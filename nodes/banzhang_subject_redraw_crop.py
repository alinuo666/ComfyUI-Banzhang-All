# -*- coding: utf-8 -*-
"""🎯 主体重绘·裁剪 —— 视频主体局部重绘的上半段。

合并 MaskVidExperiments 的 Mask Cleanup + Subject Crop + Mask To Latent Space
三件为一个节点：先按固定默认参数清理遮噪（收缩重建 + 外扩 4px，对干净遮罩
近似恒等），再对主体做整段联合规划的稳定裁剪。裁剪框在遮噪/遮挡/短暂出画时
保持不动，只有持续运动才跟随，避免视频模型把裁剪抖动误读为运镜。

潜空间遮罩：接了 VAE 时按编码器的真实几何（H3 的 1,4,4,4,4 帧循环 + 2x2
token 网格，max 降采样）把裁剪遮罩降到 latent 分辨率，直接接 Set Latent
Noise Mask——比原生像素遮罩拉伸更准，重绘边界与模型 token 对齐，不渗色。

用法：本节点 → 你的采样/放大链路 → 🎯 主体重绘·贴回。
GPLv3，算法移植自 drozbay/MaskVidExperiments。
"""

from ..core.banzhang_subject_redraw_core import grow_soft_mask, plan_and_crop
from ..core.banzhang_mask_to_latent import mask_to_latent


# 裁剪模式下拉显示中文，内部映射到规划器的三种模式
_MODE_MAP = {"静止大框": "combined", "恒尺寸跟随": "tracked", "变焦跟随": "zoomed"}
# 缩放算法下拉显示中文，内部映射到 ComfyUI 滤镜名
_SCALE_MAP = {"自动": "auto", "最近邻": "nearest-exact", "双线性": "bilinear",
              "区域平均": "area", "双三次": "bicubic", "Lanczos": "lanczos"}


class Banzhang_SubjectRedrawCrop:
    CATEGORY = "👨‍🏫班长/视频处理"
    FUNCTION = "run"

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "原始帧": ("IMAGE", {"label": "原始视频帧"}),
                "主体遮罩": ("MASK", {"label": "主体遮罩（每帧一张）"}),
                "裁剪模式": (["静止大框", "恒尺寸跟随", "变焦跟随"],
                             {"default": "静止大框", "label": "裁剪模式",
                              "tooltip": "静止大框 = 一个框包住主体全程运动，全程不动最稳；"
                                         "恒尺寸跟随 = 框大小不变、主体快出框才小幅移动；"
                                         "变焦跟随 = 框还跟着主体大小缩放，全部重采样到固定输出分辨率。"}),
                "包边比例": ("FLOAT", {"default": 1.5, "min": 0.0, "max": 4.0, "step": 0.05,
                                       "label": "包边比例",
                                       "tooltip": "裁剪框相对主体大小的倍数：1.5 = 主体占框约三分之二，"
                                                  "四周留三分之一包边；1.0 = 紧贴主体；0 = 不裁剪，全帧直通。"}),
                "画幅比例": ("FLOAT", {"default": 0.0, "min": 0.0, "max": 10.0, "step": 0.01,
                                       "label": "画幅比例（宽/高，0=自动）",
                                       "tooltip": "裁剪框的宽高比，如 1.78 就是 16:9。0 = 由规划器自动选形状。"}),
                "整除步长": ("INT", {"default": 32, "min": 1, "max": 64, "step": 1,
                                     "label": "整除步长",
                                     "tooltip": "裁剪框宽高向上取整到它的倍数，匹配模型的分辨率要求（H3/LTX 用 32）。"}),
                "放大百万像素": ("FLOAT", {"default": 0.0, "min": -16.0, "max": 16.0, "step": 0.05,
                                           "label": "放大到百万像素（0=不放大）",
                                           "tooltip": "把裁剪帧统一放大到约这个像素量再交给采样，"
                                                      "负值允许缩小。0 = 不放大。"}),
                "缩放算法": (["自动", "最近邻", "双线性", "区域平均", "双三次", "Lanczos"],
                             {"default": "自动", "label": "缩放算法",
                              "tooltip": "自动 = 放大用双三次、缩小用 Lanczos。"}),
                "遮罩外扩": ("INT", {"default": 16, "min": 0, "max": 128, "step": 4,
                                     "label": "遮罩外扩（像素，0=关闭）",
                                     "tooltip": "遮罩整体向外扩这么多像素并柔化边缘，"
                                                "让重画范围盖住旧主体轮廓外的环带——"
                                                "角色替换时防止残留旧边缘。外扩量的一半自动做边缘柔化。"
                                                "只修脸/只修补丁等不想动周边的场景填 0。"}),
            },
            "optional": {
                "编码VAE": ("VAE", {"label": "编码VAE（可选）",
                                            "tooltip": "接你编码裁剪帧用的同一个 VAE：潜空间遮罩按它的真实几何降采样"
                                                       "（H3 自动读帧循环 1,4,4,4,4 和 2x2 token 网格）。"
                                                       "不接时按 H3 默认几何兜底。"}),
            }
        }

    RETURN_TYPES = ("IMAGE", "MASK", "MASK", "BOUNDING_BOX", "STRING")
    RETURN_NAMES = ("裁剪帧", "裁剪遮罩", "潜空间遮罩", "裁剪框", "规划报告")
    OUTPUT_TOOLTIPS = (
        "恒定尺寸的裁剪帧，接你的采样/放大链路",
        "裁到同样框的像素遮罩（像素域用，如贴回）",
        "潜空间分辨率的裁剪遮罩，接 Set Latent Noise Mask——重绘边界与模型 token 对齐，不渗色",
        "每帧的裁剪框，接 🎯 主体重绘·贴回",
        "规划简报：选了什么形状、框多大、移动多少、包边达成几成",
    )

    def run(self, 原始帧, 主体遮罩, 裁剪模式, 包边比例, 画幅比例,
            整除步长, 放大百万像素, 缩放算法, 遮罩外扩, 编码VAE=None):
        主体遮罩 = grow_soft_mask(主体遮罩, int(遮罩外扩))
        cropped_images, cropped_masks, boxes, report = plan_and_crop(
            原始帧, 主体遮罩, _MODE_MAP.get(裁剪模式, 裁剪模式), 包边比例, 画幅比例,
            整除步长, 放大百万像素, _SCALE_MAP.get(缩放算法, 缩放算法))
        latent_mask = mask_to_latent(cropped_masks, 编码VAE)
        return cropped_images, cropped_masks, latent_mask, boxes, report


NODE_CLASS_MAPPINGS = {
    "Banzhang_SubjectRedrawCrop": Banzhang_SubjectRedrawCrop,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "Banzhang_SubjectRedrawCrop": "🎯 主体重绘·裁剪",
}
