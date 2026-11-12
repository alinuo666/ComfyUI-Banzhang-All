import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

// ═══════════════════════════════════════════════════════════
//  执行中节点高亮：跑到的节点描绿 + 标题两侧加 ⚡，队列结束还原
//  移植自 ComfyUI_StarNodes/web/js/starnodes_appearance.js 的 setup()，
//  只取执行状态监听，不带它的主题配色与设置项。对所有节点生效。
//
//  2026-11-08 根治「重启后残留高亮」：
//  根因是旧版把临时视觉态写进 node.title / node.color，而这两个字段会被
//  自动保存进工作流，重启加载后没有 executing 事件去还原它。
//  现在在出入口两处隔离：保存出去时不带高亮，加载进来时洗掉历史残留。
//  视觉仍走 title/color，因为 litegraph 与 VueNodes 两套引擎都读这两个字段；
//  改 canvas 绘制层在 VueNodes 下不会显示。
// ═══════════════════════════════════════════════════════════

const ACTIVE_ICON = "⚡";
const ACTIVE_COLOR = "#009933";

// 状态字段用 _bz_exec_ 前缀而非原包的 _starnodes_：StarNodes 原扩展可能同时
// 装着，共用字段会互相还原对方的图标，两套高亮就乱了。
const ensureState = (node) => {
    if (node._bz_exec_is_running === undefined) {
        node._bz_exec_is_running = false;
        node._bz_exec_original_title = null;
        node._bz_exec_original_color = null;
    }
};

const cleanTitle = (title) => String(title ?? "").split(ACTIVE_ICON).join("").trim();

// 只清确属高亮残留的值，不碰用户自己起的标题与配色
const stripLeftovers = (node) => {
    if (typeof node.title === "string" && node.title.includes(ACTIVE_ICON)) {
        node.title = cleanTitle(node.title);
    }
    if (node.color === ACTIVE_COLOR) {
        node.color = undefined;
    }
};

const restore = (node) => {
    ensureState(node);
    if (node._bz_exec_is_running) {
        node.title = node._bz_exec_original_title;
        node.color = node._bz_exec_original_color;
        node._bz_exec_is_running = false;
    } else {
        stripLeftovers(node);
    }
};

// 先剥旧图标再写，重复执行时 ⚡ 不会越叠越多
const markRunning = (node) => {
    if (!node._bz_exec_is_running) {
        node._bz_exec_original_title = node.title;
        node._bz_exec_original_color = node.color;
        node._bz_exec_is_running = true;
        node.title = ACTIVE_ICON + cleanTitle(node.title || node.type) + ACTIVE_ICON;
        node.color = ACTIVE_COLOR;
    } else {
        node.title = ACTIVE_ICON + cleanTitle(node.title) + ACTIVE_ICON;
    }
};

// 保存前摘掉高亮，序列化拿到的永远是原标题原色；保存完立刻恢复显示。
// 两个入口都包：前端不同版本分别走 serialize / asSerialisable（已在前端包核实）。
const installSerializeGuard = () => {
    const graph = app.graph;
    if (!graph || graph._bz_exec_serialize_guard) return;
    graph._bz_exec_serialize_guard = true;
    for (const name of ["serialize", "asSerialisable"]) {
        const original = graph[name];
        if (typeof original !== "function") continue;
        graph[name] = function (...args) {
            const touched = [];
            for (const node of this._nodes || []) {
                if (node._bz_exec_is_running) {
                    restore(node);
                    touched.push(node);
                }
            }
            try {
                return original.apply(this, args);
            } finally {
                for (const node of touched) markRunning(node);
            }
        };
    }
};

const onExecuting = (e) => {
    // 首次执行时装守卫；换过 graph 对象会自然重装（新对象没有标记）
    installSerializeGuard();

    // 新版前端 payload 是 {node, display_node, prompt_id}，旧版是裸 id。
    // 本项目 banzhang_dev_utils.js 已按此兼容，取法与它一致。
    const raw = e.detail;
    const nodeId = (raw && typeof raw === "object") ? raw.node : raw;
    const nodes = app.graph?._nodes || [];

    // 队列结束：全量还原，顺手清掉任何残留图标
    if (nodeId == null) {
        for (const node of nodes) restore(node);
        if (app.canvas) app.canvas.setDirty(true, true);
        return;
    }

    for (const node of nodes) {
        ensureState(node);
        if (String(node.id) === String(nodeId)) {
            markRunning(node);
        } else if (node._bz_exec_is_running) {
            restore(node);
        }
    }
    if (app.canvas) app.canvas.setDirty(true, true);
};

app.registerExtension({
    name: "Banzhang.ExecHighlight",

    // 节点从存档恢复时洗掉旧版写进去的 ⚡ 和绿底，重启后不再残留
    beforeRegisterNodeDef(nodeType) {
        const onConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function (...args) {
            const result = onConfigure?.apply(this, args);
            stripLeftovers(this);
            return result;
        };
    },

    async setup() {
        api.addEventListener("executing", onExecuting);
        for (const node of app.graph?._nodes || []) stripLeftovers(node);
    }
});
