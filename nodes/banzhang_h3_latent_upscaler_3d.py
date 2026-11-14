"""
Minimax H3 Latent Upscaler - ComfyUI inference node (pure 3D conv version)
- [终极融合] 引入时间分块(Temporal Chunking)与 Replicate Padding，解决长视频 OOM 与末尾闪烁
- [底层黑科技] 显式 .contiguous() 消除隐式显存拷贝尖峰
- [底层黑科技] Zero-Copy 零拷贝加载模型，防止系统内存(RAM)峰值爆满
- [底层黑科技] 接入 ComfyUI 原生 soft_empty_cache，彻底清理显存碎片
- [终极整合] 推理结束后将模型踢回CPU，释放显存给后续节点(可选开关)
- [终极整合] 强制长宽双向对齐到32的倍数，彻底解决底部光带(Light Banding)问题
- [终极整合] 放弃 In-place 原地操作，保障 FP16/FP32 下的数值精度与画质
- [新增] 完美支持 ROCm (AMD GPU) 加速
- [新增] 支持子文件夹模型管理 (PR #30)
- [新增] 强制卸载模型开关 (force_unload)
- 3 resize modes: scale by multiplier / target dimensions / megapixels
- Auto-detects model architecture (channels, blocks, temporal layout)
"""
import torch
import torch.nn as nn
import torch.nn.functional as F
import os
import glob
import gc
import logging
import math
import time
import folder_paths
import re
from collections import OrderedDict
from einops import rearrange
from enum import Enum
from typing import TypedDict

try:
    import comfy.model_management as mm
    HAS_COMFY_MM = True
except ImportError:
    HAS_COMFY_MM = False

try:
    from comfy.nested_tensor import NestedTensor
except ImportError:
    NestedTensor = None

try:
    from comfy_api.latest import ComfyExtension, io
    from typing_extensions import override
    USE_NEW_API = True
except ImportError:
    USE_NEW_API = False
    class io:
        class ComfyNode: pass
        class Schema: pass
        class NodeOutput: pass
        class AnyType:
            @staticmethod
            def Input(*args, **kwargs): return args[0] if args else "ANY"
            @staticmethod
            def Output(*args, **kwargs): return args[0] if args else "ANY"
        class Combo:
            @staticmethod
            def Input(*args, **kwargs): return args[0] if args else "COMBO"
        class Float:
            @staticmethod
            def Input(*args, **kwargs): return "FLOAT"
        class Int:
            @staticmethod
            def Input(*args, **kwargs): return "INT"
        class Boolean:
            @staticmethod
            def Input(*args, **kwargs): return "BOOLEAN"
        class DynamicCombo:
            @staticmethod
            def Input(*args, **kwargs): return args[0] if args else "DYNAMIC"
            class Option: pass
    class ComfyExtension: pass
    def override(func): return func

# ==========================================
# Register model folder
# ==========================================
_LATENT_UPSCALE_FOLDER = "latent_upscale_models"
if _LATENT_UPSCALE_FOLDER not in folder_paths.folder_names_and_paths:
    folder_paths.add_model_folder_path(
        _LATENT_UPSCALE_FOLDER,
        os.path.join(folder_paths.models_dir, _LATENT_UPSCALE_FOLDER)
    )

VAE_DOWNSAMPLE = 16

# ==========================================
# Minimax H3 latent normalization stats (24 channels)
# ==========================================
LATENTS_MEAN = [
    0.858090341091156, -0.9606591463088989, 1.0661640167236328, -0.5090325474739075,
    -0.2727581858634949, -1.3675414323806763, -0.2553254961967468, -0.26907554268836975,
    -0.5376840829849243, -0.0464097298681736, 0.6657370328903198, 0.19690127670764923,
    -0.5460608005523682, -0.4035342037677765, -0.23683024942874908, 0.25928452610969543,
    -0.30133944749832153, 0.211341992020607, -1.1206848621368408, 0.3581933379173279,
    -0.04225143790245056, 0.2604829967021942, 0.22864092886447906, 0.7056031823158264
]
LATENTS_STD = [
    1.2223774194717407, 1.2767263650894165, 1.6831774711608887, 1.7549455165863037,
    1.5636216402053833, 2.194143533706665, 0.9653137922286987, 1.0569885969161987,
    0.841948926448822, 0.7729952931404114, 1.8955937623977661, 0.946841835975647,
    0.7996809482574463, 0.44988900423049927, 0.7197399735450745, 0.6936293244361877,
    2.961095094680786, 2.7694199085235596, 3.0496184825897217, 2.1088054180145264,
    3.276226282119751, 3.1627357006073, 2.2816812992095947, 2.6127843856811523
]

def _make_norm_tensors(device, dtype):
    mean = torch.tensor(LATENTS_MEAN, dtype=dtype, device=device).view(1, -1, 1, 1, 1)
    std = torch.tensor(LATENTS_STD, dtype=dtype, device=device).view(1, -1, 1, 1, 1)
    return mean, std

# ==========================================
# 智能时间分块决策
#   - H3 规格（24fps，17k+5 像素帧网格，VAE 每 17 像素帧 → 5 latent token）：
#       15 秒 ≈ 362 像素帧 ≈ latent T=107（这是官方训练上限，见下）
#   - 以 60 秒为基准分段：视频 ≤60 秒且显存装得下 → 整段推理（上下文最完整）；
#     更长视频按显存在 60s/40s/30s/20s/15s/10s/5s/2.5s/1s 档位里选最长片长，
#     显存极小退到 8 帧
#   - 与空间分块天然联动：本决策发生在每条空间切条之后，看到的已是"条"的实际面积
#   - ⚠ 训练上限提示：H3 官方训练区间是 124~362 像素帧（≈5~15 秒），超过 15 秒
#     属于外推（长视频要靠多段续写，或配 LongLive 类长视频 LoRA）。本闸门放宽到
#     60 秒只是"允许整段跑"，不等于模型在该长度上仍属训练分布；若长素材画面漂移，
#     把 _TEMPORAL_CANDIDATES[0] 调回 107（≈15 秒）即可让长素材自动分片。
# ==========================================
_TEMPORAL_CANDIDATES = (420, 280, 210, 136, 102, 68, 34, 17, 8)
#                      ≈60s / 40s / 30s / 20s / 15s / 10s / 5s / 2.5s / 1s（latent 帧）
_TEMPORAL_LABELS = {420: "60 秒", 280: "40 秒", 210: "30 秒", 136: "20 秒", 102: "15 秒",
                    68: "10 秒", 34: "5 秒", 17: "2.5 秒", 8: "1 秒"}

# 时间分块融合带的目标宽度（单侧，latent 帧）。为什么不是原来的 5（= 时间卷积核宽）：
#   本放大模型在时间方向是纯卷积（注意力被强制关闭，见 _detect_arch 里 cfg["attn"]=False），
#   每个输出帧只依赖 ±RF 帧的输入、没有全局时间上下文。于是"分块结果 == 整段结果"的
#   充要条件是【融合带 ≥ 感受野半径 RF】，而 RF 由 _temporal_radius 从模块图算出 ≈75 帧。
#   原来只用 5 帧：片边缘 75 帧内的输出都被零填充/复制边界污染，羽化区只盖住 5 帧，
#   剩下 70 帧硬接缝 —— 这正是中段出现"缓慢蠕动形变"的根因。
#   为什么取 16：与空间分块的 _SPATIAL_OVERLAP 同值——那是同一套 3D 卷积（空间/时间核宽
#   一样），空间侧已被验证"16 格足以盖住感受野边界效应"，时间侧没有理由取别的量级。
#   为什么不取满 75：上下文帧数是 4×融合带，取 75 会让单片成本 ×4、显存 ×3，把时间分块
#   省下的显存全吃回去（分块就失去意义）。16 帧 ≈2.3 秒，配升余弦窗足以压掉可见接缝。
_BLEND_FRAMES = 16


