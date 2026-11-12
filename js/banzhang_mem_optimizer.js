// 💾 H3 显存优化（BanZhang_H3MemoryOptimizer）：
// 「省显存档位」选 ①②③ 时，下面 3 个细项全部隐藏 —— 新人只看一个下拉就够；
// 选 ④ 自定义 才展开细项。隐藏只影响界面显示，参数值照常保存、照常参与运行。

import { app } from "../../scripts/app.js";

const NODE_NAME = "BanZhang_H3MemoryOptimizer";
const GEAR_WIDGET = "省显存档位";
const CUSTOM = "④ 自定义（用下面的参数）";
const DETAIL_NAMES = ["前馈分块", "分块触发长度", "注意力头分组"];

function setWidgetVisible(widget, visible) {
    try { widget.hidden = !visible; } catch (e) { /* 忽略 */ }
    if (widget.inputEl && widget.inputEl.parentElement) {
        widget.inputEl.parentElement.style.display = visible ? "" : "none";
    }
}

function applyGearVisibility(node) {
    if (!node || !node.widgets) return;
    const gear = node.widgets.find((w) => w.name === GEAR_WIDGET);
    if (!gear) return;
    const showDetails = gear.value === CUSTOM;
    for (const name of DETAIL_NAMES) {
        const w = node.widgets.find((w) => w.name === name);
        if (w) setWidgetVisible(w, showDetails);
    }
    try {
        node.setSize(node.computeSize());
    } catch (e) { /* 隐藏不支持时保留原尺寸 */ }
    app.graph.setDirtyCanvas(true, true);
}

app.registerExtension({
    name: "Banzhang.H3MemOptimizerGear",
    beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== NODE_NAME) return;

        // 新建节点：挂上档位切换回调，并按默认档位初始化一次
        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const result = onNodeCreated ? onNodeCreated.apply(this, arguments) : undefined;
            const gear = this.widgets.find((w) => w.name === GEAR_WIDGET);
            if (gear) {
                const node = this;
                const origCallback = gear.callback;
                gear.callback = function (...args) {
                    const r = origCallback ? origCallback.apply(this, args) : undefined;
                    applyGearVisibility(node);
                    return r;
                };
            }
            applyGearVisibility(this);
            return result;
        };

        // 加载已保存的工作流：按保存的档位恢复显示
        const onConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function () {
            const result = onConfigure ? onConfigure.apply(this, arguments) : undefined;
            applyGearVisibility(this);
            return result;
        };
    },
});
