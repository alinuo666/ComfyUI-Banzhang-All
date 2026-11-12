# -*- coding: utf-8 -*-
"""
👨‍🏫 班长字幕处理模块
包含：视频字幕添加器、智能语音转脚本
"""

import torch
import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageFilter
import os
import sys
import re
import folder_paths
import difflib
import comfy.model_management as mm

# 依赖检测
QWEN_AVAILABLE = False
QWEN_IMPORT_ERROR = None
try:
    from qwen_asr import Qwen3ASRModel
    QWEN_AVAILABLE = True
except ImportError as e:
    QWEN_IMPORT_ERROR = str(e)

# ==============================================================================
# 内部工具函数
# ==============================================================================
def strip_punctuation(text):
    """去除文本中的所有标点符号，仅保留文字/数字/空格"""
    pattern = r'[^\w\s\u4e00-\u9fa5]'
    return " ".join(re.sub(pattern, '', text).split())

def clean_for_match(text):
    """用于匹配的极简清洗（无空格无标点全小写）"""
    return re.sub(r'[^\w\u4e00-\u9fa5]', '', text).lower()

def get_font_files():
    """扫描当前节点目录下的 Fonts 文件夹"""
    current_dir = os.path.dirname(__file__)
    fonts_dir = os.path.join(current_dir, "Fonts")
    if not os.path.exists(fonts_dir):
        os.makedirs(fonts_dir, exist_ok=True)
        return ["请在Fonts文件夹放入字体"]
    files = [f for f in os.listdir(fonts_dir) if f.lower().endswith(('.ttf', '.otf'))]
    return sorted(files) if files else ["未找到字体文件"]

def semantic_split(text, max_len=12):
    """语义感知的智能切分：避免在虚词处断开"""
    if len(text) <= max_len:
        return [text]

    parts = re.split(r'([，, \s])', text)
    chunks = []
    current_chunk = ""
    bad_endings = set("的和被在与其于了呢吧吗啊")

    for p in parts:
        if not p:
            continue
        if len(current_chunk) + len(p) <= max_len:
            current_chunk += p
        else:
            if current_chunk and current_chunk[-1] in bad_endings and len(current_chunk) > 4:
                chunks.append(current_chunk[:-1])
                current_chunk = current_chunk[-1] + p
            else:
                if current_chunk:
                    chunks.append(current_chunk)
                current_chunk = p

    if current_chunk:
        chunks.append(current_chunk)

    final_chunks = []
    for c in chunks:
        c = c.strip("，, ")
        if len(c) > max_len + 4:
            split_idx = len(c) // 2
            final_chunks.append(c[:split_idx])
            final_chunks.append(c[split_idx:])
        elif c:
            final_chunks.append(c)
    return final_chunks

def smart_alignment_engine(user_sentences, asr_stamps, fps):
    """智能对齐核心 V3：基于覆盖范围的精准映射"""
    asr_chars = ""
    asr_time_map = []

    for ts in asr_stamps:
        text = getattr(ts, 'text', '') or ts.get('text', '')
        start = getattr(ts, 'start_time', 0.0) or ts.get('start_time', 0.0)
        end = getattr(ts, 'end_time', 0.0) or ts.get('end_time', 0.0)
        if not text:
            continue
        char_dur = (end - start) / len(text)
        for i, char in enumerate(text):
            asr_chars += char
            asr_time_map.append((start + i * char_dur, start + (i + 1) * char_dur))

    clean_asr = clean_for_match(asr_chars)
    clean_to_raw_idx = [i for i, char in enumerate(asr_chars) if clean_for_match(char)]

    final_lines = []
    current_search_pos = 0

    for sentence in user_sentences:
        clean_sent = clean_for_match(sentence)
        if not clean_sent:
            continue

        matcher = difflib.SequenceMatcher(None, clean_sent, clean_asr[current_search_pos:])
        blocks = matcher.get_matching_blocks()
        matched_asr_indices = [b.b for b in blocks if b.size > 0]

        if matched_asr_indices:
            first_idx = current_search_pos + min(matched_asr_indices)
            last_idx = current_search_pos + max([b.b + b.size - 1 for b in blocks if b.size > 0])
            raw_start_idx = clean_to_raw_idx[min(first_idx, len(clean_to_raw_idx)-1)]
            raw_end_idx = clean_to_raw_idx[min(last_idx, len(clean_to_raw_idx)-1)]
            start_t = asr_time_map[raw_start_idx][0]
            end_t = asr_time_map[raw_end_idx][1]
            current_search_pos = last_idx + 1
        else:
            prev_end_f = float(final_lines[-1].split('-')[1].split(':')[0]) if final_lines else 0.0
            start_t = (prev_end_f / fps) + 0.1
            end_t = start_t + (len(clean_sent) * 0.2)

        start_f = int(start_t * fps)
        end_f = int(end_t * fps)

        if final_lines:
            last_e = int(final_lines[-1].split('-')[1].split(':')[0])
            if start_f <= last_e:
                start_f = last_e + 1

        if end_f <= start_f:
            end_f = start_f + 2

        final_lines.append(f"{start_f}-{end_f}: {strip_punctuation(sentence)}")

    return final_lines


