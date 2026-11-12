import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

// ═══════════════════════════════════════════════════════════════════════
//  🪞 人脸修复台 · 苹果风极简单页（全自动，无按钮、无参数滑块）
//  工作流执行即自动检测 + 出掩码；面板只展示检测到的人脸缩略图与状态。
//  卡片高度按人脸行数推导（1–3 行，超出滚动），行高固定，与宽度无关 ——
//  避免「宽度 ↔ aspect-ratio 高度」互相触发的那条自激回路。
// ═══════════════════════════════════════════════════════════════════════

const PANEL_W = 480;
const MIN_W = 400;
const W_KEY = "facefix_width";
const PAD = 10;
const TOOLBAR_H = 44;
const HEAD_H = 22;        // 卡片内「全自动 / 检测到 N 张脸」一行
const TILE_H = 132;       // 固定行高，不随宽度变化
const GAP = 8;
const MAX_ROWS = 2;      // 最多两行（≤6 张），再多在卡片内滚动，避免节点过高
const PARAMS_H = 22;     // 参数条一行：7 项横向平分（两行要多占 28px）
const STATUS_H = 40;   // 状态行留足余量（高 DPI 下 20px 会被节点底边切掉半行）
const COLS = 3;

const C = {
  blue: "#0A84FF", green: "#30D158", red: "#FF453A",
  line: "rgba(255,255,255,.1)",
};

