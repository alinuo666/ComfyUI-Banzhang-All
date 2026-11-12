import { app } from "../../scripts/app.js";

// 班长全家桶 · 存档节点开关「严格互斥」
// 不变量：任何时刻，画布上的「💾 H3 续拍存档」节点，其「启用存档」开关至多只有
// 一个为开 —— **不看 mode，静音(4)/从不(2) 照样参与互斥**。中央系统
// （csglide_chain.classify_run_media）只认恰好一个启用存档：多于一个会让分段片
// 归属判定落空，视频归档不到时间轴。
// 为什么连静音节点也要算进来：静音只是「不执行」，不是「不存在」。用户先 Ctrl+M
// 静音 342、再点它的开关，此刻 342 是开且即将被取消静音 —— 若把静音节点排除在
// 竞争之外，337 就不会让位，一解除静音立刻双开（真机实测过这个漏洞）。
// 光在「手动点开关」时互斥不够 —— 新建/复制节点、加载工作流、取消静音(Ctrl+M)
// 都不经过开关点击回调，会冒出多个开。这里把四个入口全部堵死：
//   1) 手动点开关（widget.callback，立即收敛）
//   2) 新建/复制节点（onNodeCreated，下一帧收敛）
//   3) 加载工作流（onConfigure，全部节点恢复完后去抖收敛一次）
//   4) 静音 / 取消静音（在实例上把 mode 换成访问器拦截 —— 见 installModeHook。
//      只包 changeMode 不够：Ctrl+M 是直接给 node.mode 赋值，绕开了它）

const SAVE = "MiniMaxH3MotionContextSaveLatent";
const SAVE_ALIAS = "BanZhang_H3_ClipArchive"; // 同名冲突防御后的新入口
const WIDGET = "archive_enabled";
// LiteGraph 节点模式：ALWAYS=0 / ON_EVENT=1 / NEVER=2 / ON_TRIGGER=3 / BYPASS=4。
// 这两个常量只用于 installModeHook 判断「刚被取消静音」，与互斥判定无关 ——
// 互斥是无条件的，任何 mode 都参与。
const MODE_BYPASS = 4;
const MODE_NEVER = 2;

const isSave = (n) => n?.comfyClass === SAVE || n?.comfyClass === SAVE_ALIAS;
const widgetOf = (node) => node?.widgets?.find((w) => w.name === WIDGET);
const isOn = (node) => {
  const w = widgetOf(node);
  return !!w && w.value === true;
};

// 最后一次被手动点成「开」的存档节点 id（仅本页生命周期）。
// 加载/取消静音后出现多开时，优先保留它；没有记录再按节点 id 最小（一采）。
let lastChosenId = null;

function graphNodes() {
  const g = app.graph;
  return (g && (g._nodes || g.nodes)) || [];
}
// 全部存档节点，**不筛 mode**（见文件头：静音节点同样参与互斥）。
function saveNodes() {
  return graphNodes().filter(isSave);
}

// 只写值、不回触发对方回调（避免连锁递归）。
function setSwitch(node, on) {
  const w = widgetOf(node);
  if (!w || w.value === on) return;
  w.value = on;
}

/* 核心不变量：保证开启的存档至多一个（不看 mode）。
   keep 非空 = 用户刚操作/刚取消静音的那个，以它为准（其余全关）；
   keep 为空 = 程序化收敛，若已多于一个开，按「最后点选 > id 最小」留一个。 */
function enforceMutex(keep) {
  const nodes = saveNodes();
  if (!nodes.length) return;
  if (keep && isSave(keep)) {
    for (const n of nodes) if (n !== keep) setSwitch(n, false);
    setSwitch(keep, true);
  } else {
    const on = nodes.filter(isOn);
    if (on.length >= 2) {
      on.sort((a, b) => {
        if (a.id === lastChosenId) return -1;
        if (b.id === lastChosenId) return 1;
        return Number(a.id) - Number(b.id);
      });
      const keeper = on[0];
      for (const n of on) if (n !== keeper) setSwitch(n, false);
    }
  }
  app.graph?.setDirtyCanvas?.(true, true);
}

/* 程序化/批量入口（新建、加载、取消静音）统一去抖到下一帧：
   一次加载会同步触发整批节点的 created/configured，去抖保证等它们状态都
   恢复完再一次性收敛，避免中途误判。重复触发幂等（最终只跑一次）。 */
let rafId = 0;
let pendingKeep = null;
function scheduleEnforce(keep) {
  if (keep) pendingKeep = keep;
  if (rafId) return;
  rafId = requestAnimationFrame(() => {
    rafId = 0;
    const k = pendingKeep;
    pendingKeep = null;
    try { enforceMutex(k); } catch (e) {
      console.warn("[存档互斥] 自动归位失败（不影响运行）：", e);
    }
  });
}

