import { app } from "../../scripts/app.js";

// ═══════════════════════════════════════════════
//  显存安全 LoRA 加载器 · 多 LoRA 面板
//  每行：启用勾选(最左) | LoRA 下拉 | 强度 | 备注 | 删除
//  底部：「＋ 添加 LoRA」动态新增行，最多 10 个
//  面板整体序列化为 JSON，经「LoRA配置」输入传给后端
// ═══════════════════════════════════════════════

const MAX_LORA = 10;

// 高度贴合策略（移植自桌面验证版 banzhang_lora_loader.js）：
// 不做 margin 补偿、不做 DOM 实测反推 —— 那套逻辑在当前前端版本下算不准，
// 会导致面板溢出节点框。直接按「行数 × 40 + 50」手算面板高，computeSize
// 原样返回该值，节点总高由 resizeNode 按 computeSize 向上兜底。

// ── 样式注入 ──────────────────────────────────
(function injectCss() {
    const ID = "banzhang-lora-css";
    if (document.getElementById(ID)) return;
    const s = document.createElement("style");
    s.id = ID;
    s.textContent = `
.bzl-wrap{width:100%;padding:4px 8px 5px;box-sizing:border-box;font-family:'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif}
.bzl-row{display:flex;align-items:center;gap:5px;margin-bottom:4px;background:rgba(255,255,255,.045);border:1px solid rgba(255,255,255,.09);border-radius:6px;padding:3px 5px}
.bzl-row.bzl-off{opacity:.42}
.bzl-row input[type="checkbox"]{width:14px;height:14px;accent-color:#4a9eff;cursor:pointer;flex-shrink:0;margin:0}
.bzl-row .bzl-file{flex:1.3;min-width:0;background:#22242a;color:#e8e8e8;border:1px solid #3a3d45;border-radius:5px;padding:2px 5px;font-size:12px;outline:none;cursor:pointer;text-align:left;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:inherit}
.bzl-row .bzl-file:hover{border-color:#4a9eff}
.bzl-pop{position:fixed;z-index:99999;background:#1c1e24;border:1px solid #3a3d45;border-radius:10px;box-shadow:0 12px 40px rgba(0,0,0,.55);overflow:hidden;font-family:'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif}
.bzl-mask{position:fixed;inset:0;z-index:99998;background:transparent}
.bzl-filter{width:100%;box-sizing:border-box;background:#22242a;border:none;border-bottom:1px solid #3a3d45;color:#e8e8e8;padding:8px 10px;font-size:12.5px;outline:none}
.bzl-tree{max-height:280px;overflow:auto;padding:4px 0}
.bzl-trow{display:flex;align-items:center;gap:6px;padding:5px 10px;font-size:12.5px;color:#dcdcdc;cursor:pointer;white-space:nowrap;overflow:hidden}
.bzl-trow:hover{background:rgba(255,255,255,.07)}
.bzl-trow.bzl-cur{color:#4a9eff}
.bzl-dir{color:#c8cad0;font-weight:600}
.bzl-arrow{width:12px;flex-shrink:0;color:#8a8f99}
.bzl-empty{padding:10px;color:#8a8f99;font-size:12px;text-align:center}
.bzl-row .bzl-str{width:58px;flex-shrink:0;background:#22242a;color:#e8e8e8;border:1px solid #3a3d45;border-radius:5px;padding:2px;font-size:12px;outline:none}
.bzl-row .bzl-str:focus{border-color:#4a9eff}
.bzl-row .bzl-note{flex:.5;min-width:0;background:transparent;color:#cfcfcf;border:none;border-bottom:1px dashed #3a3d45;padding:2px;font-size:12px;outline:none}
.bzl-row .bzl-note:focus{border-bottom-color:#4a9eff}
.bzl-row .bzl-del{width:20px;height:20px;line-height:18px;text-align:center;border:none;border-radius:5px;background:transparent;color:#ff6b6b;font-size:15px;cursor:pointer;flex-shrink:0;padding:0}
.bzl-row .bzl-del:hover{background:rgba(255,107,107,.15)}
.bzl-add{width:100%;text-align:center;padding:3px 0;border:1px dashed #3a3d45;border-radius:6px;color:#9aa0aa;font-size:12px;cursor:pointer;user-select:none;background:rgba(255,255,255,.03)}
.bzl-add:hover{border-color:#4a9eff;color:#4a9eff}
.bzl-full{color:#e8a13c;font-size:11.5px;text-align:center;margin-bottom:4px}
`;
    document.head.appendChild(s);
})();

