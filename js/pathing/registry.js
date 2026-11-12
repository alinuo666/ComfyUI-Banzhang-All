// Route cache + obstacle snapshot + nudge orchestration. Routes recompute only when
// their inputs change and never while the pointer is down (R6): a stale/missing route
// falls back to core's spline, which is exactly the wanted during-drag rendering.
//
// FORK NOTE (pcblinks): trimmed from cable-management's registry.js. The comb/gate/
// tooth machinery (ribbon crossings, gate stubs, comb obstacle rects) is cut; plain
// routing, reroute handling, per-side lane allocation, same-pair ribbon bundles and
// the nudge pass are verbatim. router.js / nudge.js / trace.js are unmodified copies.
import { offsetStrand, route } from './router.js'
import { measure } from './trace.js'
import { nudgePass } from './nudge.js'
import { conf } from './config.js'

const cache = new Map() // linkId|sx|sy|ex|ey -> {key, raw, pts, m, version}
let obstacles = []
let version = 0
let tick = 0 // frame counter; routeFor stamps every entry it serves
let lastHash = ''
let pendingHash = '' // 候选障碍快照：连续稳定若干帧后才提交
let pendingFrames = 0 // 候选快照连续出现的帧数（去抖）
let lastRouteStamp = ''

// 走线稳定性门控（R7）：节点引脚在某范围内来回振荡时，绝不让走线逐帧重路由跳跃。
// 只有新端点的 key 连续稳定若干帧后，才真正算线并提交；此前一直复用上一帧已画定
// 的几何。这与"行走线在手势间才重算、松手后落定"的设计意图完全一致 -- 振荡的引脚
// 永远到不了稳定阈值，走线就保持静止；真实且持续的移动（跨过 4px 网格）累积到稳定
// 帧数后会正常重路由。
const STABLE_FRAMES = 2
const routeCandidates = new Map() // key -> {key, frames}，等待达到稳定帧数

// 每帧给"障碍物已变、端点未变"的重算（routeFor 的 stale 分支）留多少毫秒。没有预算，
// 移动一个节点会让整屏走线在同一帧里全部重算 A*，大图上就是一次可见卡顿；超预算的走线
// 沿用旧几何，下一帧继续，摊平到几帧完成。时间预算而非条数预算：A* 的耗时随局部障碍
// 密度变化很大，固定条数在密集区照样卡。
const REROUTE_MS = 8
let budgetUntil = 0
const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now())

// 组标题带半高：标题画在组框上边缘附近，取上下各这么多像素作为禁区。
const GROUP_TITLE_BAND = 30

