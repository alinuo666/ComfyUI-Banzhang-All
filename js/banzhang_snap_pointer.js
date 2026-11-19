// How the frontend turns pointer events into positions, and the inverse: which pointer
// coordinates make it land on a snapped position. Pure; one model per way the frontend computes.
//
// solve(raw) returns the snapped value ([x, y]); rewrite = false means "do not touch the event"
// (snapping off, Shift held, read only) while the bookkeeping continues.
// A step returns { raw, delivered } where delivered is the pointer position to hand to the
// frontend, or null to leave the event as it is.

/** The frontend's auto-pan edge in screen pixels (useAutoPan.ts EDGE_THRESHOLD in 1.58.5). */
export const AUTO_PAN_EDGE_PX = 50;

/**
 * Whether a pointer at point ([clientX, clientY]) is in the band along the sides of the canvas
 * (bounds: { left, top, right, bottom } in client coordinates) where the frontend auto-pans.
 */
export function inAutoPanBand(point, bounds, edgePx = AUTO_PAN_EDGE_PX) {
  return point[0] - bounds.left < edgePx || bounds.right - point[0] < edgePx
    || point[1] - bounds.top < edgePx || bounds.bottom - point[1] < edgePx;
}

const add = (a, b) => [a[0] + b[0], a[1] + b[1]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const mul = (a, k) => [a[0] * k, a[1] * k];

/**
 * Classic canvas drag: each event moves the item by (clientNow - last_mouse) / scale.
 * Auto-pan and other moves between events show up as a difference between the item's
 * position and the position the model expected.
 */
export function deltaModel({ itemPos, lastReal }) {
  let raw = [...itemPos];
  let last = [...lastReal];
  let expected = null;
  return {
    step({ real, itemPos: pos, scale, lastDelivered }, solve, rewrite) {
      if (expected) raw = add(raw, sub(pos, expected));
      raw = add(raw, mul(sub(real, last), 1 / scale));
      last = [...real];
      if (!rewrite) {
        expected = add(pos, mul(sub(real, lastDelivered), 1 / scale));
        return { raw: [...raw], delivered: null };
      }
      const snapped = solve([...raw]);
      expected = snapped;
      return { raw: [...raw], delivered: add(lastDelivered, mul(sub(snapped, pos), scale)) };
    },
  };
}

/**
 * Nodes 2.0 drag: position = start + (client - pressClient) / scale.
 * When the view pans at the same scale (auto-pan, Space), the frontend shifts its start
 * position by the opposite of the offset change. A zoom changes the offset too; that is not a pan.
 * A wheel pan does not shift the start either. The caller says, per event, whether the frontend
 * shifts its start while handling that event (shiftsStart: Space pan, auto-pan). The offset change
 * seen at an event was made while the previous one was handled, so it is counted with the
 * previous event's flag.
 */
export function absoluteModel({ startPos, pressClient, offset, scale }) {
  let pan = [0, 0];
  let lastOffset = [...offset];
  let lastScale = scale;
  let prevShifts = false;
  return {
    step({ real, offset: o, scale: s, shiftsStart = false }, solve, rewrite) {
      if (s === lastScale && prevShifts) pan = sub(pan, sub(o, lastOffset));
      prevShifts = shiftsStart;
      lastOffset = [...o];
      lastScale = s;
      const start = add(startPos, pan);
      const raw = add(start, mul(sub(real, pressClient), 1 / s));
      if (!rewrite) return { raw, delivered: null };
      const snapped = solve([...raw]);
      return { raw, delivered: add(pressClient, mul(sub(snapped, start), s)) };
    },
    /** Sets, after solving, whether the frontend shifts its start while handling this event. */
    markShiftsStart(flag) {
      prevShifts = !!flag;
    },
  };
}

/**
 * Classic node resize: the moving edges follow the pointer in canvas coordinates from the press.
 * delivered is in canvas-element client coordinates: (canvas + offset) * scale.
 */
export function canvasResizeModel({ startEdge, pressCanvas }) {
  return {
    step({ pointerCanvas, offset, scale }, solve, rewrite) {
      const raw = add(startEdge, sub(pointerCanvas, pressCanvas));
      if (!rewrite) return { raw, delivered: null };
      const snapped = solve([...raw]);
      const canvasPoint = add(pressCanvas, sub(snapped, startEdge));
      return { raw, delivered: mul(add(canvasPoint, offset), scale) };
    },
  };
}

/** Nodes 2.0 node resize: the moving edges = start + (client - pressClient) / scale. */
export function clientResizeModel({ startEdge, pressClient }) {
  return {
    step({ real, scale }, solve, rewrite) {
      const raw = add(startEdge, mul(sub(real, pressClient), 1 / scale));
      if (!rewrite) return { raw, delivered: null };
      const snapped = solve([...raw]);
      return { raw, delivered: add(pressClient, mul(sub(snapped, startEdge), scale)) };
    },
  };
}
