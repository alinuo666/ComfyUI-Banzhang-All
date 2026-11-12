import { api } from "../../scripts/api.js";
import { bzStore } from "./bz_store.js";

/* 导演台音频轴：多条音轨，一条轨 = 一个源文件 + 一个作用范围。
   第一条 = 主音轨（MV 整首歌），作用全片，拖入时按「每段 N 秒」定段数；
   再拖入的 = 附加轨（某段角色的人声），默认只作用在当前选中段，不改段数。
   波形块只按 film_summary 的 clip_from / clip_to 摆，续接让净长变化时所有轨
   一起按新边界重切，位置天然与视频段一一对应。
   没拖音频时也常驻一条空轨：轨头占住左侧那列，按段占位格与上方视频段对齐，
   否则时间轴上「视频下面那条音频轨」会整条消失、左侧只剩一大块空白。
   20261107 用户定：时间轴音频**只做驱动、不做参考**。切片回传的峰值只用于画
   波形；每段（多轨先混音）的驱动片段由后端写进 meta["bzsa.driver"]，导演台按
   当前段直读、编码进 H3 AV latent 的声音流并锁噪。媒体架 / 文案台是用户手动
   摆参考素材的地方，时间轴不桥接、不刷新、不覆盖它们。 */

const AC = "#5ad38a";
const LS_SEG = "bzsa.segSec";
const MAX_FRAMES = 719;
/* 左侧轨头列宽，必须与 csglide_film.js 的 TRACK_GUTTER、CSS 的
   .bzf-track margin-left / .bzsa-row grid 第一列同值。 */
const GUTTER = 26;
const HINT_TEXT = "把音频拖到这里（第一首定全片；再拖一首＝新增音轨，各轨按段混音后驱动画面）";
const segKey = (c) => (c && (c.id || ("#" + c.index))) || "";

let cssReady = false;
function injectCss() {
  if (cssReady) return;
  cssReady = true;
  const s = document.createElement("style");
  s.textContent = `
.bzsa { position: relative; margin-top: 6px; border-top: 1px solid var(--bz-line, #2a2a2e); padding-top: 6px; }
.bzsa-tracks { display: flex; flex-direction: column; gap: 8px; margin-top: 6px; }
.bzsa-row { display: grid; grid-template-columns: 26px 1fr; align-items: center;
  height: 40px; border-radius: 8px; background: #ffffff0a;
  /* 左侧 26px 只放一个静音按钮，与上方成片音轨的按钮上下对齐。
     margin-left:-26px 把静音列挪进视频轨左侧的轨头区；宽度必须补回 26px，
     否则第二列波形区比视频段块短 26px（20261107 用户报）。
     这里的 calc(100% + 26px) 只是「尺子还没建好」时的兜底：
     syncRowWidth() 会按最后一块 clip_to 的像素宽 + 26 写内联宽度，
     让行与波形块共用同一把像素尺，不再出现右侧空白带（20261108 根修）。 */
  position: relative; margin-left: -26px; width: calc(100% + 26px); }
.bzsa-row[data-muted="1"] { opacity: .4; }
.bzsa-left { display: flex; align-items: center; justify-content: center; padding-left: 3px; cursor: pointer; }
.bzsa-ico, .bzsa-name { display: none; }
/* 作用范围是「状态可见」的唯一出口：行头就写清这条轨管全片还是管哪一段。
   点一下循环切换，不用弹窗、不改列宽与行高。 */
.bzsa-scope { position: absolute; left: 30px; top: 2px; z-index: 2;
  max-width: 48px; height: 16px; padding: 0 3px; font-size: 10px; line-height: 16px;
  color: ${AC}; background: #000000a8; border: 1px solid ${AC}55; border-radius: 6px;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; cursor: pointer; }
.bzsa-scope:hover { background: ${AC}28; }
.bzsa-mute, .bzsa-x { width: 20px; height: 20px; flex: 0 0 20px; padding: 0; border: none; border-radius: 6px;
  background: transparent; color: #e6e6ea; font-size: 12px; line-height: 20px; cursor: pointer; }
.bzsa-mute:hover, .bzsa-x:hover { background: #ffffff14; }
.bzsa-lane { position: relative; height: 40px; overflow: hidden; }
/* 空轨提示住在轨道内部，不再单独占一行 —— 左侧轨头列与右侧轨道同时有内容。 */
.bzsa-hint { position: absolute; inset: 0; display: flex; align-items: center;
  justify-content: center; font-size: 11px; color: #e6e6ea66; pointer-events: none;
  border: 1px dashed #e6e6ea33; border-radius: 6px; }
/* 块按时间轴像素坐标摆（与上方段块同一把尺子），随轨道一起横向滚动。 */
.bzsa-strip { position: absolute; left: 0; top: 4px; height: 32px; }
.bzsa-block { position: absolute; top: 0; height: 32px; box-sizing: border-box; cursor: pointer;
  border: 1px solid ${AC}55; border-radius: 6px; background: ${AC}14; }
.bzsa-block[data-muted="1"] { opacity: .4; }
.bzsa-block[data-empty="1"] { border-style: dashed; background: transparent; cursor: default; }
.bzsa-block canvas { width: 100%; height: 100%; display: block; }
/* 轨头 26px 列里上下叠两个按钮：喇叭（上）· 编辑（下）。列宽不动，
   波形起点仍在 26px，与上方视频段块对齐。 */
.bzsa-mute { position: absolute; left: 3px; top: 3px; z-index: 3; width: 20px; height: 15px; line-height: 15px; }
.bzsa-edit { position: absolute; left: 3px; top: 21px; z-index: 3; width: 20px; height: 15px;
  padding: 0; border: none; border-radius: 5px; background: transparent; color: #e6e6ea;
  font-size: 11px; line-height: 15px; cursor: pointer; }
.bzsa-edit:hover { background: #ffffff14; }
.bzsa-edit[data-on="1"] { background: ${AC}2e; color: ${AC}; }
/* 编辑态：整块可拖、左右把手可裁。canvas 不吃事件，否则按住波形拖不动。 */
.bzsa-row[data-edit="1"] .bzsa-block { cursor: grab; }
.bzsa-row[data-edit="1"] .bzsa-block:active { cursor: grabbing; }
.bzsa-row[data-edit="1"] .bzsa-block canvas { pointer-events: none; }
.bzsa-h { position: absolute; top: 0; width: 7px; height: 100%; z-index: 6;
  cursor: ew-resize; display: none; background: ${AC}; opacity: .55; border-radius: 3px; }
.bzsa-h[data-h="l"] { left: -1px; }
.bzsa-h[data-h="r"] { right: -1px; }
.bzsa-row[data-edit="1"] .bzsa-h { display: block; }
/* 滑动剪辑读数：编辑态下显示当前源入点，拖动时每帧跟着变（不挡鼠标）。 */
.bzsa-si { display: none; position: absolute; left: 10px; top: 1px; z-index: 5;
  pointer-events: none; font: 10px/14px monospace; color: #e6e6ea;
  background: #101014b8; border-radius: 3px; padding: 0 4px; }
.bzsa-row[data-edit="1"] .bzsa-block[data-slip="1"] .bzsa-si { display: block; }
.bzsa-x { position: absolute; top: 3px; z-index: 3; }
.bzsa-x { right: 4px; opacity: .55; }
.bzsa-row:hover .bzsa-x { opacity: 1; }
/* 试听按钮浮在轨右上、删除钮左边。不占列宽、不改行高、也不碰音频块 ——
   点块只进编辑模式，静音由轨头 🔊 管，试听只走这两个按钮。 */
.bzsa-play, .bzsa-playseg { position: absolute; top: 3px; z-index: 3;
  height: 15px; padding: 0 5px; box-sizing: border-box; font-size: 10px; line-height: 13px;
  border: 1px solid #e6e6ea33; border-radius: 5px; background: #000000a8;
  color: #e6e6ea; cursor: pointer; opacity: .75; }
.bzsa-play { right: 66px; }
.bzsa-playseg { right: 28px; }
.bzsa-play:hover, .bzsa-playseg:hover { opacity: 1; background: #ffffff14; }
.bzsa-play[data-on="1"], .bzsa-playseg[data-on="1"] { color: ${AC}; border-color: ${AC}55; opacity: 1; }
.bzsa-tip { position: absolute; left: 0; right: 0; top: 0; z-index: 9; display: flex; align-items: center;
  gap: 8px; font-size: 11px; line-height: 18px; padding: 4px 8px; border-radius: 6px;
  background: #000000cc; border: 1px solid #e6e6ea33; color: #e6e6ea; pointer-events: none; }
.bzsa-tip button { pointer-events: auto; margin-left: auto; font-size: 11px; padding: 2px 8px; cursor: pointer;
  color: ${AC}; background: ${AC}14; border: 1px solid ${AC}55; border-radius: 6px; }
/* 选中轨：整行高亮，✂ 只认这一条。再点同一行 = 取消选中。 */
.bzsa-row { cursor: pointer; }
.bzsa-row[data-sel="1"] { background: ${AC}1f; box-shadow: inset 0 0 0 1px ${AC}aa; }
/* 片段层：切点竖线 + 静音区斜纹。非编辑态不吃事件，点块仍进编辑模式。 */
.bzsa-cuts { position: absolute; inset: 0; z-index: 2; pointer-events: none; }
.bzsa-segpart { position: absolute; top: 0; bottom: 0; pointer-events: none; }
.bzsa-row[data-edit="1"] .bzsa-segpart { pointer-events: auto; cursor: pointer; }
.bzsa-row[data-edit="1"] .bzsa-segpart:hover { background: #ffffff12; }
.bzsa-row[data-edit="1"] .bzsa-segpart.dead:hover { background: #000000c0; }
.bzsa-segpart.dead { background: repeating-linear-gradient(45deg,
  #000000b0, #000000b0 4px, #ffffff1c 4px, #ffffff1c 8px); }
.bzsa-segpart.dead::after { content: "静音"; position: absolute; left: 0; right: 0; top: 8px;
  text-align: center; font-size: 10px; color: #ffffffaa; pointer-events: none; }
.bzsa-cut { position: absolute; top: 0; bottom: 0; width: 2px; background: #e6e6ea;
  pointer-events: none; }
/* 20261109 曾定「音轨行上不留常驻文字」把作用范围徽章一起藏了；20261112 用户
   要恢复它（Q3①）：轨头左侧的小徽章是「这条轨管全片还是管哪一段」的唯一可见
   出口，点一下循环切换。滑动读数 si 与空轨提示 hint 仍不常驻。 */
.bzsa-si, .bzsa-hint { display: none !important; }
.bzsa-segpart.dead::after { content: none; }
`;
  document.head.appendChild(s);
}

