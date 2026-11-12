# -*- coding: utf-8 -*-
"""提交前门禁（纯函数；不是节点，不注册 ComfyUI）。

调用点：
  · 前端 js/bz_queue_align.js 在编译后、api.queuePrompt 之前做同步等价检查
  · 后端任意位置可 ``from .csglide_preflight import preflight`` 复用同一套规则

只把「会静默错段 / 收不上片」的条件列为 error；媒体架 chain.name 为空是
既有设计（后端白名单丢弃 chain），只给 warning，避免误伤正常画布提交。

20261108：合并节点规则改为与后端「声明式收片」同口径。三采各接一个合并节点
是正常拓扑（bz_cid 本来就相同），唯一性由 _declare_film_identity() 自报的
bz_role / bz_stage 与「时间轴当前选中阶段」裁决；这里只拦「两个合并节点共享
同一路 VAE 解码」这种同一采重复出片，不再按个数误伤。
20261111 阶段 1：💾 续拍存档已并入 🎬 H3 VAE 快速解码、画布不再放存档节点；
门禁相应改成「至少接一个 H3 VAE 快速解码」，不再数唯一开着的存档开关。
"""
from __future__ import annotations

import json
from typing import Any, Dict, List, Tuple

CAST_TYPES = ("CSGlideCastCS", "CSGlideCastLegacyCS")
ARCHIVE_TYPES = ("BanZhang_H3_ClipArchive", "MiniMaxH3MotionContextSaveLatent")
DECODE_TYPES = ("BanZhang_H3VAEDecodeFast",)
COMBINE_TYPES = ("banzhangVideoCombine",)
DESK_TYPES = ("CSGlideDeskCS",)
RACK_TYPES = ("CSGlideH3MediaRackCS",)


def _nodes(prompt, types):
    if not isinstance(prompt, dict):
        return []
    return [(str(k), v) for k, v in prompt.items()
            if isinstance(v, dict) and v.get("class_type") in types]


