/* ============================================================
 * 🎨 图像编辑台 (Image Studio) — Qwen-Image 2.1 / MOSS-Image / MiniMax H3 Image
 * ------------------------------------------------------------
 * 视觉与排版复用导演台同一份样式表（CAST_CSS）与同一套类名
 * （gcast-modebar / gcast-field / gcast-pwrap / gcast-chips …），
 * 只换主色（紫）以区别于 H3 家族。
 *
 * 一个节点服务三个模型家族，按接入的 CLIP 自动分流：
 *  · Qwen-Image 2.1（qwen3vl_8b）——图片编辑，参考图是核心能力
 *  · MOSS-Image（qwen3.5_9b）——文生图，参考图只走视觉 token（读过再画）
 *  · MiniMax H3 Image（qwen3vl_32b）——文生图 + 图片编辑，负面用正面清零，
 *    画布上限 8192，改写必须外接独立模型（主编码器截断 50 层不能出字）
 * 前端据此调整控件可用性，判别口径与后端 detect_family 同源：CLIPLoader 的 type。
 *
 * 参考图不走面板槽位：素材统一由 🗂️ H3 媒体架 经 refs 端口喂入，
 * 槽位编号与媒体架格子永久绑定——图片落在哪格，@图片N 就指它。
 * 面板把已接素材展示成提示词名下的 chips（别名优先），点击即插入引用。
 *
 * 与导演台的一处**有意不同**：参考图一律全送，不需要在提示词里
 * 点名——图片编辑改的就是这些图。@图片N 只用来在文字里区分它们。
 * 因此标签栏的「亮」与文案台语义不同：亮 = 提示词里点名了它，不亮 ≠ 不送。
 *
 * 别名（媒体架槽位里起的名字）有**总开关**（面板右上的「别名」按钮，
 * 与 ✍️ H3 文案台同一机制）：同名素材既写别名又写 @图片1 会展开成两次
 * 引用（两个 <imageN>），关掉后只认 @图片N。开关同时管标签栏高亮、
 * 编辑器里的别名高亮/@补全、点标签插进去的写法，以及后端的展开。
 *
 * 外接提示词与导演台同款（模式 A）：prompt_text 接线即外部文本整体
 * 接管**正面**提示词（负面仍归面板），面板转只读镜像 + 徽章，断线即恢复。
 * ============================================================ */
import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { CAST_CSS, makeSelect, sizeLadder, findRatio, promptNodeOf, upstreamTextOf } from "./csglide_cast.js";
import { makePromptEditor } from "./csglide_prompt_editor.js";
/* 拖入 .md 批量读资产提示词：解析/清单/排队提交全在这个模块里，面板只提供挂载点 */
import { installAssetBatch } from "./csglide_asset_batch.js";
/* 别名展开的唯一权威纯函数（与后端 csglide_qwen.expand_aliases 同口径）。
   标签栏亮灭读它，保证「标签栏点亮」==「后端真的转译成 <imageN>」。 */
import { expandAliasesText } from "./csglide_ref_text.js";
import { onRackChange, rackSlotsOf, rackNodeOf, emitDeskChange } from "./bz_rack.js";

const NODE_ID = "CSGlideImageCastCS";
const MIN_W = 620, MIN_H = 620;
const STEP = 32, MAX_SIDE = 4096, MAX_SIDE_H3 = 8192;

/* 模型家族。前端读 CLIP 端口上游 CLIPLoader 的 type widget 判定，
   与后端 detect_family 同源（都源于 CLIPLoader 的 type）。读不到就
   按 Qwen 模式显示——参考图区照常可用，运行时若真是 MOSS/H3 由后端兜底。 */
const FAM_MOSS = "moss";
const FAM_QWEN21 = "qwen21";
const FAM_H3IMAGE = "h3image";

/* 改写用的默认系统提示词（与后端 MOSS_REWRITE_SYSTEM 同源；面板留空时
   由后端按模型家族给默认）。 */
const REWRITE_SYSTEM_DEFAULT =
  "你是 MOSS-Image 的提示词改写器。把用户的一段描述改写成一段**中文画面描述**，"
  + "供文生图模型直接使用。\n"
  + "规则：\n"
  + "- 只输出改写后的描述文本本身，不要标题、不要解释、不要列表、不要 Markdown。\n"
  + "- 保留用户指定的主体、数量、动作、场景、风格、氛围、色彩，不得擅自增删。\n"
  + "- 用户没写的地方补具体的视觉信息：取景、视角、光照、材质、配色。\n"
  + "- 只写画面里看得见的东西：不写声音、气味、背景故事、创作意图。\n"
  + "- 不加画质关键词（masterpiece、8K、best quality 之类），不写负面提示词。\n"
  + "- 中文，1～3 个自然段，200～350 字。";

/* 画布比例。每族基数是该比例的**顶档**（4K 级），逐档递减的阶梯由 sizeLadder
   生成；面积上限 = 顶档自身（4096×2304，16:9 的 4K DCI 尺寸）。
   Qwen Image 2.1 的编辑输出可以到 4K，再往上面积翻倍，注意力与耗时是平方级
   上去的，所以不再放宽。
   注意 32 对齐这条硬约束：3840×2160 的 2160 不是 32 的倍数（2160/32=67.5），
   送进后端会被吸附成 2144——面板上写 2160、实际跑 2144 是静默不一致。所以
   4K 档取 32 对齐且**比例精确**的组合（16:9 = 4096×2304，正好是 16/9）。 */
const MAX_PIXELS = 4096 * 2304;
/* 短边阶梯（必须全是 32 的倍数）。3072 / 2592 / 2368 只会落在方图与 4:3、3:2
   上——其余比例用这些短边算出的长边面积超顶，会被面积上限滤掉。 */
const SHORT_EDGES = [3072, 2592, 2368, 2304, 1920, 1728, 1440, 1280, 1152,
                     1024, 896, 768, 640, 512, 384, 320];
const RATIOS = [
  { label: "21:9", w: 4032, h: 1728 },
  { label: "16:9", w: 4096, h: 2304 },
  { label: "3:2",  w: 3552, h: 2368 },
  { label: "4:3",  w: 3456, h: 2592 },
  { label: "1:1",  w: 3072, h: 3072 },
  { label: "3:4",  w: 2592, h: 3456 },
  { label: "2:3",  w: 2368, h: 3552 },
  { label: "9:16", w: 2304, h: 4096 },
];
RATIOS.forEach((r) => {
  r.sizes = sizeLadder(r, SHORT_EDGES, MAX_PIXELS, MAX_SIDE);
  r.sizes.sort((a, b) => (b.w * b.h) - (a.w * a.h));
});

/* H3 Image 画布比例：顶档到 6272×2688（官方推荐上限），硬顶 8192。
   模型调优面积 ~4MP（2048²），但支持更大；阶梯往下覆盖到 320。 */
const H3_MAX_PIXELS = 6272 * 2688;
const H3_SHORT_EDGES = [4096, 3584, 3072, 2880, 2560, 2304, 2048, 1792, 1536,
                        1280, 1024, 896, 768, 640, 512, 384, 320];
const H3_RATIOS = [
  { label: "21:9", w: 6272, h: 2688 },
  { label: "16:9", w: 5120, h: 2880 },
  { label: "3:2",  w: 4800, h: 3200 },
  { label: "4:3",  w: 4096, h: 3072 },
  { label: "1:1",  w: 4096, h: 4096 },
  { label: "3:4",  w: 3072, h: 4096 },
  { label: "2:3",  w: 3200, h: 4800 },
  { label: "9:16", w: 2880, h: 5120 },
];
H3_RATIOS.forEach((r) => {
  r.sizes = sizeLadder(r, H3_SHORT_EDGES, H3_MAX_PIXELS, MAX_SIDE_H3);
  r.sizes.sort((a, b) => (b.w * b.h) - (a.w * a.h));
});

const snap = (v) => Math.max(STEP, Math.min(MAX_SIDE, Math.round((+v || 0) / STEP) * STEP));
/* 只对齐不夹上限：load() 用它保留存档原值（H3 的 6000 不被截成 4096） */
const align32 = (v) => Math.max(STEP, Math.round((+v || 0) / STEP) * STEP);

