# -*- coding: utf-8 -*-
import os
import json
import ast
import torch
import numpy as np
from PIL import Image
import io
import time
import re
import sys
import gc
import threading
from concurrent.futures import ThreadPoolExecutor
import traceback
import urllib.request
import urllib.error
import ssl
import base64
from pathlib import Path

# 导入工具模块
from .banzhang_utils import (
    MODEL_CACHE, PROCESSOR_CACHE, TOKENIZER_CACHE,
    get_vram_info, get_gpu_used, clear_global_cache, release_model, MODEL_CONFIGS, StreamStoppingCriteria,
    Quantization, ModelType, DEFAULT_PROMPTS, PROMPTS_FILE, PROMPTS_DIR,
    ImageProcessor, ModelDownloader, interrupted, resolve_gguf_model
)
import folder_paths

# 尝试导入 Transformers
try:
    from transformers import AutoModelForImageTextToText, AutoProcessor, AutoTokenizer, AutoConfig, BitsAndBytesConfig, TextIteratorStreamer, StoppingCriteriaList
    from huggingface_hub import snapshot_download as hf_snapshot_download
    TRANSFORMERS_AVAILABLE = True
except ImportError:
    TRANSFORMERS_AVAILABLE = False

# API 并发与限流
API_CONCURRENCY = 3      # API 模式并发请求上限
API_REQUEST_INTERVAL = 0.2  # 每批请求间隔（秒），温和节流

# 音频直传（input_audio）：统一转 16kHz 单声道 WAV，单段最长 10 分钟
AUDIO_EXTS = (".mp3", ".wav", ".m4a", ".flac", ".ogg", ".aac", ".opus")
AUDIO_MAX_SECONDS = 600
AUDIO_SAMPLE_RATE = 16000

# ComfyUI 常见技术术语：判漏翻时忽略，避免 cfg_scale/LoRA 等被误判为未翻译
_TECH_TERMS = {
    "cfg_scale", "cfg", "denoise", "seed", "steps", "step", "sampler", "scheduler",
    "lora", "vae", "clip", "clip_vision", "vision", "controlnet", "checkpoint", "upscale",
    "latent", "mask", "model", "models", "conditioning", "gligen", "ipadapter",
    "ip_adapter", "depth", "canny", "segmentation", "seg", "embedding", "embeddings",
    "unet", "prompt", "negative", "noise", "sigma", "gpu", "cpu", "fp8", "fp16",
    "fp32", "bf16", "sd", "sdxl", "flux", "txt2img", "img2img", "api", "json",
    "url", "ui", "js", "max", "min", "rgb", "hsv", "png", "jpg", "jpeg", "mp4",
    "mp3", "opencv", "onnx", "safetensors", "ckpt", "gguf", "dtype", "image",
    "video", "audio", "text", "tensor", "batch", "width", "height", "size",
    # 常见模型/品牌/缩写：AI 翻译时常保留原文，需豁免以免误判漏翻
    "ok", "id", "ids", "html", "css", "dom", "svg", "gif", "webp", "pdf",
    "kb", "mb", "gb", "sam", "rmbg", "rembg", "qwen", "vlm", "llm", "vl",
    "bbox", "florence", "dino", "groundingdino", "bria", "gfpgan", "codeformer",
    "esrgan", "ldsr", "swinir", "yolo", "ultralytics", "minimax", "seedream",
    "hunyuan", "kling", "vidu", "ltx", "svd", "animatediff", "pixart", "auraflow",
    "lumina", "sana", "internvl", "cogvideo", "cogview", "wanx", "doubao", "ark",
    "gemini", "claude", "grok", "mistral", "llama", "mixtral", "phi", "cuda",
    "rocm", "webui", "comfyui", "gsap", "katex", "vue", "react", "svelte", "ps",
    # 运行日志中出现的品牌/组件词：AI 保留原文属正常
    "llava", "gpv", "h3", "h264", "h265", "hevc", "avc", "aac", "flac", "opus",
}
_TECH_TERMS_SORTED = sorted(_TECH_TERMS, key=len, reverse=True)
_TECH_TERM_RE = re.compile(
    r'(?<![A-Za-z])(' + '|'.join(re.escape(t) for t in _TECH_TERMS_SORTED) + r')(?![A-Za-z])',
    re.IGNORECASE
)
# 纯大写缩写词（1-8 字符，可含数字/点/连字符，如 SAM、RMBG、BBOX、SD1.5）：AI 保留原文属正常行为
_ACRONYM_RE = re.compile(r'^[A-Z][A-Z0-9.\-]{0,7}$')