function ensureStyles() {
  if (document.getElementById("bz-facefix-style")) return;
  const css = `
  .bz-ff-root{width:100%;height:100%;box-sizing:border-box;padding:${PAD}px;border-radius:10px;color:#f5f5f7;
    background:linear-gradient(180deg,#1d1d22,#141418);border:none;overflow:hidden;
    font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;}
  .bz-ff-toolbar{display:flex;align-items:center;gap:8px;height:${TOOLBAR_H}px;margin-bottom:10px;}
  .bz-ff-title{font-size:13px;font-weight:700;white-space:nowrap;}
  .bz-ff-spacer{flex:1;}
  .bz-ff-prompt{width:150px;height:24px;box-sizing:border-box;padding:0 8px;font-size:11px;
    color:#f5f5f7;background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.12);
    border-radius:6px;outline:none;font-family:inherit;}
  .bz-ff-prompt::placeholder{color:rgba(255,255,255,.32);}
  .bz-ff-prompt:focus{border-color:${C.blue};background:rgba(10,132,255,.14);}
  /* [单行参数] 7 项平分一行：标签固定宽度，输入框吃掉剩余空间。
     两行版要多占 28px，而面板下半截一直是最紧的地方。 */
  .bz-ff-params{display:flex;align-items:center;height:${PARAMS_H}px;margin-bottom:8px;}
  .bz-ff-prow{display:flex;align-items:center;gap:5px;height:22px;flex:1;min-width:0;}
  .bz-ff-p{display:flex;align-items:center;gap:3px;font-size:10px;
    color:rgba(255,255,255,.55);flex:1 1 0;min-width:0;white-space:nowrap;}
  /* 上下箭头保留（微调靠它）。每格只有 ~38px：数字靠左排、右侧 12px 留给 spin 按钮，
     居中会让数字压到箭头上 —— 这是唯一能在单行里同时保住箭头和可读数字的排法。 */
  .bz-ff-p input{flex:1 1 0;min-width:0;height:20px;box-sizing:border-box;
    padding:0 2px 0 4px;
    font-size:10px;color:#f5f5f7;background:rgba(255,255,255,.08);
    border:1px solid rgba(255,255,255,.12);border-radius:5px;outline:none;
    font-family:inherit;text-align:left;}
  .bz-ff-p input:focus{border-color:${C.blue};background:rgba(10,132,255,.14);}
  .bz-ff-p select{flex:1.5 1 0;min-width:0;height:20px;box-sizing:border-box;
    padding:0 2px;font-size:9.5px;color:#f5f5f7;background:rgba(255,255,255,.08);
    border:1px solid rgba(255,255,255,.12);border-radius:5px;outline:none;
    font-family:inherit;text-align:left;color-scheme:dark;}
  .bz-ff-p select option{background:#1d1d22;color:#f5f5f7;}
  .bz-ff-p .hint{font-size:9.5px;color:rgba(255,255,255,.3);}
  .bz-ff-dot{width:9px;height:9px;border-radius:50%;flex:none;background:${C.green};
    box-shadow:0 0 8px rgba(48,209,88,.6);}
  .bz-ff-dot.busy{background:${C.blue};box-shadow:0 0 8px rgba(10,132,255,.6);}
  .bz-ff-dot.err{background:${C.red};box-shadow:0 0 8px rgba(255,69,58,.6);}
  .bz-ff-card{box-sizing:border-box;border:1px solid ${C.line};border-radius:10px;
    background:rgba(0,0,0,.3);padding:${PAD}px;display:flex;flex-direction:column;overflow:hidden;}
  .bz-ff-head{display:flex;align-items:baseline;gap:8px;height:${HEAD_H}px;flex:none;}
  .bz-ff-auto{font-size:11px;font-weight:700;color:${C.green};}
  .bz-ff-count{font-size:11px;color:rgba(255,255,255,.6);}
  .bz-ff-grid{flex:1;min-height:0;overflow-y:auto;scrollbar-gutter:stable;
    display:grid;grid-template-columns:repeat(${COLS},1fr);gap:${GAP}px;align-content:start;}
  /* [对比卡描边] 每对前后图独立边框 + 左上序号。5 张脸挤在一屏时，
     光靠两个半格之间那条 1px 暗线分不清哪两格是一对。 */
  .bz-ff-thumb{position:relative;height:${TILE_H}px;border-radius:8px;overflow:hidden;
    background:rgba(255,255,255,.05);display:flex;
    border:1px solid rgba(255,255,255,.18);box-shadow:0 1px 3px rgba(0,0,0,.45);}
  .bz-ff-thumb:hover{border-color:rgba(10,132,255,.7);}
  .bz-ff-idx{position:absolute;top:3px;left:4px;z-index:2;font-size:9px;font-weight:700;
    line-height:14px;padding:0 5px;border-radius:5px;color:#fff;background:rgba(0,0,0,.62);}
  .bz-ff-half{position:relative;flex:1;min-width:0;background:rgba(255,255,255,.04);cursor:zoom-in;}
  .bz-ff-half + .bz-ff-half{border-left:1px solid rgba(0,0,0,.55);}
  .bz-ff-half.bz-ff-dilate{box-shadow:inset 0 0 0 1.5px rgba(10,132,255,.6);}
  .bz-ff-half img{width:100%;height:100%;object-fit:cover;display:block;}
  .bz-ff-half .tag{position:absolute;left:3px;bottom:3px;font-size:9px;color:#fff;
    background:rgba(0,0,0,.6);padding:0 5px;border-radius:5px;}
  .bz-ff-badge{position:absolute;right:3px;top:3px;font-size:9px;line-height:1;
    color:#fff;background:rgba(10,132,255,.92);padding:3px 5px;border-radius:5px;
    font-weight:600;z-index:2;}
  .bz-ff-half .none{position:absolute;inset:0;display:flex;align-items:center;
    justify-content:center;font-size:10px;color:rgba(255,255,255,.28);}
  .bz-ff-empty{display:flex;align-items:center;justify-content:center;height:${TILE_H}px;
    font-size:12px;color:rgba(255,255,255,.4);text-align:center;line-height:1.6;white-space:pre-line;
    grid-column:1 / -1;}
  /* 40px = 两行 × 20px：长状态（「已用 SAM3.1 记忆追踪…」）不再被单行省略，
     右侧「展开」弹浮层看完整报告与证据日志（色度增量/低频漂移/覆盖）。 */
  .bz-ff-status-wrap{height:${STATUS_H}px;flex:none;position:relative;display:flex;
    align-items:center;gap:8px;}
  .bz-ff-status{flex:1;min-width:0;font-size:10.5px;color:rgba(255,255,255,.55);
    line-height:20px;box-sizing:border-box;white-space:normal;word-break:break-all;
    overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;}
  .bz-ff-expand{flex:none;border:1px solid rgba(255,255,255,.18);
    background:rgba(255,255,255,.08);color:#f5f5f7;font-size:10.5px;line-height:1;
    padding:6px 10px;border-radius:13px;cursor:pointer;font-family:inherit;}
  .bz-ff-expand:hover{background:rgba(10,132,255,.25);border-color:${C.blue};}
  .bz-ff-pop{position:absolute;left:0;right:0;bottom:44px;display:none;z-index:30;
    background:#1f1f24;border:1px solid rgba(255,255,255,.16);border-radius:12px;
    box-shadow:0 12px 36px rgba(0,0,0,.55);padding:10px 12px;max-height:280px;
    overflow:auto;box-sizing:border-box;}
  .bz-ff-pop.open{display:block;}
  .bz-ff-pop-title{font-size:11px;font-weight:700;color:#f5f5f7;margin:0 0 6px;}
  .bz-ff-pop-body{font-size:10.5px;line-height:1.65;color:rgba(255,255,255,.72);
    white-space:normal;word-break:break-word;}
  .bz-ff-logline{color:#64b5ff;}
  `;
  const style = document.createElement("style");
  style.id = "bz-facefix-style";
  style.textContent = css;
  document.head.appendChild(style);
}

