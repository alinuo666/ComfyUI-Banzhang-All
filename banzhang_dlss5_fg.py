# -*- coding: utf-8 -*-
"""ComfyUI 节点：🎞️ DLSS5 帧生成插帧

用 NVIDIA DLSS 帧生成（NGX DLSS-FG）给视频/序列提帧率：
生成帧是插在源帧之间的 AI 帧，不是前后帧的模糊叠加。

所需引擎文件不随插件分发，请自行放到 ComfyUI/models/dlss5/dlssg/：
    dlssg-worker.exe   帧生成宿主程序（MIT 协议，非 NVIDIA 文件）
    nvngx.dll          NVIDIA NGX 加载桩
    _nvngx.dll         NVIDIA 驱动核心（从驱动包里提取）
    nvngx_dlssg.dll    NVIDIA 帧生成片段

⚠️ 官方门槛：NVIDIA DLSS 帧生成官方只支持 RTX 40 / RTX 50 系列。
   RTX 30 / 20 系可以打社区补丁 dlssg_for_sm86 用上：把 alternatives\\d3d12.dll
   和 dlssg_sm86.ini 放进上面的引擎目录即可（2026-10-09 已在 RTX 3090 实测通过）。

分层：
    banzhang_dlss5_fg.py        本文件：节点层（参数 / 进度条 / 中断 / 报错文案）
    banzhang_dlss5_fg_engine.py 引擎层（worker 管道协议 + 级联调度）
    banzhang_dlss5_fg_media.py  媒体层（光流 / 视频解码 / 视频输出）

改编自 MIT 协议的 ComfyUI-RH-DLSS5 (RH-RunningHub/ComfyUI-RH-DLSS5)，
2026-10-07 并入班长全家桶。
"""
import gc
import hashlib
import os

import numpy as np
import torch

from .banzhang_dlss5_fg_engine import (
    DLSS5FGError, MULTIPLIERS, TARGET_FPS_CHOICES, as_fps,
    interpolate_frames, interpolate_stream, interpolate_stream_from_source, source_path_of,
)
from .banzhang_dlss5_fg_media import StreamEncoder, build_source, build_video, video_from_file

CATEGORY = "👨‍🏫班长/视频处理"
_MOTION_MODES = {"自动": "auto", "硬件光流(N卡)": "nvof", "软件光流(DIS)": "dis"}


def _log(message: str) -> None:
    print(f"[班长DLSS5插帧] {message}", flush=True)