// ── LoRA 文件清单 ─────────────────────────────
// 清单来自 LoRA文件 combo 的 options.values（后端 folder_paths 原生填充，
// 含子目录 + extra_model_paths.yaml 追加目录）。零网络请求、零时序竞态。
function getLoraList(node) {
    const w = node.widgets?.find((x) => x.name === "LoRA文件");
    const values = w?.options?.values;
    return Array.isArray(values) ? values : [];
}

// Windows 上 os.path.relpath 产出 "\" 分隔符，统一归一化后再分组/显示
const normPath = (p) => String(p).replace(/\\/g, "/");

// ── 树形选择弹窗（Filter 搜索 + 文件夹树，形式同原生加载器） ──
let BZL_POP = null;
let BZL_MASK = null;
let BZL_PLACE = null;
function closeTreePopup() {
    if (BZL_POP) {
        BZL_POP.remove();
        BZL_POP = null;
    }
    if (BZL_MASK) {
        BZL_MASK.remove();
        BZL_MASK = null;
    }
    if (BZL_PLACE) {
        window.removeEventListener("resize", BZL_PLACE);
        BZL_PLACE = null;
    }
}

function openTreePopup(anchor, files, current, onPick, ev) {
    closeTreePopup();

    // 全屏透明遮罩：点任何空白处必点中遮罩 → 关闭，不依赖事件冒泡
    // （ComfyUI 画布用 pointer 事件 + 部分扩展拦截文档级事件，监听方案不可靠）
    BZL_MASK = document.createElement("div");
    BZL_MASK.className = "bzl-mask";
    BZL_MASK.addEventListener("mousedown", closeTreePopup);
    document.body.appendChild(BZL_MASK);

    const pop = document.createElement("div");
    pop.className = "bzl-pop";
    const inp = document.createElement("input");
    inp.className = "bzl-filter";
    inp.placeholder = "Filter list";
    const tree = document.createElement("div");
    tree.className = "bzl-tree";
    pop.append(inp, tree);
    document.body.appendChild(pop);
    BZL_POP = pop;

    // 定位：锚点元素下方；rect 退化时用点击坐标兜底；越界收边/上翻
    const place = () => {
        const r = anchor.getBoundingClientRect();
        const W = Math.max(280, r.width || 280);
        pop.style.width = W + "px";
        let left = r.left;
        let top = r.bottom + 4;
        if ((!r.width && !r.height) && ev) {
            left = ev.clientX;
            top = ev.clientY + 4;
        }
        left = Math.max(8, Math.min(left, window.innerWidth - W - 8));
        if (top + pop.offsetHeight > window.innerHeight - 8) {
            top = Math.max(8, (r.top || (ev ? ev.clientY : 0)) - pop.offsetHeight - 4);
        }
        pop.style.left = left + "px";
        pop.style.top = top + "px";
    };
    place();
    requestAnimationFrame(place); // 布局稳定后校正一次
    window.addEventListener("resize", place);
    BZL_PLACE = place;

    // 默认展开当前文件所在目录链
    const expanded = new Set();
    if (current) {
        const parts = normPath(current).split("/");
        for (let i = 1; i < parts.length; i++) expanded.add(parts.slice(0, i).join("/"));
    }

    const addFileRow = (f, depth, showPath) => {
        // 清单里的原始值可能是 "\"（Windows），配置里存的是 "/"，
        // 高亮当前文件必须归一化后再比
        const d = document.createElement("div");
        d.className = "bzl-trow" + (normPath(f) === normPath(current) ? " bzl-cur" : "");
        d.style.paddingLeft = 10 + depth * 14 + "px";
        d.textContent = showPath ? normPath(f) : normPath(f).split("/").pop();
        d.title = normPath(f);
        d.onclick = () => { closeTreePopup(); onPick(f); };
        tree.appendChild(d);
    };

    const render = () => {
        const kw = inp.value.trim().toLowerCase();
        tree.innerHTML = "";
        if (!files.length) {
            const e = document.createElement("div");
            e.className = "bzl-empty";
            e.textContent = "未找到 LoRA 文件：请确认 LoRA 已放入 ComfyUI 的 models/loras 目录";
            e.style.lineHeight = "1.7";
            tree.appendChild(e);
            return;
        }
        // 搜索模式：平铺全部命中项（同原生 Filter list 行为）
        if (kw) {
            const hits = files.filter((f) => normPath(f).toLowerCase().includes(kw));
            hits.forEach((f) => addFileRow(f, 0, true));
            if (!hits.length) {
                const e = document.createElement("div");
                e.className = "bzl-empty";
                e.textContent = "无匹配";
                tree.appendChild(e);
            }
            return;
        }
        // 树模式：目录可展开/收起
        const root = { dirs: new Map(), files: [] };
        for (const f of files) {
            const parts = normPath(f).split("/");
            let n = root;
            for (let i = 0; i < parts.length - 1; i++) {
                if (!n.dirs.has(parts[i])) n.dirs.set(parts[i], { dirs: new Map(), files: [] });
                n = n.dirs.get(parts[i]);
            }
            n.files.push(f);
        }
        const walk = (dirsMap, fileArr, depth, path) => {
            [...dirsMap.keys()].sort().forEach((name) => {
                const full = path ? path + "/" + name : name;
                const open = expanded.has(full);
                const d = document.createElement("div");
                d.className = "bzl-trow bzl-dir";
                d.style.paddingLeft = 10 + depth * 14 + "px";
                const arrow = document.createElement("span");
                arrow.className = "bzl-arrow";
                arrow.textContent = open ? "▾" : "▸";
                const label = document.createElement("span");
                label.textContent = "📁 " + name;
                d.append(arrow, label);
                d.onclick = () => {
                    if (expanded.has(full)) expanded.delete(full); else expanded.add(full);
                    render();
                };
                tree.appendChild(d);
                if (open) {
                    const sub = dirsMap.get(name);
                    walk(sub.dirs, sub.files, depth + 1, full);
                }
            });
            fileArr.forEach((f) => addFileRow(f, depth, false));
        };
        walk(root.dirs, root.files, 0, "");
    };

    inp.oninput = render;
    inp.onkeydown = (e) => { if (e.key === "Escape") closeTreePopup(); };
    render();
    inp.focus();
}

