# -*- coding: utf-8 -*-
"""人脸检测：SAM3.1 记忆追踪（SAM3_VideoTrack），一次会话拿到逐帧逐身份掩码。

**obj_id 是「一段追踪」，不是「一个人」**：遮挡／快转／一帧运动模糊都会让同一个人
另起 id（实测 3 个人出 8 段）。所以本文件在追踪之后还有一层 `*_tracks` 归并，
对外输出的 `faces` 恒为「按人」：一个 entry = 一个人 = 一个修复目标 = 一路预览小视频。

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

SAM3_THRESHOLD = 0.5
# 一段镜头里同时追踪的身份上限（初始掩码也计入）；0 会用内部上限 64，太危险
MAX_OBJECTS = 8
# [重检间隔] 每几帧允许 SAM3 重新检测一次、往记忆里新增 obj_id。
# 原来传 1（逐帧重检，comfy/ldm/sam3/tracker.py:1692 `frame_idx % detect_interval`），
# 后果实测很硬：362 帧逐帧重检 → 同一个人侧脸/正脸/一帧糊脸各算一个新 obj_id，
# 3 个人出 8 段；而 tracker.py:1693-1694 一旦 valid_entries 顶到 max_objects 就
# **整段不再检测**，后来入画的人直接检不到。6 帧 = 0.25 秒才允许新增一次身份，
# 逐帧掩码照常由记忆传播给出（框序列不稀疏），真人入画最多晚 0.25 秒。
DETECT_INTERVAL = 6
# [身份归并] obj_id 是「一段追踪」，不是「一个人」：遮挡、快转、镜头糊一下都会
# 让 tracker 另起 id。判成同一个人的两条路：同帧两个框高度重叠（重复检出），
# 或者一段刚结束下一段就开始且位置尺度接得上（接力）。数值按 2026-11-21 那次
# 真实数据定的：老人三段（侧面 2 段 + 正面 1 段）之间接力位移约 30~90 像素、
# 脸宽约 200 像素，取 0.6×脸宽 = 120 像素上限足够宽松又能挡住跨镜别。
MERGE_DUP_IOU = 0.5          # 同帧重叠到这个程度 = 同一张脸被检了两遍
MERGE_GAP_FRAMES = 24        # 允许约一秒的遮挡；位置须与轨迹外推一致
MERGE_MOVE_FRAC = 0.6        # 接力时中心位移 ÷ 脸宽 的上限
MERGE_SCALE_MIN = 0.6        # 接力前后脸宽比的下限
MERGE_SCALE_MAX = 1.7        # 上限
# 掩码折算成框时，低于这个像素面积视为伪检测
MIN_FACE_SIDE = 8.0
# 默认提示词：SAM3.1 是开放词汇检测；裸 face 会收进牌匾/羽毛纹这类「像脸的纹理」，
# human face 更收紧语义，误检明显少（2026-11-21 用户侧成片实测误检 4/5 为纹理）
DEFAULT_PROMPT = "human face"


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
    这样才敢把阈值往低调去提召回（漏检角色）。
    """
    rows = torch.any(mask, dim=1).nonzero()
    cols = torch.any(mask, dim=0).nonzero()
    if rows.numel() == 0 or cols.numel() == 0:
        return None
    sx, sy = float(scale[0]), float(scale[1])
    y1, y2 = int(rows[0]), int(rows[-1])
    x1, x2 = int(cols[0]), int(cols[-1])
    bw, bh = (x2 - x1 + 1) * sx, (y2 - y1 + 1) * sy
    if bw < MIN_FACE_SIDE or bh < MIN_FACE_SIDE:
        return None
    aspect = bw / max(1e-6, bh)
    if aspect < 0.5 or aspect > 1.8:
        return None
    if frame_h and frame_w:
        frac = (bw * bh) / float(frame_h * frame_w)
        # 小脸按实际像素边长判断，不随成片分辨率提高而被面积占比误删。
        if frac > 0.45:
            return None
    return [x1 * sx, y1 * sy, (x2 + 1) * sx, (y2 + 1) * sy]


