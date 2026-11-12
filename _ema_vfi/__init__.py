# -*- coding: utf-8 -*-
"""EMA-VFI 网络定义（上游源码原样保留，仅改依赖导入）。

来源：MCG-NJU/EMA-VFI（CVPR 2023），Apache-2.0 许可。
代码经 gitee 镜像 xuuu3/EMA-VFI 获取，文件结构与上游一致：
    feature_extractor.py  特征提取（MotionFormer 窗口注意力）
    flow_estimation.py    多尺度光流估计 + 融合（MultiScaleFlow）
    refine.py             细化网络（Unet）
    warplayer.py          光流反向采样（warp）
    timm_shim.py          替代 timm 的 3 个小工具（本项目新增）

改动仅两处（其余逐字保留上游）：
    1. `from timm.models.layers import ...` -> `from .timm_shim import ...`
    2. 硬编码 `.cuda()` -> 跟随输入张量的设备

权重文件：ComfyUI/models/ema_vfi/ours_t.safetensors（支持任意时间点插帧）
"""
from . import feature_extractor, flow_estimation, refine, warplayer, timm_shim

__all__ = ["feature_extractor", "flow_estimation", "refine", "warplayer"]
