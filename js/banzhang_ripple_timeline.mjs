// Ripple timeline and geometry rules shared with ripple_core.py.

export const FPS = 24;
// Native MiniMax H3 accepts at most 3600 frames; 3592 is the last complete 17k+5 choice.
export const MAX_DURATION_FRAMES = 3592;
export const DURATION_OPTIONS = Array.from({ length: (MAX_DURATION_FRAMES - 5) / 17 + 1 }, (_, index) => {
    const frames = 5 + index * 17;
    return [frames, `${frames} 帧 · ${(frames / FPS).toFixed(2)} 秒`];
});

export function durationFrames(seconds) {
    const value = Number(seconds);
    return Number.isFinite(value) ? Math.max(5, 5 + 17 * Math.round((value * FPS - 5) / 17)) : 107;
}

// Resize a window around its opposite edge.
export function resizeWindow(available, start, length, side, frame) {
    const end = start + length;
    const limit = side === "left" ? end : available - start;
    const wanted = side === "left" ? end - frame : frame - start;
    const count = Math.min(MAX_DURATION_FRAMES, Math.max(5, durationFrames(wanted / FPS)), Math.max(5, 5 + 17 * Math.floor((limit - 5) / 17)));
    return { start: side === "left" ? end - count : start, length: count };
}

export function parseCrop(value) {
    let crop = value;
    try { if (typeof crop === "string") crop = crop ? JSON.parse(crop) : [0, 0, 1, 1]; } catch (_) { crop = null; }
    if (!Array.isArray(crop) || crop.length !== 4 || crop.some((n) => !Number.isFinite(Number(n)))) return [0, 0, 1, 1];
    const x = Math.min(1, Math.max(0, Number(crop[0]))), y = Math.min(1, Math.max(0, Number(crop[1])));
    const width = Math.min(1 - x, Number(crop[2])), height = Math.min(1 - y, Number(crop[3]));
    if (width <= 0 || height <= 0) return [0, 0, 1, 1];
    return [x, y, width, height].map((v) => Number(v.toFixed(8)));
}

export function cropForAspect(sourceAspect, targetAspect) {
    const ratio = targetAspect / sourceAspect;
    const width = Math.min(1, ratio), height = Math.min(1, 1 / ratio);
    return [(1 - width) / 2, (1 - height) / 2, width, height];
}

export function dragCrop(crop, handle, dx, dy, ratio = null) {
    const [x, y, width, height] = parseCrop(crop);
    if (handle === "move") return [Math.min(1 - width, Math.max(0, x + dx)), Math.min(1 - height, Math.max(0, y + dy)), width, height];
    const left = handle.includes("w"), top = handle.includes("n");
    let w = Math.min(left ? x + width : 1 - x, Math.max(0.02, width + (left ? -dx : dx)));
    let h = Math.min(top ? y + height : 1 - y, Math.max(0.02, height + (top ? -dy : dy)));
    if (ratio) {
        if (Math.abs(dx) >= Math.abs(dy * ratio)) h = w / ratio;
        else w = h * ratio;
        const scale = Math.min(1, (left ? x + width : 1 - x) / w, (top ? y + height : 1 - y) / h);
        w *= scale; h *= scale;
    }
    return [left ? x + width - w : x, top ? y + height - h : y, w, h];
}

// Same sizing as ripple_core: crop once, fit to a pixel budget, pad only for inference.
export function outputGeometry(width, height, settings = {}) {
    if (!(width > 0 && height > 0)) return null;
    const [x, y, w, h] = parseCrop(settings.crop);
    const x0 = Math.min(width - 1, Math.round(x * width)), y0 = Math.min(height - 1, Math.round(y * height));
    const cropWidth = Math.max(1, Math.min(width, Math.round((x + w) * width)) - x0);
    const cropHeight = Math.max(1, Math.min(height, Math.round((y + h) * height)) - y0);
    let scale = Number(settings.output_width) > 0 && Number(settings.output_height) > 0
        ? Math.min(Number(settings.output_width) / cropWidth, Number(settings.output_height) / cropHeight)
        : Math.sqrt(Number(settings.megapixels ?? 0.25) * 1e6 / (cropWidth * cropHeight));
    if (!settings.allow_upscale) scale = Math.min(1, scale);
    const resultWidth = Math.max(2, 2 * Math.floor(cropWidth * scale / 2)), resultHeight = Math.max(2, 2 * Math.floor(cropHeight * scale / 2));
    return { width: resultWidth, height: resultHeight,
        canvasWidth: Math.ceil(resultWidth / 32) * 32, canvasHeight: Math.ceil(resultHeight / 32) * 32,
        crop: [x0, y0, cropWidth, cropHeight] };
}

export function gridFrames(duration, firstTime = 0) {
    return Math.max(0, Math.floor(Math.max(0, duration - firstTime) * FPS + 0.5));
}

// Clamp a window into the source; never pads.
export function fitWindow(available, start, length) {
    if (available >= 5 && length > available) length = 17 * Math.floor((available - 5) / 17) + 5;
    const maxStart = Math.max(0, available - length);
    start = Math.min(Math.max(0, Math.round(start)), maxStart);
    return { start, length };
}

// Source time (seconds on the media timeline) at which the browser shows grid frame k. FFmpeg's
// fps=24 (round=near) filter keeps, for grid frame k, the last source frame that starts before the
// half-grid point (k + 0.5) / 24; a browser seeking just before that point shows the same frame.
export function seekTime(k, info) {
    const t = (info?.first_time ?? 0) + (k + 0.5) / FPS - 1e-4;
    const end = Math.max(0, (info?.duration ?? t) - 0.001);
    return Math.min(t, end);
}

// Grid frame shown at a media time (inverse of seekTime, for the playback playhead).
export function gridIndexAt(time, info) {
    return Math.max(0, Math.floor((time - (info?.first_time ?? 0)) * FPS + 1e-6));
}

export function timecode(seconds) {
    const s = Math.max(0, seconds);
    const minutes = Math.floor(s / 60);
    const rest = s - minutes * 60;
    return `${String(minutes).padStart(2, "0")}:${rest.toFixed(2).padStart(5, "0")}`;
}

// What a press at timeline x hits: the window body, or empty track.
export function hitTest(x, layout, start, length) {
    if (x >= layout.x(start) && x <= layout.x(start + length)) return "window";
    return "track";
}

// Linear frame <-> pixel mapping for a track spanning [left, left + width] over `total` frames.
export function makeLayout(left, width, total) {
    const span = Math.max(1, total);
    return {
        left, width, total: span,
        x: (frame) => left + (frame / span) * width,
        frame: (x) => ((x - left) / width) * span,
    };
}

// Tick spacing in seconds that keeps labels about 60 px apart.
export function tickStep(totalSeconds, width) {
    const steps = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
    const wanted = (totalSeconds / Math.max(1, width)) * 60;
    return steps.find((step) => step >= wanted) ?? 1200;
}