def _json_of(spec, key):
    raw = (spec.get("inputs") or {}).get(key)
    if not isinstance(raw, str) or not raw.strip():
        return {}
    try:
        data = json.loads(raw)
    except (TypeError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def _arch_on(spec):
    value = (spec.get("inputs") or {}).get("archive_enabled", True)
    if value is False or value == 0 or value in ("false", "False", "0"):
        return False
    return True


def _combine_decode_root(prompt, nid):
    """合并节点的画面来自哪一路 VAE 解码（即哪一采）。

    与 banzhang_video_tools._declare_film_identity() 的角色判定同口径：最多向上
    看 4 跳，碰到 VAE 解码即认定；碰到另一个合并节点必须停 —— 超分/插帧链的
    画面来自上一采的合并节点，那是衍生片，不算这一采的分段片。
    认不出返回 ""（整片口 / 衍生片），交后端声明式收片裁决。
    """
    seen = set()
    spec = prompt.get(str(nid)) or {}
    frontier = [str(v[0]) for v in (spec.get("inputs") or {}).values()
                if isinstance(v, (list, tuple)) and len(v) == 2]
    for _ in range(4):
        if not frontier:
            break
        nxt = []
        for u in frontier:
            if u in seen:
                continue
            seen.add(u)
            s = prompt.get(u) or {}
            cls = str(s.get("class_type") or "")
            if "VAEDecode" in cls:
                return u
            if cls in COMBINE_TYPES:
                continue
            nxt.extend(str(v[0]) for v in (s.get("inputs") or {}).values()
                       if isinstance(v, (list, tuple)) and len(v) == 2)
        frontier = nxt
    return ""


def preflight(prompt: Any) -> Tuple[List[str], List[str]]:
    """返回 (errors, warnings)。errors 非空即应拒绝提交。"""
    if not isinstance(prompt, dict) or not prompt:
        return ["提交内容为空"], []

    casts = _nodes(prompt, CAST_TYPES)
    if not casts:
        return [], []  # 普通工作流，不介入

    errors, warnings = [], []
    if len(casts) > 1:
        errors.append("本次提交有 %d 个导演台（%s）—— 只保留一个，否则段身份不唯一"
                      % (len(casts), "、".join("#" + k for k, _ in casts)))
    cast_id, cast = casts[0]
    inputs = cast.get("inputs") or {}
    h3 = _json_of(cast, "h3_data")
    chain = h3.get("chain") or {}
    name = str(chain.get("name") or "").strip()
    clip = str(chain.get("clip") or "").strip()
    if not name:
        errors.append("导演台 #%s 的 h3_data.chain.name 为空：工程名没登记" % cast_id)
    shot = str(chain.get("shot") or "").strip()
    if not clip and not shot:
        errors.append("导演台 #%s 的 chain.clip 与 chain.shot 都为空：无法认段" % cast_id)
    elif not clip:
        # bz_prompt_build.js:937-940 提交时主动清空 clip，后端按 shot 认段，是既有设计。
        warnings.append("导演台 #%s 的 chain.clip 为空（按 shot uid 认段，属既有设计）"
                        % cast_id)

    override = inputs.get("h3_override")
    if isinstance(override, (list, tuple)) and len(override) >= 2:
        src = prompt.get(str(override[0]))
        literal = None
        if isinstance(src, dict):
            upstream = src.get("inputs") or {}
            for key in ("h3_data", "value", "text", "string"):
                value = upstream.get(key)
                if isinstance(value, str) and value.strip():
                    literal = value
                    break
        if literal is None:
            errors.append("导演台 #%s 的 h3_override 接了 #%s 的连线，但上游没有"
                          "可直接读取的字面值；不能用面板旧 h3_data 顶替（会认错段）"
                          % (cast_id, override[0]))

    for label, types, key in (("文案台", DESK_TYPES, "desk_data"),
                              ("媒体架", RACK_TYPES, "rack_data")):
        for nid, spec in _nodes(prompt, types):
            other = str((_json_of(spec, key).get("chain") or {}).get("name") or "").strip()
            if not other:
                if label == "媒体架":
                    warnings.append("媒体架 #%s 的 chain.name 为空（既有设计，后端白名单丢弃 chain）" % nid)
                else:
                    warnings.append("文案台 #%s 的 chain.name 为空" % nid)
            elif name and other != name:
                errors.append("%s #%s 的工程名「%s」与导演台「%s」不一致"
                              % (label, nid, other, name))

    # 20261111 阶段 1：存档节点已删除，写盘/阶段判定/认片都由 VAE 快速解码承担。
    # 一采/二采各挂一个是正常拓扑，所以只要求「至少一个」，不再数唯一开关。
    decodes = _nodes(prompt, DECODE_TYPES)
    if not decodes:
        errors.append("画布上没有「🎬 H3 VAE 快速解码」节点 —— 续拍存档、阶段判定"
                      "和分段片认片现在都由它承担，请至少接一个")

    wired = []
    for nid, spec in _nodes(prompt, COMBINE_TYPES):
        ins = spec.get("inputs") or {}
        if ins.get("🖼️ 图像") or ins.get("🎬 视频文件") or ins.get("🎞️ 帧流"):
            wired.append(nid)
    if not wired:
        errors.append("没有视频合并节点接画面输入 —— 本轮出不了分段片")
    else:
        # 三采各接一个合并节点是正常拓扑，bz_cid 相同也不会导致拒收。
        # 真正会冲突的是两个合并节点共享同一路 VAE 解码（同一采重复出片）。
        roots = {}
        for nid in wired:
            root = _combine_decode_root(prompt, nid)
            if not root:
                continue          # 整片口 / 衍生片：交后端声明式收片裁决
            if root in roots:
                errors.append("视频合并节点 #%s 与 #%s 的画面来自同一路 VAE 解码 #%s"
                              " —— 同一采重复出片，收片会拒收，只留一个"
                              % (roots[root], nid, root))
            else:
                roots[root] = nid

    if clip:
        for nid, spec in _nodes(prompt, DESK_TYPES):
            segs = _json_of(spec, "desk_data").get("segs") or {}
            if isinstance(segs, dict) and clip in segs and not str(segs.get(clip) or "").strip():
                warnings.append("文案台 #%s 当前段 %s 的文案为空" % (nid, clip))

    return errors, warnings
