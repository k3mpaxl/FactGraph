import { useState } from 'react'
import { CheckCircle2, Copy, FileText, ShieldQuestion, X } from 'lucide-react'
import type { Assertion, GraphData, Source } from './types'
import type { ActionDraft, BoardAction } from './board'
import { periodLabel } from './timeline'
import { uuid } from './uuid'

function RawEvidence({text}: {text:string}) {
  const [page,setPage]=useState(0)
  const [query,setQuery]=useState('')
  let rows:Record<string,unknown>[]=[]
  try {const value=JSON.parse(text);rows=Array.isArray(value)?value: typeof value==='object' && value ?[value]:[]}catch{/* plain excerpt */}
  if(!rows.length) return <pre className="raw-evidence">{text || 'No original excerpt or results attached.'}</pre>
  const columns=[...new Set(rows.flatMap(row=>Object.keys(row)))].slice(0,30)
  const matching=rows.filter(row=>JSON.stringify(row).toLowerCase().includes(query.toLowerCase()))
  return <div className="evidence-table"><input aria-label="Search evidence rows" placeholder="Search original results…" value={query} onChange={e=>{setQuery(e.target.value);setPage(0)}}/><div><table><thead><tr>{columns.map(k=><th key={k}>{k}</th>)}</tr></thead><tbody>{matching.slice(page*50,(page+1)*50).map((row,i)=><tr key={i}>{columns.map(k=><td key={k}>{typeof row[k]==='object'?JSON.stringify(row[k]):String(row[k]??'')}</td>)}</tr>)}</tbody></table></div><footer><button disabled={page===0} onClick={()=>setPage(page-1)}>Previous</button><span>{matching.length} rows · page {page+1}</span><button disabled={(page+1)*50>=matching.length} onClick={()=>setPage(page+1)}>Next</button></footer></div>
}
export function EvidenceQueue({data,onOpen}: {data:GraphData;onOpen:(id:string)=>void}) {
  const [filter,setFilter]=useState('unconfirmed')
  const [page,setPage]=useState(0)
  const items=data.facts.flatMap(f=>f.assertions.map(a=>({f,a}))).filter(({a})=>filter==='all'||filter==='retracted'?filter==='all'||!!a.retracted_at:!a.retracted_at&&(a.review_status??'unconfirmed')===filter)
  const name=(id:string)=>data.entities.find(e=>e.id===id)?.name??id
  return <section className="review-queue"><header><div><h2>Evidence review</h2><p>Check the observation against its original source before confirming.</p></div><select aria-label="Review filter" value={filter} onChange={e=>{setFilter(e.target.value);setPage(0)}}><option value="unconfirmed">Unconfirmed</option><option value="confirmed">Confirmed</option><option value="retracted">Retracted</option><option value="all">All evidence</option></select></header>
    {items.slice(page*50,(page+1)*50).map(({f,a})=><button className="review-queue-item" key={a.id} onClick={()=>onOpen(a.id)}><span className={`review-badge ${a.review_status??'unconfirmed'}`}>{a.retracted_at?'Retracted':a.review_status??'unconfirmed'}</span><strong>{name(f.subject_id)} <em>{f.predicate}</em> {name(f.object_id)}</strong><p>{a.observation||a.note||'Observation still needed'}</p><small>{a.stance} · {periodLabel(a.valid_from,a.valid_to)} · {data.sources.find(s=>s.id===a.source_id)?.title??'Source missing'}</small></button>)}
    {!items.length&&<p className="empty-review">No evidence in this view.</p>}
    {items.length>50&&<footer><button disabled={!page} onClick={()=>setPage(page-1)}>Previous</button><span> {items.length} evidence items · page {page+1} </span><button disabled={(page+1)*50>=items.length} onClick={()=>setPage(page+1)}>Next</button></footer>}
  </section>
}
export default function EvidenceReader({data,evidenceId,actions,onCommand,onClose}: {
  data:GraphData;evidenceId:string;actions:BoardAction[];onCommand:(items:ActionDraft[])=>Promise<unknown>;onClose:()=>void;
}) {
  const fact=data.facts.find(f=>f.assertions.some(a=>a.id===evidenceId))
  const evidence=fact?.assertions.find(a=>a.id===evidenceId)
  if(!fact||!evidence)return null
  return <Reader key={evidence.id} data={data} evidence={evidence} actions={actions} onCommand={onCommand} onClose={onClose}/>
}
function Reader({data,evidence,actions,onCommand,onClose}: {data:GraphData;evidence:Assertion;actions:BoardAction[];onCommand:(items:ActionDraft[])=>Promise<unknown>;onClose:()=>void}) {
  const fact=data.facts.find(f=>f.id===evidence.fact_id)!
  const originalSource=data.sources.find(s=>s.id===evidence.source_id)
  const [edit,setEdit]=useState({...evidence})
  const [sourceRevision,setSourceRevision]=useState(originalSource?.revision)
  const [source,setSource]=useState<Partial<Source>>(originalSource??{title:'',uri:'',excerpt:'',query:'',source_kind:'unknown'})
  const [sourceEditing,setSourceEditing]=useState(false)
  const [editing,setEditing]=useState(false)
  const [reviewNote,setReviewNote]=useState('')
  const [error,setError]=useState('')
  const [busy,setBusy]=useState(false)
  const [wide,setWide]=useState(false)
  const name=(id:string)=>data.entities.find(e=>e.id===id)?.name??id
  const submit=async(items:ActionDraft[])=>{setError('');setBusy(true);try{await onCommand(items);setEditing(false);setSourceEditing(false)}catch(e){setError(String(e))}finally{setBusy(false)}}
  const review=(status:'confirmed'|'unconfirmed')=>void submit([{type:'assertion.review',payload:{id:evidence.id,review_status:status,review_note:reviewNote,expected_revision:evidence.revision,expected_source_revision:originalSource?.revision}}])
  const saveSource=()=>{
    const id=originalSource?.id??uuid()
    void submit([{type:originalSource?'source.update':'source.add',payload:{id,...(originalSource?{expected_revision:sourceRevision}:{}),title:source.title??'',uri:source.uri??'',excerpt:source.excerpt??'',query:source.query??'',source_kind:source.source_kind??'unknown'}},...(!originalSource?[{type:'assertion.update' as const,payload:{id:evidence.id,source_id:id}}]:[])])
  }
  const history=actions.filter(a=>a.payload.id===evidence.id||a.payload.id===evidence.source_id||a.payload.id===fact.id)
  const isoInput=(value:string|null)=>value?new Date(value).toISOString().slice(0,19):''
  const dirty=editing||sourceEditing
  return <div className="evidence-backdrop"><section className={`evidence-reader ${wide?'wide':''}`} role="dialog" aria-modal="true" aria-label="Evidence reader">
    <header><div><small>INVESTIGATION / EVIDENCE</small><h2>{name(fact.subject_id)} <em>{fact.predicate}</em> {name(fact.object_id)}</h2></div><button onClick={()=>setWide(!wide)}>{wide?'Narrow':'Expand'}</button><button aria-label="Close evidence reader" onClick={onClose}><X size={20}/></button></header>
    <div className="evidence-reader-body"><main>
      <div className="evidence-summary"><span className={`review-badge ${evidence.review_status??'unconfirmed'}`}>{evidence.review_status==='confirmed'?<CheckCircle2 size={14}/>:<ShieldQuestion size={14}/>} {evidence.retracted_at?'Retracted':evidence.review_status??'Unconfirmed'}</span><span>{evidence.stance==='supports'?'Supports claim':'Refutes claim'}</span><span>{periodLabel(evidence.valid_from,evidence.valid_to)}</span></div>
      <section><div className="reader-section-title"><h3>Observation</h3><button onClick={()=>{setEdit({...evidence});setEditing(!editing)}}>{editing?'Cancel edit':'Edit evidence'}</button></div>
      {editing?<form onSubmit={e=>{e.preventDefault();void submit([{type:'assertion.update',payload:{id:evidence.id,expected_revision:edit.revision,observation:edit.observation??'',note:edit.note,locator:edit.locator??'',interpretation:edit.interpretation??'',stance:edit.stance,valid_from:edit.valid_from,valid_to:edit.valid_to,source_id:edit.source_id}}])}}>
        <label>What does the original record show?<textarea required value={edit.observation||edit.note} onChange={e=>setEdit({...edit,observation:e.target.value,note:e.target.value})}/></label>
        <label>Specific locator / event ID / file line<input value={edit.locator??''} onChange={e=>setEdit({...edit,locator:e.target.value})}/></label>
        <label>Interpretation and limitations<textarea value={edit.interpretation??''} onChange={e=>setEdit({...edit,interpretation:e.target.value})}/></label>
        <div className="field-grid"><label>Stance<select value={edit.stance} onChange={e=>setEdit({...edit,stance:e.target.value as Assertion['stance']})}><option value="supports">Supports</option><option value="refutes">Refutes</option></select></label><label>Source<select value={edit.source_id??''} onChange={e=>setEdit({...edit,source_id:e.target.value||null})}><option value="">No source</option>{data.sources.map(s=><option key={s.id} value={s.id}>{s.title}</option>)}</select></label></div>
        <div className="field-grid">{(['valid_from','valid_to'] as const).map(field=><label key={field}>{field==='valid_from'?'Activity from (UTC)':'Activity to (UTC)'}<input type="datetime-local" step="1" value={isoInput(edit[field])} onChange={e=>setEdit({...edit,[field]:e.target.value?new Date(e.target.value+'Z').toISOString():null})}/></label>)}</div>
        <p className="muted">Content changes require a fresh review.</p><button className="primary-button" disabled={busy}>Save evidence</button>
      </form>:<><p className="observation-text">{evidence.observation||evidence.note||'No observation recorded yet.'}</p><div className="evidence-locator"><strong>Locator</strong><code>{evidence.locator||'Missing — add the event ID, result row or file line.'}</code></div>{evidence.interpretation&&<><h4>Interpretation / limitations</h4><p>{evidence.interpretation}</p></>}</>}
      </section>
      <section><div className="reader-section-title"><h3><FileText size={17}/> Primary source & original results</h3><button onClick={()=>{setSource(originalSource??{title:'',uri:'',excerpt:'',query:'',source_kind:'unknown'});setSourceRevision(originalSource?.revision);setSourceEditing(!sourceEditing)}}>{sourceEditing?'Cancel edit':originalSource?'Edit source':'Attach source'}</button></div>
      {sourceEditing?<form onSubmit={e=>{e.preventDefault();saveSource()}}><label>Source title<input required value={source.title??''} onChange={e=>setSource({...source,title:e.target.value})}/></label><label>Source classification<select value={source.source_kind??'unknown'} onChange={e=>setSource({...source,source_kind:e.target.value as Source['source_kind']})}><option value="unknown">Unclassified</option><option value="primary">Primary: original logs, telemetry, file</option><option value="secondary">Secondary: context only</option></select></label><label>Reference / repository path and commit<input value={source.uri??''} onChange={e=>setSource({...source,uri:e.target.value})}/></label><label>KQL query<textarea value={source.query??''} onChange={e=>setSource({...source,query:e.target.value})}/></label><label>Original excerpt / result rows (JSON or text)<textarea className="raw-input" value={source.excerpt??''} onChange={e=>setSource({...source,excerpt:e.target.value})}/></label><p className="muted">Editing a source resets all dependent evidence reviews.</p><button className="primary-button" disabled={busy}>Save source</button></form>:<><p><strong>{originalSource?.title??'Source missing'}</strong> · {originalSource?.source_kind??'unclassified'}</p><code className="source-reference">{originalSource?.uri}</code>{originalSource?.query&&<details open><summary>KQL query</summary><pre className="raw-evidence">{originalSource.query}</pre></details>}<RawEvidence text={originalSource?.excerpt??''}/></>}
      </section>
    </main><aside><h3>Review this evidence</h3><p>Confirm the observation against the primary record. A query by itself is not proof.</p><label>What did you verify?<textarea aria-label="Review note" value={reviewNote} onChange={e=>setReviewNote(e.target.value)} placeholder="Checked event ID, actor, target and timestamp against original results…"/></label>
      <button className="primary-button" disabled={busy||dirty||!!evidence.retracted_at} onClick={()=>review('confirmed')}><CheckCircle2 size={16}/> Confirm evidence</button>
      <button disabled={busy||dirty} onClick={()=>review('unconfirmed')}>Mark unconfirmed</button>
      {dirty&&<p>Save or cancel edits before reviewing.</p>}
      {evidence.reviewed_at&&<p>Reviewed {evidence.reviewed_at}<br/>Session {evidence.reviewed_by}<br/>{evidence.review_note}</p>}
      <button disabled={busy||dirty} onClick={()=>void submit([{type:evidence.retracted_at?'assertion.restore':'assertion.retract',payload:{id:evidence.id}}])}>{evidence.retracted_at?'Restore as unconfirmed':'Retract evidence'}</button>
      <button onClick={()=>void navigator.clipboard.writeText(evidence.id)}><Copy size={14}/> Copy evidence ID</button>
      <button onClick={()=>void navigator.clipboard.writeText(JSON.stringify({relation:fact,evidence,source:originalSource},null,2))}>Copy context for agent</button>
      <details><summary>Change history ({history.length})</summary>{history.slice().reverse().map(a=><div className="review-history" key={a.id}><strong>{a.type}</strong><small>{a.channel??a.author} · {a.at}</small></div>)}</details>
      {error&&<div role="alert" className="form-error">{error}</div>}
    </aside></div>
  </section></div>
}
