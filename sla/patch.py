"""Wire the block-sparse kernel into MiniMax-H3 attention, at inference time.

The hook is ``transformer_options["optimized_attention_override"]``, read by
``wrap_attn`` in ``comfy/ldm/modules/attention.py``. H3 reaches it from its one
attention call site, ``comfy/ldm/minimax/model.py:172``.

The legacy ``set_model_attn1_patch`` hook does *not* work here: it is the
SD-UNet cross-attention path, and H3 is a DiT that never consults it. A patch
installed that way reports success and silently does nothing -- which is the
failure this whole module exists to avoid, hence the invocation counter below.

Layout at the call site: q/k/v arrive ``[1, 56, S, 128]`` bf16 with
``skip_reshape=True``, ``mask=None``, RoPE already applied. H3 does not pass
``skip_output_reshape``, so we owe it ``[1, S, 7168]`` back.
"""

from __future__ import annotations

import logging
import time
from statistics import NormalDist

import torch

import comfy.model_management
from comfy.model_management import InterruptProcessingException

# 自带 Triton 内核是最后一档兜底：只有官方 comfy-kitchen 内核不可用时才走到这里。
# 必须可选导入 —— Windows 上装 triton 要 pytorch-triton-windows 且版本严格对齐
# torch，绝大多数用户不会装；而顶层无条件导入会让缺 triton 的机器把整个 SLA 包
# 一起 import 失败，连"不需要 triton 的官方内核"也一起废掉（节点 except 兜底后
# 静默变成全程不加速，用户只看到一条 ModuleNotFoundError 堆栈）。
# comfy-kitchen 是 ComfyUI 官方 requirements 依赖，自带编译好的 CUDA 内核
# （backends/cuda/_C.abi3.pyd），它的 triton 后端是可选分支 —— 所以
# "没有 triton" ≠ "不能加速"。
try:
    from .block_map import get_block_map
    from .kernel import block_sparse_attention
    _TRITON_OK = True
except ImportError as _exc:  # noqa: BLE001
    if str(getattr(_exc, "name", None) or "").split(".")[0] != "triton":
        raise            # 不是"没装 triton"，是本包自己的错，不能吞
    get_block_map = block_sparse_attention = None
    _TRITON_OK = False

# MiniMax-H3 走官方那条路所必需的零件。拿不到就整体退回"注意力覆盖"老路，
# 节点行为不变，只是慢一些。
try:
    from comfy.ldm.minimax.model import MiniMaxH3Model
    import comfy.model_prefetch
    import comfy.patcher_extension
    _H3_BLOCK_OK = True
except Exception:  # noqa: BLE001 - 老版本 ComfyUI 没有这些，不致命
    MiniMaxH3Model = None
    _H3_BLOCK_OK = False

# 官方 ComfyUI 的稀疏内核（comfy-kitchen）。可用时优先用它：同一稀疏度下
# 快约一倍，且注意力本身是 int8 量化噪声而非"整块丢掉"。装不上/显卡不支持
# 时自动回退到自带的 Triton 内核，节点行为不变。
try:
    import comfy_kitchen as ck
except Exception:  # noqa: BLE001 - 没装这个包不是错误，走 Triton 即可
    ck = None

log = logging.getLogger("H3Utils")

_H3_HEAD_DIM = 128
_OK_DTYPES = (torch.bfloat16, torch.float16)

# PackedLayout segments that carry sound. Only these get pinned for audio
# protection -- never the whole [text | cond | ref | audio] prefix, which on a
# long clip can be ~half the sequence and would collapse the sparsity.
_AUDIO_KINDS = ("cond_audio", "ref_audio", "audio")

# sol-attn 每个 query 块额外保留的高分 token 数，官方默认 256（更贴近稠密，
# 代价约 20% 速度；设 0 最快但离原画面更远）。
_SOL_TOKEN_AUG = 256


def engine_status():
    """本机实际能用哪一档加速 —— 给用户看的一句话，不出堆栈。

    三档从快到慢：官方块级替换 → 官方注意力覆盖 → 自带 Triton。
    前两档用 comfy-kitchen 的编译内核，**不需要 triton**；只有两者都不可用
    （老 ComfyUI 没装 comfy_kitchen，或显卡算力低于 sm_80）才轮到 Triton。
    """
    if ck is None:
        return ("没有 comfy_kitchen（ComfyUI 版本偏旧）"
                + ("，改用自带 Triton 内核" if _TRITON_OK
                   else "，也没有 triton —— 这次无法加速"))
    try:
        ok = ck.sol_attn_is_available(torch.device("cuda"))
    except Exception:  # noqa: BLE001 - 探测失败按不可用处理，不影响出图
        ok = False
    if ok:
        return "官方内核可用（不需要 triton）"
    return ("官方内核不支持这张显卡（需 sm_80 以上）"
            + ("，改用自带 Triton 内核" if _TRITON_OK
               else "，也没有 triton —— 这次无法加速"))


# 共享轨迹（时间分块同步去噪）期间多个窗口的稀疏预算必须一致。
# 自适应 tau 是「每个 query 块按自己的分数分布」定阈值，窗口切法不同 ->
# 选中的 key 块不同 -> 同一帧在两窗口得到两份近似，5 帧过渡带摊不平就是接缝跳。
# comfy_kitchen 的 topk_ratio > 0 会覆盖 tau 改成固定 top-k（SLA 选择），
# 各窗口保留同样比例的块，预算一致；不改工作流、不换内核、不需要 triton。
_SLA_SHARED_WINDOW = False
_SOL_TOPK_OK = None


def set_shared_window(on):
    global _SLA_SHARED_WINDOW
    _SLA_SHARED_WINDOW = bool(on)


