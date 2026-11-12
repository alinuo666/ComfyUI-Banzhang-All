// 📈 活动监视器（内存 / 显存曲线）—— 画布节点
// 设计语言：macOS 活动监视器 + Instruments 时间线
//   双 y 轴：左侧显存刻度（橙）、右侧内存刻度（蓝），总量自动识别
//   节点执行阶段：阶段色带（相邻段明暗交替）+ 顶部两行节点名，执行中末段随采样延长
//   苹果风对数滑块切时间窗（30 秒 ~ 30 分钟无极）· 毛玻璃统计胶囊 · 高 DPI 平滑曲线 + 渐变填充
//   最新点光晕 · 悬停十字线 + 数据点高亮 · 净化标记
// 不做悬停浮层：数值只走顶部统计胶囊，鼠标划过时不许弹窗遮挡曲线。
// 数据链：每 0.25 秒拉一次 /banzhang/mem_graph?since=（带最后一点时间，只取增量；
// 后端被问一次采一个点），页面切走自动停采。面板高度固定，宽度可拖且记忆（onResize 唯一写入口）。
// 重画一律走 scheduleDraw 合帧：mousemove 一秒上百次，每次同步重画几千点会把主线程按死。
const { app } = window.comfyAPI.app;
const { api } = window.comfyAPI.api;

const POLL_MS = 250;                        // 0.25 秒一个点（0.4 秒在快节点上仍看得出滞后）
const MAX_PTS = 7400;                       // 浏览器侧上限，与后端 deque（7200）对齐
const PANEL_H = 312;                        // 面板固定高度
const DEFAULT_W = 380;                      // 默认宽度
const MIN_W = 300;                          // 最小宽度
const WIN_MIN = 30, WIN_MAX = 1800;         // 时间范围（秒）：30 秒 ~ 30 分钟，滑块对数无极
const WIN_OLD = { "1 分钟": 60, "5 分钟": 300, "10 分钟": 600, "30 分钟": 1800 };  // 旧工作流的枚举值
const 滑到秒 = (v) => WIN_MIN * Math.pow(WIN_MAX / WIN_MIN, v / 1000);
const 秒到滑 = (s) => 1000 * Math.log(s / WIN_MIN) / Math.log(WIN_MAX / WIN_MIN);
const C_VRAM = "#FF9F0A";                   // 苹果系统橙 = 显存
const C_RAM = "#0A84FF";                    // 苹果系统蓝 = 内存
const C_MARK = "#BF5AF2";                   // 苹果系统紫 = 手动净化标记
const C_GOOD = "#30D158";                   // 苹果绿 = 开始/完成
const C_BAD = "#FF453A";                    // 苹果红 = 错误

