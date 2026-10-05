import type { Entity, EntityType, Fact, Group, TruthState } from './types'
import { layerOf } from './layers'

export const NODE_W = 230
export const NODE_H = 56
type Point = { x: number; y: number }

export type ViewOptions = { visibleLayers: Set<string> | null; collapseActivities: boolean; showLanes: boolean; entityTypes: EntityType[] }
export type EntityVNode = { kind: 'entity'; id: string; entity: Entity; position: Point; layer: string; hidden: number; container?: { groupId: string; count: number; collapsed: boolean }; inGroup?: string }
export type GroupVNode = { kind: 'group'; id: string; group: Group; position: Point; count: number; kinds: [string, number][]; states: Record<TruthState, number>; internal: number; layer: string }
/** count > 1: activities with the same operation between the same (collapsed) nodes, drawn as one; facts lists them. */
export type ActivityVNode = { kind: 'activity'; id: string; fact: Fact; position: Point; count: number; facts: Fact[] }
export type FrameVNode = { kind: 'frame'; id: string; label: string; position: Point; width: number; height: number; tone: 'group' | 'lane'; groupId?: string }
export type VNode = EntityVNode | GroupVNode | ActivityVNode | FrameVNode
export type VEdge = { id: string; source: string; target: string; label: string; state: TruthState; count: number; factIds: string[]; role?: string; activityId?: string }
export type ViewModel = { nodes: VNode[]; edges: VEdge[]; repOf: (entityId: string) => string | null; groupOf: Map<string, Group> }

export const groupNodeId = (id: string) => `group:${id}`
export const activityNodeId = (id: string) => `act:${id}`

export function combineStates(states: Iterable<TruthState>): TruthState {
  const set = new Set(states)
  if (set.has('disputed') || (set.has('supported') && set.has('refuted'))) return 'disputed'
  if (set.has('supported')) return 'supported'
  if (set.has('refuted')) return 'refuted'
  return 'unknown'
}

const centroid = (points: Point[]): Point => points.length
  ? { x: points.reduce((s, p) => s + p.x, 0) / points.length, y: points.reduce((s, p) => s + p.y, 0) / points.length }
  : { x: 0, y: 0 }

function bbox(points: Point[], pad: number, header: number) {
  const minX = Math.min(...points.map(p => p.x)), minY = Math.min(...points.map(p => p.y))
  const maxX = Math.max(...points.map(p => p.x)) + NODE_W, maxY = Math.max(...points.map(p => p.y)) + NODE_H
  return { position: { x: minX - pad, y: minY - pad - header }, width: maxX - minX + pad * 2, height: maxY - minY + pad * 2 + header }
}

/**
 * Build the canvas representation: collapsed groups replace their members, activities become hubs,
 * edges between the same visible ends are bundled with a count.
 */