def _sol_topk_arg(topk_ratio):
    """共享轨迹期间返回固定 top-k 比例；其余时候 0 = 维持原来的自适应 tau。"""
    global _SOL_TOPK_OK
    if not _SLA_SHARED_WINDOW:
        return 0.0
    if _SOL_TOPK_OK is None:
        # 旧版 comfy_kitchen 没有这个参数，传进去会 TypeError 退回 dense。
        try:
            import inspect
            _SOL_TOPK_OK = "topk_ratio" in inspect.signature(ck.sol_attn).parameters
        except Exception:
            _SOL_TOPK_OK = False
    return float(topk_ratio) if _SOL_TOPK_OK else 0.0


def _tau_for(sparsity):
    """「省多少计算」→ sol-attn 的阈值 tau。

    sol-attn 的阈值是"质心分数超过 tau 个标准差"，所以保留比例就是正态
    分布的右尾 1-Φ(tau)：tau 1.0 留约 16%、1.5 约 7%、2.0 约 2.3%，与官方
    tooltip 一致。这里直接用它的反函数，节点上写"省 85%"，内核就真的只
    精算约 15%（对角线邻块和音频块还会在上面额外保留一点）。
    """
    keep = min(max(1.0 - float(sparsity), 0.003), 0.997)
    return NormalDist().inv_cdf(1.0 - keep)   # 负值是合法的：阈值低于均值，保留更多


def _block_span(blocks):
    """块索引列表 → 连续区间 [start, end)，给 sol-attn 当 sink 用。"""
    return [min(blocks), max(blocks) + 1] if blocks else [0, 0]


# 物理安全下限：低于这个 token 数的注意力（通常是"文本精炼器"，S 只有几百）
# 走稀疏反而不划算。这是一个固定常量，不是会随显卡漂移的测量值——原版的
# "自动标定"用随机噪声测速 + "快 2 倍"门槛 + 失败即写死缓存，三个偏高源
# 叠加后把门槛系统性抬高到 2048，还不可复现。详见文件头设计说明。
_MIN_SEQ_LEN = 1024


def _is_audio_kind(kind) -> bool:
    """该段是否携带声音。

    优先精确匹配当前 H3 的三种音频段；再放宽到"含 audio 子串"兜底，
    以抗 ComfyUI 核心将来重命名段类型时的静默失配。子串匹配只是最后
    一道安全网，正常路径都走前面的精确命中。
    """
    if kind in _AUDIO_KINDS:
        return True
    return "audio" in str(kind).lower()

# 哪些"没加速"的原因算异常（内核真出问题），其余都是主动放弃，属正常
_FAIL_REASONS = ("内核报错", "显存紧张")


def _new_state():
    return {
        "calls": 0,        # sparse invocations this run
        "dense": 0,        # fall-throughs this run
        "dense_short": 0,  # 判定"不划算"而没加速（正常，不是故障）
        "dense_fail": 0,   # 内核出错 / 显存不够才退回（这个才是问题）
        "why": {},         # 各种"没加速"原因分别出现了多少次
        "why_len": {},     # 每种原因碰到时的画面长度范围
        "trace": [],       # 每一步的加速/完整计数，用来定位"哪一步没加速"
        "mem_note": None,  # 第一次判定显存紧张时的具体数字
        "pooled": {},      # 分片内核跨步复用的量化统计
        "mode": "覆盖",     # 本次实际走的路：块级替换 / 覆盖
        "step": 0,
        "seq": 0,
        "kept": 0,
        "blocks": 0,
        "backend": None,   # what we displaced
        "engine": None,    # which sparse kernel actually ran
        "eff_first": 0,    # dense head steps actually applied this run
        "eff_last": 0,     # dense tail steps actually applied this run
        "failed": None,    # first kernel failure, if any
        "protect_audio": True,  # whether 音频保护 is switched on this node
        "has_audio": False,     # whether this clip's layout carries any sound rows
        # 真实提速测量（按采样步计时，稀疏步 vs 稠密步）
        "run_start": 0.0,
        "total_time": 0.0,
        "sparse_time": 0.0,
        "dense_time": 0.0,
        "sparse_steps": 0,
        "dense_steps": 0,
        # 音频保护构成：目标音频（被去噪的主体）与参考音频分开统计
        "pinned_target": 0,
        "pinned_ref": 0,
    }


def _fmt_why(state):
    """把"没加速的原因"按次数排序列成一句话。"""
    if not state.get("why"):
        return "无 —— 本次每一处都在加速"
    items = sorted(state["why"].items(), key=lambda kv: -kv[1])
    parts = []
    for why, n in items:
        lo, hi = state.get("why_len", {}).get(why, (0, 0))
        rng = f"（画面长度 {lo}~{hi}）" if hi else ""
        parts.append(f"{why} {n} 次{rng}")
    return "；".join(parts)


def _fmt_trace(trace):
    """把逐步明细压成一行：连续相同的步合并显示。"""
    out, i, n = [], 0, len(trace)
    while i < n:
        j = i
        while (j + 1 < n
               and trace[j + 1]["dense"] == trace[i]["dense"]
               and trace[j + 1]["sparse"] == trace[i]["sparse"]
               and trace[j + 1]["full"] == trace[i]["full"]):
            j += 1
        a, b = trace[i], trace[j]
        rng = (f"第{a['step']}步" if a["step"] == b["step"]
               else f"第{a['step']}-{b['step']}步")
        tag = ("完整算" if a["dense"]
               else f"加速 {a['sparse']}/{a['sparse'] + a['full']}")
        why = "、".join(f"{k}×{v}" for k, v in sorted(
            a.get("why", {}).items(), key=lambda kv: -kv[1]))
        out.append(f"{rng} {tag}" + (f"（{why}）" if why else ""))
        i = j + 1
    return "\n               ".join(out)


