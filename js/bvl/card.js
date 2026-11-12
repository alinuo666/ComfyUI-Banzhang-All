/**
 * 单张卡片：构造（缩略图 / 播放器 / 角标 / 删除钮 / 文件名标签）、
 * 鼠标交互（悬停预览或内联播放、点击选中、双击改名）、拖拽出画布、删除。
 *
 * 用得到的抽屉字段：文件控件、node、当前路径()、多选模式、已选集合、输入相对前缀
 * 调用：多选点击 / 更新选中状态 / 隐藏预览 / 显示预览 / 跟随预览 /
 *       停止播放 / 排期播放 / 取消排期播放 / 重排布局 / 触发刷新 / 停止全部播放（无）
 */

import { 拖出目标表, 类型角标, 类型图标, 拖拽数据类型, API_前缀 } from "./const.js";
import { 创建元素, 弹出提示, 按扩展名判类型, 媒体源地址, 缩略图地址 } from "./util.js";
import { 删除文件, 重命名文件 } from "./backend.js";

export const 删除媒体 = async (ctx, 文件名, 元素节点) => {
    const 路径 = ctx.当前路径();
    if (元素节点) {
        元素节点.style.opacity = "0.2";
        元素节点.style.pointerEvents = "none";
    }
    try {
        const 结果 = await 删除文件(路径, 文件名);
        if (结果.success) {
            if (元素节点) {
                const index = ctx.缓存的卡片列表.indexOf(元素节点);
                if (index > -1) ctx.缓存的卡片列表.splice(index, 1);
                元素节点.remove();
                if (ctx.文件控件.value === 文件名) {
                    ctx.文件控件.value = "";
                    ctx.node.setDirtyCanvas(true, true);
                }
                ctx.重排布局();
            }
        } else {
            alert("🚫 " + 结果.msg);
            if (元素节点) {
                元素节点.style.opacity = "1";
                元素节点.style.pointerEvents = "auto";
            }
        }
    } catch (err) {
        alert("🚫 错误: " + err.message);
        if (元素节点) {
            元素节点.style.opacity = "1";
            元素节点.style.pointerEvents = "auto";
        }
    }
};

// ---- 双击改名：文件名标签临时变成输入框（只改基名，目录前缀保留）----
export const 开始重命名 = (ctx, 卡片) => {
    if (卡片.classList.contains("bz-editing")) return;
    const 标签 = 卡片.querySelector(".bz-tag");
    if (!标签) return;

    const 原名 = 卡片.dataset.filename || "";
    const 目录前缀 = 原名.includes("/") ? 原名.slice(0, 原名.lastIndexOf("/") + 1) : "";
    const 原基名 = 原名.slice(目录前缀.length);

    ctx.隐藏预览();
    卡片.classList.add("bz-editing");
    卡片.draggable = false;
    标签.contentEditable = "true";
    标签.textContent = 原基名;
    标签.focus();

    try {
        const 扩展点 = 原基名.lastIndexOf(".");
        const 文本节点 = 标签.firstChild || 标签;
        const 范围 = document.createRange();
        范围.setStart(文本节点, 0);
        范围.setEnd(文本节点, 扩展点 > 0 ? 扩展点 : 原基名.length);
        const 选区 = window.getSelection();
        选区.removeAllRanges();
        选区.addRange(范围);
    } catch (忽略) {}

    let 已结束 = false;
    const 收尾 = () => {
        卡片.classList.remove("bz-editing");
        卡片.draggable = true;
        标签.contentEditable = "false";
        标签.textContent = 卡片.dataset.filename || 原名;
        标签.onkeydown = null;
        标签.onblur = null;
    };
    const 放弃 = () => {
        if (已结束) return;
        已结束 = true;
        收尾();
    };
    const 提交 = async () => {
        if (已结束) return;
        已结束 = true;
        const 新基名 = (标签.textContent || "").trim();
        const 新全名 = 目录前缀 + 新基名;
        if (!新基名 || 新全名 === 原名) { 收尾(); return; }
        try {
            const 结果 = await 重命名文件(ctx.当前路径(), 原名, 新全名);
            if (!结果.success) {
                弹出提示("error", "重命名失败", 结果.msg || "未知错误");
                收尾();
                return;
            }
            const 正式名 = 结果.filename || 新全名;
            // 顺序很关键：先改卡片上的引用，再收尾。
            // 收尾() 会按 dataset.filename 回填标签文字——以前是先收尾再改数据，
            // 标签就一直停在旧名；缩略图和播放器的 src 也还指着旧路径请求 404。
            卡片.dataset.filename = 正式名;
            卡片._bz缩略图URL = 缩略图地址(ctx.当前路径(), 正式名);
            if (卡片._bz图?.getAttribute("src")) 卡片._bz图.src = 卡片._bz缩略图URL;
            if (卡片._bz播放器) 卡片._bz播放器.src = 媒体源地址(ctx.当前路径(), 正式名);
            收尾();
            if (按扩展名判类型(正式名) !== 卡片.dataset.mediaType) {
                // 连扩展名一起换了（例如 png → mp4），整表重载，别让卡片带着错的类型继续被拖出去
                ctx.触发刷新();
                return;
            }
            if (ctx.文件控件.value === 原名) {
                ctx.文件控件.value = 正式名;
                ctx.node.setDirtyCanvas(true, true);
            }
            ctx.更新选中状态(ctx.文件控件.value);
        } catch (错误) {
            弹出提示("error", "重命名失败", 错误.message || String(错误));
            收尾();
        }
    };
    标签.onkeydown = (事件) => {
        事件.stopPropagation();
        if (事件.key === "Enter") { 事件.preventDefault(); 提交(); }
        else if (事件.key === "Escape") { 事件.preventDefault(); 放弃(); }
    };
    标签.onblur = () => 提交();
};

