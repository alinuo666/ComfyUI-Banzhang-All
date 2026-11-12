// 👨‍🏫 班长全家桶 - 顶栏「显存 / 内存」监控（精简胶囊版）
// 设计目标：占地小、颜色直观、悬停看细节、断线不装死
import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const EVENT_NAME = "vram_reserved.monitor";
const STALE_MS = 10000;      // 超过 10 秒没数据 = 视为离线
const DEFAULT_WARN = 85;     // 红色告警阈值（%），可在 ComfyUI 设置里改

const GB = 1024 * 1024 * 1024;
let warnThreshold = DEFAULT_WARN;
let lastData = null;
let lastUpdate = 0;
let root = null;
let shell = null;

const CSS = `
.bz-mon {
  box-sizing:border-box;
  display:inline-flex; flex-direction:column; justify-content:center; gap:4px;
  height:34px; padding:0 12px;
  border-radius:10px;
  background:#1A1A1E;
  border:1px solid rgba(255,255,255,.10);
  cursor:pointer; user-select:none; flex-shrink:0;
  transition:border-color .2s ease, opacity .25s ease;
}
.bz-mon:hover { border-color:rgba(224,185,79,.45); }
.bz-mon-item { display:flex; align-items:center; gap:7px; height:11px; }
.bz-mon-label {
  font-size:11px; line-height:1; font-weight:500; letter-spacing:.02em;
  color:#E0B94F;
}
.bz-mon-bar {
  position:relative; width:44px; height:5px;
  border-radius:99px; background:rgba(255,255,255,.13);
  overflow:hidden;
}
.bz-mon-fill {
  display:block; width:0; height:100%; border-radius:99px;
  background:#E0B94F;
  transition:width .6s ease, background .3s ease;
}
/* 三档：正常金 / 70% 起橙 / 阈值（默认 85%）起红并轻微呼吸 */
.bz-mon-fill.warn { background:#F5A524; }
.bz-mon-fill.crit {
  background:#E5484D;
  animation:bz-mon-pulse 1.6s ease-in-out infinite;
}
@keyframes bz-mon-pulse { 0%,100%{opacity:1} 50%{opacity:.6} }
.bz-mon-val {
  font:11px/1 ui-monospace,Consolas,"Courier New",monospace;
  color:#F0F0F0; min-width:62px; text-align:right; white-space:nowrap;
}
.bz-mon.offline { opacity:.45; }
.bz-mon.offline .bz-mon-fill {
  background:#666; animation:none; width:100% !important;
}
.bz-mon.compact { padding:0 8px; }
.bz-mon.compact .bz-mon-label,
.bz-mon.compact .bz-mon-val { display:none; }

/* 胶囊 + 净化按钮的整体容器：margin 从胶囊挪到这里，两者间距由 gap 统一管理 */
.bz-mon-wrap { display:inline-flex; align-items:center; gap:6px; margin:0 4px; flex-shrink:0; }
.bz-mon-btn {
  box-sizing:border-box;
  width:70px; height:34px; padding:0;
  display:flex; align-items:center; justify-content:center;
  border-radius:10px; border:1px solid rgba(255,255,255,.14);
  background:rgba(255,255,255,.07);
  color:#E0B94F;
  font-size:11px; line-height:1; font-weight:500; white-space:nowrap;
  cursor:pointer; user-select:none;
  transition:background .15s, border-color .15s, color .15s;
}
/* hover 直接变红底白字：破坏性动作在按下之前就给颜色预警 */
.bz-mon-btn:hover { background:#E5484D; border-color:#E5484D; color:#FFF; }
.bz-mon-btn.busy { background:rgba(255,255,255,.04); border-color:rgba(255,255,255,.08); color:#8B8B93; cursor:default; }
.bz-mon-btn.busy:hover { background:rgba(255,255,255,.04); border-color:rgba(255,255,255,.08); color:#8B8B93; }
.bz-mon-btn.done { background:rgba(74,222,128,.12); border-color:rgba(74,222,128,.5); color:#4ADE80; }
.bz-mon-btn.fail { background:rgba(229,72,77,.16); border-color:rgba(229,72,77,.55); color:#FF8080; }
`;

function injectCSS() {
    if (document.getElementById("bz-mon-style")) return;
    const s = document.createElement("style");
    s.id = "bz-mon-style";
    s.textContent = CSS;
    document.head.appendChild(s);
}

