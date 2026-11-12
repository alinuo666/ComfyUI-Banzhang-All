// ═══════════════════════════════════════════════
// 🔀 互斥选路器 (BanZhang_RouteSwitch) 前端
// 物理端口 input_1..input_N 为唯一端口视觉（左侧），输出在右侧
// 面板 = 路数 stepper + 每路一个原生 toggle（选中态由框架渲染，不画 canvas）
// 点开关选路 · 双击端口 label 改名
// ═══════════════════════════════════════════════

const { app } = window.comfyAPI.app;

const MAX_ROUTES = 8;
const MIN_ROUTES = 2;
const DEFAULT_LABELS = ["输入1", "输入2", "输入3", "输入4", "输入5", "输入6", "输入7", "输入8"];

// ── 样式注入（仅路数 stepper 面板用）──────────
(function injectCss() {
    const ID = "banzhang-route-switch-css";
    if (document.getElementById(ID)) return;
    const s = document.createElement("style");
    s.id = ID;
    s.textContent = `
.bzrs-wrap{width:100%;padding:6px 6px 4px;box-sizing:border-box;
  font-family:'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif}
.bzrs-stepper{display:flex;align-items:center;justify-content:space-between;
  padding:2px 4px;font-size:11px;color:#8a8f99}
.bzrs-stepper .bzrs-num{color:#e8e8e8;font-weight:600;font-size:13px;min-width:18px;text-align:center}
.bzrs-stepper button{width:18px;height:18px;border-radius:4px;border:1px solid #3a3d45;
  background:transparent;color:#8a8f99;font-size:13px;line-height:1;cursor:pointer;padding:0}
.bzrs-stepper button:hover{border-color:#0A84FF;color:#0A84FF}
.bzrs-stepper button:disabled{opacity:.35;cursor:not-allowed}
.bzrs-dots{display:flex;gap:6px;padding:8px 4px 2px;flex-wrap:wrap}
.bzrs-dot{width:24px;height:24px;border-radius:50%;border:1px solid #3a3d45;background:transparent;
  color:#8a8f99;font-size:11px;line-height:1;cursor:pointer;padding:0;
  transition:background .12s,border-color .12s,color .12s}
.bzrs-dot:hover{border-color:#0A84FF;color:#0A84FF}
.bzrs-dot.active{background:#0A84FF;border-color:#0A84FF;color:#fff}
.bzrs-rename{position:fixed;font-size:12px;background:#22242a;color:#e8e8e8;
  border:1px solid #0A84FF;border-radius:3px;padding:1px 5px;outline:none;
  font-family:inherit;z-index:10000}
`;
    document.head.appendChild(s);
})();

function getW(node, name) {
    return node.widgets?.find((w) => w.name === name);
}

// ── 标签持久化 ─────────────────────────────────
function getLabels(node) {
    let labels = null;
    if (node.properties && Array.isArray(node.properties.bzrs_labels)) {
        labels = node.properties.bzrs_labels.slice(0, MAX_ROUTES);
    }
    if (!labels || labels.length < MIN_ROUTES) labels = DEFAULT_LABELS.slice();
    while (labels.length < MAX_ROUTES) {
        labels.push(DEFAULT_LABELS[labels.length] || `输入${labels.length + 1}`);
    }
    return labels;
}

function saveLabels(node) {
    if (!node.properties) node.properties = {};
    node.properties.bzrs_labels = node._bzrsLabels.slice(0, MAX_ROUTES);
}

// ── 端口 label 钉名 ────────────────────────────
function syncSlotLabels(node) {
    if (!node.inputs) return;
    node.inputs.forEach((slot) => {
        if (slot.name && slot.name.startsWith("input_")) {
            const idx = parseInt(slot.name.split("_")[1], 10) - 1;
            if (idx >= 0 && node._bzrsLabels[idx]) {
                slot.label = node._bzrsLabels[idx];
            }
        }
    });
    // 圆钮的 hover 提示跟着端口名走，改名后一致
    syncDots(node);
}

