/**
 * 入口：注册扩展 + 把各个功能块装成一个完整面板。
 *
 * 装配顺序有讲究（后装的会用到先装注入到抽屉里的函数）：
 *   滑条 → 工具行 → 筛选行 → 去重 → 多选 → 悬停预览 → 播放 → 挂载 DOM → 网格 → 列表
 *
 * 想改某个功能，直接去对应文件；这个文件只在「加/减一个功能块」时才需要动。
 */

import { app } from "../_comfy.js";
import { 目标节点名称 } from "./const.js";
import { 注入样式 } from "./style.js";
import { 绑定拖出落点 } from "./drop.js";
import { 创建上下文 } from "./context.js";
import { 创建尺寸滑条 } from "./slider.js";
import { 创建工具行 } from "./toolbar.js";
import { 创建筛选行 } from "./filterbar.js";
import { 创建去重面板 } from "./dedupe.js";
import { 创建多选模块 } from "./multi.js";
import { 创建悬停预览 } from "./hover.js";
import { 创建播放模块 } from "./playback.js";
import { 创建网格模块 } from "./grid.js";
import { 创建列表模块 } from "./list.js";
import { 创建元素, 按扩展名判类型, 是班长拖拽 } from "./util.js";
import { 上传文件 } from "./backend.js";

