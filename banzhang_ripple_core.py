# -*- coding: utf-8 -*-
"""涟漪编辑：帧网格、画面几何、锚点标记共用规则。

前后端各有一份同规则实现：本文件供后端使用，js/banzhang_ripple_timeline.mjs 供面板使用。
改任何一条规则必须两边同改，否则时间轴显示与实际抽帧会错位。
"""

from __future__ import annotations

import json
import math

import numpy as np

FPS = 24
CANVAS_MULTIPLE = 32
DEFAULT_DURATION = 107 / FPS
DEFAULT_MEGAPIXELS = 0.25

# 中文提示词由用户指定；按「任务 → 范围 → 约束」写，不用英文逐句直译的长从句。
DEFAULT_PROMPT = (
    "把编辑参考帧里的改动应用到整段视频的每一帧。"
    "编辑参考帧展示的是改动完成后的画面；这个改动要贯穿整段视频，"
    "参考帧之前、之间、之后的每一帧都保持同样效果，前后连贯。"
    "改动以外的部分与原视频保持一致：人物和物体的动作、镜头移动、画面构图、时间节奏，"
    "以及所有未修改的内容都不变。"
)
RESIZE_METHODS = ("lanczos", "bicubic", "bilinear", "nearest-exact", "area")


def default_markers() -> list[dict]:
    return [{"id": 1, "frame": 0, "edited": "", "edited_at": None}]


DEFAULT_MARKERS_JSON = json.dumps(default_markers(), separators=(",", ":"))


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


def parse_markers(markers, length: int) -> tuple[list[dict], list[str]]:
    """标记的 frame 是窗口内相对帧；id 是跨时间轴移动也不会变的身份。"""
    notes = []
    items = []
    if isinstance(markers, str) and markers.strip():
        try:
            items = json.loads(markers)
        except json.JSONDecodeError as error:
            raise ValueError(f"编辑帧标记不是合法 JSON：{error}") from error
    elif isinstance(markers, list):
        items = markers
    if not items:
        items = default_markers()
    seen, ids, out = set(), set(), []
    for item in items:
        frame = int(item["frame"] if isinstance(item, dict) else item)
        clamped = min(max(0, frame), length - 1)
        if clamped != frame:
            notes.append(f"编辑帧 {frame + 1} 已移入窗口内的第 {clamped + 1} 帧。")
        if clamped in seen:
            replacement = next((k for d in range(1, length) for k in (clamped + d, clamped - d)
                                if 0 <= k < length and k not in seen), clamped)
            if replacement != clamped:
                notes.append(f"编辑帧 {clamped + 1} 已移到第 {replacement + 1} 帧，以保留两个标记。")
                clamped = replacement
        seen.add(clamped)
        identity = item.get("id") if isinstance(item, dict) else None
        if not isinstance(identity, int) or isinstance(identity, bool) or identity < 1 or identity in ids:
            identity = next(i for i in range(1, len(items) + 2) if i not in ids)
        ids.add(identity)
        edited = str(item.get("edited") or "") if isinstance(item, dict) else ""
        edited_at = item.get("edited_at") if isinstance(item, dict) else None
        entry = {"id": identity, "frame": clamped, "edited": edited,
                 "edited_at": int(edited_at) if isinstance(edited_at, (int, float)) and edited else None}
        if isinstance(item, dict) and item.get("edited_crop") is not None:
            entry["edited_crop"] = normalized_crop(item["edited_crop"])
        if isinstance(item, dict) and isinstance(item.get("edited_source"), dict):
            entry["edited_source"] = {key: str(item["edited_source"].get(key, "")) for key in ("video", "version")}
        out.append(entry)
    out.sort(key=lambda marker: marker["frame"])
    return out, notes


def stale_markers(markers: list[dict], window_start: int, crop=None, source=None, version=None) -> list[int]:
    """编辑图对应的是当时那一帧；窗口、裁剪或源片变了就必须提示重做。"""
    return [m["frame"] for m in markers if m.get("edited") and
            ((m.get("edited_at") is not None and m["edited_at"] != window_start + m["frame"])
             or (crop is not None and m.get("edited_crop") is not None
                 and normalized_crop(m["edited_crop"]) != normalized_crop(crop))
             or (source is not None and m.get("edited_source") is not None
                  and (m["edited_source"].get("video") != source
                       or (version is not None and m["edited_source"].get("version") != version))))]


def timecode(seconds: float) -> str:
    minutes, rest = divmod(max(0.0, seconds), 60)
    return f"{int(minutes):02d}:{rest:05.2f}"


def describe(start: int, length: int, edit) -> str:
    frames = [edit] if isinstance(edit, int) else list(edit)
    where = ", ".join(str(frame + 1) for frame in frames)
    return (f"{timecode((start + frames[0]) / FPS)} · 第 {where} 帧 / 共 {length} 帧 · 窗口 "
            f"{timecode(start / FPS)}–{timecode((start + length) / FPS)}（{length / FPS:.2f} 秒）")


def _structure(images: np.ndarray, size: int = 48) -> np.ndarray:
    """只比布局（边缘），不比颜色，这样改色/换风格的编辑图仍能认出来源帧。"""
    images = np.asarray(images, dtype=np.float32)
    if images.ndim == 3:
        images = images[None]
    count, height, width = images.shape[:3]
    grey = images[..., :3] @ np.array([0.299, 0.587, 0.114], dtype=np.float32)
    ys = (np.arange(size) * height // size).clip(0, height - 1)
    xs = (np.arange(size) * width // size).clip(0, width - 1)
    small = np.stack([
        np.add.reduceat(np.add.reduceat(frame, np.r_[ys, height][:-1], axis=0), np.r_[xs, width][:-1], axis=1)
        for frame in grey
    ])
    gy = np.abs(np.diff(small, axis=1))[:, :, :-1]
    gx = np.abs(np.diff(small, axis=2))[:, :-1, :]
    maps = (gx + gy).reshape(count, -1)
    maps -= maps.mean(axis=1, keepdims=True)
    maps /= np.linalg.norm(maps, axis=1, keepdims=True) + 1e-6
    return maps


def match_edited_frame(window: np.ndarray, edited: np.ndarray, edit_frame: int) -> dict:
    """判断上传的编辑图是否真的来自它声称的那一帧。"""
    maps = _structure(window)
    target = _structure(edited)[0]
    scores = maps @ target
    best = int(scores.argmax())
    at_edit = float(scores[edit_frame])
    spread = float(scores.max() - np.median(scores))
    if abs(best - edit_frame) <= 2 or scores[best] - at_edit < 0.05:
        verdict = "ok"
    elif scores[best] > 0.5 and spread > 0.08:
        verdict = "mismatch"
    else:
        verdict = "unclear"
    identical = bool(np.abs(np.asarray(window[edit_frame], np.float32) - np.asarray(edited, np.float32)).mean() < 1 / 255)
    return {"score": at_edit, "best": best, "best_score": float(scores[best]), "verdict": verdict, "unchanged": identical}


def aspect_note(edited_size: tuple[int, int], canvas: tuple[int, int]) -> str | None:
    ew, eh = edited_size
    cw, ch = canvas
    if abs((ew / eh) / (cw / ch) - 1) > 0.05:
        return f"编辑图为 {ew}x{eh}，已整张缩放进该帧的 {cw}x{ch} 内容区。"
    return None
