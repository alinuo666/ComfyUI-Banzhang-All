/**
 * 筛选行：媒体类型单选（全部 / 图片 / 视频 / 音频）+ 命中计数 + 含子目录开关。
 *
 * 用得到的抽屉字段：类型筛选、子目录控件；调用：重排布局 / 触发刷新；
 * 注入：同步递归钮；供网格写入：计数
 */

import { 创建元素 } from "./util.js";

const 类型选项 = [["all", "全部"], ["image", "🖼️"], ["video", "▶️"], ["audio", "♪"]];
const 类型说明 = { all: "显示全部媒体", image: "只看图片", video: "只看视频", audio: "只看音频" };

export function 创建筛选行(ctx) {
    const 筛选行 = 创建元素("div", { className: "bz-filter-row" });
    const 类型钮组 = 创建元素("div", { className: "bz-chip-group" });
    const 类型钮表 = {};
    类型选项.forEach(([键, 文案]) => {
        const 钮 = 创建元素("button", { className: "bz-chip bz-mini", textContent: 文案, title: 类型说明[键] });
        钮.addEventListener("pointerdown", (事件) => 事件.stopPropagation());
        钮.addEventListener("click", () => {
            ctx.类型筛选 = 键;
            同步类型钮();
            ctx.重排布局();
        });
        类型钮表[键] = 钮;
        类型钮组.appendChild(钮);
    });
    const 同步类型钮 = () => {
        Object.entries(类型钮表).forEach(([键, 钮]) => 钮.classList.toggle("bz-on", 键 === ctx.类型筛选));
    };

    const 计数 = 创建元素("div", { className: "bz-count" });

    const 递归钮 = 创建元素("button", { className: "bz-chip", textContent: "含子目录" });
    const 同步递归钮 = () => 递归钮.classList.toggle("bz-on", !!ctx.子目录控件?.value);
    递归钮.addEventListener("pointerdown", (事件) => 事件.stopPropagation());
    递归钮.addEventListener("click", () => {
        if (!ctx.子目录控件) return;
        ctx.子目录控件.value = !ctx.子目录控件.value;
        同步递归钮();
        ctx.触发刷新();
    });

    筛选行.append(类型钮组, 计数, 递归钮);
    同步类型钮();
    同步递归钮();

    ctx.计数 = 计数;
    ctx.同步递归钮 = 同步递归钮;

    return 筛选行;
}
