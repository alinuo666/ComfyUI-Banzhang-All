# -*- coding: utf-8 -*-
"""图片多级渐进补丁（MODEL → MODEL）：接官方 K 采样器使用的多级渐进。

与「🖼️ 图片多级渐进」独立采样器同一套算法（SelfLift-zero 的多级推广），
但以 SAMPLER_SAMPLE wrapper 形式挂在 MODEL 上 —— 步数 / 负面词 / 降噪强度
都由官方 K 采样器管理，也能配合自定义 Sigma 曲线等节点。

机制（与 banzhang_selflift.py 的 H3 多级补丁同源）：
  1. 拦截官方采样调用后，按「分段步数」把日程切成几段；
  2. 第一段把初始 latent 缩到首级网格，交还 guider.inner_sample 正常采样；
  3. 每到一个分段边界：取该段最后一步的干净预测 x0，经 Artifact-Aware
     Consistency Lift（插值 + 像素-VAE 锚点修正）抬到下一级网格，按边界
     sigma 重新加噪并复用该步 Euler 区间（总 NFE 一步不多），继续调原采样器；
  4. 末段在满分辨率收尾，结果原样交回官方流程（VAE 解码等不受影响）。

约束：采样器必须选标准 euler（s_churn=0）、整流流模型（SD3 / FLUX / Qwen-Image 等）。
"""

import logging

import torch

import comfy.k_diffusion.sampling
import comfy.model_base
import comfy.model_sampling
import comfy.patcher_extension
import comfy.samplers
import comfy.sample

from ._selflift_avatar import selflift as _slf
from ._selflift_avatar.avatar_masks import resize_spatial as _resize_mask
from ._selflift_avatar.nodes import _euler_step
from .banzhang_selflift import _ensure_highres_headroom, _hand_off, _parse_num_list, _suggest_split
from .banzhang_selflift_image_multistage import _build_stage_plan

_TAG = "🖼️ 图片多级渐进补丁"
_WRAPPER_KEY = "banzhang_selflift_image_multistage"


def _plan_segments(segs, total_steps):
    """把 KSampler 实际步数对齐到分段：不足并入最后一段，超出报错并给建议值。"""
    segs = list(segs)
    if len(segs) > total_steps:
        raise ValueError(
            f"{_TAG}：本次调度只有 {total_steps} 步，填不下 {len(segs)} 段"
            f"（每段至少 1 步）。请减少「分段步数」的段数，或提高 KSampler 步数。")
    used = sum(segs)
    if used > total_steps:
        suggestion = ",".join(str(x) for x in _suggest_split(total_steps, len(segs)))
        raise ValueError(
            f"{_TAG}：「分段步数」合计 {used} 步，超过本次调度的 {total_steps} 步。\n"
            f"可改成 \"{suggestion}\"，或把 KSampler 步数设为 {used} 及以上。")
    if used < total_steps:
        segs[-1] += total_steps - used
        logging.info("[%s] 分段步数合计 %d 少于总步数 %d，剩余 %d 步并入最后一段",
                     _TAG, used, total_steps, total_steps - used)
    bounds = []
    acc = 0
    for s in segs[:-1]:
        acc += s
        bounds.append(acc)
    return segs, bounds


