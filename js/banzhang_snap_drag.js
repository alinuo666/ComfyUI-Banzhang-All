// Snapping while the frontend drags or resizes a node, or drags a group by its title.
//
// The frontend keeps moving the item itself. This module only rewrites the pointer
// coordinates (capture phase) so the frontend computes the snapped position. How each
// renderer turns pointer events into positions is in ./banzhang_snap_pointer.js.
// See docs/spec.md, section 1.

import { solveDrag, solveResize, wireTop } from "./banzhang_snap_core.js";
import { deltaModel, absoluteModel, canvasResizeModel, clientResizeModel, inAutoPanBand } from "./banzhang_snap_pointer.js";
import { movingEdges, withMovingEdges, withEdgesOf } from "./banzhang_snap_resize.js";
import { pickClone } from "./banzhang_snap_clone.js";

const DRAG_THRESHOLD_PX = 6; // the frontend's own threshold before a press becomes a drag

function setEventCoord(e, x, y) {
  for (const [k, v] of [["clientX", x], ["clientY", y], ["x", x], ["y", y], ["pageX", x + (globalThis.scrollX ?? 0)], ["pageY", y + (globalThis.scrollY ?? 0)]]) {
    try { Object.defineProperty(e, k, { value: v, configurable: true }); } catch { /* read-only event */ }
  }
}

function hideShift(e) {
  try { Object.defineProperty(e, "shiftKey", { value: false, configurable: true }); } catch { /* ignore */ }
}

