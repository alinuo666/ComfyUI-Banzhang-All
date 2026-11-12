import { app } from "../../scripts/app.js";
import { createCurveEditor, DEFAULT_POINTS } from "./banzhang_h3_dial_curve.js";

const NODE_ID = "BanZhang_H3_Dial";
const MAX_ROWS = 3;
const PUSH_LIMIT = 1.5;
const AUDIO_RANK = { "安全": 0, "注意": 1, "危险": 2 };
const GROUPS = ["常用", "进阶", "实验室"];

const CSS = `
.bzh3d-wrap{font-family:inherit;color:#d8d8d8;font-size:11px;padding:4px 6px;box-sizing:border-box}
.bzh3d-mode{display:flex;align-items:center;gap:5px;margin-bottom:4px}
.bzh3d-mode button{height:18px;padding:0 8px;border:1px solid #3a3d45;border-radius:5px;background:#444441;color:#b5d4f4;font-size:10px;font-family:inherit;cursor:pointer}
.bzh3d-mode button.bzh3d-on{background:#633806;border-color:#fac775;color:#faeeda}
.bzh3d-mode span{color:#8a8f99;font-size:10px}
.bzh3d-slot{margin-bottom:2px}
.bzh3d-row{display:flex;align-items:center;gap:5px;height:24px;margin-bottom:3px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08);border-radius:6px;padding:0 5px}
.bzh3d-row.bzh3d-off{opacity:.42}
.bzh3d-row input[type="checkbox"]{width:12px;height:12px;accent-color:#4a9eff;margin:0;flex-shrink:0;cursor:pointer}
.bzh3d-row select{flex:1.1;min-width:0;background:#22242a;color:#e8e8e8;border:1px solid #3a3d45;border-radius:5px;padding:1px 4px;font-size:11px;outline:none;cursor:pointer;font-family:inherit}
.bzh3d-slider{position:relative;flex:1;min-width:56px;display:flex;align-items:center;height:16px}
.bzh3d-slider::after{content:"";position:absolute;left:50%;top:3px;bottom:3px;width:1px;background:#6a6a6a;pointer-events:none}
.bzh3d-slider input[type="range"]{width:100%;height:14px;accent-color:#4a9eff;cursor:pointer;margin:0}
.bzh3d-val{width:40px;text-align:right;font-variant-numeric:tabular-nums;color:#b5d4f4;flex-shrink:0;font-size:11px}
.bzh3d-val.bzh3d-neg{color:#9fb6cc}
.bzh3d-val.bzh3d-hot{color:#fac775}
.bzh3d-del{width:16px;height:16px;line-height:14px;text-align:center;border:none;border-radius:4px;background:transparent;color:#ff8080;font-size:13px;cursor:pointer;flex-shrink:0;padding:0}
.bzh3d-del:hover{background:rgba(255,128,128,.15)}
.bzh3d-add{height:20px;line-height:20px;text-align:center;border:1px dashed #3a3d45;border-radius:6px;color:#9fb6cc;cursor:pointer;margin-top:2px;font-size:11px}
.bzh3d-add:hover{border-color:#4a9eff;color:#e6f1fb}
.bzh3d-full{height:20px;line-height:20px;text-align:center;color:#888780;margin-top:2px}
.bzh3d-state{margin-top:4px;padding:0 2px;line-height:1.4;color:#8a8f99;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bzh3d-state.bzh3d-warn{color:#e8a33d}
`;

function injectCss() {
    if (document.getElementById("bzh3d-style")) return;
    const el = document.createElement("style");
    el.id = "bzh3d-style";
    el.textContent = CSS;
    document.head.appendChild(el);
}

function isPro(node) { return node.properties?.h3DialPro === "专业版"; }

function catalogOf(node) {
    const w = node.widgets?.find((x) => x.name === "dial_params");
    try { return JSON.parse(w?.value || "{}").styles || []; }
    catch (e) { return []; }
}

function styleOf(styles, name) { return styles.find((s) => s.name === name); }

function defaultRow(styles) {
    // 默认 0：中性，不偏向任何一侧，后端直接透传模型。
    return { on: true, name: styles[0]?.name || "", pct: 0 };
}

// 面板状态双写：properties 存完整（含曲线），widget.value 只提交当前模式需要的字段。
function syncConfig(node) {
    const pro = isPro(node);
    const rows = (node._h3Rows || []).map((r) => {
        const o = { ...r };
        if (!pro) delete o.curve;
        return o;
    });
    const cfg = node.widgets?.find((w) => w.name === "dial_config");
    if (cfg) cfg.value = JSON.stringify(rows);
    node.properties = node.properties || {};
    node.properties["h3_dial_rows"] = JSON.stringify(node._h3Rows || []);
}

