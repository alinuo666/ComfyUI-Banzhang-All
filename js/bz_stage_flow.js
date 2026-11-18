/* 拓扑镜像渲染：所有阶段单行排列，分叉/汇合用绕行弧线，画布组 DAG 的 SVG 投影。
   状态持久化在导演台 properties，无组时回退。 */
import { detectStages } from "./bz_group_detect.js";

const NW = 148, NH = 62, GAPX = 42, PADX = 20, TOP = 16;
const LANE_DY = 30, BEND = 18;
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
      isVideo: s.kind === "video" };
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

  const topPad = TOP + lanes.up.length * LANE_DY;
  const cy = topPad + NH / 2;
  edges.forEach((e) => {
    if (e.laneY === null) { e.laneY = cy; return; }
    e.laneY = e.dir === "up"
      ? cy - LANE_DY * (e.lane + 1)
      : cy + LANE_DY * (e.lane + 1);
  });
  Object.keys(pos).forEach((id) => { pos[id].y = topPad; });
  const width = maxRight + PADX;
  const height = topPad + NH + lanes.down.length * LANE_DY + TOP;
  return { pos, edges, width, height, cy };
}

function edgeD(e, pos, cy) {
  const a = pos[e.from], b = pos[e.to];
  const x1 = a.x + NW, x2 = b.x;
  if (e.laneY === null || e.laneY === cy) {
    return { d: `M${x1},${e.laneY} L${x2 - 4},${e.laneY}`, labelY: e.laneY - 5 };
  }
  const y = e.laneY;
  return { d: `M${x1},${cy} C${x1 + BEND},${cy} ${x1 + BEND},${y} ${x1 + 2 * BEND},${y}
    L${x2 - 2 * BEND},${y} C${x2 - BEND},${y} ${x2 - BEND},${cy} ${x2},${cy}`,
    labelY: y - 5 };
}

function drawEdges(svg, stages, lay) {
  lay.edges.forEach((e) => {
    const info = edgeD(e, lay.pos, lay.cy);
    svg.appendChild(el("path", { class: `edge ${e.isVideo ? "video" : ""}`, d: info.d }));
    const mx = (lay.pos[e.from].x + NW + lay.pos[e.to].x) / 2;
    const t = el("text", { class: `elabel ${e.isVideo ? "video" : ""}`, x: mx - 14, y: info.labelY });
    t.textContent = e.isVideo ? "VIDEO" : "LATENT";
    svg.appendChild(t);
  });
}

function drawNodes(svg, stages, pos, state, host, onChange) {
  stages.forEach((s) => {
    const p = pos[s.id], on = isEnabled(state, s.id);
    const status = stageStatus(s, stages, host);
    const g = el("g", { class: `tnode${on ? "" : " off"}${state.sel === s.id ? " sel" : ""}` });
    const tip = el("title");
    tip.textContent = `${s.title} · ${STATUS_TEXT[status]}\n`
      + "点节点＝时间轴切到对应档案；右上开关＝本次运行是否旁路该阶段";
    g.appendChild(tip);
    g.appendChild(el("rect", { class: `node-rect ${s.kind}`, x: p.x, y: p.y, width: NW, height: NH, rx: 10 }));
    g.appendChild(el("circle", { class: `stat-dot ${status}`, cx: p.x + 12, cy: p.y + 14, r: 4 }));
    const name = el("text", { class: "tname", x: p.x + 22, y: p.y + 18 });
    name.textContent = nameOf(s);
    g.appendChild(name);
    const kind = el("text", { class: "tkind", x: p.x + 12, y: p.y + 34 });
    kind.textContent = s.kind === "video" ? "视频域超分" : "潜空间重采样";
    g.appendChild(kind);
    const from = el("text", { class: "tfrom", x: p.x + 12, y: p.y + 49 });
    from.textContent = fromText(s, stages);
    g.appendChild(from);
    g.appendChild(el("rect", { class: `sw ${on ? "on" : ""}`, "data-sw": s.id,
      x: p.x + NW - 34, y: p.y + 9, width: 24, height: 13, rx: 6.5 }));
    g.appendChild(el("circle", { class: "sw-knob", "data-sw": s.id,
      cx: p.x + NW - (on ? 12 : 28), cy: p.y + 15.5, r: 5 }));
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
