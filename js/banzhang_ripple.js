// Ripple preview, crop controls and timeline.
import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import {
    DURATION_OPTIONS, FPS, MAX_DURATION_FRAMES, cropForAspect, dragCrop, durationFrames, fitWindow, gridFrames,
    gridIndexAt, hitTest, makeLayout, outputGeometry, parseCrop, resizeWindow, seekTime, tickStep, timecode,
} from "./banzhang_ripple_timeline.mjs";

const MARGIN = 14;
const TRACK_TOP = 50;
const TRACK_HEIGHT = 30;
const HEIGHT = 112;

const CROP_LABELS = { Original: "原始比例", "16:9": "16:9", "9:16": "9:16", "1:1": "1:1", Custom: "自定义" };

const SETTINGS = ["duration", "megapixels", "crop", "allow_upscale", "resize_method", "output_width", "output_height"];
const SAVED = ["window_start", ...SETTINGS];
const widgetOf = (node, name) => node.widgets?.find((widget) => widget.name === name);
const stylesheet = document.createElement("link");
stylesheet.rel = "stylesheet";
stylesheet.href = new URL("./banzhang_ripple.css", import.meta.url).href;
document.head.append(stylesheet);

function hideWidget(widget) {
    if (!widget || widget._wnHidden) return;
    widget._wnHidden = true;
    widget.hidden = true;
    widget.computeSize = () => [0, -4];
    widget.draw = () => {};
    widget.mouse = () => false;
}

function setValue(node, name, value) {
    const widget = widgetOf(node, name);
    if (!widget || widget.value === value) return;
    widget.value = value;
    widget.callback?.(value, app.canvas, node);
}

// Keep the selection in node.properties too, so it survives reloads whatever the widget order.
function remember(node) {
    node.properties ??= {};
    node.properties.wn_ripple = Object.fromEntries(SAVED.map((name) => [name, widgetOf(node, name)?.value]));
}

function restore(node) {
    const saved = node.properties?.wn_ripple;
    if (!saved) return;
    for (const name of SAVED) {
        const widget = widgetOf(node, name);
        if (!widget || saved[name] === undefined) continue;
        widget.value = saved[name];
    }
}

function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
        if (key === "style") Object.assign(node.style, value);
        else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
        else node.setAttribute(key, value);
    }
    for (const child of children) if (child != null) node.append(child);
    if (tag === "input" && attrs.type === "number" && attrs.onchange) node.addEventListener("keydown", (event) => {
        if (event.key !== "Enter") return;
        event.preventDefault(); event.stopPropagation();
        attrs.onchange({ target: node });
        node.blur();
    });
    return node;
}

