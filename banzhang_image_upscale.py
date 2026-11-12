# -*- coding: utf-8 -*-
"""图片高清放大（二采重绘）节点：一采图 → 像素空间放大 → VAE 编码回潜空间。

专做二采的两件准备工作（采样本身交给下游官方 K 采样器）：
  · 「放大模型」下拉：⚡ 开头 = 免模型插值档（快、省显存）；其余自动扫描
    models/upscale_models 里的放大模型（ESRGAN 类神经网络放大，细节更好），
    模型放大走官方 ImageUpscaleWithModel（OOM 自动降瓦片），输出尺寸再对齐
    到目标尺寸；
  · 编码支持分块（vae.encode_tiled），大图编码不爆显存。

尺寸模式与「H3 终极放大参数」一致：按倍数 / 目标尺寸 / 兆像素；
相对原图只能放大不能缩小；结果按 VAE 的**实际**空间下采倍数对齐
（Qwen-Image 是 16，SD 系是 8）—— 写死 8 会让 Qwen 多出来的边被 VAE 悄悄吃掉。
显存压力大时：模型线接「🖼️ 图片多级渐进补丁」（渐进省显存）或调低放大倍率。

⚠ 端口名与函数签名必须逐字一致（ComfyUI 按端口名传关键字参数），
  且签名带 **_extra 兜底，防止旧版工作流残留的参数把执行炸掉。
"""

import logging

import comfy.utils
import folder_paths
from comfy_extras import nodes_upscale_model

_TAG = "🖼️ 图片高清放大"

# ⚡ 免模型插值档（与 H3 终极放大参数同口径 + 图片常用的 lanczos/bicubic/bilinear）
# 已下线 area（区域平均）：common_upscale 除 lanczos/bislerp 外都走
# torch.nn.functional.interpolate(mode=...)，而 area 模式在能整除时会退化——
# 实测 2x/3x/4x 放大逐位等同 nearest（纯马赛克），0.5x 缩小逐位等同 bilinear，
# 只有非整数倍才独立，而独立时 PSNR/SSIM 依然垫底。留着只会误导，故移除。
# 评测见 _bench_interp.py（与真实高清图比 PSNR/SSIM，非「放大再缩回」的伪指标）。
_INTERP = ("lanczos", "bicubic", "bilinear", "nearest-exact", "nearest")
_INTERP_ZH = {"lanczos": "lanczos", "bicubic": "bicubic", "bilinear": "bilinear",
              "nearest-exact": "最近邻精确", "nearest": "最近邻"}
_INTERP_PREFIX = "⚡ 插值-"
# ⚡ 档名 → common_upscale 插值方式
_METHOD_MAP = {f"{_INTERP_PREFIX}{_INTERP_ZH[m]}": m for m in _INTERP}
# 已下线档 → 替代档。老工作流保存的值不在下拉里了，但依然会原样传进来，
# 不兜底就会掉进模型分支被当成模型文件名去 load_model()，直接崩节点。
_RETIRED_METHODS = {f"{_INTERP_PREFIX}区域平均": "lanczos"}
# 编码分块瓦片边长（关 = 整幅一次编码）
_TILES = ("关", "1024", "1536", "2048")
_TILE_OVERLAP = 64

# 官方模型放大链（无状态，实例化一次；ImageUpscaleWithModel 自带 OOM 降瓦片重试）
_MODEL_LOADER = nodes_upscale_model.UpscaleModelLoader()
_MODEL_UPSCALER = nodes_upscale_model.ImageUpscaleWithModel()
# 模型档输出与目标尺寸有出入时的补足/回缩插值
_ALIGN_METHOD = "lanczos"


def _scan_upscale_models():
    """扫 models/upscale_models，失败返回空表（不影响 ⚡ 档使用）。"""
    try:
        return folder_paths.get_filename_list("upscale_models") or []
    except Exception:
        return []


def _spatial_downscale(VAE):
    """VAE 的空间下采倍数。

    VAE 的 downscale_ratio 有两种形态：纯 int，或 (公式, 高倍数, 宽倍数) 三元组，
    必须分开取，不能一律当整数用。取不到就回落 8（SD 系的通用值）。
    """
    ratio = getattr(VAE, "downscale_ratio", None)
    if isinstance(ratio, (tuple, list)):
        ratio = ratio[1] if len(ratio) > 1 else None
    try:
        v = int(ratio)
    except (TypeError, ValueError):
        return 8
    return v if v > 0 else 8


