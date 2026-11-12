/* ============================================================
 * 导演台：常量、画布与时长算法、面板状态、分镜解析
 * ------------------------------------------------------------
 * 从 csglide_cast.js 顶层整块搬来。这些都是**纯数据或纯函数**——不碰 DOM、
 * 不碰 node、不依赖面板的任何运行时状态，所以搬出来不需要改一个字。
 * ============================================================ */

/* 时长算法拆到零依赖的 csglide_length.js：成片监视器要用同一套换算，
   而本文件反向 re-export 了 film.js 的常量，让它反过来引本文件会成环。
   这里转出一份，原先从本文件 import 的模块不用改。 */
import { nearestFrames, netOfTotal, totalOfNet, secsIntOfFrames } from "./csglide_length.js";
export { nearestFrames, netOfTotal, totalOfNet };

export const NODE_ID = "CSGlideCastCS";
export const ASSET_SUBFOLDER = "cglide";
export const FPS = 24;
export const MAX_IMAGES = 9, MAX_VIDEOS = 3, MAX_AUDIOS = 3;

/* 文件格式清单 —— 唯一来源。
 *
 * 三张表（EXT_KIND / ACCEPT_VIDEO / ACCEPT_AUDIO / ACCEPT_IMAGE）全部从下面
 * 这三个数组派生，不存在手抄副本：此前媒体架自带一份抄窄了的 ACCEPT_ 副本，
 * 于是「文件对话框里选得到、拖进来却毫无反应」，改格式清单必须两边同步。
 * 现在加一个扩展名只改这一处，选择器、拖拽判定、样式分支自动跟着走。
 *
 * 为什么必须列出扩展名而不是只写 audio/* 通配符：Windows 把 .mkv 注册为
 * video/x-matroska，Chrome 不会把它归入 video/*，于是拖拽可用的 mkv 在选择器
 * 里是灰的——而 mkv 恰是 H.265 渲染的落盘格式；音频同理，.m4b / .opus / .tta
 * 在很多系统上压根没有注册 MIME，只靠通配符它们一个都选不到。
 */
export const VIDEO_EXTS = ["mkv", "mp4", "m4v", "mov", "webm", "avi", "mpg", "mpeg",
                    "ts", "mts", "m2ts", "wmv", "flv", "ogv", "3gp"];
export const AUDIO_EXTS = ["mp3", "m4a", "m4b", "aac", "ac3", "ogg", "oga", "opus",
                    "spx", "wma", "mka", "amr", "3ga", "ra",
                    "wav", "wave", "flac", "aiff", "aif", "aifc", "caf",
                    "w64", "pcm", "au", "snd", "ape", "wv", "tta"];
export const IMAGE_EXTS = ["png", "jpg", "jpeg", "webp", "avif", "bmp", "tif", "tiff"];

export const acceptOf = (exts, prefix) =>
  prefix + "," + exts.map((e) => "." + e).join(",");

export const ACCEPT_VIDEO = acceptOf(VIDEO_EXTS, "video/*");
export const ACCEPT_AUDIO = acceptOf(AUDIO_EXTS, "audio/*");
export const ACCEPT_IMAGE = acceptOf(IMAGE_EXTS, "image/*");

/* 拖拽时文件带的 MIME 可能是空的（系统没注册这种扩展名），MIME 判定落空之后
 * 回落到这张表按扩展名认类型。表里没有就认不出来。 */
export const EXT_KIND = Object.assign(
  {},
  Object.fromEntries(VIDEO_EXTS.map((e) => [e, "video"])),
  Object.fromEntries(AUDIO_EXTS.map((e) => [e, "audio"])),
  Object.fromEntries(IMAGE_EXTS.map((e) => [e, "image"])),
  { gif: "image" },   /* 动图归图片槽：它会被 PIL 按静态图读，不进音频/视频侧 */
);

/* 可疑图片格式 —— MIME 存在（于是 fileKind() 判为 image、会被收下并上传），
 * 但参考图最终要由**后端 PIL 打开**，这些扩展名在后端根本没有解码器：收下
 * 也只会一路传到模型端才抛异常，或缩略图先裂成 ⚠。
 *
 * 清单来源：ComfyUI 内嵌解释器（python_embeded）PIL 11.3.0 实测
 * `Image.registered_extensions()`——heic / heif / svg / psb / exr / hdr 均无
 * 解码器登记。**反例（不要拉进来）**：psd / tga / dds / ico / jp2 / j2k / eps /
 * wmf / emf 实测**都能解码**，凭印象拉黑会误伤这些正常文件。
 *
 * SVG 单独说一句：浏览器能把它缩略成图，看着"能用"，但 PIL 永远读不了它，
 * 所以照样要拦——它败在后端，不表现在前端。
 * 与媒体架同源：这张表只此一份，媒体架 import 共用，不要再抄副本。 */
export const PIL_BAD_IMAGE = {
  heic: "HEIC", heif: "HEIF", svg: "SVG", psb: "Photoshop 大文档（PSB）",
  exr: "OpenEXR", hdr: "Radiance HDR",
};