# ==============================================================================
# 节点 1: 视频字幕添加器 (SimpleVideoSubtitleNode)
# ==============================================================================
class SimpleVideoSubtitleNode:
    @classmethod
    def INPUT_TYPES(s):
        font_list = get_font_files()
        return {
            "required": {
                "🎞️ 视频/图像输入": ("IMAGE",),
                "📝 字幕脚本": ("STRING", {"multiline": True, "default": "", "forceInput": True}),
                "🅰️ 字体选择": (font_list, ),
                "📏 字体大小": ("INT", {"default": 40, "min": 10, "max": 200}),
                "🏁 底部边距": ("INT", {"default": 20, "min": 0, "max": 500}),
                "🔴 文本红色 (R)": ("INT", {"default": 255, "min": 0, "max": 255}),
                "🟢 文本绿色 (G)": ("INT", {"default": 255, "min": 0, "max": 255}),
                "🔵 文本蓝色 (B)": ("INT", {"default": 255, "min": 0, "max": 255}),
                "🖌️ 描边: 宽度": ("INT", {"default": 2, "min": 0, "max": 20}),
                "🌑 阴影: X偏移": ("INT", {"default": 1}),
                "🌑 阴影: Y偏移": ("INT", {"default": -1}),
                "🌑 阴影: 不透明度": ("FLOAT", {"default": 0.5, "min": 0.0, "max": 1.0, "step": 0.01}),
                "🌑 阴影: 模糊度": ("FLOAT", {"default": 0.3, "min": 0.0, "max": 1.0, "step": 0.01}),
            },
        }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("🖼️ 带字幕视频",)
    FUNCTION = "execute_logic"
    CATEGORY = "👨‍🏫班长/视频处理"

    def execute_logic(self, **kwargs):
        images_tensor = kwargs.get("🎞️ 视频/图像输入")
        script_text = kwargs.get("📝 字幕脚本", "")
        font_filename = kwargs.get("🅰️ 字体选择", "")
        font_size = kwargs.get("📏 字体大小", 40)
        bottom_margin = kwargs.get("🏁 底部边距", 20)
        text_color = (kwargs.get("🔴 文本红色 (R)"), kwargs.get("🟢 文本绿色 (G)"), kwargs.get("🔵 文本蓝色 (B)"))
        stroke_width = kwargs.get("🖌️ 描边: 宽度")
        shadow_offset_x, shadow_offset_y = kwargs.get("🌑 阴影: X偏移"), kwargs.get("🌑 阴影: Y偏移")
        opacity, blur = kwargs.get("🌑 阴影: 不透明度"), kwargs.get("🌑 阴影: 模糊度")

        shadow_alpha = int(opacity * 255)
        shadow_blur_radius = blur * 20.0
        subtitle_map = self.parse_subtitle_script(script_text)

        font_path = os.path.join(os.path.dirname(__file__), "Fonts", font_filename)
        try:
            font = ImageFont.truetype(font_path, font_size)
        except:
            font = ImageFont.load_default()

        batch_np = (images_tensor.cpu().numpy() * 255).astype(np.uint8)
        output_images = []

        for frame_idx, img_np in enumerate(batch_np):
            pil_image = Image.fromarray(img_np).convert("RGBA")
            if frame_idx in subtitle_map:
                text_content = subtitle_map[frame_idx]
                image_width, image_height = pil_image.size
                draw_temp = ImageDraw.Draw(pil_image)
                try:
                    left, top, right, bottom = draw_temp.textbbox((0, 0), text_content, font=font, stroke_width=stroke_width)
                    text_width, text_height = right - left, bottom - top
                except:
                    text_width, text_height = draw_temp.textsize(text_content, font=font)

                base_x, base_y = (image_width - text_width) / 2, image_height - text_height - bottom_margin

                if shadow_alpha > 0:
                    shadow_layer = Image.new('RGBA', pil_image.size, (0, 0, 0, 0))
                    ImageDraw.Draw(shadow_layer).text((base_x + shadow_offset_x, base_y - shadow_offset_y),
                                    text_content, font=font, fill=(0,0,0,shadow_alpha),
                                    stroke_width=stroke_width, stroke_fill=(0,0,0,shadow_alpha))
                    if shadow_blur_radius > 0:
                        shadow_layer = shadow_layer.filter(ImageFilter.GaussianBlur(radius=shadow_blur_radius))
                    pil_image = Image.alpha_composite(pil_image, shadow_layer)

                ImageDraw.Draw(pil_image).text((base_x, base_y), text_content, font=font,
                               fill=text_color + (255,), stroke_width=stroke_width, stroke_fill=(0,0,0,255))

            output_images.append(torch.from_numpy(np.array(pil_image.convert("RGB")).astype(np.float32) / 255.0))

        return (torch.stack(output_images),)

    def parse_subtitle_script(self, script_text):
        subtitle_map = {}
        for line in script_text.split('\n'):
            match = re.match(r'(\d+)\s*-\s*(\d+)\s*[:：]\s*(.*)', line.strip())
            if match:
                s, e, c = int(match.group(1)), int(match.group(2)), match.group(3)
                for i in range(s, e + 1):
                    subtitle_map[i] = c
        return subtitle_map


