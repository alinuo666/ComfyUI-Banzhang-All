# -*- coding: utf-8 -*-
"""🎬 H3 涟漪 · 选片段：从视频取一段，标出要改的帧，供外部编辑器使用。"""

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
    RETURN_TYPES = ("IMAGE", st.RIPPLE_TYPE, "IMAGE", "AUDIO") + ("IMAGE",) * st.MAX_ANCHORS
    RETURN_NAMES = ("frames_to_edit", "ripple", "source_window", "audio") + st.ANCHOR_NAMES
    OUTPUT_TOOLTIPS = (
        "按时间顺序排列的待编辑帧，尺寸与 H3 生成尺寸一致。",
        "窗口画面、编辑帧标记与几何信息，交给「应用编辑」和「输出成片」。",
        "窗口原始画面，已按生成尺寸准备好。",
        "这段窗口的原声音频；源片无音轨时为空。",
    ) + tuple(st.anchor_tooltip(i) for i in range(1, st.MAX_ANCHORS + 1))
    DESCRIPTION = (
        "选一段视频，在时间轴上拖动蓝色窗口决定要生成的范围，把标记拖到想修改的那一帧。"
        "下载该帧、在任何图片编辑器里改好，再上传、拖入或粘贴到对应卡片上。"
        "需要多个视角时可加标记，每个标记有独立的锚点输出。"
        "方向键移动标记，Shift+方向键移动窗口，Tab 切换标记，Ctrl+V 粘贴编辑图。"
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
                                         "step": 0.01, "tooltip": "可见画面的百万像素数，默认 0.25。"}),
                "window_start": ("INT", {"default": 0, "min": 0, "max": 10_000_000,
                                 "tooltip": "窗口在 24fps 时间轴上的起始帧，由下方时间轴自动设置。"}),
                "markers": ("STRING", {"default": rc.DEFAULT_MARKERS_JSON, "multiline": False,
                            "tooltip": "带固定编号的编辑帧标记，由时间轴面板管理，不需手填。"}),
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

    def select(self, video, duration, megapixels, window_start, markers, crop="", allow_upscale=False,
               resize_method="lanczos", output_width=0, output_height=0):
        path = vd.video_path(video)
        info = vd.probe(path)
        start, frames_n, notes = rc.fit_window(info["grid_frames"], window_start, rc.duration_frames(duration))
        geometry = rc.geometry(info["width"], info["height"], megapixels, crop, allow_upscale,
                               resize_method, output_width, output_height)
        width, height = geometry["width"], geometry["height"]
        loaded = st.load_window(path, info, start, frames_n, geometry)
        window, frames_n, audio = loaded["window"], loaded["length"], loaded["audio"]
        notes += loaded["notes"]
        marker_list, marker_notes = rc.parse_markers(markers, frames_n)
        notes += marker_notes
        edits = [marker["frame"] for marker in marker_list]
        ripple = {
            "window": window, "markers": marker_list, "length": frames_n, "width": width,
            "height": height, "fps": rc.FPS, "window_start": start, "window_time": loaded["window_time"],
            "audio": audio, "source": video, "source_version": info["version"], "window_key": loaded["key"],
            "binding": (video, path.stat().st_mtime_ns, start, frames_n, tuple(edits), width, height),
            "geometry": geometry,
        }
        cw, ch = geometry["content_rect"][2:]
        text = [rc.describe(start, frames_n, edits) + f" · {cw}x{ch}", *notes]
        ui = {"text": text, "binding": [start, frames_n, edits, video], "geometry": [geometry]}
        frames, anchors = st.anchor_outputs(window, marker_list, geometry)
        return {"ui": ui, "result": (frames, ripple, window, audio, *anchors)}


# 接口必须在模块导入时挂到 routes：ComfyUI 在加载完全部自定义节点之后才把
# routes 装进 app，改成函数延后调用就赶不上这一步（项目里 csglide_adopt.py 同写法）。
@PromptServer.instance.routes.get("/banzhang/ripple/info")
async def ripple_info(request):
    try:
        info = vd.probe(vd.video_path(request.query.get("video", "")))
        info["geometry"] = rc.geometry(info["width"], info["height"], **vd.query_geometry(request.query))
    except (OSError, ValueError, av.error.FFmpegError) as error:
        return web.json_response({"error": str(error)}, status=404)
    return web.json_response(info)


@PromptServer.instance.routes.get("/banzhang/ripple/frame")
async def ripple_frame(request):
    query = request.query
    try:
        data, name = vd.frame_png(query.get("video", ""), int(query.get("frame", "0")),
                                  **vd.query_geometry(query))
    except (OSError, ValueError, av.error.FFmpegError) as error:
        return web.json_response({"error": str(error)}, status=404)
    # 缩略图带版本令牌可以缓存，下载帧必须实时生成。
    cacheable = query.get("v") and not query.get("download")
    headers = {"Cache-Control": "private, max-age=86400" if cacheable else "no-store"}
    if query.get("download"):
        headers["Content-Disposition"] = f'attachment; filename="{name}"'
    return web.Response(body=data, content_type="image/png", headers=headers)


NODE_CLASS_MAPPINGS = {"BZ_RippleClip": BZ_RippleClip}
NODE_DISPLAY_NAME_MAPPINGS = {"BZ_RippleClip": "🎬 H3 涟漪 · 选片段"}
