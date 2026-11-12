import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
/* 这两个本文件自己已经不用了（搬去 csglide_cast_slots.js 了），但**必须留着**：
   csglide_qwen.js 与 csglide_media_rack.js 至今还是从本文件取它们的
   （`import { … promptNodeOf, upstreamTextOf } from "./csglide_cast.js"`）。
   bz_rack.js 没有走下面的 export *，删掉这行那两个节点会直接白屏。 */
import { promptNodeOf, upstreamTextOf, BZ_BAG_VERSION } from "./bz_rack.js";
import {
  hydrateFromStore, startSelfHeal, stopSelfHeal, switchToProject, adoptCopiedProject,
} from "./bz_project_sync.js";
import { projectStore } from "./bz_project_store.js";
import { CSS } from "./csglide_cast.css.js";
/* 常量、画布与时长算法、面板状态 —— 纯数据 / 纯函数，见 csglide_cast_core.js。
   只列本文件真正用到的：core 里其余的符号由下面 export * 原样转出去，媒体架和
   Qwen 节点仍从本文件取（改它们的 import 是另一件事）。分镜解析那一组
   （SHOT_RE / AT_MMSS / AT_SECS / parseShots）随分镜条一起删掉了，已从 core
   的导入里移除 —— 但 core 本身还留着，文案台若要分镜能力可直接从 core 取。 */
import {
  NODE_ID, FPS,
  ACCEPT_IMAGE, EXT_KIND, badImageKind, MAX_PIXELS, RATIOS,
  findRatio, REF_STEP, REF_MIN,
  REF_IMAGE_MAX, REF_VIDEO_MAX, REF_FPS_MIN, REF_FPS_MAX, clampRefFps, REF_SCALE_MIN,
  REF_SCALE_MAX, REF_SCALE_STEP, clampRefScale,
  renderRefControl, MIN_H_REF, MIN_PANEL_W,
  MIN_FLOOR_H, MAX_NODE_H, alignFrames,
  fmtSecs, secsOfFrames, framesOfSecs, blankState, parseInitial,
} from "./csglide_cast_core.js";
/* 通用界面零件。本文件现在只用 el（造根节点）—— 其余零件各分区自己 import。 */
import { el } from "./csglide_ui_kit.js";

/* 搬走的东西对外的门牌号不能变：媒体架（csglide_media_rack.js）一直是
   从本文件 import EXT_KIND / ACCEPT_IMAGE / 别名常量 那一批的。整块 re-export，
   让它们继续从这儿拿到——改媒体架的 import 是另一件事，不该夹在这次搬家里。 */
export * from "./csglide_cast_core.js";
export * from "./csglide_ui_kit.js";

/* 拖带工作流元数据的视频进画布，ComfyUI 会新开一个标签页，里面 h3_data /
   desk_data / rack_data 已经是生成当时那份。捕获阶段先记下这个动作，交给
   onConfigure 一次性消费：不去认识 ComfyUI 的加载 API，也不改视频文件。 */
const _bzDrop = { at: 0, name: "" };
const _bzDropExt = /\.(mp4|mov|m4v|webm|mkv|png|webp)$/i;
document.addEventListener("drop", (e) => {
  const fs = e && e.dataTransfer && e.dataTransfer.files;
  if (!fs || !fs.length) return;
  for (const f of fs) {
    if (f && _bzDropExt.test(f.name || "")) {
      _bzDrop.at = Date.now();
      _bzDrop.name = f.name || "";
      return;
    }
  }
}, true);
function consumeVideoDrop() {
  if (!_bzDrop.at || Date.now() - _bzDrop.at > 5000) return "";
  const name = _bzDrop.name;
  _bzDrop.at = 0;                 /* 一次性消费，5 秒内打开别的工作流不误判 */
  return name;
}
/* 面板的各个分区。顺序 = 原来在 buildUI 里的先后，不能调：后装的块会用到先装
   块挂到 ui 上的东西，而每个块是**装完才挂**，所以这个顺序原来就是声明次序。 */
import { installCmdBar } from "./csglide_cast_cmdbar.js";
import { installSettings } from "./csglide_cast_settings.js";
import { installAlias } from "./csglide_cast_alias.js";
import { installMonitor } from "./csglide_cast_monitor.js";
import { installSlots } from "./csglide_cast_slots.js";
import { installWave } from "./csglide_cast_wave.js";
import { installView } from "./csglide_cast_view.js";
import { installShots } from "./csglide_cast_shots.js";
import { installRun } from "./csglide_cast_run.js";
import { installSync } from "./csglide_cast_sync.js";
import { installTakes } from "./csglide_cast_takes.js";
import { installReview } from "./csglide_cast_review.js";
import { installHistory } from "./csglide_cast_history.js";
import { installConflict } from "./csglide_cast_conflict.js";
import { installMeta } from "./csglide_cast_meta.js";
import { installListeners } from "./csglide_cast_listeners.js";
import { installPaste } from "./csglide_cast_paste.js";

