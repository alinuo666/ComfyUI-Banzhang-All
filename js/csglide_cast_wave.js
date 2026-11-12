import { api } from "../../scripts/api.js";
import { FPS, fmtSecs } from "./csglide_cast_core.js";
import { el, viewURL } from "./csglide_ui_kit.js";

/* ============================================================
 * 波形 与 素材修剪
 * ------------------------------------------------------------
 * 从 csglide_cast.js 的 buildUI 里整块搬出来。
 *
 * 跨块的东西一律走 ui.<名>：ui 是 buildUI 建的那一个共享 bag。可变状态
 * 在它上面只有一个字段，所以本文件与别的模块改的是同一份。
 * 本块自己声明的东西保持裸名（函数声明要靠提升），末尾统一挂到 ui 上，
 * 顺序与原来在 buildUI 里的先后一致 —— 搬出去之后，谁先声明谁后声明没变。
 * ============================================================ */

export function installWave(ui) {
  /* ---- waveforms ---------------------------------------------------
   * Decoded once per file and cached. decodeAudioData handles whatever the
   * browser can play, so an mp4's soundtrack works as well as a wav.
   */
  const wavCache = new Map();

  /* trim() re-wires transport listeners on every render. On a NEW element that
   * is free; on a reused one they would stack up, so every added listener is
   * recorded and cleared before the slot is wired again. */
  function onMedia(m, ev, fn) {
    (m.__gcastL || (m.__gcastL = [])).push([ev, fn]);
    m.addEventListener(ev, fn);
  }

  function peaksFor(file) {
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
        if (peak > 0) for (let i = 0; i < N; i++) out[i] /= peak;   // normalise for display
        return out;
      } finally { ctx.close?.(); }
    })().catch(() => null);
    wavCache.set(file, job);
    return job;
  }

  function drawWave(cv, peaks) {
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

  /* Reference videos are re-snapped DOWN to the 17k+5 grid after trimming, so a
   * 20-frame trim silently becomes 5. Handles stay free; the readout tells the
   * truth about what survives. */
  const gridDown = (n) => { let g = Math.floor(n); while (g > 0 && g % 17 !== 5) g--; return g; };
  const effFrames = (span, capFrames) => {
    let want = Math.max(0, Math.round(span * FPS) + 1);
    if (capFrames) want = Math.min(want, capFrames);
    return gridDown(want);
  };
  const gridSpans = (dur) => {
    const out = [];
    for (let g = 5; ; g += 17) {
      const sp = (g - 1) / FPS;
      if (sp > dur) break;
      out.push({ g, sp });
    }
    return out;
  };

  /* dual-handle trim, in seconds, clamped to the clip's own duration */
  function trim(slot, usedSeconds, isVideo, media, label, tailOnly) {
    const wrap = el("div", "gcast-trim");
    const track = el("div", "gcast-track");
    const wave = el("canvas", "gcast-wave");
    const head = el("div", "gcast-head");
    const span = el("div", "gcast-span");
    const hA = el("div", "gcast-h a"); hA.tabIndex = 0; hA.title = "修剪起点";
    const hB = el("div", "gcast-h b"); hB.tabIndex = 0; hB.title = "修剪终点";
    const used = el("div", "gcast-used");
    track.append(wave, span, used, head, hA, hB);
    /* Chroma sits ON the waveform, at the left, because that is where the eye
     * already is when judging the window. Green for 4:4:4 and 4:2:2, which
     * both anchored cleanly in testing; amber-red for 4:2:0, which made Glide
     * Join report a frame correction on every run. */
    if (slot.chroma) {
      const weak = slot.chroma === ui.CHROMA_WARN;
      const chip = el("div", "gcast-chroma" + (weak ? " weak" : ""), slot.chroma);
      chip.title = weak
        ? `${slot.codec || "源"} ${slot.chroma} —— 色度亚采样：进入模型的参考只保留四分之一的色度信息。`
        : `${slot.codec || "源"} ${slot.chroma}`;
      track.append(chip);
    }
    if (label) track.append(el("div", "gcast-wavlabel", label));
    const times = el("div", "gcast-times");
    const play = el("button", "gcast-play", "\u25B6");
    play.title = "播放修剪区间";
    const tL = el("span"), tR = el("span");
    times.append(play, tL, tR);
    wrap.append(track, times);

    /* waveform: draw once decoded, and again if the node is resized */
    if (slot.file) {
      peaksFor(slot.file).then((pk) => drawWave(wave, pk));
      try {
        const ro = new ResizeObserver(() => {
          peaksFor(slot.file).then((pk) => drawWave(wave, pk));
        });
        ro.observe(track);
      } catch (e) { /* older browser: static draw is fine */ }
    }

    /* transport: play only what is selected, and stop at the out point */
    let raf = 0;
    const stopAt = () => {
      if (!media || media.paused) return false;
      /* the out point is enforced here rather than on timeupdate, which
       * only fires ~4x a second and overshoots audibly */
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
    const capFrames = usedSeconds != null ? Math.round(usedSeconds * FPS) : null;

    if (!Number.isFinite(slot.start) || slot.start < 0 || slot.start >= dur) slot.start = 0;
    if (!Number.isFinite(slot.end) || slot.end > dur || slot.end <= slot.start) slot.end = dur;

    const paint = () => {
      if (!dur) return;
      const a = (slot.start / dur) * 100, b = (slot.end / dur) * 100;
      span.style.left = a + "%"; span.style.width = Math.max(0, b - a) + "%";
      hA.style.left = a + "%"; hB.style.left = b + "%";
      tL.textContent = isVideo
        ? `${fmtSecs(slot.start)}  f${Math.round(slot.start * FPS)}`
        : fmtSecs(slot.start);
      const len = slot.end - slot.start;

      if (!isVideo) {
        tR.textContent = fmtSecs(len);
        tR.className = "";
        used.style.display = "none";
        return;
      }
      const f = effFrames(len, capFrames);
      const clipped = capFrames != null && Math.round(len * FPS) + 1 > capFrames;
      const clip = Math.max(0, Math.round(len * FPS) + 1 - f);
      tR.textContent = f < 5 ? "太短——至少5帧" : `已用${f}帧·${fmtSecs(len)}·裁${clip}`;
      tR.className = (f < 5 || clipped) ? "gcast-warn" : "";
      if (clipped) {
        used.style.display = "";
        used.style.left = ((slot.start + capFrames / FPS) / dur) * 100 + "%";
      } else used.style.display = "none";
    };
    paint();

    /* Park the video on a given time so the thumbnail shows the frame you are
     * pointing at. Hunting for a readable 5-22f window is done by eye, so the
     * picture has to follow the window, not the other way round. Coalesced to
     * one seek per frame - seeking on every pointermove stutters. */
    let seekReq = 0;
    const seekPreview = (t) => {
      if (!media || media.tagName !== "VIDEO") return;
      cancelAnimationFrame(seekReq);
      seekReq = requestAnimationFrame(() => {
        try {
          if (!media.paused) media.pause();
          media.currentTime = Math.min(Math.max(0, t), Math.max(0, dur - 1 / FPS));
        } catch (_) { /* not seekable yet */ }
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

      /* LiteGraph's canvas consumes pointer/mouse moves, so listen in the
       * CAPTURE phase on document and take pointer capture on the handle. */
      const move = (e) => {
        if (!dragging) return;
        e.preventDefault(); e.stopPropagation();
        apply(e.clientX);
      };
      const up = (e) => {
        if (!dragging) return;
        dragging = false;
        try { handle.releasePointerCapture(e.pointerId); } catch (_) {}
        document.removeEventListener("pointermove", move, true);
        document.removeEventListener("pointerup", up, true);
        document.removeEventListener("mousemove", moveMouse, true);
        document.removeEventListener("mouseup", up, true);
        ui.commit();
      };
      const moveMouse = (e) => { if (dragging) apply(e.clientX); };

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
        paint(); ui.commit();
      });
    };
    /* A continuation window is not free to sit anywhere: it has to END on the
     * previous clip's last frame or the new clip continues from the wrong
     * instant, and the two pieces are then not adjacent in time. Length is the
     * only choice, so the handles and the slide are off in that mode. */
    if (!tailOnly) { drag(hA, true); drag(hB, false); }
    else { hA.style.display = "none"; hB.style.display = "none"; }

    /* Slide the whole window by dragging the track, length preserved.
     *
     * This is bound to the TRACK, not to the span. At the sizes that matter
     * here a 5f window is a few pixels wide and sits entirely underneath the
     * two 11px handles, so the span itself is not a grabbable target. Landing
     * inside the current window keeps the grab offset so the block moves under
     * the finger; landing outside jumps the window to the pointer.
     *
     * The handles stopPropagation on pointerdown, so resizing still wins over
     * sliding. Same capture-phase document listeners as the handles, for the
     * same reason - LiteGraph's canvas eats the move stream otherwise. */
    if (dur && !tailOnly) {
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

      const sMove = (e) => {
        if (!sliding) return;
        e.preventDefault(); e.stopPropagation();
        place(e.clientX);
      };
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
        ui.commit();
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

      /* Arrow keys nudge the window a frame at a time, Shift a second. */
      track.tabIndex = 0;
      track.addEventListener("keydown", (e) => {
        if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
        e.preventDefault(); e.stopPropagation();
        const len = slot.end - slot.start;
        const d = (e.key === "ArrowLeft" ? -1 : 1) * (e.shiftKey ? 1 : 1 / FPS);
        const s = Math.min(Math.max(0, slot.start + d), Math.max(0, dur - len));
        slot.start = s; slot.end = Math.min(dur, s + len);
        paint(); seekPreview(slot.start); ui.commit();
      });
    }

    /* Span picks set an exact grid length - the values that survive the 17k+5
     * re-snap, so nothing is silently thrown away.
     *
     * An untouched clip (still the full range) gets the tail, which is what a
     * chunk continuation wants. Once the window has been moved the pick keeps
     * the position and only changes the length, because the expensive part is
     * finding the moment and re-finding it after every size change was the
     * annoyance. "> end" pins to the tail on demand. */
    if (isVideo && dur) {
      const quick = el("div", "gcast-quick");
      const untouched = () => slot.start <= 0.001 && slot.end >= dur - 0.001;
      gridSpans(dur).slice(0, 5).forEach((r) => {
        const b = el("button", null, `${r.g}f`);
        b.title = tailOnly
          ? `承接末尾 ${r.g} 帧（${fmtSecs(r.sp)}）`
          : `${r.g} 帧（${fmtSecs(r.sp)}）—— 拖动轨道可滑动窗口`;
        b.onclick = (e) => {
          e.stopPropagation();
          slot.start = (tailOnly || untouched())
            ? Math.max(0, dur - r.sp)
            : Math.min(slot.start, Math.max(0, dur - r.sp));
          slot.end = Math.min(dur, slot.start + r.sp);
          paint(); seekPreview(slot.start); ui.commit();
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
        paint(); seekPreview(slot.start); ui.commit();
      };
      if (!tailOnly) quick.append(bEnd);   // a tail window is always at the end
      wrap.append(quick);
    }
    return wrap;
  }

  /* 潜空间续写：从中央系统读取当前段的上一段 cont 与同次分段视频。
     不再扫描 output/h3_context，也不按全局最新输出猜预览。 */
  async function adoptLastLatent() {
    const r = await api.fetchApi("/banzhang/h3mc/latest_latent", { method: "POST" });
    if (r.status !== 200) throw new Error(`查询最新续拍存档失败 (${r.status})`);
    const j = await r.json();
    if (!j || !j.found) return null;
    return { path: String(j.path), preview: j.preview || null };
  }

  /* 预览对象 → 相对 output 的视频路径。潜空间档把它兼作「源视频」输出，
     供「Glide 续接合成」拼长片——潜空间档用独立的 cont.latent_video 字段，
     与文件档的 cont.file（input 拷贝）分开，切档互不污染。 */
  const latentVideoPath = (p) => (p && p.name)
    ? ((p.subfolder ? p.subfolder + "/" : "") + p.name) : "";

  /* 把最新存档写进续写槽位：存档路径 + 预览 + 源视频一起刷新。
     「引用上次片段」按钮与工程连续渲染共用这一份，改字段只改这里。 */
  function applyLatentAdoption(c, got) {
    if (!got) return false;
    c.latent_file = got.path;
    /* 预览用的成片顺手兼作「源视频」输出：潜空间档的续写算术不读它，
       后端把它从「源视频」端口吐出去供拼接。 */
    if (got.preview && got.preview.name) {
      c.latent_preview = got.preview;
      c.latent_video = latentVideoPath(got.preview);
    } else { delete c.latent_preview; delete c.latent_video; }
    return true;
  }


  /* 挂出去：别的块通过 ui.<名> 取。放在最后 —— 等同于原来在这一块
     结束时才声明完，之前的块拿不到，之后的块拿得到。 */
  Object.assign(ui, { wavCache, onMedia, peaksFor, drawWave, gridDown, effFrames, gridSpans, trim, adoptLastLatent, latentVideoPath, applyLatentAdoption });
}
