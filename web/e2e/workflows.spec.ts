import {test, expect, type Page, type APIRequestContext} from '@playwright/test'
import {randomUUID} from 'node:crypto'
import {spawn} from 'node:child_process'
import {readFileSync} from 'node:fs'
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
  const second=await browser.newContext({storageState:'e2e/storage.json'});const peer=await second.newPage();await peer.goto(`/boards/${id}`)
  await expect(page.getByText('2 online',{exact:true})).toBeVisible()
  await page.getByRole('button',{name:'2 online'}).click()
  await expect(page.locator('.presence-list .presence-row')).toHaveText(/Test analyst/)
  await page.keyboard.press('Escape')
  const a=(await call('POST','/entities',{name:'Source device',kind:'Device',x:60,y:100})).id
  const b=(await mcp(token,'create_entity',{board_id:id,body:{name:'Repository file',kind:'File',x:550,y:100}})).id
  const source=(await mcp(token,'create_source',{board_id:id,body:{title:'Access logs',uri:'repo/log.json@abc123',source_kind:'primary',excerpt:'[{"EventId":"42","Action":"ReadFile"}]',query:'AccessLogs | where EventId == "42"'}})).id
  const relation=(await call('POST','/relations',{subject_id:a,object_id:b,predicate:'reads'})).id
  const evidence=(await mcp(token,'add_evidence',{board_id:id,relation_id:relation,body:{source_id:source,stance:'supports',observation:'Original record shows ReadFile by source device.',locator:'EventId=42',valid_from:'2026-09-28T10:00:00Z'}})).id
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
  await mcp(token,'update_evidence',{board_id:id,relation_id:relation,evidence_id:evidence,body:{valid_from:null}})
  expect((await graph()).facts[0].assertions[0].valid_from).toBeNull()
  await mcp(token,'update_evidence',{board_id:id,relation_id:relation,evidence_id:evidence,body:{source_id:null}})
  expect((await graph()).facts[0].assertions[0].source_id).toBeNull()
  await call('PATCH',`/relations/${relation}/evidence/${evidence}`,{source_id:source,valid_from:'2026-09-28T10:00:00Z'})
  const current=await graph()
  await mcp(token,'review_evidence',{board_id:id,relation_id:relation,evidence_id:evidence,body:{review_status:'confirmed',expected_revision:current.facts[0].assertions[0].revision,expected_source_revision:current.sources[0].revision,review_note:'Analyst requested recheck'}})
  expect((await graph()).facts[0].truth_state).toBe('supported')
  await mcp(token,'retract_evidence',{board_id:id,relation_id:relation,evidence_id:evidence})
  expect((await graph()).facts[0].truth_state).toBe('unknown')
  await call('POST',`/relations/${relation}/evidence/${evidence}/restore`)
  expect((await graph()).facts[0].assertions[0].review_status).toBe('unconfirmed')
  const ident=(await mcp(token,'add_identifier',{board_id:id,entity_id:a,body:{scheme:'hostname',raw_value:'HOST-A.'}})).id
  await call('PATCH',`/entities/${a}/identifiers/${ident}`,{raw_value:'HOST-B.'})
  expect((await graph()).entities.find((x:any)=>x.id===a).identifiers[0].normalized_value).toBe('host-b')
  await call('DELETE',`/entities/${a}/identifiers/${ident}`)
  await call('PATCH',`/entities/${a}/position`,{x:160,y:240})
  const peerToken=await peer.evaluate(id=>sessionStorage.getItem(`factgraph:sessionToken:${id}`)!,id)
  await expect.poll(async()=>{const r=await request.get(`${base}/api/boards/${id}/graph`,{headers:{'X-FactGraph-Token':peerToken}});return (await r.json()).entities.find((e:any)=>e.id===a).position}).toEqual({x:160,y:240})
  const history=await call('GET','/history?limit=1000')
  expect(new Set(history.items.map((x:any)=>x.channel))).toEqual(new Set(['REST','MCP','UI']))
  expect(new Set(history.items.map((x:any)=>x.actor)).size).toBe(1)
  await page.reload();await expect(page.getByText('2 online',{exact:true})).toBeVisible()
  expect((await graph()).facts[0].assertions[0].id).toBe(evidence)
  const wrong=await request.get(`${base}/api/boards/${randomUUID()}/graph`,{headers:{'X-FactGraph-Token':token}});expect(wrong.status()).toBe(403)
  await call('DELETE',`/relations/${relation}/evidence/${evidence}`)
  expect((await graph()).facts[0].assertions).toHaveLength(0)
  await mcp(token,'undo',{board_id:id})
  expect((await graph()).facts[0].assertions).toHaveLength(1)
  await call('POST','/redo')
  expect((await graph()).facts[0].assertions).toHaveLength(0)
  await mcp(token,'delete_relation',{board_id:id,relation_id:relation})
  await call('DELETE',`/sources/${source}`)
  await mcp(token,'delete_entity',{board_id:id,entity_id:b})
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
  await dialog.getByLabel('Custom color').fill('#cc44aa')
  await expect(dialog.getByRole('button',{name:'Color #3b82f6'})).toBeVisible()
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
  await dialog.getByLabel(/^Files/).setInputFiles({name:'access.csv',mimeType:'text/csv',buffer:Buffer.from('IPAddress,FilePath,TimeGenerated\n10.0.0.5,repo/.env,2026-09-28T10:00:00Z')})
  await dialog.getByRole('button',{name:'Preview import'}).click()
  await expect(dialog.getByText('Preview · no changes saved yet')).toBeVisible()
  expect((await graph()).entities).toHaveLength(0)
  await dialog.getByRole('button',{name:'Apply import'}).click()
  await expect(dialog).not.toBeVisible()
  // The import continues in the background and reports in the notifications.
  await expect.poll(async()=> (await graph()).entities.length).toBe(2)
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

