/* ============================================================
 * csglide_timeline_engine.js — 时间轴视图引擎（方案 A 视图中枢 · B 引擎内核）
 * ------------------------------------------------------------
 * 把过去散落在 csglide_film.js 里的「帧↔像素坐标 / 缩放 / 容器尺寸 / 重画」
 * 收口为一个无依赖、可复用的纯引擎：
 *
 *   · 唯一坐标：帧→x 只有 xOf()，帧长→宽只有 wOf()，x→帧只有 frameAtX()；
 *     播放头 / 刻度 / 段块 / 接缝 / 波形 / 缩略图全部共用这一把尺子。
 *   · 唯一缩放：fit() 适配填满、zoomAt() 以鼠标下那一帧为锚点缩放，
 *     缩放是单一参数 pxPerFrame，所有层在下一帧一次重画。
 *   · 唯一 resize：内部一个 ResizeObserver 只认滚动容器 clientWidth——
 *     节点/浮动窗被拖宽才重 fit；拖段接缝只改内部 track 的 scrollWidth，
 *     不触发 refit（精准区分"拖宽容器"与"改段长"）。fit 态严格铺满，
 *     不为几像素的右缘探出缩尺子（见下方 20261108 根修注释）。
 *   · 一个 render 总线：requestRender() 用 rAF 合帧，一帧最多重画一次，
 *     resize/缩放/数据更新再密也只产生一次 layout。
 *
 * 固定「像素/帧」模型（专业剪辑软件口径）：
 *   left = 帧 × pxPerFrame；track 宽 = 总帧 × pxPerFrame；超出可视宽→横滚。
 *
 * 纯 ES module，不依赖 ComfyUI；导演台监视器与续接合成都可实例化使用。
 * ============================================================ */

const MIN_PX_PER_FRAME = 0.02;   // 每帧最小像素（防除零 / 防塌缩）
const MAX_PX_PER_FRAME = 8;      // 每帧最大像素（24fps 下约 192px/秒，足够看细节）

/* 「几像素假溢出」不再缩尺子（20261108 根修）。
   历史做法：fit 后若 scrollWidth 只比 clientWidth 大 1~12px（末帧播放头手柄、
   刻度标签、段尾徽标向右探出），就把 pxPerFrame 缩成 (vw−24)/total 吃掉它。
   但 .bzf-band 早已改成 overflow-x:hidden —— 滚动条根本不会显示，假溢出
   本来就由裁切兜住。缩尺子唯一的可见后果是：所有按 xOf/wOf 摆的层（视频段块、
   成片波形、音频块、刻度）右端统一比容器短 24px；而 .bzsa-row 按容器 100%
   铺满，那 24px 就成了时间轴右侧一条空白带，× / 试听 / 本段 按钮正好浮在
   里面（ComfyUI 画布 3× 缩放下 ≈ 78px，用户报「拖进音频后最右侧空出一块」）。
   拖音频 → resize_many 改总帧 → fitTimeline → layout，末帧播放头探出几像素
   就把吸附判据点燃，空白带随之出现；没拖音频时没有段尾徽标，看不出来。
   现在统一口径：**fit 就是让 total×ppf 严格等于 vw，一像素都不让**；
   fitMode 为真时横向滚动恒为 0；真缩放态才允许横滚，且 scrollLeft 夹在真实
   scrollWidth−clientWidth 内。 */

