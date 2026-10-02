// Generates the screenshots in docs/images for the README. Not part of the regular test run:
//   DOCS_SCREENSHOTS=1 npx playwright test e2e/docs-screenshots.spec.ts
import {test, expect, type Page, type APIRequestContext} from '@playwright/test'
import {randomUUID} from 'node:crypto'

const base='http://127.0.0.1:18088'
const out='../docs/images'
test.skip(!process.env.DOCS_SCREENSHOTS,'Set DOCS_SCREENSHOTS=1 to regenerate the README screenshots')
test.use({viewport:{width:1440,height:860},deviceScaleFactor:2})

async function open(page:Page,request:APIRequestContext) {
  const id=randomUUID();await page.goto(`/boards/${id}`)
  await expect(page.getByText('1 online',{exact:true})).toBeVisible()
  const token=await page.evaluate(id=>sessionStorage.getItem(`factgraph:sessionToken:${id}`)!,id)
  const call=async(method:string,path:string,body?:object)=>{
    const result=await request.fetch(`${base}/api/boards/${id}${path}`,{method,data:body,headers:{'X-FactGraph-Token':token}})
    expect(result.ok(),await result.text()).toBeTruthy();return result.json()
  }
  return {id,call}
}

/** A cloud intrusion reconstructed from four sources that do not reference each other. */
async function seed(call:(m:string,p:string,b?:object)=>Promise<any>) {
  await call('PATCH','',{name:'IR-2026-031 · kv-prod secret theft'})
  const entity=async(name:string,kind:string,x:number,y:number,extra:object={})=>(await call('POST','/entities',{name,kind,x,y,...extra})).id
  const edr=(await call('POST','/sources',{title:'Defender for Endpoint · DeviceProcessEvents',source_kind:'primary',uri:'mde://DeviceProcessEvents/WS-0142',
    query:'DeviceProcessEvents | where DeviceName == "ws-0142" and InitiatingProcessFileName == "outlook.exe"',
    excerpt:'[{"Timestamp":"2026-09-28T09:58:12Z","DeviceName":"ws-0142","FileName":"powershell.exe","ProcessCommandLine":"powershell -enc JAB3AGMA...","AccountName":"j.doe","ReportId":"18842"}]'})).id
  const net=(await call('POST','/sources',{title:'Defender for Endpoint · DeviceNetworkEvents',source_kind:'primary',uri:'mde://DeviceNetworkEvents/WS-0142',
    query:'DeviceNetworkEvents | where DeviceName == "ws-0142" and RemoteIP == "203.0.113.7"',
    excerpt:'[{"Timestamp":"2026-09-28T10:05:41Z","RemoteIP":"203.0.113.7","RemotePort":443,"InitiatingProcessFileName":"powershell.exe","ReportId":"18911"}]'})).id
  const signin=(await call('POST','/sources',{title:'Entra ID · AADServicePrincipalSignInLogs',source_kind:'primary',uri:'log-analytics://AADServicePrincipalSignInLogs',
    query:'AADServicePrincipalSignInLogs | where IPAddress == "203.0.113.7"',
    excerpt:'[{"TimeGenerated":"2026-09-28T10:31:02Z","ServicePrincipalName":"sp-deploy-prod","IPAddress":"203.0.113.7","ResultType":"0","CorrelationId":"c41e"}]'})).id
  const kv=(await call('POST','/sources',{title:'Key Vault · AuditEvent',source_kind:'primary',uri:'log-analytics://kv-prod-secrets/AuditEvent',
    query:'AzureDiagnostics | where ResourceType == "VAULTS" and CallerIPAddress == "203.0.113.7"',
    excerpt:'[{"TimeGenerated":"2026-09-28T10:42:07Z","OperationName":"SecretList","CallerIPAddress":"203.0.113.7","identity_claim_appid_g":"sp-deploy-prod","CorrelationId":"7f3a"},{"TimeGenerated":"2026-09-28T10:44:19Z","OperationName":"SecretGet","id_s":"github-deploy-token","CorrelationId":"7f41"}]'})).id
  const gh=(await call('POST','/sources',{title:'GitHub · audit log export',source_kind:'primary',uri:'github://acme/audit-log/2026-09-28.json',
    excerpt:'[{"@timestamp":"2026-09-28T10:51:00Z","action":"git.clone","actor":"deploy-bot","repo":"acme/payments-api"},{"@timestamp":"2026-09-28T10:58:30Z","action":"workflows.created_workflow_run","repo":"acme/payments-api"}]'})).id
  const intel=(await call('POST','/sources',{title:'Threat intel note',source_kind:'secondary',uri:'notes/intel.md',excerpt:'203.0.113.7 seen in earlier campaign infrastructure.'})).id

  const user=await entity('j.doe','User',0,0)
  const ws=await entity('WS-0142','Device',330,0)
  const ps=await entity('powershell.exe','Process',660,0)
  const ip=await entity('203.0.113.7','IP',660,190,{color:'#ef4444'})
  const actor=await entity('Unknown actor','Threat Actor',240,300,{color:'#ef4444'})
  const sp=await entity('sp-deploy-prod','Service Principal',1020,190)
  const vault=await entity('kv-prod-secrets','Key Vault',1020,400)
  const secret=await entity('github-deploy-token','Secret',1380,300)
  const payments=await entity('acme/payments-api','Repository',1740,200)
  const repos=[] as string[]
  for(let i=0;i<38;i++) repos.push(await entity(`acme/service-${String(i+1).padStart(2,'0')}`,'Repository',1740,400+i*6))

  const relation=async(subject_id:string,predicate:string,object_id:string,evidence?:object)=>{
    const id=(await call('POST','/relations',{subject_id,predicate,object_id})).id
    if(evidence) await call('POST',`/relations/${id}/evidence`,{stance:'supports',...evidence})
    return id
  }
  await relation(user,'signed in to',ws)
  await relation(ws,'runs',ps,{source_id:edr,observation:'outlook.exe spawned encoded PowerShell as j.doe',locator:'ReportId=18842',valid_from:'2026-09-28T09:58:12Z'})
  await relation(ps,'connected to',ip,{source_id:net,observation:'HTTPS beacon to 203.0.113.7:443',locator:'ReportId=18911',valid_from:'2026-09-28T10:05:41Z'})
  await relation(actor,'controls',ip,{source_id:intel,observation:'IP listed as campaign infrastructure',locator:'intel.md line 3',confidence:0.6})
  await relation(sp,'signed in from',ip,{source_id:signin,observation:'Successful service principal sign-in from 203.0.113.7',locator:'CorrelationId=c41e',valid_from:'2026-09-28T10:31:02Z'})
  const listing=(await call('POST','/activities',{operation:'listed secrets',technique:'T1555.006',valid_from:'2026-09-28T10:42:07Z',
    participants:[{entity_id:actor,role:'actor'},{entity_id:ip,role:'source'},{entity_id:sp,role:'identity'},{entity_id:vault,role:'target'}],
    source_id:kv,observation:'SecretList on kv-prod-secrets from 203.0.113.7 as sp-deploy-prod',locator:'CorrelationId=7f3a'})).id
  await relation(sp,'read',secret,{source_id:kv,observation:'SecretGet github-deploy-token',locator:'CorrelationId=7f41',valid_from:'2026-09-28T10:44:19Z'})
  await relation(vault,'stores',secret)
  const pushed=await relation(secret,'pushed workflow to',payments,{source_id:gh,observation:'New workflow run in acme/payments-api by deploy-bot',locator:'audit line 2',valid_from:'2026-09-28T10:58:30Z'})
  await relation(secret,'cloned',payments,{source_id:gh,observation:'git.clone by deploy-bot',locator:'audit line 1',valid_from:'2026-09-28T10:51:00Z'})
  for(const repo of repos) await relation(secret,'cloned',repo)
  const group=(await call('POST','/groups',{name:'acme repositories',rule:{kinds:['Repository']},excluded:[payments],collapsed:true})).id
  await call('POST','/actions',{actions:[{type:'fact.position',payload:{id:listing,x:690,y:420}},{type:'group.update',payload:{id:group,x:1740,y:420}}]})

  // Confirm the endpoint and sign-in evidence; the rest stays open for review.
  const graph=await call('GET','/graph')
  for(const fact of graph.facts) for(const evidence of fact.assertions) {
    const source=graph.sources.find((s:any)=>s.id===evidence.source_id)
    if(![edr,net,signin].includes(source?.id)) continue
    await call('POST',`/relations/${fact.id}/evidence/${evidence.id}/review`,{review_status:'confirmed',expected_revision:evidence.revision,expected_source_revision:source.revision,review_note:'Checked against the original event'})
  }
  return {pushed,payments,vault}
}

