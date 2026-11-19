# -*- coding: utf-8 -*-
"""🧬 H3 AV打包 · 哑音频 —— 把纯视频 latent 打包成 H3 双流嵌套 latent。

执行体在 core/banzhang_h3_sample_core.py 的 pack_video_only（与
「🎯 H3 角色替换采样」共用），本文件只做端口与面板。
H3 forward 必须吃「视频+音频」双流 NestedTensor，纯视频 latent 直接进
KSampler 必报 index 1 is out of bounds——本节点就是缺的那一步。
"""

from ..core.banzhang_h3_sample_core import pack_video_only


class Banzhang_H3AVPack:
    CATEGORY = "👨‍🏫班长/视频处理"
    FUNCTION = "run"

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "视频latent": ("LATENT", {"label": "视频 latent（可挂噪声掩码）"}),
                "原始帧数": ("INT", {"default": 0, "min": 0, "max": 99999, "step": 1,
                                     "label": "原始帧数（0=自动反推）",
                                     "tooltip": "视频的真实像素帧数（视频信息节点的帧数口）。"
                                                "填了才做精确的 17k+5 网格补齐；0 = 从 latent 帧数反推，"
                                                "帧数本来就在网格上时结果一样。"}),
            }
        }

    RETURN_TYPES = ("LATENT",)
    RETURN_NAMES = ("AV latent",)
    OUTPUT_TOOLTIPS = ("视频+哑音频双流嵌套 latent，接 KSampler（MiniMax H3）",)

    def run(self, 视频latent, 原始帧数):
        return pack_video_only(视频latent, 原始帧数)


NODE_CLASS_MAPPINGS = {
    "Banzhang_H3AVPack": Banzhang_H3AVPack,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "Banzhang_H3AVPack": "🧬 H3 AV打包 · 哑音频",
}
