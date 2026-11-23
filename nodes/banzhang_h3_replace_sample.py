# -*- coding: utf-8 -*-
"""🎯 H3 角色替换采样 —— 角色替换工作流的采样准备一体机。

把四步固定流水线合成一个节点（中间没有任何需要用户干预的口）：
  稳定裁剪（规划器整段联合求恒尺寸框）→ 帧网格对齐
  → VAE 编码 → 潜空间遮罩（按 H3 帧循环 + 2x2 token 降采样）→ AV 打包
  → 参考图条件（Qwen 看图 + VAE 参考块，每步重注入）

输出：正条件 / AV latent 接 KSampler；裁剪框 / 裁剪遮罩接 🎯 主体重绘·贴回。
原始帧数不再需要填——节点手里就有帧，网格对齐全自动。

独立节点（裁剪 / AV打包 / 参考图条件）保留注册，服务其他模型链路；本节点
是这条替换链的傻瓜式一键版。算法层全部在 core/banzhang_h3_sample_core.py。
"""

import re

import torch

from ..core.banzhang_subject_redraw_core import plan_and_crop
from ..core.banzhang_mask_to_latent import mask_to_latent
from ..core.banzhang_h3_sample_core import (
    align_pixel_frames, build_av, build_image_ref_conditioning, encode_video,
    fit_frames_and_mask, fix_cn_ref_tags, resolve_input_frames)

# 下拉显示中文，内部映射（与独立节点同一套）
_MODE_MAP = {"静止大框": "combined", "恒尺寸跟随": "tracked", "变焦跟随": "zoomed"}