def _smart_temporal_chunk(dev, in_h, in_w, out_h, out_w, t, feat_channels,
                          act_factor=12, margin_bytes=512 * 1024 * 1024):
    """返回时间片长（latent 帧）；调用方用 `T <= chunk` 判断是否整段推理。"""
    if dev.type != "cuda" or not torch.cuda.is_available():
        return _TEMPORAL_CANDIDATES[0]  # CPU 路线：按 60 秒基准分段

    try:
        if HAS_COMFY_MM:
            mm.soft_empty_cache()
        else:
            torch.cuda.empty_cache()
    except Exception:
        pass
    try:
        free_bytes, _ = torch.cuda.mem_get_info(dev)
    except Exception:
        free_bytes = torch.cuda.get_device_properties(dev).total_memory * 0.5

    budget = free_bytes - margin_bytes
    in_area, out_area = in_h * in_w, out_h * out_w
    # 每帧激活：插值边界两侧（输入分辨率 + 输出分辨率）的特征图同时存活
    bytes_per_frame = (in_area + out_area) * feat_channels * act_factor * 2  # ×2 = fp16

    # 1) 整段优先：视频不超过 60 秒基准且显存装得下 → 绝不切时间
    est_full = t * bytes_per_frame
    if t <= _TEMPORAL_CANDIDATES[0] and est_full <= budget:
        print(f"[H3 Latent放大] 智能时间分块: 空闲显存={free_bytes / 2**30:.1f}GB | "
              f"{t} 帧整段估算≈{est_full / 2**30:.1f}GB 可装下 → 整段推理（不切时间）")
        return t

    # 2) 超过 60 秒基准或整段装不下：按显存选最长的合格片长
    for cand in _TEMPORAL_CANDIDATES:
        if cand <= t and cand * bytes_per_frame <= budget:
            print(f"[H3 Latent放大] 智能时间分块: 空闲显存={free_bytes / 2**30:.1f}GB | "
                  f"整段估算≈{est_full / 2**30:.1f}GB 超出预算 → 每片 {cand} 帧"
                  f"（≈{_TEMPORAL_LABELS[cand]}，每片≈{cand * bytes_per_frame / 2**30:.1f}GB）")
            return cand

    print(f"[H3 Latent放大] 智能时间分块: 显存极度紧张（空闲{free_bytes / 2**30:.1f}GB）"
          f"→ 每片 8 帧尽力执行")
    return 8

# ==========================================
# ROCm / Device Helper Functions
# ==========================================
def _is_rocm_build():
    return getattr(torch.version, "hip", None) is not None

def _resolve_device(backend):
    if backend == "cpu":
        return torch.device("cpu")
    if backend == "rocm":
        if not _is_rocm_build():
            raise RuntimeError("选择了 rocm 设备，但当前 PyTorch 构建不含 HIP/ROCm 支持。")
        if not torch.cuda.is_available():
            raise RuntimeError("选择了 rocm 设备，但 PyTorch 无法访问 AMD 显卡。")
        return torch.device("cuda")
    if backend == "cuda":
        return torch.device("cuda" if torch.cuda.is_available() else "cpu")
    raise ValueError(f"不支持的运算设备: {backend}")

def _backend_label(device):
    if device.type == "cuda" and _is_rocm_build():
        return f"ROCm/HIP {torch.version.hip}"
    if device.type == "cuda":
        return f"CUDA {getattr(torch.version, 'cuda', None) or 'unknown'}"
    return "CPU"

# 精度标识 → torch dtype
_PRECISION_DTYPES = {
    "fp32": torch.float32,
    "fp16": torch.float16,
    "bf16": torch.bfloat16,
}

# ==========================================
# 3D network components
# ==========================================
def normalization(channels):
    return nn.GroupNorm(32, channels)

def zero_module(module):
    for p in module.parameters():
        p.detach().zero_()
    return module

class AttnBlock3D(nn.Module):
    def __init__(self, in_channels):
        super().__init__()
        self.norm = normalization(in_channels)
        self.q = nn.Conv3d(in_channels, in_channels, 1)
        self.k = nn.Conv3d(in_channels, in_channels, 1)
        self.v = nn.Conv3d(in_channels, in_channels, 1)
        self.proj_out = nn.Conv3d(in_channels, in_channels, 1)

    def forward(self, x):
        h = self.norm(x)
        q = rearrange(self.q(h), "b c t h w -> b 1 (t h w) c")
        k = rearrange(self.k(h), "b c t h w -> b 1 (t h w) c")
        v = rearrange(self.v(h), "b c t h w -> b 1 (t h w) c")
        h = F.scaled_dot_product_attention(q, k, v)
        h = rearrange(h, "b 1 (t h w) c -> b c t h w", t=x.shape[2], h=x.shape[3], w=x.shape[4])
        return x + self.proj_out(h)

class ResBlockEmb3D(nn.Module):
    def __init__(self, channels, emb_channels, dropout=0, out_channels=None):
        super().__init__()
        self.out_channels = out_channels or channels
        self.in_layers = nn.Sequential(
            normalization(channels), nn.SiLU(),
            nn.Conv3d(channels, self.out_channels, 3, padding=1),
        )
        self.emb_layers = nn.Sequential(
            nn.SiLU(), nn.Linear(emb_channels, 2 * self.out_channels),
        )
        self.out_norm = normalization(self.out_channels)
        self.out_layers = nn.Sequential(
            nn.SiLU(), nn.Dropout(p=dropout),
            zero_module(nn.Conv3d(self.out_channels, self.out_channels, 3, padding=1)),
        )
        self.skip = (
            nn.Conv3d(channels, self.out_channels, 1)
            if self.out_channels != channels else nn.Identity()
        )

    def forward(self, x, emb):
        h = self.in_layers(x)
        emb_out = self.emb_layers(emb).type(h.dtype)
        while len(emb_out.shape) < len(h.shape):
            emb_out = emb_out[..., None]
        scale, shift = torch.chunk(emb_out, 2, dim=1)
        h = self.out_norm(h) * (1 + scale) + shift
        h = self.out_layers(h)
        return self.skip(x) + h

class TemporalConv(nn.Module):
    def __init__(self, channels, kernel_size=5):
        super().__init__()
        padding = kernel_size // 2
        self.norm = normalization(channels)
        self.dwconv = nn.Conv3d(channels, channels,
                                kernel_size=(kernel_size, 1, 1),
                                padding=(padding, 0, 0),
                                groups=channels)
        self.pwconv = nn.Conv3d(channels, channels, kernel_size=1)
        nn.init.zeros_(self.pwconv.weight)
        nn.init.zeros_(self.pwconv.bias)

    def forward(self, x):
        identity = x
        h = self.norm(x)
        h = F.silu(h)
        h = self.dwconv(h)
        h = self.pwconv(h)
        return identity + h

# ==========================================
# Pure-3D backbone with Temporal Chunking
# ==========================================
def _temporal_radius(module):
    """模块在时间方向上的感受野半径（帧）。

    纯卷积链路，无时间注意力，所以这个值是有限的，也正是"时间分块需要多少
    上下文帧"的答案：融合带 ≥ 它，分块结果才与整段推理一致。
    算法 = 所有 Conv3d 的 (kT - 1) // 2 之和，再加三线性时间插值的 1 帧。
    """
    r = 0
    for m in module.modules():
        if isinstance(m, nn.Conv3d):
            r += (m.kernel_size[0] - 1) // 2
    return r + 1


