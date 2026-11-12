# -*- coding: utf-8 -*-
"""修复管线编排（像素域）：检测追踪 → 互动分组 → 组块精修 → 输出修好的帧。

节点定位是【成片后处理】：吃解码后的像素帧序列，吐修好的帧序列。
放在三采之后、合成出片之前。脸块在放大后的画布上占满全部 token，
这才解决「脸 token 过小」的分辨率上限。
"""

import os
import time

import numpy as np

from . import detection, frames, groups, refine

# [引擎时间戳] 进成本行 .py 的加载时间戳 —— 「改了没生效」十有八九是旧进程
# 还在跑：状态行直接报引擎版本，和磁盘 mtime 对不上就是没重启。
_ENGINE_STAMP = time.strftime("%m%d-%H%M", time.localtime(os.path.getmtime(__file__)))

# [条件清洗] H3 的 positive 里带着 ref2va / 首帧条件的 latent，那些是按「主画布」
# （官方面布短边 768）编码出来的，随主工作流一路传到这里。脸块画布是「格宽²」，
# PackedLayout 会按这些参考块的原尺寸预留序列段，与脸块画布的 video 行数对不上，
# 采样时在 _embed_and_pack 的 h[a:b] = video_embed[...] 处炸成
# 「The size of tensor a (768) must match ...」。
# 脸块重渲染只需要文本语义（cross_attn / minimax_token_tags），参考块必须剥掉；
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


def _before_after_thumbs(images, out, faces, expand=0):
    """前后对比缩略图：同一比例同一框，分别在原帧与修后帧上裁。

    [框随外扩扩] 对比框 = 脸框 + 外扩（与修复范围一致）——旧版只裁脸框，
    外扩出来的修复环全在图外，外扩调多大图上都「看不出区别」。

    [按需解码] 只转用到的那一帧，别把整段 T 帧（39×576×1216 ≈ 82MB）全部
    转成 uint8 就为了裁 96px 的图；同一帧被多张脸复用时走缓存。

    [后图兜底] 绝不无条件覆盖：裁剪失败时保留检测阶段已生成的那张，
    后图再退到前图 —— 右侧半格永远不空。
    """
    n = int(images.shape[0])
    H, W = int(images.shape[1]), int(images.shape[2])
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
        if expand > 0:
            x1, y1, x2, y2 = box
            box = [max(0.0, x1 - expand), max(0.0, y1 - expand),
                   min(float(W), x2 + expand), min(float(H), y2 + expand)]
        ratio = min(1.0, max(0.0, float(f.get("ratio", 0.0))))
        idx = min(n - 1, max(0, int(round(ratio * (n - 1)))))
        before = frames.make_thumb(pick(images, src_cache, idx), box) or f.get("thumb")
        f["thumb"] = before
        f["thumb_after"] = frames.make_thumb(pick(out, dst_cache, idx), box) or before


