import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { renderCards } from "./banzhang_sp_cards.js";

// 🎬 剧本全流程 V3：单页流水线（无标签页）
// 顶部分段进度 → 文件芯片 → 资产区块（类型筛选）→ 核心帧区块（门槛提示）
// → 日志抽屉 → 底部控制条。两档高度：展开（内部滚动）/ 折叠（仅状态条）。
const WIDGET = "file_list_json";
const BODY_H = 300;       // 卡片滚动区高度（卡片再多也不撑高节点）
const EXPAND_H = 500;     // 展开态面板总高（分段+来源+文件+滚动区+日志头+控制条）
const COLLAPSE_H = 34;    // 折叠态面板总高
const TYPES = ["主体", "服装", "道具", "场景", "色板"];
const SRC_W = { asset: "🎨 资产生图来源", kf: "🎨 核心帧生图来源" };
const SRC_PORT = { asset: "🔌 本地资产引擎", kf: "🔌 本地核心帧引擎" };

const SVG = {
    file: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>',
    plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
    image: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2.5"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/></svg>',
    film: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="5" width="19" height="14" rx="2.5"/><path d="M7 5v14M17 5v14M3 9h4M3 15h4M17 9h4M17 15h4"/></svg>',
    log: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6h16M4 12h16M4 18h10"/></svg>',
    warn: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5.5M12 16.5h.01"/></svg>',
    stop: '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="1.6"/></svg>',
    play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 4.5v15l13-7.5z"/></svg>',
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="5 12.5 10 17.5 19 7"/></svg>',
    chev: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>',
    x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>',
    upload: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 15V4M7.5 8.5 12 4l4.5 4.5"/><path d="M4 16.5V18a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-1.5"/></svg>',
};

