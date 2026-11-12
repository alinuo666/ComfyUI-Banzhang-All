/**
 * 多选模式：批量勾选（Ctrl 单选 / Shift 连选）、批量删除、批量重命名、底部操作条。
 * 开关关掉后一切恢复原样（单点设输出、双击改名）。
 *
 * 用得到的抽屉字段：缓存的卡片列表、已选集合、上次多选卡片、多选模式；
 * 调用：显示匹配 / 触发刷新；注入：同步多选条 / 清空多选 / 多选点击
 */

import { 创建元素, 弹出提示 } from "./util.js";
import { 删除文件, 重命名文件 } from "./backend.js";

export function 创建多选模块(ctx) {
    const 刷新多选样式 = () => {
        ctx.缓存的卡片列表.forEach(卡 => 卡.classList.toggle("bz-picked", ctx.已选集合.has(卡)));
    };

    const 清空多选 = () => {
        ctx.已选集合.clear();
        ctx.上次多选卡片 = null;
        ctx.缓存的卡片列表.forEach(卡 => 卡.classList.remove("bz-picked"));
    };

    const 多选点击 = (卡片, 事件) => {
        const 可见卡片 = ctx.缓存的卡片列表.filter(卡 => ctx.显示匹配(卡.dataset.filename, 卡.dataset.mediaType));
        if (事件.shiftKey && ctx.上次多选卡片 && ctx.已选集合.size > 0) {
            const 起 = 可见卡片.indexOf(ctx.上次多选卡片);
            const 止 = 可见卡片.indexOf(卡片);
            if (起 !== -1 && 止 !== -1) {
                const [小, 大] = 起 < 止 ? [起, 止] : [止, 起];
                for (let 序 = 小; 序 <= 大; 序++) ctx.已选集合.add(可见卡片[序]);
                刷新多选样式();
                同步多选条();
                return;
            }
        }
        if (ctx.已选集合.has(卡片)) ctx.已选集合.delete(卡片); else ctx.已选集合.add(卡片);
        ctx.上次多选卡片 = 卡片;
        刷新多选样式();
        同步多选条();
    };

    const 批量删除 = async () => {
        const 目标 = Array.from(ctx.已选集合);
        if (!目标.length) return;
        let 成功数 = 0;
        const 失败名 = [];
        for (const 卡 of 目标) {
            const 名 = 卡.dataset.filename;
            try {
                const 结果 = await 删除文件(ctx.当前路径(), 名);
                if (结果.success) 成功数++; else 失败名.push(名);
            } catch (错误) {
                失败名.push(名);
            }
        }
        清空多选();
        if (失败名.length) 弹出提示("error", "批量删除", `${成功数} 个成功，${失败名.length} 个失败（如 ${失败名[0]}）`);
        ctx.触发刷新();
    };

    const 批量重命名提交 = async () => {
        const 前缀 = 前缀框.value.trim();
        if (!前缀) { 弹出提示("error", "批量重命名", "先填一个名称前缀"); return; }
        // 按网格当前顺序编号（过滤后的可见顺序），勾选了哪些就改哪些
        const 可见卡片 = ctx.缓存的卡片列表.filter(卡 => ctx.显示匹配(卡.dataset.filename, 卡.dataset.mediaType));
        const 目标 = 可见卡片.filter(卡 => ctx.已选集合.has(卡));
        let 序号 = Math.floor(Number(起始框.value) || 1);
        let 成功数 = 0, 失败数 = 0, 首个失败 = "";
        for (const 卡 of 目标) {
            const 原名 = 卡.dataset.filename || "";
            const 目录前缀 = 原名.includes("/") ? 原名.slice(0, 原名.lastIndexOf("/") + 1) : "";
            const 点位 = 原名.lastIndexOf(".");
            const 扩展名 = 点位 > 0 ? 原名.slice(点位) : "";
            const 新名 = `${目录前缀}${前缀}${String(序号).padStart(3, "0")}${扩展名}`;
            序号++;
            if (新名 === 原名) { 成功数++; continue; }
            try {
                const 结果 = await 重命名文件(ctx.当前路径(), 原名, 新名);
                if (结果.success) 成功数++;
                else { 失败数++; if (!首个失败) 首个失败 = 结果.msg || 新名; }
            } catch (错误) {
                失败数++;
                if (!首个失败) 首个失败 = 错误.message || String(错误);
            }
        }
        清空多选();
        if (失败数) 弹出提示("error", "批量重命名", `${成功数} 个成功，${失败数} 个失败（${首个失败}）`);
        else 弹出提示("info", "批量重命名", `已重命名 ${成功数} 个文件`);
        ctx.触发刷新();
    };

    // ---- 底部操作条：多选模式下常驻（空选时给全选入口）----
    const 多选条 = 创建元素("div", { className: "bz-multi-bar bz-off" });
    const 多选计数 = 创建元素("div", { className: "bz-multi-count", textContent: "已选 0 项" });

    const 全选钮 = 创建元素("button", { className: "bz-multi-btn", textContent: "全选" });
    全选钮.addEventListener("pointerdown", (事件) => 事件.stopPropagation());
    全选钮.addEventListener("click", (事件) => {
        事件.stopPropagation();
        ctx.缓存的卡片列表.filter(卡 => ctx.显示匹配(卡.dataset.filename, 卡.dataset.mediaType))
            .forEach(卡 => ctx.已选集合.add(卡));
        刷新多选样式();
        同步多选条();
    });

    const 取消钮 = 创建元素("button", { className: "bz-multi-btn", textContent: "取消" });
    取消钮.addEventListener("pointerdown", (事件) => 事件.stopPropagation());
    取消钮.addEventListener("click", (事件) => {
        事件.stopPropagation();
        清空多选();
        同步多选条();
    });

    const 重命名行 = 创建元素("div", { className: "bz-multi-rename bz-off" });
    const 前缀框 = 创建元素("input", { className: "bz-multi-input", type: "text", placeholder: "新名称前缀，如 镜头A_" });
    const 起始框 = 创建元素("input", { className: "bz-multi-input", type: "number", value: "1", min: "0", title: "起始编号，自动补齐三位数" });
    前缀框.addEventListener("pointerdown", (事件) => 事件.stopPropagation());
    起始框.addEventListener("pointerdown", (事件) => 事件.stopPropagation());
    const 确定钮 = 创建元素("button", { className: "bz-multi-btn", textContent: "开始" });
    确定钮.addEventListener("pointerdown", (事件) => 事件.stopPropagation());
    确定钮.addEventListener("click", (事件) => { 事件.stopPropagation(); 批量重命名提交(); });
    重命名行.append(前缀框, 起始框, 确定钮);

    const 重命名钮 = 创建元素("button", { className: "bz-multi-btn", textContent: "重命名" });
    重命名钮.addEventListener("pointerdown", (事件) => 事件.stopPropagation());
    重命名钮.addEventListener("click", (事件) => {
        事件.stopPropagation();
        if (!ctx.已选集合.size) { 弹出提示("info", "批量重命名", "先勾选要改名的文件"); return; }
        重命名行.classList.toggle("bz-off");
    });
    [前缀框, 起始框].forEach(框 => 框.addEventListener("keydown", (事件) => {
        事件.stopPropagation();
        if (事件.key === "Enter") { 事件.preventDefault(); 批量重命名提交(); }
    }));

    const 删除钮 = 创建元素("button", { className: "bz-multi-btn bz-danger", textContent: "删除" });
    删除钮.addEventListener("pointerdown", (事件) => 事件.stopPropagation());
    删除钮.addEventListener("click", (事件) => {
        事件.stopPropagation();
        批量删除();
    });

    const 多选操作区 = 创建元素("div", { className: "bz-multi-actions" });
    多选操作区.append(重命名钮, 删除钮, 全选钮, 取消钮);
    多选条.append(多选计数, 重命名行, 多选操作区);

    const 同步多选条 = () => {
        多选条.classList.toggle("bz-off", !ctx.多选模式);
        多选计数.textContent = `已选 ${ctx.已选集合.size} 项`;
        删除钮.textContent = ctx.已选集合.size ? `删除(${ctx.已选集合.size})` : "删除";
        重命名钮.textContent = ctx.已选集合.size ? `重命名(${ctx.已选集合.size})` : "重命名";
    };

    ctx.同步多选条 = 同步多选条;
    ctx.清空多选 = 清空多选;
    ctx.多选点击 = 多选点击;

    return 多选条;
}
