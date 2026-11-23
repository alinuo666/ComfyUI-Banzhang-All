/* 节点端口级提交规划：组只决定关闭范围，原始接线决定媒体来源。
   在副本内完成旁路、依赖裁剪与校验，成功后才交给队列。 */
const MEDIA = new Set(["IMAGE", "VIDEO", "AUDIO", "LATENT"]);
const copy = (value) => JSON.parse(JSON.stringify(value));
const isLink = (v) => Array.isArray(v) && v.length === 2 && ["string", "number"].includes(typeof v[0]) && Number.isInteger(v[1]);
const typeOf = (t) => typeof t === "string" ? t.toUpperCase() : "*";
const compatible = (a, b) => a === "*" || b === "*" || a.split(",").some((t) => b.split(",").includes(t));

/* workflow 含静音前的完整接线；output 已删掉静音节点，不能用于推断断口。
   快照不持有活节点引用，排队后的编辑不改变本次规划。 */
export function captureExecutionGraph(graph, detected, definitions = new Map()) {
  const nodes = {};
  for (const n of graph?._nodes || graph?.nodes || []) {
    const cls = n.comfyClass || n.type, def = definitions.get(cls) || n.constructor?.nodeData;
    const params = { ...(n.widgets_values_named || {}) };
    for (const w of n.widgets || []) params[w.name] = w.value;
    if (cls === "BanZhang_RouteSwitch" && Array.isArray(n.widgets_values)) {
      params.count ??= n.widgets_values[0]; params.selected ??= n.widgets_values[1];
    }
    nodes[String(n.id)] = { id: String(n.id), class_type: cls, mode: n.mode || 0,
      inputs: (n.inputs || []).map((p) => ({ name: p.name, type: typeOf(p.type) })),
      outputs: (n.outputs || []).map((p) => ({ name: p.name || "", type: typeOf(p.type) })),
      required: Object.keys(def?.input?.required || {}), isOutput: def ? !!def.output_node : (n.isOutput ?? null), params };
  }
  const links = Array.isArray(graph?.links) ? graph.links : Object.values(graph?.links || {});
  const edges = links.filter(Boolean).map((l) => {
    const e = Array.isArray(l) ? { origin_id:l[1], origin_slot:l[2], target_id:l[3], target_slot:l[4], type:l[5] } : l;
    return { from:String(e.origin_id), slot:e.origin_slot, to:String(e.target_id),
      name:nodes[String(e.target_id)]?.inputs[e.target_slot]?.name, type:typeOf(e.type) };
  }).filter((e) => e.name && nodes[e.from] && nodes[e.to]);
  return copy({ nodes, edges, stages:detected?.stages || [], observers:detected?.observers || [] });
}

