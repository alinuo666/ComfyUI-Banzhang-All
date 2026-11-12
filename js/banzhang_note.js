import { app } from "../../scripts/app.js";

// ═══════════════════════════════════════════════
//  注释 · Note（虚拟节点，仅前端实现）
//  合并自 Goohaitools-comfyui 的孤海注释
// ═══════════════════════════════════════════════

const _FIXED_FONT = 'Inter, Arial, sans-serif';

// ───────────────────────────────────────────────
//  序列化安全清理
//  LiteGraph 原生 serialize 对节点上的扩展属性有 safeCloneExtensionValue 保护
//  （克隆失败即丢弃非序列化负载）。本节点覆盖了 serialize()，若直接浅拷贝
//  properties，会把扩展运行时注入的对象（含函数引用）带进快照 —— ComfyUI
//  还原工作流时 structuredClone 抛 DataCloneError，整个 UI 工作流加载失败，
//  前端回退成 API 格式加载（分组框丢失、节点自动堆叠）。
//  这里做同等清理：函数/循环引用/非法数值直接丢弃，嵌套结构逐键递归，
//  保证输出的 properties 一定可被结构化克隆。
// ───────────────────────────────────────────────
const JSON_SAFE_MAX_DEPTH = 8;

function jsonSafeDeep(value, depth = 0, seen = new WeakSet()) {
    if (value === null) return null;

    const t = typeof value;
    if (t === 'string' || t === 'boolean') return value;
    if (t === 'number') return Number.isFinite(value) ? value : null;   // NaN/Infinity 与 JSON 保持一致
    if (t !== 'object') return undefined;                                // function / symbol / undefined → 丢弃
    if (depth >= JSON_SAFE_MAX_DEPTH) return undefined;
    if (seen.has(value)) return undefined;                               // 循环引用 → 丢弃
    seen.add(value);

    if (Array.isArray(value)) {
        const out = [];
        for (const item of value) {
            const s = jsonSafeDeep(item, depth + 1, seen);
            out.push(s === undefined ? null : s);
        }
        return out;
    }

    const out = {};
    for (const [k, v] of Object.entries(value)) {
        const s = jsonSafeDeep(v, depth + 1, seen);
        if (s !== undefined) out[k] = s;
    }
    return out;
}

let _cachedComfyFont = null;
let _cachedFontTime = 0;
const FONT_CACHE_TTL = 3000;

function getComfyUIFont() {
    const now = Date.now();
    if (_cachedComfyFont && (now - _cachedFontTime) < FONT_CACHE_TTL) return _cachedComfyFont;
    _cachedComfyFont = _FIXED_FONT;
    _cachedFontTime = now;
    return _cachedComfyFont;
}

class TextEditorBaseNode extends LGraphNode {
    constructor(title) {
        super(title);
        this.serialize_widgets = true;
        this.isVirtualNode = true;
        this.class_type = this.constructor.type;
        this.type = this.constructor.type;
        this.pos = [0, 0];
    }

    static setUp() {
        if (!this.registered) {
            LiteGraph.registerNodeType(this.type, this);
            this.registered = true;
        }
    }

    configure(info) {
        if (info.properties) Object.assign(this.properties, info.properties);
        if (info.pos) this.pos = info.pos;
        if (info.size) this.size = info.size;
        if (info.flags) this.flags = info.flags;
    }

    serialize() {
        const data = super.serialize();
        if (!data.id && this.id) data.id = this.id;
        if (!data.order && this.order !== undefined) data.order = this.order;
        if (!data.mode && this.mode !== undefined) data.mode = this.mode;
        // 走 JSON 安全清理，避免扩展注入的运行时对象进入快照（详见 jsonSafeDeep 说明）
        data.properties = jsonSafeDeep(this.properties) || {};
        if (!data.pos && this.pos) data.pos = [...this.pos];
        if (!data.size && this.size) data.size = [...this.size];
        if (!data.flags && this.flags) data.flags = { ...this.flags };
        return data;
    }
}

class TextEditorNode extends TextEditorBaseNode {

