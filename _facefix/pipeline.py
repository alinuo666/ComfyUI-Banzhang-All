# -*- coding: utf-8 -*-
"""修复管线编排（像素域）：SAM3 检测追踪 → 稳定裁剪渲染 → 前后对比缩略图。

节点定位是【成片后处理】：吃解码后的像素帧序列，吐修好的帧序列。
裁剪/渲染/贴回的真正逻辑在 render.py（MaskVid 式稳定裁剪内核）；
本文件只做检测、编排、报告与缩略图。
"""

import os
import time

import numpy as np
import torch

from . import detection, frames, preview, render

# [引擎时间戳] 进成本行 .py 的加载时间戳 —— 「改了没生效」十有八九是旧进程
# 还在跑：状态行直接报引擎版本，和磁盘 mtime 对不上就是没重启。
_ENGINE_STAMP = time.strftime("%m%d-%H%M", time.localtime(os.path.getmtime(__file__)))

# [条件清洗] H3 的 positive 里带着 ref2va / 首帧条件的 latent，那些是按「主画布」
# （官方面布短边 768）编码出来的，随主工作流一路传到这里。裁剪序列尺寸不同，
# PackedLayout 会按这些参考块的原尺寸预留序列段，与裁剪序列的 video 行数对不上，
# 采样时在 _embed_and_pack 的 h[a:b] = video_embed[...] 处炸成
# 「The size of tensor a (768) must match ...」。
# 裁剪重渲染只需要文本语义（cross_attn / minimax_token_tags），参考块必须剥掉；
# 且必须浅拷贝 —— model / positive 是工作流共享对象，原地改会污染上游节点。
_STRIP_COND_KEYS = (
    "minimax_refs",
    "minimax_keyframes",
    "minimax_visual_cond_noise_aug",
    "minimax_audio_cond_noise_aug",
)


def clean_conditioning(positive):
    """剥掉绑定主画布尺寸的 H3 条件块，返回 (洗净的条件, 剥掉的键数)。"""
    if not positive:
        return positive, 0
    out, removed = [], 0
    for item in positive:
        if isinstance(item, (list, tuple)) and len(item) >= 2 and isinstance(item[1], dict):
            d = dict(item[1])
            for k in _STRIP_COND_KEYS:
                if k in d:
                    d.pop(k)
                    removed += 1
            out.append([item[0], d])
        else:
            out.append(item)
    return out, removed


def _before_after_thumbs(images, out, faces):
    """前后对比缩略图：同一框同一比例，分别在原帧与修后帧上裁。

    [按需解码] 只转用到的那一帧，别把整段 T 帧全部转成 uint8 就为了裁小图；
    同一帧被多张脸复用时走缓存。
    [后图兜底] 绝不无条件覆盖：裁剪失败时保留检测阶段已生成的那张。
    """
    n = int(images.shape[0])
    src_cache, dst_cache = {}, {}

    def pick(tensor, cache, idx):
        if idx not in cache:
            cache[idx] = np.clip(
                tensor[idx].detach().cpu().float().numpy() * 255.0, 0, 255
            ).astype(np.uint8)
        return cache[idx]

    for f in faces:
        box = f.get("box")
        if box is None:
            f.setdefault("thumb_after", f.get("thumb"))
            continue
        ratio = min(1.0, max(0.0, float(f.get("ratio", 0.0))))
        idx = min(n - 1, max(0, int(round(ratio * (n - 1)))))
        before = f.get("thumb") or frames.make_thumb(pick(images, src_cache, idx), box)
        f["thumb"] = before
        f["thumb_after"] = frames.make_thumb(pick(out, dst_cache, idx), box) or before


