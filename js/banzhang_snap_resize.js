// Rectangle math for corner resizes. Pure: rects are { x, y, w, h } in canvas units and a
// corner is one of NW, NE, SW, SE. The corner names the two edges that move; the opposite
// edges stay. Every function returns a new rect.

const west = (corner) => corner.includes("W");
const north = (corner) => corner.includes("N");

/** The position of the two moving edges of rect, as [x, y]. */
export function movingEdges(rect, corner) {
  return [west(corner) ? rect.x : rect.x + rect.w, north(corner) ? rect.y : rect.y + rect.h];
}

/** start with its moving edges put at edges ([x, y]); the opposite edges stay. */
export function withMovingEdges(start, corner, edges) {
  const rect = { ...start };
  if (west(corner)) { rect.x = edges[0]; rect.w = start.x + start.w - edges[0]; } else { rect.w = edges[0] - start.x; }
  if (north(corner)) { rect.y = edges[1]; rect.h = start.y + start.h - edges[1]; } else { rect.h = edges[1] - start.y; }
  return rect;
}

/** start with its moving edges moved by (dx, dy); the opposite edges stay. */
export function resizedBy(start, corner, dx, dy) {
  const rect = { ...start };
  if (west(corner)) { rect.x = start.x + dx; rect.w = start.w - dx; } else { rect.w = start.w + dx; }
  if (north(corner)) { rect.y = start.y + dy; rect.h = start.h - dy; } else { rect.h = start.h + dy; }
  return rect;
}

/**
 * rect with its moving edges put back on the same edges of `want`, per axis (onX, onY), while
 * rect's opposite edges stay. Used after something else (the frontend's grid) changed the size
 * of a rect whose moving edges were snapped.
 */
export function withEdgesOf(rect, want, corner, onX, onY) {
  let { x, y, w, h } = rect;
  if (onX) { if (west(corner)) { w = rect.x + rect.w - want.x; x = want.x; } else { w = want.x + want.w - rect.x; } }
  if (onY) { if (north(corner)) { h = rect.y + rect.h - want.y; y = want.y; } else { h = want.y + want.h - rect.y; } }
  return { ...rect, x, y, w, h };
}

/** rect with its moving edges rounded to the grid, per axis (onX, onY); the opposite edges stay. */
export function withEdgesOnGrid(rect, corner, grid, onX, onY) {
  const round = (v) => Math.round(v / grid) * grid;
  const out = { ...rect };
  if (onX) {
    if (west(corner)) { const nx = round(out.x); out.w += out.x - nx; out.x = nx; } else { out.w = round(out.x + out.w) - out.x; }
  }
  if (onY) {
    if (north(corner)) { const ny = round(out.y); out.h += out.y - ny; out.y = ny; } else { out.h = round(out.y + out.h) - out.y; }
  }
  return out;
}

/** rect no smaller than minW x minH, keeping the edges of `start` that the corner does not move. */
export function withMinSize(rect, start, corner, minW, minH) {
  const out = { ...rect };
  if (out.w < minW) { if (west(corner)) out.x = start.x + start.w - minW; out.w = minW; }
  if (out.h < minH) { if (north(corner)) out.y = start.y + start.h - minH; out.h = minH; }
  return out;
}
