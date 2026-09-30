import {test, expect, type Page, type APIRequestContext} from '@playwright/test'
import {randomUUID} from 'node:crypto'
import {spawn} from 'node:child_process'
const base='http://127.0.0.1:18088'
function mcp(token:string,tool:string,args:object):Promise<any> {
  return new Promise((resolve,reject)=>{
    const child=spawn('python3',['e2e/mcp_call.py']);let out='',err=''
    child.stdout.on('data',v=>out+=v);child.stderr.on('data',v=>err+=v)
    child.on('close',code=>code?reject(new Error(err)):resolve(JSON.parse(out)))
    child.stdin.end(JSON.stringify({url:base,token,tool,arguments:args}))
  })
}
async function setup(page:Page,request:APIRequestContext) {
  const id=randomUUID();await page.goto(`/boards/${id}`)
  await expect(page.getByText('1 online',{exact:true})).toBeVisible()
  const token=await page.evaluate(id=>sessionStorage.getItem(`factgraph:sessionToken:${id}`)!,id)
  const call=async(method:string,path:string,body?:object)=>{
    const result=await request.fetch(`${base}/api/boards/${id}${path}`,{method,data:body,headers:{'X-FactGraph-Token':token}})
    expect(result.ok(),await result.text()).toBeTruthy();return result.json()
  }
  return {id,token,call,graph:()=>call('GET','/graph')}
}