class BanZhang_DLSS5_FrameInterpolation:
    """用 NVIDIA DLSS 帧生成给视频/图像序列插帧。"""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "目标帧率": (["原样直通", "2倍", "3倍", "4倍"] + TARGET_FPS_CHOICES,
                         {"default": "2倍",
                          "tooltip": "「原样直通」什么都不做直接返回（不插帧不重编码）。"
                                     "「2倍/3倍/4倍」帧率翻倍，每个区间补 1 帧 AI 帧"
                                     "（3/4 倍由多次 2 倍级联而成，耗时按比例上涨）。"
                                     "也可以直接选目标帧率：节点先插出更密的网格"
                                     "（源帧率的 2/4/8 倍）再按时间点取样，不会出现重复帧。"
                                     "目标帧率必须高于源帧率，且最多为源帧率的 6 倍。"}),
            },
            "optional": {
                "视频": ("VIDEO", {"tooltip": "来自「加载视频」等节点。源帧率和音轨都取自这里。"
                                              "文件型视频走「边解码边插帧边编码」，"
                                              "内存基本不随片长增长。"}),
                "图像": ("IMAGE", {"tooltip": "图像批次，批次顺序就是时间顺序。"
                                              "批次没有帧率信息，按下方「序列源帧率」当作原帧率。"}),
                "序列源帧率": ("INT", {"default": 24, "min": 1, "max": 240, "step": 1,
                                       "tooltip": "仅「图像」输入时有效：这批图当作多少 fps 的源。"
                                                  "要和素材实际帧率一致，否则插出来的节奏不对。"}),
                "运动引导": (list(_MOTION_MODES), {"default": "自动",
                          "tooltip": "告诉 AI 画面往哪边动。自动 = 优先用 N 卡硬件光流，"
                                     "没有就用软件光流（软件光流需要装 opencv-python）。"
                                     "判定为切镜的地方不产出 AI 帧。"}),
                "切镜灵敏度": ("FLOAT", {"default": 0.24, "min": 0.01, "max": 1.0, "step": 0.01,
                                     "tooltip": "画面亮度突变超过这个值就判定「切到下一个镜头」，"
                                                "此处不插 AI 帧（否则会跨镜头串画面出鬼影）。"
                                                "调高 = 更少被判定为切镜。"}),
                "保留原音": (["开", "关"], {"default": "开",
                                          "tooltip": "视频输出带上原音轨。有源文件时直接拷贝原音轨"
                                                     "（不重编码）；没有源文件时用「音轨」输入重编码。"}),
                "音轨": ("AUDIO", {"tooltip": "可选。接了视频时它会替换原音轨；"
                                              "只接图像时，这是唯一的加配音方式。"}),
                "引擎目录": ("STRING", {"default": "",
                                        "tooltip": "放 dlssg-worker.exe 那 4 个文件的目录。"
                                                   "留空会自动找 ComfyUI/models/dlss5/dlssg/。"}),
            },
        }

    RETURN_TYPES = ("IMAGE", "VIDEO", "STRING")
    RETURN_NAMES = ("图像", "视频", "状态")
    FUNCTION = "run"
    CATEGORY = CATEGORY

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        digest = hashlib.sha256()
        for key in sorted(kwargs):
            if key in ("图像", "视频", "音轨"):
                continue
            digest.update(f"{key}={kwargs.get(key)!r};".encode())
        video = kwargs.get("视频")
        if video is not None:
            source = source_path_of(video)
            if source:
                try:
                    stat = os.stat(source)
                    digest.update(f"{source}:{stat.st_size}:{stat.st_mtime}".encode())
                except OSError:
                    digest.update(source.encode())
            else:
                digest.update(repr(video).encode())
        image = kwargs.get("图像")
        if image is not None:
            tensor = image if isinstance(image, torch.Tensor) else image[0]
            digest.update(str(tuple(tensor.shape)).encode())
            flat = tensor.detach().reshape(-1)[:: max(1, tensor.numel() // 4096)]
            digest.update(flat.to(torch.float16).cpu().numpy().tobytes())
        return digest.hexdigest()

    @staticmethod
    def _progress():
        """进度条 + 每帧检查一次是否被用户中断。"""
        import comfy.model_management as mm
        from comfy.utils import ProgressBar

        bar = ProgressBar(100)

        def callback(done, total):
            bar.update_absolute(int(100 * done / max(1, total)))
            if mm.processing_interrupted():
                raise mm.InterruptProcessingException()

        return callback

    # ------------------------------------------------------------------ 主体

    def run(self, **kwargs):
        import comfy.model_management as mm

        mm.throw_exception_if_processing_interrupted()  # 排队期间就被取消：不要启动引擎

        image = kwargs.get("图像")
        video = kwargs.get("视频")
        if image is None and video is None:
            raise DLSS5FGError("至少要接一个输入：「图像」或「视频」。")

        choice = str(kwargs.get("目标帧率", "2倍") or "2倍")
        if choice == "原样直通":
            return self._passthrough(image, video, kwargs)

        batch_fps = max(1, int(kwargs.get("序列源帧率", 24) or 24))
        motion_mode = _MOTION_MODES.get(str(kwargs.get("运动引导", "自动")), "auto")
        threshold = float(kwargs.get("切镜灵敏度", 0.24) or 0.24)
        keep_audio = str(kwargs.get("保留原音", "开")) == "开"
        audio_input = kwargs.get("音轨")
        runtime_dir = str(kwargs.get("引擎目录", "") or "")
        multiplier = MULTIPLIERS.get(choice, 2)
        target_fps = None if choice in MULTIPLIERS else as_fps(choice)

        out_image, out_video, notes = None, None, []

        if image is not None:
            out_image, vobj, extra = self._run_image_batch(
                image, batch_fps, multiplier, target_fps, motion_mode, threshold,
                runtime_dir, audio_input)
            if vobj is not None:
                out_video = vobj
            notes.extend(extra)

        if video is not None:
            out_video, extra = self._run_video(
                video, multiplier, target_fps, motion_mode, threshold, runtime_dir,
                keep_audio, audio_input)
            notes.extend(extra)

        return out_image, out_video, " | ".join(notes)

    # ---------------------------------------------------------- 图像批次分支

    def _run_image_batch(self, image, batch_fps, multiplier, target_fps, motion_mode,
                         threshold, runtime_dir, audio_input):
        result, out_fps, note = interpolate_frames(
            image, as_fps(batch_fps), multiplier,
            motion_mode=motion_mode, scene_threshold=threshold,
            runtime_dir=runtime_dir, target_fps=target_fps,
            progress_callback=self._progress(),
        )
        video_obj, vnote = build_video(result, out_fps, audio_input, None)
        notes = [f"图像 {int(image.shape[0])}->{int(result.shape[0])} 帧，{note}"]
        if vnote:
            notes.append(vnote)
        return result, video_obj, notes

    # ------------------------------------------------------------ 视频分支

    def _run_video(self, video, multiplier, target_fps, motion_mode, threshold, runtime_dir,
                   keep_audio, audio_input):
        source_path = source_path_of(video)
        source_video_for_copy = video if (audio_input is None and keep_audio) else None
        chunked = build_source(source_path, log=_log) if source_path else None
        audio = audio_input if keep_audio else None

        if chunked is not None:
            reader, source = chunked
            src_fps = as_fps(reader.fps if reader.fps > 0 else 24)
            _check_target_fps(target_fps, src_fps)
            total_in, height, width = int(reader.count), int(reader.height), int(reader.width)
            _log(f"分块解码 {total_in} 帧 {width}x{height} @{float(src_fps):g}fps")
            out_fps_pre = target_fps if target_fps is not None else src_fps * multiplier
            encoder = StreamEncoder(width, height, out_fps_pre, audio, source_video_for_copy)
            try:
                out_fps, note = interpolate_stream_from_source(
                    source, total_in, width, height, src_fps, multiplier,
                    motion_mode=motion_mode, scene_threshold=threshold,
                    runtime_dir=runtime_dir, frame_sink=encoder.write,
                    target_fps=target_fps, progress_callback=self._progress(),
                )
                encoder.close()
            except BaseException:
                encoder.abort()
                raise
            mode = "边解码边插帧边编码"
        else:
            components = video.get_components()
            frames = components.images
            src_fps = _video_fps(components)
            _check_target_fps(target_fps, src_fps)
            total_in, height, width = int(frames.shape[0]), int(frames.shape[1]), int(frames.shape[2])
            if audio_input is None and keep_audio:
                audio = components.audio
            rgb = np.empty((total_in, height, width, 3), dtype=np.uint8)
            chunk = max(1, (1 << 26) // max(1, height * width))
            for start in range(0, total_in, chunk):
                stop = min(total_in, start + chunk)
                block = frames[start:stop].detach().cpu().mul(255.0).round_().clamp_(0.0, 255.0)
                rgb[start:stop] = block.to(torch.uint8).numpy()
            frames = None
            try:
                components.images = None
            except Exception:
                pass
            gc.collect()
            out_fps_pre = target_fps if target_fps is not None else src_fps * multiplier
            encoder = StreamEncoder(width, height, out_fps_pre, audio, source_video_for_copy)
            try:
                out_fps, note = interpolate_stream(
                    rgb, src_fps, multiplier,
                    motion_mode=motion_mode, scene_threshold=threshold,
                    runtime_dir=runtime_dir, frame_sink=encoder.write,
                    target_fps=target_fps, progress_callback=self._progress(),
                )
                encoder.close()
            except BaseException:
                encoder.abort()
                raise
            mode = "流式编码"

        out_video = video_from_file(encoder.path)
        if encoder.source:
            audio_note = "音轨从源文件直拷贝"
        elif audio_input is not None:
            audio_note = "音轨由音频输入重编码"
        else:
            audio_note = "无音轨"
        notes = [f"视频 {total_in} 源帧 {float(src_fps):g}->{float(out_fps):g}fps，"
                 f"{mode}，{audio_note}；{note}"]
        return out_video, notes

    # ------------------------------------------------------------ 原样直通

    @staticmethod
    def _passthrough(image, video, kwargs):
        """目标帧率 = 原样直通：不插帧、不重编码。"""
        batch_fps = max(1, int(kwargs.get("序列源帧率", 24) or 24))
        out_image, out_video, notes = None, None, []
        if image is not None:
            out_image = image
            notes.append(f"图像 {int(image.shape[0])} 帧 @{batch_fps}fps，原样直通（没有插帧）")
            video_obj, vnote = build_video(image, float(batch_fps), kwargs.get("音轨"), None)
            if video_obj is not None:
                out_video = video_obj
            if vnote:
                notes.append(vnote)
        if video is not None:
            out_video = video
            notes.append("视频原样直通：画面和音轨都原封不动（没有插帧）")
        return out_image, out_video, " | ".join(notes)


def _check_target_fps(target_fps, src_fps) -> None:
    if target_fps is not None and target_fps <= src_fps:
        raise DLSS5FGError(
            f"目标帧率 {float(target_fps):g} 必须高于源帧率 {float(src_fps):g}，"
            f"插帧只能把帧率变高。")


def _video_fps(components):
    config = getattr(components, "config", None)
    if config is not None and getattr(config, "fps", None):
        return as_fps(config.fps)
    frame_rate = getattr(components, "frame_rate", None)
    return as_fps(frame_rate if frame_rate is not None else 24)


NODE_CLASS_MAPPINGS = {
    "BanZhang_DLSS5_FrameInterpolation": BanZhang_DLSS5_FrameInterpolation,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "BanZhang_DLSS5_FrameInterpolation": "🎞️ DLSS5 帧生成插帧",
}
