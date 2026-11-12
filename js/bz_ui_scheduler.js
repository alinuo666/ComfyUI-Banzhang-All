// 班长全家桶 · 统一 UI 调度中心（bz_ui_scheduler） 20261017
//
// 为什么要有这个文件
// ------------------
// 全家桶有 84 个前端扩展，其中 30 个各自在节点生命周期上挂钩子，累计 513 个
// 布局 / 重绘调用点，全部同步挤在浏览器这一个主线程上。结果就是：
//   · 创建一个节点要被 30 个扩展轮流改造一遍，主线程被占满；
//   · 浏览器没空派发 mouseup → 新拖出来的节点粘在鼠标上点不下去；
//   · 任一环算出个离谱尺寸，节点被撑到几万像素高，每帧照画 → 内存飙升。
//
// 本模块把这些调用收口到一处，做四件事：
//   ① 尺寸硬封顶：任何 setSize 都过闸，撑不爆节点（防内存飙升）
//   ② 交互优先：鼠标按下/拖拽期间把昂贵的布局(setSize)推迟，把主线程完整
//      让给 mouseup —— 这是「节点粘鼠标」的直接解药
//   ③ 重绘合并：同一帧内重复的 setDirtyCanvas 只真正跑一次
//   ④ 错误隔离：每个任务独立 try/catch，一个扩展炸了不拖垮整张画布
//
// 为什么用「全局 hook」而不是逐个改扩展
// ------------------------------------
// 逐个改要动 500 多处、回归成本极高；全局 hook 一次建成、立刻对所有扩展生效
// （包括以后新装的）。各扩展还可以 import 本模块主动走调度（见导出）。
//
// 刻意不 import app.js：本模块要能被任意扩展在任何加载顺序下 import，
// 保持零依赖、最先可用。重绘目标在调用时才惰性取。

// ── 可调参数 ────────────────────────────────────────────────────────────
// 节点尺寸硬上限。正常节点远小于此，纯防异常值把画布拖垮。
const MAX_W = 4000;
const MAX_H = 2000;
// 交互态兜底超时：万一 pointerup 丢失（比如拖出窗口），不能永久卡在交互态。
const INTERACT_TIMEOUT_MS = 8000;
// 补做布局时的单帧预算：超时就把剩下的推到下一帧，避免「松手那一刻」反而
// 卡一下（补做一堆节点尺寸同样要时间，不能一次性全塞进同一帧）。
const FRAME_BUDGET_MS = 8;

// ── 内部状态 ────────────────────────────────────────────────────────────
let interacting = false;
let interactDeadline = 0;
// 交互期间被推迟的 setSize：node -> 尺寸参数（只放尺寸，别塞别的）
const pendingSize = new Map();
// 交互期间被推迟的「布局任务」：bzRequestLayout 排进来的回调。
// 与 pendingSize 分开存 —— 前者是尺寸、后者是函数，混在一起会把 null
// 当成尺寸传给 setSize。
const pendingTasks = new Set();
let flushRaf = null;

// LiteGraph 不保证在本模块被 import 时就已经挂到 window 上（扩展加载顺序由
// ComfyUI 决定）。所以这里不急着取，交给 ensureInstall() 重试，取到再装 hook。
let NodeProto = null;

/** 当前是否处于「用户正在按下/拖拽」状态（带超时兜底）。 */
export function bzIsInteracting() {
  if (!interacting) return false;
  if (typeof performance !== "undefined" && performance.now() > interactDeadline) {
    // pointerup 丢了（拖出窗口、被对话框吃掉）—— 到点强制解除，避免永久卡死
    interacting = false;
    return false;
  }
  return true;
}

/** 把尺寸钳到上限内。NaN 交回原逻辑处理，不擅自改写。 */
function clampNum(v, max) {
  const n = Number(v);
  if (Number.isNaN(n)) return v;
  if (n === Infinity || n === -Infinity) return max;
  return Math.min(Math.max(n, 0), max);
}

/**
 * 该节点此刻是否正被用户拖边角改尺寸。
 * 拖拽期间尺寸必须实时写入 —— 推迟会让节点外框不跟鼠标走，观感就是拖动卡顿，
 * 松手后再一次性补做还会跳到与鼠标终点对不上的尺寸。
 */
function isResizeTarget(node) {
  // 两个来源都查：active_canvas 是 LiteGraph 的全局当前画布，
  // list_of_graphcanvas 是节点所属图的画布表。任一命中即放行，取不到就当不是。
  const canvases = [
    globalThis.LGraphCanvas?.active_canvas,
    ...(node?.graph?.list_of_graphcanvas ?? []),
  ];
  for (const c of canvases) {
    if (c && c.resizing_node === node) return true;
  }
  return false;
}

