/* ============================================================
 * 图遍历助手 —— 媒体架 / 外接提示词的上游定位
 * ------------------------------------------------------------
 * 导演台、文案台、媒体架都要问同一个问题：「我这根线接的是谁？」
 * 各写一份就会在某次前端改版后各错各的，所以收口在这里。
 *
 * 为什么不用 node.getInputNode(name)：按名字查输入口在部分 ComfyUI 前端
 * 版本下不可靠（本地化会改写 name），一旦失效，媒体架素材就一个都进不了
 * chips——症状是「面板空了」，而根因在千里之外。所以统一走
 * 「按端口类型/名字找 input + 手动查 graph.links」，原方法只作兜底。
 * ============================================================ */
import { api } from "../../scripts/api.js";
import { bzStore } from "./bz_store.js";

/**
 * 前端 bag 版本号（节点闭包版本）。**必须定义在本无环基础模块**：
 * 原来定义在 bz_project_sync.js，但 bz_project_sync 又 import 媒体架/导演台，
 * 媒体架经 rack_seg 再 import bz_project_sync 取本常量 → 形成模块循环，
 * 且新 bag 因此被误判、反复热重建。本文件只依赖 scripts + bz_store，
 * 不依赖任何业务模块，所有节点从这里取。改前端状态结构时 +1。
 */
export const BZ_BAG_VERSION = 20261013;

/** 真正的媒体架节点：带 rack_data widget（或已挂 gmr）的那个。
 *  文案台只是透传 H3_REFS，两样都没有 —— 不能拿它当媒体架。 */
function isRackNode(n) {
  if (!n) return false;
  if (n.gmr) return true;
  return !!(n.widgets && n.widgets.some((w) => w && w.name === "rack_data"));
}

/** 沿 H3_REFS 输入口往上走**一层**（不穿透）。 */
function oneUpstream(node) {
  const inputs = node.inputs || [];
  const inp = inputs.find((s) => s && s.type === "H3_REFS" && s.link != null)
    || inputs.find((s) => s && s.name === "refs" && s.link != null);
  const up = upstreamOf(node, inp);
  if (up) return up;
  return node.getInputNode ? node.getInputNode("refs") : null;
}

/** 找 refs（H3_REFS）输入口接的上游节点 —— 就是媒体架。
 *
 *  ⚠ 只走一层是不够的（20261012「渲染时所有段的参考图没连」的根因）：
 *  现在的常见接线是 **媒体架 → 文案台 → 导演台**，文案台对 H3_REFS 是
 *  **透传**（csglide_desk.py: return (参考素材, text)），自己既没有
 *  rack_data widget 也没有 gmr。只走一层拿到的是文案台，于是：
 *    · rackSnapshot() 读不到 rack_data（raw=""）→ 反而写出一份「空快照」，
 *      把该分段真实记下的素材永久覆盖成空（stash 每切一段写一次）；
 *    · restoreShotRack() 因 rn.gmr 为空直接 return → 媒体架永不被倒回，
 *      切段只能靠 switchSeg 去 segs 里找，而 segs 又是从被清空的
 *      shots[i].rack 借来的空快照 → 三段全空 = 「参考图没连」；
 *    · 导演台 mergedSlots() 也永远读不到媒体架槽位。
 *  所以这里沿 H3_REFS 链路一直往上找，直到遇到真正持有 rack_data 的节点。
 */
export function rackNodeOf(node) {
  const one = oneUpstream(node);
  let n = one;
  let guard = 0;
  while (n && guard++ < 8) {
    if (isRackNode(n)) return n;
    n = oneUpstream(n);
  }
  /* 找不到真媒体架就退回一层（旧行为兜底），绝不能返回 null —— 调用方
     拿 null 会当成"没接媒体架"，把工程级 rack 字段整段抹掉。 */
  return one;
}

/** 找 prompt_text 输入口接的上游文本节点。 */
export function promptNodeOf(node) {
  const inputs = node.inputs || [];
  const inp = inputs.find((s) => s && s.name === "prompt_text" && s.link != null);
  const up = upstreamOf(node, inp);
  if (up) return up;
  return node.getInputNode ? node.getInputNode("prompt_text") : null;
}

function upstreamOf(node, inp) {
  const graph = (typeof app !== "undefined" && app && app.graph) || null;
  if (!inp || !graph || graph.links == null) return null;
  const link = graph.links[inp.link];
  if (!link) return null;
  return graph.getNodeById ? graph.getNodeById(link.origin_id) : null;
}

