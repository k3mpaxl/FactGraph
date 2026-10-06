const assert=require('node:assert/strict')
const path=require('node:path').resolve(process.argv[2])
const {project,undoTargets,redoTarget,isAction,legacyDrafts}=require(path+'/board.js')
const {validateDrafts}=require(path+'/validation.js')
const {factsInWindow}=require(path+'/timeline.js')
const ops=[]
const add=(type,payload,extra={})=>{const action={id:`a${ops.length}`,clock:ops.length+1,at:'2026-09-29T00:00:00.000Z',actor:'analyst',author:'Analyst',boardId:'board',type,payload,...extra};ops.push(action);return action.id}
const graph=()=>project('board',ops).data
const item=()=>graph().facts[0].assertions.find(a=>a.id==='e')
add('entity.add',{id:'a',name:'IP',kind:'IP',x:40,y:80})
add('entity.add',{id:'b',name:'File',kind:'File'})
add('source.add',{id:'s',title:'Raw logs',source_kind:'primary',uri:'repo/logs.json',excerpt:'{"EventId":"42"}'})
add('fact.add',{id:'f',subject_id:'a',object_id:'b',predicate:'reads'})
add('assertion.add',{id:'e',fact_id:'f',source_id:'s',stance:'supports',note:'Read event 42',locator:'EventId=42',valid_from:'2026-09-28T10:00:00.000Z'})
assert.equal(item().review_status,'unconfirmed')
assert.equal(graph().facts[0].truth_state,'unknown')
const review=()=>({id:'e',review_status:'confirmed',expected_revision:item().revision,expected_source_revision:graph().sources[0].revision,review_note:'Checked original event'})
validateDrafts(graph(),[{type:'assertion.review',payload:review()}])
add('assertion.review',review())
assert.equal(item().review_status,'confirmed')
assert.equal(graph().facts[0].truth_state,'supported')
add('assertion.update',{id:'e',note:'Corrected read'})
assert.equal(item().review_status,'unconfirmed')
assert.throws(()=>validateDrafts(graph(),[{type:'assertion.review',payload:{...review(),expected_revision:'old'}}]),/revision/)
add('assertion.review',review())
add('source.update',{id:'s',excerpt:'Changed original'})
assert.equal(item().review_status,'unconfirmed')
add('assertion.review',review())
add('assertion.retract',{id:'e'})
assert.equal(graph().facts[0].truth_state,'unknown')
add('assertion.restore',{id:'e'})
assert.equal(item().retracted_at,null)
assert.equal(item().review_status,'unconfirmed')
add('source.update',{id:'s',source_kind:'secondary'})
assert.throws(()=>validateDrafts(graph(),[{type:'assertion.review',payload:review()}]),/primary source/)
add('source.update',{id:'s',source_kind:'primary'})
add('assertion.review',review())
add('assertion.add',{id:'other',fact_id:'f',source_id:'s',stance:'refutes',note:'Refuting event',locator:'EventId=43',valid_from:'2026-09-29T10:00:00.000Z'})
const other=graph().facts[0].assertions.find(a=>a.id==='other')
add('assertion.review',{...review(),id:'other',expected_revision:other.revision})
assert.equal(graph().facts[0].truth_state,'disputed')
assert.equal(factsInWindow(graph().facts,'2026-09-28T00:00:00.000Z','2026-09-28T23:59:59.000Z')[0].truth_state,'supported')
assert.throws(()=>validateDrafts(graph(),[{type:'source.delete',payload:{id:'s'}}]),/referenced/)
assert.throws(()=>validateDrafts(graph(),[{type:'assertion.update',payload:{id:'e',valid_to:'2020-01-01T00:00:00.000Z'}}]),/after start/)
const move=add('entity.position',{id:'a',x:200,y:300})
const rename=add('entity.update',{id:'a',name:'Renamed'})
add('action.undo',{action_ids:[move,rename]})
assert.equal(graph().entities.find(e=>e.id==='a').name,'IP')
assert.equal(graph().entities.find(e=>e.id==='a').position.x,40)
add('action.redo',{action_ids:[move,rename]})
assert.equal(graph().entities.find(e=>e.id==='a').name,'Renamed')
add('entity.merge',{source_id:'a',target_id:'b'})
assert.equal(graph().facts[0].assertions.length,2,'merge must retain self-relations and their evidence')
assert.equal(graph().facts[0].truth_state,'unknown')
// Evidence parsed by a log import is confirmed (the row is the record); the same by hand needs a review; editing asks again.
{
  const log = []
  let c = 0
  const put = (type, payload, author = 'Analyst', channel) => log.push({ id: `i${++c}`, clock: c, at: '2026-10-05T00:00:00.000Z', actor: 'a', author, boardId: 'i', type, payload, ...(channel ? { channel } : {}) })
  put('entity.add', { id: 'x', name: 'x', kind: 'IP' }); put('entity.add', { id: 'y', name: 'y', kind: 'File' })
  put('source.add', { id: 's', title: 'AzureActivity', source_kind: 'primary', uri: 'import://abc', excerpt: '[{"a":1}]' }, 'Import')
  put('fact.add', { id: 'f', subject_id: 'x', predicate: 'reads', object_id: 'y' }, 'Import')
  put('assertion.add', { id: 'imported', fact_id: 'f', stance: 'supports', source_id: 's', note: '{"a":1}', locator: 'AzureActivity CorrelationId=c1' }, 'Import')
  put('assertion.add', { id: 'agent', fact_id: 'f', stance: 'supports', source_id: 's', note: 'row', locator: 'row 1' }, 'MCP')
  // Rows an agent sends through an import over REST or MCP: it could have written them itself, so they are vetted first.
  put('assertion.add', { id: 'agent-import', fact_id: 'f', stance: 'supports', source_id: 's', note: '{"a":2}', locator: 'AzureActivity CorrelationId=c2' }, 'Import', 'MCP')
  put('assertion.add', { id: 'file-import', fact_id: 'f', stance: 'supports', source_id: 's', note: '{"a":3}', locator: 'AzureActivity CorrelationId=c3' }, 'Import', 'Import')
  let state = project('i', log).data
  const status = id => state.facts[0].assertions.find(a => a.id === id).review_status
  assert.deepEqual([status('imported'), status('agent'), status('agent-import'), status('file-import'), state.facts[0].truth_state], ['confirmed', 'unconfirmed', 'unconfirmed', 'confirmed', 'supported'])
  put('assertion.update', { id: 'imported', observation: 'changed by hand' })
  state = project('i', log).data
  assert.equal(status('imported'), 'unconfirmed', 'edited: back to review')
}
// Removing a participant changes the confirmed statement: its evidence needs a review again.
{
  const log = []
  let c = 0
  const put = (type, payload) => log.push({ id: `p${++c}`, clock: c, at: '2026-10-05T00:00:00.000Z', actor: 'a', author: 'Analyst', boardId: 'p', type, payload })
  put('entity.add', { id: 'act', name: 'actor', kind: 'User' }); put('entity.add', { id: 'sp', name: 'sp', kind: 'Service Principal' }); put('entity.add', { id: 'kv', name: 'kv', kind: 'Key Vault' })
  put('source.add', { id: 's', title: 'Raw', source_kind: 'primary', uri: 'r', excerpt: 'x' })
  put('fact.add', { id: 'f', predicate: 'listed secrets', participants: [{ entity_id: 'act', role: 'actor' }, { entity_id: 'sp', role: 'identity' }, { entity_id: 'kv', role: 'target' }] })
  put('assertion.add', { id: 'e', fact_id: 'f', stance: 'supports', source_id: 's', note: 'row', locator: 'r1' })
  const state = () => project('p', log).data.facts[0]
  put('assertion.review', { id: 'e', review_status: 'confirmed', expected_revision: state().assertions[0].revision, expected_source_revision: project('p', log).data.sources[0].revision, review_note: 'ok' })
  assert.equal(state().truth_state, 'supported')
  put('entity.delete', { id: 'sp' })
  assert.deepEqual([state().participants.length, state().assertions[0].review_status, state().truth_state], [2, 'unconfirmed', 'unknown'])
  // Deleting the actor (the activity's subject) keeps the activity and its evidence while two participants remain.
  put('entity.add', { id: 'ip', name: '192.0.2.4', kind: 'IP' })
  put('fact.update', { id: 'f', participants: [{ entity_id: 'act', role: 'actor' }, { entity_id: 'ip', role: 'source' }, { entity_id: 'kv', role: 'target' }] })
  assert.equal(state().subject_id, 'act')
  put('entity.delete', { id: 'act' })
  assert.deepEqual([state().participants.map(p => p.entity_id), state().subject_id, state().object_id, state().assertions.length], [['ip', 'kv'], 'ip', 'kv', 1])
  // Below two participants the activity is gone.
  put('entity.delete', { id: 'ip' })
  assert.equal(project('p', log).data.facts.length, 0)
}
// An edit resets reviews only when it applies and changes the statement: not when it fails, not for a technique label.
{
  const log = []
  let c = 0
  const put = (type, payload) => log.push({ id: `r${++c}`, clock: c, at: '2026-10-06T00:00:00Z', actor: 'a', author: 'Jo', boardId: 'r', type, payload })
  put('entity.add', { id: 'x', name: 'x', kind: 'IP' }); put('entity.add', { id: 'y', name: 'y', kind: 'File' })
  put('source.add', { id: 's', title: 'Raw', source_kind: 'primary', uri: 'r', excerpt: 'x' })
  put('fact.add', { id: 'f', subject_id: 'x', predicate: 'reads', object_id: 'y' })
  put('assertion.add', { id: 'e', fact_id: 'f', stance: 'supports', source_id: 's', note: 'row', locator: 'r1' })
  const state = () => project('r', log).data.facts[0]
  put('assertion.review', { id: 'e', review_status: 'confirmed', expected_revision: state().assertions[0].revision, expected_source_revision: project('r', log).data.sources[0].revision, review_note: 'ok' })
  put('fact.update', { id: 'f', object_id: 'gone' })
  put('fact.update', { id: 'f', technique: 'T1005' })
  assert.deepEqual([state().object_id, state().technique, state().assertions[0].review_status], ['y', 'T1005', 'confirmed'])
  put('fact.update', { id: 'f', predicate: 'deleted' })
  assert.equal(state().assertions[0].review_status, 'unconfirmed')
}
// Actions from peers and old logs: absurd clocks are refused by every browser alike; colours must be #rrggbb.
{
  const base = { boardId: 'p', id: 'x', actor: 'a', author: 'A', at: '2026-10-06T00:00:00Z', type: 'entity.add', payload: { id: 'e', name: 'e', kind: 'IP' } }
  assert.equal(isAction({ ...base, clock: 5 }), true)
  assert.equal(isAction({ ...base, clock: Number.MAX_SAFE_INTEGER - 1 }), false)
  const data = project('p', [{ ...base, clock: 1, payload: { ...base.payload, color: '"/><script>alert(1)</script>' } },
    { ...base, id: 'y', clock: 2, type: 'type.add', payload: { id: 't', name: 'IP', color: 'red" onload="x' } }]).data
  assert.deepEqual([data.entities[0].color, data.entity_types[0].color], [undefined, '#8da9ce'])
}
// A legacy graph file: activities keep their participants; its evidence arrives unconfirmed, also when the file says confirmed.
{
  const file = { entities: [{ id: 'a', name: 'a', kind: 'User', identifiers: [] }, { id: 'b', name: 'b', kind: 'IP', identifiers: [] }, { id: 'c', name: 'c', kind: 'Key Vault', identifiers: [] }],
    sources: [{ id: 's', title: 'Logs', source_kind: 'primary', uri: 'x', excerpt: 'row', query: '', created_at: '2026-01-01T00:00:00Z' }],
    facts: [{ id: 'f', subject_id: 'a', object_id: 'c', predicate: 'listed secrets', participants: [{ entity_id: 'a', role: 'actor' }, { entity_id: 'b', role: 'source' }, { entity_id: 'c', role: 'target' }],
      assertions: [{ id: 'e', fact_id: 'f', stance: 'supports', source_id: 's', note: '{"x":1}', locator: 'row 1', review_status: 'confirmed', review_note: 'checked', confidence: 1, valid_from: null, valid_to: null, created_at: '2026-01-01T00:00:00Z', retracted_at: null }] }] }
  const drafts = legacyDrafts(file)
  validateDrafts({ entities: [], facts: [], sources: [] }, drafts)
  const log = drafts.map((d, i) => ({ boardId: 'l', id: `l${i}`, actor: 'me', author: d.author, clock: i + 1, at: '2026-10-06T00:00:00Z', type: d.type, payload: d.payload, channel: 'UI' }))
  const fact = project('l', log).data.facts[0]
  assert.deepEqual([fact.participants.length, fact.assertions[0].review_status, fact.assertions[0].created_by], [3, 'unconfirmed', 'Legacy file'])
}
// Undo: the analyst's Cmd+Z and an agent's undo each take back their own batches, though both are written by one browser;
// a change someone else built on is not undone silently.
{
  const log = []
  let c = 0
  const put = (type, payload, extra = {}) => { const id = `u${++c}`; log.push({ id, clock: c, at: '2026-10-06T00:00:00Z', actor: 'tab', author: 'Jo', boardId: 'u', type, payload, batch_id: id, channel: 'UI', ...extra }); return id }
  const ui = put('entity.add', { id: 'host', name: 'host', kind: 'Device' })
  const agent = put('entity.add', { id: 'ip', name: '192.0.2.1', kind: 'IP' }, { channel: 'MCP', author: 'Claude', batch_id: 'agent-batch' })
  assert.deepEqual(undoTargets(log, 'tab', 'analyst').map(a => a.id), [ui], 'Cmd+Z skips the agent batch')
  assert.deepEqual(undoTargets(log, 'tab', 'agent').map(a => a.id), [agent], 'the agent undoes its own batch')
  // The agent connects the analyst's host: undoing the host would silently drop that relationship.
  put('fact.add', { id: 'f', subject_id: 'ip', predicate: 'connected to', object_id: 'host' }, { channel: 'MCP', author: 'Claude', batch_id: 'agent-2' })
  assert.throws(() => undoTargets(log, 'tab', 'analyst'), /built on these records/)
  // A colleague's relationship to it counts as well (other actor).
  const colleague = []
  const put2 = (type, payload, actor) => colleague.push({ id: `c${colleague.length}`, clock: colleague.length + 1, at: '2026-10-06T00:00:00Z', actor, author: actor, boardId: 'u', type, payload, channel: 'UI' })
  put2('entity.add', { id: 'e', name: 'e', kind: 'User' }, 'me'); put2('entity.add', { id: 'g', name: 'g', kind: 'Group' }, 'you')
  put2('fact.add', { id: 'm', subject_id: 'e', predicate: 'member of', object_id: 'g' }, 'you')
  assert.throws(() => undoTargets(colleague, 'me', 'analyst'), /built on these records/)
  // Redo picks the undo of the same scope.
  log.push({ id: 'undo-agent', clock: ++c, at: '2026-10-06T00:00:00Z', actor: 'tab', author: 'Claude', boardId: 'u', type: 'action.undo', payload: { action_ids: ['u3'] }, channel: 'REST' })
  assert.equal(redoTarget(log, 'tab', 'agent')?.id, 'undo-agent')
  assert.equal(redoTarget(log, 'tab', 'analyst'), null)
}
console.log('Review transitions, primary-source requirements, revisions, invalidation, range status, grouped undo/redo and evidence-preserving merge passed')
