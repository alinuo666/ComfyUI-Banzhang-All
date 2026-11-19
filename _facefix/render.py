# -*- coding: utf-8 -*-
"""🪞 人脸修复台新内核（MaskVid 式）：稳定裁剪 → 整段重渲染 → 羽化贴回。

取代旧「拼贴画布 + 高频残差」内核（refine.py 已归档）。旧内核的问题是
几何环节太多：逐脸框平滑（仍逐帧跟随）→ 逐帧拼格 → 逐格贴回 + 残差治理链
（亮度投影/块匹配光流/纹理加权/软钳制），任何一环抖动都进成片。

新内核把裁剪几何整段交给 MaskVid 线性规划器（core/banzhang_subject_redraw_planner）：
  1) SAM3 逐脸框 → 每帧并成一个矩形主体遮罩
  2) tracked 规划：恒定尺寸裁剪框整段联合求解 —— 遮罩抖动/丢帧/遮挡框不动，
     只有持续运动才最小移动；脸部在裁剪序列里不再逐帧缩放
  3) 裁剪序列放大到目标像素量 → VAE 编码 → H3 低降噪重渲染（保留区上下文环带
     每步被 KSamplerX0Inpaint 混回原 latent，低频/身份锁死）
  4) 解码 → 按脸区遮罩羽化贴回原帧（MaskVid Uncrop 方式）
"""

import numpy as np
import torch
import torch.nn.functional as F

from ..core import banzhang_subject_redraw_planner as planner
from ..core.banzhang_subject_redraw_core import plan_and_crop, uncrop
from ..core.banzhang_mask_to_latent import mask_to_latent

from . import inpaint

_DEBUG_DIR = None  # 占位：调试图目录在 _save_debug 里惰性取


def _save_debug(img, name):
    """把 [H,W,3] 0-1 张量存成 PNG：确诊「错位发生在采样还是贴回」的唯一手段。"""
    import os
    try:
        import cv2
        out_dir = os.path.join(os.path.dirname(os.path.dirname(
            os.path.abspath(__file__))), "_selftest_out", "facefix_debug")
        os.makedirs(out_dir, exist_ok=True)
        arr = (img.detach().clamp(0.0, 1.0).cpu().numpy() * 255.0).astype(np.uint8)
        cv2.imwrite(os.path.join(out_dir, name),
                    cv2.cvtColor(arr, cv2.COLOR_RGB2BGR))
    except Exception:
        pass


def union_face_mask(faces, T, H, W):
    """每帧把所有脸的框并成一个矩形遮罩 [T,H,W] float。

    矩形遮罩的非零范围 = 脸框本身，规划器的 extent 提取与逐帧并集框完全一致；
    某帧全部脸丢失时留零 —— 规划器把缺口当 NaN 插值（不追抖），贴回时该帧
    遮罩为 0、原样不动。
    """
    mask = np.zeros((T, H, W), dtype=np.float32)
    for f in faces:
        boxes = f.get("boxes") or []
        for t in range(min(T, len(boxes))):
            b = boxes[t]
            if b is None:
                continue
            x1 = max(0, int(np.floor(b[0])))
            y1 = max(0, int(np.floor(b[1])))
            x2 = min(W, int(np.ceil(b[2])))
            y2 = min(H, int(np.ceil(b[3])))
            if x2 > x1 and y2 > y1:
                mask[t, y1:y2, x1:x2] = 1.0
    return torch.from_numpy(mask)


