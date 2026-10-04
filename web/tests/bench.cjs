// Performance check on a synthetic large board. Run via `npm run bench`; fails when a step exceeds its budget by far.
const path = require('node:path').resolve(process.argv[2])
const { project } = require(path + '/board.js')
const { validateDrafts } = require(path + '/validation.js')
const { buildViewModel, groupSuggestions } = require(path + '/viewModel.js')
const { factsInWindow, timelineSteps } = require(path + '/timeline.js')
const { placeNew } = require(path + '/layout.js')

const N = Number(process.env.BENCH_ENTITIES ?? 2000), F = Number(process.env.BENCH_FACTS ?? 5000)
let clock = 0
const act = (type, payload) => ({ id: `a-${++clock}`, clock, at: '2026-09-29T00:00:00Z', actor: 'a', author: 'a', boardId: 'b', type, payload })
const ops = [act('source.add', { id: 's1', title: 'Report', kind: 'Report' })]
const kinds = ['IP', 'Domain', 'User', 'Host', 'Service Principal']
for (let i = 0; i < N; i++) ops.push(act('entity.add', { id: `e${i}`, name: `entity ${i}`, kind: kinds[i % 5], x: (i % 50) * 405, y: Math.floor(i / 50) * 160 }))
for (let i = 0; i < F; i++) {
  const day = String(1 + (i % 28)).padStart(2, '0')
  ops.push(act('fact.add', { id: `f${i}`, subject_id: `e${(i * 7) % N}`, predicate: ['connects to', 'logged in', 'owns'][i % 3], object_id: `e${(i * 13 + 1) % N}`, valid_from: `2026-09-${day}T00:00:00Z` }))
  ops.push(act('assertion.add', { id: `as${i}`, fact_id: `f${i}`, stance: i % 9 ? 'supports' : 'refutes', confidence: 0.8, source_id: 's1', note: 'x' }))
}

// Budgets in ms: about 10× what a laptop needs, so only real regressions (e.g. accidental O(n²)) fail.
const steps = [
  ['project', 200, () => project('b', ops)],
  ['buildViewModel', 120, data => buildViewModel(data.entities, data.facts, data.groups, { visibleLayers: null, collapseActivities: false, showLanes: false, entityTypes: [] })],
  ['groupSuggestions', 120, data => groupSuggestions(data.entities, data.facts, data.groups)],
  ['timeline window', 60, data => { timelineSteps(data.facts); return factsInWindow(data.facts, '2026-09-05T00:00:00Z', '2026-09-12T00:00:00Z', true) }],
  ['validateDrafts', 40, data => validateDrafts(data, [{ type: 'fact.add', payload: { id: 'fx', subject_id: 'e1', predicate: 'p', object_id: 'e2' } }])],
  ['placeNew (1,000 new)', 60, data => placeNew([...Array(1000).keys()].map(i => ({ type: 'entity.add', payload: { id: `n${i}` } })), data.entities.map(e => e.position))],
]
let data = null, failed = 0
console.log(`${ops.length} actions, ${N} entities, ${F} facts`)
for (const [label, budget, fn] of steps) {
  const runs = 3
  const started = performance.now()
  let result
  for (let i = 0; i < runs; i++) result = fn(data)
  const ms = (performance.now() - started) / runs
  if (label === 'project') data = result.data
  const over = ms > budget
  failed += over ? 1 : 0
  console.log(`${label.padEnd(24)} ${ms.toFixed(1).padStart(7)} ms   budget ${budget} ms${over ? '   OVER BUDGET' : ''}`)
}
// Board load: the clock of the newest action must not use Math.max(...list) (stack overflow from ~120k actions).
const big = Array.from({ length: 200000 }, (_, i) => ({ clock: i }))
console.log(`max clock of 200k actions: ${big.reduce((max, item) => Math.max(max, item.clock), 0)}`)
process.exit(failed ? 1 : 0)
