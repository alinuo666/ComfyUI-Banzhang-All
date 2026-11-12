# -*- coding: utf-8 -*-
import os
import json
import torch
import gc
import numpy as np
from PIL import Image
from enum import Enum
from pathlib import Path
import folder_paths # ComfyUI 路径工具

# 尝试导入下载工具
try:
    from huggingface_hub import snapshot_download as hf_snapshot_download
except ImportError:
    hf_snapshot_download = None

try:
    from modelscope.hub.snapshot_download import snapshot_download as ms_snapshot_download
    MODELSCOPE_AVAILABLE = True
except ImportError:
    MODELSCOPE_AVAILABLE = False

try:
    from transformers import StoppingCriteria
except ImportError:
    class StoppingCriteria: pass

# ================= 🛠️ 全局缓存与工具 =================

MODEL_CACHE = {}
PROCESSOR_CACHE = {}
TOKENIZER_CACHE = {}

def interrupted():
    """ComfyUI 官方中断标志（前端“停止”按钮唯一置位源）"""
    try:
        import comfy.model_management as mm
        return mm.processing_interrupted()
    except Exception:
        return False

def _safe_close(obj):
    """只关 llama.cpp 的对象：HF/torch 模型没有需要显式释放的 C 层句柄，
    误调第三方同名 close() 反而可能关掉后面还要复用的东西。"""
    if obj is None or not hasattr(obj, "close"):
        return
    if not obj.__class__.__module__.startswith("llama_cpp"):
        return
    try:
        obj.close()
    except Exception as e:
        print(f"👨‍🏫 班长: 关闭本地模型时忽略异常: {e}")


def release_model(cache_key):
    """真正释放一个已缓存的本地模型（HF 与 GGUF 共用）。
    只 pop 字典等于没卸：调用方的局部变量仍持有对象，empty_cache 拿不回任何显存。
    GGUF 的权重/KV 是 C 层内存，torch 管不到，必须 close()；视觉投影 clip_model
    是另一个独立 Llama 实例，关主模型不会连带关它。"""
    model = MODEL_CACHE.pop(cache_key, None)
    PROCESSOR_CACHE.pop(cache_key, None)
    TOKENIZER_CACHE.pop(cache_key, None)
    handler = getattr(model, "chat_handler", None)
    # handler 自带 close 时由它负责连带关视觉塔，不要再单独关 clip_model，
    # 否则同一个句柄被关两次（llama.cpp 侧是裸指针，重复释放会崩进程）。
    if handler is not None and hasattr(handler, "close"):
        _safe_close(handler)
    else:
        _safe_close(getattr(handler, "clip_model", None))
    _safe_close(model)
    return model


def clear_global_cache():
    """清空全部本地模型缓存。用 release_model 逐个关，不能直接 clear()，
    否则 GGUF 的 C 层内存与视觉塔显存会一直留在进程里。"""
    for key in list(MODEL_CACHE.keys()):
        release_model(key)
    PROCESSOR_CACHE.clear()
    TOKENIZER_CACHE.clear()
    gc.collect()
    if torch.cuda.is_available():
        torch.cuda.empty_cache()

def get_vram_info():
    """获取当前显存使用情况"""
    if torch.cuda.is_available():
        allocated = torch.cuda.memory_allocated() / 1024**3
        reserved = torch.cuda.memory_reserved() / 1024**3
        return f"{allocated:.2f}GB (已用) / {reserved:.2f}GB (预留)"
    return "N/A"

def get_gpu_used():
    """整卡已用显存（含 llama.cpp 这类非 torch 分配）。
    torch.memory_allocated 只看得到 torch 自己的池子，GGUF 卸载前后永远是同一个数，
    验证'到底卸没卸掉'必须用这个整卡口径。"""
    try:
        free, total = torch.cuda.mem_get_info()
        return f"{(total - free) / 1024**3:.2f}GB"
    except Exception:
        return "N/A"

# ================= 🧬 基础类定义 =================

class AnyType(str):
    def __ne__(self, __value: object) -> bool: return False

class AnyObject(str):
    def __new__(cls, text=""):
        return super().__new__(cls, text)

    def __init__(self, text=""): 
        self.shape = (1, 512, 512, 3)
        self.device = "cpu"
        self.dtype = torch.float32

    def __getattr__(self, name): return self
    def __getitem__(self, key): return self
    def __call__(self, *args, **kwargs): return self
    def __eq__(self, other): return True
    def __ne__(self, other): return False
    
    def dim(self): return 4
    def size(self, *args): return self.shape
    def to(self, *args, **kwargs): return self
    def cpu(self): return self
    def cuda(self): return self

class StreamStoppingCriteria(StoppingCriteria):
    def __call__(self, input_ids: torch.LongTensor, scores: torch.FloatTensor, **kwargs) -> bool:
        return interrupted()