def _encode_sample_decode(images_crop, model, positive, vae, dm, steps, denoise, log):
    """裁剪序列 → H3 重渲染。返回与输入同帧数的像素序列 [T,ch,cw,3]。

    帧对齐/哑音频/解码尺寸护栏沿用旧 refine 的验证过的管线骨架；
    帧数补齐只在尾部（因果 VAE 解码帧与输入帧逐帧对应）。
    """
    device = torch.device("cpu")
    import comfy.model_management as mg
    device = mg.get_torch_device()

    seq = images_crop
    n_src = int(seq.shape[0])
    try:
        from comfy_extras.nodes_minimax_h3 import (
            align_frame_count, temporal_shape)
        fc = int(align_frame_count(max(5, n_src)))
        if fc > n_src:
            seq = torch.cat(
                [seq, seq[-1:].expand(fc - n_src, -1, -1, -1)], dim=0)
        _fc, _exp_t, a_len = temporal_shape(fc)
    except ImportError:
        _exp_t = None
        a_len = max(1, int(round(n_src * 40.0 / 25.0)))

    latent = vae.encode(seq[..., :3])
    if latent.ndim == 4:
        latent = latent.unsqueeze(0).movedim(1, 2)
    latent = latent.to(device=device, dtype=torch.float32)
    if _exp_t is not None and int(latent.shape[2]) != int(_exp_t):
        lt = int(latent.shape[2])
        if lt > _exp_t:
            latent = latent[..., :_exp_t, :, :]
        else:
            pad = latent[..., :1, :, :].expand(-1, -1, _exp_t - lt, -1, -1)
            latent = torch.cat([latent, pad], dim=2)

    # H3 forward 里 audio_src = x[1]，必须喂「视频+音频」双流；哑音频只用来
    # 满足 pack/layout，采完只取回视频流。
    import comfy.nested_tensor
    dummy_audio = torch.zeros(1, 32, 2, a_len, device=device, dtype=torch.float32)
    latent_av = comfy.nested_tensor.NestedTensor((latent, dummy_audio))

    # 重绘掩码：按 VAE 真实几何降到 latent 分辨率（H3 的 1,4,4,4,4 帧循环
    # 分组 + 2x2 token 块内 max），与模型实际读写区严格一致——替代旧版
    # 「均匀分组 + nearest 拉伸」的近似。先按补帧后的序列长度补齐遮罩
    # （编码吃的就是补齐后的帧），再降采样；脸缺席的帧组 max=0 不放开重绘。
    if int(dm.shape[0]) < n_seq:
        dm = torch.cat([dm, dm[-1:].expand(n_seq - int(dm.shape[0]), -1, -1)],
                       dim=0)
    dm_lat = mask_to_latent(dm, vae)                 # [L,lh,lw]
    T_lat = int(latent.shape[2])
    lh, lw = int(latent.shape[-2]), int(latent.shape[-1])
    if (int(dm_lat.shape[-2]), int(dm_lat.shape[-1])) != (lh, lw):
        dm_lat = F.interpolate(dm_lat[:, None], size=(lh, lw),
                               mode="nearest-exact")[:, 0]
    L = int(dm_lat.shape[0])
    if L > T_lat:
        dm_lat = dm_lat[:T_lat]
    elif L < T_lat:
        pad = dm_lat[-1:].expand(T_lat - L, -1, -1)
        dm_lat = torch.cat([dm_lat, pad], dim=0)
    dm_nested = dm_lat[None, None]

    res = inpaint.sample_inpaint(
        model, positive, {"samples": latent_av}, dm_nested,
        steps=steps, denoise=denoise, seed=0)
    res_samples = res["samples"]
    if getattr(res_samples, "is_nested", False):
        res_video = list(res_samples.unbind())[0]
    else:
        res_video = res_samples
    pixels = vae.decode(res_video)
    if pixels.ndim == 5:
        pixels = pixels.movedim(1, -1) if pixels.shape[-1] not in (1, 3) \
            else pixels[0]
    pixels = pixels.clamp(0.0, 1.0).float().cpu()

    # 尺寸护栏：解码尺寸与裁剪尺寸不一致时拉回，否则贴回必然 shape 冲突
    ch, cw = int(images_crop.shape[1]), int(images_crop.shape[2])
    if pixels.ndim == 4 and (int(pixels.shape[1]), int(pixels.shape[2])) != (ch, cw):
        pixels = F.interpolate(
            pixels.permute(0, 3, 1, 2), size=(ch, cw),
            mode="bilinear", align_corners=False).permute(0, 2, 3, 1)
    elif pixels.ndim == 5 and (int(pixels.shape[2]), int(pixels.shape[3])) != (ch, cw):
        b, t, h, w, c = pixels.shape
        pixels = F.interpolate(
            pixels.reshape(b * t, h, w, c).permute(0, 3, 1, 2),
            size=(ch, cw), mode="bilinear", align_corners=False
        ).permute(0, 2, 3, 1).reshape(b, t, ch, cw, c)
    n_out = int(pixels.shape[0] if pixels.ndim == 4 else pixels.shape[1])

    _save_debug(images_crop[0], "crop_in_first.png")
    _save_debug(pixels[0] if pixels.ndim == 4 else pixels[0, 0], "crop_out_first.png")
    _mid = min(n_seq, n_out) // 2
    _save_debug(images_crop[_mid], "crop_in_mid.png")
    _save_debug(pixels[_mid] if pixels.ndim == 4 else pixels[0, _mid], "crop_out_mid.png")

    # 帧对齐：n_out ≥ T 时取前 T 帧 1:1 对齐；只有解码丢帧才按比例兜底
    T = int(images_crop.shape[0])
    if n_out >= T:
        sampled = pixels[:T]
    else:
        idx = [min(n_out - 1, int(round(i * (n_out - 1) / float(max(1, T - 1)))))
               for i in range(T)]
        sampled = pixels[idx]
        log.append("⚠️ 解码 %d 帧 ≠ 成片 %d 帧，已按比例对齐" % (n_out, T))
    return sampled


def execute(images, faces, model, positive, vae,
            crop_mode="tracked", crop_scale=1.4, megapixels=1.0,
            steps=6, denoise=0.3, feather=24, log=None):
    """新内核主入口。返回 (修好的帧 [T,H,W,3], info dict)。

    info 含 plan_report（规划简报）/ boxes 摘要 / log（逐行证据）。
    """
    T, H, W = int(images.shape[0]), int(images.shape[1]), int(images.shape[2])
    info = {"log": log if log is not None else []}
    log = info["log"]

    mask = union_face_mask(faces, T, H, W)
    crop_frames, crop_masks, boxes, plan_report = plan_and_crop(
        images, mask, crop_mode, crop_scale, 0.0, 16,
        megapixels, "auto")
    info["plan_report"] = plan_report

    sampled = _encode_sample_decode(
        crop_frames, model, positive, vae, crop_masks, steps, denoise, log)

    # 按脸区遮罩羽化贴回：遮罩外原帧逐位保留，遮罩内 = 重渲染结果
    out = uncrop(images, sampled, boxes, crop_masks, feather)

    log.insert(0, "裁剪序列 %s → 重渲染 → 贴回（脸区遮罩约束）"
               % "x".join(str(v) for v in sampled.shape[1:3]))
    return out, info
