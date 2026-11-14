# -*- coding: utf-8 -*-
"""👨‍🏫 班长 SelfLift 多级完整采样（MiniMax H3）—— 每级各跑一条完整曲线

与「🎯 SelfLift 多级渐进」的区别（20261015 按用户需求从两级泛化为 N 级）：

    多级渐进：把 KSampler 的一条 sigma 曲线切成几段，前几段在缩小网格上跑
              「曲线切片」（不到 0 就换纸），总 NFE 一步不多。
    多级完整采样：每一级各自跑**完整的一条曲线**——
              ① 第一级：在最小的草稿网格上，从最大噪声一路完整采到 0，
                 得到一张画完的图；
              ② 换纸：学习式 latent 放大，把干净草稿抬到下一级网格；
              ③ 第二级起：按「重启强度」重新加噪，再各自完整采到 0。
              总 NFE = 各级步数之和。

「各级步数」填几个数就是几级：3,3,3 → 三级，每级一次完整迭代，共 9 步。
「级间倍率」是每级之间的等比倍率：三级 1.5 = 尺寸 ÷2.25 → ÷1.5 → 原尺寸。

为什么要它：多级渐进前几段跑的是「没画完的切片」，放大换纸时抬上去的是
半成品；完整采样保证每次换纸抬上去的都是一张**画完的图**，下一级拿到的
是一张可信的底图，重绘余地全开。

接法（与 SelfLift 其它补丁节点完全一致）：
    MODEL ──► [🎯 SelfLift 多级完整采样] ──► KSampler（采样器必须选 euler）

补丁挂在 comfy.patcher_extension.WrappersMP.SAMPLER_SAMPLE 上，
KSampler 与 SamplerCustom 两条路径都汇经此处。

参数口径：
    · KSampler 的「步数」只提供基准 sigma 曲线的形状（曲线点数）；
      实际跑多少步由本节点的「各级步数」决定（总 NFE = 各级之和），
      填多少都不影响实际消耗。想进度条直觉一致就填成等于各级之和。
    · 「重启强度」= 第二级起的起始噪声 ÷ 本调度最大噪声。0.6 = 草稿占四成；
      越接近 1 越像整幅重画（草稿基本不参与），越接近 0 越像只在放大图上
      做轻收尾（重绘余地越小）。
    · 音频默认透传第一级收尾原声（音色不漂移）；关掉则随最后一级重绘。

机制复用声明：换纸（学习式放大 + 曝光守恒 + 离群钳位）、满分辨率分块收尾、
条件按级重算、钉帧遮罩互斥等全部复用 banzhang_selflift 的同一套实现
（本文件继承 _SelfLiftMultiStage，只重写「每级各自完整曲线」这一段），
不另起炉灶、不重复造轮子。
"""
import logging
import time

import torch

import comfy.k_diffusion.sampling
import comfy.model_base
import comfy.model_management
import comfy.model_sampling
import comfy.nested_tensor
import comfy.patcher_extension
import comfy.sample
import comfy.samplers
import comfy.utils

from ..core.banzhang_h3_tile_pos import install as _install_tile_pos
from .banzhang_selflift import (
    _TILE_MODE_AUTO,
    _TILE_MODE_CHOICES,
    _SelfLiftMultiStage,
    _denoise_mask_for_grid,
    _ensure_highres_headroom,
    _hand_off,
    _lifter,
    _parse_num_list,
    _plan_fullres_tiling,
    _resize_keyframes,
    _sample_tiled_highres,
    _split_denoise_mask,
    _tile_choice_to_n,
    _validate_tiling_keyframes,
    _winsorize_outliers,
)

log = logging.getLogger("banzhang.selflift_fullstage")

_WRAPPER_KEY = "banzhang_selflift_fullstage"
_TAG = "🎯 SelfLift 多级完整采样"


