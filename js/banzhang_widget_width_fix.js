// 班长全家桶 — Widget 宽度错位修复（自动生效版）
//
// 修复 ComfyUI_frontend #12443：WidgetLegacy.vue 的 draw() 每帧无条件把
// Vue 容器的 clientWidth 写进 widget.width，LiteGraph 画布模式下渲染器
// 的 `widget.width || nodeWidth` 回退失效，widget 宽度被冻结，
// 拖动/缩放节点后出现错位压缩。
//
// 与独立修复包 (ComfyUI-LegacyWidgetWidthFix) 的区别：
//   - 随班长全家桶前端自动加载，无需向工作流添加任何节点
//   - 上游官方修复该 bug 后，本补丁自动变为 no-op（vueNodesMode 放行写入）
//
// 移植自 ComfyUI-LegacyWidgetWidthFix (web/bugfix.js)

import { app } from "../../scripts/app.js";

const WIDTH_KEY = "__lwwf_width";
const GUARDED = "__lwwf_guarded";
// 全局标志：独立修复包已安装 hook 时避免双层包装（widget 层 GUARDED 幂等，此处仅防冗余）
const INSTALL_FLAG = "__banzhang_lwwf_hooks__";

// addDOMWidget 和 addCustomWidget 绕过 addWidget 直接 push 到 node.widgets，
// 三个方法全部 hook，覆盖所有自定义节点包创建 widget 的代码路径。
const HOOK_METHODS = ["addWidget", "addDOMWidget", "addCustomWidget"];

function inVueMode() {
  // LiteGraph.vueNodesMode 是上游官方修复所用的判断标志。
  // 未定义（旧版本构建）时按 LiteGraph 模式处理、丢弃写入 —— 与待修复的回归一致。
  const LG = globalThis.LiteGraph;
  return !!(LG && LG.vueNodesMode);
}

function guardWidget(w) {
  if (!w || w[GUARDED]) return;
  w[WIDTH_KEY] = w.width;
  Object.defineProperty(w, "width", {
    configurable: true,
    enumerable: true,
    get() {
      return this[WIDTH_KEY];
    },
    set(v) {
      if (!patchActive() || inVueMode()) {
        this[WIDTH_KEY] = v;
      }
      // else: 丢弃写入 —— 这正是要抑制的 bug
    },
  });
  Object.defineProperty(w, GUARDED, {
    value: true,
    enumerable: false,
    configurable: true,
  });
}

function repairWidget(w) {
  if (!w) return;
  guardWidget(w);

  // 清掉残留的持久化宽度，让渲染器回退到 node.size[0]。
  // 必须是 undefined 而非 0：DomWidgets.vue 用 `width ?? nodeWidth`（nullish，
  // 0 不会回退），画布渲染器用 `width || nodeWidth`（falsy，0 可以回退）。
  // undefined 对两者都正确。
  if (!inVueMode()) w[WIDTH_KEY] = undefined;
}

function unguardWidget(w) {
  if (!w || !w[GUARDED]) return;
  const v = w[WIDTH_KEY];
  delete w.width;
  delete w[WIDTH_KEY];
  delete w[GUARDED];
  w.width = v;
}

function patchActive() {
  // 班长全家桶加载即常开。保留此函数以兼容 setter 内的原逻辑。
  return true;
}

function hookWidgetMethods() {
  if (globalThis[INSTALL_FLAG]) return;
  const proto = globalThis.LGraphNode?.prototype;
  if (!proto) return;
  for (const name of HOOK_METHODS) {
    const fn = proto[name];
    if (typeof fn !== "function") continue;
    proto[name] = function patched(...args) {
      const w = fn.apply(this, args);
      if (w) {
        guardWidget(w);
        repairWidget(w);
      }
      return w;
    };
  }
  globalThis[INSTALL_FLAG] = true;
}

function forEachWidget(fn) {
  const nodes = app.graph?._nodes ?? [];
  for (const n of nodes) {
    const ws = n.widgets;
    if (!ws) continue;
    for (const w of ws) fn(w, n);
  }
}

function repairNode(node) {
  for (const w of node?.widgets ?? []) repairWidget(w);
}

function repairAll() {
  forEachWidget((w) => repairWidget(w));
  app.graph?.setDirtyCanvas(true, true);
}

app.registerExtension({
  name: "Banzhang.WidgetWidthFix",

  // app.setup 完成后（工作流已加载）执行：hook 全部建 widget 路径 + 全量修复一次
  setup() {
    hookWidgetMethods();
    repairAll();
  },

  nodeCreated(node) {
    repairNode(node);

    // 其他扩展可能在各自的 nodeCreated 里追加 widget，
    // 等同步 hook 与当前渲染帧结束后重扫一次。
    globalThis.requestAnimationFrame?.(() => {
      if (app.graph?._nodes?.includes(node)) repairNode(node);
    });
  },
});
