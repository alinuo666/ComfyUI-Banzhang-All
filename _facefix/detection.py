# -*- coding: utf-8 -*-
"""人脸检测：SAM3.1 记忆追踪（SAM3_VideoTrack），一次会话拿到逐帧逐身份掩码。

为什么不用 SAM3_Detect：那个是**逐帧独立检测**，帧与帧之间没有身份关联，
只能靠 IoU 猜"这帧的 0 号框是不是上帧的 0 号框"，快速换位／擦身／短暂遮挡
就会串脸。SAM3_VideoTrack 走 memory tracker，obj_id 全程稳定，还直接给像素级
掩码 —— 我们最终要的正是掩码，不必先退化成矩形框再画回来。

SAM3.1 不是独立检测器：它需要「SAM3 模型」+ 文本提示。模型由端口传入，提示词
用同一份权重自带的文本编码器在节点内编码（等价于外接一个 CLIPTextEncode，
接线少一个节点）。没有 YOLO 或任何其它降级路径：缺模型/缺编码器时直接给中文说明。
"""

import numpy as np
import torch

SAM3_THRESHOLD = 0.35
# 一段镜头里同时追踪的身份上限（初始掩码也计入）；0 会用内部上限 64，太危险
MAX_OBJECTS = 8
# 掩码折算成框时，低于这个像素面积视为伪检测
MIN_FACE_SIDE = 8.0
# 默认提示词：SAM3.1 是开放词汇检测，文本说 face 就找脸
DEFAULT_PROMPT = "face"


def encode_prompt(clip, text):
    """用 SAM3.1 自带的文本编码器编码提示词（等价于外接 CLIPTextEncode）。

    节点内集成这一步，前端只留一个可编辑的文本框，接线少一个节点。
    返回 (conditioning, note)；失败时 conditioning 为 None。
    """
    if clip is None:
        return None, "未接「SAM3.1文本编码」：把 CheckpointLoaderSimple 的 CLIP 口接过来"
    t = str(text or "").strip() or DEFAULT_PROMPT
    try:
        return clip.encode_from_tokens_scheduled(clip.tokenize(t)), ""
    except Exception as e:
        return None, "提示词「%s」编码失败（%s）" % (t, str(e).splitlines()[0][:80])


def _video_track_class():
    """取官方 SAM3 视频追踪节点类。"""
    from comfy_extras.nodes_sam3 import SAM3_VideoTrack
    return SAM3_VideoTrack


def _unpack(packed):
    """bit-packed [N,K,H,W//8] uint8 → bool [N,K,H,W*8]。"""
    from comfy.ldm.sam3.tracker import unpack_masks
    return unpack_masks(packed)


def _bbox_of(mask, frame_h=None, frame_w=None, scale=(1.0, 1.0)):
    """bool 2D 掩码（可低分辨率）→ 画面坐标 [x1,y1,x2,y2] 或 None。

    [低分算框] 以前把掩码双线性放大到整幅画面再算框：39 帧×2 人 float32
    576×1216 就要 218MB，8 人 875MB，而结果只是个矩形。现在直接在掩码自身
    分辨率上取行列包围盒，再乘 scale 换回画面坐标 —— 零插值、零放大。

    除最小边外还做几何过滤：SAM3 是开放词汇检测，会把牌匾、招牌、窗框这类
    "像脸"的方框一起收进来。人脸近似方形且面积占比有界，用这两条压误检，
    这样才敢把阈值降到 0.35 去提召回（漏检角色）。
    """
    rows = torch.any(mask, dim=1).nonzero()
    cols = torch.any(mask, dim=0).nonzero()
    if rows.numel() == 0 or cols.numel() == 0:
        return None
    sx, sy = float(scale[0]), float(scale[1])
    y1, y2 = int(rows[0]), int(rows[-1])
    x1, x2 = int(cols[0]), int(cols[-1])
    bw, bh = (x2 - x1) * sx, (y2 - y1) * sy
    if bw < MIN_FACE_SIDE or bh < MIN_FACE_SIDE:
        return None
    aspect = bw / max(1e-6, bh)
    if aspect < 0.5 or aspect > 1.8:
        return None
    if frame_h and frame_w:
        frac = (bw * bh) / float(frame_h * frame_w)
        if frac < 0.0008 or frac > 0.45:
            return None
    return [x1 * sx, y1 * sy, (x2 + 1) * sx, (y2 + 1) * sy]


