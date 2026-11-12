/* ============================================================
 * H3 媒体架 — 「本段文案引用了哪几格」
 * ------------------------------------------------------------
 * 架上每一格的**视觉状态**是二元的，用户要的就是这个：
 *   · 这一段文案**引用了它** → 正常显示（相对就是"亮"的）；
 *   · 这一段文案**没写它**   → 置灰（降饱和 + 虚线边）。
 * 摆了 28 张、文案实际用了 6 张，一眼就能看出哪几张真的在被用 —— 这是媒体架
 * 上最有价值的一眼信息，缺了它只能拿眼睛把文案里的 @图片N 一个个数出来。
 *
 * 这个状态原来就有，坏的只是**判据**：它按「槽号 ≥ 9」判，而上限算的是
 * **被引用的个数**（后端 `keep = sorted(idxs)[:cap]`，第 15 格被 @图片15 引用
 * 时照样送得出去），于是 10 格以后全被冤枉成"不进提示词"。
 * 机制与视觉原样保留，判据换成"本段文案有没有写它"。

 * 判据只有一条：**本段文案里显式写了 @图片N / @视频N / @音频N**。
 * 不做启发式、不猜语法：
 *   · 引用是位置寻址（@图片N = 第 N 格），写了就是用了，没写就是没用；
 *   · 名字（别名）在文案里出现时，展开成编号是**后端**的事，本文件不参与 ——
 *     那一步依赖别名开关，前端再算一遍只会和真送出去的对不上。回执那边
 *     算的是展开后的文本（bz_prompt_build 的 resolveWords），用途不同。
 *
 * 文案来源与「按提示词排序」按钮同一条路（片子级 + 本段，composedWords）：
 * 两条路读同一份文本，"点排序给的理由"和"这里的亮/灰"就不会互相打脸。
 * 段身份取**本架自己的 cur**（切段广播带来的 cid），为空才退回文案台的
 * chain.clip —— 亮/灰画在架面第几格上，读的就得是这一段的词。
 * ============================================================ */
import {
  castProject, deskNodeOf, deskNodes, onCastChange, onDeskChange,
} from "./bz_rack.js";
import { MAX_SLOTS } from "./csglide_rack_core.js";
import { normalizeRefs } from "./csglide_ref_text.js";

/* 三类位置引用。@视频音频N 也是视频槽位（与导演台 filterUsedByPrompt、
   后端 _filter_refs_by_prompt 同一口径）。@first / @last 不是槽位，不在此列。 */
const REF_TOK = [
  ["images", /@图片(\d+)/g],
  ["videos", /@(?:视频音频|视频)(\d+)/g],
  ["audios", /@音频(\d+)/g],
];

const KINDS = ["images", "videos", "audios"];
const LABEL_BASE = { images: "参考图片", videos: "参考视频", audios: "参考音频" };
/* 提示里用的规范 token：@视频音频N 也是视频槽位，但对用户只说 @视频N。 */
const TOKEN_LABEL = { images: "@图片", videos: "@视频", audios: "@音频" };

const emptySets = () => ({ images: new Set(), videos: new Set(), audios: new Set() });

/* 本架该读哪一台文案台：优先「本架喂的那台导演台」上游那台（多导演台时不会
   认错），取不到就退回画布上第一台。与 bz_prompt_build / csglide_rack_sort
   的取法一致 —— 这里若另立一套，"这格是亮的但排序说没引用"就会发生。 */
function deskOf(ui) {
  try {
    const p = castProject(ui.node);
    if (p && p.cast) {
      const d = deskNodeOf(p.cast);
      if (d) return d;
    }
  } catch (_) { /* 导演台还没就位：走下面的兜底 */ }
  try { return deskNodes()[0] || null; } catch (_) { return null; }
}

function deskState(desk) {
  const w = desk && (desk.widgets || []).find((x) => x.name === "desk_data");
  let st = {};
  try { st = JSON.parse((w && w.value) || "{}") || {}; } catch (_) { st = {}; }
  return st;
}

/* 文案台自己认为的当前段。只是**兜底**：正常路径用本架的 cur（那才是架上
   正摆着的那一段）。保留它是因为全片共用模式下 cur 会被清空。 */
function deskClip(desk) {
  const st = deskState(desk);
  return String((st.chain && st.chain.clip) || "");
}

/* 文案台的段表里有没有这个键。用来判断本架的 cur 是**真段身份**还是旧存档里
   的段位名（"第七段"这类老键）：拿段位名去查 st.segs 只会查空、只剩片子级，
   亮/灰就整片变哑。 */
function deskHasSeg(desk, clip) {
  if (!clip) return false;
  const st = deskState(desk);
  const segs = (st.segs && typeof st.segs === "object") ? st.segs : {};
  return Object.prototype.hasOwnProperty.call(segs, clip);
}

/* 真正会发出去的那份文本（片子级 + 本段）。
   优先问文案台要 composedWords —— 它会把编辑框里**还没提交**的最新输入收口
   进来，所以打字时就跟着亮，不必等落库。拿不到（文案台旧实例）才退回 widget，
   那时至少和"上次提交"一致。 */