const gb = (b) => b / 1024 ** 3;
const pad2 = (n) => String(n).padStart(2, "0");
function fmtAxis(t, long) {
    const d = new Date(t * 1000);
    return long
        ? `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
        : `${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}
function hexA(hex, a) {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}
// 刻度数字：整数不带小数，非整数保留 1 位
function fmtGb(v) {
    return Number.isInteger(v) ? v.toFixed(0) : v.toFixed(1);
}
// 时间窗读数：<1 分钟报秒，<10 分钟保留 1 位，再往上取整分钟
function fmtWin(sec) {
    if (sec < 60) return Math.round(sec) + " 秒";
    if (sec < 600) return (sec / 60).toFixed(1).replace(/\.0$/, "") + " 分钟";
    return Math.round(sec / 60) + " 分钟";
}
// 绘图区宽度：canvas 实测宽度减去左右刻度区。布局还没算好时退回默认宽。
const PAD_L = 34, PAD_R = 34, PAD_T = 43, PAD_B = 18;
function 绘图宽(node) {
    const c = node && node._am && node._am.canvas;
    const w = c ? c.clientWidth : 0;
    return w > 120 ? w - PAD_L - PAD_R : DEFAULT_W - PAD_L - PAD_R;
}
// 密度（秒/像素）是时间跨度的**唯一真值**：拉宽 → 跨度自动变长；拖滑块 → 改密度。
// 两个入口共用一个真值，才不会出现「拉宽之后滑块读数和实际对不上」。
// 反过来（宽度和滑块各存一份时间范围）就必然打架 —— 帧账「两个真值」那个教训。
function densityOf(node) {
    const d = node && node.properties && node.properties._bz_am_density;
    if (typeof d === "number" && isFinite(d) && d > 0) return d;
    // 老工作流只存了时间窗（可能是 "5 分钟" 这种枚举）→ 按当前宽度换算成密度
    const ww = (node.widgets || []).find((x) => x.name === "时间窗");
    let v = ww ? ww.value : 300;
    if (typeof v === "string") v = WIN_OLD[v] || 300;
    v = Number(v);
    if (!isFinite(v) || v <= 0) v = 300;
    return v / 绘图宽(node);
}
function winSecOf(node) {
    const sec = 绘图宽(node) * densityOf(node);
    return Math.min(WIN_MAX, Math.max(WIN_MIN, sec));
}

// 常见节点类型 → 中文短名（仅在用户未自定义标题时使用）
const NODE_ZH = {
    KSampler: "采样器", KSamplerAdvanced: "高级采样器", SamplerCustom: "自定义采样",
    SamplerCustomAdvanced: "高级自定义采样",
    CheckpointLoaderSimple: "加载大模型", CheckpointLoader: "加载大模型",
    UNETLoader: "加载UNET", LoraLoader: "加载LoRA", LoraLoaderModelOnly: "加载LoRA",
    VAELoader: "加载VAE", VAEDecode: "VAE解码", VAEEncode: "VAE编码",
    VAEDecodeTiled: "VAE分块解码", VAEEncodeForInpaint: "VAE重绘编码",
    CLIPTextEncode: "文本编码", CLIPTextEncodeSDXL: "SDXL文本编码",
    EmptyLatentImage: "空Latent", EmptySD3LatentImage: "空Latent",
    SaveImage: "保存图片", PreviewImage: "预览图片", LoadImage: "加载图片",
    ControlNetLoader: "加载ControlNet", ControlNetApply: "应用ControlNet",
    ControlNetApplyAdvanced: "应用ControlNet",
    UpscaleModelLoader: "加载放大模型", ImageUpscaleWithModel: "模型放大",
    ImageScale: "缩放图片", ImageScaleBy: "缩放图片",
    FreeU: "FreeU", ModelSamplingDiscrete: "模型采样设置",
};

// ── 样式注入（一次） ─────────────────────────────────────────
(function injectCss() {
    const ID = "bz-am-css";
    if (document.getElementById(ID)) return;
    const s = document.createElement("style");
    s.id = ID;
    s.textContent = `
.bz-am{width:100%;height:100%;box-sizing:border-box;padding:10px 12px 9px;display:flex;flex-direction:column;
  gap:8px;overflow:hidden;user-select:none;border-radius:6px;
  font-family:-apple-system,BlinkMacSystemFont,"SF Pro Display","SF Pro Text","Segoe UI Variable Display",
  "Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;
  background:linear-gradient(180deg,rgba(28,28,30,.92),rgba(22,22,24,.92));
  color:#fff;-webkit-font-smoothing:antialiased;}
.bz-am *{box-sizing:border-box;}
.bz-am-head{display:flex;align-items:center;gap:8px;flex:0 0 auto;height:24px;}
.bz-am-title{font-size:12.5px;font-weight:600;letter-spacing:-.1px;white-space:nowrap;}
.bz-am-gpu{margin-left:auto;font-size:10.5px;color:rgba(235,235,245,.5);white-space:nowrap;
  font-variant-numeric:tabular-nums;overflow:hidden;text-overflow:ellipsis;}
.bz-am-slider{flex:1 1 auto;min-width:58px;height:14px;margin:0;-webkit-appearance:none;
  appearance:none;background:transparent;cursor:pointer;}
.bz-am-slider::-webkit-slider-runnable-track{height:4px;border-radius:2px;
  background:rgba(255,255,255,.15);}
.bz-am-slider::-webkit-slider-thumb{-webkit-appearance:none;box-sizing:border-box;width:12px;
  height:12px;margin-top:-4px;border-radius:50%;background:#fff;border:none;
  box-shadow:0 1px 3px rgba(0,0,0,.5);transition:transform .1s ease;}
.bz-am-slider:active::-webkit-slider-thumb{transform:scale(1.15);}
.bz-am-slider::-moz-range-track{height:4px;border-radius:2px;background:rgba(255,255,255,.15);}
.bz-am-slider::-moz-range-thumb{box-sizing:border-box;width:12px;height:12px;border-radius:50%;
  background:#fff;border:none;box-shadow:0 1px 3px rgba(0,0,0,.5);}
.bz-am-win{flex:0 0 auto;min-width:46px;text-align:right;font-size:10.5px;
  color:rgba(235,235,245,.72);font-variant-numeric:tabular-nums;white-space:nowrap;}
.bz-am-stats{display:flex;gap:8px;flex:0 0 auto;}
.bz-am-stat{flex:1 1 0;min-width:0;background:rgba(255,255,255,.055);
  border:.5px solid rgba(255,255,255,.08);border-radius:10px; padding:6px 9px 5px;cursor:pointer;
  transition:opacity .15s ease,background .15s ease;}
.bz-am-stat:hover{background:rgba(255,255,255,.08);}
.bz-am-stat.off{opacity:.35;}
.bz-am-stat-top{display:flex;align-items:center;gap:5px;}
.bz-am-stat-top i{width:7px;height:7px;border-radius:50%;flex:0 0 auto;}
.bz-am-stat-top .lbl{font-size:10.5px;color:rgba(235,235,245,.6);}
.bz-am-stat-top .pct{margin-left:auto;font-size:16px;font-weight:600;letter-spacing:-.3px;
  font-variant-numeric:tabular-nums;line-height:1.15;}
.bz-am-stat-sub{margin-top:1px;font-size:10px;color:rgba(235,235,245,.45);
  font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.bz-am-stat-sub b{color:rgba(235,235,245,.75);font-weight:600;}
.bz-am-chart{position:relative;flex:1 1 auto;min-height:0;background:rgba(255,255,255,.04);
  border:.5px solid rgba(255,255,255,.07);border-radius:10px;overflow:hidden;}
.bz-am-canvas{width:100%;height:100%;display:block;cursor:crosshair;}
.bz-am-empty{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;
  font-size:11px;color:rgba(235,235,245,.4);pointer-events:none;}
`;
    document.head.appendChild(s);
})();

function el(tag, cls, parent) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (parent) parent.appendChild(e);
    return e;
}

// Catmull-Rom 样条（1/6 张力）转贝塞尔，穿全部数据点，比折线柔和
function smoothPath(ctx, pts) {
    if (!pts.length) return;
    ctx.moveTo(pts[0].x, pts[0].y);
    if (pts.length === 1) return;
    for (let i = 0; i < pts.length - 1; i++) {
        const p0 = pts[i - 1] || pts[i];
        const p1 = pts[i];
        const p2 = pts[i + 1];
        const p3 = pts[i + 2] || p2;
        const c1x = p1.x + (p2.x - p0.x) / 6;
        const c1y = p1.y + (p2.y - p0.y) / 6;
        const c2x = p2.x - (p3.x - p1.x) / 6;
        const c2y = p2.y - (p3.y - p1.y) / 6;
        ctx.bezierCurveTo(c1x, c1y, c2x, c2y, p2.x, p2.y);
    }
}

// 圆角矩形路径（标签胶囊）。r 会收敛到不超过半宽/半高，否则圆角会互相打架画成花。
// 自带 beginPath：调用方直接 fill / stroke。
function rrPath(ctx, x, y, w, h, r) {
    const rr = Math.max(0, Math.min(r, w / 2, h / 2));
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.lineTo(x + w - rr, y);
    ctx.arcTo(x + w, y, x + w, y + rr, rr);
    ctx.lineTo(x + w, y + h - rr);
    ctx.arcTo(x + w, y + h, x + w - rr, y + h, rr);
    ctx.lineTo(x + rr, y + h);
    ctx.arcTo(x, y + h, x, y + h - rr, rr);
    ctx.lineTo(x, y + rr);
    ctx.arcTo(x, y, x + rr, y, rr);
    ctx.closePath();
}

