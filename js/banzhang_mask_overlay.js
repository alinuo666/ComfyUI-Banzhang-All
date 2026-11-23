// 🎨 遮罩叠画预览面板 — 叠色结果单图，多帧自动无限循环（无控件行）
// 骨架逐行参照 js/banzhang_image_compare.js（其尺寸挂载模式来自
// music_player_node.js 的真机验证）：面板高度双通道锁死（min=max=实测内容高）
// + addDOMWidget 传 get*Height + 自然高测量 + 多轮重算。maxHeight 放开会被 v2
// 容器循环拉伸成无限长（2026-11-19 事故）。宽度真值双写 properties 并在
// onResize 纠正（Alt 复制 / Vue 覆盖都从这过）。
// 播放性能口径（2026-11-20 卡顿修复，同日二次修正为双缓冲）：
//  ① rAF 自定拍取代 setInterval——上一帧没换上就原地等，欠的账永不补放；
//  ② 双缓冲换帧——新帧先装进隐藏 img，load（解码就绪）才交换可见性；单 img
//     直接换 src 是「先空白后显示」，24fps 下整片闪屏，此机制从根上杜绝；
//  ③ 滚动预取窗口 + decoding="async"——hidden.src 基本命中缓存，交换零等待；
//  ④ 换帧回调只在宽高比真变化时 fit()——杜绝逐帧 DOM 测量 + 全画布重绘。
const { app } = window.comfyAPI.app;
const { api } = window.comfyAPI.api;

const STYLE_ID = "bz-mask-overlay-stylesheet";
function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
.bz-mo-root { width:100%; position:relative; background:#181818;
  display:flex; flex-direction:column; overflow:hidden; user-select:none; box-sizing:border-box; }
.bz-mo-area { flex:0 0 auto; position:relative; background:#0a0a0a;
  overflow:hidden; touch-action:none; }
.bz-mo-img { position:absolute; inset:0; width:100%; height:100%; object-fit:contain;
  display:block; pointer-events:none; }
