import { app } from "../../scripts/app.js";

/**
 * 👨‍🏫班长 ComfyUI 音乐播放器前端扩展 - V30（方案 B：完整体验）
 *
 * 设计基准：Apple HIG（材质 / SF Symbols 风格 SVG / 弹簧动效）
 * 能力：DPR 频谱(4 样式) · 增强 LRC(多时间戳/翻译/节点内粘贴) · scrub 状态机 ·
 *       音量/倍速/循环/随机/±15s · 媒体键(Media Session) · 多实例音频焦点 ·
 *       生命周期清理 · localStorage 持久化 · toast 通知 · XSS 安全渲染
 */

const CSS_ID = "bmp-player-style";
const STORE_KEY = "bzmp-prefs";
const lrcKey = (name) => `bzmp-lrc:${name || ""}`;

/* ---------- 全局样式（只注入一次） ---------- */
function injectStyle() {
    if (document.getElementById(CSS_ID)) return;
    const s = document.createElement("style");
    s.id = CSS_ID;
    s.textContent = `
.bmp{--c1:hsl(211,100%,52%);--c2:hsl(240,70%,58%);--c1a:hsla(211,100%,52%,.55);--c2a:hsla(240,70%,58%,.5);
  width:100%;box-sizing:border-box;padding:10px;border-radius:14px;color:#f5f5f7;
  background:linear-gradient(180deg,#1d1d22,#141418);border:1px solid rgba(255,255,255,.1);
  font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;
  font-size:13px;position:relative;overflow:hidden;user-select:none;outline:none}
.bmp:focus-visible{border-color:var(--c1)}
.bmp *{box-sizing:border-box}
.bmp button{font-family:inherit}
.bmp-visual{position:relative;height:148px;border-radius:10px;overflow:hidden;background:rgba(0,0,0,.35);margin-bottom:10px}
.bmp canvas{position:absolute;inset:0;width:100%;height:100%;display:block}
.bmp-stylebtn{position:absolute;top:6px;right:7px;z-index:6;display:flex;align-items:center;gap:4px;
  font-size:10.5px;font-weight:600;color:rgba(255,255,255,.8);background:rgba(0,0,0,.42);
  border:1px solid rgba(255,255,255,.14);border-radius:7px;padding:3px 8px;cursor:pointer;
  backdrop-filter:blur(8px);transition:background .15s}
.bmp-stylebtn:hover{background:rgba(0,0,0,.65);color:#fff}
.bmp-stylebtn svg{width:11px;height:11px}
.bmp-empty{position:absolute;inset:0;display:grid;place-items:center;text-align:center;
  color:rgba(255,255,255,.42);font-size:11.5px;line-height:1.7;padding:16px;z-index:2}
.bmp-lyrics{position:absolute;inset:0;display:none;background:linear-gradient(180deg,rgba(20,20,24,.96),rgba(14,14,17,.96));z-index:5}
.bmp-lyrics.on{display:block}
.bmp-lyrics-scroll{height:100%;overflow-y:auto;scrollbar-width:none;padding:30px 12px;text-align:center}
.bmp-lyrics-scroll::-webkit-scrollbar{display:none}
.bmp-lrc-line{font-size:13.5px;font-weight:600;line-height:1.5;color:rgba(255,255,255,.36);
  padding:6px 4px;transform:scale(.96);transition:all .36s cubic-bezier(.34,1.4,.5,1);cursor:pointer}
.bmp-lrc-line.active{color:#fff;transform:scale(1.06);text-shadow:0 0 20px var(--c1a)}
.bmp-lrc-line .tr{display:block;font-size:11px;font-weight:500;opacity:.68;margin-top:2px}
.bmp-lrc-fade{position:absolute;left:0;right:0;height:26px;pointer-events:none;z-index:2}
.bmp-lrc-fade.t{top:0;background:linear-gradient(180deg,rgba(18,18,22,.95),transparent)}
.bmp-lrc-fade.b{bottom:0;background:linear-gradient(0deg,rgba(18,18,22,.95),transparent)}
.bmp-lrc-edit{position:absolute;inset:0;z-index:8;background:rgba(12,12,15,.97);padding:10px;display:none;flex-direction:column;gap:7px}
.bmp-lrc-edit.on{display:flex}
.bmp-lrc-edit textarea{flex:1;resize:none;border-radius:8px;border:1px solid rgba(255,255,255,.16);
  background:rgba(0,0,0,.5);color:#fff;font-family:ui-monospace,Consolas,monospace;font-size:11.5px;padding:8px;outline:none}
.bmp-lrc-edit .row{display:flex;gap:7px}
.bmp-lrc-edit button{flex:1;border:0;border-radius:7px;padding:6px;font-size:12px;font-weight:600;cursor:pointer}
.bmp-lrc-save{background:var(--c1);color:#fff}.bmp-lrc-cancel{background:rgba(255,255,255,.12);color:#fff}
.bmp-lrc-paste{position:absolute;top:6px;left:7px;z-index:7;font-size:10.5px;font-weight:600;
  color:rgba(255,255,255,.8);background:rgba(0,0,0,.42);border:1px solid rgba(255,255,255,.14);
  border-radius:7px;padding:3px 8px;cursor:pointer;backdrop-filter:blur(8px)}
.bmp-lrc-paste:hover{color:#fff;background:rgba(0,0,0,.65)}
.bmp-meta{display:flex;align-items:center;gap:8px;margin-bottom:8px;min-width:0}
.bmp-title{flex:1;min-width:0}
.bmp-name{font-size:13.5px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bmp-sub{font-size:10.5px;color:rgba(255,255,255,.5);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:1px;font-variant-numeric:tabular-nums}
.bmp-prog{position:relative;height:18px;display:flex;align-items:center;cursor:pointer}
.bmp-prog .track{position:relative;width:100%;height:5px;border-radius:3px;background:rgba(255,255,255,.18)}
.bmp-prog .buf{position:absolute;left:0;top:0;bottom:0;border-radius:3px;background:rgba(255,255,255,.22);width:0}
.bmp-prog .fill{position:absolute;left:0;top:0;bottom:0;border-radius:3px;background:#fff;width:0}
.bmp-prog .knob{position:absolute;top:50%;width:11px;height:11px;border-radius:50%;background:#fff;
  transform:translate(-50%,-50%) scale(.7);left:0;opacity:0;transition:transform .16s,opacity .16s;box-shadow:0 2px 6px rgba(0,0,0,.5)}
.bmp-prog:hover .knob,.bmp-prog.scrub .knob{transform:translate(-50%,-50%) scale(1);opacity:1}
.bmp-prog .tip{position:absolute;bottom:15px;transform:translateX(-50%);background:rgba(0,0,0,.84);
  font-size:10px;font-family:ui-monospace,Consolas,monospace;padding:2px 6px;border-radius:5px;opacity:0;pointer-events:none;transition:opacity .14s;white-space:nowrap}
.bmp-prog:hover .tip{opacity:1}
.bmp-time{display:flex;justify-content:space-between;font-size:10.5px;color:rgba(255,255,255,.55);
  font-family:ui-monospace,Consolas,monospace;font-variant-numeric:tabular-nums;margin:1px 1px 8px}
.bmp-ctrl{display:flex;align-items:center;justify-content:space-between;margin:0 0 8px}
.bmp-btn{appearance:none;border:0;background:transparent;color:rgba(255,255,255,.82);cursor:pointer;
  display:grid;place-items:center;border-radius:50%;width:36px;height:36px;transition:transform .14s,color .14s,background .14s;position:relative}
.bmp-btn:hover{color:#fff;background:rgba(255,255,255,.1)}
.bmp-btn:active{transform:scale(.88)}
.bmp-btn svg{width:20px;height:20px}
.bmp-btn.sm{width:30px;height:30px;color:rgba(255,255,255,.58)}
.bmp-btn.sm svg{width:16px;height:16px}
.bmp-btn.sm.on{color:var(--c1)}
.bmp-btn.sm .dot{position:absolute;width:6px;height:6px;border-radius:50%;background:var(--c1);top:5px;right:5px;display:none}
.bmp-btn.sm.on .dot{display:block}
.bmp-play{width:48px;height:48px;background:rgba(255,255,255,.14);color:#fff;backdrop-filter:blur(8px)}
.bmp-play:hover{background:rgba(255,255,255,.22);color:#fff}
.bmp-play svg{width:23px;height:23px}
.bmp-subrow{display:flex;align-items:center;gap:7px}
.bmp-vol{display:flex;align-items:center;gap:6px;flex:1;min-width:0}
.bmp-vol svg{width:14px;height:14px;color:rgba(255,255,255,.6);flex:none;cursor:pointer}
.bmp-vslider{position:relative;flex:1;height:16px;display:flex;align-items:center;cursor:pointer;min-width:30px}
.bmp-vslider .vt{width:100%;height:4px;border-radius:2px;background:rgba(255,255,255,.18);position:relative}
.bmp-vslider .vf{position:absolute;left:0;top:0;bottom:0;border-radius:2px;background:rgba(255,255,255,.85);width:70%}
.bmp-vslider .vk{position:absolute;top:50%;width:9px;height:9px;border-radius:50%;background:#fff;transform:translate(-50%,-50%);left:70%;opacity:0;transition:opacity .14s}
.bmp-vslider:hover .vk{opacity:1}
.bmp-chip{appearance:none;background:rgba(255,255,255,.1);border:0;color:#fff;font-family:ui-monospace,Consolas,monospace;
  font-size:10.5px;font-weight:700;padding:5px 8px;border-radius:7px;cursor:pointer;white-space:nowrap;transition:background .14s}
.bmp-chip:hover{background:rgba(255,255,255,.2)}
.bmp-chip.on{background:var(--c1);color:#fff}
.bmp-chip svg{width:14px;height:14px;display:block}
.bmp-lrc-edit textarea{user-select:text}
.bmp-drag{position:absolute;inset:7px;z-index:20;border:2px dashed var(--c1);border-radius:10px;
  background:rgba(10,132,255,.14);backdrop-filter:blur(6px);display:none;place-items:center;text-align:center;
  font-weight:600;font-size:12.5px;color:#fff;pointer-events:none;line-height:1.7}
.bmp.dragover .bmp-drag{display:grid}
.bmp-toast{position:fixed;left:50%;bottom:30px;transform:translate(-50%,14px);z-index:9999;max-width:80vw;
  background:rgba(35,35,40,.94);backdrop-filter:blur(20px);border:1px solid rgba(255,255,255,.16);color:#fff;
  font-size:12.5px;font-weight:500;padding:9px 17px;border-radius:11px;opacity:0;pointer-events:none;
  transition:all .28s cubic-bezier(.34,1.4,.5,1);box-shadow:0 14px 40px -12px rgba(0,0,0,.8)}
.bmp-toast.show{opacity:1;transform:translate(-50%,0)}
.bmp-toast.err{border-color:rgba(255,69,58,.5)}
`;
    document.head.appendChild(s);
}

