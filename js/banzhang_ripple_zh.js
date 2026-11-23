// 涟漪三节点的中文显示名：控件走 widget.label，端口走 slot.label。
// 内部参数名保持英文蛇形，前端面板按这些名字读写，不能改。
import { app } from "../../scripts/app.js";

const LABELS = {
    "BZ_RippleClip": {
        widgets: {
            video: "🎞️ 视频文件", duration: "⏱️ 片段时长", megapixels: "📐 输出分辨率（MP）",
            window_start: "🎬 窗口起始帧", crop: "✂️ 裁剪框",
            allow_upscale: "🔍 允许放大", resize_method: "🔧 缩放算法",
            output_width: "↔️ 适配宽度", output_height: "↕️ 适配高度",
        },
        inputs: {},
        outputs: {
            video: "🎬 视频",
            source_window: "🖼️ 图像", audio: "🔊 音频",
            first_frame: "🖼️ 首帧", last_frame: "🖼️ 尾帧",
            fps: "🎞️ 帧率", duration: "⏱️ 时长（秒）", total_frames: "🎞️ 总帧数",
        },
    },
    "BZ_RippleApply": {
        widgets: { prompt: "📝 生成提示词" },
        inputs: {
            clip: "🔤 文本编码器 CLIP", vae: "🧊 视频 VAE", ripple: "🎬 视频",
        },
        outputs: { positive: "🧭 正向条件", latent: "🧊 空白潜空间" },
    },
    "BZ_RippleOutput": {
        widgets: {
            save: "💾 保存内容", filename_prefix: "📁 文件名前缀",
        },
        inputs: { images: "🖼️ 生成画面", ripple: "🎬 视频" },
        outputs: {
            images: "🖼️ 成片画面", audio: "🔊 音频",
            frame_rate: "🎞️ 帧率", comparison: "↔️ 源片对比",
        },
    },
};

function pinName(node, labels) {
    for (const widget of node.widgets ?? []) {
        const text = labels.widgets[widget.name];
        if (text) widget.label = text;
    }
    for (const slot of node.inputs ?? []) {
        const text = labels.inputs[slot.name];
        if (text) { slot.label = text; slot.localized_name = text; }
    }
    for (const slot of node.outputs ?? []) {
        const text = labels.outputs[slot.name];
        if (text) { slot.label = text; slot.localized_name = text; }
    }
}

app.registerExtension({
    name: "班长.H3涟漪.中文标签",
    beforeRegisterNodeDef(nodeType, nodeData) {
        const labels = LABELS[nodeData.name];
        if (!labels) return;
        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const result = onNodeCreated?.apply(this, arguments);
            pinName(this, labels);
            return result;
        };
        const onConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function () {
            const result = onConfigure?.apply(this, arguments);
            // 刷新后端口与控件会重建，properties 恢复完再钉一次。
            queueMicrotask(() => pinName(this, labels));
            return result;
        };
    },
});
