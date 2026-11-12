/* ============================================================
 * 通用提示词编辑器（业务无关）
 * ------------------------------------------------------------
 * 原生 <textarea> 只能装纯文本，框内做不了任何标记；本模块用
 * contenteditable 承载「文本 + 引用标记」，把四件事做成一个件：
 *   · 高亮   —— 命中的 @引用 标成 .tok.has / .tok.miss（空槽位）
 *   · @补全  —— 在插入符处弹出 .gcast-ac 列表，↑↓ / Enter / Tab / Esc
 *   · 悬停预览 —— 鼠标停在引用上弹 .gcast-toktip 缩略图
 *   · 纯文本回读 —— textContent 逐字还原，含换行，不掺 <br>/<div>
 *
 * 只管编辑：词表与素材解析由调用方注入（tokens / view），所以同一份
 * 代码既能服务 Qwen 编辑台，也能服务导演台——不会各自漂移出一份近似实现。
 * 样式复用 CAST_CSS 的 .gcast-ed / .tok / .gcast-ac / .gcast-toktip 类名。
 *
 * 与后端同名口径（csglide_qwen.py / csglide_cast.py 的别名规则）：
 *   · 别名 name 不含 @；strict 别名必须写 @名字 才引用（插入时自动补 @）
 *   · 别名前后空格两种写法都算命中（全角 U+3000 与半角展开为同一组）
 *   · \别名 是「保留文字、不展开」的转义，高亮同样不点亮它
 * ============================================================ */

const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

/* 引用 token → 素材类型。缩略图/图标必须按类型给：音频/视频的引用落进 <img>
 * 只会是一个破图（浏览器拿到的是一段 wav/mp4），而样式里 `.gcast-toktip .glyph`
 * 这条早就备好了 —— 浮窗本来就该分三路，只是实现时只写了图片那一路。
 *
 * canon 一定是规范 token（@图片3 / @视频2 / @视频音频2 / @音频1），类型从它
 * 推出来，不额外依赖调用方传 kind。`@视频音频N` 必须先于 `@视频N` 判：它是
 * 那条视频自带的音轨，按声音展示才有意义。
 *
 * 抽成模块级纯函数（不碰 DOM）是为了能离线自测。
 */
const KIND_OF_CANON = [
  [/^@?(?:视频)?音频/, "audio"],
  [/^@?视频/, "video"],
];

export function kindOfCanon(canon) {
  const s = String(canon == null ? "" : canon);
  for (const [re, kind] of KIND_OF_CANON) if (re.test(s)) return kind;
  return "image";
}

/** 素材文件名（去掉目录部分）——音频浮窗上要显示它，因为音频没有画面。 */
export const baseName = (f) => String(f == null ? "" : f).replace(/^.*[\\/]/, "");

/* 词表里查不到的 @编号 → 一条「指向空槽位」的标记（.tok.miss 红色波浪线）。
 *
 * 为什么非要有这一遍：词表是「**架上有素材**的格子」列表（文案台的 rackRows
 * 里 `if (!s.file) return` 直接跳过空槽），所以 `@图片15` 指向一个空格子时，
 * 它连一条记录都不存在，显示层退回纯文本 —— 用户在文案台看到的是一段普通
 * 字，没有任何警告。「引用了不存在的参考图」被静默吞掉，正是最难发现的那类
 * 错：模型拿到的是一个空引用，出来的画面看着还行。
 *
 * 只在词表**非空**时才标：一台媒体架都没接的时候，满篇编号都"查不到"，
 * 全刷红纯属噪音，还会让人以为素材全丢了（未知 ≠ 缺失）。
 *
 * 抽成模块级纯函数（不碰 DOM）是为了能离线自测：marks() 长在 makePromptEditor
 * 的闭包里，外面够不着。
 */