function css() {
    const s = document.createElement("style");
    s.textContent = `
.spv{--bg:#1c1e24;--text:#e8e8e8;--text-2:#b8bdc8;--text-3:#8a909c;--line:#4a5468;--blue:#4a9eff;--green:#4caf7d;--red:#ff6b6b;--amber:#e0a93b;width:100%;font-family:'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif;padding:4px 8px 6px;box-sizing:border-box;user-select:none}
.spv button{font-family:inherit}
.spv svg{display:block}

/* ── 折叠态状态条 ── */
.spv-colbar{display:none;align-items:center;gap:8px;height:24px;cursor:pointer}
.spv-colbar .spv-col-ic{width:13px;height:13px;color:var(--blue);flex-shrink:0}
.spv-colbar .spv-col-txt{font-size:11px;color:var(--text-2);white-space:nowrap;flex-shrink:0}
.spv-colbar .spv-col-line{flex:1;height:3px;background:rgba(255,255,255,.08);border-radius:2px;overflow:hidden;min-width:30px}
.spv-colbar .spv-col-line i{display:block;height:100%;background:var(--blue);border-radius:2px;transition:width .3s}
.spv-colbar .spv-col-pct{font-size:10.5px;color:var(--text-3);width:34px;text-align:right;flex-shrink:0}
.spv-colbar .spv-col-chev{width:13px;height:13px;color:var(--text-3);flex-shrink:0}
.spv.collapsed .spv-colbar{display:flex}
.spv.collapsed .spv-seg,.spv.collapsed .spv-src,.spv.collapsed .spv-files,.spv.collapsed .spv-body,.spv.collapsed .spv-log,.spv.collapsed .spv-ctrl{display:none}

/* ── 分段进度 ── */
.spv-seg{display:flex;align-items:center;margin-bottom:9px}
.spv-seg-item{display:flex;align-items:center;gap:5px;font-size:10.5px;color:var(--text-3);white-space:nowrap}
.spv-seg-dot{width:15px;height:15px;border-radius:50%;border:1.5px solid var(--line);display:flex;align-items:center;justify-content:center;flex-shrink:0;background:var(--bg)}
.spv-seg-dot svg{width:9px;height:9px;display:none}
.spv-seg-item.ok{color:var(--green)}.spv-seg-item.ok .spv-seg-dot{background:var(--green);border-color:var(--green)}
.spv-seg-item.ok .spv-seg-dot svg{display:block;color:#fff}
.spv-seg-item.run{color:var(--blue)}.spv-seg-item.run .spv-seg-dot{border-color:var(--blue)}
.spv-seg-item.run .spv-seg-dot::before{content:"";width:7px;height:7px;border-radius:50%;background:var(--blue);animation:spv-pulse 1.1s ease-in-out infinite}
.spv-seg-item.err .spv-seg-dot{border-color:var(--red)}
.spv-seg-link{flex:1;height:1.5px;background:var(--line);margin:0 6px;min-width:8px;border-radius:1px}
.spv-seg-link.ok{background:var(--green)}
@keyframes spv-pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.35;transform:scale(.7)}}
@keyframes spv-spin{to{transform:rotate(360deg)}}

/* ── 文件芯片 ── */
.spv-files{display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-bottom:10px}
.spv-chip{display:flex;align-items:center;gap:6px;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.09);border-radius:14px;padding:3px 6px 3px 9px;font-size:11px;color:var(--text-2);max-width:176px}
.spv-chip svg{width:12px;height:12px;flex-shrink:0;color:var(--blue)}
.spv-chip .spv-chip-nm{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.spv-chip .spv-x{width:16px;height:16px;border-radius:50%;display:flex;align-items:center;justify-content:center;color:var(--text-3);flex-shrink:0}
.spv-chip .spv-x svg{width:9px;height:9px}
.spv-chip .spv-x:hover{background:rgba(255,107,107,.16);color:var(--red)}
.spv-chip-add{border-style:dashed!important;border-color:var(--line)!important;background:transparent;color:var(--text-3);padding:3px 10px!important;cursor:pointer}
.spv-chip-add:hover{border-color:var(--blue)!important;color:var(--blue);background:rgba(74,158,255,.06)!important}
.spv-chip-add svg{color:inherit}
.spv-zone{border:1.5px dashed var(--line);border-radius:8px;height:44px;display:flex;align-items:center;justify-content:center;color:var(--text-3);font-size:11.5px;background:rgba(255,255,255,.03);width:100%;cursor:default}
.spv.dragging{outline:1.5px dashed var(--blue);outline-offset:2px;border-radius:6px}
.spv.dragging .spv-zone,.spv.dragging .spv-chip-add{border-color:var(--blue)!important;color:var(--blue);background:rgba(74,158,255,.07)!important}

/* ── 生图来源条（资产/核心帧各自云API或本地工作流） ── */
.spv-src{display:flex;align-items:center;gap:14px;margin-bottom:10px}
.spv-src-group{display:flex;align-items:center;gap:6px}
.spv-src-label{font-size:10.5px;color:var(--text-3);white-space:nowrap}
.spv-src-seg{display:flex;border:1px solid var(--line);border-radius:6px;overflow:hidden}
.spv-src-btn{padding:2.5px 8px;font-size:10.5px;background:transparent;color:var(--text-3);border:none;cursor:pointer;display:inline-flex;align-items:center;gap:3px;line-height:1.5}
.spv-src-btn+.spv-src-btn{border-left:1px solid var(--line)}
.spv-src-btn:hover:not(:disabled):not(.on){color:var(--text-2);background:rgba(255,255,255,.05)}
.spv-src-btn.on{background:var(--blue);color:#fff}
.spv-src-btn.on.local{background:var(--green)}
.spv-src-btn:disabled{opacity:.35;cursor:not-allowed}

/* ── 区块 ── */
.spv-block{margin-bottom:11px}
.spv-block-head{display:flex;align-items:center;gap:7px;margin-bottom:7px}
.spv-block-head .spv-bic{width:14px;height:14px;color:var(--text-2)}
.spv-block-head .spv-tt{font-size:12px;font-weight:600;color:var(--text)}
.spv-block-head .spv-cnt{font-size:10.5px;color:var(--text-3)}
.spv-impbtn{margin-left:auto;display:inline-flex;align-items:center;gap:4px;padding:3px 9px;font-size:10.5px;color:var(--text-2);background:transparent;border:1px solid var(--line);border-radius:6px;cursor:pointer;transition:color .15s,border-color .15s,background .15s}
.spv-impbtn svg{width:11px;height:11px}
.spv-impbtn:hover{color:var(--blue);border-color:var(--blue);background:rgba(74,158,255,.08)}
.spv-impbtn.busy{pointer-events:none;opacity:.5}
.spv-filters{display:flex;gap:5px;flex-wrap:wrap;margin-bottom:8px}
.spv-ftag{font-size:10.5px;color:var(--text-3);padding:2.5px 9px;border-radius:11px;border:1px solid transparent;line-height:1.4;cursor:pointer;background:transparent}
.spv-ftag .n{opacity:.6;margin-left:2px}
.spv-ftag:hover{color:var(--text-2);background:rgba(255,255,255,.05)}
.spv-ftag.on{color:var(--blue);background:rgba(74,158,255,.1);border-color:rgba(74,158,255,.35)}
.spv-gate{display:none;align-items:center;gap:7px;margin-bottom:8px;background:rgba(224,169,59,.08);border:1px solid rgba(224,169,59,.3);border-radius:6px;padding:6px 9px;font-size:10.5px;color:#d9b874;line-height:1.5}
.spv-gate svg{width:13px;height:13px;flex-shrink:0}
.spv-gated .spv-gate{display:flex}
.spv-gated .spv-grid{opacity:.5;filter:saturate(.4)}

/* ── 卡片（由 banzhang_sp_cards.js 生成） ── */
.spv-body{height:${BODY_H}px;overflow:auto;padding:2px 2px 4px}
.spv-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}
.spv-card{background:#17181d;border:1px solid rgba(255,255,255,.09);border-radius:8px;overflow:hidden;position:relative;transition:border-color .15s}
.spv-card:hover{border-color:rgba(255,255,255,.18)}
.spv-thumb{position:relative;aspect-ratio:3/4;background:#14151a;cursor:zoom-in;display:flex;align-items:center;justify-content:center;overflow:hidden}
.spv-thumb img{width:100%;height:100%;object-fit:cover;display:block}
.spv-ph{color:var(--text-3);display:flex;flex-direction:column;align-items:center;gap:5px;width:100%;height:100%;justify-content:center;background:repeating-linear-gradient(45deg,#16181d,#16181d 7px,#181a20 7px,#181a20 14px)}
.spv-ph svg{width:22px;height:22px}
.spv-ph span{font-size:10px}
.spv-pending .spv-thumb{cursor:default}
.spv-sdot{position:absolute;left:6px;bottom:6px;width:11px;height:11px;border-radius:50%;border:2px solid #17181d;z-index:3}
.spv-sdot-ok{background:var(--green)}.spv-sdot-locked{background:var(--amber)}.spv-sdot-failed{background:var(--red)}
.spv-sdot-running{background:var(--blue);animation:spv-pulse 1.1s ease-in-out infinite}
.spv-locked{border-color:rgba(224,169,59,.55)}
.spv-locked .spv-thumb img{filter:saturate(.55) brightness(.86)}
.spv-lock-badge{position:absolute;top:5px;right:5px;z-index:3;color:var(--amber);background:rgba(20,20,24,.7);border-radius:5px;padding:2px}
.spv-lock-badge svg{width:11px;height:11px}
.spv-failed{border-color:rgba(255,107,107,.6)}
.spv-failed .spv-thumb{cursor:default}
.spv-failed .spv-hoverbar{display:none}
.spv-retry-fab{position:absolute;inset:0;margin:auto;width:38px;height:38px;border-radius:50%;background:rgba(255,107,107,.92);display:flex;align-items:center;justify-content:center;z-index:4;box-shadow:0 3px 10px rgba(0,0,0,.4);border:none;cursor:pointer}
.spv-retry-fab svg{width:17px;height:17px;color:#fff}
.spv-retry-fab:hover{background:var(--red)}
.spv-run-mask{position:absolute;inset:0;background:rgba(20,26,36,.62);display:flex;align-items:center;justify-content:center;z-index:2}
.spv-spinner{width:24px;height:24px;border:2.5px solid rgba(255,255,255,.22);border-top-color:var(--blue);border-radius:50%;animation:spv-spin .8s linear infinite}
.spv-hoverbar{position:absolute;top:5px;left:5px;right:5px;display:flex;gap:4px;justify-content:flex-end;opacity:0;transform:translateY(-3px);transition:opacity .14s,transform .14s;z-index:5}
.spv-card:hover .spv-hoverbar{opacity:1;transform:translateY(0)}
.spv-hbtn{width:24px;height:24px;border-radius:6px;display:flex;align-items:center;justify-content:center;background:rgba(20,20,24,.78);color:#d8dbe2;border:none;padding:0;cursor:pointer}
.spv-hbtn svg{width:13px;height:13px}
.spv-hbtn:hover{background:rgba(74,158,255,.92);color:#fff}
.spv-meta{padding:6px 7px 7px}
.spv-nm{font-size:11.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--text)}
.spv-sub{display:flex;align-items:center;gap:6px;margin-top:3px;font-size:10px;color:var(--text-3)}
.spv-sub .spv-ty{flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.spv-sub .spv-seed{color:var(--text-3);flex-shrink:0}
.spv-refs{display:flex;align-items:center;gap:4px;margin-top:6px;flex-wrap:wrap}
.spv-ref-tag{font-size:10px;color:var(--text-3);flex-shrink:0}
.spv-ref-none{font-style:italic}
.spv-ref{width:21px;height:21px;border-radius:5px;overflow:hidden;border:1.5px solid var(--line);flex-shrink:0;position:relative;background:#14151d}
.spv-ref img{width:100%;height:100%;object-fit:cover;cursor:zoom-in}
.spv-ref-no{position:absolute;left:0;bottom:0;right:0;text-align:center;font-size:7.5px;line-height:1.15;background:rgba(0,0,0,.62);color:#cfd3da}
.spv-ref-miss{border-color:var(--red);display:flex;align-items:center;justify-content:center}
.spv-ref-miss svg{width:10px;height:10px;color:var(--red)}
.spv-ref-wait{border-style:dashed}
.spv-err{font-size:10px;color:var(--red);padding-top:4px;line-height:1.45;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.spv-empty{padding:24px 8px;text-align:center;color:var(--text-3);font-size:11px;line-height:1.7}

/* ── 日志抽屉 ── */
.spv-log{border-top:1px solid rgba(255,255,255,.08);margin-top:2px}
.spv-log-head{width:100%;display:flex;align-items:center;gap:7px;padding:6px 2px;font-size:11px;color:var(--text-2);background:none;border:none;cursor:pointer}
.spv-log-head .spv-bic{width:13px;height:13px}
.spv-log-dot{width:7px;height:7px;border-radius:50%;background:var(--red);display:none}
.spv-log.has-err .spv-log-dot{display:block}
.spv-log-chev{margin-left:auto;width:13px;height:13px;color:var(--text-3);transition:transform .18s}
.spv-log.open .spv-log-chev{transform:rotate(180deg)}
.spv-log-body{display:none;height:108px;overflow:auto;font-size:10.5px;line-height:1.65;color:var(--text-2);background:rgba(0,0,0,.2);border-radius:6px;padding:7px 9px;font-family:'Cascadia Code',Consolas,monospace;white-space:pre-wrap;word-break:break-all}
.spv-log.open .spv-log-body{display:block}
.spv-log-body .err{color:var(--red)}.spv-log-body .ok{color:var(--green)}

/* ── 底部控制条 ── */
.spv-ctrl{border-top:1px solid rgba(255,255,255,.08);padding-top:8px;margin-top:2px}
.spv-pline{height:4px;background:rgba(255,255,255,.08);border-radius:2px;overflow:hidden;margin-bottom:8px}
.spv-pfill{display:block;height:100%;background:var(--blue);border-radius:2px;transition:width .3s}
.spv-ctrl-row{display:flex;align-items:center;gap:8px}
.spv-pct{font-size:11px;color:var(--text-2);font-variant-numeric:tabular-nums;width:34px;flex-shrink:0}
.spv-status{flex:1;font-size:10.5px;color:var(--text-3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.spv-stop{width:28px;height:28px;border-radius:6px;border:1px solid var(--line);display:none;align-items:center;justify-content:center;color:var(--text-2);background:transparent;flex-shrink:0}
.spv-stop svg{width:12px;height:12px}
.spv-stop:hover{border-color:var(--red);color:var(--red)}
.spv.working .spv-stop{display:flex}
.spv-go{display:flex;align-items:center;gap:6px;font-size:11.5px;font-weight:600;background:var(--blue);color:#fff;border-radius:6px;padding:6px 13px;border:none;cursor:pointer;transition:background .15s,opacity .15s;flex-shrink:0}
.spv-go:hover{background:#3d8df0}
.spv-go:disabled{background:rgba(255,255,255,.08);color:var(--text-3);font-weight:500;cursor:default}
.spv-go-spin{width:12px;height:12px;border:2px solid rgba(255,255,255,.3);border-top-color:#fff;border-radius:50%;animation:spv-spin .8s linear infinite;display:none}
.spv.working .spv-go .spv-go-spin{display:block}
.spv.working .spv-go .spv-go-ic{display:none}
.spv-go.done{background:rgba(76,175,125,.16);color:var(--green)}
.spv-go.done .spv-go-ic{display:block}

/* ── 灯箱 ── */
.spv-light{position:fixed;inset:0;background:rgba(10,11,14,.88);z-index:99999;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:10px;cursor:zoom-out}
.spv-light img{max-width:92vw;max-height:86vh;border-radius:8px}
.spv-light-nav{font-size:11px;color:#fff;opacity:.75;cursor:default}
`;
    document.head.appendChild(s);
}
css();