/* ---------- 工具 ---------- */
const $ = (sel, root = document) => root.querySelector(sel);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const fmt = (s) => {
    s = Math.max(0, isFinite(s) ? s : 0);
    return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
};
const ICONS = {
    shuffle: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M16 3h5v5M4 20 21 3M21 16v5h-5M15 15l6 6M4 4l5 5"/></svg>',
    prev: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 6a1 1 0 0 1 2 0v4.5l8.4-5.2A1 1 0 0 1 19 6.1v11.8a1 1 0 0 1-1.6.8L9 13.5V18a1 1 0 0 1-2 0Z"/></svg>',
    play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.5v13a1 1 0 0 0 1.54.84l10-6.5a1 1 0 0 0 0-1.68l-10-6.5A1 1 0 0 0 8 5.5Z"/></svg>',
    pause: '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6.5" y="5" width="3.6" height="14" rx="1.2"/><rect x="13.9" y="5" width="3.6" height="14" rx="1.2"/></svg>',
    next: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M17 6a1 1 0 0 0-2 0v4.5L6.6 5.3A1 1 0 0 0 5 6.1v11.8a1 1 0 0 0 1.6.8L15 13.5V18a1 1 0 0 0 2 0Z"/></svg>',
    repeat: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14M7 22l-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/></svg>',
    repeat1: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14M7 22l-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/><path d="M11 10h1v4"/></svg>',
    back15: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 7 9l4 4"/><path d="M7 9h6a5 5 0 1 1-5 5"/></svg>',
    fwd15: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="m13 5 4 4-4 4"/><path d="M17 9h-6a5 5 0 1 0 5 5"/></svg>',
    lrc: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M7 7h10M7 12h10M7 17h6"/></svg>',
    bars: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M4 18v-4M9 18V8M14 18v-7M19 18V5"/></svg>',
    vol: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H3v6h3l5 4Z" fill="currentColor" stroke="none"/><path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 6a9 9 0 0 1 0 12"/></svg>',
    mute: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H3v6h3l5 4Z" fill="currentColor" stroke="none"/><path d="m16 9 5 6M21 9l-5 6"/></svg>',
};

/* 增强 LRC 解析：多时间戳 / 三位毫秒 / ID 标签 / offset / 同时间戳翻译双行 */
function parseLRC(text) {
    const meta = {}, lines = [];
    if (!text) return { meta, lines };
    for (const raw of String(text).split("\n")) {
        const tag = /^\[(ti|ar|al|offset)\s*:(.*?)\]$/i.exec(raw);
        if (tag) { meta[tag[1].toLowerCase()] = tag[2].trim(); continue; }
        const stamps = [...raw.matchAll(/\[(\d+):(\d+)(?:[.:](\d+))?\]/g)];
        if (!stamps.length) continue;
        const words = raw.replace(/\[[^\]]*\]/g, "").trim();
        for (const m of stamps) {
            const time = +m[1] * 60 + +m[2] + parseFloat("0." + (m[3] || "0")) - (parseFloat(meta.offset) || 0) / 1000;
            const hit = lines.find((l) => Math.abs(l.time - time) < .05);
            if (hit && words && !hit.trans && hit.text !== words) hit.trans = words;
            else if (!hit && words) lines.push({ time, text: words });
        }
    }
    return { meta, lines: lines.sort((a, b) => a.time - b.time) };
}

