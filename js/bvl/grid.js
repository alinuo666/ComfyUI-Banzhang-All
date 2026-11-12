/**
 * 网格布局：算列数、把卡片摆进列容器、缩略图按屏懒加载。
 * 核心性能点：列数与可见集合都没变时零 DOM 操作（拖尺寸滑条时每帧都会请求重排）。
 *
 * 用得到的抽屉字段：容器、提示层、缓存的卡片列表、当前列数、缓存列表已失效、
 *                   类型筛选、过滤关键字、计数、缩略图观察器；调用：回读尺寸
 * 注入：显示匹配 / 重排布局 / 请求重排 / 挂载懒加载
 */

import { 创建元素 } from "./util.js";

export function 创建网格模块(ctx) {
    // 类型筛选与关键词过滤叠加：两个条件都过才摆进网格
    const 显示匹配 = (文件名, 媒体类型) => {
        if (ctx.类型筛选 !== "all" && 媒体类型 !== ctx.类型筛选) return false;
        return !ctx.过滤关键字 || (文件名 || "").toLowerCase().includes(ctx.过滤关键字);
    };

    // ---- 缩略图按屏加载 ----
    // 目录里几百个文件时，一次性把所有 img.src 打出去 = 几百个并发请求 + 后端几百次 ffmpeg，
    // 而首屏根本看不到那么远。改成「卡片滚进视口才赋 src」，滚到哪加载哪。
    const 首屏保底张数 = 30;

    const 加载卡片缩略图 = (卡片) => {
        const img = 卡片._bz图;
        if (!img || img.getAttribute("src")) return;
        img.src = 卡片._bz缩略图URL;
    };

    const 挂载懒加载 = (卡片列表) => {
        if (ctx.缩略图观察器) { ctx.缩略图观察器.disconnect(); ctx.缩略图观察器 = null; }
        // 前 30 张直接发，保证任何环境下首屏都不空
        卡片列表.slice(0, 首屏保底张数).forEach(加载卡片缩略图);
        if (typeof IntersectionObserver === "undefined") { 卡片列表.forEach(加载卡片缩略图); return; }
        ctx.缩略图观察器 = new IntersectionObserver((条目列表, 观察器) => {
            条目列表.forEach(条目 => {
                if (!条目.isIntersecting) return;
                观察器.unobserve(条目.target);
                加载卡片缩略图(条目.target);
            });
        }, { root: ctx.容器, rootMargin: "320px 0px" });
        卡片列表.forEach(卡片 => ctx.缩略图观察器.observe(卡片));
    };

    // 列容器复用：重排不再每次销毁重建，也不再无条件搬运全部卡片
    let 列数组 = [];
    let 上次列数 = -1;
    let 上次可见 = [];
    const 清空容器 = () => {
        Array.from(ctx.容器.children).forEach(c => { if (c !== ctx.提示层) c.remove(); });
    };

    const 重排布局 = () => {
        let 容器宽度 = ctx.容器.clientWidth;
        if (容器宽度 < 50) 容器宽度 = 300;

        const 列宽 = ctx.回读尺寸();
        let 目标列数 = Math.floor(容器宽度 / 列宽);

        if (目标列数 < 1) 目标列数 = 1;
        if (目标列数 > 16) 目标列数 = 16;

        ctx.当前列数 = 目标列数;

        // 列表正在重建（卡片已摘、新卡片未挂）：此时重排会把上一次的列容器整个换掉，
        // 之后新卡片再按旧的 列数组 引用挂进去就成了游离节点。等重建完再统一重排。
        if (ctx.缓存列表已失效) return;

        // 过滤只影响摆放，不动数据：不匹配的卡片留在 缓存的卡片列表 里
        const 可见卡片 = ctx.缓存的卡片列表.filter(卡片 => 显示匹配(卡片.dataset.filename, 卡片.dataset.mediaType));
        ctx.计数.textContent = 可见卡片.length === ctx.缓存的卡片列表.length
            ? `${ctx.缓存的卡片列表.length}`
            : `${可见卡片.length}/${ctx.缓存的卡片列表.length}`;

        // 列数和可见集合都没变 → 一个 DOM 操作都不做。
        // 拖尺寸滑条时 重排布局 每帧都会被调用，而列数往往几十帧才变一次，
        // 以前每帧都要把上百张卡片全摘下来再挂回去，这就是拖动卡顿的来源。
        // 签名只用「列数 + 名称列表的长度 + 逐项比对」，不拼分隔符：
        // 文件名里可能带任意字符，拼串容易撞车，也比逐项比对慢。
        let 需要摆放 = 目标列数 !== 上次列数
            || 可见卡片.length !== 上次可见.length
            || !列数组[0]?.isConnected;
        if (!需要摆放) {
            for (let i = 0; i < 可见卡片.length; i++) {
                if (可见卡片[i] !== 上次可见[i]) { 需要摆放 = true; break; }
            }
        }
        上次列数 = 目标列数;
        上次可见 = 可见卡片;

        if (ctx.缓存的卡片列表.length > 0 && 可见卡片.length === 0) {
            清空容器();
            列数组 = [];
            ctx.容器.appendChild(创建元素("div", { className: "bz-msg", textContent: "🔍 没有符合条件的文件" }));
            return;
        }
        if (!需要摆放) return;

        if (列数组.length !== 目标列数 || !列数组.every(列 => 列.isConnected)) {
            清空容器();
            列数组 = [];
            for (let i = 0; i < 目标列数; i++) {
                const 列 = 创建元素("div", { className: "bz-column" });
                列数组.push(列);
                ctx.容器.appendChild(列);
            }
        } else {
            列数组.forEach(列 => { 列.textContent = ""; });
        }

        可见卡片.forEach((卡片, 索引) => {
            列数组[索引 % 目标列数].appendChild(卡片);
        });
    };

    // 列表重建完成后补一次重排（重建期间 重排布局 会被 缓存列表已失效 挡掉）
    const 请求重排 = () => {
        if (ctx.缓存列表已失效) return;
        重排布局();
    };

    const resizeObserver = new ResizeObserver(() => window.requestAnimationFrame(重排布局));
    resizeObserver.observe(ctx.容器);

    ctx.显示匹配 = 显示匹配;
    ctx.重排布局 = 重排布局;
    ctx.请求重排 = 请求重排;
    ctx.挂载懒加载 = 挂载懒加载;
}
