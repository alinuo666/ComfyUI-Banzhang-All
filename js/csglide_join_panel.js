/* ============================================================
 * Glide Join 剪辑面板 — 🔗 Glide 续接合成 (Join) 的可视化轨道
 * ------------------------------------------------------------
 * Join 节点过去全靠数字控件干活：重叠帧数、帧率都是盲切。本面板在
 * 节点里加一条「源片段时间带」——视频轨胶片条 + 音频轨波形，把切点
 * 摆在看得见的地方：
 *
 *   · 视频轨：源片段的缩略图胶片条，末尾重叠区红色高亮
 *   · 音频轨：同刻度的波形，切点竖线贯穿两轨
 *   · 切点竖线可左右拖动，直接写回「重叠帧数」控件
 *   · 悬停任意位置显示该帧大图预览
 *   · 自动接片：一键开关，端口收到新素材就自动接到时间轴素材的后面
 *   · 点击画面播放/暂停；画布上的参数控件全部收进面板「设置行」
 *
 * 只画源片段。续接片段是运行时才产生的张量，运行前磁盘上没有它，
 * 面板画不出来——这不是偷懒，是数据不存在。
 *
 * 后端数据来自 csglide_join_panel.py 的三个只读接口：
 *   /cglide/join/info · /cglide/join/thumb · /cglide/join/waveform
 * ============================================================ */
import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const NODE_ID = "CSGlideJoinCS";
const API = "/cglide/join";
const POLL_MS = 600;
const THUMB_STEP = 64;      // 胶片条上每张缩略图占的横向像素
const THUMB_PX = 192;       // 胶片条与图片兜底模式共用的缩略图宽度
const DRAG_GRAB = 14;       // 切点竖线两侧多少像素内按下算抓取
const MIN_WIDTH = 620;
const SEG_COLORS = ["#0C447C", "#185FA5", "#378ADD", "#5F5E5A"];   // 分段色条循环取色

/* ------------------------------------------------------------------ css */

const CSS = `
.gjoin {
  --h3-bg:#191919; --h3-panel:#212121; --h3-raise:#2b2b2b; --h3-line:#3b3b3b;
  --h3-well:#131313;
  --h3-txt:#e3e3e3; --h3-dim:#979797; --h3-label:#787878;
  --h3-accent:#58d1ff; --h3-accent-dim:#58d1ff26;
  --gj-over:#e24b4a; --gj-over-dim:#e24b4a2e; --gj-wave:#59c14f;
  font-family: ui-sans-serif, system-ui, "Segoe UI", sans-serif;
  color: var(--h3-txt); font-size: 12px; line-height: 1.35;
  /* 与导演台同一套穿透方案：wrapper none，根 auto，内部装饰层单独 none。
     高度吃满布局分配的空间（弹性分支会把节点富余高度分给本面板），
     内部再用 flex 分配：取景器吃富余，其余行保持固有高度。 */
  pointer-events: auto;
  position: relative;
  height: 100%;
  background: var(--h3-bg); border: 1px solid var(--h3-line); border-radius: 10px;
  padding: 8px; display: flex; flex-direction: column; gap: 6px;
  box-sizing: border-box; width: 100%; min-width: 0; overflow: hidden;
  user-select: none; -webkit-user-select: none;
}
.gjoin-bar {
  display: flex; align-items: center; gap: 8px; min-width: 0;
  color: var(--h3-dim); font-size: 11.5px; white-space: nowrap; overflow: hidden;
}
.gjoin-bar .gj-title { color: var(--h3-txt); font-weight: 500; flex: none; }
.gjoin-bar .gj-meta { overflow: hidden; text-overflow: ellipsis; }
.gjoin-bar .gj-err { color: #f09595; }
.gjoin-bar .gj-sep { color: var(--h3-line); flex: none; }
.gjoin-bar .gj-btn {
  all: unset; pointer-events: auto; cursor: pointer; flex: none;
  padding: 2px 9px; border-radius: 4px; background: var(--h3-raise);
  border: 1px solid var(--h3-line); font-size: 11px; color: var(--h3-txt);
  font-family: inherit;
}
.gjoin-bar .gj-btn:hover { border-color: var(--h3-accent); color: var(--h3-accent); }
.gjoin-bar .gj-btn.gj-on {
  border-color: var(--h3-accent); color: var(--h3-accent);
  background: var(--h3-accent-dim);
}
.gjoin-bar .gj-btn.gj-on::before {
  content: ""; display: inline-block; width: 6px; height: 6px;
  border-radius: 50%; background: var(--h3-accent);
  margin-right: 5px; vertical-align: middle;
}
.gjoin-bar .gj-btn:disabled { opacity: .4; cursor: default; }
.gjoin-bar .gj-clear:hover { border-color: var(--gj-over); color: var(--gj-over); }

/* 时间带：视频轨 + 音频轨共用同一横向刻度 */
.gjoin-band {
  position: relative; pointer-events: auto; cursor: crosshair;
  background: var(--h3-well); border: 1px solid var(--h3-line); border-radius: 6px;
  overflow: hidden; touch-action: none;
}
.gjoin-vtrack { position: relative; height: 58px; overflow: hidden; }
.gjoin-atrack {
  position: relative; height: 34px; overflow: hidden;
  border-top: 1px solid var(--h3-line);
}
.gjoin-atrack canvas { position: absolute; inset: 0; width: 100%; height: 100%; display: block; }

.gjoin-thumb {
  position: absolute; top: 0; bottom: 0; overflow: hidden; background: #0d0d0d;
}
.gjoin-thumb img {
  width: 100%; height: 100%; object-fit: cover; display: block; opacity: 0;
  transition: opacity .18s linear;
}
.gjoin-thumb img.gj-ok { opacity: 1; }

/* 分段着色：每段顶上一条色条（序号 + 文件名），段间一道分隔线。
   色条要能点（点中该段 → 下面出版本切换与重抽），所以吃指针事件，
   但要点下去立刻掐断冒泡——否则时间带会把它当成搓动/拖切点。 */
.gjoin-segbar {
  position: absolute; top: 0; height: 13px; z-index: 1; pointer-events: auto;
  cursor: pointer;
  display: flex; align-items: center; gap: 4px; padding: 0 4px; box-sizing: border-box;
  font-size: 10.5px; color: #f5f5f5; white-space: nowrap; overflow: hidden;
  text-shadow: 0 1px 3px #000a;
}
.gjoin-segbar.gj-sel { box-shadow: inset 0 0 0 1px #fff, 0 0 0 1px #0006; }
.gjoin-segbar .gj-v { flex: none; opacity: .85; font-size: 9.5px; }

/* 选中某段后的操作行：版本左右切 + 重抽本段 */
.gjoin-segact {
  display: flex; align-items: center; gap: 6px; padding: 3px 2px 0;
  font-size: 11px; color: var(--h3-txt);
}
.gjoin-segact .gj-vv {
  min-width: 54px; text-align: center; padding: 1px 4px; border-radius: 3px;
  background: var(--h3-well); border: 1px solid var(--h3-line);
}
.gjoin-segbar .gj-n {
  flex: none; min-width: 12px; height: 12px; border-radius: 3px; line-height: 12px;
  text-align: center; font-size: 10px; background: #00000059;
}
.gjoin-segbar .gj-f { overflow: hidden; text-overflow: ellipsis; }
.gjoin-segsep {
  position: absolute; top: 0; bottom: 0; width: 2px; z-index: 1;
  pointer-events: none; background: #0a0a0a;
}

/* 时间码气泡：跟着鼠标走，悬停/搓动时显示当前帧，拖切点时显示重叠信息 */
.gjoin-bub {
  position: absolute; top: 16px; transform: translateX(-50%); z-index: 4;
  pointer-events: none; display: none; white-space: nowrap;
  background: #000000d9; border: 1px solid var(--h3-line); border-radius: 4px;
  padding: 1px 6px; font-size: 11px; color: var(--h3-txt);
}
/* 鼠标够到切点手柄时给「可以拖」的反馈 */
.gjoin-band.gj-near { cursor: ew-resize; }
.gjoin-band.gj-near .gjoin-cut { background: #ff6b6b; }

.gjoin-over {
  position: absolute; top: 0; bottom: 0; pointer-events: none;
  background: var(--gj-over-dim);
  border-left: 2px solid var(--gj-over);
  box-sizing: border-box;
}
.gjoin-over::after {
  content: ""; position: absolute; inset: 0;
  background: repeating-linear-gradient(-45deg, transparent 0 6px, #e24b4a14 6px 12px);
}
.gjoin-cut {
  position: absolute; top: -3px; bottom: -3px; width: 2px; margin-left: -1px;
  background: var(--gj-over); pointer-events: none; z-index: 3;
}
.gjoin-cut::before {
  content: ""; position: absolute; top: -1px; left: -5px; width: 12px; height: 12px;
  border-radius: 50%; background: var(--gj-over);
  box-shadow: 0 0 0 2px var(--h3-well);
}
.gjoin-band.gj-drag { cursor: ew-resize; }
.gjoin-band.gj-drag .gjoin-cut { background: #fff; }

/* 播放头：白竖线 + 顶部倒三角，剪辑软件同款。点击时间轴跳转，
   按住搓动，播放时实时跟随。与红色切点线是两回事——切点决定
   重叠区在哪，播放头只表示「现在看到哪」。 */
.gjoin-play {
  position: absolute; top: 0; bottom: 0; width: 2px; margin-left: -1px;
  background: #f5f5f5; pointer-events: none; z-index: 2;
  box-shadow: 0 0 4px #000c;
}
.gjoin-play::before {
  content: ""; position: absolute; top: 0; left: -5px;
  border-left: 6px solid transparent; border-right: 6px solid transparent;
  border-top: 8px solid #f5f5f5;
}
.gjoin-band.gj-live { cursor: grabbing; }

/* 取景器：常驻的预览窗口。点击画面播放/暂停（左上角小圆标提示状态），
   拖红线到哪一帧就显示哪一帧；浏览器放不了的视频（HEVC 之类）自动退化
   成抽帧图片。高度弹性：节点拉大它跟着大，缩到下限后不再压缩。 */
.gjoin-view {
  position: relative; background: var(--h3-well); cursor: pointer;
  border: 1px solid var(--h3-line); border-radius: 6px;
  flex: 1 1 110px; min-height: 90px;
  display: flex; flex-direction: column;
  align-items: center; justify-content: center; gap: 5px; overflow: hidden;
}
.gjoin-view video, .gjoin-view img {
  /* 两只视频叠在同一格：在岗的亮、备班的透（透明但保持解码），
     跨片段边界切过去已经缓冲好——这就是无黑帧的关键。 */
  position: absolute; inset: 0 7px; width: calc(100% - 14px); height: 100%;
  object-fit: contain; display: block; border-radius: 4px; background: #000;
}
.gj-vid { opacity: 0; }
.gj-vid.gj-live { opacity: 1; }
.gjoin-view video[hidden], .gjoin-view img[hidden] { display: none; }
.gj-flag {
  position: absolute; left: 8px; top: 8px; width: 20px; height: 20px;
  border-radius: 50%; background: #000000b3; border: 1px solid var(--h3-line);
  pointer-events: none;
}
.gj-flag::after {
  content: ""; position: absolute; left: 7px; top: 5px;
  border-left: 7px solid #f5f5f5; border-top: 4px solid transparent;
  border-bottom: 4px solid transparent;
}
.gj-flag.gj-run::after {
  border: none; left: 6px; top: 5px; width: 3px; height: 9px;
  background: #f5f5f5; box-shadow: 4px 0 0 #f5f5f5;
}
.gjoin-view .gj-vcap {
  /* 悬浮在画面底部：弹性高度下视频会占满窗口，说明文字独占一行会被裁掉 */
  position: absolute; left: 8px; right: 8px; bottom: 4px; z-index: 2;
  color: var(--h3-dim); font-size: 11px; text-align: center;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  text-shadow: 0 1px 3px #000c; pointer-events: none;
}

/* 设置行：画布上的参数全部收进这一排。分段选择器 + 步进器 + 拨动开关 +
   虚线路径框，同一套描边与字号，看起来是一排仪器旋钮而不是一排表单。
   节点拖窄时允许换行，不硬裁。 */
.gjoin-set {
  display: flex; align-items: center; flex-wrap: wrap;
  gap: 6px 12px; padding: 0 2px; overflow: hidden;
}
.gj-s { display: flex; align-items: center; gap: 6px; flex: none; }
.gj-l { color: var(--h3-label); font-size: 11px; flex: none; }
.gj-seg {
  display: flex; border: 1px solid var(--h3-line); border-radius: 5px;
  overflow: hidden; flex: none;
}
.gj-seg button {
  all: unset; cursor: pointer; padding: 2px 9px; font-size: 11px;
  color: var(--h3-dim); font-family: inherit; border-right: 1px solid var(--h3-line);
}
.gj-seg button:last-child { border-right: none; }
.gj-seg button:hover { color: var(--h3-txt); }
.gj-seg button.gj-act { background: var(--h3-accent-dim); color: var(--h3-accent); }
.gj-step {
  display: flex; align-items: center; border: 1px solid var(--h3-line);
  border-radius: 5px; overflow: hidden; flex: none;
}
.gj-step button {
  all: unset; cursor: pointer; width: 18px; text-align: center; line-height: 1;
  padding: 3px 0; color: var(--h3-dim); font-size: 12px; font-family: inherit;
}
.gj-step button:hover { color: var(--h3-accent); }
.gj-step .gj-v { min-width: 22px; text-align: center; font-size: 11px; color: var(--h3-txt); }
.gj-s[data-off="1"] { opacity: .38; pointer-events: none; }
.gj-tg { cursor: pointer; }
.gj-sw { position: relative; width: 26px; height: 15px; flex: none; }
.gj-sw input { position: absolute; inset: 0; opacity: 0; margin: 0; cursor: pointer; }
.gj-sw i {
  position: absolute; inset: 0; box-sizing: border-box; pointer-events: none;
  border-radius: 8px; background: #2b2b2b; border: 1px solid var(--h3-line);
}
.gj-sw i::after {
  content: ""; position: absolute; top: 1px; left: 1px; width: 11px; height: 11px;
  border-radius: 50%; background: #979797; transition: left .15s, background .15s;
}
.gj-sw input:checked + i { background: var(--h3-accent-dim); border-color: var(--h3-accent); }
.gj-sw input:checked + i::after { left: 12px; background: var(--h3-accent); }
.gj-chip {
  font-size: 11px; color: var(--h3-dim); white-space: nowrap; flex: none;
  border: 1px dashed var(--h3-line); border-radius: 4px; padding: 1px 7px;
}
.gj-path {
  all: unset; flex: 1 1 60px; min-width: 56px; box-sizing: border-box;
  border: 1px dashed var(--h3-line); border-radius: 5px; padding: 2px 7px;
  font-size: 11px; color: var(--h3-txt); font-family: inherit;
}
.gj-path::placeholder { color: var(--h3-label); }
.gj-path:focus { border-color: var(--h3-accent); border-style: solid; }

.gjoin-tip {
  display: flex; gap: 8px; align-items: center; min-width: 0;
  color: var(--h3-label); font-size: 11px; white-space: nowrap; overflow: hidden;
}
.gjoin-tip .gj-ov { color: var(--gj-over); }
.gjoin-tip .gj-keep { color: var(--h3-accent); }
.gjoin-tip .gj-pass { color: #e2a24b; flex: none; }
.gjoin-tip .gj-hint { margin-left: auto; color: var(--h3-label); opacity: .8; flex: none; }
`;