class BanzhangAITranslator:
    # 类级别默认提示词缓存，确保在 INPUT_TYPES 未被调用时也有值
    SYSTEM_PROMPTS = DEFAULT_PROMPTS.copy()
    
    def __init__(self):
        self.image_processor = ImageProcessor()
        self.downloader = ModelDownloader() if TRANSFORMERS_AVAILABLE else None
    
    @classmethod
    def _load_prompts(cls):
        """读取所有外部提示词文件"""
        current_prompts = DEFAULT_PROMPTS.copy()
        if PROMPTS_FILE.exists():
            try:
                with open(PROMPTS_FILE, 'r', encoding='utf-8') as f:
                    current_prompts.update(json.load(f))
            except Exception as e: print(f"👨‍🏫 班长警告：读取 prompts.json 失败 ({e})")
        if PROMPTS_DIR.exists():
            for f in PROMPTS_DIR.glob("*.json"):
                try: 
                    with open(f, 'r', encoding='utf-8') as file: current_prompts.update(json.load(file))
                except (json.JSONDecodeError, OSError): pass
            for f in PROMPTS_DIR.glob("*.md"):
                try:
                    with open(f, 'r', encoding='utf-8') as file:
                         if content := file.read().strip(): current_prompts[f.stem] = content
                except OSError: pass
        return current_prompts

    @classmethod
    def INPUT_TYPES(cls):
        api_providers = [
            "Doubao (豆包/火山)", "Aliyun (通义千问)", "DeepSeek (深度求索)", 
            "Ollama (本地)", "Baidu Qianfan (百度千帆)", "Moonshot (Kimi)", 
            "Zhipu (智谱GLM)", "SiliconFlow (硅基流动)", "NVIDIA (英伟达NIM)", 
            "OpenAI (官方/中转)", "Custom (自定义)"
        ]
        
        loaded_prompts = cls._load_prompts()
        cls.SYSTEM_PROMPTS = loaded_prompts
        prompt_preset_keys = ["无 (使用自定义)"] + list(loaded_prompts.keys())
        default_prompt_preset = prompt_preset_keys[0]

        return {
            "required": {
                "seed": ("INT", {"default": 0, "min": 0, "max": 0xffffffffffffffff}),
                "🔑 API_KEY": ("STRING", {"default": "sk-xxxx", "multiline": False}),
                "🌐 API服务商": (api_providers, {"default": "Doubao (豆包/火山)"}), 
                "🔗 自定义地址": ("STRING", {"default": ""}),
                "🤖 模型名称": ("STRING", {"default": ""}),

                "🎨 提示词预设": (prompt_preset_keys, {"default": default_prompt_preset}),
                "🧠 系统指令 (指令)": ("STRING", {"default": "", "multiline": True, "placeholder": "[指令区] System Prompt"}),
                "🗣️ 用户提示 (正文)": ("STRING", {"default": "", "multiline": True, "placeholder": "[内容区] User Prompt"}),
                
                "🔢 最大Token (万)": ("FLOAT", {"default": 0.2, "min": 0.01, "max": 100.0, "step": 0.01, "tooltip": "单位：万 Token。0.2万=2000，1万=10000；按模型规格直接填写，如 100 = 100万"}),
                "🌡️ 采样温度": ("FLOAT", {"default": 0.7, "min": 0.0, "max": 1.0, "step": 0.1}),
                "🎬 视频帧率": ("INT", {"default": 16, "min": 1, "max": 60, "step": 1}),
                "📉 媒体限制(边长)": ("INT", {"default": 512, "min": 0, "max": 1920, "step": 64}),
            },
            "optional": {
                "🔧 本地Qwen配置": ("QWEN3VL_MODEL_CONFIG", {"forceInput": False}),
                "📂 JSON路径": ("STRING", {"forceInput": True}),
                "🗂️ 参考素材": ("*", {"tooltip": "通配输入：可接 H3 媒体架(参考素材)、任意图片加载节点(IMAGE)、视频节点(VIDEO/多帧)、音频加载节点(AUDIO)，或图片/视频/音频文件路径；音频以 input_audio 直传 API（需模型支持音频输入）"}),
                "💾 覆盖原文件": ("BOOLEAN", {"default": True}),
            }
        }

    RETURN_TYPES = ("STRING", "STRING", "STRING")
    RETURN_NAMES = ("📄 运行报告", "📝 生成内容", "🧠 思考过程")
    FUNCTION = "generate_content"
    CATEGORY = "👨‍🏫班长/文本处理"

    @staticmethod
    def _parse_max_tokens(raw, default_wan=0.2):
        """「🔢 最大Token (万)」参数 → 实际 max_tokens（万 × 10000）"""
        try:
            v = float(raw[0]) if isinstance(raw, list) else float(raw)
        except (TypeError, ValueError):
            v = default_wan
        return max(1, int(round(v * 10000)))

    # ---------------- H3 媒体架参考素材 (H3_REFS) ----------------

    @staticmethod
    def _resolve_ref_file(ref):
        """按媒体架 ref（子文件夹/文件名）在 ComfyUI input 目录定位文件"""
        if not ref:
            return None
        root = folder_paths.get_input_directory()
        ref = str(ref)
        candidates = [os.path.join(root, ref)]
        base = os.path.basename(ref)
        candidates.append(os.path.join(root, "cglide", base))   # 媒体架默认上传子目录
        candidates.append(os.path.join(root, base))
        for path in candidates:
            if path and os.path.isfile(path):
                return path
        return None

    def _load_ref_image(self, ref):
        """参考图片文件 → ComfyUI IMAGE 张量 [1,H,W,3] (0-1 float32)"""
        from PIL import ImageOps
        path = self._resolve_ref_file(ref)
        if path is None:
            raise FileNotFoundError(f"参考图片未找到: {ref}")
        img = Image.open(path)
        img = ImageOps.exif_transpose(img).convert("RGB")
        arr = np.array(img).astype(np.float32) / 255.0
        return torch.from_numpy(arr)[None, ...]

    def _load_ref_video_frames(self, ref, start=None, end=None, max_frames=8):
        """参考视频文件 → [N,H,W,3] (0-1 float32)，在修剪窗口 [start,end) 内均匀抽帧"""
        path = self._resolve_ref_file(ref)
        if path is None:
            raise FileNotFoundError(f"参考视频未找到: {ref}")
        try:
            import av
        except ImportError:
            print("👨‍🏫 班长警告: 未安装 PyAV，无法读取参考视频，已跳过:", ref)
            return None
        grabbed = []
        with av.open(path) as container:
            stream = container.streams.video[0]
            tb = float(stream.time_base)
            duration = float(stream.duration * tb) if stream.duration else None
            s = max(0.0, float(start) if start is not None else 0.0)
            e = float(end) if (end is not None and float(end) > s) else duration
            if s > 0:
                container.seek(int(s / tb), stream=stream)
            for frame in container.decode(stream):
                t = float(frame.pts * tb) if frame.pts is not None else 0.0
                if e is not None and t > e:
                    break
                if t < s:
                    continue
                grabbed.append(frame.to_image())
        if not grabbed:
            return None
        if len(grabbed) > max_frames:
            idx = np.linspace(0, len(grabbed) - 1, max_frames, dtype=int)
            grabbed = [grabbed[i] for i in idx]
        tensors = []
        for im in grabbed:
            arr = np.array(im.convert("RGB")).astype(np.float32) / 255.0
            tensors.append(torch.from_numpy(arr))
        return torch.stack(tensors)

    @staticmethod
    def _image_tensor_to_media(t):
        """IMAGE 张量 → (kind, tensor)：单帧=图片，多帧=视频帧序列"""
        if t.dim() == 3:
            t = t[None, ...]
        if t.dim() != 4 or t.shape[0] == 0:
            return None, None
        return ("image" if t.shape[0] == 1 else "video"), t

    def _video_obj_to_media(self, video):
        """ComfyUI VIDEO 对象（LoadVideo 等）→ (kind, tensor)"""
        try:
            comps = video.get_components()
        except Exception:
            return None, None
        frames = comps if torch.is_tensor(comps) else None
        if frames is None:
            for c in (comps or []):
                if torch.is_tensor(c):
                    frames = c
                    break
        if frames is None:
            return None, None
        return self._image_tensor_to_media(frames)

    @staticmethod
    def _load_audio_wave(path):
        """音频文件 → (waveform [C,T] float32, sample_rate)。

        解码交给全插件共用的一层（csglide_audio_io）：soundfile → PyAV →
        torchaudio 依次降级。原先这里 torchaudio 优先 + PyAV 兜底，而便携版实测
        torchaudio.load 对所有格式都失败，等于每次白跑一轮；且手写的整数位深
        归一与 ndim 修正在长尾格式上并不可靠。
        """
        from ..csglide_audio_io import decode_audio_file
        return decode_audio_file(path)

    @staticmethod
    def _resample_wave(wav, sr_from, sr_to):
        """重采样到目标采样率；torchaudio / swresample / 线性插值三档自动降级。"""
        if sr_from == sr_to:
            return wav
        from ..csglide_audio_io import resample_waveform
        return resample_waveform(wav, sr_from, sr_to)

    def _audio_to_wav_b64(self, path=None, start=None, end=None, waveform=None, sample_rate=None):
        """音频来源 → 16kHz 单声道 WAV 的 base64（OpenAI input_audio 标准格式）。

        支持两种来源：
        - path: 音频/视频文件路径（可选 start/end 秒修剪区间）
        - waveform + sample_rate: ComfyUI AUDIO 对象的波形与采样率
        统一混单声道、重采样 16kHz；超过 10 分钟截断保留前段。
        """
        if path is not None:
            wav, sr = self._load_audio_wave(path)
            s = max(0.0, float(start) if start is not None else 0.0)
            e = float(end) if (end is not None and float(end) > s) else None
            if s > 0 or e is not None:
                si = int(s * sr)
                ei = int(e * sr) if e is not None else wav.shape[-1]
                wav = wav[:, si:max(si, ei)]
        else:
            wav = waveform
            sr = int(sample_rate)
            if wav.dim() == 3:
                wav = wav[0]  # [B,C,T] → [C,T]
        if wav.dim() > 1 and wav.shape[0] > 1:
            wav = torch.mean(wav, dim=0, keepdim=True)  # 混为单声道
        wav = self._resample_wave(wav, sr, AUDIO_SAMPLE_RATE)
        if wav.shape[-1] > AUDIO_MAX_SECONDS * AUDIO_SAMPLE_RATE:
            wav = wav[..., :AUDIO_MAX_SECONDS * AUDIO_SAMPLE_RATE]
            print(f"👨‍🏫 班长: 音频超过 {AUDIO_MAX_SECONDS // 60} 分钟，已截断只保留前段")
        pcm = (wav.squeeze(0).cpu().numpy().clip(-1.0, 1.0) * 32767.0).astype(np.int16)
        import wave as wave_mod
        buf = io.BytesIO()
        with wave_mod.open(buf, "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(AUDIO_SAMPLE_RATE)
            w.writeframes(pcm.tobytes())
        return base64.b64encode(buf.getvalue()).decode("utf-8")

    def _rack_slots_to_media(self, slots):
        """H3 媒体架槽位 → media_seq，编号即槽位号（空槽位跳过但编号保留）"""
        media_seq = []
        for no, slot in enumerate(slots.get("images") or [], start=1):
            if isinstance(slot, dict) and slot.get("file"):
                try:
                    media_seq.append({
                        "kind": "image", "no": no,
                        "tensor": self._load_ref_image(slot["file"]),
                        "name": os.path.basename(str(slot["file"])),
                    })
                except Exception as e:
                    print(f"👨‍🏫 班长警告: 参考图片{no} 读取失败 ({e})")
        for no, slot in enumerate(slots.get("videos") or [], start=1):
            if isinstance(slot, dict) and slot.get("file"):
                try:
                    frames = self._load_ref_video_frames(
                        slot["file"], slot.get("start"), slot.get("end"))
                    if frames is not None:
                        media_seq.append({
                            "kind": "video", "no": no, "tensor": frames,
                            "name": os.path.basename(str(slot["file"])),
                        })
                except Exception as e:
                    print(f"👨‍🏫 班长警告: 参考视频{no} 读取失败 ({e})")
        for no, slot in enumerate(slots.get("audios") or [], start=1):
            if isinstance(slot, dict) and slot.get("file"):
                path = self._resolve_ref_file(slot["file"])
                if path is None:
                    print(f"👨‍🏫 班长警告: 参考音频{no} 未找到: {slot['file']}")
                    continue
                media_seq.append({
                    "kind": "audio", "no": no, "path": path,
                    "start": slot.get("start"), "end": slot.get("end"),
                    "name": os.path.basename(str(slot["file"])),
                })
        return media_seq

    def _refs_to_media(self, refs):
        """参考素材入口（通配）→ media_seq：带编号的有序素材列表。
        图片/视频项: {"kind": ..., "no": 编号, "tensor": [..,H,W,3], "name": 文件名}
        音频项: {"kind": "audio", "no": 编号, "path": 文件路径} 或
                {"kind": "audio", "no": 编号, "waveform": ..., "sample_rate": ...}
        兼容：H3 媒体架 H3_REFS JSON（编号=槽位号）、IMAGE 张量、VIDEO 对象、
        AUDIO 对象、图片/视频/音频文件路径，以及上述内容的列表。"""
        if refs is None:
            return []

        # 1) H3 媒体架：JSON 里带 slots 结构，编号沿用槽位号
        data = refs
        if isinstance(refs, str):
            try:
                data = json.loads(refs)
            except Exception:
                data = None
        if isinstance(data, dict) and isinstance(data.get("slots"), dict):
            return self._rack_slots_to_media(data["slots"])

        # 2) 通用输入：按到达顺序展开，图片/视频/音频各自独立计数
        media_seq = []
        counters = {"image": 0, "video": 0, "audio": 0}
        pending = list(refs) if isinstance(refs, (list, tuple)) else [refs]
        while pending:
            obj = pending.pop(0)
            if obj is None:
                continue
            if isinstance(obj, (list, tuple)):
                pending = list(obj) + pending
                continue
            kind = tensor = name = None
            if torch.is_tensor(obj):
                kind, tensor = self._image_tensor_to_media(obj)
            elif hasattr(obj, "get_components"):
                kind, tensor = self._video_obj_to_media(obj)
            elif isinstance(obj, dict) and torch.is_tensor(obj.get("waveform")) and obj.get("sample_rate"):
                # ComfyUI AUDIO 对象（如「加载音频」节点输出）
                counters["audio"] += 1
                media_seq.append({"kind": "audio", "no": counters["audio"],
                                  "waveform": obj["waveform"],
                                  "sample_rate": int(obj["sample_rate"]),
                                  "start": None, "end": None, "name": "音频输入"})
                continue
            elif isinstance(obj, str):
                path = self._resolve_ref_file(obj)
                if path:
                    name = os.path.basename(path)
                    ext = os.path.splitext(path)[1].lower()
                    try:
                        if ext in (".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif"):
                            kind, tensor = "image", self._load_ref_image(obj)
                        elif ext in (".mp4", ".mov", ".mkv", ".webm", ".avi", ".m4v"):
                            kind, tensor = "video", self._load_ref_video_frames(obj)
                        elif ext in AUDIO_EXTS:
                            counters["audio"] += 1
                            media_seq.append({"kind": "audio", "no": counters["audio"],
                                              "path": path, "start": None, "end": None,
                                              "name": name})
                            continue
                    except Exception as e:
                        print(f"👨‍🏫 班长警告: 参考素材读取失败 ({e})")
            if kind and tensor is not None:
                counters[kind] += 1
                media_seq.append({"kind": kind, "no": counters[kind], "tensor": tensor,
                                  "name": name or "输入素材"})
            else:
                print(f"👨‍🏫 班长警告: 参考素材端口收到不支持的输入 ({type(obj).__name__})，已跳过")
        return media_seq

    def _fix_truncated_json(self, text):
        """尝试修复截断的 JSON 字符串"""
        # 清除 BOM、零宽字符和 markdown 标记
        clean_text = text.replace('\ufeff', '').replace('\u200b', '').replace('\u200c', '').replace('\u200d', '')
        clean_text = clean_text.replace("```json", "").replace("```", "").strip()
        # 修复常见的 JSON 语法问题：尾随逗号
        clean_text = re.sub(r',\s*}', '}', clean_text)
        clean_text = re.sub(r',\s*]', ']', clean_text)

        # 首先尝试直接解析
        try:
            json.loads(clean_text)
            return clean_text
        except json.JSONDecodeError as e:
            print(f"   🔧 JSON修复-直接解析失败: {e}")
            pass

        print("   🔧 尝试修复截断的 JSON...")

        # 找到最后一个完整的节点（对于节点翻译）
        # 策略：找到最后一个完整的 "节点名": { ... } 块
        fixed = clean_text

        # 方法1：尝试找到最后一个完整的节点对象
        # 查找所有顶级节点的起始位置
        node_starts = []
        i = 0
        while i < len(fixed):
            # 找到 "节点名": 的模式
            if fixed[i] == '"':
                # 找到节点名的结束
                j = i + 1
                while j < len(fixed) and fixed[j] != '"':
                    if fixed[j] == '\\':
                        j += 2
                    else:
                        j += 1
                if j < len(fixed):
                    # 找到 ": 的模式
                    k = j + 1
                    while k < len(fixed) and fixed[k] in ' \t\n':
                        k += 1
                    if k < len(fixed) and fixed[k:k+1] == ':':
                        # 找到节点值开始的 {
                        k += 1
                        while k < len(fixed) and fixed[k] in ' \t\n':
                            k += 1
                        if k < len(fixed) and fixed[k] == '{':
                            node_starts.append((i, k))
            i += 1

        # 从最后一个节点开始，尝试找到完整的节点
        if node_starts:
            for start_idx in range(len(node_starts) - 1, -1, -1):
                node_name_start, node_value_start = node_starts[start_idx]
                # 尝试从这个节点开始截断并修复
                test_json = fixed[:node_name_start].rstrip()
                if test_json.endswith(','):
                    test_json = test_json[:-1]

                # 计算需要的闭合括号
                open_braces = test_json.count('{') - test_json.count('}')
                open_brackets = test_json.count('[') - test_json.count(']')

                # 添加闭合括号
                for _ in range(open_brackets):
                    test_json += ']'
                for _ in range(open_braces):
                    test_json += '}'

                # 尝试解析
                try:
                    result = json.loads(test_json)
                    print(f"   🔧 成功修复 JSON，保留了 {len(result)} 个完整节点")
                    return test_json
                except json.JSONDecodeError:
                    continue

        # 方法2：逐字符解析，找到最后一个完整的位置
        last_valid_pos = 0
        brace_count = 0
        bracket_count = 0
        in_string = False
        escape_next = False
        depth_stack = []  # 记录每个深度的位置

        for i, char in enumerate(fixed):
            if escape_next:
                escape_next = False
                continue
            if char == '\\':
                escape_next = True
                continue
            if char == '"' and not in_string:
                in_string = True
            elif char == '"' and in_string:
                in_string = False
            elif not in_string:
                if char == '{':
                    if brace_count == 0:
                        depth_stack.append(('brace', i))
                    brace_count += 1
                elif char == '}':
                    brace_count -= 1
                    if brace_count == 0 and bracket_count == 0:
                        last_valid_pos = i
                elif char == '[':
                    if bracket_count == 0 and brace_count == 0:
                        depth_stack.append(('bracket', i))
                    bracket_count += 1
                elif char == ']':
                    bracket_count -= 1
                    if brace_count == 0 and bracket_count == 0:
                        last_valid_pos = i

        # 如果找到了有效的完整位置
        if last_valid_pos > 0:
            test_json = fixed[:last_valid_pos + 1]
            try:
                result = json.loads(test_json)
                print(f"   🔧 成功修复 JSON（方法2），保留了 {len(result)} 个完整节点")
                return test_json
            except json.JSONDecodeError:
                pass

        # 方法3：简单地在字符串截断处添加闭合引号和括号
        if in_string:
            fixed = fixed + '"'

        # 移除尾部不完整的部分
        while fixed and fixed[-1] not in '}]':
            fixed = fixed[:-1]

        # 计算并添加闭合括号
        open_braces = fixed.count('{') - fixed.count('}')
        open_brackets = fixed.count('[') - fixed.count(']')

        for _ in range(open_brackets):
            fixed += ']'
        for _ in range(open_braces):
            fixed += '}'

        try:
            result = json.loads(fixed)
            print(f"   🔧 成功修复 JSON（方法3），保留了 {len(result)} 个完整节点")
            return fixed
        except json.JSONDecodeError:
            print("   ⚠️ 无法修复 JSON，将保留原文")
            return clean_text

    def _extract_json_from_text(self, text):
        """从文本中提取 JSON，支持混合文本（如 Ollama 返回的分析+JSON）"""
        clean_text = text.replace("```json", "").replace("```", "").strip()
        # 方法0：直接解析
        try:
            return json.loads(clean_text)
        except json.JSONDecodeError as e:
            print(f"   🔍 JSON直接解析失败: {e}")
            pass
        try:
            return ast.literal_eval(clean_text)
        except (ValueError, SyntaxError) as e:
            print(f"   🔍 AST直接解析失败: {e}")
            pass

        # 方法1：用正则找到第一个 { 和最后一个 } 之间的内容
        # 先尝试找最外层 JSON 对象
        first_brace = clean_text.find('{')
        last_brace = clean_text.rfind('}')
        if first_brace != -1 and last_brace != -1 and last_brace > first_brace:
            candidate = clean_text[first_brace:last_brace + 1]
            try:
                return json.loads(candidate)
            except json.JSONDecodeError:
                pass
            try:
                return ast.literal_eval(candidate)
            except (ValueError, SyntaxError):
                pass

        # 方法2：按行扫描，找到以 { 开头的行到最后以 } 结尾的行
        lines = clean_text.split('\n')
        start_idx = -1
        end_idx = -1
        for i, line in enumerate(lines):
            stripped = line.strip()
            if start_idx == -1 and stripped.startswith('{'):
                start_idx = i
            if stripped.endswith('}') and not stripped.endswith('\\}'):
                end_idx = i
        if start_idx != -1 and end_idx != -1 and end_idx >= start_idx:
            candidate = '\n'.join(lines[start_idx:end_idx + 1])
            try:
                return json.loads(candidate)
            except json.JSONDecodeError:
                pass
            try:
                return ast.literal_eval(candidate)
            except (ValueError, SyntaxError):
                pass

        # 方法3：使用正则匹配平衡花括号提取 JSON 对象
        candidate = self._extract_json_by_balancing(clean_text)
        if candidate:
            try:
                return json.loads(candidate)
            except json.JSONDecodeError:
                pass
            try:
                return ast.literal_eval(candidate)
            except (ValueError, SyntaxError):
                pass

        # 打印调试信息
        print(f"   🔍 响应总长度: {len(clean_text)} 字符")
        head = clean_text[:300].replace('\n', '\\n')
        print(f"   🔍 响应头部: {head}...")
        if len(clean_text) > 300:
            tail = clean_text[-200:].replace('\n', '\\n')
            print(f"   🔍 响应尾部: ...{tail}")
        return None

    def _extract_json_by_balancing(self, text):
        """通过括号平衡从文本中提取 JSON 对象"""
        start = text.find('{')
        if start == -1:
            return None
        depth = 0
        in_string = False
        escape = False
        for i in range(start, len(text)):
            c = text[i]
            if escape:
                escape = False
                continue
            if c == '\\':
                escape = True
                continue
            if c == '"' and not in_string:
                in_string = True
            elif c == '"' and in_string:
                in_string = False
            elif not in_string:
                if c == '{':
                    depth += 1
                elif c == '}':
                    depth -= 1
                    if depth == 0:
                        return text[start:i + 1]
        return None

    def _flatten_to_string(self, val, _depth=0, _visited=None):
        """核心降维工具：将各种乱七八糟的输入变为纯文本"""
        if _depth > 10: return ""  # 防止循环引用导致无限递归
        if _visited is None: _visited = set()
        if isinstance(val, str): return val
        if isinstance(val, (int, float, bool)): return str(val)
        if val is None: return ""
        if isinstance(val, dict):
            obj_id = id(val)
            if obj_id in _visited: return ""  # 检测到循环引用
            _visited.add(obj_id)
            for v in val.values():
                result = self._flatten_to_string(v, _depth + 1, _visited)
                if result: return result
            return ""
        if isinstance(val, list) and len(val) > 0: 
            return self._flatten_to_string(val[0], _depth + 1, _visited)
        return str(val)

    def _nuclear_sanitize(self, data):
        if not isinstance(data, dict): return {}
        clean_data = {}
        for node_key, node_info in data.items():
            if not isinstance(node_info, dict): continue
            clean_node = {}
            raw_title = node_info.get("title", node_key)
            clean_node["title"] = str(raw_title) if raw_title is not None else ""
            for section in ["inputs", "widgets", "outputs"]:
                if section in node_info and isinstance(node_info[section], dict):
                    clean_section = {}
                    for k, v in node_info[section].items():
                        clean_section[k] = str(v) if v is not None else ""
                    clean_node[section] = clean_section
            clean_data[node_key] = clean_node
        return clean_data

    def _deep_merge(self, target, source):
        for k, v in source.items():
            if isinstance(v, dict):
                if k not in target or not isinstance(target[k], dict): target[k] = {}
                self._deep_merge(target[k], v)
            else: target[k] = v

    def _get_api_config(self, kwargs):
        api_key = self._flatten_to_string(kwargs.get("🔑 API_KEY", "")).strip()
        provider_full = self._flatten_to_string(kwargs.get("🌐 API服务商", "Doubao"))
        provider_key = provider_full.split(" ")[0]
        custom_url = self._flatten_to_string(kwargs.get("🔗 自定义地址", "")).strip().rstrip('/')
        model_input = self._flatten_to_string(kwargs.get("🤖 模型名称", "")).strip()

        if custom_url and len(custom_url) > 5 and provider_key != "Custom":
            provider_key = "Custom"
        
        if (not api_key or "sk-xxxx" in api_key) and provider_key in ["Ollama", "Custom"]:
            api_key = "sk-no-key-required"

        url_map = {"Doubao": "https://ark.cn-beijing.volces.com/api/v3", "Aliyun": "https://dashscope.aliyuncs.com/compatible-mode/v1", "DeepSeek": "https://api.deepseek.com", "Ollama": "http://localhost:11434/v1", "NVIDIA": "https://integrate.api.nvidia.com/v1", "OpenAI": "https://api.openai.com/v1", "Baidu": "https://qianfan.baidubce.com/v2", "Moonshot": "https://api.moonshot.cn/v1", "Zhipu": "https://open.bigmodel.cn/api/paas/v4", "SiliconFlow": "https://api.siliconflow.cn/v1"}
        
        # 各服务商默认模型（当用户未指定时自动应用）
        default_model_map = {
            "Doubao": "doubao-1.5-pro-32k-250115",
            "Aliyun": "qwen-plus",
            "DeepSeek": "deepseek-chat",
            "Ollama": "",
            "Baidu": "ernie-4.0-8k",
            "Moonshot": "moonshot-v1-8k",
            "Zhipu": "glm-4-flash",
            "SiliconFlow": "Qwen/Qwen2.5-7B-Instruct",
            "NVIDIA": "nvidia/llama-3.1-nemotron-70b-instruct",
            "OpenAI": "gpt-4o-mini",
        }
        if not model_input:
            model_input = default_model_map.get(provider_key, "")
            if model_input:
                print(f"👨‍🏫 班长: 未指定模型，已自动使用 {provider_key} 默认模型: {model_input}")
        
        if provider_key == "Custom" and custom_url:
            if not custom_url.startswith("http"):
                custom_url = "http://" + custom_url

            # ---- 智能推断 chat/completions 路径 ----
            # 已知 OpenAI 兼容 API 的 4 种常见后缀格式：
            #   /chat/completions   → 已是完整端点
            #   /v1                 → 需补 /chat/completions
            #   /v3                 → 需补 /chat/completions
            #   /api/v3             → 需补 /chat/completions
            #   空/纯域名            → 补 /v1/chat/completions
            custom_base = custom_url.rstrip('/')
            # 容错：误粘贴的其它端点后缀（如 Responses API 的 /responses）直接剥掉
            if custom_base.endswith("/responses"):
                custom_base = custom_base[:-len("/responses")]
                print(f"👨‍🏫 班长: 已剥离误填的 /responses 后缀 → {custom_base}")
            if custom_base.endswith("/chat/completions"):
                # 已经是完整端点，直接使用
                final_url = custom_base
                base_url_for_list = custom_base.rsplit("/chat/completions", 1)[0]
            elif custom_base.endswith("/v1"):
                final_url = f"{custom_base}/chat/completions"
                base_url_for_list = custom_base
            else:
                # 其他任何格式：域名、/v3、/api、/api/v3 等
                # 都直接拼 /chat/completions（绝大多数服务商支持此路径）
                final_url = f"{custom_base}/chat/completions"
                base_url_for_list = custom_base
            print(f"👨‍🏫 班长: 自定义地址 → {final_url}")
        else:
            base = url_map.get(provider_key, "")
            final_url = f"{base.rstrip('/')}/chat/completions"
            base_url_for_list = base
        
        headers = {"Content-Type": "application/json", "Authorization": f"Bearer {api_key}"}
        if provider_key == "NVIDIA" or "nvidia" in final_url.lower():
            headers["Accept"] = "application/json"
        model = model_input 
        
        return final_url, headers, model, provider_key, base_url_for_list

    def _fetch_available_models(self, api_key, base_url):
        """从 API 获取可用模型列表"""
        if not base_url:
            return "无法获取模型列表：未配置服务商地址"
        try:
            list_url = base_url.rstrip('/') + "/models"
            headers = {"Authorization": f"Bearer {api_key}"}
            req = urllib.request.Request(list_url, headers=headers)
            ctx = ssl.create_default_context()
            with urllib.request.urlopen(req, context=ctx, timeout=15) as resp:
                data = json.loads(resp.read().decode('utf-8'))
            models = data.get('data', data.get('models', []))
            if not models:
                return "未找到可用模型（API 返回空列表）"
            lines = []
            for m in models[:50]:
                mid = m.get('id', m.get('model', str(m)))
                lines.append(f"  - {mid}")
            return "\n".join(lines) if lines else "未找到可用模型"
        except urllib.error.HTTPError as e:
            return f"获取模型列表失败: HTTP {e.code}"
        except Exception as e:
            return f"获取模型列表失败: {e}"

    def _split_thinking(self, text):
        """把模型输出拆成 (正文, 思考过程)，兼容三种格式：
        1) 标准成对「<think>...</think>」（API 路径常见）；
        2) Qwen3.5-9B GGUF 实测格式：chat 模板已把 <think> 渲染进提示词，模型
           续写时不再重复开标签，输出为「裸推理 + </think> + 正文」
           ——只有闭标签，按第一个闭标签一刀切，前面进思考、后面进正文；
        3) 无任何思考标签：整段都是正文，思考为空。
        """
        if not text:
            return text, ""
        # 1) 标准成对：剥掉 think 块，块内容进思考
        match = re.search(r'<think>(.*?)</think>', text, flags=re.DOTALL)
        if match:
            clean = re.sub(r'<think>.*?</think>', '', text, flags=re.DOTALL).strip()
            return clean, match.group(1).strip()
        # 2) 只有闭标签：模板预渲染了开标签，第一个闭标签之前全部是推理
        idx = text.find("</think>")
        if idx >= 0:
            think = text[:idx].strip()
            body = text[idx + len("</think>"):].strip()
            return body, think
        # 3) 无标签：全是正文
        return text, ""

    def _detect_translation_type(self, data):
        """检测翻译文件类型：nodes(节点), categories(分类), menus(菜单), frontend_js(前端JS文本)"""
        if not isinstance(data, dict) or not data:
            return None

        # 检查是否为节点翻译（包含 title/inputs/widgets/outputs/description 字段）
        for key, item in data.items():
            if isinstance(item, dict):
                node_fields = ['title', 'inputs', 'widgets', 'outputs', 'description']
                if any(field in item for field in node_fields):
                    # 进一步区分：是否有 file/context 字段（前端JS文本）
                    if 'file' in item and 'context' in item:
                        return 'frontend_js'
                    return 'nodes'

        # 检查是否为简单键值对（分类或菜单）
        has_simple_values = True
        for key, value in data.items():
            if not isinstance(value, str):
                has_simple_values = False
                break

        if has_simple_values:
            # 根据键名特征推断类型
            sample_keys = list(data.keys())[:5]
            category_keywords = ['category', 'categor', '分类']
            menu_keywords = ['menu', 'setting', 'option', '菜单', '设置']

            for key in sample_keys:
                key_lower = key.lower()
                if any(kw in key_lower for kw in category_keywords):
                    return 'categories'
                if any(kw in key_lower for kw in menu_keywords):
                    return 'menus'

            # 默认为菜单类型
            return 'menus'

        return None

    def _build_translation_prompt(self, trans_type, batch_data):
        """根据翻译类型构建优化的提示词"""
        if trans_type == 'nodes':
            system_msg = """你是一个专业的 ComfyUI 节点翻译助手。请将节点数据翻译成中文。

【关键规则 - 必须严格遵守】
1. 只输出纯 JSON，不要输出任何其他内容
2. 禁止输出 markdown 代码块标记（```json 或 ```）
3. 禁止输出任何分析、解释、思考过程或额外文字
4. 禁止输出 <analysis>、<thinking> 等标签
5. 直接以 { 开头输出 JSON，以 } 结尾

【翻译规则】
6. 保持 JSON 结构完整，键名不变
7. title: 翻译节点标题，简洁明了
8. description: 翻译节点描述
9. inputs/widgets/outputs: 翻译参数/输出名称
10. 保留技术术语的准确性"""

            # 构建结构化的翻译请求
            formatted_data = {}
            for node_name, node_info in batch_data.items():
                formatted_node = {"_original_name": node_name}
                if isinstance(node_info, dict):
                    if 'title' in node_info:
                        formatted_node['title'] = node_info['title']
                    if 'description' in node_info:
                        formatted_node['description'] = node_info['description']
                    if 'inputs' in node_info:
                        formatted_node['inputs'] = node_info['inputs']
                    if 'widgets' in node_info:
                        formatted_node['widgets'] = node_info['widgets']
                    if 'outputs' in node_info:
                        formatted_node['outputs'] = node_info['outputs']
                formatted_data[node_name] = formatted_node

            user_msg = f"""请翻译以下 ComfyUI 节点数据，直接返回纯 JSON（不要 markdown、不要分析）：

{json.dumps(formatted_data, ensure_ascii=False, indent=2)}

只输出 JSON，不要任何其他内容："""

        elif trans_type == 'categories':
            system_msg = """你是一个专业的 ComfyUI 分类翻译助手。将分类名称翻译成中文。只输出纯 JSON，不要 markdown 或任何额外文字。"""
            user_msg = f"""将以下 ComfyUI 分类名称翻译成中文，只输出纯 JSON：

{json.dumps(batch_data, ensure_ascii=False, indent=2)}

只输出 JSON："""

        elif trans_type == 'menus':
            system_msg = """你是一个专业的 ComfyUI 菜单翻译助手。将菜单项翻译成中文。只输出纯 JSON，不要 markdown 或任何额外文字。"""
            user_msg = f"""将以下 ComfyUI 菜单项翻译成中文，只输出纯 JSON：

{json.dumps(batch_data, ensure_ascii=False, indent=2)}

只输出 JSON："""

        elif trans_type == 'frontend_js':
            system_msg = """你是一个专业的 ComfyUI 前端 UI 翻译助手。请将前端 JavaScript 代码中的 UI 文本翻译为中文。

【关键规则 - 必须严格遵守】
1. 只输出纯 JSON，不要输出任何其他内容
2. 禁止输出 markdown 代码块标记（```json 或 ```）
3. 禁止输出任何分析、解释、思考过程或额外文字
4. 直接以 { 开头输出 JSON，以 } 结尾

【翻译规则】
5. 保持 JSON 结构完整，键名不变
6. title: 翻译 UI 文本（按钮标签、菜单项、提示文字、占位符等）
7. 保留 emoji 和特殊符号（如 ✅ ❌ 🚀 等）
8. 保留技术术语和变量占位符（如 ${variable}）
9. 上下文信息（file/context）不要翻译，保持原样
10. 简短 UI 文本要准确、简洁、符合中文 UI 习惯"""
            
            # 构建前端文本翻译数据
            formatted_data = {}
            for key, item in batch_data.items():
                if isinstance(item, dict):
                    formatted_data[key] = {
                        "title": item.get("title", key),
                        "file": item.get("file", ""),
                        "context": item.get("context", "")
                    }
                else:
                    formatted_data[key] = {"title": str(item)}
            
            user_msg = f"""请翻译以下 ComfyUI 前端 JS 文件中的 UI 文本，直接返回纯 JSON（不要 markdown、不要分析）：

{json.dumps(formatted_data, ensure_ascii=False, indent=2)}

只输出 JSON，不要任何其他内容："""

        else:
            system_msg = "你是一个专业的翻译助手。请将以下内容翻译成中文。"
            user_msg = f"请翻译以下内容：\n{json.dumps(batch_data, ensure_ascii=False, indent=2)}"

        return system_msg, user_msg

    def _is_english_text(self, text):
        """检测文本是否未翻译（仍为英文）。
        已含中文即视为已翻译（作者前缀如 "CR 选择模型"、品牌词、括号缩写均不误判）；
        纯大写缩写词（SAM/RMBG 等）视为术语保留；否则剔除括号缩写与技术术语后按英文占比判定。"""
        if not text or not isinstance(text, str):
            return False
        # 含中文 → 已翻译，直接放行（避免保留作者前缀/品牌词的译文被误判为漏翻）
        if re.search(r'[\u4e00-\u9fff]', text):
            return False
        stripped_text = text.strip()
        # 纯大写缩写词（SAM、RMBG、BBOX、SD1.5 等）→ 术语，保留原文不算漏翻
        if _ACRONYM_RE.match(stripped_text):
            return False
        # 先剔除括号内缩写（如 "移除背景 (RMBG)"），再剔除技术术语，最后统计英文占比
        filtered = re.sub(r'\([^()]*\)', '', text)
        filtered = _TECH_TERM_RE.sub('', filtered)
        # 统计英文字母的比例
        english_chars = sum(1 for c in filtered if ('a' <= c <= 'z') or ('A' <= c <= 'Z'))
        total_chars = len([c for c in filtered if c.strip()])  # 非空白字符
        if total_chars == 0:
            return False
        # 如果英文占比超过 30%，认为是未翻译的英文
        return (english_chars / total_chars) > 0.3

    def _scan_for_untranslated(self, original_data, translated_data, trans_type):
        """检测缺失或未翻译的条目"""
        missing = {}
        count = 0

        if trans_type == 'nodes':
            for node_name, original_node in original_data.items():
                if node_name not in translated_data:
                    # 完全缺失的节点
                    print(f"   🔍 节点缺失: {node_name}")
                    missing[node_name] = original_node
                    count += 1
                else:
                    translated_node = translated_data[node_name]
                    if not isinstance(translated_node, dict):
                        print(f"   🔍 节点格式错误: {node_name}")
                        missing[node_name] = original_node
                        count += 1
                        continue

                    # 检查各个字段是否缺失或未翻译
                    missing_fields = {}
                    has_missing = False

                    # 检查 title
                    if 'title' in original_node:
                        if 'title' not in translated_node or not translated_node['title']:
                            print(f"   🔍 节点 {node_name}: title 缺失")
                            missing_fields['title'] = original_node['title']
                            has_missing = True
                        elif self._is_english_text(translated_node['title']):
                            print(f"   🔍 节点 {node_name}: title 未翻译 - {translated_node['title']}")
                            missing_fields['title'] = original_node['title']
                            has_missing = True

                    # 检查 description
                    if 'description' in original_node:
                        if 'description' not in translated_node or not translated_node['description']:
                            print(f"   🔍 节点 {node_name}: description 缺失")
                            missing_fields['description'] = original_node['description']
                            has_missing = True
                        elif self._is_english_text(translated_node['description']):
                            print(f"   🔍 节点 {node_name}: description 未翻译")
                            missing_fields['description'] = original_node['description']
                            has_missing = True

                    # 检查 inputs
                    if 'inputs' in original_node and isinstance(original_node['inputs'], dict):
                        missing_inputs = {}
                        for key, value in original_node['inputs'].items():
                            if not isinstance(translated_node.get('inputs'), dict) or \
                               key not in translated_node['inputs'] or \
                               not translated_node['inputs'][key]:
                                print(f"   🔍 节点 {node_name}: input [{key}] 缺失")
                                missing_inputs[key] = value
                            elif self._is_english_text(translated_node['inputs'][key]):
                                print(f"   🔍 节点 {node_name}: input [{key}] 未翻译 - {translated_node['inputs'][key]}")
                                missing_inputs[key] = value
                        if missing_inputs:
                            missing_fields['inputs'] = missing_inputs
                            has_missing = True

                    # 检查 widgets
                    if 'widgets' in original_node and isinstance(original_node['widgets'], dict):
                        missing_widgets = {}
                        for key, value in original_node['widgets'].items():
                            if not isinstance(translated_node.get('widgets'), dict) or \
                               key not in translated_node['widgets'] or \
                               not translated_node['widgets'][key]:
                                print(f"   🔍 节点 {node_name}: widget [{key}] 缺失")
                                missing_widgets[key] = value
                            elif self._is_english_text(translated_node['widgets'][key]):
                                print(f"   🔍 节点 {node_name}: widget [{key}] 未翻译 - {translated_node['widgets'][key]}")
                                missing_widgets[key] = value
                        if missing_widgets:
                            missing_fields['widgets'] = missing_widgets
                            has_missing = True

                    # 检查 outputs
                    if 'outputs' in original_node and isinstance(original_node['outputs'], dict):
                        missing_outputs = {}
                        for key, value in original_node['outputs'].items():
                            if not isinstance(translated_node.get('outputs'), dict) or \
                               key not in translated_node['outputs'] or \
                               not translated_node['outputs'][key]:
                                print(f"   🔍 节点 {node_name}: output [{key}] 缺失")
                                missing_outputs[key] = value
                            elif self._is_english_text(translated_node['outputs'][key]):
                                print(f"   🔍 节点 {node_name}: output [{key}] 未翻译 - {translated_node['outputs'][key]}")
                                missing_outputs[key] = value
                        if missing_outputs:
                            missing_fields['outputs'] = missing_outputs
                            has_missing = True

                    if has_missing:
                        missing[node_name] = missing_fields
                        count += 1
        elif trans_type == 'frontend_js':
            # 前端 JS 文本类型：检查 title 是否翻译
            for key, original_item in original_data.items():
                if not isinstance(original_item, dict):
                    continue
                original_title = str(original_item.get('title', key))
                translated_item = translated_data.get(key, {})
                if not isinstance(translated_item, dict):
                    missing[key] = original_item
                    count += 1
                    print(f"   🔍 JS文本 [{key}]: 条目格式错误")
                    continue
                translated_title = str(translated_item.get('title', ''))
                if not translated_title:
                    print(f"   🔍 JS文本 [{key}]: title 缺失")
                    missing[key] = original_item
                    count += 1
                elif translated_title == original_title and not re.search(r'\s', original_title.strip()):
                    # AI 保留的单个词：缩写词（SAM/RMBG）或纯技术术语（cfg/lora）→ 刻意保留，不算缺失
                    stripped_o = original_title.strip()
                    if _ACRONYM_RE.match(stripped_o) or not self._is_english_text(stripped_o):
                        print(f"   🔒 JS文本 [{key}]: 保留原文(术语) - {translated_title}")
                    else:
                        # 普通单词（loading/success 等）保留原文 → 真漏翻，需修补
                        print(f"   🔍 JS文本 [{key}]: title 未翻译 - {translated_title}")
                        missing[key] = original_item
                        count += 1
                elif self._is_english_text(translated_title):
                    print(f"   🔍 JS文本 [{key}]: title 未翻译 - {translated_title}")
                    missing[key] = original_item
                    count += 1
        else:
            # 简单键值对类型
            for key, value in original_data.items():
                if key not in translated_data or not translated_data[key]:
                    print(f"   🔍 条目缺失: {key}")
                    missing[key] = value
                    count += 1
                elif self._is_english_text(translated_data[key]):
                    print(f"   🔍 条目未翻译: {key} - {translated_data[key]}")
                    missing[key] = value
                    count += 1

        return missing, count

    def _translate_single_batch(self, batch_num, batch_data, url, headers, model, system_prompt, local_config, local_max_tokens, api_max_tokens, trans_type, desc):
        """翻译单个批次，返回结果 dict（成功返回译文，失败保留原文）。"""
        if interrupted():
            return batch_data

        # 构建用户消息：有 trans_type 用优化提示词，否则用简单 JSON
        if trans_type:
            _, user_msg = self._build_translation_prompt(trans_type, batch_data)
        else:
            user_msg = f"请翻译以下JSON数据:\n{json.dumps(batch_data, ensure_ascii=False)}"

        if local_config:
            _, res_text = self._run_local_inference(local_config, system_prompt, user_msg, [], 0, local_max_tokens, 0.1, 0)
            res_text, _ = self._split_thinking(res_text)
            if res_text:
                fixed_text = self._fix_truncated_json(res_text)
                translated_batch = self._extract_json_from_text(fixed_text)
                if translated_batch:
                    print(f"   ✅ 第 {batch_num} 批翻译成功")
                    return self._apply_post_process(batch_data, translated_batch, trans_type)
            print(f"   ⚠️ 第 {batch_num} 批本地推理解析失败，保留原文。")
            return batch_data

        messages = []
        if system_prompt.strip():
            messages.append({"role": "system", "content": system_prompt})
        messages.append({"role": "user", "content": user_msg})
        payload = {"model": model, "messages": messages, "temperature": 0.1, "max_tokens": api_max_tokens,
                   "response_format": {"type": "json_object"}}

        try:
            response_data = self._call_api(url, headers, payload, timeout=6000)
            if response_data and 'choices' in response_data:
                res_text, _ = self._extract_message(response_data['choices'][0].get('message', {}))
                fixed_text = self._fix_truncated_json(res_text)
                translated_batch = self._extract_json_from_text(fixed_text)
                if translated_batch:
                    print(f"   ✅ 第 {batch_num} 批翻译成功")
                    return self._apply_post_process(batch_data, translated_batch, trans_type)
                print(f"   ⚠️ 第 {batch_num} 批解析JSON失败，保留原文。")
            else:
                print(f"   ⚠️ 第 {batch_num} 批无有效返回。")
            return batch_data
        except Exception as e:
            print(f"   ❌ {desc}第 {batch_num} 批失败: {e}")
            return batch_data

    def _smart_translate_routine(self, data, url, headers, model, system_prompt, local_config=None, batch_size=5, desc="处理", trans_type=None):
        """统一的智能翻译流程。
        
        当 trans_type 为 None 时：兼容旧的通用翻译模式（简单 JSON 翻译 + nuclear_sanitize）。
        当 trans_type 指定时：使用优化的类型感知提示词 + 节点级合并。
        API 模式并发请求（上限 API_CONCURRENCY）+ 温和节流；本地推理串行（共享模型与显存）。
        """
        # 根据翻译类型自动适配批次和 token 上限
        if trans_type == 'nodes':
            BATCH_SIZE = min(batch_size, 3)   # 节点翻译每批 ≤3 个，太多 JSON 会截断
            local_max_tokens = 16384
            api_max_tokens = 8192
        elif trans_type == 'frontend_js':
            BATCH_SIZE = max(batch_size, 15)  # 前端文本简短，默认至少 15 条/批
            local_max_tokens = 8192
            api_max_tokens = 8192
        else:
            BATCH_SIZE = batch_size
            local_max_tokens = 8192
            api_max_tokens = 4096

        keys = list(data.keys())
        batches = []
        for i in range(0, len(keys), BATCH_SIZE):
            batch_keys = keys[i : i + BATCH_SIZE]
            batches.append((i // BATCH_SIZE + 1, {k: data[k] for k in batch_keys}))

        def _run(batch):
            batch_num, batch_data = batch
            print(f"   ...{desc}第 {batch_num} 批 ({len(batch_data)} 个条目)...")
            if interrupted():
                return batch_data
            if not local_config:
                time.sleep(API_REQUEST_INTERVAL)  # 温和节流，避免打爆服务商
            return self._translate_single_batch(batch_num, batch_data, url, headers, model, system_prompt, local_config, local_max_tokens, api_max_tokens, trans_type, desc)

        merged_result = {}
        if local_config:
            # 本地推理串行（共享模型与显存，不能并发）
            for batch in batches:
                if interrupted():
                    print("👨‍🏫 班长: 接到中断指令，停止翻译任务！")
                    break
                merged_result.update(_run(batch))
        else:
            # API 并发，max_workers 即限流上限
            with ThreadPoolExecutor(max_workers=API_CONCURRENCY) as pool:
                for result in pool.map(_run, batches):
                    merged_result.update(result)

        return merged_result

    def _apply_post_process(self, original_batch, translated_batch, trans_type):
        """对翻译结果应用后处理：节点翻译走 merge，前端JS文本保留元数据，其他直接使用"""
        if trans_type == 'nodes':
            return self._merge_node_translation(original_batch, translated_batch)
        elif trans_type == 'frontend_js':
            return self._merge_frontend_js_translation(original_batch, translated_batch)
        elif trans_type:
            return translated_batch  # categories/menus 直接使用
        else:
            return self._nuclear_sanitize(translated_batch)

    def _is_chinese_dominant(self, text):
        """文本中中文字符占比超过 50% → 已是中文，无需翻译"""
        if not text:
            return False
        chars = [c for c in str(text) if c.isalpha() or '\u4e00' <= c <= '\u9fff']
        if not chars:
            return False
        chinese = sum(1 for c in chars if '\u4e00' <= c <= '\u9fff')
        return chinese / len(chars) > 0.5

    def _prefilter_translation_data(self, data, trans_type):
        """翻译前去重 + 跳过已是中文的条目，大幅减少 API 调用量。
        
        返回: (need_translate, skip_map, duplicate_map)
          - need_translate: 实际需要翻译的数据
          - skip_map: {原始key: 结果值}，翻译后合并用
          - duplicate_map: {去重文本: 首个key}，翻译后回填用
        """
        skip_map = {}
        need_translate = {}
        
        if trans_type != 'frontend_js' and trans_type != 'nodes':
            # 简单类型不过滤
            return data, {}, {}
        
        # 去重映射：相同文本 → 第一个 key
        content_map = {}  # {text_hash: first_key}
        
        for key, item in data.items():
            if not isinstance(item, dict):
                need_translate[key] = item
                continue
            
            # 仅 frontend_js 做去重+buffering，nodes 保持原样
            if trans_type == 'frontend_js':
                title = item.get('title', '') if isinstance(item, dict) else str(item)
                
                # 纯符号/数字 → 跳过
                text_content = str(title).strip()
                if not text_content or not any(c.isalpha() for c in text_content):
                    skip_map[key] = dict(item) if isinstance(item, dict) else item
                    continue
                
                # 已是中文 → 跳过
                if self._is_chinese_dominant(text_content):
                    skip_map[key] = dict(item) if isinstance(item, dict) else item
                    continue
                
                # 去重
                text_hash = text_content.strip().lower()
                if text_hash in content_map:
                    skip_map[key] = dict(item) if isinstance(item, dict) else item
                    continue
                content_map[text_hash] = key
                need_translate[key] = item
            else:
                need_translate[key] = item
        
        return need_translate, skip_map, content_map

    def _fill_duplicate_translations(self, translated_data, skip_map, original_data, duplicate_map=None):
        """翻译完成后，把相同文本的结果复制给被去重的 key"""
        result = dict(translated_data)
        result.update(skip_map)
        
        # 去重回填
        if duplicate_map:
            for dup_text, first_key in duplicate_map.items():
                if first_key in translated_data:
                    for key, item in original_data.items():
                        if not isinstance(item, dict):
                            continue
                        text = str(item.get('title', '')).strip().lower()
                        if text == dup_text and key != first_key:
                            result[key] = dict(translated_data[first_key])  # 复制
        
        return result

    @staticmethod
    def _normalize_ai_result(translated_batch):
        """规范化 AI 返回的翻译结果，兼容两种简化格式：
        1. {key: "纯文本译文"} → {key: {"title": "纯文本译文"}}
        2. 非法值 → 丢弃
        避免合法译文因格式偏差被合并逻辑丢弃，导致质检永远判缺失。
        """
        normalized = {}
        for k, v in translated_batch.items():
            if isinstance(v, str):
                normalized[k] = {"title": v}
            elif isinstance(v, dict):
                normalized[k] = v
        return normalized

    def _merge_frontend_js_translation(self, original_batch, translated_batch):
        """合并前端 JS 翻译结果：保留 file/context 元数据，只更新 title

        兼容 AI 返回格式偏差：
        - {key: "译文"} 简化格式（自动规范化为 title）
        - AI 用原文标题（而非 js_ 前缀键）作为键返回（按标题反查兜底）
        """
        normalized = self._normalize_ai_result(translated_batch)
        merged = {}
        for key, original_item in original_batch.items():
            if not isinstance(original_item, dict):
                merged[key] = original_item
                continue

            translated_item = normalized.get(key)
            if not isinstance(translated_item, dict):
                # 兜底：AI 可能把原文标题当作键返回
                by_title = normalized.get(str(original_item.get("title", "")).strip())
                if isinstance(by_title, dict):
                    translated_item = by_title
            if not isinstance(translated_item, dict):
                translated_item = {}

            merged_item = {
                "title": translated_item.get("title", original_item.get("title", key)),
                "original": str(original_item.get("title", "")),  # 保留英文原文，供保存阶段转换为 DD-Translation 格式
                "file": original_item.get("file", ""),
                "context": original_item.get("context", ""),
            }
            # 保留原始 inputs/widgets/outputs（如果有）
            for field in ["inputs", "widgets", "outputs"]:
                if field in original_item:
                    merged_item[field] = original_item[field]

            merged[key] = merged_item

        return merged

    @staticmethod
    def _convert_js_entries_for_dd_translation(data):
        """把 js_ 前缀条目转换为 ComfyUI-DD-Translation 可消费的格式。

        DD-Translation 前端机制：从 Nodes 字典提取「键名 → title」进 Menu 字典，
        再由 DOM 替换引擎用 Menu[界面英文文本] 翻译前端文本。
        因此 js 条目的键必须是英文原文（而非 js_ 前缀清洗键），界面文本才能命中。

        转换: {"js_Save_Image": {"title": "保存图片", "original": "Save Image", ...}}
              → {"Save Image": {"title": "保存图片"}}

        无 original 字段的 js 条目（旧格式文件）用英文 title 兜底作键；
        键含中文（原文已丢失，无法还原英文键）或与节点类名/已有键冲突的，原样保留。
        返回: (转换后的数据, 转换条数, 保留条数)
        """
        converted = {}
        node_keys = {k for k in data if not str(k).startswith("js_")}
        js_converted = 0
        js_kept = 0
        for key, item in data.items():
            if str(key).startswith("js_") and isinstance(item, dict):
                original = str(item.get("original", "")).strip()
                title = item.get("title", "")
                if not original:
                    # 旧格式兜底：title 仍是英文时，直接用英文标题作键
                    t0 = str(title).strip()
                    if t0 and re.search(r'[A-Za-z]', t0) and not re.search(r'[\u4e00-\u9fff]', t0):
                        original = t0
                if (original and title
                        and original not in node_keys and original not in converted
                        and not re.search(r'[\u4e00-\u9fff]', original)):
                    converted[original] = {"title": title}
                    node_keys.add(original)
                    js_converted += 1
                else:
                    converted[key] = item
                    js_kept += 1
            else:
                converted[key] = item
        return converted, js_converted, js_kept

    def _merge_node_translation(self, original_batch, translated_batch):
        """智能合并节点翻译结果，保留原始数据中的有效字段。
        兼容 AI 返回 {key: "纯文本译文"} 的简化格式（视为 title 译文）。"""
        normalized = self._normalize_ai_result(translated_batch)
        merged = {}
        for node_name, original_node in original_batch.items():
            if not isinstance(original_node, dict):
                merged[node_name] = original_node
                continue

            # 获取翻译后的节点数据
            translated_node = normalized.get(node_name, {})
            if not isinstance(translated_node, dict):
                translated_node = {}

            merged_node = {}

            # 合并 title
            if 'title' in original_node:
                merged_node['title'] = translated_node.get('title', original_node['title'])

            # 合并 description
            if 'description' in original_node:
                merged_node['description'] = translated_node.get('description', original_node['description'])

            # 合并 inputs
            if 'inputs' in original_node and isinstance(original_node['inputs'], dict):
                merged_inputs = {}
                for key, value in original_node['inputs'].items():
                    if isinstance(translated_node.get('inputs'), dict):
                        merged_inputs[key] = translated_node['inputs'].get(key, value)
                    else:
                        merged_inputs[key] = value
                if merged_inputs:
                    merged_node['inputs'] = merged_inputs

            # 合并 widgets
            if 'widgets' in original_node and isinstance(original_node['widgets'], dict):
                merged_widgets = {}
                for key, value in original_node['widgets'].items():
                    if isinstance(translated_node.get('widgets'), dict):
                        merged_widgets[key] = translated_node['widgets'].get(key, value)
                    else:
                        merged_widgets[key] = value
                if merged_widgets:
                    merged_node['widgets'] = merged_widgets

            # 合并 outputs
            if 'outputs' in original_node and isinstance(original_node['outputs'], dict):
                merged_outputs = {}
                for key, value in original_node['outputs'].items():
                    if isinstance(translated_node.get('outputs'), dict):
                        merged_outputs[key] = translated_node['outputs'].get(key, value)
                    else:
                        merged_outputs[key] = value
                if merged_outputs:
                    merged_node['outputs'] = merged_outputs

            merged[node_name] = merged_node

        return merged

    def _run_local_inference(self, config, system_prompt, user_prompt, media_seq, fps, max_tokens, temperature, max_side):
        # GGUF (llama.cpp) 分支：与 HF 路径分开实现
        if str(config.get("model_type", "")) == ModelType.GGUF.value:
            return self._run_local_gguf_inference(
                config, system_prompt, user_prompt, media_seq,
                max_tokens, temperature, max_side)
        if not TRANSFORMERS_AVAILABLE: return "❌ 错误: 未安装 transformers", ""
        
        model_name = config["model_name"]
        quantization = config["quantization"]
        keep_loaded = config["keep_loaded"]
        
        print(f"📊 [显存侦探] 加载前: {get_vram_info()}")
        
        try:
            bnb_available = False
            try: import bitsandbytes; bnb_available = True
            except ImportError: pass
            
            print("👨‍🏫 班长: 强制使用 sdpa 注意力机制")
            model_path = self.downloader.ensure_model_available(model_name)
            cache_key = f"{model_name}_{quantization}"
            
            global MODEL_CACHE, PROCESSOR_CACHE, TOKENIZER_CACHE
            # 缓存只留当前模型：改量化/换模型都会产生新 key，旧 key 不淘汰就一份份堆显存
            for _old in [k for k in MODEL_CACHE if k != cache_key]:
                print(f"👨‍🏫 班长: 释放旧模型缓存 {_old}")
                release_model(_old)
            if cache_key not in MODEL_CACHE:
                print(f"👨‍🏫 班长: 加载模型 {model_name}...")
                load_kwargs = {"device_map": "auto", "trust_remote_code": True, "attn_implementation": "sdpa"}
                q_str = str(quantization)
                if bnb_available and q_str in [Quantization.Q4_BIT.value, Quantization.Q8_BIT.value]:
                    q_config = BitsAndBytesConfig(load_in_4bit=True, bnb_4bit_compute_dtype=torch.float16) if "4-bit" in q_str else BitsAndBytesConfig(load_in_8bit=True)
                    load_kwargs["quantization_config"] = q_config
                else:
                    load_kwargs["torch_dtype"] = torch.float16

                model = AutoModelForImageTextToText.from_pretrained(model_path, **load_kwargs).eval()
                
                if torch.cuda.is_available() and model.device.type == 'cpu' and not (bnb_available and q_str != "None (FP16)"):
                    try:
                        print("👨‍🏫 班长: 检测到模型被分配在 CPU，正在强制移动至显卡 GPU...")
                        model = model.to("cuda")
                    except Exception as e:
                        print(f"👨‍🏫 班长警告: 强制移动至 GPU 失败，可能是显存不足: {e}")
                
                processor = AutoProcessor.from_pretrained(model_path, trust_remote_code=True)
                tokenizer = AutoTokenizer.from_pretrained(model_path, trust_remote_code=True)
                
                MODEL_CACHE[cache_key] = model
                PROCESSOR_CACHE[cache_key] = processor
                TOKENIZER_CACHE[cache_key] = tokenizer
            
            model = MODEL_CACHE[cache_key]
            processor = PROCESSOR_CACHE[cache_key]
            tokenizer = TOKENIZER_CACHE.get(cache_key)

            messages = []
            if system_prompt: messages.append({"role": "system", "content": [{"type": "text", "text": system_prompt}]})
            
            user_content = []
            for item in media_seq:
                no = item["no"]
                if item["kind"] == "audio":
                    print(f"👨‍🏫 班长: 本地推理模式暂不支持音频，[音频{no}] 已跳过（音频直传仅 API 模式生效）")
                    continue
                if item["kind"] == "image":
                    user_content.append({"type": "text", "text": f"[图片{no}]"})
                    pil_img = self.image_processor.to_pil(item["tensor"], max_side).convert("RGB")
                    user_content.append({"type": "image", "image": pil_img})
                else:
                    vid_pil_list = [self.image_processor.to_pil(f, max_side).convert("RGB") for f in item["tensor"]]
                    if len(vid_pil_list) == 1: vid_pil_list.append(vid_pil_list[0])
                    user_content.append({"type": "text", "text": f"[视频{no}]（以下帧按时间顺序）"})
                    user_content.append({"type": "video", "video": vid_pil_list})

            user_content.append({"type": "text", "text": user_prompt})
            messages.append({"role": "user", "content": user_content})

            text_prompt = processor.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
            
            image_inputs = [c['image'] for c in user_content if c['type'] == 'image']
            video_inputs = [c['video'] for c in user_content if c['type'] == 'video']
            
            inputs = processor(
                text=[text_prompt],
                images=image_inputs if image_inputs else None,
                videos=video_inputs if video_inputs else None,
                return_tensors="pt",
                padding=True
            )
            
            inputs = inputs.to(model.device)
            for k, v in inputs.items():
                if torch.is_floating_point(v):
                    inputs[k] = v.to(model.dtype)

            stop_tokens = [tokenizer.eos_token_id] if tokenizer else []
            if tokenizer and hasattr(tokenizer, 'eot_id'): stop_tokens.append(tokenizer.eot_id)

            streamer = TextIteratorStreamer(tokenizer, skip_prompt=True, skip_special_tokens=True)
            stopping_criteria = StoppingCriteriaList([StreamStoppingCriteria()])

            gen_kwargs = {
                "max_new_tokens": max_tokens, "temperature": temperature, "do_sample": True if temperature > 0 else False,
                "eos_token_id": stop_tokens, "streamer": streamer, "stopping_criteria": stopping_criteria
            }
            if tokenizer.pad_token_id is not None: gen_kwargs["pad_token_id"] = tokenizer.pad_token_id

            gc.collect(); torch.cuda.empty_cache()
            
            generated_text_container = [""]
            generation_error = [None]
            stop_wait = threading.Event()  # 生成线程异常时通知主线程停止等待
            def thread_target():
                try: model.generate(**dict(inputs, **gen_kwargs))
                except Exception as e:
                    generation_error[0] = str(e)
                    stop_wait.set()  # 通知主线程停止等待
            
            thread = threading.Thread(target=thread_target)
            thread.start()
            
            # 终端不再分块写：ComfyUI 的日志走 WS 广播，一次 write 就是前端一行，
            # 逐块写会把控制台刷成一字一行。正文在生成结束后整段输出一次，
            # 中途只报字数当心跳。
            print("📝 生成内容: 生成中……", flush=True)
            _chunks = 0
            for new_text in streamer:
                if interrupted() or stop_wait.is_set(): break
                generated_text_container[0] += new_text
                _chunks += 1
                if _chunks % 200 == 0:
                    print(f"…已生成 {len(generated_text_container[0])} 字", flush=True)

            thread.join(timeout=10)  # 等待生成线程结束
            if generation_error[0]:
                print(f"\n👨‍🏫 班长: 生成过程中发生错误: {generation_error[0]}")
                if not generated_text_container[0]:
                    return (f"❌ 生成失败: {generation_error[0]}", "")
            
            print(f"📝 生成内容（{len(generated_text_container[0])} 字）:")
            if generated_text_container[0]:
                print(generated_text_container[0])
            print("\n👨‍🏫 班长: 生成结束。")

            # 截断检测：生成 token 数触达 max_tokens 上限 → 提示调大参数
            truncation_note = ""
            try:
                if tokenizer is not None:
                    gen_tokens = len(tokenizer.encode(generated_text_container[0]))
                    if gen_tokens >= max_tokens:
                        truncation_note = (
                            f"⚠️ 输出疑似被截断：生成 {gen_tokens} tokens，触达 🔢 最大Token 上限（{max_tokens} tokens = {max_tokens/10000:g}万），"
                            "请调大该参数后重新运行")
                        print(f"\n👨‍🏫 班长: {truncation_note}")
            except Exception:
                pass

            if not keep_loaded:
                # 生成线程还活着时对象仍被它引用，此刻卸载只会腾出半截显存后又被占回去
                if thread.is_alive():
                    print("👨‍🏫 班长警告: 生成线程未退出，本次跳过卸载")
                else:
                    _gpu_before = get_gpu_used()
                    release_model(cache_key)
                    # 局部变量不清，字典删了对象也活着，empty_cache 等于白调
                    model = processor = tokenizer = None
                    inputs = thread = streamer = None
                    gc.collect()
                    if torch.cuda.is_available(): torch.cuda.empty_cache()
                    print(f"🧹 班长: 已卸载本地模型 {cache_key}（整卡显存 {_gpu_before} → {get_gpu_used()}）")

            return ((f"✅ 成功！\n{truncation_note}" if truncation_note else "✅ 成功！"),
                    generated_text_container[0])
        except Exception as e: return (f"❌ 失败: {e}", "")

    def _run_local_gguf_inference(self, config, system_prompt, user_prompt, media_seq,
                                  max_tokens, temperature, max_side):
        """GGUF 本地推理（llama.cpp）：支持 Qwen3-VL / Qwen2.5-VL 视觉 GGUF 与纯文本 GGUF。
        Qwen3VL chat handler 暂不支持原生 video，视频按时间均匀抽帧展开为多图。"""
        try:
            # 依赖缺失时自动安装（本地 wheels/ 优先，再联网兜底）；装了就直接用
            from ..banzhang_dep_installer import ensure_pip_package
            _ok, _ = ensure_pip_package(
                "llama_cpp", "llama-cpp-python", "llama_cpp_python-*.whl",
                label="Qwen3VL/GGUF 本地推理", preimport=("torch",))
            if not _ok:
                raise ImportError("llama-cpp-python 自动安装失败，请查看 ComfyUI 控制台")
            import llama_cpp
            from llama_cpp import Llama
            from llama_cpp import llama_chat_format
        except Exception as e:
            return (f"❌ 错误: llama-cpp-python 不可用（{e}）。"
                    "重启 ComfyUI 会自动安装，或把 llama_cpp_python 的 wheel 放进插件 wheels/ 目录。", "")

        label = config.get("model_name", "")
        try:
            model_path, mmproj_path = resolve_gguf_model(label)
        except Exception as e:
            return (f"❌ 失败: {e}", "")

        # 1) 收集图片：图片直接转 PIL；视频均匀抽帧（最多 16 帧）；音频跳过
        VIDEO_MAX_FRAMES = 16
        pil_images = []
        for item in media_seq:
            no = item["no"]
            if item["kind"] == "audio":
                print(f"👨‍🏫 班长: GGUF 本地推理暂不支持音频，[音频{no}] 已跳过")
                continue
            if item["kind"] == "image":
                pil_images.append((f"图片{no}",
                                   self.image_processor.to_pil(item["tensor"], max_side).convert("RGB")))
            else:
                frames = item["tensor"]
                total = frames.shape[0]
                if total > VIDEO_MAX_FRAMES:
                    gap = total / VIDEO_MAX_FRAMES
                    idxs = [int(i * gap + gap / 2) for i in range(VIDEO_MAX_FRAMES)]
                else:
                    idxs = list(range(total))
                for j, fi in enumerate(idxs):
                    pil_images.append((f"视频{no}-帧{j+1}",
                                       self.image_processor.to_pil(frames[fi], max_side).convert("RGB")))

        # 2) 有视觉输入必须配对 mmproj
        if pil_images and mmproj_path is None:
            return ("❌ 失败: 检测到图片/视频输入，但未找到视觉投影 mmproj*.gguf"
                    "（请将 mmproj 文件与模型放在同一目录或其父目录）", "")

        # 3) 选择视觉 chat handler：
        #    - MiniCPM-V（mmproj 为 minicpmv resampler：图像切片 + 每片 64 query token）
        #      必须用 MiniCPMv26ChatHandler；它自带可处理多模态 list 的 ChatML 模板。
        #      若误用 MTMD，其不转换 MiniCPM 的多模态消息，会在 jinja 渲染阶段崩
        #      （'list object' has no attribute 'startswith'）。
        #    - 其余视觉 GGUF（Qwen3-VL / Qwen3.8 / Qwen2.5-VL）在 llama_cpp 0.3.36+
        #      统一走 MTMDChatHandler（内置 MTMD 框架，按 mmproj 自动识别视觉架构）。
        #    - 旧版 llama_cpp 回退到按模型族匹配的专用 handler。
        low = label.lower()
        if "minicpm" in low and hasattr(llama_chat_format, "MiniCPMv26ChatHandler"):
            handler_cls = llama_chat_format.MiniCPMv26ChatHandler
        elif hasattr(llama_chat_format, "MTMDChatHandler"):
            handler_cls = llama_chat_format.MTMDChatHandler
        else:
            if ("qwen2.5" in low or "qwen25" in low or "qwen2_5" in low) and hasattr(llama_chat_format, "Qwen25VLChatHandler"):
                handler_cls = llama_chat_format.Qwen25VLChatHandler
            elif hasattr(llama_chat_format, "Qwen3VLChatHandler"):
                handler_cls = llama_chat_format.Qwen3VLChatHandler
            else:
                handler_cls = llama_chat_format.Llava15ChatHandler

        # 4) 加载模型（带缓存）
        context_length = int(config.get("context_length", 8192))
        gpu_layers = int(config.get("gpu_layers", -1))
        keep_loaded = config.get("keep_loaded", True)
        cache_key = f"gguf::{label}::{context_length}::{gpu_layers}"

        global MODEL_CACHE
        print(f"📊 [显存侦探] 加载前: {get_vram_info()}")
        try:
            # 缓存只留当前模型：改上下文长度/gpu_layers 都会产生新 key，
            # 旧 key 里的 llama context 与视觉塔不淘汰就会一直占着显存与内存
            for _old in [k for k in MODEL_CACHE if k != cache_key]:
                print(f"👨‍🏫 班长: 释放旧模型缓存 {_old}")
                release_model(_old)
            if cache_key not in MODEL_CACHE:
                print(f"👨‍🏫 班长: 加载 GGUF 模型 {label} ...")
                if mmproj_path:
                    if handler_cls is getattr(llama_chat_format, "MTMDChatHandler", None):
                        # MTMD：视觉塔放 GPU、静默
                        chat_handler = handler_cls(clip_model_path=str(mmproj_path), verbose=False, use_gpu=True)
                    else:
                        chat_handler = handler_cls(clip_model_path=str(mmproj_path), verbose=False)
                else:
                    chat_handler = None
                # 构造参数分两档：
                #   增强档 = FlashAttention + q8_0 量化 KV。量化 KV 显存约为 f16 的一半，
                #            可开近 2 倍上下文，对视觉打标/翻译精度与速度几乎无影响；
                #            但量化 KV 必须开 FA（type_k/v 需传 ggml 整数枚举）。
                #   普通档 = f16 KV、无 FA（Llama 默认值）。
                # CPU 版/旧版 llama-cpp-python 没有 FA 实现，带增强档参数构造会直接
                # 失败。故先试增强档，失败自动退普通档——别的用户装到 PyPI CPU 版时
                # 不至于节点报错，只是慢一点、费一点显存。
                base_kwargs = dict(
                    model_path=str(model_path),
                    n_ctx=context_length,
                    n_gpu_layers=gpu_layers,
                    n_batch=2048,
                    chat_handler=chat_handler,
                    verbose=False,
                )
                old_stdout, old_stderr = sys.stdout, sys.stderr
                used_fallback = False
                fallback_reason = ""
                # KV 量化的枚举值不能写死常量名：llama-cpp-python 0.4.x 起不再导出
                # GGML_TYPE_Q8_0（ggml_type 枚举本身没动，Q8_0 恒为 8，且官方约定
                # 该枚举只往末尾加项）。写死名字 = 每次加载都 AttributeError，被
                # except 吞掉后**永久**退回普通档，日志还只说"不支持"，看不出真凶。
                _q8 = getattr(llama_cpp, "GGML_TYPE_Q8_0", 8)
                try:
                    log_buf = io.StringIO()
                    sys.stdout, sys.stderr = log_buf, log_buf
                    try:
                        llama = Llama(
                            flash_attn=True,
                            type_k=int(_q8),
                            type_v=int(_q8),
                            **base_kwargs,
                        )
                    except Exception as _adv_err:
                        used_fallback = True
                        fallback_reason = "%s: %s" % (type(_adv_err).__name__, _adv_err)
                        try:
                            llama = Llama(**base_kwargs)
                        except Exception as _load_err:
                            # 两档都起不来。llama.cpp 的真实原因只打在 stderr 上，
                            # 被这里的静默吞掉了 —— 不带出来用户只剩一句笼统英文可看。
                            tail = log_buf.getvalue().strip()[-1500:]
                            low = tail.lower()
                            if ("out of memory" in low or "cudamalloc" in low
                                    or "unable to allocate" in low):
                                why = ("显存不够：把「🖥️ GPU 层数」往下调一档，"
                                       "或把「📝 上下文长度」调小，也可以换更小的量化档。")
                            elif ("unknown model architecture" in low
                                    or "unsupported model" in low):
                                why = "当前 llama-cpp-python 不认识这个模型的结构，需要更新插件依赖后重启。"
                            elif tail:
                                why = "上面是 llama.cpp 的原始输出，常见原因是模型文件没下完，请重新下载该 .gguf。"
                            else:
                                why = ("llama.cpp 没给出细节。先核对模型文件大小与下载页一致，"
                                       "再把「🖥️ GPU 层数」调小重试。")
                            raise RuntimeError(
                                f"{_load_err}\n\n🧾 llama.cpp 原始输出：\n{tail or '（无）'}\n\n💡 {why}"
                            )
                finally:
                    sys.stdout, sys.stderr = old_stdout, old_stderr
                if used_fallback:
                    print("👨‍🏫 班长: 当前 llama-cpp-python 不支持 FlashAttention/量化KV，"
                          "已回退普通模式（CPU 版也能跑，但更慢、更费显存）。"
                          "原因：" + fallback_reason)
                else:
                    print("⚡ 班长: 增强档已生效（FlashAttention + q8_0 量化 KV）")

                # 思考型 Qwen 系（Qwen3/3.5/3.8 thinking 等）默认会先生成大段内部推理，
                # 挤占打标/翻译/写提示词的输出额度。llama.cpp 渲染模板时不传 enable_thinking
                # （变量未定义→模板默认走“思考”分支）。这里把默认翻转为“未定义即不思考”：
                # 仅当显式 enable_thinking=True 才思考；不含该变量的模板（MiniCPM/LLaVA 等）
                # 匹配不到，原样不动。MTMD 每次请求都从 metadata 现读模板，故改这里即时生效。
                _tmpl = llama.metadata.get("tokenizer.chat_template")
                if isinstance(_tmpl, str) and "enable_thinking" in _tmpl:
                    _patched_tmpl = re.sub(
                        r"enable_thinking\s+is\s+defined\s+and\s+enable_thinking\s+is\s+false",
                        "enable_thinking is not defined or enable_thinking is false",
                        _tmpl, count=1)
                    if _patched_tmpl != _tmpl:
                        llama.metadata["tokenizer.chat_template"] = _patched_tmpl
                        print("🧠 班长: 已关闭该模型默认思考（直接输出结果）")

                MODEL_CACHE[cache_key] = llama
            llama = MODEL_CACHE[cache_key]

            # 5) 构造消息（image_url + data URI；文本标签便于模型引用）
            def to_data_uri(pil):
                buf = io.BytesIO()
                pil.save(buf, format="PNG")
                return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode("utf-8")

            content = []
            for nm, pil in pil_images:
                content.append({"type": "text", "text": f"[{nm}]"})
                content.append({"type": "image_url", "image_url": {"url": to_data_uri(pil)}})
            content.append({"type": "text", "text": user_prompt})
            messages = [
                {"role": "system", "content": (system_prompt or "You are a helpful assistant.")},
                {"role": "user", "content": content}
            ]

            # 6) 流式生成（逐 chunk 支持中断）
            completion_params = {
                "messages": messages,
                "max_tokens": max_tokens,
                "temperature": float(temperature),
                "stream": True,
                "repeat_penalty": 1.1,
            }
            # 同 Transformers 那条路径：终端不逐块写，正文整段输出一次。
            print("📝 生成内容: 生成中……", flush=True)
            parts = []
            try:
                streamer = llama.create_chat_completion(**completion_params)
                for chunk in streamer:
                    if interrupted():
                        try: streamer.close()
                        except: pass
                        break
                    try:
                        delta = chunk["choices"][0]["delta"].get("content") or ""
                    except Exception:
                        delta = ""
                    if delta:
                        parts.append(delta)
                        # 长回答给个粗粒度心跳（每 200 块一次），否则几分钟没动静
                        # 看着像卡死；正文不逐块打，见下面的整段输出。
                        if len(parts) % 200 == 0:
                            print(f"…已生成 {len(''.join(parts))} 字", flush=True)
            except Exception as gen_error:
                if not parts:
                    return (f"❌ 生成失败: {gen_error}", "")
                print(f"\n👨‍🏫 班长警告: 流中途异常: {gen_error}")
            full_text = "".join(parts).strip()
            print(f"📝 生成内容（{len(full_text)} 字）:")
            if full_text:
                print(full_text)

            # 7) 截断检测（按实际生成 token 数与上限比较）
            truncation_note = ""
            try:
                gen_tokens = len(llama.tokenize(full_text.encode("utf-8"), add_bos=False))
                if gen_tokens >= max_tokens:
                    truncation_note = (
                        f"⚠️ 输出疑似被截断：生成 {gen_tokens} tokens，触达 🔢 最大Token 上限"
                        f"（{max_tokens} tokens = {max_tokens/10000:g}万），请调大上下文/Token 参数后重新运行")
            except Exception:
                pass

            # 8) 不保持加载则真卸载：GGUF 的权重与 KV 在 C 层，pop 字典拿不回显存和内存
            if not keep_loaded:
                _gpu_before = get_gpu_used()
                release_model(cache_key)
                llama = streamer = None
                gc.collect()
                if torch.cuda.is_available(): torch.cuda.empty_cache()
                print(f"🧹 班长: 已卸载 GGUF 模型 {label}（整卡显存 {_gpu_before} → {get_gpu_used()}）")

            return ((f"✅ 成功！\n{truncation_note}" if truncation_note else "✅ 成功！"),
                    full_text)
        except Exception as e:
            return (f"❌ 失败: {e}", "")

    @staticmethod
    def _extract_message(msg):
        """统一解析 OpenAI 兼容响应：返回 (正文, 思考过程)。
        思考字段各家不同：reasoning_content / reasoning / 内联 <think>，本地则返回两部分合并前的原文。"""
        content = msg.get("content") or ""
        reasoning = msg.get("reasoning_content") or msg.get("reasoning") or ""
        clean, inline_think = "", ""
        if content:
            clean, inline_think = re.sub(r'<think>.*?</think>', '', content, flags=re.DOTALL).strip(), ""
            m = re.search(r'<think>(.*?)</think>', content, flags=re.DOTALL)
            inline_think = m.group(1).strip() if m else ""
        return clean, (reasoning.strip() or inline_think)

    @staticmethod
    def _relax_payload(payload, error_body):
        """按服务商报错调整它不支持的字段。
        返回 (新 payload, 说明)；无法降级返回 (None, None)。
        各家服务对不支持的参数只在 400 body 里说明，除读报错外无可靠发现手段。"""
        if "max_completion_tokens" in error_body and "max_tokens" in payload:
            p = dict(payload)
            p["max_completion_tokens"] = p.pop("max_tokens")
            return p, "max_tokens → max_completion_tokens"
        m = re.search(r'\[\s*1\s*,\s*(\d+)\s*\]', error_body)
        if m and "max_tokens" in payload and payload["max_tokens"] > int(m.group(1)):
            p = dict(payload)
            p["max_tokens"] = int(m.group(1))
            return p, f"max_tokens 封顶 {m.group(1)}"
        for field in ("max_tokens", "max_completion_tokens", "temperature", "top_p",
                      "response_format", "presence_penalty", "penalty"):
            if field in payload and field in error_body:
                p = dict(payload)
                p.pop(field)
                return p, f"移除不支持的 {field}"
        return None, None

    def _call_stream(self, url, headers, payload, timeout, on_chunk):
        """流式请求：逐 SSE 行累积，避免长响应被网关一次性掐断；支持中断即停"""
        req = urllib.request.Request(url, data=json.dumps(payload).encode('utf-8'), headers=headers)
        ctx = ssl.create_default_context()
        with urllib.request.urlopen(req, context=ctx, timeout=timeout) as resp:
            content, reasoning, finish = [], [], None
            for raw in resp:
                if interrupted():
                    return None
                line = raw.decode('utf-8').strip() if isinstance(raw, bytes) else str(raw).strip()
                if not line.startswith("data:"):
                    continue
                data = line[5:].strip()
                if data == "[DONE]":
                    break
                try:
                    chunk = json.loads(data)
                except Exception:
                    continue
                for choice in chunk.get("choices") or []:
                    delta = (choice.get("delta") or {}) if "delta" in choice else (choice.get("message") or {})
                    piece = delta.get("content")
                    if piece:
                        content.append(piece)
                        if on_chunk:
                            on_chunk(piece)
                    think = delta.get("reasoning_content") or delta.get("reasoning")
                    if think:
                        reasoning.append(think)
                    finish = finish or choice.get("finish_reason")
        if not content and not reasoning:
            raise RuntimeError("流式响应无内容（网关不支持流式或被缓冲）")
        return {"choices": [{"message": {"content": "".join(content),
                                         "reasoning_content": "".join(reasoning)},
                             "finish_reason": finish}]}

    def _call_api(self, url, headers, payload, timeout=6000, on_chunk=None):
        """统一请求入口。传 on_chunk 则走流式（增量输出、长响应不被网关掐断）。
        按服务商报错自动降级：流式不可用→一次性读取；字段不支持→改名/封顶/移除。"""
        attempt_payload = dict(payload)
        attempt_payload["stream"] = on_chunk is not None
        max_attempts = 6

        for attempt in range(max_attempts):
            try:
                if interrupted():
                    return None
                if attempt_payload["stream"]:
                    return self._call_stream(url, headers, attempt_payload, timeout, on_chunk)

                req = urllib.request.Request(url, data=json.dumps(attempt_payload).encode('utf-8'), headers=headers)
                ctx = ssl.create_default_context()
                with urllib.request.urlopen(req, context=ctx, timeout=min(timeout, 120)) as response:
                    raw = response.read().decode('utf-8', errors='replace')
                try:
                    return json.loads(raw)
                except json.JSONDecodeError:
                    raise Exception(f"API 返回的不是 JSON（地址填错或被网关拦截）: {raw[:200]}")
            except urllib.error.HTTPError as e:
                try: error_body = e.read().decode('utf-8', errors='replace')
                except (UnicodeDecodeError, AttributeError): error_body = "未知错误"

                if "image input is not supported" in error_body:
                    raise Exception("❌ 致命错误：你的本地模型不支持图片！\n【原因】：你加载的是纯文本模型，或者启动器里没有正确加载 mmproj 视觉模块。\n【解决】：请在 ComfyUI 中【断开】该节点的素材连线，只输入文字；或者更换一个真正支持视觉的模型。")

                # 报错指明不支持流式 → 改为一次性读取
                if attempt_payload["stream"] and e.code == 400 and "stream" in error_body.lower():
                    print("🔧 班长: 服务商不支持流式，已回退一次性读取")
                    attempt_payload["stream"] = False
                    continue

                new_payload, note = self._relax_payload(attempt_payload, error_body)
                if new_payload is not None:
                    print(f"🔧 班长: {note}，已重试")
                    attempt_payload = new_payload
                    continue

                if e.code >= 500 or e.code == 429:
                    print(f"🔄 服务端错误 {e.code}，{2 * (attempt + 1)} 秒后重试 ({attempt + 1}/{max_attempts})... ({error_body[:80]})")
                    time.sleep(2 * (attempt + 1))
                    continue

                model_used = attempt_payload.get('model', '?')
                error_msg = f"HTTP {e.code}: {error_body}\n"
                error_msg += f"   📡 请求地址: {url}\n"
                error_msg += f"   🤖 模型名称: {model_used}\n"
                error_msg += f"   📦 请求字段: {', '.join(sorted(attempt_payload))}\n"
                if hasattr(e, 'headers'):
                    error_msg += f"   📋 响应头: {dict(e.headers)}"
                print(error_msg)
                raise Exception(f"HTTP {e.code} → URL: {url} → Model: {model_used} → 详情: {error_body[:200]}")
            except (urllib.error.URLError, TimeoutError) as e:
                if interrupted():
                    return None
                if attempt < max_attempts - 1:
                    print(f"🌐 网络异常/超时 ({e})，{2 * (attempt + 1)} 秒后重试...")
                    time.sleep(2 * (attempt + 1))
                    continue
                raise Exception(f"网络连接失败: {e}")

        raise Exception("API 请求重试已达上限，请检查自定义地址 / API Key / 模型名")

    def generate_content(self, **kwargs):
        preset_name = self._flatten_to_string(kwargs.get("🎨 提示词预设", "无 (使用自定义)"))
        system_prompt = self._flatten_to_string(kwargs.get("🧠 系统指令 (指令)", "")).strip()
        user_prompt = self._flatten_to_string(kwargs.get("🗣️ 用户提示 (正文)", "")).strip()
        json_path = self._flatten_to_string(kwargs.get("📂 JSON路径", "")).strip()
        
        batch_size = 5  # 内置默认，各类型自动适配

        if not system_prompt and not user_prompt:
            if preset_name in self.SYSTEM_PROMPTS:
                system_prompt = self.SYSTEM_PROMPTS[preset_name]
                user_prompt = "请描述这张图片。"
            elif not system_prompt:
                system_prompt = "你是一个专业、友好的AI助手。"

        is_json_task = bool(json_path and os.path.exists(json_path))
        local_config = kwargs.get("🔧 本地Qwen配置")

        # 汉化意图：预设名或系统提示词含「汉化」，但上游抓取失败（JSON 路径为空/无效）时直接中止，
        # 不再落入通用生成模式空跑（上游未找到插件时 JSON 路径为空）。
        is_translation_intent = ("汉化" in preset_name) or ("汉化" in system_prompt)
        if is_translation_intent and not is_json_task:
            reason = "上游抓取失败，JSON 路径为空" if not json_path else f"JSON 文件不存在：{json_path}"
            return (f"❌ 汉化中止：{reason}。请先检查「抓取神器」是否成功。", "", "")

        # 翻译模式：检测到 JSON 文件 + 汉化预设 或 JSON 文件 + 自定义系统提示词 → 走批量翻译流程
        is_translation_mode = is_json_task and ("汉化" in preset_name or system_prompt.strip())
        if is_translation_mode:
            try:
                with open(json_path, 'r', encoding='utf-8') as f:
                    json_data = json.load(f)

                # 按类型拆分数据，避免节点和JS文本混在一起用错提示词
                node_data = {}
                js_data = {}
                other_data = {}
                for key, item in json_data.items():
                    if isinstance(item, dict):
                        # JS 文本特征：有 file + context 字段
                        if 'file' in item and 'context' in item:
                            js_data[key] = item
                        # 节点特征：含 inputs/widgets/outputs 字段（即使为空 dict 也属节点壳）
                        elif any(f in item for f in ['inputs', 'widgets', 'outputs']):
                            node_data[key] = item
                        # 有 title 字段但无任何节点字段 → 归为 JS 文本
                        elif 'title' in item:
                            js_data[key] = item
                        else:
                            other_data[key] = item
                    else:
                        other_data[key] = item

                # 获取API配置
                url, headers, model, provider_key, _ = self._get_api_config(kwargs)

                # 获取质检次数
                base_quality = 5  # 内置默认，各类型自动适配

                type_names = {'nodes': '节点翻译', 'categories': '分类翻译', 'menus': '菜单翻译', 'frontend_js': '前端JS文本翻译'}

                # 构建详细运行报告
                report_lines = [
                    "📊 ========== 运行报告 (汉化模式) ==========",
                    f"📁 输入文件: {json_path}",
                    f"📝 原始条目数: {len(json_data)}",
                ]
                if node_data: report_lines.append(f"🔩 Python节点: {len(node_data)} 个")
                if js_data: report_lines.append(f"📱 前端JS文本: {len(js_data)} 条")
                if other_data: report_lines.append(f"📦 其他条目: {len(other_data)} 条")

                # 显示使用的模型信息
                if local_config:
                    report_lines.extend([
                        f"🤖 模型: {local_config.get('model_name', '未知')} (本地)",
                        f"⚙️ 量化: {local_config.get('quantization', '未知')}",
                    ])
                else:
                    report_lines.extend([
                        f"🌐 API 服务商: {provider_key}",
                        f"🤖 模型: {model}",
                    ])
                report_lines.append(f"📐 翻译策略: 各类型自动适配批次与质检")

                # 最终翻译结果
                final_translated = {}

                # ---- 翻译各类型数据 ----
                task_list = []
                if node_data: task_list.append(('nodes', node_data))
                if js_data: task_list.append(('frontend_js', js_data))
                if other_data: task_list.append((self._detect_translation_type(other_data) or 'menus', other_data))

                for trans_type, typed_data in task_list:
                    type_name = type_names.get(trans_type, '通用翻译')
                    original_count = len(typed_data)

                    # ---- 类型自动适配：质检次数 ----
                    if trans_type == 'nodes':
                        quality_check_count = base_quality  # 节点字段多，用用户设定
                    elif trans_type == 'frontend_js':
                        quality_check_count = min(base_quality, 2)  # JS 文本简单，最多 2 轮
                    else:
                        quality_check_count = min(base_quality, 3)  # 分类/菜单适中

                    # ---- 去重 + 跳过已中文 ----
                    raw_data = typed_data
                    typed_data, skip_map, duplicate_map = self._prefilter_translation_data(raw_data, trans_type)
                    skipped_cn = len([v for v in skip_map.values() if self._is_chinese_dominant(str(v.get('title', '')))])
                    skipped_dup = len(skip_map) - skipped_cn

                    if skipped_cn or skipped_dup:
                        skip_parts = []
                        if skipped_cn: skip_parts.append(f"已是中文跳过 {skipped_cn}")
                        if skipped_dup: skip_parts.append(f"去重跳过 {skipped_dup}")
                        print(f"👨‍🏫 班长: {type_name}，原始 {original_count} 条 → {', '.join(skip_parts)} → 实际需翻译 {len(typed_data)} 条")

                    if len(typed_data) == 0:
                        print(f"👨‍🏫 班长: {type_name} 无需翻译，全部跳过！")
                        final_translated.update(raw_data)
                        report_lines.append(f"⏭️ {type_name}: 全部已中文/去重跳过 ({original_count} 条)")
                        continue

                    print(f"\n👨‍🏫 班长: 启动{type_name}，共 {len(typed_data)} 个条目...")

                    # 根据翻译类型构建优化的提示词
                    if system_prompt:
                        system_msg = system_prompt
                    else:
                        system_msg, _ = self._build_translation_prompt(trans_type, {})

                    # 第一轮翻译
                    translated_data = self._smart_translate_routine(
                        data=typed_data,
                        trans_type=trans_type,
                        url=url,
                        headers=headers,
                        model=model,
                        system_prompt=system_msg,
                        local_config=local_config,
                        batch_size=batch_size,
                        desc=type_name
                    )

                    # 回填去重跳过的条目
                    translated_data = self._fill_duplicate_translations(translated_data, skip_map, raw_data, duplicate_map)

                    # 质检和修补循环 — 在完整数据上做
                    total_fixed = 0
                    full_data = raw_data  # 质检要在原始全体数据上做
                    prev_missing_count = None
                    for check_round in range(quality_check_count):
                        missing_data, missing_count = self._scan_for_untranslated(full_data, translated_data, trans_type)
                        if missing_count == 0:
                            print(f"👨‍🏫 班长: 第 {check_round + 1} 轮质检通过，无缺失翻译！")
                            break
                        # 熔断：缺失数较上轮无下降 → 剩余条目多为 AI 无法翻译的代码标识符/品牌词，
                        # 停止修补循环避免空转烧 API（日志中会列出保留原文的条目）
                        if prev_missing_count is not None and missing_count >= prev_missing_count:
                            print(f"👨‍🏫 班长: 第 {check_round + 1} 轮质检无进展（{prev_missing_count}→{missing_count}），剩余条目判定为 AI 保留原文，停止修补。")
                            break
                        prev_missing_count = missing_count
                        print(f"👨‍🏫 班长: 第 {check_round + 1} 轮质检发现 {missing_count} 个缺失条目，开始修补...")
                        patched_data = self._smart_translate_routine(
                            data=missing_data,
                            trans_type=trans_type,
                            url=url,
                            headers=headers,
                            model=model,
                            system_prompt=system_msg,
                            local_config=local_config,
                            batch_size=batch_size,
                            desc=f"修补(第{check_round + 1}轮)"
                    )

                        # 合并修补结果
                        if trans_type == 'nodes':
                            for node_name, patched_node in patched_data.items():
                                if node_name not in translated_data:
                                    translated_data[node_name] = patched_node
                                else:
                                    existing = translated_data[node_name]
                                    if isinstance(existing, dict) and isinstance(patched_node, dict):
                                        for field in ['title', 'description']:
                                            if field in patched_node and patched_node[field]:
                                                existing[field] = patched_node[field]
                                        for field in ['inputs', 'widgets', 'outputs']:
                                            if field in patched_node and isinstance(patched_node[field], dict):
                                                if field not in existing:
                                                    existing[field] = {}
                                                existing[field].update(patched_node[field])
                        else:
                            translated_data.update(patched_data)

                        total_fixed += len(patched_data)
                        print(f"👨‍🏫 班长: 第 {check_round + 1} 轮修补完成，修复了 {len(patched_data)} 个条目")

                    # 本轮类型翻译完成，汇入总结果
                    final_translated.update(translated_data)
                    report_lines.append(f"✅ {type_name}完成: {len(translated_data)} 条")

                # ====== 所有类型翻译完成，保存结果 ======
                # 先做最终质检（用 js_ 键对账，转换前数据结构完整）
                total_missing = 0
                for trans_type, typed_data in task_list:
                    _, missing_count = self._scan_for_untranslated(typed_data, final_translated, trans_type)
                    total_missing += missing_count

                # 转换 js_ 条目为 DD-Translation 可消费格式（英文原文作键），
                # 前端 DOM 文本替换引擎才能用 Menu[原文] 命中译文
                final_translated, js_converted, js_kept = self._convert_js_entries_for_dd_translation(final_translated)
                if js_converted:
                    print(f"👨‍🏫 班长: {js_converted} 条前端文本已转换为 DD-Translation 格式（英文原文作键）")

                overwrite = kwargs.get("💾 覆盖原文件", True)
                if overwrite:
                    output_path = json_path
                else:
                    output_path = json_path.replace('.json', '_translated.json')

                with open(output_path, 'w', encoding='utf-8') as f:
                    json.dump(final_translated, f, ensure_ascii=False, indent=2)

                total_batches = sum(
                    (len(d) + batch_size - 1) // batch_size for _, d in task_list
                )

                report_lines.extend([
                    "✅ 状态: 成功",
                    f"📁 输出文件: {output_path}",
                    f"📝 处理条目数: {len(final_translated)}",
                    f"🔧 修补条目数: {total_fixed}",
                    f"🔍 最终缺失: {total_missing} 个",
                ])
                if js_converted or js_kept:
                    report_lines.append(f"📱 前端文本: {js_converted} 条已转为DD-Translation格式" + (f"，{js_kept} 条保留原键" if js_kept else ""))
                report_lines.extend([
                    "📦 使用方法: 将本JSON复制到 ComfyUI-DD-Translation/zh-CN/Nodes/ 目录（文件名=插件名.json），刷新浏览器生效",
                    f"💾 覆盖原文件: {'是' if overwrite else '否'}",
                    "================================"
                ])

                return ("\n".join(report_lines), json.dumps(final_translated, ensure_ascii=False, indent=2), "")

            except Exception as e:
                error_msg = f"❌ 汉化失败: {str(e)}"
                print(f"👨‍🏫 班长: {error_msg}")
                return (error_msg, "", "")

        report, full_text = "", ""
        if local_config:
            max_tokens = self._parse_max_tokens(kwargs.get("🔢 最大Token (万)"))
            
            temperature_raw = kwargs.get("🌡️ 采样温度", 0.7)
            temperature = float(temperature_raw[0]) if isinstance(temperature_raw, list) else float(temperature_raw)
            
            fps_raw = kwargs.get("🎬 视频帧率", 16)
            fps = int(fps_raw[0]) if isinstance(fps_raw, list) else int(fps_raw)
            
            max_side_raw = kwargs.get("📉 媒体限制(边长)", 512)
            max_side = int(max_side_raw[0]) if isinstance(max_side_raw, list) else int(max_side_raw)

            media_seq = self._refs_to_media(kwargs.get("🗂️ 参考素材"))
            
            # 构建本地模型运行报告
            model_name = local_config.get("model_name", "未知")
            quantization = local_config.get("quantization", "未知")
            
            report_lines = [
                "📊 ========== 运行报告 (本地模型) ==========",
                f"🤖 模型: {model_name}",
                f"⚙️ 量化: {quantization}",
                f"🌡️ 温度: {temperature}",
                f"🔢 最大Token: {max_tokens} ({max_tokens/10000:g}万)",
                f"📐 媒体限制: {max_side}px",
            ]
            
            # 统计输入内容
            img_count = sum(1 for m in media_seq if m["kind"] == "image")
            vid_seq = [m for m in media_seq if m["kind"] == "video"]
            if img_count > 0:
                report_lines.append(f"🖼️ 图像输入: {img_count} 张 " +
                                    " ".join(f"[图片{m['no']}]" for m in media_seq if m["kind"] == "image"))
            if vid_seq:
                total_vid_frames = sum(m["tensor"].shape[0] for m in vid_seq)
                report_lines.append(f"🎥 视频输入: {len(vid_seq)} 段 " +
                                    " ".join(f"[视频{m['no']}]({m['tensor'].shape[0]}帧)" for m in vid_seq))
            if not media_seq:
                report_lines.append("📝 纯文本模式")
            
            if is_json_task: 
                with open(json_path, 'r', encoding='utf-8') as f: 
                    json_content = f.read()
                    user_prompt += f"\n\nJSON Data:\n{json_content}"
                    report_lines.append(f"📂 JSON数据: {len(json_content)} 字符")
            
            status_msg, full_text = self._run_local_inference(local_config, system_prompt, user_prompt, media_seq, fps, max_tokens, temperature, max_side)
            
            # 添加运行结果到报告
            if status_msg.startswith("✅"):
                report_lines.extend([
                    "✅ 状态: 成功",
                    f"📄 输出长度: {len(full_text)} 字符",
                    "================================"
                ])
            else:
                report_lines.extend([
                    "❌ 状态: 失败",
                    f"⚠️ 错误: {status_msg}",
                    "================================"
                ])
            
            report = "\n".join(report_lines)
        else:
            report, full_text, api_thinking = self._v9_api_logic(**kwargs)
            clean_inline, _ = self._split_thinking(full_text)
            return (report, clean_inline, api_thinking)

        clean, thinking = self._split_thinking(full_text)
        return (report, clean, thinking)
            
    def _v9_api_logic(self, **kwargs):
        url, headers, model, provider_key, base_url_for_list = self._get_api_config(kwargs)
        
        if model.lower() in ["list", "help"]:
            # 从 headers 中提取 api_key 用于查询模型列表
            api_key = headers.get("Authorization", "").replace("Bearer ", "")
            models_info = self._fetch_available_models(api_key, base_url_for_list)
            return (f"✅ 模型列表获取成功\n{models_info}", models_info, "")

        system_prompt = self._flatten_to_string(kwargs.get("🧠 系统指令 (指令)", ""))
        user_prompt = self._flatten_to_string(kwargs.get("🗣️ 用户提示 (正文)", ""))
        messages = [{"role": "user", "content": user_prompt}]
        if system_prompt: messages.insert(0, {"role": "system", "content": system_prompt})
        
        content_parts = []
        has_media = False
        media_seq = self._refs_to_media(kwargs.get("🗂️ 参考素材"))

        for item in media_seq:
            no = item["no"]
            try:
                if item["kind"] == "image":
                    has_media = True
                    img_tensor = item["tensor"][0]
                    i_np = 255. * img_tensor.cpu().numpy()
                    img = Image.fromarray(np.clip(i_np, 0, 255).astype(np.uint8))
                    buffered = io.BytesIO()
                    img.save(buffered, format="JPEG")
                    img_b64 = base64.b64encode(buffered.getvalue()).decode("utf-8")
                    content_parts.append({"type": "text", "text": f"[图片{no}]"})
                    content_parts.append({
                        "type": "image_url", 
                        "image_url": {
                            "url": f"data:image/jpeg;base64,{img_b64}",
                            "detail": "auto"
                        }
                    })
                elif item["kind"] == "audio":
                    has_media = True
                    audio_b64 = self._audio_to_wav_b64(
                        path=item.get("path"), start=item.get("start"), end=item.get("end"),
                        waveform=item.get("waveform"), sample_rate=item.get("sample_rate"))
                    content_parts.append({"type": "text", "text": f"[音频{no}]"})
                    content_parts.append({
                        "type": "input_audio",
                        "input_audio": {"data": audio_b64, "format": "wav"}
                    })
                    print(f"👨‍🏫 班长: API模式 音频{no} 已转 16kHz 单声道 WAV 直传")
                else:
                    has_media = True
                    total_frames = item["tensor"].shape[0]
                    indices = np.linspace(0, total_frames - 1, min(total_frames, 8), dtype=int)
                    content_parts.append({"type": "text", "text": f"[视频{no}]（以下{len(indices)}帧按时间顺序）"})
                    for idx in indices:
                        img_tensor = item["tensor"][idx]
                        i_np = 255. * img_tensor.cpu().numpy()
                        img = Image.fromarray(np.clip(i_np, 0, 255).astype(np.uint8))
                        buffered = io.BytesIO()
                        img.save(buffered, format="JPEG")
                        img_b64 = base64.b64encode(buffered.getvalue()).decode("utf-8")
                        content_parts.append({
                            "type": "image_url", 
                            "image_url": {
                                "url": f"data:image/jpeg;base64,{img_b64}",
                                "detail": "auto"
                            }
                        })
                    print(f"👨‍🏫 班长: API模式 视频{no} 已抽取 {len(indices)} 帧发送")
            except Exception as e: print(f"素材处理错误 [编号{no}]: {e}")

        # V66 Fix: 智能注入视觉触发词 <image>，解决部分本地模型“装瞎”的问题
        has_visual = any(m["kind"] in ("image", "video") for m in media_seq)
        if has_media and not user_prompt:
            tip = "请详细描述这张图片。" if has_visual else "请听这些音频并分析其内容、情绪与音乐风格。"
            print(f"👨‍🏫 班长: 检测到素材输入但无文本，自动追加触发词。")
            content_parts.append({"type": "text", "text": f"<image>\n{tip}" if has_visual else tip})
        elif user_prompt:
             # 如果用户写了提示词，我们悄悄在前面加上 <image> 标签，帮本地模型定位（仅视觉素材时）
             if has_visual and "<image>" not in user_prompt.lower() and "[图片]" not in user_prompt:
                 content_parts.append({"type": "text", "text": f"<image>\n{user_prompt}"})
                 print("👨‍🏫 班长: 已为您自动在提示词前添加 '<image>' 标签")
             else:
                 content_parts.append({"type": "text", "text": user_prompt})
        
        if has_media: messages[-1]["content"] = content_parts
        
        print(f"👨‍🏫 [API Payload] Messages: {len(messages)} | Content Parts: {len(content_parts) if has_media else 1}")

        max_tokens = self._parse_max_tokens(kwargs.get("🔢 最大Token (万)"))
        
        temperature_raw = kwargs.get("🌡️ 采样温度", 0.7)
        temperature = float(temperature_raw[0]) if isinstance(temperature_raw, list) else float(temperature_raw)

        # 构建详细运行报告
        report_lines = [
            "📊 ========== 运行报告 ==========",
            f"🌐 API 服务商: {provider_key}",
            f"🤖 模型: {model}",
            f"🌡️ 温度: {temperature}",
            f"🔢 最大Token: {max_tokens} ({max_tokens/10000:g}万)",
            f"💬 消息数量: {len(messages)}",
        ]
        
        # 统计输入内容
        img_count = sum(1 for m in media_seq if m["kind"] == "image")
        vid_seq = [m for m in media_seq if m["kind"] == "video"]
        if img_count > 0:
            report_lines.append(f"🖼️ 图像输入: {img_count} 张 " +
                                " ".join(f"[图片{m['no']}]" for m in media_seq if m["kind"] == "image"))
        if vid_seq:
            total_vid_frames = sum(m["tensor"].shape[0] for m in vid_seq)
            report_lines.append(f"🎥 视频输入: {len(vid_seq)} 段 " +
                                " ".join(f"[视频{m['no']}]({m['tensor'].shape[0]}帧)" for m in vid_seq))
        aud_seq = [m for m in media_seq if m["kind"] == "audio"]
        if aud_seq:
            report_lines.append(f"🎵 音频输入: {len(aud_seq)} 段 (input_audio 直传) " +
                                " ".join(f"[音频{m['no']}]{m.get('name', '')}" for m in aud_seq))
        if not media_seq:
            report_lines.append("📝 纯文本模式")
        
        payload = {"model": model, "messages": messages, "temperature": temperature, "max_tokens": max_tokens, "top_p": 1.0}
        try:
            # 同本地两条路径：终端不逐块写（一次 write = 前端一行），正文整段
            # 输出一次。云端 chunk 比本地还碎，逐块写刷得更凶。
            print("📝 生成内容: 生成中……", flush=True)
            _chunks = [0]
            def _on_chunk(text):
                _chunks[0] += 1
                if _chunks[0] % 200 == 0:
                    print(f"…已收到 {_chunks[0]} 段", flush=True)

            res = self._call_api(url, headers, payload, timeout=6000, on_chunk=_on_chunk)
            if res is None:
                report_lines.extend(["🛑 状态: 已取消", "================================"])
                return ("\n".join(report_lines), "", "")
            if 'choices' in res:
                content, thinking = self._extract_message(res['choices'][0].get('message', {}))
                finish_reason = res['choices'][0].get('finish_reason', '未知')
                usage = res.get('usage') or {}
                prompt_tokens = usage.get('prompt_tokens', '未知')
                completion_tokens = usage.get('completion_tokens', '未知')
                total_tokens = usage.get('total_tokens', '未知')
                
                report_lines.extend([
                    "✅ 状态: 成功",
                    f"📥 输入Token: {prompt_tokens}",
                    f"📤 输出Token: {completion_tokens}",
                    f"📊 总Token: {total_tokens}",
                    f"🏁 结束原因: {finish_reason}",
                    f"📄 输出长度: {len(content)} 字符",
                    f"🧠 思考长度: {len(thinking)} 字符",
                ])
                if finish_reason == "length":
                    report_lines.append(
                        "⚠️ 输出被截断：触达 🔢 最大Token 上限 (finish_reason=length)，"
                        "请调大「🔢 最大Token (万)」后重新运行")
                report_lines.append("================================")
                print(f"📝 生成内容（{len(content)} 字）:")
                if content:
                    print(content)
                print("")
                return ("\n".join(report_lines), content, thinking)
            else:
                report_lines.extend([
                    "❌ 状态: 失败",
                    f"⚠️ 错误: API 返回格式未知",
                    f"📄 响应: {str(res)[:200]}",
                    "================================"
                ])
                return ("\n".join(report_lines), "", "")
        except Exception as e:
            # 构建详尽的错误报告
            report_lines.extend([
                "❌ 状态: 失败",
                f"⚠️ 错误: {str(e)}",
            ])
            
            # 提供商特定诊断提示
            if provider_key == "NVIDIA":
                report_lines.extend([
                    "🔍 NVIDIA NIM 诊断:",
                    "   1. API Key 必须以 'nvapi-' 开头",
                    "   2. 模型名格式: nvidia/llama-3.1-nemotron-70b-instruct",
                    "   3. 前往 https://build.nvidia.com 获取 Key 和可用模型",
                ])
            elif provider_key == "Custom":
                report_lines.append(f"🔍 使用的自定义地址: {url}")
            
            report_lines.append("================================")
            
            if "model" in str(e).lower():
                api_key_for_list = headers.get("Authorization", "").replace("Bearer ", "")
                models_info = self._fetch_available_models(api_key_for_list, base_url_for_list)
                report_lines.append(f"\n💡 可用模型列表:\n{models_info}")
            return ("\n".join(report_lines), "", "")