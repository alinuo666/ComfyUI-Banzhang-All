// ═══════════════════════════════════════════════
// 📼 加载视频 (班长) · 前端扩展
// 1. 每行参数右侧 ⟳ 恢复默认（值≠默认才显示，同 VHS 行为）
// 2. 底部视频预览窗（input 目录文件，静音循环自动播）
// 3. 「选择视频上传」按钮（传完自动进下拉并预览）
// 仅挂 BanzhangLoadVideo；注册键/类型独立，与 VHS 插件互不干扰。
// ═══════════════════════════════════════════════
const { app } = window.comfyAPI.app;
const { api } = window.comfyAPI.api;

const WIDGET_H = 20;    // litegraph 单行 widget 高
const ICON_X = 26;      // 图标中心距节点右缘（同 VHS：margin15 + 26）

function chainCallback(target, name, fn) {
    const prev = target[name];
    target[name] = function (...args) {
        const r = prev?.apply(this, args);
        fn.apply(this, args);
        return r;
    };
}

function buildInputURL(filename) {
    return api.apiURL(`/view?filename=${encodeURIComponent(filename)}&type=input`);
}

// 高度纯推导（铁律：节点高度是推导值不是存储值）——按 computeSize 精确拉回，
// 预览换源/比例变化后都必须走这里，多余空白不留。
function fitHeight(node) {
    const h = node.computeSize()[1];
    node.setSize([node.size[0], h]);
}

// ── 默认值快照：⟳ 的「默认」取节点创建时各 widget 的初始值 ──
function snapshotDefaults(node) {
    node._bzLvDefaults = {};
    for (const w of node.widgets || []) node._bzLvDefaults[w.name] = w.value;
}

function needResetIcon(node, w) {
    const def = node._bzLvDefaults?.[w.name];
    return def !== undefined && w.value !== def && typeof w.last_y === "number";
}

function drawResetIcons(node, ctx) {
    if (node.flags?.collapsed) return;
    const litegraph = window.LiteGraph;
    const color = litegraph?.WIDGET_OUTLINE_COLOR || "#888888";
    for (const w of node.widgets || []) {
        if (!needResetIcon(node, w)) continue;
        const cy = w.last_y + WIDGET_H / 2;
        const cx = node.size[0] - 15 - ICON_X;
        ctx.strokeStyle = color;
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(cx, cy, 4, Math.PI * 1.5, Math.PI);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(cx, cy - 1.5);
        ctx.lineTo(cx, cy - 6.5);
        ctx.lineTo(cx - 4, cy - 3.5);
        ctx.fill();
    }
}

function hitReset(node, pos) {
    if (node.flags?.collapsed) return false;
    for (const w of node.widgets || []) {
        if (!needResetIcon(node, w)) continue;
        if (pos.y < w.last_y || pos.y > w.last_y + WIDGET_H) continue;
        if (pos.x < node.size[0] - 15 - ICON_X - 8 || pos.x > node.size[0] - 6) continue;
        w.value = node._bzLvDefaults[w.name];
        // 走 callback 让联动逻辑（预览刷新等）照常触发
        w.callback?.(w.value, app.canvas, node, { target: null });
        app.canvas.setDirtyCanvas(true, true);   // 铁律：全量重绘
        return true;
    }
    return false;
}

// ── 视频预览窗：DOM widget + <video>，computeSize 按宽高比动态算高 ──
function addPreview(node) {
    const wrap = document.createElement("div");
    wrap.style.width = "100%";
    const video = document.createElement("video");
    video.controls = false;
    video.loop = true;
    video.muted = true;
    video.autoplay = true;
    video.style.width = "100%";
    video.style.display = "block";
    wrap.appendChild(video);

    const wgt = node.addDOMWidget("🎬 视频预览", "preview", wrap, {
        serialize: false,
        hideOnZoom: false,
    });
    wgt.computeSize = function (width) {
        if (wgt._ratio) {
            const h = (node.size[0] - 20) / wgt._ratio + 10;
            return [width, h > 0 ? h : 0];
        }
        return [width, -4];   // 无源：widget 不显示
    };
    video.addEventListener("loadedmetadata", () => {
        wgt._ratio = video.videoWidth / video.videoHeight || 16 / 9;
        fitHeight(node);
        app.canvas.setDirtyCanvas(true, true);
    });
    video.addEventListener("error", () => {
        wgt._ratio = 0;
        fitHeight(node);
    });
    // 事件透传给画布：预览区上的点击/拖拽/滚轮仍归节点操作，不被 DOM 吃掉
    for (const [ev, cb] of [
        ["pointerdown", "_mousedown_callback"],
        ["pointerup", "_mouseup_callback"],
        ["pointermove", "_mousemove_callback"],
        ["mousewheel", "_mousewheel_callback"],
    ]) {
        wrap.addEventListener(ev, (e) => {
            e.preventDefault();
            const fn = app.canvas[cb];
            if (fn) return fn.call(app.canvas, e);
        }, true);
    }
    wrap.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        app.canvas._mousedown_callback?.(e);
    }, true);

    node._bzPreview = { wgt, video };
}