function injectCSS() {
  if (document.getElementById("gjoin-css")) return;
  const s = document.createElement("style");
  s.id = "gjoin-css";
  s.textContent = CSS;
  document.head.appendChild(s);
}

/* ------------------------------------------------------------- helpers */

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const fmtSec = (s) => (s >= 10 ? s.toFixed(1) : s.toFixed(2)) + "s";

function getWidget(node, name) {
  return node.widgets?.find((w) => w.name === name);
}

/* 画布参数控件收进面板设置行：折叠成 0 高（同官方「转换为输入」时隐藏控件
   的做法），控件对象留在节点上——值照常序列化保存，后端照常读取。 */
const HIDDEN_PARAMS = ["source_video", "seam_mode", "seam_blend_frames",
  "match_levels", "fps", "match_tail", "overlap_frames"];

function hideParamWidgets(node) {
  for (const name of HIDDEN_PARAMS) {
    const w = getWidget(node, name);
    if (!w || w.type === "converted-widget") continue;
    w.origType = w.type;
    w.computeSize = () => [0, -4];
    w.type = "converted-widget";
    w.hidden = true;      // 双保险：老渲染器认 hidden，新渲染器认 converted-widget
  }
}

/* 画布上只留这 3 个接线口，顺序即画布顺序（续接片段 → 音频 → 重叠帧）。
   源视频不做端口——路径在面板里填，或由「引用上次片段 / 自动接片」供值。 */
const WIRE_PORTS = [
  { name: "images", type: "IMAGE", label: "续接片段" },
  { name: "audio", type: "AUDIO", label: "音频" },
  { name: "overlap_frames", type: "INT", label: "重叠帧数" },
];

/* 摘掉一个端口：连同它上面的连线一起清干净（图里的 link 记录 + 来源端的
   links 列表），否则会留下指向不存在端口的悬空连线。 */
function dropSlot(node, slot) {
  const lid = slot?.link;
  if (slot) slot.link = null;
  if (lid == null || !node.graph) return;
  const links = node.graph.links;
  const link = links instanceof Map ? links.get(lid) : links?.[lid];
  if (link) {
    const out = node.graph.getNodeById?.(link.origin_id)?.outputs?.[link.origin_slot];
    const k = out?.links ? out.links.indexOf(lid) : -1;
    if (k >= 0) out.links.splice(k, 1);
  }
  if (links instanceof Map) links.delete(lid);
  else if (link) delete links[lid];
}

/* 端口对齐：删掉不在 WIRE_PORTS 里的端口（源视频、以及老工程遗留的接缝
   模式/匹配级别/帧率…），补齐缺的重叠帧端口，再按 WIRE_PORTS 顺序摆好并
   修正连线记录的槽位号。源视频/重叠帧用「纯端口」（不带 widget 关联）：
   任何渲染器下都排在顶部输入区、和图像音频长一样；数值本体由折叠控件
   保管，没接线时就用它。 */
function syncInputPorts(node) {
  const ins = node.inputs;
  if (!ins) return;
  for (let i = ins.length - 1; i >= 0; i--) {
    if (WIRE_PORTS.some((p) => p.name === ins[i]?.name)) continue;
    dropSlot(node, ins[i]);
    ins.splice(i, 1);
  }
  for (const p of WIRE_PORTS) {
    const s = ins.find((x) => x?.name === p.name);
    if (s) { delete s.widget; continue; }   // 老工程残留的半端口升级成纯端口
    node.addInput(p.name, p.type, { label: p.label });
  }
  const rank = (n) => { const i = WIRE_PORTS.findIndex((p) => p.name === n); return i < 0 ? 99 : i; };
  ins.sort((a, b) => rank(a?.name) - rank(b?.name));
  /* 删端口会让剩下的往前挪，所以无论顺序有没有变，都要按最终位置重算一遍
     连线记录的槽位号，不然线会插到错误的端口上。 */
  ins.forEach((s, i) => {
    if (s?.link == null) return;
    const links = node.graph?.links;
    const link = links instanceof Map ? links.get(s.link) : links?.[s.link];
    if (link && link.target_slot !== i) link.target_slot = i;
  });
}

/* 值是否合法（能直接采用）：类型对得上、落在候选/区间里。 */
function valueOK(kind, o, v) {
  if (kind === "toggle") return typeof v === "boolean";
  if (kind === "number" || kind === "slider") {
    if (v === "" || v == null) return false;
    const n = Number(v);
    return Number.isFinite(n) && n >= (o.min ?? -Infinity) && n <= (o.max ?? Infinity);
  }
  if (kind === "combo") return Array.isArray(o.values) ? o.values.includes(v) : false;
  return typeof v === "string";
}

/* 控件顺序变过之后，老工程的 widgets_values 是按位置存的，会整条串值
   （实测出现过「帧率 = 硬切」「匹配级别 = 24」）。按控件类型把非法值掰回
   默认值，否则面板和后端都会读到脏数据。 */
function sanitizeWidgets(node, info) {
  /* 命名表（widgets_values_named）是按名字存的，不受控件顺序影响。里面的值
     合法就直接采用——能把用户原本选的东西（如「硬切」）救回来。 */
  const named = info?.widgets_values_named;
  for (const w of node.widgets || []) {
    if (!w || w.serialize === false) continue;
    const kind = w.origType || w.type;
    const o = w.options || {};
    const nv = named?.[w.name];
    if (nv !== undefined && valueOK(kind, o, nv)) { w.value = nv; continue; }
    const v = w.value;
    if (kind === "toggle") {
      if (typeof v !== "boolean") w.value = !!v && v !== "false" && v !== "0";
    } else if (kind === "number" || kind === "slider") {
      if (v === "" || v == null) { w.value = o.default ?? 0; continue; }
      const n = Number(v);
      w.value = Number.isFinite(n)
        ? clamp(n, o.min ?? -Infinity, o.max ?? Infinity)
        : (o.default ?? 0);
    } else if (kind === "combo") {
      const vals = o.values;
      if (Array.isArray(vals) && vals.length && !vals.includes(v)) w.value = o.default ?? vals[0];
    }
  }
}

