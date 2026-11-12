/* bz_project_store.js — 中央工程状态层（单一数据源 · 第①步）
 * ============================================================================
 * 目的：把导演台 / 媒体架 / 文案台三个节点里"同一段"的数据，在**渲染提交前**
 * 统一收口、对齐到当前段身份，再覆盖 graphToPrompt 的提交对象。
 *
 * 为什么需要它（"修了又坏"的根因）：
 *   同一段数据有 5 份副本（导演台 shots[i].state/rack、媒体架 st.segs、
 *   文案台 st.segs、后端 3 张表），靠"广播 + 防抖 + 离开时 stash"的**时序**
 *   对齐。时序一错位（连接池、快速操作、异步等待），graphToPrompt 读到的
 *   widget 就可能是别的段，于是三段渲染同图 / 同词。
 *
 * 本层不依赖时序：提交前直接从三个节点按**段身份**读取权威数据，覆盖提交对象，
 * 后端拿到的永远是当前段。第①步只做"提交对齐"，后续再让日常编辑 / 视图也
 * 收口到本层。
 *
 * 用法：
 *   projectStore.applyToPrompt(prompt, castNode, clipId)
 *     —— 在 graphToPrompt 之后、queuePrompt 之前调用，原地覆盖 prompt.output。
 *
 * ⚠ 20261023 起本层的"提交对齐"退居**兜底**：正常提交走 bz_prompt_build.js
 *   的编译式渲染（按段身份整块覆写三个 *_data，绝不"擦不干净就放过"）。
 *   本文件的 applyToPrompt 保留给"编译失败"的退回路径 —— 它仍有原始的
 *   fail-open 特性（拿不到 rack 段数据就不打补丁），不要再用作主路径。
 *   本层真正还在主干上的职责是：权威令牌（phase）、写穿透账本（flushWrites）、
 *   媒体架段记忆的引用收口（captureRack / mountRack）。
 * ============================================================================ */

import { rackNodeOf, deskNodeOf } from "./bz_rack.js";

const clone = (x) => (x == null ? x : JSON.parse(JSON.stringify(x)));

function emptySlots() {
  return { images: [], videos: [], audios: [] };
}

class ProjectStore {
  /* 定位三个节点（rack / desk 由导演台沿 H3_REFS 上游找）。 */
  nodesOf(castNode) {
    return {
      cast: castNode,
      rack: rackNodeOf(castNode) || null,
      desk: deskNodeOf(castNode) || null,
    };
  }

  /* 读文案台「别名模式」开关（desk.alias）——别名是否参与引用的唯一权威。
     关时只认显式 @图片N：后端不再把剧本里裸写的角色名/文件名展开成 @图片N，
     与文案台 chip 高亮、编辑器提示严格同口径（所见即所送）。
     @returns {boolean|null} 明确开/关；没接文案台或数据读不出来时返回 null
     （交给后端按默认 true 处理，旧工作流行为不变）。 */
  deskAliasOf(deskNode) {
    if (!deskNode || deskNode.type !== "CSGlideDeskCS") return null;
    try {
      const w = deskNode.widgets && deskNode.widgets.find((x) => x.name === "desk_data");
      if (!w || typeof w.value !== "string" || !w.value) return null;
      const d = JSON.parse(w.value);
      return d.alias === true;
    } catch {
      return null;
    }
  }