export function planExecution(output, snapshot, options) {
  const g = copy(output || {}), nodes = snapshot.nodes, castId = String(options.castId);
  const enabled = new Set(options.enabledStageIds || []), disabledPosts = new Set(options.disabledPostIds || []);
  const owner = new Map(), off = new Set(), rewired = [], archives = [];
  for (const group of [...snapshot.stages, ...snapshot.observers]) {
    const disabled = snapshot.stages.includes(group) ? !enabled.has(group.id) : disabledPosts.has(group.id);
    if (disabled && group.controllable === false) throw new Error("组「" + group.title + "」不能关闭");
    for (const id of group.members) {
      const key = String(id);
      if (owner.has(key) && owner.get(key).id !== group.id) throw new Error("节点 #" + key + " 的组归属不唯一");
      owner.set(key, group); if (disabled) off.add(key);
    }
  }
  for (const id of off) delete g[id];
  const incoming = new Map(), outgoing = new Map();
  for (const edge of snapshot.edges) {
    if (!incoming.has(edge.to)) incoming.set(edge.to, []);
    if (!outgoing.has(edge.from)) outgoing.set(edge.from, []);
    incoming.get(edge.to).push(edge); outgoing.get(edge.from).push(edge);
  }
  const route = (id) => {
    if (nodes[id]?.class_type !== "BanZhang_RouteSwitch") return null;
    const params = { ...nodes[id].params, ...(g[id]?.inputs || {}) };
    const count = Math.max(2, Math.min(8, Number(params.count) || 3));
    return "input_" + Math.max(1, Math.min(8, count, Number(params.selected) || 1));
  };
  const edgesInto = (id) => (incoming.get(id) || []).filter((e) => !route(id) || e.name === route(id));
  const outputType = (id, slot, seen = new Set()) => {
    const key = id + ":" + slot;
    if (seen.has(key)) throw new Error("节点连线存在环：#" + id);
    const type = nodes[id]?.outputs[slot]?.type || "*";
    if (type !== "*" || !route(id)) return type;
    const edge = edgesInto(id)[0];
    return edge ? outputType(edge.from, edge.slot, new Set([...seen, key])) : "*";
  };

  /* 不绕过启用的未知处理节点。转换来源只从原组内、原端口可达的链上寻找；
     有多个独立末端时返回全部候选，交由唯一性校验拒绝猜线。 */
  function liveOutputs(id, slot, wanted) {
    const actual = outputType(id, slot);
    if (compatible(actual, wanted) && actual !== "*") return [[id, slot]];
    // 本包视频合并节点的图像/视频口属于同一成片；其他未知节点不假定多口等价。
    if (nodes[id]?.class_type === "banzhangVideoCombine" && actual === "VIDEO" && wanted === "IMAGE") {
      return nodes[id].outputs.flatMap((p,i) => p.type === "IMAGE" ? [[id,i]] : []);
    }
    const group = owner.get(id);
    if (!group) return [];
    const candidates = new Map(), visited = new Set(), pending = [[id, slot]];
    while (pending.length) {
      const [source, port] = pending.pop(), key = source + ":" + port;
      if (visited.has(key)) continue;
      visited.add(key);
      for (const e of outgoing.get(source) || []) {
        if (e.slot !== port || owner.get(e.to)?.id !== group.id || !g[e.to] || (route(e.to) && e.name !== route(e.to))) continue;
        for (const [i, p] of (nodes[e.to]?.outputs || []).entries()) {
          if (!MEDIA.has(p.type)) continue;
          if (p.type === wanted) candidates.set(e.to + ":" + i, [e.to, i]);
          pending.push([e.to, i]);
        }
      }
    }
    return [...candidates.values()].filter(([source]) => {
      const queue = [source], seen = new Set();
      while (queue.length) {
        const current = queue.pop();
        if (seen.has(current)) continue;
        seen.add(current);
        if (current !== source && [...candidates.values()].some(([id]) => id === current)) return false;
        for (const e of outgoing.get(current) || []) {
          if (MEDIA.has(e.type) && owner.get(e.to)?.id === group.id && g[e.to]
            && (!route(e.to) || e.name === route(e.to))) queue.push(e.to);
        }
      }
      return true;
    });
  }

  /* 潜空间用一/二采明确档口；视频总线兼容口必须先核对其真实档位。
     文件存在性和项目/片段/版本由导演台现有的读档契约校验。 */
  function archive(group, wanted, targetId) {
    const latents = snapshot.stages.filter((s) => s.kind === "latent");
    const index = latents.findIndex((s) => s.id === group?.id);
    let port = wanted === "LATENT" ? [9, 10][index] : wanted === "VIDEO" && index === 1 ? 11 : null;
    if (wanted === "VIDEO" && index === 0) {
      const targetGroup = owner.get(targetId);
      if (!targetGroup) {
        /* 组外中转（选路器等）无法按目标位置定位档位，走下游总线口；
           读哪一档由后端按提交时冻结的 stage_flow 裁决（core/csglide_stage_bus），
           缺档宽容：返回 None＋中文日志，不炸前面的采。 */
        port = 13;
      } else {
        const before = snapshot.stages.slice(0, snapshot.stages.findIndex((s) => s.id === targetGroup.id)).filter((s) => s.kind === "latent");
        const active = before.filter((s) => enabled.has(s.id));
        if ((active.length ? active : before).at(-1)?.id === group.id) port = 13;
      }
    }
    if (port == null || !g[castId]) throw new Error("节点 #" + targetId + " 所需上游的档位与自动管道不一致，无法唯一确定存档，请启用上游或明确接线");
    archives.push({ group:group.id, type:wanted, port }); return [castId, port];
  }
  function resolve(id, slot, wanted, targetId, visiting = new Set()) {
    const key = id + ":" + slot + ":" + wanted;
    if (visiting.has(key)) throw new Error("旁路后节点连线存在环：#" + id);
    if (!off.has(id)) {
      if (!g[id]) throw new Error("节点 #" + targetId + " 的上游 #" + id + " 被手动静音或没有参与提交");
      if (route(id) && !compatible(outputType(id,slot),wanted)) {
        const selected = edgesInto(id)[0];
        return selected ? resolve(selected.from,selected.slot,wanted,targetId,new Set([...visiting,key])) : [];
      }
      return liveOutputs(id, slot, wanted);
    }
    const group = owner.get(id), pending = [id], seen = new Set(), found = new Map(), next = new Set([...visiting, key]);
    while (pending.length) {
      const current = pending.pop();
      if (seen.has(current)) continue;
      seen.add(current);
      for (const e of edgesInto(current)) {
        if (!MEDIA.has(e.type) && e.type !== "*") continue;
        if (owner.get(e.from)?.id === group.id) { pending.push(e.from); continue; }
        for (const link of resolve(e.from, e.slot, wanted, targetId, next)) found.set(link.join(":"), link);
      }
    }
    if (!found.size && snapshot.stages.some((s) => s.id === group.id)) {
      const link = archive(group, wanted, targetId); found.set(link.join(":"), link);
    }
    if (found.size !== 1) throw new Error("组「" + group.title + "」节点 #" + id + " 的输出无法唯一确定旁路来源："
      + (found.size ? "存在多个来源 " + [...found.values()].map((v) => "#" + v[0] + "口" + v[1]).join("、") : "没有可用的同类型上游，请启用其上游或明确接线"));
    return [...found.values()];
  }

  /* 原生 bypass 已改好的线保持不动。选路器未选通路不进入依赖图，
     防止后端提前求值无关支线；已选通路缺线必须在入队前报出。 */
  for (const [id, spec] of Object.entries(g)) {
    const selected = route(id);
    if (selected) for (const name of Object.keys(spec.inputs)) if (/^input_\d+$/.test(name) && name !== selected) delete spec.inputs[name];
    for (const e of edgesInto(id)) {
      if (!off.has(e.from)) continue;
      const current = spec.inputs[e.name];
      if (current != null && (!isLink(current) || String(current[0]) !== e.from || current[1] !== e.slot)) continue;
      const wanted = e.type === "*" ? outputType(e.from, e.slot) : e.type;
      if (!MEDIA.has(wanted)) throw new Error("节点 #" + id + " 输入「" + e.name + "」没有可安全旁路的媒体类型");
      const [target] = resolve(e.from, e.slot, wanted, id);
      spec.inputs[e.name] = [...target];
      rewired.push({ node:id, input:e.name, to:target, live:target[0] !== castId,
        ...(target[0] === castId ? { port:target[1] } : {}), injected:current == null });
    }
  }
  const targets = (options.targets || Object.keys(g).filter((id) => nodes[id]?.isOutput === true)).map(String).filter((id) => g[id]);
  if (!targets.length) throw new Error("当前启用范围没有可运行的输出节点，请检查出片节点及其输出声明");
  const retained = new Set(), active = new Set(), path = [];
  function validate(id) {
    if (active.has(id)) throw new Error("节点连线存在环：" + [...path,id].map((n) => "#" + n).join(" → "));
    if (retained.has(id)) return;
    const spec = g[id];
    if (!spec) throw new Error("提交图引用了未参与运行的节点 #" + id);
    active.add(id); path.push(id);
    const meta = nodes[id], selected = route(id);
    if (selected && !isLink(spec.inputs[selected])) throw new Error("选路器 #" + id + " 的第 " + selected.slice(6) + " 路没有连线");
    for (const name of meta?.required || []) if (spec.inputs[name] == null) throw new Error("节点 #" + id + " 缺少必需输入「" + name + "」");
    for (const [name,val] of Object.entries(spec.inputs)) {
      const input = meta?.inputs.find((p) => p.name === name);
      if (!isLink(val) || (!input && !nodes[String(val[0])])) continue;
      const source = String(val[0]), from = nodes[source];
      if (off.has(source)) throw new Error("节点 #" + id + " 仍引用关闭的节点 #" + source);
      if (from && (val[1] < 0 || val[1] >= from.outputs.length)) throw new Error("节点 #" + id + " 输入「" + name + "」引用了不存在的输出口");
      const actual = outputType(source,val[1]);
      if (input && !compatible(actual,input.type)) throw new Error("节点 #" + id + " 输入「" + name + "」的连线类型不兼容（" + actual + " → " + input.type + "）");
      validate(source);
    }
    path.pop(); active.delete(id); retained.add(id);
  }
  for (const id of targets) validate(id);
  if (g[castId]) validate(castId);  // 保留段身份与编译入口，不把导演台变成执行目标。
  for (const id of Object.keys(g)) if (!retained.has(id)) delete g[id];
  return { output:g, partialExecutionTargets:[...new Set(targets)], rewired, archives, unified:true };
}

