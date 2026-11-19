/* 组模式编排：不依赖节点类名，按阶段 DAG 与开关裁剪出片口、把禁用上游改接活源或总线口。
   改接优先级：有启用上游祖先 → 接它的活输出口（本次运行的新鲜数据，执行顺序自然排在其后）；
   没有启用上游 → 退回导演台总线口读档（12/13）。总线口读的是盘上档案，
   上游同跑时档案还没写出来，接了必空——这是 2026-11-18「关二采三采跳过」事故的根因。 */

const BUS_LATENT_PORT = 12;   // 导演台「下游潜空间」0 起索引
const BUS_VIDEO_PORT = 13;    // 导演台「下游视频」0 起索引

function cloneOutput(output) {
  const g = {};
  for (const [k, spec] of Object.entries(output || {})) {
    g[k] = { ...(spec || {}), inputs: { ...((spec || {}).inputs || {}) } };
  }
  return g;
}

export function applyGroupScope(output, detected, enabledStageIds, castId) {
  const g = cloneOutput(output);
  const enabledSet = new Set(enabledStageIds);
  const allEnabled = detected.stages.every((s) => enabledSet.has(s.id));

  if (allEnabled) {
    // 全启用 = 整图跑，不裁不改，与旧行为一致
    return { output: g, partialExecutionTargets: null, rewired: [] };
  }

  const targets = [];
  const rewired = [];
  const castIdStr = String(castId);
  const stageOf = {};
  detected.stages.forEach((s) => s.members.forEach((m) => { stageOf[String(m)] = s; }));
  const byId = (id) => detected.stages.find((s) => s.id === id);

  /* 沿 output 入线 backward 穿组外中转，收集落到的阶段组。
     mute 节点不在 output 里，天然是死端；导演台读档口不算活源，也停。 */
  function hitStages(srcId) {
    const hits = new Set();
    const seen = new Set();
    const queue = [String(srcId)];
    while (queue.length) {
      const id = queue.shift();
      if (seen.has(id)) continue;
      seen.add(id);
      const st = stageOf[id];
      if (st) { hits.add(st); continue; }
      if (id === castIdStr) continue;
      const spec = g[id];
      if (!spec) continue;
      for (const val of Object.values(spec.inputs || {})) {
        if (Array.isArray(val) && val.length === 2) queue.push(String(val[0]));
      }
    }
    return hits;
  }

  /* 禁用阶段沿阶段 DAG 向上找最近的启用祖先 */
  function enabledAncestor(stage) {
    const seen = new Set();
    const queue = [stage];
    while (queue.length) {
      const s = queue.shift();
      if (seen.has(s.id)) continue;
      seen.add(s.id);
      if (enabledSet.has(s.id)) return s;
      s.from.forEach((f) => { const up = byId(f); if (up) queue.push(up); });
    }
    return null;
  }

  /* latent 改接：取启用祖先喂进禁用链的那个输出 socket（检测期已记在 fromSockets） */
  function socketFromAncestor(disabledStage, up) {
    const seen = new Set();
    const queue = [disabledStage];
    while (queue.length) {
      const s = queue.shift();
      if (seen.has(s.id)) continue;
      seen.add(s.id);
      const k = s.from.indexOf(up.id);
      if (k >= 0 && s.fromSockets && s.fromSockets[k]) return s.fromSockets[k];
      s.from.forEach((f) => {
        const x = byId(f);
        if (x && !enabledSet.has(x.id)) queue.push(x);
      });
    }
    return null;
  }

  for (const stage of detected.stages) {
    const on = enabledSet.has(stage.id);
    if (on) {
      for (const m of stage.members) {
        if (String(m) !== castIdStr) targets.push(String(m));
      }
    }
    if (!on) continue;
    if (!stage.from.some((f) => !enabledSet.has(f))) continue;

    for (const mid of stage.members) {
      const spec = g[mid];
      if (!spec || !spec.inputs) continue;
      for (const [key, val] of Object.entries(spec.inputs)) {
        if (!Array.isArray(val) || val.length !== 2) continue;
        const srcStage = stageOf[String(val[0])];
        if (srcStage && enabledSet.has(srcStage.id)) continue; // 已接启用阶段，不动
        const hits = srcStage ? new Set([srcStage]) : hitStages(val[0]);
        const disabled = [...hits].filter((s) => !enabledSet.has(s.id));
        if (!disabled.length) continue;

        const up = enabledAncestor(disabled[0]);
        let target = null;
        if (up) {
          target = stage.kind === "video" ? (up.videoOut || null) : socketFromAncestor(disabled[0], up);
        }
        if (target) {
          g[mid].inputs[key] = [String(target[0]), target[1]];
          rewired.push({ node: String(mid), input: key, to: target, live: true });
        } else {
          const busPort = stage.kind === "video" ? BUS_VIDEO_PORT : BUS_LATENT_PORT;
          g[mid].inputs[key] = [castIdStr, busPort];
          rewired.push({ node: String(mid), input: key, port: busPort });
        }
      }
    }

    /* 补口（2026-11-18 二次事故根修）：mute 联动把禁用上游设 mode=2 后，
       graphToPrompt 会把该节点连同它的出线一起从提交对象里删掉（前端 v1.58.5
       实测：不在 output 表里的源，其入线一律 delete）——上面的循环只遍历
       「还在的输入口」，看不到消失的口，下游就空帧源跑/静默跳过。
       这里按检测期记下的画布跨组入线名单，给启用阶段补回缺失的输入口：
       有启用祖先接活源，没有退回总线口读档。口还在的一律不碰（那是上面
       循环与读档路由的地盘，补口只填空缺）。 */
    for (const e of stage.inEdges || []) {
      const upStage = byId(e.from);
      if (!upStage || enabledSet.has(upStage.id)) continue;
      if (!e.toName) continue;
      const spec = g[String(e.toNode)];
      if (!spec || !spec.inputs) continue;
      const cur = spec.inputs[e.toName];
      if (Array.isArray(cur) && cur.length === 2) continue;
      const up = enabledAncestor(upStage);
      const target = up
        ? (stage.kind === "video" ? (up.videoOut || null) : socketFromAncestor(upStage, up))
        : null;
      if (target) {
        spec.inputs[e.toName] = [String(target[0]), target[1]];
        rewired.push({ node: String(e.toNode), input: e.toName, to: target, live: true, injected: true });
      } else {
        const busPort = stage.kind === "video" ? BUS_VIDEO_PORT : BUS_LATENT_PORT;
        spec.inputs[e.toName] = [castIdStr, busPort];
        rewired.push({ node: String(e.toNode), input: e.toName, port: busPort, injected: true });
      }
    }
  }

  return {
    output: g,
    partialExecutionTargets: targets.length ? targets : null,
    rewired,
  };
}
