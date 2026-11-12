/* ============================================================
 * H3 媒体架 — 槽位纠错（腾位 / 归位）
 * ------------------------------------------------------------
 * 前提：**槽位是有语义的**。这个工程里第 24~30 格就是"核心帧槽位"，全片固定，
 * 每段文案都按这个编号写（clip_0001 写 @图片24 = KF_01-01，clip_0011 写
 * @图片28 = KF_01-05）。在这个约定下，格子放错东西是**错误**，不是"用户的选择"。

 * 于是有两类错，各有各的修法：
 *   ① moved   —— 素材在架上，只是放错了格（KF_01-05 躺在第 7 格，文案写第 28 格）
 *                → **归位**：挪回它该在的那格。图就在架上，连补图都不用。
 *   ② missing —— 素材全片都没有（KF_01-05 压根没导入），那一格却挂着别的图
 *                → **腾位**：把占位的图请到末尾，槽位留空。
 *                  宁可让引用落空（会报缺口），也不能让模型拿错图当基准 ——
 *                  核心帧基准错了，出来的画面"看着还行"，是最难发现的那一类。

 * 为什么敢自动做（这个决定是被用户纠正出来的，20261024）：
 *   我一开始怕"自动搬动素材"会破坏编号。那是建立在"槽位无语义、图随便放"的
 *   假设上的。槽位既然有固定语义，占位的图本来就不在那儿 —— 请走它是纠错。
 *   而且引用有两条，都不怕搬：
 *     · 写名字的（别名）→ 后端按名字找槽位，图挪到哪跟到哪；
 *     · 写编号的（@图片28）→ 语义就是"第 28 格"，那格本该是 KF_01-05，
 *       腾空之后它报缺口，正是我们想要的。

 * 但"自动"≠"静默"。三道保险：
 *   ① 只动**文案明确断言过**的格子（定义句点名了"这一格是谁"），不猜；
 *   ② 一次一报：toast + 控制台清单 + 落流水事件，移动明细写清楚；
 *   ③ `ui.vacateUndo()` 可还原上一次移动（按记录反向搬回去）。
 * ============================================================ */
import { defClaimsOf } from "./bz_prompt_build.js";
import { deskTextFor, deskTextAt } from "./csglide_rack_refs.js";
import { MAX_SLOTS } from "./csglide_rack_core.js";

/* 别的段里有没有这件素材？用**本架自己的段记忆**（ui.st.segs）查，不问后端。
   媒体架本来就有各段的快照副本，用它就够了 —— 也避免这条纠错链依赖网络。 */
function elsewhereOf(ui, selfCid) {
  let cache = null;
  const self = String(selfCid || "");
  return (name) => {
    if (cache === null) {
      cache = new Map();
      const segs = (ui.st && ui.st.segs) || {};
      for (const c of Object.keys(segs)) {
        if (!c || c === self) continue;
        const r = segs[c];
        const imgs = r && r.slots && r.slots.images;
        if (!Array.isArray(imgs)) continue;
        imgs.forEach((slot, i) => {
          if (!slot || !slot.file) return;
          const nm = slotName(slot);
          if (nm && !cache.has(nm)) cache.set(nm, { cid: c, idx: i });
        });
      }
    }
    return cache.get(name) || null;
  };
}

/* 与 bz_prompt_build.slotLabel 同一套取值：别名优先、文件名主干兜底。
   不直接 import 它是为了不让"上架纠错"这条链依赖编译模块的内部实现 ——
   这里只需要"这一格叫什么"，一行就说清了。 */
function slotName(slot) {
  if (!slot) return "";
  const raw = slot.alias;
  const first = String(Array.isArray(raw) ? raw.join("，") : (raw || ""))
    .split(/[,，、;；]+/).map((s) => String(s).trim()).filter(Boolean)[0];
  const file = String(slot.file || "");
  return first || file.replace(/\\/g, "/").split("/").pop().replace(/\.[^.]+$/, "");
}

/* 把 from 格的素材搬到 to 格（to 可以是末尾 = 长度），from 留空。
   不改任何其它格子 —— 搬动只影响这两格，其余编号一律不动。 */
