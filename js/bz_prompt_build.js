/* bz_prompt_build.js — 编译式渲染（方案①）
 * ============================================================================
 * 一句话：**提交的提示词/素材/段身份只从「段数据」里读，不读任何面板、
 * widget、current。** 面板此刻停在哪一段，与这次提交无关。
 *
 * 为什么要有这一层（"偶发串段"的物理根因）：
 *   旧链路是「改画布 widget → graphToPrompt 取字面量 → 再打补丁覆盖」。
 *   补丁（applyToPrompt）只要有一处拿不到数据就 **静默跳过**，于是
 *   graphToPrompt 那份"此刻架子/编辑框里的字面量"就原样送了出去 —— 那正是
 *   别的段的素材与段词。表现就是"8 段里有 1~2 段和别的段一模一样"。
 *   本质是**先污染再擦**，且擦不干净时 fail-open。
 *
 * 本层的做法是把它翻过来：
 *   1. 按段身份（cid）解析出**本段**的 state / rack / 段词 —— 只查"段记忆"
 *      （工程分段、媒体架 segs[cid]、文案台 segs[cid]），不查面板；
 *   2. 拿 graphToPrompt 的结果只当**图骨架**（拓扑、静态参数、静音状态），
 *      三个 *_data 输入整块覆写成本段数据；
 *   3. 拿不到段数据时，结果是**空**，不是"别人的" —— 行为可预测、可诊断；
 *   4. 每次编译产出一份**回执**（字数/槽位数/@引用/指纹），重复段当场报警。
 *
 * 由此所有"等广播切段、等文案台拉词、sleep 一拍再提交"的时序补丁都失去
 * 存在意义：提交的正确性不再依赖"谁先谁后"。
 * ============================================================================ */
import { app } from "../../scripts/app.js";
import { rackNodeOf, deskNodeOf } from "./bz_rack.js";
import { pullSeg, pushSegText } from "./bz_seg.js";
import {
  BUILTIN_ALIAS, ALIAS_SPLIT, aliasOk, aliasInfoOf, effectiveText,
} from "./csglide_ref_text.js";

const CAST = "CSGlideCastCS";
const RACK = "CSGlideH3MediaRackCS";
const DESK = "CSGlideDeskCS";

const clone = (x) => (x == null ? x : JSON.parse(JSON.stringify(x)));

const emptyRack = () => ({
  slots: { images: [], videos: [], audios: [] }, fps: 0, audio_out: 0,
});

/* 段记录里到底有没有素材（三类槽位任一有 file）。空记录也是记录 —— 它表达
   "这一段确实没有素材"，与"查不到这一段"是两件事，必须分开。 */
function rackHasFile(rack) {
  const s = (rack && rack.slots) || {};
  for (const k of ["images", "videos", "audios"]) {
    const a = Array.isArray(s[k]) ? s[k] : [];
    if (a.some((x) => x && x.file)) return true;
  }
  return false;
}

/* 指纹：只用来"认得出两段是不是同一份东西"，所以刻意忽略无语义差异
   （空白、换行、路径前缀）。FNV-1a 32 位，够用且零依赖。
   ⚠ 必须对 **UTF-8 字节** 取值，而且必须与后端 csglide_store._fnv8 逐字一致：
   流水表里 rack_save 的 img_fp/vid_fp/aud_fp 要和这里编译回执的
   imgFp/vidFp/audFp 直接对照（"落库的素材"是不是"送出去的素材"，一个字符串
   比就知道）。对 UTF-16 码元取值会在 emoji 这类增补平面字符上与 Python 分叉。 */
const _TXT = (typeof TextEncoder !== "undefined") ? new TextEncoder() : null;
function fp32(str) {
  let h = 0x811c9dc5;
  const s = String(str == null ? "" : str);
  if (_TXT) {
    const b = _TXT.encode(s);
    for (let i = 0; i < b.length; i++) {
      h ^= b[i];
      h = Math.imul(h, 0x01000193) >>> 0;
    }
  } else {
    /* 没有 TextEncoder（极老浏览器）：退回码元，CJK 结果一致，emoji 会分叉。 */
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
  }
  return h.toString(16).padStart(8, "0");
}

const normWords = (t) => String(t || "")
  .replace(/\r\n/g, "\n").replace(/[ \t]+/g, " ")
  .replace(/\n{3,}/g, "\n\n").trim();

const baseName = (f) => String(f || "").replace(/\\/g, "/").split("/").pop();

/* 槽位签名：**按位置**取值（空槽记 "-"）—— @图片N 是位置引用，第 3 槽空着
   和第 2 槽空着是两件不同的事，不能被"压缩空槽"抹平。
   只裁**尾部**空槽：同一份素材，架面铺 9 格还是 2 格不应该算出两个指纹，
   否则审计对账会天天误报；而中间的缺口必须保留，那才是引用错位的证据。
   ⚠ 后端 csglide_store._rack_fps 必须保持同一规则（跨语言同一指纹）。 */
function rackSig(rack) {
  const s = (rack && rack.slots) || {};
  const of = (k) => {
    const out = (Array.isArray(s[k]) ? s[k] : [])
      .map((x) => (x && x.file ? baseName(x.file).toLowerCase() : "-"));
    while (out.length && out[out.length - 1] === "-") out.pop();
    return out;
  };
  return { images: of("images"), videos: of("videos"), audios: of("audios") };
}

const REF_RE = /@(first|last|图片\d+|视频音频\d+|视频\d+|音频\d+)/g;
function refsOf(text) {
  const out = [];
  const seen = new Set();
  String(text || "").replace(REF_RE, (m, t) => {
    if (!seen.has(t)) { seen.add(t); out.push(t); }
    return m;
  });
  return out;
}

/* @图片N 落在第 N 个槽位 —— 槽位空着就是缺口。只判图/视/音三类有位置语义的。 */
function refGaps(refs, sig) {
  const gaps = [];
  for (const t of refs) {
    let m = /^图片(\d+)$/.exec(t);
    if (m) { if (!sig.images[Number(m[1]) - 1] || sig.images[Number(m[1]) - 1] === "-") gaps.push("@" + t); continue; }
    m = /^视频音频(\d+)$/.exec(t);
    if (m) { if (!sig.videos[Number(m[1]) - 1] || sig.videos[Number(m[1]) - 1] === "-") gaps.push("@" + t); continue; }
    m = /^视频(\d+)$/.exec(t);
    if (m) { if (!sig.videos[Number(m[1]) - 1] || sig.videos[Number(m[1]) - 1] === "-") gaps.push("@" + t); continue; }
    m = /^音频(\d+)$/.exec(t);
    if (m) { if (!sig.audios[Number(m[1]) - 1] || sig.audios[Number(m[1]) - 1] === "-") gaps.push("@" + t); }
  }
  return gaps;
}

/* ============================================================
 * 「架面上有什么」≠「这一段送了什么」
 * ------------------------------------------------------------
 * 后端 csglide_cast._filter_refs_by_prompt 是**严格按需**的：提示词里提到
 * 哪几个 @图片N，就只送那几张，一张没提就一张都不送。所以"这一段到底给了
 * 模型什么"只能由 引用 × 本段槽位 算出来，不能拿整台架面的指纹代表。
 *
 * 20261024 真机日志就是被这两件事混用坑的：全片固定编号（每段架子上都是
 * 同样 28 张）本来是正常用法，可回执的 imgFp 算的是**整台架面**，于是 段1~4
 * 全部算出 7bde25b3，编排器喊"与 clip_0001 的参考图完全相同，八成是段数据
 * 串了" —— 而它们实际送的是 @图片11 / @图片12 / @图片13 / @图片13，前三段
 * 各不相同。用户照着这句去查"串段"，越查越像串了。
 *
 * 这个函数返回**实际送出去的那几张**：{ tok, slot, kind, file }，空格位的
 * file 为空串（= 后端会把它从提示词里摘掉）。回执、查重、结果行全部以它为准。
 * ============================================================ */
