/* 阶段解析：把画布组与跨组连线解析成阶段 DAG。无组时回退，旧工作流零破坏。
   依据组内节点端口与跨组接线识别阶段；跨组边优先认真实连线（含穿过组外节点的透明中转），
   完全没有真实边时才按标题序号推断并标 inferred（渲染虚线）。 */
import { groupList, nodeList, inGroup, groupTitle, nodeGroupOwner } from "./bz_group_utils.js";

const VIDEO_CLASSES = [
  "BanZhangRelayVSRStreaming",
  "BanZhang_RIFE_Interpolation",
  "BanZhang_RTX_SuperResolution",
];
const CN_NUM = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
const MEDIA_TYPES = new Set(["IMAGE", "VIDEO", "AUDIO"]);
function mediaLink(link) { return MEDIA_TYPES.has(link?.type) || link?.type === "LATENT"; }
function hasMediaOutput(graph, group) {
  return nodeList(graph).some((n) => nodeGroupOwner(groupList(graph), n) === group
    && (n.outputs || []).some((p) => MEDIA_TYPES.has(p.type)));
}

function isSamplingNode(graph, n) {
    const inputs = n.inputs || [], outputs = n.outputs || [];
    return /Sampler/.test(n.comfyClass || n.type || "")
      || VIDEO_CLASSES.includes(n.comfyClass || n.type)
      || (outputs.some((p) => p.type === "VIDEO")
        && rawLinks(graph).some((l) => l && String(l.target_id) === String(n.id) && l.type === "VIDEO"))
      || (outputs.some((p) => p.type === "LATENT")
        && inputs.some((p) => p.type === "LATENT" || p.type === "CONDITIONING"));
}
function isSamplingGroup(graph, group) {
  return nodeList(graph).some((n) => nodeGroupOwner(groupList(graph), n) === group && isSamplingNode(graph, n));
}
function titleOrder(title) {
  for (const k of Object.keys(CN_NUM)) {
    if (title.includes(k)) return CN_NUM[k];
  }
  return null;
}

/* 节点 id → 阶段组 id；同一节点落多个阶段组直接报错，不猜 */
function resolveNodeGroups(graph, stageIds) {
  const map = {}, errors = [];
  for (const node of nodeList(graph)) {
    const hits = groupList(graph).filter((g) => stageIds.has(g.id) && inGroup(g, node));
    const owner = nodeGroupOwner(groupList(graph), node);
    if (hits.length > 1 && !owner) {
      errors.push(`节点「${node.title || node.id}」同时位于 ${hits.length} 个阶段组内，请解散重叠分组`);
    }
    if (owner && stageIds.has(owner.id)) map[node.id] = owner.id;
  }
  return { map, errors };
}

function rawLinks(graph) {
  return Array.isArray(graph.links) ? graph.links : Object.values(graph.links || {});
}

/* 直接跨组边：两端都落在阶段组，连线类型决定 LATENT / VIDEO。
   不按组对去重——DAG 去重在主入口做；这里保留每条连线，供编排层补口定位目标端。 */
function collectCrossEdges(links, nodeGroup) {
  const edges = [];
  for (const link of links) {
    if (!mediaLink(link) || link.origin_id == null) continue;
    const a = nodeGroup[link.origin_id], b = nodeGroup[link.target_id];
    if (!a || !b || a === b) continue;
    edges.push({
      from: a, to: b, type: link.type || "", socket: [link.origin_id, link.origin_slot],
      toNode: link.target_id, toSlot: link.target_slot,
    });
  }
  return edges;
}

/* 导演台读档口语义：整片/本段一采 → 第 1 个 latent 阶段，本段二采 → 第 2 个。
   总线口 12/13 由提交期按开关动态改接，不参与静态识别。 */
function castPortStage(slot, latentIds) {
  if (slot === 7 || slot === 9) return latentIds[0] || null;
  if (slot === 10 || slot === 11) return latentIds[1] || null;
  return null;
}

