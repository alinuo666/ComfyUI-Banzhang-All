# -*- coding: utf-8 -*-
"""涟漪编辑：帧网格与画面几何共用规则。

前后端各有一份同规则实现：本文件供后端使用，js/banzhang_ripple_timeline.mjs 供面板使用。
改任何一条规则必须两边同改，否则时间轴显示与实际抽帧会错位。
"""

from __future__ import annotations

import json
import math

FPS = 24
CANVAS_MULTIPLE = 32
DEFAULT_DURATION = 107 / FPS
DEFAULT_MEGAPIXELS = 0.25

# 默认生成指令：纯文字描述想要的内容即可。
DEFAULT_PROMPT = "按参考帧的画面与提示词生成一段连贯的视频。"
RESIZE_METHODS = ("lanczos", "bicubic", "bilinear", "nearest-exact", "area")


def duration_frames(duration: float) -> int:
    if not math.isfinite(float(duration)) or duration <= 0:
        raise ValueError("剪辑时长必须是有限的正数（秒）。")
    return max(5, 5 + 17 * math.floor((duration * FPS - 5) / 17 + 0.5))


def normalized_crop(crop="") -> list[float]:
    if crop is None or crop == "":
        return [0.0, 0.0, 1.0, 1.0]
    values = json.loads(crop) if isinstance(crop, str) else crop
    if not isinstance(values, (list, tuple)) or len(values) != 4:
        raise ValueError("裁剪框必须是 [x, y, 宽, 高] 四个归一化坐标。")
    x, y, w, h = map(float, values)
    if not all(math.isfinite(v) for v in (x, y, w, h)) or w <= 0 or h <= 0:
        raise ValueError("裁剪框坐标必须是有限数，且宽高为正。")
    x, y = max(0.0, min(1.0, x)), max(0.0, min(1.0, y))
    w, h = min(w, 1.0 - x), min(h, 1.0 - y)
    if w <= 0 or h <= 0:
        raise ValueError("裁剪框必须与原画面有重叠区域。")
    return [round(v, 8) for v in (x, y, w, h)]


def geometry(width: int, height: int, megapixels=DEFAULT_MEGAPIXELS, crop="", allow_upscale=False,
             resize_method="lanczos", output_width=0, output_height=0) -> dict:
    """源裁剪区、可见内容区、补齐到 32 倍数的模型画布，三者分开记。"""
    if width < 1 or height < 1:
        raise ValueError("视频尺寸必须为正数。")
    if resize_method not in RESIZE_METHODS:
        raise ValueError(f"未知的缩放算法：{resize_method}")
    mp = float(megapixels)
    if not math.isfinite(mp) or mp <= 0 or output_width < 0 or output_height < 0:
        raise ValueError("百万像素必须为正；适配宽高必须同时为 0 或同时为正。")
    if bool(output_width) != bool(output_height):
        raise ValueError("适配宽与适配高必须同时填写，或同时留 0。")
    selected_crop = normalized_crop(crop)
    x, y, w, h = selected_crop
    left = min(width - 1, math.floor(x * width + 0.5))
    top = min(height - 1, math.floor(y * height + 0.5))
    right = min(width, max(left + 1, math.floor((x + w) * width + 0.5)))
    bottom = min(height, max(top + 1, math.floor((y + h) * height + 0.5)))
    sw, sh = right - left, bottom - top
    scale = math.sqrt(mp * 1_000_000 / (sw * sh)) if mp else 1.0
    if output_width and output_height:
        scale = min(output_width / sw, output_height / sh)
    if not allow_upscale:
        scale = min(1.0, scale)
    cw, ch = max(2, 2 * math.floor(sw * scale / 2)), max(2, 2 * math.floor(sh * scale / 2))
    canvas_w, canvas_h = math.ceil(cw / 32) * 32, math.ceil(ch / 32) * 32
    return {"crop": selected_crop, "source_rect": [left, top, sw, sh],
            "width": canvas_w, "height": canvas_h,
            "content_rect": [(canvas_w - cw) // 2, (canvas_h - ch) // 2, cw, ch],
            "resize_method": resize_method}


def grid_frame_count(duration: float, fps: float = FPS) -> int:
    """与 FFmpeg 的 fps 滤镜同一取整口径，避免预览和实际抽帧差一帧。"""
    return max(0, math.floor(duration * fps + 0.5))


def fit_window(available: int, window_start: int, length: int) -> tuple[int, int, list[str]]:
    """窗口能放就保持长度，放不下就从片尾往前挪；绝不补帧或循环帧。"""
    notes = []
    if available < 5:
        raise ValueError(f"视频按 24 fps 只有 {available} 帧，H3 至少需要 5 帧。")
    if length > available:
        shorter = 17 * ((available - 5) // 17) + 5
        notes.append(f"视频短于 {length} 帧，已改用 {shorter} 帧。")
        length = shorter
    start = min(max(0, int(window_start)), available - length)
    if start != window_start:
        notes.append(f"窗口已移到第 {start} 帧，以便完整放下。")
    return start, length, notes
