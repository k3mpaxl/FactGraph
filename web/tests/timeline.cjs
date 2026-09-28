const assert = require('node:assert/strict')
const { timelineEntries, timelineEvents, timelineSteps, factIntersects } = require(require('node:path').resolve(process.argv[2]) + '/timeline.js')
const { project } = require(require('node:path').resolve(process.argv[2]) + '/board.js')
const base = {id:'f',valid_from:null,valid_to:null,created_at:'2030-01-01',assertions:[]}
const evidence = (id, fields={}) => ({id,note:'',created_at:'2030-01-01',retracted_at:null,valid_from:null,valid_to:null,...fields})
const entries = timelineEntries([{...base,assertions:[
 evidence('unknown'), evidence('late',{valid_from:'2026-01-02T00:00:00Z',valid_to:'2026-01-03T00:00:00Z'}),
 evidence('legacy',{note:'{"TimeGenerated":"2026-01-01T00:00:00Z"}'}),
 evidence('retracted',{valid_from:'2020-01-01',retracted_at:'2030-01-01'}),
]}])
assert.deepEqual(entries.map(e=>e.assertion.id), ['legacy','late','unknown'])
assert.equal(entries[2].from,null)
assert.equal(entries[1].to,'2026-01-03T00:00:00Z')
const duplicatePeriodFact = {...base, assertions:[
 evidence('support',{stance:'supports',valid_from:'2026-01-02T00:00:00Z'}),
 evidence('refute',{stance:'refutes',valid_from:'2026-01-02T00:00:00Z'}),
]}
assert.equal(timelineEvents([duplicatePeriodFact]).length,1)
assert.equal(timelineEvents([duplicatePeriodFact])[0].assertions.length,2)
assert.deepEqual(timelineSteps([entries[0].fact]), ['2026-01-01T00:00:00.000Z','2026-01-02T00:00:00.000Z','2026-01-03T00:00:00.000Z'])
assert.equal(factIntersects(entries[1].fact, '2026-01-02T12:00:00Z', '2026-01-02T13:00:00Z'), true)
assert.equal(factIntersects(entries[1].fact, '2026-01-04T00:00:00Z', null, false), false)
const unknownFact = {...base, assertions:[evidence('only-unknown')]}
assert.equal(factIntersects(unknownFact, '2026-01-02T12:00:00Z', '2026-01-02T13:00:00Z', true), true)
assert.equal(factIntersects(unknownFact, '2026-01-02T12:00:00Z', '2026-01-02T13:00:00Z', false), false)
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
