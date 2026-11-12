# -*- coding: utf-8 -*-
"""timm 依赖垫片：只提供 EMA-VFI 网络代码用到的 3 个小工具。

上游 EMA-VFI 从 `timm.models.layers` 导入 DropPath / to_2tuple / trunc_normal_，
但这三个东西实现极短，为了不给大家增加 timm 依赖（装了还容易跟 torch 版本打架），
这里直接内联等价实现。

等价性说明：
    to_2tuple / DropPath 与 timm 源码逐行一致；
    trunc_normal_ 直接用 PyTorch 自带的 torch.nn.init.trunc_normal_（语义相同），
    且它只在权重初始化时被调用，我们加载预训练权重，实际不会走到。
"""
from itertools import repeat

import torch
import torch.nn as nn


def to_2tuple(x):
    if isinstance(x, (tuple, list)):
        return tuple(x)
    return tuple(repeat(x, 2))


def trunc_normal_(tensor, mean=0.0, std=1.0, a=-2.0, b=2.0):
    return torch.nn.init.trunc_normal_(tensor, mean=mean, std=std, a=a, b=b)


def drop_path(x, drop_prob: float = 0.0, training: bool = False):
    if drop_prob == 0.0 or not training:
        return x
    keep_prob = 1 - drop_prob
    shape = (x.shape[0],) + (1,) * (x.ndim - 1)
    random_tensor = x.new_empty(shape).bernoulli_(keep_prob)
    if keep_prob > 0.0:
        random_tensor.div_(keep_prob)
    return x * random_tensor


class DropPath(nn.Module):
    """Stochastic depth，推理时是恒等映射。"""

    def __init__(self, drop_prob: float = 0.0):
        super().__init__()
        self.drop_prob = drop_prob

    def forward(self, x):
        return drop_path(x, self.drop_prob, self.training)

    def extra_repr(self) -> str:
        return f"p={self.drop_prob}"


__all__ = ["DropPath", "to_2tuple", "trunc_normal_", "drop_path"]