export function createDragSnapper(env) {
  // What the primary pointer went down on, until the release: { renderer, item, corner, client,
  // offset, scale, startPos, startSize, startShown, startRect, pressCanvas?, alt?, beforeIds? }.
  // renderer says who moves the item: "classic" is the canvas (nodes of the classic renderer, and
  // groups in both renderers), "vue" the Nodes 2.0 node layer.
  let press = null;
  let session = null; // an active snapped drag or resize, made from the press once the frontend moves the item
  let lastReal = null; // last real (unrewritten) pointer position
  let keptOnRelease = null; // [node, x, y] of the moving nodes at the release, see onPointerUpCapture
  const status = env.status;
  const listeners = new Set();
  const notify = () => { for (const fn of listeners) fn(session); };

  // An exception ends the current drag (the frontend carries on with the real pointer); a few of
  // them switch snapping off for the page (see ./status.js).
  const guard = (fn) => (e) => {
    if (status.isOff("snap")) return;
    try { fn(e); } catch (err) {
      status.fail("snap", err);
      try { finish(); } catch { /* finish has cleared the session and closed the undo transaction */ }
    }
  };

  // Shift switches snapping off, and with it ComfyUI's own Shift grid, unless "always snap to
  // grid" is on.
  const hidesShiftGrid = (s) => !!s?.shift && env.snapOptions().enabled && !env.alwaysSnap();

  // ----- press -----
  function onPointerDown(e) {
    if (e.isPrimary === false) return;
    if (session) finish();
    press = null;
    if (e.button !== 0) return;
    lastReal = [e.clientX, e.clientY];
    const canvas = env.canvas();
    const graph = env.graph();
    if (!canvas || !graph) return;
    press = detectPress(e, canvas, graph);
  }

  /** The item's geometry at rest: at the press, or when an Alt clone appears. */
  function restState(item) {
    const shown = env.renderedSize(item);
    return { startPos: [item.pos[0], item.pos[1]], startSize: [item.size[0], item.size[1]], startShown: [shown[0], shown[1]], startRect: env.rectOf(item) };
  }

  function detectPress(e, canvas, graph) {
    const at = { client: [e.clientX, e.clientY], offset: [...canvas.ds.offset], scale: canvas.ds.scale };
    const target = e.target instanceof Element ? e.target : null;
    const vueNodeEl = env.vueMode() ? target?.closest?.("[data-node-id]") : null;
    const onCanvas = target === canvas.canvas;
    // Alt + press clones the node and drags the clone; the clone does not exist yet, so the
    // dragged node is found once the frontend has made it (see findClone)
    if (e.altKey && !e.ctrlKey && globalThis.LiteGraph?.alt_drag_do_clone_nodes !== false) {
      // the nodes that exist now: the clone will be the one that is added (see findClone)
      const beforeIds = new Set((graph._nodes ?? []).map((n) => String(n.id)));
      if (vueNodeEl) return { ...at, renderer: "vue", item: null, corner: null, alt: true, beforeIds };
      return onCanvas ? canvasClonePress(e, { ...at, beforeIds }, canvas, graph) : null;
    }
    if (vueNodeEl) return vueNodePress(at, vueNodeEl, target, graph);
    return onCanvas ? canvasPress(e, at, canvas, graph) : null;
  }

  // Nodes 2.0: the pressed node is the element's data-node-id; a resize handle carries data-corner.
  function vueNodePress(at, vueNodeEl, target, graph) {
    const id = vueNodeEl.getAttribute("data-node-id");
    const node = graph.getNodeById(id) ?? graph.getNodeById(Number(id));
    if (!node || node.pinned) return null;
    const corner = target.closest("[data-corner]")?.getAttribute("data-corner") ?? null;
    return { ...at, renderer: "vue", item: node, corner, ...restState(node) };
  }

  // In Nodes 2.0 the nodes are elements above the canvas, so a press on the canvas is never on a node.
  const canvasNodeAt = (canvas, graph, x, y) => (env.vueMode() ? null : graph.getNodeOnPos(x, y, canvas.visible_nodes));

  // A press on the canvas: a node (classic renderer), a subgraph's input or output node (both
  // renderers draw it on the canvas), or a group's title (both renderers). The order is the
  // frontend's (resolvePointerTarget): node, subgraph input/output node, then group (it also
  // checks link badges, reroutes and links in between; those presses never start a drag of these).
  function canvasPress(e, at, canvas, graph) {
    const [x, y] = canvas.convertEventToCanvasOffset(e);
    const node = canvasNodeAt(canvas, graph, x, y);
    if (node) {
      if (node.pinned) return null;
      const corner = node.flags?.collapsed ? null : node.findResizeDirection?.(x, y) ?? null;
      return { ...at, renderer: "classic", item: node, corner, pressCanvas: [x, y], ...restState(node) };
    }
    // a press on its slot drags a link instead; the frontend then never starts dragging the item
    const io = graph.getIoNodeOnPos?.(x, y);
    if (io && env.isIoNode(io)) {
      if (io.pinned) return null;
      return { ...at, renderer: "classic", item: io, corner: null, wireOnly: true, pressCanvas: [x, y], ...restState(io) };
    }
    const group = graph.getGroupOnPos?.(x, y);
    if (group && !group.pinned && group.isPointInTitlebar(x, y)) {
      return { ...at, renderer: "classic", item: group, corner: null, pressCanvas: [x, y], ...restState(group) };
    }
    return null;
  }

  function canvasClonePress(e, at, canvas, graph) {
    const [x, y] = canvas.convertEventToCanvasOffset(e);
    const original = canvasNodeAt(canvas, graph, x, y);
    if (!original) {
      // the frontend does not clone a subgraph input/output node: Alt drags it as usual
      const io = graph.getIoNodeOnPos?.(x, y);
      if (!io || !env.isIoNode(io) || io.pinned) return null;
      const { beforeIds, ...plain } = at;
      return { ...plain, renderer: "classic", item: io, corner: null, wireOnly: true, pressCanvas: [x, y], ...restState(io) };
    }
    return { ...at, renderer: "classic", item: null, corner: null, alt: true, pressCanvas: [x, y] };
  }

  // The clone made by an Alt press: the node added since the press (see core/clone.js).
  function findClone() {
    const canvas = env.canvas();
    const selectedIds = new Set([...(canvas?.selectedItems ?? [])].filter(env.isNode).map((n) => String(n.id)));
    const clone = pickClone(press.beforeIds, env.graph()?._nodes ?? [], selectedIds);
    if (!clone || clone.pinned) return false;
    Object.assign(press, { item: clone, ...restState(clone) });
    return true;
  }

  // ----- session start -----
  function tryStart(e) {
    const canvas = env.canvas();
    if (press.alt && !press.item) {
      // classic: the clone is selected when the frontend starts dragging it; Nodes 2.0: at the press
      if (press.renderer === "classic" && !canvas.isDragging) return;
      if (!findClone()) return;
    }
    const mode = press.renderer === "classic" ? canvasStarted(canvas) : vueStarted(e);
    if (mode) start(mode, e);
  }

  /** "drag" or "resize" once the canvas has started moving or resizing the pressed item, else null. */
  function canvasStarted(canvas) {
    if (press.corner && canvas.resizing_node === press.item) return "resize";
    if (!press.corner && canvas.isDragging && canvas.selectedItems?.has(press.item) && canvas.last_mouse?.length >= 2) return "drag";
    return null;
  }

  /** The same for Nodes 2.0, which has no such flags: the pressed node really moved or changed size. */
  function vueStarted(e) {
    if (Math.hypot(e.clientX - press.client[0], e.clientY - press.client[1]) < DRAG_THRESHOLD_PX) return null;
    const n = press.item;
    const moved = n.pos[0] !== press.startPos[0] || n.pos[1] !== press.startPos[1];
    const resized = n.size[0] !== press.startSize[0] || n.size[1] !== press.startSize[1];
    if (press.corner) return moved || resized ? "resize" : null;
    return moved ? "drag" : null;
  }

  /** The pointer model for the way the frontend moves the item in this mode and renderer. */
  function makeModel(mode, item) {
    const classic = press.renderer === "classic";
    if (mode === "drag") {
      return classic
        ? deltaModel({ itemPos: [item.pos[0], item.pos[1]], lastReal })
        : absoluteModel({ startPos: press.startPos, pressClient: press.client, offset: press.offset, scale: press.scale });
    }
    const startEdge = movingEdges(press.startRect, press.corner);
    return classic
      ? canvasResizeModel({ startEdge, pressCanvas: press.pressCanvas })
      : clientResizeModel({ startEdge, pressClient: press.client });
  }

  function start(mode, e) {
    const canvas = env.canvas();
    const item = press.item;
    const selected = [...(canvas.selectedItems ?? [])];
    // the classic canvas carries a dragged group's contents (not with Ctrl); a Nodes 2.0 node drag
    // moves other selected groups without their contents
    const withContents = press.renderer === "classic" && !(e.ctrlKey || e.metaKey);
    const moving = mode === "drag"
      ? env.movingSet(selected.includes(item) ? selected : [item], withContents)
      : new Set([item]);
    moving.add(item);
    const targets = env.visibleTargets(moving);
    const r0 = press.startRect;
    // offset from pos to the visual box, taken while the item was at rest
    const offset = [r0.x - press.startPos[0], r0.y - press.startPos[1]];
    // wires of every moving node to a node that stays: all move with the grabbed item
    const wireTops = [];
    if (mode === "drag") {
      for (const n of moving) {
        if (!env.isNode(n) && !env.isIoNode(n)) continue;
        for (const w of env.wiresOf(n)) {
          if (moving.has(w.other)) continue;
          wireTops.push({ key: w.key, top: wireTop(w.mine[1], w.theirs[1], item.pos[1], offset[1]) });
        }
      }
    }
    const s = {
      mode, corner: press.corner, item, moving, targets, wireTops, offset, renderer: press.renderer,
      // a subgraph input/output node snaps only to make its wires horizontal (spec 1.1)
      wireOnly: !!press.wireOnly,
      model: makeModel(mode, item),
      // the visual box at rest: its size and header for drags, the whole box for resizes
      size: [r0.w, r0.h], head: r0.head ?? 0, startRect: r0, titleH: r0.h - press.startShown[1],
      current: {}, snapX: null, snapY: null, // the snap per axis, and its key for the hysteresis
      shift: !!e.shiftKey,
      lastDelivered: null, // where the frontend last saw the pointer
      want: null, // a resize's snapped rect
      undoOpen: false,
    };
    session = s;
    try { canvas.emitBeforeChange?.(); s.undoOpen = true; } catch { /* ignore */ }
    notify();
  }

  // ----- per event -----
  function keepSnap(s, result) {
    s.snapX = result.snapX; s.snapY = result.snapY;
    s.current = { x: result.snapX?.key, y: result.snapY?.key };
  }

  function dropSnap(s) {
    s.snapX = s.snapY = null; s.current = {}; s.want = null;
  }

  /** Snaps a dragged item's pos (raw: where the pointer alone would put it). */
  function solvePos(raw, scale, opts) {
    const s = session;
    const rect = { x: raw[0] + s.offset[0], y: raw[1] + s.offset[1], w: s.size[0], h: s.size[1], head: s.head };
    const r = solveDrag({ rect, targets: s.targets, wireTops: s.wireTops, scale, inPx: opts.inPx, outPx: opts.outPx, current: s.current, edges: opts.edges && !s.wireOnly, wires: opts.wires });
    keepSnap(s, r);
    return [r.x - s.offset[0], r.y - s.offset[1]];
  }

  /** Snaps a resized item's moving edges (edges: where the pointer alone would put them). */
  function solveEdges(edges, scale, opts) {
    const s = session;
    const rect = withMovingEdges(s.startRect, s.corner, edges);
    const min = s.renderer === "classic" && typeof s.item.computeSize === "function" ? s.item.computeSize() : [0, 0];
    const res = solveResize({ rect, corner: s.corner, targets: s.targets, scale, inPx: opts.inPx, outPx: opts.outPx, current: s.current, minW: min[0], minH: min[1] + s.titleH, edges: opts.edges });
    keepSnap(s, res);
    s.want = res.rect;
    return movingEdges(res.rect, s.corner);
  }

  /**
   * Runs the session's pointer model for one pointermove. Returns { delivered }: the client
   * position to hand to the frontend, or null to leave the event as it is.
   */
  function stepModel(s, e, real, canvas, opts, rewrite) {
    const scale = canvas.ds.scale;
    const offset = [...canvas.ds.offset];
    const solve = s.mode === "drag" ? (raw) => solvePos(raw, scale, opts) : (edges) => solveEdges(edges, scale, opts);
    if (s.mode === "drag" && s.renderer === "classic") {
      return s.model.step({ real, itemPos: [s.item.pos[0], s.item.pos[1]], scale, lastDelivered: [...canvas.last_mouse] }, solve, rewrite);
    }
    if (s.mode === "drag") {
      const out = s.model.step({ real, offset, scale }, solve, rewrite);
      // the frontend shifts its drag start only for Space pan (read only) and auto-pan, which
      // runs on the pointer it is given (the delivered one) near the canvas edge; not for a wheel pan
      const autoPans = inAutoPanBand(out.delivered ?? real, canvas.canvas.getBoundingClientRect());
      s.model.markShiftsStart(!!canvas.read_only || autoPans);
      return out;
    }
    if (s.renderer === "classic") {
      const bounds = canvas.canvas.getBoundingClientRect();
      const out = s.model.step({ pointerCanvas: canvas.convertEventToCanvasOffset(e), offset, scale }, solve, rewrite);
      if (out.delivered) out.delivered = [out.delivered[0] + bounds.left, out.delivered[1] + bounds.top];
      return out;
    }
    return s.model.step({ real, scale }, solve, rewrite);
  }

  function onPointerMove(e) {
    if (e.isPrimary === false) return;
    const real = [e.clientX, e.clientY];
    if (session && e.buttons === 0) { finish(); lastReal = real; return; } // released without a pointerup
    if (!session && press && e.buttons !== 0) tryStart(e);
    if (!session) { lastReal = real; return; }

    const s = session;
    const canvas = env.canvas();
    const opts = env.snapOptions();
    s.shift = !!e.shiftKey;
    if (hidesShiftGrid(s)) hideShift(e);
    const rewrite = opts.enabled && !s.shift && !canvas.read_only && !canvas.dragging_canvas;
    if (!rewrite) dropSnap(s);
    // what is on screen changes with auto-pan and zoom; rebuild the targets every event
    s.targets = env.visibleTargets(s.moving);

    const out = stepModel(s, e, real, canvas, opts, rewrite);
    if (out.delivered) setEventCoord(e, out.delivered[0], out.delivered[1]);
    s.lastDelivered = out.delivered ?? real;
    if (s.mode === "resize" && env.alwaysSnap() && (s.snapX || s.snapY)) {
      setTimeout(guard(() => { if (session === s) fixResizeAfterGrid(s); }), 0);
    }
    lastReal = real;
    notify();
  }

  // "Always snap to grid" rounds the size on every move. Put the snapped edges back.
  function fixResizeAfterGrid(s) {
    if (!s || s.mode !== "resize" || !s.want || (!s.snapX && !s.snapY)) return;
    const n = s.item;
    // current visual box from the live pos and rendered size (boundingRect lags a frame behind)
    const shown = env.renderedSize(n);
    const now = { x: n.pos[0] + s.offset[0], y: n.pos[1] + s.offset[1], w: shown[0], h: shown[1] + s.titleH };
    const fixed = withEdgesOf(now, s.want, s.corner, !!s.snapX, !!s.snapY);
    if (fixed.x === now.x && fixed.y === now.y && fixed.w === now.w && fixed.h === now.h) return;
    n.pos = [n.pos[0] + (fixed.x - now.x), n.pos[1] + (fixed.y - now.y)];
    env.setSize(n, [shown[0] + (fixed.w - now.w), shown[1] + (fixed.h - now.h)]);
    env.canvas()?.setDirty(true, true);
  }

  // ----- release -----
  // The frontend handles the release after this capture listener; the session closes once it has.
  const finishSoon = (s) => setTimeout(guard(() => { if (session === s) finish(); }), 0);

  function onPointerUpCapture(e) {
    if (e.isPrimary === false) return;
    const s = session;
    if (!s) { press = null; return; }
    // release where the last move was delivered; do not re-solve on release
    if (s.lastDelivered) setEventCoord(e, s.lastDelivered[0], s.lastDelivered[1]);
    if (hidesShiftGrid(s)) hideShift(e);
    // Nodes 2.0 with "always snap to grid" rounds the nodes on release (not through
    // LGraph.snapToGrid): remember where they are, so finish() can put the snapped axes back
    if (env.alwaysSnap() && s.mode === "drag" && s.renderer === "vue" && (s.snapX || s.snapY)) {
      keptOnRelease = [...s.moving].filter(env.isNode).map((n) => [n, n.pos[0], n.pos[1]]);
    }
    finishSoon(s);
  }

  function onPointerUpBubble(e) { if (e.isPrimary !== false && session) finish(); }

  // The session's state is cleared first and the undo transaction is closed whatever happens,
  // so a throwing fix-up cannot leave either open.
  function finish() {
    const s = session;
    const kept = keptOnRelease;
    session = null;
    press = null;
    keptOnRelease = null;
    if (!s) return;
    try {
      if (kept) {
        for (const [n, x, y] of kept) n.pos = [s.snapX ? x : n.pos[0], s.snapY ? y : n.pos[1]];
        env.canvas()?.setDirty(true, true);
      }
      // the frontend rounds the size to the grid on every move; put snapped edges back before closing
      if (s.mode === "resize" && env.alwaysSnap()) fixResizeAfterGrid(s);
      status.clean("snap"); // errors count only when they come in a row
    } finally {
      if (s.undoOpen) { try { env.canvas()?.emitAfterChange?.(); } catch { /* ignore */ } }
      notify();
    }
  }

  // ----- grid hooks (classic canvas, and the canvas-drawn grid preview) -----
  function installGridHooks() {
    const proto = globalThis.LGraph?.prototype;
    if (!proto || typeof proto.getSnapToGridSize !== "function" || typeof proto.snapToGrid !== "function") return false;
    // Wrappers stay installed for the page; when grid hooks are off they only pass through.
    const active = () => !status.isOff("grid") && !status.isOff("snap");
    const origSize = proto.getSnapToGridSize;
    proto.getSnapToGridSize = function (...args) {
      try {
        if (active() && hidesShiftGrid(session)) return 0;
      } catch (err) { status.fail("grid", err); }
      return origSize.apply(this, args);
    };
    // the frontend rounds the dragged items on release: keep the snapped axes where they are
    const origSnap = proto.snapToGrid;
    proto.snapToGrid = function (items, ...rest) {
      const s = session;
      let before = null;
      try {
        if (active() && s && s.mode === "drag" && (s.snapX || s.snapY)) before = [...s.moving].map((it) => [it, it.pos[0], it.pos[1]]);
      } catch (err) { status.fail("grid", err); }
      const result = origSnap.call(this, items, ...rest);
      if (!before) return result;
      try {
        for (const [it, x, y] of before) {
          const nx = s.snapX ? x : it.pos[0];
          const ny = s.snapY ? y : it.pos[1];
          if (nx !== it.pos[0] || ny !== it.pos[1]) it.pos = [nx, ny];
        }
      } catch (err) { status.fail("grid", err); }
      return result;
    };
    return true;
  }

  function install() {
    addEventListener("pointerdown", guard(onPointerDown), true);
    addEventListener("pointermove", guard(onPointerMove), true);
    addEventListener("pointerup", guard(onPointerUpCapture), true);
    addEventListener("pointerup", guard(onPointerUpBubble), false);
    addEventListener("pointercancel", guard((e) => { if (e.isPrimary !== false) finish(); }), true);
    addEventListener("lostpointercapture", guard((e) => { const s = session; if (s && e.isPrimary !== false) finishSoon(s); }), true);
    addEventListener("blur", () => { try { finish(); } catch { /* ignore */ } });
    if (!installGridHooks()) status.report("grid", "off", "LGraph.prototype.getSnapToGridSize / snapToGrid not found; Shift rounds to the grid");
  }

  return {
    install,
    get session() { return session; },
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  };
}
