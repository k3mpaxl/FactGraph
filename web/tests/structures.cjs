const assert = require('node:assert/strict')
const path = require('node:path').resolve(process.argv[2])
const { project, sortActions } = require(path + '/board.js')
const { validateDrafts } = require(path + '/validation.js')
const { buildViewModel, groupSuggestions, groupToggleDrafts, groupShiftDrafts, autoGroups, autoGroupDrafts } = require(path + '/viewModel.js')
const { layerOf } = require(path + '/layers.js')

let clock = 0
const act = (type, payload, actor = 'a1', extra = {}) => ({ id: `${actor}-${++clock}`, clock, at: '2026-09-29T00:00:00.000Z', actor, author: actor, boardId: 'b', type, payload, ...extra })
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
// Expanding a group whose members are scattered (collected by "Group all similar" from all over the board) lays them
// out as a grid at the card, growing away from the rest of the graph; activities piled on one spot are released.
{
  const scattered = ['m-3', 'm-10', 'm-1', 'm-2', 'm-20', 'm-4'].map((name, i) => ({ id: `s${i}`, name, position: { x: i * 1500, y: (i % 2) * 2400 } }))
  const visible = [{ id: 'hub', name: 'hub', position: { x: 0, y: 300 } }, { id: 'ip', name: 'ip', position: { x: 600, y: 300 } }]
  const hidden = [{ id: 'h', name: 'far away, hidden in a collapsed group', position: { x: 90000, y: 0 } }]
  const group = { id: 'g', member_ids: scattered.map(e => e.id), rule: null, collapsed: true, position: { x: 1200, y: 300 } }
  const other = { id: 'o', member_ids: ['h'], rule: null, collapsed: true, position: { x: 900, y: 600 } }
  const fact = (id, target, position) => ({ id, predicate: 'read', subject_id: 'hub', object_id: target, participants: [{ entity_id: 'hub', role: 'actor' }, { entity_id: target, role: 'target' }], position })
  const facts = [fact('f0', 's0', { x: 800, y: 320 }), fact('f1', 's1', { x: 800, y: 320 }), fact('f2', 's2', { x: 800, y: 320 }), fact('f3', 's3', { x: 640, y: 900 }), fact('f4', 'ip', { x: 800, y: 320 })]
  const drafts = groupToggleDrafts(group, [...scattered, ...visible, ...hidden], false, { groups: [group, other], facts })
  const moved = new Map(drafts.filter(d => d.type === 'entity.position').map(d => [d.payload.id, d.payload]))
  const byName = id => scattered.find(e => e.id === id).name
  const order = [...moved.keys()].sort((a, b) => moved.get(a).y - moved.get(b).y || moved.get(a).x - moved.get(b).x).map(byName)
  assert.deepEqual(order, ['m-1', 'm-2', 'm-3', 'm-4', 'm-10', 'm-20'], 'sorted by name, row by row')
  assert.equal(Math.min(...[...moved.values()].map(p => p.x)), 1200 + 260, 'the card is in the right half: the grid starts one column further right, cards above and below it stay visible')
  const ys = [...moved.values()].map(p => p.y); assert.ok(Math.min(...ys) < 300 + 28 && Math.max(...ys) > 300, 'vertically around the card')
  assert.deepEqual(drafts.filter(d => d.type === 'fact.position').map(d => d.payload), [{ id: 'f0', x: null, y: null }, { id: 'f1', x: null, y: null }, { id: 'f2', x: null, y: null }],
    'activities of members piled on one spot go back to automatic placement; one with its own place and others are kept')
  assert.equal(drafts.at(-1).type, 'group.update')
  // Members someone arranged next to each other keep their arrangement, only moved to the card.
  const tidy = scattered.map((e, i) => ({ ...e, position: { x: (i % 3) * 260, y: Math.floor(i / 3) * 80 } }))
  const kept = groupToggleDrafts(group, [...tidy, ...visible], false, { groups: [group], facts: [] }).filter(d => d.type === 'entity.position')
  assert.deepEqual(kept.map(d => [d.payload.x - tidy.find(e => e.id === d.payload.id).position.x, d.payload.y - tidy.find(e => e.id === d.payload.id).position.y]), Array(6).fill([1200 - 260, 300 - 40]))
  // Released activities are placed between their participants again.
  clock = 0
  const ops = [act('entity.add', { id: 'a', name: 'A', kind: 'User', x: 0, y: 0 }), act('entity.add', { id: 'b', name: 'B', kind: 'File', x: 400, y: 0 }),
    act('fact.add', { id: 'f', predicate: 'read', participants: [{ entity_id: 'a', role: 'actor' }, { entity_id: 'b', role: 'target' }] }), act('fact.position', { id: 'f', x: 5000, y: 5000 })]
  const placedAt = list => view(project('b', list).data).nodes.find(n => n.kind === 'activity').position
  assert.deepEqual(placedAt(ops), { x: 5000, y: 5000 })
  validateDrafts(project('b', ops).data, [{ type: 'fact.position', payload: { id: 'f', x: null, y: null } }])
  assert.ok(placedAt([...ops, act('fact.position', { id: 'f', x: null, y: null })]).x < 400, 'between A and B')
}
console.log('Activities, layers, groups with exclusions, containers, suggestions and merge-safe sync convergence passed')

