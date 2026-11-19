# -*- coding: utf-8 -*-
"""🎯 H3 参考图条件 —— 官方「MiniMax H3 参考生成视频」的傻瓜版。

执行体在 core/banzhang_h3_sample_core.py 的 build_image_ref_conditioning
（与「🎯 H3 角色替换采样」共用）。傻瓜点：接「目标latent」自动读画布尺寸
（不手填宽高帧数）、参考图定长三口、清晰度单下拉、latent 直通串联。
接了目标latent → 画布尺寸自动读，参考条件与下游严格同尺寸永不炸；
不接则用手填的画布宽/高。
"""

from ..core.banzhang_h3_sample_core import build_image_ref_conditioning, fix_cn_ref_tags


class Banzhang_H3RefCond:
    CATEGORY = "👨‍🏫班长/视频处理"
    FUNCTION = "run"

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "clip": ("CLIP", {"label": "CLIP（H3 加载器的）"}),
                "vae": ("VAE", {"label": "VAE（H3 加载器的，必接）"}),
                "参考图1": ("IMAGE", {"label": "参考图1（新角色，必接）"}),
                "提示词": ("STRING", {"default": "<Picture 1> 里的角色，原视频同款动作与光线，写实电影质感",
                                       "multiline": True,
                                       "label": "提示词（用 <Picture 1> 引用第一张图）"}),
                "清晰度": (["最高清晰（慢，换角色推荐）", "自动匹配（快）"],
                           {"default": "最高清晰（慢，换角色推荐）", "label": "参考图清晰度",
                            "tooltip": "最高清晰 = 参考图按 2048 短边编码，长相还原最好，略慢；"
                                       "自动匹配 = 参考图缩放到目标画布面积，快但身份感弱一点。"}),
            },
            "optional": {
                "参考图2": ("IMAGE", {"label": "参考图2（可选，多角度）"}),
                "参考图3": ("IMAGE", {"label": "参考图3（可选，多角度）"}),
                "参考视频": ("VIDEO", {"label": "参考视频（可选，动作/风格参考）",
                                        "tooltip": "对应提示词里的 <Video 1> 标签。"
                                                   "自动对齐画布、超长裁到目标长度、尾部对齐 17k+5 网格。"}),
                "目标latent": ("LATENT", {"label": "目标latent（接 🧬 H3 AV打包 的输出）",
                                          "tooltip": "接上后画布宽高自动从 latent 读出，"
                                                     "参考条件与下游严格同尺寸；不接则用下面手填的画布宽高。"}),
                "画布宽": ("INT", {"default": 1344, "min": 32, "max": 16384, "step": 32,
                                   "label": "画布宽（未接目标latent时生效）"}),
                "画布高": ("INT", {"default": 768, "min": 32, "max": 16384, "step": 32,
                                   "label": "画布高（未接目标latent时生效）"}),
                "参考视频尺寸": ("INT", {"default": 0, "min": 0, "max": 4096, "step": 32,
                                       "label": "参考视频最长边（0=自动适配）",
                                       "tooltip": "把参考视频按最长边缩放到这个值（宽高比不变，自动对齐 32 网格）。"
                                                  "0 = 自动适配。值越大参考细节越多、耗时越长。"}),
            }
        }

    RETURN_TYPES = ("CONDITIONING", "LATENT")
    RETURN_NAMES = ("参考图正条件", "目标latent")
    OUTPUT_TOOLTIPS = (
        "带参考图条件的正条件，接 KSampler 正条件口",
        "目标 latent 原样直通（串在 AV打包 和 KSampler 之间用）",
    )

    def run(self, clip, vae, 参考图1, 提示词, 清晰度,
            参考图2=None, 参考图3=None, 目标latent=None,
            画布宽=1344, 画布高=768, 参考视频=None, 参考视频尺寸=0):
        w_px, h_px = int(画布宽), int(画布高)
        frame_count = 0
        ref_videos = []
        if 目标latent is not None:
            samples = 目标latent.get("samples")
            video = samples
            if getattr(samples, "is_nested", False):
                video = list(samples.unbind())[0]
            if video is not None and video.ndim == 5:
                spatial = 16
                try:
                    spatial = int(vae.spacial_compression_encode())
                except Exception:
                    pass
                w_px = int(video.shape[-1]) * spatial
                h_px = int(video.shape[-2]) * spatial
                if 参考视频 is not None:
                    frame_count = 17 * max(0, (int(video.shape[2]) - 2) // 5) + 5

        if 参考视频 is not None:
            ref_videos.append(参考视频.get_components().images)
        提示词, n_fix = fix_cn_ref_tags(提示词)
        if n_fix:
            print(f"ℹ️ [H3参考图条件] 提示词里 {n_fix} 个中文参考标签已自动改为 <Picture N>/<Video N>")
        cond, _n = build_image_ref_conditioning(
            clip, vae, (参考图1, 参考图2, 参考图3), 提示词,
            清晰度.startswith("最高清晰"), w_px, h_px,
            ref_videos=ref_videos, ref_video_long=int(参考视频尺寸), frame_count=frame_count)
        passthrough = 目标latent if 目标latent is not None else {}
        return cond, passthrough


NODE_CLASS_MAPPINGS = {
    "Banzhang_H3RefCond": Banzhang_H3RefCond,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "Banzhang_H3RefCond": "🎯 H3 参考图条件",
}