def _summarise(state, sparsity, blkq, blkk, min_seq_len,
               dense_first_steps, dense_last_steps):
    """One line per sampling run. Never one per block -- there are 50 of those."""
    L = "─" * 22
    if state["calls"] == 0:
        text = "\n".join([
            "🧠 H3 SLA 运行日志（本次全程不加速）",
            L,
            "运行状态   : 全程没加速 —— 一次都没触发",
            f"自动不加速 : {state['dense_short']} 次 / 异常退回 {state['dense_fail']} 次",
            f"没加速原因 : {_fmt_why(state)}",
        ])
        if state.get("mem_note"):
            text += f"\n显存情况   : {state['mem_note']}"
        if state["failed"] is not None:
            text += f"\n内核异常   : {state['failed']}"
        log.warning(
            "[班长SLA] 补丁已装但一次都没生效，这次是全程不加速跑完的。\n%s\n"
            "检查：进采样器的模型是不是本节点返回的那个（多半有根线没接上）。",
            text,
        )
        return
    state["total_time"] = time.time() - (state["run_start"] or time.time())
    lines = [
        "🧠 H3 SLA 运行日志（本次完整生成）",
        L,
        f"运行状态   : 已加速（{state['calls']} 次）",
        f"画面长度   : {state['seq']}（文字+声音+画面打包在一起的总长度）",
        f"加速方式   : {state.get('mode')}（块级替换 = 不构建完整 QKV，最省显存）",
        f"加速引擎   : {state.get('engine') or '未知'}",
    ]
    if state["blocks"]:
        real = 1.0 - state["kept"] / state["blocks"]
        lines += [
            f"块大小     : {blkq}×{blkk}",
            f"加速设定   : 省 {sparsity * 100:.0f}%（只重点算 {100 - sparsity * 100:.0f}%）",
            f"实际效果   : 每步只算 {state['kept']}/{state['blocks']} 块，"
            f"省了 {real * 100:.1f}%",
        ]
    else:
        lines += [
            f"加速设定   : 省 {sparsity * 100:.0f}%（已换算成内核阈值）",
            "实际效果   : 自动判断哪里重要（该内核不报告具体算了多少块）",
        ]
    # 音频保护状态：目标音频始终全保，参考音频受「音频保护上限」约束
    if state.get("protect_audio"):
        if state.get("has_audio"):
            lines.append(
                f"保护音频块 : 目标 {state['pinned_target']} + 参考 "
                f"{state['pinned_ref']} = "
                f"{state['pinned_target'] + state['pinned_ref']} 块")
        else:
            lines.append("音频保护   : 本条没识别出声音段，未固定任何块")
            log.warning(
                "[班长SLA] 「保住声音」开着，但这次没拿到声音段的信息，"
                "声音没有额外保护。如果是带声音的片子，检查一下模型是否上报了"
                "分段布局（换回官方 H3 模型通常会恢复）。")
    else:
        lines.append("音频保护   : 已关闭（最快，声音可能退化）")
    lines += [
        f"自动不加速 : {state['dense_short']} 次（太短 / 声音占比太高 / 精修步，正常）",
        f"异常退回   : {state['dense_fail']} 次（0 = 内核一次没崩）",
        f"没加速原因 : {_fmt_why(state)}",
    ]
    if state.get("trace"):
        lines.append(f"逐步明细   : {_fmt_trace(state['trace'])}")
    if state.get("mem_note"):
        lines.append(f"显存情况   : {state['mem_note']}")
    lines += [
        f"完整计算的步 : 开头 {state['eff_first']} 步 + 末尾 {state['eff_last']} 步"
        + ("" if (state["eff_first"] == dense_first_steps
                  and state["eff_last"] == dense_last_steps)
           else f"　（你设的是 {dense_first_steps}+{dense_last_steps}，"
                f"这次总共才 {state['n_steps']} 步，已自动让路）"),
        f"替换引擎   : {state['backend'] or '?'}",
        f"内核异常   : {'无' if state['failed'] is None else state['failed']}",
        L,
    ]
    # 真实提速：只有同时跑过稀疏步和稠密步才有可比对的耗时
    if state["sparse_steps"] and state["dense_steps"]:
        sa = state["sparse_time"] / state["sparse_steps"]
        da = state["dense_time"] / state["dense_steps"]
        gain = (da - sa) / da * 100 if da > 0 else 0.0
        lines.append(
            f"真实提速   : 加速步均 {sa:.3f}s / 完整步均 {da:.3f}s"
            f" → 每步省 {gain:.1f}%")
    else:
        lines.append(
            "真实提速   : 未对比 —— 把「最后几步精修」设为 ≥1，"
            "本日志会给出加速步与完整步的耗时对比")
    lines += [
        f"本次总耗时 : {state['total_time']:.1f} 秒",
        L,
        "提示       : 第一步会比后面几步慢一点（内核要先统计数据的量化尺度），正常现象。",
    ]
    log.info("\n%s", "\n".join(lines))
    if state["failed"] is not None:
        log.warning("[班长SLA] 内核至少崩过一次，那一步退回不加速：%s",
                    state["failed"])


