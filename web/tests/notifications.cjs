const assert = require('node:assert/strict')
const store = new Map()
globalThis.localStorage = { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) }
const { classify, count, describe, noticesFor, loadNotices, saveNotices, createLimiter } = require(require('node:path').resolve(process.argv[2]) + '/notifications.js')

let n = 0
const act = (type, payload = {}, extra = {}) => ({ id: `a${++n}`, boardId: 'b', actor: 'me', author: 'Ana', clock: n, at: '2026-10-04T10:00:00.000Z', type, payload: { id: `p${n}`, ...payload }, channel: 'UI', batch_id: 'x', ...extra })

;(async () => {
  // Who changed it: own canvas is silent; agents, Enricher and colleagues are told apart.
  assert.equal(classify([act('entity.add')], 'me'), null)
  assert.deepEqual(classify([act('entity.add', {}, { channel: 'MCP', author: 'Claude' })], 'me'), { kind: 'agent', author: 'Claude via MCP' })
  assert.deepEqual(classify([act('entity.add', {}, { channel: 'REST', author: 'REST' })], 'me'), { kind: 'agent', author: 'Agent via REST' })
  // Agents work with an analyst's board token: whose agent it was is part of the author.
  assert.deepEqual(classify([act('entity.add', {}, { channel: 'MCP', author: 'MCP (Gregor)' })], 'me'), { kind: 'agent', author: 'Agent via MCP (Gregor)' })
  assert.deepEqual(classify([act('entity.add', {}, { channel: 'MCP', author: 'Claude (Gregor)' })], 'me'), { kind: 'agent', author: 'Claude via MCP (Gregor)' })
  assert.equal(classify([act('entity.add', {}, { channel: 'REST', author: 'Enricher (Gregor)' })], 'me').kind, 'enricher')
  assert.equal(classify([act('entity.add', {}, { channel: 'REST', author: 'Enricher' })], 'me').kind, 'enricher')
  assert.equal(classify([act('entity.add', {}, { channel: 'Import', author: 'GTIEnricher' })], 'me').author, 'Enricher', 'exports from before the rename')
  assert.equal(classify([act('entity.add', {}, { actor: 'other', author: 'Ben' })], 'me').kind, 'colleague')

  // Counts and wording; new evidence leads to the review.
  const batch = [act('entity.add'), act('entity.add'), act('fact.add'), act('assertion.add'), act('assertion.add'), act('entity.position')].map(a => ({ ...a, channel: 'MCP', author: 'Claude', batch_id: 'b1' }))
  assert.equal(describe(count(batch)), '2 entities, 1 relationship, 2 new evidence items')
  const first = noticesFor(new Map([['b1', batch]]), 'me', [])
  assert.equal(first.created.length, 1)
  assert.equal(first.created[0].title, 'Claude via MCP changed the board')
  assert.deepEqual(first.created[0].target, { kind: 'review' })
  // A later chunk of the same batch updates the notice instead of adding one.
  const more = noticesFor(new Map([['b1', [act('fact.add', {}, { channel: 'MCP', author: 'Claude', batch_id: 'b1' })]]]), 'me', first.created)
  assert.equal(more.created.length, 0)
  assert.equal(more.updates[0].counts.relationships, 2)
  // Further small calls by the same agent within two minutes are combined, also when the notice was already read.
  const next = noticesFor(new Map([['b2', [act('entity.add', {}, { channel: 'MCP', author: 'Claude', batch_id: 'b2' })]]]), 'me', more.updates)
  assert.equal(next.created.length, 0)
  assert.equal(next.updates[0].counts.entities, 3)
  assert.deepEqual(next.updates[0].batchIds, ['b1', 'b2'])
  const afterRead = noticesFor(new Map([['b3', [act('entity.add', {}, { channel: 'MCP', author: 'Claude', batch_id: 'b3' })]]]), 'me', [{ ...next.updates[0], read: true }])
  assert.equal(afterRead.created.length, 0)
  assert.equal(afterRead.updates[0].read, false, 'new changes make it unread again')
  const later = noticesFor(new Map([['b4', [act('entity.add', {}, { channel: 'MCP', author: 'Claude', batch_id: 'b4' })]]]), 'me', next.updates, new Date(Date.now() + 3 * 60_000).toISOString())
  assert.equal(later.created.length, 1, 'older than two minutes: new notice')
  // A single new entity points to itself; colleague notices are quiet; moves alone say nothing.
  const one = noticesFor(new Map([['c', [act('entity.add', { id: 'e9' }, { actor: 'other', author: 'Ben', batch_id: 'c' })]], ['d', [act('entity.position', {}, { actor: 'other', batch_id: 'd' })]]]), 'me', [])
  assert.equal(one.created.length, 1)
  assert.deepEqual(one.created[0].target, { kind: 'entity', id: 'e9' })
  assert.equal(one.created[0].quiet, true)

  // A sync with many batches folds colleagues into one notice and agents after the fifth.
  const many = new Map()
  for (let i = 0; i < 6; i++) many.set(`col${i}`, [act('fact.add', {}, { actor: 'other', author: i % 2 ? 'Ben' : 'Cleo', batch_id: `col${i}` })])
  for (let i = 0; i < 7; i++) many.set(`agent${i}`, [act('entity.add', {}, { channel: 'MCP', author: 'Claude', batch_id: `agent${i}` })])
  const folded = noticesFor(many, 'me', [])
  // The seven agent batches come from one author: combined into one notice instead of five plus a remainder.
  assert.equal(folded.created.filter(x => x.kind === 'agent').length, 1)
  assert.equal(folded.created.find(x => x.kind === 'agent').counts.entities, 7)
  assert.equal(folded.created.filter(x => x.kind === 'colleague').length, 1)
  assert.match(folded.created.find(x => x.kind === 'colleague').title, /Colleagues synced: (Cleo, Ben|Ben, Cleo)/)

  const agents = new Map()
  for (let i = 0; i < 9; i++) agents.set(`g${i}`, [act('entity.add', {}, { channel: 'MCP', author: `Agent ${i}`, batch_id: `g${i}` })])
  const foldedAgents = noticesFor(agents, 'me', [])
  assert.equal(foldedAgents.created.filter(x => x.batchIds).length, 5, 'the first five agents individually')
  assert.equal(foldedAgents.created.find(x => x.title.startsWith('More agent')).counts.entities, 4)
  console.log('Notifications: classification, counts, chunk updates, combining, targets and sync folding passed')

  // History survives a reload; running work comes back as interrupted; the newest 80 are kept.
  saveNotices('b', [{ id: 'r', kind: 'import', status: 'running', title: 'Import a.csv', at: 'x' }, ...Array.from({ length: 100 }, (_, i) => ({ id: `d${i}`, kind: 'agent', status: 'info', title: 't', at: 'x' }))])
  const back = loadNotices('b')
  assert.equal(back.length, 80)
  assert.equal(back[0].status, 'error')
  assert.match(back[0].detail, /Interrupted/)
  assert.deepEqual(loadNotices('other'), [])

  // Imports run one after another; a failing one frees the slot.
  const limit = createLimiter(1)
  const order = []
  let running = 0, peak = 0
  const job = i => limit(async () => { running++; peak = Math.max(peak, running); order.push(i); await new Promise(r => setTimeout(r, 3)); running--; if (i === 1) throw new Error('bad file'); return i })
  const results = await Promise.allSettled([0, 1, 2, 3].map(job))
  assert.equal(peak, 1); assert.deepEqual(order, [0, 1, 2, 3]); assert.equal(results.filter(r => r.status === 'fulfilled').length, 3)
  console.log('Notifications: history, interrupted work and import queue passed')
})().catch(error => { console.error(error); process.exit(1) })