/* 传入 File（或任何 { type, name }）：命中可疑格式返回可读名（如 "HEIC"），
 * 否则返回 ""。判定以扩展名为准，MIME 仅在文件名没有扩展名时兜底——某些
 * HEIC 导出不带后缀，这类只能靠 type 认。 */
export function badImageKind(f) {
  const name = (f?.name || "").toLowerCase();
  const t = (f?.type || "").toLowerCase();
  let ext = name.includes(".") ? name.split(".").pop() : "";
  if (!ext) {
    if (t === "image/svg+xml") ext = "svg";
    else if (/^image\/(x-)?(heic|heif)$/.test(t)) ext = "heif";
  }
  return PIL_BAD_IMAGE[ext] || "";
}

/* Ratio families. The first size in each ladder is the canvas H3's own
 * adapt_canvas() would pick; everything below it holds the same aspect on a
 * shorter edge, every axis a multiple of 32. */
export const MAX_PIXELS = 768 * 1344;

export const RATIOS = [
  { label: "21:9", w: 1536, h: 672 },
  { label: "16:9", w: 1344, h: 768 },
  { label: "3:2",  w: 1152, h: 768 },
  { label: "4:3",  w: 1024, h: 768 },
  { label: "1:1",  w: 768,  h: 768 },
  { label: "3:4",  w: 768,  h: 1024 },
  { label: "2:3",  w: 768,  h: 1152 },
  { label: "9:16", w: 768,  h: 1344 },
];

export const SHORT_EDGES = [768, 704, 640, 576, 512, 448, 384, 352, 320];

/* 阶梯按「短边取遍 SHORT_EDGES、长边按比例推、整体不超过 maxPixels」生成。
   shortEdges / maxPixels / maxSide 可覆盖：不同模型的画布上限不一样（H3 是
   768×1344 的面积上限，Qwen 编辑是 4K 级起步），机制共用一份，数值各给各的。
   maxSide 是单边上限，缺省不限（H3 的面积上限已经足够收住长边）；超宽比例
   （21:9 之类）单看面积是收不住的——短边 1920 推出来的长边有 4480。 */
