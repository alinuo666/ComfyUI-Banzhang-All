// 🎓 自定义 Sigma 曲线 (BanZhang_SigmaCurve) 前端：紧凑编辑器内嵌节点
// 预设 / 拖点调值 / 双击加删步 / 粘贴数值一键成线 / 右侧常驻数值精调列
// 改动实时写回「曲线数据」隐藏控件（随工作流保存）。
// 布局严格遵循 docs/AI节点开发铁律.md 第 11 节 mountFitPanel 骨架：高度由内容实测、双通道声明。

import { app } from "../../scripts/app.js";

const NODE_NAME = "BanZhang_SigmaCurve";
const DATA_WIDGET = "曲线数据";

const DEFAULT_CURVE = [1.0, 0.703, 0.485, 0.327, 0.216, 0.138, 0.085,
    0.051, 0.029, 0.015, 0.007, 0.002, 0.0];
const MIN_POINTS = 2;
const MAX_POINTS = 200;

// 节点最小宽度：右侧数值列 130 + 间隙 8 + 画布最小可用宽 ~366 + 内边距/边框 ≈ 540（画布 flex 自适应、无横向空白）
const NODE_MIN_W = 540;
const FONT_FAMILY = "'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif";

const C = {
    header: "#2a2a30", canvas: "#141418", grid: "#2a2a32", border: "#4a4a52",
    text: "#e8e8ea", muted: "#9a9aa4", axis: "#8a8a92",
    line: "#378ADD", dot: "#185FA5", dotEdge: "#85B7EB", danger: "#F09595",
    accent: "#185FA5",
};

/* ---------------- 曲线预设：输入进度 u(0→1)，输出噪声强度 t(1→0)，线性归一化 ---------------- */

function karrasT(u) {
    const rho = 7, smin = 0.002;
    const sigma = Math.pow(1 + u * (Math.pow(smin, 1 / rho) - 1), rho);
    return Math.min(1, Math.max(0, (sigma - smin) / (1 - smin)));
}

const sigmoid = (x) => 1 / (1 + Math.exp(-x));
const SIG_A = sigmoid(-5), SIG_B = sigmoid(5);

const PRESETS = [
    ["线性", (u) => 1 - u],
    ["Karras", karrasT],
    ["指数", (u) => (Math.exp(-5 * u) - Math.exp(-5)) / (1 - Math.exp(-5))],
    ["余弦", (u) => Math.cos((u * Math.PI) / 2)],
    ["S 曲线", (u) => (sigmoid(10 * (u - 0.5)) - SIG_B) / (SIG_A - SIG_B)],
    ["首段精细", (u) => 1 - Math.pow(u, 3)],
    ["末段精细", (u) => Math.pow(1 - u, 3)],
];

function presetCurve(name, n) {
    const p = PRESETS.find((x) => x[0] === name) || PRESETS[1];
    const out = [];
    for (let i = 0; i < n; i++) {
        const u = i / (n - 1);
        out.push(i === n - 1 ? 0 : Math.min(1, Math.max(0, Math.round(p[1](u) * 1000) / 1000)));
    }
    return out;
}

function resample(pts, n) {
    const m = pts.length, out = [];
    for (let i = 0; i < n; i++) {
        const pos = (i / (n - 1)) * (m - 1);
        const lo = Math.floor(pos), hi = Math.min(m - 1, lo + 1), w = pos - lo;
        out.push(Math.round((pts[lo] * (1 - w) + pts[hi] * w) * 1000) / 1000);
    }
    out[n - 1] = 0;
    return out;
}

function smooth(pts) {
    if (pts.length < 3) return pts.slice();
    const out = pts.slice();
    for (let i = 1; i < pts.length - 1; i++) {
        out[i] = Math.round((pts[i - 1] * 0.25 + pts[i] * 0.5 + pts[i + 1] * 0.25) * 1000) / 1000;
    }
    return out;
}

// 解析用户粘贴的自定义数值：兼容逗号（中/英）、空格、分号、顿号、换行、竖线等分隔；
// 自动夹到 [0,1]，返回浮点数组（可能不足 2 个点，由调用方判定）。
function parseUserInput(text) {
    const out = [];
    String(text == null ? "" : text).split(/[\s,，;；、|/]+/).forEach((tok) => {
        const t = tok.trim();
        if (!t) return;
        const v = Number(t);
        if (Number.isFinite(v)) out.push(Math.min(1, Math.max(0, v)));
    });
    return out;
}