    constructor(title) {
        super(title);
        this.isBanzhangNote = true;
        this._cache = null;
        this.flags = this.flags || {};
        this.flags.allow_interaction = !this.flags.pinned;
        this.properties = {
            text: "双击编辑文本内容...",
            fontSize: 24,
            fontColor: "#C8C8C8",
            backgroundColor: "#1B4669",
            backgroundAlpha: 0.25,
            borderRadius: 20,
            padding: 12,
            lineHeight: 1.4,
            textAlign: "center",
            stroke: true
        };
        this.resizable = true;
        this.size = [360, 100];
        this.color = "#fff0";
        this.bgcolor = "transparent";
        this.isEditing = false;
        this.editTextarea = null;
    }

    buildUnits(ctx, text, maxWidth, lineHeight) {
        const fs = this.properties.fontSize;
        const pad = this.properties.padding;
        const fcolor = this.properties.fontColor;
        const align = this.properties.textAlign;
        const font = fs + "px " + getComfyUIFont();

        ctx.textBaseline = "top";
        ctx.textAlign = "left";
        ctx.font = font;

        // 统一换行符 → 按行拆分 → 按宽度做简单整字换行
        const rawLines = text
            .replace(/\\n/g, "\n")
            .replace(/\r\n/g, "\n")
            .replace(/\r/g, "\n")
            .split("\n");

        const lines = [];
        for (const raw of rawLines) {
            if (raw === "") { lines.push(""); continue; }
            let cur = "";
            let curW = 0;
            for (const ch of raw) {
                const cw = ctx.measureText(ch).width;
                if (cur && curW + cw > maxWidth) {
                    lines.push(cur);
                    cur = ch;
                    curW = cw;
                } else {
                    cur += ch;
                    curW += cw;
                }
            }
            lines.push(cur);
        }

        return lines.map((ln) => ({
            h: lineHeight,
            draw: (y) => {
                ctx.textAlign = "left";
                ctx.textBaseline = "top";
                ctx.font = font;
                ctx.fillStyle = fcolor;
                const w = ctx.measureText(ln).width;
                let x = pad;
                if (align === "right") x = this.size[0] - pad - w;
                else if (align === "center") x = (this.size[0] - w) / 2;
                ctx.fillText(ln, x, y);
            }
        }));
    }

