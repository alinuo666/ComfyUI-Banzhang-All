/* ============================================================
 * H3 媒体架 — 波形解码缓存 与 媒体元素复用
 * ------------------------------------------------------------
 * 两件事都为了「不重载」：波形每个文件只解码一次；媒体元素按槽位弱缓存，
 * render() 重建时移动而不是重建，否则每次粘贴/换图整个架子会闪。
 * ============================================================ */
import { el, viewURL } from "./csglide_rack_core.js";

/* ---- 波形：每个文件解码一次并缓存 -------------------------------- */
const wavCache = new Map();
export function peaksFor(file) {
  if (wavCache.has(file)) return wavCache.get(file);
  const job = (async () => {
    const buf = await (await fetch(viewURL(file))).arrayBuffer();
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    const ctx = new Ctx();
    try {
      const audio = await ctx.decodeAudioData(buf);
      const ch = audio.getChannelData(0);
      const N = 1400, block = Math.max(1, Math.floor(ch.length / N));
      const out = new Float32Array(N);
      let peak = 0;
      for (let i = 0; i < N; i++) {
        let m = 0;
        const s0 = i * block;
        for (let k = 0; k < block; k += 3) {
          const v = Math.abs(ch[s0 + k] || 0);
          if (v > m) m = v;
        }
        out[i] = m;
        if (m > peak) peak = m;
      }
      if (peak > 0) for (let i = 0; i < N; i++) out[i] /= peak;
      return out;
    } finally { ctx.close?.(); }
  })().catch(() => null);
  wavCache.set(file, job);
  return job;
}

export function drawWave(cv, peaks) {
  const w = cv.clientWidth || 1, h = cv.clientHeight || 44;
  const dpr = window.devicePixelRatio || 1;
  cv.width = Math.max(1, Math.round(w * dpr));
  cv.height = Math.max(1, Math.round(h * dpr));
  const g = cv.getContext("2d");
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  if (!peaks) {
    g.strokeStyle = "rgba(255,255,255,.10)";
    g.beginPath(); g.moveTo(0, h / 2); g.lineTo(w, h / 2); g.stroke();
    return;
  }
  const mid = h / 2, pad = 3;
  g.fillStyle = "rgba(255,255,255,.34)";
  for (let x = 0; x < w; x++) {
    const v = peaks[Math.min(peaks.length - 1, Math.floor((x / w) * peaks.length))] || 0;
    const bar = Math.max(1, v * (mid - pad));
    g.fillRect(x, mid - bar, 1, bar * 2);
  }
}

/* ---- 媒体元素复用：render()/切段重建槽位时 <video> 重新赋 src 会重载，
   海报帧消失又回来，表现为整个媒体架在每次粘贴/换段时闪烁。
   20261012 方案C：改为**按文件路径池化**（旧实现按 slot 对象弱缓存，而 load
   切段会用 {...s} 造出新 slot 对象 → 必 miss → 切段切回视频仍重载）。同一文件
   全工程只有一个媒体元素，跨段、跨 load 重新挂载只是 DOM 移动，不重载、不重新
   拉 metadata。池有上限，超出按 FIFO 释放（pause + 清空 src，交还浏览器解码池）。 */
const MEDIA_POOL_MAX = 32;
const mediaByFile = new Map();
export function mediaFor(slot, tag, file) {
  const TAG = tag.toUpperCase();
  let m = mediaByFile.get(file);
  if (m && m.tagName === TAG) {
    clearMediaListeners(m);
  } else {
    m = el(tag);
    m.__gcastFile = file;
    m.src = viewURL(file);
    m.preload = "metadata";   /* 只拉元数据/首帧，悬停才 play，不占带宽 */
    mediaByFile.set(file, m);
    if (mediaByFile.size > MEDIA_POOL_MAX) {
      const oldFile = mediaByFile.keys().next().value;
      const old = mediaByFile.get(oldFile);
      try { old.pause && old.pause(); old.src = ""; } catch (_) {}
      mediaByFile.delete(oldFile);
    }
  }
  return m;
}
export function onMedia(m, ev, fn) {
  (m.__gcastL || (m.__gcastL = [])).push([ev, fn]);
  m.addEventListener(ev, fn);
}
export function clearMediaListeners(m) {
  for (const [ev, fn] of m.__gcastL || []) m.removeEventListener(ev, fn);
  m.__gcastL = [];
}
