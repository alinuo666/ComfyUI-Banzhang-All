# -*- coding: utf-8 -*-
"""主体重绘共用算法层：遮罩清理、裁剪封装、贴回。

移植自 drozbay/MaskVidExperiments（GPLv3, Copyright (C) 2026 drozbay）。
规划器本体在 banzhang_subject_redraw_planner.py（逐字保留）；本文件只做
节点侧封装：傻瓜式参数收口（tracked/zoomed 固定 firm+stillness 档）、
遮罩清理默认参数固化（shrink_grow 收缩重建 + 边缘外扩 4px）、中文规划报告。
"""

import math

import numpy as np
import torch
from scipy import ndimage

import comfy.utils

from . import banzhang_subject_redraw_planner as planner


# ---- 遮罩外扩 + 边缘柔化（角色替换场景防旧轮廓残留） -----------------------

def grow_soft_mask(masks, grow_px, feather_px=0):
    """遮罩整体外扩 grow_px 像素（灰度膨胀），再做两遍盒模糊柔化边缘（近似高斯）。
    feather_px 是模糊半径：0=自动（外扩量的一半，与拆分前的旧行为逐位一致），
    >0=独立控制过渡带——可以「大外扩+窄羽化」盖住地面投影而不扩大重画过渡。
    为什么在入口做：外扩后的遮罩要同时喂给裁剪规划、latent
    重绘掩码和贴回范围，三处共享同一个盖住旧轮廓环带的遮罩，缺一处就残留。
    贴边不外溢：池化零填充使遮罩长不到画面外。"""
    grow_px, feather_px = int(grow_px), int(feather_px)
    if grow_px <= 0 and feather_px <= 0:
        return masks
    x = masks.detach().float()
    was3d = x.ndim == 3
    if was3d:
        x = x[:, None]          # [T,H,W] → [T,1,H,W]，帧当 batch 维做空间池化
    for _ in range(max(0, grow_px)):
        x = torch.nn.functional.max_pool2d(x, 3, stride=1, padding=1)
    blur = feather_px if feather_px > 0 else max(2, grow_px // 2)
    k = blur * 2 + 1
    # count_include_pad=False：边缘的平均不把补进来的零算进去，贴边不虚
    x = torch.nn.functional.avg_pool2d(x, k, stride=1, padding=blur, count_include_pad=False)
    x = torch.nn.functional.avg_pool2d(x, k, stride=1, padding=blur, count_include_pad=False)
    x = x.clamp(0.0, 1.0)
    return x[:, 0] if was3d else x


# ---- 遮罩清理（原 Mask Cleanup / shrink_grow 法，参数固化） ----------------

def _open_reconstruct(masks, value_thresh, radius, min_frames):
    """收缩重建：腐蚀掉比 2*radius 还细的杂质，幸存核心对应的原始形状全保留
    （含细小凸起），所以对干净遮罩近似恒等。blob 按 时间+空间 三维连通，
    任何一帧有核心就整条轨迹保留；border_value=1 使贴边主体不被腐蚀。"""
    binary = masks.detach().cpu().numpy() > value_thresh
    if not binary.any():
        return binary

    spatial = np.zeros((3, 3, 3), dtype=bool)
    spatial[1] = [[0, 1, 0], [1, 1, 1], [0, 1, 0]]
    eroded = ndimage.binary_erosion(binary, structure=spatial,
                                    iterations=radius, border_value=1)

    labels, count = ndimage.label(binary, structure=np.ones((3, 3, 3), dtype=bool))
    if count == 0:
        return binary

    keep = np.zeros(count + 1, dtype=bool)
    keep[np.unique(labels[eroded])] = True
    if min_frames > 1:
        for label, location in enumerate(ndimage.find_objects(labels), start=1):
            if location is not None and location[0].stop - location[0].start < min_frames:
                keep[label] = False
    keep[0] = False
    return keep[labels]


def clean_mask(masks, threshold=0.5, shrink=4, min_frames=1, edge_grow=4):
    """清理遮罩噪声：去细杂质 + 短命 blob，外扩保软边。返回乘法门控后的遮罩。"""
    keep = _open_reconstruct(masks, threshold, shrink, min_frames)
    if edge_grow > 0:
        spatial = np.zeros((3, 3, 3), dtype=bool)
        spatial[1] = [[0, 1, 0], [1, 1, 1], [0, 1, 0]]
        keep = ndimage.binary_dilation(keep, structure=spatial, iterations=edge_grow)
    gate = torch.from_numpy(keep).to(dtype=masks.dtype, device=masks.device)
    return masks * gate


# ---- 缩放工具（原 nodes_subject_crop.py 移植） -----------------------------

def resize_image(img_hwc, w, h, method="auto"):
    """单帧 HWC 缩放；auto = 放大用 bicubic、缩小用 lanczos。"""
    if img_hwc.shape[0] == h and img_hwc.shape[1] == w:
        return img_hwc
    if method == "auto":
        method = "lanczos" if w * h < img_hwc.shape[1] * img_hwc.shape[0] else "bicubic"
    return comfy.utils.common_upscale(
        img_hwc.movedim(-1, 0).unsqueeze(0), w, h, method, "disabled"
    ).squeeze(0).movedim(0, -1)


def resize_mask(mask_hw, w, h):
    """遮罩统一用最近邻缩放，不产生中间灰度。"""
    if mask_hw.shape[0] == h and mask_hw.shape[1] == w:
        return mask_hw
    return comfy.utils.common_upscale(
        mask_hw[None, None], w, h, "nearest-exact", "disabled"
    )[0, 0]


def _upscale_size(w, h, megapixels, divisible_by):
    """把 w×h 的裁剪缩放到约 |megapixels| 百万像素、落在 divisible_by 网格上。
    正值是下限（已达标则不动）；负值是目标（允许缩小）。"""
    scale = math.sqrt(abs(megapixels) * 1024 * 1024 / (w * h))
    if megapixels > 0 and scale <= 1.0:
        return None
    return (max(1, round(w * scale / divisible_by)) * divisible_by,
            max(1, round(h * scale / divisible_by)) * divisible_by)


# ---- 傻瓜式参数收口 -------------------------------------------------------

def _planner_params(sel, crop_scale, aspect_ratio):
    """standard 节点的 (padding=firm, prefer=stillness) 预设，写死不暴露。"""
    if sel == "combined":
        return {"crop_scale": crop_scale, "aspect_ratio": aspect_ratio}
    return {
        "crop_scale": crop_scale,
        "min_padding_allowed": 0.7,          # firm：承诺的包边至少保 70%
        "min_padding_allowed_window": 16,
        "pad_deficit_tol": 16.0,
        "pad_surplus_tol": 32.0 if sel == "tracked" else 16.0,
        "resize_cost": 2.0,                  # stillness：宁大勿动、宁动勿缩
        "movement_cost": 1.0,
        "center_pull": 1e-4,
        "end_tightening": 0.0,
        "end_tightening_window": 80,
        "zoom_step": 1.0,
        "max_zoom_rate": 0.0,
        "aspect_ratio": aspect_ratio,
        "seamless_loop": False,
    }


# ---- 裁剪（原 SubjectCrop 执行逻辑移植 + 中文报告） ------------------------

_ZH_MODE = {"combined": "静止大框", "tracked": "恒尺寸跟随", "zoomed": "变焦跟随"}


def _zh_report(binary, boxes, scale, sel, info, out_size):
    """规划结果的中文简报：选了什么形状、框多大、动了多少、包边承诺达成几成。"""
    n = len(boxes)
    img_h, img_w = binary.shape[1:]
    ws = [b["width"] for b in boxes]
    hs = [b["height"] for b in boxes]
    cx = np.array([b["x"] + b["width"] / 2 for b in boxes])
    cy = np.array([b["y"] + b["height"] / 2 for b in boxes])
    travel = float(np.hypot(np.diff(cx), np.diff(cy)).sum())
    ar = info["aspect"]
    mode_name = "全帧直通" if sel == "combined" and scale <= 0 else _ZH_MODE[sel]

    lines = [
        f"模式: {mode_name}",
        f"帧数: {n}（源 {img_w}x{img_h}）",
        f"画幅: {ar:.2f}",
    ]
    if info.get("swept"):
        lines[2] += f"（从 {info['candidates']} 个候选中选出）"
    lines += [
        f"最小框: {min(ws)}x{min(hs)}  最大框: {max(ws)}x{max(hs)}",
        f"输出尺寸: {out_size[0]}x{out_size[1]}",
        f"框移动总量: {travel:.0f}px",
    ]
    if sel == "zoomed" and not (sel == "combined" and scale <= 0):
        lines.append(f"变焦倍率: {max(hs) / max(min(hs), 1):.2f}")
    if scale > 1.0:
        # 包边承诺达成率：逐帧算四边实际留白占承诺包边的比例
        worst = []
        for i in range(n):
            ys, xs = binary[i].nonzero()
            if len(xs) == 0:
                continue
            b = boxes[i]
            bx1 = b["x"] + b["width"] - 1
            by1 = b["y"] + b["height"] - 1
            wx = max((scale - 1) / 2 * (xs.max() - xs.min() + 1), 1e-6)
            wy = max((scale - 1) / 2 * (ys.max() - ys.min() + 1), 1e-6)
            fr = []
            if b["x"] > 0:
                fr.append((xs.min() - b["x"]) / wx)
            if bx1 < img_w - 1:
                fr.append((bx1 - xs.max()) / wx)
            if b["y"] > 0:
                fr.append((ys.min() - b["y"]) / wy)
            if by1 < img_h - 1:
                fr.append((by1 - ys.max()) / wy)
            if fr:
                worst.append(min(fr))
        if worst:
            lines.append(f"包边承诺: 主体尺寸的 {(scale - 1) / 2:.0%}/边，"
                         f"最差达成 {max(min(worst), 0):.0%}，"
                         f"典型 {max(float(np.median(worst)), 0):.0%}")
    return "\n".join(lines)


def plan_and_crop(original_images, masks, sel, crop_scale, aspect_ratio,
                  divisible_by, upscale_megapixels=0.0, resize_method="auto",
                  *, crop_padding=None, long_edge=None):
    """清理后的完整裁剪端：规划每帧裁剪框 → 切片/重采样 → 返回（帧、遮罩、框、报告）。
    crop_scale<=0 时不裁剪，全帧按网格重整后直通。"""
    if original_images.shape[0] != masks.shape[0]:
        raise ValueError(f"原始帧 {original_images.shape[0]} 帧与遮罩 {masks.shape[0]} 帧数量不一致")
    if original_images.shape[1:3] != masks.shape[1:3]:
        raise ValueError(f"原始帧与遮罩尺寸不一致（帧 {original_images.shape[2]}x{original_images.shape[1]}，"
                         f"遮罩 {masks.shape[2]}x{masks.shape[1]}）")
    if 0.0 < crop_scale < 1.0:
        raise ValueError("包边比例只能是 0（全帧直通）或不小于 1.0")

    full_frame = crop_scale <= 0.0
    # 阈值 0.1：羽化边缘算主体、数值噪声尾巴不算（原节点同款）
    binary = masks.detach().cpu().numpy() > 0.1
    if crop_padding is not None and crop_padding >= 0:
        # 只扩大规划视野，采样遮罩仍使用原脸区。
        padding = int(crop_padding)
        if padding:
            binary = ndimage.maximum_filter(binary, size=(1, 2*padding+1, 2*padding+1))
        crop_scale = 1.0
        full_frame = False
    if full_frame:
        img_h, img_w = masks.shape[1], masks.shape[2]
        boxes = [{"x": 0, "y": 0, "width": img_w, "height": img_h}
                 for _ in range(masks.shape[0])]
        info = {"aspect": img_w / img_h}
    else:
        if not binary.any():
            raise ValueError("所有遮罩都是空的，没有可裁剪的主体")
        boxes, info = planner.plan(binary, sel, _planner_params(sel, crop_scale, aspect_ratio),
                                   divisible_by)

    bw = max(b["width"] for b in boxes)
    bh = max(b["height"] for b in boxes)
    size = None
    if sel == "zoomed" and not full_frame:
        # 目标尺寸取最大规划框：那段近似 1:1，其余帧只放大不丢细节
        th = math.ceil(bh / divisible_by) * divisible_by
        size = (math.ceil(th * info["aspect"] / divisible_by) * divisible_by, th)
    else:
        gw = math.ceil(bw / divisible_by) * divisible_by
        gh = math.ceil(bh / divisible_by) * divisible_by
        if (gw, gh) != (bw, bh):
            size = (gw, gh)
    if long_edge is not None and long_edge > 0:
        sw, sh = size or (bw, bh)
        scale = max(1.0, long_edge / max(sw, sh))
        size = (max(divisible_by, round(sw * scale / divisible_by) * divisible_by),
                max(divisible_by, round(sh * scale / divisible_by) * divisible_by))
    elif (long_edge is None or long_edge < 0) and upscale_megapixels != 0:
        up = _upscale_size(*(size or (bw, bh)), upscale_megapixels, divisible_by)
        if up is not None:
            size = up

    report = _zh_report(binary, boxes, crop_scale, sel, info, size or (bw, bh))

    if size is not None:
        tw, th = size
        cropped_images = torch.stack([
            resize_image(original_images[i, b["y"]:b["y"] + b["height"],
                                         b["x"]:b["x"] + b["width"], :], tw, th, resize_method)
            for i, b in enumerate(boxes)
        ])
        cropped_masks = torch.stack([
            resize_mask(masks[i, b["y"]:b["y"] + b["height"],
                              b["x"]:b["x"] + b["width"]], tw, th)
            for i, b in enumerate(boxes)
        ])
    else:
        cropped_images = torch.stack([
            original_images[i, b["y"]:b["y"] + b["height"], b["x"]:b["x"] + b["width"], :]
            for i, b in enumerate(boxes)
        ])
        cropped_masks = torch.stack([
            masks[i, b["y"]:b["y"] + b["height"], b["x"]:b["x"] + b["width"]]
            for i, b in enumerate(boxes)
        ])
    return cropped_images, cropped_masks, [[b] for b in boxes], report


# ---- 贴回（原 SubjectUncrop 执行逻辑移植） ---------------------------------

def uncrop(original_images, cropped_images, bboxes, cropped_masks,
           feather, resize_method="auto", *, feather_mask=False):
    """把处理过的裁剪帧羽化贴回原帧。裁剪框不接时视为全帧；框/遮罩单帧时广播。
    裁剪框越出画面边界时自动把帧撑到模型画布 / 把坐标钳进界内，不再抛张量尺寸错误。"""
    if bboxes is None:
        bboxes = {"x": 0, "y": 0,
                  "width": original_images.shape[2], "height": original_images.shape[1]}
    if isinstance(bboxes, dict):
        frames = None
    elif isinstance(bboxes, list) and bboxes and all(isinstance(f, list) and f for f in bboxes):
        frames = bboxes
    else:
        raise ValueError("裁剪框格式不对：应为单框或每帧一组的框列表")

    # 单帧框/单帧遮罩广播，不压缩帧数
    counts = {"cropped_images": cropped_images.shape[0],
              "original_images": original_images.shape[0]}
    if frames is not None and len(frames) > 1:
        counts["bboxes"] = len(frames)
    if cropped_masks is not None and cropped_masks.shape[0] > 1:
        counts["cropped_masks"] = cropped_masks.shape[0]
    n = min(counts.values())
    if n < max(counts.values()):
        got = ", ".join(f"{k}={v}" for k, v in counts.items())
        print(f"⚠️ [主体重绘·贴回] 各输入帧数不一致（{got}），只取前 {n} 帧合成")

    cropped_images = cropped_images[:n]
    original_images = original_images[:n]
    if cropped_masks is not None:
        cropped_masks = (cropped_masks.expand(n, -1, -1)
                         if cropped_masks.shape[0] == 1 else cropped_masks[:n])
    if frames is None:
        boxes = [bboxes] * n
    else:
        boxes = [f[0] for f in (frames * n if len(frames) == 1 else frames[:n])]

    img_h, img_w = original_images.shape[1], original_images.shape[2]
    # 越界护栏：裁剪框右/下越界（裁剪链与本节点画的画布口径不一致，或外部接来的框）
    # 时把帧+遮罩撑到裁剪节点「自动对齐模型画布」同款画布再贴；负起点只做逐帧钳位，
    # 防 region 切片环绕取到对面边缘的像素。两种情况对正常不越界的框都是 no-op。
    grow = (max(b["x"] + b["width"] for b in boxes) > img_w
            or max(b["y"] + b["height"] for b in boxes) > img_h)
    if grow:
        from .banzhang_h3_sample_core import _adapt_canvas  # 同包兄弟模块；延后导入，避开模块加载顺序问题
        img_w, img_h = _adapt_canvas(img_w, img_h)
        original_images = comfy.utils.common_upscale(
            original_images.movedim(-1, 1), img_w, img_h, "lanczos", "disabled"
        ).movedim(1, -1)
        print(f"⚠️ [主体重绘·贴回] 裁剪框越出原始帧边界，已撑到模型画布 "
              f"{img_w}x{img_h} 再贴回（裁剪链若用了别的画布口径，边缘会轻微挤压）")
    out = original_images.clone()
    for i, b in enumerate(boxes):
        # BOUNDING_BOX 载荷只是约定，SAM3 会给浮点坐标
        x, y, w, h = (int(round(b[k])) for k in ("x", "y", "width", "height"))
        x = max(0, min(x, img_w - 1))
        y = max(0, min(y, img_h - 1))
        w = max(1, min(w, img_w - x))
        h = max(1, min(h, img_h - y))
        # 途中被重采样过的裁剪（变焦模式/放大参数/中间接了缩放节点）在这里缩回原框
        crop = resize_image(cropped_images[i], w, h, resize_method)

        alpha = torch.ones(h, w, dtype=out.dtype, device=out.device)
        fx, fy = min(feather, w // 2), min(feather, h // 2)
        if fy > 0:
            ramp = torch.linspace(0, 1, fy + 2, dtype=out.dtype, device=out.device)[1:-1]
            if y > 0:
                alpha[:fy, :] *= ramp[:, None]
            if y + h < img_h:
                alpha[h - fy:, :] *= ramp.flip(0)[:, None]
        if fx > 0:
            ramp = torch.linspace(0, 1, fx + 2, dtype=out.dtype, device=out.device)[1:-1]
            if x > 0:
                alpha[:, :fx] *= ramp[None, :]
            if x + w < img_w:
                alpha[:, w - fx:] *= ramp.flip(0)[None, :]

        if cropped_masks is not None:
            m = resize_mask(cropped_masks[i], w, h)
            if feather_mask and feather > 0:
                # 在成片像素坐标内沿脸区并集向内渐变；贴到裁剪框边缘时由上面的渐变接管。
                inside = m.detach().cpu().numpy() > 0
                if inside.any() and not inside.all():
                    distance = ndimage.distance_transform_cdt(inside, metric="chessboard")
                    weight = np.minimum(distance.astype(np.float32) / (feather + 1), 1.0)
                    m = m * torch.from_numpy(weight).to(m)
            alpha = alpha * m.clamp(0.0, 1.0).to(dtype=out.dtype, device=out.device)

        alpha = alpha[..., None]
        region = out[i, y:y + h, x:x + w, :]
        out[i, y:y + h, x:x + w, :] = crop.to(region) * alpha + region * (1 - alpha)

    return out
