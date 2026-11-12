# -*- coding: utf-8 -*-
"""
👨‍🏫 班长 SelfLift 渐进分辨率补丁（MiniMax H3）

把 SelfLift 的渐进分辨率采样改造成一个 MODEL → MODEL 补丁节点，直接配合
ComfyUI 原生采样器使用 —— 不需要替换 KSampler / SamplerCustom。

接法（两个节点都不需要 VAE）：
    MODEL ──► [🎯 SelfLift 渐进提升 / 多级渐进] ──► KSampler（采样器必须选 euler）

为什么能接原生采样器：
    本补丁挂在 comfy.patcher_extension.WrappersMP.SAMPLER_SAMPLE 上，而
    CFGGuider.inner_sample 在调用 sampler.sample 之前会套上这一层 wrapper。
    KSampler 与 SamplerCustom 两条路径都汇经此处，所以一个 MODEL 补丁即可
    覆盖全部原生采样器。

采样流程（论文 arXiv:2609.02036 · SelfLift-zero）：
    ① 前「过渡步数」步在低分辨率 latent 上跑（算力按面积下降）
    ② 取过渡步的干净端点预测 x0
    ③ 双路提升：直接 latent 上采样 vs VAE 像素重编码；两者残差即风险信号
    ④ 只修正风险最高的「修正比例」部分位置
    ⑤ 按过渡 sigma 重新加噪，剩余步在满分辨率跑完

    总 NFE 严格不变：过渡步的 Euler 更新被丢弃后在过渡处重建。

本版范围（仅 MiniMax H3）：
    · 支持：文生视频、带 keyframe / 参考图的条件生成
    · 噪声掩码（如「H3 Latent放大」写入的音频保留掩码）：按流透传 —— 视频流
      随每级网格缩放，音频流原样保留
    · 满分辨率收尾可选「逐步同步分块」（连接「满分辨率分块参数」）：分块机制与
      「MMH3 终极放大」同源，显存峰值≈单块，8G 级小显存也能跑满分辨率阶段；
      要求 keyframe 与画布同网格
    · 暂不支持：高分辨率阶段换模型。会在采样开始时直接报错说明，
      而不是静默给出错误结果。
"""

import contextlib
import logging
import os
import time

import torch

import comfy.k_diffusion.sampling
import comfy.model_base
import comfy.model_management
import comfy.model_sampling
import comfy.nested_tensor
import comfy.patcher_extension
import comfy.hooks
import comfy.sampler_helpers
import comfy.sample
import comfy.samplers
import comfy.utils
import latent_preview

from .banzhang_mmh3_upscale import H3_SPATIAL_PARAM as _H3_SPATIAL_PARAM
# 余弦羽化窗：2026-10 起 SelfLift 的分块融合改用二元核心区独占（去重影），
# 该函数不再被调用，保留导入以便需要 A/B 对照旧行为时直接取用。
from .banzhang_mmh3_upscale import _make_core_window_1d as _core_window_1d  # noqa: F401
# 时间分块整套沿用「🎬 H3 终极放大」的成熟实现，不在这里另写一套：
#   _h3_temporal_windows —— 5+17k 合法档位吸附 + 窗口规划（含吸附日志）
#   _temporal_segments   —— 窗口 → 视频/音频切片边界（尾部补窗的重叠按实际边界算）
#   _frame_offsets       —— latent 步 ↔ 像素帧换算
# 三者在那边已经被实测跑熟（跳变、花屏、音画错位都修完了），复制的代价是
# 以后要同步维护两份，所以直接导入。
from .banzhang_mmh3_upscale import (
    _h3_temporal_windows as _h3_time_windows,
    _temporal_segments as _h3_time_segments,
    _frame_offsets as _h3_frame_offsets,
)
from .banzhang_h3_tile_pos import (
    install as _install_tile_pos,
    set_tile_offset as _set_tile_offset,
    clear_tile_offset as _clear_tile_offset,
)

# 导演台的「放大重绘条件未升级」标记：条件与一采逐字相同时，三采纯属白跑，
# 本文件两个节点（放大重绘 / 放大采样器）据此直通。口径与导演台共用一份。
from .csglide_assets import hd_upgraded as _hd_upgraded

from .banzhang_h3_latent_upscaler_3d import (
    MinimaxH3LatentUpscaler3D as _H3LatentUpscaleNode,
    UpscaleMode as _UpscaleMode,
    UpscaleWay as _UpscaleWay,
    _TILE_OFF as _UPSCALE_TILE_OFF,
    _VRAM_PRESETS as _UPSCALE_VRAM_PRESETS,
    scan_models as _upscale_scan_models,
)

from . import banzhang_schedulers as _bz_sched

# V3 节点接口（DynamicCombo 控件需要）：「放大方式 / 放大模式」要像
# 「🎬 H3 Latent放大」一样按选中项自动弹出/收起子参数。
try:
    from comfy_api.latest import io
except ImportError:
    from .banzhang_h3_latent_upscaler_3d import io  # 老版 ComfyUI 兜底

from .selflift import h3_lifter as _lifter
from .selflift import selflift as _lifts

log = logging.getLogger("BanzhangSelfLift")

_WRAPPER_KEY = "banzhang_selflift_progressive"


def _euler_step(state, denoised, sigma, sigma_next):
    """标准 Euler 更新：x + (x - x0) * (σ_next - σ) / σ。"""
    step = ((sigma_next - sigma) / sigma).to(device=state.device, dtype=state.dtype)
    return state + (state - denoised) * step


def _hand_off(t, device):
    """交给 sampler.sample 之前的设备/精度归一。

    CFGGuider.outer_sample 原本负责把 noise/latent_image 搬到 load_device 并转成
    float32，本补丁自己发起低分辨率前缀、又直接续跑高分辨率（都绕过了 outer_sample），
    所以必须自己补上这一步 —— prepare_noise 给的是 CPU 张量。
    """
    return t.to(device=device, dtype=torch.float32)


# 提升后 latent 的离群值钳位（彩色光斑圆点的兜底）
# 阈值取稳健标准差的倍数：H3 各通道量级差很大（std 0.45~3.28），全局阈值会误伤
# 本就方差大的通道，所以按通道统计；MAD 估 σ 不会被爆表点本身撑大。
# 9σ 是怎么定下来的：MAD 稳健 σ 下，真高斯数据落到 9σ 之外的概率约 1e-19，
# 等于"正常画面根本不可能撞到"，所以降到 9 不会误伤画面；而实测里造成彩色光点的
# 离群值有的只有 8.7σ（原先 12σ 的门槛碰不到它们），故下调。再往下调（如 6σ）
# 就有真实高对比细节被削平的风险，不建议。
_OUTLIER_SIGMAS = 9.0
# 熔断：超标点占比超过这个值就不算"离群"，而是 latent 整体失控，此时按 9σ
# 全钳只会把画面削平。但完全不钳又会留下肉眼可见的彩色光点——所以熔断后改为
# 只钳最极端的一小撮（下面这个比例），既不动画面主体、又灭掉最刺眼的点。
_OUTLIER_ABORT_FRAC = 5e-3
# 熔断后的兜底钳位比例（占全张量）：只钳最极端的这一撮
_OUTLIER_ABORT_CLAMP_FRAC = 5e-4


def _winsorize_outliers(z, tag="", sigmas=None):
    """把提升后 latent 里极少数爆表点截断回稳健范围。

    为什么需要：低分辨率阶段的 x0 预测偶发离群值，放大模型会把它们一起放大，
    满分辨率步数不够时洗不掉，VAE 解码后就是五颜六色的光晕圆点。
    只截断极值、不改其余位置，正常画面零影响。

    ``sigmas`` 为 None 时用模块级默认阈值 ``_OUTLIER_SIGMAS``（9.0）；
    多级节点把它做成可调参数，实测造成彩色光点的离群值有的只有 8.7σ，
    紧贴 9σ，必要时可下调到 7~8σ 救急。
    """
    thr = _OUTLIER_SIGMAS if sigmas is None else float(sigmas)
    c_first = z.movedim(1, 0)                       # [C, B, T, H, W]
    x = c_first.reshape(c_first.shape[0], -1)
    med = x.median(dim=1, keepdim=True).values
    sigma = 1.4826 * (x - med).abs().median(dim=1, keepdim=True).values
    sigma = sigma.clamp(min=1e-6)
    dev = (x - med).abs() / sigma                   # 每处偏离稳健中位数的 σ 数
    peak = float(dev.max())
    sel = dev > thr
    n = int(sel.sum())
    if n == 0:
        log.info("[班长SelfLift·钳位]%s 稳健σ̂=%.3f 峰值 %.1fσ，无离群点",
                 tag, float(sigma.mean()), peak)
        return z
    frac = n / x.numel()
    if frac > _OUTLIER_ABORT_FRAC:
        # 整体失控：不按阈值全钳（那会把画面削平），改为只钳最极端的一小撮——
        # 它们正是肉眼可见的彩色光点；画面其余部分原样保留。
        k = min(max(1, int(x.numel() * _OUTLIER_ABORT_CLAMP_FRAC)), x.numel())
        thr2 = torch.topk(dev.reshape(-1), k, largest=True, sorted=False).values.min()
        sel2 = dev >= thr2
        out = torch.where(sel2, med + thr * sigma * (x - med).sign(), x)
        log.warning("[班长SelfLift·钳位]%s 超 %.0fσ 的点占 %.2f%%，已越 %.2f%% 熔断线 —— "
                    "整体失控不按 %.0fσ 全钳，只钳最极端的 %d 处（峰值 %.1fσ）；"
                    "仍建议调低过渡步数 / 调小倍率",
                    tag, thr, 100.0 * frac, 100.0 * _OUTLIER_ABORT_FRAC,
                    thr, int(sel2.sum()), peak)
        return out.to(z.dtype).reshape(c_first.shape).movedim(0, 1)
    out = torch.where(sel, med + thr * sigma * (x - med).sign(), x)
    log.info("[班长SelfLift·钳位]%s 稳健σ̂=%.3f 钳位 %d 处（%.4f%%）峰值 %.1fσ -> %.1fσ",
             tag, float(sigma.mean()), n, 100.0 * frac, peak,
             float(((out - med).abs() / sigma).max()))
    return out.to(z.dtype).reshape(c_first.shape).movedim(0, 1)


def _split_denoise_mask(denoise_mask, shapes):
    """把 CFGGuider 打包好的噪声掩码按流拆开（H3：视频, 音频）；无掩码返回 None。"""
    if denoise_mask is None:
        return None
    return comfy.utils.unpack_latents(denoise_mask.float(), shapes)


def _denoise_mask_for_grid(mask_streams, shapes):
    """按某级网格重建打包掩码：视频流随该级网格缩放，音频流原样（没有空间维度）。

    各流掩码进来时已是该流的完整形状（CFGGuider 已按 latent_shapes 备好），
    所以只缩放 [2:] 维，批次/通道数保持不变。
    """
    if mask_streams is None:
        return None
    streams = []
    for mask, shape in zip(mask_streams, shapes):
        if tuple(mask.shape) != tuple(shape):
            mode = "trilinear" if len(shape) == 5 else "bilinear"
            mask = torch.nn.functional.interpolate(
                mask, size=shape[2:], mode=mode, align_corners=False)
        streams.append(mask.to(torch.float32))
    return comfy.utils.pack_latents(streams)[0]


def _resume_pack_with_pure_audio(resume_pack, audio_anchor, sigma_start):
    """把「换纸状态」的音频流拆成纯 x0 锚点 + 补偿噪声（视频流原样）。

    resume_pack 是 x0 内嵌噪声的表示：noise_scaling(σ, 0, resume_pack) = (1-σ)·resume_pack
    恰好还原流状态。但保留区混合（音频掩码 < 1）把 latent_image 当纯 x0 用 —— 音频流里
    的内嵌噪声会被当成预测残差，噪声水平逐段漂移，音频发闷、破损。这里把 latent_image
    的音频换成纯锚点，差额用配套噪声补回，使初始状态逐位不变：
        (1-σ)·锚点 + σ·噪声 = (1-σ)·resume_pack
    音频流位于打包尾部（打包顺序恒为 视频, 音频）。
    """
    latent = resume_pack.clone()
    noise = torch.zeros_like(resume_pack)
    a = audio_anchor.reshape(resume_pack.shape[0], 1, -1).to(resume_pack.dtype)
    tail = -a.shape[-1]
    noise[..., tail:] = (resume_pack[..., tail:] - a) * ((1.0 - sigma_start) / sigma_start)
    latent[..., tail:] = a
    return noise, latent


def _resize_keyframes(conds, h, w):
    """keyframe 条件 latent 与生成网格同分辨率，低分辨率前缀下须同步缩放。

    ``conds`` 是 ``convert_cond`` 之后的形式 —— dict 列表（不是 (tensor, dict) 元组）。
    就地在传入的副本上改写，不触碰原始条件；返回同一个列表便于链式调用。
    """
    for d in conds:
        kfs = d.get("minimax_keyframes")
        if kfs is None:
            continue
        resized = []
        for kf in kfs:
            kf = dict(kf)
            lat = kf.get("latent")
            if lat is not None and (lat.shape[-2] != h or lat.shape[-1] != w):
                if lat.ndim == 5:
                    # 逐帧做纯空间缩放，绝不跨时间插值
                    batch, channels, frames = lat.shape[:3]
                    new_lat = torch.nn.functional.interpolate(
                        lat.float().permute(0, 2, 1, 3, 4).reshape(
                            batch * frames, channels, lat.shape[-2], lat.shape[-1]),
                        size=(h, w), mode="bilinear", align_corners=False)
                    new_lat = new_lat.reshape(batch, frames, channels, h, w).permute(0, 2, 1, 3, 4)
                else:
                    new_lat = torch.nn.functional.interpolate(
                        lat.float(), size=(h, w), mode="bilinear", align_corners=False)
                # 逐通道逐帧均值对齐：抹掉双线性的色偏，又不引入低分辨率网格表达不了的方差
                source_mean = lat.float().mean(dim=(-2, -1), keepdim=True)
                new_mean = new_lat.mean(dim=(-2, -1), keepdim=True)
                kf["latent"] = (new_lat + (source_mean - new_mean)).to(lat)
            resized.append(kf)
        d["minimax_keyframes"] = resized
    return conds


# 满分辨率前向需要的激活余量（相对低分辨率多出来的那部分）。
# H3 的注意力是 O(S)（SLA / sage / flash），所以峰值大致随 packed 序列长度线性增长：
# 0.5 缩放时 rows_per_frame 45 -> 180（4 倍），S ≈ 38k token、hidden 5376、bf16，
# 单个激活张量约 0.4GB，同时存活几个量级就是 2GB。取 2GB 作为默认门槛，
# 可用 SELFLIFT_HEADROOM_MB 覆盖。这个值只决定「要不要动手」，不决定卸多少。
_HEADROOM_BYTES = int(os.environ.get("SELFLIFT_HEADROOM_MB", "2048")) * 1024 ** 2


def _ensure_highres_headroom(keep_patcher, device, need=None):
    """为满分辨率阶段凑显存预算，返回 (处理方式, 当前可用字节, 实际释放字节)。

    为什么要凑：低分辨率阶段结束后，过渡要先解码/重编码像素锚点，VAE 会在此时被
    载入。随后满分辨率首次前向要为 grid_rows 45 -> 180 重新录制 aimdo 的显存图
    （"Model ... prepared for dynamic VRAM loading" 那套）。预算不足时录制静默失败，
    整段退化为逐层换页 —— 不报错、不 OOM，只是慢 6~30 倍，现象就是「卡住不动」。

    关键是**按需**，而不是「卸掉一切」：
      · 可用显存本来就够 → 完全不动，VAE 原地保留，后续节点零代价；
      · 不够 → 先 soft_empty_cache（只回收缓存块，不动任何模型，零代价）；
      · 还够不上 → 才动非扩散模型，而且只按需要求的量去凑。
    free_memory() 是按 memory_required 凑的：当 memory_to_free 小于模型大小时，
    LoadedModel.model_unload 会走 partially_unload 分支**只换出一部分**
    （见 comfy/model_management.py:835-845），模型不会被整个 detach。
    之前这里传 1e30，memory_to_free 远大于模型大小，才导致 VAE 被完整卸掉、
    后续节点得重新载入。

    只保留 clone_base_uuid 相同的那个扩散模型（clone() 会沿用该 uuid），
    与 ComfyUI unload_model_and_clones 的判据一致。
    """
    mm = comfy.model_management
    need = _HEADROOM_BYTES if need is None else int(need)
    free = mm.get_free_memory(device)
    if free >= need:
        return "充裕，未动显存", free, 0

    mm.soft_empty_cache()                     # 零代价：只回收缓存块
    free = mm.get_free_memory(device)
    if free >= need:
        return "回收缓存后够用", free, 0

    base = getattr(keep_patcher, "clone_base_uuid", None)
    keep = [m for m in mm.current_loaded_models
            if m.model is not None and getattr(m.model, "clone_base_uuid", None) == base]
    if not keep:
        # 认不出来就什么都别动，宁可慢也不要误卸 20GB 的扩散模型触发重新加载
        log.warning("[班长SelfLift] 未能从 current_loaded_models 认出扩散模型，跳过按需释放")
        return "认不出扩散模型，未动手", free, 0

    before = free
    mm.free_memory(need, device, keep)        # 只凑 need；能部分换出就部分换出
    freed = max(0, mm.get_free_memory(device) - before)
    if freed > 4 * need:
        log.warning("[班长SelfLift] 按需释放却给出 %.1fGB（需求仅 %.1fGB），"
                    "疑似把扩散模型也卸了，下一层前向会重新载入 20GB",
                    freed / 1024 ** 3, need / 1024 ** 3)
    return "按需释放", before + freed, freed


# ============================================================
# 满分辨率分块收尾（逐步同步单轴分块 Euler）
#
# 机制与「MMH3 终极放大」的同步分块同源：每 sigma 步依次预测全部 tile，
# 按核心区窗口融合成全局 denoised 再推进一次，显存峰值≈单块。
# 与整幅路径逐点对应：
#   · KSAMPLER.sample 的 noise_scaling / inverse_noise_scaling 由调用方完成；
#   · KSamplerX0Inpaint 的掩码预混合/回混在整幅层面复现（tile 只做预测）；
#   · tile 预测直接调 guider（CFGGuider），cond 的空间相关部分逐 tile 改写。
# ============================================================