// 阶段标记的竖线/标签配色
const STAGE_LINE = {
    manual: { color: hexA(C_MARK, .65), dash: [4, 3] },
    node: { color: "rgba(255,255,255,.26)", dash: [] },
    start: { color: hexA(C_GOOD, .45), dash: [] },
    success: { color: hexA(C_GOOD, .45), dash: [] },
    error: { color: hexA(C_BAD, .55), dash: [] },
};
const STAGE_TEXT = {
    manual: hexA(C_MARK, .98),
    node: "rgba(242,242,247,.97)",
    start: C_GOOD,
    success: C_GOOD,
    error: C_BAD,
};
// 标签胶囊：背景 / 细边框（替代粗描边，避免小字发糊）
const STAGE_BG = {
    manual: hexA(C_MARK, .22),
    node: "rgba(24,24,26,.78)",                 // 深底亮字：白色低 alpha 胶囊压在色带上，字和底分不开
    start: hexA(C_GOOD, .18),
    success: hexA(C_GOOD, .18),
    error: hexA(C_BAD, .20),
};
const STAGE_BORDER = {
    manual: hexA(C_MARK, .42),
    node: "rgba(255,255,255,.15)",
    start: hexA(C_GOOD, .38),
    success: hexA(C_GOOD, .38),
    error: hexA(C_BAD, .42),
};

