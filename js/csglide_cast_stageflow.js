/* 阶段拓扑分区：拓扑镜像挂进导演台面板，提交时把阶段状态写进 h3_data。
   结构对齐原型：topo-head（标题+状态 pill）+ 提示行 + topo-wrap（SVG 滚动盒）
   + 主运行按钮（文案随开关动态变化，关闭阶段先确认再提交）。
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

  /* 主运行按钮：范围完全由拓扑开关表达，替代已注销的遥控节点 */
  const actions = el("div", "bzf-actions");
  const btnRun = el("button", "bzf-run", "▶ 全程运行");
  btnRun.type = "button";
  actions.append(btnRun);

  /* 关闭阶段运行前确认（原型同款，罩在拓扑区上，不全屏打断） */
  const mask = el("div", "bzf-mask");
  const dlg = el("div", "bzf-dialog");
  const dTitle = el("h3", "", "确认跳过关闭阶段");
  const dText = el("p", "");
  const dRow = el("div", "bzf-d-actions");
  const dCancel = el("button", "bzf-d-cancel", "取消");
  const dOk = el("button", "bzf-d-ok", "继续运行");
  dCancel.type = dOk.type = "button";
  dRow.append(dCancel, dOk);
  dlg.append(dTitle, dText, dRow);
  mask.append(dlg);
  wrap.append(head, note, topoWrap, actions, mask);

  function confirmSkip(offStages) {
    return new Promise((resolve) => {
      dText.textContent = "「" + offStages.map((s) => s.title).join("、")
        + "」已关闭，本次运行将被旁路：下游直接读取最近上游的存档产物。确认继续？";
      mask.classList.add("open");
      const done = (v) => {
        mask.classList.remove("open");
        dCancel.onclick = dOk.onclick = null;
        resolve(v);
      };
      dCancel.onclick = () => done(false);
      dOk.onclick = () => done(true);
    });
  }

  let running = false;
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
    btnRun.disabled = running;
    if (running) { btnRun.textContent = "⏳ 运行中…"; return; }
    const on = enabledStages(ui.node);
    if (!on.length) { btnRun.textContent = "▶ 全程运行"; return; }
    const first = on[0].title, last = on[on.length - 1].title;
    if (on.length === detected.stages.length) {
      btnRun.textContent = "▶ 全程运行（" + first + " → " + last + "）";
      btnRun.title = "全部阶段启用：按画布组拓扑整图运行";
    } else if (on.length === 1) {
      btnRun.textContent = "▶ 只运行「" + first + "」";
      btnRun.title = "其余阶段旁路，上游改读导演台总线口存档";
    } else {
      btnRun.textContent = "▶ 从「" + first + "」运行到「" + last + "」";
      btnRun.title = "关闭的阶段旁路，上游改读导演台总线口存档";
    }
  }

  const flow = installStageFlow({
    graph: app.graph, container: wrap, node: ui.node,
    onChange: (detected) => { paintPill(detected); paintRunBtn(); },
    onSelect: (stage) => {
      /* 选中＝时间轴切档：走 monitor 的 setStage 唯一写入口，
         后端 chain.stage 与拓扑从此同一份真值，不再双轨 */
      const stages = (ui.node.bzStageDetected && ui.node.bzStageDetected.stages) || [];
      if (typeof ui.setStage === "function") void ui.setStage(stageArchiveSlot(stage, stages));
    },
    onBlockedToggle: (stage) => {
      ui.lanesFlash?.("「" + stage.title + "」是流程起点，不能关闭");
    },
  });
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
    if (!flow.ok || !result) return null;
    const onIds = new Set(enabledStages(ui.node).map((s) => s.id));
    return { stages: result.stages.map((s) => ({
      kind: s.kind, enabled: onIds.has(s.id),
    })) };
  }
  ui.collectStageFlow = collectStageFlow;

  const prevCommit = ui.commit;
  ui.commit = () => {
    ui.st.stage_flow = collectStageFlow();
    prevCommit();
  };

  btnRun.onclick = async (e) => {
    e.stopPropagation();
    if (running || !ui.node.bzStageDetected) return;
    const onIds = new Set(enabledStages(ui.node).map((s) => s.id));
    const off = ui.node.bzStageDetected.stages.filter((s) => !onIds.has(s.id));
    if (off.length && !(await confirmSkip(off))) return;
    try {
      await app.queuePrompt(0);
    } catch (err) {
      ui.lanesFlash?.("提交失败：" + (err && err.message ? err.message : err));
    }
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
    const id = detail == null ? null : String(detail);
    if (id === ui.node.bzRunningNodeId) return;
    ui.node.bzRunningNodeId = id;
    schedule();
  };
  const onRunStart = () => { running = true; paintRunBtn(); };
  const onRunEnd = () => {
    running = false;
    ui.node.bzRunningNodeId = null;
    paintRunBtn();
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

  const oldConfigure = ui.node.onConfigure;
  ui.node.onConfigure = function (...args) {
    if (typeof oldConfigure === "function") oldConfigure.apply(this, args);
    schedule();
    void refreshFiles();
  };

  ui.stageFlowDestroy = () => {
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