function buildItem(label) {
    const el = document.createElement("div");
    el.className = "bz-mon-item";
    el.innerHTML =
        `<span class="bz-mon-label">${label}</span>` +
        `<span class="bz-mon-bar"><i class="bz-mon-fill"></i></span>` +
        `<span class="bz-mon-val">--</span>`;
    return {
        el,
        fill: el.querySelector(".bz-mon-fill"),
        val: el.querySelector(".bz-mon-val"),
    };
}

const vram = buildItem("显存");
const ram = buildItem("内存");

// ── 「全卸载」按钮 ─────────────────────────────────────────────────────────
// 一次清到底：本包各节点的模块级缓存 + 所有已加载模型 + 显存碎片 + 进程内存。
// 后端复用「🧹 全能系统净化」节点那套执行深度清理，不另写一份。
let purging = false;

function buildBtn() {
    const b = document.createElement("div");
    b.className = "bz-mon-btn";
    b.textContent = "全卸载";
    b.dataset.idle = "全卸载";
    b.title = "一键清到底：卸掉所有已加载模型，并清空本包各节点的缓存"
        + "（参考图 / 插帧 / CLIP 投影 / FlashVSR 等），再回收显存碎片、把内存还给系统。\n"
        + "下次生成要从硬盘重读权重，会慢一些；生成过程中会被拦下。";
    // 阻止冒泡：胶囊本身的点击是折叠，按钮不能顺带触发
    b.addEventListener("click", (e) => { e.stopPropagation(); purge(b); });
    return b;
}

function flash(btn, text, cls, ms, tip) {
    // 失败原因只放 title + 控制台：按钮太窄塞不下，但鼠标一停就能看见
    const 原tip = btn.title;
    btn.textContent = text;
    btn.classList.remove("done", "fail");
    btn.classList.add(cls);
    if (tip) btn.title = tip;
    setTimeout(() => {
        btn.textContent = btn.dataset.idle;
        btn.classList.remove("done", "fail", "busy");
        btn.title = 原tip;
    }, ms);
}

async function purge(btn) {
    if (purging) return;
    purging = true;
    btn.classList.remove("done", "fail");
    btn.classList.add("busy");
    btn.textContent = "清理中";
    try {
        const res = await api.fetchApi("/banzhang/purge", { method: "POST" });
        if (res.status === 403) {
            // 后端判定正在生成（比前端状态更可信）
            flash(btn, "生成中", "fail", 2200);
            return;
        }
        // 404 = 接口根本不存在 = 后端还在跑旧代码。改过 .py 后只刷网页没用，
        // 这是本仓最常踩的坑，直接把它写在按钮上，别让人对着一句「失败」猜。
        if (res.status === 404) {
            flash(btn, "需重启", "fail", 3500,
                "找不到 /banzhang/purge 接口：后端还是旧代码。\n请完全关闭并重新启动 ComfyUI（只刷新网页没用）。");
            return;
        }
        if (!res.ok) {
            // aiohttp 出错时回的是纯文本 traceback，打到控制台，方便直接复制排查
            const 详情 = await res.text().catch(() => "");
            console.error(`[班长] 净化失败 HTTP ${res.status}\n` + 详情.slice(0, 1200));
            flash(btn, `错误${res.status}`, "fail", 3000, `HTTP ${res.status}，详细报错见浏览器控制台。`);
            return;
        }
        const d = await res.json();
        // 立刻用返回的读数刷新，不等 1.5 秒一次的轮询
        if (d && d.after) apply(d.after);
        flash(btn, "已清", "done", 1500);
    } catch (e) {
        console.warn("[班长] 净化失败", e);
        flash(btn, "失败", "fail", 2200, "请求没发出去，或者返回的不是 JSON。详见浏览器控制台。");
    } finally {
        purging = false;
    }
}

const btnPurge = buildBtn();

const pctOf = (used, total) => (total > 0 ? ((used / total) * 100).toFixed(0) + "%" : "--");

function setItem(item, used, total) {
    const ok = total > 0;
    const pct = ok ? Math.min(100, (used / total) * 100) : 0;
    // 三档：正常金 → 阈值下 15 个点开始变橙 → 到阈值变红并轻微呼吸
    const crit = ok && pct >= warnThreshold;
    const warn = ok && !crit && pct >= warnThreshold - 15;
    item.fill.style.width = pct.toFixed(1) + "%";
    item.fill.classList.toggle("crit", crit);
    item.fill.classList.toggle("warn", warn);
    item.val.textContent = ok
        ? `${(used / GB).toFixed(1)}/${(total / GB).toFixed(0)}G`
        : "--/--";
}