class LatentResizer3D(nn.Module):
    def __init__(self, in_channels=24, in_blocks=12, out_blocks=12,
                 channels=512, dropout=0.1, attn=False,
                 temporal_every=2, temporal_kernel=5):
        super().__init__()
        self.conv_in = nn.Conv3d(in_channels, channels, 3, padding=1)
        embed_dim = 64
        self.embed = nn.Sequential(
            nn.Linear(1, embed_dim), nn.SiLU(), nn.Linear(embed_dim, embed_dim))

        self.in_blocks = nn.ModuleList()
        for b in range(in_blocks):
            if (b == 1 or b == in_blocks - 1) and attn:
                self.in_blocks.append(AttnBlock3D(channels))
            self.in_blocks.append(ResBlockEmb3D(channels, embed_dim, dropout))
            if temporal_every > 0 and b % temporal_every == 0:
                self.in_blocks.append(TemporalConv(channels, temporal_kernel))

        self.out_blocks = nn.ModuleList()
        for b in range(out_blocks):
            if (b == 1 or b == out_blocks - 1) and attn:
                self.out_blocks.append(AttnBlock3D(channels))
            self.out_blocks.append(ResBlockEmb3D(channels, embed_dim, dropout))
            if temporal_every > 0 and b % temporal_every == 0:
                self.out_blocks.append(TemporalConv(channels, temporal_kernel))

        self.norm_out = normalization(channels)
        self.conv_out = nn.Conv3d(channels, in_channels, 3, padding=1)

        # 时间感受野半径：时间分块的融合带宽度由它决定（见 forward 里的 overlap 推导）
        self._rf_t = _temporal_radius(self)

    def forward(self, x, scale=None, target_size=None, enable_chunking=True):
        if target_size is not None:
            size = target_size
        elif scale is not None:
            size = tuple(int(round(s * scale)) for s in x.shape[-3:])
        else:
            return x

        if size == x.shape[-3:]:
            return x

        B, C, T, H, W = x.shape

        tk = 0
        for b in self.in_blocks:
            if isinstance(b, TemporalConv):
                tk = b.dwconv.weight.shape[2]
                break

        # 智能时间分块：按当前空闲显存动态选片长（整段/420/280/210/136/102/68/34/17/8）；关闭时整段推理。
        chunk = (_smart_temporal_chunk(
            x.device, H, W, size[-2], size[-1], T,
            feat_channels=self.conv_in.weight.shape[0])
            if enable_chunking else T)

        if not enable_chunking or T <= chunk:
            return self._forward_seg(x, scale, size)

        # 融合带宽度（单侧）：
        #   下限 tk —— 时间卷积核宽，低于它连卷积分辨的上下文都不够；
        #   目标 _BLEND_FRAMES；再受两个上限夹逼：
        #     · self._rf_t：感受野半径，超过它再多上下文也没用（纯卷积，无注意力）；
        #     · chunk // 4：上下文帧数是 4×融合带，夹住它保证片段总长 ≤2×片长，
        #       不至于把 _smart_temporal_chunk 按"片长"算出来的显存预算翻掉。
        overlap = max(tk, min(_BLEND_FRAMES, self._rf_t, max(1, chunk // 4)))

        print(f"[H3 Latent放大-3D] 时间分块推理: T={T} 分块数={(T + chunk - 1) // chunk} "
              f"融合带={overlap}（时间感受野半径={self._rf_t}）")

        x_padded = F.pad(x, (0, 0, 0, 0, overlap, overlap), mode='replicate')

        out_full = torch.zeros(B, C, T, size[-2], size[-1], device=x.device, dtype=x.dtype)
        weight_full = torch.zeros(1, 1, T, 1, 1, device=x.device, dtype=x.dtype)
        n_chunks = (T + chunk - 1) // chunk
        t_start = time.perf_counter()

        start = 0
        while start < T:
            seg_start = start
            seg_end = min(T, start + chunk)
            out_start = max(0, seg_start - overlap)
            out_end = min(T, seg_end + overlap)
            lo = max(0, out_start - overlap)
            hi = min(T + 2 * overlap, out_end + overlap)

            seg = x_padded[:, :, lo:hi].contiguous()
            seg_size = (hi - lo, size[-2], size[-1])
            seg_out = self._forward_seg(seg, scale, seg_size)

            s0 = (out_start + overlap) - lo
            s1 = s0 + (out_end - out_start)
            valid_out = seg_out[:, :, s0:s1]
            n_valid = out_end - out_start

            # 升余弦羽化窗（hanning）。原先是线性斜坡：斜坡在片边界处导数突变，
            # 两片的过渡带会留下一条"折痕"，观感就是缓慢蠕动。升余弦两端斜率为 0、
            # 中段更陡，接缝过渡自然；归一化后仍是互补权重，总和为 1。
            weight = torch.ones(n_valid, device=x.device, dtype=x.dtype)
            if seg_start > out_start:
                blend_len = seg_start - out_start
                u = torch.arange(1, blend_len + 1, device=x.device, dtype=torch.float32) / (blend_len + 1)
                weight[:blend_len] = (0.5 - 0.5 * torch.cos(math.pi * u)).to(x.dtype)
            if out_end > seg_end:
                blend_len = out_end - seg_end
                u = torch.arange(1, blend_len + 1, device=x.device, dtype=torch.float32) / (blend_len + 1)
                weight[-blend_len:] = (0.5 + 0.5 * torch.cos(math.pi * u)).to(x.dtype)

            out_full[:, :, out_start:out_end] += valid_out * weight.view(1, 1, n_valid, 1, 1)
            weight_full[:, :, out_start:out_end] += weight.view(1, 1, n_valid, 1, 1)

            start += chunk
            del seg, seg_out, valid_out
            print(f"[H3 Latent放大-3D] 时间分块: 片 {min(start, T) // chunk if start < T else n_chunks}/{n_chunks} 完成"
                  f"（累计 {time.perf_counter() - t_start:.1f}s）")
            if start % (chunk * 4) == 0:
                gc.collect()

        out_full = out_full / weight_full.clamp(min=1e-8)
        return out_full

    def _forward_seg(self, x, scale, size):
        scale_emb = torch.tensor(
            [scale - 1 if scale is not None else 0.0],
            dtype=x.dtype, device=x.device).unsqueeze(0)
        emb = self.embed(scale_emb)

        x = self.conv_in(x)
        for b in self.in_blocks:
            if isinstance(b, ResBlockEmb3D):
                emb_t = emb.expand(x.shape[0], -1)
                x = b(x, emb_t)
            else:
                x = b(x)

        x = F.interpolate(x, size=size, mode="trilinear", align_corners=False)

        for b in self.out_blocks:
            if isinstance(b, ResBlockEmb3D):
                emb_t = emb.expand(x.shape[0], -1)
                x = b(x, emb_t)
            else:
                x = b(x)

        x = self.norm_out(x)
        x = F.silu(x)
        x = self.conv_out(x)
        return x

# ==========================================
# Model loading
# ==========================================
MODEL_CACHE = OrderedDict()

# 放大模型常驻上限。放大模型是裸 nn.Module（不走 ComfyUI 的 ModelPatcher），
# 内核不会自动腾挪它；缓存无上限时，换过的模型会一直占着内存/显存到进程结束，
# 表现就是「跑的队列越多越卡，重启才好」。上限 2 覆盖「来回切两个模型」的常态。
MODEL_CACHE_LIMIT = 2


def _cache_put(key, model):
    """放入缓存并淘汰最久未用的，超上限的模型被丢弃后由 gc 回收。"""
    MODEL_CACHE[key] = model
    MODEL_CACHE.move_to_end(key)
    while len(MODEL_CACHE) > MODEL_CACHE_LIMIT:
        evicted_key, _ = MODEL_CACHE.popitem(last=False)
        print(f"[H3 Latent放大-3D] 缓存超限，已释放放大模型: {evicted_key}")
    gc.collect()


def clear_model_cache():
    """彻底清空放大模型缓存（供卸载/清理类节点调用）。"""
    if MODEL_CACHE:
        print(f"[H3 Latent放大-3D] 清空放大模型缓存（{len(MODEL_CACHE)} 个）")
    MODEL_CACHE.clear()
    gc.collect()


def get_models_dir():
    return folder_paths.get_folder_paths(_LATENT_UPSCALE_FOLDER)[0]

# 目录里没有放大模型时，下拉框唯一取值的占位文案
NO_MODEL_PLACEHOLDER = "（未找到放大模型，请放入 latent_upscale_models 目录）"

def scan_models():
    names = [
        name for name in folder_paths.get_filename_list(_LATENT_UPSCALE_FOLDER)
        if os.path.splitext(name)[1].lower() in (".pth", ".safetensors")
    ]
    return names if names else [NO_MODEL_PLACEHOLDER]

def _load_raw_sd(path):
    if path.endswith('.safetensors'):
        try:
            from safetensors import safe_open
            with safe_open(path, framework="pt", device="cpu") as f:
                sd = {k: f.get_tensor(k) for k in f.keys()}
        except ImportError:
            from safetensors.torch import load_file
            sd = load_file(path, device='cpu')
    else:
        sd = torch.load(path, map_location='cpu', weights_only=False)

    if isinstance(sd, dict) and 'model' in sd:
        sd = sd['model']
    sd = {k: v.to(torch.float16) if v.dtype == torch.float8_e4m3fn else v
          for k, v in sd.items()}
    return sd

def _extract_upscaler_sd(sd):
    if any(k.startswith("upscaler.") for k in sd):
        return {k[len("upscaler."):]: v for k, v in sd.items() if k.startswith("upscaler.")}
    return sd

def _detect_arch(sd):
    cfg = {
        "in_channels": 24, "in_blocks": 12, "out_blocks": 12, "channels": 512,
        "dropout": 0.1, "attn": False, "temporal_every": 2, "temporal_kernel": 5,
    }
    conv_key = 'conv_in.weight'
    if conv_key in sd:
        cfg["in_channels"] = sd[conv_key].shape[1]
        cfg["channels"] = sd[conv_key].shape[0]

    in_ids, out_ids = set(), set()
    temporal_in_indices, temporal_out_indices = set(), set()
    for k in sd.keys():
        m = re.match(r'in_blocks\.(\d+)\.in_layers\.', k)
        if m: in_ids.add(int(m.group(1)))
        m = re.match(r'out_blocks\.(\d+)\.in_layers\.', k)
        if m: out_ids.add(int(m.group(1)))
        m = re.match(r'in_blocks\.(\d+)\.dwconv\.weight', k)
        if m: temporal_in_indices.add(int(m.group(1)))
        m = re.match(r'out_blocks\.(\d+)\.dwconv\.weight', k)
        if m: temporal_out_indices.add(int(m.group(1)))

    if in_ids: cfg["in_blocks"] = len(in_ids)
    if out_ids: cfg["out_blocks"] = len(out_ids)

    if temporal_in_indices or temporal_out_indices:
        cfg["temporal_every"] = 2
        for k in sd.keys():
            if 'dwconv.weight' in k and k.endswith('dwconv.weight'):
                cfg["temporal_kernel"] = sd[k].shape[2]
                break
    else:
        cfg["temporal_every"] = 0

    if any('attn' in k for k in sd): cfg["attn"] = True
    cfg["attn"] = False
    return cfg

def load_model(name, device, precision=None):
    """加载放大模型。precision=None 时用模型文件里权重的原生 dtype，不做任何转换。"""
    backend_lbl = _backend_label(device)
    cache_key = f"{name}::{backend_lbl}::{precision}"
    if cache_key in MODEL_CACHE:
        model = MODEL_CACHE[cache_key]
        MODEL_CACHE.move_to_end(cache_key)
        return model.to(device, non_blocking=True)

    try:
        path = folder_paths.get_full_path_or_raise(_LATENT_UPSCALE_FOLDER, name)
    except Exception as e:
        raise FileNotFoundError(f"未找到放大模型文件: {name}") from e

    raw_sd = _load_raw_sd(path)
    up_sd = _extract_upscaler_sd(raw_sd)
    cfg = _detect_arch(up_sd)

    model = LatentResizer3D(
        in_channels=cfg["in_channels"], in_blocks=cfg["in_blocks"], out_blocks=cfg["out_blocks"],
        channels=cfg["channels"], dropout=cfg["dropout"], attn=cfg["attn"],
        temporal_every=cfg["temporal_every"], temporal_kernel=cfg["temporal_kernel"],
    )
    model.load_state_dict(up_sd, strict=True)
    if precision is None:
        # 原生精度：取权重文件里占比最高的浮点 dtype，模型保持该精度，不做转换
        float_dtypes = [t.dtype for t in up_sd.values() if t.is_floating_point()]
        if not float_dtypes:
            raise ValueError(f"放大模型 {name} 里没有浮点权重，无法确定原生精度")
        dtype = max(set(float_dtypes), key=float_dtypes.count)
    else:
        dtype = _PRECISION_DTYPES.get(precision, torch.float32)
    model = model.to(device).eval().requires_grad_(False)
    if dtype != torch.float32:
        model = model.to(dtype)

    # 权重已进模型，原始 state_dict（可达 1GB+）不再常驻
    del raw_sd, up_sd
    gc.collect()
    _cache_put(cache_key, model)
    print(f"[H3 Latent放大-3D] 已加载放大模型: {name}")
    print(f"  参数量: {sum(p.numel() for p in model.parameters()):,} | "
          f"注意力: 强制关闭 | 时序卷积: {'开' if cfg['temporal_every'] > 0 else '关'} "
          f"(every={cfg['temporal_every']}, kernel={cfg['temporal_kernel']}) | "
          f"后端: {backend_lbl} | 精度: {precision or f'原生({dtype})'}")
    return model


# ==========================================
# ComfyUI node (new API)
# ==========================================
class UpscaleMode(str, Enum):
    SCALE_BY = "按倍率"
    TARGET_DIMENSIONS = "目标尺寸"
    MEGAPIXELS = "百万像素"


class UpscaleWay(str, Enum):
    USE_MODEL = "模型放大（3D）"
    TRILINEAR = "插值放大（三线性）"


class UpscaleConfig(TypedDict):
    mode: UpscaleMode
    放大倍率: float
    目标宽度: int
    目标高度: int
    百万像素: float


# ==========================================
# 空间分块（方案A：沿长边单轴切条 + 核心区独占 + 余弦羽化）
#   - 只切空间长边，绝不切时间轴：每条都携带完整时间上下文，帧间一致性不受影响
#   - 每条独占自己的核心区；相邻两条只在重叠带内按余弦权重融合，权重和恒为 1
#   - 因而无接缝、无重影；本节点是前馈卷积网络（无注意力/无 sigma），不存在“小人”问题
# ==========================================
_SPATIAL_OVERLAP = 16  # 每侧重叠半宽（latent 格）——覆盖卷积感受野带来的边界效应

# 空间分块显存预设档位：用户声明显存档位 = 强制分块条数；
# 若整幅估算超出档位预算，再由 _smart_tile_count 自动加切保安全
_VRAM_PRESETS = ("4G", "8G", "12G", "16G", "24G")
_VRAM_PRESET_BYTES = {p: int(p[:-1]) * 2**30 for p in _VRAM_PRESETS}
_VRAM_PRESET_STRIPS = {"4G": 8, "8G": 6, "12G": 4, "16G": 3, "24G": 2}
_TILE_OFF = "禁止"


def _fmt_mem(b):
    """显存自适应单位显示：≥1GB 用 GB，否则用 MB（避免日志里出现 0.0GB 这种误导）。"""
    return f"{b / 2**30:.1f}GB" if b >= 2**30 else f"{b / 2**20:.0f}MB"


def _smart_tile_count(dev, h_in, w_in, h_out, w_out, t_eff, feat_channels,
                      act_factor=12, margin_bytes=512 * 1024 * 1024, budget_bytes=None):
    """
    智能化空间分块决策：按显存预算估算「整幅一次放大」的特征激活显存，
    选出刚好装得下的最少条数（1 = 不切分，零开销）。

    估算模型：显存 ≈ t_eff × 条输出latent像素 × 特征通道 × act_factor(并行特征图数) × fp16
      - 预算 = min(用户预设显存, 当前实际空闲显存) - margin：预设是用户对显卡档位的声明，
        实际空闲做兜底，防止其他节点占着显存时按预设满打满算导致 OOM
      - 推理在 inference_mode 下无反向激活，act_factor 取保守值即可
      - 切分后融合画布是整幅尺寸，已用 margin_bytes 统一兜底
    """
    if h_in >= w_in:
        axis, long_out = "高", h_out
    else:
        axis, long_out = "宽", w_out

    if dev.type != "cuda" or not torch.cuda.is_available():
        # CPU 路线：按输出 latent 长边保守估计（控制条数减少推理次数）
        n = 1 if long_out <= 160 else (2 if long_out <= 256 else 4)
        print(f"[H3 Latent放大] 空间分块(CPU保守档): 输出latent长边={long_out} → 切 {n} 条")
        return n

    # 释放缓存块后再测空闲显存：预算 = min(预设, 实际空闲) - margin
    try:
        if HAS_COMFY_MM:
            mm.soft_empty_cache()
        else:
            torch.cuda.empty_cache()
    except Exception:
        pass
    try:
        free_bytes, _ = torch.cuda.mem_get_info(dev)
    except Exception:
        free_bytes = torch.cuda.get_device_properties(dev).total_memory * 0.5

    preset_lbl = (f"{budget_bytes / 2**30:.0f}G 预设" if budget_bytes else "未设预设")
    budget = (min(budget_bytes, free_bytes) if budget_bytes else free_bytes) - margin_bytes

    def _est(n):
        if axis == "高":
            seg_px = math.ceil(h_out / n) * w_out
        else:
            seg_px = h_out * math.ceil(w_out / n)
        return t_eff * seg_px * feat_channels * act_factor * 2  # ×2 = fp16

    est_full = _est(1)
    if est_full <= budget:
        print(f"[H3 Latent放大] 空间分块({preset_lbl}): 实际空闲={_fmt_mem(free_bytes)} | "
              f"预算={_fmt_mem(budget)} | 整幅估算≈{_fmt_mem(est_full)} 可装下 → 预算推导 1 条")
        return 1

    for n in (2, 3, 4, 6, 8):
        if _est(n) <= budget:
            print(f"[H3 Latent放大] 空间分块({preset_lbl}): 实际空闲={_fmt_mem(free_bytes)} | "
                  f"预算={_fmt_mem(budget)} | 整幅估算≈{_fmt_mem(est_full)} 超出 → 自动切 {n} 条"
                  f"（每条≈{_fmt_mem(_est(n))}）")
            return n

    print(f"[H3 Latent放大] 空间分块({preset_lbl}): 预算{_fmt_mem(budget)} 仍不够 "
          f"（整幅估算≈{_fmt_mem(est_full)}）→ 直接切 8 条尽力执行")
    return 8


def _decide_tile_count(dev, h_in, w_in, h_out, w_out, t_eff, feat_channels,
                       act_factor, tile_preset):
    """空间分块条数决策：档位 = 强制条数（4G→8 / 8G→6 / 12G→4 / 16G→3 / 24G→2）；
    整幅估算超出档位预算时按预算自动加切（max 取安全侧）；「禁止」→ 1（整幅一次推理）。"""
    if tile_preset == _TILE_OFF:
        return 1
    n_forced = _VRAM_PRESET_STRIPS[tile_preset]
    n_budget = _smart_tile_count(dev, h_in, w_in, h_out, w_out, t_eff, feat_channels,
                                 act_factor=act_factor,
                                 budget_bytes=_VRAM_PRESET_BYTES[tile_preset])
    n = max(n_forced, n_budget)
    if n > n_forced:
        print(f"[H3 Latent放大] 空间分块: 档位固定 {n_forced} 条不够安全（预算推导 {n_budget} 条）"
              f"→ 按 {n} 条执行")
    else:
        print(f"[H3 Latent放大] 空间分块: 档位 {tile_preset} → 强制 {n_forced} 条")
    return n


def _cosine_ramp(d):
    """d∈[-1,1] 的余弦上升曲线：-1→0，0→0.5，1→1。"""
    return 0.5 - 0.5 * torch.cos(math.pi * (d + 1.0) / 2.0)


def _subpixel_warp_1d(seg, axis, scale, offset, length):
    """
    沿 axis 做一次亚像素仿射重采样：W(p) = seg(scale·p + offset)（像素中心坐标，线性插值）。
    scale≈1 且 offset≈0 时原样返回（零开销快路径）。

    用途：把每条分块的内部重采样锚定到全幅输出网格，使相邻条在重叠带内
    的内容逐像素对齐——交叉羽化的是“几乎相同的两幅图”，彻底消除条间
    比例舍入差（±1 latent 像素）造成的边缘重影。
    """
    if abs(scale - 1.0) < 1e-6 and abs(offset) < 1e-6:
        return seg
    p = torch.arange(length, device=seg.device, dtype=torch.float32)
    # 先把采样坐标钳制到 [0, L-1] 再取整：保证越界处（图像边缘）权重
    # 全部落在边界像素上（边缘复制语义），而不是错误地分给邻像素
    x = (scale * p + offset).clamp_(0.0, float(length - 1))
    f0 = torch.floor(x)
    w1 = x - f0                                   # 右邻像素权重
    i0 = f0.to(torch.long)
    i1 = (i0 + 1).clamp_(0, length - 1)
    a = seg.index_select(axis, i0)
    b = seg.index_select(axis, i1)
    view = [1] * seg.dim()
    view[axis] = length
    return a + (b - a) * w1.view(view).to(seg.dtype)


def _spatial_chunked_upscale(run_seg, s, h_out, w_out, n_strips):
    """
    沿长边把 latent 切成 n 条，逐条调用 run_seg(seg, target_hw) 放大后融合。

    融合规则（这就是“无接缝、无重影”的原因）：
      * 每条的核心区 [i*step, (i+1)*step) 只有它自己有权重（核心区独占）；
      * 相邻两条的重叠带内，左条权重从 1 余弦降到 0，右条从 0 余弦升到 1，
        两者之和在每一格都恒等于 1（余弦羽化）——融合结果无接缝；
      * 每条推理前做亚像素预校正（_subpixel_warp_1d），把各条自己的内部
        重采样统一锚定到全幅输出网格——重叠带内两条的内容逐像素对齐，
        交叉淡化的是“几乎相同的两幅图”，不会出现边缘重影；
      * 每条都携带完整时间轴，时间一致性不受分块影响。

    run_seg(seg, target_hw) -> 与 seg 同时间轴的 5D 张量，空间尺寸为 target_hw。
    """
    b, c, t, h_in, w_in = s.shape
    if h_in >= w_in:
        axis, in_len, out_len = 3, h_in, h_out
    else:
        axis, in_len, out_len = 4, w_in, w_out

    n = max(1, min(int(n_strips), in_len))
    if n == 1:
        return run_seg(s, (h_out, w_out))

    r = out_len / in_len
    step = in_len / n
    band = max(1, min(_SPATIAL_OVERLAP, int(step // 3)))   # 每侧重叠半宽（源坐标）
    band_out = max(1, int(round(band * r)))                # 映射到输出坐标

    print(f"[H3 Latent放大] 空间分块: 沿{'高' if axis == 3 else '宽'}切 {n} 条 | "
          f"重叠半宽={band} (latent) | 每条核心区≈{step:.0f} 格")

    out_full = torch.zeros(b, c, t, h_out, w_out, device=s.device, dtype=s.dtype)
    wsum = torch.zeros(1, 1, 1, h_out, w_out, device=s.device, dtype=s.dtype)
    t_start = time.perf_counter()
    axis_dim = 3 if axis == 3 else 4

    for i in range(n):
        core_lo = int(round(i * step))
        core_hi = in_len if i == n - 1 else int(round((i + 1) * step))
        lo = 0 if i == 0 else max(0, core_lo - band)
        hi = in_len if i == n - 1 else min(in_len, core_hi + band)

        seg = s[:, :, :, lo:hi, :] if axis == 3 else s[:, :, :, :, lo:hi]
        seg = seg.contiguous()

        o_lo = 0 if i == 0 else int(round(lo * r))
        o_hi = out_len if i == n - 1 else int(round(hi * r))
        seg_out_len = max(1, o_hi - o_lo)
        if axis == 3:
            target_hw = (seg_out_len, w_out)
        else:
            target_hw = (h_out, seg_out_len)

        # 亚像素预校正：本条内部重采样比例是 O/L（含舍入差），与全幅比例 r
        # 相差最多 ±1/L，叠加在重叠带上就是 ±1 个 latent 像素的内容错位
        # （像素空间 ≈16px 的边缘重影）。这里把本条的采样网格仿射校正到
        # 全幅输出网格，使相邻条在重叠带内逐像素对齐。
        seg = _subpixel_warp_1d(seg, axis_dim,
                                seg_out_len / ((hi - lo) * r),
                                o_lo / r - 0.5 - lo + 0.5 * seg_out_len / ((hi - lo) * r),
                                hi - lo)

        seg_out = run_seg(seg, target_hw)
        del seg

        # 本条的 1D 权重（输出坐标）：核心区=1，重叠带=与邻条互补的余弦曲线
        p = torch.arange(o_lo, o_hi, device=s.device, dtype=torch.float32)
        w = torch.ones(seg_out_len, device=s.device, dtype=torch.float32)
        if i > 0:  # 左边界：权重从 0 余弦升到 1
            d = ((p - core_lo * r) / band_out).clamp(-1.0, 1.0)
            w = w * _cosine_ramp(d)
        if i < n - 1:  # 右边界：权重从 1 余弦降到 0
            d = ((p - core_hi * r) / band_out).clamp(-1.0, 1.0)
            w = w * (1.0 - _cosine_ramp(d))

        if axis == 3:
            w_v = w.view(1, 1, 1, seg_out_len, 1).to(s.dtype)
            out_full[:, :, :, o_lo:o_hi, :] += seg_out * w_v
            wsum[:, :, :, o_lo:o_hi, :] += w_v
        else:
            w_v = w.view(1, 1, 1, 1, seg_out_len).to(s.dtype)
            out_full[:, :, :, :, o_lo:o_hi] += seg_out * w_v
            wsum[:, :, :, :, o_lo:o_hi] += w_v

        del seg_out, w, p, w_v
        gc.collect()
        print(f"[H3 Latent放大] 空间分块: 条 {i + 1}/{n} 完成"
              f"（累计 {time.perf_counter() - t_start:.1f}s）")

    # 权重和恒为 1，此处除法只是数值保险
    return out_full / wsum.clamp(min=1e-8)


# ==========================================
# 音频重绘（只重绘音频流，修掉杂音/爆音）
#   - H3 音频潜空间为 [B, 32, 2, T40]，时间轴 40 latent 帧/秒
#   - ComfyUI 采样器原生支持「嵌套掩码」：latent["noise_mask"] 传 NestedTensor((视频掩码, 音频掩码)) 时，
#     comfy/samplers.py 会把掩码按流解包，缺省流补全 1（全重绘）
#   - 掩码语义：1 = 该流完全重新生成；0 = 该流完全保持原样；中间值 = 部分重绘
#     所以本节点只需把掩码写进潜空间，下游 KSampler 就会只按掩码重绘音频
# ==========================================
_H3_AUDIO_LATENT_FPS = 40.0


def _build_audio_repaint_mask(audio_shape, start_sec, end_sec, feather_sec, strength):
    """
    构造音频流的重绘掩码 (1, 1, 2, T40)。
    start_sec=0 从音频开头开始；end_sec<=0 表示一直到结尾；feather 为余弦羽化（避免边界突变爆音）。
    返回 None 表示时间段无效。
    """
    t_audio = int(audio_shape[-1])
    dim2 = int(audio_shape[-2]) if len(audio_shape) >= 4 else 1
    fps = _H3_AUDIO_LATENT_FPS

    lo = max(0.0, float(start_sec)) * fps
    hi = float(end_sec) * fps if float(end_sec) > 0 else float(t_audio)
    hi = min(hi, float(t_audio))
    if hi <= lo:
        return None

    feather = max(0.0, float(feather_sec)) * fps
    feather = min(feather, (hi - lo) / 2.0)   # 两侧羽化不重叠

    idx = torch.arange(t_audio, dtype=torch.float32)
    mask = torch.zeros(t_audio, dtype=torch.float32)
    inner_lo, inner_hi = lo + feather, hi - feather
    mask[(idx >= inner_lo) & (idx <= inner_hi)] = 1.0
    for a, b, rising in ((lo, inner_lo, True), (inner_hi, hi, False)):
        if b - a <= 1e-6:
            continue
        sel = (idx > a) & (idx < b)
        if not bool(sel.any()):
            continue
        u = (idx[sel] - a) / (b - a)
        ramp = 0.5 - 0.5 * torch.cos(math.pi * u)
        mask[sel] = ramp if rising else (1.0 - ramp)

    mask = (mask.clamp(0.0, 1.0) * float(strength)).view(1, 1, 1, t_audio)
    return mask.expand(1, 1, dim2, t_audio).contiguous()


def _fit_video_mask(prev_mask, video_out):
    """把上游传来的视频掩码对齐到本节点输出尺寸。

    上游（如人脸修复台）给的是放大**前**的 latent 网格，空间要跟着一起放大；
    时间轴一般不变，但一并按目标尺寸插值更稳（多一帧少一帧都不会错位）。
    返回 [B,1,T,h,w]，语义不变：1=重绘，0=保留。
    """
    if getattr(prev_mask, "is_nested", False):
        prev_mask = list(prev_mask.unbind())[0]
    m = prev_mask
    if m.dim() == 4:
        m = m.unsqueeze(1)
    m = m[:1, :1].float()
    t, h, w = int(video_out.shape[2]), int(video_out.shape[3]), int(video_out.shape[4])
    if tuple(m.shape[2:]) != (t, h, w):
        m = F.interpolate(m, size=(t, h, w), mode="trilinear", align_corners=False)
    return m.clamp(0.0, 1.0).expand(video_out[:, :1].shape).to(
        device=video_out.device, dtype=video_out.dtype)


def _attach_audio_repaint_mask(latent_out, video_out, audio,
                               strength, start_sec, end_sec, feather_sec,
                               prev_mask=None):
    """把音频重绘掩码挂到输出的 AV 潜空间上（顺序必须是 视频, 音频）。

    掩码语义（ComfyUI noise_mask）：1 = 重新生成，0 = 保留原样。
    音频按强度：> 0 用区间羽化掩码，= 0 用全 0 —— 全 0 表示"只重绘视频、音频
    整段保留"。强度 0 也必须写掩码而不是跳过：不写掩码时下游 KSampler 会按自己
    的 denoise 把音频一起重新生成（denoise=1 时音频被完整重绘），这正是"关了
    音频重绘却还是被重绘"的来源。

    视频掩码不再写死全 1：上游若已带了 noise_mask（人脸修复台的局部掩码），
    就把它按输出尺寸缩放后原样带下去，否则一手全 1 会把上游的局部重绘抹平
    ——「掩码保留契约」：谁都没权把别人标好的保留区改成重绘区。
    """
    if float(strength) > 0.0:
        audio_mask = _build_audio_repaint_mask(audio.shape, start_sec, end_sec, feather_sec, strength)
        if audio_mask is None:
            raise ValueError("音频重绘区间无效：起始秒必须小于结束秒（结束秒 0 表示到结尾）。")
        end_lbl = f"{float(end_sec):.1f}s" if float(end_sec) > 0 else "结尾"
        tail = (f"{float(start_sec):.1f}s → {end_lbl}"
                f"（音频 {int(audio.shape[-1])} 帧 @40fps）| "
                f"强度={float(strength):.2f} | 羽化={float(feather_sec):.2f}s | "
                f"下游 KSampler 将按掩码重绘音频流")
    else:
        audio_mask = torch.zeros((1, 1, int(audio.shape[-2]), int(audio.shape[-1])),
                                 dtype=torch.float32)
        tail = "音频整段保留（只重绘视频流）"

    if prev_mask is not None:
        video_mask = _fit_video_mask(prev_mask, video_out)
        tail += " | 视频沿用上游局部掩码"
    else:
        video_mask = torch.ones_like(video_out[:, :1])
    latent_out["noise_mask"] = NestedTensor((video_mask, audio_mask))
    print("[H3 Latent放大] 音频重绘掩码已写入潜空间: " + tail)


def _text(value):
    """枚举取可读文本（class X(str, Enum) 的 str() 会给出 "X.MEMBER"）。"""
    return value.value if isinstance(value, Enum) else value


def _fill_combo(value, own_key, own_default, sub_defaults):
    """把缺失/不完整的 DynamicCombo 取值补齐。

    返回 (字典, 选择是否缺失, 补齐的子参数列表)。两者必须区分开：
      * 选择缺失 = 下拉的选中项没随工作流传入（前端控件未同步/旧工作流），
        这才是需要告警的真实异常；
      * 子参数缺失 = 正常现象：子参数挂在各自的 Option 下，前端只序列化
        激活选项的子控件（例如选「按倍率」时，「目标宽度/目标高度」属于
        未激活的「目标尺寸」选项，不会被传入），按默认补齐即可，不告警。

    io.DynamicCombo.Input 没有 default 参数（comfy_api/latest/_io.py:1235），
    schema 层面表达不了默认值；这里按与前端一致的口径重建：默认选中第一个
    Option，Option 内的子控件用各自的 default —— 保证"刚拖出来的节点"和
    "缺值的旧工作流"行为一致。
    """
    filled = dict(value) if isinstance(value, dict) else {}
    selection_missing = not (own_key in filled or "mode" in filled)
    if selection_missing:
        filled[own_key] = own_default
    filled_subs = [k for k in sub_defaults if k not in filled]
    for key, default in sub_defaults.items():
        filled.setdefault(key, default)
    return filled, selection_missing, filled_subs


class MinimaxH3LatentUpscaler3D(io.ComfyNode):
    """Minimax H3 latent 放大节点：神经网络放大（3D 主干）。"""

    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="BanZhang_H3LatentUpscale",
            display_name="🎬 H3 Latent放大",
            category="👨‍🏫班长/MiniMax H3",
            description=(
                "直接在 Minimax H3 的 24 通道 latent 上放大，省掉"
                "「解码 → 像素放大 → 再编码」的高成本往返。\n"
                "「放大方式」二选一：\n"
                "· 模型放大（3D）：训练好的神经网络，质量更高，加载后约占 3GB 显存；\n"
                "· 插值放大（三线性）：不加载模型、几乎零显存，靠后续 KSampler 二采补细节，"
                "适合 8G 小显存。\n"
                "接官方 AV 潜空间时只放大视频流，音频流原样透传（形状不变）；"
                "调整「音频重绘强度」可把重绘掩码写进潜空间，让下游 KSampler 只重绘音频、修掉杂音。\n"
                "「尺寸模式」支持按倍率、目标尺寸、百万像素三种定尺寸方式；"
                "模型放大时倍率建议用 1.5 / 2.0 这类训练档位（倍率会直接喂给模型，1.2 这类小数无保证）。\n"
                "「空间分块」按显存档位强制切条（4G→8条 / 8G→6条 / 12G→4条 / 16G→3条 / "
                "24G→2条，「禁止」不分块），逐段放大再余弦羽化融合"
                "（权重和恒为 1，无接缝无重影，不切时间轴），仅模型放大生效。\n"
                "典型用法：先低分辨率出片 → 本节点放大 latent → 再用官方 KSampler 在目标分辨率二采精修。"
            ),
            search_aliases=["minimax", "h3", "latent", "upscale", "2d", "3d"],
            inputs=[
                io.Latent.Input("latent", display_name="潜空间",
                                tooltip="待放大的 latent（图像或视频，24 通道 Minimax H3 latent）。"
                                        "支持官方 AV 潜空间：只放大视频流，音频流原样透传。"),

                io.DynamicCombo.Input(
                    "放大方式",
                    display_name="放大方式",
                    tooltip="模型放大：加载放大模型推理，质量更高，约占 3GB 显存。\n"
                            "插值放大（三线性）：不加载模型、几乎零显存，"
                            "质量靠后续 KSampler 二采补细节，适合 8G 小显存。",
                    options=[
                        io.DynamicCombo.Option(UpscaleWay.USE_MODEL, [
                            io.Combo.Input("放大模型", options=scan_models(),
                                           tooltip="从 ComfyUI/models/latent_upscale_models 选择的放大模型权重。"),

                            io.Combo.Input("时间分块",
                                           options=["开启", "关闭"], default="开启",
                                           tooltip="开启后智能化分配：自动读取当前空闲显存，以 60 秒为基准"
                                                   "（≈420 latent 帧）分段——视频 ≤60 秒且显存装得下"
                                                   "就整段推理（上下文最完整、无时间融合缝）；更长视频在 60s/40s/30s/20s/15s/10s/5s/2.5s "
                                                   "档位里选显存装得下的最长片长，并消除末尾帧闪烁。\n"
                                                   "相邻片之间用升余弦窗交叉淡化，融合带按 3D 卷积感受野取 16 帧，无接缝。\n"
                                                   "注：H3 官方训练上限约 15 秒，更长素材整段跑属外推；若长素材漂移，"
                                                   "选「关闭」以外的方式无效，需把素材控制在训练区间或走多段续写。\n"
                                                   "与空间分块自动联动（按切条后的实际面积决策）。「关闭」= 整段一次推理。"),

                            io.Combo.Input("空间分块",
                                           options=[_TILE_OFF] + list(_VRAM_PRESETS),
                                           default=_TILE_OFF,
                                           tooltip="选择显卡显存档位 = 强制分块条数：4G→8条、8G→6条、12G→4条、"
                                                   "16G→3条、24G→2条；「禁止」= 整幅一次推理（不分块）。\n"
                                                   "若整幅估算显存超出该档位预算（预算还会与当前实际空闲显存"
                                                   "取小值兜底），自动再加切条数保安全。\n"
                                                   "每条推理前做亚像素预校正，重叠带余弦羽化（权重和恒为 1）："
                                                   "无接缝、无重影。\n"
                                                   "绝不切时间轴——每条都携带完整时间上下文，帧间一致性不受影响。"),
                        ]),
                        io.DynamicCombo.Option(UpscaleWay.TRILINEAR, []),
                    ],
                ),

                io.DynamicCombo.Input(
                    "mode",
                    display_name="尺寸模式",
                    tooltip="目标尺寸怎么算。",
                    options=[
                        io.DynamicCombo.Option(UpscaleMode.SCALE_BY, [
                            io.Float.Input("放大倍率",
                                           default=2.0, min=1.0, max=4.0, step=0.05,
                                           tooltip="按倍数放大，1.0–4.0。填 1.0 时原样返回输入。"),
                        ]),
                        io.DynamicCombo.Option(UpscaleMode.TARGET_DIMENSIONS, [
                            io.Int.Input("目标宽度",
                                         default=1280, min=64, max=8192, step=8,
                                         tooltip="目标像素宽度。内部会按像素网格对齐并反推等效倍率。"),
                            io.Int.Input("目标高度",
                                         default=704, min=64, max=8192, step=8,
                                         tooltip="目标像素高度。内部会按像素网格对齐并反推等效倍率。")
                        ]),
                        io.DynamicCombo.Option(UpscaleMode.MEGAPIXELS, [
                            io.Float.Input("百万像素",
                                           default=1.0, min=0.1, max=16.0, step=0.1,
                                           tooltip="目标总像素（百万像素），自动保持原宽高比。")
                        ])
                    ],
                ),

                io.Float.Input("repaint_strength", display_name="音频重绘强度",
                               default=0.0, min=0.0, max=1.0, step=0.05,
                               tooltip="音频处理方式（掩码总是写入 AV 潜空间，下游 KSampler 据此分流视频/音频）：\n"
                                       "0 = 音频整段保留，只重绘视频流（默认，原音频不会被采样带走）；\n"
                                       "1.0 = 音频完全重新生成（修杂音/爆音）；0.5 = 新旧音频各占一半。\n"
                                       "重绘全程生效；需要下游接 KSampler 采样。"),

            ],
            outputs=[
                io.Latent.Output(display_name="潜空间", tooltip="放大后的 latent，可直接接官方 KSampler 二采。"),
            ],
        )

    @classmethod
    def execute(cls, latent: dict, 放大方式=None, mode=None,
                repaint_strength: float = 0.0) -> io.NodeOutput:

        # 「放大方式」是 DynamicCombo：新工作流传 {"放大方式": 选中项, "放大模型": ...,
        # "时间分块": ..., "空间分块": ...}；旧工作流/脚本传裸值时
        # 子参数按默认补齐。选择缺失按默认取值并打 warning 明示，不静默（口径与
        # 「尺寸模式」一致）。真没有放大模型文件时，下面的 NO_MODEL_PLACEHOLDER
        # 检查照常报错。
        if isinstance(放大方式, dict):
            way = dict(放大方式)
        elif 放大方式 is None:
            way = {}
        else:
            way = {"放大方式": 放大方式}
        way_sel = way.get("放大方式")
        if way_sel is None:
            way_sel = UpscaleWay.USE_MODEL
            logging.warning(
                "[H3 Latent放大] 「放大方式」的选择未随工作流传入（旧工作流/前端控件未同步），"
                "已按默认取值继续：放大方式=%s（模型/分块子参数一并回默认）。"
                "想改设置请刷新浏览器（Ctrl+F5）后重新选择并保存工作流。", _text(way_sel))
        use_model = (way_sel == UpscaleWay.USE_MODEL)
        model_name = way.get("放大模型")
        # 「时间分块」是「开启/关闭」下拉。键名与 schema 里的中文 id 一致：前端对
        # 动态组合的子控件强制用 id 当显示名，所以子参数 id 必须是中文。
        # 旧工作流的英文键 / 布尔值也兼容：False 或 "关闭" → 关闭分块，其余 → 开启。
        enable_temporal_chunking = way.get("时间分块", way.get("enable_temporal_chunking", "开启")) \
            not in ("关闭", False)
        tile_mode = way.get("空间分块", way.get("tile_mode", _TILE_OFF))
        model_name = model_name if model_name else scan_models()[0]

        # 「尺寸模式」下拉缺失时按默认取值补齐（口径见 _fill_combo），而不是把流程掐断：
        # 旧工作流要等到用户手动刷新并重新保存才能恢复，挂着硬报错等于这个节点
        # 永久不可用。补的是"节点刚拖出来时的默认状态"，并打一条 warning 明示，
        # 不静默。子参数缺失属正常现象（前端只序列化激活选项的子控件），不告警。
        # 真没有放大模型文件时，下面的 NO_MODEL_PLACEHOLDER 检查照常报错。
        mode, missing_mode, sub_mode = _fill_combo(
            mode, "mode", UpscaleMode.SCALE_BY, {"放大倍率": 2.0})
        if missing_mode:
            logging.warning(
                "[H3 Latent放大] 「尺寸模式」下拉的选择未随工作流传入（前端控件未同步），"
                "已按默认取值继续：尺寸模式=%s（倍率=%s）。"
                "想改设置请刷新浏览器（Ctrl+F5）后重新选择并保存工作流。",
                _text(mode["mode"]), mode["放大倍率"])

        # V3 DynamicCombo 传给 execute 的字典以内嵌的"自身 id"为键：
        #   combo "mode" -> {"mode": 选中项, "放大倍率": ...}
        # 兼容旧格式（"mode" 键）与纯字符串值。
        def _combo_selected(d, own_key, default):
            if isinstance(d, str):
                return d
            if isinstance(d, dict):
                if own_key in d:
                    return d[own_key]
                if "mode" in d:
                    return d["mode"]
            return default

        if use_model and model_name == NO_MODEL_PLACEHOLDER:
            raise ValueError("请先将放大模型文件放入 latent_upscale_models 目录，"
                             "或把「放大方式」改为「插值放大（三线性）」")

        selected_mode = _combo_selected(mode, "mode", UpscaleMode.SCALE_BY)

        # 空间分块预设："禁止" = 整幅一次推理；其余 = 档位强制条数（4G→8/8G→6/12G→4/16G→3/24G→2），
        # 估算超出档位预算时按预算自动加切。
        # 旧工作流存的是布尔值：False → 禁止；True / 异常值 → "24G"（2 条 + 预算兜底）。
        if tile_mode is False:
            tile_preset = _TILE_OFF
        elif isinstance(tile_mode, str) and (tile_mode == _TILE_OFF or tile_mode in _VRAM_PRESET_BYTES):
            tile_preset = tile_mode
        else:
            tile_preset = _TILE_OFF

        # 官方 MiniMax H3 AV 潜空间是 NestedTensor(视频, 音频)：只放大视频流，音频流原样透传。
        samples = latent["samples"]
        is_av = bool(getattr(samples, "is_nested", False))
        audio = None
        if is_av:
            video, audio = samples.unbind()
            src = video
        else:
            src = samples

        orig_dtype = src.dtype
        was_4d = (src.ndim == 4)

        # 固定默认：运算设备 cuda（无显卡自动退回 cpu）、推理后卸载模型。
        # 精度已固定（不再作为参数暴露）：显卡走 fp16（省显存、更快）；CPU 固定 fp32。
        dev = _resolve_device("cuda")
        precision_token = "fp32" if dev.type != "cuda" else "fp16"
        compute_dtype = _PRECISION_DTYPES[precision_token]

        s = src.to(device=dev, dtype=compute_dtype, copy=True)
        if was_4d:
            s = s.unsqueeze(2)

        b, c, t, h_in, w_in = s.shape
        t_exec = time.perf_counter()
        downsample = VAE_DOWNSAMPLE

        # 1. Calculate Target Size（子参数缺失时退回各自默认值）
        if selected_mode == UpscaleMode.SCALE_BY:
            scale_val = mode.get("放大倍率", 2.0) if isinstance(mode, dict) else 2.0
            w_pixel_target = w_in * downsample * scale_val
            h_pixel_target = h_in * downsample * scale_val
            effective_scale = scale_val
        elif selected_mode == UpscaleMode.TARGET_DIMENSIONS:
            w_pixel_target = float(mode.get("目标宽度", 1280)) if isinstance(mode, dict) else 1280.0
            h_pixel_target = float(mode.get("目标高度", 704)) if isinstance(mode, dict) else 704.0
            effective_scale = (w_pixel_target / (w_in * downsample) + h_pixel_target / (h_in * downsample)) / 2.0
        elif selected_mode == UpscaleMode.MEGAPIXELS:
            mp = mode.get("百万像素", 1.0) if isinstance(mode, dict) else 1.0
            target_pixels = mp * 1024 * 1024
            aspect_ratio = w_in / h_in
            h_pixel_target = (target_pixels / aspect_ratio) ** 0.5
            w_pixel_target = h_pixel_target * aspect_ratio
            effective_scale = (w_pixel_target / (w_in * downsample) + h_pixel_target / (h_in * downsample)) / 2.0
        else:
            raise ValueError(f"不支持的尺寸模式: {selected_mode}")

        # 2. Pixel-space alignment（像素对齐固定 32：消除底部光带，不再作为参数暴露）
        alignment = 32
        w_pixel_aligned = round(w_pixel_target / alignment) * alignment
        h_pixel_aligned = round(h_pixel_target / alignment) * alignment

        w_pixel_final = round(w_pixel_aligned / downsample) * downsample
        h_pixel_final = round(h_pixel_aligned / downsample) * downsample

        w_out = max(1, int(w_pixel_final // downsample))
        h_out = max(1, int(h_pixel_final // downsample))

        if effective_scale < 1.0 and (w_out < w_in or h_out < h_in):
            raise ValueError("该模型仅支持放大（等效倍率需 ≥ 1.0）。")

        if w_out == w_in and h_out == h_in:
            # 不缩放也要写音频重绘掩码，否则"只改音频、不放大画面"这个用法失效
            if is_av:
                v_keep, a_keep = latent["samples"].unbind()
                passthrough = dict(latent)
                _attach_audio_repaint_mask(passthrough, v_keep, a_keep, repaint_strength,
                                           0.0, 0.0, 0.0,
                                           prev_mask=latent.get("noise_mask"))
                return io.NodeOutput(passthrough)
            return io.NodeOutput(latent)

        print(f"[H3 Latent放大] latent {w_in}x{h_in} → {w_out}x{h_out} | "
              f"像素 {w_out * downsample}x{h_out * downsample} | 等效倍率={effective_scale:.3f} | 方式={_text(way_sel)}"
              + (" | AV潜空间：音频原样透传" if is_av else ""))

        # 3. Inference
        if not use_model:
            # 三线性插值：不加载模型、几乎零显存；只放大 H×W，时间轴不动。
            out = F.interpolate(s, size=(t, h_out, w_out), mode="trilinear",
                                align_corners=False)
        else:
            # 模型放大：空间分块 tile_preset="禁止" → 整幅一次；其余 → 档位强制条数，
            # 估算超出档位预算时按预算自动加切。
            norm_mean, norm_std = _make_norm_tensors(dev, compute_dtype)

            model = load_model(model_name, dev, precision_token)
            feat_ch = model.conv_in.weight.shape[0]
            # 3D 主干：开启时间分块时单次推理的有效时间长度被限制在 32+2*kernel 之内。
            t_eff = min(t, 32 + 2 * 5) if enable_temporal_chunking else t
            n_strips = _decide_tile_count(dev, h_in, w_in, h_out, w_out, t_eff,
                                          feat_ch, 12, tile_preset)
            with torch.inference_mode():
                s_norm = (s - norm_mean) / norm_std
                del s

                def _run_model_seg(seg, target_hw):
                    th, tw = target_hw
                    return model(seg, scale=effective_scale, target_size=(t, th, tw),
                                 enable_chunking=enable_temporal_chunking)

                if n_strips > 1:
                    out = _spatial_chunked_upscale(_run_model_seg, s_norm, h_out, w_out, n_strips)
                else:
                    out = _run_model_seg(s_norm, (h_out, w_out))
                del s_norm
                out = out * norm_std + norm_mean

        if was_4d:
            out = out.squeeze(2)

        out = out.to(device="cpu", dtype=orig_dtype, non_blocking=True)

        # 4. VRAM Management（模型放大：推理后卸载模型，释放显存给后续节点）
        if dev.type == "cuda" and use_model:
            model.to("cpu", non_blocking=True)
            print("[H3 Latent放大] ✅ 模型已卸载回 CPU，显存已释放。")
        if dev.type == "cuda":
            if HAS_COMFY_MM:
                mm.soft_empty_cache()
            else:
                torch.cuda.empty_cache()
            gc.collect()

        if is_av:
            # 重新打包为 AV 潜空间；音频重绘掩码总是写入（强度 0 = 音频整段保留），
            # 下游 KSampler 据此分流处理视频/音频。
            video_out = out
            packed = NestedTensor((video_out, audio))
            latent_out = {"samples": packed}
            _attach_audio_repaint_mask(latent_out, video_out, audio, repaint_strength,
                                       0.0, 0.0, 0.0,
                                       prev_mask=latent.get("noise_mask"))
        else:
            latent_out = {"samples": out}

        print(f"[H3 Latent放大] ✅ 全部完成，总耗时 {time.perf_counter() - t_exec:.1f}s。"
              + ("耗时构成 = 空间条数 × 时间分块数 × 单次推理，显存档位选得越小条数越多越慢。"
                 if use_model else "（插值放大：不加载模型，无分块开销）"))

        return io.NodeOutput(latent_out)

# ==========================================
# Registration
# ==========================================
if USE_NEW_API:
    class MinimaxH3Extension(ComfyExtension):
        @override
        async def get_node_list(self) -> list[type[io.ComfyNode]]:
            return [MinimaxH3LatentUpscaler3D]

    async def comfy_entrypoint() -> MinimaxH3Extension:
        return MinimaxH3Extension()

NODE_CLASS_MAPPINGS = {
    "BanZhang_H3LatentUpscale": MinimaxH3LatentUpscaler3D,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "BanZhang_H3LatentUpscale": "🎬 H3 Latent放大",
}