async function post(route, data) {
    const res = await api.fetchApi(route, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
    });
    const j = await res.json().catch(() => null);
    if (!res.ok) {
        alert(j?.error || `请求失败 (${res.status})`);
        return null;
    }
    return j;
}

function makeSession(files) {
    const str = files.map((f) => f.path).sort().join("|");
    let h = 0;
    for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0;
    return "s" + Math.abs(h).toString(36);
}

function el(tag, cls) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    return e;
}

function lightbox(item, list, viewUrlFn) {
    const m = el("div", "spv-light");
    const im = el("img");
    const nav = el("div", "spv-light-nav");
    m.append(im, nav);
    const pool = (list && list.length ? list : [item]).filter((x) => x && x.file);
    let idx = pool.findIndex((x) => x === item);
    if (idx < 0) idx = 0;
    const show = () => {
        const cur = pool[idx];
        im.src = viewUrlFn(cur.file, cur.subfolder);
        nav.textContent = pool.length > 1
            ? `${idx + 1} / ${pool.length}　${cur.name}　← → 切换 · ESC 关闭`
            : `${cur.name}　ESC 关闭`;
    };
    const move = (d) => { idx = (idx + d + pool.length) % pool.length; show(); };
    const cleanup = () => { document.removeEventListener("keydown", onKey); m.remove(); };
    const onKey = (e) => {
        if (e.key === "Escape") cleanup();
        else if (e.key === "ArrowLeft") move(-1);
        else if (e.key === "ArrowRight") move(1);
    };
    show();
    m.onclick = (e) => { if (e.target === m) cleanup(); };
    document.addEventListener("keydown", onKey);
    document.body.appendChild(m);
}

const stat = (list) => {
    const c = { pending: 0, running: 0, ok: 0, failed: 0, locked: 0 };
    list.forEach((x) => { c[x.status] = (c[x.status] || 0) + 1; });
    return c;
};
const done = (x) => x.status === "ok" || x.status === "locked";

function getParams(node) {
    const w = (n) => node.widgets.find((x) => x.name === n)?.value;
    return {
        url: w("🔗 API地址"), key: w("🔑 API密钥"), model: w("🤖 模型名称"),
        size_rule: w("📐 尺寸规则"), size_preset: w("🖥️ 尺寸预设"),
        width: w("↔️ 宽"), height: w("↕️ 高"), seed: w("🎲 起始种子"),
        seed_control: w("🎲 种子控制"), timeout: w("⏱️ 超时秒数"),
        out_dir: w("📁 输出目录"),
    };
}

async function upload(file) {
    const res = await api.fetchApi("/banzhang/upload_script", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: file.name, content: await file.text() }),
    });
    if (!res.ok) throw new Error("上传失败");
    return res.json();
}

/* 接收拖入或选择的文件（.md/.txt），统一走 upload → 入列 → rebuild */
async function ingestFiles(node, fileList) {
    let added = 0;
    for (const f of [...fileList].filter((x) => /\.(md|txt)$/i.test(x.name))) {
        try {
            const text = await f.text();
            const saved = await upload(f);
            const first = text.split("\n").map((l) => l.trim()).find(Boolean) || "(空文件)";
            node._bzFiles.push({ path: saved.path, name: saved.name, preview: first.slice(0, 46) });
            added++;
        } catch (err) { alert(`「${f.name}」失败：${err}`); }
    }
    if (added) await syncFiles(node, true);
}

const IMG_RE = /\.(png|jpe?g|webp|bmp)$/i;