/* 无组旧工作流的后处理旁路专用（applyPostGroupScope）：从提交连线补齐元数据。
   组模式一律走 captureExecutionGraph 的完整接线快照，不再经过这里。 */
function legacySnapshot(output, detected) {
  const nodes = {}, edges = [];
  const add = (id) => nodes[String(id)] ||= { id:String(id), class_type:output[id]?.class_type, inputs:[], outputs:[], required:[], params:{}, isOutput:null };
  const edge = (from,slot,to,name,type) => {
    if (!name) return;
    from = String(from); to = String(to); add(from); add(to);
    /* 提交连线不带类型（'*'），组边界边带真实类型；同一条线后到的类型要升级，
       否则「先到为准」会把 '*' 留下，规划器认不出媒体类型就不敢旁路。 */
    const out = nodes[from].outputs[slot] ||= { type };
    if (out.type === "*" && type !== "*") out.type = type;
    let input = nodes[to].inputs.find((p) => p.name === name);
    if (!input) nodes[to].inputs.push(input = { name, type });
    else if (input.type === "*" && type !== "*") input.type = type;
    const existing = edges.find((e) => e.to === to && e.name === name);
    if (!existing) edges.push({ from,slot,to,name,type });
    else if (existing.type === "*" && type !== "*") existing.type = type;
  };
  for (const [id,spec] of Object.entries(output)) {
    add(id); for (const [name,val] of Object.entries(spec.inputs || {})) if (isLink(val)) edge(val[0],val[1],id,name,"*");
  }
  for (const group of [...detected.stages,...(detected.observers || [])]) {
    for (const id of group.members) add(id);
    for (const e of [...(group.edges || group.inEdges || []),...(group.outEdges || [])]) {
      const source = detected.stages.find((s) => s.id === e.from);
      edge(e.fromNode ?? e.socket?.[0] ?? source?.members[0], e.fromSlot ?? e.socket?.[1] ?? 0,
        e.toNode,e.toName,e.type || (group.kind === "video" ? "VIDEO" : "LATENT"));
    }
  }
  for (const n of Object.values(nodes)) n.outputs = Array.from(n.outputs,(p) => p || { type:"*" });
  return { nodes,edges,stages:detected.stages,observers:detected.observers || [] };
}
export function applyGroupScope(output, detected, enabledStageIds, castId, options = {}) {
  if (!options.snapshot && detected.executionGraph) options.snapshot = captureExecutionGraph(detected.executionGraph,detected);
  if (!options.snapshot && detected.stages.every((s) => enabledStageIds.includes(s.id))) return { output:copy(output),partialExecutionTargets:null,rewired:[] };
  /* 组模式必须有完整接线快照（调用侧在提交一刻抓画布）。旧的 legacySnapshot
     兜底＋强制总线口 12/13 已删（20261123 第5步）：它按提交连线猜类型，
     与精确档口契约冲突。无组旧工作流的后处理旁路仍走 applyPostGroupScope。 */
  if (!options.snapshot) throw new Error("分组跨越多个执行位置，请全部启用运行或提供完整节点接线");
  const snapshot = options.snapshot;
  const targets = options.targets || (Object.values(snapshot.nodes).some((n) => n.isOutput !== null) ? undefined : Object.keys(output));
  return planExecution(output,snapshot,{ ...options,targets,enabledStageIds,castId });
}
export function applyPostGroupScope(output, groups, disabledIds, targets) {
  if (!disabledIds.length) return { output:copy(output),partialExecutionTargets:targets };
  return planExecution(output,legacySnapshot(output,{ stages:[],observers:groups }),
    { enabledStageIds:[],disabledPostIds:disabledIds,targets:targets || Object.keys(output),castId:"" });
}
