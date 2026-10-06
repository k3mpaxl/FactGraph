const assert = require('node:assert/strict')
const { timelineEntries, timelineEvents, timelineSteps, factIntersects, fromUtcInput, toUtcInput } = require(require('node:path').resolve(process.argv[2]) + '/timeline.js')
const { project } = require(require('node:path').resolve(process.argv[2]) + '/board.js')
const base = {id:'f',valid_from:null,valid_to:null,created_at:'2030-01-01',assertions:[]}
const evidence = (id, fields={}) => ({id,note:'',created_at:'2030-01-01',retracted_at:null,valid_from:null,valid_to:null,...fields})
const entries = timelineEntries([{...base,assertions:[
 evidence('unknown'), evidence('late',{valid_from:'2026-01-02T00:00:00.000Z',valid_to:'2026-01-03T00:00:00.000Z'}),
 evidence('legacy',{note:'{"TimeGenerated":"2026-01-01T00:00:00.000Z"}'}),
 evidence('retracted',{valid_from:'2020-01-01',retracted_at:'2030-01-01'}),
]}])
assert.deepEqual(entries.map(e=>e.assertion.id), ['legacy','late','unknown'])
assert.equal(entries[2].from,null)
assert.equal(entries[1].to,'2026-01-03T00:00:00.000Z')
const duplicatePeriodFact = {...base, assertions:[
 evidence('support',{stance:'supports',valid_from:'2026-01-02T00:00:00.000Z'}),
 evidence('refute',{stance:'refutes',valid_from:'2026-01-02T00:00:00.000Z'}),
]}
assert.equal(timelineEvents([duplicatePeriodFact]).length,1)
assert.equal(timelineEvents([duplicatePeriodFact])[0].assertions.length,2)
assert.deepEqual(timelineSteps([entries[0].fact]), ['2026-01-01T00:00:00.000Z','2026-01-02T00:00:00.000Z','2026-01-03T00:00:00.000Z'])
assert.equal(factIntersects(entries[1].fact, '2026-01-02T12:00:00.000Z', '2026-01-02T13:00:00.000Z'), true)
assert.equal(factIntersects(entries[1].fact, '2026-01-04T00:00:00.000Z', null, false), false)
const unknownFact = {...base, assertions:[evidence('only-unknown')]}
assert.equal(factIntersects(unknownFact, '2026-01-02T12:00:00.000Z', '2026-01-02T13:00:00.000Z', true), true)
assert.equal(factIntersects(unknownFact, '2026-01-02T12:00:00.000Z', '2026-01-02T13:00:00.000Z', false), false)
const ops = [
 {type:'entity.add',payload:{id:'a',name:'Old',kind:'IP'}},
 {type:'entity.update',payload:{id:'a',name:'New',kind:'Device',description:'Edited'}},
].map((op,i)=>({...op,id:String(i),clock:i,actor:'test',at:'2030-01-01'}))
const entity = project('board',ops).data.entities[0]
assert.equal(entity.id,'a');assert.equal(entity.name,'New');assert.equal(entity.kind,'Device')
const mergeOps = [
 {type:'entity.add',payload:{id:'a',name:'Source',kind:'IP'}},
 {type:'entity.add',payload:{id:'b',name:'Target',kind:'Device'}},
 {type:'entity.add',payload:{id:'c',name:'Other',kind:'File'}},
 {type:'identifier.add',payload:{id:'i',entity_id:'a',scheme:'ip',raw_value:'1.2.3.4'}},
 {type:'fact.add',payload:{id:'f',subject_id:'a',predicate:'accessed',object_id:'c'}},
 {type:'assertion.add',payload:{id:'e',fact_id:'f',stance:'supports'}},
 {type:'entity.merge',payload:{source_id:'a',target_id:'b'}},
].map((op,i)=>({...op,id:`m${i}`,clock:i,actor:'test',at:'2030-01-01'}))
const merged = project('board',mergeOps).data
assert.deepEqual(merged.entities.map(item=>item.id).sort(),['b','c'])
assert.equal(merged.entities.find(item=>item.id==='b').identifiers[0].raw_value,'1.2.3.4')
assert.equal(merged.facts[0].subject_id,'b');assert.equal(merged.facts[0].assertions[0].id,'e')
const undone = project('board',[...ops,{type:'action.undo',payload:{action_id:'1'},id:'u',clock:3,actor:'test',at:'2030-01-01'}]).data.entities[0]
assert.equal(undone.name,'Old')
console.log('Timeline grouping, ranges, legacy logs, unknown dates, retractions, merge and undo passed')

