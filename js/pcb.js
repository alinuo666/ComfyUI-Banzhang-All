// PCB -- an orthogonal "PCB" link render mode for ComfyUI, and nothing else.
//
// Adds a 4th option to Comfy.LinkRenderMode; while it is active, link geometry is
// replaced with orthogonal routed traces (exit right, around obstacles, enter left),
// collinear runs are spread into lanes, and everything else -- hit-testing, centre
// button, arrows, flow dots -- rides the trace because it all derives from the Path2D
// and centrePos we emit. Other render modes are untouched; previews stay core-drawn;
// with the extension removed a workflow left in PCB mode renders as splines.
//
// This is the routing core of comfyui-cable-management, packaged alone. If that pack
// is installed it already ships this mode (plus combs, gates and ribbon gestures that
// build on it), so this one detects it and stands down entirely -- installing both is
// safe and cable-management wins.
//
// Everything installs lazily -- app.canvas does not exist during setup, and silent
// non-attachment is the canonical failure mode.

import { app } from "../../scripts/app.js";
import { beginFrame, debugRoutes, invalidate, routeFor, stats } from "./pathing/registry.js";
import { conf } from "./pathing/config.js";
import { emit, pointAt } from "./pathing/trace.js";

// null, not a number: LiteGraph's HIDDEN_LINK is 3, and any numeric placeholder would
// make active() true for a real core mode during the ticks before the patch lands.
const state = { patched: false, option: false, PCB: null };

function active() {
  return state.PCB != null && app.canvas && app.canvas.links_render_mode === state.PCB;
}

// The graph on screen: entering a subgraph swaps what the canvas renders but leaves
// app.graph at the root, so the root's setDirtyCanvas reaches no canvas from inside one.
function activeGraph() {
  return app?.canvas?.graph ?? app?.graph ?? null;
}

// Debug overlay (Alt+P): node boxes, the live routed polylines with their vertices, and
// a cache/version readout. The fastest way to see what geometry the router actually
// produced and which obstacles it was working from.
const dbg = { on: false };

function drawDebug(canvas, ctx) {
  const k = 1 / (canvas.ds?.scale ?? 1);
  const routes = debugRoutes();
  ctx.save();
  ctx.lineWidth = k;
  ctx.strokeStyle = "rgba(255,90,90,0.55)";
  for (const n of canvas.graph?._nodes ?? []) {
    const r = n.boundingRect ?? [n.pos[0], n.pos[1], n.size[0], n.size[1]];
    ctx.strokeRect(r[0], r[1], r[2], r[3]);
  }
  ctx.strokeStyle = "rgba(90,255,255,0.85)";
  ctx.fillStyle = "rgba(90,255,255,0.85)";
  for (const d of routes) {
    const p = new Path2D();
    emit(p, d.pts);
    ctx.stroke(p);
    for (const [x, y] of d.pts) ctx.fillRect(x - 1.5 * k, y - 1.5 * k, 3 * k, 3 * k);
  }
  const s = stats();
  const va = canvas.visible_area ?? [0, 0, 0, 0];
  ctx.fillStyle = "rgba(255,235,90,0.95)";
  ctx.font = `${13 * k}px monospace`;
  ctx.fillText(
    `pcb routes=${routes.length} cache=${s.cached} obstacles=${s.obstacles} v=${s.version}`,
    va[0] + 8 * k,
    va[1] + 18 * k
  );
  ctx.restore();
}

function pickSentinel() {
  // A HIGH fixed base, not first-free-above-3: the persisted Comfy.LinkRenderMode
  // value must keep meaning "PCB" across frontend releases, and core has grown new
  // link modes before.
  const L = window.LiteGraph;
  const taken = [L.STRAIGHT_LINK, L.LINEAR_LINK, L.SPLINE_LINK, L.HIDDEN_LINK];
  let v = 64;
  while (taken.includes(v)) v++;
  return v;
}