export function sizeLadder(base, shortEdges = SHORT_EDGES, maxPixels = MAX_PIXELS,
                           maxSide = Infinity) {
  const r = base.w / base.h;
  const seen = new Set(), out = [];
  for (const shortEdge of shortEdges) {
    let w, h;
    if (r >= 1) { h = shortEdge; w = Math.max(32, Math.round((shortEdge * r) / 32) * 32); }
    else { w = shortEdge; h = Math.max(32, Math.round((shortEdge / r) / 32) * 32); }
    if (w * h > maxPixels + 1) continue;
    if (w > maxSide || h > maxSide) continue;
    const key = `${w}x${h}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ w, h });
  }
  if (!out.some((o) => o.w === base.w && o.h === base.h)) out.unshift({ w: base.w, h: base.h });
  return out;
}

RATIOS.forEach((r) => { r.sizes = sizeLadder(r); });

/* Named extra presets that are NOT produced by the short-edge ladder.
 * "700阶段" is a MiniMax resolution stage below the native 768p tiers
 * (e.g. 768x448), NOT a 0.7MP label, so it is added explicitly. */
export const EXTRA_SIZES = {
  "16:9": [{ w: 768, h: 448, stage: "700阶段" }],
};
for (const r of RATIOS) {
  for (const s of (EXTRA_SIZES[r.label] || [])) {
    if (!r.sizes.some((z) => z.w === s.w && z.h === s.h)) {
      r.sizes.push({ w: s.w, h: s.h, stage: s.stage });
    }
  }
  r.sizes.sort((a, b) => (b.w * b.h) - (a.w * a.h));
}

export function findRatio(w, h, ratios = RATIOS) {
  for (const r of ratios) if (r.sizes.some((s) => s.w === w && s.h === h)) return r;
  return null;
}

/* Reference sizing: a free LONG-edge value in px (32-aligned), plus a
 * "match" switch that tracks the canvas long edge. Images clamp at 4096;
 * video has no upper cap (Infinity makes the clamp a no-op). "跟随画布" = match. */
export const REF_STEP = 32, REF_MIN = 32;
export const REF_IMAGE_MAX = 4096, REF_VIDEO_MAX = Infinity;
/* 参考视频采样帧率：24=不抽帧；往低调（如 12/8）在时长不变时减少参考帧数、
 * 节省显存，但会降低参考锚定精度。与后端 _clamp_ref_fps 的 4..24 保持一致。 */
export const REF_FPS_MIN = 4, REF_FPS_MAX = 24;
export const clampRefFps = (v) => {
  const n = Math.round(+v);
  return Number.isFinite(n) ? Math.max(REF_FPS_MIN, Math.min(REF_FPS_MAX, n)) : REF_FPS_MAX;
};

/* 「放大重绘」（二采/三采）条件的参考档位倍数。与后端 _ref_hd_scale 同口径：
   1 = 跟随主档位、不额外编码（接入前的既有行为）；>1 = 参考素材按该倍数重新
   编码，细节更多但每级都要重跑一遍视觉编码器。 */
export const REF_SCALE_MIN = 1, REF_SCALE_MAX = 4, REF_SCALE_STEP = 0.25;
export const clampRefScale = (v) => {
  const n = Math.round(+v / REF_SCALE_STEP) * REF_SCALE_STEP;
  return Number.isFinite(n) ? Math.max(REF_SCALE_MIN, Math.min(REF_SCALE_MAX, +n.toFixed(2))) : REF_SCALE_MIN;
};


/* Normalise a stored value (from an old dropdown, or a free number) back to
 * "match" or a snapped/clamped number. Old tier strings like "512" degrade to
 * a plain number transparently; "max" still maps to the cap. */
export const normRefSize = (v, cap, fallback) => {
  if (v === "match") return "match";
  if (v === "max") return Number.isFinite(cap) ? cap : REF_IMAGE_MAX;
  const n = Number(v);
  if (Number.isFinite(n) && n > 0) {
    return Math.max(REF_MIN, Math.min(cap, Math.round(n / REF_STEP) * REF_STEP));
  }
  return fallback;
};

/* Paint one ref-size control: checkbox on ⇄ "跟随画布" plus a number input.
 * The input always stays live so its native up/down steppers work exactly like
 * the canvas width/height; editing it while following auto-flips to a fixed
 * size. A note describes the effective long edge. */
export const renderRefControl = (chk, input, note, value, canvasLong, cap) => {
  const isMatch = value === "match";
  chk.checked = isMatch;
  input.value = isMatch ? canvasLong : value;
  /* 只读出有效长边：跟随状态已由勾选框 + "跟随画布" 小标题表达，note 再写一遍
     既重复又会让视频卡那一行放不下（会被省略号截断）。 */
  note.innerHTML = `<b>长边 ${isMatch ? canvasLong : value}px</b>`;
};

/* Frame counts on the 17k+5 grid, one entry per integer second band.
   These are quick-pick presets only — NOT a hard cap; the custom input beside
   the dropdown accepts any length and re-aligns it to the grid. */
export const LENGTH_PRESETS = [124, 243, 362, 481, 600, 719];  // ≈ 5/10/15/20/25/30s

export const ALL_TOKENS = [
  "@first", "@last",
  ...Array.from({ length: MAX_IMAGES }, (_, i) => `@图片${i + 1}`),
  ...Array.from({ length: MAX_VIDEOS }, (_, i) => `@视频${i + 1}`),
  ...Array.from({ length: MAX_VIDEOS }, (_, i) => `@视频音频${i + 1}`),
  ...Array.from({ length: MAX_AUDIOS }, (_, i) => `@音频${i + 1}`),
];

/* 新建节点的初始高度。它是初值，80ms 后 fitNode() 会按真实内容收掉留白——
   所以取一个"略高于实测峰值"的值即可，取大了新建时会先闪一个超高节点。
   1330 是七段纵向平铺那个年代的实测值；改成指挥条 + 双栏 + 总览轴 + 落地行
   四段之后，实测峰值约 660（fl2va 模式下首尾帧卡展开）。 */
export const MIN_H_REF = 700;    // initial node height; the node itself is user-resizable below this
/* 节点最窄下限：设置卡（右栏 540）+ 监视器（左栏）至少留出可用的观看宽度。
   低于此值右侧设置卡会被挤没、左侧监视器也窄到没法看——这是「允许收窄」的
   合理终点，原 900 是拍脑袋的保守值，把用户能收窄的幅度白白扣掉了。 */
export const MIN_PANEL_W = 560;
/* 手动拖拽模式下报给框架的最小面板高度。前端拖拽以 node.computeSize()
   （=各 widget minHeight 之和）做下限钳制，报内容实测峰值会让节点永远拖不到
   比内容更矮。固定小值 + maxHeight 无限，收短后内容靠 .gcast 滚动，不塌陷。 */
export const MIN_FLOOR_H = 120;
/* Hard safety cap: no matter what a measurement returns, the node is never
   grown past this. A runaway fitNode (or a stale minHeight) used to stretch
   the bottom to infinity; this bounds it so the worst case is a large but
   finite panel the user can drag down. The prompt scrolls inside it, so a
   tall cap here costs nothing. */
export const MAX_NODE_H = 6000;
export const PROMPT_H_REF = 160, PROMPT_H_FL = 300;   // fl2va has only two slots, so the space goes to the prompt

export const alignFrames = (n) => { n = Math.max(5, Math.round(n)); while (n % 17 !== 5) n++; return n; };
export const fmtSecs = (s) => (Math.round(s * 100) / 100).toFixed(2) + "s";
/* 秒 ↔ 帧：自定义时长输入以「秒」为单位。帧数只有落在 17k+5 网格上才合法，
   而用户想说的是「我要 12 秒」——吸附交给 nearestFrames。
   回显只给整数秒（显示层简化，不让 17.92 这类小数挤占窄框）；精确帧数在右侧
   读出位、精确秒数在 title 里备查。可逆性不靠小数：listeners.js 的 onchange 用
   raw === echo 值比较拦住「点进框又点出来」，回显与 echo 同走本函数，整数同样可逆。
   空/非法输入回退 124 帧（与旧行为一致）；数值合法但越界（在下限附近按 ↓ 时浏览器
   会给出 0）交给 nearestFrames 夹到下限 5——不能回退 124，否则按 ↓ 会突然跳回 5.17s。
   NaN 必须先挡（alignFrames/nearestFrames 都不认 NaN）。 */
export const secsOfFrames = (f) => secsIntOfFrames(f, FPS);
export const framesOfSecs = (s) => {
  if (s == null || String(s).trim() === "") return 124;      // 空 → 回落默认
  const v = +s;
  return Number.isFinite(v) ? nearestFrames(v * FPS) : 124;  // 越界由 nearestFrames 夹到 ≥5
};

/* 本段当前的承接重叠帧数（头部 trim）。导演台「时长」卡与时间轴块宽要统一
   按**净长**口径换算（20261013：卡上 345 帧/14 秒、轴上块却 12 秒，用户当然
   认为对不上 —— 块画的是净长，头部 56 帧是承接上一段尾巴的重叠，显示在
   上一段那侧）。取值优先读档案里这一段的 trim_frames（渲染登记时定的实际
   值，监视器缓存里有）；档案还没有就退回本段承接窗口设置 cont.frames。
   第 1 段 / 未承接 = 0。 */
export const headOverlapFrames = (monitor, st) => {
  let t = 0;
  try {
    const cid = (st && st.chain && st.chain.clip) || "";
    const row = (cid && monitor && monitor.clipRowOf) ? monitor.clipRowOf(cid) : null;
    if (row) t = Math.round(Number(row.trim_frames) || 0);
  } catch (_) { t = 0; }
  if (!t) t = Math.max(0, Math.round(Number(st && st.cont && st.cont.frames) || 0));
  return Math.max(0, t);
};

/* ---------------------------------------------------------------- state */

/* 20261026：重抽档位 / 锚点选法 / 骨架间隔 已整体删除。
   骨架钉帧会按固定间隔把整个 latent 步标 0（原样贴一帧旧版画面），落到
   H3 周期首步（那一步只覆盖 1 帧）就是单帧孤立 —— 视觉上每 0.7 秒闪一下，
   且 UI 已无处可关。钉帧从此只有「头尾各留几帧」一个旋钮（续接用途）。 */
/* 钉死的头 / 尾帧数上限。H3 的片段长度远小于它 —— 这个上限只挡输入框手滑
   （多按两个 0 把浮点撑爆），不是业务边界。 */
export const PIN_FRAMES_MAX = 4096;

export function blankState() {
  const mk = (n) => Array.from({ length: n }, () => ({}));
  return {
    mode: "ref2va",
    /* 出厂默认画布：576×320（16:9 阶梯短边 320 档，findRatio 可匹配）。 */
    width: 576, height: 320,
    ratio: "16:9",        /* locked aspect-ratio family; "custom" unlinks width/height */
    length: 243,
    /* 钉帧从此处起**只有头尾两个旋钮**（20261026 删除了重抽档位 / 锚点选法 /
       骨架间隔）。中间任何一帧都不再钉 —— 骨架钉帧按固定间隔标 0，落到 H3
       周期首步（那一步只覆盖 1 帧）就是单帧孤立，视觉上每 0.7 秒闪一下。 */
    /* 本段钉死的头 / 尾帧数（潜空间帧）。尾部帧数是「重抽这一段、后面各段
       一个都不用重跑」的物理判据 —— 下一段的引导头就是它。0 = 不钉。 */
    pin_head: 0,
    pin_tail: 0,
    ref_image_size: "match",
    ref_video_size: "768",
    ref_video_fps: 24,
    /* 「放大重绘」（二采/三采共用）条件的参考档位倍数。1 = 跟随主档位。 */
    ref_scale_hd: 1,
    pace: 2.5,          /* legacy: the speech-budget slider is gone, kept so old .h3.json still parses */
    prompt: "",
    slots: { first: {}, last: {}, images: mk(MAX_IMAGES), videos: mk(MAX_VIDEOS), audios: mk(MAX_AUDIOS) },
    /* CONTINUE FROM: the previous clip's tail, anchored at frame 0 of this one.
     * Deliberately NOT a reference slot - it takes no @token, never appears in
     * the presentation, and works in both modes. Continuing is orthogonal to
     * first/last vs omni, so it is a section rather than a third mode. */
    cont: {},
    /* 段落档案归属 —— 与「工程」合一，只有一套概念：
     *   name = 工程名（= 片名，output/h3_chain/<片名>/）
     *   shot = 本分段的唯一 id，后台按它认段（重抽复用同一段，不重复新建）
     *   clip = 段落 id，通常留空交给后台按 shot 匹配
     * name 空 = 不归档，导演台照旧单段工作、不产生任何档案文件。 */
    /* 「整片」口输出开关。关（默认）= 跑图时整片口不往外发内容，接在它后面
       的 RTX 超分 / 插帧会安静跳过（不报错、不白跑），也省掉每次几秒的整片
       拼接；开 = 按老样子拼出整片并从「整片」口吐给下游。 */
    push_whole: false,
    /* 「整片潜空间」口**没有面板状态位**（20261102 定）：它是「🧬 推送整片潜空间」
       按钮按下时直接写进"这一笔提交副本"的 h3_data 里，不经过 ui.st。放进状态
       就必然出现两种翻车 —— 勾着忘了取消（每次渲染白拼一条整片 latent）/
       忘了勾（下游拿到空线）。 */
    chain: { name: "", clip: "", shot: "" },
    /* 上一轮「全部渲染」的结果（成功/中断/失败）。
     * 面板上那行结果原先只写 DOM，刷新页面就没了 —— 用户看不到「这一轮到底
     * 成没成、断在第几段」。存进面板存档（h3_data）才能跨刷新活下来。 */
    run_result: null,
  };
}

/* Whitelisted parse. Anything not named here is dropped on reload — on purpose.
 * Adding a new stored field means adding it HERE too, or it vanishes silently. */
export function parseInitial(raw) {
  const out = blankState();
  let d = {};
  try { d = typeof raw === "string" ? JSON.parse(raw || "{}") : (raw || {}); } catch (e) { d = {}; }
  if (!d || typeof d !== "object") d = {};

  if (d.mode === "fl2va") out.mode = "fl2va";
  if (Number.isFinite(+d.width)) out.width = +d.width;
  if (Number.isFinite(+d.height)) out.height = +d.height;
  if (d.ratio === "custom" || RATIOS.some((r) => r.label === d.ratio)) {
    out.ratio = d.ratio;
  } else {
    /* Pre-ratio saves: recover the family from the canvas size, falling back
     * to "custom" when the dimensions match no preset ladder. */
    out.ratio = (findRatio(out.width, out.height) || {}).label || "custom";
  }
  if (Number.isFinite(+d.length)) out.length = alignFrames(+d.length);
  out.ref_image_size = normRefSize(d.ref_image_size, REF_IMAGE_MAX, "match");
  out.ref_video_size = normRefSize(d.ref_video_size, REF_VIDEO_MAX, "768");
  out.ref_video_fps = clampRefFps(d.ref_video_fps);
  out.ref_scale_hd = clampRefScale(d.ref_scale_hd);
  /* 「整片」口输出开关：**只读运行时、不读存档**。它是「🎬 推送整片」按下
     那一瞬间才开、推送完立刻关的一次性开关，不是能留在工程里的设置——万一
     推送途中刷新 / 崩了，存档里可能残留 true，重载时必须无条件回到关，
     否则"不点就永远是关"这条就不成立了。 */
  out.push_whole = false;
  /* 「整片潜空间」口同理：它连状态位都没有（见 blankState 说明），老工程里
     残留的 true 读档时会被白名单直接丢掉 —— 不会有幽灵开关复活。 */
  if (Number.isFinite(+d.pace) && +d.pace > 0) out.pace = Math.min(4, Math.max(1, +d.pace));
  if (typeof d.prompt === "string") out.prompt = d.prompt;
  /* 上一轮渲染结果：读回来让面板在刷新后仍显示「这轮成没成」。 */
  if (d.run_result && typeof d.run_result === "object") {
    const rr = d.run_result;
    if (typeof rr.text === "string" && rr.text) {
      out.run_result = { ok: !!rr.ok, text: rr.text };
    }
  }

  const s = (d.slots && typeof d.slots === "object") ? d.slots : {};
  const image = (o) => (o && o.file) ? { file: String(o.file) } : {};
  const timed = (o, withAudio) => {
    if (!o || !o.file) return {};
    const r = { file: String(o.file) };
    if (Number.isFinite(+o.start)) r.start = +o.start;
    if (Number.isFinite(+o.end)) r.end = +o.end;
    if (Number.isFinite(+o.dur)) r.dur = +o.dur;
    if (withAudio && o.audio) r.audio = true;
    return r;
  };

  out.slots.first = image(s.first);
  out.slots.last = image(s.last);
  for (let i = 0; i < MAX_IMAGES; i++) out.slots.images[i] = image((s.images || [])[i]);
  for (let i = 0; i < MAX_VIDEOS; i++) out.slots.videos[i] = timed((s.videos || [])[i], true);
  for (let i = 0; i < MAX_AUDIOS; i++) out.slots.audios[i] = timed((s.audios || [])[i], false);

  const c = (d.cont && typeof d.cont === "object") ? d.cont : {};
  if (c.mode === "latent") {
    /* 潜空间续写：上一片段的采样潜空间。来源二选一：引用的存档文件
       （latent_file，相对 output 目录），或 context_latent 端口接线。
       frames = 续写画面窗口；声音始终延续（这正是该档位的意义）。 */
    out.cont = { mode: "latent" };
    if (Number.isFinite(+c.frames)) out.cont.frames = +c.frames;
    if (c.latent_file) out.cont.latent_file = String(c.latent_file);
    /* 源视频输出（相对 output 的成片路径）：潜空间档下兼作「Glide 续接合成」
       的源片，随工程保存/载入，后端从「源视频」端口吐出。
       老工程曾把它存在 cont.file（档位共用期的残留），载入时归位。 */
    if (c.latent_video) out.cont.latent_video = String(c.latent_video);
    else if (c.file) out.cont.latent_video = String(c.file);
    /* UI-only（后端白名单丢弃）：预览用的同批视频输出，仅展示。 */
    if (c.latent_preview && typeof c.latent_preview === "object" && c.latent_preview.name) {
      out.cont.latent_preview = {
        name: String(c.latent_preview.name),
        subfolder: String(c.latent_preview.subfolder || ""),
        type: String(c.latent_preview.type || "output"),
      };
    }
  } else if (c.file) {
    out.cont = { file: String(c.file) };
    /* 续接窗口。文件档的窗口真正生效在 start/end 跨度上，frames 是
       「还没有跨度时」的兜底；两个都要留，否则重载一次窗口就丢了。 */
    if (Number.isFinite(+c.frames) && +c.frames > 0) out.cont.frames = +c.frames;
    if (Number.isFinite(+c.start)) out.cont.start = +c.start;
    if (Number.isFinite(+c.end)) out.cont.end = +c.end;
    if (Number.isFinite(+c.dur)) out.cont.dur = +c.dur;
    if (c.audio) out.cont.audio = true;
    if (c.flatten) out.cont.flatten = true;
    /* UI-only, and dropped by the Python whitelist: what the guide's chroma is,
       so the 4:2:0 note survives a reload instead of vanishing until the file
       is re-adopted. */
    if (c.chroma) out.cont.chroma = String(c.chroma);
    if (c.codec) out.cont.codec = String(c.codec);
  }

  /* 段级生成参数：**只剩钉死的头尾帧数**（20261026 删掉重抽档位 / 锚点选法 /
     骨架间隔三件套 —— 见本文件 state 段上方的删除说明）。
     老存档 / 老模板的 h3_data 里还带着 redo_mode / redo_anchor，这里**一个都不
     收**：blankState 里已经没有这两个字段，不读就自然消失，不再需要"读了再删"。 */
  if (Number.isFinite(+d.pin_head)) {
    out.pin_head = Math.max(0, Math.min(PIN_FRAMES_MAX, Math.round(+d.pin_head)));
  }
  if (Number.isFinite(+d.pin_tail)) {
    out.pin_tail = Math.max(0, Math.min(PIN_FRAMES_MAX, Math.round(+d.pin_tail)));
  }

  /* 段落档案：只收 name / clip 两个字符串，其余一律丢弃。
     老工程没有这个字段 → 保持空白，行为逐字不变（不归档）。 */
  const ch = (d.chain && typeof d.chain === "object") ? d.chain : {};
  out.chain = {
    name: typeof ch.name === "string" ? ch.name : "",
    clip: typeof ch.clip === "string" ? ch.clip : "",
    shot: typeof ch.shot === "string" ? ch.shot : "",
  };
  return out;
}

/* Same ordinal rules as the tokenizer: images, then videos (a soundtrack's
 * <Audio j> lands immediately before its <Video k>), then standalone audio.
 * Ordinals are 1-based per type and count only filled slots.
 * slots: 展示用的合并槽位视图（面板 + 媒体架），缺省用面板自身槽位。
 * 数组长度动态——媒体架槽位按需生长，空位/未选中位传 null 即可跳过。 */
export function presentation(st, slots) {
  const rows = [], tags = {};
  if (st.mode === "fl2va") {
    let i = 0;
    if (st.slots.first.file) { i++; tags["@first"] = `<Picture ${i}>`; rows.push({ tag: `<Picture ${i}>`, from: "first frame", kind: "image" }); }
    if (st.slots.last.file)  { i++; tags["@last"]  = `<Picture ${i}>`; rows.push({ tag: `<Picture ${i}>`, from: "last frame",  kind: "image" }); }
    return { rows, tags };
  }
  const view = slots || st.slots;
  let i = 0, j = 0, k = 0;
  view.images.forEach((s, n) => {
    if (!s || !s.file) return; i++;
    tags[`@图片${n + 1}`] = `<Picture ${i}>`;
    rows.push({ tag: `<Picture ${i}>`, from: `图片 ${n + 1}`, kind: "image", token: `@图片${n + 1}` });
  });
  view.videos.forEach((s, n) => {
    if (!s || !s.file) return;
    if (s.audio) {
      j++; tags[`@视频音频${n + 1}`] = `<Audio ${j}>`;
      rows.push({ tag: `<Audio ${j}>`, from: `视频 ${n + 1} 声音`, kind: "audio", token: `@视频音频${n + 1}` });
    }
    k++; tags[`@视频${n + 1}`] = `<Video ${k}>`;
    rows.push({ tag: `<Video ${k}>`, from: `视频 ${n + 1}`, kind: "video", token: `@视频${n + 1}` });
  });
  view.audios.forEach((s, n) => {
    if (!s || !s.file) return; j++;
    tags[`@音频${n + 1}`] = `<Audio ${j}>`;
    rows.push({ tag: `<Audio ${j}>`, from: `音频 ${n + 1}`, kind: "audio", token: `@音频${n + 1}` });
  });
  return { rows, tags };
}

/* ---- 媒体架合并视图 + 严格按需过滤（与 csglide_cast.py 同规则镜像） ----
   上游定位（媒体架 / 外接文本源）收口在 bz_rack.js，媒体架与 Qwen 编辑台
   都在用；这里再导出一遍，那两个文件的 import 不用动。 */
export { promptNodeOf, upstreamTextOf } from "./bz_rack.js";

/* 「当前段」的规范色 —— 定义在成片监视器里（时间轴是它最醒目的一处），这里
   只是转出去给媒体架用。三个节点必须同一个值，所以只准有一份定义。 */
export { CUR_SEG, CUR_SEG_DIM } from "./csglide_film.js";

/* 提示词提到的 @标签 才送；一个都没提就一个都不送（严格按需）。
   未提到的位置保留为 null——编号位置不变，presentation 只数已填槽位。 */
export function filterUsedByPrompt(slots, prompt) {
  const nums = (re) => new Set([...prompt.matchAll(re)].map((m) => +m[1] - 1));
  const keep = {
    images: nums(/@图片(\d+)/g),
    videos: new Set([...nums(/@视频音频(\d+)/g), ...nums(/@视频(\d+)/g)]),
    audios: nums(/@音频(\d+)/g),
  };
  /* 超过各类型上限时按编号取前 N 个，其余丢弃：<Picture 10> / <Video 4> 这类
     标签模型不认，送进去只会静默失效（图没生效却没报错）。截断规则与
     csglide_cast.py 的 _filter_refs_by_prompt 必须一致。 */
  const caps = { images: MAX_IMAGES, videos: MAX_VIDEOS, audios: MAX_AUDIOS };
  for (const k of Object.keys(keep)) {
    if (keep[k].size > caps[k]) {
      keep[k] = new Set([...keep[k]].sort((a, b) => a - b).slice(0, caps[k]));
    }
  }
  const any = Object.values(keep).some((s) => s.size > 0);
  const out = {};
  for (const k of ["images", "videos", "audios"]) {
    /* 独立音频不参与按需过滤：与 csglide_cast.py 的 _filter_refs_by_prompt 同口径。
       官方 MiniMaxH3ReferenceToVideo 对 ref_audios 无条件发送，导演台原先也过滤，
       于是「摆好了音频、提示词没写 @音频N」就静默丢弃——用户只看到音频没生效。
       音频是配乐/音色这类整体氛围参考，剧本里未必逐句提到，过滤它省不了多少
       显存却极易误伤。仍受 MAX_AUDIOS 上限约束。 */
    if (k === "audios") {
      const all = slots[k].map((s, i) => (s && s.file ? i : -1)).filter((i) => i >= 0);
      const use = new Set(all.slice(0, MAX_AUDIOS));
      out[k] = slots[k].map((s, i) => (use.has(i) ? s : null));
      continue;
    }
    out[k] = any ? slots[k].map((s, i) => (keep[k].has(i) ? s : null)) : [];
  }
  return out;
}

/* ---- prompt check ---------------------------------------------------
 * H3 always generates a soundtrack for the full duration, so whatever the
 * prompt leaves unsaid gets invented -- which is where mumbling comes from.
 * Counting words against a pace was the wrong measure: a well-paced line
 * still leaves seconds of unassigned audio at the end of the shot. What
 * actually stopped it in testing was structural, so this looks for the
 * structure: named fields, a speaker ID, mouths closed after the line, and
 * a soundscape that covers the whole clip.
 */


/* Shot markers, official format: "[Shot 2] At 00:03.500," -- Shot 1 carries no
 * timestamp and starts at zero. A shot runs until the next one starts, or to
 * the end of the clip. "At 3.5s," and "At 00:03," are tolerated too, since the
 * guide's MM:SS.mmm is not what people type by hand.
 *
 * The END of a shot is never stated, so it is always inferred. That is the
 * format's own rule, not a guess: shots are contiguous inside one generation. */
export const SHOT_RE = /\[\s*shot\s*(\d+)\s*\]([^\n]{0,90})/gi;
export const AT_MMSS = /\bat\s+(\d{1,2}):(\d{2})(?:[.,](\d{1,3}))?/i;
export const AT_SECS = /\bat\s+(\d{1,3}(?:[.,]\d+)?)\s*s\b/i;

export function parseShots(prompt, total) {
  const p = prompt || "";
  const marks = [];
  let m;
  SHOT_RE.lastIndex = 0;
  while ((m = SHOT_RE.exec(p)) !== null) {
    const tail = m[2] || "";
    const tailAt = m.index + (m[0].length - tail.length);
    const a = AT_MMSS.exec(tail), b = a ? null : AT_SECS.exec(tail);
    let at = null, tsFrom = null, tsTo = null;
    if (a) {
      at = (+a[1]) * 60 + (+a[2]) + (a[3] ? +("0." + a[3].padEnd(3, "0")) : 0);
      tsFrom = tailAt + a.index; tsTo = tsFrom + a[0].length;
    } else if (b) {
      at = +String(b[1]).replace(",", ".");
      tsFrom = tailAt + b.index; tsTo = tsFrom + b[0].length;
    }
    marks.push({ n: +m[1], at, tsFrom, tsTo, afterBracket: tailAt, idx: m.index });
  }
  if (!marks.length) return [];
  if (marks[0].at == null) marks[0].at = 0;

  return marks.map((s, i) => {
    const next = marks[i + 1];
    const end = (next && next.at != null) ? next.at : total;
    return {
      n: s.n,
      start: s.at,
      end: s.at == null ? null : Math.max(s.at, end),
      untimed: s.at == null,
      past: s.at != null && s.at >= total,
      /* character ranges, so the timeline can edit the prompt back */
      tsFrom: s.tsFrom, tsTo: s.tsTo, afterBracket: s.afterBracket,
      idx: s.idx, bodyFrom: s.tsTo != null ? s.tsTo : s.afterBracket,
      bodyTo: next ? next.idx : null,
    };
  });
}


/* ------------------------------------------------------------------ css */

/* 样式在 csglide_cast.css.js —— 整块搬走，这里只留引入。 */


/* ==========================================================================
 * 素材落盘目录：按工程隔离（20261020）
 * --------------------------------------------------------------------------
 * input/cglide 原本是所有工程共用的**一个**目录，文件名即全局唯一身份：
 * 新工程导入同名素材会撞名 —— ComfyUI 的 store_image_upload 撞名就改名
 * 「名 (2).ext」（/upload/image），后端 adopt 撞名就改名「名_1.ext」，
 * 于是素材名后面凭空多出编号。
 *
 * 改法：素材按工程落子目录 input/cglide/<片名>/。但**不能一律落子目录**，
 * 有两条必须兼容：
 *   1. 同工程内重新导入同名素材 = 「用新的替换旧的、名字不变」——必须落回
 *      本工程**正在用的那个目录**原地覆盖，槽位路径不动、内容换新；落到别的
 *      目录（哪怕是本工程子目录）槽位读的还是旧文件，等于没替换。
 *   2. 本方案之前的存档，槽位指向 cglide/ 根；老素材再导入要能覆盖到根上
 *      那一份，否则老工程永远换不掉内容。
 * 规则：本工程有槽位正在用同名文件 → 用它**现在那个目录**；否则 → 本工程
 * 子目录；拿不到片名 → 退回根（与旧版逐字一致）。
 *
 * 放在本文件是因为它**零 import**：导演台（csglide_ui_kit）与媒体架
 * （csglide_rack_asset）都要用，放任何一端都会让另一端反向依赖重模块。
 * 纯函数，可脱离浏览器单跑自测（_selftest_asset_dir.mjs）。
 * ======================================================================== */

/* 片名要当磁盘目录名（Windows 非法字符一律换 _）。片名本身已经是
   output/h3_chain 下的目录名，这一步只兜住手输进来的怪名字。 */
export function safeDirName(name) {
  const s = String(name || "").replace(/[\\/:*?"<>| -]+/g, "_").trim();
  return s === "." || s === ".." ? "" : s;
}

/* 一个面板状态里**正在被引用**的全部素材路径。
   导演台：slots.first / slots.last / slots.images[] / videos[] / audios[]
   外加续写卡 cont（文件档的 file、潜空间档的 latent_video）。
   媒体架：slots.images[] / videos[] / audios[] 外加各段记忆 segs。 */
export function castSlotFiles(st) {
  const out = [];
  const push = (v) => { if (v) out.push(String(v)); };
  const s = (st && st.slots) || {};
  if (s.first && s.first.file) push(s.first.file);
  if (s.last && s.last.file) push(s.last.file);
  for (const k of ["images", "videos", "audios"]) {
    const list = s[k];
    if (Array.isArray(list)) for (const x of list) if (x && x.file) push(x.file);
  }
  const c = st && st.cont;
  if (c && c.file) push(c.file);
  if (c && c.latent_video) push(c.latent_video);
  return out;
}

/* input 侧的素材只可能落在这两处根：cglide 是现行目录，whatdreamscost 是
   后端 LEGACY_ASSET_SUBFOLDERS 里的老目录（老工程要能继续打开）。

   为什么必须先看根：槽位里还混着**相对 output 的路径**——续写卡潜空间档的
   cont.latent_video 存的是 h3_chain/<片名>/clip_000N.mp4，而「取用输出」采纳
   的成片 basename 恰恰也是 clip_000N.mp4。只比 basename 就会命中它，把成片
   落进 input/h3_chain/<片名>/ 这种垃圾目录，续接从此读不到素材。 */
const ASSET_ROOTS = ["cglide", "whatdreamscost"];

const isAssetPath = (p) => ASSET_ROOTS.indexOf(String(p || "").split("/")[0]) >= 0;

/**
 * 素材该落 input 下的哪个子目录（不含文件名）。
 * @param used        本工程正在用的素材相对路径数组（castSlotFiles 的产出）
 * @param projectName 当前工程片名
 * @param fileName    本次要导入的文件名（或带路径，只取最后一段）
 */
export function assetDirOf(used, projectName, fileName) {
  const want = String(fileName || "").split(/[\\/]/).pop();
  if (want) {
    for (const f of used || []) {
      const p = String(f || "");
      if (!p || !isAssetPath(p)) continue;
      if (p.split(/[\\/]/).pop() === want) {
        const i = p.lastIndexOf("/");
        /* 老存档的槽位在 cglide 根上（没有 /）→ 回根覆盖，别把它甩进子目录 */
        return i > 0 ? p.slice(0, i) : ASSET_SUBFOLDER;
      }
    }
  }
  const d = safeDirName(projectName);
  return d ? `${ASSET_SUBFOLDER}/${d}` : ASSET_SUBFOLDER;
}
