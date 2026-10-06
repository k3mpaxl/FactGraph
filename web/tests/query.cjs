const assert = require('node:assert/strict')
const { queryRecords, shorten, messageParts, actionChunks, LIST_TEXT } = require(require('node:path').resolve(process.argv[2]) + '/query.js')

const long = 'x'.repeat(50_000)
const data = { entities: [{ id: 'e1', name: 'Build host' }, { id: 'e2', name: 'secrets.yml' }], sources: [{ id: 's1', title: 'Huge', excerpt: long }],
  facts: [{ id: 'f1', predicate: 'reads', assertions: [{ id: 'a1', note: long, observation: 'needle in the note' }] }], groups: [], views: [], entity_types: [] }

// Lists: only the page, long texts shortened (also evidence inside relations); search covers the full text.
const page = queryRecords(data, { collection: 'entities', limit: 1 })
assert.deepEqual(page, { items: [{ id: 'e1', name: 'Build host' }], total: 2 })
const sources = queryRecords(data, { collection: 'sources' })
assert.equal(sources.items[0].excerpt.length, LIST_TEXT)
assert.equal(sources.items[0].excerpt_length, 50_000)
assert.equal(queryRecords(data, { collection: 'relations' }).items[0].assertions[0].note_truncated, true)
assert.equal(queryRecords(data, { collection: 'evidence', q: 'NEEDLE' }).total, 1)
// Single records are complete; unknown IDs are null; unknown collections fail.
assert.equal(queryRecords(data, { collection: 'sources', id: 's1' }).record.excerpt.length, 50_000)
assert.equal(queryRecords(data, { collection: 'evidence', id: 'nope' }).record, null)
assert.throws(() => queryRecords(data, { collection: 'secrets' }))
assert.equal(shorten({ id: 'x', note: 'short' }).note_truncated, undefined)

// Large replies are split and reassemble to the same JSON.
const payload = { ok: true, record: { excerpt: 'ü'.repeat(25_000) } }
const parts = messageParts('r1', payload, 10_000)
assert.ok(parts.length > 2)
const decoded = parts.map(p => JSON.parse(p))
assert.ok(decoded.every((p, i) => p.type === 'api-result-part' && p.index === i && p.total === parts.length))
assert.deepEqual(JSON.parse(decoded.map(p => p.data).join('')), { type: 'api-result', requestId: 'r1', ...payload })
assert.equal(messageParts('r2', { ok: true }).length, 1)

// Actions are chunked by count and by size; a single huge action gets its own chunk.
const actions = [{ id: 1, payload: 'a'.repeat(3_000_000) }, { id: 2, payload: 'b'.repeat(3_000_000) }, ...Array.from({ length: 150 }, (_, i) => ({ id: i + 3 }))]
const chunks = actionChunks(actions)
assert.deepEqual(chunks.map(c => c.length), [1, 100, 51])
assert.deepEqual(chunks.flat().map(a => a.id), actions.map(a => a.id))
// An action that alone is larger than the relay accepts is left out instead of closing the connection; UTF-8 counts.
{
  const tooLarge = []
  const ascii = { id: 'a', text: 'x'.repeat(6_000_000) }, umlauts = { id: 'u', text: 'ü'.repeat(6_000_000) }, euros = { id: 'e', text: '€'.repeat(6_000_000) }
  const chunks = actionChunks([{ id: 's' }, ascii, umlauts, euros, { id: 't' }], 100, 4_000_000, tooLarge)
  assert.deepEqual(chunks.map(c => c.map(i => i.id)), [['s'], ['a'], ['u'], ['t']], '6 MB and 12 MB fit, 18 MB of three-byte characters does not')
  assert.deepEqual(tooLarge.map(i => i.id), ['e'])
  assert.deepEqual(actionChunks([euros]), [], 'without a collector it is still left out')
}
console.log('Targeted queries, shortened lists, reply parts and size-bounded action chunks passed')

// Sync by summary: a peer sends only what the requester lacks; a gap or a different set falls back per actor.
{
  const { summarize, syncPlan, isSummary } = require(require('node:path').resolve(process.argv[2]) + '/sync.js')
  const act = (actor, clock, id = `${actor}${clock}`) => ({ boardId: 'b', id, actor, author: actor, clock, at: '2026-10-06T00:00:00Z', type: 'entity.position', payload: {} })
  const mine = [act('a', 1), act('a', 2), act('a', 3), act('b', 4), act('b', 5)]
  // A peer that has a1, a2, b4: gets a3 and b5 only.
  let plan = syncPlan(mine, summarize([act('a', 1), act('a', 2), act('b', 4)]))
  assert.deepEqual([plan.send.map(x => x.id), plan.askBack], [['a3', 'b5'], false])
  // Up to date: nothing.
  plan = syncPlan(mine, summarize(mine))
  assert.deepEqual([plan.send.length, plan.askBack], [0, false])
  // A gap below its highest clock (has a1, a3): all of a's actions, and it may hold something here unknown.
  plan = syncPlan(mine, summarize([act('a', 1), act('a', 3), act('b', 4), act('b', 5)]))
  assert.deepEqual(plan.send.map(x => x.id), ['a1', 'a2', 'a3'])
  // It has an actor this browser never saw (offline changes): ask back.
  plan = syncPlan(mine, summarize([...mine, act('c', 9)]))
  assert.deepEqual([plan.send.length, plan.askBack], [0, true])
  // An older browser sends no summary: everything, as before.
  assert.equal(syncPlan(mine, null).send.length, 5)
  assert.ok(isSummary(summarize(mine)) && !isSummary({ a: [1, 2] }) && !isSummary([1]))
  console.log('Sync by summary: deltas, gaps, unknown actors, older peers passed')
}