function updateTooltip(offline) {
    if (!root) return;
    if (offline) {
        root.title = "⚠️ 已超过 10 秒没收到服务器数据，显示的可能不是实时值。\n（点击可折叠/展开）";
        return;
    }
    if (!lastData) {
        root.title = "显存 / 内存监控：等待服务器数据…\n（点击可折叠/展开）";
        return;
    }
    const d = lastData;
    const t = new Date(lastUpdate).toLocaleTimeString("zh-CN", { hour12: false });
    root.title =
        `显存  ${(d.vram_used / GB).toFixed(1)} / ${(d.vram_total / GB).toFixed(1)} GB  (${pctOf(d.vram_used, d.vram_total)})\n` +
        `内存  ${(d.ram_used / GB).toFixed(1)} / ${(d.ram_total / GB).toFixed(1)} GB  (${pctOf(d.ram_used, d.ram_total)})\n` +
        `更新于 ${t}\n` +
        `（点击可折叠/展开；${Math.max(0, warnThreshold - 15)}% 起变橙、${warnThreshold}% 起变红，可在设置里调）`;
}

function markOffline() {
    if (!root || root.classList.contains("offline")) return;
    root.classList.add("offline");
    vram.val.textContent = "离线";
    ram.val.textContent = "离线";
    updateTooltip(true);
}

function apply(data) {
    lastData = data;
    lastUpdate = Date.now();
    if (!root) return;
    root.classList.remove("offline");
    setItem(vram, data.vram_used || 0, data.vram_total || 0);
    setItem(ram, data.ram_used || 0, data.ram_total || 0);
    updateTooltip(false);
}

function mount() {
    const tryMount = () => {
        const target = app.menu?.settingsGroup?.element;
        if (target) { target.before(shell); return true; }
        const queueBtn = document.getElementById("queue-button");
        if (queueBtn) { queueBtn.insertAdjacentElement("afterend", shell); return true; }
        return false;
    };
    if (!tryMount()) {
        const iv = setInterval(() => { if (tryMount()) clearInterval(iv); }, 500);
    }
}

app.registerExtension({
    name: "BanZhang.VRAM.Monitor",

    setup() {
        injectCSS();

        root = document.createElement("div");
        root.className = "bz-mon";
        root.appendChild(vram.el);
        root.appendChild(ram.el);
        root.addEventListener("click", () => root.classList.toggle("compact"));
        updateTooltip(false);

        // 胶囊和按钮是一个整体：显示开关要一起隐藏，不然关了监控按钮还杵在那
        shell = document.createElement("div");
        shell.className = "bz-mon-wrap";
        shell.appendChild(root);
        shell.appendChild(btnPurge);

        mount();

        // addSetting 的 onChange 只在「改动」时触发，不会为已存的旧值补发一次，
        // 所以上次关掉监控的人重启后胶囊会照样出来 —— 这里主动读一次兜住
        try {
            const on = app.ui.settings.getSettingValue("BanZhang.VRAMMonitor.Enabled", true);
            if (shell && on === false) shell.style.display = "none";
        } catch (e) { /* 拿不到就按默认显示 */ }

        api.addEventListener(EVENT_NAME, (e) => {
            if (e?.detail) apply(e.detail);
        });

        // 断线检测：超过 10 秒没更新就变灰标注「离线」
        setInterval(() => {
            if (lastUpdate && Date.now() - lastUpdate > STALE_MS) markOffline();
        }, 1000);

        // 设置项（注册失败也不影响监控本身）
        try {
            app.ui.settings.addSetting({
                id: "BanZhang.VRAMMonitor.WarnThreshold",
                name: "显存监控：变红告警阈值 (%)",
                type: "number",
                defaultValue: DEFAULT_WARN,
                onChange: (v) => {
                    const n = Number(v);
                    if (!Number.isNaN(n) && n > 0) {
                        warnThreshold = n;
                        if (lastData) apply(lastData);
                    }
                },
            });
        } catch (e) {
            console.warn("[班长] 阈值设置项注册失败(不影响使用)", e);
        }

        try {
            app.ui.settings.addSetting({
                id: "BanZhang.VRAMMonitor.Enabled",
                name: "显存监控：显示顶栏状态条",
                type: "boolean",
                defaultValue: true,
                onChange: (v) => {
                    if (shell) shell.style.display = v ? "inline-flex" : "none";
                },
            });
        } catch (e) {
            console.warn("[班长] 显示开关设置项注册失败(不影响使用)", e);
        }
    },
});
