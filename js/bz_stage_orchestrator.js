/* 导演台总控编排器（方案甲 P2）。
 *
 * 职责：把「运行模式 × 当前阶段」翻译成一次提交的**执行范围**——
 *   ① 选输出节点：只让目标阶段的🎥视频合并节点跑（partialExecutionTargets）；
 *   ② 改接线（P2b）：上游阶段不在本次范围时，把跨采活线改接到导演台读档口
 *      （9=本段一采潜空间、10=本段二采潜空间），让下游吃已写好的档而非重跑上游。
 *
 * 为什么必须同时做①②：ComfyUI 是拉取式执行，只裁输出节点不够——反闭包会把上游
 * 整条拉起来重跑。只有「裁输出＋把范围外上游改接读档口」两者一起做，才能让一采按钮
 * 真正决定二采跑不跑。
 *
 * 落点：全部改在**编译后的 prompt.output** 上（与 promptBuild.apply / bz_project_store
 * 同一机制），不动画布、无需还原。由 bz_queue_align.js 在包装层最顶部调用，单跑与
 * 批跑每一段统一生效（P2c 接入）。
 *
 * 关键选项名（已核实前端真身 assets/api-*.js）：底层 api.queuePrompt 读
 * options.partialExecutionTargets → 后端 partial_execution_targets。上层 GraphView
 * 用的 queueNodeIds 是 app 队列服务名，到底层已翻译，本包装层只认 partialExecutionTargets。
 */

import {
  identifyStageOutputs, decodeStage, stageOfOutput, s3ModeOf, inputLinks,
  isRelayVSRClass, UPSCALE_TYPES, CAST_TYPES, STAGES, RELAYVSR_VIDEO_INPUT,
} from "./bz_stage_decode.js";

export { STAGES };

/* 运行模式下拉（P2c 挂到监视器阶段控件旁）。默认「全程」开箱即用。 */
export const RUN_MODES = [
  { value: "only", label: "只跑本阶段" },
  { value: "toEnd", label: "从本阶段跑到最后" },
  { value: "all", label: "全程" },
];
export const DEFAULT_RUN_MODE = "all";

/* 三采方式切换钮（P3）：现在视频口超分，以后可能潜空间放大。默认视频口超分。
 * 它决定认哪条三采子图的合并节点为出口、跨采改接哪个读档口（video→11 / latent→10）。
 * 不自动改画布接线：钮与画布拓扑对不上时按画布实际有的那条安全兜底（s3Fallback）。 */
export const S3_MODES = [
  { value: "video", label: "视频口超分" },
  { value: "latent", label: "潜空间放大" },
];
export const DEFAULT_S3_MODE = "video";

/* 模式×当前阶段 → 本次要跑的阶段集合。 */
export function targetStages(mode, currentStage) {
  const cur = STAGES.includes(currentStage) ? currentStage : "s1";
  if (mode === "only") return [cur];
  if (mode === "toEnd") return STAGES.slice(STAGES.indexOf(cur));
  return STAGES.slice();   // all / 未知模式 → 全程（最安全，不裁）
}

/* 导演台读档口序号（nodes/csglide_cast.py RETURN_TYPES）：
 * 本段一采潜空间=9、本段二采潜空间=10。改接线时按上游阶段取对应口。 */
export const READ_PORT = { s1: 9, s2: 10 };
/* 视频口超分三采的读档口：本段二采视频=11（VIDEO，带音轨）。RelayVSRStreaming
 * 的「视频」输入跨采活线来自二采合并，二采被裁出范围时改接本口。 */
export const READ_PORT_VIDEO = { s2: 11 };
/* 二采合并节点的实时 VIDEO 输出口序号（nodes/banzhang_video_tools.py
 * RETURN_TYPES=("IMAGE","VIDEO","AUDIO")，口 1=📹视频对象）。二采本轮要跑时，
 * 三采「视频」口改接这里而非读档口 11，形成 一采→二采→三采 硬依赖、保证先后。 */
const MERGE_VIDEO_OUTPUT = 1;

/* 终极放大节点的 latent 输入口名（nodes/banzhang_mmh3_upscale.py INPUT_TYPES）。
 * 跨采活线就接在这个口上，改接线即改它。 */
const UPSCALE_LATENT_INPUT = "潜空间";

/* 从合并节点向上 BFS，按「离合并节点由近到远」收集终极放大节点。
 * 模型/条件分支不含终极放大，不会混进来；碰导演台即停。 */
