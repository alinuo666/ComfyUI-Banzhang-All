/* ============================================================
 * H3 工程状态库（SQLite 方案 A · 20261012）— 前端同步中枢
 * ------------------------------------------------------------
 * 后端 /cglide/store/* 是**新工程**（output/h3_chain/<片名>/project.db）
 * 的权威状态库；老工程（chain.json）后端返回 backend=json，本模块所有
 * 动作一律静默跳过，两套工程互不干扰。
 *
 * 职责：
 *   1. rack / desk / event / snapshot 的 HTTP 封装（供媒体架、文案台落库）；
 *   2. hydrateFromStore(导演台节点)：启动 / 刷新 / 读档后，库为权威，
 *      把 clips[].state、racks、desk 灌回导演台 / 媒体架 / 文案台；
 *   3. startSelfHeal(导演台节点)：热重载不会重跑 onNodeCreated，媒体架 /
 *      文案台可能还是热重载前的旧 bag（闭包无法在线替换）。检测到旧 bag
 *      时从库重灌数据并提示 Ctrl+F5；新 bag 则带 BAG_VERSION 标记。
 * ============================================================ */
import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { castNodes, rackNodeOf, BZ_BAG_VERSION } from "./bz_rack.js";
import { rebuildMediaRackUI } from "./csglide_media_rack.js";
import { rebuildCastUI } from "./csglide_cast.js";
import { parseInitial } from "./csglide_cast_core.js";
import { projectStore } from "./bz_project_store.js";

/* BAG_VERSION 已移到无环基础模块 bz_rack（避免 bz_project_sync→媒体架→
   rack_seg→bz_project_sync 的循环）。re-export 保持旧 import 路径兼容。 */
export { BZ_BAG_VERSION } from "./bz_rack.js";

const DESK_NODE_ID = "CSGlideDeskCS";

/* ---------------- HTTP 封装 ---------------- */

/* 后端版本错配检测：插件 Python 端更新（新增 /cglide/store/* 路由）后必须
   **完全重启 ComfyUI**（关掉黑窗口重开，不是 Ctrl+F5 —— 那只刷新浏览器侧
   JS）。若后端还是旧进程，这组路由根本不存在：POST 会被 ComfyUI 的静态
   资源处理器兜底成 405（Allow: GET,HEAD），GET 是 404。此时素材/文案全部
   落不了库，只在内存里，一刷新就丢 —— 必须给出醒目且一次性的提示，
   而不是每 700ms 刷一条"落库失败"让用户在日志里猜。 */
let _backendMissing = false;
let _missingBanner = null;
function showBackendMissingBanner() {
  if (_backendMissing) return;
  _backendMissing = true;
  console.warn("[状态库] 后端 /cglide/store/* 接口不存在（404/405）——插件已更新但 "
    + "ComfyUI 后端进程未重启。请完全关闭 ComfyUI（黑窗口）再启动；重启前素材与"
    + "文案只在内存中，刷新页面会丢失。");
  try {
    const d = document.createElement("div");
    d.style.cssText = "position:fixed;left:50%;top:14px;transform:translateX(-50%);"
      + "z-index:999999;max-width:82vw;background:#3a1d1d;color:#ffd9d9;"
      + "border:1px solid #a94444;border-radius:8px;padding:10px 38px 10px 14px;"
      + "font:13px/1.5 system-ui,sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.45);"
      + "pointer-events:auto;white-space:pre-wrap;";
    d.textContent = "⚠️ 班长状态库后端未加载：插件更新后需要**完全重启 ComfyUI**"
      + "（关闭黑窗口重新启动；Ctrl+F5 只刷新浏览器，无效）。\n"
      + "重启前摆的素材/文案不会落库，刷新会丢，段素材还会显示错乱。";
    const x = document.createElement("button");
    x.textContent = "×";
    x.style.cssText = "position:absolute;right:6px;top:6px;border:0;background:transparent;"
      + "color:#ffd9d9;font-size:16px;cursor:pointer;";
    x.onclick = () => { d.remove(); _missingBanner = null; };
    d.append(x);
    document.body.appendChild(d);
    _missingBanner = d;
  } catch (_) { /* 非浏览器环境静默 */ }
}
function clearBackendMissing() {
  if (!_backendMissing) return;
  _backendMissing = false;
  if (_missingBanner) { try { _missingBanner.remove(); } catch (_) {} _missingBanner = null; }
}
/** 路由根本不存在（旧后端）：404（GET）或 405（POST 被静态处理器兜底）。 */
function isBackendMissing(resOrStatus) {
  const s = typeof resOrStatus === "number" ? resOrStatus : (resOrStatus && resOrStatus.status);
  return s === 404 || s === 405;
}