  /* ============================================================
   * 权威方向 / 写令牌（方案 B · 一劳永逸）
   * ------------------------------------------------------------
   * 每个导演台节点一个 phase，决定"现在谁说了算"：
   *   "boot"      启动 / 读档期：后端是权威，允许 hydrate 后端→前端灌入，
   *                            连接池失败时 self-heal 可重试；
   *   "editing"   用户编辑期：前端是权威，编辑实时落库，self-heal 禁止回灌
   *                            （否则会把用户刚改、还没/已落库的值用后端旧值覆盖）；
   *   "rendering" 渲染期：渲染循环是唯一权威，self-heal 冻结一切 state 覆盖。
   * 历史"画布改了又被拉回旧值"根因：self-heal 写死"后端永远权威"，在
   * editing/rendering 期间用后端旧值覆盖了前端新值。令牌一立，覆盖只在
   * boot 发生，物理上不可能再吃掉编辑。
   * ============================================================ */
  constructor() {
    this._phase = new WeakMap();
    /* 写穿透账本：工程名 -> Map(写键 -> Promise)。三节点每次编辑的"防抖+
       落库"都登记到这里；提交前 flushWrites 等它们全部完成，保证提交那一刻
       缓存（前端）= 后端，物理上不再有"改完立刻提交、后端是旧值"的窗口。 */
    this._pending = new Map();
    /* 全局渲染锁（1-A）：连续生成期间，画布上**所有**导演台节点的 hydrate /
       self-heal / 热接管一律冻结，不只有 beginRender 传入的那一个节点 ——
       否则画布上还挂着别的导演台，它的 3s 巡检照样用后端旧值回灌、抢主线程。 */
    this._globalRender = 0;
    this._renderNodes = new Set();
  }
  phaseOf(castNode) {
    return this._phase.get(castNode) || "boot";
  }
  /* 用户开始编辑：只在 boot 态转入 editing（rendering 态不被编辑操作打断）。 */
  beginEdit(castNode) {
    if (this.phaseOf(castNode) === "boot") this._phase.set(castNode, "editing");
  }
  beginRender(castNode) {
    this._phase.set(castNode, "rendering");
    this._globalRender += 1;
    this._renderNodes.add(castNode);
  }
  endRender(castNode) {
    this._phase.set(castNode, "editing");
    if (this._renderNodes.delete(castNode)) {
      this._globalRender = Math.max(0, this._globalRender - 1);
    }
  }
  /* 全局渲染锁是否生效（任何节点在渲染 = 全画布冻结自愈回灌）。 */
  isGloballyRendering() {
    return this._globalRender > 0;
  }
  /* 是否允许"后端→前端"自动灌入：仅 boot 态。显式重建/切工程走 force=true。 */
  canPullFromBackend(castNode) {
    return this.phaseOf(castNode) === "boot";
  }

  /* ============================================================
   * 写穿透（write-through）账本（方案 C · 前端实时缓存）
   * ------------------------------------------------------------
   * 三节点编辑后落库是"防抖 + 网络"，天然有窗口。把每次落库登记成一个
   * Promise（同一写键串行，防止后写先到、旧值盖新值），提交前 flushWrites
   * 等全部完成。前端实时缓存保住交互零延迟，后端仍是最终唯一真相。
   * ============================================================ */
  _pendingFor(name) {
    let m = this._pending.get(name);
    if (!m) {
      m = new Map();
      /* 防抖表（Map 上的额外属性，不进 entries）：
         _fire[key] = 取最新数据并返回落库 Promise 的函数；
         _timers[key] = 防抖 timer。 */
      m._fire = {};
      m._timers = {};
      this._pending.set(name, m);
    }
    return m;
  }
  /**
   * 调度一次防抖写（三节点编辑收口都走这里）。
   * @param {string} name 工程名
   * @param {string} key 写键（如 "rack:clip_0001" / "state:clip_0002" / "desk"）
   * @param {() => Promise} fire 防抖结束后取**最新**数据并发起落库的函数
   * @param {number} waitMs 防抖毫秒
   */
  scheduleSave(name, key, fire, waitMs) {
    if (!name) return;
    const m = this._pendingFor(name);
    m._fire[key] = fire;                       // 总是覆盖成最新数据
    clearTimeout(m._timers[key]);
    m._timers[key] = setTimeout(() => this._fireOne(name, key), waitMs || 700);
  }
  /* 防抖结束：取最新 fire 发起网络落库，登记串行。 */
  _fireOne(name, key) {
    const m = this._pending.get(name);
    if (!m || !m._fire || !m._fire[key]) return;
    const fire = m._fire[key];
    delete m._fire[key];
    clearTimeout(m._timers[key]);
    let p;
    try { p = Promise.resolve(fire()); } catch (e) { p = Promise.resolve(null); }
    /* 同键网络写严格串行：防后写先到、旧值盖新值。这里登记的是纯网络
       Promise（一定会 settle），不含防抖等待，故不会被取消卡死。 */
    const prev = m.get(key);
    const next = Promise.resolve(prev).then(() => p).catch(() => {});
    m.set(key, next);
    next.finally(() => { if (m.get(key) === next) m.delete(key); });
  }
  /**
   * 提交 / 切段前：① 立即触发所有防抖等待（不傻等 700ms）；
   * ② 等全部网络写完成。保证提交那一刻前端缓存 = 后端。
   */
  async flushWrites(name) {
    const m = this._pending.get(name);
    if (!m) return;
    /* 立即把在防抖的写全部 fire（用最新数据）。 */
    Object.keys(m._fire || {}).forEach((key) => {
      clearTimeout(m._timers[key]);
      this._fireOne(name, key);
    });
    /* 等所有网络写 settle。 */
    await Promise.all([...m.keys()].map((k) => m.get(k))).catch(() => {});
  }

