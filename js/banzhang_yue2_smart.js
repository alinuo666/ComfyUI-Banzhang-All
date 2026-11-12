// 🎼 BanzhangYuE2SmartPlan —— YuE2 智能乐谱中枢 · 苹果风自适应面板
// 对齐 js/banzhang_lora_loader.js 的「单一配置 JSON」模式：
//   面板全部状态存 node._bzYue2State → 序列化进隐藏 config widget（框架自动持久化）；
//   内部状态不占对外端口，左侧只暴露 style/lyrics/clip/audio_encoder/reference_audio。
// ⚠️ 严禁把面板状态挂在 node._state / node.properties 等 litegraph 内部字段上：
//   LGraphNode 的 _state 装着 properties / inputs / outputs / flags / order，
//   properties 只是它的取值器（get properties(){return this._state.properties}）。
//   一旦被我们的配置对象覆盖，node.properties 就变 undefined，
//   刷新重载时 LGraphNode.configure 执行 this.properties['Node name for S&R'] = ...
//   会抛 “Cannot set properties of undefined”，整个工作流加载被中止。
// 挂载 / 高度贴合照抄 lora：DOM 移到 widgets 最前 + 双通道声明 + 同步测量 +
// ResizeObserver/rAF/60/300 多轮收敛。
import { app } from "../../scripts/app.js";

const PANEL_MARGIN = 4;
const BOTTOM_PAD = 8;
const NODE_NAME = "BanzhangYuE2SmartPlan";
const PROP_KEY = "banzhang_yue2_smart";

const COL = { blue: "#0A84FF", green: "#30D158", orange: "#FF9F0A", gray: "#8e8e93" };
const FONT = "'SF Pro Text',-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif";
const MONO = "ui-monospace,'SF Mono',Consolas,'Courier New',monospace";

// 面板状态默认值（与后端 DEFAULT_CONFIG 同构）
const DEFAULT_STATE = {
  plan_mode: "smart",
  seed: 0,
  max_abc_tokens: 8192,
  abc_temperature: 0.7,
  abc_top_p: 0.9,
  abc_top_k: 30,
  repetition_penalty: 1.005,
  penalty_window: 100,
  cover_transcribe_mode: "melody",
  style: "",
  lyrics: "",
  manual_abc: "",
};

// 常显、紧凑的高级参数：[key, 短标签, 是否带随机按钮]
const ADV_ROWS = [
  ["seed", "种子", true],
  ["max_abc_tokens", "ABC上限", false],
  ["abc_temperature", "温度", false],
  ["abc_top_p", "top_p", false],
  ["abc_top_k", "top_k", false],
  ["repetition_penalty", "重复惩罚", false],
  ["penalty_window", "惩罚窗口", false],
];

const gw = (node, name) => node.widgets?.find((x) => x.name === name);
const linked = (node, name) => {
  const slot = node.inputs?.find((x) => x.name === name);
  return !!slot?.link;
};

// —— 状态 → 隐藏 config widget + properties（双写持久化）——
function syncConfig(node) {
  const json = JSON.stringify(node._bzYue2State || DEFAULT_STATE);
  const w = gw(node, "config");
  if (w) w.value = json;
  if (node.properties) node.properties[PROP_KEY] = json;
}

// 面板控件改值：更新 state → 写 config
function update(node, key, value) {
  node._bzYue2State[key] = value;
  syncConfig(node);
}

// —— 恢复 state：properties 优先 → config widget 兜底 ——
function restoreState(node) {
  let raw = node.properties?.[PROP_KEY];
  if (!raw) raw = gw(node, "config")?.value;
  let parsed = null;
  try { parsed = JSON.parse(raw); } catch (e) { /* 脏数据走默认 */ }
  node._bzYue2State = {
    ...DEFAULT_STATE,
    ...(parsed && typeof parsed === "object" ? parsed : {}),
  };
}