function moveTo(arr, from, to) {
  const moving = arr[from];
  if (!moving || !moving.file) return null;
  arr[from] = {};
  if (to >= arr.length) arr.push(moving);
  else arr.splice(to, 0, moving);
  return moving;
}

/* **交换**两格（归位专用）。
   ⚠ 不能用 moveTo 的 splice 插入：目标格被让开之后已经是个空 {}，再往那个
   下标"插入"会把空壳和后面所有素材整体后移一格 —— 归位出一对多余空位，
   编号跟着整体平移（20261024 自测【2】抓到的）。归位要的是**两格互换**：
   KF_01-05 去目标格，目标格现在的东西（多半是刚让出来的空位）回到原格。 */
function swapSlots(arr, from, to) {
  const a = arr[from];
  if (!a || !a.file) return null;
  arr[from] = arr[to] || {};
  arr[to] = a;
  return a;
}

/* 收掉尾部空槽。与媒体架「尾格清空即收缩（编号永不漂移）」同一条规则 ——
   撤销之后末尾会留下一个 append 出来的空壳，不收就是"多了一个空格子"。 */
function trimTail(arr) {
  while (arr.length && !(arr[arr.length - 1] || {}).file) arr.pop();
}

/* 段 → 那一段的架况。当前段摆在 ui.st 上，其它段在 ui.st.segs[cid] 里。
   取不到返回 null（那一段还没有素材清单）。 */
function rackOf(ui, cid) {
  const cur = String((ui.st && ui.st.cur) || "");
  if (!cid || cid === cur) return (ui.st && ui.st.slots) ? ui.st : null;
  const segs = (ui.st && ui.st.segs) || {};
  const r = segs[cid];
  return (r && r.slots) ? r : null;
}

