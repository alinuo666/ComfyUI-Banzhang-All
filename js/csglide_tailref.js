/* ============================================================
 * ⏱ 参照图替换 — 把上一段成片的某一帧，换成下一段的参照图参考
 * 方案 B「接缝双画面」：
 *   左卡＝上一段成片的选中帧（薄胶片条选帧），右卡＝媒体架当前
 *   参照图（缩略图直接读媒体架，替换前就看得见要换掉什么），
 *   中间圆形按钮一按换画，再按还原。
 *
 * 不接任何线、不点运行也生效：替换发生在两次运行之间，是纯前端
 * 动作。编号不用选：@图片N 的 N = 媒体架 slots.images 的物理下标，
 * 原位换 file 指向（不插队不追加），编号与文案里写死的 @图片N
 * 全部照旧。
 *
 * 后端接口：/cglide/tailref/info · /preview · /sprite · /grab
 * ============================================================ */
import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { rebuildMediaRackUI } from "./csglide_media_rack.js";
import { viewURL, THUMB_SIZE, MAX_SLOTS } from "./csglide_rack_core.js";
import { onRackChange, emitRackChange, castProject } from "./bz_rack.js";
import { pushSegText } from "./bz_seg.js";
import { CSS } from "./csglide_tailref.css.js";

const NODE_ID = "CSGlideTailRefCS";
const API = "/cglide/tailref";
const RACK_ID = "CSGlideH3MediaRackCS";
const DESK_ID = "CSGlideDeskCS";

const STRIP_H = 30;         // 薄胶片条高度兜底值：实际以 CSS 渲染高度为准
const MIN_WIN = 16;         // 最少可见帧数 = 缩放上限
const ZOOM_MAX = 64;
const BUF_MUL = 2.4;        // 胶片条取「可见窗口」的多少倍：平移时不必重取
const MIN_WIDTH = 400;
const FALLBACK_H = 248;     // 首挂 rAF 前测不到高度时的兜底面板高

function injectCSS() {
  if (document.getElementById("bzt-css")) return;
  const s = document.createElement("style");
  s.id = "bzt-css";
  s.textContent = CSS;
  document.head.appendChild(s);
}

/* ------------------------------------------------------------- helpers */

/* 两条替换目标：
     core = 空间关系参照图（原有一路）
     open = 开场构图参考（新增：把上一段收尾画面给本段开头当参照）
   每路各自记「选了哪一帧 / 改了哪一栏 / 原来是什么」—— 两路要能用不同帧。
   时间轴只有一条，st.frame 是时间轴的当前帧；切标签时存旧路、恢复新路。

   segWrite / segName —— 这次替换实际写进了哪一段。还原按它写回，
   与"当前停在哪一段"无关：切段后点 ↩ 也能还原，且不会改到眼前的段。
   hadOrig —— 原来那栏本来就是空的（此时 origFile 为空是正常值，不是记录丢失）。
   revoked —— 用户点过还原、这一路已撤销。开场构图的行是本节点自己插的，
   还原时连行一起撤；没有这个标记，paintTarget 的「没行就自动建栏」会在同一帧
   把行补回来，表现就是「点了还原，文案一动没动」。 */
const TG_EMPTY = { frame: -1, index: 0, alias: "", file: "", origFile: "",
                   replaced: false, hadOrig: false, segWrite: "", segName: "",
                   revoked: false };

const EMPTY = { video: "", frame: -1, total: 0, fps: 24, w: 0, h: 0, name: "",
                cur: "core", tg: { core: { ...TG_EMPTY }, open: { ...TG_EMPTY } } };

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const shortName = (p) => String(p || "").split("/").pop() || "";

/* 面板状态既写 widget（随工作流存档）又写 properties（刷新后先读它）。
   落盘文件是固定名，所以只需记住「原来指向谁」就能一键还原。 */
function readState(node) {
  const raw = node.properties?.bzt || {};
  /* tg 要逐路深合并：外层展开会把只存了 core 的老存档的 open 整块抹掉，
     一路替换记录丢了倒还好，一路变成半截对象才是真麻烦。 */
  const st = { ...EMPTY, ...raw,
               tg: { core: { ...TG_EMPTY, ...(raw.tg?.core || {}) },
                     open: { ...TG_EMPTY, ...(raw.tg?.open || {}) } } };
  st.frame = Number(st.frame ?? -1);
  st.total = Number(st.total ?? 0);
  st.fps = Number(st.fps ?? 24) || 24;
  st.w = Number(st.w ?? 0);
  st.h = Number(st.h ?? 0);
  st.cur = st.cur === "open" ? "open" : "core";
  for (const k of ["core", "open"]) {
    st.tg[k].frame = Number(st.tg[k].frame ?? -1);
    st.tg[k].index = Number(st.tg[k].index ?? 0);
  }
  return st;
}

function writeState(node, st) {
  node.properties = node.properties || {};
  node.properties.bzt = st;
  const w = node.widgets?.find((x) => x.name === "tail_state");
  if (w) {
    w.value = JSON.stringify(st);
    w.callback?.(w.value);
  }
}

function findNode(type) {
  const list = app.graph?.nodes || app.graph?._nodes || [];
  return list.find((n) => n && n.type === type) || null;
}

/* 参照图编号从文案台当前段文案里认：优先当前 clip，兜底按 shot，再兜底
   扫所有段找「标出了参照图」的那段 —— 与文案台 compose 的认段顺序一致。

   认的是**结构**，不是某个具体名词：模板的叫法会变，现在 SEG 里同一张参照图
   有两种写法，两者指向同一栏，谁在用谁：
     ① 定义式    将 @图片25 定义为本段的空间关系参照图（…）
     ② 编号对照式 图片编号对照：@图片25 对应 KF_01-02。
   同一段里还有「将 @图片12 定义为 林昭（主角）」这类主体定义行 —— 认错行会把
   主角槽换成尾帧，所以优先级严格分层：名词命中 > 名词兜底 > 编号对照式，
   都不命中就报错，宁可不出手也不猜。 */
const CORE_HINTS = ["核心帧", "空间关系参照图", "参照图", "参考图"];
/* 开场构图：上一段的收尾画面，给本段开头当参照（主体位置、构图延续）。
   认名词时不走"定义为…图／帧"兜底、也不认编号对照 —— 那两条会把别人的
   参照图当成开场帧。宁可认不到（认不到就自动建一栏）。 */
const OPEN_HINTS = ["开场构图参考", "开场构图", "开场参考"];
/* 自动建栏时写进文案的那一行。栏号 N = 媒体架末尾加一，不写死 —— 写死
   编号必然和别的参照图撞车。 */
const openLine = (n) => `将 @图片${n} 定义为本段的开场构图参考（承接上一段的收尾画面）`;