app.registerExtension({
    name: "Banzhang.VisualLoader",

    async init() {
        注入样式();
        绑定拖出落点();
    },

    async nodeCreated(node) {
        if (node.comfyClass !== 目标节点名称) return;

        const 文件夹控件 = node.widgets.find(w => w.name === "📂 文件夹路径");
        const 文件控件 = node.widgets.find(w => w.name === "📄 指定文件");
        const 排序控件 = node.widgets.find(w => w.name === "🔃 排序方式");
        const 尺寸控件 = node.widgets.find(w => w.name === "🔍 缩略图尺寸");
        const 子目录控件 = node.widgets.find(w => w.name === "📁 含子目录");

        node.setSize([340, 500]);

        const 容器 = 创建元素("div", { className: "bz-grid-container" });
        const 提示层 = 创建元素("div", { className: "bz-drag-tip", textContent: "📂 松手上传" });
        容器.appendChild(提示层);

        容器.addEventListener("wheel", (e) => e.stopPropagation(), { passive: false });
        容器.addEventListener("pointerdown", (e) => e.stopPropagation(), { passive: false });

        容器.addEventListener("dragover", (e) => { if (是班长拖拽(e)) return; e.preventDefault(); e.stopPropagation(); 容器.classList.add("bz-drag-over"); });
        容器.addEventListener("dragleave", (e) => { if (是班长拖拽(e)) return; e.preventDefault(); e.stopPropagation(); 容器.classList.remove("bz-drag-over"); });
        容器.addEventListener("drop", async (e) => {
            if (是班长拖拽(e)) return;
            e.preventDefault(); e.stopPropagation(); 容器.classList.remove("bz-drag-over");
            if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
                const 文件 = e.dataTransfer.files[0];
                // 类型以扩展名为准（某些视频/音频拖进来时浏览器给的 MIME 为空，
                // 单看 文件.type 会误拦）；三类都放行，交给上传接口按扩展名落盘。
                const 类型 = 按扩展名判类型(文件.name);
                if (类型 !== "image" && 类型 !== "video" && 类型 !== "audio") {
                    alert("🚫 不支持的文件类型！");
                    return;
                }
                await 执行上传(文件);
            }
        });

        async function 执行上传(文件对象) {
            const 提示 = document.createElement("div");
            提示.className = "bz-msg";
            提示.textContent = "🚀 上传中...";
            容器.prepend(提示);

            try {
                const 结果 = await 上传文件(ctx.当前路径(), 文件对象);
                if (结果.success) {
                    文件控件.value = 结果.filename;
                    ctx.加载媒体列表();
                    node.setDirtyCanvas(true, true);
                } else {
                    alert("❌ " + 结果.msg);
                    提示.remove();
                }
            } catch (err) {
                alert("❌ 上传失败: " + err.message);
                提示.remove();
            }
        }

        // 隐藏 litegraph 原生控件（canvas 画的，样式不可控），改用下面的自绘 DOM 控件。
        // 这个前端版本的可见性判据是 widget.hidden（见 isWidgetVisible），
        // 旧的 computeSize 归零法对它是无效的。
        if (尺寸控件) 尺寸控件.hidden = true;
        if (子目录控件) 子目录控件.hidden = true;

        // ---- 共享抽屉：所有功能块都从这里取状态、互相调用 ----
        const ctx = 创建上下文({ node, 文件夹控件, 文件控件, 排序控件, 尺寸控件, 子目录控件, 容器, 提示层 });

        const 滑条行 = 创建尺寸滑条(ctx);
        const 工具行 = 创建工具行(ctx);
        const 筛选行 = 创建筛选行(ctx);
        创建去重面板(ctx);
        const 多选条 = 创建多选模块(ctx);
        const 预览浮层 = 创建悬停预览(ctx);
        创建播放模块(ctx);

        const 外层 = 创建元素("div", { className: "bz-wrap" });
        外层.append(滑条行, 工具行, 筛选行, 容器);
        // 多选操作条浮在面板底部；wrap 需要有定位上下文才能 absolute 贴底
        外层.style.position = "relative";
        外层.appendChild(多选条);

        const 原onRemoved = node.onRemoved;
        node.onRemoved = function (...参数) {
            ctx.隐藏预览();
            ctx.停止全部播放();
            try { 预览浮层.remove(); } catch (错误) {}
            try { ctx.缩略图观察器?.disconnect(); } catch (错误) {}
            try { ctx.关闭去重(); } catch (错误) {}
            return 原onRemoved?.apply(this, 参数);
        };

        const domWidget = node.addDOMWidget("preview_grid", "div", 外层, {
            serialize: false,
            hideOnZoom: false
        });

        // ---- 尺寸：完全交给前端布局，元素不再自算 ----
        // 前端把 DOM widget 包进一个 fixed 定位的包裹层，并按布局给它分配 w/h；
        // 元素只需撑满（.bz-wrap 的 width/height:100%）。
        // 旧写法用「节点高 - 预留高度」自算 px，而「预留高度」量的是下面几行自绘控件，
        // 与前端分配值天然对不上 → 一旦算大就把底部格子顶出节点框。
        // 这里显式声明：最小高度报小值、上限不封顶，保证拿到全部剩余空间。
        if (domWidget) {
            domWidget.computeLayoutSize = () => ({ minHeight: 120, maxHeight: undefined, minWidth: 0 });
        }

        node.onResize = function () {
            // 尺寸变化后仅需重排网格与同步滑条，高度不再由我们决定
            ctx.重排布局();
            ctx.同步滑条();
        };

        setTimeout(() => { if (node.onResize) node.onResize(node.size); }, 100);

        创建网格模块(ctx);
        创建列表模块(ctx);

        const 原文件夹回调 = 文件夹控件.callback;
        文件夹控件.callback = function (...参数) {
            const 结果 = 原文件夹回调?.apply(this, 参数);
            ctx.触发刷新();
            return 结果;
        };

        const 原排序回调 = 排序控件.callback;
        排序控件.callback = function (...参数) {
            const 结果 = 原排序回调?.apply(this, 参数);
            ctx.触发刷新();
            return 结果;
        };

        if (子目录控件) {
            const 原子目录回调 = 子目录控件.callback;
            子目录控件.callback = function (...参数) {
                const 结果 = 原子目录回调?.apply(this, 参数);
                ctx.同步递归钮();
                return 结果;
            };
        }

        // 外部改值（拖拽投放 / 下拉选择 / 撤销）时同步高亮：
        // setValue 与 callback 两条路都堵上，避免只有单侧更新。
        const 原图像回调 = 文件控件.callback;
        文件控件.callback = function (...参数) {
            const 结果 = 原图像回调?.apply(this, 参数);
            ctx.更新选中状态(文件控件.value);
            return 结果;
        };
        if (typeof 文件控件.setValue === "function") {
            const 原图像setValue = 文件控件.setValue;
            文件控件.setValue = function (...参数) {
                const 结果 = 原图像setValue.apply(this, 参数);
                ctx.更新选中状态(文件控件.value);
                return 结果;
            };
        }

        // 读档 / 外部改值时把自绘控件的位置同步过来（onConfigure 不在 onResize 路径上）
        const 原onConfigure = node.onConfigure;
        node.onConfigure = function (...参数) {
            const 结果 = 原onConfigure?.apply(this, 参数);
            ctx.同步滑条();
            ctx.同步递归钮();
            ctx.更新选中状态(文件控件.value);
            return 结果;
        };

        // 供同包的拖拽投放逻辑回写：外部改值后同步高亮 / 换目录时整表重载
        node.bz同步选中 = ctx.更新选中状态;
        node.bz刷新列表 = ctx.加载媒体列表;

        setTimeout(ctx.加载媒体列表, 500);
    }
});
