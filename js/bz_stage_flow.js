/* 拓扑镜像渲染：所有阶段单行排列，分叉/汇合用绕行弧线，画布组 DAG 的 SVG 投影。
   状态持久化在导演台 properties，无组时回退。 */
import { detectStages } from "./bz_group_detect.js";
import { nodeList } from "./bz_group_utils.js";

const NW = 140, NH = 58, GAPX = 38, PADX = 16, TOP = 10;
const LANE_DY = 16, BEND = 12;
const SVG_NS = "http://www.w3.org/2000/svg";

function el(tag, attrs = {}) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
}
function readState(host) { return host.properties?.bzStageFlow || { sel: null, toggles: {} }; }
function writeState(host, state) {
  if (!host.properties) host.properties = {};
  host.properties.bzStageFlow = state;
}
function isEnabled(state, id) { return state.toggles[id] !== false; }

/* B1：管道口自动标记。组模式下口 7–13 的显示 label 加「·自动」，
   提示这些口提交期按拓扑开关自动接线、无需手接；回退模式恢复原名
   （旧图的读档口本就靠手接，不能误标）。只改 .label 显示层，
   .name 与端口序号一律不动，接线与逻辑零影响。 */
const AUTO_PORT_NAMES = ["整片潜空间", "整片", "本段一采潜空间", "本段二采潜空间", "本段二采视频", "下游潜空间", "下游视频"];
function paintAutoPorts(host, mode) {
  const outs = host.outputs || [];
  AUTO_PORT_NAMES.forEach((base, k) => {
    const o = outs[7 + k];
    /* 20261118 口 7–13 已前端隐藏（csglide_cast.js pinCastPortLabels），
       隐藏的口不再钉「·自动」标签，避免把隐藏口重新显示出来。 */
    if (o && !o.hidden) o.label = mode === "group" ? base + "·自动" : base;
  });
}

/* mute 联动：off = 整组成员静音（ComfyUI 原生 mode=2，画布灰显且不进提交），
   on = 恢复被我们静音前的原 mode。原 mode 双写进 properties.bzMuteOrig，
   刷新后 render 再收敛一遍即状态同步。只动阶段组成员，导演台/组外节点不碰；
   用户手动静音的节点（无 orig 记录）开组时不擅自解除。 */
function syncMute(host, detected) {
  const { graph } = host.bzStageIO;
  const state = readState(host);
  if (!host.properties) host.properties = {};
  const orig = host.properties.bzMuteOrig || (host.properties.bzMuteOrig = {});
  const byId = {};
  nodeList(graph).forEach((n) => { byId[n.id] = n; });
  let changed = false;
  detected.stages.forEach((s) => {
    const on = isEnabled(state, s.id);
    s.members.forEach((id) => {
      const n = byId[id];
      if (!n) return;
      if (!on) {
        if (n.mode !== 2) {
          if (orig[id] == null) orig[id] = n.mode || 0;
          n.mode = 2;
          changed = true;
        }
      } else if (orig[id] != null) {
        n.mode = orig[id];
        delete orig[id];
        changed = true;
      }
    });
  });
  if (changed) graph.canvas?.setDirtyCanvas?.(true, true);
}

/* 阶段 → 档案档位：latent 按它是第几个 latent 阶段认 sN，档案只有三档，
   三采以上并入 s3；video 阶段的产物登记在 s3 成片。与后端读档口同一套 s1/s2/s3。 */
export function stageArchiveSlot(stage, stages) {
  if (stage.kind === "video") return "s3";
  const li = stages.filter((s) => s.kind === "latent").indexOf(stage);
  return "s" + Math.min(Math.max(li + 1, 1), 3);
}

/* 状态灯只认两个真事实：正在执行的节点落在本组 = 运行中；
   对应档位档案在盘（后端 summary.stage_files，与读档口同口径）= 已缓存。
   不猜 ComfyUI 节点缓存 —— 前端拿不到可靠信号，猜了就是假灯。 */
function stageStatus(stage, stages, host) {
  const runId = host.bzRunningNodeId;
  if (runId != null && stage.members.some((m) => String(m) === String(runId))) return "running";
  const slot = (host.bzStageFiles || {})[stageArchiveSlot(stage, stages)];
  const has = slot && (stage.kind === "video" ? slot.film : slot.latent);
  return has ? "cached" : "ready";
}
const STATUS_TEXT = { running: "运行中", cached: "已缓存 · 有档可读", ready: "待运行 · 尚无存档" };

/* 显示名直接用画布组标题，忠实于用户命名且不重名 */
function nameOf(stage) { return stage.title; }
function fromText(stage, stages) {
  if (!stage.from.length) return "流程起点";
  const names = stage.from.map((f) => {
    const up = stages.find((s) => s.id === f);
    return up ? up.title : "";
  }).filter(Boolean);
  return "来自 " + names.join("、");
}