function restoreRows(node) {
    const cfg = node.widgets?.find((w) => w.name === "dial_config");
    const raw = node.properties?.["h3_dial_rows"] || cfg?.value || "[]";
    let rows = [];
    try { rows = JSON.parse(raw); } catch (e) { rows = []; }
    if (!Array.isArray(rows)) rows = [];
    rows = rows.filter((r) => r && typeof r === "object").slice(0, MAX_ROWS);
    node._h3Rows = rows.length ? rows : [defaultRow(catalogOf(node))];
}

// 隐藏原生 widget：只改 hidden/computeSize/draw/mouse，绝不改 widget.type。
function hideWidgets(node) {
    for (const name of ["dial_config", "dial_params"]) {
        const w = node.widgets?.find((x) => x.name === name);
        if (!w) continue;
        w.hidden = true;
        w.computeSize = () => [0, -4];
        w.draw = () => {};
        w.mouse = () => {};
        if (name === "dial_params") {
            w.serialize = false;
            w.options = { ...(w.options || {}), serialize: false };
        }
    }
}

// 有符号：负向用 neg_cap，正向用 pos_cap，0 时为 0。
function strengthOf(styles, row) {
    const st = styleOf(styles, row.name);
    if (!st) return 0;
    const v = (Number(row.pct) || 0) / 100;
    if (v === 0) return 0;
    return v * Number(v > 0 ? st.pos_cap : st.neg_cap);
}

function usefulOf(styles, row) {
    const st = styleOf(styles, row.name);
    if (!st) return 0;
    return Number((Number(row.pct) || 0) > 0 ? st.pos_useful : st.neg_useful) || 0;
}

function updateState(node) {
    const styles = catalogOf(node);
    const pro = isPro(node);
    // 专业版曲线自带强度，滑块为 0 也算启用。
    const rows = (node._h3Rows || []).filter((r) => r.on &&
        (Number(r.pct) !== 0 || (pro && r.curve?.points)));
    let text = "未启用任何风格，模型原样透传";
    let warn = false;
    if (rows.length) {
        const push = rows.reduce((n, r) => n +
            (pro && r.curve?.points ? 1 : Math.abs((Number(r.pct) || 0) / 100)), 0);
        const capped = push > PUSH_LIMIT;
        const audio = rows.reduce((a, r) => {
            const v = styleOf(styles, r.name)?.audio || "安全";
            return (AUDIO_RANK[v] || 0) > (AUDIO_RANK[a] || 0) ? v : a;
        }, "安全");
        const badRef = rows.some((r) => styleOf(styles, r.name)?.ref2v === "不可用");
        const hot = rows.some((r) => {
            const u = usefulOf(styles, r);
            return u > 0 && Math.abs(strengthOf(styles, r)) > u;
        });
        text = "合计推力 " + push.toFixed(2) + " / " + PUSH_LIMIT.toFixed(2);
        if (capped) text += " → 自动等比限幅";
        text += " · 音频" + audio + " · 区间" + (hot ? "注意" : "安全");
        if (badRef) text += " · 参考图模式不适用";
        warn = capped || audio === "危险" || hot || badRef;
        if (isPro(node)) {
            const n = rows.filter((r) => r.curve?.points).length;
            text += " · 曲线" + n + "路 · 约" + (1 + 0.24 * n).toFixed(2) + "× 耗时";
        }
    }
    const box = node._h3State;
    if (!box) return;
    box.textContent = text;
    box.classList.toggle("bzh3d-warn", warn);
}

// 高度是推导值：取 DOM 实测，交给框架 computeSize 汇总；可增可减，configure 后重算。
function refresh(node) {
    updateState(node);
    const wrap = node._h3Wrap;
    const domW = node._h3DomW;
    if (!wrap || !domW) return;
    const h = Math.max(50, wrap.scrollHeight + 4);
    domW.computeSize = () => [node.size[0], h];
    domW.computeLayoutSize = () => ({ minHeight: h, maxHeight: undefined, minWidth: 0 });
    node._h3Fixing = true;
    node.setSize([node.size[0], node.computeSize()[1]]);
    node._h3Fixing = false;
    node.setDirtyCanvas(true, true);
}

