/**
 * 列表加载：向后端要目录内容 → 建卡片 → 摆进网格 → 同步选中高亮；外加刷新防抖。
 * 并发安全靠「刷新令牌」：期间又刷新过一次，旧请求的结果直接作废（否则会出现重影卡片）。
 *
 * 用得到的抽屉字段：当前路径()、排序控件、子目录控件、文件控件、容器、提示层、
 *                   缓存的卡片列表、刷新令牌、缓存列表已失效、输入相对前缀、缩略图观察器、防抖定时器
 * 调用：停止全部播放 / 取消排期播放 / 清空多选 / 同步多选条 / 隐藏预览 /
 *       重排布局 / 挂载懒加载 / 请求重排 / 记住路径
 * 注入：加载媒体列表 / 触发刷新 / 更新选中状态
 */

import { 创建元素 } from "./util.js";
import { 列媒体 } from "./backend.js";
import { 创建卡片 } from "./card.js";

export function 创建列表模块(ctx) {
    const 更新选中状态 = (选中文件名) => {
        ctx.缓存的卡片列表.forEach(卡片 => {
            卡片.classList.toggle("selected", (卡片.dataset.filename || "") === 选中文件名);
        });
    };

    const 加载媒体列表 = async () => {
        const 路径 = ctx.当前路径();
        const 排序 = ctx.排序控件.value;

        // 清场：掐掉正在播的媒体 + 撤掉待播的排期 + 关掉懒加载观察器 + 清空多选，
        // 全部放在第一个 await 之前。否则并发的两次刷新会互相踩：
        // 后一次清空 缓存的卡片列表 后，前一次 await 回来还会往里面塞旧卡片。
        ctx.停止全部播放();
        ctx.取消排期播放();
        ctx.清空多选();
        ctx.同步多选条();
        ctx.缓存列表已失效 = true;
        if (ctx.缩略图观察器) { ctx.缩略图观察器.disconnect(); ctx.缩略图观察器 = null; }
        ctx.缓存的卡片列表 = [];
        ctx.隐藏预览();

        const 本次令牌 = ++ctx.刷新令牌;

        const 提示文本 = 创建元素("div", { className: "bz-msg", textContent: "🚀 加载中..." });
        Array.from(ctx.容器.children).forEach(c => {
            if (c !== ctx.提示层) c.remove();
        });
        ctx.容器.appendChild(提示文本);

        try {
            const 响应 = await 列媒体(路径, 排序, !!ctx.子目录控件?.value);
            if (本次令牌 !== ctx.刷新令牌) return;    // 期间又刷新过一次，这次结果作废
            const 引用前缀头 = 响应.headers.get("X-Input-Rel");
            ctx.输入相对前缀 = 引用前缀头 === null ? null : decodeURIComponent(引用前缀头);
            const 媒体数据 = await 响应.json();
            if (本次令牌 !== ctx.刷新令牌) return;
            if (媒体数据.error) {
                提示文本.textContent = `❌ ${媒体数据.msg}`;
                提示文本.style.color = "red";
                return;
            }
            const 条目列表 = Object.entries(媒体数据);
            if (条目列表.length === 0) {
                提示文本.textContent = "📭 空文件夹（没有图片 / 视频 / 音频）";
                提示文本.style.color = "";
                return;
            }
            ctx.记住路径(路径);
            提示文本.remove();
            ctx.缓存列表已失效 = false;

            条目列表.forEach(([文件名, 媒体类型]) => {
                const 类型 = 媒体类型 || "image";
                const 卡片 = 创建卡片(ctx, 文件名, 类型, 路径);
                ctx.缓存的卡片列表.push(卡片);
            });
            ctx.重排布局();
            ctx.挂载懒加载(ctx.缓存的卡片列表);
            更新选中状态(ctx.文件控件.value);
            ctx.请求重排();            // 期间可能被 缓存列表已失效 挡掉过重排，重建完成后补一次
        } catch (错误) {
            if (本次令牌 !== ctx.刷新令牌) return;
            console.error(错误);
            提示文本.textContent = "❌ 读取失败";
            提示文本.style.color = "red";
        }
    };

    const 触发刷新 = () => {
        if (ctx.防抖定时器) clearTimeout(ctx.防抖定时器);
        ctx.防抖定时器 = setTimeout(加载媒体列表, 300);
    };

    ctx.加载媒体列表 = 加载媒体列表;
    ctx.触发刷新 = 触发刷新;
    ctx.更新选中状态 = 更新选中状态;
}
