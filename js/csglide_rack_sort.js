/* ============================================================
 * H3 媒体架 — 按提示词排序
 * ------------------------------------------------------------
 * 「<Subject 1> 为 @图片3 中的陈九一」这类写法里，编号 3 是写剧本时按文本
 * 顺序定死的，素材落在架上哪一格却是拖出来的——两者不一致时，@图片3 指的
 * 就不是陈九一。本按钮把这层关系反过来用：在 @标签 左右找出架上认得的名
 * 字，把那件素材搬到这个编号所在的格子。

 * 名字是**反查**得来的，不是从句子里分析出来的：候选集就是架上现有的别名
 * 与文件名主干（有限、且全由用户控制），拿它去文本里查命中。因此绝不会认
 * 出一个架上没有的名字，也不需要猜测句子语法——换任何提示词写法都照样成立。
 * 一处 @标签附近有多个候选时，取离它最近的；距离相同取名字更长的（免得
 * 「九一」抢掉更完整的「陈九一」）。

 * 只认**显式写的** @图片N / @视频N / @音频N：只写角色名（别名）的不好办——
 * 别名是「按当前顺序」展开成编号的，先改顺序再按别名判，等于拿结论当依据。
 * ============================================================ */
import { promptNodeOf, upstreamTextOf } from "./csglide_cast.js";
import { flashBtn, MAX_SLOTS } from "./csglide_rack_core.js";
import { ALIAS_MIN, ALIAS_SPLIT, baseName, normSpace } from "./csglide_rack_alias.js";
/* 写法归一化：官方式 <Picture N> / <Video N>、英文裸词 image 1 / Image 1、
   中文 图片 1 等，统一收敛成 @图片N。排序前先过一遍，中英文写法就不必在
   这里再认一次——与导演台 / 后端同一套口径，改一处全覆盖。 */
import { normalizeRefs } from "./csglide_ref_text.js";
import { defClaimsOf } from "./bz_prompt_build.js";

/* 补一层**带 @ 的英文写法**（@image1 / @pic2 / @video1 / @audio1）：项目级
   normalizeRefs 只收「不带 @ 的英文裸词」（image 1）和官方式尖括号（<Picture 1>），
   带 @ 的英文它认不到。这一层只加在媒体架排序里，不动共享规则，免得影响
   导演台编辑器的显示与别名展开。 */
const AT_EN_REF = [
  [/@\s*images?\s*(\d+)/gi, "@图片$1"],
  [/@\s*(?:pic|picture|frame|img)s?\s*(\d+)/gi, "@图片$1"],
  [/@\s*videos?\s*(\d+)/gi, "@视频$1"],
  [/@\s*audios?\s*(\d+)/gi, "@音频$1"],
];
function rackNormalize(t) {
  let s = String(t || "");
  for (const [re, rep] of AT_EN_REF) s = s.replace(re, rep);
  return s;
}

const TOKEN_RE = {
  images: /@图片(\d+)/g,
  /* @视频音频N 也是视频槽位（与导演台 filterUsedByPrompt 同口径） */
  videos: /@(?:视频音频|视频)(\d+)/g,
  audios: /@音频(\d+)/g,
};
const TOKEN_LABEL = { images: "图片", videos: "视频", audios: "音频" };

/* 卡片上显示的名字：别名优先，文件名主干兜底——与 nameIndex 同一套取值规则，
   保证「诊断里报出来的名字」就是用户在架上看到的那个名字，不会对不上号。 */
function slotLabel(slot) {
  const raw = Array.isArray(slot.alias) ? slot.alias.join("，") : (slot.alias || "");
  const first = String(raw).split(ALIAS_SPLIT).map((s) => String(s).trim()).filter(Boolean)[0];
  return first || baseName(slot.file);
}

/* 架上现有的名字 → 槽位。别名优先，文件名主干兜底（两者常是同一个词）。 */
function nameIndex(kind, st) {
  const m = new Map();
  st.slots[kind].forEach((slot) => {
    if (!slot || !slot.file) return;
    const raw = Array.isArray(slot.alias) ? slot.alias.join("，") : (slot.alias || "");
    for (const nm of String(raw).split(ALIAS_SPLIT).concat(baseName(slot.file))) {
      const name = normSpace(String(nm).trim()).replace(/^@/, "");
      if (name.length >= ALIAS_MIN && !m.has(name)) m.set(name, slot);
    }
  });
  return m;
}

