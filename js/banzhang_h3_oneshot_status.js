import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

// ═══════════════════════════════════════════════════════════
//  🎬 H3 智能成片 · 诊断面板（节点顶部）
//
//  数据流：后端 enhance() 末尾组装成结构化 report →
//          · 节点执行完随 ui 输出（onExecuted 拿 h3oneshot_tiling_report）
//          · 采样一结束立刻 send_sync「banzhang-h3-oneshot-tiling」（跑长任务时提前可见）
//  面板只负责上色排版：结论徽章 / 建议 / 本次运行 / σ 读数 / 分块 / 参数速查。
//  判定与文案都在后端（banzhang_mmh3_upscale.py 的 _sigma_triage + advice），
//  这样日志和面板说的永远是同一件事，改文案只改一处。
//
//  没跑过之前显示「新手速查」，不是一句"未运行"——新人是靠这个面板上手的。
//
//  面板高度固定 PANEL_H、内容超出自己滚：DOM widget 的盒子由前端算
//  （size = computedHeight - 20，见 banzhang_h3_oneshot.js 文件头），
//  运行时改高度不会自动重排，所以不做自适应。
// ═══════════════════════════════════════════════════════════

const PANEL_H = 150;

const CSS = `
.bzo-head{display:flex;align-items:center;gap:5px;padding:3px 6px;border-radius:4px;
  margin-bottom:5px;font-size:11px;font-weight:500}
.bzo-head.bad{background:rgba(255,107,107,.16);color:#ff8a80;border-left:3px solid #ff6b6b}
.bzo-head.warn{background:rgba(255,183,77,.14);color:#ffcc80;border-left:3px solid #ffb74d}
.bzo-head.ok{background:rgba(102,187,106,.14);color:#a5d6a7;border-left:3px solid #66bb6a}
.bzo-sec{margin-bottom:5px}
.bzo-t{font-size:9px;color:#8a8f99;letter-spacing:1px;margin-bottom:2px}
.bzo-adv{font-size:10px;line-height:1.5;padding:2px 0 2px 6px;border-left:2px solid #565a63;
  margin-bottom:3px;color:#cfd3da;word-break:break-word}
.bzo-adv.must{border-left-color:#ff6b6b;color:#ffdede}
.bzo-adv.tip{border-left-color:#ffb74d;color:#ffe9c8}
.bzo-adv.ok{border-left-color:#66bb6a;color:#d9f2db}
.bzo-fix{font-family:ui-monospace,Consolas,monospace;font-size:9px;color:#8fd0ff;
  padding-left:2px;margin-top:2px;word-break:break-all;user-select:text}
.bzo-kv{display:flex;gap:6px;font-size:10px;line-height:1.5}
.bzo-k{color:#8a8f99;min-width:40px;flex:none}
.bzo-s{color:#cfd3da;flex:1;min-width:0;word-break:break-word}
.bzo-mono{font-family:ui-monospace,Consolas,monospace;font-size:9px;color:#9fd6c8;
  word-break:break-all;user-select:text}
.bzo-note{font-size:10px;line-height:1.5;color:#b9bec7;word-break:break-word}
.bzo-rec{font-size:9px;color:#8a8f99;border-top:1px dashed #464a52;padding-top:4px;margin-top:2px}
`;

(function injectCss() {
    const ID = "banzhang-h3-oneshot-status-css";
    if (document.getElementById(ID)) return;
    const s = document.createElement("style");
    s.id = ID;
    s.textContent = CSS;
    document.head.appendChild(s);
})();

