"""Depth Pro 2 推理引擎：模型类变量缓存 + 单图/视频统一推理。

底层张量处理（加载/前处理/输出）复用同目录 _upstream.py 里已验证的函数，
本文件只做装配，不重复造轮子。
"""
from __future__ import annotations

import torch
import comfy.model_management as mm
from comfy.utils import ProgressBar

from ._upstream import load_depthpro2, _prepare_frames, _depth_outputs, _focal_mm_to_px

# 模型放类变量缓存，按 (模型名, 精度) 隔离：同一组合全会话只加载一次。
_MODEL_CACHE: dict[tuple[str, str], dict] = {}


def get_model(model: str, precision: str) -> dict:
    """取缓存模型；未命中才加载（禁止每次执行重新加载）。"""
    key = (model, precision)
    if key not in _MODEL_CACHE:
        _MODEL_CACHE[key] = load_depthpro2(model, precision, "auto")
    return _MODEL_CACHE[key]


def estimate(images, model_bundle, focal_mm, focal_px, max_size, video_mode, window, overlap):
    """单图/视频统一推理，返回 (灰度图, 米制深度, 焦距像素, 天空遮罩)。"""
    net, device = model_bundle["model"], model_bundle["device"]
    f_px = focal_px or _focal_mm_to_px(focal_mm, *images.shape[1:3])
    frames, focal, scale = _prepare_frames(images, device, max_size, f_px)
    progress = ProgressBar(len(frames))
    predictions = []
    with torch.no_grad():
        if video_mode:
            for pred in net.infer_video(
                iter(frames), window=window, overlap=overlap, f_px=focal, mode="buffered"
            ):
                predictions.append(pred)
                progress.update(1)
        else:
            for frame in frames:
                predictions.append(net.infer(frame, f_px=focal))
                progress.update(1)
    mm.soft_empty_cache()
    image, depth, focal_out, sky = _depth_outputs(predictions, tuple(images.shape[1:3]), scale)
    if video_mode:
        image = _steady_color(images, depth)
    return image, depth, focal_out, sky


def _steady_color(images, depth):
    """视频模式：全批次统一色标，帧间亮度不闪。"""
    finite = torch.isfinite(depth) & (depth > 0)
    if not finite.any():
        return torch.zeros((*images.shape[1:3], 3), dtype=torch.float32)
    inverse = 1.0 / depth.clamp(min=1e-6)
    inverse[~finite] = 0.0
    lo, hi = inverse[finite].min(), inverse[finite].max()
    if hi <= lo:
        return torch.zeros((*images.shape[1:3], 3), dtype=torch.float32)
    return ((inverse - lo) / (hi - lo)).clamp(0, 1).unsqueeze(-1).repeat(1, 1, 1, 3)
