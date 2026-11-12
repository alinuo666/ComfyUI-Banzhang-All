# -*- coding: utf-8 -*-
"""
👨‍🏫 班长音频节点模块
包含：音频批处理、音频定长与补齐
"""

import torch
import sys
import typing

from .csglide_audio_io import resample_waveform

# ==============================================================================
# 节点 1: 音频循环收集器 (BanZhang_Audio_Batcher)
# ==============================================================================
class BanZhang_Audio_Batcher:
    """
    功能说明：
    这个节点专门用于在循环（For Loop）中收集音频。
    它可以把每次循环生成的单段音频进行合并。
    """

    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "现有音频堆": ("AUDIO",),
                "新音频": ("AUDIO",),
                "合并模式": (["⏱️ 串联连接 (时间延长)", "📦 批量堆叠 (数量增加)"], {"default": "⏱️ 串联连接 (时间延长)"}),
            },
        }

    RETURN_TYPES = ("AUDIO",)
    RETURN_NAMES = ("📦 整合后的音频",)
    FUNCTION = "collect_audio"
    CATEGORY = "👨‍🏫班长/音频处理"

    def collect_audio(self, 现有音频堆, 新音频, 合并模式):
        if 现有音频堆 is None:
            return (新音频,)

        新波形 = 新音频['waveform']
        新采样率 = 新音频['sample_rate']
        老波形 = 现有音频堆['waveform']
        老采样率 = 现有音频堆['sample_rate']

        if 新采样率 != 老采样率:
            print(f"👨‍🏫 班长提示：检测到采样率不一致（新:{新采样率} vs 旧:{老采样率}），强制使用旧采样率。")

        if "⏱️ 串联连接" in 合并模式:
            if 老波形.shape[0] != 新波形.shape[0] or 老波形.shape[1] != 新波形.shape[1]:
                print("👨‍🏫 警告：音频通道数或批次大小不一致，可能会报错！尝试强制拼接...")
            合并后的波形 = torch.cat((老波形, 新波形), dim=2)
        else:
            老长度 = 老波形.shape[2]
            新长度 = 新波形.shape[2]
            最大长度 = max(老长度, 新长度)

            def 补全波形(原始波形, 目标长度):
                当前长度 = 原始波形.shape[2]
                if 当前长度 < 目标长度:
                    差值 = 目标长度 - 当前长度
                    return torch.nn.functional.pad(原始波形, (0, 差值), "constant", 0)
                return 原始波形

            老波形_对齐后 = 补全波形(老波形, 最大长度)
            新波形_对齐后 = 补全波形(新波形, 最大长度)
            合并后的波形 = torch.cat((老波形_对齐后, 新波形_对齐后), dim=0)

        结果音频 = {
            "waveform": 合并后的波形,
            "sample_rate": 老采样率
        }
        return (结果音频,)