def _resample_sigmas(src, n_steps):
    """把基准 sigma 曲线整形为 n_steps+1 个点，末项强制为 0（完整采到干净）。

    保持原曲线的形状（beta / karras 等调度各有性格，不替换成线性），
    只在参数域上等距重采样；末项钉 0 是为了「完整」二字 —— 基准曲线末项
    非 0 时（个别自定义 SIGMAS）也保证最后一步落到干净端。
    """
    s = src.flatten().float()
    S = s.numel()
    if S < 2:
        raise ValueError(f"{_TAG}：基准 sigma 曲线太短（少于 2 个点）")
    if S == n_steps + 1:
        out = s.clone()
    else:
        pos = torch.linspace(0.0, float(S - 1), n_steps + 1,
                             device=s.device, dtype=torch.float32)
        lo = pos.floor().long().clamp(max=S - 2)
        hi = lo + 1
        w = (pos - lo.float()).clamp(0.0, 1.0).to(s.dtype)
        out = s[lo] * (1.0 - w) + s[hi] * w
    if float(out[-1]) != 0.0:
        out = torch.cat([out[:-1], torch.zeros_like(out[-1:])])
    return out


class _SelfLiftFullStage(_SelfLiftMultiStage):
    """多级完整采样补丁：每级各自一条完整曲线，级间学习式换纸。

    继承 _SelfLiftMultiStage 只为复用它的换纸 / 回调 / 网格 / 分块实现；
    采样主流程（__call__）按「每级各自完整曲线」重写。
    """

    def __init__(self, steps, ratio, restart, lifter=None,
                 spatial_params=None, outlier_sigmas=9.0, vae=None, rho=0.0,
                 audio_passthrough=True):
        # segments 仅用于继承来的 _transition/_grids 等 helper；
        # 采样主流程走本类自己的 __call__，不经过父类的 _plan 切片逻辑。
        super().__init__(segments=[int(s) for s in steps],
                         ratios=[float(ratio)], lifter=lifter,
                         spatial_params=spatial_params,
                         outlier_sigmas=outlier_sigmas, vae=vae, rho=float(rho),
                         w_min=0.0, w_max=1.0)
        self.steps = [max(1, int(s)) for s in steps]
        self.restart = float(restart)
        self.audio_passthrough = bool(audio_passthrough)

    # ------------------------------------------------------------------
    # 入口
    # ------------------------------------------------------------------
    def __call__(self, executor, guider, sigmas, extra_args, callback,
                 noise, latent_image, denoise_mask, disable_pbar):
        if self._busy:
            return executor(guider, sigmas, extra_args, callback,
                            noise, latent_image, denoise_mask, disable_pbar)

        model = guider.inner_model
        if not isinstance(guider.model_patcher.model, comfy.model_base.MiniMaxH3):
            raise ValueError(f"{_TAG}：本补丁目前只支持 MiniMax H3 模型")

        sampler_obj = executor.class_obj
        if getattr(sampler_obj, "sampler_function", None) is not comfy.k_diffusion.sampling.sample_euler:
            raise ValueError(
                f"{_TAG}：采样器必须选标准 euler。"
                "换纸复用边界步的预测来对齐两级状态，其它采样器无法套用。")
        if sampler_obj.extra_options.get("s_churn", 0.0) != 0.0:
            raise ValueError(f"{_TAG}：euler 的 s_churn 必须为 0")
        if not isinstance(model.model_sampling, comfy.model_sampling.CONST):
            raise ValueError(f"{_TAG}：需要 rectified-flow 模型")

        steps = self.steps
        n = len(steps)
        r = self.restart
        if n < 2:
            raise ValueError(f"{_TAG}：至少需要 2 级（「各级步数」填两个以上数字）")
        if any(s < 1 for s in steps):
            raise ValueError(f"{_TAG}：每一级至少 1 步")
        if not 0.0 < r <= 1.0:
            raise ValueError(f"{_TAG}：重启强度必须落在 (0, 1]")

        base = sigmas.flatten().float()
        if base.numel() < 2:
            # 曲线太短没得玩：原样放行（与多级渐进同口径）
            return executor(guider, sigmas, extra_args, callback,
                            noise, latent_image, denoise_mask, disable_pbar)
        if bool((base[1:] > base[:-1]).any()):
            raise ValueError(f"{_TAG}：sigmas 必须非递增")

        # ── 各级曲线：第一级 max→0 完整一条；第二级起 重启强度×max→0 完整一条 ──
        sig_levels = [
            _resample_sigmas(base, s) * (1.0 if i == 0 else r)
            for i, s in enumerate(steps)
        ]
        sigma_max = float(base[0])
        sigma_restart = float(sig_levels[1][0])
        if sigma_max <= 0.0:
            raise ValueError(f"{_TAG}：基准曲线最大噪声 ≤ 0，无从采样")
        if sigma_restart >= 1.0 - 1e-4:
            raise ValueError(
                f"{_TAG}：重启强度 %.2f × 本调度最大噪声 %.4f = %.4f，"
                "已接近或超过 1 —— 第二级起等于从纯噪声开始（且补丁无法表示该状态）。"
                "请把「重启强度」降到 %.2f 以下。"
                % (r, sigma_max, sigma_restart,
                   min(1.0, (1.0 - 1e-3) / max(sigma_max, 1e-6))))
        if r >= 0.9:
            log.warning("[班长SelfLift·完整] 重启强度 %.2f 很高：第二级起几乎整幅重画，"
                        "前级草稿基本不参与最终画面（等于白跑）", r)
        if r <= 0.15:
            log.warning("[班长SelfLift·完整] 重启强度 %.2f 很低：第二级起接近在干净放大图上"
                        "轻收尾，「完整采样」的重绘余地很小", r)
        if min(steps[1:]) < 3:
            log.warning("[班长SelfLift·完整] 有级只有 %d 步：换纸注入的离群值可能洗不掉"
                        "（彩色光点风险），建议每级 ≥ 3 步", min(steps[1:]))

        shapes = getattr(model, "latent_shapes", None)
        if not shapes or len(shapes) < 2:
            raise ValueError(f"{_TAG}：需要一个音视频双流的 H3 latent")
        shapes = [tuple(s) for s in shapes]
        video_shape = shapes[0]
        if len(video_shape) != 5:
            raise ValueError(f"{_TAG}：视频 latent 应为 5 维，实际 {video_shape}")
        t, H, W = video_shape[2], video_shape[3], video_shape[4]
        audio_shape = shapes[1]

        # 钉帧遮罩与换纸互斥（与多级渐进同口径：遮罩的参照物在换纸后已不在）
        mask_streams = _split_denoise_mask(denoise_mask, shapes)
        if mask_streams is not None:
            log.warning("[班长SelfLift·完整] 检测到钉帧遮罩：与换纸互斥，本次忽略遮罩"
                        "（钉帧由「🧷 尾帧回填」保证，不受影响）")
            mask_streams = None

        # 各级网格：首级最小，末级恒为满尺寸，级间等比
        ratios = self._ratios_for(n)
        scales = self._scales_from_ratios(ratios, n)
        grids = self._grids(scales, H, W)
        first_px = min(grids[0][0], grids[0][1]) * 16
        if first_px < 384:
            log.warning("[班长SelfLift·完整] 首级短边 %dpx 低于 H3 训练分布下限 384，"
                        "画质可能受影响（仅提示，不影响运行）", first_px)
        for i in range(n - 1):
            real_ratio = max(grids[i + 1][0] / grids[i][0], grids[i + 1][1] / grids[i][1])
            if abs(real_ratio - ratios[i]) / ratios[i] > 0.10:
                log.warning("[班长SelfLift·完整] 第%d→%d级实际倍率 %.3f 与设定 %.3f "
                            "偏差超 10%%（网格取整导致）",
                            i + 1, i + 2, real_ratio, ratios[i])
        draft_share = 1.0 - sigma_restart / max(sigma_max, 1e-6)
        if draft_share > 0.5:
            log.warning("[班长SelfLift·完整] 草稿占比 %.3f > 0.5（重启强度偏低）："
                        "前级草稿在最终画面里分量过大，后级很难修正构图", draft_share)
        ladder = " | ".join(
            "第%d级 %dx%d（%d步，σ%.4g→0）"
            % (i + 1, grids[i][1] * 16, grids[i][0] * 16, steps[i],
               float(sig_levels[i][0]))
            for i in range(n))
        log.info("[班长SelfLift·完整] 计划：画布 %dx%d | %s | 倍率 %.3f | 重启 %.2f"
                 "（草稿占比 %.2f）| 音频%s | 总NFE %d"
                 "（KSampler步数 %d 仅定基准曲线形状，与实际消耗无关）",
                 W * 16, H * 16, ladder, ratios[0], r, draft_share,
                 "透传" if self.audio_passthrough else "随最后一级重绘",
                 sum(steps), base.numel() - 1)

        device = guider.model_patcher.load_device
        seed = int(extra_args.get("seed") or 0)
        ms = model.model_sampling

        # 第一级：整条 latent 下采样到首级网格（空 latent 恒等，不引入偏差）
        video_ms, audio_ms = comfy.utils.unpack_latents(latent_image, shapes)
        h0, w0 = grids[0]
        video0 = torch.nn.functional.interpolate(
            video_ms.float(), size=(t, h0, w0), mode="trilinear", align_corners=False
        ).to(video_ms.dtype)
        noise_streams = comfy.sample.prepare_noise(
            comfy.nested_tensor.NestedTensor([video0, audio_ms]), seed).unbind()
        video_noise, audio_noise = noise_streams[0], noise_streams[1]
        latent0, _ = comfy.utils.pack_latents([video0, audio_ms])
        noise0, _ = comfy.utils.pack_latents([video_noise, audio_noise])

        saved_conds = guider.conds
        original_conds = getattr(guider, "original_conds", None)
        if original_conds is None:
            log.warning("[班长SelfLift·完整] 读不到 guider.original_conds，"
                        "首级将沿用最终网格的条件")

        saved_shapes = model.latent_shapes
        started = time.perf_counter()
        self._busy = True
        out = None
        resume_pack = None
        audio_anchor0 = None
        total = sum(steps)
        try:
            for i in range(n):
                h_i, w_i = grids[i]
                stage_shapes = [(video_shape[0], video_shape[1], t, h_i, w_i),
                                audio_shape]
                mask_i = _denoise_mask_for_grid(mask_streams, stage_shapes)
                sig_i = sig_levels[i]
                last = (i == n - 1)
                step_base = sum(steps[:i])
                if last and getattr(self.lifter, "unload", False):
                    # 末级不再提升：放大模型用完即焚（彻底丢弃，不是搬回内存等复用）
                    _lifter.release()
                sink = {}
                cb, calls = self._make_callback(
                    i, steps[i], step_base, total, callback,
                    stage_shapes, t, None if last else (H, W), sink)

                conds_i = None
                if original_conds is not None:
                    conds_i = {k: [c.copy() for c in v]
                               for k, v in original_conds.items()}
                    for key in ("positive", "negative"):
                        if key in conds_i:
                            conds_i[key] = _resize_keyframes(conds_i[key], h_i, w_i)
                    if i > 0:
                        # 中间级不能走 inner_sample（会对非零 latent 再乘一次音频系数），
                        # 自己处理条件后直接交给原生 sampler.sample。
                        conds_i = comfy.samplers.process_conds(
                            model, noise, conds_i, device, latent_image=None,
                            denoise_mask=mask_i, seed=seed,
                            latent_shapes=stage_shapes)
                model.latent_shapes = stage_shapes
                if conds_i is not None:
                    guider.conds = conds_i
                try:
                    if i == 0:
                        out = guider.inner_sample(
                            _hand_off(noise0, device), _hand_off(latent0, device),
                            device, sampler_obj, sig_i, mask_i, cb,
                            disable_pbar, seed, latent_shapes=stage_shapes)
                    else:
                        _ensure_highres_headroom(guider.model_patcher, device)
                        stage_noise = torch.zeros_like(resume_pack)
                        stage_latent = resume_pack
                        # 末级（满尺寸网格）可选逐步同步分块收尾：显存峰值≈单块。
                        # 前面各级都在缩小网格上跑，用不着分块。
                        tiling = None
                        if last and self.spatial_params is not None:
                            # n_tiles=0（智能档）才需要读显存；手动档不白跑一次 NVML。
                            n_manual = self.spatial_params.get("n_tiles")
                            tiling = _plan_fullres_tiling(
                                self.spatial_params, h_i, w_i,
                                n_tiles_manual=n_manual,
                                free_bytes=(comfy.model_management.get_free_memory(device)
                                            if n_manual == 0 else None),
                                t_frames=t)
                        if tiling is not None:
                            t_axis, t_starts, t_size, t_ov, t_fe = tiling
                            _validate_tiling_keyframes(guider, h_i, w_i)
                            log.info(
                                "[班长SelfLift·完整] 第%d级改为逐步同步分块收尾："
                                "长边=%s 共%d块 tile=%d格 overlap=%d 羽化=%d"
                                "（画布 %d格×%d格 / %dpx×%dpx）",
                                i + 1, t_axis, len(t_starts), t_size, t_ov, t_fe,
                                h_i, w_i, w_i * 16, h_i * 16)
                            # 与 KSAMPLER.sample 同口径的入口加噪：CONST 下
                            # noise_scaling(σ, 0, latent) = (1-σ)·latent，
                            # 恰好还原续跑状态
                            x0_state = ms.noise_scaling(
                                sig_i[0], stage_noise, stage_latent, False)
                            out = _sample_tiled_highres(
                                guider, model, sig_i, extra_args, cb,
                                x0_state, stage_latent, stage_noise, mask_i,
                                stage_shapes, t_axis, t_starts, t_size, t_ov, t_fe,
                                h_i, w_i, step_offset=step_base,
                                total_steps=total, disable_pbar=disable_pbar)
                        else:
                            out = executor(guider, sig_i, extra_args, cb,
                                           stage_noise, stage_latent, mask_i,
                                           disable_pbar)
                finally:
                    guider.conds = saved_conds
                    model.latent_shapes = saved_shapes
                if calls[0] != steps[i]:
                    raise RuntimeError(
                        f"{_TAG}：第 {i + 1} 级应跑 {steps[i]} 步，实际 {calls[0]} 步；"
                        "采样器可能被其它插件包装")
                if last:
                    break

                # 音频锚点：本级收尾的干净音频。sink["x"] 在 σ=0 上（欧拉末步
                # 恰好落在 x0 上），直接取它，不走 _transition 的欧拉外推 ——
                # σ_k→下一级跨距大时外推会把末步残差放大十倍以上，音频会脏。
                _, audio_stage = comfy.utils.unpack_latents(sink["x"], stage_shapes)
                anchor = _winsorize_outliers(
                    audio_stage.float(), f"（完整·第{i + 1}级音频锚点）",
                    sigmas=self.outlier_sigmas)
                if i == 0:
                    audio_anchor0 = anchor.clone()

                # 换纸：干净草稿抬到下一级网格
                # 提升前按 4GB 预算给放大模型腾地方（与多级渐进同一口径，必做）：
                # 不腾的话智能时间分块会被压到极短，3D 时间感受野被切碎，
                # 运动剧烈区域在时间片边界出现果冻状形变。
                _ensure_highres_headroom(guider.model_patcher, device,
                                         need=4 * 1024 ** 3)
                next_shapes = [(video_shape[0], video_shape[1], t,
                                grids[i + 1][0], grids[i + 1][1]), audio_shape]
                resume_pack = self._transition(
                    sink["x"], sink["x0"], stage_shapes, ms,
                    sig_i[-2], sig_levels[i + 1][0], grids[i + 1], device,
                    (seed + 1 + i) % (1 << 64))
                del sink

                # 视频已由 _transition 按下一级起始 σ 加噪（inverse 空间，÷(1-σ)）；
                # 音频与视频同口径加噪：每级都是完整采样，音频不能停在干净态
                # （否则下一级入口的 AV 联合状态一边加噪一边干净，模型错乱）。
                # _transition 返回的音频是欧拉外推的，弃用，改按锚点重加噪。
                v_hi, _ = comfy.utils.unpack_latents(resume_pack, next_shapes)
                a_noise = _hand_off(
                    comfy.sample.prepare_noise(anchor, (seed + 2 + i) % (1 << 64)),
                    device)
                sigma_next = float(sig_levels[i + 1][0])
                resume_audio = anchor + (sigma_next / (1.0 - sigma_next)) * a_noise
                resume_pack, _ = comfy.utils.pack_latents([v_hi, resume_audio])
                del anchor, v_hi, a_noise

            # ================= 收尾：离群钳位 + 音频透传 =================
            out_shapes = [(video_shape[0], video_shape[1], t, H, W), audio_shape]
            v_out, a_out = comfy.utils.unpack_latents(out, out_shapes)
            v_out = _winsorize_outliers(
                v_out, "（完整·收尾 %dx%d）" % (W * 16, H * 16),
                sigmas=self.outlier_sigmas)
            if self.audio_passthrough:
                # 透传：输出保留第一级收尾的干净音频（音色不漂移）
                log.info("[班长SelfLift·完整] 音频透传：输出保留第一级收尾音频")
                a_out = audio_anchor0.to(a_out.dtype)
            else:
                a_out = _winsorize_outliers(a_out, "（完整·音频收尾）",
                                            sigmas=self.outlier_sigmas)
            out, _ = comfy.utils.pack_latents([v_out, a_out])
            log.info("[班长SelfLift·完整] %d 级完成，总耗时 %.3fs（NFE=%d）",
                     n, time.perf_counter() - started, total)
            return out
        finally:
            self._busy = False