/* ---------- 全局：音频焦点 & toast & 偏好 ---------- */
const Focus = { current: null, notifyPlay(p) { if (this.current && this.current !== p) this.current.remotePause(); this.current = p; }, leave(p) { if (this.current === p) this.current = null; } };
function toast(msg, isErr = false) {
    let el = document.querySelector(".bmp-toast");
    if (!el) { el = document.createElement("div"); el.className = "bmp-toast"; document.body.appendChild(el); }
    el.textContent = msg;
    el.classList.toggle("err", !!isErr);
    el.classList.add("show");
    clearTimeout(el._t);
    el._t = setTimeout(() => el.classList.remove("show"), 2200);
}
const Prefs = {
    data: {},
    load() { try { this.data = JSON.parse(localStorage.getItem(STORE_KEY) || "{}"); } catch (e) { this.data = {}; } return this.data; },
    set(k, v) { this.data[k] = v; try { localStorage.setItem(STORE_KEY, JSON.stringify(this.data)); } catch (e) { } },
};
function hueOfName(name) {
    let h = 0;
    for (let i = 0; i < (name || "").length; i++) h = (h * 31 + name.charCodeAt(i)) % 360;
    return h;
}
function rr(ctx, x, y, w, h, r) {
    r = Math.min(r, w / 2, Math.abs(h) / 2);
    const yy = y + Math.min(0, h);
    ctx.beginPath();
    ctx.moveTo(x + r, yy); ctx.arcTo(x + w, yy, x + w, yy + h, r); ctx.arcTo(x + w, yy + h, x, yy + h, r);
    ctx.arcTo(x, yy + h, x, yy, r); ctx.arcTo(x, yy, x + w, yy, r); ctx.closePath();
}

class NodeMusicPlayer {
    constructor(node) {
        this.node = node;
        this.audio = new Audio();
        this.audio.preload = "metadata";
        this.ctx = null; this.analyser = null; this.mediaNode = null;
        this.raf = null; this.peaks = [];
        this.lrc = { meta: {}, lines: [] };
        this.activeLrc = -99;
        this.scrubbing = false; this.volDrag = false; this.pending = 0;
        this.view = "viz";              // viz | lyrics
        this.styleIdx = 0;
        this.styles = ["镜像频谱", "丝滑波形", "环形扩散", "像素点阵"];
        this.ab = null;                 // A-B 循环 {a,b}
        this.currentName = "";
        this.currentUrl = "";
        this.bufPct = 0;
        this.prefs = Prefs.load();
        this.ready = false;
    }

    /* ---------------- UI ---------------- */
    createUI() {
        this.el = document.createElement("div");
        this.el.className = "bmp";
        this.el.tabIndex = 0;
        this.el.innerHTML = `
            <div class="bmp-drag">松开以载入音频<br><span style="font-size:10.5px;font-weight:500;opacity:.85">MP3 · WAV · FLAC · M4A · OGG · OPUS</span></div>
            <div class="bmp-visual">
                <button class="bmp-stylebtn" title="点击频谱区域也可切换样式">${ICONS.bars}<span class="bmp-style-name">镜像频谱</span></button>
                <canvas class="bmp-canvas"></canvas>
                <div class="bmp-empty">▶ 点击播放，或拖入音频文件<br>频谱 / 歌词可切换显示</div>
                <div class="bmp-lyrics">
                    <button class="bmp-lrc-paste" title="粘贴 LRC 歌词">粘贴歌词</button>
                    <div class="bmp-lyrics-fade t"></div>
                    <div class="bmp-lyrics-scroll"></div>
                    <div class="bmp-lyrics-fade b"></div>
                </div>
                <div class="bmp-lrc-edit">
                    <textarea placeholder="粘贴 LRC 歌词，支持 [mm:ss.xxx] 时间戳与同时间戳翻译双行"></textarea>
                    <div class="row">
                        <button class="bmp-lrc-cancel">取消</button>
                        <button class="bmp-lrc-save">保存并显示</button>
                    </div>
                </div>
            </div>
            <div class="bmp-meta">
                <div style="min-width:0;flex:1">
                    <div class="bmp-name">🎵 等待加载音频</div>
                    <div class="bmp-sub">节点内试听 · 拖入文件即可上传到 input</div>
                </div>
            </div>
            <div class="bmp-prog">
                <div class="track"><div class="buf"></div><div class="fill"></div></div>
                <div class="knob"></div><div class="tip">0:00</div>
            </div>
            <div class="bmp-time"><span class="t-cur">0:00</span><span class="t-dur">0:00</span></div>
            <div class="bmp-ctrl">
                <button class="bmp-btn sm b-shuffle" title="随机播放">${ICONS.shuffle}<span class="dot"></span></button>
                <button class="bmp-btn b-prev" title="上一首">${ICONS.prev}</button>
                <button class="bmp-btn bmp-play b-play" title="播放/暂停">${ICONS.play}${ICONS.pause}</button>
                <button class="bmp-btn b-next" title="下一首">${ICONS.next}</button>
                <button class="bmp-btn sm b-repeat" title="循环模式">${ICONS.repeat}${ICONS.repeat1}<span class="dot"></span></button>
            </div>
            <div class="bmp-subrow">
                <button class="bmp-chip b-seek-back" title="后退 15 秒">${ICONS.back15}</button>
                <button class="bmp-chip b-speed" title="播放速度（保持音调）">1×</button>
                <button class="bmp-chip b-seek-fwd" title="前进 15 秒">${ICONS.fwd15}</button>
                <button class="bmp-chip b-lrc-toggle" title="歌词 (L)">${ICONS.lrc}</button>
                <div class="bmp-vol">
                    <span class="b-vol-ic">${ICONS.vol}</span>
                    <div class="bmp-vslider"><div class="vt"><div class="vf"></div></div><div class="vk"></div></div>
                </div>
            </div>`;
        // play/pause 双图标处理
        const playBtn = $(".bmp-play", this.el);
        playBtn.innerHTML = `<span class="ic-play">${ICONS.play}</span><span class="ic-pause" style="display:none">${ICONS.pause}</span>`;
        const repBtn = $(".b-repeat", this.el);
        repBtn.innerHTML = `<span class="ic-rep">${ICONS.repeat}</span><span class="ic-rep1" style="display:none">${ICONS.repeat1}</span><span class="dot"></span>`;
        $(".b-seek-back", this.el).innerHTML = ICONS.back15;
        $(".b-seek-fwd", this.el).innerHTML = ICONS.fwd15;
        $(".b-lrc-toggle", this.el).innerHTML = ICONS.lrc;

        this.bindControls();
        this.bindProgress();
        this.bindVolume();
        this.bindDragDrop();
        this.bindKeys();
        this.loop();                 // 启动 rAF 主循环（频谱 / 进度 / 歌词滚动的唯一驱动）
        return this.el;
    }

    /* ---------------- widget 桥接 ---------------- */
    W(name) { return this.node.widgets?.find((w) => w.name && w.name.includes(name)); }
    get playlist() { return (this.W("音乐文件")?.options?.values || []).filter((v) => v && v !== "no audio file" && !String(v).startsWith("no ")); }
    get autoplay() { return this.W("自动播放")?.value ?? true; }
    get rate() { return this._rate ?? (this.prefs.rate ?? 1); }
    set rate(v) { this._rate = v; Prefs.set("rate", v); }
    get volume() { return this._volume ?? (this.prefs.volume ?? .75); }
    set volume(v) { this._volume = v; Prefs.set("volume", v); }
    get repeatMode() { return this._repeat ?? (this.prefs.repeat ?? "list"); }
    set repeatMode(v) { this._repeat = v; Prefs.set("repeat", v); }
    get shuffleOn() { return this._shuffle ?? !!this.prefs.shuffle; }
    set shuffleOn(v) { this._shuffle = v; Prefs.set("shuffle", v); }