function clearPreview(node) {
    const p = node._bzPreview;
    if (!p) return;
    p.wgt._ratio = 0;
    p.video.removeAttribute("src");
    p.video.load();
    fitHeight(node);
}

function updatePreview(node) {
    if (!node._bzPreview) return;
    const 下拉 = node.widgets.find((x) => x.name === "📁 视频文件");
    const 路径 = node.widgets.find((x) => x.name === "✍️ 或填完整路径");
    const file = 下拉?.value;
    const manual = (路径?.value || "").trim();
    // /view 只服务 input 目录：手填绝对路径预览不了（VHS 同限制），隐藏预览区
    if (manual || !file || file === "无") {
        clearPreview(node);
        return;
    }
    const { wgt, video } = node._bzPreview;
    const url = buildInputURL(file);
    if (video.src !== url) {
        video.src = url;
        video.play?.().catch(() => {});
    }
}

// ── 上传按钮：走 ComfyUI 原生 /upload/image，成功后进下拉并预览 ──
function addUploadButton(node) {
    const btn = document.createElement("button");
    btn.textContent = "📤 选择视频上传";
    btn.style.cssText = "width:100%;box-sizing:border-box;margin:2px 0;padding:5px 0;" +
        "background:#2a2d33;color:#dcdcdc;border:1px solid #3a3d45;border-radius:6px;" +
        "cursor:pointer;font-size:12px;font-family:inherit";
    btn.onmouseenter = () => { btn.style.borderColor = "#4a9eff"; };
    btn.onmouseleave = () => { btn.style.borderColor = "#3a3d45"; };

    const fileInput = document.createElement("input");
    fileInput.type = "file";
    fileInput.accept = "video/*";
    fileInput.style.display = "none";
    btn.onclick = () => fileInput.click();
    fileInput.onchange = async () => {
        const file = fileInput.files?.[0];
        if (!file) return;
        btn.disabled = true;
        btn.textContent = "上传中…";
        try {
            const fd = new FormData();
            fd.append("image", file);
            fd.append("type", "input");
            fd.append("overwrite", "0");
            const res = await api.fetchApi("/upload/image", { method: "POST", body: fd });
            const data = await res.json();
            if (!data?.name) throw new Error(data?.error || "服务端未返回文件名");
            const 下拉 = node.widgets.find((x) => x.name === "📁 视频文件");
            if (下拉) {
                if (!下拉.options.values.includes(data.name)) 下拉.options.values.push(data.name);
                下拉.value = data.name;
                下拉.callback?.(下拉.value, app.canvas, node, { target: null });
            }
            updatePreview(node);
        } catch (err) {
            alert("视频上传失败：" + (err.message || err));
        } finally {
            btn.disabled = false;
            btn.textContent = "📤 选择视频上传";
            fileInput.value = "";
        }
    };
    const wgt = node.addDOMWidget("📤 选择视频上传", "button", btn, { serialize: false });
    wgt.computeSize = () => [node.size[0], 34];
}

app.registerExtension({
    name: "banzhang.load_video.ui",
    beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== "BanzhangLoadVideo") return;

        chainCallback(nodeType.prototype, "onNodeCreated", function () {
            snapshotDefaults(this);
            addUploadButton(this);
            addPreview(this);
            // 下拉/路径变化 → 刷新预览
            for (const name of ["📁 视频文件", "✍️ 或填完整路径"]) {
                const w = this.widgets.find((x) => x.name === name);
                if (w) chainCallback(w, "callback", () => updatePreview(this));
            }
        });

        // 刷新（configure）恢复后：预览按保存值重建，高度重算（铁律）
        chainCallback(nodeType.prototype, "onConfigure", function () {
            updatePreview(this);
            fitHeight(this);
        });

        chainCallback(nodeType.prototype, "onDrawForeground", function (ctx) {
            drawResetIcons(this, ctx);
        });

        // ⟳ 点击命中要在拖拽判定之前消费掉
        const prevDown = nodeType.prototype.onMouseDown;
        nodeType.prototype.onMouseDown = function (e, pos, canvas) {
            if (hitReset(this, pos)) return true;
            return prevDown?.apply(this, arguments);
        };
    },
});