test('analyst + agent: primary evidence, review, REST/MCP null patches, sync, delete and reload',async({page,browser,request})=>{
  const {id,token,call,graph}=await setup(page,request)
  const second=await browser.newContext();const peer=await second.newPage();await peer.goto(`/boards/${id}`)
  await expect(page.getByText('2 online',{exact:true})).toBeVisible()
  const a=(await call('POST','/entities',{name:'Source device',kind:'Device',x:60,y:100})).id
  const b=(await mcp(token,'rest_create_entity',{board_id:id,body:{name:'Repository file',kind:'File',x:550,y:100}})).id
  const source=(await mcp(token,'rest_create_source',{board_id:id,body:{title:'Access logs',uri:'repo/log.json@abc123',source_kind:'primary',excerpt:'[{"EventId":"42","Action":"ReadFile"}]',query:'AccessLogs | where EventId == "42"'}})).id
  const relation=(await call('POST','/relations',{subject_id:a,object_id:b,predicate:'reads'})).id
  const evidence=(await mcp(token,'rest_create_evidence',{board_id:id,relation_id:relation,body:{source_id:source,stance:'supports',observation:'Original record shows ReadFile by source device.',locator:'EventId=42',valid_from:'2026-09-28T10:00:00Z'}})).id
  await expect.poll(async()=> (await graph()).facts[0].assertions[0].review_status).toBe('unconfirmed')
  await page.getByRole('tab',{name:/Evidence review/}).click()
  await page.locator('.review-queue-item').click()
  await expect(page.getByRole('dialog',{name:'Evidence reader'})).toBeVisible()
  await page.getByLabel('Review note').fill('Compared actor, target and timestamp against original event 42')
  await page.getByRole('button',{name:'Confirm evidence',exact:true}).click()
  await expect.poll(async()=> (await graph()).facts[0].truth_state).toBe('supported')
  const confirmed=await graph();const e=confirmed.facts[0].assertions[0]
  await call('PATCH',`/sources/${source}`,{excerpt:'[{"EventId":"42","Action":"ReadFile","corrected":true}]'})
  await expect.poll(async()=> (await graph()).facts[0].assertions[0].review_status).toBe('unconfirmed')
  const stale=await request.post(`${base}/api/boards/${id}/relations/${relation}/evidence/${evidence}/review`,{headers:{'X-FactGraph-Token':token},data:{review_status:'confirmed',expected_revision:e.revision,expected_source_revision:confirmed.sources[0].revision,review_note:'stale'}})
  expect(stale.status()).toBe(409)
  await mcp(token,'rest_update_evidence',{board_id:id,relation_id:relation,evidence_id:evidence,body:{valid_from:null}})
  expect((await graph()).facts[0].assertions[0].valid_from).toBeNull()
  await mcp(token,'update_evidence',{board_id:id,relation_id:relation,evidence_id:evidence,patch:{source_id:null}})
  expect((await graph()).facts[0].assertions[0].source_id).toBeNull()
  await call('PATCH',`/relations/${relation}/evidence/${evidence}`,{source_id:source,valid_from:'2026-09-28T10:00:00Z'})
  const current=await graph()
  await mcp(token,'rest_review_evidence',{board_id:id,relation_id:relation,evidence_id:evidence,body:{review_status:'confirmed',expected_revision:current.facts[0].assertions[0].revision,expected_source_revision:current.sources[0].revision,review_note:'Analyst requested recheck'}})
  expect((await graph()).facts[0].truth_state).toBe('supported')
  await mcp(token,'rest_retract_evidence',{board_id:id,relation_id:relation,evidence_id:evidence})
  expect((await graph()).facts[0].truth_state).toBe('unknown')
  await mcp(token,'rest_restore_evidence',{board_id:id,relation_id:relation,evidence_id:evidence})
  expect((await graph()).facts[0].assertions[0].review_status).toBe('unconfirmed')
  const ident=(await mcp(token,'rest_create_identifier',{board_id:id,entity_id:a,body:{scheme:'hostname',raw_value:'HOST-A.'}})).id
  await call('PATCH',`/entities/${a}/identifiers/${ident}`,{raw_value:'HOST-B.'})
  expect((await graph()).entities.find((x:any)=>x.id===a).identifiers[0].normalized_value).toBe('host-b')
  await mcp(token,'rest_delete_identifier',{board_id:id,entity_id:a,identifier_id:ident})
  await call('PATCH',`/entities/${a}/position`,{x:160,y:240})
  const peerToken=await peer.evaluate(id=>sessionStorage.getItem(`factgraph:sessionToken:${id}`)!,id)
  await expect.poll(async()=>{const r=await request.get(`${base}/api/boards/${id}/graph`,{headers:{'X-FactGraph-Token':peerToken}});return (await r.json()).entities.find((e:any)=>e.id===a).position}).toEqual({x:160,y:240})
  const history=await call('GET','/history?limit=1000')
  expect(new Set(history.items.map((x:any)=>x.channel))).toEqual(new Set(['REST','MCP','UI']))
  expect(new Set(history.items.map((x:any)=>x.actor)).size).toBe(1)
  await page.reload();await expect(page.getByText('2 online',{exact:true})).toBeVisible()
  expect((await graph()).facts[0].assertions[0].id).toBe(evidence)
  const wrong=await request.get(`${base}/api/boards/${randomUUID()}/graph`,{headers:{'X-FactGraph-Token':token}});expect(wrong.status()).toBe(403)
  await mcp(token,'rest_delete_evidence',{board_id:id,relation_id:relation,evidence_id:evidence})
  expect((await graph()).facts[0].assertions).toHaveLength(0)
  await mcp(token,'rest_undo_board',{board_id:id})
  expect((await graph()).facts[0].assertions).toHaveLength(1)
  await mcp(token,'rest_redo_board',{board_id:id})
  expect((await graph()).facts[0].assertions).toHaveLength(0)
  await mcp(token,'rest_delete_relation',{board_id:id,relation_id:relation})
  await mcp(token,'rest_delete_source',{board_id:id,source_id:source})
  await mcp(token,'rest_delete_entity',{board_id:id,entity_id:b})
  expect((await graph()).entities).toHaveLength(1)
  await second.close()
})

