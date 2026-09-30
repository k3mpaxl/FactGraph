import type { Entity, EntityType, Fact, Group, TruthState } from './types'
import { layerOf } from './layers'

export const NODE_W = 230
export const NODE_H = 56
type Point = { x: number; y: number }

export type ViewOptions = { visibleLayers: Set<string> | null; collapseActivities: boolean; showLanes: boolean; entityTypes: EntityType[] }
export type EntityVNode = { kind: 'entity'; id: string; entity: Entity; position: Point; layer: string; hidden: number; container?: { groupId: string; count: number; collapsed: boolean }; inGroup?: string }
export type GroupVNode = { kind: 'group'; id: string; group: Group; position: Point; count: number; kinds: [string, number][]; states: Record<TruthState, number>; internal: number; layer: string }
export type ActivityVNode = { kind: 'activity'; id: string; fact: Fact; position: Point }
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
      const hub = activityNodeId(fact.id)
      let position = fact.position
      if (!position) {
        const c = centroid(visible.map(v => positions.get(v.rep) ?? { x: 0, y: 0 }))
        const key = `${Math.round(c.x)}:${Math.round(c.y)}`
        const slot = hubSlots.get(key) ?? 0; hubSlots.set(key, slot + 1)
        position = { x: c.x + NODE_W / 2 - 14, y: c.y + NODE_H / 2 - 14 + (slot ? (slot % 2 ? 1 : -1) * Math.ceil(slot / 2) * 44 : 0) + (visible.length < 2 ? 90 : 0) }
      }
      nodes.push({ kind: 'activity', id: hub, fact, position })
      const seen = new Set<string>()
      for (const { role, rep } of visible) {
        const key = `${role}|${rep}`
        if (seen.has(key)) continue
        seen.add(key)
        const outgoing = role === 'target'
        edges.set(`${fact.id}:${key}`, { id: `${fact.id}:${key}`, source: outgoing ? hub : rep, target: outgoing ? rep : hub, label: role, role, state: fact.truth_state, count: 1, factIds: [fact.id], activityId: fact.id, states: [], plain: false })
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
    state: edge.activityId ? edge.state : combineStates(states),
  }))

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
