const assert = require('node:assert/strict')
const path = require('node:path').resolve(process.argv[2])
const { project, sortActions } = require(path + '/board.js')
const { validateDrafts } = require(path + '/validation.js')
const { buildViewModel, groupSuggestions, groupToggleDrafts, groupShiftDrafts } = require(path + '/viewModel.js')
const { layerOf } = require(path + '/layers.js')

let clock = 0
const act = (type, payload, actor = 'a1', extra = {}) => ({ id: `${actor}-${++clock}`, clock, at: '2026-09-29T00:00:00Z', actor, author: actor, boardId: 'b', type, payload, ...extra })
const view = (data, options = {}) => buildViewModel(data.entities, data.facts, data.groups, { visibleLayers: null, collapseActivities: false, showLanes: false, entityTypes: [], ...options })

// Activities: one event, several role-tagged participants, evidence on the whole event.
{
  clock = 0
  const ops = [
    act('entity.add', { id: 'atk', name: 'Attacker', kind: 'Threat Actor' }),
    act('entity.add', { id: 'ip', name: '1.2.3.4', kind: 'IP' }),
    act('entity.add', { id: 'sp', name: 'sp-b', kind: 'Service Principal' }),
    act('entity.add', { id: 'kv', name: 'kv-c', kind: 'Key Vault' }),
    act('fact.add', { id: 'ev', predicate: 'listed secrets', participants: [{ entity_id: 'atk', role: 'actor' }, { entity_id: 'ip', role: 'source' }, { entity_id: 'sp', role: 'identity' }, { entity_id: 'kv', role: 'target' }] }),
    act('assertion.add', { id: 'e1', fact_id: 'ev', stance: 'supports', note: 'row 1' }),
    act('fact.add', { id: 'plain', subject_id: 'atk', predicate: 'listed secrets', object_id: 'kv' }),
  ]
  const data = project('b', ops).data
  const ev = data.facts.find(f => f.id === 'ev')
  assert.equal(ev.subject_id, 'atk'); assert.equal(ev.object_id, 'kv')
  assert.equal(ev.participants.length, 4); assert.equal(ev.assertions.length, 1)
  assert.ok(data.facts.find(f => f.id === 'plain'), 'plain relation with same ends is not swallowed by the activity')
  assert.deepEqual(['atk', 'ip', 'sp', 'kv'].map(id => layerOf(data.entities.find(e => e.id === id))), ['identity', 'network', 'identity', 'cloud'])
  const v = view(data)
  assert.equal(v.nodes.filter(n => n.kind === 'activity').length, 1)
  assert.equal(v.edges.filter(e => e.activityId === 'ev').length, 4)
  assert.equal(v.edges.find(e => e.role === 'target').source, 'act:ev', 'target spoke points away from the event')
  assert.equal(view(data, { collapseActivities: true }).nodes.filter(n => n.kind === 'activity').length, 0)
  // Layer filter hides the network layer and counts the hidden participant on a visible node.
  const filtered = view(data, { visibleLayers: new Set(['identity', 'cloud', 'other']) })
  assert.ok(!filtered.nodes.some(n => n.id === 'ip'))
  assert.equal(filtered.edges.filter(e => e.activityId === 'ev').length, 3)
  // Deleting a non-end participant keeps the activity; validation rejects single-participant activities.
  const after = project('b', [...ops, act('entity.delete', { id: 'ip' })]).data.facts.find(f => f.id === 'ev')
  assert.equal(after.participants.length, 3)
  assert.throws(() => validateDrafts(data, [{ type: 'fact.add', payload: { id: 'x', predicate: 'p', participants: [{ entity_id: 'kv', role: 'target' }] } }]), /two different participants/)
  assert.throws(() => validateDrafts(data, [{ type: 'fact.add', payload: { id: 'x', predicate: 'p', participants: [{ entity_id: 'kv', role: 'target' }, { entity_id: 'nope', role: 'actor' }] } }]), /does not exist/)
  validateDrafts(data, [{ type: 'fact.add', payload: { id: 'x', predicate: 'p', participants: [{ entity_id: 'kv', role: 'target' }, { entity_id: 'sp', role: 'identity' }] } }])
}

