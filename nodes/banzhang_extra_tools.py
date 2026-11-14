# -*- coding: utf-8 -*-
"""
👨‍🏫 班长额外工具模块
包含：音频保存、音频拼接、图像处理工具
"""

import os
import torch
import torch.nn.functional as F
import numpy as np
from pathlib import Path

from comfy import model_management
from comfy.utils import ProgressBar

# ==========================================
# 🔊 自定义音频保存节点
# ==========================================
try:
    from scipy.io import wavfile
    import soundfile as sf
    
    class Banzhang_CustomAudioSaver:
        def __init__(self):
            pass
        
        @classmethod
        def INPUT_TYPES(cls):
            return {
                "required": {
                    "🎵 音频数据": ("AUDIO",),
                    "📁 保存路径": ("STRING", {"default": "output", "placeholder": "留 output 存到 ComfyUI/output，也可填完整路径"}),
                    "📝 文件名称": ("STRING", {"default": "output", "placeholder": "输入文件名(不含扩展名)"}),
                    "📦 文件格式": (["wav", "flac", "ogg", "mp3"], {"default": "wav"}),
                    "🔄 处理方式": (["覆盖同名文件", "按顺序自动命名"], {"default": "按顺序自动命名"}),
                }
            }
        
        RETURN_TYPES = ()
        FUNCTION = "save_audio"
        OUTPUT_NODE = True
        CATEGORY = "👨‍🏫班长/音频处理"
        DISPLAY_NAME = "📥 自定义音频保存"

        def save_audio(self, **kwargs):
            音频数据 = kwargs.get("🎵 音频数据")
            保存路径 = kwargs.get("📁 保存路径")
            文件名称 = kwargs.get("📝 文件名称")
            文件格式 = kwargs.get("📦 文件格式")
            处理方式 = kwargs.get("🔄 处理方式")

            sample_rate = None
            audio_data = None

            if isinstance(音频数据, tuple):
                if len(音频数据) == 2:
                    sample_rate, audio_data = 音频数据
                elif len(音频数据) == 3 and isinstance(音频数据[0], int):
                    sample_rate = 音频数据[0]
                    audio_data = 音频数据[1]
            elif isinstance(音频数据, dict):
                if "sample_rate" in 音频数据 and "waveform" in 音频数据:
                    sample_rate = 音频数据["sample_rate"]
                    audio_data = 音频数据["waveform"]
                elif "sr" in 音频数据 and "audio" in 音频数据:
                    sample_rate = 音频数据["sr"]
                    audio_data = 音频数据["audio"]
            elif isinstance(音频数据, (np.ndarray, torch.Tensor)):
                sample_rate = 44100
                audio_data = 音频数据

            if sample_rate is None or audio_data is None:
                return {"ui": {"message": ["❌ 音频数据格式不支持"]}}

            sample_rate = int(sample_rate)

            if isinstance(audio_data, torch.Tensor):
                audio_data = audio_data.cpu().numpy()

            if audio_data.ndim == 1:
                audio_data = np.expand_dims(audio_data, axis=0)
            elif audio_data.ndim == 3 and audio_data.shape[0] == 1:
                audio_data = audio_data.squeeze(0)
            elif audio_data.ndim > 2:
                audio_data = audio_data.reshape(-1, audio_data.shape[-1])

            audio_data = np.ascontiguousarray(audio_data)

            try:
                os.makedirs(保存路径, exist_ok=True)
            except Exception as e:
                return {"ui": {"message": [f"❌ 无法创建目录: {str(e)}"]}}

            full_path = None

            if 处理方式 == "按顺序自动命名":
                counter = 1
                while True:
                    new_filename = f"{文件名称}_{counter:04d}.{文件格式}"
                    full_path = os.path.join(保存路径, new_filename)
                    if not os.path.exists(full_path):
                        break
                    counter += 1
            else:
                base_filename = f"{文件名称}.{文件格式}"
                full_path = os.path.join(保存路径, base_filename)

            try:
                if audio_data.size == 0:
                    return {"ui": {"message": ["❌ 音频数据为空"]}}

                if np.issubdtype(audio_data.dtype, np.floating):
                    max_val = np.max(np.abs(audio_data))
                    if max_val > 0 and max_val > 1.0:
                        audio_data = audio_data / max_val

                if 文件格式 == "wav":
                    if np.issubdtype(audio_data.dtype, np.floating):
                        audio_data_int16 = (audio_data * 32767).astype(np.int16)
                    else:
                        audio_data_int16 = audio_data.astype(np.int16)
                    wavfile.write(full_path, sample_rate, audio_data_int16.T)
                else:
                    if not np.issubdtype(audio_data.dtype, np.floating):
                        if np.issubdtype(audio_data.dtype, np.integer):
                            audio_data_float = audio_data.astype(np.float32) / 32767.0
                        else:
                            audio_data_float = audio_data.astype(np.float32)
                    else:
                        audio_data_float = audio_data
                    sf.write(full_path, audio_data_float.T, sample_rate, format=文件格式)

                return {"ui": {"message": [f"✅ 音频保存成功: {full_path}"]}}
            except Exception as e:
                return {"ui": {"message": [f"❌ 保存失败: {str(e)}"]}}

    HAS_SOUNDFILE = True