test('canvas: palette, connect handles, inline rename, edit color/type, grouped history and type catalog',async({page,request})=>{
  const {call,graph}=await setup(page,request)
  await page.getByRole('button',{name:'Add entity',exact:true}).click()
  await page.locator('.entity-palette').getByRole('button',{name:'Device',exact:true}).click()
  await page.getByRole('dialog',{name:'Place entity'}).getByLabel('Entity name').fill('Workstation')
  await page.getByRole('button',{name:'Save entity',exact:true}).click()
  await expect(page.locator('.entity-node')).toHaveCount(1)
  const a=(await graph()).entities[0].id
  await call('PATCH',`/entities/${a}/position`,{x:80,y:160})
  const b=(await call('POST','/entities',{name:'Target file',kind:'File',x:650,y:160})).id
  await page.getByRole('button',{name:'fit view'}).click()
  const handle=page.locator(`[data-id="${a}"] .react-flow__handle.source`)
  const target=page.locator(`[data-id="${b}"] .react-flow__handle.target`)
  await handle.dragTo(target)
  await page.getByRole('dialog',{name:'Connect entities'}).getByLabel('Relationship',{exact:true}).fill('reads')
  await page.getByRole('button',{name:'Save connection'}).click()
  await expect.poll(async()=> (await graph()).facts.length).toBe(1)
  await page.locator(`[data-id="${a}"] .node-copy strong`).dblclick()
  await page.locator(`[data-id="${a}"]`).getByLabel('Entity name',{exact:true}).fill('Renamed workstation')
  await page.locator(`[data-id="${a}"]`).getByLabel('Entity name',{exact:true}).press('Enter')
  await expect.poll(async()=> (await graph()).entities.find((e:any)=>e.id===a).name).toBe('Renamed workstation')
  await page.getByRole('button',{name:'Undo',exact:true}).click()
  await expect.poll(async()=> (await graph()).entities.find((e:any)=>e.id===a).name).toBe('Workstation')
  await page.getByRole('button',{name:'Redo',exact:true}).click()
  await page.locator(`[data-id="${a}"]`).click({button:'right'})
  await page.getByRole('button',{name:'Edit name, type & color'}).click()
  const dialog=page.getByRole('dialog',{name:'Edit entity'})
  await dialog.getByLabel('Type',{exact:true}).selectOption('User')
  await dialog.getByLabel('Node color').fill('#cc44aa')
  await dialog.getByRole('button',{name:/Save/}).click()
  expect((await graph()).entities.find((e:any)=>e.id===a)).toMatchObject({kind:'User',color:'#cc44aa'})
  const custom=(await call('POST','/types',{name:'Custom resource',color:'#abcdef'})).id
  await call('PATCH',`/types/${custom}`,{name:'Cloud asset'})
  expect((await call('GET','/types')).items[0].name).toBe('Cloud asset')
  await call('DELETE',`/types/${custom}`)
  await page.getByRole('button',{name:'Close',exact:true}).click()
  await page.screenshot({path:'test-results/investigation-canvas.png'})
})

test('imports: preview, repeated rows, batch undo/redo, primary results preserved',async({page,request})=>{
  const {call,graph}=await setup(page,request)
  const rows=Array.from({length:250},(_,i)=>({EventId:String(i),IPAddress:'10.0.0.5',FilePath:`repo/file-${i%5}`,TimeGenerated:`2026-09-28T10:${String(i%60).padStart(2,'0')}:00Z`}))
  const body={query:'AccessLogs',rows,title:'Test results'}
  const preview=await call('POST','/imports/kql',{...body,dry_run:true})
  expect(preview.dry_run).toBe(true);expect((await graph()).entities).toHaveLength(0)
  await call('POST','/imports/kql',body)
  const before=await graph();expect(before.facts.flatMap((f:any)=>f.assertions)).toHaveLength(250)
  expect(JSON.parse(before.sources[0].excerpt)).toHaveLength(250)
  await call('POST','/imports/kql',body)
  expect((await graph()).facts.flatMap((f:any)=>f.assertions)).toHaveLength(250)
  await call('POST','/undo')
  expect((await graph()).entities).toHaveLength(0)
  await call('POST','/redo')
  expect((await graph()).facts.flatMap((f:any)=>f.assertions)).toHaveLength(250)
  await page.reload();await expect(page.getByText('1 online',{exact:true})).toBeVisible()
  expect((await graph()).facts.flatMap((f:any)=>f.assertions)).toHaveLength(250)
})

test('canvas drag from a handle to blank space is atomic and cancellable',async({page,request})=>{
  const {call,graph}=await setup(page,request)
  const source=(await call('POST','/entities',{name:'Origin',kind:'Device',x:60,y:160})).id
  await expect(page.locator('.entity-node')).toHaveCount(1)
  await page.getByRole('button',{name:'fit view'}).click()
  const handle=page.locator(`[data-id="${source}"] .react-flow__handle.source`)
  const box=(await handle.boundingBox())!
  const pane=(await page.locator('.react-flow__pane').boundingBox())!
  const end={x:pane.x+pane.width-120,y:pane.y+pane.height-140}
  await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();await page.mouse.move(end.x,end.y,{steps:10});await page.mouse.up()
  await expect(page.getByRole('dialog',{name:'Connect entities'})).toBeVisible()
  await page.keyboard.press('Escape')
  expect((await graph()).entities).toHaveLength(1)
  expect((await graph()).facts).toHaveLength(0)
  await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();await page.mouse.move(end.x,end.y,{steps:10});await page.mouse.up()
  const draft=page.getByRole('dialog',{name:'Connect entities'})
  await draft.getByLabel('Relationship',{exact:true}).fill('exposes')
  await draft.getByLabel('Entity name',{exact:true}).fill('Azure credential')
  await draft.getByLabel('Type',{exact:true}).fill('Credential')
  await draft.getByRole('button',{name:'Save connection'}).click()
  await expect.poll(async()=> (await graph()).entities.length).toBe(2)
  expect((await graph()).facts).toHaveLength(1)
  await page.getByRole('button',{name:'Undo',exact:true}).click()
  await expect.poll(async()=> (await graph()).entities.length).toBe(1)
  expect((await graph()).facts).toHaveLength(0)
  await page.getByRole('button',{name:'Redo',exact:true}).click()
  await expect.poll(async()=> (await graph()).entities.length).toBe(2)
  expect((await graph()).facts).toHaveLength(1)
})

