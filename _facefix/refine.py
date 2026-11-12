# -*- coding: utf-8 -*-
"""像素域脸块精修（拼贴画布 + 高频残差版）：多脸拼一张 → 一次采样 → 残差贴回。

[拼贴画布] 逐脸/逐组采样时，每次采样都独立判断口型与光照，多人同框就会各说
各的（真机实测「多人说话乱」）。拼成一张画布后所有脸共享同一次采样，口型、
光线、清晰度天然一致，采样次数也从 N 次降到 1 次。

[高频残差·加法注入 v3] 采样结果不直接替换原帧，也不替换原帧的高频 —— 6 步
采样经 VAE 往返的高频比成片更软，替换会把脸弄糊（真机实测）。贴回 = 原帧 +
采样高频残差 ×gain，残差过四道治理：亮度投影（色彩永远走原帧，采样偏色/
颜色闪烁被结构性排除）→ 块匹配光流对齐平均（帧间平移先对齐再平均，运动
细节不拖糊、噪声仍被平均）→ 纹理感知加权（眼/嘴/眉纹理区全量、平坦区压
光斑）→ 自适应软钳制（平坦区收紧、纹理区放松）。

每格边长 = 脸框长边 × 放大倍数（再由人数决定 1×1/2×1/2×2/4×2 排布）。
脸块先用像素域放大模型真放大再进格子（crop 小于格宽时才跑），
采样拿到的才是有细节的输入。
"""

import os

import numpy as np
import torch
import torch.nn.functional as F

_DEBUG_DIR = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "_selftest_out", "facefix_debug")


def _save_debug(img, name):
    """把 [H,W,3] 0-1 张量存成 PNG：确诊「错位发生在采样还是贴回」的唯一手段。

    输入画布（in）与采样输出（out）各存首帧 —— out 里内容若已挪位，是模型
    把网格当场景重排（降降噪 / 加上下文）；out 正常而成片错位，才是几何问题。
    """
    try:
        import cv2
        os.makedirs(_DEBUG_DIR, exist_ok=True)
        arr = (img.detach().clamp(0.0, 1.0).cpu().numpy() * 255.0).astype(np.uint8)
        cv2.imwrite(os.path.join(_DEBUG_DIR, name),
                    cv2.cvtColor(arr, cv2.COLOR_RGB2BGR))
    except Exception:
        pass


# [细节增益] 高频残差的放大系数。1.0 = 采样的细节全量叠加；如果真机出现
# 「锐化过头/白边」就降到 0.5，等低频漂移曲线出齐再决定是否升为面板参数。
_DETAIL_GAIN = 1.0
# [残差钳制] 软钳制幅度：真实纹理残差小（一般 <0.15），采样幻觉出来的
# 大块光斑幅度大 —— 超过它的部分被 tanh 平滑压扁，纹理正常通过。
# 0.25→0.35：0.25 连参数差异一起压没了（真机反馈「调了没反应」），
# 放宽后细节/降噪的调节可见；光斑仍被压（幻觉幅度 0.5+）。
_DETAIL_CLAMP = 0.35

# [贴回区权重保底] 贴回掩码核心区（脸框 + 外扩）内的残差权重不低于此值。
# 旧版纹理权重在平坦区压到 0.25，外扩环带（脸框外的平坦背景）因此「有范围、
# 没内容」，外扩调多少成片都看不见。核心区是用户明确要求修复的范围，给保底；
# 核心区之外（喂给模型的上下文环带，不进成片）维持原纹理权重。
_CORE_W_FLOOR = 0.55

# [去斑平滑核] 平坦区残差的 3×3 均值平滑：只压孤立像素振荡（少步高降噪未收敛的
# 椒盐斑），门控混合保证五官纹理区一像素都不被平滑。
_DESPECKLE_K = 3

# [亮度分离] Rec.601 亮度系数：残差只保留沿这个方向的分量
_LUMA_W = (0.299, 0.587, 0.114)