except ImportError:
    HAS_SOUNDFILE = False

# ==========================================
# 🔗 音频文件夹拼接器
# ==========================================
try:
    from pydub import AudioSegment
    import re
    import folder_paths

    class Banzhang_AudioConcatenator:
        @classmethod
        def INPUT_TYPES(s):
            return {
                "required": {
                    "📁 音频文件夹路径": ("STRING", {"default": "", "multiline": False}),
                    "🔄 排序方式": (["文件名(最小到最大)", "文件名(最大到最小)", "修改时间(最新到最旧)", "修改时间(最旧到最新)"], {"default": "文件名(最小到最大)"}),
                    "📝 输出文件名": ("STRING", {"default": "拼接音频.wav", "multiline": False}),
                },
                "optional": {
                    "📁 输出路径": ("STRING", {"default": "", "multiline": False}),
                }
            }

        RETURN_TYPES = ("AUDIO", "STRING")
        RETURN_NAMES = ("🎵 音频数据", "📁 文件路径")
        FUNCTION = "concatenate_audio"
        CATEGORY = "👨‍🏫班长/音频处理"

        def natural_sort_key(self, filename):
            parts = re.split(r'(\d+)', os.path.basename(filename))
            result = []
            for part in parts:
                if part.isdigit():
                    result.append(int(part))
                else:
                    result.append(part.lower())
            return result

        def concatenate_audio(self, **kwargs):
            音频文件夹路径 = kwargs.get("📁 音频文件夹路径")
            排序方式 = kwargs.get("🔄 排序方式")
            输出文件名 = kwargs.get("📝 输出文件名")
            输出路径 = kwargs.get("📁 输出路径")

            if not os.path.isdir(音频文件夹路径):
                return (None, f"❌ 文件夹不存在: {音频文件夹路径}")

            if not 输出路径 or 输出路径.strip() == "":
                输出目录 = folder_paths.get_output_directory()
            else:
                输出目录 = 输出路径
                os.makedirs(输出目录, exist_ok=True)

            audio_files = set()
            extensions = [".wav", ".mp3", ".flac", ".ogg"]

            for file in os.listdir(音频文件夹路径):
                file_path = os.path.join(音频文件夹路径, file)
                if os.path.isfile(file_path):
                    file_ext = Path(file).suffix.lower()
                    if file_ext in extensions:
                        audio_files.add(os.path.normpath(os.path.abspath(file_path)))

            if not audio_files:
                return (None, "❌ 未找到支持的音频文件")

            audio_files = list(audio_files)

            if 排序方式 == "文件名(最小到最大)":
                audio_files.sort(key=self.natural_sort_key)
            elif 排序方式 == "文件名(最大到最小)":
                audio_files.sort(key=self.natural_sort_key, reverse=True)
            elif 排序方式 == "修改时间(最新到最旧)":
                audio_files.sort(key=lambda x: os.path.getmtime(x), reverse=True)
            elif 排序方式 == "修改时间(最旧到最新)":
                audio_files.sort(key=lambda x: os.path.getmtime(x))

            combined = AudioSegment.empty()

            for file in audio_files:
                try:
                    audio = AudioSegment.from_file(file)
                    combined += audio
                except Exception as e:
                    print(f"跳过文件 {file}: {e}")

            if len(combined) == 0:
                return (None, "❌ 没有成功加载任何音频文件")

            samples = np.array(combined.get_array_of_samples())
            if combined.channels > 1:
                samples = samples.reshape((-1, combined.channels))

            audio_tensor = torch.from_numpy(samples).float()
            max_val = torch.abs(audio_tensor).max()
            if max_val > 0:
                audio_tensor = audio_tensor / max_val

            if combined.channels == 1:
                audio_tensor = audio_tensor.unsqueeze(0)
            else:
                audio_tensor = audio_tensor.T

            audio_dict = {
                "waveform": audio_tensor.unsqueeze(0),
                "sample_rate": combined.frame_rate
            }

            output_full_path = os.path.join(输出目录, 输出文件名)
            if not output_full_path.lower().endswith(('.wav', '.mp3', '.flac', '.ogg')):
                output_full_path += ".wav"

            os.makedirs(os.path.dirname(output_full_path), exist_ok=True)
            ext = Path(output_full_path).suffix.lower()
            export_format = {".wav": "wav", ".mp3": "mp3", ".flac": "flac", ".ogg": "ogg"}.get(ext, "wav")
            combined.export(output_full_path, format=export_format)

            return (audio_dict, output_full_path)

    HAS_PYDUB = True
