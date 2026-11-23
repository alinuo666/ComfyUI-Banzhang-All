# -*- coding: utf-8 -*-
"""🪞 人脸修复台新内核（MaskVid 式）：稳定裁剪 → 整段重渲染 → 羽化贴回。

取代旧「拼贴画布 + 高频残差」内核（refine.py 已归档）。旧内核的问题是
几何环节太多：逐脸框平滑（仍逐帧跟随）→ 逐帧拼格 → 逐格贴回 + 残差治理链
（亮度投影/块匹配光流/纹理加权/软钳制），任何一环抖动都进成片。

新内核把裁剪几何整段交给 MaskVid 线性规划器（core/banzhang_subject_redraw_planner）：
  1) SAM3 保留逐帧人脸分割并集，框只用于人物预览
  2) tracked 规划：恒定尺寸裁剪框整段联合求解 —— 遮罩抖动/丢帧/遮挡框不动，
     只有持续运动才最小移动；脸部在裁剪序列里不再逐帧缩放
  3) 裁剪序列放大到目标像素量 → VAE 编码 → H3 低降噪重渲染（保留区上下文环带
     每步被 KSamplerX0Inpaint 混回原 latent，保留遮罩外上下文）
  4) 解码 → 按分割遮罩和裁剪边界羽化贴回原帧（MaskVid Uncrop 方式）
"""

import time

import torch
import torch.nn.functional as F

from ..core.banzhang_subject_redraw_core import plan_and_crop, uncrop
from ..core.banzhang_mask_to_latent import mask_to_latent

from . import inpaint, preview

_DEBUG_DIR = None  # 占位：调试图目录在 _save_debug 里惰性取

# [逐步预览档位] 采样每一步解几格、长边多大。导演台那条链是全解（实测 72 格
# → TAE 314 毫秒 + WebP 755 毫秒），本节点裁剪序列常有 90+ 格，全解一档更贵；
# 抽 24 格按比例 ≈ 110 毫秒解码 + 260 毫秒编码，4 步合计 <1 秒（整轮约十分钟，0.2%）。
PREVIEW_STEP_FRAMES = 24
PREVIEW_STEP_RES = 480


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


