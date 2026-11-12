/* ============================================================
 * csglide_ref_text.js —— 引用文本归一化 / 别名展开（**纯函数 · 唯一权威**）
 * ------------------------------------------------------------
 * 「提示词里到底引用了哪些素材」只在这里算一份。导演台（送模型）、文案台
 * （chip 高亮 / 编辑器词表 / @补全）都读本模块，杜绝"文案台显示没引用、后端
 * 却把参考图发出去"这类口径分叉。
 *
 * 与后端 csglide_cast.py 的 normalize_refs / alias_table / expand_aliases
 * 逐字对称；与 csglide_qwen.py 那一套同口径。改任何一条规则，这四处必须一起改。
 *
 * 本模块不依赖任何节点 / ui / 缓存，输入只有「文本 + 槽位视图 view」，
 * 可在任意节点、任意测试里直接调用。
 * view 形如 { images:[slot|null,...], videos:[...], audios:[...] }，
 * slot 至少含 { file, alias }。
 * ============================================================ */

/* 引用别名归一化：官方式 <Picture N> / <Video N>、英文裸词 image 1、
   中文 图片 1 等统一收敛成 @图片N / @视频N / @音频N。
   顺序：官方式尖括号 → 英文裸词 → 中文；(?!\d) 防「图片12」被拆成 1 与 2；
   中文规则带 @? 前缀，对已是规范写法的文本幂等。
   <Audio N> 不进这张表（固定语义：N=第 N 个独立音频），由 AUDIO_TAG 处理。 */