def _tile_stride_even(total, n_tiles):
    """单轴核心区步长（偶数对齐）。与 _tile_starts_even 同源，单独抽出来是给
    「重叠自适应」复用——重叠的合理上限取决于步长，得先知道步长才能定。

    H3 按 2×2 patch 切 token，步长取偶才能让核心区边界落在 patch 网格上。"""
    return max(2, int(round(total / n_tiles / 2)) * 2)


# 重叠自适应的两个系数（见 _fit_overlap_to_stride）
_OVERLAP_MIN = 4        # 最少 4 格（=64 像素）：再少核心区拿不到上下文，会造分身/蠕动
_OVERLAP_RATIO = 0.5    # 最多占核心区步长的一半


def _fit_overlap_to_stride(overlap, stride):
    """重叠自适应：把请求的重叠收窄到「够用且不浪费」的区间。

    overlap 的唯一职责是给核心区补上下文，它本身是**纯开销**——重叠区被相邻块的
    核心区覆盖，本块算出来的那部分在融合时会被丢掉。块数一加密 stride 就变小，
    若重叠固定不动，tile 会被撑到 stride 的数倍（用户实测的典型工况）：
        stride=10 / overlap=8 → tile=26，实算 2.6 倍面积（62% 是白算的）
        stride=34 / overlap=8 → tile=50，只多算 47%（本来就合理）
    让重叠跟着步长按比例收窄，大块保持原样、小块自动瘦身，块数多时省下的是
    每一步 × 每一块的实打实算力。同时保留最小值保证上下文质量不塌。"""
    ov = (max(0, int(overlap)) // 2) * 2
    cap = max(_OVERLAP_MIN, (int(stride * _OVERLAP_RATIO) // 2) * 2)
    return int(min(ov, cap))


def _tile_starts_even(total, n_tiles, overlap):
    """单轴分块（偶数对齐版）。stride / overlap / tile 边界全部取偶，让 tile 与
    H3 的 2×2 patch 网格对齐——掩码与 keyframe 的裁切才不会跨 patch 错位。
    核心区划分公式与第三方实现一致：任意分块几何下核心区完整覆盖长轴。"""
    overlap = max(2, int(overlap)) // 2 * 2
    stride = _tile_stride_even(total, n_tiles)
    tile_size = stride + 2 * overlap
    # 补尾（与主节点同一口径）：核心区边界按画布全长均分，而不是用 stride 累加。stride 取偶
    # 会累积零头，按 stride 累加会让末块窗口盖不到画布末端 → 末端几列不落在任何融合窗内
    # → 权值为 0 → 被合并除法压成 0。均分边界可在块数、块尺寸都不变的前提下盖满末端，
    # 既不多切一块，也不留窄块（窄块上下文不足会造出分身 / 蠕动的一团）。
    starts = []
    for i in range(n_tiles):
        b = ((int(round(i * total / n_tiles)) + 1) // 2) * 2
        starts.append(max(0, b - overlap))
    dedup = []
    for s in starts:
        if not dedup or s > dedup[-1]:
            dedup.append(s)
    return dedup, tile_size


def _crop_axis(t, axis_dim, lo, hi):
    sl = [slice(None)] * t.ndim
    sl[axis_dim] = slice(lo, hi)
    return t[tuple(sl)].contiguous()


# ============================================================
# 满分辨率收尾的智能分块（6G 显存可用性的关键）
#
# 校准锚点（与本文件 _HEADROOM_BYTES 上方同一组实测注释）：
#   hidden 5376、bf16、注意力 O(S) —— 峰值随 packed 序列长度线性增长。
#   0.5 缩放（45 rows/帧）时 S ≈ 38k token → 单张量 0.4GB，
#   同时存活约 5 个量级 ≈ 2GB。
# 由此反推两个系数：
#   时间膨胀 = 38k / (45 rows × 107 帧) ≈ 8  —— packed 布局的时间维摊薄系数
#   存活张量 = 2GB / 0.4GB = 5
# 块数只影响激活峰值，不影响权重（权重由 aimdo 逐层换页自管），所以
# 「整幅激活 ÷ 预算」向上取整就是能塞下的最少块数。
# ============================================================
_H3_HIDDEN = 5376
_TIME_TOKEN_FACTOR = 8          # 时间维膨胀（由 38k 锚点反推的校准值）
_ACT_ALIVE = 5                  # 同时存活的激活张量数（2GB / 0.4GB）
_AUTO_MARGIN = int(1.5 * 1024 ** 3)   # 给 aimdo 权重页 / 碎片留的工作空间
# 块数上限：8 是老版本拍出来的，低显存跑大画布会被卡死 —— 1248x704 整幅激活
# ≈37GB，6G 卡要 13 块，8 块必爆；16 块每块 2.3GB 实测能跑（用户实测背书）。
# 块数只增加融合次数（每步 N 次前向），不增加单次前向的激活峰值，所以放宽到
# 16 只会变慢，不会更爆。
_TILE_MAX = 16

_TILE_MODE_AUTO = "自动（按显存智能规划）"
_TILE_MODE_OFF = "关（整幅收尾）"
_TILE_MODE_CHOICES = [
    _TILE_MODE_AUTO, _TILE_MODE_OFF,
    "2 块（接缝最少）", "4 块（均衡）", "8 块（省显存）", "16 块（低显存救急）",
]

# 时间分块（末段沿时间轴切开跑）——主省显存手段，语义照搬「🎬 H3 终极放大参数」。
# 「开」用下面的「每块帧数 / 重叠帧数」；「自动」按空闲显存反推窗口数，够就不切。
_TIME_MODE_AUTO = "自动（显存不够才切）"
_TIME_MODE_OFF = "关（整条收尾）"
_TIME_MODE_ON = "开（用下面两个参数）"
_TIME_MODE_CHOICES = [_TIME_MODE_AUTO, _TIME_MODE_OFF, _TIME_MODE_ON]

# —— 老工作流兼容：认不出的值退回安全默认，不整条工作流报错 ——
# ComfyUI 按位置存 widgets_values，节点增删控件都会让老存档整列错位。


def _coerce_time_mode(value) -> str:
    """老工作流的 widgets_values 按位置存：新增控件后老存档里这一格可能是别的值。"""
    if isinstance(value, str) and value in _TIME_MODE_CHOICES:
        return value
    log.warning("「时间分块」收到无法识别的值 %r（多为老工作流控件位置错位），"
                "本次按「自动」处理。", value)
    return _TIME_MODE_AUTO


def _coerce_int(value, default: int, name: str) -> int:
    try:
        n = int(round(float(value)))
    except (TypeError, ValueError):
        log.warning("「%s」收到无法识别的值 %r（多为老工作流控件位置错位），本次按 %d 处理。",
                    name, value, default)
        return default
    return n


def _auto_tiles_for_vram(free_bytes, H, W, t_frames):
    """按空闲显存反推末段需要的块数。返回 0=显存富余整幅 / 2~8=块数。

    拿不到显存信号（free_bytes 为空）时返回 0 之外的做法是危险的 —— 那会
    在最需要分块的机器上误判成整幅。所以这里返回 None 让调用方退回
    tw 自动推算档，而不是猜一个数。
    """
    if not free_bytes or free_bytes <= 0 or not t_frames:
        return None
    rows = (max(2, H) // 2) * (max(2, W) // 2)      # 2×2 patch 后的行数/帧
    s_tokens = rows * max(1, int(t_frames)) * _TIME_TOKEN_FACTOR
    act_full = s_tokens * _H3_HIDDEN * 2 * _ACT_ALIVE
    budget = free_bytes - _AUTO_MARGIN
    if budget <= 0:
        log.warning("[班长SelfLift·分块] 空闲显存 %.2fGB 连安全余量 %.1fGB 都不够，"
                    "按 8 块极限尝试（大概率仍紧张：建议缩短时长或减小画布）",
                    free_bytes / 1024 ** 3, _AUTO_MARGIN / 1024 ** 3)
        return 8
    if act_full * 2 <= budget:
        return 0            # 激活只占预算一半以下 → 整幅最干净，不付融合代价
    n = -(-act_full // budget)                      # 整数上取整，不引 math
    if n > _TILE_MAX:
        log.warning("[班长SelfLift·分块] 整幅激活估算 %.1fGB，按 %.2fGB 预算需要 %d 块，"
                    "超过 %d 块上限 —— 本次按 %d 块尽力跑；要稳定请缩短视频时长或减小画布",
                    act_full / 1024 ** 3, budget / 1024 ** 3, n, _TILE_MAX, _TILE_MAX)
    return int(min(_TILE_MAX, max(2, n)))


def _tile_choice_to_n(choice):
    """下拉文案 → n_tiles 语义：关=None（整幅）/ 自动=0（智能）/ N=手动块数。"""
    text = str(choice)
    if "关" in text:
        return None
    head = text.split(" ")[0]
    try:
        return max(0, int(head))
    except ValueError:
        return 0            # 自动档（文案不带数字）


def _plan_fullres_tiling(sp, H, W, n_tiles_manual=None, free_bytes=None, t_frames=None):
    """按「H3 终极放大参数」的空间分块语义规划满分辨率收尾的切条。
    返回 None 表示退回整幅收尾——只会发生在两种情形：
      ① 画布太小（长边 ≤ mt 门槛）：加密救不了，画布本身就切不出有意义的块；
      ② overlap 被设得异常大（羽化带占满整块）：加密到 _TILE_MAX 仍退化，
        此时打警告说明，让用户去调 overlap 而不是默默整幅爆显存。

    其余一切"切了等于没切"（tile ≥ 0.9 倍轴长）的情形，三条路径统一自动加密
    块数直到能切或到 _TILE_MAX。理由：退整幅会把小显存用户炸回 OOM——
    退化区间是长边 60~100 格（960~1600px，含 1248x704），整幅激活可达数十 GB，
    而加密一次（2→3 块）就能切，24G 卡可救；6G 卡则应改用多级/二合一的智能档。
    「MMH3 终极放大」是独立实现，不受本函数行为变化影响。

    ``n_tiles_manual`` 三态语义（只决定加密的起点，不决定是否加密）：
      · None —— 外部「H3 终极放大参数」路径（字典里没有 n_tiles 键）：
        按 tw 自动推算起点块数（该参数节点的原口径）；
      · 0 —— 智能模式：按 free_bytes / t_frames 反推起点块数（见 _auto_tiles_for_vram）；
      · 2~_TILE_MAX —— 手动块数。
    """
    long_edge = max(H, W)
    if long_edge <= sp.get("mt", 24):
        return None
    if n_tiles_manual is None:
        tile_px = sp.get("tw", sp.get("th", 40))
        n_tiles = min(8, max(2, int(round(long_edge / max(1, tile_px)))))
    else:
        n_tiles = (int(n_tiles_manual) if n_tiles_manual > 0
                   else _auto_tiles_for_vram(free_bytes, H, W, t_frames))
        if n_tiles == 0:
            return None
        n_tiles = min(_TILE_MAX, max(2, n_tiles))
    overlap_req = max(0, min(32, int(sp.get("ol_w", sp.get("ol_h", 8)))))
    feather = max(0, min(16, int(sp.get("feather", 4))))
    axis = "H" if H >= W else "W"
    axis_total = H if axis == "H" else W
    # 重叠自适应：加密块数时同步收窄重叠，避免 tile 被撑成 stride 的数倍。
    # 副作用是「切了等于没切」的退化判据更容易解除（tile 变小了）。
    overlap = _fit_overlap_to_stride(overlap_req, _tile_stride_even(axis_total, n_tiles))
    starts, tile_size = _tile_starts_even(axis_total, n_tiles, overlap)
    while (len(starts) <= 1 or tile_size >= axis_total * 0.9) and n_tiles < _TILE_MAX:
        n_tiles += 1
        overlap = _fit_overlap_to_stride(overlap_req,
                                         _tile_stride_even(axis_total, n_tiles))
        starts, tile_size = _tile_starts_even(axis_total, n_tiles, overlap)
    if overlap < overlap_req:
        log.info("[班长SelfLift·分块] 长边 %d 格 / %d 块 → 步长 %d 格，"
                 "重叠按步长自适应 %d → %d 格（省 %.0f%% 面积）",
                 axis_total, n_tiles, _tile_stride_even(axis_total, n_tiles),
                 overlap_req, overlap,
                 100.0 * (1.0 - (tile_size / max(1, tile_size + 2 * (overlap_req - overlap)))))
    # 块数多、重叠又被压到下限时，运动画面容易沿固定接缝出现果冻状扭动
    #（块间无跨块注意力，接缝两侧运动预测逐帧独立、硬切不混合）。
    if n_tiles >= 6 and overlap <= _OVERLAP_MIN:
        log.warning(
            "[班长SelfLift·分块] %d 块时重叠被压到下限 %d 格（%dpx），"
            "运动画面沿接缝出现果冻状扭动的风险高。显存够就把「满分辨率分块」"
            "改成「关（整幅收尾）」；显存不够就尽量减少块数（2~4 块），"
            "并缩短时长 / 减小画布让自动档少切几块。",
            n_tiles, overlap, overlap * 16)
    if len(starts) <= 1 or tile_size >= axis_total * 0.9:
        log.warning(
            "[班长SelfLift·分块] 长边 %d 格加密到 %d 块仍切不开（tile %d ≥ 0.9×%d）——"
            "多半是 overlap(%d 格) 相对画布太大。本次退回整幅，显存可能不够；"
            "请调小 overlap 或加大画布", axis_total, n_tiles, tile_size,
            axis_total, overlap)
        return None
    return axis, starts, tile_size, overlap, feather


# ============================================================
# 末段的时间分块（主省显存手段）
#
# 机制照搬「🎬 H3 终极放大参数」的共享轨迹实现（那边已经跑熟）：
# 每个 sigma 步依次前向所有时间窗，各窗都读同一份全局 latent、同一噪声水平，
# 只把各自的预测按**三角羽化**权重累加进同一份 denoised，再统一推进一次 Euler。
# 为什么不是「各窗各跑完整行程再拼」：那样两侧的中间态不同，段边界就是硬切（跳变）。
# 为什么不用二元核心区独占：每帧只由唯一一个窗负责时，落在窗边缘的帧前向时看不到
# 窗外内容，预测比中心帧弱 → 成片出现「整段像被 0.5 强度重绘了一遍」的台阶。
# ============================================================

def _temporal_feather(n, device):
    """三角羽化窗：中心 1、两端递降到 ~0。

    端点取 i+0.5 而不是 i —— 权重永远严格大于 0，片头（只有第一个窗覆盖）和片尾
    （只有最后一个覆盖）那一端归一化后仍然是它自己的值，不会 0/0 变成黑段。
    """
    n = max(1, int(n))
    i = torch.arange(n, device=device, dtype=torch.float32) + 0.5
    return torch.minimum(i, n - i) / (n * 0.5)


def _plan_temporal_segs(total_t, audio_total, mode, chunk_frames, overlap_frames,
                        H, W, free_bytes):
    """规划末段的时间窗。返回 segs 或 None（None = 整条收尾，与旧版行为一致）。

    segs 元素：(视频起, 视频止, 音频起, 音频止)，单位是各自 latent 的步 / 格。
    窗口规划、5+17k 合法档位吸附、音频边界换算全部走「🎬 H3 终极放大」的成熟实现，
    这里只负责「切不切、切多大」这一个决定。
    """
    if mode == _TIME_MODE_OFF:
        return None
    chunk = None
    if mode == _TIME_MODE_AUTO:
        need = _auto_tiles_for_vram(free_bytes, H, W, total_t)
        if need is not None:
            if not need:
                log.info("[班长SelfLift·时间] 自动档：空闲显存够整条收尾，本次不切时间块")
                return None
            # 整幅激活需要几份预算 ≈ 该切成几段；每段帧数 = 总帧数 / 段数。
            # 必须在这里先吸附到 5+17k 合法档位：_h3_time_windows 内部用 int()
            # 截断，13.9 帧会被截成 13、吸附到 5 帧档 —— 5 帧窗没有 smaller 档，
            # 直接退回整条，显存救场就静默失效了。
            total_frames = _h3_frame_offsets(total_t)[-1]
            target = total_frames / float(need)
            legal = [5 + 17 * k for k in range((total_frames - 5) // 17 + 1)]
            chunk = float(min(legal, key=lambda n2: abs(n2 - target))) if legal else target
            # 5 帧窗只有 2 个 latent 步，切出来全是碎片；最少从 22 帧（≈1 秒）起。
            # 片长真不够 22 帧时 _h3_time_windows 自己会退回整条，不会硬切。
            chunk = max(chunk, 22.0)
        # need is None（读不到显存信号）→ 退回用户填的「每块帧数」，宁可切也不炸
    if chunk is None:
        chunk = float(chunk_frames)
    windows, _ov = _h3_time_windows(total_t, chunk, overlap_frames)
    if len(windows) <= 1:
        log.info("[班长SelfLift·时间] 片长 %d 步 / 块长 %.0f 帧 → 只切出 1 段，"
                 "本次按整条收尾", total_t, chunk)
        return None
    segs = [(s, e, a0, a1)
            for (s, e, _lk, a0, a1, _al)
            in _h3_time_segments(total_t, audio_total, windows)]
    log.info("[班长SelfLift·时间] 末段改走共享轨迹时间分块：%d 段"
             "（各窗共用同一条去噪轨迹、同一噪声水平，段间三角羽化融合）", len(segs))
    return segs


def _validate_tiling_keyframes(guider, H, W):
    """分块收尾要求 keyframe 与画布同网格（fl2va 的 cond 行共享目标空间网格）。
    异网格 keyframe 无法安全裁切，采样开始时直接报错说明。"""
    for conds in (guider.conds or {}).values():
        for d in conds:
            if not isinstance(d, dict):
                continue
            pc = (d.get("model_conds") or {}).get("minimax_payload")
            payload = pc.cond if pc is not None else None
            for kf in (payload or {}).get("keyframes") or ():
                lat = kf.get("latent")
                if lat is not None and (lat.shape[-2] != H or lat.shape[-1] != W):
                    raise ValueError(
                        "🎯 SelfLift 渐进提升：满分辨率分块收尾要求 keyframe 与画布同网格"
                        f"（keyframe {tuple(lat.shape[-2:])} ≠ 画布 {(H, W)}）。\n"
                        "请不连「满分辨率分块参数」改走整幅收尾，或改用「MMH3 终极放大」做二采。")


class _TileCondSwapper:
    """逐 tile 改写 guider.conds 里与空间网格相关的 model_conds，退出即恢复。

    H3 的打包布局（PackedLayout）在模型 forward 里按实际 tile 尺寸自动重建
    （signature 不匹配即重建），所以只需改写三类 cond：
      · latent_shapes：让 apply_model 把扁平 tile 解包成正确的流形状；
      · denoise_mask：池化到 token 网格的视频掩码，随 tile 裁切；
      · minimax_payload：keyframe / cond_video_latents 随 tile 裁切
        （refs 有独立网格，参与打包时不依赖画布尺寸，原样透传）。
    """

    def __init__(self, guider, model, axis_dim, full_shapes):
        self.guider = guider
        self.model = model
        self.axis_dim = axis_dim
        self.full_shapes = full_shapes
        self.saved_model_shapes = model.latent_shapes

    @contextlib.contextmanager
    def tile(self, tile_shapes, lo, hi, H, W, win=None):
        """把本块的切片条件装进模型，退出即恢复。

        ``win`` 为 None 时是纯空间分块（老行为）；给了就是时间窗：
        ``(t_lo, t_hi, a_lo, a_hi, f_start, f_end, f_total)``。
        时间窗下三样东西必须一起切，少一样就炸形状或悄悄失效：
          · ``denoise_mask`` / ``audio_denoise_mask`` —— 模型按它们决定哪几步重画，
            形状必须与切过的 latent 严格一致；
          · ``minimax_keyframes`` —— 不按时间筛的话片头锚会被注入每一个窗，
            模型会把每窗的第 0 帧都当成片头，于是每窗开头都被拉回第一帧画面。
        """
        saved = []
        self.model.latent_shapes = tile_shapes
        t_lo = t_hi = a_lo = a_hi = None
        f_start = f_end = f_total = None
        if win is not None:
            t_lo, t_hi, a_lo, a_hi, f_start, f_end, f_total = win
        try:
            for conds in self.guider.conds.values():
                for d in conds:
                    if not isinstance(d, dict):
                        continue
                    mc = d.get("model_conds")
                    if not mc:
                        continue
                    cond_obj = mc.get("latent_shapes")
                    if cond_obj is not None:
                        saved.append((cond_obj, cond_obj.cond))
                        cond_obj.cond = tile_shapes
                    cond_obj = mc.get("denoise_mask")
                    if cond_obj is not None:
                        m = cond_obj.cond
                        saved.append((cond_obj, m))
                        if t_lo is not None and m.ndim >= 5:
                            m = _crop_axis(m, 2, t_lo, t_hi)
                        cond_obj.cond = _crop_axis(m, self.axis_dim, lo, hi)
                    cond_obj = mc.get("audio_denoise_mask")
                    if cond_obj is not None and a_lo is not None:
                        # 音频流没有空间维，只按时间窗切尾轴；不切就与切片后的
                        # 音频 latent 形状不符（模型侧直接报维度错）
                        m = cond_obj.cond
                        saved.append((cond_obj, m))
                        cond_obj.cond = _crop_axis(m, m.ndim - 1, a_lo, a_hi)
                    cond_obj = mc.get("minimax_payload")
                    if cond_obj is not None:
                        p = cond_obj.cond
                        new = dict(p)
                        if p.get("keyframes"):
                            kfs = []
                            for kf in p["keyframes"]:
                                kf2 = dict(kf)
                                if f_start is not None:
                                    f = int(kf.get("resolved_frame_index", 0))
                                    last_win = f_end >= f_total
                                    if not (f_start <= f < f_end
                                            or (last_win and f == f_total)):
                                        continue
                                    kf2["resolved_frame_index"] = max(0, f - f_start)
                                lat = kf.get("latent")
                                if lat is not None:
                                    if lat.shape[-2] != H or lat.shape[-1] != W:
                                        raise ValueError(
                                            "🎯 SelfLift 渐进提升：分块收尾要求 keyframe 与画布同网格"
                                            f"（keyframe {tuple(lat.shape[-2:])} ≠ 画布 {(H, W)}）")
                                    kf2["latent"] = _crop_axis(lat, self.axis_dim, lo, hi)
                                kfs.append(kf2)
                            new["keyframes"] = kfs
                        if "cond_video_latents" in p:
                            # 按构建顺序重建：先裁好的 keyframe 视频 latent，再原样的 refs
                            new["cond_video_latents"] = (
                                [kf["latent"] for kf in new.get("keyframes") or ()
                                 if kf.get("latent") is not None]
                                + [r["latent"] for r in p.get("refs") or () if "latent" in r])
                        if "cond_audio_latents" in p:
                            # 与 comfy/model_base.py 的 _cond_latents 同口径：先幸存
                            # keyframe 音频，再原样 refs 音频。时间窗筛掉 keyframe
                            # 后不同步重建，音频条件仍是全量 80 行、视频已 0 条，
                            # 模型侧就会报 [80,32] → [0,32]（承接钉帧场景）。
                            new["cond_audio_latents"] = (
                                [kf["audio_latent"] for kf in new.get("keyframes") or ()
                                 if kf.get("audio_latent") is not None]
                                + [r["audio_latent"] for r in p.get("refs") or ()
                                   if r.get("audio_latent") is not None])
                        saved.append((cond_obj, p))
                        cond_obj.cond = new
            yield
        finally:
            for cond_obj, old in saved:
                cond_obj.cond = old
            self.model.latent_shapes = self.full_shapes


def _sample_tiled_highres(guider, model, sigmas, extra_args, callback,
                          x, base_latent, base_noise, denoise_mask,
                          shapes, axis, starts, tile_size, overlap, feather,
                          H, W, step_offset, total_steps, disable_pbar,
                          temporal_segs=None):
    """末段的逐步同步分块 Euler —— **时间轴与空间轴共用同一条去噪轨迹**。
    返回与 KSAMPLER.sample 同口径的结果（已做 inverse_noise_scaling，
    未做 process_latent_out）。

    ``temporal_segs`` 为 None 时就是纯空间分块（老行为）；给了时间窗
    （``[(视频起, 视频止, 音频起, 音频止), ...]``）时，每个 sigma 步依次前向
    「每个时间窗 × 每个空间块」，全部写入同一份全局 denoised 再统一推进一步。

    两条轴的融合规矩不同，是有意为之：
      · **时间轴用三角羽化**（与「🎬 H3 终极放大」的共享轨迹同源）：每帧至少被
        两个窗覆盖，落在窗边缘的帧也能拿到窗外上下文，段间没有「预测质量台阶」；
      · **空间轴用二元核心区独占**：每个位置只采纳唯一一块的预测，绝不把两份预测
        平均成第三个值（平均值落在流形外，是接缝脏线的来源）。
    ``feather`` 保留只为兼容旧签名。"""
    axis_dim = 3 if axis == "H" else 4
    axis_total = H if axis == "H" else W
    device = x.device
    ms = model.model_sampling
    model_options = extra_args.get("model_options", {}) or {}

    full_shapes = [tuple(s) for s in shapes]
    T = int(full_shapes[0][2])

    regions = []
    last = len(starts) - 1
    for i, ax_start in enumerate(starts):
        ax_end = min(ax_start + tile_size, axis_total)
        actual = ax_end - ax_start
        c_lo = 0 if i == 0 else min(axis_total, ax_start + overlap) - ax_start
        c_hi = (axis_total - ax_start if i == last
                else min(axis_total, starts[i + 1] + overlap) - ax_start)
        # 【接缝融合】窗口 = 核心区**二值**窗（1=采纳 / 0=丢弃），不做羽化。
        # 与「H3 终极放大」的 _tile_clean_mask 同构：核心区严格互补、完整覆盖长轴
        # → 每个位置只采纳唯一一块的预测，weights 恒为 1。
        #
        # 为什么不用 _make_core_window_1d 的余弦羽化窗：羽化带（默认 4 格 = 64 像素）
        # 本质是「两块各自预测一遍、再按 0.5/0.5 平均」。两块在重叠带的上下文不同，
        # 对同一条边画出的位置会错开；平均出来的中间值**两块都没预测过**，它不属于
        # 任何一个 x0 估计，落在流形之外。去噪会把它当成真实内容继续画 → 沿轮廓
        # 留下脏线/双线。实测 k=19 处两块分别给 0.00 / 1.00，平均得到 0.25。
        #
        # 边界说明（二元窗不做什么）：
        #   · 它不保证两块预测一致——不一致时接缝处留台阶，靠 overlap 提供一致上下文
        #     来约束，overlap 越宽越稳；
        #   · 它不治「免模型插值档的信息缺口型重影」（见 重影问题_交接文档.md §4，
        #     那种重影开不开分块都在，与本窗口无关）。
        w1d = torch.zeros(actual, dtype=torch.float32, device=device)
        lo = max(0, int(c_lo))
        hi = min(actual, int(c_hi))
        if hi > lo:
            w1d[lo:hi] = 1.0
        else:
            w1d.fill_(1.0)
        window = w1d.view(1, 1, 1, -1, 1) if axis == "H" else w1d.view(1, 1, 1, 1, -1)
        regions.append((ax_start, ax_end, window))

    weight_shape = (1, 1, 1, axis_total, 1) if axis == "H" else (1, 1, 1, 1, axis_total)
    weights = torch.zeros(weight_shape, dtype=torch.float32, device=device)
    for ax_start, ax_end, window in regions:
        if axis == "H":
            weights[:, :, :, ax_start:ax_end, :] += window
        else:
            weights[:, :, :, :, ax_start:ax_end] += window
    weights = weights.clamp(min=1e-8)
    # 兜底：核心区严格互补时 weights 恒为 1。万一有列没被任何块的核心区覆盖
    # （退化几何 / 极端块数），不能被合并除法压成 0（解码后就是画面边缘脏条）——
    # 与终极放大一致，这些列留守当前 x 而不是归零。
    uncovered = weights < 1e-6
    if bool(uncovered.any()):
        log.warning("[班长SelfLift·分块] %d 列未被任何块核心区覆盖，本次留守当前 latent",
                    int(uncovered.sum()))
    # 单块盖满长轴时（纯时间分块）根本不存在空间接缝，坐标注入必须跳过 ——
    # 否则会挂上一条多余的 wrapper、还白白写一次全画布偏移
    full_axis = len(regions) == 1 and (regions[0][1] - regions[0][0]) >= axis_total

    # 时间窗：None = 整条收尾（老行为）；羽化权重只在真的切了多段时才有意义
    if temporal_segs is None:
        seg_list = [(0, T, None, None)]
    else:
        seg_list = list(temporal_segs)
    n_seg = len(seg_list)
    seg_wv = [None] * n_seg
    seg_wa = [None] * n_seg
    if n_seg > 1:
        for si, (vs, ve, a0, a1) in enumerate(seg_list):
            seg_wv[si] = _temporal_feather(ve - vs, device)
            if a0 is not None:
                seg_wa[si] = _temporal_feather(max(1, a1 - a0), device)
    # 关键帧的时间筛选用像素帧坐标（与 resolved_frame_index 同口径），一次算好
    frame_ofs = _h3_frame_offsets(T) if n_seg > 1 else None

    swapper = _TileCondSwapper(guider, model, axis_dim, full_shapes)
    steps = len(sigmas) - 1
    has_mask_fn = "denoise_mask_function" in model_options
    # KSAMPLER.sample 会把 denoise_mask 塞进 extra_args（给 KSamplerX0Inpaint 消化）。
    # 本函数已自做掩码预混合 + 逐 tile 裁切，guider 只认 model_options/seed，
    # 多余的键必须过滤掉，否则 outer_predict_noise 直接 TypeError。
    guider_kwargs = {k: v for k, v in extra_args.items() if k != "denoise_mask"}
    # 全局坐标注入的写入点：每块预测前把本块在整幅中的偏移写进 transformer_options，
    # 由 banzhang_h3_tile_pos 的 diffusion_model wrapper 换算成整幅坐标系下的
    # RoPE 位置（防"每块把条带当独立完整小画布"——分身小人/彩色圆点的根因）。
    _mo = guider_kwargs.get("model_options")
    if not isinstance(_mo, dict):
        _mo = {}
        guider_kwargs["model_options"] = _mo
    _to = _mo.setdefault("transformer_options", {})

    try:
        for i in comfy.utils.model_trange(steps, disable=disable_pbar):
            # 末段分块是逐步同步的，一步要跑完所有块；步间检查取消，否则点完取消
            # 还得干等剩下所有步（大画布 + 十几块时是几十秒到几分钟）
            comfy.model_management.throw_exception_if_processing_interrupted()
            sigma_hat = sigmas[i]
            sigma_next = sigmas[i + 1]
            # 掩码预混合（整幅，复现 KSamplerX0Inpaint.__call__ 的前半段；
            # denoise_mask_function 与原生一致，每步用当前 sigma 求值）
            model.latent_shapes = full_shapes
            dm = denoise_mask
            if dm is not None and has_mask_fn:
                dm = model_options["denoise_mask_function"](
                    sigma_hat, dm, extra_options={"model": guider, "sigmas": sigmas})
            if dm is not None:
                latent_mask = 1.0 - dm
                x_in = x * dm + model.scale_latent_inpaint(
                    x=x, sigma=sigma_hat, noise=base_noise,
                    latent_image=base_latent, denoise_mask=dm) * latent_mask
            else:
                x_in = x

            video_x, audio_x = comfy.utils.unpack_latents(x_in, full_shapes)
            video_denoised = torch.zeros_like(video_x, dtype=torch.float32)
            # 时间×空间二维权重累加器：与 denoised 同形逐位置归一化，不用
            # 「时间权重 ⊗ 空间权重」的外积近似 —— 若某个 (t, 轴) 组合没被任何
            # 窗口×块覆盖，外积近似会把它压成 0（解码后是黑条/脏条），同形累加则
            # 能精确发现并在下面回退成当前 latent。
            v_wsum = torch.zeros_like(video_x[:, :1], dtype=torch.float32)
            # 音频没有空间维度，不需要也不应该分空间块：显存大头全是视频 token。
            # 同一时间窗内各块看到的视频条带不同，预测出的音频互不一致——逐块平均
            # 会搅出浑浊/嗡嗡。恒取该窗第一块的预测；窗与窗之间按羽化权重融合。
            audio_denoised = (torch.zeros_like(audio_x, dtype=torch.float32)
                              if audio_x is not None else None)
            a_wsum = (torch.zeros_like(audio_x, dtype=torch.float32)
                      if audio_x is not None else None)

            for si, (vs, ve, a0, a1) in enumerate(seg_list):
                comfy.model_management.throw_exception_if_processing_interrupted()
                sub_v = video_x[:, :, vs:ve]
                sub_a = audio_x if a0 is None else audio_x[..., a0:a1]
                w_t = seg_wv[si]
                audio_pred = None
                for ax_start, ax_end, window in regions:
                    tile_video = _crop_axis(sub_v, axis_dim, ax_start, ax_end)
                    tile_x, tile_shapes = comfy.utils.pack_latents([tile_video, sub_a])
                    del tile_video
                    # 全局坐标注入：把本块 video 段的空间坐标换成整幅坐标系下的真实位置，
                    # 模型才知道自己处理的是画面第几块（防分身小人/防彩色圆点）。
                    if not full_axis:
                        if axis == "H":
                            _set_tile_offset(_to, H, W, ax_end - ax_start, W,
                                             ax_start // 2, 0)
                        else:
                            _set_tile_offset(_to, H, W, H, ax_end - ax_start,
                                             0, ax_start // 2)
                    win = None
                    if w_t is not None:
                        win = (vs, ve, a0, a1,
                               int(frame_ofs[vs]), int(frame_ofs[ve]),
                               int(frame_ofs[-1]))
                    try:
                        with swapper.tile(tile_shapes, ax_start, ax_end, H, W, win=win):
                            tile_pred = guider(
                                tile_x, sigma_hat * tile_x.new_ones([tile_x.shape[0]]),
                                **guider_kwargs)
                    finally:
                        if not full_axis:
                            _clear_tile_offset(_to)
                    pred_streams = comfy.utils.unpack_latents(tile_pred, tile_shapes)
                    pred_video = pred_streams[0].float()
                    w = window if w_t is None else w_t.view(1, 1, -1, 1, 1) * window
                    if axis == "H":
                        video_denoised[:, :, vs:ve, ax_start:ax_end, :] += pred_video * w
                        v_wsum[:, :, vs:ve, ax_start:ax_end, :] += w
                    else:
                        video_denoised[:, :, vs:ve, :, ax_start:ax_end] += pred_video * w
                        v_wsum[:, :, vs:ve, :, ax_start:ax_end] += w
                    if audio_pred is None and len(pred_streams) > 1:
                        audio_pred = pred_streams[1].float()
                    del tile_x, tile_pred, pred_streams

                if audio_pred is not None and audio_denoised is not None:
                    w_a = seg_wa[si]
                    if w_a is None:
                        audio_denoised = audio_denoised + audio_pred
                        a_wsum = a_wsum + 1.0
                    else:
                        audio_denoised[..., a0:a1] += audio_pred * w_a
                        a_wsum[..., a0:a1] += w_a
                del audio_pred

            empty = v_wsum < 1e-6
            if bool(empty.any()):
                video_denoised = torch.where(empty, video_x, video_denoised)
                v_wsum = torch.where(empty, torch.ones_like(v_wsum), v_wsum)
            video_denoised = video_denoised / v_wsum
            del v_wsum
            if audio_denoised is not None:
                a_empty = a_wsum < 1e-6
                if bool(a_empty.any()):
                    audio_denoised = torch.where(a_empty, audio_x, audio_denoised)
                    a_wsum = torch.where(a_empty, torch.ones_like(a_wsum), a_wsum)
                audio_denoised = audio_denoised / a_wsum
                del a_wsum
            denoised, _ = comfy.utils.pack_latents(
                [video_denoised.to(dtype=video_x.dtype),
                 audio_denoised.to(dtype=audio_x.dtype)])
            del video_denoised, audio_denoised

            # 掩码回混（整幅，复现 KSamplerX0Inpaint.__call__ 的后半段）
            if dm is not None:
                denoised = denoised * dm + base_latent * latent_mask

            model.latent_shapes = full_shapes
            if callback is not None:
                callback(step_offset + i, denoised, x, total_steps)
            d = comfy.k_diffusion.sampling.to_d(x, sigma_hat, denoised)
            x = x + d * (sigma_next - sigma_hat)
        return ms.inverse_noise_scaling(sigmas[-1], x)
    finally:
        model.latent_shapes = swapper.saved_model_shapes



class _SelfLiftProgressive:
    """挂在 SAMPLER_SAMPLE 上的渐进分辨率采样补丁。

    前段在原始 latent 网格上跑 → 用学习式放大模型抬到更大的目标网格 →
    剩余步在目标网格上收尾。输出 latent 尺寸 = 原始尺寸 × 放大倍率。
    自己发起的两段采样通过 ``_busy`` 直通，避免递归。
    """

    def __init__(self, transition_step, upscale, lifter=None, spatial_params=None,
                 audio_passthrough=True):
        self.transition_step = int(transition_step)
        self.upscale = float(upscale)
        self.audio_passthrough = bool(audio_passthrough)
        self.spatial_params = spatial_params
        # VAE 往返校正已移除（实测是彩色光斑圆点的来源）：修正比例固化为 0，
        # 恒走学习式直接提升，VAE 不参与过渡。字段保留以便日志与既有代码路径复用。
        self.rho = 0.0
        self.w_min = 0.0
        self.w_max = 0.0
        self.vae = None
        self.lifter = lifter
        self._busy = False

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
            raise ValueError("🎯 SelfLift 渐进提升：本补丁目前只支持 MiniMax H3 模型")

        sampler_obj = executor.class_obj
        if getattr(sampler_obj, "sampler_function", None) is not comfy.k_diffusion.sampling.sample_euler:
            raise ValueError(
                "🎯 SelfLift 渐进提升：采样器必须选标准 euler。"
                "SelfLift 复用过渡步的预测来保持总 NFE 不变，其它采样器无法套用。")
        if sampler_obj.extra_options.get("s_churn", 0.0) != 0.0:
            raise ValueError("🎯 SelfLift 渐进提升：euler 的 s_churn 必须为 0")
        if not isinstance(model.model_sampling, comfy.model_sampling.CONST):
            raise ValueError("🎯 SelfLift 渐进提升：需要 rectified-flow 模型")

        total_steps = int(sigmas.numel()) - 1
        if total_steps < 2:
            return executor(guider, sigmas, extra_args, callback,
                            noise, latent_image, denoise_mask, disable_pbar)

        ts = self.transition_step
        if not 1 <= ts <= total_steps - 1:
            raise ValueError(
                f"🎯 SelfLift 渐进提升：过渡步数 {ts} 超出本次调度 {total_steps} 步的可用范围"
                f"（应取 1 ~ {total_steps - 1}）")
        if float(sigmas[ts]) >= 1.0:
            raise ValueError(
                "🎯 SelfLift 渐进提升：放大后起始 sigma 必须小于 1 —— "
                "请加大过渡步数，或降低 KSampler 的降噪强度")
        if bool((sigmas[1:] > sigmas[:-1]).any()) or bool((sigmas[:-1] <= 0).any()):
            raise ValueError("🎯 SelfLift 渐进提升：sigmas 必须非递增，且只有最后一项可为 0")

        shapes = getattr(model, "latent_shapes", None)
        if not shapes or len(shapes) < 2:
            raise ValueError("🎯 SelfLift 渐进提升：需要一个音视频双流的 H3 latent")
        shapes = [tuple(s) for s in shapes]
        video_shape = shapes[0]
        if len(video_shape) != 5:
            raise ValueError(f"🎯 SelfLift 渐进提升：视频 latent 应为 5 维，实际 {video_shape}")
        t, H, W = video_shape[2], video_shape[3], video_shape[4]
        mask_streams = _split_denoise_mask(denoise_mask, shapes)
        if mask_streams is not None:
            # 与多级路径同一修法（20261010）：钉帧遮罩与 SelfLift 互斥，跨 1.5×
            # 网格重采样会导致末段发散（彩色光点）。忽略遮罩，钉帧由方案 B 回填保证。
            log.warning("[班长SelfLift] 检测到钉帧遮罩：SelfLift 与遮罩互斥，"
                        "本次忽略遮罩（钉帧由「🧷 尾帧回填」保证，不受影响）")
            mask_streams = None

        need_pix = self.rho > 0.0 and self.w_max > 0.0
        if need_pix and self.vae is None:
            raise ValueError("🎯 SelfLift 渐进提升：修正比例 > 0 时需要接入 VAE（像素锚点）")

        h2 = max(2, round(H * self.upscale / 2) * 2)
        w2 = max(2, round(W * self.upscale / 2) * 2)
        high_shapes = [(video_shape[0], video_shape[1], t, h2, w2), shapes[1]]
        seed = int(extra_args.get("seed") or 0)

        log.info(
            "[班长SelfLift·放大] 起始 latent=(%d, %d) 放大后 latent=(%d, %d) 倍率=(%.4f, %.4f) "
            "起始 NFE=%d 放大后 NFE=%d 过渡 sigma=%.6g→%.6g "
            "直接提升=%s 像素锚点=%s",
            H, W, h2, w2, h2 / H, w2 / W, ts, total_steps - ts,
            float(sigmas[ts - 1]), float(sigmas[ts]),
            "学习式放大" if self.lifter is not None else "最近邻", need_pix)

        # 起始段 --------------------------------------------------------
        # 不缩小：直接在原始 latent 网格上跑前 ts 步，放大只在过渡处做一次
        video_ms, audio_ms = comfy.utils.unpack_latents(latent_image, shapes)
        base_shapes = [tuple(video_ms.shape), tuple(audio_ms.shape)]
        low_mask = _denoise_mask_for_grid(mask_streams, base_shapes)
        # 起始网格就是原始网格，这里只是原样拆包再装回，不改变任何数值
        low_pack, _ = comfy.utils.pack_latents([video_ms, audio_ms])
        # 音频锚点口径：直接喂外层 latent，让 inner_sample 的 process_latent_in 把音频
        # 缩到正确的采样空间（先 process_latent_out 会把锚点缩小 audio_scale 倍，
        # 降噪<1 / 带掩码时音频发闷、破损 —— 见多级渐进里同主题的注释）
        low_outer = low_pack
        saved_latent_shapes = model.latent_shapes

        low_noise_nested = comfy.sample.prepare_noise(
            comfy.nested_tensor.NestedTensor([video_ms, audio_ms]), seed)
        low_noise, _ = comfy.utils.pack_latents(low_noise_nested.unbind())
        # 保留音频的纯 x0 锚点（采样空间），见 _resume_pack_with_pure_audio
        # 注意：本补丁经 SAMPLER_SAMPLE wrapper 被调用时，外层 CFGGuider.inner_sample
        # 已经对非零 latent 做过 process_latent_in（音频 ×audio_scale），所以这里的
        # audio_ms 已经是「内层采样空间」。再乘一次 audio_scale 会把音频放大到
        # audio_scale²（H3 上 shift=12/audio_shift=3 → 4×，即最终 16 倍），这就是
        # 二采（输入非零）时音频被重绘/爆音的根因。直接取 audio_ms 即可。
        audio_anchor = audio_ms
        device = guider.model_patcher.load_device
        low_noise = _hand_off(low_noise, device)
        low_outer = _hand_off(low_outer, device)

        captured = {}
        low_calls = 0

        def cb_low(step, x0, x, _total):
            nonlocal low_calls
            if low_calls >= ts:
                raise RuntimeError("🎯 SelfLift 渐进提升：起始段回调次数超出预期")
            index = low_calls
            low_calls += 1
            if index == ts - 1:
                captured["x"] = x
                captured["x0"] = x0
            if callback is None:
                return None
            return callback(index, x0, x, total_steps)

        saved_conds = guider.conds
        low_conds = None
        original_conds = getattr(guider, "original_conds", None)
        if original_conds is not None:
            # 从原始条件重建一份干净副本，让 process_conds 按起始网格重新解析；
            # 直接复用已处理的 guider.conds 会把 keyframe 等条件编码两遍
            low_conds = {k: [cond.copy() for cond in v] for k, v in original_conds.items()}
            for key in ("positive", "negative"):
                if key in low_conds:
                    low_conds[key] = _resize_keyframes(low_conds[key], H, W)
        else:
            log.warning("[班长SelfLift] 读不到 guider.original_conds，起始段将沿用原条件")

        started = time.perf_counter()
        self._busy = True
        try:
            if low_conds is not None:
                guider.conds = low_conds
            try:
                guider.inner_sample(low_noise, low_outer, device,
                                    sampler_obj, sigmas[:ts + 1], low_mask, cb_low,
                                    disable_pbar, seed, latent_shapes=base_shapes)
            finally:
                guider.conds = saved_conds
                model.latent_shapes = saved_latent_shapes
            low_elapsed = time.perf_counter() - started
            if low_calls != ts:
                raise RuntimeError(
                    f"🎯 SelfLift 渐进提升：起始段应跑 {ts} 步，实际 {low_calls} 步；"
                    "采样器可能被其它插件包装")

            # 过渡 ------------------------------------------------------
            # 放大模型也要吃显存：提前按 4GB 预算把主模型部分换出。
            # 否则 lifter 只能拿到 ~0.6GB，时间分块被压到 8 帧/片，
            # 3D 时间感受野被切碎 —— 这是放大后时间向重影的主要来源。
            _ensure_highres_headroom(guider.model_patcher, device,
                                     need=4 * 1024 ** 3)
            state = captured.get("x")
            x0 = captured.get("x0")
            if state is None or x0 is None:
                raise RuntimeError("🎯 SelfLift 渐进提升：未能截获过渡步的中间状态")
            sigma_k = sigmas[ts - 1]
            sigma_next = sigmas[ts]
            ms = model.model_sampling

            video_state, audio_state = comfy.utils.unpack_latents(state, base_shapes)
            video_x0, audio_x0 = comfy.utils.unpack_latents(x0, base_shapes)
            # 音频流没有空间维度，跟着复用同一个 Euler 边界步继续走
            auxiliary_next = _euler_step(audio_state, audio_x0, sigma_k, sigma_next)

            need_lat = not (self.rho >= 1.0 and self.w_min >= 1.0 and self.w_max >= 1.0)
            # 原版在这里显式转 fp32（nodes.py:390 process_out(x0_streams[0].float())）。
            # 这一步不能省：模型跑 bf16、VAE 是 int8 量化版，拿 bf16 latent 去解码
            # 会把像素锚点做脏，而 rho=0.6 / w=1 会把 60% 的位置整个换成这个锚点。
            z_lat, z_pix = _lifts.paired_lifts(
                video_x0.float(), self.vae, (h2, w2), "nearest", self.lifter,
                need_lat=need_lat, need_pix=need_pix)
            # MiniMaxH3Video 的 scale_factor 为 1.0，process_in/out 对视频流是恒等映射，
            # 所以这里直接就是模型空间，无需来回换算。
            # 注意：ComfyUI 的 VAE.encode 把结果落在 intermediate_device（默认 CPU），
            # 像素锚点一开，整条提升链路都会被拽回 CPU，必须在边界上归一回来
            z_art = _lifts.artifact_aware_consistency_lift(
                z_lat, z_pix, self.rho, self.w_min, self.w_max)
            z_art = _winsorize_outliers(
                z_art, "（单级·放大后 %dx%d）" % (w2 * 16, h2 * 16))
            # 逐帧曝光守恒（与多级同修，20261011）：lifter 抬亮整帧、续写接缝处
            # 条件头亮度被钉住而状态头被抬亮，满网格步数少调和不回。这里把每帧
            # 每通道均值拉回低清干净端点，细节保留、只去曝光漂移。
            z_art = _lifts.match_lift_exposure(z_art, video_x0)
            z0_high = _hand_off(z_art, device)

            # 重新加噪：噪声必须生成在满分辨率上（z0_high），不能沿用低分辨率的
            # video_x0 做尺寸模板，否则 sigma*noise 与 (1-sigma)*z0_high 形状对不上
            video_noise = _hand_off(
                comfy.sample.prepare_noise(z0_high, (seed + 1) % (1 << 64)), device)
            video_state = ms.noise_scaling(sigma_k, video_noise, z0_high)
            video_next = _euler_step(video_state, z0_high, sigma_k, sigma_next)
            aux_next = ms.inverse_noise_scaling(sigma_next, auxiliary_next)
            resume_pack, _ = comfy.utils.pack_latents(
                [ms.inverse_noise_scaling(sigma_next, video_next), aux_next])
            resume_pack = _hand_off(resume_pack, device)
            # 交给原生采样器时补零噪声：noise_scaling(σ_next, 0, latent) 恰好还原上面那个状态
            resume_noise = torch.zeros_like(resume_pack)
            # 过渡用的满分辨率中间量都已并入 resume_pack，立刻放掉；
            # 否则它们会一直活到函数返回，也就是整个满分辨率阶段都在占着显存
            del video_state, audio_state, video_x0, audio_x0, auxiliary_next
            del z_lat, z_pix, video_noise, video_next, aux_next
            # 放大模型用完即焚：单级只有这一次提升，后面整段都不再需要它。
            # （unload 关时保留，供后续任务复用）
            if getattr(self.lifter, "unload", False):
                _lifter.release()

            # 放大后收尾 ------------------------------------------------
            # 新网格首次前向要重新录制显存图；只在真的缺预算时才按需凑一点，
            # 显存够用时不动任何模型（VAE 原地保留，后续节点零代价）
            raise_elapsed = time.perf_counter() - started - low_elapsed
            how, free_now, freed = _ensure_highres_headroom(guider.model_patcher, device)
            log.info(
                "[班长SelfLift] 过渡完成：放大耗时 %.3fs；放大后预算 %s"
                "（可用 %.2fGB，按需释放 %.0fMB，门槛 %.0fMB）；"
                "放大后 %d 步开始（首步含新网格显存图录制，会比后续步慢）",
                raise_elapsed, how, free_now / 1024 ** 3, freed / 1024 ** 2,
                _HEADROOM_BYTES / 1024 ** 2, total_steps - ts)

            high_calls = 0

            def cb_high(step, x0, x, _total):
                nonlocal high_calls
                if high_calls >= total_steps - ts:
                    raise RuntimeError("🎯 SelfLift 渐进提升：放大后阶段回调次数超出预期")
                index = high_calls
                high_calls += 1
                if callback is None:
                    return None
                return callback(index + ts, x0, x, total_steps)

            high_noise, high_latent = resume_noise, resume_pack
            if mask_streams is not None:
                high_noise, high_latent = _resume_pack_with_pure_audio(
                    resume_pack, audio_anchor, float(sigmas[ts]))
            high_mask = _denoise_mask_for_grid(mask_streams, high_shapes)
            # 网格放大了，条件必须按新网格重建（keyframe 随网格裁切）。
            # 不能沿用已处理的 guider.conds：那是按起始网格编码的。
            high_conds = None
            if original_conds is not None:
                high_conds = {k: [cond.copy() for cond in v]
                              for k, v in original_conds.items()}
                for key in ("positive", "negative"):
                    if key in high_conds:
                        high_conds[key] = _resize_keyframes(high_conds[key], h2, w2)
                high_conds = comfy.samplers.process_conds(
                    model, noise, high_conds, device, latent_image=None,
                    denoise_mask=high_mask, seed=seed, latent_shapes=high_shapes)
            else:
                log.warning("[班长SelfLift] 读不到 guider.original_conds，放大后将沿用起始网格条件")

            tiling = None
            if self.spatial_params is not None:
                # n_tiles 缺省时为 None → _plan_fullres_tiling 按 sp 里的 tw 自动推算，
                # 「H3 终极放大参数」不产出 n_tiles 键 → get 得 None → tw 自动推算，
                # 与该节点原口径完全一致；字典里带 n_tiles（0=智能 / 2~8=手动）时走新语义。
                tiling = _plan_fullres_tiling(
                    self.spatial_params, h2, w2,
                    n_tiles_manual=self.spatial_params.get("n_tiles"),
                    t_frames=t)
            model.latent_shapes = high_shapes
            if high_conds is not None:
                guider.conds = high_conds
            try:
                if tiling is not None:
                    axis, starts, tile_size, ov, fe = tiling
                    _validate_tiling_keyframes(guider, h2, w2)
                    log.info(
                        "[班长SelfLift·分块] 放大后收尾改为逐步同步分块：长边=%s 共%d块 "
                        "tile=%d格 overlap=%d 羽化=%d（画布 %d格×%d格 / %dpx×%dpx）",
                        axis, len(starts), tile_size, ov, fe, h2, w2, w2 * 16, h2 * 16)
                    # 与 KSAMPLER.sample 同口径的入口加噪：CONST 下
                    # noise_scaling(σ, 0, latent) = (1-σ)·latent，恰好还原换纸状态
                    # （噪声为全零，max_denoise 取 False 与否不影响结果）
                    x0_state = ms.noise_scaling(sigmas[ts], high_noise, high_latent, False)
                    out = _sample_tiled_highres(
                        guider, model, sigmas[ts:], extra_args, cb_high,
                        x0_state, high_latent, high_noise, high_mask,
                        high_shapes, axis, starts, tile_size, ov, fe, h2, w2,
                        step_offset=ts, total_steps=total_steps, disable_pbar=disable_pbar)
                else:
                    out = executor(guider, sigmas[ts:], extra_args, cb_high,
                                   high_noise, high_latent, high_mask, disable_pbar)
            finally:
                guider.conds = saved_conds
                model.latent_shapes = saved_latent_shapes
            # 输出网格已经放大，记到 guider 上交给调用方（🎯 H3 放大采样器）按新网格解包。
            # 官方 KSampler 走 guider.sample()，会强制按输入网格重打包，用不了这条路径。
            guider._banzhang_out_shapes = high_shapes
            if high_calls != total_steps - ts:
                raise RuntimeError(
                    f"🎯 SelfLift 渐进提升：放大后阶段应跑 {total_steps - ts} 步，"
                    f"实际 {high_calls} 步；采样器可能被其它插件包装")

            # 出口兜底钳位：钳位只覆盖"换纸"那一瞬间，末段采样/分块里新产生的离群值
            # 之前没人管（VAE 解码后就是彩色光点）。出厂前对视频流统一拦一道。
            v_out, a_out = comfy.utils.unpack_latents(out, high_shapes)
            v_out = _winsorize_outliers(
                v_out, "（单级·收尾 %dx%d）" % (w2 * 16, h2 * 16))
            if self.audio_passthrough:
                # 音频透传：后段联合采样会重画音频流，这里直接换回一采的干净音频
                # （audio_anchor = 起始音频 × audio_scale，内层采样空间，与 out 同口径）
                a_out = audio_anchor
                log.info("[班长SelfLift] 音频已透传（保留一采原始音频，未重绘）")
            out, _ = comfy.utils.pack_latents([v_out, a_out])
            log.info("[班长SelfLift] 起始段 %.3fs，过渡 %.3fs，放大后段 %.3fs，总耗时 %.3fs",
                     low_elapsed, raise_elapsed, time.perf_counter() - started - low_elapsed - raise_elapsed,
                     time.perf_counter() - started)
            return out
        finally:
            self._busy = False


class BanZhang_SelfLiftProgressive:
    """SelfLift 渐进分辨率采样补丁（MODEL → MODEL，学习式 latent 提升路线）。"""

    DESCRIPTION = (
        "采样中途放大一次：调「放大倍率」，采样器必须选 euler；爆显存接分块参数。"
    )

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "模型": ("MODEL", {
                    "tooltip": "接在 LoRA 加载器之后、采样器之前。",
                }),
                "过渡步数": ("INT", {
                    "default": 4,
                    "min": 1,
                    "max": 10000,
                    "tooltip": (
                        "放大前在原始网格上跑多少步。\n"
                        "8 步调度建议 4；步数越多省得越多，但过渡后留给放大后收尾的步数也越少。"
                    ),
                }),
                "放大倍率": ("FLOAT", {
                    "default": 1.5,
                    "min": 1.0,
                    "max": 3.0,
                    "step": 0.05,
                    "tooltip": (
                        "过渡处把 latent 放大到多少倍，输出尺寸 = 原始尺寸 × 放大倍率。\n"
                        "1.0 = 不放大（退化为普通采样）。\n"
                        "建议 1.5 以内：latent 放大模型的训练档位就是 1.5，超出会掉细节。"
                    ),
                }),
                "latent放大模型": (_lifter.list_models(), {
                    "default": _lifter.default_model(),
                    "tooltip": (
                        "过渡处「放大」这一段用什么算法。\n"
                        "列表来自 models/latent_upscale_models 目录，默认自动选名字含 h3 的模型。\n"
                        "提升必须走学习式放大：最近邻插值实测伪影严重，已不提供。"
                    ),
                }),
            },
            "optional": {
                "放大后卸载": ("BOOLEAN", {
                    "default": True,
                    "label_on": "开启",
                    "label_off": "关闭",
                    "tooltip": "提升一结束就把放大模型搬回 CPU，把显存让给满分辨率阶段；"
                               "单级只有这一次提升，用完整块丢弃（内存也释放）。",
                }),
                "满分辨率分块参数": (_H3_SPATIAL_PARAM, {
                    "tooltip": (
                        "连接「H3 终极放大参数」的「空间分块参数」后，满分辨率收尾改为"
                        "逐步同步分块（与「MMH3 终极放大」同一套分块机制，显存峰值≈单块）。\n"
                        "不连 = 整幅收尾（原行为）。\n"
                        "注意：分块收尾要求 keyframe 与画布同网格，否则采样开始时直接报错；"
                        "分块之间没有跨块注意力，跨块物体一致性会略降。"
                    ),
                }),
                "音频透传": ("BOOLEAN", {
                    "default": True,
                    "label_on": "透传（保留一采音频）",
                    "label_off": "重绘（音频随画面重采样）",
                    "tooltip": (
                        "开启 = 输出保留一采的原始音频，放大阶段只重画视频（推荐，音色不漂移）。\n"
                        "关闭 = 音频随画面一起重新采样。"
                    ),
                }),
            },
        }

    RETURN_TYPES = ("MODEL",)
    FUNCTION = "apply"
    CATEGORY = "👨‍🏫班长/MiniMax H3"

    def apply(self, 模型, 过渡步数=4, 放大倍率=1.5, latent放大模型=None,
              放大后卸载=True, 音频透传=True, 满分辨率分块参数=None):
        if latent放大模型 is None:
            latent放大模型 = _lifter.default_model()
        lifter = _lifter.make_lifter(latent放大模型, 放大后卸载)
        if lifter is None:
            raise ValueError(
                "🎯 SelfLift 渐进提升：没有可用的 H3 latent 放大模型。"
                "请把模型文件放入 models/latent_upscale_models 目录后刷新。")

        patched = 模型.clone()
        if 满分辨率分块参数 is not None:
            # 分块收尾要用：全局坐标注入 wrapper 必须在采样准备前挂好
            #（wrapper 列表在采样开始时快照进 model_options，中途补挂不生效）。
            _install_tile_pos(patched)
        patched.add_wrapper_with_key(
            comfy.patcher_extension.WrappersMP.SAMPLER_SAMPLE,
            _WRAPPER_KEY,
            _SelfLiftProgressive(过渡步数, 放大倍率, lifter, 满分辨率分块参数,
                                 audio_passthrough=音频透传),
        )
        return (patched,)


# ============================================================
# 二合一：「🎬 H3 Latent放大」+「🎯 SelfLift 多级渐进」
#
# 用户验证过的串联用法：
#   一采 latent ──► H3 Latent放大(按倍率) ──► 放大采样器.潜空间
#   一采 MODEL  ──► SelfLift 渐进提升(倍率=1) ──► 放大采样器.模型
# 本节点把前两步合成一个：先放大潜空间到最终网格，再挂多级渐进补丁。
# 「分段步数」决定分几段、每段几步（单值 = 两段，等价原来的过渡步数）；
# 「级间倍率」= 每次提升的倍率，1.0 时各级同尺寸、只换纸不放大，
# 与三节点串联验证过的行为一致。
#
# 「放大方式」「放大模式」用 V3 DynamicCombo 控件（与「🎬 H3 Latent放大」
# 同款）：前端只显示当前选中项的子控件——选「插值放大（三线性）」时
# 「放大模型 / 显存档位」自动收起；「放大模式」选「按倍率」只显示倍数、
# 选「目标尺寸」只显示宽高、选「百万像素」只显示百万像素。
# ============================================================
class BanZhang_SelfLiftUpscale(io.ComfyNode):
    """合并「🎬 H3 Latent放大」+「🎯 SelfLift 多级渐进」为一个节点。"""

    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="BanZhang_SelfLiftUpscale",
            display_name="🎯 SelfLift 放大重绘（二合一）",
            category="👨‍🏫班长/MiniMax H3",
            description=(
                "「🎬 H3 Latent放大 + 🎯 SelfLift 多级渐进」二合一：\n"
                "先按「放大方式 / 放大模式」把潜空间放大到目标尺寸（=最终网格），\n"
                "再在 MODEL 上挂多级渐进补丁：「分段步数」决定分几段、每段几步，\n"
                "每个分段边界换纸一次，用放大模型把干净预测抬到下一级网格\n"
                "（级间倍率 × 段数 决定首段有多小：首段尺寸 = 满尺寸 ÷ 倍率^提升次数）。\n"
                "级间倍率 1.0 时各级同尺寸，只换纸重建（离群钳位）——与验证过的\n"
                "三节点组合一致。\n"
                "输出 模型 / 潜空间，分别接「🎯 H3 放大采样器」的 模型 / 潜空间。\n"
                "采样器仍必须选 euler；音频恒定透传一采原声（不重绘，音色不漂移）。"
            ),
            inputs=[
                io.Model.Input("模型", tooltip="接在 LoRA 等补丁之后、放大采样器之前。"),
                io.Latent.Input("潜空间", tooltip="一采输出的 AV 潜空间（视频+音频）。"),

                io.DynamicCombo.Input(
                    "放大方式",
                    display_name="放大方式",
                    tooltip="模型放大：加载放大模型推理，质量更高，约占 3GB 显存。\n"
                            "插值放大（三线性）：不加载模型、几乎零显存，靠重绘补细节。",
                    options=[
                        io.DynamicCombo.Option(_UpscaleWay.USE_MODEL, [
                            io.Combo.Input("放大模型", options=_upscale_scan_models(),
                                           tooltip="latent_upscale_models 目录下的 H3 放大模型权重。"),
                            io.Combo.Input("显存档位",
                                           options=[_UPSCALE_TILE_OFF] + list(_UPSCALE_VRAM_PRESETS),
                                           default=_UPSCALE_TILE_OFF,
                                           tooltip="空间分块：4G→8条、8G→6条、12G→4条、16G→3条、24G→2条；\n"
                                                   "「禁止」= 整幅一次推理。估算超出档位预算时自动加切。"),
                            io.Boolean.Input("放大前清显存", default=True,
                                             label_on="清空（主模型先让位）",
                                             label_off="保留（与独立节点行为一致）",
                                             tooltip="开启 = 放大前先把 H3 主模型等全部模型从显存换出到内存，\n"
                                                     "放大模型独占显存推理，峰值最低。代价：采样开始时主模型\n"
                                                     "要重新装回显存（多花几秒到几十秒）。\n"
                                                     "关闭 = 与独立「🎬 H3 Latent放大」节点行为完全一致。"),
                        ]),
                        io.DynamicCombo.Option(_UpscaleWay.TRILINEAR, []),
                    ],
                ),

                io.DynamicCombo.Input(
                    "mode",
                    display_name="放大模式",
                    tooltip="目标尺寸怎么算。",
                    options=[
                        io.DynamicCombo.Option(_UpscaleMode.SCALE_BY, [
                            io.Float.Input("放大倍数", default=1.5, min=1.0, max=4.0, step=0.05,
                                           tooltip="按倍数放大，1.0–4.0。输出尺寸 = 原始尺寸 × 倍数（像素按 32 对齐）。"),
                        ]),
                        io.DynamicCombo.Option(_UpscaleMode.TARGET_DIMENSIONS, [
                            io.Int.Input("目标宽度", default=1344, min=32, max=8192, step=32,
                                         tooltip="目标像素宽度，内部按像素网格对齐并反推等效倍率。"),
                            io.Int.Input("目标高度", default=768, min=32, max=8192, step=32,
                                         tooltip="目标像素高度，内部按像素网格对齐并反推等效倍率。"),
                        ]),
                        io.DynamicCombo.Option(_UpscaleMode.MEGAPIXELS, [
                            io.Float.Input("百万像素", default=1.0, min=0.1, max=16.0, step=0.1,
                                           tooltip="目标总像素（百万像素），自动保持原宽高比。"),
                        ]),
                    ],
                ),

                io.Float.Input("级间倍率", default=1.0, min=1.0, max=4.0, step=0.05, optional=True,
                               tooltip="每次提升的倍率（各级同倍率，与「🎯 SelfLift 多级渐进」同口径）：\n"
                                       "1.0 = 各级同尺寸，只换纸不放大（与验证过的三节点组合一致）；\n"
                                       ">1.0（如 2）= 每次提升翻一倍，总放大 = 倍率^提升次数，\n"
                                       "首段尺寸 = 满尺寸 ÷ 总放大（分段越多首段越小，越省算力）。\n"
                                       "选「模型放大（3D）」时提升用同款放大模型；三线性时没有模型，\n"
                                       "只能最近邻提升，画质明显变差（不建议 >1.0）。\n"
                                       "注意：>1.0 等价于独立 SelfLift 的中途提升路径，效果需自行实测。"),

                io.String.Input("分段步数", default="2", optional=True,
                                tooltip="每段各跑多少步，段数 = 数值个数（最后一段自动吃满剩余步数）：\n"
                                        "· 一个值（如 2）= 两段：前 2 步在缩小网格上试跑，其余在满尺寸精修\n"
                                        "  （等价原来的「过渡步数」）；\n"
                                        "· 两个值（如 3,3）= 两段：各 3 步；三个值（如 2,3,3）= 三段。\n"
                                        "段数越多、级间倍率越大，首段越小越省算力。\n"
                                        "合计步数少于 KSampler 总步数时，剩余自动并入最后一段；\n"
                                        "每个提升点的 sigma 必须 < 1，否则会报错提示。"),

                io.Combo.Input("满分辨率分块", options=_TILE_MODE_CHOICES,
                               default=_TILE_MODE_AUTO, optional=True,
                               tooltip="最后一段满尺寸收尾的显存策略（与「🎯 SelfLift 多级渐进」同款）：\n"
                                       "· 自动（按显存智能规划）：读空闲显存估算末段激活，富余→整幅，\n"
                                       "  紧张→切 2~16 块，6G 显存也能跑大画布收尾；\n"
                                       "· 关（整幅收尾）：整幅一次跑，显存大户选这个，无接缝开销；\n"
                                       "· 2~16 块（手动）：固定块数，越多越省显存、越慢、跨块一致性越差。\n"
                                       "要求 keyframe 与画布同网格，异网格会在采样开始时报错说明。\n"
                                       "实际是否分块看控制台「末段改为逐步同步分块收尾」那行日志。"),
            ],
            outputs=[
                io.Model.Output(display_name="模型",
                                tooltip="挂好过渡换纸补丁的 MODEL，接「🎯 H3 放大采样器」的模型。"),
                io.Latent.Output(display_name="放大后潜空间",
                                 tooltip="放大后的 latent，接「🎯 H3 放大采样器」的潜空间。"),
            ],
        )

    @classmethod
    def execute(cls, 模型, 潜空间, 放大方式=None, mode=None,
                级间倍率: float = 1.0, 分段步数: str = "2",
                满分辨率分块: str = _TILE_MODE_AUTO):
        # 条件未升级 → 三采没有新增信息，整条链路退化成纯一采：不放大、不挂
        # 多级补丁，模型与潜空间都原样传下去（下游采样器同样会直通）。
        if not _hd_upgraded(潜空间):
            print("[SelfLift 放大重绘] 条件未升级（与一采逐字相同）—— 跳过放大与"
                  "渐进补丁，模型/潜空间原样输出")
            return io.NodeOutput(模型, 潜空间)
        # DynamicCombo 前端只序列化当前激活选项的子控件。这里统一归一化成
        # 「🎬 H3 Latent放大」execute 接受的字典形状（键名以该节点为准）。
        if isinstance(放大方式, dict):
            way = {"放大方式": 放大方式.get("放大方式", _UpscaleWay.USE_MODEL),
                   "放大模型": 放大方式.get("放大模型"),
                   "时间分块": "开启",   # 固定开启（与三节点组合验证过的行为一致）
                   "空间分块": 放大方式.get("显存档位", _UPSCALE_TILE_OFF),
                   "放大前清显存": 放大方式.get("放大前清显存", True)}
        elif 放大方式 is None:
            way = {"放大方式": _UpscaleWay.USE_MODEL, "放大模型": None,
                   "时间分块": "开启", "空间分块": _UPSCALE_TILE_OFF,
                   "放大前清显存": True}
        else:  # 旧脚本直接传字符串
            way = {"放大方式": 放大方式, "时间分块": "开启", "空间分块": _UPSCALE_TILE_OFF,
                   "放大前清显存": True}

        if isinstance(mode, dict):
            mode_out = {"mode": mode.get("mode", _UpscaleMode.SCALE_BY),
                        "放大倍率": mode.get("放大倍数", 1.5),
                        "目标宽度": mode.get("目标宽度", 1344),
                        "目标高度": mode.get("目标高度", 768),
                        "百万像素": mode.get("百万像素", 1.0)}
        elif mode is None:
            mode_out = {"mode": _UpscaleMode.SCALE_BY, "放大倍率": 1.5}
        else:  # 旧脚本直接传字符串
            mode_out = {"mode": mode}

        # 1. 潜空间放大：复用「🎬 H3 Latent放大」的执行体，
        #    保证与独立节点逐位一致（fp16、时间分块、32 像素对齐、音频透传）。
        #    「放大前清显存」：一采 KSampler 跑完后 H3 主模型通常仍驻留显存，
        #    先把它整批换出到内存再装放大模型，放大瞬间的峰值最低。
        if way.get("放大方式") == _UpscaleWay.USE_MODEL and way.get("放大前清显存", True):
            if torch.cuda.is_available():
                comfy.model_management.unload_all_models()
                comfy.model_management.soft_empty_cache()
                log.info("[SelfLift 放大重绘] 已把驻留模型全部换出显存，放大模型独占推理")
        out = _H3LatentUpscaleNode.execute(
            latent=潜空间, 放大方式=way, mode=mode_out, repaint_strength=0.0)
        放大后潜空间 = out[0]

        # 2. 级间倍率 > 1：各分段边界用放大模型把干净预测抬到下一级网格。
        #    =1.0 时各级同尺寸，只换纸不放大（与验证过的三节点组合一致）。
        lift_ratio = 1.0 if 级间倍率 is None else float(级间倍率)
        lifter = None
        if lift_ratio > 1.001:
            if way.get("放大方式") == _UpscaleWay.USE_MODEL and way.get("放大模型"):
                lifter = _lifter.make_lifter(way["放大模型"], True)
                if lifter is None:
                    raise ValueError(
                        "🎯 SelfLift 放大重绘：没有可用的 H3 latent 放大模型，"
                        "无法按级间倍率在分段边界提升。请把模型文件放入 "
                        "models/latent_upscale_models 目录后刷新。")
            else:
                log.warning(
                    "[SelfLift 放大重绘] 级间倍率 %.2f > 1，但当前放大方式是三线性"
                    "（无放大模型），各分段边界只能最近邻提升，画质会明显变差；"
                    "建议改用「模型放大（3D）」或把级间倍率调回 1.0。", lift_ratio)

        # 3. 分段步数 → 每段步数（段数 = 数值个数）。单值 = 两段：前 N 步 + 剩余
        #    （补一个占位段，_plan 会把剩余步数并入最后一段）。输出 latent 保持
        #    满尺寸 —— 多级补丁自己把首段缩到 1/总倍率，逐段抬回最终网格。
        segs_text = "2" if not ("" if 分段步数 is None else str(分段步数)).strip() else str(分段步数)
        vals = _parse_num_list(segs_text, int, "分段步数")
        segs = [vals[0], 0] if len(vals) == 1 else vals

        # 满分辨率分块收尾：开关打开时用内置默认切条几何（与「🎬 H3 终极放大参数」
        # 的空间分块语义一致：tile=40格 overlap=8格 羽化=4，画布太小自动退回整幅）。
        spatial_params = None
        n_tiles = _tile_choice_to_n(满分辨率分块)
        if n_tiles is not None:
            spatial_params = {"tw": 40, "th": 40, "ol_w": 8, "ol_h": 8,
                              "fw": 8, "fh": 8, "mt": 24, "feather": 4,
                              "n_tiles": n_tiles}

        # 4. 挂多级渐进补丁（段数=2 且级间倍率=1 时，行为与原来的单次换纸一致）。
        patched = 模型.clone()
        if spatial_params is not None:
            # 分块收尾要用：全局坐标注入 wrapper 必须在采样准备前挂好。
            _install_tile_pos(patched)
        patched.add_wrapper_with_key(
            comfy.patcher_extension.WrappersMP.SAMPLER_SAMPLE,
            _MULTI_WRAPPER_KEY,
            _SelfLiftMultiStage(segs, [lift_ratio], lifter,
                                spatial_params=spatial_params,
                                # 单级节点没有时间分块控件 → 关掉，保持它原本的行为；
                                # 时间分块只在「🎯 SelfLift 多级渐进」上可用
                                time_mode=_TIME_MODE_OFF),
        )
        return io.NodeOutput(patched, 放大后潜空间)


# ============================================================
# 多级渐进：把"只换一次纸"推广成"按自定义步数分布逐级换纸"
#
# 与单级的差别只有换纸次数：每到一个分段边界，用学习式放大模型把干净预测抬到
# 下一级网格，按该处 sigma 重新加噪后继续跑。总 NFE 恒等于调度步数。
# ============================================================

_MULTI_WRAPPER_KEY = "banzhang_selflift_multistage"


def _parse_num_list(text, cast, name, tag="🎯 SelfLift 多级渐进"):
    """解析 "6,6,6" / "6，6，6" / "6 6 6" / "6、6、6" / "6;6;6" / "[6,14]" 这类输入。

    半角/全角逗号、空格、制表符、换行、顿号、分号都能当分隔符（20261015 泛化，
    五个 SelfLift 节点共用此函数：多级渐进 / 图片多级渐进 / 单级提升 / 多级完整采样）。
    非法直接报错，不做静默兜底。
    """
    s = str(text)
    for ch in ("，", "、", ";", "；"):
        s = s.replace(ch, ",")
    items = []
    for part in s.split(","):
        part = part.strip().strip("[]()")
        if not part:
            continue
        # 段内还剩空白（"6 6" / "6\t6" / "6\n6"）也按分隔符处理：
        # 用户从表格/别处粘过来的文本常带这类分隔
        for sub in part.split():
            try:
                items.append(cast(sub))
            except (TypeError, ValueError):
                raise ValueError(
                    f"{tag}：「{name}」里的 '{sub}' 不是合法数字。"
                    f"请填分隔符隔开的数字，例如 6,6,6")
    return items


def _suggest_split(total, n):
    """均分建议：步数富余优先给靠后的段（后段才是精修，换纸过晚风险更大）。"""
    base, rem = divmod(total, n)
    return [base + (1 if i >= n - rem else 0) for i in range(n)]


def _preview_at(state, cur_shapes, t, hw):
    """把当前段的 x0 抬到最终网格再交给回调（只影响预览，不参与结果）。"""
    if state is None:
        return None
    v, a = comfy.utils.unpack_latents(state, cur_shapes)
    v = torch.nn.functional.interpolate(
        v.float(), size=(t, hw[0], hw[1]), mode="trilinear", align_corners=False).to(v.dtype)
    return comfy.utils.pack_latents([v, a])[0]


class _SelfLiftMultiStage:
    """挂在 SAMPLER_SAMPLE 上的多级渐进分辨率采样补丁。

    分段步数必填（填几个数就是分几段），级间倍率可留空走自动：
    倍率留空 → 取训练档位 1.5，不限制首段尺寸。
    """

    def __init__(self, segments, ratios, lifter=None, spatial_params=None,
                 outlier_sigmas=9.0,
                 time_mode=_TIME_MODE_AUTO, chunk_frames=73, overlap_frames=22):
        self.segments = list(segments)
        self.ratios = list(ratios) if ratios else None
        self.lifter = lifter
        # 离群钳位阈值（σ）：默认 9.0，可调低到 7~8 救急（见 _winsorize_outliers）
        self.outlier_sigmas = float(outlier_sigmas)
        # 满分辨率分块收尾（与单级「满分辨率分块参数」同源）：
        # 只有跑在满尺寸网格上的段才切块。
        self.spatial_params = spatial_params
        # 时间分块（末段主省显存手段，移植自「🎬 H3 终极放大参数」）：
        # 语义见 _plan_temporal_segs；空间块退居第二维、只在显式指定块数时叠加。
        self.time_mode = str(time_mode)
        self.chunk_frames = int(chunk_frames)
        self.overlap_frames = int(overlap_frames)
        self._busy = False

    # ------------------------------------------------------------------
    # 分段计划
    # ------------------------------------------------------------------
    def _ratios_for(self, n_stages):
        if len(self.ratios) == 1:
            return [self.ratios[0]] * (n_stages - 1)
        return list(self.ratios)

    def _scales_from_ratios(self, ratios, n_stages):
        """各级相对最终网格的比例（最后一级恒为 1.0）。"""
        scales = [1.0] * n_stages
        for i in range(n_stages - 2, -1, -1):
            scales[i] = scales[i + 1] / ratios[i]
        return scales

    @staticmethod
    def _grids(scales, H, W):
        return [(max(2, round(H * s / 2) * 2), max(2, round(W * s / 2) * 2)) for s in scales]

    def _auto_ratios(self, n_stages):
        """自动倍率：取训练档位 1.5（与三采链路同档），不限制首段尺寸。"""
        log.info("[班长SelfLift·多级] 自动倍率取默认档位 1.5")
        return [1.5] * (n_stages - 1)

    def _plan(self, total_steps):
        """返回 (每段步数, 边界 sigma 索引)；最后一段吃满剩余步数。"""
        # 段数比总步数还多时，每段连 1 步都分不到 —— 这个检查必须先于一切
        segs = list(self.segments)
        if len(segs) > total_steps:
            raise ValueError(
                f"🎯 SelfLift 多级渐进：本次调度只有 {total_steps} 步，"
                f"填不下 {len(segs)} 段（每段至少 1 步）。"
                f"请减少「分段步数」的段数，或提高 KSampler 步数。")
        used = sum(segs)
        if used > total_steps:
            raise ValueError(
                f"🎯 SelfLift 多级渐进：「分段步数」合计 {used} 步，超过本次调度的 "
                f"{total_steps} 步（KSampler 步数 = {total_steps}）。\n"
                f"按你填的 {len(segs)} 段，可直接改成 \""
                f"{','.join(str(x) for x in _suggest_split(total_steps, len(segs)))}\"；"
                f"或把 KSampler 步数设为 {used} 及以上。")
        if used < total_steps:
            extra = total_steps - used
            segs[-1] += extra
            log.info("[班长SelfLift·多级] 分段步数合计 %d 少于总步数 %d，"
                     "剩余 %d 步并入最后一段（最后一段 %d 步）",
                     used, total_steps, extra, segs[-1])
        bounds = []
        acc = 0
        for s in segs[:-1]:
            acc += s
            bounds.append(acc)
        return segs, bounds

    # ------------------------------------------------------------------
    # 过渡：抬到下一级
    # ------------------------------------------------------------------
    def _transition(self, state, x0, cur_shapes, ms, sigma_k, sigma_next, next_hw,
                    device, noise_seed):
        video_state, audio_state = comfy.utils.unpack_latents(state, cur_shapes)
        video_x0, audio_x0 = comfy.utils.unpack_latents(x0, cur_shapes)
        # 音频锚点也过一道离群钳位（与视频 z_lat 同款）。
        # 视频的 x0 放大后会钳一次、音频的一直没人管 —— 冒出来的离群点会一路带进
        # VAE，解码出来就是偶发的爆音/破音。音频没有空间维度，不需要放大，
        # 所以直接钳 x0 本身（视频钳的是放大后的 z_lat）。
        audio_x0 = _winsorize_outliers(audio_x0, "（多级·音频锚点）",
                                       sigmas=self.outlier_sigmas)
        # 音频流没有空间维度，跟着复用同一个 Euler 边界步继续走
        auxiliary_next = _euler_step(audio_state, audio_x0, sigma_k, sigma_next)
        # [音频诊断] 每次换纸打一行：看 std 是否在这里跳变，以及换纸次数越多是否单调放大
        log.info("[班长SelfLift·多级·音频] 换纸 σ=%.4f→%.4f | 换纸前 std=%.4f → 换纸后 std=%.4f | "
                 "本段模型音频 x0 std=%.4f、换纸后峰值=%.4f",
                 float(sigma_k), float(sigma_next),
                 float(audio_state.float().std()), float(auxiliary_next.float().std()),
                 float(audio_x0.float().std()), float(auxiliary_next.float().abs().max()))

        # 换纸：放大走 learned lifter；缩小必须走插值 —— 学习式放大模型只训练过
        # 1.5× 放大，拿它做缩小是外推，出来的网格是废的。
        cur_hw = (int(video_x0.shape[-2]), int(video_x0.shape[-1]))
        shrink = next_hw[0] <= cur_hw[0] and next_hw[1] <= cur_hw[1]
        z_lat, _ = _lifts.paired_lifts(
            video_x0.float(), None, next_hw,
            "bilinear" if shrink else "nearest",
            None if shrink else self.lifter,
            need_lat=True, need_pix=False)
        z_lat = _winsorize_outliers(z_lat,
                                    "（提升至 %dx%d）" % (next_hw[1] * 16, next_hw[0] * 16),
                                    sigmas=self.outlier_sigmas)
        # 逐帧曝光守恒：learned lifter 会整体抬亮（续写接缝处尤其明显——条件里的
        # 引导头经 _resize_keyframes 亮度被钉住、状态里的头却被抬亮）。把放大后
        # 每帧每通道的空间均值拉回低清干净端点，lifter 的细节保留、只去曝光漂移。
        z_lat = _lifts.match_lift_exposure(z_lat, video_x0)
        z0 = _hand_off(z_lat, device)
        video_noise = _hand_off(comfy.sample.prepare_noise(z0, noise_seed), device)
        video_next = _euler_step(ms.noise_scaling(sigma_k, video_noise, z0), z0,
                                 sigma_k, sigma_next)
        aux_next = ms.inverse_noise_scaling(sigma_next, auxiliary_next)
        pack, _ = comfy.utils.pack_latents(
            [ms.inverse_noise_scaling(sigma_next, video_next), aux_next])
        del video_state, audio_state, video_x0, audio_x0, auxiliary_next
        del z_lat, z0, video_noise, video_next, aux_next
        return _hand_off(pack, device)

    # ------------------------------------------------------------------
    # 每段的回调：按全局步号回传、预览统一抬到最终网格
    # ------------------------------------------------------------------
    def _make_callback(self, stage, stage_steps, offset, total, callback,
                       cur_shapes, t, target_hw, sink):
        calls = [0]
        last = stage_steps - 1

        def cb(step, x0, x, _total):
            j = calls[0]
            calls[0] += 1
            if j > last:
                raise RuntimeError(
                    f"🎯 SelfLift 多级渐进：第 {stage + 1} 段回调次数超出预期；"
                    "采样器可能被其它插件包装")
            if j == last:
                sink["x"], sink["x0"] = x, x0
            if callback is None:
                return None
            if target_hw is None:                       # 最后一段本就是最终网格
                return callback(offset + j, x0, x, total)
            prev = _preview_at(x0, cur_shapes, t, target_hw)
            return callback(offset + j, prev, prev, total)

        return cb, calls

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
            raise ValueError("🎯 SelfLift 多级渐进：本补丁目前只支持 MiniMax H3 模型")

        sampler_obj = executor.class_obj
        if getattr(sampler_obj, "sampler_function", None) is not comfy.k_diffusion.sampling.sample_euler:
            raise ValueError(
                "🎯 SelfLift 多级渐进：采样器必须选标准 euler。"
                "多级提升复用边界步的预测来保持总 NFE 不变，其它采样器无法套用。")
        if sampler_obj.extra_options.get("s_churn", 0.0) != 0.0:
            raise ValueError("🎯 SelfLift 多级渐进：euler 的 s_churn 必须为 0")
        if not isinstance(model.model_sampling, comfy.model_sampling.CONST):
            raise ValueError("🎯 SelfLift 多级渐进：需要 rectified-flow 模型")

        total_steps = int(sigmas.numel()) - 1
        if total_steps < 2:
            return executor(guider, sigmas, extra_args, callback,
                            noise, latent_image, denoise_mask, disable_pbar)
        segs, bounds = self._plan(total_steps)
        n = len(segs)
        if n < 2:
            return executor(guider, sigmas, extra_args, callback,
                            noise, latent_image, denoise_mask, disable_pbar)
        if segs[-1] < 3:
            # 末段（满分辨率精修）步数太少，换纸注入的离群值洗不掉 → 彩色光点。
            suggest = ",".join(str(x) for x in _suggest_split(total_steps, n))
            log.warning(
                "[班长SelfLift·多级] 最后一段只有 %d 步，彩色光点风险高："
                "末段步数不足，换纸注入的离群值洗不掉。"
                "建议把「分段步数」改成 %s，或把 KSampler 步数提到 %d 以上"
                "（剩余步数会自动并入最后一段）。",
                segs[-1], suggest, sum(segs[:-1]) + 3)
        for b in bounds:
            if not 1 <= b <= total_steps - 1:
                raise ValueError(
                    f"🎯 SelfLift 多级渐进：第 {b} 步不是可用的提升点"
                    f"（应取 1 ~ {total_steps - 1}），请调整「分段步数」")
            if float(sigmas[b]) >= 1.0:
                raise ValueError(
                    "🎯 SelfLift 多级渐进：某次提升后的起始 sigma ≥ 1 —— "
                    "请把前面各段的步数调大，或降低 KSampler 的降噪强度。")
        if bool((sigmas[1:] > sigmas[:-1]).any()) or bool((sigmas[:-1] <= 0).any()):
            raise ValueError("🎯 SelfLift 多级渐进：sigmas 必须非递增，且只有最后一项可为 0")

        shapes = getattr(model, "latent_shapes", None)
        if not shapes or len(shapes) < 2:
            raise ValueError("🎯 SelfLift 多级渐进：需要一个音视频双流的 H3 latent")
        shapes = [tuple(s) for s in shapes]
        video_shape = shapes[0]
        if len(video_shape) != 5:
            raise ValueError(f"🎯 SelfLift 多级渐进：视频 latent 应为 5 维，实际 {video_shape}")
        t, H, W = video_shape[2], video_shape[3], video_shape[4]
        audio_shape = shapes[1]
        mask_streams = _split_denoise_mask(denoise_mask, shapes)
        if mask_streams is not None:
            # 两条流必须分开处置 —— 20261010 修花屏的根因只在视频那一路：
            # 方案 A 的钉帧遮罩参照物是喂进 KSampler 的原稿，而多级渐进在采样
            # 中途把 latent 抬到 1.5× 网格，参照物已经不在；再逐段按网格重采样、
            # 跨换纸边界硬套，末段会发散成 13% 离群（峰值几十 σ）→ 满屏彩色光点。
            # 视频有空间维度、会跨网格，所以保留区一律作废（全 1 = 不保留任何区域，
            # 数值上等价于丢弃遮罩）；钉帧仍由方案 B「🧷 尾帧回填」保证，一分不差。
            # 音频没有空间维度，永远只有一条时间轴、不需要按网格重采样，
            # 不受上述问题影响，原样保留 —— 这就是「保住原声」的开关。
            v_mask, a_mask = mask_streams[0], mask_streams[1]
            if float(v_mask.min()) < 1.0:
                log.warning("[班长SelfLift·多级] 检测到视频遮罩（保留区）：多级提升会跨网格，"
                            "遮罩的参照物已不在 —— 本次忽略视频保留区"
                            "（钉帧由「🧷 尾帧回填」保证，不受影响）")
                v_mask = torch.ones_like(v_mask)
            if float(a_mask.min()) < 1.0:
                log.info("[班长SelfLift·多级] 音频遮罩生效：本次保留输入音频"
                         "（掩码为 0 的位置不重新生成）")
            if float(v_mask.min()) >= 1.0 and float(a_mask.min()) >= 1.0:
                mask_streams = None      # 两路都没有保留区，等价于没给遮罩
            else:
                mask_streams = [v_mask, a_mask]

        if self.ratios is None:
            ratios = self._auto_ratios(n)                # 自动：训练档位 1.5
        else:
            ratios = self._ratios_for(n)                 # 手动：用户给的倍率
        scales = self._scales_from_ratios(ratios, n)
        grids = self._grids(scales, H, W)

        # 首段提示：低于 H3 训练分布下限 384 时提醒（仅提示，不影响运行）
        first_px = min(grids[0]) * 16
        if first_px < 384:
            log.warning("[班长SelfLift·多级] 首段短边 %dpx 低于 H3 训练分布下限 384，"
                        "画质可能受影响（仅提示，不影响运行）", first_px)
        # 任何一级掉下限都提醒：先大后小时最小的是末段，而末段决定最终细节，更要紧
        min_idx = min(range(n), key=lambda i: min(grids[i]))
        if min_idx != 0:
            min_px = min(grids[min_idx]) * 16
            if min_px < 384:
                log.warning("[班长SelfLift·多级] 第 %d 段短边 %dpx 低于 H3 训练分布下限 384，"
                            "这一段决定最终细节，画质可能受影响（仅提示，不影响运行）",
                            min_idx + 1, min_px)
        # 护栏②：网格取整后实际倍率偏离设定值
        for i, r in enumerate(ratios):
            real = max(grids[i + 1][0] / grids[i][0], grids[i + 1][1] / grids[i][1])
            if abs(real - r) / r > 0.10:
                log.warning("[班长SelfLift·多级] 第 %d 次提升的实际倍率 %.3f 与设定 %.3f 偏差超 10%%"
                            "（网格取整导致）", i + 1, real, r)
        # 护栏③：过渡注入权重（换纸越晚，提升结果在最终画面里占的分量越大）
        for i, b in enumerate(bounds):
            weight = 1.0 - float(sigmas[b - 1])
            if weight > 0.5:
                log.warning("[班长SelfLift·多级] 第 %d 次提升的注入权重 %.3f > 0.5（换纸过晚），"
                            "建议加大后段步数或把提升点前移", i + 1, weight)
        # 一行式阶梯总览（诊断时整行抄出来即可）
        log.info("[班长SelfLift·多级] 阶梯：画布 %dx%d | %s | 倍率 %s（%s）| 分段 %s",
                 W * 16, H * 16,
                 " → ".join(f"{h * 16}x{w * 16}" for h, w in grids),
                 ",".join(f"{r:.3f}".rstrip("0").rstrip(".") for r in ratios),
                 "自动" if self.ratios is None else "手动",
                 ",".join(str(s) for s in segs))
        for i, b in enumerate(bounds):
            log.info("[班长SelfLift·多级] 第 %d 次提升 sigma=%.6g→%.6g 注入权重=%.4f "
                     "网格 %dx%d → %dx%d",
                     i + 1, float(sigmas[b - 1]), float(sigmas[b]),
                     1.0 - float(sigmas[b - 1]),
                     grids[i][0], grids[i][1], grids[i + 1][0], grids[i + 1][1])

        device = guider.model_patcher.load_device
        seed = int(extra_args.get("seed") or 0)
        ms = model.model_sampling

        # 第一段：把初始 latent 下采样到首段网格（空 latent 恒等，不引入偏差）
        video_ms, audio_ms = comfy.utils.unpack_latents(latent_image, shapes)
        # [音频诊断] 入口基线：与出口那行对比，判断音频整体是被放大、塌缩还是正常
        _a_in = audio_ms.float()
        log.info("[班长SelfLift·多级·音频] 入口 | std=%.4f 峰值=%.4f 均值=%.6f"
                 "（输入 latent 全 0 时这里应当接近 0）",
                 float(_a_in.std()), float(_a_in.abs().max()), float(_a_in.mean()))
        del _a_in
        h0, w0 = grids[0]
        video0 = torch.nn.functional.interpolate(
            video_ms.float(), size=(t, h0, w0), mode="trilinear", align_corners=False
        ).to(video_ms.dtype)
        noise_streams = comfy.sample.prepare_noise(
            comfy.nested_tensor.NestedTensor([video0, audio_ms]), seed).unbind()
        video_noise, audio_noise = noise_streams[0], noise_streams[1]
        pack0, _ = comfy.utils.pack_latents([video0, audio_ms])
        saved_shapes = model.latent_shapes
        latent0 = pack0
        noise0, _ = comfy.utils.pack_latents([video_noise, audio_noise])
        # 音频锚点：口径与单级节点一致 —— 本补丁由 SAMPLER_SAMPLE wrapper 调用时，
        # 外层 CFGGuider 已对非零 latent 做过 process_latent_in（音频 ×audio_scale），
        # 这里的 audio_ms 已经是内层采样空间，再乘一次会放大到 audio_scale² → 爆音。
        audio_anchor = audio_ms

        saved_conds = guider.conds
        original_conds = getattr(guider, "original_conds", None)
        if original_conds is None:
            log.warning("[班长SelfLift·多级] 读不到 guider.original_conds，各段将沿用最终网格的条件")

        started = time.perf_counter()
        self._busy = True
        resume_pack = None
        out = None
        try:
            for i in range(n):
                h_i, w_i = grids[i]
                stage_shapes = [(video_shape[0], video_shape[1], t, h_i, w_i), audio_shape]
                mask_i = _denoise_mask_for_grid(mask_streams, stage_shapes)
                start = 0 if i == 0 else bounds[i - 1]
                end = bounds[i] if i < n - 1 else total_steps
                steps = end - start
                last = (i == n - 1)
                if last and getattr(self.lifter, "unload", False):
                    # 末段不再提升：放大模型用完即焚（彻底丢弃，不是搬回内存等复用）
                    _lifter.release()
                sink = {}
                cb, calls = self._make_callback(
                    i, steps, start, total_steps, callback,
                    stage_shapes, t, None if last else (H, W), sink)

                conds_i = None
                if original_conds is not None:
                    conds_i = {k: [c.copy() for c in v] for k, v in original_conds.items()}
                    for key in ("positive", "negative"):
                        if key in conds_i:
                            conds_i[key] = _resize_keyframes(conds_i[key], h_i, w_i)
                    if i > 0:
                        # 中间段不能走 inner_sample：它会对非零 latent 再乘一次音频系数。
                        # 这里自己处理条件，再直接交给原生的 sampler.sample。
                        conds_i = comfy.samplers.process_conds(
                            model, noise, conds_i, device, latent_image=None,
                            denoise_mask=mask_i, seed=seed, latent_shapes=stage_shapes)
                model.latent_shapes = stage_shapes
                if conds_i is not None:
                    guider.conds = conds_i
                try:
                    if i == 0:
                        out = guider.inner_sample(
                            _hand_off(noise0, device), _hand_off(latent0, device), device,
                            sampler_obj, sigmas[start:end + 1], mask_i, cb,
                            disable_pbar, seed, latent_shapes=stage_shapes)
                    else:
                        _ensure_highres_headroom(guider.model_patcher, device)
                        stage_noise, stage_latent = torch.zeros_like(resume_pack), resume_pack
                        if mask_streams is not None:
                            # 音频有保留区时，resume_pack 里的内嵌噪声会被当成预测残差
                            # → 噪声水平逐段漂移、音频发闷破损（与单级同一口径）
                            stage_noise, stage_latent = _resume_pack_with_pure_audio(
                                resume_pack, audio_anchor, float(sigmas[start]))
                        # 末段（满尺寸网格）省显存：**时间分块是主手段**，空间块退居
                        # 第二维、只在显式指定块数（2/4/8/16）时才叠加。
                        # 前面各段都在缩小网格上跑，用不着分块。
                        big_grid = (h_i >= H and w_i >= W)
                        time_segs = None
                        if self.time_mode != _TIME_MODE_OFF and big_grid:
                            free_bytes = (comfy.model_management.get_free_memory(device)
                                          if self.time_mode == _TIME_MODE_AUTO else None)
                            time_segs = _plan_temporal_segs(
                                t, int(audio_shape[-1]), self.time_mode,
                                self.chunk_frames, self.overlap_frames,
                                h_i, w_i, free_bytes)
                        tiling = None
                        # 分块保护的是「网格最大的那一级」：标准渐进（越采越大）里就是末段；
                        # 前段放大的用法（倍率 < 1）里峰值反而在前面某段，只守末段会 OOM。
                        if self.spatial_params is not None and big_grid:
                            # n_tiles=0（智能档）才需要读显存；手动档不白跑一次 NVML。
                            n_manual = self.spatial_params.get("n_tiles")
                            if time_segs is not None and n_manual == 0:
                                # 时间分块已经接管显存，自动档不再叠空间块：两条轴都
                                # 自动切等于切两次，每步前向次数相乘、耗时线性涨。
                                log.info("[班长SelfLift·时间] 时间分块已生效，"
                                         "「满分辨率分块」自动档本次不叠加"
                                         "（要二维分块请手动指定 2/4/8/16 块）")
                            else:
                                tiling = _plan_fullres_tiling(
                                    self.spatial_params, h_i, w_i,
                                    n_tiles_manual=n_manual,
                                    free_bytes=(comfy.model_management.get_free_memory(device)
                                                if n_manual == 0 else None),
                                    t_frames=t)
                        if tiling is not None or time_segs is not None:
                            if tiling is not None:
                                t_axis, t_starts, t_size, t_ov, t_fe = tiling
                                _validate_tiling_keyframes(guider, h_i, w_i)
                                desc = (f"长边={t_axis} 共{len(t_starts)}块 "
                                        f"tile={t_size}格 overlap={t_ov} 羽化={t_fe}")
                                if time_segs is not None:
                                    desc = f"时间 {len(time_segs)} 段 × 空间（{desc}）"
                            else:
                                # 纯时间分块：空间上只有一块（整幅），不注入坐标偏移
                                t_axis, t_starts, t_size, t_ov, t_fe = "H", [0], h_i, 0, 0
                                desc = f"时间 {len(time_segs)} 段（空间整幅）"
                            log.info(
                                "[班长SelfLift·多级] 第 %d 段改为逐步同步分块：%s"
                                "（画布 %d格×%d格 / %dpx×%dpx）",
                                i + 1, desc, h_i, w_i, w_i * 16, h_i * 16)
                            # 与 KSAMPLER.sample 同口径的入口加噪：CONST 下
                            # noise_scaling(σ, 0, latent) = (1-σ)·latent，恰好还原续跑状态
                            x0_state = ms.noise_scaling(
                                sigmas[start], stage_noise, stage_latent, False)
                            out = _sample_tiled_highres(
                                guider, model, sigmas[start:end + 1], extra_args, cb,
                                x0_state, stage_latent, stage_noise, mask_i,
                                stage_shapes, t_axis, t_starts, t_size, t_ov, t_fe,
                                h_i, w_i, step_offset=start, total_steps=total_steps,
                                disable_pbar=disable_pbar, temporal_segs=time_segs)
                        else:
                            out = executor(guider, sigmas[start:end + 1], extra_args, cb,
                                           stage_noise, stage_latent, mask_i, disable_pbar)
                finally:
                    guider.conds = saved_conds
                    model.latent_shapes = saved_shapes
                if calls[0] != steps:
                    raise RuntimeError(
                        f"🎯 SelfLift 多级渐进：第 {i + 1} 段应跑 {steps} 步，实际 {calls[0]} 步；"
                        "采样器可能被其它插件包装")
                if last:
                    break
                # 提升前按 4GB 预算给放大模型腾地方（与单级节点过渡处同一口径，必做）：
                # 段首那次 _ensure_highres_headroom 只为扩散前向留了 2GB 门槛，
                # 没有为 lifter 凑预算；不腾的话放大模型只能拿到残余空闲显存，
                # 智能时间分块会被压到 34/17/8 帧一片，融合带随之缩到 8/4/2 帧，
                # 3D 时间感受野（半径≈75 帧）被切碎 —— 运动剧烈的区域在时间片
                # 边界帧会出现果冻状形变 / 蠕动（时间片越小、提升次数越多越明显）。
                # 4GB 可把末级提升的片长从 34 帧抬到 68 帧：边界数减半、融合带加倍。
                _ensure_highres_headroom(guider.model_patcher, device,
                                         need=4 * 1024 ** 3)
                resume_pack = self._transition(
                    sink["x"], sink["x0"], stage_shapes, ms,
                    sigmas[start + steps - 1], sigmas[start + steps],
                    grids[i + 1], device, (seed + 1 + i) % (1 << 64))
                del sink

            log.info("[班长SelfLift·多级] 共 %d 段，总耗时 %.3fs", n,
                     time.perf_counter() - started)
            # 出口兜底钳位：钳位只覆盖"换纸"那一瞬间，末段采样/分块里新产生的离群值
            # 之前没人管（末段步数少时最容易冒彩色光点）。出厂前对视频流统一拦一道。
            out_shapes = [(video_shape[0], video_shape[1], t, H, W), audio_shape]
            v_out, a_out = comfy.utils.unpack_latents(out, out_shapes)
            v_out = _winsorize_outliers(v_out, "（多级·收尾 %dx%d）" % (W * 16, H * 16),
                                        sigmas=self.outlier_sigmas)
            # [音频诊断] 出口（钳位前）：与入口/各次换纸那几行连起来看，即可定位音频在哪一步被带偏
            _a_out = a_out.float()
            log.info("[班长SelfLift·多级·音频] 出口（钳位前）| std=%.4f 峰值=%.4f 均值=%.6f",
                     float(_a_out.std()), float(_a_out.abs().max()), float(_a_out.mean()))
            del _a_out
            # 音频出口也过一道离群钳位（与视频 v_out 同款）：末段采样里新冒出的离群点
            # 之前只有视频被拦、音频一路裸奔进 VAE，偶发的爆音/破音就是它。
            a_out = _winsorize_outliers(a_out, "（多级·音频收尾）",
                                        sigmas=self.outlier_sigmas)
            out, _ = comfy.utils.pack_latents([v_out, a_out])
            return out
        finally:
            self._busy = False


class BanZhang_SelfLiftMultiStage:
    """多级渐进分辨率采样补丁（MODEL → MODEL）：采样过程中按自定义步数分布逐级提升。"""

    DESCRIPTION = (
        "分段提升分辨率：只填「分段步数」（如 6,6,6），其余默认；爆显存调分块。"
    )

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "模型": ("MODEL", {
                    "tooltip": "接在 LoRA 加载器之后、采样器之前。",
                }),
                "分段步数": ("STRING", {
                    "default": "6,6,6",
                    "multiline": False,
                    "tooltip": (
                        "填逗号分隔的步数，填几个数就是分几段，例：18 步填 6,6,6 → 三段阶梯。\n"
                        "合计必须 ≤ KSampler 步数（超出会报错并给出建议值）；\n"
                        "不足时剩余步数并入最后一段。"
                    ),
                }),
                "级间倍率": ("STRING", {
                    "default": "",
                    "multiline": False,
                    "tooltip": (
                        "相邻两级的尺寸比（后一级 ÷ 前一级）。\n"
                        "留空 = 自动 1.5：小图打底 → 满图收尾，推荐。\n"
                        "填 > 1（如 1.5）：后面一级更大，前面便宜、末段出细节。\n"
                        "填 < 1 是反方向：首段会比最终画布还大（0.6 三段 = 2.8 倍），"
                        "显存猛增且没有收益，不建议。\n"
                        "可逐级给，个数 = 分段个数 - 1（例 1.5,1.2）。范围 0.25 ~ 4.0。"
                    ),
                }),
                "latent放大模型": (_lifter.list_models(), {
                    "default": _lifter.default_model(),
                    "tooltip": (
                        "每级「换纸」用的提升算法。\n"
                        "列表来自 models/latent_upscale_models 目录，默认自动选名字含 h3 的模型。\n"
                        "必须走学习式放大：最近邻插值实测伪影严重，已不提供。"
                    ),
                }),
            },
            "optional": {
                "满分辨率分块": (_TILE_MODE_CHOICES, {
                    "default": _TILE_MODE_AUTO,
                    "tooltip": (
                        "末段（满尺寸网格）的显存策略。只在末段生效——前面各段跑在缩小网格上，"
                        "用不着分块。\n"
                        "\n"
                        "【自动（按显存智能规划）】← 推荐新手直接用\n"
                        "  采样前读当前空闲显存，估算末段整幅激活需要多大，自动决定：\n"
                        "  显存富余 → 整幅收尾（无接缝，画质最好）；\n"
                        "  显存紧张 → 切 2~16 块（显存峰值≈单块，6G 卡也能跑大画布）。\n"
                        "  预算连 16 块都不够时控制台会警告并建议缩短时长。\n"
                        "\n"
                        "【关（整幅收尾）】\n"
                        "  显存大户才选这个：不分块、无融合开销、跨块一致性最好。\n"
                        "\n"
                        "【2 / 4 / 8 / 16 块】\n"
                        "  块数越多越省显存，但物体跨块处可能轻微不一致，"
                        "  且每步要做更多次前向（变慢）。\n"
                        "  显存不够往大调，出现拼接痕迹 / 太慢往小调。\n"
                        "\n"
                        "【填了也没用的两种情况】（选自动可避开）\n"
                        "  ① 画布长边 ≤ 24 格（约 384px）→ 画布本身就太小，怎么填都不切\n"
                        "  ② 切出来每块仍覆盖 ≥90% 长边 → 等于没切，自动加密块数直到能切\n"
                        "\n"
                        "6G 显存配套：启动参数去掉 --disable-smart-memory 和 --highvram，\n"
                        "「显存预留卫士」预留容量设 0，动态加载保持开启。\n"
                        "实际是否分块看控制台「末段改为逐步同步分块收尾」那行日志。\n"
                        "注意：要求 keyframe 与画布同网格，否则采样开始时直接报错。"
                    ),
                }),
                # —— 时间分块三项留在最后：老存档按位置存值，插中间会整列错位 ——
                "时间分块": (_TIME_MODE_CHOICES, {
                    "default": _TIME_MODE_AUTO,
                    "tooltip": (
                        "只在末段（满尺寸网格）生效：沿时间轴切段，每段是一次较小的前向。\n"
                        "\n"
                        "【自动（显存不够才切）】← 推荐\n"
                        "  算法与空间分块同一套显存估算：够整条跑就不切；不够就按时长均分。\n"
                        "【关（整条收尾）】时间轴整条一次算，最干净、最吃显存。\n"
                        "【开（用下面两个参数）】按你填的「每块帧数 / 重叠帧数」切。\n"
                        "\n"
                        "与空间分块的区别：\n"
                        "  时间分块——各段共用同一条去噪轨迹（每个 sigma 步把所有段都前向一遍），\n"
                        "  段间三角羽化融合 → 没有「成品 vs 重新生成」的硬切，不跳变。\n"
                        "  空间分块——切画面，接缝是画面里的一条线（运动跨界会轻微果冻）。\n"
                        "\n"
                        "两条轴同时开 = 二维分块，显存更省但每步前向次数相乘、更慢。\n"
                        "「满分辨率分块」是自动档时，时间分块一旦生效就不再叠空间块；\n"
                        "想强制二维分块，把「满分辨率分块」改成手动 2/4/8/16 块。"
                    ),
                }),
                "每块帧数": ("INT", {
                    "default": 73, "min": 5, "max": 2000, "step": 17,
                    "tooltip": (
                        "仅「时间分块 = 开」时生效：每段覆盖多少像素帧。\n"
                        "步进 17 是为了落在 H3 的 5+17k 合法档位上（22 / 39 / 56 / 73 / 90 …）。\n"
                        "调大 = 段更少、时间上下文更长、显存更高；调小反之。\n"
                        "有效档位看控制台「[H3时间分块] 块长 …」那行。"
                    ),
                }),
                "重叠帧数": ("INT", {
                    "default": 22, "min": 5, "max": 1000, "step": 17,
                    "tooltip": (
                        "仅「时间分块 = 开」时生效：相邻两段重叠多少帧（≈1 秒的 22 帧）。\n"
                        "重叠区是羽化融合带：越宽段边界越稳，但要多算一些。\n"
                        "必须小于「每块帧数」，否则切不动。"
                    ),
                }),
            },
        }

    RETURN_TYPES = ("MODEL",)
    FUNCTION = "apply"
    CATEGORY = "👨‍🏫班长/MiniMax H3"

    def apply(self, 模型, 分段步数="6,6,6", 级间倍率="",
              latent放大模型=None,
              满分辨率分块=_TILE_MODE_AUTO,
              时间分块=_TIME_MODE_AUTO, 每块帧数=73, 重叠帧数=22):
        # 老存档按位置存值，删控件会整列错位；越界一律回默认，不让整条工作流跑不了。
        时间分块 = _coerce_time_mode(时间分块)
        每块帧数 = _coerce_int(每块帧数, 73, "每块帧数")
        if not 5 <= 每块帧数 <= 2000:
            log.warning("「每块帧数」= %d 超出 5 ~ 2000，本次按 73 处理"
                        "（多为老工作流控件错位）", 每块帧数)
            每块帧数 = 73
        重叠帧数 = _coerce_int(重叠帧数, 22, "重叠帧数")
        if not 5 <= 重叠帧数 <= 1000:
            log.warning("「重叠帧数」= %d 超出 5 ~ 1000，本次按 22 处理", 重叠帧数)
            重叠帧数 = 22
        segs = _parse_num_list(分段步数, int, "分段步数")
        if len(segs) < 2:
            raise ValueError(
                "🎯 SelfLift 多级渐进：「分段步数」必填且至少两段，例如 6,6,6"
                "（单段请用 🎯 SelfLift 渐进提升）")
        if any(s < 1 for s in segs):
            raise ValueError("🎯 SelfLift 多级渐进：「分段步数」每段至少 1 步")
        n_stages = len(segs)
        ratios = _parse_num_list(级间倍率, float, "级间倍率")
        if ratios:
            if len(ratios) != 1 and len(ratios) != n_stages - 1:
                raise ValueError(
                    f"🎯 SelfLift 多级渐进：「级间倍率」应填 1 个值，或填 {n_stages - 1} 个值"
                    f"（{n_stages} 段）；当前填了 {len(ratios)} 个")
            # 相邻两级的尺寸比（后一级 ÷ 前一级）：> 1 = 越采越大（标准渐进，
            # 小图打底、满图收尾）；< 1 = 越采越小（先大后小，用大网格定结构、
            # 小网格跑完剩余步数省算力）。两种可以混填，阶梯不要求单调。
            for r in ratios:
                if not 0.25 <= r <= 4.0:
                    raise ValueError(
                        f"🎯 SelfLift 多级渐进：「级间倍率」应在 0.25 ~ 4.0 之间，"
                        f"当前填了 {r}（>1 放大收尾，<1 缩小收尾）")
        else:
            ratios = None      # 自动：训练档位 1.5

        if latent放大模型 is None:
            latent放大模型 = _lifter.default_model()
        lifter = _lifter.make_lifter(latent放大模型, True)
        if lifter is None:
            raise ValueError(
                "🎯 SelfLift 多级渐进：没有可用的 H3 latent 放大模型。"
                "请把模型文件放入 models/latent_upscale_models 目录后刷新。")

        # 满分辨率收尾的下拉三态：关=不分块 / 自动=按显存智能 / N=手动块数。
        # 内置几何与「🎯 SelfLift 放大重绘（二合一）」同一套（tile=40格 overlap=8格 羽化=4）。
        # 画布太小（长边 ≤24格）时 _plan_fullres_tiling 退回整幅，不报错。
        n_tiles = _tile_choice_to_n(满分辨率分块)
        spatial_params = None
        if n_tiles is not None:
            spatial_params = {"tw": 40, "th": 40, "ol_w": 8, "ol_h": 8,
                              "fw": 8, "fh": 8, "mt": 24, "feather": 4,
                              "n_tiles": n_tiles}

        patched = 模型.clone()
        if spatial_params is not None:
            # 分块收尾要用：全局坐标注入 wrapper 必须在采样准备前挂好
            #（wrapper 列表在采样开始时快照进 model_options，中途补挂不生效）。
            _install_tile_pos(patched)
        patched.add_wrapper_with_key(
            comfy.patcher_extension.WrappersMP.SAMPLER_SAMPLE,
            _MULTI_WRAPPER_KEY,
            # 彩色光点钳位保留在类里，固定默认 9.0：控件删了，画质不变。
            _SelfLiftMultiStage(segs, ratios, lifter,
                                spatial_params=spatial_params,
                                outlier_sigmas=9.0,
                                time_mode=时间分块,
                                chunk_frames=每块帧数,
                                overlap_frames=重叠帧数),
        )
        return (patched,)


class BanZhang_SelfLiftSampler:
    """采样器节点：允许输出 latent 尺寸与输入不同（配 🎯 SelfLift 渐进提升的放大）。

    与官方 KSampler 唯一的差别在收尾那一步：
    官方走 guider.sample()，它在返回前会用「输入时的网格」把结果重新打包，
    中途放大的 latent 会被按旧网格切开（画面花 + 尺寸回退）。
    本节点走 guider.outer_sample()，没有那次重打包，按实际网格输出。
    """

    DESCRIPTION = (
        "代替 KSampler：允许输出比输入大，放大后的 latent 不会被压回原尺寸。"
    )

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "模型": ("MODEL", {"tooltip": "接在 🎯 SelfLift 渐进提升 之后的 MODEL。"}),
                "正面条件": ("CONDITIONING", {}),
                "潜空间": ("LATENT", {}),
                "随机种子": ("INT", {
                    "default": 0, "min": 0, "max": 0xffffffffffffffff,
                    "control_after_generate": True,
                }),
                "步数": ("INT", {"default": 8, "min": 1, "max": 10000}),
                "CFG": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 100.0, "step": 0.1}),
                "采样器": (comfy.samplers.KSampler.SAMPLERS, {"default": "euler"}),
                "调度器": (_bz_sched.schedulers(), {"default": "beta"}),
                "降噪强度": ("FLOAT", {
                    "default": 1.0, "min": 0.0, "max": 1.0, "step": 0.01,
                    "tooltip": "1.0 = 从纯噪声开始生成；小于 1 = 图生图式重绘。",
                }),
            }
        }

    RETURN_TYPES = ("LATENT",)
    RETURN_NAMES = ("潜空间",)
    FUNCTION = "sample"
    CATEGORY = "👨‍🏫班长/MiniMax H3"

    def sample(self, 模型, 正面条件, 潜空间, 随机种子, 步数,
               CFG, 采样器, 调度器, 降噪强度):
        # 条件未升级 → 与一采同条件，跳过这趟采样，潜空间原样输出。
        if not _hd_upgraded(潜空间):
            print("[SelfLift 采样器] 条件未升级（与一采逐字相同）—— 跳过本次采样，"
                  "潜空间原样输出")
            return (潜空间,)
        latent = dict(潜空间)
        latent_image = latent["samples"]
        if not getattr(latent_image, "is_nested", False):
            raise ValueError(
                "🎯 H3 放大采样器：需要 MiniMax H3 的嵌套 latent（视频+音频），"
                "请接 CSGlide 的「潜空间」输出")
        shapes = [tuple(t.shape) for t in latent_image.unbind()]

        ms = 模型.get_model_object("model_sampling")
        total_steps = int(步数)
        if float(降噪强度) < 1.0:
            total_steps = int(total_steps / max(float(降噪强度), 1e-4))
        sigmas = comfy.samplers.calculate_sigmas(ms, _bz_sched.resolve(调度器), total_steps).cpu()
        sigmas = sigmas[-(int(步数) + 1):]
        log.info("[班长SelfLift·采样器] 降噪强度 %.2f → 起点 sigma %.4f（步数 %d，调度器 %s）",
                 float(降噪强度), float(sigmas[0]), int(步数), 调度器)

        guider = comfy.samplers.CFGGuider(模型)
        guider.set_conds(正面条件, [])
        guider.set_cfg(float(CFG))
        noise = comfy.sample.prepare_noise(latent_image, int(随机种子))

        x0_output = {}
        callback = latent_preview.prepare_callback(
            guider.model_patcher, sigmas.shape[-1] - 1, x0_output)
        sampler = comfy.samplers.sampler_object(采样器)

        # 与官方 sample() 同款：NestedTensor 转扁平包再进采样器
        flat_image, packed_shapes = comfy.utils.pack_latents(latent_image.unbind())
        flat_noise, _ = comfy.utils.pack_latents(noise.unbind())
        if len(packed_shapes) > 1 and callback is not None:
            # 采样器在扁平包上跑，回调包装成嵌套视图（官方 1289~1295 行同款）
            packed_callback = callback
            def callback(step, x0, x, total_steps):
                x0 = comfy.nested_tensor.NestedTensor(
                    comfy.utils.unpack_latents(x0, packed_shapes))
                x = comfy.nested_tensor.NestedTensor(
                    comfy.utils.unpack_latents(x, packed_shapes))
                return packed_callback(step, x0, x, total_steps)

        # ---- 复刻 CFGGuider.sample() 的准备流程（conds/hooks/model_options），
        #      但直接调 outer_sample：官方 sample() 会在返回前用「输入网格」把结果
        #      重新打包，SelfLift 中途放大的 latent 会被按旧网格切开（花屏根源）。
        #      outer_sample 没有那一步，真实输出网格记录在 guider._banzhang_out_shapes。
        guider.conds = {}
        for k in guider.original_conds:
            guider.conds[k] = list(map(lambda a: a.copy(), guider.original_conds[k]))
        comfy.samplers.preprocess_conds_hooks(guider.conds)

        orig_model_options = guider.model_options
        guider.model_options = comfy.model_patcher.create_model_options_clone(guider.model_options)
        orig_hook_mode = guider.model_patcher.hook_mode
        if comfy.samplers.get_total_hook_groups_in_conds(guider.conds) <= 1:
            guider.model_patcher.hook_mode = comfy.hooks.EnumHookMode.MinVram
        comfy.sampler_helpers.prepare_model_patcher(
            guider.model_patcher, guider.conds, guider.model_options)
        comfy.samplers.filter_registered_hooks_on_conds(guider.conds, guider.model_options)
        try:
            out = guider.outer_sample(flat_noise, flat_image, sampler, sigmas,
                                      callback=callback, disable_pbar=False,
                                      seed=int(随机种子), latent_shapes=packed_shapes)
        finally:
            comfy.samplers.cast_to_load_options(
                guider.model_options, device=guider.model_patcher.offload_device)
            guider.model_options = orig_model_options
            guider.model_patcher.hook_mode = orig_hook_mode
            guider.model_patcher.restore_hook_patches()

        # SelfLift 放大后会把真实网格写到 guider 上；没接 SelfLift 时就是原网格
        out_shapes = getattr(guider, "_banzhang_out_shapes", None) or shapes
        tensors = comfy.utils.unpack_latents(out, out_shapes)
        device = comfy.model_management.intermediate_device()
        latent["samples"] = comfy.nested_tensor.NestedTensor(
            [t.to(device) for t in tensors])
        if out_shapes != shapes:
            log.info("[班长SelfLift·采样器] 输出 latent 已放大：%s → %s（格子数）",
                     "×".join(str(s) for s in shapes[0][2:]),
                     "×".join(str(s) for s in out_shapes[0][2:]))
        return (latent,)


# 傻瓜档位：选一档就替你把下面几个参数配好。
# 顺序按"越往下越省、也越慢"排列，新人从上往下试即可。
# 每项 = (前馈分块, 分块触发长度, 注意力头分组)
# 只保留「无损」路线：官方 global 系包装要把 H3 块级补丁换成它自己认得的那套，
# 而「🧠 H3 SLA 注意力加速」用的也是块级补丁，两者协议不兼容（会直接报错）。
# 注意力交给 SLA，前馈交给本节点，各管一层，互不冲突。
_MEM_PRESET_OFF = "① 关（最快，不省显存）"
_MEM_PRESET_CUSTOM = "④ 自定义（用下面的参数）"
_MEM_PRESETS = {
    _MEM_PRESET_OFF:                 (1, 4096, 1),
    "② 轻度（省一点，画面完全不变）": (2, 4096, 4),
    "③ 强力（省得多，画面基本不变）": (4, 4096, 8),
    _MEM_PRESET_CUSTOM:              None,
}


def _resolve_mem_preset(档位, 前馈分块, 分块触发长度, 注意力头分组):
    """档位 → (前馈分块, 分块触发长度, 注意力头分组)。选自定义时用下面几项的实际值。"""
    preset = _MEM_PRESETS.get(档位)
    if preset is not None:
        return preset
    if 档位 != _MEM_PRESET_CUSTOM:
        # 老工作流档位名变了 / 控件位置错位 → 退回「关」，不阻断出图。
        log.warning(
            "💾 H3 显存优化：「省显存档位」收到无法识别的值 %r（多为老工作流的控件"
            "位置错位），本次已按「%s」处理。请重新加载一次工作流以永久修正。",
            档位, _MEM_PRESET_OFF)
        return _MEM_PRESETS[_MEM_PRESET_OFF]
    return (_coerce_int(前馈分块, 1, "前馈分块"),
            _coerce_int(分块触发长度, 4096, "分块触发长度"),
            _coerce_int(注意力头分组, 1, "注意力头分组"))



class BanZhang_H3MemoryOptimizer:
    """H3 显存优化补丁（MODEL → MODEL）。

    只做「无损」那一层：前馈分块 + 注意力头分组，只改计算顺序、不改数学，
    画面与不挂补丁逐位等价。移植自 ComfyUI-KJNodes 的 MiniMax H3 Chunk
    FeedForward 与 Low VRAM Attention。

    不接管注意力：H3 的稀疏注意力交给「🧠 H3 SLA 注意力加速」。
    官方 global 系包装要求块级补丁是它自己那套，与 SLA 的块级补丁协议不兼容，
    同挂会直接报错，所以这里不提供。
    """

    DESCRIPTION = (
        "选一个档位即可，爆显存往下挪一档。只省前馈层，与 SLA 加速不冲突。"
    )


    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "模型": ("MODEL", {
                    "tooltip": "接 MiniMax H3 的 MODEL 线（串在采样器前面即可）。\n"
                               "本节点只给模型挂补丁，不改权重，所以可以放在 MODEL 链路上的任意位置。",
                }),
                "省显存档位": (list(_MEM_PRESETS.keys()), {
                    "default": _MEM_PRESET_OFF,
                    "tooltip": (
                        "从上往下：越往下越省显存，也越慢。不知道选什么就从②开始试。\n"
                        "· ① 关：什么都不做，最快 —— 显存够用就用它。\n"
                        "· ② 轻度：画面逐位不变，开始爆显存时选它。\n"
                        "· ③ 强力：前馈切得更细、注意力头分得更细；②还爆显存时用。\n"
                        "· ④ 自定义：按下面那几项填，给要细调的人用。\n"
                        "选 ①②③ 时，下面几项由本档位决定，不用管。"
                    ),
                }),
            },
            "optional": {
                "前馈分块": ("INT", {
                    "default": 1,
                    "min": 1,
                    "max": 64,
                    "step": 1,
                    "tooltip": "把 SwiGLU 前馈沿打包 token 维切成几段算，降低峰值显存。\n"
                               "画面结果与不分块完全一致（逐行独立，实测等价）。\n"
                               "· 1（默认）：关闭，最快，但不省显存\n"
                               "· 2~4：显存吃紧时加，段数越多越省显存、开销略增\n"
                               "配合下面的「分块触发长度」使用。",
                }),
                "分块触发长度": ("INT", {
                    "default": 4096,
                    "min": 256,
                    "max": 262144,
                    "step": 256,
                    "tooltip": "打包 token 数超过这个数才真的分块，短序列分块只会白白增加开销。\n"
                               "只有「前馈分块」大于 1 时这条才生效，一般保持默认不用动。",
                }),
                "注意力头分组": ("INT", {
                    "default": 1,
                    "min": 1,
                    "max": 56,
                    "step": 1,
                    "tooltip": "把一次注意力调用拆成几个头组分别算，并提前释放 qkv 缓冲，降低峰值显存。\n"
                               "头之间互相独立，画面结果与不分组完全一致。\n"
                               "· 1（默认）：关闭\n"
                               "· 4：显存吃紧时的推荐值\n"
                               "· 8：小显存（8G 级）可以再往上试；超过模型头数会自动收敛\n"
                               "如果别的方法（sage 等）已经占了注意力补丁，本节点会保留它的 forward，"
                               "只叠加显存释放部分。",
                }),
            },
        }

    RETURN_TYPES = ("MODEL",)
    FUNCTION = "apply"
    CATEGORY = "👨‍🏫班长/MiniMax H3"

    def apply(self, 模型, 省显存档位=_MEM_PRESET_OFF,
              前馈分块=None, 分块触发长度=None, 注意力头分组=None):
        from .selflift import h3_mem

        前馈分块, 分块触发长度, 注意力头分组 = _resolve_mem_preset(
            省显存档位, 前馈分块, 分块触发长度, 注意力头分组)
        return (h3_mem.apply(模型.clone(), 前馈分块, 分块触发长度, 注意力头分组),)


# ============================================================
# 节点注册
# ============================================================
NODE_CLASS_MAPPINGS = {
    "BanZhang_SelfLiftProgressive": BanZhang_SelfLiftProgressive,
    "BanZhang_SelfLiftUpscale": BanZhang_SelfLiftUpscale,
    "BanZhang_SelfLiftMultiStage": BanZhang_SelfLiftMultiStage,
    "BanZhang_SelfLiftSampler": BanZhang_SelfLiftSampler,
    "BanZhang_H3MemoryOptimizer": BanZhang_H3MemoryOptimizer,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "BanZhang_SelfLiftProgressive": "🎯 SelfLift 渐进提升",
    "BanZhang_SelfLiftUpscale": "🎯 SelfLift 放大重绘（二合一）",
    "BanZhang_SelfLiftMultiStage": "🎯 SelfLift 多级渐进",
    "BanZhang_SelfLiftSampler": "🎯 H3 放大采样器",
    "BanZhang_H3MemoryOptimizer": "💾 H3 显存优化",
}