/* rack_data 的解析缓存：按原文缓存 JSON.parse 的结果。
   击键级调用（chips 每次输入都要重算一遍）不能每次都 parse 一遍整个素材架。 */
let rackParseCache = { nodeId: null, raw: null, slots: { images: [], videos: [], audios: [] } };

/* 广播旁路（20261023 P2 性能专项）：媒体架 commit 时手里已有刚 stringify 的
   最新 rack_data 原文，经 bz:rack-change 事件一并带来；本模块在模块级监听里
   只解析一次、按媒体架节点 id 存这里。之后导演台/文案台所有 rackSlotsOf 调用
   只要发现 widget 原文与旁路是**同一个字符串引用**（=== 先判同指针，O(1)），
   就直接返回解析结果，不再各自 parse 一遍整个素材架（素材多、段数多时整份
   rack_data 可达 MB 量级，每次操作省掉导演台/文案台两次全量解析）。
   widget 被外部改动（Ctrl+Z 回滚、工作流加载、外部写入）时引用必然变化，
   === 不命中 → 自动回退到下面的现场解析，语义不丢。Map 带上限防节点越积越多。 */
const rackFeedCache = new Map();
const RACK_FEED_MAX = 32;

function parseRackSlots(raw) {
  let d = {};
  try { d = JSON.parse(raw); } catch { d = {}; }
  const s = (d && d.slots) || {};
  const arr = (k) => (Array.isArray(s[k]) ? s[k] : []);
  return { images: arr("images"), videos: arr("videos"), audios: arr("audios") };
}

/* 素材真值只在媒体架内存 gmr.st 里（20261110）。rack_data 已改成只存引用，
   再解析 widget 原文会拿到空架，文案台 chips / @ 高亮 / 悬停预览全失效。
   返回的是一份「素材快照 JSON」，广播原文与现场解析用同一口径，缓存才命中。 */
function rackLiveRaw(n) {
  const st = n && n.gmr && n.gmr.st;
  if (!st || !st.slots) return null;
  try {
    return JSON.stringify({ slots: st.slots, fps: st.fps || 0,
                            audio_out: st.audio_out || 0 });
  } catch (_) { return null; }
}

export function rackSlotsOf(node) {
  const w = rackNodeOf(node);
  const nodeId = w && w.id != null ? String(w.id) : null;
  const raw = rackLiveRaw(w)
    || ((w && w.widgets && w.widgets.find((x) => x.name === "rack_data")?.value) || "");
  /* 1) 广播旁路：媒体架最新一次广播带来的原文 + 已解析结果，按节点 id 取。 */
  const feed = nodeId != null ? rackFeedCache.get(nodeId) : null;
  if (feed && feed.raw === raw) return { raw, slots: feed.slots };
  /* 2) 现场解析缓存（同一节点、原文未变）。 */
  if (rackParseCache.nodeId === nodeId && raw === rackParseCache.raw) {
    return { raw, slots: rackParseCache.slots };
  }
  /* 3) 现场解析一次。 */
  const slots = parseRackSlots(raw);
  rackParseCache = { nodeId, raw, slots };
  return { raw, slots };
}

/* 外接提示词：文本源节点五花八门、widget 名不统一，「最长字符串 widget 值」
   是最稳的启发式——用户的提示词几乎总是那个节点里最长的字符串。 */
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

/* ---- 导演台定位 ------------------------------------------------------
   文案台要知道「现在在写哪一段」，而段身份只存在于导演台节点的工程快照里
   （node.properties.gcast_project）。执行顺序上文案台排在导演台前面，所以
   不能等后端告诉它——只能在前端直接问导演台。 */

export const CAST_NODE_ID = "CSGlideCastCS";
export const DESK_NODE_ID = "CSGlideDeskCS";

/** 画布上所有导演台节点（通常只有一个）。 */
export function castNodes() {
  const g = (typeof app !== "undefined" && app && app.graph) || null;
  if (!g || !g._nodes) return [];
  return g._nodes.filter((n) => n && n.type === CAST_NODE_ID);
}

/** 画布上所有文案台节点（通常只有一个）。 */
export function deskNodes() {
  const g = (typeof app !== "undefined" && app && app.graph) || null;
  if (!g || !g._nodes) return [];
  return g._nodes.filter((n) => n && n.type === DESK_NODE_ID);
}

