# -*- coding: utf-8 -*-
"""互动分组：把挨得近、有重叠的脸归成一组，组内联合裁块渲染。

为什么按「组」而不是按「脸」：多人同框挨得近时，逐脸裁块渲染会让两个人
互相"看不见"——对视、说话接话全部破功，贴回还会互相覆盖。同一组的人在
同一个裁剪区域里一起渲染，互动与光照天然保住；组与组之间互不干扰。
"""

import numpy as np


def _box_center(box):
    return ((box[0] + box[2]) / 2.0, (box[1] + box[3]) / 2.0)


def _boxes_overlap(a, b, gap):
    """两框外扩 gap 后是否相交（像素单位）。"""
    return not (a[2] + gap < b[0] or b[2] + gap < a[0]
                or a[3] + gap < b[1] or b[3] + gap < a[1])


def _track_mean_box(face):
    """track 的平均框（忽略丢帧的 None），作为聚类依据。"""
    boxes = [b for b in face["boxes"] if b is not None]
    if not boxes:
        return None
    arr = np.array(boxes, dtype=np.float32)
    return arr.mean(axis=0).tolist()


def group_faces(faces, max_gap=80):
    """把 track 聚成互动组。

    判据：平均框外扩 max_gap 像素后相交 → 同组（并查集连通）。
    max_gap=0 表示只有真正重叠才成组。
    返回 [{"members": [face 下标]}]，无脸返回 []。
    """
    boxes = [_track_mean_box(f) for f in faces]
    n = len(faces)
    parent = list(range(n))

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    for i in range(n):
        if boxes[i] is None:
            continue
        for j in range(i + 1, n):
            if boxes[j] is None:
                continue
            if _boxes_overlap(boxes[i], boxes[j], max_gap):
                parent[find(i)] = find(j)

    groups = {}
    for i in range(n):
        groups.setdefault(find(i), []).append(i)
    return [{"members": sorted(m)} for m in groups.values()]


def _smooth(values, radius=2):
    """组框时间平滑（滑动平均）：脸在动，但裁剪窗口不该抖。"""
    n = len(values)
    out = []
    for i in range(n):
        lo, hi = max(0, i - radius), min(n, i + radius + 1)
        seg = [v for v in values[lo:hi] if v is not None]
        if seg:
            arr = np.array(seg, dtype=np.float32)
            out.append(arr.mean(axis=0).tolist())
        else:
            out.append(None)
    return out


def group_frame_boxes(faces, members, n_frames, margin=24,
                      frame_w=None, frame_h=None):
    """逐帧计算组的联合框：组内所有脸框取并集，外扩 margin，时间平滑。

    某帧组内所有脸丢失时，沿用最近有效帧的框（H3 对静止窗口渲染更稳）。
    给了 frame_w/frame_h 时右/下也裁到画面内 —— 半出画面的框裁出来会被
    下游 clamp，有效区域宽高比失真，等比画布放大就白费了。
    返回长度 n_frames 的框列表（[x1,y1,x2,y2]，画面坐标）。
    """
    raw = []
    for t in range(n_frames):
        boxes = [faces[i]["boxes"][t] for i in members if t < len(faces[i]["boxes"])]
        boxes = [b for b in boxes if b is not None]
        if boxes:
            arr = np.array(boxes, dtype=np.float32)
            x1, y1 = arr[:, 0].min(), arr[:, 1].min()
            x2, y2 = arr[:, 2].max(), arr[:, 3].max()
            raw.append([x1, y1, x2, y2])
        else:
            raw.append(None)

    filled = list(raw)
    last = None
    for i, b in enumerate(filled):        # 向前补
        if b is not None:
            last = b
        elif last is not None:
            filled[i] = last
    for i in range(len(filled) - 1, -1, -1):   # 向后补开头
        if filled[i] is None and last is not None:
            filled[i] = last
        elif filled[i] is not None:
            last = filled[i]

    smoothed = _smooth(filled)
    out = []
    for b in smoothed:
        x1 = max(0.0, b[0] - margin)
        y1 = max(0.0, b[1] - margin)
        x2, y2 = b[2] + margin, b[3] + margin
        if frame_w:
            x2 = min(float(frame_w), x2)
        if frame_h:
            y2 = min(float(frame_h), y2)
        out.append([x1, y1, x2, y2])
    return out
