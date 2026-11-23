/* 画布组低层工具：兼容 litegraph 新旧版本字段名，纯函数，不做业务判断 */

export function groupList(graph) {
  return graph?._groups || graph?.groups || [];
}

export function nodeList(graph) {
  return graph?._nodes || graph?.nodes || [];
}

/* 部分版本组内节点是懒计算的，先强制刷新再读 */
export function groupMembers(group) {
  if (typeof group.recomputeInsideNodes === "function") {
    try { group.recomputeInsideNodes(); } catch (e) { /* 旧版无此方法 */ }
  }
  if (Array.isArray(group._nodes) && group._nodes.length) return group._nodes;
  if (Array.isArray(group.nodes) && group.nodes.length) return group.nodes;
  const kids = group._children || group.children;
  return kids ? Array.from(kids) : [];
}

export function groupBounding(group) {
  const b = group._bounding || group.bounding;
  if (b && b.length >= 4) return b;
  /* 兜底：用 pos/size 拼，避免某些版本 bounding 未计算 */
  if (group.pos && group.size) {
    return [group.pos[0], group.pos[1], group.size[0], group.size[1]];
  }
  return null;
}

function nodeCenter(node) {
  return [
    node.pos[0] + (node.size?.[0] || 0) / 2,
    node.pos[1] + (node.size?.[1] || 0) / 2
  ];
}

/* 成员名单优先；组不持有成员时回退坐标判定（节点中心落在框内） */
export function inGroup(group, node) {
  const members = groupMembers(group);
  if (members.length) {
    return members.includes(node) || members.some((n) => n.id === node.id);
  }
  const b = groupBounding(group);
  if (!b || !node.pos) return false;
  const [x, y] = nodeCenter(node);
  return x >= b[0] && x <= b[0] + b[2] && y >= b[1] && y <= b[1] + b[3];
}

export function groupTitle(group) {
  return group.title || group._title || "";
}

/* 正常嵌套框归属最内层；交叉重叠或相同范围不猜归属。 */
export function nodeGroupOwner(groups, node) {
  const hits = groups.filter((g) => inGroup(g, node));
  if (hits.length <= 1) return hits[0] || null;
  return hits.find((inner) => {
    const a = groupBounding(inner);
    return a && hits.every((outer) => {
      if (inner === outer) return true;
      const b = groupBounding(outer);
      return b && a[0] >= b[0] && a[1] >= b[1]
        && a[0] + a[2] <= b[0] + b[2] && a[1] + a[3] <= b[1] + b[3]
        && (a[0] !== b[0] || a[1] !== b[1] || a[2] !== b[2] || a[3] !== b[3]);
    });
  }) || null;
}