/** 找文案台节点：优先接在本台（导演台）上游的那台，否则取第一个。 */
export function deskNodeOf(node) {
  const all = deskNodes();
  const wired = all.filter((d) => feeds(d, node));
  const list = wired.length ? wired : all;
  return list[0] || null;
}

/**
 * 导演台当前的「片名 + 分段身份」。
 * 文案台拿它认段：同一段来回切，词不会串；新建分段自动跟着走。
 */
export function castProject(node) {
  /* 优先用接了本节点输出的那台导演台（多导演台时不会认错）。

     ⚠️ 参数顺序是 feeds(上游, 下游)：本节点的输出流进导演台，所以本节点是
     上游、导演台是下游，必须写 feeds(node, c)。
     20261020 之前写成 feeds(c, node) —— 那是逆流，「导演台能不能流到媒体架」
     恒为 false（媒体架是导演台的**上游**，rack_data → refs），于是每次调用
     都要把导演台整条下游子图走完才放弃（真实三采工作流实测 366 次递归），
     然后兜底取 castNodes()[0]。两层后果：① 白跑（媒体架侧 7 处调用点 ×
     一次交互多轮 = 上千次递归）；② 语义错 —— 多导演台时永远取第一台，
     恰好是这段注释想避免的事。修正后实测 2 次递归且返回 true。 */
  const wired = castNodes().filter((c) => feeds(node, c));
  const list = wired.length ? wired : castNodes();
  const c = list[0];
  if (!c) { console.warn("[联动] castProject 失败: 画布上找不到导演台节点"); return null; }
  const p = c.properties && c.properties.gcast_project;
  if (!p || !Array.isArray(p.shots)) { console.warn("[联动] castProject 失败: 导演台 properties.gcast_project 为空或无 shots"); return null; }
  const cur = p.shots[p.idx];
  if (!cur) return { name: p.name || "", shot: "", clip: "", index: p.idx,
                     gen: p.gen || 0, cast: c };
  if (!cur.id) cur.id = Math.random().toString(36).slice(2, 9);
  return { name: p.name || "", shot: cur.id, clip: cur.clip || "", index: p.idx,
           gen: p.gen || 0, cast: c };
}

/* ---- 共享的「当前段」 ------------------------------------------------
   三个节点（导演台 / 文案台 / 媒体架）唯一的共享点。导演台切段时立刻写后端，
   另外两个轮询读它 —— ComfyUI 没有给我们跨节点事件机制，而轮询一个
   几十字节的 JSON 是最小的代价。
   注意这与 castProject() 不是一回事：那个读的是导演台节点**内存里的工程
   快照**（即时、但只有导演台自己有）；这个读的是**磁盘档案**（稍有延迟、
   但三个节点看的是同一份）。两者互为兜底。 */

let curCache = { name: "", id: null, at: 0 };
/* 当前段**那一行档案**（index / name / locked / pending / frames）。
   三个节点要告诉用户"现在写的是哪一段"时都读这一份：各自去拼段号、各自判断
   锁定，就会出现三处说法不一致 —— 那正是"统一锚点"要解决的问题。 */
let curRowCache = { name: "", row: null, at: 0 };

/** 一次读回 current 与它那一行档案。两个缓存共用这一读，不额外打后端。 */
async function _readCurrent(name) {
  const res = await api.fetchApi(`/cglide/chain/summary?name=${encodeURIComponent(name)}`);
  const d = await res.json();
  const id = (d && d.current) || null;
  const row = id
    ? (((d && d.clips) || []).find((c) => c && c.id === id) || null)
    : null;
  curCache = { name, id, at: Date.now() };
  curRowCache = { name, row, at: Date.now() };
  return { id, row };
}

export async function currentOf(name) {
  if (!name) return null;
  /* 2 秒内的重复读直接走缓存：轮询是每 900ms 一次，没必要每次都打后端 */
  if (curCache.name === name && Date.now() - curCache.at < 2000) return curCache.id;
  try {
    return (await _readCurrent(name)).id;
  } catch {
    return curCache.name === name ? curCache.id : null;
  }
}

/** 当前段那一行档案；没有当前段（或档案读不到）时返回 null。 */
export async function currentClipOf(name) {
  if (!name) return null;
  if (curRowCache.name === name && Date.now() - curRowCache.at < 2000) {
    return curRowCache.row;
  }
  try {
    return (await _readCurrent(name)).row;
  } catch {
    return curRowCache.name === name ? curRowCache.row : null;
  }
}