function sentRefsOf(refs, sig) {
  const out = [];
  const pick = (arr, n) => {
    const f = arr[n - 1];
    return (f && f !== "-") ? f : "";
  };
  for (const t of refs || []) {
    let m = /^图片(\d+)$/.exec(t);
    if (m) { out.push({ tok: "@" + t, slot: Number(m[1]), kind: "images", file: pick(sig.images, Number(m[1])) }); continue; }
    /* 视频音频N 必须先试，否则会被 视频N 拆成 "视频" + "音频N"。 */
    m = /^视频(?:音频)?(\d+)$/.exec(t);
    if (m) { out.push({ tok: "@" + t, slot: Number(m[1]), kind: "videos", file: pick(sig.videos, Number(m[1])) }); continue; }
    m = /^音频(\d+)$/.exec(t);
    if (m) { out.push({ tok: "@" + t, slot: Number(m[1]), kind: "audios", file: pick(sig.audios, Number(m[1])) }); }
  }
  return out;
}

/* ============================================================
 * 跨段：同一件基准被谁共用 / 哪件基准摆着没人用
 * ------------------------------------------------------------
 * 20261024 现场：段1/2/3 的核心帧分别是 KF_01-01/02/03，段4 仍是 KF_01-03
 * （复制段之后只改了数字没改名字），而 KF_01-04 一整轮没有任何一段引用它。
 * 这种错不报错、不缺图、画面看着都"对"，只是两段拿同一张图当基准 ——
 * 用户读作"参考图串了"，然后去查代码（代码没错）。
 *
 * 只认**纯 ASCII 标识符**形状的名字（KF_01-03 / A1 / scene2）：中文名
 * （陈墨白、守缺斋前堂）本来就是全片共用，逐段重复是正常的，拿它们报
 * 会满屏噪音。
 *
 * 传进来的每一项是 { idx, seg, receipt }：idx 0 起，seg 是 resolve 的结果
 * （要 defClaims / rack），receipt 要 sent。返回纯数据，显示文案留给调用方。
 * ============================================================ */
function basisOf(items) {
  const use = new Map();          /* 名字 -> { segs:[1起], toks:[] } */
  const list = Array.isArray(items) ? items : [];
  for (const it of list) {
    const seg = it && it.seg;
    if (!seg) continue;
    for (const c of seg.defClaims || []) {
      const nm = String(c.claim || "");
      if (!PURE_ID.test(nm)) continue;
      const g = use.get(nm) || { segs: [], toks: [] };
      g.segs.push((it.idx | 0) + 1); g.toks.push(c.tok);
      use.set(nm, g);
    }
  }
  const shared = [...use.entries()]
    .filter(([, g]) => g.segs.length >= 2)
    .map(([name, g]) => ({ name, segs: g.segs, toks: g.toks }));

  /* 闲置：纯 ASCII 命名的素材摆在架上，却没有一段断言它、也没有一段用
     @图片N 指到它 —— 那通常正是"该接到某一段、却一直没接上"的那一张。 */
  const usedFiles = new Set();
  for (const it of list) {
    for (const s of ((it && it.receipt && it.receipt.sent) || [])) {
      if (s.f) usedFiles.add(String(s.f).toLowerCase());
    }
  }
  const idle = [];
  const seen = new Set();
  for (const it of list) {
    const seg = it && it.seg;
    if (!seg) continue;
    const imgs = (seg.rack && seg.rack.slots && seg.rack.slots.images) || [];
    imgs.forEach((slot, k) => {
      const nm = slotLabel(slot);
      if (!nm || !PURE_ID.test(nm)) return;
      if (use.has(nm) || seen.has(nm)) return;
      const f = String((slot && slot.file) || "")
        .replace(/\\/g, "/").split("/").pop().toLowerCase();
      if (f && usedFiles.has(f)) return;
      seen.add(nm);
      idle.push({ name: nm, seg: (it.idx | 0) + 1, slot: k + 1, file: f });
    });
  }
  return { shared, idle };
}

/* 模型看到的编号：与后端 csglide_cast.build_tag_map **同一条规则** ——
   按**槽位升序**只数"已填且被引用"的槽位，图片/视频/音频各自从 1 起。
   超过上限（图 9 / 视 3 / 音 3）时后端只留编号最小的那几个，其余从提示词里
   移除（_filter_refs_by_prompt 的 cap 逻辑）——这里如实标出来，别让"送 9 张、
   第 10 张悄悄没了"再次变成只能靠猜的事。
   返回 Map(tok -> { k, dropped })，k=0 表示压根没送（空格位）。 */
const MAX_REF = { images: 9, videos: 3, audios: 3 };
function pictureOrdinals(sent) {
  const out = new Map();
  const byKind = { images: [], videos: [], audios: [] };
  for (const x of sent || []) {
    if (!x || !byKind[x.kind]) continue;
    byKind[x.kind].push(x);
  }
  for (const kind of Object.keys(byKind)) {
    const cap = MAX_REF[kind];
    const filled = byKind[kind]
      .filter((x) => x.file)
      .sort((a, b) => a.slot - b.slot);      // 槽位序 = 后端的数组序
    filled.forEach((x, i) => {
      out.set(x.tok, { k: i < cap ? i + 1 : 0, dropped: i >= cap });
    });
    for (const x of byKind[kind]) if (!out.has(x.tok)) out.set(x.tok, { k: 0, dropped: false });
  }
  return out;
}

/* ============================================================
 * 方案④（第三刀）：引用按「身份」解，不靠编号猜
 * ------------------------------------------------------------
 * 后端 csglide_cast 送模型前本来就会做这一步（alias_table + expand_aliases，
 * 用**本段**的槽位把「名字」翻成 @图片N）。问题从来不在后端，在**前端看不见**：
 *   ① 回执里的 @引用/缺口是拿规范 token 正则扫**原文**算的，文本里写「马魁」
 *      时扫不出任何引用 → 回执显示"引用 0"，实际后端送了 3 张图。回执在说谎。
 *   ② 名字在本段架上压根没有时，后端保留原文、没人报错 —— 用户以为引用了，
 *      实际那段文字只是散文，参考图一张没挂上。
 * 所以这里把「真正会送出去的那份文本」算出来，只为口径与回执，**不改存储**：
 * 段里存的永远是原文（后端注释写得很清楚，写回展开结果会让文本逐次退化）。
 * ============================================================ */

/* 真正会送进模型的文本：按本段槽位把名字展开成 @图片N。
   与后端同口径，别名开关关闭时就只做写法归一（<Picture 1> → @图片1）。

   ⚠ 20261024 起两边有**一处刻意的差异**：后端 csglide_cast.expand_aliases
   不再展开「定义句的宾语」（`将 @图片11 定义为 KF_01-01` 里的 KF_01-01），
   否则整句会退化成「定义为 @图片11」，模型再也学不到哪一号图是谁。
   这边保留原行为是因为它只服务于**回执的引用集合**，而定义句的宾语紧跟在
   同一个 @图片N 之后，展开与否都不改变这个集合（有专门的自测钉着）。
   别"为了统一"把后端那条护栏删掉。 */
function resolveWords(text, rack, aliasOn) {
  const view = (rack && rack.slots) || {};
  try {
    return effectiveText(text, view, aliasOn !== false);
  } catch (_) {
    return String(text || "");
  }
}

/* 文本里点了名、但这次**不会解析成功**的引用。
   只认带 @ 前缀的（`@马魁`）：裸写名字在散文里随处可见，逐条报会把真问题淹掉，
   而且散文中出现角色名本来就是正常的。
   返回 [{ name, why }]，why: "absent"（本段架上没这件素材）/ "alias-off"（开关关着）。 */