function scheduleFlush() {
  if (flushRaf != null) return;
  const raf = globalThis.requestAnimationFrame;
  if (typeof raf !== "function") return;
  flushRaf = raf(flushPending);
}

/** 补做交互期间被推迟的布局。一次只做一批，做完就停。 */
function flushPending() {
  flushRaf = null;
  if (bzIsInteracting()) {
    // 还在拖：继续等，别跟交互抢主线程
    if (pendingSize.size || pendingTasks.size) scheduleFlush();
    return;
  }
  // 1) 补做被推迟的 setSize（带单帧预算，做不完的推下一帧）
  const orig = NodeProto && NodeProto.__bzOrigSetSize;
  if (orig) {
    const now = () =>
      typeof performance !== "undefined" ? performance.now() : Date.now();
    const t0 = now();
    const entries = Array.from(pendingSize.entries());
    pendingSize.clear();
    for (let i = 0; i < entries.length; i++) {
      const [node, size] = entries[i];
      try {
        orig.call(node, size);
      } catch (err) {
        console.warn("[班长调度] 补做节点尺寸失败（已跳过）：", err);
      }
      // 每 8 个查一次表：够便宜，又不会让「松手瞬间」变成一次长任务
      if ((i & 7) === 7 && now() - t0 > FRAME_BUDGET_MS && i + 1 < entries.length) {
        for (let j = i + 1; j < entries.length; j++) {
          pendingSize.set(entries[j][0], entries[j][1]);
        }
        scheduleFlush();
        break;
      }
    }
  } else {
    pendingSize.clear();
  }

  // 2) 补跑被推迟的布局任务
  for (const run of pendingTasks) {
    try {
      run();
    } catch (err) {
      console.warn("[班长调度] 补跑布局任务失败（已跳过）：", err);
    }
  }
  pendingTasks.clear();
}

// ── ① + ②：setSize 封顶 + 交互期间推迟 ────────────────────────────────
function hookSetSize() {
  const proto = NodeProto;
  if (!proto || !proto.setSize || proto.__bzSizeHooked) return false;
  const orig = proto.setSize;
  proto.__bzOrigSetSize = orig;
  proto.__bzSizeHooked = true;

  proto.setSize = function (size) {
    let next = size;
    if (Array.isArray(size) && size.length >= 2) {
      // LiteGraph 标准用法：setSize([w, h])
      next = [clampNum(size[0], MAX_W), clampNum(size[1], MAX_H)];
    }
    // 用户自己正在拖这个节点的边角 —— 这条尺寸是交互本身，必须实时生效。
    // 同时必须丢掉交互早期记下的旧尺寸：拖拽刚起步时（resizing_node 还没挂上）
    // 可能已经记过一次原始尺寸，若不清掉，松手后 flushPending 会用那条旧记录
    // 把节点覆盖回原样 —— 表现就是「拉大了、一松手弹回原始大小」。
    if (isResizeTarget(this)) {
      pendingSize.delete(this);
      try {
        return orig.call(this, next);
      } catch (err) {
        console.warn("[班长调度] setSize 失败（已跳过）：", err);
      }
      return;
    }
    if (bzIsInteracting()) {
      // 交互中：昂贵的布局先记账，等松手再补做 —— 主线程留给 mouseup
      pendingSize.set(this, next);
      scheduleFlush();
      return;
    }
    try {
      return orig.call(this, next);
    } catch (err) {
      console.warn("[班长调度] setSize 失败（已跳过）：", err);
    }
  };
  return true;
}

// ── ①b：computeSize 钳制（把离谱值挡在源头）───────────────────────────
// setSize 是「出口封顶」，这里是「源头治理」：各扩展都拿 computeSize 的结果
// 去算目标尺寸，源头一给离谱值，后面整条链路跟着一起放大。这里直接钳回来。
// 刻意不 catch —— computeSize 抛错说明节点本身有问题，静默吞掉会掩盖真因，
// 让它照常抛，比返回一个假尺寸要好。
function hookComputeSize() {
  const proto = NodeProto;
  if (!proto || !proto.computeSize || proto.__bzComputeHooked) return false;
  const orig = proto.computeSize;
  proto.__bzComputeHooked = true;

  proto.computeSize = function () {
    const out = orig.apply(this, arguments);
    if (Array.isArray(out) && out.length >= 2) {
      return [clampNum(out[0], MAX_W), clampNum(out[1], MAX_H)];
    }
    return out;
  };
  return true;
}

// ── ③：重绘合并（同一帧内重复请求只真正跑一次）────────────────────────
// 只合并、不延迟：拖拽时画面照常更新，只是不再同一帧标记十几次 dirty。
let dirtyRaf = null;
const dirtyNodes = new Set();