export function mountAudioLane(opts = {}) {
  const wave = opts.wave;
  if (!wave) return null;
  /* 坐标只认时间轴那一套像素（xOfFrame / wOfFrames）：音频块与上方段块共用
     同一把尺子，缩放、滚动、加减段之后都还贴边。 */
  if (typeof opts.pxOf !== "function" || typeof opts.wOf !== "function") {
    throw new Error("时间轴没把像素坐标交给音频轴（请刷新页面再试）");
  }
  if (wave.__bzsa) return wave.__bzsa;
  injectCss();

  /* 「每段 N 秒」独立框已撤（20261112 用户定·方案 B 合并）：切段秒数改由导演台
     设置面板「时长」在有主音轨时驱动（setSegSec → replan）。这里只留 segSec 真值
     与切段逻辑，不再往上下文条塞输入框，opts.segHost 也不再需要。 */
  const box = document.createElement("div");
  box.className = "bzsa";
  const tracksEl = document.createElement("div");
  tracksEl.className = "bzsa-tracks";
  box.appendChild(tracksEl);
  wave.after(box);

  let segSec = Math.max(1, Number(localStorage.getItem(LS_SEG)) || 10);
  let tracks = [];   // [{ id, el, lane, strip, name, rel, dur, sr, scope, blocks, placeholder }]
  let nextTrackId = 1;
  /* 全时间轴同时只有一条选中轨：✂ 只切它。判定精确到 track id，不用
     「是否在编辑态」这类粗粒度状态（AGENTS.md 高频事实）。 */
  let selectedTrackId = 0;
  let selectCb = null;
  /* 本次要重切的段：后端只重切这些段，不把 18 段全解码一遍。 */
  const pendingChanged = new Set();
  /* 数据换代标记：全部渲染时段 id / 边界频繁变化，旧的异步切片结果回来后
     必须丢弃，否则按旧坐标再画一块，叠在新块上就是「音频轨错位」。 */
  let generation = 0;
  let film = null;
  let subName = "";
  /* 音轨恢复的唯一在途标记：片名抖动 / 刷新 / 切工程同时触发时不并发重建。 */
  let restoreInflight = "";
  let unsub = null;
  /* 当前这批轨属于哪个工程。整包灌入与片名轮询先后不固定，靠它避免
     轮询晚到一步把刚灌好的波形清掉。 */
  let tracksOwner = "";
  let tipTimer = 0;
  let busy = false;      // 我们自己改档案时，别让订阅回调再切一遍
  let syncTimer = 0;

  /* hold=true：不自动消失。切一首 3 分钟的歌要十几秒，进度提示必须挂住，
     否则用户看到的是一片死寂 + 3.2 秒后连"正在切"都没了。 */
  function tip(text, bad, act, hold) {
    const old = box.querySelector(".bzsa-tip");
    if (old) old.remove();
    clearTimeout(tipTimer);
    /* 20261109 用户定：音轨上不留普通文字提示（挡视线）。错误 bad / 带动作
       act / 进度 hold 仍要显示，否则出错无反馈、长时间重切像卡死。先清掉
       上一条再返回，进度提示才有机会退场。 */
    if (!bad && !act && !hold) return;
    const el = document.createElement("div");
    el.className = "bzsa-tip";
    el.textContent = text;
    if (bad) el.style.borderColor = "#e6e6ea";
    if (act) {
      const b = document.createElement("button");
      b.textContent = act.label;
      b.addEventListener("click", async () => {
        b.disabled = true;
        try { await act.run(); el.remove(); }
        catch (e) { el.remove(); tip(String((e && e.message) || e), true); }
      });
      el.appendChild(b);
      box.appendChild(el);
    } else {
      box.appendChild(el);
      if (!hold) tipTimer = setTimeout(() => el.remove(), 3200);
    }
  }

  const nameOf = () => (opts.getName && opts.getName()) || "";
  const clipsOf = () => (film && film.clips) || [];
  const fpsOf = () => Number(film && film.fps) || 24;
  const covers = (t, r) => t.placeholder || t.scope === "all" || t.scope.has(segKey(r));
  const muteOf = (t, k) => `${t.id}::${k}`;
  const hasReal = () => tracks.some((t) => !t.placeholder);

  /* 音频模式（有无主音轨）翻转时通知宿主重渲染设置面板「时长」——它在「逐段
     时长」与「每段秒数·全片」两种语义间切换（20261112 方案 B）。只在真的翻转时
     通知：1.5s 轮询也会调到这里，不能每次都触发重渲染。 */
  let lastAudioMode = false;
  function syncMeta() {
    const m = hasReal();
    if (m === lastAudioMode) return;
    lastAudioMode = m;
    if (typeof opts.onAudioModeChange === "function") opts.onAudioModeChange(m);
  }

  /* 没有音频也留一条空轨：轨头把左侧 88px 列占住，按段占位格与上方视频段
     一一对齐。这样「视频轨下面的音频轨」永远在，不会只剩一句提示。 */
  function ensurePlaceholder() {
    if (tracks.length) return;
    tracksEl.style.display = "flex";
    newTrack(null, "音频 1", 0, 0, "all", true);
  }
  function syncEmpty() { ensurePlaceholder(); }

  async function askJson(url, body) {
    const r = await api.fetchApi(url, body
      ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
      : undefined);
    let j = {};
    try { j = await r.json(); } catch (_) { j = {}; }
    const err = j["错误"] || j.error;
    if (err) throw new Error(String(err));
    if (!r.ok) throw new Error("接口返回异常（" + r.status + "）");
    return j;
  }

  const loadFilm = async () => {
    const name = nameOf();
    if (!name) return null;
    film = await askJson("/cglide/chain/film_summary?name=" + encodeURIComponent(name));
    syncMeta();
    return film;
  };

  async function upload(file) {
    const fd = new FormData();
    fd.append("image", file, file.name);
    fd.append("type", "input");
    const r = await api.fetchApi("/upload/image", { method: "POST", body: fd });
    if (!r.ok) throw new Error("上传失败，可能是文件太大或格式不支持");
    const j = await r.json();
    return j.subfolder ? `${j.subfolder}/${j.name}` : j.name;
  }

  const cutOf = (rel, start, end) => askJson("/banzhang/audio/cut", { file: rel, start, end });

  /* 拖进来的音频落在 input 侧，用 ComfyUI 的 /view 直接给 <audio> 当源。 */
  function audioUrl(rel) {
    const s = String(rel || ""), i = s.lastIndexOf("/");
    const filename = i >= 0 ? s.slice(i + 1) : s;
    const subfolder = i >= 0 ? s.slice(0, i) : "";
    return `/view?filename=${encodeURIComponent(filename)}`
      + `&subfolder=${encodeURIComponent(subfolder)}&type=input`;
  }
  /* 每条轨的声源只由 t.rel 决定。以前见 t.audio 已存在就直接 return —— 复用
     占位轨 / 切工程时 rel 换了、src 却还挂着上一条轨的文件，表现就是
     「点第 2 轨试听，出来的是第 1 轨的声音」。现在 src 与 rel 强绑定。 */
  function attachAudio(t) {
    if (!t.rel) return;
    if (!t.audio) {
      const a = document.createElement("audio");
      a.preload = "auto";
      a.style.display = "none";
      /* 本段试听靠 timeupdate 收口：到段尾自己停，不侵入音频块的任何手势。 */
      a.addEventListener("timeupdate", () => {
        if (previewMode === "seg" && previewTrackRef === t
            && previewEnd > 0 && a.currentTime >= previewEnd - 0.03) stopAudio();
      });
      a.addEventListener("ended", () => {
        if (previewTrackRef !== t) return;
        /* 整轨试听：一段放完接下一段，不必再让 ffmpeg 拼一条整轨 wav。 */
        if (previewIdx < previewQueue.length - 1) {
          previewIdx += 1;
          const rel = previewQueue[previewIdx];
          if (rel) {
            a.setAttribute("src", audioUrl(rel));
            try { a.load(); } catch (_) {}
            const p = a.play();
            if (p && p.catch) p.catch(() => stopAudio());
            return;
          }
        }
        stopAudio();
      });
      box.appendChild(a);
      t.audio = a;
    }
    const want = audioUrl(t.rel);
    if (t.audio.getAttribute("src") !== want) {
      t.audio.setAttribute("src", want);
      try { t.audio.load(); } catch (_) {}
    }
  }
  function detachAudio(t) {
    if (!t.audio) return;
    try { t.audio.pause(); } catch (_) {}
    t.audio.remove();
    t.audio = null;
  }



  /* 画波形。a/b 是**源区间的比例**（0..1）：裁剪过的块只画 [a,b) 那一段，
     块变窄时波形是被"裁掉"，而不是把整段挤压成缩放（20261107 用户报）。 */
  /* 绘制尺寸只认 placeBlock 记下的 pxW/pxH（几何真值），不读 cv.clientWidth。
     后者是布局的异步投影：块还没上屏、时间轴尺子还没起、刷新恢复中它都是 0，
     旧版遇 0 静默 return，再靠 rAF / 观察器「猜时机」补画，异步链路一错位就
     永久空白。20261108 第二次根修：绘制绑在「重摆」上，谁改尺寸谁负责重画。 */
  function paint(cv, peaks, a = 0, b = 1, pxW = 0, pxH = 0) {
    if (!(pxW > 0 && pxH > 0)) return;
    const dpr = window.devicePixelRatio || 1;
    const W = Math.max(1, Math.round(pxW * dpr));
    const H = Math.max(1, Math.round(pxH * dpr));
    if (cv.width !== W) cv.width = W;
    if (cv.height !== H) cv.height = H;
    const g = cv.getContext("2d");
    g.clearRect(0, 0, cv.width, cv.height);
    if (!peaks || !peaks.length) return;
    g.fillStyle = AC + "b3";
    const mid = cv.height / 2;
    const n0 = peaks.length;
    const i0 = Math.max(0, Math.min(n0 - 1, Math.floor(a * n0)));
    const i1 = Math.max(i0 + 1, Math.min(n0, Math.ceil(b * n0)));
    const n = i1 - i0;
    const bw = Math.max(1, Math.round(cv.width / n));
    for (let i = i0; i < i1; i++) {
      const x = Math.round((i - i0) * cv.width / n);
      const bh = Math.max(1, Math.round(peaks[i] * cv.height * 0.92));
      g.fillRect(x, mid - bh / 2, bw, bh);
    }
  }

  /* 波形按**时间轴尺子**画：peaks 覆盖源区间 [pf,pt]，每个峰的像素位置由
     它在整段里的帧位决定，块只是窗口。以前把选中的 peaks 段铺满块宽，块一窄
     波形就被压缩成「缩放」；现在拖左右把手只是窗口变窄/左移，被裁掉的那截
     自然落到窗口外，剩下的波形密度不变 —— 这才是裁剪。
     滑动剪辑（slip）例外：源入点在整轨上滑，本段切片 peaks 覆盖不到新位置，
     仍走整轨峰值按整条音频比例画。 */
  function paintRuler(cv, peaks, pf, pt, srcFrom, pxW, pxH) {
    const dpr = window.devicePixelRatio || 1;
    const W = Math.max(1, Math.round(pxW * dpr));
    const H = Math.max(1, Math.round(pxH * dpr));
    if (cv.width !== W) cv.width = W;
    if (cv.height !== H) cv.height = H;
    const g = cv.getContext("2d");
    g.clearRect(0, 0, cv.width, cv.height);
    if (!peaks || !peaks.length) return;
    g.fillStyle = AC + "b3";
    const mid = cv.height / 2;
    const n0 = peaks.length;
    const span = Math.max(1, pt - pf);
    const ppf = opts.wOf(1) * dpr;
    const bw = Math.max(1, Math.round(ppf * span / n0));
    for (let i = 0; i < n0; i++) {
      const frame = pf + (i + 0.5) * span / n0;
      const x = Math.round((frame - srcFrom) * ppf);
      if (x < -bw || x > cv.width) continue;
      const bh = Math.max(1, Math.round(peaks[i] * cv.height * 0.92));
      g.fillRect(x, mid - bh / 2, bw, bh);
    }
  }
  function paintBlock(b) {
    const tr = b.trackRef;
    if (b.slip && tr && tr.fullPeaks && tr.fullPeaks.length) {
      const n = Math.max(1, Number(tr.fullFrames) || 1);
      paint(b.cv, tr.fullPeaks,
            Math.max(0, Math.min(1, Number(b.srcFrom) / n)),
            Math.max(0, Math.min(1, Number(b.srcTo) / n)), b.pxW, b.pxH);
      return;
    }
    paintRuler(b.cv, b.peaks, Number(b.pf), Number(b.pt),
               Number(b.srcFrom), b.pxW, b.pxH);
  }

  /* 行宽也只认时间轴那把尺子（20261108 根修）。
     CSS 的 width: calc(100% + GUTTER) 是「容器百分比」，而音频块用
     opts.pxOf / opts.wOf 是「帧×ppf」。两套坐标系一旦不等长（fit 被吸附
     缩窄、容器 min-width 撑开、refit 尚未落地），行就会比波形长出一截，
     右端那条空白带正好把 × / 试听 / 本段 按钮兜进去 —— 用户报的「拖进音频
     后最右侧空出一块」。现在每行宽度 = 内容轨真实宽 + 轨头列，波形铺到哪、
     行和按钮就到哪，永远不会多出一条空白。 */
  function syncRowWidth() {
    /* 右端取「最后一块波形的 clip_to」，与 addBlock()/placeBlock() 读的是同一份
       film.clips —— 不用 film.total_frames，免得两份帧账快照有时序差时行与波形
       又一次对不齐。 */
    let last = 0;
    for (const r of clipsOf()) last = Math.max(last, Number(r && r.clip_to) || 0);
    /* 挂载时序：本模块比 film.js 的 tEngine 先建。那边 wOfFrames 已改成
       「引擎未就绪返回 0」，所以这里拿到 0 就是尺子还没起，走 CSS 兜底即可。 */
    const w = last > 1 ? Math.max(1, opts.wOf(last)) : 0;
    for (const t of tracks) {
      /* 尺子还没建好（ppf=0 / 没工程）时退回 CSS 的 100% 兜底，别把行压没。 */
      t.el.style.width = w > GUTTER ? (w + GUTTER) + "px" : "";
    }
  }

  /* 波形重摆 + 重画的唯一入口。placeBlock 既写坐标又画波形：刷新恢复、
     切工程、时间轴缩放、尺子就绪，任何一次走这里都按当前尺子摆正并当场画出来。
     旧版只调 paintBlock（读 DOM 尺寸）再叠加双 rAF / 容器观察器补画，
     异步链路一长就全落空（20261108 第二次根修）。 */
  function renderBlocks() {
    syncRowWidth();
    for (const t of tracks) for (const b of t.blocks.values()) placeBlock(b);
  }

  function resetSelection() {
    if (!selectedTrackId) return;
    selectedTrackId = 0;
    if (typeof selectCb === "function") {
      try { selectCb(false); } catch (_) {}
    }
  }
  function removeTrack(t) {
    const i = tracks.indexOf(t);
    if (i < 0) return;
    generation += 1;
    stopAudio();
    detachAudio(t);
    t.el.remove();
    tracks.splice(i, 1);
    if (selectedTrackId === t.id) resetSelection();
    syncEmpty();
    syncMeta();   /* 删到没主音轨 → 设置面板「时长」切回逐段语义 */
    /* 删轨必须落库：以前只清前端，后端 bzsa.tracks / driver 还是删之前的，
       全部渲染照样把删掉的音频生成出来。把剩余轨清单交给 auto_slice 一次
       事务重写档案并重切驱动；删光时后端连 driver / layout 一起清空。 */
    const name = nameOf();
    if (name) {
      const files = tracks.filter((x) => !x.placeholder && x.rel).map((x) => x.rel);
      void askJson("/banzhang/audio/auto_slice", { name, files }).catch(() => {});
    }
  }
  function clearTracks() {
    generation += 1;
    for (const t of tracks) { detachAudio(t); t.el.remove(); }
    tracks = [];
    resetSelection();
    syncEmpty();
    syncMeta();
  }

  /* ---- 静音：只由轨头 🔊 管，点段块不再静音 ----
     **不落 localStorage**（20261107）：记住了就会出现「刷新后整条轨一直
     置灰」—— 用户根本没点过静音，只是上一次会话的残留。
     20261111 方案 B：静音改为落**工程档案** bzsa.tracks[i]['静音']，
     reslice_drivers 混音时跳过该轨，新渲染的成片里就真的没有它。
     跨会话记忆只认档案：loadMuted 仍恒为空，刷新后由 hydrateTracks 从
     后端「静音」还原，绝不会「没点过却置灰」。 */
  const loadMuted = () => new Set();
  let muted = loadMuted();
  let muteTimer = 0;
  let muteSeq = 0;
  const saveMuted = () => {
    clearTimeout(muteTimer);
    const name = nameOf();
    if (!name) return;
    const seq = ++muteSeq;
    /* 连点轨头只发最后一次：每次都全量重切会把界面拖住。 */
    muteTimer = setTimeout(async () => {
      const real = tracks.filter((t) => !t.placeholder && t.rel);
      const payload = real.map((t) => {
        const keys = [...t.blocks.keys()];
        const on = keys.filter((k) => muted.has(muteOf(t, k))).map(String);
        if (keys.length && on.length === keys.length) return true;
        return on;
      });
      try {
        const j = await askJson("/banzhang/audio/mute", { name, muted: payload });
        if (seq !== muteSeq || nameOf() !== name) return;
        if (!j["未变化"]) {
          console.log("[audio-lane] 轨静音已写进档案并重切：",
            j["静音轨数"], "条轨 /", j["重切段数"], "段 · 已生成的成片要重跑才生效");
        }
      } catch (e) {
        if (seq !== muteSeq) return;
        tip("轨静音没能写进成片：" + String((e && e.message) || e), true);
      }
    }, 320);
  };
  function paintMute(t) {
    if (t.placeholder) { t.el.dataset.muted = "0"; return; }
    let on = 0, all = 0;
    for (const [k, b] of t.blocks) {
      all += 1;
      const m = muted.has(muteOf(t, k));
      if (m) on += 1;
      b.el.dataset.muted = m ? "1" : "0";
    }
    t.el.dataset.muted = (all && on === all) ? "1" : "0";
    const btn = t.el.querySelector(".bzsa-mute");
    btn.textContent = !on ? "🔊" : (on === all ? "🔇" : "🔉");
    btn.dataset.state = !on ? "off" : (on === all ? "all" : "some");
    /* 文案要说清代价：这是成片静音，不是只关试听。 */
    const muteHint = "（写进成片；已生成的段要重跑才生效）";
    btn.title = (!on ? "整条轨静音：点一下把这一行所有段都静音"
      : (on === all ? "整条轨已静音：点一下全部恢复"
        : `这一行有 ${on}/${all} 段静音：点一下全部静音`)) + muteHint;
    /* 轨头静音现在真的切掉这条轨的声音，不再只改显示。 */
    if (t.audio) t.audio.muted = (t.el.dataset.muted === "1");
  }
  /* 行头 = 整行一个动作：全静音就全恢复，否则全部静音。 */
  function toggleAllMute(t) {
    if (t.placeholder) return;
    const keys = [...t.blocks.keys()];
    if (!keys.length) return;
    const allOn = keys.every((k) => muted.has(muteOf(t, k)));
    keys.forEach((k) => { if (allOn) muted.delete(muteOf(t, k)); else muted.add(muteOf(t, k)); });
    saveMuted();
    paintMute(t);
  }

  /* 20261111 方案 B：刷新 / 切工程后从档案还原静音。
     必须等 refreshBlocks 建齐 t.blocks 再跑，否则遍历到的是空 Map，
     F5 之后整条轨就悄悄「不静音」了。 */
  function applyMuteSeeds() {
    for (const t of tracks) {
      if (t.muteSeed === undefined) continue;
      const seed = t.muteSeed;
      delete t.muteSeed;
      if (!seed) continue;
      const set = Array.isArray(seed) ? new Set(seed.map(String)) : null;
      for (const k of t.blocks.keys()) {
        if (set ? set.has(String(k)) : true) muted.add(muteOf(t, k));
      }
      paintMute(t);
    }
  }

  function scopeLabel(t) {
    if (t.placeholder) return "未导入";
    if (t.scope === "all") return "全片";
    const rows = clipsOf();
    const keys = [...t.scope];
    if (keys.length === 1) {
      const r = rows.find((x) => segKey(x) === keys[0]);
      return r ? `第${r.index}段` : "指定段";
    }
    return `${keys.length}段`;
  }
  function paintScope(t) {
    const b = t.el.querySelector(".bzsa-scope");
    b.textContent = scopeLabel(t);
    b.title = t.placeholder ? "拖入音频后这条轨才有内容"
      : `作用范围：${scopeLabel(t)}（点一下切到下一段，轮完回到全片）`;
  }
  /* 循环切换而不是弹窗：点一次给一次可见反馈，不打断时间轴操作。 */
  function cycleScope(t) {
    if (t.placeholder) return;
    const rows = clipsOf();
    if (!rows.length) return;
    const i = rows.findIndex((r) => t.scope !== "all" && t.scope.has(segKey(r)));
    if (t.scope === "all") t.scope = new Set([segKey(rows[0])]);
    else if (i < 0 || i >= rows.length - 1) t.scope = "all";
    else t.scope = new Set([segKey(rows[i + 1])]);
    paintScope(t);
    void refreshBlocks(true);
  }

  function newTrack(rel, fname, dur, sr, scope, placeholder = false) {
    const el = document.createElement("div");
    el.className = "bzsa-row";
    el.innerHTML =
      `<div class="bzsa-left">` +
      `<span class="bzsa-ico">🎵</span><span class="bzsa-name">音频</span>` +
      `<button class="bzsa-scope" title="作用范围"></button></div>` +
      `<div class="bzsa-lane"><div class="bzsa-strip"></div>` +
      (placeholder ? `<div class="bzsa-hint">${HINT_TEXT}</div>` : "") +
      `</div>` +
      `<button class="bzsa-mute" data-state="off" title="整条轨静音">🔊</button>` +
      `<button class="bzsa-edit" data-on="0" title="编辑这条音频：拖动位置 / 左右裁剪（不超出视频范围）">✥</button>` +
      `<button class="bzsa-play" data-on="0" title="试听整条音频（再点一次停止）">试听</button>` +
      `<button class="bzsa-playseg" data-on="0" title="试听当前选中段的音频（再点一次停止）">本段</button>` +
      `<button class="bzsa-x" title="删除这条轨">✕</button>`;
    const t = { id: nextTrackId++, el, lane: el.querySelector(".bzsa-lane"),
      strip: el.querySelector(".bzsa-strip"), name: fname, rel, dur, sr,
      scope: scope === "all" || !scope ? "all" : new Set([...scope]),
      blocks: new Map(), placeholder,
      editing: false, layout: new Map(), edited: false };
    el.querySelector(".bzsa-name").textContent = fname;
    el.querySelector(".bzsa-left").title = placeholder
      ? "把音频拖到这里建立第一条音轨"
      : `${fname}（点这一行 = 选中这条轨，✂ 只裁它）`;
    el.querySelector(".bzsa-name").title = fname;
    el.dataset.sel = "0";
    if (placeholder) {
      for (const b of el.querySelectorAll(".bzsa-mute, .bzsa-x, .bzsa-scope, .bzsa-play, .bzsa-playseg")) b.style.display = "none";
    }
    /* 不在这里重置 muted：新建第二/第三条轨会把用户刚点的静音一起清掉。
       静音只在切工程（ensureSub）时归零。 */
    paintScope(t);
    /* 点轨道行空白 = 选中/取消选中。按钮与波形块各自保留原语义，
       静音只走轨头 🔊 —— 轨头名字区不再兼任静音开关。 */
    el.addEventListener("click", (e) => {
      if (e.target.closest("button") || e.target.closest(".bzsa-block")) return;
      selectTrack(t);
    });
    el.querySelector(".bzsa-mute").addEventListener("click", (e) => {
      e.stopPropagation();
      toggleAllMute(t);
    });
    el.querySelector(".bzsa-edit").addEventListener("click", (e) => {
      e.stopPropagation();
      toggleEdit(t);
    });
    el.querySelector(".bzsa-scope").addEventListener("click", (e) => {
      e.stopPropagation();
      cycleScope(t);
    });
    el.querySelector(".bzsa-x").addEventListener("click", (e) => {
      e.stopPropagation();
      removeTrack(t);
    });
    /* 试听只走按钮，绝不挂到音频块上：块要留给静音 / 拖动 / 裁剪。 */
    el.querySelector(".bzsa-play").addEventListener("click", (e) => {
      e.stopPropagation();
      startPreview(t, "track");
    });
    el.querySelector(".bzsa-playseg").addEventListener("click", (e) => {
      e.stopPropagation();
      startPreview(t, "seg");
    });
    /* 音轨行的 pointerdown 不能冒泡到时间轴：el.band 会当成搓播放头，
       点「试听 / 本段」时红色指针就跳到点击位置。行内拖动自己消化。 */
    el.addEventListener("pointerdown", (e) => e.stopPropagation());
    tracksEl.appendChild(el);
    tracks.push(t);
    syncRowWidth();
    if (!placeholder) attachAudio(t);
    return t;
  }

  /* 第一首音频直接填进常驻的那条空轨，不另起一行 —— 轨道位置不跳，
     上方视频段与下方音频段的对应关系也不中断。 */
  function attachFirstTrack(rel, fname, dur, sr) {
    const ph = tracks.find((t) => t.placeholder);
    if (!ph) return newTrack(rel, fname, dur, sr, "all");
    ph.placeholder = false;
    ph.rel = rel; ph.name = fname; ph.dur = dur; ph.sr = sr; ph.scope = "all";
    ph.el.querySelector(".bzsa-name").textContent = fname;
    ph.el.querySelector(".bzsa-name").title = fname;
    ph.el.querySelector(".bzsa-left").title = `${fname}（点这一行 = 整行所有段一起静音 / 取消）`;
    const hint = ph.el.querySelector(".bzsa-hint");
    if (hint) hint.remove();
    for (const b of ph.el.querySelectorAll(".bzsa-mute, .bzsa-x, .bzsa-scope, .bzsa-play, .bzsa-playseg")) b.style.display = "";
    for (const b of ph.blocks.values()) { b.ph = false; b.el.dataset.empty = "0"; placeBlock(b); }
    paintScope(ph);
    attachAudio(ph);
    syncMeta();   /* 第一条真轨 → 设置面板「时长」切成「每段秒数·全片」 */
    return ph;
  }

  /* 编辑模式：整块拖动 = 平移（源入点不变）；左右把手 = 裁剪（源入点跟着走）。

     ⚠ 限位单位是**这一段视频**，不是全片（20261107 用户报「能拖到第二段范围」）：
     第 3 段的音频块只许待在第 3 段的 [clip_from, clip_to] 里，拖出去的部分
     自动在左右缩进去（交集裁剪），再拖回来能原样恢复。旧实现拿全片总长当
     上界，于是块能一路滑进隔壁段。 */
  const pxPerFrame = () => {
    try { return Math.abs(opts.pxOf(1) - opts.pxOf(0)) || 1; } catch (_) { return 1; }
  };
  /* 把块的显示区间硬夹回它自己那一段。源区间按被裁掉的左右量同步收窄，
     保持「显示 1 帧 = 源 1 帧」的 1:1 关系，波形换算才不会错位。
     用于：刷新还原旧布局、段长/续接改了之后重新对界。 */
  function clampBlockToSeg(b) {
    const lo = Math.max(0, Number(b.segFrom) || 0);
    const hi = Math.max(lo + 1, Number(b.segTo) || lo + 1);
    let from = Math.max(Number(b.from) || 0, lo);
    let to = Math.min(Number(b.to) || from + 1, hi);
    if (to - from < 1) { from = lo; to = hi; }   // 整个跑出段外：贴回整段
    const dl = from - (Number(b.from) || 0), dr = (Number(b.to) || 0) - to;
    b.from = from; b.to = to;
    b.srcFrom = Math.max(0, (Number(b.srcFrom) || 0) + dl);
    b.srcTo = Math.max(b.srcFrom + 1, (Number(b.srcTo) || 0) - dr);
  }
  function toggleEdit(t) {
    if (t.placeholder) return;
    t.editing = !t.editing;
    t.el.dataset.edit = t.editing ? "1" : "0";
    const btn = t.el.querySelector(".bzsa-edit");
    btn.dataset.on = t.editing ? "1" : "0";
    btn.title = t.editing
      ? "退出编辑（拖动整块 = 移动，拖左右边缘 = 裁剪）"
      : "编辑这条音频：拖动位置 / 左右裁剪（不超出视频范围）";
    if (t.editing) {
      tip("编辑模式：满段块拖动 = 滑音频内容（块不动、入点滑）；裁短过的块 = 段内移动；左右把手 = 裁剪");
    } else {
      saveLayout();
    }
  }
  /* 布局落库：轨序号 → 段键 → {f,t,sf,st,sl,cuts,del}。
     cuts = 段内切点（连播帧），del = 静音片段的起点帧。两者与 f/t/sf/st
     是同一份真值，后端按它合成驱动；只存真动过的块。 */
  function saveLayout() {
    const name = nameOf();
    if (!name) return;
    const changed = [...pendingChanged];
    pendingChanged.clear();
    const real = tracks.filter((x) => !x.placeholder);
    const layout = {};
    real.forEach((t, i) => {
      const o = {};
      for (const [k, b] of t.blocks) {
        const cuts = b.cuts || [], dead = b.dead || [];
        if (!b.manual && !cuts.length && !dead.length) continue;
        o[k] = { f: Math.round(b.from), t: Math.round(b.to),
                 sf: Math.round(b.srcFrom), st: Math.round(b.srcTo),
                 sl: b.slip ? 1 : 0,
                 cuts: cuts.slice(), del: dead.slice() };
      }
      if (Object.keys(o).length) layout[String(i + 1)] = o;
    });
    api.fetchApi("/banzhang/audio/layout", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, layout, changed }),
    }).catch(() => {});
  }

  /* ---- 选中轨 / 片段分割（20261109） ---- */
  function selectedTrack() {
    return tracks.find((t) => t.id === selectedTrackId && !t.placeholder) || null;
  }
  function selectTrack(t) {
    if (t.placeholder) return;
    selectedTrackId = selectedTrackId === t.id ? 0 : t.id;
    for (const x of tracks) x.el.dataset.sel = (x.id === selectedTrackId) ? "1" : "0";
    if (typeof selectCb === "function") {
      try { selectCb(!!selectedTrackId); } catch (_) {}
    }
  }
  function markChanged(k) { if (k) pendingChanged.add(String(k)); }

  /* 片段层：切点竖线 + 静音区斜纹。用片段起点帧做删除标记，插新刀时
     不会像序号那样整体漂移。非编辑态不吃事件，点块仍是「进编辑模式」。 */
  function paintCuts(b) {
    const host = b.cutEl;
    if (!host) return;
    host.textContent = "";
    const f = Math.round(b.from), z = Math.round(b.to);
    const pts = [f, ...(b.cuts || []), z];
    const dead = b.dead || [];
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], e = pts[i + 1];
      const p = document.createElement("div");
      p.className = "bzsa-segpart" + (dead.includes(a) ? " dead" : "");
      p.dataset.start = String(a);
      /* 最左/最右片段各让出 12px 给把手：把手区不能被片段层盖住，
         否则 pointerdown 落到片段上，拖侧边会变成「拖整块 = 滑内容」。
         12px 与 addBlock 里 EDGE 的边缘命中区同宽。 */
      const padL = i === 0 ? 12 : 0;
      const padR = i === pts.length - 2 ? 12 : 0;
      p.style.left = (opts.pxOf(a) - opts.pxOf(f) + padL) + "px";
      p.style.width = Math.max(1, opts.wOf(Math.max(1, e - a)) - padL - padR) + "px";
      /* 片段层同样不留悬停文字；静音与否看斜纹即可。 */
      host.appendChild(p);
      if (i > 0) {
        const c = document.createElement("div");
        c.className = "bzsa-cut";
        c.style.left = (opts.pxOf(a) - opts.pxOf(f)) + "px";
        host.appendChild(c);
      }
    }
  }
  function toggleDead(b, start) {
    const dead = b.dead || (b.dead = []);
    const j = dead.indexOf(start);
    if (j >= 0) dead.splice(j, 1); else dead.push(start);
    markChanged(b.k);
    paintCuts(b);
    saveLayout();
    tip(j >= 0 ? "已恢复这一片段的声音" : "这一片段已静音（画面段长不变，再点恢复）");
  }
  function canCutAt(hit) {
    const t = selectedTrack();
    if (!t || !hit) return false;
    const b = t.blocks.get(String(hit.clipId || ""));
    if (!b) return false;
    const g = Math.round(Number(hit.globalFrame) || 0);
    return g > Math.round(b.from) && g < Math.round(b.to)
      && !(b.cuts || []).includes(g);
  }
  function cutAt(hit) {
    const t = selectedTrack();
    if (!t) return { ok: false, 提示: "先点一下要裁剪的音轨" };
    const b = t.blocks.get(String((hit && hit.clipId) || ""));
    if (!b) return { ok: false, 提示: "选中轨在这一段没有音频块" };
    const g = Math.round(Number(hit.globalFrame) || 0);
    if (!(g > Math.round(b.from) && g < Math.round(b.to)))
      return { ok: false, 提示: "切点要落在音频块内部" };
    const cuts = b.cuts || (b.cuts = []);
    if (cuts.includes(g)) return { ok: false, 提示: "这里已经切过了" };
    cuts.push(g); cuts.sort((a, c) => a - c);
    markChanged(b.k);
    paintCuts(b);
    saveLayout();
    return { ok: true, 提示: `已切开，共 ${cuts.length + 1} 个片段；编辑态点某一片段可静音` };
  }

  /* 滑动剪辑落库：把这一段的这一轨按新源入点重切，重新混出本段驱动片段
     （meta["bzsa.driver"]）—— 送模型的驱动音频真的跟着滑动变，不只是时间轴好看。
     只在松手时调一次；失败就回滚源入点，保证看到的和送出去的一致。 */
  async function reslip(t, b, cid, oldFrom, oldTo) {
    const name = nameOf();
    const fps = fpsOf();
    const trackNo = tracks.filter((x) => !x.placeholder).indexOf(t) + 1;
    if (!name || trackNo < 1 || !t.rel) {
      tip("重切失败：工程名或音轨文件缺失", true);
      return;
    }
    tip(`第 ${b.no} 段：正在按新入点重切驱动音频…`, false, null, true);
    try {
      const j = await askJson("/banzhang/audio/slip", {
        name, cid, track: trackNo, file: t.rel,
        start: Number(b.srcFrom) / fps, end: Number(b.srcTo) / fps,
      });
      /* 本段缓存的峰值/文件跟着换，重建块时才不会画回旧波形。
         「文件」要留本轨切片，不能填驱动混音产物 —— 多轨时那是整段的合流。 */
      if (t.slices && t.slices.has(cid)) {
        const s = t.slices.get(cid);
        s["峰值"] = (j && j["峰值"]) || s["峰值"];
        s["文件"] = (j && j["切片文件"]) || (j && j["文件"]) || s["文件"];
      }
      tip(`第 ${b.no} 段：源入点 ${(Number(b.srcFrom) / fps).toFixed(2)} 秒`
          + ` → 驱动片段已重切`
          + (Number(j && j["混音"]) ? "并重新混音" : "")
          + "（时间轴音频只驱动，不写媒体架 / 文案台）");
    } catch (err) {
      b.srcFrom = oldFrom; b.srcTo = oldTo;
      t.layout.set(cid, { f: b.from, t: b.to, sf: b.srcFrom, st: b.srcTo, sl: 1,
                          cuts: (b.cuts || []).slice(), del: (b.dead || []).slice() });
      saveLayout();
      paintBlock(b);
      tip(`重切失败，已回滚到原入点：${String((err && err.message) || err)}`, true);
    }
  }

  /* 时间轴像素坐标：块的左右边严格跟上方段块重合，缩放/滚动都跟着变。 */
  function placeBlock(b) {
    /* 不取整：与上方段块的 left/width 用同一份小数像素，边界才真正贴齐。 */
    b.el.style.left = opts.pxOf(b.from) + "px";
    /* 右边留 2px 缝：两段之间看得见分界，又不至于跟上方段块错位。 */
    const w = Math.max(2, opts.wOf(Math.max(1, b.to - b.from)) - 2);
    b.el.style.width = w + "px";
    /* canvas 可见尺寸 = 块 border-box 去掉上下左右各 1px 边框。几何真值，
       不依赖布局：尺子没起、块还没上屏、刷新恢复中照样有值。 */
    b.pxW = Math.max(1, w - 2);
    b.pxH = 30;
    /* 滑过的块在编辑态左上角常驻源入点读数，拖动时每帧跟着变。 */
    b.el.dataset.slip = b.slip ? "1" : "0";
    if (b.siEl) b.siEl.textContent = `↔ ${(Number(b.srcFrom) / fpsOf()).toFixed(2)}s`;
    /* 波形块不留悬停文字：波形本身就是全部信息（20261109 用户定）。 */
    /* 摆完就画，不等下一帧：绘制不再依赖「布局何时落定」。 */
    paintCuts(b);
    paintBlock(b);
  }
  function addBlock(t, r, peaks) {
    /* 同一个段键只允许一个 DOM 块：谁后到谁替换，绝不叠加两层波形。 */
    const k0 = segKey(r);
    const dup = t.blocks.get(k0);
    if (dup) { dup.el.remove(); t.blocks.delete(k0); }
    const el = document.createElement("div");
    el.className = "bzsa-block";
    el.dataset.empty = t.placeholder ? "1" : "0";
    const cv = document.createElement("canvas");
    el.appendChild(cv);
    const si = document.createElement("div");
    si.className = "bzsa-si";
    el.appendChild(si);
    const cutEl = document.createElement("div");
    cutEl.className = "bzsa-cuts";
    el.appendChild(cutEl);
    t.strip.appendChild(el);
    /* 有手动布局就用布局值（刷新/切工程后还原），否则贴住视频段边界。
       srcFrom/srcTo 是「这段音频在源文件里的入点/出点」，拖动时不动、裁剪时跟着走。 */
    const lay = t.layout && t.layout.get(k0);
    const cf = Number(r.clip_from) || 0, ct = Number(r.clip_to) || cf;
    /* 没手动编辑过的块按**源音频实际时长**摆，不铺满整段：以前 from/to
       直接取段边界，2.6 秒音频被画成 10.13 秒。段长仍是帧账；20261111 起
       驱动 wav 也只切到剩余音频实际时长，后端不再补静音凑满设定秒数，
       声音流缺的那截由真静音 latent 填，不会重复本段旋律。 */
    const natTo = Math.max(cf + 1, Math.min(ct,
      cf + Math.max(1, Math.round((Number(t.dur) || 0) * fpsOf()))));
    const b = { el, cv, siEl: si, cutEl, k: k0, peaks, ph: !!t.placeholder,
      from: lay ? lay.f : cf, to: lay ? lay.t : natTo,
      srcFrom: lay ? lay.sf : cf, srcTo: lay ? lay.st : natTo,
      cuts: ((lay && lay.cuts) || []).map(Number).filter(Number.isFinite),
      dead: ((lay && lay.del) || []).map(Number).filter(Number.isFinite),
      /* segFrom/segTo = 本块对应那段**视频**的左右边界，拖动的唯一合法范围。
         段长/续接改了会在 refreshBlocks 里跟着更新。 */
      segFrom: cf, segTo: ct,
      /* pf/pt = 这份 peaks 覆盖的源区间（后端切片时的起止帧）。裁剪后按它
         换算"该画 peaks 的哪一段"，块变窄时波形是被裁掉而不是被压缩。 */
      pf: cf, pt: ct,
      manual: !!lay, no: Number(r.index) || (t.blocks.size + 1),
      /* sl=1 = 这块做过滑动剪辑：块贴段不动、源入点滑过，波形改画整轨峰值，
         松手还要按新入点重切本段驱动片段。trackRef 让 paintBlock 拿到整轨峰值。 */
      slip: !!(lay && lay.sl), trackRef: t };
    /* 从工程库还原的旧布局可能是按「全片限位」拖出来的、会跨段 —— 建块时
       先夹回本段，界面上永远不会出现「第 2 段的音频压在第 3 段上」。 */
    clampBlockToSeg(b);
    b.cuts = b.cuts.filter((x) => x > b.from && x < b.to).sort((a, c) => a - c);
    t.blocks.set(k0, b);
    /* 点段块 = 进编辑模式；静音只由轨头 🔊 管（20261109 用户定）。 */
    el.addEventListener("click", (e) => {
      if (t.placeholder || t.editing) return;
      e.stopPropagation();
      toggleEdit(t);
    });
    /* 编辑态点某一片段 = 静音 / 恢复。非编辑态片段层不吃事件。 */
    cutEl.addEventListener("click", (e) => {
      if (t.placeholder || !t.editing) return;
      const p = e.target.closest(".bzsa-segpart");
      if (!p) return;
      e.stopPropagation();
      toggleDead(b, Number(p.dataset.start));
    });
    /* 左右裁剪把手（只在编辑态显示，CSS 控制）。 */
    const hl = document.createElement("div");
    hl.className = "bzsa-h"; hl.dataset.h = "l";
    const hr = document.createElement("div");
    hr.className = "bzsa-h"; hr.dataset.h = "r";
    el.append(hl, hr);
    const startDrag = (e, mode) => {
      if (!t.editing || t.placeholder) return;
      e.preventDefault();
      e.stopPropagation();
      const x0 = e.clientX;
      const f0 = b.from, t1 = b.to, s0 = b.srcFrom, e1 = b.srcTo;
      const ppf = pxPerFrame();
      /* 唯一合法范围 = 本块对应那段视频的左右边界，不是全片总长。 */
      const lo = Math.max(0, Number(b.segFrom) || 0);
      const hi = Math.max(lo + 1, Number(b.segTo) || lo + 1);
      const srcMax = Math.max(1, Math.round((Number(t.dur) || 0) * fpsOf()));
      /* 满段块（宽度≈本段宽度）拖动 = **滑音频内容**：块永远贴着本段不动，
         只把源入点/出点在整条音频上滑动（剪映的滑动剪辑）。裁短过的块段内
         有空位，仍走原来的「段内平移 / 超界缩进」。20261107 用户选方案 2。 */
      const lenSeg = hi - lo;
      const slipMode = mode === "move" && Math.round(t1 - f0) >= lenSeg - 1;
      const lenSrc = Math.max(1, Math.min(Math.round(t1 - f0), lenSeg));
      const maxStart = Math.max(0, srcMax - lenSrc);
      try { el.setPointerCapture && el.setPointerCapture(e.pointerId); } catch (_) {}
      const move = (ev) => {
        const df = Math.round((ev.clientX - x0) / ppf);
        if (slipMode) {
          b.from = lo; b.to = lo + lenSrc;
          b.srcFrom = Math.max(0, Math.min(s0 + df, maxStart));
          b.srcTo = b.srcFrom + lenSrc;
          b.slip = true;
        } else if (mode === "move") {
          /* 先算「没有段边界时该在哪儿」，再与本段求交集：超出的部分自动
             缩进（源区间同步裁掉），反向拖回来又原样长回来 —— 不会跨段。 */
          const rawFrom = f0 + df, rawTo = t1 + df;
          const from = Math.max(rawFrom, lo), to = Math.min(rawTo, hi);
          if (to - from >= 1) {
            b.from = from; b.to = to;
            b.srcFrom = Math.max(0, s0 + (from - rawFrom));
            b.srcTo = Math.max(b.srcFrom + 1, e1 - (rawTo - to));
          } else {
            /* 整块被拖出了这一段：贴住最近的边界、恢复原长度，别让块卡死
               在半路（用户会觉得「拖不动」）。源区间一并复位。 */
            const len = Math.max(1, Math.min(Math.round(t1 - f0), hi - lo));
            const f = rawTo <= lo ? lo : (rawFrom >= hi ? hi - len : f0);
            b.from = Math.min(Math.max(f, lo), Math.max(lo, hi - len));
            b.to = b.from + len;
            b.srcFrom = s0;
            b.srcTo = Math.max(s0 + 1, s0 + len);
          }
        } else if (mode === "l") {
          const from = Math.max(lo, Math.min(f0 + df, Math.min(t1 - 1, hi - 1)));
          b.from = from;
          b.srcFrom = Math.max(0, Math.min(s0 + (from - f0), e1 - 1));
        } else {
          const to = Math.min(hi, Math.max(t1 + df, Math.max(f0 + 1, lo + 1)));
          b.to = Math.max(b.from + 1, to);
          b.srcTo = Math.max(s0 + 1, Math.min(e1 + (to - t1), srcMax));
        }
        clampBlockToSeg(b);
        b.manual = true; b._dragged = true;
        t.edited = true;
        placeBlock(b);
        paintBlock(b);
      };
      const up = () => {
        el.removeEventListener("pointermove", move);
        el.removeEventListener("pointerup", up);
        el.removeEventListener("pointercancel", up);
        /* 只是单击（没真拖动）就什么都不做 —— 否则这一块会被标成"手动布局"，
           从此不再跟随段边界（改段长时它会掉队）。 */
        if (!b._dragged) return;
        t.layout.set(k0, { f: b.from, t: b.to, sf: b.srcFrom, st: b.srcTo,
                           sl: b.slip ? 1 : 0,
                           cuts: (b.cuts || []).slice(), del: (b.dead || []).slice() });
        saveLayout();
        /* 滑动剪辑：松手才落库重切（拖动全程零请求）。源入点没真变就不切。 */
        if (slipMode && b.srcFrom !== s0) {
          void reslip(t, b, k0, s0, e1);
          return;
        }
      };
      el.addEventListener("pointermove", move);
      el.addEventListener("pointerup", up);
      el.addEventListener("pointercancel", up);
    };
    /* 把手只有 7px，稍偏一点就落到块主体、走进「滑动剪辑」—— 那段逻辑
       故意让块贴段不动，用户看到的就是「拖两侧边不跟随鼠标」。按落点离
       左右边缘的距离分流：边缘 12px 内一律裁边，块中间才是滑动 / 平移。 */
    el.addEventListener("pointerdown", (e) => {
      if (!t.editing) return;
      if (e.target.classList && e.target.classList.contains("bzsa-h")) return;
      const rect = el.getBoundingClientRect();
      const EDGE = 12;
      if (e.clientX - rect.left <= EDGE) { startDrag(e, "l"); return; }
      if (rect.right - e.clientX <= EDGE) { startDrag(e, "r"); return; }
      startDrag(e, "move");
    });
    hl.addEventListener("pointerdown", (e) => startDrag(e, "l"));
    hr.addEventListener("pointerdown", (e) => startDrag(e, "r"));
    placeBlock(b);
    return b;
  }

  /* 边界只认 clip_from / clip_to；块变了才重切，切点仍是绝对时间轴位置。
     段数变了（插段/删段/复制段）必须跟着增删块：否则新段没有音频块、
     删掉的段留下孤块 —— 显示层就与档案脱节了。 */
  const pending = new Set();       // 轨 id + 段键，防同一段并发切两次
  async function fillBlock(t, r) {
    const k = segKey(r);
    if (t.placeholder) { if (!t.blocks.has(k)) addBlock(t, r, []); return; }
    const p = `${t.id}::${k}`;
    if (pending.has(p) || t.blocks.has(k)) return;
    /* 后端 auto_slice 已经切好、峰值也算好了 —— 直接用，别再切第二遍。 */
    const cached = t.slices && t.slices.get(k);
    if (cached) {
      addBlock(t, r, cached["峰值"] || []);
      paintMute(t);
      return;
    }
    /* 音频只覆盖到 t.dur 为止：更靠后的段没有音频可切，别造出空块。 */
    if (r.clip_from / fpsOf() >= t.dur - 1e-9) return;
    const gen = generation;
    pending.add(p);
    try {
      const start = r.clip_from / fpsOf();
      /* 帧账（243 帧/段）比用户填的秒数长：音频不够时切到音频末尾，
         绝不把区间伸到音频外面去 —— 那会让后端 400、整段没波形。 */
      const end = Math.min(r.clip_to / fpsOf(), t.dur);
      if (end - start < 1 / fpsOf()) return;
      const j = await cutOf(t.rel, start, end);
      /* 换代 / 段被删 / 同键已有新块：这次结果已过期，丢掉。 */
      if (gen !== generation || !t.el.isConnected || t.blocks.has(k)) return;
      if (t.aliveKeys && !t.aliveKeys.has(k)) return;
      addBlock(t, r, j["峰值"] || []);
      paintMute(t);
    } catch (e) {
      tip(String((e && e.message) || e), true);
    } finally {
      pending.delete(p);
    }
  }

  async function refreshBlocks(recut) {
    syncRowWidth();
    if (!tracks.length || !film) { syncEmpty(); return; }
    const rows = clipsOf();
    for (const t of tracks) {
      paintScope(t);
      const alive = new Set(rows.filter((r) => covers(t, r)).map(segKey));
      t.aliveKeys = alive;
      /* 档案里没有的块（段被删/被换身份/范围改了）当场带走，不留旧布局。 */
      for (const [k, b] of [...t.blocks]) {
        if (!alive.has(k)) { b.el.remove(); t.blocks.delete(k); }
      }
      for (const r of rows) {
        if (!covers(t, r)) continue;
        const b = t.blocks.get(segKey(r));
        if (!b) { void fillBlock(t, r); continue; }
        b.no = Number(r.index) || b.no;
        /* 段边界变了（改段长 / 续接 / 重排）两种块都要认新边界：手动块不许
           借着旧边界越到隔壁段去，自动块则整块跟着档案走。 */
        b.segFrom = Number(r.clip_from) || 0;
        b.segTo = Number(r.clip_to) || (b.segFrom + 1);
        /* 段长改了，落在段外的切点自动丢弃，否则后端会切出负长片段。 */
        if (b.cuts && b.cuts.length) {
          const kept = b.cuts.filter((x) => x > b.segFrom && x < b.segTo);
          if (kept.length !== b.cuts.length) {
            b.cuts = kept; markChanged(segKey(r));
          }
        }
        /* 手动布局过的块不再被档案边界覆盖 —— 那是用户亲手拖出来的位置，
           但仍要夹回新段内。 */
        if (b.manual) { clampBlockToSeg(b); placeBlock(b); continue; }
        const ncf = Number(r.clip_from) || 0, nct = Number(r.clip_to) || ncf;
        const natTo = Math.max(ncf + 1, Math.min(nct,
          ncf + Math.max(1, Math.round((Number(t.dur) || 0) * fpsOf()))));
        const moved = b.from !== ncf || b.to !== natTo;
        b.from = ncf;
        b.to = natTo;
        b.srcFrom = ncf;
        b.srcTo = natTo;
        placeBlock(b);
        if (recut && moved && !t.placeholder) void recutBlock(t, b, r);
      }
      paintMute(t);
    }
  }

  async function recutBlock(t, b, r) {
    const cached = t.slices && t.slices.get(segKey(r));
    if (cached) {
      b.peaks = cached["峰值"] || b.peaks;
      /* peaks 换了 = 它覆盖的源区间也换了，pf/pt 必须跟着更新。 */
      b.pf = Number(r.clip_from) || 0;
      b.pt = Number(r.clip_to) || b.pf;
      paintBlock(b);
      return;
    }
    const gen = generation;
    try {
      const start = r.clip_from / fpsOf();
      const end = Math.min(r.clip_to / fpsOf(), t.dur);
      if (end - start < 1 / fpsOf()) return;
      const j = await cutOf(t.rel, start, end);
      if (gen !== generation) return;
      b.peaks = j["峰值"] || b.peaks;
      b.pf = Number(r.clip_from) || 0;
      b.pt = Number(r.clip_to) || b.pf;
      paintBlock(b);
    } catch (e) {
      tip(String((e && e.message) || e), true);
    }
  }

  /* 段数按净长算：ceil 之后若余数不足 1 帧，并回上一段，避免出现半帧段。 */
  function countFor(dur) {
    const f = fpsOf();
    let n = Math.max(1, Math.ceil(dur / segSec - 1e-9));
    if (n > 1 && (dur - (n - 1) * segSec) * f < 1) n -= 1;
    return n;
  }

  /* 把「每段 N 秒」落成 H3 的合法帧。
     H3 的 17k+5 约束落在**总采样帧数**上，不是净长。旧实现让净长落在格点、
     再加 trim 交给后端，后端 resize_clip 的 snap_frames 又把含承接帧的总数吸
     一次，续接段的承接帧被吃掉、全片凭空短一截（20261108 实测短 31 帧）。
     所以这里直接产后端不会改的总 frames：Σ(5+17k) ≤ 音频帧数 + Σtrim。
     各段各自四舍五入会累积余量（18 段每段多 3 帧就是 2.5 秒），仍按总预算均分、
     余数用 Bresenham 打散，全程误差 ≤ 半格。 */
  function planFrames(dur, need, trims) {
    const f = fpsOf();
    const BASE = 5, GRID = 17;
    const budget = Math.max(1, Math.round(dur * f));
    const trimSum = trims.reduce((a, b) => a + (Number(b) || 0), 0);
    /* Σnet = Σframes - Σtrim ≤ budget */
    const kMax = Math.floor((MAX_FRAMES - BASE) / GRID);
    let units = Math.floor((budget + trimSum - BASE * need) / GRID);
    let per = Math.max(1, Math.floor(units / need));
    per = Math.min(per, kMax);
    units = per * need + Math.max(0, units - per * need);
    const rem = Math.max(0, units - per * need);
    const out = [];
    for (let i = 0; i < need; i++) {
      const extra = ((i * rem) % need) < rem ? 1 : 0;
      const k = Math.min(kMax, per + extra);
      out.push(Math.min(MAX_FRAMES, BASE + GRID * k));
    }
    return out;
  }

  /* 20261109 事故：音频轴用 resize_many 把段长改成 56 帧，却没改导演台面板
     的 shot.state.length，运行时登记又按面板 243 帧写回档案 —— 56↔243 反复
     6 次，波形缩条、驱动只剩开头一小截。当时的修法是「音频轴永不改段长」。

     20261111 用户选 B 重新要求改：末段音源不够时画面也要按剩余音频缩短。
     这次不是把旧写法抄回来，而是换成**后端单一事务**：缩短由后端在重切
     之前一次性改完档案，并把回读的真实帧数清单交给 syncFramesFromSlice
     写齐面板预设。档案 / 面板 / 驱动切片三者同源，没有第二个写入口。 */
  async function placeSegments(files) {
    return (await askJson("/banzhang/audio/auto_slice",
                          { name: nameOf(), files: files || [],
                            shrink_frames: true })) || {};
  }

  /* 把后端 auto_slice 带回的每段峰值灌进各轨缓存 —— 波形唯一的真值源。
     以前前端为了画波形会再调一遍 /cut，把同一首歌重切两次、写进另一份目录，
     还在"时长差一个采样点"时抛错，把整个拖入流程打断（库其实已经写好了）。 */
  /* 整轨峰值：滑动剪辑要按任意源入点即时画波形，本段切片那份 peaks 覆盖
     不到滑过去的位置。拖入 / 刷新恢复时各拉一次（512 点、一次解码），之后
     拖动全程纯前端，零请求、跟手。拿不到也不打断流程，退回本段峰值。 */
  async function ensureFullPeaks(t) {
    if (t.placeholder || !t.rel || t.fullPeaks) return;
    try {
      const j = await askJson("/banzhang/audio/peaks?file=" + encodeURIComponent(t.rel));
      const arr = j && j["峰值"];
      if (!Array.isArray(arr) || !arr.length) return;
      t.fullPeaks = arr;
      t.fullFrames = Math.max(1, Math.round(
        (Number(j["时长秒"]) || Number(t.dur) || 0) * fpsOf()));
      for (const b of t.blocks.values()) if (b.slip) paintBlock(b);
    } catch (_) { /* 预览缺席不影响主链路 */ }
  }

  function applySlices(j) {
    const laneBlocks = Array.isArray(j && j["轨"]) ? j["轨"] : [];
    const real = tracks.filter((x) => !x.placeholder);
    for (let i = 0; i < real.length; i++) {
      const info = laneBlocks[i];
      if (!info) continue;
      real[i].slices = new Map(
        (info["块"] || []).map((b) => [String(b["段"] || ""), b]));
      /* 收到整批新切片 = 音轨构成变了（换了音频 / 重排段）。旧 layout 按
         旧轨号与旧段存，继续采纳会把新长音频的第 1 段裁成一小截。 */
      real[i].layout = new Map();
    }
  }

  /* 后端把末段 frames 缩短后，导演台面板预设必须跟着改 —— 这一步是
     20261109 事故里唯一缺的那一环。只改档案不改面板，下一次渲染登记时
     后端会拿旧的 shot.state.length 把档案静默改回去。
     帧数用后端**回读**的真实值（不是前端估算），rows 用刷新后的 film。 */
  async function syncFramesFromSlice(j) {
    const pre = j && j["末段缩短"];
    const frames = pre && Array.isArray(pre["帧数"]) ? pre["帧数"] : null;
    if (!frames || !frames.length || !Number(pre["已缩短"])) return null;
    await loadFilm();
    if (typeof opts.syncShotFrames === "function") {
      opts.syncShotFrames(frames, clipsOf());
    } else {
      console.warn("[audio-lane] 导演台没给帧数回写入口：末段已按音频缩短，"
        + "但面板预设还是旧值，下一次渲染可能把它改回去。请 Ctrl+F5 刷新");
    }
    return pre;
  }

  async function rebuild(t, dur, sr) {
    generation += 1;
    for (const b of t.blocks.values()) b.el.remove();
    t.blocks.clear();
    t.aliveKeys = null;
    if (t.placeholder) {
      for (const r of clipsOf()) if (covers(t, r)) addBlock(t, r, []);
      return;
    }
    /* 有后端切片缓存就直接画，一次 ffmpeg 都不用再跑。 */
    if (t.slices && t.slices.size) {
      for (const r of clipsOf()) {
        if (!covers(t, r)) continue;
        const s = t.slices.get(segKey(r));
        addBlock(t, r, s ? (s["峰值"] || []) : []);
      }
      paintMute(t);
      return;
    }
    /* 没缓存（刷新后 / 老工程 / 手工改段长）才退回本地切片。
       失败只提示、绝不抛出 —— 拖入流程已经把库和界面都写好了，不该被
       一次波形重绘失败推翻成"看起来全都没成功"。 */
    busy = true;
    let shortBy = 0;
    try {
      const f = fpsOf(), rows = clipsOf();
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        if (!covers(t, r)) continue;
        if (r.clip_from / f >= dur - 1e-9) break;
        const start = r.clip_from / f;
        const rawEnd = r.clip_to / f;
        const end = Math.min(rawEnd, dur);
        if (end - start < 1 / f) continue;
        if (rawEnd > dur + 1e-6) shortBy = Math.max(shortBy, rawEnd - dur);
        const j = await cutOf(t.rel, start, end);
        addBlock(t, r, j["峰值"] || []);
      }
      paintMute(t);
      if (shortBy > 0.01) {
        tip(`音频比全片短 ${shortBy.toFixed(2)} 秒：最后一段尾部没有声音。`
            + `换条更长的音频，或把「每段秒数」调小即可铺满。`);
      }
    } catch (e) {
      tip("波形重绘没成功（音频分发本身已完成）：" + String((e && e.message) || e), true);
    } finally {
      busy = false;
    }
  }

  /* 按「每段秒数」把段清单排到刚好装下这首歌：不够就补段，多了不动。
     两条路径共用这一处 —— 拖入主音轨、以及改「每段 N 秒」，免得两份逻辑漂。
     返回 {need, added, extra}。 */
  async function planSegments(dur, files) {
    const f = fpsOf();
    /* 先卡上限再动段清单：单段最多 719 帧（29 秒），超了就别先建一堆空段。 */
    if (segSec > Math.floor(MAX_FRAMES / f)) {
      throw new Error(`每段最多 ${Math.floor(MAX_FRAMES / f)} 秒（模型单段上限 ${MAX_FRAMES} 帧）`);
    }
    /* 防呆：时间轴画的是**档案**里的段，渲染前检查却遍历**工程对象** p.shots。
       两边一旦差很多，就是「时间轴 3 段、渲染却报 319 段没绑档案」。这时候
       绝不能再 addShot —— 只会往 319 个孤儿段后面继续加，洞越挖越大。 */
    const archN = clipsOf().length;
    const liveN = typeof opts.shotCount === "function"
      ? (Number(opts.shotCount()) || 0) : archN;
    if (liveN > archN + 1) {
      throw new Error(`工程里有 ${liveN} 段、档案里只有 ${archN} 段 —— 有没绑进档案的`
        + `半成品段。先「切换工程」切到别的工程再切回来（会按档案重建段列表），再拖音频`);
    }
    const need = countFor(dur);
    /* 段数上限：H3 单段最多 30 秒，120 段已是 1 小时。挡住「算出来几百段、
       工程里塞进 319 个没绑档案的半成品」这种失控，宁可让人调大每段秒数。 */
    if (need > 120) {
      throw new Error(`这条音频要 ${need} 段（每段 ${segSec} 秒），超过 120 段上限；`
        + `把「每段秒数」调大再来`);
    }
    const cur = clipsOf().length;
    let added = 0;
    for (let i = cur; i < need; i++) {
      /* **必须走导演台注入的 addShot**（→ ui.addShot → registerShot）：它同一次
         调用里既往工程对象 p.shots 加段、又登记进档案，还给新段继承班底。
         自己 POST /cglide/chain/add_clip 只落档案、工程段永远是 1 —— 于是
         「时间轴 3 段、渲染前检查却报 319 段没绑进档案」就是这么长出来的。
         这条路 20261106 已明令废弃，别再从旧备份里抄回来。 */
      if (typeof opts.addShot !== "function") {
        throw new Error("导演台没把建段入口交给音频轴，请 Ctrl+F5 刷新页面再拖");
      }
      const sh = await opts.addShot();
      if (!sh || !sh.clip) {
        throw new Error(`补齐第 ${i + 1} 段没拿到段身份，已停下，不再硬补`);
      }
      added += 1;
    }
    if (added) await loadFilm();
    const extra = Math.max(0, clipsOf().length - need);
    const slice = await placeSegments(files);
    await loadFilm();
    return { need, added, extra, slice };
  }

  /* 拖入音频 = 一条龙：按音频长度排段数 → 按段切 → 每段混成一条驱动。
     段数是**算出来**的（ceil 音频时长 / 每段秒数），不够就自动补段 —— 拖一首
     3 分钟的歌进来，18 段自己出来，不用先手工数段。
     已有段只改净长、**绝不删段**：多出来的段不在音频范围内，保留（里面可能
     已经有素材）。第二首及以后的轨不改段数 —— 全片长度只由主音轨定。
     20261107 用户定：时间轴音频**只做驱动、不做参考**。后端一处收口把每段
     的驱动片段写进 meta["bzsa.driver"]，导演台按当前段直读 → 编码进 H3 AV
     latent 声音流 → 锁噪。这里刻意不刷新媒体架 / 文案台：那边是用户手动摆
     参考素材的地方，拖个音频进来不该把人家摆好的东西冲掉。 */
  async function applyAudio(file, rel, info) {
    const dur = Number(info["时长秒"]) || 0;
    const sr = Number(info["采样率"]) || 0;
    if (!(dur > 0)) throw new Error("这段音频读不出时长");
    const name = nameOf();
    if (!name) throw new Error("先给这个工程起个名字，再拖音频");
    if (!film) await loadFilm();

    const isMain = !hasReal();   /* 还没有真轨 = 这一条是主音轨，由它定全片长度 */
    /* files 必须在建轨之前算好：后端排段事务要拿这份清单一次性重切，而工程库
       里此刻还没有刚拖进来的这条轨，从 bzsa.tracks 反查会漏掉它。 */
    const files = tracks.filter((x) => !x.placeholder)
      .map((x) => x.rel).filter(Boolean).concat([rel]);
    let need = 0, added = 0, extra = 0, slice = null;
    if (isMain) ({ need, added, extra, slice } = await planSegments(dur, files));

    const t = isMain ? attachFirstTrack(rel, file.name, dur, sr)
                     : newTrack(rel, file.name, dur, sr, "all");
    let j = slice || {};
    if (!slice) {
      /* 附加轨不改段数，只需按现有段边界重切一次。 */
      tip(`正在按 ${clipsOf().length} 段切驱动音频…（${files.length} 条轨，别关页面）`,
          false, null, true);
      try {
        j = await askJson("/banzhang/audio/auto_slice",
                          { name, files, shrink_frames: true });
      } catch (e) {
        tip(String((e && e.message) || e), true);
        return;
      }
    }
    /* 末段画面缩短：档案已由后端改完，这里把真实帧数写齐面板预设。 */
    const shrink = await syncFramesFromSlice(j);
    /* 后端把每段每轨的切片峰值一起带回来了：灌进缓存，rebuild / fillBlock
       直接用，整条链路只切这一次。 */
    applySlices(j);
    /* 整轨峰值先备好：进编辑模式拖满段块时才有即时的滑动波形。 */
    await Promise.all(tracks.filter((x) => !x.placeholder).map(ensureFullPeaks));
    await rebuild(t, dur, sr);
    const segs = need || Number(j["段数"]) || 0;
    const drv = Number(j["驱动段数"]) || 0;
    const mixed = Number(j["混音段数"]) || 0;
    const shortened = Number(j["缩短段数"]) || 0;
    const thin = (j["明细"] || [])
      .filter((x) => Number(x["轨数"]) < files.length).length;
    const noDrv = Math.max(0, segs - drv);
    tip(`已按每段 ${segSec} 秒排成 ${segs} 段`
        + (added ? `（新增 ${added} 段空档案）` : "")
        + `，${files.length} 条轨 → 生成 ${drv} 段驱动音频`
        + (mixed ? `（其中 ${mixed} 段多轨混音）` : "（单轨直用）")
        + (thin ? `；有 ${thin} 段副轨较短，只按实际有音频的轨驱动` : "")
        + (shrink && Number(shrink["已缩短"])
          ? `；末段音源只剩 ${Number((shrink["明细"] || [{}])[0]["剩余音频秒"]) || 0} 秒，`
            + `画面也跟着缩到 ${Number((shrink["明细"] || [{}])[0]["新帧"]) || 0} 帧（不补静音、不留空画面）`
          : (shortened ? `；末段等 ${shortened} 段音源不够，按剩余音频实际时长驱动，不补静音` : ""))
        + (noDrv ? `；${noDrv} 段超出音源长度没有驱动，由模型自行出声` : "")
        + (extra ? `；多出的 ${extra} 段不在音频内，没动它们` : "")
        + "；时间轴音频只驱动、不写媒体架 / 文案台，参考素材请手动摆");
  }

  box.addEventListener("dragover", (e) => {
    if (!e.dataTransfer) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  });
  box.addEventListener("drop", async (e) => {
    e.preventDefault();
    const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (!file) return;
    if (!nameOf()) { tip("先给这个工程起个名字，再拖音频", true); return; }
    try {
      const rel = await upload(file);
      const info = await askJson("/banzhang/audio/probe?file=" + encodeURIComponent(rel));
      await applyAudio(file, rel, info);
    } catch (err) {
      tip(String((err && err.message) || err), true);
    }
  });

  /* 改「每段多少秒」= 按主音轨重排段数（不够自动补、多了不动），后端跟着重切，
     所有轨重画。与拖入主音轨共用 planSegments，两条路径不会各说各话。 */
  async function replan() {
    if (!hasReal()) { syncMeta(); return; }
    const main = tracks.find((t) => !t.placeholder);
    try {
      const files = tracks.filter((x) => !x.placeholder)
        .map((x) => x.rel).filter(Boolean);
      tip("正在按主音轨重排段数并重切驱动音频…", false, null, true);
      const { need, added, extra, slice } = await planSegments(main.dur, files);
      const shrink = await syncFramesFromSlice(slice);
      applySlices(slice || {});
      for (const t of tracks) await rebuild(t, t.dur, t.sr);
      const drv = Number((slice || {})["驱动段数"]) || 0;
      tip(`已按每段 ${segSec} 秒排成 ${need} 段`
          + (added ? `（新增 ${added} 段）` : "")
          + `，${tracks.length} 条音轨重切成 ${drv} 段驱动音频`
          + (shrink && Number(shrink["已缩短"])
            ? `；末段画面也按剩余音频缩到 ${Number((shrink["明细"] || [{}])[0]["新帧"]) || 0} 帧` : "")
          + (extra ? `；多出的 ${extra} 段不在音频内，没动` : "")
          + "；参考素材仍在媒体架 / 文案台手动摆，不受影响");
    } catch (e) {
      tip(String((e && e.message) || e), true);
    }
  }

  /* 「每段秒数」的改动入口已移到导演台设置面板「时长」（20261112 方案 B）：
     有主音轨时由 apiObj.setSegSec → replan 驱动，底部不再有独立输入框。 */

  /* 音轨恢复的唯一入口。真值源只有后端工程库：整包切工程带 data 来就直接用
     省一次请求，刷新 / 自愈 / HMR 没带就自己 GET。以前绑死在 applyProjectBundle
     上、还删了自恢复请求，刷新走 hydrateFromStore 时永远没人回灌（20261109）。 */
  async function restoreTracks(name, data) {
    if (!name || restoreInflight === name) return 0;
    restoreInflight = name;
    try {
      let j = data;
      if (!j) {
        const r = await api.fetchApi(
          "/banzhang/audio/tracks?name=" + encodeURIComponent(name));
        if (!r.ok) return 0;
        j = await r.json();
      }
      /* 片名在请求途中变了：这份数据属于旧工程，丢掉等下一轮。 */
      if (nameOf() !== name) return 0;
      return await hydrateTracks(j);
    } catch (e) {
      console.warn("[audio-lane] 音轨恢复失败：", e);
      return 0;
    } finally {
      restoreInflight = "";
    }
  }

  /* 整包切工程时由 applyProjectBundle 带 data 灌入；与 racks / desk 同一次请求。 */
  async function hydrateTracks(data) {
    const name = nameOf();
    /* 认领当前工程：重挂帧账订阅，并让后续 ensureSub 不再清空刚灌好的轨。 */
    tracksOwner = name;
    subName = name;
    if (unsub) { try { unsub(); } catch (_) {} unsub = null; }
    film = null;
    clearTracks();
    ensurePlaceholder();
    muted = loadMuted();
    syncMeta();
    if (name) {
      const snap = bzStore.film(name);
      if (snap) { film = snap; syncMeta(); }
      unsub = bzStore.subscribe(name, (d) => {
        if (!d || d.immediate) return;
        const s = bzStore.film(name);
        if (s) { film = s; syncMeta(); void refreshBlocks(!busy); }
      });
    }
    const j = data || {};
    const list = Array.isArray(j["轨"]) ? j["轨"] : [];
    if (!list.length) {
      void loadFilm().then(() => { if (film) void refreshBlocks(false); }).catch(() => {});
      return 0;
    }
    if (!film) await loadFilm();
    for (let i = 0; i < list.length; i++) {
      const info = list[i] || {};
      const rel = String(info["文件"] || "");
      if (!rel) continue;
      /* 第一条复用 clearTracks 留下的占位轨，不另起一行 —— 轨位置不跳。 */
      const t = i === 0
        ? attachFirstTrack(rel, String(info["名称"] || "音频"),
            Number(info["时长秒"]) || 0, Number(info["采样率"]) || 0)
        : newTrack(rel, String(info["名称"] || "音频"),
            Number(info["时长秒"]) || 0, Number(info["采样率"]) || 0, "all");
      t.slices = new Map((info["块"] || [])
        .map((b) => [String(b["段"] || ""), b]));
      /* 静音种子先挂着：blocks 要等下面的 refreshBlocks 才建齐。 */
      if (info["静音"] !== undefined && info["静音"] !== null) t.muteSeed = info["静音"];
      /* 手动拖/裁过的位置一起还原（按轨序号 1-based 存）。 */
      const lay = j["布局"] && j["布局"][String(i + 1)];
      if (lay && typeof lay === "object") {
        t.layout = new Map(Object.entries(lay).map(([k, v]) => [String(k), {
          f: Number(v && v.f) || 0, t: Number(v && v.t) || 0,
          sf: Number(v && v.sf) || 0, st: Number(v && v.st) || 0,
          sl: Number(v && v.sl) || 0,   // 滑动剪辑标记，追加字段向后兼容
          cuts: (Array.isArray(v && v.cuts) ? v.cuts : [])
            .map(Number).filter(Number.isFinite),
          del: (Array.isArray(v && v.del) ? v.del : [])
            .map(Number).filter(Number.isFinite),
        }]));
        if (t.layout.size) t.edited = true;
      }
    }
    syncMeta();
    await refreshBlocks(false);
    applyMuteSeeds();
    /* 刷新后滑过的块要用整轨峰值重画，否则波形会退回旧切片那一截。 */
    for (const t of tracks) void ensureFullPeaks(t);
    /* 重摆一次即可：placeBlock 自带绘制，不再赌「两帧之后布局一定落定」。 */
    renderBlocks();
    return list.length;
  }

  function ensureSub() {
    const name = (opts.getName && opts.getName()) || "";
    /* 音轨恢复与帧账订阅解耦：按「轨属于哪个片名」判定，不看是谁在恢复。
       刷新走 hydrateFromStore、切工程走整包、自愈 / HMR 各走各的，这里一律
       兜住；后端库里有轨就自己拉回来，空工程也会认领、不会重复发请求。 */
    if (name && tracksOwner !== name && !restoreInflight) void restoreTracks(name);
    if (name === subName) return;
    subName = name;
    if (unsub) { try { unsub(); } catch (_) {} unsub = null; }
    film = null;
    /* 整包已把轨灌成当前工程的就别清：轮询只比 ensureSub 晚一步也会抹掉波形。 */
    if (tracksOwner !== name) { clearTracks(); tracksOwner = ""; }
    muted = loadMuted();
    syncMeta();
    if (!name) return;
    const snap = bzStore.film(name);
    if (snap) { film = snap; syncMeta(); void refreshBlocks(false); }
    unsub = bzStore.subscribe(name, (d) => {
      if (!d || d.immediate) return;
      const s = bzStore.film(name);
      if (s) { film = s; syncMeta(); void refreshBlocks(!busy); }
    });
    /* 刚进工程时 store 常常还没有快照；不主动拉一次帧账，空轨就只有轨头、
       按段占位格画不出来，看起来又像「音频轨不见了」。 */
    void loadFilm().then(() => { if (film) void refreshBlocks(false); }).catch(() => {});
  }

  /* 改段长：松手 300ms 后重摆边界；净长变了就只重切变的那几块。 */
  const hostRoot = wave.closest(".bzfilm") || document;
  hostRoot.addEventListener("input", (e) => {
    if (!e.target || !e.target.classList || !e.target.classList.contains("bzf-frames")) return;
    clearTimeout(syncTimer);
    syncTimer = setTimeout(() => {
      const name = (opts.getName && opts.getName()) || "";
      if (!name) return;
      const snap = bzStore.film(name);
      if (snap) { film = snap; syncMeta(); void refreshBlocks(true); }
    }, 300);
  }, true);

  /* ---- 驱动音轨试听：跟时间轴播放头同步 ----
     播放头帧位由 film.js 的 setPlayheadAbs 广播；play/pause 不冒泡，走捕获。 */
  let audioPlaying = false;
  let previewMode = "idle";   // idle | track | seg | sync
  let previewTrackRef = null;
  let previewEnd = 0;
  /* 整轨试听按段序依次播放的片段队列；本段试听只有 1 项。 */
  let previewQueue = [];
  let previewIdx = 0;
  let lastFrame = 0;   /* 最近一次广播的全片帧位：play 之前要对齐到它 */

  /* 把一条轨对到全片第 t 秒。
     「指针在动、声音从头开始」的根因就在这里：play() 永远从 currentTime 起播，
     而元素刚建好（readyState=0）时**给 currentTime 赋值会被直接吞掉**，于是
     一开播就是 0。所以：没就绪就记账、等 loadedmetadata 再补一次；就绪了才
     按容差纠偏（容差太大每帧都在 seek，会卡成电音）。 */
  function seekOne(tr, t) {
    const a = tr.audio;
    if (!a) return;
    const dur = (isFinite(a.duration) && a.duration > 0) ? a.duration : tr.dur;
    const want = Math.max(0, Math.min(Number(t) || 0, Math.max(0, dur - 0.02)));
    if (a.readyState === 0) {
      a.dataset.pendingSeek = String(want);
      if (!a.dataset.seekHooked) {
        a.dataset.seekHooked = "1";
        a.addEventListener("loadedmetadata", () => {
          const v = Number(a.dataset.pendingSeek);
          if (isFinite(v)) { try { a.currentTime = v; } catch (_) {} }
        });
      }
      return;
    }
    if (Math.abs(a.currentTime - want) > 0.15) {
      try { a.currentTime = want; } catch (_) {}
    }
  }

  /* 把一条轨对齐到全片第 frame 帧。手拖/裁剪过的轨按块映射到源音频入点，
     块外静音 —— 否则「拖了位置，声音还按老位置播」，等于白拖。 */
  function seekTrackTo(tr, frame) {
    const fps = fpsOf() || 24;
    if (tr.edited) {
      let hit = null;
      for (const b of tr.blocks.values()) {
        if (frame >= b.from && frame < b.to) { hit = b; break; }
      }
      try { tr.audio.muted = !hit || (tr.el.dataset.muted === "1"); } catch (_) {}
      if (hit) seekOne(tr, (hit.srcFrom + (frame - hit.from)) / fps);
      return;
    }
    seekOne(tr, frame / fps);
  }

  function syncAudioTo(frame, fps) {
    lastFrame = Number(frame) || 0;
    /* 独立试听时别让成片播放头把 currentTime 拽走。 */
    if (previewMode === "track" || previewMode === "seg") return;
    for (const tr of tracks) {
      if (tr.placeholder || !tr.audio) continue;
      seekTrackTo(tr, lastFrame);
    }
  }

  /* 播放状态机：以前只有 primeAudio 一个单向入口，停止全靠 video 的 pause
     事件 —— 没成片时 video 根本不播、永远不发 pause，音轨就在后台一直响。
     现在停止是显式接口，film.js 所有暂停路径都调 stopAudio。 */
  function syncPlayButtons() {
    for (const t of tracks) {
      for (const [el, mode] of [[t.el.querySelector(".bzsa-play"), "track"],
                                [t.el.querySelector(".bzsa-playseg"), "seg"]]) {
        if (!el) continue;
        const active = previewTrackRef === t && previewMode === mode;
        el.dataset.on = active ? "1" : "0";
        el.textContent = active ? "停止" : (mode === "track" ? "试听" : "本段");
      }
    }
  }
  function stopAudio() {
    previewQueue = [];
    previewIdx = 0;
    if (previewMode === "idle" && !audioPlaying) { syncPlayButtons(); return; }
    previewMode = "idle";
    previewTrackRef = null;
    previewEnd = 0;
    audioPlaying = false;
    for (const t of tracks) {
      if (!t.audio) continue;
      try { t.audio.pause(); } catch (_) {}
      /* 独立试听临时解过静音，停时按轨头静音状态复原。 */
      try { t.audio.muted = t.el.dataset.muted === "1"; } catch (_) {}
      /* 试听临时挂的是合成片段，停时退回整条源音频 —— 成片播放按帧对齐
         靠它，不能让一次试听把播放源永久换成本段切片。 */
      try {
        const src = audioUrl(t.rel);
        if (t.audio.getAttribute("src") !== src) {
          t.audio.setAttribute("src", src);
          t.audio.load();
        }
      } catch (_) {}
    }
    syncPlayButtons();
  }
  /* 试听整轨从 0 播到结束；试听本段只播当前选中段在源音频里的区间。
     同一个按钮再点 = 停；切按钮 / 切轨先停旧的。全程不碰音频块。 */
  async function startPreview(t, mode) {
    if (t.placeholder || !t.audio) return;
    if (previewTrackRef === t && previewMode === mode) { stopAudio(); return; }
    stopAudio();
    const a = t.audio;
    const rows = clipsOf();
    const cur = opts.getCurClip ? String(opts.getCurClip() || "") : "";
    /* 本段 = 当前选中的那一段（没选中就取第一段）；试听 = 本轨作用范围内的所有段。 */
    const r = rows.find((c) => segKey(c) === cur) || rows[0] || null;
    /* 试听 / 本段都听**本轨本段**的合成切片：t.slices 按轨按段缓存了「文件」，
       含静音轨（试听无视静音），是单一真值源。不再自请求 /banzhang/audio/tracks，
       也不再用驱动 parts 的稠密索引 —— 那是去掉静音轨后的列表，按轨号取会串轨 /
       取空，一取空就退回整条源音频，本段因此播成了整首歌（20261112 用户报）。 */
    const partOf = (row) => {
      const s = row && t.slices && t.slices.get(segKey(row));
      return s ? String(s["文件"] || "") : "";
    };
    let queue = [];
    if (mode === "track") {
      for (const row of rows) {
        if (!covers(t, row)) continue;
        const rel = partOf(row);
        if (rel) queue.push(rel);
      }
      /* 整轨试听没有任何切片（老工程 / 后端异常）才退回整条源音频。 */
      if (!queue.length) queue = [t.rel];
    } else {
      const rel = partOf(r);
      if (rel) queue = [rel];
    }
    previewQueue = queue;
    previewIdx = 0;
    previewMode = mode;
    previewTrackRef = t;
    previewEnd = 0;
    if (queue.length) {
      const want = audioUrl(queue[0]);
      if (a.getAttribute("src") !== want) {
        a.setAttribute("src", want);
        try { a.load(); } catch (_) {}
      }
      seekOne(t, 0);
    } else {
      /* 本段没有合成切片：退回**源音频里这一段的区间**，绝不播整条源。
         用块的源入点 / 出点定位，timeupdate 到段尾自停（previewEnd）。 */
      const b = r && t.blocks.get(segKey(r));
      if (!b) {
        previewMode = "idle"; previewTrackRef = null;
        tip("当前段没有音频切片，先拖入音频或等切片完成", true);
        syncPlayButtons();
        return;
      }
      const fps = fpsOf() || 24;
      const want = audioUrl(t.rel);
      if (a.getAttribute("src") !== want) {
        a.setAttribute("src", want);
        try { a.load(); } catch (_) {}
      }
      seekOne(t, (Number(b.srcFrom) || 0) / fps);
      previewEnd = (Number(b.srcTo) || 0) / fps;
    }
    /* 成片播放留下的轨静音不该把独立试听也闷掉。 */
    try { a.muted = false; } catch (_) {}
    const p = a.play();
    if (p && p.catch) p.catch(() => stopAudio());
    syncPlayButtons();
  }
  function setAudioPlaying(on) {
    if (on && (previewMode === "track" || previewMode === "seg")) stopAudio();
    audioPlaying = !!on;
    /* 停时必须退回 idle：留着 sync 会让 isPlaying() 恒真，监视器再点画面只暂停不播放。 */
    previewMode = on ? "sync" : "idle";
    for (const tr of tracks) {
      if (tr.placeholder || !tr.audio) continue;
      if (on) {
        /* 先对齐再播 —— 顺序反了就是「每次播放都从头」。 */
        seekTrackTo(tr, lastFrame);
        const p = tr.audio.play();
        if (p && p.catch) p.catch(() => {});
      } else tr.audio.pause();
    }
    syncPlayButtons();
  }
  function primeAudio() {
    if (!audioPlaying) setAudioPlaying(true);
  }
  const isPlaying = () => previewMode !== "idle" || audioPlaying;
  hostRoot.addEventListener("bzf:playhead", (e) => {
    syncAudioTo(Number(e.detail && e.detail.frame) || 0, fpsOf());
  });
  /* 播放状态只由 film.js 的 startPlayback / haltPlayback 显式驱动。
     这里曾捕获 play / pause / ended 反推状态，结果任何预览视频一播就把
     导入音轨一起唤起（20261108 二次复发）—— 隐式驱动整套删除，不再补判断。
     段尾收口在 <audio> 自己的 timeupdate / ended，停止在 stopAudio()。 */

  const ro = new ResizeObserver(() => {
    renderBlocks();
    void refreshBlocks(false);
  });
  ro.observe(box);

  /* 工程还没起名时 ensureSub 会提前返回，空轨就没人建 —— 这里先兜一条。 */
  ensurePlaceholder();
  ensureSub();
  /* 宿主切工程 / 改片名时 getName 会变；名字没变就是一次字符串比较，开销可忽略。
     节点被删后 box.isConnected 为假，这里自然停转，不另设卸载接口。 */
  setInterval(() => { if (box.isConnected) ensureSub(); }, 1500);

  /* sync：时间轴重新布局 / 缩放后由 film.js 调一次，块按新像素重摆。 */
  /* 时间轴每次 layout 都会调 sync：尺子变化必须无条件重摆重画，不能等 film
     到齐 —— 否则尺子已就绪、档案还没拉回来时那次通知就被丢掉，块永远停在 2px。 */
  /* 整包切工程也走同一个恢复入口，避免与 ensureSub 的自恢复并发重建。 */
  const apiObj = { box, refresh: ensureSub, primeAudio,
    hydrateTracks: (data) => restoreTracks(nameOf(), data),
    sync: () => { renderBlocks(); if (film) void refreshBlocks(false); },
    stopAudio, isPlaying,
    selectedTrack: () => selectedTrackId,
    onSelectChange: (cb) => { selectCb = typeof cb === "function" ? cb : null; },
    /* 方案 B：设置面板「时长」在有主音轨时驱动切段。hasMainAudio 判语义、
       getSegSec 回显、setSegSec 改秒数并重切全片（夹到模型单段上限）。 */
    hasMainAudio: hasReal,
    getSegSec: () => segSec,
    setSegSec: (n) => {
      const maxSec = Math.max(1, Math.floor(MAX_FRAMES / fpsOf()));
      let v = Math.round(Number(n) || 0);
      if (v < 1) v = 1;
      if (v > maxSec) { v = maxSec; tip(`每段最多 ${maxSec} 秒（模型单段上限 ${MAX_FRAMES} 帧）`, true); }
      segSec = v;
      localStorage.setItem(LS_SEG, String(segSec));
      return replan();
    },
    canCutAt, cutAt };
  wave.__bzsa = apiObj;
  return apiObj;
}
