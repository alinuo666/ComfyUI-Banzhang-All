/* ============================================================
 * H3 媒体架 — 别名（文件名即角色名）
 * ------------------------------------------------------------
 * 剧本里直接写角色名（小明）就能引用对应素材，导演台侧展开成 @图片N。
 * 拖入即按文件名主干自动登记，不用手动起名；多个称呼用逗号分隔；
 * 留空 = 不参与自动引用（比如文件名太泛，写「背景」会满篇命中）。
 * ============================================================ */
import { el } from "./csglide_rack_core.js";

export const ALIAS_SPLIT = /[,，、;；]+/;
/* 与 csglide_cast_alias.js 的 ALIAS_MIN/MAX/TOTAL、csglide_media_rack.py 的
   _ALIAS_MAX/_ALIAS_TOTAL 同一组数字，改一处必须改三处。 */
export const ALIAS_MIN = 2, ALIAS_MAX = 40, ALIAS_TOTAL = 12;

export function baseName(file) {
  const s = String(file || "");
  const i = s.lastIndexOf("/");
  const n = i >= 0 ? s.slice(i + 1) : s;
  const d = n.lastIndexOf(".");
  return d > 0 ? n.slice(0, d) : n;
}

/* 文件名主干作默认别名：文件名里带空格是常事（my photo.png），别名现在也
   允许空格且空格就是名字的一部分，所以只压缩连续空白、不删空格——删掉会
   让默认别名跟用户看到的文件名对不上。合法性（太短/太长/撞内置标签）不过就
   一个都不登记，否则用户会在 chips 上看到一个「注册了却死活不生效」的名字。

   \s 在 JS 里本来就含 U+3000，所以这一步顺带把全角空格也归一成半角；
   normSpace 再走一遍是为了让「默认别名」与「手写别名」的归一化入口一致，
   不依赖「正则的 \s 覆盖哪些字符」这种需要查表的知识——显式一次更便宜。 */
export function autoAliasOf(file) {
  const a = normSpace(baseName(file).replace(/\s+/g, " ").trim());
  return aliasBad(a) ? [] : [a];
}

/* 拖入时登记：文件名不能作别名就一个都不写（保持 undefined），别写个空数组
   占住位置——空数组在这里代表「手工关掉了自动引用」。 */
export function setAutoAlias(slot, file) {
  const a = autoAliasOf(file);
  if (a.length) slot.alias = a;
}

export function aliasText(slot) {
  return Array.isArray(slot.alias) ? slot.alias.join(", ") : (slot.alias || "");
}

/* 与 csglide_cast_alias.js 的 aliasBad / csglide_cast.py 的 _alias_ok 同一套
   规则，改一处必须改另外两处。填了后端会静默忽略的名字却毫无提示，是最难排查的
   一类问题——所以这里即时标红，把「为什么它不生效」说在前面。

   空格是允许的，且是名字的一部分（「张三丰 剧照」就是一个名字）。分隔符只有
   ALIAS_SPLIT 那几个，空格不在其中，所以写法上不会歧义。 */
const ALIAS_BUILTIN = /^(?:first|last|图片\d+|视频音频\d+|视频\d+|音频\d+|pictures?\s*\d+|videos?\s*\d+|audios?\s*\d+|images?\s*\d+)$/i;
export function aliasBad(raw) {
  const n = raw.charAt(0) === "@" ? raw.slice(1) : raw;   // @ 前缀是作用域标记，不是名字
  if (!n) return "";
  if (n.length < ALIAS_MIN) return "至少 " + ALIAS_MIN + " 个字";
  if (n.length > ALIAS_MAX) return "太长（上限 " + ALIAS_MAX + " 字）";
  if (/[@\\]/.test(n)) return "不能含 @ 或反斜杠";
  if (ALIAS_BUILTIN.test(n)) return "与内置标签冲突（first / last / 图片1 / image 1…）";
  return "";
}

/* 全角空格 U+3000 → 半角 U+0020。中文输入法在词间极易产出全角空格，而手打
   别名又常是半角，两边不统一就永远命不中。归一化必须**两侧都做**：只改名字或
   只改正文，仍有「名字半角 / 正文全角」这类组合漏掉。只换 U+3000，不动其他
   空白。与 csglide_cast_alias.js 的 normSpace、csglide_cast.py 的 _norm_space 一致。 */
export function normSpace(s) {
  return s ? s.replace(/\u3000/g, " ") : s;
}

/* 写入前先做一遍和后端完全相同的规范化：归一空格、去重、丢弃非法项、截断到
   ALIAS_TOTAL。不这么做的话，输入框会显示 15 个别名而后端只认前 12 个——用户
   改了名却「后半截死活不生效」，且全程没有任何提示。返回被丢弃的项用于回显。 */