/* 参考尺寸（最长边上限）的档位与缺省值；缺省与后端 REF_CAP_DEFAULT 同值 */
const REF_CAPS = [0, 512, 768, 1024, 1280, 1536, 2048, 2560, 3072, 4096];
const REF_CAP_DEFAULT = 1024;

/* 跟随图片1 时画布长边的缺省值（px）。0 = 不限：用图片原尺寸（4096 硬顶仍在）。 */
const REF_LONG_DEFAULT = 1024;

/* 只补导演台样式表里没有的：别名 chips 的缩略图 + 提示词区的高度策略 */
const QWEN_CSS = `
.gq { --h3-accent:#a97bff; --h3-accent-dim:#a97bff26; }
/* 下拉菜单与 @ 补全列表挂在 body 上，拿不到 .gq 的局部变量，主色走 data-mode 传递 */
.gcast-menu[data-mode="qwen"] { --h3-accent:#a97bff; }
.gcast-ac[data-mode="qwen"] { --h3-accent:#a97bff; --h3-accent-dim:#a97bff26; }
/* 导演台表单行里的数字框定宽 46px，是给 4 卡的窄列调的；画布尺寸要放得下
   4 位数（4096）加右侧的微调箭头，所以加宽并左对齐。spinner 保留——它是
   尺度的微调入口（每格 32，与后端对齐粒度一致）。 */
.gq .gcast-field .gcast-ctl input[type="number"] { width:88px; padding:0 2px 0 6px; text-align:left; }
/* 导演台的 .gcast-row 是横排侧栏（flex:1 1 240px 管宽度）；本面板把它直接
   放进纵向根容器，同一条 flex 就变成管高度——画布行被纵向撑开吃掉全部剩余
   空间，缝隙出现在画布与提示词之间、下方内容被挤出节点底。这里改回内容高，
   让「吃剩余高度」的只剩提示词编辑区（与导演台的意图一致）。 */
.gq .gcast-row { flex:0 0 auto; max-width:none; }
/* 提示词是本节点的主要内容，吃掉节点剩余高度：节点拖多高编辑区就多大，
   同时给一个可用下限，免得节点收矮后编辑区只剩一条缝 */
.gq .gcast-pwrap { flex:1 1 auto; min-height:0; }
.gq .gcast-ed.prompt { flex:1 1 auto; min-height:150px; }
/* 片子级常驻单行框：从提示词框的 min-height 里让出 40px 换这一行，
   净高度基本不变，不会把下面的负面提示词挤出去 */
.gq .gq-grow { flex:0 0 auto; }
.gq .gq-global { width:100%; box-sizing:border-box; font:inherit; font-size:12px; line-height:1.35;
  color:var(--h3-txt); background:var(--h3-well); border:1px solid var(--h3-line);
  border-radius:6px; padding:4px 8px; outline:none; }
.gq .gq-global:focus { border-color:var(--h3-accent); }
.gq .gq-global::placeholder { color:var(--h3-dim); }
/* 负面提示词是次要输入，固定矮高度，不跟正提示词抢节点高度 */
.gq .gcast-ed.neg { flex:0 0 auto; min-height:54px; }
.gq-hint { color:var(--h3-dim); font-size:10.5px; line-height:1.45; }
/* 别名总开关：与文案台 d-btn 同一种画法（描边胶囊，开 = 主色描边 + 淡底），
   margin-left:auto 把它顶到提示词标题行的最右端。 */
.gq .gq-aliasbtn { all:unset; pointer-events:auto; cursor:pointer; margin-left:auto;
  font-size:10px; padding:2px 8px; border-radius:20px; white-space:nowrap;
  border:1px solid var(--h3-line); background:var(--h3-raise); color:var(--h3-dim); }
.gq .gq-aliasbtn:hover { border-color:var(--h3-accent); color:var(--h3-accent); }
.gq .gq-aliasbtn.on { border-color:var(--h3-accent); color:var(--h3-accent);
  background:var(--h3-accent-dim); }
/* 置灰：MOSS 模式下的参考图控件、关掉的改写区。用不透明度而不是 display:none
   ——控件保留在原位，换模型时不用重填，面板高度也不会跳。 */
.gq .gq-off { opacity:.42; }
.gq .gq-off .gcast-ctl, .gq .gq-off .gcast-chips { pointer-events:none; }
/* 改写区：系统提示词框 + 输出上限。 */
.gq .gq-rewrite { margin-top:8px; padding-top:8px;
  border-top:1px solid var(--h3-line); }
.gq .gq-rewrite .gcast-phead { display:flex; align-items:center; gap:6px; }
.gq textarea.gcast-rwsys { width:100%; box-sizing:border-box; resize:vertical;
  min-height:64px; padding:6px 8px; font:inherit; font-size:11px; line-height:1.5;
  color:var(--h3-txt); background:var(--h3-well);
  border:1px solid var(--h3-line); border-radius:6px; }
.gq textarea.gcast-rwsys:focus { outline:none; border-color:var(--h3-accent); }
.gq textarea.gcast-rwsys:disabled { opacity:.5; }
`;

let cssInjected = false;
function injectCSS() {
  if (cssInjected) return;
  if (!document.getElementById("gcast-css")) {
    const base = document.createElement("style");
    base.id = "gcast-css";
    base.textContent = CAST_CSS;
    document.head.append(base);
  }
  const s = document.createElement("style");
  s.id = "gq-css";
  s.textContent = QWEN_CSS;
  document.head.append(s);
  cssInjected = true;
}

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function viewURL(file, thumb) {
  if (!file) return "";
  const i = file.lastIndexOf("/");
  const sub = i >= 0 ? file.slice(0, i) : "";
  const name = i >= 0 ? file.slice(i + 1) : file;
  /* thumb 给了数字 = 走 /cglide/thumb 256px 缩略图（20261101），与媒体架
     同一套磁盘缓存 + ETag；同 size 同 URL 和媒体架共享一份缓存。 */
  if (thumb) {
    return api.apiURL(`/cglide/thumb?filename=${encodeURIComponent(name)}`
      + `&subfolder=${encodeURIComponent(sub)}&size=${thumb}`);
  }
  return api.apiURL(`/view?filename=${encodeURIComponent(name)}&subfolder=${encodeURIComponent(sub)}&type=input`);
}

/* 小图口子统一走缩略图（20261101）：素材 chip / @补全 / 悬停预览原来拉
   原图，4K 素材解码 ≈46MB/张。视频不能走缩略图端点（后端 PIL 415），
   按扩展名回原图 —— 编辑器里 img/video 分支共用同一个 view，得在这里分。 */
const IMG_EXT = new Set(["png", "jpg", "jpeg", "webp", "gif", "bmp"]);
function previewURL(file) {
  const f = String(file || "");
  const ext = f.split(".").pop().toLowerCase();
  return IMG_EXT.has(ext) ? viewURL(f, 256) : viewURL(f);
}

/* 别名（命名引用）与后端 csglide_qwen.py 同一套口径：全角空格归一、
   单字不注册、含 @ 或反斜杠不行、撞内置词不行。这里只负责「取首个合法
   别名」给 chips 做显示与插入；真正的展开在后端做（后端是权威）。 */
const ALIAS_SPLIT = /[,，、;；]+/;
const ALIAS_MIN = 2, ALIAS_MAX = 40;
const BUILTIN_ALIAS = /^(?:图片\d+|视频音频\d+|视频\d+|音频\d+)$/i;
const normSpace = (s) => (s ? s.replace(/\u3000/g, " ") : s);
function aliasPick(v) {
  const raw = Array.isArray(v) ? v.filter((x) => typeof x === "string").join(",") : v;
  if (typeof raw !== "string" || !raw.trim()) return "";
  for (const p of raw.split(ALIAS_SPLIT)) {
    const a = normSpace(p.trim());
    const at = a.startsWith("@");
    const name = at ? a.slice(1) : a;
    if (name.length >= ALIAS_MIN && name.length <= ALIAS_MAX
      && !/[@\\]/.test(name) && !BUILTIN_ALIAS.test(name)) {
      return (at ? "@" : "") + name;
    }
  }
  return "";
}

