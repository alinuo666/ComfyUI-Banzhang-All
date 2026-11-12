import { app } from "../../scripts/app.js";

// ═══════════════════════════════════════════════════════════
//  🎬 H3 智能成片 · 高级参数折叠
//  后端 ComfyUI 不支持参数折叠，只能走前端扩展。
//  默认只露主板（傻瓜参数），四个「高级」参数收进折叠条。
//
//  实现要点（都是踩过的坑，改前先读）：
//  1) 【最重要】DOM widget 的盒子不是我们说了算。前端 comfyui_frontend_package
//     1.52.7 的 DomWidgets.updateWidgets() 里：
//         margin = widget.margin;                 // 默认 10
//         pos    = [node.pos[0] + margin, node.pos[1] + margin + widget.y];
//         size   = [(widget.width ?? node.width) - margin * 2,
//                   (widget.computedHeight ?? 50) - margin * 2];
//     而 .dom-widget > * 的 CSS 又把子元素强设成 width:100%; height:100%。
//     → 元素实际可占盒子 = (节点宽 - 20) × (computedHeight - 20)。
//     所以：预留高度必须 = 想要的按钮高 + 20（RESERVE_H），
//           宽度直接交给 CSS 的 100%（容器正好是 节点宽-20，写死像素反而会差几 px
//           伸到框外——这里曾经用 node.size[0]-16 就宽了 4px）。
//  2) 「高级」控件用 hideAdv/showAdv 收起：改 hidden + 把 computeSize/draw/mouse
//     换成空实现。判断「是否已保存过」只能看 _boAdvSaved[name]，绝不能看 w.hidden
//     当前值——收起后 w.hidden 就不是 undefined 了，那样第二次折叠会漏保存、
//     把原生 draw 永久覆盖成空函数（控件从此画不出来）。
//  3) pointerdown 阶段就要 stopPropagation。litegraph 在 pointerdown 里开始拖动
//     节点，只拦 mousedown 会让每次点击先拖一下节点、click 变得不可靠。
//  4) 折叠态存 node.properties，随工作流一起保存。
//  5) 节点高度：#arrangeWidgets 只会在内容超高时 setSize 撑高、从不缩回，
//     所以收起后要主动贴合并减少空白（relayout(true)）。
//  6) 生命周期顺序是 createNode()→onNodeCreated()→configure()→onConfigure()：
//     onNodeCreated 时 properties 还是空的，折叠态要等 configure 之后才能确定，
//     所以状态必须能重放（_boAdvApply），不能只在 onNodeCreated 里画一次。
// ═══════════════════════════════════════════════════════════

const ADV_WIDGET_NAMES = ["低清前缀", "低清起跑比例", "低清打磨步数", "神经网络放大"];

// 改名的老工作流兼容：「细节校正」→「低清前缀」（同名同类型，只换了 name）。
// 是否需要它，取决于 ComfyUI 走哪条恢复路径：
//   · 默认是按位置恢复（Comfy.Workflow.NamedValuesRestore 默认 false）——
//     新旧名字落在完全相同的位置，对它透明，不会丢值；
//   · 但那个实验开关一旦打开（按名字恢复），旧名字就再也匹配不上新控件，
//     值会被静默丢回默认 false（false = 不重建细节）；而按位置那条分支是 else、
//     会被整体跳过，补不回来。
// 所以这里补一次名字迁移，两条路径都安全；按位置恢复时它是空操作。
const LEGACY_WIDGET_NAMES = { "细节校正": "低清前缀" };

// 按钮自身高度；DOM widget 上下各有 10px margin，故预留高度 = 按钮高 + 20
const BTN_H = 20;
const RESERVE_H = BTN_H + 20;
// 节点底部留白，别让最后一个控件贴着下边框
const BOTTOM_PAD = 8;

(function injectCss() {
    const ID = "banzhang-h3-oneshot-css";
    if (document.getElementById(ID)) return;
    const s = document.createElement("style");
    s.id = ID;
    s.textContent = `
.bo-adv-btn{display:block;box-sizing:border-box;width:100%;max-width:100%;height:100%;
  min-height:${BTN_H}px;margin:0;padding:0;cursor:pointer;overflow:hidden;
  font-size:9px;line-height:${BTN_H - 2}px;color:#8a8f99;background:rgba(255,255,255,.04);
  border:1px dashed #3a3d45;border-radius:5px;user-select:none;
  white-space:nowrap;text-overflow:ellipsis;font-family:inherit}
.bo-adv-btn:hover{color:#4a9eff;border-color:#4a9eff}
.bo-adv-btn.bo-open{color:#4a9eff;border-style:solid}
`;
    document.head.appendChild(s);
})();

