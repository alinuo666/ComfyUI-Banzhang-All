/**
 * 拖到画布：把面板里的卡片拖出去那一整套——
 * 落在输入口上连线 / 落在加载节点上改值 / 落在空白处新建节点 / 落在别的面板上转成真文件投放。
 *
 * 用得到的抽屉字段：无（这是全局一次性绑定，不依赖某个节点实例）
 */

import { app } from "../_comfy.js";
import { 拖出目标表, 加载节点表, 目标节点名称, 媒体MIME表 } from "./const.js";
import { 弹出提示, 是班长拖拽, 解析拖拽载荷, 获取画布元素 } from "./util.js";
import { 取input路径, 取原文件blob } from "./backend.js";

/* 槽位能不能吃这种媒体：
 * 图片吃 IMAGE 口、音频吃 AUDIO 口；视频没有通用输入类型，不参与口匹配（只建节点）。 */
function 槽可接(槽类型, 媒体类型) {
    if (!槽类型 || !媒体类型) return false;
    const 大写 = String(槽类型).toUpperCase();
    if (媒体类型 === "image") return 大写.includes("IMAGE");
    if (媒体类型 === "audio") return 大写.includes("AUDIO");
    return false;
}

function 命中输入(节点, 落点, 媒体类型) {
    let 命中 = -1;
    let 最短距离 = 24;
    (节点.inputs || []).forEach((输入, 索引) => {
        if (!槽可接(输入.type, 媒体类型)) return;
        const 位置 = 节点.getConnectionPos?.(true, 索引);
        if (!位置) return;
        const 距离 = Math.hypot(位置[0] - 落点[0], 位置[1] - 落点[1]);
        if (距离 < 最短距离) {
            最短距离 = 距离;
            命中 = 索引;
        }
    });
    return 命中;
}

function 查找空闲输入(节点, 媒体类型) {
    return (节点.inputs || []).findIndex(输入 => 槽可接(输入.type, 媒体类型) && !输入.link);
}

function 写入控件值(控件, 值) {
    控件.value = 值;
    const 候选值列表 = 控件.options?.values;
    if (Array.isArray(候选值列表) && !候选值列表.includes(值)) 候选值列表.push(值);
}

async function 新建加载节点(载荷, 落点) {
    const 目标 = 拖出目标表[载荷.type] || 拖出目标表.image;
    const 结果 = await 取input路径(载荷);
    if (!结果) return null;
    const 新节点 = LiteGraph.createNode(目标.节点);
    if (!新节点) {
        弹出提示("error", "拖出失败", `画布上没有 ${目标.节点} 节点类型`);
        return null;
    }
    新节点.pos = [落点[0], 落点[1]];
    app.graph.add(新节点);
    const 值控件 = (新节点.widgets || []).find(w => w.name === 目标.控件);
    if (值控件) 写入控件值(值控件, 结果.value);
    新节点.setDirtyCanvas?.(true, true);
    if (结果.copied) 弹出提示("info", "已复制原文件到 input 目录", 结果.value);
    return 新节点;
}

async function 新建并连线(载荷, 目标节点, 输入索引) {
    const 槽位 = 目标节点.getConnectionPos?.(true, 输入索引) || 目标节点.pos;
    const 新节点 = await 新建加载节点(载荷, [槽位[0] - 280, 槽位[1] - 100]);
    if (新节点) 新节点.connect(0, 目标节点, 输入索引);
    app.graph.setDirtyCanvas?.(true, true);
}

async function 尝试直接赋值(载荷, 目标节点) {
    if (目标节点.comfyClass === 目标节点名称) {
        const 文件夹控件 = (目标节点.widgets || []).find(w => w.name === "📂 文件夹路径");
        const 文件控件 = (目标节点.widgets || []).find(w => w.name === "📄 指定文件");
        if (!文件夹控件 || !文件控件) return false;
        const 换了目录 = 文件夹控件.value !== 载荷.folder;
        文件夹控件.value = 载荷.folder;
        文件控件.value = 载荷.filename;
        目标节点.setDirtyCanvas?.(true, true);
        // 直接写 .value 不会触发控件回调，这里手动通知节点同步（换目录则整表重载）
        if (换了目录) 目标节点.bz刷新列表?.(); else 目标节点.bz同步选中?.(载荷.filename);
        return true;
    }

    const 可接 = 加载节点表[目标节点.comfyClass];
    if (可接) {
        if (可接.类型 !== 载荷.type) return false;
        const 值控件 = (目标节点.widgets || []).find(w => w.name === 可接.控件);
        if (!值控件) return false;
        const 结果 = await 取input路径(载荷);
        if (!结果) return true;
        写入控件值(值控件, 结果.value);
        目标节点.setDirtyCanvas?.(true, true);
        if (结果.copied) 弹出提示("info", "已复制原文件到 input 目录", 结果.value);
        return true;
    }
    return false;
}

/* 落点在别的节点面板上时，把「引用拖拽」就地转成「文件拖拽」：
 * 拉原文件字节 → 造一个真 File → 合成一个 drop 事件投给光标下的元素。
 * 对方面板只认 dataTransfer.files 也能照常吃下，且吃到的是原文件。 */