function buildUI(node) {
  const root = el("div", "gcast gq");
  const st = {
    prompt: "", negative_prompt: "",
    /* 片子级（LoRA 触发词）。跟其它面板状态一样进 qwen_data——
       只存 node.properties 的话刷新后没有回填路径（值在、框是空的），
       而且改它不会让工作流变「已修改」，自动保存也不记。
       留空 = 不拼；真正的拼接在提交对象上做（见 csglide_asset_batch.js）。 */
    global: "",
    canvas: { w: 1024, h: 1024 },   // 画布始终是明确尺寸，缺省官方默认 1024²
    canvas_from_ref: false,         // 画布跟随图片1尺寸（后端取图片1原尺寸）
    ref_long: REF_LONG_DEFAULT,     // 跟随时的画布长边（px），只缩不放；0 = 用图片原尺寸
    ref_cap: REF_CAP_DEFAULT,       // 参考图最长边上限（px）；0 = 原尺寸（不限）
    alias: true,                    // 别名引用开关（与文案台同机制）；关 = 只认 @图片N
    rewrite: false,                 // 提示词改写开关
    rewrite_system: "",             // 改写的系统提示词；空 = 用模型家族的默认
    rewrite_max_length: 512,        // 改写输出上限（token）
    rewrite_model: "",              // 改写模型文件名（同文案台机制）；空 = Qwen/MOSS 用主 CLIP
  };
  let dataWidget = null;
  let batch = null;               // 批量导入 / 片子级面板，buildUI 末尾装配

  const commit = () => {
    if (!dataWidget) dataWidget = node.widgets?.find((w) => w.name === "qwen_data");
    if (dataWidget) dataWidget.value = JSON.stringify(st);
    node.setDirtyCanvas(true, true);
  };

  /* ---------------- header ---------------- */
  const head = el("div", "gcast-modebar");
  const headLabel = el("div", "gcast-label", "图像编辑台");
  const headBadge = el("div", "gcast-need");
  head.append(headLabel, headBadge);

  /* 模型家族：读 CLIP 端口上游 CLIPLoader 的 type widget。
     判别口径与后端 detect_family 同源（都源于 CLIPLoader 的 type），
     前端只用来决定参考图区置不置灰——真判错了运行时后端会兜底。 */
  function clipNodeOf(n) {
    const inputs = n.inputs || [];
    const inp = inputs.find((s) => s && (s.name === "clip" || s.type === "CLIP") && s.link != null);
    const graph = (typeof app !== "undefined" && app && app.graph) || null;
    if (inp && graph && graph.links != null) {
      const link = graph.links[inp.link];
      if (link) {
        const up = graph.getNodeById ? graph.getNodeById(link.origin_id) : null;
        if (up) return up;
      }
    }
    return n.getInputNode ? n.getInputNode("clip") : null;
  }

  function familyOf() {
    const up = clipNodeOf(node);
    const t = (up && up.widgets && up.widgets.find((w) => w.name === "type")?.value) || "";
    if (t === "moss_image") return FAM_MOSS;
    if (t === "minimax") return FAM_H3IMAGE;
    return FAM_QWEN21;
  }

  /* 家族感知的画布上限与比例表：H3 到 8192，其余 4096。
     shadow 模块级 snap——buildUI 内所有 snap 调用自动用当前家族的上限。 */
  const maxSide = () => familyOf() === FAM_H3IMAGE ? MAX_SIDE_H3 : MAX_SIDE;
  const snap = (v) => Math.max(STEP, Math.min(maxSide(), Math.round((+v || 0) / STEP) * STEP));
  const activeRatios = () => familyOf() === FAM_H3IMAGE ? H3_RATIOS : RATIOS;
  const activeMaxPixels = () => familyOf() === FAM_H3IMAGE ? H3_MAX_PIXELS : MAX_PIXELS;

  /* ---------------- 参考素材：来自 🗂️ H3 媒体架（refs 端口）----------------
     面板不自带上传槽位——素材统一在媒体架管理，一个媒体架可以喂多个节点。
     槽位编号与媒体架永久绑定：图片落在哪个格，@图片N 就指它。已接素材
     展示成提示词名下的 chips（别名优先），点击即把引用写进提示词。
     rackNodeOf / rackSlotsOf 走 bz_rack 共享口径：先读媒体架内存真值
     （gmr.st），再退回 widget——rack_data 只存引用，直读 widget 会拿空架。 */
  function rackImages() {
    return rackSlotsOf(node).slots.images;
  }

  const chips = el("div", "gcast-chips");
  const refRead = el("div", "gcast-read");
  const chipEls = new Map();          // 规范 token → chip 按钮（打字时只改 class）

  function renderChips() {
    chips.replaceChildren();
    chipEls.clear();
    const h3 = (familyOf() === FAM_H3IMAGE);
    let ord = 0;
    rackImages().forEach((slot, i) => {
      if (!slot || !slot.file) return;
      ord += 1;
      const token = `@图片${i + 1}`;
      const name = aliasPick(slot.alias);        // 显示优先用别名（认得出是哪张图）
      const tag = h3 ? "引用后送" : `<image${ord}>`;
      const chip = el("button", "gcast-chip");
      const th = el("img");
      th.src = viewURL(slot.file, 256);
      chip.append(th, el("span", "lbl", name || token), el("span", "sub", tag));
      chip.dataset.tip = h3
        ? `插入 ${name || token}（即 ${token}，提示词引用后送编码）\n${slot.file}`
        : `插入 ${name || token}（即 ${token}，编码器看到 ${tag}）\n${slot.file}`;
      chip.onclick = () => insertToken((st.alias && name) ? name : token);
      chips.append(chip);
      chipEls.set(token, chip);
    });
    if (!ord) {
      chips.append(el("span", "gq-hint",
        "未接媒体架——把 🗂️ H3 媒体架 的输出接到「参考素材」端口，素材会出现在这里。"));
    }
    refRead.textContent = ord ? `已接 ${ord} 张` : "未接";
    paintChips();
  }

  /* 亮 = 提示词里点名了它。判定走共享纯函数：先把别名展开（开关关就不展开），
     再数剩下的 @图片N —— 与后端 expand_aliases + transcribe_prompt 同一条路，
     「标签栏亮」==「后端真转译成 <imageN>」，不会出现"写着 @图片1 却不亮"。
     注意本节点与文案台的语义不同：参考图一律全送，不亮不代表不送。 */
  function usedTokens() {
    let t = [edPos.getText(), edNeg.getText()].join("\n");
    if (st.alias) t = expandAliasesText(t, { images: rackImages() });
    return new Set(t.match(/@图片\d+/g) || []);
  }

  function paintChips() {
    const used = usedTokens();
    const h3 = (familyOf() === FAM_H3IMAGE);
    chipEls.forEach((chip, token) => {
      const on = used.has(token);
      chip.classList.toggle("on", on);
      const offMsg = h3 ? "提示词里没提到（H3 不送未引用的图）" : "提示词里没提到（仍会作为参考图送出）";
      chip.title = `${on ? "已在提示词里提到" : offMsg}`
        + ` · 点一下插到光标处\n${chip.dataset.tip}`;
    });
  }

  /* 记录表：媒体架槽位 → 高亮 / @补全 / 悬停预览共用同一份口径
     （与后端 alias_table 对称：别名不带 @，写 @别名 的槽位是 strict）。
     一条素材一条记录：别名只是这条素材的友好名，不再额外生成「规范名」记录，
     否则菜单里一条素材会占两行、看起来像素材翻倍。 */
  function vocab() {
    const out = [];
    rackImages().forEach((slot, i) => {
      if (!slot || !slot.file) return;
      const name = `@图片${i + 1}`;
      /* 开关关时别名整个不给：编辑器便不再把名字高亮成引用、也不进 @ 补全 */
      const al = st.alias ? aliasPick(slot.alias) : "";
      const bare = al ? al.replace(/^@/, "") : "";
      out.push({
        name,                              // 规范引用，永远可写
        alias: bare,                       // 友好名（可能为空）
        strict: al ? al.startsWith("@") : false,
        file: slot.file,
        label: bare || name,               // 菜单里显示的名字：有别名用别名
        note: bare ? name : slot.file.split("/").pop(),
      });
    });
    return out;
  }

  /* 媒体架变动后：chips 与两个编辑器的高亮一起跟上 */
  function refsChanged() {
    renderChips();
    edPos.refresh();
    edNeg.refresh();
  }

  /* 20261012 方案B 后这里是全包里**唯一保留的定时器**（2.5s）：
     媒体架变化已由 rack-change 事件即时驱动（见下）；本 tick 只剩一个客观
     无事件源的脏检查——**外接上游文本节点改字**（LiteGraph 不提供跨节点
     widget changed 广播）。内部全部按原文签名去重，没变就是几次字典/字符串
     比对，折叠或页面隐藏时直接早退，不再有任何 DOM 成本。 */
  let rackSeen = null, extSeen = null, famSeen = null;
  function pollOnce() {
    if (node.flags?.collapsed || document.hidden) return;
    const rackRaw = rackSlotsOf(node).raw;
    if (rackRaw !== rackSeen) {
      rackSeen = rackRaw;
      refsChanged();
    }
    const up = promptNodeOf(node);
    const key = up ? "W\u0001" + upstreamTextOf(up) : "";
    if (key !== extSeen) { extSeen = key; paintExt(); }
    /* 换了 CLIP 加载节点（模型家族变了）→ 徽标与参考图置灰跟着换。
       LiteGraph 没有跨节点连线变更广播，只能在这个 tick 里查。 */
    const fam = familyOf();
    if (fam !== famSeen) {
      const prev = famSeen;
      famSeen = fam;
      /* 切到 H3 时画布还是 Qwen 默认 1024² → 自动跟到官方默认 2048²。
         只在家族切换时做一次，用户之后手动设 1024 不会被覆盖。 */
      if (fam === FAM_H3IMAGE && prev !== FAM_H3IMAGE
          && st.canvas.w === 1024 && st.canvas.h === 1024) {
        st.canvas = { w: 2048, h: 2048 };
        commit();
      }
      refresh();
    }
  }
  const rackPoll = setInterval(pollOnce, 2500);
  /* 媒体架 commit 即时广播：chips/高亮立刻刷新，零等待。
     只认自己接线的那台媒体架（20261012 联动提速）。 */
  const offRackEvt = onRackChange((d) => {
    if (node.flags?.collapsed) return;
    const w = rackNodeOf(node);
    if (w && d.node != null && w.id !== d.node) return;
    pollOnce();
  });

  /* ---------------- 设置：画布 / 参考尺寸 ---------------- */
  const row = el("div", "gcast-row");
  const field = (label, ctl, read) => {
    const f = el("div", "gcast-field");
    f.append(el("span", "gcast-flabel", label), ctl);
    if (read) f.append(read);
    return f;
  };

  /* MOSS 模式：编码器无视觉塔，参考图不成立。控件**保留但置灰**——
     保留是为了换模型时不用重填，置灰是明确告知「这里现在不生效」。
     置灰用 .gq-off（降低不透明度 + 禁用指针），不是 display:none，
     免得面板高度随模型切换跳动。
     变量在下面各自声明（chips / fFollow / fRef / selRef / inRef /
     cbFollow / refNote / followNote），本函数只在它们就绪后调用。 */
  let refOff = () => false;

  const canvasCtl = el("div", "gcast-ctl");
  const selRatio = makeSelect(node, "画布比例", "qwen");
  const selSize = makeSelect(node, "该比例下的画布尺寸", "qwen");
  const inW = el("input"); inW.type = "number"; inW.step = STEP; inW.min = STEP; inW.max = MAX_SIDE;
  const inH = el("input"); inH.type = "number"; inH.step = STEP; inH.min = STEP; inH.max = MAX_SIDE;
  inW.title = inH.title = "画布宽/高（像素，按 32 对齐）。↑↓ 微调，每格 32；改这里等于切到自定义尺寸。";
  const canvasNote = el("div", "gcast-read");
  canvasCtl.append(selRatio.el, selSize.el, inW, el("span", "gcap dim-x", "\u00d7"), inH);
  const fCanvas = field("画布", canvasCtl, canvasNote);
  row.append(fCanvas);

  /* ---------------- 设置：跟随图片1（画布来源）----------------
     独立的开关，不混进上面的比例下拉——比例下拉管的是「画面形状」，
     这一项管的是「尺寸从哪来」。勾上后：取图片1的原图比例，按下面填的
     画布长边等比缩小，就不用手敲宽高了。 */
  const followCtl = el("div", "gcast-ctl");
  const cbFollow = el("input"); cbFollow.type = "checkbox";
  cbFollow.title = "勾选后画布不再手填：运行时取图片1（第一个参考图槽位）的原图比例，"
    + "再按右侧的画布长边等比缩小。";
  const cbLabel = el("span", "gq-cblbl", "画布用图片1尺寸");
  cbLabel.style.cssText = "font-size:11px; white-space:nowrap; color:var(--h3-txt);";
  const inLong = el("input"); inLong.type = "number";
  inLong.step = STEP; inLong.min = 0; inLong.max = MAX_SIDE;
  inLong.title = "画布长边（像素，按 32 对齐）。↑↓ 微调，每格 32。"
    + "只缩不放：图片比这个值大就等比缩到这个值，比它小就按原尺寸出图；填 0 = 不限。";
  const followNote = el("div", "gcast-read");
  followCtl.append(cbFollow, cbLabel, el("span", "gcap dim-x", "长边"), inLong,
    el("span", "gcap dim-x", "px"));
  const fFollow = field("跟随图片1", followCtl, followNote);
  row.append(fFollow);

  function paintFollow() {
    cbFollow.checked = st.canvas_from_ref;
    inLong.disabled = !st.canvas_from_ref;
    inLong.value = String(st.ref_long);
    const hardMax = maxSide();
    followNote.innerHTML = st.canvas_from_ref
      ? (st.ref_long
        ? `<b>长边 ≤ ${st.ref_long} px</b> · 更大的图等比压下来`
        : `<b>原尺寸</b> · 不缩放（${hardMax} 硬顶）`)
      : `未启用 · 画布用上面的尺寸`;
  }

  /* ---------------- 设置：参考尺寸（最长边上限）----------------
     这一项管的是**参考图怎么进编码器**：素材是 4K 大图时按上限等比压下来，
     比上限小的原样送（不放大——放大只多花显存换不出细节）。数值是**最长边**，
     不是短边、也不是面积：一张 4000×3000 配 1024，编出来是 1024×768。 */
  const refCtl = el("div", "gcast-ctl");
  const selRef = makeSelect(node, "参考图最长边上限", "qwen");
  const inRef = el("input"); inRef.type = "number"; inRef.step = STEP; inRef.min = 0; inRef.max = MAX_SIDE;
  inRef.title = "参考图最长边上限（像素，按 32 对齐）。↑↓ 微调，每格 32。"
    + "超过上限的图等比压到上限，没超过的按原尺寸送；两侧都不放大。";
  const refNote = el("div", "gcast-read");
  refCtl.append(selRef.el, inRef);
  const fRef = field("参考尺寸", refCtl, refNote);
  row.append(fRef);

  selRef.setOptions(REF_CAPS.map((v) => ({
    label: v ? `${v} px` : "原尺寸",
    value: String(v),
    note: v ? "最长边" : "不限",
  })));

  /* 画布永远是一个明确尺寸：比例档位或自定义，缺省官方默认 1024² */
  function paintRatioOptions() {
    selRatio.setOptions(activeRatios().map((r) => ({ label: r.label, value: r.label, note: `${r.w} x ${r.h}` }))
      .concat([{ label: "自定义", value: "custom" }]));
  }
  paintRatioOptions();

  function paintCanvas() {
    /* 跟随模式下画布由运行时决定：比例/尺寸/宽高全部停摆并置灰，避免
       「上面显示了 1024²、实际跑的是图片1尺寸」这种两处打架的错觉。 */
    selRatio.disabled = selSize.disabled = inW.disabled = inH.disabled = st.canvas_from_ref;
    if (st.canvas_from_ref) {
      inW.value = ""; inH.value = "";
      canvasNote.innerHTML = `<b>跟随图片1</b> · 长边 ${
        st.ref_long ? `≤ ${st.ref_long} px` : "不限"}，运行时算出`;
      return;
    }
    const w = st.canvas.w, h = st.canvas.h;
    const ratios = activeRatios();
    const fam = findRatio(w, h, ratios);
    selRatio.value = fam ? fam.label : "custom";
    if (fam) {
      const options = fam.sizes.map((z) => ({ label: `${z.w} x ${z.h}`, value: `${z.w}x${z.h}` }));
      const key = `${w}x${h}`;
      /* 手动改宽高后落在阶梯之外时，把它作为一项补进下拉，别让读出空白 */
      if (!options.some((o) => o.value === key)) {
        options.push({ label: `${w} x ${h}`, value: key, note: "自定义" });
      }
      selSize.setOptions(options);
      selSize.value = key;
      selSize.disabled = false;
    } else {
      selSize.setOptions([{ label: "自定义尺寸", value: "custom" }]);
      selSize.value = "custom";
      selSize.disabled = true;
    }
    inW.value = String(w);
    inH.value = String(h);
    const mp = (w * h / 1e6).toFixed(2);
    canvasNote.innerHTML = `<b>${mp} MP</b> · ${(w / h).toFixed(2)}:1`;
    if (w * h > activeMaxPixels()) {
      canvasNote.insertAdjacentHTML("beforeend", ' · <span class="gcast-warn">面积偏大</span>');
    }
  }

  /* 参考尺寸读出：这一项不改变画布，只决定参考图进编码器时的最大边长。
     H3 模式用固定短边缩放（视觉 1024 / VAE [1024,2048]），此项不生效。 */
  function paintRef() {
    const cap = st.ref_cap;
    selRef.value = String(cap);
    inRef.value = String(cap);
    inRef.disabled = !cap;                 // 0 = 原尺寸，此时输入框没有意义
    refNote.innerHTML = cap
      ? `<b>最长边 ≤ ${cap} px</b> · 更大的图等比压下来，更小的原样送`
      : `<b>原尺寸</b> · 不设上限（4K 大图会照原样进编码器）`;
  }

  /* 模型家族决定的控件可用性：
     MOSS — 参考图只走视觉 token（读过再画），chips/跟随/参考尺寸全置灰
     H3   — 参考图正常用，但参考尺寸（最长边上限）不生效（H3 用固定短边缩放），
            负面提示词不生效（H3 用正面清零）
     Qwen — 全部正常 */
  refOff = () => {
    const fam = familyOf();
    const moss = (fam === FAM_MOSS);
    const h3 = (fam === FAM_H3IMAGE);
    chips.classList.toggle("gq-off", moss);
    fFollow.classList.toggle("gq-off", moss);
    fRef.classList.toggle("gq-off", moss || h3);
    cbFollow.disabled = moss;
    selRef.disabled = moss || h3;
    inRef.disabled = moss || h3 || !st.ref_cap;
    if (moss) {
      refNote.innerHTML = "<b>MOSS-Image 不支持参考图</b> · 编码器无视觉塔";
      followNote.innerHTML = "MOSS-Image 无参考图 · 用上面的画布尺寸";
    } else if (h3) {
      refNote.innerHTML = "<b>H3 固定短边缩放</b> · 视觉 1024 / VAE [1024, 2048]，此项不生效";
      paintFollow();
    } else {
      paintRef();
      paintFollow();
    }
    return moss;
  };

  /* H3 负面提示词置灰：H3 用正面清零作负面，面板负面框不参与。 */
  function paintNeg() {
    const h3 = (familyOf() === FAM_H3IMAGE);
    nHead.classList.toggle("gq-off", h3);
    edNeg.node.classList.toggle("gq-off", h3);
    edNeg.setReadonly(h3);
    if (h3) {
      nHead.title = "H3 Image 用正面清零作负面，此处不参与编码";
    } else {
      nHead.title = "";
    }
  }

  /* 画布/参考尺寸改动只影响尺寸相关的控件与读出；chips 与编辑器不动 */
  const refresh = () => {
    inW.max = inH.max = inLong.max = String(maxSide());
    paintRatioOptions();
    paintFollow(); paintCanvas(); paintRead(); paintRef(); refOff(); paintNeg(); paintHint(); paintRewrite();
  };

  selRatio.onchange = (v) => {
    if (v === "custom") { st.canvas = { w: snap(inW.value), h: snap(inH.value) }; refresh(); commit(); return; }
    const fam = activeRatios().find((r) => r.label === v);
    if (!fam) return;
    /* 换比例时留在原来那一档（面积最接近的一档），不要每次跳回最大 */
    const cur = st.canvas.w * st.canvas.h;
    const rung = fam.sizes.reduce((best, z, i) =>
      Math.abs(z.w * z.h - cur) < Math.abs(fam.sizes[best].w * fam.sizes[best].h - cur) ? i : best, 0);
    st.canvas = { w: fam.sizes[rung].w, h: fam.sizes[rung].h };
    refresh(); commit();
  };
  selSize.onchange = (v) => {
    if (v === "custom") return;
    const [w, h] = v.split("x").map(Number);
    st.canvas = { w, h };
    refresh(); commit();
  };
  /* 预设比例下宽高锁在一起：改宽带动高，比例不会漂；只有自定义才各自独立 */
  const activeRatio = () => findRatio(st.canvas.w, st.canvas.h, activeRatios());
  inW.onchange = () => {
    const fam = activeRatio();
    const w = snap(inW.value);
    st.canvas = { w, h: fam ? snap(w / (fam.w / fam.h)) : snap(inH.value) };
    refresh(); commit();
  };
  inH.onchange = () => {
    const fam = activeRatio();
    const h = snap(inH.value);
    st.canvas = { w: fam ? snap(h * (fam.w / fam.h)) : snap(inW.value), h };
    refresh(); commit();
  };
  /* 上下箭头微调：键盘 ↑↓ 自己接。原生在部分浏览器上要等 blur 才派 change，
     那样比例锁、读出与快照全都不跟；自己走一遍 onchange，每格 32（与后端
     对齐粒度一致）。鼠标点 spinner 走原生 → change → 同一条路径。 */
  const nudge = (box) => (e) => {
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
    e.preventDefault();
    e.stopPropagation();
    box.value = String(snap((+box.value || 0) + (e.key === "ArrowUp" ? STEP : -STEP)));
    box.onchange();
  };
  inW.addEventListener("keydown", nudge(inW));
  inH.addEventListener("keydown", nudge(inH));

  /* 参考尺寸：0 在下拉里是「原尺寸」，输入框里也认 0（清空后打 0 即可回到不限） */
  const refCapOf = (v) => { const n = +v; return n > 0 ? snap(n) : 0; };
  selRef.onchange = (v) => { st.ref_cap = refCapOf(v); refresh(); commit(); };
  inRef.onchange = () => { st.ref_cap = refCapOf(inRef.value); refresh(); commit(); };
  inRef.addEventListener("keydown", nudge(inRef));

  /* 跟随图片1：0 = 用原尺寸画布（上限由 4096 硬顶兜着），与「参考尺寸」同口径 */
  const longCapOf = (v) => { const n = +v; return n > 0 ? snap(n) : 0; };
  cbFollow.onchange = () => { st.canvas_from_ref = cbFollow.checked; refresh(); commit(); };
  inLong.onchange = () => { st.ref_long = longCapOf(inLong.value); refresh(); commit(); };
  inLong.addEventListener("keydown", nudge(inLong));

  /* ---------------- 提示词 / 负面提示词 ----------------
     用富文本编辑器而不是 textarea：框内要标出 @引用 的命中状态、要能 @ 弹
     补全、要能悬停看素材——这三件都是纯文本控件做不到的。 */
  const pWrap = el("div", "gcast-pwrap");
  pWrap.style.cssText = "display:flex; flex-direction:column; gap:6px;";
  const pHead = el("div", "gcast-phead");
  pHead.append(el("div", "gcast-label", "提示词"), refRead);
  /* 外接提示词徽章：prompt_text 接线时显示，提示词框同时转只读镜像 */
  const extBadge = el("span", "gcast-extbadge", "外部提示词 · 只读");
  extBadge.style.display = "none";
  extBadge.title = "正面提示词由外部文本节点提供，此处仅预览；断开连线即恢复面板编辑";
  pHead.append(extBadge);
  /* 别名总开关（与 ✍️ H3 文案台的「别名」同一个机制）：
     开 = 媒体架槽位里起的名字直接当引用（写完即高亮、后端展开成 @图片N）；
     关 = 只认 @图片N，名字一律当普通文字——同一张图既写名字又写 @图片1 时，
     两边会一起指向它（两个 <imageN>），关掉就只剩一次引用。 */
  const btnAlias = el("button", "gq-aliasbtn");
  btnAlias.type = "button";
  btnAlias.title = "别名：媒体架槽位里起的名字（小明 / @小明）直接当引用。\n"
    + "关掉后只认 @图片N——同一张参考图既写了名字又写了 @图片1 时，用它避免重复引用。";
  pHead.append(btnAlias);
  const paintAlias = () => {
    btnAlias.textContent = `别名：${st.alias ? "开" : "关"}`;
    btnAlias.classList.toggle("on", !!st.alias);
  };
  btnAlias.onclick = () => {
    st.alias = !st.alias;
    paintAlias();
    paintChips();                  // 关掉后只按 @图片N 判定亮灭
    edPos.refresh();               // 词表变了：别名不再高亮 / 不再进 @ 补全
    edNeg.refresh();
    commit();
  };
  /* 片子级（LoRA 触发词）：常驻单行框，留空不拼、有内容自动加在最前面。
     注入做在提交对象上（见 csglide_asset_batch.js），所以提示词框不会被改写；
     单张运行与批量共用这一处设置。 */
  const gRow = el("div", "gq-grow");
  const gIn = document.createElement("input");
  gIn.type = "text";
  gIn.className = "gq-global";
  gIn.placeholder = "片子级：LoRA 触发词 / 风格基调，留空不拼";
  gIn.value = String((node.properties && node.properties.gqGlobal) || "");
  gIn.addEventListener("input", () => {
    st.global = gIn.value;
    /* 双写：qwen_data 是主路径（必然被序列化，且改它会标脏），
       properties 留作旧存档的兼容位。缺了 qwen_data 这一路，
       自动保存和「未保存」提示都不会认这次修改。 */
    if (!node.properties) node.properties = {};
    node.properties.gqGlobal = gIn.value;
    commit();
    emitDeskChange({ reason: "image-studio" });
  });
  /* 别让 Backspace / 数字键冒泡到画布触发快捷键 */
  gIn.addEventListener("keydown", (e) => e.stopPropagation());
  gRow.append(gIn);
  const nHead = el("div", "gcast-phead");
  nHead.append(el("div", "gcast-label", "负面提示词"));

  const mkEditor = (cls, placeholder, key) => makePromptEditor({
    cls, placeholder, mode: "qwen", view: previewURL, tokens: vocab,
    onChange: (t) => { st[key] = t; paintChips(); commit(); emitDeskChange({ reason: "image-studio" }); },
  });
  const edPos = mkEditor("prompt",
    "描述要怎么改这张图。写 @图片1 / @图片2 来区分多张参考图。", "prompt");
  const edNeg = mkEditor("neg", "不想出现的东西（可留空）", "negative_prompt");

  /* 外接提示词（模式 A）：prompt_text 接线即外部文本整体接管正面提示词。
     编辑器转只读镜像——DOM 里放的就是外部值，高亮与悬停预览照常工作；
     st.prompt 的存储永不被污染，断线即恢复面板原文。负面提示词不受影响。 */
  function paintExt() {
    const up = promptNodeOf(node);
    const pw = !!up;
    extBadge.style.display = pw ? "" : "none";
    edPos.setReadonly(pw);
    edPos.setText(pw ? upstreamTextOf(up) : st.prompt);
    paintChips();                  // 外部文本换了，标签栏的亮灭跟着换
  }

  pWrap.append(pHead, gRow, chips, edPos.node, nHead, edNeg.node);

  const hint = el("div", "gq-hint", "");
  function paintHint() {
    const h3 = (familyOf() === FAM_H3IMAGE);
    if (h3) {
      hint.textContent = "";
    } else {
      hint.textContent = "参考图全部送出，不必在提示词里点名；@图片N 只是用来在文字里区分它们（会转写成 <imageN>）。"
        + "点亮的标签 = 提示词里提到了它。别名（媒体架槽位里起的名字）可直接当引用写；"
        + "\\别名 表示不展开；同一张图既写名字又写 @图片1 时，把「别名」关掉即可避免重复引用。";
    }
  }
  paintHint();
  pWrap.append(hint);

  /* ---------------- 提示词改写 ----------------
     Qwen/MOSS 默认用接入的 CLIP 自己改写（带 lm_head，能出字）；
     H3 Image 主编码器截断 50 层不能出字，必须外接独立模型（同文案台机制：
     按文件名直连加载，不依赖画布连线）。系统提示词留空时后端按家族给默认。 */
  const rwWrap = el("div", "gq-rewrite");
  const rwHead = el("div", "gcast-phead");
  const cbRewrite = el("input"); cbRewrite.type = "checkbox";
  cbRewrite.title = "开启后，正面提示词会先改写成更完整的画面描述，再送去编码。"
    + "Qwen/MOSS 用接入的 CLIP；H3 Image 用下面选的外接模型。";
  const rwLabel = el("span", "gq-cblbl", "提示词改写");
  rwLabel.style.cssText = "font-size:11px; white-space:nowrap; color:var(--h3-txt);";
  const rwBadge = el("span", "gcast-extbadge", "");
  rwBadge.style.display = "none";
  const rwBtn = el("button", "gq-rwbtn");
  rwBtn.type = "button";
  rwBtn.textContent = "立即改写";
  rwBtn.title = "不用跑画布，直接调后端改写当前提示词。结果写回提示词框。";
  rwBtn.style.cssText = "margin-left:auto; font-size:11px; padding:2px 10px;"
    + "color:var(--h3-txt); background:var(--h3-well); border:1px solid var(--h3-line);"
    + "border-radius:6px; cursor:pointer; white-space:nowrap;";
  rwHead.append(cbRewrite, rwLabel, rwBadge, rwBtn);
  rwWrap.append(rwHead);

  /* 改写模型下拉（同文案台机制）：候选来自后端 /csglide_qwen/models。
     空 = Qwen/MOSS 用主 CLIP 自己改写；H3 必须选一个（空时后端用默认 2b）。 */
  const rwModelCtl = el("div", "gcast-ctl");
  const rwModel = document.createElement("select");
  rwModel.style.cssText = "flex:1; min-width:0; font:inherit; font-size:11px;"
    + "color:var(--h3-txt); background:var(--h3-well); border:1px solid var(--h3-line);"
    + "border-radius:6px; padding:2px 4px; outline:none;";
  rwModel.title = "改写用的模型文件。Qwen/MOSS 留空 = 用接入的 CLIP 自己改写；"
    + "H3 Image 必须外接（主编码器不能出字），留空 = 用默认 2b 模型。";
  rwModelCtl.append(el("span", "gcap dim-x", "改写模型"), rwModel);
  rwWrap.append(rwModelCtl);
  /* 候选来自后端。拉取失败时只留「默认」一项，改写照常可用。 */
  (async () => {
    const put = (opts) => {
      rwModel.replaceChildren(...opts.map(([v, t]) =>
        Object.assign(document.createElement("option"), { value: v, textContent: t })));
      rwModel.value = st.rewrite_model || "";
    };
    try {
      const r = await api.fetchApi("/csglide_qwen/models");
      const d = await r.json();
      const list = Array.isArray(d.models) ? d.models : [];
      const def = String(d.default || "");
      const base = (n) => n.replace(/\\/g, "/").split("/").pop();
      const opts = [["", "默认模型" + (def ? "（" + base(def) + "）" : "")]];
      for (const n of list) opts.push([n, base(n)]);
      if (st.rewrite_model && !opts.some((o) => o[0] === st.rewrite_model))
        opts.push([st.rewrite_model, base(st.rewrite_model) + "（存档所选）"]);
      put(opts);
    } catch (_) { put([["", "默认模型"]]); }
  })();
  rwModel.onchange = () => { st.rewrite_model = rwModel.value; paintRewrite(); commit(); };

  const rwSys = el("textarea");
  rwSys.className = "gcast-rwsys";
  rwSys.rows = 4;
  rwSys.placeholder = "系统提示词（留空 = 用该模型的默认改写规则）";
  rwSys.title = "给改写模型下的指令。留空则用默认规则："
    + "改写成中文画面描述，保留全部指定内容，补齐取景/光照/材质，不加画质关键词。";
  const rwNote = el("div", "gcast-read");
  rwWrap.append(rwSys, rwNote);

  const rwLen = el("input"); rwLen.type = "number";
  rwLen.step = 64; rwLen.min = 64; rwLen.max = 4096;
  rwLen.title = "改写输出的最大长度（token）。默认 512——改写产出 200～350 字中文，"
    + "512 已经宽裕；上限只是防止模型跑飞时无限出字。";
  const rwLenCtl = el("div", "gcast-ctl");
  rwLenCtl.append(el("span", "gcap dim-x", "输出上限"), rwLen,
    el("span", "gcap dim-x", "token"));
  rwWrap.append(rwLenCtl);
  const rwStatus = el("div", "gcast-read");
  rwStatus.style.cssText = "font-size:11px; min-height:1em; margin-top:2px;";
  rwWrap.append(rwStatus);

  function paintRewrite() {
    cbRewrite.checked = st.rewrite;
    rwSys.value = st.rewrite_system || "";
    rwLen.value = String(st.rewrite_max_length || 512);
    rwModel.value = st.rewrite_model || "";
    const on = st.rewrite;
    const h3 = (familyOf() === FAM_H3IMAGE);
    rwSys.disabled = !on;
    rwLen.disabled = !on;
    rwModel.disabled = !on;
    rwWrap.classList.toggle("gq-off", !on);
    rwBadge.style.display = on ? "" : "none";
    rwBadge.textContent = h3 ? "外接模型改写" : "由模型自己改写";
    rwBadge.title = h3
      ? "H3 Image 主编码器截断 50 层不能出字，改写用下面选的外接模型"
      : "改写用的是接入的 CLIP（它带语言模型头），不需要另接 LLM 节点";
    rwNote.innerHTML = on
      ? (h3
        ? "改写后送去编码 · 用外接模型（H3 主编码器不能出字）"
        : (st.rewrite_model
          ? "改写后送去编码 · 用外接模型 " + st.rewrite_model.replace(/\\/g, "/").split("/").pop()
          : "改写后送去编码 · 用接入的 CLIP，不占额外显存"))
      : "未开启 · 提示词原样送去编码";
  }
  cbRewrite.onchange = () => { st.rewrite = cbRewrite.checked; paintRewrite(); commit(); };
  rwSys.onchange = () => { st.rewrite_system = rwSys.value; commit(); };
  rwLen.onchange = () => {
    const n = Math.max(64, Math.min(4096, Math.round(Number(rwLen.value) || 512)));
    st.rewrite_max_length = n;
    rwLen.value = String(n);
    commit();
  };
  /* 「立即改写」按钮：不走画布运行，直接调后端 HTTP 接口改写当前提示词，
     结果写回提示词框。与文案台同机制。 */
  rwBtn.onclick = async () => {
    if (promptNodeOf(node)) {
      rwStatus.textContent = "外接提示词模式：正面由外部文本接管，请在外部节点改写";
      return;
    }
    const t = st.prompt || "";
    if (!t.trim()) { rwStatus.textContent = "提示词为空，没有可改写的内容"; return; }
    rwBtn.disabled = true;
    const old = rwBtn.textContent;
    rwBtn.textContent = "改写中…";
    rwStatus.textContent = "";
    try {
      const { raw } = rackSlotsOf(node);
      const res = await api.fetchApi("/csglide_qwen/rewrite", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: t,
          system: st.rewrite_system || "",
          model: st.rewrite_model || "",
          max_length: st.rewrite_max_length || 512,
          refs: raw || "",
        }),
      });
      const txt = await res.text();
      let d;
      try { d = JSON.parse(txt); }
      catch (_) { throw new Error("HTTP " + res.status + "：" + txt.slice(0, 120)); }
      if (!res.ok || d.error) throw new Error(d.error || ("HTTP " + res.status));
      if (!d.text || d.text === t) {
        rwStatus.textContent = "模型没有产出改动，保持原样";
        return;
      }
      st.prompt = d.text;
      edPos.setText(d.text);
      commit();
      emitDeskChange({ reason: "image-studio" });
      rwStatus.textContent = "已改写 " + d.text.length + " 字并写回提示词框";
    } catch (err) {
      rwStatus.textContent = "改写失败：" + ((err && err.message) || err);
    } finally {
      rwBtn.disabled = false;
      rwBtn.textContent = old;
    }
  };
  pWrap.append(rwWrap);

  /* ---------------- 改写结果回填提示词框 ----------------
     改写发生在后端（结果直接送编码器），前端默认拿不到。没有回填的话，
     面板里显示的是原文、实际送去编码的是改写后的文本——「面板说了不算」，
     用户既看不到模型改成了什么，也没法在改写结果上继续改。

     回填通道：后端把改写文本放在返回值的 ui.text 里，ComfyUI 执行时随
     executed 事件推给前端（execution.py 的 send_sync("executed", {...output})）。
     不用查 history——普通节点的 STRING 输出不进 history。

     回填后文本进了提示词框，下一次运行会拿它再改一遍。所以这里把
     「本次回填的是改写结果」记进面板状态：改写开关自动关掉（用户想继续
     改就手动再开），并在提示词框上方留一行说明。 */
  let lastRewrite = "";
  const rwDone = el("div", "gq-hint");
  rwDone.style.display = "none";
  rwDone.style.marginTop = "4px";
  rwDone.innerHTML = "<b>已回填改写结果</b> · 再次运行不会重复改写（要再改请重新勾选）";
  /* 放在提示词编辑器下面（不是 pHead 里——那是横向排版条，塞会换行的
     说明会把整行挤乱）。 */
  edPos.node.after(rwDone);

  function onExecuted(e) {
    const d = e && e.detail;
    if (!d || String(d.node) !== String(node.id)) return;
    const out = d.output;
    if (!out || !out.text) return;
    const text = Array.isArray(out.text) ? out.text[0] : out.text;
    if (typeof text !== "string" || !text.trim()) return;
    if (text === lastRewrite) return;          // 同一份结果不重复回填
    lastRewrite = text;
    /* 外接提示词接管时，面板正面是只读镜像——这时不抢用户的外部文本，
       只提示改写确实发生了。 */
    const external = !!promptNodeOf(node);
    if (external) {
      rwDone.style.display = "";
      rwDone.innerHTML = "<b>已改写</b> · 外接提示词接管中，面板不显示改写结果";
      return;
    }
    st.prompt = text;
    edPos.setText(text);
    st.rewrite = false;                          // 防止下次把改写结果再改一遍
    paintRewrite();
    paintChips();
    commit();
    rwDone.style.display = "";
  }
  api.addEventListener("executed", onExecuted);

  /* 插入点跟随「最后编辑过的那个框」：点 chip 时焦点落在按钮上，用
     activeElement 判断会一律插进正提示词。 */
  let lastEd = edPos;
  edPos.node.addEventListener("focus", () => { lastEd = edPos; });
  edNeg.node.addEventListener("focus", () => { lastEd = edNeg; });
  const insertToken = (t) => { if (!lastEd.readonly()) lastEd.insert(t); };

  function paintRead() {
    const fam = familyOf();
    const moss = (fam === FAM_MOSS);
    const h3 = (fam === FAM_H3IMAGE);
    headBadge.replaceChildren();
    /* 徽标第一段是模型名——用户一眼能看出这个节点当前在服务哪个模型，
       不用去翻 CLIP 加载节点。 */
    headBadge.append(el("span", null, moss ? "MOSS-Image" : h3 ? "MiniMax H3 Image" : "Qwen-Image 2.1"),
      el("span", null, " · "));
    if (st.canvas_from_ref && !moss) {
      headBadge.append(el("b", null, "输出画面 跟随图片1"));
      return;
    }
    const w = st.canvas.w, h = st.canvas.h;
    headBadge.append(el("span", null, "输出画面 "), el("b", null, `${w}×${h}`),
      el("span", null, ` · 潜空间 ${w / 16}×${h / 16}`));
  }

  root.append(head, row, pWrap);

  const RACK_HEAD = () => (typeof LiteGraph !== "undefined" && LiteGraph.NODE_TITLE_HEIGHT) || 30;
  function fit() {
    requestAnimationFrame(() => {
      if (node.flags?.collapsed) return;
      /* root 是 height:100%，offsetHeight 只会等于节点现有高度（循环自证）；
         内容超高时溢出进滚动区，scrollHeight 才是真实内容高度。 */
      const contentH = Math.max(root.offsetHeight || 0, root.scrollHeight || 0);
      if (!contentH) return;
      const needH = RACK_HEAD() + 2 + contentH + 6;
      if (needH > (node.size?.[1] || 0) + 1) node.setSize?.([node.size[0], Math.ceil(needH)]);
    });
  }

  function render() {
    renderChips();
    refresh();         // 画布控件 + 尺寸读出（内含 refOff 置灰）
  }

  function load(raw) {
    let d = {};
    try { d = typeof raw === "string" ? JSON.parse(raw || "{}") : (raw || {}); } catch (_) { d = {}; }
    st.prompt = typeof d.prompt === "string" ? d.prompt : "";
    st.negative_prompt = typeof d.negative_prompt === "string" ? d.negative_prompt : "";
    /* 旧存档里的 images（面板槽位时代）直接丢弃：参考图现在只认媒体架 */
    /* 画布缺省/非法 → 官方默认（H3 2048²，其余 1024²）；用 align32 不夹上限
       ——H3 存档的 6000 不被截成 4096（load 时 CLIP 可能还没接）。 */
    const cv = (d.canvas && typeof d.canvas === "object") ? d.canvas : {};
    const cw = Math.round(Number(cv.w) || 0);
    const ch = Math.round(Number(cv.h) || 0);
    const defSide = familyOf() === FAM_H3IMAGE ? 2048 : 1024;
    st.canvas = (cw >= STEP && ch >= STEP)
      ? { w: align32(cw), h: align32(ch) }
      : { w: defSide, h: defSide };
    st.canvas_from_ref = !!d.canvas_from_ref;
    /* 跟随长边：缺省/非法 → 1024；align32 不夹上限（H3 可到 8192） */
    const lg = Math.round(Number(d.ref_long));
    st.ref_long = Number.isFinite(lg) && lg >= 0 ? (lg > 0 ? align32(lg) : 0) : REF_LONG_DEFAULT;
    /* 参考尺寸：缺省 / 非法 → 与后端 REF_CAP_DEFAULT 同值；0 = 原尺寸。
       旧存档里这项叫 resolution（当时按面积锚定），数值当最长边上限用依然合理。 */
    const capRaw = d.ref_cap != null ? Number(d.ref_cap)
      : (d.resolution != null ? Number(d.resolution) : REF_CAP_DEFAULT);
    st.ref_cap = Number.isFinite(capRaw) ? refCapOf(capRaw) : REF_CAP_DEFAULT;
    /* 别名开关：缺省开——旧存档没有这一项，保持它们原本的行为 */
    st.alias = d.alias !== false;
    /* 改写：旧存档没有这些项，缺省关（保持旧工作流行为不变） */
    st.rewrite = d.rewrite === true;
    st.rewrite_system = typeof d.rewrite_system === "string" ? d.rewrite_system : "";
    st.rewrite_model = typeof d.rewrite_model === "string" ? d.rewrite_model : "";
    const rwLen = Math.round(Number(d.rewrite_max_length));
    st.rewrite_max_length = Number.isFinite(rwLen) && rwLen >= 64
      ? Math.min(4096, rwLen) : 512;
    paintAlias();
    paintRewrite();
    /* 片子级：新存档在 qwen_data.global。老存档（上一版）只写在
       node.properties.gqGlobal，作为回退——configure 阶段 properties 已应用，
       而本函数在 onNodeCreated 阶段也会跑一次，那时读到空串也无妨，
       后面 onConfigure 再跑一次就能补上。 */
    const gSaved = typeof d.global === "string" ? d.global : null;
    const gLegacy = String((node.properties && node.properties.gqGlobal) || "");
    /* 用 null 区分「存档里没这一项」和「用户清空了」：
       后者是 "" 且不该回退到 properties，否则清空会失效。 */
    st.global = gSaved == null ? gLegacy : gSaved;
    gIn.value = st.global;
    edPos.setText(st.prompt);
    edNeg.setText(st.negative_prompt);
    render();
    paintExt();        // 存档里 prompt_text 已接线时，直接进只读镜像
    fit();
  }

  /* 批量导入挂在面板底部；两个钩子都读最新状态（不是快照），
     因为面板可能在校验之后才接线/改画布。 */
  const ui = {
    root, load, fit, render,
    minH: () => 120,
    /* 外接提示词接线时正面是只读镜像：批量改了 qwen_data 也送不到后端，必须提前拦 */
    locked: () => !!promptNodeOf(node),
    /* 片子级输入框：注入时读它的实时值，改完立刻点运行就生效 */
    globalInput: gIn,
    /* 老存档迁移：片子级上一版只写在 node.properties.gqGlobal,
       onConfigure 末尾调一次把它搬进 st / 输入框（那时 properties 才准）。
       st.global 有值就直接返回，绝不覆盖用户在 qwen_data 里存的内容。 */
    syncGlobal: () => {
      if (st.global) return;
      const v = String((node.properties && node.properties.gqGlobal) || "");
      st.global = v;
      gIn.value = v;
    },
    destroy: () => {
      clearInterval(rackPoll);
      try { offRackEvt(); } catch (_) {}
      /* executed 监听是挂在 api 上的全局事件，节点删了不摘会一直回调到
         已销毁的面板——句柄还在，累积成泄漏。 */
      try { api.removeEventListener("executed", onExecuted); } catch (_) {}
      try { batch && batch.destroy(); } catch (_) {}
      edPos.destroy(); edNeg.destroy();
    },
  };
  batch = installAssetBatch(node, ui);
  return ui;
}

