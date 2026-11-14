# -*- coding: utf-8 -*-
"""涟漪编辑：读视频、抽 24fps 网格帧、取音轨、导出单帧 PNG。

抽帧口径必须和 js/banzhang_ripple_timeline.mjs 的 seekTime 完全一致，
否则时间轴上看到的帧和下载的锚点帧不是同一张。
"""

from __future__ import annotations

import io as _bytes_io
import itertools
import math
import os
import time
from pathlib import Path

import av
import numpy as np
import torch
import torch.nn.functional as F
from PIL import Image, ImageOps

from . import banzhang_ripple_core as rc

VIDEO_EXTENSIONS = {".mp4", ".webm", ".mkv", ".mov", ".avi", ".m4v", ".gif"}
_list_cache: dict = {}
_info_cache: dict = {}


def _input_root() -> Path:
    import folder_paths

    return Path(folder_paths.get_input_directory()).resolve()


def list_videos() -> list[str]:
    """输入目录下的视频相对路径。缓存几秒，避免每次排队都扫盘。"""
    root = str(_input_root())
    now = time.monotonic()
    cached = _list_cache.get(root)
    if cached and now - cached[0] < 3.0:
        return list(cached[1])
    found, pending = [], [("", root)]
    while pending:
        prefix, folder = pending.pop()
        try:
            entries = os.scandir(folder)
        except OSError:
            continue
        with entries as items:
            for entry in items:
                if entry.name.startswith("."):
                    continue
                relative = f"{prefix}{entry.name}"
                if entry.is_dir(follow_symlinks=False):
                    pending.append((f"{relative}/", entry.path))
                elif Path(entry.name).suffix.lower() in VIDEO_EXTENSIONS:
                    found.append(relative)
    found.sort()
    _list_cache[root] = (now, found)
    return found or [""]


def video_path(video: str) -> Path:
    import folder_paths

    root = _input_root()
    path = Path(folder_paths.get_annotated_filepath(video)).resolve()
    if not path.is_relative_to(root):
        raise ValueError("视频必须放在 ComfyUI 的 input 文件夹内。")
    if path.suffix.lower() not in VIDEO_EXTENSIONS or not path.is_file():
        raise ValueError(f"找不到视频或格式不支持：{video}")
    return path


def probe(path: Path) -> dict:
    """时长、旋转后尺寸、原始帧率、首帧时间与 24fps 网格总帧数。"""
    stat = path.stat()
    key = (str(path), stat.st_size, stat.st_mtime_ns)
    if key in _info_cache:
        return dict(_info_cache[key])
    with av.open(str(path)) as container:
        if not container.streams.video:
            raise ValueError("这个文件没有视频流。")
        stream = container.streams.video[0]
        rate = stream.average_rate or stream.guessed_rate
        if not rate:
            raise ValueError("读不到视频帧率。")
        start = (stream.start_time or 0) * stream.time_base
        if stream.duration:
            duration = float(stream.duration * stream.time_base)
        elif container.duration:
            duration = container.duration / av.time_base
        else:
            duration = (stream.frames or 0) / float(rate)
        first = next(container.decode(stream), None)
        width, height, rotation, first_time = stream.width, stream.height, 0, 0.0
        if first is not None:
            width, height, rotation = first.width, first.height, first.rotation
            if first.pts is not None:
                first_time = float(first.pts * first.time_base - start)
        if rotation % 180:
            width, height = height, width
    info = {
        "width": int(width), "height": int(height), "rotation": int(rotation), "fps": float(rate),
        "duration": float(duration), "first_time": first_time,
        "grid_frames": rc.grid_frame_count(max(0.0, duration - first_time)),
        "audio": None,
        # 版本令牌让缩略图缓存随源文件变化自动失效。
        "version": f"{stat.st_size:x}-{stat.st_mtime_ns:x}",
    }
    with av.open(str(path)) as container:
        info["audio"] = bool(container.streams.audio)
    if len(_info_cache) > 64:
        _info_cache.clear()
    _info_cache[key] = info
    return dict(info)