async function 转发为文件投放(事件, 载荷) {
    const 目标元素 = document.elementFromPoint(事件.clientX, 事件.clientY) || 事件.target;
    if (!目标元素) return;
    const 数据 = await 取原文件blob(载荷.folder, 载荷.filename);
    if (!数据) return;
    /* 递归列表的 filename 是相对路径（子目录/名.png）。转发的接收方一律走
       /upload/image，落盘位置由它们自己的 subfolder 决定，文件名必须是裸
       文件名——带着路径传就是 input/cglide/cglide/角色A.png 的目录叠罗汉。
       拖画布建节点走 投放媒体 分支不经这里，LoadImage 值的相对路径不受影响。 */
    const 主干名 = (载荷.filename || "").split(/[\\/]/).pop();
    const 扩展名 = 主干名.split(".").pop().toLowerCase();
    const 文件 = new File([数据], 主干名, { type: 媒体MIME表[扩展名] || 数据.type || "application/octet-stream" });

    const 传输 = new DataTransfer();
    传输.items.add(文件);
    目标元素.dispatchEvent(new DragEvent("drop", {
        bubbles: true, cancelable: true, composed: true,
        clientX: 事件.clientX, clientY: 事件.clientY,
        dataTransfer: 传输
    }));
}

async function 投放媒体(载荷, 落点) {
    载荷.type = 载荷.type || "image";
    // 多选拖出：第一个走完整智能逻辑（可连线/改值），其余在旁边按列排开独立成节点
    if (Array.isArray(载荷.items) && 载荷.items.length > 1) {
        await 投放多个媒体(载荷.items, 落点);
        return;
    }
    const 目标节点 = app.graph.getNodeOnPos(落点[0], 落点[1]);
    if (目标节点) {
        const 命中索引 = 命中输入(目标节点, 落点, 载荷.type);
        if (命中索引 !== -1) { await 新建并连线(载荷, 目标节点, 命中索引); return; }
        if (await 尝试直接赋值(载荷, 目标节点)) return;
        const 空闲索引 = 查找空闲输入(目标节点, 载荷.type);
        if (空闲索引 !== -1) { await 新建并连线(载荷, 目标节点, 空闲索引); return; }
    }
    await 新建加载节点(载荷, 落点);
}

async function 投放多个媒体(条目列表, 落点) {
    for (let 序 = 0; 序 < 条目列表.length; 序++) {
        const 条目 = { ...条目列表[序] };
        条目.type = 条目.type || "image";
        if (序 === 0) {
            // 第一个交给原有逻辑：落点上有输入口就连线，没有就建节点
            await 投放媒体(条目, 落点);
            continue;
        }
        // 其余的摆成 3 个一列的队列，从落点右下方开始
        const 列 = Math.floor((序 - 1) / 3);
        const 行 = (序 - 1) % 3;
        await 新建加载节点(条目, [落点[0] + 300 * (列 + 1), 落点[1] + 330 * 行]);
    }
    app.graph?.setDirtyCanvas?.(true, true);
}

let 落点已绑定 = false;

export function 绑定拖出落点() {
    if (落点已绑定) return;
    落点已绑定 = true;

    document.addEventListener("dragover", (事件) => {
        if (!是班长拖拽(事件)) return;
        事件.preventDefault();
        事件.dataTransfer.dropEffect = "copy";
    });

    document.addEventListener("drop", async (事件) => {
        if (!是班长拖拽(事件)) return;
        事件.preventDefault();
        事件.stopPropagation();
        if (事件.target?.closest?.(".bz-grid-container")) return;

        const 画布元素 = 获取画布元素();
        if (!画布元素) return;
        const 框 = 画布元素.getBoundingClientRect();
        const 在画布内 = 事件.clientX >= 框.left && 事件.clientX <= 框.right
            && 事件.clientY >= 框.top && 事件.clientY <= 框.bottom;
        if (!在画布内) return;

        const 载荷 = 解析拖拽载荷(事件);
        if (!载荷?.filename) return;

        const 画布 = app.canvas;
        if (!画布 || !app.graph) return;
        try {
            // 落点在本体画布上：走连线 / 改值 / 新建；落在别的节点面板上：转文件投放
            if (事件.target === 画布元素) {
                const 落点 = 画布.convertEventToCanvasOffset({ clientX: 事件.clientX, clientY: 事件.clientY });
                await 投放媒体(载荷, 落点);
            } else {
                // 引用通道：文件已在 input 目录内，目标面板自己从 dataTransfer 读 rel
                // 即可定位；再合成一次「文件投放」会触发它那边的上传、同目录复制一份。
                if (载荷.rel) return;
                // 多选拖到别的面板没有意义（那边的上传通道一次收一个），只转发第一个
                const 单载荷 = Array.isArray(载荷.items) && 载荷.items.length > 1 ? 载荷.items[0] : 载荷;
                await 转发为文件投放(事件, 单载荷);
            }
        } catch (错误) {
            弹出提示("error", "拖出失败", 错误.message || String(错误));
        }
    });
}
