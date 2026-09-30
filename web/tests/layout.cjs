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