async function shot(page:Page,name:string) { await page.waitForTimeout(500);await page.screenshot({path:`${out}/${name}.png`}) }
const fit=async(page:Page)=>{await page.getByRole('button',{name:'fit view'}).click();await page.waitForTimeout(600)}

test('README screenshots',async({page,browser,request})=>{
  test.setTimeout(180_000)
  const {id,call}=await open(page,request)
  const peer=await (await browser.newContext({storageState:{cookies:[],origins:[{origin:base,localStorage:[{name:'factgraph:displayName',value:'Sam Rivera'}]}]}})).newPage()
  await peer.goto(`/boards/${id}`)
  const {pushed}=await seed(call)
  await expect(page.getByText('2 online',{exact:true})).toBeVisible()
  await page.getByRole('button',{name:'Hide explorer'}).first().click()
  await fit(page)
  await shot(page,'graph-overview')

  // Activity with role-tagged participants in the inspector.
  await page.locator('.activity-node').click()
  await page.keyboard.press('f');await page.waitForTimeout(700)
  await shot(page,'activity-inspector')
  await page.keyboard.press('Escape')

  // Evidence review and the evidence reader.
  await page.getByRole('tab',{name:/Evidence review/}).click()
  await shot(page,'evidence-review')
  await page.locator('.review-queue-item').filter({hasText:'pushed workflow'}).click()
  await expect(page.getByRole('dialog',{name:'Evidence reader'})).toBeVisible()
  await shot(page,'evidence-reader')
  await page.keyboard.press('Escape')

  await page.getByRole('tab',{name:/Timeline/}).click()
  await shot(page,'timeline')

  await page.getByRole('tab',{name:/Graph/}).click()

  await page.getByRole('button',{name:'API and MCP'}).click()
  await page.getByRole('menuitem',{name:/Connect an agent/}).or(page.getByRole('button',{name:/Connect an agent/})).first().click()
  // Show the default port of a normal installation instead of the test server's.
  await page.evaluate(()=>{const walk=document.createTreeWalker(document.querySelector('[aria-label="Connect an agent"]')!,NodeFilter.SHOW_TEXT);for(let n=walk.nextNode();n;n=walk.nextNode()) n.textContent=n.textContent!.replaceAll(':18088',':8080')})
  await shot(page,'connect-agent')
  await page.keyboard.press('Escape')

  await page.getByRole('button',{name:'Dark theme'}).click()
  await fit(page)
  await shot(page,'graph-dark')
  expect(pushed).toBeTruthy()
})