    wireWidgetOnce() {
        const fw = this.W("音乐文件");
        if (!fw) { requestAnimationFrame(() => this.wireWidgetOnce()); return; }  // widget 尚未就绪，下一帧重试
        if (this._wired) return; this._wired = true;
        fw.callback = (v) => { if (v && v !== "no audio file") this.loadFromFileWidget(v, this.autoplay); };
        const sw = this.W("频谱样式");
        if (sw) sw.callback = (v) => { const i = this.styles.indexOf(v); if (i >= 0) { this.styleIdx = i; this.syncStyleName(); } };
        // 样式初始值：偏好优先，其次 widget 序列化值
        if (typeof this.prefs.style === "number") this.styleIdx = this.prefs.style;
        else if (sw && this.styles.includes(sw.value)) this.styleIdx = this.styles.indexOf(sw.value);
        this.syncStyleName();
        this.syncSpeedUI(); this.syncVolumeUI(); this.syncRepeatUI();
        this.applyTheme(this.currentName || "banzhang");
        const ro = new ResizeObserver(() => this.resizeCanvas());
        ro.observe($(".bmp-visual", this.el));
        this._ro = ro;
        requestAnimationFrame(() => this.resizeCanvas());
        this.ready = true;
        this.loop();
    }

    /* ---------------- 事件绑定 ---------------- */
    bindControls() {
        $(".b-play", this.el).addEventListener("click", (e) => { e.stopPropagation(); this.togglePlay(); });
        $(".b-next", this.el).addEventListener("click", (e) => { e.stopPropagation(); this.stepTrack(1); });
        $(".b-prev", this.el).addEventListener("click", (e) => { e.stopPropagation(); this.stepTrack(-1); });
        $(".b-repeat", this.el).addEventListener("click", (e) => { e.stopPropagation(); this.cycleRepeat(); });
        $(".b-shuffle", this.el).addEventListener("click", (e) => { e.stopPropagation(); this.shuffleOn = !this.shuffleOn; this.syncRepeatUI(); toast(this.shuffleOn ? "随机播放：开" : "随机播放：关"); });
        $(".b-speed", this.el).addEventListener("click", (e) => { e.stopPropagation(); this.cycleSpeed(); });
        $(".b-seek-back", this.el).addEventListener("click", (e) => { e.stopPropagation(); this.seek(this.audio.currentTime - 15); });
        $(".b-seek-fwd", this.el).addEventListener("click", (e) => { e.stopPropagation(); this.seek(this.audio.currentTime + 15); });
        $(".b-lrc-toggle", this.el).addEventListener("click", (e) => { e.stopPropagation(); this.setView(this.view === "lyrics" ? "viz" : "lyrics"); });
        const styleBtn = $(".bmp-stylebtn", this.el);
        styleBtn.addEventListener("click", (e) => { e.stopPropagation(); this.cycleStyle(); });
        $(".bmp-canvas", this.el).addEventListener("click", () => { if (this.view === "viz") this.cycleStyle(); });
        // 歌词粘贴
        const lrcBox = $(".bmp-lyrics", this.el), edit = $(".bmp-lrc-edit", this.el), ta = $("textarea", edit);
        $(".bmp-lrc-paste", this.el).addEventListener("click", (e) => { e.stopPropagation(); ta.value = this.lrc.raw || ""; edit.classList.add("on"); ta.focus(); });
        $(".bmp-lrc-cancel", edit).addEventListener("click", () => edit.classList.remove("on"));
        $(".bmp-lrc-save", edit).addEventListener("click", () => {
            const text = ta.value;
            if (text.trim()) {
                try { localStorage.setItem(lrcKey(this.currentName), text); } catch (err) { }
                this.applyLyrics(text);
                toast("歌词已保存并绑定到当前曲目");
            }
            edit.classList.remove("on");
        });
    }

    bindProgress() {
        const bar = $(".bmp-prog", this.el);
        const ratio = (e) => { const r = bar.getBoundingClientRect(); return clamp((e.clientX - r.left) / r.width, 0, 1); };
        bar.addEventListener("pointerdown", (e) => {
            bar.setPointerCapture(e.pointerId); this.scrubbing = true; bar.classList.add("scrub");
            this.pending = ratio(e) * (this.audio.duration || 0); this.renderProgress(this.pending);
        });
        bar.addEventListener("pointermove", (e) => {
            const p = ratio(e), tip = $(".tip", bar);
            tip.style.left = (p * 100) + "%"; tip.textContent = fmt(p * (this.audio.duration || 0));
            if (this.scrubbing) { this.pending = p * (this.audio.duration || 0); this.renderProgress(this.pending); }
        });
        const up = () => { if (!this.scrubbing) return; this.scrubbing = false; bar.classList.remove("scrub"); this.seek(this.pending); };
        bar.addEventListener("pointerup", up);
        bar.addEventListener("pointercancel", up);
    }

    bindVolume() {
        const s = $(".bmp-vslider", this.el);
        const ratio = (e) => { const r = s.getBoundingClientRect(); return clamp((e.clientX - r.left) / r.width, 0, 1); };
        const set = (v) => { this.volume = v; this._muted = false; this.applyVolume(); };
        s.addEventListener("pointerdown", (e) => { s.setPointerCapture(e.pointerId); this.volDrag = true; set(ratio(e)); });
        s.addEventListener("pointermove", (e) => { if (this.volDrag) set(ratio(e)); });
        window.addEventListener("pointerup", () => { this.volDrag = false; });
        $(".b-vol-ic", this.el).addEventListener("click", () => { this._muted = !this._muted; this.applyVolume(); });
    }

    bindDragDrop() {
        this.el.addEventListener("dragover", (e) => { e.preventDefault(); e.stopPropagation(); this.el.classList.add("dragover"); });
        this.el.addEventListener("dragleave", (e) => { e.preventDefault(); e.stopPropagation(); this.el.classList.remove("dragover"); });
        this.el.addEventListener("drop", async (e) => {
            e.preventDefault(); e.stopPropagation(); this.el.classList.remove("dragover");
            const file = e.dataTransfer.files[0];
            if (file && (file.type.startsWith("audio/") || /\.(mp3|wav|flac|m4a|ogg|opus|aac|aif|aiff|webm)$/i.test(file.name))) await this.uploadFile(file);
            else toast("请拖入音频文件（MP3 / WAV / FLAC / M4A / OGG / OPUS）", true);
        });
    }

    bindKeys() {
        // 仅在播放器获得焦点时拦截，避免与 ComfyUI 画布快捷键冲突
        this.el.addEventListener("keydown", (e) => {
            const k = e.key;
            if (k === " ") {
                if (e.target.tagName === "BUTTON") return;  // 按钮自身处理空格，避免双触发
                e.preventDefault(); e.stopPropagation(); this.togglePlay();
            }
            else if (k === "ArrowLeft") { e.preventDefault(); e.stopPropagation(); this.seek(this.audio.currentTime - 5); }
            else if (k === "ArrowRight") { e.preventDefault(); e.stopPropagation(); this.seek(this.audio.currentTime + 5); }
            else if (k === "ArrowUp") { e.preventDefault(); this.volume = clamp(this.volume + .05, 0, 1); this.applyVolume(); }
            else if (k === "ArrowDown") { e.preventDefault(); this.volume = clamp(this.volume - .05, 0, 1); this.applyVolume(); }
            else if (k.toLowerCase() === "l") { this.setView(this.view === "lyrics" ? "viz" : "lyrics"); }
            else if (k.toLowerCase() === "m") { this._muted = !this._muted; this.applyVolume(); }
        });
    }

    async uploadFile(file) {
        $(".bmp-name", this.el).textContent = "📡 正在上传...";
        try {
            const fd = new FormData();
            fd.append("image", file); fd.append("type", "input"); fd.append("overwrite", "true");
            const resp = await fetch("/upload/image", { method: "POST", body: fd });
            if (!resp.ok) throw new Error("upload " + resp.status);
            const data = await resp.json();
            const filename = data.name || file.name;
            const fw = this.W("音乐文件");
            if (fw) {
                if (Array.isArray(fw.options?.values) && !fw.options.values.includes(filename)) fw.options.values.push(filename);
                fw.value = filename; app.graph.setDirtyCanvas(true);
                this.loadFromFileWidget(filename, true);
            }
        } catch (err) {
            $(".bmp-name", this.el).textContent = "❌ 上传失败";
            toast("音频上传失败，请检查文件后重试", true);
        }
    }