const esc = (s) => String(s ?? "").replace(/[&<>]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

const row = (k, v) => `<div class="bzo-kv"><span class="bzo-k">${esc(k)}</span>`
    + `<span class="bzo-s">${esc(v)}</span></div>`;

const sec = (title, inner) => `<div class="bzo-sec"><div class="bzo-t">${esc(title)}</div>${inner}</div>`;

function adviceHtml(list) {
    return (list || []).map((item) => {
        const lvl = Array.isArray(item) ? item[0] : "tip";
        const text = Array.isArray(item) ? item[1] : item;
        const lines = String(text).split("\n");
        return `<div class="bzo-adv ${esc(lvl)}">${esc(lines[0])}`
            + lines.slice(1).map((l) => `<div class="bzo-fix">${esc(l)}</div>`).join("")
            + "</div>";
    }).join("");
}

// 没跑过 → 新手速查。这一段是新人唯一的入口，别删成"未运行"。
// 行数要压在首屏能看全的范围（面板 150px ≈ 12~13 行），所以只留四步 + 两条提醒。
const GUIDE = `
<div class="bzo-head ok"><span>新手速查 · 四步配好</span></div>
${sec("① 提升路径（看「神经网络放大」下拉）", `
  <div class="bzo-adv tip">提升方式由「▸ 高级参数」→<b>「神经网络放大」</b>一个下拉决定：<br>
    ·<b>「直出」</b>（默认）= 不做提升，只放大，<b>不重建细节</b>；<br>
    ·<b>「纯插值」</b>= 纯插值 + 像素VAE 强修正（<b>需</b>把视频 VAE 接到「视频VAE」端口，零额外显存）；<br>
    ·<b>选模型</b>= 模型提升（多占约 1~3GiB）；<b>再接上 VAE 会叠一层同样的像素强修正、更锐</b>，不接则偏平滑。</div>`)}
${sec("② 画布", `<div class="bzo-adv tip">「低清起跑比例」默认 0.5；嫌结构不够稳就提到 0.7。</div>`)}
${sec("③ σ", `
  <div class="bzo-adv ok">把「自定义Sigmas」<b>留空</b>、「调度器」选 <b>simple</b>、步数 8，
    直接用模型自己的 σ 轨道。</div>
  <div class="bzo-adv tip">非要手填（stock H3 / shift=12，8 步）：
    <div class="bzo-fix">1,0.9882,0.973,0.9524,0.9231,0.878,0.8,0.6316,0</div></div>`)}
${sec("④ 放大器（可选）", `
  <div class="bzo-adv ok">想省显存就别选模型（多占约 1~3GiB，放不下会自动降级并写明原因）——
    <b>「纯插值」</b>档同样是完整提升，且<b>零额外显存</b>。</div>`)}
${sec("两条必读", `
  <div class="bzo-note">σ 轨道<b>前松后紧是正常的</b>：H3 的 shift=12 让头几步只掉 0.01 量级、
    末步掉得最多。别照 karras 的形状去「加密末段」，那会让加速 LoRA 发糊、发肉。</div>
  <div class="bzo-note">「大面积崩坏」多是直接插值提升的误差，靠提升流程里的强修正档修掉
    ——「神经网络放大」选「纯插值」或模型即启用。</div>`)}
<div class="bzo-rec">跑完一次后，这里会换成这次实测的诊断与针对性建议。</div>`;

function reportHtml(r) {
    const run = r.run || {};
    const tri = r.triage || {};
    const til = r.tiling || {};
    const v = r.verdict || "ok";
    const out = [];

    out.push(`<div class="bzo-head ${esc(v)}"><span>${esc(r.verdict_text || "")}</span></div>`);
    out.push(sec("建议", adviceHtml(r.advice)));

    out.push(sec("本次运行",
        row("画面", `${run.res || "?"} · ${run.frames ?? "?"} 潜帧 · ${run.steps ?? "?"} 步`)
        + row("流程", run.path || "?")
        + (run.lift
            ? row("低清", `${run.lowres || "?"}（长宽 ×${run.lowres_scale ?? "?"}）`)
            : row("低清", "未启用（未走提升流程）"))
        + (run.lift ? row("校正", run.lift_mode || "?") : "")
        + row("σ 来源", r.sigma_src || "?")));

    // 只报数字，不给「形状好坏」的结论：H3 在 shift=12 下正确的那条轨道本来就是末步跨度大、
    // 细节区少，标「太陡/偏少」正好会把对的序列说成错的。
    out.push(sec("σ 读数",
        row("末步跨度", `${(tri.last_drop ?? 0).toFixed(3)} ← 其余步中位数 `
            + `${(tri.median_drop ?? 0).toFixed(3)}，${(tri.ratio ?? 0).toFixed(1)} 倍`)
        + row("细节区", `${tri.detail ?? 0}/${tri.steps ?? 0} 步（σ 落在轨道后半分位，管纹理与锐度）`)
        + `<div class="bzo-mono">σ = ${esc((r.sigmas || []).join(", "))}</div>`));

    out.push(sec("分块方案",
        row("切分", `${til.axis || "?"} · ${til.tiles ?? "?"} 块`
            + (til.tiles > 1
                ? ` · 重叠 ${til.overlap ?? 0} 格 · 交叉过渡 ${til.feather ?? 0} 格`
                : "（整图未拆分）"))
        + (til.tiles > 1 && Array.isArray(til.regions)
            ? row("范围", til.regions.map(([a, b]) => `[${a},${b})`).join(" "))
            : "")
        + row("显存", `预设 ${til.preset || "?"} · 采样后空闲 ≈ ${til.free_mib ?? "?"} MiB`)));

    // 「采样」这一行直接用后端拼好的 sampler_line：填了自定义 Sigmas 时后端会写明
    // 「去噪强度本次未生效」，不会再把它当成生效参数显示（旧版前端没有这个字段，故回退）。
    const samplerLine = run.sampler_line
        || (run.sampler || "?") + (run.denoise === null || run.denoise === undefined
            ? "（去噪强度未生效）" : ` · 去噪 ${run.denoise}`);
    out.push(sec("本次参数", row("采样", samplerLine)));
    out.push(`<div class="bzo-rec">${esc(r.rec || "")}</div>`);
    return out.join("");
}

function renderStatus(node, report, text) {
    const box = node._bzoStatusBox;
    if (!box) return;
    if (report !== undefined) node._bzoStatusReport = report;
    if (text !== undefined) node._bzoStatusText = String(text);
    const r = node._bzoStatusReport;
    if (r && r.verdict) box.innerHTML = reportHtml(r);
    else if (node._bzoStatusText) box.innerHTML = `<div class="bzo-note">${esc(node._bzoStatusText)}</div>`;
    else box.innerHTML = GUIDE;
    node.setDirtyCanvas?.(true, true);
}

app.registerExtension({
    name: "banzhang.h3.oneshot.tilingstatus",

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== "BanZhang_MMH3_OneShot") return;

        const created = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const result = created?.apply(this, arguments);
            const box = document.createElement("div");
            box.setAttribute("role", "status");
            box.setAttribute("aria-label", "H3 智能成片 · 运行诊断");
            box.style.cssText = (
                "width:100%;height:100%;box-sizing:border-box;resize:none;overflow-y:auto;"
                + "overflow-x:hidden;padding:5px 6px;"
                + "color:var(--input-text,#ddd);background:var(--comfy-input-bg,#222);"
                + "border:1px solid var(--border-color,#555);border-radius:4px;");
            this._bzoStatusBox = box;
            const statusWidget = this.addDOMWidget("bzo_tiling_status", "bzo-tiling-status", box,
                { serialize: false, getHeight: () => PANEL_H, getMinHeight: () => PANEL_H,
                  getMaxHeight: () => PANEL_H });
            // 面板放到所有参数之上：ComfyUI 按 widgets 数组顺序排列，addDOMWidget 默认追加到末尾
            const idx = this.widgets.indexOf(statusWidget);
            if (idx > 0) this.widgets.splice(0, 0, this.widgets.splice(idx, 1)[0]);
            // 高度交给 getHeight（computeSize 会带上它），这里只做「只增不减」兜底，
            // 免得把用户在别处拉高的布局压回去；真正的贴合由 banzhang_h3_oneshot.js
            // 的 relayout 在下一帧统一处理。
            this.size[0] = Math.max(this.size[0], 360);
            let need = 0;
            try { need = this.computeSize?.()?.[1] || 0; } catch (e) { need = 0; }
            if (need > 0) this.setSize([this.size[0], Math.max(this.size[1] || 0, need + 8)]);
            renderStatus(this);
            return result;
        };

        const configured = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function () {
            const result = configured?.apply(this, arguments);
            renderStatus(this);
            return result;
        };

        const executed = nodeType.prototype.onExecuted;
        nodeType.prototype.onExecuted = function (message) {
            const result = executed?.apply(this, arguments);
            const ui = message?.ui_values ?? message;
            const report = ui?.h3oneshot_tiling_report?.[0] ?? message?.h3oneshot_tiling_report?.[0];
            const text = ui?.h3oneshot_tiling?.[0] ?? message?.h3oneshot_tiling?.[0];
            renderStatus(this, report, Array.isArray(text) ? text.join("\n") : text);
            return result;
        };
    },

    setup() {
        api.addEventListener("banzhang-h3-oneshot-tiling", (event) => {
            const id = String(event.detail?.node_id ?? "");
            let node = app.graph?.getNodeById(id);
            if (!node && /^\d+$/.test(id)) node = app.graph?.getNodeById(Number(id));
            if (node?._bzoStatusBox) renderStatus(node, event.detail?.report, event.detail?.text);
        });
    },
});
