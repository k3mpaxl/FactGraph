const assert = require('node:assert/strict')
const path = require('node:path').resolve(process.argv[2])
const { organicLayout, layoutQuality } = require(path + '/organicLayout.js')

// Realistic large investigation: 150 users → 400 devices → 250 IPs → 60 files, plus one hub with 250 leaf files.
const nodes = [], edges = []
const add = (id, width = 200) => nodes.push({ id, width, height: 48, x: 0, y: 0 })
for (let i = 0; i < 150; i++) add(`u${i}`)
for (let i = 0; i < 400; i++) add(`d${i}`)
for (let i = 0; i < 250; i++) add(`ip${i}`)
for (let i = 0; i < 60; i++) add(`f${i}`)
add('hub'); for (let i = 0; i < 250; i++) { add(`leaf${i}`); edges.push({ source: 'hub', target: `leaf${i}` }) }
for (let i = 0; i < 600; i++) edges.push({ source: `u${i % 150}`, target: `d${(i * 7) % 400}` })
for (let i = 0; i < 700; i++) edges.push({ source: `d${i % 400}`, target: `ip${(i * 3) % 250}` })
for (let i = 0; i < 500; i++) edges.push({ source: `ip${i % 250}`, target: `f${i % 60}` })
nodes[0].pinned = true; nodes[0].x = 5000; nodes[0].y = 5000
const started = Date.now()
const positions = organicLayout(nodes, edges)
const ms = Date.now() - started
const quality = layoutQuality(nodes, positions)
console.log(`organic layout: ${nodes.length} nodes, ${edges.length} edges in ${ms} ms, ${Math.round(quality.width)}×${Math.round(quality.height)}, aspect ${quality.aspect.toFixed(2)}, ${quality.overlaps} overlaps`)
assert.ok(ms < 8000, 'fast enough for the browser')
assert.ok(quality.aspect > 0.4 && quality.aspect < 3, 'compact, screen-like shape instead of one long column')
assert.ok(quality.overlaps < nodes.length * 0.02, 'cards hardly overlap')
assert.deepEqual(positions.get('u0'), { x: 5000, y: 5000 }, 'pinned node keeps its position')
// Deterministic: the same input gives the same layout, so collaborators see the same result.
assert.deepEqual([...organicLayout(nodes, edges).entries()].slice(0, 20), [...positions.entries()].slice(0, 20))
// Hub leaves stay near their hub.
const hub = positions.get('hub'), leaf = positions.get('leaf0'), user = positions.get('u1')
assert.ok(Math.hypot(leaf.x - hub.x, leaf.y - hub.y) < Math.hypot(user.x - hub.x, user.y - hub.y) + 3000)
console.log('Organic layout: speed, compact shape, overlaps, pinned nodes and determinism passed')

// Placement of new entities: same cells as the old all-pairs search, never overlapping, linear for bulk imports.
{
  const { placeNew, initialPosition } = require(path + '/layout.js')
  const naive = (drafts, existing) => {
    const occupied = [...existing]; let index = 0
    return drafts.map(d => {
      if (d.type !== 'entity.add' || d.payload.x != null || d.payload.y != null) return d
      let p; do { p = initialPosition(index++); p = { x: p.x * 1.5, y: p.y } } while (occupied.some(o => Math.abs(o.x - p.x) < 270 && Math.abs(o.y - p.y) < 110))
      occupied.push(p); return { ...d, payload: { ...d.payload, ...p } }
    })
  }
  const existing = [{ x: 0, y: 0 }, { x: 450, y: 0 }, { x: 37, y: 160 }, { x: -460, y: -150 }]
  const drafts = [...Array(60).keys()].map(i => i % 7 === 0 ? { type: 'fact.add', payload: { id: `f${i}` } } : i % 11 === 0 ? { type: 'entity.add', payload: { id: `p${i}`, x: 5, y: 5 } } : { type: 'entity.add', payload: { id: `e${i}` } })
  assert.deepEqual(placeNew(drafts, existing), naive(drafts, existing), 'same positions as before')
  const placed = placeNew(drafts, existing).filter(d => d.type === 'entity.add' && d.payload.id.startsWith('e')).map(d => d.payload)
  const all = [...existing, ...placed]
  for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++)
    if (i >= existing.length || j >= existing.length) assert.ok(Math.abs(all[i].x - all[j].x) >= 270 || Math.abs(all[i].y - all[j].y) >= 110, `overlap ${i}/${j}`)
  // Bulk: 3,000 new entities next to 3,000 existing ones.
  const many = [...Array(3000).keys()].map(i => ({ x: (i % 60) * 405, y: Math.floor(i / 60) * 160 }))
  const started = Date.now()
  placeNew([...Array(3000).keys()].map(i => ({ type: 'entity.add', payload: { id: `b${i}` } })), many)
  assert.ok(Date.now() - started < 1500, `bulk placement took ${Date.now() - started} ms`)
  console.log('placement ok')
}