export function missRefsOf(text, toks) {
  const out = [];
  const list = toks || [];
  if (!list.length) return out;
  const known = new Set();
  for (const tk of list) {
    if (tk && tk.name) known.add(tk.name);
    if (tk && tk.canon) known.add(tk.canon);
  }
  /* 顺序要紧：视频音频 必须排在 视频 前面，否则 @视频音频3 会被拆成 @视频 + 音频3 */
  const BARE = /@(图片|视频音频|视频|音频)(\d+)/g;
  let m;
  while ((m = BARE.exec(String(text || "")))) {
    if (!m[0]) { BARE.lastIndex++; continue; }
    const canon = "@" + m[1] + m[2];
    if (known.has(canon)) continue;      // 词表里有：由词表那一遍负责上色
    out.push({ i: m.index, len: m[0].length, tok: m[0], tk: { canon } });
  }
  return out;
}

/* 记录（调用方给）——**一条素材一条记录**：
 *   name   规范引用文字（@图片1），永远是这条记录的主名字
 *   alias  可选的友好名（小明），不带 @；有它时补全与 chips 优先用它
 *   canon  判定素材归属的规范 token，缺省取 name
 *   file   素材文件；空 → 该引用标成「指向空槽位」
 *   strict 别名必须带 @ 才引用（写 @小明）
 *   label  补全列表里显示的名字，缺省别名或 name
 *   note   补全列表右侧的注解（通常给规范 token 的文件名/编号）
 *
 * 别名与规范 token 是**同一条素材的两个写法**，不是两条素材：早先把它们
 * 拆成两条记录，菜单里一条素材就出现两行，看起来像素材翻倍了。
 */