/* =========================================================================
 * H3 Studio — UI
 *
 * Two model families, one node. The accent colour IS the family indicator:
 *   blue  = fl2va  (first / last keyframes)
 *   green = ref2va (9 images, 3 videos, 3 audio)
 * Mismatched weights run fine and produce nonsense, so the node shouts which
 * family it is currently asking for.
 * ====================================================================== */

/* 媒体架（csglide_media_rack.js）导入这份样式表，保证两个节点的槽位视觉
   与字阶完全相同——而不是各写一份会各自漂移的近似样式。 */
export const CAST_CSS = CSS;

function injectCSS() {
  if (document.getElementById("gcast-css")) return;
  const s = document.createElement("style");
  s.id = "gcast-css"; s.textContent = CSS;
  document.head.appendChild(s);
}

/* ------------------------------------------------------------- helpers */

/* What is being dragged, read from the drag rather than the file: during a
 * dragover the name is not exposed, only the MIME type. Returns image, video,
 * audio, or null when it is not a file drag at all (a node, a link, text). */

/* ================================================================= build */

function buildUI(node) {
  /* 共享 bag：本文件剩下的代码与拆出去的各模块都通过它拿同一份东西。
     可变状态（ui.st / ui.run / …）在两边都是同一个字段，不会各存一份。 */
  const ui = { node, app, api };
  /* 历史旧工程切换：菜单点击时调用，复用状态库的整包加载/灌库通道。 */
  ui.switchToProject = (name) => switchToProject(node, name);
  /* 拖入视频还原：后端把原片整份档案复制到新片名之后，按复制来的档案重建
     工程对象（与 switchToProject 同一条重建路径，区别是不 stash —— 见
     bz_project_sync.adoptCopiedProject 的注释）。 */
  ui.adoptCopiedProject = (name) => adoptCopiedProject(node, name);
  ui.root = el("div", "gcast");
  ui.st = blankState();
  ui.dataWidget = null;
  /* 前端 bag 版本标记：热重载自愈巡检（bz_project_sync.startSelfHeal）
     靠它识别 h3ui 是不是热重载前的旧闭包。节点级 BZ_BAG_VERSION 会被
     HMR 接管代码无条件覆盖，检测必须挂在 ui 闭包上。 */
  ui.BAG_VERSION = BZ_BAG_VERSION;

  ui.commit = () => {
    /* 任何编辑收口都把权威方向从 boot 切到 editing（前端权威）。beginEdit
       只在 boot 态生效，渲染期间 commit 不会错误打断 rendering。 */
    projectStore.beginEdit(node);
    /* 段落档案与「工程」合一 —— 只有一套概念，不并存：
         工程名   = 片名（output/h3_chain/<片名>/）
         工程分段 = 段落（clip_0001…），分段的 clip id 就存在 shot 上
       后端按 chain.name + chain.clip 归档；clip 为空则新建一段。 */
    const p = node.properties && node.properties.gcast_project;
    if (p && Array.isArray(p.shots)) {
      ui.st.chain.name = p.name || "";
      const cur = p.shots[p.idx];
      if (cur) {
        /* 分段身份：老工程的分段可能没有 id，补一个，否则每次运行都新建一段。
           内联生成而不用 uid()——那个 const 定义在面板更下方，commit 有可能
           在它之前就被调用（TDZ 会直接抛错）。 */
        if (!cur.id) cur.id = Math.random().toString(36).slice(2, 9);
        ui.st.chain.shot = cur.id;
        /* 单向签发（20261105）：clip **只能**从工程现场（cur.clip）流向面板，
           面板里持久化的旧值绝不反向写回 shot。
           这里原来写的是"面板有 clip 就赋给 shot.clip，否则把 shot.clip 喂给
           面板"的双向同步，后果是：加载一份别处/别工程的工作流时，
           h3_data.chain.clip 里残留的 clip_0001 会在任意一次 commit（改参数、
           拖节点、切段、收片）时被写进**当前工程**的 shot，再由 :146 持久化进
           widget；运行时带着这个本工程根本不存在的段 id 去提交，后端
           _register_clip 查 load_clip 返回 None → 抛 _SegBindingLost，
           整次生成直接失败。
           shot.clip 的合法来源只有一个：后端 bind_segment 返回的真实 id
           （csglide_cast_sync.js:76 / csglide_cast_shots.js:604）。
           「重抽同一段不新建」不受影响 —— cur.clip 已由上面那条通道填好了。 */
        ui.st.chain.clip = cur.clip || "";
      }
    }
    if (!ui.dataWidget) ui.dataWidget = node.widgets?.find((w) => w.name === "h3_data");
    if (ui.dataWidget) {
      /* clip 是后端按 shot uid 现场签发的运行时凭证，不写进 widget：
         widget.value 既进工作流存盘、又进「未经编译的裸提交」，一旦随 .json
         跨机器分发，就会带着别的工程的 clip_XXXX 去后端认段 → _SegBindingLost。
         ui.st 内存里仍保留 clip，段记忆 / 时间轴索引照旧用。 */
      const saved = { ...ui.st, chain: { ...(ui.st.chain || {}), clip: "" } };
      ui.dataWidget.value = JSON.stringify(saved);
    }
    node.setDirtyCanvas(true, true);
    /* state 写穿透：当前段已认 clip 时，编辑收口即安排落库（防抖但已登记），
       不必等切段 stash。这样改画布/参数后，后端也及时更新。 */
    const cid = ui.st.chain && ui.st.chain.clip;
    if (cid && typeof ui.persistClipState === "function") ui.persistClipState(cid, ui.st);
  };

  installCmdBar(ui);
  installSettings(ui);
  installAlias(ui);
  installMonitor(ui);
  installSlots(ui);
  installWave(ui);
  installView(ui);
  installShots(ui);
  installRun(ui);
  installSync(ui);
  installTakes(ui);
  installReview(ui);
  installHistory(ui);
  installConflict(ui);
  installMeta(ui);
  installListeners(ui);
  installPaste(ui);
  /* 入队前自动准备（20261020）：ComfyUI 在生成 prompt 前会遍历所有节点的 widget
     调用 beforeQueued —— 官方钩子（前端 queuePrompt 里的
     executeWidgetsCallback(this.graph.nodes, 'beforeQueued')），不是 override。
     以前这四件事只挂在导演台自己的「⟳ 重抽这一段」按钮上（renderAll 里），于是
     点画布上的运行按钮会被跳过：直接覆盖当前版本、不留快照。两个运行入口行为
     不一致，正是"不知道该点哪个"的根源。现在无论点哪个，入队前都自动做完，
     那个按钮也就完成了历史使命（20261020 已删）。 */
  const _qWidget = node.widgets?.find((w) => w.name === "h3_data");
  if (_qWidget) {
    ui.dataWidget = _qWidget;
    _qWidget.beforeQueued = () => {
      /* batchCount 循环里每批都调一次 —— 同一批次只做一次，否则堆一叠快照。 */
      const now = Date.now();
      if (now - (ui.__prepAt || 0) < 800) return;
      ui.__prepAt = now;
      const p = ui.proj ? ui.proj() : null;
      const i = p ? p.idx : -1;
      /* 只有已经渲染过（有 clip）的段才算「重抽」，才需要另存保留旧版 ——
         首次生成也存版本的话版本数会爆炸。 */
      if (ui.setSaveNewTake && p && p.shots[i] && p.shots[i].clip) ui.setSaveNewTake(true);
      if (ui.stash) ui.stash();
      /* syncCheck 只是把档案时长与面板改齐（20261013 定：以面板为准、不拦渲染）
         —— 异步跑掉即可，晚一拍不影响这次渲染结果。 */
      if (ui.syncCheck) void ui.syncCheck();
    };
  } else {
    console.warn("[H3 Studio] 找不到 h3_data widget —— 入队前自动准备（另存/"
      + "落档）挂不上。画布运行会直接覆盖当前版本，请用别的存档方式兜底。");
  }
  /* 构建版本标记。排障用：控制台（F12）里看不到这行 = 浏览器在跑缓存的旧
     脚本，改了什么都不会生效 —— 这类"改了没反应"先排除这一层再查别的。 */
  console.info("[H3 Studio] 导演台面板已构建 · build 20261013（中央工程状态层 B+C："
    + "权威令牌 phase + 写穿透集中防抖 + 提交前 flush，画布/素材/段词全链路对齐）");
  /* 公开 bag = 内部完整 ui（20261013 根因修复）。原来这里 return 一个**精简
     对象**（只有 18 个字段），带来两个根因问题：
       1. st 是 buildUI 时的**值快照**（st: ui.st），而内部 load 会
          `ui.st = parseInitial(raw)` 整体替换内部 st —— 外部 node.h3ui.st 永远
          停在旧引用（新建时的 1344 默认态），切换工程后画布尺寸/比例/chain 全
          显示旧值；
       2. 历史切换 / 三节点联动需要的 stash/commit/paintSegTools/
          broadcastSeg/restoreShotRack/busy/lanesFlash/uid 全部没暴露，被
          `&&` 静默跳过 —— 当前段没收口、联动广播没发。
     现在直接返回内部 ui（st 始终是同一个字段，load 替换后也天然最新），只把原
     精简对象上**额外定制**的几个方法（destroy / state / pickedClip /
     refreshMonitor / pasteFile / save）补挂到 ui 上。 */
  Object.assign(ui, {
    refreshMonitor() { try { ui.monitor.refresh(); } catch { /* 面板已销毁 */ } },
    /* Core's route, used when the node is selected but the pointer is not over
       the panel. No hovered slot, so it routes like a loose drop. */
    pasteFile(file) { ui.takePaste(file, null); },
    save() { return JSON.stringify(ui.st); },
    destroy() {
      window.removeEventListener("focus", ui.onWinFocus, true);
      api.removeEventListener("executed", ui.onExecuted);
      api.removeEventListener("executing", ui.onExecuting);
      /* 内置逐帧预览：热重建 rebuildCastUI 会先 destroy 再 buildUI，
         不注销会重复订阅；Blob URL 也要一并回收。 */
      if (ui.onH3Preview) api.removeEventListener("minimax_h3_preview_override", ui.onH3Preview);
      try { ui.clearLive?.(); } catch { /* 已清理 */ }
      /* 渲染浮层 20261013 起挂在 document.body 上，不随节点 DOM 一起消失，
         节点删除/重建时必须在这里显式摘掉，否则会残留一张死遮罩。 */
      try {
        if (ui.runBox) {
          ui.runBox._stopFollow?.();
          ui.runBox.remove();
          ui.runBox = null;
        }
      } catch { /* 已清理 */ }
      /* 观察者轮询 / 司机心跳也要一起停：它们是挂在 window 上的计时器，
         节点没了还在跑，会去写一个已经没有主人的进度存档。 */
      try { ui.stopRunWatch?.(); } catch { /* 已清理 */ }
      try { ui.monitor.destroy(); } catch { /* 已经不在 DOM 里了 */ }
      ui.widthObserver?.disconnect();
      ui.narrowObserver?.disconnect();
      ui.rackPollTeardown?.();
      clearInterval(ui.rackPoll);
      /* a window listener per node instance would outlive the node */
      window.removeEventListener("paste", ui.onPaste, true);
      /* 20261026 撤销功能整体删除：原来这里还要摘 monitor.js 挂在 window /
         document 上的 Ctrl+Alt+Z 那组监听，现在那些监听已不存在了。 */
    },
  });
  Object.defineProperty(ui, "pickedClip", {
    get() { return ui.lastPickedClip; }, configurable: true,
  });
  Object.defineProperty(ui, "state", {
    get() { return ui.st; }, configurable: true,
  });
  return ui;
}