function upscalesNearestFirst(graph, mergeId, maxHops = 24) {
  const me = String(mergeId);
  const seen = new Set([me]);
  let frontier = inputLinks(graph[me]).map((v) => String(v[0]));
  const order = [];
  for (let hop = 0; hop < maxHops && frontier.length; hop++) {
    const nxt = [];
    for (const nid of frontier) {
      if (seen.has(nid)) continue;
      seen.add(nid);
      const spec = graph[nid] || {};
      const cls = String(spec.class_type || "");
      if (UPSCALE_TYPES.includes(cls)) order.push(nid);
      if (CAST_TYPES.includes(cls)) continue;
      for (const v of inputLinks(spec)) nxt.push(String(v[0]));
    }
    frontier = nxt;
  }
  return order;
}

/* 从合并节点向上 BFS，近先收集 RelayVSR 节点（视频口超分三采）。碰导演台即停。 */
function relayvsrNearestFirst(graph, mergeId, maxHops = 24) {
  const me = String(mergeId);
  const seen = new Set([me]);
  let frontier = inputLinks(graph[me]).map((v) => String(v[0]));
  const order = [];
  for (let hop = 0; hop < maxHops && frontier.length; hop++) {
    const nxt = [];
    for (const nid of frontier) {
      if (seen.has(nid)) continue;
      seen.add(nid);
      const spec = graph[nid] || {};
      const cls = String(spec.class_type || "");
      if (isRelayVSRClass(cls)) order.push(nid);
      if (CAST_TYPES.includes(cls)) continue;
      for (const v of inputLinks(spec)) nxt.push(String(v[0]));
    }
    frontier = nxt;
  }
  return order;
}

/* 改接线（P2b 潜空间链 / P3 视频链）：上游阶段不在本次范围时，把跨采活线切到读档口。
 *
 * 为什么切在「下游节点的跨采输入」：只裁输出节点时，ComfyUI 反闭包仍会顺着高采→
 * 低采把整条上游拉起来重跑。把下游的跨采输入从「低采活输出」改接到「导演台·本段
 * 低采读档口」，反闭包到导演台为止，低采不再被拉起。
 *
 * 两条链按拓扑分流（互斥，一个合并节点只走其中一条）：
 *   · 潜空间链（终极放大）：找最近的放大节点，其输入阶段在范围外→切「潜空间」口到
 *     READ_PORT[阶段]（9/10），切一处即断上游。
 *   · 视频链（RelayVSR 视频口超分）：找最近的 RelayVSR，其「视频」输入来源阶段在
 *     范围外→切「视频」口到 READ_PORT_VIDEO[阶段]（11），切一处即断上游。
 * 输入阶段在范围内则保留活线、继续往上找边界。全程在克隆图上改，不动调用方原图。 */
function rewireCrossStage(output, targets, stageMap, castId) {
  const g = {};
  for (const [k, spec] of Object.entries(output || {})) {
    g[k] = { ...(spec || {}), inputs: { ...((spec || {}).inputs || {}) } };
  }
  const rewired = [];
  if (!castId) return { output: g, rewired };
  const inScope = new Set(targets);
  const cut = new Set();
  for (const s of targets) {
    for (const m of stageMap[s] || []) {
      if (s3ModeOf(g, m) === "video") {
        /* 视频口超分链：按「二采本轮跑不跑」决定 RelayVSR「视频」口接活线还是读档口。
           二采在范围 → 接二采合并实时 VIDEO 口（一采→二采→三采 硬依赖，全程不会
           出现三采抢在二采出片前读空档）；二采不在范围 → 接本段二采视频读档口 11。
           画布无论接的是活线还是读档口，这里都归一到本轮该有的接法。 */
        for (const r of relayvsrNearestFirst(g, m)) {
          if (cut.has(r)) break;
          const vin = (g[r].inputs || {})[RELAYVSR_VIDEO_INPUT];
          if (!Array.isArray(vin) || vin.length !== 2) continue;  // 没接视频口，找下一个
          const srcId = String(vin[0]);
          const srcPort = Number(vin[1]);
          const isS2Archive = srcId === String(castId) && srcPort === READ_PORT_VIDEO.s2;
          if (inScope.has("s2")) {
            // 二采本轮要跑 → 必须吃实时出片。已是活线就保留；是读档口就改接活线。
            if (isS2Archive) {
              const liveMerge = (stageMap.s2 || [])[0];
              if (liveMerge === undefined) break;               // 图里没有二采合并，不猜
              g[r].inputs[RELAYVSR_VIDEO_INPUT] = [liveMerge, MERGE_VIDEO_OUTPUT];
              cut.add(r);
              rewired.push({ node: r, from: "s2", port: "live" });
            }
            break;                                              // 活线保留 / 已改接，都到此为止
          }
          // 二采不在范围 → 三采独立读档。已是读档口就保留；是活线就切读档口。
          if (isS2Archive) break;                               // 已接读档口，正确
          const srcStage = stageOfOutput(g, srcId);             // 视频来源属哪采
          const port = READ_PORT_VIDEO[srcStage];
          if (port === undefined) break;                        // 无对应读档口，不猜
          g[r].inputs[RELAYVSR_VIDEO_INPUT] = [castId, port];
          cut.add(r);
          rewired.push({ node: r, from: srcStage, port });
          break;
        }
      } else {
        /* 潜空间放大链：切放大的「潜空间」输入到本段低采潜空间读档口。 */
        for (const u of upscalesNearestFirst(g, m)) {
          if (cut.has(u)) break;                 // 上游已被切过，断了，停
          const inputStage = decodeStage(g, u);  // 进入本放大的 latent 属哪采
          if (inScope.has(inputStage)) continue; // 上游在范围，活线保留，继续往上
          const port = READ_PORT[inputStage];
          if (port === undefined) break;         // 无对应读档口，不猜，停
          g[u].inputs[UPSCALE_LATENT_INPUT] = [castId, port];
          cut.add(u);
          rewired.push({ node: u, from: inputStage, port });
          break;                                 // 切一处即断上游
        }
      }
    }
  }
  return { output: g, rewired };
}

