/**
 * BanZhang_WrapperParser — 动态输出端口扩展
 * 解析结果变化时，自动为每个字段重命名 / 增删输出端口（工具端口 JSON/记录数/预览 永不动）。
 * 初始零字段端口；示例以灰色 placeholder 呈现，不参与解析。
 */
import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const NODE_ID = "BanZhang_WrapperParser";
const MAX_PORTS = 24;
const UTIL_COUNT = 3; // 📦 JSON / 🔢 记录数 / 📄 预览

const W = {
    text: "输入文本",
    style: "包裹符格式",
    customRegex: "自定义正则(2捕获组:名称,内容)",
    fieldSpec: "输出字段清单(每行一个,留空=自动)",
};

// 灰色示例：仅提示格式，不是真实值
const PLACEHOLDER = [
    "<<<SCENE_VALUE>>>在此粘贴场景<<<SCENE_VALUE_END>>>",
    "<<<CHARACTER_VALUE>>>角色描述<<<CHARACTER_VALUE_END>>>",
    "<<<SHOT_VALUE>>>镜头与运镜<<<SHOT_VALUE_END>>>",
    "字段名与数量不限，解析后点「刷新端口」自动生成输出",
].join("\n");

const STYLE_KEYS = {
    "🤖 自动识别 (推荐)": "auto",
    "🔺 三角 <<<NAME>>>": "triangle",
    "🔤 XML <NAME>": "xml",
    "🔣 双花括号 {{NAME}}": "mustache",
    "📦 方括号 [NAME]": "bbcode",
    "✏️ 自定义正则": "custom",
};

function widget(node, name) {
    return node.widgets?.find((w) => w.name === name);
}
function value(node, name) {
    return widget(node, name)?.value;
}

// 清单行误粘包裹符时，从中提取字段名(四种风格的开标记)
// 与后端一致：字段名允许中文（中文模板 <<<歌名>>>…<<<歌名结束>>>）
const FIELD_MARKERS = [
    /<<<\s*([A-Za-z0-9_\u4e00-\u9fa5 ]+?)\s*>>>/,
    /<([A-Za-z\u4e00-\u9fa5][A-Za-z0-9_\u4e00-\u9fa5 ]*)>/,
    /\{\{\s*([A-Za-z0-9_\u4e00-\u9fa5 ]+?)\s*\}\}/,
    /\[\s*([A-Za-z0-9_\u4e00-\u9fa5 ]+?)\s*\]/,
];
// 中文放开后必须限长：否则整句正文（无标点）也会被当成字段名
const FIELD_VALID = /^(?:[A-Z0-9_]{1,24}|[\u4e00-\u9fa5][\u4e00-\u9fa5A-Za-z0-9_]{0,11})$/;

function normalizeName(raw) {
    let n = String(raw)
        .trim()
        .toUpperCase()
        .replace(/[\s-]+/g, "_")
        .replace(/^_+|_+$/g, "");
    if (n.endsWith("_VALUE")) n = n.slice(0, -6);
    return n;
}

/** 容错解析字段清单：提取/归一化字段名，非法行计入 dropped */
function parseFieldSpec(spec) {
    const names = [];
    let dropped = 0;
    for (const rawLine of String(spec || "").split("\n")) {
        const line = rawLine.trim();
        if (!line) continue;
        let token = line;
        for (const m of FIELD_MARKERS) {
            const hit = line.match(m);
            if (hit) {
                token = hit[1];
                break;
            }
        }
        const name = normalizeName(token);
        if (FIELD_VALID.test(name)) {
            if (!names.includes(name)) names.push(name);
        } else {
            dropped++;
        }
    }
    return { names: names.slice(0, MAX_PORTS), dropped };
}

async function detectFields(node) {
    // 用户字段清单优先（纯本地、确定性）
    const spec = parseFieldSpec(value(node, W.fieldSpec));
    if (spec.names.length) return { fields: spec.names, dropped: spec.dropped };

    // 自动模式：调用后端解析路由，避免在 JS 里重复正则逻辑
    let fields = [];
    try {
        const res = await api.fetchApi("/banzhang/parse_wrapper", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                text: value(node, W.text) ?? "",
                style: STYLE_KEYS[value(node, W.style)] ?? "auto",
                custom_pattern: value(node, W.customRegex) ?? "",
            }),
        });
        if (res.ok) {
            const data = await res.json();
            fields = (data.fields || []).slice(0, MAX_PORTS);
        }
    } catch (e) {
        fields = [];
    }
    return { fields, dropped: spec.dropped };
}