// Large graphs: entities with the same characteristics are collapsed into groups, and activities with the same operation
// between the same (collapsed) nodes are drawn as one, so a hub-and-spoke import becomes readable.
{
  clock = 0
  const ops = [act('entity.add', { id: 'sp', name: '0b7f0c1e-1111-4222-8333-444444444444', kind: 'Service Principal' }), act('entity.add', { id: 'ip', name: '203.0.113.7', kind: 'IP' })]
  const event = (id, predicate, target) => ops.push(act('fact.add', { id, predicate, participants: [{ entity_id: 'sp', role: 'actor' }, { entity_id: 'ip', role: 'source' }, { entity_id: target, role: 'target' }] }))
  const resource = (id, kind = 'Azure Resource', extra = {}) => ops.push(act('entity.add', { id, name: id, kind, x: 100 * ops.length, y: 40, ...extra }))
  for (let i = 0; i < 6; i++) { resource(`w${i}`); event(`fw${i}`, 'write deployments', `w${i}`) }
  for (let i = 0; i < 4; i++) { resource(`d${i}`); event(`fd${i}`, 'delete', `d${i}`) }
  // Same counterparts, different operations: grouped in the second pass.
  for (let i = 0; i < 4; i++) { resource(`k${i}`, 'AKS Cluster'); event(`fk${i}`, i < 2 ? 'read' : 'list credentials', `k${i}`) }
  // The one that differs stays visible; pinned and already grouped entities are left alone.
  resource('odd'); event('fo1', 'write deployments', 'odd'); event('fo2', 'delete', 'odd')
  resource('pin', 'Azure Resource', { pinned: true }); event('fp', 'delete', 'pin')
  resource('kept'); event('fkept', 'delete', 'kept'); ops.push(act('group.add', { id: 'old', name: 'Kept', members: ['kept'], rule: null, excluded: [], collapsed: false }))
  const data = project('b', ops).data
  const before = view(data)
  assert.equal(before.nodes.filter(n => n.kind === 'activity').length, 18, 'one activity node per event while nothing is grouped')

  const found = autoGroups(data.entities, data.facts, data.groups)
  assert.deepEqual(found.map(g => g.name), ['Azure Resource · write deployments', 'Azure Resource · delete', 'AKS Cluster · 2 operations'])
  assert.deepEqual(found[1].members, ['d0', 'd1', 'd2', 'd3'])
  assert.match(found[2].reason, /different operations/)
  for (const id of ['odd', 'pin', 'kept', 'sp', 'ip']) assert.ok(!found.some(g => g.members.includes(id)), `${id} stays as it is`)
  assert.deepEqual(autoGroups(data.entities, data.facts, data.groups, { only: new Set(['w0', 'w1', 'w2', 'w3', 'd0']) }).map(g => g.members.length), [4], 'only new entities of an import')
  // Exact buckets below the minimum: the same counterparts are enough, whatever the operations.
  assert.deepEqual(autoGroups(data.entities, data.facts, data.groups, { minSize: 7 }).map(g => [g.name, g.members.includes('odd')]), [['Azure Resource · 2 operations', true]])
  assert.deepEqual(autoGroups(data.entities, data.facts, data.groups, { minSize: 12 }), [])

  let n = 0
  const drafts = autoGroupDrafts(found, data.entities, () => `g${n++}`)
  assert.deepEqual(drafts[1].payload, { id: 'g1', name: 'Azure Resource · delete', members: ['d0', 'd1', 'd2', 'd3'], rule: null, excluded: [], collapsed: true,
    x: Math.round(data.entities.filter(e => found[1].members.includes(e.id)).reduce((s, e) => s + e.position.x, 0) / 4 / 20) * 20, y: 40 })
  validateDrafts(data, drafts)
  const grouped = project('b', [...ops, ...drafts.map(d => act(d.type, d.payload))]).data
  const after = view(grouped)
  const activities = after.nodes.filter(n => n.kind === 'activity')
  const write = activities.find(n => n.fact.predicate === 'write deployments' && n.count > 1)
  assert.equal(write.count, 6); assert.deepEqual(write.facts.map(f => f.id), ['fw0', 'fw1', 'fw2', 'fw3', 'fw4', 'fw5'])
  assert.equal(after.edges.find(e => e.source === write.id && e.role === 'target').target, 'group:g0')
  assert.equal(after.edges.find(e => e.target === write.id && e.source === 'sp').count, 6, 'the spoke counts the bundled events')
  assert.ok(activities.some(n => n.fact.id === 'fo1' && n.count === 1), 'an event with a visible, ungrouped participant stays apart')
  assert.deepEqual(activities.filter(n => n.fact.predicate !== 'write deployments' && n.fact.predicate !== 'delete').map(n => n.count).sort(), [2, 2], 'AKS group: one node per operation')
  assert.ok(after.nodes.length < before.nodes.length / 2, `${before.nodes.length} → ${after.nodes.length} nodes`)
  console.log(`Auto grouping and activity bundling passed (${before.nodes.length} → ${after.nodes.length} nodes)`)
}

