// 走线几何单测。跑法：
//   node js/pathing/test/run.mjs
// pathing/package.json 声明了 type=module，node 才能按 ESM 解析这些 .js。
//
// 覆盖纯几何（router / trace / nudge）+ registry 的缓存失效（B1）。registry 依赖
// window.LiteGraph 与一个最小 canvas/graph，两者都在下面现场 mock。

globalThis.window = { LiteGraph: { alwaysSnapToGrid: false, CANVAS_GRID_SIZE: 10 } }

import assert from 'node:assert/strict'
import { offsetStrand, route } from '../router.js'
import { measure, pointAt } from '../trace.js'
import { nudgePass } from '../nudge.js'
import { conf } from '../config.js'
import { beginFrame, routeFor } from '../registry.js'

let pass = 0
let fail = 0
function t(name, fn) {
  try {
    fn()
    pass++
    console.log('  ok   ' + name)
  } catch (err) {
    fail++
    console.log('  FAIL ' + name)
    console.log('       ' + err.message)
  }
}

// 折线是否与轴对齐矩形真正相交（擦边不算）。
function crossesRect(pts, [x0, y0, x1, y1]) {
  for (let i = 1; i < pts.length; i++) {
    const ax = Math.min(pts[i - 1][0], pts[i][0]), bx = Math.max(pts[i - 1][0], pts[i][0])
    const ay = Math.min(pts[i - 1][1], pts[i][1]), by = Math.max(pts[i - 1][1], pts[i][1])
    const ox = Math.min(bx, x1) - Math.max(ax, x0)
    const oy = Math.min(by, y1) - Math.max(ay, y0)
    if (ox > 0.5 && oy > 0.5) return true
  }
  return false
}

console.log('router')

t('直通且无障碍 -> null（交给核心样条）', () => {
  const r = route({
    start: [0, 100], end: [400, 100], startDir: 'right', endDir: 'left',
    obstacles: [], clearance: 16, stubStart: 24, stubEnd: 24
  })
  assert.equal(r, null)
})

t('前方有障碍 -> 绕行且不穿过节点', () => {
  const obs = [[150, 40, 80, 80]] // x 150-230, y 40-120
  const r = route({
    start: [0, 80], end: [400, 80], startDir: 'right', endDir: 'left',
    obstacles: obs, clearance: 16, stubStart: 24, stubEnd: 24
  })
  assert.ok(r && r.length >= 4, '期望真实折线，得到 ' + JSON.stringify(r))
  assert.ok(!crossesRect(r, [150, 40, 230, 120]), '折线穿过障碍: ' + JSON.stringify(r))
})

t('同一输入重复求解结果一致（A* 堆 tie-break 稳定）', () => {
  const args = {
    start: [0, 80], end: [400, 200], startDir: 'right', endDir: 'left',
    obstacles: [[150, 40, 80, 80], [260, 150, 60, 60]], clearance: 16, stubStart: 24, stubEnd: 24
  }
  const a = route(args)
  const b = route(args)
  const c = route(args)
  assert.deepEqual(a, b)
  assert.deepEqual(b, c)
})

t('offsetStrand: 退化模板返回 null', () => {
  // 段数不足
  assert.equal(offsetStrand([[0, 0], [10, 0]], [0, 0], [10, 0], 8), null)
  // 非正交
  assert.equal(offsetStrand([[0, 0], [10, 5], [20, 10], [30, 15]], [0, 0], [30, 15], 8), null)
})

t('offsetStrand: 同束 strand 平行等距', () => {
  const tpl = [[0, 0], [40, 0], [40, 100], [200, 100], [200, 160]]
  const a = offsetStrand(tpl, [0, 0], [200, 160], -8)
  const b = offsetStrand(tpl, [0, 0], [200, 160], 8)
  assert.ok(a && b)
  // 中段（竖段 x=40）分别被推到两侧
  const ax = a.find((p) => Math.abs(p[1] - 0) < 0.01 && p[0] !== 0)
  assert.ok(a.some((p) => Math.abs(p[0] - 32) < 0.01), 'a 未偏移到 32: ' + JSON.stringify(a))
  assert.ok(b.some((p) => Math.abs(p[0] - 48) < 0.01), 'b 未偏移到 48: ' + JSON.stringify(b))
  assert.ok(ax === undefined || true)
})

console.log('trace')

