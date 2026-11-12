/* ============================================================
 * B1 · 中央段档案 —— 唯一的「按段 id 读写」入口   20261015
 * ------------------------------------------------------------
 * 以前三个节点各存一份段内存：
 *     媒体架 ui.st.segs / 文案台 st.segs / 导演台 shots[].state
 * 切段时各自去"猜当前段是谁"，猜错就串段、丢素材、丢提示词。
 *
 * 现在改成一句话：**切段 = 拿 cid → 问中央 → 中央说什么就是什么。**
 * 前端内存降级成"乐观预览"，不再是事实的最终来源。
 *
 * 后端：
 *   GET  /cglide/store/segment?name=&id=   权威读（没档案就现场补建，老工程自愈）
 *   POST /cglide/store/desk {name,cid,text} 按段增量写（不整片覆盖）
 *
 * ⚠️ 后端进程没重启时（Python 改了但 ComfyUI 没重开），segment 路由是 404。
 * 这时**绝不能**退化成"静默什么都不做"——那正是以前查不出血案的姿势：
 *   · 读：降级到 /cglide/store/project 全量拉，照样拿得到权威数据；
 *   · 写：直接**不发**增量请求。旧后端的 /cglide/store/desk 见到没有 desk
 *     字段的 body 会把整个文案台写成空 —— 一次请求清空所有段的词。
 * 这两种情况都会在控制台打一条醒目报错，告诉你"要重启后端"。
 *
 * 无依赖（只 import api），谁都能安全 import 它，不会成环。
 * ============================================================ */
import { api } from "../../scripts/api.js";

/* 同一段 1.2s 内不重复问中央：切段风暴（点段 + 后端回声 + 乐观值校正）
   会在几百毫秒内连打同一个 cid，没必要每次都打 HTTP。
   降级路径（全量 project）代价大，缓存放长一点。 */
const TTL_MS = 1200;
const TTL_FALLBACK_MS = 4000;
const _cache = new Map();      // "name::cid" -> { at, data }
const _inflight = new Map();
/* 段词**版本号**（A+ 方案的乐观锁）："name::cid" -> 最后一次从中央看到的 rev。
   写的时候把它当 base_rev 带上去；中央对不上就回 409 + 中央真值，前端据此
   刷新自己的内存 —— **绝不再拿过期的副本往前盖**。
   这就是"只有一份真值"落地的那一环：中央能回答"你手上这份过期了"。 */
const _rev = new Map();
/* 按段写入通道**当前是否不通**（后端没重启 / 网络挂了）。
   整包保存拿它决定要不要降级带上 segs：新通道通的时候整包**绝不**带段词
   （那是"旧副本盖真值"的通道，必须封死）；通道不通的时候退回老写法，
   宁可冒整包覆盖的老风险，也不能让用户的词一次都不落盘。 */
let _pushBroken = false;

/* 后端能力探测：null=未探 / "segment"=新后端 / "legacy"=没重启的旧后端。
   一次探测全局缓存；后端重启后刷新页面会重新探。 */
let _mode = null;
let _modeProbe = null;
let _legacyWarned = false;

const enc = (s) => encodeURIComponent(String(s == null ? "" : s));
const ck = (name, cid) => String(name || "") + "::" + String(cid || "");

function warnLegacyOnce() {
  if (_legacyWarned) return;
  _legacyWarned = true;
  console.error(
    "[B1] 中央段档案接口 /cglide/store/segment 不存在（404）—— ComfyUI 后端进程"
    + "**没有重启**。Ctrl+F5 只刷新浏览器 JS，对 Python 无效。\n"
    + "  · 现在的状态：素材/段词靠「整包」老路径读写，B1 的精确对账不生效；\n"
    + "  · 要 B1 全生效：完全关闭 ComfyUI（黑窗口）再启动一次。");
}

async function probeMode(name, cid) {
  if (_mode) return _mode;
  if (_modeProbe) return _modeProbe;
  _modeProbe = (async () => {
    try {
      const res = await api.fetchApi(
        "/cglide/store/segment?name=" + enc(name) + "&id=" + enc(cid));
      _mode = (res && res.ok) ? "segment" : "legacy";
    } catch (_) {
      _mode = "legacy";
    }
    _modeProbe = null;
    if (_mode === "legacy") warnLegacyOnce();
    return _mode;
  })();
  return _modeProbe;
}