// Third pass: the same operation with the same shared counterparts, each with a partner of its own (one user reads one
// file in each of many repositories). Isolated pairs without anything shared are never lumped together.
{
  clock = 0
  const ops = [act('entity.add', { id: 'u', name: 'reader', kind: 'User' }), act('entity.add', { id: 'ip', name: '203.0.113.9', kind: 'IP' })]
  for (let i = 0; i < 5; i++) {
    ops.push(act('entity.add', { id: `r${i}`, name: `group/repo-${i}`, kind: 'Repository' }), act('entity.add', { id: `f${i}`, name: `.env`, kind: 'File' }))
    ops.push(act('fact.add', { id: `a${i}`, predicate: 'repository file accessed', participants: [{ entity_id: 'u', role: 'actor' }, { entity_id: 'ip', role: 'source' }, { entity_id: `r${i}`, role: 'target' }, { entity_id: `f${i}`, role: 'target' }] }))
  }
  for (let i = 0; i < 4; i++) ops.push(act('entity.add', { id: `x${i}`, name: `198.51.100.${i}`, kind: 'IP' }), act('entity.add', { id: `d${i}`, name: `host-${i}`, kind: 'Device' }),
    act('fact.add', { id: `c${i}`, subject_id: `x${i}`, predicate: 'connects to', object_id: `d${i}` }))
  const data = project('b', ops).data
  const found = autoGroups(data.entities, data.facts, data.groups)
  assert.deepEqual(found.map(g => [g.name, g.members.length]), [['File · repository file accessed', 5], ['Repository · repository file accessed', 5]])
  assert.match(found[0].reason, /^Same operation with reader, 203\.0\.113\.9; each with its own Repository$/)
  assert.ok(!found.some(g => g.members.includes('x0') || g.members.includes('d0')), 'nothing shared: isolated pairs stay apart')
  const groups = found.map((g, i) => ({ id: `g${i}`, name: g.name, member_ids: g.members, collapsed: true, excluded: [], rule: null }))
  const v = view({ ...data, groups })
  assert.equal(v.nodes.filter(n => n.kind === 'activity').length, 1, 'the five reads become one diamond')
  assert.equal(v.edges.filter(e => !e.activityId).length, 4, 'the pairs keep their own relations')
  assert.equal(v.nodes.find(n => n.kind === 'activity').count, 5)
  console.log('Auto grouping by shared counterparts passed')
}

