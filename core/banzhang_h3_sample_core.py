# -*- coding: utf-8 -*-
"""H3 采样准备共用层：帧网格对齐、视频编码、AV 打包、参考图条件。

三个 H3 相关节点共用（🧬 AV打包 / 🎯 H3 参考图条件 / 🎯 H3 角色替换采样），
逻辑只写一遍。关键事实（均已在本机源码查实）：
- H3 forward 必须吃 NestedTensor(视频[1,24,T,h,w], 音频[1,32,2,T40]) 双流；
- 像素帧对齐 17k+5 网格（align_frame_count），latent 帧数 = video_latent_t(fc)；
- 参考图条件 = clip.tokenize(minimax_ref_items) + conditioning_set_values
  ({"minimax_refs"})，参考块每步重注入（从不去噪），所以身份稳。
"""

import math
import re

import torch
import comfy.utils
import node_helpers

from comfy_extras.nodes_minimax_h3 import (
    AUDIO_LATENT_FPS, CANVAS_MULTIPLE, FPS, REF_IMAGE_SHORT_EDGE,
    align_frame_count, video_latent_t)

try:
    from comfy.nested_tensor import NestedTensor
except Exception:
    NestedTensor = None

_MULT = CANVAS_MULTIPLE


def _round32(v):
    return max(_MULT, round(v / _MULT) * _MULT)


# tokenizer 只认英文标签 <Picture N> / <Video N>；中文写法（<图片1>/<视频1>）会被当
# 普通文字，参考项和提示词就对不上号。这里自动纠偏。
_CN_TAG_RE = re.compile(r"<\s*(?:图片|图像|图)\s*0?(\d+)\s*>")
_CN_VIDEO_TAG_RE = re.compile(r"<\s*视频\s*0?(\d+)\s*>")


def fix_cn_ref_tags(prompt):
    """中文参考标签自动改为官方英文标签（<Picture N> / <Video N>）。
    返回 (纠正后的提示词, 纠正数量)。"""
    prompt, n1 = _CN_TAG_RE.subn(r"<Picture \1>", prompt)
    prompt, n2 = _CN_VIDEO_TAG_RE.subn(r"<Video \1>", prompt)
    return prompt, n1 + n2


# ---- 视频口取帧与尺寸对齐 --------------------------------------------------

_BASE_SHORT = 768
_MAX_AREA = 768 * 1344


def _adapt_canvas(w, h):
    """官方同款画布适配：短边贴 768、总面积不超 768x1344、宽高对齐 32。
    把用户视频的任意尺寸贴到模型最合适的画布。"""
    ratio = w / h
    if ratio >= 1.0:
        nom_w, nom_h = _BASE_SHORT * ratio, _BASE_SHORT
    else:
        nom_w, nom_h = _BASE_SHORT, _BASE_SHORT / ratio
    if nom_w * nom_h > _MAX_AREA:
        s = math.sqrt(_MAX_AREA / (nom_w * nom_h))
        nom_w, nom_h = nom_w * s, nom_h * s
    return _round32(nom_w), _round32(nom_h)


def resolve_input_frames(原始帧=None, 视频=None):
    """「原始帧」与「视频」两口二选一。视频口自动取画面轨
    （video.get_components()，官方 Video Components 节点同款）。"""
    if 原始帧 is not None:
        return 原始帧
    if 视频 is not None:
        comps = 视频.get_components()
        frames = comps.images
        if frames is None or int(frames.shape[0]) == 0:
            raise ValueError("视频里没有画面轨，无法用于替换")
        return frames
    raise ValueError("「原始帧」与「视频」至少接一个")


def fit_frames_and_mask(frames, mask, 尺寸对齐):
    """帧与遮罩同步缩放到目标画布（遮罩来自 SAM3，跟视频同尺寸，必须一起缩）。
    自动对齐 = 官方画布适配；跟随视频 = 保留原尺寸仅对齐 32 网格。
    返回 (帧, 遮罩, 目标宽, 目标高)。"""
    T, H, W, C = int(frames.shape[0]), int(frames.shape[1]), int(frames.shape[2]), 3
    if str(尺寸对齐).startswith("自动"):
        tw, th = _adapt_canvas(W, H)
    else:
        tw, th = max(_MULT, _round32(W)), max(_MULT, _round32(H))
    if (tw, th) != (W, H):
        frames = comfy.utils.common_upscale(
            frames.movedim(-1, 1), tw, th, "lanczos", "disabled").movedim(1, -1)
        if mask is not None:
            mask = comfy.utils.common_upscale(
                mask[:, None], tw, th, "nearest-exact", "disabled")[:, 0]
    return frames, mask, tw, th