/* @标签 左右认主人的边界：**按条目切，不按整行切**。
   原来只有「同一行内」这一个约束——条目之间只用句号分隔（或者整段被压成一
   行）时，窗口会横跨好几条定义，前面那个 @标签 把后面条目的名字抢走：
      · @图片1 … @图片2 定义为 陈墨白 → 陈墨白被 @图片1 抢走，@图片2 只能报
        「陈墨白已占位」，那件素材一格都不挪；
      · @图片13 定义为 升山符 … @图片14 → 升山符被 @图片14 抢走（诊断里
        「@图片14（升山符已占位）」出现两次就是这么来的）。
   换行、中文句读、竖线都算条目边界；再叠 ±120 字上限兜底（超长无标点段落
   不至于让窗口无限延伸）。 */
const ITEM_CUT = /[\n\r。；;！!？?|，,、]/;

/* 任意 @标签（含 @first/@last）。它也是窗口的硬边界：名字归离它最近的那个
   标签，窗口不许跨过别的标签——否则「@图片1 定义为 陈墨白 @图片2 定义为 马魁」
   这种同行写法里，@图片2 会把 陈墨白 抢过来。 */
const ANY_TOKEN = /@(?:first|last|图片\d+|视频音频\d+|视频\d+|音频\d+)/g;

/* ---- 通用判据：标签与名字之间「只有连接词」才算直接定义 ------------------
   剧本写法千变万化（`@图片1是李墨白`、`@图片1=李墨白`、`李墨白=@图片1`、
   `@image1 is Li Mobai`、`<Picture 1>: Li Mobai`…），靠「看左边还是看右边」
   + 距离去猜，任何一种新写法都可能翻车。换成看**中间那截是什么**：
   只有空白、标点、系动词、「定义为 / 即 / 对应 / refers to」这类连接词，
   就认定这一对是直接定义；夹了别的字（另一句描述、另一个素材名）就不是。
   这条判据不分中英文、也不分名字在前还是在后。 */
const LINK_PURE = /^[\s:：=＝\-—～~*#"'"'"‘’“”()（）\[\]【】<>《》,，、.。/\\|]*$/;
const LINK_WORD = /^(?:是|为|即|系|指|就是|名叫|名为|命名(?:为)?|定义(?:为)?|对应|指向|代表|表示|指的是|指的就是|is|are|was|were|be|as|means?|refers?\s+to|defined\s+as|named|a\.k\.a\.?|aka|the\s+name\s+of|stands\s+for)$/i;

function linkOnly(mid) {
  /* 先剥掉成对括号及其内容：`@图片30（核心帧图标准名 KF_01-07）定义为核心帧
     参考图` 剥完就是「定义为」，否则会被括号里的附注挡掉。 */
  const s = String(mid || "").replace(/[（(][^）)]*[）)]/g, "").trim();
  if (!s) return true;
  if (LINK_PURE.test(s)) return true;
  /* 名字**在括号里**的写法（`将 @图片26（核心帧图标准名 KF_01-03）定义为核心帧
     参考图`）：上面那刀只切到名字前面，拿到的是「（核心帧图标准名 」—— 左括号
     没有配对的右括号，剥括号正则剥不掉，剩下的「核心帧图标准名」让它被判成
     "夹了别的字"，于是不算直接定义，括号里写好的标准名等于白写（这一格不挪）。
     括号里的附注本来就是这个标签自己的说明（"核心帧图标准名"是提示词作者加的
     注释），见到未闭合的左括号一律放行。 */
  if (/[（(][^）)]*$/.test(s)) return true;
  return LINK_WORD.test(s.replace(/[\s:：=＝\-—～~]+/g, " ").trim());
}

/* tokLen = 当前这个 @标签 自身的长度（@图片12 是 5），用来算标签结束位置 */
function ownerOfToken(text, pos, tokLen, names) {
  let from = Math.max(0, pos - 120);
  for (let i = pos - 1; i >= from; i -= 1) {
    if (ITEM_CUT.test(text[i])) { from = i + 1; break; }
  }
  let to = Math.min(text.length, pos + 120);
  for (let i = pos + 1; i < to; i += 1) {
    if (ITEM_CUT.test(text[i])) { to = i; break; }
  }
  /* 第二道：别的 @标签。贴着窗口边界往外扫，取最近的那个当硬边界。 */
  const re = new RegExp(ANY_TOKEN.source, "g");
  re.lastIndex = from;
  let m, leftTok = -1, rightTok = to;
  while ((m = re.exec(text)) && m.index < to) {
    if (m.index + m[0].length <= pos) { leftTok = m.index; continue; }
    if (m.index > pos) { rightTok = m.index; break; }
  }
  if (leftTok >= 0) from = Math.max(from, leftTok);
  to = Math.min(to, rightTok);

  /* 三级取舍：直接定义 > 同侧最近（先右后左）> 另一侧最近。
     直接定义之间也按距离取最近，同距离取名字更长的（免得「九一」抢掉「陈九一」）。 */
  let bestDirect = null, bestR = null, bestL = null;
  for (const [name, slot] of names) {
    for (let k = text.indexOf(name, from); k >= 0 && k < to; k = text.indexOf(name, k + 1)) {
      /* 标签与名字之间那一截：名字在后 → 标签尾到名字头；名字在前 → 名字尾到标签头 */
      const mid = k >= pos ? text.slice(pos + tokLen, k) : text.slice(k + name.length, pos);
      const item = { dist: Math.abs(k - pos), name, slot, direct: linkOnly(mid) };
      const better = (a, b) => !b || item.dist < b.dist
        || (item.dist === b.dist && name.length > b.name.length);
      if (item.direct) { if (better(item, bestDirect)) bestDirect = item; }
      else if (k >= pos) { if (better(item, bestR)) bestR = item; }
      else if (better(item, bestL)) bestL = item;
    }
  }
  /* 没有「直接定义」的写法（`@图片2 场景中出现 陈墨白` 这类）才退回位置推断 */
  return bestDirect || bestR || bestL;
}