/* 透明中转：连线源端在阶段组外时，沿入线 backward 穿过组外节点（路由/解码/合并等），
   到阶段组节点即记录并停（不穿透），到导演台按读档口语义换算。
   收集全部可达源阶段——合并类节点可能同时依赖多个阶段。
   返回每条来源的阶段、输出 socket 与离开阶段后的首个输入端点（导演台读档口 socket 为 null）。
   保留首个端点，供提交期修复静音造成的组外中转断线。 */
function traceSources(originId, originSlot, nodeGroup, byTarget, castId, latentIds) {
  const found = new Map();
  const seen = new Set();
  const queue = [[originId, originSlot]];
  while (queue.length) {
    const [id, slot, boundary] = queue.shift();
    if (id == null) continue;
    const key = id + "|" + slot + "|" + (boundary ? boundary.toNode + ":" + boundary.toSlot : "");
    if (seen.has(key)) continue;
    seen.add(key);
    if (nodeGroup[id]) {
      found.set(key, { from: nodeGroup[id], socket: [id, slot], boundary });
      continue;
    }
    if (castId != null && String(id) === String(castId)) {
      const s = castPortStage(slot, latentIds);
      if (s) found.set(key, { from: s, socket: null });
      continue;
    }
    for (const l of byTarget[id] || []) {
      if (mediaLink(l)) queue.push([l.origin_id, l.origin_slot,
        { toNode: l.target_id, toSlot: l.target_slot, type: l.type }]);
    }
  }
  return found;
}

/* 入端在阶段组、源端在组外的连线：追出真实源阶段补边 */
function collectTracedEdges(links, nodeGroup, byTarget, castId, latentIds) {
  const edges = [];
  for (const link of links) {
    if (!mediaLink(link) || link.origin_id == null) continue;
    const b = nodeGroup[link.target_id];
    if (!b || nodeGroup[link.origin_id]) continue;
    for (const source of traceSources(link.origin_id, link.origin_slot, nodeGroup, byTarget, castId, latentIds).values()) {
      if (source.from !== b) edges.push({
        from: source.from, to: b, type: link.type || "", socket: source.socket, boundary: source.boundary,
        toNode: link.target_id, toSlot: link.target_slot,
      });
    }
  }
  return edges;
}

/* kind：标题「超分」与入边类型优先；有 LATENT 入边即 latent（接线说了算），
   类名白名单只在没有任何入边类型信息时兜底 */
function isVideoStage(group, members, inTypes) {
  if (inTypes.some((t) => t === "LATENT")) return false;
  if (inTypes.some((t) => t === "VIDEO")) return true;
  return members.some((n) => VIDEO_CLASSES.includes(n.comfyClass));
}

/* Kahn 拓扑排序：顺序由最终边决定，不按画布位置 */
function topoSort(stages, edges) {
  const indeg = {}, adj = {};
  stages.forEach((s) => { indeg[s.id] = 0; adj[s.id] = []; });
  edges.forEach((e) => {
    if (indeg[e.to] == null) return;
    indeg[e.to] += 1; adj[e.from].push(e.to);
  });
  const queue = stages.filter((s) => indeg[s.id] === 0).map((s) => s.id);
  const out = [];
  while (queue.length) {
    const id = queue.shift();
    out.push(id);
    for (const next of adj[id]) {
      indeg[next] -= 1;
      if (indeg[next] === 0) queue.push(next);
    }
  }
  return out.map((id) => stages.find((s) => s.id === id));
}

function nodeCycle(graph) {
  const adj = new Map(nodeList(graph).map((n) => [String(n.id), []]));
  for (const l of rawLinks(graph)) {
    if (l && adj.has(String(l.origin_id)) && adj.has(String(l.target_id))) adj.get(String(l.origin_id)).push(String(l.target_id));
  }
  const done = new Set(), active = new Set(), path = [];
  function visit(id) {
    if (active.has(id)) return [...path.slice(path.indexOf(id)), id];
    if (done.has(id)) return null;
    active.add(id); path.push(id);
    for (const next of adj.get(id)) { const cycle = visit(next); if (cycle) return cycle; }
    active.delete(id); path.pop(); done.add(id); return null;
  }
  for (const id of adj.keys()) { const cycle = visit(id); if (cycle) return cycle; }
  return null;
}