/* ---------------- 数据读写 ---------------- */

function findWidget(node, name) {
    return (node.widgets || []).find((w) => w.name === name);
}

function readCurve(node) {
    const w = findWidget(node, DATA_WIDGET);
    try {
        const v = JSON.parse(w ? w.value : "");
        if (Array.isArray(v) && v.length >= MIN_POINTS) {
            return v.map((x) => Math.min(1, Math.max(0, Number(x) || 0)));
        }
    } catch (e) { /* 解析失败用默认曲线 */ }
    return DEFAULT_CURVE.slice();
}

function writeCurve(node, pts) {
    const w = findWidget(node, DATA_WIDGET);
    if (w) w.value = JSON.stringify(pts.map((v) => Math.round(v * 1000) / 1000));
    try { app.graph.setDirtyCanvas(true, true); } catch (e) { /* 图未就绪 */ }
}

/* ---------------- 内嵌紧凑编辑器面板 ---------------- */

function buildPanel(node, wrap) {
    let pts = readCurve(node);
    const presetBtns = [];

    const mk = (tag, css, text) => {
        const e = document.createElement(tag);
        e.style.cssText = css;
        if (text !== undefined) e.textContent = text;
        return e;
    };

    /* 头部 */
    const head = mk("div", "display:flex;align-items:center;gap:10px;padding:8px 12px;background:" +
        C.header + ";border-bottom:1px solid " + C.border + ";");
    head.append(mk("span", "font-size:14px;font-weight:500;color:" + C.text + ";", "Sigma 曲线编辑器"));
    const badge = mk("span", "font-size:11px;color:" + C.muted + ";background:" + C.canvas +
        ";border:1px solid " + C.border + ";border-radius:10px;padding:2px 10px;");
    head.append(badge);

    /* 工具栏：预设 + 步数 + 平滑（窄宽自动换行，高度由实测贴合） */
    const bar = mk("div", "display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:8px 12px;background:" +
        C.header + ";border-bottom:1px solid " + C.border + ";");
    PRESETS.forEach((p) => {
        const b = mk("button", "background:transparent;color:" + C.text + ";border:1px solid " + C.border +
            ";border-radius:6px;padding:4px 10px;font-size:12px;cursor:pointer;", p[0]);
        b.onclick = () => {
            pts = presetCurve(p[0], pts.length);
            presetBtns.forEach((x) => { x.style.background = "transparent"; x.style.borderColor = C.border; });
            b.style.background = C.accent; b.style.borderColor = C.dotEdge;
            rebuild(); commit();
        };
        presetBtns.push(b); bar.append(b);
    });
    const clearPreset = () => presetBtns.forEach((x) => { x.style.background = "transparent"; x.style.borderColor = C.border; });
    const spacer = mk("span"); spacer.style.marginLeft = "auto";
    const stepLabel = mk("span", "font-size:12px;color:" + C.muted + ";", "步数");
    const stepInput = mk("input");
    stepInput.type = "number"; stepInput.min = "2"; stepInput.max = "200"; stepInput.step = "1";
    stepInput.style.cssText = "width:56px;background:" + C.canvas + ";border:1px solid " + C.border +
        ";border-radius:6px;color:" + C.text + ";padding:4px 6px;font-size:12px;";
    stepInput.onchange = () => {
        const n = Math.min(MAX_POINTS, Math.max(MIN_POINTS, parseInt(stepInput.value) || pts.length - 1)) + 1;
        stepInput.value = n - 1;
        pts = resample(pts, n);
        clearPreset(); rebuild(); commit();
    };
    const smoothBtn = mk("button", "background:transparent;color:" + C.text + ";border:1px solid " + C.border +
        ";border-radius:6px;padding:4px 10px;font-size:12px;cursor:pointer;", "平滑");
    smoothBtn.onclick = () => { pts = smooth(pts); clearPreset(); rebuild(); commit(); };
    bar.append(spacer, stepLabel, stepInput, smoothBtn);

    /* 自定义数值输入行：粘贴一串数字直接生成曲线 */
    const customRow = mk("div", "display:flex;align-items:center;gap:6px;padding:6px 12px;background:" +
        C.header + ";border-bottom:1px solid " + C.border + ";");
    const customInput = mk("input");
    customInput.type = "text";
    customInput.placeholder = "粘贴数值，如 1.000, 0.984, 0.962 … 0.000";
    customInput.style.cssText = "flex:1;min-width:0;background:" + C.canvas + ";border:1px solid " + C.border +
        ";border-radius:6px;color:" + C.text + ";padding:5px 8px;font-size:12px;";
    const applyCustom = () => {
        const vals = parseUserInput(customInput.value);
        if (vals.length < MIN_POINTS) {
            customInput.style.borderColor = C.danger;
            customInput.title = "没解析到足够的数值：至少需要 2 个 0~1 之间的数（逗号/空格分隔）";
            return;
        }
        customInput.style.borderColor = C.border;
        customInput.title = "";
        pts = vals;
        clearPreset();
        rebuild();
        commit();
    };
    customInput.addEventListener("keydown", (e) => {
        e.stopPropagation();              // 防止数字/字母键被画布快捷键截走
        if (e.key === "Enter") { e.preventDefault(); applyCustom(); }
    });
    customInput.addEventListener("pointerdown", (e) => e.stopPropagation());
    const applyBtn = mk("button", "flex:0 0 auto;background:" + C.accent + ";color:#fff;border:1px solid " +
        C.dotEdge + ";border-radius:6px;padding:5px 12px;font-size:12px;cursor:pointer;", "应用曲线");
    applyBtn.onclick = applyCustom;
    customRow.append(
        mk("span", "flex:0 0 auto;font-size:12px;color:" + C.muted + ";", "自定义"),
        customInput, applyBtn);

    /* 主体：左画布（flex:1 自适应吃掉富余宽度，高度按 viewBox 比例随宽度走，绝不溢出/留白）
       + 右侧常驻数值列（固定窄宽、贴合内容；步数很多时在列内纵向滚动）。 */
    const body = mk("div", "display:flex;gap:8px;padding:8px 10px;background:" + C.canvas +
        ";align-items:flex-start;");
    const chartArea = mk("div", "flex:1 1 auto;min-width:0;");
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.style.cssText = "display:block;width:100%;height:auto;aspect-ratio:520 / 320;border-radius:5px;background:" +
        C.canvas + ";cursor:crosshair;";
    svg.setAttribute("viewBox", "0 0 520 320");
    chartArea.append(svg);

    // 右侧数值列：固定窄宽（步号 + 数值框 + 删除，刚好排下）；高度由 RO 锁定为画布高，超高列内滚动
    const listWrap = mk("div", "flex:0 0 auto;width:130px;display:flex;flex-direction:column;overflow:hidden;");
    const listHead = mk("div", "flex:0 0 auto;display:flex;align-items:center;gap:4px;padding:0 2px 4px;font-size:10px;color:" + C.axis + ";");
    listHead.append(mk("span", "flex:0 0 auto;width:20px;text-align:right;", "步"));
    listHead.append(mk("span", "flex:1;", "σ 值"));
    listHead.append(mk("span", "flex:0 0 auto;width:22px;text-align:center;", ""));
    const list = mk("div", "flex:1 1 auto;min-height:0;overflow-y:auto;");
    listWrap.append(listHead, list);
    body.append(chartArea, listWrap);

    /* 底部 */
    const foot = mk("div", "display:flex;align-items:center;gap:8px;padding:8px 12px;background:" +
        C.header + ";border-top:1px solid " + C.border + ";");
    foot.append(mk("span", "font-size:11px;color:" + C.muted + ";",
        "拖圆点调值 · 双击空白加一步 · 双击圆点删一步"));
    const resetBtn = mk("button", "margin-left:auto;background:transparent;color:" + C.text +
        ";border:1px solid " + C.border + ";border-radius:6px;padding:4px 12px;font-size:12px;cursor:pointer;",
        "恢复默认");
    resetBtn.onclick = () => { pts = DEFAULT_CURVE.slice(); rebuild(); commit(); };
    foot.append(resetBtn);

    // 内容层：挂载根 wrap 会被前端 .dom-widget.size-full 强制 fill 容器高度（自反馈脏值），
    // 故真实内容放进不被定高的 inner，mountFitPanel 改测 inner.offsetHeight。
    const inner = mk("div", "width:100%;box-sizing:border-box;");
    inner.append(head, bar, customRow, body, foot);
    wrap.append(inner);
    node._fitMeasureEl = inner;

    /* 画布绘制与交互（viewBox 坐标固定，元素盒比例=viewBox，getBoundingClientRect 线性换算） */
    const W = 520, H = 320, M = { l: 46, r: 14, t: 14, b: 34 };
    const iw = W - M.l - M.r, ih = H - M.t - M.b, VMAX = 1.05;
    const X = (i) => M.l + iw * (i / (pts.length - 1));
    const Y = (v) => M.t + ih * (1 - v / VMAX);
    const NS = "http://www.w3.org/2000/svg";
    const mkSvg = (n, a) => { const e = document.createElementNS(NS, n); for (const k in a) e.setAttribute(k, a[k]); return e; };

    function drawChart() {
        svg.replaceChildren();
        for (let g = 0; g <= 5; g++) {
            const v = g * 0.2;
            svg.append(mkSvg("line", { x1: M.l, x2: W - M.r, y1: Y(v), y2: Y(v), stroke: C.grid, "stroke-width": 1 }));
            const t = mkSvg("text", { x: M.l - 7, y: Y(v) + 4, fill: C.axis, "font-size": 10, "text-anchor": "end" });
            t.textContent = v.toFixed(1); svg.append(t);
        }
        const gap = pts.length > 24 ? Math.ceil(pts.length / 12) : 1;
        for (let i = 0; i < pts.length; i++) {
            if (i % gap && i !== pts.length - 1) continue;
            const t = mkSvg("text", { x: X(i), y: H - M.b + 16, fill: C.axis, "font-size": 10, "text-anchor": "middle" });
            t.textContent = i; svg.append(t);
        }
        const yl = mkSvg("text", { x: 14, y: H / 2, fill: C.muted, "font-size": 11, "text-anchor": "middle", transform: "rotate(-90 14 " + H / 2 + ")" });
        yl.textContent = "噪声强度比例"; svg.append(yl);
        const xl = mkSvg("text", { x: W / 2, y: H - 4, fill: C.muted, "font-size": 11, "text-anchor": "middle" });
        xl.textContent = "步序号"; svg.append(xl);
        let d = "";
        for (let i = 0; i < pts.length; i++) d += (i ? "L" : "M") + X(i) + " " + Y(pts[i]) + " ";
        svg.append(mkSvg("path", { d, fill: "none", stroke: C.line, "stroke-width": 2 }));
        for (let i = 0; i < pts.length; i++) {
            const c = mkSvg("circle", { cx: X(i), cy: Y(pts[i]), r: pts.length > 40 ? 3.5 : 5, fill: C.dot, stroke: C.dotEdge, "stroke-width": 2, cursor: "ns-resize" });
            c.dataset.i = i; svg.append(c);
        }
    }

    function updateChart() {
        let d = "";
        for (let i = 0; i < pts.length; i++) d += (i ? "L" : "M") + X(i) + " " + Y(pts[i]) + " ";
        const p = svg.querySelector("path");
        if (p) p.setAttribute("d", d);
        svg.querySelectorAll("circle").forEach((c, i) => { c.setAttribute("cx", X(i)); c.setAttribute("cy", Y(pts[i])); });
        list.querySelectorAll("input").forEach((inp, i) => {
            if (document.activeElement !== inp) inp.value = pts[i].toFixed(3);
        });
    }

    function commit() { writeCurve(node, pts); }

    function rebuild() {
        badge.textContent = "共 " + (pts.length - 1) + " 步";
        stepInput.value = pts.length - 1;
        list.replaceChildren();
        pts.forEach((v, i) => {
            const row = mk("div", "display:flex;align-items:center;gap:4px;padding:1px 2px 1px 0;");
            row.append(mk("span", "flex:0 0 auto;width:20px;text-align:right;font-size:11px;color:" + C.axis + ";", String(i)));
            const inp = mk("input");
            inp.type = "number"; inp.step = "0.001"; inp.min = "0"; inp.max = "1"; inp.value = v.toFixed(3);
            inp.style.cssText = "flex:1;min-width:0;width:auto;background:" + C.header + ";border:1px solid " + C.border +
                ";border-radius:4px;color:" + C.text + ";padding:2px 5px;font-size:11px;";
            inp.addEventListener("keydown", (e) => e.stopPropagation());
            inp.addEventListener("pointerdown", (e) => e.stopPropagation());
            inp.oninput = () => {
                const nv = Math.min(1, Math.max(0, parseFloat(inp.value) || 0));
                pts[i] = i === 0 ? Math.min(1, Math.max(nv, pts[1] || 0)) : Math.min(pts[i - 1], nv);
                clearPreset(); updateChart();
            };
            inp.onchange = () => commit();
            const del = mk("button", "flex:0 0 auto;width:22px;height:22px;background:transparent;color:" + C.danger +
                ";border:1px solid #5a3a3a;border-radius:4px;font-size:12px;cursor:pointer;", "×");
            del.onclick = () => { if (pts.length > MIN_POINTS) { pts.splice(i, 1); clearPreset(); rebuild(); commit(); } };
            row.append(inp, del);
            list.append(row);
        });
        drawChart();
    }

    /* 拖点调值：window 监听保证移出画布仍可拖，handler 保存以便 onRemoved 清理 */
    let drag = -1;
    const onSvgDown = (e) => {
        if (e.target.dataset && e.target.dataset.i !== undefined) { drag = parseInt(e.target.dataset.i); e.preventDefault(); }
    };
    const onWinMove = (e) => {
        if (drag < 0 || !wrap.isConnected) return;
        const r = svg.getBoundingClientRect();
        const py = ((e.clientY - r.top) / r.height) * H;
        let v = Math.min(1, Math.max(0, Math.round((1 - (py - M.t) / ih * VMAX) * 1000) / 1000));
        if (drag < pts.length - 1) v = Math.max(v, pts[drag + 1]);
        if (drag > 0) v = Math.min(v, pts[drag - 1]);
        pts[drag] = v;
        clearPreset(); updateChart();
    };
    const onWinUp = () => { if (drag >= 0) { drag = -1; commit(); } };
    const onSvgDbl = (e) => {
        if (e.target.dataset && e.target.dataset.i !== undefined) {
            if (pts.length > MIN_POINTS) { pts.splice(parseInt(e.target.dataset.i), 1); clearPreset(); rebuild(); commit(); }
            return;
        }
        if (pts.length >= MAX_POINTS) return;
        const r = svg.getBoundingClientRect();
        const px = ((e.clientX - r.left) / r.width) * W, py = ((e.clientY - r.top) / r.height) * H;
        if (px < M.l || px > W - M.r) return;
        let v = Math.min(1, Math.max(0, Math.round((1 - (py - M.t) / ih * VMAX) * 1000) / 1000));
        const idx = Math.round(((px - M.l) / iw) * (pts.length - 1));
        v = Math.min(Math.max(v, pts[idx + 1] || 0), pts[idx] === undefined ? 1 : pts[idx]);
        pts.splice(idx, 0, v);
        clearPreset(); rebuild(); commit();
    };
    svg.addEventListener("mousedown", onSvgDown);
    window.addEventListener("mousemove", onWinMove);
    window.addEventListener("mouseup", onWinUp);
    svg.addEventListener("dblclick", onSvgDbl);

    /* 右列高度锁定为画布高：宽度变化 → 画布按比例等高变化 → 同步右列 max-height，
       步数多时只在右列内部滚动，画布下方不留下垂直空白。 */
    const syncListH = () => { listWrap.style.maxHeight = chartArea.offsetHeight + "px"; };
    const listRO = new ResizeObserver(() => { syncListH(); node.fitPanel?.(); });
    listRO.observe(chartArea);
    syncListH();

    rebuild();

    return {
        refresh() { pts = readCurve(node); rebuild(); },
        cleanup() {
            listRO.disconnect();
            window.removeEventListener("mousemove", onWinMove);
            window.removeEventListener("mouseup", onWinUp);
        },
    };
}

