/**
 * 悬停放大预览：光标旁浮层显示原文件大图，自动避让窗口边缘。
 * 视频/音频卡片不弹预览（它们改为内联播放）。
 *
 * 用得到的抽屉字段：当前路径()、容器、文件控件（无用）、node（无用）
 * 注入：隐藏预览 / 显示预览 / 跟随预览
 */

import { API_前缀 } from "./const.js";
import { 创建元素 } from "./util.js";

export function 创建悬停预览(ctx) {
    const 预览浮层 = 创建元素("div", { className: "bz-zoom" });
    const 预览图 = 创建元素("img", { draggable: false });
    预览浮层.appendChild(预览图);
    document.body.appendChild(预览浮层);

    // 浮层尺寸只在弹出时和图片加载完成时量一次：跟随光标时每帧读 offsetWidth
    // 会触发强制同步布局，鼠标一动就掉帧。
    let 预览宽 = 268, 预览高 = 268;
    const 量预览尺寸 = () => {
        预览宽 = 预览浮层.offsetWidth || 268;
        预览高 = 预览浮层.offsetHeight || 268;
    };

    const 隐藏预览 = () => 预览浮层.classList.remove("bz-show");
    const 显示预览 = (文件名) => {
        if (!文件名) return;
        预览图.src = `${API_前缀}/view_image?folder_path=${encodeURIComponent(ctx.当前路径())}&filename=${encodeURIComponent(文件名)}`;
        预览浮层.classList.add("bz-show");
        量预览尺寸();
    };
    预览图.addEventListener("load", 量预览尺寸);

    // 跟随光标：mousemove 一秒能触发上百次，改成每帧最多搬一次浮层
    let 待更新点 = null;
    let 预览已排队 = false;
    const 跟随预览 = (事件) => {
        if (!预览浮层.classList.contains("bz-show")) return;
        待更新点 = { x: 事件.clientX, y: 事件.clientY };
        if (预览已排队) return;
        预览已排队 = true;
        window.requestAnimationFrame(() => {
            预览已排队 = false;
            const 点 = 待更新点;
            if (!点) return;
            let x = 点.x + 18;
            let y = 点.y + 18;
            if (x + 预览宽 > window.innerWidth - 8) x = 点.x - 预览宽 - 18;
            if (y + 预览高 > window.innerHeight - 8) y = Math.max(8, window.innerHeight - 预览高 - 8);
            预览浮层.style.left = Math.max(8, x) + "px";
            预览浮层.style.top = Math.max(8, y) + "px";
        });
    };
    ctx.容器.addEventListener("mouseleave", 隐藏预览);
    ctx.容器.addEventListener("scroll", 隐藏预览, { passive: true });

    ctx.隐藏预览 = 隐藏预览;
    ctx.显示预览 = 显示预览;
    ctx.跟随预览 = 跟随预览;

    return 预览浮层;
}