// ── 曲线绘制（每帧） ─────────────────────────────────────────
// 合帧：一帧最多真画一次。鼠标在面板上划一秒能来上百个 mousemove，
// 每个都同步重画几千点 = 主线程被按死，表现就是「整个界面延迟严重」。
// 用布尔标记而不是存 rAF id：requestAnimationFrame 在某些环境（含单测）是同步回调，
// 存 id 会留下一个永不复位的真值，第二次之后就再也画不动了。
function scheduleDraw(node) {
    const st = node && node._am;
    if (!st || st._queued) return;
    st._queued = true;
    requestAnimationFrame(() => { st._queued = false; drawChart(node); });
}
function drawChart(node) {
    try {
        _drawChart(node);
    } catch (e) {
        console.error("[班长活动监视器] 绘制异常:", e);
    }
}
function _drawChart(node) {
    const st = node._am;
    const canvas = st.canvas;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (w < 10 || h < 10) return;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    // 双 y 轴：左右各留刻度宽度；顶部留两行阶段标签轨（43 = 2×16 标签 + 间隙 + 边距）
    const padL = PAD_L, padR = PAD_R, padT = PAD_T, padB = PAD_B;
    const plotW = w - padL - padR, plotH = h - padT - padB;
    // 时间跨度和横轴映射必须用**同一个 plotW** 算。
    // 之前这里调 winSecOf()，它会再读一次 canvas.clientWidth —— 一帧内两次取宽度，
    // 只要有一次拿到的是布局中途的值，刻度/标签就和曲线错位（拉宽时最容易撞上）。
    const winSec = Math.min(WIN_MAX, Math.max(WIN_MIN, plotW * densityOf(node)));
    const winMs = winSec * 1000;

    const all = st.points || [];
    st.empty.style.display = all.length ? "none" : "flex";
    if (!all.length) return;

    // 右边界不能只看最后一个采样点。采样线程万一被 GIL 饿住一小会儿、或网络抖一下，
    // 落后那段时间的节点会整段落到右边界之外被裁掉（bands 和标签都有越界 continue），
    // 看着就是「执行都完成了，节点还没出来」。取「最后采样点」和「最新节点阶段」的较大者，
    // 新节点立刻可见 —— 代价只是曲线右端可能留一小段空白，那是真实情况，不该藏。
    const 末采样 = all[all.length - 1].t;
    let 末阶段 = 0;
    for (const s of (st.stages || [])) {
        if (s.t > 末阶段) 末阶段 = s.t;
        if (s.end != null && s.end > 末阶段) 末阶段 = s.end;
    }
    const nowT = Math.max(末采样, 末阶段);
    const startMs = nowT * 1000 - winMs;
    const pts = all.filter((p) => p.t * 1000 >= startMs);
    if (!pts.length) return;

    const x2px = (t) => padL + ((t * 1000 - startMs) / winMs) * plotW;
    const y2px = (r) => padT + plotH - Math.min(1, Math.max(0, r)) * plotH;

    // 总量（自动识别：取最新采样点，不同用户配置自然适配）
    const last0 = all[all.length - 1];
    const vramTotal = gb(last0.vram_total) || 0;
    const ramTotal = gb(last0.ram_total) || 0;

    // ── 水平网格 0/25/50/75/100 ──
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
        const y = padT + (plotH * i) / 4;
        ctx.strokeStyle = i === 4 ? "rgba(255,255,255,.09)" : "rgba(255,255,255,.055)";
        ctx.beginPath();
        ctx.moveTo(padL, y + .5);
        ctx.lineTo(padL + plotW, y + .5);
        ctx.stroke();
    }

    // ── 左侧显存刻度（橙）/ 右侧内存刻度（蓝） ──
    ctx.font = "9.5px -apple-system,'Segoe UI',sans-serif";
    ctx.lineWidth = 3;
    for (let i = 0; i <= 4; i++) {
        const y = padT + (plotH * i) / 4;
        const frac = (4 - i) / 4;                 // 顶部 100% → 底部 0
        ctx.textAlign = "right";
        ctx.fillStyle = hexA(C_VRAM, .85);
        ctx.fillText(fmtGb(vramTotal * frac), padL - 5, y + 3);
        ctx.textAlign = "left";
        ctx.fillStyle = hexA(C_RAM, .85);
        ctx.fillText(fmtGb(ramTotal * frac), padL + plotW + 5, y + 3);
    }

    // ── 时间刻度（5 个，底部） ──
    ctx.fillStyle = "rgba(235,235,245,.4)";
    ctx.font = "9px -apple-system,'Segoe UI',sans-serif";
    ctx.textAlign = "center";
    const long = winSec >= 600;
    for (let i = 0; i <= 4; i++) {
        const t = startMs / 1000 + (winMs / 1000) * (i / 4);
        ctx.fillText(fmtAxis(t, long), padL + (plotW * i) / 4, h - 5);
    }

    // ── 阶段色带（曲线底层）：交替明暗区分相邻节点，悬停段提亮 ──
    // 区间来自 stages；末段尚未收尾时延伸到最新采样点，执行到哪就长到哪。
    // 画在曲线之前，曲线和渐变才压在带子上面，不挡数据。
    // 延伸终点只能用曲线自己的时间轴（nowT），换浏览器时钟会让带子和曲线错开（远程访问时尤其明显）。
    const bands = buildBands(st, nowT, all);
    const bandHoverT = st.hoverX != null
        ? startMs / 1000 + ((st.hoverX - padL) / plotW) * winMs
        : null;
    ctx.save();
    ctx.beginPath();
    ctx.rect(padL, padT, plotW, plotH);
    ctx.clip();
    for (const b of bands) {
        const x0 = Math.max(padL, x2px(b.t0));
        const x1 = Math.min(padL + plotW, x2px(b.t1));
        if (x0 > padL + plotW) continue;      // 整段在窗口右侧外
        if (x1 - x0 >= .7) {                  // 窄于 1px 不铺色（铺了也是糊成一条灰）
            const on = bandHoverT != null && bandHoverT >= b.t0 && bandHoverT < b.t1;
            // 曲线自身的渐变填充压在上面，色差太小会看不出来 → 两档要拉得开
            ctx.fillStyle = on
                ? "rgba(255,255,255,.17)"
                : (b.i % 2 ? "rgba(255,255,255,.03)" : "rgba(255,255,255,.10)");
            ctx.fillRect(x0, padT, x1 - x0, plotH);
        }
    }
    ctx.restore();

    const series = (getV, getT) =>
        pts.map((p) => ({ x: x2px(p.t), y: y2px(getV(p) / (getT(p) || 1)), p }));

    const drawOne = (sr, color) => {
        if (sr.length < 1) return;
        if (sr.length >= 2) {
            ctx.beginPath();
            ctx.moveTo(sr[0].x, padT + plotH);
            ctx.lineTo(sr[0].x, sr[0].y);
            smoothPath(ctx, sr);
            ctx.lineTo(sr[sr.length - 1].x, padT + plotH);
            ctx.closePath();
            const g = ctx.createLinearGradient(0, padT, 0, padT + plotH);
            g.addColorStop(0, hexA(color, .20));
            g.addColorStop(1, hexA(color, 0));
            ctx.fillStyle = g;
            ctx.fill();
        }
        ctx.beginPath();
        smoothPath(ctx, sr);
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.7;
        ctx.lineJoin = "round";
        ctx.lineCap = "round";
        ctx.stroke();
        const last = sr[sr.length - 1];
        ctx.save();
        ctx.shadowColor = color;
        ctx.shadowBlur = 9;
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(last.x, last.y, 3.2, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
        ctx.fillStyle = "rgba(255,255,255,.85)";
        ctx.beginPath();
        ctx.arc(last.x, last.y, 1.2, 0, Math.PI * 2);
        ctx.fill();
    };

    const srRam = st.show.ram ? series((p) => p.ram_used, (p) => p.ram_total) : null;
    const srVram = st.show.vram ? series((p) => p.vram_used, (p) => p.vram_total) : null;
    if (srRam) drawOne(srRam, C_RAM);
    if (srVram) drawOne(srVram, C_VRAM);

    // ── 阶段标记：节点段出顶部横排胶囊（两行交替），其余出竖线 ──
    // 竖排虽能塞更多，但读起来要歪头；过滤掉零占用节点后，横排两行足够用。
    const topItems = [];
    for (const m of (st.marks || [])) {
        if (m.t * 1000 >= startMs) topItems.push({ t: m.t, name: m.label, kind: "manual" });
    }
    for (const s of (st.stages || [])) {
        if (s.kind === "node") continue;        // 节点由色带表达，不再重复占标签位
        if (s.t * 1000 >= startMs) topItems.push({ t: s.t, name: s.name, kind: s.kind });
    }
    for (const b of bands) {
        if (b.t1 * 1000 >= startMs) topItems.push({ t: b.t0, name: b.name, kind: "node" });
    }
    topItems.sort((a, b) => a.t - b.t);

    // 文字清晰度三件事：11px 起（10px 中文在 Windows 上必糊）、整数基线（亚像素会发虚）、
    // 深色胶囊底（白色低 alpha 胶囊叠在色带上，字和背景分不开）。字体优先微软雅黑，Segoe 排在后面。
    ctx.save();
    ctx.font = "11px 'Microsoft YaHei','PingFang SC','Segoe UI',sans-serif";
    ctx.textBaseline = "middle";
    const LABEL_H = 16, LABEL_PADX = 5, LABEL_GAP = 3, LABEL_MAXW = 96;
    const rowY = [padT - LABEL_H - 3, padT - LABEL_H * 2 - 3 - LABEL_GAP];
    const rowEnd = [-Infinity, -Infinity];
    // 长节点名会吃掉半条轨、把后面的标签全挤掉 → 超宽裁成 …，保留可读前缀
    const fitText = (text, maxW) => {
        if (ctx.measureText(text).width <= maxW) return text;
        let s = text;
        while (s.length > 1 && ctx.measureText(s + "…").width > maxW) s = s.slice(0, -1);
        return s + "…";
    };
    let seq = 0;
    for (const it of topItems) {
        const x = x2px(it.t);
        if (x < padL - 2 || x > padL + plotW + 2) continue;
        // 竖线画在曲线之上：色带边界会被曲线渐变盖住，分段靠这条线兜底
        {
            const ls = STAGE_LINE[it.kind] || STAGE_LINE.node;
            ctx.save();
            ctx.strokeStyle = ls.color;
            ctx.setLineDash(ls.dash);
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(Math.round(x) + .5, padT);
            ctx.lineTo(Math.round(x) + .5, padT + plotH);
            ctx.stroke();
            ctx.restore();
        }
        // 胶囊一律从自己的竖线右侧起笔，**绝不翻到竖线左边**：
        // 旧逻辑 `x - 3 - boxW` 会把名字甩到前一段头上，看着就是「名字下面的线错位」。
        // 右边装不下时先按剩余空间缩字（……），剩下的余量允许压进右侧刻度区。
        const tx = Math.max(padL, Math.round(x) + 3);
        const 可用 = w - 4 - tx - LABEL_PADX * 2;
        if (可用 < 12) continue;                        // 一个中文字都塞不下才放弃
        const text = fitText(String(it.name), Math.min(LABEL_MAXW, 可用));
        const boxW = ctx.measureText(text).width + LABEL_PADX * 2;
        // 两行交替：按出现顺序先排首选行，挤了换另一行，两行都挤才丢
        const pref = (seq++) % 2;
        let row = -1;
        for (const r of [pref, 1 - pref]) {
            if (tx >= rowEnd[r]) { row = r; break; }
        }
        if (row < 0) continue;
        const baseY = rowY[row];
        const cy = Math.round(baseY + LABEL_H / 2);   // 整数基线：亚像素会让中文发虚
        ctx.textAlign = "left";
        ctx.fillStyle = STAGE_BG[it.kind];
        rrPath(ctx, tx, baseY, boxW, LABEL_H, 5);
        ctx.fill();
        ctx.strokeStyle = STAGE_BORDER[it.kind];
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.fillStyle = STAGE_TEXT[it.kind];
        ctx.fillText(text, Math.round(tx + LABEL_PADX), cy);
        rowEnd[row] = tx + boxW + 3;
    }
    ctx.restore();

    // ── 悬停十字线 + 数据点 ──
    if (st.hoverX != null) {
        const tAt = startMs / 1000 + ((st.hoverX - padL) / plotW) * winMs;
        let best = pts[0], bd = Infinity;
        for (const p of pts) {
            const d = Math.abs(p.t - tAt);
            if (d < bd) { bd = d; best = p; }
        }
        const hx = x2px(best.t);
        ctx.strokeStyle = "rgba(255,255,255,.22)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(hx + .5, padT);
        ctx.lineTo(hx + .5, padT + plotH);
        ctx.stroke();
        for (const [sr, color] of [[srRam, C_RAM], [srVram, C_VRAM]]) {
            if (!sr) continue;
            const item = sr.find((q) => q.p === best);
            if (!item) continue;
            ctx.fillStyle = color;
            ctx.beginPath();
            ctx.arc(item.x, item.y, 3, 0, Math.PI * 2);
            ctx.fill();
            ctx.strokeStyle = "rgba(0,0,0,.5)";
            ctx.lineWidth = 1;
            ctx.stroke();
        }
    }
}

