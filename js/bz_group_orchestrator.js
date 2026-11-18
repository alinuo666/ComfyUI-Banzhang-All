/* 组模式编排：不依赖节点类名，按阶段 DAG 与开关裁剪出片口、把禁用上游改接总线口。 */

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

  for (const stage of detected.stages) {
    const on = enabledSet.has(stage.id);
    if (on) {
      for (const m of stage.members) {
        if (String(m) !== castIdStr) targets.push(String(m));
      }
    }
    /* 改线：本阶段启用但有直接上游被禁用 */
    if (!on) continue;
    const disabledUp = stage.from.filter((f) => !enabledSet.has(f));
    if (!disabledUp.length) continue;
    const upSet = new Set(disabledUp);
    const upMembers = new Set();
    detected.stages.filter((x) => upSet.has(x.id))
      .forEach((x) => x.members.forEach((m) => upMembers.add(String(m))));
    const busPort = stage.kind === "video" ? BUS_VIDEO_PORT : BUS_LATENT_PORT;

    for (const mid of stage.members) {
      const spec = g[mid];
      if (!spec || !spec.inputs) continue;
      for (const [key, val] of Object.entries(spec.inputs)) {
        if (Array.isArray(val) && val.length === 2 && upMembers.has(String(val[0]))) {
          g[mid].inputs[key] = [castIdStr, busPort];
          rewired.push({ node: String(mid), input: key, port: busPort });
        }
      }
    }
  }

  return {
    output: g,
    partialExecutionTargets: targets.length ? targets : null,
    rewired,
  };
}