/* 端口中文标签（模块级，供多个生命周期钩子复用）。
 * 为什么不能只在 onNodeCreated 钉一次：从已存工作流恢复时，configure() 会按
 * 节点定义/存档重建 slot 对象，新对象不带我们钉过的 label，端口就回退成裸
 * 英文 —— 后加的口（h3_override）必现，旧口偶发。.label 在绘制时优先于
 * name/localized_name，所以在 onNodeCreated / onConfigure /
 * onConnectionsChange 三个时机各钉一遍（configure 后再 rAF+300ms 补钉）。 */
function pinCastPortLabels(node) {
  const pin = (slot) => {
    if (!slot) return;
    const key = (slot.name || slot.localized_name || "").toLowerCase().replace(/[\s_]+/g, "");
    /* 模型输入 / 输出统一中文「模型」，不带任何前缀后缀（20261106 用户定）。 */
    if (key === "model" || key === "模型") slot.label = "模型";
    else if (key === "clip" || key === "剪辑") slot.label = "CLIP";
    else if (key === "vae" || key === "变分自编码器") slot.label = "视频VAE";
    /* 音频 VAE：参考音频走独立的音频编码器，与上面「视频VAE」不是同一个
       模型（minimax_h3_audio_vae_fp32）。不改写的话端口上就是裸的
       "audio_vae"，跟视频 VAE 混在一起，接错线的概率极高。 */
    else if (key === "audiovae") slot.label = "音频VAE";
    else if (key === "lastframe" || key === "末帧") slot.label = "尾帧";
    else if (key === "firstframe" || key === "首帧") slot.label = "首帧";
    else if (key === "refs") slot.label = "参考素材";
    else if (key === "prompttext" || key === "prompt_text" || key === "外接提示词") slot.label = "外接提示词";
    /* AI 制片中枢 P1：外接导演台配置口。接线即用外部 JSON 整体覆盖面板
       配置（画布/片长/续接/合订词），断线恢复面板；平时悬空即可。 */
    else if (key === "h3override") slot.label = "🎛️ 外接导演配置";
    else if (key === "帧数") slot.label = "总帧数";
    /* 整片（VIDEO）成品口：直连视频合并节点的「🎬 视频文件」。 */
    else if (key === "整片" || key === "wholefilm" || key === "whole_film") slot.label = "🎬 整片";
  };
  for (const inp of node.inputs || []) pin(inp);
  for (const out of node.outputs || []) pin(out);
}