/* 把 target（0 基编号 → 槽位）落到数组里：被点名的进指定格，其余按原相对
   顺序补进剩下的格子。编号是位置本身，挪了中间的必然带动后面——这是改动
   的本意。返回实际换了位置的个数。 */
function applyOrder(kind, target, st) {
  const arr = st.slots[kind];
  const need = Math.max(...target.keys()) + 1;
  while (arr.length < need) arr.push({});      // 编号超出现有长度：补空位撑住
  const placed = new Set(target.values());
  const out = new Array(arr.length).fill(null);
  for (const [i, slot] of target) out[i] = slot;
  let k = 0;
  for (const s of arr) {
    if (placed.has(s)) continue;
    while (k < out.length && out[k] !== null) k += 1;
    if (k < out.length) out[k] = s; else out.push(s);
  }
  for (let i = 0; i < out.length; i++) if (out[i] === null) out[i] = {};
  let moved = 0;
  for (const [i, slot] of target) if (arr.indexOf(slot) !== i) moved += 1;
  /* 原地写回：视频/音频卡的闭包拿的是 slot 对象而不是数组，换数组引用会挂 */
  arr.length = out.length;
  for (let i = 0; i < out.length; i++) arr[i] = out[i];
  return moved;
}

export function installSort(ui) {
  /* 从文案台 desk_data JSON 按当前段拼出「真正会发送」的提示词。
     ⚠ 绝不能再用「最长字符串 widget」启发式去取文案台的提示词——那会把整段
     desk_data JSON 当成提示词：JSON 里换行被转义成字面量 \n，ownerOfToken 的
     「只在同一行内找」边界保护随之失效，±120 字窗口跨行把上一行的名字（如
     @图片2 的「范孟」）认成 @图片13 的主人 → 范孟偷掉 @图片13、真正该去的
     「中台中堂」落进剩余桶。取的是与本段相关的那一份文本（全局 + 本段），
     但拼接顺序见下面 deskPrompt 顶部注释——排序要的是冲突时的优先级。 */
  /* 段键的权威来源：**文案台自己的 chain.clip**。
     媒体架的 ui.st.cur 是「架上的段位名」（第七段 / 段3…），文案台的 segs 是
     按 cid 建的字典——两者不是一套命名。拿 cur 去查 segs，查不到时本段段词
     整段丢失、只剩 global，于是「一个 @图片N 都没读到」，排序纹丝不动，提示
     还偏偏显示「顺序已对齐」。与导演台 csglide_cast_slots.js 的 effPrompt 同
     口径：clip 才是「本段到底是哪一段」。 */
  function deskClipOf(deskNode) {
    const w = (deskNode.widgets || []).find((x) => x.name === "desk_data");
    let st = {};
    try { st = JSON.parse((w && w.value) || "{}") || {}; } catch (_) { st = {}; }
    return String((st.chain && st.chain.clip) || "");
  }

  /* ⚠ 拼接顺序是「本段 → 全局」，直接决定谁赢，别改回去。
     同一件素材在 global 里常有一套**全片**定义（@图片1 = 陈墨白），在本段里
     又写一套（@图片2 = 陈墨白），编号对不上。排序按文本出现顺序「先写先赢」，
     global 放前面，旧编号就把素材抢走，本段写的 @图片2 只能落空——表现正是
     「点完显示顺序已对齐（其实是挪动 0 个），陈墨白还在第 1 格」。本段更具体、
     更新，必须优先；global 只兜底补那些本段没写到的编号。
     注意：这里与导演台 composedWords 的「global + 本段」**故意不同**——那是
     送模型的文本顺序，改不得；排序要的是冲突时的优先级，不是发送顺序。 */
  /* clipOverride：排「全部段」时按指定段读，不传 = 读文案台当前段。
     文案台的 segWords / composedWords 本来就接受段身份作参数（按段身份直接读
     st.segs[key]，不依赖界面此刻停在哪一段），所以逐段读不需要切界面。 */
  function deskPrompt(deskNode, clipOverride) {
    const clip = clipOverride || deskClipOf(deskNode);
    const du = deskNode && deskNode.deskUI;
    const clean = (t) => String(t || "").replace(/\r\n/g, "\n").replace(/[ \t]+\n/g, "\n").trim();

    /* 本段：优先问文案台要实时文本（正编辑本段时它先把编辑器里的输入收口回来） */
    let seg = "";
    if (du && typeof du.segWords === "function") {
      try { seg = String(du.segWords(clip) || ""); } catch (_) { seg = ""; }
    }
    /* 全局：composedWords 会先把 global 收口成编辑器最新值并返回「global + 本段」，
       把本段那段抠掉，剩下的就是最新的 global。拆不开就整份当 global 用。 */
    let glob = "";
    if (du && typeof du.composedWords === "function") {
      try {
        const full = String(du.composedWords(clip) || "");
        /* composedWords 会给相邻的两个 @标签补一个空格（@图片1@图片2 →
           @图片1 @图片2），所以摘本段之前先套同一条规则，否则差一个空格就
           拼不上、整份退回 global 优先，bug 又悄悄回来了。 */
        const segC = clean(seg).replace(
          /(@(?:first|last|图片\d+|视频音频\d+|视频\d+|音频\d+))(?=@)/g, "$1 ");
        /* 本段是拼接串的尾部（global + "\n" + 本段），判尾部即可精确切开 */
        if (segC && full.endsWith(segC)) { seg = segC; glob = full.slice(0, full.length - segC.length); }
        else { glob = full; }   // 切不开就保留 seg（本段会在串里出现两次，但顺序对）
      } catch (_) { /* 落回 desk_data */ }
    }
    if (!glob) {   // 文案台没给出 global（取不到 deskUI 或抛错）：退回解析 desk_data
      const w = (deskNode.widgets || []).find((x) => x.name === "desk_data");
      let st = {};
      try { st = JSON.parse((w && w.value) || "{}") || {}; } catch (_) { st = {}; }
      const segs = (st.segs && typeof st.segs === "object") ? st.segs : {};
      const key = clip || String((ui.st && ui.st.cur) || "");
      if (!seg) seg = (key && segs[key]) ? segs[key] : "";
      glob = st.global || "";
    }
    const out = [clean(seg), clean(glob)].filter(Boolean).join("\n");
    /* 段键一起记下来：`getSegWords` 见空 key 直接返回空串（csglide_desk.js:873），
       段键拿不到 → 本段整段丢失、只剩全局，而全局通常不写 @图片N —— 这是
       「点排序一个编号都没读到」最常见的原因。不把段键报出来就只能靠猜。 */
    ui.__deskSplit = { 本段: clean(seg).length, 全局: clean(glob).length,
                       段键: clip || "(空)" };
    return out;
  }

  /* 消费本媒体架的节点（refs 端口接过来的）在用的提示词。按连线反查，不认
     节点类型——导演台换了名字/换了实现照样成立。 */
  function promptTexts(clipOverride) {
    const graph = (ui.app && ui.app.graph) || null;
    if (!graph || !graph.links) return [];
    const eats = (n) => (n.inputs || []).some((s) => {
      if (!s || s.link == null || !(s.type === "H3_REFS" || s.name === "refs")) return false;
      const lk = graph.links[s.link];
      return !!lk && lk.origin_id === ui.node.id;
    });
    const out = [];
    for (const n of graph._nodes || []) {
      if (!n || n.id === ui.node.id || !eats(n)) continue;
      /* 与导演台「实际生效的提示词」同序：prompt_text 接线时外部文本整体接管，
         面板原文不再算数——判反了就会按一份早就作废的旧文本去搬素材。 */
      const up = promptNodeOf ? promptNodeOf(n) : null;
      /* 文案台（带 desk_data 控件）走 deskPrompt 取干净文本；其它文本源仍用
         最长字符串 widget 启发式兜底。 */
      const isDesk = !!(up && (up.widgets || []).some((x) => x && x.name === "desk_data"));
      let t = isDesk ? deskPrompt(up, clipOverride) : (up && upstreamTextOf ? upstreamTextOf(up) : "");
      if (!t) {
        const w = (n.widgets || []).find((x) => x.name === "h3_data");
        try { t = (JSON.parse((w && w.value) || "{}").prompt) || ""; } catch (_) { t = ""; }
      }
      /* 图像编辑台（qwen_data JSON）：global + prompt 拼成完整提示词。
         不能落到下面的最长字符串启发式——那会把整份 JSON 当文本。 */
      if (!t) {
        const w = (n.widgets || []).find((x) => x.name === "qwen_data");
        try {
          const d = JSON.parse((w && w.value) || "{}");
          t = [d.global, d.prompt].filter(Boolean).join("\n");
        } catch (_) { t = ""; }
      }
      if (!t && upstreamTextOf) t = upstreamTextOf(n);
      t = String(t || "");
      /* 写法归一化放在去重之前：`<Picture 1>` 与 `@图片1` 是同一种引用的两种
         写法，归一后去重才算得准。view 用媒体架自己的槽位（<Audio N> 要按
         视频音轨 / 独立音频的顺序展开）。 */
      if (t) {
        try { t = rackNormalize(normalizeRefs(t) || ""); } catch (_) { /* 保留原文 */ }
      }
      /* 多个消费节点（一采 / 二采各一个导演台）常常读到同一份文本。重复计入
         会让后面每份的编号都撞上「编号重复」被静默丢弃，诊断里那 49 项重复
         就是这么来的。同一份文本只算一次。 */
      if (t && !out.includes(t)) out.push(t);
    }
    return out;
  }

  /* 诊断口径（20261019）：「顺序已对齐」原来同时表示「真的对齐了」和「一个
     编号都没读到」，出问题只能靠肉眼逐格核对。现在把实情分四类报出来——读到
     几个编号、认出几个、哪个编号认不出（带上下文）、架上哪些素材根本没被点
     名。排序逻辑一行未动。 */
  /* 对**一份架况**按给定文本排一次：原地改 st.slots，返回诊断统计。
     抽成独立函数是为了「排全部段」能对每一段的快照跑同一套逻辑——素材清单是
     每段一份独立副本，逐段排不能靠切界面实现（切段会连带触发渲染与落库）。 */
  /* 定义句点名的「这一格是谁」（含括号标准名写法）。
     命中就用它，不走 ownerOfToken 的"附近找名字"启发式 —— 那一层看不见
     「@图片28（核心帧图标准名 KF_01-05）」里的 KF_01-05（20261024 现场：
     7 段有 3 段的核心帧编号全被认成"没认出名字"，一格都没挪）。
     只用 claims（"文案怎么说的"），不看 problems —— 排版本身就要拿它当依据，
     对不对由它自己判。 */
  const EMPTY_RACK = { slots: { images: [], videos: [], audios: [] } };
  function defWantOf(texts) {
    const map = new Map();
    for (const text of texts) {
      let chk = null;
      try { chk = defClaimsOf(text, EMPTY_RACK, null); } catch (_) { continue; }
      for (const c of (chk && chk.claims) || []) {
        if (c && c.claim && !map.has(c.idx)) map.set(c.idx, c.claim);
      }
    }
    return map;
  }

  function sortSlots(st, texts) {
    const done = [];        // { nm, tok } 认出名字并落位
    const noOwner = [];     // 读到编号，但附近没找到架上认得的名字
    const wantGone = [];    // 定义句点名了，但架上根本没有这件素材
    const dupSlot = [];     // 编号的主人已被更早的编号占走
    const dupIdx = [];      // 该编号已被更早的编号占了
    const rest = [];        // 架上没被任何编号点名的素材
    const claimed = new Set();
    const claimedBy = new Map();   // 槽位 → 认领它的编号（诊断用：谁抢了谁）
    let tokens = 0, total = 0;

    for (const kind of ["images", "videos", "audios"]) {
      const names = nameIndex(kind, st);
      if (!names.size) continue;
      const defWant = defWantOf(texts);
      const target = new Map();
      const noOwnerFrom = noOwner.length;   // 本 kind 的「认不出」条目从这条开始
      for (const text of texts) {
        for (const m of text.matchAll(new RegExp(TOKEN_RE[kind].source, "g"))) {
          const idx = parseInt(m[1], 10) - 1;
          if (!(idx >= 0 && idx < MAX_SLOTS)) continue;
          const tok = `@${TOKEN_LABEL[kind]}${idx + 1}`;
          tokens += 1;
          if (target.has(idx)) {
            /* 同一个编号在文本里出现两次：新模板必然如此（定义式一行 + 编号
               对照一行，都写 @图片25）。这不算冲突 —— 只有当第二次指的是
               **另一件**素材时才是真问题（一个编号指向两个素材）。
               所以这里照样去认一次主人，比对是不是同一件：同一件不报，
               不同件才报「编号重复」。 */
            const again = ownerOfToken(text, m.index, m[0].length, names);
            if (!again || again.slot !== target.get(idx)) dupIdx.push(tok);
            continue;                              // 多个节点抢同一编号：先写的赢
          }
          /* ① 定义句点名了这一格 → 直接用（最高优先级，不走位置推断） */
          const want = (kind === "images") ? defWant.get(idx) : "";
          let hit = (want && names.has(want)) ? { name: want, slot: names.get(want) } : null;
          if (!hit && want) {
            /* 定义句点名了，但架上没有这件素材 —— 单独记一条，别混进
               "没认出名字"：那一句会让用户以为是自己没写清楚，而真因是
               **素材缺失**（空位由 sortByPrompt 末尾的槽位纠错去腾）。 */
            if (!wantGone.some((w) => w.tok === tok)) wantGone.push({ tok, claim: want });
            hit = null;
          }
          /* ② 定义句没点名 → 退回"@标签附近找名字" */
          if (!hit) hit = ownerOfToken(text, m.index, m[0].length, names);
          if (!hit) { noOwner.push([tok, text, m.index, idx]); continue; }
          /* 同一件素材被两个编号点名（多半是认错了主人）：也是先写的赢，
             否则它会同时占两格，其余素材集体后移。 */
          if (claimed.has(hit.slot)) {
            dupSlot.push(`${tok}（${hit.name}已被 ${claimedBy.get(hit.slot) || "?"} 占位）`);
            continue;
          }
          target.set(idx, hit.slot);
          claimed.add(hit.slot);
          claimedBy.set(hit.slot, tok);
          done.push({ nm: hit.name, tok });
        }
      }
      /* 同一个编号在另一处出现时认出了主人（典型：新模板里
         「将 @图片25 定义为本段的空间关系参照图」认不出名字，而后面
         「图片编号对照：@图片25 对应 KF_01-02」认得出）——那前面那条
         「认不出」就不该再报，否则明明排对了却说没认出来。
         只清本 kind 的区间：三种素材的编号各是一套，不能跨 kind 清。 */
      for (let i = noOwner.length - 1; i >= noOwnerFrom; i--) {
        if (target.has(noOwner[i][3])) noOwner.splice(i, 1);
      }
      if (target.size) total += applyOrder(kind, target, st);
    }

    for (const kind of ["images", "videos", "audios"]) {
      for (const s of ((st.slots && st.slots[kind]) || [])) {
        if (!s || !s.file || claimed.has(s)) continue;
        rest.push(slotLabel(s));
      }
    }
    return { done, noOwner, dupSlot, dupIdx, rest, wantGone, tokens, total };
  }

  /* 一份架况里到底有没有素材。空快照也是对象，只看"有没有键"会被骗过。 */
  function rackHasFile(rack) {
    const s = (rack && rack.slots) || {};
    return ["images", "videos", "audios"].some((k) =>
      (Array.isArray(s[k]) ? s[k] : []).some((x) => x && x.file));
  }

  function reportOf(r) {
    const near = (t, p) => String(t).slice(Math.max(0, p - 8), Math.min(t.length, p + 18)).replace(/\n/g, "⏎");
    const cap = (arr, n) => (arr.length > n
      ? arr.slice(0, n).join("、") + ` 等 ${arr.length} 项` : arr.join("、"));
    const lines = [`读到 ${r.tokens} 个编号，认出 ${r.done.length} 个，挪动 ${r.total} 个`];
    /* 认出清单：素材多到几十张时（尤其一堆 KF_xx 的参照图），光看「认出 7 个」
       根本不知道哪张图落到了第几栏。名字→编号 一行摊开，一眼可对账。 */
    if (r.done.length) {
      lines.push("认出：" + cap(r.done.map((d) => `${d.nm}→${d.tok}`), 8));
    }
    if (!r.tokens) {
      /* 本段 / 全局各读到多少字直接摆出来：一个编号都没读到时，最常见的真因
         是「本段没取到、只剩全局」（段键对不上 / 文案台没停在这一段），而全局
         里通常不写 @图片N。不报字数就只能去开控制台翻，排查成本高得多。 */
      const sp = ui.__deskSplit || null;
      lines.push("文本里一个 @图片N / @视频N / @音频N 都没有（读的是文案台「本段 + 全局」）"
        + (sp ? `：本段 ${sp.本段} 字 / 全局 ${sp.全局} 字` : "")
        + (sp && !sp.本段
            ? ` —— 本段一个字都没读到，段键是「${sp.段键}」`
              + (sp.段键 === "(空)"
                  ? "：文案台还没认段（先在文案台点一下这一段），或没接到导演台的「提示词」口"
                  : "：文案台的 segs 里没有这一段，先在文案台切到该段确认有内容")
            : ""));
    }
    if (r.wantGone && r.wantGone.length) {
      lines.push("缺素材：" + cap(r.wantGone.map((w) => `${w.tok} 要「${w.claim}」`), 4)
        + "（文案点名了，架上没有 —— 这几格会被腾空）");
    }
    if (r.noOwner.length) {
      lines.push("认不出：" + cap(r.noOwner.map(([tok, t, p]) => `${tok}←「${near(t, p)}」`), 3)
        + "（附近没找到架上认得的名字）");
    }
    if (r.dupSlot.length) lines.push("重名占位：" + cap(r.dupSlot, 3));
    if (r.dupIdx.length) lines.push("编号重复：" + cap(r.dupIdx, 3));
    /* 只在真读到了编号时才报：一个编号都没读到时这份名单就是「架上全部素材」，
       没有信息量（那种情况上面那句「没读到 @图片N」才是要害） */
    if (r.rest.length && r.tokens) lines.push("没被点名：" + cap(r.rest, 6) + "（架上名字与文本对不上？）");
    return lines;
  }

  /* 当前段排完要把结果同步回段记忆：落库读的是 segs[cur] 而不是 ui.st.slots，
     不同步的话排完一切段／一提交，顺序就被旧副本盖回去。 */
  function syncCurToSegs() {
    const cur = (ui.st && ui.st.cur) || "";
    if (!cur || !ui.st.segs || !ui.st.segs[cur]) return;
    ui.st.segs[cur].slots = ui.st.slots;
  }

  function sortByPrompt() {
    const texts = promptTexts();
    if (!texts.length) {
      ui.toast("没找到接本媒体架的节点：把「参考素材」接到导演台的 refs 输入再点", true);
      return;
    }
    const r = sortSlots(ui.st, texts);

    /* ⚠ 槽位纠错**必须无条件跑**，并且必须在 `if (!r.total)` 那个提前返回
       **之前**（20261024 现场根因，就是这一行）。
       排序只搬"认得出来的素材"：文案写「@图片15 定义为 KF_01-05」，而架上
       根本没有 KF_01-05 时，这个编号一个主人都认不出 —— total = 0。而这恰恰
       是最该腾位的局面：第 15 格还挂着帆布包，模型会拿它当核心帧基准。
       原来 `if (!r.total) return` 紧跟在这里，纠错整段被挡在门外，于是
       「点了按钮毫无反应」。先纠后报，两件事互不依赖。 */
    syncCurToSegs();          // 纠错改的是同一份数组，段记忆必须先同源
    let vac = null;
    try {
      if (ui.vacate) vac = ui.vacate(true, null, true, texts);   // quiet + 不弹自己的 toast + 用同一份文本
    } catch (e) {
      console.warn("[媒体架] 槽位纠错失败（排序结果不受影响）:", e);
    }
    const vacLines = (vac && vac.lines) || [];
    const vacWarn = (vac && vac.warn) || [];
    const vacN = vacLines.length;

    /* 完整细节进控制台：名单可能很长，界面上只放得下摘要 */
    console.log("[媒体架] 按提示词排序诊断", {
      媒体架段位: (ui.st && ui.st.cur) || "",
      文本段数: texts.length,
      本段与全局字数: ui.__deskSplit || null,
      文本: texts.map((t) => String(t).slice(0, 600)),
      架上名字: ["images", "videos", "audios"].map((k) => [...nameIndex(k, ui.st).keys()]),
      编号数: r.tokens, 已对齐: r.done,
      认不出: r.noOwner.map(([tok]) => tok),
      缺素材: (r.wantGone || []).map((w) => `${w.tok}→${w.claim}`),
      未点名: r.rest,
      槽位纠错: vacLines,
      纠错未执行: vacWarn,
    });

    if (!r.total && !vacN) {
      /* 一格没挪不一定是坏事：本来就对齐时不该报红。真的读不到编号、
         真的认不出名字、真的缺素材，才用红色。 */
      const gone = (r.wantGone || []).length;
      const bad = !r.tokens || r.noOwner.length > 0 || gone > 0;
      flashBtn(ui.bSort, !r.tokens ? "没读到编号"
        : (gone ? "缺素材 " + gone + " 格"
          : (r.noOwner.length ? "没认出名字" : "顺序已对齐")));
      /* 20261026 用户定：**正常不弹**（「顺序已对齐」这类）—— 按钮上已经闪过短字，
         再用一条长条重复一遍纯属噪音。只有真读不到编号 / 认不出名字 / 缺素材 /
         纠错搬不动时才弹：这几种不说，用户没法自查，等于"点了没反应"。 */
      if (bad || vacWarn.length) {
        ui.toast(reportOf(r).concat(vacWarn).join(" ｜ "), true, 9000);
      }
      return;
    }
    /* 排序是显式重排语义：强制整池重建一次，保证「视频 N」标题与卡闭包
       全部按新顺序对齐（低频手动操作，一次全量成本可接受）。
       纠错自己已经渲染+落库过一遍，这里只在真的排动过时再补一次全量重建。 */
    if (r.total) { ui.renderImages(); ui.rebuildMedia(true); ui.commit(); }
    const tag = [];
    if (r.total) tag.push("已排 " + r.total);
    if (vacN) tag.push("纠位 " + vacN);
    flashBtn(ui.bSort, tag.join(" · ") || "无变化");
    /* 20261026 用户定：**成功不弹窗** —— 反馈只靠按钮上那行短字（「已排 8 · 纠位 2」）。
       其余明细（谁落到第几栏、纠了哪两格）全部只进 console 的「按提示词排序诊断」。
       原来每次点都在底部糊一条长条，素材一多要横跨半屏；等真要查明细时它已经过时。 */
  }

  /* ---- 一键排全部段 ----------------------------------------------------
     时间轴有 8 段、每段提示词不同、但素材是同一批时，逐段切过去点一次要 8 趟。
     这里一次跑完：对每一段，用**它自己的提示词**排**它自己的那份槽位清单**。

     两点前提（都已核实）：
       · 素材清单是每段一份独立副本（ui.st.segs[cid]），所以必须各排各的；
       · 文案台的 segWords / composedWords 本来就接受段身份作参数（按段身份直接
         读 st.segs[key]，不依赖界面此刻停在哪一段），所以不用真的切界面。 */
  function sortAllSegs() {
    const cur = String((ui.st && ui.st.cur) || "");
    const segs = (ui.st && ui.st.segs && typeof ui.st.segs === "object") ? ui.st.segs : {};
    const cids = [];
    if (cur) cids.push(cur);
    for (const k of Object.keys(segs)) if (k && k !== cur) cids.push(k);

    if (!cids.length) {
      ui.toast("还没认段：现在是一套全片共用的素材，点「按提示词排序」就行", true);
      return;
    }

    let moved = 0, doneSegs = 0, emptySegs = 0, noText = 0, vacN = 0, vacSegs = 0;
    const per = [];
    for (const cid of cids) {
      const isCur = cid === cur;
      const rack = isCur ? ui.st : segs[cid];
      if (!rack || !rack.slots || !rackHasFile(rack)) { emptySegs += 1; continue; }
      const texts = promptTexts(cid);
      if (!texts.length) { noText += 1; continue; }
      const r = sortSlots(rack, texts);
      per.push({ 段: cid, 编号: r.tokens, 挪动: r.total, 认不出: r.noOwner.length });
      if (r.total) {
        moved += r.total; doneSegs += 1;
        if (isCur) { syncCurToSegs(); ui.commit(); }
        else if (ui.saveSegRack) ui.saveSegRack(cid);
      }
      /* 逐段纠错：**不能只纠当前段**。"第 N 格该放谁"是每一段各自的文案说的，
         其它段的架况就在 segs 里、完全可以就地纠 —— 只纠当前段等于 8 段里
         另外 7 段的核心帧基准错了也不管（20261024）。silent=true：别连弹 8 条
         toast，明细统一进下面那一条。 */
      try {
        const v = ui.vacate ? ui.vacate(true, cid, true, texts) : null;
        const n = (v && v.lines) ? v.lines.length : 0;
        if (n) { vacN += n; vacSegs += 1; }
      } catch (_) { /* 单段纠错失败不拖垮其余段 */ }
    }

    console.log("[媒体架] 排全部段 明细", per);

    if (!moved && !vacN) {
      const why = noText ? `${noText} 段没读到提示词`
        : (emptySegs ? `${emptySegs} 段没有素材` : "各段顺序都对上了");
      flashBtn(ui.bSortAll, "没动");
      ui.toast(`全部段排序：没挪动任何素材（${why}）`, true, 9000);
      return;
    }
    ui.renderImages(); ui.rebuildMedia(true); ui.commit();
    const tag = [];
    if (moved) tag.push("已排 " + doneSegs + " 段");
    if (vacN) tag.push("纠位 " + vacN);
    flashBtn(ui.bSortAll, tag.join(" · "));
    ui.toast(`已按各段提示词重排：${doneSegs} 段，共挪动 ${moved} 个`
      + (vacN ? `；另纠正 ${vacN} 个槽位（${vacSegs} 段）` : "")
      + (emptySegs ? `（${emptySegs} 段没素材，跳过）` : ""), false, 9000);
  }

  ui.sortByPrompt = sortByPrompt;
  ui.sortAllSegs = sortAllSegs;
}