.bz-mo-placeholder { position:absolute; inset:0; display:flex; align-items:center;
  justify-content:center; color:#707070; font:12px sans-serif; pointer-events:none; }
`;
    document.head.appendChild(style);
}

// 子图链 id（如 "12:7:5"）定位节点，与图像对比器同款
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

// /view 同款 URL 会被浏览器缓存，循环第二圈起直接命中，所以只需用 Image()
// 提前把接下来一段帧塞进缓存；窗口太大白占内存，太小追不上 24fps。
const PRELOAD_WINDOW = 24;

api.addEventListener("executed", (e) => {
    const d = e.detail;
    // 核心约定 UI 值是列表（裸字典会被合并逻辑 flatten 成键名数组），取首条
    const raw = d?.output?.bz_mask_overlay;
    const out = Array.isArray(raw) ? raw[0] : raw;
    if (!out || d.node == null) return;
    const node = findNodeByQualifiedId(app.graph, d.node);
    if (node?._bzMoApply) node._bzMoApply(out);
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

// ── 尺寸挂载常量与工具，逐行对齐 banzhang_image_compare.js ──
const PANEL_MARGIN = 4;
const BOTTOM_PAD = 8;
const PANEL_MINW = 330;
const AREA_MIN_H = 140;
const AREA_MAX_H = 700;   // 竖图按宽高比推导会冲上千像素，封顶防「无限长」

function naturalPanelHeight(el) {
    // 临时解除 v2 容器对元素的高度锁定 / flex 拉伸，测内容自然高后还原
    const keys = ["height", "minHeight", "maxHeight", "flex", "alignSelf"];
    const old = keys.map((k) => el.style[k]);
    el.style.height = "auto";
    el.style.minHeight = "0px";
    el.style.maxHeight = "none";
    el.style.flex = "0 0 auto";
    el.style.alignSelf = "flex-start";
    const h = el.offsetHeight | 0;
    keys.forEach((k, i) => { el.style[k] = old[i]; });
    return h;
}

app.registerExtension({
    name: "Banzhang.MaskOverlayPreview",
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData?.name !== "BanZhang_MaskOverlayPreview") return;

        chainCallback(nodeType.prototype, "onNodeCreated", function () {
            ensureStyles();
            const node = this;
            node.properties = node.properties || {};

            const root = el("div", "bz-mo-root");
            const area = el("div", "bz-mo-area", root);
            // 双缓冲：换帧先装进隐藏层，图就绪（load 事件）才交换可见性。
            // 单 img 直接换 src 会「先空白再显示」，24fps 下就是整片闪屏（2026-11-20 事故）。
            const layers = [el("img", "bz-mo-img", area), el("img", "bz-mo-img", area)];
            layers.forEach((l) => { l.draggable = false; l.decoding = "async"; });
            let shown = layers[0], hidden = layers[1];
            hidden.style.visibility = "hidden";
            const placeholder = el("div", "bz-mo-placeholder", area);
            placeholder.textContent = "运行一次后在此循环播放遮罩叠加效果";

            // 面板交互不冒泡到画布
            root.addEventListener("mousedown", (e) => e.stopPropagation());

            let data = null;
            let aspect = 16 / 9;   // 未出图前默认画幅，出图后按真实宽高比
            let frame = -1;
            let rafId = 0;
            let lastAt = 0;
            let awaiting = false;
            const preloading = new Set();
            node._bzMoH = 300;

            const panelWidget = node.addDOMWidget("bz_overlay_panel", "bz_overlay", root, {
                serialize: false,
                hideOnZoom: false,
                margin: PANEL_MARGIN,
                getMinHeight: () => node._bzMoH,
                getMaxHeight: () => node._bzMoH,
                getHeight: () => node._bzMoH,
            });

            function declareHeight() {
                const pad = 2 * (panelWidget.margin ?? PANEL_MARGIN) - 4;
                panelWidget.computeSize = () => [node.size[0], node._bzMoH + pad];
                panelWidget.computeLayoutSize = () => ({
                    minHeight: node._bzMoH + pad,
                    maxHeight: node._bzMoH + pad,
                    minWidth: 0,
                });
            }

            function fit() {
                // 画面区高度 = 宽/画幅，上下封顶；与对比器同一口径（控件行已删）
                const w = node.size?.[0] || PANEL_MINW;
                const areaH = Math.max(AREA_MIN_H, Math.min(AREA_MAX_H, Math.round(w / aspect)));
                area.style.height = areaH + "px";
                const h = naturalPanelHeight(root) || areaH;
                if (h) node._bzMoH = h;
                declareHeight();
                let cs = [0, 0];
                try { cs = node.computeSize() || [0, 0]; } catch (e) { }
                const m = panelWidget.margin ?? PANEL_MARGIN;
                const byDom = (panelWidget.y || 0) + m + node._bzMoH + m + BOTTOM_PAD;
                const needH = Math.ceil(Math.max(cs[1] || 0, byDom));
                const needW = Math.max(cs[0] || 0, node.size?.[0] || 0, PANEL_MINW);
                if (Math.abs((node.size?.[1] || 0) - needH) > 2 || needW > (node.size?.[0] || 0)) {
                    node.setSize([needW, needH]);
                    node.setDirtyCanvas?.(true, true);
                }
            }
            function scheduleFit() {
                fit();
                requestAnimationFrame(() => fit());
                setTimeout(() => fit(), 60);
                setTimeout(() => fit(), 300);
            }
            node._bzMoFit = scheduleFit;

            function urlOf(i) {
                const q = new URLSearchParams({
                    filename: data.frames[i], subfolder: data.subfolder, type: data.type,
                });
                return "/view?" + q.toString();
            }

            function preloadAhead(start) {
                const n = data.frames.length;
                for (let k = 1; k <= PRELOAD_WINDOW && k < n; k++) {
                    const url = urlOf((start + k) % n);
                    if (preloading.has(url)) continue;
                    preloading.add(url);
                    const probe = new Image();
                    probe.decoding = "async";
                    probe.src = url;   // 只为塞进浏览器缓存，不挂 DOM
                }
            }

            // 换帧 = 装进隐藏层，load（解码就绪）那一刻才交换可见性——交换瞬间
            // 显示的旧图还在原位，浏览器永远不会出现空帧，闪屏从机制上杜绝。
            function swapTo(i) {
                if (!data) return;
                frame = i;
                awaiting = true;
                preloadAhead(i);
                hidden.onload = () => {
                    const ratio = hidden.naturalWidth / hidden.naturalHeight;
                    if (ratio > 0 && Math.abs(ratio - aspect) > 1e-6) {
                        aspect = ratio;
                        fit();
                    }
                    hidden.style.visibility = "visible";
                    shown.style.visibility = "hidden";
                    const t = shown; shown = hidden; hidden = t;
                    awaiting = false;
                    lastAt = performance.now();
                };
                hidden.onerror = () => { awaiting = false; };   // 坏帧跳过，不卡引擎
                hidden.src = urlOf(i);
            }

            // rAF 自定拍：到点且上一帧已换上才发下一帧；图没回就原地等，
            // 天然不堆积。document.hidden 停摆省电。
            function tick(now) {
                rafId = requestAnimationFrame(tick);
                if (!data || data.frames.length < 2 || document.hidden || awaiting) return;
                const step = 1000 / (data.fps || 24);
                if (now - lastAt < step) return;
                swapTo((frame + 1) % data.frames.length);
            }

            function applyData(d) {
                data = d;
                // 面板状态双写：properties 供刷新 / Alt 复制后恢复
                node.properties.bz_mo_data = d;
                placeholder.style.display = "none";
                frame = -1;
                awaiting = false;
                preloading.clear();
                swapTo(0);
                if (d.frames.length > 1) {
                    if (!rafId) { lastAt = performance.now(); rafId = requestAnimationFrame(tick); }
                } else if (rafId) {
                    cancelAnimationFrame(rafId);
                    rafId = 0;
                }
                scheduleFit();
                node.graph?.change?.();
            }
            node._bzMoApply = applyData;

            // 宽度真值双写 + onResize 纠正：onResize 是尺寸唯一写入口，
            // 用户亲手拖边角记真值；Vue 覆盖 / Alt 副本 / configure 一律拉回。
            chainCallback(node, "onResize", function (size) {
                if (node._bzMoFixingW) return;
                const truth = node.properties.bz_mo_w;
                if (app.canvas?.resizing_node === node) {
                    node.properties.bz_mo_w = size[0];
                } else if (typeof truth === "number" && Math.abs(size[0] - truth) > 1) {
                    node._bzMoFixingW = true;
                    node.setSize([truth, size[1]]);
                    node._bzMoFixingW = false;
                    return;
                } else if (typeof truth !== "number") {
                    node.properties.bz_mo_w = size[0];
                }
                fit();
            });

            if (typeof ResizeObserver !== "undefined") {
                node._bzMoRO = new ResizeObserver(() => fit());
                node._bzMoRO.observe(root);
            }
            chainCallback(node, "onRemoved", function () {
                node._bzMoRO?.disconnect();
                node._bzMoRO = null;
                if (rafId) cancelAnimationFrame(rafId);
                rafId = 0;
            });

            node.size[0] = Math.max(node.size?.[0] ?? 0, PANEL_MINW);
            declareHeight();
            scheduleFit();

            chainCallback(node, "onConfigure", function () {
                const savedW = this.properties?.bz_mo_w;
                if (typeof savedW === "number" && savedW >= 240 && Math.abs(node.size[0] - savedW) > 1) {
                    node._bzMoFixingW = true;
                    node.setSize([savedW, node.size[1]]);
                    node._bzMoFixingW = false;
                }
                const saved = this.properties?.bz_mo_data;
                if (saved && saved.frames?.length) applyData(saved);
                scheduleFit();
            });
        });
    },
});
