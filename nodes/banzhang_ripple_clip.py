# -*- coding: utf-8 -*-
"""🎬 H3 涟漪 · 时间轴选段：从视频里选一段，按生成画布输出视频 / 画面 / 音频，供生成与保存链路使用。"""

from __future__ import annotations

import av
from aiohttp import web
from server import PromptServer

from ..core import banzhang_ripple_core as rc
from ..core import banzhang_ripple_state as st
from ..core import banzhang_ripple_video as vd


class BZ_RippleClip:
    CATEGORY = st.CATEGORY
    FUNCTION = "select"
    RETURN_TYPES = ("VIDEO", "IMAGE", "AUDIO", "IMAGE", "IMAGE", "FLOAT", "FLOAT", "INT")
    RETURN_NAMES = ("video", "source_window", "audio", "first_frame", "last_frame",
                    "fps", "duration", "total_frames")
    OUTPUT_TOOLTIPS = (
        "选中片段的官方 VIDEO（带原声，可直接接「保存视频」）；「应用编辑」「输出成片」也接这里。",
        "窗口原始画面，已按生成尺寸准备好。",
        "这段窗口的音频；源片无音轨时为空。",
        "选区的第一帧（内容区，无补边）。",
        "选区的最后一帧——时间轴手动设置那段的末尾，不是整部源片的最后一帧。",
        "输出视频的帧率：涟漪链路固定按 24fps 出片。",
        "这段选区的实际时长（秒）；源片不足或网格对齐时会自动缩短。",
        "这段选区的总帧数（已对齐 17n+5 帧网格，含补齐帧）。",
    )
    DESCRIPTION = (
        "选一段视频，在时间轴上拖动蓝色窗口决定要生成的范围，Shift+方向键也能挪窗口。"
        "点击预览画面即可播放 / 暂停选区（带原声，音画同步）。"
        "输出口是这段选区的官方 VIDEO：可直连「保存视频」，或接「应用编辑」组成 H3 生成条件。"
        "另有首帧 / 尾帧两个图像口，取的都是选区窗口的头尾。"
        "「原片裁剪」选手动裁剪后，预览画面上会出现可拖动的裁剪框。"
    )

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "video": (vd.list_videos(), {"video_upload": True,
                          "tooltip": "放在 ComfyUI/input 里的视频，可在节点上直接上传。"}),
                "duration": ("FLOAT", {"default": rc.DEFAULT_DURATION, "min": 5 / rc.FPS, "max": 150.0,
                                       "step": 0.01, "tooltip": "片段长度（秒，按 24fps 计算），自动对齐到 H3 的 17n+5 帧网格。"}),
                "megapixels": ("FLOAT", {"default": rc.DEFAULT_MEGAPIXELS, "min": 0.001, "max": 268.435456,
                                         "step": 0.01, "tooltip": "输出画面的百万像素数，默认 0.25。"}),
                "window_start": ("INT", {"default": 0, "min": 0, "max": 10_000_000,
                                 "tooltip": "窗口在 24fps 时间轴上的起始帧，由下方时间轴自动设置。"}),
            },
            "optional": st.framing_inputs(),
        }

    @classmethod
    def VALIDATE_INPUTS(cls, video, duration, megapixels, crop="",
                        allow_upscale=False, resize_method="lanczos", output_width=0, output_height=0):
        try:
            vd.video_path(video)
            rc.duration_frames(duration)
            rc.geometry(1920, 1080, megapixels, crop, allow_upscale, resize_method,
                        output_width, output_height)
        except (ValueError, IndexError, TypeError) as error:
            return str(error)
        return True

    @classmethod
    def IS_CHANGED(cls, video, **kwargs):
        stat = vd.video_path(video).stat()
        return (video, stat.st_size, stat.st_mtime_ns, tuple(sorted(kwargs.items())))

    def select(self, video, duration, megapixels, window_start, crop="", allow_upscale=False,
               resize_method="lanczos", output_width=0, output_height=0):
        path = vd.video_path(video)
        info = vd.probe(path)
        start, frames_n, _ = rc.fit_window(info["grid_frames"], window_start, rc.duration_frames(duration))
        geometry = rc.geometry(info["width"], info["height"], megapixels, crop, allow_upscale,
                               resize_method, output_width, output_height)
        width, height = geometry["width"], geometry["height"]
        loaded = st.load_window(path, info, start, frames_n, geometry)
        window, frames_n, audio = loaded["window"], loaded["length"], loaded["audio"]
        ripple = {
            "window": window, "length": frames_n, "width": width, "height": height,
            "fps": rc.FPS, "audio": audio, "window_key": loaded["key"], "geometry": geometry,
        }
        content = vd.trim_content(window, geometry)
        clip_video = st.make_ripple_video(content, rc.FPS, audio, ripple)
        return (clip_video, window, audio, content[0:1].clone(), content[-1:].clone(),
                float(rc.FPS), frames_n / rc.FPS, int(frames_n))


# 接口必须在模块导入时挂到 routes：ComfyUI 在加载完全部自定义节点之后才把
# routes 装进 app，改成函数延后调用就赶不上这一步（项目里 csglide_adopt.py 同写法）。
# 时间轴面板靠它读源片时长与尺寸，删了面板就只剩转圈。
@PromptServer.instance.routes.get("/banzhang/ripple/info")
async def ripple_info(request):
    try:
        info = vd.probe(vd.video_path(request.query.get("video", "")))
        info["geometry"] = rc.geometry(info["width"], info["height"], **vd.query_geometry(request.query))
    except (OSError, ValueError, av.error.FFmpegError) as error:
        return web.json_response({"error": str(error)}, status=404)
    return web.json_response(info)


NODE_CLASS_MAPPINGS = {"BZ_RippleClip": BZ_RippleClip}
NODE_DISPLAY_NAME_MAPPINGS = {"BZ_RippleClip": "🎬 H3 涟漪 · 时间轴选段"}
