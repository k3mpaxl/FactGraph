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