# ==============================================================================
# 节点 2: 音频定长与补齐 (Banzhang_AudioDurationFixer)
# ==============================================================================
class Banzhang_AudioDurationFixer:
    """
    👨‍🏫班长/音频处理/音频定长与补齐
    功能：调整音频长度，支持补静音、裁剪、重采样和立体声转换。
    支持按时间(秒)或按视频帧数设定长度。
    """

    def __init__(self):
        pass

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "🎵 输入音频": ("AUDIO",),
                "⏱️ 目标时长(秒)": ("FLOAT", {"default": 10.0, "min": 0.0, "max": 3600.0, "step": 0.01}),
                "↔️ 填充位置": (["结尾", "开头"],),
                "🔄 目标采样率": ("INT", {"default": 44100, "min": 8000, "max": 96000, "step": 100}),
                "🎧 强制立体声": ("BOOLEAN", {"default": True}),
                "🎞️ 视频帧率": ("FLOAT", {"default": 30.0, "min": 1.0, "max": 120.0, "step": 0.01}),
                "🔢 目标视频帧数(0=不使用)": ("INT", {"default": 0, "min": 0, "max": 999999}),
            }
        }

    RETURN_TYPES = ("AUDIO", "FLOAT", "INT")
    RETURN_NAMES = ("🎵 输出音频", "⏱️ 实际时长", "🔢 视频总帧数")
    FUNCTION = "execute_audio_fix"
    CATEGORY = "👨‍🏫班长/音频处理"

    def execute_audio_fix(self, **kwargs):
        if torch is None:
            print("❌ 👨‍🏫 班长提示: 缺少 torch 库！")
            return (None, 0.0, 0)

        audio = kwargs.get("🎵 输入音频")
        duration_sec = kwargs.get("⏱️ 目标时长(秒)")
        fill_mode = kwargs.get("↔️ 填充位置")
        sample_rate = kwargs.get("🔄 目标采样率")
        force_stereo = kwargs.get("🎧 强制立体声")
        video_fps = kwargs.get("🎞️ 视频帧率", 30.0)
        target_video_frames = kwargs.get("🔢 目标视频帧数(0=不使用)", 0)

        if audio is None:
            print("❌ 👨‍🏫班长提示：没有输入音频数据 (Input is None)。")
            return (None, 0.0, 0)

        try:
            if target_video_frames > 0:
                目标时长_秒 = target_video_frames / video_fps
                print(f"👨‍🏫班长日志: 检测到帧数设定 -> {target_video_frames}帧 @ {video_fps}fps = {目标时长_秒:.4f}秒")
            else:
                目标时长_秒 = duration_sec
                估算帧数 = int(目标时长_秒 * video_fps)
                print(f"👨‍🏫班长日志: 使用时间设定 -> {目标时长_秒}秒 (约 {估算帧数} 视频帧)")

            原始波形 = audio["waveform"].clone().cpu()
            原始采样率 = audio["sample_rate"]
            目标采样率 = sample_rate

            print(f"👨‍🏫班长日志: 收到音频，原始采样率={原始采样率}Hz，形状={原始波形.shape}")

            if 原始采样率 != 目标采样率:
                print(f"👨‍🏫班长日志: 正在重采样 {原始采样率} -> {目标采样率}...")
                # 重采样走公共层：torchaudio → swresample → 线性插值自动降级，
                # 不再因为这台机器没装 torchaudio 就让整个节点罢工。
                当前波形 = resample_waveform(原始波形, 原始采样率, 目标采样率)
            else:
                当前波形 = 原始波形

            批次大小, 声道数, 样本数 = 当前波形.shape

            if force_stereo and 声道数 == 1:
                当前波形 = torch.cat([当前波形, 当前波形], dim=1)
                print("👨‍🏫班长日志: 已将单声道转换为立体声。")

            目标样本数 = int(目标时长_秒 * 目标采样率)
            当前样本数 = 当前波形.shape[-1]

            print(f"👨‍🏫班长日志: 音频采样点数 当前={当前样本数} -> 目标={目标样本数}")

            if 当前样本数 < 目标样本数:
                需要补的数量 = 目标样本数 - 当前样本数
                if fill_mode == "结尾":
                    填充参数 = (0, 需要补的数量)
                else:
                    填充参数 = (需要补的数量, 0)
                最终波形 = torch.nn.functional.pad(当前波形, 填充参数, mode='constant', value=0)
                print(f"👨‍🏫班长日志: 音频较短，已在{fill_mode}补充了 {需要补的数量} 个采样点的静音。")
            elif 当前样本数 > 目标样本数:
                最终波形 = 当前波形[:, :, :目标样本数]
                print("👨‍🏫班长日志: 音频较长，已裁剪多余部分。")
            else:
                最终波形 = 当前波形
                print("👨‍🏫班长日志: 音频长度完美匹配。")

            输出音频包 = {
                "waveform": 最终波形,
                "sample_rate": 目标采样率
            }

            最终采样点数 = 最终波形.shape[-1]
            最终时长 = 最终采样点数 / 目标采样率
            最终视频帧数 = int(最终时长 * video_fps)

            return (输出音频包, float(最终时长), int(最终视频帧数))

        except Exception as e:
            print(f"❌ 👨‍🏫班长提示：处理音频时发生错误 -> {e}")
            return (audio, 0.0, 0)


# 节点映射
NODE_CLASS_MAPPINGS = {
    "BanZhang_Audio_Batcher": BanZhang_Audio_Batcher,
    "Banzhang_AudioDurationFixer": Banzhang_AudioDurationFixer
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "BanZhang_Audio_Batcher": "🎵 音频循环收集器 (Batch Audio)",
    "Banzhang_AudioDurationFixer": "✂️ 班长-音频定长与补齐"
}
