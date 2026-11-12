/**
 * 后端接口：所有跟 ComfyUI 后端要数据 / 提交动作的函数集中在这里。
 * 这一层只管发请求和收结果，成功失败怎么提示，交给调用方决定
 * （取input路径 除外——它原本就自带提示，照搬）。
 *
 * 用得到的抽屉字段：无
 */

import { api } from "../_comfy.js";
import { API_前缀 } from "./const.js";
import { 弹出提示 } from "./util.js";

// 去重扫描/合并可能要读完整盘哈希，给请求加个上限
export function 带超时fetch(路径, 选项 = {}, 毫秒 = 120000) {
    const 控制器 = new AbortController();
    const 定时 = setTimeout(() => 控制器.abort(), 毫秒);
    return api.fetchApi(路径, { ...选项, signal: 控制器.signal })
        .finally(() => clearTimeout(定时));
}

// 后端没响应时给明确提示，不再让用户面对天书般的「Failed to fetch」干等
export function 后端错误提示(错误) {
    if (错误?.name === "AbortError") return "后端 120 秒内没有响应（目录太大时属正常，稍后重试即可；若反复如此请检查 ComfyUI 是否还在运行）";
    const 文本 = String(错误?.message || 错误);
    if (文本.includes("Failed to fetch") || 文本.includes("NetworkError")) return "连不上 ComfyUI 后端——服务可能已退出或重启中，请确认 ComfyUI 正在运行后重试";
    return 文本;
}

// 把面板里的文件搬进 input 目录（必要时复制），返回可写进节点控件的值
export async function 取input路径(载荷) {
    const 响应 = await api.fetchApi(`${API_前缀}/import_image`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ folder_path: 载荷.folder, filename: 载荷.filename })
    });
    const 结果 = await 响应.json();
    if (!结果.success) {
        弹出提示("error", "拖出失败", 结果.msg || "未知错误");
        return null;
    }
    return 结果;
}

// 列目录。返回原始 response：调用方要读 X-Input-Rel 响应头（判断列表是否在 input 目录内）
export function 列媒体(路径, 排序, 递归) {
    return api.fetchApi(`${API_前缀}/list_images`, {
        method: "POST",
        body: JSON.stringify({ folder_path: 路径, sort_method: 排序, recursive: !!递归 })
    });
}

export async function 删除文件(路径, 文件名) {
    const 响应 = await api.fetchApi(`${API_前缀}/delete_image`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ folder_path: 路径, filename: 文件名 })
    });
    return await 响应.json();
}

export async function 重命名文件(路径, 原名, 新名) {
    const 响应 = await api.fetchApi(`${API_前缀}/rename_image`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ folder_path: 路径, filename: 原名, new_name: 新名 })
    });
    return await 响应.json();
}

export async function 上传文件(路径, 文件对象) {
    const formData = new FormData();
    formData.append("folder_path", 路径);
    formData.append("image", 文件对象);
    const 响应 = await api.fetchApi(`${API_前缀}/upload_image`, {
        method: "POST",
        body: formData
    });
    if (响应.status !== 200) {
        throw new Error(`Code ${响应.status}: ${响应.statusText}`);
    }
    return await 响应.json();
}

// 读原文件字节（拖到其他面板时要转成一个真 File 投过去）。读不到返回 null 并提示。
export async function 取原文件blob(文件夹, 文件名) {
    const 响应 = await api.fetchApi(
        `${API_前缀}/view_image?folder_path=${encodeURIComponent(文件夹)}&filename=${encodeURIComponent(文件名)}`
    );
    if (!响应.ok) {
        弹出提示("error", "拖出失败", "读不到原文件（文件可能已被删除）");
        return null;
    }
    return await 响应.blob();
}