async function postJSON(url, body) {
  const res = await api.fetchApi(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  if (!res.ok) {
    if (isBackendMissing(res)) { showBackendMissingBanner(); }
    let msg = "";
    try { msg = (await res.json()).error || ""; } catch (_) {}
    const err = new Error(msg || ("HTTP " + res.status));
    err.status = res.status;
    throw err;
  }
  clearBackendMissing();
  return res.json();
}

/* 带超时的 GET（默认 8s）：后端可能被别的慢请求/连接池卡住，浏览器侧请求
   若不超时会永久 inflight、堆积并耗尽同域 6 个连接，最终连"新建工程"都
   点不动。超时后当本轮失败，self-heal 下轮再试。 */
async function fetchWithTimeout(url, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms || 8000);
  try {
    return await api.fetchApi(url, { signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** 拉工程全量（老工程返回 {backend:"json"}，无库返回 {backend:"none"}）。 */
export async function getProject(name) {
  if (!name) return null;
  try {
    const res = await fetchWithTimeout(
      `/cglide/store/project?name=${encodeURIComponent(name)}`, 8000);
    if (!res.ok) {
      if (isBackendMissing(res)) showBackendMissingBanner();
      return null;
    }
    clearBackendMissing();
    return await res.json();
  } catch (e) {
    if (e && e.name === "AbortError") {
      console.warn("[状态库] project 拉取超时(8s)，本轮跳过", name);
      return null;
    }
    console.warn("[状态库] project 拉取失败", name, e);
    return null;
  }
}

/** 媒体架段槽位落库。rack = {slots,fps,audio_out}（某一段的快照）。 */
export function saveRack(name, cid, rack) {
  if (!name || !cid || !rack) return Promise.resolve(null);
  return postJSON("/cglide/store/rack", {
    name,
    cid: String(cid),
    slots: rack.slots || { images: [], videos: [], audios: [] },
    fps: rack.fps || 0,
    audio_out: rack.audio_out || 0,
  }).catch((e) => {
    if (e && (e.status === 404 || e.status === 405)) return null;   // 已弹横幅，不刷屏
    console.warn("[状态库] rack 落库失败", name, cid, e);
    return null;
  });
}

/** 文案台整份文案落库。desk = {chain,global,segs,alias,presets}。
    cid 可选：只用来给这次留痕标上"是哪一段"，**不会**触发按段增量写
    （整包要照旧存 presets / alias / global）。 */
export function saveDesk(name, desk, cid) {
  if (!name || !desk) return Promise.resolve(null);
  const body = { name, desk };
  if (cid) body.cur_cid = String(cid);
  return postJSON("/cglide/store/desk", body)
    .catch((e) => {
      if (e && (e.status === 404 || e.status === 405)) return null;
      console.warn("[状态库] desk 落库失败", name, e);
      return null;
    });
}

/** 操作流水（后端关键动作已在 Python 侧埋点，前端额外事件可选）。 */
export function saveEvent(name, action, cid, payload, actor) {
  if (!name || !action) return Promise.resolve(null);
  return postJSON("/cglide/store/event", {
    name, action,
    cid: cid ? String(cid) : "",
    payload: payload || {},
    actor: actor || "front",
  }).catch(() => null);
}

/* 20261026：saveSnapshot / listSnapshots / getSnapshot / deleteSnapshot
   四个通道**已删** —— 唯一使用者是导演台的撤销栈，撤销整体下线后无人调用。
   后端的 /cglide/store/snapshot* 路由**保留**：那是通用存储 API，不属于
   撤销功能的行为面，删它只会让老前端 404 而没有收益。 */


/* ---------------- 节点定位 ---------------- */

function deskNodes() {
  const g = (typeof app !== "undefined" && app && app.graph) || null;
  return (g && g._nodes ? g._nodes : []).filter((n) => n && n.type === DESK_NODE_ID);
}

/** 轮询等待条件成立（三节点在同一次 graph configure 中创建，先后不保证）。 */
async function waitFor(pred, timeout = 15000, interval = 250) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    let v = null;
    try { v = pred(); } catch (_) { v = null; }
    if (v) return v;
    await new Promise((r) => setTimeout(r, interval));
  }
  return null;
}

/* timeout 可传：拖入视频那条路（adoptCopiedProject）用短预算 —— 那一页的节点
   在同一次 configure 里刚建好，等不到就是不在这张工作流里，不该让人对着
   "什么都没发生"干等 15 秒 × 2。 */
const waitRack = (castNode, timeout = 15000) => waitFor(() => {
  const n = rackNodeOf(castNode);
  if (n && (n.gmr || (n.widgets || []).some((w) => w && w.name === "rack_data"))) return n;
  return null;
}, timeout);
const waitDesk = (timeout = 15000) => waitFor(() => {
  const list = deskNodes();
  return list.length ? list[0] : null;
}, timeout);

/* ---------------- 灌库（hydrate） ---------------- */

function normRack(rk) {
  if (!rk || typeof rk !== "object" || !rk.slots) return null;
  const s = rk.slots;
  const clean = (k) => {
    const arr = Array.isArray(s[k]) ? s[k] : [];
    const out = arr.slice(0, 32).map((x) => (x && typeof x === "object") ? JSON.parse(JSON.stringify(x)) : {});
    while (out.length && !(out[out.length - 1] && out[out.length - 1].file)) out.pop();
    return out;
  };
  return {
    slots: { images: clean("images"), videos: clean("videos"), audios: clean("audios") },
    fps: Number(rk.fps) || 0,
    audio_out: Number(rk.audio_out) || 0,
  };
}

function rackHasFile(rk) {
  const s = (rk && rk.slots) || {};
  return ["images", "videos", "audios"].some((k) =>
    (Array.isArray(s[k]) ? s[k] : []).some((x) => x && x.file));
}

/** 找画布上的媒体架节点。rackNodeOf 是「沿导演台 H3_REFS 连线往上找」，
 *  媒体架没接线 / 链路超过 8 跳时会退回一个普通上游节点 —— 这时
 *  hydrateRackNode 的旧 bag 兜底把 rack_data 写进一个没人看的 widget，
 *  库里明明已经落了 3 个音频槽，界面一张卡都不加（20261107 用户报
 *  「第二轨第三轨的音频没在媒体架看到」）。按节点特征全图兜底找一次。 */
function anyRackNode(cn) {
  const isRack = (n) => !!(n && (n.gmr || (n.widgets || [])
    .some((w) => w && w.name === "rack_data")));
  const wired = cn ? rackNodeOf(cn) : null;
  if (isRack(wired)) return wired;
  const g = (typeof app !== "undefined" && app && app.graph) || null;
  const all = (g && g._nodes) || [];
  return all.find(isRack) || null;
}

/** 媒体架灌库：新 bag 走 hydrateRacks；旧 bag 用整包 rack_data（旧 load 支持
 *  segs/cur 恢复），至少保证数据与渲染正确。 */
function hydrateRackNode(rn, racks, curCid) {
  const normed = {};
  Object.keys(racks || {}).forEach((cid) => {
    const r = normRack(racks[cid]);
    if (r && rackHasFile(r)) normed[String(cid)] = r;
  });
  if (rn.gmr && rn.gmr.BAG_VERSION === BZ_BAG_VERSION && typeof rn.gmr.hydrateRacks === "function") {
    return rn.gmr.hydrateRacks(normed, curCid);
  }
  /* 旧 bag 兼容路径：把全段 segs 塞进 rack_data 整包，让旧 load 一次性恢复。 */
  const w = (rn.widgets || []).find((x) => x.name === "rack_data");
  let base = {};
  try { base = JSON.parse((w && w.value) || "{}"); } catch (_) { base = {}; }
  base.segs = normed;
  base.cur = curCid || "";
  const cur = normed[curCid];
  if (cur) { base.slots = JSON.parse(JSON.stringify(cur.slots)); base.fps = cur.fps; base.audio_out = cur.audio_out; }
  const raw = JSON.stringify(base);
  if (w) w.value = raw;
  try { rn.gmr && rn.gmr.load && rn.gmr.load(raw, true); } catch (e) { console.warn("[状态库] 旧媒体架 bag 灌库失败", e); }
  return Object.keys(normed).length;
}

/** 文案台灌库：新 bag 走 deskUI.hydrate；旧 bag 只写 widget（渲染读 widget，
 *  提交仍正确；界面文本可能不刷新，提示 Ctrl+F5）。 */
function hydrateDeskNode(dn, desk) {
  if (!desk || typeof desk !== "object") return false;
  if (dn.deskUI && dn.deskUI.BAG_VERSION === BZ_BAG_VERSION && typeof dn.deskUI.hydrate === "function") {
    return dn.deskUI.hydrate(desk);
  }
  const w = (dn.widgets || []).find((x) => x.name === "desk_data");
  if (w) { try { w.value = JSON.stringify(desk); } catch (_) {} }
  try { dn.deskUI && dn.deskUI.refresh && dn.deskUI.refresh(); } catch (_) {}
  return true;
}

/** hydrate 后让导演台面板重显当前段（switchTo 对同 idx 有 guard，这里复刻
 *  它的切段序列：先倒媒体架、再载面板状态、提交、广播三节点联动）。 */
function replayCurrent(castNode) {
  const ui = castNode.h3ui;
  const p = castNode.properties && castNode.properties.gcast_project;
  if (!ui || !p || !Array.isArray(p.shots)) return;
  let idx = p.idx;
  if (idx < 0 || !p.shots[idx]) idx = p.shots.length ? 0 : -1;
  if (idx < 0) return;
  p.idx = idx;
  const shot = p.shots[idx];
  try { ui.restoreShotRack && ui.restoreShotRack(shot); } catch (_) {}
  try { if (shot.state) ui.load && ui.load(JSON.stringify(shot.state)); } catch (_) {}
  try { ui.commit && ui.commit(); } catch (_) {}
  try { ui.paintSegTools && ui.paintSegTools(); } catch (_) {}
  try { ui.broadcastSeg && ui.broadcastSeg("hydrate"); } catch (_) {}
}

/* 同一导演台节点、同一工程代际只 hydrate 一次（onNodeCreated 与 onConfigure
   在读档场景会先后各触发一次）；失败不记，允许后续钩子重试。 */
const hydrateDone = new WeakMap();
/* 并发锁：多个启动钩子（含 HMR 接管扫描）同时触发时，合并成同一次灌库。 */
const hydrateInflight = new WeakMap();

/* project 结果短缓存（hydrate 与自愈轮询共用，避免重复请求）。 */
let projCache = { name: "", at: 0, data: null };
/* 同片名在途请求复用：原来 getProject 一旦挂起，缓存不更新、3s 后又发一个，
   几分钟堆积上百个 inflight、耗尽连接。pending 期间一律等同一个 Promise。 */
const projInflight = new Map();
async function fetchProjectCached(name) {
  if (projCache.name === name && Date.now() - projCache.at < 3000) return projCache.data;
  if (projInflight.has(name)) return projInflight.get(name);
  const p = (async () => {
    const data = await getProject(name);
    /* 只有真拿到数据才更新缓存（null 不缓存，让下轮立刻重试）。 */
    if (data) projCache = { name, at: Date.now(), data };
    return data;
  })();
  projInflight.set(name, p);
  try { return await p; }
  finally { projInflight.delete(name); }
}

/**
 * 启动 / 刷新 / 读档后从工程库恢复三节点。库为权威：
 *   clips[].state / clips[].rack → 导演台 shots；
 *   racks → 媒体架分段槽位；desk → 文案台；最后重显当前段并广播联动。
 * 老工程（backend=json）与空工程直接返回，绝不碰 JSON 通道。
 */
export function hydrateFromStore(castNode, force = false) {
  /* 全局渲染锁（1-A）：任何节点在渲染，全画布冻结后端→前端回灌。 */
  if (projectStore.isGloballyRendering()) return Promise.resolve(false);
  if (hydrateInflight.has(castNode)) return hydrateInflight.get(castNode);
  const p = _hydrateFromStore(castNode, force);
  hydrateInflight.set(castNode, p);
  p.finally(() => hydrateInflight.delete(castNode));
  return p;
}

async function _hydrateFromStore(castNode, force) {
  /* 从视频还原出来的标签页已经带着当时的现场，片名也换成了新工程。库里没有
     这个片名的档案，回灌会把文案台 / 媒体架当成空架子清掉。这一个判定管住
     读档 / 自愈 / 热重建 / HMR 接管全部调用点；不影响写回与开拍。 */
  if (castNode && castNode._bzVideoSnap) return false;
  try {
    const proj = castNode && castNode.properties && castNode.properties.gcast_project;
    if (!proj || !proj.name || !Array.isArray(proj.shots)) return false;
    /* 权威闸门：self-heal 自动灌（force=false）只在 boot 态进行。editing /
       rendering 态前端是权威，灌后端旧值会吃掉用户刚改的画布 / 素材（画布
       尺寸不生效根因）。热重建后、切工程等显式场景传 force=true 放行。 */
    if (!force && !projectStore.canPullFromBackend(castNode)) return false;
    const data = await fetchProjectCached(proj.name);
    if (!data || data.backend !== "db") return false;
    const doneKey = proj.name + "|" + (proj.gen || 0) + "|" + proj.shots.length + "|" + (data.current || "");
    if (hydrateDone.get(castNode) === doneKey) return false;

    /* 1) 库内段数据覆盖工作流内存快照（state / rack 都以库为权威）。
          只覆盖工作流里已有的段，不凭空造段（段列表以工作流 / 登记为准）。 */
    const rackByCid = data.racks || {};
    (data.clips || []).forEach((clip) => {
      if (!clip || !clip.id) return;
      const shot = proj.shots.find((s) => s &&
        (s.clip === clip.id || (clip.shot && s.id === clip.shot)));
      if (!shot) return;
      /* 这里**不再补 shot.clip**（20261107 段身份合并）：身份只由
         csglide_cast_monitor.js 的 reconcileSegmentIdentity 在轴重画时判定。
         hydrate 只负责把库里的 state / rack 灌给对应段，靠 clip.shot 找得到人，
         与身份判定无关。 */
      if (clip.state && typeof clip.state === "object") shot.state = clip.state;
      const rk = normRack(rackByCid[clip.id]);
      if (rk && rackHasFile(rk)) shot.rack = rk;
    });

    /* current 对齐到库里的当前段下标。 */
    if (data.current) {
      const i = proj.shots.findIndex((s) => s && (s.clip === data.current || s.id === data.current));
      if (i >= 0) proj.idx = i;
    }

    /* 2) 媒体架（等节点就绪）。 */
    const rn = await waitRack(castNode);
    if (rn) {
      hydrateRackNode(rn, rackByCid, data.current || "");
      /* 回填静默失败检测：库里有素材、灌完媒体架却还是空的 —— 以前这里一声不
         吭，用户打开工作流看到空架子只会以为自己忘了摆素材，然后手工重摆一遍
         （摆完刷新又没了）。现在直接把原因喊出来。
         这里不信任 hydrateRackNode 的返回值（新旧 bag 口径不一致，可能是
         undefined），而是看媒体架**实际**有没有拿到带文件的槽位。 */
      let hasFile = false;
      try {
        const rw = (rn.widgets || []).find((x) => x.name === "rack_data");
        const j = JSON.parse((rw && rw.value) || "{}");
        const sl = (j && j.slots) || {};
        hasFile = ["images", "videos", "audios"].some(
          (k) => (Array.isArray(sl[k]) ? sl[k] : []).some((x) => x && x.file));
      } catch (_) { hasFile = false; }
      const libSegs = Object.keys(rackByCid || {}).filter(
        (cid) => rackHasFile(rackByCid[cid])).length;
      if (libSegs > 0 && !hasFile) {
        console.warn("[状态库] ⚠ 回填没有生效：工程库里有 " + libSegs
          + " 段素材，但媒体架一个都没拿到。\n"
          + "  最常见的原因：插件更新后没有**完全重启 ComfyUI**（关掉黑窗口重开，"
          + "Ctrl+F5 只刷新浏览器、无效）——后端 /cglide/store/* 路由不存在时，"
          + "素材只在内存里，刷新就丢。");
      }
    }

    /* 3) 文案台。 */
    const dn = await waitDesk();
    if (dn && data.desk) hydrateDeskNode(dn, data.desk);

    /* 4) 导演台面板回到当前段，广播让媒体架 / 文案台联动一次。 */
    replayCurrent(castNode);
    hydrateDone.set(castNode, doneKey);
    /* boot 态首次灌入成功 → 转 editing，此后 self-heal 不再自动回灌（防止
       后端旧值覆盖用户编辑）。beginEdit 只在 boot 态生效，force 场景安全。 */
    if (!force) projectStore.beginEdit(castNode);
    console.info("[状态库] hydrate 完成:", proj.name,
      "段=" + (data.clips || []).length, "架=" + Object.keys(rackByCid).length,
      "文案=" + !!(data.desk), "当前=" + (data.current || "空"));
    return true;
  } catch (e) {
    console.warn("[状态库] hydrate 失败(已忽略)", e);
    return false;
  }
}

/** 拉一个工程的整包（history/bundle）：clips（含 state）+ racks + desk。
 *  15s 超时 —— bundle 里装着全部段的参数与素材槽位，工程大了就是几 MB。
 *  switchToProject（用户切工程）与 adoptCopiedProject（拖入视频还原）共用。 */
async function fetchBundle(name) {
  let data;
  try {
    const res = await fetchWithTimeout(
      "/cglide/chain/history/bundle?name=" + encodeURIComponent(name), 15000);
    if (!res.ok) throw new Error("HTTP " + res.status);
    data = await res.json();
  } catch (e) {
    if (e && e.name === "AbortError") throw new Error("工程读取超时，再试一次");
    throw e;
  }
  if (!data || data.error) throw new Error((data && data.error) || "工程读不出来");
  return data;
}

/** 把一份整包落成**当前工程**：重建段列表 → 灌媒体架/文案台 → 面板回当前段
 *  → 提交 → 广播 → 刷新监视器。返回重建后的工程对象。
 *
 *  这是"整包 → 工程"的唯一实现：switchToProject（历史菜单切工程）与
 *  adoptCopiedProject（拖入视频还原）都走这里。两条路的差别只有一件 ——
 *  切工程前要 stash，还原前**不能** stash（理由见 adoptCopiedProject）。
 */
async function applyProjectBundle(castNode, name, data, opts) {
  const ui = castNode.h3ui;
  const p = castNode.properties.gcast_project;
  const waitMs = Number((opts && opts.waitMs) || 15000);
  const clips = data.clips || [];
  const racks = data.racks || {};
  /* 重建工程。 */
  p.name = name;
  p.shots = clips.map((c) => {
    if (!c || !c.id) return null;
    const st = c.state && typeof c.state === "object"
      ? parseInitial(JSON.stringify(c.state))
      : null;
    const rk = racks[c.id] ? normRack(racks[c.id]) : null;
    return {
      id: c.shot ? String(c.shot) : ui.uid(),
      clip: c.id,
      name: (typeof c.name === "string" && c.name.indexOf("第 ") !== 0) ? c.name : "",
      state: st || parseInitial("{}"),
      rack: (rk && rackHasFile(rk)) ? rk : undefined,
      off: !!c.off,
      link: c.link === false ? false : undefined,
      colour: typeof c.colour === "string" ? c.colour : undefined,
    };
  }).filter(Boolean);

  /* 当前段：优先库里的 current，找不到回第 0 段。 */
  let idx = 0;
  if (data.current) {
    const i = p.shots.findIndex((s) => s.clip === data.current || s.id === data.current);
    if (i >= 0) idx = i;
  }
  p.idx = p.shots.length ? Math.min(idx, p.shots.length - 1) : -1;
  /* 代际 +1：任何按旧工程名/代际挂的缓存与竞态广播一律失效。 */
  p.gen = (Number(data.gen) || Number(p.gen) || 0) + 1;
  /* 接缝（断链 / 叠化）也随档案走：p.transitions 是面板上画接缝标记与
     applyTransition 判"现在是不是断着的"的唯一真值。不接过来的话，切工程 /
     复制档案之后面板上的接缝标记还是上一个工程的 —— 点一次「接上」就会把
     另一条片子的接缝写进这一条。DB 包在顶层给，老 JSON 包在 chain 里。 */
  const tr = (data.transitions && typeof data.transitions === "object")
    ? data.transitions
    : ((data.chain && data.chain.transitions) || {});
  p.transitions = JSON.parse(JSON.stringify(tr || {}));

  /* 媒体架灌库（racks 缺省的老工程 = 清空，事实正确）。 */
  const rn = await waitRack(castNode, waitMs);
  if (rn) hydrateRackNode(rn, racks, data.current || "");

  /* 文案台：DB 工程灌回；老 JSON 工程没有档案，灌空包清掉旧工程的词。 */
  const dn = await waitDesk(waitMs);
  if (dn) {
    const emptyDesk = { chain: [], global: "", segs: {}, alias: {}, presets: [] };
    hydrateDeskNode(dn, data.desk || (data.backend === "json" ? emptyDesk : null));
  }

  /* 音轨：与 racks / desk 同一次整包、同一个库，直接灌给音频轴。
     音频轴不再自己发 /banzhang/audio/tracks —— 那会另起一套时序，切工程时
     片名抖动就把恢复丢掉，波形整栏空着。 */
  try {
    ui.monitor && ui.monitor.hydrateAudioTracks
      && ui.monitor.hydrateAudioTracks(data.audio || null);
  } catch (_) {}

  /* 面板回到当前段，提交、广播、刷新监视器。 */
  if (p.idx >= 0) {
    const shot = p.shots[p.idx];
    try { ui.restoreShotRack && ui.restoreShotRack(shot); } catch (_) {}
    try { ui.load && ui.load(JSON.stringify(shot.state)); } catch (_) {}
  }
  try { ui.commit && ui.commit(); } catch (_) {}
  try { ui.paintSegTools && ui.paintSegTools(); } catch (_) {}
  try { ui.broadcastSeg && ui.broadcastSeg("project"); } catch (_) {}
  try { ui.monitor && ui.monitor.reset && ui.monitor.reset(); } catch (_) {}
  setTimeout(() => {
    try { ui.monitor && ui.monitor.refresh(); } catch (_) {}
  }, 80);
  return p;
}

/* ---------------- 切换到旧工程（轴头「历史」菜单） ---------------- */

/**
 * 一键切换到 output/h3_chain/ 下的另一个整部工程（不是操作记录）。
 *
 * 流程：
 *   1. 渲染中拒绝；当前段先 stash 收口（state/rack 落内存 + 防抖落盘）；
 *   2. 切前工程**不进任何还原点**（20261026 撤销栈已整体删除）——
 *      切过去就回不来了，想留后路请先「另存工程文件」；
 *   3. 拉 history bundle：DB 工程含 clips/racks/desk 全量，老 JSON 工程只有
 *      clips（state），racks/desk 缺省；
 *   4. 重建 gcast_project（每段 state 过 parseInitial 白名单）；
 *   5. 媒体架/文案台灌库；老工程这两块没有档案，如实清空（不拿旧工程的
 *      素材/词渲染新工程）；
 *   6. 面板载入当前段、提交、广播代际、监视器刷新。
 */
export async function switchToProject(castNode, name) {
  const ui = castNode && castNode.h3ui;
  if (!ui) throw new Error("导演台面板没就绪");
  if (ui.run) throw new Error("渲染中不能切换工程 —— 等这轮跑完（或先停止）");
  const p = castNode.properties && castNode.properties.gcast_project;
  if (!p || !Array.isArray(p.shots)) throw new Error("当前工程对象没就绪");
  const oldName = p.name || "";
  if (oldName === name) return;

  /* 1) 当前段收口（面板 state + 媒体架快照写回 shot）。 */
  try { ui.stash && ui.stash(); } catch (_) {}

  /* 2) 拉目标工程整包。 */
  const data = await fetchBundle(name);

  /* 3)~6) 重建：段列表 / 媒体架 / 文案台 / 面板 / 广播 / 监视器（共用实现）。 */
  const rebuilt = await applyProjectBundle(castNode, name, data);

  const note = data.backend === "json"
    ? "（老工程：媒体架/文案台当时没归档，只恢复了导演台参数）"
    : "（导演台/媒体架/文案台已完整恢复）";
  try {
    ui.lanesFlash("已切换到「" + name + "」· " + rebuilt.shots.length + " 段 " + note
      + "；切回去按 Ctrl+Z");
  } catch (_) {}
  console.info("[状态库] switchToProject:", oldName, "->", name,
      "段=" + rebuilt.shots.length, "后端=" + (data.backend || "?"));
  return true;
}

/**
 * 拖入视频还原：源片的**整份档案**已经被后端复制到新片名下了（route
 * /cglide/chain/copy），这里把复制过来的档案当权威、把工程对象重建成它的样子。
 *
 * 与 switchToProject 共用 applyProjectBundle，只差一件事：**不 stash**。
 * 此刻 p.name 还是旧片名，stash 会把内存里的 state / 素材槽位写回**源片**的
 * 档案 —— 那等于偷偷改了旧工程，而"拖入视频还原"这一步对用户的承诺恰恰是
 * 「旧工程未改动」。所以内存里那份视频现场一律不回收，以复制来的档案为准。
 *
 * 为什么必须整份重建、而不是让 hydrateFromStore 按 shot_uid 补 clip：视频里
 * 带的是**渲染当时**的段列表，档案里可能有渲染之后才加的段（也可能删过段）。
 * 两条账对不上时，时间轴按档案画、工程按视频走，轴上就会出现点不开的空块。
 * 这里整份以档案为准，两本账立刻对齐。
 *
 * 返回 false = 新片名下没有可用档案（源片在别的机器上 / 已被删），交给调用方
 * 退回"至少一段"。绝不在这里造段：造出来的段没有成片，用户点了会以为坏了。
 */
export async function adoptCopiedProject(castNode, name) {
  const ui = castNode && castNode.h3ui;
  const p = castNode && castNode.properties && castNode.properties.gcast_project;
  if (!ui || !p || !Array.isArray(p.shots)) return false;
  const data = await fetchBundle(name);
  if (!(data.clips || []).length) return false;
  /* 短预算：这一页的节点是同一次 configure 建出来的，2 秒还等不到就是不在这
     张工作流里 —— 那就跳过对应节点的灌库，不能让拖入动作卡 30 秒。 */
  const rebuilt = await applyProjectBundle(castNode, name, data, { waitMs: 2000 });
  try {
    ui.lanesFlash("已把原片整份档案复制到「" + name + "」· "
      + rebuilt.shots.length + " 段（参数 / 文案台 / 媒体架 / 成片都在），"
      + "旧工程未改动");
  } catch (_) {}
  console.info("[状态库] adoptCopiedProject:", name, "段=" + rebuilt.shots.length,
      "后端=" + (data.backend || "?"));
  return true;
}

/* ---------------- 热重载自愈 ---------------- */

const healTimers = new WeakMap();
const healedTags = new WeakMap();   // 节点 → 已提示过的旧 bag 类型集合

function flash(castNode, msg) {
  try {
    const ui = castNode.h3ui;
    if (ui && typeof ui.flashBar === "function") ui.flashBar(msg);
    else if (ui && typeof ui.lanesFlash === "function") ui.lanesFlash(msg);
    else console.warn(msg);
  } catch (_) { console.warn(msg); }
}

/** 旧 bag 自愈：导演台 / 媒体架支持在线热重建（行为直接升级，不再只是救数据）；
 *  文案台重建路径未做，仍走整包灌数据 + 提示。重建不依赖工程名（新工程摆图
 *  也需要新逻辑），所以导演台检查放在最前面。 */
async function healOldBags(castNode) {
  const tags = healedTags.get(castNode) || {};
  const stale = [];
  const flushStale = (extra) => {
    if (!stale.length) return;
    healedTags.set(castNode, tags);
    flash(castNode, "⚠️ 检测到热重载前的旧界面：" + stale.join(" / ") + "；"
      + (extra || "素材与文案已自动恢复，建议空闲时彻底刷新一次页面。"));
  };

  /* 导演台 h3ui：stash 按段身份取快照等修复都在闭包里，旧闭包不重建等于
     白改（20261013 两图对调修复必须随新版 h3ui 生效）。 */
  if (castNode.h3ui && castNode.h3ui.BAG_VERSION !== BZ_BAG_VERSION && !tags.cast) {
    let rebuilt = false;
    try { rebuilt = rebuildCastUI(castNode); } catch (_) {}
    if (rebuilt) {
      tags.cast = true;
      stale.push("导演台（已在线升级）");
      /* 热重建 = 显式升级，新 bag 需要按库重灌一次，force 放行（不受
         editing/rendering 闸门限制）。 */
      try { hydrateFromStore(castNode, true); } catch (_) {}
    }
    /* 重建失败不锁 tags：3s 后下一轮自动重试。 */
  }

  const proj = castNode && castNode.properties && castNode.properties.gcast_project;
  if (!proj || !proj.name) { flushStale(); return; }
  const data = await fetchProjectCached(proj.name);
  if (!data || data.backend !== "db") { flushStale(); return; }

  /* 版本号都对，但启动早期连接池紧张时 project 会超时、hydrate 失败（表现为
     刷新后媒体架段记忆 / shot.rack 全空）。每轮巡检核对 hydrate 是否真的完成，
     没完成就补一次；hydrate 内部按 doneKey 去重，成功后自动跳过，不重复灌数据。
     这里 fetchProjectCached 已拿到 data（3s 缓存），hydrate 内部直接命中缓存，
     不会重复发请求。 */
  const expectedKey = proj.name + "|" + (proj.gen || 0) + "|" +
    proj.shots.length + "|" + (data.current || "");
  if (hydrateDone.get(castNode) !== expectedKey) {
    await hydrateFromStore(castNode);
  }

  const rn = rackNodeOf(castNode);
  if (rn && rn.gmr && rn.gmr.BAG_VERSION !== BZ_BAG_VERSION && !tags.rack) {
    /* 媒体架旧 bag 缺段记忆接口（segs/switchSeg/loadSeg），是串段与素材丢失
       的另一半根因。重建成功后 gmr 是新闭包，hydrateRackNode 自动走新路径。 */
    let rebuilt = false;
    try { rebuilt = rebuildMediaRackUI(rn); } catch (_) {}
    if (rebuilt) {
      tags.rack = true;
      try { hydrateRackNode(rn, data.racks || {}, data.current || ""); } catch (_) {}
      stale.push("媒体架（已在线升级）");
    } else {
      /* 重建失败：本轮不锁 tags，3s 后下一轮重试；先走整包 load 兜底灌数据。 */
      try { hydrateRackNode(rn, data.racks || {}, data.current || ""); } catch (_) {}
      stale.push("媒体架");
    }
  }
  const dn = deskNodes()[0];
  if (dn && dn.deskUI && dn.deskUI.BAG_VERSION !== BZ_BAG_VERSION && !tags.desk) {
    tags.desk = true;
    try { if (data.desk) hydrateDeskNode(dn, data.desk); } catch (_) {}
    stale.push("文案台");
  }
  flushStale("素材与文案已从工程库自动恢复。");
}

/** 启动自愈巡检（每 3s 一次，轻量版本号比对；节点销毁自动停）。 */
export function startSelfHeal(castNode) {
  if (!castNode || healTimers.has(castNode)) return;
  const t = setInterval(() => {
    try {
      if (!castNode.graph || castNode.isRemoved?.()) { stopSelfHeal(castNode); return; }
      /* 全局渲染锁（1-A）：渲染期间本巡检直接跳过，不 fetch、不回灌。 */
      if (projectStore.isGloballyRendering()) return;
      healOldBags(castNode);
    } catch (_) {}
  }, 3000);
  healTimers.set(castNode, t);
}

export function stopSelfHeal(castNode) {
  const t = healTimers.get(castNode);
  if (t) { clearInterval(t); healTimers.delete(castNode); }
}

/* ---------------- 热重载（HMR）接管 ----------------
   前端热替换会重新执行模块、替换节点原型方法，但**不会重建已存在的节点**：
   onNodeCreated / onConfigure 都不重跑，节点上的 h3ui / gmr / deskUI 还是
   热重载前的旧闭包，挂在钩子里的 hydrate / 自愈因此不会启动。模块每次加载
   都主动扫描画布上已有的导演台节点并接管（hydrateDone 锁保证与正常钩子
   不重复灌库）。整页刷新时节点由钩子路径接管，这里多扫一次也幂等。 */
function armExistingCastNodes() {
  /* 全局渲染锁（1-A）：渲染期间不接管、不 hydrate 已有节点。 */
  if (projectStore.isGloballyRendering()) return;
  let nodes = [];
  try { nodes = castNodes(); } catch (_) { nodes = []; }
  nodes.forEach((n) => {
    try {
      n.BZ_BAG_VERSION = BZ_BAG_VERSION;
      hydrateFromStore(n);
      startSelfHeal(n);
    } catch (_) {}
  });
}
setTimeout(armExistingCastNodes, 1500);
setTimeout(armExistingCastNodes, 5000);

/* ---------------- 外部写手落库后的定向回灌（20261107 音频自动分发） --------
   后端 auto_slice 一次写 N 段的 rack/段词，但媒体架 / 文案台**内存里的段记忆
   还是旧的**。用户随手切一段，commit 就按旧内存整段回写（save_rack 先
   DELETE WHERE cid），刚落库的音频槽被清空 —— 表现就是「切了 3 段，只有 1 段
   有内容，而且每次剩下的那一段还不一样」。asset_pool 里 3 条都在、rack_refs
   只剩 1 条，就是这个反噬的指纹。

   为什么不能用现成两条路：
     · hydrateFromStore 会整包重建导演台，音频轴 DOM 会被一起拆掉；
     · startSelfHeal 只在 BAG_VERSION 不对时才灌库，版本对就完全不动。
   所以这里只灌「媒体架 + 文案台」两个节点，不重建、不切工程、不动播放头。

   用 window 事件而不是 export：音频轴 → bz_project_sync → csglide_cast →
   csglide_film → 音频轴 会成环，ESM 环里 TDZ 会静默炸；事件是零耦合的。
   detail.done(n) 回传灌入的段数，调用方可以 await 到真正灌完再收工。 */
window.addEventListener("bz:refresh-rack-desk", (ev) => {
  const d = (ev && ev.detail) || {};
  const done = typeof d.done === "function" ? d.done : () => {};
  const name = String(d.name || "");
  if (!name) { done(0); return; }
  void (async () => {
    let n = 0;
    try {
      const data = await getProject(name);
      if (data && data.backend === "db") {
        try {
          const cn = castNodes()[0];
          const rn = anyRackNode(cn);
          if (rn) n += Number(hydrateRackNode(rn, data.racks || {}, data.current || "")) || 0;
        } catch (_) {}
        try {
          const dn = deskNodes()[0];
          if (dn && data.desk && hydrateDeskNode(dn, data.desk)) n += 1;
        } catch (_) {}
      }
    } catch (_) {}
    console.log("[状态库] 音频分发回灌：", name, "段数", n);
    done(n);
  })();
});
