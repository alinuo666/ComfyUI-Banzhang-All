# -*- coding: utf-8 -*-
"""图片分块二采采样器：大图（4K 级）把整幅切成瓦片逐块采样，窗口融合成整幅。

定位：接在「🖼️ 图片高清放大（二采重绘）」的潜空间输出之后，替代整幅 KSampler。
只做一件事——分块采样。放大一律交给上游的「图片高清放大」节点，本节点不碰放大
（早先版本内部塞了一整套放大参数，其中「潜空间插值放大」那条路线效果不可用已砍掉；
放大回归单一入口后，两个节点各管一段，不再互相重复）。

买的是显存（峰值 ≈ 单瓦片）与"跑得动"，不是速度：总前向次数 ≈ 块数 × 步数。
完全复用官方采样循环 comfy.samplers.sample（条件处理 / CFG / 进度全部官方口径）。

融合口径（与 H3 终极放大同源）：
  · 二维网格切块，起点均匀分布、最后一块必贴画布边缘；
  · 每块独立跑同一条 sigma 曲线（「降噪强度」= 官方 denoise，步数走满多少就是多少）；
  · 融合用「核心区独占 + 余弦过渡窗」：核心区按**真实邻居**划定（左邻块终点 →
    右邻块起点），羽化铺满整个重叠区，相邻两块一降一升、区间等长，权重和恒为 1
    —— 从机制上消除接缝重影。
  · 噪声从整幅一次生成后切块，重叠区两侧噪声一致，过渡更干净。

⚠ 网格切分曾有一个致命坑（已修，勿回退）：早先先按 stride 铺一遍、再把最后
一块硬塞到 total-tile 收尾，最后一块与前一格的重叠会暴涨（实测声明 8 格实际
120 格），而核心区窗口仍按声明的 ov 算 —— 权重和最大冲到 4.0，82.5% 的画面
变成 2~4 块结果的算术平均，直接把画面抹糊。现在改为先定块数再反算间距（均匀
重排）+ 核心区按真实邻居算，二者缺一不可。运行结束有权重和自检。

限制：整流流模型（SD3 / FLUX / Qwen-Image 等）+ 标准 euler；不支持重绘蒙版；仅 batch 1。
「降噪强度」就是官方 KSampler 的 denoise（步数走满、起点按强度前移）。
上游走「图片高清放大」（像素放大）时 0.35~0.45 最稳；越高块间内容差异越大，
越靠参考图锚定一致性。

分块的两个固有问题在 banzhang_tiled_rope 里处理（两个开关）：
  · 坐标对齐：让模型知道这块在整幅的哪个位置（Qwen-Image 2.1）；
  · 参考图分块：参考图按块的位置比例切，每块只看自己那块。
"""

import logging
import math

import torch

import comfy.model_management
import comfy.sample
import comfy.samplers
import comfy.utils

from .._selflift_avatar.nodes import _validate_sampling
from ..core import banzhang_tiled_rope as _tiled_rope
from ..core import banzhang_schedulers as _bz_sched

_TAG = "🖼️ 图片分块二采"


def _spatial_downscale(模型, VAE):
    """空间下采倍数：优先从模型的 latent_format 读（最准），读不到再问 VAE。

    Qwen 是 16、SD 系是 8。它决定「瓦片尺寸 / 重叠」从像素换算成多少格，
    也就决定整幅被切成几块 —— 写死 8 会让 Qwen 的块比声明的大一倍。
    """
    lf = 模型.get_model_object("latent_format")
    v = getattr(lf, "spacial_downscale_ratio", None)
    if not isinstance(v, int) or v <= 0:
        ratio = getattr(VAE, "downscale_ratio", None)
        if isinstance(ratio, (tuple, list)):
            ratio = ratio[1] if len(ratio) > 1 else None
        try:
            v = int(ratio)
        except (TypeError, ValueError):
            v = 0
    return v if isinstance(v, int) and v > 0 else 8


