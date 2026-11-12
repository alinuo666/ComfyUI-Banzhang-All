// MiniMax H3 Preview Override — DOM widget for the MiniMaxH3PreviewOverride node.
// 结构与显示对齐 KJNodes Model Preview Override：图片区 + 可拖拽 grip + 图表面板
// （σ/Δ 与 步耗时 两块画布，均真实绘制）。事件流: "minimax_h3_preview_override"。
const { app } = window.comfyAPI.app;
const { api } = window.comfyAPI.api;

const STYLE_ID = "minimax-h3-pov-stylesheet";
function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
.minimax-h3-pov-root { width:100%; height:100%; position:relative; background:#181818; color:#b0b0b0;
  font:12px monospace; display:flex; flex-direction:column; overflow:hidden; user-select:none; }
.minimax-h3-pov-image-area { flex:1 1 auto; min-height:80px; position:relative; display:flex;
  align-items:center; justify-content:center; background:#0a0a0a; overflow:hidden; }
.minimax-h3-pov-img, .minimax-h3-pov-video { position:absolute; inset:0; width:100%; height:100%;
  object-fit:contain; display:block; image-rendering:pixelated; }
.minimax-h3-pov-placeholder { position:absolute; inset:0; display:flex; align-items:center;
  justify-content:center; color:#707070; font:12px monospace; pointer-events:none; }
.minimax-h3-pov-scrub { position:absolute; left:0; right:0; bottom:0; height:6px;
  background:rgba(0,0,0,0.5); cursor:pointer; z-index:5; }
/* 进度条被 tickScrub 的 rAF **每帧**驱动，只能动 transform（走合成层、不触发布
   局），不能动 width（每帧一次 layout）。宽度钉满 100%，用 scaleX 表示进度。
   transition:none 是必须的：rAF 每帧写值 + 过渡 = 两套动画机制打架，过渡每帧被
   重启、永远跑不完，7.7 秒能刷出 10304 次样式重算；而页面里存在我们管不到的
   全局 transition，会命中这里。 */
.minimax-h3-pov-scrub-fill { height:100%; width:100%; background:#e67e22; pointer-events:none;
  transform:scaleX(0); transform-origin:left center; transition:none; }
.minimax-h3-pov-fold { position:absolute; top:8px; right:10px; z-index:20; background:rgba(0,0,0,0.45);
  border:1px solid rgba(255,255,255,0.18); border-radius:4px; color:#ccc; cursor:pointer;
  font-size:13px; line-height:1; padding:4px 8px; }
.minimax-h3-pov-grip { flex:0 0 5px; background:#2a2a2a; cursor:ns-resize; position:relative;
  z-index:4; user-select:none; }
.minimax-h3-pov-grip::after { content:''; position:absolute; left:50%; top:50%;
  transform:translate(-50%,-50%); width:26px; height:2px; background:#555; border-radius:1px; }
.minimax-h3-pov-grip:hover { background:#3a3a3a; }
.minimax-h3-pov-grip:hover::after { background:#888; }
.minimax-h3-pov-panel { flex:0 0 auto; height:140px; min-height:60px; background:#181818;
  font:11px monospace; color:#b0b0b0; display:flex; flex-direction:column; overflow:hidden; }
.minimax-h3-pov-panel-header { display:flex; justify-content:space-between; align-items:center;
  padding:4px 10px; gap:8px; background:#202020; border-bottom:1px solid #2a2a2a; }
.minimax-h3-pov-panel-title { color:#9ecbff; font-size:11px; font-weight:600; }
.minimax-h3-pov-panel-summary { color:#8a8a8a; font-size:10px; overflow:hidden;
  text-overflow:ellipsis; white-space:nowrap; }
.minimax-h3-pov-graphs { display:grid; grid-template-columns:1fr 1fr; gap:6px; padding:6px; flex:1;
  min-height:0; }
.minimax-h3-pov-graph-cell { background:#1a1a1a; border:1px solid #2a2a2a; border-radius:6px;
  padding:3px 5px; display:flex; flex-direction:column; min-height:0; overflow:hidden; }
.minimax-h3-pov-graph-head { display:flex; justify-content:space-between; align-items:baseline;
  font-size:10px; color:#8a8a8a; flex:0 0 auto; }
.minimax-h3-pov-graph-label { white-space:nowrap; }
.minimax-h3-pov-graph-value { font-family:ui-monospace,Consolas,monospace; color:#d0d0d0; }
.minimax-h3-pov-graph-canvas { flex:1 1 auto; display:block; width:100%; min-height:0;
  cursor:crosshair; }
`;
    document.head.appendChild(style);
}

// Walks subgraph chain for ids like "12:7:5" (mirrors getNodeByExecutionId).
function findNodeByQualifiedId(rootGraph, qid) {
    if (!rootGraph || !qid) return null;
    const parts = String(qid).split(":");
    let graph = rootGraph;
    for (let i = 0; i < parts.length - 1; i++) {
        const parentId = parseInt(parts[i], 10);
        if (!Number.isFinite(parentId)) return null;
        const parentNode = graph?.getNodeById?.(parentId);
        if (!parentNode?.subgraph) return null;
        graph = parentNode.subgraph;
    }
    const leafId = parseInt(parts[parts.length - 1], 10);
    if (!Number.isFinite(leafId)) return null;
    return graph?.getNodeById?.(leafId) || null;
}

api.addEventListener("minimax_h3_preview_override", (e) => {
    const data = e.detail;
    if (!data || data.node_id == null) return;
    const node = findNodeByQualifiedId(app.graph, data.node_id);
    if (node?._h3PreviewHandler) node._h3PreviewHandler(data);
});

function chainCallback(target, name, fn) {
    const prev = target[name];
    target[name] = function (...args) {
        const r = prev?.apply(this, args);
        fn.apply(this, args);
        return r;
    };
}

function el(tag, className, parent) {
    const e = document.createElement(tag);
    if (className) e.className = className;
    if (parent) parent.appendChild(e);
    return e;
}

function b64ToBlob(b64, mime) {
    const bin = atob(b64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return new Blob([arr], { type: mime });
}

function fmt(n, d) {
    return Number.isFinite(n) ? n.toFixed(d) : "—";
}

const GRAPH_PAD_X = 4;
function syncCanvasDPR(canvas) {
    const dpr = window.devicePixelRatio || 1;
    const cssW = canvas.clientWidth || canvas.width;
    const cssH = canvas.clientHeight || canvas.height;
    if (canvas.width !== Math.round(cssW * dpr) || canvas.height !== Math.round(cssH * dpr)) {
        canvas.width = Math.round(cssW * dpr);
        canvas.height = Math.round(cssH * dpr);
    }
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx, W: cssW, H: cssH };
}

function drawGridlines(ctx, W, H, padX, padY) {
    ctx.strokeStyle = "#1e1e1e";
    ctx.lineWidth = 1;
    for (let g = 1; g < 4; g++) {
        const y = Math.round(padY + (g / 4) * (H - 2 * padY)) + 0.5;
        ctx.beginPath();
        ctx.moveTo(padX, y);
        ctx.lineTo(W - padX, y);
        ctx.stroke();
    }
}

// σ + Δ overlaid; each series normalised to its own max for comparable shapes.
function drawSigmaDeltaGraph(canvas, sigmas, deltas, step, totalSteps, hoverStep, lockedStep) {
    const { ctx, W, H } = syncCanvasDPR(canvas);
    if (W < 10 || H < 5) return;
    const padX = GRAPH_PAD_X, padY = 3;
    const iW = W - 2 * padX, iH = H - 2 * padY;
    ctx.clearRect(0, 0, W, H);
    drawGridlines(ctx, W, H, padX, padY);

    const n = sigmas?.length || 0;
    const xSteps = Math.max(totalSteps || n, n, deltas?.length || 0);
    const xAt = i => padX + (i / Math.max(1, xSteps - 1)) * iW;

    let sYAt = null;
    if (n > 1) {
        let sMax = -Infinity, sMin = Infinity;
        for (const s of sigmas) { if (s > sMax) sMax = s; if (s < sMin) sMin = s; }
        if (sMin > 0) sMin = 0;
        const sRange = Math.max(sMax - sMin, 1e-6);
        sYAt = v => padY + (1 - (v - sMin) / sRange) * iH;

        ctx.strokeStyle = "rgba(208, 208, 208, 0.55)";
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        for (let i = 0; i < n; i++) {
            const px = padX + (i / (n - 1)) * iW;
            const py = sYAt(sigmas[i]);
            if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
        }
        ctx.stroke();
        ctx.setLineDash([]);

        const i = Math.max(0, Math.min(n - 1, step));
        const mx = padX + (i / Math.max(1, n - 1)) * iW;
        const my = sYAt(sigmas[i]);
        ctx.fillStyle = "#d0d0d0";
        ctx.beginPath();
        ctx.arc(mx, my, 2.5, 0, Math.PI * 2);
        ctx.fill();
    }

    let dYAt = null;
    if (deltas && deltas.length >= 1) {
        let dMax = -Infinity;
        for (const v of deltas) if (Number.isFinite(v) && v > dMax) dMax = v;
        const dRange = Math.max(dMax, 1e-6);
        dYAt = v => padY + (1 - v / dRange) * iH;

        // delta[i] is plotted at boundary (i+1); flat-extend delta[0] back to boundary 0.
        const lastB = deltas.length;
        ctx.beginPath();
        ctx.moveTo(xAt(0), H - padY);
        ctx.lineTo(xAt(0), dYAt(deltas[0]));
        for (let i = 0; i < deltas.length; i++) ctx.lineTo(xAt(i + 1), dYAt(deltas[i]));
        ctx.lineTo(xAt(lastB), H - padY);
        ctx.closePath();
        ctx.fillStyle = "rgba(230, 126, 34, 0.15)";
        ctx.fill();

        ctx.strokeStyle = "#e67e22";
        ctx.lineWidth = 1.3;
        if (deltas.length === 1) {
            ctx.fillStyle = "#e67e22";
            ctx.beginPath();
            ctx.arc(xAt(1), dYAt(deltas[0]), 2, 0, Math.PI * 2);
            ctx.fill();
        } else {
            ctx.beginPath();
            for (let i = 0; i < deltas.length; i++) {
                const px = xAt(i + 1), py = dYAt(deltas[i]);
                if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
            }
            ctx.stroke();
        }
    }

    if (lockedStep != null && lockedStep >= 0 && lockedStep < xSteps) {
        const lx = xAt(lockedStep) + 0.5;
        ctx.strokeStyle = "rgba(245, 200, 60, 0.9)";
        ctx.lineWidth = 1.2;
        ctx.setLineDash([4, 2]);
        ctx.beginPath();
        ctx.moveTo(lx, padY);
        ctx.lineTo(lx, H - padY);
        ctx.stroke();
        ctx.setLineDash([]);
    }

    if (hoverStep != null && hoverStep >= 0 && hoverStep < xSteps) {
        const hx = xAt(hoverStep) + 0.5;
        ctx.strokeStyle = "rgba(208, 208, 208, 0.5)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(hx, padY);
        ctx.lineTo(hx, H - padY);
        ctx.stroke();
        if (sYAt && hoverStep < n) {
            ctx.fillStyle = "#d0d0d0";
            ctx.beginPath();
            ctx.arc(hx - 0.5, sYAt(sigmas[hoverStep]), 2.5, 0, Math.PI * 2);
            ctx.fill();
        }
        // delta[k-1] is plotted at boundary k.
        if (dYAt && hoverStep >= 1 && (hoverStep - 1) < deltas.length) {
            ctx.fillStyle = "#e67e22";
            ctx.beginPath();
            ctx.arc(hx - 0.5, dYAt(deltas[hoverStep - 1]), 2.5, 0, Math.PI * 2);
            ctx.fill();
        }
    }
}

// totalSteps fixes the x-axis so the line grows left-to-right, not stretching to fill.
function drawLineGraph(canvas, values, totalSteps) {
    const { ctx, W, H } = syncCanvasDPR(canvas);
    if (W < 10 || H < 5) return;
    const padX = GRAPH_PAD_X, padY = 3;
    const iW = W - 2 * padX, iH = H - 2 * padY;
    ctx.clearRect(0, 0, W, H);
    drawGridlines(ctx, W, H, padX, padY);
    if (!values || values.length < 1) return;

    let vMax = -Infinity, vMin = Infinity;
    for (const v of values) { if (v > vMax) vMax = v; if (v < vMin) vMin = v; }
    if (vMin > 0) vMin = 0;
    const vRange = Math.max(vMax - vMin, 1e-6);

    const xSteps = Math.max(totalSteps || values.length, values.length);

    ctx.beginPath();
    ctx.moveTo(padX, H - padY);
    for (let i = 0; i < values.length; i++) {
        const px = padX + (i / Math.max(1, xSteps - 1)) * iW;
        const py = padY + (1 - (values[i] - vMin) / vRange) * iH;
        ctx.lineTo(px, py);
    }
    ctx.lineTo(padX + ((values.length - 1) / Math.max(1, xSteps - 1)) * iW, H - padY);
    ctx.closePath();
    ctx.fillStyle = "rgba(230, 126, 34, 0.15)";
    ctx.fill();

    ctx.strokeStyle = "#e67e22";
    ctx.lineWidth = 1.3;
    ctx.beginPath();
    for (let i = 0; i < values.length; i++) {
        const px = padX + (i / Math.max(1, xSteps - 1)) * iW;
        const py = padY + (1 - (values[i] - vMin) / vRange) * iH;
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.stroke();
}

app.registerExtension({
    name: "MiniMaxH3.PreviewOverride",
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData?.name !== "MiniMaxH3PreviewOverride") return;

        chainCallback(nodeType.prototype, "onNodeCreated", function () {
            ensureStyles();
            const node = this;

            // ── KJNodes 同构布局：图片区 + grip + 图表面板 ──
            const root = el("div", "minimax-h3-pov-root");

            const imageArea = el("div", "minimax-h3-pov-image-area", root);
            const imgA = el("img", "minimax-h3-pov-img", imageArea);
            const imgB = el("img", "minimax-h3-pov-img", imageArea);
            imgA.draggable = imgB.draggable = false;
            imgB.style.opacity = "0";
            let visibleImg = imgA;
            let pendingImg = imgB;
            const videoEl = el("video", "minimax-h3-pov-video", imageArea);
            videoEl.style.opacity = "0";
            videoEl.muted = true;
            videoEl.playsInline = true;
            videoEl.loop = true;
            videoEl.disablePictureInPicture = true;
            /* 自动播放（20261020 用户定）：muted 视频浏览器直接放行自动播放。
               旧版怕「loop 视频无限循环解码」（采样预览每次都换源）就把自动播放
               关了，代价是画面得点一下才动 —— 根治不是「永远不播」，而是**看不
               见就停**：节点滚出视口 / 被别的窗口挡住就 pause()，回到视口就接着
               播。点击画面仍可暂停 / 继续（imageArea 的 click 已接 toggle）。 */
            let povVisible = true;
            const povPlay = () => {
                if (povVisible && videoEl.paused && videoEl.src) videoEl.play().catch(() => {});
            };
            try {
                const povIO = new IntersectionObserver((es) => {
                    povVisible = !!(es[0] && es[0].isIntersecting);
                    if (povVisible) povPlay();
                    else if (!videoEl.paused) videoEl.pause();
                }, { threshold: 0.05 });
                povIO.observe(imageArea);
            } catch (_) {
                /* 老浏览器没有 IntersectionObserver：退化成一直播（等于旧行为）。 */
            }
            const placeholder = el("div", "minimax-h3-pov-placeholder", imageArea);
            placeholder.textContent = "等待采样…";
            const scrubBar = el("div", "minimax-h3-pov-scrub", imageArea);
            const scrubFill = el("div", "minimax-h3-pov-scrub-fill", scrubBar);
            scrubBar.style.display = "none";

            const foldBtn = el("button", "minimax-h3-pov-fold", imageArea);
            foldBtn.textContent = "⌃";
            foldBtn.title = "折叠参数，仅显示画面";

            const grip = el("div", "minimax-h3-pov-grip", root);
            grip.title = "拖拽调整面板高度";

            const panel = el("div", "minimax-h3-pov-panel", root);
            const panelHeader = el("div", "minimax-h3-pov-panel-header", panel);
            const title = el("span", "minimax-h3-pov-panel-title", panelHeader);
            title.textContent = "H3 实时预览";
            const summary = el("span", "minimax-h3-pov-panel-summary", panelHeader);
            summary.textContent = "待机";

            const graphs = el("div", "minimax-h3-pov-graphs", panel);
            function makeCell(labelText) {
                const cell = el("div", "minimax-h3-pov-graph-cell", graphs);
                const head = el("div", "minimax-h3-pov-graph-head", cell);
                const lbl = el("span", "minimax-h3-pov-graph-label", head);
                lbl.textContent = labelText;
                const val = el("span", "minimax-h3-pov-graph-value", head);
                const canvas = el("canvas", "minimax-h3-pov-graph-canvas", cell);
                return { canvas, val, lbl };
            }
            const sdCell = makeCell("σ / Δ");
            const timeCell = makeCell("步耗时");

            const previewWidget = node.addDOMWidget("h3_preview", "minimax_h3_preview", root, { serialize: false });
            node.setSize([Math.max(node.size?.[0] ?? 360, 360), 480]);

            // 布局尺寸：minHeight 报小值 + maxHeight 无限，控件撑满节点主体
            if (previewWidget) {
                previewWidget.computeLayoutSize = () => ({ minHeight: 160, maxHeight: undefined, minWidth: 0 });
            }

            // 16:9 画幅锁定（同视频合并节点的 onResize 推导思路）：
            // 节点高度恒由宽度推导 = 标题/参数区 + 预览区(width*9/16) + grip + 图表面板。
            // 高度不是存储值，刷新后按当前宽度重算，不存在"尺寸被恢复默认"。
            function upperHeight() {
                let h = (typeof LiteGraph !== "undefined" && LiteGraph.NODE_TITLE_HEIGHT) || 30;
                for (const w of node.widgets) {
                    if (w === previewWidget || w.hidden || w.type === "hidden") continue;
                    h += (w.computeSize ? w.computeSize(node.size[0])[1] : (w.height || 26)) + 4;
                }
                return h;
            }
            chainCallback(node, "onResize", function (size) {
                const panelH = parseInt(panel.style.height, 10) || 140;
                const total = Math.ceil(upperHeight() + size[0] * 9 / 16 + 5 + panelH + 14);
                if (Math.abs(size[1] - total) > 1) size[1] = total;
                drawAll();
            });
            requestAnimationFrame(() => { if (node.onResize) node.onResize(node.size); });

            // 图表面板高度：grip 拖拽调整，持久化到 properties（同 KJNodes kjPovPanelH）
            node.properties = node.properties || {};
            if (typeof node.properties.h3PovPanelH === "number") {
                panel.style.height = node.properties.h3PovPanelH + "px";
            }
            grip.addEventListener("mousedown", (e) => {
                if (e.button !== 0) return;
                e.preventDefault();
                e.stopPropagation();
                const startY = e.clientY;
                const startH = panel.offsetHeight;
                const move = (ev) => {
                    const scale = app.canvas?.ds?.scale || 1;
                    const dy = (ev.clientY - startY) / scale;
                    const rootRect = root.getBoundingClientRect();
                    const maxH = Math.max(60, rootRect.height / scale - 80);
                    const newH = Math.max(60, Math.min(maxH, startH - dy));
                    panel.style.height = newH + "px";
                };
                const up = () => {
                    document.removeEventListener("mousemove", move);
                    document.removeEventListener("mouseup", up);
                    node.properties.h3PovPanelH = panel.offsetHeight;
                    node.graph?.change?.();
                    // 面板高度变了，重新推导节点总高
                    if (node.onResize) node.onResize(node.size);
                };
                document.addEventListener("mousemove", move);
                document.addEventListener("mouseup", up);
            });
            chainCallback(node, "onConfigure", function () {
                if (typeof node.properties?.h3PovPanelH === "number") {
                    panel.style.height = node.properties.h3PovPanelH + "px";
                }
                if (this.properties?.["bz_h3_compact"]) applyCompactMode(true);
                // 加载后按当前宽度重推一次高度
                requestAnimationFrame(() => { if (node.onResize) node.onResize(node.size); });
            });

            // 画布尺寸随布局变化时自动重绘，防止空白或拉伸变形
            const graphRO = new ResizeObserver(() => requestAnimationFrame(drawAll));
            graphRO.observe(sdCell.canvas);
            graphRO.observe(timeCell.canvas);

            // Per-run state.
            let hoverStep = null;
            let lockedStep = null;
            let lastCurrentStep = -1;
            let totalSteps = 0;
            let cachedSigmas = null;
            let lastAvgStepMs = null;
            let lastStep = 0;
            let lastTotal = 0;
            let lastW = null;
            let lastH = null;
            let bakedFps = null;
            let liveUrl = null;
            let liveMime = null;
            let currentVideoUrl = null;
            const stepBlobUrls = [];
            const stepMimes = [];
            const history = { stepMs: [], delta: [] };

            function showLiveFrame(url) {
                const target = pendingImg;
                target.src = url;
                target.decode().then(() => {
                    if (hoverStep != null || lockedStep != null) return;
                    if (liveUrl !== url || target !== pendingImg) return;
                    target.style.opacity = "1";
                    visibleImg.style.opacity = "0";
                    const prev = visibleImg;
                    visibleImg = target;
                    pendingImg = prev;
                }).catch(() => {});
            }

            function hideVideo() {
                videoEl.pause();
                videoEl.style.opacity = "0";
                currentVideoUrl = null;
            }

            function showVideo(url) {
                if (url === currentVideoUrl) return;
                currentVideoUrl = url;
                videoEl.src = url;
                videoEl.style.opacity = "1";
                visibleImg.style.opacity = "0";
                pendingImg.style.opacity = "0";
                /* 自动播放（20261020）：可见就播、看不见才停，见上面 povPlay 的
                   注释 —— 靠"永远不播"来省解码会让预览失去动画。 */
                const 开播 = () => {
                    try { videoEl.currentTime = 0; } catch (_) {}
                    povPlay();
                };
                if (videoEl.readyState >= 1) 开播();
                else videoEl.addEventListener("loadedmetadata", 开播, { once: true });
            }

            function showMedia(url, mime) {
                if (placeholder.parentNode) placeholder.remove();
                if (mime === "video/mp4") {
                    showVideo(url);
                } else {
                    hideVideo();
                    showLiveFrame(url);
                }
            }

            function setStepBlob(stepIdx, blob) {
                const url = URL.createObjectURL(blob);
                if (stepBlobUrls[stepIdx]) {
                    try { URL.revokeObjectURL(stepBlobUrls[stepIdx]); } catch {}
                }
                stepBlobUrls[stepIdx] = url;
                stepMimes[stepIdx] = blob.type;
                liveUrl = url;
                liveMime = blob.type;
                if (hoverStep == null && lockedStep == null) showMedia(url, blob.type);
            }

            function displayScrubStep() {
                const idx = hoverStep != null ? hoverStep : lockedStep;
                if (idx != null && stepBlobUrls[idx]) {
                    showMedia(stepBlobUrls[idx], stepMimes[idx] || (idx === 0 ? "image/jpeg" : liveMime));
                } else if (liveUrl) {
                    showMedia(liveUrl, liveMime);
                }
            }

            const fpsWidget = () => node.widgets?.find(w => w.name === "preview_fps");
            function currentFps() {
                const v = +fpsWidget()?.value;
                return Number.isFinite(v) && v > 0 ? v : 12;
            }

            function renderStats() {
                const tIdx = lastCurrentStep - 1;
                const stepMs = (tIdx >= 0 && tIdx < history.stepMs.length) ? history.stepMs[tIdx] : null;
                const avgTxt = lastAvgStepMs != null
                    ? `${(lastAvgStepMs / 1000).toFixed(2)}秒/步` : "—";
                let eta = "";
                if (lastAvgStepMs != null && lastTotal != null && lastStep != null) {
                    eta = ` · 剩余 ${((lastTotal - lastStep) * lastAvgStepMs / 1000).toFixed(1)}s`;
                }
                timeCell.val.textContent = stepMs != null ? `${stepMs.toFixed(0)}ms` : "—";
                let sd = "—";
                if (cachedSigmas) {
                    const idx = hoverStep != null ? hoverStep : (lockedStep != null ? lockedStep : lastCurrentStep);
                    const sig = cachedSigmas[Math.min(idx, cachedSigmas.length - 1)];
                    const d = (idx - 1 >= 0 && history.delta[idx - 1] != null) ? history.delta[idx - 1] : null;
                    sd = `${fmt(sig, 3)} / ${fmt(d, 3)}`;
                }
                sdCell.val.textContent = sd;
                summary.textContent = `${lastW ?? "—"}×${lastH ?? "—"} · ${lastStep ?? 0}/${lastTotal ?? 0} · ${avgTxt}${eta}`;
            }

            function drawAll() {
                drawSigmaDeltaGraph(sdCell.canvas, cachedSigmas, history.delta, lastCurrentStep, totalSteps, hoverStep, lockedStep);
                drawLineGraph(timeCell.canvas, history.stepMs, totalSteps);
                renderStats();
            }

            function resetRun() {
                for (const u of stepBlobUrls) {
                    if (u) try { URL.revokeObjectURL(u); } catch {}
                }
                stepBlobUrls.length = 0;
                stepMimes.length = 0;
                history.stepMs.length = 0;
                history.delta.length = 0;
                hoverStep = null;
                lockedStep = null;
                lastCurrentStep = -1;
                totalSteps = 0;
                bakedFps = null;
                hideVideo();
                liveUrl = null;
                liveMime = null;
                placeholder.remove();
                imageArea.appendChild(placeholder);
                placeholder.textContent = "等待采样…";
                scrubBar.style.display = "none";
            }

            // Animated playback scrub (WebP plays natively in <img>; MP4 in <video>).
            function clipDurationMs() {
                if (currentVideoUrl && Number.isFinite(videoEl.duration) && videoEl.duration > 0) {
                    return videoEl.duration * 1000;
                }
                return 0;
            }
            // 进度条刷新：只在播放时用 rAF（常驻 rAF 是每帧写 style.width，
            // 等于每帧弄脏布局；暂停/无视频时一次都不跑）
            let scrubRaf = null;
            function tickScrub() {
                scrubRaf = null;
                const dur = clipDurationMs();
                if (dur > 0) {
                    if (scrubBar.style.display === "none") scrubBar.style.display = "block";
                    /* 同 CSS 处的理由：每帧只写 transform，不碰布局属性。 */
                    scrubFill.style.transform = "scaleX(" + (videoEl.currentTime / videoEl.duration).toFixed(4) + ")";
                    if (bakedFps != null && bakedFps > 0) {
                        const rate = currentFps() / bakedFps;
                        if (Math.abs(videoEl.playbackRate - rate) > 0.001) videoEl.playbackRate = rate;
                    }
                } else if (scrubBar.style.display !== "none") {
                    scrubBar.style.display = "none";
                }
                if (!videoEl.paused) scrubRaf = requestAnimationFrame(tickScrub);
            }
            videoEl.addEventListener("play", () => { if (!scrubRaf) scrubRaf = requestAnimationFrame(tickScrub); });
            videoEl.addEventListener("pause", () => { if (scrubRaf) cancelAnimationFrame(scrubRaf); scrubRaf = null; });
            videoEl.addEventListener("timeupdate", () => { if (videoEl.paused) tickScrub(); });
            videoEl.addEventListener("loadedmetadata", () => { if (videoEl.paused) tickScrub(); });
            scrubBar.addEventListener("mousedown", (ev) => {
                if (ev.button !== 0) return;
                ev.stopPropagation();
                ev.preventDefault();
                const rect = scrubBar.getBoundingClientRect();
                const seek = (e) => {
                    if (Number.isFinite(videoEl.duration) && videoEl.duration > 0) {
                        videoEl.currentTime = ((e.clientX - rect.left) / rect.width) * videoEl.duration;
                    }
                };
                seek(ev);
                const move = (e) => seek(e);
                const up = () => {
                    document.removeEventListener("mousemove", move);
                    document.removeEventListener("mouseup", up);
                };
                document.addEventListener("mousemove", move);
                document.addEventListener("mouseup", up);
            });
            imageArea.addEventListener("click", (ev) => {
                if (scrubBar.contains(ev.target) || foldBtn.contains(ev.target)) return;
                if (clipDurationMs() <= 0) return;
                ev.stopPropagation();
                if (videoEl.paused) videoEl.play().catch(() => {});
                else videoEl.pause();
            });

            // σ/Δ graph: hover to scrub, click to lock.
            sdCell.canvas.addEventListener("mousemove", (ev) => {
                if (!cachedSigmas) return;
                const rect = sdCell.canvas.getBoundingClientRect();
                const iW = Math.max(1, rect.width - 2 * GRAPH_PAD_X);
                const xSteps = Math.max(totalSteps || cachedSigmas.length, cachedSigmas.length, history.delta.length);
                const fx = (ev.clientX - rect.left - GRAPH_PAD_X) / iW;
                const idx = Math.max(0, Math.min(xSteps - 1, Math.round(fx * (xSteps - 1))));
                if (idx !== hoverStep) {
                    hoverStep = idx;
                    displayScrubStep();
                    drawAll();
                }
            });
            sdCell.canvas.addEventListener("mouseleave", () => {
                if (hoverStep != null) {
                    hoverStep = null;
                    if (lockedStep == null) displayScrubStep();
                    drawAll();
                }
            });
            sdCell.canvas.addEventListener("click", (ev) => {
                ev.preventDefault();
                ev.stopPropagation();
                if (lockedStep != null) {
                    lockedStep = null;
                } else if (cachedSigmas) {
                    const rect = sdCell.canvas.getBoundingClientRect();
                    const iW = Math.max(1, rect.width - 2 * GRAPH_PAD_X);
                    const xSteps = Math.max(totalSteps || cachedSigmas.length, cachedSigmas.length, history.delta.length);
                    const fx = (ev.clientX - rect.left - GRAPH_PAD_X) / iW;
                    lockedStep = Math.max(0, Math.min(xSteps - 1, Math.round(fx * (xSteps - 1))));
                }
                displayScrubStep();
                drawAll();
            });

            // 折叠按钮：只收起参数控件，画面与两个曲线框保留（状态持久化）。
            // 高度交给 onResize 按宽度重推——参数隐藏后自动变矮，无需另设固定值。
            function applyCompactMode(collapsed) {
                node._h3_compact = collapsed;
                if (node.properties) node.properties["bz_h3_compact"] = collapsed;

                node.widgets?.forEach(w => {
                    if (w.name === "h3_preview" || w.type === "hidden") return;
                    w.hidden = collapsed;
                });
                foldBtn.textContent = collapsed ? "⌄" : "⌃";
                foldBtn.title = collapsed ? "展开参数" : "折叠参数，仅显示画面";
                if (node.onResize) node.onResize(node.size);
                node.setDirtyCanvas(true, true);
            }
            foldBtn.addEventListener("click", (ev) => {
                ev.stopPropagation();
                applyCompactMode(!node._h3_compact);
            });

            const handler = (data) => {
                try {
                    if (Array.isArray(data.sigmas) && data.sigmas.length > 1) {
                        cachedSigmas = data.sigmas;
                        resetRun();
                    }
                    if (typeof data.image === "string") {
                        const mime = typeof data.mime === "string" ? data.mime : "image/jpeg";
                        if (typeof data.fps === "number" && data.fps > 0) bakedFps = data.fps;
                        setStepBlob(data.step, b64ToBlob(data.image, mime));
                    }
                    totalSteps = data.total || totalSteps;
                    if (data.step_ms != null) history.stepMs.push(data.step_ms);
                    if (data.delta != null) history.delta.push(data.delta);
                    lastAvgStepMs = data.avg_step_ms;
                    lastStep = data.step;
                    lastTotal = data.total;
                    lastW = data.w;
                    lastH = data.h;
                    lastCurrentStep = data.step;
                    drawAll();
                } catch (err) {
                    console.warn("[MiniMaxH3.PreviewOverride] decode failed:", err);
                }
            };
            node._h3PreviewHandler = handler;

            chainCallback(node, "onRemoved", function () {
                node._h3PreviewHandler = null;
                graphRO.disconnect();
                for (const u of stepBlobUrls) {
                    if (u) try { URL.revokeObjectURL(u); } catch {}
                }
                stepBlobUrls.length = 0;
                stepMimes.length = 0;
                hideVideo();
            });
        });
    },
});
