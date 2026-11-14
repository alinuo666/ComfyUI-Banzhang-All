# -*- coding: utf-8 -*-
"""图片版多级渐进采样引擎（SelfLift-zero 的多级推广）。

上游 _selflift_avatar/ 的 progressive_sample 固定两级：低清前段 → 一次放大 → 高清后段。
本文件把"只换一次纸"推广成"按分段步数逐级换纸"，只面向 4 维图片潜空间：

  每到一个分段边界：
    1. 取上一级最后一步的干净预测（论文 Eq.3 的 x0）；
    2. 走 Artifact-Aware Consistency Lift（直接插值 + 像素-VAE 锚点修正，Eqs.4-9）
       抬到下一级网格；
    3. 按边界 sigma 重新加噪，复用该步的 Euler 区间（不额外花一次模型前向）；
    4. 进入下一级继续采样。

总模型前向次数（NFE）恒等于「分段步数」之和。上游代码一行不动，
本文件只调用其工具函数（paired_lifts / artifact_aware_consistency_lift /
_validate_sampling / _validate_schedule / _euler_step）与遮罩助手。
"""

import logging

import torch

import comfy.model_management
import comfy.sample
import comfy.samplers
import comfy.utils
import latent_preview

from ._selflift_avatar import avatar_masks
from ._selflift_avatar import selflift as _slf
from ._selflift_avatar.avatar_sampling import native_mask_model
from ._selflift_avatar.nodes import _euler_step, _validate_sampling, _validate_schedule
from .nodes.banzhang_selflift import _suggest_split

_TAG = "🎯 SelfLift 图片多级渐进"


def _build_stage_plan(segs, ratios, H, W):
    """按每级步数与级间倍率算出每级网格。

    segs: 每级步数列表（至少两级，每级 ≥ 1）；ratios: None = 自动（每级长宽翻倍），
    或 1 个 / n-1 个倍率值（必须大于 1）。网格从最终画布自顶向下推（与上游
    单级版同口径）：最后一级恒为 (H, W)，前面每级四舍五入到偶数、最小 2。
    返回 (grids, ratios)。
    """
    if len(segs) < 2:
        raise ValueError(
            f"{_TAG}：「分段步数」必填且至少两级，例如 6,14（两级）或 6,6,8（三级）")
    if any(s < 1 for s in segs):
        raise ValueError(f"{_TAG}：「分段步数」每级至少 1 步")
    n = len(segs)

    if ratios:
        if len(ratios) != 1 and len(ratios) != n - 1:
            raise ValueError(
                f"{_TAG}：「级间倍率」应填 1 个值，或填 {n - 1} 个值（{n} 级）；"
                f"当前填了 {len(ratios)} 个")
        if any(r <= 1.0 for r in ratios):
            raise ValueError(f"{_TAG}：「级间倍率」必须大于 1.0")
        if len(ratios) == 1:
            ratios = list(ratios) * (n - 1)
    else:
        # 留空 = 自动：每级长宽各翻倍（与论文单级口径 lowres_scale=0.5 一致）
        ratios = [2.0] * (n - 1)

    scales = [1.0] * n
    for i in range(n - 2, -1, -1):
        scales[i] = scales[i + 1] / ratios[i]
    # 中间级网格四舍五入到偶数、最小 2（与上游单级版同口径）；
    # 最后一级必须精确等于画布本身，不能参与舍入（奇数尺寸会舍成画布+1）
    grids = [(max(2, round(H * s / 2) * 2), max(2, round(W * s / 2) * 2)) for s in scales[:-1]]
    grids.append((H, W))

    for i in range(n - 1):
        if not (grids[i][0] < grids[i + 1][0] and grids[i][1] < grids[i + 1][1]):
            raise ValueError(
                f"{_TAG}：第 {i + 1} 级网格 {grids[i]} 没有小于第 {i + 2} 级网格 {grids[i + 1]} —— "
                f"画布太小或级数太多。请减少级数（删掉「分段步数」里的一个数）、"
                f"加大「级间倍率」或加大画布。")
    return grids, ratios


