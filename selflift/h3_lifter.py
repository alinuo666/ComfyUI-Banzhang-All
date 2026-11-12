# -*- coding: utf-8 -*-
"""MiniMax H3 学习式 latent 提升器 —— SelfLift 的 direct lift 通路。

为什么需要它：SelfLift 从低分辨率过渡到满分辨率时，"直接提升"（direct lift）
的默认实现是最近邻插值。原版 comfyui-SelfLift 在 H3 上把这条通路换成
LBH-123-AI 的 Minimax_h3_latent_Upscaler —— 一个在 H3 latent 空间里训练的 3D
Resizer，保真度远高于最近邻（原项目 README 的诊断结论：最近邻路线存在
"widespread artifacts"，H3 的实用默认就是"学习式放大 + rho=0"）。

本模块只做一件事：把插件里已有的网络与加载逻辑
（banzhang_h3_latent_upscaler_3d）包装成 SelfLift 需要的
``(z, (H, W)) -> z`` 闭包，不重复实现任何网络结构。

关于归一化：放大模型是在 (latent - mean) / std 空间里训练的，进出各一次即可，
与原节点的 _run_model_seg 完全同口径。
"""

import torch

import comfy.model_management

_NONE = "none"


def _module():
    # 延迟导入：这个模块定义了整套 3D 网络，不必在 SelfLift 节点注册时就拉起来
    from .. import banzhang_h3_latent_upscaler_3d as up
    return up


def list_models():
    """下拉框取值：latent_upscale_models 目录里的模型名；没有时只剩占位文案。"""
    try:
        names = [n for n in _module().scan_models() if not n.startswith("（")]
    except Exception:
        names = []
    return names if names else ["（未找到放大模型，请放入 latent_upscale_models 目录）"]


def default_model():
    """默认选中第一个文件名含 h3 的模型，与原版 _upscaler_input 口径一致。"""
    names = list_models()
    for name in names:
        if "h3" in name.lower():
            return name
    return names[0] if names else _NONE


def make_lifter(name, unload=True):
    """返回 ``(z, (H, W)) -> z`` 的提升闭包；未选模型时返回 None。

    ``z`` 是 [B, C, T, h, w] 的低分辨率视频 latent（H3 的 scale_factor 为 1.0，
    VAE 空间与模型空间重合）。返回 float32 的 [B, C, T, H, W]。
    不指定任何精度：模型用什么 dtype 存的，就按什么精度加载和运算，
    归一化张量也跟随模型 dtype。换模型 = 自动跟随那个模型文件的原生精度。
    """
    if not name or name == _NONE or name.startswith("（"):
        return None

    def lift(z, out_hw):
        up = _module()
        H, W = out_hw
        dev = z.device
        cuda = dev.type == "cuda"
        # precision=None → load_model 直接用模型文件权重的原生 dtype
        model = up.load_model(name, dev, None)
        try:
            dtype = next(model.parameters()).dtype
            norm_mean, norm_std = up._make_norm_tensors(dev, dtype)
            t = z.shape[2]
            with torch.inference_mode():
                s = (z.to(device=dev, dtype=dtype) - norm_mean) / norm_std
                out = model(s, scale=H / z.shape[-2],
                            target_size=(t, H, W), enable_chunking=True)
                out = out * norm_std + norm_mean
            return out.to(device=dev, dtype=torch.float32)
        finally:
            if unload and cuda:
                # 满分辨率阶段要重录显存图，放大模型留着只会挤预算
                model.to("cpu")
                comfy.model_management.soft_empty_cache()

    # 交给调用方：是否需要"用完即焚"（最后一次提升后彻底丢弃，见 release）
    lift.unload = bool(unload)
    return lift


def release():
    """彻底丢弃放大模型：清空模块级缓存（内存 + 显存一并释放）。

    与 lift 里的 unload 不同：unload 只是把模型从显卡搬回内存并缓存住，供下一级
    提升复用（省读盘）；release 是把缓存整个清掉——单级只有一次提升、多级到最后
    一次提升之后，都不再需要这个模型，留着白占内存。
    """
    try:
        up = _module()
    except Exception:
        return
    up.clear_model_cache()