function defaultRow(node) {
    const files = getLoraList(node);
    return { on: true, file: files.length ? normPath(files[0]) : "", strength: 1.0, note: "" };
}

function syncConfig(node) {
    const json = JSON.stringify(node._bzRows || []);
    const cfg = node.widgets?.find((w) => w.name === "LoRA配置");
    if (cfg) cfg.value = json;
    // 双保险：同步写 node.properties，刷新/重开工作流时靠它恢复，
    // 不依赖 widgets_values 的索引对齐（那是「回到默认」的历史 bug 来源）。
    if (node.properties) node.properties["banzhang_lora_rows"] = json;
}

// 从持久化数据恢复面板行。优先级：properties（最可靠）→ widget.value（兜底）。
// 工作流加载时 configure 与 onNodeCreated(setupPanel) 的先后不保证，
// 两处都走这里，保证已有配置不会被默认行覆盖。
function restoreRows(node) {
    let raw = null;
    if (node.properties && node.properties["banzhang_lora_rows"]) {
        raw = node.properties["banzhang_lora_rows"];
    } else {
        const cfg = node.widgets?.find((w) => w.name === "LoRA配置");
        raw = cfg?.value ?? "[]";
    }
    let rows = [];
    try {
        rows = JSON.parse(raw);
    } catch (e) { /* 旧工作流或脏数据，走默认 */ }
    if (!Array.isArray(rows)) rows = [];
    rows = rows.filter((x) => x && typeof x === "object");
    node._bzRows = rows.length ? rows : [defaultRow(node)];
}