def _sam3_track(sam3_model, frames, sam3_cond, threshold=SAM3_THRESHOLD):
    """一次会话跑完整段追踪。

    返回 (逐帧人脸并集遮罩, per_obj [N][K] bbox, W, H)。
    仅保留通过人脸几何过滤的对象遮罩，不把分割结果退化为矩形。
    """
    height, width = int(frames.shape[1]), int(frames.shape[2])
    cls = _video_track_class()
    out = cls.execute(
        images=frames, model=sam3_model, conditioning=sam3_cond,
        detection_threshold=float(threshold), max_objects=MAX_OBJECTS,
        detect_interval=DETECT_INTERVAL)
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
    union = torch.zeros((n, hm, wm), dtype=torch.bool, device=masks.device)
    for i in range(n):
        bboxes = []
        for j in range(k):
            box = _bbox_of(masks[i, j], height, width, scale)
            bboxes.append(box)
            if box is not None:
                union[i] |= masks[i, j].bool()
        per_obj.append(bboxes)
    frame_masks = torch.nn.functional.interpolate(
        union.cpu().float()[:, None], size=(height, width), mode="nearest-exact")[:, 0]
    return frame_masks, per_obj, width, height


def _iou(a, b):
    ix, iy = max(a[0], b[0]), max(a[1], b[1])
    jx, jy = min(a[2], b[2]), min(a[3], b[3])
    iw, ih = max(0.0, jx - ix), max(0.0, jy - iy)
    inter = iw * ih
    union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
    return inter / union if union > 0 else 0.0


def _area(b):
    return max(0.0, b[2] - b[0]) * max(0.0, b[3] - b[1])


def _centre(b):
    return ((b[0] + b[2]) * 0.5, (b[1] + b[3]) * 0.5)


def _is_duplicate(per_obj, a, b):
    """持续重合才归并；同帧分处两地的证据优先，避免擦身时串人。"""
    overlap = []
    for i in range(len(per_obj)):
        ba, bb = per_obj[i][a], per_obj[i][b]
        if ba and bb:
            overlap.append(_iou(ba, bb))
    return bool(overlap) and min(overlap) > 0 and np.mean(
        np.asarray(overlap) >= MERGE_DUP_IOU) >= 0.8


def _is_handoff(per_obj, spans, a, b):
    """一段刚结束下一段就开始、位置尺度接得上 = 同一个人被拆成两段。

    只判「A 末帧 → B 首帧」与反向两种接力；两段长时间并存交给 IoU 判。
    """
    for first, last in ((a, b), (b, a)):
        fa, fb = spans[first], spans[last]
        gap = fb[0] - fa[1]
        if not 1 <= gap <= MERGE_GAP_FRAMES:
            continue
        ba, bb = per_obj[fa[1]][first], per_obj[fb[0]][last]
        if not ba or not bb:
            continue
        wa = max(1e-6, ba[2] - ba[0])
        wb = max(1e-6, bb[2] - bb[0])
        if not MERGE_SCALE_MIN <= wb / wa <= MERGE_SCALE_MAX:
            continue
        ca, cb = _centre(ba), _centre(bb)
        # 用末尾有效观测估计速度；短空档仍用原有位置判据。
        if gap > DETECT_INTERVAL:
            history = [t for t in range(max(fa[0], fa[1] - 6), fa[1])
                       if per_obj[t][first]]
            if len(history) < 2:
                continue
            velocities = [(np.asarray(ca) - _centre(per_obj[t][first])) / (fa[1] - t)
                          for t in history]
            velocity = np.median(velocities, axis=0)
            ca = np.asarray(ca) + velocity * gap
        if ((ca[0] - cb[0]) ** 2 + (ca[1] - cb[1]) ** 2) ** 0.5 \
                <= MERGE_MOVE_FRAC * max(wa, wb):
            return True
    return False