def execute(images, model=None, positive=None, vae=None,
            sam3_model=None, sam3_clip=None,
            sam3_prompt=detection.DEFAULT_PROMPT,
            sam3_threshold=detection.SAM3_THRESHOLD,
            crop_mode="tracked", crop_scale=1.4, megapixels=0.5,
            steps=4, denoise=0.3, feather=8, node_id=None, fps=24.0,
            crop_padding=None, crop_long_edge=None):
    """返回 (修好的帧, info)。info 含 backend/faces/report/log。

    node_id：面板事件的目标（来自 UNIQUE_ID 隐藏输入）；为空时预览整体静默，
    主流程一个字不变。fps：原片帧率，只用来把「帧数」换成「秒」让循环动画
    与成片同速。
    """
    seg_sec = (int(images.shape[0]) / float(fps or 24.0)) \
        if isinstance(images, torch.Tensor) and images.ndim == 4 else 0.0
    # 预览只服务「检出的人」：整片画面不在这里推（用户明确要的是每张脸的裁剪画面）。
    preview.stage(node_id, "准备中")

    if model is None or positive is None or vae is None:
        preview.stage(node_id, "缺输入")
        return images, {
            "backend": "none", "faces": [], "coverage": 0.0,
            "report": "❌ 像素精修需要「H3模型」「正条件」「解码VAE」三口，缺一口无法运行",
        }

    sam3_cond, cond_note = detection.encode_prompt(sam3_clip, sam3_prompt)
    if sam3_cond is None:
        preview.stage(node_id, "提示词未生效")
        return images, {
            "backend": "none", "faces": [], "coverage": 0.0,
            "report": "⚠️ %s —— 帧序列原样透传" % cond_note,
        }

    preview.stage(node_id, "SAM3.1 追踪人脸")
    det = detection.detect_faces(images, None, vae=None,
                                 sam3_model=sam3_model, sam3_cond=sam3_cond,
                                 sam3_threshold=sam3_threshold)
    faces = det.get("faces", [])
    backend = det.get("backend", "none")
    base_info = {"backend": backend, "faces": faces, "coverage": 0.0}

    if not faces:
        info = dict(base_info)
        info["report"] = "⚠️ %s —— 未检出人脸，帧序列原样透传" % det.get("note", "")
        preview.stage(node_id, "未检出人脸")
        return images, info

    info = dict(base_info)
    # [条件清洗] 主工作流的 refs / keyframes 是主画布尺寸的 latent，裁剪序列装不下，
    # 采样前剥掉；只留文本语义，layout 才完全按当前序列重建。
    clean_positive, stripped = clean_conditioning(positive)
    info["cond_stripped"] = stripped
    log = info.setdefault("log", [])
    # 检出是谁 → 立刻给每个人推一路「修复前」小视频。编码 112 秒 + 采样几分钟里
    # 每格都在动：既看得见跟的是哪张脸，也分得清「在跑」和「卡住」。
    preview.stage(node_id, "推送各脸原片预览")
    n_pv = preview.faces(node_id, images, faces, kind="before", fps=fps)
    if n_pv:
        log.append("已推 %d 路修复前小视频（每人 12 帧、边长 128）" % n_pv)
    # 「为什么是这几个人」的证据：每个人由哪几段追踪合并、在各段里活了多少帧。
    for f in faces:
        tr = f.get("tracks") or [f.get("index")]
        log.append("人#%s ← 追踪段 %s（有效 %s 帧，最佳框 %.0f×%.0f）" % (
            f.get("index"), "/".join(str(t) for t in tr),
            f.get("frames_valid", "?"),
            float(f["box"][2]) - float(f["box"][0]),
            float(f["box"][3]) - float(f["box"][1])))
    try:
        out, rinfo = render.execute(
            images, faces, model, clean_positive, vae,
            crop_mode=crop_mode, crop_scale=crop_scale, megapixels=megapixels,
            steps=steps, denoise=denoise, feather=feather, log=log,
            node_id=node_id, seg_sec=seg_sec,
            crop_padding=crop_padding, crop_long_edge=crop_long_edge,
            frame_masks=det.get("frame_masks"))
        ok = True
    except Exception as e:
        import traceback
        traceback.print_exc()
        why = str(e).splitlines()[0][:110]
        first = (info.get("log") or [""])[0]
        # 失败必须继续显性报错，但保持一行：前端按「｜」拆行，这里用「·」连接。
        info["report"] = "⚠️ %s；精修失败已回退（%s%s）" % (
            det.get("note", ""), why, ("·" + first) if first else "")
        info["detail"] = "｜".join(x for x in (info.get("log") or []) if x)
        out, ok = images, False
        preview.stage(node_id, "已回退原片")

    # 失败也要出对比图：左右都等于原帧，面板看得出「没变化」而不是「没出图」
    _before_after_thumbs(images, out, faces)
    if not ok:
        return images, info

    mode_zh = {"combined": "静止大框", "tracked": "恒尺寸跟随",
               "zoomed": "变焦跟随"}.get(crop_mode, crop_mode)
    # [面板只留一行] 用户要求：底部只出现「✅ 已用 SAM3.1 记忆追踪…；N 张脸」这一条
    # 结论。前端把报告按「｜」拆成多行全文直显（js/banzhang_facefix.js showReport），
    # 所以参数明细/规划简报/逐行日志一律不进 report，改存 info["detail"]，
    # 由节点写进工程 JSON 的 last_detail：排查时从「工程JSON」输出口或存档里取。
    info["report"] = "✅ %s；%d 个修复目标" % (det.get("note", ""), len(faces))
    detail = ["%s、包边 %.2f、放大 %.2fMP、%d 步、降噪 %.2f、阈值 %.2f、羽化 %d、"
              "引擎 %s" % (mode_zh, float(crop_scale), float(megapixels),
                           int(steps), float(denoise), float(sam3_threshold),
                           int(feather), _ENGINE_STAMP)]
    if stripped:
        detail.append("剥掉 %d 个主画布条件" % stripped)
    if float(denoise) >= 0.5:
        detail.append("⚠️降噪≥0.5 高频伪影风险增大")
    if rinfo.get("plan_report"):
        detail.append(rinfo["plan_report"])
    detail.extend(x for x in log if x)
    # 收尾把每个人的「修复后」小视频推上去：格子右半换成成片循环，
    # 不用接预览节点、也不用打开输出文件就能左右对着看同一张脸。
    n_af = preview.faces(node_id, out, faces, kind="after", fps=fps)
    if n_af:
        detail.append("已推 %d 路修复后小视频" % n_af)
    info["detail"] = "｜".join(detail)
    preview.stage(node_id, "完成")
    return out, info