/* 批量导入已按资产名命名的图片：后端按文件名匹配资产并直接标记完成，跳过生成 */
async function ingestImages(node, fileList) {
    const imgs = [...fileList].filter((x) => IMG_RE.test(x.name));
    if (!imgs.length) return;
    if (!node._bzFiles || !node._bzFiles.length) {
        alert("请先拖入剧本文件，再导入资产图（图片文件名要与资产名一致）");
        return;
    }
    if (node._bzRunning) {
        alert("请先点停止按钮结束当前运行，再导入图片");
        return;
    }
    const btn = node._bzImpBtn;
    const label = btn?.querySelector(".spv-imp-txt");
    if (btn) btn.classList.add("busy");
    if (label) label.textContent = "导入中…";
    try {
        const fd = new FormData();
        fd.append("session", node._bzSession);
        fd.append("out_dir", getParams(node).out_dir || "");
        imgs.forEach((f) => fd.append("images", f, f.name));
        const res = await api.fetchApi("/banzhang/sp_import_assets", { method: "POST", body: fd });
        const j = await res.json().catch(() => null);
        if (!res.ok) {
            alert(j?.error || `导入失败 (${res.status})`);
            return;
        }
        node._bzState = j;
        renderAll(node);
        if (j.unmatched?.length) {
            node._bzStatusText = `已导入 ${j.imported?.length || 0} 张，${j.unmatched.length} 张未匹配（详见日志）`;
            renderBar(node);
            setTimeout(() => { if (node._bzState === j) { node._bzStatusText = null; renderBar(node); } }, 5000);
        }
    } catch (err) {
        alert(`导入失败：${err}`);
    } finally {
        if (btn) btn.classList.remove("busy");
        if (label) label.textContent = "导入已有图";
    }
}

/* ================= 渲染 ================= */
function renderSeg(node) {
    const s = node._bzState;
    const ac = stat(s.assets), kc = stat(s.kfs);
    const aDone = ac.ok + ac.locked, kDone = kc.ok + kc.locked;
    // 运行态只认 _bzRunning（stage 仅表示进度阶段，中断/失败后 stage 会停在 asset/kf）
    const running = !!node._bzRunning;
    const aAll = s.assets.length > 0 && aDone === s.assets.length;
    const kfAll = s.kfs.length > 0 && kDone === s.kfs.length;
    let assetCls, kfCls;
    if (running && s.stage === "asset") assetCls = ac.failed ? "err" : "run";
    else if (ac.failed) assetCls = "err";
    else if (aAll) assetCls = "ok";
    else assetCls = "";
    if (running && s.stage === "kf") kfCls = "run";
    else if (kfAll) kfCls = "ok";
    else if (kc.failed) kfCls = "err";
    else kfCls = "";
    const defs = [
        { label: "解析", cls: (s.assets.length + s.kfs.length) ? "ok" : "" },
        { label: `资产 ${aDone}/${s.assets.length}`, cls: assetCls },
        { label: `核心帧 ${kDone}/${s.kfs.length}`, cls: kfCls },
        { label: "完成", cls: kfAll || s.stage === "done" ? "ok" : "" },
    ];
    node._bzSeg.innerHTML = "";
    defs.forEach((d, i) => {
        if (i > 0) {
            const link = el("span", "spv-seg-link" + (defs[i - 1].cls === "ok" && d.cls === "ok" ? " ok" : ""));
            node._bzSeg.appendChild(link);
        }
        const item = el("span", "spv-seg-item " + d.cls);
        const dot = el("span", "spv-seg-dot");
        dot.innerHTML = SVG.check;
        const t = el("span");
        t.textContent = d.label;
        item.append(dot, t);
        node._bzSeg.appendChild(item);
    });
}

function renderFiles(node) {
    const box = node._bzFilesBox;
    box.innerHTML = "";
    if (!node._bzFiles.length) {
        const zone = el("div", "spv-zone");
        zone.textContent = "把 .md / .txt 剧本（含色板文件）拖到这里，或点击选择";
        zone.onclick = (e) => { e.stopPropagation(); node._bzFileInput.click(); };
        box.appendChild(zone);
        return;
    }
    node._bzFiles.forEach((f, i) => {
        const c = el("div", "spv-chip");
        c.innerHTML = SVG.file;
        const nm = el("span", "spv-chip-nm");
        nm.textContent = f.name;
        const x = el("button", "spv-x");
        x.innerHTML = SVG.x;
        x.title = "移除";
        x.onclick = (e) => { e.stopPropagation(); node._bzFiles.splice(i, 1); syncFiles(node, true); };
        c.append(nm, x);
        box.appendChild(c);
    });
    const add = el("button", "spv-chip spv-chip-add");
    add.innerHTML = SVG.plus + "<span>添加剧本</span>";
    add.onclick = (e) => { e.stopPropagation(); node._bzFileInput.click(); };
    box.appendChild(add);
}

function renderFilters(node) {
    const counts = { 全部: node._bzState.assets.length };
    TYPES.forEach((t) => { counts[t] = node._bzState.assets.filter((a) => a.type === t).length; });
    const tags = ["全部", ...TYPES.filter((t) => counts[t] > 0)];
    node._bzFilters.innerHTML = "";
    tags.forEach((t) => {
        const b = el("button", "spv-ftag" + (node._bzFilter === t ? " on" : ""));
        b.innerHTML = `${t}<span class="n">${counts[t]}</span>`;
        b.onclick = (e) => { e.stopPropagation(); node._bzFilter = t; renderFilters(node); renderAssetGrid(node); };
        node._bzFilters.appendChild(b);
    });
}

function cardHandlers(node) {
    const viewUrlFn = (file, subfolder) => {
        const q = new URLSearchParams({ filename: file, type: "output" });
        if (subfolder) q.set("subfolder", subfolder);
        return `/view?${q.toString()}`;
    };
    return {
        onPreview: (it, list) => lightbox(it, list, viewUrlFn),
        onLock: async (kind, it) => {
            const lock = it.status !== "locked";
            const s = node._bzState;
            node._bzState = (await post("/banzhang/sp_lock", {
                session: s.session, kind, id: it.id, locked: lock,
            })) || s;
            renderAll(node);
        },
        onRerun: async (kind, it) => {
            if (node._bzRunning) {
                alert("请先点停止按钮结束当前运行，再单独重生");
                return;
            }
            const srcW = node.widgets?.find((x) => x.name === SRC_W[kind]);
            const local = srcW && String(srcW.value).includes("本地");
            if (local) {
                // 本地模式：HTTP 路由拿不到连线上的引擎，标记 pending 后重跑整个节点
                // （引擎只跑 pending，其他已完成/锁定项直接跳过）
                if (!portConnected(node, SRC_PORT[kind])) {
                    alert("本地引擎未连接，请先连接对应的本地生图器节点");
                    return;
                }
                const s = node._bzState;
                node._bzState = (await post("/banzhang/sp_mark_rerun", {
                    session: s.session, kind, id: it.id,
                })) || s;
                renderAll(node);
                node._bzRunning = true;
                node._bzStatusText = `重生中：${it.name}`;
                renderBar(node);
                app.queuePrompt(0, 1);
                return;
            }
            node._bzStatusText = `重生中：${it.name}`;
            renderBar(node);
            const s = node._bzState;
            node._bzState = (await post("/banzhang/sp_rerun", {
                session: s.session, kind, id: it.id, params: getParams(node),
            })) || s;
            renderAll(node);
        },
    };
}