except ImportError:
    HAS_PYDUB = False

# ==========================================
# ✂️ 两宫格分割器
# ==========================================
class Banzhang_SplitTwoPanel:
    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "🖼️ 图像": ("IMAGE",),
                "🔄 分割方向": (["水平", "垂直"], {"default": "垂直"}),
            }
        }

    RETURN_TYPES = ("IMAGE", "IMAGE")
    RETURN_NAMES = ("左/上图", "右/下图")
    FUNCTION = "split_image"
    CATEGORY = "👨‍🏫班长/图像处理"

    def split_image(self, **kwargs):
        image = kwargs.get("🖼️ 图像")
        direction = kwargs.get("🔄 分割方向")

        if image is None:
            return (None, None)

        if len(image.shape) == 3:
            image = image.unsqueeze(0)

        _, h, w, _ = image.shape

        if direction == "垂直":
            mid = w // 2
            left = image[:, :, :mid, :]
            right = image[:, :, mid:, :]
        else:
            mid = h // 2
            left = image[:, :mid, :, :]
            right = image[:, mid:, :, :]

        return (left, right)

# ==========================================
# 🔄 替换首尾帧
# ==========================================
class Banzhang_ReplaceFirstLastFrames:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "📽️ 源帧": ("IMAGE",),
                "🔄 重复模式": (["首尾替换", "循环填充"], {"default": "首尾替换"}),
                "🔢 目标帧数": ("INT", {"default": 300, "min": 1, "max": 99999}),
            }
        }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("📽️ 输出帧序列",)
    FUNCTION = "replace_frames"
    CATEGORY = "👨‍🏫班长/图像处理"

    def replace_frames(self, **kwargs):
        source_frames = kwargs.get("📽️ 源帧")
        mode = kwargs.get("🔄 重复模式")
        target_count = kwargs.get("🔢 目标帧数")

        if source_frames is None:
            return (None,)

        if len(source_frames.shape) == 3:
            source_frames = source_frames.unsqueeze(0)

        current_count = source_frames.shape[0]

        if current_count >= target_count:
            return (source_frames[:target_count],)

        need_more = target_count - current_count

        if mode == "首尾替换":
            first_frame = source_frames[0:1]
            last_frame = source_frames[-1:]
            prepend_count = need_more // 2
            append_count = need_more - prepend_count
            prepended = first_frame.repeat(prepend_count, 1, 1, 1)
            appended = last_frame.repeat(append_count, 1, 1, 1)
            result = torch.cat([prepended, source_frames, appended], dim=0)
        else:
            full_cycles = need_more // current_count
            remainder = need_more % current_count
            full_part = source_frames.repeat(full_cycles, 1, 1, 1)
            remainder_part = source_frames[:remainder]
            result = torch.cat([source_frames, full_part, remainder_part], dim=0)

        return (result,)