def _target_size(mode, scale, tw, th, mp, h0, w0, align=8):
    """按三种模式算目标尺寸，结果对齐 align、下限 64，且相对原图只放大不缩小。

    align 用 VAE 的**实际**空间下采倍数（Qwen 16 / SD 8），不能写死 8。
    返回 (target_h, target_w)。
    """
    if mode == "按倍数":
        s = max(1.0, float(scale))
        nw, nh = round(w0 * s), round(h0 * s)
    elif mode == "目标尺寸":
        nw, nh = int(tw), int(th)
    elif mode == "兆像素":
        px = max(1, h0 * w0)
        s = max(1.0, (float(mp) * 1000.0 * 1000.0 / px) ** 0.5)
        nw, nh = round(w0 * s), round(h0 * s)
    else:
        raise ValueError(f"{_TAG}：未知放大模式「{mode}」")
    # 按 VAE 实际下采倍数对齐，下限 64，避免尺寸除不尽被 VAE 静默截断
    nh = max(64, round(nh / align) * align)
    nw = max(64, round(nw / align) * align)
    return nh, nw


def _scale_image(img, target_h, target_w, method):
    """IMAGE (B,H,W,C) → common_upscale → (B,H',W',C)。"""
    x = img.movedim(-1, 1)
    x = comfy.utils.common_upscale(x, target_w, target_h, method, "disabled")
    return x.movedim(1, -1)


def _resolve_method(放大模型):
    """判定「放大模型」是插值档还是模型档。

    返回 (method, desc)；不是插值档时返回 (None, None)，交给模型链处理。
    关键是第二种情况：以 ⚡ 插值- 开头却不在 _METHOD_MAP 里 = 老工作流残留的
    已下线档（如「区域平均」）。这种值必须在这里拦掉并回退，
    否则会掉进 else 分支被当成模型文件名去 load_model()，直接崩节点。
    """
    m = _METHOD_MAP.get(放大模型)
    if m is not None:
        return m, f"插值 {m}"
    if isinstance(放大模型, str) and 放大模型.startswith(_INTERP_PREFIX):
        fallback = _RETIRED_METHODS.get(放大模型, "lanczos")
        logging.warning("[%s] 插值档「%s」已下线，自动改用 %s（请在节点上重新选一次）",
                       _TAG, 放大模型, fallback)
        return fallback, f"插值 {fallback}（已下线档回退）"
    return None, None