/* 计算一次提交的执行范围：①选输出（partialExecutionTargets）②改接线。
 * s3Mode（P3）：三采方式钮，video=视频口超分 / latent=潜空间放大，默认 video。
 *   按它筛三采出口；钮与画布拓扑对不上（选的方式图里没有）时按画布实际有的那条
 *   安全兜底（s3Fallback=true，调用方告警），绝不静默裁成空集、绝不拦运行。
 * 返回 { output, partialExecutionTargets, targets, stageMap, castId, selected,
 *        rewired, s3Mode, s3Fallback }。
 * partialExecutionTargets=null 表示不裁（整图跑）：全程且方式钮没丢弃任何子图，
 *   或目标阶段在图里没有对应输出节点（无从裁起）。 */
export function applyStageScope(output, mode, currentStage, s3Mode) {
  const { stageMap, castId } = identifyStageOutputs(output);
  const wantS3 = s3Mode === "latent" ? "latent" : "video";
  const s3All = stageMap.s3 || [];
  const s3Matched = s3All.filter((id) => s3ModeOf(output, id) === wantS3);
  const s3Fallback = s3All.length > 0 && s3Matched.length === 0;
  const effMap = { ...stageMap, s3: s3Matched.length ? s3Matched : s3All };
  const targets = targetStages(mode, currentStage);
  const selected = [];
  for (const s of targets) {
    for (const id of effMap[s] || []) {
      if (!selected.includes(id)) selected.push(id);
    }
  }
  const totalMerges = (stageMap.s1 || []).length + (stageMap.s2 || []).length + s3All.length;
  /* 全程且 selected 覆盖全图所有合并节点（方式钮没丢弃任何子图）＝整图跑，不裁。
     全程但方式钮在两条三采子图里只选了一条 → selected 少于总数 → 仍要裁掉另一条。 */
  const noPrune = !selected.length || (mode === "all" && selected.length === totalMerges);
  /* 全程也要改接：三采若接的是二采读档口，全程时二采会重跑，必须改接实时出片口
     才能保证 一采→二采→三采 的先后（否则三采抢跑读空档）。所以 noPrune 不再原样
     返回，仍走 rewireCrossStage —— 此时 inScope 含全部阶段，潜空间活线全保留，
     只有「三采读档口→二采实时口」这一处可能改。partialExecutionTargets 仍 null＝不裁。 */
  const { output: rewiredOutput, rewired } = rewireCrossStage(output, targets, effMap, castId);
  if (noPrune) {
    return {
      output: rewiredOutput, partialExecutionTargets: null, targets, stageMap: effMap, castId,
      selected: [], rewired, s3Mode: wantS3, s3Fallback,
    };
  }
  return {
    output: rewiredOutput, partialExecutionTargets: selected, targets, stageMap: effMap, castId,
    selected, rewired, s3Mode: wantS3, s3Fallback,
  };
}