function installRipple(node) {
    const state = {
        info: null, video: null, request: 0, player: null, playing: false, drag: null, customMP: false,
        pendingSeek: null, panelHeight: 110, renderQueued: false, durationRequest: 0, measured: false,
        cropEditing: false, cropRatio: "Original", cropDrag: null, previewObservers: [], removed: false,
    };
    for (const name of SAVED) hideWidget(widgetOf(node, name));
    const settings = () => Object.fromEntries(SETTINGS.map((name) => [name, widgetOf(node, name)?.value]));
    const geometry = () => state.info && !state.info.error ? outputGeometry(state.info.width, state.info.height, settings()) : null;
    const cropValue = () => parseCrop(widgetOf(node, "crop")?.value);
    let cropOverlay = null, cropBox = null, cropObserver = null;

    const current = () => {
        const available = state.info && !state.info.error ? gridFrames(state.info.duration, state.info.first_time) : 0;
        const requested = Math.min(MAX_DURATION_FRAMES, durationFrames(widgetOf(node, "duration")?.value));
        const start = Number(widgetOf(node, "window_start")?.value) || 0;
        const fitted = available ? fitWindow(available, start, requested) : { start, length: requested };
        return { available, requested, ...fitted };
    };

    function commit(start) {
        const now = current();
        const fitted = now.available ? fitWindow(now.available, start, now.length) : { start, length: now.length };
        state.durationRequest = 0;
        setValue(node, "duration", (fitted.length ?? now.length) / FPS);
        setValue(node, "window_start", fitted.start);
        remember(node);
        requestRender();
        node.setDirtyCanvas?.(true, true);
    }

    function resizeShot(next) {
        setValue(node, "duration", next.length / FPS);
        commit(next.start);
    }

    function changeDuration(seconds) {
        if (!(Number(seconds) > 0)) return;
        const now = current();
        const requested = durationFrames(seconds);
        resizeShot(resizeWindow(now.available, now.start, now.length, "right", now.start + requested));
        state.durationRequest = requested;
    }

    function changeSetting(name, value) {
        setValue(node, name, value);
        if (name === "megapixels") { setValue(node, "output_width", 0); setValue(node, "output_height", 0); }
        remember(node); updateCropOverlay(); requestRender(); node.setDirtyCanvas?.(true, true);
    }

    // The panel is rebuilt at most once per animation frame (dragging commits on every mouse move).
    function requestRender() {
        if (state.renderQueued || state.removed) return;
        state.renderQueued = true;
        const run = () => { if (!state.renderQueued || state.removed) return; state.renderQueued = false; renderPanel(); };
        requestAnimationFrame(run);
        setTimeout(run, 120); // background tabs pause animation frames
    }

    // ---- preview player ----------------------------------------------------------------------
    function showFrame(k) {
        const player = state.player;
        if (!player || !state.info || state.info.error) return;
        const time = seekTime(k, state.info);
        if (player.seeking) { state.pendingSeek = time; return; }
        player.currentTime = time;
    }

    // 点击预览播放/暂停；声音直接用 <video> 自带音轨，天然音画同步。
    function togglePlay() {
        const player = state.player;
        if (!player || !state.info || state.info.error) return;
        if (!player.paused) { player.pause(); return; }
        const { start, length } = current();
        const k = gridIndexAt(player.currentTime, state.info);
        if (player.muted) player.muted = false;
        if (k < start || k >= start + length) player.currentTime = seekTime(start, state.info);
        player.play().catch(() => {});
    }

    function updateCropOverlay() {
        if (!cropOverlay || !state.player) return;
        const host = cropOverlay.parentElement;
        const aspect = state.info?.width / state.info?.height || state.player.videoWidth / state.player.videoHeight || 16 / 9;
        const width = Math.min(host.clientWidth, host.clientHeight * aspect), height = width / aspect;
        Object.assign(cropOverlay.style, { width: `${width}px`, height: `${height}px`, left: `${(host.clientWidth - width) / 2}px`, top: `${(host.clientHeight - height) / 2}px` });
        cropOverlay.hidden = !state.cropEditing && !widgetOf(node, "crop")?.value;
        cropOverlay.classList.toggle("is-editing", state.cropEditing);
        const [x, y, w, h] = cropValue();
        Object.assign(cropBox.style, { left: `${x * 100}%`, top: `${y * 100}%`, width: `${w * 100}%`, height: `${h * 100}%` });
    }

    function setCrop(crop) {
        setValue(node, "crop", crop ? JSON.stringify(parseCrop(crop).map((v) => Number(v.toFixed(8)))) : "");
        remember(node);
        updateCropOverlay();
        requestRender();
        node.setDirtyCanvas?.(true, true);
    }

    function attachCropOverlay(player) {
        const host = player.parentElement;
        if (!host || host === cropOverlay?.parentElement) { updateCropOverlay(); return; }
        cropObserver?.disconnect();
        cropOverlay?.remove();
        host.classList.add("bz-ripple-video");
        cropBox = el("div", { class: "ripple-crop-box", "aria-label": "裁剪区域" });
        for (const handle of ["nw", "ne", "sw", "se"]) cropBox.append(el("span", { class: `ripple-crop-handle ${handle}`, "data-crop-handle": handle }));
        cropOverlay = el("div", { class: "ripple-crop-overlay" }, cropBox);
        host.append(cropOverlay);
        cropOverlay.addEventListener("pointerdown", (event) => {
            if (!state.cropEditing || event.button !== 0) return;
            event.preventDefault(); event.stopPropagation();
            const bounds = cropOverlay.getBoundingClientRect();
            state.cropDrag = { crop: cropValue(), handle: event.target.dataset.cropHandle || "move", x: event.clientX, y: event.clientY, width: bounds.width, height: bounds.height };
            cropOverlay.setPointerCapture(event.pointerId);
        });
        cropOverlay.addEventListener("pointermove", (event) => {
            if (!state.cropDrag) return;
            event.preventDefault(); event.stopPropagation();
            const drag = state.cropDrag;
            const preset = state.cropRatio === "Original" ? state.info.width / state.info.height : state.cropRatio === "Custom" ? null : state.cropRatio.split(":").map(Number).reduce((a, b) => a / b);
            const ratio = preset ? preset / (state.info.width / state.info.height) : null;
            setCrop(dragCrop(drag.crop, drag.handle, (event.clientX - drag.x) / drag.width, (event.clientY - drag.y) / drag.height, ratio));
        });
        const finish = (event) => {
            if (!state.cropDrag) return;
            event.stopPropagation(); state.cropDrag = null;
            if (cropOverlay.hasPointerCapture(event.pointerId)) cropOverlay.releasePointerCapture(event.pointerId);
        };
        cropOverlay.addEventListener("pointerup", finish);
        cropOverlay.addEventListener("pointercancel", finish);
        cropObserver = new ResizeObserver(updateCropOverlay);
        cropObserver.observe(host);
        updateCropOverlay();
    }

    function attachPlayer(player) {
        if (state.player === player) { attachCropOverlay(player); return; }
        state.player = player;
        player.autoplay = false; player.muted = true; player.loop = false; player.controls = false; player.playsInline = true;
        player.pause();
        attachCropOverlay(player);
        player.addEventListener("seeked", () => {
            if (state.pendingSeek != null) { const time = state.pendingSeek; state.pendingSeek = null; player.currentTime = time; }
        });
        player.addEventListener("loadeddata", () => {
            showFrame(current().start);
            updateCropOverlay();
        });
        player.style.cursor = "pointer";
        player.title = "点击播放 / 暂停选中片段（带声音）";
        player.addEventListener("click", togglePlay);
        player.addEventListener("play", () => { state.playing = true; node.setDirtyCanvas?.(true, true); });
        player.addEventListener("pause", () => { state.playing = false; node.setDirtyCanvas?.(true, true); });
        player.addEventListener("timeupdate", () => {
            if (!state.playing) return;
            const { start, length } = current();
            const k = gridIndexAt(player.currentTime, state.info);
            if (k >= start + length || k < start) player.currentTime = seekTime(start, state.info);
            node.setDirtyCanvas?.(true, false);
        });
    }

    function placePreview(widget) {
        const timeline = node.widgets?.findIndex((w) => w.name === "ripple_timeline");
        const position = node.widgets?.indexOf(widget);
        if (timeline >= 0 && position > timeline) {
            node.widgets.splice(position, 1);
            node.widgets.splice(timeline, 0, widget);
            node.setDirtyCanvas?.(true, true);
        }
    }

    function sizePreview(widget) {
        if (widget._wnRippleSized) return;
        widget._wnRippleSized = true;
        queueMicrotask(() => {
            widget.computeLayoutSize = () => {
                const video = state.player;
                const aspect = video?.videoWidth && video.videoHeight ? video.videoWidth / video.videoHeight : 16 / 9;
                const margin = widget.margin ?? 10;
                const height = Math.max(120, Math.min(260, (node.size[0] - 2 * margin) / aspect)) + 2 * margin;
                return { minHeight: height, maxHeight: height, minWidth: 0 };
            };
            node.setSize?.([node.size[0], node.computeSize()[1]]);
            node.setDirtyCanvas?.(true, true);
        });
    }

    // The core video_upload combo adds a "video" DOM widget with a <video>; take it over.
    const addDOMWidget = node.addDOMWidget;
    node.addDOMWidget = function (name, type, element) {
        const widget = addDOMWidget.apply(this, arguments);
        if (type === "video") {
            const grab = () => {
                const player = element.querySelector?.("video") ?? (element.tagName === "VIDEO" ? element : null);
                if (!player) return;
                attachPlayer(player);
                sizePreview(widget);
            };
            const observer = new MutationObserver(grab);
            observer.observe(element, { childList: true, subtree: true });
            state.previewObservers.push(observer);
            grab();
            placePreview(widget);
        }
        return widget;
    };
    const findExisting = () => {
        for (const widget of node.widgets ?? []) {
            const player = widget.element?.querySelector?.("video");
            if (player) { attachPlayer(player); placePreview(widget); sizePreview(widget); }
        }
    };

    // ---- source facts --------------------------------------------------------------------------
    function fetchInfo(video, attempt = 0) {
        if (state.removed) return;
        const request = ++state.request;
        state.video = video;
        state.info = null;
        requestRender();
        if (!video) return;
        api.fetchApi(`/banzhang/ripple/info?video=${encodeURIComponent(video)}`)
            .then(async (response) => ({ ok: response.ok, data: await response.json().catch(() => ({})) }))
            .catch(() => ({ ok: false, data: { error: "连不上 ComfyUI 后端。" } }))
            .then(({ ok, data }) => {
                if (request !== state.request || state.removed) return;
                if (!ok && attempt < 8) {
                    setTimeout(() => { if (request === state.request) fetchInfo(video, attempt + 1); }, 300 * (attempt + 1));
                    return;
                }
                state.info = ok ? data : { error: data.error || "读不出这个视频。" };
                const now = current();
                commit(now.start);
                state.durationRequest = now.requested;
                findExisting();
                updateCropOverlay();
            });
    }

    // ---- selection panel (DOM) -------------------------------------------------------------------
    const panel = el("div", { class: "bz-ripple-panel" });
    const content = el("div", { class: "ripple-content" });
    panel.append(content);

    function sizingControls(now, canvas) {
        const options = (values, selected) => values.map(([value, label]) => el("option", { value, ...(String(value) === String(selected) ? { selected: "" } : {}) }, label));
        const value = Number(widgetOf(node, "megapixels")?.value) || 0.25;
        const preset = [0.25, 0.5, 1].includes(value) ? String(value) : "custom";
        const size = el("label", { class: "ripple-field" }, el("span", {}, "输出分辨率"), el("select", {
            "aria-label": "百万像素", "data-ripple-focus": "size", onchange: (event) => {
                if (event.target.value === "custom") { state.customMP = true; requestRender(); }
                else { state.customMP = false; changeSetting("megapixels", Number(event.target.value)); }
            },
        }, ...options([["0.25", "0.25 MP"], ["0.5", "0.5 MP"], ["1", "1 MP"], ["custom", "自定义"]], state.customMP ? "custom" : preset)));
        if (state.customMP || preset === "custom") size.append(el("input", { type: "number", min: "0.01", step: "0.05", value,
            "aria-label": "自定义百万像素", "data-ripple-focus": "megapixels", onchange: (event) => {
                const next = Number(event.target.value); if (next > 0) changeSetting("megapixels", next);
            } }));
        const duration = el("label", { class: "ripple-field" }, el("span", {}, "片段时长"), el("select", {
            "aria-label": "帧数与秒数", "data-ripple-focus": "duration",
            onchange: (event) => changeDuration(Number(event.target.value) / FPS),
        }, ...options(DURATION_OPTIONS, now.length)));
        const cropped = Boolean(widgetOf(node, "crop")?.value);
        const framing = el("label", { class: "ripple-field" }, el("span", {}, "原片裁剪"), el("select", {
            "data-ripple-focus": "framing", onchange: (event) => {
                state.cropEditing = event.target.value === "crop";
                setCrop(state.cropEditing ? cropValue() : null);
            },
        }, ...options([["original", "原始画面"], ["crop", "手动裁剪"]], cropped ? "crop" : "original")));
        const config = settings();
        const uncapped = outputGeometry(state.info.width, state.info.height, { ...config, allow_upscale: true });
        const sourceLimited = !config.allow_upscale && (uncapped.width > canvas.width || uncapped.height > canvas.height);
        const group = el("div", { class: "ripple-sizing" }, el("div", { class: "ripple-settings" }, size, framing, duration),
            el("span", { class: "ripple-meta" }, `${canvas.width} × ${canvas.height} · ${(canvas.width * canvas.height / 1e6).toFixed(2)} MP · ${now.length} 帧 · ${FPS} fps${sourceLimited ? " · 受源片尺寸限制" : ""}`));
        if (Math.max(now.requested, state.durationRequest) > now.length) group.append(el("span", { class: "ripple-meta" },
            `源片仅剩 ${((now.available - now.start) / FPS).toFixed(2)} 秒，已改用 ${now.length} 帧 · ${(now.length / FPS).toFixed(2)} 秒。`));
        if (cropped) {
            const controls = el("div", { class: "ripple-actions" }, el("button", {
                type: "button", "data-ripple-focus": "crop-edit", onclick: () => { state.cropEditing = !state.cropEditing; updateCropOverlay(); requestRender(); },
            }, state.cropEditing ? "完成裁剪" : "调整裁剪"));
            if (state.cropEditing) controls.append(el("select", { "aria-label": "裁剪宽高比", "data-ripple-focus": "crop-aspect", onchange: (event) => {
                state.cropRatio = event.target.value;
                if (state.cropRatio !== "Custom") {
                    const source = state.info.width / state.info.height;
                    const ratio = state.cropRatio === "Original" ? source : state.cropRatio.split(":").map(Number).reduce((a, b) => a / b);
                    setCrop(cropForAspect(source, ratio));
                }
            } }, ...options(["Original", "16:9", "9:16", "1:1", "Custom"].map((item) => [item, CROP_LABELS[item]]), state.cropRatio)));
            group.append(controls);
        }
        return group;
    }

    function renderPanel() {
        const now = current();
        const focusKey = panel.contains(document.activeElement) ? document.activeElement?.dataset.rippleFocus : null;
        content.replaceChildren();
        if (!state.info || state.info.error) {
            content.append(el("div", { class: "ripple-empty" },
                el("strong", {}, state.info?.error ? "视频不可用" : "先准备一段短视频"),
                el("span", {}, state.info?.error ?? "在上方上传视频，拖时间轴选好片段。")));
            resize();
            return;
        }
        content.append(sizingControls(now, geometry()));
        updateCropOverlay();
        resize();
        if (focusKey) panel.querySelector(`[data-ripple-focus="${focusKey}"]`)?.focus({ preventScroll: true });
    }
    const panelWidget = node.addDOMWidget?.("ripple_panel", "div", panel, {
        serialize: false, hideOnZoom: false,
        getMinHeight: () => state.panelHeight, getMaxHeight: () => state.panelHeight,
    });
    function resize() {
        const previousHeight = state.panelHeight;
        if (content.offsetHeight) state.panelHeight = content.offsetHeight + 16;
        if (panelWidget) panelWidget.computeSize = (width) => [width ?? 360, state.panelHeight];
        const size = node.computeSize?.();
        if (size && node.size) {
            const height = Math.max(size[1], node.size[1] + (state.measured ? state.panelHeight - previousHeight : 0));
            if (height !== node.size[1]) node.setSize?.([node.size[0], height]);
        }
        state.measured = Boolean(content.offsetHeight);
        node.setDirtyCanvas?.(true, true);
    }
    const panelObserver = new ResizeObserver(resize);
    panelObserver.observe(content);

    // ---- timeline (canvas) -----------------------------------------------------------------------
    const widget = {
        name: "ripple_timeline", type: "bz_ripple_timeline", value: "", serialize: false, options: { serialize: false },
        computeSize: (width) => [width ?? 360, HEIGHT],
        draw(ctx, _node, width, y) {
            const video = widgetOf(node, "video")?.value;
            if (video !== state.video) fetchInfo(video);
            if (!state.player) findExisting();
            this._y = y;
            const now = current();
            const layout = makeLayout(MARGIN, width - MARGIN * 2, Math.max(now.available, now.start + now.length));
            this._layout = layout;
            const styles = getComputedStyle(panel);
            const theme = { text: styles.color, muted: styles.getPropertyValue("--ripple-muted").trim(),
                track: styles.getPropertyValue("--ripple-surface").trim() };
            ctx.save();
            ctx.font = "11px Arial, sans-serif";
            ctx.textBaseline = "middle";
            if (!state.info || state.info.error) {
                ctx.fillStyle = state.info?.error ? "#e0a050" : "#8a8a8a";
                ctx.fillText(state.info?.error ?? (video ? "正在读取视频…" : "请加载视频"), MARGIN, y + HEIGHT / 2);
                ctx.restore();
                return;
            }
            const top = y + TRACK_TOP;
            ctx.fillStyle = theme.track;
            ctx.fillRect(layout.left, top, layout.width, TRACK_HEIGHT);
            const seconds = now.available / FPS;
            const step = tickStep(seconds, layout.width);
            ctx.fillStyle = theme.muted; ctx.textAlign = "center"; ctx.font = "11px sans-serif";
            for (let s = 0; s <= seconds + 1e-6; s += step) {
                const x = layout.x(s * FPS);
                ctx.fillRect(x, top + TRACK_HEIGHT - 5, 1, 5);
                ctx.fillText(timecode(s).replace(/\.00$/, ""), Math.min(Math.max(x, layout.left + 14), layout.left + layout.width - 14), y + 27);
            }
            const wx = layout.x(now.start);
            const ww = Math.max(3, layout.x(now.start + now.length) - wx);
            ctx.fillStyle = "rgba(80, 150, 255, 0.28)";
            ctx.fillRect(wx, top, ww, TRACK_HEIGHT);
            ctx.strokeStyle = "rgba(120, 180, 255, 0.95)"; ctx.lineWidth = 1.5;
            ctx.strokeRect(wx + 0.5, top + 0.5, ww - 1, TRACK_HEIGHT - 1);
            ctx.fillStyle = "rgba(120, 180, 255, 0.95)";
            ctx.fillRect(wx, top + 9, 4, TRACK_HEIGHT - 18);
            ctx.fillRect(wx + ww - 4, top + 9, 4, TRACK_HEIGHT - 18);
            if (state.playing && state.player) {
                const k = gridIndexAt(state.player.currentTime, state.info);
                ctx.fillStyle = "rgba(255,255,255,0.75)";
                ctx.fillRect(layout.x(k + 0.5) - 0.5, top, 1, TRACK_HEIGHT);
            }
            ctx.textAlign = "left"; ctx.fillStyle = theme.text; ctx.font = "12px sans-serif";
            ctx.fillText("选取片段", MARGIN, y + 9);
            ctx.textAlign = "right"; ctx.fillStyle = theme.muted; ctx.font = "11px sans-serif";
            ctx.fillText(`${timecode(now.start / FPS)}–${timecode((now.start + now.length) / FPS)}`, width - MARGIN, y + 9);
            ctx.textAlign = "left";
            ctx.fillText("拖动片段 · 拖两端裁剪 · 点击预览播放（带声音）", MARGIN, y + 100, width - MARGIN * 2);
            ctx.restore();
        },
        mouse(event, pos) {
            const now = current();
            const layout = this._layout;
            if (!layout || !state.info || state.info.error) return false;
            const localY = pos[1] - (this._y ?? 0);
            const type = event.type;
            if (type === "pointerdown" || type === "mousedown") {
                if (localY < TRACK_TOP - 18 || localY > TRACK_TOP + TRACK_HEIGHT + 6) return false;
                const onBody = localY >= TRACK_TOP + 7 && localY <= TRACK_TOP + TRACK_HEIGHT - 7;
                const edge = onBody && Math.abs(pos[0] - layout.x(now.start)) <= 7 ? "left"
                    : onBody && Math.abs(pos[0] - layout.x(now.start + now.length)) <= 7 ? "right" : null;
                if (edge) {
                    state.drag = { kind: "resize", edge, before: now };
                } else if (hitTest(pos[0], layout, now.start, now.length) === "window") {
                    state.drag = { kind: "window", grab: layout.frame(pos[0]) - now.start };
                } else {
                    const frame = Math.round(layout.frame(pos[0]));
                    commit(frame - Math.floor(now.length / 2));
                    state.drag = { kind: "window", grab: Math.floor(now.length / 2) };
                }
                return true;
            }
            if (type === "pointermove" || type === "mousemove") {
                if (!state.drag) return false;
                const frame = layout.frame(pos[0]);
                if (state.drag.kind === "resize") {
                    const before = state.drag.before;
                    resizeShot(resizeWindow(now.available, before.start, before.length, state.drag.edge, Math.round(frame)));
                } else if (state.drag.kind === "window") commit(Math.round(frame - state.drag.grab));
                return true;
            }
            if (type === "pointerup" || type === "mouseup") {
                const dragging = Boolean(state.drag);
                state.drag = null;
                return dragging;
            }
            return false;
        },
    };
    node.addCustomWidget ? node.addCustomWidget(widget) : node.widgets?.push(widget);
    if (node.widgets && panelWidget) {
        const ti = node.widgets.indexOf(widget), pi = node.widgets.indexOf(panelWidget);
        if (ti > pi && pi >= 0) { node.widgets.splice(ti, 1); node.widgets.splice(pi, 0, widget); }
    }

    // Shift+arrows move the window while this node is the only one selected.
    const onKey = (event) => {
        if (!event.shiftKey || !["ArrowLeft", "ArrowRight"].includes(event.key)) return;
        const tag = document.activeElement?.tagName;
        if (panel.contains(document.activeElement) || ["INPUT", "TEXTAREA", "SELECT", "BUTTON", "A"].includes(tag) || document.activeElement?.isContentEditable) return;
        const selected = app.canvas?.selected_nodes;
        if (!selected || !selected[node.id] || Object.keys(selected).length !== 1) return;
        const now = current();
        commit(now.start + (event.key === "ArrowLeft" ? -1 : 1) * (event.altKey ? FPS : 1));
        event.preventDefault();
        event.stopPropagation();
    };
    window.addEventListener("keydown", onKey, true);
    const onRemoved = node.onRemoved;
    node.onRemoved = function () {
        window.removeEventListener("keydown", onKey, true);
        state.removed = true;
        state.player?.pause();
        panelObserver.disconnect();
        for (const observer of state.previewObservers) observer.disconnect();
        cropObserver?.disconnect();
        cropOverlay?.remove();
        return onRemoved?.apply(this, arguments);
    };
    for (const name of SETTINGS) {
        const target = widgetOf(node, name);
        const callback = target?.callback;
        if (target) target.callback = function () {
            const result = callback?.apply(this, arguments);
            remember(node);
            updateCropOverlay();
            requestRender();
            return result;
        };
    }
    return { refresh: requestRender, configure: () => { state.cropRatio = widgetOf(node, "crop")?.value ? "Custom" : "Original"; requestRender(); } };
}

