export const GRAPH_GRID = 20

// A square spiral assigns each entity a stable cell from its action order.
// Existing cells do not move when more entities are added.
export function initialPosition(index: number): { x: number; y: number } {
  if (index === 0) return { x: 0, y: 0 }
  const ring = Math.ceil((Math.sqrt(index + 1) - 1) / 2)
  const side = ring * 2
  const fromEnd = (side + 1) ** 2 - 1 - index
  let x: number
  let y: number
  if (fromEnd < side) { x = ring - fromEnd; y = -ring }
  else if (fromEnd < side * 2) { x = -ring; y = -ring + fromEnd - side }
  else if (fromEnd < side * 3) { x = -ring + fromEnd - side * 2; y = ring }
  else { x = ring; y = ring - (fromEnd - side * 3) }
  return { x: x * 300, y: y * 160 }
}

export function snapPosition(position: { x: number; y: number }) {
  return {
    x: Math.round(position.x / GRAPH_GRID) * GRAPH_GRID,
    y: Math.round(position.y / GRAPH_GRID) * GRAPH_GRID,
  }
}

// Free spiral cells keep new entities this far apart (card width/height plus a gap).
const MIN_DX = 270
const MIN_DY = 110

/**
 * Positions for entity drafts without coordinates: the next free cells of the spiral, never closer than MIN_DX/MIN_DY
 * to an existing or newly placed entity. A grid index keeps bulk imports linear instead of comparing every new entity
 * with every existing one.
 */
export function placeNew<T extends { type: string; payload: Record<string, unknown> }>(drafts: T[], existing: { x: number; y: number }[]): T[] {
  const grid = new Map<string, { x: number; y: number }[]>()
  const cell = (p: { x: number; y: number }) => [Math.floor(p.x / MIN_DX), Math.floor(p.y / MIN_DY)]
  const add = (p: { x: number; y: number }) => { const [cx, cy] = cell(p); const key = `${cx},${cy}`; const list = grid.get(key); if (list) list.push(p); else grid.set(key, [p]) }
  const taken = (p: { x: number; y: number }) => {
    const [cx, cy] = cell(p)
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++)
      if (grid.get(`${cx + dx},${cy + dy}`)?.some(o => Math.abs(o.x - p.x) < MIN_DX && Math.abs(o.y - p.y) < MIN_DY)) return true
    return false
  }
  existing.forEach(add)
  let index = 0
  return drafts.map(draft => {
    if (draft.type !== 'entity.add' || draft.payload.x != null || draft.payload.y != null) return draft
    let point: { x: number; y: number }
    do { point = initialPosition(index++); point = { x: point.x * 1.5, y: point.y } } while (taken(point))
    add(point)
    return { ...draft, payload: { ...draft.payload, ...point } }
  })
}