// 700 repositories: 699 behave the same, one differs → rule group with exclusion, bundled edge ×699.
{
  clock = 0
  const ops = [act('entity.add', { id: 'sp', name: 'sp-ci', kind: 'Service Principal' }), act('entity.add', { id: 'atk', name: 'Attacker', kind: 'Threat Actor' })]
  for (let i = 0; i < 700; i++) { ops.push(act('entity.add', { id: `r${i}`, name: `org/repo-${i}`, kind: 'Repository' })); ops.push(act('fact.add', { id: `f${i}`, subject_id: 'sp', predicate: 'cloned', object_id: `r${i}` })) }
  ops.push(act('fact.add', { id: 'push', subject_id: 'atk', predicate: 'pushed to', object_id: 'r699' }))
  let data = project('b', ops).data
  const suggestion = groupSuggestions(data.entities, data.facts, data.groups ?? []).find(s => s.members.length === 699)
  assert.ok(suggestion, 'identical connections are suggested as a group')
  assert.deepEqual(suggestion.outliers, ['r699'], 'the one different repository is reported as outlier')
  ops.push(act('group.add', { id: 'g', name: 'Repos', rule: { kinds: ['Repository'] }, excluded: ['r699'], collapsed: true }))
  data = project('b', ops).data
  assert.equal(data.groups[0].member_ids.length, 699)
  let v = view(data)
  assert.ok(v.nodes.some(n => n.id === 'group:g') && v.nodes.some(n => n.id === 'r699') && !v.nodes.some(n => n.id === 'r0'))
  const bundle = v.edges.find(e => e.target === 'group:g')
  assert.equal(bundle.count, 699); assert.equal(bundle.label, 'cloned')
  assert.equal(v.nodes.length, 4, 'sp, attacker, group, separate repo')
  // New matching entity joins automatically; expanding shows members inside a frame.
  ops.push(act('entity.add', { id: 'r700', name: 'org/repo-700', kind: 'Repository' }))
  ops.push(act('group.update', { id: 'g', collapsed: false }))
  data = project('b', ops).data
  assert.equal(data.groups[0].member_ids.length, 700)
  v = view(data)
  assert.ok(v.nodes.some(n => n.kind === 'frame' && n.groupId === 'g'))
  assert.equal(v.nodes.filter(n => n.kind === 'entity').length, 703)
}

// Containers: "collapse contents" folds everything a device contains into the device node.
{
  clock = 0
  const ops = [act('entity.add', { id: 'dev', name: 'WS-1', kind: 'Device' }), act('entity.add', { id: 'proc', name: 'powershell.exe', kind: 'Process' }), act('entity.add', { id: 'file', name: 'C:/x.ps1', kind: 'File' }), act('entity.add', { id: 'ext', name: '8.8.8.8', kind: 'IP' }),
    act('fact.add', { id: 'c1', subject_id: 'dev', predicate: 'runs', object_id: 'proc' }), act('fact.add', { id: 'c2', subject_id: 'proc', predicate: 'contains', object_id: 'file' }), act('fact.add', { id: 'n', subject_id: 'proc', predicate: 'connected to', object_id: 'ext' }),
    act('group.add', { id: 'cg', name: 'WS-1 contents', rule: { container_id: 'dev' }, collapsed: true })]
  const data = project('b', ops).data
  assert.deepEqual(data.groups[0].member_ids.sort(), ['file', 'proc'])
  const v = view(data)
  assert.deepEqual(v.nodes.filter(n => n.kind === 'entity').map(n => n.id).sort(), ['dev', 'ext'])
  assert.equal(v.nodes.find(n => n.id === 'dev').container.count, 2)
  assert.ok(v.edges.some(e => e.source === 'dev' && e.target === 'ext'), 'contained process edge is redirected to the container')
}