  /**
   * 实时收口媒体架当前架面：把"当前段"的架面写入段记忆 segs[cur]。
   * 供媒体架每次 commit 调用，替代"只在切段离开时才快照"。
   * 用引用指向当前 slots 数组（无深拷贝）；load 重建数组后总会再 commit 刷新。
   */
  captureRack(rackNode) {
    const g = rackNode && rackNode.gmr;
    if (!g || !g.st || !g.st.cur) return;
    const st = g.st;
    st.segs[st.cur] = {
      slots: st.slots,
      fps: st.fps || 0,
      audio_out: st.audio_out || 0,
    };
  }

  /**
   * 引用切段（物理单一持有）：媒体架切到 key 段时，
   *  - 若段记忆已有该段（带 slots），离开旧段用**引用**收口、直接把 st.slots
   *    指向段记忆 rec.slots —— 不 clone、不 revive，每段 slots 物理上只此一份；
   *  - 段记忆没有该段时返回 false，由调用方走 load revive 建立。
   * 只切换数据，不渲染；返回后调用方渲染。
   * @returns {boolean} 是否成功引用
   */
  mountRack(rackNode, key) {
    const g = rackNode && rackNode.gmr;
    if (!g || !g.st) return false;
    const st = g.st;
    key = String(key);
    const rec = st.segs[key];
    if (!rec || !rec.slots) return false;
    /* 离开旧段：引用收口（不 clone）。 */
    if (st.cur && st.cur !== key) {
      const old = st.segs[st.cur] || {};
      old.slots = st.slots;
      old.fps = st.fps || 0;
      old.audio_out = st.audio_out || 0;
      st.segs[st.cur] = old;
    }
    /* 直接引用新段 slots。 */
    st.slots = rec.slots;
    st.fps = rec.fps || 0;
    st.audio_out = rec.audio_out || 0;
    st.cur = key;
    return true;
  }

  /**
   * 收集当前段（clip）的权威数据。
   * @returns {{clip:string, state:object|null, rack:object|null, desk:string}}
   *
   * rack / desk 一律按段身份从各自"段记忆"取，不看架面此刻停在哪——
   * 广播可能先把架面切到了别的段，但段记忆是竞态免疫通道。
   */
  collectSeg(castNode, clip) {
    clip = clip ? String(clip) : "";
    const { rack, desk } = this.nodesOf(castNode);

    /* state：导演台当前面板（switchTo 后已 load 成当前段）。 */
    let state = null;
    if (castNode.h3ui && castNode.h3ui.st) state = clone(castNode.h3ui.st);

    /* rack：媒体架段记忆 segs[clip] 优先；架面正停在该段时也可用架面兜底。 */
    let rackSnap = null;
    if (rack && rack.gmr && rack.gmr.st) {
      const mst = rack.gmr.st;
      if (clip && mst.segs && mst.segs[clip]) {
        rackSnap = clone(mst.segs[clip]);
      } else if (!clip || String(mst.cur) === clip) {
        rackSnap = clone({
          slots: mst.slots,
          fps: mst.fps,
          audio_out: mst.audio_out,
        });
      }
    }

    /* desk：文案台按段身份读段词（内部会先收口 textarea）。 */
    let deskWords = "";
    if (desk && desk.deskUI && typeof desk.deskUI.segWords === "function") {
      deskWords = desk.deskUI.segWords(clip);
    }

    return { clip, state, rack: rackSnap, desk: deskWords };
  }