def _make_override(state, sparsity_ratio, blkq, blkk, min_seq_len,
                   protect_audio=True, protect_cap=0):
    topk_ratio = 1.0 - sparsity_ratio

    def override(func, q, k, v, heads, mask=None, attn_precision=None,
                 skip_reshape=False, skip_output_reshape=False, **kwargs):
        # 用于诊断：记下这次调用时的画面长度，好知道"是哪一类长度没加速"
        s_now = q.shape[2] if q.ndim >= 3 else 0

        def dense(why):
            """按具体原因记一笔，再走原来的完整计算。"""
            state["dense"] += 1
            state["why"][why] = state["why"].get(why, 0) + 1
            lo, hi = state["why_len"].get(why, (s_now, s_now))
            state["why_len"][why] = (min(lo, s_now), max(hi, s_now))
            if why in _FAIL_REASONS:
                state["dense_fail"] += 1
            else:
                state["dense_short"] += 1
            return func(q, k, v, heads, mask=mask, attn_precision=attn_precision,
                        skip_reshape=skip_reshape,
                        skip_output_reshape=skip_output_reshape, **kwargs)

        if state["backend"] is None:
            state["backend"] = getattr(func, "__name__", repr(func))

        to = kwargs.get("transformer_options") or {}

        # 下面每个分支都单独记一个原因，后台日志会列出各原因的次数，
        # 这样"这次为什么没加速"能一眼看出来，不用猜。
        if to.get("_h3sla_dense", False):
            return dense("开头或末尾精修步（你设的）")

        # 不是 H3 打包好的自注意力（形状/带 mask/没跳过 reshape）就原样放行。
        if not skip_reshape or mask is not None or q.ndim != 4:
            return dense("不是H3打包注意力")

        if q.shape[-1] != _H3_HEAD_DIM or q.dtype not in _OK_DTYPES:
            return dense("数据格式不支持")

        if topk_ratio >= 1.0:
            return dense("省0%（等于没开加速）")

        # min_seq_len keeps the 2-block token refiner (S = text length, a few
        # hundred) and lower-resolution runs on dense attention, where block
        # sparsity would cost more than it saves.
        if s_now < min_seq_len:
            return dense("画面太短（加速不划算）")

        try:
            B, H, S, D = q.shape

            # [1, H, S, D] -> [1, S, H, D]. H3 builds q/k/v as [S, H, D] and
            # transposes for the call, so this transposes back onto the original
            # memory: contiguous already, and the copy is a no-op. A BHSD kernel
            # would instead cost a real ~1.3 GB copy per tensor at 768p/15s.
            qb, kb, vb = (t.transpose(1, 2) for t in (q, k, v))
            if not qb.is_contiguous():
                qb, kb, vb = qb.contiguous(), kb.contiguous(), vb.contiguous()

            # 目标音频（被去噪的输出主体）始终完整保护；「音频保护上限」
            # 只约束参考音频（cond_audio / ref_audio）的截取长度，从尾部取
            # 以优先保住离目标最近的参考。上限再小也绝不会砍到目标音频的开头。
            protect_blocks = None
            targets = []
            n_target = n_ref = 0
            if protect_audio:
                targets = to.get("_h3sla_target_audio_blocks") or []
                refs = to.get("_h3sla_ref_audio_blocks") or []
                cap = int(protect_cap)
                blocks = list(targets)
                n_target = len(targets)
                if cap > 0 and refs:
                    max_blocks = (cap + blkk - 1) // blkk
                    picked = refs[-max_blocks:]
                    blocks += picked
                    n_ref = len(picked)
                if blocks:
                    protect_blocks = blocks
            state["pinned_target"] = n_target
            state["pinned_ref"] = n_ref

            # 必须完整算的块（音频保护 + 内核自带的额外 token）如果占掉太多，
            # 稀疏就省不出东西、还要倒贴打分和量化的开销，不如直接完整算。
            # 2.5 是实测出来的：强制块占到四成时还有 2.6 倍收益，再往上就不划算了。
            forced = len(protect_blocks or ()) + (_SOL_TOKEN_AUG + blkk - 1) // blkk
            if (S + blkk - 1) // blkk < forced * 2.5:
                return dense("声音保护占比太高（省不出时间）")

            # 显存前置检查：连输出 buffer 都放不下（含池化/回退余量）时，
            # 直接回退稠密，避免「先分配池化张量 → 稀疏 OOM → 回退稠密仍 OOM」的连环爆。
            #
            # 注意 torch.cuda.mem_get_info() 报告的"空闲"不含 PyTorch 缓存分配器
            # 手里那批"已预留但当前空闲"的显存——那部分不用问驱动就能直接复用。
            # 不加回来的话，缓存占得多就会被误判成显存不够，几百次误判还会连带
            # 触发几百次 empty_cache()，反而把整次生成拖慢好几倍。
            out_bytes = S * H * D * q.element_size()
            need = int(out_bytes * 1.5 + (1 << 27))
            try:
                _free, _total = torch.cuda.mem_get_info()
                _cached = max(0, torch.cuda.memory_reserved()
                              - torch.cuda.memory_allocated())
            except Exception:  # noqa: BLE001 - 非 CUDA 或无此接口时跳过检查
                _free, _cached = None, 0
            if _free is not None and (_free + _cached) < need:
                if state["mem_note"] is None:
                    state["mem_note"] = (
                        f"可用 {(_free + _cached) / 2 ** 30:.2f}G"
                        f"（驱动空闲 {_free / 2 ** 30:.2f}G + 缓存空闲 "
                        f"{_cached / 2 ** 30:.2f}G），本次需要约 {need / 2 ** 30:.2f}G")
                return dense("显存紧张")

            if ck is not None and ck.sol_attn_is_available(qb.device):
                # 官方内核：自适应阈值挑块，音频块走 sink（每个 query 都精确计算）
                tau = _tau_for(sparsity_ratio)
                fixed = _sol_topk_arg(topk_ratio)
                out = ck.sol_attn(
                    qb, kb, vb,
                    tau=tau,
                    topk_ratio=fixed,
                    scale=D ** -0.5,
                    sink_blocks=_block_span(protect_blocks),
                    sink_q=_block_span(targets),
                    token_aug=_SOL_TOKEN_AUG,
                ).to(qb.dtype)
                state["engine"] = (
                    f"官方 sol-attn（固定 top-k {fixed * 100:.1f}%，共享轨迹预算一致）"
                    if fixed > 0 else f"官方 sol-attn（tau {tau:.2f}，自适应阈值）")
            else:
                # 回退：自带 Triton 内核，固定比例 top-k。
                # 连 triton 都没有时只能完整算 —— 这里必须显式判空，否则每一次
                # 注意力调用都会 TypeError，日志刷满"内核报错"却看不出真因。
                if block_sparse_attention is None:
                    return dense("没装 triton，且官方内核不可用")
                lut, topk, n_pinned = get_block_map(qb, kb, topk_ratio, blkq, blkk,
                                                    protect_blocks=protect_blocks)
                out = block_sparse_attention(qb, kb, vb, lut, topk, blkq, blkk)
                state["kept"] = topk
                state["blocks"] = (S + blkk - 1) // blkk
                state["engine"] = (
                    f"自带 Triton 内核（每步保留 {topk}/{state['blocks']} 块）")

            state["calls"] += 1
            state["seq"] = S

            # [1, S, H, D] -> what the caller expects
            if skip_output_reshape:
                return out.transpose(1, 2)
            return out.reshape(B, S, H * D)

        except Exception as exc:  # noqa: BLE001 - a bad kernel must not kill the run
            if state["failed"] is None:
                state["failed"] = "%s: %s" % (exc.__class__.__name__, exc)
                log.debug("[H3Utils] SLA kernel failed", exc_info=True)
            # 释放稀疏路径的中间量并回收碎片，给回退的稠密注意力腾出显存。
            try:
                del lut
            except Exception:  # noqa: BLE001 - lut 可能尚未赋值
                pass
            try:
                torch.cuda.empty_cache()
            except Exception:  # noqa: BLE001
                pass
            return dense("内核报错")

    return override


