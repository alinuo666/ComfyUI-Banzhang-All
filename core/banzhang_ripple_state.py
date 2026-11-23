# -*- coding: utf-8 -*-
"""涟漪编辑：三个节点共用的端口约定、控件定义与复用缓存。"""

from __future__ import annotations

import json
import weakref

import torch

from . import banzhang_ripple_core as rc
from . import banzhang_ripple_video as vd

# 「涟漪数据」不再是独立输出口：整包挂进官方 VIDEO 的内部属性，随 🎬 视频口传给
# 应用编辑 / 输出成片。属性名全包唯一，避免与核心 VIDEO 自带字段撞名。
RIPPLE_ATTR = "_banzhang_ripple"
CATEGORY = "👨‍🏫班长/MiniMax H3"


def make_ripple_video(content, fps, audio, ripple: dict):
    """把内容区帧包成官方 VIDEO（与核心 CreateVideo 同构造），挂上涟漪数据后返回。"""
    content = content.detach().cpu()
    if not content.is_contiguous():   # 裁剪出来的窗口帧常是切片视图，编码链路要求连续内存
        content = content.contiguous()
    try:
        from .banzhang_dlss5_fg_media import _video_from_components
        video, _ = _video_from_components(content, fps, audio)
    except Exception as error:
        raise ValueError(f"构造官方 VIDEO 对象失败：{error}") from error
    if video is None:
        raise ValueError("当前 ComfyUI 版本没有 VIDEO 类型，请升级 ComfyUI 后再使用涟漪。")
    setattr(video, RIPPLE_ATTR, ripple)
    return video


def unwrap_ripple(ripple):
    """从 🎬 视频口取回涟漪数据字典；误接普通 VIDEO 时给出中文提示。"""
    data = getattr(ripple, RIPPLE_ATTR, None)
    if not isinstance(data, dict) or "window" not in data or "geometry" not in data:
        raise ValueError("「🎬 视频」口必须接「H3 涟漪 · 时间轴选段」的视频输出口；普通 VIDEO 里没有涟漪数据。")
    return data


def framing_inputs() -> dict:
    return {
        "crop": ("STRING", {"default": "", "tooltip": "归一化裁剪框 [x, y, 宽, 高]，留空为整幅画面。"}),
        "allow_upscale": ("BOOLEAN", {"default": False, "tooltip": "允许把裁剪后的画面放大。"}),
        "resize_method": (list(rc.RESIZE_METHODS), {"default": "lanczos", "tooltip": "缩放算法，默认 Lanczos 画质最好。"}),
        "output_width": ("INT", {"default": 0, "min": 0, "max": 16384, "step": 32,
                                 "tooltip": "适配宽度上限，需与高度同时填写；留 0 则按百万像素计算。"}),
        "output_height": ("INT", {"default": 0, "min": 0, "max": 16384, "step": 32,
                                  "tooltip": "适配高度上限，需与宽度同时填写；留 0 则按百万像素计算。"}),
    }


def _weak(obj):
    try:
        return weakref.ref(obj)
    except TypeError:
        return None


def _same(ref, obj) -> bool:
    return ref is not None and ref() is obj


# 每类缓存只留最近一项；用弱引用持有模型，避免阻止显存释放。
_window_cache: dict = {}
_prompt_cache: dict = {}
_source_cache: dict = {}


def load_window(path, info: dict, start: int, length: int, geometry: dict) -> dict:
    """重跑同一窗口时不重复解码；键里带源文件时间戳与几何参数。"""
    stat = path.stat()
    key = (str(path), stat.st_size, stat.st_mtime_ns, start, length, json.dumps(geometry, sort_keys=True))
    if _window_cache.get("key") == key:
        return _window_cache["value"]
    frames, window_time = vd.decode_grid_window(path, start, length, geometry)
    notes = []
    if len(frames) < length:
        shorter = 17 * ((len(frames) - 5) // 17) + 5
        if shorter < 5:
            raise ValueError(f"第 {start} 帧起只解出 {len(frames)} 帧，H3 至少需要 5 帧。")
        notes.append(f"此处只解出 {len(frames)} 帧，已改用 {shorter} 帧。")
        frames, length = frames[:shorter], shorter
    window = torch.from_numpy(frames).float().div_(255)
    audio = vd.decode_audio(path, window_time, length / rc.FPS) if info.get("audio") else None
    value = {"window": window, "length": length, "window_time": window_time, "audio": audio, "notes": notes,
             "key": key}
    _window_cache.clear()
    _window_cache.update(key=key, value=value)
    return value


def encode_prompt(clip, prompt: str):
    if _same(_prompt_cache.get("clip"), clip) and _prompt_cache.get("prompt") == prompt:
        return _prompt_cache["value"]
    value = clip.encode_from_tokens_scheduled(clip.tokenize(prompt))
    _prompt_cache.clear()
    _prompt_cache.update(clip=_weak(clip), prompt=prompt, value=value)
    return value


def encode_source(vae, ripple: dict):
    key = ripple.get("window_key")
    if key is not None and _same(_source_cache.get("vae"), vae) and _source_cache.get("key") == key:
        return _source_cache["value"]
    value = vae.encode(ripple["window"][..., :3])
    _source_cache.clear()
    _source_cache.update(vae=_weak(vae), key=key, value=value)
    return value
