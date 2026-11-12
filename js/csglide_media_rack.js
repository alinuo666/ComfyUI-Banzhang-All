/* ============================================================
 * H3 Media Rack — 🗂️ H3 媒体架 (H3 Media Rack)
 * ------------------------------------------------------------
 * 参考图片/视频/音频的独立素材节点。槽位编号即 @图片N / @视频N /
 * @音频N 的 N，与导演台面板同义且**永久绑定**：图片落在哪个格，
 * 那个编号就永远指它——本节点没有任何自动搬动图片的逻辑。
 *
 * 视觉与排版复用导演台面板同一份样式表（CAST_CSS）与同一套类名
 * （gcast-slot / gcast-media / gcast-thumb / gcast-cap …），
 * 两个节点的槽位因此完全一致，不会各自漂移。
 *
 * 输出 H3_REFS 接导演台的 refs 输入；接线槽位覆盖面板同编号素材，
 * 空槽位由面板兜底。一个媒体架可以喂多个导演台。素材仍走文件管道
 * （/upload/image → input/cglide/），导演台侧的修剪/抽帧/色度探针
 * 全部照常工作。
 *
 * ---- 本文件只做装配。各分区（顺序 = 依赖次序，不能调）----
 *   csglide_rack_core.js    常量 + 无状态工具（上传/探测/格式判定/网格）
 *   csglide_rack_css.js     媒体架专属样式与注入
 *   csglide_rack_alias.js   别名（文件名即角色名）全套
 *   csglide_rack_media.js   波形解码缓存 + 媒体元素复用
 *   csglide_rack_images.js  参考图片格
 *   csglide_rack_trim.js    修剪条（波形 + 双柄 + 播放 + 帧档）
 *   csglide_rack_cards.js   参考视频 / 参考音频卡片区
 *   csglide_rack_sort.js    按提示词排序
 *   csglide_rack_bar.js     面板条（本段指示 / 排序 / 帧率 / 音频号 / 清空）
 *   csglide_rack_drop.js    节点级拖入路由
 *   csglide_rack_seg.js     按分段记忆 + 存档读写 + 跟随导演台轮询
 * ============================================================ */
import { app } from "../../scripts/app.js";
import { el, MIN_W, MIN_H, NODE_ID, uploadAsset } from "./csglide_rack_core.js";
import { assetDirFor } from "./csglide_rack_asset.js";
import { injectRackCSS } from "./csglide_rack_css.js";
import { installImages } from "./csglide_rack_images.js";
import { installCards } from "./csglide_rack_cards.js";
import { installSort } from "./csglide_rack_sort.js";
import { installBar } from "./csglide_rack_bar.js";
import { installDrop } from "./csglide_rack_drop.js";
import { installSeg } from "./csglide_rack_seg.js";
import { installRefs } from "./csglide_rack_refs.js";
import { installVacate } from "./csglide_rack_vacate.js";
import { castProject, emitRackChange, BZ_BAG_VERSION } from "./bz_rack.js";