def _grid_starts(total, tile, stride):
    """长边 total、瓦片 tile、步长 stride 的起点列表：均匀铺满，最后一块必贴边。

    先算出需要几块，再反算间距让起点均匀分布。不能「按 stride 铺一遍 + 末尾硬塞
    total-tile」：那样最后一块与前一格的重叠会暴涨（实测声明 8 格实际 120 格），
    多出来的是整块被邻居盖住的冗余块，白算一遍还不讨好。
    """
    if total <= tile:
        return [0]
    span = total - tile
    # 块数下限：按目标步长 stride 铺满最少要几块（此时重叠 ≈ 声明的 ov，最省算力）
    n = math.ceil(span / stride) + 1
    # 块数上限：间距不得小于 tile/2，否则某块会被前后邻居完全盖住，
    # 羽化一升一降的区间就不再等长，权重和会失控（实测最大冲到 1.71）。
    # 冲突时优先保上限——宁可重叠比声明的大（多算点），也不能让画面被平均糊掉。
    n = min(n, math.floor(span / math.ceil(tile / 2)) + 1)
    n = max(2, n)
    # 整数间距铺开：间距只在 base / base+1 之间抖（用浮点步长再取整，会让间距在
    # 临界值两侧翻转，出现比 tile/2 还小的间距），且最后一块正好贴边。
    base, extra = divmod(span, n - 1)
    starts = []
    pos = 0
    for i in range(n):
        starts.append(pos)
        pos += base + (1 if i < extra else 0)
    return starts


def _tile_window_1d(size, lo, hi, dtype, device):
    """融合窗：核心 [lo, hi) 取 1，两侧羽化铺满整个重叠区（局部坐标）。

    lo = 左邻块的终点（首块为 0），hi = 右邻块的起点（末块为 size）。
    相邻两块落在同一段重叠区上，一个降一个升、区间长度相同，
    由 cos(π-t) = -cos(t) 得两者之和恒为 1 —— 与实际重叠是几格无关，
    这才是「权重和恒为 1」真正的前提（早先按声明的 ov 算核心区是错的）。

    lo == hi 是允许的：本块是纯过渡块（核心区为空），升区间和降区间正好首尾相接，
    与邻居仍然严格互补。lo > hi 表示本块被邻居完全盖住，此时无法互补，
    峰值落在中点兜底，调用处会打告警。
    """
    w = torch.zeros(size, dtype=dtype, device=device)
    lo = max(0, min(size, int(lo)))
    hi = max(0, min(size, int(hi)))
    if hi >= lo:
        w[lo:hi] = 1.0
        if lo > 0:
            t = torch.linspace(0.0, 1.0, lo, dtype=dtype, device=device)
            w[:lo] = 0.5 - 0.5 * torch.cos(t * math.pi)
        if hi < size:
            t = torch.linspace(0.0, 1.0, size - hi, dtype=dtype, device=device)
            w[hi:] = 0.5 - 0.5 * torch.cos((1.0 - t) * math.pi)
    else:
        mid = max(1, min(size - 1, int(round((lo + hi) / 2.0))))
        t = torch.linspace(0.0, 1.0, mid, dtype=dtype, device=device)
        w[:mid] = 0.5 - 0.5 * torch.cos(t * math.pi)
        t = torch.linspace(0.0, 1.0, size - mid, dtype=dtype, device=device)
        w[mid:] = 0.5 - 0.5 * torch.cos((1.0 - t) * math.pi)
    return w


def _sigmas_for(model_sampling, scheduler, steps, denoise):
    """官方 KSampler.set_steps 同口径：denoise 是「走完整日程的尾部几步」。

    算法（与 comfy/samplers.py 的 set_steps 逐字一致）：
      new_steps = int(steps / denoise)        # 反推完整日程有多长
      sigmas = calculate_sigmas(new_steps)    # 按完整长度算日程
      return sigmas[-(steps + 1):]            # 取尾部 steps+1 个点

    所以「步数 4 + denoise 0.4」真的会走 4 步——起点在约 57% 噪声处，
    不是只走 1 步。denoise 越小，起点越靠近清晰态，但走的步数不变。
    """
    if denoise is None or denoise > 0.9999:
        return comfy.samplers.calculate_sigmas(model_sampling, _bz_sched.resolve(scheduler), steps)
    new_steps = int(steps / denoise)
    sigmas = comfy.samplers.calculate_sigmas(model_sampling, _bz_sched.resolve(scheduler), new_steps)
    return sigmas[-(steps + 1):]


