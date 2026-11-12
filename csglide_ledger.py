# -*- coding: utf-8 -*-
"""H3 帧账单一计算的纯函数模块（内部地基，不是节点，也不注册 ComfyUI）。

常量来源：banzhang_producer.py:43-46 / csglide_cast.py:267-323 / AGENTS.md。
当前只被 csglide_ticket 使用；后续 film_summary / 装配侧统一 import 这里，
消灭「导演台 124 / 中枢 360-379 / 合并节点 widget 帧率」三套口径。
"""
from __future__ import annotations

from dataclasses import dataclass

FPS = 24
FIRST_CLIP_LENGTH = 360
NEXT_CLIP_LENGTH = 379
CONT_HEAD_FRAMES = 22
FRAME_GRID = 17
FRAME_BASE = 5
MIN_FRAMES = 5


class LedgerError(ValueError):
    """帧账非法。"""


def align_frame_count(n):
    """向上吸附到 H3 合法格点 17k+5（与 csglide_cast.py:309 同口径）。"""
    n = max(MIN_FRAMES, int(n))
    while n % FRAME_GRID != FRAME_BASE:
        n += 1
    return n


def video_latent_t(frame_count):
    if frame_count <= MIN_FRAMES:
        return 2
    return ((frame_count - FRAME_BASE) // FRAME_GRID) * 5 + 2


@dataclass(frozen=True)
class FrameSpec:
    """一段的帧账：gross = 模型实际生成，net = 进整片的净长。"""
    gross_frames: int
    trim_head: int = 0
    trim_tail: int = 0
    fps: int = FPS

    def __post_init__(self):
        errs = []
        if int(self.fps) <= 0:
            errs.append("帧率必须为正")
        g = int(self.gross_frames)
        if g < MIN_FRAMES or align_frame_count(g) != g:
            errs.append("总帧数 %d 不在 %dk+%d 格点上" % (g, FRAME_GRID, FRAME_BASE))
        th, tt = int(self.trim_head), int(self.trim_tail)
        if th < 0 or tt < 0 or th + tt >= g:
            errs.append("剪头 / 剪尾越界")
        if errs:
            raise LedgerError("帧账非法：" + "；".join(errs))

    @property
    def net_frames(self):
        return int(self.gross_frames) - int(self.trim_head) - int(self.trim_tail)

    @property
    def seconds(self):
        return self.gross_frames / float(self.fps)

    @property
    def latent_t(self):
        return video_latent_t(int(self.gross_frames))


def frame_spec_for(length, is_first=False, overlap=CONT_HEAD_FRAMES):
    """按段序算帧账。首段不剪承接头；续段剪掉 overlap 帧重叠。"""
    gross = align_frame_count(length)
    if is_first or int(overlap) <= 0:
        trim = 0
    else:
        trim = min(int(overlap), gross - 1)
    return FrameSpec(gross, trim, 0, FPS)


def drift_prefix_steps(trim_head):
    """漂移控制 prefix_steps = video_latent_t(承接头帧数)。

    banzhang_h3_drift.py 注释里的对照表 5→2 / 22→7 / 39→12 / 56→17
    正好就是这个函数，说明 prefix_steps 是帧账派生值、不是独立参数。
    """
    n = int(trim_head or 0)
    return 0 if n <= 0 else video_latent_t(n)