function hookSetDirtyCanvas() {
  const proto = NodeProto;
  if (!proto || !proto.setDirtyCanvas || proto.__bzDirtyHooked) return false;
  const orig = proto.setDirtyCanvas;
  proto.__bzOrigDirty = orig;
  proto.__bzDirtyHooked = true;

  proto.setDirtyCanvas = function (fg, bg) {
    dirtyNodes.add(this);
    if (dirtyRaf != null) return; // 本帧已经有排队的重绘，合并掉
    const raf = globalThis.requestAnimationFrame;
    if (typeof raf !== "function") {
      try { orig.call(this, fg, bg); } catch (e) { /* 忽略 */ }
      return;
    }
    dirtyRaf = raf(() => {
      dirtyRaf = null;
      const nodes = Array.from(dirtyNodes);
      dirtyNodes.clear();
      for (const node of nodes) {
        try {
          // 合并后必须仍按全量重绘发出：只脏前景会让 DOM 容器高度跟不上节点高度，
          // Vue 侧那条「DOM 尺寸 != 节点尺寸就覆盖回去」的同步会把手动拉大的节点缩回原状。
          orig.call(node, true, true);
        } catch (err) {
          console.warn("[班长调度] 重绘失败（已跳过）：", err);
        }
      }
    });
  };
  return true;
}

// ── 交互态检测 ──────────────────────────────────────────────────────────
// 捕获阶段监听 document：不管别的扩展在画布上挂了什么，document 永远先收到。
function onDown() {
  interacting = true;
  interactDeadline =
    (typeof performance !== "undefined" ? performance.now() : Date.now()) +
    INTERACT_TIMEOUT_MS;
}
function onUp() {
  if (!interacting) return;
  interacting = false;
  if (pendingSize.size) scheduleFlush();
}

function hookInteraction() {
  if (globalThis.__bzSchedulerHooked) return;
  globalThis.__bzSchedulerHooked = true;
  const doc = globalThis.document;
  if (!doc || !doc.addEventListener) return;
  doc.addEventListener("pointerdown", onDown, true);
  doc.addEventListener("pointerup", onUp, true);
  doc.addEventListener("pointercancel", onUp, true);
  // 兜底：拖出窗口松开、切标签页回来，别把交互态一直挂着
  globalThis.addEventListener?.("blur", onUp);
  doc.addEventListener("visibilitychange", onUp);
}

/**
 * 扩展主动走调度：把一个「布局任务」排进队列。
 * L1 收口阶段各扩展用它替代直接调 computeSize/setSize。
 * @param {object} node 目标节点
 * @param {Function} task 真正干活的回调（内部已做错误隔离）
 */
export function bzRequestLayout(node, task) {
  if (!node || typeof task !== "function") return;
  const run = () => {
    try {
      task();
    } catch (err) {
      console.warn("[班长调度] 布局任务失败（已跳过）：", err);
    }
  };
  if (bzIsInteracting()) {
    // 交互中：排队，等松手由 flushPending 统一补跑 —— 不在拖拽途中抢主线程
    pendingTasks.add(run);
    scheduleFlush();
    return;
  }
  run();
}

/** 手动清掉某个节点待补做的布局（比如节点已被删除）。 */
export function bzCancelLayout(node) {
  if (node) pendingSize.delete(node);
}

// ── 安装 ────────────────────────────────────────────────────────────────
// 交互态检测只依赖 document，先装上，不等 LiteGraph。
hookInteraction();

/**
 * 等 LiteGraph 就位再装 hook。扩展加载顺序由 ComfyUI 决定，本模块很可能比
 * LiteGraph 核心先被 import —— 取不到就下一帧再试，给足 60 帧（约 1 秒），
 * 足够 ComfyUI 把核心跑完；超了就明确报一句，而不是静默失效。
 */
function ensureInstall(attempt) {
  const LG = globalThis.LiteGraph;
  const proto = (LG && LG.LGraphNode && LG.LGraphNode.prototype) || null;
  if (!proto) {
    const raf = globalThis.requestAnimationFrame;
    if (attempt < 60) {
      if (typeof raf === "function") raf(() => ensureInstall(attempt + 1));
      else setTimeout(() => ensureInstall(attempt + 1), 50);
    } else {
      console.warn("[班长调度] LiteGraph 迟迟未就位 —— 调度中心未装载，"
        + "节点尺寸与重绘退回各自为政（不影响功能，只是不再受保护）");
    }
    return;
  }
  NodeProto = proto;
  const size = hookSetSize();
  const compute = hookComputeSize();
  const dirty = hookSetDirtyCanvas();
  console.log(
    "[班长调度] 统一 UI 调度中心已装载：尺寸封顶 %dx%d，setSize %s，"
    + "computeSize %s，重绘合并 %s，交互优先已开",
    MAX_W,
    MAX_H,
    String(size),
    String(compute),
    String(dirty)
  );
}

ensureInstall(0);
