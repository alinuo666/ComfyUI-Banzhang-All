# -*- coding: utf-8 -*-
"""三节点状态一致性守卫（纯函数，不是节点）。

`csglide_store.py:1040` 的 put_segment_text 已经是「段词唯一写入口」，
segment_bindings 是段词真值。这里补齐另外两处副本（媒体架 slots、导演台
state）的一致性校验：写之前 / 提交之前调用，发现漂移就报中文原因，
而不是等收片时才发现三处各说各话。
"""
from __future__ import annotations

from typing import Any, Dict, List, Tuple


def _chain(data: Any) -> Dict[str, str]:
    value = (data or {}).get("chain") or {} if isinstance(data, dict) else {}
    return {"name": str(value.get("name") or "").strip(),
            "clip": str(value.get("clip") or "").strip(),
            "shot": str(value.get("shot") or "").strip()}


def verify_snapshots(project_id: str, clip: str, desk: Dict[str, Any],
                     rack: Dict[str, Any], h3: Dict[str, Any],
                     binding: Dict[str, Any] = None) -> Tuple[List[str], List[str]]:
    """返回 (errors, warnings)。binding 可选，来自 segment_bindings 行。"""
    errors, warnings = [], []
    cid = str(clip or "").strip()
    if not cid:
        return ["当前段 clip 为空"], warnings

    chains = {"文案台": _chain(desk), "媒体架": _chain(rack), "导演台": _chain(h3)}
    for label, ref in chains.items():
        if ref["name"] and project_id and ref["name"] != str(project_id):
            errors.append("%s 的工程名「%s」与「%s」不一致"
                          % (label, ref["name"], project_id))
        if ref["clip"] and ref["clip"] != cid:
            errors.append("%s 的当前段「%s」与提交目标「%s」不一致"
                          % (label, ref["clip"], cid))
        if label == "媒体架" and not ref["name"]:
            warnings.append("媒体架 chain.name 为空（既有设计：后端白名单丢弃 chain）")

    desk_segs = (desk or {}).get("segs") or {}
    rack_segs = (rack or {}).get("segs") or {}
    if isinstance(desk_segs, dict) and cid not in desk_segs:
        errors.append("文案台没有当前段 %s 的文案副本" % cid)
    if isinstance(rack_segs, dict) and cid not in rack_segs:
        errors.append("媒体架没有当前段 %s 的素材副本" % cid)

    if binding:
        text = str(binding.get("desk_text") or "")
        mine = str(desk_segs.get(cid) or "") if isinstance(desk_segs, dict) else ""
        if text and mine and text != mine:
            errors.append("当前段文案与 segment_bindings 真值不一致（投影过期）")
        shot = str(binding.get("shot_uid") or "").strip()
        if shot and chains["导演台"]["shot"] and shot != chains["导演台"]["shot"]:
            errors.append("导演台 shot uid 与 segment_bindings 绑定不一致")
        bound_cid = str(binding.get("cid") or "").strip()
        if bound_cid and bound_cid != cid:
            errors.append("segment_bindings 绑定的是 %s，不是当前段 %s" % (bound_cid, cid))

    return errors, warnings