export function buildViewModel(entities: Entity[], facts: Fact[], groups: Group[], options: ViewOptions): ViewModel {
  const byId = new Map(entities.map(e => [e.id, e]))
  const layer = new Map(entities.map(e => [e.id, layerOf(e, options.entityTypes)]))
  const layerVisible = (id: string) => !options.visibleLayers || options.visibleLayers.has(layer.get(id) ?? 'other')
  const groupOf = new Map<string, Group>()
  for (const group of groups) for (const id of group.member_ids) groupOf.set(id, group)

  const repCache = new Map<string, string | null>()
  const repOf = (id: string, depth = 0): string | null => {
    if (repCache.has(id)) return repCache.get(id)!
    let result: string | null = null
    if (byId.has(id) && depth < 8) {
      const group = groupOf.get(id)
      if (group?.collapsed) {
        const container = group.rule?.container_id
        if (container && byId.has(container)) result = repOf(container, depth + 1)
        else if (group.member_ids.some(layerVisible)) result = groupNodeId(group.id)
      } else if (layerVisible(id)) result = id
    }
    repCache.set(id, result)
    return result
  }

  const nodes: VNode[] = []
  const entityNodes = new Map<string, EntityVNode>()
  const positions = new Map<string, Point>()
  for (const entity of entities) {
    if (repOf(entity.id) !== entity.id) continue
    const group = groupOf.get(entity.id)
    const node: EntityVNode = { kind: 'entity', id: entity.id, entity, position: entity.position ?? { x: 0, y: 0 }, layer: layer.get(entity.id) ?? 'other', hidden: 0, inGroup: group && !group.rule?.container_id ? group.name : undefined }
    entityNodes.set(entity.id, node); positions.set(entity.id, node.position); nodes.push(node)
  }
  for (const group of groups) if (group.rule?.container_id) {
    const container = entityNodes.get(group.rule.container_id)
    if (container && group.member_ids.length) container.container = { groupId: group.id, count: group.member_ids.length, collapsed: group.collapsed }
  }
  const groupNodes = new Map<string, GroupVNode>()
  for (const group of groups) {
    if (!group.collapsed || group.rule?.container_id || !group.member_ids.some(layerVisible)) continue
    const members = group.member_ids.map(id => byId.get(id)!).filter(Boolean)
    const kinds = new Map<string, number>(); const layers = new Map<string, number>()
    for (const m of members) { kinds.set(m.kind, (kinds.get(m.kind) ?? 0) + 1); const l = layer.get(m.id) ?? 'other'; layers.set(l, (layers.get(l) ?? 0) + 1) }
    const node: GroupVNode = { kind: 'group', id: groupNodeId(group.id), group, count: members.length,
      position: group.position ?? centroid(members.map(m => m.position ?? { x: 0, y: 0 })),
      kinds: [...kinds.entries()].sort((a, b) => b[1] - a[1]), states: { supported: 0, disputed: 0, refuted: 0, unknown: 0 }, internal: 0,
      layer: [...layers.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'other' }
    groupNodes.set(node.id, node); positions.set(node.id, node.position); nodes.push(node)
  }

  const edges = new Map<string, VEdge & { states: TruthState[]; plain: boolean }>()
  const hubSlots = new Map<string, number>()
  // Activities that look the same once groups are collapsed (same operation, same visible participants) are one node.
  const bundles = new Map<string, ActivityVNode & { edgeKeys: string[] }>()
  const noteHidden = (a: string | null, b: string | null) => {
    if (a && !b) { const n = entityNodes.get(a); if (n) n.hidden++ }
    if (b && !a) { const n = entityNodes.get(b); if (n) n.hidden++ }
  }
  for (const fact of facts) {
    const participants = fact.participants?.length ? fact.participants : null
    if (participants && !options.collapseActivities) {
      const reps = participants.map(p => ({ role: p.role, rep: repOf(p.entity_id) }))
      const visible = reps.filter((r): r is { role: string; rep: string } => !!r.rep)
      for (const r of reps) if (!r.rep) for (const v of visible) { const n = entityNodes.get(v.rep); if (n) { n.hidden++; break } }
      if (!visible.length) continue
      const bundleKey = `${fact.predicate.trim().toLowerCase()}\u0000${[...new Set(visible.map(v => `${v.role}|${v.rep}`))].sort().join('\u0001')}`
      const bundle = bundles.get(bundleKey)
      if (bundle) {
        bundle.count++
        bundle.facts.push(fact)
        for (const key of bundle.edgeKeys) { const edge = edges.get(key); if (edge) { edge.count++; edge.factIds.push(fact.id); edge.states.push(fact.truth_state) } }
        continue
      }
      const hub = activityNodeId(fact.id)
      let position = fact.position
      if (!position) {
        const c = centroid(visible.map(v => positions.get(v.rep) ?? { x: 0, y: 0 }))
        const key = `${Math.round(c.x)}:${Math.round(c.y)}`
        const slot = hubSlots.get(key) ?? 0; hubSlots.set(key, slot + 1)
        position = { x: c.x + NODE_W / 2 - 14, y: c.y + NODE_H / 2 - 14 + (slot ? (slot % 2 ? 1 : -1) * Math.ceil(slot / 2) * 44 : 0) + (visible.length < 2 ? 90 : 0) }
      }
      const node = { kind: 'activity' as const, id: hub, fact, position, count: 1, facts: [fact], edgeKeys: [] as string[] }
      bundles.set(bundleKey, node)
      nodes.push(node)
      const seen = new Set<string>()
      for (const { role, rep } of visible) {
        const key = `${role}|${rep}`
        if (seen.has(key)) continue
        seen.add(key)
        const outgoing = role === 'target'
        edges.set(`${fact.id}:${key}`, { id: `${fact.id}:${key}`, source: outgoing ? hub : rep, target: outgoing ? rep : hub, label: role, role, state: fact.truth_state, count: 1, factIds: [fact.id], activityId: fact.id, states: [fact.truth_state], plain: false })
        node.edgeKeys.push(`${fact.id}:${key}`)
      }
      continue
    }
    const s = repOf(fact.subject_id), t = repOf(fact.object_id)
    if (!s || !t) { noteHidden(s, t); continue }
    if (s === t) { const g = groupNodes.get(s); if (g) g.internal++; continue }
    const key = `${s}|${t}|${fact.predicate.trim().toLowerCase()}`
    const existing = edges.get(key)
    if (existing) { existing.count++; existing.factIds.push(fact.id); existing.states.push(fact.truth_state) }
    else edges.set(key, { id: key, source: s, target: t, label: fact.predicate, state: fact.truth_state, count: 1, factIds: [fact.id], states: [fact.truth_state], plain: entityNodes.has(s) && entityNodes.has(t) })
    for (const end of [s, t]) { const g = groupNodes.get(end); if (g) g.states[fact.truth_state]++ }
  }
  const edgeList: VEdge[] = [...edges.values()].map(({ states, plain, ...edge }) => ({
    ...edge, id: edge.activityId ? edge.id : edge.count === 1 && plain ? edge.factIds[0] : `agg:${edge.id}`,
    state: edge.activityId && edge.count === 1 ? edge.state : combineStates(states),
  }))
  for (const node of nodes) if (node.kind === 'activity') delete (node as Partial<ActivityVNode & { edgeKeys: string[] }>).edgeKeys

  const frames: FrameVNode[] = []
  for (const group of groups) {
    if (group.collapsed || group.rule?.container_id) continue
    const members = group.member_ids.filter(id => entityNodes.has(id)).map(id => positions.get(id)!)
    if (members.length < 1) continue
    frames.push({ kind: 'frame', id: `frame:${group.id}`, label: `${group.name} · ${group.member_ids.length}`, tone: 'group', groupId: group.id, ...bbox(members, 18, 26) })
  }
  if (options.showLanes) {
    const byLayer = new Map<string, Point[]>()
    for (const node of nodes) if (node.kind === 'entity' || node.kind === 'group') {
      const list = byLayer.get(node.layer); if (list) list.push(node.position); else byLayer.set(node.layer, [node.position])
    }
    for (const [id, points] of byLayer) frames.push({ kind: 'frame', id: `lane:${id}`, label: id, tone: 'lane', ...bbox(points, 36, 34) })
  }
  return { nodes: [...frames, ...nodes], edges: edgeList, repOf: (id: string) => repOf(id), groupOf }
}

export type GroupSuggestion = { id: string; name: string; members: string[]; outliers: string[]; reason: string; rule?: { kinds: string[] } }

/**
 * Entities of one type with exactly the same connections are candidates for one group.
 * Same-type entities that share some but not all connections stay outside: they are the anomalies.
 */
export function groupSuggestions(entities: Entity[], facts: Fact[], groups: Group[], minSize = 4): GroupSuggestion[] {
  const grouped = new Set(groups.flatMap(g => g.member_ids))
  const names = new Map(entities.map(e => [e.id, e.name]))
  const tokens = new Map<string, Set<string>>()
  const add = (id: string, token: string) => { let set = tokens.get(id); if (!set) tokens.set(id, set = new Set()); set.add(token) }
  for (const fact of facts) {
    if (fact.participants?.length) {
      for (const p of fact.participants) add(p.entity_id, `a:${p.role}:${fact.predicate.toLowerCase()}:${fact.participants.filter(o => o.entity_id !== p.entity_id).map(o => o.entity_id).sort().join(',')}`)
    } else {
      add(fact.subject_id, `o:${fact.predicate.toLowerCase()}:${fact.object_id}`)
      add(fact.object_id, `i:${fact.predicate.toLowerCase()}:${fact.subject_id}`)
    }
  }
  const buckets = new Map<string, string[]>()
  for (const entity of entities) {
    const set = tokens.get(entity.id)
    if (grouped.has(entity.id) || !set?.size) continue
    const key = `${entity.kind}\u0000${[...set].sort().join('\u0001')}`
    const list = buckets.get(key); if (list) list.push(entity.id); else buckets.set(key, [entity.id])
  }
  const describe = (token: string) => {
    const [dir, a, b, c] = token.split(':')
    if (dir === 'o') return `${a} ${names.get(b) ?? '?'}`
    if (dir === 'i') return `${a} by ${names.get(b) ?? '?'}`
    return `${a} in “${b}” with ${(c ?? '').split(',').map(id => names.get(id) ?? '?').slice(0, 2).join(', ')}`
  }
  const result: GroupSuggestion[] = []
  const covered = new Set<string>()
  for (const [key, members] of buckets) {
    if (members.length < minSize) continue
    const kind = key.split('\u0000')[0]
    const shared = [...tokens.get(members[0])!]
    const memberSet = new Set(members)
    const outliers = entities.filter(e => e.kind === kind && !memberSet.has(e.id) && !grouped.has(e.id) && [...(tokens.get(e.id) ?? [])].some(t => shared.includes(t))).map(e => e.id)
    members.forEach(m => covered.add(m))
    result.push({ id: `sig:${members[0]}`, name: `${members.length} ${kind}`, members, outliers, reason: `Same connections: ${shared.slice(0, 2).map(describe).join('; ')}${shared.length > 2 ? ` +${shared.length - 2}` : ''}` })
  }
  const perKind = new Map<string, string[]>()
  for (const entity of entities) if (!grouped.has(entity.id)) { const list = perKind.get(entity.kind); if (list) list.push(entity.id); else perKind.set(entity.kind, [entity.id]) }
  for (const [kind, members] of perKind) {
    const uncovered = members.filter(m => !covered.has(m))
    if (members.length >= 25 && uncovered.length >= members.length * 0.3)
      result.push({ id: `kind:${kind}`, name: `All ${kind}`, members, outliers: [], reason: `${members.length} entities of type ${kind}; new ones join automatically`, rule: { kinds: [kind] } })
  }
  return result.sort((a, b) => b.members.length - a.members.length).slice(0, 10)
}

// Shared edge geometry: the canvas and image export draw edges identically.
export type NodeBox = { x: number; y: number; w: number; h: number }
export function borderPoint(from: NodeBox, toward: Point, pad = 0): Point {
  const dx = toward.x - from.x, dy = toward.y - from.y
  if (!dx && !dy) return { x: from.x, y: from.y }
  const scale = Math.min((from.w / 2 + pad) / Math.abs(dx || 1e-9), (from.h / 2 + pad) / Math.abs(dy || 1e-9))
  return { x: from.x + dx * scale, y: from.y + dy * scale }
}

/** Floating edge between two node boxes (centre + size); parallel edges bend by `offset`. */
export function edgeGeometry(a: NodeBox, b: NodeBox, offset: number) {
  const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2
  const len = Math.hypot(b.x - a.x, b.y - a.y) || 1
  const cx = mx + (-(b.y - a.y) / len) * offset * 2, cy = my + ((b.x - a.x) / len) * offset * 2
  const start = borderPoint(a, offset ? { x: cx, y: cy } : b)
  const end = borderPoint(b, offset ? { x: cx, y: cy } : a, 3)
  const path = offset ? `M ${start.x} ${start.y} Q ${cx} ${cy} ${end.x} ${end.y}` : `M ${start.x} ${start.y} L ${end.x} ${end.y}`
  const label = offset ? { x: 0.25 * start.x + 0.5 * cx + 0.25 * end.x, y: 0.25 * start.y + 0.5 * cy + 0.25 * end.y } : { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 }
  return { path, label, start, end }
}

export const edgeWidth = (count: number) => count > 1 ? Math.min(1.5 + Math.log10(count) * 1.6, 5) : 1.5

/** Parallel edges between the same two nodes get symmetric offsets so they do not overlap. */
export function edgeOffsets(edges: Pick<VEdge, 'id' | 'source' | 'target'>[]) {
  const pairs = new Map<string, Pick<VEdge, 'id' | 'source' | 'target'>[]>()
  for (const edge of edges) {
    const key = edge.source < edge.target ? `${edge.source}|${edge.target}` : `${edge.target}|${edge.source}`
    const list = pairs.get(key); if (list) list.push(edge); else pairs.set(key, [edge])
  }
  const offsets = new Map<string, number>()
  for (const list of pairs.values()) list.forEach((edge, index) => {
    const raw = list.length > 1 ? (index - (list.length - 1) / 2) * 34 : 0
    offsets.set(edge.id, edge.source < edge.target ? raw : -raw)
  })
  return offsets
}

const CELL_W = NODE_W + 30, CELL_H = NODE_H + 24

/**
 * Members in a screen-shaped grid, sorted by name, next to the card at `anchor`: towards the outside of the graph
 * (`side` right: the grid starts one column right of the card, so the cards stacked above and below it in a flow
 * layout stay visible), or centred on it.
 */
export function packedPositions(members: Entity[], anchor: Point, side: 'left' | 'right' | 'center' = 'center') {
  const cols = Math.max(1, Math.ceil(Math.sqrt(1.6 * members.length * CELL_H / CELL_W)))
  const rows = Math.ceil(members.length / cols)
  const snap = (n: number) => Math.round(n / 20) * 20
  const left = snap(side === 'right' ? anchor.x + CELL_W : side === 'left' ? anchor.x - cols * CELL_W : anchor.x + NODE_W / 2 - cols * CELL_W / 2)
  const top = snap(anchor.y + NODE_H / 2 - rows * CELL_H / 2)
  const sorted = [...members].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }) || a.id.localeCompare(b.id))
  return new Map(sorted.map((e, i) => [e.id, { x: left + (i % cols) * CELL_W, y: top + Math.floor(i / cols) * CELL_H }]))
}