function buildUI(node) {
  /* 共享 bag：本文件与所有分区都通过它拿同一份东西。可变状态（ui.st）在两边
     都是同一个对象，不会各存一份。 */
  const ui = { node, app };
  ui.root = el("div", "gcast gmr");
  ui.st = {
    slots: { images: [], videos: [], audios: [] }, fps: 0, audio_out: 0,
    segs: {}, cur: "",
    /* 全片共用：true = 8 段同一副架面，切段不换素材（20261022） */
    shared: false,
  };
  let dataWidget = null;

  /* 瞬态提示。凡是「本该有反应却没有」的路径都要在这里发声：拖入被拒、
     上传失败、超限。toastEl 懒建（首次提示才插 DOM），3.6s 后自行淡出。 */
  let toastEl = null, toastTimer = 0;
  /* ms：可选的停留时长。「按提示词排序」这类诊断文本较长，3.6s 读不完，
     传 9000；不传仍按默认 3.6s。 */
  ui.toast = (msg, bad, ms) => {
    if (!toastEl) { toastEl = el("div", "gmr-toast"); ui.root.append(toastEl); }
    toastEl.textContent = msg;
    toastEl.classList.toggle("bad", !!bad);
    toastEl.classList.add("on");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove("on"), ms > 0 ? ms : 3600);
  };

  /* 同名但内容不同时问用户（20261112 根因修复）：替换现有 / 作为新素材 / 取消。
     复用导演台冲突清单同一套 gcast-modal 样式（injectRackCSS 已注入 CAST_CSS，
     媒体架单独在画布上也有样式）。默认焦点给「作为新素材」这个安全项 ——
     替换会顶掉旧图，不能让用户一不留神回车就丢图。 */
  function askAssetConflict(name) {
    return new Promise((resolve) => {
      const wrap = el("div", "gcast-modal");
      const sheet = el("div", "gcast-sheet");
      sheet.append(el("h3", null, `「${name}」已存在，但内容不一样`));
      const body = el("div", "body");
      body.append(el("div", "hint",
        "替换会顶掉旧图（引用它的格子一起换新）；作为新素材加入则两张并存、互不覆盖。"));
      const foot = el("div", "foot");
      const cancel = el("button", "gcast-btn ghost", "取消");
      const asNew = el("button", "gcast-btn ghost", "作为新素材加入");
      const replace = el("button", "gcast-btn", "替换现有图");
      foot.append(cancel, asNew, replace);
      sheet.append(body, foot);
      wrap.append(sheet);
      const close = () => wrap.remove();
      cancel.onclick = () => { close(); resolve(null); };
      asNew.onclick = () => { close(); resolve("new"); };
      replace.onclick = () => { close(); resolve("replace"); };
      wrap.addEventListener("pointerdown", (ev) => {
        if (ev.target === wrap) { close(); resolve(null); }
      });
      document.body.append(wrap);
      asNew.focus();
    });
  }

  /* 上传失败要把原因说出来。超限时后端返回 413（--max-upload-size，默认
     100 MB），此前这里直接 throw 而无人接住，界面看上去就是「拖进去没反应」。 */
  ui.uploadOrToast = async (file) => {
    try {
      /* 落哪个目录由 assetDirFor 定（csglide_rack_asset.js）：本工程有槽位在用
         同名素材 → 它正在用的那个目录；否则 → 本工程子目录 cglide/<片名>/。
         同名冲突不再盲目覆盖：先 auto 探一次，conflict 就问用户，再按选择落盘。 */
      const p = castProject(ui.node);
      const sub = assetDirFor(ui.st, p && p.name, file.name);
      let r = await uploadAsset(file, sub, "auto");
      if (r.status === "conflict") {
        const choice = await askAssetConflict(file.name);
        if (!choice) return null;   // 取消：不落盘、不动槽位
        r = await uploadAsset(file, sub, choice);
      }
      return r.path;
    } catch (e) {
      const m = String((e && e.message) || e);
      const why = m.includes("413")
        ? "超过 ComfyUI 上传上限（--max-upload-size，默认 100 MB）"
        : m;
      ui.toast(`「${file.name}」导入失败：${why}`, true);
      return null;
    }
  };

  ui.clearSlot = (slot) => { for (const k of Object.keys(slot)) delete slot[k]; };

  /* 批量导入挂起 commit 的重活（20261020）。
     一次拖 100 张，若每张都走完整 commit，就是 100 次 snapshot 深拷贝 +
     100 次 JSON.stringify(整个 st，含所有段的 segs) + 100 次全画布重绘 +
     100 次广播 —— 这就是「素材一多、导入就卡死」的量级来源。批量期间只记
     「有改动」，末尾 endBatch 统一做一次。

     ⚠️ 不去抖**用户直接操作**：AGENTS.md 铁律 —— 单击、拖滑块这类交互的写入
     永远实时。所以这里只由批量导入显式包起来用，日常路径 batchDepth 恒为 0，
     行为与改动前逐字一致。 */
  let batchDepth = 0;
  let commitPending = false;
  let renderPending = false;

  /* 帧级重绘合并（20261023 性能专项）：同一帧内 commit 多少次，全画布
     重绘最多发一次。参数恒为 (true,true) —— 只合并**次数**、绝不降级
     （铁律/PROJECT.md 经验：合并重绘若发 (true,false)，DOM 容器高度
     跟不上节点高度，会被前端单向尺寸覆盖缩回）。
     数据写入（snapshot + widget.value）在 commit 里**同步**完成、不进
     本合并，用户点完立刻点「运行」读到的就是最新架面。 */
  let paintRaf = 0;
  let paintTimer = 0;
  const schedulePaint = () => {
    if (paintRaf) return;
    const flush = () => {
      paintRaf = 0;
      if (paintTimer) { clearTimeout(paintTimer); paintTimer = 0; }
      try { node.setDirtyCanvas(true, true); } catch (_) {}
    };
    paintRaf = requestAnimationFrame(flush);
    /* 后台标签页 rAF 会被暂停，50ms 定时器兜底，事件不丢。 */
    paintTimer = setTimeout(() => {
      if (paintRaf) { cancelAnimationFrame(paintRaf); flush(); }
    }, 50);
  };
  ui.cancelPaint = () => {
    if (paintRaf) { cancelAnimationFrame(paintRaf); paintRaf = 0; }
    if (paintTimer) { clearTimeout(paintTimer); paintTimer = 0; }
  };
  ui.beginBatch = () => { batchDepth++; };
  /* renderImages 自己也来问一句（20261020）：commit 挂了、渲染没挂的话，100 张
     就是 100 次全量遍历 + insertBefore 校正，O(n²) 照旧。 */
  ui.inBatch = () => batchDepth > 0;
  ui.markRendered = () => { renderPending = true; };
  ui.endBatch = () => {
    batchDepth = Math.max(0, batchDepth - 1);
    if (batchDepth !== 0) return;
    /* 先渲后提交：commit 会把 st 写进 widget，画面得先跟上。 */
    if (renderPending) { renderPending = false; ui.renderImages?.(); }
    if (commitPending) { commitPending = false; ui.commit(); }
  };

  ui.commit = () => {
    ui.fixAudioOut?.();
    if (batchDepth > 0) { commitPending = true; return; }   // 批量中：只记一笔
    /* 改动**即时**落进当前段的记忆（segs[cur]）。只靠切段那一刻才存
       （switchSeg 里的 ui.st.segs[cur] = snapshot()）会漏掉最后一次改动：
       摆完图直接点「全部渲染」或刷新页面，那一版素材就根本没进 segs，
       切段回来还是旧的 —— 表现为「摆好了、渲染时却没连上」（20261012）。 */
    if (ui.st && typeof ui.snapshot === "function") {
      try {
        const snap = ui.snapshot();
        if (ui.st.cur) {
          ui.st.segs[ui.st.cur] = snap;
        } else if (ui.st.shared) {
          /* 全片共用：cur 是空的（不按段记忆），但每一段的记录都得跟着这副架面走。
             否则加一张图只有架面变了、各段记忆和工程库里都还是旧的 —— 切回
             按段记忆或刷新页面之后，新加的图就没了（20261022 缺口）。 */
          Object.keys(ui.st.segs || {}).forEach((cid) => { ui.st.segs[cid] = snap; });
          /* 共用时没有"切段"这个时机去落库，只能在每次收口时把 N 段一起写。
             scheduleRackSave 自带 700ms 防抖并由 projectStore 合并，8 段不会
            打成 8 个连发请求。 */
          Object.keys(ui.st.segs || {}).forEach((cid) => ui.saveSegRack?.(cid));
        }
      } catch (_) {}
    }
    if (!dataWidget) dataWidget = node.widgets?.find((w) => w.name === "rack_data");
    if (dataWidget) {
      /* 方案A（20261025）：后端执行时按 chain{name,clip} 去中央库取本段权威
         架面，rack_data 镜像只是缓存。

         ⚠ **全片共用模式（setShared 打开）下 ui.st.cur 是空串** —— 于是
         chain.clip 为空，后端 `_cid.startswith("clip_")` 不成立，直接退回镜像。
         这不是失效，是**唯一正确的行为**：库里的 rack 是按 cid 存的，"全片共用"
         这个架面在库里根本没有对应条目，无从取权威。所以共用模式下方案A
         对媒体架等于不生效 —— 知道就好，别在共用模式下遇架面错乱时往"方案A
         没生效"这个方向查（20261025 暗病 6，仅认知问题，无害）。 */
      ui.st.chain = {
        name: (ui.castName && ui.castName()) || "",
        clip: ui.st.cur || "",
      };
      dataWidget.value = JSON.stringify(ui.st);
    }
    /* 重绘走帧级合并：一帧内 N 次 commit 只全画布重绘一次（20261023）。 */
    schedulePaint();
    /* 架内容变了即时广播：导演台/文案台监听后立即同步，不再等 0.8~1.5s
       轮询（监听方各自按 raw/节点 id 去重；emitRackChange 自身按帧+节点
       合帧，20261012/20261023）。 */
    emitRackChange({ node: node.id, reason: "commit" });
  };

  /* 节点高度只由用户拖拽 / 初始 setSize 决定，内容超出靠面板内滚动
     （.gcast overflow:auto）。以前有个 ui.fit() 按 DOM 全量内容高度
     grow-only 撑高：图片一多节点就几千像素、看不到头，手动拖小后刷新
     又被撑回（20261110 多名用户实测）。现在不再有任何按内容改高的入口。
     报给框架的 minHeight 只给一个固定小值：前端拖拽用 node.computeSize()
     做下限钳制，而 computeSize() 累加各 widget 的 minHeight —— 报内容实测
     峰值会让节点永远拖不到比内容更矮的位置。报小值后，布局的
     distributeSpace（maxHeight 无限）让 widget 填满节点主体，收短后内容
     自然滚动、不塌陷。 */
  const MIN_FLOOR_H = 120;
  ui.minH = () => MIN_FLOOR_H;

  /* 分区装配。顺序 = 依赖次序：后装的块在运行时会用到先装块挂到 ui 上的东西，
     而每个块是**装完才挂**，所以这个顺序不能调。 */
  installImages(ui);     // → ui.imgBox / ui.assignImage / ui.renderImages / ui.isReordering
  installCards(ui);      // → ui.vidGrid / ui.audGrid / ui.rebuildMedia / ui.freeMediaSlot / ui.appendMedia
  installSort(ui);       // → ui.sortByPrompt（用到 ui.bSort，由 bar 创建）
  installBar(ui);        // → ui.bar / ui.segChip / ui.bSort / ui.fpsIn / ui.audIn / ui.fixAudioOut
  installDrop(ui);       // 节点级拖入（用到上面两块的漏斗）
  installSeg(ui);        // → ui.load / ui.switchSeg / ui.syncSegChip

  ui.root.append(ui.bar, ui.imgBox,
                 el("div", "gcast-label", "参考视频"), ui.vidGrid,
                 el("div", "gcast-label", "参考音频"), ui.audGrid);

  /* 「本段文案引用了哪几格」的亮/灰（20261023）。必须排在 root.append **之后**：
     它要在三个网格各自的标题上补"· 本段用 N"，而标题是 grid 的前一个兄弟节点
     —— 还没上文档就找不到。它只读 ui.imgGrid/vidGrid/audGrid 与文案台。 */
  installRefs(ui);
  /* 槽位纠错（腾位/归位）排在最后：它要读文案台、要看完整架面，
     还要调 ui.renderImages / ui.commit —— 全都是前面几块挂上去的。 */
  installVacate(ui);

  return {
    root: ui.root,
    /* BAG_VERSION 必须在返回对象上：self-heal 读 node.gmr.BAG_VERSION 判断
       旧闭包。原来只在内部 ui（installSeg 挂的）、返回对象没有 → 恒
       undefined、新 bag 也被误判为旧 bag 而热重建（监听器累积/风暴源头）。 */
    BAG_VERSION: ui.BAG_VERSION,
    st: ui.st,
    load: ui.load,
    /* loadSeg / switchSeg 必须暴露：restoreShotRack 靠 node.gmr.loadSeg 判定新
       bag。原来返回对象漏了它们（只在内部 ui 上），导致 node.gmr.loadSeg 恒
       undefined，**每次都误判成"热重载前的旧实例"、走旧兜底 load(force)**，
       段词/架面联动错乱还误报硬刷新警告。 */
    loadSeg: ui.loadSeg,
    switchSeg: ui.switchSeg,
    /* copySeg / claimSeg / dropSeg 也必须在返回对象上：导演台复制/认领/删段
       走 node.gmr.copySeg / claimSeg / dropSeg，漏挂 = 恒 undefined、静默失败
       （复制段抄素材一直没生效的根因之一，20261014）。 */
    copySeg: ui.copySegRack,
    claimSeg: ui.claimSegRack,
    dropSeg: ui.dropSeg,
    commit: ui.commit,
    /* renderImages 也必须在返回对象上：commit **只写镜像 + 画布重绘 + 广播**，
       它自己不重绘图片网格（渲染由 installImages 的 ui.renderImages 负责）。
       外部改完 ui.st 后必须 先 renderImages 再 commit，否则栏位变了、
       面板上那一格还是旧图（与 loadSeg/copySeg 当年"漏挂变静默失败"同类）。 */
    renderImages: ui.renderImages,
    minH: ui.minH,
    /* 槽位纠错（20261024）：控制台的 bzVacate() / bzVacateUndo() / bzVacateAuto()
       走这三个 —— 漏挂就是恒 undefined、控制台命令静默失败（与 loadSeg/copySeg
       当年那个根因同一类，见上面注释）。 */
    vacate: ui.vacate,
    vacateUndo: ui.vacateUndo,
    vacateAuto: ui.vacateAuto,
    destroy() { ui.cancelPaint(); ui.destroySegPoll(); ui.destroyRefs?.(); },
  };
}

