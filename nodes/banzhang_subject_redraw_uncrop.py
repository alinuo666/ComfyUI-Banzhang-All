# -*- coding: utf-8 -*-
"""🎯 主体重绘·贴回 —— 视频主体局部重绘的下半段。

把采样/放大链路处理过的裁剪帧羽化贴回原始帧。裁剪框中途被缩放过也能自动
缩回原框；接到裁剪遮罩时只在主体范围内合成。第一个输入是「处理后帧」：
bypass 本节点和 🎯 主体重绘·裁剪 时，处理后帧直通输出，整条裁剪链可一键 A/B 对比。

GPLv3，算法移植自 drozbay/MaskVidExperiments。
"""

from ..core.banzhang_subject_redraw_core import uncrop

# 缩放算法下拉显示中文，内部映射到 ComfyUI 滤镜名（与裁剪节点同一套）
_SCALE_MAP = {"自动": "auto", "最近邻": "nearest-exact", "双线性": "bilinear",
              "区域平均": "area", "双三次": "bicubic", "Lanczos": "lanczos"}


class Banzhang_SubjectRedrawUncrop:
    CATEGORY = "👨‍🏫班长/视频处理"
    FUNCTION = "run"

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                # 处理后帧放第一位：bypass 时第一路 IMAGE 直通输出，
                # 裁剪+贴回一起 bypass 得到的必须是处理过的全帧，不是原始帧
                "处理后帧": ("IMAGE", {"label": "处理后帧（你的采样/放大结果）"}),
                "原始帧": ("IMAGE", {"label": "原始视频帧（贴回目标）"}),
                "羽化宽度": ("INT", {"default": 16, "min": 0, "max": 256, "step": 1,
                                     "label": "羽化宽度（像素）",
                                     "tooltip": "从裁剪框边缘向内渐变混合的宽度；贴到画面边缘的边不羽化。"}),
                "缩放算法": (["自动", "最近邻", "双线性", "区域平均", "双三次", "Lanczos"],
                             {"default": "自动", "label": "缩放算法",
                              "tooltip": "裁剪帧需要缩回原框时用的滤波器；自动 = 放大用双三次、缩小用 Lanczos。"}),
            },
            "optional": {
                "裁剪框": ("BOUNDING_BOX", {"forceInput": True,
                                            "tooltip": "🎯 主体重绘·裁剪输出的每帧裁剪框。不接时按全帧处理。"}),
                "裁剪遮罩": ("MASK", {"tooltip": "可选：只在遮罩范围内合成（遮罩按裁剪帧分辨率给）。"
                                             "想要更软的边缘可先模糊遮罩再接进来。"}),
            }
        }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("合成帧",)
    OUTPUT_TOOLTIPS = ("贴回完成的完整视频帧",)

    def run(self, 处理后帧, 原始帧, 羽化宽度, 缩放算法, 裁剪框=None, 裁剪遮罩=None):
        return (uncrop(原始帧, 处理后帧, 裁剪框, 裁剪遮罩, 羽化宽度,
                       _SCALE_MAP.get(缩放算法, 缩放算法)),)


NODE_CLASS_MAPPINGS = {
    "Banzhang_SubjectRedrawUncrop": Banzhang_SubjectRedrawUncrop,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "Banzhang_SubjectRedrawUncrop": "🎯 主体重绘·贴回",
}