/**
 * Actions for collapsing or expanding a group. The collapsed card and the expanded members share one place:
 * expanding moves the members so their centre lands where the card was (it may have been dragged or arranged),
 * collapsing puts the card at the members' centre.
 *
 * Members that are scattered (an import or "Group all similar" collected them from all over the board) or piled up
 * are laid out as a grid at the card instead, growing away from the rest of the graph; members someone arranged keep
 * their arrangement. Activities of the members that shared one spot (drawn as one while the group was collapsed) go
 * back to automatic placement between their participants. `context` (all groups and facts) enables both.
 */
export function groupToggleDrafts(group: Group, entities: Entity[], collapsed: boolean, context: { groups?: Group[]; facts?: Fact[] } = {}) {
  // Container contents have no card of their own, so there is no place to keep in sync.
  if (group.rule?.container_id) return [{ type: 'group.update' as const, payload: { id: group.id, collapsed } }]
  const members = new Set(group.member_ids)
  const placed = entities.filter(e => members.has(e.id) && e.position)
  const centre = centroid(placed.map(e => e.position!))
  const round = (p: Point) => ({ x: Math.round(p.x), y: Math.round(p.y) })
  if (collapsed) return [{ type: 'group.update' as const, payload: { id: group.id, collapsed, ...(placed.length ? round(centre) : {}) } }]
  const all = entities.filter(e => members.has(e.id))
  const anchor = group.position ?? (placed.length ? centre : null)
  let moves: { type: 'entity.position'; payload: { id: string; x: number; y: number } }[] = []
  if (anchor && all.length >= 4 && (placed.length < all.length || scattered(placed))) {
    // Which way is outside: compare the card with what else is visible (members of collapsed groups are hidden).
    const hidden = new Set((context.groups ?? []).filter(g => g.collapsed && g.id !== group.id && !g.rule?.container_id).flatMap(g => g.member_ids))
    const others = [...entities.filter(e => e.position && !members.has(e.id) && !hidden.has(e.id)).map(e => e.position!.x),
      ...(context.groups ?? []).filter(g => g.collapsed && g.id !== group.id && g.position).map(g => g.position!.x)]
    let left = anchor.x, right = anchor.x
    for (const x of others) { if (x < left) left = x; if (x > right) right = x }
    // Away from the middle of the graph: a card in the right half (targets in a flow layout) grows to the right.
    const middle = (left + right) / 2
    const side = !others.length ? 'center' : anchor.x > middle + NODE_W / 2 ? 'right' : anchor.x < middle - NODE_W * 1.5 ? 'left' : 'center'
    moves = [...packedPositions(all, anchor, side)].map(([id, p]) => ({ type: 'entity.position' as const, payload: { id, ...p } }))
  } else {
    const dx = group.position && placed.length ? group.position.x - centre.x : 0
    const dy = group.position && placed.length ? group.position.y - centre.y : 0
    if (Math.hypot(dx, dy) >= 1) moves = placed.map(e => ({ type: 'entity.position' as const, payload: { id: e.id, ...round({ x: e.position!.x + dx, y: e.position!.y + dy }) } }))
  }
  const spots = new Map<string, string[]>()
  for (const fact of context.facts ?? []) {
    if (!fact.position || !(fact.participants?.length ? fact.participants.some(p => members.has(p.entity_id)) : members.has(fact.subject_id) || members.has(fact.object_id))) continue
    const key = `${Math.round(fact.position.x)}:${Math.round(fact.position.y)}`
    spots.set(key, [...(spots.get(key) ?? []), fact.id])
  }
  const released = [...spots.values()].filter(ids => ids.length > 1).flat()
    .map(id => ({ type: 'fact.position' as const, payload: { id, x: null, y: null } }))
  return [...moves, ...released, { type: 'group.update' as const, payload: { id: group.id, collapsed } }]
}

