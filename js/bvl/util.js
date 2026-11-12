/**
 * 小工具：不依赖任何面板状态，纯粹「给进去什么、吐出来什么」。
 *
 * 用得到的抽屉字段：无
 */

import { app } from "../_comfy.js";
import { 拖拽数据类型, 媒体MIME表, API_前缀 } from "./const.js";

export function 创建元素(标签名, 属性 = {}, 子元素列表 = []) {
    const 元素 = document.createElement(标签名);
    if (标签名.includes(".")) {
        const parts = 标签名.split(".");
        元素.tagName = parts[0];
        parts.slice(1).forEach(cls => 元素.classList.add(cls));
    }
    Object.assign(元素, 属性);
    子元素列表.forEach(子元素 => {
        if (子元素) 元素.appendChild(子元素);
    });
    return 元素;
}

export function 人类字节(字节数) {
    const 单位表 = ["B", "KB", "MB", "GB", "TB"];
    let 值 = Number(字节数) || 0;
    let 序 = 0;
    while (值 >= 1024 && 序 < 单位表.length - 1) { 值 /= 1024; 序++; }
    return `${值.toFixed(值 >= 10 || 序 === 0 ? 0 : 1)}${单位表[序]}`;
}

export function 是班长拖拽(事件) {
    const 类型列表 = 事件.dataTransfer?.types;
    return !!类型列表 && Array.from(类型列表).includes(拖拽数据类型);
}

export function 解析拖拽载荷(事件) {
    try {
        return JSON.parse(事件.dataTransfer.getData(拖拽数据类型));
    } catch (e) {
        return null;
    }
}

export function 获取画布元素() {
    return app.canvasEl || app.canvas?.canvas || document.querySelector("canvas#graph-canvas");
}

export function 弹出提示(级别, 标题, 内容) {
    try {
        app.extensionManager?.toast?.add?.({ severity: 级别, summary: 标题, detail: 内容, life: 4000 });
    } catch (e) {
        console.warn("[班长] 提示发送失败", e);
    }
}

// 改名可能连扩展名一起换（png → mp4），此时要按新扩展名重判类型
export function 按扩展名判类型(文件名) {
    const 扩展名 = (文件名 || "").split(".").pop().toLowerCase();
    const MIME = 媒体MIME表[扩展名] || "";
    if (MIME.startsWith("video/")) return "video";
    if (MIME.startsWith("audio/")) return "audio";
    return "image";
}

// 视频/音频内联播放走原文件（需后端支持 Range）
export const 媒体源地址 = (文件夹, 文件名) =>
    `${API_前缀}/view_image?folder_path=${encodeURIComponent(文件夹)}&filename=${encodeURIComponent(文件名)}`;

// 缩略图地址：文件名带路径也照常编码，后端按相对路径找
export const 缩略图地址 = (文件夹, 文件名) =>
    `${API_前缀}/view_image?folder_path=${encodeURIComponent(文件夹)}&filename=${encodeURIComponent(文件名)}&thumbnail=true`;