def transform_pixels(pixels: np.ndarray, geometry: dict) -> np.ndarray:
    """先裁剪缩放再补边，窗口帧一次性转换完再进内存，避免逐帧重复算。"""
    x, y, w, h = geometry["source_rect"]
    left, top, cw, ch = geometry["content_rect"]
    filters = {"lanczos": Image.Resampling.LANCZOS, "bicubic": Image.Resampling.BICUBIC,
               "bilinear": Image.Resampling.BILINEAR, "nearest-exact": Image.Resampling.NEAREST,
               "area": Image.Resampling.BOX}
    image = Image.fromarray(np.ascontiguousarray(pixels[y:y + h, x:x + w]))
    content = np.asarray(image.resize((cw, ch), filters[geometry["resize_method"]]))
    return np.pad(content, ((top, geometry["height"] - ch - top),
                            (left, geometry["width"] - cw - left), (0, 0)), mode="edge")


def trim_content(images: torch.Tensor, geometry: dict | None) -> torch.Tensor:
    x, y, w, h = geometry["content_rect"]
    return images[:, y:y + h, x:x + w].clone()


def edit_to_canvas(images: torch.Tensor, geometry: dict) -> torch.Tensor:
    """导出的编辑图已带裁剪，只需缩放并补回模型画布的边，不能二次裁剪。"""
    import comfy.utils

    left, top, cw, ch = geometry["content_rect"]
    content = images[..., :3].movedim(-1, 1)
    if images.shape[1:3] != (ch, cw):
        content = comfy.utils.common_upscale(content, cw, ch, geometry["resize_method"], "disabled")
    return F.pad(content, (left, geometry["width"] - cw - left, top, geometry["height"] - ch - top),
                 mode="replicate").movedim(1, -1).clamp(0, 1)