# ================= 📦 GGUF 模型支持 =================

class ModelType(str, Enum):
    HF = "Transformers (HF)"
    GGUF = "GGUF (llama.cpp)"
    @classmethod
    def get_values(cls): return [item.value for item in cls]

# GGUF 模型配置
GGUF_MODEL_CONFIGS = {
    "Qwen3-VL-2B-Instruct-GGUF": {"default": True, "description": "Qwen3-VL-2B-Instruct 量化版本"},
    "Qwen3-VL-4B-Instruct-GGUF": {"default": False, "description": "Qwen3-VL-4B-Instruct 量化版本"},
    "Qwen3-VL-8B-Instruct-GGUF": {"default": False, "description": "Qwen3-VL-8B-Instruct 量化版本"},
    "Qwen2.5-VL-3B-Instruct-GGUF": {"default": False, "description": "Qwen2.5-VL-3B-Instruct 量化版本"},
    # Qwen3.5 模型
    "Qwen3.5-27B-GGUF": {"default": False, "description": "Qwen3.5-27B 量化版本"},
    "Qwen3.5-35B-A3B-GGUF": {"default": False, "description": "Qwen3.5-35B-A3B 量化版本"},
    "Qwen3.5-122B-A10B-GGUF": {"default": False, "description": "Qwen3.5-122B-A10B 量化版本"},
    "Qwen3.5-397B-A17B-GGUF": {"default": False, "description": "Qwen3.5-397B-A17B 量化版本"}
}

# 获取 GGUF 模型目录
def get_gguf_models_dir():
    """获取 GGUF 模型存储目录"""
    base_models_dir = None
    try:
        if hasattr(folder_paths, "models_dir"):
            base_models_dir = Path(folder_paths.models_dir)
    except: pass
        
    if base_models_dir is None or not base_models_dir.exists():
        try:
            # __file__ = .../ComfyUI/custom_nodes/<本包>/banzhang_translator/banzhang_utils.py
            # 要 4 层才到 ComfyUI 根。少一层会落到 custom_nodes，下面 mkdir 又会
            # 把 custom_nodes/models/llm/GGUF 真的建出来 —— 表现就是「模型明明放了却扫不到」。
            comfy_root = Path(__file__).parent.parent.parent.parent
            base_models_dir = comfy_root / "models"
        except: pass
    
    if base_models_dir:
        gguf_dir = base_models_dir / "llm" / "GGUF"
    else:
        gguf_dir = Path(__file__).parent / "models" / "llm" / "GGUF"
        
    gguf_dir.mkdir(parents=True, exist_ok=True)
    return gguf_dir

# 列出 GGUF 扫描根目录（只认主根）
def _get_gguf_scan_roots():
    """返回 GGUF 扫描根目录列表，主根永远排第一。

    1. `<models_dir>/llm/GGUF` —— 普通用户唯一会用的位置。
    2. `extra_model_paths.yaml` 里用户自己写了的 `llm:` 目录 —— 官方客户端/多盘
       用户会把模型挂在映射目录，不读它们等于模型不存在（下拉空 → 节点报
       「缺少必需的输入」，用户根本没法用）。

    不无脑扫全盘：只认主根 + 用户**显式声明**过的 llm 路径。标签仍是「相对各自
    扫描根」的短路径，重名按主根优先，避免当年选错模型的乱象。
    """
    roots = []
    try:
        roots.append(get_gguf_models_dir())
    except Exception:
        pass

    try:
        llm_paths = list(folder_paths.folder_names_and_paths.get("llm", ([], set()))[0])
    except Exception:
        llm_paths = []

    for raw in llm_paths:
        try:
            base = Path(raw)
        except Exception:
            continue
        # 用户的 llm 目录两种摆法都认：直接放 *.gguf，或再建一层 GGUF 子目录
        for cand in (base / "GGUF", base):
            try:
                if not cand.is_dir():
                    continue
                resolved = cand.resolve()
            except Exception:
                continue
            if any(resolved == r.resolve() for r in roots):
                # 主根已经就是它：必须 break 而不是 continue，
                # 否则会退回父目录 models/llm 再扫一遍，标签变成 GGUF/ 开头的长路径。
                break
            roots.append(cand)
            break
    return roots


