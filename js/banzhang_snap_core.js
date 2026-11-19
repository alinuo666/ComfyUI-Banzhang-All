// Snapping math for drags and resizes. Pure: plain rectangles in canvas units,
// distances compared in screen pixels (canvas distance * scale).
//
// A rect is { x, y, w, h, head }: the visual box (header included); head is the header height.
// A target is { id, x, y, w, h, head }: another node or group that can be snapped to.
// "Top" means the top of the body (y + head); abutting uses the whole box.
// A wire top is { key, top }: the rect.y that makes one of the grabbed node's wires flat.

/** Exit distance for a given enter distance, keeping the playground's 8 : 14 ratio. */
export function exitDistance(enterPx) {
  return Math.round((enterPx * 14) / 8);
}

const FLAT_TOL = 0.5; // canvas units

/**
 * The wire top for one wire of a node that moves with the grabbed item: the rect.y of the
 * grabbed item's visual box at which the wire is flat.
 * @param {number} mineY the moving slot's y now
 * @param {number} theirsY the y of the wire's other end, which stays
 * @param {number} itemPosY the grabbed item's pos.y now
 * @param {number} boxOffsetY the grabbed item's visual box top minus its pos.y
 */
export function wireTop(mineY, theirsY, itemPosY, boxOffsetY) {
  return theirsY - (mineY - itemPosY) + boxOffsetY;
}

/** Whether a wire between two slot heights counts as horizontal. */
export function isFlat(mineY, theirsY) {
  return Math.abs(mineY - theirsY) <= FLAT_TOL;
}

function yCandidates(rect, targets, wireTops, opts) {
  const out = [];
  if (opts.wires) {
    for (const w of wireTops) out.push({ key: w.key, kind: "wire", value: w.top, line: null, target: null });
  }
  if (opts.edges) {
    for (const t of targets) {
      out.push({ key: `top:${t.id}`, kind: "top", value: t.y + (t.head ?? 0) - (rect.head ?? 0), line: t.y + (t.head ?? 0), target: t });
      out.push({ key: `bottom:${t.id}`, kind: "bottom", value: t.y + t.h - rect.h, line: t.y + t.h, target: t });
      out.push({ key: `below:${t.id}`, kind: "below", value: t.y + t.h, line: t.y + t.h, target: t });
      out.push({ key: `above:${t.id}`, kind: "above", value: t.y - rect.h, line: t.y, target: t });
    }
  }
  return out;
}

function xCandidates(rect, targets, opts) {
  const out = [];
  if (!opts.edges) return out;
  for (const t of targets) {
    out.push({ key: `left:${t.id}`, kind: "left", value: t.x, line: t.x, target: t });
    out.push({ key: `right:${t.id}`, kind: "right", value: t.x + t.w - rect.w, line: t.x + t.w, target: t });
    out.push({ key: `rightOf:${t.id}`, kind: "rightOf", value: t.x + t.w, line: t.x + t.w, target: t });
    out.push({ key: `leftOf:${t.id}`, kind: "leftOf", value: t.x - rect.w, line: t.x, target: t });
  }
  return out;
}

/**
 * Chooses one candidate on one axis.
 * While attached (currentKey still among the candidates and within the exit distance), stays attached.
 * Otherwise takes the nearest candidate within the enter distance.
 */
export function pickCandidate(cands, raw, currentKey, scale, inPx, outPx) {
  const dist = (c) => Math.abs(c.value - raw) * scale;
  const nearest = (pool) => {
    let best = null;
    for (const c of pool) {
      const d = dist(c);
      if (d <= inPx && (!best || d < dist(best))) best = c;
    }
    return best;
  };
  // Wires come first: making a wire horizontal is what this extension is for. A wire within the
  // enter distance is chosen over edges, and takes over from an edge snap; an edge never takes
  // over from a wire before the exit distance.
  const wire = nearest(cands.filter((c) => c.kind === "wire"));
  if (currentKey) {
    const cur = cands.find((c) => c.key === currentKey);
    if (cur && dist(cur) <= outPx) {
      if (cur.kind !== "wire" && wire) return wire;
      return cur;
    }
  }
  return wire ?? nearest(cands);
}

/**
 * Snaps a dragged rect.
 * @returns {{ x: number, y: number, snapX: object|null, snapY: object|null }}
 */
export function solveDrag({ rect, targets, wireTops, scale, inPx, outPx, current = {}, edges = true, wires = true }) {
  const opts = { edges, wires };
  const snapY = pickCandidate(yCandidates(rect, targets, wireTops, opts), rect.y, current.y, scale, inPx, outPx);
  const snapX = pickCandidate(xCandidates(rect, targets, opts), rect.x, current.x, scale, inPx, outPx);
  return { x: snapX ? snapX.value : rect.x, y: snapY ? snapY.value : rect.y, snapX, snapY };
}

/**
 * Snaps the moving edges of a resized rect. corner is one of NW, NE, SW, SE.
 * Left and right edges snap to targets' left and right edges. A moving bottom edge snaps
 * only to bottoms, a moving top edge only to tops. A snap that would go below the
 * minimum size is skipped.
 * @returns {{ rect: object, snapX: object|null, snapY: object|null }}
 */
export function solveResize({ rect, corner, targets, scale, inPx, outPx, current = {}, minW = 0, minH = 0, edges = true }) {
  const west = corner.includes("W");
  const north = corner.includes("N");
  const right = rect.x + rect.w;
  const bottom = rect.y + rect.h;
  const movingX = west ? rect.x : right;
  const head = rect.head ?? 0;
  const movingY = north ? rect.y + head : bottom; // a moving top edge is matched by its body top

  const xs = [];
  const ys = [];
  if (edges) {
    for (const t of targets) {
      for (const [kind, line] of [["left", t.x], ["right", t.x + t.w]]) {
        const w = west ? right - line : line - rect.x;
        if (w >= minW) xs.push({ key: `${kind}:${t.id}`, kind, value: line, line, target: t });
      }
      const kind = north ? "top" : "bottom";
      const line = north ? t.y + (t.head ?? 0) : t.y + t.h;
      const h = north ? bottom - (line - head) : line - rect.y;
      if (h >= minH) ys.push({ key: `${kind}:${t.id}`, kind, value: line, line, target: t });
    }
  }
  const snapX = pickCandidate(xs, movingX, current.x, scale, inPx, outPx);
  const snapY = pickCandidate(ys, movingY, current.y, scale, inPx, outPx);

  let { x, y, w, h } = rect;
  if (snapX) {
    if (west) { x = snapX.value; w = right - x; } else { w = snapX.value - x; }
  }
  if (snapY) {
    if (north) { y = snapY.value - head; h = bottom - y; } else { h = snapY.value - y; }
  }
  return { rect: { x, y, w, h }, snapX, snapY };
}