def _smooth2d(x, k=9):
    """小核均值平滑（局部纹理能量聚合用），保持尺寸。"""
    y = F.avg_pool2d(x[None, None], k, stride=1, padding=k // 2)
    return y[0, 0]


def _shift2d(x, dx, dy):
    """整像素平移，越界补零（位移只有几像素，边缘效应可忽略）。"""
    if dx == 0 and dy == 0:
        return x
    h, w = int(x.shape[0]), int(x.shape[1])
    out = torch.zeros_like(x)
    ys, xs = max(0, -dy), max(0, -dx)
    yd, xd = max(0, dy), max(0, dx)
    hh, ww = min(h - ys, h - yd), min(w - xs, w - xd)
    out[yd:yd + hh, xd:xd + ww] = x[ys:ys + hh, xs:xs + ww]
    return out


def _best_shift(cur, prev, radius=3):
    """块匹配：±radius 像素内找让 prev 对上 cur 的整数平移（光流的轻量版，
    不上 RAFT —— 脸在格子里帧间只挪几像素，整像素搜索够用且零依赖）。
    返回 (dx, dy)，把 prev 平移 (dx, dy) 后与 cur 最吻合。"""
    m = radius
    a = cur[m:-m:2, m:-m:2]                    # 隔行采样，省 4 倍计算
    best, bs = (0, 0), None
    for dy in range(-radius, radius + 1):
        for dx in range(-radius, radius + 1):
            b = _shift2d(prev, dx, dy)[m:-m:2, m:-m:2]
            d = float((a - b).abs().mean())
            if bs is None or d < bs:
                bs, best = d, (dx, dy)
    return best


def _texture_maps(orig_high, clamp, k=9):
    """[纹理感知] 从原帧高频能量导出两张图：
    weight —— 残差权重（0.25~1.75 倍，均值≈1）：纹理区全量、平坦区压低；
    amp —— 自适应钳制幅度（0.6~1.4 倍 clamp）：平坦区收紧、纹理区放松。
    眼/嘴/眉的高频能量天然大、平坦皮肤天然小 —— 用它当权重，等于零成本
    近似「五官区全量、边缘衰减」，还顺手把平坦区的幻觉光斑双重压制。"""
    energy = _smooth2d(orig_high.abs().mean(-1), k)
    norm = energy / (float(energy.mean()) + 1e-6)
    weight = norm.clamp(0.25, 1.75)
    amp = (clamp * (0.6 + 0.4 * norm)).clamp(0.6 * clamp, 1.4 * clamp)
    return weight[..., None], amp[..., None]


def _low_freq(x, down=8):
    """低频分量：双线性降 down 倍再升回原尺寸。256px 格子经 32px 中转，
    保留脸的位置/大小/朝向/嘴型这些大尺度结构，8px 以下的细节全部剥离。"""
    h, w = int(x.shape[0]), int(x.shape[1])
    small = F.interpolate(
        x.permute(2, 0, 1)[None].float(),
        size=(max(1, h // down), max(1, w // down)),
        mode="bilinear", align_corners=False)
    return F.interpolate(small, size=(h, w), mode="bilinear",
                         align_corners=False)[0].permute(1, 2, 0)


def fuse_detail(orig, samp, gain=_DETAIL_GAIN, down=8, ema_prev=None,
                clamp=_DETAIL_CLAMP, core_box=None):
    """[高频残差·加法注入 v3] fused = 原帧 + 残差×gain，返回 (fused, drift, ema)。

    残差流水线（每格每帧）：
      1. [亮度分离] 残差投影到亮度方向：明暗细节来自采样，色彩永远走原帧
         —— 采样偏色和颜色闪烁被结构性排除（②）。
      2. [光流对齐平均] 块匹配找帧间平移（±3px 整像素），先对齐再平均 ——
         运动中的纹理不被时间低通拖糊，噪声照样被平均掉；EMA 旧版会把
         动起来的细节拖成残影（①）。
      3. [纹理感知加权] 权重 = 原帧高频能量（平滑归一，0.25~1.75 倍）：
         眼/嘴/眉等纹理区全量叠加，平坦皮肤/盒内背景压到 0.25 倍 ——
         幻觉光斑长在平坦区，纹理区不受影响（③）。贴回核心区（脸框+外扩）
         权重保底 _CORE_W_FLOOR，外扩环带的修复才进得去成片。
      4. [平坦区去斑] 残差做 3×3 平滑，按纹理门控混合：平坦区取平滑值
         （少步高降噪的孤立椒盐斑被抹掉），纹理区取原值，五官不糊。
      5. [自适应钳制] 钳制幅度随局部纹理 0.6~1.4 倍浮动：平坦区收紧、
         纹理区放松，光斑压得更准（⑤）。

    core_box = (x1,y1,x2,y2)，本格坐标系里的贴回核心区（贴回掩码实际采纳的
    范围）；None 时不做保底（老自检/单测路径）。

    ema_state = 亮度残差 [H,W,1]（对齐平均后、加权钳制前），供下一帧对齐。
    drift = |采样低频 − 原帧低频| 均值（证据链指标）。
    """
    l0 = _low_freq(orig, down)
    l1 = _low_freq(samp, down)
    drift = float((l1 - l0).abs().mean())
    orig_high = orig.float() - l0
    resid = samp.float() - l1
    wy = resid.new_tensor(_LUMA_W)
    resid_y = (resid * wy).sum(-1, keepdim=True)          # [H,W,1] 亮度残差
    if ema_prev is not None:
        dx, dy = _best_shift(resid_y, ema_prev)
        s_y = 0.5 * resid_y + 0.5 * _shift2d(ema_prev, dx, dy)
    else:
        s_y = resid_y
    weight, amp = _texture_maps(orig_high, clamp)
    if core_box is not None:
        # 贴回核心区保底：核心区里权重不低于 _CORE_W_FLOOR，外扩环带（平坦）
        # 不再被 0.25 压没；核心区外是上下文环带，不进成片，维持原权重。
        hh, ww = int(weight.shape[0]), int(weight.shape[1])
        cm = torch.zeros(hh, ww, 1, device=weight.device, dtype=weight.dtype)
        cx1, cy1, cx2, cy2 = core_box
        cm[max(0, int(cy1)):min(hh, max(0, int(cy2))),
           max(0, int(cx1)):min(ww, max(0, int(cx2)))] = _CORE_W_FLOOR
        weight = torch.maximum(weight, cm)
    # [平坦区去斑] 门控 = 纹理权重归一到 0~1：平坦区→0（取平滑值），
    # 纹理区→1（取原值）。保底后的外扩环带 gate≈0.2，残差仍偏柔和。
    s_smooth = _smooth2d(s_y[..., 0], _DESPECKLE_K)[..., None]
    gate = ((weight - 0.25) / (1.75 - 0.25)).clamp(0.0, 1.0)
    s_y = s_y * gate + s_smooth * (1.0 - gate)
    out = s_y * wy * weight                               # 亮度残差 → RGB × 权重
    out = torch.tanh(out / amp) * amp
    fused = (orig.float() + out * float(gain)).clamp(0.0, 1.0)
    return fused.to(orig.dtype), drift, s_y


# [放大模型缓存] 模块级缓存：禁止每次执行重新加载权重
_UPSCALE_CACHE = {}
_NO_MODEL_PREFIX = "（"


def _get_upscale_model(name):
    """按名加载像素域放大模型并缓存；返回 None = 不用模型。"""
    if not name or str(name).startswith(_NO_MODEL_PREFIX):
        return None
    if name in _UPSCALE_CACHE:
        return _UPSCALE_CACHE[name]
    from comfy_extras.nodes_upscale_model import UpscaleModelLoader
    out = UpscaleModelLoader.execute(model_name=name)
    try:
        mdl = out.result[0]
    except Exception:
        mdl = out.args[0]
    _UPSCALE_CACHE[name] = mdl
    return mdl


def _model_upscale(tile, model):
    """[模型放大] 用像素域放大模型把脸块真放大（不是双线性糊块）。
    tile [h,w,3] 0-1 → [H,W,3]。no_grad；显存由 ComfyUI tiled_scale 自己管。"""
    import torch
    from comfy_extras.nodes_upscale_model import ImageUpscaleWithModel
    with torch.no_grad():
        out = ImageUpscaleWithModel.execute(model, tile[None].float())
    try:
        up = out.result[0]
    except Exception:
        up = out.args[0]
    return up[0].float().cpu().clamp(0.0, 1.0)


def _crop_resize(frame, box, size, up_model=None):
    """按框裁剪 → 等比缩放 → 居中补边到 size×size，返回 (tile, rect, pad)。

    [等比] 组框宽高比典型 0.85，直接拉伸到正方形等于把脸横向压扁 15%，模型在
    变形脸上重绘、贴回再反拉一次 → 双重形变。等比 + 居中补边没有这个问题。
    补边用边缘复制：零填充会让模型把画布边界当黑框一起重绘。

    [单一真值] rect=(x1,y1,cw,ch) 是实际裁剪到的整数矩形，贴回照抄不重算；
    浮点框在 .5 边界会差 1px，框被画面裁边时差更多。
    pad=(ox,oy,nw,nh) 是等比内容在画布里的位置，贴回按它取回内容。
    FaceDetailer 的 crop → bbox → paste 三件套就是这个道理：只算一次，一路传。
    """
    h, w = frame.shape[:2]
    x1, y1, x2, y2 = box
    x1, y1 = max(0.0, x1), max(0.0, y1)
    x2, y2 = min(float(w), x2), min(float(h), y2)
    if x2 - x1 < 2 or y2 - y1 < 2:
        return None, None, None
    x1i, y1i, x2i, y2i = int(x1), int(y1), int(x2), int(y2)
    cw, ch = x2i - x1i, y2i - y1i
    if cw < 2 or ch < 2:
        return None, None, None
    crop = frame[y1i:y2i, x1i:x2i]
    cw0, ch0 = cw, ch      # rect 用裁剪原始尺寸（贴回坐标的唯一真值）
    # [模型放大] 只在需要放大时跑：crop 已比目标格大就双线性缩（缩不丢细节，
    # 白跑一次前向不值）。放大后按新尺寸算等比缩放，rect 不变。
    if up_model is not None and max(cw, ch) < int(size):
        crop = _model_upscale(crop, up_model)
        ch, cw = int(crop.shape[0]), int(crop.shape[1])
    s = float(size) / float(max(cw, ch))
    nw = max(1, min(int(size), int(round(cw * s))))
    nh = max(1, min(int(size), int(round(ch * s))))
    t = crop.permute(2, 0, 1)[None].float()
    t = F.interpolate(t, size=(nh, nw), mode="bilinear", align_corners=False)
    ox, oy = (int(size) - nw) // 2, (int(size) - nh) // 2
    t = F.pad(t, (ox, int(size) - nw - ox, oy, int(size) - nh - oy),
              mode="replicate")
    return t[0].permute(1, 2, 0), (x1i, y1i, cw0, ch0), (ox, oy, nw, nh)


def _feather_mask(h, w, box, feather):
    """脸框实心 + 高斯羽化的贴回掩码 [H,W]。"""
    import cv2
    m = np.zeros((h, w), dtype=np.float32)
    x1, y1, x2, y2 = box
    m[int(max(0, y1)):int(min(h, y2)), int(max(0, x1)):int(min(w, x2))] = 1.0
    if feather > 0:
        k = int(feather * 2) + 1
        m = cv2.GaussianBlur(m, (k, k), 0)
    return np.clip(m, 0.0, 1.0)


def paste_tile(out, t, tile, rect, pad, size, feather, W, H, context=0):
    """把一格精修后的脸块贴回 out[t]，out 是 [T,H,W,3]。

    rect / pad 必须来自 _crop_resize 的返回值，**不要传浮点脸框** —— 这里不做
    任何取整，取整只在裁剪那一刻发生。先按 pad 取回等比内容，再缩回 rect 尺寸。

    [上下文独占]（借鉴终极放大的 overlap 边带思路）：context > 0 时贴回掩码
    从矩形边缘向内缩 context 像素 —— 格子外圈是喂给模型的上下文，它的重绘
    结果**不进成片**，只有核心脸区被采纳，向外羽化过渡。

    [贴回索引] out 是 4D 帧序列，dim0 是时间 —— 必须 out[t, y1:y2, x1:x2]。
    返回实际写入的像素数；0 表示矩形完全在画面外，什么都没写。
    """
    ox, oy, nw, nh = [int(v) for v in pad]
    sub = tile[oy:oy + nh, ox:ox + nw]
    if sub.numel() == 0:
        return 0
    x1, y1, cw, ch = [int(v) for v in rect]
    x2, y2 = min(W, x1 + cw), min(H, y1 + ch)
    if x2 <= x1 or y2 <= y1:
        return 0
    back = F.interpolate(
        sub.permute(2, 0, 1)[None].float(), size=(ch, cw),
        mode="bilinear", align_corners=False)[0].permute(1, 2, 0).clamp(0.0, 1.0)
    if context > 0:
        mask = _feather_mask(ch, cw, (context, context,
                                      cw - context, ch - context), feather)
    else:
        mask = _feather_mask(ch, cw, (0, 0, cw, ch), feather)
    m = torch.from_numpy(mask)[:y2 - y1, :x2 - x1][..., None].to(out.device, out.dtype)
    region = out[t, y1:y2, x1:x2]
    out[t, y1:y2, x1:x2] = (
        back[:y2 - y1, :x2 - x1].to(out.device, out.dtype) * m + region * (1 - m))
    return int((y2 - y1) * (x2 - x1))


def _batch_layout(n, cell_size):
    """(画布宽, 画布高, 列, 行, 格边长)。cell_size = 脸框长边 × 放大倍数 ——
    每格就是一格脸，格子不再按人数缩水。"""
    cols, rows = 1, 1
    if n == 2:
        cols, rows = 2, 1
    elif 2 < n <= 4:
        cols, rows = 2, 2
    elif n > 4:
        cols, rows = 4, 2
    cell = max(128, min(768, int(cell_size)))
    # 画布面积上限 1.2MP：8 人 ×512 格会到 2048×1024，H3 token 量会爆
    while cell > 128 and cell * cols * cell * rows > 1200000:
        cell //= 2
    # [stride 对齐] 格宽必须是 16 的倍数：VAE 按 stride 取整，任意尺寸会让
    # 解码尺寸与画布差几像素，拆格切片直接 shape 冲突（331 vs 343 事故）。
    # 固定 256 时代没暴露，改成「脸框×倍数」后才炸。
    cell = max(128, (cell // 16) * 16)
    return cell * cols, cell * rows, cols, rows, cell


def _expand_box(box, margin, W, H):
    """脸框外扩并裁到画面内。"""
    if box is None:
        return None
    return [max(0.0, box[0] - margin), max(0.0, box[1] - margin),
            min(float(W), box[2] + margin), min(float(H), box[3] + margin)]


def _smooth_track(boxes, radius=2):
    """框序列时间平滑（滑动平均）：SAM3 的掩码逐帧抖，bbox 跟着抖 ——
    裁块/贴回都用它的话，脸会在成片里小幅晃动。半径 2 抹掉高频抖动，
    慢速真实运动保留；丢帧（None）不参与平均。"""
    n = len(boxes)
    out = []
    for i in range(n):
        lo, hi = max(0, i - radius), min(n, i + radius + 1)
        seg = [b for b in boxes[lo:hi] if b is not None]
        if seg:
            arr = np.array(seg, dtype=np.float32)
            out.append(arr.mean(axis=0).tolist())
        else:
            out.append(None)
    return out


def refine_batches(images, faces, model, positive, vae,
                   upscale=2.0, upscale_model="", denoise=0.3, steps=6,
                   feather=24, detail_gain=1.0, margin=0, seed=0, log=None,
                   max_faces=8):
    """多脸拼一张画布，一次采样后各自贴回。返回修好的帧序列 [T,H,W,3]。

    images [T,H,W,3] float 0-1（成片像素帧）。单批失败只跳过该批。
    """
    import comfy.nested_tensor
    import comfy.model_management as mg

    from . import inpaint

    device = mg.get_torch_device()
    out = images.clone()
    T, H, W = int(images.shape[0]), int(images.shape[1]), int(images.shape[2])
    if not faces:
        return out

    # [框平滑] 见 _smooth_track：用副本，不动 pipeline 共享的检测对象
    smooth_faces = [dict(f, boxes=_smooth_track(f.get("boxes") or []))
                    for f in faces]

    # [羽化自适应] 固定 24px 对 60×70 的小脸是灾难：49×49 高斯核几乎盖住整块，
    # 掩码被稀释成半透明，贴回≈没贴。按最小脸框短边收口。
    face_short = min(
        [min(max(1, b[2] - b[0]), max(1, b[3] - b[1]))
         for f in smooth_faces for b in f["boxes"] if b] or [64])
    fe = int(min(feather, max(2, face_short // 4)))

    # [放大倍数] 格宽 = 脸框长边 × 倍数，取代手填画布尺寸：小脸不会被硬拉爆、
    # 大脸不爆 token。放大模型只在 crop 小于格宽时跑（缩不丢细节，白跑不值）。
    up_model = _get_upscale_model(upscale_model)
    _face_long = max(
        [max(b[2] - b[0], b[3] - b[1])
         for f in smooth_faces for b in f["boxes"] if b] or [256])
    cell_target = int(round(_face_long * float(upscale)))

    # [拼贴画布] 多人拼一张、一次采样（用户确认的方向）。错位有两个可能来源：
    # ① 降噪偏高 → 模型把「网格上的多张脸」当多人场景重排 —— 拼贴下降噪要比
    #    单脸更低（建议 0.25~0.35），低频越稳重排越少；② 贴回几何 —— rect/pad
    #    单一真值已修。每跑一次都把输入/输出画布首帧存到
    #    _selftest_out/facefix_debug/，两张图一对比就能确诊错位在哪一环。
    batches = [list(range(i, min(i + max_faces, len(faces))))
               for i in range(0, len(faces), max_faces)]
    made_any = False

    for bi, batch in enumerate(batches):
        try:
            cw, ch, cols, rows, cell = _batch_layout(len(batch), cell_target)
            n_up = 0

            # 1) 逐帧拼贴：一人一格，等比塞进格子（没出现的人留空，贴回时跳过）
            # rects[t][k]=(rect,pad,inset)：rect 是实际裁剪矩形（贴回照抄，
            # 不重算，FaceDetailer 也是存 bbox）；inset=基础环带宽度，贴回
            # 掩码从 rect 边缘内缩 inset → 修复范围 = 脸框 + 外扩。
            # cores[t][k] 是核心脸区在**画布**上的像素框（同样内缩 inset），
            # 外圈是喂给模型的上下文环带（借鉴终极放大的 overlap 边带）。
            canvases, rects, cores = [], [], []
            for t in range(T):
                canvas = torch.zeros(ch, cw, 3, dtype=torch.float32)
                row_rects = [None] * len(batch)
                row_cores = [None] * len(batch)
                for k, fi in enumerate(batch):
                    boxes_i = smooth_faces[fi]["boxes"]
                    bx = boxes_i[t] if t < len(boxes_i) else None
                    if bx is None:
                        continue
                    # [上下文环带] 裁剪框 = 脸框 + 基础环带(半个脸宽) + 外扩。
                    # 环带给模型当上下文（其重绘不进成片）。
                    # [外扩语义] 外扩决定修复范围：贴回范围 = 脸框 + 外扩。
                    # 旧写法贴回/核心区掩码按「基础+外扩」整体内缩 —— 一进
                    # 一出抵消，外扩调多少成片都看不见。
                    bw0 = max(1.0, bx[2] - bx[0])
                    bh0 = max(1.0, bx[3] - bx[1])
                    base = int(min(bw0, bh0) * 0.5)
                    ctx = base + int(margin)
                    bx = _expand_box(bx, ctx, W, H)
                    if bx is None:
                        continue
                    c, rect, pad = _crop_resize(images[t], bx, cell, up_model)
                    if c is None:
                        continue
                    if up_model is not None and max(bx[2] - bx[0],
                                                    bx[3] - bx[1]) < cell:
                        n_up += 1
                    cx, cy = (k % cols) * cell, (k // cols) * cell
                    canvas[cy:cy + cell, cx:cx + cell] = c
                    # 贴回内缩量 = 基础环带（不是 ctx）—— 修复范围因此
                    # = 脸框 + 外扩，外扩参数才真正生效
                    row_rects[k] = (rect, pad, base)
                    rx, ry, rcw, rch = rect
                    sx = pad[2] / float(rcw)
                    sy = pad[3] / float(rch)
                    row_cores[k] = (
                        cx + pad[0] + base * sx, cy + pad[1] + base * sy,
                        cx + pad[0] + (rcw - base) * sx,
                        cy + pad[1] + (rch - base) * sy)
                canvases.append(canvas)
                rects.append(row_rects)
                cores.append(row_cores)
            seq = torch.stack(canvases)

            # 2) 帧网格：H3 只吃 17k+5 的像素帧数（5/22/39/56…），先补齐再 encode
            n_src = int(seq.shape[0])
            try:
                from comfy_extras.nodes_minimax_h3 import (
                    align_frame_count, temporal_shape)
                fc = int(align_frame_count(max(5, n_src)))
                if fc > n_src:
                    seq = torch.cat(
                        [seq, seq[-1:].expand(fc - n_src, -1, -1, -1)], dim=0)
                _fc, _exp_t, a_len = temporal_shape(fc)
            except ImportError:
                _exp_t = None
                a_len = max(1, int(round(n_src * 40.0 / 25.0)))

            latent = vae.encode(seq[..., :3])
            if latent.ndim == 4:
                latent = latent.unsqueeze(0).movedim(1, 2)
            latent = latent.to(device=device, dtype=torch.float32)
            if _exp_t is not None and int(latent.shape[2]) != int(_exp_t):
                lt = int(latent.shape[2])
                if lt > _exp_t:
                    latent = latent[..., :_exp_t, :, :]
                else:
                    pad = latent[..., :1, :, :].expand(
                        -1, -1, _exp_t - lt, -1, -1)
                    latent = torch.cat([latent, pad], dim=2)

            # [核心区掩码·按时间步] 借鉴终极放大空间分块的机制：1 = 核心脸区
            # （重绘），0 = 上下文环带（每步被 KSamplerX0Inpaint 混回原始
            # latent，只作上下文喂给模型）。掩码必须按 latent 时间步分开写：
            # 每个时间步覆盖 n_seq/T_lat 个像素帧，取覆盖到的帧的 core 并集。
            # 旧写法把所有帧的 core 并进全部时间步 —— 脸只出现在部分帧时，
            # 缺席帧的位置也被放开重绘，模型在那里凭空生成。
            lh, lw = int(latent.shape[-2]), int(latent.shape[-1])
            slh = lh / float(ch)
            slw = lw / float(cw)
            T_lat = int(latent.shape[2])
            n_seq = int(seq.shape[0])
            fpl = float(n_seq) / float(max(1, T_lat))
            dm = torch.zeros(1, 1, T_lat, lh, lw, dtype=torch.float32)
            for li in range(T_lat):
                lo = int(li * fpl)
                hi = min(len(cores), max(lo + 1, int(round((li + 1) * fpl))))
                for t in range(lo, hi):
                    for core in cores[t]:
                        if core is None:
                            continue
                        px0, py0, px1, py1 = core
                        dm[:, :, li,
                           max(0, int(py0 * slh)):max(1, int(py1 * slh)),
                           max(0, int(px0 * slw)):max(1, int(px1 * slw))] = 1.0

            # H3 forward 里 audio_src = x[1]，必须喂「视频+音频」双流；哑音频只
            # 用来满足 pack/layout，采完只取回视频流。
            dummy_audio = torch.zeros(1, 32, 2, a_len,
                                      device=device, dtype=torch.float32)
            latent_av = comfy.nested_tensor.NestedTensor((latent, dummy_audio))

            # 3) 一次采样：所有脸共享同一次去噪，口型与光线天然一致
            res = inpaint.sample_inpaint(
                model, positive, {"samples": latent_av}, dm,
                steps=steps, denoise=denoise, seed=seed + bi)
            res_samples = res["samples"]
            if getattr(res_samples, "is_nested", False):
                res_video = list(res_samples.unbind())[0]
            else:
                res_video = res_samples
            pixels = vae.decode(res_video)
            if pixels.ndim == 5:
                pixels = pixels.movedim(1, -1) if pixels.shape[-1] not in (1, 3) \
                    else pixels[0]
            pixels = pixels.clamp(0.0, 1.0).float().cpu()
            # [尺寸护栏] 兜底：解码尺寸与画布不一致时先拉回画布尺寸，否则
            # 下面按格切片必然 shape 冲突（多几像素就是这条报错的来源）。
            if pixels.ndim == 4 and (int(pixels.shape[1]),
                                     int(pixels.shape[2])) != (ch, cw):
                pixels = F.interpolate(
                    pixels.permute(0, 3, 1, 2), size=(ch, cw),
                    mode="bilinear", align_corners=False).permute(0, 2, 3, 1)
            elif pixels.ndim == 5 and (int(pixels.shape[2]),
                                       int(pixels.shape[3])) != (ch, cw):
                b, t, h, w, c = pixels.shape
                pixels = F.interpolate(
                    pixels.reshape(b * t, h, w, c).permute(0, 3, 1, 2),
                    size=(ch, cw), mode="bilinear", align_corners=False
                ).permute(0, 2, 3, 1).reshape(b, t, ch, cw, c)
            n_out = int(pixels.shape[0] if pixels.ndim == 4 else pixels.shape[1])
            _save_debug(seq[0], "batch%d_in.png" % bi)
            _save_debug(pixels[0] if pixels.ndim == 4 else pixels[0, 0],
                        "batch%d_out.png" % bi)
            # 首帧 + 中帧：静态单帧看不出时序漂移，两张一起看才够
            _mid = min(int(seq.shape[0]), int(n_out)) // 2
            _save_debug(seq[_mid], "batch%d_in_mid.png" % bi)
            _save_debug(pixels[_mid] if pixels.ndim == 4 else pixels[0, _mid],
                        "batch%d_out_mid.png" % bi)

            # 4) 帧对齐（一次到位）：补帧只发生在尾部（上面 cat 的就是末帧重复），
            # 因果 VAE 解码帧与输入帧逐帧对应 —— n_out ≥ T 时直接取前 T 帧就是
            # 1:1 对齐，不做任何重采样。旧做法「先补帧、再 frame_map 按比例映射」
            # 等于两次重采样叠加，反而往时间轴里注入抖动。只有 n_out < T
            # （解码丢帧，正常不该发生）才退回比例映射兜底。
            if int(n_out) >= int(T):
                frame_map = range(T)
                if n_out > n_src and log is not None:
                    log.append("批%d：补齐至 %d 帧解码，取前 %d 帧 1:1 对齐"
                               % (bi, n_out, T))
            else:
                frame_map = [
                    min(n_out - 1,
                        int(round(i * (n_out - 1) / float(max(1, T - 1)))))
                    for i in range(T)
                ]
                if log is not None:
                    log.append("批%d：解码 %d 帧 ≠ 成片 %d 帧，已按比例对齐"
                               % (bi, n_out, T))

            # 5) 拆格 + 残差注入 + 贴回：每人用自己当帧的脸框，互不干扰。
            # 贴回 = 原帧 + 采样高频残差（加法，不替换任何原帧内容）；残差
            # 走 v3 流水线（亮度投影/光流对齐平均/纹理加权/自适应钳制，
            # 见 fuse_detail）。采样里的内容漂移全在低频，减掉 L1 进不了成片。
            pasted = 0
            drift_sum, drift_n = 0.0, 0
            chroma_sum, chroma_n = 0.0, 0
            ema_prev = {}
            for t, src_i in enumerate(frame_map):
                row = pixels[src_i] if pixels.ndim == 4 else pixels[0, src_i]
                for k in range(len(batch)):
                    rp = rects[t][k]
                    if rp is None:
                        ema_prev.pop(k, None)  # 脸缺席：断平滑链，重现重新起步
                        continue
                    rect, pad, inset = rp
                    cx, cy = (k % cols) * cell, (k // cols) * cell
                    orig_tile = canvases[t][cy:cy + cell, cx:cx + cell]
                    # [核心区几何] rect 坐标系内缩 inset（贴回掩码实际采纳范围），
                    # 按 pad 缩放映射到本格坐标，传给 fuse_detail 做权重保底。
                    _rx, _ry, rcw, rch = rect
                    sxg = pad[2] / float(rcw)
                    syg = pad[3] / float(rch)
                    core_box = (
                        pad[0] + inset * sxg, pad[1] + inset * syg,
                        pad[0] + (rcw - inset) * sxg,
                        pad[1] + (rch - inset) * syg)
                    fused, drift, ema_prev[k] = fuse_detail(
                        orig_tile, row[cy:cy + cell, cx:cx + cell], detail_gain,
                        ema_prev=ema_prev.get(k), core_box=core_box)
                    drift_sum += drift
                    drift_n += 1
                    # [色度增量] 贴回带来的颜色变化（残差对亮度轴的正交分量）。
                    # v3 亮度分离后它应当 ≈0 —— 彩斑若还在而这个数是 0，
                    # 铁证斑点来自原帧/上游，不是本节点加的。
                    delta = fused.float() - orig_tile.float()
                    _wy = delta.new_tensor(_LUMA_W)
                    chroma = delta - (delta * _wy).sum(-1, keepdim=True) * _wy
                    chroma_sum += float(chroma.abs().mean())
                    chroma_n += 1
                    pasted += paste_tile(
                        out, t, fused, rect, pad, cell, fe, W, H,
                        context=inset)

            # [效果自证] 块差≈0 = 采样没动；覆盖≈0 = 贴回没落进画面
            n_cmp = min(int(seq.shape[0]), int(n_out))
            src_px = seq[:n_cmp].cpu()
            out_px = pixels[:n_cmp] if pixels.ndim == 4 else pixels[0, :n_cmp]
            crop_delta = float((out_px - src_px).abs().mean())
            cover = pasted / float(max(1, T * H * W))
            made_any = True
            if log is not None:
                log.append(
                    "批%d：%d 张脸、画布 %d×%d（%d×%d 格）、%d 帧、羽化 %d、"
                    "模型放大 %d 块、块差 %.4f、低频漂移 %.4f、色度增量 %.4f、"
                    "覆盖 %.1f%%"
                    % (bi, len(batch), cw, ch, cols, rows, n_out, fe, n_up,
                       crop_delta, drift_sum / max(1, drift_n),
                       chroma_sum / max(1, chroma_n), cover * 100.0))
        except Exception as e:
            if log is not None:
                log.append("批%d 跳过（%s）" % (bi, str(e).splitlines()[0][:200]))
    if not made_any:
        raise RuntimeError("所有批次均精修失败")
    return out