// Called from the wrapped drawConnections, once per frame, before core renders.
export function beginFrame(canvas) {
  const graph = canvas.graph
  if (!graph) return
  // 拖动中（R6）：走线交给核心样条实时跟随，routeFor 直接返回 null，不会用到障碍物
  // 快照。此时不必逐节点扫描/拼 hash，直接跳过整段障碍物与版本维护，省掉拖动期间
  // 的多余计算。
  if (canvas.pointer?.isDown) return
  budgetUntil = now() + REROUTE_MS
  let hash = ''
  const rects = []
  for (const node of graph._nodes) {
    const r = node.boundingRect ?? [node.pos[0], node.pos[1], node.size[0], node.size[1]]
    rects.push([r[0], r[1], r[2], r[3]])
    hash += `${node.id}|${r[0] | 0}|${r[1] | 0}|${r[2] | 0}|${r[3] | 0}|${node.flags?.collapsed ? 1 : 0};`
  }
  // 组（LGraphGroup）：只取标题带，不取整框 -- 整框会把大组内部的空白也变成禁区，逼着
  // 走线绕远；真正难看的只有线压在标题栏上。标题画在组框上边缘附近（不同 litegraph 版本
  // 在框内或框外），所以取上边缘上下各一段。boundingRect 在某些时刻是未计算的零框，故用
  // pos/size 并要求宽度有效。
  if (conf.avoidGroups) {
    for (const g of graph._groups ?? []) {
      const w = g.size?.[0] ?? 0
      if (!w || g.pos?.[0] == null || g.pos?.[1] == null) continue
      const r = [g.pos[0], g.pos[1] - GROUP_TITLE_BAND, w, GROUP_TITLE_BAND * 2]
      rects.push(r)
      hash += `g${g.id}|${r[0] | 0}|${r[1] | 0}|${r[2] | 0}|${r[3] | 0};`
    }
  }
  // 去抖：节点边界可能在极小的 1-2px 范围内来回抖动（如某些节点高度自动调整的
  // 反馈循环），若每一帧都据此重路由，走线会跟着闪。只有候选快照连续稳定若干帧
  // 后才提交为真实障碍物并递增版本，从而一次性重路由、消除闪烁。
  if (hash !== lastHash) {
    if (hash !== pendingHash) {
      pendingHash = hash
      pendingFrames = 0
    }
    if (++pendingFrames >= 3) {
      lastHash = hash
      obstacles = rects
      version++
      prune(graph)
      if (cache.size > 4096) cache.clear()
    }
  } else {
    pendingHash = ''
    pendingFrames = 0
  }

  // Reconcile bundles, then nudge, whenever the set of live routes changed. Routes
  // computed during THIS frame's draw get both passes next frame -- one-frame settle.
  //
  // Liveness needs more than the version stamp: slot positions settle over a couple of
  // mount frames while every node RECT stays put, so an entry made from the rough
  // default endpoints keeps the current version forever and would join nudge clusters
  // as a ghost segment on top of its refined twin. An entry that stopped being DRAWN
  // while sitting inside the viewport is such a ghost; one that is silent because it
  // scrolled out of view (the cull skips it) stays live so panning does not reflow lanes.
  const va = canvas.visible_area
  const live = []
  for (const e of cache.values()) {
    if (!e.raw || e.version !== version) continue
    let keep = e.tick >= tick - 2 || !va
    if (!keep) {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
      for (const p of e.raw) {
        if (p[0] < x0) x0 = p[0]
        if (p[0] > x1) x1 = p[0]
        if (p[1] < y0) y0 = p[1]
        if (p[1] > y1) y1 = p[1]
      }
      keep = x1 < va[0] || x0 > va[0] + va[2] || y1 < va[1] || y0 > va[1] + va[3]
    }
    e.live = keep
    if (keep) live.push(e)
  }
  tick++
  const changed = reconcileBundles(live)
  const stamp = live.map((e) => e.key).join(';') + `#v${version}`
  if (changed || stamp !== lastRouteStamp) {
    lastRouteStamp = stamp
    nudgePass(live, obstacles)
    for (const e of live) e.m = measure(e.pts)
  }
}

// Same-pair bundles are rebuilt as RIBBON STRANDS: the median member's A* route is
// the template, every member becomes the template offset along the path's left normal
// by its rank offset (entry order along the first mid run). This nests strands
// correctly around wraps -- which per-member y-translation cannot (it copies the
// source-side stacking onto every run and inverts the far side's required nesting).
// 束内 strand 间距取自 conf.lane。
function reconcileBundles(live) {
  const groups = new Map()
  for (const e of live) {
    if (!e.pairKey) continue
    if (!groups.has(e.pairKey)) groups.set(e.pairKey, [])
    groups.get(e.pairKey).push(e)
  }
  let changed = false
  for (const [pk, group] of groups) {
    // Reroute SEGMENTS share one link id and one pair -- they are sequential pieces,
    // not siblings, and must never be ribbon-rebuilt from each other's shapes.
    const byLink = new Map()
    for (const m of group) {
      const id = m.key.split('|')[0]
      byLink.set(id, (byLink.get(id) ?? 0) + 1)
    }
    const members = group.filter((m) => byLink.get(m.key.split('|')[0]) === 1)
    if (members.length < 2) continue
    const stamp = pk + '#' + version + '#' + members.map((m) => m.key).sort().join(';')
    if (members.every((m) => m.bundleStamp === stamp)) continue

    members.sort((a, b) => a.start[1] - b.start[1] || a.start[0] - b.start[0])
    const tpl = members[(members.length - 1) >> 1].raw
    if (!tpl || tpl.length < 4) {
      for (const m of members) m.bundleStamp = stamp
      continue
    }
    // Rank by entry position projected on the first mid segment's travel direction;
    // the furthest-along strand takes the lane nearest the pins' side of that run.
    const d1 = [Math.sign(tpl[2][0] - tpl[1][0]), Math.sign(tpl[2][1] - tpl[1][1])]
    const ln = [d1[1], -d1[0]] // left normal of travel
    const seg1Vert = d1[0] === 0
    const pinSide = Math.sign(
      seg1Vert ? members[0].start[0] - tpl[1][0] : members[0].start[1] - tpl[1][1]
    )
    const lnPerp = seg1Vert ? ln[0] : ln[1]
    const sideSign = pinSide === Math.sign(lnPerp) ? 1 : -1

    const ranked = members
      .map((m) => ({ m, proj: m.start[0] * d1[0] + m.start[1] * d1[1] }))
      .sort((a, b) => b.proj - a.proj || String(a.m.key).localeCompare(String(b.m.key)))
    const mid = (ranked.length - 1) / 2
    ranked.forEach(({ m }, rank) => {
      const o = (mid - rank) * conf.lane * sideSign
      const t = offsetStrand(tpl, m.start, m.end, o)
      if (t) {
        m.raw = t
        m.pts = t.map((p) => [p[0], p[1]])
        changed = true
      }
      m.bundleStamp = stamp
    })
  }
  return changed
}

