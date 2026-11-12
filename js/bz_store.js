/* bz_store.js — 导演台 / 文案台 / 媒体架 / 时间轴联动的「单一数据源」
 * ============================================================================
 * 20261012 方案 B（ComfyUI 官方 WebSocket 自定义消息 + rgthree 式事件单例）：
 *
 *   后端 csglide_chain 任何写点落盘 → send_sync("bz.chain.event", {name,type})
 *   → 本 store 在 120ms 合帧窗口里对同一片名只拉一次 film_summary
 *   → diff/快照后向订阅者派发 "bz:store-film"
 *
 *   · 信号-拉取模式：WS 只传"谁变了"（极小、不怕乱序/重复/丢条），
 *     权威状态永远以 film_summary 拉取结果为准；
 *   · 轮询定时器 = 0，只留 30s 慢兜底（页面隐藏时不跑）+ WS 重连全量补；
 *   · 节点执行完成（execution_success）对在订片名补拉一次，覆盖外部节点
 *     直接写盘、不经 chain 写函数的场景。
 *
 * 订阅：const off = bzStore.subscribe(片名, ({film, reason, prev}) => {...})
 * 立即拉：await bzStore.touchNow(片名, "manual")
 * 乐观切段：bzStore.optimisticCurrent(片名, clipId)（后端回声后以档案为准）
 * ============================================================================ */

import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

export const STORE_FILM_EVENT = "bz:store-film";
const CHAIN_FILM_URL = (name) =>
  "/cglide/chain/film_summary?name=" + encodeURIComponent(name);

const COALESCE_MS = 120;   // 合帧窗口：一次点击引发的 N 条信号只拉一次
const FALLBACK_MS = 30000; // 慢兜底：30s，仅页面可见且有人订阅时

class BzChainStore extends EventTarget {
  constructor() {
    super();
    this._film = new Map();      // name -> film_summary 快照
    this._timers = new Map();    // name -> 合帧 setTimeout id
    this._inflight = new Map();  // name -> 进行中的拉取 Promise
    this._dirty = new Set();     // 拉取进行中又收到信号的片名
    this._wanted = new Set();    // 当前有订阅者的片名
    this._opt = new Map();       // name -> {clip, seq, at} 未被后端回声确认的乐观切段
    this._reconcile = new Map(); // name -> {timer, tries} 乐观对账重试状态
    this._installed = false;
  }