def scan_gguf_entries():
    """递归扫描所有 GGUF 扫描根，返回 {标签: {"model": 绝对路径, "mmproj": 绝对路径或None, "root": 根}}。
    - 标签：模型文件相对扫描根的 POSIX 路径（去扩展名），支持子目录
    - 视觉投影 mmproj*.gguf：按 同目录→逐级父目录（到扫描根为止）配对；
      纯文本模型允许无 mmproj（mmproj=None，仅可用于纯文本任务）
    - 主根优先：不同根出现相同标签时先扫到的生效"""
    entries = {}
    for root in _get_gguf_scan_roots():
        try:
            if not root.exists(): continue
        except: continue
        # 主根同时兼容老式 .bin；其他根只收 .gguf（避免误扫 HF 的 pytorch_model.bin）
        files = list(root.rglob("*.gguf"))
        try:
            if str(root.resolve()) == str(get_gguf_models_dir().resolve()):
                files += list(root.rglob("*.bin"))
        except: pass
        files = sorted(set(files), key=lambda p: str(p).lower())
        mmprojs = [p for p in files if "mmproj" in p.name.lower()]
        for model_file in files:
            lname = model_file.name.lower()
            if lname.endswith(".gguf") and "mmproj" in lname:
                continue
            label = model_file.relative_to(root).with_suffix("").as_posix()
            if label in entries:
                continue  # 主根优先
            # 配对 mmproj：同目录 → 逐级父目录（到扫描根为止）
            mmproj_path = None
            directory = model_file.parent
            while True:
                for mm in mmprojs:
                    if mm.parent == directory:
                        mmproj_path = mm; break
                if mmproj_path is not None or directory == root:
                    break
                directory = directory.parent
            entries[label] = {"model": str(model_file),
                              "mmproj": (str(mmproj_path) if mmproj_path else None),
                              "root": str(root)}
            if mmproj_path is None:
                print(f"👨‍🏫 班长: {label} 未配对 mmproj*.gguf，仅可用于纯文本任务")
    return entries


# 列出 GGUF 模型标签（供配置节点下拉）
def list_gguf_models():
    """列出可用的 GGUF 模型标签（相对扫描根的 POSIX 路径）。"""
    try:
        return list(scan_gguf_entries().keys())
    except:
        return []


def resolve_gguf_model(label):
    """标签 -> (模型绝对路径, mmproj绝对路径或None)。找不到时抛 ValueError。"""
    entries = scan_gguf_entries()
    entry = entries.get(label)
    if entry is None:
        raise ValueError(
            f"GGUF 模型 '{label}' 不存在（可用: {', '.join(entries) if entries else '无'}）"
        )
    return entry["model"], entry["mmproj"]

# ================= 📦 模型数据配置 =================

class Quantization(str, Enum):
    Q4_BIT = "4-bit (节省显存)"
    Q8_BIT = "8-bit (平衡)"
    NONE = "None (FP16)"
    @classmethod
    def get_values(cls): return [item.value for item in cls]

DEFAULT_MODEL_CONFIGS = {
    # 内置 HF 模型清单已按用户要求清空（节点「🤖 模型选择 (HF)」不再显示这些条目）。
    # 如需重新使用 HF 模型，在本目录 config.json 中添加（会自动合并到 MODEL_CONFIGS）；
    # 完整原始清单见同目录 banzhang_utils.py.bak_hflist。
}

MODEL_CONFIGS = DEFAULT_MODEL_CONFIGS.copy()
# 加载外部配置
BASE_DIR = Path(__file__).parent
CONFIG_FILE = BASE_DIR / "config.json"
try:
    if CONFIG_FILE.exists():
        with open(CONFIG_FILE, 'r', encoding='utf-8') as f:
            external_configs = json.load(f)
            models_only = {k: v for k, v in external_configs.items() if not k.startswith('_')}
            MODEL_CONFIGS.update(models_only)
except: pass

# ================= 📝 外部提示词配置 =================

DEFAULT_PROMPTS = {
    "汉化节点 - 指令": """你负责ComfyUI插件汉化。
核心规则：
1. 绝对不要修改Key。
2. 必须翻译Value：即使Value是英文缩写(如"cfg_scale")，也要意译为中文(如"引导系数")。
3. 即使Key=Value也要翻译Value。
4. 保留Emoji。
5. 只输出纯JSON。
6. 【关键】翻译 Title 时，必须智能保留插件特征（前缀/后缀/括号标识）：
   - 🚫 严禁翻译括号内的插件简称：'Remove Background (RMBG)' -> '移除背景 (RMBG)'。
   - 🚫 严禁翻译作者专属前缀：'CR Select Model' -> 'CR 选择模型'。""",
    "提示词风格 - 标签": "你的任务是为文生图AI生成一个简洁的逗号分隔标签列表，仅基于图像中的视觉信息。限制输出最多50个唯一标签。严格描述视觉元素，如主体、服装、环境、颜色、光照和构图。不要包含抽象概念、解释、营销术语或技术术语。目标是一个简洁的视觉描述符列表。避免重复标签。",
    "提示词风格 - 简单": "分析图像并生成一个简单的单句文生图提示词。简洁地描述主要主体和场景。",
    "提示词风格 - 详细": "基于图像生成一个详细的艺术性文生图提示词。将主体、动作、环境、光照和整体氛围组合成一个连贯的段落，约2-3句话。关注关键视觉细节。",
    "提示词风格 - 极致详细": "从图像生成一个极其详细和描述性的文生图提示词。创建一个丰富的段落，详细阐述主体的外观、服装纹理、具体背景元素、光线的质量和颜色、阴影以及整体氛围。追求高度描述性和沉浸式的提示词。",
    "提示词风格 - 电影感": "作为一个大师级提示词工程师。为图像生成AI创建一个高度详细和富有感染力的提示词。描述主体、姿势、环境、光照、情绪和艺术风格（如照片写实、电影感、绘画风格）。将所有元素编织成一个自然语言段落，专注于视觉冲击力。"
}