function renderAssetGrid(node) {
    const s = node._bzState;
    const list = node._bzFilter === "全部" ? s.assets : s.assets.filter((a) => a.type === node._bzFilter);
    const asc = stat(s.assets);
    node._bzAssetCnt.textContent = `${asc.ok + asc.locked}/${s.assets.length} 就绪`;
    node._bzAssetGrid.innerHTML = "";
    node._bzAssetGrid.appendChild(
        renderCards("asset", list, Object.fromEntries(s.assets.map((a) => [a.id, a])),
                    node._bzHandlers, s.assets));
}

function renderKfGrid(node) {
    const s = node._bzState;
    const c = stat(s.kfs);
    node._bzKfCnt.textContent = `${c.ok + c.locked}/${s.kfs.length} 完成`;
    const blocked = s.assets.filter((a) => !done(a)).length;
    node._bzKfBlock.classList.toggle("spv-gated", s.stage !== "done" && blocked > 0);
    node._bzGateTxt.textContent = `${blocked} 项资产未就绪，核心帧排队中（资产完成后自动开始）`;
    node._bzKfGrid.innerHTML = "";
    node._bzKfGrid.appendChild(
        renderCards("kf", s.kfs, Object.fromEntries(s.assets.map((a) => [a.id, a])),
                    node._bzHandlers, s.assets));
}

function renderLogs(node) {
    const s = node._bzState;
    const body = node._bzLogBody;
    body.innerHTML = "";
    s.logs.forEach((line) => {
        const d = el("div");
        d.className = line.includes("失败") ? "err" : (line.includes("完成") ? "ok" : "");
        d.textContent = line;
        body.appendChild(d);
    });
    body.scrollTop = body.scrollHeight;
    node._bzLogDrawer.classList.toggle("has-err", s.logs.some((l) => l.includes("失败")));
}

function renderBar(node) {
    const s = node._bzState;
    const ac = stat(s.assets), kc = stat(s.kfs);
    const total = s.assets.length + s.kfs.length;
    const doneN = ac.ok + ac.locked + kc.ok + kc.locked;
    const pct = total ? Math.round(doneN / total * 100) : 0;
    node._bzPfill.style.width = pct + "%";
    node._bzPct.textContent = pct + "%";
    // 运行态只认 _bzRunning；stage 是进度阶段，中断/部分失败后会停在 asset/kf
    const running = !!node._bzRunning;
    node._bzRoot.classList.toggle("working", running);

    // 折叠态同步
    const colText = s.stage === "done" ? "全部完成"
        : s.stage === "kf" ? `核心帧 ${kc.ok + kc.locked}/${s.kfs.length}`
        : (s.assets.length ? `资产 ${ac.ok + ac.locked}/${s.assets.length}` : "未载入剧本");
    node._bzColTxt.textContent = colText;
    node._bzColFill.style.width = pct + "%";
    node._bzColPct.textContent = pct + "%";

    // 状态文字
    if (node._bzStatusText) {
        node._bzStatus.textContent = node._bzStatusText;
    } else if (!s.assets.length) {
        node._bzStatus.textContent = "拖入剧本文件 → 填好 API 参数 → 点开始生成";
    } else if (s.stage === "done") {
        node._bzStatus.textContent = `全部完成 · ${s.assets.length} 项资产 · ${s.kfs.length} 张核心帧`;
    } else if (running) {
        const cur = [...s.assets, ...s.kfs].find((x) => x.status === "running");
        const stageCn = s.stage === "kf" ? "核心帧" : "资产";
        node._bzStatus.textContent = cur ? `${stageCn}生成中：${cur.name}` : `${stageCn}生成中…`;
    } else if (s.stage === "kf") {
        node._bzStatus.textContent = `核心帧 ${kc.ok + kc.locked}/${s.kfs.length}${kc.failed ? ` · ${kc.failed} 项失败` : ""} · 已暂停`;
    } else {
        node._bzStatus.textContent = `资产 ${ac.ok + ac.locked}/${s.assets.length}${ac.failed ? ` · ${ac.failed} 项失败` : ""} · 已暂停`;
    }

    // 主按钮文案
    const go = node._bzGo, txt = node._bzGoTxt;
    go.classList.remove("done");
    node._bzGoIc.innerHTML = SVG.play;
    if (running) {
        go.disabled = true;
        txt.textContent = "生成中…";
    } else if (s.stage === "done") {
        go.disabled = true;
        go.classList.add("done");
        node._bzGoIc.innerHTML = SVG.check;
        txt.textContent = "全部完成";
    } else if (!s.assets.length) {
        go.disabled = true;
        txt.textContent = "开始生成";
    } else if (s.stage === "kf") {
        const wait = s.kfs.filter((x) => x.status === "pending" || x.status === "failed").length;
        go.disabled = wait === 0;
        txt.textContent = `继续生成 ${wait} 张核心帧`;
    } else {
        // parse / asset 阶段：失败优先提示重试
        const wait = s.assets.filter((x) => x.status === "pending" || x.status === "failed").length;
        const started = ac.ok + ac.locked + ac.failed > 0;
        go.disabled = wait === 0;
        txt.textContent = ac.failed > 0
            ? `重试 ${ac.failed} 项失败并继续`
            : `${started ? "继续" : "开始"}生成 ${wait} 项`;
    }
}

function renderAll(node) {
    renderSeg(node);
    renderSource(node);
    renderFiles(node);
    renderFilters(node);
    renderAssetGrid(node);
    renderKfGrid(node);
    renderLogs(node);
    renderBar(node);
}

// 引擎端口是否已连线（node.inputs 为 litegraph 端口描述数组）
function portConnected(node, name) {
    const inp = node.inputs?.find((x) => x.name === name);
    return !!(inp && inp.link !== null && inp.link !== undefined && inp.link !== -1);
}

function setSource(node, kind, value) {
    const w = node.widgets?.find((x) => x.name === SRC_W[kind]);
    if (!w) return;
    w.value = value;
    if (w.callback) w.callback.call(w, value);
    renderSource(node);
    app.graph.setDirtyCanvas(true, true);
}

// 来源分段条：按 widget 值高亮，按连线状态决定本地项可否点击
function renderSource(node) {
    if (!node._bzSrc) return;
    for (const kind of ["asset", "kf"]) {
        const w = node.widgets?.find((x) => x.name === SRC_W[kind]);
        const connected = portConnected(node, SRC_PORT[kind]);
        const value = w?.value || "☁️ 云API";
        const local = String(value).includes("本地");
        const btns = node._bzSrc[kind].querySelectorAll(".spv-src-btn");
        btns.forEach((b) => {
            const isLocal = b.dataset.v === "local";
            b.classList.toggle("on", isLocal ? local : !local);
            b.classList.toggle("local", isLocal && local);
            b.disabled = isLocal && !connected;
            b.title = isLocal && !connected
                ? (kind === "asset"
                    ? "请先连接「🎬 本地文生图器」"
                    : "请先连接「🎬 本地参考图生图器」")
                : "";
        });
    }
}