/** 在工具端口之前插入一个输出槽（addOutput 总是追加到末尾，先弹出再归位） */
function insertBeforeUtils(node, index, name) {
    node.addOutput(name, "STRING");
    const slot = node.outputs.pop();
    node.outputs.splice(index, 0, slot);
    // 之后的槽整体后移一位，其连线 origin_slot 同步 +1
    for (let i = index + 1; i < node.outputs.length; i++) {
        const s = node.outputs[i];
        if (s?.links && node.graph) {
            for (const linkId of s.links) {
                const link = node.graph._links.get(linkId);
                if (link) link.origin_slot++;
            }
        }
    }
}

/** 把动态端口同步为 fields；工具端口固定在末尾不动 */
function syncPorts(node, fields) {
    let dyn = Math.max(0, node.outputs.length - UTIL_COUNT);

    // 1. 就地重命名（不改变索引，已有连线安全）
    for (let i = 0; i < dyn; i++) {
        if (i < fields.length) {
            const slot = node.outputs[i];
            slot.name = fields[i];
            slot.label = fields[i];
            slot.type = "STRING";
        }
    }

    // 2. 从尾部移除多余且无连线的端口
    for (let i = dyn - 1; i >= fields.length; i--) {
        const slot = node.outputs[i];
        if (slot && (!slot.links || slot.links.length === 0)) {
            node.removeOutput(i);
        }
    }

    // 3. 字段数变多时，在工具端口前补槽
    let cur = Math.max(0, node.outputs.length - UTIL_COUNT);
    for (let i = cur; i < fields.length; i++) {
        insertBeforeUtils(node, i, fields[i]);
    }

    node.setDirtyCanvas?.(true, true);
}

let refreshSeq = 0;
async function refresh(node, silent = false) {
    const seq = ++refreshSeq;
    const { fields, dropped } = await detectFields(node);
    if (seq !== refreshSeq) return; // 已有更新的一次刷新
    syncPorts(node, fields);
    if (dropped > 0) {
        app.extensionManager?.toast?.(
            `字段清单有 ${dropped} 行不是合法字段名，已忽略（每行只填字段名，勿粘正文）`,
            { variant: "warning" }
        );
    } else if (!silent && !fields.length) {
        app.extensionManager?.toast?.("未检测到包裹字段，请检查输入或点刷新", { variant: "warning" });
    }
}

function hookCallback(node, name, cb) {
    const w = widget(node, name);
    if (!w) return;
    const orig = w.callback;
    w.callback = function () {
        const ret = orig?.apply(this, arguments);
        cb();
        return ret;
    };
}

/** 旧 litegraph：多行弹窗打开后给 textarea 钉灰色示例 */
function hookLegacyPopup(node, w) {
    const origMouse = w.mouse;
    w.mouse = function () {
        const ret = origMouse?.apply(this, arguments);
        setTimeout(() => {
            const ta = document.querySelector("textarea.comfy-multiline-input");
            if (ta && !ta.placeholder) ta.placeholder = PLACEHOLDER;
        }, 0);
        return ret;
    };
}

app.registerExtension({
    name: "banzhang.wrapper_parser",
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (!nodeData || nodeData.name !== NODE_ID) return;

        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const ret = onNodeCreated?.apply(this, arguments);
            const node = this;

            // 文本框：v2 走 options.placeholder（widgetPropFilter 为黑名单，placeholder 放行）
            const textW = widget(node, W.text);
            if (textW) {
                textW.options = { ...(textW.options || {}), placeholder: PLACEHOLDER };
                hookLegacyPopup(node, textW);
            }

            // 手动刷新按钮（显式可控）
            this.addWidget("button", "🔄 刷新端口", null, () => refresh(this));

            // 关键字段变化即同步
            hookCallback(this, W.style, () => refresh(this));
            hookCallback(this, W.customRegex, () => refresh(this));
            hookCallback(this, W.fieldSpec, () => refresh(this));
            hookCallback(this, W.text, () => refresh(this, true));

            // 初始零字段端口：删掉静态预置的 24 个占位槽，只留工具端口
            syncPorts(node, []);
            return ret;
        };

        const onConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function (info) {
            const ret = onConfigure?.apply(this, arguments);
            // 加载存档：优先用户字段清单，否则按存档中保存的动态端口名对齐
            const specified = parseFieldSpec(value(this, W.fieldSpec)).names;
            const saved = ((info?.outputs || [])
                .slice(0, Math.max(0, (info.outputs?.length || 0) - UTIL_COUNT))
                .map((s) => s.name)
                .filter(Boolean));
            syncPorts(this, specified.length ? specified : saved);
            return ret;
        };
    },
});