class BanZhang_ImageTiledKSampler:
    """分块二采：潜空间切块逐块采样，核心区窗口融合，显存峰值 ≈ 单瓦片。"""

    DESCRIPTION = (
        "大图分块采样：把上游放大好的潜空间切成瓦片，每块独立采样后\n"
        "按核心区 + 余弦过渡窗融合成整幅 —— 显存峰值 ≈ 单瓦片，4K/8K 不 OOM。\n"
        "入口只有一个「潜空间」：接「🖼️ 图片高清放大（二采重绘）」的输出。\n"
        "⚠ 分块买的是显存不是速度：总计算量 ≈ 块数 × 步数，瓦片越小块越多越慢。\n"
        "显存够跑整幅时，整幅 KSampler 更快。要求整流流模型 + 内置标准 euler。\n"
        "「瓦片尺寸 / 瓦片重叠」是像素口径，按模型的真实下采倍数换算\n"
        "（Qwen 是 16 倍，SD 系是 8 倍），填 1024 就是 1024 像素。\n"
        "块间一致性靠底图锚定：0.35~0.45 最稳，降噪越高块间内容差异越大，\n"
        "越靠参考图锚定一致性。\n"
        "「坐标对齐」让模型知道每块在整幅的位置（Qwen-Image 2.1 专用，消除接缝\n"
        "与重复主体）；「参考图分块」把参考图按块切开，每块只看自己那一块。\n"
        "两者都可以在出问题的时候单独关掉排查。"
    )

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "模型": ("MODEL", {
                    "tooltip": "整流流模型（SD3 / FLUX / Qwen-Image 等）；SD1.5 / SDXL 不支持。"}),
                "正面条件": ("CONDITIONING", {
                    "tooltip": "与二采提示词对应的正面条件。"}),
                "负面条件": ("CONDITIONING", {
                    "tooltip": "与二采提示词对应的负面条件。"}),
                "潜空间": ("LATENT", {
                    "tooltip": "已经放大并编码好的潜空间，接「🖼️ 图片高清放大（二采重绘）」的输出。\n"
                               "本节点不做放大，只做分块采样。"}),
                "随机种子": ("INT", {
                    "default": 0, "min": 0, "max": 18446744073709551615,
                    "control_after_generate": True,
                    "tooltip": "噪声从整幅一次生成后按块切用，重叠区两侧噪声一致。"}),
                "步数": ("INT", {
                    "default": 20, "min": 2, "max": 100, "step": 1,
                    "tooltip": "实际走几步（与官方 KSampler 同口径：步数填几就走几步，\n"
                               "不会被降噪缩水）。配加速 LoRA 时填 4。"}),
                "降噪强度": ("FLOAT", {
                    "default": 0.4, "min": 0.05, "max": 1.0, "step": 0.01,
                    "tooltip": "就是官方 KSampler 的 denoise，完全一致：\n"
                               "1.0 = 从纯噪声开始；0.4（Qwen 实测起点 sigma 0.571）同样走满「步数」步。\n"
                               "越低越忠实底图，越高变化越大。上游走像素放大时 0.35~0.45 够锐。"}),
                "引导系数": ("FLOAT", {
                    "default": 2.5, "min": 1.0, "max": 20.0, "step": 0.1,
                    "tooltip": "CFG。Qwen-Image 建议 2.5 左右。"}),
                "调度器": (_bz_sched.schedulers(), {
                    "default": "simple",
                    "tooltip": "sigma 日志形状，与官方 KSampler 同一套。"}),
                "瓦片尺寸": ("INT", {
                    "default": 1024, "min": 256, "max": 4096, "step": 64,
                    "tooltip": "每块边长（像素口径，按模型真实下采倍数换算：Qwen 是 16 倍）。\n"
                               "显存越紧越小。建议贴近模型的训练分辨率（Qwen 约 1024）。\n"
                               "切得太碎（块数暴涨）会让块间一致性变差。"}),
                "瓦片重叠": ("INT", {
                    "default": 64, "min": 0, "max": 512, "step": 8,
                    "tooltip": "相邻块的目标过渡带宽度（像素口径），必须小于瓦片尺寸的一半。\n"
                               "越大接缝越稳、块间重叠计算越多。\n"
                               "实际重叠会由网格自动微调，融合权重始终归一化，不会抹糊。"}),
                "坐标对齐": (["开", "关"], {
                    "default": "开",
                    "tooltip": "分块时告诉模型「这块在整幅图的哪个位置」，消除块间接缝与重复主体。\n"
                               "仅 Qwen-Image 2.1 生效，其他模型自动跳过（不报错）。\n"
                               "出了奇怪的重影 / 构图错乱就先关掉它排查。"}),
                "参考图分块": (["开", "关"], {
                    "default": "开",
                    "tooltip": "参考图按当前块的位置比例切成对应区域，每块只看自己那一块。\n"
                               "参考图比目标小很多时（比如 1280 参考图配 4096 目标）\n"
                               "切完信息量太少会伤画质，这种情况改关。"}),
            },
            "optional": {
                "VAE": ("VAE", {
                    "tooltip": "可接可不接：只在模型读不出下采倍数时，用来兜底换算瓦片尺寸。\n"
                               "正常情况留空即可，倍数直接从模型读取。"}),
            },
        }

    RETURN_TYPES = ("LATENT",)
    RETURN_NAMES = ("潜空间",)
    FUNCTION = "sample"
    CATEGORY = "👨‍🏫班长/MiniMax H3"

    # **_extra 吞掉旧版工作流残留的放大类参数（图片 / 放大路线 / 插值方式 等已删除项），
    # 老工作流不至于一打开就执行失败。
    def sample(self, 模型, 正面条件, 负面条件, 潜空间, 随机种子,
               步数, 降噪强度, 引导系数, 调度器, 瓦片尺寸, 瓦片重叠,
               坐标对齐="开", 参考图分块="开", VAE=None, **_extra):
        samples = 潜空间["samples"]
        if getattr(samples, "is_nested", False) or samples.ndim != 4:
            raise ValueError(f"{_TAG}：只支持普通 4 维图片潜空间")
        if samples.shape[0] != 1:
            raise ValueError(f"{_TAG}：仅支持 batch 1（当前 {samples.shape[0]}）")
        if 潜空间.get("noise_mask") is not None:
            raise ValueError(f"{_TAG}：分块二采暂不支持重绘蒙版（潜空间里带了 noise_mask）")

        model_sampling = 模型.get_model_object("model_sampling")
        sampler_obj = comfy.samplers.sampler_object("euler")
        _validate_sampling(model_sampling, sampler_obj)

        steps = int(步数)
        denoise = float(降噪强度)
        sigmas = _sigmas_for(model_sampling, 调度器, steps, denoise)
        actual_steps = len(sigmas) - 1
        if actual_steps < 1:
            raise ValueError(f"{_TAG}：日程不足 1 步，请调高步数")
        logging.info("[%s] 步数 %d ｜ 降噪 %.2f ｜ 实际走 %d 步（起点 sigma %.4f）",
                     _TAG, steps, denoise, actual_steps, float(sigmas[0]))

        h, w = int(samples.shape[2]), int(samples.shape[3])
        # 像素口径 → 潜空间格数必须按模型真实的下采倍数换算：Qwen 是 16 倍，
        # 写死 8 倍会让「瓦片 1024 像素」实际切出 2048 像素的块。
        d = _spatial_downscale(模型, VAE)
        tile = max(1, int(瓦片尺寸) // d)
        ov = max(0, int(瓦片重叠) // d)
        if ov >= tile // 2:
            raise ValueError(f"{_TAG}：「瓦片重叠」必须小于瓦片尺寸的一半")
        stride = tile - ov
        ys = _grid_starts(h, tile, stride)
        xs = _grid_starts(w, tile, stride)
        n_blocks = len(ys) * len(xs)
        logging.info("[%s] 潜空间 %dx%d 格（画面 %dx%d）｜ 瓦片 %d 格（%d 像素）｜ 重叠 %d 格 ｜ %d 行 × %d 列 = %d 块 ｜ %d 步 @ 降噪 %.2f ｜ 下采 %d 倍 ｜ 坐标对齐 %s ｜ 参考图分块 %s",
                     _TAG, h, w, w * d, h * d, tile, tile * d, ov, len(ys), len(xs), n_blocks,
                     len(sigmas) - 1, denoise, d, 坐标对齐, 参考图分块)
        for nm, st, tot in (("行", ys, h), ("列", xs, w)):
            gaps = [st[i + 1] - st[i] for i in range(len(st) - 1)]
            if gaps and (max(gaps) - min(gaps)) > 1:
                logging.warning("[%s] %s方向块间距不均 %s，画质可能受影响", _TAG, nm, gaps)

        device = comfy.model_management.intermediate_device()
        load_device = 模型.load_device
        model_options = 模型.model_options
        disable_pbar = not comfy.utils.PROGRESS_BAR_ENABLED

        # 噪声整幅一次生成后切块：重叠区两侧噪声一致，过渡更干净
        noise_full = comfy.sample.prepare_noise(samples, int(随机种子), None)
        out_sum = torch.zeros(samples.shape, dtype=torch.float32, device=samples.device)
        w_sum = torch.zeros((1, 1, h, w), dtype=torch.float32, device=samples.device)

        done = 0
        set_tile, uninstall = (None, None)
        if 坐标对齐 == "开":
            hooked = _tiled_rope.install(模型)
            if hooked is not None:
                set_tile, uninstall = hooked
        try:
            for bi, y0 in enumerate(ys):
                th = min(tile, h - y0)
                # 核心区按真实邻居划：左邻块终点 → 右邻块起点（首/末块贴画布边）
                y_lo = 0 if bi == 0 else ys[bi - 1] + tile - y0
                y_hi = th if bi == len(ys) - 1 else ys[bi + 1] - y0
                if y_lo > y_hi:
                    logging.warning("[%s] 行块 %d 被邻居完全覆盖，请调大瓦片尺寸", _TAG, bi)
                wy = _tile_window_1d(th, y_lo, y_hi, torch.float32, device)
                for xi, x0 in enumerate(xs):
                    tx = min(tile, w - x0)
                    x_lo = 0 if xi == 0 else xs[xi - 1] + tile - x0
                    x_hi = tx if xi == len(xs) - 1 else xs[xi + 1] - x0
                    if x_lo > x_hi:
                        logging.warning("[%s] 列块 %d 被邻居完全覆盖，请调大瓦片尺寸", _TAG, xi)
                    wx = _tile_window_1d(tx, x_lo, x_hi, torch.float32, device)
                    w_tile = (wy[:, None] * wx[None, :])[None, None]

                    if set_tile is not None:
                        sh, sw = _tiled_rope.tile_shifts(y0, x0, th, tx, h, w)
                        set_tile(th * tx, sh, sw)
                    pos_t, neg_t = 正面条件, 负面条件
                    if 参考图分块 == "开":
                        pos_t = _tiled_rope.slice_reference_latents(正面条件, y0, x0, th, tx, h, w)
                        neg_t = _tiled_rope.slice_reference_latents(负面条件, y0, x0, th, tx, h, w)

                    x_tile = samples[..., y0:y0 + th, x0:x0 + tx].to(device)
                    noise_tile = noise_full[..., y0:y0 + th, x0:x0 + tx].to(device)
                    block_seed = (int(随机种子) + bi * 977 + xi * 131) % (1 << 64)
                    out_tile = comfy.samplers.sample(
                        模型, noise_tile, pos_t, neg_t, float(引导系数),
                        load_device, sampler_obj, sigmas, model_options,
                        latent_image=x_tile, callback=None, disable_pbar=disable_pbar,
                        seed=block_seed)
                    out_sum[..., y0:y0 + th, x0:x0 + tx] += \
                        out_tile.to(device=samples.device, dtype=torch.float32) * w_tile
                    w_sum[..., y0:y0 + th, x0:x0 + tx] += w_tile
                    done += 1
                    logging.info("[%s] 块 %d/%d 完成（y%d x%d）", _TAG, done, n_blocks, y0, x0)
        finally:
            if uninstall is not None:
                uninstall()

        # 权重和自检：正常恒为 1；不是 1 说明有区域被多块平均，画面会糊
        w_min, w_max = float(w_sum.min()), float(w_sum.max())
        if w_max > 1.001 or w_min < 0.999:
            logging.warning("[%s] 融合权重和 %.3f~%.3f（正常应恒为 1.000），"
                            "画面可能被多块平均抹糊，请调大瓦片尺寸", _TAG, w_min, w_max)
        out = out_sum / w_sum.clamp_min(1e-6)
        logging.info("[%s] 分块二采完成：%d 块 × %d 步 ｜ 权重和 %.4f~%.4f",
                     _TAG, n_blocks, len(sigmas) - 1, w_min, w_max)
        result = dict(潜空间)
        result.pop("noise_mask", None)
        result["samples"] = out.to(device=comfy.model_management.intermediate_device(),
                                   dtype=comfy.model_management.intermediate_dtype())
        return (result,)


NODE_CLASS_MAPPINGS = {"BanZhang_ImageTiledKSampler": BanZhang_ImageTiledKSampler}
NODE_DISPLAY_NAME_MAPPINGS = {"BanZhang_ImageTiledKSampler": "🖼️ 图片分块二采"}