def _emit_step_progress(state, n_steps):
    """每走完一个采样步，往控制台打一行进度 + SLA 状态。

    目的是让用户知道"还在动"：H3 在 8GB 卡上一步可能 30~60 秒，控制台若
    长时间没有新输出，用户会误以为卡死。这里每步刷一行，附带本步是完整算
    还是加速算、以及累计的加速/完整次数。
    """
    step = state["step"]
    # 只认让路后的真值：wrapper 才决定本步完整算还是加速算，读用户原始设置
    # 会在让路时把进度行打成"完整算"、实际却在加速。
    first, last = int(state["eff_first"]), int(state["eff_last"])
    is_dense = (first > 0 and step <= first) or (last > 0 and step > n_steps - last)
    tag = "完整算" if is_dense else "加速算"
    try:
        bar = "█" * max(0, step) + "░" * max(0, n_steps - step)
        log.info("[班长SLA] 进度 %d/%d [%s] 第%d步·%s｜累计加速 %d 次 / 完整 %d 次",
                 step, n_steps, bar, step, tag, state["calls"], state["dense"])
    except Exception:  # noqa: BLE001 - 进度行打不出来不影响出图
        log.info("[班长SLA] 进度 %d/%d 第%d步·%s｜累计加速 %d 次 / 完整 %d 次",
                 step, n_steps, step, tag, state["calls"], state["dense"])