  install() {
    if (this._installed) return;
    this._installed = true;

    /* 主通道：后端档案变更广播（线程安全，任意写点都会发） */
    api.addEventListener("bz.chain.event", (e) => {
      const d = (e && e.detail) || {};
      if (!d.name) return;
      if (d.type === "renamed") {
        this._film.delete(d.name);
        if (d.new_name) { this._wanted.add(d.new_name); this.touch(d.new_name, "renamed"); }
        this._dispatch(d.name, null, "renamed", null);
        return;
      }
      this.touch(d.name, d.type || "chain");
    });

    /* 兜底 1：一次工作流执行成功后，在订片名补拉（外部节点直接写成片/latent） */
    api.addEventListener("execution_success", () => {
      if (document.hidden) return;
      for (const name of this._wanted) this.touch(name, "exec");
    });

    /* 兜底 2：WS 重连后 status 必到 → 全量补拉一次，防断线期间漏消息 */
    api.addEventListener("status", () => {
      if (document.hidden) return;
      for (const name of this._wanted) this.touch(name, "status");
    });

    /* 兜底 3：回到标签页立即同步；隐藏期间彻底不动 */
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) return;
      for (const name of this._wanted) this.touch(name, "visible");
    });

    /* 兜底 4：30s 慢轮询，只防极端漏消息，不再是联动主链路 */
    setInterval(() => {
      if (document.hidden || !this._wanted.size) return;
      for (const name of this._wanted) this.touch(name, "fallback");
    }, FALLBACK_MS);
  }

  /**
   * 订阅某片名的快照变化。
   * @returns {function} unsubscribe
   */
  subscribe(name, listener) {
    if (!name) return () => {};
    /* 故障隔离：任何一个订阅者回调报错，都不得炸掉 dispatchEvent ——
       否则同一事件后续订阅者（文案台/时间轴）全部收不到，异常还会抛回
       触发方（setCurrent 里 optimisticCurrent 之后的 emitCastChange 会被
       连带中断，表现为「运行完成后点哪段都不联动」，20261012 实测）。 */
    const safe = (detail) => {
      try { listener(detail); }
      catch (err) { console.warn("[bz_store] 订阅者回调异常（已隔离，不影响其他节点）：", name, err); }
    };
    const handler = (ev) => {
      if (ev.detail.name === name) safe(ev.detail);
    };
    this.addEventListener(STORE_FILM_EVENT, handler);
    this._wanted.add(name);
    const cached = this._film.get(name);
    if (cached) safe({ name, film: cached, prev: null, reason: "cached", immediate: true });
    else this.touch(name, "subscribe");
    return () => {
      this.removeEventListener(STORE_FILM_EVENT, handler);
      this._wanted.delete(name);
    };
  }

  film(name) { return this._film.get(name) || null; }
  current(name) {
    const f = this._film.get(name);
    return f ? (f.current || f.head || "") : "";
  }

  /** 合帧拉取（120ms 窗口内同片名多信号合并）。 */
  touch(name, reason) {
    if (!name) return;
    this._wanted.add(name);
    if (this._inflight.has(name)) { this._dirty.add(name); return; }
    if (this._timers.has(name)) return;
    this._timers.set(name, setTimeout(() => {
      this._timers.delete(name);
      void this._pull(name, reason);
    }, COALESCE_MS));
  }

  /** 立即拉（跳过合帧窗口）——用户主动操作后要立刻反映时用。 */
  touchNow(name, reason) {
    if (!name) return Promise.resolve(null);
    const t = this._timers.get(name);
    if (t) { clearTimeout(t); this._timers.delete(name); }
    return this._pull(name, reason || "now");
  }

  async _pull(name, reason) {
    if (this._inflight.has(name)) return this._inflight.get(name);
    const startedAt = Date.now();
    const p = (async () => {
      try {
        const res = await api.fetchApi(CHAIN_FILM_URL(name), { cache: "no-store" });
        if (!res.ok) throw new Error("HTTP " + res.status);
        const film = await res.json();
        const prev = this._film.get(name) || null;
        /* 乐观保护（20261012 快速连点乱序回声）：本次拉取**发起之后**用户又
           乐观切了段，而后端这次返回的还是旧 current —— 不能让旧快照把界面
           拉回旧段。派发给订阅者的快照 current 用乐观值顶替，并安排一次延迟
           对账；等后端串行 POST 落盘完，下一次 pull 命中乐观值即收敛。 */
        const opt = this._opt.get(name);
        let out = film;
        if (opt && opt.at >= startedAt - 50) {
          if (film.current === opt.clip) {
            /* 后端已追上乐观值：收敛，清保护。 */
            this._opt.delete(name);
            this._clearReconcile(name);
          } else {
            out = Object.assign({}, film, { current: opt.clip, head: film.head || opt.clip });
            console.log("[bz_store] 乐观保护：后端 current=" + (film.current || "")
              + " 暂未追上乐观值 " + opt.clip + "，延迟对账");
            this._scheduleReconcile(name);
          }
        } else if (opt) {
          /* 乐观值早于本次拉取：后端结果更新（可能是其他标签页/执行中登记），
             以后端为准，放弃乐观。 */
          this._opt.delete(name);
          this._clearReconcile(name);
        }
        this._film.set(name, out);
        this._dispatch(name, out, reason || "pull", prev);
        return out;
      } catch (err) {
        /* 拉失败不吵：下条 WS 信号 / 30s 兜底会再来；不 dispatch 错误数据 */
        console.warn("[bz_store] film_summary 拉取失败：", name, err);
        return null;
      } finally {
        this._inflight.delete(name);
        if (this._dirty.delete(name)) this.touch(name, "dirty");
      }
    })();
    this._inflight.set(name, p);
    return p;
  }

  /** 乐观值与后端不一致时的有限次延迟对账（最多 3 次，每次 350ms）。 */
  _scheduleReconcile(name) {
    const r = this._reconcile.get(name) || { timer: null, tries: 0 };
    if (r.timer || r.tries >= 3) return;
    r.tries += 1;
    r.timer = setTimeout(() => {
      r.timer = null;
      if (!this._opt.has(name)) { this._clearReconcile(name); return; }
      void this.touchNow(name, "reconcile");
    }, 350);
    this._reconcile.set(name, r);
  }

  _clearReconcile(name) {
    const r = this._reconcile.get(name);
    if (r && r.timer) { clearTimeout(r.timer); r.timer = null; }
    this._reconcile.delete(name);
  }

  /** setCurrent 成功后调用：立即拉一次做权威对账（受乐观保护，不会回跳）。 */
  reconcileCurrent(name /*, seq*/) {
    if (!name) return;
    this._clearReconcile(name);
    void this.touchNow(name, "set_current");
  }

  _dispatch(name, film, reason, prev) {
    this.dispatchEvent(new CustomEvent(STORE_FILM_EVENT, {
      detail: {
        name, film, prev, reason,
        current: film ? (film.current || film.head || "") : "",
      },
    }));
  }

  /** 本地乐观更新 current（切段不等 POST/WS 往返）；后端回声由 _pull 对账收敛。
      seq = setCurrent 的单调请求序号，用于区分"新点击"与"旧回声"。 */
  optimisticCurrent(name, clip, seq) {
    const f = this._film.get(name);
    /* 登记未确认的乐观值（即使快照 current 已相同也登记 —— 后端可能还停在
       更早的段，仍需要一次对账确认）。 */
    this._opt.set(name, { clip: clip || "", seq: seq || 0, at: Date.now() });
    this._clearReconcile(name);
    if (f && f.current === clip) return;
    /* 首个信号可能早于任何快照：拼一个只含 current 的最小快照，订阅者立刻
       能跟切；真快照在 touch 拉回后整体替换。 */
    const nf = f
      ? Object.assign({}, f, { current: clip })
      : { current: clip, head: clip, clips: [] };
    this._film.set(name, nf);
    this._dispatch(name, nf, "optimistic", f);
  }

  /** 改名 / 新工程后清掉旧订阅缓存。 */
  forget(name) {
    this._film.delete(name);
    this._wanted.delete(name);
    this._opt.delete(name);
    this._clearReconcile(name);
    const t = this._timers.get(name);
    if (t) { clearTimeout(t); this._timers.delete(name); }
  }
}

const bzStore = new BzChainStore();

app.registerExtension({
  name: "banzhang.bz_store",
  setup() { bzStore.install(); },
});

export { bzStore };