def _encode_sample_decode(images_crop, model, positive, vae, dm, steps, denoise, log,
                          node_id=None, seg_sec=0.0):
    """裁剪序列 → H3 重渲染。返回与输入同帧数的像素序列 [T,ch,cw,3]。

    帧对齐/哑音频/解码尺寸护栏沿用旧 refine 的验证过的管线骨架；
    帧数补齐只在尾部（因果 VAE 解码帧与输入帧逐帧对应）。

    node_id 非空时顺带做两件事：每个阶段往前端推进度字幕；给模型装
    「H3 预览覆盖」让每一步都有一段循环动画（见 preview.py / 预览覆盖节点）。
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
    # 补帧后的序列长度：遮罩补齐与调试取帧都以它为准（编码吃的就是补齐后的帧）
    n_seq = int(seq.shape[0])

    preview.stage(node_id, "VAE 编码裁剪序列")
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

    # [运行时逐步动画] 装「H3 预览覆盖」——与导演台内置预览同一个实现：
    # 每一步采样后用官方 MiniMax-H3-TAE 小解码器解出 PREVIEW_STEP_FRAMES 格，
    # 交给后台线程编成动画（NVENC 可用则 MP4，否则 animated WebP）广播给面板。
    # 只允许 tiny 解码器是那个模块写死的规矩：每步跑完整 VAE 会在 DiT 常驻显存时炸。
    preview.stage(node_id, "局部重绘采样")
    if node_id:
        try:
            from ..nodes.banzhang_mmh3_preview import apply_h3_preview_override
            model = apply_h3_preview_override(
                model, str(node_id),
                max_resolution=PREVIEW_STEP_RES, jpeg_quality=60,
                suppress_default_preview=False,
                preview_frames=PREVIEW_STEP_FRAMES, lite_animation=True,
                segment_seconds=seg_sec)
            log.append("逐步动画预览已装（H3 TAE %d 格/步，长边 %d）"
                       % (PREVIEW_STEP_FRAMES, PREVIEW_STEP_RES))
        except Exception as exc:
            log.append("逐步动画预览未挂上（不影响出片）：%s" % str(exc)[:80])

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
        if pixels.shape[-1] not in (1, 3):
            pixels = pixels.movedim(1, -1)
        pixels = pixels[0]
    pixels = pixels.clamp(0.0, 1.0).float()

    # 尺寸护栏：解码尺寸与裁剪尺寸不一致时拉回，否则贴回必然 shape 冲突
    ch, cw = int(images_crop.shape[1]), int(images_crop.shape[2])
    if pixels.ndim == 4 and (int(pixels.shape[1]), int(pixels.shape[2])) != (ch, cw):
        pixels = F.interpolate(
            pixels.permute(0, 3, 1, 2), size=(ch, cw),
            mode="bilinear", align_corners=False).permute(0, 2, 3, 1)
    n_out = int(pixels.shape[0])

    _save_debug(images_crop[0], "crop_in_first.png")
    _save_debug(pixels[0], "crop_out_first.png")
    _mid = min(n_src, n_out) // 2
    _save_debug(images_crop[_mid], "crop_in_mid.png")
    _save_debug(pixels[_mid], "crop_out_mid.png")

    # 只裁掉因果 VAE 的尾部补帧；缺帧不能按比例拉伸，否则五官运动会错帧。
    T = int(images_crop.shape[0])
    if n_out >= T:
        sampled = pixels[:T]
    else:
        raise ValueError("解码仅 %d 帧，少于输入 %d 帧，拒绝错帧贴回" % (n_out, T))
    return sampled


def execute(images, faces, model, positive, vae,
            crop_mode="tracked", crop_scale=1.4, megapixels=0.5,
            steps=4, denoise=0.3, feather=8, log=None,
            node_id=None, seg_sec=0.0, crop_padding=None, crop_long_edge=None, frame_masks=None):
    """新内核主入口。返回 (修好的帧 [T,H,W,3], info dict)。

    info 含 plan_report（规划简报）/ boxes 摘要 / log（逐行证据）。
    node_id / seg_sec 只服务预览（进度字幕 + 逐步动画），为空时全流程一字不变。
    """
    T, H, W = int(images.shape[0]), int(images.shape[1]), int(images.shape[2])
    info = {"log": log if log is not None else []}
    log = info["log"]

    preview.stage(node_id, "规划稳定裁剪框")
    if frame_masks is None or tuple(frame_masks.shape) != (T, H, W):
        raise ValueError("缺少与原片逐帧对齐的 SAM3 分割遮罩")
    mask = frame_masks.to(device="cpu", dtype=torch.float32)
    crop_frames, crop_masks, boxes, plan_report = plan_and_crop(
        images, mask, crop_mode, crop_scale, 0.0, 16,
        megapixels, "auto", crop_padding=crop_padding, long_edge=crop_long_edge)
    info["plan_report"] = plan_report
    if crop_padding is not None and crop_padding >= 0:
        log.append("裁剪外扩 %d px/边" % crop_padding)
    if crop_long_edge is not None and crop_long_edge >= 0:
        log.append("目标长边 %d px，实际裁剪 %d×%d" %
                   (crop_long_edge, crop_frames.shape[2], crop_frames.shape[1]))
    # 把原片脸框映射到采样裁剪画布；前端逐脸播放每步解码的动画。
    layout = []
    for face in faces:
        regions = []
        for t, b in enumerate(face.get("boxes", [])[:T]):
            if b is None:
                regions.append(None)
                continue
            crop = boxes[t][0]
            regions.append([(b[0] - crop["x"]) / crop["width"],
                            (b[1] - crop["y"]) / crop["height"],
                            (b[2] - crop["x"]) / crop["width"],
                            (b[3] - crop["y"]) / crop["height"]])
        layout.append({"index": int(face["index"]), "regions": regions})
    preview._send(node_id, {"kind": "layout", "faces": layout,
                            "duration": float(seg_sec or T / 24)})

    sampled = _encode_sample_decode(
        crop_frames, model, positive, vae, crop_masks, steps, denoise, log,
        node_id=node_id, seg_sec=seg_sec)

    import comfy.model_management as mg
    device = mg.get_torch_device()
    preview.stage(node_id, "羽化贴回原帧")
    start = time.perf_counter()
    out = uncrop(images, sampled, boxes, crop_masks, feather, "auto")
    if device.type == "cuda":
        torch.cuda.synchronize(device)
    log.append("MaskVid 坐标贴回与边缘合成：%s，%.2f 秒" % (device, time.perf_counter() - start))

    log.insert(0, "裁剪序列 %s → 重渲染 → 贴回（脸区遮罩约束）"
               % "x".join(str(v) for v in sampled.shape[1:3]))
    return out, info