/* ============================================================
 * 画布导航期降载（20261101 性能专项第二轮）
 * ------------------------------------------------------------
 * 媒体架是挂在 ComfyUI 的 transform:translate/scale 盒里的 DOM widget，
 * 画布平移/缩放时整块面板要按新比例重栅格化、拖节点时 clip-path 随选中
 * 每帧变化 —— 重栅格化的大头是 img/video 的重采样（成本不进显存/内存
 * 读数，所以「占用很低但很卡」）。
 * 做法（与 ComfyUI-NodeSnapshots 的「导航期简化」同思路）：
 *   视图真的在动 / 鼠标按住拖动期间，给 <html> 挂 bz-nav 类 → CSS 隐掉
 *   媒体元素本身（布局不动，只省位图绘制）；停手 180ms 后摘掉，缩略图
 *   立刻恢复（解码缓存还在，恢复近零成本）。数据、交互、槽位一概不动。
 * 信号源（都在前端产物里核实过）：
 *   ① DragAndScale.computeVisibleArea 在 scale/offset 真的变了才回调
 *      onChanged(scale, offset) —— 平移/缩放专用，链式接管不丢原回调。
 *   ② pointermove 且 buttons≠0 —— 覆盖拖节点/框选/拖拽平移（ds 不变）。
 *      目标在媒体架内部时不打标：架内拖拽排序/修剪时不能藏自己的图。
 * ============================================================ */