PROMPTS_FILE = BASE_DIR / "prompts.json"
PROMPTS_DIR = BASE_DIR / "prompts"

# 自动创建模板
try:
    if not PROMPTS_FILE.exists():
        with open(PROMPTS_FILE, 'w', encoding='utf-8') as f:
            json.dump(DEFAULT_PROMPTS, f, indent=4, ensure_ascii=False)
    
    if not PROMPTS_DIR.exists():
        PROMPTS_DIR.mkdir(parents=True, exist_ok=True)
        example_path = PROMPTS_DIR / "示例_小红书风格.json"
        with open(example_path, 'w', encoding='utf-8') as f:
            json.dump({"小红书文案风格": "请以小红书博主的语气描述这张图片，多使用emoji，语气活泼，包含痛点和种草建议。"}, f, indent=4, ensure_ascii=False)
        example_md_path = PROMPTS_DIR / "示例_代码解释器.md"
        with open(example_md_path, 'w', encoding='utf-8') as f:
            f.write("你是一个资深的代码解释器。\n请详细分析代码逻辑，并用通俗易懂的语言解释每一步的作用。\n如果发现潜在的 Bug，请指出并提供修复建议。")
except: pass

# ================= 🖼️ 图像处理与下载工具 =================

class ImageProcessor:
    _cache = {}
    def to_pil(self, image_tensor: torch.Tensor, max_side: int = 0) -> Image.Image:
        """转换并可选缩放图像"""
        if image_tensor.dim() == 4: image_tensor = image_tensor[0]
        image_np = (image_tensor.cpu().numpy() * 255).astype(np.uint8)
        pil_image = Image.fromarray(image_np)
        
        if max_side > 0:
            w, h = pil_image.size
            if max(w, h) > max_side:
                ratio = max_side / max(w, h)
                # 极端宽高比或 max_side 过小会把短边截成 0，resize 要求宽高 ≥1
                new_w = max(1, int(w * ratio))
                new_h = max(1, int(h * ratio))
                pil_image = pil_image.resize((new_w, new_h), Image.LANCZOS)
        
        return pil_image

class ModelDownloader:
    def __init__(self):
        base_models_dir = None
        try:
            if hasattr(folder_paths, "models_dir"):
                base_models_dir = Path(folder_paths.models_dir)
        except: pass
            
        if base_models_dir is None or not base_models_dir.exists():
            try:
                comfy_root = Path(__file__).parent.parent.parent
                base_models_dir = comfy_root / "models"
            except: pass
        
        if base_models_dir:
            self.models_dir = base_models_dir / "prompt_generator"
        else:
            self.models_dir = Path(__file__).parent / "models" / "prompt_generator"
            
        self.models_dir.mkdir(parents=True, exist_ok=True)
        print(f"👨‍🏫 班长：本地模型存储路径已锁定 -> {self.models_dir.absolute()}")

    def ensure_model_available(self, model_name):
        model_info = DEFAULT_MODEL_CONFIGS.get(model_name)
        if not model_info: 
             # 尝试从热更配置中查找
             model_info = MODEL_CONFIGS.get(model_name)
        
        if not model_info: raise ValueError(f"未知模型: {model_name}")
        
        repo_id = model_info['repo_id']
        source = model_info.get('source', 'huggingface')
        model_folder_name = repo_id.split('/')[-1]
        model_path = self.models_dir / model_folder_name
        
        if model_path.exists() and (model_path / "config.json").exists():
            return str(model_path)
            
        print(f"📥 正在从 {source} 下载模型 '{model_name}'...")
        print(f"📂 目标路径: {model_path}")
        
        if source == 'modelscope':
            if not MODELSCOPE_AVAILABLE: raise RuntimeError("请先安装 modelscope: pip install modelscope")
            ms_snapshot_download(model_id=repo_id, cache_dir=str(model_path.parent), local_dir=str(model_path))
        else:
            if hf_snapshot_download is None: raise RuntimeError("未安装 huggingface_hub")
            hf_snapshot_download(repo_id=repo_id, local_dir=str(model_path), resume_download=True)
            
        return str(model_path)