// ==============================================================================
// 高度贴合（照抄 lora）
// ==============================================================================
function declareWidgetHeight(node) {
  const w = node._panelDomW;
  if (!w) return;
  const pad = 2 * (w.margin ?? PANEL_MARGIN) - 4;
  w.computeSize = () => [node.size[0], node._panelHeight + pad];
  w.computeLayoutSize = () => ({
    minHeight: node._panelHeight + pad,
    maxHeight: node._panelHeight + pad,
    minWidth: 0,
  });
}

// 度量面板「真实内容高度」——不读 root.offsetHeight：
// ComfyUI v2 会给 DOM widget 容器固定高度（甚至给 root 套 height:100%），
// 此时 root.offsetHeight 被容器钉死，溢出的子区块量不到，节点不会撑高。
// 改为遍历直接子区块，用 offsetTop+offsetHeight（布局像素，不受画布缩放影响，
// 且天然处理 margin 折叠）求最底部，再加 root 下内边距。
// 前提：root 必须 position:relative，使直接子区块的 offsetParent 指向 root。
function measurePanelHeight(root) {
  if (!root) return 0;
  if (!root.children.length) return root.offsetHeight || 0;
  const cs = getComputedStyle(root);
  const pb = parseFloat(cs.paddingBottom) || 0;
  let bottom = 0;
  for (const el of root.children) {
    if (el.offsetWidth === 0 && el.offsetHeight === 0) continue; // 隐藏区块
    bottom = Math.max(bottom, el.offsetTop + el.offsetHeight);
  }
  return Math.ceil(bottom + pb);
}

function fitNodeHeight(node) {
  const root = node._panelRoot;
  const w = node._panelDomW;
  if (!root || !w) return;
  const h = measurePanelHeight(root);
  if (h) node._panelHeight = h;
  declareWidgetHeight(node);

  let cs = [0, 0];
  try { cs = node.computeSize() || [0, 0]; } catch (e) { /* 下轮再试 */ }

  const m = w.margin ?? PANEL_MARGIN;
  const byDom = (w.y || 0) + m + node._panelHeight + m + BOTTOM_PAD;
  const needH = Math.ceil(Math.max(cs[1] || 0, byDom));
  const needW = Math.max(cs[0] || 0, node.size?.[0] || 0, 360);

  if (Math.abs((node.size?.[1] || 0) - needH) > 2 || needW > (node.size?.[0] || 0)) {
    node.setSize([needW, needH]);
    node.setDirtyCanvas(true, true);
  }
}

function scheduleFit(node) {
  fitNodeHeight(node);
  if (typeof requestAnimationFrame === "function") {
    requestAnimationFrame(() => fitNodeHeight(node));
  }
  if (typeof setTimeout === "function") {
    setTimeout(() => fitNodeHeight(node), 60);
    setTimeout(() => fitNodeHeight(node), 300);
  }
}

// ==============================================================================
// UI 基础件（全部绑定 node._bzYue2State）
// ==============================================================================
function makeBoundTextArea(node, key, minH, placeholder, mono) {
  const ta = document.createElement("textarea");
  ta.spellcheck = false;
  ta.style.cssText =
    "display:block;width:calc(100% - 18px);box-sizing:border-box;margin:7px 9px 9px;" +
    "min-height:" + minH + "px;resize:vertical;background:rgba(0,0,0,.28);border:1px solid " +
    "rgba(255,255,255,.09);border-radius:8px;color:#e8e8ed;font-size:11px;line-height:1.55;" +
    "padding:7px 9px;outline:none;font-family:" + (mono ? MONO : FONT) +
    ";transition:border-color .18s,box-shadow .18s,opacity .18s;";
  ta.placeholder = placeholder;
  ta.value = node._bzYue2State[key] ?? "";
  ta.addEventListener("focus", () => {
    ta.style.borderColor = "rgba(10,132,255,.5)";
    ta.style.boxShadow = "0 0 0 3px rgba(10,132,255,.16)";
  });
  ta.addEventListener("blur", () => {
    ta.style.borderColor = "rgba(255,255,255,.09)";
    ta.style.boxShadow = "none";
  });
  ta.addEventListener("input", () => update(node, key, ta.value));
  return ta;
}