let navTimer = 0;
function markNav() {
  try {
    document.documentElement.classList.add("bz-nav");
    if (navTimer) clearTimeout(navTimer);
    navTimer = setTimeout(() => {
      document.documentElement.classList.remove("bz-nav");
      navTimer = 0;
    }, 180);
  } catch (_) {}
}
let navDsHooked = false;
let navPtrHooked = false;
function hookNavWatch() {
  /* 拖动类信号：一次就够（HMR 重跑本模块时 navPtrHooked 归零会重复注册，
     用全局标记挡住 —— 否则热重载一次多一个监听器，监听器累积是本仓的老坑）。 */
  if (!navPtrHooked) {
    navPtrHooked = true;
    try {
      document.addEventListener("pointermove", (e) => {
        if (!e.buttons) return;
        const t = e.target;
        /* .gmr = 媒体架，.bz-wrap = 班长媒体加载器：两者面板内部都有按住
           拖动的交互（架内拖拽排序/修剪、加载器尺寸滑条），不能把自己的
           缩略图藏掉 —— 面板内不打标，只对画布上的拖动降载。 */
        if (t && t.closest && t.closest(".gmr,.bz-wrap")) return;
        markNav();
      }, { passive: true, capture: true });
    } catch (_) {}
  }
  /* 视图变换信号：画布可能晚于本模块创建，建节点时再试，成功一次即止。 */
  if (navDsHooked) return;
  try {
    const ds = app.canvas && app.canvas.ds;
    if (!ds) return;
    if (ds.__bzNav) { navDsHooked = true; return; }   /* HMR：已链过，别再包一层 */
    navDsHooked = true;
    const prev = ds.onChanged;
    ds.__bzNav = true;
    ds.onChanged = function (scale, offset) {
      if (prev) { try { prev.call(this, scale, offset); } catch (_) {} }
      markNav();
    };
  } catch (_) {}
}

