const assert = require('node:assert/strict')
const path = require('node:path').resolve(process.argv[2])
const { project } = require(path + '/board.js')
const { sessionId, processKeys, messageId, keysOf, linkedActivities } = require(path + '/correlation.js')

const SID = '6F1C2D3E-4A5B-4C6D-8E9F-0A1B2C3D4E5F'
// The Entra session ID: lower case, from sign-in and Graph rows (they carry a token ID) and Microsoft 365 / Cloud App
// context; a bare SessionId of another product and Windows SIDs are not taken for it.
assert.equal(sessionId(JSON.stringify({ UniqueTokenIdentifier: 'tokenAAAA1111bbbb', SessionId: SID })), SID.toLowerCase())
assert.equal(sessionId(JSON.stringify({ AppAccessContext: { AADSessionId: SID } })), SID.toLowerCase())
assert.equal(sessionId(JSON.stringify({ RawEventData: { claims: { sid: SID } } })), SID.toLowerCase())
assert.equal(sessionId(JSON.stringify({ SessionId: SID, DeviceName: 'ws-1' })), undefined, 'SessionId of a non-Entra row')
assert.equal(sessionId(JSON.stringify({ UniqueTokenId: 'tokenAAAA1111bbbb', Sid: 'S-1-5-21-1-2-3-1104' })), undefined)
// Process start keys with their device (numbers or text, as exports differ); a key of 0 is none.
assert.deepEqual(processKeys(JSON.stringify({ DeviceId: 'D1', ProcessUniqueId: 200, InitiatingProcessUniqueId: '100' })), { started: 'd1|200', by: 'd1|100' })
assert.deepEqual(processKeys(JSON.stringify({ ProcessUniqueId: 200 })), {}, 'no device, no key')
assert.deepEqual(processKeys(JSON.stringify({ DeviceId: 'd1', InitiatingProcessUniqueId: 0 })), {})
assert.equal(messageId(JSON.stringify({ NetworkMessageId: 'AAAAAAAA-1111-2222-3333-444444444444' })), 'aaaaaaaa-1111-2222-3333-444444444444')

// Every session, process and email column of the xdrinternals.com catalog is read.
const catalog = require(require('node:path').join(__dirname, '../../app/data/column_relations.json'))
const sample = (end, value, extra = {}) => JSON.stringify({ ...extra, [end.column]: end.path ? end.path.split('.').reduceRight((inner, key) => ({ [key]: inner }), value) : value })
for (const relation of catalog.relations) for (const end of [relation.from, relation.to]) {
  const label = `${relation.family} ${end.table}.${end.column}${end.path ? '.' + end.path : ''}`
  if (relation.family === 'entra-session') assert.equal(sessionId(sample(end, SID, { UniqueTokenIdentifier: 'tokenAAAA1111bbbb' })), SID.toLowerCase(), label)
  if (relation.family === 'email-message') assert.equal(messageId(sample(end, 'aaaaaaaa-1111-2222-3333-444444444444')), 'aaaaaaaa-1111-2222-3333-444444444444', label)
  if (relation.family === 'process-start-key') {
    const keys = keysOf(sample(end, '4242', { DeviceId: 'd1' })).filter(k => k.kind === 'process')
    assert.deepEqual(keys.map(k => [k.value, k.role]), [['d1|4242', end.column === 'ProcessUniqueId' ? 'started' : 'by']], label)
  }
}

// Linked activities: a process tree, one email across tables, one sign-in session with two tokens.
{
  let clock = 0
  const ops = []
  const act = (type, payload) => ops.push({ id: `a${++clock}`, clock, at: '2026-10-04T00:00:00.000Z', actor: 'me', author: 'Analyst', boardId: 'b', type, payload })
  for (const [id, kind] of [['d1', 'Device'], ['d2', 'Device'], ['word', 'Process'], ['ps', 'Process'], ['ip', 'IP'], ['f', 'File'], ['u', 'User'], ['url', 'URL'], ['mail', 'Email Address'], ['app', 'Service']])
    act('entity.add', { id, name: id, kind })
  const event = (id, predicate, participants, row, at) => {
    act('fact.add', { id, predicate, participants: participants.map(([entity_id, role]) => ({ entity_id, role })) })
    act('assertion.add', { id: `${id}-e`, fact_id: id, stance: 'supports', valid_from: at, note: JSON.stringify(row), source_id: null })
  }
  event('launch', 'process created', [['d1', 'via'], ['word', 'actor'], ['ps', 'target']], { DeviceId: 'd1', ProcessUniqueId: 200, InitiatingProcessUniqueId: 100 }, '2026-10-01T10:00:00Z')
  event('connect', 'connection success', [['ps', 'actor'], ['ip', 'target']], { DeviceId: 'd1', InitiatingProcessUniqueId: 200 }, '2026-10-01T10:00:05Z')
  event('write', 'file created', [['ps', 'actor'], ['f', 'target']], { DeviceId: 'd1', InitiatingProcessUniqueId: 200 }, '2026-10-01T10:00:03Z')
  event('elsewhere', 'file created', [['d2', 'via'], ['f', 'target']], { DeviceId: 'd2', InitiatingProcessUniqueId: 200 }, '2026-10-01T10:00:04Z')
  const message = 'aaaaaaaa-1111-2222-3333-444444444444'
  event('delivered', 'sent email (delivered)', [['mail', 'actor'], ['u', 'target']], { NetworkMessageId: message }, '2026-10-01T09:00:00Z')
  event('click', 'clicked', [['u', 'actor'], ['url', 'target']], { NetworkMessageId: message.toUpperCase() }, '2026-10-01T09:05:00Z')
  event('signin1', 'signed in', [['u', 'actor'], ['app', 'target']], { UniqueTokenIdentifier: 'tokenAAAA1111bbbb', SessionId: SID }, '2026-10-01T08:00:00Z')
  event('signin2', 'signed in (non-interactive)', [['u', 'actor'], ['app', 'target']], { UniqueTokenIdentifier: 'tokenCCCC2222dddd', SessionId: SID.toLowerCase() }, '2026-10-01T11:00:00Z')
  const data = project('b', ops).data
  const view = id => linkedActivities(data, id).map(g => [g.kind, g.relation, g.facts.map(f => f.fact)])
  assert.deepEqual(view('connect'), [['process', 'launched by', ['launch']], ['process', 'also', ['write']]], 'the other device is a different process')
  assert.deepEqual(view('launch'), [['process', 'then', ['write', 'connect']]], 'what the started process did, earliest first')
  assert.deepEqual(view('delivered'), [['message', 'same', ['click']]])
  assert.deepEqual(view('signin2'), [['session', 'same', ['signin1']]], 'two tokens, one sign-in session')
  assert.deepEqual(view('elsewhere'), [])
}
console.log('Correlation keys: tokens, sign-in sessions, process launches, emails; catalog columns; linked activities passed')