// ── 取每个输入端口行的真实 y（节点本地坐标）────
function getSlotY(node, i) {
    const slot = node.inputs?.[i];
    if (slot && Array.isArray(slot.pos) && slot.pos[1] > 0) return slot.pos[1];
    // fallback：标题高 + 行高推算
    const th = LiteGraph.NODE_TITLE_HEIGHT || 30;
    const sh = LiteGraph.NODE_SLOT_HEIGHT || 20;
    return th + i * sh + sh / 2;
}

// ── 动态端口增减 ───────────────────────────────
function syncInputs(node) {
    const count = Math.max(MIN_ROUTES, Math.min(MAX_ROUTES, getW(node, "count")?.value ?? 3));
    if (!node.inputs) node.inputs = [];
    const cur = node.inputs.filter((s) => s.name && s.name.startsWith("input_")).length;
    if (count === cur) { syncSlotLabels(node); return; }

    if (count < cur) {
        for (let i = cur; i > count; i--) {
            const slot = node.inputs.find((s) => s.name === `input_${i}`);
            if (slot) {
                const idx = node.inputs.indexOf(slot);
                if (idx >= 0) node.removeInput(idx);
            }
        }
    } else {
        for (let i = cur + 1; i <= count; i++) node.addInput(`input_${i}`, "*");
    }
    syncSlotLabels(node);
}

// ── 选中：唯一入口，同时对齐圆钮与 selected ────
function selectRoute(node, idx) {
    const count = getW(node, "count")?.value ?? 3;
    const i = Math.max(0, Math.min(idx, count - 1));
    const sel = getW(node, "selected");
    if (sel) sel.value = i + 1;
    syncDots(node);
    node.setDirtyCanvas(true, true);
}

/* 20261111 用户定：互斥器**只手动切换**，不做任何自动联动。
   阶段 3 曾在这里挂过一个全局联动入口给导演台推送用，已整套删除。
   selectRoute() 保持本文件唯一选路入口（圆钮 / widget / 标签
   三处一次对齐），只由节点面板上的圆钮与原生 toggle 触发。 */

// 路数文本与 +/− 禁用态由 count 单向推导 —— 读档、加减、新建都走这一处
function syncStepper(node) {
    const count = getW(node, "count")?.value ?? 3;
    const numEl = node._bzrsStepper?.querySelector(".bzrs-num");
    if (numEl) numEl.textContent = count;
    const btns = node._bzrsStepper?.querySelectorAll(".bzrs-stepper button");
    if (btns && btns.length >= 2) {
        btns[0].disabled = count <= MIN_ROUTES;
        btns[1].disabled = count >= MAX_ROUTES;
    }
}

// 按路数显隐圆钮、点亮选中那颗；title 用改名后的标签
function syncDots(node) {
    const count = getW(node, "count")?.value ?? 3;
    const raw = (getW(node, "selected")?.value ?? 1) - 1;
    const sel = Math.max(0, Math.min(raw, count - 1));   // 只为显示，不写回数据
    (node._bzrsDots || []).forEach((b, i) => {
        b.style.display = i < count ? "" : "none";
        b.classList.toggle("active", i === sel);
        b.title = (node._bzrsLabels || [])[i] || `输入${i + 1}`;
    });
}