def _require_nested():
    if NestedTensor is None:
        raise RuntimeError("当前 ComfyUI 没有 comfy.nested_tensor，无法打包 H3 AV latent")


def align_pixel_frames(frames):
    """像素帧补齐到 17k+5 网格（尾部重复末帧，因果 VAE 解码帧与输入 1:1 对应）。
    返回 (补齐后帧, fc)。编码前对齐比编码后补 latent 更稳（引擎同款）。"""
    T = int(frames.shape[0])
    fc = align_frame_count(max(5, T))
    if fc > T:
        frames = torch.cat([frames, frames[-1:].expand(fc - T, -1, -1, -1)], dim=0)
    return frames, fc


def encode_video(frames, vae):
    """像素帧 → 视频 latent [1,24,T,h,w]（设备上 float32）。"""
    import comfy.model_management as mg
    device = mg.get_torch_device()
    latent = vae.encode(frames[..., :3])
    if latent.ndim == 4:
        latent = latent.unsqueeze(0).movedim(1, 2)
    return latent.to(device=device, dtype=torch.float32), device


def build_av(video, fc):
    """视频 latent → 补/裁到网格 latent 帧数 → 包哑音频双流。
    返回 (latent dict, T_lat)。"""
    _require_nested()
    exp_t = int(video_latent_t(fc))
    T_lat = int(video.shape[2])
    if exp_t > T_lat:
        pad = video[:, :, -1:].expand(-1, -1, exp_t - T_lat, -1, -1)
        video = torch.cat([video, pad], dim=2)
    elif exp_t < T_lat:
        video = video[:, :, :exp_t]
    a_len = max(1, round(fc / 24.0 * AUDIO_LATENT_FPS))
    audio = torch.zeros(1, 32, 2, a_len, device=video.device, dtype=torch.float32)
    return {"samples": NestedTensor((video, audio))}, int(video.shape[2])