async function syncFiles(node, rerender) {
    const w = node.widgets.find((x) => x.name === WIDGET);
    // 文件全部移除：清空会话与状态，避免下次拖入新文件时串到旧 session 缓存
    if (!node._bzFiles.length) {
        node._bzSession = "";
        node._bzState = { session: "", assets: [], kfs: [], logs: [], asset_stat: {}, kf_stat: {}, stage: "parse" };
        node._bzFilter = "全部";
        if (w) w.value = JSON.stringify({ session: "", files: [] });
        if (rerender) renderAll(node);
        return;
    }
    if (!node._bzSession)
        node._bzSession = makeSession(node._bzFiles);
    if (w) w.value = JSON.stringify({ session: node._bzSession, files: node._bzFiles });
    node._bzState = (await post("/banzhang/sp_rebuild", {
        session: node._bzSession, files: node._bzFiles,
    })) || node._bzState;
    node._bzStatusText = null;
    if (rerender) renderAll(node);
}

/* ================= 折叠（两档高度） ================= */
// 只声明尺寸回调，不主动 setSize：让 litegraph/v2 在布局时自然推导
// （configure 恢复工作流期间若主动 setSize，会与保存的尺寸恢复打架，
//  造成刷新后节点高度跳动、画布位置错位）。
function declareHeight(node) {
    const h = node._bzCollapsed ? COLLAPSE_H : EXPAND_H;
    node._bzDomW.computeSize = () => [node.size[0], h];
    // v2 VueNodes：该函数必须无条件赋上（v2 靠函数存在与否识别自定义尺寸，
    // 先做存在性判断再赋值会导致永远不生效，widget 落回缺省 50px 高、内容溢出）
    node._bzDomW.computeLayoutSize = () => ({ minHeight: h, maxHeight: undefined, minWidth: 0 });
}

// 真正校正节点高度：仅用于用户主动折叠/展开，以及加载工作流后的 rAF 校正
function applyHeight(node) {
    if (!node._bzDomW) return;
    declareHeight(node);
    const cs = node.computeSize();
    if (node._bzCollapsed) {
        node.setSize([node.size[0], cs[1]]);
    } else {
        node.setSize([node.size[0], Math.max(node.size[1], cs[1])]);
    }
    app.graph.setDirtyCanvas(true, true);
}

function applyCollapsed(node, collapsed) {
    node._bzCollapsed = collapsed;
    node._bzRoot.classList.toggle("collapsed", collapsed);
    setParamsCollapsed(node, collapsed);
    if (node.properties) node.properties.bz_sp_collapsed = collapsed;
    applyHeight(node);
}

// 折叠时把下方所有原生参数 widget 一并隐藏（铁律四件套，隐藏项净高度抵消），
// 展开时还原并让尺寸规则联动重新裁决预设/宽高的显隐
function setParamsCollapsed(node, collapsed) {
    const wHidden = node.widgets.find((x) => x.name === WIDGET);
    for (const w of node.widgets) {
        if (w === node._bzDomW || w === wHidden) continue;
        if (collapsed) {
            if (!w._bzCollapseSave)
                w._bzCollapseSave = { hidden: w.hidden, computeSize: w.computeSize, draw: w.draw, mouse: w.mouse };
            w.hidden = true;
            w.computeSize = () => [0, -4];
            w.draw = () => {};
            w.mouse = () => {};
        } else if (w._bzCollapseSave) {
            const s = w._bzCollapseSave;
            w.hidden = s.hidden; w.computeSize = s.computeSize; w.draw = s.draw; w.mouse = s.mouse;
            w._bzCollapseSave = null;
        }
    }
    if (!collapsed) applySizeVisibility(node);
    // 两个来源选择由面板分段条接管，折叠/展开后都保持原生 widget 隐藏（值仍序列化）
    setWidgetVisible(node.widgets?.find((x) => x.name === SRC_W.asset), false);
    setWidgetVisible(node.widgets?.find((x) => x.name === SRC_W.kf), false);
}

/* ================= 尺寸规则联动（同 FlashVSR 机制） ================= */
const SIZE_RULE_WIDGET = "📐 尺寸规则";
const SIZE_RULE_TO_PARAMS = {
    "🛠️ 使用下方预设": ["🖥️ 尺寸预设"],
    "✍️ 使用手动输入": ["↔️ 宽", "↕️ 高"],
};
function setWidgetVisible(widget, visible) {
    if (!widget) return;
    if (visible) {
        widget.hidden = false;
        const saved = widget._bzSavedSize;
        if (saved) {
            widget.computeSize = saved.computeSize;
            widget.draw = saved.draw;
            widget.mouse = saved.mouse;
            widget._bzSavedSize = null;
        }
    } else {
        if (!widget._bzSavedSize) {
            widget._bzSavedSize = { computeSize: widget.computeSize, draw: widget.draw, mouse: widget.mouse };
        }
        widget.hidden = true;
        widget.computeSize = () => [0, -4];
        widget.draw = () => {};
        widget.mouse = () => {};
    }
}
function applySizeVisibility(node) {
    const modeWidget = node.widgets?.find((w) => w.name === SIZE_RULE_WIDGET);
    if (!modeWidget) return;
    if (!node._bzSizeHooked) {
        node._bzSizeHooked = true;
        const orig = modeWidget.callback;
        modeWidget.callback = function (...args) {
            const r = orig ? orig.apply(this, args) : undefined;
            applySizeVisibility(node);
            return r;
        };
    }
    for (const [mode, names] of Object.entries(SIZE_RULE_TO_PARAMS)) {
        const show = modeWidget.value === mode;
        for (const name of names)
            setWidgetVisible(node.widgets.find((w) => w.name === name), show);
    }
    app.graph.setDirtyCanvas(true, true);
}