export function makePromptEditor(opts = {}) {
  const placeholder = opts.placeholder || "";
  const mode = opts.mode || "";
  const view = typeof opts.view === "function" ? opts.view : () => "";
  const tokens = typeof opts.tokens === "function" ? opts.tokens : () => [];
  const onChange = opts.onChange;
  /* 只读镜像：外接提示词接管时置位。所有写入口（输入 / 粘贴 / 剪切 / 撤销 /
     chips 插入）都收口在 fire() 与 replaceRange()，挡这两处即写不进去。 */
  let ro = false;

  const ed = el("div", "gcast-ed" + (opts.cls ? " " + opts.cls : ""));
  ed.setAttribute("contenteditable", "plaintext-only");
  /* plaintext-only 只有 Chromium 认；别的浏览器退回 true，靠 Enter 拦截
     保证不生成 <div>——否则 textContent 会掺进换行之外的结构。 */
  const flat = ed.contentEditable === "plaintext-only";
  if (!flat) ed.setAttribute("contenteditable", "true");
  ed.dataset.placeholder = placeholder;
  ed.spellcheck = false;

  /* ---------------- 纯文本 / 光标 ---------------- */

  /* 编辑区只由文本节点与扁平 span 构成，按 DOM 顺序累加文本节点长度
     即得字符偏移——与 textContent 同一套口径，不会各算各的。 */
  function charOffset(node, offset) {
    let total = 0;
    const w = document.createTreeWalker(ed, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = w.nextNode())) {
      if (n === node) return total + offset;
      total += n.textContent.length;
    }
    return total;
  }

  /* textContent 而非 innerText：innerText 依赖排版，编辑区高度为 0 时会
     返回空串，把提示词悄悄读没。 */
  const text = () => ed.textContent || "";

  /* 编辑期间随时记下光标：失焦后（点 chip 时焦点在按钮上）插入仍能落到用户
     离开时的位置，而不是一律追加到末尾。caret() 取不到选区时也退回它。 */
  let lastCaret = 0;

  function caret() {
    const s = window.getSelection();
    if (!s || !s.rangeCount) return { s: lastCaret, e: lastCaret };
    const r = s.getRangeAt(0);
    /* 选区落在编辑区外 = 这个 range 已经不可信，不是"光标在文末"。
       20261028：原来这里返回 text().length，于是任何一次 replaceRange(起点, 终点)
       都变成"从起点删到全文结尾" —— 实测症状是补全回车后整行后半截没了。
       谎报"在文末"比承认取不到更糟：调用方没有任何机会发现不对。 */
    if (!ed.contains(r.startContainer)) return { s: lastCaret, e: lastCaret };
    return { s: charOffset(r.startContainer, r.startOffset),
             e: charOffset(r.endContainer, r.endOffset) };
  }

  function setCaret(pos) {
    /* 未聚焦时绝不动选区：对可编辑元素 addRange 会把焦点抢过来。 */
    if (document.activeElement !== ed) return;
    const w = document.createTreeWalker(ed, NodeFilter.SHOW_TEXT);
    let n, acc = 0, last = null;
    while ((n = w.nextNode())) {
      last = n;
      if (acc + n.textContent.length >= pos) break;
      acc += n.textContent.length;
    }
    const s = window.getSelection();
    const r = document.createRange();
    if (n) { r.setStart(n, Math.max(0, Math.min(pos - acc, n.textContent.length))); r.collapse(true); }
    else if (last) { r.setStart(last, last.textContent.length); r.collapse(true); }
    else { r.selectNodeContents(ed); r.collapse(false); }
    s.removeAllRanges(); s.addRange(r);
  }

  const focused = () => document.activeElement === ed;

  const track = () => { if (focused()) lastCaret = caret().s; };

  /* ---------------- 高亮 ---------------- */

  /* 别名集合随媒体架变化，正则每次现拼，不写死字面量。
     每条记录最多产两个正则（规范名 + 别名），逐条各跑一次：条数不过百，比
     拼一个巨型交替正则 + 命名组更好读，也不必为「是哪一组命中」做额外解包。 */
  function marks(t) {
    const out = [];
    /* 词表只取一次：下面三处都要用，而 tokens() 是 O(架上素材数) 的重算，
       每次按键调三遍没必要。 */
    const TOKS = tokens() || [];
    for (const tk of TOKS) {
      if (!tk) continue;
      const forms = [];
      /* 规范名（@图片1）与别名（小明）是同一素材的两种写法，两种都点亮 */
      if (typeof tk.name === "string" && tk.name) forms.push({ text: tk.name, need: true });
      if (typeof tk.alias === "string" && tk.alias) {
        forms.push({ text: tk.alias, need: !!tk.strict });
      }
      for (const f of forms) {
        const core = f.text.startsWith("@") ? f.text.slice(1) : f.text;
        if (!core) continue;
        /* need = 必须带 @ 才引用（规范 token、以及 strict 别名） */
        const at = f.need || f.text.startsWith("@");
        /* 边界口径与后端同一套：首尾含 ASCII 字母的成分用字母数字边界，纯中文
           只挡数字——中文没有空格分词，连汉字一起挡会让「看小明走过来」失效。 */
        const asciiEdge = /[A-Za-z]/.test(f.text[0] + f.text[f.text.length - 1]);
        const left = at ? "(?<![\\u0000\\\\A-Za-z0-9])"
          : asciiEdge ? "(?<![\\u0000\\\\A-Za-z0-9])" : "(?<![\\u0000\\\\0-9])";
        const right = asciiEdge && !at ? "(?![A-Za-z0-9])" : "(?![0-9])";
        const scope = at ? "@" : "@?";
        /* 别名里的空格正文里可能被打成全角，展开成 [ \u3000] 两种写法都点亮 */
        const body = esc(core).replace(/ /g, "[ \u3000]");
        const re = new RegExp(left + scope + "(" + body + ")" + right, "g");
        let m;
        while ((m = re.exec(t))) {
          if (!m[0]) { re.lastIndex++; continue; }
          out.push({ i: m.index, len: m[0].length, tok: m[0], tk });
        }
      }
    }
    /* 尖括号写法 <Picture N> / <Video N> / <Audio N>：后端 normalize 一直认这
       三种（见 csglide_ref_text.js 的 REF_ALIASES / AUDIO_TAG），显示层必须同
       步点亮。它们不是独立的一类引用，而是 @中文N 的另一种写法 —— 所以命中后
       **回查词表**，找 canon 相同的记录回填 file 与 alias：有素材标绿（has）、
       没素材标红（miss），与直接写 @音频N 完全一致；别名模式也照常生效。
       不查词表就只剩一个死 canon，file 恒空 → 永远标红，还会把别名对应一并丢掉。 */
    const ANGLE_KIND = { picture: "图片", video: "视频", audio: "音频" };
    const ANGLE_RE = /<\s*(Picture|Video|Audio)\s*(\d+)\s*>/gi;
    const ANGLE_TOKEN = { 图片: "@图片", 视频: "@视频", 音频: "@音频" };
    const tokenByCanon = new Map();
    for (const tk of TOKS) {
      if (tk && (tk.canon || tk.name) && !tokenByCanon.has(tk.canon || tk.name)) {
        tokenByCanon.set(tk.canon || tk.name, tk);
      }
    }
    let am;
    while ((am = ANGLE_RE.exec(t))) {
      if (!am[0]) { ANGLE_RE.lastIndex++; continue; }
      const kind = ANGLE_KIND[String(am[1]).toLowerCase()] || "";
      if (!kind) continue;
      const canon = ANGLE_TOKEN[kind] + am[2];
      /* 回查词表：查得到就带 file（判色）+ 别名（名字对应），查不到退化成死
         canon（该槽位本就没素材，标红正合适）。 */
      out.push({ i: am.index, len: am[0].length, tok: am[0],
                 tk: tokenByCanon.get(canon) || { canon } });
    }
    /* 词表里查不到的编号也要标红 —— 只能靠这一遍纯文本扫描补上（见
       missRefsOf 顶部注释：词表只含"有素材"的格子，空槽引用根本不在里面）。 */
    if (TOKS.length) out.push(...missRefsOf(t, TOKS));
    /* 台词标签 <d>…</d>：口径与后端保护区（csglide_cast.py 的 PROTECT_SRC）
       一致。整段先占位，内部因此不会再被当成 @引用高亮——台词是要原样念出去
       的字，别名与 @标签在里头都不展开。 */
    const D_RE = /<d>([\s\S]*?)<\/d>/g;
    let dm;
    while ((dm = D_RE.exec(t))) {
      if (!dm[0]) { D_RE.lastIndex++; continue; }
      out.push({ i: dm.index, len: dm[0].length, d: dm[1] });
    }
    out.sort((a, b) => a.i - b.i || b.len - a.len);   // 长匹配优先，短名不抢长名
    const segs = [];
    let pos = 0;
    for (const mk of out) {
      if (mk.i < pos) continue;                       // 已被更长的匹配覆盖
      if (mk.i > pos) segs.push({ text: t.slice(pos, mk.i) });
      segs.push(mk.d !== undefined
        ? { d: mk.d }
        : { tok: mk.tok, canon: mk.tk.canon || mk.tk.name,
            file: mk.tk.file || "" });
      pos = mk.i + mk.len;
    }
    if (pos < t.length) segs.push({ text: t.slice(pos) });
    return segs;
  }

  let sig = "";
  function paint(t, caretPos) {
    const segs = marks(t);
    const s = JSON.stringify(segs);
    if (s === sig) return;                            // 结构没变就不动 DOM
    sig = s;
    const keepScroll = ed.scrollTop;                  // 重建会清滚动位置
    ed.replaceChildren();
    for (const g of segs) {
      if (g.d !== undefined) {
        /* <d> / </d> 留成纯文本节点：textContent 必须原样带着标签回读给后端，
           否则台词保护区一丢，别名就会在台词里被展开。只有中间那句上色。 */
        ed.append(document.createTextNode("<d>"));
        const sp = document.createElement("span");
        sp.className = "d";
        sp.textContent = g.d;
        ed.append(sp);
        ed.append(document.createTextNode("</d>"));
        continue;
      }
      if (g.tok === undefined) { ed.append(document.createTextNode(g.text)); continue; }
      const sp = document.createElement("span");
      sp.className = "tok " + (g.file ? "has" : "miss");
      sp.textContent = g.tok;                         // 保留原文，回读逐字不变
      sp.dataset.tok = g.tok;
      sp.dataset.canon = g.canon;
      if (g.file) sp.dataset.file = g.file;
      ed.append(sp);
    }
    ed.scrollTop = keepScroll;
    if (caretPos != null) setCaret(caretPos);
  }

  /* ---------------- @ 补全 ---------------- */

  const ac = el("div", "gcast-ac");
  ac.style.display = "none";
  ac.style.position = "fixed";
  ac.addEventListener("pointerdown", (e) => e.preventDefault());   // 保住编辑区焦点
  document.body.append(ac);   // 挂在 body，弹出时不参与节点内部排版

  let items = [], idx = 0, acStart = -1, acQuery = "", open = false;

  function closeAC() { ac.style.display = "none"; items = []; acStart = -1; open = false; }

  /* 插入符坐标：用一份样式克隆的镜像量文字落点，避免依赖已废弃的 selection 坐标 */
  function caretXY() {
    const cs = getComputedStyle(ed);
    const mirror = el("div");
    ["fontFamily", "fontSize", "fontWeight", "lineHeight", "letterSpacing",
     "paddingTop", "paddingRight", "paddingBottom", "paddingLeft",
     "borderTopWidth", "borderLeftWidth", "textTransform", "wordSpacing"]
      .forEach((k) => { mirror.style[k] = cs[k]; });
    Object.assign(mirror.style, {
      position: "absolute", left: "-99999px", top: "0", visibility: "hidden",
      whiteSpace: "pre-wrap", wordWrap: "break-word",
      width: ed.clientWidth + "px", boxSizing: "border-box",
    });
    const mark = el("span", null, "\u200b");
    mirror.append(document.createTextNode(text().slice(0, caret().s)), mark);
    document.body.append(mirror);
    const x = mark.offsetLeft, y = mark.offsetTop;
    mirror.remove();
    const box = ed.getBoundingClientRect();
    return { x: box.left + x, y: box.top + y - ed.scrollTop + parseFloat(cs.lineHeight || 18) + 4 };
  }

  /* 素材类型判定（kindOfCanon）与文件名提取（baseName）在模块顶层，
     纯函数、可离线自测。 */

  /* 补全列表里一条素材只占一行：别名与规范 token 是同一素材的两个写法。
     标签优先显示别名（能认出来是谁），note 里带规范 token（知道会写成什么）。
     图标同样按类型：音频没有画面，塞 <img> 只会是破图。 */
  function drawAC() {
    ac.replaceChildren();
    items.forEach((t, i) => {
      const b = el("button");
      b.setAttribute("aria-selected", String(i === idx));
      const kind = kindOfCanon(t.canon || t.name);
      if (t.file && kind === "image") {
        const im = el("img");
        im.src = view(t.file);
        b.append(im);
      } else if (t.file && kind === "video") {
        const v = el("video");
        v.src = view(t.file);
        v.muted = true; v.preload = "metadata"; v.playsInline = true;
        b.append(v);
      } else if (t.file) {
        b.append(el("span", "glyph", "♪"));
      } else {
        b.append(el("span", "glyph", "@"));
      }
      b.append(el("span", null, t.label || t.alias || t.name));
      if (t.note) b.append(el("span", "tag", t.note));
      b.addEventListener("pointerdown", (e) => e.preventDefault());
      b.onclick = () => accept(i);
      ac.append(b);
    });
  }

  function openAC(query, start) {
    const q = query.toLowerCase();
    items = [];
    for (const t of tokens() || []) {
      if (!t || !t.name) continue;
      const canon = t.name.replace(/^@/, "").toLowerCase();
      const alias = (t.alias || "").toLowerCase();
      if (q && !canon.includes(q) && !alias.includes(q)
        && !(t.label || "").toLowerCase().includes(q)) continue;
      items.push(t);
    }
    if (!items.length) { closeAC(); return; }
    idx = 0;
    acStart = start;
    acQuery = query;
    ac.dataset.mode = mode;
    drawAC();
    ac.style.display = "";
    const { x, y } = caretXY();
    const w = ac.offsetWidth || 220, h = ac.offsetHeight || 200;
    ac.style.left = Math.max(6, Math.min(x, window.innerWidth - w - 8)) + "px";
    ac.style.top = (y + h > window.innerHeight - 8 ? Math.max(6, y - h - 26) : y) + "px";
    open = true;
  }

  function maybeAC() {
    if (!focused()) { closeAC(); return; }
    const t = text(), c = caret().s;
    const m = /@([^\s@]*)$/.exec(t.slice(0, c));
    if (!m) { closeAC(); return; }
    /* 转义写法 \@ 不该触发补全——与高亮、后端展开三处保持一致 */
    if (t[c - m[0].length - 1] === "\\") { closeAC(); return; }
    openAC(m[1], c - m[0].length);
  }

  /* 写哪个名字，取决于你打的是哪个名字：打了「图片1」就补 @图片1，打了别名
     （或什么都没打）就补别名——否则打 @图片1 回车却插入「小明」，是另一种意外。 */
  function accept(i) {
    const t = items[i];
    if (!t) return;
    const canon = t.name.replace(/^@/, "");
    const q = (acQuery || "").toLowerCase();
    const alias = t.alias || "";
    const useAlias = !!alias && (q === "" || alias.toLowerCase().includes(q)
      || !canon.toLowerCase().includes(q));
    const ins = useAlias
      ? (t.strict ? "@" + alias : alias)
      : (t.name.startsWith("@") ? t.name : "@" + t.name);
    /* 要替换的范围由 acStart + 查询串长度完全确定（就是「@ + 你打的字」），
       不必去问 DOM 现在的插入符在哪。20261028：原来用的是 caret().s，而
       caret() 在选区失效时会把位置报成"文末"，于是回车上屏的那一刻变成
       「从 @ 一直删到全文结尾」—— 用户看到的就是这行后面的字全没了。 */
    replaceRange(acStart, acStart + 1 + (acQuery || "").length, ins);
    ed.focus();
  }

  /* ---------------- 悬停预览 ---------------- */

  const tip = el("div", "gcast-toktip");
  document.body.append(tip);
  const hideTip = () => { tip.style.display = "none"; };

  const tokFrom = (e) => {
    let n = e.target;
    if (n && n.nodeType === 3) n = n.parentElement;
    return n && n.closest ? n.closest(".tok") : null;
  };

  /* 浮窗内容按素材类型分三路（类型判定见上面 kindOfCanon）。 */
  function showTip(sp) {
    const canon = sp.dataset.canon || sp.dataset.tok;
    const file = sp.dataset.file || "";
    tip.replaceChildren();
    if (!file) {
      tip.append(el("span", "cap", canon + " 指向空槽位，请补充参考素材"));
    } else {
      const kind = kindOfCanon(canon);
      if (kind === "audio") {
        /* 音频没有画面：给音符 + 文件名。之前这里也塞 <img>，浏览器拿到的
           是一段 wav，渲染成破图，用户会以为"显示的怎么是别的素材"。 */
        tip.append(el("span", "glyph", "♪ " + baseName(file)),
                   el("span", "cap", canon));
      } else if (kind === "video") {
        const v = el("video");
        v.src = view(file);
        v.muted = true; v.preload = "metadata"; v.playsInline = true;
        tip.append(v, el("span", "cap", canon));
      } else {
        const im = el("img");
        im.src = view(file);
        tip.append(im, el("span", "cap", canon));
      }
    }
    tip.style.display = "block";
    const r = sp.getBoundingClientRect();
    const tw = tip.offsetWidth || 170;
    tip.style.left = Math.min(Math.max(8, r.left), window.innerWidth - tw - 8) + "px";
    tip.style.top = Math.min(r.bottom + 6, window.innerHeight - 140) + "px";
  }

  ed.addEventListener("mouseover", (e) => {
    const sp = tokFrom(e);
    if (sp) showTip(sp); else hideTip();
  });
  ed.addEventListener("mouseout", (e) => {
    const sp = tokFrom(e);
    if (sp && !sp.contains(e.relatedTarget)) hideTip();
  });
  ed.addEventListener("scroll", hideTip);

  /* 点空白处收起补全列表与预览浮窗。不能只靠编辑区的 blur：LiteGraph 在画布
     pointerdown 上 preventDefault（防选中文字/拖拽干扰），焦点因此**不会**离开
     编辑区，blur 永远不触发，浮窗就赖在屏幕上不走。所以在这里按「目标不在浮窗里」
     兜底收起。
     20261028：原先还放过「目标在编辑区内」这一条，结果点文案正文里的空白不收 ——
     编辑区占满整个面板，所谓"点击旁边空白处"几乎总是落在编辑区里。
     编辑区内任何点击都会移动插入符，而列表仍挂在旧的 acStart 上：留着它不只是
     碍眼，下一次输入会按旧起点替换，把已经写好的字吃掉。所以只放过浮窗自身。 */
  const onDocDown = (e) => {
    if (ac.contains(e.target)) return;
    closeAC();
    hideTip();
  };
  document.addEventListener("pointerdown", onDocDown, true);

  /* ---------------- 写回与撤销 ---------------- */

  let prevText = "";
  const undo = [], redo = [];
  let lastPush = 0;

  const fire = () => { if (!ro && onChange) onChange(text()); };

  /* 入栈的是「本次编辑前的文本」。600ms 内的连续输入合并成一步，
     免得一个字撤一次。 */
  function remember() {
    if (Date.now() - lastPush < 600) return;
    undo.push(prevText);
    if (undo.length > 200) undo.shift();
    redo.length = 0;
    lastPush = Date.now();
  }

  function replaceRange(start, end, str) {
    if (ro) return;                              // 只读镜像：外部文本只作展示
    const t = text();
    const s = Math.max(0, Math.min(start, t.length));
    const e = Math.max(s, Math.min(end, t.length));
    const next = t.slice(0, s) + str + t.slice(e);
    remember();
    sig = "";                                    // 强制重绘
    ed.textContent = next;
    paint(next, Math.min(s + str.length, next.length));
    closeAC();
    prevText = next;
    fire();
  }

  function applyHistory(t) {
    if (t == null) return;
    const cur = text();
    let i = 0;
    while (i < cur.length && i < t.length && cur[i] === t[i]) i++;   // 光标落在分歧点
    sig = "";
    ed.textContent = t;
    paint(t, i);
    closeAC();
    prevText = t;
    fire();
  }

  let composing = false;
  ed.addEventListener("compositionstart", () => { composing = true; });
  /* compositionend 不能立即 sync()：此刻浏览器还没把拼音替换成汉字，text()
   * 读到的仍是拼音串，paint() 重建 DOM 会把拼音固化、顶掉候选。等下一帧
   * 上屏完成后再重绘。composing 标志也留到那时才清，挡住这期间漏进来的
   * input 事件（部分输入法上屏瞬间 e.isComposing 已为 false）。 */
  ed.addEventListener("compositionend", () => {
    requestAnimationFrame(() => {
      composing = false;
      sync();
    });
  });

  ed.addEventListener("input", (e) => {
    if (e.isComposing || composing) return;      // 输入法拼字期间重建 DOM 会打断候选
    remember();
    sync();
  });

  function sync() {
    const t = text();
    paint(t, focused() ? caret().s : null);
    prevText = t;
    track();
    fire();
    maybeAC();
  }

  ed.addEventListener("keydown", (e) => {
    /* LiteGraph 的 processKey 只跳过 <input>，不认 contenteditable：按键冒泡
       上去会被当成画布快捷键（Ctrl+Z 直接回滚整个工作流），一律挡在节点内。 */
    e.stopPropagation();
    if (ro) return;                // 只读：编辑入口全关，但仍要挡住画布快捷键
    const k = (e.key || "").toLowerCase();
    if (e.ctrlKey || e.metaKey) {
      if (k === "z" || k === "y") {
        e.preventDefault();
        const cur = text();
        if (k === "y" || e.shiftKey) {
          const n = redo.pop();
          if (n == null) return;
          undo.push(cur); applyHistory(n);
        } else {
          const p = undo.pop();
          if (p == null) return;
          redo.push(cur); applyHistory(p);
        }
      }
      return;
    }
    if (open) {
      if (k === "arrowdown" || k === "arrowup") {
        e.preventDefault();
        idx = (idx + (k === "arrowdown" ? 1 : items.length - 1)) % items.length;
        drawAC();
        return;
      }
      if (k === "enter" || k === "tab") { e.preventDefault(); accept(idx); return; }
      if (k === "escape") { e.preventDefault(); closeAC(); return; }
    }
    if (k === "enter" && !flat) {                // 非 Chromium 的退路：手写换行
      e.preventDefault();
      replaceRange(caret().s, caret().e, "\n");
      return;
    }
  });
  ed.addEventListener("keyup", (e) => { e.stopPropagation(); track(); });
  ed.addEventListener("mouseup", track);
  ed.addEventListener("pointerdown", (e) => e.stopPropagation());
  ed.addEventListener("wheel", (e) => e.stopPropagation());
  ed.addEventListener("cut", (e) => e.stopPropagation());
  ed.addEventListener("copy", (e) => e.stopPropagation());
  ed.addEventListener("paste", (e) => {
    e.preventDefault(); e.stopPropagation();
    const dt = e.clipboardData || window.clipboardData;
    const t = dt ? dt.getData("text/plain") : "";
    if (t) replaceRange(caret().s, caret().e, t);
  });
  ed.addEventListener("blur", () => { closeAC(); hideTip(); });

  /* ---------------- 对外 ---------------- */

  return {
    node: ed,

    getText: text,

    readonly: () => ro,

    /* 转只读镜像（外接提示词接管时用）：只关写入，不动选区、不触发 onChange；
       高亮与悬停预览照常可用。 */
    setReadonly(v) {
      const next = !!v;
      if (next === ro) return;
      ro = next;
      ed.setAttribute("contenteditable", ro ? "false" : (flat ? "plaintext-only" : "true"));
      ed.classList.toggle("gcast-ro", ro);
      if (ro) { closeAC(); hideTip(); }
    },

    /* 外部写入（载入存档、撤销外部来源）：不走 onChange，避免回声 */
    setText(t, caretPos) {
      const s = String(t == null ? "" : t);
      if (s === text()) { if (caretPos != null) setCaret(caretPos); return; }
      sig = "";
      ed.textContent = s;
      paint(s, caretPos != null ? caretPos : null);
      closeAC();
      prevText = s;
    },

    /* 在插入点插入（chips 点击走这里）；未聚焦时退回上次记录的光标位置 */
    insert(str) {
      const pos = focused() ? caret().s : Math.min(lastCaret, text().length);
      replaceRange(pos, pos, str);
    },

    /* 词表变了（媒体架增删素材）→ 重绘高亮；补全面板开着就按当前查询重开 */
    refresh() {
      sig = "";
      const q = open ? /@([^\s@]*)$/.exec(text().slice(0, caret().s)) : null;
      paint(text(), focused() ? caret().s : null);
      if (q) maybeAC(); else closeAC();
    },

    focus() { ed.focus(); },

    destroy() {
      document.removeEventListener("pointerdown", onDocDown, true);
      ac.remove();
      tip.remove();
    },
  };
}