def execute(images, model=None, positive=None, vae=None,
            sam3_model=None, sam3_clip=None, sam3_prompt=detection.DEFAULT_PROMPT,
            sam3_threshold=detection.SAM3_THRESHOLD, mask_dilate=0,
            steps=6, denoise=0.3, upscale=2.0, upscale_model="",
            feather=24, detail_gain=1.0):
    """返回 (修好的帧, info)。info 含 backend/faces/report/log。"""
    T, H, W = int(images.shape[0]), int(images.shape[1]), int(images.shape[2])
    if model is None or positive is None or vae is None:
        return images, {
            "backend": "none", "faces": [], "coverage": 0.0,
            "report": "❌ 像素精修需要「H3模型」「正条件」「解码VAE」三口，缺一口无法运行",
        }

    sam3_cond, cond_note = detection.encode_prompt(sam3_clip, sam3_prompt)
    if sam3_cond is None:
        return images, {
            "backend": "none", "faces": [], "coverage": 0.0,
            "report": "⚠️ %s —— 帧序列原样透传" % cond_note,
        }

    det = detection.detect_faces(images, None, vae=None,
                                 sam3_model=sam3_model, sam3_cond=sam3_cond,
                                 sam3_threshold=sam3_threshold)
    faces = det.get("faces", [])
    backend = det.get("backend", "none")
    base_info = {"backend": backend, "faces": faces, "coverage": 0.0}

    if not faces:
        info = dict(base_info)
        info["report"] = "⚠️ %s —— 未检出人脸，帧序列原样透传" % det.get("note", "")
        return images, info

    # [拼贴画布] 不再按「互动组」分组：所有脸拼到一张画布上、一次采样，
    # 口型与光线天然一致。分组只在人太多一屏放不下时按 max_faces 切批，
    # 批与批之间互不影响（每批各自采样）。
    info = dict(base_info)
    # [条件清洗] 主工作流的 refs / keyframes 是主画布尺寸的 latent，脸块画布装不下，
    # 采样前剥掉；只留文本语义，layout 才完全按当前画布重建。
    clean_positive, stripped = clean_conditioning(positive)
    info["cond_stripped"] = stripped
    try:
        out = refine.refine_batches(
            images, faces, model, clean_positive, vae,
            upscale=upscale, upscale_model=upscale_model,
            denoise=denoise, steps=steps, feather=feather,
            detail_gain=detail_gain,
            margin=mask_dilate, log=info.setdefault("log", []))
        ok = True
    except Exception as e:
        import traceback
        traceback.print_exc()
        why = str(e).splitlines()[0][:110]
        first = (info.get("log") or [""])[0]
        info["report"] = "⚠️ %s；精修失败已回退（%s%s）" % (
            det.get("note", ""), why, ("｜" + first) if first else "")
        out, ok = images, False

    # 失败也要出对比图：左右都等于原帧，面板看得出「没变化」而不是「没出图」
    # [框随外扩扩] 对比框 = 脸框 + 外扩，修复环必须在图里看得见
    _before_after_thumbs(images, out, faces, expand=mask_dilate)
    if not ok:
        return images, info

    # [效果自证] 把「块差 / 覆盖」带到状态行 —— 「没效果」时一眼能分清是
    # 采样没动（块差≈0）还是贴回没落（覆盖≈0），不用再猜。
    detail = ""
    log_lines = info.get("log") or []
    log0 = log_lines[0] if log_lines else ""
    if "块差" in log0:
        detail = "、块差" + log0.split("块差", 1)[1]
    # [帧对齐] 正常路径已是「取前 T 帧 1:1 对齐」（补帧只在尾部、因果 VAE 逐帧
    # 对应）；只有解码丢帧（n_out < T，正常不该发生）才按比例兜底 —— 那是
    # 「口型对不上」的残余风险，必须显式暴露。
    for line in log_lines:
        if "按比例对齐" in line:
            detail = "、⚠️ " + line.split("：", 1)[-1] + detail
            break
    # [可见性] 剥条件与伪影风险必须出现在报告里：画布条件被剥掉后高频是模型
    # 自由生成的，降噪越高伪影越多 —— 用户不该靠猜。
    extra = ""
    if stripped:
        extra += "、剥掉 %d 个主画布条件" % stripped
    if float(denoise) >= 0.5:
        extra += "、⚠️降噪≥0.5 高频伪影风险增大"
    # 画布尺寸随人数变（1 人 256²、4 人 512²、8 人 1024×512），从日志取真值
    canvas_txt = ""
    if "画布 " in log0:
        canvas_txt = "、画布 " + log0.split("画布 ", 1)[1].split("、", 1)[0]
    # [全参数回显] 7 个参数的实际执行值都上状态行 —— 调参即见反馈，
    # 不用再猜「这个参数到底进没进」。
    # 放大模型短名（面板/状态行放得下）：去掉扩展名，超长截断
    _m = str(upscale_model or "")
    if _m and not _m.startswith("（"):
        _m = _m.rsplit(".", 1)[0]
        _m = _m if len(_m) <= 14 else _m[:13] + "…"
    else:
        _m = "双线性"
    info["report"] = ("✅ %s；%d 张脸一次采样%s、放大 ×%.2f[%s]、%d 步、"
                      "降噪 %.2f、细节 %.2f、阈值 %.2f、外扩 %d、羽化 %d、"
                      "引擎 %s%s%s" % (
                          det.get("note", ""), len(faces), canvas_txt,
                          float(upscale), _m, int(steps),
                          float(denoise), float(detail_gain),
                          float(sam3_threshold), int(mask_dilate), int(feather),
                          _ENGINE_STAMP, detail, extra))
    # [证据全文] 完整日志（色度增量/低频漂移/覆盖/块差）附到报告末尾：
    # 前端状态区默认两行截断，点「展开」即可逐行核对，判断斑点来自本节点还是上游。
    if log_lines:
        info["report"] += "｜" + "｜".join(log_lines)
    return out, info