/* 阶段内的活视频输出口：优先有 VIDEO 出线的成员，其次任何带 VIDEO 输出端的成员
   （输出口悬空也能被改接用上）。按 outputs 类型认，不依赖节点类名。 */
function stageVideoOut(members, links) {
  const withLink = new Set();
  for (const l of links) {
    if (l && l.type === "VIDEO" && members.some((n) => n.id === l.origin_id)) withLink.add(l.origin_id);
  }
  const ordered = [...members.filter((n) => withLink.has(n.id)), ...members.filter((n) => !withLink.has(n.id))];
  for (const n of ordered) {
    const outs = Array.isArray(n.outputs) ? n.outputs : [];
    for (let i = 0; i < outs.length; i += 1) {
      if (outs[i] && outs[i].type === "VIDEO") return [n.id, i];
    }
  }
  return null;
}

/* 图像必须取阶段内处理链末端，不能按节点排列误选解码前后的中间画面。
   独立图像分支无法唯一判断时留空，由提交期提示接线，绝不猜一个分支。 */
function stageImageOut(members, links) {
  const ids = new Set(members.map((n) => n.id));
  const candidates = members.flatMap((n) => (n.outputs || []).flatMap((p, slot) => p.type === "IMAGE" ? [[n.id, slot]] : []));
  const terminals = candidates.filter(([id]) => {
    const pending = [id], seen = new Set();
    while (pending.length) {
      const current = pending.pop();
      if (seen.has(current)) continue;
      seen.add(current);
      if (current !== id && candidates.some(([other]) => other === current)) return false;
      for (const l of links) {
        if (mediaLink(l) && l.origin_id === current && ids.has(l.target_id)) pending.push(l.target_id);
      }
    }
    return true;
  });
  return terminals.length === 1 ? terminals[0] : null;
}

/* 后处理组保留媒体来源；不参与采样档位分配。 */
function observeGroups(graph, groups, stageGroups) {
  const other = groups.filter((g) => !stageGroups.includes(g));
  const nodeGroup = {};
  for (const n of nodeList(graph)) {
    const owner = nodeGroupOwner(groups, n);
    if (owner) nodeGroup[n.id] = owner.id;
  }
  const links = rawLinks(graph), byTarget = {};
  for (const l of links) {
    if (l && l.target_id != null) (byTarget[l.target_id] = byTarget[l.target_id] || []).push(l);
  }
  return other.map((g) => {
    const members = nodeList(graph).filter((n) => nodeGroup[n.id] === g.id);
    const memberIds = new Set(members.map((n) => String(n.id)));
    const nodesById = Object.fromEntries(nodeList(graph).map((n) => [String(n.id), n]));
    const edge = (l) => ({ fromNode: l.origin_id, fromSlot: l.origin_slot,
      toNode: l.target_id, toName: nodesById[String(l.target_id)]?.inputs?.[l.target_slot]?.name || null,
      type: l.type || "" });
    const edges = links.filter((l) => l && memberIds.has(String(l.target_id))).map(edge);
    const inEdges = edges.filter((e) => !memberIds.has(String(e.fromNode)));
    const outEdges = links.filter((l) => l && memberIds.has(String(l.origin_id))
      && !memberIds.has(String(l.target_id))).map(edge);
    const sources = new Set(), sourceTypes = new Map(), sourceEdges = [];
    for (const l of links) {
      if (!mediaLink(l) || nodeGroup[l.target_id] !== g.id || nodeGroup[l.origin_id] === g.id) continue;
      for (const source of traceSources(l.origin_id, l.origin_slot, nodeGroup, byTarget, null, []).values()) {
        const id = source.from;
        if (id !== g.id) {
          sources.add(id);
          if (!sourceTypes.has(id)) sourceTypes.set(id, new Set());
          sourceTypes.get(id).add(l.type || "未知类型");
          const boundary = source.boundary;
          sourceEdges.push({ from: id, socket: source.socket, type: l.type,
            toNode: l.target_id, toName: nodesById[String(l.target_id)]?.inputs?.[l.target_slot]?.name || null,
            boundary: boundary ? { ...boundary,
              toName: nodesById[String(boundary.toNode)]?.inputs?.[boundary.toSlot]?.name || null } : null });
        }
      }
    }
    return { id: g.id, title: groupTitle(g), members: members.map((n) => n.id), edges, inEdges, outEdges, sourceEdges,
      controllable: !!members.length && !members.some((n) => n.comfyClass === "CSGlideCastCS"),
      edgeTypes: groups.filter((x) => sources.has(x.id)).map((x) => [...sourceTypes.get(x.id)].join(" / ")),
      ioTypes: [...new Set([...inEdges, ...outEdges].map((e) => e.type).filter(Boolean))],
      from: groups.filter((x) => sources.has(x.id))
      .map((x) => ({ id: x.id, title: groupTitle(x) })) };
  });
}

