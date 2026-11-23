import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

// ═══════════════════════════════════════════════════════════════════════
//  🪞 人脸修复台 · 苹果风极简单页（全自动，无按钮、无参数滑块）
//  工作流执行即自动检测 + 出掩码；面板只展示检测到的人脸缩略图与状态。
//  卡片高度按人脸行数推导（1–2 行，超出滚动）；行高 = 半格宽度（用户要求
//  每个预览是正方形），只跟**宽度**走、不跟高度走 —— 宽度由 wantWidth()
//  决定，与行高无关，所以这里不会形成「宽度 ↔ 高度」自激回路
//  （aspect-ratio 版本踩过的坑，别改回去）。
// ═══════════════════════════════════════════════════════════════════════

const PANEL_W = 480;
const MIN_W = 400;
const W_KEY = "facefix_width";
const PAD = 10;
const TOOLBAR_H = 44;
const HEAD_H = 22;        // 卡片内「全自动 / 检测到 N 张脸」一行
const TILE_H = 132;       // 兜底行高：实测半格宽之前/未挂载时用
const GAP = 8;
const MAX_ROWS = 2;      // 最多两行（≤6 张），再多在卡片内滚动，避免节点过高
const PARAMS_H = 22;     // 参数条一行：7 项横向平分（两行要多占 28px）
const STATUS_H = 40;   // 状态区最小高：报告全文直显后实际高度由实测推导
const COLS = 3;
// 预览带最长边按比例推，但封顶 150px：节点被拉很宽时不让一条预览吃掉半屏，
// 也让「预览 + 两行人脸格」的总高仍在可接受范围（高度是推导值，不是手调）。
const PV_MAX_H = 150;

const C = {
  blue: "#0A84FF", green: "#30D158", red: "#FF453A",
  line: "rgba(255,255,255,.1)",
};

