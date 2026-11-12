/* ============================================================
 * H3 媒体架 — 修剪条（波形 + 双柄 + 播放 + 时间/帧读出 + 快速帧档）
 * ------------------------------------------------------------
 * 与导演台面板（csglide_cast.js 的 mediaSlot + trim）逐项同构。
 * 唯一差异：媒体架是共享素材源，不知道消费侧导演台的片段时长，帧读出
 * 不做「按片段上限裁剪」告警（capFrames 置空），只报告 17k+5 网格吸附
 * 后的存活帧数。

 * 本模块只认识 slot 与 commit，不认识卡片：卡片每次重渲都会新建一条修剪条
 * （因为 makeMedia 的 paint 会 replaceChildren），所以这里返回的是一个全新的
 * wrap 元素，而不是可复用的实例。
 * ============================================================ */
import { el, FPS, fmt, gridDown, gridSpans, CHROMA_WARN } from "./csglide_rack_core.js";
import { drawWave, peaksFor, onMedia } from "./csglide_rack_media.js";

export function buildTrim({ slot, isVideo, media, commit }) {
  const wrap = el("div", "gcast-trim");
  const track = el("div", "gcast-track");
  const wave = el("canvas", "gcast-wave");
  const head = el("div", "gcast-head");
  const span = el("div", "gcast-span");
  const hA = el("div", "gcast-h a"); hA.tabIndex = 0; hA.title = "修剪起点";
  const hB = el("div", "gcast-h b"); hB.tabIndex = 0; hB.title = "修剪终点";
  const used = el("div", "gcast-used");
  track.append(wave, span, used, head, hA, hB);
  /* 色度徽章压在波形上、靠左——眼睛本就停在那里判断窗口。
     绿色 4:4:4 / 4:2:2（锚定干净）；琥珀红 4:2:0（丢四分之三色度）。 */
  if (slot.chroma) {
    const weak = slot.chroma === CHROMA_WARN;
    const chip = el("div", "gcast-chroma" + (weak ? " weak" : ""), slot.chroma);
    chip.title = weak
      ? `${slot.codec || "源"} ${slot.chroma} —— 色度亚采样：进入模型的参考只保留四分之一的色度信息。`
      : `${slot.codec || "源"} ${slot.chroma}`;
    track.append(chip);
  }
  /* 音频卡没有缩略图，波形本身背文件名；视频卡无需（cap 已有文件名） */
  if (!isVideo) track.append(el("div", "gcast-wavlabel", slot.file.split("/").pop()));

  const times = el("div", "gcast-times");
  const play = el("button", "gcast-play", "\u25B6");
  play.title = "播放修剪区间";
  const tL = el("span"), tR = el("span");
  times.append(play, tL, tR);
  wrap.append(track, times);

  /* 波形：解码一次后绘制，节点尺寸变化时重绘。
     首次解码要 fetch 整个媒体文件再 WebAudio 全量解码（参考视频常 10MB+，
     机械盘上当场发起会和切段渲染抢 IO/CPU，表现为切段迟钝）—— 首次发起
     延后到浏览器空闲帧（300ms 兜底），架子先瞬间换好，波形稍后填入；
     解码结果按文件缓存在 peaksFor 的 wavCache，尺寸变化重绘零请求。 */
  let ro = null;
  if (slot.file) {
    const drawWhenReady = () => peaksFor(slot.file).then((pk) => {
      if (wave.isConnected) drawWave(wave, pk);   /* 卡已淘汰就别画了 */
    });
    if (window.requestIdleCallback) {
      window.requestIdleCallback(drawWhenReady, { timeout: 300 });
    } else {
      setTimeout(drawWhenReady, 180);
    }
    try {
      ro = new ResizeObserver(drawWhenReady);
      ro.observe(track);
    } catch (e) { /* 旧浏览器：静态绘制即可 */ }
  }
  /* 卡被增量缓存淘汰/销毁时必须断开观察器：旧实现每次重建修剪条都新建一个
     ResizeObserver 且从不 disconnect，反复切段会累积大量死观察器，画布尺寸
     一变全部触发回调（脱离 DOM 的 canvas 也空跑）——「越切越卡」的泄漏点。 */
  wrap.__gcastDestroy = () => { try { ro && ro.disconnect(); } catch (e) {} };

  /* 只播放选区，到达终点即停 */
  let raf = 0;
  const stopAt = () => {
    if (!media || media.paused) return false;
    if (media.currentTime >= slot.end - 0.005 || media.currentTime < slot.start - 0.05) {
      media.pause();
      media.currentTime = slot.start;
      return true;
    }
    return false;
  };
  const paintHead = () => {
    if (!media || media.paused || !dur) { head.style.display = "none"; return; }
    if (stopAt()) { head.style.display = "none"; return; }
    head.style.display = "";
    head.style.left = (media.currentTime / dur) * 100 + "%";
    raf = requestAnimationFrame(paintHead);
  };
  if (media) {
    onMedia(media, "timeupdate", stopAt);
    onMedia(media, "play", () => { play.textContent = "\u23F8"; play.classList.add("on"); paintHead(); });
    onMedia(media, "pause", () => {
      play.textContent = "\u25B6"; play.classList.remove("on");
      cancelAnimationFrame(raf); head.style.display = "none";
    });
    play.onclick = (e) => {
      e.stopPropagation();
      if (!media.paused) { media.pause(); return; }
      media.muted = false;
      media.currentTime = slot.start;
      media.play().catch(() => {});
    };
  } else {
    play.disabled = true;
    play.style.opacity = .35;
    play.title = "该片段没有音频";
  }

  const dur = slot.dur || 0;
  if (!Number.isFinite(slot.start) || slot.start < 0 || slot.start >= dur) slot.start = 0;
  if (!Number.isFinite(slot.end) || slot.end > dur || slot.end <= slot.start) slot.end = dur;

  const paint = () => {
    if (!dur) return;
    const a = (slot.start / dur) * 100, b = (slot.end / dur) * 100;
    span.style.left = a + "%"; span.style.width = Math.max(0, b - a) + "%";
    hA.style.left = a + "%"; hB.style.left = b + "%";
    tL.textContent = isVideo
      ? `${fmt(slot.start)}  f${Math.round(slot.start * FPS)}`
      : fmt(slot.start);
    const len = slot.end - slot.start;
    if (!isVideo) { tR.textContent = fmt(len); tR.className = ""; return; }
    const f = gridDown(Math.round(len * FPS) + 1);
    const clip = Math.max(0, Math.round(len * FPS) + 1 - f);
    tR.textContent = f < 5 ? "太短——至少5帧" : `存活${f}帧·${fmt(len)}·裁${clip}`;
    tR.className = f < 5 ? "gcast-warn" : "";
  };
  paint();

  /* 拖柄时预览当前指向的帧 */
  let seekReq = 0;
  const seekPreview = (t) => {
    if (!media || media.tagName !== "VIDEO") return;
    cancelAnimationFrame(seekReq);
    seekReq = requestAnimationFrame(() => {
      try {
        if (!media.paused) media.pause();
        media.currentTime = Math.min(Math.max(0, t), Math.max(0, dur - 1 / FPS));
      } catch (_) { /* 还不可 seek */ }
    });
  };

  const drag = (handle, isStart) => {
    let dragging = false;
    const apply = (clientX) => {
      const r = track.getBoundingClientRect();
      let t = ((clientX - r.left) / r.width) * dur;
      t = Math.min(dur, Math.max(0, t));
      if (isStart) slot.start = Math.min(t, slot.end - 0.25);
      else slot.end = Math.max(t, slot.start + 0.25);
      paint();
      seekPreview(isStart ? slot.start : slot.end);
    };
    const move = (e) => { if (!dragging) return; e.preventDefault(); e.stopPropagation(); apply(e.clientX); };
    const moveMouse = (e) => { if (dragging) apply(e.clientX); };
    const up = (e) => {
      if (!dragging) return;
      dragging = false;
      try { handle.releasePointerCapture(e.pointerId); } catch (_) {}
      document.removeEventListener("pointermove", move, true);
      document.removeEventListener("pointerup", up, true);
      document.removeEventListener("mousemove", moveMouse, true);
      document.removeEventListener("mouseup", up, true);
      commit();
    };
    handle.addEventListener("pointerdown", (e) => {
      if (!dur) return;
      e.preventDefault(); e.stopPropagation();
      dragging = true;
      try { handle.setPointerCapture(e.pointerId); } catch (_) {}
      document.addEventListener("pointermove", move, true);
      document.addEventListener("pointerup", up, true);
      document.addEventListener("mousemove", moveMouse, true);
      document.addEventListener("mouseup", up, true);
    });
    handle.addEventListener("pointermove", move);
    handle.addEventListener("keydown", (e) => {
      const step = e.shiftKey ? 1 : 1 / FPS;
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      e.preventDefault();
      const d = e.key === "ArrowLeft" ? -step : step;
      if (isStart) slot.start = Math.min(Math.max(0, slot.start + d), slot.end - 0.25);
      else slot.end = Math.max(Math.min(dur, slot.end + d), slot.start + 0.25);
      paint(); commit();
    });
  };
  drag(hA, true); drag(hB, false);

  /* 拖动整条轨道平移窗口，长度不变 */
  if (dur) {
    track.classList.add("slidable");
    let sliding = false, grabOff = 0;
    const timeAt = (clientX) => {
      const r = track.getBoundingClientRect();
      return Math.min(dur, Math.max(0, ((clientX - r.left) / r.width) * dur));
    };
    const place = (clientX) => {
      const len = slot.end - slot.start;
      let s = timeAt(clientX) - grabOff;
      s = Math.min(Math.max(0, s), Math.max(0, dur - len));
      slot.start = s;
      slot.end = Math.min(dur, s + len);
      paint();
      seekPreview(slot.start);
    };
    const sMove = (e) => { if (!sliding) return; e.preventDefault(); e.stopPropagation(); place(e.clientX); };
    const sMoveMouse = (e) => { if (sliding) place(e.clientX); };
    const sUp = (e) => {
      if (!sliding) return;
      sliding = false;
      track.classList.remove("sliding");
      try { track.releasePointerCapture(e.pointerId); } catch (_) {}
      document.removeEventListener("pointermove", sMove, true);
      document.removeEventListener("pointerup", sUp, true);
      document.removeEventListener("mousemove", sMoveMouse, true);
      document.removeEventListener("mouseup", sUp, true);
      commit();
    };
    track.addEventListener("pointerdown", (e) => {
      e.preventDefault(); e.stopPropagation();
      const t = timeAt(e.clientX);
      grabOff = (t >= slot.start && t <= slot.end) ? t - slot.start : 0;
      sliding = true;
      track.classList.add("sliding");
      try { track.setPointerCapture(e.pointerId); } catch (_) {}
      document.addEventListener("pointermove", sMove, true);
      document.addEventListener("pointerup", sUp, true);
      document.addEventListener("mousemove", sMoveMouse, true);
      document.addEventListener("mouseup", sUp, true);
      place(e.clientX);
    });
    track.tabIndex = 0;
    track.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      e.preventDefault(); e.stopPropagation();
      const len = slot.end - slot.start;
      const d = (e.key === "ArrowLeft" ? -1 : 1) * (e.shiftKey ? 1 : 1 / FPS);
      const s = Math.min(Math.max(0, slot.start + d), Math.max(0, dur - len));
      slot.start = s; slot.end = Math.min(dur, s + len);
      paint(); seekPreview(slot.start); commit();
    });
  }

  /* 快速帧档：直接选 17k+5 网格上真实存活的长度 */
  if (isVideo && dur) {
    const quick = el("div", "gcast-quick");
    const untouched = () => slot.start <= 0.001 && slot.end >= dur - 0.001;
    gridSpans(dur).slice(0, 5).forEach((r) => {
      const b = el("button", null, `${r.g}f`);
      b.title = `${r.g} 帧（${fmt(r.sp)}）—— 拖动轨道可滑动窗口`;
      b.onclick = (e) => {
        e.stopPropagation();
        slot.start = untouched() ? Math.max(0, dur - r.sp) : Math.min(slot.start, Math.max(0, dur - r.sp));
        slot.end = Math.min(dur, slot.start + r.sp);
        paint(); seekPreview(slot.start); commit();
      };
      quick.append(b);
    });
    const bEnd = el("button", null, "\u203A 末尾");
    bEnd.title = "把窗口移到片段末尾，长度不变";
    bEnd.onclick = (e) => {
      e.stopPropagation();
      const len = slot.end - slot.start;
      slot.end = dur;
      slot.start = Math.max(0, dur - len);
      paint(); seekPreview(slot.start); commit();
    };
    quick.append(bEnd);
    wrap.append(quick);
  }
  return wrap;
}