function makeCard(title, ta) {
  const card = document.createElement("div");
  card.style.cssText =
    "background:rgba(255,255,255,.045);border:1px solid rgba(255,255,255,.08);" +
    "border-radius:10px;margin-bottom:8px;";
  const head = document.createElement("div");
  head.style.cssText =
    "display:flex;align-items:center;justify-content:space-between;padding:8px 11px 0;";
  const t = document.createElement("span");
  t.textContent = title;
  t.style.cssText = "font-size:11px;font-weight:600;color:#8e8e93;";
  head.appendChild(t);
  card.append(head, ta);
  return card;
}

// 紧凑参数行：label 左、窄输入框右（两列网格内统一结构，常显不折叠）
function makeCompactRow(node, key, labelText, withDice) {
  const row = document.createElement("div");
  row.style.cssText = "display:flex;align-items:center;gap:6px;min-width:0;";
  const lab = document.createElement("span");
  lab.textContent = labelText;
  lab.style.cssText =
    "flex:1;min-width:0;font-size:10.5px;color:#a8a8b0;white-space:nowrap;" +
    "overflow:hidden;text-overflow:ellipsis;";
  const inp = document.createElement("input");
  inp.type = "number";
  inp.value = node._bzYue2State[key];
  inp.style.cssText =
    "width:54px;flex:none;box-sizing:border-box;background:rgba(0,0,0,.32);" +
    "border:1px solid rgba(255,255,255,.1);border-radius:6px;color:#eee;" +
    "font-size:11px;padding:3px 5px;text-align:right;outline:none;font-family:inherit;";
  inp.addEventListener("focus", () => { inp.style.borderColor = COL.blue; });
  inp.addEventListener("blur", () => { inp.style.borderColor = "rgba(255,255,255,.1)"; });
  inp.addEventListener("input", () => {
    const num = Number(inp.value);
    if (!Number.isNaN(num)) update(node, key, num);
  });
  row.append(lab, inp);
  if (withDice) {
    const dice = document.createElement("button");
    dice.textContent = "🎲";
    dice.title = "随机种子";
    dice.style.cssText =
      "flex:none;width:22px;height:22px;padding:0;line-height:1;border:1px solid " +
      "rgba(255,255,255,.1);background:rgba(255,255,255,.04);border-radius:6px;" +
      "cursor:pointer;font-size:11px;";
    dice.addEventListener("click", (e) => {
      e.stopPropagation();
      update(node, "seed", Math.floor(Math.random() * 0xffffffffffffffff));
      inp.value = node._bzYue2State.seed;
    });
    row.append(dice);
  }
  return { row, inp };
}