// ── 统计胶囊数值更新 ─────────────────────────────────────────
function updateStats(node) {
    const st = node._am;
    const all = st.points || [];
    if (!all.length) return;
    const p = all[all.length - 1];
    const vramPct = p.vram_total ? Math.round((p.vram_used / p.vram_total) * 100) : 0;
    const ramPct = p.ram_total ? Math.round((p.ram_used / p.ram_total) * 100) : 0;
    st.vramPct.textContent = vramPct + "%";
    st.ramPct.textContent = ramPct + "%";
    st.vramSub.innerHTML = `<b>${gb(p.vram_used).toFixed(1)}</b> / ${gb(p.vram_total).toFixed(0)} GB`;
    st.ramSub.innerHTML = `<b>${gb(p.ram_used).toFixed(1)}</b> / ${gb(p.ram_total).toFixed(0)} GB`;
    st.gpu.textContent = (p.gpu_util || p.gpu_temp)
        ? `GPU ${p.gpu_util}% · ${p.gpu_temp}°C`
        : "";
}

// ── 采样点增量合并 ───────────────────────────────────────────
// 单独成函数是为了能单测：这一段是「越跑越卡」的总开关。
// since = 已拿到的最后一点时间，带上它后端只回增量（0.25 秒一次，全量等于每秒搬
// 四五次 30 分钟历史，几千个点，本地回环也白烧 JSON 序列化）。
// 坑：后端不匹配（没重启 ComfyUI、跑的还是不支持 since 的老 .py）时响应里没有 full 字段。
// 老后端每次都回整段历史，这时候**必须替换而不是 concat** —— 一分钟后画布上就是几十万点，
// 界面直接被拖垮。这就是「延迟严重」的头号成因，所以缺 full 一律按全量处理。
function 合并采样(st, data) {
    if (!data) return;
    const 新点 = Array.isArray(data.points) ? data.points : [];
    const 末t = st.points.length ? st.points[st.points.length - 1].t : -Infinity;
    const 全量 = data.full == null ? true : !!data.full;
    if (全量 || !st.points.length) {
        st.points = 新点;
    } else {
        // 增量只收严格晚于末点的：后端被重复问一次会回同一个时间戳的点，叠上去曲线会原地打结
        const 加 = [];
        for (const p of 新点) {
            if (p && typeof p.t === "number" && p.t > 末t) 加.push(p);
        }
        if (加.length) st.points = st.points.concat(加);
    }
    if (data.marks) st.marks = data.marks;
    if (st.points.length) {
        st.since = st.points[st.points.length - 1].t;
        if (st.points.length > MAX_PTS) st.points = st.points.slice(-MAX_PTS);
    }
}

// ── 滑块与密度双向同步 ───────────────────────────────────────
// 重画可以关掉：拉宽时 ResizeObserver 自己会画，不必让滑块再画一次。
function syncSlider(node, 重画) {
    const st = node._am;
    if (!st || !st.slider) return;
    const sec = winSecOf(node);
    st.slider.value = String(Math.round(秒到滑(sec)));
    st.winText.textContent = fmtWin(sec);
    if (重画 !== false) drawChart(node);
}