/* ------------------------------------------------------------- panel */

function buildPanel(node) {
  injectCSS();

  const root = document.createElement("div");
  root.className = "gjoin";
  root.innerHTML = `
    <div class="gjoin-bar">
      <span class="gj-title">🎞 源片段</span>
      <span class="gj-sep">|</span>
      <span class="gj-meta">等待选择源视频…</span>
      <button class="gj-btn" type="button" title="把最新生成的成片设为源片段：时间轴随即显示它，可以直接在上面拖切点，下一次续接就落在这条片上">引用上次片段</button>
      <button class="gj-btn gj-chain" type="button" title="自动接片：开启后，每跑完一轮生成，视频合并节点新存下的成片就自动接到时间轴已有素材的后面，并写进源视频控件——下一轮 join 拿它当源片继续拼。若本节点连着某个视频合并的「图像透传」输出，则只认那个节点的成片（最高权重）。切点红线自动锚到最新一段；再点一次停止">自动接片</button>
      <button class="gj-btn gj-clear" type="button" title="一键清空：下架时间轴上的所有素材，接片链和源视频一并归零（恢复到空白，可重新引用/接片）">清空</button>
    </div>
    <div class="gjoin-view" title="点击画面播放 / 暂停">
      <video class="gj-vid" muted playsinline preload="metadata"></video>
      <video class="gj-vid" muted playsinline preload="metadata"></video>
      <img alt="" hidden>
      <div class="gj-flag" style="display:none"></div>
      <div class="gj-vcap">选取源视频后显示预览</div>
    </div>
    <div class="gjoin-band">
      <div class="gjoin-vtrack"></div>
      <div class="gjoin-atrack"><canvas></canvas></div>
      <div class="gjoin-over" style="display:none"></div>
      <div class="gjoin-cut" style="display:none"></div>
      <div class="gjoin-play" style="display:none"></div>
      <div class="gjoin-bub"></div>
    </div>
    <div class="gjoin-set">
      <div class="gj-s">
        <span class="gj-l">拼接</span>
        <div class="gj-seg">
          <button type="button" data-v="提前切" title="保留续接片段的重叠并按源片段着色——一条连续的模型轨迹，运动衔接更好">提前切</button>
          <button type="button" data-v="S 渐变切" title="同样的拼接但跨几帧渐变，用于速度变化可见的情况">S 渐变</button>
          <button type="button" data-v="硬切" title="改用源片段自身帧，丢弃重新渲染的头部">硬切</button>
        </div>
      </div>
      <div class="gj-s" data-name="blend" data-off="1" title="「S 渐变切」的渐变帧数，其他拼接方式不用">
        <span class="gj-l">渐变帧</span>
        <div class="gj-step">
          <button type="button" data-d="-1" title="减 1 帧">−</button>
          <span class="gj-v">6</span>
          <button type="button" data-d="1" title="加 1 帧">＋</button>
        </div>
      </div>
      <label class="gj-s gj-tg" title="匹配级别：逐帧把续接片段的亮度增益与偏移对齐到源片段，跨越重叠区并在其后保持">
        <span class="gj-l">匹配级别</span>
        <span class="gj-sw"><input type="checkbox" data-w="match_levels"><i></i></span>
      </label>
      <label class="gj-s gj-tg" title="把音频裁剪为恰好 帧数/帧率——H3 的音频网格向上取整，不裁会逐段累积多出的约 8ms">
        <span class="gj-l">音频对齐</span>
        <span class="gj-sw"><input type="checkbox" data-w="match_tail"><i></i></span>
      </label>
      <div class="gj-s" title="自动取源片段的帧率，保证「音频对齐」裁得准">
        <span class="gj-l">帧率</span>
        <span class="gj-chip gj-fps">—</span>
      </div>
      <input class="gj-path" spellcheck="false" placeholder="源视频完整路径">
    </div>
    <div class="gjoin-segact" style="display:none">
      <span class="gj-sl">—</span>
      <button class="gj-btn" type="button" data-d="-1" title="回到这一段的上一个抽卡版本">‹</button>
      <span class="gj-vv">版本 1/1</span>
      <button class="gj-btn" type="button" data-d="1" title="看这一段的下一个抽卡版本">›</button>
      <button class="gj-btn gj-rr" type="button" title="这一段重抽：把上一段的成片填回源视频，重跑生成覆盖这一段（旧版本留着，随时切回来）。这一段之后的段落会依次重跑一遍">重抽本段</button>
      <button class="gj-btn gj-px" type="button" title="取消选中">✕</button>
    </div>
    <div class="gjoin-tip">
      <span class="gj-ov">重叠 —</span>
      <span class="gj-keep">保留至 —</span>
      <span class="gj-pass" hidden title="源视频控件是空的——本次运行不会拼接，画面音频原样直通">⚠ 未连源片 · 本次直通不拼接</span>
      <span class="gj-hint">拖红线调重叠 · 点击播放(段间续播) · 按住搓动</span>
    </div>
  `;

  const el = {
    title: root.querySelector(".gj-title"),
    meta: root.querySelector(".gj-meta"),
    clear: root.querySelector(".gj-clear"),
    band: root.querySelector(".gjoin-band"),
    vtrack: root.querySelector(".gjoin-vtrack"),
    atrack: root.querySelector(".gjoin-atrack"),
    canvas: root.querySelector("canvas"),
    over: root.querySelector(".gjoin-over"),
    cut: root.querySelector(".gjoin-cut"),
    ovTip: root.querySelector(".gj-ov"),
    keepTip: root.querySelector(".gj-keep"),
    pass: root.querySelector(".gj-pass"),
    vimg: root.querySelector(".gjoin-view img"),
    vcap: root.querySelector(".gjoin-view .gj-vcap"),
    videos: [...root.querySelectorAll(".gjoin-view video")],
    view: root.querySelector(".gjoin-view"),
    flag: root.querySelector(".gj-flag"),
    play: root.querySelector(".gjoin-play"),
    bub: root.querySelector(".gjoin-bub"),
    seg: root.querySelector(".gj-seg"),
    blend: root.querySelector('.gj-s[data-name="blend"]'),
    blendV: root.querySelector(".gj-step .gj-v"),
    fpsChip: root.querySelector(".gj-fps"),
    path: root.querySelector(".gj-path"),
    btn: root.querySelector(".gj-btn"),
    chain: root.querySelector(".gj-chain"),
    segact: root.querySelector(".gjoin-segact"),
    segLabel: root.querySelector(".gjoin-segact .gj-sl"),
    segVer: root.querySelector(".gjoin-segact .gj-vv"),
    reroll: root.querySelector(".gjoin-segact .gj-rr"),
    unpick: root.querySelector(".gjoin-segact .gj-px"),
  };

  const state = {
    video: "",       // 当前源视频值
    info: null,      // /info 返回
    wave: null,      // /waveform 返回
    overlap: 0,      // 本地镜像的重叠帧数（以节点控件为准，这里只缓存）
    drag: false,
    scrub: false,    // 在空白时间带上按住搓动（跳帧预览），区别于拖切点
    thumbs: [],      // {div, frame}
    dead: false,
    vFrame: -1,      // 取景器当前显示的帧
    vCut: null,      // 该帧是不是切点帧
    videoOK: true,   // 浏览器能放这条源视频吗；不能就退化成抽帧图片
    vA: 0,           // 双视频里在岗的那只（0/1），另一只备班预取下一段
    typingPath: false, // 正在手填源路径，轮询先别拿半截路径去读盘
    /* 自动接片：segs 是「轮次」列表，每轮一个位置，按接片顺序排列。
       每轮可以有多个抽卡版本：alts 是候选池（越靠后越新），alt 是当前
       选中的那个——重抽不会覆盖旧版本，只是把新结果加进池子并选中它。 */
    chain: { on: false, segs: [] },
    pick: -1,        // 时间轴上选中了第几段（-1 = 没选）
    reroll: null,    // 从第几段起「依次重跑」：新成片对位替换这一轮，跑完自动归位
  };

  /* 在岗视频：双视频交替，另一只备班预取下一段（跨段零黑帧） */
  const av = () => el.videos[state.vA];

  /* ---------- data ---------- */

  async function loadInfo(video) {
    const res = await api.fetchApi(`${API}/info?video=${encodeURIComponent(video)}`);
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  async function loadWave(video) {
    const res = await api.fetchApi(`${API}/waveform?video=${encodeURIComponent(video)}&bins=900`);
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  function setMeta(html, isError) {
    el.meta.innerHTML = html;
    el.meta.classList.toggle("gj-err", !!isError);
  }

  function refresh(video) {
    state.video = video;
    state.info = null;
    state.wave = null;
    state.vFrame = -1;
    state.vCut = null;
    el.play.style.display = "none";   // 换源了，播放头别停在旧位置
    state.thumbs.forEach((t) => t.div.remove());
    state.thumbs = [];
    /* 段落色条占位也要清：只有 buildThumbs 会重画它们，空源清空时不跑
       buildThumbs，不在这里删的话占位会赖在轨道上（缩略图没了占位还在） */
    el.vtrack.querySelectorAll(".gjoin-segbar, .gjoin-segsep").forEach((d) => d.remove());
    hideOverlays();
    el.vimg.removeAttribute("src");
    for (const v of el.videos) v.pause?.();
    if (video) {
      const cur = av(), idle = el.videos[1 - state.vA];
      // /cglide/join/video 是 Range 流，浏览器拿它 seek 和逐帧都流畅
      cur.dataset.v = video;        // 取景器当前装的是哪条片（自动接片切换段时要用）
      cur.src = `${API}/video?video=${encodeURIComponent(video)}`;
      cur.classList.add("gj-live");
      idle.dataset.v = "";          // 备班的清空，之后由预取填下一段
      idle.removeAttribute("src");
      idle.classList.remove("gj-live");
      el.vimg.hidden = true;
      state.videoOK = true;
    } else {
      for (const v of el.videos) {
        v.dataset.v = "";
        v.removeAttribute("src");
        v.classList.remove("gj-live");
      }
      el.vimg.hidden = true;
    }
    el.vcap.textContent = video ? "读取中…" : "选取源视频后显示预览";
    syncFlag();
    if (!video) {
      setMeta("等待选择源视频…");
      drawWave();
      return;
    }
    setMeta("读取中…");
    loadInfo(video)
      .then((info) => {
        if (state.dead || state.video !== video) return;
        state.info = info;
        setMeta(srcMeta(video, info));
        buildThumbs();
        if (info.has_audio) {
          loadWave(video).then((w) => {
            if (state.dead || state.video !== video) return;
            state.wave = w;
            drawWave();
          }).catch(() => setMeta(`${esc(shortName(video))} · 波形读取失败（画面仍可用）`));
        } else {
          drawWave();
        }
        syncFromWidgets();
        syncSettings();
      })
      .catch((err) => {
        if (state.dead || state.video !== video) return;
        setMeta(`无法读取视频：${esc(err.message || err)}`, true);
        drawWave();
      });
  }

  function shortName(v) {
    const s = String(v).replace(/\\/g, "/");
    return s.split("/").pop() || s;
  }

  function srcMeta(video, info) {
    return `${esc(shortName(video))} · ${info.total_frames}帧 · ${fmtSec(info.duration)} · ${info.fps.toFixed(info.fps % 1 ? 2 : 0)}fps · ${info.width}×${info.height}${info.has_audio ? "" : " · 无音轨"}`;
  }

  /* ---------- thumbs ---------- */

  /* 一段的色条（序号 + 文件名）和它与上一段的分隔线 */
  function drawSegBar(i, name, x0, width) {
    const bar = document.createElement("div");
    bar.className = "gjoin-segbar";
    bar.dataset.i = i;
    bar.style.left = `${x0}px`;
    bar.style.width = `${width}px`;
    bar.style.background = SEG_COLORS[i % SEG_COLORS.length];
    const seg = state.chain.on ? state.chain.segs[i] : null;
    const vt = seg && seg.alts.length > 1
      ? `<span class="gj-v">v${seg.alt + 1}/${seg.alts.length}</span>` : "";
    bar.innerHTML = `<span class="gj-n">${i + 1}</span><span class="gj-f">${esc(name)}</span>${vt}`;
    if (state.pick === i) bar.classList.add("gj-sel");
    /* 点在色条上是「选中这一段」，不是在时间带上搓动——掐断冒泡 */
    if (seg) {
      bar.addEventListener("pointerdown", (e) => { e.stopPropagation(); pickSeg(i); });
    }
    el.vtrack.appendChild(bar);
    if (i > 0) {
      const sep = document.createElement("div");
      sep.className = "gjoin-segsep";
      sep.style.left = `${x0 - 1}px`;
      el.vtrack.appendChild(sep);
    }
  }

  function buildThumbs() {
    state.thumbs.forEach((t) => t.div.remove());
    state.thumbs = [];
    el.vtrack.querySelectorAll(".gjoin-segbar, .gjoin-segsep").forEach((d) => d.remove());
    const width = el.vtrack.clientWidth || 400;

    /* 自动接片：每段按帧数比例分一块横向区间，块内铺自己的缩略图 */
    if (state.chain.on) {
      if (chainN() < 1) return;
      state.chain.segs.forEach((s, i) => {
        const fn = s.info?.total_frames || 0;
        const en = effLen(i);
        if (en < 1) return;
        const x0 = frameToX(segStart(i));
        const x1 = frameToX(segStart(i) + en - 1);
        const segW = Math.max(THUMB_STEP, x1 - x0);
        const count = clamp(Math.ceil(segW / THUMB_STEP), 2, 64);
        const w = segW / count;
        drawSegBar(i, shortName(s.video), x0, x1 - x0);
        for (let k = 0; k < count; k++) {
          const local = Math.round((k * (en - 1)) / (count - 1));
          const div = document.createElement("div");
          div.className = "gjoin-thumb";
          div.style.left = `${x0 + k * w}px`;
          div.style.width = `${w + 1}px`;
          const img = document.createElement("img");
          img.src = thumbURL(local, THUMB_PX, s.video);
          img.onload = () => img.classList.add("gj-ok");
          div.appendChild(img);
          el.vtrack.appendChild(div);
          state.thumbs.push({ div, frame: segStart(i) + local });
        }
      });
      return;
    }

    const info = state.info;
    if (!info || info.total_frames < 1) return;
    drawSegBar(0, shortName(state.video), 0, width);
    const count = clamp(Math.ceil(width / THUMB_STEP), 4, 64);
    const w = width / count;
    for (let i = 0; i < count; i++) {
      const frame = Math.round((i * (info.total_frames - 1)) / (count - 1));
      const div = document.createElement("div");
      div.className = "gjoin-thumb";
      div.style.left = `${i * w}px`;
      div.style.width = `${w + 1}px`;
      const img = document.createElement("img");
      img.src = `${API}/thumb?video=${encodeURIComponent(state.video)}&frame=${frame}&w=${THUMB_PX}`;
      img.onload = () => img.classList.add("gj-ok");
      div.appendChild(img);
      el.vtrack.appendChild(div);
      state.thumbs.push({ div, frame });
    }
  }

  /* ---------- waveform ---------- */

  function drawWave() {
    const canvas = el.canvas;
    const w = el.atrack.clientWidth, h = el.atrack.clientHeight;
    if (!w || !h) return;
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
      canvas.width = w * dpr;
      canvas.height = h * dpr;
    }
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const mid = h / 2;

    /* 自动接片：每段在自己的横向区间里画自己的波形 */
    if (state.chain.on) {
      let any = false;
      state.chain.segs.forEach((s, i) => {
        const fn = s.info?.total_frames || 0;
        if (!s.wave?.bins?.length || fn < 2) return;
        any = true;
        const x0 = frameToX(segStart(i));
        const x1 = frameToX(segStart(i) + effLen(i) - 1);
        const segW = Math.max(1, x1 - x0);
        const bins = s.wave.bins;
        ctx.fillStyle = "#59c14f";
        const colW = segW / bins.length;
        for (let b = 0; b < bins.length; b++) {
          const v = bins[b] * (h / 2 - 2);
          ctx.fillRect(x0 + b * colW, mid - v, Math.max(1, colW - 0.4), v * 2);
        }
      });
      if (!any) {
        ctx.fillStyle = "#979797";
        ctx.font = "11px ui-sans-serif, system-ui, sans-serif";
        ctx.fillText("等待音频数据…", 8, h / 2 + 4);
      }
      return;
    }

    const wave = state.wave;
    if (!wave || !wave.bins?.length) {
      ctx.fillStyle = "#979797";
      ctx.font = "11px ui-sans-serif, system-ui, sans-serif";
      const text = state.info && !state.info.has_audio ? "该片段没有音轨" : "等待音频数据…";
      ctx.fillText(text, 8, h / 2 + 4);
      return;
    }
    const bins = wave.bins;
    ctx.fillStyle = "#59c14f";
    const colW = w / bins.length;
    for (let x = 0; x < bins.length; x++) {
      const v = bins[x] * (h / 2 - 2);
      ctx.fillRect(x * colW, mid - v, Math.max(1, colW - 0.4), v * 2);
    }
  }

  /* ---------- overlap ---------- */

  function hasData() {
    return state.chain.on ? state.chain.segs.length > 0 : !!state.info;
  }

  function curInfo() {
    return state.chain.on ? (lastSeg()?.info || null) : state.info;
  }

  /* 第 i 段在真正成片里贡献的帧数：非末段扣掉尾部 overlap——那段画面会被
     下一段开头重新渲染出来，真正的成片里只有一份。时间轴按这个摆，
     跨边界才不会把重叠内容播两遍。 */
  function effLen(i) {
    const n = state.chain.segs[i]?.info?.total_frames || 0;
    return i < state.chain.segs.length - 1 ? Math.max(0, n - state.overlap) : n;
  }

  /* 自动接片：全轨总帧数 = 各段按真实成片的贡献之和 */
  function chainN() {
    let t = 0;
    state.chain.segs.forEach((_, i) => { t += effLen(i); });
    return t;
  }

  /* 第 i 段在全轨上的起始帧 */
  function segStart(i) {
    let start = 0;
    for (let k = 0; k < i; k++) start += effLen(k);
    return start;
  }

  /* 全轨帧号 → 哪一段的第几帧。超出末尾按最后一段收住。 */
  function chainAt(frame) {
    let start = 0;
    for (let i = 0; i < state.chain.segs.length; i++) {
      const n = effLen(i);
      if (frame < start + n) return { i, seg: state.chain.segs[i], local: frame - start };
      start += n;
    }
    const last = state.chain.segs.length - 1;
    return last >= 0
      ? { i: last, seg: state.chain.segs[last], local: Math.max(0, effLen(last) - 1) }
      : null;
  }

  /* 切点帧的全轨位置：永远锚在「将被续接的那条片段」末尾——
     单源就是源片段本身，自动接片就是最后接进来的那段。 */
  function cutGlobal() {
    if (state.chain.on) {
      const s = lastSeg();
      return s ? segStart(state.chain.segs.length - 1) + (s.info?.total_frames || 0) - state.overlap : 0;
    }
    return totalFrames() - state.overlap;
  }

  /* 重叠帧端口接了线（导演台供值）时，拖红线改的本地值不会生效——
     要诚实：红线只看不可拖，提示行说明数值来源。 */
  function ovLinked() {
    return !!node.inputs?.find((i) => i.name === "overlap_frames")?.link;
  }

  function totalFrames() {
    if (state.chain.on) return chainN();
    return state.info ? state.info.total_frames : 0;
  }

  /* 时间带有两套宽度：布局宽（clientWidth，不含画布缩放）和可视宽
     （getBoundingClientRect，含缩放）。鼠标坐标永远来自可视宽，所以凡是
     「鼠标 → 帧」的换算必须用可视宽；DOM 定位用布局宽。两套混用就是
     「线不跟手」的根因——画布一缩放，两套基准不一样，线整体偏移。 */
  function bandLayoutW() {
    return el.band.clientWidth || el.band.offsetWidth || 400;
  }

  function bandViewW() {
    return el.band.getBoundingClientRect().width || bandLayoutW();
  }

  /* 鼠标坐标（可视像素）→ 布局像素，用于给气泡等 DOM 定位 */
  function viewToLayout(x) {
    const rw = bandViewW();
    return rw ? x * (bandLayoutW() / rw) : x;
  }

  function frameToX(frame) {
    const n = totalFrames();
    if (n < 2) return 0;
    return (frame / (n - 1)) * bandLayoutW();
  }

  function xToFrame(x) {
    const n = totalFrames();
    const width = bandViewW();
    if (n < 2 || !width) return 0;
    return Math.round(clamp(x / width, 0, 1) * (n - 1));
  }

  function writeOverlap(frames) {
    const w = getWidget(node, "overlap_frames");
    if (!w) return;
    const v = clamp(Math.round(frames), 0, 999999);
    if (w.value !== v) {
      w.value = v;
      w.callback?.(v);
    }
    state.overlap = v;
    paint();
  }

  function syncFromWidgets() {
    const w = getWidget(node, "overlap_frames");
    const v = w ? Math.round(+w.value || 0) : 0;
    if (v !== state.overlap) {
      state.overlap = v;
      paint();
    }
  }

  function hideOverlays() {
    el.over.style.display = "none";
    el.cut.style.display = "none";
    el.ovTip.textContent = "重叠 —";
    el.keepTip.textContent = "保留至 —";
  }

  function paint() {
    const n = totalFrames();
    const ov = state.overlap;
    const refN = state.chain.on ? (lastSeg()?.info?.total_frames || 0) : n;
    if (!n || ov <= 0 || ov >= refN) {
      hideOverlays();
      if (n && ov >= refN) el.ovTip.textContent = "重叠 ≥ 片段长度，检查重叠帧数";
      /* 没有重叠可画时取景器仍要有内容：停在最后一帧，面板不至于空着 */
      if (n) updateView(n - 1, false);
      return;
    }
    const cutF = cutGlobal();
    const x = frameToX(cutF);
    el.over.style.display = "block";
    el.cut.style.display = "block";
    el.over.style.left = `${x}px`;
    el.over.style.width = `${el.band.clientWidth - x}px`;
    el.cut.style.left = `${x}px`;

    const fps = curInfo()?.fps || 24;
    el.ovTip.textContent = `重叠 ${ov}帧 (${fmtSec(ov / fps)})`;
    el.keepTip.textContent = ovLinked()
      ? "重叠帧已接线 · 数值由导演台供"
      : `保留至 第${cutF - 1}帧 · ${fmtSec(cutF / fps)}`;
    /* 取景器跟着切点走：红线停在哪一帧，就显示哪一帧 */
    updateView(cutF, true);
  }

  /* ---------- 取景器 ---------- */

  function thumbURL(frame, px, video) {
    return `${API}/thumb?video=${encodeURIComponent(video || state.video)}&frame=${frame}&w=${px}`;
  }

  /* 播放头：白色竖线标「现在看到哪」。与红色切点线是两回事——切点由
     重叠帧数决定，播放头只跟着取景器/视频播放走。 */
  function paintPlay() {
    if (!hasData() || state.vFrame < 0) {
      el.play.style.display = "none";
      return;
    }
    el.play.style.display = "block";
    el.play.style.left = `${frameToX(state.vFrame)}px`;
  }

  /* 帧号说明文字：单源报全片帧号，自动接片报「第几段 · 段内帧号」 */
  function capText(frame, atCut) {
    if (state.chain.on) {
      const at = chainAt(frame);
      if (!at) return "";
      const fps = at.seg.info?.fps || 24;
      return `第${at.i + 1}/${state.chain.segs.length}段 · 第 ${at.local} 帧 · ${fmtSec(at.local / fps)}`
        + (atCut ? " · 切点（这段保留到此帧，新片段从这里接）" : "");
    }
    const fps = curInfo()?.fps || 24;
    return `第 ${frame} 帧 · ${fmtSec(frame / fps)}`
      + (atCut ? " · 切点（源片段保留到此帧，新片段从这里接）" : "");
  }

  function updateView(frame, atCut) {
    if (!hasData()) return;
    const n = totalFrames();
    frame = clamp(Math.round(frame), 0, Math.max(0, n - 1));
    if (state.vFrame === frame && state.vCut === atCut) return;
    state.vFrame = frame;
    state.vCut = atCut;

    /* 自动接片时帧号是全轨的：先换算成「哪一段的第几帧」；
       单源模式下就是源片段本身的第几帧。段变了要换装视频源。 */
    let segVideo = state.video;
    let local = frame;
    let fps = curInfo()?.fps || 24;
    if (state.chain.on) {
      const at = chainAt(frame);
      if (!at) return;
      segVideo = at.seg.video;
      local = at.local;
      fps = at.seg.info?.fps || fps;
    }

    const cur = av();
    if (cur.dataset.v !== segVideo) {
      /* 双视频交替：目标段已预取在另一只上就直接切（零黑帧）；没装就装上
         再切。空出来的那只随后预取下一段，下个边界同样无缝。 */
      const idle = el.videos[1 - state.vA];
      if (idle.dataset.v !== segVideo) {
        idle.dataset.v = segVideo;
        idle.src = `${API}/video?video=${encodeURIComponent(segVideo)}`;
      }
      state.vA = 1 - state.vA;
      av().classList.add("gj-live");
      cur.classList.remove("gj-live");
      state.videoOK = true;
    }
    if (state.videoOK) {
      /* 视频模式：seek 源片段本身，拖红线时画面实时跟手——这就是切点的
         所见即所得。播放中则不抢 seek，让画面自己走（时间轴上的播放头由
         timeupdate 驱动），否则鼠标扫一下时间轴就把播放打得卡卡的。 */
      el.vimg.hidden = true;
      if (av().paused) {
        try {
          const dur = av().duration;
          av().currentTime = dur ? clamp(local / fps, 0, Math.max(0, dur - 0.05)) : 0;
        } catch (err) { /* metadata 未就绪时 loadedmetadata 里会补一次 */ }
      }
    } else {
      /* 图片兜底：浏览器解不动的视频（HEVC 之类）退回抽帧图 */
      el.videos.forEach((v) => v.classList.remove("gj-live"));
      el.vimg.hidden = false;
      el.vimg.src = thumbURL(local, THUMB_PX, segVideo);
    }

    el.vcap.textContent = capText(frame, atCut);
    paintPlay();
    syncFlag();
    prefetchNext();
  }

  /* video 生命周期（双元素轮流上阵，只响应「在岗」那只的事件）：
     metadata 到位后把画面补到当前帧；浏览器放不出来（HEVC 之类）就整体
     退化成抽帧图片，功能不减半。 */
  let autoContinue = false;   // 一段放完 → 换装下一段 → 这里补 seek 并续播
  function onLoadedMeta(e) {
    if (e.target !== av() || state.vFrame < 0 || !hasData()) return;
    let local = state.vFrame;
    let fps = curInfo()?.fps || 24;
    if (state.chain.on) {
      const at = chainAt(state.vFrame);
      if (!at || at.seg.video !== av().dataset.v) return;
      local = at.local;
      fps = at.seg.info?.fps || fps;
    }
    try {
      av().currentTime = Math.min(local / fps, Math.max(0, (av().duration || 0) - 0.05));
    } catch (err) { /* nothing to seek to yet */ }
    if (autoContinue) {
      autoContinue = false;
      Promise.resolve(av().play?.()).catch(() => {});
    }
  }
  function onVideoErr() {
    state.videoOK = false;
    av().classList.remove("gj-live");
  }
  /* 播放中播放头跟着画面走。只挪竖线和帧号，不回头调 currentTime——
     否则就是「seek 触发播放进度、播放进度又触发 seek」的死循环。 */
  function onTimeUpdate(e) {
    if (e.target !== av() || !hasData()) return;
    let f;
    if (state.chain.on) {
      const i = state.chain.segs.findIndex((s) => s.video === av().dataset.v);
      if (i < 0) return;
      const s = state.chain.segs[i];
      const lf = clamp(Math.round((av().currentTime || 0) * (s.info?.fps || 24)),
        0, Math.max(0, (s.info?.total_frames || 1) - 1));
      f = segStart(i) + Math.min(lf, effLen(i) - 1);
    } else {
      f = clamp(Math.round((av().currentTime || 0) * (curInfo()?.fps || 24)),
        0, Math.max(0, totalFrames() - 1));
    }
    if (f !== state.vFrame) {
      state.vFrame = f;
      state.vCut = state.overlap > 0 && f === cutGlobal();
      paintPlay();
      el.vcap.textContent = capText(f, state.vCut);
    }
  }
  /* 点击画面 = 播放 / 暂停。左上角小圆标常显状态：三角=停着，双杠=播放中。
     图片兜底模式（浏览器解不动的视频）没有播放这回事，角标隐藏。 */
  function syncFlag() {
    el.flag.style.display = hasData() && state.videoOK ? "block" : "none";
    el.flag.classList.toggle("gj-run", !!av() && !av().paused);
  }
  /* 跨片段连续播放（剪辑软件同款）：接片模式下一段放完，自动切到下一段
     接着放，直到最后一段播完停住。下一段多半已预取在另一只视频上——
     切过去零黑帧；没预取到就换装后交给 loadedmetadata 续播。 */
  function onEnded() {
    syncFlag();
    if (!state.chain.on) return;
    const i = state.chain.segs.findIndex((s) => s.video === av().dataset.v);
    if (i < 0 || i >= state.chain.segs.length - 1) return;   // 最后一段：停
    autoContinue = true;
    updateView(segStart(i + 1), false);
    if (av().readyState >= 1) {
      autoContinue = false;
      Promise.resolve(av().play?.()).catch(() => {});
    }
  }
  for (const v of el.videos) {
    v.addEventListener("loadedmetadata", onLoadedMeta);
    v.addEventListener("error", onVideoErr);
    v.addEventListener("timeupdate", onTimeUpdate);
    v.addEventListener("play", syncFlag);
    v.addEventListener("pause", syncFlag);
    v.addEventListener("ended", onEnded);
  }

  el.view.addEventListener("click", () => {
    if (!hasData() || !state.videoOK) return;
    autoContinue = false;   // 手动暂停/播放，别和自动续播打架
    if (av().paused) Promise.resolve(av().play?.()).catch(() => {});
    else av().pause();
  });

  /* 预取下一段：当前段一定下来就把下一段装进备班视频，过边界切过去
     已经缓冲好——无黑帧的关键。 */
  function prefetchNext() {
    if (!state.chain.on) return;
    const i = state.chain.segs.findIndex((s) => s.video === av().dataset.v);
    const nxt = state.chain.segs[i + 1];
    if (!nxt) return;
    const idle = el.videos[1 - state.vA];
    if (idle.dataset.v !== nxt.video) {
      idle.dataset.v = nxt.video;
      idle.src = `${API}/video?video=${encodeURIComponent(nxt.video)}`;
    }
  }

  /* ---------- 引用上次片段 ---------- */

  /* 与导演台同名按钮同一件事：把最新生成的成片摆上源时间轴。潜空间续写
     模式下，下一次运行的源视频就是这条最新成片（后端自动承接最新输出），
     所以在这里对它拖切点，切的就是下一次续接的位置。 */
  /* 最高权重源：本节点连着某个「视频合并」的「图像透传」输出时，接片只认
     这个节点的产出——连线即开关，优先级高于历史猜测和目录扫描。工作流里
     有多个合并节点时，这条连线明确指定了「我的上一条成片出自谁」。 */
  function upstreamCombineId() {
    for (const s of node.inputs || []) {
      if (s?.link == null) continue;
      const links = node.graph?.links;
      const link = links instanceof Map ? links.get(s.link) : links?.[s.link];
      if (!link) continue;
      const src = node.graph?.getNodeById?.(link.origin_id);
      if (!src || !/VideoCombine/i.test(src.type || "")) continue;
      const out = src.outputs?.[link.origin_slot];
      if (out && /透传/.test(out.name || "")) return String(src.id);
    }
    return null;
  }

  /* 挑「视频合并」节点最新产出的成片。工作流里可能有多个视频合并节点
     （首段/续接/预览各一个），同一次运行会落好几个文件，按历史顺序挑会
     撞上旧节点——把历史里所有合并产出的文件收集齐，再按文件修改时间取
     最新。onlyId 给定时只认这个节点的产出（图像透传连线的最高权重）。
     历史被重启清空时退回输出目录最新文件（没法按节点认，但至少新）。 */
  /* 本 join 的成片出自谁：从本节点的输出正向遍历下游，收集可达的「视频合并」
     节点。工作流里常有另一个视频合并并联在导演台原始段上（每轮都在本节点
     之前刚落盘）——按 mtime 全局挑最新必然挑中它，成片每轮都被换成本轮
     原始段，之前拼好的段全部丢失（用户报的「缺少片段」）。只认下游可达的
     合并节点，并联的存档编码器就被天然排除。 */
  function downstreamCombineIds() {
    const ids = new Set();
    const graph = node.graph;
    if (!graph?.links) return ids;
    const links = graph.links;
    const getLink = (lid) => (links instanceof Map ? links.get(lid) : links?.[lid]);
    const queue = [];
    for (const out of node.outputs || []) {
      for (const lid of out?.links || []) if (lid != null) queue.push(lid);
    }
    const seenLinks = new Set();
    const seenNodes = new Set([String(node.id)]);
    while (queue.length) {
      const lid = queue.shift();
      if (seenLinks.has(String(lid))) continue;
      seenLinks.add(String(lid));
      const link = getLink(lid);
      if (!link) continue;
      const tid = String(link.target_id);
      if (seenNodes.has(tid)) continue;
      seenNodes.add(tid);
      const tn = graph.getNodeById?.(link.target_id);
      if (!tn) continue;
      if (/VideoCombine/i.test(tn.type || "")) ids.add(tid);
      for (const out of tn.outputs || []) {
        for (const l2 of out?.links || []) if (l2 != null) queue.push(l2);
      }
    }
    return ids;
  }

  async function latestCombineOutput(maxItems, onlyId, onlyIds) {
    const cands = new Set();
    try {
      const res = await api.fetchApi(`/history?max_items=${maxItems || 8}`);
      if (res.ok) {
        const hist = await res.json();
        for (const entry of Object.values(hist || {})) {
          const graph = entry?.prompt?.[2] || {};
          for (const id of Object.keys(graph)) {
            if (!/VideoCombine/i.test(graph[id]?.class_type || "")) continue;
            if (onlyId != null && String(id) !== String(onlyId)) continue;
            if (onlyIds && onlyIds.size && !onlyIds.has(String(id))) continue;
            const outs = entry.outputs?.[id]?.painter_output
              || entry.outputs?.[id]?.gifs
              || entry.outputs?.[id]?.images || [];
            for (const o of outs) {
              if (o?.type === "output" && o.filename) {
                cands.add(o.subfolder ? `${o.subfolder}/${o.filename}` : o.filename);
              }
            }
          }
        }
      }
    } catch (err) { /* 历史拿不到就按目录兜底 */ }
    try {
      const res = await api.fetchApi("/cglide/recent_outputs?limit=30&type=output");
      const list = res.ok ? await res.json() : [];
      let top = null;
      for (const item of list || []) {
        const rel = item.subfolder ? `${item.subfolder}/${item.name}` : item.name;
        if (!top) top = { filename: item.name, subfolder: item.subfolder };
        if (cands.has(rel)) return { filename: item.name, subfolder: item.subfolder };
      }
      if (!cands.size) return top;
    } catch (err) { /* 扫不动目录就算了 */ }
    return null;
  }

  el.btn.addEventListener("click", async () => {
    if (state.chain.on) {
      setMeta("接片中——先点「接片中 · 停止」停止接片，再用引用", true);
      return;
    }
    el.btn.disabled = true;
    try {
      /* 和 chainPoll 同一套优先级：透传连线 > 下游可达合并 > 全局最新 */
      const upId = upstreamCombineId();
      let pick = upId != null ? await latestCombineOutput(8, upId) : null;
      if (!pick) pick = await latestCombineOutput(8, null, downstreamCombineIds());
      if (pick) {
        const v = pick.subfolder ? `${pick.subfolder}/${pick.filename}` : pick.filename;
        /* 必须写回控件：源视频端口已删，执行侧读的就是这个控件——只刷预览
           不写回的话，下一轮 join() 拿到空源会静默直通（不报错、不拼接）。 */
        setWidget("source_video", v);
        refresh(v);
      } else {
        setMeta("没有找到成片——先跑一次生成再引用", true);
      }
    } catch (err) {
      setMeta(`引用失败：${esc(err.message || err)}`, true);
    } finally {
      el.btn.disabled = false;
    }
  });

  /* ---------- 设置行 ---------- */

  /* 值的唯一的家仍是节点控件（保存/加载/后端读取都不变），设置行只是换
     了身好看的衣服：改这里 = 改控件；控件被别处改动 = 这里回显。 */
  function setWidget(name, v) {
    const w = getWidget(node, name);
    if (w) { w.value = v; w.callback?.(v); }
  }

  /* 帧率不给人调：自动取源片段的帧率写回控件，「音频对齐」才裁得准 */
  function syncFps() {
    const info = curInfo();
    if (!info?.fps) return;
    const v = Math.round(info.fps * 1000) / 1000;
    if (Math.abs((+getWidget(node, "fps")?.value || 0) - v) > 0.0005) setWidget("fps", v);
    el.fpsChip.textContent = `${v} · 自动`;
  }

  function syncSettings() {
    const sm = String(getWidget(node, "seam_mode")?.value ?? "");
    el.seg.querySelectorAll("button[data-v]").forEach((b) => b.classList.toggle("gj-act", b.dataset.v === sm));
    el.blendV.textContent = clamp(Math.round(+getWidget(node, "seam_blend_frames")?.value || 1), 1, 64);
    el.blend.dataset.off = sm === "S 渐变切" ? "0" : "1";
    root.querySelectorAll(".gj-sw input[data-w]").forEach((cb) => {
      const wv = getWidget(node, cb.dataset.w)?.value;
      cb.checked = wv === true || wv === 1 || wv === "true";
    });
    if (document.activeElement !== el.path) el.path.value = state.video;
    syncFps();
    /* 空源直通提示：控件没值时执行侧会原样直通（不拼接），必须让人看见 */
    el.pass.hidden = !!String(getWidget(node, "source_video")?.value ?? "").trim();
  }

  el.seg.addEventListener("click", (e) => {
    const b = e.target?.closest?.("button[data-v]");
    if (!b) return;
    setWidget("seam_mode", b.dataset.v);
    syncSettings();
  });

  el.blend.addEventListener("click", (e) => {
    const b = e.target?.closest?.("button[data-d]");
    if (!b) return;
    const w = getWidget(node, "seam_blend_frames");
    setWidget("seam_blend_frames", clamp(Math.round(+w?.value || 1) + Number(b.dataset.d), 1, 64));
    syncSettings();
  });

  root.querySelectorAll(".gj-sw input[data-w]").forEach((cb) => {
    cb.addEventListener("change", () => setWidget(cb.dataset.w, cb.checked));
  });

  /* 手填源路径：输入时只记账不刷新（半截路径会乱读盘），回车/失焦才加载 */
  el.path.addEventListener("input", () => {
    state.typingPath = true;
    setWidget("source_video", el.path.value);
  });
  el.path.addEventListener("change", () => {
    state.typingPath = false;
    if (!state.chain.on) refresh(el.path.value.trim());
  });
  el.path.addEventListener("blur", () => { state.typingPath = false; });

  /* ---------- 自动接片 ---------- */

  /* 开着这个开关，面板盯着「视频合并节点新产出的成片」：一轮生成跑完，
     新成片自动接到时间轴已有素材的后面，并写进源视频控件——下一轮 join
     拿它当源片继续拼，片子一轮轮长下去；切点红线自动锚到最新一段。
     再点一次停止接片，已接的留在时间轴上；重新开启接着往下接。
     之前盯 /last_source 是鸡生蛋：那值只有 join 带着源片跑过一次才有，
     链永远无法自举，第一次开启必然空转直通。 */

  const chainBusy = new Set();   // 正在读取的成片，防止两轮轮询重复收同一段
  let chainTimer = null;

  const segKey = (p) => String(p).replace(/\\/g, "/");

  /* 接片链持久化：路径列表 + 接片开关一起存进节点 properties，随工作流
     保存/载入。只存路径不存开关的话，载入时分不清「接片中保存」还是
     「停止后保存」，一概强制续接——停止接片重启后就会自己复活。
     info 和波形不存——载入时按路径重新读，链的账面（顺序与条数）才是要保的。 */
  function saveChain() {
    try {
      if (node.properties) {
        node.properties["bz_join_chain"] = {
          on: state.chain.on,
          /* 每轮存的是「候选池 + 当前选中哪个」——重抽出来的旧版本要能
             跟着工作流一起保存，重启后照样切得回去。 */
          segs: state.chain.segs.map((s) => ({
            alts: s.alts.map((a) => a.video),
            alt: s.alt || 0,
          })),
        };
      }
    } catch (err) { /* 存不下就算了，链还在内存里 */ }
  }

  const lastSeg = () => state.chain.segs[state.chain.segs.length - 1];

  /* 按候选池恢复一轮：逐个读 info（读不动的候选跳过），选中存档里那个 */
  async function restoreSeg(videos, alt) {
    const seg = { video: "", info: null, wave: null, key: "", alts: [], alt: 0 };
    for (const v of videos) {
      if (typeof v !== "string" || !v) continue;
      try {
        const info = await loadInfo(v);
        seg.alts.push({ video: v, info, key: `${segKey(v)}@${info.mtime ?? ""}` });
      } catch (err) { /* 这条候选没了就跳过 */ }
    }
    if (!seg.alts.length) return null;
    seg.alt = clamp(alt, 0, seg.alts.length - 1);
    applyAlt(seg);
    return seg;
  }

  function chainMeta() {
    const dur = state.chain.segs.reduce((a, s) => a + (s.info?.duration || 0), 0);
    setMeta(`接片中 · 已接 ${state.chain.segs.length} 段 · 共 ${chainN()} 帧 · ${fmtSec(dur)}`);
    syncFps();
  }

  /* 收一段：读 info 成功才算收进来（保证几何信息齐全），波形异步补。
     key = 路径@mtime：同名覆盖的成片 mtime 变了照样接得上；不传就现场算。 */
  async function appendSeg(video, key) {
    const vkey = segKey(video);
    if (chainBusy.has(vkey)) return false;
    chainBusy.add(vkey);
    try {
      const info = await loadInfo(video);
      if (state.dead) return false;
      const k = key || `${segKey(video)}@${info.mtime ?? ""}`;
      if (state.chain.segs.some((s) => s.key === k)) return false;
      /* alts 是这一轮的候选池：第一个候选就是刚接进来的这条，重抽时往
         池子里再加，旧的一直留着——「还是上一版好」随时能切回去。 */
      const seg = { video, info, wave: null, key: k,
        alts: [{ video, info, key: k }], alt: 0 };
      state.chain.segs.push(seg);
      saveChain();
      if (info.has_audio) {
        loadWave(video).then((w) => {
          seg.wave = w;
          if (state.chain.on) drawWave();
        }).catch(() => { /* 这段没波形，画面照样接 */ });
      }
      return true;
    } catch (err) {
      return false;      // 读不动的文件直接跳过，不挡后面的
    } finally {
      chainBusy.delete(vkey);
    }
  }

  /* ---------- 重抽与版本 ---------- */

  /* 选中某个候选：段的对外身份（video/info/key）就是这个候选的，几何、
     缩略图、波形全跟着它走。 */
  function applyAlt(seg) {
    const a = seg.alts[seg.alt] || seg.alts[0];
    seg.video = a.video;
    seg.info = a.info;
    seg.key = a.key;
    seg.wave = null;
  }

  function loadSegWave(seg) {
    if (!seg?.info?.has_audio) return;
    loadWave(seg.video).then((w) => {
      if (seg.wave === null && state.chain.segs.includes(seg)) seg.wave = w;
      if (state.chain.on) drawWave();
    }).catch(() => { /* 这段没波形，画面照样接 */ });
  }

  /* 重抽对位：新成片不是「新的一段」，而是第 i 轮的一个新版本——加进
     候选池并选中，旧版本留在池子里。 */
  async function rerollSeg(i, video) {
    const vkey = segKey(video);
    if (chainBusy.has(vkey)) return false;
    chainBusy.add(vkey);
    try {
      const info = await loadInfo(video);
      if (state.dead) return false;
      const seg = state.chain.segs[i];
      if (!seg) return false;
      const k = `${segKey(video)}@${info.mtime ?? ""}`;
      if (seg.alts.some((a) => a.key === k)) return false;   // 同一条片不重复收
      seg.alts.push({ video, info, key: k });
      seg.alt = seg.alts.length - 1;
      applyAlt(seg);
      saveChain();
      loadSegWave(seg);
      return true;
    } catch (err) {
      return false;
    } finally {
      chainBusy.delete(vkey);
    }
  }

  /* 点「重抽本段」：源片回退到上一段的成片，之后每跑完一轮，新成片就
     对位替换当前这一轮，一轮轮往下推，直到最后一段跑完自动收尾。 */
  function startReroll(i) {
    if (!state.chain.on) {
      setMeta("先开启自动接片：重抽出来的成片要靠它自动收进来并对位", true);
      return;
    }
    state.reroll = i;
    const prev = i > 0 ? state.chain.segs[i - 1] : null;
    setWidget("source_video", prev ? prev.video : "");
    setMeta(prev
      ? `重抽第 ${i + 1} 段：源片已设为第 ${i} 段的成片——跑完一轮，新成片作为这一段的新版本收进来，之后每段依次重跑`
      : `重抽第 1 段：源片已清空——跑完一轮就从零重来，之后每段依次重跑`, true);
  }

  async function useAlt(i, idx) {
    const seg = state.chain.segs[i];
    if (!seg) return;
    seg.alt = clamp(idx, 0, seg.alts.length - 1);
    applyAlt(seg);
    saveChain();
    loadSegWave(seg);
    buildThumbs();
    drawWave();
    paint();
    chainMeta();
    syncSegAct();
    markSel();
    /* 源片跟住链尾：继续跑就接在最后一段后面 */
    const tail = lastSeg();
    if (tail && !state.typingPath) setWidget("source_video", tail.video);
  }

  function pickSeg(i) {
    state.pick = (state.pick === i) ? -1 : i;
    syncSegAct();
    markSel();
  }

  function markSel() {
    el.vtrack.querySelectorAll(".gjoin-segbar").forEach((b) => {
      b.classList.toggle("gj-sel", Number(b.dataset.i) === state.pick);
    });
  }

  function syncSegAct() {
    const seg = state.pick >= 0 ? state.chain.segs[state.pick] : null;
    el.segact.style.display = seg ? "flex" : "none";
    if (!seg) return;
    el.segLabel.textContent = `第 ${state.pick + 1} 段`;
    el.segVer.textContent = `版本 ${(seg.alt || 0) + 1}/${seg.alts.length}`;
  }

  el.segact.addEventListener("click", (e) => {
    const seg = state.chain.segs[state.pick];
    if (!seg) return;
    const step = e.target?.closest?.("button[data-d]");
    if (step) {
      useAlt(state.pick, (seg.alt || 0) + Number(step.dataset.d));
      return;
    }
    if (e.target?.closest?.(".gj-rr")) { startReroll(state.pick); return; }
    if (e.target?.closest?.(".gj-px")) { state.pick = -1; syncSegAct(); markSel(); }
  });

  async function chainPoll() {
    if (state.dead || !state.chain.on) return;
    try {
      /* 图像透传连线在 → 只认那个合并节点的产出（最高权重）；没连 → 只认
         本 join 下游可达的合并节点——工作流里常有另一个视频合并并联在导
         演台原始段上，每轮都在本节点之前刚落盘、mtime 永远最新，全局挑
         最新必然挑中它，成片每轮被换成本轮原始段，之前拼好的段全丢（用
         户报的「缺少片段」）。下游没接成片文件端口时集合为空，自动退回
         全局挑最新，老工作流行为不变。 */
      const upId = upstreamCombineId();
      const downIds = downstreamCombineIds();
      let pick = upId != null ? await latestCombineOutput(6, upId) : null;
      if (!pick) pick = await latestCombineOutput(6, null, downIds);
      if (!pick) return;                    // 历史和输出目录里都没有成片
      const v = pick.subfolder ? `${pick.subfolder}/${pick.filename}` : pick.filename;
      /* 重抽中：这条成片对位替换「正在重跑的那一轮」，不是新的一段 */
      if (state.reroll != null && state.reroll < state.chain.segs.length) {
        const i = state.reroll;
        if (await rerollSeg(i, v)) {
          state.reroll = i + 1 < state.chain.segs.length ? i + 1 : null;
          buildThumbs();
          drawWave();
          paint();
          chainMeta();
          syncSegAct();
          const seg = state.chain.segs[i];
          setMeta(state.reroll == null
            ? `第 ${i + 1} 段已换成版本 ${seg.alt + 1}/${seg.alts.length} · 重抽完成`
            : `第 ${i + 1} 段已换成版本 ${seg.alt + 1}/${seg.alts.length} · 源片已跟上，接着跑第 ${state.reroll + 1} 段`,
            true);
        }
        return;
      }
      if (await appendSeg(v)) {
        buildThumbs();
        paint();                            // 切点红线自动跟到新末段
        chainMeta();
      }
      /* 接片开着，源视频控件就跟住链尾「当前选中的那个版本」——哪怕这条
         片已经在链上（去重不重复接），控件也得写：重启后链是恢复的、控件
         却可能是空的，不写的话下一轮 join 照样空源直通。跟的是链尾而不是
         磁盘上最新的成片，切回旧版本后才不会被更新的那条盖回去。 */
      const tailV = lastSeg()?.video || v;
      if (!state.typingPath && getWidget(node, "source_video")?.value !== tailV) {
        setWidget("source_video", tailV);
      }
    } catch (err) { /* 暂时拿不到就等下一轮 */ }
  }

  /* 载入工作流时把存过的接片链摆回时间轴：开关是开就恢复成接片中继续
     往下接，是停就只把素材摆上时间轴、接片保持停——不再自作主张复活。
     去重按 路径@mtime，已接过的不会重复。旧版存的裸路径数组没有开关
     信息，一律按「停着」恢复（旧版行为正是用户抱怨的自动开启）。 */
  async function restoreChain(list) {
    const obj = Array.isArray(list) ? { on: false, segs: list } : list;
    if (!obj || !Array.isArray(obj.segs) || !obj.segs.length) return;
    if (state.chain.segs.length) return;
    for (const item of obj.segs) {
      /* 三种存档都认：裸路径（最老）、{on,segs:[路径]}、{on,segs:[{alts,alt}]} */
      const videos = typeof item === "string" ? [item] : (item?.alts || []);
      const alt = typeof item === "string" ? 0 : (item?.alt || 0);
      const seg = await restoreSeg(videos, alt);
      if (seg) {
        state.chain.segs.push(seg);
        loadSegWave(seg);
      }
    }
    if (!state.chain.segs.length) return;
    /* 开关先定，再画：buildThumbs 按「接片中/单源」走两条分支，chain.on
       还没设成 true 就去画，会拿单源的空信息画出一条空时间轴。 */
    if (obj.on) {
      state.chain.on = true;
      el.chain.classList.add("gj-on");
      el.chain.textContent = "接片中 · 停止";
      el.title.textContent = "🎞 接片链";
    }
    buildThumbs();
    drawWave();
    paint();
    if (obj.on) {
      chainTimer = setInterval(chainPoll, 3000);
      chainMeta();
    } else {
      if (state.video && state.info) setMeta(srcMeta(state.video, state.info));
      else setMeta("已停止接片。点「引用上次片段」回到单源时间轴");
    }
    saveChain();   // 归一化落盘，顺带把旧数组格式升级成新格式
  }

  el.chain.addEventListener("click", async () => {
    state.chain.on = !state.chain.on;
    el.chain.classList.toggle("gj-on", state.chain.on);
    el.chain.textContent = state.chain.on ? "接片中 · 停止" : "自动接片";
    el.title.textContent = state.chain.on ? "🎞 接片链" : "🎞 源片段";
    if (state.chain.on) {
      if (!state.chain.segs.length) {
        /* 刚开启先把端口里已有的这条收进来，时间轴不至于空着 */
        await chainPoll();
      }
      chainTimer = setInterval(chainPoll, 3000);
      buildThumbs();
      drawWave();
      paint();
      if (state.chain.segs.length) chainMeta();
      else setMeta("自动接片已开启——跑完一轮生成，新成片会自动接进来并作为下一轮的源片", true);
    } else {
      clearInterval(chainTimer);
      chainTimer = null;
      state.reroll = null;   // 停止接片 = 放弃还没跑完的重抽队列
      state.pick = -1;       // 段操作行收起（单源时间轴上没有「第几段」）
      syncSegAct();
      el.bub.style.display = "none";
      buildThumbs();
      drawWave();
      paint();
      if (state.video && state.info) setMeta(srcMeta(state.video, state.info));
      else setMeta("已停止接片。点「引用上次片段」回到单源时间轴");
    }
    saveChain();   // 开/停都要落盘：重启后按此刻的开关状态恢复
  });

  /* 一键清空：接片先停、素材全部下架，接片链和源视频一并归零——
     恢复到空白时间轴，之后引用/接片/手填路径随便重来。 */
  el.clear.addEventListener("click", () => {
    if (state.chain.on) {
      state.chain.on = false;
      clearInterval(chainTimer);
      chainTimer = null;
      el.chain.classList.remove("gj-on");
      el.chain.textContent = "自动接片";
      el.title.textContent = "🎞 源片段";
    }
    el.bub.style.display = "none";
    state.chain.segs = [];
    state.pick = -1;                // 选中的段和待重跑的队列一并归零
    state.reroll = null;
    syncSegAct();
    saveChain();                    // properties 里的链也清掉，重开工作流不会复活
    setWidget("source_video", "");  // 源片归零：空源直通提示会亮起来提醒
    refresh("");
  });

  /* ---------- pointer ---------- */

  function bandX(e) {
    const rect = el.band.getBoundingClientRect();
    return clamp(e.clientX - rect.left, 0, rect.width);
  }

  /* 气泡跟着鼠标走，说的是「鼠标底下这一帧」；拖切点时改说重叠信息 */
  function showBub(layoutX, text) {
    el.bub.style.display = "block";
    el.bub.style.left = `${clamp(layoutX, 30, Math.max(30, bandLayoutW() - 30))}px`;
    el.bub.textContent = text;
  }

  el.band.addEventListener("pointerdown", (e) => {
    if (!hasData()) return;
    const x = bandX(e);
    const cutX = frameToX(cutGlobal());
    const onHandle = Math.abs(viewToLayout(x) - cutX) <= DRAG_GRAB;
    const inOver = viewToLayout(x) >= cutX;
    if (!onHandle && !inOver) {
      /* 空白处按下：播放头跳到该帧，按住可拖动搓动预览（剪辑软件同款） */
      state.scrub = true;
      el.band.classList.add("gj-drag");
      el.band.setPointerCapture(e.pointerId);
      updateView(xToFrame(x), false);
      e.preventDefault();
      return;
    }
    if (ovLinked()) {
      /* 重叠帧接了线：红线只看不可拖，按住当作在切点上搓动 */
      state.scrub = true;
      el.band.classList.add("gj-drag");
      el.band.setPointerCapture(e.pointerId);
      updateView(cutGlobal(), true);
      e.preventDefault();
      return;
    }
    state.drag = true;
    el.band.classList.add("gj-drag");
    el.band.setPointerCapture(e.pointerId);
    updateView(cutGlobal(), true);
    e.preventDefault();
  });

  el.band.addEventListener("pointermove", (e) => {
    if (!hasData()) return;
    const vx = bandX(e);              // 可视像素（来自 rect）
    const lx = viewToLayout(vx);      // 布局像素（DOM 定位用）
    const gf = xToFrame(vx);
    if (state.drag) {
      /* 拖切点只改「将被续接的那条片段」的重叠：自动接片时换算回末段帧号 */
      const local = state.chain.on ? gf - segStart(state.chain.segs.length - 1) : gf;
      writeOverlap((state.chain.on ? (lastSeg()?.info?.total_frames || 0) : totalFrames()) - local);
      /* paint() 已把取景器带到新切点，气泡改说重叠 */
      const fps = curInfo()?.fps || 24;
      showBub(lx, `重叠 ${state.overlap}帧 (${fmtSec(state.overlap / fps)}) · 保留至 第${cutGlobal()}帧`);
      return;
    }
    /* 搓动中或悬停中：取景器和播放头都跟手 */
    updateView(gf, false);
    el.band.classList.toggle("gj-near", Math.abs(lx - frameToX(cutGlobal())) <= DRAG_GRAB);
    showBub(lx, capText(gf, false));
  });

  const endDrag = () => {
    if (!state.drag && !state.scrub) return;
    state.drag = false;
    state.scrub = false;
    el.band.classList.remove("gj-drag");
  };
  el.band.addEventListener("pointerup", endDrag);
  el.band.addEventListener("pointercancel", endDrag);
  /* 指针离开时间带：取景器回到切点上，不留在刚扫过的某一帧，气泡收起。
     搓动中不算离开（指针已被捕获，松手才算结束）。 */
  el.band.addEventListener("pointerleave", () => {
    el.bub.style.display = "none";
    el.band.classList.remove("gj-near");
    if (!state.drag && !state.scrub) paint();
  });

  /* ---------- last_source ---------- */

  /* 源视频输入接了线（导演台供值），widget 里没有静态值；执行侧在 join()
     时把真实路径记了下来，这里去问。跑一次之后面板就有画面了。 */
  async function loadLastSource() {
    if (state.dead || state.chain.on) return;   // 自动接片时显示权归链，不让单源刷新打岔
    try {
      const res = await api.fetchApi(`${API}/last_source`);
      if (!res.ok) return;
      const d = await res.json();
      const v = (d.source || "").trim();
      if (v && v !== state.video) {
        refresh(v);
      } else if (!v && state.video) {
        refresh("");            // 本次按普通生成跑的（没有源），面板随之清空
      }
    } catch (err) {
      /* 面板不是关键路径，拿不到就算了 */
    }
  }

  /* ---------- lifecycle ---------- */

  /* 本节点一跑完就把成片换成本次的输出。下游的 Video Combine 还要先把文件
     写完，所以等一下再去查目录，否则拿到的还是上一次的文件。 */
  const onExecuted = (e) => {
    const id = e?.detail?.node;
    if (String(id) !== String(node.id)) {
      /* 下游「视频合并」存完成片也会触发：接片模式下等它落盘就接，
         不用等 3 秒轮询。 */
      const t = app.graph?.getNodeById?.(id)?.type || "";
      if (!state.chain.on || !/VideoCombine/i.test(t)) return;
    }
    /* last_source 是执行时记的；下游 Video Combine 写完文件要一会儿，
       但源视频的路径此刻已确定，立刻刷新即可。自动接片模式则立刻接一次。 */
    setTimeout(() => {
      if (state.chain.on) chainPoll();
      else loadLastSource();
    }, 1500);
  };
  api.addEventListener("executed", onExecuted);
  loadLastSource();

  const ro = new ResizeObserver(() => {
    if (state.dead) return;
    buildThumbs();
    drawWave();
    paint();
  });
  ro.observe(root);

  /* 节点在不在画布可视区内（同视频合并节点 isNodeVisible 的口径）。
     视口外暂停轮询刷新：面板看不见时刷了也白刷，滚回来下一跳就恢复。 */
  function nodeVisible() {
    const canvas = app.canvas;
    if (!canvas?.ds || !node.pos || !node.size) return true;
    const { scale, offset } = canvas.ds;
    const x = (node.pos[0] + offset[0]) * scale;
    const y = (node.pos[1] + offset[1]) * scale;
    const cw = canvas.canvas?.clientWidth || window.innerWidth;
    const ch = canvas.canvas?.clientHeight || window.innerHeight;
    return x + node.size[0] * scale > 0 && y + node.size[1] * scale > 0
      && x < cw && y < ch;
  }

  const poll = setInterval(() => {
    if (state.dead || !nodeVisible()) return;
    /* 只在控件真有值（手填路径 / 引用上次片段写回）且变化时才刷新；
       控件为空说明还没选定源片段，不能拿它清面板——自动接片模式下
       面板显示的是接片链。 */
    const w = getWidget(node, "source_video");
    const v = (w?.value || "").trim();
    if (!state.typingPath && v && v !== state.video && !state.chain.on) refresh(v);
    else syncFromWidgets();
    syncSettings();       // 控件被别处改动（加载工程等）时设置行跟着回显
  }, POLL_MS);

  const prevRemoved = node.onRemoved;
  node.onRemoved = function () {
    state.dead = true;
    clearInterval(poll);
    clearInterval(chainTimer);
    ro.disconnect();
    api.removeEventListener("executed", onExecuted);
    return prevRemoved?.apply(this, arguments);
  };

  function minH() {
    /* 紧凑下限：取景器压到 90px、参数行折一行时，底部提示行仍露得出来
       （bar+取景器+时间带+设置行+提示行+间距）。上限不设——节点拉多高，
       取景器就吃多高（弹性分支分摊）。 */
    return 316;
  }

  return { root, minH, restoreChain };
}

/* ------------------------------------------------------------ register */

app.registerExtension({
  name: "Banzhang.CSGlideJoinPanel",

  beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== NODE_ID) return;

    const onCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = onCreated?.apply(this, arguments);

      const panel = buildPanel(this);
      this._bz_join_panel = panel;   // onConfigure 恢复接片链时要用
      hideParamWidgets(this);     // 画布参数收进面板设置行
      syncInputPorts(this);       // 端口只留 3 个：续接片段/音频/重叠帧
      const w = this.addDOMWidget("gjoin_panel", "div", panel.root, {
        serialize: false, hideOnZoom: false,
      });
      /* 同视频合并节点的布局契约（painter_video）：只报 computeLayoutSize，
         minHeight/maxHeight 都报常量——官方弹性分支在空间富余时把剩余高度
         分摊给本面板（内容跟随节点框变大），空间不足时给 minHeight 并把
         节点自动撑高。minWidth 报 0：官方拖拽拿 computeSize() 当尺寸下限，
         会把 widget 的 minWidth 累加进去，报「当前宽度」会让节点一拖就
         暴涨（视频合并节点踩过的坑），报 0 下限才是死的。 */
      w.computeLayoutSize = () => ({ minHeight: panel.minH(), maxHeight: 1e6, minWidth: 0, maxWidth: 1e6 });

      requestAnimationFrame(() => {
        const wrap = panel.root.parentElement;
        if (wrap && wrap.classList.contains("dom-widget")) wrap.style.pointerEvents = "none";
      });

      /* 面板排在「源视频」输入框之前——也就是显示在它上方：先看画面定切点，
         再往下填路径，视线不用在节点上来回跳。 */
      const idx = this.widgets.findIndex((x) => x.name === "source_video");
      if (idx >= 0) {
        const item = this.widgets.splice(this.widgets.indexOf(w), 1)[0];
        this.widgets.splice(idx, 0, item);
      }

      const size = this.computeSize();
      this.setSize?.([Math.max(size[0], MIN_WIDTH), size[1] + 8]);
      return r;
    };

    /* 加载老工程时对齐端口（新节点本来就对，兜底重跑一次）。必须放在基类
       configure 之后——端口和控件值都是那一步才灌进节点的。 */
    const onConfigure0 = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function (info) {
      const r = onConfigure0?.apply(this, arguments);
      try { hideParamWidgets(this); } catch (err) { /* 折叠不了就折不了，不影响加载 */ }
      try { syncInputPorts(this); } catch (err) { /* 排不上就保持原样，不影响加载 */ }
      try { sanitizeWidgets(this, info); } catch (err) { /* 同上 */ }
      try { this._bz_join_panel?.restoreChain(this.properties?.bz_join_chain); }
      catch (err) { /* 链恢复不了就当没存过，不影响加载 */ }
      return r;
    };
  },
});