export function installVacate(ui) {
  /* 上一次移动的明细：撤销用。只留一份（连续的纠错用户一般只回退一步）。
     每条都带 cid —— 「排全部段」会一次纠好几段，撤销得知道回哪一段去搬。 */
  let lastUndo = null;

  /* 算出**这一段**每一格"错在哪"。不写任何状态，纯读 —— 可以反复调用。
     cid 省略 = 当前段（界面上摆着的那一段）。
     texts 省略 = 自己去文案台读；由排序按钮传进来时，用的就是**它刚刚排序用的
     那份文本**。这一条很重要：两处各读一次文案，只要有一次读不到（文案台没
     定位到、段键对不上），纠错就静默不动 —— 而排序照样工作，用户看到的是
     "排序有效、纠错无效"，最难归因的一种。一份文本，两个消费者。 */
  function planFor(cid, texts) {
    const cur = String((ui.st && ui.st.cur) || "");
    const key = String(cid || cur || "");
    const rack = rackOf(ui, key);
    const empty = { moved: [], missing: [], text: "", cid: key };
    if (!rack) return empty;
    let text = "", known = false;
    if (texts && texts.length) {
      text = texts.join("\n");
      known = true;
    } else {
      try {
        /* 非当前段要走 deskTextAt（按段身份直读文案台的段表）；当前段走
           deskTextFor，与亮/灰同一套判据。 */
        const got = (key && key !== cur && typeof deskTextAt !== "undefined")
          ? deskTextAt(ui, key) : deskTextFor(ui);
        text = String((got && got.text) || "");
        known = !!(got && got.known);
      } catch (_) { return empty; }
    }
    if (!known || !text) return empty;
    const imgs = (rack.slots && rack.slots.images) || [];
    let chk = { problems: [] };
    try {
      chk = defClaimsOf(text, { slots: rack.slots }, elsewhereOf(ui, key));
    } catch (_) { return empty; }
    const moved = [], missing = [];
    for (const p of chk.problems || []) {
      if (p.kind === "moved") {
        /* 图在架上但放错格 → 归位（目标格若有别的图，那张先让开、去末尾） */
        if (p.at >= 1 && p.at - 1 < imgs.length) {
          moved.push({ want: p.idx, at: p.at - 1, claim: p.claim, tok: p.tok });
        }
      } else if (p.kind === "missing") {
        /* 全片都没有 → 把占位图请走，槽位留空等补图 */
        const curSlot = imgs[p.idx];
        if (curSlot && curSlot.file) {
          missing.push({ want: p.idx, claim: p.claim, tok: p.tok, actual: slotName(curSlot) });
        }
      }
    }
    /* 按目标格升序处理：末尾是 append，前面的索引不会被后面影响。 */
    moved.sort((a, b) => a.want - b.want);
    missing.sort((a, b) => a.want - b.want);
    return { moved, missing, text, cid: key };
  }

  /* 真正执行某一段。返回 { moved, vacated, undo, skipped, cid } —— 调用方拿它去报。 */
  function runFor(cid, texts) {
    const { moved, missing, cid: key } = planFor(cid, texts);
    const rack = rackOf(ui, key);
    const blank = { moved: [], vacated: [], undo: null, cid: key };
    if (!rack) return blank;
    const imgs = (rack.slots && rack.slots.images) || [];
    if (!moved.length && !missing.length) return blank;

    const undo = [];
    const doneM = [], doneV = [];
    let skipped = 0;

    /* ① 归位：素材在架上、放错了格 → 挪回它该在的格 */
    for (const m of moved) {
      if (imgs.length >= MAX_SLOTS) { skipped++; continue; }
      const from = m.at;
      let to = m.want;
      if (from === to) continue;
      /* 目标格被别的图占了 → 那张先去末尾（本轮末尾，不覆盖、不删） */
      const blocker = imgs[to];
      if (blocker && blocker.file) {
        if (imgs.length >= MAX_SLOTS) { skipped++; continue; }
        const b = moveTo(imgs, to, imgs.length);
        if (!b) { skipped++; continue; }
        undo.push({ cid: key, name: slotName(b), from: to, to: imgs.length - 1 });
      }
      const g = swapSlots(imgs, from, to);
      if (!g) { skipped++; continue; }
      undo.push({ cid: key, name: slotName(g), from, to });
      doneM.push({ name: m.claim, from: from + 1, to: to + 1, tok: m.tok });
    }

    /* ② 腾位：素材全片都没有 → 占位图去末尾，槽位留空 */
    for (const v of missing) {
      if (imgs.length >= MAX_SLOTS) { skipped++; continue; }
      const g = moveTo(imgs, v.want, imgs.length);
      if (!g) { skipped++; continue; }
      undo.push({ cid: key, name: slotName(g), from: v.want, to: imgs.length - 1 });
      doneV.push({ want: v.want + 1, claim: v.claim, tok: v.tok,
                   moved: slotName(g), to: imgs.length });
    }

    /* 一格都没搬成也要把 skipped 带出去 —— 否则"槽位满了搬不动"这件事在
       这里就被吞掉了，上层看到的是一个空的正常结果（自测【7】抓到的）。 */
    if (!undo.length) return Object.assign(blank, { skipped });
    lastUndo = undo.slice();
    return { moved: doneM, vacated: doneV, undo: lastUndo, skipped, cid: key };
  }

  /* 一次完整的"检查 → 搬 → 告知 → 落库"。
     quiet 用于自动时机（切段后）：没有错就一声不出，有错才说。
     silent 用于调用方自己要合并播报（排序按钮）：明细照样打控制台、照样可撤销，
     只是不弹 toast —— 否则 8 段连弹 8 条，把真正要看的那条挤没了。
     texts 见 planFor：排序按钮把它刚用完的那份文本直接交过来。 */
  function vacate(quiet, cid, silent, texts) {
    let out = { moved: [], vacated: [], undo: null, lines: [], warn: [], cid: String(cid || "") };
    try {
      out = Object.assign(out, runFor(cid, texts));
    } catch (e) {
      console.warn("[媒体架] 槽位纠错失败（素材未动）:", e);
      return out;
    }
    /* 先把"该说什么"算齐，再决定要不要落库 —— 因为**搬不动**也是一种结果，
       而且是一种最容易变成"点了没反应"的结果（槽位满了 MAX_SLOTS，moveTo
       跳过）。与这次修掉的那个提前返回属于同一类：失败必须出声。 */
    const lines = [];
    for (const m of out.moved || []) {
      lines.push(`${m.tok} 要的是「${m.name}」：从第 ${m.from} 格挪回第 ${m.to} 格`);
    }
    for (const v of out.vacated || []) {
      lines.push(`${v.tok} 要的「${v.claim}」全片都没有 —— 第 ${v.want} 格已腾空，`
        + `占位的「${v.moved}」移到第 ${v.to} 格`);
    }
    const warn = [];
    if (out.skipped) {
      warn.push(`${out.skipped} 格挪不开：槽位已满 ${MAX_SLOTS} 格，`
        + `先删掉几张用不到的素材，再点一次`);
    }
    out.lines = lines;
    out.warn = warn;
    if (!out.undo) {
      if (warn.length) {
        console.warn("[媒体架] 槽位纠错未搬动：" + warn.join("；"));
        if (!silent) { try { ui.toast?.(warn.join("；"), true, 9000); } catch (_) {} }
      } else if (!quiet && !silent) {
        ui.toast?.("这一段的槽位都对得上，不用动");
      }
      return out;
    }
    const cur = String((ui.st && ui.st.cur) || "");
    const isCur = !out.cid || out.cid === cur;
    try {
      if (isCur) { ui.renderImages?.(); ui.commit?.(); }
      else ui.saveSegRack?.(out.cid);
    } catch (_) {}
    const where = isCur ? "" : `（${out.cid}）`;
    const txt = `${where}槽位纠错 ${lines.length} 处：${lines.join("；")}`;
    console.warn("[媒体架] " + txt
      + "（撤销：bzVacateUndo()）");
    if (!silent) {
      try { ui.toast?.(lines.length + " 个槽位已纠正，看控制台明细"); } catch (_) {}
    }
    /* 搬动明细留在 lastUndo 里：撤销走 ui.vacateUndo()，
       事后要查也有一份控制台清单（刚打印过）。不额外落库 —— 架况本身
       已经经 commit 落进工程库了，再记一份反而多一个会对不上的副本。 */
    return out;
  }

  /* 撤销：按记录反向搬回去。从后往前还原，避免中间格被顶乱。
     记录带 cid：一次纠了好几段时，各段回各段，不会搬到别的段去。 */
  function undo() {
    if (!lastUndo || !lastUndo.length) { ui.toast?.("没有可撤销的槽位纠错"); return false; }
    const cur = String((ui.st && ui.st.cur) || "");
    const touched = new Map();      // cid → 那份 slot 对象
    for (const u of lastUndo.slice().reverse()) {
      const key = String(u.cid || cur);
      const rack = rackOf(ui, key);
      if (!rack) continue;
      const imgs = (rack.slots && rack.slots.images) || [];
      const at = u.to >= imgs.length ? imgs.length - 1 : u.to;
      const curSlot = imgs[at];
      if (!curSlot || !curSlot.file) continue;
      imgs[at] = {};
      const back = { file: curSlot.file, alias: curSlot.alias };
      if (u.from >= imgs.length) imgs.push(back); else imgs[u.from] = back;
      touched.set(key, imgs);
    }
    /* 收掉末尾空壳：腾位是 append 出来的，还原后那一位就空了 —— 不收会多出
       一个空格子（自测【3】【4】抓到的）。逐段各收各的。 */
    for (const [, imgs] of touched) trimTail(imgs);
    lastUndo = null;
    for (const key of touched.keys()) {
      if (key && key !== cur) { try { ui.saveSegRack?.(key); } catch (_) {} }
    }
    ui.renderImages?.();
    ui.commit?.();
    ui.toast?.("已还原上次的槽位纠错");
    return true;
  }

  ui.vacate = vacate;
  ui.vacateUndo = undo;
  ui.vacatePlan = planFor;

  /* 自动开关：**不存进 st**。后端 parse_rack_data 是白名单解析（未列出的字段
     在渲染时被丢弃），存进去会在某次 load 之后悄悄变回默认值 —— 那正是
     "我明明关了自动，它怎么又动了"的来源。用闭包变量，语义就是"本次会话"：
     关了就一直是关的，刷新回到默认开。默认开是用户要的行为。 */
  let auto = true;
  ui.vacateAuto = (on) => {
    if (on !== undefined) auto = !!on;
    return auto;
  };
}
