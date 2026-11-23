# -*- coding: utf-8 -*-
"""🪞 深度估计 Pro2：单节点集成 Depth Pro 2（图片/视频、着色、米制导出、点云）。

把原 9 个节点合成 1 个：加载→推理→着色→坐标→导出一次完成。
内部按缓存复用模型；推理用 torch.no_grad()；导出走 core/depth_pro2/exporters。
"""
from __future__ import annotations

import torch

from ..core.depth_pro2 import engine, exporters
from ..core.depth_pro2.colormaps import COLORMAPS, color_scale, colorize, inverse_metric

_TAG = "🪞 深度估计 Pro2"
_MODELS = ["depthpro2-s", "depthpro2-b", "depthpro2-l", "depthpro2-h"]
_EXPORTS = ["不导出", "16位深度PNG", "32位浮点TIFF", "带色点云PLY"]
_COLORMAPS_ZH = {"turbo": "turbo（近红远蓝）", "gray": "灰度（近白远黑）",
                 "viridis": "viridis", "inferno": "inferno", "magma": "magma", "plasma": "plasma"}
_ZH_TO_CM = {v: k for k, v in _COLORMAPS_ZH.items()}


class BanZhang_DepthPro2:
    """Depth Pro 2 一体机：一张图/一段视频 → 深度图 + 米制深度 + 可选导出。"""

    DESCRIPTION = (
        "苹果 Depth Pro 2 单节点版：逐像素米制深度（单位米），边缘锐利、视频帧间稳定。\n"
        "【模式】单图=逐张独立推理（各帧自己的焦距）；视频=滑动窗口联合推理（全段共用一个焦距，不闪）。\n"
        "【精度】自动=GPU 用 bf16、CPU 用 fp32；fp8 最省显存（S 模型约 79MB，精度掉约 7%）。\n"
        "首次运行自动下载权重到 ComfyUI/models/depthpro2/（S 97MB；H+ 3.5GB）。\n"
        "【焦距】填 0 自动估算；知道相机 35mm 等效焦距就填进去（24/35/50），深度按焦距线性缩放。\n"
        "【导出】16位PNG=反深度灰度（Nuke 用 Raw、Blender 用 Non-Color 读）；\n"
        "32位TIFF=真米制浮点（无损，Nuke/Fusion/Blender 直接吃）；PLY=相机空间点云（可带原图上色）。\n"
        "⚠ 模型权重仅限非商用研究与学习使用。"
    )

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "图像": ("IMAGE", {"tooltip": "单张或一批图。视频模式请按顺序送帧（用加载视频节点解出的画面）。"}),
                "模型": (_MODELS, {"default": "depthpro2-s",
                                 "tooltip": "S 97MB 最快；H+ 3.5GB 最锐最稳。笔记本建议 S/B。"}),
                "精度": (["自动", "bf16", "fp16", "fp32", "fp8"],
                         {"default": "自动", "tooltip": "自动=GPU bf16 / CPU fp32；fp8 最省显存但掉精度约 7%。"}),
                "模式": (["单图（逐张独立）", "视频（时序稳定）"],
                         {"default": "单图（逐张独立）", "tooltip": "视频=滑动窗口联合推理，帧间深度不闪，全段共用一个焦距。"}),
                "焦距毫米": ("FLOAT", {"default": 0.0, "min": 0.0, "step": 0.5,
                                   "tooltip": "35mm 等效焦距（EXIF 的 FocalLengthIn35mmFilm）。0=用焦距估计器自动算。"}),
                "最长边": ("INT", {"default": 0, "min": 0, "max": 8192, "step": 32,
                                "tooltip": "0=原始分辨率（边缘最锐）。显存不够再调小，缩小会损失细节并可能改变深度尺度。"}),
                "着色": (list(_ZH_TO_CM), {"default": "turbo（近红远蓝）",
                                        "tooltip": "彩色深度预览的配色。turbo 是苹果官方预览色。"}),
                "导出": (_EXPORTS, {"default": "不导出",
                                  "tooltip": "不导出=只在节点上看；16位PNG/32位TIFF/PLY 会写到 ComfyUI 的 output 目录。"}),
            },
            "optional": {
                "焦距像素": ("FLOAT", {"default": 0.0, "min": 0.0, "step": 0.1,
                                   "tooltip": "直接给像素焦距，优先于「焦距毫米」。已标定的相机用这个。"}),
                "窗口帧数": ("INT", {"default": 16, "min": 1, "max": 64,
                                 "tooltip": "仅视频模式：每次联合推理的帧数。越大越稳但越吃显存。"}),
                "重叠帧数": ("INT", {"default": 4, "min": 0, "max": 63,
                                 "tooltip": "仅视频模式：相邻窗口重叠帧数，接缝更稳。必须小于窗口帧数。"}),
                "文件名前缀": ("STRING", {"default": "depthpro2/depth",
                                     "tooltip": "导出文件名的前缀，支持子目录。"}),
                "天空填充值": ("FLOAT", {"default": 0.0, "min": 0.0, "step": 100.0,
                                   "tooltip": "仅32位TIFF：天空/无效像素填的米数。0=保留无穷远。"}),
            },
        }

    RETURN_TYPES = ("IMAGE", "IMAGE", "DEPTHPRO2_DEPTH", "MASK", "FLOAT", "IMAGE", "MASK")
    RETURN_NAMES = ("深度灰度图", "深度彩色图", "米制深度", "天空遮罩", "焦距像素", "点云位置", "有效遮罩")
    FUNCTION = "estimate"
    CATEGORY = "👨‍🏫班长/深度估计"
    OUTPUT_NODE = True

    def estimate(self, 图像, 模型, 精度, 模式, 焦距毫米, 最长边, 着色, 导出,
                 焦距像素=0.0, 窗口帧数=16, 重叠帧数=4, 文件名前缀="depthpro2/depth", 天空填充值=0.0):
        video_mode = 模式.startswith("视频")
        if video_mode and 重叠帧数 >= 窗口帧数:
            raise ValueError(f"{_TAG}：重叠帧数必须小于窗口帧数。")

        model_bundle = engine.get_model(模型, _precision(精度))
        image, depth, focal_out, sky = engine.estimate(
            图像, model_bundle, 焦距毫米, 焦距像素, 最长边, video_mode, 窗口帧数, 重叠帧数
        )
        inverse = inverse_metric(depth)
        colored = colorize(inverse, _ZH_TO_CM[着色], color_scale(inverse))
        if focal_out > 0:
            position, valid = self._position(depth, focal_out)
        else:
            position = torch.zeros((*depth.shape, 3), dtype=torch.float32)
            valid = torch.zeros_like(depth)

        ui = self._export(导出, depth, position, valid, 图像, focal_out, 天空填充值, 文件名前缀)
        result = (image, colored, depth, sky, focal_out, position, valid)
        if ui:
            return {"ui": ui["ui"], "result": result}
        return result

    @staticmethod
    def _position(depth, focal_out):
        if focal_out <= 0:
            raise ValueError(f"{_TAG}：导出点云需要有效焦距，请把「焦距像素」接上或填 35mm 等效焦距。")
        h, w = depth.shape[-2:]
        valid = torch.isfinite(depth) & (depth > 0)
        z = torch.where(valid, depth, torch.zeros_like(depth))
        u = torch.arange(w, dtype=torch.float32) + 0.5 - w / 2
        v = torch.arange(h, dtype=torch.float32) + 0.5 - h / 2
        xyz = torch.stack([z * u.view(1, 1, w) / focal_out,
                           z * v.view(1, h, 1) / focal_out, z], dim=-1)
        return xyz, valid.to(torch.float32)

    @staticmethod
    def _export(导出, depth, position, valid, 图像, focal_out, 天空填充值, 文件名前缀):
        if 导出 == "16位深度PNG":
            return exporters.save_depth16(depth, 文件名前缀)
        if 导出 == "32位浮点TIFF":
            return exporters.save_depth32(depth, 文件名前缀, 天空填充值, focal_out)
        if 导出 == "带色点云PLY":
            exporters.save_ply(position, valid, 文件名前缀, 图像)
        return None


def _precision(精度):
    return {"自动": "auto", "bf16": "bf16", "fp16": "fp16", "fp32": "fp32", "fp8": "fp8"}[精度]


NODE_CLASS_MAPPINGS = {"BanZhang_DepthPro2": BanZhang_DepthPro2}
NODE_DISPLAY_NAME_MAPPINGS = {"BanZhang_DepthPro2": "🪞 深度估计 Pro2（图片/视频一体）"}
