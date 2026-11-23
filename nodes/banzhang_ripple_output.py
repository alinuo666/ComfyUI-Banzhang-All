# -*- coding: utf-8 -*-
"""🎞️ H3 涟漪 · 输出成片：裁掉模型补边，保存成片与源片对比。"""

from __future__ import annotations

import torch

from ..core import banzhang_ripple_state as st
from ..core import banzhang_ripple_video as vd
from . import banzhang_ripple_writer as sv

SAVE_CHOICES = ("成片+对比", "仅成片", "仅对比", "不保存")


def comparison_frames(images: torch.Tensor, ripple: dict) -> torch.Tensor:
    """左源片、右成片并排。"""
    count = min(len(images), ripple["length"])
    images = vd.trim_content(images[:count], ripple["geometry"])
    source = vd.trim_content(ripple["window"][:count], ripple["geometry"]).to(images.device, images.dtype)
    if source.shape[1:3] != images.shape[1:3]:
        import comfy.utils

        source = comfy.utils.common_upscale(source.movedim(-1, 1), int(images.shape[2]), int(images.shape[1]),
                                            "lanczos", "disabled").movedim(1, -1)
    return torch.cat((source, images[..., :3]), dim=2).clone()


class BZ_RippleOutput:
    CATEGORY = st.CATEGORY
    FUNCTION = "output"
    OUTPUT_NODE = True
    RETURN_TYPES = ("IMAGE", "AUDIO", "FLOAT", "IMAGE")
    RETURN_NAMES = ("images", "audio", "frame_rate", "comparison")
    OUTPUT_TOOLTIPS = (
        "生成的成片画面（已去掉模型补边）。",
        "这段窗口的音频。",
        "帧率，固定 24.0。",
        "左源片、右成片的并排对比画面。",
    )
    DESCRIPTION = (
        "把生成的成片连同原片音频保存为 MP4，并另存一份源片 | 成片对比。"
        "同时把画面继续输出，方便再接放大、转格式等节点。"
    )

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "images": ("IMAGE", {"tooltip": "采样器解码后的生成画面。"}),
                "ripple": ("VIDEO", {"tooltip": "接「时间轴选段」的 🎬 视频输出口，用来裁掉补边和取音频。"}),
            },
            "optional": {
                "save": (list(SAVE_CHOICES), {"default": SAVE_CHOICES[0],
                         "tooltip": "保存哪些 MP4（H.264）到输出目录；对比片不带声音。"}),
                "filename_prefix": ("STRING", {"default": "ripple/edit",
                                    "tooltip": "文件名前缀，可带子目录；对比片会自动加 _compare。"}),
            },
            "hidden": {"prompt": "PROMPT", "extra_pnginfo": "EXTRA_PNGINFO"},
        }

    def output(self, images, ripple, save=SAVE_CHOICES[0], filename_prefix="ripple/edit", prompt=None,
               extra_pnginfo=None):
        ripple = st.unwrap_ripple(ripple)
        count = min(len(images), ripple["length"])
        comparison = comparison_frames(images[:count], ripple)
        images = vd.trim_content(images[:count], ripple["geometry"])
        fps, audio, previews = float(ripple["fps"]), ripple.get("audio"), []
        if save in (SAVE_CHOICES[0], SAVE_CHOICES[1], SAVE_CHOICES[2]):
            saver = sv.WN_SaveVideo()
            jobs = []
            if save != SAVE_CHOICES[2]:
                jobs.append((images, filename_prefix, audio))
            if save != SAVE_CHOICES[1]:
                jobs.append((comparison, f"{filename_prefix}_compare", None))
            for frames, prefix, sound in jobs:
                saved = saver.save_video(frames, fps, prefix, audio=sound, prompt=prompt, extra_pnginfo=extra_pnginfo)
                previews += saved["ui"]["images"]
        result = (images, audio, fps, comparison)
        if not previews:
            return result
        return {"ui": {"images": previews, "animated": (True,)}, "result": result}


NODE_CLASS_MAPPINGS = {"BZ_RippleOutput": BZ_RippleOutput}
NODE_DISPLAY_NAME_MAPPINGS = {"BZ_RippleOutput": "🎞️ H3 涟漪 · 输出成片"}