class BanZhang_SelfLiftFullStage:
    """多级完整采样（MODEL → MODEL 补丁）：每级各自一条完整曲线，级间学习式换纸。"""

    DESCRIPTION = (
        "把「多级渐进」的每一级都升级成完整采样：每一级各自跑一条完整曲线。\n"
        "① 第一级：在最小的草稿网格上从最大噪声完整采到 0，得到一张画完的图；\n"
        "② 换纸：学习式 latent 放大把干净草稿抬到下一级网格；\n"
        "③ 第二级起：按「重启强度」重新加噪，再各自完整采到 0。\n"
        "「各级步数」填几个数就是几级（例：3,3,3 → 三级，每级一次完整迭代，共 9 步）。\n"
        "与「多级渐进」的差别：那条是几段共享一条曲线、前几段跑切片；\n"
        "本节点每级各跑一条完整曲线，每次换纸抬上去的都是一张画完的图。\n"
        "总 NFE = 各级步数之和；KSampler 步数只定基准曲线形状，填多少都不影响\n"
        "实际消耗（想进度条直觉一致，就填成等于各级之和）。\n"
        "接在 MODEL 线上、采样器之前，采样器必须选「euler」。\n"
        "「级间倍率」是每级之间的等比倍率（三级 1.5 = 尺寸 ÷2.25 → ÷1.5 → 原尺寸）。\n"
        "「重启强度」0.6 = 草稿占四成、混入六成噪声后整幅重画细节；\n"
        "越接近 1 越像整幅重来（草稿白跑），越接近 0 越像轻收尾（重绘余地小）。\n"
        "音频默认透传第一级收尾的原声（音色不漂移），可关掉让其随最后一级重绘。\n"
        "满分辨率收尾可选「自动」按显存智能切 2~16 块，6G 卡也能跑大画布\n"
        "（要求 keyframe 与画布同网格；6G 配套：去掉启动参数 --disable-smart-memory /\n"
        "--highvram，显存卫士预留设 0，动态加载保持开启）。\n"
        "每次换纸后自动把极少数爆表的点压回正常范围，兜住偶发彩色光点；\n"
        "清理力度可调，控制台会打印每次清理了几处。"
    )

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "模型": ("MODEL", {
                    "tooltip": "接在 LoRA 加载器之后、采样器之前。",
                }),
                "各级步数": ("STRING", {
                    "default": "8,8",
                    "multiline": False,
                    "tooltip": (
                        "填几个数就是几级，每一级各自跑一条完整曲线\n"
                        "（第一级 最大噪声→0，第二级起 重启强度×最大噪声→0）。\n"
                        "例：3,3,3 → 三级各 3 步，共 9 步，每级一次完整迭代。\n"
                        "至少 2 级；总步数 = 各级之和，与 KSampler 步数无关。\n"
                        "分隔符随意：半角/全角逗号、空格、顿号、分号都认，\n"
                        "3,3,3 / 3，3，3 / 3 3 3 / 3、3、3 写法等价。"
                    ),
                }),
                "级间倍率": ("FLOAT", {
                    "default": 1.5, "min": 1.0, "max": 3.0, "step": 0.05,
                    "tooltip": "换纸时每放大一级的倍率，各级之间等比。\n"
                               "1.5 = 训练档位（推荐）；1.0 = 各级同尺寸，只换纸不放大。\n"
                               "三级 1.5 = 尺寸 ÷2.25 → ÷1.5 → 原尺寸。",
                }),
                "重启强度": ("FLOAT", {
                    "default": 0.6, "min": 0.05, "max": 1.0, "step": 0.05,
                    "tooltip": "第二级起的起始噪声 = 重启强度 × 本调度最大噪声。\n"
                               "0.6 = 草稿占四成，混六成噪声整幅重画细节（推荐）；\n"
                               "越接近 1 越像整幅重来（草稿基本不参与，前级白跑）；\n"
                               "越接近 0 越像只在放大图上轻收尾（重绘余地越小）。",
                }),
                "latent放大模型": (_lifter.list_models(), {
                    "default": _lifter.default_model(),
                    "tooltip": "换纸时「放大」这一段用什么算法。\n"
                               "列表来自 models/latent_upscale_models 目录，\n"
                               "默认自动选名字含 h3 的模型。\n"
                               "提升必须走学习式放大：最近邻插值实测伪影严重，已不提供。",
                }),
            },
            "optional": {
                "放大后卸载": ("BOOLEAN", {
                    "default": True, "label_on": "开启", "label_off": "关闭",
                    "tooltip": "最后一次换纸一结束就把放大模型搬回 CPU，把显存让给末级。",
                }),
                "满分辨率分块": (_TILE_MODE_CHOICES, {
                    "default": _TILE_MODE_AUTO,
                    "tooltip": "末级（满尺寸网格）的显存策略。\n"
                               "自动 = 按当前空闲显存智能决定整幅还是切 2~16 块；\n"
                               "关 = 整幅收尾（无接缝，画质最好，显存大户选这个前先掂量）；\n"
                               "手动块数 = 固定块数，块越多越省显存但接缝风险略升。\n"
                               "画布长边 ≤ 384px 时怎么填都不切。",
                }),
                "音频透传": ("BOOLEAN", {
                    "default": True, "label_on": "透传（保留首级原声）",
                    "label_off": "重绘（音频随末级重采样）",
                    "tooltip": "开启 = 输出保留第一级收尾的音频（推荐，音色不漂移）；\n"
                               "关闭 = 音频按重启强度加噪后随最后一级一起重绘。",
                }),
                "视频VAE": ("VAE", {
                    "tooltip": "伪影修正需要的像素锚点 VAE。不接 = 关闭伪影修正。",
                }),
                "伪影修正比例": ("FLOAT", {
                    "default": 0.0, "min": 0.0, "max": 1.0, "step": 0.05,
                    "tooltip": "换纸时的 artifact-aware 一致性修正开关（0 = 关）。\n"
                               "开 > 0：换纸同时算一条像素-VAE 重编码路径，用两条路的残差\n"
                               "定位离群点、只修最不一致的 top-rho 位置。\n"
                               "建议从 0.05~0.2 试起；需要接「视频 VAE」才生效。\n"
                               "⚠ 实验开关：开启后请小样验证。",
                }),
                "彩色光点清理力度": ("FLOAT", {
                    "default": 9.0, "min": 6.0, "max": 12.0, "step": 0.5,
                    "tooltip": "专治画面里偶尔冒出的「五颜六色小光点」。\n"
                               "平时保持默认 9。出彩色光点 → 往小调（先试 8，不行再 7）；\n"
                               "亮部细节发灰被压平 → 往大调（10 或 11）。\n"
                               "每次清理了多少，看控制台「[班长SelfLift·钳位]」那行日志。",
                }),
            },
        }

    RETURN_TYPES = ("MODEL",)
    RETURN_NAMES = ("模型",)
    FUNCTION = "apply"
    CATEGORY = "👨‍🏫班长/MiniMax H3"

    def apply(self, 模型, 各级步数="8,8", 级间倍率=1.5, 重启强度=0.6,
              latent放大模型=None, 放大后卸载=True, 满分辨率分块=_TILE_MODE_AUTO,
              音频透传=True, 视频VAE=None, 伪影修正比例=0.0, 彩色光点清理力度=9.0):
        steps = _parse_num_list(各级步数, int, "各级步数", tag=_TAG)
        if len(steps) < 2:
            raise ValueError(
                f"{_TAG}：「各级步数」至少填 2 级（例：8,8 或 3,3,3）。\n"
                "只跑一级的话，直接用 KSampler 就行，不需要本节点。")
        if any(s < 1 for s in steps):
            raise ValueError(f"{_TAG}：「各级步数」每一级至少 1 步")
        if 级间倍率 < 1.0:
            raise ValueError(f"{_TAG}：「级间倍率」必须 ≥ 1.0")
        if latent放大模型 is None:
            latent放大模型 = _lifter.default_model()
        lifter = _lifter.make_lifter(latent放大模型, 放大后卸载)
        if lifter is None:
            raise ValueError(
                f"{_TAG}：没有可用的 H3 latent 放大模型。"
                "请把模型文件放入 models/latent_upscale_models 目录后刷新。")

        # 满分辨率收尾的下拉三态：关=不分块 / 自动=按显存智能 / N=手动块数。
        # 内置几何与「🎯 SelfLift 多级渐进」同一套（tile=40格 overlap=8格 羽化=4）。
        n_tiles = _tile_choice_to_n(满分辨率分块)
        spatial_params = None
        if n_tiles is not None:
            spatial_params = {"tw": 40, "th": 40, "ol_w": 8, "ol_h": 8,
                              "fw": 8, "fh": 8, "mt": 24, "feather": 4,
                              "n_tiles": n_tiles}

        patched = 模型.clone()
        if spatial_params is not None:
            # 分块收尾要用：全局坐标注入 wrapper 必须在采样准备前挂好
            # （wrapper 列表在采样开始时快照进 model_options，中途补挂不生效）。
            _install_tile_pos(patched)
        patched.add_wrapper_with_key(
            comfy.patcher_extension.WrappersMP.SAMPLER_SAMPLE,
            _WRAPPER_KEY,
            _SelfLiftFullStage(steps, 级间倍率, 重启强度, lifter,
                               spatial_params=spatial_params,
                               outlier_sigmas=彩色光点清理力度,
                               vae=视频VAE, rho=float(伪影修正比例 or 0.0),
                               audio_passthrough=音频透传),
        )
        return (patched,)


NODE_CLASS_MAPPINGS = {
    "BanZhang_SelfLiftFullStage": BanZhang_SelfLiftFullStage,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "BanZhang_SelfLiftFullStage": "🎯 SelfLift 多级完整采样",
}
