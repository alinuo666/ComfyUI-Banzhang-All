import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { hasRef, relFromEvent } from "./bz_media_ref.js";

/* =========================================================================
 * H3 Studio — UI
 *
 * Two model families, one node. The accent colour IS the family indicator:
 *   blue  = fl2va  (first / last keyframes)
 *   green = ref2va (9 images, 3 videos, 3 audio)
 * Mismatched weights run fine and produce nonsense, so the node shouts which
 * family it is currently asking for.
 * ====================================================================== */

const NODE_ID = "CSGlideCastLegacyCS";
const ASSET_SUBFOLDER = "cglide";
const FPS = 24;
const MAX_IMAGES = 9, MAX_VIDEOS = 3, MAX_AUDIOS = 3;

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
const VIDEO_EXTS = ["mkv", "mp4", "m4v", "mov", "webm", "avi", "mpg", "mpeg",
                    "ts", "mts", "m2ts", "wmv", "flv", "ogv", "3gp"];
const AUDIO_EXTS = ["mp3", "m4a", "m4b", "aac", "ac3", "ogg", "oga", "opus",
                    "spx", "wma", "mka", "amr", "3ga", "ra",
                    "wav", "wave", "flac", "aiff", "aif", "aifc", "caf",
                    "w64", "pcm", "au", "snd", "ape", "wv", "tta"];
const IMAGE_EXTS = ["png", "jpg", "jpeg", "webp", "avif", "bmp", "tif", "tiff"];

const acceptOf = (exts, prefix) =>
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
const MAX_PIXELS = 768 * 1344;

const RATIOS = [
  { label: "21:9", w: 1536, h: 672 },
  { label: "16:9", w: 1344, h: 768 },
  { label: "3:2",  w: 1152, h: 768 },
  { label: "4:3",  w: 1024, h: 768 },
  { label: "1:1",  w: 768,  h: 768 },
  { label: "3:4",  w: 768,  h: 1024 },
  { label: "2:3",  w: 768,  h: 1152 },
  { label: "9:16", w: 768,  h: 1344 },
];

const SHORT_EDGES = [768, 704, 640, 576, 512, 448, 384, 352, 320];

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
const EXTRA_SIZES = {
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
const REF_STEP = 32, REF_MIN = 32;
const REF_IMAGE_MAX = 4096, REF_VIDEO_MAX = Infinity;
/* 参考视频采样帧率：24=不抽帧；往低调（如 12/8）在时长不变时减少参考帧数、
 * 节省显存，但会降低参考锚定精度。与后端 _clamp_ref_fps 的 4..24 保持一致。 */
const REF_FPS_MIN = 4, REF_FPS_MAX = 24;
const clampRefFps = (v) => {
  const n = Math.round(+v);
  return Number.isFinite(n) ? Math.max(REF_FPS_MIN, Math.min(REF_FPS_MAX, n)) : REF_FPS_MAX;
};

/* 「放大重绘」（二采/三采）条件的参考档位倍数。与后端 _ref_hd_scale 同口径：
   1 = 跟随主档位、不额外编码（接入前的既有行为）；>1 = 参考素材按该倍数重新
   编码，细节更多但每级都要重跑一遍视觉编码器。 */
const REF_SCALE_MIN = 1, REF_SCALE_MAX = 4, REF_SCALE_STEP = 0.25;
const clampRefScale = (v) => {
  const n = Math.round(+v / REF_SCALE_STEP) * REF_SCALE_STEP;
  return Number.isFinite(n) ? Math.max(REF_SCALE_MIN, Math.min(REF_SCALE_MAX, +n.toFixed(2))) : REF_SCALE_MIN;
};


/* Normalise a stored value (from an old dropdown, or a free number) back to
 * "match" or a snapped/clamped number. Old tier strings like "512" degrade to
 * a plain number transparently; "max" still maps to the cap. */
const normRefSize = (v, cap, fallback) => {
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
const renderRefControl = (chk, input, note, value, canvasLong, cap) => {
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
const LENGTH_PRESETS = [124, 243, 362, 481, 600, 719];  // ≈ 5/10/15/20/25/30s

const ALL_TOKENS = [
  "@first", "@last",
  ...Array.from({ length: MAX_IMAGES }, (_, i) => `@图片${i + 1}`),
  ...Array.from({ length: MAX_VIDEOS }, (_, i) => `@视频${i + 1}`),
  ...Array.from({ length: MAX_VIDEOS }, (_, i) => `@视频音频${i + 1}`),
  ...Array.from({ length: MAX_AUDIOS }, (_, i) => `@音频${i + 1}`),
];

const MIN_H_REF = 1330;   // initial node height; the node itself is user-resizable below this
/* 节点最窄下限：设置表单行宽 540 + midWrap 两侧 padding 与间距。低于此值右侧
   续写来源会被挤没、左侧也会溢出——这是「允许收窄」的合理终点，原 900 是拍脑袋
   的保守值，把用户能收窄的幅度白白扣掉了。 */
const MIN_PANEL_W = 560;
/* 手动拖拽模式下报给框架的最小面板高度。前端拖拽以 node.computeSize()
   （=各 widget minHeight 之和）做下限钳制，报内容实测峰值会让节点永远拖不到
   比内容更矮。固定小值 + maxHeight 无限，收短后内容靠 .gcastL 滚动，不塌陷。 */
const MIN_FLOOR_H = 120;
/* Hard safety cap: no matter what a measurement returns, the node is never
   grown past this. A runaway fitNode (or a stale minHeight) used to stretch
   the bottom to infinity; this bounds it so the worst case is a large but
   finite panel the user can drag down. The prompt scrolls inside it, so a
   tall cap here costs nothing. */
const MAX_NODE_H = 6000;
const PROMPT_H_REF = 160, PROMPT_H_FL = 300;   // fl2va has only two slots, so the space goes to the prompt

const alignFrames = (n) => { n = Math.max(5, Math.round(n)); while (n % 17 !== 5) n++; return n; };
/* 最近的 17k+5 帧。alignFrames 只往上顶，用在「已有帧数、把它顶到合法」的地方；
   而自定义时长是「用户报一个秒数、吸附到最近的合法格」，方向该由远近决定。
   这个区别在上下按钮上是决定性的：按钮每次只把秒数改 1，一律往上顶会一次跨两格
   （141 帧 5.88s 按上 → 165 帧再顶到 175），取最近格点才是一格（→158）。 */
const nearestFrames = (n) =>
  5 + 17 * Math.max(0, Math.round((Math.max(5, Math.round(n)) - 5) / 17));
const fmtSecs = (s) => (Math.round(s * 100) / 100).toFixed(2) + "s";
/* 秒 ↔ 帧：自定义时长输入以「秒」为单位。帧数只有落在 17k+5 网格上才合法，
   而用户想说的是「我要 12 秒」——吸附交给 nearestFrames。
   回显只给整数秒（显示层简化，不让 10.13 这类小数挤占本就 42px 的窄框），
   精确值由右侧读出位以「N 帧 · 10.13s」给出，内部换算仍走未取整的
   frames/24——显示取整不参与任何计算，两处换算集中在这里，避免口径漂移。
   空/非法输入回退 124 帧（与旧行为一致）；数值合法但越界（在下限附近按 ↓ 时浏览器
   会给出 0）交给 nearestFrames 夹到下限 5——不能回退 124，否则按 ↓ 会突然跳回 5.17s。
   NaN 必须先挡（alignFrames/nearestFrames 都不认 NaN）。 */
const secsOfFrames = (f) => Math.round(f / FPS);
const framesOfSecs = (s) => {
  if (s == null || String(s).trim() === "") return 124;      // 空 → 回落默认
  const v = +s;
  return Number.isFinite(v) ? nearestFrames(v * FPS) : 124;  // 越界由 nearestFrames 夹到 ≥5
};

/* ---------------------------------------------------------------- state */

function blankState() {
  const mk = (n) => Array.from({ length: n }, () => ({}));
  return {
    mode: "ref2va",
    width: 1344, height: 768,
    ratio: "16:9",        /* locked aspect-ratio family; "custom" unlinks width/height */
    length: 243,
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
  };
}

/* Whitelisted parse. Anything not named here is dropped on reload — on purpose.
 * Adding a new stored field means adding it HERE too, or it vanishes silently. */
function parseInitial(raw) {
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
  if (Number.isFinite(+d.pace) && +d.pace > 0) out.pace = Math.min(4, Math.max(1, +d.pace));
  if (typeof d.prompt === "string") out.prompt = d.prompt;

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
  return out;
}

/* Same ordinal rules as the tokenizer: images, then videos (a soundtrack's
 * <Audio j> lands immediately before its <Video k>), then standalone audio.
 * Ordinals are 1-based per type and count only filled slots.
 * slots: 展示用的合并槽位视图（面板 + 媒体架），缺省用面板自身槽位。
 * 数组长度动态——媒体架槽位按需生长，空位/未选中位传 null 即可跳过。 */
function presentation(st, slots) {
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

/* ---- 媒体架合并视图 + 严格按需过滤（与 csglide_cast.py 同规则镜像） ---- */

/* 找到 refs 输入口接的上游节点（媒体架）。不用 node.getInputNode("refs")：
 * 按名字查输入口在部分 ComfyUI 前端版本下不可靠（本地化/name 改写），一旦
 * 失效媒体架素材就一个都进不了 chips。refs 是本节点唯一的 H3_REFS 类型
 * 输入，按类型匹配 + 手动走 graph.links 最稳；原方法留作兜底。 */
function rackNodeOf(node) {
  const inputs = node.inputs || [];
  const inp = inputs.find((s) => s && s.type === "H3_REFS" && s.link != null)
    || inputs.find((s) => s && s.name === "refs" && s.link != null);
  const graph = (typeof app !== "undefined" && app && app.graph) || null;
  if (inp && graph && graph.links != null) {
    const link = graph.links[inp.link];
    if (link) {
      const up = graph.getNodeById ? graph.getNodeById(link.origin_id) : null;
      if (up) return up;
    }
  }
  return node.getInputNode ? node.getInputNode("refs") : null;
}

let rackParseCache = { raw: null, slots: { images: [], videos: [], audios: [] } };
function rackSlotsOf(node) {
  const w = rackNodeOf(node);
  const raw = (w && w.widgets && w.widgets.find((x) => x.name === "rack_data")?.value) || "";
  if (raw === rackParseCache.raw) return { raw, slots: rackParseCache.slots };
  let d = {};
  try { d = JSON.parse(raw); } catch (_) { d = {}; }
  const s = (d && d.slots) || {};
  const arr = (k) => (Array.isArray(s[k]) ? s[k] : []);
  rackParseCache = { raw, slots: { images: arr("images"), videos: arr("videos"), audios: arr("audios") } };
  return { raw, slots: rackParseCache.slots };
}

/* 外接提示词：找 prompt_text 输入口接的上游文本节点。文本源节点五花八门、
 * widget 名不统一，「最长字符串 widget 值」是最稳的启发式；连线解析与
 * rackNodeOf 同思路（按名找 input + 手动走 graph.links，原方法兜底）。 */
export function promptNodeOf(node) {
  const inputs = node.inputs || [];
  const inp = inputs.find((s) => s && s.name === "prompt_text" && s.link != null);
  const graph = (typeof app !== "undefined" && app && app.graph) || null;
  if (inp && graph && graph.links != null) {
    const link = graph.links[inp.link];
    if (link) {
      const up = graph.getNodeById ? graph.getNodeById(link.origin_id) : null;
      if (up) return up;
    }
  }
  return node.getInputNode ? node.getInputNode("prompt_text") : null;
}
export function upstreamTextOf(n) {
  if (!n) return "";
  let best = "";
  for (const w of n.widgets || []) {
    if (typeof w.value === "string" && w.value.length > best.length) best = w.value;
  }
  if (!best && Array.isArray(n.widgets_values)) {
    for (const v of n.widgets_values) {
      if (typeof v === "string" && v.length > best.length) best = v;
    }
  }
  return best;
}

/* 提示词提到的 @标签 才送；一个都没提就一个都不送（严格按需）。
   未提到的位置保留为 null——编号位置不变，presentation 只数已填槽位。 */
function filterUsedByPrompt(slots, prompt) {
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

/* average delivery rate. Only an estimate of how long the written lines take
 * to say -- it is NOT a target to fill, which is what the old budget got
 * wrong. Coverage of the tail is handled by the soundscape row. */
const WORDS_PER_SEC = 2.5;

const FIELD_BODY  = /^[ \t]*(?:detailed_description|integrated_multimodal_description)[ \t]*:/im;
const FIELD_SOUND = /^[ \t]*overall_soundscape[ \t]*:/im;
const FIELD_MUSIC = /^[ \t]*non_diegetic_music[ \t]*:/im;

const DTAG_RE = /<d>\s*(?:\[[^\]]*\]\s*)?([^<]{1,400})<\/d>/gi;
const QUOTE_RE = /["\u201c]([^"\u201d]{1,400})["\u201d]/g;
/* a quote introduced like this is on-screen text, not speech */
const SCREEN_TEXT = /(read(?:s|ing)?|sign|banner|label|subtitle|caption|placard|logo|title card|neon|lettering|letters|text|marked|stencilled|stenciled|written)\W*$/i;
/* the official form is (S1); (S1,S2) covers simultaneous speech */
const SPEAKER_RE = /\(\s*S\d+\s*(?:,\s*S\d+\s*)*\)/;
/* mouths shut, stated positively -- H3 is CFG-distilled, so "no murmuring"
 * has nothing to push against and lands weakly */
const LIPS_RE = /lips?\s+(?:close|remain|stay|are\s+close)|close[sd]?\s+(?:his|her|their|the)\s+(?:lips|mouth)|mouths?\s+(?:closed|stay|remain)|(?:does|do)\s+not\s+speak\s+again|never\s+speaks?|says?\s+nothing\s+(?:more|further)|no\s+further\s+dialogue/i;
const SILENT_INTENT = /silen|wordless|mute|no speech|no dialogue|no words|no line|not speak|doesn't speak|says? nothing|saying nothing|without speaking|(?:neither|nobody|no one|no-one) speaks?|stays? quiet|remains? quiet|in silence|beat of quiet/i;

/* text of a named field, up to the next field header or the end of the prompt */
const ANY_FIELD = /^[ \t]*[a-z_]{4,}[ \t]*:/gm;
function fieldText(prompt, name) {
  const head = new RegExp("^[ \\t]*" + name + "[ \\t]*:", "im").exec(prompt);
  if (!head) return null;
  const from = head.index + head[0].length;
  let stop = prompt.length, m;
  ANY_FIELD.lastIndex = from;
  while ((m = ANY_FIELD.exec(prompt)) !== null) { stop = m.index; break; }
  return prompt.slice(from, stop).trim();
}

/* Shot markers, official format: "[Shot 2] At 00:03.500," -- Shot 1 carries no
 * timestamp and starts at zero. A shot runs until the next one starts, or to
 * the end of the clip. "At 3.5s," and "At 00:03," are tolerated too, since the
 * guide's MM:SS.mmm is not what people type by hand.
 *
 * The END of a shot is never stated, so it is always inferred. That is the
 * format's own rule, not a guess: shots are contiguous inside one generation. */
const SHOT_RE = /\[\s*shot\s*(\d+)\s*\]([^\n]{0,90})/gi;
const AT_MMSS = /\bat\s+(\d{1,2}):(\d{2})(?:[.,](\d{1,3}))?/i;
const AT_SECS = /\bat\s+(\d{1,3}(?:[.,]\d+)?)\s*s\b/i;

function parseShots(prompt, total) {
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

function spokenLines(text) {
  const out = [];
  let m;
  DTAG_RE.lastIndex = 0;
  while ((m = DTAG_RE.exec(text)) !== null) out.push(m[1].trim());
  if (out.length) return out;          /* tagged prompt: quotes are screen text */
  QUOTE_RE.lastIndex = 0;
  while ((m = QUOTE_RE.exec(text)) !== null) {
    const before = text.slice(Math.max(0, m.index - 48), m.index);
    if (SCREEN_TEXT.test(before)) continue;
    out.push(m[1].trim());
  }
  return out;
}

function promptCheck(prompt, totalSeconds) {
  const p = prompt || "";
  const clip = Math.max(0, +totalSeconds || 0);
  const rows = [];
  if (!p.trim()) return rows;

  /* 1. named fields */
  const missing = [];
  if (!FIELD_SOUND.test(p)) missing.push("overall_soundscape");
  if (!FIELD_MUSIC.test(p)) missing.push("non_diegetic_music");
  if (!FIELD_BODY.test(p) && missing.length === 2) {
    rows.push({ label: "格式", text: "未用命名字段，建议改用 overall_soundscape / non_diegetic_music / detailed_description 结构", state: "warn" });
  } else if (missing.length) {
    rows.push({ label: "格式", text: "缺少字段：" + missing.join("、"), state: "warn" });
  } else {
    rows.push({ label: "格式", text: "命名字段齐全", state: "ok" });
  }

  /* 2. dialogue and speaker id */
  const body = fieldText(p, "detailed_description")
            || fieldText(p, "integrated_multimodal_description")
            || p;
  const lines = spokenLines(body);
  if (!lines.length) {
    rows.push({ label: "对话", text: SILENT_INTENT.test(body) ? "已明确静默" : "无台词", state: "ok" });
  } else if (!SPEAKER_RE.test(body)) {
    rows.push({ label: "对话", text: `${lines.length} 句台词，缺说话人标注 (S1)`, state: "warn" });
  } else {
    rows.push({ label: "对话", text: `${lines.length} 句台词，已标说话人`, state: "ok" });
  }

  /* 3. mouths closed after the last line */
  if (lines.length) {
    rows.push(LIPS_RE.test(body)
      ? { label: "嘴唇", text: "台词结束后已提示合拢嘴唇", state: "ok" }
      : { label: "嘴唇", text: "台词后未提示闭嘴，H3 可能让角色继续张嘴，请补一句闭嘴描述", state: "warn" });
  }

  /* 4. how long the written lines take to say, at an average rate */
  if (lines.length) {
    const words = lines.join(" ").split(/\s+/).filter(Boolean).length;
    const spoken = words / WORDS_PER_SEC;
    const text = `台词约 ${spoken.toFixed(1)}s / 片段 ${clip.toFixed(1)}s`;
    rows.push(spoken > clip
      ? { label: "语音", text: text + " · 台词超出片段时长", state: "warn" }
      : { label: "语音", text, state: "ok" });
  }

  /* 5. soundscape covering the whole clip */
  const sound = fieldText(p, "overall_soundscape");
  if (sound === null) {
    rows.push({ label: "声音", text: "未填写整体音景 overall_soundscape", state: "warn" });
  } else {
    const w = sound.split(/\s+/).filter(Boolean).length;
    rows.push(w < 8
      ? { label: "声音", text: `音景描述仅 ${w} 词，偏单薄`, state: "warn" }
      : { label: "声音", text: `音景描述 ${w} 词`, state: "ok" });
  }

  return rows;
}

/* ------------------------------------------------------------------ css */

const CSS = `
.gcastL {
  --h3-bg:#191919; --h3-panel:#212121; --h3-raise:#2b2b2b; --h3-line:#3b3b3b;
  --h3-well:#131313;
  --h3-txt:#e3e3e3; --h3-dim:#979797; --h3-label:#787878;
  --h3-accent:#58d1ff; --h3-accent-dim:#58d1ff26;
  --gc-wave:#59c14f;
  font-family: ui-sans-serif, system-ui, "Segoe UI", sans-serif;
  color: var(--h3-txt); font-size: 12px; line-height: 1.35;
  /* 节点 body 的 DOM widget（.dom-widget）被设为 pointer-events:none，让点击能
     落回画布；这里给强调根恢复 auto，使节点内所有子元素默认可点。内部装饰层
     （gcastL-wave/gcastL-num/gcastL-wavlabel 等）仍保留自己的 none 保持穿透。 */
  pointer-events:auto;
  position:relative;
  background: var(--h3-bg); border:1px solid var(--h3-line); border-radius:10px;
  padding:10px; display:flex; flex-direction:column; gap:9px;
  box-sizing:border-box; width:100%; min-width:0; height:100%; overflow:auto;
  /* 极窄时个别 nowrap 文案的 min-content 仍可能超出 1~6px：横向一律裁掉，
     不给面板出横向滚动条（纵向滚动不受影响） */
  overflow-x:hidden;
  /* Hard ceiling so a runaway measurement can never stretch the panel to
     infinity: the expanded prompt already scrolls inside the layer, and
     collapsed content is ~1300px, so this cap is only ever a safety net. */
  max-height:6000px;
}
.gcastL[data-mode="fl2va"] { --h3-accent:#59c14f; --h3-accent-dim:#59c14f26; }

/* custom dropdown -------------------------------------------------- */
.gcastL-select { all:unset; pointer-events:auto; cursor:pointer; box-sizing:border-box;
  display:flex; align-items:center; gap:8px; min-width:0;
  background:var(--h3-bg); color:var(--h3-txt); border:1px solid var(--h3-line);
  border-radius:5px; padding:4px 8px; font-size:11.5px; font-family:inherit; }
.gcastL-select:hover { border-color:var(--h3-dim); }
.gcastL-select:focus-visible { outline:2px solid var(--h3-accent); outline-offset:1px; }
.gcastL-select .lbl { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.gcastL-select .caret { margin-left:auto; color:var(--h3-dim); font-size:9px; }
.gcastL-select[aria-disabled="true"] { opacity:.45; cursor:default; }

.gcastL-menu {
  --h3-panel:#212121; --h3-raise:#2b2b2b; --h3-line:#3b3b3b; --h3-well:#131313;
  --h3-txt:#e3e3e3; --h3-dim:#979797; --h3-accent:#58d1ff;
  position:fixed; z-index:9100; box-sizing:border-box;
  font-family: ui-sans-serif, system-ui, "Segoe UI", sans-serif;
  background:var(--h3-panel); border:1px solid var(--h3-line); border-radius:11px;
  padding:7px; display:flex; flex-direction:column; gap:5px;
  max-height:60vh; overflow:auto; box-shadow:0 22px 60px #000d, 0 2px 10px #0009; }
.gcastL-menu[data-mode="fl2va"] { --h3-accent:#59c14f; }
.gcastL-menu button { all:unset; pointer-events:auto; cursor:pointer; box-sizing:border-box;
  display:flex; align-items:center; gap:10px; width:100%;
  background:var(--h3-raise); border:1px solid var(--h3-line); border-radius:8px;
  padding:9px 13px; font-size:12.5px; color:var(--h3-txt); white-space:nowrap; }
.gcastL-menu button:hover { border-color:var(--h3-accent); }
.gcastL-menu button[aria-selected="true"] { color:var(--h3-accent); border-color:var(--h3-accent); }
.gcastL-menu button .note { margin-left:auto; color:var(--h3-dim); font-size:10.5px;
  font-family:ui-monospace,Consolas,monospace; }
.gcastL-menu .grp { padding:3px 4px 1px; font-size:9.5px; letter-spacing:.13em;
  text-transform:uppercase; color:var(--h3-dim); }

.gcastL-label { font-size:9.5px; letter-spacing:.13em; text-transform:uppercase;
  color:var(--h3-label); font-weight:600; }

/* project timeline ----------------------------------------------------
   The whole film across the top of the node: one block per clip, width in
   proportion to its real length - honestly, so the ruler above means what it
   says. A short clip really is a narrow block; zoom in to work with it.
   Colour comes from the clip's id rather than its position, so a block keeps
   its colour when the film is reordered and can be followed while dragging. */
.gcastL-tl { display:flex; flex-direction:column; gap:2px; }
.gcastL-tl.off { display:none; }
.gcastL-tl .head { display:flex; align-items:flex-end; gap:5px; }
.gcastL-tl .tools { display:flex; gap:3px; flex:0 0 auto; padding-bottom:1px; }
.gcastL-tl .tools button { width:17px; height:15px; padding:0; display:grid;
  place-items:center; background:var(--h3-well); color:var(--h3-dim);
  border:1px solid var(--h3-line); border-radius:4px; cursor:pointer;
  transition:color .12s ease, border-color .12s ease; }
.gcastL-tl .tools button:hover:not(:disabled) { color:var(--h3-txt); border-color:var(--h3-accent); }
.gcastL-tl .tools button:disabled { opacity:.35; cursor:default; }
.gcastL-tl .tools button.danger:hover:not(:disabled) { color:#ff8a8a; border-color:#ff8a8a; }
.gcastL-tl .tools svg { width:9px; height:9px; fill:none; stroke:currentColor;
  stroke-width:1.7; stroke-linecap:round; stroke-linejoin:round; }
/* a block too narrow for a label shows none rather than a clipped one */
.gcastL-tl .clip.tiny { padding:0 2px; }
.gcastL-tl .clip.tiny .nm, .gcastL-tl .clip.tiny .du { display:none; }
.gcastL-tl .clip input { width:100%; box-sizing:border-box; font-size:10px;
  padding:1px 3px; border-radius:3px; border:1px solid var(--h3-accent);
  background:rgba(0,0,0,.6); color:#fff; outline:none; }
/* The ruler is a pan surface as well as a scale. Once the strip overflows
   there is no empty track left to grab -- every pixel of it is a block --
   so without this the only way to scroll a long film is the wheel. */
.gcastL-tl .rule { position:relative; height:10px; overflow:hidden;
  touch-action:none; flex:1 1 auto; min-width:0; }
.gcastL-tl .rule.pannable { cursor:grab; }
.gcastL-tl .rule.panning { cursor:grabbing; }
.gcastL-tl .rule .t { position:absolute; bottom:0; width:1px; height:3px;
  background:var(--h3-dim); opacity:.32; }
.gcastL-tl .rule .t.maj { height:6px; opacity:.65; }
.gcastL-tl .rule .lbl { position:absolute; top:0; margin-left:3px; line-height:1;
  font-family:ui-monospace,Consolas,monospace; font-size:8px; color:var(--h3-dim);
  opacity:.75; }
.gcastL-tl .view { position:relative; height:41px; overflow:hidden; border-radius:7px;
  background:var(--h3-well); box-shadow:inset 0 1px 3px rgba(0,0,0,.38);
  touch-action:none; }
.gcastL-tl .view.pannable { cursor:grab; }
.gcastL-tl .view.panning { cursor:grabbing; }
/* panned by left, not by transform: a transformed layer inside the canvas
   zoom is rasterised at one scale and composited at another, which is what
   put the prompt colouring a letter out. Nothing here has to line up with a
   caret, but the text would still soften for no gain. */
.gcastL-tl .strip { position:absolute; top:0; bottom:0; }
.gcastL-tl .clip { position:absolute; top:0; bottom:0; border-radius:6px;
  box-sizing:border-box; padding:0 7px 0 12px; overflow:hidden; cursor:pointer;
  display:flex; flex-direction:column; justify-content:center; gap:1px;
  /* A card, not a colour block: near-black body with the clip's colour as a
     solid edge down the left and a bloom off it. That replaces the old dark
     ramp, which existed because colours are keyed to clip IDENTITY, so two
     neighbours can draw the same colour and a shared edge between two flat
     fills is invisible. A hard colour bar at every block start says it louder. */
  background:linear-gradient(90deg, var(--cg, #ffffff1a) 0px, var(--cw, #ffffff0f) 24px,
             #ffffff00 66%), var(--h3-panel);
  box-shadow:inset 0 0 0 2px #ffffff17, 0 1px 3px rgba(0,0,0,.45);
  transition:left .15s cubic-bezier(.2,.7,.3,1), filter .12s ease, box-shadow .12s ease; }
.gcastL-tl .clip::before { content:""; position:absolute; left:0; top:0; bottom:0;
  width:4px; border-radius:6px 0 0 6px; background:var(--c, #444); }
.gcastL-tl .clip.nomove { transition:filter .12s ease, box-shadow .12s ease; }
.gcastL-tl .clip .nm { font-size:12px; line-height:1.15; color:#fff; opacity:.96;
  text-shadow:0 1px 2px rgba(0,0,0,.55); white-space:nowrap; overflow:hidden;
  text-overflow:ellipsis; }
.gcastL-tl .clip .du { font-family:ui-monospace,Consolas,monospace; font-size:9.5px;
  line-height:1; color:#fff; opacity:.66; text-shadow:0 1px 2px rgba(0,0,0,.55);
  white-space:nowrap; }
.gcastL-tl .clip:hover { filter:brightness(1.18); }
/* Skipped clips stay legible but plainly out of the run: greyed and dropped
   back, never hidden and never a different height -- the timeline is how you
   read the shape of the project, and a block that changes size when you skip
   it makes the whole strip jump. Grey reads at any zoom, including blocks too
   narrow to carry the dot. */
.gcastL-tl .clip.off { filter:grayscale(1); opacity:.45; }
.gcastL-tl .clip.off:hover { filter:grayscale(1) brightness(1.3); opacity:.62; }
.gcastL-tl .clip.off .nm { opacity:.8; }
/* The dot is the CONTROL, and it degrades where the state does not: below a
   readable width it would be a 6px target sitting on a draggable block, which
   is a mis-click waiting to happen. The block still shows its state; you just
   toggle it from the project list or with Alt-click. */
.gcastL-tl .clip .sk { position:absolute; top:3px; right:4px; width:13px; height:13px;
  border:0; padding:0; border-radius:50%; background:#00000059; color:#fff;
  font-size:8px; line-height:13px; text-align:center; cursor:pointer;
  opacity:.5; transition:opacity .12s ease, background .12s ease; z-index:2; }
.gcastL-tl .clip .sk:hover { opacity:1; background:#000000a6; }
.gcastL-tl .clip.off .sk { opacity:.9; }
.gcastL-tl .clip.hasdot { padding-right:21px; }
.gcastL-tl .clip.on { box-shadow:inset 0 0 0 2px var(--h3-accent), 0 2px 7px rgba(0,0,0,.55); }
.gcastL-tl .clip.on .nm { opacity:1; }
.gcastL-tl .clip.lifted { opacity:.3; }
/* where the dragged clip would land */
.gcastL-tl .drop { position:absolute; top:-1px; bottom:-1px; width:3px; margin-left:-1.5px;
  background:#fff; border-radius:2px;
  box-shadow:0 0 0 1px rgba(0,0,0,.55), 0 0 9px rgba(255,255,255,.75);
  pointer-events:none; z-index:3; }
/* Links. A linked pair is drawn as one run: no gap between the blocks, the
   touching corners squared off, and an accent rule along the bottom of every
   block in the run - readable at any zoom, including blocks too narrow for
   the button. The rule is an ::after because the block clips its own
   overflow and ::before is already the colour edge. */
.gcastL-tl .clip.lp { border-top-left-radius:0; border-bottom-left-radius:0; }
.gcastL-tl .clip.lp::before { border-radius:0; }
.gcastL-tl .clip.ln { border-top-right-radius:0; border-bottom-right-radius:0; }
.gcastL-tl .clip.lk::after { content:""; position:absolute; left:0; right:0; bottom:0;
  height:2px; opacity:.9; pointer-events:none;
  background:repeating-linear-gradient(90deg, #ff9f43 0 6px, transparent 6px 10px); }
/* The control sits ON the seam, in the strip rather than in either block -
   both blocks clip their overflow, so a child of one could not straddle the
   edge. Invisible at rest when unlinked so it does not litter every boundary;
   the whole strip reveals them on hover. Linked ones stay lit. */
.gcastL-tl .lnk { position:absolute; top:calc(50% - 8px); width:16px; height:16px;
  margin-left:-8px; padding:0; border:1px solid #ffffff38; border-radius:50%;
  background:#141414e6; color:#bdbdbd; display:grid; place-items:center;
  cursor:pointer; pointer-events:auto; z-index:4; opacity:0;
  transition:opacity .12s ease, border-color .12s ease, color .12s ease; }
.gcastL-tl .lnk svg { width:10px; height:10px; fill:none; stroke:currentColor;
  stroke-width:1.5; stroke-linecap:round; }
.gcastL-tl .view:hover .lnk { opacity:.6; }
.gcastL-tl .lnk:hover { opacity:1; color:#fff; border-color:#ff9f43; }
.gcastL-tl .lnk.on { opacity:1; background:#ff9f43; border-color:#ff9f43;
  color:#111; }
.gcastL-tl .view:hover .lnk.on { opacity:1; }
/* Blocks slide during a drag and the seams move with them, so the controls
   would sit on boundaries that no longer exist. Gone until the drop repaints. */
.gcastL-tl .strip.dragging .lnk { display:none; }
.gcastL-tl .clip.virtual { cursor:default; }

/* mode bar ---------------------------------------------------------- */
.gcastL-modebar { display:flex; align-items:center; gap:10px;
  background:linear-gradient(90deg, var(--h3-accent-dim), transparent 65%);
  border:1px solid var(--h3-line); border-left:3px solid var(--h3-accent);
  border-radius:8px; padding:7px 10px; }
.gcastL-seg { display:flex; background:var(--h3-bg); border:1px solid var(--h3-line);
  border-radius:7px; padding:2px; gap:2px; }
.gcastL-seg button { all:unset; pointer-events:auto; cursor:pointer; padding:5px 13px; border-radius:5px;
  font-size:11.5px; font-weight:600; color:var(--h3-dim); transition:.13s; }
.gcastL-seg button:hover { color:var(--h3-txt); }
.gcastL-seg button[aria-pressed="true"] { background:var(--h3-accent); color:#101010; }
.gcastL-seg button:focus-visible { outline:2px solid var(--h3-accent); outline-offset:1px; }
.gcastL-need { margin-left:auto; font-family:ui-monospace,Consolas,monospace; font-size:10.5px;
  color:var(--h3-dim); }
.gcastL-need b { color:var(--h3-accent); font-weight:600; }

/* settings row ------------------------------------------------------ */
/* 设置区：紧凑表单（方案 B）——每行「标签定宽 + 控件 + 读出右对齐」，行间只用
   细分隔线，不再给每项描边成卡片。设置是参数表不是内容块，卡片层级让给续写
   来源与提示词；省下的高度直接还给提示词区。
   min-width:0 / minmax(0,1fr)：控件与文案的 min-content 会托住轨道，节点收窄
   时必须显式压到 0，宽度才真正由 flex 分配。 */
/* flex-basis 用 320 而不是 540：basis 是「开始收缩的门槛」，写 540 时逻辑容器
   要窄到 549 以下左栏才肯收，结果节点 980→620 全程左栏纹丝不动、右边续写卡
   被压成 0（用户反馈「四张卡片宽度固定收不窄」的真因）。basis 320 + max-width
   540 后：宽屏仍然吃满 540（外观不变），窄屏与续写卡按比例一起收。
   basis 取 240 而非 320：节点拖拽下限实测是 664（minWidth 560 + 框架 104），
   用户真正够得到的区间只有 664~980。basis 320 在该区间只收 486→417（-14%）；
   240 可收到 381（-21%）且仍高于表单行 min-content 410 的溢出线，不会裁字。 */
.gcastL-row { display:flex; flex-direction:column; flex:1 1 240px;
  max-width:540px; padding:0 10px; min-width:0; }
.gcastL-field { display:flex; align-items:center; gap:7px; min-height:30px;
  min-width:0; overflow:hidden; border-bottom:1px solid var(--h3-line); }
.gcastL-field:last-child { border-bottom:0; }
.gcastL-flabel { flex:0 0 62px; font-size:11px; font-weight:600; letter-spacing:.06em;
  color:var(--h3-label); white-space:nowrap; }
.gcastL-ctl { display:flex; align-items:center; gap:5px; flex-wrap:wrap; }
.gcastL select, .gcastL input[type="number"] {
  background:var(--h3-bg); color:var(--h3-txt); border:1px solid var(--h3-line);
  border-radius:5px; padding:4px 6px; font-size:11.5px; font-family:inherit; outline:none; }
.gcastL select:focus-visible, .gcastL input:focus-visible, .gcastL textarea:focus-visible {
  border-color:var(--h3-accent); }
.gcastL input[type="number"] { width:62px; }
.gcastL-read { font-family:ui-monospace,Consolas,monospace; font-size:11px; color:var(--h3-dim); }
.gcastL-read b { color:var(--h3-txt); font-weight:600; }
/* 表单行：全行唯一字号 11px（层级只靠颜色与字重区分，不再用字号），
   控件统一 22px 高。下拉改按内容宽度自适应——flex:1 曾把 "10s" 撑成 121px
   的空壳框，"框很大"的根因就在这里。数据读出放弃等宽：中文在等宽字体下会
   回退到系统字体反而更乱，改用同字体 + 等宽数字 tabular-nums。 */
.gcastL-field .gcastL-ctl { flex-wrap:nowrap; gap:6px; min-width:0; }
/* 控件字号与高度统一：数字框、下拉、按钮一律 10px / 20px。原先三者各为
   11/11/11px 且高度不一，数字框窄、字号却与按钮一样大，4 位数（如 1888）
   必然被截。gcastL-select 是 all:unset 的按钮，自身没有默认高度，必须在此
   显式给 height，否则它按内容行高排、与旁边 20px 的数字框差一截。 */
.gcastL-field input[type="number"], .gcastL-field .gcastL-select,
.gcastL-field select.gcastL-btn, .gcastL-btn {
  height:20px; box-sizing:border-box; font-size:10px; }
.gcastL-field select.gcastL-btn { padding:0 5px; }
.gcastL-field .gcastL-select { flex:0 1 auto; min-width:0; padding:0 5px; gap:5px; }
.gcastL-field .gcastL-select .caret { font-size:10px; }
/* flex 由 autoWidth 在 JS 里逐个钉成 0 0 auto（否则 flex-shrink 会把按内容
   算出的宽度压回去，长值照旧截断）；此处不写 flex，留给 JS 决定。 */
.gcastL-field .gcastL-ctl input[type="number"] { width:44px; min-width:0;
  text-align:center; padding:0 2px; letter-spacing:-.01em; }
.gcastL-field .gcap { font-size:11px; font-family:inherit; color:var(--h3-dim);
  white-space:nowrap; flex:0 0 auto; }
.gcastL-field .gcap.dim-x { color:var(--h3-label); padding:0 2px; }
.gcastL-field input[type="checkbox"] { accent-color:var(--h3-accent);
  width:13px; height:13px; margin:0; flex:0 0 auto; }
.gcastL-field .gcastL-read { font-size:10px; font-family:inherit;
  font-variant-numeric:tabular-nums; color:var(--h3-dim); margin-left:auto;
  min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
  text-align:right; }
.gcastL-field .gcastL-read b { color:var(--h3-txt); font-weight:600; }
/* slots ------------------------------------------------------------- */
.gcastL-grid { display:grid; gap:7px; }
.gcastL-grid.img { grid-template-columns:repeat(9, minmax(0,1fr)); }
/* 首尾帧（fl）与多参考（fl3）按固定列宽而非等分：等分会让每格吃掉整行宽度，
   缩略图被拉得过宽、修剪条与波形一起变松垮。固定 190px 让卡片保持紧凑，
   右侧余宽留给续写卡。minmax(0,190px) 保证窄节点下仍能收缩。 */
.gcastL-grid.fl  { grid-template-columns:repeat(2, minmax(0,190px)); }
.gcastL-grid.med { grid-template-columns:repeat(3, minmax(0,190px)); }
/* One extra column so the continuation rides in the SAME row as the reference
   slots. It had a section of its own below them, and that cost a whole row of
   node height for one card. */
/* grid 行默认按内容高度（auto），不会跟着分栏的 align-items:stretch 长高——
   这正是续写卡右侧留空白的真因：容器被 flex 撑高了，卡片本身没长。
   grid-template-rows:1fr 让唯一的续写卡占满整行，高度交给 flex:1 的缩略图分配。 */
.gcastL-grid.med4 { grid-template-columns:1fr; grid-template-rows:1fr; }
.gcastL-grid.fl3  { grid-template-columns:repeat(3, minmax(0,190px)); }

.gcastL-slot { position:relative; background:var(--h3-panel); border:1px solid var(--h3-line);
  border-radius:7px; overflow:hidden; cursor:pointer; transition:.13s;
  box-shadow:0 2px 6px rgba(0,0,0,.45); }
.gcastL-slot:hover { border-color:var(--h3-dim); }
.gcastL-slot.filled { border-color:var(--h3-accent); }
.gcastL-slot.drop { border-color:var(--h3-accent); background:var(--h3-accent-dim); }
/* While a file is over the node, every slot that could take it lifts out of
   the background, so a near-miss is visible before the release rather than
   after. The slot actually under the pointer keeps the stronger .drop look. */
.gcastL-armed { outline:1px dashed var(--h3-accent); outline-offset:-2px;
  background:var(--h3-accent-dim); }
.gcastL-armed .gcastL-empty { color:var(--h3-accent); opacity:1; }
.gcastL-reject { border-color:#b4544f !important; background:rgba(180,84,79,.14) !important; }
/* Only the slot UNDER THE POINTER reads as the target. Arming every slot that
   could take the file lit up all nine images or all four video cards at once,
   which reads as everything-selected rather than as a hint. Neutralised per
   slot type, not by one blanket rule: gcastL-armed lands on the THUMB for a
   video and on the card for an image, so a single background:transparent took
   the dark well with it. Each gets its own background back. Two classes beats
   the one-class gcastL-armed rules above, and source order settles the rest. */
.gcastL-thumb.gcastL-armed { outline:none; background:var(--h3-well); }
.gcastL-wav.gcastL-armed   { outline:none; background:var(--h3-well); }
.gcastL-slot.gcastL-armed  { outline:none; background:var(--h3-panel); }
.gcastL-armed .gcastL-empty { color:#525252; opacity:.9; }
/* The hovered target. Media slots wire their drop on an INNER element - the
   thumb for video, the waveform for an empty audio - so the drop class lands
   there and the gcastL-slot.drop rule never matched them. Without this the slot
   under the pointer showed nothing, which is why they all looked the same. */
.gcastL-media.drop, .gcastL-media .gcastL-thumb.drop, .gcastL-media .gcastL-wav.drop {
  border-color:var(--h3-accent); background:var(--h3-accent-dim);
  box-shadow:inset 0 0 0 1px var(--h3-accent); }
.gcastL-thumb { width:100%; aspect-ratio:1/1; display:flex; align-items:center; justify-content:center;
  background:var(--h3-well); }
.gcastL-grid.fl .gcastL-thumb, .gcastL-grid.fl3 .gcastL-thumb { aspect-ratio:16/9; }
.gcastL-thumb img, .gcastL-thumb video { width:100%; height:100%; display:block; }
/* 视频等比例完整显示（contain），不裁边：竖屏素材在 16:9 框内左右留黑、
   上下完整可见，而不是被 cover 切成一条。图片仍走各自规则（img 槽 contain、
   悬浮预览 cover 保持）。 */
.gcastL-thumb video { object-fit:contain; }
/* Reference images keep their native aspect ratio instead of being cropped to
   the square slot. Empty slots keep the square for the "+" placeholder. */
.gcastL-slot.filled .gcastL-thumb { aspect-ratio:auto; }
.gcastL-slot.filled .gcastL-thumb img { width:100%; height:auto; object-fit:contain; }
/* Reference-image box: all nine slots share one bordered box laid out as a
   3x3 grid (read left-to-right, top-to-bottom). Cells keep one fixed height so
   a tall portrait reference no longer blows the rack up, and the image stays
   contained -- never cropped -- inside it. */
.gcastL-imgbox { background:var(--h3-panel); border:1px solid var(--h3-line);
  border-radius:8px; padding:7px; display:flex; flex-direction:column; gap:7px; }
.gcastL-grid.img .gcastL-slot { padding:4px; display:flex; flex-direction:column; gap:4px; }
/* Border colour follows the video/audio cards exactly: quiet grey until a file
   is in, accent once filled, no hover shift. */
.gcastL-grid.img .gcastL-slot:hover { border-color:var(--h3-line); }
.gcastL-grid.img .gcastL-thumb { position:relative; width:100%; height:48px; aspect-ratio:auto; }
.gcastL-grid.img .gcastL-thumb img { width:100%; height:100%; object-fit:contain; object-position:center; }
/* Corner number dot: a perfect circle, no stroke, pale-blue tint, white digit.
   Its own class so the FL/REF text badge styles never leak into it. */
.gcastL-num { position:absolute; left:2px; top:2px; z-index:2; pointer-events:none;
  display:inline-flex; align-items:center; justify-content:center; box-sizing:border-box;
  width:8px; height:8px; min-width:8px; min-height:8px; flex:0 0 auto; padding:0; margin:0;
  border:none; outline:none; box-shadow:none; border-radius:50%;
  font-family:ui-monospace,Consolas,monospace; font-size:6px; font-weight:700;
  line-height:1; letter-spacing:0; color:#fff; background:rgba(88,209,255,.5); }
/* Caption bar on each cell: just the original filename (6px so long names fit)
   with the clear control pushed to the far end. */
.gcastL-grid.img .gcastL-cap { padding:0; gap:4px; font-size:6px; line-height:1.3; }
.gcastL-grid.img .gcastL-cap .fn { flex:1 1 auto; min-width:0; overflow:hidden;
  text-overflow:ellipsis; white-space:nowrap; opacity:.8; }
.gcastL-grid.img .gcastL-cap .gcastL-x { font-size:10px; padding:0 1px; }
/* Reorder affordance: the picture is what moves, the cell keeps its number. */
.gcastL-grid.img .gcastL-slot { cursor:grab; }
/* 「＋ 添加」格：常驻各类槽位末尾，按需追加空槽位。共用——媒体架与 Qwen
   编辑台都用同一张样式表，各写一份迟早会漂。 */
.gcastL-addtile { border:1px dashed var(--h3-line); border-radius:7px; min-height:48px;
  display:flex; align-items:center; justify-content:center;
  color:var(--h3-dim); font-size:11px; cursor:pointer; user-select:none; }
.gcastL-addtile:hover { border-color:var(--h3-accent); color:var(--h3-accent); }
.gcastL-empty { color:#525252; font-size:18px; font-weight:300; }
/* 预览缺失（/view 404 或浏览器解不了码）时的占位：警示色、可读、给行动建议 */
.gcastL-broken { display:flex; flex-direction:column; align-items:center; justify-content:center;
  gap:3px; width:100%; height:100%; padding:4px; box-sizing:border-box;
  background:#3a1e1e; border:1px dashed #a05252; border-radius:5px;
  color:#ffb3b3; text-align:center; }
.gcastL-broken-ico { font-size:14px; line-height:1; }
.gcastL-broken-txt { font-size:8px; line-height:1.25; opacity:.9; }
.gcastL-cap { display:flex; align-items:center; gap:5px; padding:4px 6px;
  font-family:ui-monospace,Consolas,monospace; font-size:10px; color:var(--h3-dim); }
.gcastL-slot.filled .gcastL-cap { color:var(--h3-accent); }
.gcastL-cap .n { opacity:.55; }
.gcastL-cap .spacer { margin-left:auto; }
.gcastL-last { all:unset; pointer-events:auto; cursor:pointer; padding:1px 6px; border-radius:4px;
  border:1px solid #4d3b22; color:#e8a758; font-size:9px; line-height:1.5;
  font-family:ui-monospace,Consolas,monospace; }
.gcastL-last:hover { border-color:#ff9f43; color:#ff9f43; background:#ff9f4314; }
.gcastL-last:focus-visible { outline:2px solid #ff9f43; outline-offset:1px; }
.gcastL-last[disabled] { opacity:.45; cursor:default; }
.gcastL-last.warn { border-color:#c8892f; color:#ffc069; }
.gcastL-last.warn:hover { border-color:#ffc069; background:#ffc0691a; }
.gcastL-chroma { position:absolute; left:5px; top:5px; z-index:3; pointer-events:auto;
  font-family:ui-monospace,Consolas,monospace; font-size:8px; line-height:1.5;
  padding:1px 5px; border-radius:3px; cursor:help; white-space:nowrap;
  background:#0b0b0bcc; border:1px solid #3f7d4f; color:#6fe08a; }
.gcastL-chroma.weak { border-color:#b5502a; color:#ff8a5c; }

/* The run overlay covers the panel on purpose: while a run owns the node,
   editing a clip that is about to be queued would silently change what gets
   rendered. Blocking input is simpler to reason about than disabling widgets
   one by one, and Stop is the only thing that stays live. */
.gcastL.running { position:relative; }
.gcastL-run { position:absolute; inset:0; z-index:60; display:flex;
  align-items:center; justify-content:center; background:#07070799;
  backdrop-filter:blur(1.5px); }
.gcastL-run .card { display:flex; flex-direction:column; gap:7px; align-items:center;
  padding:16px 22px; border-radius:8px; background:#141414f2;
  border:1px solid var(--h3-accent); box-shadow:0 10px 34px #000a; }
.gcastL-run .ttl { font-size:11px; color:var(--h3-accent); letter-spacing:.04em; }
.gcastL-run .msg { font-family:ui-monospace,Consolas,monospace; font-size:12px; color:#e8e8e8; }
.gcastL-run .sub { font-size:10px; color:var(--h3-dim); min-height:12px; }
.gcastL-shots-foot.run .lbl { color:var(--h3-accent); }
.gcastL-runmode { background:#191919; color:#ccc; border:1px solid #333; border-radius:4px;
  font-size:10px; padding:2px 4px; font-family:inherit; }
.gcastL-btn.run { border-color:var(--h3-accent); color:var(--h3-accent); }
.gcastL-btn.run:hover:not([disabled]) { background:#ff9f4318; }
.gcastL-x { all:unset; pointer-events:auto; cursor:pointer; margin-left:auto; color:var(--h3-dim); padding:0 3px;
  border-radius:3px; font-size:12px; line-height:1; }
.gcastL-x:hover { color:#ff7a7a; background:#ff7a7a1a; }

/* media cards ------------------------------------------------------- */
.gcastL-media { background:var(--h3-panel); border:1px solid var(--h3-line); border-radius:7px;
  overflow:hidden; padding:7px; display:flex; flex-direction:column; gap:6px; }
/* 节点收窄时网格卡（续写来源等）允许缩到轨道宽并裁掉内容，min-content 不再
   把卡片托出面板（横向溢出的元凶就是卡内「续写来源」标签的 nowrap 最小宽） */
.gcastL-grid > * { min-width:0; }
.gcastL-media.filled { border-color:var(--h3-accent); }
/* Amber, not the accent: the continuation is not a reference, it is where this
   clip picks up from. Different job, different colour, so the eye never files
   it with the slots either side of it. */
.gcastL-media.cont { background:#221c15; border-color:#4d3b22; }
.gcastL-media.cont.filled { border-color:#ff9f43; }
.gcastL-media.cont .gcastL-cap { color:#e8a758; }
.gcastL-media.cont .gcastL-ico { color:#ff9f43; display:flex; flex:0 0 auto; }
.gcastL-media.cont .gcastL-chk { color:#e8a758; }
.gcastL-media .gcastL-thumb { aspect-ratio:16/9; border-radius:5px; overflow:hidden; cursor:pointer; }
/* 续写卡（med4 单列全宽）的高度必须向左列四卡看齐，而不是自己定高：
   aspect-ratio:16/9 会让缩略图随余宽变高，反过来把整条分栏撑开。
   改为 flex 填充——但修剪条（波形+播放行+快速帧档+复选框）本身已比
   四卡总高还高，min-height:0 会把缩略图压成 0px、视频整条看不见，
   所以给一个 96px 的可见下限：四卡保持内容高，续写卡略高于四卡。
   Source order matters here: same specificity as the 16/9 rule above, so this
   has to come AFTER it or it never applies. */
/* 续写卡（med4 单列全宽）必须真正铺满右侧余宽，而不是靠 min-height 兜一个
   96px 下限——那正是截图里右侧留一大块空白的原因。改为：卡片本身撑满分栏高度
   （align-items:stretch 已在容器上），缩略图 flex:1 吃掉修剪条以外的全部剩余，
   min-height 保 96px 只作为修剪条本身过高时的兜底。 */
.gcastL-grid.med4 .gcastL-thumb { aspect-ratio:auto; flex:1 1 0; min-height:96px; }
/* 档位按钮行现在位于卡片内部首位：给卡片加 7px 顶部内边距、按钮行自身去掉
   外边距，使「文件续写」与下方「续写来源」标题之间保持与其他卡片一致的间距，
   而不是紧贴卡片顶边。 */
.gcastL-media.cont > .gcastL-bar:first-child { margin: -2px 0 1px; }
.gcastL-grid.fl3 .gcastL-thumb { aspect-ratio:6/5; }
.gcastL-wav { width:100%; height:34px; background:var(--h3-well); border-radius:5px; cursor:pointer;
  display:flex; align-items:center; justify-content:center; color:#525252; font-size:11px; }

.gcastL-trim { padding:2px 0 0; }
.gcastL-track { position:relative; height:44px; cursor:pointer;
  background:var(--h3-well); border-radius:5px; overflow:hidden; }
.gcastL-wave { position:absolute; inset:0; width:100%; height:100%; display:block; }
.gcastL-wavlabel { position:absolute; inset:0; display:flex; align-items:flex-start;
  justify-content:center; padding-top:2px; font-size:10.5px; color:var(--h3-dim);
  pointer-events:none; text-shadow:0 1px 4px #000, 0 0 10px #000; letter-spacing:.02em; }
.gcastL-span { position:absolute; top:0; bottom:0; background:var(--gc-wave);
  opacity:.13; pointer-events:none; }
.gcastL-track.slidable { cursor:grab; }
.gcastL-track.sliding { cursor:grabbing; }
.gcastL-track.sliding .gcastL-span { opacity:.24; }
.gcastL-used { position:absolute; top:0; bottom:0; border-right:1px dashed var(--h3-dim); }
.gcastL-head { position:absolute; top:0; bottom:0; width:1px; background:#fff;
  opacity:.85; display:none; pointer-events:none; }
.gcastL-play { all:unset; pointer-events:auto; cursor:pointer; width:22px; height:22px; border-radius:50%;
  display:flex; align-items:center; justify-content:center; flex:0 0 auto;
  border:1px solid var(--h3-line); color:var(--h3-dim); font-size:9px; }
.gcastL-play:hover { border-color:var(--h3-accent); color:var(--h3-accent); }
.gcastL-play:focus-visible { outline:2px solid var(--h3-accent); outline-offset:1px; }
.gcastL-play.on { border-color:var(--h3-accent); color:var(--h3-accent); }
/* 11px was wider than a short span: at 22f on a 13s clip the selection is about
   20px, so the two handles covered it completely and there was no span left to
   grab -- every slide became a jump-to-pointer instead of a relative drag.
   Visible width halved to 6px. The grab area is padded back OUTWARD only, away
   from the selection, so the handle stays easy to hit without stealing the
   middle of the window back. */
.gcastL-h { position:absolute; top:4px; width:6px; height:36px; margin-left:-3px; border-radius:3px;
  background:var(--gc-wave); cursor:ew-resize; box-shadow:0 0 0 1px #101010;
  touch-action:none; }
.gcastL-h::after { content:""; position:absolute; top:-3px; bottom:-3px; }
.gcastL-h.a::after { left:-5px; right:0; }
.gcastL-h.b::after { left:0; right:-5px; }
.gcastL-track { touch-action:none; }
.gcastL-quick { display:flex; gap:4px; flex-wrap:wrap; }
.gcastL-quick button { all:unset; pointer-events:auto; cursor:pointer; padding:2px 7px; border-radius:4px;
  border:1px solid var(--h3-line); font-family:ui-monospace,Consolas,monospace;
  font-size:10px; color:var(--h3-dim); }
.gcastL-quick button:hover { border-color:var(--h3-accent); color:var(--h3-accent); }
.gcastL-quick button:focus-visible { outline:2px solid var(--h3-accent); outline-offset:1px; }
.gcastL-h:focus-visible { outline:2px solid #fff; outline-offset:1px; }
.gcastL-times { display:flex; align-items:center; gap:7px; justify-content:space-between;
  font-family:ui-monospace,Consolas,monospace; font-size:10px; color:var(--h3-dim); }
.gcastL-times > * { white-space:nowrap; }
.gcastL-times span:last-child { text-align:right; }
.gcastL-chk { display:flex; align-items:center; gap:5px; font-size:11px; color:var(--h3-dim);
  cursor:pointer; user-select:none; }
.gcastL-chk input { accent-color:var(--h3-accent); margin:0; }

/* prompt ------------------------------------------------------------ */
/* pWrap is a positioned parent so the gutter can be placed against it. */
.gcastL-pwrap { position:relative; }
/* 提示词常驻在流内：吃掉节点剩余高度（节点拖多高，编辑区就多大），
   展开/收起浮层机制已删除。 */
.gcastL-promptfill { flex:1 1 auto; min-height:0; }
.gcastL-promptfill .gcastL-ed { flex:1 1 auto; }
.gcastL-phead { display:flex; align-items:center; gap:8px; }
/* 外接提示词：只读镜像编辑器 + 标题徽章 */
.gcastL-ed.gcastL-ro { cursor:default; }
.gcastL-ed.gcastL-ro .tok { pointer-events:auto; }
.gcastL-extbadge { font-size:9.5px; letter-spacing:.08em; color:var(--h3-accent, #7fb2ff);
  border:1px solid currentColor; border-radius:20px; padding:1px 8px; white-space:nowrap; }

/* shot timeline: one thin band across the node standing for the whole clip,
   split where the [Shot N] markers say. Reading a shot list as timestamps
   buried in prose is the slow way to notice that shot 3 starts after the
   clip has ended. */
/* the prompt's left margin, colour-matched to the timeline segments */
/* clip-path as well as overflow: the dots are moved by a compositor-driven
   transform below, and clip-path clips a transformed descendant reliably. */
.gcastL-gutter { position:absolute; width:6px; overflow:hidden; clip-path:inset(0);
  pointer-events:none; z-index:1; }
.gcastL-gutter .inner { position:absolute; left:0; right:0; top:0; bottom:0; }
.gcastL-gutter .dot { position:absolute; left:0; width:6px; height:6px; border-radius:50%; }

/* Zero-lag scroll sync where the browser supports it.
   A JS scroll listener always runs a frame after the compositor has already
   moved the text, which is the visible lag. Binding the transform to the
   textarea's own scroll timeline moves the dots in the SAME frame. Falls back
   to repainting from scrollTop when unsupported. */
.gcastL-pwrap { timeline-scope: --gcastLPrompt; }
.gcastL-pwrap > .gcastL-ed { scroll-timeline-name: --gcastLPrompt; scroll-timeline-axis: y; }
.gcastL-gutter .inner.sdriven { animation: gcastL-gutter-scroll linear both;
  animation-timeline: --gcastLPrompt; }
@keyframes gcastL-gutter-scroll {
  from { transform: translateY(0); }
  to   { transform: translateY(var(--gcastL-scroll-max, 0px)); }
}
/* offscreen twin of the textarea, used only to measure where each marker lands */
.gcastL-mirror { position:absolute; left:-99999px; top:0; visibility:hidden;
  pointer-events:none; }
.gcastL-shotbar { display:flex; flex-direction:column; gap:2px; }
.gcastL-shotbar .ruler { position:relative; height:11px; }
.gcastL-shotbar .ruler .t { position:absolute; bottom:0; width:1px;
  background:var(--h3-dim); opacity:.4; }
.gcastL-shotbar .ruler .t.maj { opacity:.75; }
.gcastL-shotbar .ruler .lbl { position:absolute; top:0; margin-left:3px; line-height:1;
  font-family:ui-monospace,Consolas,monospace; font-size:8px; color:var(--h3-dim); }
.gcastL-shotbar .band { position:relative; display:flex; height:22px; width:100%;
  border-radius:5px; overflow:hidden; background:var(--h3-well); gap:1px; }
/* Wide grab area, thin visible line. 17px is easy to catch on a busy strip,
   but what you SEE stays a 2px seam - a 17px marker would cover the very
   segment edge you are trying to place. */
.gcastL-shotbar .bnd { position:absolute; top:0; bottom:0; width:17px;
  margin-left:-8px; cursor:col-resize; touch-action:none; z-index:2; }
.gcastL-shotbar .bnd::after { content:""; position:absolute; left:7px; top:0; bottom:0;
  width:2px; border-radius:1px; background:#fff; opacity:.3; transition:.12s; }
.gcastL-shotbar .bnd:hover::after { opacity:.8; }
.gcastL-shotbar .bnd.on::after { opacity:1; background:var(--h3-txt); }
.gcastL-shotbar .seg { height:100%; min-width:0; overflow:hidden;
  display:flex; align-items:center; }
/* White ink, with a soft shadow so it survives the lighter colours in the
   cycle (the ochre and the sand) as well as the blues. */
.gcastL-shotbar .seg .lab { min-width:0; padding:0 6px; font-size:10px; line-height:1;
  color:#fff; opacity:.96; text-shadow:0 1px 2px rgba(0,0,0,.55);
  white-space:nowrap; overflow:hidden; text-overflow:ellipsis; pointer-events:none; }
.gcastL-shotbar .seg.past { background-image:repeating-linear-gradient(
  45deg, #00000000 0 3px, #00000059 3px 6px); }
.gcastL-shotbar .note { font-family:ui-monospace,Consolas,monospace; font-size:9.5px;
  color:var(--h3-dim); }
.gcastL-shotbar .note.warn { color:#e0a35c; }
.gcastL-pace { display:flex; align-items:center; gap:7px; }
.gcastL-pace input[type="range"] { width:104px; accent-color:var(--h3-accent);
  pointer-events:auto; cursor:pointer; }
.gcastL-ok { color:var(--gc-wave); }
.gcastL-phead .spacer { margin-left:auto; }
.gcastL-phead button { padding:2px 9px; font-size:10.5px; }
.gcastL-chips { display:flex; flex-wrap:wrap; gap:5px; }
.gcastL-chip { all:unset; pointer-events:auto; cursor:pointer; display:flex; align-items:center; gap:5px;
  background:var(--h3-raise); border:1px solid var(--h3-line); border-radius:20px;
  padding:2px 9px 2px 2px; font-family:ui-monospace,Consolas,monospace; font-size:10.5px;
  color:var(--h3-txt); transition:.13s; }
.gcastL-chip:hover { border-color:var(--h3-accent); }
.gcastL-chip.on { border-color:var(--h3-accent); background:var(--h3-accent-dim); }
.gcastL-chip.on span:last-child { color:var(--h3-accent); }
/* 别名 chip：别名为主，规范 token 缩小作副标（素材认得出是谁） */
.gcastL-chip .sub { opacity:.5; font-size:9.5px; letter-spacing:.2px; }
.gcastL-chip.on .lbl, .gcastL-chip.on .sub { color:var(--h3-accent); }
.gcastL-chip img, .gcastL-chip video { width:18px; height:18px; border-radius:50%; object-fit:cover; }
.gcastL-chip .glyph { width:18px; height:18px; border-radius:50%; background:var(--h3-bg);
  display:flex; align-items:center; justify-content:center; font-size:9px; color:var(--h3-accent); }
.gcastL textarea { background:var(--h3-bg); color:var(--h3-txt); border:1px solid var(--h3-line);
  border-radius:7px; padding:8px 9px; font-family:inherit; font-size:12px; line-height:1.5;
  /* resize:none, not vertical. The browser's own grip writes an INLINE height
     onto the element, which outranks the flex fill and cannot be undone by
     anything the layout does - the panel then stays taller than the node
     however small the node is dragged, and the two come unstuck. The prompt
     already grows with the node; that is the handle. */
  resize:none; width:100%; box-sizing:border-box; outline:none;
  overflow-y:auto; overscroll-behavior:contain; }
/* contenteditable prompt editor — a real <div> instead of a <textarea>, so a
   <d>…</d> spoken line can be styled inline and selection/caret are native.
   No overlay to drift out of alignment. */
.gcastL-pwrap > .gcastL-ed { position:relative; flex:1 1 auto; min-height:0;
  background:var(--h3-bg); color:var(--h3-txt); border:1px solid var(--h3-line);
  border-radius:7px; padding:8px 9px; font-family:inherit; font-size:12px; line-height:1.5;
  width:100%; box-sizing:border-box; outline:none; cursor:text;
  overflow-y:auto; overscroll-behavior:contain; overflow-wrap:break-word; word-break:break-word;
  white-space:pre-wrap; -webkit-user-modify:read-write-plaintext-only;
  scrollbar-width:none; }
.gcastL-pwrap > .gcastL-ed::-webkit-scrollbar { width:0; height:0; display:none; }
.gcastL-pwrap > .gcastL-ed:focus { outline:none; }
/* placeholder only while empty */
.gcastL-pwrap > .gcastL-ed:empty::before { content:attr(data-placeholder); color:var(--h3-dim); pointer-events:none; }
/* <d>…</d> spoken line highlighted in green */
.gcastL-pwrap > .gcastL-ed .d { background:#1f5c38; color:#d9f5e2; border-radius:3px;
  padding:0 1px; box-decoration-break:clone; -webkit-box-decoration-break:clone; }
/* @标签 高亮：有图用主色，空槽位用警示色 */
.gcastL-pwrap > .gcastL-ed .tok { border-radius:3px; padding:0 1px; cursor:default;
  box-decoration-break:clone; -webkit-box-decoration-break:clone; }
.gcastL-pwrap > .gcastL-ed .tok.has { background:var(--h3-accent-dim); color:var(--h3-accent); }
.gcastL-pwrap > .gcastL-ed .tok.miss { background:#5c262673; color:#ffb3b3;
  text-decoration:underline wavy #ff8a8a 1px; }
/* 悬停预览浮窗。与 .gcastL-ac 同理挂在 body 上，取不到 .gcastL 的局部变量，
   自带一份——否则 background/color 全部落空，浮窗会退化成无底色的裸图。 */
.gcastL-toktip { --h3-bg:#191919; --h3-panel:#212121; --h3-raise:#2b2b2b;
  --h3-line:#3b3b3b; --h3-well:#131313; --h3-txt:#e3e3e3; --h3-dim:#979797;
  position:fixed; z-index:99999; display:none; background:var(--h3-panel);
  border:1px solid var(--h3-line); border-radius:6px; padding:4px; color:var(--h3-txt);
  font-size:11px; max-width:170px; box-shadow:0 4px 14px #0009; pointer-events:none; }
/* 保持素材原始比例：约束一个 150×220 的边界框，宽高都自动，等比缩到框内——
   竖图/竖视频不会被裁成 16:9。视频在 metadata 加载前按默认 300×150 量尺寸，
   加载完自然收到原始比例。 */
.gcastL-toktip img, .gcastL-toktip video { display:block; width:auto; height:auto;
  max-width:150px; max-height:220px; object-fit:contain;
  border-radius:4px; background:var(--h3-well); }
.gcastL-toktip .cap, .gcastL-toktip .glyph { display:block; margin-top:3px; text-align:center;
  color:var(--h3-dim); }
/* preset bar + dialogs ------------------------------------------------ */
.gcastL-bar { display:flex; align-items:center; gap:6px; }
.gcastL-bar .name { font-family:ui-monospace,Consolas,monospace; font-size:11px;
  color:var(--h3-txt); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.gcastL-bar .name .dirty { color:var(--h3-dim); }
.gcastL-bar .name .shot { color:#c9aeff; }
.gcastL-bar .spacer { margin-left:auto; }
.gcastL-btn { all:unset; pointer-events:auto; cursor:pointer; padding:4px 10px; border-radius:6px;
  border:1px solid var(--h3-line); background:var(--h3-panel);
  font-size:10px; color:var(--h3-txt); transition:.13s; }
/* 续写三件套（文件续写 / 潜空间续写 / 续写帧数）：它们同属一行，必须等高等宽
   才像一组控件。内边距收到 4px 6px、字号与上方的数字框统一 10px。 */
.gcastL-btn.cont { padding:0 6px; height:20px; line-height:18px; box-sizing:border-box;
  display:inline-flex; align-items:center; font-size:10px; }
.gcastL-btn:hover { border-color:var(--h3-accent); color:var(--h3-accent); }
.gcastL-btn:focus-visible { outline:2px solid var(--h3-accent); outline-offset:1px; }
.gcastL-btn.ghost { background:transparent; color:var(--h3-dim); }

/* shots -------------------------------------------------------------
   Violet on purpose: amber already means "something is wrong" in the
   prompt check and the presentation strip, and blue/green are taken by
   the two weight families. */
.gcastL-btn.shots { background:#2a2340; border-color:#584a78; color:#c9aeff; }
.gcastL-btn.shots:hover { border-color:#a97bff; color:#e4d6ff; }
.gcastL-shots {
  --h3-raise:#2b2b2b; --h3-line:#3b3b3b; --h3-well:#131313; --h3-panel:#212121;
  --h3-txt:#e3e3e3; --h3-dim:#979797; --h3-violet:#a97bff;
  --h3-accent:#58d1ff; --h3-accent-dim:#58d1ff26;
  font-family: ui-sans-serif, system-ui, "Segoe UI", sans-serif;
  position:fixed; z-index:80; width:336px; box-sizing:border-box;
  background:var(--h3-raise); border:1px solid var(--h3-line); border-radius:10px;
  padding:8px; box-shadow:0 14px 34px #000c; color:var(--h3-txt); font-size:11.5px; }
.gcastL-shots[data-mode="fl2va"] { --h3-accent:#59c14f; --h3-accent-dim:#59c14f26; }
.gcastL-shots input { background:var(--h3-well); color:var(--h3-txt); box-sizing:border-box;
  border:1px solid var(--h3-line); border-radius:5px; padding:4px 7px; width:100%;
  font-family:inherit; font-size:11.5px; outline:none; }
.gcastL-shots input:focus { border-color:var(--h3-violet); }
.gcastL-shots-head { padding-bottom:7px; }
.gcastL-shots-title { font-size:10px; letter-spacing:.08em; text-transform:uppercase;
  color:#c9aeff; padding:0 2px 5px; }
.gcastL-shots-file { font-family:ui-monospace,Consolas,monospace; font-size:9.5px;
  color:var(--h3-dim); padding:5px 2px 0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.gcastL-shots-list { max-height:min(52vh, 420px); overflow:auto; display:flex; flex-direction:column; gap:4px; }
.gcastL-shots-empty { color:var(--h3-dim); font-size:11px; padding:9px 4px; line-height:1.5; }
.gcastL-shot { display:flex; align-items:center; gap:8px; padding:5px; border-radius:7px;
  border:1px solid transparent; cursor:pointer; }
.gcastL-shot:hover { background:#ffffff0a; border-color:var(--h3-line); }
.gcastL-shot.on { border-color:var(--h3-violet); background:#a97bff14; }
.gcastL-shot .th { width:46px; height:30px; flex:0 0 auto; border-radius:4px; overflow:hidden;
  background:var(--h3-well); display:flex; align-items:center; justify-content:center; color:#4a4a4a; }
.gcastL-shot .th img, .gcastL-shot .th video { width:100%; height:100%; object-fit:cover; display:block; }
.gcastL-shot .mid { min-width:0; flex:1 1 auto; }
.gcastL-shot .nm { font-size:11.5px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.gcastL-shot .meta { font-family:ui-monospace,Consolas,monospace; font-size:9.5px; color:var(--h3-dim); }
.gcastL-shot .ctl { display:flex; gap:2px; flex:0 0 auto; opacity:0; transition:.13s; }
.gcastL-shot:hover .ctl, .gcastL-shot.on .ctl { opacity:1; }
.gcastL-shot .ctl button { all:unset; pointer-events:auto; cursor:pointer; width:18px; height:18px;
  border-radius:4px; display:flex; align-items:center; justify-content:center;
  color:var(--h3-dim); font-size:9px; }
.gcastL-shot .ctl button:hover { background:#ffffff14; color:var(--h3-txt); }
.gcastL-shot .ctl button.rm:hover { background:#ff7a7a1a; color:#ff7a7a; }
.gcastL-shot .ctl button.sk { border-radius:50%; font-size:8px; line-height:18px; }
.gcastL-shot .ctl button.sk:hover { background:#ffffff14; color:var(--h3-txt); }
.gcastL-shot.off { opacity:.55; }
.gcastL-shot.off .nm { text-decoration:line-through; }
.gcastL-shot.off .th { filter:grayscale(1); }
.gcastL-shots-foot { display:flex; align-items:center; gap:5px; flex-wrap:wrap;
  padding-top:8px; margin-top:8px; border-top:1px solid var(--h3-line); }
.gcastL-shots-foot.proj { border-top:none; padding-top:5px; margin-top:0; }
.gcastL-shots-foot .lbl { color:var(--h3-dim); font-size:10px; letter-spacing:.04em; }
.gcastL-shots-foot .spacer { margin-left:auto; }
.gcastL-shots-foot .gcastL-btn { padding:3px 8px; font-size:10.5px; }
/* Revert is the rescue button: violet like the rest of the project row, and
   visibly dead when there is nothing to go back to. .gcastL-btn is all:unset,
   so the disabled look has to be written out - the browser's own greying is
   reset away with everything else. */
.gcastL-shots-foot .gcastL-btn.revert { color:var(--h3-violet); border-color:#584a78; }
.gcastL-shots-foot .gcastL-btn.revert:hover { border-color:#a97bff; color:#e4d6ff; }
.gcastL-shots-foot .gcastL-btn[disabled] { opacity:.34; cursor:default; }
.gcastL-shots-foot .gcastL-btn[disabled]:hover { border-color:var(--h3-line); color:var(--h3-dim); }

.gcastL-badge { font-family:ui-monospace,Consolas,monospace; font-size:9.5px;
  letter-spacing:.06em; padding:1px 6px; border-radius:10px; flex:0 0 auto;
  border:1px solid currentColor; }
.gcastL-badge.ref { color:#58d1ff; }
.gcastL-badge.fl { color:#59c14f; }

.gcastL-modal {
  --h3-panel:#212121; --h3-raise:#2b2b2b; --h3-line:#3b3b3b; --h3-well:#131313;
  --h3-txt:#e3e3e3; --h3-dim:#979797; --h3-accent:#58d1ff;
  position:fixed; inset:0; z-index:9000; background:#000a;
  display:flex; align-items:center; justify-content:center;
  font-family: ui-sans-serif, system-ui, "Segoe UI", sans-serif; }
.gcastL-sheet { background:var(--h3-panel); border:1px solid var(--h3-line);
  border-radius:12px; box-shadow:0 20px 60px #000c; width:460px; max-width:92vw;
  max-height:76vh; display:flex; flex-direction:column; overflow:hidden;
  color:var(--h3-txt); font-size:12px; }
.gcastL-sheet h3 { margin:0; padding:13px 15px 10px; font-size:12px; font-weight:600;
  letter-spacing:.04em; border-bottom:1px solid var(--h3-line); }
.gcastL-sheet .body { padding:13px 15px; display:flex; flex-direction:column; gap:9px;
  overflow:auto; }
.gcastL-sheet .foot { padding:11px 15px; border-top:1px solid var(--h3-line);
  display:flex; gap:7px; justify-content:flex-end; }
.gcastL-sheet input[type="text"] { background:var(--h3-well); color:var(--h3-txt);
  border:1px solid var(--h3-line); border-radius:6px; padding:8px 10px;
  font-size:12px; font-family:inherit; outline:none; width:100%; box-sizing:border-box; }
.gcastL-sheet input[type="text"]:focus { border-color:var(--h3-accent); }
.gcastL-sheet .hint { color:var(--h3-dim); font-size:11px; line-height:1.45; }
.gcastL-row2 { display:flex; align-items:center; gap:9px; padding:8px 9px;
  border:1px solid var(--h3-line); border-radius:8px; cursor:pointer; background:var(--h3-well); }
.gcastL-row2:hover { border-color:var(--h3-accent); }
.gcastL-row2 .t { flex:1; min-width:0; }
.gcastL-row2 .t b { display:block; font-weight:600; overflow:hidden;
  text-overflow:ellipsis; white-space:nowrap; }
.gcastL-row2 .t span { color:var(--h3-dim); font-size:10.5px;
  font-family:ui-monospace,Consolas,monospace; }
.gcastL-row2 .del { all:unset; pointer-events:auto; cursor:pointer; color:var(--h3-dim); padding:2px 6px;
  border-radius:4px; }
.gcastL-row2 .del:hover { color:#ff7a7a; background:#ff7a7a1a; }

.gcastL-ac {
  --h3-raise:#2b2b2b; --h3-line:#3b3b3b; --h3-well:#131313;
  --h3-txt:#e3e3e3; --h3-dim:#979797;
  --h3-accent:#58d1ff; --h3-accent-dim:#58d1ff26;
  --gc-wave:#59c14f;
  font-family: ui-sans-serif, system-ui, "Segoe UI", sans-serif;
  position:absolute; z-index:70; background:var(--h3-raise);
  border:1px solid var(--h3-line); border-radius:8px; padding:4px; min-width:210px;
  max-height:236px; overflow:auto; box-shadow:0 10px 28px #000b; }
.gcastL-ac[data-mode="fl2va"] { --h3-accent:#59c14f; --h3-accent-dim:#59c14f26; }
.gcastL-ac button { all:unset; box-sizing:border-box; cursor:pointer; display:flex; width:100%;
  align-items:center; gap:8px; padding:5px 7px; border-radius:5px;
  font-family:ui-monospace,Consolas,monospace; font-size:11px; color:var(--h3-txt); }
.gcastL-ac button[aria-selected="true"] { background:var(--h3-accent-dim); }
.gcastL-ac img, .gcastL-ac video { width:22px; height:22px; border-radius:50%; object-fit:cover; flex:0 0 auto; }
.gcastL-ac .glyph { width:22px; height:22px; border-radius:50%; background:var(--h3-well);
  display:flex; align-items:center; justify-content:center; font-size:10px;
  color:var(--h3-accent); flex:0 0 auto; }
.gcastL-ac .tag { margin-left:auto; color:var(--h3-dim); font-size:10px; }
.gcastL-ac .fname { color:var(--h3-dim); font-size:9.5px; opacity:.75;
  overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:120px; }
.gcastL-ac .glyph.mark { background:var(--h3-accent-dim); color:var(--h3-accent); }
.gcastL-ac .none { padding:6px 8px; color:var(--h3-dim); font-size:11px; font-family:inherit; }
/* Prompt check: one row per category. */
.gcastL-check { background:var(--h3-well); border:1px solid var(--h3-line); border-radius:7px;
  box-shadow:inset 0 1px 3px rgba(0,0,0,.38);
  padding:7px 9px; display:flex; flex-direction:column; gap:4px;
  font-family:ui-monospace,Consolas,monospace; font-size:10.5px; color:var(--h3-dim); }
.gcastL-check .row { display:flex; align-items:baseline; gap:7px; }
.gcastL-check b { color:var(--h3-accent); font-weight:600; min-width:36px; flex:0 0 auto; }

/* Presentation strip: each tag ← source mapping is its own grid cell, so it
   cannot wrap into its neighbour or spill past the node border. */
.gcastL-pres { background:var(--h3-well); border:1px solid var(--h3-line); border-radius:7px;
  box-shadow:inset 0 1px 3px rgba(0,0,0,.38);
  padding:7px 9px; display:grid;
  grid-template-columns:repeat(auto-fill, minmax(150px, 1fr));
  gap:4px 10px;
  font-family:ui-monospace,Consolas,monospace; font-size:10.5px; color:var(--h3-dim); }
.gcastL-pres .cell { display:flex; align-items:center; gap:5px; min-width:0; }
.gcastL-pres .cell b { flex:0 0 auto; }
.gcastL-pres .cell .src { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.gcastL-pres b { color:var(--h3-accent); font-weight:600; }
.gcastL-pres .arrow { opacity:.4; }
.gcastL-pres .full { grid-column:1 / -1; }
.gcastL-warn { color:#ffcc66; }
@media (prefers-reduced-motion: reduce) { .gcastL * { transition:none !important; } }
`;

/* 媒体架（csglide_media_rack.js）导入这份样式表，保证两个节点的槽位视觉
   与字阶完全相同——而不是各写一份会各自漂移的近似样式。 */
export const CAST_CSS = CSS;

function injectCSS() {
  if (document.getElementById("gcastL-css")) return;
  const s = document.createElement("style");
  s.id = "gcastL-css"; s.textContent = CSS;
  document.head.appendChild(s);
}

/* ------------------------------------------------------------- helpers */

/* What is being dragged, read from the drag rather than the file: during a
 * dragover the name is not exposed, only the MIME type. Returns image, video,
 * audio, or null when it is not a file drag at all (a node, a link, text). */
function dragKind(e) {
  const dt = e.dataTransfer;
  if (!dt) return null;
  /* 媒体加载器拖来的引用：drop 阶段才有值，dragover 阶段只认类型存在 */
  const ref = relFromEvent(e);
  if (ref) return fileKind({ name: ref }) || "";
  if (hasRef(e)) return "";
  const types = Array.from(dt.types || []);
  if (!types.includes("Files")) return null;
  const item = Array.from(dt.items || []).find((i) => i.kind === "file");
  const mime = item?.type || "";
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  return "";              /* a file, but the browser will not say what kind */
}

/* A dropdown that looks like the rest of the panel rather than an OS combo.
 * Same surface as the <select> it replaces: .value, .onchange, .disabled.
 * 菜单挂在 document.body 上（不在节点内），拿不到节点的局部 CSS 变量，所以
 * 主色靠 data-mode 传递：mode 由调用方给，缺省沿用导演台的家族标记。 */
export function makeSelect(node, titleAttr, mode) {
  const btn = el("button", "gcastL-select");
  btn.type = "button";
  if (titleAttr) btn.title = titleAttr;
  const lbl = el("span", "lbl");
  btn.append(lbl, el("span", "caret", "\u25BE"));

  let opts = [], value = null, onchange = null, disabled = false, menu = null;
  let dismissing = false;      /* a press outside is waiting for its pointerup */

  const paint = () => {
    const o = opts.find((o) => o.value === value);
    lbl.textContent = o ? o.label : "";
    btn.setAttribute("aria-disabled", String(disabled));
  };

  const close = () => {
    dismissing = false;
    if (!menu) return;
    menu.remove();
    menu = null;
    document.removeEventListener("pointerdown", onOutside, true);
    document.removeEventListener("keydown", onKey, true);
    window.removeEventListener("wheel", close, true);
  };
  /* Dismiss on pointerUP, never on pointerdown. Removing the menu while the
   * button is still down means the matching pointerup lands on nothing, and
   * the v2 canvas is left believing a drag is in progress -- the graph then
   * pans with the mouse until the next press. Same reason items select on
   * click; this is the path that press missed. */
  const onOutside = (e) => {
    if (!menu || menu.contains(e.target) || dismissing) return;
    dismissing = true;
    const done = () => {
      window.removeEventListener("pointerup", done, true);
      window.removeEventListener("pointercancel", done, true);
      dismissing = false;
      close();
    };
    window.addEventListener("pointerup", done, true);
    window.addEventListener("pointercancel", done, true);
  };
  const onKey = (e) => { if (e.key === "Escape") { e.stopPropagation(); close(); } };

  const open = () => {
    close();
    menu = el("div", "gcastL-menu");
    menu.dataset.mode = mode || node?.h3ui?.mode
      || document.querySelector(".gcastL")?.dataset.mode || "";
    let lastGroup = null;
    opts.forEach((o) => {
      if (o.group && o.group !== lastGroup) {
        lastGroup = o.group;
        menu.append(el("div", "grp", o.group));
      }
      const b = el("button", null);
      b.type = "button";
      b.append(el("span", null, o.label));
      if (o.note) b.append(el("span", "note", o.note));
      b.setAttribute("aria-selected", String(o.value === value));
      /* Select on CLICK, not pointerdown. Removing the menu on pointerdown
       * means the matching pointerup lands on nothing, and the v2 canvas is
       * left believing a drag is still in progress. */
      b.addEventListener("pointerdown", (e) => { e.stopPropagation(); });
      b.addEventListener("click", (e) => {
        e.preventDefault(); e.stopPropagation();
        close();
        if (o.value === value) return;
        value = o.value;
        paint();
        onchange?.(value);
      });
      menu.append(b);
    });
    document.body.append(menu);

    const r = btn.getBoundingClientRect();
    menu.style.minWidth = Math.max(r.width, 170) + "px";
    const h = menu.offsetHeight, w = menu.offsetWidth;
    menu.style.left = Math.max(6, Math.min(r.left, window.innerWidth - w - 8)) + "px";
    menu.style.top = (r.bottom + 4 + h > window.innerHeight - 8
      ? Math.max(6, r.top - h - 4)
      : r.bottom + 4) + "px";

    setTimeout(() => document.addEventListener("pointerdown", onOutside, true), 0);
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("wheel", close, true);
  };

  btn.addEventListener("pointerdown", (e) => { e.stopPropagation(); });
  btn.addEventListener("click", (e) => {
    e.preventDefault(); e.stopPropagation();
    if (disabled) return;
    menu ? close() : open();
  });

  return {
    el: btn,
    setOptions(list) { opts = list || []; paint(); },
    get value() { return value; },
    set value(v) { value = v; paint(); },
    set disabled(v) { disabled = !!v; paint(); },
    set onchange(fn) { onchange = fn; },
    close,
  };
}

const el = (tag, cls, txt) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (txt != null) n.textContent = txt;
  return n;
};

function viewURL(file) {
  if (!file) return "";
  const i = file.lastIndexOf("/");
  const sub = i >= 0 ? file.slice(0, i) : "";
  const name = i >= 0 ? file.slice(i + 1) : file;
  return api.apiURL(`/view?filename=${encodeURIComponent(name)}&subfolder=${encodeURIComponent(sub)}&type=input`);
}

async function uploadFile(file) {
  const body = new FormData();
  body.append("image", file, file.name);
  body.append("subfolder", ASSET_SUBFOLDER);
  body.append("type", "input");
  const res = await api.fetchApi("/upload/image", { method: "POST", body });
  if (res.status !== 200) throw new Error(`上传失败 (${res.status})`);
  const d = await res.json();
  return d.subfolder ? `${d.subfolder}/${d.name}` : d.name;
}

function pickFile(accept, multiple) {
  return new Promise((resolve) => {
    const inp = document.createElement("input");
    inp.type = "file"; inp.accept = accept;
    if (multiple) inp.multiple = true;
    inp.onchange = () => {
      const list = inp.files ? Array.from(inp.files) : [];
      resolve(multiple ? list : (list[0] || null));
    };
    inp.click();
  });
}

function probeDuration(url, isVideo) {
  return new Promise((resolve) => {
    const m = document.createElement(isVideo ? "video" : "audio");
    m.preload = "metadata";
    m.onloadedmetadata = () => resolve(Number.isFinite(m.duration) ? m.duration : 0);
    m.onerror = () => resolve(0);
    m.src = url;
  });
}

/* ================================================================= build */

function buildUI(node) {
  const root = el("div", "gcastL");
  let st = blankState();
  let dataWidget = null;

  const commit = () => {
    if (!dataWidget) dataWidget = node.widgets?.find((w) => w.name === "h3_data");
    if (dataWidget) dataWidget.value = JSON.stringify(st);
    node.setDirtyCanvas(true, true);
  };

  /* ---- preset bar ---- */
  const bar = el("div", "gcastL-bar");
  const nameLabel = el("div", "name");
  const bSave = el("button", "gcastL-btn", "保存");
  const bSaveAs = el("button", "gcastL-btn ghost", "另存为…");
  const bPack = el("button", "gcastL-btn ghost", "保存打包");
  const bLoad = el("button", "gcastL-btn ghost", "载入");
  const bShots = el("button", "gcastL-btn shots", "工程");
  bSave.title = "覆盖写入你上次打开或保存过的那个文件";
  bSaveAs.title = "选择保存位置；JSON 中的素材以文件名引用";
  bPack.title = "选择保存位置；打包文件会把素材一并装入，便于携带";
  bShots.title = "本工程的各分段 —— 可在此切换，或将整个工程保存为单个文件";
  bar.append(nameLabel, el("div", "spacer"), bSave, bSaveAs, bPack, bLoad, bShots);

  /* ---- project timeline ---- */
  const tl = el("div", "gcastL-tl");
  const tlHead = el("div", "head");
  const tlRule = el("div", "rule");
  const tlTools = el("div", "tools");
  const tlView = el("div", "view");
  const tlStrip = el("div", "strip");
  const tlBtn = (title, path, cls) => {
    const b = el("button", cls || null);
    b.title = title;
    b.innerHTML = '<svg viewBox="0 0 12 12">' + path + "</svg>";
    b.onclick = (e) => e.stopPropagation();
    return b;
  };
  const tlZoomOut = tlBtn("缩小", '<path d="M2.5 6h7"/>');
  const tlZoomIn = tlBtn("放大", '<path d="M6 2.5v7M2.5 6h7"/>');
  const tlFit = tlBtn("适配整部工程",
    '<path d="M1.5 3.5v-2h2M8.5 1.5h2v2M10.5 8.5v2h-2M3.5 10.5h-2v-2"/>');
  const tlAdd = tlBtn("新增分段，保留当前参考素材与画布",
    '<path d="M6 2v8M2 6h8"/>');
  const tlDel = tlBtn("删除当前分段",
    '<path d="M2.5 3.5h7M4.5 3.5V2.5h3v1M3.5 3.5l.5 6h4l.5-6"/>', "danger");
  tlTools.append(tlZoomOut, tlZoomIn, tlFit, tlAdd, tlDel);
  tlHead.append(tlRule, tlTools);
  tlView.append(tlStrip);
  tl.append(tlHead, tlView);

  /* ---- mode bar ---- */
  const modeBar = el("div", "gcastL-modebar");
  const seg = el("div", "gcastL-seg");
  const btnFL = el("button", null, "首尾帧");
  const btnRef = el("button", null, "多参考");
  seg.append(btnFL, btnRef);
  const need = el("div", "gcastL-need");
  modeBar.append(seg, need);

  /* ---- settings ---- */
  /* 紧凑表单（方案 B）：标签定宽左对齐 + 控件 + 读出右对齐，行间只用细分隔线。
     设置是「参数表」不是内容块，卡片层级让给续写来源这类真正的内容。 */
  const row = el("div", "gcastL-row");
  /* 读出位靠 margin-left:auto 顶到行尾，不需要额外 spacer */
  const field = (label, ctl, read) => {
    const f = el("div", "gcastL-field");
    f.append(el("span", "gcastL-flabel", label), ctl);
    if (read) f.append(read);
    return f;
  };

  const canvasCtl = el("div", "gcastL-ctl");
  const selRatio = makeSelect(node, "宽高比");
  selRatio.setOptions(RATIOS.map((r) => ({ label: r.label, value: r.label, note: `${r.w} x ${r.h}` }))
    .concat([{ label: "自定义", value: "custom" }]));
  const selSize = makeSelect(node, "该比例下的画布尺寸");
  const inW = el("input"); inW.type = "number"; inW.step = 32; inW.min = 32;
  const inH = el("input"); inH.type = "number"; inH.step = 32; inH.min = 32;
  const canvasNote = el("div", "gcastL-read");
  canvasCtl.append(selRatio.el, selSize.el, inW, el("span", "gcap dim-x", "\u00d7"), inH);

  const lenCtl = el("div", "gcastL-ctl");
  const selLen = makeSelect(node, "片段时长（秒）；括号内为实际帧数，见右侧读出");
  selLen.setOptions(LENGTH_PRESETS.map((f) => ({
    label: `${Math.round(f / FPS)}s`, value: String(f), note: `${f} f`,
  })).concat([{ label: "自定义", value: "custom" }]));
  /* 自定义输入以「秒」为单位（曾是帧数）：帧数只有落在 17k+5 网格上才合法，
     用户想的却是「我要 12 秒」。写入统一经 nearestFrames 吸附，故回显的是吸附后
     的真实秒数（如 10.13）——精确帧数在右侧读出位给出，不劳用户自己算网格。 */
  const inLen = el("input"); inLen.type = "number";
  /* step="any"：不要让浏览器自己算小数步长。它的网格是 min + k*step，而 min 与
     step 都是四舍五入后的秒（0.21 / 0.7083），回显又取两位小数——三张网格互不
     重合。按一次跳到最近的浏览器格点、回写后又被吸附回同样的帧数，按钮看起来
     毫无反应（141 帧卡在 5.88s，升一次到 158 就再也上不去）。现在浏览器只负责
     ±1 秒，吸附交给 nearestFrames，全程只有一张网格。
     min 只声明「秒数非负」而不是 5 帧下限：只要存在 min，浏览器一旦算出「当前值
     − 1 低于 min」就整个拒绝步进（既不夹也不触发），22 帧（0.92s）按 ↓ 会静默无
     反应。帧网格的下限统一由 nearestFrames 裁决，浏览器不插手。 */
  inLen.step = "any"; inLen.min = 0;
  inLen.title = "自定义时长（秒）。会吸附到 H3 的 17k+5 帧网格，实际帧数见右侧读出。";
  const lenNote = el("div", "gcastL-read");
  lenCtl.append(selLen.el, inLen, el("span", "gcap", "秒"));

  /* 按内容长度自动撑宽：CSS 里的 42px 只放得下 4~5 个字符，「1888」「4096」
     一变长就被浏览器静默截断，用户既看不到自己填了什么、也改不回去。
     数字字号 10px 下每字符约 6px，两侧各留 9px 内边距。
     flex:0 1 auto 里的 flex-shrink=1 会在行内空间不足时把宽度压回去（这正是
     上一版设了 style.width 仍被截断的原因），故这里同时钉死 flex-basis 与
     flex-grow/shrink，让浏览器无法回压。 */
  const autoWidth = (inp) => {
    const n = String(inp.value == null ? "" : inp.value).length;
    inp.style.flex = "0 0 auto";
    /* 每字符 6.4px + 22px 余量：10px 字体下 4 位数（1888）需要约 48px，
       42px 装不下（会退化成省略号）；留足余量才真的不截断。 */
    inp.style.width = Math.max(44, n * 6.4 + 22) + "px";
  };

  const refCtl = el("div", "gcastL-ctl");
  const chkRef = el("input"); chkRef.type = "checkbox"; chkRef.title = "跟随画布长边";
  const inRef = el("input"); inRef.type = "number"; inRef.step = REF_STEP; inRef.min = REF_MIN; inRef.max = REF_IMAGE_MAX;
  inRef.title = "图片参考的最长边（px）：等比缩放到长边不超过该值；比它小的图片原样编码，不放大。";
  /* 放大重绘（二采/三采）条件的参考档位倍数：属于「参考素材怎么编码」的参数，
     所以跟参考尺寸同处一行。1 = 直接用上面的档位，不额外编码。 */
  const inScale = el("input");
  inScale.type = "number"; inScale.step = REF_SCALE_STEP; inScale.min = REF_SCALE_MIN; inScale.max = REF_SCALE_MAX;
  inScale.title = "放大重绘条件的参考档位倍数：1 = 跟随左侧档位、不额外编码；"
    + "1.5/2 = 参考素材按更大档位重新编码后交给二采与三采，细节更多。"
    + "倍数越高越慢——每个档位都要重跑一遍视觉编码器。";
  const refNote = el("div", "gcastL-read");
  refCtl.append(chkRef, el("span", "gcap", "跟随画布"), inRef,
                el("span", "gcap", "放大倍数"), inScale);

  const vrefCtl = el("div", "gcastL-ctl");
  const chkVRef = el("input"); chkVRef.type = "checkbox"; chkVRef.title = "跟随画布长边";
  const inVRef = el("input"); inVRef.type = "number"; inVRef.step = REF_STEP; inVRef.min = REF_MIN; inVRef.max = REF_VIDEO_MAX;
  inVRef.title = "视频参考的最长边（px）：等比缩放到长边不超过该值；比它小的视频原样编码，不放大。";
  const vrefNote = el("div", "gcastL-read");
  const fpsRef = el("input"); fpsRef.type = "number"; fpsRef.step = 1; fpsRef.min = REF_FPS_MIN; fpsRef.max = REF_FPS_MAX;
  fpsRef.title = "参考视频采样帧率：24=不抽帧；往低调（如 12/8）在时长不变时减少参考帧数、节省显存，但会降低参考锚定精度。";
  const fpsNote = el("span", "gcastL-read");
  /* 视频参考一行并进「抽帧帧率」：这两项同属视频参考的采样设置，
     原来单独占一行把卡片撑高、又和上行控件重复了「视频参考」的语义。 */
  vrefCtl.append(chkVRef, el("span", "gcap", "跟随画布"), inVRef,
                 el("span", "gcap", "抽帧"), fpsRef, fpsNote);

  /* 绑定必须放在上面所有输入框都声明完之后：const 声明前引用会抛 TDZ
     （Cannot access before initialization），整个面板连带工作流加载一起中止。 */
  for (const inp of [inW, inH, inLen, inRef, inScale, inVRef, fpsRef]) {
    inp.addEventListener("input", () => { autoWidth(inp); inp.dataset.dirty = "1"; });
  }

  const fRef = field("图片参考", refCtl, refNote);
  const fVRef = field("视频参考", vrefCtl, vrefNote);


  row.append(field("画布", canvasCtl, canvasNote),
             field("时长", lenCtl, lenNote),
             fRef, fVRef);

  /* ---- slot areas ---- */
  const flWrap = el("div");
  flWrap.append(el("div", "gcastL-label", "首尾关键帧"));
  const flGrid = el("div", "gcastL-grid fl");
  flWrap.append(flGrid);

  /* 参考图/视频/音频三模块已外迁至「🗂️ H3 媒体架」节点（refs 端口接线）。
     面板只保留续写来源卡——它消费的是本节点上一段的渲染产物，归导演台管。
     contWrap 是续写卡在非 fl2va 模式下的独立容器（fl2va 下挂进 flGrid）。 */
  const contWrap = el("div", "gcastL-grid med4");
  contWrap.style.display = "none";
  contWrap.style.flex = "1 1 0";
  contWrap.style.minWidth = "0";

  /* 左右分栏：设置四卡竖排在左（.gcastL-row 自带定宽），续写来源在右占满余宽 */
  const midWrap = el("div");
  midWrap.style.cssText = "display:flex; gap:8px; align-items:stretch;";

  /* ---- prompt ---- */
  const pWrap = el("div", "gcastL-pwrap");
  pWrap.style.display = "flex"; pWrap.style.flexDirection = "column"; pWrap.style.gap = "6px";
  const pHead = el("div", "gcastL-phead");
  pHead.append(el("div", "gcastL-label", "提示词"));
  /* 外接提示词徽章：prompt_text 接线时显示，编辑器同时转只读镜像 */
  const extBadge = el("span", "gcastL-extbadge", "外部提示词 · 只读");
  extBadge.style.display = "none";
  extBadge.title = "提示词由外部文本节点提供，此处仅预览；断开连线即恢复面板编辑";
  pHead.append(extBadge);
  const chips = el("div", "gcastL-chips");
  const shotbar = el("div", "gcastL-shotbar");
  const gutter = el("div", "gcastL-gutter");
  const gutterInner = el("div", "inner");
  gutter.append(gutterInner);
  const ta = el("div", "gcastL-ed");
  ta.setAttribute("contenteditable", "plaintext-only");
  ta.setAttribute("role", "textbox");
  ta.setAttribute("aria-multiline", "true");
  ta.setAttribute("spellcheck", "false");
  ta.setAttribute("autocapitalize", "off");
  ta.setAttribute("autocorrect", "off");
  ta.dataset.placeholder = "描述这个片段：点击上方参考素材，即可把它的 @标签 插入到提示词里。";
  const sHead = el("div", "gcastL-phead");
  sHead.append(el("div", "gcastL-label", "提示词检查"));
  const speech = el("div", "gcastL-check");

  const presLabel = el("div", "gcastL-label", "提交给编码器的格式");
  const pres = el("div", "gcastL-pres");
  pWrap.append(pHead, chips, shotbar, ta, sHead, speech, presLabel, pres);
  pWrap.append(gutter);
  ta.style.paddingLeft = "17px";          // room for the gutter bar
  /* Only needed on the fallback path; the scroll timeline handles it natively. */
  ta.addEventListener("scroll", () => { if (!SCROLL_DRIVEN) paintGutterBars(); }, { passive: true });

  /* ---- plain-text + caret helpers over the contenteditable editor ---- */

  /* The editor is only ever built from text nodes and flat inline .d spans, so
   * walking text nodes in DOM order yields the prompt's character offsets. */
  function charOffset(node, offset) {
    let total = 0;
    const w = document.createTreeWalker(ta, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = w.nextNode())) {
      if (n === node) return total + offset;
      total += n.textContent.length;
    }
    return total;
  }
  /* textContent, not innerText: innerText is layout-dependent and returns ""
   * whenever the editor is momentarily un-rendered (zero height, mid-layout),
   * which would silently overwrite st.prompt with an empty string. The editor
   * is always built from flat text nodes + .d spans, so textContent reads back
   * the exact prompt, newlines included, regardless of layout. It also stays
   * consistent with charOffset(), which walks the same text nodes. */
  function edText() { return ta.textContent || ""; }
  function edCaret() {
    const s = window.getSelection();
    if (!s || !s.rangeCount) return { s: 0, e: 0 };
    const r = s.getRangeAt(0);
    if (!ta.contains(r.startContainer)) return { s: edText().length, e: edText().length };
    return { s: charOffset(r.startContainer, r.startOffset), e: charOffset(r.endContainer, r.endOffset) };
  }
  function setCaret(pos) {
    /* 编辑区未聚焦时绝不动选区：对非聚焦的可编辑元素 addRange 会把焦点强抢
     * 过来——外接提示词时镜像一更新（800ms 轮询），正在外部文本节点打字的光标
     * 就被拽进导演台。光标只在编辑区自己有焦点时才有意义。 */
    if (document.activeElement !== ta) return;
    const w = document.createTreeWalker(ta, NodeFilter.SHOW_TEXT);
    let n, acc = 0, last = null;
    while ((n = w.nextNode())) {
      last = n;
      if (acc + n.textContent.length >= pos) break;
      acc += n.textContent.length;
    }
    const s = window.getSelection();
    const r = document.createRange();
    if (n) { r.setStart(n, pos - acc); r.setEnd(n, pos - acc); }
    else if (last) { r.setStart(last, last.textContent.length); r.setEnd(last, last.textContent.length); }
    else { r.selectNodeContents(ta); r.collapse(false); }
    s.removeAllRanges(); s.addRange(r);
  }
  /* Insert a literal text node at the caret (replacing any selection). "\n" is
   * a real newline character here — never a <br>/<div>, so the text reads back
   * exactly, on every browser. */
  function insertTextNode(text) {
    const s = window.getSelection();
    if (!s || !s.rangeCount) return;
    const r = s.getRangeAt(0);
    r.deleteContents();
    const node = document.createTextNode(text);
    r.insertNode(node);
    r.setStartAfter(node); r.setEndAfter(node);
    s.removeAllRanges(); s.addRange(r);
  }
  /* Rebuild the editor from a plain string, wrapping each <d>…</d> in a green
   * span and each @标签 in a reference chip. Text nodes + flat spans only, so
   * it reads back verbatim (textContent / charOffset keep their invariants). */
  const EDIT_D = /<d>([\s\S]*?)<\/d>/g;
  /* 规范 @标签。高亮正则是动态的（别名集合随媒体架变化），这里只存源串，
     由 editTokRe() 每次现拼——别名字面量不能写死在正则里。 */
  const EDIT_TOK = "@(?:first|last|图片\\d+|视频音频\\d+|视频\\d+|音频\\d+)(?![0-9A-Za-z])";
  /* 引用别名归一化。官方 skill 的写法是 <Picture N> / <Video N> / <Audio N>，
     用户手写又常见 image 1 / Video1 / 图片 1 之类。这里统一收敛成导演台唯一
     认得的一套（@图片N / @视频N / @音频N / @视频音频N），下游的高亮、按需
     过滤、后端转译就都不必各写一份兼容。
     顺序：官方式尖括号 → 英文裸词 → 中文；(?!\d) 防止「图片12」被拆成
     1 与 2；中文规则带 @? 前缀，对已是规范写法的文本幂等。

     <Audio N> 也不进这张表。旧做法把它的 N 当成「音频类的全局序号 j」（视频
     自带的声音与独立音频共用同一个计数器），于是同一个 <Audio 1> 时而是某个
     视频的声音、时而是独立音频1，随当日填充状态漂移。2026-09-25 起改为固定
     语义：N 就是第 N 个独立音频，与 @音频N 同义；视频自带的声音一律用
     @视频音频N 引用，两套编号各数各的、互不挤占。由 AUDIO_TAG 单独处理。 */
  const REF_ALIASES = [
    [/<\s*Picture\s*(\d+)\s*>/gi, "@图片$1"],
    [/<\s*Video\s*(\d+)\s*>/gi, "@视频$1"],
    [/(?<!@)\bPictures?\s*(\d+)(?!\d)/gi, "@图片$1"],
    [/(?<!@)\bImages?\s*(\d+)(?!\d)/gi, "@图片$1"],
    [/(?<!@)\bVideos?\s*(\d+)(?!\d)/gi, "@视频$1"],
    [/(?:@\s*)?视频音频\s*(\d+)(?!\d)/g, "@视频音频$1"],
    [/(?<![视音频图])(?:@\s*)?(?:图片|图像)\s*(\d+)(?!\d)/g, "@图片$1"],
    [/(?<![视音频图])(?:@\s*)?视频\s*(\d+)(?!\d)/g, "@视频$1"],
    [/(?<![视音频图])(?:@\s*)?音频\s*(\d+)(?!\d)/g, "@音频$1"],
  ];
  const AUDIO_TAG = /<\s*Audio\s*(\d+)\s*>/gi;
  const AUDIO_WORD = /(?<!@)\bAudios?\s*(\d+)(?!\d)/gi;

  /* 相邻标签之间补空格。@音频1@音频4 这种连贴写法来自手滑或外部工具，下游目前
     切得开、也换得对，但难读且脆：一旦高亮正则改边界、或替换排序不再长度优先，
     它立刻变成静默错位。补一个空格既恢复可读性，也把「标签能不能挨着」这个
     边界问题彻底消掉。必须排在 REF_ALIASES 之后——那时写法才都已收敛成规范
     标签；幂等：已有空格的文本不再命中 (?=@)。 */
  const GLUE_RE = /(@(?:first|last|图片\d+|视频音频\d+|视频\d+|音频\d+))(?=@)/g;

  /* 全局第 N 个音频 → 它的规范 token（@视频音频K 或 @音频K）。
     N 是模型协议里的音频序号（见 build_tag_map 的 j），视频音轨与独立音频共用
     同一个计数器、音轨在前。旧实现只查独立音频槽，于是两者同时存在时编号整体
     错位一格：<Audio 1> 被解析成 @音频1，而模型侧 <Audio 1> 其实是视频1的音轨。
     与 csglide_cast.py 的 _audio_ref 必须给出同一个答案。
     空槽/越界返回 null 由调用方保留原文——凭空生成的标签指向空槽会被静默删掉，
     用户看到「写了却像没写」比报错更难查；保留原文还能自愈。 */
  function audioRef(n, view) {
    const toks = [];
    ((view && view.videos) || []).forEach((s, i) => {
      if (s && s.file && s.audio) toks.push(`@视频音频${i + 1}`);
    });
    ((view && view.audios) || []).forEach((s, i) => {
      if (s && s.file) toks.push(`@音频${i + 1}`);
    });
    return n >= 1 && n <= toks.length ? toks[n - 1] : null;
  }

  function normalizeRefs(text, view) {
    if (!text) return text;
    let out = String(text);
    out = out.replace(AUDIO_TAG, (m, d) => audioRef(+d, view) || m);
    out = out.replace(AUDIO_WORD, (m, d) => audioRef(+d, view) || m);
    for (const [re, rep] of REF_ALIASES) out = out.replace(re, rep);
    out = out.replace(GLUE_RE, "$1 ");
    return out;
  }

  /* ---- 别名：剧本里直接写角色名 → @图片N --------------------------------
     媒体架槽位可带 alias（拖入时按文件名主干自动登记，也能手动改成多个称呼）。
     原文不改写：只有「送模型」这一路（effPrompt → 按需过滤 / 展示条 / 后端
     转译）走展开，编辑器里始终是剧本原文，可读性与撤销栈都不受影响。
     规则与 csglide_cast.py 的 alias_table / _alias_ok / expand_aliases 完全
     对称（alias_map 只是 alias_table 取 map 的便捷包装），改一处必须改另一处。 */
  const ALIAS_SPLIT = /[,，、;；]+/;
  const ALIAS_MAX = 40, ALIAS_MIN = 2, ALIAS_TOTAL = 12;
  const BUILTIN_ALIAS = /^(?:first|last|图片\d+|视频音频\d+|视频\d+|音频\d+|pictures?\s*\d+|videos?\s*\d+|audios?\s*\d+|images?\s*\d+)$/i;
  const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  /* 全角空格 U+3000 → 半角 U+0020。中文输入法在词间极易产出全角空格，
     而手打别名又常是半角，两边不统一就永远命不中。归一化必须**两侧都做**：
     只改名字或只改正文，仍有「名字半角 / 正文全角」这类组合漏掉。
     只换 U+3000，不动其他空白。与 csglide_cast.py 的 _norm_space、
     csglide_media_rack.js 的 normSpace 口径一致。 */
  const normSpace = (s) => (s ? s.replace(/\u3000/g, " ") : s);

  function aliasList(v) {
    /* 非字符串一律丢掉：与 csglide_cast.py 的 _alias_of 一致。拼成字符串再
       切会让数字 12 变成别名「12」——后端不认，两边就对不上了。 */
    const raw = Array.isArray(v) ? v.filter((x) => typeof x === "string").join(",") : v;
    if (typeof raw !== "string" || !raw.trim()) return [];
    const out = [];
    for (const p of raw.split(ALIAS_SPLIT)) {
      // trim 先剥首尾（JS 的 trim 认 U+3000），再归一内部全角空格——与
      // Python _alias_of 同序。
      const a = normSpace(p.trim());
      if (!a || a.length > ALIAS_MAX || out.includes(a)) continue;
      out.push(a);
      if (out.length >= ALIAS_TOTAL) break;
    }
    return out;
  }
  /* 单字不注册（误伤率爆炸）、含 @ 或反斜杠不行、撞内置词不行——否则
     「图片1」到底算别名还是规范写法无从判定。
     反斜杠也不行：\别名 是「保留文字、不展开」的转义写法，名字里带反斜杠
     会和它抢（「小\明」遇上别名「明」时，转义先吃掉反斜杠，字就变了）。
     空格允许，且是名字的一部分（「张三丰 剧照」就是一个名字）；分隔符只有
     ALIAS_SPLIT 那几个，空格不在其中，写法上不会歧义。规则与
     csglide_cast.py 的 _alias_ok、csglide_media_rack.js 的 aliasBad 必须一致。 */
  const aliasOk = (a) =>
    a.length >= ALIAS_MIN && a.length <= ALIAS_MAX
    && !/[@\\]/.test(a) && !BUILTIN_ALIAS.test(a);

  /* 别名表。写法即作用域，不需要额外控件：
       小明    → 自动：剧本里写「小明」就引用
       @小明   → 仅 @ 触发：必须写「@小明」才引用（名字太常见时用）
       清空    → 关闭：不参与
     返回 { map: 名字(不含@) → 规范 token, strict: 只认 @ 的名字集合 }。
     先出现者优先：重名时后者静默失效，不覆盖前一个。 */
  /* 别名表在击键链路上被反复取（每个 chip 一次 hasToken、展示条一次、
     后端一次），不缓存就是每个别名一遍正则。 */
  let aliasCache = { key: "", val: null };
  /* 缓存键是各槽位别名原文拼出来的串，不是 rack_data 全文——面板改名、
     媒体架改名都会让它变，但只有别名相关的改动才失效。不借用 rackCache：
     那是一处晚声明的 let，此处引用既会踩到 TDZ，也让缓存脱离视图本身。 */
  function aliasKey(view) {
    let k = "";
    for (const kind of ["images", "videos", "audios"]) {
      const arr = view[kind] || [];
      for (let i = 0; i < arr.length; i++) {
        const s = arr[i];
        if (!s) continue;
        const al = s.alias;
        k += "\u0001" + (Array.isArray(al) ? al.join("\u0002") : al == null ? "" : String(al));
      }
      k += "\u0003";
    }
    return k;
  }
  function aliasInfo() {
    const view = mergedSlots();
    const key = aliasKey(view);
    if (aliasCache.key === key && aliasCache.val) return aliasCache.val;
    const map = Object.create(null);
    const strict = new Set();
    const kinds = [["images", "@图片"], ["videos", "@视频"], ["audios", "@音频"]];
    for (const [kind, prefix] of kinds) {
      const arr = view[kind] || [];
      for (let i = 0; i < arr.length; i++) {
        const s = arr[i];
        if (!s) continue;
        for (const raw of aliasList(s.alias)) {
          const at = raw.charAt(0) === "@";
          const name = at ? raw.slice(1) : raw;
          if (!aliasOk(name) || map[name]) continue;
          map[name] = prefix + (i + 1);
          if (at) strict.add(name);
        }
      }
    }
    aliasCache = { key, val: { map, strict } };
    return aliasCache.val;
  }
  const aliasMap = () => aliasInfo().map;
  /* 反查：@图片1 → 首选别名的显示写法（chips 上显示、点击插入都用它） */
  function aliasLabel(t) {
    if (!t) return "";
    const { map, strict } = aliasInfo();
    for (const k in map) if (map[k] === t) return (strict.has(k) ? "@" : "") + k;
    return "";
  }

  /* ---- 保护区 ---------------------------------------------------------
     台词标签 <d>…</d> 内部与引号内部不展开别名：台词是给 H3 念的字，换成
     <Picture n> 会把它念错或搞乱口型。转义 \别名 同理（保留文字，末尾去掉
     反斜杠）。改动必须与 csglide_cast.py 的 _PROTECT_RE 保持一致。 */
  /* 末两项是「引号开了没闭」的兜底：打字打到一半、或台词跨行只写了一半时，
     闭引号还没出现，闭引号规则匹配不上，后半个引号里的名字就会被替换。
     这里按行兜住到行尾——引号本就不跨行，吞掉一整段才是更大的事故。 */
  const PROTECT_SRC = "<d>[\\s\\S]*?<\\/d>|\"[^\"\\n]*\"|\u201c[^\u201d\\n]*\u201d"
    + "|\"[^\"\\n]*(?=$|\\n)|\u201c[^\u201d\\n]*(?=$|\\n)";
  const PROTECT_FLAG = "gm";       // m：让上面兜底项的 $ 认行尾
  const ESC = "\u0000";            // 哨兵：提示词里不可能出现的字符

  /* 这些正则每次击键都要重建几百遍（每个别名一遍、每处扫描一遍），而它们
     只随别名集合变化——按「模式串 + flags」缓存编译结果即可。换别名表会
     产出新串，旧条目随之变成垃圾，所以设个上限定期清空，别让它无限长。 */
  const reCache = new Map();
  function reOf(src, flags) {
    const k = (flags || "") + "\u0001" + src;
    let r = reCache.get(k);
    if (!r) {
      if (reCache.size > 200) reCache.clear();
      r = new RegExp(src, flags);
      reCache.set(k, r);
    }
    return r;
  }

  function protectRanges(text) {
    const re = reOf(PROTECT_SRC, PROTECT_FLAG);
    re.lastIndex = 0;              // 复用同一个对象，进循环前先归位
    const out = [];
    let m;
    while ((m = re.exec(text))) out.push([m.index, m.index + m[0].length]);
    return out;
  }
  const inRanges = (i, rs) => rs.some(([s, e]) => i >= s && i < e);
  /* 只对保护区**外面**的片段做变换，保护区原样通过 */
  function mapOutside(text, fn) {
    const re = reOf(PROTECT_SRC, PROTECT_FLAG);
    re.lastIndex = 0;
    let out = "", pos = 0, m;
    while ((m = re.exec(text))) {
      if (m.index > pos) out += fn(text.slice(pos, m.index));
      out += m[0];
      pos = m.index + m[0].length;
    }
    return out + (pos < text.length ? fn(text.slice(pos)) : "");
  }
  /* 首尾有没有反斜杠/哨兵也进边界：转义过的别名不能被展开 */
  const EDGE_L = { ascii: "(?<![\\u0000\\\\A-Za-z0-9])", cjk: "(?<![\\u0000\\\\0-9])" };
  const EDGE_R = { ascii: "(?![A-Za-z0-9])", cjk: "(?![0-9])" };
  /* 别名首尾是不是 ASCII 字母：决定用哪套边界。中文没有空格分词，若连汉字
     一起挡，「看小明走过来」这种最常见的剧本句式会整个失效。 */
  const aliasEdges = (keys) => {
    const g = { ascii: [], cjk: [] };
    for (const k of keys) g[edgeOf(k)].push(k);
    return g;
  };
  /* 分组的唯一判据：首尾是不是 ASCII 字母。展开与高亮必须共用这一处判定，
     两处各写一遍迟早会飘（一边把「小明Ab刀」当 cjk，另一边当 ascii）。 */
  const edgeOf = (k) => (/[A-Za-z]/.test(k[0] + k[k.length - 1]) ? "ascii" : "cjk");

  /* 展开结果同样缓存：击键时同一段文本会被 hasToken / 展示条 / 过滤各问一遍，
     每次都重跑全部别名太浪费。键 = 别名表版本 + 原文。 */
  let expCache = { in: null, out: null };
  function expandAliases(text) {
    if (!text) return text;
    const { map, strict } = aliasInfo();
    const names = Object.keys(map);
    if (!names.length) return String(text);
    const ckey = (aliasCache.key || "") + "\u0001" + text;
    if (expCache.in === ckey) return expCache.out;
    expCache = { in: ckey, out: null };
    /* 转义：\别名 → 哨兵 + 别名（哨兵让边界断言挡住展开），末尾统一还原 */
    const escaped = String(text).replace(
      reOf("\\\\(?=" + names.map(escRe).join("|") + ")", "g"), ESC);

    /* 全局按长度倒序、**逐个别名**替换。不能分 ascii/cjk 两组批量替换：
       短别名（ascii 组）会抢先吃掉长别名（cjk 组）里的一段——别名「小明Ab刀」
       加「Ab」时，「小明Ab刀」会被截成「小明@图片2刀」。逐个按长度先长后短
       就没有这个问题；替换结果是 @图片N（不含任何别名，且「图片N」是禁用的
       别名），所以也不会连锁。 */
    const ordered = names.slice().sort((a, b) => b.length - a.length);
    const seg = (s) => {
      if (!s) return s;
      /* 全角空格在这里归一：seg 只收到**保护区之外**的片段（台词 <d>…</d>
         与引号内整段跳过），所以模型要念的字一个字符都不会被动。必须早于
         下面的匹配——名字在 aliasList 里已归一成半角，正文不归一就永远对不上。 */
      s = normSpace(s);
      for (const n of ordered) {
        const edge = edgeOf(n);
        const at = strict.has(n) ? "@" : "@?";   // 仅 @ 触发的那组必须带 @
        const re = reOf(EDGE_L[edge] + at + "(" + escRe(n) + ")" + EDGE_R[edge], "g");
        s = s.replace(re, () => map[n]);
      }
      return s;
    };
    return (expCache.out = mapOutside(escaped, seg).split(ESC).join(""));
  }

  /* 编辑器高亮用：规范 @标签 与别名都能命中；别名带出 canon（规范 token），
     供 fileForToken 判定有图/空槽位。 */
  function editTokRe() {
    const { map: am, strict } = aliasInfo();
    const keys = Object.keys(am);
    if (!keys.length) return { re: reOf(EDIT_TOK, "g"), am };
    const parts = [];
    /* 作用域必须体现在高亮上：「仅 @ 触发」的别名如果裸着也标成引用色，
       等于告诉用户这句会引用，而实际只有写 @小明 才引用——高亮在骗人。
       所以分两组：auto 组允许 @?，strict 组强制 @。组名带 s/u 前缀，
       调用方按「哪组有值」取原文。 */
    for (const scope of ["auto", "strict"]) {
      const ks = keys.filter((k) => (scope === "strict") === strict.has(k));
      if (!ks.length) continue;
      const g = aliasEdges(ks);
      for (const key of ["ascii", "cjk"]) {
        if (!g[key].length) continue;
        g[key].sort((a, b) => b.length - a.length);   // 长名优先，短名不能抢
        const L = EDGE_L[key];
        const R = key === "ascii" ? "(?![A-Za-z0-9])" : "(?![0-9])";
        const at = scope === "strict" ? "@" : "@?";
        const gn = (scope === "strict" ? "s" : "g") + (key === "ascii" ? "a" : "c");
        /* 别名里的空格在正文里可能被写成半角，也可能被输入法写成全角 U+3000。
           别名表里的 key 已归一成半角，所以这里把 key 的空格展开成 [ 　]，
           两种写法都能点亮——否则用户打了全角空格时功能其实生效了（展开那一路
           会归一），高亮却不亮，等于告诉他「这句没引用」，又是静默不一致。
           捕获组拿到的是**用户原文**，textContent 保留它，编辑器回读不变。 */
        const alt = g[key].map((n) => escRe(n).replace(/ /g, "[ \u3000]")).join("|");
        parts.push(L + at + "(?<" + gn + ">" + alt + ")" + R);
      }
    }
    const re = reOf(EDIT_TOK + "|" + parts.join("|"), "g");
    re.lastIndex = 0;
    return { re, am };
  }
  /* 取别名组里真正命中的那个（四组里只可能有一组有值） */
  const alOf = (g) => {
    for (const k of ["ga", "gc", "sa", "sc"]) if (g && g[k] !== undefined) return g[k];
    return null;
  };
  function buildEditor(text) {
    ta.replaceChildren();
    const marks = [];
    let m;
    /* 动态正则：别名集合随媒体架变化，不能写死。别名命中时带出 canon
       （规范 @图片N）——高亮显示的是剧本原文，判定有无素材则用 canon。 */
    const { re: tokRe, am: tokAm } = editTokRe();
    /* 台词/引号里的别名不标成引用色——它不会被展开，标了等于骗人。
       规范 @标签 不受影响：那是显式写的，不存在误伤。 */
    const guards = protectRanges(text);
    while ((m = tokRe.exec(text))) {
      const g = m.groups || {};
      const al = alOf(g);
      if (al != null && inRanges(m.index, guards)) continue;
      /* al 是**用户原文**（可能是全角空格写法），tokAm 的键是归一后的半角，
         所以查表前先归一——不归一就会 canon 取不到，chip 被标成 miss。 */
      marks.push(al != null
        ? { i: m.index, len: m[0].length, tok: m[0], canon: tokAm[normSpace(al)] }
        : { i: m.index, len: m[0].length, tok: m[0] });
    }
    EDIT_D.lastIndex = 0;
    while ((m = EDIT_D.exec(text))) marks.push({ i: m.index, len: m[0].length, d: m[1] });
    marks.sort((a, b) => a.i - b.i || b.len - a.len);   // 长匹配优先，避免重叠时互相吃掉

    let pos = 0;
    for (const mk of marks) {
      if (mk.i < pos) continue;                          // 已被前一个更长的匹配覆盖
      ta.append(document.createTextNode(text.slice(pos, mk.i)));
      if (mk.tok !== undefined) {
        const sp = document.createElement("span");
        const canon = mk.canon || mk.tok;
        const slotFile = fileForToken(canon);
        sp.className = "tok " + ((slotFile || (refsWired() && isRefToken(canon))) ? "has" : "miss");
        sp.textContent = mk.tok;                         // 保留原文，textContent 回读不变
        sp.dataset.tok = mk.tok;
        if (mk.canon) sp.dataset.canon = mk.canon;
        ta.append(sp);
      } else {
        ta.append(document.createTextNode("<d>"));       // keep the delimiter
        const sp = document.createElement("span");
        sp.className = "d";
        sp.textContent = mk.d;
        ta.append(sp);
        ta.append(document.createTextNode("</d>"));
      }
      pos = mk.i + mk.len;
    }
    const tail = text.slice(pos);
    if (tail) ta.append(document.createTextNode(tail));
  }
  /* ---- 撤销栈 -------------------------------------------------------
     高亮靠 buildEditor 重建 DOM，浏览器原生 undo 栈随之作废；更麻烦的是
     Ctrl+Z 落在 contenteditable 上时，Chrome 会把同一编辑上下文里父容器的变更
     一并回滚——renderTags() 写素材标签就发生在 .gcastL-pwrap 之下，于是一次
     Ctrl+Z 连素材标签一起回滚没了（节点发灰、标签消失、无法引用）。
     这里自己接管：只存文本快照，恢复走 setEditorText（与高亮同源，互不打架），
     按键一律 preventDefault + 阻止冒泡——浏览器和画布都不许插手（LiteGraph 的
     processKey 只跳过 <input>，不认 contenteditable，冒泡上去会回滚整个工作流）。*/
  const undoStack = [], redoStack = [];
  let undoMark = "", undoTime = 0;
  /* 连续打字按 600ms 合并成一步，免得一个字撤一次 */
  function pushUndo(text) {
    if (text === undoMark) return;
    const now = Date.now();
    if (now - undoTime > 600) {
      undoStack.push(undoMark);
      if (undoStack.length > 100) undoStack.shift();
      undoTime = now;
    }
    undoMark = text;
    redoStack.length = 0;
  }
  function restoreUndo(text) {
    undoMark = text; undoTime = 0;
    st.prompt = text;
    setEditorText(text, text.length, true);
    renderTags(); renderCheck(); commit();
  }
  function setEditorText(text, caretPos, focus) {
    buildEditor(text);
    if (focus) ta.focus();
    setCaret(caretPos >= 0 ? caretPos : text.length);
    undoMark = text;   /* 整体替换（加载/插入/恢复）后重置撤销基准 */
  }
  /* Re-highlight after typing has gone quiet: save the caret, rebuild, restore
   * it. Never run mid-IME (a DOM rewrite would cancel the candidate window),
   * and never steal focus. */
  let hlTimer = 0, composing = false;
  function applyHighlight() {
    /* 拼字期间绝不重建 DOM：compositionend 后 300ms 的重绘若撞上下一轮
     * 拼字（连续输入），buildEditor 会杀死输入法组合、把在飞的拼音固化成
     * 字母。正在拼字就顺延，等 compositionend 之后再做。 */
    if (composing) { scheduleHighlight(); return; }
    const caret = edCaret();
    const focused = document.activeElement === ta;
    const scrollTop = ta.scrollTop;
    buildEditor(edText() || st.prompt || "");
    ta.scrollTop = scrollTop;   // rebuilding children can reset the scroll
    if (focused) ta.focus();
    setCaret(Math.min(caret.e, edText().length));
  }
  function scheduleHighlight() {
    clearTimeout(hlTimer);
    hlTimer = setTimeout(applyHighlight, 300);
  }
  /* 轻量高亮刷新：只按 fileForToken 重设 @token 的 has/miss class，不重建
     DOM——安全用于焦点在编辑区时（光标、选区、IME 候选都不受影响）。
     判定必须与 buildEditor 完全一致（有实际文件，或接线了媒体架的合法
     @标签——执行时槽位由媒体架按需提供），否则两条路径会给出不同的
     has/miss 显示，用户会看到标签「忽而识别忽而不识别」。 */
  function refreshTokClasses() {
    ta.querySelectorAll(".tok").forEach((sp) => {
      const tok = sp.dataset.canon || sp.dataset.tok;   // 别名命中时用规范 token 判定
      if (!tok) return;
      const ok = !!fileForToken(tok) || (refsWired() && isRefToken(tok));
      sp.classList.toggle("has", ok);
      sp.classList.toggle("miss", !ok);
    });
  }
  ta.addEventListener("compositionstart", () => { composing = true; });
  ta.addEventListener("compositionend", () => { composing = false; scheduleHighlight(); });
  /* Paste plain text only — contenteditable="plaintext-only" is Chromium-only,
   * and the `true` fallback on other browsers would otherwise let rich HTML in.
   * stopImmediatePropagation keeps the paste event (and with it ComfyUI's
   * document-level node-paste handler) from ever seeing it. */
  ta.addEventListener("paste", (e) => {
    e.preventDefault();
    e.stopImmediatePropagation();
    /* 先归一化再插入：粘贴官方英文提示词（<Picture 1>…）是最常见的入口，
       插入前改写能让光标自然停在插入点末尾，不必事后重建编辑器。 */
    const t = normalizeRefs((e.clipboardData || window.clipboardData).getData("text/plain"),
                            mergedSlots());
    insertTextNode(t);
    /* 粘贴是程序化的 DOM 写入，不会触发 input 事件，必须手动把新文本
     * 写回 st.prompt 并 commit，否则后端拿到的仍是旧提示词。 */
    st.prompt = ta.textContent || "";
    scheduleHighlight();
    renderTags(); renderCheck(); maybeAC(); commit();
  });
  /* Same guard for copy/cut: ComfyUI's document-level copy handler calls
   * canvas.copyToClipboard() for graph targets — never for the editor. */
  ta.addEventListener("copy", (e) => { e.stopPropagation(); });
  ta.addEventListener("cut", (e) => { e.stopPropagation(); });

  /* ---- @标签 悬停预览：鼠标停在提示词里的 @图片N / @视频N / @音频N 上，
   * 弹出对应参考的缩略图；空槽位则提示需要补充素材。事件委托在 ta 上，
   * 因为 buildEditor 每次重建 span，逐个绑定会被反复丢弃。 */
  const tip = el("div", "gcastL-toktip");
  document.body.append(tip);
  /* token 必须是**规范 token**，不是提示词里的原文：别名命中的 span 上
     dataset.tok 存的是剧本原文（小明），dataset.canon 才是 @图片N。拿别名去
     fileForToken 一定落空（它只认 @图片N / @视频N / @音频N），于是每个别名都被
     误报成「指向空槽位」——@标签本身 tok === canon，所以只有别名会踩到。
     判定与 buildEditor / refreshTokClasses 保持同一套：canon || tok。
     label 只为 tooltip 文案服务：别名命中时显示「小明 → @图片1」，裸 @标签
     则只显示 token 本身。 */
  function showTokTip(token, anchor, label) {
    const file = fileForToken(token);
    const cap = label && label !== token ? label + " \u2192 " + token : token;
    tip.replaceChildren();
    if (!file) {
      tip.append(el("span", "cap", cap + " 指向空槽位，请补充参考素材"));
    } else if (/^@视频/.test(token)) {
      const v = el("video"); v.src = viewURL(file); v.muted = true;
      v.preload = "metadata"; v.playsInline = true;
      tip.append(v, el("span", "cap", cap));
    } else if (/^@音频/.test(token)) {
      tip.append(el("span", "glyph", "\u266a"), el("span", "cap", cap));
    } else {
      const im = el("img"); im.src = viewURL(file);
      tip.append(im, el("span", "cap", cap));
    }
    tip.style.display = "block";
    const r = anchor.getBoundingClientRect();
    const tw = tip.offsetWidth || 170;
    const th = tip.offsetHeight || 120;
    tip.style.left = Math.min(Math.max(8, r.left), window.innerWidth - tw - 8) + "px";
    /* 预览保持原始比例后高度不定：下方放得下就悬在标签下方，放不下改到上方，
     * 都钳在视口内。 */
    let top = r.bottom + 6;
    if (top + th > window.innerHeight - 8) top = r.top - th - 6;
    tip.style.top = Math.max(8, Math.min(top, window.innerHeight - th - 8)) + "px";
  }
  const tokFromEvent = (e) => {
    let n = e.target;
    if (n && n.nodeType === 3) n = n.parentElement;
    return (n && n.closest) ? n.closest(".tok") : null;
  };
  ta.addEventListener("mouseover", (e) => {
    const t = tokFromEvent(e);
    /* canon 优先：别名命中的 span 用规范 token 查素材，别名原文只作显示标签 */
    if (t) showTokTip(t.dataset.canon || t.dataset.tok, t, t.dataset.tok);
    else tip.style.display = "none";
  });
  ta.addEventListener("mouseout", (e) => {
    const t = tokFromEvent(e);
    if (t && !t.contains(e.relatedTarget)) tip.style.display = "none";
  });
  /* Expand, collapse, a node resize and the drag handle all change the
   * editor's box; the gutter is positioned from it, so it has to follow. */
  if (window.ResizeObserver) {
    new ResizeObserver(() => syncGutter()).observe(ta);
  }
  window.addEventListener("resize", () => syncGutter());

  midWrap.append(row, contWrap);
  root.append(bar, tl, modeBar, midWrap, flWrap, pWrap);
  /* the strip is laid out in pixels, so it has to be re-measured whenever the
     node is resized -- there is no CSS that can do proportional-with-a-floor */
  if (window.ResizeObserver) new ResizeObserver(() => paintTimeline()).observe(tlView);

  /* ------------------------------------------------------------ slots */

  function clearSlot(slot) { for (const k of Object.keys(slot)) delete slot[k]; }

  /* A token is only "in the prompt" if it isn't a prefix of a longer one —
   * @视频1 must not match inside @视频音频1. */
  const tokenRe = (t) => new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(?![0-9A-Za-z])", "g");
  const hasToken = (t) => !!t && tokenRe(t).test(effPrompt());

  function fileKind(f) {
    const t = f?.type || "";
    if (t.startsWith("image/")) return "image";
    if (t.startsWith("video/")) return "video";
    if (t.startsWith("audio/")) return "audio";
    /* No MIME type at all is common for containers the OS does not know --
       mkv on a machine without a matroska registration is the usual one. The
       extension still says what it is. */
    const ext = (f?.name || "").split(".").pop().toLowerCase();
    return EXT_KIND[ext] || "";   /* still unknown: let it through, don't block */
  }

  /* First empty slot of the right kind, else the last one so a full rack still
     takes the file rather than dropping it on the floor. Tokens are renumbered
     against filled slots at emit, so the index chosen here does not matter.
     For images, prefer an empty slot whose @图片N is already referenced in the
     prompt, so re-pasted references land on the number the prompt expects. */
  /* 参考图/视频/音频槽位 UI 已外迁至「🗂️ H3 媒体架」（refs 接线），面板不再
   * 接收参考素材：拖到面板空白处的文件会被拒绝（防止静默填进看不见的槽位）。
   * 首末帧卡与续写卡有各自的 wireDrop，卡级拖放不受影响。绑定关系永久固定：
   * 素材落在媒体架哪个格，@图片N 就永远指它，任何自动逻辑都不得搬动。 */

  /* refs 端口接线时，参考素材由媒体架提供、面板槽位为空不代表缺失——
   * 提示词里 @图片N/@视频N/@音频N 的 miss 警示据此豁免（@first/@last 仍归面板）。 */
  const isRefToken = (t) => /^@(?:图片|视频|音频)/.test(t);
  const refsWired = () => !!rackNodeOf(node);

  /* 外接提示词（模式 A）：prompt_text 接线即外部文本整体接管。所有展示型
   * 逻辑（高亮 / 检查 / 分镜条 / 按需过滤）都读 effPrompt()；st.prompt 的
   * 存储永不被外部数据污染，断线即恢复面板原文。 */
  const promptWired = () => !!promptNodeOf(node);
  /* 一次渲染里 effPrompt() 会被问十几遍（每个 chip 一次 hasToken、展示条
     一次、告警一次……），而它只在「原文」或「别名表」变了才会变——按这两
     者做键缓存下来。别名表版本要先刷新，否则改完别名还会命中旧结果。 */
  let effCache = { key: "", out: "" };
  const effPrompt = () => {
    /* 别名先展开、再归一化：名为 image 3.png 的素材若先走归一化，会被英文
       规则抢成 @图片1，指向完全错误的槽位。
       注意这里返回的是「送模型」用的展开文本——编辑器里仍是剧本原文，
       hasToken / 按需过滤 / 展示条都靠它识别别名引用。 */
    const raw = !promptWired() ? (st.prompt || "") : upstreamTextOf(promptNodeOf(node));
    aliasInfo();                       // 刷新别名表版本，下面才拿得到新键
    const key = aliasCache.key + "\u0001" + raw;
    if (effCache.key === key) return effCache.out;
    const out = normalizeRefs(expandAliases(raw), mergedSlots());
    effCache = { key, out };
    return out;
  };

  function flashPanel() {
    root.classList.add("gcastL-reject");
    setTimeout(() => root.classList.remove("gcastL-reject"), 320);
  }

  function flashWrong(node_) {
    node_.classList.add("gcastL-reject");
    setTimeout(() => node_.classList.remove("gcastL-reject"), 320);
  }

  async function assign(slot, src, kind, token) {
    /* src 是字符串 = 文件已在 input 目录里的相对路径，直接引用，不再上传 */
    const name = typeof src === "string" ? src : await uploadFile(src);
    clearSlot(slot);
    slot.file = name;
    if (kind !== "image") {
      const d = await probeDuration(viewURL(name), kind === "video");
      slot.dur = d; slot.start = 0; slot.end = d;
      if (kind === "video") slot.audio = true;
    }
    render(); commit();
    /* Dropped or picked clips skip the adopt route entirely, so they arrive
       with no chroma known -- and a clip from somewhere else is precisely the
       one worth checking. Done after the render so the slot appears at once
       and the badge follows. */
    if (slot === st.cont && kind === "video") tagChroma(slot, name);
  }

  /* Ask the server what a file in input/ actually is. Quiet on failure: an
     unknown chroma just means no badge, which is the state before this ran. */
  async function tagChroma(slot, name) {
    try {
      const i = name.lastIndexOf("/");
      const sub = i >= 0 ? name.slice(0, i) : "";
      const base = i >= 0 ? name.slice(i + 1) : name;
      const r = await api.fetchApi("/cglide/probe?type=input"
        + `&filename=${encodeURIComponent(base)}&subfolder=${encodeURIComponent(sub)}`);
      if (r.status !== 200) return;
      const d = await r.json();
      if (slot.file !== name) return;      /* the slot moved on while we waited */
      slot.chroma = d.chroma || "";
      slot.codec = d.codec || "";
      /* a container the browser could not decode still has a real duration */
      if (!slot.dur && d.duration) {
        slot.dur = d.duration; slot.start = 0; slot.end = d.duration;
      }
      render(); commit();
    } catch (err) {
      console.warn("[H3 Studio] probe failed:", err);
    }
  }

  /* ------------------------------------------------- adopt a finished render
   * Renders land in output/, guides are read from input/cglide/. The copy is
   * done SERVER-SIDE by /cglide/adopt_output -- pulling a 12s 4:4:4 file into
   * the browser only to post the same bytes back would move hundreds of
   * megabytes across the loopback for a disk copy.
   */
  /* ------------------------------------------------ what am I about to take?
   * Hovering the button probes the newest output and says what it is, BEFORE
   * it is adopted. Worth the round trip because chroma is not cosmetic here:
   * measured on the same clip pair, an AV1 yuv420p10le guide made Glide Join
   * report a -2 frame correspondence on every run, while 4:2:2 and 4:4:4
   * guides reported none. Three quarters of the chroma is gone before the
   * model sees the frames, so the anchor is weaker.
   * Probing is cached server-side on path+mtime, so a second hover is free. */
  const CHROMA_WARN = "4:2:0";
  let hoverProbe = null;

  function describeSource(info) {
    if (!info || !info.name) return "取用输出目录里最新的视频";
    const what = [info.codec, info.chroma].filter(Boolean).join(" ");
    const head = what ? `${info.name} — ${what}` : info.name;
    if (info.chroma === CHROMA_WARN) {
      return head + "\n\n该视频为色度亚采样（4:2:0）：进入模型的参考只保留四分之一的色度信息。";
    }
    return head;
  }

  function primeLastRenderTip(btn) {
    /* one request per hover, and the answer is reused for the next one */
    if (hoverProbe) { hoverProbe.then((i) => { btn.title = describeSource(i); }); return; }
    hoverProbe = api.fetchApi("/cglide/recent_outputs?limit=1&probe=1")
      .then((r) => (r.status === 200 ? r.json() : []))
      .then((list) => (Array.isArray(list) && list.length ? list[0] : null))
      .catch(() => null);
    hoverProbe.then((i) => { btn.title = describeSource(i); });
    /* the newest output changes as soon as anything renders */
    setTimeout(() => { hoverProbe = null; }, 15000);
  }

  /* Adopt one NAMED output. Shared by the button and by the run loop, which
     needs a specific file rather than whatever happens to be newest. */
  async function adoptInto(slot, pick) {
    const a = await api.fetchApi("/cglide/adopt_output", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        filename: pick.name, subfolder: pick.subfolder || "", type: pick.type || "output",
      }),
    });
    if (a.status !== 200) throw new Error(`导入输出失败 (${a.status})`);
    const d = await a.json();
    const name = d.subfolder ? `${d.subfolder}/${d.name}` : d.name;
    clearSlot(slot);
    slot.file = name;
    /* Ask the browser first; fall back to the server's reading. The browser
       reports 0 for anything it cannot decode, and HEVC 4:4:4 in Matroska --
       what the high-fidelity preset writes -- is exactly that case. Without a
       duration there is no window to draw. */
    let dur = await probeDuration(viewURL(name), true);
    if (!dur) dur = Number(d.duration) || 0;
    slot.dur = dur; slot.start = 0; slot.end = dur;
    slot.audio = true;
    /* Assigned unconditionally, including to nothing: a blank probe must clear
       a previous file's label rather than leave it standing over the new one. */
    slot.chroma = d.chroma || "";
    slot.codec = d.codec || "";
    /* start/end left at the full range on purpose: the render pass snaps an
       untouched continuation clip to its last 22 frames. */
    return d;
  }

  async function adoptLastRender(slot, card, btn) {
    if (btn) { btn.disabled = true; btn.textContent = "\u2026"; }
    try {
      const r = await api.fetchApi("/cglide/recent_outputs?limit=1");
      if (r.status !== 200) throw new Error(`获取最新输出失败 (${r.status})`);
      const list = await r.json();
      if (!Array.isArray(list) || !list.length) {
        /* Nothing rendered yet, or the outputs went somewhere else. Say so
           rather than failing mutely. */
        console.warn("[H3 Studio] no video found in the output folder");
        flashWrong(card);
        return;
      }
      await adoptInto(slot, { ...list[0], type: "output" });
      render(); commit();
    } catch (err) {
      console.error("[H3 Studio] could not adopt the last render:", err);
      flashWrong(card);
    } finally {
      if (btn && btn.isConnected) { btn.disabled = false; btn.textContent = "引用最新渲染"; }
    }
  }

  function wireDrop(node_, slot, kind, accept, token) {
    /* 可疑图片格式：MIME 齐全，能过 fileKind() 的关进到图片槽，但后端 PIL 没有
       解码器——收了只会一路炸到模型端。提前拒绝，沿用导演台既有的拒绝语言
       （卡片红框闪一下）；面板里没有 toast 体系，原因挂到 title 上，鼠标移上去
       能看全，3 秒后摘掉免得残留误导。 */
    const rejectBad = (f) => {
      if (kind !== "image") return false;
      const bad = badImageKind(f);
      if (!bad) return false;
      flashWrong(node_);
      const msg = `「${f.name}」是 ${bad}，无法作为参考图，请先转成 PNG/JPG`;
      node_.title = msg;
      setTimeout(() => { if (node_.title === msg) node_.title = ""; }, 3000);
      console.warn(`[H3 导演台] 拒绝可疑参考图：${msg}`);
      return true;
    };
    node_.addEventListener("click", async (e) => {
      if (e.target.closest(".gcastL-x, .gcastL-track, .gcastL-chk, .gcastL-times, .gcastL-quick")) return;
      const f = await pickFile(accept);
      if (f && !rejectBad(f)) await assign(slot, f, kind, token);
    });
    node_.dataset.kind = kind;
    /* The paste handler finds its target by hover, and a hovered element only
     * knows its kind from the dataset. Carry the slot object and its token on
     * the element too, so a paste can go straight into the slot under the
     * pointer instead of always routing to the first free one. Re-set on every
     * render, since these elements are rebuilt. */
    node_.__gcastLSlot = slot;
    node_.__gcastLToken = token || null;
    node_.addEventListener("dragover", (e) => {
      const k = dragKind(e);
      if (k === null) return;                    /* not a file: leave it alone */
      e.preventDefault(); e.stopPropagation();
      /* a mismatch stays unhighlighted, so the wrong slot never looks willing */
      node_.classList.toggle("drop", k === "" || k === kind);
    });
    /* dragleave also fires crossing into a child, which made the highlight
       flicker. Only clear when the pointer has really left the card. */
    node_.addEventListener("dragleave", (e) => {
      if (!node_.contains(e.relatedTarget)) node_.classList.remove("drop");
    });
    node_.addEventListener("drop", async (e) => {
      const k = dragKind(e);
      if (k === null) return;
      e.preventDefault(); e.stopPropagation(); node_.classList.remove("drop");
      const ref = relFromEvent(e);
      if (ref) {
        if (fileKind({ name: ref }) !== kind) { flashWrong(node_); return; }
        await assign(slot, ref, kind, token);
        return;
      }
      const f = e.dataTransfer?.files?.[0];
      if (!f) return;
      if (fileKind(f) && fileKind(f) !== kind) { flashWrong(node_); return; }
      if (rejectBad(f)) return;
      await assign(slot, f, kind, token);
    });
  }

  function imageSlot(slot, caption, token, badge) {
    const card = el("div", "gcastL-slot" + (slot.file ? " filled" : ""));
    const thumb = el("div", "gcastL-thumb");
    if (slot.file) {
      const img = el("img"); img.src = viewURL(slot.file); img.loading = "lazy";
      img.draggable = false;   /* keep the card's drag; the img is natively draggable */
      thumb.append(img);
    } else thumb.append(el("div", "gcastL-empty", "+"));
    card.append(thumb);
    if (badge) {
      /* Reference cells: a corner number dot on the image (carrying the
         @图片N identity), with a caption bar below showing just the original
         filename and the clear control pushed to the far end. */
      thumb.append(el("span", "gcastL-num", caption));
      const cap = el("div", "gcastL-cap");
      if (slot.file) {
        const fn = el("span", "fn", slot.file.split("/").pop());
        fn.title = slot.file;
        cap.append(fn);
      }
      cap.append(el("div", "spacer"));
      if (slot.file) {
        const x = el("button", "gcastL-x", "×");
        x.title = "清除槽位";
        x.onclick = (e) => { e.stopPropagation(); clearSlot(slot); render(); commit(); };
        cap.append(x);
      }
      card.append(cap);
    }
    if (!badge) {
      const cap = el("div", "gcastL-cap");
      cap.append(el("span", "n", caption));
      if (slot.file && token) cap.append(el("span", null, token));
      if (slot.file) {
        const x = el("button", "gcastL-x", "×");
        x.title = "清除槽位";
        x.onclick = (e) => { e.stopPropagation(); clearSlot(slot); render(); commit(); };
        cap.append(x);
      }
      card.append(cap);
    }
    return card;
  }

  /* ---- waveforms ---------------------------------------------------
   * Decoded once per file and cached. decodeAudioData handles whatever the
   * browser can play, so an mp4's soundtrack works as well as a wav.
   */
  const wavCache = new Map();

  /* ---- media element reuse ------------------------------------------
   * render() rebuilds every slot, and a fresh <video> with a src reloads:
   * the poster frame drops out and comes back, which reads as the whole
   * video rack blinking every time an image is pasted or replaced. Nothing
   * is actually wrong, but you have to look to be sure.
   *
   * The element is kept per slot instead and re-appended. Moving a live media
   * element to a new parent does NOT reload it, so the frame stays put.
   * Keyed weakly on the slot object, which survives renders and is dropped
   * with the state on load().
   */
  const mediaCache = new WeakMap();

  /* trim() re-wires transport listeners on every render. On a NEW element that
   * is free; on a reused one they would stack up, so every added listener is
   * recorded and cleared before the slot is wired again. */
  function onMedia(m, ev, fn) {
    (m.__gcastLL || (m.__gcastLL = [])).push([ev, fn]);
    m.addEventListener(ev, fn);
  }
  function clearMediaListeners(m) {
    for (const [ev, fn] of m.__gcastLL || []) m.removeEventListener(ev, fn);
    m.__gcastLL = [];
  }

  /* Same element back while the file is unchanged; a new one when the slot has
   * been given a different file, since that genuinely has to load. */
  function mediaFor(slot, tag, file) {
    const cached = mediaCache.get(slot);
    if (cached && cached.tagName === tag.toUpperCase() && cached.__gcastLFile === file) {
      clearMediaListeners(cached);
      return cached;
    }
    const m = el(tag);
    m.__gcastLFile = file;
    m.src = viewURL(file);
    m.preload = "metadata";
    mediaCache.set(slot, m);
    return m;
  }

  function peaksFor(file) {
    if (wavCache.has(file)) return wavCache.get(file);
    const job = (async () => {
      const buf = await (await fetch(viewURL(file))).arrayBuffer();
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return null;
      const ctx = new Ctx();
      try {
        const audio = await ctx.decodeAudioData(buf);
        const ch = audio.getChannelData(0);
        const N = 1400, block = Math.max(1, Math.floor(ch.length / N));
        const out = new Float32Array(N);
        let peak = 0;
        for (let i = 0; i < N; i++) {
          let m = 0;
          const s0 = i * block;
          for (let k = 0; k < block; k += 3) {
            const v = Math.abs(ch[s0 + k] || 0);
            if (v > m) m = v;
          }
          out[i] = m;
          if (m > peak) peak = m;
        }
        if (peak > 0) for (let i = 0; i < N; i++) out[i] /= peak;   // normalise for display
        return out;
      } finally { ctx.close?.(); }
    })().catch(() => null);
    wavCache.set(file, job);
    return job;
  }

  function drawWave(cv, peaks) {
    const w = cv.clientWidth || 1, h = cv.clientHeight || 44;
    const dpr = window.devicePixelRatio || 1;
    cv.width = Math.max(1, Math.round(w * dpr));
    cv.height = Math.max(1, Math.round(h * dpr));
    const g = cv.getContext("2d");
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    if (!peaks) {
      g.strokeStyle = "rgba(255,255,255,.10)";
      g.beginPath(); g.moveTo(0, h / 2); g.lineTo(w, h / 2); g.stroke();
      return;
    }
    const mid = h / 2, pad = 3;
    g.fillStyle = "rgba(255,255,255,.34)";
    for (let x = 0; x < w; x++) {
      const v = peaks[Math.min(peaks.length - 1, Math.floor((x / w) * peaks.length))] || 0;
      const bar = Math.max(1, v * (mid - pad));
      g.fillRect(x, mid - bar, 1, bar * 2);
    }
  }

  /* Reference videos are re-snapped DOWN to the 17k+5 grid after trimming, so a
   * 20-frame trim silently becomes 5. Handles stay free; the readout tells the
   * truth about what survives. */
  const gridDown = (n) => { let g = Math.floor(n); while (g > 0 && g % 17 !== 5) g--; return g; };
  const effFrames = (span, capFrames) => {
    let want = Math.max(0, Math.round(span * FPS) + 1);
    if (capFrames) want = Math.min(want, capFrames);
    return gridDown(want);
  };
  const gridSpans = (dur) => {
    const out = [];
    for (let g = 5; ; g += 17) {
      const sp = (g - 1) / FPS;
      if (sp > dur) break;
      out.push({ g, sp });
    }
    return out;
  };

  /* dual-handle trim, in seconds, clamped to the clip's own duration */
  function trim(slot, usedSeconds, isVideo, media, label, tailOnly) {
    const wrap = el("div", "gcastL-trim");
    const track = el("div", "gcastL-track");
    const wave = el("canvas", "gcastL-wave");
    const head = el("div", "gcastL-head");
    const span = el("div", "gcastL-span");
    const hA = el("div", "gcastL-h a"); hA.tabIndex = 0; hA.title = "修剪起点";
    const hB = el("div", "gcastL-h b"); hB.tabIndex = 0; hB.title = "修剪终点";
    const used = el("div", "gcastL-used");
    track.append(wave, span, used, head, hA, hB);
    /* Chroma sits ON the waveform, at the left, because that is where the eye
     * already is when judging the window. Green for 4:4:4 and 4:2:2, which
     * both anchored cleanly in testing; amber-red for 4:2:0, which made Glide
     * Join report a frame correction on every run. */
    if (slot.chroma) {
      const weak = slot.chroma === CHROMA_WARN;
      const chip = el("div", "gcastL-chroma" + (weak ? " weak" : ""), slot.chroma);
      chip.title = weak
        ? `${slot.codec || "源"} ${slot.chroma} —— 色度亚采样：进入模型的参考只保留四分之一的色度信息。`
        : `${slot.codec || "源"} ${slot.chroma}`;
      track.append(chip);
    }
    if (label) track.append(el("div", "gcastL-wavlabel", label));
    const times = el("div", "gcastL-times");
    const play = el("button", "gcastL-play", "\u25B6");
    play.title = "播放修剪区间";
    const tL = el("span"), tR = el("span");
    times.append(play, tL, tR);
    wrap.append(track, times);

    /* waveform: draw once decoded, and again if the node is resized */
    if (slot.file) {
      peaksFor(slot.file).then((pk) => drawWave(wave, pk));
      try {
        const ro = new ResizeObserver(() => {
          peaksFor(slot.file).then((pk) => drawWave(wave, pk));
        });
        ro.observe(track);
      } catch (e) { /* older browser: static draw is fine */ }
    }

    /* transport: play only what is selected, and stop at the out point */
    let raf = 0;
    const stopAt = () => {
      if (!media || media.paused) return false;
      /* the out point is enforced here rather than on timeupdate, which
       * only fires ~4x a second and overshoots audibly */
      if (media.currentTime >= slot.end - 0.005 || media.currentTime < slot.start - 0.05) {
        media.pause();
        media.currentTime = slot.start;
        return true;
      }
      return false;
    };
    const paintHead = () => {
      if (!media || media.paused || !dur) { head.style.display = "none"; return; }
      if (stopAt()) { head.style.display = "none"; return; }
      head.style.display = "";
      head.style.left = (media.currentTime / dur) * 100 + "%";
      raf = requestAnimationFrame(paintHead);
    };
    if (media) {
      onMedia(media, "timeupdate", stopAt);
      onMedia(media, "play", () => { play.textContent = "\u23F8"; play.classList.add("on"); paintHead(); });
      onMedia(media, "pause", () => {
        play.textContent = "\u25B6"; play.classList.remove("on");
        cancelAnimationFrame(raf); head.style.display = "none";
      });
      play.onclick = (e) => {
        e.stopPropagation();
        if (!media.paused) { media.pause(); return; }
        media.muted = false;
        media.currentTime = slot.start;
        media.play().catch(() => {});
      };
    } else {
      play.disabled = true;
      play.style.opacity = .35;
      play.title = "该片段没有音频";
    }

    const dur = slot.dur || 0;
    const capFrames = usedSeconds != null ? Math.round(usedSeconds * FPS) : null;

    if (!Number.isFinite(slot.start) || slot.start < 0 || slot.start >= dur) slot.start = 0;
    if (!Number.isFinite(slot.end) || slot.end > dur || slot.end <= slot.start) slot.end = dur;

    const paint = () => {
      if (!dur) return;
      const a = (slot.start / dur) * 100, b = (slot.end / dur) * 100;
      span.style.left = a + "%"; span.style.width = Math.max(0, b - a) + "%";
      hA.style.left = a + "%"; hB.style.left = b + "%";
      tL.textContent = isVideo
        ? `${fmtSecs(slot.start)}  f${Math.round(slot.start * FPS)}`
        : fmtSecs(slot.start);
      const len = slot.end - slot.start;

      if (!isVideo) {
        tR.textContent = fmtSecs(len);
        tR.className = "";
        used.style.display = "none";
        return;
      }
      const f = effFrames(len, capFrames);
      const clipped = capFrames != null && Math.round(len * FPS) + 1 > capFrames;
      const clip = Math.max(0, Math.round(len * FPS) + 1 - f);
      tR.textContent = f < 5 ? "太短——至少5帧" : `已用${f}帧·${fmtSecs(len)}·裁${clip}`;
      tR.className = (f < 5 || clipped) ? "gcastL-warn" : "";
      if (clipped) {
        used.style.display = "";
        used.style.left = ((slot.start + capFrames / FPS) / dur) * 100 + "%";
      } else used.style.display = "none";
    };
    paint();

    /* Park the video on a given time so the thumbnail shows the frame you are
     * pointing at. Hunting for a readable 5-22f window is done by eye, so the
     * picture has to follow the window, not the other way round. Coalesced to
     * one seek per frame - seeking on every pointermove stutters. */
    let seekReq = 0;
    const seekPreview = (t) => {
      if (!media || media.tagName !== "VIDEO") return;
      cancelAnimationFrame(seekReq);
      seekReq = requestAnimationFrame(() => {
        try {
          if (!media.paused) media.pause();
          media.currentTime = Math.min(Math.max(0, t), Math.max(0, dur - 1 / FPS));
        } catch (_) { /* not seekable yet */ }
      });
    };

    const drag = (handle, isStart) => {
      let dragging = false;

      const apply = (clientX) => {
        const r = track.getBoundingClientRect();
        let t = ((clientX - r.left) / r.width) * dur;
        t = Math.min(dur, Math.max(0, t));
        if (isStart) slot.start = Math.min(t, slot.end - 0.25);
        else slot.end = Math.max(t, slot.start + 0.25);
        paint();
        seekPreview(isStart ? slot.start : slot.end);
      };

      /* LiteGraph's canvas consumes pointer/mouse moves, so listen in the
       * CAPTURE phase on document and take pointer capture on the handle. */
      const move = (e) => {
        if (!dragging) return;
        e.preventDefault(); e.stopPropagation();
        apply(e.clientX);
      };
      const up = (e) => {
        if (!dragging) return;
        dragging = false;
        try { handle.releasePointerCapture(e.pointerId); } catch (_) {}
        document.removeEventListener("pointermove", move, true);
        document.removeEventListener("pointerup", up, true);
        document.removeEventListener("mousemove", moveMouse, true);
        document.removeEventListener("mouseup", up, true);
        commit();
      };
      const moveMouse = (e) => { if (dragging) apply(e.clientX); };

      handle.addEventListener("pointerdown", (e) => {
        if (!dur) return;
        e.preventDefault(); e.stopPropagation();
        dragging = true;
        try { handle.setPointerCapture(e.pointerId); } catch (_) {}
        document.addEventListener("pointermove", move, true);
        document.addEventListener("pointerup", up, true);
        document.addEventListener("mousemove", moveMouse, true);
        document.addEventListener("mouseup", up, true);
      });
      handle.addEventListener("pointermove", move);
      handle.addEventListener("keydown", (e) => {
        const step = e.shiftKey ? 1 : 1 / FPS;
        if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
        e.preventDefault();
        const d = e.key === "ArrowLeft" ? -step : step;
        if (isStart) slot.start = Math.min(Math.max(0, slot.start + d), slot.end - 0.25);
        else slot.end = Math.max(Math.min(dur, slot.end + d), slot.start + 0.25);
        paint(); commit();
      });
    };
    /* A continuation window is not free to sit anywhere: it has to END on the
     * previous clip's last frame or the new clip continues from the wrong
     * instant, and the two pieces are then not adjacent in time. Length is the
     * only choice, so the handles and the slide are off in that mode. */
    if (!tailOnly) { drag(hA, true); drag(hB, false); }
    else { hA.style.display = "none"; hB.style.display = "none"; }

    /* Slide the whole window by dragging the track, length preserved.
     *
     * This is bound to the TRACK, not to the span. At the sizes that matter
     * here a 5f window is a few pixels wide and sits entirely underneath the
     * two 11px handles, so the span itself is not a grabbable target. Landing
     * inside the current window keeps the grab offset so the block moves under
     * the finger; landing outside jumps the window to the pointer.
     *
     * The handles stopPropagation on pointerdown, so resizing still wins over
     * sliding. Same capture-phase document listeners as the handles, for the
     * same reason - LiteGraph's canvas eats the move stream otherwise. */
    if (dur && !tailOnly) {
      track.classList.add("slidable");
      let sliding = false, grabOff = 0;

      const timeAt = (clientX) => {
        const r = track.getBoundingClientRect();
        return Math.min(dur, Math.max(0, ((clientX - r.left) / r.width) * dur));
      };
      const place = (clientX) => {
        const len = slot.end - slot.start;
        let s = timeAt(clientX) - grabOff;
        s = Math.min(Math.max(0, s), Math.max(0, dur - len));
        slot.start = s;
        slot.end = Math.min(dur, s + len);
        paint();
        seekPreview(slot.start);
      };

      const sMove = (e) => {
        if (!sliding) return;
        e.preventDefault(); e.stopPropagation();
        place(e.clientX);
      };
      const sMoveMouse = (e) => { if (sliding) place(e.clientX); };
      const sUp = (e) => {
        if (!sliding) return;
        sliding = false;
        track.classList.remove("sliding");
        try { track.releasePointerCapture(e.pointerId); } catch (_) {}
        document.removeEventListener("pointermove", sMove, true);
        document.removeEventListener("pointerup", sUp, true);
        document.removeEventListener("mousemove", sMoveMouse, true);
        document.removeEventListener("mouseup", sUp, true);
        commit();
      };

      track.addEventListener("pointerdown", (e) => {
        e.preventDefault(); e.stopPropagation();
        const t = timeAt(e.clientX);
        grabOff = (t >= slot.start && t <= slot.end) ? t - slot.start : 0;
        sliding = true;
        track.classList.add("sliding");
        try { track.setPointerCapture(e.pointerId); } catch (_) {}
        document.addEventListener("pointermove", sMove, true);
        document.addEventListener("pointerup", sUp, true);
        document.addEventListener("mousemove", sMoveMouse, true);
        document.addEventListener("mouseup", sUp, true);
        place(e.clientX);
      });

      /* Arrow keys nudge the window a frame at a time, Shift a second. */
      track.tabIndex = 0;
      track.addEventListener("keydown", (e) => {
        if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
        e.preventDefault(); e.stopPropagation();
        const len = slot.end - slot.start;
        const d = (e.key === "ArrowLeft" ? -1 : 1) * (e.shiftKey ? 1 : 1 / FPS);
        const s = Math.min(Math.max(0, slot.start + d), Math.max(0, dur - len));
        slot.start = s; slot.end = Math.min(dur, s + len);
        paint(); seekPreview(slot.start); commit();
      });
    }

    /* Span picks set an exact grid length - the values that survive the 17k+5
     * re-snap, so nothing is silently thrown away.
     *
     * An untouched clip (still the full range) gets the tail, which is what a
     * chunk continuation wants. Once the window has been moved the pick keeps
     * the position and only changes the length, because the expensive part is
     * finding the moment and re-finding it after every size change was the
     * annoyance. "> end" pins to the tail on demand. */
    if (isVideo && dur) {
      const quick = el("div", "gcastL-quick");
      const untouched = () => slot.start <= 0.001 && slot.end >= dur - 0.001;
      gridSpans(dur).slice(0, 5).forEach((r) => {
        const b = el("button", null, `${r.g}f`);
        b.title = tailOnly
          ? `承接末尾 ${r.g} 帧（${fmtSecs(r.sp)}）`
          : `${r.g} 帧（${fmtSecs(r.sp)}）—— 拖动轨道可滑动窗口`;
        b.onclick = (e) => {
          e.stopPropagation();
          slot.start = (tailOnly || untouched())
            ? Math.max(0, dur - r.sp)
            : Math.min(slot.start, Math.max(0, dur - r.sp));
          slot.end = Math.min(dur, slot.start + r.sp);
          paint(); seekPreview(slot.start); commit();
        };
        quick.append(b);
      });
      const bEnd = el("button", null, "\u203A 末尾");
      bEnd.title = "把窗口移到片段末尾，长度不变";
      bEnd.onclick = (e) => {
        e.stopPropagation();
        const len = slot.end - slot.start;
        slot.end = dur;
        slot.start = Math.max(0, dur - len);
        paint(); seekPreview(slot.start); commit();
      };
      if (!tailOnly) quick.append(bEnd);   // a tail window is always at the end
      wrap.append(quick);
    }
    return wrap;
  }

  function mediaSlot(slot, kind, caption, token, usedSeconds, opts) {
    opts = opts || {};
    const card = el("div", "gcastL-media" + (slot.file ? " filled" : "")
                    + (opts.cont ? " cont" : ""));
    const cap = el("div", "gcastL-cap");
    if (opts.cont) {
      /* An arrow entering a box: this is where the clip comes IN from, not a
         reference standing beside it. */
      const ico = el("span", "gcastL-ico");
      ico.innerHTML = '<svg viewBox="0 0 24 24" width="11" height="11" '
        + 'fill="currentColor" aria-hidden="true">'
        + '<path d="M13 3h7a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1h-7v-2h6V5h-6V3z"/>'
        + '<path d="M11 7l5 5-5 5v-3H3v-4h8V7z"/></svg>';
      cap.append(ico);
    }
    cap.append(el("span", "n", caption));
    if (slot.file && token) cap.append(el("span", null, token));
    if (opts.cont) {
      /* The step this removes: render, hunt the file down in the output folder,
         drag it onto the slot. The server does the copy on disk instead. */
      const bLast = el("button", "gcastL-last", "引用最新渲染");
      bLast.title = "从输出目录取用最新渲染的视频";
      bLast.addEventListener("pointerenter", () => primeLastRenderTip(bLast));
      bLast.onclick = (e) => { e.stopPropagation(); adoptLastRender(slot, card, bLast); };
      if (slot.chroma === CHROMA_WARN) bLast.classList.add("warn");
      cap.append(el("div", "spacer"), bLast);
    }
    if (slot.file) {
      const x = el("button", "gcastL-x", "×");
      x.title = "清除槽位";
      x.onclick = (e) => { e.stopPropagation(); clearSlot(slot); render(); commit(); };
      cap.append(x);
    }

    let body, media = null;
    if (kind === "video") {
      body = el("div", "gcastL-thumb");
      if (slot.file) {
        const v = mediaFor(slot, "video", slot.file);
        media = v;
        v.playsInline = true;
        if (v.paused) v.muted = true;   // a reused element mid-playback keeps its sound
        v.loop = false;   // looping wraps to frame 0 and sails past the out point
        // silent hover preview, but only while the transport is not in use
        v.onmouseenter = () => { if (v.muted) v.play().catch(() => {}); };
        v.onmouseleave = () => { if (v.muted) { v.pause(); v.currentTime = slot.start || 0; } };
        body.append(v);
      } else body.append(el("div", "gcastL-empty", "+"));
    } else {
      if (slot.file) {
        media = mediaFor(slot, "audio", slot.file);
        media.style.display = "none";
        card.append(media);
        body = null;      // the waveform carries the filename instead
      } else {
        body = el("div", "gcastL-wav", "+  音频");
      }
    }

    card.append(cap);
    if (body) card.append(body);
    if (slot.file && slot.dur) {
      const label = (kind === "audio") ? slot.file.split("/").pop() : null;
      card.append(trim(slot, usedSeconds, kind === "video", media, label,
                       !!opts.tailOnly));
    }
    if (slot.file && kind === "video") {
      const lab = el("label", "gcastL-chk");
      const cb = el("input"); cb.type = "checkbox"; cb.checked = !!slot.audio;
      cb.onchange = () => { slot.audio = cb.checked; render(); commit(); };
      lab.append(cb, el("span", null, "同时把其音轨作为音频参考"));
      card.append(lab);
    }

    /* Levelling the carried frames onto their own last frame, before they are
     * encoded. Measured on his renders: the model continues from the window's
     * AVERAGE exposure, not its final frame, so a window ending darker than
     * its average produced a brighter clip and vice versa. Off by default -
     * with a true tail window the drift measured near zero, so this is for the
     * case where it does not. */
    if (slot.file && opts.cont) {
      const lab2 = el("label", "gcastL-chk");
      const cb2 = el("input"); cb2.type = "checkbox"; cb2.checked = !!slot.flatten;
      cb2.onchange = () => { slot.flatten = cb2.checked; render(); commit(); };
      lab2.append(cb2, el("span", null, "曝光对齐到末帧"));
      lab2.title = "仅在续接片段比它接续的那段明显更亮或更暗时启用";
      card.append(lab2);
    }

    wireDrop(body || card, slot, kind, kind === "video" ? ACCEPT_VIDEO : ACCEPT_AUDIO, token);
    return card;
  }

  /* 潜空间续写：抓 output/h3_context/ 里最新的一个续拍存档（相对路径）。
     与「引用最新渲染」同一交互规则——抓的是点击那一刻的最新文件。
     顺手抓最新渲染视频做预览：存档和视频来自同一次运行，预览只是给人看的
     画面，传输仍走潜空间存档文件；视频抓不到不影响引用本身。 */
  async function adoptLastLatent() {
    const r = await api.fetchApi("/banzhang/h3mc/latest_latent_legacy", { method: "POST" });
    if (r.status !== 200) throw new Error(`查询最新续拍存档失败 (${r.status})`);
    const j = await r.json();
    if (!j || !j.found) return null;
    let preview = null;
    try {
      const v = await api.fetchApi("/cglide/recent_outputs?limit=1");
      if (v.status === 200) {
        const list = await v.json();
        if (Array.isArray(list) && list.length) preview = list[0];
      }
    } catch (e) { /* 预览缺席不影响引用 */ }
    return { path: String(j.path), preview };
  }

  /* 预览对象 → 相对 output 的视频路径。潜空间档把它兼作「源视频」输出，
     供「Glide 续接合成」拼长片——潜空间档用独立的 cont.latent_video 字段，
     与文件档的 cont.file（input 拷贝）分开，切档互不污染。 */
  const latentVideoPath = (p) => (p && p.name)
    ? ((p.subfolder ? p.subfolder + "/" : "") + p.name) : "";

  /* 把最新存档写进续写槽位：存档路径 + 预览 + 源视频一起刷新。
     「引用上次片段」按钮与工程连续渲染共用这一份，改字段只改这里。 */
  function applyLatentAdoption(c, got) {
    if (!got) return false;
    c.latent_file = got.path;
    /* 预览用的成片顺手兼作「源视频」输出：潜空间档的续写算术不读它，
       后端把它从「源视频」端口吐出去供拼接。 */
    if (got.preview && got.preview.name) {
      c.latent_preview = got.preview;
      c.latent_video = latentVideoPath(got.preview);
    } else { delete c.latent_preview; delete c.latent_video; }
    return true;
  }

  /* ----------------------------------------------------------- render */

  function render() {
    try { renderInner(); }
    catch (e) { console.error("[H3 Studio] render failed:", e); }
  }

  function renderInner() {
    root.dataset.mode = st.mode;
    btnFL.setAttribute("aria-pressed", String(st.mode === "fl2va"));
    btnRef.setAttribute("aria-pressed", String(st.mode === "ref2va"));
    need.innerHTML = st.mode === "fl2va"
      ? '请加载 <b>minimax_h3_fl2va</b> 开头的模型权重'
      : '请加载 <b>minimax_h3_ref2va</b> 开头的模型权重';
    /* 多参考模式下首/末帧卡片是隐藏的，但槽位里可能还留着上一次的图——后端
       一个字都不读。不点出来，用户就以为它还在约束画面。 */
    if (st.mode !== "fl2va" && (st.slots.first.file || st.slots.last.file)) {
      const warn = el("span", "gcastL-warn", "⚠ 首/末帧已填但当前模式不生效");
      warn.style.marginLeft = "8px";
      warn.title = "首帧 / 末帧只在「首/尾帧」模式下参与生成。"
                 + "要让它生效请切到「首/尾帧」模式（并加载 fl2va 权重）。";
      need.append(warn);
    }

    const fam = st.ratio === "custom"
      ? null
      : (RATIOS.find((r) => r.label === st.ratio) || findRatio(st.width, st.height));
    selRatio.value = fam ? fam.label : "custom";
    if (fam) {
      const options = fam.sizes.map((z, i) => ({
        label: `${z.w} x ${z.h}`,
        value: `${z.w}x${z.h}`,
        note: z.stage || (i === 0 ? "native" : (z.w * z.h <= 384 * 640 ? "draft" : "")),
      }));
      /* A linked manual edit keeps the ratio but lands off the preset ladder;
       * surface that size in the dropdown instead of leaving the label blank. */
      const curKey = `${st.width}x${st.height}`;
      if (!options.some((o) => o.value === curKey)) {
        options.push({ label: `${st.width} x ${st.height}`, value: curKey, note: "自定义" });
      }
      selSize.setOptions(options);
      selSize.value = curKey;
      selSize.disabled = false;
    } else {
      selSize.setOptions([{ label: "自定义尺寸", value: "custom" }]);
      selSize.value = "custom";
      selSize.disabled = true;
    }
    inW.value = st.width; inH.value = st.height;
    const mp = (st.width * st.height / 1e6).toFixed(2);
    canvasNote.innerHTML = `<b>${mp} MP</b> · ${(st.width / st.height).toFixed(3)}:1`
      + (st.width * st.height > MAX_PIXELS
         ? ` · <span class="gcastL-warn" title="H3 的原生画布面积上限为 768×1344 = ${(MAX_PIXELS / 1e6).toFixed(2)} MP（短边 768 的原生画布）。当前 ${mp} MP 已超出，模型会按比例降采样后再生成，输出仍是 ${st.width}×${st.height}，等于先缩小再放大，细节会掉。">超出 H3 原生面积</span>`
         : "");

    const frames = alignFrames(st.length);
    selLen.value = LENGTH_PRESETS.includes(frames) ? String(frames) : "custom";
    inLen.value = secsOfFrames(frames);          // 整数秒（精确值见下方读出）
    delete inLen.dataset.dirty;                  // 本次回显不算「用户编辑过」
    lenNote.innerHTML = `<b>${frames} 帧</b> · ${fmtSecs(frames / FPS)}（24 fps）`;

    const canvasLong = Math.max(st.width, st.height);
    renderRefControl(chkRef, inRef, refNote, st.ref_image_size, canvasLong, REF_IMAGE_MAX);
    inScale.value = st.ref_scale_hd;
    /* 倍数 >1 时把「重编码后的有效长边」补进读出位——这才是二采三采真正拿到
       的参考清晰度，只看左侧档位会以为没变。与后端 _ref_target_long 同口径
       （match → 画布长边 × 倍数）。 */
    if (st.ref_scale_hd > 1) {
      const base = st.ref_image_size === "match" ? canvasLong : +st.ref_image_size;
      refNote.innerHTML += ` · <b>放大 ${Math.round(base * st.ref_scale_hd)}px</b>`;
    }
    renderRefControl(chkVRef, inVRef, vrefNote, st.ref_video_size, canvasLong, REF_VIDEO_MAX);
    fpsRef.value = st.ref_video_fps;
    /* 数值已显示在输入框里，读出位不再回显"21 fps"这类重复——只保留状态提示；
       单位语义由行首的"抽帧帧率"四字承担。 */
    fpsNote.innerHTML = st.ref_video_fps >= REF_FPS_MAX
      ? `<b>不抽帧</b>`
      : `<b>省显存</b>`;

    /* 宽度按本轮回显的实际字数统一刷新：input 事件只在用户敲键时触发，
       预设下拉改长度、吸附回显、加载工程都会绕过它，窄框下长值就又被截断。 */
    for (const inp of [inW, inH, inLen, inRef, inScale, inVRef, fpsRef]) autoWidth(inp);


    const isFL = st.mode === "fl2va";
    /* 提示词常驻在流内并吃掉节点剩余高度（gcastL-promptfill）：节点拖高多少，
       编辑区就大多少。展开/收起机制已删除，两种模式同一套布局。 */
    pWrap.classList.add("gcastL-promptfill");
    /* 外接提示词：编辑器转只读镜像——DOM 里放的就是最终文本（外部值），
     * 这样 edText() / 高亮 / 检查 / 自动补全全部基于最终文本自动工作。 */
    const pw = promptWired();
    extBadge.style.display = pw ? "" : "none";
    ta.setAttribute("contenteditable", pw ? "false" : "plaintext-only");
    ta.classList.toggle("gcastL-ro", pw);
    if (pw) {
      const ext = effPrompt();
      if (edText() !== ext) setEditorText(ext, edText().length);
    }
    /* Clear any inline height left behind by the old resize grip - a workflow
     * saved while the textarea had been dragged would otherwise stay pinned
     * tall forever, since an inline height beats the flex fill. */
    if (ta.style.height) ta.style.height = "";
    ta.style.minHeight = (isFL ? PROMPT_H_FL : PROMPT_H_REF) + "px";
    root.style.minHeight = "";
    flWrap.style.display = isFL ? "" : "none";
    contWrap.style.display = isFL ? "none" : "";
    fRef.style.opacity = isFL ? "0.35" : "1";
    fRef.style.pointerEvents = isFL ? "none" : "";
    fVRef.style.opacity = isFL ? "0.35" : "1";
    fVRef.style.pointerEvents = isFL ? "none" : "";

    const { rows, tags } = presentation(st);

    flGrid.replaceChildren();
    if (isFL) {
      [["first", "首帧", "@first"], ["last", "末帧", "@last"]].forEach(([key, cap, tok]) => {
        const slot = st.slots[key];
        const card = imageSlot(slot, cap, tok);
        wireDrop(card, slot, "image", ACCEPT_IMAGE, tok);
        flGrid.append(card);
      });
    }

    const usedSeconds = frames / FPS;
    contWrap.replaceChildren();

    /* A freshly dropped clip arrives as its full range, which is never what a
     * continuation wants. Snap it to the last 22 frames - the tested window -
     * or to the largest grid run the clip can actually supply. */
    const c = st.cont;
    if (c.mode !== "latent" && c.file && c.dur && (c.start || 0) <= 0.001 && (c.end || 0) >= c.dur - 0.001) {
      const spans = gridSpans(c.dur);
      const pick = spans.find((r) => r.g === 22) || spans[spans.length - 1];
      if (pick) { c.end = c.dur; c.start = Math.max(0, c.dur - pick.sp); }
    }
    /* 续写档位：文件 = 磁盘视频（解码→重编码，原路径）；潜空间 = 上一片段的
       采样潜空间（接导演台 context_latent 端口，Motion Context 算术，真续声、
       无钉帧损耗）。缺省文件档，老工程不受影响。 */
    const isLatent = c.mode === "latent";
    /* 续写是否真的会生效：文件档要有源片，潜空间档要引用过存档。只切了档位没
       选东西不算——那只是「还没配」，说它生效会误导。 */
    const contActive = isLatent ? !!c.latent_file : !!c.file;
    let contCard = null;
    const contModeRow = el("div", "gcastL-bar");
    const bFile = el("button", "gcastL-btn cont" + (isLatent ? " ghost" : ""), "文件续写");
    const bLatent = el("button", "gcastL-btn cont" + (isLatent ? "" : " ghost"), "潜空间续写");
    bFile.title = "选一段磁盘上的视频作为续写来源（原路径，每接一次有一次重编码损耗）";
    bLatent.title = "用上一片段的采样潜空间续写：画面位对位无损、声音真正接上。"
                  + "自动承接最新一段「H3 续拍存档」（存档节点编号保持 0 即可），"
                  + "分辨率必须与本画布一致。";
    bFile.onclick = () => { if (c.mode === "latent") { delete c.mode; render(); commit(); } };
    /* 切档只切档位，不自动引用——上一片段的画面由「引用上次片段」按钮手动
       取用（与文件档的「引用最新渲染」同一交互）。 */
    bLatent.onclick = () => {
      if (c.mode !== "latent") { c.mode = "latent"; render(); commit(); }
    };
    contModeRow.append(bFile, bLatent);
    if (isLatent) {
      const framesSel = el("select", "gcastL-btn cont");
      framesSel.title = "续写画面窗口帧数（潜空间整步值）。声音固定钉尾部约 1 秒";
      for (const v of [5, 22, 39, 56, 73, 90, 107, 124]) {
        const o = el("option"); o.value = String(v); o.textContent = v + " 帧";
        framesSel.append(o);
      }
      framesSel.value = String(+c.frames || 22);
      if (!framesSel.value || framesSel.selectedIndex < 0) framesSel.value = "22";
      framesSel.onchange = () => { c.frames = +framesSel.value; commit(); };
      contModeRow.append(framesSel);
    }
    /* No section of its own: it joins the row that is already on screen, so the
     * node stays exactly as tall as it was. Both modes get it - continuing is
     * orthogonal to first/last vs omni. */
    if (isLatent) {
      contCard = el("div", "gcastL-media cont filled");
      const cap = el("div", "gcastL-cap");
      /* 与文件档同款结构：箭头图标 + 标题 + 右侧「引用上次片段」与「×」，
         样式与悬停提示也复用同一套（gcastL-last / gcastL-x / primeLastRenderTip）。 */
      const ico = el("span", "gcastL-ico");
      ico.innerHTML = '<svg viewBox="0 0 24 24" width="11" height="11" '
        + 'fill="currentColor" aria-hidden="true">'
        + '<path d="M13 3h7a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1h-7v-2h6V5h-6V3z"/>'
        + '<path d="M11 7l5 5-5 5v-3H3v-4h8V7z"/></svg>';
      cap.append(ico);
      cap.append(el("span", "n", "续写来源（潜空间）"));
      const bAdopt = el("button", "gcastL-last", "引用上次片段");
      bAdopt.title = "取用最新一段「H3 续拍存档」：本段才续写上一段，"
                   + "预览与拼长片的源片一并就位";
      bAdopt.addEventListener("pointerenter", () => primeLastRenderTip(bAdopt));
      bAdopt.onclick = async (e) => {
        e.stopPropagation();
        bAdopt.disabled = true;
        try {
          if (applyLatentAdoption(c, await adoptLastLatent())) { render(); commit(); }
          else { bAdopt.disabled = false; }
        } catch (err) {
          console.error("[H3 Studio] 引用上次片段失败:", err);
          bAdopt.disabled = false;
        }
      };
      cap.append(el("div", "spacer"), bAdopt);
      if (c.latent_file) {
        const x = el("button", "gcastL-x", "×");
        x.title = "清除引用：本段改为不续写（按第一段处理），档位保持潜空间";
        x.onclick = (e) => {
          e.stopPropagation();
          delete c.latent_file; delete c.latent_preview; delete c.latent_video;
          render(); commit();
        };
        cap.append(x);
      }
      contCard.append(cap);
      /* 预览：上一片段的成片画面（同一次运行的视频输出，仅展示用——
         真正参与续写的始终是潜空间存档文件）。静音，悬停播放。 */
      if (c.latent_preview && c.latent_preview.name) {
        const pv = el("video");
        pv.src = api.apiURL(`/view?filename=${encodeURIComponent(c.latent_preview.name)}`
          + `&subfolder=${encodeURIComponent(c.latent_preview.subfolder || "")}`
          + `&type=${encodeURIComponent(c.latent_preview.type || "output")}`);
        pv.muted = true; pv.loop = true; pv.playsInline = true; pv.preload = "metadata";
        pv.style.width = "100%"; pv.style.display = "block"; pv.style.background = "#000";
        pv.onmouseenter = () => pv.play().catch(() => {});
        pv.onmouseleave = () => pv.pause();
        contCard.append(pv);
      }
      const note = el("div", "gcastL-empty");
      note.style.whiteSpace = "normal";
      note.style.padding = "6px 10px";
      note.style.lineHeight = "1.4";
      note.style.fontSize = "11px";
      note.style.opacity = "0.75";
      note.textContent = c.latent_file
        ? ("上一片段：" + c.latent_file.split("/").pop())
        : "还没引用存档——本段按第一段处理。要续写：点「引用上次片段」。";
      contCard.append(note);
      if (isFL) { flGrid.className = "gcastL-grid fl3"; contCard.prepend(contModeRow); flGrid.append(contCard); }
      else { contCard.prepend(contModeRow); contWrap.append(contCard); }
    } else {
      contCard = mediaSlot(c, "video", "续写来源", null, usedSeconds,
                           { tailOnly: true, cont: true });
      if (isFL) { flGrid.className = "gcastL-grid fl3"; contCard.prepend(contModeRow); flGrid.append(contCard); }
      else { contCard.prepend(contModeRow); contWrap.append(contCard); }
    }
    /* 首尾帧 + 续写同时生效时，必须把「开头归谁」写在卡片上：后端已把首帧锚
       自动后移到接缝处（两个锚抢帧 0 会互相抵消，潜空间档更会被整块丢弃）。
       不写出来，用户只会看到首帧图「摆着却没用上」，找不出原因。 */
    if (isFL && contCard && contActive) {
      const hint = el("div", "gcastL-empty");
      hint.style.whiteSpace = "normal";
      hint.style.padding = "6px 10px";
      hint.style.lineHeight = "1.4";
      hint.style.fontSize = "11px";
      hint.style.opacity = "0.75";
      hint.textContent = "续写钉住开头 —— 首帧锚已自动后移到接缝处。"
                       + "要让首帧就是整段第一帧，请先清除续写来源。";
      contCard.append(hint);
    }
    /* 档位按钮行放进续写卡内部（此前是 contWrap 里的独立网格行）：作为独立行时
       它与续写卡之间隔着 grid 的 7px gap，视觉上按钮悬在卡片上方一大截空白里。
       放进卡片后紧贴内容区顶部，与「续写来源」标题同属一张卡。 */

    renderTags();
    renderCheck();
    paintPresetName();
  }

  function renderCheck() {
    const eff = effPrompt();
    const rows = promptCheck(eff, alignFrames(st.length) / FPS);
    speech.replaceChildren();

    let flagged = 0;
    rows.forEach((r) => {
      if (r.state === "warn") flagged++;
      const item = el("div", "row");
      item.innerHTML = `<b>${r.label}</b> <span class="${r.state === "warn" ? "gcastL-warn" : "gcastL-ok"}">${r.text}</span>`;
      speech.append(item);
    });

    /* 空槽位的音频引用是「不换算、原样留着」，外面看不出它压根没送出去。尖括号
       写法能活到这一层，说明它那一格还没素材——把原文直接报出来。 */
    const orphans = eff.match(AUDIO_TAG) || [];
    if (orphans.length) {
      flagged++;
      speech.append(el("div", "row gcastL-warn",
        `· ${orphans.join(" ")} 未生效：对应音频槽位空着，原文没送进模型。`
        + "填好素材后重新点一下本面板、再离开输入框即可换算成 @音频N"));
    }

    if (flagged) {
      speech.append(el("div", "row gcastL-warn",
        "· 提示词没写明的部分，H3 会自行编造配音/声音——想精确控制就去写全音景和闭嘴指示"));
    }
    renderShotBar();
    if (typeof paintTimeline === "function") paintTimeline();
  }

  /* Colours cycle and mean nothing but "next shot" -- deliberately away from
   * the accent (weight family) and violet (project), which do mean something. */
  const SHOT_COLOURS = ["#4f8cd6", "#4fae8b", "#c9a24a", "#57a0b8", "#d08f6a", "#9a72c9"];

  /* Rewrite one marker's timestamp in the prompt. The whole point of the drag
   * is that it edits the text you will actually send - a timeline that only
   * moved a picture around would be decoration. */
  function writeShotTime(mark, seconds) {
    /* 外接提示词时时间戳属于外部文本，写不回去——分镜条仅作展示 */
    if (promptWired()) return;
    const stamp = `At ${mmss(Math.max(0, seconds))}`;
    const p = st.prompt || "";
    const caret = edCaret().s;
    let out, delta, at;
    if (mark.tsFrom != null) {
      out = p.slice(0, mark.tsFrom) + stamp + p.slice(mark.tsTo);
      delta = stamp.length - (mark.tsTo - mark.tsFrom);
      at = mark.tsFrom;
    } else {
      const ins = ` ${stamp},`;
      out = p.slice(0, mark.afterBracket) + ins + p.slice(mark.afterBracket);
      delta = ins.length;
      at = mark.afterBracket;
    }
    st.prompt = out;
    const pos = caret > at ? Math.max(0, caret + delta) : caret;
    setEditorText(out, pos);
    renderTags(); commit(); renderCheck();
  }

  /* The opening words of a shot, for the label inside its segment. Trimmed of
   * the comma and spaces left over from the timestamp; CSS does the actual
   * truncation, so a wide segment shows more than a narrow one. */
  function shotBlurb(prompt, s) {
    let body = String(prompt || "").slice(s.bodyFrom, s.bodyTo == null ? undefined : s.bodyTo);
    body = body.replace(/^[\s,;:.\-]+/, "").replace(/\s+/g, " ").trim();
    return body;
  }

  /* Colour bar in the prompt's left margin, matching the timeline segment.
   *
   * A textarea cannot style a range of its own text, so the vertical extent of
   * each [Shot N] block is measured in a hidden MIRROR div that copies the
   * textarea's font, width, padding and wrapping. A zero-width span dropped at
   * each marker index reports the line it landed on; that is where the bar
   * starts. The gutter then only has to scroll with the textarea. */
  let mirror = null;
  const MIRROR_PROPS = ["fontFamily", "fontSize", "fontWeight", "fontStyle", "fontVariant",
    "letterSpacing", "lineHeight", "textTransform", "wordSpacing", "textIndent",
    "whiteSpace", "wordBreak", "overflowWrap", "tabSize"];

  function shotTops(marks) {
    if (!mirror) { mirror = el("div", "gcastL-mirror"); document.body.append(mirror); }
    const cs = getComputedStyle(ta);
    MIRROR_PROPS.forEach((k) => { mirror.style[k] = cs[k]; });

    /* Padding is NOT copied. Copying it made every measured position depend on
     * the mirror reproducing the textarea's box exactly, and any mismatch
     * showed up as a constant shift of every bar. Instead the mirror is pure
     * content - zero padding, content-box, the textarea's inner width - and
     * the padding is added back explicitly, once, below. */
    const padL = parseFloat(cs.paddingLeft) || 0;
    const padR = parseFloat(cs.paddingRight) || 0;
    const padT = parseFloat(cs.paddingTop) || 0;
    mirror.style.padding = "0";
    mirror.style.boxSizing = "content-box";
    mirror.style.width = Math.max(10, ta.clientWidth - padL - padR) + "px";

    const text = effPrompt();
    mirror.replaceChildren();
    const spans = [];
    let pos = 0;
    for (const m of marks) {
      if (m.idx == null || m.idx < pos) continue;
      mirror.append(document.createTextNode(text.slice(pos, m.idx)));
      const sp = document.createElement("span");
      sp.textContent = "\u200b";
      mirror.append(sp);
      spans.push(sp);
      pos = m.idx;
    }
    mirror.append(document.createTextNode(text.slice(pos) + "\n"));
    const tops = spans.map((sp) => sp.offsetTop + padT);
    return { tops, height: mirror.scrollHeight + padT };
  }

  let lastGutter = null;
  let gutterState = null;   // { tops, height, lineHeight, colours } from the last measure
  const SCROLL_DRIVEN = typeof CSS !== "undefined" && !!CSS.supports
    && CSS.supports("animation-timeline: --x")
    && CSS.supports("scroll-timeline-name: --x");

  function syncGutter() {
    if (lastGutter) renderGutter(lastGutter.marks, lastGutter.colour);
  }

  /* Place the bars for the current scroll offset.
   *
   * Every bar is CLAMPED in script to the visible band rather than left to
   * overflow:hidden. Relying on the clip meant a bar could be drawn far above
   * the box and show up over the timeline if anything about the containing
   * block was not what I assumed. Clamping cannot do that: nothing outside
   * 0..clientHeight is ever written. */
  /* A dot per shot rather than a bar spanning it.
   *
   * A full-height bar has to be right at BOTH ends, so every reflow, rewrite
   * and scroll was another chance to be a few pixels out - and being out is
   * obvious when an edge is meant to line up with a paragraph. A dot only has
   * to sit beside the right line, which the same measurement gives easily. */
  function paintGutterBars() {
    if (!gutterState) return;
    const view = ta.clientHeight;
    const lh = gutterState.lineHeight || 18;
    gutterInner.replaceChildren();

    if (SCROLL_DRIVEN) {
      /* Dots sit at CONTENT coordinates and the whole layer is slid by the
       * scroll timeline, so nothing has to be recomputed while scrolling. */
      gutterInner.classList.add("sdriven");
      const span = Math.max(0, ta.scrollHeight - view);
      gutterInner.style.setProperty("--gcastL-scroll-max", (-span) + "px");
      gutterState.tops.forEach((top, i) => {
        const dot = el("div", "dot");
        dot.style.top = (top + lh / 2 - 3) + "px";
        dot.style.background = gutterState.colours[i];
        gutterInner.append(dot);
      });
      return;
    }

    const off = ta.scrollTop;
    gutterState.tops.forEach((top, i) => {
      const y = top - off + lh / 2;               // centre of the marker's line
      if (y < 4 || y > view - 4) return;          // scrolled out
      const dot = el("div", "dot");
      dot.style.top = (y - 3) + "px";
      dot.style.background = gutterState.colours[i];
      gutterInner.append(dot);
    });
  }

  function renderGutter(marks, colourFor, deferred) {
    lastGutter = { marks, colour: colourFor };
    /* Expand re-flows the textarea a frame later, so a paint taken now would
     * measure a zero-height box and the bars would vanish. Wait for a real
     * size instead of drawing into nothing. */
    if (!ta.clientHeight) { requestAnimationFrame(syncGutter); return; }

    const cs = getComputedStyle(ta);
    gutter.style.top = (ta.offsetTop + parseFloat(cs.borderTopWidth || 0)) + "px";
    gutter.style.left = (ta.offsetLeft + parseFloat(cs.borderLeftWidth || 0) + 6) + "px";
    gutter.style.height = ta.clientHeight + "px";

    const lineHeight = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.5 || 18;
    if (!marks.length) {
      gutterState = { tops: [0], height: ta.scrollHeight, lineHeight, colours: [colourFor(0)] };
    } else {
      const { tops, height } = shotTops(marks);
      gutterState = { tops, height, lineHeight, colours: tops.map((_, i) => colourFor(i)) };
    }
    paintGutterBars();
    /* One re-measure a frame later, never more: the first pass can land before
     * the textarea has re-wrapped after a text change. */
    if (!deferred) {
      requestAnimationFrame(() => {
        if (lastGutter) renderGutter(lastGutter.marks, lastGutter.colour, true);
      });
    }
  }

  function renderShotBar() {
    const total = Math.max(0.001, (alignFrames(st.length) - 1) / FPS);
    const shots = parseShots(effPrompt(), total);
    shotbar.replaceChildren();

    /* A thin ruler over the band. Without it the coloured strip reads as a
     * progress bar or a palette; one row of ticks and it is obviously time.
     * Minor ticks every second, a longer one with a label every five. */
    const ruler = el("div", "ruler");
    (() => {
      const minor = total > 30 ? 5 : 1;
      const major = total > 30 ? 15 : 5;
      for (let t = 0; t <= total + 1e-6; t += minor) {
        const x = (t / total) * 100;
        if (x > 100) break;
        const isMaj = Math.abs(t / major - Math.round(t / major)) < 1e-6;
        const tick = el("div", "t" + (isMaj ? " maj" : ""));
        tick.style.left = `${x}%`;
        tick.style.height = isMaj ? "6px" : "3px";
        ruler.append(tick);
        /* skip a label that would hang off the right edge */
        if (isMaj && x < 88) {
          const lb = el("div", "lbl", `${Math.round(t)}s`);
          lb.style.left = `${x}%`;
          ruler.append(lb);
        }
      }
    })();
    shotbar.append(ruler);

    const band = el("div", "band");
    const notes = [];

    if (!shots.length) {
      /* No markers is not an error -- one continuous shot is his default.
       * The band then just reads as the clip's length. */
      const seg = el("div", "seg");
      seg.style.flex = "1 1 0%";
      seg.style.background = SHOT_COLOURS[0] + "94";
      seg.title = `一镜到底 \u00b7 ${fmtSecs(total)}`;
      const only = (fieldText(effPrompt(), "detailed_description")
                 || String(effPrompt())).replace(/\s+/g, " ").trim();
      if (only) seg.append(el("span", "lab", only));
      band.append(seg);
      renderGutter([], () => SHOT_COLOURS[0] + "94");
    } else {
      /* Segments are laid out from a live copy of the times so a boundary drag
       * can relayout without touching the prompt on every pointermove. The
       * text is rewritten once, on release. */
      const live = shots.filter((s) => !s.untimed && !s.past);
      shots.forEach((s) => {
        if (s.untimed) notes.push({ warn: true, text: `分镜 ${s.n} 无时间标记 \u2014 无法定位` });
        else if (s.past) notes.push({ warn: true, text: `分镜 ${s.n} 起始于 ${fmtSecs(s.start)}，已超出片段末尾` });
      });

      const times = live.map((s) => s.start);
      const segs = live.map((s, i) => {
        const seg = el("div", "seg" + (s.end > total ? " past" : ""));
        seg.style.background = SHOT_COLOURS[i % SHOT_COLOURS.length] + "b4";
        const blurb = shotBlurb(effPrompt(), s);
        seg.append(el("span", "lab", blurb || `分镜 ${s.n}`));
        band.append(seg);
        return seg;
      });

      const bounds = [];
      const layout = () => {
        segs.forEach((seg, i) => {
          const from = Math.min(times[i], total);
          const to = Math.min(i + 1 < times.length ? times[i + 1] : total, total);
          seg.style.flex = `${Math.max(to - from, 0.02)} 0 0%`;
          const bl = shotBlurb(effPrompt(), live[i]);
          seg.title = `分镜 ${live[i].n} \u00b7 ${fmtSecs(from)} \u2192 ${fmtSecs(to)} (${fmtSecs(to - from)})`
                    + (bl ? `\n${bl.slice(0, 300)}` : "");
        });
        bounds.forEach((h, k) => { h.style.left = `${(times[k + 1] / total) * 100}%`; });
      };

      /* Drag a boundary to move where a shot starts, and the timestamp in the
       * prompt is rewritten to match. Snaps to a tenth of a second, or to the
       * frame with Shift held. Boundaries cannot cross each other. */
      live.slice(1).forEach((s, k) => {
        const h = el("div", "bnd");
        h.title = "拖动可调整该分镜的开始位置";
        band.append(h);
        bounds.push(h);

        const timeAt = (clientX) => {
          const r = band.getBoundingClientRect();
          return Math.min(total, Math.max(0, ((clientX - r.left) / r.width) * total));
        };
        let dragging = false;
        const move = (e) => {
          if (!dragging) return;
          e.preventDefault(); e.stopPropagation();
          const raw = timeAt(e.clientX);
          const t = e.shiftKey ? Math.round(raw * FPS) / FPS : Math.round(raw * 10) / 10;
          const lo = times[k] + 0.2;
          const hi = (k + 2 < times.length ? times[k + 2] : total) - 0.2;
          times[k + 1] = Math.min(Math.max(t, lo), Math.max(lo, hi));
          layout();
        };
        const up = (e) => {
          if (!dragging) return;
          dragging = false;
          h.classList.remove("on");
          document.removeEventListener("pointermove", move, true);
          document.removeEventListener("pointerup", up, true);
          writeShotTime(s, times[k + 1]);
        };
        h.addEventListener("pointerdown", (e) => {
          e.preventDefault(); e.stopPropagation();
          dragging = true;
          h.classList.add("on");
          try { h.setPointerCapture(e.pointerId); } catch (_) {}
          document.addEventListener("pointermove", move, true);
          document.addEventListener("pointerup", up, true);
        });
      });

      layout();
      renderGutter(live, (i) => SHOT_COLOURS[i % SHOT_COLOURS.length] + "b4");

      /* A gap before the first marker is real dead air, and H3 fills silence
       * with invented sound -- so it is worth seeing, not hiding. */
      const first = shots.find((s) => !s.untimed && !s.past);
      if (first && first.start > 0.01) {
        const lead = el("div", "seg");
        lead.style.flex = `${first.start} 0 0%`;
        lead.style.background = "#ffffff14";
        lead.title = `${fmtSecs(first.start)} 前无分镜标记`;
        band.prepend(lead);
        notes.push({ warn: false, text: `距首分镜 ${fmtSecs(first.start)}` });
      }
      const timed = shots.filter((s) => !s.untimed && !s.past);
      const last = timed[timed.length - 1];
      if (last && last.end > total + 0.01) {
        notes.push({ warn: true, text: `分镜 ${last.n} 超出片段末尾 ${fmtSecs(last.end - total)}` });
      }
    }

    shotbar.append(band);
    if (notes.length) {
      shotbar.append(el("div", "note" + (notes.some((n) => n.warn) ? " warn" : ""),
        notes.map((n) => n.text).join("  \u00b7  ")));
    }
  }

  /* skipHighlight：只重建标签、不重建编辑器。焦点在提示词框里刷新素材时用，
     避免 applyHighlight 的 buildEditor 打断输入与光标。 */
  function renderTags(skipHighlight) {
    /* 全量合并视图做 chips 调色板（点击插入 @标签）；展示条只列按需过滤后
       真正会送模型的素材——与 csglide_cast.py 的 _filter_refs_by_prompt 同规则 */
    const view = mergedSlots();
    const { rows, tags } = presentation(st, view);
    const { rows: sentRows } = presentation(st, filterUsedByPrompt(view, effPrompt()));

    /* Rebuild the chips ONLY when the reference set changes. Typing calls
     * this on every keystroke, and recreating a <video> thumbnail makes it
     * reload -- which is the flicker. promptWired() 进 sig：接线状态切换时
     * onclick（插入/禁用）必须重建。
     * 素材文件名也必须进 sig：媒体架里换位只改变「哪个编号对应哪个文件」，
     * token 与 tag 都原样不变，单看这两项会误判为无变化，缩略图留旧图。 */
    const sig = (promptWired() ? "W|" : "")
      + rows.map((r) => (tokenOf(r) || "") + r.tag + "|" + (fileForToken(tokenOf(r)) || "")
                 + "|" + (aliasLabel(tokenOf(r)) || "")).join("|");
    if (sig !== chipSig) {
      chipSig = sig;
      chipEls.clear();
      chips.replaceChildren();
      rows.forEach((r) => {
        const token = tokenOf(r);
        if (!token) return;
        const b = el("button", "gcastL-chip");
        const slotFile = fileForToken(token);
        /* 有别名就显示别名（素材认得出是谁），规范 token 缩小作为副标。
           点击插入的也是别名——剧本保持可读，展开只发生在发送时。 */
        const alias = aliasLabel(token);
        if (r.kind === "image" && slotFile) {
          const im = el("img"); im.src = viewURL(slotFile); b.append(im);
        } else if (r.kind === "video" && slotFile) {
          const v = el("video");
          v.src = viewURL(slotFile); v.muted = true; v.preload = "metadata"; v.playsInline = true;
          b.append(v);
        } else {
          b.append(el("span", "glyph", "♪"));
        }
        b.append(el("span", "lbl", alias || token));
        if (alias) b.append(el("span", "sub", token));
        b.onmousedown = (e) => e.preventDefault();   // keep the textarea focused so the caret stays put
        /* 外接提示词时编辑器只读，插入无从谈起——芯片仅作展示与状态提示 */
        b.onclick = promptWired() ? null : () => insert(alias || token);
        b.dataset.tag = r.tag;
        chips.append(b);
        chipEls.set(token, b);
      });
      if (!rows.length) chips.append(el("span", "gcastL-read",
        refsWired() ? "参考素材由 H3 媒体架提供" : "参考素材请放入 H3 媒体架节点"));
      /* 参考素材集合变了（加图/删图/对齐重排），提示词里的 @图片N 高亮同样由
         fileForToken 决定，必须一并刷新：有图 → .has 主色，空槽位 → .miss 警示。
         否则「先复制提示词、后加图」时，加完图只有 chips 有了缩略图，提示词里的
         @图片N 仍停留在加图前的 miss 状态，不会实时亮起。
         正在编辑时不能走 applyHighlight（buildEditor 重建会把光标和候选词顶掉），
         但也不能什么都不做——不打字就没有 input 事件，高亮会一直停在旧状态，
         看上去像「标签不识别了」。refreshTokClasses 只改 class，不碰 DOM 结构。 */
      if (!skipHighlight) applyHighlight();
      else refreshTokClasses();
    }
    /* the in-the-prompt state changes as you type, so only that is repainted */
    chipEls.forEach((b, token) => {
      const on = hasToken(token);
      b.classList.toggle("on", on);
      b.title = on
        ? `${token} → ${b.dataset.tag} · in the prompt`
        : `insert ${token} → ${b.dataset.tag}`;
    });

    /* presentation strip：本次真正发送的参考 + 汇总 */
    pres.replaceChildren();
    if (!sentRows.length) {
      pres.append(el("span", "full", "仅提示词（未引用任何 @标签，参考不发送）"));
    } else {
      sentRows.forEach((r) => {
        const item = el("span", "cell");
        const tok = r.token || (r.from === "first frame" ? "@first" : r.from === "last frame" ? "@last" : null);
        const used = hasToken(tok);
        item.innerHTML = `<b>${r.tag.replace(/</g, "&lt;").replace(/>/g, "&gt;")}</b> <span class="arrow">←</span> <span class="src">${r.from}</span>`;
        if (!used) item.classList.add("gcastL-warn");
        pres.append(item);
      });
      if (rows.length > sentRows.length) {
        pres.append(el("span", "full", `· 素材共 ${rows.length} 个，本次发送 ${sentRows.length} 个（未提及的不送）`));
      }
      /* 别名自动展开让「提到几个角色就送几张」极易撞上限（图片侧 <Picture 1>
         ~ <Picture 9>）。这里比对的是「引用了几个」而不是「送出几个」——送出
         的那份已被 filterUsedByPrompt 截断，看不出超没超。 */
      const want = new Set(
        [...effPrompt().matchAll(/@图片(\d+)/g)].map((m) => +m[1])).size;
      if (want > MAX_IMAGES) {
        pres.append(el("span", "full gcastL-warn",
          `· 图片引用 ${want} 个，超出上限 ${MAX_IMAGES}——只保留编号最小的 ${MAX_IMAGES} 个`));
      }
    }
    const orphans = ALL_TOKENS.filter((t) => !tags[t] && hasToken(t) && !(refsWired() && isRefToken(t)));
    if (orphans.length) {
      pres.append(el("span", "full gcastL-warn", `· ${orphans.join(" ")} 指向了空槽位`));
    }
  }

  /* ---- preset files ------------------------------------------------
   *
   * Everything happens in the browser: a .json holds the state and points
   * at media by filename, a .h3pack is a zip with the media inside. The
   * media itself is read back out of ComfyUI through /view and pushed
   * back in through /upload on import, so no server route is needed.
   *
   * Reference images are re-encoded to JPEG inside a pack -- they are
   * heading into a VAE, so the artifacts are irrelevant and the saving is
   * large. First/last KEYFRAMES are deliberately left alone: those are the
   * chunk-continuity frames, and JPEG damage there propagates into every
   * generation built on top of them.
   */

  const JPEG_QUALITY = 0.92;

  let fileHandle = null;      // File System Access handle, when supported
  let fileIsPack = false;
  let fileLabel = "";

  /* -- minimal zip, stored (media is already compressed) -- */
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(buf) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  function zipWrite(entries) {
    const enc = new TextEncoder();
    const parts = [], central = [];
    let offset = 0;

    for (const e of entries) {
      const name = enc.encode(e.name);
      const data = e.data;
      const crc = crc32(data);

      const lh = new DataView(new ArrayBuffer(30));
      lh.setUint32(0, 0x04034b50, true);
      lh.setUint16(4, 20, true);        // version needed
      lh.setUint16(8, 0, true);         // stored
      lh.setUint32(14, crc, true);
      lh.setUint32(18, data.length, true);
      lh.setUint32(22, data.length, true);
      lh.setUint16(26, name.length, true);
      parts.push(new Uint8Array(lh.buffer), name, data);

      const cd = new DataView(new ArrayBuffer(46));
      cd.setUint32(0, 0x02014b50, true);
      cd.setUint16(4, 20, true);
      cd.setUint16(6, 20, true);
      cd.setUint16(10, 0, true);
      cd.setUint32(16, crc, true);
      cd.setUint32(20, data.length, true);
      cd.setUint32(24, data.length, true);
      cd.setUint16(28, name.length, true);
      cd.setUint32(42, offset, true);
      central.push(new Uint8Array(cd.buffer), name);

      offset += 30 + name.length + data.length;
    }

    let cdSize = 0;
    for (const c of central) cdSize += c.length;
    const eo = new DataView(new ArrayBuffer(22));
    eo.setUint32(0, 0x06054b50, true);
    eo.setUint16(8, entries.length, true);
    eo.setUint16(10, entries.length, true);
    eo.setUint32(12, cdSize, true);
    eo.setUint32(16, offset, true);

    return new Blob([...parts, ...central, new Uint8Array(eo.buffer)],
                    { type: "application/zip" });
  }

  async function zipRead(buffer) {
    const dv = new DataView(buffer);
    const bytes = new Uint8Array(buffer);
    let eocd = -1;
    for (let i = dv.byteLength - 22; i >= 0 && i > dv.byteLength - 66000; i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error("不是有效的 zip 文件");

    const count = dv.getUint16(eocd + 10, true);
    let p = dv.getUint32(eocd + 16, true);
    const dec = new TextDecoder();
    const out = new Map();

    for (let i = 0; i < count; i++) {
      const nameLen = dv.getUint16(p + 28, true);
      const extraLen = dv.getUint16(p + 30, true);
      const commentLen = dv.getUint16(p + 32, true);
      const method = dv.getUint16(p + 10, true);
      const compSize = dv.getUint32(p + 20, true);
      const local = dv.getUint32(p + 42, true);
      const name = dec.decode(bytes.subarray(p + 46, p + 46 + nameLen));

      const lNameLen = dv.getUint16(local + 26, true);
      const lExtraLen = dv.getUint16(local + 28, true);
      const start = local + 30 + lNameLen + lExtraLen;
      let data = bytes.subarray(start, start + compSize);

      if (method === 8) {
        const ds = new DecompressionStream("deflate-raw");
        const blob = new Blob([data]).stream().pipeThrough(ds);
        data = new Uint8Array(await new Response(blob).arrayBuffer());
      } else if (method !== 0) {
        throw new Error(`不支持的 zip 压缩方式：${name}`);
      }
      out.set(name, data);
      p += 46 + nameLen + extraLen + commentLen;
    }
    return out;
  }

  /* -- media helpers -- */

  async function toJpeg(blob) {
    try {
      const bmp = await createImageBitmap(blob);
      const c = document.createElement("canvas");
      c.width = bmp.width; c.height = bmp.height;
      c.getContext("2d").drawImage(bmp, 0, 0);
      const out = await new Promise((r) => c.toBlob(r, "image/jpeg", JPEG_QUALITY));
      bmp.close?.();
      return out;
    } catch (e) { return null; }
  }

  const bytesOf = async (blob) => new Uint8Array(await blob.arrayBuffer());

  function busy(text) {
    [bSave, bSaveAs, bPack, bLoad].forEach((b) => { b.disabled = !!text; b.style.opacity = text ? .5 : 1; });
    if (text) nameLabel.innerHTML = `<span class="dirty">${text}</span>`;
    else paintPresetName();
  }

  /* -- build a pack: state plus every referenced file -- */
  /* Collects media into zip entries, rewriting each item's filename to point
   * at the copy inside the pack. The dedup map is passed in rather than owned,
   * so a whole project can share ONE map across every shot: a reference sheet
   * used in ten shots is fetched once and stored once. */
  function makeAssetAdder(entries, seen, used) {
    return async function add(item, keepOriginal) {
      if (!item || !item.file) return;
      const src = item.file;
      if (seen.has(src)) { item.file = seen.get(src); return; }

      let blob;
      try { blob = await (await fetch(viewURL(src))).blob(); }
      catch (e) { console.warn("[H3 Studio] could not read " + src, e); return; }

      let name = src.split("/").pop();
      if (!keepOriginal && /\.(png|jpe?g|webp|bmp)$/i.test(name)) {
        const j = await toJpeg(blob);
        if (j && j.size < blob.size) {
          blob = j;
          name = name.replace(/\.[^.]+$/, "") + ".jpg";
        }
      }
      let unique = name, n = 2;
      while (used.has(unique)) {
        unique = name.replace(/(\.[^.]+)$/, `_${n++}$1`);
      }
      used.add(unique);
      entries.push({ name: "assets/" + unique, data: await bytesOf(blob) });
      seen.set(src, unique);
      item.file = unique;
    };
  }

  async function packSlots(slots, add) {
    if (!slots) return;
    await add(slots.first, true);                 // keyframes stay lossless
    await add(slots.last, true);
    for (const it of slots.images || []) await add(it, false);
    for (const it of slots.videos || []) await add(it, false);
    for (const it of slots.audios || []) await add(it, false);
  }

  async function buildPack() {
    const state = JSON.parse(JSON.stringify(st));
    const entries = [];
    const add = makeAssetAdder(entries, new Map(), new Set());

    await packSlots(state.slots, add);

    const enc = new TextEncoder();
    entries.unshift({ name: "state.json", data: enc.encode(JSON.stringify(state, null, 1)) });
    entries.unshift({ name: "meta.json", data: enc.encode(JSON.stringify({
      app: "H3 Studio", version: 1,
      mode: state.mode, width: state.width, height: state.height,
      length: state.length, saved: new Date().toISOString(),
    }, null, 1)) });

    return zipWrite(entries);
  }

  function plainBlob() {
    return new Blob([JSON.stringify({
      meta: { app: "H3 Studio", version: 1, mode: st.mode, packed: false,
              saved: new Date().toISOString() },
      state: st,
    }, null, 1)], { type: "application/json" });
  }

  const defaultName = (pack) =>
    `${st.mode === "fl2va" ? "h3-fl" : "h3-ref"}-${st.width}x${st.height}` +
    (pack ? ".h3pack" : ".h3.json");

  /* -- OS dialogs, with a download fallback where the API is missing -- */

  async function writeOut(blob, suggested, pack) {
    if (window.showSaveFilePicker) {
      try {
        const handle = await window.showSaveFilePicker({
          suggestedName: suggested,
          types: [pack
            ? { description: "H3 Studio pack", accept: { "application/zip": [".h3pack"] } }
            : { description: "H3 Studio preset", accept: { "application/json": [".json"] } }],
        });
        const w = await handle.createWritable();
        await w.write(blob);
        await w.close();
        fileHandle = handle; fileIsPack = pack; fileLabel = handle.name;
        return true;
      } catch (e) {
        if (e && e.name === "AbortError") return false;
        console.warn("[H3 Studio] save picker failed, downloading instead", e);
      }
    }
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = suggested;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    fileHandle = null; fileIsPack = pack; fileLabel = suggested;
    return true;
  }

  async function saveAs(pack) {
    busy(pack ? "打包中…" : "保存中…");
    try {
      const blob = pack ? await buildPack() : plainBlob();
      await writeOut(blob, defaultName(pack), pack);
    } catch (e) {
      alert("H3 Studio：保存失败 —— " + e);
    } finally { busy(null); }
  }

  async function saveOver() {
    if (!fileHandle) return saveAs(fileIsPack);
    busy(fileIsPack ? "打包中…" : "保存中…");
    try {
      const blob = fileIsPack ? await buildPack() : plainBlob();
      const w = await fileHandle.createWritable();
      await w.write(blob);
      await w.close();
    } catch (e) {
      alert("H3 Studio：保存失败 —— " + e);
    } finally { busy(null); }
  }

  async function pickFileForOpen() {
    if (window.showOpenFilePicker) {
      try {
        const [h] = await window.showOpenFilePicker({
          types: [{ description: "H3 Studio preset or pack",
                    accept: { "application/json": [".json"], "application/zip": [".h3pack", ".h3projpack", ".zip"] } }],
        });
        const f = await h.getFile();
        return { file: f, handle: h };
      } catch (e) {
        if (e && e.name === "AbortError") return null;
      }
    }
    const f = await pickFile(".json,.h3pack,.h3projpack,.zip");
    return f ? { file: f, handle: null } : null;
  }

  /* Read a .h3.json or .h3pack into a plain state object. Split out of
   * doLoad so importing a saved shot into a project takes the identical
   * path, pack media restore included. */
  async function stateFromFile(file) {
    const isPack = /\.(h3pack|zip)$/i.test(file.name);
    if (!isPack) {
      const parsed = JSON.parse(await file.text());
      /* 工程文件是 {meta, name, idx, shots}——顶层没有 state，下面的白名单会
       * 把每个字段静默重置为默认值。认出它并指到该去的按钮，而不是假装载入成功。 */
      if (Array.isArray(parsed.shots)) {
        throw new Error("这是工程文件（含多个分段），请到「工程」面板里用「打开…」载入它");
      }
      return { state: parsed.state || parsed, isPack: false };
    }
    const map = await zipRead(await file.arrayBuffer());
    /* 打包工程存的是 project.json 不是 state.json。少了这条，下面的报错会让人
     * 以为文件坏了，实际只是按钮用错了。 */
    if (map.has("project.json")) {
      throw new Error("这是打包的工程文件，请到「工程」面板里用「打开…」载入它");
    }
    const raw = map.get("state.json");
    if (!raw) throw new Error("打包文件缺少 state.json");
    const state = JSON.parse(new TextDecoder().decode(raw));

    /* push the bundled media back into ComfyUI's input folder so the
     * Python side can find it, then repoint the state at the uploads */
    const remap = new Map();
    for (const [name, data] of map) {
      if (!name.startsWith("assets/")) continue;
      const base = name.slice(7);
      const blob = new Blob([data]);
      try {
        remap.set(base, await uploadFile(new File([blob], base)));
      } catch (e) {
        console.warn("[H3 Studio] could not restore " + base, e);
      }
    }
    const fix = (item) => {
      if (item && item.file && remap.has(item.file)) item.file = remap.get(item.file);
    };
    const sl = state.slots || {};
    fix(sl.first); fix(sl.last);
    (sl.images || []).forEach(fix);
    (sl.videos || []).forEach(fix);
    (sl.audios || []).forEach(fix);
    return { state, isPack: true };
  }

  /* Same dialog, several files at once - importing a finished film one shot
   * at a time was the tedious part. */
  async function pickFilesForOpen() {
    if (window.showOpenFilePicker) {
      try {
        const hs = await window.showOpenFilePicker({
          multiple: true,
          types: [{ description: "H3 Studio preset or pack",
                    accept: { "application/json": [".json"], "application/zip": [".h3pack", ".h3projpack", ".zip"] } }],
        });
        const out = [];
        for (const h of hs) out.push(await h.getFile());
        return out;
      } catch (e) {
        if (e && e.name === "AbortError") return [];
      }
    }
    return (await pickFile(".json,.h3pack,.h3projpack,.zip", true)) || [];
  }

  async function doLoad() {
    const picked = await pickFileForOpen();
    if (!picked) return;
    const { file, handle } = picked;
    busy("载入中…");
    try {
      const { state, isPack } = await stateFromFile(file);
      load(JSON.stringify(state));
      fileHandle = handle; fileIsPack = isPack; fileLabel = file.name;
      commit();
    } catch (e) {
      alert("H3 Studio：载入失败 —— " + ((e && e.message) ? e.message : e));
    } finally { busy(null); }
  }

  function paintPresetName() {
    const isFl = st.mode === "fl2va";
    const badge = `<span class="gcastL-badge ${isFl ? "fl" : "ref"}">${isFl ? "FL" : "REF"}</span>`;
    /* Save / Save as / Save packed always write THIS SHOT, never the project.
     * With a project open that is easy to forget, so the bar names the shot
     * those buttons would write. */
    const p = (node.properties && node.properties.gcastL_project) || null;
    const shot = (p && Array.isArray(p.shots) && p.idx >= 0 && p.shots[p.idx])
      ? `<span class="shot">分段 ${p.idx + 1}/${p.shots.length}</span>` : "";
    nameLabel.innerHTML = (fileLabel
      ? `${badge} ${fileLabel}`
      : `${badge} <span class="dirty">未保存</span>`) + (shot ? " " + shot : "");
  }

  /* ---- shots: several shots in one project --------------------------
   *
   * A film is a list of shots that mostly share their references, so a file
   * per shot loses the relationship and repeats the work. A project holds
   * the shot states together.
   *
   * The single-shot Save / Save as / Save packed / Load buttons are NOT
   * touched: every existing .h3.json and .h3pack keeps loading exactly as
   * before, and a project is a separate file with its own two buttons.
   *
   * Shots live in node.properties, which LiteGraph serialises with the
   * workflow. A project therefore survives a browser reload without ever
   * being written to disk -- the file is for moving it somewhere else, not
   * for not losing it.
   *
   * Media is referenced by filename, as in .h3.json. There is no packed
   * project yet: the files have to still be in ComfyUI's input folder.
   */

  const clone = (o) => JSON.parse(JSON.stringify(o));
  const uid = () => Math.random().toString(36).slice(2, 9);
  let projHandle = null;
  let projLabel = "";
  let shotsOpen = false;
  let shotsFocus = -1;

  function proj() {
    node.properties = node.properties || {};
    const p = node.properties.gcastL_project;
    if (!p || !Array.isArray(p.shots)) {
      node.properties.gcastL_project = { name: "", shots: [], idx: -1 };
    }
    return node.properties.gcastL_project;
  }

  /* ---- previous state: the .bak, kept in the workflow ----------------
   *
   * There is exactly ONE copy of a project, in node.properties. New, Open,
   * Import and Delete each rewrite that copy, and the file on disk is only
   * as recent as the last time Save was pressed. So before anything that
   * rewrites the list, the current one is put aside in a second property
   * and the panel's Revert button comes alive.
   *
   * Kept in properties rather than written next to the project file on
   * purpose: a file handle can only rewrite the file it points at, so a
   * sibling .bak needs a DIRECTORY handle - and where the File System
   * Access API is missing there is no dialog at all and saves land in the
   * downloads folder. Properties work everywhere and survive a reload.
   *
   * ONE level deep: this is a .bak, not an undo stack. A backup of a
   * backup is not worth the workflow bytes.
   *
   * Deliberately NOT taken on the autosave that fires when you switch
   * clip. That runs constantly while browsing, so the stored state would
   * almost always be "the same project, one clip ago" - useless as a
   * safety net, and it would flush out a snapshot worth having.
   */
  function projSnapshot() {
    const p = node.properties && node.properties.gcastL_project;
    if (!p || !Array.isArray(p.shots) || !p.shots.length) return null;
    return { name: p.name || "", idx: p.idx, shots: clone(p.shots) };
  }

  function snapProject(why) {
    const snap = projSnapshot();
    if (!snap) return;                     // an empty project has nothing to lose
    node.properties.gcastL_project_prev = {
      why: why || "", at: Date.now(),
      name: snap.name, idx: snap.idx, shots: snap.shots,
    };
  }

  function prevProject() {
    const b = node.properties && node.properties.gcastL_project_prev;
    return (b && Array.isArray(b.shots) && b.shots.length) ? b : null;
  }

  function agoText(ms) {
    const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
    if (s < 60) return "a moment ago";
    const m = Math.round(s / 60);
    if (m < 60) return m + " min ago";
    const h = Math.round(m / 60);
    return h < 24 ? h + " h ago" : Math.round(h / 24) + " d ago";
  }

  function prevWhen(b) {
    return agoText(b.at) + (b.why ? " (" + b.why + ")" : "");
  }

  /* Revert SWAPS the two, so a mis-click on Revert is itself revertible. */
  function revertProject() {
    const b = prevProject();
    if (!b) return;
    const n = b.shots.length;
    if (!confirm(
          `回退到 ${prevWhen(b)} 时的工程？\n\n` +
          `共 ${n} 个分段。当前工程会被保留为「上一次状态」，`
          + `因此再点「还原」又能把它带回来。`)) return;
    stash();
    const now = projSnapshot();
    node.properties.gcastL_project = { name: b.name || "", idx: b.idx, shots: clone(b.shots) };
    if (now) {
      node.properties.gcastL_project_prev = {
        why: "before Revert", at: Date.now(),
        name: now.name, idx: now.idx, shots: now.shots,
      };
    } else {
      delete node.properties.gcastL_project_prev;
    }
    const p = proj();
    p.idx = p.shots.length ? Math.min(Math.max(0, +p.idx || 0), p.shots.length - 1) : -1;
    if (p.idx >= 0) {
      restoreShotRack(p.shots[p.idx]);
      load(JSON.stringify(p.shots[p.idx].state));
    }
    commit(); paintShotsBtn(); paintPresetName(); renderShots();
    paintTimeline();
  }

  /* 媒体架的分段快照。素材住在「H3 媒体架」节点里，现在跟着分段一起记：
   * 每段存一份当时的完整架况（槽位引用 + 裁剪窗 + 别名 + 帧率 + 音频输出
   * 编号），切换、打开、渲染时倒回，各段互不串台。只记引用不复制文件——
   * 要连文件一起走请用「打包」。没接媒体架时返回 null、字段不写：那是
   * 「当时没有媒体架」，不是「媒体架空着」。 */
  function rackSnapshot() {
    if (!rackNodeOf(node)) return null;
    try {
      const d = JSON.parse(rackSlotsOf(node).raw || "{}");
      return (d && typeof d === "object") ? d : null;
    } catch (_) { return null; }
  }

  /* 把分段存的快照倒回媒体架。没有快照就一动不动——老工程、建段时没接
   * 媒体架的分段都没有这个字段，绝不能拿空快照把用户现在摆好的素材清掉。 */
  function restoreShotRack(shot) {
    const rn = rackNodeOf(node);
    if (!rn || !rn.gmr || !shot || !shot.rack || typeof shot.rack !== "object") return;
    rn.gmr.load(shot.rack);
    rn.gmr.commit();
  }

  /* Autosave. The shot being left is written back before anything else
   * happens, so browsing the list can never cost an edit. */
  function stash() {
    const p = proj();
    if (p.idx >= 0 && p.shots[p.idx]) {
      p.shots[p.idx].state = clone(st);
      /* 媒体架跟段走：接了就记当前架况，没接就清掉字段（与 projectBlob 同口径） */
      const snap = rackSnapshot();
      if (snap) p.shots[p.idx].rack = snap;
      else delete p.shots[p.idx].rack;
    }
  }

  /* Vocabulary, kept straight on purpose: a CLIP is one generation, and a clip
   * can contain several SHOTS - the [Shot N] markers the model cuts on. The
   * project list talks about clips; the timeline strip talks about shots.
   * Internals and the file format still say "shots" so old projects load. */
  const shotLabel = (s, i) => s.name || `分段 ${i + 1}`;

  function shotThumb(state) {
    const sl = (state && state.slots) || {};
    const cand = [sl.first, sl.last].concat(sl.images || [], sl.videos || []);
    const hit = cand.find((x) => x && x.file);
    return hit ? hit.file : null;
  }

  function paintShotsBtn() {
    const p = proj();
    bShots.textContent = p.shots.length
      ? `工程 ${p.idx >= 0 ? p.idx + 1 : "-"}/${p.shots.length}`
      : "工程";
  }

  /* A new shot in a film usually reuses the same cast and location, so it
   * starts from the current one. The prompt does not carry over -- except
   * subject_definitions, which describes the references that just came with
   * it and would only be retyped. */
  function inheritedState() {
    const s = clone(st);
    const subs = fieldText(effPrompt(), "subject_definitions");
    s.prompt = subs ? `subject_definitions:\n${subs}\n\n` : "";
    return s;
  }

  /* The first Add turns what is on screen into Shot 1 rather than losing it. */
  function seedFromScreen(p) {
    if (p.shots.length === 0 && p.idx < 0) {
      const s = clone(st);
      normalizeNewShotCont(s);
      const shot = { id: uid(), name: "", state: s };
      const snap = rackSnapshot();
      if (snap) shot.rack = snap;
      p.shots.push(shot);
      p.idx = 0;
    }
  }

  /* 新分段默认潜空间续写（工程链路的常规档位）；继承了明确文件来源的
   * （用户手动引用过的文件窗口）保持文件档不动。只用于新建分段，
   * 载入老工程不走这里——老工程没有续写信息时仍按文件档，行为逐帧不变。 */
  function normalizeNewShotCont(s) {
    if (!(s.cont && s.cont.file)) {
      s.cont = Object.assign({}, s.cont, { mode: "latent" });
    }
  }

  function addShot(blank) {
    const p = proj();
    stash();
    seedFromScreen(p);
    const s = blank ? blankState() : inheritedState();
    normalizeNewShotCont(s);
    const shot = { id: uid(), name: "", state: s };
    /* 新分段继承当前媒体架（与"继承班底"同一逻辑：班底跟着段走） */
    const snap = rackSnapshot();
    if (snap) shot.rack = snap;
    p.shots.push(shot);
    p.idx = p.shots.length - 1;
    load(JSON.stringify(s));
    commit(); paintShotsBtn(); paintPresetName(); renderShots();
    paintTimeline();
  }

  /* ======================================================== Render all
   * Queue every clip in the project in order. In "continue" mode each render
   * is adopted into the next clip's CONTINUE FROM slot, so the graph's own
   * Glide Join stitches as it goes and the LAST render is the finished piece
   * -- there is no separate assembly pass to build.
   *
   * The loop drives the panel rather than the graph: it switches clips, fills
   * the slot, commits, queues, waits. Everything it does is something you
   * could do by hand, which is what makes it safe to interrupt.
   */
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const VIDEO_OUT_RE = /\.(mkv|mp4|m4v|mov|webm|avi|mpg|mpeg|ts|m2ts|wmv|flv|ogv)$/i;
  let run = null;                 /* null when idle; the run's own state when not */
  let runBox = null;              /* the overlay, so it can be torn down */

  async function queueOnce() {
    const p = await app.graphToPrompt();
    const res = await api.queuePrompt(0, p);
    const id = res && (res.prompt_id || res.promptId);
    if (!id) throw new Error("服务端未返回任务 ID");
    return id;
  }

  /* Polling rather than socket events: it survives a dropped websocket, a tab
     that was backgrounded, and every frontend version. A render is a minute or
     more, so a second between checks costs nothing. */
  async function waitForPrompt(id) {
    for (;;) {
      if (run && run.cancel) throw new Error("已取消");
      await sleep(1200);
      let entry = null;
      try {
        const r = await api.fetchApi(`/history/${id}`);
        if (r.status === 200) {
          const h = await r.json();
          entry = h && h[id];
        }
      } catch (e) { /* server busy or restarting: try again */ }
      if (!entry) continue;
      const s = entry.status || {};
      if (s.status_str === "error") throw new Error("渲染失败，请查看控制台");
      if (s.completed || s.status_str === "success") return entry;
    }
  }

  /* Glide Video reports ONE entry per render: the browser-playable proxy, as
     type "temp", with the real file named in a "master" field beside it. So the
     master never appears as a filename anywhere in the history, and picking
     "the newest video" can only ever find the proxy. Read master when it is
     offered; fall back to filename for anything else that writes video. */
  const PREVIEW_RE = /(^|[._-])preview\.[^.]+$/i;

  function videoFromHistory(entry) {
    const outs = (entry && entry.outputs) || {};
    let best = null;
    let proxy = null;
    for (const nodeId of Object.keys(outs)) {
      const bag = outs[nodeId] || {};
      for (const key of Object.keys(bag)) {
        const arr = bag[key];
        if (!Array.isArray(arr)) continue;
        for (const item of arr) {
          if (!item) continue;
          /* The master sits in output/ even when the proxy it came with is a
             temp file, so the type of the entry does not describe it. */
          if (typeof item.master === "string" && VIDEO_OUT_RE.test(item.master)) {
            best = { name: item.master, subfolder: item.subfolder || "", type: "output" };
            continue;
          }
          if (typeof item.filename !== "string") continue;
          if (!VIDEO_OUT_RE.test(item.filename)) continue;
          const hit = {
            name: item.filename,
            subfolder: item.subfolder || "",
            type: item.type || "output",
          };
          if (PREVIEW_RE.test(item.filename)) proxy = hit; else best = hit;
        }
      }
    }
    if (!best && proxy) {
      /* Only a proxy was produced. Better than stopping, but say so - the
         guide will be subsampled and the join will pay for it. */
      console.warn("[H3 Studio] Render all: only a preview proxy was found for "
                 + "this render, chaining from it");
      return proxy;
    }
    return best;
  }

  function paintRun() {
    if (!run) {
      if (runBox) { runBox.remove(); runBox = null; }
      root.classList.remove("running");
      paintShotsBtn();
      return;
    }
    if (!runBox) {
      runBox = el("div", "gcastL-run");
      const card = el("div", "card");
      card.append(el("div", "ttl", "正在渲染工程"));
      card.append(el("div", "msg"));
      card.append(el("div", "sub"));
      const cancel = el("button", "gcastL-btn ghost", "停止");
      cancel.title = "先把正在渲染的分段完成，然后停止。已完成的分段会保留。";
      cancel.onclick = (e) => {
        e.stopPropagation();
        if (run) { run.cancel = true; paintRun(); }
      };
      card.append(cancel);
      runBox.append(card);
      root.append(runBox);
      root.classList.add("running");
    }
    const p = proj();
    const name = p.shots[run.i] ? shotLabel(p.shots[run.i], run.i) : `分段 ${run.i + 1}`;
    runBox.querySelector(".msg").textContent =
      run.cancel ? `正在收尾 ${name}…` : `${name} —— ${run.k + 1} / ${run.total}`;
    runBox.querySelector(".sub").textContent =
      run.note || (run.mode === "continue" ? "经「续写来源」串联" : "各分段独立渲染")
      + (run.skipped ? `，已跳过 ${run.skipped} 段` : "");
    bShots.textContent = `渲染中 ${run.k + 1}/${run.total}`;
  }

  async function renderAll(mode, scope) {
    if (run) return;
    const p = proj();
    if (!p.shots.length) {
      alert("H3 Studio：本工程还没有任何分段。");
      return;
    }
    scope = scope || "all";

    /* Free undo: the project as it stands goes into the same slot New and Open
       use, so Revert in the project panel brings it back. */
    snapProject("before Render all");
    stash();
    const startIdx = p.idx >= 0 ? p.idx : 0;

    /* Which clips the scope covers, minus skipped ones. "clip" is an explicit
       ask, so it renders even a skipped clip. */
    const range = scopeRange(scope, p.idx >= 0 ? p.idx : 0);
    const queue = scope === "clip" ? range.slice() : range.filter((i) => !p.shots[i].off);
    if (!queue.length) {
      alert("H3 Studio：该范围内的分段全部被跳过。");
      return;
    }
    const skipped = range.length - queue.length;

    run = { cancel: false, i: queue[0], k: 0, total: queue.length, mode, scope,
            skipped, note: "", made: [] };
    paintRun();
    /* 立刻重画分段列表：把建段/删段/换工程这类按钮在运行期间置灰 */
    renderShots();

    let previous = null;
    let stopped = false;
    try {
      for (let k = 0; k < queue.length; k++) {
        const i = queue[k];
        run.i = i; run.k = k; run.note = ""; paintRun();
        switchTo(i);
        const linked = !(i > 0 && p.shots[i].link === false);

        if (linked && i > 0 && mode === "continue") {
          if (st.cont.mode === "latent") {
            /* 潜空间续写：承接上一分段的采样存档（「续拍存档」每个分段
               跑完都会自动落一个新文件，抓最新的就是上一分段的）。 */
            run.note = "正在引用上一分段的续拍存档\u2026"; paintRun();
            const got = await adoptLastLatent();
            if (!got) {
              throw new Error("没找到续拍存档 — 工作流里是否接了「H3 续拍存档」"
                            + "（采样输出 → 存档，编号 0）？\n\n"
                            + "也可以把该分段的续写档位切回「文件续写」，"
                            + "用上一段的成片当源片。");
            }
            st.cont.latent_file = got.path;
            /* 源片优先用上一分段这次渲染的成片（连续渲染里两者必然同源），
               抓不到才退回「最新输出」。 */
            applyLatentAdoption(st.cont,
              { path: got.path, preview: previous || got.preview });
          } else {
            if (!previous) throw new Error("前序片段未产出视频，无法续写");
            run.note = "正在截取前序渲染的尾部\u2026"; paintRun();
            await adoptInto(st.cont, previous);
          }
          render(); commit(); stash();
        }

        /* 排队前自检：缺素材就拦在前端，报清是哪段缺哪个标签、怎么补 */
        run.note = "检查引用素材…"; paintRun();
        const miss = missingRefs();
        if (miss.length) {
          throw new Error(
            `提示词引用的 ${miss.join("、")} 没有对应素材（面板槽位与媒体架均为空）。\n\n`
            + `媒体架现在按分段记忆：切到本分段，把素材放回媒体架即可，它会随该分段自动保存。`);
        }

        run.note = "已入队，等待渲染\u2026"; paintRun();
        const id = await queueOnce();
        const entry = await waitForPrompt(id);
        const out = videoFromHistory(entry);
        if (!out) {
          throw new Error("该次渲染未产出视频文件 \u2014 工作流里是否连接了 Glide Video（或其他视频输出）？");
        }
        previous = out;
        run.made.push(out.name);
        console.log(`[H3 Studio] Render all: clip ${i + 1}/${p.shots.length} \u2192 ${out.name}`);

        if (run.cancel) { stopped = true; break; }
      }
    } catch (err) {
      stopped = true;
      if (String(err && err.message) === "cancelled") {
        console.log("[H3 Studio] Render all: stopped");
      } else {
        console.error("[H3 Studio] Render all stopped:", err);
        /* Clips already finished stay finished, and the project holds the
           slots the run filled, so it can be picked up from where it stopped. */
        alert(`H3 Studio —— 渲染在第 ${run.i + 1} 个分段处中断：\n\n`
              + `${err && err.message ? err.message : err}\n\n`
              + `已完成 ${run.made.length} 个分段并保留。`);
      }
    } finally {
      const made = run ? run.made.slice() : [];
      run = null;
      paintRun();
      /* Back to the clip the run started from, so the panel is where it was */
      if (p.shots[startIdx]) switchTo(startIdx);
      renderShots();
      paintTimeline();
      if (!stopped && made.length) {
        console.log(`[H3 Studio] Render all: done, ${made.length} clip(s), `
                  + `final file ${made[made.length - 1]}`);
      }
    }
  }

  /* Which clips a scope covers, in project order. */
  function scopeRange(scope, a) {
    const p = proj();
    const n = p.shots.length;
    if (!n) return [];
    a = Math.min(Math.max(0, a | 0), n - 1);
    let s = 0, e = n - 1;
    if (scope === "clip") { s = a; e = a; }
    else if (scope === "from") { s = a; }
    const out = [];
    for (let i = s; i <= e; i++) out.push(i);
    return out;
  }

  function switchTo(i) {
    const p = proj();
    if (i === p.idx || !p.shots[i]) return;
    stash();
    p.idx = i;
    /* 先倒回该段的媒体架快照，再加载面板：load 里 setEditorText(effPrompt())
     * 要拿 effPrompt() 的高亮/preview，而它靠 mergedSlots() 读媒体架——顺序
     * 反了就会用上一段的旧架况算高亮，出现"媒体架还原了但提示词不引用、无
     * 预览图"。 */
    restoreShotRack(p.shots[i]);
    load(JSON.stringify(p.shots[i].state));
    commit(); paintShotsBtn(); paintPresetName(); shotsFocus = i; renderShots();
    paintTimeline();
  }

  function delShot(i) {
    const p = proj();
    const s = p.shots[i];
    if (!s) return;
    /* 不再弹确认窗：删错可以按工程面板的「还原」撤回，删前已留快照。 */
    snapProject("删除前 " + shotLabel(s, i));
    console.log(`[H3 Studio] 删除分段「${shotLabel(s, i)}」—— 误删可用工程面板「还原」撤回`);
    p.shots.splice(i, 1);
    if (!p.shots.length) p.idx = -1;
    else if (p.idx > i) p.idx--;
    else if (p.idx === i) {
      p.idx = Math.min(i, p.shots.length - 1);
      restoreShotRack(p.shots[p.idx]);
      load(JSON.stringify(p.shots[p.idx].state));
    }
    commit(); paintShotsBtn(); paintPresetName(); renderShots();
    paintTimeline();
  }

  function moveShot(i, d) {
    const p = proj();
    const j = i + d;
    if (j < 0 || j >= p.shots.length) return;
    const [it] = p.shots.splice(i, 1);
    p.shots.splice(j, 0, it);
    if (p.idx === i) p.idx = j;
    else if (p.idx === j) p.idx = i;
    shotsFocus = j;
    commit(); paintShotsBtn(); paintPresetName(); renderShots();
    paintTimeline();
  }

  /* One place that flips the skip flag, reachable from the timeline dot,
   * the timeline Alt-click, and the project list dot. */
  function toggleSkip(i) {
    const p = proj();
    const sh = p.shots[i];
    if (!sh) return;
    sh.off = !sh.off;
    commit(); renderShots(); paintTimeline();
  }

  /* The link flag (sh.link === false means "break the chain") marks a seam as
   * NOT continuing from the previous clip. In continue mode, renderAll only
   * adopts the previous render into clips whose link is not explicitly false,
   * so the timeline lets you break one seam while the rest of the film stays
   * chained. */
  function toggleLink(i) {
    if (run) return;
    const p = proj();
    const sh = p.shots[i];
    if (!sh || i < 1) return;
    if (sh.link === false) delete sh.link;
    else sh.link = false;
    commit(); renderShots(); paintTimeline();
  }

  async function importShot() {
    const files = await pickFilesForOpen();
    if (!files.length) return;
    busy(files.length > 1 ? `正在导入 ${files.length}…` : "导入中…");
    const failed = [];
    try {
      const p = proj();
      stash();
      snapProject("before Import");
      seedFromScreen(p);
      /* name order, so a folder of shot-01 … shot-12 lands in film order */
      files.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
      for (const f of files) {
        try {
          const { state } = await stateFromFile(f);
          p.shots.push({
            id: uid(),
            name: f.name.replace(/\.(h3\.json|h3pack|json|zip)$/i, ""),
            state: parseInitial(JSON.stringify(state)),
          });
        } catch (e) {
          console.warn("[H3 Studio] could not import " + f.name, e);
          failed.push(f.name);
        }
      }
      p.idx = p.shots.length - 1;
      restoreShotRack(p.shots[p.idx]);
      load(JSON.stringify(p.shots[p.idx].state));
      commit(); paintShotsBtn(); paintPresetName(); shotsFocus = p.idx; renderShots();
      if (failed.length) alert("H3 Studio：导入失败 —— " + failed.join(", "));
    } catch (e) {
      alert("H3 Studio：导入失败 —— " + e);
    } finally { busy(null); }
  }

  function projectBlob() {
    const p = proj();
    const out = {
      meta: { app: "H3 Studio project", version: 1, saved: new Date().toISOString() },
      name: p.name || "", idx: p.idx, shots: p.shots,
    };
    /* 媒体架快照（工程级）。素材住在「H3 媒体架」节点里，不进工程文件，所以在这里记
     * 一份当时每个槽位引用的文件名（含裁剪窗口、音轨开关、别名），打开工程
     * 时倒回媒体架就能还原。只记引用、不复制文件——文件得仍在 ComfyUI 的
     * input 目录里；要连文件一起走请用「打包」。
     * 每段自己的架况已随分段存在 shots[i].rack 里（见 stash/rackSnapshot），
     * 打开工程时优先用它；这里的工程级快照保留给旧版本脚本读写，两代互开不丢架。
     * 没接媒体架时整个字段不写：那是「当时没有媒体架」，不是「媒体架空着」。
     * 记成空快照会在打开工程时把用户后来摆好的素材清掉。 */
    if (rackNodeOf(node)) out.rack = { slots: rackSlotsOf(node).slots };
    return new Blob([JSON.stringify(out, null, 1)], { type: "application/json" });
  }

  async function saveProject(asNew) {
    const p = proj();
    stash();
    if (!p.shots.length) { alert("H3 Studio：本工程还没有任何分段。"); return; }
    if (asNew) projHandle = null;
    busy("保存工程中…");
    let wrote = false;
    try {
      const blob = projectBlob();
      const stem = (p.name || "h3-project").replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "-") || "h3-project";
      const suggested = stem + ".h3proj.json";
      if (projHandle) {
        const w = await projHandle.createWritable();
        await w.write(blob); await w.close();
        projLabel = projHandle.name;
        wrote = true;
      } else if (window.showSaveFilePicker) {
        try {
          const h = await window.showSaveFilePicker({
            suggestedName: suggested,
            types: [{ description: "H3 Studio project", accept: { "application/json": [".json"] } }],
          });
          const w = await h.createWritable();
          await w.write(blob); await w.close();
          projHandle = h; projLabel = h.name;
          wrote = true;
        } catch (e) { if (!(e && e.name === "AbortError")) throw e; }
      } else {
        /* No File System Access here, so the file lands in the browser's
         * download folder with no dialog at all. Say so - a silent save
         * reads as a save that did not happen. */
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = suggested;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 10000);
        projLabel = suggested;
        wrote = true;
        alert("H3 Studio：当前浏览器没有保存对话框，工程已作为 \u201c"
              + suggested + "\u201d 下载到你的下载文件夹。");
      }
      /* Snapshot AFTER a write that actually happened, never after an
       * abandoned dialog. Revert then means "back to what I last saved",
       * which is the useful reading whenever nothing destructive has
       * happened since - and if something has, that action took its own
       * snapshot and this one is already gone. */
      if (wrote) snapProject("as last saved");
      renderShots();
    } catch (e) {
      alert("H3 Studio：工程保存失败 —— " + e);
    } finally { busy(null); }
  }

  /* Close the project without touching the shot on screen. Clearing the list
   * and wiping the node are different wishes: the usual reason to start a new
   * project is that the shot you are looking at is the first one of it, so it
   * is kept and the next Add makes it Shot 1. "Blank" still gives an empty
   * node when that is what you want. */
  function newProject() {
    const p = proj();
    if (p.shots.length) {
      const n = p.shots.length;
      const ok = confirm(
        `关闭「${p.name || "当前工程"}」及它的 ${n} 个分段？\n\n` +
        "画面上的分段会保留。凡是还没写入到工程文件的改动都会丢失。");
      if (!ok) return;
    }
    /* The list goes, the copy stays: Revert is the way back. */
    snapProject("before New");
    node.properties.gcastL_project = { name: "", shots: [], idx: -1 };
    projHandle = null; projLabel = "";
    commit(); paintShotsBtn(); paintPresetName(); renderShots();
    paintTimeline();
  }

  /* A packed project: one zip, every shot, media inside, dedup shared across
   * shots. The .h3proj.json stays the working file; this is the deliverable.
   * So packing always asks where to put it and never becomes projHandle -
   * otherwise "Save project" would start silently rewriting a huge export. */
  async function packProject() {
    const p = proj();
    stash();
    if (!p.shots.length) { alert("H3 Studio：本工程还没有任何分段。"); return; }
    busy("打包工程中…");
    try {
      const shots = clone(p.shots);
      const entries = [];
      const add = makeAssetAdder(entries, new Map(), new Set());
      for (const s of shots) {
        await packSlots(s.state.slots, add);
        /* 每段媒体架快照引用的素材同样进包，与所有段共用 dedup，不重复存储 */
        if (s.rack && s.rack.slots) await packSlots(s.rack.slots, add);
      }
      /* 媒体架素材也进包：工程文件只记引用，文件不跟着走的话，换台电脑打开
       * 还原出来的就是空壳。与 shots 共用同一个 dedup map，两边都引用的素材
       * 只存一份。必须 clone 后再 add——add 会就地把 item.file 改写成包内文件
       * 名，直接用会污染导演台正在展示的那份缓存。 */
      const rack = rackNodeOf(node) ? { slots: clone(rackSlotsOf(node).slots) } : null;
      if (rack) await packSlots(rack.slots, add);

      const enc = new TextEncoder();
      entries.unshift({ name: "project.json", data: enc.encode(JSON.stringify({
        meta: { app: "H3 Studio project", version: 1, packed: true,
                shots: shots.length, saved: new Date().toISOString() },
        name: p.name || "", idx: p.idx, shots,
        ...(rack ? { rack } : {}),
      }, null, 1)) });

      const stem = (p.name || "h3-project").replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "-") || "h3-project";
      /* Named .h3proj.zip rather than .h3projpack: it IS a zip, and an
       * extension the OS recognises is one less thing to explain to whoever
       * you hand it to. openProject still accepts the old .h3projpack. */
      const suggested = stem + ".h3proj.zip";

      /* The zip writer uses 32-bit offsets and sizes (no ZIP64) and stores
       * entries uncompressed, so the whole archive has to stay under 4 GB.
       * Video reference clips are packed WHOLE - trim points are metadata -
       * so a few masters get there faster than you would think. Better to
       * say so now than to hand someone a silently corrupt file. */
      let total = 0;
      for (const e of entries) total += e.data.length;
      if (total > 3.8e9) {
        const gb = (total / 1e9).toFixed(1);
        alert(`H3 Studio：本工程打包后约 ${gb} GB，已超出打包格式 4 GB 上限。`
            + `请先裁剪或转码参考视频 —— 它们无论裁剪窗口多短都会完整存入。`);
        return;
      }
      const blob = await zipWrite(entries);

      if (window.showSaveFilePicker) {
        try {
          const h = await window.showSaveFilePicker({
            suggestedName: suggested,
            types: [{ description: "H3 Studio project pack",
                      accept: { "application/zip": [".zip", ".h3projpack"] } }],
          });
          const w = await h.createWritable();
          await w.write(blob); await w.close();
        } catch (e) { if (!(e && e.name === "AbortError")) throw e; }
      } else {
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = suggested;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 20000);
        alert("H3 Studio：当前浏览器没有保存对话框，打包结果已作为 \u201c"
              + suggested + "\u201d 下载到你的下载文件夹。");
      }
    } catch (e) {
      alert("H3 Studio：工程打包失败 —— " + e);
    } finally { busy(null); }
  }

  async function openProject() {
    const picked = await pickFileForOpen();
    if (!picked) return;
    busy("载入工程中…");
    try {
      const isPack = /\.(h3projpack|zip)$/i.test(picked.file.name);
      let d, remap = null;

      if (isPack) {
        const map = await zipRead(await picked.file.arrayBuffer());
        const raw = map.get("project.json");
        if (!raw) throw new Error("打包文件缺少 project.json");
        d = JSON.parse(new TextDecoder().decode(raw));
        /* restore each asset once, however many shots point at it */
        remap = new Map();
        for (const [name, data] of map) {
          if (!name.startsWith("assets/")) continue;
          const base = name.slice(7);
          try {
            remap.set(base, await uploadFile(new File([new Blob([data])], base)));
          } catch (e) {
            console.warn("[H3 Studio] could not restore " + base, e);
          }
        }
      } else {
        d = JSON.parse(await picked.file.text());
      }

      if (!d || !Array.isArray(d.shots)) throw new Error("不是有效的 H3 Studio 工程文件");
      const p = proj();
      /* opening replaces whatever is in the list, same as closing it */
      if (p.shots.length && !confirm(
            `用 ${picked.file.name} 替换当前工程（${p.shots.length} 个分段）？`)) return;
      snapProject("before opening " + picked.file.name);
      p.name = typeof d.name === "string" ? d.name : "";
      /* every shot goes through parseInitial, so a project written by an
       * older build cannot smuggle in fields this one does not know.
       * rack 是本版本新增的每段媒体架快照，同样按白名单收下。 */
      p.shots = d.shots.map((s) => ({
        id: (s && s.id) ? String(s.id) : uid(),
        name: (s && typeof s.name === "string") ? s.name : "",
        state: parseInitial(JSON.stringify((s && s.state) || {})),
        rack: (s && s.rack && typeof s.rack === "object" && s.rack.slots) ? s.rack : undefined,
        /* 时间轴字段：跳过 / 链扣 / 颜色随段走，旧工程没有这些字段则取缺省。 */
        off: !!s.off,
        link: s.link === false ? false : undefined,
        colour: (s && typeof s.colour === "string") ? s.colour : undefined,
      }));
      if (remap) {
        const fix = (it) => { if (it && it.file && remap.has(it.file)) it.file = remap.get(it.file); };
        p.shots.forEach((s) => {
          const sl = s.state.slots || {};
          fix(sl.first); fix(sl.last);
          (sl.images || []).forEach(fix);
          (sl.videos || []).forEach(fix);
          (sl.audios || []).forEach(fix);
          /* 每段媒体架快照里存的也是包内文件名，同样要指到上传后的文件 */
          const rk = (s.rack && s.rack.slots) || null;
          if (rk) {
            (rk.images || []).forEach(fix);
            (rk.videos || []).forEach(fix);
            (rk.audios || []).forEach(fix);
          }
        });
        /* 媒体架快照里存的也是包内文件名，同样要指到上传后的文件，否则倒回
         * 媒体架时一个都读不到。 */
        const rk = (d.rack && d.rack.slots) || null;
        if (rk) {
          (rk.images || []).forEach(fix);
          (rk.videos || []).forEach(fix);
          (rk.audios || []).forEach(fix);
        }
      }
      p.idx = p.shots.length ? Math.min(Math.max(0, +d.idx || 0), p.shots.length - 1) : -1;
      /* a pack is an import, not a working file - don't let Save write over it */
      projHandle = isPack ? null : (picked.handle || null);
      projLabel = picked.file.name;
      /* 把工程里记的素材清单倒回媒体架。当前分段有自己的快照就优先用它
       * （每段各归各位）；没有才退回工程级的整体快照（旧版工程的唯一记录）。
       * 两样都没有就一律不动媒体架——否则会把用户现在摆好的素材清掉。
       * 没接媒体架时同样跳过。 */
      const rn = rackNodeOf(node);
      if (rn && rn.gmr) {
        const cur = p.shots[p.idx];
        if (cur && cur.rack) { rn.gmr.load(cur.rack); rn.gmr.commit(); }
        else if (d.rack) { rn.gmr.load(d.rack); rn.gmr.commit(); }
      }
      if (p.idx >= 0) load(JSON.stringify(p.shots[p.idx].state));
      commit(); paintShotsBtn(); paintPresetName(); renderShots();
      paintTimeline();
    } catch (e) {
      alert("H3 Studio：打开工程失败 —— " + e);
    } finally { busy(null); }
  }

  /* ---- the panel ---- */

  const shotsPanel = el("div", "gcastL-shots");
  shotsPanel.style.display = "none";
  document.body.append(shotsPanel);   // outside the node: a popup inside it reflows the layout

  function placeShots() {
    const r = bShots.getBoundingClientRect();
    const w = 336;
    shotsPanel.style.left = Math.max(8, Math.min(window.innerWidth - w - 8, r.right - w)) + "px";
    shotsPanel.style.top = (r.bottom + 6) + "px";
  }

  function outsideShots(e) {
    if (shotsPanel.contains(e.target) || bShots.contains(e.target)) return;
    closeShots();
  }

  function openShots() {
    shotsOpen = true;
    shotsPanel.style.display = "";
    placeShots(); renderShots();
    /* Dismiss on pointerUP, never pointerdown: taking the panel off the page
     * under a press that is still down leaves the v2 canvas mid-drag. */
    setTimeout(() => document.addEventListener("pointerup", outsideShots, true), 0);
  }

  function closeShots() {
    shotsOpen = false;
    shotsPanel.style.display = "none";
    document.removeEventListener("pointerup", outsideShots, true);
  }

  function renderShots() {
    if (!shotsOpen) return;
    const p = proj();
    shotsPanel.dataset.mode = st.mode;

    /* The list is rebuilt on every change, which used to throw the scroll
     * back to the top - so moving a shot down twice meant scrolling down
     * twice. Keep the offset, and pull the row that just moved into view. */
    const prevList = shotsPanel.querySelector(".gcastL-shots-list");
    const prevTop = prevList ? prevList.scrollTop : 0;
    shotsPanel.textContent = "";

    const head = el("div", "gcastL-shots-head");
    head.append(el("div", "gcastL-shots-title", "工程"));
    const nm = el("input");
    nm.type = "text";
    nm.placeholder = "工程名";
    nm.value = p.name || "";
    nm.oninput = () => { p.name = nm.value; commit(); };
    nm.onkeydown = (e) => e.stopPropagation();
    head.append(nm);
    head.append(el("div", "gcastL-shots-file",
      projLabel ? `文件：${projLabel}` : "尚未写入文件 —— 保存在工作流内"));
    shotsPanel.append(head);

    const list = el("div", "gcastL-shots-list");
    if (!p.shots.length) {
      list.append(el("div", "gcastL-shots-empty",
        "还没有分段。\u201c添加分段\u201d会把当前画面留存为「分段 1」，并让「分段 2」从它的参考素材开始。"));
    }
    p.shots.forEach((s, i) => {
      const row = el("div", "gcastL-shot" + (i === p.idx ? " on" : ""));

      const th = el("div", "th");
      const f = shotThumb(s.state);
      if (f) {
        const isVid = /\.(mp4|webm|mov|mkv|m4v|avi)$/i.test(f);
        const m = el(isVid ? "video" : "img");
        m.src = viewURL(f);
        if (isVid) { m.muted = true; m.preload = "metadata"; }
        th.append(m);
      } else th.append(el("span", null, "\u2014"));

      const mid = el("div", "mid");
      const nameEl = el("div", "nm", shotLabel(s, i));
      nameEl.title = "点击重命名";
      nameEl.onclick = (e) => {
        e.stopPropagation();
        const inp = el("input");
        inp.type = "text";
        inp.value = s.name || "";
        inp.placeholder = `分段 ${i + 1}`;
        nameEl.replaceWith(inp);
        inp.focus(); inp.select();
        const done = () => { s.name = inp.value.trim(); commit(); renderShots(); };
        inp.onclick = (ev) => ev.stopPropagation();
        inp.onblur = done;
        inp.onkeydown = (ev) => {
          ev.stopPropagation();
          if (ev.key === "Enter") { ev.preventDefault(); done(); }
          if (ev.key === "Escape") { ev.preventDefault(); renderShots(); }
        };
      };
      const dur = fmtSecs(Math.max(0, ((s.state.length || 5) - 1) / FPS));
      mid.append(nameEl, el("div", "meta",
        `${s.state.mode === "fl2va" ? "首尾" : "多参考"}  ${s.state.width}\u00d7${s.state.height}  ${dur}`));

      const ctl = el("div", "ctl");
      const sk = el("button", "sk", s.off ? "\u25CB" : "\u25CF");
      sk.title = s.off ? "已跳过 —— 渲染会越过此段。点击恢复。" : "参与渲染。点击跳过。";
      sk.onclick = (e) => { e.stopPropagation(); toggleSkip(i); };
      const up = el("button", null, "\u25B2"); up.title = "上移";
      const dn = el("button", null, "\u25BC"); dn.title = "下移";
      const rm = el("button", "rm", "\u00D7"); rm.title = "删除该分段";
      /* 连续渲染运行中禁用：动到分段列表会让运行循环按错的序号渲染。 */
      if (run) { up.disabled = true; dn.disabled = true; rm.disabled = true; sk.disabled = true; }
      up.onclick = (e) => { e.stopPropagation(); moveShot(i, -1); };
      dn.onclick = (e) => { e.stopPropagation(); moveShot(i, 1); };
      rm.onclick = (e) => { e.stopPropagation(); delShot(i); };
      ctl.append(sk, up, dn, rm);
      if (s.off) row.classList.add("off");

      row.append(th, mid, ctl);
      row.onclick = () => switchTo(i);
      if (i === shotsFocus) row.dataset.focus = "1";
      list.append(row);
    });
    shotsPanel.append(list);
    list.scrollTop = prevTop;
    if (shotsFocus >= 0) {
      const target = list.querySelector('[data-focus="1"]');
      if (target) target.scrollIntoView({ block: "nearest" });
      shotsFocus = -1;
    }

    const foot = el("div", "gcastL-shots-foot");
    const bAdd = el("button", "gcastL-btn", "添加分段");
    bAdd.title = run
      ? "连续渲染运行中，无法新增分段"
      : "新增分段，保留当前画布、时长与 subject_definitions 等参考设置";
    const bBlank = el("button", "gcastL-btn ghost", "空白");
    bBlank.title = "新增空白分段";
    const bImport = el("button", "gcastL-btn ghost", "导入…");
    bImport.title = "把一个已保存的 .h3.json 或 .h3pack 作为分段加入本工程";
    /* 连续渲染运行中禁用：动到分段/工程会打乱正在跑的循环。 */
    if (run) { bAdd.disabled = true; bBlank.disabled = true; bImport.disabled = true; }
    const bPRevert = el("button", "gcastL-btn ghost revert", "还原");
    const bPNew = el("button", "gcastL-btn ghost", "新建");
    const bPSave = el("button", "gcastL-btn ghost", "保存工程");
    const bPSaveAs = el("button", "gcastL-btn ghost", "另存为…");
    const bPPack = el("button", "gcastL-btn ghost", "打包…");
    const bPOpen = el("button", "gcastL-btn ghost", "打开…");
    const bak = prevProject();
    /* 运行中整体换工程同样会打乱运行循环，一并禁用。 */
    bPRevert.disabled = !bak || !!run;
    if (run) { bPNew.disabled = true; bPOpen.disabled = true; }
    bPRevert.title = bak
      ? `回退到 ${prevWhen(bak)} 时的工程 —— ` 
        + `${bak.shots.length} 个分段。当前内容会被保留，再点「还原」可恢复。`
      : "暂无内容可回退 —— 在「新建/打开/导入/删除」之前、以及每次保存之后都会留一份副本";
    bPNew.title = "关闭本工程并新建空工程 —— 当前画面会保留";
    bPSave.title = projLabel
      ? "把整个工程覆盖回写 " + projLabel
      : "把整个工程写入一个文件";
    bPSaveAs.title = "把工程写到新文件";
    bPPack.title = "把整个工程导出为一个含全部素材的 .zip —— 共用参考只存一份";
    bPOpen.title = "打开工程文件";
    bAdd.onclick = (e) => { e.stopPropagation(); addShot(false); };
    bBlank.onclick = (e) => { e.stopPropagation(); addShot(true); };
    bImport.onclick = (e) => { e.stopPropagation(); importShot(); };
    bPRevert.onclick = (e) => { e.stopPropagation(); revertProject(); };
    bPNew.onclick = (e) => { e.stopPropagation(); newProject(); };
    bPSave.onclick = (e) => { e.stopPropagation(); saveProject(false); };
    bPSaveAs.onclick = (e) => { e.stopPropagation(); saveProject(true); };
    bPPack.onclick = (e) => { e.stopPropagation(); packProject(); };
    bPOpen.onclick = (e) => { e.stopPropagation(); openProject(); };
    foot.append(bAdd, bBlank, bImport);
    shotsPanel.append(foot);

    /* Shot actions and project actions on separate rows: seven buttons on one
     * wrapping row read as one undifferentiated pile, and "New" sitting next
     * to "Add clip" is exactly the confusion to avoid. */
    const pfoot = el("div", "gcastL-shots-foot proj");
    pfoot.append(el("div", "lbl", "工程"), el("div", "spacer"),
                 bPRevert, bPNew, bPSave, bPSaveAs, bPPack, bPOpen);
    shotsPanel.append(pfoot);

    /* Render all sits on its own row: it is the only control here that starts
       work rather than editing the list, and it should not be a neighbour of
       Delete. */
    const rfoot = el("div", "gcastL-shots-foot run");
    const selMode = el("select", "gcastL-runmode");
    [["continue", "续写 —— 一整段连续镜头"],
     ["separate", "独立 —— 不续写"]].forEach(([v, t]) => {
      const o = el("option", null, t); o.value = v; selMode.append(o);
    });
    selMode.value = node.properties.gcastL_run_mode || "continue";
    selMode.onchange = () => { node.properties.gcastL_run_mode = selMode.value; };
    selMode.onpointerdown = (e) => e.stopPropagation();
    const bRun = el("button", "gcastL-btn run", "全部渲染");
    bRun.disabled = !p.shots.length || !!run;
    bRun.title = p.shots.length
      ? `按顺序排队渲染全部 ${p.shots.length} 个分段。续写模式会把每段渲染喂给下一分段的`
        + "「续写来源」，因此最后得到的文件就是完整成片。"
      : "请先添加一些分段";
    bRun.onclick = (e) => { e.stopPropagation(); closeShots(); renderAll(selMode.value, selScope.value); };
    rfoot.append(el("div", "lbl", "渲染"), el("div", "spacer"), selMode, bRun);
    shotsPanel.append(rfoot);

    /* 渲染范围：整个工程 / 从当前段起 / 仅当前段。与时间轴的「跳过」联动：
       范围越大越尊重跳过标记，「仅当前段」是明确点名，跳过的段也照渲染。 */
    const sfoot = el("div", "gcastL-shots-foot scope");
    const selScope = el("select", "gcastL-runmode");
    [["all", "整个工程"],
     ["from", "从当前段起"],
     ["clip", "仅当前段"]].forEach(([v, t]) => {
      const o = el("option", null, t); o.value = v; selScope.append(o);
    });
    selScope.value = node.properties.gcastL_run_scope || "all";
    selScope.onchange = () => { node.properties.gcastL_run_scope = selScope.value; };
    selScope.onpointerdown = (e) => e.stopPropagation();
    sfoot.append(el("div", "lbl", "范围"), el("div", "spacer"), selScope);
    shotsPanel.append(sfoot);
  }

  bShots.onclick = (e) => {
    e.stopPropagation();
    shotsOpen ? closeShots() : openShots();
  };
  paintShotsBtn();

  /* ================================================ project timeline ==
   *
   * The film across the top of the node. It is a VIEW over the project, not
   * a second copy of it: every block is drawn from p.shots on each paint and
   * every edit goes through the same functions the panel list uses, so the
   * two can never disagree.
   *
   * It is NOT an editor. A clip's length comes off the 17k+5 ladder, so a
   * block cannot be dragged to an arbitrary duration the way a real NLE
   * would suggest - which is exactly the expectation to design against.
   */
  const TL_TICKS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
  const TL_ZOOM_MAX = 40;
  let tlZoom = 1;             // 1 = the whole project fits the node
  let tlPan = 0;              // px scrolled from the left
  let tlPanTo = 0;            // where the wheel wants it; tlPan eases to this
  let tlPanRaf = 0;
  let tlLay = null;           // last layout: { pps, width, view, blocks }
  let tlDragEnd = 0;          // timestamp, so a release does not read as a click
  let tlSig = "";             // what the blocks currently on screen represent

  const tlSecs = (state) =>
    Math.max(0.001, (alignFrames((state && state.length) || 56) - 1) / FPS);

  /* The clip you are editing is read from the LIVE state, not from its saved
   * copy in the project. shots[i].state is only rewritten when you switch
   * away. */
  const tlShotSecs = (sh, i) => tlSecs(i === proj().idx ? st : sh.state);

  /* Colour follows the CLIP, not its position. An explicit sh.colour wins over
   * the hash. Only a value actually in the palette is honoured. */
  function tlColour(sh, i) {
    if (sh && sh.colour && SHOT_COLOURS.indexOf(sh.colour) >= 0) return sh.colour;
    const key = (sh && sh.id) || ("i" + i);
    let h = 0;
    for (let n = 0; n < key.length; n++) h = (h * 31 + key.charCodeAt(n)) >>> 0;
    return SHOT_COLOURS[h % SHOT_COLOURS.length];
  }

  /* The canvas zoom is a CSS transform, so getBoundingClientRect() and
   * clientX come back SCALED while tlPan, block x and block w are all layout
   * pixels. offsetWidth is the unscaled twin of rect.width, so their ratio IS
   * the zoom. */
  function tlScale() {
    const w = tlView.offsetWidth;
    if (!w) return 1;
    const r = tlView.getBoundingClientRect().width / w;
    return r > 0.01 && r < 100 ? r : 1;
  }

  const tlTime = (t) => {
    const m = Math.floor(t / 60), sec = Math.round(t % 60);
    return sec === 60 ? (m + 1) + ":00" : m + ":" + String(sec).padStart(2, "0");
  };

  function tlLayout() {
    const p = proj();
    const view = tlView.clientWidth || 0;
    if (!view) { tlLay = null; return null; }
    /* No project yet: the screen itself is Clip 1. */
    const virtual = !p.shots.length;
    const secs = virtual ? [tlSecs(st)] : p.shots.map(tlShotSecs);
    const total = secs.reduce((a, b) => a + b, 0) || 1;
    const pps = (view / total) * tlZoom;
    let x = 0;
    const blocks = secs.map((sec, i) => {
      const b = { i, x, w: sec * pps, sec };
      x += b.w;
      return b;
    });
    const width = x;
    tlPan = Math.max(0, Math.min(tlPan, Math.max(0, width - view)));
    tlPanTo = Math.max(0, Math.min(tlPanTo, Math.max(0, width - view)));
    tlLay = { pps, width, view, total, blocks, virtual };
    return tlLay;
  }

  function tlSetZoom(z, anchor) {
    const L = tlLay;
    const nz = Math.max(1, Math.min(TL_ZOOM_MAX, z));
    if (!L || Math.abs(nz - tlZoom) < 1e-6) return;
    const t = (tlPan + anchor) / L.pps;
    tlZoom = nz;
    const nl = tlLayout();
    if (nl) tlPanNow(Math.max(0, Math.min(t * nl.pps - anchor,
                                          Math.max(0, nl.width - nl.view))));
    paintTimeline();
    paintTlTools();
  }

  function paintTlTools() {
    tlZoomOut.disabled = tlZoom <= 1.0001;
    tlZoomIn.disabled = tlZoom >= TL_ZOOM_MAX - 1e-6;
    tlFit.disabled = tlZoom <= 1.0001 && tlPan === 0;
    tlDel.disabled = proj().shots.length < 2;
    tlAdd.disabled = !!run;
    tlDel.disabled = tlDel.disabled || !!run;
  }

  tlZoomOut.onclick = (e) => { e.stopPropagation();
    tlSetZoom(tlZoom / 1.6, (tlLay ? tlLay.view : 0) / 2); };
  tlZoomIn.onclick = (e) => { e.stopPropagation();
    tlSetZoom(tlZoom * 1.6, (tlLay ? tlLay.view : 0) / 2); };
  tlFit.onclick = (e) => { e.stopPropagation();
    tlZoom = 1; tlPanNow(0); paintTimeline(); paintTlTools(); };
  tlAdd.onclick = (e) => { e.stopPropagation(); addShot(false); };
  tlDel.onclick = (e) => { e.stopPropagation();
    const p = proj(); if (p.idx >= 0) delShot(p.idx); };

  function tlGlide() {
    tlPanRaf = 0;
    const d = tlPanTo - tlPan;
    if (Math.abs(d) < 0.5) { tlPan = tlPanTo; paintTimeline(); return; }
    tlPan += d * 0.32;
    paintTimeline();
    tlPanRaf = requestAnimationFrame(tlGlide);
  }

  function tlPanNow(v) {
    tlPan = v;
    tlPanTo = v;
    if (tlPanRaf) { cancelAnimationFrame(tlPanRaf); tlPanRaf = 0; }
  }

  function paintTimeline() {
    const p = proj();
    tl.classList.toggle("off", false);

    const L = tlLayout();
    if (!L) return;

    tlStrip.style.left = (-tlPan) + "px";
    paintRule(L);

    if (L.virtual) {
      const vsig = ["V", Math.round(L.pps * 100), Math.round(L.view), Math.round(L.total * 100)].join("/");
      if (vsig === tlSig && tlStrip.children.length) return;
      tlSig = vsig;
      tlStrip.style.width = L.width + "px";
      tlStrip.replaceChildren();
      const b = L.blocks[0];
      const vsh = { id: "", name: "" };
      const d = el("div", "clip on virtual");
      d.style.left = b.x + "px";
      d.style.width = Math.max(3, b.w - 2) + "px";
      const c = tlColour(vsh, 0);
      d.style.setProperty("--c", c);
      d.style.setProperty("--cg", c + "5c");
      d.style.setProperty("--cw", c + "24");
      d.title = `分段 1 \u2014 ${fmtSecs(b.sec)} \u2014 当前画面。点 + 添加第二段并建档。`;
      d.append(el("div", "nm", "分段 1"));
      if (b.w >= 74) d.append(el("div", "du", fmtSecs(b.sec)));
      tlStrip.append(d);
      return;
    }

    const sig = [Math.round(L.pps * 100), Math.round(L.view), p.idx,
                 p.shots.map((sh, i) => (sh.id || i) + ":" + shotLabel(sh, i)
                   + ":" + Math.round(tlSecs(sh.state) * 100)
                   + (sh.off ? ":off" : "")
                   + (sh.link === false ? ":L" : "")
                   + (sh.colour ? ":" + sh.colour : "")).join("|")].join("/");
    if (sig === tlSig && tlStrip.children.length) return;
    tlSig = sig;
    tlStrip.style.width = L.width + "px";
    tlStrip.replaceChildren();
    L.blocks.forEach((b) => {
      const sh = p.shots[b.i];
      const d = el("div", "clip" + (b.i === p.idx ? " on" : ""));
      /* A broken link (sh.link === false) closes the 2px gap so the run reads
         as separate objects; a linked (default) pair stays one run. */
      const lp = b.i > 0 && sh.link !== false;
      const nx = p.shots[b.i + 1];
      const ln = !!(nx && nx.link !== false);
      d.style.left = b.x + "px";
      d.style.width = Math.max(3, b.w - (ln ? 0 : 2)) + "px";
      if (lp) d.classList.add("lp");
      if (ln) d.classList.add("ln");
      if (lp || ln) d.classList.add("lk");
      const c = tlColour(sh, b.i);
      d.style.setProperty("--c", c);
      d.style.setProperty("--cg", c + "5c");
      d.style.setProperty("--cw", c + "24");
      d.dataset.clip = String(b.i);
      d.title = shotLabel(sh, b.i) + " \u2014 " + fmtSecs(b.sec)
              + (sh.off
                  ? "  \u2014 已跳过，渲染会越过它"
                  : "  \u2014 参与渲染")
              + "  (双击改名，右键换颜色，Alt+单击 " + (sh.off ? "恢复" : "跳过") + ")";
      if (b.w < 24) d.classList.add("tiny");
      if (sh.off) d.classList.add("off");
      if (b.w >= 46) {
        const sk = el("button", "sk", sh.off ? "\u25CB" : "\u25CF");
        sk.title = sh.off
          ? "已跳过 \u2014 渲染会越过此段。点击恢复。"
          : "参与渲染。点击跳过。";
        sk.onclick = (ev) => { ev.stopPropagation(); toggleSkip(b.i); };
        d.classList.add("hasdot");
        d.append(sk);
      }
      d.append(el("div", "nm", shotLabel(sh, b.i)));
      if (b.w >= 74) d.append(el("div", "du", fmtSecs(b.sec)));
      tlStrip.append(d);
    });

    /* One control per seam, appended after the blocks so it stacks above
       both. Needs a few pixels of block either side of it or it covers the
       labels it sits between. */
    L.blocks.forEach((b) => {
      if (b.i < 1) return;
      const prev = L.blocks[b.i - 1];
      if (Math.min(prev.w, b.w) < 30) return;
      const sh = p.shots[b.i];
      const on = sh.link !== false;
      const k = el("button", "lnk" + (on ? " on" : ""));
      k.type = "button";
      k.dataset.link = String(b.i);
      k.style.left = (b.x - 1) + "px";
      k.innerHTML = '<svg viewBox="0 0 12 12">'
        + '<path d="M5 7 7 5"/>'
        + '<path d="M4.4 5.6 3.2 6.8a1.9 1.9 0 0 0 2.7 2.7l1.2-1.2"/>'
        + '<path d="M7.6 6.4l1.2-1.2a1.9 1.9 0 0 0-2.7-2.7L4.9 3.7"/>'
        + "</svg>";
      const a = shotLabel(p.shots[b.i - 1], b.i - 1), z = shotLabel(sh, b.i);
      k.title = on
        ? `已续写：${z} 接 ${a} 的尾部。点击断开 \u2014 该段不再引用上一段的成片。`
        : `未续写。点击连接：${z} 接 ${a}，作为一段连续镜头。`;
      k.onclick = (ev) => { ev.stopPropagation(); toggleLink(b.i); };
      tlStrip.append(k);
    });
  }

  function paintRule(L) {
    let step = TL_TICKS[TL_TICKS.length - 1];
    for (const cand of TL_TICKS) { if (cand * L.pps >= 46) { step = cand; break; } }
    tlRule.replaceChildren();
    const first = Math.floor(tlPan / L.pps / step) * step;
    const last = (tlPan + L.view) / L.pps;
    for (let t = first; t <= last; t += step) {
      const x = t * L.pps - tlPan;
      if (x < 0 || x > L.view) continue;
      const maj = Math.abs((t / step) % 5) < 1e-6;
      const tick = el("div", "t" + (maj ? " maj" : ""));
      tick.style.left = x + "px";
      tlRule.append(tick);
      if (maj && t > 0 && x < L.view - 34) {
        const lb = el("div", "lbl", tlTime(t));
        lb.style.left = x + "px";
        tlRule.append(lb);
      }
    }
    const canPan = L.width > L.view + 1;
    tlView.classList.toggle("pannable", canPan);
    tlRule.classList.toggle("pannable", canPan);
    paintTlTools();
  }

  function tlDropPos(px, from) {
    if (!tlLay) return 0;
    const rest = tlLay.blocks.filter((b) => b.i !== from);
    let x = 0;
    for (let k = 0; k < rest.length; k++) {
      if (px < x + rest[k].w / 2) return k;
      x += rest[k].w;
    }
    return rest.length;
  }

  function tlPreview(from, to) {
    const order = tlLay.blocks.map((b) => b.i);
    const [it] = order.splice(from, 1);
    order.splice(to, 0, it);
    const pos = {};
    let x = 0;
    order.forEach((i) => { pos[i] = x; x += tlLay.blocks[i].w; });
    return pos;
  }

  function reorderShot(from, to) {
    const p = proj();
    if (to < 0 || to > p.shots.length - 1) { paintTimeline(); return; }
    const cur = p.idx >= 0 ? p.shots[p.idx] : null;
    const [it] = p.shots.splice(from, 1);
    p.shots.splice(to, 0, it);
    if (cur) p.idx = p.shots.indexOf(cur);
    shotsFocus = p.idx;
    commit(); paintShotsBtn(); paintPresetName(); renderShots();
    paintTimeline();
  }

  function tlStartPan(e) {
    const L = tlLay;
    if (!L || L.width <= L.view + 1) return false;
    const x0 = e.clientX, pan0 = tlPan, k = tlScale();
    tlView.classList.add("panning");
    tlRule.classList.add("panning");
    try { tlView.setPointerCapture(e.pointerId); } catch (_) {}
    const move = (ev) => {
      ev.preventDefault(); ev.stopPropagation();
      tlPanNow(Math.max(0, Math.min(pan0 + (x0 - ev.clientX) / k,
                                    Math.max(0, tlLay.width - tlLay.view))));
      paintTimeline();
    };
    const up = (ev) => {
      tlView.classList.remove("panning");
      tlRule.classList.remove("panning");
      document.removeEventListener("pointermove", move, true);
      document.removeEventListener("pointerup", up, true);
    };
    document.addEventListener("pointermove", move, true);
    document.addEventListener("pointerup", up, true);
    return true;
  }

  /* Drag a block to reorder. Pointer-based, not HTML5 drag. */
  function tlStartDrag(e, i) {
    const L = tlLay;
    if (!L) return false;
    const k = tlScale();
    let dragging = false;
    let mark = null;
    const from = i;
    const move = (ev) => {
      if (!dragging) {
        if (Math.abs(ev.clientX - e.clientX) < 4) return;
        dragging = true;
        tlStrip.classList.add("dragging");
        const clip = tlStrip.querySelector('[data-clip="' + from + '"]');
        if (clip) clip.classList.add("lifted", "nomove");
        mark = el("div", "drop");
        tlStrip.append(mark);
      }
      ev.preventDefault(); ev.stopPropagation();
      const r = tlView.getBoundingClientRect();
      const px = (ev.clientX - r.left) / k + tlPan;
      const to = tlDropPos(px, from);
      if (tlLay) {
        const pos = tlPreview(from, to);
        const clips = tlStrip.querySelectorAll(".clip");
        clips.forEach((cl) => {
          const ci = +cl.dataset.clip;
          if (isNaN(ci)) return;
          cl.style.left = pos[ci] + "px";
        });
      }
      /* position the drop marker */
      const rest = tlLay.blocks.filter((b) => b.i !== from);
      let x = 0;
      for (let q = 0; q < to; q++) x += rest[q].w;
      if (mark) mark.style.left = (x - tlPan) + "px";
    };
    const up = (ev) => {
      document.removeEventListener("pointermove", move, true);
      document.removeEventListener("pointerup", up, true);
      tlStrip.classList.remove("dragging");
      if (dragging && mark) {
        const r = tlView.getBoundingClientRect();
        const px = (ev.clientX - r.left) / k + tlPan;
        const to = tlDropPos(px, from);
        tlDragEnd = Date.now();   // suppress the click that follows a drag
        reorderShot(from, to);
      } else {
        paintTimeline();
      }
    };
    document.addEventListener("pointermove", move, true);
    document.addEventListener("pointerup", up, true);
    return true;
  }

  const tlRuleDown = (e) => {
    if (!tlRule.contains(e.target)) return;
    if (tlStartPan(e)) { e.preventDefault(); e.stopPropagation(); }
  };
  window.addEventListener("pointerdown", tlRuleDown, true);

  tlView.addEventListener("pointerdown", (e) => {
    const clip = e.target.closest ? e.target.closest(".clip") : null;
    if (!clip || clip.classList.contains("virtual")) {
      if (tlStartPan(e)) { e.preventDefault(); e.stopPropagation(); }
      return;
    }
    const i = +clip.dataset.clip;
    if (e.button === 1) { e.preventDefault(); tlStartPan(e); return; }
    if (e.altKey) { e.preventDefault(); toggleSkip(i); return; }
    if (tlStartDrag(e, i)) { e.preventDefault(); e.stopPropagation(); }
  });

  tlView.addEventListener("click", (e) => {
    const clip = e.target.closest ? e.target.closest(".clip") : null;
    if (!clip || clip.classList.contains("virtual")) return;
    if (e.altKey) return;
    if (Date.now() - tlDragEnd < 150) return;
    const i = +clip.dataset.clip;
    switchTo(i);
    paintTimeline();
  });

  tlView.addEventListener("dblclick", (e) => {
    const clip = e.target.closest ? e.target.closest(".clip") : null;
    if (!clip || clip.classList.contains("virtual")) return;
    const i = +clip.dataset.clip;
    const p = proj();
    const s = p.shots[i];
    if (!s) return;
    const d = el("input");
    d.value = s.name || "";
    d.placeholder = `分段 ${i + 1}`;
    clip.replaceChildren(d);
    d.focus(); d.select();
    const done = () => { s.name = d.value.trim(); commit(); paintShotsBtn(); paintPresetName(); renderShots(); paintTimeline(); };
    d.onclick = (ev) => ev.stopPropagation();
    d.onblur = done;
    d.onkeydown = (ev) => {
      ev.stopPropagation();
      if (ev.key === "Enter") { ev.preventDefault(); done(); }
      if (ev.key === "Escape") { ev.preventDefault(); paintTimeline(); }
    };
  });

  tlView.addEventListener("contextmenu", (e) => {
    const clip = e.target.closest ? e.target.closest(".clip") : null;
    if (!clip || clip.classList.contains("virtual")) return;
    e.preventDefault(); e.stopPropagation();
    const i = +clip.dataset.clip;
    const p = proj();
    const s = p.shots[i];
    if (!s) return;
    const menu = el("div", "gcastL-menu");
    menu.dataset.mode = st.mode;
    SHOT_COLOURS.forEach((c) => {
      const it = el("button", null);
      if (s.colour === c) it.setAttribute("aria-selected", "true");
      it.style.display = "flex"; it.style.alignItems = "center"; it.style.gap = "10px";
      const sw = el("span");
      sw.style.cssText = `width:12px;height:12px;border-radius:3px;background:${c};flex:0 0 auto`;
      it.append(sw, el("span", null, s.colour === c ? "已选颜色" : ""));
      it.onclick = () => { s.colour = c; commit(); paintTimeline(); menu.remove(); };
      menu.append(it);
    });
    const clear = el("button", null, "清除颜色（回到自动）");
    clear.onclick = () => { delete s.colour; commit(); paintTimeline(); menu.remove(); };
    menu.append(clear);
    menu.style.left = e.clientX + "px";
    menu.style.top = e.clientY + "px";
    document.body.append(menu);
    const rm = (ev) => { if (!menu.contains(ev.target)) { menu.remove(); document.removeEventListener("pointerdown", rm, true); } };
    setTimeout(() => document.addEventListener("pointerdown", rm, true), 0);
  });

  /* Keep the timeline visible whenever there is a project OR the current clip. */
  paintTimeline();

  /* The panel is fixed to the viewport while the button moves with the
   * canvas, so it re-anchors every frame while open. Cheaper than trying to
   * hook LiteGraph's pan and zoom, and it cannot get out of sync. */
  (function followShots() {
    if (shotsOpen) placeShots();
    requestAnimationFrame(followShots);
  })();

  /* Insurance: the frontend claims wheel at window level, which is why the
   * prompt box will not scroll. Same trap would hit a long shot list, so the
   * list is scrolled by hand whenever the pointer is genuinely over it. */
  window.addEventListener("wheel", (e) => {
    if (!shotsOpen || !shotsPanel.contains(e.target)) return;
    const list = shotsPanel.querySelector(".gcastL-shots-list");
    if (!list || list.scrollHeight <= list.clientHeight) return;
    list.scrollTop += e.deltaY;
    e.preventDefault(); e.stopPropagation();
  }, { capture: true, passive: false });

  bSave.onclick = () => saveOver();
  bSaveAs.onclick = () => saveAs(false);
  bPack.onclick = () => saveAs(true);
  bLoad.onclick = () => doLoad();

  /* 面板槽位 + 接线媒体架槽位的合并展示视图（媒体架覆盖同编号，空位面板兜底）。
   * 数组长度取两者较长者——媒体架是动态槽位（可 >9/3/3），若以面板固定长度
   * 起步，超出部分的素材永远进不了 chips / 展示条 / 自动补全。 */
  /* 解析缓存由 rackSlotsOf 持有（它按 rack_data 原文缓存 JSON.parse 结果）；
     这里只缓存「合并后的视图」，并按同样的键失效，避免每次击键都重新合并
     一遍面板槽位与媒体架槽位。键同时充当「上游是否变过」的判据，见 syncRack。 */
  let rackCache = { key: null, slots: { images: [], videos: [], audios: [] } };
  function mergedSlots() {
    /* 键里带上「外接提示词接线与否」：合并结果本身不看接线，但所有比对
       rackCache 的地方都拿它当「上游没变」的判据，而拔/插 prompt_text 不改变
       任何素材——接线状态不进键，拔线后导演台就永远停在只读镜像上。
       上游节点 id 也一并入键：换接到另一台文本源时原文可能一字不差，但来源
       换了，镜像该跟着换。 */
    const src = promptNodeOf(node);
    const key = rackSlotsOf(node).raw + "\u0002" + (src ? "W" + (src.id ?? "") : "N");
    if (key !== rackCache.key) rackCache = { key, slots: rackSlotsOf(node).slots };
    const out = {};
    for (const kind of ["images", "videos", "audios"]) {
      const mine = st.slots[kind];
      const wired = rackCache.slots[kind] || [];
      const n = Math.max(mine.length, wired.length);
      const row = [];
      for (let i = 0; i < n; i++) {
        const ws = wired[i];
        const ms = mine[i];
        row.push(ws && ws.file ? { ...ws } : ms && ms.file ? { ...ms } : null);
      }
      out[kind] = row;
    }
    return out;
  }

  function fileForToken(token) {
    if (!token) return null;
    const view = mergedSlots();
    const m = /^@图片(\d+)$/.exec(token); if (m) return view.images[+m[1] - 1]?.file || null;
    const v = /^@视频(?:音频)?(\d+)$/.exec(token); if (v) return view.videos[+v[1] - 1]?.file || null;
    const a = /^@音频(\d+)$/.exec(token); if (a) return view.audios[+a[1] - 1]?.file || null;
    if (token === "@first") return st.slots.first.file;
    if (token === "@last") return st.slots.last.file;
    return null;
  }

  /* 排队前自检：提示词里引用到的 @标签 / 别名，必须能在合并视图（面板槽位 +
     媒体架）里找到文件。缺了就在前端拦下，说清缺哪个标签、怎么补——不再让
     后端甩一句「槽位为空」让人摸不着头脑（尤其媒体架现在按分段记忆，切段
     倒回旧快照后素材可能不在了）。 */
  function missingRefs() {
    const bad = [];
    const seen = new Set();
    const text = st.prompt || "";
    const { re, am } = editTokRe();
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text))) {
      const al = alOf(m.groups);
      const canon = al != null ? am[normSpace(al)] : m[0];
      if (!canon || seen.has(canon)) continue;
      seen.add(canon);
      if (!fileForToken(canon)) bad.push(canon);
    }
    return bad;
  }

  /* 音频参考需要独立接「音频 VAE」（minimax_h3_audio_vae_fp32）——它不在
     optional 里强制，不接也能跑，于是一用到音频就在后端抛异常中断。这里在排队
     前拦下：提示词引用了音频、或视频槽位勾了音轨，而 audio_vae 没接线，直接
     报清楚缺什么、怎么补。判定只看「有没有连线」，不猜模型对不对。

     第三条判据「音频槽位摆了素材」是 20261021 补的：后端
     _filter_refs_by_prompt 对 audios 是**无条件发送**——它是代码里的显式例外，
     不看提示词（csglide_cast_legacy.py:1112 同口径）。于是只要槽位里摆了音频，
     后端就一定会走到 _encode_ref_audio，audio_vae 为 None 时抛异常中断。
     原先这里只查提示词与视频音轨勾选，于是「摆了音频 + 提示词没写 @音频N」
     这个组合前端放行进队、后端跑一半炸掉，用户看到的是「音频不生效」。
     三条判据必须与后端真正会走到 _encode_ref_audio 的三条路一一对应，
     少一条就是一条漏网的中断。 */
  function audioVaeMissing() {
    const slots = mergedSlots();
    const inPrompt = /@音频\d+/.test(effPrompt());
    const hasAudioSlot = (slots.audios || []).some((s) => s && s.file);
    const hasVideoTrack = (slots.videos || []).some((s) => s && s.file && s.audio);
    if (!(inPrompt || hasAudioSlot || hasVideoTrack)) return null;
    const inp = (node.inputs || []).find(
      (s) => s && (s.name === "audio_vae" || s.localized_name === "audio_vae")
             && s.type === "VAE");
    if (inp && inp.link != null) return null;
    return {
      why: inPrompt
        ? "提示词引用了 @音频N"
        : hasAudioSlot
          ? "音频槽位摆了素材（音频无条件发送，不写 @音频N 也会送）"
          : "视频槽位勾了「同时把其音轨作为音频参考」",
    };
  }

  /* 媒体架在另一个节点上编辑，导演台不会自己重渲——悬停进面板时检测
     rack_data 与外接提示词文本变化并刷新（chips / 按需发送展示 / miss 高亮 /
     只读镜像） */
  const syncRack = () => {
    const before = rackCache.key;
    /* 焦点在提示词编辑区：整面板 render 会重建编辑器、抢走光标，所以不能走
       render()。但素材标签在编辑区之外，单独刷新它完全安全——否则「光标还停
       在提示词框里」时媒体架增删素材一概不刷新，看上去就像卡在上一批素材。 */
    if (document.activeElement === ta) {
      mergedSlots();
      if (rackCache.key !== before) { renderTags(true); return true; }
      return false;
    }
    /* 正在别的节点里编辑文本（ComfyUI 的浮动输入/外接文本源）也不动：
       镜像更新会重建 DOM 并触发画布重排，打断外部输入。等焦点离开再刷新。 */
    const ae = document.activeElement;
    if (ae && ae !== document.body && !root.contains(ae)) {
      const editing = ae.tagName === "TEXTAREA" || ae.tagName === "INPUT" || ae.isContentEditable;
      if (editing) return false;
    }
    mergedSlots();
    /* 不需要再单独判外接提示词的文本差异：接线状态与上游节点 id 都在 key 里，
       上游改字会让 key 变，key 变就足以触发重渲（重渲里自会把只读镜像换成
       新文本）。原来那句 promptWired() && edText() !== effPrompt() 是个死判据
       ——edText() 正是被镜像过的文本，接线后两者恒等，恒为 false。 */
    if (rackCache.key !== before) { render(); return true; }
    return false;
  };
  root.addEventListener("pointerenter", syncRack);
  /* 悬停只能覆盖「鼠标移回导演台」这一刻。媒体架里换位/增删后导演台收不到
     任何事件，标签会一直停在旧顺序上——补一个低频轮询兜底：只比对 rack_data
     原文与外接文本，不同才重渲，成本可忽略。destroy() 里清理。 */
  const rackPoll = setInterval(() => {
    if (!node.flags?.collapsed) syncRack();
  }, 800);

  const tokenOf = (r) =>
    r.token || (r.from === "first frame" ? "@first" : r.from === "last frame" ? "@last" : null);

  /* ---- @ autocomplete ---------------------------------------------- */

  const ac = el("div", "gcastL-ac");
  ac.style.display = "none";
  ac.addEventListener("pointerdown", (e) => e.preventDefault());   // keep textarea focus
  ac.style.position = "fixed";
  document.body.append(ac);   // outside the node, so opening it can't reflow the layout

  let acItems = [], acIdx = 0, acStart = -1;
  let chipSig = "";
  const chipEls = new Map();

  /* caret position, measured with a style-cloned mirror */
  function caretXY() {
    const cs = getComputedStyle(ta);
    const mirror = el("div");
    const copy = ["fontFamily", "fontSize", "fontWeight", "lineHeight", "letterSpacing",
      "paddingTop", "paddingRight", "paddingBottom", "paddingLeft",
      "borderTopWidth", "borderLeftWidth", "textTransform", "wordSpacing"];
    copy.forEach((k) => { mirror.style[k] = cs[k]; });
    Object.assign(mirror.style, {
      position: "absolute", visibility: "hidden", whiteSpace: "pre-wrap",
      wordWrap: "break-word", top: "0", left: "0",
      width: ta.clientWidth + "px", boxSizing: "border-box",
    });
    Object.assign(mirror.style, { left: "-99999px", top: "0" });
    const head = document.createTextNode(edText().slice(0, edCaret().s));
    const mark = el("span", null, "\u200b");
    mirror.append(head, mark);
    document.body.append(mirror);
    const x = mark.offsetLeft, y = mark.offsetTop;
    mirror.remove();
    const box = ta.getBoundingClientRect();
    return { x: box.left + x, y: box.top + y - ta.scrollTop + parseFloat(cs.lineHeight || 18) + 4 };
  }

  function closeAC() { ac.style.display = "none"; acItems = []; acStart = -1; acSignature = ""; }

  /* The @ list also offers the next shot marker.
   *
   * The bracket-and-timestamp format is the one thing in an H3 prompt you
   * cannot guess, and typing "[Shot 2] At 00:04.000," by hand is exactly where
   * people give up and write prose instead. So the menu writes it.
   *
   * Shot 1 carries no timestamp - that is the format's rule, not a shortcut.
   * Later markers default to halfway between the previous one and the end of
   * the clip, rounded to the half second: a placeholder you can immediately
   * see on the timeline strip, instead of a 00:00 that stacks everything on
   * top of itself. */
  function mmss(t) {
    const m = Math.floor(t / 60), sec = Math.floor(t % 60);
    const ms = Math.round((t - Math.floor(t)) * 1000);
    return `${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}.${String(ms).padStart(3, "0")}`;
  }

  function nextShotMarker() {
    const total = Math.max(0.001, (alignFrames(st.length) - 1) / FPS);
    const found = parseShots(effPrompt(), total);
    const n = found.length + 1;
    if (n === 1) return { text: "[Shot 1] ", token: "[Shot 1]", tag: "starts the clip" };
    const timed = found.filter((x) => !x.untimed).map((x) => x.start);
    const last = timed.length ? Math.max.apply(null, timed) : 0;
    let t = last + (total - last) / 2;
    t = Math.max(0, Math.min(total, Math.round(t * 2) / 2));
    return { text: `[Shot ${n}] At ${mmss(t)}, `, token: `[Shot ${n}]`, tag: `At ${mmss(t)}` };
  }

  function openAC(query, start) {
    /* 合并视图：媒体架槽位（含 9/3/3 之外的编号）同样可被 @ 补全 */
    const { rows } = presentation(st, mergedSlots());
    const q = query.toLowerCase();
    /* 一个素材只出一个入口：有别名就出别名行（副标签已把 @图片N 写在旁边），
       不再追加一行 @图片N——同一个素材两个入口，选哪个都得先想一下。
       别名不匹配当前输入时回退到索引行，否则搜「@图片1」时该素材整个消失，
       而它明明有别名、只是名字里不含这几个字。没有别名的素材照旧只出索引行。
       canon 供 fileForToken 取缩略图——别名本身不是规范 token，查不到文件。 */
    acItems = [];
    for (const r of rows) {
      const token = tokenOf(r);
      if (!token) continue;
      const alias = aliasLabel(token);
      if (alias && (!q || alias.toLowerCase().includes(q))) {
        acItems.push({ token: alias, canon: token, tag: r.tag, from: r.from, kind: r.kind, isAlias: true });
      } else if (!q || token.slice(1).toLowerCase().includes(q)) {
        acItems.push({ token, tag: r.tag, from: r.from, kind: r.kind });
      }
    }

    /* always last in the list - it is an action, not a reference */
    if (!q || "shot marker cut".includes(q)) {
      const mk = nextShotMarker();
      acItems.push({ special: "shot", insert: mk.text, token: mk.token, tag: mk.tag, kind: "shot" });
    }
    acStart = start;
    acIdx = 0;
    if (!acItems.length) { closeAC(); return; }
    ac.dataset.mode = st.mode;
    drawAC();
    const { x, y } = caretXY();
    ac.style.display = "";
    const w = ac.offsetWidth || 220, h = ac.offsetHeight || 200;
    ac.style.left = Math.max(6, Math.min(x, window.innerWidth - w - 8)) + "px";
    ac.style.top = (y + h > window.innerHeight - 8 ? Math.max(6, y - h - 26) : y) + "px";
  }

  let acSignature = "";

  function markAC() {
    Array.from(ac.children).forEach((b, i) => {
      if (b.tagName === "BUTTON") b.setAttribute("aria-selected", String(i === acIdx));
    });
  }

  function drawAC() {
    const sig = acItems.map((o) => o.token + o.tag).join("|");
    if (sig === acSignature && ac.children.length) { markAC(); return; }
    acSignature = sig;

    ac.replaceChildren();
    if (!acItems.length) {
      ac.append(el("div", "none", refsWired() ? "参考素材由 H3 媒体架提供" : "还没有填入任何参考"));
      return;
    }
    acItems.forEach((o, i) => {
      const b = el("button");
      const file = fileForToken(o.canon || o.token);
      if (o.special) b.append(el("span", "glyph mark", "\u2702"));
      else if (o.kind === "image" && file) { const im = el("img"); im.src = viewURL(file); b.append(im); }
      else if (o.kind === "video" && file) { const v = el("video"); v.src = viewURL(file); v.muted = true; v.preload = "metadata"; b.append(v); }
      else b.append(el("span", "glyph", "\u266a"));
      b.append(el("span", null, o.token));
      if (o.canon) b.append(el("span", "fname", o.canon));
      if (file) b.append(el("span", "fname", file.split("/").pop()));
      b.append(el("span", "tag", o.tag));
      b.addEventListener("mouseenter", () => { acIdx = i; markAC(); });
      b.addEventListener("pointerdown", (e) => { e.preventDefault(); e.stopPropagation(); acceptAC(i); });
      ac.append(b);
    });
    markAC();
  }

  function acceptAC(i) {
    const o = acItems[i];
    if (!o) { closeAC(); return; }
    const text = edText();
    const caret = edCaret().s;
    const before = text.slice(0, acStart);

    /* a shot marker starts a line; a reference tag goes wherever you are */
    const insert = o.special
      ? ((before.length && !/\n[ \t]*$/.test(before) ? "\n" : "") + o.insert)
      : o.token + " ";

    const newText = text.slice(0, acStart) + insert + text.slice(caret);
    st.prompt = newText;
    setEditorText(newText, acStart + insert.length);
    ta.focus();
    closeAC(); renderTags(); commit();
    if (o.special) renderCheck();
  }

  function maybeAC() {
    const text = edText();
    const caret = edCaret().s;
    const m = /@([^\s@]*)$/.exec(text.slice(0, caret));
    if (!m) { closeAC(); return; }
    openAC(m[1], caret - m[0].length);
  }

  /* The editor is a <div> now, not a <textarea>, so LiteGraph's canvas guard
   * (which only shields <input>/<textarea>) never sees it: Ctrl+V/C/X/A,
   * Delete and Backspace all leak to the canvas and act on NODES. A keydown
   * listener ON the editor cannot stop that either - the canvas hook is bound
   * on the canvas element with capture, so it fires BEFORE the editor. The
   * only point that runs before every other keydown listener in the page is
   * the CAPTURE phase on window; stopImmediatePropagation there stops the key
   * from ever reaching the canvas, the document or any other handler. */
  window.addEventListener("keydown", (e) => {
    if (!ta.contains(e.target)) return;
    e.stopImmediatePropagation();
    /* 撤销/重做自己接管，且必须写在这里：本监听位于 window 捕获阶段并已
       stopImmediatePropagation，是唯一跑在所有其他 keydown 之前、也能彻底阻断
       传播的位置（挂在 ta 上的监听永远收不到事件）。交给浏览器原生 undo 有两个
       问题——高亮重建 DOM 让原生栈作废；contenteditable 上的原生 Ctrl+Z 还会把
       同一编辑上下文里父容器（素材标签所在的 .gcastL-pwrap）的变更一并回滚，
       标签随之消失。 */
    if (e.ctrlKey || e.metaKey) {
      const k = (e.key || "").toLowerCase();
      if (k === "z" || k === "y") {
        e.preventDefault();
        if (k === "y" || e.shiftKey) {
          if (redoStack.length) { undoStack.push(undoMark); restoreUndo(redoStack.pop()); }
        } else if (undoStack.length) {
          redoStack.push(undoMark);
          restoreUndo(undoStack.pop());
        }
        return;
      }
    }
    if (ac.style.display === "none") {
      /* Plaintext fallback: `contenteditable="true"` (non-Chromium) turns Enter
       * into a <div>/<br>, which breaks innerText round-tripping. Force a
       * literal newline instead. */
      if (e.key === "Enter") {
        e.preventDefault();
        insertTextNode("\n");
      }
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      acIdx = (acIdx + (e.key === "ArrowDown" ? 1 : -1) + acItems.length) % Math.max(1, acItems.length);
      markAC();
      ac.children[acIdx]?.scrollIntoView?.({ block: "nearest" });
    } else if (e.key === "Enter" || e.key === "Tab") {
      if (!acItems.length) return;
      e.preventDefault();
      acceptAC(acIdx);
    } else if (e.key === "Escape") {
      e.preventDefault();
      closeAC();
    }
  }, true);
  /* Same for keyup: LiteGraph also binds keyup on the document in capture
   * (line 130051 of the bundle) and re-dispatches it into processKey, so a
   * released Backspace/Ctrl+V would still land there. */
  window.addEventListener("keyup", (e) => {
    if (!ta.contains(e.target)) return;
    e.stopImmediatePropagation();
  }, true);
  /* 失焦时把整篇提示词的引用写法归一化：手打的 Picture 1 / image1 / 视频 2
     在这里才收敛成 @图片1 / @视频2。刻意不在 input 里做——那会在打字中途
     改写文本、顶掉光标。 */
  ta.addEventListener("blur", () => {
    setTimeout(closeAC, 120);
    /* 外接提示词（prompt_text 接线）：编辑器只是上游文本的只读镜像，且是已经
       展开过别名的文本。在这里写回等于把外部数据倒灌进面板原文——与「st.prompt
       永不被外部数据污染」的承诺相反，展开后的名字同样会被 @图片N 吃掉。
       面板原文本来就不该由失焦事件动，直接跳过整段。 */
    if (promptWired()) return;
    const t = ta.textContent || "";
    const norm = normalizeRefs(t, mergedSlots());
    if (norm === t) return;
    st.prompt = norm;
    setEditorText(norm, norm.length, false);
    renderTags(); renderCheck(); commit();
  });
  ta.addEventListener("click", () => maybeAC());

  function insert(token) {
    const text = edText();
    const c = edCaret();
    const s = c.s, e = Math.max(c.e, s);
    const pad = (s > 0 && !/\s$/.test(text.slice(0, s))) ? " " : "";
    const newText = text.slice(0, s) + pad + token + " " + text.slice(e);
    const pos = s + pad.length + token.length + 1;
    pushUndo(newText);
    st.prompt = newText;
    setEditorText(newText, pos);
    ta.focus();
    renderTags(); commit();
  }

  /* -------------------------------------------------------- listeners */

  /* pointerdown rather than click: something in the v2 node renderer can
   * swallow the click before it lands, and stopping propagation here keeps
   * the canvas-forwarding handler on root out of the way. */
  const setMode = (m) => {
    if (st.mode === m) return;
    st.mode = m;
    render();
    commit();
  };
  const wireMode = (btn, mode) => {
    btn.addEventListener("pointerdown", (e) => {
      e.preventDefault(); e.stopPropagation();
      setMode(mode);
    });
    btn.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); });
  };
  wireMode(btnFL, "fl2va");
  wireMode(btnRef, "ref2va");

  selRatio.onchange = (v) => {
    if (v === "custom") { st.ratio = "custom"; render(); commit(); return; }
    const fam = RATIOS.find((r) => r.label === v);
    if (!fam) return;
    st.ratio = v;
    /* keep the rung of the ladder they were already on, if it exists */
    const cur = findRatio(st.width, st.height);
    const rung = cur ? cur.sizes.findIndex((z) => z.w === st.width && z.h === st.height) : 0;
    const pick = fam.sizes[Math.min(Math.max(0, rung), fam.sizes.length - 1)];
    st.width = pick.w; st.height = pick.h; render(); commit();
  };
  selSize.onchange = (v) => {
    if (v === "custom") return;
    const [w, h] = v.split("x").map(Number);
    st.width = w; st.height = h; render(); commit();
  };
  const snap = (v) => Math.max(32, Math.round(v / 32) * 32);
  const activeRatio = () => st.ratio === "custom" ? null : RATIOS.find((r) => r.label === st.ratio);
  inW.onchange = () => {
    const fam = activeRatio();
    const w = snap(+inW.value || 768);
    st.width = w;
    /* A preset ratio keeps both fields locked together: adjusting the width
     * drives the height so the aspect ratio never drifts. Only "custom"
     * unlinks them so width and height edit independently. */
    if (fam) st.height = snap(w / (fam.w / fam.h));
    render(); commit();
  };
  inH.onchange = () => {
    const fam = activeRatio();
    const h = snap(+inH.value || 768);
    st.height = h;
    if (fam) st.width = snap(h * (fam.w / fam.h));
    render(); commit();
  };

  selLen.onchange = (v) => {
    if (v === "custom") return;
    st.length = +v; render(); commit();
  };
  inLen.onchange = () => {
    /* 回显只给整数秒（见 secsOfFrames），而吸附仍按未取整的秒走——若用户只是
       点进框又点出来（值没变，onchange 照样触发），10.13s 会被读成 10s 再吸附到
       另一格帧数，等于「什么都没干却改了片段长度」。故对未编辑过的回显值短路：
       只有真敲过键盘才重算。 */
    if (inLen.dataset.dirty !== "1") { render(); return; }
    delete inLen.dataset.dirty;
    /* 输入是秒；framesOfSecs 里已含「空/非法 → 124」的兜底，且吸附后回显，
       所以这里不必再兜一次。 */
    st.length = framesOfSecs(inLen.value);
    render(); commit();
  };

  const refSnap = (v, cap) => Math.max(REF_MIN, Math.min(cap, Math.round(v / REF_STEP) * REF_STEP));
  chkRef.onchange = () => {
    st.ref_image_size = chkRef.checked ? "match" : refSnap(Math.max(st.width, st.height), REF_IMAGE_MAX);
    render(); commit();
  };
  inRef.onchange = () => { st.ref_image_size = refSnap(+inRef.value || REF_MIN, REF_IMAGE_MAX); render(); commit(); };
  inScale.onchange = () => { st.ref_scale_hd = clampRefScale(inScale.value); render(); commit(); };
  chkVRef.onchange = () => {
    st.ref_video_size = chkVRef.checked ? "match" : refSnap(Math.max(st.width, st.height), REF_VIDEO_MAX);
    render(); commit();
  };
  inVRef.onchange = () => { st.ref_video_size = refSnap(+inVRef.value || REF_MIN, REF_VIDEO_MAX); render(); commit(); };
  fpsRef.onchange = () => { st.ref_video_fps = clampRefFps(+fpsRef.value); render(); commit(); };


  ta.addEventListener("input", () => {
    pushUndo(ta.textContent || "");
    st.prompt = ta.textContent || "";
    if (!composing) scheduleHighlight();
    renderTags(); renderCheck(); maybeAC(); commit();
  });

  ta.addEventListener("pointerdown", (e) => e.stopPropagation());
  /* The DOM widget sits over the canvas and eats wheel and drag. Rather than
   * disabling pointer events (which risks reaching a shared container and
   * freezing the whole graph), re-dispatch the event onto the canvas. */
  const graphCanvas = () => app.canvas?.canvas || document.querySelector("canvas#graph-canvas");

  const INTERACTIVE = "button, select, input, textarea, [contenteditable], label, " +
    ".gcastL-slot, .gcastL-media, .gcastL-chip, .gcastL-track, .gcastL-thumb, .gcastL-wav";

  root.addEventListener("wheel", (e) => {
    closeAC();
    /* Anything that can scroll itself keeps the wheel -- but only while it
     * actually has somewhere to go. Returning early is not enough on its own:
     * without stopPropagation the event carries on to the canvas handler and
     * zooms the graph instead of scrolling the prompt. At either end of the
     * scroll, hand it on so a short prompt still zooms like the rest of the
     * panel. No preventDefault -- the browser does the scrolling. */
    /* A scrollable area keeps the wheel outright. Handing it on at the ends
     * sounds tidy but means a wheel-down at scrollTop 0 zooms the graph
     * instead of scrolling -- which is the whole complaint. overscroll-behavior
     * in the CSS stops the scroll chaining onward once it does hit an end. */
    if (e.target.closest("textarea, [contenteditable], .gcastL-ac")) {
      e.stopPropagation();
      return;
    }
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

  /* NO pointerdown forwarding to the canvas. v2 takes pointer CAPTURE on that
   * press and only releases it from its own state machine, which ignores an
   * untrusted event -- so the canvas keeps panning with the mouse until a
   * real press elsewhere clears it. Confirmed in the event log: every stuck
   * drag began with a re-dispatched pointerdown and ended on the next real
   * press with lostpointercapture. Wheel forwarding above is fine, because
   * wheel does not capture. The node still drags by its title bar.
   */

  /* Miss a slot and the file falls through to ComfyUI, which answers by
   * spawning a LoadAudio node on the graph. The node swallows the whole drop
   * instead: while a file is over it, every slot that could take that file is
   * armed so the target is visible, and a release that lands on none of them
   * is routed to the first empty slot of the right kind rather than escaping. */
  let dragDepth = 0;

  function armSlots(kind) {
    root.querySelectorAll("[data-kind]").forEach((n) => {
      n.classList.toggle("gcastL-armed", kind === "" || n.dataset.kind === kind);
    });
  }
  function disarm() {
    dragDepth = 0;
    root.querySelectorAll(".gcastL-armed, .drop").forEach((n) => {
      n.classList.remove("gcastL-armed", "drop");
    });
  }

  root.addEventListener("dragenter", (e) => {
    const k = dragKind(e);
    if (k === null) return;
    e.preventDefault(); e.stopPropagation();
    dragDepth++;
    armSlots(k);
  });
  root.addEventListener("dragover", (e) => {
    if (dragKind(e) === null) return;
    e.preventDefault(); e.stopPropagation();      /* keep it off the canvas */
  });
  root.addEventListener("dragleave", (e) => {
    if (dragKind(e) === null) return;
    if (--dragDepth <= 0) disarm();
  });
  window.addEventListener("dragend", disarm);
  window.addEventListener("drop", disarm);

  root.addEventListener("drop", async (e) => {
    const k = dragKind(e);
    if (k === null) return;
    e.preventDefault(); e.stopPropagation();       /* never reaches the graph */
    const onSlot = e.target.closest("[data-kind]");
    disarm();
    if (onSlot) return;                            /* the slot handled it */
    const f = e.dataTransfer?.files?.[0];
    const kind = f && (fileKind(f) || k);
    if (!f || !kind) return;
    /* 参考素材槽位已外迁媒体架：面板空白处不接收文件，拒绝闪烁提示 */
    flashPanel();
  });

  /* ---------------------------------------------------------------- paste
   * Ctrl+V, the same way a stock LoadImage node takes it.
   *
   * ComfyUI's own paste handler looks for pasteFile() on the CURRENT node and,
   * finding none, drops a fresh LoadImage node on the graph -- the same escape
   * the drop handler above closes. Two entries, deliberately non-overlapping:
   *
   *   pointer over the panel   -> this listener takes it, hovered slot wins
   *   node selected, pointer elsewhere -> core calls pasteFile() (see register)
   *
   * It listens in the CAPTURE phase on window so it runs before core's
   * document-level handler, and only stops propagation when it actually
   * consumes the paste. Hover is the signal rather than selection because
   * pressing the panel background does not select the node (the pointerdown
   * re-dispatch to the canvas was removed) -- so "click a slot, hit Ctrl+V"
   * would otherwise paste into nothing.
   */
  let overPanel = false;
  let hoverEl = null;
  /* pointerenter/leave do not bubble, so these describe the panel itself */
  root.addEventListener("pointerenter", () => { overPanel = true; });
  root.addEventListener("pointerleave", () => { overPanel = false; hoverEl = null; });
  /* pointerover DOES bubble: fires for every descendant, so hoverEl clears
     itself as soon as the pointer moves off a slot onto plain panel */
  root.addEventListener("pointerover", (e) => {
    hoverEl = e.target?.closest?.("[data-kind]") || null;
  });

  /* A clipboard image has no useful name -- Chrome calls every one of them
   * image.png. Stamping it keeps successive pastes apart in input/cglide/
   * instead of leaning on the server's (1)(2) suffixing. */
  function nameForPaste(file) {
    const mime = file.type || "image/png";
    const ext = (mime.split("/")[1] || "png").split("+")[0].replace("jpeg", "jpg");
    return `pasted-${Date.now()}.${ext}`;
  }

  /* Paste has no pointer trail, so without a flash there is no telling which
     of nine slots took the image. Reuses the drop look. */
  function flashTarget(node_) {
    if (!node_) return;
    node_.classList.add("drop");
    setTimeout(() => node_.classList.remove("drop"), 260);
  }

  async function takePaste(file, target) {
    if (!file) return;
    const kind = fileKind(file) || "image";
    const named = new File([file], nameForPaste(file), { type: file.type || "image/png" });
    const slot = target && root.contains(target) ? target.__gcastLSlot : null;
    if (slot) {
      if (target.dataset.kind !== kind) { flashWrong(target); return; }
      flashTarget(target);
      await assign(slot, named, kind, target.__gcastLToken || null);
      return;
    }
    /* 参考素材槽位已外迁媒体架：未落在槽位上的粘贴一律拒绝 */
    flashPanel();
  }

  const onPaste = (e) => {
    const cd = e.clipboardData;
    if (!cd) return;
    const file = Array.from(cd.files || [])[0]
      || Array.from(cd.items || [])
           .filter((i) => i.kind === "file")
           .map((i) => i.getAsFile())
           .find(Boolean);
    if (!file) return;
    const tgt = e.target;
    const editing = !!tgt && (tgt.tagName === "TEXTAREA" || tgt.tagName === "INPUT");
    /* Typing in the prompt: anything carrying text is a text paste, always.
       A screenshot with no text beside it still belongs in a slot. */
    if (editing && Array.from(cd.types || []).includes("text/plain")) return;
    const over = hoverEl && root.contains(hoverEl) ? hoverEl : null;
    const mine = overPanel || over || (editing && root.contains(tgt));
    if (!mine) return;                  /* not ours: core, or pasteFile below */
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation?.();
    takePaste(file, over);
  };
  window.addEventListener("paste", onPaste, true);

  ac.addEventListener("wheel", (e) => e.stopPropagation());
  root.addEventListener("scroll", () => closeAC(), true);

  function load(raw) {
    st = parseInitial(raw);
    /* 编辑器显示**剧本原文**：只做写法归一（手打的 Picture 1 → @图片1），
       绝不展开别名。这里曾经显示 effPrompt()（里面含别名展开），于是「@图片3
       中的陈九一」一刷新就变成「@图片3 中的@图片3」；更糟的是失焦写回会把这份
       展开文本当作用户输入存进 st.prompt、随工作流一起落盘——名字就此永久丢失，
       连重开都救不回来。别名区那条「原文不改写，编辑器里始终是剧本原文」的
       规矩，就是被这一行破掉的。（Qwen 节点的 edPos.setText(st.prompt) 一直
       是对的，导演台这里是唯一的例外。） */
    const shown = normalizeRefs(st.prompt || "", mergedSlots());
    setEditorText(shown, shown.length);
    render();
  }

  /* Measure the panel's NATURAL content height. .gcastL is height:100% +
     overflow:auto, so flex children shrink to fit a short node and
     scrollHeight then reports the shrunken height — the real content height is
     only visible once height:auto removes the cap. The prompt box is the one
     child that must NOT dictate the height: it is flex:1, and under height:auto
     it would grow to its full text length (thousands of px), which is exactly
     the "infinitely long" bug. Freeze it at its folded minimum while measuring
     so the natural height is the fixed chrome + one prompt row. */
  function naturalPanelHeight() {
    const prevH = root.style.height;
    const prevTaFlex = ta.style.flex;
    const prevTaHeight = ta.style.height;
    root.style.height = "auto";
    ta.style.flex = "none";
    ta.style.height = (st.mode === "fl2va" ? PROMPT_H_FL : PROMPT_H_REF) + "px";
    try {
      const h = root.offsetHeight || root.scrollHeight || 0;
      return Math.min(MAX_NODE_H, h);
    } finally {
      root.style.height = prevH;
      ta.style.flex = prevTaFlex;
      ta.style.height = prevTaHeight;
    }
  }

  /* 手动拖拽模式：fitNode 只在「新建」节点时调用一次，把 MIN_H_REF 这个固定初值
     校正到内容真实高度（含缩掉初值留下的留白）。加载已有工作流时不调用——那时
     node.size 是用户存下来的高度，以它为准（见注册段 onConfigure）。之后不再随
     内容变化自动改高。报给框架的 minHeight（见注册段 computeLayoutSize）是固定小
     值，避免 computeSize() 的下限被内容实测峰值顶住，让拖拽能自由收短。 */
  /* naturalPanelHeight() freezes the prompt at its minimum height while
     measuring, so auto-fit always sizes from the fixed chrome + one prompt
     row — the text length can never stretch the bottom to infinity. */
  function fitNode(shrink) {
    try {
      if (node.flags?.collapsed) return;
      /* 任何一次 fit 后顺带校正容器宽度（rAF 内执行，度量的是排版后真值）。 */
      requestAnimationFrame(reconcileWrapperWidth);
      const HEAD = (typeof LiteGraph !== "undefined" && LiteGraph.NODE_TITLE_HEIGHT) || 30;
      const w = (node.size && node.size[0]) || 980;
      const h = (node.size && node.size[1]) || 0;
      const panelH = naturalPanelHeight();
      if (!panelH) return;
      const needH = Math.min(MAX_NODE_H, HEAD + 2 + panelH + 6);
      if (needH > h || (shrink && needH < h)) {
        node.setSize?.([w, Math.ceil(needH)]);
        node.setDirtyCanvas?.(true, true);
        try { node.graph?.setDirtyCanvas?.(true, true); } catch (_) {}
      }
    } catch (e) { /* sizing is cosmetic; never break the panel for it */ }
  }

  /* React only to genuine CONTENT changes, never to the node being resized
     (a ResizeObserver here would fire when the user drags the node smaller and
     make fitNode snap it back). Content appears via child insert/remove, and
     images reveal their height only after decode, caught by a captured 'load'. */
  /* The frontend can clear a DOM widget's width while arranging widgets after
     a file picker closes. The widget lives in the graph's transformed layer,
     so its CSS width must remain in node coordinates, never screen coordinates. */
  let widthObserver = null;
  /* 宽度协调。历史背景：个别前端版本在文件对话框关闭后会清掉 DOM widget 的
     style.width，节点又活在变换层里，宽度一旦丢就塌掉——这个函数当初是兜底
     补写。
     但现在框架自己会写 wrapper 宽度（node.size − 2×widget margin，实测 -20），
     若这里无条件按自己的口径（node.size − 12）再写一遍，就会在「点击选中节点
     → 框架重排写 960」的瞬间被 ResizeObserver 触发，反过来写 968，形成几帧内
     960↔968 互相覆盖——面板左右颤一下的根因（已实测：一次点击产生 4 次交替
     写入）。
     修复：宽度正常时一律不碰，把宽度所有权完全交给框架；只有宽度缺失/被清
     （NaN/0/明显异常）时才兜底补写一次，兜底值也按框架口径（node.size − 20），
     两边一致则永远不会打架。 */
  function reconcileWrapperWidth() {
    try {
      if (node.flags?.collapsed) return;
      const wrap = root.closest?.(".dom-widget");
      if (!wrap || wrap.style.display === "none") return;
      const nodeW = (node.size && node.size[0]) || 980;
      /* 兜底值必须与框架口径逐像素一致（nodeW − 20），不再做 MIN_PANEL_W 钳制：
         钳制会在 nodeW 接近下限时与框架写值拉开 20px 差距，制造新的拉锯。最小
         宽度改由 computeLayoutSize 的 minWidth 负责（拖拽钳制），各司其职。 */
      const want = Math.round(nodeW - 20);
      if (!(want > 0)) return;
      const cur = parseFloat(wrap.style.width);
      /* 与框架一致（±8px 容差，吸收各版本 widget margin 差异）→ 一个字都不写。
         不能沿用旧判据「cur > nodeW*0.5 && cur <= nodeW+1」：那是个半开半闭的
         宽区间，节点被拉宽时旧宽度（如 600）依然落在 (490, 981] 内被判为「正
         常」而永不更新，wrapper 于是被永久锁死在拖动前的宽度上——节点变宽、面
         板宽度不跟随的真因。改成围绕目标值的窄容差才能真正跟上缩放。 */
      if (!Number.isNaN(cur) && Math.abs(cur - want) <= 8) return;
      /* 缺失/被清/异常：按框架口径兜底补写一次（与框架写值一致，不会引发拉锯） */
      const width = want + "px";
      if (wrap.style.width === width) return;
      wrap.style.width = width;
      if (wrap.style.minWidth) wrap.style.minWidth = "";
    } catch (_) { /* Sizing must never break the panel. */ }
  }

  function observeWrapperWidth() {
    const wrap = root.closest?.(".dom-widget");
    if (!wrap || !window.ResizeObserver) return;
    widthObserver?.disconnect();
    widthObserver = new ResizeObserver(reconcileWrapperWidth);
    widthObserver.observe(wrap);
    reconcileWrapperWidth();
  }

  /* 窗口聚焦（文件对话框关闭、Alt-Tab 切回）会触发框架重新排列 widget，
     个别前端版本在这一轮不写容器宽度——这正是"加载素材后窗口缩成一团"
     的触发时机。聚焦后统一校正一次。 */
  const onWinFocus = () => {
    requestAnimationFrame(reconcileWrapperWidth);
    setTimeout(reconcileWrapperWidth, 120);
  };
  window.addEventListener("focus", onWinFocus, true);

  return {
    root,
    fitNode,
    naturalPanelHeight,
    reconcileWrapperWidth,
    observeWrapperWidth,
    /* 供注册段的 onBeforeQueued 调用：面板内部状态（提示词、合并后的槽位）
       只有这里拿得到，注册段只看到节点对象。 */
    audioVaeMissing,
    destroy() {
      window.removeEventListener("focus", onWinFocus, true);
      widthObserver?.disconnect();
      clearInterval(rackPoll);
      ac.remove();
      /* a window listener per node instance would outlive the node */
      window.removeEventListener("paste", onPaste, true);
    },
    load,
    /* Core's route, used when the node is selected but the pointer is not over
       the panel. No hovered slot, so it routes like a loose drop. */
    pasteFile(file) { takePaste(file, null); },
    save() { return JSON.stringify(st); },
    get state() { return st; },
  };
}

/* ============================================================ register */

app.registerExtension({
  name: "cglide.glidecast.legacy",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== NODE_ID) return;
    injectCSS();

    const onCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = onCreated?.apply(this, arguments);

      /* Port labels. The framework localizes common keys (clip -> 剪辑, vae ->
       * 变分自编码器, last_frame -> 末帧), so we pin our own names. Slots expose
       * the raw key in `.name` and the localized text in `.localized_name`.
       * `.label` wins at draw time, so setting it is enough; match either form. */
      const pinLabel = (slot) => {
        if (!slot) return;
        const key = (slot.name || slot.localized_name || "").toLowerCase().replace(/[\s_]+/g, "");
        if (key === "clip" || key === "剪辑") slot.label = "CLIP";
        else if (key === "vae" || key === "变分自编码器") slot.label = "视频VAE";
        /* 音频 VAE：参考音频走独立的音频编码器，与上面「视频VAE」不是同一个
           模型（minimax_h3_audio_vae_fp32）。不改写的话端口上就是裸的
           "audio_vae"，跟视频 VAE 混在一起，接错线的概率极高。 */
        else if (key === "audiovae") slot.label = "音频VAE";
        else if (key === "lastframe" || key === "末帧") slot.label = "尾帧";
        else if (key === "firstframe" || key === "首帧") slot.label = "首帧";
        else if (key === "refs") slot.label = "参考素材";
        else if (key === "prompttext" || key === "prompt_text" || key === "外接提示词") slot.label = "外接提示词";
        else if (key === "帧数") slot.label = "总帧数";
      };
      for (const inp of this.inputs || []) pinLabel(inp);
      for (const out of this.outputs || []) pinLabel(out);

      const data = this.widgets?.find((w) => w.name === "h3_data");
      if (data) {
        /* Hiding a widget has changed convention across frontend versions, so
         * set every mechanism that has ever been honoured:
         *   v1  - computeSize returning zero height
         *   v2  - widget.hidden / computeLayoutSize (it does NOT understand a
         *         fake "hidden" type, which it draws as a plain text row).
         * Never touch .type: an unknown type (e.g. "converted-widget") is not
         * understood by the current frontend and breaks value restore on
         * reload, which clears the saved prompt. */
        data.origType = data.origType || data.type;
        data.origComputeSize = data.computeSize;
        data.hidden = true;
        data.options = Object.assign({}, data.options, { hidden: true });
        data.computeSize = () => [0, -4];
        data.computeLayoutSize = () => ({ minHeight: 0, maxHeight: 0, minWidth: 0 });
        data.label = "";
        data.tooltip = "";
        data.serializeValue = data.serializeValue || (() => data.value);
        if (data.element) {
          Object.assign(data.element.style, {
            display: "none", visibility: "hidden", pointerEvents: "none",
            position: "absolute", left: "-99999px", top: "0",
            width: "0px", height: "0px", opacity: "0", zIndex: "-1",
          });
          data.element.hidden = true;
          data.element.tabIndex = -1;
        }
      }

      const ui = buildUI(this);
      this.h3ui = ui;
      const uiWidget = this.addDOMWidget("h3_ui", "div", ui.root, { serialize: false, hideOnZoom: false });

      /* v2 sizes a DOM widget from computeLayoutSize. 手动拖拽模式：
         minHeight 报固定小值（前端拖拽以 node.computeSize()=各 widget minHeight
         之和做下限钳制，报内容实测峰值会让节点永远拖不到比内容更矮）。
         maxHeight 保持弹性（不设上限）：distributeSpace 只会把 freeWidgetSpace
         那么多空间分给 widget，widget 高度天然被 bodyHeight 封顶、填满节点，
         收短后内容靠 .gcastL 滚动，不塌陷、不诱发放大。 */
      uiWidget.computeLayoutSize = () => {
        return { minHeight: MIN_FLOOR_H, maxHeight: void 0, minWidth: MIN_PANEL_W };
      };

      /* The widget's own wrapper is <div class="dom-widget">, sitting inside
       * .isolate inside #graph-canvas-container. ONLY the dom-widget div may be
       * made transparent -- going any higher reaches the canvas container and
       * freezes the entire graph. */
      requestAnimationFrame(() => {
        const wrap = ui.root.parentElement;
        if (wrap && wrap.classList.contains("dom-widget")) {
          wrap.style.pointerEvents = "none";
        }
        ui.observeWrapperWidth?.();
      });

      /* v2 wraps every DOM widget in a full-size .dom-widget div. Hiding the
       * inner element is not enough -- the wrapper stays, covers the node and
       * swallows every click. Hide the wrappers belonging to THIS node's other
       * widgets only; never touch shared containers. */
      const hideStrayWrappers = () => {
        const mine = ui.root.closest(".dom-widget");
        for (const w of this.widgets || []) {
          if (!w || w === uiWidget || !w.element) continue;
          const wrap = w.element.closest?.(".dom-widget");
          if (wrap && wrap !== mine) {
            wrap.style.display = "none";
            wrap.style.pointerEvents = "none";
          }
        }
      };
      requestAnimationFrame(hideStrayWrappers);
      setTimeout(hideStrayWrappers, 250);
      this.gcastLTidy = hideStrayWrappers;

      ui.load(data ? data.value : "");

      this.size = [980, MIN_H_REF];
      this.setSize?.([980, MIN_H_REF]);
      /* 手动拖拽：只有「新建」的节点才做一次内容自适应，缩掉 MIN_H_REF 这个
         固定初值留下的留白。计时器必须可打断——从工作流加载时 configure() 先
         还原用户存的高度，本计时器随后才到点，不拦就会把用户拖的高度覆盖掉。
         onConfigure 即是「本节点来自已存数据」的判据，见注册段。 */
      this.gcastLFitTimer = setTimeout(() => {
        this.gcastLFitTimer = null;
        this.h3ui?.fitNode?.(true);
      }, 80);
      return r;
    };

    /* ComfyUI's document paste handler calls pasteFile() on the current node
     * when the clipboard holds an image, and spawns a LoadImage node when no
     * node answers. Answering here keeps the paste inside the panel. The
     * hover-based listener in buildUI covers the commoner case where the node
     * is under the pointer but was never selected. */
    nodeType.prototype.pasteFile = function (file) {
      if (!this.h3ui?.pasteFile) return false;
      this.h3ui.pasteFile(file);
      return true;               /* truthy: core treats the paste as handled */
    };

    const onRemoved = nodeType.prototype.onRemoved;
    nodeType.prototype.onRemoved = function () {
      this.h3ui?.destroy?.();
      return onRemoved?.apply(this, arguments);
    };

    /* 排队前自检。ComfyUI 在每次入队前调用节点上的 onBeforeQueued，返回真值即
       中止；这里挂上，手动点「运行」与「渲染全部」两条路都会被拦到（原本只有
       渲染全部里有一段检查，手动排队直接把异常甩给后端）。
       只查「接线缺失」这类纯前端可见、后端必炸的情况，不重复后端能自己报的错。 */
    const onBeforeQueued = nodeType.prototype.onBeforeQueued;
    nodeType.prototype.onBeforeQueued = function () {
      const r = onBeforeQueued?.apply(this, arguments);
      if (r) return r;
      const bad = this.h3ui?.audioVaeMissing?.();
      if (!bad) return;
      app.ui.dialog.show(
        "H3 导演台：缺少音频 VAE\n\n"
        + bad.why + "，但导演台的「audio_vae」输入口没有接线。\n\n"
        + "参考音频走独立的音频 VAE（minimax_h3_audio_vae_fp32），不接也能跑，"
        + "一用到音频就会中断。\n\n"
        + "请加载 minimax_h3_audio_vae_fp32 并接到 audio_vae 口；"
        + "或去掉音频引用 / 取消视频槽位的音轨勾选。");
      return true;
    };

    const onConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function (info) {
      const r = onConfigure?.apply(this, arguments);
      const data = this.widgets?.find((w) => w.name === "h3_data");
      if (this.h3ui && data) this.h3ui.load(data.value);
      if (this.gcastLTidy) setTimeout(this.gcastLTidy, 60);
      /* 高度归用户所有。本节点来自已存数据，configure() 已经还原了 node.size，
         这里不得再动它——历史上这里会 fitNode(true) 把高度压回内容高度，那正是
         「每次刷新都缩回一个固定高度」的根因：它把用户手动拖出的高度当成了需要
         纠正的旧尺寸。同时打断创建时那个还没到点的自适应计时器，否则它会在
         configure() 之后到点、把用户的高度再覆盖一次。 */
      if (this.gcastLFitTimer) {
        clearTimeout(this.gcastLFitTimer);
        this.gcastLFitTimer = null;
      }
      return r;
    };

    const onResize = nodeType.prototype.onResize;
    nodeType.prototype.onResize = function (size) {
      if (size[0] < MIN_PANEL_W) size[0] = MIN_PANEL_W;
      /* 手动拖拽：高度下限由 computeLayoutSize 的 minHeight 报给 computeSize()，
         这里不再额外钳制；宽度容器随拖拽同步一次。 */
      this.h3ui?.reconcileWrapperWidth?.();
      return onResize?.apply(this, arguments);
    };
  },
});