// Per-node-side lane allocation (design spec): on each side, up-bending wires nest
// topmost-closest; down-bending wires start ONE LANE beyond the farthest up-bender,
// bottommost-closest. Deterministic from graph truth; the allocated stub tip becomes
// an A* lane and the horizontal-first tie-break lands the bend exactly on it, so the
// side forms a ribbon by slot order with no iteration. Slot ys come from litegraph's
// getConnectionPos -- offset from the DOM truth, but consistently so, and only order
// and rough approach direction matter here. Opposite-side pairs are not counted
// against each other: their crossing is topologically forced, so standoff buys nothing.
// 常量取自 conf：stub / stubPitch。
// Lane ladder pitch at a pin column. Tighter than the 8px strand pitch on purpose
// (polish round): the deepest lane's stub is MANDATORY length for every wire on the
// side, and at 8px a many-input node forced stubs long enough to loop. 5px is the
// ribbon's proven minimum for 3px strokes (3 + 2 gap). The nudge's cluster
// threshold sits BELOW this pitch so allocated neighbours never re-spread to 8.

// Exact endpoint ys per link, harvested from the draw calls. litegraph's
// getConnectionPos returns DEFAULT slot positions -- up to a slot column off on tall
// Vue nodes (the same bad data behind the ghost routes) -- which misclassifies
// approach directions. The memo self-corrects: allocation from defaults on the first
// frame, exact from the second; the changed stub re-keys the route and the ghost
// liveness retires the old one. Written per END: reroute segments share the link id,
// so a blanket {sy, ey} write from the final segment would record the last reroute's
// y as the origin pin's. sNext/ePrev are the IMMEDIATE hop past each pin -- the
// first/last reroute when the link has any -- because the approach direction at a
// node is set by the nearest hop, not the far pin.
const pinMemo = new Map() // linkId -> {sy, sNext, ey, ePrev}

function pinY(node, isInput, slot) {
  const p = node?.getConnectionPos?.(isInput, slot)
  return p ? p[1] : (node?.pos?.[1] ?? 0)
}

// Reroute ends. Core marks both reroute sides of a segment CENTER ('none') and
// nothing else ever gets that direction, so 'none' IS the reroute marker. The rule
// (design spec): the wire ENTERS a reroute horizontally from the side its upstream hop
// (output pin or parent reroute) sits on, and LEAVES from the opposite side -- the
// chain reads as one continuous run and never hooks around the dot. Upstream and
// downstream x come from the drawn sibling segments, graph truth is the first-frame
// fallback; a flipped side re-keys the route and ghost liveness retires the old
// shape, same as lane stubs. A dead-vertical upstream is the one case the rule
// leaves open: tie-break by downstream, so the exit faces where the wire goes next.
const rerouteMemo = new Map() // rerouteId -> {upX, downX}