class BanZhang_ImageHiResUpscale:
    """放大一采图并编码回潜空间，输出接官方 K 采样器做二采高清重绘。"""

    DESCRIPTION = (
        "图片版「终极放大」的准备工作：把一采图放大 → VAE 编码回潜空间，\n"
        "输出接官方 K 采样器做二采高清重绘（重绘幅度在 KSampler 上调，建议 0.35~0.5）。\n"
        "「放大模型」下拉：⚡ 开头 = 免模型插值档；其余自动扫描 models/upscale_models\n"
        "（放进新模型后刷新节点即可出现）。尺寸模式三选一，只能放大不能缩小；\n"
        "输出尺寸按 VAE 实际下采倍数对齐（Qwen 是 16 的倍数），不会多出被 VAE 吃掉的边。\n"
        "大图编码爆显存时开「编码分块」；想渐进省显存，模型线另接「🖼️ 图片多级渐进补丁」。"
    )

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "图片": ("IMAGE", {
                    "tooltip": "一采输出的图片（VAE 解码后的 RGB）。"}),
                "VAE": ("VAE", {
                    "tooltip": "把放大后的图编码回潜空间，二采 K 采样器只吃潜空间，必须接。"}),
                "放大模型": (tuple(_METHOD_MAP) + tuple(_scan_upscale_models()), {
                    "default": f"{_INTERP_PREFIX}lanczos",
                    "tooltip": "⚡ 开头 = 免模型插值档（纯数学拉伸，快、省显存）：\n"
                               "lanczos 画质第一（推荐，实测 PSNR 38.06 / SSIM 0.9773）；\n"
                               "bicubic 画质几乎持平、快 4 倍、振铃最少；bilinear 会发糊；\n"
                               "最近邻精确 / 最近邻 出马赛克，只适合像素画或掩膜，别用在照片上。\n"
                               "其余 = models/upscale_models 里的放大模型（神经网络放大，细节更好、\n"
                               "更慢更吃显存，OOM 自动降瓦片）。放入新模型后刷新节点即可出现。"}),
                "放大模式": (["按倍数", "目标尺寸", "兆像素"], {
                    "default": "按倍数",
                    "tooltip": "目标尺寸计算方式：按倍数 / 目标尺寸 / 兆像素。"}),
                "放大倍数": ("FLOAT", {
                    "default": 2.0, "min": 1.0, "max": 4.0, "step": 0.05,
                    "tooltip": "仅「按倍数」模式生效。下限 1.0 = 只能放大不能缩小。"}),
                "目标宽度": ("INT", {
                    "default": 2048, "min": 64, "max": 8192, "step": 16,
                    "tooltip": "仅「目标尺寸」模式生效（自动按 VAE 下采倍数对齐，Qwen 是 16 的倍数）。"}),
                "目标高度": ("INT", {
                    "default": 2048, "min": 64, "max": 8192, "step": 16,
                    "tooltip": "仅「目标尺寸」模式生效（自动按 VAE 下采倍数对齐，Qwen 是 16 的倍数）。"}),
                "兆像素": ("FLOAT", {
                    "default": 2.0, "min": 0.1, "max": 16.0, "step": 0.1,
                    "tooltip": "仅「兆像素」模式生效：等比放大到目标总像素，只放大不缩小。"}),
            },
            "optional": {
                "编码分块": (_TILES, {
                    "default": "关",
                    "tooltip": "VAE 编码的瓦片边长。关 = 整幅一次编码（最快）；\n"
                               "放大到 2K 以上爆显存时选 1024 / 1536 / 2048 分块编码。"}),
            },
        }

    RETURN_TYPES = ("LATENT", "IMAGE")
    RETURN_NAMES = ("潜空间", "放大图")
    FUNCTION = "upscale"
    CATEGORY = "👨‍🏫班长/MiniMax H3"

    # 注意：参数名与顺序必须与 INPUT_TYPES 端口逐字一致（含大小写），ComfyUI 按名传参；
    # **_extra 兜底吞掉旧版工作流残留的参数（如已删除的「模型」「渐进分段步数」）。
    def upscale(self, 图片, VAE, 放大模型, 放大模式, 放大倍数, 目标宽度, 目标高度,
                兆像素, 编码分块="关", **_extra):
        h0, w0 = int(图片.shape[1]), int(图片.shape[2])
        align = _spatial_downscale(VAE)
        th, tw = _target_size(放大模式, 放大倍数, 目标宽度, 目标高度, 兆像素, h0, w0, align)

        method, method_desc = _resolve_method(放大模型)
        if method is not None:
            scaled = _scale_image(图片, th, tw, method)
        else:
            # 模型档：官方链放大（OOM 自动降瓦片）→ 输出尺寸对齐到目标
            (up_model,) = _MODEL_LOADER.load_model(放大模型)
            # 官方 execute 的形参顺序是 (upscale_model, image)：模型在前、图片在后。
            # 写反了会拿图片当模型用，直接报 'Tensor' object has no attribute 'patcher'。
            (scaled,) = _MODEL_UPSCALER.upscale(up_model, 图片)
            bh, bw = int(scaled.shape[1]), int(scaled.shape[2])
            if (bh, bw) != (th, tw):
                scaled = _scale_image(scaled, th, tw, _ALIGN_METHOD)
            method_desc = f"模型 {放大模型}"

        pixels = scaled[:, :, :, :3]
        if 编码分块 != "关":
            tile = int(编码分块)
            samples = VAE.encode_tiled(pixels, tile, tile, _TILE_OVERLAP)
        else:
            samples = VAE.encode(pixels)

        logging.info("[%s] %dx%d → %dx%d（%s ｜ %s）｜ 对齐 %d 的倍数 ｜ 编码分块=%s",
                     _TAG, w0, h0, tw, th, 放大模式, method_desc, align, 编码分块)
        return ({"samples": samples}, scaled)


NODE_CLASS_MAPPINGS = {"BanZhang_ImageHiResUpscale": BanZhang_ImageHiResUpscale}
NODE_DISPLAY_NAME_MAPPINGS = {"BanZhang_ImageHiResUpscale": "🖼️ 图片高清放大（二采重绘）"}
