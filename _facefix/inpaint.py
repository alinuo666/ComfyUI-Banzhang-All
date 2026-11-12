# -*- coding: utf-8 -*-
"""掩码驱动的 H3 局部重绘。

两件事：
  1) 软掩码 → H3 NestedTensor noise_mask（video 掩码 + audio 零）
  2) 节点内跑一次局部采样，把脸区重绘掉 —— 混合由采样器自己做
     （comfy/samplers.py KSamplerX0Inpaint：out*mask + 原latent*(1-mask)）

不对模型打任何补丁：H3 官方的 scale_latent_inpaint（comfy/model_base.py
MiniMaxH3）已经做了「保留区按 VISUAL_COND_TIMESTEP 注入 + token 网格对齐混合」，
在这里再叠一层只会把它搅脏。旧版那层 "重噪到当前 sigma" 还依赖
model_sampling.noise_scaling —— 该方法在 ModelSamplingAV 上并不存在（只有旧采样类
EPS/CONST 才有），挂上必抛 AttributeError。
"""

import torch


def attach_noise_mask(h3_latent, noise_mask):
    """返回带 noise_mask 的 latent 副本，不修改原 dict。"""
    out = dict(h3_latent)
    out["noise_mask"] = noise_mask
    return out


def sample_inpaint(model, positive, latent, denoise_mask, steps=6, denoise=0.6,
                   sampler_name="euler", scheduler="simple", seed=0):
    """在节点内对脸区做一次局部重绘，返回新的 latent dict。

    只重绘 denoise_mask>0 的区域：采样器内部的 KSamplerX0Inpaint 每步都把
    输出与原 latent 按掩码混合，保留区（含音频整段）原样穿过。
    走官方 CFGGuider，sigmas 由「步数 + 降噪强度」推，与工作流的三采参数无关。
    """
    import comfy.samplers
    import comfy.sample
    import comfy.nested_tensor as nt
    import comfy.model_management as mg

    device = mg.get_torch_device()
    samples = latent["samples"]
    # 统一成 float32 再打包：采样器内部按 float32 计算，混 bf16 会让 pack 后的
    # 拼接张量升/降位不一致，H3 forward 对 dtype 很挑
    if getattr(samples, "is_nested", False):
        # H3 联合 AV latent：视频 + 音频两条流
        members = [m.to(device=device, dtype=torch.float32)
                   for m in samples.unbind()]
    else:
        # 普通视频 latent（脸块画布），单流
        members = [samples.to(device=device, dtype=torch.float32)]
    latent_nested = nt.NestedTensor(tuple(members))

    # 视频/音频各自造同形状噪声；prepare_noise 走 CPU 的 randn，再搬设备
    noises = [comfy.sample.prepare_noise(m, int(seed)).to(device) for m in members]
    noise_nested = nt.NestedTensor(tuple(noises))

    dm = denoise_mask
    if getattr(dm, "is_nested", False):
        dm = nt.NestedTensor(tuple(t.to(device) for t in dm.unbind()))
    elif dm is not None:
        dm = dm.to(device)

    steps = max(1, int(steps))
    dn = min(0.999, max(0.01, float(denoise)))
    # 采样总步数按降噪比例放大，再截取尾部 steps+1 个 sigma —— 等价于从 dn 起采样
    total = max(steps, int(round(steps / dn)))
    sigmas = comfy.samplers.calculate_sigmas(
        model.get_model_object("model_sampling"), scheduler, total).cpu()
    sigmas = sigmas[-(steps + 1):]

    guider = comfy.samplers.CFGGuider(model)
    guider.inner_set_conds({"positive": positive})
    out = guider.sample(noise_nested, latent_nested,
                        comfy.samplers.sampler_object(sampler_name), sigmas,
                        denoise_mask=dm, seed=int(seed))
    return {"samples": out}