    createTextEditor() {
        if (this.editTextarea) this.removeTextEditor();

        _cachedFontTime = 0;

        const canvas = LGraphCanvas.active_canvas;
        const rect = canvas.canvas.getBoundingClientRect();
        const ox = (this.pos[0] + canvas.ds.offset[0]) * canvas.ds.scale;
        const oy = (this.pos[1] + canvas.ds.offset[1]) * canvas.ds.scale;

        const TOOLBAR_OFFSET = 210;

        this.editToolbar = document.createElement("div");
        Object.assign(this.editToolbar.style, {
            position: "absolute",
            left: rect.left + ox + "px",
            top: rect.top + oy - TOOLBAR_OFFSET + "px",
            width: "373px", display: "flex", flexDirection: "column",
            gap: "8px", zIndex: "1001", fontSize: "12px", color: "#ffffff"
        });

        const alignRow = document.createElement("div");
        Object.assign(alignRow.style, { display: "flex", alignItems: "center", gap: "8px" });
        const alignLabel = document.createElement("span");
        alignLabel.textContent = "对齐:";
        alignLabel.style.minWidth = "32px";
        alignLabel.style.fontSize = "13px";
        alignRow.appendChild(alignLabel);

        this.alignButtons = {};
        [
            { key: "left", symbol: "⬅" },
            { key: "center", symbol: "⬌" },
            { key: "right", symbol: "➡" }
        ].forEach((opt) => {
            const btn = document.createElement("button");
            btn.textContent = opt.symbol;
            Object.assign(btn.style, {
                width: "28px", height: "24px", border: "1px solid #666",
                borderRadius: "3px", cursor: "pointer", fontSize: "12px",
                backgroundColor: this.properties.textAlign === opt.key ? "#459BAC" : "#444",
                color: "#fff", display: "flex", alignItems: "center", justifyContent: "center"
            });
            btn.addEventListener("click", () => {
                this.properties.textAlign = opt.key;
                this.updateAlignButtons();
                app.graph.setDirtyCanvas(true);
            });
            this.alignButtons[opt.key] = btn;
            alignRow.appendChild(btn);
        });

        const strokeCtrl = document.createElement("div");
        Object.assign(strokeCtrl.style, {
            display: "flex", alignItems: "center", gap: "4px",
            marginLeft: "auto",
            marginRight: "2px"
        });

        this.strokeCheckbox = document.createElement("input");
        this.strokeCheckbox.type = "checkbox";
        this.strokeCheckbox.checked = !!this.properties.stroke;
        Object.assign(this.strokeCheckbox.style, {
            width: "19.5px",
            height: "19.5px",
            cursor: "pointer",
            accentColor: "#459BAC"
        });
        this.strokeCheckbox.addEventListener("change", (e) => {
            this.properties.stroke = e.target.checked;
            app.graph.setDirtyCanvas(true);
        });
        strokeCtrl.appendChild(this.strokeCheckbox);

        const strokeLabel = document.createElement("span");
        strokeLabel.textContent = "：描边";
        Object.assign(strokeLabel.style, { fontSize: "13px", userSelect: "none", cursor: "pointer" });
        strokeLabel.addEventListener("click", () => {
            this.strokeCheckbox.checked = !this.strokeCheckbox.checked;
            this.properties.stroke = this.strokeCheckbox.checked;
            app.graph.setDirtyCanvas(true);
        });
        strokeCtrl.appendChild(strokeLabel);

        alignRow.appendChild(strokeCtrl);
        this.editToolbar.appendChild(alignRow);

        const textRow = document.createElement("div");
        Object.assign(textRow.style, { display: "flex", alignItems: "center", gap: "8px" });

        const txtLbl = document.createElement("span");
        txtLbl.textContent = "文本:";
        txtLbl.style.minWidth = "32px";
        txtLbl.style.fontSize = "13px";
        textRow.appendChild(txtLbl);

        this.textColorPicker = document.createElement("input");
        this.textColorPicker.type = "color";
        this.textColorPicker.value = this.properties.fontColor;
        Object.assign(this.textColorPicker.style, { width: "56px", height: "24px", border: "none", borderRadius: "3px", cursor: "pointer" });
        this.textColorPicker.addEventListener("change", (e) => {
            this.properties.fontColor = e.target.value;
            this.updateTextareaStyle();
            app.graph.setDirtyCanvas(true);
        });
        textRow.appendChild(this.textColorPicker);

        const textSpacer = document.createElement("div");
        Object.assign(textSpacer.style, { width: "28px", flexShrink: "0", flexGrow: "0" });
        textRow.appendChild(textSpacer);

        const sizeLbl = document.createElement("span");
        sizeLbl.textContent = "大小:";
        sizeLbl.style.fontSize = "13px";
        textRow.appendChild(sizeLbl);

        this.fontSizeSlider = document.createElement("input");
        this.fontSizeSlider.type = "range";
        this.fontSizeSlider.min = "8";
        this.fontSizeSlider.max = "200";
        this.fontSizeSlider.value = this.properties.fontSize;
        Object.assign(this.fontSizeSlider.style, { flex: "1", height: "20px" });
        this.fontSizeSlider.addEventListener("input", (e) => {
            this.properties.fontSize = parseInt(e.target.value);
            this.fontSizeValue.textContent = this.properties.fontSize;
            this.updateTextareaStyle();
            app.graph.setDirtyCanvas(true);
        });
        textRow.appendChild(this.fontSizeSlider);

        this.fontSizeValue = document.createElement("span");
        this.fontSizeValue.textContent = this.properties.fontSize;
        Object.assign(this.fontSizeValue.style, { fontSize: "12px", minWidth: "25px", textAlign: "right" });
        textRow.appendChild(this.fontSizeValue);
        this.editToolbar.appendChild(textRow);

        const bgRow = document.createElement("div");
        Object.assign(bgRow.style, { display: "flex", alignItems: "center", gap: "8px" });

        const bgLbl = document.createElement("span");
        bgLbl.textContent = "背景:";
        bgLbl.style.minWidth = "32px";
        bgLbl.style.fontSize = "13px";
        bgRow.appendChild(bgLbl);

        this.bgColorPicker = document.createElement("input");
        this.bgColorPicker.type = "color";
        this.bgColorPicker.value = this.properties.backgroundColor;
        Object.assign(this.bgColorPicker.style, { width: "56px", height: "24px", border: "none", borderRadius: "3px", cursor: "pointer" });
        this.bgColorPicker.addEventListener("change", (e) => {
            this.properties.backgroundColor = e.target.value;
            this.updateTextareaStyle();
            app.graph.setDirtyCanvas(true);
        });
        bgRow.appendChild(this.bgColorPicker);

        const bgSpacer = document.createElement("div");
        Object.assign(bgSpacer.style, { width: "28px", flexShrink: "0", flexGrow: "0" });
        bgRow.appendChild(bgSpacer);

        const alphaLbl = document.createElement("span");
        alphaLbl.textContent = "透明:";
        alphaLbl.style.fontSize = "13px";
        bgRow.appendChild(alphaLbl);

        this.alphaSlider = document.createElement("input");
        this.alphaSlider.type = "range";
        this.alphaSlider.min = "0";
        this.alphaSlider.max = "1";
        this.alphaSlider.step = "0.05";
        this.alphaSlider.value = this.properties.backgroundAlpha;
        Object.assign(this.alphaSlider.style, { flex: "1", height: "20px" });
        this.alphaSlider.addEventListener("input", (e) => {
            this.properties.backgroundAlpha = parseFloat(e.target.value);
            this.alphaValue.textContent = Math.round(100 * this.properties.backgroundAlpha) + "%";
            this.updateTextareaStyle();
            app.graph.setDirtyCanvas(true);
        });
        bgRow.appendChild(this.alphaSlider);

        this.alphaValue = document.createElement("span");
        this.alphaValue.textContent = Math.round(100 * this.properties.backgroundAlpha) + "%";
        Object.assign(this.alphaValue.style, { fontSize: "12px", minWidth: "25px", textAlign: "right" });
        bgRow.appendChild(this.alphaValue);
        this.editToolbar.appendChild(bgRow);

        const radiusRow = document.createElement("div");
        Object.assign(radiusRow.style, { display: "flex", alignItems: "center", gap: "8px" });
        const radiusLbl = document.createElement("span");
        radiusLbl.textContent = "圆角:";
        radiusLbl.style.minWidth = "32px";
        radiusLbl.style.fontSize = "13px";
        radiusRow.appendChild(radiusLbl);

        this.borderRadiusSlider = document.createElement("input");
        this.borderRadiusSlider.type = "range";
        this.borderRadiusSlider.min = "0";
        this.borderRadiusSlider.max = "300";
        this.borderRadiusSlider.value = this.properties.borderRadius;
        Object.assign(this.borderRadiusSlider.style, { flex: "1", height: "20px" });
        this.borderRadiusSlider.addEventListener("input", (e) => {
            this.properties.borderRadius = parseInt(e.target.value);
            this.borderRadiusValue.textContent = this.properties.borderRadius;
            app.graph.setDirtyCanvas(true);
        });
        radiusRow.appendChild(this.borderRadiusSlider);

        this.borderRadiusValue = document.createElement("span");
        this.borderRadiusValue.textContent = this.properties.borderRadius;
        Object.assign(this.borderRadiusValue.style, { fontSize: "12px", minWidth: "25px", textAlign: "right" });
        radiusRow.appendChild(this.borderRadiusValue);
        this.editToolbar.appendChild(radiusRow);

        const lhRow = document.createElement("div");
        Object.assign(lhRow.style, { display: "flex", alignItems: "center", gap: "8px" });
        const lhLbl = document.createElement("span");
        lhLbl.textContent = "行距:";
        lhLbl.style.minWidth = "32px";
        lhLbl.style.fontSize = "13px";
        lhRow.appendChild(lhLbl);

        this.lineHeightSlider = document.createElement("input");
        this.lineHeightSlider.type = "range";
        this.lineHeightSlider.min = "0.8";
        this.lineHeightSlider.max = "3.0";
        this.lineHeightSlider.step = "0.1";
        this.lineHeightSlider.value = this.properties.lineHeight;
        Object.assign(this.lineHeightSlider.style, { flex: "1", height: "20px" });
        this.lineHeightSlider.addEventListener("input", (e) => {
            this.properties.lineHeight = parseFloat(e.target.value);
            this.lineHeightValue.textContent = this.properties.lineHeight.toFixed(1);
            app.graph.setDirtyCanvas(true);
        });
        lhRow.appendChild(this.lineHeightSlider);

        this.lineHeightValue = document.createElement("span");
        this.lineHeightValue.textContent = this.properties.lineHeight.toFixed(1);
        Object.assign(this.lineHeightValue.style, { fontSize: "12px", minWidth: "25px", textAlign: "right" });
        lhRow.appendChild(this.lineHeightValue);
        this.editToolbar.appendChild(lhRow);

        document.body.appendChild(this.editToolbar);

        this.editTextarea = document.createElement("textarea");
        this.editTextarea.value = this.properties.text;
        Object.assign(this.editTextarea.style, {
            position: "absolute",
            left: rect.left + ox + this.properties.padding * canvas.ds.scale + "px",
            top: rect.top + oy + 10 * canvas.ds.scale + "px",
            width: (this.size[0] - 2 * this.properties.padding) * canvas.ds.scale + "px",
            height: (this.size[1] - 20) * canvas.ds.scale + "px",
            fontFamily: getComfyUIFont(),
            border: "none", borderRadius: "0px", outline: "none",
            resize: "none", padding: "0px", boxSizing: "border-box",
            zIndex: "1000", textAlign: this.properties.textAlign
        });
        this.updateTextareaStyle();
        document.body.appendChild(this.editTextarea);
        this.editTextarea.focus();
        this.editTextarea.select();

        const saveAndClose = () => {
            this.properties.text = this.editTextarea.value;
            this.removeTextEditor();
            this.setDirtyCanvas(true, true);
            app.graph.setDirtyCanvas(true);
        };

        this.updateEditorsPosition = () => {
            if (!this.editTextarea || !this.editToolbar) return;
            const c = LGraphCanvas.active_canvas;
            const r = c.canvas.getBoundingClientRect();
            const ox2 = (this.pos[0] + c.ds.offset[0]) * c.ds.scale;
            const oy2 = (this.pos[1] + c.ds.offset[1]) * c.ds.scale;
            Object.assign(this.editTextarea.style, {
                left: r.left + ox2 + this.properties.padding * c.ds.scale + "px",
                top: r.top + oy2 + 10 * c.ds.scale + "px",
                width: (this.size[0] - 2 * this.properties.padding) * c.ds.scale + "px",
                height: (this.size[1] - 20) * c.ds.scale + "px"
            });
            Object.assign(this.editToolbar.style, {
                left: r.left + ox2 + "px",
                top: r.top + oy2 - TOOLBAR_OFFSET + "px"
            });
            this.updateTextareaStyle();
        };

        const origOCC = canvas.onCanvasChanged;
        canvas.onCanvasChanged = (evt) => {
            origOCC && origOCC.call(canvas, evt);
            this.updateEditorsPosition();
        };
        this.canvasUpdateInterval = setInterval(() => this.updateEditorsPosition(), 16);

        this.editTextarea.addEventListener("keydown", (e) => {
            if ("Escape" === e.key) {
                this.removeTextEditor();
            } else if ("Enter" === e.key && (e.ctrlKey || e.metaKey)) {
                saveAndClose();
            }
            e.stopPropagation();
        });

        this.clickCount = 0;
        this.documentClickHandler = (e) => {
            this.clickCount++;
            setTimeout(() => {
                this.clickCount--;
                if (this.clickCount === 0 && this.editTextarea && this.editToolbar &&
                    !this.editTextarea.contains(e.target) &&
                    !this.editToolbar.contains(e.target) && this.isEditing) {
                    saveAndClose();
                }
            }, 300);
        };
        setTimeout(() => {
            if (this.isEditing) document.addEventListener("click", this.documentClickHandler, true);
        }, 200);

        this.editTextarea.addEventListener("blur", () => {
            setTimeout(() => {
                if (this.editToolbar && this.editTextarea &&
                    !this.editToolbar.contains(document.activeElement) &&
                    document.activeElement !== this.editTextarea) {
                    saveAndClose();
                }
            }, 100);
        });

        this.isEditing = true;
    }

