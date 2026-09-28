const assert = require('node:assert/strict')
const { timelineEntries, factIntersects } = require(require('node:path').resolve(process.argv[2]) + '/timeline.js')
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
assert.equal(factIntersects(entries[1].fact, '2026-01-02T12:00:00Z', '2026-01-02T13:00:00Z'), true)
assert.equal(factIntersects(entries[1].fact, '2026-01-04T00:00:00Z', null), false)
const ops = [
 {type:'entity.add',payload:{id:'a',name:'Old',kind:'IP'}},
 {type:'entity.update',payload:{id:'a',name:'New',kind:'Device',description:'Edited'}},
].map((op,i)=>({...op,id:String(i),clock:i,actor:'test',at:'2030-01-01'}))
const entity = project('board',ops).data.entities[0]
assert.equal(entity.id,'a');assert.equal(entity.name,'New');assert.equal(entity.kind,'Device')
console.log('Timeline ordering, ranges, legacy logs, unknown dates, retractions and entity edits passed')