export function writeAlias(slot, text) {
  const list = [], drop = [];
  const seen = new Set();
  for (const raw of String(text || "").split(ALIAS_SPLIT)) {
    // trim 先剥首尾（JS 的 trim 认 U+3000），再归一内部全角空格——与
    // csglide_cast_alias.js 的 aliasList、Python 的 _alias_of 同序。归一必须在
    // 取 name（去 @）之前，否则去重会漏掉「同一名字的全角/半角两种写法」。
    const a = normSpace(raw.trim());
    if (!a) continue;
    const name = a.charAt(0) === "@" ? a.slice(1) : a;
    if (seen.has(name) || aliasBad(a)) { drop.push(a); continue; }
    if (list.length >= ALIAS_TOTAL) { drop.push(a); continue; }
    seen.add(name);
    list.push(a);
  }
  slot.alias = list;
  return { list, drop };
}

/* commit 与 onChange 分开传：改名必须落盘（commit），而重渲哪一块由调用方
   决定（图片格 / 媒体卡各自的 render）。 */
export function aliasInput(slot, commit, onChange) {
  const inp = document.createElement("input");
  inp.className = "gmr-alias";
  inp.type = "text";
  inp.value = aliasText(slot);
  inp.placeholder = slot.file ? baseName(slot.file) : "别名";   // 留空=关闭，@前缀=仅@触发
  const baseTitle = "剧本里写这个名字即引用本素材（导演台展开成 @图片N / @视频N / @音频N）。\n"
    + "· 小明    自动：写「小明」就引用\n"
    + "· @小明   仅 @ 触发：必须写「@小明」才引用（名字太常见时用）\n"
    + "· 留空    关闭：不参与自动引用\n"
    + "名字可以带空格：「张三丰 剧照」算一个名字，不会拆成两个；\n"
    + "首尾的空格会被自动去掉，中间的原样保留。\n"
    + "多个称呼用逗号分隔；每个 " + ALIAS_MIN + "-" + ALIAS_MAX + " 字，最多 " + ALIAS_TOTAL
    + " 个，重名与非法项会被丢弃。\n"
    + "台词 <d>…</d> 与引号内的名字不会被替换。"
    + (slot.file ? "\n文件：" + slot.file : "");
  inp.title = baseTitle;
  /* 用真 <input>：LiteGraph 的 processKey 只跳过 input/textarea，
     contenteditable 上的按键会漏到画布去。 */
  const stop = (e) => e.stopPropagation();
  inp.addEventListener("pointerdown", stop);
  inp.addEventListener("click", stop);
  inp.addEventListener("wheel", stop);
  /* 点击名称栏直接改名：聚焦即全选——拖入时别名=文件名主干（原名），所以
     打字直接整体替换，不必先删原名。想只改一处再点一下同名输入框：focus 不
     再触发，光标落到点击处，原文保留可精修。只动交互，别名登记/规范化/补
     别名这套原名机制一概不碰。 */
  inp.addEventListener("focus", () => inp.select());
  inp.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") { e.preventDefault(); inp.blur(); }
    if (e.key === "Escape") { inp.value = aliasText(slot); inp.blur(); }
  });
  /* 即时校验：非法名字标红并在 tooltip 里说明原因 */
  const check = () => {
    const list = String(inp.value || "").split(ALIAS_SPLIT)
      .map((s) => s.trim()).filter(Boolean);
    const bad = [...new Set(list.map(aliasBad).filter(Boolean))];
    inp.classList.toggle("bad", bad.length > 0);
    inp.title = baseTitle + (bad.length ? "\n⚠ " + bad.join("；") + "（这些不会被注册）" : "");
  };
  const save = () => {
    const before = aliasText(slot);
    const res = writeAlias(slot, inp.value) || { drop: [] };
    const after = aliasText(slot);
    inp.value = after;                  // 回显规范化后的值（多余空格/分隔符/超量项被吃掉）
    check();
    /* 被规范化吃掉的项（重名 / 超 12 个）也要说一声，否则输入框悄悄变短，
       用户只会以为是自己没存上。 */
    if (res.drop && res.drop.length) {
      const why = res.drop.length > 1 ? "（重名或超过 " + ALIAS_TOTAL + " 个，已丢弃）" : "（重名或非法，已丢弃）";
      inp.title = baseTitle + "\n⚠ 已忽略：" + res.drop.join("、") + why;
    }
    /* 没变就别重渲：blur → save → 重渲 → 旧框被移除 会再触发一次 blur，
       不挡住就是一次空转，挡住也不影响改名的正常路径。 */
    if (after === before) return;
    if (commit) commit();
    if (onChange) onChange();
  };
  inp.addEventListener("input", check);
  inp.addEventListener("change", save);
  inp.addEventListener("blur", save);
  check();
  return inp;
}