// ==============================================================================
// UI 构建
// ==============================================================================
function buildUI(node) {
  const ui = {};
  const root = document.createElement("div");
  root.style.cssText =
    "position:relative;width:100%;box-sizing:border-box;padding:6px 10px 8px;font-family:" +
    FONT + ";color:#f2f2f7;font-size:12.5px;";

  // —— 风格 / 歌词 卡片 ——
  ui.taStyle = makeBoundTextArea(node, "style", 56,
    "语言 + 曲风 + 人声 + BPM + 乐器 + 情绪", false);
  ui.taLyrics = makeBoundTextArea(node, "lyrics", 96,
    "[Verse] / [Chorus] 段落标签，只放要演唱的词", false);
  root.appendChild(makeCard("风格 STYLE", ui.taStyle));
  root.appendChild(makeCard("歌词 LYRICS", ui.taLyrics));

  // —— 主分段 ——
  const mainTrack = document.createElement("div");
  mainTrack.style.cssText =
    "display:flex;gap:2px;background:rgba(0,0,0,.38);border-radius:9px;padding:2px;margin-top:2px;";
  const mainDefs = [
    { key: "smart", label: "智能" },
    { key: "text", label: "文生" },
    { key: "cover", label: "翻唱" },
    { key: "manual", label: "手动" },
    { key: "off", label: "直生" },
  ];
  mainDefs.forEach((d) => {
    const b = document.createElement("button");
    b.textContent = d.label;
    b.dataset.key = d.key;
    b.style.cssText =
      "flex:1;border:0;background:transparent;color:#9a9aa2;font-size:12px;" +
      "font-weight:500;padding:6px 0;border-radius:7px;cursor:default;" +
      "transition:background .18s,color .18s,box-shadow .18s;font-family:inherit;";
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      setMain(node, d.key);
      scheduleFit(node);
    });
    mainTrack.appendChild(b);
  });
  ui.mainTrack = mainTrack;

  // —— 副分段 ——
  const subWrap = document.createElement("div");
  subWrap.style.cssText = "overflow:hidden;max-height:0;opacity:0;";
  ui.subWrap = subWrap;

  // —— 状态行 ——
  const statusRow = document.createElement("div");
  statusRow.style.cssText =
    "display:flex;align-items:flex-start;gap:8px;margin:10px 2px 2px;" +
    "font-size:11.5px;color:#b8b8c0;line-height:1.4;";
  const dot = document.createElement("span");
  dot.style.cssText =
    "flex:none;width:8px;height:8px;border-radius:50%;margin-top:4px;background:" +
    COL.gray + ";";
  const statusText = document.createElement("span");
  statusRow.append(dot, statusText);
  ui.dot = dot; ui.statusText = statusText;

  // —— ABC 卡片 ——
  const abcCard = document.createElement("div");
  abcCard.style.cssText =
    "margin-top:9px;background:rgba(255,255,255,.045);border:1px solid " +
    "rgba(255,255,255,.08);border-radius:10px;";
  const cardHead = document.createElement("div");
  cardHead.style.cssText =
    "display:flex;align-items:center;justify-content:space-between;padding:8px 11px 0;";
  const cardTitle = document.createElement("span");
  cardTitle.textContent = "ABC 乐谱";
  cardTitle.style.cssText = "font-size:11px;font-weight:600;color:#8e8e93;";
  const badge = document.createElement("span");
  badge.style.cssText =
    "font-size:10px;font-weight:600;padding:2px 8px;border-radius:20px;" +
    "background:rgba(10,132,255,.16);color:#6bb6ff;";
  cardHead.append(cardTitle, badge);
  const ta = makeBoundTextArea(node, "manual_abc", 92,
    "运行工作流后此处得到 ABC；切到「手动」可自行编辑", true);
  abcCard.append(cardHead, ta);
  ui.ta = ta; ui.badge = badge;

  // —— 高级参数：常显、紧凑两列网格（不折叠，不溢出）——
  const adv = document.createElement("div");
  adv.style.cssText = "margin-top:9px;";
  const advTitle = document.createElement("div");
  advTitle.textContent = "高级参数";
  advTitle.style.cssText =
    "display:flex;align-items:center;padding:0 2px 6px;" +
    "font-size:11px;font-weight:600;color:#8e8e93;user-select:none;";
  const advGrid = document.createElement("div");
  advGrid.style.cssText =
    "display:grid;grid-template-columns:1fr 1fr;gap:7px 12px;padding:0 2px 2px;";
  ui.advNums = {};
  ADV_ROWS.forEach(([key, label, withDice]) => {
    const { row, inp } = makeCompactRow(node, key, label, withDice);
    ui.advNums[key] = inp;
    advGrid.appendChild(row);
  });
  adv.append(advTitle, advGrid);

  root.append(mainTrack, subWrap, statusRow, abcCard, adv);
  ui.root = root;
  return ui;
}