function makeCollapse(node) {
    // 原始 computeSize/draw/mouse 只保存一次，且永不丢弃（见文件头第 2 条）。
    node._boAdvSaved = {};

    // 按内容高度贴合节点：展开时只增不减（不覆盖用户手动拉高的布局），
    // 收起时直接贴合，避免下面留一大块空白。
    const relayout = (shrink) => {
        let need = 0;
        try {
            need = node.computeSize?.()?.[1] || 0;
        } catch (e) {
            need = 0;
        }
        const want = need + BOTTOM_PAD;
        const target = shrink ? want : Math.max(node.size[1] || 0, want);
        // setSize 传自身 size 引用在部分实现下不会重算布局，传新数组
        node.setSize([node.size[0], target]);
        node.setDirtyCanvas(true, true);
    };

    // 隐藏所有「高级」widget（保留值与序列化）
    const hideAdv = () => {
        for (const name of ADV_WIDGET_NAMES) {
            const w = node.widgets?.find((x) => x.name === name);
            if (!w) continue;
            if (!node._boAdvSaved[name]) {
                node._boAdvSaved[name] = {
                    computeSize: w.computeSize, draw: w.draw, mouse: w.mouse,
                };
            }
            w.hidden = true;
            // [0,-4] 是 ComfyUI 隐藏 widget 的惯例值，比 [0,0] 少留一行空隙
            w.computeSize = () => [0, -4];
            w.draw = () => {};
            w.mouse = () => {};
        }
        relayout(true);
    };

    // 恢复显示（还原原 computeSize/draw/mouse）
    const showAdv = () => {
        for (const name of ADV_WIDGET_NAMES) {
            const w = node.widgets?.find((x) => x.name === name);
            if (!w) continue;
            const saved = node._boAdvSaved[name];
            w.hidden = false;
            if (saved) {
                w.computeSize = saved.computeSize;
                w.draw = saved.draw;
                w.mouse = saved.mouse;
            }
        }
        relayout(false);
    };

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "bo-adv-btn";
    btn.title = "展开/收起 低清前缀、低清起跑比例、低清打磨步数、神经网络放大";

    // 拖动 / 选中节点都在 canvas 上处理，按钮必须自己吃掉这些事件，别冒泡上去
    for (const evt of ["pointerdown", "mousedown", "mouseup", "dblclick", "contextmenu"]) {
        btn.addEventListener(evt, (e) => e.stopPropagation());
    }
    // 状态 → 界面 的唯一出口：onNodeCreated 与 onConfigure 都走这里，
    // 否则 configure 恢复了 properties 却没人重画按钮（见文件头第 6 条）。
    const apply = (open) => {
        const on = !!open;
        btn.textContent = on ? "▾ 高级参数" : "▸ 高级参数";
        btn.classList.toggle("bo-open", on);
        on ? showAdv() : hideAdv();
    };
    node._boAdvApply = apply;

    btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const open = !node.properties._boAdvOpen;
        node.properties._boAdvOpen = open;
        apply(open);
    });

    // 宽度不设像素：CSS 里 width:100%，容器正好是「节点宽 - 20」。
    // 高度预留 RESERVE_H，这样元素盒子 = RESERVE_H - 20 = BTN_H，按钮不再溢出。
    node.addDOMWidget("__高级参数折叠", "__高级参数折叠", btn, {
        serialize: false,
        getHeight: () => RESERVE_H,
        getMinHeight: () => RESERVE_H,
        getMaxHeight: () => RESERVE_H,
    });

    apply(node.properties._boAdvOpen);

    // onNodeCreated 之后 litegraph 还会调一次 configure 把工作流里存的 size 盖回来，
    // 所以下一帧再贴合一次，否则会长期停在过时的高度上。
    if (typeof requestAnimationFrame === "function") {
        requestAnimationFrame(() => relayout(!node.properties._boAdvOpen));
    }
}

// 老工作流兼容，两件事，都在 onConfigure 里做（见 LEGACY_WIDGET_NAMES 的说明）：
//  1) 旧控件名 → 新控件名：只有「按名字恢复」那条路径会丢值，所以只在确实存在名字表、
//     旧名字出现过、新名字还没出现时补写；其余情况一律不动手，避免覆盖用户当前值。
//  2) 本插件自己管理的 combo 持有「列表外的值」→ 对齐回列表第 1 项。后端 combo 校验在
//     节点函数之前跑，值一旦不在列表里，老图会直接报 value not in list、连函数都进不去，
//     所以后端兜不住，必须在这里对齐。两种来路：
//       · 旧值已被移除：「神经网络放大」历史上叫过「不使用」/「关·不用模型（省显存）」/
//         「关·纯插值（省显存）」，现在都从列表里删了；
//       · 新增控件在老图里根本没有：按位置恢复时新控件拿到 ''/undefined。
//     统一回落到列表第 1 项 —— 与后端约定一致（第 1 项 = 「不做提升」/「自动」，判定看
//     值本身，与文案无关），不写死任何字符串。
const MIGRATED_COMBOS = ["神经网络放大"];

function alignOwnCombo(node, name) {
    const w = node.widgets?.find((x) => x.name === name);
    const values = w?.options?.values;
    if (!w || !Array.isArray(values) || typeof values[0] !== "string") return;
    if (!values.includes(w.value)) w.value = values[0];
}

function migrateLegacyWidgets(node, info) {
    const named = info?.widgets_values_named;
    if (named) {
        for (const [oldName, newName] of Object.entries(LEGACY_WIDGET_NAMES)) {
            if (!(oldName in named) || newName in named) continue;
            const target = node.widgets?.find((w) => w.name === newName);
            if (target) target.value = named[oldName];
        }
    }
    for (const name of MIGRATED_COMBOS) alignOwnCombo(node, name);
}

app.registerExtension({
    name: "banzhang.h3.oneshot.advcollapse",

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== "BanZhang_MMH3_OneShot") return;

        const onCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const r = onCreated ? onCreated.apply(this, arguments) : undefined;
            // onNodeCreated 同步执行时原生 widgets 已由 INPUT_TYPES 生成，直接折叠
            if (!this.properties) this.properties = {};
            makeCollapse(this);
            return r;
        };

        // onConfigure 在 LGraphNode.configure() 恢复完控件值之后才被调用，
        // 所以这里改值一定晚于「按名字恢复」，不会被它盖回去。
        const onConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function (info) {
            const r = onConfigure ? onConfigure.apply(this, arguments) : undefined;
            migrateLegacyWidgets(this, info);
            this._boAdvApply?.(this.properties?._boAdvOpen);
            return r;
        };
    },
});