    /* ---------------- 播放引擎 ---------------- */
    ensureGraph() {
        if (this.ctx) return;
        try {
            const AC = window.AudioContext || window.webkitAudioContext;
            this.ctx = new AC();
            this.analyser = this.ctx.createAnalyser();
            this.analyser.fftSize = 1024; this.analyser.smoothingTimeConstant = .82;
            this.gain = this.ctx.createGain(); this.gain.gain.value = this._muted ? 0 : this.volume;
            this.mediaNode = this.ctx.createMediaElementSource(this.audio);
            this.mediaNode.connect(this.analyser); this.analyser.connect(this.gain); this.gain.connect(this.ctx.destination);
            this.freq = new Uint8Array(this.analyser.frequencyBinCount);
            this.wave = new Uint8Array(this.analyser.frequencyBinCount);
            this.applyVolume();
        } catch (err) { console.warn("[BMP] AudioContext init failed:", err); }
    }

    applyTheme(name) {
        const h = hueOfName(name || "banzhang");
        this.hue = h;
        this.el.style.setProperty("--c1", `hsl(${h},80%,56%)`);
        this.el.style.setProperty("--c2", `hsl(${(h + 42) % 360},72%,58%)`);
        this.el.style.setProperty("--c1a", `hsla(${h},80%,56%,.55)`);
        this.el.style.setProperty("--c2a", `hsla(${(h + 42) % 360},72%,58%,.5)`);
    }

    loadFromFileWidget(name, autoplay) {
        if (!name || name === "no audio file") return;
        const url = `/view?filename=${encodeURIComponent(name)}&type=input`;
        this.loadAudio(url, name, autoplay, { type: "input", filename: name, subfolder: "" });
        // 前端侧尝试同名 .lrc（后端执行时也会匹配并回传）
        const stored = (() => { try { return localStorage.getItem(lrcKey(name)); } catch (e) { return null; } })();
        if (stored) { this.applyLyrics(stored); return; }
        fetch(`/view?filename=${encodeURIComponent(name.replace(/\.[^.]+$/, ".lrc"))}&type=input`)
            .then((r) => { if (!r.ok) throw new Error("no lrc"); return r.text(); })
            .then((t) => { if (t.trim() && !this.lrc.lines.length) this.applyLyrics(t); })
            .catch(() => { });
    }

    loadAudio(url, name, autoplay, meta) {
        if (!url) return;
        this.audio.pause();
        this.audio.src = url;
        this.currentUrl = url; this.currentName = name || "未知音频";
        this.applyTheme(this.currentName);
        $(".bmp-name", this.el).textContent = this.currentName;
        $(".bmp-sub", this.el).textContent = meta
            ? (meta.type === "input" ? `input · ${meta.filename}` : `管线预览 · ${meta.filename}`)
            : "节点内试听 · 拖入文件即可上传到 input";
        this.audio.onloadedmetadata = () => {
            this.resizeCanvas();
            this.syncMetaUI();
            if (autoplay) this.play();
        };
        this.audio.onprogress = () => this.updateBuffered();
        this.audio.onended = () => this.onEnded();
        this.bufPct = 0;
        this.activeLrc = -99;
        this.syncPlayUI();
        this.clearCanvas();
        this.updateMediaSession();
    }

    async play() {
        this.ensureGraph();
        if (this.ctx && this.ctx.state === "suspended") await this.ctx.resume();
        this.audio.playbackRate = this.rate;
        try { this.audio.preservesPitch = true; this.audio.mozPreservesPitch = true; this.audio.webkitPreservesPitch = true; } catch (e) { }
        try {
            await this.audio.play();
            Focus.notifyPlay(this);
            this.syncPlayUI();
            this.updateMediaSession();
        } catch (err) {
            toast("浏览器拦截了自动播放，请点击播放键", true);
        }
    }
    pause(silent) {
        this.audio.pause();
        if (!silent) Focus.leave(this);
        this.syncPlayUI();
    }
    remotePause() { this.pause(true); }// 音频焦点：被其它播放器打断
    togglePlay() { if (this.audio.paused) this.play(); else this.pause(); }

    seek(t) {
        if (!isFinite(this.audio.duration)) return;
        this.audio.currentTime = clamp(t, 0, this.audio.duration);
        this.renderProgress(this.audio.currentTime);
        this.renderLyrics(true);
    }

    onEnded() {
        if (this.repeatMode === "one") { this.audio.currentTime = 0; this.play(); return; }
        if (this.repeatMode === "list") {
            if (this.playlist.length <= 1) { this.audio.currentTime = 0; this.play(); return; }
            if (this.stepTrack(1, true)) return;
        }
        this.pause(); this.audio.currentTime = 0;
    }

    stepTrack(dir, autoplay) {
        const list = this.playlist;
        if (list.length <= 1) { if (dir < 0) this.seek(0); return false; }
        const fw = this.W("音乐文件");
        let idx = list.indexOf(fw?.value);
        let next;
        if (this.shuffleOn && dir > 0) {
            next = list[Math.floor(Math.random() * list.length)];
        } else {
            idx = idx < 0 ? 0 : idx;
            next = list[(idx + dir + list.length) % list.length];
        }
        if (fw) { fw.value = next; if (fw.callback) fw.callback(next); app.graph.setDirtyCanvas(true); }
        if (autoplay) this.play();
        return true;
    }

    cycleRepeat() {
        this.repeatMode = this.repeatMode === "off" ? "list" : this.repeatMode === "list" ? "one" : "off";
        this.syncRepeatUI();
        toast({ off: "循环：关闭", list: "循环：列表", one: "循环：单曲" }[this.repeatMode]);
    }
    cycleSpeed() {
        const seq = [.5, .75, 1, 1.25, 1.5, 2];
        const v = seq[(seq.indexOf(this.rate) + 1) % seq.length];
        this.rate = v; this.audio.playbackRate = v; this.syncSpeedUI();
        toast(`播放速度 ${v}×（保持音调）`);
    }
    cycleStyle() {
        this.styleIdx = (this.styleIdx + 1) % this.styles.length;
        Prefs.set("style", this.styleIdx);
        const sw = this.W("频谱样式");
        if (sw && this.styles.includes(this.styles[this.styleIdx])) sw.value = this.styles[this.styleIdx];
        this.syncStyleName();
    }

