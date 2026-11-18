"""阶段总线决策：根据前端组解析写入的 stage_flow，判定两个自动总线口该读哪一阶段。

只做决策不读文件：返回阶段序号（s1/s2...），由导演台节点调用现有读档函数执行。
关键前提：阶段 DAG 连通且从单一源头展开，一次提交最多一个 latent 读档边界、
一个 video 读档值，两个自动口即可覆盖任意阶段数。
"""


def normalized(stage_flow):
    """归一化前端状态：只保留 kind/enabled，拓扑序由前端保证。"""
    if not isinstance(stage_flow, dict):
        return []
    raw = stage_flow.get("stages")
    if not isinstance(raw, list):
        return []
    out = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        kind = item.get("kind")
        if kind not in ("latent", "video"):
            continue
        out.append({"kind": kind, "enabled": bool(item.get("enabled"))})
    return out


def _latents(flow):
    """所有 latent 阶段按出现顺序给全局 s 序号。"""
    n = 0
    out = []
    for item in flow:
        if item["kind"] != "latent":
            continue
        n += 1
        out.append({"ordinal": n, "enabled": item["enabled"]})
    return out


def downstream_latent_stage(stage_flow):
    """口13：第一个「直接 latent 上游被禁用」的启用 latent 阶段，读该上游档。

    上游启用则走活线、不读档；起点阶段无上游。无边界返回 None。
    """
    latents = _latents(normalized(stage_flow))
    for i, cur in enumerate(latents):
        if not cur["enabled"] or i == 0:
            continue
        prev = latents[i - 1]
        if not prev["enabled"]:
            return "s%d" % prev["ordinal"]
    return None


def downstream_film_stage(stage_flow):
    """口14：存在启用 video 阶段时，给最后启用 latent 阶段的成片。"""
    flow = normalized(stage_flow)
    if not any(i["kind"] == "video" and i["enabled"] for i in flow):
        return None
    enabled_on = [x for x in _latents(flow) if x["enabled"]]
    if not enabled_on:
        return None
    return "s%d" % enabled_on[-1]["ordinal"]