app.registerExtension({
  name: "cglide.mediarack",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== NODE_ID) return;
    injectRackCSS();
    hookNavWatch();

    const onCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = onCreated?.apply(this, arguments);

      const data = this.widgets?.find((w) => w.name === "rack_data");
      if (data) {
        /* 隐藏 rack_data widget（同导演台 h3_data 的隐藏手法，兼容 v1/v2） */
        data.origType = data.origType || data.type;
        data.hidden = true;
        data.options = Object.assign({}, data.options, { hidden: true });
        data.computeSize = () => [0, -4];
        data.computeLayoutSize = () => ({ minHeight: 0, maxHeight: 0, minWidth: 0 });
        data.label = "";
        data.tooltip = "";
        data.serializeValue = data.serializeValue || (() => data.value);
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
      this.gmr = ui;
      const uiWidget = this.addDOMWidget("gmr_ui", "div", ui.root, { serialize: false, hideOnZoom: false });
      /* minHeight 报固定小值：前端拖拽以 node.computeSize()（=各 widget
         minHeight 之和）做下限钳制，报内容实测峰值会让节点永远拖不到比内容
         更矮。报小值 + maxHeight 无限，布局会把 widget 填满节点主体，收短后
         内容靠 .gcast 滚动，不塌陷。 */
      uiWidget.computeLayoutSize = () => ({ minHeight: ui.minH(), maxHeight: void 0, minWidth: 0 });

      requestAnimationFrame(() => {
        const wrap = ui.root.parentElement;
        if (wrap && wrap.classList.contains("dom-widget")) wrap.style.pointerEvents = "none";
        /* 网格样式首验+自愈：样式表被旧缓存顶掉（custom_nodes 静态服务无缓存
           戳，覆盖更新后不硬刷新会新旧混跑）时就地补内联修复，并提示硬刷新。
           之后每次 rebuildMedia 还会顺带复验（rack_cards 的 healGrids）。 */
        try {
          if (ui.healGrids && ui.healGrids()) {
            ui.toast("媒体架样式没加载全（浏览器缓存），网格已自动修复，建议 Ctrl+F5 硬刷新一次", true, 9000);
          }
        } catch (_) {}
      });

      ui.load(data ? data.value : "");
      /* 唯一的尺寸写入口：初始 620×560，之后全归用户拖拽。
         不按 DOM 内容撑高，图片多时靠面板内滚动看全部。 */
      this.setSize?.([MIN_W, MIN_H]);
      return r;
    };

    const onConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function (info) {
      const r = onConfigure?.apply(this, arguments);
      const data = this.widgets?.find((w) => w.name === "rack_data");
      if (this.gmr && data) {
        this.gmr.load(data.value);
        const nid = this.id;
        /* 读档（reload / loadGraphData）后架上已有素材，但 commit 不触发、
           不会广播 bz:rack-change，导演台 / 文案台首帧读到的是空架，素材条会
           永久空着。这里等本轮同步配置结束后主动广播一次，让所有监听方按同一
           事件统一刷新（事件驱动的单一数据源，20261013）。监听方都按素材
           集合签名去重，多播一次零成本。
           用 setTimeout 而非 requestAnimationFrame：标签页在后台时 rAF 会被
           暂停、事件就发不出去，setTimeout 仍会执行（可能被节流，但不漏）。 */
        setTimeout(() => {
          try { emitRackChange({ node: nid }); } catch (_) {}
        }, 0);
      }
      return r;
    };
  },
});