def _make_wrapper(state, sparsity_ratio, blkq, blkk, min_seq_len,
                  dense_first_steps, dense_last_steps):
    """DIFFUSION_MODEL wrapper: per-step state, and the end-of-run summary.

    Registered once and then reused -- ComfyUI caches node outputs, so this
    closure outlives a single sampling run. The step counter therefore has to
    reset itself, or every run after the first drifts permanently into the
    trailing-dense window and silently stops sparsifying.
    """

    def wrapper(executor, x, timestep, context, transformer_options={},
                minimax_payload=None, **kwargs):
        to = transformer_options
        n_steps = max(1, len(to.get("sample_sigmas", [])) - 1)

        # 新的一次生成：清掉上次的统计。除了"步数跑满"之外，步数变化也算新
        # 一次——一采/二采/三采的步数常常不同，若沿用上次的计数，步号会一直
        # 停在末尾精修区间里，导致整次都不加速（这正是"同个工作流有时全程
        # 不加速"的根因之一）。
        prev_n = state.get("n_steps", 0)
        if state["step"] >= n_steps or (prev_n and prev_n != n_steps):
            state["step"] = 0
            state["calls"] = 0
            state["dense"] = 0
            state["dense_short"] = 0
            state["dense_fail"] = 0
            state["why"] = {}
            state["why_len"] = {}
            state["trace"] = []
            state["mem_note"] = None
            state["pooled"] = {}
            state["failed"] = None
            state["seq"] = 0
            state["kept"] = 0
            state["blocks"] = 0
            state["pinned_target"] = 0
            state["pinned_ref"] = 0
            state["sparse_time"] = 0.0
            state["dense_time"] = 0.0
            state["sparse_steps"] = 0
            state["dense_steps"] = 0
            state["run_start"] = time.time()
        elif state["run_start"] == 0.0:   # 首次运行
            state["run_start"] = time.time()
        state["step"] += 1

        # 把携带声音的段分成两组：目标音频（被去噪的主体，始终全保）与
        # 参考音频（cond_audio / ref_audio，受「音频保护上限」约束）。
        # 判定不靠 kind 字符串：H3 的打包布局固定"目标音频在最前、紧跟视频"
        # （model.py: target audio then target video, always the last two
        # segments），所以按行号排序后最后一段音频就是目标音频 —— 即使核心
        # 将来改了段类型名，这个"最后一段"判定也依然成立。
        target_blocks = []
        ref_blocks = []
        audio_segs = []
        layout = minimax_payload.get("layout") if minimax_payload else None
        for seg in getattr(layout, "segments", ()) or ():
            if len(seg) != 3:
                continue
            if not _is_audio_kind(seg[2]):
                continue
            a, b = int(seg[0]), int(seg[1])
            if b > a:
                audio_segs.append((a, b))
        audio_segs.sort()
        for i, (a, b) in enumerate(audio_segs):
            blocks = range(a // blkk, (b + blkk - 1) // blkk)
            if i == len(audio_segs) - 1:
                target_blocks.extend(blocks)
            else:
                ref_blocks.extend(blocks)
        to["_h3sla_target_audio_blocks"] = sorted(set(target_blocks))
        to["_h3sla_ref_audio_blocks"] = sorted(set(ref_blocks))
        state["has_audio"] = bool(audio_segs)

        # 开头几步决定整体构图，官方默认也让前 20% 的步保持完整计算。
        # 但二采/三采常常只有 1~2 步：开头末尾各占一步就把加速吃光了，
        # 所以自动让路，保证至少留 1 步真的在加速（2 步采样可留 1 步完整算）。
        first, last = int(dense_first_steps), int(dense_last_steps)
        while first + last > n_steps - 1 and (first or last):
            if first >= last:
                first -= 1
            else:
                last -= 1
        state["eff_first"], state["eff_last"] = first, last
        state["n_steps"] = n_steps

        to["_h3sla_dense"] = bool(
            (first > 0 and state["step"] <= first)
            or (last > 0 and state["step"] > n_steps - last)
        )

        # Forward minimax_payload only when H3 actually supplied one. Nothing
        # stops a user wiring this node to a non-H3 model, and every other
        # diffusion model would raise TypeError on the unexpected kwarg -- a
        # crash mid-sampling rather than the graceful no-op they should get.
        if minimax_payload is not None:
            kwargs["minimax_payload"] = minimax_payload

        step_t0 = time.time()
        snap = (state["calls"], state["dense"], dict(state["why"]))
        try:
            out = executor.original(x, timestep, context,
                                    transformer_options=transformer_options,
                                    **kwargs)
        except InterruptProcessingException:
            log.info("[班长SLA] 已中断：完成 %d/%d 步，用时 %.1f 秒",
                     state["step"], n_steps,
                     time.time() - (state["run_start"] or time.time()))
            raise
        finally:
            # 无论正常/异常都记下这一步的耗时，供"真实提速"对比用。
            elapsed = time.time() - step_t0
            if to.get("_h3sla_dense", False):
                state["dense_time"] += elapsed
                state["dense_steps"] += 1
            else:
                state["sparse_time"] += elapsed
                state["sparse_steps"] += 1
            # 逐步明细：这一步加速了多少次、完整算了多少次
            got_sparse = state["calls"] - snap[0]
            got_dense = state["dense"] - snap[1]
            if got_sparse or got_dense:
                now_why = state["why"]
                delta = {k: v - snap[2].get(k, 0)
                         for k, v in now_why.items()
                         if v - snap[2].get(k, 0) > 0}
                state["trace"].append({
                    "step": state["step"], "n": n_steps,
                    "dense": bool(to.get("_h3sla_dense", False)),
                    "sparse": got_sparse, "full": got_dense,
                    "why": delta,
                })

        if state["step"] >= n_steps:
            _summarise(state, sparsity_ratio, blkq, blkk, min_seq_len,
                       dense_first_steps, dense_last_steps)
        else:
            _emit_step_progress(state, n_steps)
        return out

    return wrapper


# ── MiniMax-H3 专用：官方同款「块级替换 + 分片 QKV 生成器」 ────────────────
#
# 这才是官方节点真正快的原因。两条路的差别不在内核（都用 ck.sol_attn 系列），
# 而在"喂给内核的数据是怎么来的"：
#
#   老路（注意力覆盖）：H3 先把完整的 q/k/v 都算出来（47135×56×128 的 bf16，
#   三个张量约 2 GB），我们再拿去做稀疏。这 2 GB 的分配和显存占用是省不掉的
#   固定成本 —— 瓦片一大就会顶到显存上限，于是触发保护逻辑退回完整计算，
#   这正解释了"同样的参数，有时全加速、有时一次都不加速"。
#
#   新路（块级替换）：在 H3 的每个 transformer 块里把注意力换成生成器，每
#   4096 个 token 现算一小片 qkv 直接喂内核，完整 QKV 从头到尾不存在。省掉
#   的既是算力也是那 2 GB 显存，速度和稳定性一起改善。
_PRODUCER_CHUNK = 4096


def _h3_sinks(transformer_options, tokens, mode, blkk):
    """官方同款的 sink 计算：视频之前的所有打包行（文字/条件/参考/声音）整体
    当精确 KV，可选再让目标声音的 query 行也走精确。

    mode: 0=关 1=只保 KV 2=KV + 声音行（官方默认）
    """
    if mode == 0:
        return (0, 0), (0, 0)
    layout = transformer_options.get("minimax_h3_layout")
    if layout is None or getattr(layout, "seq_len", tokens) != tokens:
        return (0, 0), (0, 0)
    video = audio = None
    for seg in getattr(layout, "segments", ()) or ():
        if len(seg) != 3:
            continue
        if seg[2] == "video" and video is None:
            video = (int(seg[0]), int(seg[1]))
        elif seg[2] == "audio" and audio is None:
            audio = (int(seg[0]), int(seg[1]))
    if video is None or video[0] <= 0:
        return (0, 0), (0, 0)
    blocks = (0, (video[0] + blkk - 1) // blkk)
    if mode != 2:
        return blocks, (0, 0)
    if audio is None:
        return blocks, blocks
    return blocks, (audio[0] // blkk, blocks[1])


def _h3_producer_attention(attn, x, rope_freqs, transformer_options, state,
                           block_index, tau, topk_ratio, token_aug, sink_mode,
                           blkk):
    """H3 注意力 → 分片 QKV + sol_attn_chunked。完整 QKV 始终不落地。"""
    n_tokens = x.shape[0]
    heads, head_dim = attn.heads, attn.head_dim
    qw = comfy.model_management.cast_to(attn.q_norm.weight, device=x.device)
    kw = comfy.model_management.cast_to(attn.k_norm.weight, device=x.device)

    sink, sink_q = _h3_sinks(transformer_options, n_tokens, sink_mode, blkk)

    # 空间分块（H3 终极放大）会把整幅切成瓦片，此时 x.shape[0] 比 layout.seq_len
    # 小，_h3_sinks 会静默放弃 sink（音频保护失效）。这里把它显式记下来，
    # 免得"带声音的片子声音没保护住"变成一桩无头案。
    if sink_mode and sink == (0, 0):
        layout = transformer_options.get("minimax_h3_layout")
        want = getattr(layout, "seq_len", n_tokens) if layout is not None else n_tokens
        if want != n_tokens:
            state["why"]["空间分块致音频保护失效"] = \
                state["why"].get("空间分块致音频保护失效", 0) + 1

    # 每一步的量化统计（kmean/vscale）可以下一步接着用，省掉重新统计的时间。
    # 注意 key 里带上了 uuids：一次生成可能有多个条件分支（多段 prompt / 多参考），
    # 每个分支必须各自维护一份统计，否则会互相污染、画质出现难以察觉的退化。
    # 这也和官方「statistics per conditioning branch」的注释一致。
    with comfy.model_prefetch.pause_malloc_graph():
        key = (block_index, n_tokens, tuple(transformer_options.get("uuids", ())))
        pooled = state["pooled"].get(key)
        first = pooled is None
        if first:
            pooled = (
                torch.empty((heads, head_dim), dtype=torch.float32, device=x.device),
                torch.empty((heads, head_dim), dtype=torch.float32, device=x.device),
            )

        def chunks():
            for i in range(0, n_tokens, _PRODUCER_CHUNK):
                yield attn.qkv_proj(x[i:i + _PRODUCER_CHUNK])

        # 共享标志由放大节点在 guider.sample 之前才置位，而 patch_h3_sla 早在
        # SLA 节点执行时就跑完了 —— 门控必须留到每次注意力调用时再求值，
        # 否则固化成 0，固定 top-k 又变成「打印了但没生效」。
        out, kmean, vscale = ck.sol_attn_chunked(
            chunks, n_tokens, heads, rope_freqs, (qw, kw),
            kmean=None if first else pooled[0],
            vscale=None if first else pooled[1],
            tau=tau, topk_ratio=_sol_topk_arg(topk_ratio), token_aug=token_aug,
            sink_blocks=list(sink), sink_q=list(sink_q),
            rope_eps=attn.q_norm.eps,
        )
    pooled[0].copy_(kmean)
    pooled[1].copy_(vscale)
    state["pooled"][key] = pooled

    out = out.view(n_tokens, heads * head_dim)
    return attn.out_proj(out)


def _make_h3_block_patch(block, block_index, state, tau, topk_ratio, token_aug,
                         sink_mode, min_seq_len, blkk):
    """把 H3 某个 transformer 块的注意力换成上面的生成器。"""

    def attention(h, rope_freqs=None, transformer_options={}):
        return _h3_producer_attention(
            block.attn, h, rope_freqs, transformer_options, state, block_index,
            tau, topk_ratio, token_aug, sink_mode, blkk)

    def block_patch(args, extra):
        to = args.get("transformer_options") or {}
        x = args.get("img")
        attn = block.attn
        n = 0 if x is None else int(x.shape[0])

        def dense(why):
            state["dense"] += 1
            state["why"][why] = state["why"].get(why, 0) + 1
            lo, hi = state["why_len"].get(why, (n, n))
            state["why_len"][why] = (min(lo, n), max(hi, n))
            if why in _FAIL_REASONS:
                state["dense_fail"] += 1
            else:
                state["dense_short"] += 1
            if n:                       # 让日志的"画面长度"反映实际看到的长度
                state["seq"] = n
            return extra["original_block"](args)

        if ck is None:
            return dense("没装 comfy-kitchen")
        if x is None or x.device.type != "cuda" or x.dtype != torch.bfloat16:
            return dense("数据格式不支持")
        if attn.head_dim != _H3_HEAD_DIM:
            return dense("数据格式不支持")
        if not ck.sol_attn_is_available(x.device):
            return dense("显卡没有可用内核")
        if args.get("rope_freqs") is None:
            return dense("拿不到位置编码")
        if to.get("_h3sla_dense", False):
            return dense("开头或末尾精修步（你设的）")
        if int(x.shape[0]) < min_seq_len:
            return dense("画面太短（加速不划算）")

        args = {**args, "attention": attention}
        try:
            out = extra["original_block"](args)
            state["calls"] += 1
            state["seq"] = int(x.shape[0])
            _fixed = _sol_topk_arg(topk_ratio)
            state["engine"] = (
                f"官方分片内核（固定 top-k {_fixed * 100:.1f}%，共享轨迹预算一致）"
                if _fixed > 0 else
                f"官方分片内核（tau {tau:.2f}，不构建完整 QKV）")
            return out
        except Exception as exc:  # noqa: BLE001 - 内核出错不能中断出图
            if state["failed"] is None:
                state["failed"] = "%s: %s" % (exc.__class__.__name__, exc)
                log.debug("[H3Utils] SLA producer failed", exc_info=True)
            return dense("内核报错")

    return block_patch


def patch_h3_sla(model, sparsity_ratio=0.90, block_size=64, min_seq_len=0,
                 dense_first_steps=1, dense_last_steps=1, protect_audio=True,
                 protect_cap=0):
    """Return a clone of ``model`` whose H3 self-attention runs block-sparse.

    Weights are untouched; this only installs an attention override and a
    per-step wrapper on the clone. Run reports go to the console log only.
    """
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    # 安全下限是物理常量，不做自动标定。min_seq_len 参数保留仅为兼容旧调用
    # 签名（banzhang_sla_attention 里固定传 0），一律落回 _MIN_SEQ_LEN。
    min_seq_len = _MIN_SEQ_LEN

    blkq = int(block_size)
    # BLKK=64 is not a typo. On sm_120 the 128x128 tile needs 160 KB of shared
    # memory against a ~99 KB limit and cannot launch at all; 128x64 both fits
    # and measured fastest. LightX2V picks the same split for its sage2 path on
    # non-sm90 architectures.
    blkk = 64 if blkq == 128 else blkq

    state = _new_state()
    state["protect_audio"] = bool(protect_audio)

    patched = model.clone()

    # 走官方那条路：在 H3 的每个 transformer 块里换注意力，QKV 分片现算，
    # 完整 QKV 不落地。非 H3 模型（或拿不到官方零件时）自动退回注意力覆盖。
    tau = _tau_for(sparsity_ratio)
    # 「保住声音」= 官方的 exact_kv_and_rows：视频之前的整段打包行（文字/条件/
    # 参考/声音）都精确算，目标声音的 query 行也走精确。约 3% 的额外代价。
    sink_mode = 2 if protect_audio else 0
    n_blocks = 0
    if float(sparsity_ratio) <= 0.0:
        pass                      # 省 0% = 关掉加速，两条路都不装
    elif ck is not None and _H3_BLOCK_OK and hasattr(ck, "sol_attn_chunked"):
        try:
            dm = patched.get_model_object("diffusion_model")
            if isinstance(dm, MiniMaxH3Model):
                for i, block in enumerate(dm.blocks):
                    patched.set_model_patch_replace(
                        _make_h3_block_patch(block, i, state, tau, 1.0 - sparsity_ratio,
                                             _SOL_TOKEN_AUG, sink_mode,
                                             int(min_seq_len), blkk),
                        "dit", "double_block", i)
                    n_blocks += 1
        except Exception as exc:  # noqa: BLE001 - 装不上就退回覆盖路
            n_blocks = 0
            log.info("[班长SLA] 块级替换没装上（%s），退回注意力覆盖路", exc)
    if n_blocks:
        state["mode"] = "块级替换"
        # 跑完一次采样清掉跨步复用的量化统计，避免下次生成沿用脏数据。
        # （块级替换用的是 set_model_patch_replace，不会被后挂节点的
        #  optimized_attention_override 顶掉，所以不需要官方那种每步重挂。）
        try:
            patched.add_callback_with_key(
                comfy.patcher_extension.CallbacksMP.ON_CLEANUP,
                "h3_sla_state", lambda model_patcher: state.update(pooled={}))
        except Exception:  # noqa: BLE001
            pass

    # 注意力覆盖：给非 H3 的注意力调用兜底，同时也是块级替换不可用时的主路
    to = patched.model_options.get("transformer_options", {}).copy()
    to["optimized_attention_override"] = _make_override(
        state, float(sparsity_ratio), blkq, blkk, int(min_seq_len),
        bool(protect_audio), int(protect_cap))
    patched.model_options["transformer_options"] = to

    patched.add_wrapper_with_key(
        "diffusion_model", "h3_sla_state",
        _make_wrapper(state, float(sparsity_ratio), blkq, blkk,
                      int(min_seq_len), int(dense_first_steps),
                      int(dense_last_steps)),
    )

    # 日志必须写清"实际挂了哪个引擎"：两条覆盖路的日志长得一模一样，
    # 用户就看不出自己在跑快的那档还是慢的那档（更看不出压根没加速）。
    if float(sparsity_ratio) <= 0.0:
        engine_name = "省 0% —— 按你的设置不加速"
    elif n_blocks:
        engine_name = f"官方分片内核（{n_blocks} 个块，不构建完整 QKV）"
    elif ck is not None:
        engine_name = "官方注意力覆盖（完整 QKV 后再稀疏）"
    elif _TRITON_OK:
        engine_name = "自带 Triton 覆盖（较慢，建议升级 ComfyUI 用官方内核）"
    else:
        engine_name = "无可用内核 —— 本次全程不加速（只影响速度，不影响出图）"

    log.info(
        "[班长SLA] 已挂上加速：%s | 省 %.0f%%（tau %.2f） | 短于 %d 不加速 | "
        "开头 %d 步 + 末尾 %d 步完整算 | 保护声音 %s | 本机档位：%s",
        engine_name,
        sparsity_ratio * 100, tau, min_seq_len,
        dense_first_steps, dense_last_steps, "开" if protect_audio else "关",
        engine_status(),
    )
    return patched