  /**
   * 把当前段权威数据覆盖到 graphToPrompt 的提交对象 prompt.output（原地）。
   * @returns {string[]} 实际覆盖了哪些节点（h3 / rack / desk），供诊断。
   */
  applyToPrompt(prompt, castNode, clip) {
    if (!prompt || !prompt.output) return [];
    /* clip 只用于前端内部定位段记忆；写进 h3_data 时会清掉，
       后端按 chain.shot（分段 uid）认段。 */
    clip = clip ? String(clip) : "";
    const seg = this.collectSeg(castNode, clip);
    const { rack, desk } = this.nodesOf(castNode);
    const done = [];

    /* 导演台 h3_data：强制认当前段。 */
    if (seg.state) {
      this._patchNode(prompt, castNode, "CSGlideCastCS", (inputs) => {
        /* 提交不带 clip：后端按 chain.shot（分段 uid）认段，显式 clip 会
           跨工程认不出 → _SegBindingLost。clip 只用于上面的段记忆定位。 */
        if (!seg.state.chain) seg.state.chain = {};
        seg.state.chain.clip = "";
        /* 别名开关全链路以文案台为唯一权威：desk.alias 透传进 h3_data.alias，
           后端 csglide_cast 据此决定是否把裸角色名展开成 @图片N。这样"文案台
           chip 亮不亮 / 编辑器认不认别名"与"后端到底发不发参考图"严格同口径。
           读不到（没接文案台）时不写，后端按默认 True（展开），旧行为不变。 */
        const deskAlias = this.deskAliasOf(desk);
        if (deskAlias !== null) seg.state.alias = deskAlias;
        inputs.h3_data = JSON.stringify(seg.state);
        done.push("h3");
      });
    }

    /* 媒体架 rack_data：只对齐 slots/fps/audio_out/cur，保留其余段记忆。 */
    if (rack && seg.rack) {
      this._patchNode(prompt, rack, "CSGlideH3MediaRackCS", (inputs) => {
        let d = {};
        try { d = JSON.parse(inputs.rack_data || "{}"); } catch { d = {}; }
        d.slots = clone(seg.rack.slots) || emptySlots();
        d.fps = seg.rack.fps || 0;
        d.audio_out = seg.rack.audio_out || 0;
        d.cur = clip;
        if (d.segs && clip) d.segs[clip] = clone(seg.rack);
        inputs.rack_data = JSON.stringify(d);
        done.push("rack");
      });
    }

    /* 文案台 desk_data：对齐 chain.clip 与本段段词。 */
    if (desk) {
      this._patchNode(prompt, desk, "CSGlideDeskCS", (inputs) => {
        let d = {};
        try { d = JSON.parse(inputs.desk_data || "{}"); } catch { d = {}; }
        if (clip) {
          if (!d.chain) d.chain = { name: "", clip: "", shot: "" };
          d.chain.clip = clip;
          if (!d.segs) d.segs = {};
          d.segs[clip] = seg.desk;
        }
        inputs.desk_data = JSON.stringify(d);
        done.push("desk");
      });
    }

    return done;
  }

  /* 按节点 id 定位提交对象里那一项；找不到（极端情况）按 class_type 回退找。
     找到后用回调改它的 inputs。 */
  _patchNode(prompt, node, classType, fn) {
    if (!node) return;
    let entry = prompt.output[String(node.id)];
    if (!entry && classType) {
      for (const k of Object.keys(prompt.output)) {
        const e = prompt.output[k];
        if (e && e.class_type === classType) { entry = e; break; }
      }
    }
    if (!entry || !entry.inputs) return;
    fn(entry.inputs);
  }
}

const projectStore = new ProjectStore();
export { projectStore };
