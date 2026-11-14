# -*- coding: utf-8 -*-
"""班长 MiniMax H3 预览覆盖 — 小型 VAE 解码器加载器。

移植自 ComfyUI-KJNodes 的 nodes/tiny_vae.py（MIT, © kijai）。ComfyUI 核心的
comfy.sd.VAE 无法构建 H3 用的小型解码器：TAEHV 的 patch_size 由通道数推导，
对 H3 的 24 通道没有对应条目；扁平 TAESD 式解码器（如 MiniMax-H3-TAE）核心
根本识别不出。这里按 checkpoint 自身结构重建（索引式键名 → 模块序列）。
"""

import logging

import torch
import torch.nn as nn

import comfy.model_management
import comfy.utils
from comfy.taesd.taesd import Block, Clamp, conv


def build_tae_decoder(sd):
    by_index = {}
    for k, v in sd.items():
        head, _, rest = k.partition(".")
        if not head.isdigit():
            raise ValueError(f"not a flat TAE decoder state dict (unexpected key '{k}')")
        by_index.setdefault(int(head), {})[rest] = v

    modules = []
    for i in range(max(by_index) + 1):
        entry = by_index.get(i)
        if entry is None:
            # 0 = 输入 Clamp，2 = 输入卷积后的 ReLU，其余为上采样
            modules.append(Clamp() if i == 0 else nn.ReLU() if i == 2 else nn.Upsample(scale_factor=2))
        elif "conv.0.weight" in entry:
            w = entry["conv.0.weight"]
            if "pool.0.weight" in entry:
                modules.append(Block(w.shape[1], w.shape[0], use_midblock_gn=True))
            else:
                modules.append(Block(w.shape[1], w.shape[0]))
        elif "weight" in entry:
            w = entry["weight"]
            modules.append(conv(w.shape[1], w.shape[0], bias="bias" in entry))
        else:
            raise ValueError(f"unrecognized TAE decoder module at index {i}: {sorted(entry)}")
    return nn.Sequential(*modules)


def _place(model, device, dtype):
    model = model.eval().to(device=device, dtype=dtype)
    if torch.device(device).type == "cuda":
        model.to(memory_format=torch.channels_last)
    return model


class TinyVAEDecoder:
    """扁平 TAESD 式解码器（如 MiniMax-H3-TAE.safetensors）。"""

    def __init__(self, sd, device=None, dtype=None):
        prefix = ""
        first = next(iter(sd))
        if not first.split(".")[0].isdigit():
            prefix = first.split(".")[0] + "."
            sd = {k[len(prefix):]: v for k, v in sd.items() if k.startswith(prefix)}

        self.device = device if device is not None else comfy.model_management.vae_device()
        self.dtype = dtype if dtype is not None else comfy.model_management.vae_dtype(
            self.device, [torch.float16, torch.bfloat16])
        self.model = build_tae_decoder(sd)
        self.model.load_state_dict(sd)
        self.model = _place(self.model, self.device, self.dtype)

        self.latent_channels = self.model[1].weight.shape[1]
        self.upscale_ratio = 2 ** sum(isinstance(m, nn.Upsample) for m in self.model)

    def decode_video(self, latent, frame_indices=None):
        """[B, C, T, H, W] -> [n, 3, H*ratio, W*ratio] uint8 (CPU)。逐帧解码，显存只驻留一帧。"""
        x = latent[0]
        indices = list(range(x.shape[1])) if frame_indices is None else list(frame_indices)
        out = None
        for i, t in enumerate(indices):
            f = self.model(x[:, t].unsqueeze(0).to(device=self.device, dtype=self.dtype))[0]
            f = f.clamp_(0, 1).mul_(255).to(torch.uint8)
            if out is None:
                out = torch.empty((len(indices),) + tuple(f.shape), dtype=torch.uint8)
            out[i].copy_(f)
        return out


def is_taehv_state_dict(sd):
    return "decoder.1.weight" in sd and "decoder.22.bias" in sd


class TAEHVDecoder:
    """时序 TAEHV 解码器（如 taeh3_decoder.safetensors），仅解码。"""

    def __init__(self, sd, device=None, dtype=None):
        from comfy.taesd.taehv import TAEHV, conv as taehv_conv

        latent_channels = sd["decoder.1.weight"].shape[1]
        # 末层卷积输出 image_channels * patch_size**2；核心按通道数推导，对 H3 无条目
        patch_size = max(1, int(round((sd["decoder.22.bias"].shape[0] / 3) ** 0.5)))
        model = TAEHV(latent_channels=latent_channels)
        if model.patch_size != patch_size:
            model.patch_size = patch_size
            model.encoder[0] = taehv_conv(3 * patch_size ** 2, model.encoder[0].out_channels)
            model.decoder[-1] = taehv_conv(model.decoder[-1].in_channels, 3 * patch_size ** 2)
        model.load_state_dict(sd)
        del model.encoder  # 只解码，编码器不占用显存

        self.device = device if device is not None else comfy.model_management.vae_device()
        self.dtype = dtype if dtype is not None else comfy.model_management.vae_dtype(
            self.device, [torch.float16, torch.bfloat16])
        self.model = _place(model, self.device, self.dtype)
        self.latent_channels = latent_channels
        self.upscale_ratio = patch_size * 2 ** sum(isinstance(m, nn.Upsample) for m in model.decoder)
        self.is_h3 = latent_channels == 24 and patch_size == 2

    def _decode(self, latent):
        return self.model.decode(latent.to(device=self.device, dtype=self.dtype))

    def decode_video(self, latent, frame_indices=None):
        t_total = latent.shape[2]
        n = t_total if frame_indices is None else max(1, min(len(frame_indices), t_total))
        if n == t_total:
            out = self._decode(latent[:1])[0].movedim(0, 1)
        else:
            # MemBlock 状态向前链，只能取前缀，代价可控
            out = self._decode(latent[:1, :, :n])[0].movedim(0, 1)
        if out.shape[0] > n:
            out = out[torch.linspace(0, out.shape[0] - 1, n).round().long()]
        return out


def load_tiny_vae_decoder(name, device=None, dtype=None):
    """按 models/vae_approx 下的文件名加载小型解码器；失败返回 None。"""
    import folder_paths

    path = folder_paths.get_full_path("vae_approx", name)
    if path is None:
        logging.warning(f"[班长 H3 预览] '{name}' 不在 models/vae_approx 中。")
        return None
    try:
        sd = comfy.utils.load_torch_file(path, safe_load=True)
        if is_taehv_state_dict(sd):
            return TAEHVDecoder(sd, device=device, dtype=dtype)
        return TinyVAEDecoder(sd, device=device, dtype=dtype)
    except Exception as e:
        logging.warning(f"[班长 H3 预览] 无法加载 '{name}': {e}")
        return None