def _sam3_track(sam3_model, frames, sam3_cond, threshold=SAM3_THRESHOLD):
    """一次会话跑完整段追踪。

    返回 (None, per_obj [N][K] bbox, W, H)。第一项保留占位：调用方只看 per_obj，
    掩码不再回传 —— 全图掩码是 218~875MB 的死重，只用来取矩形框。
    """
    height, width = int(frames.shape[1]), int(frames.shape[2])
    cls = _video_track_class()
    out = cls.execute(
        images=frames, model=sam3_model, conditioning=sam3_cond,
        detection_threshold=float(threshold), max_objects=MAX_OBJECTS,
        detect_interval=1)
    res = out.result if getattr(out, "result", None) is not None else out.args
    td = res[0]

    packed = td.get("packed_masks")
    if packed is None:
        return None, [], width, height

    masks = _unpack(packed)                       # [N,K,Hm,Wm] bool
    n, k = int(masks.shape[0]), int(masks.shape[1])
    if n == 0 or k == 0:
        return None, [], width, height

    # [低分算框] 掩码保持自身分辨率，只算行列包围盒再乘比例换回画面坐标。
    # 以前先双线性放大到 576×1216 再算 → 218MB（2 人）/ 875MB（8 人）纯浪费。
    hm, wm = int(masks.shape[-2]), int(masks.shape[-1])
    scale = (width / float(max(1, wm)), height / float(max(1, hm)))
    per_obj = []
    for i in range(n):
        bboxes = []
        for j in range(k):
            bboxes.append(_bbox_of(masks[i, j], height, width, scale))
        per_obj.append(bboxes)
    return None, per_obj, width, height


def detect_faces(detect_frames=None, h3_latent=None, vae=None,
                 sam3_model=None, sam3_cond=None, sam3_threshold=SAM3_THRESHOLD,
                 max_frames=None):
    """主入口。返回 {"faces","frame_masks","backend","frame_size","note"}。

    frame_masks 恒为 None（历史字段，保留键名不破坏老自检）；掩码只用于取框。
    外部检测帧优先；未接时用 VAE 内部解码一采 latent 的关键帧兜底。
    """
    if sam3_model is None:
        return {
            "faces": [], "frame_masks": None, "backend": "none", "frame_size": [],
            "note": "未接「SAM3.1模型」：CheckpointLoaderSimple 的 MODEL 口接过来"
                    "（没有降级检测器）",
        }
    if sam3_cond is None:
        return {
            "faces": [], "frame_masks": None, "backend": "none", "frame_size": [],
            "note": "提示词没编成条件，本次不检测（没有降级检测器）",
        }

    if detect_frames is None:
        from . import frames
        detect_frames = frames.decode_keyframes(
            vae, h3_latent, max_frames=max_frames or frames.MAX_DETECT_FRAMES)
        source = "VAE 内部解码关键帧"
        if detect_frames is None:
            return {
                "faces": [], "frame_masks": None, "backend": "none", "frame_size": [],
                "note": "未接检测帧且未接解码VAE：接「检测帧」或「解码VAE」即可自动检测",
            }
    else:
        source = "外部检测帧"

    try:
        _masks_unused, per_obj, width, height = _sam3_track(
            sam3_model, detect_frames, sam3_cond, threshold=sam3_threshold)
    except ImportError:
        return {
            "faces": [], "frame_masks": None, "backend": "sam3.1", "frame_size": [],
            "note": "当前 ComfyUI 没有 SAM3 追踪节点（comfy_extras/nodes_sam3.py）",
        }
    except Exception as e:
        return {
            "faces": [], "frame_masks": None, "backend": "sam3.1", "frame_size": [],
            "note": "SAM3.1 追踪失败：%s" % str(e).splitlines()[0][:120],
        }

    if not per_obj or not per_obj[0]:
        return {
            "faces": [], "frame_masks": None, "backend": "sam3.1",
            "frame_size": [width, height],
            "note": "SAM3.1 在 %s 上没追踪到人脸（可把文本条件改成 face / 人脸）" % source,
        }

    # 只保留至少在一帧里成立的身份（obj_id 直接就是身份，不再需要 IoU 猜）
    n_obj = len(per_obj[0]) if per_obj else 0
    rgb = np.clip(detect_frames.detach().cpu().float().numpy() * 255.0,
                  0, 255).astype(np.uint8)

    from . import frames as frames_mod
    faces = []
    for j in range(n_obj):
        per_frame = [per_obj[i][j] for i in range(len(per_obj))]
        valid = [(i, b) for i, b in enumerate(per_frame) if b is not None]
        if not valid:
            continue
        best_frame, best_box = max(
            valid, key=lambda ib: (ib[1][2] - ib[1][0]) * (ib[1][3] - ib[1][1]))
        faces.append({
            "index": j,
            "boxes": per_frame,
            "status": "tracked",
            "thumb": frames_mod.make_thumb(rgb[best_frame], best_box),
            # 记录最佳帧在检测序列里的相对位置：修复后解码出的帧数不同，
            # 但按同一比例能找到同一时刻，前后对比才不会错帧。
            "ratio": best_frame / max(1, len(per_frame) - 1),
            "box": best_box,
        })

    # [人数上限] SAM3 的 max_objects 命中上限时会静默丢弃后面的人，
    # 报告必须说出来，否则用户只看到"共 8 个身份"却不知道为什么少了人。
    note = "已用 SAM3.1 记忆追踪 %s，共 %d 个身份" % (source, len(faces))
    if n_obj >= MAX_OBJECTS:
        note += "（已达 %d 人上限，画面里更多人未追踪）" % MAX_OBJECTS
    return {
        "faces": faces,
        "frame_masks": None,
        "backend": "sam3.1",
        "frame_size": [width, height],
        "note": note,
    }