def _group_tracks(per_obj):
    """obj_id → 按人的分组（并查集）。返回 [[obj_id, …], …]，组内与组间都按身份号排序。"""
    if not per_obj or not per_obj[0]:
        return []
    k = len(per_obj[0])
    spans = []
    for j in range(k):
        valid = [i for i in range(len(per_obj)) if per_obj[i][j]]
        spans.append((valid[0], valid[-1]) if valid else None)
    parent = list(range(k))

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    for a in range(k):
        if not spans[a]:
            continue
        for b in range(a + 1, k):
            if not spans[b]:
                continue
            if _is_duplicate(per_obj, a, b) or _is_handoff(per_obj, spans, a, b):
                ra, rb = find(a), find(b)
                if ra != rb:
                    left = [j for j in range(k) if find(j) == ra]
                    right = [j for j in range(k) if find(j) == rb]
                    # 并查集的传递合并也必须服从同帧排他约束。
                    conflict = any(
                        per_obj[t][u] and per_obj[t][v]
                        and _iou(per_obj[t][u], per_obj[t][v]) == 0
                        for u in left for v in right for t in range(len(per_obj)))
                    if not conflict:
                        parent[max(ra, rb)] = min(ra, rb)
    groups = {}
    for j in range(k):
        if not spans[j]:
            continue
        groups.setdefault(find(j), []).append(j)
    return [groups[r] for r in sorted(groups)]


def _merged_boxes(per_obj, members):
    """一组 obj_id → 一条逐帧框序列（同一帧多个成员时取面积最大的那个框）。"""
    out = []
    for i in range(len(per_obj)):
        best = None
        for j in members:
            b = per_obj[i][j]
            if b and (best is None or _area(b) > _area(best)):
                best = b
        out.append(best)
    return out


def detect_faces(detect_frames=None, h3_latent=None, vae=None,
                 sam3_model=None, sam3_cond=None, sam3_threshold=SAM3_THRESHOLD,
                 max_frames=None):
    """主入口。返回 {"faces","frame_masks","backend","frame_size","note"}。

    frame_masks 保留 SAM3 分割轮廓，供裁剪、重绘和贴回共用。
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
        frame_masks, per_obj, width, height = _sam3_track(
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

    # [obj_id ≠ 人] SAM3 的记忆追踪给的是「一段追踪」，遮挡／快转／一帧糊脸都会
    # 让同一个人另起 id。先按人归并（判据见 MERGE_* 注释），再每人出一个目标：
    # 面板按人数开格、预览按人数出小视频、裁剪并集也不会被碎片拉宽。
    n_obj = len(per_obj[0]) if per_obj else 0
    groups = _group_tracks(per_obj)
    from . import frames as frames_mod
    faces = []
    for pos, members in enumerate(groups):
        per_frame = _merged_boxes(per_obj, members)
        valid = [(i, b) for i, b in enumerate(per_frame) if b is not None]
        if not valid:
            continue
        best_frame, best_box = max(valid, key=lambda ib: _area(ib[1]))
        rgb = np.clip(detect_frames[best_frame].detach().cpu().float().numpy() * 255.0,
                      0, 255).astype(np.uint8)
        faces.append({
            "index": pos,
            "boxes": per_frame,
            "status": "tracked",
            "thumb": frames_mod.make_thumb(rgb, best_box),
            # 记录最佳帧在检测序列里的相对位置：修复后解码出的帧数不同，
            # 但按同一比例能找到同一时刻，前后对比才不会错帧。
            "ratio": best_frame / max(1, len(per_frame) - 1),
            "box": best_box,
            # 这个人由哪几段追踪合并而来，只进明细，供「为什么 N 个人」追溯。
            "tracks": list(members),
            "frames_valid": len(valid),
        })

    # [人数上限] SAM3 的 max_objects 命中上限时会静默丢弃后面的人，
    # 报告必须说出来，否则用户只看到"共 8 段"却不知道为什么少了人。
    note = "已用 SAM3.1 记忆追踪 %s，共 %d 个人" % (source, len(faces))
    if len(groups) != n_obj:
        note += "（%d 段追踪已合并）" % n_obj
    if n_obj >= MAX_OBJECTS:
        note += "（追踪段数已达 %d 上限，画面里更多人可能未覆盖）" % MAX_OBJECTS
    return {
        "faces": faces,
        "frame_masks": frame_masks,
        "backend": "sam3.1",
        "frame_size": [width, height],
        "note": note,
    }
