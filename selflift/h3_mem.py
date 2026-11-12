"""MiniMax H3 显存优化补丁：前馈分块 + 低显存注意力。

移植自 ComfyUI-KJNodes 的 MiniMaxChunkFeedForward / MiniMaxLowVRAMAttention
（nodes/minimax_nodes.py）。两者都只改变计算顺序与释放时机，不改数学，
输出与不打补丁的模型等价：

· 前馈分块（SwiGLU 分块）
    packed 序列的每一行互相独立，int8 激活量化也是逐行做的，所以把两层线性
    沿 token 维切成 n 段分别算，结果与整段算完全一致，峰值显存更低。

· 低显存注意力
    ① qkv GEMM 之后立刻释放 norm 后的 h 和融合的 qkv 缓冲，让 out_proj
       分配时它们已经不在显存里；
    ② 可选按"头分组"把注意力拆成多次调用，核函数内部的临时张量（int8 的
       q/k 拷贝、fp32 累加器）随分组数下降；头之间互相独立，结果不变。

头分组会让每一层注意力被 optimized_attention 调用 n 次（n = 分组数），
这一点对任何按"调用次数"记账的上层补丁都成立，需要它们自行折算。
"""

import logging
import types

import torch

import comfy.model_management as mm
import comfy.ops
import comfy.quant_ops
from comfy.ldm.modules.attention import optimized_attention
from comfy.ldm.minimax.model import _mod_scale_shift, _mod_gate

log = logging.getLogger("BanzhangSelfLift")


def _make_mlp_chunked_forward(num_chunks, seq_threshold):
    """生成分块版 SwiGLU 前馈的 forward（绑定到 block.mlp 上）。"""

    def chunked_mlp_forward(self, x):
        # 短序列分块只会白白增加开销，所以只有超过阈值才切
        if x.shape[0] > seq_threshold and num_chunks > 1:
            out = torch.empty_like(x)
            offset = 0
            for c in torch.chunk(x, num_chunks, dim=0):
                out[offset:offset + c.shape[0]] = comfy.ops.linear_input_act(
                    self.fc2, self.fc1(c), "swiglu")
                offset += c.shape[0]
            return out
        return comfy.ops.linear_input_act(self.fc2, self.fc1(x), "swiglu")

    return chunked_mlp_forward