// ── 路数 stepper DOM 面板（只负责路数，不重复端口）
function buildStepperPanel(node) {
    const wrap = document.createElement("div");
    wrap.className = "bzrs-wrap";
    wrap.addEventListener("mousedown", (e) => e.stopPropagation());
    wrap.addEventListener("keydown", (e) => e.stopPropagation());

    const st = document.createElement("div");
    st.className = "bzrs-stepper";
    const count = getW(node, "count")?.value ?? 3;

    const minus = document.createElement("button");
    minus.textContent = "−";
    minus.disabled = count <= MIN_ROUTES;
    const num = document.createElement("span");
    num.className = "bzrs-num";
    num.textContent = count;
    const plus = document.createElement("button");
    plus.textContent = "+";
    plus.disabled = count >= MAX_ROUTES;

    minus.onclick = () => changeCount(node, -1);
    plus.onclick = () => changeCount(node, +1);

    st.append(document.createElement("span").appendChild(document.createTextNode("路数")).parentNode,
              (() => { const c = document.createElement("span");
                       c.style.cssText = "display:flex;gap:8px;align-items:center";
                       c.append(minus, num, plus); return c; })());
    wrap.appendChild(st);

    // 圆钮行：数字 = 端口序号，点哪颗选哪路
    const row = document.createElement("div");
    row.className = "bzrs-dots";
    node._bzrsDots = [];
    for (let i = 0; i < MAX_ROUTES; i++) {
        const b = document.createElement("button");
        b.className = "bzrs-dot";
        b.textContent = String(i + 1);
        b.onclick = () => selectRoute(node, i);
        row.appendChild(b);
        node._bzrsDots.push(b);
    }
    wrap.appendChild(row);

    node._bzrsStepper = wrap;
    return wrap;
}

function changeCount(node, delta) {
    const cw = getW(node, "count");
    if (!cw) return;
    cw.value = Math.max(MIN_ROUTES, Math.min(MAX_ROUTES, (cw.value ?? 3) + delta));
    const sw = getW(node, "selected");
    if (sw) sw.value = Math.max(1, Math.min(cw.value, sw.value ?? 1));
    syncInputs(node);
    syncStepper(node);
    syncDots(node);
    // 只改高度，宽度保留用户拉出来的值
    node.setSize([node.size[0], node.computeSize()[1]]);
    node.setDirtyCanvas(true, true);
}

// ── 隐藏原生 widget ────────────────────────────
function hideWidgets(node) {
    ["count", "selected"].forEach((name) => {
        const w = getW(node, name);
        if (w) {
            w.hidden = true;
            w.computeSize = () => [0, -4];
            w.draw = () => {};
            w.mouse = () => {};
        }
    });
}

// ── 双击改名：在 label 位置弹 DOM input ────────
function startRename(node, idx) {
    const canvas = app.canvas;
    const y = getSlotY(node, idx);
    // 屏幕坐标 = rect 原点 + (图坐标 + offset) * scale；fixed 定位直接吃视口坐标
    const scale = canvas.ds.scale;
    const rect = canvas.canvas.getBoundingClientRect();
    const sx = rect.left + (node.pos[0] + 14 + canvas.ds.offset[0]) * scale;
    const sy = rect.top + (node.pos[1] + y + canvas.ds.offset[1]) * scale;

    const input = document.createElement("input");
    input.className = "bzrs-rename";
    input.value = node._bzrsLabels[idx] || "";
    input.maxLength = 16;
    input.style.left = sx + "px";
    input.style.top = (sy - 10) + "px";
    input.style.width = Math.max(90, node.size[0] * scale - 30) + "px";
    document.body.appendChild(input);
    input.focus();
    input.select();

    const commit = () => {
        const v = input.value.trim();
        if (v) {
            node._bzrsLabels[idx] = v;
            saveLabels(node);
            syncSlotLabels(node);
        }
        input.remove();
        node.setDirtyCanvas(true, true);
    };
    input.addEventListener("blur", commit);
    input.addEventListener("keydown", (e) => {
        e.stopPropagation();
        if (e.key === "Enter") input.blur();
        if (e.key === "Escape") { input.value = node._bzrsLabels[idx] || ""; input.blur(); }
    });
}

