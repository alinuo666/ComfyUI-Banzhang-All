"""Depth Pro 2 导出：16 位 PNG / 32 位浮点 TIFF / PLY 点云。

从上游 Save 节点抽出为独立函数，供合体节点调用。EXR 需额外装 OpenEXR，
本机未装，故不提供（TIFF 无损等价，零依赖）。
"""
from __future__ import annotations

import logging
from pathlib import Path

import numpy as np
import torch
import folder_paths
from PIL import Image
from PIL.PngImagePlugin import PngInfo
from PIL.TiffImagePlugin import ImageFileDirectory_v2

from .colormaps import inverse_metric, color_scale

LOGGER = logging.getLogger(__name__)


def _output_prefix(prefix: str, width: int, height: int):
    folder, filename, counter, _, _ = folder_paths.get_save_image_path(
        prefix, folder_paths.get_output_directory(), width, height
    )
    return Path(folder), filename, counter


def save_depth16(depth: torch.Tensor, prefix: str) -> dict:
    """反深度 16 位灰度 PNG（近白远黑）；米制深度 = k / 像素值，k 写入 PNG 文本块。"""
    inverse = inverse_metric(depth)
    scale = color_scale(inverse)
    k = 65535.0 / scale
    folder, filename, counter = _output_prefix(prefix, depth.shape[-1], depth.shape[-2])
    previews = []
    for frame in inverse:
        normalized = (frame / scale).clamp(0, 1)
        path = folder / f"{filename}_{counter:05d}.png"
        meta = PngInfo()
        meta.add_text("depthpro2_k", f"{k:.6g}")
        Image.fromarray(normalized.mul(65535).round().to(torch.uint16).numpy()).save(
            path, pnginfo=meta, compress_level=1
        )
        name = f"{filename}_{counter:05d}_preview.png"
        Image.fromarray(normalized.mul(255).round().to(torch.uint8).numpy()).save(
            Path(folder_paths.get_temp_directory()) / name, compress_level=1
        )
        previews.append({"filename": name, "subfolder": "", "type": "temp"})
        counter += 1
    LOGGER.info("%s：深度（米）= %.4g / 像素值，0 表示无穷远", prefix, k)
    return {"ui": {"images": previews}}


def save_depth32(depth: torch.Tensor, prefix: str, sky_value: float, focal_px: float) -> dict:
    """真米制 32 位浮点 TIFF（Nuke/Fusion/Blender 直接吃），EXR 的无依赖替代。"""
    meters = depth.float().cpu().clone()
    invalid = ~torch.isfinite(meters)
    if sky_value > 0:
        meters[invalid] = sky_value
    else:
        meters[torch.isnan(meters)] = float("inf")
    sky_desc = f"{sky_value:g} m" if sky_value > 0 else "inf"
    folder, filename, counter = _output_prefix(prefix, meters.shape[-1], meters.shape[-2])
    counter = len(list(folder.glob(f"{filename}_*.tif")))
    inverse = inverse_metric(depth)
    scale = color_scale(inverse)
    previews = []
    for i, frame in enumerate(meters):
        path = folder / f"{filename}_{counter:05d}.tif"
        info = ImageFileDirectory_v2()
        info[65000] = "meters"
        info[65001] = sky_desc
        if focal_px > 0:
            info[65002] = f"{focal_px:.6g}"
        Image.fromarray(frame.numpy()).save(path, tiffinfo=info)
        name = f"{filename}_{counter:05d}_preview.png"
        Image.fromarray((inverse[i] / scale).clamp(0, 1).mul(255).round().to(torch.uint8).numpy()).save(
            Path(folder_paths.get_temp_directory()) / name, compress_level=1
        )
        previews.append({"filename": name, "subfolder": "", "type": "temp"})
        counter += 1
    LOGGER.info("%s：米制浮点 TIFF，天空=%s", prefix, sky_desc)
    return {"ui": {"images": previews}}


def save_ply(position: torch.Tensor, valid: torch.Tensor, prefix: str, image: torch.Tensor | None):
    """相机空间 XYZ → 二进制 PLY 点云（米）；只写有效点，可带原图 RGB。"""
    if position.ndim != 4 or position.shape[-1] != 3:
        raise ValueError("点云需要位置通道输出（T,H,W,3），请检查连线。")
    if image is not None and image.shape[1:3] != position.shape[1:3]:
        raise ValueError("原图分辨率必须与位置通道一致。")
    folder, filename, _ = _output_prefix(prefix, position.shape[-2], position.shape[-1])
    counter = len(list(folder.glob(f"{filename}_*.ply")))
    colored = image is not None
    props = "property float x\nproperty float y\nproperty float z\n"
    fields = [("x", "<f4"), ("y", "<f4"), ("z", "<f4")]
    if colored:
        props += "property uchar red\nproperty uchar green\nproperty uchar blue\n"
        fields += [("red", "u1"), ("green", "u1"), ("blue", "u1")]
    for i in range(position.shape[0]):
        mask = valid[i].bool()
        points = position[i][mask].numpy().astype("<f4")
        record = np.empty(len(points), dtype=np.dtype(fields))
        record["x"], record["y"], record["z"] = points.T
        if colored:
            rgb = (image[i][mask].clamp(0, 1) * 255).round().to(torch.uint8).numpy()
            record["red"], record["green"], record["blue"] = rgb.T
        header = (
            f"ply\nformat binary_little_endian 1.0\nelement vertex {len(points)}\n"
            f"{props}end_header\n"
        )
        path = folder / f"{filename}_{counter:05d}.ply"
        path.write_bytes(header.encode("ascii") + record.tobytes())
        LOGGER.info("%s：%s（%d 点，米制）", path, prefix, len(points))
        counter += 1