function el(tag, cls, parent) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (parent) parent.appendChild(node);
  return node;
}

function hideWidget(w) {
  if (!w) return;
  w.hidden = true;
  w.computeSize = () => [0, -4];
  w.draw = () => {};
  w.mouse = () => {};
}

// 内部 name 英文蛇形，仅钉显示用中文 label
const PORT_LABELS = {
  frames: "成片帧",
  model: "H3模型",
  positive: "正条件",
  vae: "编解码VAE",
  sam3_model: "SAM3.1模型",
  sam3_clip: "SAM3.1文本编码",
};

function pinPortLabels(n) {
  for (const s of n.inputs || []) {
    const key = String(s.name || "").toLowerCase();
    if (PORT_LABELS[key]) s.label = PORT_LABELS[key];
  }
}

app.registerExtension({
  name: "BanZhang.FaceFixStudio",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData?.name !== "BanZhang_FaceFixStudio") return;

    const chain = (target, name, fn) => {
      const old = target[name];
      target[name] = function (...args) {
        if (old) old.apply(this, args);
        return fn.apply(this, args);
      };
    };

    chain(nodeType.prototype, "onNodeCreated", function () {
      ensureStyles();
      const node = this;
      node.properties = node.properties || {};

      const wMap = {};
      // 提示词与三个数值参数都由面板自绘，原生 widget 收起来只留值
      const HIDDEN_WIDGETS = ["project_data", "sam3_prompt",
        "detail_gain", "sam3_threshold", "mask_dilate", "steps", "denoise",
        "feather", "upscale", "upscale_model"];
      function bindWidgets() {
        for (const name of HIDDEN_WIDGETS) {
          const w = (node.widgets || []).find((x) => x.name === name);
          if (!w) continue;
          wMap[name] = w;
          hideWidget(w);
        }
      }
      bindWidgets();

      const state = { project: { faces: [] } };

      // ── 工具栏：标题 + 提示词 + 状态点 ─────────────────────────
      const root = el("div", "bz-ff-root");
      const toolbar = el("div", "bz-ff-toolbar", root);
      el("span", "bz-ff-title", toolbar).textContent = "🪞 人脸修复台";
      el("div", "bz-ff-spacer", toolbar);
      const promptInput = el("input", "bz-ff-prompt", toolbar);
      promptInput.type = "text";
      promptInput.placeholder = "人脸提示词";
      promptInput.spellcheck = false;
      promptInput.title = "SAM3.1 开放词汇提示词，默认 face；改「人脸」等同义也行";
      const dot = el("span", "bz-ff-dot", toolbar);

      // ── 参数条：阈值 / 外扩 / 强度（原生 widget 已隐藏，这里代理）──
      const numInputs = {};
      const selInputs = {};
      // [下拉] 放大模型这类选项型参数：原生 combo 收起，面板里给一个 select
      function selField(parent, label, name, options) {
        const wrap = el("label", "bz-ff-p", parent);
        el("span", "", wrap).textContent = label;
        const sel = document.createElement("select");
        for (const o of options) {
          const op = document.createElement("option");
          op.value = o;
          op.textContent = String(o).replace(/\.(pth|safetensors)$/i, "");
          sel.appendChild(op);
        }
        wrap.appendChild(sel);
        selInputs[name] = sel;
        sel.addEventListener("change", () => {
          const w = wMap[name];
          if (w && w.value !== sel.value) {
            w.value = sel.value;
            node.graph?.change?.();
          }
        });
        ["pointerdown", "keydown", "keyup", "wheel"].forEach((ev) =>
          sel.addEventListener(ev, (e) => e.stopPropagation()));
        return sel;
      }
      function numField(parent, label, name, min, max, step) {
        const wrap = el("label", "bz-ff-p", parent);
        el("span", "", wrap).textContent = label;
        const inp = document.createElement("input");
        inp.type = "number";
        inp.min = min;
        inp.max = max;
        inp.step = step;
        wrap.appendChild(inp);
        numInputs[name] = inp;
        // [箭头即时生效] 点 number 的上下箭头只发 input、不发 change ——
        // 只绑 change 的话，点完箭头不点别处，值只停在显示上，执行时还是旧值。
        // 只写「合法且在范围内」的值，敲 "0." 这种半成品不会把 0 写进去。
        inp.addEventListener("input", () => {
          const w = wMap[name];
          if (!w) return;
          const v = parseFloat(inp.value);
          if (isFinite(v) && v >= min && v <= max && w.value !== v) {
            w.value = v;
            node.graph?.change?.();
          }
        });
        inp.addEventListener("change", () => {
          const w = wMap[name];
          if (!w) return;
          let v = parseFloat(inp.value);
          if (!isFinite(v)) v = parseFloat(w.value) || min;
          v = Math.min(max, Math.max(min, v));
          inp.value = step < 1 ? v.toFixed(2) : String(Math.round(v));
          if (w.value !== v) {
            w.value = v;
            node.graph?.change?.();
          }
        });
        ["pointerdown", "keydown", "keyup", "wheel", "contextmenu", "dblclick"]
          .forEach((ev) => inp.addEventListener(ev, (e) => e.stopPropagation()));
        return inp;
      }
      function paramsFromWidgets() {
        for (const name of ["detail_gain", "sam3_threshold", "mask_dilate",
                            "steps", "denoise", "feather", "upscale"]) {
          const w = wMap[name];
          const inp = numInputs[name];
          if (!w || !inp) continue;
          const step = parseFloat(inp.step) || 1;
          inp.value = step < 1 ? Number(w.value).toFixed(2) : String(Math.round(Number(w.value)));
        }
        const sel = selInputs.upscale_model;
        const wsel = wMap.upscale_model;
        if (sel && wsel) sel.value = String(wsel.value);
      }
      // [存档自愈] widget 值按顺序存档：增删参数后旧工程会整排错位（上轮
      // blend 拿到 384 就是这原因），超出 min/max 的在这里复位成默认，
      // 免得执行期被后端校验拦下。
      const WIDGET_DEFAULTS = { detail_gain: 1, sam3_threshold: 0.35,
        mask_dilate: 24, steps: 6, denoise: 0.3, feather: 24, upscale: 3 };
      function sanitizeWidgets() {
        let changed = false;
        for (const name of Object.keys(WIDGET_DEFAULTS)) {
          const w = wMap[name];
          const inp = numInputs[name];
          if (!w || !inp) continue;
          const v = Number(w.value);
          const min = parseFloat(inp.min), max = parseFloat(inp.max);
          if (!isFinite(v) || v < min || v > max) {
            w.value = WIDGET_DEFAULTS[name];
            changed = true;
          }
        }
        const sel = selInputs.upscale_model, wsel = wMap.upscale_model;
        if (sel && wsel) {
          const vals = Array.from(sel.options).map((o) => o.value);
          if (!vals.includes(String(wsel.value))) {
            wsel.value = vals[0];
            changed = true;
          }
        }
        paramsFromWidgets();
        if (changed) node.graph?.change?.();
      }

      const params = el("div", "bz-ff-params", root);
      const row1 = el("div", "bz-ff-prow", params);
      numField(row1, "细节", "detail_gain", 0, 2, 0.05);
      numField(row1, "放大", "upscale", 1, 4, 0.5);
      numField(row1, "阈值", "sam3_threshold", 0.05, 0.95, 0.05);
      numField(row1, "外扩", "mask_dilate", 0, 96, 4);
      numField(row1, "步数", "steps", 1, 30, 1);
      numField(row1, "降噪", "denoise", 0.05, 1, 0.05);
      numField(row1, "羽化", "feather", 0, 64, 4);
      const modelOpts = (wMap.upscale_model && wMap.upscale_model.options
        && wMap.upscale_model.options.values) || ["（不用模型）"];
      selField(row1, "模型", "upscale_model", modelOpts);
      sanitizeWidgets();

      // ── 人脸缩略图卡片 ─────────────────────────────────────────
      const card = el("div", "bz-ff-card", root);
      const head = el("div", "bz-ff-head", card);
      el("div", "bz-ff-auto", head).textContent = "全自动";
      const count = el("div", "bz-ff-count", head);
      const grid = el("div", "bz-ff-grid", card);

      const statusWrap = el("div", "bz-ff-status-wrap", root);
      const statusLine = el("div", "bz-ff-status", statusWrap);
      const expandBtn = el("button", "bz-ff-expand", statusWrap);
      expandBtn.type = "button";
      expandBtn.textContent = "展开";
      const pop = el("div", "bz-ff-pop", statusWrap);
      el("div", "bz-ff-pop-title", pop).textContent = "完整修复报告";
      const popBody = el("div", "bz-ff-pop-body", pop);

      let lastFullReport = "";
      function renderPop(full) {
        lastFullReport = String(full || "");
        popBody.innerHTML = "";
        lastFullReport.split(/[｜\n]/).filter(Boolean).forEach((seg) => {
          const d = document.createElement("div");
          d.textContent = seg;
          if (/批\d|色度|漂移|覆盖|块差|画布|羽化/.test(seg)) {
            d.className = "bz-ff-logline";
          }
          popBody.appendChild(d);
        });
      }
      function togglePop(force) {
        const open = typeof force === "boolean" ? force
          : !pop.classList.contains("open");
        pop.classList.toggle("open", open);
        expandBtn.textContent = open ? "收起" : "展开";
      }
      expandBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        togglePop();
      });
      [expandBtn, pop].forEach((box) =>
        ["pointerdown", "keydown", "keyup", "wheel", "contextmenu", "dblclick"]
          .forEach((ev) => box.addEventListener(ev, (e) => e.stopPropagation())));

      function setStatus(text, tone) {
        statusLine.textContent = text;
        statusLine.title = lastFullReport || text;
        dot.className = "bz-ff-dot" + (tone === "busy" ? " busy" : tone === "err" ? " err" : "");
      }

      // 提示词：面板输入框 ↔ 隐藏 widget 双向同步（值随工作流存档走）
      function promptFromWidget() {
        const w = wMap.sam3_prompt;
        promptInput.value = (w && w.value) || "face";
      }
      // 打字时只同步值，失焦/回车才标脏，避免每敲一个字都刷「未保存」
      promptInput.addEventListener("input", () => {
        const w = wMap.sam3_prompt;
        if (w) w.value = promptInput.value;
      });
      promptInput.addEventListener("change", () => {
        const w = wMap.sam3_prompt;
        if (w) {
          w.value = promptInput.value;
          node.graph?.change?.();
        }
      });
      // 打字/滚轮别冒到画布，否则会触发画布快捷键
      ["pointerdown", "keydown", "keyup", "wheel", "contextmenu", "dblclick"]
        .forEach((ev) => promptInput.addEventListener(ev, (e) => e.stopPropagation()));
      promptFromWidget();

      // 卡片高度 = 表头 + 行数×行高 + 行间距；行高固定，与节点宽度无关
      function cardHeight() {
        const n = (state.project.faces || []).length;
        const rows = Math.min(MAX_ROWS, Math.max(1, Math.ceil(n / COLS)));
        return HEAD_H + rows * TILE_H + (rows - 1) * GAP + PAD * 2;
      }
      function panelHeight() {
        return PAD * 2 + TOOLBAR_H + 6 + PARAMS_H + 8 + cardHeight() + STATUS_H;
      }
      function wantWidth() {
        return Math.max(node.properties[W_KEY] || PANEL_W, MIN_W);
      }
      // 节点高度必须自己把「输入端口占的行高」加回来：litegraph 的 computeSize 只累加
      // widget 高度，不含 inputs 的垂直占位，而 DOM 面板是从 widgets_start_y（端口之后）
      // 开始铺的 —— 少算这段，面板下半截就被裁（2026-11-01 真机截图）。
      // widgets_start_y 由排版方提供（单一真值），拿不到再按端口行数推。
      function contentTop() {
        const title = LiteGraph.NODE_TITLE_HEIGHT || 30;
        const rows = Math.max(1, (node.inputs || []).length);
        const bySlots = title + rows * (LiteGraph.NODE_SLOT_HEIGHT || 20);
        const y = node.widgets_start_y;
        return (typeof y === "number" && y > 0) ? Math.max(y, bySlots) : bySlots;
      }
      function nodeHeight() {
        return contentTop() + panelHeight();
      }
      function applySize() {
        card.style.height = cardHeight() + "px";
        if (node._bz_fixingW) return;
        node._bz_fixingW = true;
        node.setSize([wantWidth(), nodeHeight()]);
        node._bz_fixingW = false;
      }

      let lastRaw = "";
      function syncProject() {
        const raw = JSON.stringify(state.project);
        if (wMap.project_data) wMap.project_data.value = raw;
        node.properties.facefix_project = raw;
        // 只有内容真变了才标脏，重复执行同样结果不再刷「未保存」
        if (raw !== lastRaw) {
          lastRaw = raw;
          node.graph?.change?.();
        }
      }

      function renderFaces() {
        grid.innerHTML = "";
        const faces = state.project.faces || [];
        count.textContent = faces.length ? `检测到 ${faces.length} 张脸` : "";
        if (!faces.length) {
          el("div", "bz-ff-empty", grid).textContent =
            "工作流执行后自动检测人脸\n接「SAM3.1模型」+「SAM3.1文本编码」\n此处显示识别到的人脸缩略图";
          return;
        }
        faces.forEach((f, i) => {
          const thumb = el("div", "bz-ff-thumb", grid);
          el("span", "bz-ff-idx", thumb).textContent = String(i + 1);
          const dilate = Math.round(Number(wMap.mask_dilate?.value ?? 0));
          const half = (src, label, isAfter) => {
            const d = el("div", "bz-ff-half", thumb);
            if (src) {
              const img = document.createElement("img");
              img.src = src;
              img.alt = "脸 " + (i + 1) + " " + label;
              img.draggable = false;
              d.appendChild(img);
              // [点击放大] 新窗口看完整前后图，小缩略图上看不清的斑点可逐张核对
              d.addEventListener("click", () => window.open(src, "_blank"));
              ["pointerdown", "keydown", "keyup", "wheel", "contextmenu", "dblclick"]
                .forEach((ev) => d.addEventListener(ev, (e) => e.stopPropagation()));
            } else {
              el("div", "none", d).textContent = "—";
            }
            el("span", "tag", d).textContent = label;
            // [外扩可视化] 后图在外扩>0 时蓝色描边 + 徽章，修复范围状态一眼可见
            if (isAfter && dilate > 0) {
              d.classList.add("bz-ff-dilate");
              el("span", "bz-ff-badge", d).textContent = "外扩 " + dilate;
            }
          };
          half(f.thumb, "前", false);
          half(f.thumb_after || f.thumb, "后", true);
        });
      }

      function renderAll() {
        renderFaces();
        applySize();
      }

      function applyResult(fullJson, report) {
        if (Array.isArray(fullJson)) fullJson = fullJson[0];
        if (fullJson) {
          try {
            const proj = JSON.parse(fullJson);
            if (proj && typeof proj === "object") {
              state.project = proj;
              renderAll();
              syncProject();
            }
          } catch (e) {
            console.error("[人脸修复台] 回执 JSON 解析失败", e);
          }
        }
        let rep = report;
        if (Array.isArray(rep)) rep = rep.join("\n");
        if (rep) {
          const full = String(rep);
          const tone = full.startsWith("⚠️") || full.startsWith("❌") ? "err" : "";
          renderPop(full);
          // 状态行只显示首段（浮层里看全文与证据日志）
          setStatus(full.split(/[｜\n]/)[0], tone);
        }
      }

      function onExecuted(detail) {
        if (String(detail.node) !== String(node.id)) return;
        const out = detail.output || {};
        applyResult(out.project, out.report);
      }

      const onExecHandler = (e) => onExecuted(e.detail);
      api.addEventListener("executed", onExecHandler);
      const onErrHandler = (e) => {
        const d = (e && e.detail) || {};
        if (String(d.node_id) !== String(node.id)) return;
        const msg = d.exception_message || d.exception_type || "未知错误";
        const errTxt = "❌ 执行失败：" + msg;
        renderPop(errTxt);
        setStatus(errTxt, "err");
      };
      api.addEventListener("execution_error", onErrHandler);
      chain(node, "onRemoved", function () {
        api.removeEventListener("executed", onExecHandler);
        api.removeEventListener("execution_error", onErrHandler);
      });

      // ── 尺寸双通道 ─────────────────────────────────────────────
      const domWidget = node.addDOMWidget(
        "facefix_panel", "facefix", root, { serialize: false });
      node.widgets.unshift(node.widgets.pop());
      if (domWidget) {
        // 旧引擎（litegraph）问 computeSize，新引擎（v2 VueNodes）问 computeLayoutSize，
        // 两个都必须报「真实内容高」，缺一个就会按默认值排布 → 面板溢出/压住端口
        domWidget.computeSize = () => [node.size[0], panelHeight()];
        domWidget.computeLayoutSize = () => ({
          minHeight: panelHeight(), maxHeight: undefined, minWidth: 0,
        });
      }
      card.style.height = cardHeight() + "px";
      applySize();

      chain(node, "onResize", function (size) {
        if (app.canvas && app.canvas.resizing_node === node) {
          // 用户亲手拖：只记宽度真值，高度由内容推导，松手后下次渲染再对齐
          node.properties[W_KEY] = Math.round(size[0]);
          return;
        }
        const wantW = wantWidth();
        const wantH = nodeHeight();
        if (Math.abs(size[0] - wantW) > 1 && !node._bz_fixingW) {
          node._bz_fixingW = true;
          node.setSize([wantW, wantH]);
          node._bz_fixingW = false;
          return;
        }
        if (Math.abs(size[1] - wantH) > 1) size[1] = wantH;
      });

      // 旧工作流存档会带着已删除的端口（参考脸/正条件/多身份条件），litegraph 的
      // configure 会照抄存档 inputs 重建 slot —— 后端已无定义，留着只会误导接线。
      // 白名单只认后端 schema（单一真值），取不到才退回本地端口表。
      function knownInputs() {
        const def = node.constructor?.nodeData?.input;
        const names = new Set();
        for (const grp of [def?.required, def?.optional]) {
          if (grp) Object.keys(grp).forEach((k) => names.add(k.toLowerCase()));
        }
        if (!names.size) Object.keys(PORT_LABELS).forEach((k) => names.add(k));
        return names;
      }
      function pruneStaleSlots() {
        const known = knownInputs();
        const inputs = node.inputs || [];
        for (let i = inputs.length - 1; i >= 0; i--) {
          if (!known.has(String(inputs[i].name || "").toLowerCase())) {
            try { node.removeInput(i); } catch (_) {}
          }
        }
      }

      chain(node, "onConfigure", function () {
        bindWidgets();
        promptFromWidget();
        paramsFromWidgets();
        const raw = node.properties?.facefix_project;
        if (raw) {
          try {
            state.project = JSON.parse(raw);
            renderAll();
          } catch (_) {}
        }
        pruneStaleSlots();
        pinPortLabels(node);
        requestAnimationFrame(() => {
          promptFromWidget();
          paramsFromWidgets();
          pruneStaleSlots();
          pinPortLabels(node);
          applySize();
        });
      });

      pinPortLabels(node);
      renderAll();
    });

    // 接线变化会重建 slot，补钉中文标签
    chain(nodeType.prototype, "onConnectionsChange", function () {
      pinPortLabels(this);
    });
  },
});
