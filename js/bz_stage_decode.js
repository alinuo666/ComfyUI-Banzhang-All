/* 阶段判据的前端移植（方案甲 P2a）。
 *
 * 为什么前端也要有一份：编排器在**提交前**就要知道每个🎥视频合并输出节点属哪采，
 * 才能裁输出（partialExecutionTargets）＋改接线。后端 decode_stage 是执行期判据，
 * 前端拿不到执行结果，只能按同一张 prompt.output 图自己算。两边判据必须逐字同源，
 * 否则「前端选的输出」与「后端认的阶段」对不上，收片就归错档。
 *
 * 判据＝导演台读档口携带的基阶段 ＋ 上游可见的终极放大个数（与 core/csglide_ticket.py
 * decode_stage 完全一致）：0→s1、1→s2、≥2→s3。RelayVSR 像素域三采单独认（含
 * RelayVSR 即 s3），与后端 _declare_film_identity 同口径。
 *
 * 本模块只读图、不改图，纯函数，可独立自测。改接线在 bz_stage_orchestrator.js。
 */

export const UPSCALE_TYPES = ["BanZhang_MMH3_Upscale"];
export const CAST_TYPES = ["CSGlideCastCS", "CSGlideCastLegacyCS"];
/* 导演台各输出口「本身已是第几采」（放大个数表示的基阶段）。
 * 口号按 RETURN_TYPES 序号（nodes/csglide_cast.py）：3 潜空间(活一采)=0、
 * 7 整片潜空间=0、9 本段一采潜空间=0、10 本段二采潜空间=1、11 本段二采视频=1。
 * 未列出口默认 0。口 11 是 VIDEO（喂 RelayVSR），登记基阶段只为判据自洽。 */
export const CAST_PORT_BASE = { 3: 0, 7: 0, 9: 0, 10: 1, 11: 1 };
export const STAGES = ["s1", "s2", "s3"];
/* RelayVSR 像素域超分：class 含 "RelayVSR" 即认（BanZhangRelayVSR / Streaming）。
 * 视频口超分三采走 Streaming 的「视频」(VIDEO) 输入，吃二采成片（带音轨）。 */
export const RELAYVSR_VIDEO_INPUT = "视频";
export function isRelayVSRClass(cls) {
  return String(cls || "").includes("RelayVSR");
}

function asGraph(output) {
  return output && typeof output === "object" ? output : {};
}

export function inputLinks(spec) {
  const links = [];
  for (const value of Object.values((spec || {}).inputs || {})) {
    if (Array.isArray(value) && value.length === 2) links.push(value);
  }
  return links;
}

/* 从 nodeId 的输入向上回溯，基阶段＋可见放大个数 → s1/s2/s3。
 * frontier 携带 [节点id, 连线输出口序号]：序号用来在碰导演台时取基阶段。 */
export function decodeStage(output, nodeId, maxHops = 16) {
  const graph = asGraph(output);
  const me = String(nodeId);
  const seen = new Set();
  let frontier = inputLinks(graph[me]).map((v) => [String(v[0]), v[1]]);
  const upscales = new Set();
  let base = 0;
  for (let hop = 0; hop < maxHops; hop++) {
    if (!frontier.length) break;
    const nxt = [];
    for (const [nid, outIdx] of frontier) {
      if (seen.has(nid) || nid === me) continue;
      seen.add(nid);
      const spec = graph[nid] || {};
      const cls = String(spec.class_type || "");
      if (UPSCALE_TYPES.includes(cls)) upscales.add(nid);
      if (CAST_TYPES.includes(cls)) {
        let b = CAST_PORT_BASE[Number(outIdx)];
        if (Number(outIdx) === 12) {
          try {
            const raw = spec.inputs?.h3_data || "{}";
            const data = typeof raw === "string" ? JSON.parse(raw) : raw;
            const stages = (data.stage_flow?.stages || []).filter((s) => s?.kind === "latent");
            const boundary = stages.findIndex((stage, i) => i > 0 && stage.enabled && !stages[i - 1].enabled);
            b = boundary > 0 ? boundary - 1 : 0;
          } catch (_) { b = 0; }
        }
        base = Math.max(base, b === undefined ? 0 : b);
        continue;
      }
      for (const v of inputLinks(spec)) nxt.push([String(v[0]), v[1]]);
    }
    frontier = nxt;
  }
  const n = base + upscales.size;
  if (n >= 2) return "s3";
  if (n === 1) return "s2";
  return "s1";
}

/* 上游是否含 RelayVSR（像素域三采超分）。碰导演台即停，不往源头之上爬。 */
export function hasRelayVSR(output, nodeId, maxHops = 16) {
  const graph = asGraph(output);
  const me = String(nodeId);
  const seen = new Set([me]);
  let frontier = inputLinks(graph[me]).map((v) => String(v[0]));
  for (let hop = 0; hop < maxHops && frontier.length; hop++) {
    const nxt = [];
    for (const nid of frontier) {
      if (seen.has(nid)) continue;
      seen.add(nid);
      const spec = graph[nid] || {};
      const cls = String(spec.class_type || "");
      if (cls.includes("RelayVSR")) return true;
      if (CAST_TYPES.includes(cls)) continue;
      for (const v of inputLinks(spec)) nxt.push(String(v[0]));
    }
    frontier = nxt;
  }
  return false;
}

/* 一个输出节点属哪采：RelayVSR→s3，否则数放大判据。 */
export function stageOfOutput(output, nodeId) {
  if (hasRelayVSR(output, nodeId)) return "s3";
  return decodeStage(output, nodeId);
}

/* 三采子图的方式：上游含 RelayVSR＝视频口超分(video)，否则终极放大链＝潜空间(latent)。
 * 供「三采方式」切换钮按方式筛三采出口、并决定改接哪个读档口（video→11 / latent→10）。 */
export function s3ModeOf(output, nodeId) {
  return hasRelayVSR(output, nodeId) ? "video" : "latent";
}

/* 枚举全图：每个🎥视频合并输出节点归到 s1/s2/s3，并认出导演台 id（改接线要用）。
 * 返回 { stageMap:{s1:[],s2:[],s3:[]}, castId }。多导演台取第一个（提交前门禁已保证唯一）。 */
export function identifyStageOutputs(output) {
  const graph = asGraph(output);
  const stageMap = { s1: [], s2: [], s3: [] };
  let castId = "";
  for (const [nid, spec] of Object.entries(graph)) {
    const cls = String((spec || {}).class_type || "");
    if (CAST_TYPES.includes(cls)) {
      if (!castId) castId = nid;
      continue;
    }
    if (cls.includes("VideoCombine")) stageMap[stageOfOutput(graph, nid)].push(nid);
  }
  return { stageMap, castId };
}