function makeSelect(node, row) {
    const sel = document.createElement("select");
    const styles = catalogOf(node);
    for (const g of GROUPS) {
        const list = styles.filter((s) => s.group === g);
        if (!list.length) continue;
        const og = document.createElement("optgroup");
        og.label = g;
        for (const s of list) {
            const op = document.createElement("option");
            op.value = s.name;
            op.textContent = s.name;
            op.title = s.desc;
            og.appendChild(op);
        }
        sel.appendChild(og);
    }
    if (!styles.some((s) => s.name === row.name)) {
        const bad = document.createElement("option");
        bad.value = row.name;
        bad.textContent = "（已失效，请重选）" + row.name;
        sel.appendChild(bad);
    }
    sel.value = row.name;
    // 换风格要重建该行，左右标签与 tooltip 才会跟着变。
    sel.onchange = () => { row.name = sel.value; rebuildPanel(node); };
    return sel;
}

function buildModeBar(node) {
    const bar = document.createElement("div");
    bar.className = "bzh3d-mode";
    for (const label of ["简版", "专业版"]) {
        const b = document.createElement("button");
        b.textContent = label;
        b.classList.toggle("bzh3d-on", isPro(node) === (label === "专业版"));
        b.title = label === "专业版" ? "每行一条贝塞尔时间曲线" : "全程一个强度";
        b.onclick = (e) => {
            e.stopPropagation();
            node.properties = node.properties || {};
            node.properties.h3DialPro = label;
            rebuildPanel(node);
        };
        bar.appendChild(b);
    }
    const hint = document.createElement("span");
    hint.textContent = isPro(node) ? "曲线纵轴即强度：−1 左侧，+1 右侧" : "";
    bar.appendChild(hint);
    return bar;
}

function buildRow(node, row) {
    const box = document.createElement("div");
    box.className = "bzh3d-slot";
    const div = document.createElement("div");
    div.className = "bzh3d-row" + (row.on ? "" : " bzh3d-off");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = !!row.on;
    cb.title = "启用该路";
    cb.onchange = () => {
        row.on = cb.checked;
        div.classList.toggle("bzh3d-off", !row.on);
        syncConfig(node);
        refresh(node);
    };
    const sel = makeSelect(node, row);
    const st0 = styleOf(catalogOf(node), row.name);
    const range = document.createElement("input");
    range.type = "range";
    range.min = -100; range.max = 100; range.step = 1;
    range.value = row.pct ?? 0;
    range.title = st0
        ? "左：" + st0.neg + "　中：0 不生效　右：" + st0.pos
        : "左：负向　中：0 不生效　右：正向";
    const slider = document.createElement("div");
    slider.className = "bzh3d-slider";
    slider.appendChild(range);
    const val = document.createElement("span");
    val.className = "bzh3d-val";
    const paint = () => {
        const styles = catalogOf(node);
        const st = styleOf(styles, row.name);
        const v = (Number(row.pct) || 0) / 100;
        const s = strengthOf(styles, row);
        val.textContent = v === 0 ? "0.00" : (v > 0 ? "+" : "") + v.toFixed(2);
        const u = usefulOf(styles, row);
        val.classList.toggle("bzh3d-hot", !!st && u > 0 && Math.abs(s) > u);
        val.classList.toggle("bzh3d-neg", v < 0);
        val.title = st
            ? (v >= 0 ? "右：" + st.pos : "左：" + st.neg) + " · 实际强度 " + s.toFixed(2)
            : "";
    };
    // 用户直接拖滑块：实时写值与重绘，不合并、不推迟。
    range.oninput = () => {
        row.pct = Number(range.value);
        paint();
        syncConfig(node);
        refresh(node);
    };
    const del = document.createElement("button");
    del.className = "bzh3d-del";
    del.textContent = "×";
    del.title = "删除该路";
    del.onclick = (e) => {
        e.stopPropagation();
        node._h3Rows = node._h3Rows.filter((r) => r !== row);
        if (!node._h3Rows.length) node._h3Rows.push(defaultRow(catalogOf(node)));
        rebuildPanel(node);
    };
    if (isPro(node)) {
        const tip = document.createElement("span");
        tip.textContent = "曲线控制 −1 ~ +1";
        tip.title = "曲线纵轴即风格强度：负值偏左侧风格，正值偏右侧风格";
        tip.style.cssText = "flex:1;min-width:0;color:#8a8f99;font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis";
        div.append(cb, sel, tip, del);
    } else {
        div.append(cb, sel, slider, val, del);
    }
    box.appendChild(div);
    if (isPro(node)) {
        // 一进专业版就给默认曲线，否则用户不点预设时 row.curve 为空、后端仍按中性透传。
        if (!row.curve?.points) {
            row.curve = { points: DEFAULT_POINTS(), preset: "匀速", k: 2, audio: "protect" };
            syncConfig(node);
        }
        const ed = createCurveEditor(row.curve.points, (pts, preset) => {
            row.curve = { points: pts, preset: preset, k: 2, audio: "protect" };
            syncConfig(node);
            refresh(node);
        });
        box.appendChild(ed.el);
    }
    paint();
    return box;
}