/* 两个列区间是否重叠（共享中间列就不能走同一绕行轨道） */
function conflict(a, b) { return !(a[1] <= b[0] || b[1] <= a[0]); }
function pickLane(lanes, span) {
  for (let i = 0; i < lanes.length; i += 1) {
    if (!lanes[i].some((s) => conflict(s, span))) return i;
  }
  return -1;
}

/* level：from 最长路径，同 level 多节点即并列分叉 */
function stageLevels(stages) {
  const lv = {};
  stages.forEach((s) => { lv[s.id] = 0; });
  for (let p = 0; p < stages.length; p += 1) {
    stages.forEach((s) => {
      if (s.from.length) {
        lv[s.id] = Math.max(lv[s.id], ...s.from.map((f) => (lv[f] || 0) + 1));
      }
    });
  }
  return lv;
}

/* 单行布局：同 level 节点紧凑相邻，level 累计 x；跨列边分配上/下绕行轨道，
   同一上游的分叉在出口形成 Y 型，明确并列而非串联 */
function layout(stages) {
  const lv = stageLevels(stages);
  const byLv = {};
  stages.forEach((s) => { (byLv[lv[s.id]] = byLv[lv[s.id]] || []).push(s); });
  const pos = {};
  let cursor = PADX;
  let maxRight = PADX;
  for (const L of Object.keys(byLv).sort((a, b) => a - b)) {
    const arr = byLv[L];
    arr.forEach((g, i) => { pos[g.id] = { x: cursor + i * (NW + GAPX) }; });
    maxRight = cursor + arr.length * NW + (arr.length - 1) * GAPX;
    cursor += arr.length * NW + (arr.length - 1) * GAPX + GAPX;
  }
  const xOrder = stages.slice().sort((a, b) => pos[a.id].x - pos[b.id].x);
  const xIndex = {};
  xOrder.forEach((s, i) => { xIndex[s.id] = i; });

  const lanes = { up: [], down: [] };
  const edges = [];
  stages.forEach((s) => s.from.forEach((f, k) => {
    if (xIndex[f] == null) return;
    const fi = xIndex[f], ti = xIndex[s.id];
    const base = { from: f, to: s.id, type: s.edgeTypes?.[k] || "",
      isVideo: s.kind === "video", inferred: !!s.edgeInferred?.[k] };
    if (ti === fi + 1) { edges.push({ ...base, laneY: null }); return; }
    const span = [fi, ti];
    let dir = "down", laneNo = pickLane(lanes.down, span);
    if (laneNo < 0) { dir = "up"; laneNo = pickLane(lanes.up, span); }
    if (laneNo < 0) {
      if (dir === "down") { laneNo = lanes.down.length; lanes.down.push([]); }
      else { laneNo = lanes.up.length; lanes.up.push([]); }
    }
    lanes[dir][laneNo].push(span);
    edges.push({ ...base, dir, lane: laneNo });
  }));

  /* 绕行轨道必须避开节点卡行：上轨贴卡顶上方、下轨贴卡底下方，
     否则水平段落在卡片矩形里被盖住（卡片后于边绘制） */
  const topPad = TOP + lanes.up.length * LANE_DY;
  const cy = topPad + NH / 2;
  edges.forEach((e) => {
    if (e.laneY === null) { e.laneY = cy; return; }
    e.laneY = e.dir === "up"
      ? topPad - 8 - LANE_DY * e.lane
      : topPad + NH + 8 + LANE_DY * e.lane;
  });
  Object.keys(pos).forEach((id) => { pos[id].y = topPad; });
  const width = maxRight + PADX;
  const height = topPad + NH + 6 + lanes.down.length * LANE_DY;
  return { pos, edges, width, height, cy };
}

function edgeD(e, pos, cy) {
  const a = pos[e.from], b = pos[e.to];
  const x1 = a.x + NW, x2 = b.x;
  /* 两端各伸进卡片 1px：卡片后绘制会盖住伸入段，视觉上线贴着卡边，不留断口 */
  if (e.laneY === null || e.laneY === cy) {
    /* 直线标签放线下方：分叉绕行只往上走，上方会压到上升曲线 */
    return { d: `M${x1 - 1},${e.laneY} L${x2 + 1},${e.laneY}`, labelY: e.laneY + 11 };
  }
  const y = e.laneY;
  return { d: `M${x1 - 1},${cy} C${x1 + BEND},${cy} ${x1 + BEND},${y} ${x1 + 2 * BEND},${y}
    L${x2 - 2 * BEND},${y} C${x2 - BEND},${y} ${x2 - BEND},${cy} ${x2 + 1},${cy}`,
    labelY: y - 5 };
}