// Sync convergence: every browser sorts by (clock, actor, id), so arrival order never changes the result.
{
  clock = 0
  const base = [act('entity.add', { id: 'a', name: 'A', kind: 'User' }, 'x'), act('entity.add', { id: 'b', name: 'B', kind: 'User' }, 'x'), act('entity.add', { id: 'c', name: 'C', kind: 'Key Vault' }, 'x'),
    act('group.add', { id: 'g', name: 'G', members: ['a', 'b'], collapsed: true }, 'x')]
  const t = clock
  // Concurrent: analyst 1 merges A into B; analyst 2 (offline, same logical time) links A to C, renames A, adds A to an activity and takes A out of the group.
  const mergeOp = { ...act('entity.merge', { source_id: 'a', target_id: 'b' }, 'analyst1'), clock: t + 1 }
  const concurrent = [
    { ...act('fact.add', { id: 'rel', subject_id: 'a', predicate: 'reads', object_id: 'c' }, 'analyst2'), clock: t + 1 },
    { ...act('entity.update', { id: 'b', name: 'B (renamed by 2)' }, 'analyst2'), clock: t + 1 },
    { ...act('fact.add', { id: 'act', predicate: 'listed', participants: [{ entity_id: 'a', role: 'identity' }, { entity_id: 'c', role: 'target' }] }, 'analyst2'), clock: t + 2 },
    { ...act('identifier.add', { id: 'i1', entity_id: 'a', scheme: 'email', raw_value: 'a@x.test' }, 'analyst2'), clock: t + 2 },
    { ...act('group.update', { id: 'g', exclude: ['a'] }, 'analyst2'), clock: t + 3 },
  ]
  const renameBy1 = { ...act('entity.update', { id: 'b', name: 'B (renamed by 1)' }, 'analyst1'), clock: t + 1 }
  const all = [...base, mergeOp, renameBy1, ...concurrent]
  const shuffle = list => list.map(v => [Math.sin(v.clock * 97 + v.id.length * 13) , v]).sort((p, q) => p[0] - q[0]).map(p => p[1])
  const results = [all, [...all].reverse(), shuffle(all)].map(order => JSON.stringify(project('b', order).data))
  assert.equal(results[0], results[1]); assert.equal(results[0], results[2])
  const data = project('b', all).data
  assert.ok(!data.entities.some(e => e.id === 'a'))
  assert.equal(data.facts.find(f => f.id === 'rel').subject_id, 'b', 'concurrent relation follows the merge instead of being lost')
  assert.equal(data.facts.find(f => f.id === 'act').participants[0].entity_id, 'b', 'concurrent activity participant follows the merge')
  assert.equal(data.entities.find(e => e.id === 'b').identifiers[0].raw_value, 'a@x.test', 'concurrent identifier follows the merge')
  assert.equal(data.entities.find(e => e.id === 'b').name, 'B (renamed by 2)', 'concurrent rename: deterministic winner by (clock, actor)')
  assert.ok(data.groups[0].excluded.includes('b') && !data.groups[0].member_ids.includes('b'), 'group exclusion of the old ID applies to the merge target')
  // Incremental membership edits from two analysts both survive.
  const g2 = [...base, { ...act('group.update', { id: 'g', add_members: ['c'] }, 'p'), clock: t + 5 }, { ...act('group.update', { id: 'g', exclude: ['a'] }, 'q'), clock: t + 5 }]
  const groupA = project('b', g2).data.groups[0], groupB = project('b', [...g2].reverse()).data.groups[0]
  assert.deepEqual(groupA, groupB)
  assert.deepEqual(groupA.member_ids.sort(), ['b', 'c'])
  assert.deepEqual(sortActions(all).map(a => a.id), sortActions([...all].reverse()).map(a => a.id))
}

// Perspectives and layer overrides.
{
  clock = 0
  const ops = [act('entity.add', { id: 'x', name: 'weird', kind: 'Widget', layer: 'data' }), act('type.add', { id: 't', name: 'Gadget', layer: 'workload' }), act('entity.add', { id: 'y', name: 'g', kind: 'Gadget' }),
    act('view.add', { id: 'v', name: 'Cloud', layers: ['cloud', 'identity'], show_lanes: true })]
  let data = project('b', ops).data
  assert.equal(layerOf(data.entities.find(e => e.id === 'x'), data.entity_types), 'data')
  assert.equal(layerOf(data.entities.find(e => e.id === 'y'), data.entity_types), 'workload')
  assert.deepEqual(data.views[0].layers, ['cloud', 'identity'])
  ops.push(act('entity.update', { id: 'x', layer: null }), act('view.delete', { id: 'v' }))
  data = project('b', ops).data
  assert.equal(layerOf(data.entities.find(e => e.id === 'x'), data.entity_types), 'other')
  assert.equal(data.views.length, 0)
  assert.throws(() => validateDrafts(data, [{ type: 'entity.update', payload: { id: 'x', layer: 'moon' } }]), /Unknown layer/)
  assert.throws(() => validateDrafts(data, [{ type: 'group.add', payload: { id: 'g', name: 'G', members: ['missing'] } }]), /does not exist/)
}
// Groups keep their place: expanding moves members to the card, collapsing puts the card on the members.
{
  const entities = [{ id: 'a', position: { x: 0, y: 0 } }, { id: 'b', position: { x: 100, y: 200 } }, { id: 'c', position: { x: 900, y: 900 } }]
  const group = { id: 'g', member_ids: ['a', 'b'], rule: null, collapsed: true, position: { x: 550, y: 300 } }
  const expand = groupToggleDrafts(group, entities, false)
  assert.deepEqual(expand.map(d => d.payload), [{ id: 'a', x: 500, y: 200 }, { id: 'b', x: 600, y: 400 }, { id: 'g', collapsed: false }])
  assert.deepEqual(groupToggleDrafts({ ...group, position: { x: 50, y: 100 } }, entities, false).map(d => d.type), ['group.update'])
  assert.deepEqual(groupToggleDrafts({ ...group, collapsed: false }, entities, true)[0].payload, { id: 'g', collapsed: true, x: 50, y: 100 })
  assert.deepEqual(groupToggleDrafts({ ...group, rule: { container_id: 'c' } }, entities, false).map(d => d.type), ['group.update'])
  assert.deepEqual(groupShiftDrafts(group, entities, 10, -5).map(d => d.payload), [{ id: 'a', x: 10, y: -5 }, { id: 'b', x: 110, y: 195 }])
}
console.log('Activities, layers, groups with exclusions, containers, suggestions and merge-safe sync convergence passed')