    applyVolume() {
        const v = this._muted ? 0 : this.volume;
        if (this.gain && this.ctx) this.gain.gain.setTargetAtTime(v, this.ctx.currentTime, .02);
        const pct = v * 100;
        const fill = $(".vf", this.el), knob = $(".vk", this.el);
        if (fill) fill.style.width = pct + "%";
        if (knob) knob.style.left = pct + "%";
        $(".b-vol-ic", this.el).innerHTML = (this._muted || v === 0) ? ICONS.mute : ICONS.vol;
    }
    syncSpeedUI() { $(".b-speed", this.el).textContent = this.rate + "×"; }
    syncRepeatUI() {
        $(".b-shuffle", this.el).classList.toggle("on", this.shuffleOn);
        const rep = $(".b-repeat", this.el);
        rep.classList.toggle("on", this.repeatMode !== "off");
        $(".ic-rep", rep).style.display = this.repeatMode === "one" ? "none" : "";
        $(".ic-rep1", rep).style.display = this.repeatMode === "one" ? "" : "none";
    }
    syncStyleName() { const n = $(".bmp-style-name", this.el); if (n) n.textContent = this.styles[this.styleIdx]; }
    syncPlayUI() {
        const playing = !this.audio.paused;
        $(".ic-play", this.el).style.display = playing ? "none" : "";
        $(".ic-pause", this.el).style.display = playing ? "" : "none";
        $(".bmp-empty", this.el).style.display = playing || this.view === "lyrics" ? "none" : "grid";
        if ("mediaSession" in navigator) { try { navigator.mediaSession.playbackState = playing ? "playing" : "paused"; } catch (e) { } }
    }
    syncMetaUI() {
        const d = this.audio.duration;
        if (isFinite(d) && d > 0) $(".t-dur", this.el).textContent = fmt(d);
    }
    setMetaInfo(info) {
        if (!info) return;
        const parts = [];
        if (info.sample_rate) parts.push((info.sample_rate / 1000).toFixed(1) + " kHz");
        parts.push((info.channels === 2 ? "立体声" : (info.channels === 1 ? "单声道" : (info.channels || "?") + " 声道")));
        if (info.duration) parts.push(fmt(info.duration));
        $(".bmp-sub", this.el).textContent = parts.join(" · ");
        if (info.duration) $(".t-dur", this.el).textContent = fmt(info.duration);
    }
    updateBuffered() {
        let p = 0;
        if (this.audio.buffered.length && isFinite(this.audio.duration))
            p = this.audio.buffered.end(this.audio.buffered.length - 1) / this.audio.duration;
        this.bufPct = clamp(p, 0, 1);
        $(".buf", this.el).style.width = (this.bufPct * 100) + "%";
    }

    /* ---------------- 视图 ---------------- */
    setView(v, silent) {
        this.view = v;
        $(".bmp-canvas", this.el).style.display = v === "viz" ? "block" : "none";
        $(".bmp-lyrics", this.el).classList.toggle("on", v === "lyrics");
        $(".bmp-stylebtn", this.el).style.display = v === "viz" ? "flex" : "none";
        $(".b-lrc-toggle", this.el).classList.toggle("on", v === "lyrics");
        $(".bmp-empty", this.el).style.display = (!this.audio.paused || v === "lyrics") ? "none" : "grid";
        if (v === "lyrics") this.renderLyrics(true);
        this.resizeCanvas();
    }

    /* ---------------- 歌词（安全渲染） ---------------- */
    applyLyrics(text) {
        this.lrc.raw = text || "";
        this.lrc = Object.assign({ raw: this.lrc.raw }, parseLRC(text));
        const box = $(".bmp-lyrics-scroll", this.el);
        box.innerHTML = "";
        if (!this.lrc.lines.length) {
            const d = document.createElement("div");
            d.style.cssText = "opacity:.45;font-size:12px;margin-top:24px;line-height:1.9";
            d.textContent = "暂无歌词\n可点左上角「粘贴歌词」，或在 input 放同名 .lrc 文件";
            d.style.whiteSpace = "pre-line";
            box.appendChild(d);
            this.activeLrc = -99;
            return;
        }
        this.lrc.lines.forEach((l) => {
            const d = document.createElement("div");
            d.className = "bmp-lrc-line";
            const t = document.createElement("span");
            t.textContent = l.text;                 // textContent 天然防 XSS
            d.appendChild(t);
            if (l.trans) {
                const tr = document.createElement("span");
                tr.className = "tr"; tr.textContent = l.trans;
                d.appendChild(tr);
            }
            d.addEventListener("click", () => {
                this.seek(l.time);
                if (this.audio.paused) this.play();
            });
            box.appendChild(d);
        });
        this.activeLrc = -99;
        this.renderLyrics(true);
    }

    renderLyrics(force) {
        if (this.view !== "lyrics" || !this.lrc.lines.length) return;
        const time = this.audio.currentTime;
        let idx = -1;
        for (let i = 0; i < this.lrc.lines.length; i++) { if (time >= this.lrc.lines[i].time) idx = i; else break; }
        if (idx === this.activeLrc && !force) return;
        this.activeLrc = idx;
        const lines = $(".bmp-lyrics-scroll", this.el).querySelectorAll(".bmp-lrc-line");
        lines.forEach((el, i) => el.classList.toggle("active", i === idx));
        if (idx >= 0 && lines[idx]) {
            const box = $(".bmp-lyrics-scroll", this.el), el = lines[idx];
            const top = el.offsetTop - box.clientHeight / 2 + el.clientHeight / 2;
            box.scrollTo({ top, behavior: force ? "auto" : "smooth" });
        }
    }

    /* ---------------- 进度 ---------------- */
    renderProgress(time) {
        const dur = this.audio.duration || 0;
        const p = dur ? clamp(time / dur, 0, 1) : 0;
        $(".fill", this.el).style.width = (p * 100) + "%";
        $(".knob", this.el).style.left = (p * 100) + "%";
        $(".t-cur", this.el).textContent = fmt(time);
        if (dur) $(".t-dur", this.el).textContent = fmt(dur);
    }

