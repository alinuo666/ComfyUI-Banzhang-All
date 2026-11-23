"""Weight-only fp8 quantization for Depth Pro 2.

Linear weights are stored as float8_e4m3fn with a per-output-channel float32 scale and
dequantized on the fly, roughly halving weight memory versus bf16. Biases, norms and small
layers stay in high precision.
"""

from __future__ import annotations

import torch
from torch import nn
from torch.nn import functional as F

FP8_DTYPE = torch.float8_e4m3fn
FP8_MAX = torch.finfo(FP8_DTYPE).max


class QuantizedLinear(nn.Module):
    """Drop-in nn.Linear replacement holding fp8 weights and dequantizing in forward."""

    def __init__(self, linear: nn.Linear, compute_dtype: torch.dtype):
        super().__init__()
        self.in_features = linear.in_features
        self.out_features = linear.out_features
        self.compute_dtype = compute_dtype
        weight = linear.weight.detach().float()
        scale = weight.abs().amax(dim=1).clamp(min=1e-8) / FP8_MAX
        quantized = (weight / scale[:, None]).clamp(-FP8_MAX, FP8_MAX).to(FP8_DTYPE)
        self.register_buffer("weight_fp8", quantized)
        self.register_buffer("weight_scale", scale)
        if linear.bias is not None:
            self.register_buffer("bias_fp32", linear.bias.detach().float())
        else:
            self.bias_fp32 = None

    def dequantized_weight(self) -> torch.Tensor:
        dtype = self.compute_dtype
        return self.weight_fp8.to(dtype) * self.weight_scale.to(dtype)[:, None]

    @property
    def weight(self) -> torch.Tensor:
        # timm's EVA attention reads attn.qkv.weight directly in the streaming path.
        return self.dequantized_weight()

    @property
    def bias(self) -> torch.Tensor | None:
        return self.bias_fp32

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        weight = self.dequantized_weight()
        bias = None if self.bias_fp32 is None else self.bias_fp32.to(weight.dtype)
        return F.linear(x.to(weight.dtype), weight, bias)


def quantize_linears(
    model: nn.Module, compute_dtype: torch.dtype, min_numel: int = 4096
) -> int:
    """Replace every sufficiently large nn.Linear in ``model`` with a QuantizedLinear.

    Returns the number of replaced layers. Run on CPU before moving the model to its device.
    """
    targets = [
        (parent, name, child)
        for parent in model.modules()
        for name, child in parent.named_children()
        if isinstance(child, nn.Linear) and child.weight.numel() >= min_numel
    ]
    for parent, name, child in targets:
        setattr(parent, name, QuantizedLinear(child, compute_dtype))
    return len(targets)