function memoOf(id) {
  let m = rerouteMemo.get(id)
  if (!m) rerouteMemo.set(id, (m = {}))
  return m
}

function rerouteAt(graph, x, y) {
  if (!graph?.reroutes) return null
  for (const r of graph.reroutes.values()) {
    const p = r.pos
    if (Math.abs(p[0] - x) <= 0.5 && Math.abs(p[1] - y) <= 0.5) return r
  }
  return null
}

function upstreamX(graph, r) {
  const parent = r.parentId != null ? graph.getReroute?.(r.parentId) : null
  if (parent) return parent.pos[0]
  const ll = r.firstLink
  const n = ll && graph.getNodeById(ll.origin_id)
  return n?.getConnectionPos?.(false, ll.origin_slot)?.[0]
}

function downstreamX(graph, r) {
  for (const c of graph.reroutes.values()) {
    if (c.parentId !== r.id) continue
    for (const id of c.linkIds) if (r.linkIds?.has?.(id)) return c.pos[0]
  }
  const ll = r.firstLink
  const n = ll && graph.getNodeById(ll.target_id)
  return n?.getConnectionPos?.(true, ll.target_slot)?.[0]
}

// The side the wire enters this reroute from; the exit is always the opposite.
function rerouteSide(graph, r) {
  const m = rerouteMemo.get(r.id)
  const rx = r.pos[0]
  const ux = m?.upX ?? upstreamX(graph, r)
  if (ux != null && Math.abs(ux - rx) > 0.5) return ux < rx ? 'left' : 'right'
  const dx = m?.downX ?? downstreamX(graph, r)
  if (dx != null && Math.abs(dx - rx) > 0.5) return dx < rx ? 'right' : 'left'
  return 'left'
}

function laneStub(graph, node, isInput, slot) {
  const slots = node ? (isInput ? node.inputs : node.outputs) : null
  if (!slots) return conf.stub
  const list = []
  for (let j = 0; j < slots.length; j++) {
    // An output slot with several links is one pin, one lane; its wires fan at the
    // stub tip and the nudge fan-out staggers them from there.
    const linkId = isInput ? slots[j].link : slots[j].links?.[0]
    if (linkId == null) continue
    const ll = graph._links?.get?.(Number(linkId))
    if (!ll) continue
    const other = graph.getNodeById(isInput ? ll.origin_id : ll.target_id)
    if (!other) continue
    const m = pinMemo.get(Number(linkId))
    const y = (isInput ? m?.ey : m?.sy) ?? pinY(node, isInput, j)
    const otherY = (isInput ? m?.ePrev : m?.sNext) ??
      pinY(other, !isInput, isInput ? ll.origin_slot : ll.target_slot)
    list.push({ j, y, up: otherY <= y })
  }
  const ups = list.filter((s) => s.up).sort((a, b) => a.y - b.y)
  const downs = list.filter((s) => !s.up).sort((a, b) => b.y - a.y)
  let lane = ups.findIndex((s) => s.j === slot)
  if (lane < 0) {
    const d = downs.findIndex((s) => s.j === slot)
    if (d < 0) return conf.stub
    lane = ups.length + d
  }
  return conf.stub + lane * conf.stubPitch
}

