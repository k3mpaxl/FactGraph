// Saved import formats: editing column uses, recognising exports, storage and sharing.
const assert = require('node:assert/strict')
const store = new Map()
globalThis.localStorage = { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) }
const { setUse, useOf, usedColumns, formatProblems, matchFormat, draftFrom, isFormat, loadFormats, saveFormat, deleteFormat, markUsed, exportFormats, importFormats } =
  require(require('node:path').resolve(process.argv[2]) + '/importFormats.js')

const base = { version: 1, id: '', name: 'Vault audit', rows: 'activity', columns: ['event_time', 'caller_oid', 'app_guid', 'action', 'src', 'bytes'],
  entities: [], operation: 'observed', operation_column: null, time: null, end: null, locator: [], details: [] }

{
  // One use per column: choosing a new use takes the column out of its old one.
  let f = setUse(base, 'src', { use: 'entity', kind: 'IP', role: 'source' })
  f = setUse(f, 'caller_oid', { use: 'entity', kind: 'User', role: 'actor', own: { column: 'caller_oid', type: 'entra-object-id' } })
  f = setUse(f, 'event_time', { use: 'time' })
  f = setUse(f, 'action', { use: 'operation' })
  assert.deepEqual(useOf(f, 'caller_oid'), { use: 'entity', kind: 'User', role: 'actor', own: { column: 'caller_oid', type: 'entra-object-id' } })
  assert.equal(useOf(f, 'bytes').use, 'ignore')
  assert.deepEqual(formatProblems(f), [])
  // Changing the role keeps the ID the value is; an ID column added to the user stays with it.
  f = setUse(f, 'app_guid', { use: 'id', of: 'caller_oid', type: 'entra-app-id' })
  f = setUse(f, 'caller_oid', { ...useOf(f, 'caller_oid'), role: 'identity' })
  assert.deepEqual(f.entities.find(e => e.column === 'caller_oid').ids.map(i => i.column), ['caller_oid', 'app_guid'])
  assert.equal(f.entities[1].column, 'caller_oid', 'an entity keeps its place (from and to of a relationship)')
  // The time column becomes an entity: no longer the time.
  const moved = setUse(f, 'event_time', { use: 'entity', kind: 'Other', role: 'other' })
  assert.equal(moved.time, null)
  // An entity that stops being one takes its ID columns along.
  const dropped = setUse(f, 'caller_oid', { use: 'ignore' })
  assert.equal(useOf(dropped, 'app_guid').use, 'ignore')
  assert.deepEqual(usedColumns(f).sort(), ['action', 'app_guid', 'caller_oid', 'event_time', 'src'])
  assert.match(formatProblems(setUse(f, 'src', { use: 'ignore' }))[0], /at least two columns/)
  assert.match(formatProblems({ ...f, rows: 'relationship', entities: [...f.entities, { column: 'x', kind: 'File', role: 'other', ids: [] }] })[0], /exactly two/)
  assert.equal(draftFrom({ ...f, name: '' }, 'vault-audit-2026-09-28.csv', []).name, 'Vault audit')
  console.log('Import formats: column uses, own IDs, problems passed')
}

{
  // Recognising: every used column must be there and the columns mostly the same; the best fit wins.
  const vault = { ...base, id: 'v', entities: [{ column: 'src', kind: 'IP', role: 'source', ids: [] }, { column: 'caller_oid', kind: 'User', role: 'actor', ids: [] }] }
  const proxy = { ...base, id: 'p', name: 'Proxy', columns: ['when', 'client_addr', 'who', 'verb'], entities: [{ column: 'client_addr', kind: 'IP', role: 'source', ids: [] }, { column: 'who', kind: 'User', role: 'actor', ids: [] }] }
  assert.equal(matchFormat([proxy, vault], ['action', 'event_time', 'src', 'caller_oid', 'app_guid', 'bytes', 'region']).format.id, 'v', 'reordered, one column more')
  assert.equal(matchFormat([vault], ['src', 'bytes', 'other1', 'other2', 'other3', 'other4', 'other5', 'other6', 'caller_oid']), null, 'mostly other columns: not this format')
  assert.equal(matchFormat([vault], ['event_time', 'src', 'action', 'app_guid', 'bytes']), null, 'a used column is missing')
  console.log('Import formats: recognising exports passed')
}

{
  // Storage: saved with an id and times, validated on load; shared as a file, newer wins.
  const { saved } = saveFormat({ ...base, entities: [{ column: 'src', kind: 'IP', role: 'source', ids: [] }, { column: 'caller_oid', kind: 'User', role: 'actor', ids: [{ column: 'caller_oid', type: 'other', namespace: 'gitlab-user-id' }] }] }, '2026-10-06T10:00:00.000Z')
  assert.ok(saved.id && saved.created_at === '2026-10-06T10:00:00.000Z')
  assert.equal(loadFormats().length, 1)
  markUsed([saved.id], '2026-10-06T11:00:00.000Z')
  assert.equal(loadFormats()[0].used_at, '2026-10-06T11:00:00.000Z')
  store.set('factgraph:importFormats', JSON.stringify([...loadFormats(), { name: 'broken' }]))
  assert.equal(loadFormats().length, 1, 'invalid entries are ignored')
  const file = exportFormats([{ ...saved, name: 'Vault audit v2', updated_at: '2026-10-07T00:00:00.000Z' }, { ...saved, id: 'other', name: 'Other' }])
  const result = importFormats(file)
  assert.equal(result.added, 1)
  assert.deepEqual(loadFormats().map(f => f.name), ['Other', 'Vault audit v2'])
  assert.throws(() => importFormats('{"formats": [{"name": "x"}]}'), /no valid import formats/)
  deleteFormat('other')
  assert.equal(loadFormats().length, 1)
  assert.ok(isFormat(loadFormats()[0]))
  console.log('Import formats: storage and sharing passed')
}