/* ================= 面板构建（幂等） ================= */
function setup(node) {
    if (node._bzDomW) {
        // 幂等：configure 恢复工作流时可能带来折叠状态，只同步 class 与尺寸声明，
        // 不立即 setSize（高度校正由 configure 的 requestAnimationFrame 统一做）
        if (node.properties && node.properties.bz_sp_collapsed !== undefined) {
            node._bzCollapsed = !!node.properties.bz_sp_collapsed;
            node._bzRoot.classList.toggle("collapsed", node._bzCollapsed);
            setParamsCollapsed(node, node._bzCollapsed);
            declareHeight(node);
        }
        renderAll(node);
        return;
    }
    const w = node.widgets.find((x) => x.name === WIDGET);
    if (w) { w.hidden = true; w.computeSize = () => [0, -4]; w.draw = () => {}; w.mouse = () => {}; }
    if (w?.value) try {
        const p = JSON.parse(w.value);
        node._bzSession = p.session;
        node._bzFiles = p.files || [];
    } catch (e) {}
    node._bzHandlers = cardHandlers(node);

    const root = el("div", "spv");
    root.addEventListener("mousedown", (e) => e.stopPropagation());
    root.addEventListener("keydown", (e) => e.stopPropagation());
    node._bzRoot = root;

    // 折叠态状态条（展开态隐藏，数据始终新鲜）
    const colbar = el("div", "spv-colbar");
    colbar.innerHTML = `<span class="spv-col-ic">${SVG.film}</span>`;
    const colTxt = el("span", "spv-col-txt");
    const colLine = el("span", "spv-col-line");
    const colFill = el("i");
    colLine.appendChild(colFill);
    const colPct = el("span", "spv-col-pct");
    const colChev = el("span", "spv-col-chev");
    colChev.innerHTML = SVG.chev;
    colbar.append(colTxt, colLine, colPct, colChev);
    colbar.onclick = (e) => { e.stopPropagation(); applyCollapsed(node, false); };
    node._bzColTxt = colTxt; node._bzColFill = colFill; node._bzColPct = colPct;
    root.appendChild(colbar);

    // 分段进度
    node._bzSeg = el("div", "spv-seg");
    root.appendChild(node._bzSeg);

    // 生图来源条：资产 / 核心帧各自选 云API 或 本地工作流
    const srcBar = el("div", "spv-src");
    node._bzSrc = {};
    const mkSrcGroup = (kind, label) => {
        const g = el("div", "spv-src-group");
        const lab = el("span", "spv-src-label");
        lab.textContent = label;
        const seg = el("span", "spv-src-seg");
        const bCloud = el("button", "spv-src-btn");
        bCloud.type = "button"; bCloud.dataset.v = "cloud"; bCloud.textContent = "☁️ 云API";
        const bLocal = el("button", "spv-src-btn");
        bLocal.type = "button"; bLocal.dataset.v = "local"; bLocal.textContent = "🔌 本地";
        bCloud.onclick = (e) => {
            e.stopPropagation();
            if (node._bzRunning) return;
            setSource(node, kind, "☁️ 云API");
        };
        bLocal.onclick = (e) => {
            e.stopPropagation();
            if (node._bzRunning) return;
            if (!portConnected(node, SRC_PORT[kind])) {
                alert(kind === "asset"
                    ? "请先把「🎬 本地文生图器」连到本节点左侧「🔌 本地资产引擎」端口"
                    : "请先把「🎬 本地参考图生图器」连到本节点左侧「🔌 本地核心帧引擎」端口");
                return;
            }
            setSource(node, kind, "🔌 本地工作流");
        };
        seg.append(bCloud, bLocal);
        g.append(lab, seg);
        node._bzSrc[kind] = g;
        return g;
    };
    srcBar.append(mkSrcGroup("asset", "资产"), mkSrcGroup("kf", "核心帧"));
    root.appendChild(srcBar);

    // 文件区（0 文件时为虚线拖放区）
    node._bzFilesBox = el("div", "spv-files");
    root.appendChild(node._bzFilesBox);
    const fileInput = el("input");
    fileInput.type = "file";
    fileInput.accept = ".md,.txt";
    fileInput.multiple = true;
    fileInput.style.display = "none";
    fileInput.onchange = () => ingestFiles(node, fileInput.files).then(() => { fileInput.value = ""; });
    node._bzFileInput = fileInput;
    root.appendChild(fileInput);

    // 滚动体：资产 + 核心帧
    const body = el("div", "spv-body");
    const assetBlock = el("div", "spv-block");
    const aHead = el("div", "spv-block-head");
    aHead.innerHTML = `<span class="spv-bic">${SVG.image}</span><span class="spv-tt">资产</span>`;
    const assetCnt = el("span", "spv-cnt");
    aHead.appendChild(assetCnt);
    node._bzAssetCnt = assetCnt;
    // 导入已有资产图：按文件名匹配资产名，直接标记完成跳过生成
    const impBtn = el("button", "spv-impbtn");
    impBtn.type = "button";
    impBtn.title = "选择已按资产名命名的图片（文件名 = 资产名），导入后跳过对应生成";
    impBtn.innerHTML = `<span>${SVG.upload}</span><span class="spv-imp-txt">导入已有图</span>`;
    const imgInput = el("input");
    imgInput.type = "file";
    imgInput.accept = ".png,.jpg,.jpeg,.webp,.bmp";
    imgInput.multiple = true;
    imgInput.style.display = "none";
    impBtn.onclick = (e) => { e.stopPropagation(); imgInput.click(); };
    imgInput.onchange = () => ingestImages(node, imgInput.files).then(() => { imgInput.value = ""; });
    aHead.appendChild(impBtn);
    node._bzImpBtn = impBtn;
    node._bzFilters = el("div", "spv-filters");
    node._bzAssetGrid = el("div");
    assetBlock.append(aHead, node._bzFilters, node._bzAssetGrid);
    root.appendChild(imgInput);

    const kfBlock = el("div", "spv-block");
    const gate = el("div", "spv-gate");
    gate.innerHTML = SVG.warn;
    const gateTxt = el("span");
    gate.appendChild(gateTxt);
    const kHead = el("div", "spv-block-head");
    kHead.innerHTML = `<span class="spv-bic">${SVG.film}</span><span class="spv-tt">核心帧</span>`;
    const kfCnt = el("span", "spv-cnt");
    kHead.appendChild(kfCnt);
    node._bzKfCnt = kfCnt; node._bzGateTxt = gateTxt;
    node._bzKfGrid = el("div");
    kfBlock.append(gate, kHead, node._bzKfGrid);
    node._bzKfBlock = kfBlock;

    body.append(assetBlock, kfBlock);
    root.appendChild(body);
    node._bzBody = body;

    // 日志抽屉
    const logDrawer = el("div", "spv-log");
    const logHead = el("button", "spv-log-head");
    logHead.innerHTML = `<span class="spv-bic">${SVG.log}</span><span>运行日志</span><span class="spv-log-dot"></span><span class="spv-log-chev">${SVG.chev}</span>`;
    logHead.onclick = (e) => { e.stopPropagation(); logDrawer.classList.toggle("open"); };
    const logBody = el("div", "spv-log-body");
    logDrawer.append(logHead, logBody);
    root.appendChild(logDrawer);
    node._bzLogDrawer = logDrawer; node._bzLogBody = logBody;

    // 底部控制条
    const ctrl = el("div", "spv-ctrl");
    const pline = el("div", "spv-pline");
    const pfill = el("i", "spv-pfill");
    pline.appendChild(pfill);
    const row = el("div", "spv-ctrl-row");
    const pct = el("span", "spv-pct");
    pct.textContent = "0%";
    const status = el("span", "spv-status");
    const stop = el("button", "spv-stop");
    stop.title = "停止（未完成项保留，可继续）";
    stop.innerHTML = SVG.stop;
    stop.onclick = async (e) => {
        e.stopPropagation();
        node._bzStatusText = "正在停止…";
        renderBar(node);
        try { await api.interrupt(); } catch (err) { /* 中断请求失败时由 done 事件兜底 */ }
        // 5 秒未收到 done 兜底解锁，防止按钮永久置灰
        setTimeout(() => {
            if (node._bzRunning) {
                node._bzRunning = false;
                node._bzStatusText = null;
                post("/banzhang/sp_state", { session: node._bzSession }).then((s) => {
                    if (s) { node._bzState = s; renderAll(node); }
                });
            }
        }, 5000);
    };
    const go = el("button", "spv-go");
    go.innerHTML = `<span class="spv-go-ic">${SVG.play}</span><span class="spv-go-spin"></span><span class="spv-go-txt"></span>`;
    go.onclick = (e) => {
        e.stopPropagation();
        if (node._bzRunning) return;
        if (!node._bzFiles.length) { alert("请先拖入剧本文件"); return; }
        node._bzRunning = true;
        node._bzStatusText = null;
        renderBar(node);
        app.queuePrompt(0, 1);
    };
    row.append(pct, status, stop, go);
    ctrl.append(pline, row);
    root.appendChild(ctrl);
    node._bzPfill = pfill; node._bzPct = pct; node._bzStatus = status; node._bzGo = go;
    node._bzGoIc = go.querySelector(".spv-go-ic");
    node._bzGoTxt = go.querySelector(".spv-go-txt");

    // 拖放：整个面板即投放区
    root.addEventListener("dragover", (e) => { e.preventDefault(); root.classList.add("dragging"); });
    root.addEventListener("dragleave", (e) => { if (!root.contains(e.relatedTarget)) root.classList.remove("dragging"); });
    root.addEventListener("drop", async (e) => {
        e.preventDefault();
        root.classList.remove("dragging");
        // 剧本与图片按扩展名分流：.md/.txt 走解析，图片走资产导入
        const files = [...(e.dataTransfer?.files || [])];
        const scripts = files.filter((x) => /\.(md|txt)$/i.test(x.name));
        const imgs = files.filter((x) => IMG_RE.test(x.name));
        if (scripts.length) await ingestFiles(node, scripts);
        if (imgs.length) await ingestImages(node, imgs);
    });

    node._bzDomW = node.addDOMWidget("pipeline面板", "pipeline面板", root, { serialize: false });
    const wi = node.widgets.indexOf(node._bzDomW);
    if (wi > 0) node.widgets.splice(0, 0, node.widgets.splice(wi, 1)[0]);
    node.size[0] = Math.max(node.size[0] ?? 0, 380);

    // 折叠状态恢复（properties 优先）；仅声明尺寸，高度由 litegraph 自然推导
    node._bzCollapsed = !!(node.properties && node.properties.bz_sp_collapsed);
    root.classList.toggle("collapsed", node._bzCollapsed);
    setParamsCollapsed(node, node._bzCollapsed);
    declareHeight(node);
    renderAll(node);
}