    /* ---------------- 频谱（DPR 适配） ---------------- */
    resizeCanvas() {
        const c = $(".bmp-canvas", this.el);
        if (!c) return;
        const host = c.parentElement.getBoundingClientRect();
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        if (host.width > 0 && host.height > 0) {
            c.width = host.width * dpr; c.height = host.height * dpr;
            c.getContext("2d").setTransform(dpr, 0, 0, dpr, 0, 0);
            this.vw = host.width; this.vh = host.height;
            this.peaks = [];
            if (!this.audio.paused) this.drawViz();
        }
    }
    clearCanvas() {
        const c = $(".bmp-canvas", this.el);
        c.getContext("2d").clearRect(0, 0, c.width, c.height);
    }
    drawViz() {
        if (!this.analyser) return;
        const c = $(".bmp-canvas", this.el);
        if (!c) return;
        const ctx = c.getContext("2d");
        const w = this.vw, h = this.vh;
        if (!w || !h) return;
        ctx.clearRect(0, 0, w, h);
        const h1 = this.hue ?? 211, h2 = (h1 + 42) % 360;
        const si = this.styleIdx;

        if (si === 1) { /* 丝滑波形（时域） */
            this.analyser.getByteTimeDomainData(this.wave);
            const sl = w / this.wave.length;
            ctx.beginPath(); ctx.moveTo(0, h / 2);
            this.wave.forEach((v, i) => ctx.lineTo(i * sl, h / 2 + (v / 128) * h / 2));
            for (let i = this.wave.length - 1; i >= 0; i--) ctx.lineTo(i * sl, h / 2 - (this.wave[i] / 128) * h / 2);
            ctx.closePath();
            const fg = ctx.createLinearGradient(0, 0, 0, h);
            fg.addColorStop(0, `hsla(${h2},72%,58%,.28)`); fg.addColorStop(.5, `hsla(${h1},80%,56%,.18)`); fg.addColorStop(1, `hsla(${h2},72%,58%,.28)`);
            ctx.fillStyle = fg; ctx.fill();
            ctx.beginPath();
            this.wave.forEach((v, i) => { const y = h / 2 + (v / 128) * h / 2; i ? ctx.lineTo(i * sl, y) : ctx.moveTo(i * sl, y); });
            ctx.lineWidth = 2.2; ctx.strokeStyle = "rgba(255,255,255,.92)";
            ctx.shadowColor = `hsla(${h1},80%,56%,.8)`; ctx.shadowBlur = 10;
            ctx.stroke(); ctx.shadowBlur = 0;
            return;
        }

        this.analyser.getByteFrequencyData(this.freq);

        if (si === 0) { /* 镜像圆角柱 */
            const n = 48, bw = w / n, mid = h / 2;
            if (this.peaks.length !== n) this.peaks = new Array(n).fill(0);
            for (let i = 0; i < n; i++) {
                const idx = Math.floor(Math.pow(i / n, 1.65) * (this.freq.length * .72));
                const v = (this.freq[idx] || 0) / 255;
                const bh = Math.max(v * mid * .92, 1.5);
                this.peaks[i] = Math.max(this.peaks[i] - .006, v);
                const x = i * bw + bw * .24, ww = bw * .52;
                const g = ctx.createLinearGradient(0, mid - bh, 0, mid + bh);
                g.addColorStop(0, `hsla(${h2},72%,60%,.95)`); g.addColorStop(1, `hsla(${h1},80%,55%,.95)`);
                ctx.fillStyle = g;
                rr(ctx, x, mid - bh, ww, bh, bw * .26); ctx.fill();
                rr(ctx, x, mid, ww, bh, bw * .26); ctx.fill();
                const ph = Math.max(this.peaks[i] * mid * .92, 1.5);
                ctx.fillStyle = "rgba(255,255,255,.8)";
                rr(ctx, x, mid - ph - 1.5, ww, 2, 1); ctx.fill();
                rr(ctx, x, mid + ph - .5, ww, 2, 1); ctx.fill();
            }
            return;
        }
        if (si === 2) { /* 环形扩散 */
            const cx = w / 2, cy = h / 2, R = Math.min(w, h) * .16, bars = 56;
            for (let i = 0; i < bars; i++) {
                const idx = Math.floor(Math.pow(i / bars, 1.4) * (this.freq.length * .6));
                const v = (this.freq[idx] || 0) / 255, len = 3 + v * R * 1.5;
                const ang = (i / bars) * Math.PI * 2 - Math.PI / 2;
                ctx.strokeStyle = `hsla(${(h1 + i / bars * 42) % 360},75%,62%,${.4 + v * .5})`;
                ctx.lineWidth = 3; ctx.lineCap = "round";
                ctx.beginPath();
                ctx.moveTo(cx + Math.cos(ang) * R, cy + Math.sin(ang) * R);
                ctx.lineTo(cx + Math.cos(ang) * (R + len), cy + Math.sin(ang) * (R + len));
                ctx.stroke();
            }
            ctx.beginPath(); ctx.arc(cx, cy, R - 6, 0, Math.PI * 2);
            ctx.strokeStyle = "rgba(255,255,255,.13)"; ctx.lineWidth = 1; ctx.stroke();
            return;
        }
        /* 像素点阵 */
        const cols = 24, rows = 6, cw = w / cols, chh = h / (rows * 2);
        for (let i = 0; i < cols; i++) {
            const idx = Math.floor(Math.pow(i / cols, 1.5) * (this.freq.length * .6));
            const v = (this.freq[idx] || 0) / 255, lit = Math.round(v * rows);
            for (let j = 0; j < rows; j++) {
                const on = j < lit;
                ctx.fillStyle = on ? `hsla(${(h1 + j / rows * 42) % 360},75%,62%,.9)` : "rgba(255,255,255,.07)";
                const d = Math.min(cw, chh * 2) * .4;
                ctx.beginPath(); ctx.arc((i + .5) * cw, h / 2 - (j + .5) * chh * 2, d / 2, 0, Math.PI * 2); ctx.fill();
                ctx.beginPath(); ctx.arc((i + .5) * cw, h / 2 + (j + .5) * chh * 2, d / 2, 0, Math.PI * 2); ctx.fill();
            }
        }
    }

    /* ---------------- 主循环（rAF 音频时钟） ---------------- */
    loop() {
        cancelAnimationFrame(this.raf);
        const tick = () => {
            if (this._destroyed) return;
            this.raf = requestAnimationFrame(tick);
            if (this.audio.paused) return;            // 暂停时空转，不写 DOM
            if (this.view === "viz" && this.analyser) this.drawViz();
            if (this.view === "lyrics") this.renderLyrics();
            if (!this.scrubbing) this.renderProgress(this.audio.currentTime || 0);
            if (this.ab && isFinite(this.audio.duration) && this.audio.currentTime >= this.ab.b)
                this.seek(this.ab.a);
        };
        tick();
    }

    /* ---------------- Media Session（媒体键 / 锁屏） ---------------- */
    updateMediaSession() {
        if (!("mediaSession" in navigator)) return;
        try {
            navigator.mediaSession.metadata = new MediaMetadata({
                title: this.currentName.replace(/\.[^.]+$/, ""),
                artist: "班长音乐播放器",
                album: "ComfyUI Banzhang-All"
            });
            navigator.mediaSession.setActionHandler("play", () => this.play());
            navigator.mediaSession.setActionHandler("pause", () => this.pause());
            navigator.mediaSession.setActionHandler("previoustrack", () => this.stepTrack(-1, true));
            navigator.mediaSession.setActionHandler("nexttrack", () => this.stepTrack(1, true));
            navigator.mediaSession.setActionHandler("seekbackward", () => this.seek(this.audio.currentTime - 15));
            navigator.mediaSession.setActionHandler("seekforward", () => this.seek(this.audio.currentTime + 15));
        } catch (e) { }
    }

    /* ---------------- 后端执行消息入口 ---------------- */
    handleExecuted(message) {
        if (!message) return;
        if (message.audio?.[0]) {
            const a = message.audio[0];
            const url = `/view?filename=${encodeURIComponent(a.filename)}&type=${a.type || "temp"}&subfolder=${encodeURIComponent(a.subfolder || "")}`;
            this.loadAudio(url, a.filename, this.W("自动播放")?.value ?? true, a);
            if (a.type === "input") {
                const fw = this.W("音乐文件");
                if (fw && Array.isArray(fw.options?.values) && !fw.options.values.includes(a.filename)) {
                    fw.options.values.push(a.filename); app.graph.setDirtyCanvas(true);
                }
            }
        }
        if (message.lyrics?.[0]) this.applyLyrics(message.lyrics[0]);
        if (message.meta?.[0]) this.setMetaInfo(message.meta[0]);
        if (message.status) {
            const s = message.status;
            if (typeof s === "string") toast(s.replace(/^[✅🎧⚠️❌]\s*/, ""), /❌/.test(s));
        }
    }

    /* ---------------- 销毁（防泄漏） ---------------- */
    destroy() {
        this._destroyed = true;
        cancelAnimationFrame(this.raf);
        try { this.audio.pause(); this.audio.removeAttribute("src"); this.audio.load(); } catch (e) { }
        try { this._ro?.disconnect(); } catch (e) { }
        try { this.ctx?.close(); } catch (e) { }
        Focus.leave(this);
    }
}

/* ============================================================
   DOM widget 双通道挂载（遵循 docs/AI节点开发铁律.md 第 1/2/3/11 节）
   - computeSize                       → 旧 litegraph 布局通道
   - getMinHeight/getMaxHeight/getHeight + computeLayoutSize → v2 VueNodes 通道
   - margin:4、offsetHeight 实测、ResizeObserver、configure 后多轮重算
   ============================================================ */
const PANEL_MARGIN = 4;    // 框架默认 10 会让容器上下各被裁 10px
const BOTTOM_PAD = 8;
const PANEL_MINW = 330;
const PANEL_FALLBACK_H = 400;