function wireWidget(node) {
  const w = widgetOf(node);
  if (!w || w._bzMutex) return;
  w._bzMutex = true;
  const prev = w.callback;
  w.callback = function (...args) {
    const ret = prev?.apply(this, args);
    // 用户亲手点的开关：实时收敛，绝不延后（开→关则允许，不强制留一个）。
    if (w.value === true) {
      lastChosenId = node.id;
      enforceMutex(node);
    }
    return ret;
  };
}

/* ---- mode 属性拦截：堵住「直接赋值」这条漏网路径 ----------------------
   为什么必须拦在属性这一层：Ctrl+M 的 toggleSelectedNodesMode 是
       selectedNode.mode = newModeForSelectedNode
   **直接赋值**，不经过 changeMode —— 包 changeMode 只堵住了右键菜单，
   快捷键一次互斥都没跑（真机实测：342 取消静音后 337开 + 342开 同时亮）。
   往上追一层，在实例上把 mode 换成访问器，无论谁改（快捷键赋值 /
   changeMode / 程序赋值 / 加载恢复）都必然经过 setter —— 这比逐个追入口
   更靠根：以后前端再加新入口也照样拦得住，不用再补第五个补丁。

   三个必须写对的点（写错任一都会出静默问题）：
     · enumerable: true —— defineProperty 默认不可枚举，任何靠遍历属性做
       序列化 / 克隆 / 脏检查的路径都会把 mode 漏掉，存盘往返后静音状态丢失；
     · setter 只调度不执行 —— 赋值发生在前端遍历选中节点的 forEach 里，
       同步去改别人的 widget 会连锁递归；交给 scheduleEnforce 去抖到下一帧；
     · 真值存 _bzMode 隐藏键 —— getter/setter 里再读写 node.mode 会无限递归。 */
function installModeHook(node) {
  if (!node || node._bzModeHooked) return;
  node._bzModeHooked = true;
  const cur = node.mode;
  Object.defineProperty(node, "_bzMode", {
    value: cur,
    writable: true,
    enumerable: false,      // 纯内部存储，不该出现在序列化 / 遍历里
    configurable: true,
  });
  Object.defineProperty(node, "mode", {
    get() { return this._bzMode; },
    set(v) {
      const prev = this._bzMode;
      this._bzMode = v;
      /* 只有「取消静音 → 启用」需要在这里收敛：它一旦恢复执行，就是一个真正的
         启用存档，必须把其余关掉。反过来（启用 → 静音）不需要做任何事 ——
         互斥是无条件的，静音节点仍占着「唯一那个开」的位置，别人点开才会顶掉它。
         多选批量取消静音时这里会被连续触发 N 次，scheduleEnforce 去抖到
         同一帧，只以最后那个为准收敛一次。 */
      if (v === 0 && (prev === MODE_NEVER || prev === MODE_BYPASS)
          && isSave(this) && isOn(this)) {
        lastChosenId = this.id;
        scheduleEnforce(this);
      }
    },
    enumerable: true,
    configurable: true,
  });
}

app.registerExtension({
  name: "banzhang.archive_enabled.mutex",
  beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== SAVE && nodeData.name !== SAVE_ALIAS) return;

    const onNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = onNodeCreated?.apply(this, arguments);
      wireWidget(this);
      installModeHook(this);
      // 新建/复制出的节点默认开：若画布已有开的，下一帧收敛，杜绝两个开。
      scheduleEnforce(null);
      return r;
    };

    const onConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function () {
      const r = onConfigure?.apply(this, arguments);
      wireWidget(this);
      installModeHook(this);
      // 工作流加载：等全部节点恢复完，去抖收敛一次（脏文件多开也归位）。
      scheduleEnforce(null);
      return r;
    };

    /* 新版前端已无 onModeChange 回调，右键菜单的静音/取消静音走 LGraphNode.changeMode，
       这里包一层（Ctrl+M 走的是属性直接赋值，由 installModeHook 兜住，两条路都要）。
       取消静音(mode→0) 且该存档开关是开的，视为「现在要用它」，以它为准把其余关掉。 */
    const changeMode = nodeType.prototype.changeMode;
    nodeType.prototype.changeMode = function (mode) {
      const r = changeMode ? changeMode.apply(this, arguments) : undefined;
      try {
        if (mode === 0 && isSave(this) && isOn(this)) {
          lastChosenId = this.id;
          scheduleEnforce(this);
        }
      } catch (e) { /* 归位失败不影响静音切换本身 */ }
      return r;
    };
  },
});