def _infer_frames(T_lat):
    """从 latent 帧数反推像素帧数：网格上（5k+2）精确反推，否则按平均估。"""
    if T_lat >= 2 and (T_lat - 2) % 5 == 0:
        return 17 * ((T_lat - 2) // 5) + 5
    return max(5, round(T_lat * 17 / 5))


def pack_video_only(latent, n_src):
    """纯视频单流 latent → AV 嵌套（含帧网格补齐与掩码归一）。
    🧬 H3 AV打包 节点的执行体；掩码保持单流，采样器自动给音频流补全 1。"""
    _require_nested()
    samples = latent.get("samples")
    if getattr(samples, "is_nested", False):
        return (latent,)                      # 已是 AV，幂等直通
    video = samples.detach().to(dtype=torch.float32)
    if video.ndim == 4:
        video = video[None]
    T_lat = int(video.shape[2])

    n = int(n_src) if int(n_src) > 0 else _infer_frames(T_lat)
    fc = align_frame_count(max(5, n))
    exp_t = video_latent_t(fc)

    mask = latent.get("noise_mask")
    if mask is not None and getattr(mask, "is_nested", False):
        mask = list(mask.unbind())[0]
    if mask is not None:
        mask = mask.detach().float().cpu().reshape(
            -1, mask.shape[-2], mask.shape[-1])[None, None]
        T_m = int(mask.shape[2])
        if T_m == 1:
            mask = mask.expand(-1, -1, exp_t, -1, -1)
        elif T_m < exp_t:
            pad = mask[:, :, -1:].expand(-1, -1, exp_t - T_m, -1, -1)
            mask = torch.cat([mask, pad], dim=2)
        elif T_m > exp_t:
            mask = mask[:, :, :exp_t]

    if exp_t > T_lat:
        pad = video[:, :, -1:].expand(-1, -1, exp_t - T_lat, -1, -1)
        video = torch.cat([video, pad], dim=2)
    elif exp_t < T_lat:
        video = video[:, :, :exp_t]

    a_len = max(1, round(fc / 24.0 * AUDIO_LATENT_FPS))
    audio = torch.zeros(1, 32, 2, a_len, device=video.device, dtype=torch.float32)

    out = dict(latent)
    out["samples"] = NestedTensor((video, audio))
    if mask is not None:
        out["noise_mask"] = mask
    else:
        out.pop("noise_mask", None)
    return (out,)


def build_image_ref_conditioning(clip, vae, images, prompt, use_max, w_px, h_px,
                                 ref_videos=None, ref_video_long=0,
                                 frame_count=0):
    """参考图列表 + 可选参考视频列表 → 带参考条件的正条件。images 里 None 项跳过。
    参考"只缩不放"：max 档按 2048 短边上限，match 档对齐目标画布面积；
    参考块尺寸对齐 32 网格，与下游画布同源时永不尺寸炸。
    参考视频（官方 ref_videos 同款）：画布适配 → 超长裁到主片帧数 →
    尾部对齐 17k+5 网格 → VAE 全量编码 + 按 2fps 抽帧给 Qwen 看。
    参考视频尺寸：0 = 官方自动适配（比画布小的视频保留原尺寸）；
    >0 = 按最长边缩放到这个值（宽高比不变，自动对齐 32 网格）。"""
    ref_items, ref_blocks = [], []
    for img in images:
        if img is None:
            continue
        h, w = int(img.shape[1]), int(img.shape[2])
        if use_max:
            scale = min(1.0, REF_IMAGE_SHORT_EDGE / min(w, h))
        else:
            scale = min(1.0, math.sqrt((w_px * h_px) / max(1, w * h)))
        tw, th = _round32(w * scale), _round32(h * scale)
        resized = comfy.utils.common_upscale(
            img[:1].movedim(-1, 1), tw, th, "lanczos", "disabled").movedim(1, -1)
        ref_items.append({"type": "image", "data": resized})
        z = vae.encode(resized)
        ref_blocks.append({"kind": "image", "latent_h": th // 16,
                           "latent_w": tw // 16, "latent": z})
    for frames in (ref_videos or []):
        if frames is None:
            continue
        vh, vw = int(frames.shape[1]), int(frames.shape[2])
        cw, ch = _adapt_canvas(vw, vh)
        if vw * vh < cw * ch:
            cw, ch = _round32(vw), _round32(vh)      # 比画布小的视频保留自己尺寸
        if int(ref_video_long) > 0:                  # 手动：按最长边缩放，宽高比不变
            scale = int(ref_video_long) / max(vw, vh)
            cw = _round32(vw * scale)
            ch = _round32(vh * scale)
        if (int(vw), int(vh)) != (cw, ch):
            frames = comfy.utils.common_upscale(
                frames.movedim(-1, 1), cw, ch, "lanczos", "disabled").movedim(1, -1)
        if frame_count > 0 and int(frames.shape[0]) > frame_count:
            frames = frames[:frame_count]            # 参考视频不比主片长
        n = int(frames.shape[0])
        if n < 5:
            raise ValueError("参考视频至少需要 5 帧（约 0.2 秒 @24fps）")
        while n % 17 != 5:                           # 尾部对齐 17k+5 网格（官方同款）
            n -= 1
            frames = frames[:n]
        sample_idx = list(range(0, n, FPS // 2))     # Qwen 按 2fps 看参考视频
        ref_items.append({"type": "video", "data": frames[sample_idx],
                          "timestamps": [i / 2.0 for i in range(len(sample_idx))]})
        z = vae.encode(frames)
        ref_blocks.append({"kind": "video", "latent_t": int(z.shape[2]),
                           "latent_h": ch // 16, "latent_w": cw // 16,
                           "ref_audio_t": 0,   # 参考视频只取画面轨：新版官方布局按这个键给参考音频占时
                           "latent": z})
    tokens = clip.tokenize(prompt, minimax_ref_items=ref_items)
    cond = clip.encode_from_tokens_scheduled(tokens)
    if ref_blocks:
        cond = node_helpers.conditioning_set_values(cond, {"minimax_refs": ref_blocks})
    return cond, len(ref_blocks)
