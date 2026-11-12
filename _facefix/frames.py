# -*- coding: utf-8 -*-
"""检测帧准备：VAE 内部解码关键帧 + 人脸缩略图裁剪编码。

不接外部检测帧时，用节点自带 VAE 解码一采 latent 的视频成员，均匀抽取关键帧
供检测器使用；检测后为每个身份 track 裁剪一张代表脸，编码成 data URI 供面板
缩略图网格展示。全程 try 保护，缺 VAE / 解码失败安全返回 None，不炸主管线。
"""

import base64

import torch

MAX_DETECT_FRAMES = 12
THUMB_SIZE = 96


def decode_keyframes(vae, h3_latent, max_frames=MAX_DETECT_FRAMES):
    """VAE 解码 latent 视频并均匀抽帧，返回 IMAGE [N,H,W,3] 0-1；失败返回 None。"""
    if vae is None or not isinstance(h3_latent, dict) or "samples" not in h3_latent:
        return None
    try:
        samples = h3_latent["samples"]
        if getattr(samples, "is_nested", False):
            video = list(samples.unbind())[0]
        else:
            video = samples
        out = vae.decode(video)
        # [B,C,T,H,W] → [B,T,H,W,C]
        if out.ndim == 5 and out.shape[-1] not in (1, 3):
            out = out.movedim(1, -1)
        total = out.shape[1]
        if total <= max_frames:
            frames = out[0]
        else:
            idx = torch.linspace(0, total - 1, max_frames).long()
            frames = out[0][idx]
        return frames.clamp(0.0, 1.0)
    except Exception:
        return None


def make_thumb(frame_rgb_u8, box, size=THUMB_SIZE):
    """裁剪人脸框并缩到 size×size，返回 data URI base64 PNG；失败返回 None。"""
    try:
        import cv2
        h, w = frame_rgb_u8.shape[:2]
        x1, y1, x2, y2 = [int(round(v)) for v in box]
        x1 = max(0, min(x1, w - 1))
        x2 = max(x1 + 1, min(x2, w))
        y1 = max(0, min(y1, h - 1))
        y2 = max(y1 + 1, min(y2, h))
        crop = frame_rgb_u8[y1:y2, x1:x2]
        if crop.size == 0:
            return None
        crop = cv2.resize(crop, (size, size), interpolation=cv2.INTER_AREA)
        ok, buf = cv2.imencode(".png", cv2.cvtColor(crop, cv2.COLOR_RGB2BGR))
        if not ok:
            return None
        b64 = base64.b64encode(buf.tobytes()).decode("ascii")
        return "data:image/png;base64," + b64
    except Exception:
        return None