test('navigation: command palette jumps to an entity, explorer and inspector navigate, keys switch views',async({page,request})=>{
  const {call}=await setup(page,request)
  const a=(await call('POST','/entities',{name:'Jump host',kind:'Device',x:0,y:0})).id
  const b=(await call('POST','/entities',{name:'Vault secret',kind:'Credential',x:400,y:0})).id
  await call('POST','/relations',{subject_id:a,object_id:b,predicate:'reads'})
  await expect(page.locator('.entity-node')).toHaveCount(2)
  await page.keyboard.press('ControlOrMeta+k')
  const palette=page.getByRole('dialog',{name:'Command palette'})
  await palette.getByPlaceholder(/Search entities/).fill('vault')
  await palette.getByPlaceholder(/Search entities/).press('Enter')
  await expect(palette).not.toBeVisible()
  const inspector=page.getByRole('complementary',{name:'Inspector'})
  await expect(inspector.getByRole('heading',{name:'Vault secret'})).toBeVisible()
  await inspector.getByRole('button',{name:'Jump host'}).click()
  await expect(inspector.getByRole('heading',{name:'Jump host'})).toBeVisible()
  await inspector.getByRole('button',{name:/reads/}).click()
  await expect(inspector.getByText('Relationship',{exact:true})).toBeVisible()
  await page.getByRole('button',{name:'Close',exact:true}).click()
  await page.keyboard.press('2')
  await expect(page.getByRole('tab',{name:/Timeline/})).toHaveAttribute('aria-selected','true')
  await page.keyboard.press('1')
  await page.getByLabel('Search graph').fill('jump')
  await expect(page.getByRole('complementary',{name:'Entity explorer'}).getByRole('button',{name:/Jump host/})).toBeVisible()
  await expect(page.locator('.entity-node.dimmed')).toHaveCount(1)
})