async function getJSON(url, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => { try { ctrl.abort(); } catch (_) {} }, ms || 6000);
  try {
    const res = await api.fetchApi(url, { signal: ctrl.signal });
    if (!res || !res.ok) return null;
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

/** 我手上这份段词是**基于中央哪个版本**看到的（null = 不知道 / 没有版本保护）。 */
export function segRev(name, cid) {
  const v = _rev.get(ck(name, cid));
  return (typeof v === "number" && isFinite(v)) ? v : null;
}

/** 记下中央刚告诉我的版本号。传 null = 忘掉（降级路径拿不到 rev，就该忘掉，
    免得拿一个陈旧 rev 去撞出假冲突）。 */
/** 按段写入通道现在通不通（false = 通）。整包保存据此决定降级与否。 */
export function segPushBroken() {
  return _pushBroken;
}

export function setSegRev(name, cid, rev) {
  const k = ck(name, cid);
  if (typeof rev === "number" && isFinite(rev)) _rev.set(k, rev);
  else _rev.delete(k);
}

/** 作废缓存：刚写完段词、刚换完素材时调，让下一次 pull 拿到真新的。 */
export function invalidateSeg(name, cid) {
  const pre = String(name || "") + "::";
  if (!cid) {
    for (const k of Array.from(_cache.keys())) {
      if (k.startsWith(pre)) _cache.delete(k);
    }
    return;
  }
  _cache.delete(ck(name, cid));
}

/**
 * 降级读：后端没重启（segment 路由 404）时，改拉 /cglide/store/project 全量，
 * 自己拼出与 segment 同构的一段档案。数据一样是中央的权威值，只是费一点。
 */
async function pullViaProject(name, cid) {
  const data = await getJSON("/cglide/store/project?name=" + enc(name), 8000);
  if (!data || data.error) return null;
  const clips = Array.isArray(data.clips) ? data.clips : [];
  const clip = clips.find((c) => String(c && c.id) === String(cid)) || null;
  const desk = (data.desk && typeof data.desk === "object") ? data.desk : {};
  const segs = (desk.segs && typeof desk.segs === "object") ? desk.segs : {};
  const racks = (data.racks && typeof data.racks === "object") ? data.racks : {};
  const rk = racks[cid] || null;
  const txt = segs[cid];
  if (!clip && !rk && txt == null) return null;
  const order = Array.isArray(data.order) ? data.order : [];
  return {
    cid: String(cid),
    shot_uid: String((clip && clip.shot) || ""),
    state: (clip && clip.state) || {},
    rack: normRack(rk),
    desk_text: txt == null ? "" : String(txt),
    index: order.indexOf(String(cid)) + 1,
    order: order,
    clip_name: (clip && clip.name) || "",
    frames: (clip && clip.frames) || 0,
    backend: "db(project-fallback)",
  };
}

/**
 * 拉某一段的权威档案。
 * 返回 {cid, shot_uid, state, rack, desk_text, index, order, clip_name, frames}
 * 返回 null = 拉不到（老工程 / 没这一段），调用方保留现状即可，
 * **绝不能**因为拉不到就把界面清空 —— 那正是以前丢数据的经典姿势。
 */
export async function pullSeg(name, cid, opts) {
  const o = opts || {};
  cid = String(cid || "");
  if (!name || !cid) return null;
  const k = ck(name, cid);
  if (!o.force) {
    const hit = _cache.get(k);
    const ttl = o.ttl || (hit && hit.ttl) || TTL_MS;
    if (hit && (Date.now() - hit.at) < ttl) return hit.data;
  }
  if (_inflight.has(k)) return _inflight.get(k);
  const p = (async () => {
    try {
      const mode = await probeMode(name, cid);
      let data = null;
      if (mode === "segment") {
        data = await getJSON(
          "/cglide/store/segment?name=" + enc(name) + "&id=" + enc(cid));
        if (data && data.error) data = null;
      } else {
        data = await pullViaProject(name, cid);
      }
      if (data) {
        _cache.set(k, { at: Date.now(), data });
        /* 每次权威读都把版本号带回来 —— 写的时候才有得可押。
           降级路径（整包 project）没有 desk_rev：那就忘掉，走"硬写"。 */
        setSegRev(name, cid,
                  (typeof data.desk_rev === "number") ? data.desk_rev : null);
        if (mode !== "segment") {
          /* 降级拿到的也标上 TTL：全量请求不便宜。 */
          const hit = _cache.get(k);
          if (hit) hit.ttl = TTL_FALLBACK_MS;
        }
      }
      return data;
    } catch (_) {
      return null;
    } finally {
      _inflight.delete(k);
    }
  })();
  _inflight.set(k, p);
  return p;
}

/**
 * 按段增量写段词（B1 之后文案台落库走这条）。
 * 只动 body.cid 那一段，别的段连碰都不碰 —— 前端内存里别的段是空也伤不到。
 * 默认空串不覆盖中央已存的词（防切段竞态把词清空）；用户真的把词删空时，
 * 调用方要显式带 allowEmpty: true。
 *
 * 后端没重启时**直接不发**：旧后端的 /cglide/store/desk 见到没有 desk 字段
 * 的 body 会把整个文案台写成空（一次请求清空所有段的词）。那种情况下段词
 * 继续走原来的整包 saveDesk 路径，不做增量 —— 宁可不精确，也不能出事。
 */
/** 段身份的**唯一**合法形状 = 后端档案里的 clip id（clip_0001 这种）。

    以前段身份是双轨的：有 clip 用 clip，没有就退回工程内部的 uid（e5ak1jh
    这种随机号）。uid 一旦落进中央，同一段就同时拥有两个身份 —— 中央多出一
    批没有段的孤儿键，"删掉的素材/词又冒出来"就是从这儿来的（B 方案要根治
    的就是它）。所以现在定死一条：uid 只是工程内部的临时编号，**永远不是**
    段身份，任何写中央的入口都先过这个函数。 */
export function isRealCid(cid) {
  return /^clip_/i.test(String(cid || ""));
}

/** 新段还没从档案拿到 clip 时的**本地**临时键。带前缀，一眼认得出，
    并且被 isRealCid 挡在中央之外；等 clip 回来再一次性改名搬过去。 */
export const TEMP_PREFIX = "__new__";
export const tempKeyOf = (shot) => TEMP_PREFIX + (String(shot || "") || "?");
export const isTempKey = (k) => String(k || "").startsWith(TEMP_PREFIX);

export async function pushSegText(name, cid, text, opts) {
  const o = opts || {};
  if (!name || !cid || !isRealCid(cid)) return null;
  const mode = await probeMode(name, cid);
  if (mode !== "segment") { _pushBroken = true; return null; }
  /* 押上"我这份是基于哪个版本改的"。没押（base_rev 缺席）= 硬写，中央照样
     bump 版本号 —— 过渡期和拿不到 rev 的路径不会写不进去，但下一次带 rev
     的写就会老实撞上。

     撞了怎么办由调用方定：
       · retryOnConflict（用户正在打字 / 明确写入）→ 换中央刚给的 rev 再押一次。
         这份内容是**用户当下的意图**，不是过期副本，该赢的是它。
       · 不给（迁移 / 后台对账 / 别处改的）→ 原样把 {conflict, text} 交回去，
         调用方按中央真值刷新自己。本地那份本来就可能是旧副本。
     最多两次，绝不无限重试 —— 撞两次就是真并发，再试只是制造噪音。 */
  const tries = o.retryOnConflict ? 2 : 1;
  let last = null;
  for (let i = 0; i < tries; i++) {
    const body = {
      name, cid: String(cid), text: text == null ? "" : String(text),
    };
    if (o.allowEmpty) body.allow_empty = 1;
    if (o.global != null) body.global = String(o.global);
    const base = (i === 0 && o.baseRev != null) ? o.baseRev : segRev(name, cid);
    if (base != null) body.base_rev = base;
    let res = null;
    let data = null;
    try {
      res = await api.fetchApi("/cglide/store/desk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res) return null;
      data = await res.json().catch(() => null);
    } catch (_) {
      _pushBroken = true;
      return null;
    }
    // [单一真值] 冲突回包 {conflict:true} 是 truthy —— 调用方判成功必须写
    // `!!(r && !r.conflict)`。直接 `if (r)` 会把冲突当成功，接着去 refresh
    // 触发对账，把刚写的行盖回去。
    if (data && data.conflict) {
      /* 中央说：你手上这份过期了，一个字都没写进去。
         先把版本号刷成中央的 —— 下一次写才押得对。 */
      setSegRev(name, cid, (typeof data.rev === "number") ? data.rev : null);
      invalidateSeg(name, cid);
      last = { conflict: true, rev: data.rev, text: data.text || "" };
      continue;
    }
    if (!res || !res.ok) { _pushBroken = true; return null; }
    _pushBroken = false;
    const rv = (data && typeof data.rev === "number") ? data.rev
      : (data && data.binding && typeof data.binding.desk_rev === "number")
        ? data.binding.desk_rev : null;
    if (rv != null) setSegRev(name, cid, rv);
    invalidateSeg(name, cid);
    return data;
  }
  return last;
}

/** 把中央给的 rack 规整成媒体架认的形状（缺字段补空，缺槽位补 null）。 */
export function normRack(rack) {
  const r = rack && typeof rack === "object" ? rack : {};
  const s = r.slots && typeof r.slots === "object" ? r.slots : {};
  return {
    slots: {
      images: Array.isArray(s.images) ? s.images : [],
      videos: Array.isArray(s.videos) ? s.videos : [],
      audios: Array.isArray(s.audios) ? s.audios : [],
    },
    fps: r.fps || 0,
    audio_out: r.audio_out || 0,
  };
}