class _ImageMultiStagePatch:
    """挂 SAMPLER_SAMPLE 上的图片多级渐进 wrapper（协议与 H3 多级补丁一致）。"""

    def __init__(self, segments, ratios, vae=None, rho=0.3, w_min=0.5, w_max=1.0,
                 latent_upsample="nearest"):
        self.segments = list(segments)
        self.ratios = list(ratios) if ratios else None
        self.vae = vae
        self.rho = float(rho)
        self.w_min = float(w_min)
        self.w_max = float(w_max)
        self.latent_upsample = latent_upsample
        self._busy = False

    # ------------------------------------------------------------------
    # 过渡：把干净预测抬到下一级网格（复用边界 Euler 区间，不 extra NFE）
    # ------------------------------------------------------------------
    def _transition(self, x0, ms, latent_format, sigma_k, sigma_next, next_hw,
                    device, noise_seed):
        need_pix = self.rho > 0.0 and self.w_max > 0.0 and self.vae is not None
        need_lat = not (self.rho >= 1.0 and self.w_min >= 1.0 and self.w_max >= 1.0)
        z0_low_vae = latent_format.process_out(x0.float()).to(device)
        z_lat_vae, z_pix_vae = _slf.paired_lifts(
            z0_low_vae, self.vae, next_hw, self.latent_upsample, None,
            need_lat=need_lat, need_pix=need_pix)
        del z0_low_vae
        z_lat = latent_format.process_in(z_lat_vae) if z_lat_vae is not None else None
        z_pix = latent_format.process_in(z_pix_vae) if z_pix_vae is not None else None
        del z_lat_vae, z_pix_vae
        z0 = _slf.artifact_aware_consistency_lift(z_lat, z_pix, self.rho,
                                                  self.w_min, self.w_max)
        del z_lat, z_pix
        z0 = z0.to(device=device, dtype=torch.float32)
        # 重新加噪 + 复用边界 Euler 区间（与独立采样器 / H3 补丁逐行同构）
        video_noise = _hand_off(comfy.sample.prepare_noise(z0, noise_seed), device)
        next_state = _euler_step(ms.noise_scaling(sigma_k, video_noise, z0), z0,
                                 sigma_k, sigma_next)
        del z0, video_noise
        # 还原成 executor 入口口径（KSAMPLER.sample 内部会按 sigmas[0] 重建）
        return ms.inverse_noise_scaling(sigma_next, next_state)

    # ------------------------------------------------------------------
    # 入口
    # ------------------------------------------------------------------
    def __call__(self, executor, guider, sigmas, extra_args, callback,
                 noise, latent_image, denoise_mask, disable_pbar):
        if self._busy:
            return executor(guider, sigmas, extra_args, callback,
                            noise, latent_image, denoise_mask, disable_pbar)

        model = guider.inner_model
        if isinstance(guider.model_patcher.model, comfy.model_base.MiniMaxH3):
            raise ValueError(f"{_TAG}：MiniMax H3 请改用 🎯 SelfLift 多级渐进（视频版补丁）")
        if not isinstance(model.model_sampling, comfy.model_sampling.CONST):
            raise ValueError(
                f"{_TAG}：需要 rectified-flow 模型（SD3 / FLUX / Qwen-Image 等）")
        sampler_obj = executor.class_obj
        if getattr(sampler_obj, "sampler_function", None) is not comfy.k_diffusion.sampling.sample_euler:
            raise ValueError(
                f"{_TAG}：采样器必须选标准 euler —— 多级提升复用边界步的预测，"
                "其它采样器无法套用")
        if sampler_obj.extra_options.get("s_churn", 0.0) != 0.0:
            raise ValueError(f"{_TAG}：euler 的 s_churn 必须为 0")

        total_steps = int(sigmas.numel()) - 1
        if total_steps < 2:
            return executor(guider, sigmas, extra_args, callback,
                            noise, latent_image, denoise_mask, disable_pbar)
        if getattr(latent_image, "is_nested", False):
            raise ValueError(f"{_TAG}：音视频双流 latent 请用 🎯 H3 渐进采样器")
        if latent_image is None or latent_image.ndim != 4:
            raise ValueError(f"{_TAG}：本补丁只支持图片 latent（4 维）")

        _, _, H, W = latent_image.shape
        segs, bounds = _plan_segments(self.segments, total_steps)
        grids, ratios = _build_stage_plan(segs, self.ratios, H, W)
        n = len(segs)

        for bk in bounds:
            if not 1 <= bk <= total_steps - 1:
                raise ValueError(
                    f"{_TAG}：第 {bk} 步不是可用的提升点（应取 1 ~ {total_steps - 1}），"
                    f"请调整「分段步数」")
            if float(sigmas[bk]) >= 1.0:
                raise ValueError(
                    f"{_TAG}：某次提升后的起始 sigma ≥ 1 —— "
                    f"请加大前段步数，或降低 KSampler 的降噪强度")
        if bool((sigmas[1:] > sigmas[:-1]).any()) or bool((sigmas[:-1] <= 0).any()):
            raise ValueError(f"{_TAG}：sigmas 必须非递增，且只有最后一项可为 0")

        if self.rho > 0.0 and self.vae is None:
            logging.warning("[%s] 「像素锚点修正比例」大于 0 但没接「图片VAE」，锚点修正不会生效", _TAG)

        logging.info("[%s] 阶梯：%s ｜ 倍率 %s ｜ 锚点修正 %.2f ｜ 画布 %dx%d ｜ 分段 %s",
                     _TAG,
                     " → ".join(f"{h}x{w}" for h, w in grids),
                     ratios, self.rho, W, H,
                     ",".join(str(s) for s in segs))

        device = guider.model_patcher.load_device
        seed = int(extra_args.get("seed") or 0)
        ms = model.model_sampling
        # 注意：inner_model 是模型本体（BaseModel），get_model_object 在 ModelPatcher 上
        latent_format = guider.model_patcher.get_model_object("latent_format")

        # 入口的 latent_image 在 inner_sample 里已被 process_latent_in 过（非零时）。
        # 第一段要重新走 inner_sample，先还原回原始 latent，避免二次缩放；
        # 空 latent（文生图）零就是零，两个空间一致，无需处理。
        raw_latent = latent_image
        if torch.count_nonzero(latent_image) > 0:
            raw_latent = model.process_latent_out(latent_image.to(torch.float32))
        h0, w0 = grids[0]
        latent0 = raw_latent if (h0, w0) == (H, W) else torch.nn.functional.interpolate(
            raw_latent.float(), size=(h0, w0), mode="bilinear", align_corners=False
        ).to(dtype=raw_latent.dtype)
        noise0 = comfy.sample.prepare_noise(latent0, seed)

        saved_conds = guider.conds
        original_conds = getattr(guider, "original_conds", None)
        if original_conds is None:
            logging.warning("[%s] 读不到 guider.original_conds，各段将沿用第一段处理后的条件", _TAG)

        self._busy = True
        resume = None
        out = None
        try:
            for i in range(n):
                h_i, w_i = grids[i]
                mask_i = (_resize_mask(denoise_mask, (h_i, w_i))
                          if denoise_mask is not None else None)
                start = 0 if i == 0 else bounds[i - 1]
                end = bounds[i] if i < n - 1 else total_steps
                steps = end - start
                last = i == n - 1
                sink = {}
                calls = [0]

                def cb(step, x0, x, _total, _steps=steps, _not_last=not last,
                       _offset=start, _idx=i):
                    j = calls[0]
                    calls[0] += 1
                    if j > _steps - 1:
                        raise RuntimeError(
                            f"{_TAG}：第 {_idx + 1} 级回调次数超出预期；"
                            "采样器可能被其它插件包装")
                    if j == _steps - 1 and _not_last:
                        sink["x"], sink["x0"] = x, x0
                    if callback is None:
                        return None
                    if _not_last and x0.ndim == 4 and (x0.shape[-2] != H or x0.shape[-1] != W):
                        # 预览统一抬到最终网格（只影响预览，不参与结果）
                        x0 = torch.nn.functional.interpolate(
                            x0.float(), size=(H, W), mode="bilinear", align_corners=False
                        ).to(x0.dtype)
                        x = x0
                    return callback(_offset + j, x0, x, total_steps)

                if i == 0:
                    out = guider.inner_sample(
                        _hand_off(noise0, device), _hand_off(latent0, device), device,
                        sampler_obj, sigmas[start:end + 1], mask_i, cb, disable_pbar, seed)
                else:
                    _ensure_highres_headroom(guider.model_patcher, device)
                    conds_i = None
                    if original_conds is not None:
                        conds_i = {k: [c.copy() for c in v]
                                   for k, v in original_conds.items()}
                        conds_i = comfy.samplers.process_conds(
                            model, noise, conds_i, device, latent_image=None,
                            denoise_mask=mask_i, seed=seed)
                    if conds_i is not None:
                        guider.conds = conds_i
                    try:
                        out = executor(guider, sigmas[start:end + 1], extra_args, cb,
                                       torch.zeros_like(resume), resume, mask_i,
                                       disable_pbar)
                    finally:
                        guider.conds = saved_conds
                if calls[0] != steps:
                    raise RuntimeError(
                        f"{_TAG}：第 {i + 1} 级应跑 {steps} 步，实际 {calls[0]} 步；"
                        "采样器可能被其它插件包装")
                if last:
                    break
                resume = self._transition(
                    sink["x0"], ms, latent_format,
                    float(sigmas[end - 1]), float(sigmas[end]), grids[i + 1],
                    device, (seed + 1 + i) % (1 << 64))
                del sink
            return out
        finally:
            guider.conds = saved_conds
            self._busy = False