function ensureStyles() {
  if (document.getElementById("bz-facefix-style")) return;
  const css = `
  .bz-ff-root{width:100%;height:100%;box-sizing:border-box;padding:${PAD}px;border-radius:10px;color:#f5f5f7;
    background:linear-gradient(180deg,#1d1d22,#141418);border:none;overflow:hidden;
    display:flex;flex-direction:column;
    font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;}
  .bz-ff-toolbar{display:flex;align-items:center;gap:8px;height:${TOOLBAR_H}px;flex:none;margin-bottom:10px;}
  .bz-ff-title{font-size:13px;font-weight:700;white-space:nowrap;}
  .bz-ff-spacer{flex:1;}
  .bz-ff-prompt{width:150px;height:24px;box-sizing:border-box;padding:0 8px;font-size:11px;
    color:#f5f5f7;background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.12);
    border-radius:6px;outline:none;font-family:inherit;}
  .bz-ff-prompt::placeholder{color:rgba(255,255,255,.32);}
  .bz-ff-prompt:focus{border-color:${C.blue};background:rgba(10,132,255,.14);}
  /* [单行参数] 7 项平分一行：标签固定宽度，输入框吃掉剩余空间。
     两行版要多占 28px，而面板下半截一直是最紧的地方。 */
  .bz-ff-params{display:flex;align-items:center;height:${PARAMS_H}px;flex:none;margin-bottom:8px;}
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
  .bz-ff-card{box-sizing:border-box;border:1px solid ${C.line};border-radius:10px;flex:none;
    background:rgba(0,0,0,.3);padding:${PAD}px;display:flex;flex-direction:column;overflow:hidden;}
  .bz-ff-head{display:flex;align-items:baseline;gap:8px;height:${HEAD_H}px;flex:none;}
  .bz-ff-auto{font-size:11px;font-weight:700;color:${C.green};}
  .bz-ff-count{font-size:11px;color:rgba(255,255,255,.6);}
  /* [运行时动画预览带] 三种画面共用一条带：跑起来先播「修复前」循环（检测 84 秒 +
     编码 112 秒这两段没有采样画面，有画面在动才分得清在跑还是卡住）；采样期间播
     每一步用 H3 官方 TAE 解出的动画；跑完停在「修复后」循环。
     播放一律交给浏览器原生解码（animated WebP 用 <img>、MP4 用 <video loop>），
     JS 只在收到新画面时换一次 src —— 不写 setInterval、不用 requestAnimationFrame。
     高度进 nodeHeight 推导链（measurePvH/applyPvH），带子出现即节点长高，
     不会顶出圆角边框。 */
  .bz-ff-pv{position:relative;display:none;flex:none;width:100%;
    height:var(--bz-pv-h,${PV_MAX_H}px);margin-bottom:${GAP}px;border-radius:8px;
    overflow:hidden;background:#000;border:1px solid rgba(255,255,255,.16);}
  .bz-ff-pv.is-on{display:block;}
  .bz-ff-pv img,.bz-ff-pv video{position:absolute;inset:0;width:100%;height:100%;
    object-fit:contain;background:#000;display:none;}
  .bz-ff-pv img.is-on,.bz-ff-pv video.is-on{display:block;}
  .bz-ff-pv .cap{position:absolute;left:4px;top:4px;z-index:2;font-size:9px;color:#fff;
    background:rgba(0,0,0,.62);padding:1px 5px;border-radius:5px;}
  .bz-ff-grid{flex:1;min-height:0;overflow-y:auto;scrollbar-gutter:stable;
    display:grid;grid-template-columns:repeat(${COLS},1fr);gap:${GAP}px;align-content:start;}
  /* [对比卡描边] 每对前后图独立边框 + 左上序号。5 张脸挤在一屏时，
     光靠两个半格之间那条 1px 暗线分不清哪两格是一对。 */
  .bz-ff-thumb{position:relative;height:var(--bz-tile-h,${TILE_H}px);border-radius:8px;overflow:hidden;
    background:rgba(255,255,255,.05);display:flex;
    border:1px solid rgba(255,255,255,.18);box-shadow:0 1px 3px rgba(0,0,0,.45);}
  .bz-ff-thumb:hover{border-color:rgba(10,132,255,.7);}
  .bz-ff-idx{position:absolute;top:3px;left:4px;z-index:2;font-size:9px;font-weight:700;
    line-height:14px;padding:0 5px;border-radius:5px;color:#fff;background:rgba(0,0,0,.62);}
  .bz-ff-half{position:relative;flex:1;min-width:0;background:rgba(255,255,255,.04);cursor:zoom-in;}
  .bz-ff-half + .bz-ff-half{border-left:1px solid rgba(0,0,0,.55);}
  .bz-ff-half.bz-ff-dilate{box-shadow:inset 0 0 0 1.5px rgba(10,132,255,.6);}
  .bz-ff-half img{width:100%;height:100%;object-fit:cover;display:block;}
  /* [每格一路小视频] 后端按人推的 animated WebP 盖在同一半格的静图上面：
     静图是「还没收到动画」时的海报，动画到了就接管这一格。absolute 而不是
     替换 img，是为了不动格子的形状推导（行高=半格宽的正方形规则只有一处）。 */
  .bz-ff-anim{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;
    z-index:1;display:block;background:#000;}
  .bz-ff-half .tag{position:absolute;left:3px;bottom:3px;z-index:2;font-size:9px;color:#fff;
    background:rgba(0,0,0,.6);padding:0 5px;border-radius:5px;}
  .bz-ff-badge{position:absolute;right:3px;top:3px;font-size:9px;line-height:1;
    color:#fff;background:rgba(10,132,255,.92);padding:3px 5px;border-radius:5px;
    font-weight:600;z-index:2;}
  .bz-ff-half .none{position:absolute;inset:0;display:flex;align-items:center;
    justify-content:center;font-size:10px;color:rgba(255,255,255,.28);}
  .bz-ff-empty{display:flex;align-items:center;justify-content:center;
    min-height:var(--bz-tile-h,${TILE_H}px);
    font-size:12px;color:rgba(255,255,255,.4);text-align:center;line-height:1.6;white-space:pre-line;
    grid-column:1 / -1;}
  /* [状态全文直显] 报告每段一行、高度随内容推导（节点底边跟随内容长高）；
     margin-top:auto 让状态区始终贴面板底部，节点被拉高时下方不留空洞。 */
  .bz-ff-status-wrap{min-height:${STATUS_H}px;flex:none;margin-top:auto;display:flex;
    align-items:center;}
  .bz-ff-status{flex:1;min-width:0;font-size:10.5px;color:rgba(255,255,255,.55);
    line-height:20px;box-sizing:border-box;white-space:pre-line;word-break:break-all;}
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
      // 提示词与数值参数都由面板自绘，原生 widget 收起来只留值
      const HIDDEN_WIDGETS = ["project_data", "sam3_prompt",
        "sam3_threshold", "steps", "denoise", "feather",
        "裁剪模式", "包边比例", "放大百万像素", "crop_padding", "crop_long_edge"];
      function bindWidgets() {
        for (const name of HIDDEN_WIDGETS) {
          const w = (node.widgets || []).find((x) => x.name === name);
          if (!w) continue;
          wMap[name] = w;
          if (name === "project_data") {
            // 工作流保留完整回执；队列只提交工程输入，避免回执改变采样缓存键。
            w.serializeValue = () => {
              let data;
              try { data = JSON.parse(w.value || "{}"); } catch (_) { return ""; }
              if (!data || typeof data !== "object" || Array.isArray(data)) return "";
              for (const key of ["faces", "backend", "last_report", "last_detail", "modules"]) delete data[key];
              return Object.keys(data).length ? JSON.stringify(data) : "";
            };
          }
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
      promptInput.title = "SAM3.1 开放词汇提示词，默认 human face；改「人脸」等同义也行";
      const dot = el("span", "bz-ff-dot", toolbar);

      // ── 参数条：阈值 / 外扩 / 强度（原生 widget 已隐藏，这里代理）──
      const numInputs = {};
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
        for (const name of ["sam3_threshold", "steps", "denoise", "feather",
                            "crop_padding", "crop_long_edge"]) {
          const w = wMap[name];
          const inp = numInputs[name];
          if (!w || !inp) continue;
          const step = parseFloat(inp.step) || 1;
          if (Number(w.value) < 0) {
            inp.value = "";
            inp.placeholder = "旧值";
            continue;
          }
          inp.value = step < 1 ? Number(w.value).toFixed(2) : String(Math.round(Number(w.value)));
        }
      }
      // [存档自愈] widget 值按顺序存档：增删参数后旧工程会整排错位（上轮
      // blend 拿到 384 就是这原因），超出 min/max 的在这里复位成默认，
      // 免得执行期被后端校验拦下。
      const WIDGET_DEFAULTS = { "sam3_threshold": 0.5, steps: 4, denoise: 0.3,
        feather: 8, crop_padding: -1, crop_long_edge: -1 };
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
        paramsFromWidgets();
        if (changed) node.graph?.change?.();
      }

      const params = el("div", "bz-ff-params", root);
      const row1 = el("div", "bz-ff-prow", params);
      numField(row1, "外扩", "crop_padding", -1, 512, 1).title =
        "单位 px，裁剪框四周各外扩的原片像素数；0 为不外扩，-1 使用包边比例。";
      numField(row1, "长边", "crop_long_edge", -1, 4096, 16).title =
        "单位 px，仅放大到该长边下限，不缩小；0 为原尺寸对齐，-1 使用放大百万像素。";
      numField(row1, "阈值", "sam3_threshold", 0.05, 0.95, 0.05);
      numField(row1, "步数", "steps", 1, 30, 1);
      numField(row1, "降噪", "denoise", 0.05, 1, 0.05);
      numField(row1, "羽化", "feather", 0, 64, 4);
      sanitizeWidgets();

      // ── 人脸缩略图卡片 ─────────────────────────────────────────
      const card = el("div", "bz-ff-card", root);
      const head = el("div", "bz-ff-head", card);
      el("div", "bz-ff-auto", head).textContent = "全自动";
      const count = el("div", "bz-ff-count", head);
      // 预览带只在这里建 DOM；播放与高度并入的代码在下面（那时布局函数才初始化完）
      const pv = el("div", "bz-ff-pv", card);
      const pvImg = document.createElement("img");
      pvImg.alt = "";
      const pvVid = document.createElement("video");
      pvVid.muted = true;
      pvVid.loop = true;
      pvVid.playsInline = true;
      /* 不设 autoplay：只有收到新画面才显式 play，避免 DOM 重建时自己播起来。 */
      pvVid.preload = "auto";
      pvVid.setAttribute("muted", "");
      pvVid.setAttribute("playsinline", "");
      const pvCap = el("span", "cap", pv);
      pv.append(pvImg, pvVid);
      const grid = el("div", "bz-ff-grid", card);

      const statusWrap = el("div", "bz-ff-status-wrap", root);
      const statusLine = el("div", "bz-ff-status", statusWrap);

      function setStatus(text, tone) {
        statusLine.textContent = text;
        dot.className = "bz-ff-dot" + (tone === "busy" ? " busy" : tone === "err" ? " err" : "");
      }
      // 报告全文直显：每段一行；⚠️/❌ 开头点亮红点
      function showReport(full) {
        const s = String(full || "");
        if (!s) return;
        setStatus(s.split(/[｜\n]/).filter(Boolean).join("\n"),
                  s.startsWith("⚠️") || s.startsWith("❌") ? "err" : "");
      }

      // 提示词：面板输入框 ↔ 隐藏 widget 双向同步（值随工作流存档走）
      function promptFromWidget() {
        const w = wMap.sam3_prompt;
        promptInput.value = (w && w.value) || "human face";
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

      // 卡片高度 = 表头 + 行数×行高 + 行间距。行高取「半格宽度」，让每个预览
      // 严格正方形：一格左右两半（前/后），中间 1px 分隔线，所以半格宽 =(格宽-1)/2。
      // 挂载后直接量 grid 实际宽度，量不到（未挂载/折叠）才按节点宽度算。
      let tileH = TILE_H;
      let pvH = 0;            // 预览带高：0 = 带子不显示（不进高度推导）
      function measureTileH() {
        const gapAll = (COLS - 1) * GAP;
        let inner;
        if (grid && grid.clientWidth > 0) {
          inner = grid.clientWidth - gapAll;
        } else {
          const w = Number(node.width) > 0 ? Number(node.width) : wantWidth();
          // 节点宽 - 根 padding×2 - 卡片 padding×2 - 卡片描边×2
          inner = w - PAD * 4 - 2 - gapAll;
        }
        return Math.max(48, Math.min(200, Math.round((inner / COLS - 1) / 2)));
      }
      function applyTileH() {
        const h = measureTileH();
        if (h === tileH) return false;
        tileH = h;
        if (root) root.style.setProperty("--bz-tile-h", h + "px");
        return true;
      }
      // 预览带按内容宽推 16:9，封顶 PV_MAX_H。与人脸格用同一个宽度基准，
      // 所以拉宽节点时两者一起变，不会出现「格子已经到底、预览还有一半空」。
      function measurePvH() {
        let w;
        if (grid && grid.clientWidth > 0) {
          w = grid.clientWidth;
        } else {
          const nw = Number(node.width) > 0 ? Number(node.width) : wantWidth();
          w = nw - PAD * 4 - 2;                 // 卡片内容宽（含列间距）
        }
        return Math.max(56, Math.min(PV_MAX_H, Math.round(w * 9 / 16)));
      }
      function applyPvH() {
        const h = pv.classList.contains("is-on") ? measurePvH() : 0;
        if (h === pvH) return false;
        pvH = h;
        if (root) root.style.setProperty("--bz-pv-h", h + "px");
        return true;
      }
      function cardHeight() {
        const n = (state.project.faces || []).length;
        const rows = Math.min(MAX_ROWS, Math.max(1, Math.ceil(n / COLS)));
        // 带子出现时多占「带高 + 它的下间距」，这条是节点高度的唯一真值来源
        const pvBlock = pvH > 0 ? pvH + GAP : 0;
        return HEAD_H + pvBlock + rows * tileH + (rows - 1) * GAP + PAD * 2;
      }
      function panelHeight() {
        // 状态区高度实测（全文直显随内容长高），未挂载/折叠时兜底最小高
        const stH = Math.max(STATUS_H, statusWrap.offsetHeight || 0);
        return PAD * 2 + TOOLBAR_H + 6 + PARAMS_H + 8 + cardHeight() + stH;
      }
      function wantWidth() {
        return Math.max(node.properties[W_KEY] || PANEL_W, MIN_W);
      }
      // 节点高度必须自己把「输入端口占的行高」加回来：面板是从端口之后开始铺的，
      // 少算这段，面板下半截就顶出节点边框（2026-11-21 下午截图：状态区整截溢在
      // 边框外）。但行数只能数**真端口**——这套前端给后端 schema 里每个输入都留了
      // 一条 slot 记录，连纯参数（project_data…feather 共 9 个）也在内，直接数
      // node.inputs.length 会多算 9 行 → 底部空一大截（同日上午「预留太大」的根因）。
      // 真端口 = 没被 widget 吃掉的那几个，或已被转成输入、带连线的。
      // 不再按「是不是 v2 前端」分叉：分叉判据是猜的，端口占不占行只取决于这张
      // slot 表本身，两套引擎同一条算式（旧引擎另给 widgets_start_y 兜底）。
      function portRows() {
        const widgeted = new Set((node.widgets || []).map((w) => String(w?.name || "")));
        let rows = 0;
        for (const i of node.inputs || []) {
          if (i.link != null || !widgeted.has(String(i?.name || ""))) rows += 1;
        }
        return rows;
      }
      function contentTop() {
        const title = LiteGraph.NODE_TITLE_HEIGHT || 30;
        const bySlots = title + Math.max(1, portRows()) * (LiteGraph.NODE_SLOT_HEIGHT || 20);
        const y = node.widgets_start_y;
        return (typeof y === "number" && y > 0) ? Math.max(y, bySlots) : bySlots;
      }
      function nodeHeight() {
        return contentTop() + panelHeight();
      }
      function applySize() {
        applyTileH();                       // 先按当前宽度定正方形行高
        applyPvH();                         // 再定预览带高（不带子时为 0，不占位）
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
        slots.clear();                 // 格子重建，动画层要重新挂（缓存里的小视频还在）
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
            // [包边可视化] 后图在包边>1 时蓝色描边 + 徽章，修复范围状态一眼可见
            if (isAfter && Number(wMap.crop_padding?.value ?? -1) < 0) {
              const cs = Math.round(Number(wMap["包边比例"]?.value ?? 1));
              if (cs > 1) {
                d.classList.add("bz-ff-dilate");
                el("span", "bz-ff-badge", d).textContent = "包边 ×" + cs;
              }
            }
            return d;
          };
          slots.set(Number(f.index ?? i), {
            before: half(f.thumb, "前", false),
            after: half(f.thumb_after || f.thumb, "后", true),
          });
        });
        syncAnims();                   // 重建后把已收到的小视频立刻挂回去
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
        showReport(rep);
        applySize();
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
        setStatus(errTxt, "err");
        applySize();
      };
      api.addEventListener("execution_error", onErrHandler);
      chain(node, "onRemoved", function () {
        api.removeEventListener("executed", onExecHandler);
        api.removeEventListener("execution_error", onErrHandler);
        api.removeEventListener("banzhang_facefix_preview", onFfPreview);
        stopFaceLoop();
        api.removeEventListener("minimax_h3_preview_override", onH3Step);
        document.removeEventListener("visibilitychange", onDocVis);
        if (pvIo) pvIo.disconnect();
        stopPvVideo();
        if (pvUrl) { try { URL.revokeObjectURL(pvUrl); } catch { /* 已回收 */ } pvUrl = null; }
        animCache.forEach((rec) => Object.values(rec).forEach(
          (u) => { try { URL.revokeObjectURL(u); } catch { /* 已回收 */ } }));
        animCache.clear();
        slots.clear();
      });

      // ── 运行时动画预览：播放与事件 ─────────────────────────────
      /* 后端两条通道，payload 字段同一套（image=base64、mime、rate=回放倍速）：
         · banzhang_facefix_preview     本节点自己的「修复前 / 修复后」循环 + 阶段字幕
         · minimax_h3_preview_override  采样每一步的动画（复用「班长 MiniMax H3 预览
           覆盖」的实现：每步用 H3 官方 TAE 小解码器解 24 格 → 后台线程编动画），
           导演台也走这个事件名，所以两个监听都必须按 node_id 过滤，不然互相串台。
         播放全部交给浏览器原生解码：animated WebP 用 <img>（按内嵌帧延时自动循环）、
         MP4 用 <video loop>（playbackRate 抹平到 1:1）。JS 只在收到新画面时换一次
         src —— 没有 setInterval、没有 requestAnimationFrame、不逐帧 post。 */
      let pvUrl = null;
      let pvKind = null;        // "img" | "video"
      let pvVisible = true;     // 节点在不在视口里
      const stopPvVideo = () => {
        try { pvVid.pause(); } catch { /* 还没有源 */ }
        pvVid.removeAttribute("src");
        try { pvVid.load(); } catch { /* 空源时部分内核会抛 */ }
      };
      const b64ToBlob = (b64, mime) => {
        const bin = atob(b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return new Blob([bytes], { type: mime || "image/webp" });
      };
      function showPv(on) {
        // 解码源只供各人脸小框取画面，上方不再占用预览面积。
        pv.classList.remove("is-on");
      }
      function setPv(b64, mime, rate, cap) {
        if (!b64) return;
        const isMp4 = mime === "video/mp4";
        let url;
        try { url = URL.createObjectURL(b64ToBlob(b64, mime)); } catch { return; }
        const prev = pvUrl;
        pvUrl = url;
        pvKind = isMp4 ? "video" : "img";
        /* 换源前先把另一层摘干净：两层同挂会各自解码，白白烧一倍。 */
        pvImg.classList.remove("is-on");
        pvImg.removeAttribute("src");
        stopPvVideo();
        if (isMp4) {
          const r = Number(rate);
          const go = () => {
            if (Number.isFinite(r) && r > 0) {
              try { pvVid.playbackRate = r; } catch { /* 内核不支持就按原速 */ }
            }
            const p = pvVid.play();
            if (p && p.catch) p.catch(() => { /* 无手势自动播放被拦：静帧仍在 */ });
          };
          pvVid.onloadedmetadata = go;
          pvVid.classList.add("is-on");
          pvVid.src = url;
          go();
        } else {
          pvImg.classList.add("is-on");
          pvImg.src = url;
        }
        if (cap != null) pvCap.textContent = cap;
        if (prev) setTimeout(() => { try { URL.revokeObjectURL(prev); } catch { /* 已回收 */ } }, 0);
        showPv(true);
      }
      /* 看不见就别解：animated WebP 在浏览器里是持续解码的，节点滚出画面、
         页面切后台、或者被折叠（DOM 容器 display:none → 观察器报不相交）之后
         还照烧 CPU 说不过去。只在真进出视口时回调一次，不轮询。 */
      function gatePv() {
        syncAnims();          // 各脸的小视频与带子共用同一条可见性规则
        if (!pvUrl) return;
        const hold = pvVisible && !document.hidden;
        if (hold) {
          if (pvKind === "video") {
            if (!pvVid.getAttribute("src")) {
              pvVid.src = pvUrl;
              const p = pvVid.play();
              if (p && p.catch) p.catch(() => { /* 同上 */ });
            }
          } else if (!pvImg.getAttribute("src")) pvImg.src = pvUrl;
          return;
        }
        if (pvKind === "video") stopPvVideo();
        else pvImg.removeAttribute("src");
      }
      const pvIo = ("IntersectionObserver" in window)
        ? new IntersectionObserver((es) => {
            const on = es.length > 0 && es[es.length - 1].isIntersecting;
            if (on === pvVisible) return;
            pvVisible = on;
            gatePv();
          }, { threshold: 0.01 })
        : null;
      if (pvIo) pvIo.observe(root);
      const onDocVis = () => gatePv();
      document.addEventListener("visibilitychange", onDocVis);

      /* 每人一路小视频：后端在检出之后推「修复前」循环、贴回完成后推「修复后」
         循环，分别落在同一格的左半与右半。静图保留当海报（动画没到也看得见构图），
         动画层 absolute 盖在上面 → 不影响「行高=半格宽」的正方形推导。 */
      const slots = new Map();      // faceIndex → { before, after } 两个半格元素
      const animCache = new Map();  // faceIndex → { before: url, after: url }
      function animLayer(host, url) {
        let a = host.querySelector("img.bz-ff-anim");
        if (!a) {
          a = document.createElement("img");
          a.className = "bz-ff-anim";
          a.alt = "";
          a.draggable = false;
          host.appendChild(a);
        }
        a.style.display = url ? "" : "none";
        if (url) { if (a.getAttribute("src") !== url) a.src = url; }
        else a.removeAttribute("src");
      }
      // 「谁该播」只判一次：可见性 × 缓存。格子重建（renderFaces）也走这里，
      // 所以刷新/重排之后动画不会丢，也不会出现两份在播。
      function syncAnims() {
        const hold = pvVisible && !document.hidden;
        slots.forEach((host, i) => {
          const rec = animCache.get(i) || {};
          if (host.before) animLayer(host.before, hold ? rec.before : null);
          if (host.after) animLayer(host.after, hold ? rec.after : null);
        });
      }
      function faceAnim(index, faceKind, b64, mime) {
        if (!Number.isInteger(index)) return;
        if (faceKind !== "before" && faceKind !== "after") return;
        if (!b64) return;
        let url;
        try { url = URL.createObjectURL(b64ToBlob(b64, mime || "image/webp")); } catch { return; }
        if (index === 0 && faceKind === "before") {
          // 新一轮的第一个「修复前」= 上一轮整批作废，不给旧 blob 留底
          animCache.forEach((rec) => Object.values(rec).forEach(
            (u) => { try { URL.revokeObjectURL(u); } catch { /* 已回收 */ } }));
          animCache.clear();
        }
        const rec = animCache.get(index) || {};
        const prev = rec[faceKind];
        rec[faceKind] = url;
        animCache.set(index, rec);
        if (prev) setTimeout(() => { try { URL.revokeObjectURL(prev); } catch { /* 已回收 */ } }, 0);
        syncAnims();
      }

      const onFfPreview = (e) => {
        const d = e && e.detail;
        if (!d || String(d.node_id) !== String(node.id)) return;
        if (d.kind === "stage") {
          /* 进度字幕落到底部状态行，不放预览带里：带子只在采样阶段才出现，
             检测/编码那两分钟没带子，字幕得有地方说「现在在干什么」。
             跑完 executed 会用最终报告覆盖这一行，蓝点跟着变回绿/红。 */
          setStatus("⏳ " + String(d.text || ""), "busy");
          if (["完成", "已回退原片", "准备中"].includes(d.text)) stopFaceLoop();
          if (d.text === "准备中") {
            liveLayout = null;
            animCache.forEach(rec => Object.values(rec).forEach(url => URL.revokeObjectURL(url)));
            animCache.clear();
            state.project.faces = [];
            renderFaces();
          }
          return;
        }
        if (d.kind === "layout") {
          liveLayout = d;
          return;
        }
        // 整片画面不再往带子上放：带子只留「每步解码出的裁剪区域」，
        // 各张脸的实时画面在格子里，那里才是该看的地方。
        if (d.kind === "face") {
          const index = Number(d.face_index);
          if (d.face_kind === "before" && !slots.has(index)) {
            state.project.faces ||= [];
            state.project.faces.push({index, thumb: null, thumb_after: null});
            renderFaces();
          }
          faceAnim(index, d.face_kind, d.image, d.mime);
        }
      };
      let liveLayout = null, faceRaf = 0, stepStarted = 0;
      function stopFaceLoop() {
        cancelAnimationFrame(faceRaf);
        faceRaf = 0;
        slots.forEach(host => host.after?.querySelector("canvas")?.remove());
      }
      function drawFaces(now) {
        faceRaf = requestAnimationFrame(drawFaces);
        if (!pvVisible || document.hidden || !liveLayout || !pvUrl) return;
        const source = pvKind === "video" ? pvVid : pvImg;
        const w = source.videoWidth || source.naturalWidth, h = source.videoHeight || source.naturalHeight;
        if (!w || !h) return;
        const duration = Number(liveLayout.duration) || 1;
        const phase = pvKind === "video" && pvVid.duration > 0 ?
          pvVid.currentTime / pvVid.duration : ((now - stepStarted) / 1000 % duration) / duration;
        for (const face of liveLayout.faces || []) {
          const host = slots.get(face.index)?.after;
          if (!host) continue;
          const regions = face.regions || [];
          const box = regions[Math.min(regions.length - 1, Math.floor(phase * regions.length))];
          let canvas = host.querySelector("canvas");
          if (!box) { if (canvas) canvas.style.visibility = "hidden"; continue; }
          if (!canvas) {
            canvas = document.createElement("canvas");
            canvas.width = canvas.height = 128;
            canvas.className = "bz-ff-anim";
            host.appendChild(canvas);
          }
          canvas.style.visibility = "";
          const side = Math.min(w, h, Math.max((box[2]-box[0])*w, (box[3]-box[1])*h)*1.4);
          const x = Math.max(0, Math.min(w-side, (box[0]+box[2])*w/2-side/2));
          const y = Math.max(0, Math.min(h-side, (box[1]+box[3])*h/2-side/2));
          canvas.getContext("2d").drawImage(source, x, y, side, side, 0, 0, 128, 128);
        }
      }
      const onH3Step = (e) => {
        const d = e && e.detail;
        if (!d || !d.image || String(d.node_id) !== String(node.id)) return;
        setPv(d.image, d.mime, d.rate, "采样 " + d.step + "/" + d.total);
        stepStarted = performance.now();
        setStatus("⏳ 采样 " + d.step + "/" + d.total, "busy");
        if (!faceRaf) faceRaf = requestAnimationFrame(drawFaces);
      };
      api.addEventListener("banzhang_facefix_preview", onFfPreview);
      api.addEventListener("minimax_h3_preview_override", onH3Step);

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
          // 用户亲手拖：只记宽度真值，高度由内容推导，松手后下次渲染再对齐。
          // 行高跟着宽度走（正方形），所以拖宽/拖窄时当场重算一次，否则
          // 松手前那几秒预览会被拉成长方形。
          node.properties[W_KEY] = Math.round(size[0]);
          if (applyTileH()) card.style.height = cardHeight() + "px";
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

      chain(node, "onConfigure", function (data) {
        bindWidgets();
        // 新参数追加在末尾，旧工作流继续按原来的比例和 MP 计算。
        if (data?.widgets_values?.length <= 9) {
          if (wMap.crop_padding) wMap.crop_padding.value = -1;
          if (wMap.crop_long_edge) wMap.crop_long_edge.value = -1;
        }
        promptFromWidget();
        paramsFromWidgets();
        const raw = node.properties?.facefix_project;
        if (raw) {
          try {
            state.project = JSON.parse(raw);
            renderAll();
            // 刷新后报告照旧可见：存档里带着上次的 last_report，不用重跑
            showReport(state.project.last_report);
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
