/* 视频中 prompt 是实际提交，workflow 保存节点布局与编辑控件。按节点 ID 对齐两份数据。 */
function objectValue(value) {
  try { return typeof value === "string" ? JSON.parse(value) : value; }
  catch { return null; }
}

export function restoreVideoWorkflow(graph, prompt, fileName) {
  if (!Array.isArray(graph?.nodes) || !Object.values(prompt || {}).some(n => n?.class_type === "banzhangVideoCombine")) return false;
  for (const node of graph.nodes) {
    const entry = prompt[node.id];
    if (!entry || entry.class_type !== node.type) continue;
    const inputs = entry.inputs || {};
    const values = node.widgets_values;
    const named = node.widgets_values_named;
    const keys = Object.keys(named || {});
    const ordered = Array.isArray(values) && keys.length === values.length &&
      keys.every((k,i) => JSON.stringify(named[k]) === JSON.stringify(values[i]));
    for (const [i,key] of keys.entries()) {
      if (!Object.hasOwn(inputs,key) || typeof inputs[key] === "object") continue;
      named[key] = inputs[key];
      if (ordered) values[i] = inputs[key];
    }
    const field = {CSGlideDeskCS:"desk_data",CSGlideCastCS:"h3_data",CSGlideH3MediaRackCS:"rack_data"}[node.type];
    if (field && typeof inputs[field] === "string" && Array.isArray(values)) values[0] = inputs[field];
    if (node.type !== "CSGlideCastCS") continue;
    const state = objectValue(inputs.h3_data);
    const project = node.properties?.gcast_project;
    if (!state?.chain || !Array.isArray(project?.shots)) continue;
    const {shot,clip} = state.chain;
    const idx = project.shots.findIndex(s => (shot && s.id === shot) || (clip && s.clip === clip));
    if (idx < 0) continue;
    project.idx = idx;
    project.shots[idx].state = state;
    const source = link => Array.isArray(link) ? prompt[link[0]]?.inputs : null;
    const deskInputs = source(inputs.prompt_text);
    const desk = objectValue(deskInputs?.desk_data);
    const rack = objectValue(source(inputs.refs)?.rack_data || source(deskInputs?.参考素材)?.rack_data);
    const text = desk?.segs?.[clip] ?? desk?.segs?.[shot] ?? desk?.pending_seg;
    if (rack) project.shots[idx].rack = rack.segs?.[clip] || {slots:rack.slots,fps:rack.fps,audio_out:rack.audio_out};
    if (fileName) node.properties.bz_video_restore = {fileName,state,text,global:desk?.global,alias:desk?.alias,rack:rack && project.shots[idx].rack};
  }
  return true;
}
