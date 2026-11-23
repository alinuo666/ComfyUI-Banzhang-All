# -*- coding: utf-8 -*-
"""🪄 H3 涟漪 · 应用编辑：把选中片段的首帧引导与提示词编成 H3 条件与空白潜空间。"""

from __future__ import annotations

from ..core import banzhang_ripple_core as rc
from ..core import banzhang_ripple_state as st


class BZ_RippleApply:
    CATEGORY = st.CATEGORY
    FUNCTION = "apply"
    RETURN_TYPES = ("CONDITIONING", "LATENT")
    RETURN_NAMES = ("positive", "latent")
    OUTPUT_TOOLTIPS = (
        "H3 条件：提示词 + 窗口首帧编码出的画面引导。",
        "与窗口等长的空白 H3 音视频潜空间。",
    )
    DESCRIPTION = (
        "把「时间轴选段」窗口首帧编码成引导，与提示词一起组成 H3 条件，另给等长空白潜空间。"
        "接好 FL2VA 模型后，输出接到 BasicGuider（CFG 1）和采样器。"
        "重跑时，已编码的提示词和引导会自动复用。"
    )

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "clip": ("CLIP", {"tooltip": "H3 的文本编码器（CLIP 类型选 minimax）。"}),
                "vae": ("VAE", {"tooltip": "H3 的视频 VAE。"}),
                "ripple": ("VIDEO", {"tooltip": "接「时间轴选段」的 🎬 视频输出口（涟漪数据在里面）。"}),
                "prompt": ("STRING", {"multiline": True, "default": rc.DEFAULT_PROMPT,
                           "tooltip": "给 H3 模型的生成指令。"}),
            },
        }

    def apply(self, clip, vae, ripple, prompt):
        ripple = st.unwrap_ripple(ripple)
        import node_helpers
        from comfy_extras.nodes_minimax_h3 import _empty_av_latent

        width, height, length = ripple["width"], ripple["height"], ripple["length"]
        latent, frame_count = _empty_av_latent(width, height, length)
        if frame_count != length:
            raise ValueError(f"窗口长度 {length} 不是合法的 H3 长度。")
        positive = st.encode_prompt(clip, prompt)
        keyframes = [{"resolved_frame_index": 0, "latent": st.encode_source(vae, ripple)}]
        positive = node_helpers.conditioning_set_values(positive, {"minimax_keyframes": keyframes})
        cw, ch = ripple["geometry"]["content_rect"][2:]
        text = [f"窗口 {length} 帧（{cw}x{ch}）：首帧已编码为画面引导。"]
        return {"ui": {"text": text}, "result": (positive, latent)}


NODE_CLASS_MAPPINGS = {"BZ_RippleApply": BZ_RippleApply}
NODE_DISPLAY_NAME_MAPPINGS = {"BZ_RippleApply": "🪄 H3 涟漪 · 应用编辑"}
