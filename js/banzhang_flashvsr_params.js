// 👨‍🏫 班长 FlashVSR 扩散超分（BanZhangFlashVSR）：
// 按「放大模式」只显示对应模式的参数，其余隐藏（与 🎬 H3 终极放大 完全同一套机制）。
//   按倍数   -> 放大倍数
//   目标尺寸 -> 目标宽度 / 目标高度
//   兆像素   -> 兆像素
// 隐藏仅影响界面显示；参数值仍正常保存到工作流、正常参与运行。

import { app } from "../../scripts/app.js";

const NODE_NAME = "BanZhangFlashVSR";
const MODE_WIDGET = "放大模式";
const MODE_TO_PARAMS = {
    "按倍数": ["放大倍数"],
    "目标尺寸": ["目标宽度", "目标高度"],
    "兆像素": ["兆像素"],
};

function setWidgetVisible(widget, visible) {
    try { widget.hidden = !visible; } catch (e) { /* 忽略 */ }
    if (widget.inputEl && widget.inputEl.parentElement) {
        widget.inputEl.parentElement.style.display = visible ? "" : "none";
    }
}

function applyModeVisibility(node) {
    if (!node || !node.widgets) return;
    const modeWidget = node.widgets.find((w) => w.name === MODE_WIDGET);
    if (!modeWidget) return;
    for (const [mode, paramNames] of Object.entries(MODE_TO_PARAMS)) {
        for (const name of paramNames) {
            const w = node.widgets.find((w) => w.name === name);
            if (w) setWidgetVisible(w, modeWidget.value === mode);
        }
    }
    try {
        node.setSize(node.computeSize());
    } catch (e) { /* 隐藏不支持时保留原尺寸 */ }
    app.graph.setDirtyCanvas(true, true);
}

app.registerExtension({
    name: "Banzhang.FlashVSRModeParams",
    beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== NODE_NAME) return;

        // 新建节点：挂上模式切换回调，并按默认值初始化一次
        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const result = onNodeCreated ? onNodeCreated.apply(this, arguments) : undefined;
            const modeWidget = this.widgets.find((w) => w.name === MODE_WIDGET);
            if (modeWidget) {
                const node = this;
                const origCallback = modeWidget.callback;
                modeWidget.callback = function (...args) {
                    const r = origCallback ? origCallback.apply(this, args) : undefined;
                    applyModeVisibility(node);
                    return r;
                };
            }
            applyModeVisibility(this);
            return result;
        };

        // 加载已保存的工作流：按保存的模式值恢复显示
        const onConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function () {
            const result = onConfigure ? onConfigure.apply(this, arguments) : undefined;
            applyModeVisibility(this);
            return result;
        };
    },
});