// ── 行构建 ────────────────────────────────────
function buildRow(node, row, index) {
    const div = document.createElement("div");
    div.className = "bzl-row" + (row.on ? "" : " bzl-off");

    // 最左：启用勾选
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = !!row.on;
    cb.title = "勾选启用 / 取消禁用该 LoRA";
    cb.onchange = () => {
        row.on = cb.checked;
        div.classList.toggle("bzl-off", !row.on);
        syncConfig(node);
    };

    // LoRA 选择按钮：点击弹出 Filter 搜索 + 文件夹树（形式同原生加载器）
    const fileBtn = document.createElement("button");
    fileBtn.type = "button";
    fileBtn.className = "bzl-file";
    const setName = (v) => {
        fileBtn.textContent = v ? normPath(v).split("/").pop() : "（未选择 LoRA）";
        fileBtn.title = v || "未选择";
    };
    if (!row.file) {
        const files = getLoraList(node);
        if (files.length) row.file = normPath(files[0]);
    }
    setName(row.file);
    fileBtn.onclick = (e) => {
        e.stopPropagation();
        openTreePopup(fileBtn, getLoraList(node), row.file, (v) => {
            // 统一存 "/"：Windows 清单里的 "\" 只留在显示层，不进配置
            row.file = normPath(v);
            setName(row.file);
            syncConfig(node);
        }, e);
    };

    // 强度（无上下限，负数为反向）
    const str = document.createElement("input");
    str.className = "bzl-str";
    str.type = "number";
    str.step = "0.05";
    str.value = row.strength ?? 1;
    str.title = "模型强度（无上下限，负数为反向）";
    const onStr = () => {
        const v = parseFloat(str.value);
        if (!isNaN(v)) {
            row.strength = v;
            syncConfig(node);
        }
    };
    str.oninput = onStr;
    str.onchange = onStr;

    // 备注
    const note = document.createElement("input");
    note.className = "bzl-note";
    note.type = "text";
    note.placeholder = "备注";
    note.title = "该 LoRA 的备注";
    note.value = row.note || "";
    note.oninput = () => { row.note = note.value; syncConfig(node); };

    // 删除
    const del = document.createElement("button");
    del.className = "bzl-del";
    del.textContent = "×";
    del.title = "删除该行";
    del.onclick = (e) => {
        e.stopPropagation();
        node._bzRows.splice(index, 1);
        rebuildPanel(node);
        syncConfig(node);
    };

    div.append(cb, fileBtn, str, note, del);
    return div;
}

// ── 面板重建 ──────────────────────────────────
function rebuildPanel(node) {
    const wrap = node._bzWrap;
    if (!wrap) return;
    wrap.innerHTML = "";

    const rows = node._bzRows;
    rows.forEach((row, i) => wrap.appendChild(buildRow(node, row, i)));

    if (rows.length >= MAX_LORA) {
        const full = document.createElement("div");
        full.className = "bzl-full";
        full.textContent = `最多 ${MAX_LORA} 个 LoRA，先删除再添加`;
        wrap.appendChild(full);
    } else {
        const add = document.createElement("div");
        add.className = "bzl-add";
        add.textContent = "＋ 添加 LoRA";
        add.onclick = (e) => {
            e.stopPropagation();
            node._bzRows.push(defaultRow(node));
            rebuildPanel(node);
            syncConfig(node);
        };
        wrap.appendChild(add);
    }

    // 高度：按行数手算（紧凑样式实测：每行约 34px + 添加按钮区约 38px）。
    // 尺寸计算完全照抄桌面版，不掺 margin 补偿 / DOM 实测（那套在前端下失准）。
    node._bzHeight = rows.length * 34 + 38;
    if (node._bzDomW) {
        node._bzDomW.computeSize = () => [node.size[0], node._bzHeight];
    }
    resizeNode(node);
}

// ── 节点尺寸（只增不减守卫）──（同桌面验证版，逐行一致）
function resizeNode(node) {
    const cs = node.computeSize();
    const minH = (node._bzHeight ?? 50) + 80;
    node.setSize([
        Math.max(cs[0], node.size?.[0] ?? 0),
        Math.max(cs[1], minH),
    ]);
    node.setDirtyCanvas(true, true);
}

