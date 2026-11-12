/**
 * 卡片内联播放：视频出画面、音频出声，鼠标移到卡片上就播、移开就停。
 * 播放带 160ms 防抖——快速划过一整屏卡片时不会瞬间拉起几十路流。
 *
 * 用得到的抽屉字段：缓存的卡片列表
 * 注入：开始播放 / 停止播放 / 停止全部播放 / 排期播放 / 取消排期播放
 */

export function 创建播放模块(ctx) {
    const 开始播放 = (卡片) => {
        const 播放器 = 卡片?._bz播放器;
        if (!播放器) return;
        ctx.隐藏预览();                       // 视频/音频不再弹静态预览
        卡片.classList.add("bz-playing");
        try {
            播放器.currentTime = 0;
            const 句柄 = 播放器.play();
            // 浏览器自动播放策略可能拦截（无用户手势时），失败静默，不打断操作
            if (句柄 && typeof 句柄.catch === "function") 句柄.catch(() => {});
        } catch (错误) { /* 忽略 */ }
    };

    const 停止播放 = (卡片) => {
        if (!卡片) return;
        卡片.classList.remove("bz-playing");
        const 播放器 = 卡片._bz播放器;
        if (!播放器) return;
        try { 播放器.pause(); 播放器.currentTime = 0; } catch (错误) { /* 忽略 */ }
        const 进度条 = 卡片.querySelector(".bz-progress");
        if (进度条) 进度条.style.width = "0%";
    };

    const 停止全部播放 = () => {
        ctx.取消排期播放();
        ctx.缓存的卡片列表.forEach(停止播放);
    };

    // ---- 播放防抖 ----
    // 鼠标扫过一整屏卡片时，逐个悬停会瞬间拉起几十个视频流。等 160ms 还停在卡片上才真播，
    // 快速划过就当没发生；移开或换卡片时立刻取消上一个待播。
    let 待播卡片 = null;
    let 待播定时器 = null;
    const 取消排期播放 = () => {
        if (待播定时器) { clearTimeout(待播定时器); 待播定时器 = null; }
        待播卡片 = null;
    };
    const 排期播放 = (卡片) => {
        取消排期播放();
        待播卡片 = 卡片;
        待播定时器 = setTimeout(() => {
            待播定时器 = null;
            const 目标 = 待播卡片;
            待播卡片 = null;
            if (目标) 开始播放(目标);
        }, 160);
    };

    ctx.开始播放 = 开始播放;
    ctx.停止播放 = 停止播放;
    ctx.停止全部播放 = 停止全部播放;
    ctx.排期播放 = 排期播放;
    ctx.取消排期播放 = 取消排期播放;
}