// ==============================================================================
// 状态 / 分段同步
// ==============================================================================
function makeSubTrack(node, items, cur, onPick) {
  const track = document.createElement("div");
  track.style.cssText =
    "display:flex;gap:2px;margin-top:7px;background:rgba(255,255,255,.07);" +
    "border-radius:8px;padding:2px;";
  items.forEach((it) => {
    const b = document.createElement("button");
    b.textContent = it.label;
    b.style.cssText =
      "flex:1;border:0;background:transparent;color:#9a9aa2;font-size:11px;" +
      "font-weight:500;padding:5px 0;border-radius:6px;cursor:default;" +
      "transition:background .18s,color .18s;font-family:inherit;";
    if (it.v === cur) {
      b.style.background = "#6d6d75";
      b.style.color = "#fff";
      b.style.fontWeight = "600";
    }
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      onPick(it.v);
      scheduleFit(node);
    });
    track.appendChild(b);
  });
  return track;
}

function renderSub(node) {
  const ui = node._ui;
  const mode = node._bzYue2State.plan_mode;
  let inner = null;
  if (mode === "text_full" || mode === "text_melody") {
    inner = makeSubTrack(node, [
      { v: "full", label: "旋律+和弦" },
      { v: "melody", label: "仅旋律" },
    ], mode === "text_full" ? "full" : "melody", (v) => {
      update(node, "plan_mode", v === "full" ? "text_full" : "text_melody");
      syncAll(node);
    });
  } else if (mode === "cover") {
    inner = makeSubTrack(node, [
      { v: "melody", label: "仅旋律" },
      { v: "full", label: "旋律+和弦" },
    ], node._bzYue2State.cover_transcribe_mode, (v) => {
      update(node, "cover_transcribe_mode", v);
      syncAll(node);
    });
  }
  if (inner) {
    ui.subWrap.innerHTML = "";
    ui.subWrap.appendChild(inner);
    ui.subWrap.style.maxHeight = "46px";
    ui.subWrap.style.opacity = "1";
  } else {
    ui.subWrap.innerHTML = "";
    ui.subWrap.style.maxHeight = "0";
    ui.subWrap.style.opacity = "0";
  }
}

function updateMainSeg(node) {
  const mode = node._bzYue2State.plan_mode;
  const key =
    mode === "smart" ? "smart"
    : (mode === "text_full" || mode === "text_melody") ? "text"
    : mode === "cover" ? "cover"
    : mode === "manual" ? "manual" : "off";
  node._ui.mainTrack.querySelectorAll("button").forEach((b) => {
    if (b.dataset.key === key) {
      b.style.background = "#6d6d75";
      b.style.color = "#fff";
      b.style.fontWeight = "600";
      b.style.boxShadow = "0 1px 3px rgba(0,0,0,.35)";
    } else {
      b.style.background = "transparent";
      b.style.color = "#9a9aa2";
      b.style.fontWeight = "500";
      b.style.boxShadow = "none";
    }
  });
}

function updateAbcCard(node) {
  const ui = node._ui;
  // 外部 ABC 接入：编辑区只读提示
  if (linked(node, "abc")) {
    ui.ta.readOnly = true;
    ui.ta.value = "";
    ui.ta.placeholder = "由外部节点提供";
    ui.ta.style.opacity = ".65";
    ui.badge.textContent = "外部提供";
    return;
  }
  const mode = node._bzYue2State.plan_mode;
  const isManual = mode === "manual";
  ui.ta.readOnly = !isManual;
  if (isManual) {
    ui.ta.value = node._bzYue2State.manual_abc ?? "";
    ui.ta.placeholder = "在此粘贴或编写 ABC 乐谱…";
    ui.ta.style.opacity = "1";
  } else {
    ui.ta.value = "";
    ui.ta.placeholder = "运行工作流后此处得到 ABC；切到「手动」可自行编辑";
    ui.ta.style.opacity = ".8";
  }
  const bmap = {
    smart: "智能路由", text_full: "旋律+和弦", text_melody: "仅旋律",
    cover: "音频转谱", manual: "可编辑", off: "不使用",
  };
  ui.badge.textContent = bmap[mode] ?? "";
}

