# -*- coding: utf-8 -*-
"""
🎓 自定义 Sigma 曲线 (BanZhang_SigmaCurve)
================================================================================
节点只存一条「归一化曲线」（每步的剩余噪声比例，1.0 = 满噪声，0.0 = 完全去噪），
曲线由前端 js/banzhang_sigmas_custom.js 可视化编辑（拖拽 / 加步 / 删步 / 预设）。

后端职责：
    1. 解析曲线数据（JSON 数组，容错支持「空格 / 逗号分隔的数字」）
    2. 接可选 MODEL，用该模型自身的 sigma_max / sigma_min 把曲线换算成真实 sigma 序列
       ——流匹配模型（H3 / FLUX / Qwen-Image / LTX）上限是 1.0，SD1.5 / SDXL 是 14.61，
         连续 EDM 是 120，同一条曲线在不同模型上都会落进各自的合法值域
       ——不接 MODEL 时按流匹配值域（0.001 → 1.0）兜底
    3. 输出 SIGMAS（可直连内置 KSampler 的 sigmas 口）+ 步数 INT
================================================================================
"""

import json

import torch

# 内置曲线（Karras ρ=7 / 12 步）在线性归一化空间的结果，作为新节点的默认曲线
DEFAULT_CURVE = [1.0, 0.703, 0.485, 0.327, 0.216, 0.138, 0.085,
                 0.051, 0.029, 0.015, 0.007, 0.002, 0.0]

# 无 MODEL 兜底时的 sigma 值域（流匹配模型：H3 / FLUX / Qwen-Image / LTX 等，上限 1.0）
FALLBACK_SIGMA_MAX = 1.0
FALLBACK_SIGMA_MIN = 0.001


def _parse_curve(raw):
    """把曲线数据解析成 [0,1] 的浮点列表"""
    vals = None
    if isinstance(raw, (list, tuple)):
        vals = list(raw)
    else:
        text = (raw or "").strip()
        if text.startswith("["):
            try:
                vals = json.loads(text)
            except Exception:
                vals = None
        if vals is None:
            vals = text.replace(",", " ").split()
    if not vals:
        raise ValueError("[Sigma曲线] 曲线数据为空，请在节点里点「编辑曲线」画一条")

    out = []
    for v in vals:
        try:
            f = float(v)
        except Exception:
            continue
        out.append(min(1.0, max(0.0, f)))
    if len(out) < 2:
        raise ValueError("[Sigma曲线] 曲线至少需要 2 个点（当前 %d 个）" % len(out))
    return out


class BanZhang_SigmaCurve:
    """🎓 自定义 Sigma 曲线：可视化画一条每步的噪声曲线，输出 SIGMAS"""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "曲线数据": ("STRING", {"multiline": False,
                                        "default": json.dumps(DEFAULT_CURVE)}),
                "末尾补零": ("BOOLEAN", {"default": True}),
            },
            "optional": {
                "model": ("MODEL",),
            },
        }

    RETURN_TYPES = ("SIGMAS", "INT")
    RETURN_NAMES = ("SIGMAS", "步数")
    FUNCTION = "build"
    CATEGORY = "👨‍🏫班长/采样"

    def build(self, 曲线数据, 末尾补零, model=None):
        curve = _parse_curve(曲线数据)

        model_sampling = None
        if model is not None:
            try:
                model_sampling = model.get_model_object("model_sampling")
            except Exception:
                model_sampling = None

        sigmas = [_sigma_at(t, model_sampling) for t in curve]
        if 末尾补零:
            # 不管曲线末点画在哪，最后一步都归 0（完全去噪）；关掉则尊重末点（用于局部去噪）
            sigmas[-1] = 0.0
        # ComfyUI 约定：sigmas 长度为 步数+1（末位为终止值）
        return (torch.tensor(sigmas, dtype=torch.float32), len(curve) - 1)


def _sigma_at(t, model_sampling):
    """归一化噪声强度 t(1→0) 线性映射到真实 sigma

    sigma = sigma_min + t * (sigma_max - sigma_min)
    线性映射保证所见即所得：编辑器里画的曲线形状 = Sigmas 预览看到的形状。
    接了 MODEL 就用该模型自身的值域（H3/FLUX 等流匹配为 0.001→1.0，
    SD1.5/SDXL 为 0.029→14.61），不接则按流匹配值域兜底。
    """
    smax, smin = FALLBACK_SIGMA_MAX, FALLBACK_SIGMA_MIN
    if model_sampling is not None:
        try:
            smax = float(model_sampling.sigma_max)
            smin = float(model_sampling.sigma_min)
        except Exception:
            smax, smin = FALLBACK_SIGMA_MAX, FALLBACK_SIGMA_MIN
    if smin <= 0 or smax <= smin:
        smax, smin = FALLBACK_SIGMA_MAX, FALLBACK_SIGMA_MIN
    return smin + t * (smax - smin)


NODE_CLASS_MAPPINGS = {
    "BanZhang_SigmaCurve": BanZhang_SigmaCurve,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "BanZhang_SigmaCurve": "🎓 自定义 Sigma 曲线",
}