app.registerExtension({
  name: "cglide.qwenstudio",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== NODE_ID) return;
    injectCSS();

    const onCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = onCreated?.apply(this, arguments);

      const pinLabel = (slot) => {
        if (!slot) return;
        const key = (slot.name || slot.localized_name || "").toLowerCase().replace(/[\s_]+/g, "");
        if (key === "clip" || key === "剪辑") slot.label = "CLIP";
        else if (key === "vae" || key === "变分自编码器") slot.label = "VAE";
        else if (key === "refs") slot.label = "参考素材";
        else if (key === "prompttext" || key === "外接提示词") slot.label = "外接提示词";
        else if (key === "正面条件") slot.label = "正面条件";
        else if (key === "潜空间") slot.label = "潜空间";
      };
      for (const inp of this.inputs || []) pinLabel(inp);
      for (const out of this.outputs || []) pinLabel(out);

      const data = this.widgets?.find((w) => w.name === "qwen_data");
      if (data) {
        /* 隐藏 data widget：v1/v2 前端各自的隐藏口径都设一遍（同导演台） */
        data.origType = data.origType || data.type;
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
      this.gq = ui;
      const uiWidget = this.addDOMWidget("qwen_ui", "div", ui.root, { serialize: false, hideOnZoom: false });
      /* minHeight 报固定小值：前端拖拽以 computeSize()（各 widget minHeight 之和）
         做下限钳制，报内容实测峰值会让节点永远收不短。 */
      uiWidget.computeLayoutSize = () => ({ minHeight: ui.minH(), maxHeight: void 0, minWidth: 0 });

      requestAnimationFrame(() => {
        const wrap = ui.root.parentElement;
        if (wrap && wrap.classList.contains("dom-widget")) wrap.style.pointerEvents = "none";
      });

      ui.load(data ? data.value : "");
      this.setSize?.([MIN_W, MIN_H]);
      return r;
    };

    const onConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function (info) {
      const r = onConfigure?.apply(this, arguments);
      const data = this.widgets?.find((w) => w.name === "qwen_data");
      if (this.gq && data) this.gq.load(data.value);
      /* load 之后补一次：老存档的片子级在 properties 里，configure 阶段才读得准 */
      this.gq?.syncGlobal?.();
      return r;
    };

    /* 编辑器的补全列表与预览浮窗挂在 body 上（不能挂在节点里，否则一弹出
       就把节点内排版顶开）；节点删除时一并收走，不然它们会留在页面上。 */
    const onRemoved = nodeType.prototype.onRemoved;
    nodeType.prototype.onRemoved = function () {
      const r = onRemoved?.apply(this, arguments);
      this.gq?.destroy?.();
      return r;
    };

    /* 画布行是两个下拉 + 两个数字框，收得比 MIN_W 更窄就会互相挤掉 */
    const onResize = nodeType.prototype.onResize;
    nodeType.prototype.onResize = function (size) {
      if (size[0] < MIN_W) size[0] = MIN_W;
      return onResize?.apply(this, arguments);
    };
  },
});
