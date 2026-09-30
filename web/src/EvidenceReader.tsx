import { useState } from 'react'
import { CheckCircle2, CircleDashed, Copy, FileText, Maximize2, Minimize2, Search, ShieldCheck, X } from 'lucide-react'
import type { Assertion, GraphData, Source } from './types'
import type { ActionDraft, BoardAction } from './board'
import { periodLabel } from './timeline'
import { uuid } from './uuid'

function RawEvidence({ text }: { text: string }) {
  const [page, setPage] = useState(0)
  const [query, setQuery] = useState('')
  let rows: Record<string, unknown>[] = []
  try { const value = JSON.parse(text); rows = Array.isArray(value) ? value : typeof value === 'object' && value ? [value] : [] } catch { /* plain excerpt */ }
  if (!rows.length) return <pre className="raw-evidence">{text || 'No original excerpt or results attached.'}</pre>
  const columns = [...new Set(rows.flatMap(row => Object.keys(row)))].slice(0, 30)
  const matching = rows.filter(row => JSON.stringify(row).toLowerCase().includes(query.toLowerCase()))
  return <div className="evidence-table">
    <label className="input-with-icon"><Search size={14} /><input aria-label="Search evidence rows" placeholder="Search original results…" value={query} onChange={e => { setQuery(e.target.value); setPage(0) }} /></label>
    <div className="table-scroll"><table><thead><tr>{columns.map(k => <th key={k}>{k}</th>)}</tr></thead><tbody>{matching.slice(page * 50, (page + 1) * 50).map((row, i) => <tr key={i}>{columns.map(k => <td key={k}>{typeof row[k] === 'object' ? JSON.stringify(row[k]) : String(row[k] ?? '')}</td>)}</tr>)}</tbody></table></div>
    <footer><button className="secondary-button small" disabled={page === 0} onClick={() => setPage(page - 1)}>Previous</button><span>{matching.length} rows · page {page + 1}</span><button className="secondary-button small" disabled={(page + 1) * 50 >= matching.length} onClick={() => setPage(page + 1)}>Next</button></footer>
  </div>
}

/** Relationship: "A verb B"; activity: "verb · actor, identity, source → target" with every participant. */
function claimLabel(fact: GraphData['facts'][number], name: (id: string) => string) {
  if (!fact.participants?.length) return <>{name(fact.subject_id)} <em>{fact.predicate}</em> {name(fact.object_id)}</>
  const targets = fact.participants.filter(p => p.role === 'target'), others = fact.participants.filter(p => p.role !== 'target')
  return <><em>{fact.predicate}</em> · {others.map(p => name(p.entity_id)).join(', ')}{targets.length ? <> → {targets.map(p => name(p.entity_id)).join(', ')}</> : null}</>
}

type QueueFilter = 'unconfirmed' | 'confirmed' | 'retracted' | 'all'
export function EvidenceQueue({ data, onOpen }: { data: GraphData; onOpen: (id: string) => void }) {
  const [filter, setFilter] = useState<QueueFilter>('unconfirmed')
  const [page, setPage] = useState(0)
  const all = data.facts.flatMap(f => f.assertions.map(a => ({ f, a })))
  const matches = (a: Assertion, value: QueueFilter) => value === 'all' || (value === 'retracted' ? !!a.retracted_at : !a.retracted_at && (a.review_status ?? 'unconfirmed') === value)
  const items = all.filter(({ a }) => matches(a, filter))
  const name = (id: string) => data.entities.find(e => e.id === id)?.name ?? id
  const claim = (f: GraphData['facts'][number]) => claimLabel(f, name)
  const filters: [QueueFilter, string][] = [['unconfirmed', 'Unconfirmed'], ['confirmed', 'Confirmed'], ['retracted', 'Retracted'], ['all', 'All']]
  return <section className="view-page review-queue">
    <header className="view-header"><div><h2>Evidence review</h2><p>Check each observation against its original source before confirming.</p></div>
      <div className="segmented" role="group" aria-label="Review filter">{filters.map(([value, label]) => <button key={value} className={filter === value ? 'active' : ''} aria-pressed={filter === value} onClick={() => { setFilter(value); setPage(0) }}>{label} <b>{all.filter(({ a }) => matches(a, value)).length}</b></button>)}</div></header>
    <div className="review-list">
      {items.slice(page * 50, (page + 1) * 50).map(({ f, a }) => {
        const status = a.retracted_at ? 'retracted' : a.review_status ?? 'unconfirmed'
        return <button className="review-queue-item" key={a.id} onClick={() => onOpen(a.id)}>
          <span className={`review-badge ${status}`}>{status === 'confirmed' ? <CheckCircle2 size={12} /> : <CircleDashed size={12} />}{status}</span>
          <span className="review-body"><strong>{claim(f)}</strong>
            <span className="review-observation">{a.observation || a.note || 'Observation still needed'}</span>
            <small><span className={`stance ${a.stance}`}>{a.stance === 'supports' ? 'Supports' : 'Refutes'}</span> · {periodLabel(a.valid_from, a.valid_to)} · {data.sources.find(s => s.id === a.source_id)?.title ?? 'Source missing'}</small></span>
        </button>
      })}
      {!items.length && <div className="view-empty"><ShieldCheck size={22} /><p>No evidence in this view.</p></div>}
    </div>
    {items.length > 50 && <footer className="pager"><button className="secondary-button small" disabled={!page} onClick={() => setPage(page - 1)}>Previous</button><span>{items.length} items · page {page + 1}</span><button className="secondary-button small" disabled={(page + 1) * 50 >= items.length} onClick={() => setPage(page + 1)}>Next</button></footer>}
  </section>
}