test('sync: offline edits and a concurrent merge converge in both browsers without losing the offline relationship',async({page,browser,request})=>{
  const {id,call,graph}=await setup(page,request)
  const second=await browser.newContext({storageState:'e2e/storage.json'});const peer=await second.newPage()
  // Proxy the peer's relay socket so the test can cut the connection like a network loss.
  let offline=false;const sockets:any[]=[]
  await peer.routeWebSocket(/\/ws\/boards\//,ws=>{if(offline){ws.close();return}sockets.push(ws);ws.connectToServer()})
  await peer.goto(`/boards/${id}`)
  await expect(page.getByText('2 online',{exact:true})).toBeVisible()
  const dup=(await call('POST','/entities',{name:'alice (dup)',kind:'User',x:0,y:0})).id
  const keep=(await call('POST','/entities',{name:'alice',kind:'User',x:0,y:200})).id
  const vault=(await call('POST','/entities',{name:'kv-prod',kind:'Key Vault',x:400,y:100})).id
  await expect(peer.locator('.entity-node')).toHaveCount(3)
  // Peer goes offline and links the duplicate; meanwhile the first analyst merges the duplicate away.
  offline=true;for(const ws of sockets) await ws.close()
  await expect(peer.getByText('Offline',{exact:true})).toBeVisible({timeout:15000})
  await expect(page.getByText('1 online',{exact:true})).toBeVisible()
  await peer.keyboard.press('ControlOrMeta+k')
  await peer.getByPlaceholder(/Search entities/).fill('alice (dup)')
  await peer.getByPlaceholder(/Search entities/).press('Enter')
  await peer.getByRole('complementary',{name:'Inspector'}).getByRole('button',{name:'Connect'}).click()
  const dialog=peer.getByRole('dialog',{name:'New relationship'})
  await dialog.getByRole('button',{name:'Existing node'}).click()
  await dialog.locator('select[name=object_id]').selectOption(vault)
  await dialog.getByLabel('Relationship / predicate').fill('read secrets of')
  await dialog.getByRole('button',{name:/Save/}).click()
  await expect(dialog).not.toBeVisible()
  await call('POST',`/entities/${dup}/merge`,{target_id:keep})
  await call('PATCH',`/entities/${keep}`,{name:'alice@corp'})
  expect((await graph()).entities).toHaveLength(2)
  offline=false
  await expect(page.getByText('2 online',{exact:true})).toBeVisible({timeout:15000})
  const peerToken=await peer.evaluate(id=>sessionStorage.getItem(`factgraph:sessionToken:${id}`)!,id)
  const peerGraph=async()=>(await (await request.get(`${base}/api/boards/${id}/graph`,{headers:{'X-FactGraph-Token':peerToken}})).json())
  await expect.poll(async()=>(await graph()).facts.length).toBe(1)
  const mine=await graph()
  expect(mine.facts[0].subject_id).toBe(keep)
  expect(mine.facts[0].object_id).toBe(vault)
  expect(mine.entities.map((e:any)=>e.id).sort()).toEqual([keep,vault].sort())
  await expect.poll(async()=>{const p=await peerGraph();return JSON.stringify([p.entities,p.facts,p.groups])}).toBe(JSON.stringify([mine.entities,mine.facts,mine.groups]))
  // Simultaneous renames from both browsers settle on the same winner everywhere.
  await Promise.all([call('PATCH',`/entities/${vault}`,{name:'kv-A'}),request.fetch(`${base}/api/boards/${id}/entities/${vault}`,{method:'PATCH',data:{name:'kv-B'},headers:{'X-FactGraph-Token':peerToken}})])
  await expect.poll(async()=>(await peerGraph()).entities.find((e:any)=>e.id===vault).name).toBe((await graph()).entities.find((e:any)=>e.id===vault).name)
  await second.close()
})

test('activities, groups, layers and perspectives across REST, MCP and the canvas',async({page,request})=>{
  const {id,token,call,graph}=await setup(page,request)
  const atk=(await call('POST','/entities',{name:'Attacker',kind:'Threat Actor',x:0,y:0})).id
  const ip=(await call('POST','/entities',{name:'203.0.113.7',kind:'IP',x:0,y:200})).id
  const sp=(await mcp(token,'create_entity',{board_id:id,body:{name:'sp-deploy',kind:'Service Principal',x:300,y:0}})).id
  const kv=(await call('POST','/entities',{name:'kv-prod',kind:'Key Vault',x:600,y:100})).id
  const created=await mcp(token,'create_activity',{board_id:id,body:{operation:'listed secrets',participants:[{entity_id:atk,role:'actor'},{entity_id:ip,role:'source'},{entity_id:sp,role:'identity'},{entity_id:kv,role:'target'}],technique:'T1555.006',valid_from:'2026-09-28T10:42:00Z',observation:'SecretList by sp-deploy from 203.0.113.7',locator:'CorrelationId=abc'}})
  const activity=(await call('GET',`/activities/${created.id}`))
  expect(activity.participants).toHaveLength(4)
  expect(activity.assertions[0].review_status).toBe('unconfirmed')
  expect((await call('GET',`/activities?entity_id=${sp}`)).total).toBe(1)
  await expect(page.locator('.activity-node')).toHaveCount(1)
  await expect(page.locator('.react-flow__edge')).toHaveCount(4)
  await call('PATCH',`/activities/${created.id}`,{participants:[{entity_id:atk,role:'actor'},{entity_id:sp,role:'identity'},{entity_id:kv,role:'target'}]})
  await expect(page.locator('.react-flow__edge')).toHaveCount(3)
  // Multi-column import: one activity per operation + participant set, one evidence per row, idempotent.
  const rows=[1,2,3].map(i=>({CallerIPAddress:'203.0.113.7',AppId:'sp-deploy',ResourceId:'kv-prod',OperationName:i<3?'SecretGet':'SecretList',TimeGenerated:`2026-09-28T11:0${i}:00Z`}))
  const roles=[{field:'CallerIPAddress',role:'source',kind:'IP'},{field:'AppId',role:'identity',kind:'Service Principal'},{field:'ResourceId',role:'target',kind:'Key Vault'}]
  const preview=await call('POST','/imports/activities',{rows,roles,operation_field:'OperationName',dry_run:true,title:'KV audit'})
  expect(preview).toMatchObject({dry_run:true,activities:2,evidence:3})
  await call('POST','/imports/activities',{rows,roles,operation_field:'OperationName',title:'KV audit'})
  await call('POST','/imports/activities',{rows,roles,operation_field:'OperationName',title:'KV audit'})
  const afterImport=await graph()
  expect(afterImport.entities).toHaveLength(4)
  expect(afterImport.facts.filter((f:any)=>f.participants)).toHaveLength(3)
  // Group many repositories, keep one separate.
  const repos=[] as string[]
  for(let i=0;i<12;i++) repos.push((await call('POST','/entities',{name:`org/repo-${i}`,kind:'Repository',x:900,y:i*80})).id)
  await call('POST','/actions',{actions:repos.map(r=>({type:'fact.add',payload:{id:randomUUID(),subject_id:sp,predicate:'cloned',object_id:r}}))})
  const group=(await mcp(token,'create_group',{board_id:id,body:{name:'Org repositories',rule:{kinds:['Repository']},excluded:[repos[11]]}})).id
  expect((await call('GET',`/groups/${group}`)).member_ids).toHaveLength(11)
  await page.getByRole('button',{name:'fit view'}).click()
  await expect(page.locator('.group-node')).toHaveCount(1)
  await expect(page.locator(`[data-id="${repos[11]}"]`)).toBeVisible()
  await page.locator('.group-node').click()
  const inspector=page.getByRole('complementary',{name:'Inspector'})
  await expect(inspector.getByRole('heading',{name:'Org repositories'})).toBeVisible()
  await expect(inspector.getByText('×11')).toBeVisible()
  await inspector.getByRole('button',{name:'Put back'}).click()
  await expect.poll(async()=>(await call('GET',`/groups/${group}`)).member_ids.length).toBe(12)
  await inspector.getByRole('button',{name:'Expand'}).click()
  await expect(page.locator('.frame-node.group')).toHaveCount(1)
  await page.getByRole('button',{name:'Close',exact:true}).click()
  // Layers: hide network, save a perspective.
  await page.getByRole('button',{name:'Layers'}).click()
  const layers=page.getByRole('dialog',{name:'Layers and perspectives'})
  await layers.getByRole('checkbox',{name:/Network/}).uncheck()
  await expect(page.locator(`[data-id="${ip}"]`)).toHaveCount(0)
  await layers.getByLabel('Perspective name').fill('Without network')
  await layers.getByRole('button',{name:'Save perspective'}).click()
  await expect.poll(async()=>(await call('GET','/perspectives')).items[0]?.layers?.includes('network')).toBe(false)
  expect((await request.get(`${base}/api/layers`)).ok()).toBeTruthy()
  await call('PATCH',`/entities/${kv}`,{layer:'data'})
  expect((await graph()).entities.find((e:any)=>e.id===kv).layer).toBe('data')
  await call('DELETE',`/groups/${group}`)
  await expect(page.locator('.group-node')).toHaveCount(0)
  expect((await graph()).entities).toHaveLength(16)
})

test('export: PNG and SVG downloads, clipboard-free API export via REST and MCP',async({page,request})=>{
  const {id,token,call}=await setup(page,request)
  const a=(await call('POST','/entities',{name:'Attacker & Co <x>',kind:'Threat Actor',x:0,y:0})).id
  const b=(await call('POST','/entities',{name:'kv-prod',kind:'Key Vault',x:420,y:0})).id
  await call('POST','/relations',{subject_id:a,predicate:'listed secrets of',object_id:b})
  await expect(page.locator('.entity-node')).toHaveCount(2)
  await page.getByRole('button',{name:'Export image'}).click()
  const panel=page.getByRole('dialog',{name:'Export image'})
  await panel.getByLabel('Export resolution').selectOption('2')
  const [png]=await Promise.all([page.waitForEvent('download'),panel.getByRole('button',{name:'Download PNG'}).click()])
  expect(png.suggestedFilename()).toMatch(/^factgraph-.*\.png$/)
  const bytes=readFileSync(await png.path())
  expect(bytes.subarray(1,4).toString()).toBe('PNG')
  expect(bytes.readUInt32BE(16)).toBeGreaterThan(900)
  await expect(page.getByText(/PNG exported/)).toBeVisible()
  await page.getByRole('button',{name:'Export image'}).click()
  await panel.getByRole('button',{name:'SVG'}).click()
  await panel.getByLabel('Export theme').selectOption('dark')
  const [svg]=await Promise.all([page.waitForEvent('download'),panel.getByRole('button',{name:'Download SVG'}).click()])
  const text=readFileSync(await svg.path(),'utf8')
  expect(text).toContain('Attacker &amp; Co &lt;x&gt;')
  expect(text).toContain('listed secrets of')
  expect(text).toContain('<g fill="none" stroke=')
  expect(await page.evaluate(t=>new DOMParser().parseFromString(t,'image/svg+xml').getElementsByTagName('parsererror').length,text)).toBe(0)
  // Selection without selected nodes explains itself instead of producing an empty file.
  await page.getByRole('button',{name:'Export image'}).click()
  await panel.getByLabel('Export area').selectOption('selection')
  await panel.getByRole('button',{name:'Download SVG'}).click()
  await expect(page.getByRole('alert')).toContainText('Select nodes first')
  await panel.getByLabel('Export area').selectOption('all')
  // Agents: SVG via REST, PNG via MCP.
  const restSvg=await call('POST','/export',{format:'svg',theme:'light',title:'Report figure'})
  expect(restSvg).toMatchObject({format:'svg',mime:'image/svg+xml',node_count:2})
  expect(restSvg.content).toContain('Report figure')
  const mcpPng=await mcp(token,'export_image',{board_id:id,body:{format:'png',scale:1}})
  expect(mcpPng.format).toBe('png')
  expect(Buffer.from(mcpPng.content,'base64').subarray(1,4).toString()).toBe('PNG')
  const bad=await request.post(`${base}/api/boards/${id}/export`,{headers:{'X-FactGraph-Token':token},data:{format:'gif'}})
  expect(bad.status()).toBe(422)
})

test('canvas navigation: wheel zooms, right-drag pans without a browser menu, left-drag still selects',async({page,request})=>{
  const {call}=await setup(page,request)
  await call('POST','/entities',{name:'A',kind:'Device',x:0,y:0})
  await call('POST','/entities',{name:'B',kind:'Device',x:300,y:0})
  await expect(page.locator('.entity-node')).toHaveCount(2)
  const viewport=()=>page.locator('.react-flow__viewport').evaluate(el=>{const m=new DOMMatrix(getComputedStyle(el).transform);return {x:m.e,y:m.f,zoom:m.a}})
  const pane=(await page.locator('.react-flow__pane').boundingBox())!
  const center={x:pane.x+pane.width/2,y:pane.y+pane.height-120}
  const before=await viewport()
  await page.mouse.move(center.x,center.y)
  await page.mouse.wheel(0,-400)
  await expect.poll(async()=>(await viewport()).zoom).toBeGreaterThan(before.zoom)
  const zoomed=await viewport()
  let contextMenu=false
  await page.exposeFunction('reportContextMenu',()=>{contextMenu=true})
  await page.evaluate(()=>document.addEventListener('contextmenu',e=>{if(!e.defaultPrevented)(window as any).reportContextMenu()},{capture:false}))
  await page.mouse.move(center.x,center.y);await page.mouse.down({button:'right'})
  await page.mouse.move(center.x+180,center.y-90,{steps:8});await page.mouse.up({button:'right'})
  await page.mouse.click(center.x+180,center.y-90,{button:'right'})
  const panned=await viewport()
  expect(panned.x-zoomed.x).toBeGreaterThan(150)
  expect(panned.zoom).toBeCloseTo(zoomed.zoom,5)
  expect(contextMenu).toBe(false)
  await page.getByRole('button',{name:'fit view'}).click()
  // Fit view animates; wait until the viewport is stable before drawing the selection box.
  await expect.poll(async()=>{const a=await viewport();await page.waitForTimeout(120);const b=await viewport();return a.x===b.x&&a.zoom===b.zoom}).toBe(true)
  const box=(await page.locator('.react-flow__pane').boundingBox())!
  await page.mouse.move(box.x+20,box.y+80);await page.mouse.down()
  await page.mouse.move(box.x+box.width-20,box.y+box.height-20,{steps:8});await page.mouse.up()
  await expect(page.locator('.selection-tools')).toContainText('2 selected')
})

test('first visit asks for a name; help explains browser storage; agent snippets carry the token header',async({browser,request})=>{
  const context=await browser.newContext({storageState:{cookies:[],origins:[]}});const page=await context.newPage()
  const id=randomUUID();await page.goto(`/boards/${id}`)
  const welcome=page.getByRole('dialog',{name:'Welcome'})
  await expect(welcome).toBeVisible()
  await welcome.getByLabel('Your name').fill('Gregor')
  await welcome.getByRole('button',{name:'Continue'}).click()
  await expect(welcome).not.toBeVisible()
  expect(await page.evaluate(()=>localStorage.getItem('factgraph:displayName'))).toBe('Gregor')
  await page.reload();await expect(page.getByText('1 online',{exact:true})).toBeVisible()
  await expect(page.getByRole('dialog',{name:'Welcome'})).toHaveCount(0)
  expect(await page.evaluate(()=>document.documentElement.dataset.theme)).toBe('light')
  await page.getByRole('button',{name:'Help and data storage'}).click()
  const help=page.getByRole('dialog',{name:'Help'})
  await expect(help.getByText('Everything stays in this browser.')).toBeVisible()
  await expect(help.getByText(/^v\d+\.\d+\.\d+$/)).toBeVisible()
  await expect(help.getByText(/server v\d+\.\d+\.\d+/)).toBeVisible()
  await help.getByRole('tab',{name:'Keyboard & mouse'}).click()
  await expect(help.getByText('Right-drag · trackpad two-finger scroll · Space + drag')).toBeVisible()
  await help.getByRole('button',{name:'Close dialog'}).click()
  await page.getByRole('button',{name:'API and MCP'}).click()
  await page.getByRole('button',{name:'Connect an agent…'}).click()
  const connect=page.getByRole('dialog',{name:'Connect an agent'})
  const token=await page.evaluate(id=>sessionStorage.getItem(`factgraph:sessionToken:${id}`)!,id)
  await expect(connect.locator('pre').first()).toContainText('"X-FactGraph-Token": "${input:factgraph-token}"')
  await connect.getByText('Put the token into the file instead of asking').click()
  await expect(connect.locator('pre').first()).toContainText(token)
  await connect.getByRole('tab',{name:'Claude Code'}).click()
  await expect(connect.locator('pre').first()).toContainText(`--header "X-FactGraph-Token: ${token}"`)
  await expect(connect.getByText(`Board ID: ${id}`)).toBeVisible()
  await context.close()
})

test('confirmed relationships are locked against reconnecting; long labels show in full on hover',async({page,request})=>{
  const {call,graph}=await setup(page,request)
  const a=(await call('POST','/entities',{name:'Device',kind:'Device',x:0,y:0})).id
  const b=(await call('POST','/entities',{name:'Vault',kind:'Key Vault',x:500,y:0})).id
  const long='retrieved the production database connection string from'
  const rel=(await call('POST','/relations',{subject_id:a,object_id:b,predicate:long})).id
  const src=(await call('POST','/sources',{title:'Audit',source_kind:'primary',uri:'law://audit',excerpt:'[{"id":1}]'})).id
  const ev=(await call('POST',`/relations/${rel}/evidence`,{source_id:src,observation:'Row 1 shows it',locator:'id=1'})).id
  await page.getByRole('button',{name:'fit view'}).click()
  const label=page.locator('.edge-label').first()
  await expect(label).toHaveAttribute('title',long)
  const narrow=(await label.boundingBox())!.width
  await label.hover()
  await expect.poll(async()=>(await label.boundingBox())!.width).toBeGreaterThan(narrow)
  const g=await graph()
  await call('POST',`/relations/${rel}/evidence/${ev}/review`,{review_status:'confirmed',expected_revision:g.facts[0].assertions[0].revision,expected_source_revision:g.sources[0].revision,review_note:'checked row 1'})
  await expect.poll(async()=>(await graph()).facts[0].truth_state).toBe('supported')
  await expect.poll(async()=>page.locator('.react-flow__edgeupdater').count()).toBe(0)
  await label.click()
  await expect(page.getByRole('complementary',{name:'Inspector'}).getByText('Ends locked')).toBeVisible()
})

test('trackpad: two-finger scroll pans, pinch zooms, mouse wheel still zooms',async({page,request})=>{
  const {call}=await setup(page,request)
  await call('POST','/entities',{name:'A',kind:'Device',x:0,y:0})
  await expect(page.locator('.entity-node')).toHaveCount(1)
  const viewport=()=>page.locator('.react-flow__viewport').evaluate(el=>{const m=new DOMMatrix(getComputedStyle(el).transform);return {x:m.e,y:m.f,zoom:m.a}})
  const wheel=(init:WheelEventInit)=>page.locator('.react-flow__pane').evaluate((el,init)=>{const r=el.getBoundingClientRect();el.dispatchEvent(new WheelEvent('wheel',{bubbles:true,cancelable:true,clientX:r.x+r.width/2,clientY:r.y+r.height/2,...init}))},init)
  const start=await viewport()
  for(let i=0;i<10;i++) await wheel({deltaX:3.5,deltaY:12.25,deltaMode:0})
  const panned=await viewport()
  expect(panned.zoom).toBeCloseTo(start.zoom,5)
  expect(start.y-panned.y).toBeGreaterThan(100)
  expect(start.x-panned.x).toBeGreaterThan(20)
  await page.waitForTimeout(400)
  for(let i=0;i<5;i++) await wheel({deltaY:-4.5,deltaMode:0,ctrlKey:true})
  const pinched=await viewport()
  expect(pinched.zoom).toBeGreaterThan(panned.zoom*1.3)
  await page.waitForTimeout(400)
  await page.mouse.move(700,500);await page.mouse.wheel(0,300)
  await expect.poll(async()=>(await viewport()).zoom).toBeLessThan(pinched.zoom)
})

test('groups keep their place: drag collapsed card, expand, drag the expanded frame',async({page,request})=>{
  const {call,graph}=await setup(page,request)
  const members=[] as string[]
  for(let i=0;i<3;i++) members.push((await call('POST','/entities',{name:`c2-node-${i}`,kind:'IP',x:0,y:i*100})).id)
  const group=(await call('POST','/groups',{name:'C2 infrastructure',members,collapsed:true})).id
  await page.getByRole('button',{name:'fit view'}).click()
  const card=page.locator('.group-node')
  await expect(card).toHaveCount(1)
  const centre=(list:any[])=>({x:list.reduce((s,e)=>s+e.position.x,0)/list.length,y:list.reduce((s,e)=>s+e.position.y,0)/list.length})
  const before=centre((await graph()).entities)
  const box=(await card.boundingBox())!
  await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down()
  await page.mouse.move(box.x+box.width/2+120,box.y+box.height/2+60,{steps:8});await page.mouse.up()
  await expect.poll(async()=>(await graph()).groups[0].position?.x??0).toBeGreaterThan(before.x+40)
  await page.locator('.group-node').click({button:'right'})
  await page.getByRole('button',{name:'Expand group'}).click()
  await expect(page.locator('.frame-node.group')).toHaveCount(1)
  const target=(await graph()).groups[0].position
  await expect.poll(async()=>Math.round(centre((await graph()).entities).x-target.x)).toBe(0)
  // Drag the expanded group by its header: all members move along.
  const expanded=centre((await graph()).entities)
  const head=(await page.locator('.frame-node.group .frame-head span').boundingBox())!
  await page.mouse.move(head.x+head.width/2,head.y+head.height/2);await page.mouse.down()
  await page.mouse.move(head.x+head.width/2+150,head.y+head.height/2,{steps:8});await page.mouse.up()
  await expect.poll(async()=>centre((await graph()).entities).x-expanded.x).toBeGreaterThan(60)
  const moved=(await graph()).entities.map((e:any)=>e.position.y-expanded.y)
  expect(new Set(moved.map((y:number)=>Math.round(y))).size).toBe(3)
  // Collapsing puts the card where the members are now.
  await page.locator('.frame-node.group .frame-head button').click()
  await expect.poll(async()=>Math.round((await graph()).groups[0].position.x-centre((await graph()).entities).x)).toBe(0)
  expect(group).toBeTruthy()
})

test('notifications: agent writes, several log files in a queue, remembered view after reload',async({page,request})=>{
  const {id,token,call,graph}=await setup(page,request)
  // An agent writes over MCP: the bell shows it and leads to the review.
  const a=(await call('POST','/entities',{name:'Build agent',kind:'Device',x:60,y:100})).id
  const b=(await mcp(token,'create_entity',{board_id:id,body:{name:'Secret store',kind:'Key Vault',x:550,y:100}})).id
  const relation=(await mcp(token,'create_relation',{board_id:id,body:{subject_id:a,object_id:b,predicate:'reads'}})).id
  await mcp(token,'add_evidence',{board_id:id,relation_id:relation,body:{stance:'supports',observation:'Read secret',locator:'row 1'}})
  const bell=page.getByRole('button',{name:'Notifications'})
  await expect(bell.locator('.notifications-badge')).toBeVisible()
  await bell.click()
  const panel=page.getByRole('dialog',{name:'Notifications'})
  // The agent's three MCP calls are one notice; the REST call is another client.
  const mcpNotice=panel.locator('.notice').filter({hasText:'Agent via MCP changed the board'})
  await expect(mcpNotice).toHaveCount(1)
  await expect(mcpNotice).toContainText('1 entity, 1 relationship, 1 new evidence item')
  await expect(panel.locator('.notice').filter({hasText:'Agent via REST changed the board'})).toHaveCount(1)
  await panel.getByRole('button',{name:'Review'}).first().click()
  await expect(page.getByRole('tab',{name:/Evidence review/})).toHaveAttribute('aria-selected','true')
  await page.getByRole('tab',{name:'Graph'}).click()
  // Two log files at once: previewed together, imported one after another, each with its own notification.
  await page.getByLabel('Board menu').click()
  await page.getByRole('button',{name:'Import logs / KQL',exact:true}).click()
  const dialog=page.getByRole('dialog',{name:'Import activity logs'})
  await dialog.getByLabel(/^Files/).setInputFiles([
    {name:'day1.csv',mimeType:'text/csv',buffer:Buffer.from('IPAddress,FilePath,TimeGenerated\n10.0.0.5,repo/.env,2026-09-28T10:00:00Z')},
    {name:'day2.csv',mimeType:'text/csv',buffer:Buffer.from('IPAddress,FilePath,TimeGenerated\n10.0.0.6,repo/secrets.yml,2026-09-29T10:00:00Z')},
  ])
  await dialog.getByRole('button',{name:'Preview import'}).click()
  await expect(dialog.getByText('2 of 2 files')).toBeVisible()
  await dialog.getByRole('button',{name:'Import 2 files'}).click()
  await expect(dialog).not.toBeVisible()
  await expect.poll(async()=> (await graph()).entities.length).toBe(6)
  await bell.click()
  await expect(panel.locator('.notice.done').filter({hasText:'Import day1.csv'})).toBeVisible()
  await expect(panel.locator('.notice.done').filter({hasText:'Import day2.csv'})).toBeVisible()
  // Own imports are not reported a second time as someone else's change.
  await expect(panel.locator('.notice').filter({hasText:'Import changed the board'})).toHaveCount(0)
  await page.keyboard.press('Escape')
  // The evidence window and the status filter survive a reload; the notifications too.
  await page.getByRole('button',{name:'Evidence window',exact:true}).click()
  await page.locator('.status-filter button.unknown').click()
  await page.reload()
  await expect(page.getByText('1 online',{exact:true})).toBeVisible()
  await expect(page.locator('.status-filter button.unknown')).toHaveClass(/active/)
  await expect(page.getByRole('button',{name:'Evidence window',exact:true})).toHaveAttribute('aria-pressed','true')
  await page.getByRole('button',{name:'Notifications'}).click()
  await expect(page.getByRole('dialog',{name:'Notifications'}).getByText('Import day2.csv')).toBeVisible()
})

test('drop: Defender XDR and Sentinel exports are recognised, mapped and joined by their IDs; unknown tables open the mapping',async({page,request})=>{
  const {graph}=await setup(page,request)
  const network=['Timestamp,DeviceId,DeviceName,ActionType,RemoteIP,RemotePort,RemoteUrl,LocalIP,Protocol,InitiatingProcessFileName,InitiatingProcessSHA1,InitiatingProcessAccountUpn,InitiatingProcessAccountObjectId,ReportId',
    '2026-09-28T10:42:07.1234567Z,a1b2c3,WS-0142.corp.example,ConnectionSuccess,203.0.113.7,443,evil.example,10.0.0.5,Tcp,powershell.exe,'+'ab'.repeat(20)+',J.Doe@corp.example,11111111-2222-3333-4444-555555555555,18842',
    '2026-09-28T10:43:07Z,a1b2c3,WS-0142.corp.example,ConnectionSuccess,203.0.113.7,443,evil.example,10.0.0.5,Tcp,powershell.exe,'+'ab'.repeat(20)+',J.Doe@corp.example,11111111-2222-3333-4444-555555555555,18843'].join('\n')
  const signins=['"TimeGenerated [UTC]",UserPrincipalName,UserId,AppDisplayName,AppId,IPAddress,ResultType,ConditionalAccessStatus,CorrelationId,DeviceDetail',
    '"9/28/2026, 10:40:01.512 AM",j.doe@corp.example,11111111-2222-3333-4444-555555555555,Azure Portal,c44b4083-3bb0-49c1-b47d-974e53cbdf3c,203.0.113.7,0,success,corr-1,"{""deviceId"":""dev-1"",""displayName"":""WS-0142""}"'].join('\n')
  const drop=async(files:{name:string,text:string}[])=>{
    const transfer=await page.evaluateHandle(files=>{const dt=new DataTransfer();for(const f of files) dt.items.add(new File([f.text],f.name,{type:'text/csv'}));return dt},files)
    const target=page.locator('.workspace')
    await target.dispatchEvent('dragenter',{dataTransfer:transfer})
    await expect(page.locator('.drop-overlay')).toBeVisible()
    await target.dispatchEvent('dragover',{dataTransfer:transfer})
    await target.dispatchEvent('drop',{dataTransfer:transfer})
    await expect(page.locator('.drop-overlay')).toHaveCount(0)
  }
  await drop([{name:'DeviceNetworkEvents.csv',text:network},{name:'SigninLogs.csv',text:signins}])
  // Both files: XDR first (queue), then Sentinel; the user from both is one entity (Entra object ID), so is the IP.
  await expect.poll(async()=>(await graph()).facts.length,{timeout:15000}).toBe(2)
  const board=await graph()
  const users=board.entities.filter((e:any)=>e.kind==='User')
  expect(users.map((e:any)=>e.name)).toEqual(['j.doe@corp.example'])
  expect(board.entities.filter((e:any)=>e.name==='203.0.113.7')).toHaveLength(1)
  const device=board.entities.find((e:any)=>e.name==='ws-0142.corp.example')
  expect(device.identifiers.map((i:any)=>i.namespace||i.scheme)).toEqual(expect.arrayContaining(['mde-device-id','fqdn']))
  const net=board.facts.find((f:any)=>f.predicate==='connection success')
  expect(net.participants.map((p:any)=>p.role).sort()).toEqual(['actor','source','target','target','via'])
  expect(net.assertions).toHaveLength(2)
  expect(net.assertions[0].locator).toMatch(/^DeviceNetworkEvents ReportId=1884\d DeviceId=a1b2c3$/)
  const signin=board.facts.find((f:any)=>f.predicate==='signed in')
  expect(signin.assertions[0].valid_from).toBe('2026-09-28T10:40:01.512000Z')
  await page.getByRole('button',{name:'Notifications'}).click()
  await expect(page.getByRole('dialog',{name:'Notifications'}).locator('.notice.done').filter({hasText:'DeviceNetworkEvents (Defender XDR)'})).toBeVisible()
  await expect(page.getByRole('dialog',{name:'Notifications'}).locator('.notice.done').filter({hasText:'SigninLogs (Sentinel)'})).toBeVisible()
  await page.keyboard.press('Escape')
  // An unknown export: no automatic import, the mapping dialog opens with the columns it could guess.
  await drop([{name:'proxy.csv',text:'when,ClientIP,UserPrincipalName,Operation,Workload\n2026-09-28T10:00:00Z,198.51.100.9,eve@corp.example,FileDownloaded,SharePoint'}])
  const dialog=page.getByRole('dialog',{name:'Import activity logs'})
  await expect(dialog).toBeVisible()
  await expect(dialog.getByLabel('Column 1')).toHaveValue('UserPrincipalName')
  await expect(dialog.getByLabel('Column 2')).toHaveValue('ClientIP')
  await dialog.getByRole('button',{name:'Add column'}).click()
  await dialog.getByLabel('Column 3').fill('Workload')
  await dialog.getByLabel('Role 3').selectOption('target')
  await dialog.getByLabel('Type 3').fill('Service')
  await dialog.getByRole('button',{name:'Preview import'}).click()
  await dialog.getByRole('button',{name:'Apply import'}).click()
  await expect.poll(async()=>(await graph()).facts.some((f:any)=>f.predicate==='FileDownloaded'),{timeout:15000}).toBe(true)
})