# ==============================================================================
# 节点 2: 智能语音转脚本 (WhisperSubtitleNode)
# ==============================================================================
class WhisperSubtitleNode:
    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "🔊 音频输入": ("AUDIO",),
                "🧠 模型尺寸": (["Qwen3-ASR-0.6B", "Qwen3-ASR-1.7B"], {"default": "Qwen3-ASR-0.6B"}),
                "🎚️ 模式": (["⏱️ 强制对齐 (Smart Align)", "🗣️ 转录 (Transcribe)"], {"default": "⏱️ 强制对齐 (Smart Align)"}),
                "🎞️ 视频帧率": ("FLOAT", {"default": 25.0, "min": 1.0, "max": 120.0, "step": 0.01}),
            },
            "optional": {
                "📝 台词文本": ("STRING", {"multiline": True, "default": "", "forceInput": True}),
            }
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("📝 结果文本",)
    FUNCTION = "execute_logic"
    CATEGORY = "👨‍🏫班长/视频处理"

    def execute_logic(self, **kwargs):
        if not QWEN_AVAILABLE:
            return (f"❌ 依赖缺失: {QWEN_IMPORT_ERROR}",)

        audio_data = kwargs.get("🔊 音频输入")
        model_name = kwargs.get("🧠 模型尺寸")
        mode = kwargs.get("🎚️ 模式")
        fps = kwargs.get("🎞️ 视频帧率")
        manual_text = kwargs.get("📝 台词文本", "").strip()

        search_roots = [os.path.join(folder_paths.base_path, "models", "qwen-tts"), os.path.join(folder_paths.base_path, "models", "Qwen3-ASR")]
        model_path = next((os.path.join(root, model_name) for root in search_roots if os.path.exists(os.path.join(root, model_name))), None)
        if not model_path:
            return (f"❌ 找不到模型: {model_name}",)

        waveform = audio_data['waveform']
        if waveform.dim() > 1 and waveform.shape[0] > 1:
            waveform = torch.mean(waveform, dim=0, keepdim=True)
        audio_np = waveform.squeeze().cpu().numpy().astype(np.float32)

        device = mm.get_torch_device()
        dtype = torch.float16 if device.type == "cuda" else torch.float32

        try:
            aligner_path = next((os.path.join(root, "Qwen3-ForcedAligner-0.6B") for root in search_roots if os.path.exists(os.path.join(root, "Qwen3-ForcedAligner-0.6B"))), None)
            model = Qwen3ASRModel.from_pretrained(
                model_path, device_map=str(device), dtype=dtype, trust_remote_code=True,
                forced_aligner=aligner_path,
                forced_aligner_kwargs={"device_map": str(device), "dtype": dtype} if aligner_path else None
            )

            results = model.transcribe(audio=(audio_np, audio_data['sample_rate']), return_time_stamps=True)
            res = results[0]

            if "转录" in mode:
                return ((getattr(res, 'text', '') or res.get('text', '')).strip(),)
            else:
                user_sents = []
                if manual_text:
                    raw_lines = [s.strip() for s in re.split(r'[\n。！？!?]+', manual_text) if s.strip()]
                    for line in raw_lines:
                        user_sents.extend(semantic_split(line, max_len=12))
                    return ("\n".join(smart_alignment_engine(user_sents, res.time_stamps, fps)),)
                else:
                    script_lines = []
                    buf_txt, buf_start = "", None
                    for ts in res.time_stamps:
                        txt = ts.get('text', '')
                        start = ts.get('start_time', 0.0)
                        end = ts.get('end_time', 0.0)
                        if buf_start is None:
                            buf_start = start
                        buf_txt += txt
                        if re.search(r'[。！？，；：!?,;:.\n]', txt) or len(buf_txt) >= 12:
                            s_f, e_f = int(buf_start * fps), int(end * fps)
                            if script_lines:
                                last_e = int(script_lines[-1].split('-')[1].split(':')[0])
                                if s_f <= last_e:
                                    s_f = last_e + 1
                            clean_t = strip_punctuation(buf_txt)
                            if clean_t:
                                script_lines.append(f"{s_f}-{e_f}: {clean_t}")
                            buf_txt, buf_start = "", None
                    return ("\n".join(script_lines),)
        except Exception as e:
            return (f"❌ 推理错误: {str(e)}",)


# 注册映射
NODE_CLASS_MAPPINGS = {
    "BanZhang_SimpleVideoSubtitle": SimpleVideoSubtitleNode,
    "BanZhang_WhisperSubtitle": WhisperSubtitleNode
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "BanZhang_SimpleVideoSubtitle": "🎬 视频字幕添加器 (班长 v4 Pro)",
    "BanZhang_WhisperSubtitle": "🎤 智能语音转脚本 (Qwen3-ASR v4)"
}