/* 切段请求的两道乱序防护（20261012「快速连点 1→2→3，最后跳回旧段」根因）：
   1) curPostSeq 单调序号：快速连点会并发发出多个 POST，旧请求的响应可能**晚于**
      新请求回来；序号过期的响应一律不更新缓存、不广播、不碰 store。
   2) curPostChain 串行化：同片名的 POST 严格按调用顺序排队发出，后端落盘顺序
      与点击顺序一致（否则即便前端不广播，后端最终 current 也可能是旧段，WS
      回声照样把界面拉回去）。
   乐观更新在**发请求前**就广播：界面零延迟跟最后一次点击，权威值由后端回声
   与 bzStore 对账收敛。 */
let curPostSeq = 0;
let curPostChain = Promise.resolve();

/** 导演台切段时调用：把「当前段」写给大家看。 */
export function setCurrent(name, id) {
  if (!name) { console.warn("[联动] setCurrent 跳过: name 为空"); return Promise.resolve(); }
  const mySeq = ++curPostSeq;
  const clip = id || "";
  /* 立即乐观：缓存 / store / 事件总线全部先切到目标段，不等 POST 往返
     （文案台首跳读旧 store 慢半拍的根因也在这里一并解决）。 */
  curCache = { name, id: clip || null, at: Date.now() };
  curRowCache = { name, row: null, at: 0 };
  bzStore.optimisticCurrent(name, clip, mySeq);
  emitCastChange({ name, clip, reason: "set_current", seq: mySeq });
  /* 串行排队：等前一个 POST 落盘后再发本次，保证后端按点击顺序写。 */
  const run = curPostChain.then(async () => {
    try {
      await api.fetchApi("/cglide/chain/current", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, id: clip }),
      });
      /* 过期响应（连点后本次已不是最新一次点击）：什么都不覆盖。
         store 的乐观值由最新那次请求负责对账。 */
      if (mySeq !== curPostSeq) {
        console.log("[联动] setCurrent 过期响应丢弃: name=" + name + " id=" + clip + " seq=" + mySeq + "<" + curPostSeq);
        return;
      }
      console.log("[联动] setCurrent 成功: name=" + name + " id=" + clip);
      curCache = { name, id: clip || null, at: Date.now() };
      curRowCache = { name, row: null, at: 0 };
      /* 权威对账：拉一次档案，让 store 以后端 current 为准（命中乐观值即收敛，
         不一致也由 store 的乐观保护延迟对账，不会把界面拉回旧段）。 */
      bzStore.reconcileCurrent(name, mySeq);
    } catch (e) { console.warn("[联动] setCurrent 失败(被吞):", name, clip, e); }
  });
  /* 队列本身不能因单次失败断掉：吞掉 rejection 并续链。 */
  curPostChain = run.catch(() => {});
  return run;
}

/* ---- 跨节点事件总线（20261012 联动提速）------------------------------
   导演台 / 媒体架 / 文案台 / Qwen 台同处一个 ComfyUI 前端页面（同 window）。
   以前"当前段变了没、素材架空没空"全靠 0.8~1.5s 轮询互相发现 —— 操作后有
   1 秒级迟钝，每次轮询还全量重建 DOM、打后端。现在变化方即时广播，监听方
   即时响应；轮询保留但拉长到 3~5 秒，只作跨标签页 / 外部改动 / 漏事件的兜底。
   事件不走 ComfyUI websocket（那是后端→前端通道），同页面 window 事件零成本。 */
export const CAST_SEG_EVENT = "bz:cast-seg-change";   /* 当前段/工程身份变化 */
export const RACK_CHANGE_EVENT = "bz:rack-change";    /* 媒体架槽位内容变化 */

export function emitCastChange(detail) {
  const d = detail || {};
  console.log("[联动] 广播", d.reason || "?", "name=" + (d.name || ""), "clip=" + (d.clip || ""), "shot=" + (d.shot || ""));
  try { window.dispatchEvent(new CustomEvent(CAST_SEG_EVENT, { detail: d })); }
  catch (e) { console.warn("[联动] 广播失败(退回轮询)", e); }
}
export function onCastChange(fn) {
  const h = (ev) => { try { fn(ev.detail || {}); } catch (e) {} };
  window.addEventListener(CAST_SEG_EVENT, h);
  return () => window.removeEventListener(CAST_SEG_EVENT, h);
}
/* 帧级合帧（20261023 性能专项）：一次操作（批量拖入/排序/参照图替换/
   连续改槽位）可能在同一帧内多次 commit，旧实现每次都同步派发，导演台
   syncRack（大面板全量同步）、文案台 renderChips（素材 chip 全量重建）
   一帧内被反复触发。合并规则：
   · 同一帧 + 同一媒体架节点 id 的多条事件合成一条；
   · 不同节点 id 的事件各自保留（多个媒体架互不吞事件）；
   · 事件只是「数据变了」的信号，监听方收到后自己读最新 widget 值，
     所以合并后它们读到的必是最新状态，语义不丢；
   · 监听方本就按节点 id 过滤、按数据签名去重，合帧不改变其判定。
   后台标签页 rAF 暂停，50ms 定时器兜底。 */
