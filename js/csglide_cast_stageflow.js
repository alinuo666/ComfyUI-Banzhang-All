/* 阶段拓扑分区：拓扑镜像挂进导演台面板，提交时把阶段状态写进 h3_data。
   结构对齐原型：topo-head（标题+状态 pill）+ 提示行 + topo-wrap（SVG 滚动盒）
   + 主运行按钮（文案随开关动态变化，关闭阶段直接旁路提交，无弹窗——
   2026-11-18 用户拍板删除跳过确认）。
   graph 钩子全模块只链一套，实例注册/注销 —— 节点删除不再留死钩子。 */
import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { el } from "./csglide_ui_kit.js";
import { installStageFlow, enabledStages, stageArchiveSlot } from "./bz_stage_flow.js";

const instances = new Set();
let graphHooked = false;
function hookGraph() {
  if (graphHooked) return;
  graphHooked = true;
  const graph = app.graph;
  const chain = (name) => {
    const old = graph[name];
    graph[name] = (...args) => {
      if (typeof old === "function") old.apply(graph, args);
      instances.forEach((inst) => inst.schedule());
    };
  };
  chain("onNodeAdded");
  chain("onNodeRemoved");
  chain("onConnectionChange");
}

export function installStageFlowUI(ui) {
  const wrap = el("div", "bzf-stage-wrap");
  ui.stageFlowWrap = wrap;

  const head = el("div", "topo-head");
  const title = el("span", "", "阶段拓扑 · 画布组连接状态实时镜像");
  const pill = el("span", "pill");
  head.append(title, pill);
  const note = el("div", "topo-note");
  note.style.display = "none";
  const topoWrap = el("div", "topo-wrap");
  /* B1：管道口灰字说明，仅组模式显示（回退模式读档口靠手接，不显示） */
  const autoNote = el("div", "topo-auto-note",
    "阶段自动接线；多个视频阶段共用三采档，优先收取选中阶段，否则收取最后启用的阶段。");

  /* 主运行按钮：范围完全由拓扑开关表达，替代已注销的遥控节点 */
  const actions = el("div", "bzf-actions");
  const btnRun = el("button", "bzf-run", "▶ 全程运行");
  btnRun.type = "button";
  actions.append(btnRun);
  wrap.append(head, note, topoWrap, autoNote, actions);

  let running = false, submitting = false, switching = false, pollTimer = 0, destroyed = false, currentPromptId = "";
  const prompts = new Set();
  const finished = new Set();
  ui.node.bzStageBusy = () => submitting || switching || prompts.size > 0 || !!ui.run || !!ui._bzRunPreparing || !!ui._bzDeliveryPreparing;
  // 已入队的单次任务不占用提交按钮；阶段切换与批跑仍用完整 busy 保护。
  const submissionBusy = () => submitting || switching || !!ui.run || !!ui._bzRunPreparing || !!ui._bzDeliveryPreparing;
  function paintPill(detected) {
    if (!detected) {
      pill.className = "pill fb";
      pill.textContent = "拓扑回退识别中";
      pill.title = "未检测到阶段组，按旧拓扑推断运行";
      note.style.display = "none";
      return;
    }
    const problems = [...(detected.errors || []), ...(detected.warnings || [])];
    pill.className = "pill" + (problems.length ? " warn" : "");
    pill.textContent = "已识别 " + detected.stages.length + " 个阶段"
      + (problems.length ? " · " + problems.length + " 条提示" : "");
    pill.title = problems.join("\n");
    note.style.display = problems.length ? "" : "none";
    note.textContent = problems[0] || "";
    note.title = problems.join("\n");
  }

  function paintRunBtn() {
    const detected = ui.node.bzStageDetected;
    if (!detected || detected.mode !== "group") { actions.style.display = "none"; return; }
    actions.style.display = "";
    btnRun.disabled = submissionBusy() || !!detected.errors?.length;
    if (switching) { btnRun.textContent = "⏳ 切换阶段…"; return; }
    if (submitting) { btnRun.textContent = "⏳ 正在提交…"; return; }
    if (ui.run || ui._bzRunPreparing) { btnRun.textContent = "⏳ 正在运行全部分段"; return; }
    const on = enabledStages(ui.node);
    if (!on.length) { btnRun.disabled = true; btnRun.textContent = "请先启用阶段"; return; }
    const first = on[0].title, last = on[on.length - 1].title;
    const action = prompts.size ? "继续排队" : "运行当前段";
    if (on.length === detected.stages.length) {
      btnRun.textContent = "▶ " + action + "（全部阶段）";
      btnRun.title = "全部阶段启用：按画布组拓扑整图运行";
    } else if (on.length === 1) {
      btnRun.textContent = "▶ " + action + "（" + first + "）";
      btnRun.title = "其余阶段旁路，上游改读导演台总线口存档";
    } else {
      btnRun.textContent = "▶ " + action + "（" + on.map((s) => s.title).join("、") + "）";
      btnRun.title = "关闭的阶段旁路，上游改读导演台总线口存档";
    }
    if (prompts.size) btnRun.title = `已有 ${prompts.size} 项任务未结束；按当前提示词和素材再加入一项。` + btnRun.title;
  }

  const flow = installStageFlow({
    graph: app.graph, container: wrap, node: ui.node,
    onChange: (detected) => { paintPill(detected); paintRunBtn(); },
    onSelect: (stage, previous) => {
      /* 选中＝时间轴切档：走 monitor 的 setStage 唯一写入口，
         后端 chain.stage 与拓扑从此同一份真值，不再双轨 */
      const stages = (ui.node.bzStageDetected && ui.node.bzStageDetected.stages) || [];
      if (typeof ui.setStage !== "function") return;
      switching = true;
      const pending = Promise.resolve(ui.setStage(stageArchiveSlot(stage, stages)))
        .then((ok) => {
          if (!ok && ui.node.properties?.bzStageFlow?.sel === stage.id) {
            ui.node.properties.bzStageFlow.sel = previous;
            flow.repaint();
          }
          return !!ok;
        }).catch(() => false).finally(() => {
          switching = false;
          if (ui.stageFlowStagePromise === pending) ui.stageFlowStagePromise = null;
          if (!destroyed) repaintControls();
        });
      ui.stageFlowStagePromise = pending;
      repaintControls();
    },
    onBlockedToggle: (stage, reason) => {
      ui.lanesFlash?.(reason === "busy" ? "运行或切换阶段中，请稍候"
        : reason === "group" ? "此组包含导演台、组内无节点或与其他媒体组重叠，请检查组框范围"
        : "至少保留一个启用的阶段");
    },
  });
  ui.node.bzOnGroupToggle = () => { ui.commit(); ui.node.setDirtyCanvas?.(true, true); };
  paintPill(flow.ok ? ui.node.bzStageDetected : null);
  paintRunBtn();
  ui.stageFlowRepaint = flow.repaint;

  /* 状态灯数据：summary.stage_files 与后端读档口同口径。
     拉取时机＝安装/载入/运行结束/切工程，不做轮询。 */
  async function refreshFiles() {
    const p = ui.proj ? ui.proj() : null;
    const name = (p && p.name) || (ui.st && ui.st.chain && ui.st.chain.name) || "";
    if (!name) { ui.node.bzStageFiles = {}; return; }
    try {
      const res = await api.fetchApi("/cglide/chain/summary?name=" + encodeURIComponent(name));
      const d = await res.json().catch(() => ({}));
      ui.node.bzStageFiles = (res.ok && !d.error && d.stage_files) || {};
    } catch (e) { ui.node.bzStageFiles = {}; }
    flow.repaint();
  }
  ui.stageFlowRefresh = refreshFiles;

  function collectStageFlow() {
    const result = ui.node.bzStageDetected;
    if (!result) return null;
    const enabled = enabledStages(ui.node);
    const onIds = new Set(enabled.map((s) => s.id));
    const videos = enabled.filter((s) => s.kind === "video");
    const selected = ui.node.properties?.bzStageFlow?.sel;
    const archive = videos.find((s) => s.id === selected) || videos[videos.length - 1];
    return { stages: result.stages.map((s) => ({
      kind: s.kind, enabled: onIds.has(s.id),
      members: s.members || [], archive: !!archive && s.id === archive.id,
    })) };
  }
  ui.collectStageFlow = collectStageFlow;
  ui.stageFlowSignature = () => {
    const result = ui.node.bzStageDetected;
    if (!result) return JSON.stringify({ mode: "fallback", postGroups: ui.node.bzPostGroups || [],
      toggles: ui.node.properties?.bzStageFlow?.toggles || {} });
    return JSON.stringify({
      stages: result.stages.map((s) => {
        const members = s.members.slice().sort((a, b) => String(a).localeCompare(String(b)));
        const inEdges = (s.inEdges || []).slice().sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
        return { id: s.id, kind: s.kind, from: s.from.slice().sort(), members, inEdges,
          modes: members.map((id) => app.graph.getNodeById?.(id)?.mode ?? 0) };
      }),
      enabled: enabledStages(ui.node).map((s) => s.id),
      postGroups: (ui.node.bzPostGroups || []).map((g) => ({ id: g.id, members: g.members,
        edges: g.edges, outEdges: g.outEdges, enabled: ui.node.properties?.bzStageFlow?.toggles?.[g.id] !== false })),
      selected: ui.node.properties?.bzStageFlow?.sel ?? null,
    });
  };

  const prevCommit = ui.commit;
  ui.commit = () => {
    ui.st.stage_flow = collectStageFlow();
    prevCommit();
  };

  btnRun.onclick = async (e) => {
    e.stopPropagation();
    if (submissionBusy() || !ui.node.bzStageDetected || ui.node.bzStageDetected.errors?.length) return;
    if (app.processingQueue) { ui.lanesFlash?.("画布正在准备上一项提交，请稍后再运行"); return; }
    submitting = true;
    try {
      paintRunBtn(); ui.paintRenderRow?.();
      await app.queuePrompt(0);
    } catch (err) {
      ui.lanesFlash?.("提交失败：" + (err && err.message ? err.message : err));
    } finally { submitting = false; paintRunBtn(); ui.paintRenderRow?.(); }
  };

  function repaintControls() { paintRunBtn(); ui.paintRenderRow?.(); }
  ui.stageFlowUpdateControls = repaintControls;
  function pollPrompts() {
    if (destroyed || !prompts.size || pollTimer) return;
    pollTimer = setTimeout(async () => {
      pollTimer = 0;
      let completed = false;
      for (const id of [...prompts]) {
        try {
          const res = await api.fetchApi("/history/" + encodeURIComponent(id));
          const history = res.ok ? await res.json() : null;
          if (destroyed) return;
          if (history && history[id]) { prompts.delete(id); completed = true; }
        } catch (_) { /* 网络暂不可用，下一次继续 */ }
      }
      if (prompts.size) {
        try {
          const res = await api.fetchApi("/queue");
          const queue = res.ok ? await res.json() : null;
          if (destroyed) return;
          if (Array.isArray(queue?.queue_running) && Array.isArray(queue?.queue_pending)) {
            const present = new Set([...queue.queue_running, ...queue.queue_pending]
              .filter(Array.isArray).map((item) => String(item[1])));
            for (const id of [...prompts]) {
              if (!present.has(id)) { prompts.delete(id); completed = true; }
            }
          }
        } catch (_) { /* 队列不可用时不猜任务状态 */ }
      }
      running = prompts.has(currentPromptId);
      if (completed) { ui.node.bzRunningNodeId = null; void refreshFiles(); }
      repaintControls();
      pollPrompts();
    }, 2000);
  }
  ui.stageFlowQueued = (id) => {
    id = String(id);
    if (finished.delete(id)) { void refreshFiles(); return; }
    prompts.add(id); running = id === currentPromptId;
    pollPrompts(); repaintControls();
  };
  ui.stageFlowForget = (id) => {
    prompts.delete(String(id));
    running = prompts.has(currentPromptId);
    if (!running) ui.node.bzRunningNodeId = null;
    repaintControls();
  };

  /* 运行事件：executing 给正在跑的节点号（状态灯），结束事件拉一次档案状态 */
  let timer = 0;
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      try { flow.repaint(); } catch (e) { console.warn(e); }
    }, 0);
  };
  const onExecuting = ({ detail }) => {
    const id = !running || detail == null ? null : String(detail);
    if (id === ui.node.bzRunningNodeId) return;
    ui.node.bzRunningNodeId = id;
    schedule();
  };
  const onRunStart = ({ detail }) => {
    currentPromptId = String(detail?.prompt_id || "");
    running = prompts.has(currentPromptId); repaintControls();
  };
  const onRunEnd = ({ detail }) => {
    const id = String(detail?.prompt_id || "");
    if (currentPromptId === id) currentPromptId = "";
    if (!prompts.has(id)) {
      if (id) { finished.add(id); if (finished.size > 100) finished.delete(finished.values().next().value); }
      running = prompts.has(currentPromptId); repaintControls(); return;
    }
    prompts.delete(id);
    running = prompts.has(currentPromptId);
    ui.node.bzRunningNodeId = null;
    repaintControls();
    void refreshFiles();
  };
  api.addEventListener("executing", onExecuting);
  api.addEventListener("execution_start", onRunStart);
  api.addEventListener("execution_success", onRunEnd);
  api.addEventListener("execution_error", onRunEnd);
  api.addEventListener("execution_interrupted", onRunEnd);

  const inst = { schedule };
  instances.add(inst);
  hookGraph();
  /* 组的创建、改名、移动与缩放不一定触发节点/连线回调。只在几何或标题变化时重绘。 */
  const groupSnapshot = () => JSON.stringify([
    (app.graph?._groups || app.graph?.groups || []).map((g) =>
      [g.id, g.title || g._title, Array.from(g._bounding || g.bounding || []),
        Array.from(g.pos || []), Array.from(g.size || [])]),
    (app.graph?._nodes || app.graph?.nodes || []).map((n) =>
      [n.id, Array.from(n.pos || []), Array.from(n.size || [])]),
  ]);
  let lastGroups = groupSnapshot();
  const groupTimer = setInterval(() => {
    const now = groupSnapshot();
    if (now !== lastGroups) { lastGroups = now; schedule(); }
  }, 1000);

  const oldConfigure = ui.node.onConfigure;
  ui.node.onConfigure = function (...args) {
    if (typeof oldConfigure === "function") oldConfigure.apply(this, args);
    schedule();
    void refreshFiles();
  };

  ui.stageFlowDestroy = () => {
    destroyed = true;
    clearTimeout(pollTimer);
    clearInterval(groupTimer);
    delete ui.node.bzStageBusy;
    delete ui.node.bzOnGroupToggle;
    instances.delete(inst);
    clearTimeout(timer);
    api.removeEventListener("executing", onExecuting);
    api.removeEventListener("execution_start", onRunStart);
    api.removeEventListener("execution_success", onRunEnd);
    api.removeEventListener("execution_error", onRunEnd);
    api.removeEventListener("execution_interrupted", onRunEnd);
  };

  void refreshFiles();
}
