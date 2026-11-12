# -*- coding: utf-8 -*-
"""🪄 H3 涟漪 · 应用编辑：把改好的帧编成 H3 的条件与空白潜空间。"""

from __future__ import annotations

import banzhang_ripple_core as rc
import banzhang_ripple_state as st
import banzhang_ripple_video as vd


class BZ_RippleApply:
    CATEGORY = st.CATEGORY
    FUNCTION = "apply"
    RETURN_TYPES = ("CONDITIONING", "LATENT")
    RETURN_NAMES = ("positive", "latent")
    OUTPUT_TOOLTIPS = (
        "H3 条件：提示词 + 第 0 帧的原始窗口引导 + 每个编辑帧在对应位置的引导。",
        "与窗口等长的空白 H3 音视频潜空间。",
    )
    DESCRIPTION = (
        "把「选片段」给的原片段当作引导，再为每个编辑帧加一条引导，组成 H3 涟漪 LoRA 需要的条件。"
        "接好 FL2VA 模型与涟漪 LoRA，输出接到 BasicGuider（CFG 1）和采样器。"
        "改了编辑图重跑时，已编码的提示词和原片段会自动复用。"
    )

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "clip": ("CLIP", {"tooltip": "H3 的文本编码器（CLIP 类型选 minimax）。"}),
                "vae": ("VAE", {"tooltip": "H3 的视频 VAE。"}),
                "ripple": (st.RIPPLE_TYPE, {"tooltip": "接「选片段」的涟漪输出。"}),
                "prompt": ("STRING", {"multiline": True, "default": rc.DEFAULT_PROMPT,
                           "tooltip": "给 H3 模型的编辑传播指令。改动来自编辑图而不是文字，保持默认即可。"}),
            },
            "optional": {
                "edited_images": ("IMAGE", {"tooltip": "图内编辑器输出的编辑帧批次，按标记的时间顺序排列；优先于「选片段」上上传的图片。"}),
                **{name: ("IMAGE", {"tooltip": f"标记 {i} 的编辑图，必须恰好一张；优先于批次和上传"
                                    + ("" if i == 1 else f"，且要求「选片段」上存在标记 {i}。")})
                   for i, name in enumerate(st.EDITED_ANCHOR_NAMES, 1)},
            },
        }

    def apply(self, clip, vae, ripple, prompt, edited_images=None, **edited_anchors):
        import node_helpers
        from comfy_extras.nodes_minimax_h3 import _empty_av_latent

        unknown = sorted(set(edited_anchors) - set(st.EDITED_ANCHOR_NAMES))
        if unknown:
            raise TypeError(f"「应用编辑」收到未知输入：{', '.join(unknown)}")
        width, height, length = ripple["width"], ripple["height"], ripple["length"]
        markers, _ = rc.parse_markers(ripple["markers"], length)
        geometry = ripple["geometry"]
        explicit = {i: edited_anchors[name] for i, name in enumerate(st.EDITED_ANCHOR_NAMES, 1)
                    if edited_anchors.get(name) is not None}
        for identity, image in explicit.items():
            if not any(m["id"] == identity for m in markers):
                raise ValueError(f"编辑锚点 {identity} 需要「选片段」上先有标记 {identity}。")
            if len(image) != 1:
                raise ValueError(f"编辑锚点 {identity} 必须恰好一张图。")
        window = ripple["window"]
        notes, checks, keyframes_edit, unchanged = [], [], [], 0
        if edited_images is not None and len(edited_images) != len(markers):
            notes.append(f"编辑帧批次有 {len(edited_images)} 张、标记有 {len(markers)} 个，缺的改用已上传图片。")
        missing = [m["frame"] + 1 for i, m in enumerate(markers)
                   if explicit.get(m["id"]) is None
                   and not (edited_images is not None and i < len(edited_images)) and not m.get("edited")]
        if missing:
            frames = ", ".join(str(frame) for frame in missing)
            raise ValueError(f"第 {frames} 帧没有编辑图：请在「选片段」卡片上传/拖入/粘贴，或连接编辑帧批次。")
        stale = set(rc.stale_markers(markers, int(ripple.get("window_start", 0)), geometry["crop"],
                                     ripple.get("source"), ripple.get("source_version")))
        window_np = None
        for index, marker in enumerate(markers):
            frame, label = int(marker["frame"]), f"第 {int(marker['frame']) + 1} 帧"
            direct = explicit.get(marker["id"])
            from_input = direct is not None or (edited_images is not None and index < len(edited_images))
            edited = direct if direct is not None else (edited_images[index:index + 1] if from_input
                                                        else vd.load_input_image(marker["edited"]))
            if frame in stale and not from_input:
                notes.append(f"{label}：这张编辑图对应的是别的帧、裁剪或源片，请重新导出该帧或还原选择。")
            aspect = rc.aspect_note((int(edited.shape[2]), int(edited.shape[1])), tuple(geometry["content_rect"][2:]))
            if aspect:
                notes.append(f"{label}：{aspect}")
            edited = vd.edit_to_canvas(edited, geometry)
            if window_np is None:
                window_np = window.cpu().numpy()
            match = rc.match_edited_frame(window_np, edited[0].cpu().numpy(), frame)
            if match["unchanged"]:
                unchanged += 1
                notes.append(f"{label}：与原帧完全相同，这一刻将保持原样。")
            elif match["verdict"] == "mismatch":
                notes.append(f"{label}：这张图看起来来自第 {match['best'] + 1} 帧，请重新导出或把标记移回去。")
            checks.append("✓" if match["verdict"] == "ok" else "?")
            keyframes_edit.append({"resolved_frame_index": frame, "latent": vae.encode(edited[..., :3])})
        if unchanged == len(markers):
            notes.append("没有任何编辑帧与原帧不同，结果会与原片段一样。")

        latent, frame_count = _empty_av_latent(width, height, length)
        if frame_count != length:
            raise ValueError(f"窗口长度 {length} 不是合法的 H3 长度。")
        positive = st.encode_prompt(clip, prompt)
        keyframes = [{"resolved_frame_index": 0, "latent": st.encode_source(vae, ripple)}, *keyframes_edit]
        positive = node_helpers.conditioning_set_values(positive, {"minimax_keyframes": keyframes})
        where = ", ".join(f"{m['frame'] + 1} {c}" for m, c in zip(markers, checks))
        cw, ch = geometry["content_rect"][2:]
        text = [f"共 {len(markers)} 张编辑帧 / 窗口 {length} 帧（{cw}x{ch}）：第 {where} 帧（✓ 表示编辑图与其来源帧吻合）",
                *notes]
        return {"ui": {"text": text}, "result": (positive, latent)}


NODE_CLASS_MAPPINGS = {"BZ_RippleApply": BZ_RippleApply}
NODE_DISPLAY_NAME_MAPPINGS = {"BZ_RippleApply": "🪄 H3 涟漪 · 应用编辑"}
