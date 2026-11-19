/* 阶段解析：把画布组与跨组连线解析成阶段 DAG。无组时回退，旧工作流零破坏。
   只识别标题含「采/超分」的阶段组；跨组边优先认真实连线（含穿过组外节点的透明中转），
   完全没有真实边时才按标题序号推断并标 inferred（渲染虚线）。 */
import { groupList, nodeList, inGroup, groupTitle } from "./bz_group_utils.js";

const VIDEO_HINTS = ["超分", "RelayVSR"];
const VIDEO_CLASSES = [
  "BanZhangRelayVSRStreaming",
  "BanZhang_RIFE_Interpolation",
  "BanZhang_RTX_SuperResolution",
];
const CN_NUM = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };

function isStageTitle(title) {
  return title.includes("采") || title.includes("超分");
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
    if (hits.length > 1) {
      errors.push(`节点「${node.title || node.id}」同时位于 ${hits.length} 个阶段组内，请解散重叠分组`);
    }
    if (hits.length === 1) map[node.id] = hits[0].id;
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
    if (!link || link.origin_id == null) continue;
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
   返回 Map：阶段 id → 该阶段边界上的输出 socket [nodeId, slot]（导演台读档口为 null）。 */
function traceSources(originId, originSlot, nodeGroup, byTarget, castId, latentIds) {
  const found = new Map();
  const seen = new Set();
  const queue = [[originId, originSlot]];
  while (queue.length) {
    const [id, slot] = queue.shift();
    if (id == null) continue;
    const key = id + "|" + slot;
    if (seen.has(key)) continue;
    seen.add(key);
    if (nodeGroup[id]) {
      if (!found.has(nodeGroup[id])) found.set(nodeGroup[id], [id, slot]);
      continue;
    }
    if (castId != null && String(id) === String(castId)) {
      const s = castPortStage(slot, latentIds);
      if (s && !found.has(s)) found.set(s, null);
      continue;
    }
    for (const l of byTarget[id] || []) queue.push([l.origin_id, l.origin_slot]);
  }
  return found;
}

/* 入端在阶段组、源端在组外的连线：追出真实源阶段补边 */
function collectTracedEdges(links, nodeGroup, byTarget, castId, latentIds) {
  const edges = [];
  for (const link of links) {
    if (!link || link.origin_id == null) continue;
    const b = nodeGroup[link.target_id];
    if (!b || nodeGroup[link.origin_id]) continue;
    for (const [a, socket] of traceSources(link.origin_id, link.origin_slot, nodeGroup, byTarget, castId, latentIds)) {
      if (a !== b) edges.push({
        from: a, to: b, type: link.type || "", socket,
        toNode: link.target_id, toSlot: link.target_slot,
      });
    }
  }
  return edges;
}

/* kind：标题「超分」与入边类型优先；有 LATENT 入边即 latent（接线说了算），
   类名白名单只在没有任何入边类型信息时兜底 */
function isVideoStage(group, members, inTypes) {
  const title = groupTitle(group);
  if (title.includes("超分")) return true;
  if (inTypes.some((t) => t === "VIDEO")) return true;
  if (inTypes.some((t) => t === "LATENT")) return false;
  if (VIDEO_HINTS.some((k) => title.includes(k))) return true;
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

/* 主入口：返回阶段 DAG 或回退标志，调用方据此渲染与改线 */
export function detectStages(graph) {
  const allGroups = groupList(graph);
  if (!allGroups.length) return { mode: "fallback", stages: [], warnings: [], errors: [] };

  const stageGroups = allGroups.filter((g) => isStageTitle(groupTitle(g)));
  if (!stageGroups.length) return { mode: "fallback", stages: [], warnings: [], errors: [] };

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

  const direct = collectCrossEdges(links, nodeGroup);
  /* 先用直接边定 kind，排出 latent 序号供读档口映射 */
  const latentIds = stageGroups
    .filter((g) => !isVideoStage(g, membersOf(g), direct.filter((e) => e.to === g.id).map((e) => e.type)))
    .sort((a, b) => (titleOrder(groupTitle(a)) || 0) - (titleOrder(groupTitle(b)) || 0))
    .map((g) => g.id);
  const traced = collectTracedEdges(links, nodeGroup, byTarget, castId, latentIds);

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
      from: inEdges.map((e) => e.from),
      fromSockets: inEdges.map((e) => e.socket || null),
      edgeTypes: inEdges.map((e) => e.type),
      edgeInferred: inEdges.map(() => false),
      /* 每条跨组入线的目标端（不去重）：静音上游会把出线带出提交对象，
         编排层靠这份名单给启用阶段补回缺失的输入口（2026-11-18 二次事故根修） */
      inEdges: crossAll.filter((e) => e.to === g.id).map((e) => ({
        from: e.from, type: e.type, socket: e.socket || null,
        toNode: e.toNode, toSlot: e.toSlot, toName: nameOf(e.toNode, e.toSlot),
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
  if (sorted.length !== stages.length) errors.push("阶段组之间存在环，请检查跨组连线");
  return { mode: "group", stages: sorted, warnings, errors };
}