def _attn_lowmem_forward(self, x, rope_freqs=None, transformer_options={}):
    """低显存版 Attention.forward。

    原版会把 norm 后的 h 和 (S, 3*inner) 的 qkv 缓冲一直留到 out_proj 分配之后；
    这里在 qkv GEMM 之后立刻释放两者。头分组由 transformer_options 里的
    minimax_head_chunks 控制，未设置时与一次全量调用等价。
    """
    if isinstance(x, list):
        x = x.pop()
    s = x.shape[0]
    device = x.device
    dtype = x.dtype
    qkv = self.qkv_proj(x)
    del x
    q, k, v = qkv.split(self.heads * self.head_dim, dim=-1)
    v = v.view(s, self.heads, self.head_dim)
    if rope_freqs is not None:
        q = q.view(1, s, self.heads, self.head_dim)
        k = k.view(1, s, self.heads, self.head_dim)
        qw = mm.cast_to(self.q_norm.weight, device=device)
        kw = mm.cast_to(self.k_norm.weight, device=device)
        rot = rope_freqs.shape[-3] * 2
        if mm.in_training:
            q, k = comfy.quant_ops.ck.rms_rope_split_half(
                q, k, rope_freqs, qw, kw, epsilon=self.q_norm.eps, rot_dim=rot)
        else:
            comfy.quant_ops.ck.rms_rope_split_half_(
                q, k, rope_freqs, qw, kw, epsilon=self.q_norm.eps, rot_dim=rot)
        q = q[0]
        k = k[0]
    else:
        q = self.q_norm(q.view(s, self.heads, self.head_dim))
        k = self.k_norm(k.view(s, self.heads, self.head_dim))
    q = q.transpose(0, 1).unsqueeze(0)
    k = k.transpose(0, 1).unsqueeze(0)
    v = v.transpose(0, 1).unsqueeze(0)
    n = min(transformer_options.get("minimax_head_chunks", 1), self.heads) if isinstance(transformer_options, dict) else 1
    if n <= 1:
        out = optimized_attention(q, k, v, self.heads, mask=None, skip_reshape=True,
                                  transformer_options=transformer_options).squeeze(0)
    else:
        # 头之间互相独立，所以按组算与整体算结果一致；核函数内部临时量随每组头数下降
        out = torch.empty((s, self.heads * self.head_dim), dtype=dtype, device=device)
        hs = 0
        for size in ([self.heads // n + (1 if i < self.heads % n else 0) for i in range(n)]):
            he = hs + size
            o = optimized_attention(q[:, hs:he], k[:, hs:he], v[:, hs:he], size, mask=None,
                                    skip_reshape=True, transformer_options=transformer_options)
            out[:, hs * self.head_dim:he * self.head_dim] = o.squeeze(0)
            hs = he
    del q, k, v, qkv
    return self.out_proj(out)


# 告诉其它注意力补丁：本 forward 内部已经走 optimized_attention，
# 所以基于 optimized_attention_override 的补丁照常生效，无需再包一层
_attn_lowmem_forward._uses_optimized_attention = True


def _block_lowmem_forward(self, x, t_emb, mod_segments, rope_freqs, transformer_options={}, attention=None):
    """DiTBlock.forward，唯一区别：把 h 装在 list 里交给注意力，好让它用完立刻释放。"""
    shift_msa, scale_msa, gate_msa, shift_mlp, scale_mlp, gate_mlp = self.adaln_proj(t_emb)
    h = _mod_scale_shift(self.norm1(x), shift_msa, scale_msa, mod_segments)
    if attention is None:
        attention = self.attn
        h = [h]
    x = _mod_gate(x, gate_msa, attention(h, rope_freqs=rope_freqs, transformer_options=transformer_options), mod_segments)
    h = _mod_scale_shift(self.norm2(x), shift_mlp, scale_mlp, mod_segments)
    return _mod_gate(x, gate_mlp, self.mlp(h), mod_segments)


def _blocks_of(patcher):
    """取 diffusion_model.blocks；取不到返回 None（说明不是 H3 结构）。"""
    try:
        blocks = getattr(patcher.get_model_object("diffusion_model"), "blocks", None)
    except Exception:
        return None
    return blocks if blocks else None


def apply(patcher, ff_chunks=1, ff_seq_threshold=4096, head_chunks=1):
    """在同一个 ModelPatcher 上叠加显存补丁，返回同一个 patcher。"""
    blocks = _blocks_of(patcher)
    if blocks is None:
        log.warning("[班长·H3显存] 模型结构不像 MiniMax H3（取不到 diffusion_model.blocks），已跳过显存补丁")
        return patcher

    # ---- 前馈分块 ----
    if ff_chunks > 1:
        if hasattr(blocks[0], "mlp") and hasattr(blocks[0].mlp, "fc1"):
            fwd = _make_mlp_chunked_forward(ff_chunks, ff_seq_threshold)
            for idx, block in enumerate(blocks):
                patcher.add_object_patch(f"diffusion_model.blocks.{idx}.mlp.forward",
                                         types.MethodType(fwd, block.mlp))
        else:
            log.warning("[班长·H3显存] 找不到 blocks[*].mlp.fc1/fc2，前馈分块已跳过")

    # ---- 低显存注意力 ----
    if head_chunks > 1:
        if not (hasattr(blocks[0], "attn") and hasattr(blocks[0].attn, "qkv_proj")):
            log.warning("[班长·H3显存] 找不到 blocks[*].attn.qkv_proj，低显存注意力已跳过")
            return patcher

        try:
            total_heads = int(blocks[0].attn.heads)
        except Exception:
            total_heads = 56
        group_count = max(1, min(int(head_chunks), total_heads))

        opts = patcher.model_options.setdefault("transformer_options", {})
        # 注意力 forward 每次调用都会读这个键，所以串联顺序不影响分组生效
        opts["minimax_head_chunks"] = group_count
        # 让 Sol-Attn 之类的组合逻辑走这条低显存路径
        opts["sol_take_forward"] = _attn_lowmem_forward

        composed = False
        for idx, block in enumerate(blocks):
            patcher.add_object_patch(f"diffusion_model.blocks.{idx}.forward",
                                     types.MethodType(_block_lowmem_forward, block))
            attn_key = f"diffusion_model.blocks.{idx}.attn.forward"
            existing = patcher.object_patches.get(attn_key)
            if existing is not None and getattr(existing, "__func__", None) is not _attn_lowmem_forward:
                # 别的注意力补丁（sage / mem eff 等）已经占了这个键：保留它，
                # 只补 block 层的 h 释放
                composed = True
                continue
            patcher.add_object_patch(attn_key, types.MethodType(_attn_lowmem_forward, block.attn))

        if composed:
            log.info("[班长·H3显存] 检测到已存在的注意力补丁，保留其 forward，只叠加 block 层显存释放")

    return patcher