function deskText(desk, clip) {
  if (!desk) return "";
  const du = desk.deskUI;
  if (du && typeof du.composedWords === "function") {
    try {
      const t = String(du.composedWords(clip) || "");
      if (t) return t;
    } catch (_) { /* 落到下面读 widget */ }
  }
  const st = deskState(desk);
  const segs = (st.segs && typeof st.segs === "object") ? st.segs : {};
  return [String(st.global || ""), String((clip && segs[clip]) || "")]
    .filter(Boolean).join("\n");
}

/* 文本 → 三类被引用的槽号集合（**0 基**，与数组下标同号）。
   先过项目级 normalizeRefs：`<Picture 3>` / `image 3` 与 `@图片3` 是同一件事的
   不同写法，不归一就会"明明写了却不亮"。 */
export function usedSets(text) {
  const out = emptySets();
  let t = String(text || "");
  if (!t) return out;
  try { t = normalizeRefs(t) || t; } catch (_) { /* 保留原文 */ }
  for (const [kind, re] of REF_TOK) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(t))) {
      const n = parseInt(m[1], 10);
      if (n >= 1 && n <= MAX_SLOTS) out[kind].add(n - 1);
    }
  }
  return out;
}

/* 只碰 DOM：按「本段文案引用了没引用」给每一格上色 —— 被引用 = 正常显示
   （相对就是"亮"的），没被引用 = 置灰（.gcast-unref）。
   不读任何节点数据，所以可以在每次重渲末尾放心调用（槽号取自卡片自己的
   dataset.refIdx —— 走 DOM 序号会在中间空槽/增删时错位，而这张表最不该错）。

   known=false 表示"这次没读到文案，谁被引用这件事没有答案"。未知 ≠ 未引用：
   那时一律不置灰 —— 否则蛋糕似的把用户刚摆好的素材全压暗，看着像素材丢了。 */
function paintGrid(grid, used, kind, known) {
  if (!grid || !grid.children) return 0;
  const tok = TOKEN_LABEL[kind] || "";
  let n = 0;
  for (const card of grid.children) {
    if (!card || !card.dataset) continue;
    const raw = card.dataset.refIdx;
    if (raw == null) continue;                 // 添加格 / 别的装饰节点
    const idx = Number(raw);
    const cls = card.classList;
    const hasFile = !!cls && cls.contains("filled");
    const hit = used.has(idx);
    if (hit && hasFile) n++;
    const base = card.dataset.refBase || "";

    if (!known || !hasFile) {
      /* 未知 / 空格位：不置灰，提示回到基础文案（空槽谈不上引不引用）。 */
      if (cls) cls.toggle("gcast-unref", false);
      if (base && card.title !== base) { card.dataset.refTip = base; card.title = base; }
      continue;
    }
    if (cls) cls.toggle("gcast-unref", !hit);
    /* 把"这一格为什么是这个状态"写进提示：查起来不用回到文案里数。 */
    const tip = hit
      ? `${base}\n\n本段文案引用了 ${tok}${idx + 1}`
      : `${base}\n\n本段文案没有写 ${tok}${idx + 1} —— 这一格不会送进模型。\n`
        + `在文案里写上它，这一格就会亮起来。`;
    if (card.title !== tip) { card.dataset.refTip = tip; card.title = tip; }
  }
  return n;
}

/* 分区标题后面跟一句"本段用 N"，把"到底用了几张"从数数变成一眼可见。
   标题是从 DOM 邻居取的（grid 前面那个就是自己的标题）—— 三个分区都是同一
   种装配方式，取不到就安静跳过，绝不因为装饰失败影响主流程。 */
function markLabel(grid, base, n, known) {
  const lab = grid && grid.previousElementSibling;
  if (!lab || !lab.classList || !lab.classList.contains("gcast-label")) return;
  const txt = !known ? base
    : (n > 0 ? `${base} · 本段用 ${n}` : `${base} · 本段未引用`);
  if (lab.textContent !== txt) lab.textContent = txt;
}

/* 读「本段文案」的唯一入口（抽出来给腾位也用 —— 两处各读一份，读的段不一样
   就是两台机器互相打架，20261024）。
   返回 { clip, text, known }：known=false 表示没读到文案，"谁被引用"没有答案。 */