// ── 初始化 ────────────────────────────────────
function setupNode(node) {
    hideWidgets(node);
    node._bzrsLabels = getLabels(node);
    syncInputs(node);

    // 1) 路数 stepper + 圆钮行（同一个 DOM 面板）
    const panel = buildStepperPanel(node);
    node._bzrsDomW = node.addDOMWidget("路数控件", "route_count", panel, { serialize: false });
    // 高度写死：setup 时元素还没进文档，量 offsetHeight 会得到 0，节点会被压扁
    node._bzrsDomW.computeSize = () => [node.size[0] - 20, 72];
    syncStepper(node);
    syncDots(node);

    // 仅用于双击改名时反查节点
    node._bzrsRouteNode = true;

    node.size[0] = Math.max(node.size[0] ?? 0, 220);
    node.setSize(node.computeSize());
}

app.registerExtension({
    name: "banzhang.route.switch",
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== "BanZhang_RouteSwitch") return;

        const onCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const r = onCreated ? onCreated.apply(this, arguments) : undefined;
            setupNode(this);
            return r;
        };

        const onConfigure = nodeType.prototype.configure;
        nodeType.prototype.configure = function (info) {
            const r = onConfigure ? onConfigure.apply(this, arguments) : undefined;
            hideWidgets(this);
            this._bzrsLabels = getLabels(this);
            syncInputs(this);
            syncStepper(this);
            syncDots(this);
            // 存档里的路数与端口数可能和新建时不同，高度必须按读到的值重算
            this.setSize([this.size[0], this.computeSize()[1]]);
            return r;
        };
    },
});

// ═══════════════════════════════════════════════
// 全局事件：v2 前端不调节点 onMouseDown/onDblClick，
// 改用 document 捕获 + 画布坐标反查节点
// ═══════════════════════════════════════════════

// 屏幕坐标 → 图坐标
// 换算公式由 litegraph 的 ds 定义：graph = screen / scale - offset（反向：screen = (graph + offset) * scale）
// 手写容易漏 offset 已随 scale 归一这一步，优先用画布自带的官方换算
function toGraphPos(e) {
    const canvas = app.canvas;
    if (typeof canvas.convertEventToCanvasOffset === "function") {
        const p = canvas.convertEventToCanvasOffset({ clientX: e.clientX, clientY: e.clientY });
        if (p) return [p[0], p[1]];
    }
    const rect = canvas.canvas.getBoundingClientRect();
    return [
        (e.clientX - rect.left) / canvas.ds.scale - canvas.ds.offset[0],
        (e.clientY - rect.top) / canvas.ds.scale - canvas.ds.offset[1],
    ];
}

// 找到坐标下的 RouteSwitch 节点，并返回节点本地坐标
function pickRouteNode(e) {
    const [gx, gy] = toGraphPos(e);
    const nodes = (app.graph && (app.graph._nodes || app.graph.nodes)) || [];
    for (const node of nodes) {
        if (!node || !node._bzrsRouteNode) continue;
        if (gx >= node.pos[0] && gx <= node.pos[0] + node.size[0] &&
            gy >= node.pos[1] && gy <= node.pos[1] + node.size[1]) {
            return { node, local: [gx - node.pos[0], gy - node.pos[1]] };
        }
    }
    return null;
}

// 本地 y 坐标 → 端口行索引
function pickSlotIndex(node, localY) {
    const n = node.inputs?.filter((s) => s.name?.startsWith("input_")).length || 0;
    const sh = LiteGraph.NODE_SLOT_HEIGHT || 20;
    for (let i = 0; i < n; i++) {
        if (Math.abs(localY - getSlotY(node, i)) < sh / 2) return i;
    }
    return -1;
}

// 单击选路已交给原生 toggle 行，这里不再监听 click —— 画布上不画任何行状态，也就没有坐标可算错

// 双击：改名（仍由画布反查端口行，公式走官方 convertEventToCanvasOffset）
document.addEventListener("dblclick", (e) => {
    if (e.target.closest?.(".bzrs-rename")) return;
    const hit = pickRouteNode(e);
    if (!hit) return;
    const idx = pickSlotIndex(hit.node, hit.local[1]);
    if (idx >= 0) {
        e.stopPropagation();
        startRename(hit.node, idx);
    }
}, true);