export function createTimelineEngine(cfg = {}) {
  const band = cfg.band;                         // 滚动容器（clientWidth = 可视宽）
  const getTotalFrames = cfg.getTotalFrames || (() => 0);
  const onRender = cfg.onRender || null;         // 几何重画回调（宿主的 layout）
  const isCollapsed = cfg.isCollapsed || null;
  /* 左侧轨道头留白（像素）：时间轴 0 帧并不在容器最左边，而是右移这一列 ——
     音频轴的行头就住在这条留白里。可见内容宽必须扣掉它，否则整条片会被
     挤出右缘 88px。 */
  const gutter = Math.max(0, Number(cfg.gutter) || 0);

  let pxPerFrame = 0;      // 每帧占多少布局像素；0 = 尚未建立尺子
  let fitted = false;      // 是否在"数据+布局就绪"时 fit 过（防早期脏值锁定）
  let fitMode = true;      // true = 整片刚好铺满、禁止任何横向滚动
  let lastFitTotal = 0;    // 上次适配时的总帧数（总长变了才自动重 fit）
  let lastBandW = 0;       // 上次容器可视宽（宽变才 refit）
  let ro = null;
  let rafId = 0;
  let queued = false;

  const totalNow = () =>
    Math.max(1, Math.round(Number(getTotalFrames()) || 0));
  const viewportW = () => Math.max(1, (band.clientWidth || 1) - gutter);

  /* 重算 pxPerFrame，让整条片刚好填满可视宽。
     数据未就绪（无段 / total<2）或布局未就绪（clientWidth<60）都不许锁定，
     否则早期一次空渲染会把尺子锁成脏值（段块放大成几万像素 / 挤成 2px）。 */
  function fit() {
    const total = totalNow();
    const vw = viewportW();
    if (!total || total < 2 || vw < 60) {
      pxPerFrame = 0;
      fitted = false;
      fitMode = true;
      lastFitTotal = 0;
      return false;
    }
    /* 严格铺满：total × pxPerFrame === vw，不留任何右侧余量。 */
    pxPerFrame = Math.max(MIN_PX_PER_FRAME, vw / total);
    fitted = true;
    fitMode = true;
    lastFitTotal = total;
    /* fit 态下 scrollWidth 可能比 clientWidth 大几像素（右缘徽标探出），
       overflow-x:hidden 会裁掉它，但浏览器仍允许 scrollLeft 被推到那几像素，
       看上去又是一条空白带。这里显式归零，把"铺满"锁死。 */
    if (band) { try { band.scrollLeft = 0; } catch (_) {} }
    return true;
  }
  function ensureScale() { if (!fitted) fit(); }

  const isFitted = () => fitted;
  const getPx = () => pxPerFrame;
  const getLastFitTotal = () => lastFitTotal;

  /* 唯一坐标换算（全时间轴所有层共用，禁止其它地方再手算 帧×像素）。 */
  const xOf = (frame) => (Number(frame) || 0) * pxPerFrame;
  const wOf = (frames) => (Number(frames) || 0) * pxPerFrame;
  const frameAtX = (contentX) =>
    (pxPerFrame > 0 ? (contentX / pxPerFrame) : 0);

  /* render 总线：rAF 合帧，一帧最多重画一次；回调异常隔离，不炸调用方。 */
  function requestRender() {
    if (queued) return;
    queued = true;
    rafId = requestAnimationFrame(() => {
      queued = false;
      if (isCollapsed && isCollapsed()) return;
      try { if (onRender) onRender(); }
      catch (e) { console.warn("[timeline-engine] render 回调异常：", e); }
    });
  }

  /* 容器可视宽变化（拖节点/浮动窗/窗口缩放）→ 重 fit。只认 clientWidth，
     拖段长不改它。fit() 已经把尺子重算成严格铺满、并把 scrollLeft 归零，
     不要再按旧的 gutter / anchorFrame 往回写 scrollLeft —— 那等于凭空把
     内容整体左移 26px，右端又留出一条空白带。 */
  function refitForWidth(vw) {
    vw = Math.round(Number(vw) || 0);
    if (vw === lastBandW || vw < 60) return false;
    lastBandW = vw;
    fit();
    return true;
  }

  const clampPx = (v) =>
    Math.max(MIN_PX_PER_FRAME, Math.min(MAX_PX_PER_FRAME, v));

  /* 以鼠标位置（clientX，视口坐标）下那一帧为锚点缩放。
     缩到"整条片不再超出可视宽"时吸附回 fit；放大时保持锚点帧在鼠标下。 */
  function zoomAt(factor, clientX) {
    ensureScale();
    if (!fitted) { requestRender(); return; }
    const rect = band.getBoundingClientRect();
    const localX = clientX == null
      ? band.clientWidth / 2
      : (clientX - rect.left);
    const anchorFrame = Math.max(0, (band.scrollLeft + localX - gutter) / pxPerFrame);
    const total = totalNow();
    const vw = viewportW();
    const next = clampPx(pxPerFrame * factor);
    if (next * total <= vw + 0.5) {
      fit();                       // 缩回填满就吸附到 fit（fitMode=true，横向归零）
    } else {
      pxPerFrame = next;
      fitted = true;
      fitMode = false;             // 真缩放态：才允许横向滚动
      lastFitTotal = total;
    }
    requestAnimationFrame(() => {
      if (!band.isConnected) return;
      if (fitMode) { band.scrollLeft = 0; return; }
      const maxScroll = Math.max(0, band.scrollWidth - band.clientWidth);
      band.scrollLeft = Math.max(0,
        Math.min(maxScroll, gutter + anchorFrame * pxPerFrame - localX));
    });
    requestRender();
  }

  /* 换片/换工程：尺子归零，等新数据就绪后由 ensureScale 重建。 */
  function reset() {
    pxPerFrame = 0;
    fitted = false;
    fitMode = true;
    lastFitTotal = 0;
  }

  /* 唯一 resize 入口：内部 ResizeObserver + window resize。 */
  function handleResize() {
    if (isCollapsed && isCollapsed()) return;
    refitForWidth(band.clientWidth);
    requestRender();
  }
  if (typeof ResizeObserver !== "undefined" && band) {
    ro = new ResizeObserver(handleResize);
    ro.observe(band);
  }
  function onWinResize() { handleResize(); }
  window.addEventListener("resize", onWinResize);
  lastBandW = band ? Math.round(band.clientWidth || 0) : 0;

  function destroy() {
    if (ro) { try { ro.disconnect(); } catch (_) { /* 已断开 */ } ro = null; }
    window.removeEventListener("resize", onWinResize);
    if (rafId) cancelAnimationFrame(rafId);
    queued = false;
  }

  return {
    fit,
    ensureScale,
    isFitted,
    getPx,
    getLastFitTotal,
    viewportW,
    xOf,
    wOf,
    frameAtX,
    zoomAt,
    refitForWidth,
    requestRender,
    reset,
    destroy,
  };
}
