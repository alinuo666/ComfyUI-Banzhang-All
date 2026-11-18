/* 阶段解析：把画布组与跨组连线解析成阶段 DAG。无组时回退，旧工作流零破坏。
   只识别标题含「采/超分」的阶段组；latent 阶段按标题序号补全，video 组走真实边。 */
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

/* 阶段组之间的跨组连线即阶段边，按组对去重，连线类型决定 LATENT / VIDEO */
function collectCrossEdges(graph, nodeGroup) {
  const raw = Array.isArray(graph.links) ? graph.links : Object.values(graph.links || {});
  const seen = new Set();
  const edges = [];
  for (const link of raw) {
    if (!link || link.origin_id == null) continue;
    const a = nodeGroup[link.origin_id], b = nodeGroup[link.target_id];
    if (!a || !b || a === b) continue;
    const key = a + "->" + b;
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push({ from: a, to: b, type: link.type || "" });
  }
  return edges;
}

function isVideoStage(group, members, inTypes) {
  const title = groupTitle(group);
  if (title.includes("超分")) return true;
  if (inTypes.some((t) => t === "VIDEO")) return true;
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

/* 主入口：返回阶段 DAG 或回退标志，调用方据此渲染与改线 */
export function detectStages(graph) {
  const allGroups = groupList(graph);
  if (!allGroups.length) return { mode: "fallback", stages: [], warnings: [], errors: [] };

  const stageGroups = allGroups.filter((g) => isStageTitle(groupTitle(g)));
  if (!stageGroups.length) return { mode: "fallback", stages: [], warnings: [], errors: [] };

  const stageIds = new Set(stageGroups.map((g) => g.id));
  const { map: nodeGroup, errors } = resolveNodeGroups(graph, stageIds);
  const edges = collectCrossEdges(graph, nodeGroup);
  const warnings = [];

  const stages = stageGroups.map((g) => {
    const members = nodeList(graph).filter((n) => nodeGroup[n.id] === g.id);
    const inEdges = edges.filter((e) => e.to === g.id);
    const kind = isVideoStage(g, members, inEdges.map((e) => e.type)) ? "video" : "latent";
    return {
      id: g.id, title: groupTitle(g), kind,
      order: titleOrder(groupTitle(g)),
      members: members.map((n) => n.id),
      from: inEdges.map((e) => e.from),
      edgeTypes: inEdges.map((e) => e.type),
    };
  });

  /* latent 阶段按标题序号补全：阶段间 latent 经导演台中转、画布上可能无直接连线 */
  const latents = stages.filter((s) => s.kind === "latent")
    .sort((a, b) => (a.order || 0) - (b.order || 0));
  latents.forEach((s, i) => {
    if (i === 0) return;
    const prev = latents[i - 1];
    if (!s.from.includes(prev.id)) {
      s.from.push(prev.id);
      s.edgeTypes.push("LATENT");
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