export function deskTextFor(ui) {
  let desk = null, clip = "", text = "", known = false;
  try {
    desk = deskOf(ui);
    /* 段身份优先取**本架自己的 cur**（它就是切段广播带来的 cid，见
       csglide_rack_seg.switchSegSync）：亮/灰画在架面第几格上，读的就必须是
       这一段的词 —— 拿文案台的 chain.clip 顶替，在"切段广播到达、文案台
       还没跟上"的那一帧里就会用别段的词点别段的格。composedWords 按段身份
       直接读 st.segs[key]，本来就与文案台界面停在哪一段无关。

       但 cur 也可能是**旧存档里的段位名**（"第七段"），那时它在文案台段表里
       根本不存在，拿它查词只会查空、整片都变哑。所以只在"文案台确实有这个
       段键 / 或它本来就等于文案台的段身份 / 或文案台还没有段身份"时才信它。 */
    const cur = String((ui.st && ui.st.cur) || "");
    const dclip = deskClip(desk);
    clip = (cur && (cur === dclip || !dclip || deskHasSeg(desk, cur))) ? cur : (dclip || cur);
    text = deskText(desk, clip);
    /* 拿到文案台才敢置灰。拿不到（画布上没接 / 还没装完）就是**未知**，
       不是"没被引用" —— 那时把素材全压暗，用户会以为素材丢了。 */
    known = !!desk;
  } catch (e) {
    desk = null;
    known = false;
  }
  return { clip, text, known };
}

/* 读**指定段**的文案（排全部段 / 逐段纠错用）。那一段的架面此刻不在屏幕上，
   但"要不要腾位"完全是它自己的事 —— 只读当前段的话，8 段里只有 1 段会被纠。
   段身份给不出内容时退回当前段：纠错宁可拿当前段再算一遍，也不能静默不动
   （静默不动会让人以为"纠错根本没跑"）。 */
export function deskTextAt(ui, clip) {
  const c = String(clip || "");
  try {
    const desk = deskOf(ui);
    const t = deskText(desk, c);
    if (desk && t) return { clip: c, text: t, known: true };
  } catch (_) { /* 落到当前段 */ }
  return deskTextFor(ui);
}

export function installRefs(ui) {
  /* 热重建（bz_project_sync 的自愈巡检）会再 install 一遍：不先把上一份拆掉，
     旧闭包的监听器就永远挂在 window 上，广播一次触发 N 次 —— 这正是
     csglide_rack_seg 那边"越重建越卡"的老根因。所以每次装都先卸自己。 */
  try { ui.destroyRefs && ui.destroyRefs(); } catch (_) {}

  ui.refUsed = emptySets();
  ui.refKnown = false;
  ui.refSrc = { clip: "", chars: 0, desk: false, known: false };

  /* 重算：读文案台 → 归一 → 抽三类编号。只在"文案变了 / 换段了"时调用。 */
  function refreshRefs() {
    let known = false;
    let { clip, text } = { clip: "", text: "" };
    try {
      const got = deskTextFor(ui);
      clip = got.clip; text = got.text; known = got.known;
    } catch (e) {
      known = false;
    }
    ui.refUsed = usedSets(text);
    ui.refKnown = known;
    ui.refSrc = { clip, chars: text.length, desk: known, known };
    /* 亮/灰是**装饰**：它挂了也绝不能让媒体架面板建不起来（这条链一旦在
       buildUI 里抛，节点就是一个空盒子）。所以这里兜住，出错只记一笔。 */
    try { paintRefMarks(); } catch (e) {
      if (!ui.__refMarkWarned) {
        ui.__refMarkWarned = true;
        console.warn("[媒体架] 引用亮/灰刷新失败（不影响使用）:", e);
      }
    }
  }

  /* 只重刷亮/灰（便宜）。重渲后新卡片没有 class，靠这个补上。 */
  function paintRefMarks() {
    const u = ui.refUsed || emptySets();
    const known = !!ui.refKnown;
    const grids = { images: ui.imgGrid, videos: ui.vidGrid, audios: ui.audGrid };
    for (const k of KINDS) {
      const n = paintGrid(grids[k], u[k], k, known);
      markLabel(grids[k], LABEL_BASE[k], n, known);
    }
  }

  ui.refreshRefs = refreshRefs;
  ui.paintRefMarks = paintRefMarks;

  /* 换段 = 换了一段词，可能整片引用都变了；文案改动 = 逐字跟着亮灭。
     两条都在 rAF 里合帧（见 bz_rack 的 emitDeskChange）：一次粘贴/切段会连着
     触发很多次，一帧只需要算一次。 */
  let raf = 0;
  const schedule = () => {
    if (raf) return;
    if (typeof requestAnimationFrame !== "function") {
      raf = 0;
      try { refreshRefs(); } catch (_) { /* 同上：装饰不许连累面板 */ }
      return;
    }
    raf = requestAnimationFrame(() => {
      raf = 0;
      try { refreshRefs(); } catch (_) {}
    });
  };
  const offs = [];
  try { offs.push(onCastChange(() => schedule())); } catch (_) {}
  try { offs.push(onDeskChange(() => schedule())); } catch (_) {}

  /* 拆：撤监听 + 撤未执行的帧。由本函数自己（重装前）与 bag 的 destroy()
     两头调用，任何一条路都不会留下孤儿监听器。 */
  ui.destroyRefs = () => {
    for (const off of offs.splice(0)) { try { off && off(); } catch (_) {} }
    if (raf && typeof cancelAnimationFrame === "function") cancelAnimationFrame(raf);
    raf = 0;
  };

  /* 首次就位：节点建好时文案台可能还没装完，一帧后再算一次即可覆盖两种顺序。 */
  schedule();
}