/* ============================================================
 * 热重建（HMR 在线升级）
 * ------------------------------------------------------------
 * 前端热替换只重跑模块、不重跑 onNodeCreated —— 已存在媒体架节点的 gmr
 * 永远停在热重载前的旧闭包（缺 switchSeg/loadSeg/hydrateRacks，段记忆
 * 不存在）。Electron 套壳里 Ctrl+F5 还可能被缓存拦掉，用户光靠"刷新"
 * 无法保证 bag 换新。自愈巡检（bz_project_sync）检测到旧 gmr 后直接调
 * 本函数：拆掉旧 DOM widget、按当前代码重新 buildUI 并挂回节点，行为
 * 与刷新后新建的节点一致。rack_data 原样保留，素材不丢。
 * 失败回退 false（调用方保留旧 bag + 走整包 load 兜底）。
 * ============================================================ */
export function rebuildMediaRackUI(node) {
  if (!node || !node.widgets) return false;
  /* 已经是新 bag（接口齐全）就不用重建。 */
  /* 新 bag 识别只认 BAG_VERSION + st.segs（返回对象现在都暴露了）；
     旧判定还要求 loadSeg 函数，但返回对象从不暴露它 → 永远重建。 */
  if (node.gmr && node.gmr.BAG_VERSION === BZ_BAG_VERSION
      && node.gmr.st && node.gmr.st.segs) return true;
  try {
    const old = node.gmr;
    /* 旧 gmr 是 buildUI 的返回对象，只暴露 destroy（内部调 destroySegPoll），
       **没有 destroySegPoll**——原来调 old?.destroySegPoll?.() 等于空操作，
       旧 bag 注册的 onCastChange 监听器从不移除，热重建一次就多挂一个，
       最终一次广播触发 N 次 switchSeg（事件风暴/串段/误删根因）。 */
    try { old?.destroy?.(); } catch (_) {}

    /* 摘掉旧 DOM widget：优先用 ComfyUI 配对的 removeDOMWidget（会同时
       移除 .comfyui-dom-widget 包裹），没有再手动摘。 */
    const oldUiWidget = node.widgets.find((w) => w.name === "gmr_ui");
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
    /* 再清一遍可能残留的包裹容器（双屏版/HMR 偶发 DOM 残留）。 */
    try {
      const roots = node.domEl?.querySelectorAll ? node.domEl.querySelectorAll(".gmr") : [];
      roots.forEach((r) => {
        if (r.parentElement && r.parentElement.classList.contains("comfyui-dom-widget")) {
          r.parentElement.remove();
        }
      });
    } catch (_) {}

    const data = node.widgets.find((w) => w.name === "rack_data");
    const ui = buildUI(node);
    node.gmr = ui;
    const uiWidget = node.addDOMWidget("gmr_ui", "div", ui.root, { serialize: false, hideOnZoom: false });
    uiWidget.computeLayoutSize = () => ({ minHeight: ui.minH(), maxHeight: void 0, minWidth: 0 });

    requestAnimationFrame(() => {
      const wrap = ui.root.parentElement;
      if (wrap && wrap.classList.contains("dom-widget")) wrap.style.pointerEvents = "none";
      /* 同 onNodeCreated：热重建后也做一次网格样式首验+自愈。 */
      try {
        if (ui.healGrids && ui.healGrids()) {
          ui.toast("媒体架样式没加载全（浏览器缓存），网格已自动修复，建议 Ctrl+F5 硬刷新一次", true, 9000);
        }
      } catch (_) {}
    });

    ui.load(data ? data.value : "");
    /* 尺寸归用户：热重建类比 onConfigure（节点已存在、用户已拖过大小），
       不 setSize、不 fit —— DOM widget 会填满节点主体，强行按初始尺寸
       重设会把用户拖好的节点大小冲掉。 */
    node.setDirtyCanvas?.(true, true);
    console.log("[H3 Studio] 媒体架节点已在线热重建（旧 bag 升级为当前版本）node=" + node.id);
    return true;
  } catch (e) {
    console.warn("[H3 Studio] 媒体架热重建失败(保留旧界面):", e);
    return false;
  }
}