// Window keeps the old semantics: retracted evidence never counts; untouched facts keep their identity; 200k values do not overflow.
{
  const t = require(require('node:path').resolve(process.argv[2]) + '/timeline.js')
  const fact = (id, assertions) => ({ id, subject_id: 'a', predicate: 'p', object_id: 'b', valid_from: null, valid_to: null, assertions, truth_state: 'supported' })
  const a = (id, from, extra = {}) => ({ id, fact_id: 'f', stance: 'supports', confidence: 1, source_id: 's', note: 'free text {not json', valid_from: from, valid_to: null, review_status: 'confirmed', ...extra })
  const inside = fact('f1', [a('a1', '2026-09-10T00:00:00.000Z')])
  const mixed = fact('f2', [a('a2', '2026-09-10T00:00:00.000Z'), a('a3', '2026-09-10T00:00:00.000Z', { retracted_at: '2026-09-11T00:00:00.000Z' })])
  const outside = fact('f3', [a('a4', '2026-08-01T00:00:00.000Z')])
  const legacy = fact('f4', [a('a5', null, { note: JSON.stringify({ TimeGenerated: '2026-09-09T12:00:00.000Z' }) })])
  const result = t.factsInWindow([inside, mixed, outside, legacy], '2026-09-05T00:00:00.000Z', '2026-09-12T00:00:00.000Z', false)
  assert.deepEqual(result.map(f => f.id), ['f1', 'f2', 'f4'])
  assert.equal(result[0], inside, 'unchanged facts are not copied')
  assert.deepEqual(result[1].assertions.map(x => x.id), ['a2'], 'retracted evidence is left out')
  const many = Array.from({ length: 70000 }, (_, i) => fact(`m${i}`, [a(`m${i}`, new Date(Date.UTC(2026, 0, 1) + i * 60000).toISOString())]))
  const bounds = t.timelineBounds(many)
  assert.equal(bounds.from, '2026-01-01T00:00:00.000Z')
  console.log('Timeline window semantics and large boards passed')
}

// Dialog times are UTC whatever the browser's time zone (Europe/Berlin must not turn 10:00 into 08:00Z).
{
  assert.equal(fromUtcInput('2026-10-04T10:00'), '2026-10-04T10:00:00.000Z')
  assert.equal(fromUtcInput('2026-01-15T10:00:30'), '2026-01-15T10:00:30.000Z')
  assert.equal(fromUtcInput('2026-10-04T10:00:00+02:00'), '2026-10-04T08:00:00.000Z')
  assert.equal(fromUtcInput(''), null)
  assert.equal(fromUtcInput('nonsense'), null)
  assert.equal(toUtcInput('2026-10-04T10:00:00.000Z'), '2026-10-04T10:00')
  assert.equal(toUtcInput('2026-10-04T10:00:30.000Z', true), '2026-10-04T10:00:30')
  console.log('UTC dialog times passed')
}

// One time format: zone-less times are UTC (not the browser's local time), offsets are converted, precision is fixed.
{
  const { utc, isUtc } = require(require('node:path').resolve(process.argv[2]) + '/time.js')
  assert.equal(utc('2026-09-17T10:00:00'), '2026-09-17T10:00:00.000Z')
  assert.equal(utc('2026-09-17 10:00:00'), '2026-09-17T10:00:00.000Z')
  assert.equal(utc('2026-09-17T10:00:00+02:00'), '2026-09-17T08:00:00.000Z')
  assert.equal(utc('2026-09-17T08:00:05.123456Z'), '2026-09-17T08:00:05.123Z')
  assert.equal(utc('2026-09-17'), '2026-09-17T00:00:00.000Z')
  assert.equal(utc('9/28/2026, 10:42:07 AM'), '2026-09-28T10:42:07.000Z')
  assert.equal(utc('nonsense'), null)
  assert.equal(utc(42), null)
  assert.ok(isUtc('2026-09-17T08:00:05.123Z'))
  assert.ok(!isUtc('2026-09-17T08:00:05Z) | union x'))
  // The projection stores every time normalised, so text order is time order (an offset no longer sorts wrongly).
  const ops = []
  const add = (type, payload) => ops.push({ id: `u${ops.length}`, clock: ops.length + 1, at: '2026-10-06T00:00:00Z', actor: 'a', author: 'A', boardId: 'u', type, payload })
  add('entity.add', { id: 'a', name: 'a', kind: 'IP' }); add('entity.add', { id: 'b', name: 'b', kind: 'File' })
  add('fact.add', { id: 'f', subject_id: 'a', predicate: 'reads', object_id: 'b' })
  add('assertion.add', { id: 'late', fact_id: 'f', stance: 'supports', valid_from: '2026-09-17T10:00:00+02:00' })
  add('assertion.add', { id: 'early', fact_id: 'f', stance: 'supports', valid_from: '2026-09-17T07:30:00' })
  const items = project('u', ops).data.facts[0].assertions
  const at = id => items.find(a => a.id === id).valid_from
  assert.deepEqual([at('early'), at('late')], ['2026-09-17T07:30:00.000Z', '2026-09-17T08:00:00.000Z'])
  assert.ok(at('early') < at('late'))
  console.log('UTC times: zone-less as UTC, offsets converted, one format in the projection passed')
}