    updateTextareaStyle() {
        if (!this.editTextarea) return;
        const s = LGraphCanvas.active_canvas.ds.scale;
        Object.assign(this.editTextarea.style, {
            fontSize: this.properties.fontSize * s + "px",
            fontFamily: getComfyUIFont(),
            color: this.properties.fontColor,
            backgroundColor: this.hexToRGBA(this.properties.backgroundColor, this.properties.backgroundAlpha),
            textAlign: this.properties.textAlign,
            lineHeight: this.properties.lineHeight,
            paddingTop: "2px", paddingLeft: "0px", paddingRight: "0px", paddingBottom: "0px",
            boxSizing: "border-box"
        });
    }

    updateAlignButtons() {
        Object.keys(this.alignButtons).forEach((k) => {
            this.alignButtons[k].style.backgroundColor = this.properties.textAlign === k ? "#459BAC" : "#444";
        });
    }

    removeTextEditor() {
        if (this.editTextarea) { document.body.removeChild(this.editTextarea); this.editTextarea = null; }
        if (this.editToolbar) { document.body.removeChild(this.editToolbar); this.editToolbar = null; }
        if (this.canvasUpdateInterval) { clearInterval(this.canvasUpdateInterval); this.canvasUpdateInterval = null; }
        if (this.documentClickHandler) { document.removeEventListener("click", this.documentClickHandler, true); this.documentClickHandler = null; }
        this.isEditing = false;
    }