export function routeFor(canvas, linkData) {
  const s = linkData.startPoint, e = linkData.endPoint
  const g = canvas.graph
  const llink = g?._links?.get?.(Number(linkData.id))
  const sIsPin = linkData.startDirection !== 'none'
  const eIsPin = linkData.endDirection !== 'none'
  if (llink) {
    let pm = pinMemo.get(Number(linkData.id))
    if (!pm) pinMemo.set(Number(linkData.id), (pm = {}))
    if (sIsPin) { pm.sy = s.y; pm.sNext = e.y }
    if (eIsPin) { pm.ey = e.y; pm.ePrev = s.y }
  }
  // Clearance shares the graph's snap arithmetic: with 10px snapping and 16px
  // inflation, lane furniture lives on a different modulus than the nodes and every
  // drop lands near-alignments at shifting sub-grid offsets (QA find: jank vanishes
  // at snap 16). Quantize UP to the grid so edges-on-grid put lanes on-grid too.
  const L = window.LiteGraph
  const grid = L?.alwaysSnapToGrid && L.CANVAS_GRID_SIZE > 0 ? L.CANVAS_GRID_SIZE : 0
  const clearance = grid ? Math.ceil(16 / grid) * grid : 16

  // Resolve reroute ends before the key: the entry side depends on the upstream hop,
  // so moving THAT can flip this segment's direction without touching its endpoints.
  // Memo writes first -- the incoming segment draws before the outgoing one, so the
  // exit side resolves from this frame's data.
  let sDir = linkData.startDirection, eDir = linkData.endDirection
  if (!sIsPin || !eIsPin) {
    const rS = sIsPin ? null : rerouteAt(g, s.x, s.y)
    const rE = eIsPin ? null : rerouteAt(g, e.x, e.y)
    if (rS) memoOf(rS.id).downX = e.x
    if (rE) memoOf(rE.id).upX = s.x
    if (!sIsPin) {
      sDir = rS ? (rerouteSide(g, rS) === 'left' ? 'right' : 'left') : 'right'
    }
    if (!eIsPin) {
      eDir = rE ? rerouteSide(g, rE) : 'left'
    }
  }
  // Allocation is part of the cache key: connecting or dropping a SIBLING link changes
  // this link's lane without moving its endpoints or any node rect. The old entry
  // simply stops being served and the ghost liveness retires it. Lane allocation
  // belongs to node sides only -- a reroute end takes the plain stub (the llink's
  // origin/target slots describe the CHAIN's pins, not this segment's endpoints).
  let stubStart = conf.stub, stubEnd = conf.stub
  if (llink) {
    if (sIsPin) stubStart = laneStub(g, g.getNodeById(llink.origin_id), false, llink.origin_slot)
    if (eIsPin) stubEnd = laneStub(g, g.getNodeById(llink.target_id), true, llink.target_slot)
  }
  // Facing endpoints closer than their combined stub depth: deep lane ladders
  // (STUB + rank*PITCH, ~100px on wide sides) overshoot a short gap, the stub
  // tips cross, and A* folds a 4-bend loop around them (measured: 115px gap,
  // 500px of wire, one self-crossing per link). Scale both stubs to fit the
  // gap, preserving their ratio so lane order survives the squeeze.
  if (stubStart + stubEnd > 0) {
    const svx = sDir === 'right' ? 1 : sDir === 'left' ? -1 : 0
    const svy = sDir === 'down' ? 1 : sDir === 'up' ? -1 : 0
    const facing =
      (svx && eDir === (svx > 0 ? 'left' : 'right') && (e.x - s.x) * svx > 0 && (e.x - s.x) * svx < stubStart + stubEnd) ||
      (svy && eDir === (svy > 0 ? 'up' : 'down') && (e.y - s.y) * svy > 0 && (e.y - s.y) * svy < stubStart + stubEnd)
    if (facing) {
      const gap = svx ? Math.abs(e.x - s.x) : Math.abs(e.y - s.y)
      const k = gap / (stubStart + stubEnd)
      stubStart = Math.max(1, Math.floor(stubStart * k))
      stubEnd = Math.max(1, Math.floor(stubEnd * k))
    }
  }
  // 端点抖动去抖：某些节点的引脚 Y 会因高度自动调整在 1-2px 内来回抖动。若直接以
  // 原始坐标作 key，每帧都会跨过整数边界 → 换 key → 重路由 → 走线闪烁。端点按 4px
  // 网格量化后，微小抖动落在同一格内就直接命中缓存、复用稳定的几何，不再逐帧重算。
  // （route() 首次计算仍用实时端点；命中缓存后返回的 pts 是首帧几何，天然静止。）
  const q = (v) => Math.round(v / 4) * 4
  const key = `${linkData.id}|${q(s.x)}|${q(s.y)}|${q(e.x)}|${q(e.y)}|${stubStart}|${stubEnd}|${sDir}>${eDir}`
  const hit = cache.get(key)
  // 障碍物已变（version 推进）但本链路端点没变：旧几何是绕旧障碍算的，沿用它会让走线
  // 一直穿在移动后的节点上 -- key 不变就永远不会重算。视为未命中，用新障碍直算。
  const stale = hit != null && hit.version !== version
  if (hit && !stale) {
    hit.tick = tick
    return hit.raw ? hit : null
  }

  // R6: 拖动中不算线 -- 核心样条负责实时跟随节点端点（换 key 通常无缓存命中，返回
  // null 即走核心样条）；若恰好命中缓存才沿用该走线。松手后 R7 稳定门控再落定。
  if (canvas.pointer?.isDown) return hit && hit.raw ? hit : null

  if (stale) {
    // 端点既然稳定过，跳过 R7 门控直接重算，只受本帧时间预算约束。
    if (now() > budgetUntil) return hit.raw ? hit : null
  } else {
    // R7 稳定性门控：新端点 key 需连续稳定若干帧才真正算线。等待期间不显示"脱节的旧
    // 走线"（那会造成松手后停在旧位置再猛跳），而是回落 null 让核心样条贴着节点平滑
    // 跟随；一旦稳定立即提交 PCB 落定。振荡源（100ms 无条件重绘）已在上轮关闭，空闲
    // 时此处几乎不会被触发，门控只需很轻即可兼顾顺滑。
    const cand = routeCandidates.get(key) || { key, frames: 0 }
    cand.frames++
    routeCandidates.set(key, cand)
    if (cand.frames < STABLE_FRAMES) {
      if (routeCandidates.size > 1024) routeCandidates.clear()
      return null
    }
    routeCandidates.delete(key)
  }

  // Every link routes independently; same-pair bundles are rebuilt as ribbon strands
  // by reconcileBundles on the next beginFrame (one-frame settle).
  const pairKey = llink ? `${llink.origin_id}>${llink.target_id}` : null

  const raw = route({
    start: [s.x, s.y],
    end: [e.x, e.y],
    startDir: sDir,
    endDir: eDir,
    obstacles,
    clearance,
    stubStart,
    stubEnd,
    // Shadow standoff, quantized like clearance so lanes stay on-grid.
    vPad: grid ? Math.ceil(conf.vPad / grid) * grid : conf.vPad,
    // Near-straight fallback: a jog thinner than the stroke is drawing noise.
    flatTol: canvas.connections_width ?? 3
  })
  const entry = raw
    ? {
        key, raw, pts: raw.map((p) => [p[0], p[1]]), m: measure(raw), version, tick,
        pairKey, start: [s.x, s.y], end: [e.x, e.y]
      }
    : { key, raw: null, version, tick }
  cache.set(key, entry)
  return raw ? entry : null
}

// 删除的链路与 reroute 会在 memo / cache 里留下永不命中的条目。只在障碍物版本推进时
// 清一次（节点增删或移动），摊到低频，代价是一次 O(memo + cache) 扫描。
function prune(graph) {
  const links = graph?._links
  if (links?.has) {
    for (const id of pinMemo.keys()) if (!links.has(id)) pinMemo.delete(id)
    // cache key 的第一段就是 link id。
    for (const key of cache.keys()) if (!links.has(Number(key.split('|')[0]))) cache.delete(key)
  }
  const rs = graph?.reroutes
  if (rs?.has) for (const id of rerouteMemo.keys()) if (!rs.has(id)) rerouteMemo.delete(id)
}

// 参数（conf）变更后调用：清缓存并强制下一帧重提障碍物快照。
export function invalidate() {
  version++
  cache.clear()
  routeCandidates.clear()
  lastHash = ''
  pendingHash = ''
  pendingFrames = 0
}

export function stats() {
  return { cached: cache.size, obstacles: obstacles.length, version }
}

export function debugRoutes() {
  return [...cache.entries()]
    .filter(([, e]) => e.raw && e.version === version && e.live !== false)
    .map(([key, e]) => ({ key, pts: e.pts, raw: e.raw }))
}