function updateInputCards(node) {
  const ui = node._ui;
  const defs = [
    { slot: "style", key: "style", ta: ui.taStyle,
      ph: "语言 + 曲风 + 人声 + BPM + 乐器 + 情绪" },
    { slot: "lyrics", key: "lyrics", ta: ui.taLyrics,
      ph: "[Verse] / [Chorus] 段落标签，只放要演唱的词" },
  ];
  defs.forEach((d) => {
    const wired = linked(node, d.slot);
    d.ta.readOnly = wired;
    d.ta.style.opacity = wired ? ".65" : "1";
    d.ta.value = node._bzYue2State[d.key] ?? "";
    d.ta.placeholder = wired ? "由外部节点提供" : d.ph;
  });
}

function refreshStatus(node) {
  const ui = node._ui;
  // 外部 ABC 端口优先级最高
  if (linked(node, "abc")) {
    ui.dot.style.background = COL.blue;
    ui.dot.style.boxShadow = "0 0 6px " + COL.blue + "66";
    ui.statusText.textContent = "外部乐谱：已接入 ABC，将直接采用（忽略内部生成）";
    return;
  }
  const mode = node._bzYue2State.plan_mode;
  const audio = linked(node, "reference_audio");
  const enc = linked(node, "audio_encoder");
  const clip = linked(node, "clip");
  const m = mode === "smart" ? (audio ? "cover" : "text_full") : mode;
  let color = COL.gray;
  let text;
  if (m === "cover") {
    if (audio && enc) {
      color = COL.green;
      text = "翻唱就绪：将从参考音频提取旋律，重新编曲演唱";
    } else {
      color = COL.orange;
      text = audio
        ? "已接参考音频，还需接入音频编码器（AudioEncoderLoader）"
        : "请接入参考音频（reference_audio）";
    }
  } else if (m === "text_full" || m === "text_melody") {
    if (clip) {
      color = COL.green;
      text = m === "text_full"
        ? "文生就绪：生成旋律 + 和弦的完整乐谱"
        : "文生就绪：仅生成旋律，伴奏更自由";
    } else {
      color = COL.orange;
      text = "文生需要 CLIP：请接入 CheckpointLoader 的 CLIP";
    }
  } else if (m === "manual") {
    color = COL.blue;
    text = "手动模式：使用下方编辑区中的 ABC 乐谱";
  } else {
    color = COL.gray;
    text = "直生模式：不生成乐谱，由风格与歌词直接演唱";
  }
  ui.dot.style.background = color;
  ui.dot.style.boxShadow = "0 0 6px " + color + "66";
  ui.statusText.textContent = text;
}

function setMain(node, key) {
  let mode;
  if (key === "smart") mode = "smart";
  else if (key === "text") {
    mode = node._bzYue2State.plan_mode === "text_melody" ? "text_melody" : "text_full";
  } else if (key === "cover") mode = "cover";
  else if (key === "manual") mode = "manual";
  else mode = "off";
  update(node, "plan_mode", mode);
  syncAll(node);
}

function syncAll(node) {
  if (!node._ui) return;
  updateInputCards(node);
  updateMainSeg(node);
  renderSub(node);
  updateAbcCard(node);
  refreshStatus(node);
  for (const [key, num] of Object.entries(node._ui.advNums)) {
    num.value = node._bzYue2State[key];
  }
}

// ==============================================================================
// 端口中文标签
// ==============================================================================
const IN_LABELS = {
  style: "风格", lyrics: "歌词", abc: "外部乐谱", clip: "CLIP",
  audioencoder: "音频编码器", referenceaudio: "参考音频",
};
const OUT_LABELS = {
  style: "风格", lyrics: "歌词", abc: "ABC乐谱", activesource: "实际来源",
};

function pinLabels(node) {
  const norm = (s) => (s || "").toLowerCase().replace(/[\s_]+/g, "");
  const apply = (slot, map) => {
    if (!slot) return;
    const l = map[norm(slot.name)];
    if (l) { slot.label = l; slot.localized_name = l; }
  };
  (node.inputs || []).forEach((s) => apply(s, IN_LABELS));
  (node.outputs || []).forEach((s) => apply(s, OUT_LABELS));
}

