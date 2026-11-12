/**
 * 缩略图尺寸滑条：拖动即时改列宽。
 *
 * 用得到的抽屉字段：node、尺寸控件；注入：同步滑条 / 排队重排 / 回读尺寸
 */

import { app } from "../_comfy.js";
import { 创建元素 } from "./util.js";

export function 创建尺寸滑条(ctx) {
    const { node, 尺寸控件 } = ctx;

    const 滑条行 = 创建元素("div", { className: "bz-slider-row" });
    const 滑轨 = 创建元素("div", { className: "bz-slider" });
    const 轨道 = 创建元素("div", { className: "bz-slider-track" });
    const 填充 = 创建元素("div", { className: "bz-slider-fill" });
    const 圆钮 = 创建元素("div", { className: "bz-slider-thumb" });
    const 读值 = 创建元素("div", { className: "bz-slider-value" });
    滑轨.append(轨道, 填充, 圆钮);
    滑条行.append(创建元素("div", { className: "bz-slider-label", textContent: "缩略图尺寸" }), 滑轨, 读值);

    // 拖滑条时每帧都会请求重排，这里合并成每帧最多一次
    let 待重排 = false;
    const 排队重排 = () => {
        if (待重排) return;
        待重排 = true;
        window.requestAnimationFrame(() => { 待重排 = false; ctx.重排布局(); });
    };

    const 回读尺寸 = () => Math.max(40, Number(尺寸控件?.value) || 60);
    const 滑条边界 = () => {
        const 下限 = Number(尺寸控件?.options?.min ?? 40);
        const 上限 = Number(尺寸控件?.options?.max ?? 240);
        return [下限, 上限 > 下限 ? 上限 : 下限 + 1];
    };

    function 同步滑条() {
        const [下限, 上限] = 滑条边界();
        const 值 = Math.min(上限, Math.max(下限, 回读尺寸()));
        const 比例 = (值 - 下限) / (上限 - 下限);
        填充.style.width = (比例 * 100) + "%";
        圆钮.style.left = (比例 * 100) + "%";
        读值.textContent = String(Math.round(值));
    }

    function 按位置设值(事件) {
        const 框 = 轨道.getBoundingClientRect();
        if (!框.width) return;
        const [下限, 上限] = 滑条边界();
        let 比例 = (事件.clientX - 框.left) / 框.width;
        比例 = Math.min(1, Math.max(0, 比例));
        const 新值 = 下限 + (上限 - 下限) * 比例;
        尺寸控件.value = 新值;
        尺寸控件.callback?.call(尺寸控件, 新值, app.canvas, node, app.canvas?.graph_mouse, null);
        app.graph?.incrementVersion?.();
    }

    滑条行.addEventListener("pointerdown", (事件) => 事件.stopPropagation());
    滑轨.addEventListener("pointerdown", (事件) => {
        事件.preventDefault();
        滑轨.setPointerCapture?.(事件.pointerId);
        滑轨.classList.add("bz-active");
        按位置设值(事件);
    });
    滑轨.addEventListener("pointermove", (事件) => {
        if (!滑轨.hasPointerCapture?.(事件.pointerId)) return;
        按位置设值(事件);
    });
    const 结束拖拽 = (事件) => {
        滑轨.classList.remove("bz-active");
        try { 滑轨.releasePointerCapture(事件.pointerId); } catch (忽略) {}
    };
    滑轨.addEventListener("pointerup", 结束拖拽);
    滑轨.addEventListener("pointercancel", 结束拖拽);

    // ⚠️ 必须保留 this 并转发全部参数：ComfyUI 给数值控件挂的原始回调
    // 是 onValueChange(value, canvas, node, pos, event)，内部读 this.options
    // 做取整。裸调用会让 this 变 undefined 并抛错，后面的重排就永远跑不到。
    if (尺寸控件) {
        const 原尺寸回调 = 尺寸控件.callback;
        尺寸控件.callback = function (...参数) {
            if (原尺寸回调) 原尺寸回调.apply(this, 参数);
            同步滑条();
            排队重排();
        };
        同步滑条();
    }

    ctx.同步滑条 = 同步滑条;
    ctx.排队重排 = 排队重排;
    ctx.回读尺寸 = 回读尺寸;

    return 滑条行;
}