// A relationship of an entity with itself stays visible (here after a merge); links inside a collapsed group stay internal.
{
  const log = []
  let c = 0
  const put = (type, payload) => log.push({ id: `s${++c}`, clock: c, at: '2026-10-05T00:00:00.000Z', actor: 'a', author: 'Analyst', boardId: 's', type, payload })
  put('entity.add', { id: 'a', name: 'host-a', kind: 'Device' }); put('entity.add', { id: 'b', name: 'host-b', kind: 'Device' }); put('entity.add', { id: 'c', name: 'host-c', kind: 'Device' })
  put('fact.add', { id: 'self', subject_id: 'a', predicate: 'restarted', object_id: 'a' })
  put('fact.add', { id: 'ab', subject_id: 'a', predicate: 'connected to', object_id: 'b' })
  put('fact.add', { id: 'bc', subject_id: 'b', predicate: 'connected to', object_id: 'c' })
  let data = project('s', log).data
  assert.ok(view(data).edges.some(e => e.source === 'a' && e.target === 'a' && e.factIds.includes('self')))
  put('entity.merge', { source_id: 'b', target_id: 'a' })
  data = project('s', log).data
  const loops = view(data).edges.filter(e => e.source === 'a' && e.target === 'a')
  assert.deepEqual(loops.flatMap(e => e.factIds).sort(), ['ab', 'self'])
  put('group.add', { id: 'g', name: 'Hosts', members: ['a', 'c'], collapsed: true })
  data = project('s', log).data
  const grouped = view(data)
  assert.equal(grouped.edges.length, 0)
  assert.equal(grouped.nodes.find(n => n.kind === 'group').internal, 3)
  console.log('Self-relations stay visible; group-internal links stay aggregated passed')
}

// A generated name with a member count goes stale: the count is dropped from it; a name an analyst chose stays as is.
{
  const log = []
  let c = 0
  const put = (type, payload) => log.push({ id: `n${++c}`, clock: c, at: '2026-10-05T00:00:00.000Z', actor: 'a', author: 'Analyst', boardId: 'n', type, payload })
  for (let i = 0; i < 3; i++) put('entity.add', { id: `r${i}`, name: `org/r${i}`, kind: 'Repository' })
  put('entity.add', { id: 'h', name: 'host', kind: 'Device' })
  put('group.add', { id: 'g1', name: '422 Repository · cloned', members: ['r0', 'r1', 'r2'], collapsed: true })
  put('group.add', { id: 'g2', name: '3 hosts', members: ['h'], collapsed: true })
  const groups = project('n', log).data.groups
  assert.deepEqual(groups.map(g => [g.name, g.member_ids.length]), [['Repository · cloned', 3], ['3 hosts', 1]])
  console.log('Group names without stale member counts passed')
}