# ==========================================
# 🧩 图像多路拼接器 (复刻自 KJNodes ImageConcatMulti)
# ==========================================
class Banzhang_ImageConcatMulti:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "🔢 输入数量": ("INT", {"default": 2, "min": 2, "max": 1000, "step": 1,
                                   "tooltip": "要拼接的图像数量。修改后点击「🔄 更新输入」按钮增减输入槽"}),
                "🖼️ 图像1": ("IMAGE", {"tooltip": "第一张图像,决定输出画面的批次数基准"}),
                "🧭 拼接方向": (["右", "下", "左", "上"], {"default": "右",
                                          "tooltip": "后一张图像拼在前一张的哪个方向"}),
                "📐 对齐第一张尺寸": ("BOOLEAN", {"default": False,
                                        "tooltip": "开启:其余图像缩放到与第一张同高(左右拼接)或同宽(上下拼接)再拼接\n关闭:按各自原尺寸拼接,尺寸不足处居中补黑"}),
            },
            "optional": {
                "🖼️ 图像2": ("IMAGE", {"tooltip": "第二张图像。未连接时用黑块占位"}),
            },
        }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("🖼️ 拼接结果",)
    FUNCTION = "concat"
    CATEGORY = "👨‍🏫班长/图像处理"

    def concat(self, **kwargs):
        inputcount = kwargs["🔢 输入数量"]
        direction = {"右": "right", "下": "down", "左": "left", "上": "up"}[kwargs["🧭 拼接方向"]]
        match_image_size = kwargs["📐 对齐第一张尺寸"]

        image = kwargs["🖼️ 图像1"]
        first_image_shape = image.shape
        for c in range(1, inputcount):
            key = f"🖼️ 图像{c + 1}"
            new_image = kwargs.get(key)
            if new_image is None:
                # 输入槽存在但未连线时,用黑块占位(与 KJNodes 行为一致)
                new_image = torch.zeros(
                    first_image_shape,
                    dtype=model_management.intermediate_dtype(),
                    device=model_management.intermediate_device(),
                )
            image = self._concat_two(image, new_image, direction, match_image_size,
                                     first_image_shape=first_image_shape)
        return (image,)

    @staticmethod
    def _concat_two(image1, image2, direction, match_image_size, first_image_shape=None):
        """将 image2 拼接到 image1 上(复刻 KJNodes ImageConcanate.concatenate, 仅 IMAGE 版)"""
        bs1, bs2 = image1.shape[0], image2.shape[0]
        B = max(bs1, bs2)

        H1, W1 = image1.shape[1], image1.shape[2]
        C1, C2 = image1.shape[-1], image2.shape[-1]
        out_C = max(C1, C2)

        if match_image_size:
            target_shape = first_image_shape if first_image_shape is not None else image1.shape
            orig_aspect = image2.shape[2] / image2.shape[1]
            if direction in ("left", "right"):
                H2 = target_shape[1]
                W2 = int(H2 * orig_aspect)
            else:
                W2 = target_shape[2]
                H2 = int(W2 / orig_aspect)
        else:
            H2, W2 = image2.shape[1], image2.shape[2]

        if direction in ("right", "left"):
            out_H, out_W = max(H1, H2), W1 + W2
        else:
            out_H, out_W = H1 + H2, max(W1, W2)

        if direction == "right":
            i1_y, i1_x, i2_y, i2_x = (out_H - H1) // 2, 0, (out_H - H2) // 2, W1
        elif direction == "left":
            i1_y, i1_x, i2_y, i2_x = (out_H - H1) // 2, W2, (out_H - H2) // 2, 0
        elif direction == "down":
            i1_y, i1_x, i2_y, i2_x = 0, (out_W - W1) // 2, H1, (out_W - W2) // 2
        else:  # up
            i1_y, i1_x, i2_y, i2_x = H2, (out_W - W1) // 2, 0, (out_W - W2) // 2

        output = torch.zeros(
            (B, out_H, out_W, out_C),
            dtype=model_management.intermediate_dtype(),
            device=model_management.intermediate_device(),
        )

        def write(dst, src, src_C):
            if dst.shape[-1] == src_C:
                dst.copy_(src)
            else:
                dst[..., :src_C].copy_(src)
                dst[..., src_C:].fill_(1.0)

        slot1 = output[:, i1_y:i1_y + H1, i1_x:i1_x + W1, :]
        if bs1 == B:
            write(slot1, image1, C1)
        else:
            write(slot1[:bs1], image1, C1)
            write(slot1[bs1:], image1[-1:].expand(B - bs1, -1, -1, -1), C1)
        del slot1

        slot2 = output[:, i2_y:i2_y + H2, i2_x:i2_x + W2, :]
        if match_image_size:
            pbar = ProgressBar(B)
            device = model_management.get_torch_device()
            for i in range(B):
                src_i = min(i, bs2 - 1)
                frame = image2[src_i:src_i + 1].to(device, non_blocking=True).permute(0, 3, 1, 2)
                resized = F.interpolate(frame, size=(H2, W2), mode="bicubic", antialias=True).permute(0, 2, 3, 1)
                write(slot2[i:i + 1], resized, C2)
                del frame, resized
                pbar.update(1)
        else:
            if bs2 == B:
                write(slot2, image2, C2)
            else:
                write(slot2[:bs2], image2, C2)
                write(slot2[bs2:], image2[-1:].expand(B - bs2, -1, -1, -1), C2)
        del slot2

        return output

# ==========================================
# 注册节点
# ==========================================
NODE_CLASS_MAPPINGS = {
    "Banzhang_SplitTwoPanel": Banzhang_SplitTwoPanel,
    "Banzhang_ReplaceFirstLastFrames": Banzhang_ReplaceFirstLastFrames,
    "Banzhang_ImageConcatMulti": Banzhang_ImageConcatMulti,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "Banzhang_SplitTwoPanel": "✂️ 两宫格分割器",
    "Banzhang_ReplaceFirstLastFrames": "🔄 替换首尾帧",
    "Banzhang_ImageConcatMulti": "🧩 图像多路拼接",
}

if HAS_SOUNDFILE:
    NODE_CLASS_MAPPINGS["Banzhang_CustomAudioSaver"] = Banzhang_CustomAudioSaver
    NODE_DISPLAY_NAME_MAPPINGS["Banzhang_CustomAudioSaver"] = "📥 自定义音频保存"

if HAS_PYDUB:
    NODE_CLASS_MAPPINGS["Banzhang_AudioConcatenator"] = Banzhang_AudioConcatenator
    NODE_DISPLAY_NAME_MAPPINGS["Banzhang_AudioConcatenator"] = "🔗 音频文件夹拼接器"