/** Spread far wider than a grid of them would be, or piled on few spots. */
function scattered(placed: Entity[]) {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
  for (const { position: p } of placed) { minX = Math.min(minX, p!.x); maxX = Math.max(maxX, p!.x); minY = Math.min(minY, p!.y); maxY = Math.max(maxY, p!.y) }
  const area = (maxX - minX + NODE_W) * (maxY - minY + NODE_H)
  const spots = new Set(placed.map(e => `${Math.round(e.position!.x / 40)}:${Math.round(e.position!.y / 40)}`)).size
  return area > 4 * placed.length * CELL_W * CELL_H || spots < placed.length / 2
}

/** Moves all placed members of an expanded group by the given offset (dragging the group frame). */
export function groupShiftDrafts(group: Group, entities: Entity[], dx: number, dy: number) {
  const members = new Set(group.member_ids)
  return entities.filter(e => members.has(e.id) && e.position)
    .map(e => ({ type: 'entity.position' as const, payload: { id: e.id, x: Math.round(e.position!.x + dx), y: Math.round(e.position!.y + dy) } }))
}

export type AutoGroup = { name: string; members: string[]; reason: string }

/**
 * Groups for a large graph, by the same characteristics, in three passes over entities of one type:
 * 1. the same operations with the same counterparts in the same roles ("41 Azure Resource · write …/deployments");
 * 2. the same counterparts with different operations;
 * 3. the same operations with the same shared counterparts, each with partners of its own: 90 files the same user
 *    accessed from the same IP, each in its own repository. A counterpart is shared when it takes part in at least
 *    `minSize` activities; rare ones count by their type only, and every link needs one shared counterpart, so
 *    unrelated incidents are never lumped together.
 * Entities already in a group and pinned ones stay as they are, and so does the one that differs; `only` limits it to,
 * for example, what an import just added.
 */