// 隐藏唯一原生 widget（config），照铁律第 4 节
function hideConfig(node) {
  const w = gw(node, "config");
  if (!w) return;
  w.hidden = true;
  w.computeSize = () => [0, -4];
  w.draw = () => {};
  w.mouse = () => {};
  w.serializeValue = () => JSON.stringify(node._bzYue2State || DEFAULT_STATE);
}

// ==============================================================================
// 面板初始化
// ==============================================================================
function setupPanel(node) {
  hideConfig(node);
  restoreState(node);

  node._panelHeight = 540;
  node._ui = buildUI(node);
  const root = node._ui.root;
  root.addEventListener("mousedown", (e) => e.stopPropagation());
  root.addEventListener("keydown", (e) => e.stopPropagation());
  node._panelRoot = root;

  node._panelDomW = node.addDOMWidget("智能乐谱面板", "fit_panel", root, {
    serialize: false,
    margin: PANEL_MARGIN,
    getMinHeight: () => node._panelHeight,
    getMaxHeight: () => node._panelHeight,
    getHeight: () => node._panelHeight,
  });
  // 铁律第 4 节：只写 options.serialize 不够，widget 自身的 serialize 必须显式置 false，
  // 否则存档里的 widgets_values 会按索引错位分发（面板占掉第 0 位 → config 拿不到值 → 回到默认）。
  node._panelDomW.serialize = false;
  node._panelDomW.options = { ...(node._panelDomW.options || {}), serialize: false };

  // 面板移到 widgets 最前，紧跟端口（照抄 lora）
  const wi = node.widgets.indexOf(node._panelDomW);
  if (wi > 0) node.widgets.splice(0, 0, node.widgets.splice(wi, 1)[0]);

  node.size[0] = Math.max(node.size[0] ?? 0, 360);

  syncAll(node);
  pinLabels(node);
  // 注意：新建节点时不回写 properties。
  // 刷新加载时 configure 会先把存档的 widgets_values 写进 config widget，
  // 若此时 properties 已被「新建默认值」污染，恢复优先级（properties 优先）就会取到默认值，
  // 表现为「刷新后面板回到默认」。真正的回写交给用户改值的 update() 与 configure 末尾。

  if (typeof ResizeObserver === "function" && !node._panelRO) {
    node._panelRO = new ResizeObserver(() => fitNodeHeight(node));
    // 同时观察 root 与其每个直接子区块：root 盒高可能被容器钉死，
    // 内容溢出时 root 自身不触发回调，子区块（显隐/换行/字数变化）才会。
    node._panelRO.observe(root);
    Array.from(root.children).forEach((c) => node._panelRO.observe(c));
  }
  node.onResize = (function (prev) {
    return function () {
      prev?.apply(this, arguments);
      fitNodeHeight(this);
    };
  })(node.onResize);
  node.onRemoved = (function (prev) {
    return function () {
      this._panelRO?.disconnect();
      this._panelRO = null;
      prev?.apply(this, arguments);
    };
  })(node.onRemoved);

  scheduleFit(node);
}

// ==============================================================================
// 注册
// ==============================================================================
app.registerExtension({
  name: "banzhang.yue2.smart",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== NODE_NAME) return;

    const onCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = onCreated ? onCreated.apply(this, arguments) : undefined;
      setupPanel(this);
      return r;
    };

    const onConfigure = nodeType.prototype.configure;
    nodeType.prototype.configure = function () {
      const r = onConfigure ? onConfigure.apply(this, arguments) : undefined;
      const node = this;
      hideConfig(node);
      restoreState(node);
      if (node._ui) {
        syncAll(node);
        pinLabels(node);
        scheduleFit(node);
      }
      syncConfig(node);
      return r;
    };

    const prevConn = nodeType.prototype.onConnectionsChange;
    nodeType.prototype.onConnectionsChange = function () {
      prevConn?.apply(this, arguments);
      const node = this;
      if (node._ui) {
        updateInputCards(node);
        updateAbcCard(node);
        refreshStatus(node);
        fitNodeHeight(node);
      }
    };
  },
});