// ── 节点执行阶段：自动在时间轴打标 ───────────────────────────
// 段必须有终点才能画成「区间」：只有起点的话，色带只能一路延伸到当前时刻，
// 中断后就永远挂在那儿。终点取「下一段开始」或「执行结束/中断」。
function addStage(st, name, kind) {
    const t = Date.now() / 1000;
    closeLastStage(st, t);
    st.stages.push({ t, name, kind, end: null });
    if (st.stages.length > 300) st.stages.shift();
    scheduleDraw(st.node);
}
function closeLastStage(st, t) {
    const last = st.stages[st.stages.length - 1];
    if (last && last.kind === "node" && last.end == null) {
        last.end = t == null ? Date.now() / 1000 : t;
    }
}
// 二分找第一个 t >= x 的下标（pts 按时间递增）
function 下界(a, x) {
    let lo = 0, hi = a.length;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (a[mid].t < x) lo = mid + 1;
        else hi = mid;
    }
    return lo;
}
// 把时刻吸附到**最近的采样点**上。
// 曲线只有采样点那些时刻有数据，采样间隔 0.25 秒；而阶段时间是浏览器的事件到达时刻，
// 落在两个采样点之间。硬画的话，曲线在右边的点才涨，竖线却在左边 ——
// 窗口越小、面板越宽，这个偏差被放大得越明显（30 秒窗口 / 1000 宽时 0.25 秒 = 8px）。
// 我们只能在采样点上观察数据，所以标记也应当落在采样点上。
function 吸附(pts, t) {
    if (!pts || !pts.length) return t;
    const i = 下界(pts, t);
    const 后 = pts[Math.min(pts.length - 1, i)];
    const 前 = pts[Math.max(0, i - 1)];
    if (!后) return 前 ? 前.t : t;
    if (!前) return 后.t;
    return Math.abs(后.t - t) <= Math.abs(t - 前.t) ? 后.t : 前.t;
}
// 段内四项指标：显存起伏 / 内存首尾净变化 / GPU 利用率峰值 / 段内采样点数（仅诊断用）
function 段内量(pts, t0, t1) {
    const 无 = { 显存: 0, 内存: 0, gpu: 0, 点数: 0 };
    if (!pts || !pts.length) return 无;
    const i0 = 下界(pts, t0);
    let 首 = null, 末 = null, minV = Infinity, maxV = -Infinity, maxU = 0, n = 0;
    for (let i = i0; i < pts.length && pts[i].t <= t1; i++) {
        const p = pts[i];
        if (!首) 首 = p;
        末 = p; n++;
        if (p.vram_used < minV) minV = p.vram_used;
        if (p.vram_used > maxV) maxV = p.vram_used;
        if ((p.gpu_util || 0) > maxU) maxU = p.gpu_util || 0;
    }
    if (!首) return 无;
    if (首 === 末) {
        // 段内只有 0~1 个采样点（比采样间隔还快）：用段前一点和段后一点估这期间的动静
        const 前 = pts[Math.max(0, i0 - 1)];
        const 后 = pts[Math.min(pts.length - 1, i0)];
        if (!前 || !后 || 前 === 后) return { 显存: 0, 内存: 0, gpu: 0, 点数: n };
        首 = 前; 末 = 后;
        minV = Math.min(前.vram_used, 后.vram_used);
        maxV = Math.max(前.vram_used, 后.vram_used);
        maxU = Math.max(前.gpu_util || 0, 后.gpu_util || 0);
    }
    return {
        显存: maxV - minV,
        内存: Math.abs(末.ram_used - 首.ram_used),
        gpu: maxU,
        点数: n,
    };
}
// stages → 绘制用区间表；i 用于交替配色（相邻段明暗不同才好分界）。
// 起点吸附到最近采样点（理由见 吸附 的注释）：竖线和色带都踩在曲线的数据点上，
// 才不会出现「曲线在右边才涨、竖线在左边」的错位。
// **不做「零占用过滤」**。踩过两次坑后认清两件事：
//   1. Note / Reroute / Primitive 这类「零占用」节点**根本不触发 executing 事件**，
//      它们从第一天起就没进过 stages —— 想过滤的对象本来就不存在。
//   2. 拿「显存/内存没变化」判「没占用」是结构性的错：PyTorch 缓存分配器只向驱动申请、
//      用完不归还，NVML 的 used 是只涨不跌的高水位线，采样器占满 9GB 时读数最平；
//      而 0.25 秒采样粒度又抓不到快节点的 GPU 峰值。任何指标阈值都会误杀真节点。
// 所以执行过的节点一律显示，一个不漏。真要清爽，以后只按节点类型精确挡（确定性、不误杀）。
function buildBands(st, nowSec, pts) {
    const out = [];
    let i = 0;
    for (const s of (st.stages || [])) {
        i++;
        if (s.kind !== "node") continue;
        const t1 = s.end == null ? nowSec : s.end;
        if (t1 <= s.t) continue;
        const a = 吸附(pts, s.t);
        out.push({ t0: a, t1: Math.max(a, t1), name: s.name, i });
    }
    return out;
}
function nodeDisplayName(n) {
    if (!n) return "未知节点";
    const t = n.title || n.type || "节点";
    if (t !== n.type) return t;                       // 用户自定义过标题
    return NODE_ZH[n.type] || n.type;
}

function bindStageEvents(node) {
    const st = node._am;
    st.hStart = () => {
        console.log("[活动监视器] 执行开始");
        addStage(st, "开始执行", "start");
    };
    st.hExec = (e) => {
        try {
            // detail 有两种形态（见 banzhang_dev_utils.js:558 同款处理）：
            //   新版 → {node, display_node, prompt_id} 字典；旧版 → 直接是节点 id。
            // 必须取 node：display_node 指向子图/组的**外层**节点，拿它会把子图内所有节点
            // 压成同一个名字，观感就是「很多节点没识别到」。
            const d = e && e.detail;
            let id = (d && typeof d === "object") ? (d.node ?? d.display_node) : d;
            // 队列空闲时前端会发 executing(null)：这是末段收尾的时机之一
            if (id == null || id === "") {
                closeLastStage(st);
                scheduleDraw(st.node);
                return;
            }
            let n = null;
            try { n = app.graph?.getNodeById?.(id); } catch (_) {}
            if (!n) { try { n = app.graph?.getNodeById?.(parseInt(id, 10)); } catch (_) {} }
            // 子图内部节点在顶层图里查不到 → 退回 display_node 拿外层名，总比 #id 强
            if (!n && d && typeof d === "object" && d.display_node != null && d.display_node !== id) {
                try { n = app.graph?.getNodeById?.(d.display_node); } catch (_) {}
            }
            // 查不到节点也要留下痕迹（#id），不能退化成「未知节点」——那样等于没识别
            const name = n ? nodeDisplayName(n) : ("#" + id);
            console.log("[活动监视器] 节点开始:", id, "→", name, n ? n.type : "(图上找不到)");
            addStage(st, name, "node");
        } catch (err) {
            console.error("[活动监视器] hExec 异常:", err);
        }
    };
    st.hSuccess = () => {
        console.log("[活动监视器] 执行完成");
        addStage(st, "执行完成", "success");
    };
    // 点「停止」中断时没有 success 事件，必须在这里收尾，否则末段色带会一直延长
    st.hInt = () => {
        console.log("[活动监视器] 执行中断");
        closeLastStage(st);
        scheduleDraw(st.node);
    };
    st.hError = (e) => {
        const d = (e && e.detail) || {};
        const n = d.node_type ? { type: d.node_type, title: d.node_type } : null;
        console.log("[活动监视器] 执行错误:", d.node_type || "");
        addStage(st, "执行错误 · " + nodeDisplayName(n), "error");
    };
    api.addEventListener("execution_start", st.hStart);
    api.addEventListener("executing", st.hExec);
    api.addEventListener("execution_success", st.hSuccess);
    api.addEventListener("execution_interrupted", st.hInt);
    api.addEventListener("execution_error", st.hError);
}