/* ============================================================ register */

app.registerExtension({
  name: "cglide.glidecast",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== NODE_ID) return;
    injectCSS();

    /* 工作流存盘时，properties.gcast_project.shots[].clip 同样不许落盘。
       ComfyUI 把 node.properties 全量写进 .json（实测桌面 H3三采_空模板.json
       里就存着 clip_0001），不剔除就等于把「上一个工程的段编号」分发给所有人。
       只改序列化副本，绝不碰 this.properties —— 运行时 30 个模块都读它；
       打开时由 bz_project_sync.hydrateFromStore 按 shot_uid 从档案回填。 */
    const origSerialize = nodeType.prototype.serialize;
    nodeType.prototype.serialize = function () {
      const d = origSerialize.apply(this, arguments);
      const p = d && d.properties && d.properties.gcast_project;
      if (p && Array.isArray(p.shots)) {
        d.properties = {
          ...d.properties,
          gcast_project: {
            ...p,
            shots: p.shots.map((s) => {
              if (!s || typeof s !== "object") return s;
              const c = { ...s };
              delete c.clip;
              return c;
            }),
          },
        };
      }
      return d;
    };

    const onCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = onCreated?.apply(this, arguments);

      /* Port labels. The framework localizes common keys (clip -> 剪辑, vae ->
       * 变分自编码器, last_frame -> 末帧), so we pin our own names. Slots expose
       * the raw key in `.name` and the localized text in `.localized_name`.
       * `.label` wins at draw time, so setting it is enough; match either form.
       * 恢复存档后的重钉见下方 onConfigure（configure 会重建 slot 对象）。 */
      pinCastPortLabels(this);

      const data = this.widgets?.find((w) => w.name === "h3_data");
      if (data) {
        /* Hiding a widget has changed convention across frontend versions, so
         * set every mechanism that has ever been honoured:
         *   v1  - computeSize returning zero height
         *   v2  - widget.hidden / computeLayoutSize (it does NOT understand a
         *         fake "hidden" type, which it draws as a plain text row).
         * Never touch .type: an unknown type (e.g. "converted-widget") is not
         * understood by the current frontend and breaks value restore on
         * reload, which clears the saved prompt. */
        data.origType = data.origType || data.type;
        data.origComputeSize = data.computeSize;
        data.hidden = true;
        data.options = Object.assign({}, data.options, { hidden: true });
        data.computeSize = () => [0, -4];
        data.computeLayoutSize = () => ({ minHeight: 0, maxHeight: 0, minWidth: 0 });
        data.label = "";
        data.tooltip = "";
        /* 存盘再兜一层：有的路径直接改 data.value 而不经过 commit()，
           序列化时统一抹掉 chain.clip，工作流 .json 里永不出现它。 */
        data.serializeValue = () => {
          try {
            const o = JSON.parse(data.value || "{}");
            if (o && typeof o === "object" && o.chain) o.chain.clip = "";
            return JSON.stringify(o);
          } catch (_) { return data.value || "{}"; }
        };
        if (data.element) {
          Object.assign(data.element.style, {
            display: "none", visibility: "hidden", pointerEvents: "none",
            position: "absolute", left: "-99999px", top: "0",
            width: "0px", height: "0px", opacity: "0", zIndex: "-1",
          });
          data.element.hidden = true;
          data.element.tabIndex = -1;
        }
      }

      const ui = buildUI(this);
      this.h3ui = ui;
      const uiWidget = this.addDOMWidget("h3_ui", "div", ui.root, { serialize: false, hideOnZoom: false });

      /* v2 sizes a DOM widget from computeLayoutSize. 手动拖拽模式：
         minHeight 报固定小值（前端拖拽以 node.computeSize()=各 widget minHeight
         之和做下限钳制，报内容实测峰值会让节点永远拖不到比内容更矮）。
         maxHeight 保持弹性（不设上限）：distributeSpace 只会把 freeWidgetSpace
         那么多空间分给 widget，widget 高度天然被 bodyHeight 封顶、填满节点，
         收短后内容靠 .gcast 滚动，不塌陷、不诱发放大。 */
      uiWidget.computeLayoutSize = () => {
        return { minHeight: MIN_FLOOR_H, maxHeight: void 0, minWidth: MIN_PANEL_W };
      };

      /* The widget's own wrapper is <div class="dom-widget">, sitting inside
       * .isolate inside #graph-canvas-container. ONLY the dom-widget div may be
       * made transparent -- going any higher reaches the canvas container and
       * freezes the entire graph. */
      requestAnimationFrame(() => {
        const wrap = ui.root.parentElement;
        if (wrap && wrap.classList.contains("dom-widget")) {
          wrap.style.pointerEvents = "none";
        }
        ui.observeWrapperWidth?.();
      });

      /* v2 wraps every DOM widget in a full-size .dom-widget div. Hiding the
       * inner element is not enough -- the wrapper stays, covers the node and
       * swallows every click. Hide the wrappers belonging to THIS node's other
       * widgets only; never touch shared containers. */
      const hideStrayWrappers = () => {
        const mine = ui.root.closest(".dom-widget");
        for (const w of this.widgets || []) {
          if (!w || w === uiWidget || !w.element) continue;
          const wrap = w.element.closest?.(".dom-widget");
          if (wrap && wrap !== mine) {
            wrap.style.display = "none";
            wrap.style.pointerEvents = "none";
          }
        }
      };
      requestAnimationFrame(hideStrayWrappers);
      setTimeout(hideStrayWrappers, 250);
      this.gcastTidy = hideStrayWrappers;

      ui.load(data ? data.value : "");

      this.size = [980, MIN_H_REF];
      this.setSize?.([980, MIN_H_REF]);
      /* 「这是不是新建的节点」用一个显式标记位，不再靠"计时器到点时 configure()
         跑没跑完"去猜——那是两个异步事件在赛跑，加载慢的时候行为不确定。
         从已存数据恢复的节点一定会走 onConfigure，在那里把它置 false。 */
      this.gcastIsNew = true;
      /* 前端 bag 版本标记（热重载自愈巡检识别用）。 */
      this.BZ_BAG_VERSION = BZ_BAG_VERSION;
      /* 手动拖拽：只有「新建」的节点才做一次默认高度校正 —— 从 MIN_H_REF 这个
         固定初值改成"适配画布视口"，让整块面板一次看得见。 */
      this.gcastFitTimer = setTimeout(() => {
        this.gcastFitTimer = null;
        if (!this.gcastIsNew) return;
        /* configure() 已经跑完（它晚于 onNodeCreated），属性是真的了 —— 这时才
           能判断这条片子到底有没有名字，没有就补一个默认的。 */
        this.h3ui?.ensureProjectName?.();
        void this.h3ui?.ensureFirstShot?.();
        this.h3ui?.fitToViewport?.();
      }, 80);
      /* 工程库启动灌库 + 热重载自愈巡检。新工程此时库里还没数据，hydrate 会
         静默跳过；媒体架/文案台若晚于导演台拖入，hydrate 内部会等待就绪。 */
      setTimeout(() => { hydrateFromStore(this); startSelfHeal(this); }, 500);
      return r;
    };

    /* ComfyUI's document paste handler calls pasteFile() on the current node
     * when the clipboard holds an image, and spawns a LoadImage node when no
     * node answers. Answering here keeps the paste inside the panel. The
     * hover-based listener in buildUI covers the commoner case where the node
     * is under the pointer but was never selected. */
    nodeType.prototype.pasteFile = function (file) {
      if (!this.h3ui?.pasteFile) return false;
      this.h3ui.pasteFile(file);
      return true;               /* truthy: core treats the paste as handled */
    };

    const onRemoved = nodeType.prototype.onRemoved;
    nodeType.prototype.onRemoved = function () {
      stopSelfHeal(this);
      this.h3ui?.destroy?.();
      return onRemoved?.apply(this, arguments);
    };

    /* 排队前自检。ComfyUI 在每次入队前调用节点上的 onBeforeQueued，返回真值即
       中止；这里挂上，手动点「运行」与「渲染全部」两条路都会被拦到（原本只有
       渲染全部里有一段检查，手动排队直接把异常甩给后端）。
       只查「接线缺失」这类纯前端可见、后端必炸的情况，不重复后端能自己报的错。 */
    const onBeforeQueued = nodeType.prototype.onBeforeQueued;
    nodeType.prototype.onBeforeQueued = function () {
      const r = onBeforeQueued?.apply(this, arguments);
      if (r) return r;
      const bad = this.h3ui?.audioVaeMissing?.();
      if (!bad) return;
      /* 不弹窗：改在面板时间轴下方那条提示区里说清缺什么、怎么补（非阻塞）。 */
      this.h3ui?.lanesFlash?.(
        "缺少音频 VAE —— " + bad.why + "，但导演台的「audio_vae」输入口没有接线。"
        + "请加载 minimax_h3_audio_vae_fp32 接到 audio_vae 口，"
        + "或去掉音频引用 / 取消视频槽位的音轨勾选。");
      return true;
    };

    const onConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function (info) {
      const r = onConfigure?.apply(this, arguments);
      /* configure 会按存档/节点定义重建 slot，钉过的中文 label 会丢，这里
         重钉一遍；inputs 可能在 rAF 后才规范化完成，再补两档（同连线恢复节奏）。 */
      pinCastPortLabels(this);
      requestAnimationFrame(() => pinCastPortLabels(this));
      setTimeout(() => pinCastPortLabels(this), 300);
      const data = this.widgets?.find((w) => w.name === "h3_data");
      if (this.h3ui && data) this.h3ui.load(data.value);
      /* configure 已恢复 first_frame / last_frame 连线：让面板槽镜像端口图。
         rAF + 300ms 两档，等 graph.links 完全就位。 */
      if (this.h3ui) {
        requestAnimationFrame(() => this.h3ui.syncPortFrames?.());
        setTimeout(() => this.h3ui.syncPortFrames?.(), 300);
      }
      if (this.gcastTidy) setTimeout(this.gcastTidy, 60);
      /* 高度归用户所有。本节点来自已存数据，configure() 已经还原了 node.size，
         这里不得再动它——历史上这里会 ui.fitNode(true) 把高度压回内容高度，那正是
         「每次刷新都缩回一个固定高度」的根因：它把用户手动拖出的高度当成了需要
         纠正的旧尺寸。同时打断创建时那个还没到点的自适应计时器，否则它会在
         configure() 之后到点、把用户的高度再覆盖一次。 */
      /* 走到这里 = 本节点来自已存数据：显式置位，让上面那个计时器不再自适应。
         高度归用户所有，configure() 已经还原了 node.size。 */
      this.gcastIsNew = false;
      if (this.gcastFitTimer) {
        clearTimeout(this.gcastFitTimer);
        this.gcastFitTimer = null;
      }
      /* 读档也走一次默认高度：老工程的高度是 700 那个初值时代存下的，而面板内容
         早就比它高 —— 不校正就得往下滚才能看到底部。有 gcast_h（用户手拖过）时
         fitToViewport 会原样听用户的，不会把拖小的节点再撑开。
         两档时机：读档瞬间 node.pos / 画布 offset 可能还没就位，量出来不准。 */
      if (this.h3ui) {
        requestAnimationFrame(() => this.h3ui?.fitToViewport?.());
        setTimeout(() => this.h3ui?.fitToViewport?.(), 300);
      }
      /* 读档后从 SQLite 工程库灌库（库为权威；老工程 backend=json 静默跳过），
         并启动热重载自愈。600ms 等三节点 widget/gmr 就位，hydrate 内部还有
         就绪等待，双重保险。 */
      this.BZ_BAG_VERSION = BZ_BAG_VERSION;
      const boot = () => {
        try { hydrateFromStore(this); startSelfHeal(this); } catch (_) {}
        /* 保底一段：读档 / 拖入视频 / 打开空工程都从 boot 过。
           守卫只在缺段或缺登记时动手，已有段且档案齐全一行不动。 */
        void this.h3ui?.ensureFirstShot?.();
        /* 撤销（Ctrl+Z）也走 onConfigure：properties 里的工程镜像会回到
           删段之前（幽灵段绑着已不存在的 clip id），而档案条目与磁盘文件
           删了就是删了 —— 撤销不会把它们变回来。轴上"两段之间空出一段
           幽灵宽度"就是这么来的（F5 才自愈 = 载入路径有对账、撤销路径没有）。
           这里补一次 monitor.refresh：段身份对账（reconcileSegmentIdentity）+
           film_summary 重拉全在它里面，让撤销和 F5 走同一套账（20261104）。
           refresh 自带 0.8s 结果缓存，正常载入多调这一次不心疼；失败静默 ——
           3 秒轮询自愈还兜着。 */
        /* 档案拉回来之后再跑一次守卫：第一次调用时 clipCount 还是 -1，
           「工程有段、档案没登记」这条洞判不出来。挂在 refresh 的 Promise 上，
           只跑这一次低频时机，不进 render / 画段回调（20261108 按钮点不动的教训）。 */
        try {
          const r = this.h3ui?.monitor?.refresh?.();
          if (r && typeof r.then === "function") {
            r.then(() => void this.h3ui?.ensureFirstShot?.()).catch(() => {});
          }
        } catch (_) {}
      };
      /* 视频还原出来的这一页要先换成独立片名，再让工程库回灌：否则库按旧
         片名把现场盖成「现在的值」，而且这一页的写回会污染原工程。改名是
         异步的，所以把 boot 延后到它完成，不是靠抢时间窗。 */
      const dropped = consumeVideoDrop();
      if (dropped && typeof this.h3ui?.restoreVideoAsNewProject === "function") {
        let task = null;
        try { task = this.h3ui.restoreVideoAsNewProject(dropped); }
        catch (e) { console.warn("[H3 Studio] 视频现场还原失败", e); }
        if (task && typeof task.then === "function") task.then(boot, boot);
        else boot();
      } else {
        setTimeout(boot, 600);
      }
      return r;
    };

    /* 首帧 / 尾帧端口连线 / 拆线：让面板槽镜像端口图。在原型上重写 —— 实例级
       覆盖在本前端版本不被稳定调用；通过 h3ui 进面板。side 用 LiteGraph 常量：
       INPUT = 1（不是 0），OUTPUT = 2。 */
    const onConnChange = nodeType.prototype.onConnectionsChange;
    nodeType.prototype.onConnectionsChange = function (side, ...rest) {
      const r = onConnChange?.apply(this, arguments);
      /* 框架在 widget↔端口转换 / 连线恢复时可能换 slot 对象，换完即重钉。 */
      pinCastPortLabels(this);
      if (side === 1 && this.h3ui)
        requestAnimationFrame(() => this.h3ui.syncPortFrames?.());
      return r;
    };

    const onResize = nodeType.prototype.onResize;
    nodeType.prototype.onResize = function (size) {
      if (size[0] < MIN_PANEL_W) size[0] = MIN_PANEL_W;
      /* 手动拖拽：高度下限由 computeLayoutSize 的 minHeight 报给 computeSize()，
         这里不再额外钳制；宽度容器随拖拽同步一次。 */
      this.h3ui?.reconcileWrapperWidth?.();
      /* 用户亲手拖边角 = 高度真值，记进 properties（读档 / Alt 复制都带得过来）。
         程序自发的 setSize（新建时适配视口、监视器换档）不记，否则"默认适配窗口"
         会被自己刚写下的高度反锁成固定值。
         这里**只记录、不改尺寸**：曾经加过一条"发现尺寸与真值不符就 setSize 拉回"
         的防覆盖逻辑，结果只要判据一失准（resizing_node 在某些路径下不是本节点），
         每帧都把用户拖出来的尺寸拽回去，节点高度就彻底拖不动了。宁可松手后被框架
         覆盖一次，也不能让拖拽本身失效。 */
      try {
        const cv = globalThis.app?.canvas;
        if (cv && cv.resizing_node === this) {
          this.properties = this.properties || {};
          this.properties.gcast_h = Math.round(size[1]);
        }
      } catch (_) { /* 记不住就记不住，尺寸本身照常生效 */ }
      return onResize?.apply(this, arguments);
    };
  },
});

