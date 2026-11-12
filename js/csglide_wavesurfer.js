/* ============================================================
 * csglide_wavesurfer.js — wavesurfer.js 按需懒加载器（方案 B 的波形内核）
 * ------------------------------------------------------------
 * 为什么库文件用 .js.txt 而不是 .js：
 *   ComfyUI 启动时会扫描 WEB_DIRECTORY（js/）下**所有 .js** 并逐个 import。
 *   本机装了 764 个扩展，浏览器对同域最多 6 个连接 —— 若 wavesurfer 以 .js
 *   存在，启动时会和导演台 hydrate 工程数据、视频预览抢连接（这正是本轮要根治
 *   的"刷新后素材空、连接被挤死"）。改成 .js.txt 后：
 *     · 不在 /api/extensions 枚举里 → 启动**零连接、零执行**；
 *     · 仍在静态目录下，需要时 fetch 文本即可取到（text/plain）。
 *   加载时用 Blob 转成 text/javascript 的本地 URL 再注入 <script>，UMD 会正确
 *   挂到 globalThis.WaveSurfer，并严格按 core → regions → zoom → timeline 顺序
 *   执行（避免 UMD 并行加载时 core 覆盖插件对象的问题）。
 *
 * 段块轴不用 wavesurfer：wavesurfer 的 Region 按"秒"、且依赖一条连续音频源，
 * 而本时间轴是"多段累积片 + 帧精确生成单元"（续拍菱形 / 转场卡 / 双缓冲
 * 连播 / 空段 / 雪碧图）。段块、缩放、自适应、坐标、合帧重画已由
 * csglide_timeline_engine（自研视图引擎）完整承担，且更贴合帧模型。
 * wavesurfer 预留给未来"整片音频波形轨"这类它真正擅长的场景。
 * ============================================================ */

const VENDOR_BASE = "/extensions/ComfyUI-Banzhang-All/vendor/";
/* 顺序敏感：core 必须先于插件（插件往全局 WaveSurfer 上挂 xxxPlugin）。 */
const FILES = [
  "wavesurfer.core.min.js.txt",
  "wavesurfer.regions.min.js.txt",
  "wavesurfer.zoom.min.js.txt",
  "wavesurfer.timeline.min.js.txt",
];

let _promise = null;

/** fetch 文本 → Blob(text/javascript) → 注入经典 <script>，等其执行完成。 */
function injectFromText(fileName) {
  return new Promise((resolve, reject) => {
    fetch(VENDOR_BASE + fileName, { cache: "force-cache" })
      .then((r) => {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.text();
      })
      .then((code) => {
        const blob = new Blob([code], { type: "text/javascript" });
        const url = URL.createObjectURL(blob);
        const s = document.createElement("script");
        s.src = url;
        s.async = false;
        s.dataset.bzWs = fileName;
        s.onload = () => { URL.revokeObjectURL(url); resolve(); };
        s.onerror = () => { URL.revokeObjectURL(url); reject(new Error("wavesurfer 执行失败：" + fileName)); };
        document.head.appendChild(s);
      })
      .catch((err) => reject(err));
  });
}

/** 按需加载 wavesurfer（幂等，失败可重试）。完成后返回 globalThis.WaveSurfer。
    UMD 全局构建里插件挂在类名上（WaveSurfer.Regions / Zoom / Timeline），
    不是 ES module 的小写工厂 regionsPlugin，故按类名判定就绪。 */
export function loadWaveSurfer() {
  const WS = globalThis.WaveSurfer;
  const ready = WS && typeof WS.create === "function"
    && WS.Regions && WS.Zoom && WS.Timeline;
  if (ready) return Promise.resolve(WS);
  if (!_promise) {
    _promise = (async () => {
      /* 全局只有 core（例如被别处加载）时，也仍按顺序补插件。 */
      for (const f of FILES) {
        const isCore = f.includes("core");
        if (isCore && globalThis.WaveSurfer && typeof globalThis.WaveSurfer.create === "function") continue;
        await injectFromText(f);
      }
      const out = globalThis.WaveSurfer;
      if (!out || typeof out.create !== "function") {
        throw new Error("wavesurfer 加载后未正确挂载到全局");
      }
      return out;
    })();
    _promise.catch(() => { _promise = null; });   // 失败后允许重试
  }
  return _promise;
}

export function isWaveSurferReady() {
  const WS = globalThis.WaveSurfer;
  return !!(WS && typeof WS.create === "function" && WS.Regions && WS.Zoom && WS.Timeline);
}
