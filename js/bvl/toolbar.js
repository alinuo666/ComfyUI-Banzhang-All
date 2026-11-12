/**
 * 工具行：文件名过滤框 / 路径历史 / 去重按钮 / 多选开关 / 手动刷新。
 *
 * 用得到的抽屉字段：文件夹控件、过滤关键字、多选模式；
 * 调用：加载媒体列表 / 重排布局 / 打开去重 / 清空多选 / 同步多选条；
 * 注入：记住路径（列表加载成功后记一条历史）
 */

import { 创建元素, 弹出提示 } from "./util.js";

const 历史键 = "bz_visual_loader_paths";

export function 创建工具行(ctx) {
    const { 文件夹控件 } = ctx;

    const 读取历史 = () => {
        try {
            const 原始 = JSON.parse(localStorage.getItem(历史键) || "[]");
            return Array.isArray(原始) ? 原始.filter(p => typeof p === "string") : [];
        } catch (错误) {
            return [];
        }
    };
    const 记住路径 = (路径) => {
        if (!路径) return;
        const 列表 = 读取历史().filter(p => p !== 路径);
        列表.unshift(路径);
        try { localStorage.setItem(历史键, JSON.stringify(列表.slice(0, 8))); } catch (错误) {}
    };

    const 工具行 = 创建元素("div", { className: "bz-tools-row" });

    // ---- 过滤框：按文件名子串过滤（忽略大小写），只影响摆放不动数据 ----
    const 搜索框 = 创建元素("input", { className: "bz-search", type: "text", placeholder: "🔍 过滤文件名" });
    搜索框.addEventListener("pointerdown", (事件) => 事件.stopPropagation());
    搜索框.addEventListener("keydown", (事件) => {
        事件.stopPropagation();
        if (事件.key === "Escape") {
            搜索框.value = "";
            ctx.过滤关键字 = "";
            ctx.重排布局();
        }
    });
    搜索框.addEventListener("input", () => {
        ctx.过滤关键字 = 搜索框.value.trim().toLowerCase();
        ctx.重排布局();
    });

    // ---- 路径历史：localStorage 记最近 8 个文件夹，一键回填并刷新，可清空 ----
    const 历史钮 = 创建元素("button", { className: "bz-hist-btn", textContent: "🕘" });
    let 历史面板 = null;
    const 关闭历史 = () => {
        if (历史面板) { 历史面板.remove(); 历史面板 = null; }
    };
    const 打开历史 = () => {
        关闭历史();
        const 列表 = 读取历史();
        if (列表.length === 0) {
            弹出提示("info", "还没有历史记录", "浏览过的文件夹会自动记下来");
            return;
        }
        const 面板 = 创建元素("div", { className: "bz-hist-panel" });
        const 框 = 历史钮.getBoundingClientRect();
        面板.style.left = Math.max(4, 框.left) + "px";
        面板.style.top = (框.bottom + 4) + "px";
        列表.forEach(路径 => {
            const 项 = 创建元素("div", { className: "bz-hist-item", textContent: 路径, title: 路径 });
            项.addEventListener("click", () => {
                文件夹控件.value = 路径;
                关闭历史();
                ctx.加载媒体列表();
            });
            面板.appendChild(项);
        });
        const 清空 = 创建元素("div", { className: "bz-hist-item bz-hist-clear", textContent: "🗑️ 清空历史" });
        清空.addEventListener("click", () => {
            try { localStorage.removeItem(历史键); } catch (错误) {}
            关闭历史();
        });
        面板.appendChild(清空);
        document.body.appendChild(面板);
        历史面板 = 面板;
    };
    历史钮.addEventListener("pointerdown", (事件) => 事件.stopPropagation());
    历史钮.addEventListener("click", (事件) => {
        事件.stopPropagation();
        if (历史面板) 关闭历史(); else 打开历史();
    });
    document.addEventListener("click", 关闭历史);

    // ---- 去重按钮：查找并合并内容重复的文件 ----
    const 去重钮 = 创建元素("button", { className: "bz-hist-btn", textContent: "🧹", title: "查找并合并内容重复的文件" });
    去重钮.addEventListener("pointerdown", (事件) => 事件.stopPropagation());
    去重钮.addEventListener("click", (事件) => {
        事件.stopPropagation();
        ctx.打开去重();
    });

    // ---- 多选开关：开着时点击 = 勾选/取消，拖动任一勾选卡片 = 整批拖出 ----
    const 多选钮 = 创建元素("button", { className: "bz-chip", textContent: "☑ 多选", title: "批量选择：勾选后可批量删除 / 重命名 / 整批拖出画布" });
    多选钮.addEventListener("pointerdown", (事件) => 事件.stopPropagation());
    多选钮.addEventListener("click", (事件) => {
        事件.stopPropagation();
        ctx.多选模式 = !ctx.多选模式;
        多选钮.classList.toggle("bz-on", ctx.多选模式);
        if (!ctx.多选模式) ctx.清空多选();
        ctx.同步多选条();
    });

    // ---- 手动刷新：外部程序直接拷进目录的文件，点一下才看得见 ----
    const 刷新钮 = 创建元素("button", { className: "bz-hist-btn", textContent: "🔄", title: "重新扫描当前文件夹（外部新增的文件点这里刷新）" });
    刷新钮.addEventListener("pointerdown", (事件) => 事件.stopPropagation());
    刷新钮.addEventListener("click", (事件) => {
        事件.stopPropagation();
        ctx.加载媒体列表();
    });

    工具行.append(搜索框, 历史钮, 去重钮, 多选钮, 刷新钮);

    ctx.记住路径 = 记住路径;

    return 工具行;
}
