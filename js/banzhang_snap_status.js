// Which parts of the extension work with the running frontend, and why not.
//
// Every feature that depends on frontend internals reports here (see docs/frontend-dependencies.md
// for what each one relies on). A feature is "ok", "fallback" (works another way, with something
// lost), or "off" (switched off; the frontend's own behavior stays). Status changes go to the
// console; SmartGuidesStatus() in the browser console prints the table for issue reports.

export const FEATURES = {
  globals: "Frontend globals (LiteGraph classes on window)",
  snap: "Snap while dragging and resizing",
  nodeBoxes: "Nodes 2.0 node boxes from the DOM",
  grid: "Shift without the grid; grid and snap together",
  groupCorners: "Group resize from the four corners",
  cursor: "Corner cursor",
  wireColor: "Recolor flat wires",
  toolboxButton: "Menu button on the selection toolbox",
  actionBarButton: "Menu button next to Run",
};

const ERRORS_BEFORE_OFF = 3; // in a row: a clean run in between resets the count (clean())

export function createStatus(log = console) {
  const table = new Map(Object.keys(FEATURES).map((k) => [k, { status: "ok", reason: "" }]));
  const errors = new Map();

  /** Sets a feature's status; logs it when it changes. "off" is final for the page. */
  function report(feature, status, reason = "") {
    const cur = table.get(feature) ?? { status: "ok", reason: "" };
    if (cur.status === "off") return;
    if (cur.status === status && cur.reason === reason) return;
    table.set(feature, { status, reason });
    if (status !== "ok") log.warn(`[Smart Guides] ${FEATURES[feature] ?? feature}: ${status}${reason ? ` — ${reason}` : ""}`);
  }

  const isOff = (feature) => table.get(feature)?.status === "off";
  const get = (feature) => table.get(feature)?.status ?? "ok";

  /**
   * Counts an exception thrown inside a feature. The caller ends what was going on (a drag, a
   * resize); after a few exceptions the feature is switched off.
   */
  function fail(feature, err) {
    const n = (errors.get(feature) ?? 0) + 1;
    errors.set(feature, n);
    log.warn(`[Smart Guides] ${FEATURES[feature] ?? feature}: error ${n}/${ERRORS_BEFORE_OFF}`, err);
    if (n >= ERRORS_BEFORE_OFF) report(feature, "off", "kept throwing; a frontend internal it relies on probably changed");
  }

  /** A clean run of the feature: earlier exceptions no longer count toward switching it off. */
  function clean(feature) {
    if (errors.get(feature)) errors.set(feature, 0);
  }

  /** Rows for console.table. */
  function rows() {
    return Object.fromEntries([...table].map(([k, v]) => [k, { status: v.status, reason: v.reason, errors: errors.get(k) ?? 0 }]));
  }

  return { report, fail, clean, isOff, get, rows };
}
