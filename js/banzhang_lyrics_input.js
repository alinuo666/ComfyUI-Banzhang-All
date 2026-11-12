// 📝 手动输入歌词（BanZhang_LyricsInput）前端增强
// 一个布尔按钮两态：
//   📌 固定   = 跟随上游（默认）：执行后传入文本回填进编辑框，可直接改，运行会刷新
//   🔓 取消固定 = 已固定：框内内容定格，可自由编辑，运行 / 刷新都不被上游覆盖
//
// 实现要点：
// - 固定状态由后端 BOOLEAN widget「pinned」承载（随工作流持久化），前端隐藏原生勾选框，
//   只留一个 button 翻转它（铁律第 4 节隐藏写法）
// - 兼容旧版 combo 存档：pinned 被恢复成中文枚举字符串时归一化为布尔
// - 端口中文标签走 slot.label 钉名（铁律第 7 节）

import { app } from "../../scripts/app.js";

const NODE_NAME = "BanZhang_LyricsInput";
const W_TEXT = "📝 歌词文本";
const OLD_PIN_CN = "📌 固定编辑";   // 旧版 combo 存档兼容

/* ---------------- 通用辅助 ---------------- */

// 铁律第 4 节：隐藏 / 显示原生 widget 的唯一合法写法（旧 litegraph 与 v2 双通道，保存原值以便还原）
function setWidgetHidden(w, hidden) {
    if (!w) return;
    if (hidden && !w._bzHidden) {
        w._bzSaved = { computeSize: w.computeSize, computeLayoutSize: w.computeLayoutSize, draw: w.draw, mouse: w.mouse };
        w.hidden = true;
        w.computeSize = () => [0, -4];
        w.computeLayoutSize = () => ({ minHeight: 0, maxHeight: 0, minWidth: 0 });
        w.draw = () => {};
        w.mouse = () => {};
        w._bzHidden = true;
    } else if (!hidden && w._bzHidden) {
        w.hidden = false;
        w.computeSize = w._bzSaved.computeSize;
        w.computeLayoutSize = w._bzSaved.computeLayoutSize;
        w.draw = w._bzSaved.draw;
        w.mouse = w._bzSaved.mouse;
        w._bzHidden = false;
    }
}

// 程序化写值：widget.value 与 DOM 输入框同步，并派发原生 input 事件
// （走框架自己的 multiline 自动高度 / v2 响应式同步，不手算节点高度）
function setWidgetText(w, v) {
    if (!w) return;
    w.value = v;
    if (w.inputEl) {
        w.inputEl.value = v;
        w.inputEl.dispatchEvent(new Event("input", { bubbles: true }));
    }
}

// 旧 combo 字符串 / 杂散值 → 布尔
function normalizePinned(node) {
    const w = node._bz?.wPinned;
    if (!w) return;
    if (typeof w.value === "string") w.value = w.value === OLD_PIN_CN;
    else if (typeof w.value !== "boolean") w.value = !!w.value;
    if (w.inputEl && "checked" in w.inputEl) w.inputEl.checked = w.value;
}

// 显隐切换后重算节点尺寸
function relayout(node) {
    try {
        node.setSize?.(node.computeSize());
        node.setDirtyCanvas?.(true, true);
    } catch (e) {
        console.warn("[Banzhang][歌词输入] 重排失败:", e);
    }
}

function setPinned(node, v) {
    const w = node._bz.wPinned;
    w.value = !!v;
    if (w.inputEl && "checked" in w.inputEl) w.inputEl.checked = w.value;
    w.callback?.(w.value, null, node);
    apply(node);
}

function apply(node) {
    const st = node._bz;
    if (!st?.wText || !st.wPinned) return;
    normalizePinned(node);
    const pinned = !!st.wPinned.value;
    st.wBtn.name = pinned ? "🔓 取消固定" : "📌 固定";
    // 本节点无动态显隐控件，只重绘按钮文案；绝不主动 setSize ——
    // 否则 multiline 已被内容撑开的高度会被 computeSize 按默认行数重算，点击固定时节点突然缩小
    node.setDirtyCanvas?.(true, true);
}

/* ---------------- 注册 ---------------- */

app.registerExtension({
    name: "Banzhang.LyricsInput",
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData?.name !== NODE_NAME) return;

        const onCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            onCreated?.apply(this, arguments);
            const node = this;

            const wText = node.widgets?.find((w) => w.name === W_TEXT);
            const wPinned = node.widgets?.find((w) => w.name === "pinned");
            if (!wText || !wPinned) {
                console.warn("[Banzhang][歌词输入] 缺少后端 widget，前端增强中止");
                return;
            }
            node._bz = { wText, wPinned, incoming: null };
            normalizePinned(node);

            if (wText.inputEl) {
                wText.inputEl.placeholder = "直接编辑歌词；未固定时运行后传入文本会填到这里，点「固定」定格";
            }

            // 隐藏布尔勾选框，交互由唯一的 toggle 按钮承载
            setWidgetHidden(wPinned, true);

            const wBtn = node.addWidget("button", "📌 固定", null, () => {
                setPinned(node, !node._bz.wPinned.value);
            });
            node._bz.wBtn = wBtn;

            // 布尔值被框架 / 存档恢复改变时同步按钮文案
            const prevCb = wPinned.callback;
            wPinned.callback = function () {
                const r = prevCb ? prevCb.apply(this, arguments) : undefined;
                apply(node);
                return r;
            };

            apply(node);
            relayout(node);   // 仅初始建节点时重算一次（布尔勾选框已隐藏）；之后不再主动 setSize

            // 端口中文标签钉名（铁律第 7 节；内部 name 保持英文蛇形）
            node.inputs?.forEach((s) => { if (s.name === "text_in") s.label = "📥 传入文本"; });
            node.outputs?.forEach((s) => { if (s.name === "lyrics") s.label = "📝 歌词"; });
        };

        // 后端执行回传：未固定（跟随）时把传入文本回填进可编辑框；已固定不动框内内容
        const onExecuted = nodeType.prototype.onExecuted;
        nodeType.prototype.onExecuted = function (message) {
            onExecuted?.apply(this, arguments);
            const st = this._bz;
            if (!st) return;
            normalizePinned(this);
            if (message?.incoming_text?.length) {
                st.incoming = message.incoming_text[0];
                if (!st.wPinned.value) setWidgetText(st.wText, st.incoming);
            }
            apply(this);
        };

        // 刷新加载工作流：存档可能把 pinned 恢复成旧 combo 字符串，归一化后多轮重渲染
        const onConfigure = nodeType.prototype.configure;
        nodeType.prototype.configure = function () {
            onConfigure?.apply(this, arguments);
            const node = this;
            const redo = () => { normalizePinned(node); apply(node); };
            requestAnimationFrame(redo);
            setTimeout(redo, 60);
            setTimeout(redo, 300);
        };
    },
});
