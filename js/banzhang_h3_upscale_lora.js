// 🎬 H3 终极放大（BanZhang_MMH3_Upscale）· 内置 LoRA 控件前端
//   1) lora_file / lora_strength 两个英文控件钉中文显示名：新版前端不读
//      INPUT_TYPES options 里的 label，只能在控件创建时直接写 widget.label
//      （做法同 js/h3mc_zh_labels.js，刷新页面即生效，不依赖重启/语言包缓存）；
//   2) 内置 LoRA 选「🚫 关闭」时隐藏「LoRA 强度」——关闭时强度无意义；
//   3) 老工作流尾部多出的 widgets_values 按当前 widget 数截断（2026-11-08
//      主节点移除「音频重绘强度」后，旧存档会多带一个 0~1 的值，如 0.3）。
// 隐藏只影响界面显示，控件值仍正常保存到工作流、正常参与运行。

import { app } from "../../scripts/app.js";

const NODE_NAME = "BanZhang_MMH3_Upscale";
const FILE_WIDGET = "lora_file";
const STRENGTH_WIDGET = "lora_strength";
const OFF_VALUE = "🚫 关闭";
const ZH_LABELS = {
    lora_file: "内置 LoRA",
    lora_strength: "LoRA 强度",
};

function setWidgetVisible(widget, visible) {
    try { widget.hidden = !visible; } catch (e) { /* 忽略 */ }
    if (widget.inputEl && widget.inputEl.parentElement) {
        widget.inputEl.parentElement.style.display = visible ? "" : "none";
    }
}

function applyZhLabels(node) {
    for (const w of node.widgets || []) {
        const zh = ZH_LABELS[w.name];
        if (zh) w.label = zh;
    }
}

function applyLoraVisibility(node) {
    if (!node || !node.widgets) return;
    const fileW = node.widgets.find((w) => w.name === FILE_WIDGET);
    const strW = node.widgets.find((w) => w.name === STRENGTH_WIDGET);
    if (!fileW || !strW) return;
    setWidgetVisible(strW, fileW.value !== OFF_VALUE);
    try {
        node.setSize(node.computeSize());
    } catch (e) { /* 布局未就绪时保留原尺寸 */ }
    app.graph.setDirtyCanvas(true, true);
}

app.registerExtension({
    name: "Banzhang.H3UpscaleBuiltinLora",
    beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== NODE_NAME) return;

        // 新建节点：钉中文名、挂下拉切换回调，并按默认值初始化一次显隐
        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const result = onNodeCreated ? onNodeCreated.apply(this, arguments) : undefined;
            const node = this;
            applyZhLabels(node);

            const fileW = node.widgets?.find((w) => w.name === FILE_WIDGET);
            if (fileW) {
                const origCallback = fileW.callback;
                fileW.callback = function (...args) {
                    const r = origCallback ? origCallback.apply(this, args) : undefined;
                    applyLoraVisibility(node);
                    return r;
                };
            }
            applyLoraVisibility(node);
            return result;
        };

        // 加载已保存工作流：恢复中文 label 与强度框显隐、收回/补足节点高度
        const onConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function () {
            const result = onConfigure ? onConfigure.apply(this, arguments) : undefined;
            applyZhLabels(this);
            applyLoraVisibility(this);
            return result;
        };

        // ── 旧工作流迁移（在框架按位置赋值「之前」改写 widgets_values）──
        // 1) 新版控件顺序在端口后插入了 lora_file / lora_strength，而前端 configure
        //    是按数组位置逐个赋值的：旧存档的 widgets_values 第一项是随机种子（数字），
        //    新版第一项是 lora_file（字符串：关闭项或 LoRA 路径）。
        //    检测到旧格式（首项非字符串）→ 在头部补两个默认值（LoRA 默认关闭），
        //    旧参数即与新控件一一对齐、不会错位。API 调用按名字传值，不受此影响。
        // 2) 2026-11-08 移除末尾的「音频重绘强度」控件后，老存档会比现有 widget
        //    多一个 0~1 的值（如 0.3）。框架 configure 本来就会忽略多余值，但存档
        //    会一直带着脏数据；这里按当前实际 widget 数截断，下次保存即自动洗净。
        //    只截尾部、不动前面，且用 this.widgets.length 而非硬编码数字，
        //    以后增删 widget 也不会把值挪错位置。
        const prevConfigure = nodeType.prototype.configure;
        nodeType.prototype.configure = function (info) {
            const wv = info?.widgets_values;
            if (Array.isArray(wv) && wv.length > 0 && typeof wv[0] !== "string") {
                info.widgets_values = [OFF_VALUE, 1.0, ...wv];
            }
            const maxWidgets = this.widgets ? this.widgets.length : 0;
            if (maxWidgets > 0 && Array.isArray(info.widgets_values)
                && info.widgets_values.length > maxWidgets) {
                info.widgets_values = info.widgets_values.slice(0, maxWidgets);
            }
            return prevConfigure ? prevConfigure.apply(this, arguments) : undefined;
        };
    },
});