/* 主入口：返回阶段 DAG 或回退标志，调用方据此渲染与改线 */
export function detectStages(graph) {
  const allGroups = groupList(graph).filter((g) => hasMediaOutput(graph, g));
  if (!allGroups.length) return { mode: "fallback", stages: [], warnings: [], errors: [] };

  const stageGroups = allGroups.filter((g) => isSamplingGroup(graph, g));
  const observers = observeGroups(graph, allGroups, stageGroups);
  const mirror = observeGroups(graph, allGroups, []).map((g) => ({ ...g,
    from: g.from.map((x) => x.id), kind: "post", edgeInferred: [],
    category: g.inEdges.length ? "处理组" : "资源输入组" }));
  if (!stageGroups.length) return { mode: "fallback", stages: [], observers, mirror, warnings: [], errors: [] };

  const stageIds = new Set(stageGroups.map((g) => g.id));
  const { map: nodeGroup, errors } = resolveNodeGroups(graph, stageIds);
  const links = rawLinks(graph);
  const byTarget = {};
  for (const l of links) {
    if (l && l.target_id != null) (byTarget[l.target_id] = byTarget[l.target_id] || []).push(l);
  }
  const cast = nodeList(graph).find((n) => n.comfyClass === "CSGlideCastCS");
  const castId = cast ? cast.id : null;
  const membersOf = (g) => nodeList(graph).filter((n) => nodeGroup[n.id] === g.id);
  const byIdNode = {};
  nodeList(graph).forEach((n) => { byIdNode[n.id] = n; });
  /* 目标端口名：编排层补口要按名字写进提交对象（提交对象 inputs 以名字为键）。
     合成图/mock 节点可能没有 inputs，返回 null 时编排层跳过补口。 */
  const nameOf = (id, slot) => {
    const n = byIdNode[id];
    const inp = n && Array.isArray(n.inputs) ? n.inputs[slot] : null;
    return inp && inp.name ? inp.name : null;
  };
  const warnings = [];

  // 阶段依赖只看能送达采样核心的入线；组内的下游预览/出片口不反向约束采样。
  const coreTargets = new Map();
  for (const g of stageGroups) {
    const pending = membersOf(g).filter((n) => isSamplingNode(graph, n)).map((n) => n.id);
    const targets = new Set();
    while (pending.length) {
      const id = pending.pop();
      if (targets.has(String(id))) continue;
      targets.add(String(id));
      for (const l of byTarget[id] || []) {
        if (mediaLink(l) && nodeGroup[l.origin_id] === g.id) pending.push(l.origin_id);
      }
    }
    coreTargets.set(g.id, targets);
  }
  const intoCore = (e) => coreTargets.get(e.to)?.has(String(e.toNode));
  const direct = collectCrossEdges(links, nodeGroup).filter(intoCore);
  /* 先用直接边定 kind，排出 latent 序号供读档口映射 */
  const latentIds = stageGroups
    .filter((g) => !isVideoStage(g, membersOf(g), direct.filter((e) => e.to === g.id).map((e) => e.type)))
    .sort((a, b) => (titleOrder(groupTitle(a)) || 0) - (titleOrder(groupTitle(b)) || 0))
    .map((g) => g.id);
  const traced = collectTracedEdges(links, nodeGroup, byTarget, castId, latentIds).filter(intoCore);

  const seenPair = new Set();
  const allEdges = [];
  const crossAll = [...direct, ...traced];
  for (const e of crossAll) {
    const key = e.from + "->" + e.to;
    if (seenPair.has(key)) continue;
    seenPair.add(key);
    allEdges.push(e);
  }

  const stages = stageGroups.map((g) => {
    const members = membersOf(g);
    const inEdges = allEdges.filter((e) => e.to === g.id);
    return {
      id: g.id, title: groupTitle(g),
      kind: isVideoStage(g, members, inEdges.map((e) => e.type)) ? "video" : "latent",
      order: titleOrder(groupTitle(g)),
      members: members.map((n) => n.id),
      videoOut: stageVideoOut(members, links),
      imageOut: stageImageOut(members, links),
      from: inEdges.map((e) => e.from),
      fromSockets: inEdges.map((e) => e.socket || null),
      edgeTypes: inEdges.map((e) => e.type),
      edgeInferred: inEdges.map(() => false),
      /* 每条跨组入线的目标端（不去重）：静音上游会把出线带出提交对象，
         编排层靠这份名单给启用阶段补回缺失的输入口（2026-11-18 二次事故根修） */
      inEdges: crossAll.filter((e) => e.to === g.id).map((e) => ({
        from: e.from, type: e.type, socket: e.socket || null,
        toNode: e.toNode, toSlot: e.toSlot, toName: nameOf(e.toNode, e.toSlot),
        boundary: e.boundary ? { ...e.boundary, toName: nameOf(e.boundary.toNode, e.boundary.toSlot) } : null,
      })),
    };
  });

  /* 序号补全只兜底「完全没有真实入边」的 latent，标推断；有真实边（哪怕接去别的阶段）绝不造边 */
  const latents = stages.filter((s) => s.kind === "latent")
    .sort((a, b) => (a.order || 0) - (b.order || 0));
  latents.forEach((s, i) => {
    if (i === 0) return;
    const prev = latents[i - 1];
    if (!s.from.length) {
      // 真实接线可能与标题序号相反，不能用序号补边反向闭环。
      const pending = [prev.id], seen = new Set();
      while (pending.length) {
        const id = pending.pop();
        if (seen.has(id)) continue;
        seen.add(id);
        pending.push(...(stages.find((x) => x.id === id)?.from || []));
      }
      if (seen.has(s.id)) return;
      s.from.push(prev.id);
      s.fromSockets.push(null);
      s.edgeTypes.push("LATENT");
      s.edgeInferred.push(true);
      warnings.push(`「${prev.title}」→「${s.title}」无真实连线，按标题序号推断（虚线）`);
    }
  });

  /* video 组没有真实入边通常是漏连，提示而非猜挂 */
  stages.filter((s) => s.kind === "video" && !s.from.length).forEach((s) => {
    warnings.push(`组「${s.title}」没有上游连线，请把上游视频接进该组`);
  });
  stages.filter((s) => !s.members.length).forEach((s) => {
    warnings.push(`组「${s.title}」内没有节点，请检查框选范围`);
  });

  const finalEdges = [];
  stages.forEach((s) => s.from.forEach((f, k) => {
    finalEdges.push({ from: f, to: s.id, type: s.edgeTypes[k] });
  }));
  const sorted = topoSort(stages, finalEdges);
  let exactOnly = false;
  if (sorted.length !== stages.length) {
    const cycle = nodeCycle(graph);
    if (cycle) errors.push("节点连线存在环：" + cycle.map((id) => "#" + id).join(" → ") + "，请断开其中一条回线");
    else {
      exactOnly = true;
      warnings.push("节点链路无环，已识别为分组跨执行位置；全部启用时按原连线执行");
    }
  }
  // 判环失败仍保留所有组的身份和开关，便于用户纠正；错误仍阻止提交。
  const ordered = sorted.length === stages.length ? sorted : stages;
  for (const group of mirror) {
    const stage = ordered.find((s) => s.id === group.id);
    if (stage) { group.kind = stage.kind; group.stage = true; }
  }
  return { mode: "group", stages: ordered, observers, mirror, warnings, errors, exactOnly };
}