function rebuildPanel(node) {
    const wrap = node._h3Wrap;
    if (!wrap) return;
    wrap.innerHTML = "";
    wrap.appendChild(buildModeBar(node));
    const list = document.createElement("div");
    node._h3Rows.forEach((r) => list.appendChild(buildRow(node, r)));
    wrap.appendChild(list);
    const foot = document.createElement("div");
    if (node._h3Rows.length >= MAX_ROWS) {
        foot.className = "bzh3d-full";
        foot.textContent = "最多 " + MAX_ROWS + " 路，先删除再添加";
    } else {
        foot.className = "bzh3d-add";
        foot.textContent = "＋ 添加风格";
        foot.onclick = (e) => {
            e.stopPropagation();
            node._h3Rows.push(defaultRow(catalogOf(node)));
            rebuildPanel(node);
        };
    }
    wrap.appendChild(foot);
    const state = document.createElement("div");
    state.className = "bzh3d-state";
    wrap.appendChild(state);
    node._h3State = state;
    syncConfig(node);
    refresh(node);
}

// 尺寸纠正挂在 onResize：用户亲手拖边角记宽度真值，其余覆盖一律拉回。
function attachResize(node) {
    const prev = node.onResize;
    node.onResize = function (size) {
        const r = prev ? prev.apply(this, arguments) : undefined;
        if (this._h3Fixing) return r;
        const props = this.properties || (this.properties = {});
        const byUser = app.canvas && app.canvas.resizing_node === this;
        if (byUser) {
            props.h3DialWidth = size[0];
        } else if (props.h3DialWidth && Math.abs(size[0] - props.h3DialWidth) > 1) {
            this._h3Fixing = true;
            this.setSize([props.h3DialWidth, size[1]]);
            this._h3Fixing = false;
        }
        refresh(this);
        return r;
    };
}

function setupPanel(node) {
    injectCss();
    hideWidgets(node);
    node.properties = node.properties || {};
    if (!node.properties.h3DialPro) node.properties.h3DialPro = "简版";
    restoreRows(node);
    const wrap = document.createElement("div");
    wrap.className = "bzh3d-wrap";
    wrap.addEventListener("mousedown", (e) => e.stopPropagation());
    wrap.addEventListener("keydown", (e) => e.stopPropagation());
    node._h3Wrap = wrap;
    node._h3DomW = node.addDOMWidget("h3_dial_panel", "div", wrap, { serialize: false });
    const i = node.widgets.indexOf(node._h3DomW);
    if (i > 0) node.widgets.splice(0, 0, node.widgets.splice(i, 1)[0]);
    // 刷新时用 properties 里的宽度真值，不把 Vue 覆盖后的窄宽度当成新真值。
    const savedW = Number(node.properties.h3DialWidth) || 0;
    node.size[0] = Math.max(savedW, node.size[0] ?? 0, 420);
    node.properties.h3DialWidth = node.size[0];
    rebuildPanel(node);
    attachResize(node);
}

app.registerExtension({
    name: "banzhang.h3.dial.multi",
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== NODE_ID) return;
        const onCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const r = onCreated ? onCreated.apply(this, arguments) : undefined;
            setupPanel(this);
            return r;
        };
        const onConfigure = nodeType.prototype.configure;
        nodeType.prototype.configure = function (info) {
            const r = onConfigure ? onConfigure.apply(this, arguments) : undefined;
            // configure 可能早于 onNodeCreated，两处都走恢复，已有配置不会被默认行覆盖。
            hideWidgets(this);
            this.properties = this.properties || {};
            if (!this.properties.h3DialPro) this.properties.h3DialPro = "简版";
            restoreRows(this);
            if (this._h3Wrap) rebuildPanel(this);
            syncConfig(this);
            return r;
        };
    },
});
