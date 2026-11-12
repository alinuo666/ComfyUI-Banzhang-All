import { api } from "../../scripts/api.js";
import { MAX_NODE_H, parseInitial } from "./csglide_cast_core.js";

/* ============================================================
 * 粘贴落槽 与 面板自适应（含窄档上下堆叠）
 * ------------------------------------------------------------
 * 从 csglide_cast.js 的 buildUI 里整块搬出来。
 *
 * 跨块的东西一律走 ui.<名>：ui 是 buildUI 建的那一个共享 bag。可变状态
 * 在它上面只有一个字段，所以本文件与别的模块改的是同一份。
 * 本块自己声明的东西保持裸名（函数声明要靠提升），末尾统一挂到 ui 上，
 * 顺序与原来在 buildUI 里的先后一致 —— 搬出去之后，谁先声明谁后声明没变。
 * ============================================================ */

export function installPaste(ui) {
  /* ---------------------------------------------------------------- paste
   * Ctrl+V, the same way a stock LoadImage node takes it.
   *
   * ComfyUI's own paste handler looks for pasteFile() on the CURRENT node and,
   * finding none, drops a fresh LoadImage node on the graph -- the same escape
   * the drop handler above closes. Two entries, deliberately non-overlapping:
   *
   *   pointer over the panel   -> this listener takes it, hovered slot wins
   *   node selected, pointer elsewhere -> core calls pasteFile() (see register)
   *
   * It listens in the CAPTURE phase on window so it runs before core's
   * document-level handler, and only stops propagation when it actually
   * consumes the paste. Hover is the signal rather than selection because
   * pressing the panel background does not select the node (the pointerdown
   * re-dispatch to the canvas was removed) -- so "click a slot, hit Ctrl+V"
   * would otherwise paste into nothing.
   */
  ui.overPanel = false;
  ui.hoverEl = null;
  /* pointerenter/leave do not bubble, so these describe the panel itself */
  ui.root.addEventListener("pointerenter", () => { ui.overPanel = true; });
  ui.root.addEventListener("pointerleave", () => { ui.overPanel = false; ui.hoverEl = null; });
  /* pointerover DOES bubble: fires for every descendant, so hoverEl clears
     itself as soon as the pointer moves off a slot onto plain panel */
  ui.root.addEventListener("pointerover", (e) => {
    ui.hoverEl = e.target?.closest?.("[data-kind]") || null;
  });

  /* A clipboard image has no useful name -- Chrome calls every one of them
   * image.png. Stamping it keeps successive pastes apart in input/cglide/
   * instead of leaning on the server's (1)(2) suffixing. */
  function nameForPaste(file) {
    const mime = file.type || "image/png";
    const ext = (mime.split("/")[1] || "png").split("+")[0].replace("jpeg", "jpg");
    return `pasted-${Date.now()}.${ext}`;
  }

  /* Paste has no pointer trail, so without a flash there is no telling which
     of nine slots took the image. Reuses the drop look. */
  function flashTarget(node_) {
    if (!node_) return;
    node_.classList.add("drop");
    setTimeout(() => node_.classList.remove("drop"), 260);
  }

  async function takePaste(file, target) {
    if (!file) return;
    const kind = ui.fileKind(file) || "image";
    const named = new File([file], nameForPaste(file), { type: file.type || "image/png" });
    const slot = target && ui.root.contains(target) ? target.__gcastSlot : null;
    if (slot) {
      if (target.dataset.kind !== kind) { ui.flashWrong(target); return; }
      flashTarget(target);
      await ui.assign(slot, named, kind, target.__gcastToken || null);
      return;
    }
    /* 参考素材槽位已外迁媒体架：未落在槽位上的粘贴一律拒绝 */
    ui.flashPanel();
  }

  const onPaste = (e) => {
    const cd = e.clipboardData;
    if (!cd) return;
    const file = Array.from(cd.files || [])[0]
      || Array.from(cd.items || [])
           .filter((i) => i.kind === "file")
           .map((i) => i.getAsFile())
           .find(Boolean);
    if (!file) return;
    const tgt = e.target;
    const editing = !!tgt && (tgt.tagName === "TEXTAREA" || tgt.tagName === "INPUT");
    /* Typing in the prompt: anything carrying text is a text paste, always.
       A screenshot with no text beside it still belongs in a slot. */
    if (editing && Array.from(cd.types || []).includes("text/plain")) return;
    const over = ui.hoverEl && ui.root.contains(ui.hoverEl) ? ui.hoverEl : null;
    const mine = ui.overPanel || over || (editing && ui.root.contains(tgt));
    if (!mine) return;                  /* not ours: core, or pasteFile below */
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation?.();
    takePaste(file, over);
  };
  window.addEventListener("paste", onPaste, true);

  function load(raw) {
    /* 记住上一次的片名：载入后若片名变了，监视器必须重拉一次。
       刷新页面后 onConfigure 会用存档里的名字再 load 一遍 —— 而监视器创建时
       排的那一次 requestAnimationFrame(refresh) 很可能已经先跑掉了（那一刻
       h3_data 还没恢复，片名是空的），于是轴上就停在"还没登记过片子"，再没人
       喊它重刷。这正是"刷新后时间轴和监视器一直空白"的根因。
       片名变了 = 换了一部片子（新建 / 载入 / 改名），重拉是必须的；而普通的
       切段（switchTo 也会走到 load）名字不变，就不会多拉一次 —— 那种情况让
       轴上已有的段块原样复用即可，否则每切一段都整条轴重新抽缩略图，又回到
       "一动就假死"的老毛病。 */
    const prevName = (ui.st && ui.st.chain && ui.st.chain.name) || "";
    ui.st = parseInitial(raw);
    /* 存档里存的是**剧本原文**（st.prompt），绝不预先展开别名。别名只在
       effPrompt() 送模型那一刻展开 —— 曾经有一版把展开后的文本回写进
       ui.st.prompt，于是「@图片3 中的陈九一」一刷新就变成「@图片3 中的@图片3」，
       而且这份展开文本会随工作流落盘，名字永久丢失，连重开都救不回来。
       面板上现在没有编辑器，这条规矩也就不用再靠"显示层"来守：ui.st.prompt 是
       唯一一份原文，谁都不许改写它。 */
    ui.ensureProjectName();
    ui.render();
    if ((ui.st.chain.name || "") !== prevName) {
      requestAnimationFrame(() => {
        try { if (ui.monitor) ui.monitor.refresh(); } catch { /* 已销毁 */ }
      });
    }
  }

  /* Measure the panel's NATURAL content height. .gcast is height:100% +
     纵向可滚动（见 csglide_cast.css.js 里 scrollbar-gutter 那段），滚动容器下
     flex 子元素会按矮节点收缩、scrollHeight 因此报的是收缩后的高度 ——
     真实内容高度只有在 height:auto 撤掉上限后才量得到。
     提示词编辑区删掉之前，它是唯一必须冻住的子元素（flex:1，在 height:auto 下
     会涨到全文长度，正是"节点无限变长"那个 bug），测量前要先钉住它。现在面板
     上没有可自由增长的文本块了，直接量就是。 */
  function naturalPanelHeight() {
    const prevH = ui.root.style.height;
    ui.root.style.height = "auto";
    try {
      const h = ui.root.offsetHeight || ui.root.scrollHeight || 0;
      return Math.min(MAX_NODE_H, h);
    } finally {
      ui.root.style.height = prevH;
    }
  }

  /* 默认高度：适配画布视口（20261029 用户定）。
     节点刚拖出来 / 老工程里没有手拖记录时，高度按"从节点顶到窗口底还剩多少屏幕
     像素"换算成节点坐标，让整块面板一次看得见 —— 而不是先给 MIN_H_REF=700 再让
     用户往下滚。底部留 24px 是给节点下边框留的抓手：贴着窗口底边的话，用户想再
     拖高都抓不到边。 */
  function viewportFitHeight() {
    try {
      const cvEl = globalThis.app?.canvas?.canvas;         /* 画布 <canvas>，屏幕坐标 */
      const rect = ui.root.getBoundingClientRect();
      const cvRect = cvEl?.getBoundingClientRect?.();
      if (!cvRect || !rect.height || !cvRect.height) return 0;
      /* 全部在屏幕坐标系里量，不碰 litegraph 的 offset/scale 换算（那套加号还是
         减号历史上错过一次）。缩放比用「屏幕高 / 布局高」实测反推，画布缩放
         （Ctrl+滚轮）时同样成立。 */
      const scale = rect.height / (ui.root.offsetHeight || rect.height);
      const availPx = cvRect.bottom - Math.max(cvRect.top, rect.top) - 24;
      /* 节点高 − 面板布局高 = 标题栏 + widget 边距，是个固定差值，补回去才是
         该设的 node.size[1]。 */
      const chrome = Math.max(0, Math.round(
        (ui.node.size?.[1] || 0) - (ui.root.offsetHeight || 0)));
      return Math.max(0, Math.round(availPx / scale) + chrome);
    } catch (_) { return 0; }
  }

  /* 有 properties.gcast_h（用户亲手拖过的高度）就完全听用户的 —— 适配只负责
     "没有用户意见时给一个合理默认"，不推翻既有规则：高度归用户所有。
     没有手拖记录时**内容优先、视口封顶**（20261031 用户定，替代原"一律顶到
     窗口底"）：默认高 = min(内容自然高度, 视口可用高度)。原先只看视口的副作用
     是"新建节点底部一大片空白"——节点拖在画布偏上位置/屏幕越高，空白越长；
     内容矮节点就矮，内容真高才顶到窗口底，空白底从机制上消失。 */
  function fitToViewport() {
    try {
      if (ui.node.flags?.collapsed) return;
      const userH = Math.round(Number(ui.node.properties?.gcast_h) || 0);
      let want;
      if (userH > 0) {
        want = userH;
      } else {
        const vp = viewportFitHeight();
        if (!(vp > 0)) return;
        const nat = naturalPanelHeight();
        want = Math.min(MAX_NODE_H, vp, nat > 0 ? nat : vp);
      }
      if (!(want > 0)) return;
      const w = (ui.node.size && ui.node.size[0]) || 980;
      if (Math.abs(want - ((ui.node.size && ui.node.size[1]) || 0)) < 2) return;
      ui.node.setSize?.([w, want]);
      ui.node.setDirtyCanvas?.(true, true);
      try { ui.node.graph?.setDirtyCanvas?.(true, true); } catch (_) {}
      requestAnimationFrame(reconcileWrapperWidth);
    } catch (_) { /* 尺寸是外观，不能因为它把面板搞挂 */ }
  }

  /* 手动拖拽模式：fitNode 只在「新建」节点时调用一次，把 MIN_H_REF 这个固定初值
     校正到内容真实高度（含缩掉初值留下的留白）。加载已有工作流时不调用——那时
     node.size 是用户存下来的高度，以它为准（见注册段 onConfigure）。之后不再随
     内容变化自动改高。报给框架的 minHeight（见注册段 computeLayoutSize）是固定小
     值，避免 computeSize() 的下限被内容实测峰值顶住，让拖拽能自由收短。 */
  /* naturalPanelHeight() freezes the prompt at its minimum height while
     measuring, so auto-fit always sizes from the fixed chrome + one prompt
     row — the text length can never stretch the bottom to infinity. */
  function fitNode(shrink) {
    try {
      if (ui.node.flags?.collapsed) return;
      /* 任何一次 fit 后顺带校正容器宽度（rAF 内执行，度量的是排版后真值）。 */
      requestAnimationFrame(reconcileWrapperWidth);
      const HEAD = (typeof LiteGraph !== "undefined" && LiteGraph.NODE_TITLE_HEIGHT) || 30;
      const w = (ui.node.size && ui.node.size[0]) || 980;
      const h = (ui.node.size && ui.node.size[1]) || 0;
      const panelH = naturalPanelHeight();
      if (!panelH) return;
      const needH = Math.min(MAX_NODE_H, HEAD + 2 + panelH + 6);
      if (needH > h || (shrink && needH < h)) {
        ui.node.setSize?.([w, Math.ceil(needH)]);
        ui.node.setDirtyCanvas?.(true, true);
        try { ui.node.graph?.setDirtyCanvas?.(true, true); } catch (_) {}
      }
    } catch (e) { /* sizing is cosmetic; never break the panel for it */ }
  }

  /* React only to genuine CONTENT changes, never to the node being resized
     (a ResizeObserver here would fire when the user drags the node smaller and
     make fitNode snap it back). Content appears via child insert/remove, and
     images reveal their height only after decode, caught by a captured 'load'. */
  /* The frontend can clear a DOM widget's width while arranging widgets after
     a file picker closes. The widget lives in the graph's transformed layer,
     so its CSS width must remain in node coordinates, never screen coordinates. */
  ui.widthObserver = null;
  /* 宽度协调。历史背景：个别前端版本在文件对话框关闭后会清掉 DOM widget 的
     style.width，节点又活在变换层里，宽度一旦丢就塌掉——这个函数当初是兜底
     补写。
     但现在框架自己会写 wrapper 宽度（node.size − 2×widget margin，实测 -20），
     若这里无条件按自己的口径（node.size − 12）再写一遍，就会在「点击选中节点
     → 框架重排写 960」的瞬间被 ResizeObserver 触发，反过来写 968，形成几帧内
     960↔968 互相覆盖——面板左右颤一下的根因（已实测：一次点击产生 4 次交替
     写入）。
     修复：宽度正常时一律不碰，把宽度所有权完全交给框架；只有宽度缺失/被清
     （NaN/0/明显异常）时才兜底补写一次，兜底值也按框架口径（node.size − 20），
     两边一致则永远不会打架。 */
  function reconcileWrapperWidth() {
    try {
      if (ui.node.flags?.collapsed) return;
      const wrap = ui.root.closest?.(".dom-widget");
      if (!wrap || wrap.style.display === "none") return;
      const nodeW = (ui.node.size && ui.node.size[0]) || 980;
      /* 兜底值必须与框架口径逐像素一致（nodeW − 20），不再做 MIN_PANEL_W 钳制：
         钳制会在 nodeW 接近下限时与框架写值拉开 20px 差距，制造新的拉锯。最小
         宽度改由 computeLayoutSize 的 minWidth 负责（拖拽钳制），各司其职。 */
      const want = Math.round(nodeW - 20);
      if (!(want > 0)) return;
      const cur = parseFloat(wrap.style.width);
      /* 与框架一致（±8px 容差，吸收各版本 widget margin 差异）→ 一个字都不写。
         不能沿用旧判据「cur > nodeW*0.5 && cur <= nodeW+1」：那是个半开半闭的
         宽区间，节点被拉宽时旧宽度（如 600）依然落在 (490, 981] 内被判为「正
         常」而永不更新，wrapper 于是被永久锁死在拖动前的宽度上——节点变宽、面
         板宽度不跟随的真因。改成围绕目标值的窄容差才能真正跟上缩放。 */
      if (!Number.isNaN(cur) && Math.abs(cur - want) <= 8) return;
      /* 缺失/被清/异常：按框架口径兜底补写一次（与框架写值一致，不会引发拉锯） */
      const width = want + "px";
      if (wrap.style.width === width) return;
      wrap.style.width = width;
      if (wrap.style.minWidth) wrap.style.minWidth = "";
    } catch (_) { /* Sizing must never break the panel. */ }
  }

  function observeWrapperWidth() {
    const wrap = ui.root.closest?.(".dom-widget");
    if (!wrap || !window.ResizeObserver) return;
    ui.widthObserver?.disconnect();
    ui.widthObserver = new ResizeObserver(reconcileWrapperWidth);
    ui.widthObserver.observe(wrap);
    reconcileWrapperWidth();
  }

  /* ---- 窄档：双栏塌了就改上下堆叠 ----
     右栏定宽 540px、节点最小宽 560px，双栏在窄节点上会把成片监视器压到只剩
     十几像素——用户看到的是"监视器不见了"，而不是"它被挤扁了"。
     节点宽度不是视口宽度，媒体查询管不到，只能实测容器宽度后打 .narrow。 */
  const NARROW_W = 820;
  /* 退出窄档的阈值要比进入的高一截（迟滞），不能和进入共用 820。
     切档本身是**粗粒度**的布局变化：双栏 → 上下堆叠、右栏定宽取消、内层
     `.gcast-col` 的滚动条有无跟着变。这些又反过来改变 `ui.root.clientWidth`。
     单阈值时只要宽度压在 820 附近，就会「切档 → 宽度变 → 切回来 → 宽度变回去」
     每帧来回翻一次，表现就是面板在抖（与滚动条那条回路可以同时发生、
     互相加持）。两个阈值之间是「保持现状」的死区，回路断在这里。 */
  const NARROW_OUT = 880;
  ui.narrowObserver = null;
  function syncNarrow() {
    try {
      const w = ui.root.clientWidth || 0;
      if (!w) return;                 /* 未挂载/正在测量，别拿 0 去切档 */
      const isNarrow = ui.root.classList.contains("narrow");
      if (!isNarrow && w < NARROW_W) ui.root.classList.add("narrow");
      else if (isNarrow && w > NARROW_OUT) ui.root.classList.remove("narrow");
    } catch (_) { /* 尺寸是外观，不能因为它把面板搞挂 */ }
  }
  function observeNarrow() {
    if (!window.ResizeObserver) return;
    ui.narrowObserver?.disconnect();
    ui.narrowObserver = new ResizeObserver(syncNarrow);
    ui.narrowObserver.observe(ui.root);
    syncNarrow();
  }
  requestAnimationFrame(observeNarrow);

  /* 20261029 曾在这里挂一个 MutationObserver，内容一增删就把节点高度 fit 回内容
     高度 —— 那是"面板不滚动、装不下即裁"年代的补偿。面板已改回可滚动（见
     csglide_cast.css.js 里 scrollbar-gutter 那段），溢出的内容随时能滚到，
     这个 observer 只会起反作用：它把用户亲手拖高的高度在下次切段 / 重绘时缩回
     内容高度，等于和"高度归用户所有"打架。故整段撤除，高度只在新建与监视器换档
     这两个真正改变内容体量的时机 fit。 */

  /* 窗口聚焦（文件对话框关闭、Alt-Tab 切回）会触发框架重新排列 widget，
     个别前端版本在这一轮不写容器宽度——这正是"加载素材后窗口缩成一团"
     的触发时机。聚焦后统一校正一次。 */
  const onWinFocus = () => {
    requestAnimationFrame(reconcileWrapperWidth);
    setTimeout(reconcileWrapperWidth, 120);
  };
  window.addEventListener("focus", onWinFocus, true);

  /* 跑完一轮就刷新监视器：导演台登记了新段、续接合成又把成片写进档案，
     面板不该等用户手点刷新才看得到。
     两处钩子各有分工：本节点跑完说明段落变了；executing=null 是一整轮结束，
     此时续接合成才刚把成片登记进档案（它排在本节点后面）。 */
  const onExecuted = (e) => {
    /* 20261107 修：曾在这里按 ui.run 提前返回，想保护逐帧预览，
       但它把时间轴 / 接缝胶囊唯一的刷新入口也一起停了 —— st.film 不更新，
       clipById 查不到段，点续接胶囊就静默无反应。逐帧预览是独立 img 层，
       refresh 清不到它（万一被清，onH3Preview 会自愈重挂）。恢复无条件刷新。 */
    if (e && e.detail && e.detail.node === ui.node.id) {
      setTimeout(() => { try { ui.monitor.refresh(); } catch { /* 已销毁 */ } }, 300);
    }
  };
  const onExecuting = (e) => {
    if (e && e.detail === null) {
      try { ui.clearLive?.(); } catch { /* 面板已销毁 */ }
      setTimeout(() => { try { ui.monitor.refresh(); } catch { /* 已销毁 */ } }, 600);
    }
  };
  api.addEventListener("executed", onExecuted);
  api.addEventListener("executing", onExecuting);


  /* 挂出去：别的块通过 ui.<名> 取。放在最后 —— 等同于原来在这一块
     结束时才声明完，之前的块拿不到，之后的块拿得到。 */
  Object.assign(ui, { nameForPaste, flashTarget, takePaste, onPaste, load, naturalPanelHeight, fitNode, viewportFitHeight, fitToViewport, reconcileWrapperWidth, observeWrapperWidth, NARROW_W, syncNarrow, observeNarrow, onWinFocus, onExecuted, onExecuting });
}