/* ---------------- 铁律第 11 节：自适应面板挂载（双通道尺寸声明，勿改布局逻辑） ---------------- */

const PANEL_MARGIN = 4;   // 默认 10 会让 DOM 容器上下各被裁 10px
const BOTTOM_PAD = 8;

function mountFitPanel(node, element, opts = {}) {
    const margin = opts.margin ?? PANEL_MARGIN;
    const minWidth = opts.minWidth ?? 320;
    node._fitEl = element;
    // 内容自然高度测量元素：默认 element；若前端强制 element fill 容器，传内部不定高的内容层
    const measureEl = opts.measureEl ?? node._fitMeasureEl ?? element;
    node._fitMeasureEl = measureEl;
    node._fitH = opts.estimate?.(node) ?? 80;

    const w = node.addDOMWidget(opts.name ?? "fit_panel", opts.type ?? "fit_panel", element, {
        serialize: false,
        margin,
        // v2 通道①：options 三件套
        getMinHeight: () => node._fitH,
        getMaxHeight: () => node._fitH,
        getHeight: () => node._fitH,
    });
    node._fitW = w;

    // 旧 litegraph 通道 + v2 通道②：高度含 margin 补偿 pad = 2*margin-4
    const declare = () => {
        const pad = 2 * (w.margin ?? margin) - 4;
        w.computeSize = () => [node.size[0], node._fitH + pad];
        w.computeLayoutSize = () => ({ minHeight: node._fitH + pad, maxHeight: node._fitH + pad, minWidth: 0 });
    };
    node._fitDeclare = declare;

    // 节点总高双向贴合（max：框架自算 vs 面板实测），存档撑大/压小都能收回
    const fit = () => {
        if (!node._fitEl || !node._fitW) return;
        if (node.flags?.collapsed) return;
        // 测内容层自然高度（scrollHeight 兜底，防止某帧被容器压死读到脏值）
        const measured = Math.max(measureEl.offsetHeight | 0, measureEl.scrollHeight | 0);
        if (measured) node._fitH = measured;
        declare();
        let cs = [0, 0];
        try { cs = node.computeSize() || [0, 0]; } catch (e) {}
        const m = w.margin ?? margin;
        const byDom = (w.y || 0) + m + node._fitH + m + BOTTOM_PAD;
        const needH = Math.ceil(Math.max(cs[1] || 0, byDom));
        const needW = Math.max(cs[0] || 0, node.size?.[0] || 0, minWidth);
        if (Math.abs((node.size?.[1] || 0) - needH) > 2 || needW > (node.size?.[0] || 0)) {
            node.setSize([needW, needH]);
            node.setDirtyCanvas(true, true);
        }
    };
    node.fitPanel = () => {
        fit();
        requestAnimationFrame(fit);
        setTimeout(fit, 60); setTimeout(fit, 300);   // 字体/样式晚就绪、存档恢复
    };

    if (typeof ResizeObserver !== "undefined") {
        node._fitRO = new ResizeObserver(fit);
        node._fitRO.observe(measureEl);   // 内容增删 / 宽度致画布等高变化
    }
    const prevResize = node.onResize;
    node.onResize = function () { prevResize?.apply(this, arguments); fit(); };
    const prevRemoved = node.onRemoved;
    node.onRemoved = function () {
        node._fitRO?.disconnect(); node._fitRO = null;
        node._panelApi?.cleanup?.();
        prevRemoved?.apply(this, arguments);
    };

    element.addEventListener("mousedown", (e) => e.stopPropagation());
    element.addEventListener("keydown", (e) => e.stopPropagation());
    node.size[0] = Math.max(node.size[0] ?? 0, minWidth);
    return w;
}

