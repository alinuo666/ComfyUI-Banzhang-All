/**
 * 去重面板：按内容哈希找出重复文件，合并成指向保留文件的硬链接。
 * 文件名一个都不改，节点控件与工作流里的引用照常有效，磁盘上只留一份数据。
 *
 * 用得到的抽屉字段：当前路径()、子目录控件；调用：加载媒体列表；注入：打开去重 / 关闭去重
 */

import { API_前缀 } from "./const.js";
import { 创建元素, 人类字节, 弹出提示 } from "./util.js";
import { 带超时fetch, 后端错误提示 } from "./backend.js";

export function 创建去重面板(ctx) {
    let 去重面板 = null;

    const 关闭去重 = () => {
        if (去重面板) { 去重面板.remove(); 去重面板 = null; }
    };

    const 打开去重 = async () => {
        关闭去重();
        const 遮罩 = 创建元素("div", { className: "bz-dedupe-mask" });
        const 面板 = 创建元素("div", { className: "bz-dedupe" });

        const 头部 = 创建元素("div", { className: "bz-dedupe-head" });
        const 关闭钮 = 创建元素("div", { className: "bz-dedupe-close", textContent: "✕" });
        关闭钮.addEventListener("click", 关闭去重);
        头部.append(创建元素("div", { className: "bz-dedupe-title", textContent: "🧹 重复文件" }), 关闭钮);

        const 摘要 = 创建元素("div", { className: "bz-dedupe-sum", textContent: "正在按内容哈希比对…" });
        const 列表 = 创建元素("div", { className: "bz-dedupe-list" });

        const 进度 = 创建元素("div", { className: "bz-dedupe-prog", textContent: "" });
        const 取消钮 = 创建元素("button", { className: "bz-dedupe-btn", textContent: "关闭" });
        取消钮.addEventListener("click", 关闭去重);
        const 全部钮 = 创建元素("button", { className: "bz-dedupe-btn bz-primary", textContent: "全部合并" });
        全部钮.disabled = true;
        const 操作区 = 创建元素("div", { className: "bz-dedupe-actions" });
        操作区.append(取消钮, 全部钮);
        const 底部 = 创建元素("div", { className: "bz-dedupe-foot" });
        底部.append(进度, 操作区);

        面板.append(头部, 摘要, 列表, 底部);
        遮罩.appendChild(面板);
        遮罩.addEventListener("click", (事件) => { if (事件.target === 遮罩) 关闭去重(); });
        document.body.appendChild(遮罩);
        去重面板 = 遮罩;

        let 分组数据 = [];
        try {
            const 响应 = await 带超时fetch(`${API_前缀}/find_duplicates`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ folder_path: ctx.当前路径(), recursive: !!ctx.子目录控件?.value })
            });
            const 数据 = await 响应.json();
            if (数据.error) {
                摘要.textContent = `❌ ${数据.msg || "扫描失败"}`;
                return;
            }
            分组数据 = 数据.groups || [];
            if (分组数据.length === 0) {
                摘要.textContent = "✅ 这个目录里没有内容完全相同的重复文件";
                return;
            }

            摘要.textContent = "";
            摘要.appendChild(创建元素("div", {
                textContent: `共 ${数据.group_count} 组重复文件，全部合并预计可回收 ${人类字节(数据.waste)}`
            }));
            摘要.appendChild(创建元素("div", {
                className: "bz-dedupe-warn",
                textContent: "合并 = 把重复文件换成指向「保留文件」的硬链接：文件名一个都不改，节点与工作流的引用照常有效，磁盘上只留一份数据。"
            }));
            if (数据.support_link === false) {
                摘要.appendChild(创建元素("div", {
                    className: "bz-dedupe-warn",
                    textContent: "⚠️ 当前目录不支持硬链接（跨盘或权限不足），无法合并。"
                }));
            } else {
                全部钮.disabled = false;
            }

            const 选择表 = new Map();   // 组索引 → 保留的文件名
            const 已合并组 = new Set(); // 单组合并过的组，点「全部合并」时跳过，不重复提交

            const 执行合并 = async (组索引列表, 按钮) => {
                const 待处理 = 组索引列表.filter(索引 => !已合并组.has(索引));
                if (待处理.length === 0) return 0;
                let 已合并 = 0, 已回收 = 0;
                if (按钮) 按钮.disabled = true;
                for (const 组索引 of 待处理) {
                    const 组 = 分组数据[组索引];
                    if (!组) continue;
                    已合并组.add(组索引);
                    const 保留 = 选择表.get(组索引) || 组.files[0];
                    const 替换 = 组.files.filter(名 => 名 !== 保留);
                    if (替换.length === 0) continue;
                    进度.textContent = `合并中… ${待处理.indexOf(组索引) + 1}/${待处理.length}`;
                    try {
                        const 响应 = await 带超时fetch(`${API_前缀}/merge_duplicates`, {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ folder_path: ctx.当前路径(), keep: 保留, replace: 替换 })
                        }, 300000);
                        const 结果 = await 响应.json();
                        if (结果.error) {
                            弹出提示("error", "合并失败", 结果.msg || "未知错误");
                            continue;
                        }
                        已合并 += 结果.merged || 0;
                        已回收 += 结果.saved || 0;
                    } catch (错误) {
                        弹出提示("error", "合并失败", 后端错误提示(错误));
                    }
                }
                if (按钮) 按钮.disabled = false;
                进度.textContent = `已合并 ${已合并} 个文件，回收 ${人类字节(已回收)}`;
                return 已合并;
            };

            分组数据.forEach((组, 组索引) => {
                选择表.set(组索引, 组.files[0]);
                const 组元素 = 创建元素("div", { className: "bz-dup-group" });
                const 组头 = 创建元素("div", { className: "bz-dup-group-head" });
                const 本组钮 = 创建元素("button", { className: "bz-dedupe-btn", textContent: "合并本组" });
                组头.append(
                    创建元素("div", { className: "bz-dup-head-info", textContent: `${组.files.length} 个文件 · 每个 ${人类字节(组.size)}` }),
                    创建元素("div", { className: "bz-dup-size", textContent: `可回收 ${人类字节(组.waste)}` }),
                    本组钮
                );

                const 文件盒 = 创建元素("div", { className: "bz-dup-files" });
                const 行表 = [];
                const 刷新组 = () => {
                    行表.forEach(({ 行, 标, 文件名 }) => {
                        const 是保留 = 选择表.get(组索引) === 文件名;
                        行.classList.toggle("bz-on", 是保留);
                        标.textContent = 是保留 ? "保留" : "→ 合并到保留项";
                    });
                };
                组.files.forEach((文件名) => {
                    const 行 = 创建元素("div", { className: "bz-dup-file", title: 文件名 });
                    const 标 = 创建元素("div", { className: "bz-dup-badge", textContent: "" });
                    行.append(创建元素("div", { className: "bz-dup-name", textContent: 文件名 }), 标);
                    行.addEventListener("click", () => { 选择表.set(组索引, 文件名); 刷新组(); });
                    行表.push({ 行, 标, 文件名 });
                    文件盒.appendChild(行);
                });
                刷新组();
                本组钮.addEventListener("click", async () => {
                    const 数量 = await 执行合并([组索引], 本组钮);
                    if (数量 > 0) 组元素.remove();
                });

                组元素.append(组头, 文件盒);
                列表.appendChild(组元素);
            });

            全部钮.addEventListener("click", async () => {
                await 执行合并(分组数据.map((_, 索引) => 索引), 全部钮);
                关闭去重();
                ctx.加载媒体列表();
            });
        } catch (错误) {
            摘要.textContent = `❌ 扫描失败：${后端错误提示(错误)}`;
        }
    };

    ctx.打开去重 = 打开去重;
    ctx.关闭去重 = 关闭去重;
}
