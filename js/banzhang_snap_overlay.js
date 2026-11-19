// A canvas laid over the graph canvas, above the Nodes 2.0 node layer, so nothing drawn on it
// hides under nodes; and the draw job for it: snap guides with the slot dots of flat wires.
// Everything is computed from live geometry at draw time.
// （裁剪自 nomadoor/ComfyUI-Smart-Guides，MIT；删去编组把手与连线高亮兜底，只保留吸附参考线。）

import { alignedGuides } from "./banzhang_snap_guides.js";
import { isFlat } from "./banzhang_snap_core.js";

// 参考线固定亮绿 + 发光：跟随主题的强调色在深色画布上不够显眼，按用户要求改为绿色高亮
const GUIDE_COLOR = "#00e676";
const GUIDE_GLOW = 6; // 发光半径（屏幕像素，shadowBlur 不随缩放变化，正好保持恒定观感）

// the edges of a resized box that move, by corner
const EDGES = { NW: ["left", "top"], NE: ["right", "top"], SW: ["left", "bottom"], SE: ["right", "bottom"] };

export function createOverlay(env) {
  let el = null;
  let ctx = null;
  let raf = 0;
  // draw jobs: (ctx, px) => boolean, with ctx in canvas units and px one screen pixel in them;
  // true asks for another frame
  const sources = [];

  function ensure() {
    const canvas = env.canvas();
    const host = canvas?.canvas?.parentElement;
    if (!host) return false;
    if (!el || el.parentElement !== host) {
      el?.remove();
      el = document.createElement("canvas");
      el.className = "smart-guides-overlay";
      host.appendChild(el);
      ctx = el.getContext("2d");
    }
    const c = canvas.canvas;
    const dpr = globalThis.devicePixelRatio || 1;
    const w = c.clientWidth;
    const h = c.clientHeight;
    el.style.left = `${c.offsetLeft}px`;
    el.style.top = `${c.offsetTop}px`;
    el.style.width = `${w}px`;
    el.style.height = `${h}px`;
    if (el.width !== Math.round(w * dpr) || el.height !== Math.round(h * dpr)) {
      el.width = Math.round(w * dpr);
      el.height = Math.round(h * dpr);
    }
    return true;
  }

  function frame() {
    raf = 0;
    if (!ensure()) return;
    const canvas = env.canvas();
    const dpr = globalThis.devicePixelRatio || 1;
    const { scale, offset } = canvas.ds;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, el.width, el.height);
    ctx.setTransform(dpr * scale, 0, 0, dpr * scale, dpr * offset[0] * scale, dpr * offset[1] * scale);
    const px = 1 / scale; // one screen pixel in canvas units
    let again = false;
    for (const src of sources) {
      ctx.save();
      try { again = src(ctx, px) || again; } catch (err) { console.warn("[班长吸附] draw", err); }
      ctx.restore();
    }
    if (again) request();
  }

  function request() {
    if (!raf) raf = requestAnimationFrame(frame);
  }

  function add(src) { sources.push(src); }

  return { request, add };
}

/** Draw job for drag / resize sessions. */
export function snapGuides(env, getSessions) {
  return (ctx, px) => {
    const sessions = getSessions().filter(Boolean);
    if (!sessions.length) return false;
    const opts = env.snapOptions();
    for (const s of sessions) {
      if (!opts.enabled || s.shift) continue;
      // a moving item's DOM lags a frame in Nodes 2.0; build its box from pos and the press-time offsets
      const rect = s.mode === "drag" && s.offset && s.size
        ? { x: s.item.pos[0] + s.offset[0], y: s.item.pos[1] + s.offset[1], w: s.size[0], h: s.size[1], head: s.head ?? 0 }
        : env.rectOf(s.item);
      const corner = s.corner;
      const edges = s.mode === "drag" ? undefined : EDGES[corner];
      if (opts.edges && !s.wireOnly) {
        const guides = alignedGuides(rect, s.targets, { edges });
        // On each box, a solid line along its aligned edge; between boxes, a dashed line.
        // The line never runs dashed through a node, so a top guide at the body top reads as
        // "these edges line up" rather than a line crossing the nodes.
        const seg = (g, at, from, to) => {
          ctx.beginPath();
          if (g.orient === "v") { ctx.moveTo(at, from); ctx.lineTo(at, to); }
          else { ctx.moveTo(from, at); ctx.lineTo(to, at); }
          ctx.stroke();
        };
        ctx.strokeStyle = GUIDE_COLOR;
        ctx.shadowColor = GUIDE_COLOR;
        ctx.shadowBlur = GUIDE_GLOW;
        for (const g of guides) {
          ctx.setLineDash([]);
          ctx.lineWidth = 1 * px;
          for (const [from, to, at] of g.spans) seg(g, at, from, to);
          ctx.setLineDash([6 * px, 5 * px]);
          ctx.lineWidth = 0.6 * px;
          for (let i = 0; i + 1 < g.spans.length; i++) {
            if (g.spans[i + 1][0] > g.spans[i][1]) seg(g, g.drawAt, g.spans[i][1], g.spans[i + 1][0]);
          }
        }
        ctx.setLineDash([]);
      }
      // flat wires: the slot dots at both ends are drawn here, above the nodes
      if (opts.wires && s.mode === "drag") {
        ctx.fillStyle = GUIDE_COLOR;
        ctx.shadowColor = GUIDE_COLOR;
        ctx.shadowBlur = GUIDE_GLOW;
        for (const w of flatWires(env, s)) {
          for (const p of [w.mine, w.theirs]) {
            ctx.beginPath();
            ctx.arc(p[0], p[1], 4, 0, Math.PI * 2);
            ctx.fill();
          }
        }
      }
    }
    return true;
  };
}

/**
 * The wires to mark during a drag session: wires from the moving nodes to something that
 * stays, that are horizontal now (see env.wiresOf for their shape).
 */
export function flatWires(env, s) {
  if (!s || s.mode !== "drag" || s.shift) return [];
  const opts = env.snapOptions();
  if (!opts.enabled || !opts.wires) return [];
  const out = [];
  for (const n of s.moving ?? []) {
    if (!env.isNode(n) && !env.isIoNode(n)) continue;
    for (const w of env.wiresOf(n)) {
      if (!s.moving.has(w.other) && isFlat(w.mine[1], w.theirs[1])) out.push(w);
    }
  }
  return out;
}