function declarePlayerHeight(node) {
    const w = node._bmpDomW;
    if (!w) return;
    const pad = 2 * (w.margin ?? PANEL_MARGIN) - 4;
    w.computeSize = () => [node.size[0], node._bmpHeight + pad];
    w.computeLayoutSize = () => ({
        minHeight: node._bmpHeight + pad,
        maxHeight: node._bmpHeight + pad,
        minWidth: 0,
    });
}

function naturalPlayerHeight(el) {
    // 临时解除 v2 容器对元素的高度锁定 / flex 拉伸，测内容自然高后还原（同步测量，无渲染帧，不可见）
    const keys = ["height", "minHeight", "maxHeight", "flex", "alignSelf"];
    const old = keys.map((k) => el.style[k]);
    el.style.height = "auto";
    el.style.minHeight = "0px";
    el.style.maxHeight = "none";
    el.style.flex = "0 0 auto";
    el.style.alignSelf = "flex-start";
    const h = el.offsetHeight | 0;
    keys.forEach((k, i) => { el.style[k] = old[i]; });
    return h;
}

function fitPlayerNode(node) {
    const el = node._bmpEl, w = node._bmpDomW;
    if (!el || !w) return;
    // 必须用内容自然高：offsetHeight 在 v2 首轮会读到被容器拉伸后的虚高，锁死后底部留白缩不回
    const h = naturalPlayerHeight(el) || (el.offsetHeight | 0);
    if (h) node._bmpHeight = h;
    declarePlayerHeight(node);
    let cs = [0, 0];
    try { cs = node.computeSize() || [0, 0]; } catch (e) { }
    const m = w.margin ?? PANEL_MARGIN;
    const byDom = (w.y || 0) + m + node._bmpHeight + m + BOTTOM_PAD;
    const needH = Math.ceil(Math.max(cs[1] || 0, byDom));
    const needW = Math.max(cs[0] || 0, node.size?.[0] || 0, PANEL_MINW);
    if (Math.abs((node.size?.[1] || 0) - needH) > 2 || needW > (node.size?.[0] || 0)) {
        node.setSize([needW, needH]);
        node.setDirtyCanvas?.(true, true);
    }
    node.player?.resizeCanvas();
}

function schedulePlayerFit(node) {
    fitPlayerNode(node);
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => fitPlayerNode(node));
    if (typeof setTimeout === "function") {
        setTimeout(() => fitPlayerNode(node), 60);
        setTimeout(() => fitPlayerNode(node), 300);
    }
}

function mountPlayerPanel(node, el) {
    node._bmpEl = el;
    node._bmpHeight = PANEL_FALLBACK_H;
    el.style.width = "100%";
    el.style.boxSizing = "border-box";
    // 阻止面板交互冒泡到画布（打字/拖拽/点击不触发节点拖动与画布快捷键）
    el.addEventListener("mousedown", (e) => e.stopPropagation());
    el.addEventListener("keydown", (e) => e.stopPropagation());

    const w = node.addDOMWidget("player_gui", "player_gui", el, {
        serialize: false,
        hideOnZoom: false,
        margin: PANEL_MARGIN,
        getMinHeight: () => node._bmpHeight,
        getMaxHeight: () => node._bmpHeight,
        getHeight: () => node._bmpHeight,
    });
    node._bmpDomW = w;
    node.size[0] = Math.max(node.size[0] ?? 0, PANEL_MINW);

    if (typeof ResizeObserver !== "undefined" && !node._bmpRO) {
        node._bmpRO = new ResizeObserver(() => fitPlayerNode(node));
        node._bmpRO.observe(el);
    }
    const prevResize = node.onResize;
    node.onResize = function () {
        prevResize?.apply(this, arguments);
        fitPlayerNode(this);
    };
    const prevRemoved = node.onRemoved;
    node.onRemoved = function () {
        this._bmpRO?.disconnect();
        this._bmpRO = null;
        this.player?.destroy();
        prevRemoved?.apply(this, arguments);
    };

    schedulePlayerFit(node);
    return w;
}

app.registerExtension({
    name: "Comfy.SquadLeader.MusicPlayerV30",
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== "BanZhang_MusicPlayerWithLyrics") return;

        const onCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            onCreated?.apply(this, arguments);
            try {
                injectStyle();
                Prefs.load();
                this.player = new NodeMusicPlayer(this);
                mountPlayerPanel(this, this.player.createUI());
                requestAnimationFrame(() => this.player.wireWidgetOnce());
                console.log("[BMP] 播放器面板已挂载，节点", this.id);
            } catch (err) {
                console.error("[BMP] 播放器面板初始化失败:", err);
            }
        };

        // 刷新/加载工作流后：widget 值已恢复，重新桥接并把存档旧高度收回
        const onConfigure = nodeType.prototype.configure;
        nodeType.prototype.configure = function () {
            onConfigure?.apply(this, arguments);
            // 自检：存档里残留的"临时试听文件名"要归位，否则提交时后端会报 Value not in list。
            // 后端生成规则固定为 preview_{8位小写字母数字}.{wav|mp3|ogg|flac}，写在 temp 目录、
            // 不在 input 清单里 —— 只有这类名字才归位，绝不误伤用户真实选中的音频。
            const fw = this.widgets?.find((w) => w.name && w.name.includes("音乐文件"));
            if (fw) {
                const v = fw.value;
                if (typeof v === "string" && /^preview_[a-z0-9]{8}\.(?:wav|mp3|ogg|flac)$/.test(v)) {
                    fw.value = "no audio file";
                    if (Array.isArray(fw.options?.values)) {
                        fw.options.values = fw.options.values.filter((x) => x !== v);
                    }
                    console.warn(`[BMP] 已归位失效的临时试听文件: ${v}`);
                }
            }
            requestAnimationFrame(() => this.player?.wireWidgetOnce());
            if (this._bmpEl) schedulePlayerFit(this);
        };

        nodeType.prototype.getExtraMenuOptions = function (canvas, options) {
            const p = this.player;
            if (p?.currentUrl) {
                options.push({
                    content: "💾 下载当前音频",
                    callback: () => {
                        const url = p.currentUrl;
                        const filename = new URLSearchParams(url.split("?")[1]).get("filename") || "audio_export";
                        const a = document.createElement("a");
                        a.href = url; a.download = filename;
                        document.body.appendChild(a); a.click(); document.body.removeChild(a);
                    }
                }, {
                    content: "⏺ A-B 循环：设为起点",
                    callback: () => {
                        if (!isFinite(p.audio.duration)) return toast("请先加载音频", true);
                        p.ab = { a: p.audio.currentTime, b: (p.ab?.b ?? p.audio.duration) };
                        toast(`A-B 起点 ${fmt(p.ab.a)}`);
                    }
                }, {
                    content: "⏺ A-B 循环：设为终点并开启",
                    callback: () => {
                        if (!p.ab) return toast("请先设置起点", true);
                        p.ab.b = p.audio.currentTime;
                        if (p.ab.b <= p.ab.a) { p.ab = null; toast("终点早于起点，已取消 A-B", true); }
                        else toast(`A-B 循环：${fmt(p.ab.a)} – ${fmt(p.ab.b)}`);
                    }
                }, {
                    content: "✖ 取消 A-B 循环",
                    callback: () => { p.ab = null; toast("已取消 A-B 循环"); }
                });
            }
        };

        const onExecuted = nodeType.prototype.onExecuted;
        nodeType.prototype.onExecuted = function (message) {
            onExecuted?.apply(this, arguments);
            this.player?.handleExecuted(message);
        };
    }
});