export function autoGroups(entities: Entity[], facts: Fact[], groups: Group[], options: { minSize?: number; only?: Set<string> } = {}): AutoGroup[] {
  const minSize = options.minSize ?? 4
  const grouped = new Set(groups.flatMap(g => g.member_ids))
  const byId = new Map(entities.map(e => [e.id, e]))
  type Link = { id: string; role: string; operation: string; others: { id: string; role: string }[] }
  const links: Link[] = []
  const degree = new Map<string, number>()
  for (const fact of facts) {
    const operation = fact.predicate.trim()
    const ends = fact.participants?.length ? fact.participants.map(p => ({ id: p.entity_id, role: p.role }))
      : [{ id: fact.subject_id, role: 'out' }, { id: fact.object_id, role: 'in' }]
    for (const end of ends) {
      degree.set(end.id, (degree.get(end.id) ?? 0) + 1)
      links.push({ id: end.id, role: end.role, operation, others: ends.filter(o => o.id !== end.id) })
    }
  }
  const shared = (id: string) => (degree.get(id) ?? 0) >= minSize
  const exact = new Map<string, Set<string>>(), loose = new Map<string, Set<string>>(), counterparts = new Map<string, Set<string>>(), operations = new Map<string, Set<string>>()
  const add = (map: Map<string, Set<string>>, id: string, value: string) => { let set = map.get(id); if (!set) map.set(id, set = new Set()); set.add(value) }
  const noLoose = new Set<string>()
  for (const link of links) {
    const head = `${link.role}|${link.operation.toLowerCase()}|`
    add(exact, link.id, head + link.others.map(o => `${o.role}:${o.id}`).sort().join(','))
    add(operations, link.id, link.operation)
    for (const o of link.others) add(counterparts, link.id, o.id)
    if (!link.others.some(o => shared(o.id))) noLoose.add(link.id)
    add(loose, link.id, head + link.others.map(o => `${o.role}:${shared(o.id) ? o.id : `~${byId.get(o.id)?.kind ?? '?'}`}`).sort().join(','))
  }
  const candidates = entities.filter(e => !grouped.has(e.id) && !e.pinned && exact.has(e.id) && (!options.only || options.only.has(e.id)))
  const result: AutoGroup[] = []
  const taken = new Set<string>()
  const bucket = (key: (e: Entity) => string | null) => {
    const buckets = new Map<string, Entity[]>()
    for (const e of candidates) {
      if (taken.has(e.id)) continue
      const k = key(e)
      if (k === null) continue
      const list = buckets.get(k); if (list) list.push(e); else buckets.set(k, [e])
    }
    return [...buckets.values()].filter(list => list.length >= minSize).sort((a, b) => b.length - a.length)
  }
  const names = (ids: Iterable<string>) => { const list = [...ids].map(id => byId.get(id)?.name ?? '?'); return list.slice(0, 2).join(', ') + (list.length > 2 ? ` +${list.length - 2}` : '') }
  const take = (members: Entity[], name: (ops: Set<string>) => string, reason: string) => {
    const ops = new Set(members.flatMap(m => [...(operations.get(m.id) ?? [])]))
    members.forEach(m => taken.add(m.id))
    result.push({ members: members.map(m => m.id), name: `${members.length} ${members[0].kind} · ${name(ops)}`, reason })
  }
  const one = (ops: Set<string>) => ops.size === 1 ? [...ops][0] : `${ops.size} operations`
  for (const members of bucket(e => `${e.kind}\u0000${[...exact.get(e.id)!].sort().join('\u0001')}`))
    take(members, one, `Same operation and counterparts: ${names(counterparts.get(members[0].id) ?? [])}`)
  for (const members of bucket(e => `${e.kind}\u0000${[...(counterparts.get(e.id) ?? [])].sort().join(',')}`))
    take(members, ops => `${ops.size} operations`, `Same counterparts (${names(counterparts.get(members[0].id) ?? [])}), different operations`)
  for (const members of bucket(e => noLoose.has(e.id) ? null : `${e.kind}\u0000${[...loose.get(e.id)!].sort().join('\u0001')}`)) {
    const peers = [...(counterparts.get(members[0].id) ?? [])]
    const own = [...new Set(peers.filter(id => !shared(id)).map(id => byId.get(id)?.kind ?? '?'))]
    take(members, one, `Same operation with ${names(peers.filter(shared))}; each with its own ${own.join(', ')}`)
  }
  return result
}

/** Drafts that create the groups collapsed, each at the centre of its members, as one batch (one undo step). */
export function autoGroupDrafts(found: AutoGroup[], entities: Entity[], newId: () => string) {
  const byId = new Map(entities.map(e => [e.id, e]))
  return found.map(group => {
    const center = centroid(group.members.map(id => byId.get(id)?.position ?? { x: 0, y: 0 }))
    return { type: 'group.add' as const, payload: { id: newId(), name: group.name, members: group.members, rule: null, excluded: [], collapsed: true,
      x: Math.round(center.x / 20) * 20, y: Math.round(center.y / 20) * 20 } }
  })
}