export const REF_ALIASES = [
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
export const AUDIO_TAG = /<\s*Audio\s*(\d+)\s*>/gi;
export const AUDIO_WORD = /(?<!@)\bAudios?\s*(\d+)(?!\d)/gi;

/* 相邻标签之间补空格（@音频1@音频4 这类连贴写法）。幂等。 */
export const GLUE_RE = /(@(?:first|last|图片\d+|视频音频\d+|视频\d+|音频\d+))(?=@)/g;

/* 独立音频槽上限，与 csglide_cast.py 的 MAX_AUDIOS 一致（改一处就要改两处）。 */
export const MAX_AUDIOS = 3;

/* <Audio N> / 裸词 Audio N → 第 N 个独立音频槽的规范 token @音频N。
   N 就是槽位编号，与 @音频N 同义；不查槽位此刻有没有素材 —— 空槽也照样换成
   @音频N，等素材补进那一格，同一份文案一个字不改就能生效。旧做法保留原文，
   结果 <Audio 2> 作为字面文本进了编码器、永远参考不到，界面上却毫无提示。
   视频自带的音轨不归这里管，一律用 @视频音频N 引用。越界返回 null。 */
export function audioRef(n) {
  return n >= 1 && n <= MAX_AUDIOS ? `@音频${n}` : null;
}

export function normalizeRefs(text) {
  if (!text) return text;
  let out = String(text);
  out = out.replace(AUDIO_TAG, (m, d) => audioRef(+d) || m);
  out = out.replace(AUDIO_WORD, (m, d) => audioRef(+d) || m);
  for (const [re, rep] of REF_ALIASES) out = out.replace(re, rep);
  out = out.replace(GLUE_RE, "$1 ");
  return out;
}

/* ---- 别名：剧本里直接写角色名 → @图片N --------------------------------
   槽位可带 alias（拖入时按文件名主干自动登记，也可手动改成多个称呼）。
   规则与 csglide_cast.py 的 alias_table / _alias_ok / expand_aliases 对称。 */
export const ALIAS_SPLIT = /[,，、;；]+/;
export const ALIAS_MAX = 40, ALIAS_MIN = 2, ALIAS_TOTAL = 12;
export const BUILTIN_ALIAS = /^(?:first|last|图片\d+|视频音频\d+|视频\d+|音频\d+|pictures?\s*\d+|videos?\s*\d+|audios?\s*\d+|images?\s*\d+)$/i;
export const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/* 全角空格 U+3000 → 半角，两侧都做（与后端 _norm_space 一致）。 */
export const normSpace = (s) => (s ? s.replace(/\u3000/g, " ") : s);

export function aliasList(v) {
  const raw = Array.isArray(v) ? v.filter((x) => typeof x === "string").join(",") : v;
  if (typeof raw !== "string" || !raw.trim()) return [];
  const out = [];
  for (const p of raw.split(ALIAS_SPLIT)) {
    const a = normSpace(p.trim());
    if (!a || a.length > ALIAS_MAX || out.includes(a)) continue;
    out.push(a);
    if (out.length >= ALIAS_TOTAL) break;
  }
  return out;
}

export function aliasOk(a) {
  return a.length >= ALIAS_MIN && a.length <= ALIAS_MAX
    && !/[@\\]/.test(a) && !BUILTIN_ALIAS.test(a);
}

/* 别名表：{ map: 名字(不含@) → 规范 token, strict: 只认 @ 的名字集合 }。
   先出现者优先：重名时后者静默失效，不覆盖前一个。 */
export function aliasInfoOf(view) {
  const map = Object.create(null);
  const strict = new Set();
  const kinds = [["images", "@图片"], ["videos", "@视频"], ["audios", "@音频"]];
  for (const [kind, prefix] of kinds) {
    const arr = (view && view[kind]) || [];
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
  return { map, strict };
}

/* 保护区：台词 <d>…</d> 与引号内不展开别名（台词要原样念）。 */
const PROTECT_SRC = "<d>[\\s\\S]*?<\\/d>|\"[^\"\\n]*\"|\u201c[^\u201d\\n]*\u201d"
  + "|\"[^\"\\n]*(?=$|\\n)|\u201c[^\u201d\\n]*(?=$|\\n)";
const ESC = "\u0000";

const EDGE_L = { ascii: "(?<![\\u0000\\\\A-Za-z0-9])", cjk: "(?<![\\u0000\\\\0-9])" };
const EDGE_R = { ascii: "(?![A-Za-z0-9])", cjk: "(?![0-9])" };
const edgeOf = (k) => (/[A-Za-z]/.test(k[0] + k[k.length - 1]) ? "ascii" : "cjk");

function mapOutside(text, fn) {
  const re = new RegExp(PROTECT_SRC, "gm");
  re.lastIndex = 0;
  let out = "", pos = 0, m;
  while ((m = re.exec(text))) {
    if (m.index > pos) out += fn(text.slice(pos, m.index));
    out += m[0];
    pos = m.index + m[0].length;
  }
  return out + (pos < text.length ? fn(text.slice(pos)) : "");
}

/* 把别名展开成规范 token（纯函数，无缓存；调用方需要缓存请自行包一层）。 */
export function expandAliasesText(text, view) {
  if (!text) return text;
  const { map, strict } = aliasInfoOf(view);
  const names = Object.keys(map);
  if (!names.length) return String(text);
  const escaped = String(text).replace(
    new RegExp("\\\\(?=" + names.map(escRe).join("|") + ")", "g"), ESC);
  const ordered = names.slice().sort((a, b) => b.length - a.length);
  const seg = (s) => {
    if (!s) return s;
    s = normSpace(s);
    for (const n of ordered) {
      const edge = edgeOf(n);
      const at = strict.has(n) ? "@" : "@?";
      const re = new RegExp(EDGE_L[edge] + at + "(" + escRe(n) + ")" + EDGE_R[edge], "g");
      s = s.replace(re, () => map[n]);
    }
    return s;
  };
  return mapOutside(escaped, seg).split(ESC).join("");
}

/* ============================================================
 * 便捷入口：给定「原文 + 槽位 + 别名开关」，算出**真正会发送**的文本。
 * alias=false 时只做写法归一化（<Picture N>/图片N 等仍识别为显式引用），
 * 裸写角色名（别名）不展开 —— 与文案台「别名模式」开关、后端口径一致。
 * ============================================================ */
export function effectiveText(text, view, aliasOn) {
  let out = String(text || "");
  if (aliasOn !== false) out = expandAliasesText(out, view);
  return normalizeRefs(out);
}

const CANON_RE = /@(?:first|last|视频音频\d+|图片\d+|视频\d+|音频\d+)(?![0-9A-Za-z])/g;

/* 「真正会发送」的规范 token 集合（Set）。chip 亮灭、素材自检都读它，
   保证"文案台点亮哪些素材" == "后端实际发哪些参考"。 */
export function effectiveTags(text, view, aliasOn) {
  const out = effectiveText(text, view, aliasOn).match(CANON_RE);
  return new Set(out || []);
}
