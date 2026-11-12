# -*- coding: utf-8 -*-
"""
👨‍🏫 班长 FlashVSR 扩散超分（自包含单节点）
================================================================================
把低清视频用 FlashVSR 扩散模型重画成高清，输出是一段 mp4。模型固定 4 倍重建，
输出尺寸由「放大模式」（按倍数 / 目标尺寸 / 兆像素）指定；完全按目标来，
显存不够直接报错，不自动缩。

输出只有「视频」一个端口（VIDEO 类型，可直连「🎥 视频合并」的「🎬 视频文件」）：
边算边用 GPU（NVENC）压成 mp4，内存 O(1)，不再往 ComfyUI 交回 IMAGE 批次。

为什么不用官方 FlashVSR 插件 / 外部程序：
    模型实现直接内置在 `_flashvsr/` 子包里（来自回归超分整合包实测过的
    Lackluster fork），权重读 ComfyUI 自己的 `models/FlashVSR/`。
    不 import 任何第三方 ComfyUI 节点包，不起子进程，全程同进程跑。

相对官方插件多出来的关键优化（都是实测出来的）：
    1. DiT 权重 fp8 存储 / bf16 计算 —— 显存减半，不然 16G 卡装不下
    2. 流式 KV 缓存 int8 —— 1080p 下这是显存大头，bf16 要 ~6G
    3. LazyLQ —— 低清帧按窗口现放大，不整段预生成（13MB/帧 → 0.4MB/帧）
    4. 流式吐帧 + 可中断 —— 边算边收，随时取消
    5. 小波色彩校正 —— adain 只对齐全局均值方差会偏粉，小波按局部低频对齐
    6. 直写 mp4 —— NVENC 硬编码（恒定 QP 16，肉眼近乎无损），内存 O(1)，
       跑几千帧也不爆内存（前面几条省的是显存，这条省的是内存）

为什么只有一套管线（tiny）：
    官方的 full 模式看着高级，实际 `__call__` 里判断到 TCDecoder 存在就走
    TCDecoder，和 tiny 完全同一条路；full 只是多一个用不上的 VAE 兜底分支，
    还得多加载一个 300MB+ 的 VAE 权重。tiny-long 与 tiny 代码近乎重复，且没有
    流式回调和取消支持。所以 tiny 就是完整能力，其余两个是冗余。
================================================================================
"""

from __future__ import annotations

import math
import os

import torch
import torch.nn.functional as F

import comfy.model_management
import comfy.utils
import folder_paths

from ._flashvsr.models import ModelManager
from ._flashvsr.models import wan_video_dit
from ._flashvsr.models.TCDecoder import build_tcdecoder
from ._flashvsr.models.utils import Causal_LQ4x_Proj
from ._flashvsr.mp4 import Mp4Writer
from ._flashvsr.pipelines.flashvsr_tiny import FlashVSRTinyPipeline, PipelineCancelled
from ._flashvsr.vram_management import layers

# 权重目录：ComfyUI 自己的 models/FlashVSR（官方插件放的也是这里，直接复用）
folder_paths.add_model_folder_path("FlashVSR", os.path.join(folder_paths.models_dir, "FlashVSR"))

_DIR = os.path.dirname(os.path.abspath(__file__))
_PROMPT = os.path.join(_DIR, "_flashvsr", "posi_prompt.pth")
_REQUIRED = (
    "diffusion_pytorch_model_streaming_dmd.safetensors",
    "LQ_proj_in.ckpt",
    "TCDecoder.ckpt",
)

# 流式管线至少要 33 帧才跑得起来（process_total_num >= 2）
_MIN_FRAMES = 33


_PRECISION = {
    "fp8（省显存，推荐）": "fp8",
    "bf16（快，30/40/50系推荐）": "bf16",
    "fp16（老卡兼容）": "fp16",
}

_DECODE = ("自动（推荐）", "不分块（最快）", "分块（最省显存）")

# 放大模式的显示名 -> 内部代号（对齐 H3 终极放大的「放大模式」）
_SIZE_MODE = {"按倍数": "scale", "目标尺寸": "target", "兆像素": "megapixels"}