function fromDefine(line) {
  const m = line.match(/@图片\s*(\d+)/);
  if (!m) return null;
  const a = line.match(/定义为\s*([^\s（(,，。；;、]+)/);
  // 「定义为本段的空间关系参照图」→ 剥掉「本段的」这一层前缀，只留名词本身
  const alias = a ? a[1].replace(/^(本段|该段|本镜|这一段|这一镜)?的?/, "") : "";
  return { line, index: Number(m[1]), alias };
}

/* 编号对照项：@图片N 对应 KF_xx。架上参照图可能有很多张（KF_01-02、KF_01-05…），
   所以这一层只在**整段恰好一个**对照项时才敢用：多条即歧义，不出手。 */
function contrastItems(text) {
  const out = [];
  const re = /@图片\s*(\d+)\s*对应\s*([^\s（(,，。；;、]+)/g;
  let mm;
  while ((mm = re.exec(String(text || "")))) {
    out.push({ index: Number(mm[1]), alias: mm[2] });
  }
  return out;
}

function coreRef(text, hints = CORE_HINTS, strict = false) {
  const lines = String(text || "").split(/\r?\n/);
  const def = lines.filter((l) => /@图片\s*\d+/.test(l) && /定义\s*为/.test(l));
  for (const hint of hints) {
    const one = def.find((l) => l.includes(hint));
    if (one) { const r = fromDefine(one); if (r) return r; }
  }
  if (strict) return null;
  // 兜底只认「定义为…图／帧」这种名词：主体定义行（定义为 张三）不是参照图
  const tail = def.find((l) => /定义为\s*[^\s（(,，。；;、]*[图帧]/.test(l));
  if (tail) { const r = fromDefine(tail); if (r) return r; }
  // 编号对照式：上面都没命中才用它
  const all = contrastItems(text);
  if (all.length === 1) return { line: "", index: all[0].index, alias: all[0].alias };
  return null;
}

/* 认栏按「当前段优先、认不出就跨段找」，找到后用 current 标出来源 ——
   不拦截。用户可能就是想在还没写文案的段里先把图换上。
   唯一还会报错的是**当前段自己写着多条编号对照**：那是同段内的歧义，
   猜错会把主角槽换成尾帧。 */
function readCoreFrame(kind = "core") {
  const desk = findNode(DESK_ID);
  const w = desk?.widgets?.find((x) => x.name === "desk_data");
  if (!w) return { error: "画布上没有 ✍️ H3 文案台" };
  let st = {};
  try { st = JSON.parse(w.value || "{}"); } catch (_) { st = {}; }
  const segs = st.segs && typeof st.segs === "object" ? st.segs : {};
  const name = st.chain?.name || "";
  const open = kind === "open";
  let key = st.chain?.clip || st.chain?.shot || "";
  let current = true;

  if (!key) {
    /* 没选中段：核心帧可以跨段找（老行为），开场构图不行 ——
       建栏要写进文案，必须落在一段明确的段上。 */
    const hit = open ? null : Object.keys(segs).find((k) => coreRef(segs[k]));
    if (!hit) {
      return { error: open ? "先选中目标段，才能给这一段建开场构图栏"
                           : "文案台没选中段，也没有任何段写着参照图行" };
    }
    key = hit;
    current = false;
  } else if (!open && !coreRef(segs[key] || "")) {
    const hit = Object.keys(segs).find((k) => k !== key && coreRef(segs[k]));
    if (hit) { key = hit; current = false; }
  }

  const text = segs[key] || "";
  const ref = coreRef(text, open ? OPEN_HINTS : CORE_HINTS, open);
  if (!ref) {
    /* 开场构图没这一行 = 还没建栏，交给调用方去建（不是错误） */
    if (open) return { missing: true, segKey: key, name, current };
    /* 有多条编号对照 = 架上参照图很多张、这段没写明是哪一张。
       直接把候选摊给用户看，并告诉他怎么写才认得出来。 */
    const items = contrastItems(text);
    if (items.length > 1) {
      const names = items.map((it) => `${it.alias}（@图片${it.index}）`).join("、");
      return { error: `本段有 ${items.length} 张参照图候选（${names}），` +
                       "没写明哪张是本段的。在文案台加一行「将 @图片N 定义为本段的空间关系参照图」即可" };
    }
    return { error: "文案台里没找到参照图行（需要 @图片N + 定义为 X，或 @图片N 对应 编号）" };
  }
  return { index: ref.index, alias: ref.alias, name, segKey: key, current };
}

function timecode(sec) {
  const s = Math.max(0, sec || 0);
  const m = Math.floor(s / 60);
  const r = s - m * 60;
  return `${m}:${r.toFixed(2).padStart(5, "0")}`;
}

/* -------------------------------------------------------------- panel */

function buildPanel(node) {
  injectCSS();

  const root = document.createElement("div");
  root.className = "bzt";
  root.innerHTML = `
    <div class="bz-bar">
      <span class="bz-title">⏱ 参照图</span>
      <span class="bz-sep">|</span>
      <span class="bz-meta">等待取片…</span>
      <button class="bz-btn" type="button" data-a="pick"
        title="从 output 最近生成的成片里选一部，取到胶片条上挑帧">选取成片</button>
    </div>
    <div class="bz-pick" hidden></div>
    <div class="bz-band">
      <div class="bz-view" tabindex="0"
        title="点一下跳到该帧 · 按住拖动搓动选帧 · 滚轮缩放 · Shift/中键拖动平移 · 双击适配 · ← → 微调（Shift 走 10 帧）">
        <img class="bz-strip" alt="" hidden>
        <div class="bz-empty">点右上「选取成片」后，在这里选帧</div>
        <div class="bz-play" style="display:none"></div>
        <div class="bz-bub"></div>
      </div>
      <div class="bz-trackrow">
        <span class="bz-tc mono"></span>
        <span class="bz-zoom"></span>
        <button class="bz-mini" type="button" data-a="tail" disabled
          title="跳到最后一帧：续接要的通常就是上一段的收尾画面">尾帧</button>
      </div>
    </div>
    <div class="bz-tabs">
      <button class="bz-tab" type="button" data-t="core"
        title="本段的空间关系参照图：换成本片选中的那一帧">空间关系参照图</button>
      <button class="bz-tab" type="button" data-t="open"
        title="本段开头的构图参照：把上一段的收尾画面给这一段当开头参照">开场构图</button>
    </div>
    <div class="bz-seam">
      <div class="bz-card">
        <div class="bz-cl">源帧 · 上一段成片</div>
        <div class="bz-vframe dash bz-srcframe">
          <img class="bz-pic" alt="选中帧" hidden>
          <div class="bz-stripzoom" hidden></div>
          <div class="bz-vcap">取片后显示所选帧</div>
          <button class="bz-nav bz-nav-l" type="button" data-d="-1" disabled>‹</button>
          <button class="bz-nav bz-nav-r" type="button" data-d="1" disabled>›</button>
        </div>
        <div class="bz-vm"><span class="bz-fnum mono">—</span></div>
      </div>
      <button class="bz-mid" type="button" data-a="go" disabled title="用源帧替换目标参照图">→</button>
      <div class="bz-card">
        <div class="bz-cl">目标 · <b class="bz-tgt">识别中…</b></div>
        <div class="bz-vframe dash bz-tgtframe">
          <img class="bz-tgtpic" alt="目标参照图" hidden>
          <div class="bz-vcap bz-tgtcap">—</div>
          <span class="bz-vbadge" style="display:none">当前</span>
        </div>
        <div class="bz-vm"><span class="bz-tgtname">—</span></div>
      </div>
    </div>
    <div class="bz-msg">先取片，再点替换</div>
  `;

  const el = {
    tabs: [...root.querySelectorAll(".bz-tab")],
    meta: root.querySelector(".bz-meta"),
    pick: root.querySelector('[data-a="pick"]'),
    pickList: root.querySelector(".bz-pick"),
    view: root.querySelector(".bz-view"),
    strip: root.querySelector(".bz-strip"),
    empty: root.querySelector(".bz-empty"),
    play: root.querySelector(".bz-play"),
    bub: root.querySelector(".bz-bub"),
    tc: root.querySelector(".bz-tc"),
    zoomTxt: root.querySelector(".bz-zoom"),
    tail: root.querySelector('[data-a="tail"]'),
    srcFrame: root.querySelector(".bz-srcframe"),
    pic: root.querySelector(".bz-pic"),
    stripZoom: root.querySelector(".bz-stripzoom"),
    srcCap: root.querySelector(".bz-srcframe .bz-vcap"),
    fnum: root.querySelector(".bz-fnum"),
    navs: [...root.querySelectorAll(".bz-nav")],
    mid: root.querySelector(".bz-mid"),
    tgt: root.querySelector(".bz-tgt"),
    tgtFrame: root.querySelector(".bz-tgtframe"),
    tgtPic: root.querySelector(".bz-tgtpic"),
    tgtCap: root.querySelector(".bz-tgtcap"),
    tgtName: root.querySelector(".bz-tgtname"),
    badge: root.querySelector(".bz-vbadge"),
    msg: root.querySelector(".bz-msg"),
  };

  let st = readState(node);
  let busy = false;
  let zoom = 1;
  let winStart = 0;
  let buf = null;          // 当前胶片条覆盖的区间
  let stamp = Date.now();  // 换片才变，用来绕过浏览器缓存
  let drag = null;         // {mode:'scrub'|'pan', x, start}
  let measured = 0;        // 面板自然高度实测值（高度双通道声明共用）
  const tg = () => st.tg[st.cur] || st.tg.core;   // 当前这一路的替换记录
  let creating = false;    // 正在自动建开场构图栏：改文案会引发重绘，挡递归
  let openFailed = false;  // 建栏失败过：不再自动重试，等用户再点一次标签
  let lineFixKey = "";     // 补写文案行的去重键（同一段+同一栏只补一次）
  let tgtShown = "";       // 右卡已加载的 file，相同不重设 src
  let tgtLoaded = false;   // 右卡当前 src 是否已加载完成
  let tgtWired = false;    // 目标栏位接了端口：file 会被端口值覆盖，替换不落地
  let tgtNoLine = false;   // 开场构图栏还在，但文案里那一行没了：模型看不到这张图
  let errMsg = "";         // 异步操作的错误：paint 重绘不得把它盖掉
  let noteMsg = "";        // 一次性回执（跨段还原：眼前这一段看不出变化，得说一句）
  let noteTimer = 0;

  /* ---------- 几何：时间 ↔ 像素 ---------- */

  /* 画布缩放是 CSS transform，getBoundingClientRect() 与 clientX 都是缩放后的
     值，而 winStart/播放头用的是布局像素。两者之比就是缩放系数。 */
  function ptrX(e) {
    const r = el.view.getBoundingClientRect();
    const scale = r.width / (el.view.offsetWidth || 1) || 1;
    return (e.clientX - r.left) / scale;
  }

  function maxZoom() {
    return clamp(st.total / Math.min(MIN_WIN, Math.max(1, st.total)), 1, ZOOM_MAX);
  }

  function metrics(z, s0) {
    const view = el.view.clientWidth;
    if (!view || st.total < 2) return null;
    const aspect = st.w > 0 && st.h > 0 ? st.w / st.h : 16 / 9;
    const cellPx = Math.max(36, Math.round((el.view.clientHeight || STRIP_H) * aspect));
    const cols = clamp(Math.round(view / cellPx), 3, 40);
    const cellW = Math.max(14, Math.round(view / cols));
    const winF = clamp(st.total / z, Math.min(MIN_WIN, st.total), st.total);
    const maxStart = Math.max(0, st.total - winF);
    return {
      view, winF, maxStart, cols, cellW,
      cellF: winF / cols, start: clamp(s0, 0, maxStart),
      ppf: view / Math.max(1, winF - 1),
    };
  }

  const layout = () => {
    const m = metrics(zoom, winStart);
    if (m) winStart = m.start;
    return m;
  };

  const frameToX = (f, L) => (f - L.start) * L.ppf;
  const xToFrame = (x, L) => Math.round(clamp(L.start + x / L.ppf, 0, st.total - 1));

  /* ---------- 胶片条 ---------- */

  /* 取「可见窗口」的 BUF_MUL 倍铺进去：窗口在缓冲里移动时只改 left，
     不必重新抽帧，平移才跟手。缓冲起点按格对齐。 */
  function ensureStrip(L) {
    if (!st.video) { el.strip.hidden = true; el.empty.style.display = ""; return; }
    el.empty.style.display = "none";
    el.strip.hidden = false;

    const total = st.total;
    const bufF = Math.min(total, Math.max(L.winF, L.winF * BUF_MUL));
    const slack = bufF * 0.10;
    const stale = !buf || buf.key !== st.video || buf.cellW !== L.cellW ||
      L.start < buf.start + slack || L.start + L.winF > buf.end - slack;
    if (stale) {
      const g = Math.max(1, Math.round(L.cellF));
      let s = clamp(L.start - (bufF - L.winF) / 2, 0, Math.max(0, total - bufF));
      s = Math.min(Math.floor(s / g) * g, Math.max(0, total - bufF));
      const e = Math.min(total - 1, s + bufF - 1);
      const cols = clamp(Math.round(((e - s + 1) / Math.max(1, L.winF)) * L.cols), 3, 48);
      /* 请求宽度乘 DPR：不乘的话高分屏上每格只有 CSS 像素，胶片条发糊。
         上限与后端 _sprite 的 clamp 对齐（400）。buf.cellW 仍存 CSS 像素，
         它是「同一窗口宽度」的判定依据，不该随屏变化。 */
      const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
      const srcW = clamp(Math.round(L.cellW * dpr), 24, 400);
      const src = `${API}/sprite?video=${encodeURIComponent(st.video)}` +
        `&start=${Math.round(s)}&end=${Math.round(e)}&cols=${cols}&w=${srcW}&t=${stamp}`;
      buf = { start: s, end: e, cols, cellW: L.cellW, key: st.video, src };
      el.strip.src = src;
    }
    el.strip.style.left = `${(buf.start - L.start) * L.ppf}px`;
    el.strip.style.width = `${Math.max(1, buf.end - buf.start) * L.ppf}px`;
  }

  el.strip.onload = () => {
    if (drag && drag.mode === "scrub") showStripFrame(st.frame);
  };
  el.strip.onerror = () => {
    el.strip.hidden = true;
    el.empty.textContent = "胶片条抽帧失败（视频可能被占用或已删除）";
    el.empty.style.display = "";
  };

  /* ---------- 取景器（左卡大图）：同时在飞只留一张 ---------- */

  let pvBusy = false;
  let pvWant = -1;
  let pvHiWant = false;
  let pvShown = -1;
  let pvShownHi = false;

  function pumpPreview() {
    if (pvBusy) return;
    const f = pvWant;
    const hi = pvHiWant;
    pvBusy = true;
    const img = new Image();
    const settle = (ok) => {
      pvBusy = false;
      if (pvWant !== f || pvHiWant !== hi) { pumpPreview(); return; }
      if (ok) {
        el.pic.src = img.src;
        pvShown = f;
        pvShownHi = hi;
      }
    };
    img.onload = () => settle(true);
    img.onerror = () => settle(false);
    img.src = `${API}/preview?video=${encodeURIComponent(st.video)}` +
      `&frame=${f}&w=${hi ? 480 : 280}`;
  }

  function showFrame(f, hi) {
    if (!st.video) return;
    pvWant = f;
    pvHiWant = !!hi;
    if (!pvBusy && pvShown === f && pvShownHi === pvHiWant) return;
    pumpPreview();
  }

  /* 搓帧跟手：preview 单帧要 seek+解码（约 0.3~0.4 秒/张），逐帧请求必然滞后。
     拖动中直接把已下载的胶片条对应格子铺到左卡（纯本地、零延迟），松手才换
     高清 preview。返回 false 表示当前缓冲没覆盖该帧（窗口刚平移/缩放），由调用
     方退回低清网络帧。 */
  function showStripFrame(f) {
    if (!buf || !buf.src || el.strip.hidden ||
        !el.strip.complete || !el.strip.naturalWidth) return false;
    if (f < buf.start || f > buf.end) return false;
    const span = buf.end - buf.start;
    const k = Math.max(0, Math.min(buf.cols - 1,
      Math.round((f - buf.start) / span * (buf.cols - 1))));
    el.stripZoom.style.backgroundImage = `url("${buf.src}")`;
    el.stripZoom.style.backgroundSize = `${buf.cols * 100}% 100%`;
    el.stripZoom.style.backgroundPosition = `${k / (buf.cols - 1) * 100}% 0`;
    el.stripZoom.hidden = false;
    el.pic.hidden = true;
    el.srcCap.style.display = "none";
    el.srcFrame.classList.remove("dash");
    return true;
  }

  function hideStripFrame() {
    el.stripZoom.hidden = true;
    el.stripZoom.style.backgroundImage = "";
    // 高清帧到达前先顶着已加载的旧图，避免松手瞬间黑一下
    if (el.pic.src && pvShown >= 0) el.pic.hidden = false;
  }

  el.pic.onload = () => {
    el.pic.hidden = false;
    el.srcCap.textContent = "";
    el.srcFrame.classList.remove("dash");
  };

  /* ---------- 目标卡（右卡：媒体架当前参照图）---------- */

  /* 媒体架的真实状态在 node.gmr.st（活对象），rack_data 只是它的序列化镜像。
     以前只改镜像 → 面板不重绘，要刷新网页才看见（"替换后媒体架没出现素材"）。
     有 gmr 就直接用活对象，改完调 gmr.commit()：它会 snapshot 到 segs[cur]、
     写回 rack_data、重渲染面板、广播事件，一套全包。 */
  function rackData() {
    const rack = findNode(RACK_ID);
    if (!rack) return null;
    const g = rack.gmr;
    const w = rack.widgets?.find((x) => x.name === "rack_data");
    let data = null;
    if (g && g.st && g.st.slots) data = g.st;
    else if (w) { try { data = JSON.parse(w.value || "{}"); } catch (_) { data = {}; } }
    if (!data) return null;
    return { rw: { rack, w, g }, data, cur: data.cur || "" };
  }

  /* 收口：有 gmr 走「先渲染面板、再 commit」；没有才退回写镜像。
     ⚠ commit 不重绘图片网格（它只写镜像 + 画布重绘 + 广播），漏了 renderImages
     就是"改了数据、面板一格不动"。顺序固定：先渲后提交（commit 会把 st 写进
     widget，画面得先跟上）。 */
  function commitRack(rw, data) {
    if (!rw) return;
    if (rw.g && typeof rw.g.commit === "function") {
      try { rw.g.renderImages?.(); } catch (_) { /* 渲不动也不挡提交 */ }
      rw.g.commit();
      return;
    }
    if (rw.w) {
      rw.w.value = JSON.stringify(data || {});
      rw.w.callback?.(rw.w.value);
    }
    try { rebuildMediaRackUI(rw.rack); } catch (_) {}
    rw.rack?.setDirtyCanvas?.(true, true);
    try { emitRackChange({ node: rw.rack?.id, reason: "tailref" }); } catch (_) {}
  }

  function targetState(kind = "core") {
    const core = readCoreFrame(kind);
    if (core.error) return { err: core.error };
    const r = rackData();
    if (!r) return { err: "画布上没有 🗂️ H3 媒体架", core };

    if (core.missing) {
      /* 用户点过还原：这一路已经撤销，**不许**当成「还没建栏」去重建 ——
         那会把刚删掉的文案行和空栏位一起补回来，等于还原按钮没生效。
         栏号照样留着，点回「开场构图」标签时按原栏号重新启用，不新占一格。 */
      if (kind === "open" && st.tg.open.revoked) {
        return { idle: true, core, rw: r.rw, data: r.data };
      }
      const g = st.tg.open;
      /* 行不见了（被冲掉 / 用户删了）但这一路建过栏：用建栏时记下的栏号继续。
         定位不能绑在一行文案上 —— 行是会丢的，栏不会。noLine 只用来提示
         "模型看不到这张图"。 */
      const slot = g.index > 0 ? r.data.slots?.images?.[g.index - 1] : null;
      if (slot) {
        return { core: { ...core, index: g.index, alias: g.alias || "开场构图参考", noLine: true },
                 slot, rw: r.rw, data: r.data };
      }
      return { need: true, core, rw: r.rw, data: r.data };
    }
    return { core, slot: r.data.slots?.images?.[core.index - 1], rw: r.rw, data: r.data };
  }

  /* ---------- 开场构图：自动建一栏 + 自动写一行文案 ---------- */

  /* 插到核心帧那一行下面；找不到核心帧行就插到段落开头。
     排版跟核心帧行完全一致：列表前缀（"- " / "1. " / 缩进）和句末标点都照抄 ——
     否则插进去的那一行在整段里一眼就是外来的。 */
  function insertOpenLine(text, n) {
    const lines = String(text || "").split(/\r?\n/);
    const at = lines.findIndex((l) => /@图片\s*\d+/.test(l) &&
      /(?:空间关系)?参[考照]图|核心帧|参考帧/.test(l));
    const anchor = at >= 0 ? lines[at] : "";
    const prefix = (anchor.match(/^(\s*(?:[-*•]|\d+[.)])\s+)/) || ["", ""])[1];
    const dot = /[。.]\s*$/.test(anchor) ? "。" : "";
    const line = prefix + openLine(n) + dot;
    if (at >= 0) lines.splice(at + 1, 0, line);
    else lines.unshift(line);
    return lines.join("\n");
  }

  /* 撤掉本节点自动插进去的那一行（还原 = 整路撤销）。
     只认 OPEN_HINTS 这一族措辞 —— 只有本节点会写这几句，用户自己的参照图行
     不会命中。编号不校验：用户可能手改过编号，那时行里已不是栏号，但留着
     同样是「提示词说有参考图、模型拿到空槽」的假声明，一并删掉。 */
  function removeOpenLine(text) {
    const lines = String(text || "").split(/\r?\n/);
    const at = lines.findIndex((l) => OPEN_HINTS.some((h) => l.includes(h)));
    if (at < 0) return null;
    lines.splice(at, 1);
    return lines.join("\n");
  }

  /* 新栏不一定在图区可见范围内（几十个空槽之后），滚到它那一格去 ——
     否则用户以为没建。拿不到 DOM 就算了，数据是真的写进去了。 */
  function scrollRackTo(rack, index) {
    try {
      const rootEl = (rack.widgets || []).map((w) => w.element).find(Boolean);
      const cells = rootEl && rootEl.querySelectorAll(".gcast-slot");
      const cell = cells && cells[Math.max(0, index - 1)];
      if (cell && cell.scrollIntoView) cell.scrollIntoView({ block: "nearest" });
    } catch (_) { /* 滚不动就算了，栏是真的加了 */ }
  }

  /* 写文案：三处都得写，少一处就会被另一处盖掉。
     ① desk_data（存档 / 运行 / 刷新后恢复都读它）
     ② 编辑框（文案台内部 st.segs 是闭包状态，只改 widget 它看不见；
        而且下一次收口 switchSeg 会拿编辑框里的旧文本反盖回来）
     ③ 中央档案（文案台每次做「段词对账」，本地 vs 中央，不推中央就被旧词盖回）
     编辑框此刻显示的不是目标段就不动它，否则这一行会落到别的段里。 */
  function writeDeskSeg(key, text) {
    const desk = findNode(DESK_ID);
    const w = desk?.widgets?.find((x) => x.name === "desk_data");
    if (!w || !key) return false;
    let d = {};
    try { d = JSON.parse(w.value || "{}"); } catch (_) { d = {}; }
    if (!d.segs || typeof d.segs !== "object") d.segs = {};
    d.segs[key] = text;
    w.value = JSON.stringify(d);
    w.callback?.(w.value);
    desk.setDirtyCanvas?.(true, true);

    const shown = d.chain?.clip || d.chain?.shot || "";
    const edDom = desk.deskUI?.root?.querySelector?.(".gcast-ed.d-seg");
    if (edDom && (!shown || shown === key)) {
      edDom.textContent = text;
      try { edDom.dispatchEvent(new InputEvent("input", { bubbles: true })); }
      catch (_) { edDom.dispatchEvent(new Event("input", { bubbles: true })); }
    }

    /* ③ 中央：必须推。文案台每次都做「段词对账」（本地 vs 中央），只改本地的话，
       下一次对账就拿中央的旧词把这一行盖回去 —— 表现正是"媒体架有图、文案台没变"。
       pushSegText 是文案台自己用的那条通道（onSegChange 里就是调它）。 */
    const name = (castProject(desk)?.name) || d.chain?.name || "";
    pushSegText(name, key, text, { retryOnConflict: true }).then((r) => {
      /* [单一真值] conflict 是"一个字都没写进去"，**必须**当未落库处理 —— 它长得像
         "有回包"，一不留神就会被当成成功，然后去 refresh 触发对账把这句盖回去。 */
      const ok = !!(r && !r.conflict);
      console.log("[H3 参照图替换] 写入文案：段=%s 中央=%s（片名=%s 编辑框=%s）",
                  key, ok ? "已更新" : (r ? "版本冲突，未落库" : "未落库"),
                  name || "(无)", !!edDom);
      /* 只有真落库才让文案台重载。refresh 内部会跑「段词对账」——
         未落库时中央还是旧词，对账会把刚写进去的这句**盖回去**
         （表现就是"删掉的那行又冒出来"）。落库成功则对账读到新词，重载安全。
         未落库也没关系：desk_data 与编辑框已经写了，input 事件驱动文案台自更新。 */
      if (ok) { try { desk.deskUI?.refresh?.(); } catch (_) { /* 重渲染失败不影响文本正确 */ } }
    }).catch(() => {});
    return true;
  }

  /* 已有那一行的排版跟核心帧行对齐（补「- 」前缀 / 句号）。
     旧版写进去的是光秃秃一句，混在列表里很显眼。返回新文本，没变化返回 null。 */
  function fixOpenLine(text, index) {
    const lines = String(text || "").split(/\r?\n/);
    const at = lines.findIndex((l) => /@图片\s*\d+/.test(l) &&
      OPEN_HINTS.some((h) => l.includes(h)));
    if (at < 0) return null;                       // 没有这一行，交给 insertOpenLine
    const coreAt = lines.findIndex((l) => /@图片\s*\d+/.test(l) &&
      /(?:空间关系)?参[考照]图|核心帧|参考帧/.test(l));
    const anchor = coreAt >= 0 ? lines[coreAt] : "";
    const prefix = (anchor.match(/^(\s*(?:[-*•]|\d+[.)])\s+)/) || ["", ""])[1];
    const dot = /[。.]\s*$/.test(anchor) ? "。" : "";
    /* 编号以行里写的为准：用户手改过编号就跟他的，不硬换成栏号 */
    const m = lines[at].match(/@图片\s*(\d+)/);
    const want = prefix + openLine(m ? Number(m[1]) : index) + dot;
    if (lines[at].trim() === want.trim()) return null;
    lines[at] = want;
    return lines.join("\n");
  }

  /* 栏已经建过、但文案里那一行不在（被冲掉 / 用户删了）：补写一次。
     认得到就不动 —— 这条只是补历史遗留，不是每次重绘都写。 */
  function ensureOpenLine(segKey, index) {
    const desk = findNode(DESK_ID);
    const w = desk?.widgets?.find((x) => x.name === "desk_data");
    if (!w || !segKey || !(index > 0)) return false;
    let d = {};
    try { d = JSON.parse(w.value || "{}"); } catch (_) { return false; }
    const cur = String((d.segs || {})[segKey] || "");
    const fixed = fixOpenLine(cur, index);
    if (fixed !== null) return writeDeskSeg(segKey, fixed);
    if (coreRef(cur, OPEN_HINTS, true)) return true;   // 其实还在，不用补
    return writeDeskSeg(segKey, insertOpenLine(cur, index));
  }

  /* 行在、但排版不统一时就地改正；用户正在编辑框里打字时不动，免得抢输入。 */
  function polishOpenLine(segKey, index) {
    const desk = findNode(DESK_ID);
    const w = desk?.widgets?.find((x) => x.name === "desk_data");
    if (!w || !segKey) return;
    const edDom = desk.deskUI?.root?.querySelector?.(".gcast-ed.d-seg");
    if (edDom && document.activeElement === edDom) return;
    let d = {};
    try { d = JSON.parse(w.value || "{}"); } catch (_) { return; }
    const fixed = fixOpenLine(String((d.segs || {})[segKey] || ""), index);
    if (fixed !== null) writeDeskSeg(segKey, fixed);
  }

  /* 媒体架末尾追加一空栏（与手动「＋ 添加」同一写法 push({})），把栏号写进
     文案。栏号 = 追加后的长度，永不写死 —— 写死必然跟别的参照图撞车。 */
  function createOpenSlot() {
    const t = targetState("open");
    if (t.err) return t.err;
    if (!t.need) return "";
    const images = t.data.slots?.images;
    if (!Array.isArray(images)) return "媒体架没有图片槽位";
    if (images.length >= MAX_SLOTS) return `图片槽位已达上限 ${MAX_SLOTS} 个，先清理再建`;

    /* 优先复用第一个空槽：架子里往往堆着一串没用过的空位（实测有 49 个槽、
       最后一格有图的才 33），继续往后追加会让新栏飘到第 50 格，
       用户既找不到、看着也像跳号。 */
    let idx = images.findIndex((s) => !s || !s.file);
    const added = idx < 0;
    if (added) { images.push({}); idx = images.length - 1; }
    /* 先把栏号记进这一路：文案行万一没留住，替换/还原照样找得到这一栏 */
    st.tg.open.index = idx + 1;
    st.tg.open.alias = "开场构图参考";
    const n = idx + 1;   // 段快照由 commit 自己 snapshot，不用手工双写

    const desk = findNode(DESK_ID);
    const dw = desk?.widgets?.find((x) => x.name === "desk_data");
    let d = {};
    try { d = JSON.parse(dw?.value || "{}"); } catch (_) { d = {}; }
    const okDesk = writeDeskSeg(t.core.segKey,
      insertOpenLine((d.segs || {})[t.core.segKey] || "", n));

    /* 建完必须立刻能认到，否则这次不算数：把栏撤回去。
       不撤的话「认不到」会在每次重绘时被当成「还没建」，一栏一栏往上堆。 */
    const again = targetState("open");
    if (!okDesk || again.err || again.need) {
      if (added) images.pop();        // 复用来的空槽没被改动，不用复原
      st.tg.open.index = 0;          // 栏都撤了，栏号也作废
      st.tg.open.alias = "";
      openFailed = true;
      return !okDesk ? "写不进文案台，已撤回（先在文案台选中明确的段）"
                     : "建栏后仍认不到开场构图行，已撤回";
    }
    openFailed = false;

    commitRack(t.rw, t.data);
    scrollRackTo(t.rw.rack, n);
    return "";
  }

  /* 返回 true 表示目标栏位可替换。右卡是"替换前防呆"的全部依据：
     没文案台 / 没参照图行 / 栏位不存在 / 文件读不到 / 替换记录属于别的段，
     都在按下按钮之前直接摆在脸上。空栏位是**可写**的（源帧直接落进去）。 */
  function paintTarget() {
    el.tgtPic.hidden = true;
    el.tgtFrame.classList.remove("bz-err");
    el.badge.classList.remove("hot");
    tgtWired = false;
    tgtNoLine = false;
    let t = targetState(st.cur);

    /* 已撤销（点过还原）：行和栏都撤了，绝不在这里自动重建 —— 一重建就等于
       把刚删的文案行补回去。重新启用只有一个入口：点一下「开场构图」标签。 */
    if (t.idle) {
      el.tgt.textContent = "未启用";
      el.tgtFrame.classList.add("dash");
      el.tgtCap.textContent = "已撤销 · 点上方「开场构图」标签重新启用";
      el.tgtName.textContent = "—";
      el.badge.style.display = "none";
      return false;
    }

    /* 开场构图这一路还没建栏：就地备好（媒体架加一栏 + 文案插一行），再认一次。
       建栏会改文案台，可能反过来触发本面板重绘 —— creating 挡住递归；
       失败过就到此为止，不跟着每次重绘反复尝试。 */
    if (t.need && (creating || openFailed)) {
      el.tgt.textContent = "未建栏";
      el.tgtFrame.classList.add("dash");
      el.tgtCap.textContent = openFailed
        ? "开场构图栏没建成，在文案台选中明确的段后再点一次「开场构图」" : "";
      el.tgtName.textContent = "—";
      el.badge.style.display = "none";
      return false;
    }
    if (t.need && !creating) {
      creating = true;
      const err = createOpenSlot();
      creating = false;
      if (err) {
        el.tgt.textContent = "建栏失败";
        el.tgtFrame.classList.add("dash", "bz-err");
        el.tgtCap.textContent = err;
        el.tgtName.textContent = "—";
        el.badge.style.display = "none";
        return false;
      }
      t = targetState(st.cur);
      if (t.err || t.need) {
        el.tgt.textContent = "未识别";
        el.tgtFrame.classList.add("dash");
        el.tgtCap.textContent = t.err || "建栏后仍认不到开场构图行，手动加一行试试";
        el.tgtName.textContent = "—";
        el.badge.style.display = "none";
        return false;
      }
    } else if (t.need) {
      return false;                 // 重绘递归里二次进来，交给外层那次处理
    }

    if (t.err) {
      el.tgt.textContent = "未识别";
      el.tgtFrame.classList.add("dash");
      el.tgtCap.textContent = t.err;
      el.tgtName.textContent = "—";
      el.badge.style.display = "none";
      return false;
    }

    /* 栏在、文案行没了（历史遗留）：补一次。用 段+栏 做去重键，
       同一处只补一次 —— 补不上就停，不跟着重绘反复改文案。 */
    if (t.core.noLine) {
      const k = `${t.core.segKey}:${t.core.index}`;
      if (lineFixKey !== k) {
        lineFixKey = k;
        ensureOpenLine(t.core.segKey, t.core.index);
        const t2 = targetState(st.cur);
        if (!t2.err && !t2.need) t = t2;
      }
    } else {
      /* 行在，但旧版写进去的没有「- 」前缀 / 句号：改正一次 */
      const k = `p:${t.core.segKey}:${t.core.index}`;
      if (lineFixKey !== k) {
        lineFixKey = k;
        polishOpenLine(t.core.segKey, t.core.index);
      }
    }

    el.tgt.textContent = `@图片${t.core.index}${t.core.alias ? " " + t.core.alias : ""}`;
    el.badge.style.display = "";
    const segTag = t.core.current === false ? "（来自别段）" : "";

    /* 栏位不存在 = 没有对象可写，仍然禁掉。
       栏位存在但没有文件 = 空栏：直接写源帧就行。旧版在这里禁掉，用户还得
       先去媒体架随便塞一张图才能用 —— 那一步没有任何意义。 */
    if (!t.slot) {
      el.tgtFrame.classList.add("dash");
      el.tgtPic.hidden = true;
      el.tgtName.textContent = "无此栏位";
      el.badge.textContent = "缺";
      el.badge.classList.remove("hot");
      el.tgtCap.textContent = `媒体架没有第 ${t.core.index} 栏`;
      return false;
    }
    if (!t.slot.file) {
      el.tgtFrame.classList.add("dash");
      el.tgtPic.hidden = true;
      el.tgtPic.removeAttribute("src");
      tgtShown = "";
      tgtLoaded = false;
      tgtWired = !!t.slot.wired;   // 端口空值也是接线状态，替换照样会被盖
      el.tgtName.textContent = (t.slot.alias || "空栏位") + segTag;
      el.badge.textContent = tgtWired ? "端口" : "空";
      el.badge.classList.toggle("hot", tgtWired);
      el.tgtCap.textContent = "空栏位 · 可直接写入源帧";
      return true;
    }

    el.tgtFrame.classList.remove("dash");
    el.tgtCap.textContent = "";
    tgtWired = !!t.slot.wired;
    tgtNoLine = !!t.core.noLine;
    el.tgtName.textContent = (t.slot.alias || shortName(t.slot.file)) + segTag +
      (tgtWired ? " · 端口覆盖" : "");
    const file = t.slot.file;
    if (tgtShown !== file) {
      tgtShown = file;
      tgtLoaded = false;
      el.tgtPic.src = viewURL(file, THUMB_SIZE);
    } else if (tgtLoaded) {
      el.tgtPic.hidden = false;   // 重绘时别把已加载的图藏掉
    }
    /* 端口优先于"已替换"：这栏就算刚换过，下次同步也会被端口值盖回去，
       角标必须一直提醒，不能因为一次成功就变回"已替换"。 */
    if (tgtWired) {
      el.badge.textContent = "端口";
      el.badge.classList.add("hot");
    } else if (tg().replaced) {
      el.badge.textContent = "已替换";
      el.badge.classList.add("hot");
    } else {
      el.badge.textContent = "当前";
    }
    return true;
  }

  el.tgtPic.onload = () => {
    tgtLoaded = true;
    el.tgtPic.hidden = false;
    el.tgtCap.textContent = "";
    el.tgtFrame.classList.remove("dash", "bz-err");
  };
  el.tgtPic.onerror = () => {
    tgtShown = "";
    tgtLoaded = false;
    el.tgtPic.hidden = true;
    el.tgtFrame.classList.add("dash", "bz-err");
    el.tgtCap.textContent = "目标文件读不到";
  };

  /* 媒体架一 commit 就广播（换新文件/切段/排序），右卡跟着刷新；
     本节点卸载时解绑，不留窗口监听。 */
  const offRack = onRackChange(() => { tgtShown = ""; paintTarget(); });

  /* ---------- 绘制 ---------- */

  function paintPlay(L) {
    if (!st.video || st.total < 2 || st.frame < 0) { el.play.style.display = "none"; return; }
    const x = frameToX(st.frame, L);
    if (x < -1 || x > L.view + 1) { el.play.style.display = "none"; return; }
    el.play.style.display = "block";
    el.play.style.left = `${x}px`;
  }

  function paintZoom() {
    el.zoomTxt.textContent = zoom > 1.02
      ? `${zoom < 10 ? zoom.toFixed(1) : Math.round(zoom)}×` : "";
    el.tail.disabled = !(st.video && st.total > 1);
  }

  function renderMsg(text, cls) {
    el.msg.className = cls ? `bz-msg bz-${cls}` : "bz-msg";
    el.msg.textContent = text;
  }

  /* 异步操作（取片/替换/还原）的错误要活到下一次成功操作：withBusy 的
     finally 会重绘，错误必须在重绘后仍在，所以单独记 errMsg。 */
  function setMsg(text, cls) {
    errMsg = cls === "err" ? text : "";
    renderMsg(text, cls);
  }

  /* 一次性回执（4.5 秒）：跨段还原后眼前这一段毫无变化，不说一句像没生效 */
  function flashNote(text) {
    noteMsg = text;
    clearTimeout(noteTimer);
    noteTimer = setTimeout(() => { noteMsg = ""; paint(); }, 4500);
    renderMsg(text, "ok");
  }

  /* ---------- 切换目标路 ---------- */

  /* 两路各自记住自己选的帧：切走时存下时间轴当前帧，切回来时跳回去。
     时间轴只有一条，st.frame 是它的当前帧 —— 不按路分开存，切一次标签
     就把另一路选好的帧弄丢了。 */
  function setCur(kind) {
    const next = kind === "open" ? "open" : "core";
    /* 点标签 = 明确要这一路：撤销过的在这里重新启用（按建栏时记下的栏号，
       不新占一格）。必须放在下面那句早退**之前** —— 撤销后用户点的往往
       就是当前这个标签，早退掉就永远启用不回来。 */
    if (st.tg[next].revoked) {
      st.tg[next].revoked = false;
      /* 补行的去重键一起作废：撤销时删掉的那一行，重新启用必须能补回来，
         否则「栏在、行没了」会被去重键挡住，一直不补。 */
      lineFixKey = "";
      writeState(node, st);
      if (next === st.cur) { tgtShown = ""; paint(); return; }
    }
    if (next === st.cur) return;
    openFailed = false;          // 重新点标签 = 再给一次机会
    tg().frame = st.frame;
    st.cur = next;
    const g = tg();
    st.frame = (g.frame >= 0 && st.total > 1) ? Math.min(g.frame, st.total - 1)
      : (st.total > 1 ? st.total - 1 : -1);
    writeState(node, st);
    tgtShown = "";
    paint();
  }

  el.tabs.forEach((b) => { b.onclick = () => setCur(b.dataset.t); });

  function paint() {
    const has = !!st.video && st.total > 1;
    const g = tg();
    el.tabs.forEach((b) => b.classList.toggle("on", b.dataset.t === st.cur));
    el.meta.textContent = has
      ? `${shortName(st.video)} · ${st.total} 帧 · ${st.fps % 1 ? st.fps.toFixed(2) : st.fps.toFixed(0)}fps`
      : "等待取片…";
    el.navs.forEach((b) => { b.disabled = !has; });
    el.tail.disabled = !has;
    el.pick.disabled = busy;

    /* 左卡源帧状态 */
    el.fnum.textContent = has
      ? `第 ${st.frame} 帧 · ${timecode(st.frame / st.fps)} / ${timecode((st.total - 1) / st.fps)}`
      : "—";
    el.tc.textContent = has ? `第 ${st.frame} / ${st.total - 1} 帧` : "";
    if (!has) {
      el.pic.hidden = true;
      el.srcFrame.classList.add("dash");
      el.srcCap.textContent = "取片后显示所选帧";
    }

    /* 右卡目标状态决定圆按钮能不能按 */
    const targetOk = paintTarget();

    /* 圆按钮：→ 替换 / ↩ 还原。已替换时不再要求"取过片"——还原跟源片无关，
       旧写法在刷新后没取片的人身上会变成"按钮点不动，也没有原因"。 */
    el.mid.disabled = busy || (!g.replaced && (!has || !targetOk));
    el.mid.classList.toggle("bz-on", !!g.replaced);
    el.mid.textContent = g.replaced ? "↩" : "→";
    const what = st.cur === "open" ? "开场帧" : "参照图";
    el.mid.title = g.replaced
      ? `还原${g.segName ? "「" + g.segName + "」" : ""}第 ${g.index} 栏原来的${what}`
      : !targetOk ? "目标栏位不可替换"
      : !has ? "先取片，再替换"
      : `用左卡源帧替换右侧${what}`;

    if (errMsg) {
      renderMsg(errMsg, "err");
    } else if (busy) {
      renderMsg("处理中…", "");
    } else if (noteMsg) {
      renderMsg(noteMsg, "ok");
    } else if (g.replaced) {
      renderMsg(`已替换第 ${g.index} 栏${g.alias ? "（" + g.alias + "）" : ""} → 第 ${g.frame} 帧，再点圆按钮还原`, "ok");
    } else if (!targetOk) {
      renderMsg(el.tgtCap.textContent || "目标栏位不可替换", "err");
    } else if (!has) {
      renderMsg("点右上「选取成片」，再点中间按钮替换", "");
    } else if (tgtNoLine) {
      renderMsg("文案里缺「开场构图参考」那一行 —— 模型看不到这张图，在文案台补一行即可", "err");
    } else if (tgtWired) {
      renderMsg("这一栏接了端口：替换后会被端口覆盖，拆线后才生效", "err");
    } else {
      renderMsg(`左选源帧（默认尾帧），点 → 替换 ${el.tgt.textContent}`, "");
    }

    const L = layout();
    if (!L) {
      el.play.style.display = "none";
      el.strip.hidden = true;
      el.empty.style.display = "";
      paintZoom();
      return;
    }
    ensureStrip(L);
    paintPlay(L);
    paintZoom();
    if (st.frame >= 0) {
      if (drag && drag.mode === "scrub") {
        if (!showStripFrame(st.frame)) showFrame(st.frame, false);
      } else {
        showFrame(st.frame, true);
      }
    }
  }

  async function withBusy(fn) {
    busy = true;
    el.pick.disabled = true;
    el.mid.disabled = true;
    try { await fn(); } finally { busy = false; paint(); }
  }

  /* ---------- 改帧 ---------- */

  /* 播放头走到窗口边上时把窗口推着走，不用松手去平移 */
  function follow(f, L) {
    if (L.winF >= st.total) return;
    const m = L.winF * 0.14;
    if (f < L.start + m) winStart = f - m;
    else if (f > L.start + L.winF - 1 - m) winStart = f - (L.winF - 1 - m);
  }

  function setFrame(v, opts) {
    if (!st.video || st.total < 2) return;
    const f = clamp(Math.round(Number(v) || 0), 0, st.total - 1);
    const before = layout();
    st.frame = f;
    tg().frame = f;      // 这一路选的帧跟着走：切走再切回来还是这一帧
    /* 拖动中只改内存，不写 widget：写 widget 会触发官方的 graph._version++ →
       changeTracker.checkState() 把整张工作流 clone(serialize()) 一遍做变更比对，
       拖动时每帧一次就是 CPU 大头（内存也跟着抖）。松手由 endDrag 统一落盘 ——
       真正需要存进工作流的就是松手那一次。 */
    if (!drag) writeState(node, st);
    if (before) follow(f, before);
    const L = layout();
    if (L) {
      if (!before || L.start !== before.start) { ensureStrip(L); }
      paintPlay(L);
      paintZoom();
    }
    el.fnum.textContent = `第 ${f} 帧 · ${timecode(f / st.fps)} / ${timecode((st.total - 1) / st.fps)}`;
    el.tc.textContent = `第 ${f} / ${st.total - 1} 帧`;
    if (drag && drag.mode === "scrub") {
      if (!showStripFrame(f)) showFrame(f, false);
    } else {
      showFrame(f, true);
    }
    if (opts?.bub) showBub(f);
  }

  function showBub(f) {
    const L = layout();
    if (!L) return;
    el.bub.style.display = "block";
    el.bub.style.left = `${clamp(frameToX(f, L), 30, Math.max(30, L.view - 30))}px`;
    el.bub.textContent = `${f} · ${timecode(f / st.fps)}`;
  }
  const hideBub = () => { el.bub.style.display = "none"; };

  /* ---------- 缩放 ---------- */

  /* 以指针下的那一帧为锚缩放：滚一下，正在看的画面不会跑掉 */
  function zoomAt(z, anchorX) {
    const L = layout();
    if (!L || st.total < 2) return;
    const x = clamp(anchorX == null ? L.view / 2 : anchorX, 0, L.view);
    const fAt = L.start + x / L.ppf;
    zoom = clamp(z, 1, maxZoom());
    const m = metrics(zoom, winStart);
    if (!m) return;
    winStart = clamp(fAt - x / m.ppf, 0, m.maxStart);
    paint();
  }

  el.view.addEventListener("wheel", (e) => {
    if (!st.video || st.total < 2) return;
    e.preventDefault();
    e.stopPropagation();
    zoomAt(zoom * (e.deltaY < 0 ? 1.22 : 1 / 1.22), ptrX(e));
  }, { passive: false });

  el.view.addEventListener("dblclick", () => {
    zoom = 1; winStart = 0; paint();
  });

  /* 面板盖在画布上会把滚轮吃掉：除时间轴之外，滚轮转发给画布，
     否则鼠标停在面板上就缩不了工作流。只转 wheel。 */
  const graphCanvas = () => app.canvas?.canvas || document.querySelector("canvas#graph-canvas");
  root.addEventListener("wheel", (e) => {
    if (e.target.closest(".bz-view")) return;
    const cv = graphCanvas();
    if (!cv) return;
    e.preventDefault();
    e.stopPropagation();
    cv.dispatchEvent(new WheelEvent("wheel", {
      deltaX: e.deltaX, deltaY: e.deltaY, deltaMode: e.deltaMode,
      clientX: e.clientX, clientY: e.clientY,
      ctrlKey: e.ctrlKey, shiftKey: e.shiftKey,
      bubbles: true, cancelable: true,
    }));
  }, { passive: false });

  /* ---------- 拖动：搓动 / 平移 ---------- */

  el.view.addEventListener("pointerdown", (e) => {
    if (!st.video || st.total < 2) return;
    const L = layout();
    if (!L) return;
    const pan = e.button === 1 || e.shiftKey;
    drag = { mode: pan ? "pan" : "scrub", x: ptrX(e), start: L.start };
    el.view.classList.add(pan ? "bz-panning" : "bz-live");
    try { el.view.setPointerCapture(e.pointerId); } catch (_) { /* 捕获不了也能拖 */ }
    if (!pan) setFrame(xToFrame(ptrX(e), L), { bub: true });
    e.preventDefault();
    e.stopPropagation();
  });

  el.view.addEventListener("pointermove", (e) => {
    if (!st.video || st.total < 2) return;
    const L = layout();
    if (!L) return;
    if (!drag) {
      showBub(xToFrame(ptrX(e), L));
      return;
    }
    if (drag.mode === "pan") {
      winStart = drag.start - (ptrX(e) - drag.x) / L.ppf;
      paint();
      return;
    }
    setFrame(xToFrame(ptrX(e), L), { bub: true });
  });

  function endDrag() {
    if (!drag) return;
    drag = null;
    el.view.classList.remove("bz-panning", "bz-live");
    hideBub();
    hideStripFrame();
    writeState(node, st);   // 拖动期间攒着的状态，松手这一次落进工作流
    paint();          // 松手补一张清晰的大图
  }
  el.view.addEventListener("pointerup", endDrag);
  el.view.addEventListener("pointercancel", endDrag);
  el.view.addEventListener("pointerleave", () => { if (!drag) hideBub(); });

  /* 键盘微调：← → 走 1 帧，Shift 走 10 帧 */
  el.view.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    if (!st.video || st.total < 2) return;
    setFrame(st.frame + (e.key === "ArrowLeft" ? -1 : 1) * (e.shiftKey ? 10 : 1), { bub: true });
    e.preventDefault();
    e.stopPropagation();
  });

  /* ---------- 按钮 ---------- */

  el.navs.forEach((b) => {
    b.onclick = () => setFrame(st.frame + Number(b.dataset.d), { bub: true });
  });
  el.tail.onclick = () => setFrame(st.total - 1, { bub: true });

  /* ---------- 取片：先选片，再取 ---------- */

  function relTime(sec) {
    const t = Number(sec || 0) * 1000;
    if (!t) return "";
    const d = new Date(t);
    const pad = (n) => String(n).padStart(2, "0");
    const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    return d.toDateString() === new Date().toDateString()
      ? hm : `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${hm}`;
  }

  async function loadVideo(video) {
    await withBusy(async () => {
      try {
        const r = await api.fetchApi(`${API}/info?video=${encodeURIComponent(video)}`);
        const info = await r.json();
        if (info?.error) { setMsg(info.error, "err"); return; }
        st.video = video;
        st.total = Number(info.frame_count || 0);
        st.fps = Number(info.fps || 24) || 24;
        st.w = Number(info.width || 0);
        st.h = Number(info.height || 0);
        st.frame = st.total - 1;   // 默认落在最后一帧：续接要的就是上一段的收尾画面
        /* 换片 = 换素材：两路各自记的帧号都作废，切标签时重新落在尾帧 */
        st.tg.core.frame = -1;
        st.tg.open.frame = -1;
        stamp = Date.now();
        zoom = 1;
        winStart = 0;
        buf = null;
        pvShown = -1;
        el.empty.textContent = "选一部成片后，在这里选帧";
        writeState(node, st);
        setMsg("已取片，默认选中尾帧", "");
      } catch (e) {
        setMsg(String(e?.message || e), "err");
      }
    });
  }

  /* 列出 output 最近的成片让用户挑 —— 之前写死 limit=1，想用上上段的成片
     只能重新生成一次。后端本来支持到 50，白放着。 */
  async function openPick() {
    if (!el.pickList.hidden) { el.pickList.hidden = true; return; }
    let list = [];
    try {
      const r = await api.fetchApi("/cglide/recent_outputs?limit=10&type=output");
      list = await r.json();
    } catch (e) { setMsg(String(e?.message || e), "err"); return; }
    if (!Array.isArray(list) || !list.length) {
      setMsg("output 目录里还没有成片", "err");
      return;
    }
    el.pickList.innerHTML = "";
    for (const one of list) {
      const video = one.subfolder ? `${one.subfolder}/${one.name}` : one.name;
      const row = document.createElement("div");
      row.className = "bz-pick-row" + (video === st.video ? " on" : "");
      const nm = document.createElement("span");
      nm.className = "bz-pick-nm";
      nm.textContent = one.name;
      nm.title = video;
      const tm = document.createElement("span");
      tm.className = "bz-pick-tm";
      tm.textContent = relTime(one.mtime);
      row.append(nm, tm);
      row.onclick = () => { el.pickList.hidden = true; loadVideo(video); };
      el.pickList.appendChild(row);
    }
    el.pickList.hidden = false;
  }

  el.pick.onclick = openPick;

  /* 点面板其它地方收起列表。用 capture：胶片条的 pointerdown 会
     stopPropagation，冒泡阶段收不到 */
  root.addEventListener("pointerdown", (e) => {
    if (el.pickList.hidden) return;
    if (e.target === el.pick || el.pickList.contains(e.target)) return;
    el.pickList.hidden = true;
  }, true);

  /* ---------- 替换 / 还原 ---------- */

  function flashTarget() {
    el.tgtFrame.classList.remove("bz-flash");
    void el.tgtFrame.offsetWidth;
    el.tgtFrame.classList.add("bz-flash");
  }

  el.mid.onclick = () => {
    if (busy) return;
    const g = tg();
    if (g.replaced) { withBusy(async () => restore()); return; }
    withBusy(async () => {
      const t = targetState(st.cur);
      if (t.err) { setMsg(t.err, "err"); return; }
      /* 已撤销：idle 分支没有 index，放过去就是「第 undefined 栏」那种报错。
         按钮此时是禁用的，这条只作兜底。 */
      if (t.idle) {
        setMsg("开场构图已撤销：点一下「开场构图」标签重新启用", "err");
        return;
      }
      /* need = 这一路还没建栏。必须在这里拦下：need 分支没有 index，
         放过去就会报成「媒体架第 undefined 栏不存在」。 */
      if (t.need) {
        setMsg("开场构图栏还没建好：先点一下「开场构图」标签让它建栏", "err");
        return;
      }
      if (!t.rw || !t.slot) { setMsg(`媒体架第 ${t.core.index} 栏不存在`, "err"); return; }
      g.index = t.core.index;
      g.alias = t.core.alias || "";
      g.frame = st.frame;          // 这一路用的就是时间轴上当前这帧
      st.name = t.core.name || st.name;
      /* 记下这次替换实际写进了哪一段（媒体架的当前段）。还原按它写回，
         与"还原时停在哪一段"无关。段名只用于回执 —— 文案台认到别段时，
         它给的名字不是被写那段的名字，退回用段 id。 */
      g.segWrite = t.data?.cur || "";
      g.segName = (t.core.current === false ? "" : (t.core.name || "")) || g.segWrite;

      let out;
      try {
        const r = await api.fetchApi(`${API}/grab`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          /* slot：落盘文件名带栏号。固定名会让同段第二张参照图覆盖第一张 */
          body: JSON.stringify({ video: st.video, frame: st.frame, name: st.name, slot: g.index }),
        });
        out = await r.json();
      } catch (e) { setMsg(String(e?.message || e), "err"); return; }
      if (!out || out.error) { setMsg(out?.error || "取帧失败", "err"); return; }

      /* 空栏位照写：hadOrig=false 让还原时把 file 清回空，而不是当"记录丢了" */
      g.origFile = t.slot.file || "";
      g.hadOrig = !!t.slot.file;
      t.slot.file = out.file;
      /* 接了端口的栏位：file 会被下一次同步盖回端口值。同时写 manualFile，
         用户之后拆线，落的是这次的尾帧，而不是更早那张手动图。 */
      const wired = !!t.slot.wired;
      if (wired) t.slot.manualFile = out.file;

      /* 只改活对象这一处：commit 负责 snapshot 到 segs[cur]、写镜像、重渲染面板、广播 */
      commitRack(t.rw, t.data);
      try { app.graph?.setDirtyCanvas?.(true, true); } catch (_) {}

      g.file = out.file;
      g.replaced = true;
      errMsg = "";
      writeState(node, st);
      tgtShown = "";
      paintTarget();
      flashTarget();
      if (wired) flashNote("已替换，但这栏接了端口 —— 同步后会被覆盖，拆线才生效");
      console.log("[H3 参照图替换] %s 路 第 %d 栏（%s）→ %s（第 %d 帧）",
                  st.cur, g.index, g.alias || "无别名", out.file, st.frame);
    });
  };

  async function restore() {
    const g = tg();
    /* 还原只认记录：栏号在 g.index、段在 g.segWrite，都跟"当前停在哪一段"无关，
       跨段也能还原。关键是**写回记录那一段**，不写眼前这一段 ——
       slots 是当前段的视图，跨段时改它只会让用户眼前的段凭空变色。 */
    const r = rackData();
    if (!r) { setMsg("画布上没有 🗂️ H3 媒体架", "err"); return; }
    /* 诊断：还原没反应时，先看这一行（路/是否已替换/栏号/原文件/段） */
    console.log("[H3 参照图替换] 还原请求：路=%s 已替换=%s 第 %d 栏 原=%s 段=%s",
                st.cur, g.replaced, g.index, g.origFile || "(空)", g.segWrite || "(无)");

    const i = g.index - 1;
    const slot = r.data?.slots?.images?.[i];
    const segKey = g.segWrite || r.cur;
    const segSlot = segKey ? r.data?.segs?.[segKey]?.slots?.images?.[i] : null;
    if (!slot && !segSlot) {
      setMsg(`第 ${g.index} 栏已不存在，还原不了`, "err");
      return;
    }

    /* hadOrig=false 表示原来就是空栏：还原＝清空，不是"记录丢了" */
    const hadOrig = g.hadOrig !== false;
    if (hadOrig && !g.origFile) {
      setMsg("原文件记录丢了，只能手动在媒体架改回来", "err");
      return;
    }
    const orig = hadOrig ? g.origFile : "";

    const same = !segKey || !r.cur || segKey === r.cur;
    if (same) {
      /* 同段：只改活槽位，段快照交给 commit 自己同步 */
      if (slot) {
        slot.file = orig;
        if (slot.wired) slot.manualFile = orig;   // 拆线后别再冒出换之前那张图
      }
    } else {
      /* 跨段：改那一段的记忆，不碰当前架面（否则眼前这段会跟着变色） */
      const tgt = segSlot || slot;
      if (tgt) {
        tgt.file = orig;
        if (tgt.wired) tgt.manualFile = orig;
      }
    }

    commitRack(r.rw, r.data);
    /* 跨段还原改的是「记录那一段」的架面记忆，而 commit 的落库只认当前段
       （媒体架把 ui.commit 包了一层 → scheduleRackSave(ui.st.cur)）。不补这一句，
       内存里对、工程库里还是旧的：刷新页面又把尾帧图拉回来。 */
    if (!same) { try { r.rw.g?.saveSegRack?.(segKey); } catch (_) { /* 落库失败不挡还原 */ } }

    /* 开场构图这一路的文案行是本节点自己插的：那一栏还原成空之后，这行就成了
       指向空槽的假声明（提示词说有参考图，模型实际拿到空）——必须一起撤掉。
       只撤 open 路、且那一栏原本就是空的（hadOrig=false，这栏是本节点建的）；
       原来真有图的（hadOrig=true）保留该行：那行声明的是一张真图。
       revoked 交给 targetState 挡住「没行就自动建栏」的自我修复。 */
    let revokedLine = false;
    if (st.cur === "open" && !hadOrig) {
      const desk = findNode(DESK_ID);
      const dw = desk?.widgets?.find((x) => x.name === "desk_data");
      const segText = (seg) => {
        try { return String((JSON.parse(dw?.value || "{}").segs || {})[seg] || ""); }
        catch (_) { return ""; }
      };
      /* 行在哪个段就以哪个段为准：替换写进的是 segWrite，但用户可能已经把
         文案台切到别的段 —— 两个都试，删成的那个算数。 */
      const cands = [segKey, readCoreFrame("open")?.segKey].filter(Boolean);
      const hit = cands.find((seg) => removeOpenLine(segText(seg)) !== null);
      if (hit) revokedLine = writeDeskSeg(hit, removeOpenLine(segText(hit)));
      /* 有行却删不掉（文案台写不进去）就不标 revoked：否则面板说「已撤销」、
         文案台里那行还在，两处说法打架。本来就没有行 = 撤销是干净的空状态。 */
      if (revokedLine || !hit) {
        st.tg.open.revoked = true;
        lineFixKey = "";
      }
    }

    /* 只重建面板不够：节点缩略图/画布缓存停在旧画面，看上去像没还原。
       画布全量重绘一次（图元多也就一帧）。 */
    try { app.graph?.setDirtyCanvas?.(true, true); } catch (_) {}
    try { emitRackChange({ node: r.rw.rack.id, reason: "tailref-restore" }); } catch (_) {}
    console.log("[H3 参照图替换] 还原 %s 路 第 %d 栏：%s → %s（段 %s）",
                st.cur, g.index, g.origFile || "(空)", orig || "(空)", segKey || "(无)");

    const where = same ? `第 ${g.index} 栏`
      : `「${g.segName || segKey || "原段"}」第 ${g.index} 栏`;
    g.replaced = false;
    g.origFile = "";
    g.hadOrig = false;
    g.segWrite = "";
    g.segName = "";
    errMsg = "";
    writeState(node, st);
    tgtShown = "";
    paintTarget();
    const tail = same ? "" : "（不在这一段，切回去才看得见）";
    const gone = revokedLine ? " · 开场构图行已一并撤掉" : "";
    flashNote(`已还原${where}${tail}${gone}`);
    console.log("[H3 参照图替换] 已还原%s%s", where, revokedLine ? "（含文案行）" : "");
  }

  /* ---------- 尺寸变化 ---------- */

  /* 量「内容自然高度」，不是「盒子当前高度」。
     .bzt 是 height:100% 的盒子，直接读 scrollHeight 读到的是盒子自己的高度：
     内容比盒子矮时也一样高，于是永远量不出富余，节点就被锁在初值 300px 上，
     底部留一大块空白（内容比盒子高时同理，量不出裁切）。量之前把高度放开成
     auto，量完同一帧内恢复，不产生可见闪动。 */
  const measure = () => {
    const prev = root.style.height;
    root.style.height = "auto";
    const h = root.scrollHeight;
    root.style.height = prev;
    if (h > 40) measured = h;
  };

  /* 高度贴合：面板「可见高」＝.dom-widget 容器给的高度，「内容自然高」＝高度放开
     成 auto 后的 scrollHeight。两者差多少就把节点加/减多少 —— 容器高与节点高是
     1:1 线性关系（官方弹性分支把剩余空间全给本面板），所以一次就能收敛。
     不猜标题栏/槽位/margin 任何常数：DOM widget 的边距是官方按 margin=10 扣的，
     硬写常数一改版就错。差值法自己会纠偏。
     什么时候才动节点：
       · 内容被裁切（natural > visible）→ 必须撑高，否则看不全；
       · 内容自然高变了（换片/文案变了）→ 重新贴合；
       · force（建节点/载入工程）→ 无条件收一次，把老工程存的高节点收回来。
     用户自己拖底边改过高度 → 不动他（这是「内容没变、只是尺寸变了」的情况）。 */
  let lastFitH = 0;
  const fit = (force = false) => {
    // 搓帧/平移进行中不动节点：面板一动，指针下的画面就跳，预览跟不住
    if (drag) return;
    if (app.canvas?.resizing_node === node) return;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const prev = root.style.height;
      root.style.height = "auto";
      const natural = root.scrollHeight;
      root.style.height = prev;
      const visible = root.clientHeight;
      if (!natural || !visible) return;
      const clipped = natural > visible + 1;
      const contentChanged = natural !== lastFitH;
      if (!force && !clipped && !contentChanged) return;
      lastFitH = natural;
      const diff = natural - visible;
      if (Math.abs(diff) > 1) {
        const sz = node.size;
        node.setSize?.([sz[0], Math.max(160, sz[1] + diff)]);
        // 只有真改了尺寸才全量重绘：重绘会让 Vue 重排 DOM 容器 → 触发
        // ResizeObserver → 再重绘，无条件重绘会变成刷屏循环（搓帧直接卡住）
        node.setDirtyCanvas?.(true, true);
      }
    }));
  };

  let raf = 0;
  const ro = new ResizeObserver(() => {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      measure();
      const L = layout();
      if (buf && L && buf.cellW !== L.cellW) buf = null;
      if (L) { ensureStrip(L); paintPlay(L); paintZoom(); }
      // 宽度/内容变化后让官方重新分摊高度（v2 不发 onResize 的路径也要走）。
      // 这里不做全量重绘：重绘会让 Vue 重排 DOM 容器 → 再次触发 ResizeObserver，
      // 无条件重绘会变成刷屏循环，搓帧直接卡住（源帧窗口没有实时预览）。
      node.onResize?.(node.size);
      fit();
    });
  });
  ro.observe(el.view);
  ro.observe(root);

  const prevRemoved = node.onRemoved;
  node.onRemoved = function () {
    offRack();
    ro.disconnect();
    cancelAnimationFrame(raf);
    clearTimeout(noteTimer);
    return prevRemoved?.apply(this, arguments);
  };

  function refresh() {
    st = readState(node);
    buf = null;
    tgtShown = "";
    errMsg = "";
    noteMsg = "";
    clearTimeout(noteTimer);
    hideStripFrame();
    el.pic.hidden = true;
    paint();
    requestAnimationFrame(measure);
  }

  // 挂载那一刻 clientWidth 还是 0，量不出轨道宽度，等一帧再画
  requestAnimationFrame(() => { paint(); requestAnimationFrame(measure); });

  return { root, minH: () => measured || FALLBACK_H, measure, refresh, fit };
}