export default function EvidenceReader({ data, evidenceId, actions, onCommand, onClose, onCopy }: {
  data: GraphData; evidenceId: string; actions: BoardAction[]; onCommand: (items: ActionDraft[]) => Promise<unknown>; onClose: () => void; onCopy: (value: string, label: string) => void;
}) {
  const fact = data.facts.find(f => f.assertions.some(a => a.id === evidenceId))
  const evidence = fact?.assertions.find(a => a.id === evidenceId)
  if (!fact || !evidence) return null
  return <Reader key={evidence.id} data={data} evidence={evidence} actions={actions} onCommand={onCommand} onClose={onClose} onCopy={onCopy} />
}
function Reader({ data, evidence, actions, onCommand, onClose, onCopy }: { data: GraphData; evidence: Assertion; actions: BoardAction[]; onCommand: (items: ActionDraft[]) => Promise<unknown>; onClose: () => void; onCopy: (value: string, label: string) => void }) {
  const fact = data.facts.find(f => f.id === evidence.fact_id)!
  const originalSource = data.sources.find(s => s.id === evidence.source_id)
  const [edit, setEdit] = useState({ ...evidence })
  const [sourceRevision, setSourceRevision] = useState(originalSource?.revision)
  const [source, setSource] = useState<Partial<Source>>(originalSource ?? { title: '', uri: '', excerpt: '', query: '', source_kind: 'unknown' })
  const [sourceEditing, setSourceEditing] = useState(false)
  const [editing, setEditing] = useState(false)
  const [reviewNote, setReviewNote] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [wide, setWide] = useState(false)
  const name = (id: string) => data.entities.find(e => e.id === id)?.name ?? id
  const submit = async (items: ActionDraft[]) => { setError(''); setBusy(true); try { await onCommand(items); setEditing(false); setSourceEditing(false) } catch (e) { setError(String(e)) } finally { setBusy(false) } }
  const review = (status: 'confirmed' | 'unconfirmed') => void submit([{ type: 'assertion.review', payload: { id: evidence.id, review_status: status, review_note: reviewNote, expected_revision: evidence.revision, expected_source_revision: originalSource?.revision } }])
  const saveSource = () => {
    const id = originalSource?.id ?? uuid()
    void submit([{ type: originalSource ? 'source.update' : 'source.add', payload: { id, ...(originalSource ? { expected_revision: sourceRevision } : {}), title: source.title ?? '', uri: source.uri ?? '', excerpt: source.excerpt ?? '', query: source.query ?? '', source_kind: source.source_kind ?? 'unknown' } }, ...(!originalSource ? [{ type: 'assertion.update' as const, payload: { id: evidence.id, source_id: id } }] : [])])
  }
  const history = actions.filter(a => a.payload.id === evidence.id || a.payload.id === evidence.source_id || a.payload.id === fact.id)
  const isoInput = (value: string | null) => value ? new Date(value).toISOString().slice(0, 19) : ''
  const dirty = editing || sourceEditing
  const status = evidence.retracted_at ? 'retracted' : evidence.review_status ?? 'unconfirmed'
  return <div className="evidence-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}><section className={`evidence-reader ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-label="Evidence reader">
    <header className="reader-head"><div className="reader-title"><span className="eyebrow">Evidence</span><h2>{claimLabel(fact, name)}</h2></div>
      <button className="icon-button" onClick={() => setWide(!wide)} aria-label={wide ? 'Narrow' : 'Expand'} title={wide ? 'Narrow' : 'Expand'}>{wide ? <Minimize2 size={16} /> : <Maximize2 size={16} />}</button>
      <button className="icon-button" aria-label="Close evidence reader" onClick={onClose}><X size={18} /></button></header>
    <div className="evidence-summary"><span className={`review-badge ${status}`}>{status === 'confirmed' ? <CheckCircle2 size={12} /> : <CircleDashed size={12} />} {status}</span><span className={`stance ${evidence.stance}`}>{evidence.stance === 'supports' ? 'Supports claim' : 'Refutes claim'}</span><span className="muted">{periodLabel(evidence.valid_from, evidence.valid_to)}</span></div>
    <div className="evidence-reader-body"><main>
      <section className="reader-section"><div className="reader-section-title"><h3>Observation</h3><button className="text-button" onClick={() => { setEdit({ ...evidence }); setEditing(!editing) }}>{editing ? 'Cancel edit' : 'Edit evidence'}</button></div>
        {editing ? <form className="stack" onSubmit={e => { e.preventDefault(); void submit([{ type: 'assertion.update', payload: { id: evidence.id, expected_revision: edit.revision, observation: edit.observation ?? '', note: edit.note, locator: edit.locator ?? '', interpretation: edit.interpretation ?? '', stance: edit.stance, valid_from: edit.valid_from, valid_to: edit.valid_to, source_id: edit.source_id } }]) }}>
          <label>What does the original record show?<textarea required value={edit.observation || edit.note} onChange={e => setEdit({ ...edit, observation: e.target.value, note: e.target.value })} /></label>
          <label>Specific locator / event ID / file line<input value={edit.locator ?? ''} onChange={e => setEdit({ ...edit, locator: e.target.value })} /></label>
          <label>Interpretation and limitations<textarea value={edit.interpretation ?? ''} onChange={e => setEdit({ ...edit, interpretation: e.target.value })} /></label>
          <div className="field-grid"><label>Stance<select value={edit.stance} onChange={e => setEdit({ ...edit, stance: e.target.value as Assertion['stance'] })}><option value="supports">Supports</option><option value="refutes">Refutes</option></select></label><label>Source<select value={edit.source_id ?? ''} onChange={e => setEdit({ ...edit, source_id: e.target.value || null })}><option value="">No source</option>{data.sources.map(s => <option key={s.id} value={s.id}>{s.title}</option>)}</select></label></div>
          <div className="field-grid">{(['valid_from', 'valid_to'] as const).map(field => <label key={field}>{field === 'valid_from' ? 'Activity from (UTC)' : 'Activity to (UTC)'}<input type="datetime-local" step="1" value={isoInput(edit[field])} onChange={e => setEdit({ ...edit, [field]: e.target.value ? new Date(e.target.value + 'Z').toISOString() : null })} /></label>)}</div>
          <div className="form-row-end"><span className="hint">Content changes require a fresh review.</span><button className="primary-button" disabled={busy}>Save evidence</button></div>
        </form> : <><p className="observation-text">{evidence.observation || evidence.note || <span className="muted">No observation recorded yet.</span>}</p>
          <div className="evidence-locator"><span>Locator</span><code>{evidence.locator || 'Missing — add the event ID, result row or file line.'}</code></div>
          {evidence.interpretation && <div className="interpretation"><span>Interpretation / limitations</span><p>{evidence.interpretation}</p></div>}</>}
      </section>
      <section className="reader-section"><div className="reader-section-title"><h3><FileText size={15} /> Primary source & original results</h3><button className="text-button" onClick={() => { setSource(originalSource ?? { title: '', uri: '', excerpt: '', query: '', source_kind: 'unknown' }); setSourceRevision(originalSource?.revision); setSourceEditing(!sourceEditing) }}>{sourceEditing ? 'Cancel edit' : originalSource ? 'Edit source' : 'Attach source'}</button></div>
        {sourceEditing ? <form className="stack" onSubmit={e => { e.preventDefault(); saveSource() }}><label>Source title<input required value={source.title ?? ''} onChange={e => setSource({ ...source, title: e.target.value })} /></label><label>Source classification<select value={source.source_kind ?? 'unknown'} onChange={e => setSource({ ...source, source_kind: e.target.value as Source['source_kind'] })}><option value="unknown">Unclassified</option><option value="primary">Primary: original logs, telemetry, file</option><option value="secondary">Secondary: context only</option></select></label><label>Reference / repository path and commit<input value={source.uri ?? ''} onChange={e => setSource({ ...source, uri: e.target.value })} /></label><label>KQL query<textarea className="mono" value={source.query ?? ''} onChange={e => setSource({ ...source, query: e.target.value })} /></label><label>Original excerpt / result rows (JSON or text)<textarea className="raw-input mono" value={source.excerpt ?? ''} onChange={e => setSource({ ...source, excerpt: e.target.value })} /></label><div className="form-row-end"><span className="hint">Editing a source resets all dependent evidence reviews.</span><button className="primary-button" disabled={busy}>Save source</button></div></form>
          : <><div className="source-line"><strong>{originalSource?.title ?? 'Source missing'}</strong><span className={`source-kind ${originalSource?.source_kind ?? 'unknown'}`}>{originalSource?.source_kind ?? 'unclassified'}</span></div>{originalSource?.uri && <code className="source-reference">{originalSource.uri}</code>}{originalSource?.query && <details open className="query-block"><summary>KQL query</summary><pre className="raw-evidence">{originalSource.query}</pre></details>}<RawEvidence text={originalSource?.excerpt ?? ''} /></>}
      </section>
    </main><aside className="review-aside"><h3>Review</h3><p className="hint">Confirm the observation against the primary record. A query by itself is not proof.</p><label>What did you verify?<textarea aria-label="Review note" value={reviewNote} onChange={e => setReviewNote(e.target.value)} placeholder="Checked event ID, actor, target and timestamp against original results…" /></label>
      <button className="primary-button" disabled={busy || dirty || !!evidence.retracted_at} onClick={() => review('confirmed')}><CheckCircle2 size={15} /> Confirm evidence</button>
      <button className="secondary-button" disabled={busy || dirty} onClick={() => review('unconfirmed')}>Mark unconfirmed</button>
      {dirty && <p className="hint">Save or cancel edits before reviewing.</p>}
      {evidence.reviewed_at && <div className="review-meta"><span>Last review</span><p>{new Date(evidence.reviewed_at).toLocaleString('en-GB')}<br /><small>Session {evidence.reviewed_by}</small></p>{evidence.review_note && <p>{evidence.review_note}</p>}</div>}
      <div className="aside-sep" />
      <button className="secondary-button" disabled={busy || dirty} onClick={() => void submit([{ type: evidence.retracted_at ? 'assertion.restore' : 'assertion.retract', payload: { id: evidence.id } }])}>{evidence.retracted_at ? 'Restore as unconfirmed' : 'Retract evidence'}</button>
      <button className="ghost-button" onClick={() => onCopy(evidence.id, 'Evidence ID')}><Copy size={14} /> Copy evidence ID</button>
      <button className="ghost-button" onClick={() => onCopy(JSON.stringify({ relation: fact, evidence, source: originalSource }, null, 2), 'Agent context')}><Copy size={14} /> Copy context for agent</button>
      <details className="history"><summary>Change history ({history.length})</summary>{history.slice().reverse().map(a => <div className="review-history" key={a.id}><strong>{a.type}</strong><small>{a.channel ?? a.author} · {new Date(a.at).toLocaleString('en-GB')}</small></div>)}</details>
      {error && <div role="alert" className="form-error">{error}</div>}
    </aside></div>
  </section></div>
}
