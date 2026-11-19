// Which node an Alt press cloned. Pure.
//
// The frontend clones only the pressed node, after this extension has seen the press. The clone
// is therefore a node that did not exist at the press. Other nodes may stay selected, so the
// selection alone cannot tell the clone apart.

/**
 * @param {Set<string>} beforeIds ids of the graph's nodes at the press
 * @param {Array<{id: unknown}>} nodes the graph's nodes now
 * @param {Set<string>} selectedIds ids of the selected nodes now
 * @returns the clone, or null when no node was added
 */
export function pickClone(beforeIds, nodes, selectedIds) {
  const added = nodes.filter((n) => !beforeIds.has(String(n.id)));
  return added.find((n) => selectedIds.has(String(n.id))) ?? added[0] ?? null;
}