# 速度档位 -> 稀疏注意力的 topk 系数。数字越大 = 每个画面块参考的范围越广 = 越慢越细。
# 1.5 是原版写死的值，即"标准"档与改动前完全一致。
_SPEED = {
    "精细（更慢更细）": 2.0,
    "标准（推荐）": 1.5,
    "快": 0.9,
    "极快（可能掉细节）": 0.5,
}

# 注意力后端与 KV 量化都是模块级全局，只在加载时设一次
wan_video_dit.ATTENTION_MODE = "sparse_sage_attention"

# 已加载的管线缓存：(精度, 设备) -> pipe。连续跑不重复读 5.7G 权重
_PIPES: dict[tuple[str, str], FlashVSRTinyPipeline] = {}


# --------------------------------------------------------------------------- #
# 尺寸 / 帧数规划
# --------------------------------------------------------------------------- #
def _largest_8n1_leq(n: int) -> int:
    """不超过 n 的最大 8n+1。"""
    return 0 if n < 1 else ((n - 1) // 8) * 8 + 1


def _next_8n5(n: int) -> int:
    """不小于 n 的最小 8n+5（下限 21）。"""
    return 21 if n < 21 else ((n + 2) // 8) * 8 + 5


def plan_size(w: int, h: int, mode_code: str, scale: float, tw: int, th: int, mp: float):
    """源 W×H -> 模型输入 (w_in,h_in) 与输出 (out_w,out_h)。

    目标语义（与 H3 终极放大的「放大模式」一致）：输出直接按目标定，不设面积上限。
    三种模式：按倍数 / 目标尺寸 / 兆像素。模型固定 4 倍，所以模型输入 = 输出 / 4。
    宽高严格等比：先定唯一缩放比算高，再用实际高度比例回推宽度（不拉伸画面）。
    """
    if mode_code == "scale":
        r = float(scale)
    elif mode_code == "target":
        r = (tw / w + th / h) / 2.0
    elif mode_code == "megapixels":
        target_pixels = mp * 1024 * 1024
        ar = w / h
        h_target = (target_pixels / ar) ** 0.5
        w_target = h_target * ar
        r = (w_target / w + h_target / h) / 2.0
    else:
        raise ValueError(f"不支持的放大模式：{mode_code}")

    out_h = max(16, round(h * r))
    out_w = max(16, round(w * (out_h / h)))
    w_in = max(16, round(out_w / 4))
    h_in = max(16, round(out_h / 4))
    return w_in, h_in, w_in * 4, h_in * 4


def _auto_mp4_path() -> str:
    """mp4 落到插件目录下的临时文件夹，跑之前清掉上次的旧文件（用完即删，不堆积）。"""
    import time
    d = os.path.join(os.path.dirname(os.path.abspath(__file__)), "_flashvsr", "tmp_out")
    os.makedirs(d, exist_ok=True)
    # 用完即删：每次运行前清掉上一次留下的旧 mp4，避免越堆越多
    for name in os.listdir(d):
        if name.lower().endswith(".mp4"):
            try:
                os.remove(os.path.join(d, name))
            except Exception:
                pass
    return os.path.join(d, "FlashVSR_" + time.strftime("%Y%m%d_%H%M%S") + ".mp4")


def _padded_dims(w_in: int, h_in: int, multiple: int = 128):
    """模型输入放大 4 倍后，向上对齐到 128 的倍数（DiT/解码器的硬要求）。"""
    sw, sh = w_in * 4, h_in * 4
    tw = math.ceil(sw / multiple) * multiple
    th = math.ceil(sh / multiple) * multiple
    return sw, sh, tw, th, (tw - sw) // 2, (th - sh) // 2


# --------------------------------------------------------------------------- #
# 低清帧的惰性供给
# --------------------------------------------------------------------------- #
class LazyLQ:
    """管线要的「低清视频」是已双三次放大到输出尺寸、pad 到 128 倍数的张量。

    整段预生成太占内存，这里按管线的切片请求现算。管线只会做
    `x[:, :, a:b, :, :]` 再 `.to(device)`，所以只需实现 __getitem__。

    """

    def __init__(self, frames, n_total, sh, sw, th, tw, pad_top, pad_left, device, dtype):
        self.f = frames
        self.n_total = n_total
        self.sh, self.sw, self.th, self.tw = sh, sw, th, tw
        self.pad = (pad_left, tw - sw - pad_left, pad_top, th - sh - pad_top)
        self.device, self.dtype = device, dtype
        self.shape = (1, 3, n_total, th, tw)

    def __getitem__(self, idx):
        t = idx[2]
        a = t.start or 0
        b = min(t.stop if t.stop is not None else self.n_total, self.n_total)
        n0 = self.f.shape[0]
        ids = [min(i, n0 - 1) for i in range(a, b)]          # 尾部用最后一帧补
        x = torch.from_numpy(self.f[ids]).to(self.device).permute(0, 3, 1, 2).float().div_(255.0)
        x = F.interpolate(x, size=(self.sh, self.sw), mode="bicubic", align_corners=False)
        if any(self.pad):
            mode = "reflect" if min(self.sh, self.sw) >= max(self.pad) else "replicate"
            x = F.pad(x, self.pad, mode=mode)
        return x.permute(1, 0, 2, 3).unsqueeze(0).to(self.dtype).mul_(2.0).sub_(1.0)


# --------------------------------------------------------------------------- #
# 管线装配
# --------------------------------------------------------------------------- #
def _torch_load(path, **kw):
    try:
        return torch.load(path, weights_only=True, **kw)
    except Exception:
        return torch.load(path, weights_only=False, **kw)


def _weight_dir() -> str:
    d = os.path.join(folder_paths.models_dir, "FlashVSR")
    missing = [f for f in _REQUIRED if not os.path.exists(os.path.join(d, f))]
    if missing:
        raise RuntimeError(
            f"FlashVSR 权重缺失：{', '.join(missing)}\n"
            f"请放到 {d}\\ （官方 FlashVSR 插件用的也是这个目录，已有就不用管）"
        )
    return d


def _build_pipe(device: str, precision: str) -> FlashVSRTinyPipeline:
    """装配 tiny 管线。等价于官方 init_pipeline，但砍掉联网下载与 VAE 分支。"""
    d = _weight_dir()
    # torch 里没有 torch.bf16 / torch.fp16，只能按名字映射，写错会直接崩在这里
    store_dtype = {
        "fp8": getattr(torch, "float8_e4m3fn", None),
        "bf16": torch.bfloat16,
        "fp16": torch.float16,
    }[precision]
    # fp8 只能存不能算（addmm 不支持），计算一律 bf16
    calc_dtype = torch.bfloat16 if precision == "fp8" else store_dtype

    mm = ModelManager(torch_dtype=store_dtype, device="cpu")
    mm.load_models([os.path.join(d, "diffusion_pytorch_model_streaming_dmd.safetensors")])
    pipe = FlashVSRTinyPipeline.from_model_manager(mm, device=device)

    # TCDecoder 输入通道 = 16(latent) + 768(低清引导 pixel_shuffle 后 3*4*8*8)
    pipe.TCDecoder = build_tcdecoder(
        new_channels=[512, 256, 128, 128], device=device,
        dtype=calc_dtype, new_latent_channels=16 + 768)
    pipe.TCDecoder.load_state_dict(_torch_load(os.path.join(d, "TCDecoder.ckpt"), map_location="cpu"), strict=False)
    pipe.TCDecoder.clean_mem()

    pipe.torch_dtype = calc_dtype
    pipe.denoising_model().LQ_proj_in = Causal_LQ4x_Proj(
        in_dim=3, out_dim=1536, layer_num=1).to(device, dtype=calc_dtype)
    pipe.denoising_model().LQ_proj_in.load_state_dict(
        _torch_load(os.path.join(d, "LQ_proj_in.ckpt"), map_location="cpu"), strict=True)

    # fp8 时不能用 pipe.to(device, dtype)，会报 mat1/mat2 dtype 不一致
    pipe.to(device) if precision == "fp8" else pipe.to(device, dtype=calc_dtype)
    pipe.enable_vram_management(num_persistent_param_in_dit=None)
    pipe.init_cross_kv(prompt_path=_PROMPT)
    pipe.load_models_to_device(["dit", "vae"])
    pipe.offload_model()
    return pipe


def _get_pipe(device: str, precision: str) -> FlashVSRTinyPipeline:
    key = (precision, device)
    if key not in _PIPES:
        _PIPES[key] = _build_pipe(device, precision)
    return _PIPES[key]


def _set_cast_cache(enable: bool):
    """切换「权重常驻缓存」。关掉时要把已经缓存的 bf16 副本清掉，否则显存不让出来。"""
    enable = bool(enable)
    if layers.CACHE_CAST == enable:
        return
    layers.CACHE_CAST = enable
    if not enable:
        for pipe in _PIPES.values():
            for m in pipe.dit.modules():
                if hasattr(m, "cast_cache"):
                    m.cast_cache = None
        if torch.cuda.is_available():
            torch.cuda.empty_cache()


def unload_all():
    """把缓存里的管线权重挪回内存，把显存让给后面的节点。"""
    for pipe in _PIPES.values():
        try:
            pipe.offload_model()
        except Exception:
            pass
    if torch.cuda.is_available():
        torch.cuda.empty_cache()


# --------------------------------------------------------------------------- #
# 节点
# --------------------------------------------------------------------------- #
class BanZhangFlashVSR:
    """FlashVSR 扩散超分：低清图/视频 -> 高清。自包含，不依赖任何外部节点或程序。"""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "图像": ("IMAGE", {"tooltip": "低清图像序列（视频逐帧）。输出固定为一段 mp4，"
                                             "不再往 ComfyUI 交回图像；要接着处理请连「🎥 视频合并」。"}),
                "模型精度": (list(_PRECISION), {
                    "default": "fp8（省显存，推荐）",
                    "tooltip": "fp8 = 权重 fp8 存储 + bf16 计算，显存减半，16G 卡跑 1080p 靠它。"
                               "bf16 = 最快、动态范围最好（30/40/50 系）。fp16 = 老卡兜底。",
                }),
                "放大模式": (["按倍数", "目标尺寸", "兆像素"], {
                    "default": "按倍数",
                    "tooltip": "跟「H3 终极放大」一样：怎么定输出尺寸。\n"
                               "按倍数 = 输出 = 源图 × 倍数；目标尺寸 = 直接指定输出宽高；"
                               "兆像素 = 指定输出总像素数（按源图比例分配宽高）。\n"
                               "⚠ 这是「目标」不是「上限」：源图再小也会放大到你定的尺寸，"
                               "源图比目标大则会缩小。",
                }),
                "放大倍数": ("FLOAT", {
                    "default": 2.0, "min": 1.0, "max": 16.0, "step": 0.05,
                    "tooltip": "仅「按倍数」模式生效。输出 = 源图 × 倍数。"
                               "1.0 = 不放大（输出跟源图一样大）。FlashVSR 是超分节点，"
                               "低清源常见要 4 倍以上。",
                }),
                "目标宽度": ("INT", {
                    "default": 1920, "min": 64, "max": 8192, "step": 8,
                    "tooltip": "仅「目标尺寸」模式生效。想要的输出宽度。"
                               "会保持源图宽高比，宽高比与源图不一致时实际尺寸会略有出入。",
                }),
                "目标高度": ("INT", {
                    "default": 1080, "min": 64, "max": 8192, "step": 8,
                    "tooltip": "仅「目标尺寸」模式生效。想要的输出高度。",
                }),
                "兆像素": ("FLOAT", {
                    "default": 2.0, "min": 0.1, "max": 32.0, "step": 0.1,
                    "tooltip": "仅「兆像素」模式生效。输出总像素数（百万像素），按源图宽高比分配。"
                               "1080p ≈ 2.0，4K ≈ 8.3。",
                }),
            },
            "optional": {
                "速度档位": (list(_SPEED), {
                    "default": "标准（推荐）",
                    "tooltip": "稀疏注意力「每个画面块参考多宽的范围」。标准 = 原版写死的值，与改动前一致。"
                               "调快 = 算得更少、更快，代价是细节和高落差边缘可能变糊。"
                               "分辨率越高，档位之间的速度差越明显。",
                }),
                "色彩校正": (["wavelet（推荐）", "adain", "关闭"], {
                    "default": "wavelet（推荐）",
                    "tooltip": "wavelet = 按局部低频对齐颜色，肤色和原图一致。"
                               "adain = 只对齐全局均值方差，容易偏粉。关闭 = 不做校正。",
                }),
                "KV缓存int8": ("BOOLEAN", {
                    "default": True,
                    "tooltip": "流式 KV 缓存量化成 int8，显存减半，误差与 SageAttention 自身的量化同量级。开启。",
                }),
                "帧率": ("INT", {
                    "default": 30, "min": 1, "max": 240, "step": 1,
                    "tooltip": "输出 mp4 的帧率，设成源视频的帧率（VHS 加载节点的 force_rate）。",
                }),
                "解码方式": (_DECODE, {
                    "default": "自动（推荐）",
                    "tooltip": "自动 = 按当时空闲显存决定切不切、切多大（推荐，画质与不分块一致）。"
                               "不分块 = 强制整幅解码，最快、最吃显存。"
                               "分块 = 强制用最小的保守瓦片，最省显存但明显更慢。",
                }),
                "权重常驻缓存": ("BOOLEAN", {
                    "default": False,
                    "tooltip": "fp8 精度下：权重转换结果只做一次并留在显存，省掉每个窗口重复转换。画质不变，"
                               "但实测只快 1~2%，代价是多占 2.3G 显存，所以默认关。"
                               "窗口特别多（长视频）时可以试试。bf16/fp16 下无效果。",
                }),
                "跑完卸载模型": ("BOOLEAN", {
                    "default": True,
                    "tooltip": "跑完把权重挪回内存，给后面的节点让显存。连续处理多条时会慢一点（来回搬）。",
                }),
                "种子": ("INT", {"default": 0, "min": 0, "max": 0xFFFFFFFFFFFFFFFF,
                                "tooltip": "初始噪声种子。单步蒸馏模型，影响很小。"}),
                "音频": ("AUDIO", {
                    "tooltip": "可选：原片声音（VHS 加载节点的「音频」输出）。给了就 mux 进 mp4，"
                               "不给就是无声视频。",
                }),
            },
        }

    # 纯视频输出：只有「视频」一个口（VIDEO 类型，可直连「🎥 视频合并」的「🎬 视频文件」）
    RETURN_TYPES = ("VIDEO",)
    RETURN_NAMES = ("视频",)
    FUNCTION = "upscale"
    CATEGORY = "👨‍🏫班长/FlashVSR"

    def upscale(self, 图像, 模型精度, 放大模式, 放大倍数, 目标宽度, 目标高度, 兆像素,
                速度档位="标准（推荐）", 色彩校正="wavelet（推荐）", KV缓存int8=True,
                解码方式="自动（推荐）", 权重常驻缓存=False,
                跑完卸载模型=True, 种子=0, 帧率=30, 音频=None):
        device = comfy.model_management.get_torch_device()
        precision = _PRECISION[模型精度]
        topk_scale = _SPEED[速度档位]
        size = (_SIZE_MODE[放大模式], 放大倍数, 目标宽度, 目标高度, 兆像素)

        # 色彩校正：管线内部从环境变量读，这里临时设、跑完还原，不污染全局
        if 色彩校正 == "关闭":
            out = self._run(图像, size, precision, device, False,
                            KV缓存int8, 解码方式, topk_scale, 权重常驻缓存, 种子,
                            帧率, 音频)
        else:
            old = os.environ.get("FV_COLOR_FIX")
            os.environ["FV_COLOR_FIX"] = "wavelet" if 色彩校正.startswith("wavelet") else "adain"
            try:
                out = self._run(图像, size, precision, device, True,
                                KV缓存int8, 解码方式, topk_scale, 权重常驻缓存, 种子,
                                帧率, 音频)
            finally:
                if old is None:
                    os.environ.pop("FV_COLOR_FIX", None)
                else:
                    os.environ["FV_COLOR_FIX"] = old

        if 跑完卸载模型:
            unload_all()
        return out

    # ------------------------------------------------------------------ #
    def _run(self, image, size, precision, device, color_fix, kv_int8, decode_mode,
             topk_scale, cast_cache, seed, fps=30, audio=None):
        n0, h0, w0 = image.shape[0], image.shape[1], image.shape[2]

        w_in, h_in, out_w, out_h = plan_size(w0, h0, *size)
        sw, sh, tw, th, pad_left, pad_top = _padded_dims(w_in, h_in)

        n_total = max(_largest_8n1_leq(_next_8n5(n0) + 4), _MIN_FRAMES)

        # 缩到模型输入尺寸，转 uint8 常驻 CPU（0.4MB/帧，比 float 省 4 倍）
        x = image.permute(0, 3, 1, 2).to(dtype=torch.float32)
        x = F.interpolate(x, size=(h_in, w_in), mode="bicubic", align_corners=False)
        # ComfyUI 的 IMAGE 是 [0,1] 浮点，落盘成 uint8 前必须还原到 [0,255]，
        # 否则整张图被压成近乎纯黑喂进模型，输出全黑
        frames = x.permute(0, 2, 3, 1).mul_(255.0).round_().clamp_(0, 255).to(torch.uint8).cpu().numpy()

        wan_video_dit._KV_INT8 = bool(kv_int8)
        _set_cast_cache(cast_cache)
        pipe = _get_pipe(str(device), precision)

        # 解码瓦片：自动档由管线在模型搬上显卡之后再决定（那时空闲显存才是真实的）
        tiled = decode_mode != "不分块（最快）"
        auto = decode_mode == "自动（推荐）"
        tile_size = None if auto else (60, 104)
        tile_stride = None if auto else (30, 52)

        lq = LazyLQ(frames, n_total, sh, sw, th, tw, pad_top, pad_left, device, pipe.torch_dtype)
        pbar = comfy.utils.ProgressBar(n0)

        def should_stop() -> bool:
            try:
                comfy.model_management.throw_exception_if_processing_interrupted()
            except Exception:
                return True
            return False

        def call(on_frames):
            pipe(
                prompt="", negative_prompt="", cfg_scale=1.0, num_inference_steps=1,
                seed=seed, tiled=tiled,
                tile_size=tile_size, tile_stride=tile_stride,
                progress_bar_cmd=lambda it, **k: it,
                LQ_video=lq, num_frames=n_total, height=th, width=tw,
                is_full_block=False, if_buffer=True,
                topk_ratio=topk_scale * 768 * 1280 / (th * tw), kv_ratio=1.0,
                local_range=11, color_fix=bool(color_fix),
                unload_dit=False, force_offload=False,
                on_frames=on_frames, should_stop=should_stop,
            )

        # ------------------------------------------------------------------ #
        # 直写视频（唯一输出）。不攒全量结果，边算边喂 ffmpeg（NVENC 硬编码），内存 O(1)
        # ------------------------------------------------------------------ #
        out_path = _auto_mp4_path()
        writer = Mp4Writer(out_path, sw, sh, fps=fps, audio=audio, n_frames=n0)
        got_frame = False
        written = 0

        def on_frames(cur):
            """(3,T,th,tw) CPU [-1,1] -> uint8 -> 喂进 ffmpeg 管道。"""
            nonlocal written, got_frame
            if written >= n0:
                return
            out = cur[:, :, pad_top:pad_top + sh, pad_left:pad_left + sw]
            out = out.permute(1, 2, 3, 0).float().add_(1.0).mul_(127.5).round_().clamp_(0, 255).to(torch.uint8)
            k = min(out.shape[0], n0 - written)
            if k <= 0:
                return
            got_frame = True
            writer.write_rgb(out[:k].contiguous().numpy().tobytes())
            written += k
            pbar.update(written)

        try:
            call(on_frames)
        except PipelineCancelled:
            writer.abort()
            raise comfy.model_management.InterruptProcessingException()
        except Exception:
            writer.abort()
            raise
        writer.finish()

        if not got_frame:
            raise RuntimeError(f"FlashVSR 没产出任何帧（输入 {n0} 帧，需要至少 1 帧）")
        print(f"[FlashVSR] 已写出 {out_path}（{written} 帧 {sw}x{sh}）", flush=True)
        # 唯一输出口：mp4 路径（VIDEO 类型，可直连「🎥 视频合并」的「🎬 视频文件」）
        return (out_path,)


NODE_CLASS_MAPPINGS = {
    "BanZhangFlashVSR": BanZhangFlashVSR,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "BanZhangFlashVSR": "👨‍🏫 班长 FlashVSR 扩散超分",
}