    onDrawBackground(ctx) {
        ctx.save();
        ctx.imageSmoothingEnabled = true;

        const r = this.properties.borderRadius;
        const fs = this.properties.fontSize;
        const pad = this.properties.padding;
        const lh = Math.round(fs * this.properties.lineHeight);
        const mw = this.size[0] - 2 * pad;

        // 内容布局 + 高度自适应（结果缓存，避免每帧重复解析/测量）
        let units = null;
        if (!this.isEditing) {
            const key = this.properties.text + "\u0001" + this.size[0] + "\u0001" + fs + "\u0001" + pad + "\u0001" + this.properties.lineHeight + "\u0001" + this.properties.textAlign;
            if (!this._cache || this._cache.key !== key || this._cache.ctx !== ctx) {
                const built = this.buildUnits(ctx, this.properties.text, mw, lh) || [];
                let totalH = 0;
                for (const u of built) totalH += u.h;
                this._cache = { key, ctx, units: built, totalH };
            }
            const newH = Math.max(100, Math.ceil(this._cache.totalH + pad * 2 + 6));
            if (Math.abs(newH - this.size[1]) > 0.5) this.size[1] = newH;
            units = this._cache.units;
        }

        ctx.beginPath();
        ctx.roundRect(0, 0, this.size[0], this.size[1], r);
        ctx.fillStyle = this.hexToRGBA(this.properties.backgroundColor, this.properties.backgroundAlpha);
        ctx.fill();

        if (this.properties.stroke) {
            const bgHex = this.properties.backgroundColor;
            const sr = Math.min(parseInt(bgHex.slice(1, 3), 16) + 80, 255);
            const sg = Math.min(parseInt(bgHex.slice(3, 5), 16) + 80, 255);
            const sb = Math.min(parseInt(bgHex.slice(5, 7), 16) + 80, 255);

            ctx.beginPath();
            ctx.roundRect(0.5, 0.5, this.size[0] - 1, this.size[1] - 1, Math.max(r - 0.5, 0));
            ctx.strokeStyle = "rgba(" + sr + "," + sg + "," + sb + "," + this.properties.backgroundAlpha + ")";
            ctx.lineWidth = 1;
            ctx.stroke();
        }

        if (this.isEditing) {
            ctx.beginPath();
            ctx.roundRect(0, 0, this.size[0], this.size[1], r);
            ctx.strokeStyle = "#4CAF50";
            ctx.lineWidth = 2;
            ctx.stroke();
        }

        if (units && units.length) {
            let y = pad;
            for (const u of units) { u.draw(y); y += u.h; }
        }

        ctx.restore();
    }