function tryPatch() {
  const c = app.canvas;
  if (!c?.linkRenderer?.pathRenderer) return false;
  state.PCB = pickSentinel();

  const canvasProto = c.constructor.prototype;
  const prProto = Object.getPrototypeOf(c.linkRenderer.pathRenderer);

  const origDrawConnections = canvasProto.drawConnections;
  canvasProto.drawConnections = function (ctx) {
    // A throw escaping drawConnections leaves core's is_rendering flag stuck and the
    // canvas dead for the session -- same failure class as drawLink below.
    if (this === app.canvas && this.links_render_mode === state.PCB) {
      try {
        beginFrame(this);
      } catch (err) {
        console.warn("pcb: beginFrame failed", err);
      }
    }
    const r = origDrawConnections.call(this, ctx);
    // Overlay rides core's connection pass: the ctx is already in graph coordinates and
    // links draw above nodes, so it pans/zooms for free and sits on top.
    if (dbg.on && this === app.canvas && active()) {
      try {
        drawDebug(this, ctx);
      } catch (err) {
        console.warn("pcb: debug overlay failed", err);
      }
    }
    return r;
  };

  const origDrawLink = prProto.drawLink;
  prProto.drawLink = function (ctx, linkData, context) {
    // Only real links (numeric id) get routed; the in-flight drag link is a placeholder
    // ("temp"/"dragging" in current frontends, but the numeric test does not depend on
    // those spellings) and core's own spline is what should follow the pointer.
    if (active() && Number.isFinite(Number(linkData.id))) {
      // A throw escaping drawLink KILLS core's render loop permanently (measured:
      // one bad route froze the canvas for the rest of the session). Spline
      // fallback for that link, loudly, and the loop survives.
      try {
        const r = routeFor(app.canvas, linkData);
        if (r) linkData.__route = r;
      } catch (err) {
        console.warn("pcb: route failed for link", linkData.id, err);
      }
    }
    return origDrawLink.call(this, ctx, linkData, context);
  };

  const origDrawLinkPath = prProto.drawLinkPath;
  prProto.drawLinkPath = function (ctx, path, link, context, lineWidth, color) {
    if (!link.__route) return origDrawLinkPath.call(this, ctx, path, link, context, lineWidth, color);
    // save/restore: core reads back whatever it set on the ctx in places, and leaving
    // strokeStyle/lineJoin modified leaks into whatever it draws next.
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(0.5, lineWidth * conf.widthScale);
    ctx.lineJoin = "round";
    emit(path, link.__route.pts);
    ctx.stroke(path);
    ctx.restore();
  };

  const origCentre = prProto.calculateCenterPoint;
  prProto.calculateCenterPoint = function (link, context) {
    if (!link.__route) return origCentre.call(this, link, context);
    // Marker sits at the midpoint of the LONGEST straight run, not the arc-length
    // midpoint -- the arc midpoint can land next to a corner or inside a dense lane
    // stack, where the longest run is the trace's natural label position.
    const pts = link.__route.pts;
    let bi = 1, bl = -1;
    for (let k = 1; k < pts.length; k++) {
      const l = Math.abs(pts[k][0] - pts[k - 1][0]) + Math.abs(pts[k][1] - pts[k - 1][1]);
      if (l > bl) { bl = l; bi = k; }
    }
    const a = pts[bi - 1], b = pts[bi];
    link.centerPos = { x: (a[0] + b[0]) / 2, y: (a[1] + b[1]) / 2 };
    link.centerAngle = Math.atan2(b[1] - a[1], b[0] - a[0]);
  };

  const origPoint = prProto.computeConnectionPoint;
  prProto.computeConnectionPoint = function (link, t, context) {
    if (!link.__route) return origPoint.call(this, link, t, context);
    const p = pointAt(link.__route.pts, link.__route.m, t);
    return { x: p.x, y: p.y };
  };

  // The last redraw of a drag happens while the pointer is still down (splines, by
  // design); without this, no frame runs after the drop until the next interaction, so
  // traces only reappeared once the node was unselected. Capture-phase listener: core's
  // own window handlers stopPropagation, which does not silence same-target siblings.
  // Installed here, not at module scope, so a stood-down install leaves nothing behind.
  window.addEventListener(
    "pointerup",
    () => {
      if (!active()) return;
      requestAnimationFrame(() => requestAnimationFrame(() => {
        activeGraph()?.setDirtyCanvas(false, true);
      }));
    },
    true
  );

  state.patched = true;
  return true;
}

function tryOption() {
  const vueApp = document.querySelector("#vue-app")?.__vue_app__ ?? document.querySelector("#app")?.__vue_app__;
  const pinia = vueApp?.config?.globalProperties?.$pinia;
  if (!pinia?._s) return false;
  for (const [, store] of pinia._s) {
    const bag = store.settingsById ?? store.settings;
    const def = bag?.["Comfy.LinkRenderMode"] ?? bag?.get?.("Comfy.LinkRenderMode");
    if (def && Array.isArray(def.options)) {
      // Belt-and-braces behind the stand-down guard: never a second "PCB" entry.
      if (!def.options.some((o) => o.value === state.PCB || o.text === "PCB 走线")) {
        def.options.push({ value: state.PCB, text: "PCB 走线" });
      }
      state.option = true;
      return true;
    }
  }
  return false;
}

let ticks = 0;
const MAX_TICKS = 300; // 60s at 200ms -- past this the frontend is not what we expect
const timer = setInterval(() => {
  ticks++;
  // cable-management ships a superset of this extension and publishes this global at
  // module evaluation -- all extension modules finish evaluating before the canvas
  // (our earliest patch point) exists, so one check per tick is a reliable guard.
  if (window.__cablemanagementPathing) {
    clearInterval(timer);
    console.log("[pcb] comfyui-cable-management is installed and already provides PCB mode; standing down");
    return;
  }
  if (!state.patched) {
    tryPatch();
    // The gate is a TS-private property (linkRenderer.pathRenderer); if a frontend
    // renames it this must say so ONCE instead of failing silently forever.
    if (!state.patched && ticks === 50) {
      console.warn("[pcb] patch points not found on this frontend; routed rendering unavailable");
    }
  }
  if (state.patched && !state.option) tryOption();
  if (state.patched && state.option) {
    clearInterval(timer);
    return;
  }
  // Polling forever when the frontend never matches buys nothing but a 5Hz wakeup for the
  // rest of the session. Report which half failed and stop.
  if (ticks >= MAX_TICKS) {
    clearInterval(timer);
    console.warn(
      `[pcb] install incomplete after ${(MAX_TICKS * 200) / 1000}s (patched=${state.patched}, setting=${state.option}); giving up`
    );
  }
}, 200);

window.addEventListener("keydown", (e) => {
  if (!e.altKey || e.code !== "KeyP" || !state.patched) return;
  const t = e.target;
  if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
  dbg.on = !dbg.on;
  activeGraph()?.setDirtyCanvas(false, true);
});

// conf is live -- mutate then call invalidate() to rebuild everything from the new values.
window.__pcb = {
  state,
  stats,
  routes: debugRoutes,
  PCB: () => state.PCB,
  conf,
  invalidate,
  debug: dbg
};