class BanZhang_SelfLiftImageMultiStage:
    """图片多级渐进补丁（MODEL → MODEL）：接官方 K 采样器，采样中按分段逐级提升。"""

    DESCRIPTION = (
        "「🖼️ 图片多级渐进」的 MODEL 补丁版：接在官方 K 采样器之前，\n"
        "步数 / 负面词 / 降噪强度都回 K 采样器管，也能配合自定义 Sigma 曲线节点。\n"
        "填「分段步数」（例 12,28 → 两级阶梯；也可 6,6,8 三级），「级间倍率」留空自动每级翻倍。\n"
        "采样器必须选标准 euler；整流流图片模型可用（SD3 / FLUX / Qwen-Image 等），\n"
        "SD1.5 / SDXL 等老模型不支持。视频模型（MiniMax H3）请用 🎯 SelfLift 多级渐进。\n"
        "低清步数建议只占总步数的 30%~40%：大图阶段才是出细节的地方，低清太多会糊。\n"
        "「像素锚点修正比例」大于 0 时必须接「图片VAE」才生效，发糊先试调高它、\n"
        "或把「潜空间放大方式」切成 bilinear（Qwen 这类 64 通道模型建议）。"
    )

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "模型": ("MODEL", {
                    "tooltip": "接在 LoRA 加载器之后、官方 K 采样器之前。"}),
                "分段步数": ("STRING", {
                    "default": "12,28",
                    "multiline": False,
                    "tooltip": (
                        "填逗号分隔的步数，填几个数就是分几级，例：40 步填 12,28 → 两级阶梯。\n"
                        "合计必须 ≤ KSampler 步数（超出会报错并给出建议值）；\n"
                        "不足时剩余步数自动并入最后一段。")}),
                "级间倍率": ("STRING", {
                    "default": "",
                    "multiline": False,
                    "tooltip": (
                        "留空 = 自动：每级长宽各翻倍（与论文口径一致）。\n"
                        "想手动控制就填倍率：一个值 = 各级同倍率（例 2）；\n"
                        "也可逐级给，个数 = 级数 - 1（例 2,1.5）。必须大于 1。")}),
            },
            "optional": {
                "图片VAE": ("VAE", {
                    "tooltip": (
                        "锚点修正的像素基准（解码 → 放大 → 重编码）。\n"
                        "「像素锚点修正比例」大于 0 时必须接上才生效。")}),
                "像素锚点修正比例": ("FLOAT", {
                    "default": 0.3, "min": 0.0, "max": 1.0, "step": 0.05,
                    "tooltip": (
                        "每次换大纸时，把最容易出错的位置拉回 VAE 像素基准的强度。\n"
                        "论文：FLUX.2-Klein 用 0.4，Z-Image-Turbo 用 0.3。0 = 不修正。")}),
                "潜空间放大方式": (["nearest", "bilinear"], {
                    "default": "nearest",
                    "tooltip": (
                        "换纸时 latent 的插值方式。论文默认 nearest；Qwen-Image 这类\n"
                        "64 通道模型建议试 bilinear —— 发糊或有块状感时先切这个。")}),
            },
        }

    RETURN_TYPES = ("MODEL",)
    FUNCTION = "apply"
    CATEGORY = "👨‍🏫班长/MiniMax H3"

    def apply(self, 模型, 分段步数="12,28", 级间倍率="", 图片VAE=None,
              像素锚点修正比例=0.3, 潜空间放大方式="nearest"):
        segs = _parse_num_list(分段步数, int, "分段步数", _TAG)
        if len(segs) < 2:
            raise ValueError(f"{_TAG}：「分段步数」必填且至少两级，例如 12,28")
        if any(s < 1 for s in segs):
            raise ValueError(f"{_TAG}：「分段步数」每级至少 1 步")
        ratios = _parse_num_list(级间倍率, float, "级间倍率", _TAG) or None
        if ratios:
            if len(ratios) != 1 and len(ratios) != len(segs) - 1:
                raise ValueError(
                    f"{_TAG}：「级间倍率」应填 1 个值，或填 {len(segs) - 1} 个值"
                    f"（{len(segs)} 级）；当前填了 {len(ratios)} 个")
            if any(r <= 1.0 for r in ratios):
                raise ValueError(f"{_TAG}：「级间倍率」必须大于 1.0")

        patched = 模型.clone()
        patched.add_wrapper_with_key(
            comfy.patcher_extension.WrappersMP.SAMPLER_SAMPLE,
            _WRAPPER_KEY,
            _ImageMultiStagePatch(segs, ratios, vae=图片VAE, rho=像素锚点修正比例,
                                  w_min=0.5, w_max=1.0,
                                  latent_upsample=潜空间放大方式))
        return (patched,)


NODE_CLASS_MAPPINGS = {"BanZhang_SelfLiftImageMultiStage": BanZhang_SelfLiftImageMultiStage}
NODE_DISPLAY_NAME_MAPPINGS = {"BanZhang_SelfLiftImageMultiStage": "🖼️ 图片多级渐进补丁"}
