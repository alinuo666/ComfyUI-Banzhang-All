// 涟漪三节点的中文显示名：控件走 widget.label，端口走 slot.label。
// 内部参数名保持英文蛇形，前端面板按这些名字读写，不能改。
import { app } from "../../scripts/app.js";

const ANCHOR_OUTPUT = /^anchor_(\d+)$/;
const ANCHOR_INPUT = /^edited_anchor_(\d+)$/;

const LABELS = {
    "BZ_RippleClip": {
        widgets: {
            video: "🎞️ 视频文件", duration: "⏱️ 片段时长（秒）", megapixels: "📐 画面尺寸（MP）",
            window_start: "🎬 窗口起始帧", markers: "🎯 编辑帧标记", crop: "✂️ 裁剪框",
            allow_upscale: "🔍 允许放大", resize_method: "🔧 缩放算法",
            output_width: "↔️ 适配宽度", output_height: "↕️ 适配高度",
        },
        inputs: {},
        outputs: {
            frames_to_edit: "📝 待编辑帧", ripple: "🌊 涟漪数据",
            source_window: "🎞️ 窗口原画面", audio: "🔊 原声音频",
        },
    },
    "BZ_RippleApply": {
        widgets: { prompt: "📝 传播指令" },
        inputs: {
            clip: "🔤 文本编码器 CLIP", vae: "🧊 视频 VAE", ripple: "🌊 涟漪数据",
            edited_images: "🖼️ 编辑帧批次",
        },
        outputs: { positive: "🧭 正向条件", latent: "🧊 空白潜空间" },
    },
    "BZ_RippleOutput": {
        widgets: {
            save: "💾 保存内容", filename_prefix: "📁 文件名前缀",
            show_anchor_markers: "🟡 显示锚点标记",
        },
        inputs: { images: "🖼️ 生成画面", ripple: "🌊 涟漪数据" },
        outputs: {
            images: "🖼️ 成片画面", audio: "🔊 原声音频",
            frame_rate: "🎞️ 帧率", comparison: "↔️ 源片对比",
        },
    },
};

function anchorLabel(name, pattern, text) {
    const match = pattern.exec(name ?? "");
    return match ? `${text} ${match[1]}` : null;
}

function pinName(node, labels) {
    for (const widget of node.widgets ?? []) {
        const text = labels.widgets[widget.name];
        if (text) widget.label = text;
    }
    for (const slot of node.inputs ?? []) {
        const text = labels.inputs[slot.name] ?? anchorLabel(slot.name, ANCHOR_INPUT, "✏️ 编辑锚点");
        if (text) { slot.label = text; slot.localized_name = text; }
    }
    for (const slot of node.outputs ?? []) {
        const text = labels.outputs[slot.name] ?? anchorLabel(slot.name, ANCHOR_OUTPUT, "🎯 锚点");
        if (text) { slot.label = text; slot.localized_name = text; }
    }
}

// 主扩展会动态增删 anchor_N / edited_anchor_N 端口，端口一创建就钉名，避免闪回英文。
function patchSlots(node, labels) {
    if (node._bzRippleSlotsPatched) return;
    node._bzRippleSlotsPatched = true;
    const addOutput = node.addOutput;
    const addInput = node.addInput;
    node.addOutput = function (...args) {
        const result = addOutput.apply(this, args);
        pinName(this, labels);
        return result;
    };
    node.addInput = function (...args) {
        const result = addInput.apply(this, args);
        pinName(this, labels);
        return result;
    };
}

app.registerExtension({
    name: "班长.H3涟漪.中文标签",
    beforeRegisterNodeDef(nodeType, nodeData) {
        const labels = LABELS[nodeData.name];
        if (!labels) return;
        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const result = onNodeCreated?.apply(this, arguments);
            patchSlots(this, labels);
            pinName(this, labels);
            return result;
        };
        const onConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function () {
            const result = onConfigure?.apply(this, arguments);
            // 刷新后端口与控件会重建，properties 恢复完再钉一次。
            queueMicrotask(() => { patchSlots(this, labels); pinName(this, labels); });
            return result;
        };
    },
});