/* ------------------------------------------------------------ register */

function hideState(node) {
  const w = node.widgets?.find((x) => x.name === "tail_state");
  if (!w) return;
  // v2 下隐藏 widget 必须双通道：旧 litegraph 看 hidden/computeSize，
  // v2 看 computeLayoutSize；只报旧通道，textarea 仍按 ~450px 占位
  w.hidden = true;
  w.options = Object.assign({}, w.options, { hidden: true });
  w.computeSize = () => [0, -4];
  w.computeLayoutSize = () => ({ minHeight: 0, maxHeight: 0, minWidth: 0 });
  w.draw = () => {};
  w.mouse = () => {};
  if (w.element) {
    Object.assign(w.element.style, {
      display: "none", visibility: "hidden", pointerEvents: "none",
      position: "absolute", left: "-99999px", top: "0",
      width: "0px", height: "0px", opacity: "0", zIndex: "-1",
    });
    w.element.hidden = true;
    w.element.tabIndex = -1;
  }
}

app.registerExtension({
  name: "Banzhang.CSGlideTailRef",

  beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== NODE_ID) return;

    const onCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = onCreated?.apply(this, arguments);

      // tail_state 只作状态载体：面板有按钮，用户不该看见这串 JSON
      hideState(this);

      if (!this.properties?.bzt) {
        const w = this.widgets?.find((x) => x.name === "tail_state");
        if (w?.value) {
          try { this.properties = { ...(this.properties || {}), bzt: JSON.parse(w.value) }; }
          catch (_) { /* 存过坏值就当没存 */ }
        }
      }

      const panel = buildPanel(this);
      this._bzt = panel;
      const dom = this.addDOMWidget("尾帧面板", "div", panel.root, {
        serialize: false,
        hideOnZoom: false,
      });
      /* 官方结算 widget 高度的两处（LGraphNode.computeSize 与 #arrangeWidgets）都是
         `if (widget.computeSize) → 定高分支`，只有**没有** computeSize 的 widget 才走
         computeLayoutSize 弹性分支：Vue 给 .dom-widget 容器的高度 = computedHeight，
         定高就恒等于内容高 → 节点再高面板也够不到底部（就是那块空白）；弹性分支才会
         把节点的富余高度分摊给面板。所以这里必须把 computeSize 置为假值。 */
      dom.computeSize = undefined;
      // 弹性分支契约：minHeight 报实测内容高（空间不足时官方自动撑高节点），
      // maxHeight/maxWidth 报 1e6 明确上限（不报 → 官方当 Infinity 用，语义不明），
      // minWidth 报 0（官方拖拽拿 computeSize() 当下限，报当前宽度会让节点一拖暴涨）。
      // 节点比内容高时，富余高度归本面板（面板跟到节点底边，不留断口）；
      // 多出来的那截由 fit() 用差值法收回去。
      dom.computeLayoutSize = () => ({ minHeight: panel.minH(), maxHeight: 1e6, minWidth: 0, maxWidth: 1e6 });

      // wrapper 透传关闭、根元素自己接管指针：DOM 面板能点起来的前提
      requestAnimationFrame(() => {
        const wrap = panel.root.parentElement;
        if (wrap && wrap.classList.contains("dom-widget")) wrap.style.pointerEvents = "none";
        panel.refresh();
      });

      // v2 给每个 widget 都包了一层全尺寸 .dom-widget：光藏 textarea 不够，
      // 它的包装层仍占位（底部一大块空白）还吞点击。只藏本节点其他 widget 的
      const hideStrayWrappers = () => {
        const mine = panel.root.closest(".dom-widget");
        for (const w of this.widgets || []) {
          if (!w || w === dom || !w.element) continue;
          const wrap = w.element.closest?.(".dom-widget");
          if (wrap && wrap !== mine) {
            wrap.style.display = "none";
            wrap.style.pointerEvents = "none";
          }
        }
      };
      requestAnimationFrame(hideStrayWrappers);
      setTimeout(hideStrayWrappers, 250);
      this._bztTidy = hideStrayWrappers;

      // 初值只给接近的固定高度，随后由 fit() 按「内容自然高 − 可见高」的差值收敛
      const w0 = Math.max(this.size?.[0] || 0, MIN_WIDTH);
      this.setSize?.([w0, 300]);
      this.setDirtyCanvas?.(true, true);
      this._bztFit = panel.fit;
      requestAnimationFrame(() => panel.fit(true));
      return r;
    };

    const onConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function (info) {
      const r = onConfigure?.apply(this, arguments);
      try {
        hideState(this);
        const saved = info?.widgets_values;
        if (!this.properties?.bzt && Array.isArray(saved) && saved[0]) {
          try { this.properties = { ...(this.properties || {}), bzt: JSON.parse(saved[0]) }; }
          catch (_) { /* 同上 */ }
        }
        requestAnimationFrame(() => {
          hideState(this);
          this._bztTidy?.();
          this._bzt?.refresh();
          // 载入老工程：节点可能存着远高于内容的旧高度，这里按差值收回来
          this._bztFit?.(true);
        });
      } catch (_) { /* 恢复不了就按空状态跑，不挡加载 */ }
      return r;
    };
  },
});
