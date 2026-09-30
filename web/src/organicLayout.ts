import { forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY, type SimulationLinkDatum, type SimulationNodeDatum } from 'd3-force'

export type LayoutNode = { id: string; width: number; height: number; x: number; y: number; pinned?: boolean }
export type LayoutEdge = { source: string; target: string }
type SimNode = SimulationNodeDatum & { id: string; width: number; height: number; degree: number }

/** Graphs above this size get the organic layout by default; flow layouts turn into unreadable columns there. */
export const ORGANIC_THRESHOLD = 150

/**
 * Force-directed layout for large, densely connected graphs: connected entities cluster, hubs sit among their
 * neighbours and cards never overlap horizontally. Deterministic (d3-force uses a seeded random source) and fast
 * enough for thousands of nodes (Barnes–Hut). Returns top-left positions; pinned nodes keep theirs.
 */
export function organicLayout(nodes: LayoutNode[], edges: LayoutEdge[], ticks = 320) {
  const ids = new Set(nodes.map(n => n.id))
  const valid = edges.filter(e => e.source !== e.target && ids.has(e.source) && ids.has(e.target))
  const degree = new Map<string, number>()
  for (const edge of valid) { degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1); degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1) }
  const sim: SimNode[] = nodes.map(node => ({
    id: node.id, width: node.width, height: node.height, degree: degree.get(node.id) ?? 0,
    // Unpinned nodes start from d3's phyllotaxis arrangement so the result does not inherit a poor previous layout.
    ...(node.pinned ? { x: node.x + node.width / 2, y: node.y + node.height / 2, fx: node.x + node.width / 2, fy: node.y + node.height / 2 } : {}),
  }))
  const links: SimulationLinkDatum<SimNode>[] = valid.map(edge => ({ source: edge.source, target: edge.target }))
  const simulation = forceSimulation(sim)
    .force('link', forceLink<SimNode, SimulationLinkDatum<SimNode>>(links).id(node => node.id)
      .distance(link => { const s = link.source as SimNode, t = link.target as SimNode; return 150 + 10 * Math.sqrt(Math.min(s.degree, t.degree)) }))
    .force('charge', forceManyBody<SimNode>().strength(node => -260 - 60 * Math.sqrt(node.degree)).distanceMax(2600).theta(0.9))
    .force('collide', forceCollide<SimNode>(node => node.width / 2 + 14).strength(0.9).iterations(2))
    // A weak pull to the centre keeps disconnected components close instead of drifting apart.
    .force('x', forceX<SimNode>(0).strength(0.035))
    .force('y', forceY<SimNode>(0).strength(0.06))
    .stop()
  simulation.tick(ticks)
  return new Map(sim.map(node => [node.id, { x: (node.x ?? 0) - node.width / 2, y: (node.y ?? 0) - node.height / 2 }]))
}

/** Bounding box aspect ratio and overlap count, used to judge layout quality in tests. */
export function layoutQuality(nodes: LayoutNode[], positions: Map<string, { x: number; y: number }>) {
  const boxes = nodes.map(n => ({ ...positions.get(n.id)!, w: n.width, h: n.height }))
  let overlaps = 0
  const sorted = [...boxes].sort((a, b) => a.x - b.x)
  for (let i = 0; i < sorted.length; i++) for (let j = i + 1; j < sorted.length && sorted[j].x < sorted[i].x + sorted[i].w; j++) {
    const a = sorted[i], b = sorted[j]
    if (a.y < b.y + b.h && b.y < a.y + a.h) overlaps++
  }
  const minX = Math.min(...boxes.map(b => b.x)), maxX = Math.max(...boxes.map(b => b.x + b.w))
  const minY = Math.min(...boxes.map(b => b.y)), maxY = Math.max(...boxes.map(b => b.y + b.h))
  return { width: maxX - minX, height: maxY - minY, aspect: (maxX - minX) / Math.max(1, maxY - minY), overlaps }
}