def progressive_sample_multistage(model, positive, negative, vae, latent_image,
                                  sampler, sigmas, seed, cfg, segments, ratios,
                                  rho, w_min=0.5, w_max=1.0, latent_upsample="nearest",
                                  model_hires=None):
    """图片模型多级渐进采样主循环。

    segments / ratios 均为调用方解析好的列表（ratios 传 None 走自动倍率）。
    """
    model_sampling = model.get_model_object("model_sampling")
    _validate_sampling(model_sampling, sampler)

    raw = latent_image["samples"]
    if getattr(raw, "is_nested", False):
        raise ValueError(
            f"{_TAG}：本节点只支持普通图片潜空间；音视频双流请用 🎯 H3 渐进采样器")
    samples = comfy.sample.fix_empty_latent_channels(
        model, raw, latent_image.get("downscale_ratio_spacial", None),
        latent_image.get("downscale_ratio_temporal", None))
    if samples.ndim != 4:
        raise ValueError(
            f"{_TAG}：本节点只支持图片潜空间（4 维）；视频模型请用 🎯 SelfLift 多级渐进")

    _, _, H, W = samples.shape
    segs = list(segments)
    grids, ratios = _build_stage_plan(segs, ratios, H, W)
    total_steps = sum(segs)

    got_steps = sigmas.numel() - 1
    if got_steps != total_steps:
        suggestion = ",".join(str(x) for x in _suggest_split(got_steps, len(segs)))
        raise ValueError(
            f"{_TAG}：「分段步数」合计 {total_steps} 步，与采样日程的 {got_steps} 步不一致。\n"
            f"可把「分段步数」改成 \"{suggestion}\"；或不接 sigmas、按分段步数自动生成日程。")
    boundaries = []
    acc = 0
    for s in segs[:-1]:
        acc += s
        boundaries.append(acc)
        _validate_schedule(sigmas, acc)

    if not 0.0 <= rho <= 1.0:
        raise ValueError(f"{_TAG}：「像素锚点修正比例」必须在 0 ~ 1 之间")
    if not 0.0 <= w_min <= w_max <= 1.0:
        raise ValueError(f"{_TAG}：修正强度必须满足 0 ≤ 下限 ≤ 上限 ≤ 1")

    noise_masks = avatar_masks.normalize_masks(latent_image.get("noise_mask"), [samples])
    m_full = noise_masks[0] if noise_masks is not None else None

    logging.info("[%s] 分段计划：%s ｜ 级间倍率 %s ｜ 锚点修正 %.2f ｜ CFG %.2f ｜ 遮罩=%s",
                 _TAG,
                 " → ".join(f"{s}步@{g[0]}x{g[1]}" for s, g in zip(segs, grids)),
                 ratios, rho, cfg, "无" if m_full is None else "有")

    device = comfy.model_management.intermediate_device()
    source = samples.to(device)
    latent_format = model.get_model_object("latent_format")
    callback = latent_preview.prepare_callback(model, total_steps)
    disable_pbar = not comfy.utils.PROGRESS_BAR_ENABLED
    # 每级抬升的两条路是否要算：与上游单级版同一套裁剪规则
    need_pix = rho > 0.0 and w_max > 0.0
    need_lat = not (rho >= 1.0 and w_min >= 1.0 and w_max >= 1.0)
    # 最后一级（满分辨率收尾）可换模型；前面各级恒用主模型
    stage_bases = [model] * (len(segs) - 1) + [model_hires if model_hires is not None else model]

    resume_latent = None
    done_evals = 0
    acc = 0
    out = None

    for i, seg in enumerate(segs):
        h_i, w_i = grids[i]
        logging.info("[%s] 第 %d/%d 级开始：%d 步 @ %dx%d", _TAG, i + 1, len(segs), seg, h_i, w_i)
        grid_latent = source if (h_i, w_i) == (H, W) else torch.nn.functional.interpolate(
            source.float(), size=(h_i, w_i), mode="bilinear", align_corners=False
        ).to(dtype=source.dtype)
        m_i = avatar_masks.resize_spatial(m_full, (h_i, w_i)) if m_full is not None else None
        stage_model = native_mask_model(stage_bases[i], [grid_latent],
                                        [m_i] if m_i is not None else None, False)

        chunk = sigmas[acc: acc + seg + 1]
        stage_evals = 0
        captured = {}

        def stage_cb(step, x0, x, total_, _seg=seg, _is_not_last=(i < len(segs) - 1), _idx=i):
            nonlocal stage_evals, done_evals
            stage_evals += 1
            if stage_evals > _seg:
                raise RuntimeError(
                    f"{_TAG}：第 {_idx + 1} 级回调次数超出预期；采样器必须是标准 euler")
            if _is_not_last and stage_evals == _seg:
                captured["state"] = x
                captured["x0"] = x0
            # 预览统一抬到最终网格（只影响预览，不参与结果）
            preview = x0
            if x0.ndim == 4 and (x0.shape[-2] != H or x0.shape[-1] != W):
                preview = torch.nn.functional.interpolate(
                    x0.float(), size=(H, W), mode="bilinear", align_corners=False
                ).to(x0.dtype)
            done_evals += 1
            return callback(done_evals - 1, preview, preview, total_steps)

        if i == 0:
            noise = comfy.sample.prepare_noise(grid_latent, seed,
                                               latent_image.get("batch_index", None))
            latent_arg = grid_latent
        else:
            noise = torch.zeros_like(grid_latent)
            latent_arg = resume_latent

        out = comfy.samplers.sample(stage_model, noise, positive, negative, cfg,
                                    stage_model.load_device, sampler, chunk,
                                    stage_model.model_options, latent_image=latent_arg,
                                    callback=stage_cb, disable_pbar=disable_pbar, seed=seed)
        if stage_evals != seg:
            raise RuntimeError(
                f"{_TAG}：第 {i + 1} 级应跑 {seg} 步，实际 {stage_evals} 步；"
                f"采样器必须是标准 euler（s_churn=0）")
        acc += seg
        if i == len(segs) - 1:
            break

        # ---------- 过渡：抬到下一级网格 ----------
        h_next, w_next = grids[i + 1]
        sigma_k = sigmas[acc - 1]    # 上一级最后一步评估所在的 sigma
        sigma_next = sigmas[acc]     # 下一级起始 sigma
        m_next = avatar_masks.resize_spatial(m_full, (h_next, w_next)) if m_full is not None else None
        z0_low_vae = latent_format.process_out(captured["x0"].float()).to(device)
        z_lat_vae, z_pix_vae = _slf.paired_lifts(z0_low_vae, vae, (h_next, w_next),
                                                 latent_upsample, None,
                                                 need_lat=need_lat, need_pix=need_pix)
        del z0_low_vae
        z_lat = latent_format.process_in(z_lat_vae) if z_lat_vae is not None else None
        z_pix = latent_format.process_in(z_pix_vae) if z_pix_vae is not None else None
        del z_lat_vae, z_pix_vae
        z0_next = _slf.artifact_aware_consistency_lift(z_lat, z_pix, rho, w_min, w_max,
                                                       mask=m_next)
        del z_lat, z_pix
        if m_next is not None:
            # 遮罩保留区在抬升后立即用原始内容（缩到本级网格）回填
            m_cast = m_next.to(device=z0_next.device, dtype=z0_next.dtype)
            anchor = torch.nn.functional.interpolate(
                source.float(), size=(h_next, w_next), mode="bilinear", align_corners=False
            ).to(z0_next)
            z0_next = z0_next * m_cast + latent_format.process_in(anchor) * (1.0 - m_cast)
            del anchor
        z0_next = z0_next.to(device)

        # 重新加噪 + 复用最后一步的 Euler 区间（与上游单级版逐行同构）
        video_noise = comfy.sample.prepare_noise(
            z0_next, (seed + i + 1) % (1 << 64), latent_image.get("batch_index", None)).to(z0_next)
        state_k = model_sampling.noise_scaling(sigma_k, video_noise, z0_next)
        next_state = _euler_step(state_k, z0_next, sigma_k, sigma_next)
        del z0_next, video_noise, state_k
        resume_stream = model_sampling.inverse_noise_scaling(sigma_next, next_state)
        del next_state
        resume_latent = model.model.process_latent_out(resume_stream)
        del resume_stream

    result = latent_image.copy()
    if noise_masks is not None:
        out = avatar_masks.restore_kept([out], [source], noise_masks)[0]
    result["samples"] = out.to(device=comfy.model_management.intermediate_device(),
                               dtype=comfy.model_management.intermediate_dtype())
    logging.info("[%s] 采样完成：共 %d 步，%d 级阶梯", _TAG, total_steps, len(segs))
    return result