app.registerExtension({
    name: "banzhang.script.pipeline.v3",
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== "BanZhang_ScriptPipeline") return;

        nodeType.prototype.onNodeCreated = function () {
            this._bzFiles = [];
            this._bzFilter = "全部";
            this._bzState = { session: "", assets: [], kfs: [], logs: [], asset_stat: {}, kf_stat: {}, stage: "parse" };
            this._bzStatusText = null;
            setup(this);
            applySizeVisibility(this);
        };
        // 引擎连线/拔线后刷新来源分段条（本地项的可点状态随连线变化）
        const onConnectionsChange = nodeType.prototype.onConnectionsChange;
        nodeType.prototype.onConnectionsChange = function () {
            const r = onConnectionsChange ? onConnectionsChange.apply(this, arguments) : undefined;
            if (this._bzSrc) renderSource(this);
            return r;
        };
        // 必须转调父类：pos / size / widgets_values 的恢复全在父类 configure 里，
        // 裸覆盖会让节点每次加载都落回默认坐标
        const onConfigure = nodeType.prototype.configure;
        nodeType.prototype.configure = function () {
            const r = onConfigure ? onConfigure.apply(this, arguments) : undefined;
            if (!this._bzFilter) this._bzFilter = "全部";
            if (!this._bzFiles) this._bzFiles = [];
            if (!this._bzState) this._bzState = { assets: [], kfs: [], logs: [], asset_stat: {}, kf_stat: {}, stage: "parse" };
            // configure 时 widget 值已恢复；面板若已建（onNodeCreated 先于 configure），
            // 内存里的文件/会话还是空的，需从 widget 补读
            const fw = this.widgets?.find((x) => x.name === WIDGET);
            if (fw?.value && !this._bzFiles.length) {
                try {
                    const p = JSON.parse(fw.value);
                    this._bzSession = p.session;
                    this._bzFiles = p.files || [];
                } catch (e) {}
            }
            setup(this);
            applySizeVisibility(this);
            // 等前端把工作流的尺寸/位置和 DOM 布局恢复完成后，再校正一次高度
            // （折叠态收到设计值，展开态只增不减），避免恢复期间尺寸打架
            const self = this;
            requestAnimationFrame(() => applyHeight(self));
            if (this._bzSession)
                post("/banzhang/sp_state", { session: this._bzSession })
                    .then((s) => { if (s) { this._bzState = s; renderAll(this); } });
            return r;
        };

        api.addEventListener("script_pipeline", (e) => {
            const d = e.detail;
            for (const n of Object.values(app.graph._nodes_by_id)) {
                if (n.type !== "BanZhang_ScriptPipeline" || !n._bzBody) continue;
                if (d.session && d.session !== n._bzSession) continue;
                if (d.event === "stage") {
                    n._bzState.stage = d.stage;
                    n._bzStatusText = null;
                    renderSeg(n); renderKfGrid(n); renderBar(n);
                } else if (d.event === "item") {
                    // 有 item 事件说明后端流水线正在执行（含刷新页面后恢复识别）
                    n._bzRunning = true;
                    const list = d.kind === "asset" ? n._bzState.assets : n._bzState.kfs;
                    const i = list.findIndex((x) => x.id === d.item.id);
                    if (i >= 0) list[i] = d.item;
                    else list.push(d.item);
                    n._bzStatusText = null;
                    // 只重建对应区块，避免无关缩略图闪烁
                    if (d.kind === "asset") { renderAssetGrid(n); renderFilters(n); renderKfGrid(n); }
                    else renderKfGrid(n);
                    renderSeg(n); renderBar(n);
                } else if (d.event === "log") {
                    n._bzState.logs.push(d.line);
                    renderLogs(n);
                } else if (d.event === "done") {
                    n._bzRunning = false;
                    n._bzStatusText = null;
                    post("/banzhang/sp_state", { session: n._bzSession })
                        .then((s) => { if (s) { n._bzState = s; renderAll(n); } });
                }
            }
        });

        // 中断/异常的权威兜底：runner 的 done 事件之外，再以 ComfyUI 执行事件为准
        const resetRunning = () => {
            for (const n of Object.values(app.graph._nodes_by_id)) {
                if (n.type !== "BanZhang_ScriptPipeline" || !n._bzBody || !n._bzRunning) continue;
                n._bzRunning = false;
                n._bzStatusText = null;
                if (n._bzSession)
                    post("/banzhang/sp_state", { session: n._bzSession })
                        .then((s) => { if (s) { n._bzState = s; renderAll(n); } });
            }
        };
        api.addEventListener("execution_interrupted", resetRunning);
        api.addEventListener("execution_error", resetRunning);
    },
});
