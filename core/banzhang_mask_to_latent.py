# -*- coding: utf-8 -*-
"""像素遮罩 → latent 分辨率遮罩（按 VAE 真实几何降采样）。

移植自 drozbay/MaskVidExperiments 的 nodes_mask_to_latent.py（GPLv3,
Copyright (C) 2026 drozbay），只保留几何求解与降采样核心，砍掉 grow/
preview 等外围。为什么不用 ComfyUI 自带路径：Set Latent Noise Mask 的
遮罩在采样器内部被 trilinear 拉伸，与因果 VAE 的帧分组（H3 的
1,4,4,4,4 循环）和 token 网格（H3 DiT 按 2x2 latent 像素读遮罩）对不齐，
边缘渗色、半帧漏遮罩都从这里来。本模块按 VAE 报告的真实几何做 max 降采样，
遮罩与模型实际读写区严格一致。

用法：mask_to_latent(masks[T,H,W], vae) → [L,lh,lw]，直接当
noise_mask / Set Latent Noise Mask 的输入。
"""

import math

import torch
import torch.nn.functional as F


_TEMPORAL_REDUCE = {
    "max": lambda g: g.amax(0),
    "min": lambda g: g.amin(0),
    "mean": lambda g: g.mean(0),
    "first": lambda g: g[0],
    "last": lambda g: g[-1],
}

# VAE 读不出几何时的兜底：班长全家桶的 H3 默认（spatial 16、循环 1,4,4,4,4、
# 2x2 token）。宁可给默认也别抛错——错一点会被采样器的拉伸兜住，抛错则全断。
_H3_FALLBACK = {"spatial": 16, "pattern": [1, 4, 4, 4, 4], "drop": 0, "token": 2}