    hexToRGBA(hex, alpha) {
        return "rgba(" +
            parseInt(hex.slice(1, 3), 16) + ", " +
            parseInt(hex.slice(3, 5), 16) + ", " +
            parseInt(hex.slice(5, 7), 16) + ", " +
            alpha + ")";
    }

    draw(ctx) {
        this.flags = this.flags || {};
        this.flags.allow_interaction = !this.flags.pinned;
        this.onDrawBackground(ctx);
    }

    onPropertyChanged(name, value) {
        if (this.isEditing) {
            if ("fontSize" === name && this.fontSizeSlider) {
                this.fontSizeSlider.value = value;
                this.fontSizeValue.textContent = value;
            } else if ("fontColor" === name && this.textColorPicker) {
                this.textColorPicker.value = value;
            } else if ("backgroundColor" === name && this.bgColorPicker) {
                this.bgColorPicker.value = value;
            } else if ("backgroundAlpha" === name && this.alphaSlider) {
                this.alphaSlider.value = value;
                this.alphaValue.textContent = Math.round(100 * value) + "%";
            } else if ("lineHeight" === name && this.lineHeightSlider) {
                this.lineHeightSlider.value = value;
                this.lineHeightValue.textContent = value.toFixed(1);
            } else if ("textAlign" === name && this.alignButtons) {
                this.updateAlignButtons();
            } else if ("borderRadius" === name && this.borderRadiusSlider) {
                this.borderRadiusSlider.value = value;
                this.borderRadiusValue.textContent = value;
            } else if ("stroke" === name && this.strokeCheckbox) {
                this.strokeCheckbox.checked = !!value;
            }
            this.updateTextareaStyle();
        }
        this.setDirtyCanvas(true, true);
        app.graph.setDirtyCanvas(true);
    }