// 卡片交互：
//   图片 → 悬停弹放大预览浮层；视频/音频 → 悬停直接内联播放（不再弹静态预览）。
//   双击改名（文件名/类型存 dataset，改名后各处自动跟随）。
const 绑定卡片交互 = (ctx, 卡片) => {
    卡片.addEventListener("mouseenter", (事件) => {
        if (卡片.classList.contains("bz-editing")) return;
        if (卡片.dataset.mediaType === "image") {
            ctx.显示预览(卡片.dataset.filename);
            ctx.跟随预览(事件);
            return;
        }
        // 视频/音频延迟 160ms 才播：快速划过整屏卡片时不会连拉几十路流
        ctx.排期播放(卡片);
    });
    卡片.addEventListener("mousemove", (事件) => {
        if (卡片.dataset.mediaType === "image") ctx.跟随预览(事件);
    });
    卡片.addEventListener("mouseleave", () => {
        ctx.隐藏预览();
        ctx.取消排期播放();
        ctx.停止播放(卡片);
    });
    卡片.addEventListener("dblclick", (事件) => {
        事件.preventDefault();
        事件.stopPropagation();
        ctx.停止播放(卡片);
        开始重命名(ctx, 卡片);
    });
};

export function 创建卡片(ctx, 文件名, 类型, 路径) {
    const 缩略图URL = 缩略图地址(路径, 文件名);
    const 原文件URL = 媒体源地址(路径, 文件名);   // 视频/音频内联播放走原文件（需后端支持 Range）

    const 卡片 = 创建元素("div", {
        className: `bz-item bz-${类型}`,
        draggable: true,
        title: `点击选中 · 拖拽到画布可新建 ${拖出目标表[类型]?.节点 || "节点"} · 双击改名`,
        onclick: (点击事件) => {
            // 多选模式下点击 = 勾选/取消，不再改输出文件
            if (ctx.多选模式) { ctx.多选点击(卡片, 点击事件); return; }
            ctx.文件控件.value = 文件名;
            ctx.更新选中状态(文件名);
            ctx.node.setDirtyCanvas(true, true);
        }
    });
    卡片.ondragstart = (拖拽事件) => {
        ctx.隐藏预览();
        ctx.停止播放(卡片);
        拖拽事件.dataTransfer.effectAllowed = "copy";
        // 多选模式下拖任一勾选卡片 = 整批拖出；其余情况保持单文件。
        // items 里保留旧字段（folder/filename/type/rel），老接收逻辑不受影响。
        if (ctx.多选模式 && ctx.已选集合.has(卡片) && ctx.已选集合.size > 1) {
            const 条目列表 = Array.from(ctx.已选集合).map(卡 => ({
                folder: 路径,
                filename: 卡.dataset.filename || "",
                type: 卡.dataset.mediaType || "image",
                rel: ctx.输入相对前缀 === null ? null : ctx.输入相对前缀 + (卡.dataset.filename || ""),
            })).filter(项 => 项.filename);
            if (条目列表.length > 1) {
                拖拽事件.dataTransfer.setData(拖拽数据类型, JSON.stringify({
                    folder: 路径,
                    filename: 卡片.dataset.filename || 文件名,
                    type: 类型,
                    items: 条目列表,
                }));
                return;
            }
        }
        拖拽事件.dataTransfer.setData(拖拽数据类型, JSON.stringify({
            folder: 路径,
            filename: 卡片.dataset.filename || 文件名,
            type: 类型,
            // 文件在 input 目录内时带相对路径，接收方直接引用、不再重传字节
            rel: ctx.输入相对前缀 === null ? null : ctx.输入相对前缀 + (卡片.dataset.filename || 文件名)
        }));
    };

    const 删除按钮 = 创建元素("button", { className: "bz-del-btn", textContent: "×" });
    删除按钮.onpointerdown = (e) => e.stopPropagation();
    删除按钮.onmousedown = (e) => e.stopPropagation();
    删除按钮.onclick = (e) => {
        e.preventDefault(); e.stopPropagation();
        // ⚡ 直接删除，无弹窗
        ctx.停止播放(卡片);
        删除媒体(ctx, 卡片.dataset.filename || 文件名, 卡片);
    };

    // 缩略图生成失败（缺 ffmpeg / 文件损坏）时退化成类型图标，不留破图
    // src 先不给：由 挂载懒加载 在卡片滚进视口时才赋，避免几百个请求同时打出去
    const img = 创建元素("img", {
        loading: "lazy", draggable: false,
        onload: (e) => e.target.classList.add("loaded"),
        onerror: () => 卡片.classList.add("bz-noThumb")
    });
    卡片._bz图 = img;
    卡片._bz缩略图URL = 缩略图URL;

    卡片.appendChild(img);

    // 视频/音频：卡片自带内联播放器（preload=none，悬停才拉流播放）+ 底部进度条
    if (类型 === "video" || 类型 === "audio") {
        const 播放器 = 类型 === "video"
            ? 创建元素("video", { className: "bz-playback", loop: true, playsInline: true, preload: "none", draggable: false })
            : 创建元素("audio", { preload: "none" });
        播放器.src = 原文件URL;
        if (类型 === "audio") 播放器.style.display = "none";
        卡片._bz播放器 = 播放器;
        卡片.appendChild(播放器);

        const 进度条 = 创建元素("div", { className: "bz-progress" });
        播放器.addEventListener("timeupdate", () => {
            const 总长 = 播放器.duration;
            if (!总长 || !isFinite(总长)) return;
            进度条.style.width = ((播放器.currentTime / 总长) * 100).toFixed(2) + "%";
        });
        播放器.addEventListener("ended", () => { 进度条.style.width = "0%"; });
        // 播放失败 → 能播的永远走原文件；只有浏览器解不动（H.265/mkv/avi…）
        // 才切到后端悬停转码副本（/play_video，后端缓存复用）。转码版也失败才报不支持。
        播放器.addEventListener("error", () => {
            if (类型 !== "video") { 卡片.classList.add("bz-noPlay"); return; }
            if (卡片._bz已转码) {
                卡片.classList.remove("bz-transcoding");
                卡片.classList.add("bz-noPlay");
                return;
            }
            卡片._bz已转码 = true;
            卡片.classList.remove("bz-noPlay");
            卡片.classList.add("bz-transcoding");
            播放器.src = `${API_前缀}/play_video?folder_path=${encodeURIComponent(ctx.当前路径())}&filename=${encodeURIComponent(卡片.dataset.filename || 文件名)}`;
            const 句柄 = 播放器.play();
            if (句柄 && typeof 句柄.catch === "function") 句柄.catch(() => {});
        });
        // 转码完成开播 → 撤掉「转码中」提示
        播放器.addEventListener("playing", () => {
            卡片.classList.remove("bz-transcoding");
            卡片.classList.remove("bz-noPlay");
        });
        卡片.appendChild(进度条);
    }

    if (类型 !== "image") {
        卡片.appendChild(创建元素("div", { className: "bz-badge", textContent: 类型角标[类型] || "" }));
    }
    卡片.appendChild(创建元素("div", { className: "bz-icon", textContent: 类型图标[类型] || "📄" }));
    卡片.appendChild(删除按钮);
    卡片.appendChild(创建元素("div", { className: "bz-tag", textContent: 文件名 }));

    卡片.dataset.filename = 文件名;
    卡片.dataset.mediaType = 类型;
    绑定卡片交互(ctx, 卡片);

    return 卡片;
}