let rackPending = new Map();
let rackRaf = 0;
let rackTimer = 0;
/* 派发前从媒体架节点读最新 rack_data 原文（20261023 P2）：合帧后一帧只读一次，
   事件把原文带给监听方，导演台/文案台不再各自 parse 整个素材架（见 rackFeedCache）。 */
function rackRawOfNode(nodeId) {
  try {
    const g = (typeof app !== "undefined" && app && app.graph) || null;
    if (!g || nodeId == null || !g.getNodeById) return null;
    const n = g.getNodeById(Number(nodeId));
    const live = rackLiveRaw(n);
    if (live) return live;
    const w = n && n.widgets && n.widgets.find((x) => x.name === "rack_data");
    return w ? String(w.value == null ? "" : w.value) : null;
  } catch (_) { return null; }
}
function flushRackChange() {
  rackRaf = 0;
  if (rackTimer) { clearTimeout(rackTimer); rackTimer = 0; }
  const pend = rackPending;
  rackPending = new Map();
  pend.forEach((d) => {
    if (d.raw === undefined) d.raw = rackRawOfNode(d.node);
    try { window.dispatchEvent(new CustomEvent(RACK_CHANGE_EVENT, { detail: d })); }
    catch (e) {}
  });
}
export function emitRackChange(detail) {
  const d = detail || {};
  const key = d.node == null ? "_g" : String(d.node);
  const prev = rackPending.get(key);
  if (prev) {
    if (d.reason && String(prev.reason || "").indexOf(d.reason) < 0) {
      prev.reason = prev.reason ? prev.reason + "+" + d.reason : d.reason;
    }
    return;
  }
  rackPending.set(key, { node: d.node, reason: d.reason });
  if (rackRaf) return;
  rackRaf = requestAnimationFrame(flushRackChange);
  rackTimer = setTimeout(() => {
    if (rackRaf) { cancelAnimationFrame(rackRaf); flushRackChange(); }
  }, 50);
}
export function onRackChange(fn) {
  const h = (ev) => { try { fn(ev.detail || {}); } catch (e) {} };
  window.addEventListener(RACK_CHANGE_EVENT, h);
  return () => window.removeEventListener(RACK_CHANGE_EVENT, h);
}

/* ---- 文案台文本变化（20261023 第三刀配套）----------------------------
   媒体架上有「这一格被本段文案引用没引用」的亮/灰（见 csglide_rack_refs.js 的
   paintRefMarks）。它要跟着文案**实时**亮灭：写 `@图片3` 第 3 格就亮、
   删掉就灭。在此之前文案台只写自己的 desk_data、什么都不广播，媒体架只能等
   下一次自身重渲（切段 / 落图 / 提交）才知道文案变了 —— 表现正是"刚写的
   引用不亮"。

   与 rack 同一条合帧理由：一次编辑会连着 commit（打字、粘贴一整段、切段），
   而监听方只关心"文本变了没有"，一帧派发一次就够。detail 只带身份
   （name/clip），文本由监听方自己去读 —— 事件带正文会让"谁是最新"这件事
   多出一个副本可以漂。 */