    onDblClick() {
        if (!this.isEditing) this.createTextEditor();
    }

    onResize(size) {
        if (size && Array.isArray(size) && size.length >= 2) {
            this.size[0] = Math.max(size[0], 5);
            this.size[1] = Math.max(size[1], 5);
            app.graph.setDirtyCanvas(true);
        }
    }

    getExtraMenuOptions(node, options) {
        options.unshift({
            content: "编辑文本",
            callback: () => this.createTextEditor()
        });
        options.push({
            content: "固定节点",
            callback: () => {
                this.flags.pinned = !this.flags.pinned;
                this.flags.allow_interaction = !this.flags.pinned;
            }
        });
    }

    onShowCustomPanelInfo(panel) {
        panel.querySelector('div.property[data-property="Mode"]')?.remove();
        panel.querySelector('div.property[data-property="Color"]')?.remove();
    }

    onRemoved() {
        this.removeTextEditor();
    }
}

TextEditorNode.type = "注释";
TextEditorNode.title = "注释";
TextEditorNode.category = "👨‍🏫班长/工具";
TextEditorNode.title_mode = LiteGraph.NO_TITLE;
TextEditorNode.collapsable = false;

TextEditorNode["@text"] = { type: "string", title: "文本内容", default: "双击编辑文本内容...", multiline: true };
TextEditorNode["@fontSize"] = { type: "number", title: "字体大小", default: 24, min: 8, max: 200, step: 1 };
TextEditorNode["@fontColor"] = { type: "color", title: "字体颜色", default: "#C8C8C8" };
TextEditorNode["@backgroundColor"] = { type: "color", title: "背景颜色", default: "#1B4669" };
TextEditorNode["@backgroundAlpha"] = { type: "number", title: "背景透明度", default: 0.25, min: 0, max: 1, step: 0.05 };
TextEditorNode["@borderRadius"] = { type: "number", title: "圆角", default: 20, min: 0, max: 300, step: 1 };
TextEditorNode["@padding"] = { type: "number", title: "内边距", default: 12, min: 0, max: 50, step: 1 };
TextEditorNode["@lineHeight"] = { type: "number", title: "行距", default: 1.4, min: 0.8, max: 3, step: 0.1 };
TextEditorNode["@textAlign"] = { type: "combo", title: "对齐方式", values: ["left", "center", "right"], default: "center" };
TextEditorNode["@stroke"] = { type: "boolean", title: "描边", default: true };

// ═══════════════════════════════════════════════
// 后端桩 (banzhang_note.py) 提供节点定义以归入班长节点包；
// 前端行为通过 beforeRegisterNodeDef 合并到 def 注册的类上，
// 不再整体替换注册类（替换会丢失 nodeData/comfyClass，导致前端不渲染节点体）
// ═══════════════════════════════════════════════

function initNoteNode(n) {
    n.flags = n.flags || {};
    n.flags.allow_interaction = !n.flags.pinned;
    n.properties = Object.assign({
        text: "双击编辑文本内容...",
        fontSize: 24,
        fontColor: "#C8C8C8",
        backgroundColor: "#1B4669",
        backgroundAlpha: 0.25,
        borderRadius: 20,
        padding: 12,
        lineHeight: 1.4,
        textAlign: "center",
        stroke: true
    }, n.properties || {});
    n.resizable = true;
    if (!n.size || !n.size[0]) n.size = [360, 100];
    n.color = "#fff0";
    n.bgcolor = "transparent";
    n.serialize_widgets = true;
    n.isVirtualNode = true;
    n.isEditing = false;
    n.editTextarea = null;
    n._cache = null;
    n.isBanzhangNote = true;
}