// ── 诊断出口 ─────────────────────────────────────────────────
// 控制台跑 bzAmDumpStages()，把每个节点段的「时长 / 显存起伏 / 内存净变化 / GPU 峰值」
// 一次性打出来。现在所有节点段一律显示，这里只看数值 —— 若你觉得某个节点没出现，
// 大概率是它没触发 executing（Note/Reroute 类），或标签在横排里被挤掉了，不是被过滤。
window.bzAmDumpStages = function () {
    const 节点 = [];
    try {
        for (const n of (app.graph?._nodes || app.graph?.nodes || [])) {
            if (n && n._am) 节点.push(n);
        }
    } catch (_) {}
    if (!节点.length) { console.log("画布上没有活动监视器节点"); return; }
    for (const n of 节点) {
        const st = n._am;
        const pts = st.points || [];
        const 末 = pts.length ? pts[pts.length - 1].t : Date.now() / 1000;
        console.log(`%c活动监视器 · 采样点 ${pts.length} · 阶段 ${(st.stages || []).length}`
            + ` · since ${st.since} · inflight ${st.inflight}`
            + ` · 当前跨度 ${fmtWin(winSecOf(n))}（密度 ${densityOf(n).toFixed(3)} 秒/px）`,
            "color:#0A84FF;font-weight:600");
        for (const s of (st.stages || [])) {
            if (s.kind !== "node") continue;
            const t1 = s.end == null ? 末 : s.end;
            const m = 段内量(pts, s.t, t1);
            console.log(`  ${s.name}`
                + ` │ 时长 ${(t1 - s.t).toFixed(2)}s`
                + ` │ 显存起伏 ${(m.显存 / 1048576).toFixed(0)}MB`
                + ` │ 内存净变 ${(m.内存 / 1048576).toFixed(0)}MB`
                + ` │ GPU峰值 ${m.gpu}%`
                + ` │ 采样点 ${m.点数}`);
        }
    }
};

