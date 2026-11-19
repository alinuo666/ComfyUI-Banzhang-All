// Guides: every line on which an edge of the moving box coincides (within 0.5) with an edge of
// another box. One guide per line, long enough to reach every box on it.
//
// Tops line up by the top of the body (the header excluded). Headers all have the same height, so
// when every box on the line has a header, the line is drawn at the top of the boxes. When a box
// without a header (Reroute) is on the line, it is drawn where the edges meet: the body tops.

const TOL = 0.5;

/**
 * @param {{x:number,y:number,w:number,h:number,head?:number}} me the moving box
 * @param {Array<{x:number,y:number,w:number,h:number,head?:number}>} targets other boxes
 * @param {{ edges?: string[] }} [opts] edges of mine to consider: left, right, top, bottom (default all)
 * @returns {Array<{ orient: 'v'|'h', at: number, drawAt: number, from: number, to: number, spans: number[][] }>}
 *   'v' is a vertical line, 'h' horizontal. at is the aligned coordinate; drawAt is where the
 *   line between boxes is drawn. spans are [from, to, pos] per box along the line, sorted,
 *   overlaps at the same pos merged; pos is where that box's edge is drawn.
 */
export function alignedGuides(me, targets, opts = {}) {
  const edges = new Set(opts.edges ?? ["left", "right", "top", "bottom"]);
  const mine = { left: me.x, right: me.x + me.w, top: me.y, bottom: me.y + me.h };
  const lines = new Map();
  // byBody: the line aligns body tops
  const add = (orient, at, box, byBody = false) => {
    const key = `${orient}:${Math.round(at * 2)}:${byBody ? "b" : "e"}`;
    let g = lines.get(key);
    if (!g) {
      g = { orient, at, byBody, boxes: [me] };
      lines.set(key, g);
    }
    g.boxes.push(box);
  };
  for (const t of targets) {
    for (const e of ["left", "right"]) {
      if (!edges.has(e)) continue;
      if ([t.x, t.x + t.w].some((v) => Math.abs(v - mine[e]) <= TOL)) add("v", mine[e], t);
    }
    const myBodyTop = me.y + (me.head ?? 0);
    const theirBodyTop = t.y + (t.head ?? 0);
    if (edges.has("top")) {
      if (Math.abs(theirBodyTop - myBodyTop) <= TOL) add("h", myBodyTop, t, true);
      if (Math.abs(t.y + t.h - mine.top) <= TOL) add("h", mine.top, t);
    }
    if (edges.has("bottom")) {
      if (Math.abs(t.y + t.h - mine.bottom) <= TOL) add("h", mine.bottom, t);
      if (Math.abs(t.y - mine.bottom) <= TOL) add("h", mine.bottom, t);
    }
  }
  const out = [];
  for (const g of lines.values()) {
    const allHeaded = g.boxes.every((b) => (b.head ?? 0) > 0);
    const drawAt = g.byBody && allHeaded ? Math.min(...g.boxes.map((b) => b.y)) : g.at;
    const spans = mergeSpans(g.boxes.map((b) => (g.orient === "v" ? [b.y, b.y + b.h, drawAt] : [b.x, b.x + b.w, drawAt])));
    out.push({
      orient: g.orient, at: g.at, drawAt, spans,
      from: Math.min(...spans.map((s) => s[0])), to: Math.max(...spans.map((s) => s[1])),
    });
  }
  return out;
}

function mergeSpans(spans) {
  const sorted = spans.map((s) => [...s]).sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const s of sorted) {
    const last = out[out.length - 1];
    if (last && s[0] <= last[1] && Math.abs(s[2] - last[2]) <= TOL) last[1] = Math.max(last[1], s[1]);
    else out.push(s);
  }
  return out;
}