function applyNoteBehavior(nodeType) {
    for (const proto of [TextEditorNode.prototype, TextEditorBaseNode.prototype]) {
        for (const k of Object.getOwnPropertyNames(proto)) {
            if (k !== "constructor") {
                Object.defineProperty(nodeType.prototype, k, Object.getOwnPropertyDescriptor(proto, k));
            }
        }
    }
    for (const k of Object.keys(TextEditorNode)) {
        if (k.startsWith("@")) nodeType[k] = TextEditorNode[k];
    }
    nodeType.title_mode = LiteGraph.NO_TITLE;
    nodeType.collapsable = false;
    nodeType.isBanzhangNote = true;

    const baseCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
        const r = baseCreated ? baseCreated.apply(this, arguments) : undefined;
        initNoteNode(this);
        return r;
    };
}

const _origDrawNode = LGraphCanvas.prototype.drawNode;
LGraphCanvas.prototype.drawNode = function (node, ctx) {
    if (node.isBanzhangNote) {
        node.bgcolor = "transparent";
        node.color = "#fff0";
        const result = _origDrawNode.apply(this, arguments);
        node.onDrawBackground(ctx);
        return result;
    }
    return _origDrawNode.apply(this, arguments);
};

const mouseState = { processingMouseDown: false, lastMouseEvent: null };

const _origGNOP = LGraph.prototype.getNodeOnPos;
LGraph.prototype.getNodeOnPos = function (x, y, nodes, margin) {
    if (nodes) {
        const recent = LiteGraph.getTime() -
            (LGraphCanvas.active_canvas && LGraphCanvas.active_canvas.last_mouseclick
                ? LGraphCanvas.active_canvas.last_mouseclick : 0) < 300;
        if (mouseState.processingMouseDown && mouseState.lastMouseEvent &&
            mouseState.lastMouseEvent.type.includes("down") &&
            mouseState.lastMouseEvent.which === 1 && !recent) {
            nodes = [...nodes].filter(n => !(n.isBanzhangNote && n.flags && n.flags.pinned));
        }
    }
    return _origGNOP.apply(this, [x, y, nodes, margin]);
};

document.addEventListener("mousedown", function (e) {
    mouseState.processingMouseDown = true;
    mouseState.lastMouseEvent = e;
}, true);

document.addEventListener("mouseup", function () {
    mouseState.processingMouseDown = false;
}, true);

// Nodes 2.0 HTML VUE覆盖层双击穿透
document.addEventListener("dblclick", function (e) {
    const nodeBody = e.target.closest('[data-testid^="node-body-"]');
    if (!nodeBody) return;

    if (e.target.closest(
        "input, textarea, select, [contenteditable], button, a, " +
        "[role='button'], [role='slider'], [role='combobox'], " +
        ".comfy-multiline-input, .comfy-input"
    )) {
        return;
    }


    const testId = nodeBody.getAttribute("data-testid");
    const match = testId.match(/node-body-(\d+)/);
    if (!match) return;

    const nodeId = parseInt(match[1]);
    const node = app.graph?.getNodeById(nodeId);
    if (!node) return;


    if (typeof node.onDblClick === "function") {
        node.onDblClick(e);
    }
}, true);


const _dblclickFixStyle = document.createElement("style");
_dblclickFixStyle.id = "banzhang-note-fix-dblclick-style";
_dblclickFixStyle.textContent = `
    [data-testid^="node-body-"] { cursor: default !important; }
    [data-testid^="node-header-"] { cursor: grab !important; }
`;
document.head.appendChild(_dblclickFixStyle);

// ============================================

app.registerExtension({
    name: "banzhang.note",
    beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name === "注释") applyNoteBehavior(nodeType);
    },
    registerCustomNodes() {
        // 兜底：后端桩缺失时保持纯前端注册
        if (!LiteGraph.registered_node_types["注释"]) {
            TextEditorNode.setUp();
            // registerNodeType 会用 type 名的 "/" 前缀覆盖 category（"注释" 无前缀 → 置空），
            // 导致节点被前端归类到 __frontend_only__；注册后需重新赋值以归入班长/工具目录
            TextEditorNode.category = "👨‍🏫班长/工具";
        }
    }
});