// ── 面板搭建 ─────────────────────────────────────────────────
function setupPanel(node) {
    node.properties = node.properties || {};
    const savedShow = node.properties._bz_am_show;
    const show = savedShow && typeof savedShow === "object"
        ? { vram: savedShow.vram !== false, ram: savedShow.ram !== false }
        : { vram: true, ram: true };

    const root = el("div", "bz-am");
    root.addEventListener("mousedown", (e) => e.stopPropagation());
    root.addEventListener("keydown", (e) => e.stopPropagation());

    const head = el("div", "bz-am-head", root);
    el("div", "bz-am-title", head).textContent = "活动监视器";
    // 时间范围：对数无极滑块（线性的话 1~5 分钟只占轨道 13%，短窗口根本拖不准）
    const slider = el("input", "bz-am-slider", head);
    slider.type = "range";
    slider.min = "0";
    slider.max = "1000";
    slider.step = "1";
    slider.title = "曲线时间范围：拖动无极调节，30 秒 ~ 30 分钟（对数刻度）";
    const winText = el("span", "bz-am-win", head);
    slider.addEventListener("input", () => {
        const sec = Math.round(滑到秒(Number(slider.value)));
        // 滑块改的是密度（秒/像素），不是时间范围本身 —— 宽度变了跨度还得跟着变
        node.properties._bz_am_density = sec / 绘图宽(node);
        const ww = (node.widgets || []).find((x) => x.name === "时间窗");
        if (ww) ww.value = sec;
        winText.textContent = fmtWin(sec);
        drawChart(node);            // 用户手上的操作必须实时，不能节流
    });
    slider.addEventListener("mousedown", (e) => e.stopPropagation());
    slider.addEventListener("pointerdown", (e) => e.stopPropagation());
    const gpu = el("div", "bz-am-gpu", head);

    const stats = el("div", "bz-am-stats", root);
    const mkStat = (key, label, color) => {
        const card = el("div", "bz-am-stat", stats);
        const top = el("div", "bz-am-stat-top", card);
        const dot = el("i", null, top);
        dot.style.background = color;
        el("span", "lbl", top).textContent = label;
        const pct = el("span", "pct", top);
        const sub = el("div", "bz-am-stat-sub", card);
        card.onclick = (e) => {
            e.stopPropagation();
            show[key] = !show[key];
            card.classList.toggle("off", !show[key]);
            node.properties._bz_am_show = { ...show };
            drawChart(node);
        };
        return { card, pct, sub };
    };
    const vram = mkStat("vram", "显存", C_VRAM);
    const ram = mkStat("ram", "内存", C_RAM);

    const chart = el("div", "bz-am-chart", root);
    const canvas = el("canvas", "bz-am-canvas", chart);
    const empty = el("div", "bz-am-empty", chart);
    empty.textContent = "正在采集…";

    chart.addEventListener("mousemove", (e) => {
        const r = chart.getBoundingClientRect();
        node._am.hoverX = e.clientX - r.left;
        scheduleDraw(node);
    });
    chart.addEventListener("mouseleave", () => {
        node._am.hoverX = null;
        scheduleDraw(node);
    });

    node._am = {
        node, root, gpu, slider, winText, canvas, chart, empty, show,
        vramPct: vram.pct, ramPct: ram.pct, vramSub: vram.sub, ramSub: ram.sub,
        points: [], marks: [], stages: [], hoverX: null, inflight: false, since: 0,
    };
    vram.card.classList.toggle("off", !show.vram);
    ram.card.classList.toggle("off", !show.ram);

    const domW = node.addDOMWidget("活动监视器", "活动监视器", root, {
        serialize: false,
        getMinHeight: () => PANEL_H,
        getMinWidth: () => MIN_W,
    });
    domW.computeSize = () => [node.size[0], PANEL_H];

    const ww = (node.widgets || []).find((x) => x.name === "时间窗");
    if (ww) {
        // 本节点从枚举档位改成秒数，旧工作流里存的是 "5 分钟" —— 就地换算，别让它变 NaN
        if (typeof ww.value === "string") ww.value = WIN_OLD[ww.value] || 300;
        ww.hidden = true;
        ww.computeSize = () => [0, -4];
        ww.draw = () => {};
        ww.mouse = () => {};
    }

    const wi = node.widgets.indexOf(domW);
    if (wi > 0) node.widgets.splice(0, 0, node.widgets.splice(wi, 1)[0]);

    const wantW = Math.max(MIN_W, node.properties._bz_am_w || DEFAULT_W);
    node.size[0] = wantW;
    // 密度只在第一次确定，之后固定：老工作流只有「时间窗」，按当时的宽度换算成秒/像素。
    // 不写死的话，每次兜底都除以「当前」宽度，拉宽后时间跨度会原地不动 —— 等于没做联动。
    if (!(typeof node.properties._bz_am_density === "number" && isFinite(node.properties._bz_am_density))) {
        const ww0 = (node.widgets || []).find((x) => x.name === "时间窗");
        let sec0 = ww0 ? Number(ww0.value) : 300;
        if (!isFinite(sec0) || sec0 <= 0) sec0 = 300;
        node.properties._bz_am_density = sec0 / Math.max(80, wantW - PAD_L - PAD_R);
    }

    node.onResize = function (size) {
        const isUser = app.canvas.resizing_node === this;
        if (isUser) {
            this.properties._bz_am_w = Math.max(MIN_W, size[0]);
        }
        const w = isUser ? Math.max(MIN_W, size[0])
            : Math.max(MIN_W, this.properties._bz_am_w || DEFAULT_W);
        const h = this.computeSize()[1];
        if (!this._bz_am_fixing && (Math.abs(size[0] - w) > .5 || Math.abs(size[1] - h) > .5)) {
            this._bz_am_fixing = true;
            this.setSize([w, h]);
            this._bz_am_fixing = false;
        }
    };

    // 拉宽会改变时间跨度（密度不变、绘图区变宽），滑块读数和曲线要一起跟上
    node._am._ro = new ResizeObserver(() => {
        syncSlider(node, false);
        drawChart(node);
    });
    node._am._ro.observe(chart);

    // 监听执行事件：自动标注每个节点阶段
    bindStageEvents(node);

    // 滑块位置按已保存的秒数摆好（旧工作流的枚举值已在上面换成秒）
    syncSlider(node);

    node._am.timer = setInterval(() => {
        const st = node._am;
        if (!st || document.hidden || !node.graph) return;
        // inflight 用时间戳兜底，不用纯布尔：某次 fetch 万一没走到 finally（同步抛错之类），
        // 纯布尔会把轮询永久锁死、曲线彻底冻住 —— 和「执行完了都不更新」同一种症状。
        if (st.inflight && Date.now() - st.inflightAt < 6000) return;
        st.inflight = true;
        st.inflightAt = Date.now();
        // 请求挂死会把 inflight 永久锁住、曲线直接冻住，所以给个硬超时。
        // 采样已经挪到后端线程，超时只是防锁死，放宽到 5 秒（生成期 aiohttp 会被 GIL 挡，
        // 2 秒太容易把正常请求误杀）。
        // AbortController 在老环境里没有 → typeof 判空，拿不到就不设超时，别反而报错。
        const ac = (typeof AbortController === "function") ? new AbortController() : null;
        const 超时 = ac ? setTimeout(() => { try { ac.abort(); } catch (_) {} }, 5000) : null;
        fetch(`/banzhang/mem_graph?since=${st.since || 0}`, ac ? { signal: ac.signal } : undefined)
            .then((res) => (res.ok ? res.json() : null))
            .then((data) => {
                合并采样(st, data);
                if (st.points.length) updateStats(node);
                scheduleDraw(node);
            })
            .catch(() => {})
            .finally(() => {
                if (超时) clearTimeout(超时);
                st.inflight = false;
            });
    }, POLL_MS);

    requestAnimationFrame(() => {
        const h = node.computeSize()[1];
        node.setSize([wantW, h]);
        drawChart(node);
    });
}

app.registerExtension({
    name: "BanZhang.MemGraph",
    beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== "BanZhang_Mem_Graph") return;

        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const r = onNodeCreated ? onNodeCreated.apply(this, arguments) : undefined;
            setupPanel(this);
            return r;
        };

        const onConfigure = nodeType.prototype.configure;
        nodeType.prototype.configure = function () {
            const r = onConfigure ? onConfigure.apply(this, arguments) : undefined;
            if (this._am) {
                // 旧工作流存的是 "5 分钟"，读档后立刻换成秒，否则保存时又写回字符串
                const ww = (this.widgets || []).find((x) => x.name === "时间窗");
                if (ww && typeof ww.value === "string") ww.value = WIN_OLD[ww.value] || 300;
                // 读档来的老工作流没有密度：按存下来的宽度换算一次并写死
                if (!(typeof this.properties._bz_am_density === "number"
                    && isFinite(this.properties._bz_am_density))) {
                    let sec0 = ww ? Number(ww.value) : 300;
                    if (!isFinite(sec0) || sec0 <= 0) sec0 = 300;
                    const w0 = Math.max(MIN_W, this.properties._bz_am_w || DEFAULT_W);
                    this.properties._bz_am_density = sec0 / Math.max(80, w0 - PAD_L - PAD_R);
                }
                syncSlider(this);
                requestAnimationFrame(() => {
                    const w = Math.max(MIN_W, this.properties._bz_am_w || DEFAULT_W);
                    this.setSize([w, this.computeSize()[1]]);
                    drawChart(this);
                });
            }
            return r;
        };

        const onRemoved = nodeType.prototype.onRemoved;
        nodeType.prototype.onRemoved = function () {
            const st = this._am;
            if (st) {
                clearInterval(st.timer);
                st._ro?.disconnect();
                api.removeEventListener("execution_start", st.hStart);
                api.removeEventListener("executing", st.hExec);
                api.removeEventListener("execution_success", st.hSuccess);
                api.removeEventListener("execution_interrupted", st.hInt);
                api.removeEventListener("execution_error", st.hError);
            }
            return onRemoved ? onRemoved.apply(this, arguments) : undefined;
        };
    },
});