def _token_snap(x, token, method):
    """把每个 token 块（token×token 个 latent 像素）统一成一个值，
    奇数边缘按模型的 replicate 方式补齐。H3 的 DiT 按整块 token 读遮罩。"""
    t, h, w = x.shape
    x = F.pad(x[:, None], (0, -w % token, 0, -h % token), mode="replicate")
    if method == "max":
        x = F.max_pool2d(x, token)
    elif method == "min":
        x = -F.max_pool2d(-x, token)
    elif method == "mean":
        x = F.avg_pool2d(x, token)
    else:
        x = F.interpolate(x, (x.shape[-2] // token, x.shape[-1] // token),
                          mode="nearest-exact")
    x = x.repeat_interleave(token, dim=-2).repeat_interleave(token, dim=-1)
    return x[:, 0, :h, :w]


def _pattern_starts(pattern):
    starts = [0]
    for p in pattern:
        starts.append(starts[-1] + p)
    return starts


def _pattern_groups(pattern, t, drop=0):
    """按精确循环（从第 0 帧起）给出每个 latent 帧覆盖的像素帧区间。
    正 drop 建模「补齐整块再砍掉尾部若干 latent」的编码器（MiniMax H3）：
    被砍 latent 覆盖的帧并入最后一个保留组，完全落在补齐段的组覆盖末帧。"""
    starts = _pattern_starts(pattern)
    chunk, n = starts[-1], len(pattern)
    total = n * math.ceil(t / chunk)
    if drop > 0:
        kept = max(1, total - drop)
    else:
        kept = sum(1 for k in range(total)
                   if (k // n) * chunk + starts[k % n] < t)
    groups = []
    for k in range(kept):
        s = (k // n) * chunk + starts[k % n]
        groups.append((min(s, t - 1), min(s + pattern[k % n], t)))
    if drop > 0:
        groups[-1] = (groups[-1][0], t)
    return groups


def _manual_frame_formula(head_frames, head_latents, chunk_frames, chunk_latents):
    """头组 + 重复组的网格上：前 t 个像素帧产生多少 latent 帧。
    不满一块的尾段不产出新 latent 帧（与分块编码器一致）。"""
    def formula(t):
        if head_frames > 0 and t <= head_frames:
            return max(1, math.ceil(t * head_latents / head_frames))
        return head_latents + (t - head_frames) // chunk_frames * chunk_latents
    return formula


def _temporal_groups(formula, t):
    """通用路径：公式每完成 d 个新 latent 帧，期间的像素帧均分给它们；
    产出不满一帧的尾帧并入最后一组，覆盖不丢。"""
    groups = []
    prev_t = 0
    prev_l = 0
    for tp in range(1, t + 1):
        latents = formula(tp)
        if latents <= prev_l:
            continue
        d = latents - prev_l
        span = tp - prev_t
        for j in range(d):
            s = prev_t + round(j * span / d)
            e = prev_t + round((j + 1) * span / d)
            if e > s:
                groups.append((s, e))
        prev_t = tp
        prev_l = latents
    if not groups:
        return [(0, t)]
    if prev_t < t:
        groups[-1] = (groups[-1][0], t)
    return groups


def _resolve_geometry(vae):
    """从 VAE 读 (spatial, groups_fn, token, chunk_latents)。
    分块因果编码器（MiniMax H3）把 vae_ratio_t / tokens_chunk_size 挂在
    first_stage_model 上，auto 由此推出精确帧循环；该家族 token=2。
    读不出 → H3 默认兜底。"""
    spatial = 8
    try:
        if vae is not None:
            spatial = int(vae.spacial_compression_encode())
            inner = getattr(vae, "first_stage_model", None)
            ratio_t = getattr(inner, "vae_ratio_t", None)
            chunk_latents = getattr(inner, "tokens_chunk_size", None)
            if ratio_t is not None and chunk_latents is not None and ratio_t > 1:
                pre_pad = getattr(inner, "frame_pre_padding", 0)
                drop = getattr(inner, "token_drop", 0) or 0
                pattern = [ratio_t - pre_pad] + [ratio_t] * (chunk_latents - 1)
                if max(pattern) == 1 and drop == 0:
                    return spatial, None, 1, None
                return (spatial,
                        lambda t: _pattern_groups(pattern, t, drop),
                        2, chunk_latents)
            temporal = vae.temporal_compression_decode()
            if temporal is None or int(temporal) <= 1:
                return spatial, None, 1, None
            formula = _manual_frame_formula(1, 1, int(temporal), 1)
            return (spatial,
                    lambda t: _temporal_groups(formula, t), 1, None)
    except Exception:
        pass
    fb = _H3_FALLBACK
    return (fb["spatial"],
            lambda t: _pattern_groups(fb["pattern"], t, fb["drop"]),
            fb["token"], len(fb["pattern"]))


def _reduce(x, spatial, groups, token, spatial_method="max", temporal_method="max"):
    """空间降采样 → token 统一 → 按帧分组时间降采样，返回 [L,lh,lw]。"""
    t, h, w = x.shape
    lh = max(1, h // spatial)
    lw = max(1, w // spatial)
    x = x[:, None]
    if spatial_method == "max":
        x = F.adaptive_max_pool2d(x, (lh, lw))
    elif spatial_method == "min":
        x = -F.adaptive_max_pool2d(-x, (lh, lw))
    elif spatial_method == "mean":
        x = F.adaptive_avg_pool2d(x, (lh, lw))
    else:
        x = F.interpolate(x, (lh, lw), mode="nearest-exact")
    x = x[:, 0]

    if token > 1:
        x = _token_snap(x, token, spatial_method)

    if groups is None or t <= 1:
        return x
    if callable(groups):                    # 几何求解器：传入帧数求分组
        groups = groups(t)
    fn = _TEMPORAL_REDUCE.get(temporal_method, _TEMPORAL_REDUCE["max"])
    return torch.stack([fn(x[s:e]) for s, e in groups])


def mask_to_latent(masks, vae=None, spatial_method="max", temporal_method="max"):
    """主入口。[T,H,W] 像素遮罩 → [L,lh,lw] latent 分辨率遮罩。

    vae 接编码用的同一个 VAE（auto 读精确几何，H3 含帧循环与 2x2 token）；
    读不出或没接时用 H3 默认几何兜底。max 语义 = 一组里任何一帧/任一像素
    有遮罩就整组标记，重绘范围不漏。
    """
    spatial, groups, token, _ = _resolve_geometry(vae)
    x = masks.detach().float().cpu()
    return _reduce(x, spatial, groups, token, spatial_method, temporal_method)
