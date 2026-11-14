# -*- coding: utf-8 -*-
"""整片导出门禁（纯函数；不是节点，不注册 ComfyUI）。

把 export_film_plan 里原本「只打印不阻断」的 short / trim_notes 升级为硬拦，
并补上帧账、待办、成片、帧率四类检查。所有判据只依赖 film_summary 与 plan
两个字典，可纯 Python 单测。

应急关闭：设环境变量 BZ_EXPORT_GATE=0 后重启（csglide_chain.export_film_plan）。
"""
from __future__ import annotations

from typing import Any, Dict, List

try:
    from . import csglide_ledger as L
except ImportError:
    from . import csglide_ledger as L


def export_gate(fs: Dict[str, Any], plan: Dict[str, Any]) -> List[str]:
    """返回中文错误列表；空列表 = 允许导出。"""
    rows = fs.get("clips") or []
    cut = plan.get("at_index")
    if cut is None:
        return ["导出计划没有给出截止段（at_index）"]
    cut = int(cut)
    picks = [r for r in rows if int(r.get("index") or 0) <= cut]
    if not picks:
        return ["没有可导出的分段"]

    errs = []
    fps = float(fs.get("fps") or 0)
    if fps and abs(fps - float(L.FPS)) > 1e-6:
        errs.append("工程帧率 %.3f 与 H3 帧账 %.3f 不一致 —— 导出时长与音画对齐会整体偏移"
                    % (fps, L.FPS))

    last_to = 0
    for row in picks:
        idx = int(row.get("index") or 0)
        label = str(row.get("name") or row.get("id") or idx)
        if row.get("pending"):
            errs.append("第 %d 段（%s）有未处理待办「%s」—— 先重跑再导出"
                        % (idx, label, row["pending"]))
        if not row.get("playable"):
            errs.append("第 %d 段（%s）成片不在磁盘上" % (idx, label))

        trim = int(row.get("trim_frames") or 0)
        tail = int(row.get("trim_tail") or 0)
        frames = int(row.get("frames") or 0)
        if trim < 0 or tail < 0 or (frames and trim + tail >= frames):
            errs.append("第 %d 段帧账非法（frames=%d / 剪头=%d / 剪尾=%d）"
                        % (idx, frames, trim, tail))
        # 剪头帧数是用户自设的接缝档位（0/5/22/39/56/73…），不是固定 22：
        # L.CONT_HEAD_FRAMES 只是制片中枢模板的默认帧账，不是 H3 物理上限。
        # 帧账合法性上面已按 frames 判过，这里不再设第二套上限 —— 以前按 22
        # 硬拦会同时挡掉手动选 39/56 的段和旧版默认 39 生成的工程。

        begin = int(row.get("clip_from") or 0)
        end = int(row.get("clip_to") or 0)
        if end < begin or (end == begin and frames > 0):
            errs.append("第 %d 段在全片里的帧区间非法（%d → %d）" % (idx, begin, end))
        last_to = max(last_to, end)

    total = int(fs.get("total_frames") or 0)
    if total and last_to and total != last_to:
        errs.append("时间轴总帧数 %d 与最后一段 clip_to %d 不一致 —— 全片长度口径分叉"
                    % (total, last_to))

    for item in plan.get("short") or []:
        errs.append("第 %s 段成片只有 %s 帧，少于应有的 %s 帧 —— 拼进去会丢帧 / 重播"
                    % (item.get("index"), item.get("film_frames"), item.get("want")))
    for item in plan.get("trim_notes") or []:
        errs.append("第 %s 段承接帧数对不上（面板 %s / 档案 %s）—— 接缝会重复播一截，"
                    "请重跑该段再导出"
                    % (item.get("index"), item.get("panel"), item.get("archive")))

    return errs