const AT_NAME_RE = /@([^\s@,，。、；;:：()（）\[\]【】"'“”]{2,40})/g;
/* `@图片1定义为珽瑶` 这种定义句没有标点断开，AT_NAME_RE 会把「图片1定义为珽瑶」
   **整串**当成一个名字。它当然查不到，于是报一条 why=absent 的假警报 ——
   20261026 现场：提示词里明明只有 @图片1 / @音频1 两个引用，却报了
   「图片1定义为珽瑶」「音频1定义为珽瑶」两条"架上没有这个名字"。
   这里按"开头是不是编号写法"再挡一次：真正的引用就是开头那一段，位置有没有
   素材归 refGaps 管，不该在这儿重复报。 */
const BUILTIN_HEAD = /^(?:视频音频|视频|音频|图片)\s*\d+/;
function unresolvedRefsIn(text, rack, aliasOn) {
  const view = (rack && rack.slots) || {};
  let map = {};
  try { map = aliasInfoOf(view).map; } catch (_) { map = {}; }
  const out = [];
  const seen = new Set();
  AT_NAME_RE.lastIndex = 0;
  let m;
  while ((m = AT_NAME_RE.exec(String(text || "")))) {
    const nm = m[1];
    if (seen.has(nm)) continue;
    /* @图片3 / @first / @video1 这类规范写法不是"名字"，它们由编号寻址，
       缺槽位归 refGaps 管，不在这里重复报。 */
    if (BUILTIN_ALIAS.test(nm)) continue;
    /* `@图片1定义为珽瑶`：整串里真正被引用的只是开头那段编号写法（见 BUILTIN_HEAD）。 */
    if (BUILTIN_HEAD.test(nm)) continue;
    if (!aliasOk(nm)) continue;
    seen.add(nm);
    if (map[nm]) {
      /* 架上有这个名字，但开关关着 → 也不会展开 */
      if (aliasOn === false) out.push({ name: nm, why: "alias-off" });
      continue;
    }
    out.push({ name: nm, why: "absent" });
  }
  return out;
}

/* ============================================================
 * 定义句对账（20261023 第三刀配套，对应"@图片15 指向帆布包"）
 * ------------------------------------------------------------
 * 文案里最要命的一类句子是「将 @图片15 定义为 KF_01-05」：它同时断言了
 * 「第 15 格是什么」。而 @图片N 是**位置**引用 —— 位置会被拖拽换位、会被删槽、
 * 会被「按提示词排序」搬动，句子却不会跟着变。于是文案说 15 是 KF_01-05，
 * 架上第 15 格其实是「帆布包」，而 KF_01-05 自己安静地躺在第 7 格。
 * 这种错位不报错、不缺图、画面还可能"看着还行"，是最难查的一类。

 * 判据同样是字面的，不猜语义，但**两种写法都要认**：
 *   ① 名字在"定义为"后面：`将 @图片15 定义为 KF_01-05（本段空间关系参照图…）`
 *   ② 名字在**括号里的标准名**：`将 @图片28（核心帧图标准名 KF_01-05）
 *      定义为核心帧参考图（…）`
 * ② 是 20261024 现场补的：只认 ① 时，用户工程里 7 段有 3 段的核心帧定义句
 * **一句都报不出来**（真名写在括号里，"定义为"后面是描述词）。那 3 段的关键
 * 画面基准全是错的，而体检一片安静 —— 这正是"最难查"那一类该抓的。
 *
 * 报不报分三档，区别是**硬证据到哪一步**：
 *   · moved   —— 名字躺在本段**别的格子** → 改这句话的编号就行；
 *   · missing —— 本段没有，但**别的段**有 → 从那一段拿过来，或改编号；
 *   · missing —— 全片都没有 → **素材缺失**，得先把这张图导入。
 * 描述性说法（`定义为核心帧参考图` 这种）不单独开口 —— 只有当它带的括号里
 * 点名了具体素材、而那件素材找不到时才报。
 * ============================================================ */
const DEF_FWD = /@图片\s*(\d+)\s*(?:定义\s*为|定义|对应|即为|=|＝)\s*([^\s（(,，。；;、]+)/g;
const DEF_REV = /([^\s（(,，。；;、@]+)\s*(?:定义\s*为|定义|对应|即为)\s*@图片\s*(\d+)/g;
/* 紧跟在 @图片N 后面的括号：核心帧图**标准名** 就写在里面。 */
const DEF_PAREN = /@图片\s*(\d+)\s*[（(]([^）)]*)[）)]/g;
/* 括号里的"标准名/名称/名/即 X" —— X 只取 ASCII 标识符形状，中文描述一律不算
   （`核心帧图标准名` 里那三个字会被"标准名"整块吃掉，剩下的才是真名）。 */
const STD_NAME = /(?:标准名|名称|名字|名|即)\s*[:：]?\s*([A-Za-z0-9_.\-]+)/;
/* 纯 ASCII 标识符（KF_01-05 / A1 / scene2）—— 素材名的形状。
   中文一定是描述（`核心帧参考图`），不该被当成素材名去架上比对。 */
const PURE_ID = /^[A-Za-z0-9_.\-]+$/;
/* 描述性名词（这一格"是什么东西"），不是素材名：不该要求架上有同名素材。 */
const DEF_DESC = /[图景镜帧]|参照|参考|素材|画面/;

/* 从括号内容里取素材名：优先「标准名 X」，其次整个括号就是个标识符。
   取不到返回 "" —— 那就是一行纯描述，不参与对账。 */
function parenName(inner) {
  const s = String(inner || "");
  const m = STD_NAME.exec(s);
  if (m) return m[1];
  const t = s.trim();
  return PURE_ID.test(t) ? t : "";
}

/* 卡片上显示的名字：别名优先、文件名主干兜底 —— 与 csglide_rack_sort 的
   slotLabel 同一套取值规则，保证"对账里报出来的名字"就是用户看到的那个。 */
function slotLabel(slot) {
  const raw = slot && slot.alias;
  const first = String(Array.isArray(raw) ? raw.join("，") : (raw || ""))
    .split(ALIAS_SPLIT).map((s) => String(s).trim()).filter(Boolean)[0];
  return first || baseName((slot && slot.file) || "").replace(/\.[^.]+$/, "");
}

/* 名字归一：去扩展名、小写、去分隔与标点。只用来判"是不是同一个名字"，
   所以宽松一点没有副作用（判错的方向是"算一样"，不会误报）。 */
const flatName = (s) => String(s || "")
  .replace(/\.(png|jpe?g|webp|bmp|gif|tiff?|mp4|mov|webm|wav|mp3)$/i, "")
  .toLowerCase()
  .replace(/[\s_\-·．.,，、:：;；()（）\[\]【】]/g, "");
function sameName(a, b) {
  const x = flatName(a), y = flatName(b);
  if (!x || !y) return false;
  return x === y || x.includes(y) || y.includes(x);
}

/* 返回 { claims, problems }。
   claims 是"文案怎么说的"全量（不判对错，给回执用）；
   problems 是"说的和架上不一样"的那几条。
   nameElsewhere 是可选的**跨段查找**回调：给定名字，返回它在哪一段的哪一格
   （{cid, idx}）或 null。抽成回调是为了让这个函数保持纯 —— 自测里可以喂假的
   返回值，不必真的搭一整个工程。 */
function defClaimsOf(text, rack, nameElsewhere) {
  const imgs = ((rack && rack.slots && rack.slots.images) || []);
  /* 同一格可能有两处候选：defined = "定义为"后面那个；paren = 括号里的标准名。
     先都收着，最后挑"看着像素材名"的那个（见下面）。 */
  const cand = new Map();
  const put = (idx, field, v) => {
    const i = Number(idx) - 1;
    if (!(i >= 0)) return;
    const c = String(v || "").trim();
    if (!c) return;
    let e = cand.get(i);
    if (!e) { e = {}; cand.set(i, e); }
    if (!e[field]) e[field] = c;      // 同一格同一来源只认第一条
  };
  let m;
  const t = String(text || "");
  DEF_FWD.lastIndex = 0;
  while ((m = DEF_FWD.exec(t))) put(m[1], "defined", m[2]);
  DEF_REV.lastIndex = 0;
  while ((m = DEF_REV.exec(t))) put(m[2], "defined", m[1]);
  DEF_PAREN.lastIndex = 0;
  while ((m = DEF_PAREN.exec(t))) put(m[1], "paren", parenName(m[2]));

  const claims = [], problems = [];
  for (const [i, e] of [...cand.entries()].sort((a, b) => a[0] - b[0])) {
    /* 挑"这一格到底被说成是谁"：
       · 「定义为 KF_01-05」→ 就是它（不是描述词）；
       · 「定义为核心帧参考图（…标准名 KF_01-05）」→ 前者是描述，取括号里的；
       · 两者都是描述 → 这是一行纯说明，不参与对账。 */
    let claim = "";
    if (e.defined && !DEF_DESC.test(e.defined)) claim = e.defined;
    else if (e.paren) claim = e.paren;
    else claim = e.defined || "";
    if (!claim || DEF_DESC.test(claim)) continue;   // 纯描述句：不算断言

    const actual = slotLabel(imgs[i]);
    const tok = "@图片" + (i + 1);
    claims.push({ tok, idx: i, claim, actual });
    if (!actual) continue;        // 空格位：归 refGaps 报，别在这儿重复一遍
    if (sameName(claim, actual)) continue;

    /* 一档：本段别的格子上有它吗？—— 有，就是位置漂移，改编号即可。 */
    let at = -1;
    for (let k = 0; k < imgs.length; k++) {
      if (k === i) continue;
      if (sameName(claim, slotLabel(imgs[k]))) { at = k; break; }
    }
    if (at >= 0) {
      problems.push({ kind: "moved", tok, idx: i, claim, actual,
                      at: at + 1, atTok: "@图片" + (at + 1) });
      continue;
    }
    /* 二档：本段没有 —— 那**别的段**有没有？有就说明素材在，只是没摆到这一段。 */
    let el = null;
    try { el = typeof nameElsewhere === "function" ? nameElsewhere(claim) : null; }
    catch (_) { el = null; }
    problems.push({ kind: "missing", tok, idx: i, claim, actual,
                    elsewhere: el && el.cid ? { cid: el.cid, idx: el.idx } : null });
  }
  return { claims, problems };
}

/* 一条问题压成一行（结果行 / 段体检共用同一句文案，两边说法不会打架）。
   落点必须是**下一步能做什么**，不能只是"对不上"。 */
function defProblemText(p) {
  const head = `${p.tok} 文案说是「${p.claim}」，这一格实际是「${p.actual}」`;
  if (p.kind === "moved") {
    return `${head}——「${p.claim}」在${p.atTok}（第 ${p.at} 格），把这句话的编号改一下`;
  }
  if (p.elsewhere && p.elsewhere.cid) {
    return `${head}——本段没有「${p.claim}」，它在 ${p.elsewhere.cid} 的第 `
      + `${p.elsewhere.idx + 1} 格，从那一段拿过来或把编号改成那一段的`;
  }
  return `${head}——全片都没有叫「${p.claim}」的素材：这张图还没导入，`
    + `先把 ${p.claim} 放进 input 目录并拖上架，再把这句话的编号改成它那一格`;
}

/* 跨段查找：这个素材名在**本工程别的段**里有没有？（20261024）
   只在出现 missing 时才真的去扫 —— 多数工程一次都不会触发。

   为什么值得扫："文案写了 KF_01-05 但这一段没有"有两种完全不同的性质 ——
     · 别的段有  → 素材在，只是没摆到这一段（复制/改编号就行）；
     · 全片都没有 → **素材缺失**，那张图根本没导入。
   两种的下一步完全不一样，混成一句话报，用户只能干瞪眼。

   惰性求值 + 一次缓存：遍历全部段 + 解析每段 rack 不便宜，但一次编译最多
   扫一遍，而且只有真的缺东西时才付这个代价。 */
function nameElsewhereOf(h3, shots, selfCid) {
  let cache = null;
  const self = String(selfCid || "");
  return (name) => {
    if (cache === null) {
      cache = new Map();
      if (typeof h3.rackSnapshot !== "function") return null;
      for (const s of shots || []) {
        const c = String((s && s.clip) || "");
        if (!c || c === self) continue;
        let r = null;
        try { r = h3.rackSnapshot(c); } catch (_) { r = null; }
        const imgs = r && r.slots && r.slots.images;
        if (!Array.isArray(imgs)) continue;
        imgs.forEach((slot, i) => {
          const nm = slotLabel(slot);
          if (nm && !cache.has(nm)) cache.set(nm, { cid: c, idx: i });
        });
      }
    }
    return cache.get(name) || null;
  };
}

class PromptBuilder {
  constructor() {
    /* cid -> {wordFp, imgFp, fp, at}：只用来判"两段是不是同一份东西"。
       不持久化 —— 它是本次会话的观察窗，落库那件事交给 bz_audit。 */
    this._seen = new Map();
    /* 期一（20261031）：cid -> {text, has, src}，由 primeDesk 填。
       单次编译的取值缓存：compile 前 prime 一次，resolve 直接读它。
       不持久化 —— 编译取数每次都该问最新的库。 */
    this._libWords = new Map();
  }

  /* 工程换了 / 重新读档：观察窗作废（否则新工程的段会被拿去和旧工程比）。 */
  reset() { this._seen.clear(); this._libWords.clear(); }

  /**
   * 期一（20261031）：段词**读库**，不再只在文案台的内存副本里翻。
   *
   * 为什么必须换取数源：内存副本 `st.segs[cid]` 在渲染循环里是最不可靠的那份
   * —— 渲染锁冻结后端回灌、切段时中央对账会被丢弃、临时键搬迁还可能把别的段
   * 的词搬到本段名下。越靠后的段越可能缺键或装着错的词，而后端（20261030 起）
   * 只在"提交里没这个键"时才问库，凭空写的空键把兜底短路了。
   *
   * 库是按 cid 一段一键的 —— 结构上拿不到别的段的词，这是根治，不是补丁。
   *
   * 顺序必须是「先写穿、再读」：本地刚编辑的词可能还在防抖窗口里，直接读库会
   * 读到旧值（20261030「编辑后第二次运行输出旧词」就是这么来的）。先把本段本地
   * 值推进库，再 force（绕过缓存）读回来，读到的必然是最新的那份。
   */
  async primeDesk(castNode, cid) {
    this._libWords.clear();
    cid = String(cid || "");
    if (!cid) return;

    const h3 = castNode && castNode.h3ui;
    const nm = (h3 && typeof h3.castName === "function")
      ? String(h3.castName() || "") : "";
    /* 本地副本只用来"写穿"和"库里没有时兜底"，不作为取数源。 */
    const dnode = deskNodeOf(castNode);
    let local = "", localHas = false;
    if (dnode && dnode.deskUI && typeof dnode.deskUI.snapshot === "function") {
      const snap = dnode.deskUI.snapshot();
      const segs = (snap && snap.segs) || {};
      if (Object.prototype.hasOwnProperty.call(segs, cid)) {
        localHas = true;
        local = String(segs[cid] || "");
      }
    }
    /* 执行真相 = 本次提交（与 csglide_desk.compose 同口径）。库只兜底
       「这一段现在没词」，绝不反盖用户刚改的 / 视频里恢复的那份 ——
       20261106：编译期读库再写回提交，正是「改回 a 却出 c」「拖旧视频
       回来显示最新词」的根因。 */
    const fromVideo = !!(castNode && castNode._bzVideoSnap);
    if (!nm || fromVideo) {
      /* 还原态用临时片名，推库/读库只会把旧片子的段词搅乱。 */
      this._libWords.set(cid, localHas
        ? { text: local, has: true, src: fromVideo ? "视频还原(本次提交)" : "local(读不到片名)" }
        : { text: "", has: false, src: "缺词" });
      return;
    }
    /* 写穿：把本次提交的词同步进库；冲突照样明说，但**不改本次用词**。 */
    if (localHas && local) {
      try {
        const r = await pushSegText(nm, cid, local);
        if (r && r.conflict) {
          console.warn("[编译] 本段词版本冲突（本次仍按提交跑）：" + cid
                       + " 中央=" + ((r.text || "").length) + "字"
                       + " / 提交=" + local.length + "字");
        }
      } catch (_) {
        console.warn("[编译] 本段词写库失败（本次仍按提交跑）：" + cid);
      }
    }
    /* 这一读只为刷新版本号 / 在提交没词时兜底，不再是取数源。 */
    let libTxt = "";
    try {
      const s = await pullSeg(nm, cid, { force: true });
      libTxt = (s && s.desk_text != null) ? String(s.desk_text || "") : "";
    } catch (_) {
      console.warn("[编译] 读中央库失败，本次按提交里的词跑：" + cid);
    }
    /* 用户在段表里真删空也是本次提交的意图，键在就不许库填回。 */
    if (localHas) {
      this._libWords.set(cid, {
        text: local, has: true, src: local ? "本次提交" : "本次提交(用户删空)",
      });
    } else if (libTxt) {
      this._libWords.set(cid, { text: libTxt, has: true, src: "中央库兜底" });
    } else {
      this._libWords.set(cid, { text: "", has: localHas, src: localHas ? "本次提交(空)" : "缺词" });
    }
  }

  /* ---------------------------------------------------------------
   * ① 解析：按段身份取本段的权威数据
   * ---------------------------------------------------------------
   * cid 为空（新段还没登记）时退化为"当前段" —— 这是唯一允许的退化，
   * 因为此时不存在"另一个段"可以串。 */
  resolve(castNode, cid, idxHint) {
    const h3 = (castNode && castNode.h3ui) || null;
    if (!h3) throw new Error("导演台面板还没就绪（h3ui 缺失）—— 等一下再试");

    const proj = typeof h3.proj === "function" ? h3.proj() : null;
    const shots = (proj && Array.isArray(proj.shots)) ? proj.shots : [];
    cid = cid ? String(cid) : "";

    let i = -1;
    if (cid) {
      i = shots.findIndex((s) => s && (String(s.clip || "") === cid
        || String(s.id || "") === cid));
    } else {
      /* cid 为空（新段还没登记）：优先用调用方给的段序（段体检逐行点名时用），
         否则就是"当前段" —— 此时不存在"另一个段"可以串，退化是安全的。 */
      const hint = Number(idxHint);
      i = (Number.isInteger(hint) && hint >= 0 && hint < shots.length) ? hint
        : ((proj && proj.idx >= 0 && proj.idx < shots.length) ? proj.idx : -1);
    }
    if (i < 0) {
      throw new Error(cid
        ? `工程里没有段 ${cid}（可能刚被删掉、或换了工程）`
        : "没有当前段 —— 先在总览轴上选一段");
    }
    const shot = shots[i];
    const warnings = [];

    /* --- state：段快照。调用方（queueOnce）会先 stash 一次，所以它就是本段最新值。
       绝不退回面板 ui.st：那是"此刻屏幕上的那一段"，正是串段的来源。 --- */
    let state = clone(shot.state);
    if (!state || typeof state !== "object") {
      throw new Error(`第 ${i + 1} 段（${cid || shot.id || "未登记"}）没有面板状态 —— 无法编译`);
    }
    /* 身份三件套一律按工程重写：段快照里的 chain 可能是很久以前的，
       name 一空后端就写进别的片子目录，clip 一空就当成"新建一段"。 */
    const name = typeof h3.castName === "function" ? String(h3.castName() || "") : "";
    state.chain = state.chain || {};
    /* 片名读不到（工程 properties 还没恢复）时**别清空**：留着快照里的旧名字，
       总好过让后端把这一段写进另一个空名字的片子目录。 */
    if (name || !state.chain.name) state.chain.name = name;
    state.chain.clip = cid;                       /* 未登记就留空 = 后端新建 */
    state.chain.shot = String(shot.id || state.chain.shot || "");

    /* --- rack：段记忆优先，工程快照兜底，都没有就是空。
       三段来源全部按 cid 取，与"架子此刻停在哪一段"无关。 --- */
    let rack = null, rackSrc = "";
    try {
      if (typeof h3.rackSnapshot === "function") {
        rack = h3.rackSnapshot(cid || "");
        if (rack) rackSrc = "rack.segs";
      }
    } catch (_) { /* 媒体架节点不在 / 旧实例：走下面的兜底 */ }
    if ((!rack || !rackHasFile(rack)) && shot.rack && rackHasFile(shot.rack)) {
      rack = clone(shot.rack);
      rackSrc = "shot.rack";
    }
    if (!rack) {
      rack = (shot.rack && typeof shot.rack === "object") ? clone(shot.rack) : emptyRack();
      rackSrc = rackSrc || (shot.rack ? "shot.rack(空)" : "空");
    }

    /* --- desk：段词按 cid 从文案台的段表里取。
       不走 segWords() —— 那个函数在"正编辑着这一段"时会把**编辑器文本**
       回写进段表（它是给实时预览用的）；编译期不能有这个副作用，否则
       一个还没刷新的编辑框就能把权威段词盖掉。 --- */
    const dnode = deskNodeOf(castNode);
    let deskWords = "", deskGlobal = "", alias = null, deskHasKey = false, deskSrc = "";
    /* 片子级与别名开关仍从文案台快照读（期二把它们一起并入库）；
       **本段词**优先用 primeDesk 读回来的库值。 */
    if (dnode && dnode.deskUI && typeof dnode.deskUI.snapshot === "function") {
      const snap = dnode.deskUI.snapshot();
      if (snap) {
        deskGlobal = String(snap.global || "");
        alias = snap.alias === true;
      }
    }
    const primed = this._libWords.get(cid);
    if (primed) {
      deskHasKey = !!primed.has;
      deskWords = String(primed.text || "");
      deskSrc = primed.src;
    } else if (dnode && dnode.deskUI && typeof dnode.deskUI.snapshot === "function") {
      const snap = dnode.deskUI.snapshot();
      const segs = (snap && snap.segs) || {};
      /* 段词**只按真 cid 查**（20261031）。
           以前 cid 查不到就退回 segs[shot.id]（工程内部 uid）—— uid 是历史
           双身份的残留键，命中就拿到**别的段**的词，这正是"后面的段被前面的
           段污染"的一条直接通路。段表现在的规矩是只留真 clip 键（临时键由
           文案台 migrateTempSeg 各搬各的），uid 键出现即异常。
           查不到就老实走"缺词"路径并出声 —— 拿别的键顶数比缺词便宜得多。 */
      if (cid && Object.prototype.hasOwnProperty.call(segs, cid)) {
        deskHasKey = true;
        deskWords = String(segs[cid] || "");
        deskSrc = "desk.segs(未读库)";
      } else if (cid) {
        const uidHit = String(shot.id || "") !== cid
          && Object.prototype.hasOwnProperty.call(segs, String(shot.id || ""));
        console.warn("[编译] 文案台段表里没有本段（" + cid + "）—— 本段词按缺词处理"
          + (uidHit ? "；⚠ 发现 uid 旧键残留，本次**不使用**（那可能装着别的段的词），请把这段词重新粘一遍" : "")
          + "。片子级照送");
      }
    }

    /* 段身份还没拿到真 clip（新段未登记）：词只存在 __new__ 临时键里。
       让它随本次提交走，不写进段表、不进中央库 —— 正是 isRealCid 挡掉的键。 */
    if (!/^clip_/i.test(cid) && !deskWords && dnode && dnode.deskUI
        && typeof dnode.deskUI.snapshot === "function") {
      const snap = dnode.deskUI.snapshot();
      const segs = (snap && snap.segs) || {};
      const curK = String((snap && snap.curKey) || "");
      let t = (curK && Object.prototype.hasOwnProperty.call(segs, curK))
        ? String(segs[curK] || "") : "";
      if (!t) {
        const tmp = Object.keys(segs).find((x) => x.startsWith("__new__"));
        if (tmp) t = String(segs[tmp] || "");
      }
      if (!t && castNode && castNode._bzVideoSnap) {
        /* 还原态把段 id 清空了（B1 不带旧档案），词仍按原 clip 键留在段表里。 */
        const real = Object.keys(segs).find((x) => /^clip_/i.test(x));
        if (real) t = String(segs[real] || "");
      }
      if (t) {
        deskWords = t;
        deskHasKey = true;
        deskSrc = (castNode && castNode._bzVideoSnap)
          ? "视频还原(段表)" : "本地临时段(未登记)";
      }
    }

    /* 真正会送出去的词：接了文案台就是「片子级 + 本段」，没接就是面板里的
       state.prompt。与后端 csglide_desk.compose_text 同口径。 */
    const effWords = dnode
      ? [normWords(deskGlobal), normWords(deskWords)].filter(Boolean).join("\n")
      : normWords(state.prompt);

    const sig = rackSig(rack);
    /* 别名开关的口径必须与后端一致：没接文案台时后端 `cfg.get("alias")` 是
       None → 按 True 处理，所以这里 alias===null 也当开。差这一次，回执就会
       和实际送出去的东西对不上，而且只在"接了名字、没接文案台"时才发作。 */
    const aliasOn = (alias === null) ? true : alias === true;
    /* 引用一律从**展开后**的文本里数，这才是模型真正看到的那份。
       wordFp 仍然对**原文**算 —— 后端是拿库里的原文算指纹的，两边必须同一份
       输入，否则对账天天假警报。这两件事看着矛盾，其实是两个不同的用途。 */
    const resolvedWords = resolveWords(effWords, rack, aliasOn);
    const refs = refsOf(resolvedWords);
    const gaps = refGaps(refs, sig);
    /* 实际送出去的那几张（引用 × 本段槽位）。查重、结果行都用它 ——
       见 sentRefsOf 上面那段：架面相同不代表送出相同。 */
    const sent = sentRefsOf(refs, sig);
    const unresolved = unresolvedRefsIn(effWords, rack, aliasOn);
    /* 定义句按**原文**对账：`将 @图片3 定义为 陈九一` 里的 陈九一 是作者写的
       断言，别名开不开都一样。按展开后的文本对，名字已经被换成 @图片3，
       这句话就自己变成 "定义为 @图片3"，什么都对不出来。 */
    const defChk = defClaimsOf(effWords, rack, nameElsewhereOf(h3, shots, cid));
    const defProblems = defChk.problems;

    /* @first / @last 走导演台的首尾帧端口（或槽位框），**与媒体架无关** ——
       不能拿它们去触发"媒体架记录查不到"。20261026 现场：首帧图从端口正常
       送入、提示词写 @first，这里却报"已按空素材提交"，把人指去媒体架里找了
       一顿（连我都被这条带偏过一次）。只有 @图片N/@视频N/@音频N 才是媒体架引用。
       槽位框那条路 20261108 修好了：提交编译现在保留 slots.first / last，
       别再整块删 slots，否则这里写的「或槽位框」又会变成空话。 */
    const rackRefs = refs.filter((r) => r !== "first" && r !== "last");
    if (rackSrc === "空" && rackRefs.length) {
      const _rk = rackRefs.map((r) => "@" + r).join("、");
      /* 首尾帧模式不认 @图片N/@视频N：那个模式媒体架根本不参与，写了也只是
         普通文字。这时让人去媒体架里找记录是错的方向，直接说清该写 @first。 */
      warnings.push(state.mode === "fl2va"
        ? `第 ${i + 1} 段（${cid}）提示词里写了 ${_rk}，但本段是「首/尾帧」模式 —— `
          + `这个模式只认 @first 和 @last，${_rk} 不会被当成参考图，只是普通文字。`
          + `首帧请在提示词里写 @first`
        : `第 ${i + 1} 段（${cid}）提示词引用了 ${_rk}`
          + `，但工程里查不到这一段的媒体架记录 —— 已按空素材提交（不再退回画布上别的段）`);
    }
    const absent = unresolved.filter((u) => u.why === "absent").map((u) => "@" + u.name);
    if (absent.length) {
      warnings.push(`第 ${i + 1} 段（${cid}）文本里写了 ${absent.join("、")}，`
        + `但本段媒体架上没有这件素材 —— 它不会变成参考图，只是普通文字`);
    }
    const off = unresolved.filter((u) => u.why === "alias-off").map((u) => "@" + u.name);
    if (off.length) {
      warnings.push(`第 ${i + 1} 段（${cid}）的 ${off.join("、")} 不会生效：文案台的`
        + `「别名模式」是关着的，只有显式写 @图片N 才会被当成引用`);
    }
    /* 定义句错位：文案断言"第 N 格是谁"，但第 N 格实际不是它。moved 那档还
       能指出它现在在第几格 —— 这正是"拖过槽位之后句子没跟着改"的直接证据。 */
    const moved = defProblems.filter((p) => p.kind === "moved");
    if (moved.length) {
      warnings.push(`第 ${i + 1} 段（${cid}）定义句与架上位置对不上：`
        + moved.map(defProblemText).join("；")
        + `。@图片N 是位置引用，格子一挪这句话就不成立了`);
    }
    /* 素材缺失（20261024 现场：7 段里有 3 段的核心帧图全片都没有，体检却一片
       安静）。分两句话说：别的段有 = 拿过来就行；全片都没有 = 得先导入。 */
    const gone = defProblems.filter((p) => p.kind === "missing");
    const near = gone.filter((p) => p.elsewhere && p.elsewhere.cid);
    if (near.length) {
      warnings.push(`第 ${i + 1} 段（${cid}）这几件素材本段没摆，但别的段有：`
        + near.map(defProblemText).join("；"));
    }
    const lost = gone.filter((p) => !p.elsewhere);
    if (lost.length) {
      warnings.push(`第 ${i + 1} 段（${cid}）文案点名的素材全片都没有：`
        + lost.map(defProblemText).join("；")
        + `。这几格现在挂着别的图，模型会拿错图当基准`);
    }

    return {
      cid, idx: i, shotId: String(shot.id || ""), name,
      state, rack, deskWords: normWords(deskWords), deskGlobal: normWords(deskGlobal),
      deskHasKey,
      alias, aliasOn, hasDesk: !!dnode, effWords, resolvedWords, refs, gaps, sent,
      unresolved, defClaims: defChk.claims, defProblems, sig, warnings,
      src: { state: "shot.state", rack: rackSrc,
             desk: dnode ? (deskSrc || "desk.segs") : "(无文案台)" },
      slots: {
        images: sig.images.filter((x) => x !== "-").length,
        videos: sig.videos.filter((x) => x !== "-").length,
        audios: sig.audios.filter((x) => x !== "-").length,
      },
    };
  }

  /* ---------------------------------------------------------------
   * ② 回执：这次编译到底送了什么（人可读 + 可对账）
   * --------------------------------------------------------------- */
  receiptOf(seg) {
    /* 真正送出去的素材：按「引用 × 本段槽位」取，空格位不算。
       排序是为了让"同一套素材、引用顺序不同"也算同一套 —— 集合语义。 */
    const sent = seg.sent || [];
    const sentFiles = sent.filter((x) => x.file)
      .map((x) => x.kind + ":" + x.slot + ":" + x.file)
      .sort();
    const rec = {
      cid: seg.cid, idx: seg.idx, at: Date.now(),
      name: seg.name, words: seg.effWords.length,
      slots: seg.slots, refs: seg.refs, gaps: seg.gaps,
      src: seg.src, alias: seg.alias, aliasOn: seg.aliasOn,
      unresolved: seg.unresolved,
      /* 送出去的是哪几张（人可读，也能进流水对账）。tokens 里带空格位会留 file:"",
         用来解释"这一段为什么少了一张"。 */
      sent: sent.map((x) => ({ t: x.tok, s: x.slot, k: x.kind, f: x.file })),
      /* 模型读到的编号（<Picture 6>）。文案台显示的是 @图片11，模型看到的是
         第 6 张 —— 这两个数不一样，正是"我看着对、它引用错"最容易卡住的地方。 */
      pics: Object.fromEntries(pictureOrdinals(sent)),
      /* 定义句错位：回执只留能对账的字段（谁在第几格、文案说是谁、实际是谁），
         不留整句 —— 回执要能进流水，塞长文就废了。 */
      defProblems: (seg.defProblems || []).map((p) => ({
        k: p.kind, tok: p.tok, claim: p.claim, actual: p.actual, at: p.at || 0,
        elsewhere: p.elsewhere && p.elsewhere.cid
          ? { cid: p.elsewhere.cid, idx: p.elsewhere.idx } : null,
      })),
      /* 别名展开前后的字符数：两者不等，说明文本里确实有名字被换成了编号。
         不单独存展开后的全文 —— 回执要能进流水、能一眼看完，塞一篇长文就废了。 */
      resolvedChars: String(seg.resolvedWords || "").length,
      wordFp: fp32(seg.effWords),
      /* imgFp 仍然是**架面**指纹：后端 csglide_store 的 rack_save 流水按它
         对账"落库的架子是不是这一台"，口径不能动（自测【1】钉着）。
         sendFp 才是"这一段送出去的那几张"，查重、给用户看的判断都用它。 */
      imgFp: fp32(seg.sig.images.join("|")),
      vidFp: fp32(seg.sig.videos.join("|")),
      audFp: fp32(seg.sig.audios.join("|")),
      sendFp: fp32(sentFiles.join("|")),
      sendN: sentFiles.length,
      dupOf: "", dupWhy: "", dupFp: "",
    };
    rec.fp = fp32([rec.wordFp, rec.imgFp, rec.vidFp, rec.audFp].join(""));
    return rec;
  }

  /* 与本会话里其它段比对：词一样 / **送出去的素材**一样 → 记下来。
     只报"别人和我一样"，不报"我和我自己一样"（同一段重跑不算重复）。 */
  checkDup(rec) {
    const key = rec.cid || `#${rec.idx}`;
    for (const [ok, o] of this._seen) {
      if (ok === key) continue;
      if (!rec.dupOf && o.wordFp === rec.wordFp && rec.words > 0) {
        rec.dupOf = o.cid || `#${o.idx}`;
        rec.dupWhy = "段词完全相同";
        rec.dupFp = rec.wordFp;
        continue;
      }
      /* ⚠ 比的必须是 sendFp，不是 imgFp：
         全片固定编号时每段的架子上都是同一批素材（正常用法），拿架面指纹比
         会把整部片都判成"段数据串了"（20261024 真机：段1~4 全是 7bde25b3，
         而它们送的其实是 @图片11/12/13/13 —— 前三段并不相同）。
         真正该报的是"这两段送给模型的图一模一样"。 */
      if (!rec.dupOf && rec.sendN > 0 && o.sendFp === rec.sendFp) {
        rec.dupOf = o.cid || `#${o.idx}`;
        rec.dupWhy = `送出的参考图完全相同（都是这 ${rec.sendN} 张）`;
        rec.dupFp = rec.sendFp;
      }
    }
    this._seen.set(key, rec);
    return rec;
  }

  /* 只体检不编译（给 bz_audit 的段体检用）。 */
  inspect(castNode, cid, idxHint) {
    const seg = this.resolve(castNode, cid, idxHint);
    return { seg, receipt: this.receiptOf(seg) };
  }

  /* ---------------------------------------------------------------
   * ③ 编译：把段数据写进 prompt 对象（原地），返回回执
   * ---------------------------------------------------------------
   * 只写三个 *_data 输入。图骨架里的其它东西（模型、尺寸、采样、静音）
   * 是全片共享的，本来就该来自画布。 */
  apply(prompt, castNode, cid) {
    const out = prompt && prompt.output;
    if (!out) throw new Error("提交对象里没有 output（graphToPrompt 失败）");

    const seg = this.resolve(castNode, cid);
    const rec = this.checkDup(this.receiptOf(seg));
    const patched = [];
    const missing = [];

    const castEntry = this._entry(out, castNode, CAST);
    if (!castEntry) {
      throw new Error("提交对象里没有导演台节点 —— 这次提交没有可编译的段");
    }
    /* 别名开关全链路唯一权威仍在文案台：读到了就写，读不到不写（后端默认 true）。 */
    if (seg.alias !== null) seg.state.alias = seg.alias;
    /* 方案②：把「这次送出去的到底是什么」算成指纹，随数据一起走。
       后端拿库里的真值再算一遍，就知道**前端这份副本**过没过时 ——
       不用再靠"感觉这一段好像不对"。
       只写进本次提交的那一份（seg.state 是 shot.state 的克隆），不碰权威段表；
       src 说明词是从哪儿来的，后端据此选该和库里哪一份比（global+段词 vs state.prompt）。 */
    seg.state.segFps = {
      word: rec.wordFp, img: rec.imgFp, vid: rec.vidFp, aud: rec.audFp,
      src: seg.hasDesk ? "desk" : "state",
    };
    /* 段内容只认接线（20261105），但 first / last 是**例外**（20261108 修）：
       词与 images/videos/audios 三类参考素材仍只认连线，断线即空；首/末帧是
       fl2va 的几何锚点，由面板首/末帧卡提交（见 csglide_cast_slots.js 的
       「端口优先 + 手动兜底」镜像），后端 parse_h3_data 的 one("first") 读它，
       _resolve_wired_content 不碰它，SEG_KEY_OWNER 归 submit。
       20261105 改造把整块 slots 删掉，连 first/last 一起没了，而 wired 收口
       又不给这两个字段赋值 → fl2va 面板放图静默退化成 T2V（外部 BugReport
       20261108）。这里只清三类参考槽，**别再整块删**。 */
    const h3Submit = { ...seg.state };
    delete h3Submit.prompt;
    h3Submit.slots = {
      ...(seg.state.slots || {}),
      images: [], videos: [], audios: []   // 参考素材仍只认 refs 接线
    };
    /* 提交必须带本段真实 cid（20261107 修）。
       以前这里把 clip 抹成 ""，只留 chain.shot 让后端按分段 uid 认段；但档案里
       「时间轴上预设、还没跑过」的段，shot 字段只有被导演台跑过才由
       csglide_cast.py:2837 写进去 —— 于是第 2/3 段按 shot 认不到，_register_clip
       走 add_clip 新建段（3 段变 4 段），current 被改成新段，前端仍按旧 cid
       收片被 current != cid 拒绝，下一段续接又找不到承接档。
       序列化时 csglide_cast.js:159 已经统一抹掉 clip（工作流 .json 永不带 clip，
       跨工程安全由那一层保证），提交时再抹一次是多余且有害的。
       cid 为空 = 真正未登记的新段，后端仍按原逻辑自登记。 */
    h3Submit.chain = { ...(h3Submit.chain || {}), clip: String(cid || "") };
    castEntry.inputs.h3_data = JSON.stringify(h3Submit);
    patched.push("h3");

    const rackNode = rackNodeOf(castNode);
    if (rackNode) {
      const e = this._entry(out, rackNode, RACK);
      if (e) {
        let d = {};
        try { d = JSON.parse(e.inputs.rack_data || "{}"); } catch { d = {}; }
        d.slots = clone(seg.rack.slots) || emptyRack().slots;
        d.fps = seg.rack.fps || 0;
        d.audio_out = seg.rack.audio_out || 0;
        d.cur = seg.cid;
        if (!d.segs) d.segs = {};
        if (seg.cid) d.segs[seg.cid] = clone(seg.rack);
        e.inputs.rack_data = JSON.stringify(d);
        patched.push("rack");
      } else missing.push("rack");
    }

    const deskNode = deskNodeOf(castNode);
    if (deskNode) {
      const e = this._entry(out, deskNode, DESK);
      if (e) {
        let d = {};
        try { d = JSON.parse(e.inputs.desk_data || "{}"); } catch { d = {}; }
        if (!d.chain) d.chain = { name: "", clip: "", shot: "" };
        d.chain.name = seg.name;
        d.chain.clip = seg.cid;
        d.chain.shot = seg.shotId || d.chain.shot || "";
        /* 片子级也要从段数据里写：它是全片唯一，但编辑框里的最新值可能还在
           防抖窗口里没进 widget（graphToPrompt 读到旧值 = 整片词少一截）。 */
        d.global = seg.deskGlobal;
        if (seg.alias !== null) d.alias = seg.alias;
        if (!d.segs) d.segs = {};
        /* 20261031：**文案台段表里没有这一段时，绝不写空键**。
           以前无条件 `d.segs[cid] = deskWords`，取不到词就写 "" —— 后端
           （csglide_desk.compose）的库兜底条件是"提交里没有这个键才问库"，
           一个被编译器凭空造出来的空键就把兜底短路了，本段词当场丢失
           （渲染循环逐段切时，后面的段最容易中招）。
           现在只有两种情况才写：有词；或文案台段表**真有**这个键（哪怕是空串
           —— 那是用户真删空，属 20261030 定下的用户意图，必须原样提交）。 */
        if (seg.cid && (seg.deskWords || seg.deskHasKey)) {
          d.segs[seg.cid] = seg.deskWords;
        } else if (!seg.cid && seg.deskWords) {
          /* 新段没登记：段词只随本次提交走，不进段表、不进中央库。 */
          d.pending_seg = seg.deskWords;
        }
        e.inputs.desk_data = JSON.stringify(d);
        patched.push("desk");
      } else missing.push("desk");
    }

    console.log("[段词] 段 " + (seg.cid || "未登记") + " · "
      + (seg.deskWords || "").length + " 字 · 来源 " + (seg.src.desk || "无文案台")
      + " · 片子级 " + (seg.deskGlobal || "").length + " 字");
    rec.patched = patched;
    rec.missing = missing;
    if (missing.length) {
      const warn = `第 ${seg.idx + 1} 段：${missing.join("/")} 节点不在本次提交里`
        + `（被静音/旁路，或没接进图）—— 它那部分数据没有被编译`;
      console.warn("[编译] " + warn);
      seg.warnings.push(warn);
    }
    rec.warnings = seg.warnings;
    return { prompt, receipt: rec, seg };
  }

  /* 按节点 id 定位提交对象那一项；找不到按 class_type 回退。 */
  _entry(out, node, classType) {
    if (node && out[String(node.id)]) return out[String(node.id)];
    if (classType) {
      for (const k of Object.keys(out)) {
        const e = out[k];
        if (e && e.class_type === classType) return e;
      }
    }
    return null;
  }

  /* 一步到位：取图骨架 + 编译。queueOnce 用这条。 */
  async compile(castNode, cid) {
    const p = await app.graphToPrompt();
    /* 期一：先把本段词**写穿**再按 cid **读库**，填好 prime 缓存；
       下面 apply → resolve 就会用库值，而不是文案台的内存副本。 */
    await this.primeDesk(castNode, cid);
    const built = this.apply(p, castNode, cid);
    /* 20261107：全部渲染走的是 compile 而不是直接 apply。这里在编译出口
       再钉一次 chain.clip，无论中途哪一层动过 h3_data，交出去的一定带本段
       真实 cid；同时留一条可验证的控制台标记，刷新后跑一次就能确认新版已生效。 */
    try {
      const out = built && built.prompt && built.prompt.output;
      const key = out && Object.keys(out).find((k) => out[k] && out[k].class_type === CAST);
      const entry = key && out[key];
      if (entry && typeof (entry.inputs || {}).h3_data === "string") {
        const h3 = JSON.parse(entry.inputs.h3_data);
        h3.chain = { ...(h3.chain || {}), clip: String(cid || "") };
        entry.inputs.h3_data = JSON.stringify(h3);
      }
      console.log("[班长] 提交编译：段 " + (cid || "未登记") + " · clip 已写入");
    } catch (e) {
      console.warn("[班长] 提交编译兜底没生效：", e);
    }
    return built;
  }
}

const promptBuild = new PromptBuilder();

/* 给调用方一行日志用。
   「引用」后面直接跟**落在哪张图上、模型叫它第几号**
   （@图片11→kf_01-01.png(P6)，空格位写 (空)）—— 一行就能看出"这一段到底送了
   哪几张、模型读到的编号是几"，不用再拿架面指纹去猜。
   20261024：架面一样 ≠ 送的一样；@图片N ≠ 模型看到的 <Picture k>。
   这两层不写进日志，"串没串、引用对不对"就只能靠感觉。 */
function lineOf(rec) {
  const s = rec.slots || {};
  const un = rec.unresolved || [];
  const dp = rec.defProblems || [];
  const sentMap = new Map((rec.sent || []).map((x) => [x.t, x.f]));
  const pics = rec.pics || {};
  const refTxt = (rec.refs || []).map((r) => {
    const k = "@" + r;
    if (!sentMap.has(k)) return k;               // @first / @last 这类非位置引用
    const f = sentMap.get(k);
    if (!f) return k + "→(空)";                  // 空格位：后端会把它从提示词里摘掉
    const p = pics[k] || {};
    return k + "→" + f + (p.dropped ? "(超上限·被丢弃)" : (p.k ? "(P" + p.k + ")" : ""));
  }).join(" ");
  return `段${rec.idx + 1}${rec.cid ? " " + rec.cid : "（未登记）"}`
    + ` · 词 ${rec.words}字 · 图${s.images || 0} 视${s.videos || 0} 音${s.audios || 0}`
    + (refTxt ? ` · 引用 ${refTxt}` : "")
    + (un.length ? ` · ⚠未解析 ${un.map((u) => "@" + u.name).join("")}` : "")
    + (dp.length ? ` · ⚠定义句 ${dp.map((p) => p.tok + "≠" + p.actual).join("")}` : "")
    + ` · 指纹 ${rec.wordFp}/${rec.imgFp}`
    + ` · 源 ${rec.src.state}/${rec.src.rack}/${rec.src.desk}`;
}

export {
  promptBuild, PromptBuilder, lineOf, fp32, rackSig, refsOf, baseName,
  resolveWords, unresolvedRefsIn, defClaimsOf, defProblemText, slotLabel,
  sentRefsOf, pictureOrdinals, PURE_ID, basisOf,
};
