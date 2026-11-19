// 🔍 图像对比器面板 — A/B 叠图 + 可拖分隔滑杆 + 帧批次帧滑条
// 尺寸挂载照 js/music_player_node.js 的真机验证模式：
// 面板高度双通道锁死（min=max=实测内容高）+ addDOMWidget 传 get*Height +
// 自然高测量 + 多轮重算。maxHeight 放开会被 v2 容器循环拉伸成无限长（2026-11-19 事故）。
// 宽度真值双写 properties 并在 onResize 纠正（Alt 复制 / Vue 覆盖都从这过）。
const { app } = window.comfyAPI.app;
const { api } = window.comfyAPI.api;

const STYLE_ID = "bz-image-compare-stylesheet";
function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
.bz-cmp-root { width:100%; position:relative; background:#181818;
  display:flex; flex-direction:column; overflow:hidden; user-select:none; box-sizing:border-box; }
.bz-cmp-area { flex:0 0 auto; position:relative; background:#0a0a0a;
  overflow:hidden; cursor:ew-resize; touch-action:none; }
.bz-cmp-img { position:absolute; inset:0; width:100%; height:100%; object-fit:contain;
  display:block; pointer-events:none; }
.bz-cmp-placeholder { position:absolute; inset:0; display:flex; align-items:center;
  justify-content:center; color:#707070; font:12px sans-serif; pointer-events:none; }
.bz-cmp-divider { position:absolute; top:0; bottom:0; width:2px; margin-left:-1px;
  background:#e67e22; pointer-events:none; z-index:4; }
.bz-cmp-handle { position:absolute; top:50%; left:50%; transform:translate(-50%,-50%);
  width:22px; height:22px; border-radius:50%; background:#e67e22; color:#181818;
  font:11px/22px sans-serif; text-align:center; }
.bz-cmp-tag { position:absolute; top:6px; z-index:3; padding:2px 7px; border-radius:4px;
  background:rgba(0,0,0,0.55); color:#ddd; font:11px sans-serif; pointer-events:none; }
.bz-cmp-tag-a { left:6px; }
.bz-cmp-tag-b { right:6px; }
.bz-cmp-framebar { flex:0 0 auto; display:flex; align-items:center; gap:8px;
  padding:5px 10px; background:#202020; border-top:1px solid #2a2a2a; }
.bz-cmp-framebar input[type=range] { flex:1 1 auto; min-width:0; accent-color:#e67e22; }
.bz-cmp-framelabel { flex:0 0 auto; color:#b0b0b0; font:11px monospace; white-space:nowrap; }
`;
    document.head.appendChild(style);
}

// 子图链 id（如 "12:7:5"）定位节点，与 minimax_h3_preview.js 同款
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

api.addEventListener("executed", (e) => {
    const d = e.detail;
    const out = d?.output?.bz_compare;
    if (!out || d.node == null) return;
    const node = findNodeByQualifiedId(app.graph, d.node);
    if (node?._bzCmpApply) node._bzCmpApply(out);
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

// ── 尺寸挂载常量与工具，逐行对齐 music_player_node.js ──
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
    name: "Banzhang.ImageCompare",
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData?.name !== "Banzhang_ImageCompare") return;

        chainCallback(nodeType.prototype, "onNodeCreated", function () {
            ensureStyles();
            const node = this;
            node.properties = node.properties || {};

            const root = el("div", "bz-cmp-root");
            const area = el("div", "bz-cmp-area", root);
            const imgA = el("img", "bz-cmp-img", area);
            const imgB = el("img", "bz-cmp-img", area);
            imgA.draggable = imgB.draggable = false;
            const placeholder = el("div", "bz-cmp-placeholder", area);
            placeholder.textContent = "运行一次后在此对比 A / B";
            const tagA = el("div", "bz-cmp-tag bz-cmp-tag-a", area);
            tagA.textContent = "A";
            const tagB = el("div", "bz-cmp-tag bz-cmp-tag-b", area);
            tagB.textContent = "B";
            const divider = el("div", "bz-cmp-divider", area);
            const handle = el("div", "bz-cmp-handle", divider);
            handle.textContent = "⇔";
            tagA.style.display = tagB.style.display = divider.style.display = "none";

            const frameBar = el("div", "bz-cmp-framebar", root);
            const frameSlider = el("input", "", frameBar);
            frameSlider.type = "range";
            frameSlider.min = "0";
            frameSlider.max = "0";
            frameSlider.value = "0";
            const frameLabel = el("span", "bz-cmp-framelabel", frameBar);
            frameLabel.textContent = "帧 1 / 1";
            frameBar.style.display = "none";

            // 面板交互不冒泡到画布（拖滑杆不带动节点 / 画布）
            root.addEventListener("mousedown", (e) => e.stopPropagation());
            root.addEventListener("keydown", (e) => e.stopPropagation());

            let data = null;
            let aspect = 16 / 9;   // 未出图前默认画幅，出图后按 A 的真实宽高比
            let frame = 0;
            let pos = 0.5;
            node._bzCmpH = 300;

            const panelWidget = node.addDOMWidget("bz_compare_panel", "bz_compare", root, {
                serialize: false,
                hideOnZoom: false,
                margin: PANEL_MARGIN,
                getMinHeight: () => node._bzCmpH,
                getMaxHeight: () => node._bzCmpH,
                getHeight: () => node._bzCmpH,
            });

            function declareHeight() {
                const pad = 2 * (panelWidget.margin ?? PANEL_MARGIN) - 4;
                panelWidget.computeSize = () => [node.size[0], node._bzCmpH + pad];
                panelWidget.computeLayoutSize = () => ({
                    minHeight: node._bzCmpH + pad,
                    maxHeight: node._bzCmpH + pad,
                    minWidth: 0,
                });
            }

            function fit() {
                // 画面区高度 = 宽/画幅，上下封顶；竖图 letterbox 显示，A/B 一致不影响对比
                const w = node.size?.[0] || PANEL_MINW;
                const areaH = Math.max(AREA_MIN_H, Math.min(AREA_MAX_H, Math.round(w / aspect)));
                area.style.height = areaH + "px";
                const h = naturalPanelHeight(root) || (areaH + (frameBar.style.display === "none" ? 0 : 30));
                if (h) node._bzCmpH = h;
                declareHeight();
                let cs = [0, 0];
                try { cs = node.computeSize() || [0, 0]; } catch (e) { }
                const m = panelWidget.margin ?? PANEL_MARGIN;
                const byDom = (panelWidget.y || 0) + m + node._bzCmpH + m + BOTTOM_PAD;
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
            node._bzCmpFit = scheduleFit;

            function viewURL(name) {
                const q = new URLSearchParams({
                    filename: name, subfolder: data.subfolder, type: data.type,
                });
                return "/view?" + q.toString();
            }

            function setPos(p) {
                pos = Math.max(0, Math.min(1, p));
                // clip-path 走合成层，拖动不触发重排；B 显示在分隔线右侧
                imgB.style.clipPath = `inset(0 0 0 ${pos * 100}%)`;
                divider.style.left = (pos * 100) + "%";
            }
            setPos(pos);

            function loadFrame(i) {
                if (!data || !data.a.length) return;
                frame = Math.max(0, Math.min(data.a.length - 1, i));
                frameSlider.value = String(frame);
                frameLabel.textContent = `帧 ${frame + 1} / ${data.a.length}`;
                imgA.src = viewURL(data.a[frame]);
                imgB.src = viewURL(data.b[Math.min(frame, data.b.length - 1)]);
            }

            imgA.addEventListener("load", () => {
                if (imgA.naturalWidth > 0 && imgA.naturalHeight > 0) {
                    aspect = imgA.naturalWidth / imgA.naturalHeight;
                    fit();
                }
            });

            function applyData(d) {
                data = d;
                // 面板状态双写：properties 供刷新 / Alt 复制后恢复
                node.properties.bz_cmp_data = d;
                placeholder.style.display = "none";
                tagA.style.display = tagB.style.display = divider.style.display = "";
                const n = d.a.length;
                frameBar.style.display = n > 1 ? "" : "none";
                frameSlider.max = String(Math.max(0, n - 1));
                loadFrame(0);
                scheduleFit();
                node.graph?.change?.();
            }
            node._bzCmpApply = applyData;

            // 分隔滑杆：用户直接操作，永远实时
            area.addEventListener("pointerdown", (e) => {
                if (e.button !== 0 || !data) return;
                e.preventDefault();
                e.stopPropagation();
                area.setPointerCapture(e.pointerId);
                const move = (ev) => {
                    const rect = area.getBoundingClientRect();
                    if (rect.width > 0) setPos((ev.clientX - rect.left) / rect.width);
                };
                move(e);
                const up = () => {
                    area.removeEventListener("pointermove", move);
                    area.removeEventListener("pointerup", up);
                    area.removeEventListener("pointercancel", up);
                };
                area.addEventListener("pointermove", move);
                area.addEventListener("pointerup", up);
                area.addEventListener("pointercancel", up);
            });

            frameSlider.addEventListener("input", () => loadFrame(parseInt(frameSlider.value, 10) || 0));

            // 宽度真值双写 + onResize 纠正：onResize 是尺寸唯一写入口，
            // 用户亲手拖边角记真值；Vue 覆盖 / Alt 副本 / configure 一律拉回。
            chainCallback(node, "onResize", function (size) {
                if (node._bzCmpFixingW) return;
                const truth = node.properties.bz_cmp_w;
                if (app.canvas?.resizing_node === node) {
                    node.properties.bz_cmp_w = size[0];
                } else if (typeof truth === "number" && Math.abs(size[0] - truth) > 1) {
                    node._bzCmpFixingW = true;
                    node.setSize([truth, size[1]]);
                    node._bzCmpFixingW = false;
                    return;
                } else if (typeof truth !== "number") {
                    node.properties.bz_cmp_w = size[0];
                }
                fit();
            });

            if (typeof ResizeObserver !== "undefined") {
                node._bzCmpRO = new ResizeObserver(() => fit());
                node._bzCmpRO.observe(root);
            }
            chainCallback(node, "onRemoved", function () {
                node._bzCmpRO?.disconnect();
                node._bzCmpRO = null;
            });

            node.size[0] = Math.max(node.size?.[0] ?? 0, PANEL_MINW);
            declareHeight();
            scheduleFit();

            chainCallback(node, "onConfigure", function () {
                const savedW = this.properties?.bz_cmp_w;
                if (typeof savedW === "number" && savedW >= 240 && Math.abs(node.size[0] - savedW) > 1) {
                    node._bzCmpFixingW = true;
                    node.setSize([savedW, node.size[1]]);
                    node._bzCmpFixingW = false;
                }
                const saved = this.properties?.bz_cmp_data;
                if (saved && saved.a?.length) applyData(saved);
                scheduleFit();
            });
        });
    },
});