// ── 面板初始化 ────────────────────────────────
// LoRA配置 / LoRA文件 / 模型强度 都是后端 optional 的 STRING/combo，ComfyUI
// 前端会把它们自动创建成 widget（不是端口），并自动序列化/恢复 —— 这是「刷新
// 不丢配置」的关键。这里只隐藏它们的 UI，不动态 addWidget（避免恢复时序竞态）。
function ensureHiddenWidgets(node) {
    // LoRA配置：面板 JSON 的序列化承载（框架自动创建 widget，这里覆盖序列化值）
    const cfg = node.widgets?.find((x) => x.name === "LoRA配置");
    if (cfg) {
        cfg.hidden = true;
        cfg.computeSize = () => [0, -4];
        cfg.draw = () => {};
        cfg.mouse = () => {};
        cfg.serializeValue = () => JSON.stringify(node._bzRows || []);
    }

    // 模型强度：兜底强度承载（框架自动创建 widget，隐藏即可）
    const str = node.widgets?.find((x) => x.name === "模型强度");
    if (str) {
        str.hidden = true;
        str.computeSize = () => [0, -4];
        str.draw = () => {};
        str.mouse = () => {};
    }
}

// LoRA文件 是 combo widget（不是端口）：隐藏 UI，仅作面板文件清单来源。
// serialize=false 使其不进 prompt（面板用 LoRA配置 传值）、不进工作流存档。
function detachLoraPort(node) {
    const lora = node.widgets?.find((x) => x.name === "LoRA文件");
    if (!lora) return;
    lora.hidden = true;
    lora.computeSize = () => [0, -4];
    lora.draw = () => {};
    lora.mouse = () => {};
    lora.serialize = false;
    lora.options = { ...(lora.options || {}), serialize: false };
}

function setupPanel(node) {
    ensureHiddenWidgets(node);
    detachLoraPort(node);

    restoreRows(node); // 已有配置优先，避免加载时被默认行覆盖
    node._bzHeight = 90; // 初始值，rebuildPanel 会按行数重算

    const wrap = document.createElement("div");
    wrap.className = "bzl-wrap";
    // 防止输入交互触发节点拖拽 / 画布快捷键
    wrap.addEventListener("mousedown", (e) => e.stopPropagation());
    wrap.addEventListener("keydown", (e) => e.stopPropagation());

    node._bzWrap = wrap;
    node._bzDomW = node.addDOMWidget("lora面板", "lora面板", wrap, {
        serialize: false,
    });

    // 面板移到 widgets 数组最前：ComfyUI 按数组顺序排列 widget，addDOMWidget
    // 默认追加到末尾，会被 LoRA文件/LoRA配置/模型强度 挤到端口下方 → 框离端口远。
    // 移到索引 0 后，面板紧跟端口，距离最小。
    const wi = node.widgets.indexOf(node._bzDomW);
    if (wi > 0) node.widgets.splice(0, 0, node.widgets.splice(wi, 1)[0]);

    node.size[0] = Math.max(node.size[0] ?? 0, 320); // 先定宽，再量高（宽度会影响行高）
    rebuildPanel(node);
    syncConfig(node);
    resizeNode(node);
}

// ── 注册扩展 ──────────────────────────────────
app.registerExtension({
    name: "banzhang.lora.vramsafe.multi",

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== "BanZhang_LoRA_VramSafe") return;

        const onCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const r = onCreated ? onCreated.apply(this, arguments) : undefined;
            setupPanel(this);
            return r;
        };

        // 加载已保存的工作流：从 LoRA配置 JSON 恢复面板行
        const onConfigure = nodeType.prototype.configure;
        nodeType.prototype.configure = function (info) {
            const r = onConfigure ? onConfigure.apply(this, arguments) : undefined;
            // configure 可能早于 onNodeCreated（widget 尚未创建），先确保 widget 存在
            ensureHiddenWidgets(this);
            detachLoraPort(this);
            restoreRows(this);
            if (this._bzWrap) rebuildPanel(this);
            syncConfig(this);
            return r;
        };
    },
});