class Banzhang_H3ReplaceSample:
    CATEGORY = "👨‍🏫班长/视频处理"
    FUNCTION = "run"

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "clip": ("CLIP", {"label": "CLIP（H3 加载器的）"}),
                "vae": ("VAE", {"label": "VAE（H3 加载器的）"}),
                "主体遮罩": ("MASK", {"label": "主体遮罩（SAM3 追踪的旧角色）"}),
                "提示词": ("STRING", {"default": "<Picture 1> 里的角色，原视频同款动作与光线，写实电影质感",
                                       "multiline": True,
                                       "label": "提示词（用 <Picture 1> 引用第一张图）"}),
                "清晰度": (["最高清晰（慢，换角色推荐）", "自动匹配（快）"],
                           {"default": "最高清晰（慢，换角色推荐）", "label": "参考图清晰度",
                            "tooltip": "最高清晰 = 参考图按 2048 短边编码，长相还原最好，略慢；"
                                       "自动匹配 = 参考图缩放到目标画布面积，快但身份感弱一点。"}),
                "裁剪模式": (["静止大框", "恒尺寸跟随", "变焦跟随"],
                             {"default": "恒尺寸跟随", "label": "裁剪模式",
                              "tooltip": "静止大框 = 一个框包住角色全程运动，全程不动最稳；"
                                         "恒尺寸跟随 = 框大小不变、角色快出框才小幅移动；"
                                         "变焦跟随 = 框还跟着角色大小缩放。"}),
                "包边比例": ("FLOAT", {"default": 1.5, "min": 1.0, "max": 3.0, "step": 0.05,
                                       "label": "包边比例",
                                       "tooltip": "裁剪框相对角色大小的倍数，1.5 = 角色占框约三分之二，"
                                                  "四周留给模型当上下文。"}),
                "画幅比例": ("FLOAT", {"default": 0.0, "min": 0.0, "max": 10.0, "step": 0.01,
                                       "label": "画幅比例（宽/高，0=自动）"}),
                "放大百万像素": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 16.0, "step": 0.05,
                                           "label": "放大到百万像素（0=不放大）",
                                           "tooltip": "裁剪区放大到约这个像素量再采样，角色占满 token 才出细节。"}),
                "重绘强度": ("FLOAT", {"default": 1.0, "min": 0.05, "max": 1.0, "step": 0.05,
                                      "label": "重绘强度（1=全重画）",
                                      "tooltip": "重画区保留多少原帧结构：1 = 整块重画，动作靠模型编；"
                                                 "0.6~0.7 = 保留原角色动作姿态，新角色沿原轨迹演（换角色推荐）；"
                                                 "低于 0.5 换脸不彻底。只作用于重画区，KSampler 的 denoise 保持 1.0 不要动。"}),
                "遮罩反向": ("BOOLEAN", {"default": False, "label": "遮罩反向（改背景用）",
                                        "tooltip": "开 = 白区变保留区：遮罩圈住的主体（角色）原样不动，背景全部重画"
                                                   "（换背景/换场景用）。"}),
                "尺寸对齐": (["自动对齐模型画布（推荐）", "跟随视频（仅对齐网格）"],
                             {"default": "自动对齐模型画布（推荐）", "label": "尺寸对齐",
                              "tooltip": "自动对齐 = 视频/帧的任意尺寸贴到模型最合适的画布"
                                         "（短边 768、总面积不超 768x1344、宽高对齐 32）；"
                                         "跟随视频 = 保留原尺寸，只把宽高对齐到 32 网格。帧与遮罩同步缩放。"}),
                "参考视频尺寸": ("INT", {"default": 0, "min": 0, "max": 4096, "step": 32,
                                       "label": "参考视频最长边（0=自动适配）",
                                       "tooltip": "把参考视频按最长边缩放到这个值（宽高比不变，自动对齐 32 网格）。"
                                                  "0 = 自动适配（比画布小的视频保留原尺寸、比画布大的缩到模型画布）。"
                                                  "值越大参考细节越多、耗时越长。"}),
            },
            "optional": {
                "原始帧": ("IMAGE", {"label": "原始帧（与「视频」口二选一）"}),
                "视频": ("VIDEO", {"label": "视频（接官方 LoadVideo / Video Components）",
                                     "tooltip": "接视频口就不用接「原始帧」：节点自动取画面轨。"
                                                "VHS 老版 LoadVideo 的 VHS_VIDEO 类型接不进来，"
                                                "用官方 LoadVideo 或在中间加一个 Video Components 节点转帧。"}),
                "参考图1": ("IMAGE", {"label": "参考图1（可选，新角色；全不接=纯提示词编辑）",
                                     "tooltip": "接了 = 按图换角色；参考图 1/2/3 与参考视频都不接时，"
                                                "按提示词直接重画遮罩区域（换装/换道具/加特效等），不需要任何素材图。"}),
                "参考图2": ("IMAGE", {"label": "参考图2（可选，多角度）"}),
                "参考图3": ("IMAGE", {"label": "参考图3（可选，多角度）"}),
                "参考视频": ("VIDEO", {"label": "参考视频（可选，动作/风格参考）",
                                        "tooltip": "接官方 LoadVideo 的视频：给模型当动作/表演参考"
                                                   "（对应提示词里的 <Video 1> 标签）。"
                                                   "自动对齐画布、超长部分裁到主片帧数、尾部对齐 17k+5 网格。"}),
            }
        }

    RETURN_TYPES = ("CONDITIONING", "LATENT", "BOUNDING_BOX", "MASK")
    RETURN_NAMES = ("正条件", "AV latent", "裁剪框", "裁剪遮罩")
    OUTPUT_TOOLTIPS = (
        "带参考图条件的正条件，接 KSampler 正条件口",
        "打包好的 AV latent，接 KSampler latent 口",
        "每帧裁剪框，接 🎯 主体重绘·贴回",
        "裁剪后的遮罩（原边界，未外扩未柔化），接 🎯 主体重绘·贴回",
    )

    def run(self, clip, vae, 主体遮罩, 提示词, 清晰度,
            裁剪模式, 包边比例, 画幅比例, 放大百万像素,
            重绘强度, 遮罩反向, 尺寸对齐, 参考视频尺寸,
            参考图1=None, 原始帧=None, 视频=None, 参考图2=None, 参考图3=None, 参考视频=None):
        # 0) 视频口/原始帧口二选一取帧，并按尺寸对齐模式统一画布（遮罩同步缩放）
        原始帧 = resolve_input_frames(原始帧, 视频)
        原始帧, 主体遮罩, _tw, _th = fit_frames_and_mask(
            原始帧, 主体遮罩, 尺寸对齐)
        # 1) 遮罩原样进稳定裁剪（不再外扩/羽化）；反向时取反 → 主体保留、背景重画
        if 遮罩反向:
            主体遮罩 = 1.0 - 主体遮罩
        crop_frames, crop_masks, boxes, _report = plan_and_crop(
            原始帧, 主体遮罩, _MODE_MAP.get(裁剪模式, 裁剪模式), 包边比例, 画幅比例,
            32, 放大百万像素, "auto")  # H3 专用节点：网格步长恒 32、缩放恒自动

        # 2) 帧网格对齐（像素级，编码前）——遮罩随帧一起补齐
        frames, fc = align_pixel_frames(crop_frames)
        if crop_masks.shape[0] < frames.shape[0]:
            pad = crop_masks[-1:].expand(frames.shape[0] - crop_masks.shape[0], -1, -1)
            crop_masks = torch.cat([crop_masks, pad], dim=0)

        # 3) 编码 + AV 打包（哑音频）
        latent_video, _device = encode_video(frames, vae)
        av, T_lat = build_av(latent_video, fc)

        # 4) 潜空间遮罩：按 VAE 真实几何降采样，随补齐帧数对齐
        dm = mask_to_latent(crop_masks, vae)
        lh, lw = int(latent_video.shape[-2]), int(latent_video.shape[-1])
        if (int(dm.shape[-2]), int(dm.shape[-1])) != (lh, lw):
            dm = torch.nn.functional.interpolate(dm[:, None], size=(lh, lw),
                                                 mode="nearest-exact")[:, 0]
        L = int(dm.shape[0])
        if L > T_lat:
            dm = dm[:T_lat]
        elif L < T_lat:
            pad = dm[-1:].expand(T_lat - L, -1, -1)
            dm = torch.cat([dm, pad], dim=0)
        # 重绘强度只乘在噪声掩码上（<1 = 重画区保留部分原帧结构 → 动作传给新角色）；
        # 贴回用的 crop_masks 保持原值——若一并缩放，旧角色会以半透明混进出片（鬼影）
        dm = (dm * float(重绘强度)).clamp(0.0, 1.0)
        av["noise_mask"] = dm[None, None]

        # 5) 参考图/参考视频条件：画布尺寸 = 裁剪输出尺寸，同源永不炸
        提示词, n_fix = fix_cn_ref_tags(提示词)
        if n_fix:
            print(f"ℹ️ [H3角色替换采样] 提示词里 {n_fix} 个中文参考标签已自动改为 <Picture N>/<Video N>")
        # 零参考护栏：没接任何参考素材时，提示词里引用不存在的图/视频会被模型当真去找，直接剥掉
        if 参考图1 is None and 参考图2 is None and 参考图3 is None and 参考视频 is None:
            提示词, n_strip = re.subn(r"<(Picture|Video)\s*\d+>", "", 提示词)
            if n_strip:
                print(f"ℹ️ [H3角色替换采样] 未接任何参考图/参考视频，提示词里 {n_strip} 个失效的 <Picture>/<Video> 标签已去掉")
        ref_videos = []
        if 参考视频 is not None:
            ref_videos.append(参考视频.get_components().images)
        cond, _n_refs = build_image_ref_conditioning(
            clip, vae, (参考图1, 参考图2, 参考图3), 提示词,
            清晰度.startswith("最高清晰"),
            int(crop_frames.shape[2]), int(crop_frames.shape[1]),
            ref_videos=ref_videos, ref_video_long=int(参考视频尺寸), frame_count=fc)

        return cond, av, boxes, crop_masks


NODE_CLASS_MAPPINGS = {
    "Banzhang_H3ReplaceSample": Banzhang_H3ReplaceSample,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "Banzhang_H3ReplaceSample": "🎯 H3 角色替换采样",
}
