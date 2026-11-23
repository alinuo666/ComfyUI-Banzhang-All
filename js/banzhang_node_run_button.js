import { app } from "../../scripts/app.js";

const buttonName = "banzhang_queue_selected_outputs";
const headerSelector = ".lg-node-header[data-testid^='node-header-']";
const playShape = "M-2.8-3.7 Q-2.8-4.9-1.7-4.2 L4.2-.8 Q5.6 0 4.2.8 L-1.7 4.2 Q-2.8 4.9-2.8 3.7 Z";
const playPath = new Path2D(playShape);
const buttons = new WeakMap();
let hovered = null;

function installButton(node) {
    if (buttons.has(node) || !node.addTitleButton) return;
    const button = node.addTitleButton({ name: buttonName, text: "运行", height: 24 });
    button.getWidth = () => 26;
    button.draw = (ctx, x, y) => drawRunButton.call(button, ctx, x, y, hovered === button);
    buttons.set(node, button);
}

function drawRunButton(ctx, x, y, hovered) {
    // 同一个矩形交给 LiteGraph 判定点击，也用于鼠标悬停。右侧留出标题边距。
    const area = this._last_area;
    area[0] = x;
    area[1] = y;
    area[2] = this.getWidth();
    area[3] = this.height;
    ctx.save();
    ctx.translate(x + 12, y + this.height / 2);
    const surface = ctx.createLinearGradient(0, -9, 0, 9);
    surface.addColorStop(0, hovered ? "#70b5ff" : "#e7ecf2");
    surface.addColorStop(1, hovered ? "#2176df" : "#aebac8");
    ctx.beginPath();
    ctx.arc(0, 0, 9, 0, 2 * Math.PI);
    ctx.fillStyle = surface;
    ctx.fill();
    ctx.lineWidth = 1;
    ctx.strokeStyle = "rgba(255,255,255,.48)";
    ctx.stroke();
    ctx.fillStyle = hovered ? "#fff" : "#344352";
    ctx.fill(playPath);
    ctx.restore();
}

function queueFrom(node) {
    const canvas = app.canvas;
    if (!node || node.graph !== canvas.getCurrentGraph()) return;
    // 点已选节点保留多选，点选区外节点则只对它执行原生命令。
    if (!canvas.selectedItems.has(node)) canvas.selectNodes([node], false);
    return app.extensionManager.command.execute("Comfy.QueueSelectedOutputNodes");
}

function addHeaderButton(header) {
    const row = header.firstElementChild;
    if (!row || row.querySelector(".bz-node-run")) return;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "bz-node-run";
    button.innerHTML = `<svg width="12" height="12" viewBox="-6 -6 12 12" aria-hidden="true"><path fill="currentColor" d="${playShape}"/></svg>`;
    button.title = "对所选输出节点进行排队";
    button.setAttribute("aria-label", button.title);
    for (const event of ["pointerdown", "mousedown", "dblclick"]) {
        button.addEventListener(event, e => e.stopPropagation());
    }
    button.onclick = e => {
        e.stopPropagation();
        const id = header.dataset.testid.slice("node-header-".length);
        queueFrom(app.canvas.getCurrentGraph()?.getNodeById(id));
    };
    row.append(button);
}

app.registerExtension({
    name: "Banzhang.NodeRunButton",
    nodeCreated: installButton,
    loadedGraphNode: installButton,
    setup() {
        const canvas = app.canvas;
        const style = document.createElement("style");
        style.textContent = `
            canvas.bz-run-hover, .lg-node-header .bz-node-run { cursor: pointer !important; }
            .lg-node-header .bz-node-run {
                display: grid; place-items: center; flex: none; box-sizing: border-box;
                width: 20px; height: 20px; margin-inline: 2px 4px; padding: 0;
                border: 1px solid rgba(255,255,255,.48); border-radius: 50%;
                color: #344352; background: linear-gradient(#e7ecf2, #aebac8);
            }
            .lg-node-header .bz-node-run:is(:hover,:focus-visible) {
                color: white; background: linear-gradient(#70b5ff, #2176df);
            }
            .lg-node-header .bz-node-run:focus-visible { outline: 2px solid #70b5ff; outline-offset: 2px; }
            .lg-node-header .bz-node-run svg { pointer-events: none; }
        `;
        document.head.append(style);
        // 前端虚拟节点也可直接加入图。在节点入图时注册，避免截断画布的绘制链。
        function watchGraph(graph) {
            graph.nodes.forEach(installButton);
            graph.events?.addEventListener("node:added", e => installButton(e.detail.node));
        }
        watchGraph(app.graph);
        app.graph.events?.addEventListener("subgraph-created", e => watchGraph(e.detail.subgraph));
        function setHover(button) {
            if (hovered === button) return;
            hovered = button;
            canvas.canvas.classList.toggle("bz-run-hover", !!button);
            canvas.setDirty(true, true);
        }
        canvas.canvas.addEventListener("pointermove", e => {
            if (e.buttons) return setHover(null);
            const [x, y] = canvas.convertEventToCanvasOffset(e);
            const node = canvas.getCurrentGraph()?.getNodeOnPos(x, y, canvas.visible_nodes);
            const button = buttons.get(node);
            setHover(button && !node.flags.collapsed && button.isPointInside(x - node.pos[0], y - node.pos[1])
                ? button : null);
        });
        canvas.canvas.addEventListener("pointerleave", () => setHover(null));
        canvas.canvas.addEventListener("pointercancel", () => setHover(null));
        canvas.canvas.addEventListener("litegraph:node-title-button-clicked", e => {
            if (e.detail.button.name === buttonName) queueFrom(e.detail.node);
        });

        // Vue Nodes 的标题由 DOM 绘制，新挂载的标题需要单独补上按钮。
        document.querySelectorAll(headerSelector).forEach(addHeaderButton);
        new MutationObserver(records => {
            for (const record of records) {
                for (const el of record.addedNodes) {
                    if (!(el instanceof Element) || el.classList.contains("bz-node-run")) continue;
                    if (el.matches(headerSelector)) addHeaderButton(el);
                    else el.querySelectorAll(headerSelector).forEach(addHeaderButton);
                }
            }
        }).observe(document.body, { childList: true, subtree: true });
        canvas.setDirty(true, true);
    },
});
