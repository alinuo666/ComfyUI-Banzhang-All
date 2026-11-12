import { el } from "./csglide_ui_kit.js";

/* ============================================================
 * 引用归一化 / 别名展开 / 保护区
 * ------------------------------------------------------------
 * 从 csglide_cast.js 的 buildUI 里整块搬出来。
 *
 * 跨块的东西一律走 ui.<名>：ui 是 buildUI 建的那一个共享 bag。可变状态
 * 在它上面只有一个字段，所以本文件与别的模块改的是同一份。
 * 本块自己声明的东西保持裸名（函数声明要靠提升），末尾统一挂到 ui 上，
 * 顺序与原来在 buildUI 里的先后一致 —— 搬出去之后，谁先声明谁后声明没变。
 * ============================================================ */

export function installAlias(ui) {
  /* ---- prompt ----
     本节点**没有提示词编辑区**。标准链路是「媒体架 → 文案台 → 导演台」：词只在
     文案台写，导演台只管怎么生成。所以面板上只留下面一行「文案来源」，说明词
     从哪来、没接时该怎么接 —— 两处都能改的话，改完到底谁生效就成了谜。

     这里原本立着整块编辑区（pWrap：参考标签 chips / 分镜条 / contenteditable
     编辑器 / 行号 gutter / 提交格式展示条）。它在「词归文案台」那次改动里就已
     经从面板上摘掉了，元素退到幕后却仍在被 rackPoll 定时器反复重建 —— 每 1.5
     秒往一批看不见的 DOM 里重画 <video> / <img> 缩略图。而 effPrompt() 那时也
     已改读 ui.st.prompt，不再读编辑器，那块连"状态载体"都算不上了。整块已在「阶
     段 0 死代码清理」中删除：不要照旧例把它再建回来。 */
  const pSrcLine = el("div", "gcast-psrc");

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

  /* <Audio N> / 裸词 Audio N → 第 N 个独立音频槽的规范 token @音频N。
     N 就是槽位编号，与 @音频N 同义；不查槽位此刻有没有素材——空槽也照样换成
     @音频N，素材补进那一格后同一份文案一个字不改就能生效。旧做法保留原文，
     结果 <Audio 2> 作为字面文本进了编码器、永远参考不到，界面上却毫无提示。
     视频自带的音轨不归这里管，一律用 @视频音频N 引用。
     与 csglide_cast.py 的 _audio_ref、csglide_ref_text.js 的 audioRef 必须给出
     同一个答案。越界返回 null。 */
  const MAX_AUDIOS = 3;   // 与 csglide_cast.py 的 MAX_AUDIOS 一致
  function audioRef(n) {
    return n >= 1 && n <= MAX_AUDIOS ? `@音频${n}` : null;
  }

  function normalizeRefs(text) {
    if (!text) return text;
    let out = String(text);
    out = out.replace(AUDIO_TAG, (m, d) => audioRef(+d) || m);
    out = out.replace(AUDIO_WORD, (m, d) => audioRef(+d) || m);
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
  /* 别名表在一条链路上被反复取（素材自检一次、别名展开一次、后端一次），
     不缓存就是每个别名一遍正则。 */
  ui.aliasCache = { key: "", val: null };
  /* 缓存键是各槽位别名原文拼出来的串，不是 rack_data 全文——面板改名、
     媒体架改名都会让它变，但只有别名相关的改动才失效。不借用 ui.rackCache：
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
    const view = ui.mergedSlots();
    const key = aliasKey(view);
    if (ui.aliasCache.key === key && ui.aliasCache.val) return ui.aliasCache.val;
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
    ui.aliasCache = { key, val: { map, strict } };
    return ui.aliasCache.val;
  }
  /* 别名反查（@图片1 → 首选别名的显示写法）原来服务于参考标签 chips 与 @ 补全
     的插入，两者随编辑区一起删了，这里不再需要。别名**正向**展开（别名 → @规范
     标签）仍然必需：effPrompt() 送模型前靠它把剧本里的角色名换成槽位 token。 */

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
  /* 分组的唯一判据：首尾是不是 ASCII 字母。展开与引用扫描（tokReOf）必须共用
     这一处判定，两处各写一遍迟早会飘（一边把「小明Ab刀」当 cjk，另一边当
     ascii）。 */
  const edgeOf = (k) => (/[A-Za-z]/.test(k[0] + k[k.length - 1]) ? "ascii" : "cjk");

  /* 展开结果同样缓存：同一段文本会被素材自检 / 按需过滤 / 引用扫描各问一遍，
     每次都重跑全部别名太浪费。键 = 别名表版本 + 原文。 */
  ui.expCache = { in: null, out: null };
  function expandAliases(text) {
    if (!text) return text;
    const { map, strict } = aliasInfo();
    const names = Object.keys(map);
    if (!names.length) return String(text);
    const ckey = (ui.aliasCache.key || "") + "\u0001" + text;
    if (ui.expCache.in === ckey) return ui.expCache.out;
    ui.expCache = { in: ckey, out: null };
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
    return (ui.expCache.out = mapOutside(escaped, seg).split(ESC).join(""));
  }


  /* 挂出去：别的块通过 ui.<名> 取。放在最后 —— 等同于原来在这一块
     结束时才声明完，之前的块拿不到，之后的块拿得到。 */
  Object.assign(ui, { pSrcLine, REF_ALIASES, AUDIO_TAG, AUDIO_WORD, GLUE_RE, audioRef, normalizeRefs, ALIAS_SPLIT, ALIAS_MAX, ALIAS_MIN, ALIAS_TOTAL, BUILTIN_ALIAS, escRe, normSpace, aliasList, aliasOk, aliasKey, aliasInfo, PROTECT_SRC, PROTECT_FLAG, ESC, reCache, reOf, mapOutside, EDGE_L, EDGE_R, aliasEdges, edgeOf, expandAliases });
}