def decode_grid_window(path: Path, start: int, length: int, geometry=None) -> tuple[np.ndarray, float]:
    """取 24fps 网格的第 start..start+length-1 帧，返回 uint8 [N,H,W,3] 与窗口起始秒。"""
    with av.open(str(path)) as container:
        stream = container.streams.video[0]
        stream.thread_type = "AUTO"
        tb = stream.time_base
        stream_start = (stream.start_time or 0) * tb
        first_pts = None
        for frame in container.decode(stream):
            first_pts = frame.pts
            break
        if first_pts is None:
            raise ValueError("视频没有可解码的帧。")
        seek_seconds = start / rc.FPS - 1.0
        container.seek(0, stream=stream) if seek_seconds <= 0 else container.seek(
            max(0, math.floor((stream_start + seek_seconds) / tb)), stream=stream, backward=True
        )
        graph = None
        frames: list[np.ndarray] = []
        rotation = 0
        for frame in itertools.chain(container.decode(stream), (None,)):
            if frame is not None:
                if frame.pts is None:
                    raise ValueError("视频帧缺少时间戳。")
                rotation = frame.rotation
            if graph is None:
                if frame is None:
                    break
                graph = av.filter.Graph()
                graph.link_nodes(
                    graph.add_buffer(width=frame.width, height=frame.height, format=frame.format, time_base=frame.time_base),
                    graph.add("setpts", f"PTS-{first_pts}"),
                    graph.add("fps", f"fps={rc.FPS}:start_time=0:round=near"),
                    graph.add("buffersink"),
                )
                graph.configure()
            graph.push(frame)
            while len(frames) < length:
                try:
                    out = graph.pull()
                except (av.error.BlockingIOError, av.error.EOFError):
                    break
                index = int(out.pts)
                if index < start:
                    continue
                pixels = out.to_ndarray(format="rgb24")
                if rotation:
                    pixels = np.rot90(pixels, rotation // 90)
                if geometry is not None:
                    pixels = transform_pixels(pixels, geometry)
                frames.append(np.ascontiguousarray(pixels))
            if len(frames) >= length:
                break
    if not frames:
        raise ValueError(f"24fps 网格第 {start} 帧之后没有画面，窗口已越过片尾。")
    window_time = float((first_pts * tb - stream_start)) + start / rc.FPS
    return np.stack(frames), window_time


def decode_audio(path: Path, start_seconds: float, duration: float) -> dict | None:
    with av.open(str(path)) as container:
        if not container.streams.audio:
            return None
        stream = container.streams.audio[0]
        rate = stream.codec_context.sample_rate
        channels = stream.codec_context.channels
        stream_start = float((stream.start_time or 0) * stream.time_base)
        first, count = round((start_seconds + stream_start) * rate), round(duration * rate)
        waveform = np.zeros((channels, count), dtype=np.float32)
        resampler = av.AudioResampler(format="fltp", layout=stream.codec_context.layout, rate=rate)
        if start_seconds > 0.5:
            container.seek(int((stream_start + start_seconds - 0.5) / stream.time_base), stream=stream, backward=True)
        for frame in itertools.chain(container.decode(stream), (None,)):
            for samples in resampler.resample(frame):
                if samples.pts is None:
                    continue
                offset = round(samples.pts * samples.time_base * rate) - first
                if offset >= count:
                    return {"waveform": torch.from_numpy(waveform).unsqueeze(0), "sample_rate": rate}
                lo, hi = max(0, offset), min(count, offset + samples.samples)
                if hi > lo:
                    waveform[:, lo:hi] = samples.to_ndarray()[:, lo - offset:hi - offset]
        return {"waveform": torch.from_numpy(waveform).unsqueeze(0), "sample_rate": rate}


def load_input_image(relative: str) -> torch.Tensor:
    """上传的编辑图只允许落在 input 目录内，防止路径穿越。"""
    root = _input_root()
    path = (root / relative).resolve()
    if not path.is_relative_to(root) or not path.is_file():
        raise ValueError(f"找不到已上传的编辑图：{relative}")
    with Image.open(path) as image:
        image = ImageOps.exif_transpose(image).convert("RGB")
        return torch.from_numpy(np.asarray(image, dtype=np.float32) / 255.0)[None]


def frame_png(video: str, absolute_frame: int, megapixels=rc.DEFAULT_MEGAPIXELS, crop="", allow_upscale=False,
              resize_method="lanczos", output_width=0, output_height=0) -> tuple[bytes, str]:
    """给时间轴卡片用的单帧 PNG，必须与 Clip 输出的内容区逐像素一致。"""
    path = video_path(video)
    info = probe(path)
    absolute_frame = min(max(0, int(absolute_frame)), max(0, info["grid_frames"] - 1))
    geometry = rc.geometry(info["width"], info["height"], megapixels, crop, allow_upscale,
                           resize_method, output_width, output_height)
    frames, _ = decode_grid_window(path, absolute_frame, 1, geometry)
    image = trim_content(torch.from_numpy(frames[:1]).float().div_(255), geometry)[0]
    buffer = _bytes_io.BytesIO()
    Image.fromarray((image.clamp(0, 1).numpy() * 255).round().astype(np.uint8)).save(buffer, format="PNG")
    return buffer.getvalue(), f"{Path(video).stem}_f{absolute_frame:05d}.png"


def query_geometry(query) -> dict:
    return {"megapixels": float(query.get("megapixels", rc.DEFAULT_MEGAPIXELS)),
            "crop": query.get("crop", ""),
            "allow_upscale": str(query.get("allow_upscale", "false")).lower() in ("1", "true", "yes"),
            "resize_method": query.get("resize_method", "lanczos"),
            "output_width": int(query.get("output_width", 0)), "output_height": int(query.get("output_height", 0))}