/* ============================================================
 * 热重建（HMR 在线升级）—— 与 csglide_media_rack.rebuildMediaRackUI 同构。
 * 热替换只重跑模块、不重跑 onNodeCreated，已存在导演台的 h3ui 永远停在
 * 热重载前的旧闭包（stash/restoreShotRack 等修过的行为都不会生效，
 * 串段修复白改）。自愈巡检检测到旧 h3ui 后调本函数：销毁旧 bag 与旧
 * DOM、按当前代码重建并挂回节点，h3_data 原样保留，工程不丢。
 * 失败回退 false（调用方保留旧 h3ui）。
 * ============================================================ */
export function rebuildCastUI(node) {
  if (!node || !node.widgets) return false;
  if (node.h3ui && node.h3ui.BAG_VERSION === BZ_BAG_VERSION) return true;
  try {
    /* 停掉旧 bag 的事件监听 / 轮询 / 计时器（destroy 由 installListeners 等挂载）。 */
    try { node.h3ui?.destroy?.(); } catch (_) {}
    if (node.gcastFitTimer) { clearTimeout(node.gcastFitTimer); node.gcastFitTimer = null; }

    const oldUiWidget = node.widgets.find((w) => w.name === "h3_ui");
    if (oldUiWidget) {
      try {
        if (typeof node.removeDOMWidget === "function") {
          node.removeDOMWidget(oldUiWidget);
        } else {
          const i = node.widgets.indexOf(oldUiWidget);
          if (i >= 0) node.widgets.splice(i, 1);
          oldUiWidget.element?.remove?.();
        }
      } catch (_) {}
    }
    try {
      const roots = node.domEl?.querySelectorAll ? node.domEl.querySelectorAll(".gcast") : [];
      roots.forEach((r) => {
        if (r.parentElement && r.parentElement.classList.contains("comfyui-dom-widget")) {
          r.parentElement.remove();
        }
      });
    } catch (_) {}

    const data = node.widgets.find((w) => w.name === "h3_data");
    const ui = buildUI(node);
    node.h3ui = ui;
    const uiWidget = node.addDOMWidget("h3_ui", "div", ui.root, { serialize: false, hideOnZoom: false });
    uiWidget.computeLayoutSize = () => ({
      minHeight: MIN_FLOOR_H, maxHeight: void 0, minWidth: MIN_PANEL_W,
    });

    requestAnimationFrame(() => {
      const wrap = ui.root.parentElement;
      if (wrap && wrap.classList.contains("dom-widget")) wrap.style.pointerEvents = "none";
      ui.observeWrapperWidth?.();
    });
    /* 与 onNodeCreated 同一份 wrapper 收整逻辑（重建后旧闭包挂的 gcastTidy
       已随旧 DOM 失效，重新挂一份）。 */
    const hideStrayWrappers = () => {
      const mine = ui.root.closest(".dom-widget");
      for (const w of node.widgets || []) {
        if (!w || w === uiWidget || !w.element) continue;
        const wrap = w.element.closest?.(".dom-widget");
        if (wrap && wrap !== mine) {
          wrap.style.display = "none";
          wrap.style.pointerEvents = "none";
        }
      }
    };
    requestAnimationFrame(hideStrayWrappers);
    setTimeout(hideStrayWrappers, 250);
    node.gcastTidy = hideStrayWrappers;

    ui.load(data ? data.value : "");
    /* 重建 = 节点已存在，高度归用户，不当成"新建节点"做内容自适应。 */
    node.gcastIsNew = false;
    node.BZ_BAG_VERSION = BZ_BAG_VERSION;
    /* 连线/端口镜像补两档（configure 流程在重建时不会重跑）。 */
    pinCastPortLabels(node);
    requestAnimationFrame(() => { ui.syncPortFrames?.(); });
    setTimeout(() => { ui.syncPortFrames?.(); }, 300);
    node.setDirtyCanvas?.(true, true);
    console.log("[H3 Studio] 导演台节点已在线热重建（旧 h3ui 升级为当前版本）node=" + node.id);
    return true;
  } catch (e) {
    console.warn("[H3 Studio] 导演台热重建失败(保留旧界面):", e);
    return false;
  }
}
