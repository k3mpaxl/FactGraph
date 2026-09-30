const assert = require('node:assert/strict')
const path = require('node:path').resolve(process.argv[2])
const { project } = require(path + '/board.js')
const { buildViewModel } = require(path + '/viewModel.js')
const { buildGraphSvg, safeScale, escapeXml, mix } = require(path + '/exportGraph.js')

let clock = 0
const act = (type, payload) => ({ id: `a${++clock}`, clock, at: '2026-09-29T00:00:00Z', actor: 'x', author: 'x', boardId: 'b', type, payload })
const ops = [
  act('entity.add', { id: 'atk', name: 'APT <script>alert(1)</script> & "co"', kind: 'Threat Actor', x: 0, y: 0 }),
  act('entity.add', { id: 'ip', name: '203.0.113.7', kind: 'IP', x: 0, y: 200 }),
  act('entity.add', { id: 'kv', name: 'kv-prod', kind: 'Key Vault', x: 500, y: 100 }),
  act('entity.add', { id: 'far', name: 'far away', kind: 'Device', x: 5000, y: 5000 }),
  act('fact.add', { id: 'ctl', subject_id: 'atk', predicate: 'controls', object_id: 'ip' }),
  act('fact.add', { id: 'ev', predicate: 'listed secrets', participants: [{ entity_id: 'atk', role: 'actor' }, { entity_id: 'ip', role: 'source' }, { entity_id: 'kv', role: 'target' }], technique: 'T1555' }),
  act('assertion.add', { id: 'e', fact_id: 'ev', stance: 'supports', note: 'x', valid_from: '2026-09-28T10:42:00Z' }),
]
for (let i = 0; i < 30; i++) { ops.push(act('entity.add', { id: `r${i}`, name: `repo-${i}`, kind: 'Repository', x: 900, y: i * 60 })); ops.push(act('fact.add', { id: `f${i}`, subject_id: 'ip', predicate: 'cloned', object_id: `r${i}` })) }
ops.push(act('group.add', { id: 'g', name: 'Repos & forks', rule: { kinds: ['Repository'] }, collapsed: true }))
const data = project('b', ops).data
const view = buildViewModel(data.entities, data.facts, data.groups, { visibleLayers: null, collapseActivities: false, showLanes: true, entityTypes: [] })
const base = { nodes: view.nodes, edges: view.edges, entityTypes: [], theme: 'light' }

const full = buildGraphSvg({ ...base, title: 'Board <1>', subtitle: 'Layers: all', legend: true })
assert.ok(full.svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"'))
assert.ok(!full.svg.includes('<script>'), 'entity names are escaped')
assert.ok(full.svg.includes('APT &lt;script&gt;'))
assert.ok(full.svg.includes('Repos &amp; forks'), 'group label is escaped')
assert.ok(!/&(?!amp;|lt;|gt;|quot;|apos;|#)/.test(full.svg), 'no raw ampersands')
assert.ok(full.svg.includes('×30'), 'bundled edge count')
assert.ok(full.svg.includes('LISTED') === false && full.svg.includes('listed secrets') && full.svg.includes('T1555'), 'activity label with technique')
assert.ok(full.svg.includes('ACTOR') && full.svg.includes('TARGET'), 'role labels on spokes')
assert.ok(full.svg.includes('Supported 0') && full.svg.includes('Unknown 31'), 'legend counts bundled relationships')
assert.ok(full.svg.includes('IDENTITY &amp; ACCESS'), 'layer lanes')
assert.equal((full.svg.match(/<svg/g) || []).length, 1, 'no icons without a renderer, letters instead')
assert.equal(full.nodeCount, 6)
assert.ok(full.width > 5000 && full.height > 5000, 'whole graph includes the far node')
// Area and selection restrict the content; edges to cut-off nodes disappear.
const visible = buildGraphSvg({ ...base, area: { x: -50, y: -50, width: 700, height: 400 } })
assert.ok(!visible.svg.includes('far away') && visible.svg.includes('kv-prod') && visible.width < 1200)
const selected = buildGraphSvg({ ...base, only: new Set(['atk', 'ip']) })
assert.equal(selected.nodeCount, 2)
assert.ok(selected.svg.includes('controls') && !selected.svg.includes('listed secrets'))
// Dark theme, transparency and icons.
const dark = buildGraphSvg({ ...base, theme: 'dark', transparent: true, icon: (kind, icon, color) => `<path d="M0 0" stroke="${color}"/>` })
assert.ok(!dark.svg.includes('width="100%" height="100%"'), 'transparent background has no canvas rect')
assert.ok(dark.svg.includes('<path d="M0 0" stroke="#'), 'icons are embedded with a fixed colour')
assert.ok(dark.svg.includes('#e7e9ee'))
// Limits and helpers.
assert.equal(safeScale(1000, 1000, 2), 2)
assert.ok(safeScale(20000, 3000, 2) <= 16000 / 20000 + 1e-9)
assert.ok(safeScale(9000, 9000, 3) * 9000 * safeScale(9000, 9000, 3) * 9000 <= 100_000_000 + 1)
assert.equal(escapeXml(`<a href="x">&'</a>`), '&lt;a href=&quot;x&quot;&gt;&amp;&apos;&lt;/a&gt;')
assert.equal(mix('#ff0000', '#0000ff', 0.5), '#800080')
const empty = buildGraphSvg({ ...base, only: new Set(['nope']) })
assert.equal(empty.nodeCount, 0)
console.log('SVG export: escaping, bundled groups, activities, lanes, legend, area/selection, themes and PNG size limits passed')