// Apply: show the node's messages.
function installMessages(node) {
    const state = { lines: [] };
    const lines = () => state.lines;
    const widget = {
        name: "ripple_messages", type: "bz_ripple_messages", value: "", serialize: false, options: { serialize: false },
        computeSize: (width) => [width ?? 300, 16 * lines().length * 2 + 6],
        draw(ctx, _node, width, y) {
            ctx.save();
            ctx.font = "11px Arial, sans-serif";
            ctx.textBaseline = "top";
            ctx.fillStyle = "#cfcfcf";
            let line = 0;
            for (const text of lines()) {
                const words = String(text).split(" ");
                let row = "";
                for (const word of words) {
                    if (ctx.measureText(`${row} ${word}`).width > width - 28 && row) {
                        ctx.fillText(row, 14, y + 3 + 16 * line++);
                        row = word;
                    } else row = row ? `${row} ${word}` : word;
                }
                if (row) ctx.fillText(row, 14, y + 3 + 16 * line++);
            }
            ctx.restore();
        },
        mouse: () => false,
    };
    node.addCustomWidget ? node.addCustomWidget(widget) : node.widgets?.push(widget);
    const onExecuted = node.onExecuted;
    node.onExecuted = function (message) {
        state.lines = Array.isArray(message?.text) ? message.text : [];
        node.setSize?.([node.size[0], node.computeSize()[1]]);
        node.setDirtyCanvas?.(true, true);
        return onExecuted?.apply(this, arguments);
    };
}

app.registerExtension({
    name: "班长.H3涟漪",
    beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name === "BZ_RippleClip") {
            const onNodeCreated = nodeType.prototype.onNodeCreated;
            nodeType.prototype.onNodeCreated = function () {
                const result = onNodeCreated?.apply(this, arguments);
                this.wnRipple = installRipple(this);
                return result;
            };
            const onConfigure = nodeType.prototype.onConfigure;
            nodeType.prototype.onConfigure = function () {
                const result = onConfigure?.apply(this, arguments);
                restore(this);
                setTimeout(() => { restore(this); this.wnRipple?.configure(); this.setDirtyCanvas?.(true, true); }, 0);
                return result;
            };
        } else if (nodeData.name === "BZ_RippleApply") {
            const onNodeCreated = nodeType.prototype.onNodeCreated;
            nodeType.prototype.onNodeCreated = function () {
                const result = onNodeCreated?.apply(this, arguments);
                installMessages(this);
                return result;
            };
        }
    },
});