/* ---------------- 注册扩展 ---------------- */

app.registerExtension({
    name: "Banzhang.SigmaCurve",
    beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== NODE_NAME) return;

        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const r = onNodeCreated ? onNodeCreated.apply(this, arguments) : undefined;
            const node = this;

            // 藏掉后端自动生成的「曲线数据」存储控件（铁律第 4 节唯一合法写法，禁改 type）
            const dw = findWidget(node, DATA_WIDGET);
            if (dw) { dw.hidden = true; dw.computeSize = () => [0, -4]; dw.draw = () => {}; dw.mouse = () => {}; }

            const wrap = document.createElement("div");
            // 不写死宽高：宽度 100% 自适应，高度由内容撑开供 offsetHeight 实测
            wrap.style.cssText = "width:100%;box-sizing:border-box;font-family:" + FONT_FAMILY +
                ";background:" + C.header + ";border:1px solid " + C.border + ";border-radius:8px;overflow:hidden;";

            node._panelApi = buildPanel(node, wrap);
            mountFitPanel(node, wrap, { name: "sigma_curve", type: "sigma_curve", minWidth: NODE_MIN_W, estimate: () => 440 });
            node.fitPanel();
            return r;
        };

        // 刷新加载工作流：恢复曲线数据、重建内容、重新贴合（高度收回存档空白/收缩）
        const onConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function () {
            const r = onConfigure ? onConfigure.apply(this, arguments) : undefined;
            this._panelApi?.refresh();
            this.fitPanel?.();
            return r;
        };
    },
});
