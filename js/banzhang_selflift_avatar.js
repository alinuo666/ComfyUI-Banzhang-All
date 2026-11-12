// 🎯 SelfLift-Avatar 两个采样器节点的前端适配：中文参数名 + 悬停说明 + 分块状态栏。
//
// 为什么必须写在前端：这两个节点是老式 INPUT_TYPES 写法，后端 object_info 里只有
// "input" 结构；新版 ComfyUI 前端的参数中文名和悬停说明读的是 nodeData.inputs[name]
// 的 label / tooltip，读不到就只剩英文参数名、鼠标放上去也没有任何说明。
// 这里在控件创建那一刻直接把后端中文层写的中文名和说明贴到 widget 上，
// 同时补进 nodeData.inputs，让前端自己的悬停提示也能取到。刷新页面即生效。
import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const H3_NODE = "SelfLiftAvatarH3Sampler";
const IMG_NODE = "SelfLiftAvatarImageSampler";
const CONTROL_NAMES = new Set(["高分辨率分块", "省显存模式", "token分块大小", "权重缓存预算", "分块模式", "手动块数", "分块方向"]);

// 从后端 object_info 里把每个参数的中文名和说明取出来，避免文案在前后端各写一份。
function collectMeta(nodeData) {
    const out = {};
    const src = nodeData?.input ?? {};
    for (const section of ["required", "optional"]) {
        const group = src[section] ?? {};
        for (const key of Object.keys(group)) {
            const spec = group[key];
            const opts = Array.isArray(spec) && spec[1] && typeof spec[1] === "object" ? spec[1] : null;
            if (opts && (opts.label || opts.tooltip)) out[key] = opts;
        }
    }
    return out;
}

function read(node, name, fallback) {
    return node.widgets?.find((w) => w.name === name)?.value ?? fallback;
}

function settingsLine(node) {
    if (!read(node, "高分辨率分块", false)) return "设置：关闭（整帧一次算完）";
    const strategy = read(node, "省显存模式", "spatial");
    if (strategy !== "spatial") {
        const chunk = read(node, "token分块大小", 4096);
        const cache = strategy === "global_stream" ? ` | 权重缓存=${read(node, "权重缓存预算", 4)} GiB` : "";
        return `设置：${strategy}（全序列）| token分块=${chunk}${cache}`;
    }
    const mode = read(node, "分块模式", "auto");
    const axis = read(node, "分块方向", "auto");
    const tiles = mode === "manual" ? read(node, "手动块数", 2) : "自动 1~8";
    return `设置：空间分块·${mode === "manual" ? "手动" : "自动"} | 方向=${axis} | 块数=${tiles}`;
}

function actualLine(node) {
    if (!read(node, "高分辨率分块", false)) return "实际方案：不分块";
    const plan = node.selfliftTilingPlan;
    if (plan?.kind === "global") {
        const fallback = plan.fallback
            ? ` | 回退：${plan.fallback === "attention_backend" ? "dense 全序列注意力" : "全序列 dense + 分块 MLP"}`
            : "";
        const cache = plan.mode === "global_stream" ? ` | 权重缓存=${plan.weight_cache_gb} GiB` : "";
        return `实际方案：${plan.mode} 全序列 | token分块=${plan.token_chunk}${cache}${fallback}`;
    }
    const count = plan?.tiles;
    if (!Number.isInteger(count) || count < 1) return "实际方案：待估算（高清阶段准备时确定）";
    return `实际块数：${count} 块${count === 1 ? "（整图，不拆分）" : ""}`;
}

function display(node, text, plan) {
    const box = node.selfliftTilingPanel;
    if (!box) return;
    if (text !== undefined) {
        node.selfliftTilingLast = String(text);
        // plan 显式为 null 表示清除上一次运行；undefined 表示兼容旧的缓存文本。
        node.selfliftTilingPlan = plan ?? null;
        if (plan === undefined) {
            const match = String(text).match(/Effective \/ 实际:\s*(\d+)/);
            if (match) node.selfliftTilingPlan = { tiles: Number(match[1]) };
        }
    }
    const fallback = "未运行。实际方案在高清阶段准备时才会算出来。\n手动块数只在「手动」模式下有效；时间窗口不受这些选项控制。";
    box.value = actualLine(node) + "\n" + settingsLine(node) + "\n" + (node.selfliftTilingLast || fallback);
    node.setDirtyCanvas?.(true, true);
}

app.registerExtension({
    name: "Banzhang.SelfLiftAvatarZh",
    async beforeRegisterNodeDef(nodeType, nodeData) {
        const isH3 = nodeData.name === H3_NODE;
        if (!isH3 && nodeData.name !== IMG_NODE) return;

        const meta = collectMeta(nodeData);
        // 新版前端的悬停提示读 nodeData.inputs[name].tooltip，老式节点没有 inputs，这里补一份。
        const inputs = (nodeData.inputs ??= {});
        for (const [key, opts] of Object.entries(meta)) {
            inputs[key] = { ...(inputs[key] ?? {}), label: opts.label, tooltip: opts.tooltip };
        }

        const created = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const result = created?.apply(this, arguments);

            // 中文参数名 + 悬停说明
            for (const widget of this.widgets || []) {
                const opts = meta[widget.name];
                if (!opts) continue;
                if (opts.label) widget.label = opts.label;
                if (opts.tooltip) widget.tooltip = opts.tooltip;
            }

            if (isH3) {
                const box = document.createElement("textarea");
                box.readOnly = true;
                box.setAttribute("aria-label", "省显存方案");
                box.style.cssText = "width:100%;height:100%;box-sizing:border-box;resize:none;overflow:auto;font:12px/1.45 monospace;color:var(--input-text,#ddd);background:var(--comfy-input-bg,#222);border:1px solid var(--border-color,#555);padding:6px;";
                this.selfliftTilingPanel = box;
                this.addDOMWidget("selflift_tiling_plan", "selflift-tiling-status", box, { serialize: false });
                for (const widget of this.widgets || []) {
                    if (!CONTROL_NAMES.has(widget.name)) continue;
                    const callback = widget.callback;
                    const node = this;
                    widget.callback = function () {
                        const value = callback?.apply(this, arguments);
                        display(node, "设置已修改，重新运行才会算出新方案。");
                        return value;
                    };
                }
                this.size[0] = Math.max(this.size[0], 370);
                this.size[1] = Math.max(this.size[1], this.computeSize()[1] + 170);
                display(this);
            }
            return result;
        };

        if (!isH3) return;

        const configured = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function () {
            const result = configured?.apply(this, arguments);
            display(this);
            return result;
        };
        const executed = nodeType.prototype.onExecuted;
        nodeType.prototype.onExecuted = function (message) {
            const result = executed?.apply(this, arguments);
            if (message?.selflift_tiling) display(this, message.selflift_tiling.join("\n"), message.selflift_tiling_plan?.[0]);
            return result;
        };
    },
    setup() {
        api.addEventListener("selflift-avatar-tiling", (event) => {
            const id = String(event.detail?.node_id ?? "");
            // 根图事件用字符串 ID；子图仍靠 onExecuted 回传。
            const node = app.graph?.getNodeById(id) ?? (/^\d+$/.test(id) ? app.graph?.getNodeById(Number(id)) : null);
            if (node?.selfliftTilingPanel) display(node, event.detail.text, event.detail.plan);
        });
    },
});
