// 🎬 H3 终极放大参数（BanZhang_MMH3_UpscaleParams）：旧工作流 widgets_values 迁移。
//
// 2026-11-08 节点从 12 个控件精简到 5 个（只留 放大模型 / 放大倍数 / 显存预设 /
// 每块帧数 / 重叠帧数）。原文件做的事是「按放大模式显隐控件」，模式已删，故改为迁移。
//
// 为什么必须迁移：ComfyUI 的 LGraphNode.configure() 是按 widgets_values 的**位置**
// 回填的，不是按控件名：
//     for (i...) if (this.widgets[i]) this.widgets[i].value = info.widgets_values[i];
// 控件一少，老工程整列错位 —— 12 项老布局下新版会读成：
//     放大模型 = 模型名（对）、放大倍数 = "按倍数"、显存预设 = 1.5、
//     每块帧数 = 1280、重叠帧数 = 704。
// onConfigure 在 configure 末尾调用且能拿到原始 info，在这里按旧索引重映射最稳。
// 项目档案记过同款事故（曾把「预显影强度」读成 73），不要在后端补占位控件了事。

import { app } from "../../scripts/app.js";

const NODE_NAME = "BanZhang_MMH3_UpscaleParams";

// 与 BanZhang_MMH3_UpscaleParams.INPUT_TYPES()["required"] 的字典顺序逐字对应。
// 后端增删控件时，这张表和下面的 LAYOUTS 必须一起改。
const NEW_NAMES = ["放大模型", "放大倍数", "显存预设", "每块帧数", "重叠帧数"];
const VRAM_PRESETS = ["4 GB", "6 GB", "8 GB", "12 GB", "16 GB", "24 GB"];
const OLD_MODES = ["按倍数", "目标尺寸", "兆像素"];
const TAG = "[🎬 H3 终极放大参数]";

// 旧布局 → 新控件取值（数字 = 旧 widgets_values 的索引）。
// 12 项（精简前的当前版）：
//   0 放大模型 / 1 放大模式 / 2 放大倍数 / 3 目标宽度 / 4 目标高度 / 5 兆像素
//   6 显存预设 / 7 预显影步数 / 8 预显影强度 / 9 每块帧数 / 10 重叠帧数
//   11 放大时间分块
// 9 项（更老，中间还有个已删的「模型精度」）：
//   0~5 同上 / 6 模型精度（"fp16" / "bf16"）/ 7 显存预设 / 8 预显影步数
//   该版本还没有「每块帧数 / 重叠帧数」，两项留节点默认值。
const LAYOUTS = {
    12: {
        map: { "放大模型": 0, "放大倍数": 2, "显存预设": 6, "每块帧数": 9, "重叠帧数": 10 },
        mode: 1, preSteps: 7, upChunk: 11,
    },
    9: {
        map: { "放大模型": 0, "放大倍数": 2, "显存预设": 7 },
        mode: 1, preSteps: 8, upChunk: null,
    },
};

function widgetOf(node, name) {
    return (node.widgets || []).find((w) => w && w.name === name) || null;
}

function setValue(node, name, value) {
    const w = widgetOf(node, name);
    if (w && value !== undefined && value !== null) w.value = value;
}

/** 老工程里可能存着已下架的 ⚡ 免模型插值档。
 *  不擅自替换：换真模型会改变出片方式、还可能爆显存；运行侧仍兼容该标签。
 *  只给一条明确提示，让用户自己决定要不要重选。 */
function legacyModelNotes(node) {
    const name = String(widgetOf(node, "放大模型")?.value ?? "");
    if (!name.startsWith("⚡")) return [];
    return [`原「放大模型=${name}」是 2026-11-08 已从下拉移除的免模型插值档；`
        + "本次仍按历史方式兼容执行（结果基线不变），但下拉不再显示它，"
        + "如需改用真实放大模型请手动重选"];
}

/** 把一份老 widgets_values 映射到新控件上；返回给用户看的提示行数组。 */
export function migrateWidgetValues(node, info) {
    const old = info && info.widgets_values;
    if (!Array.isArray(old)) return [];
    // 已经是新布局也要查一下老 ⚡ 模型标签（值可能随工程一起存下来了）。
    if (old.length === NEW_NAMES.length) return legacyModelNotes(node);
    const layout = LAYOUTS[old.length];
    if (!layout) {
        return [`识别不了的 widgets_values 长度 ${old.length}，`
            + "控件值可能错位，请手动核对本节点的 5 个参数。"];
    }
    // 双重确认这确实是本节点的旧布局，避免别的原因造成的长度变化被误改。
    if (!OLD_MODES.includes(old[layout.mode])) return [];

    // configure() 已经把旧值按位置塞进了新控件（9 项布局下「每块帧数」会读到
    // 1280、「重叠帧数」读到 704）。map 没覆盖的那几项必须先清回默认，否则
    // 「老工程没有时间分块控件」会被误当成用户手填了 1280 帧。
    const FALLBACK = { "放大倍数": 2.0, "显存预设": "24 GB", "每块帧数": 73, "重叠帧数": 22 };
    for (const [name, value] of Object.entries(FALLBACK)) setValue(node, name, value);
    for (const [name, idx] of Object.entries(layout.map)) setValue(node, name, old[idx]);

    // 类型 / 取值域兜底：老值错位塞进 combo 会让控件显示空白。
    const scale = Number(widgetOf(node, "放大倍数")?.value);
    if (!Number.isFinite(scale) || scale < 1 || scale > 4) setValue(node, "放大倍数", 2.0);
    const preset = widgetOf(node, "显存预设")?.value;
    if (!VRAM_PRESETS.includes(preset)) setValue(node, "显存预设", "24 GB");
    for (const name of ["每块帧数", "重叠帧数"]) {
        const v = Number(widgetOf(node, name)?.value);
        if (!Number.isFinite(v) || v < 5) setValue(node, name, name === "每块帧数" ? 73 : 22);
    }

    // 被移除的能力，得让用户知道这次加载悄悄改了什么。
    const notes = legacyModelNotes(node);
    const mode = old[layout.mode];
    if (mode !== "按倍数") {
        notes.push(`原「放大模式=${mode}」已移除，现按倍数 ${widgetOf(node, "放大倍数")?.value} 计算尺寸`
            + "（原目标宽度 / 高度 / 兆像素不再生效）");
    }
    const pre = Number(old[layout.preSteps]);
    if (Number.isFinite(pre) && pre > 0) {
        notes.push(`原「预显影步数=${pre}」已移除，本次不做预显影`);
    }
    if (layout.upChunk !== null) {
        const chunk = String(old[layout.upChunk] ?? "");
        if (chunk && !chunk.startsWith("自动")) {
            notes.push(`原「放大时间分块=${chunk}」手动档已移除，改为按空闲显存自动挑块长（12~32）`);
        }
    }
    return notes;
}

app.registerExtension({
    name: "Banzhang.H3UpscaleParamsMigrate",
    beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== NODE_NAME) return;
        const onConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function (info) {
            const result = onConfigure ? onConfigure.apply(this, arguments) : undefined;
            try {
                const notes = migrateWidgetValues(this, info);
                if (notes.length) {
                    console.warn(TAG, `已从 ${info.widgets_values.length} 项老布局迁移：`, ...notes);
                }
                app.graph?.setDirtyCanvas(true, true);
            } catch (e) {
                console.warn(TAG, "迁移失败，沿用后端兜底值：", e);
            }
            return result;
        };
    },
});