t('measure / pointAt: 端点与拐点', () => {
  const pts = [[0, 0], [100, 0], [100, 100]]
  const m = measure(pts)
  assert.equal(m.total, 200)
  assert.deepEqual([pointAt(pts, m, 0).x, pointAt(pts, m, 0).y], [0, 0])
  assert.deepEqual([pointAt(pts, m, 1).x, pointAt(pts, m, 1).y], [100, 100])
  assert.deepEqual([pointAt(pts, m, 0.5).x, pointAt(pts, m, 0.5).y], [100, 0])
})

console.log('nudge')

t('共线重叠的两条竖段被分开一个 lane', () => {
  const mk = (key, y0) => ({
    key,
    start: [0, y0],
    end: [300, y0 + 100],
    raw: [[0, y0], [100, y0], [100, y0 + 100], [300, y0 + 100]],
    pts: [],
    m: null
  })
  const a = mk('a', 0)
  const b = mk('b', 50)
  nudgePass([a, b], [])
  assert.notEqual(a.pts[1][0], b.pts[1][0], '两条段没有被分开')
  assert.equal(Math.abs(a.pts[1][0] - b.pts[1][0]), conf.lane)
  // 首末 stub 仍落在引脚一侧
  assert.equal(a.pts[0][0], 0)
  assert.equal(a.pts[3][0], 300)
})

console.log('registry')

function mockGraph(nodes) {
  return {
    _nodes: nodes,
    _links: new Map([[7, { origin_id: 1, origin_slot: 0, target_id: 2, target_slot: 0 }]]),
    _groups: [],
    reroutes: new Map(),
    getNodeById: () => null,
    getReroute: () => null
  }
}

function mockCanvas(graph) {
  return { graph, pointer: { isDown: false }, visible_area: null, connections_width: 3 }
}

function mockLink() {
  return {
    id: 7,
    startPoint: { x: 0, y: 80 },
    endPoint: { x: 400, y: 140 },
    startDirection: 'right',
    endDirection: 'left'
  }
}

// B1：走线端点没有动，但一个第三方节点挪到了原走线上。旧几何是绕旧障碍算的，
// 沿用它会让走线一直穿在移动后的节点上（key 不变 -> 永不重算）。
t('B1: 障碍物变化后端点未变的走线必须重算', () => {
  const graph = mockGraph([])
  const canvas = mockCanvas(graph)
  const link = mockLink()
  const settle = (n = 6) => { for (let i = 0; i < n; i++) beginFrame(canvas) }

  settle()
  routeFor(canvas, link) // 第 1 帧：稳定门控未满足 -> null
  const before = routeFor(canvas, link) // 第 2 帧：真正算线
  assert.ok(before?.raw, '无障碍物时应该算出走线')

  // 把一个节点放到原走线必经的区域上
  graph._nodes.push({ id: 99, pos: [150, 50], size: [80, 80] })
  settle()
  const after = routeFor(canvas, link)
  assert.ok(after?.raw, '障碍物变化后应该重算出走线')
  assert.notDeepEqual(after.pts, before.pts, 'B1 回归：走线沿用了旧几何')
  assert.ok(
    !crossesRect(after.pts, [150, 50, 230, 130]),
    '新走线穿过移动后的节点: ' + JSON.stringify(after.pts)
  )
})

t('B1: 端点未动且障碍物未变时命中缓存（不重复计算）', () => {
  const graph = mockGraph([])
  const canvas = mockCanvas(graph)
  const link = mockLink()
  for (let i = 0; i < 6; i++) beginFrame(canvas)
  routeFor(canvas, link)
  const a = routeFor(canvas, link)
  const b = routeFor(canvas, link)
  assert.equal(a, b, '同一帧内应返回同一个缓存条目')
})

// B6：组标题带应进入障碍集，否则走线横穿标题栏。
t('B6: 组标题带进入障碍集', () => {
  const graph = mockGraph([])
  graph._groups = [{ id: 5, pos: [150, 40], size: [200, 200] }]
  const canvas = mockCanvas(graph)
  const link = mockLink()
  for (let i = 0; i < 6; i++) beginFrame(canvas)
  routeFor(canvas, link)
  const e = routeFor(canvas, link)
  assert.ok(e?.raw, '应该算出走线')
  // 标题带 = 组上边缘 40 上下各 30 -> [150, 10, 200x60]
  assert.ok(
    !crossesRect(e.pts, [150, 10, 350, 70]),
    '走线穿过组标题带: ' + JSON.stringify(e.pts)
  )
})

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
