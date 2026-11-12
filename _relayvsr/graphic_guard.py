"""图形区保护：只修「模型把硬边画糊」的地方，全自动、无用户参数。

生成式超分会把字幕 / 台标 / 色块的 1px 硬边重画成多像素灰渐变（灰裙＋斜面），平涂图形因此发脏。
判据不认内容而认破坏：源里是硬边（2px 跨度差 / 6px 跨度差 接近 1）、超分缩回源尺寸后变软
（比值明显下降）的像素，才是被画坏的地方；自然软边的源比值本来就低，不会误判。
保护区改用干净立方插值放大贴回，并按邻域色差场补偿色调，避免与超分区之间出现亮度台阶。
"""

import cv2
import numpy as np

_EDGE_MIN = 120.0     # 6px 跨度差低于此值不算边：滤掉压缩块边等低对比硬边，只认字/箭头级高对比
_SRC_RATIO = 0.7      # 源比值高于此 = 硬边
_SR_RATIO = 0.8       # 超分缩回比值低于此 = 被画软
_DILATE = 3           # 源尺度膨胀半径：盖住灰裙（实测裙宽约 3px）并留羽化余量
_CLOSE = 3            # 闭运算把沿边断点连成连续环
_MIN_AREA = 50        # 去掉孤立噪点组件
_FEATHER = 2.0        # 输出尺度羽化 sigma，藏拼接边界
_OFFSET_WIN = 31      # 色差场归一化卷积窗口（源尺度）
_OFFSET_CLAMP = 12.0  # 色差补偿上限，防止极端帧把干净区推偏


def _ratio_map(gray):
    """硬边锐度：2px 跨度差 / 6px 跨度差，横竖取大。硬边≈1，软边≈0.3-0.5。"""
    g = gray.astype(np.int16)
    r = np.zeros(g.shape, np.float32)
    gx2 = np.abs(g[:, 2:] - g[:, :-2]).astype(np.float32)
    gx6 = np.abs(g[:, 6:] - g[:, :-6]).astype(np.float32)
    r[:, 3:-3] = np.maximum(r[:, 3:-3], np.where(gx6 > _EDGE_MIN, gx2[:, 2:-2] / np.maximum(gx6, 1), 0))
    gy2 = np.abs(g[2:, :] - g[:-2, :]).astype(np.float32)
    gy6 = np.abs(g[6:, :] - g[:-6, :]).astype(np.float32)
    r[3:-3, :] = np.maximum(r[3:-3, :], np.where(gy6 > _EDGE_MIN, gy2[2:-2, :] / np.maximum(gy6, 1), 0))
    return r


def _mask(src_gray, sr_gray):
    flag = ((_ratio_map(src_gray) > _SRC_RATIO) & (_ratio_map(sr_gray) < _SR_RATIO)).astype(np.uint8)
    m = cv2.dilate(flag, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * _DILATE + 1, 2 * _DILATE + 1)))
    m = cv2.morphologyEx(m, cv2.MORPH_CLOSE,
                         cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * _CLOSE + 1, 2 * _CLOSE + 1)))
    n, lab, stats, _ = cv2.connectedComponentsWithStats(m, 8)
    keep = np.zeros(n, bool)
    for j in range(1, n):
        keep[j] = stats[j, cv2.CC_STAT_AREA] >= _MIN_AREA
    return keep[lab].astype(np.uint8)


def _offset_field(src, sr_down, mask):
    """非保护区的「超分-源」色差做归一化卷积：每个保护块跟自家邻域色调。

    全局中位在混合画面（一半奶油画布一半室内）会偏色，局部场才能让箭头 / 字幕各跟各的背景。
    """
    diff = sr_down.astype(np.float32) - src.astype(np.float32)
    wgt = (1 - mask).astype(np.float32)
    num = cv2.blur(diff * wgt[..., None], (_OFFSET_WIN, _OFFSET_WIN))
    den = cv2.blur(wgt, (_OFFSET_WIN, _OFFSET_WIN))[..., None]
    outside = diff[mask == 0]
    glob = np.median(outside.reshape(-1, 3), axis=0) if outside.size else np.zeros(3, np.float32)
    field = np.where(den > 0.05, num / np.maximum(den, 1e-3), glob)
    return np.clip(field, -_OFFSET_CLAMP, _OFFSET_CLAMP)


def protect_frame(source, sr):
    """source 为 torch uint8 (3,H,W)，sr 为 numpy uint8 (H,W,3)；返回拼接后的 numpy uint8。

    没有破坏痕迹时原样返回 sr，自然画面一个像素都不碰。
    """
    src = np.ascontiguousarray(source.permute(1, 2, 0).numpy())
    height, width = sr.shape[:2]
    sr_down = cv2.resize(sr, (src.shape[1], src.shape[0]), interpolation=cv2.INTER_AREA)
    mask = _mask(cv2.cvtColor(src, cv2.COLOR_RGB2GRAY), cv2.cvtColor(sr_down, cv2.COLOR_RGB2GRAY))
    if not mask.any():
        return sr
    clean = cv2.resize(src, (width, height), interpolation=cv2.INTER_CUBIC).astype(np.float32)
    clean += cv2.resize(_offset_field(src, sr_down, mask), (width, height), interpolation=cv2.INTER_LINEAR)
    alpha = cv2.resize(mask.astype(np.float32), (width, height), interpolation=cv2.INTER_NEAREST)
    alpha = cv2.GaussianBlur(alpha, (0, 0), _FEATHER)[..., None]
    blended = sr.astype(np.float32) * (1 - alpha) + np.clip(clean, 0, 255) * alpha
    return np.clip(blended, 0, 255).astype(np.uint8)