export const DESK_CHANGE_EVENT = "bz:desk-change";
let deskPending = null;
let deskRaf = 0;
let deskTimer = 0;
function flushDeskChange() {
  deskRaf = 0;
  if (deskTimer) { clearTimeout(deskTimer); deskTimer = 0; }
  const d = deskPending;
  deskPending = null;
  if (!d) return;
  try { window.dispatchEvent(new CustomEvent(DESK_CHANGE_EVENT, { detail: d })); }
  catch (e) {}
}
export function emitDeskChange(detail) {
  const d = detail || {};
  if (deskPending) {
    if (d.reason && String(deskPending.reason || "").indexOf(d.reason) < 0) {
      deskPending.reason = deskPending.reason
        ? deskPending.reason + "+" + d.reason : d.reason;
    }
    if (d.clip !== undefined) deskPending.clip = d.clip;
    if (d.name !== undefined) deskPending.name = d.name;
  } else {
    deskPending = { name: d.name, clip: d.clip, reason: d.reason };
  }
  if (deskRaf) return;
  if (typeof requestAnimationFrame === "function") {
    deskRaf = requestAnimationFrame(flushDeskChange);
    deskTimer = setTimeout(() => {
      if (deskRaf) { cancelAnimationFrame(deskRaf); flushDeskChange(); }
    }, 50);
  } else {
    flushDeskChange();               // 没有 rAF（老浏览器 / 测试环境）：直接派
  }
}
export function onDeskChange(fn) {
  const h = (ev) => { try { fn(ev.detail || {}); } catch (e) {} };
  window.addEventListener(DESK_CHANGE_EVENT, h);
  return () => window.removeEventListener(DESK_CHANGE_EVENT, h);
}

/* 模块级旁路喂料（20261023 P2）：本模块是无环基础模块，各节点面板代码都
   import 它，所以这个监听注册得早；事件到达时先在这里解析一次存进
   rackFeedCache，导演台/文案台面板的监听随后调 rackSlotsOf 直接 O(1) 命中。
   解析口径与现场解析完全一致（parseRackSlots）。 */
if (typeof window !== "undefined") {
  window.addEventListener(RACK_CHANGE_EVENT, (ev) => {
    try {
      const d = (ev && ev.detail) || {};
      if (d.node == null || typeof d.raw !== "string" || !d.raw) return;
      const id = String(d.node);
      rackFeedCache.set(id, { raw: d.raw, slots: parseRackSlots(d.raw) });
      while (rackFeedCache.size > RACK_FEED_MAX) {
        rackFeedCache.delete(rackFeedCache.keys().next().value);
      }
    } catch (_) {}
  });
}

/**
 * 从导演台**内存工程快照**里借某段（缺省=当前段）的媒体架快照 rack。
 * 媒体架轮询发现"档案 current 跳到一个我没记过的新段"时用它兜底 ——
 * 新段刚 addShot、轮询比导演台 restoreShotRack 快的那个竞态窗口里，
 * 旧实现直接把架上清空（参考图"复制后消失"的根因）；现在先问导演台要。
 */
export function castShotRack(node, clipId) {
  const p0 = castProject(node);
  if (!p0 || !p0.cast) return null;
  const proj = p0.cast.properties && p0.cast.properties.gcast_project;
  if (!proj || !Array.isArray(proj.shots)) return null;
  const shot = clipId
    ? proj.shots.find((s) => s && (s.clip === clipId || s.id === clipId))
    : proj.shots[proj.idx];
  return shot && shot.rack ? shot.rack : null;
}

/**
 * downstream 是否直接或间接吃得到 upstream 的输出。
 *
 * visited 不是优化，**是正确性**：原实现只挡了「回到终点」（mid !== downstream），
 * 没挡回到起点或任何环。ComfyUI 画布允许连出环（执行时才检测），一有环就是
 * 无限递归爆栈。就算没环，分叉再汇合（三采工作流到处都是：视频/音频两条解码
 * 再一起进视频合并）也会让同一节点被不同路径重复展开 —— 复杂度是**路径数**，
 * 不是节点数。真实工作流实测：无 visited 366 次、有 visited 20 次、再修正
 * 参数方向只要 2 次（_bench_feeds.mjs）。
 */
function feeds(upstream, downstream) {
  /* app.graph 只取一次。原来在最内层循环里逐条链接地取（typeof app !==
     "undefined" && app && app.graph），一次 366 次递归就是约千次重复求值。 */
  const g = (typeof app !== "undefined" && app && app.graph) || null;
  if (!g || !g.links) return false;

  const seen = new Set([upstream.id]);     // 含起点：挡住自环与绕回起点
  const walk = (from) => {
    for (const o of from.outputs || []) {
      for (const lid of o.links || []) {
        const link = g.links[lid];
        if (!link) continue;
        if (link.target_id === downstream.id) return true;
        const mid = g.getNodeById ? g.getNodeById(link.target_id) : null;
        if (!mid || mid === downstream || seen.has(mid.id)) continue;
        seen.add(mid.id);
        if (walk(mid)) return true;
      }
    }
    return false;
  };
  return walk(upstream);
}
