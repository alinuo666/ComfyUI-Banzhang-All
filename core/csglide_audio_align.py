# -*- coding: utf-8 -*-
"""音画按帧对齐（纯函数，不是节点）。

旧行为只把音频尾部截到画面长度，音频短于画面时留下静音缺口；采样率直取
源值不重采样，编码侧再 -ar 会二次换算。这里一次做完：
  重采样 → 按 n_frames/fps*target_sr 算目标采样数 → 短补零 / 长截断。
"""
from __future__ import annotations

import os
from typing import Any, Dict, Tuple

import numpy as np


def target_samples(n_frames: int, fps: float, sample_rate: int) -> int:
    if int(n_frames) <= 0 or float(fps) <= 0 or int(sample_rate) <= 0:
        return 0
    return int(round(int(n_frames) / float(fps) * int(sample_rate)))


def effective_target_sr(src_sr: int) -> int:
    """默认跟随源采样率；BZ_AUDIO_TARGET_SR=48000 可强制统一重采样。"""
    forced = os.environ.get("BZ_AUDIO_TARGET_SR", "").strip()
    if forced.isdigit() and int(forced) >= 8000:
        return int(forced)
    return int(src_sr)


def resample_wave(wave: np.ndarray, src_sr: int, dst_sr: int) -> np.ndarray:
    """[C,T] float32 线性重采样；纯 numpy，不依赖 torchaudio。"""
    if int(src_sr) == int(dst_sr) or wave.shape[1] == 0:
        return wave
    n_out = max(1, int(round(wave.shape[1] * float(dst_sr) / float(src_sr))))
    old = np.linspace(0.0, 1.0, num=wave.shape[1], dtype=np.float64)
    new = np.linspace(0.0, 1.0, num=n_out, dtype=np.float64)
    return np.stack([np.interp(new, old, ch).astype(np.float32)
                     for ch in wave], axis=0)


def align_audio(wave: Any, src_sr: int, n_frames: int, fps: float,
                target_sr: int = None) -> Tuple[np.ndarray, int, Dict[str, Any]]:
    """返回 (pcm int16 [C,T], 输出采样率, 报告字典)。"""
    src_sr = int(src_sr)
    out_sr = int(target_sr) if target_sr else effective_target_sr(src_sr)
    data = np.asarray(wave, dtype=np.float32)
    if data.ndim == 1:
        data = data[None, :]
    data = resample_wave(data, src_sr, out_sr)
    got = int(data.shape[1])
    want = target_samples(n_frames, fps, out_sr)
    action = "keep"
    if want > 0:
        if got < want:
            data = np.pad(data, ((0, 0), (0, want - got)), mode="constant")
            action = "pad"
        elif got > want:
            data = data[:, :want]
            action = "trim"
    pcm = (np.clip(data, -1.0, 1.0) * 32767.0).astype(np.int16)
    return pcm, out_sr, {
        "src_sr": src_sr, "out_sr": out_sr, "src_samples": got,
        "target_samples": want, "action": action,
        "video_seconds": (int(n_frames) / float(fps)) if fps else 0.0,
    }