test('layout: compact header and viewport on desktop/mobile, import file preview',async({page,request})=>{
  const {call,graph}=await setup(page,request)
  const stage=page.locator('.graph-stage')
  expect((await page.locator('.compact-header').boundingBox())!.height).toBeLessThanOrEqual(40)
  expect((await stage.boundingBox())!.height).toBeGreaterThanOrEqual(675)
  await page.getByLabel('Board menu').click()
  await page.getByRole('button',{name:'Import logs / KQL',exact:true}).click()
  const dialog=page.getByRole('dialog',{name:'Import activity logs'})
  await dialog.getByLabel('File',{exact:true}).setInputFiles({name:'access.csv',mimeType:'text/csv',buffer:Buffer.from('IPAddress,FilePath,TimeGenerated\n10.0.0.5,repo/.env,2026-09-28T10:00:00Z')})
  await dialog.getByRole('button',{name:'Preview import'}).click()
  await expect(dialog.getByText('Preview · no changes saved yet')).toBeVisible()
  expect((await graph()).entities).toHaveLength(0)
  await dialog.getByRole('button',{name:'Apply import'}).click()
  await expect(dialog).not.toBeVisible()
  expect((await graph()).entities).toHaveLength(2)
  await page.setViewportSize({width:768,height:900})
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true)
  await page.setViewportSize({width:390,height:844})
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true)
  await page.getByLabel('Board menu').click()
  await expect(page.getByRole('button',{name:'Import logs / KQL',exact:true})).toBeVisible()
})

test('layout preserves pinned positions; browser back navigates views without undoing data',async({page,request})=>{
  const {call,graph}=await setup(page,request)
  const a=(await call('POST','/entities',{name:'Pinned device',kind:'Device',x:40,y:80,pinned:true})).id
  const b=(await call('POST','/entities',{name:'Credential',kind:'Credential',x:40,y:80})).id
  await call('POST','/relations',{subject_id:a,object_id:b,predicate:'exposes'})
  await page.getByRole('button',{name:'Arrange',exact:true}).click()
  await expect.poll(async()=> (await graph()).entities.find((e:any)=>e.id===b).position.x).toBeGreaterThan(300)
  expect((await graph()).entities.find((e:any)=>e.id===a).position).toEqual({x:40,y:80})
  await page.getByRole('tab',{name:/Timeline/}).click()
  await page.getByRole('tab',{name:/Evidence review/}).click()
  await page.goBack()
  await expect(page.getByRole('tab',{name:/Timeline/})).toHaveAttribute('aria-selected','true')
  await page.goBack()
  await expect(page.getByRole('tab',{name:/Graph/})).toHaveAttribute('aria-selected','true')
  expect((await graph()).entities).toHaveLength(2)
})

test('large import retains 10000 evidence rows and renders a 1000-node graph',async({page,request})=>{
  const {call,graph}=await setup(page,request)
  const rows=Array.from({length:10000},(_,i)=>({EventId:String(i),IPAddress:'10.0.0.5',FilePath:`repo/file-${i%999}`,TimeGenerated:'2026-09-28T10:00:00Z'}))
  await call('POST','/imports/kql',{query:'AccessLogs',rows,title:'Large result'})
  const data=await graph()
  expect(data.entities).toHaveLength(1000)
  expect(data.facts.flatMap((f:any)=>f.assertions)).toHaveLength(10000)
  await page.getByRole('button',{name:'fit view'}).click()
  await expect(page.locator('.react-flow')).toBeVisible()
  await page.getByRole('tab',{name:/Evidence review/}).click()
  await expect(page.getByRole('tab',{name:/Evidence review/})).toHaveAttribute('aria-selected','true')
})