function drawEdges(svg, stages, lay) {
  lay.edges.forEach((e) => {
    const info = edgeD(e, lay.pos, lay.cy);
    const path = el("path", { class: `edge ${e.isVideo ? "video" : ""}${e.inferred ? " inferred" : ""}`, d: info.d });
    if (e.inferred) {
      const tip = el("title");
      tip.textContent = `${e.isVideo ? "VIDEO" : "LATENT"} · 无真实连线，按标题序号推断`;
      path.appendChild(tip);
    }
    svg.appendChild(path);
    const mx = (lay.pos[e.from].x + NW + lay.pos[e.to].x) / 2;
    const t = el("text", { class: `elabel ${e.isVideo ? "video" : ""}${e.inferred ? " inferred" : ""}`, x: mx, y: info.labelY });
    t.textContent = e.inferred ? "推断" : (e.isVideo ? "VIDEO" : "LATENT");
    svg.appendChild(t);
    t.setAttribute("x", mx - t.getBBox().width / 2);
  });
}

function drawNodes(svg, stages, pos, state, host, onChange) {
  stages.forEach((s) => {
    const p = pos[s.id], on = isEnabled(state, s.id);
    const status = stageStatus(s, stages, host);
    const g = el("g", { class: `tnode${on ? "" : " off"}${state.sel === s.id ? " sel" : ""}` });
    const tip = el("title");
    tip.textContent = `${s.title} · ${STATUS_TEXT[status]}\n`
      + "点节点＝时间轴切到对应档案；右上开关＝阶段启停（关闭时整组节点在画布静音灰显、本次不跑）";
    g.appendChild(tip);
    g.appendChild(el("rect", { class: `node-rect ${s.kind}`, x: p.x, y: p.y, width: NW, height: NH, rx: 10 }));
    g.appendChild(el("circle", { class: `stat-dot ${status}`, cx: p.x + 12, cy: p.y + 13, r: 4 }));
    const name = el("text", { class: "tname", x: p.x + 22, y: p.y + 17 });
    name.textContent = nameOf(s);
    g.appendChild(name);
    const kind = el("text", { class: "tkind", x: p.x + 12, y: p.y + 32 });
    kind.textContent = s.kind === "video" ? "视频域超分" : "潜空间重采样";
    g.appendChild(kind);
    const from = el("text", { class: "tfrom", x: p.x + 12, y: p.y + 46 });
    from.textContent = fromText(s, stages);
    g.appendChild(from);
    g.appendChild(el("rect", { class: `sw ${on ? "on" : ""}`, "data-sw": s.id,
      x: p.x + NW - 36, y: p.y + 7, width: 28, height: 14, rx: 7 }));
    g.appendChild(el("circle", { class: `sw-knob ${on ? "on" : ""}`, "data-sw": s.id,
      cx: p.x + NW - (on ? 15 : 29), cy: p.y + 14, r: 5 }));
    g.onclick = (ev) => {
      if (ev.target.dataset.sw) {
        if (!s.from.length) { host.bzOnBlockedToggle?.(s); return; } /* 起点阶段不可关 */
        state.toggles[s.id] = on ? false : true;
        writeState(host, state); render(host, onChange);
        return;
      }
      state.sel = s.id; writeState(host, state);
      host.bzOnSelect?.(s);
      render(host, onChange);
    };
    svg.appendChild(g);
  });
}

function render(host, onChange) {
  const { container, graph } = host.bzStageIO;
  const svgBox = container.querySelector(".topo");
  if (svgBox) svgBox.innerHTML = "";
  const detected = detectStages(graph);
  paintAutoPorts(host, detected.mode);
  if (detected.mode === "fallback") {
    container.dataset.mode = "fallback";
    host.bzStageDetected = null;
    if (onChange) onChange(null);
    return false;
  }
  container.dataset.mode = "group";
  const state = readState(host);
  const lay = layout(detected.stages);
  let svg = svgBox;
  if (!svg) {
    svg = el("svg", { class: "topo" });
    container.querySelector(".topo-wrap").appendChild(svg);
  }
  svg.setAttribute("viewBox", `0 0 ${lay.width} ${lay.height}`);
  svg.setAttribute("width", lay.width);
  svg.setAttribute("height", lay.height);
  drawEdges(svg, detected.stages, lay);
  drawNodes(svg, detected.stages, lay.pos, state, host, onChange);
  host.bzStageDetected = detected;
  syncMute(host, detected);
  if (onChange) onChange(detected);
  return true;
}

export function installStageFlow({ graph, container, node, onChange, onSelect, onBlockedToggle }) {
  node.bzStageIO = { graph, container };
  node.bzOnSelect = onSelect;
  node.bzOnBlockedToggle = onBlockedToggle;
  const ok = render(node, onChange);
  return { ok, repaint: () => render(node, onChange) };
}

export function enabledStages(node) {
  const detected = node.bzStageDetected;
  if (!detected) return [];
  const state = readState(node);
  return detected.stages.filter((s) => isEnabled(state, s.id));
}
