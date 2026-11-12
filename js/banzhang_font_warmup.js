import { app } from "../../scripts/app.js";

// ═══════════════════════════════════════════════════════════════
//  节点标题栏 UI 修复（两件事，都只影响显示，不动任何节点数据）
// ═══════════════════════════════════════════════════════════════

// ── 修复 1：移除标题栏右上角永久「菱形/问号豆腐字」装饰徽章 ──────────
// 新版前端(v2)在【每个节点】构造函数末尾硬编码 push 一个蓝色 LGraphBadge：
//   new LGraphBadge({ text:"", iconOptions:{ unicode:"\uE96E",
//   fontFamily:"PrimeIcons" }, bgColor:"#3b82f6" })
// 它是纯装饰（一个层级网络小图标，无点击、无功能）。canvas 用 PrimeIcons
// 画它，字体晚加载一步就画成 .notdef 豆腐字（白色 ◇/?），框架之后永不
// 重绘 → 永久挂在标题栏。与其和字体时序赛跑，不如直接把这个无功能徽章
// 摘掉（输出节点的绿色圆点是另一套绘制逻辑，不受影响，照常保留）。
function stripDiamondBadge(node) {
    if (!Array.isArray(node.badges)) return;
    const n0 = node.badges.length;
    node.badges = node.badges.filter((b) => {
        const io = b?.iconOptions;
        // 特征①：码位 U+E96E（pi-sitemap）的 PrimeIcons 图标；
        // 特征②：框架硬编码徽章的完整指纹（空文本 + PrimeIcons + 蓝底）。
        const isDiamond = (io?.fontFamily === "PrimeIcons") && (
            (io.unicode && io.unicode.charCodeAt(0) === 0xe96e) ||
            (b.text === "" && io.fontSize === 12 && b.bgColor === "#3b82f6")
        );
        return !isDiamond;
    });
    if (node.badges.length !== n0) app.canvas?.setDirty?.(true, true);
}

// ── 修复 2：PrimeIcons 字体预热（其余图标仍需要这套字体）────────────
function warmupFonts() {
    const repaint = () => {
        try { app.canvas?.setDirty?.(true, true); } catch (e) { /* 画布未就绪 */ }
    };
    if (document.fonts && typeof document.fonts.load === "function") {
        Promise.all([
            document.fonts.load("12px PrimeIcons"),
            document.fonts.load("14px PrimeIcons"),
            document.fonts.load("16px PrimeIcons"),
        ]).then(repaint).catch(() => {});
    }
    document.fonts?.ready?.then?.(repaint);
    window.addEventListener("load", () => setTimeout(repaint, 200));
    setTimeout(repaint, 500);
    setTimeout(repaint, 1500);
}

app.registerExtension({
    name: "banzhang.ui.titlebar-fix",
    nodeCreated(node) {
        // 注意：框架在构造函数里是「先调用 nodeCreated 钩子、后 push 徽章」，
        // 所以钩子里立刻清理会扑空，必须延迟到下一帧/稍后，幂等多跑几遍。
        // 新建节点与从存档恢复（恢复也要 new 节点）两条路径都由此覆盖。
        requestAnimationFrame(() => stripDiamondBadge(node));
        setTimeout(() => stripDiamondBadge(node), 100);
        setTimeout(() => stripDiamondBadge(node), 600);
    },
});

warmupFonts();
