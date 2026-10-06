import { Fragment, useMemo, useState } from 'react'
import { addedText, reviewKind, reviewText } from './provenance'
import { CheckCircle2, CircleDashed, Copy, FileText, Maximize2, Minimize2, Search, ShieldCheck, X } from 'lucide-react'
import type { Assertion, GraphData, Source } from './types'
import { orderedKeys, rowFields, rowOf, timeSourceOf } from './rows'
import { Sentence } from './Sentence'
import type { ActionDraft, BoardAction } from './board'
import { periodLabel } from './timeline'
import { uuid } from './uuid'

/** The values that identify an evidence row ("AzureActivity CorrelationId=… EventDataId=…" → its IDs). */
const locatorValues = (locator?: string) => [...(locator ?? '').matchAll(/\S+=(\S+)/g)].map(m => m[1]).filter(v => v.length >= 4)

/** One original row as field: value lines, key fields first, the event time column marked; long JSON values fold. */
function RowFields({ row, timeKey }: { row: Record<string, unknown>; timeKey: string | null }) {
  return <dl className="row-vertical">{orderedKeys(row).map(key => { const value = row[key]; const text = typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value)
    return <Fragment key={key}><dt className={key === timeKey ? 'time-key' : ''}>{key}{key === timeKey ? <small> · event time</small> : null}</dt>
      <dd>{typeof value === 'object' || text.length > 160 ? <details><summary>{text.slice(0, 120).replace(/\s+/g, ' ')}{text.length > 120 ? '…' : ''}</summary><pre>{text}</pre></details> : text}</dd></Fragment> })}</dl>
}

function RawEvidence({ text, focus = [], time = null, row = null }: { text: string; focus?: string[]; time?: string | null
  /** The evidence's own original row (kept with the evidence): shown when the source holds only a sample of a large export. */
  row?: Record<string, unknown> | null }) {
  const [page, setPage] = useState(0)
  const [query, setQuery] = useState('')
  const [onlyThis, setOnlyThis] = useState(focus.length > 0 || !!row)
  const [asTable, setAsTable] = useState(false)
  let rows: Record<string, unknown>[] = []
  try { const value = JSON.parse(text); rows = Array.isArray(value) ? value : typeof value === 'object' && value ? [value] : [] } catch { /* plain excerpt */ }
  if (!rows.length && !row) return <pre className="raw-evidence">{text || 'No original excerpt or results attached.'}</pre>
  // This evidence's own row first (found by the IDs in its locator, else the row kept with the evidence); the other rows of the source on demand.
  const found = focus.length ? rows.filter(item => { const text = JSON.stringify(item); return focus.every(v => text.includes(v)) }) : []
  const own = found.length ? found : row ? [row] : []
  const base = onlyThis && own.length ? own : rows
  const matching = base.filter(row => JSON.stringify(row).toLowerCase().includes(query.toLowerCase()))
  // Columns that say something in the rows shown; empty ones are left out.
  const filled = (k: string) => matching.slice(0, 200).some(row => row[k] !== undefined && row[k] !== null && row[k] !== '')
  const columns = [...new Set([...rows, ...own].flatMap(row => Object.keys(row)))].filter(filled).slice(0, 30)
  // The evidence's own row reads best top to bottom, without scrolling sideways through dozens of columns.
  if (onlyThis && own.length === 1 && !asTable) return <div className="evidence-table">
    <div className="row-switch"><span>{found.length ? `The row of this evidence (1 of ${rows.length})` : `The row of this evidence (kept with it; the source holds ${rows.length ? `a sample of ${rows.length} rows` : 'no rows'})`}{timeSourceOf(own[0], time) ? <> · event time from <code>{timeSourceOf(own[0], time)}</code></> : null}</span>
      <button type="button" className="text-button" onClick={() => setAsTable(true)}>As table</button>
      {rows.length > 0 && <button type="button" className="text-button" onClick={() => { setOnlyThis(false); setPage(0) }}>{found.length ? 'Show all rows' : 'Show the sample'}</button>}</div>
    <RowFields row={own[0]} timeKey={timeSourceOf(own[0], time)} /></div>
  return <div className="evidence-table">
    {own.length > 0 && <div className="row-switch"><span>{onlyThis ? `The row of this evidence (${own.length} of ${rows.length})` : `All ${rows.length} rows of the source`}</span>
      <button type="button" className="text-button" onClick={() => { setOnlyThis(!onlyThis); setPage(0) }}>{onlyThis ? 'Show all rows' : 'Only the row of this evidence'}</button></div>}
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

type QueueFilter = 'unconfirmed' | 'agent' | 'import' | 'analyst' | 'retracted' | 'all'
export function EvidenceQueue({ data, onOpen, attack }: { data: GraphData; onOpen: (id: string) => void; attack?: Map<string, { before: number }> | null }) {
  const [filter, setFilter] = useState<QueueFilter>('unconfirmed')
  const [page, setPage] = useState(0)
  const [query, setQuery] = useState('')
  const names = useMemo(() => new Map(data.entities.map(e => [e.id, e.name])), [data.entities])
  const all = data.facts.flatMap(f => f.assertions.map(a => ({ f, a })))
  const matches = (a: Assertion, value: QueueFilter) => value === 'all' || (value === 'retracted' ? !!a.retracted_at : !a.retracted_at && reviewKind(a) === (value === 'unconfirmed' ? 'open' : value))
  // One card per activity: its items share the claim; the attacker's activities are reviewed first.
  const cards = useMemo(() => {
    const byFact = new Map<string, { f: GraphData['facts'][number]; items: Assertion[] }>()
    const q = query.trim().toLowerCase()
    const text = (f: GraphData['facts'][number]) => `${f.predicate} ${(f.participants?.map(p => p.entity_id) ?? [f.subject_id, f.object_id]).map(id => names.get(id) ?? '').join(' ')}`.toLowerCase()
    const hit = new Map<string, boolean>()
    for (const { f, a } of all) if (matches(a, filter)) {
      if (q) { if (!hit.has(f.id)) hit.set(f.id, text(f).includes(q)); if (!hit.get(f.id) && !`${a.observation ?? ''} ${a.locator ?? ''}`.toLowerCase().includes(q)) continue }
      const card = byFact.get(f.id) ?? { f, items: [] }; card.items.push(a); byFact.set(f.id, card) }
    const rank = (id: string) => { const hit = attack?.get(id); return !hit ? 2 : hit.before ? 1 : 0 }
    return [...byFact.values()].sort((a, b) => rank(a.f.id) - rank(b.f.id) || b.items.length - a.items.length)
  }, [data, filter, attack, query, names])
  // "Nothing to review" is not "all checked by a person": parser and agent confirmations are counted apart.
  const filters: [QueueFilter, string, string][] = [['unconfirmed', 'To review', 'Not confirmed yet'], ['agent', 'Agent-confirmed', 'Confirmed by an agent through REST or MCP; no analyst has checked it'],
    ['import', 'Parsed by import', 'Confirmed automatically: the import parsed the original log row; nobody has read it'], ['analyst', 'Reviewed', 'Checked by an analyst against the original'], ['retracted', 'Retracted', 'Withdrawn'], ['all', 'All', 'Everything']]
  const counts = useMemo(() => new Map(filters.map(([value]) => [value, all.filter(({ a }) => matches(a, value)).length])), [data])
  const times = (items: Assertion[]) => { const t = items.map(a => a.valid_from).filter(Boolean).sort() as string[]; return t.length ? periodLabel(t[0], t[t.length - 1]) : 'no time' }
  return <section className="view-page review-queue">
    <header className="view-header"><div><h2>Evidence review</h2><p>Check each observation against its original source before confirming.{attack?.size ? ' Attacker activity comes first.' : ''}</p></div>
      <div className="segmented wrap" role="group" aria-label="Review filter">{filters.filter(([value]) => counts.get(value) || value === 'unconfirmed' || value === 'all').map(([value, label, hint]) => <button key={value} title={hint} className={filter === value ? 'active' : ''} aria-pressed={filter === value} onClick={() => { setFilter(value); setPage(0) }}>{label} <b>{(counts.get(value) ?? 0).toLocaleString('en')}</b></button>)}</div></header>
    <label className="input-with-icon queue-search"><Search size={14} /><input aria-label="Search the review queue" placeholder="Search activities, entities, observations, locators…" value={query} onChange={e => { setQuery(e.target.value); setPage(0) }} /></label>
    {filter === 'unconfirmed' && !counts.get('unconfirmed') && (counts.get('import') || counts.get('agent')) ? <p className="queue-note">Nothing waits for a review, but that is not the same as checked: <b>{(counts.get('import') ?? 0).toLocaleString('en')}</b> items were confirmed by the import parser and <b>{(counts.get('agent') ?? 0).toLocaleString('en')}</b> by agents only; <b>{(counts.get('analyst') ?? 0).toLocaleString('en')}</b> were reviewed by analysts.</p> : null}
    {filter === 'agent' && <p className="queue-note">An agent said these are right. Check each against the original row and confirm it yourself, or mark it unconfirmed.</p>}
    {filter === 'import' && <p className="queue-note">The import mapped each original row to its activity. Spot-check the ones that matter (attacker activity first) and confirm them to record your own check.</p>}
    <div className="review-list">
      {cards.slice(page * 50, (page + 1) * 50).map(({ f, items }) => {
        const hit = attack?.get(f.id)
        const first = items.find(a => (a.review_status ?? 'unconfirmed') === 'unconfirmed' && !a.retracted_at) ?? items[0]
        const sources = [...new Set(items.map(a => data.sources.find(s => s.id === a.source_id)?.title.split(' · ')[0] ?? 'Source missing'))]
        return <button className={`review-queue-item${hit ? hit.before ? ' regular' : ' attack' : ''}`} key={f.id} onClick={() => onOpen(first.id)}>
          <span className={`review-badge ${['import', 'analyst', 'agent'].includes(filter) ? `confirmed ${filter}` : filter === 'retracted' ? 'retracted' : 'unconfirmed'}`}>{['import', 'analyst', 'agent'].includes(filter) ? <CheckCircle2 size={12} /> : <CircleDashed size={12} />}{items.length > 1 ? `${items.length.toLocaleString('en')} items` : '1 item'}</span>
          <span className="review-body"><span className="review-claim"><Sentence fact={f} data={data} /></span>
            <span className="review-observation">{first.observation || first.note || 'Observation still needed'}</span>
            <small>{hit ? <b className={hit.before ? 'review-regular' : 'review-attack'}>{hit.before ? 'Attacker window, likely regular' : 'Attacker activity'}</b> : null}{hit ? ' · ' : ''}{times(items)} · {sources.join(', ')}</small></span>
        </button>
      })}
      {!cards.length && <div className="view-empty"><ShieldCheck size={22} /><p>No evidence in this view.</p></div>}
    </div>
    {cards.length > 50 && <footer className="pager"><button className="secondary-button small" disabled={!page} onClick={() => setPage(page - 1)}>Previous</button><span>{cards.length} activities · page {page + 1}</span><button className="secondary-button small" disabled={(page + 1) * 50 >= cards.length} onClick={() => setPage(page + 1)}>Next</button></footer>}
  </section>
}

export default function EvidenceReader({ data, evidenceId, actions, onCommand, onClose, onCopy, onNavigate }: {
  data: GraphData; evidenceId: string; actions: BoardAction[]; onCommand: (items: ActionDraft[]) => Promise<unknown>; onClose: () => void; onCopy: (value: string, label: string) => void;
  /** Open another item of the same activity. */
  onNavigate: (id: string) => void;
}) {
  const fact = data.facts.find(f => f.assertions.some(a => a.id === evidenceId))
  const evidence = fact?.assertions.find(a => a.id === evidenceId)
  if (!fact || !evidence) return null
  return <Reader key={evidence.id} data={data} evidence={evidence} actions={actions} onCommand={onCommand} onClose={onClose} onCopy={onCopy} onNavigate={onNavigate} />
}

/** Every item of the activity, in time order: one card in the queue can stand for thousands of rows. */
function GroupNavigator({ items, current, data, onNavigate }: { items: Assertion[]; current: string; data: GraphData; onNavigate: (id: string) => void }) {
  const [open, setOpen] = useState(false)
  const [limit, setLimit] = useState(100)
  const index = items.findIndex(a => a.id === current)
  const nextOpen = items.find((a, i) => i > index && reviewKind(a) === 'open') ?? items.find(a => a.id !== current && reviewKind(a) === 'open')
  if (items.length < 2) return null
  const sourceTitle = (a: Assertion) => data.sources.find(s => s.id === a.source_id)?.title ?? 'Manual entry'
  return <div className="group-nav">
    <div className="group-nav-bar">
      <button className="secondary-button small" disabled={index <= 0} onClick={() => onNavigate(items[index - 1].id)} aria-label="Previous item">‹ Previous</button>
      <span>Item <b>{(index + 1).toLocaleString('en')}</b> of <b>{items.length.toLocaleString('en')}</b> of this activity</span>
      <button className="secondary-button small" disabled={index >= items.length - 1} onClick={() => onNavigate(items[index + 1].id)} aria-label="Next item">Next ›</button>
      {nextOpen && <button className="text-button" onClick={() => onNavigate(nextOpen.id)}>Next to review</button>}
      <button className="text-button" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? 'Hide list' : 'All items'}</button>
    </div>
    {open && <div className="group-nav-list" role="list">{items.slice(0, limit).map((a, i) => <button key={a.id} role="listitem" className={a.id === current ? 'active' : ''} onClick={() => onNavigate(a.id)}>
      <span className="mono">{i + 1}</span><span className="mono">{a.valid_from ? a.valid_from.slice(0, 19).replace('T', ' ') : 'no time'}</span>
      <span className={`review-badge ${a.retracted_at ? 'retracted' : a.review_status ?? 'unconfirmed'} ${reviewKind(a)}`}>{a.retracted_at ? 'retracted' : reviewText(a)}</span><span className="muted">{sourceTitle(a)}</span></button>)}
      {items.length > limit && <button className="text-button" onClick={() => setLimit(limit + 500)}>Show {Math.min(500, items.length - limit)} more of {items.length - limit}</button>}</div>}
  </div>
}

function Reader({ data, evidence, actions, onCommand, onClose, onCopy, onNavigate }: { data: GraphData; evidence: Assertion; actions: BoardAction[]; onCommand: (items: ActionDraft[]) => Promise<unknown>; onClose: () => void; onCopy: (value: string, label: string) => void; onNavigate: (id: string) => void }) {
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
  const submit = async (items: ActionDraft[]) => { setError(''); setBusy(true); try { await onCommand(items); setEditing(false); setSourceEditing(false); return true } catch (e) { setError(String(e)); return false } finally { setBusy(false) } }
  const items = useMemo(() => [...fact.assertions].sort((a, b) => (a.valid_from ?? '').localeCompare(b.valid_from ?? '') || a.id.localeCompare(b.id)), [fact.assertions])
  const nextOpen = (() => { const i = items.findIndex(a => a.id === evidence.id); return items.find((a, j) => j > i && reviewKind(a) === 'open') ?? items.find(a => a.id !== evidence.id && reviewKind(a) === 'open') })()
  // Moves on only when the confirmation went through; otherwise the error stays visible on this item.
  const confirmAndNext = async () => { const next = nextOpen; if (await submit([{ type: 'assertion.review', payload: { id: evidence.id, review_status: 'confirmed', review_note: reviewNote, expected_revision: evidence.revision, expected_source_revision: originalSource?.revision } }]) && next) onNavigate(next.id) }
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
    <GroupNavigator items={items} current={evidence.id} data={data} onNavigate={onNavigate} />
    <div className="evidence-summary"><span className={`review-badge ${status} ${reviewKind(evidence)}`}>{status === 'confirmed' ? <CheckCircle2 size={12} /> : <CircleDashed size={12} />} {status === 'retracted' ? 'retracted' : reviewText(evidence)}</span><span className={`stance ${evidence.stance}`}>{evidence.stance === 'supports' ? 'Supports claim' : 'Refutes claim'}</span><span className="muted" title="The event time of this evidence item">{periodLabel(evidence.valid_from, evidence.valid_to)}{timeSourceOf(rowOf(evidence), evidence.valid_from) ? ` · from ${timeSourceOf(rowOf(evidence), evidence.valid_from)}` : ''}</span></div>
    <div className="evidence-reader-body"><main>
      <section className="reader-section"><div className="reader-section-title"><h3>Observation</h3><button className="text-button" onClick={() => { setEdit({ ...evidence }); setEditing(!editing) }}>{editing ? 'Cancel edit' : 'Edit evidence'}</button></div>
        {editing ? <form className="stack" onSubmit={e => { e.preventDefault(); void submit([{ type: 'assertion.update', payload: { id: evidence.id, expected_revision: edit.revision, observation: edit.observation ?? '', note: edit.note, locator: edit.locator ?? '', interpretation: edit.interpretation ?? '', stance: edit.stance, valid_from: edit.valid_from, valid_to: edit.valid_to, source_id: edit.source_id } }]) }}>
          <label>What does the original record show?<textarea required value={edit.observation || edit.note} onChange={e => setEdit({ ...edit, observation: e.target.value, note: e.target.value })} /></label>
          <label>Specific locator / event ID / file line<input value={edit.locator ?? ''} onChange={e => setEdit({ ...edit, locator: e.target.value })} /></label>
          <label>Interpretation and limitations<textarea value={edit.interpretation ?? ''} onChange={e => setEdit({ ...edit, interpretation: e.target.value })} /></label>
          <div className="field-grid"><label>Stance<select value={edit.stance} onChange={e => setEdit({ ...edit, stance: e.target.value as Assertion['stance'] })}><option value="supports">Supports</option><option value="refutes">Refutes</option></select></label><label>Source<select value={edit.source_id ?? ''} onChange={e => setEdit({ ...edit, source_id: e.target.value || null })}><option value="">No source</option>{data.sources.map(s => <option key={s.id} value={s.id}>{s.title}</option>)}</select></label></div>
          <div className="field-grid">{(['valid_from', 'valid_to'] as const).map(field => <label key={field}>{field === 'valid_from' ? 'Activity from (UTC)' : 'Activity to (UTC)'}<input type="datetime-local" step="1" value={isoInput(edit[field])} onChange={e => setEdit({ ...edit, [field]: e.target.value ? new Date(e.target.value + 'Z').toISOString() : null })} /></label>)}</div>
          <div className="form-row-end"><span className="hint">Content changes require a fresh review.</span><button className="primary-button" disabled={busy}>Save evidence</button></div>
        </form> : <>{rowFields(evidence).length > 0 && <dl className="row-fields large">{rowFields(evidence).map(([label, value]) => <Fragment key={label}><dt>{label}</dt><dd>{value}</dd></Fragment>)}</dl>}
          <p className="observation-text">{evidence.observation || evidence.note || <span className="muted">No observation recorded yet.</span>}</p>
          <div className="evidence-locator"><span>Locator</span><code>{evidence.locator || 'Missing — add the event ID, result row or file line.'}</code></div>
          {evidence.interpretation && <div className="interpretation"><span>Interpretation / limitations</span><p>{evidence.interpretation}</p></div>}</>}
      </section>
      <section className="reader-section"><div className="reader-section-title"><h3><FileText size={15} /> Primary source & original results</h3><button className="text-button" onClick={() => { setSource(originalSource ?? { title: '', uri: '', excerpt: '', query: '', source_kind: 'unknown' }); setSourceRevision(originalSource?.revision); setSourceEditing(!sourceEditing) }}>{sourceEditing ? 'Cancel edit' : originalSource ? 'Edit source' : 'Attach source'}</button></div>
        {sourceEditing ? <form className="stack" onSubmit={e => { e.preventDefault(); saveSource() }}><label>Source title<input required value={source.title ?? ''} onChange={e => setSource({ ...source, title: e.target.value })} /></label><label>Source classification<select value={source.source_kind ?? 'unknown'} onChange={e => setSource({ ...source, source_kind: e.target.value as Source['source_kind'] })}><option value="unknown">Unclassified</option><option value="primary">Primary: original logs, telemetry, file</option><option value="secondary">Secondary: context only</option></select></label><label>Reference / repository path and commit<input value={source.uri ?? ''} onChange={e => setSource({ ...source, uri: e.target.value })} /></label><label>KQL query<textarea className="mono" value={source.query ?? ''} onChange={e => setSource({ ...source, query: e.target.value })} /></label><label>Original excerpt / result rows (JSON or text)<textarea className="raw-input mono" value={source.excerpt ?? ''} onChange={e => setSource({ ...source, excerpt: e.target.value })} /></label><div className="form-row-end"><span className="hint">{(() => { const dependent = data.facts.flatMap(f => f.assertions).filter(a => a.source_id && a.source_id === originalSource?.id && !a.retracted_at)
            const confirmed = dependent.filter(a => a.review_status === 'confirmed').length
            return originalSource ? <>Saving changes the source of <b>{dependent.length.toLocaleString('en')}</b> evidence item{dependent.length === 1 ? '' : 's'}; <b className={confirmed ? 'warn-text' : ''}>{confirmed.toLocaleString('en')}</b> confirmed one{confirmed === 1 ? '' : 's'} will need a review again. The change log keeps the original.</> : 'Attaches a new source to this evidence item.' })()}</span><button className="primary-button" disabled={busy}>Save source</button></div></form>
          : <><div className="source-line"><strong>{originalSource?.title ?? 'Source missing'}</strong><span className={`source-kind ${originalSource?.source_kind ?? 'unknown'}`}>{originalSource?.source_kind ?? 'unclassified'}</span></div>{originalSource?.uri && <code className="source-reference">{originalSource.uri}</code>}{originalSource?.query && <details open className="query-block"><summary>KQL query</summary><pre className="raw-evidence">{originalSource.query}</pre></details>}<RawEvidence text={originalSource?.excerpt ?? ''} focus={locatorValues(evidence.locator)} time={evidence.valid_from} row={rowOf(evidence)} /></>}
      </section>
    </main><aside className="review-aside"><h3>Review</h3><p className="hint">Confirm the observation against the primary record. A query by itself is not proof.</p><label>What did you verify?<textarea aria-label="Review note" value={reviewNote} onChange={e => setReviewNote(e.target.value)} placeholder="Checked event ID, actor, target and timestamp against original results…" /></label>
      <button className="primary-button" disabled={busy || dirty || !!evidence.retracted_at} onClick={() => review('confirmed')}><CheckCircle2 size={15} /> {items.length > 1 ? 'Confirm this item only' : 'Confirm evidence'}</button>
      {items.length > 1 && nextOpen && <button className="secondary-button" disabled={busy || dirty || !!evidence.retracted_at} onClick={() => void confirmAndNext()}>Confirm and go to the next open item</button>}
      <button className="secondary-button" disabled={busy || dirty} onClick={() => review('unconfirmed')}>Mark unconfirmed</button>
      {dirty && <p className="hint">Save or cancel edits before reviewing.</p>}
      <div className={`review-meta ${reviewKind(evidence)}`}><span>Status</span><p><b>{reviewText(evidence)}</b>{evidence.reviewed_at && <><br /><small>{new Date(evidence.reviewed_at).toLocaleString('en-GB', { timeZone: 'UTC' })} UTC · session {evidence.reviewed_by}</small></>}</p>
        {evidence.review_note && reviewKind(evidence) !== 'import' && <p>{evidence.review_note}</p>}
        {reviewKind(evidence) === 'import' && <p className="hint">A parser decision: the import mapped the original row to this activity. Nobody has read it yet; confirm it here to record your own check.</p>}
        {reviewKind(evidence) === 'agent' && <p className="hint">An agent confirmed it through REST or MCP. Check it against the original row before relying on it.</p>}
        <span>Added</span><p>{addedText(evidence)}{evidence.created_at ? <><br /><small>{new Date(evidence.created_at).toLocaleString('en-GB', { timeZone: 'UTC' })} UTC</small></> : null}</p></div>
      <div className="aside-sep" />
      <button className="secondary-button" disabled={busy || dirty} onClick={() => void submit([{ type: evidence.retracted_at ? 'assertion.restore' : 'assertion.retract', payload: { id: evidence.id } }])}>{evidence.retracted_at ? 'Restore as unconfirmed' : 'Retract evidence'}</button>
      <button className="ghost-button" onClick={() => onCopy(evidence.id, 'Evidence ID')}><Copy size={14} /> Copy evidence ID</button>
      <button className="ghost-button" onClick={() => onCopy(JSON.stringify({ relation: fact, evidence, source: originalSource }, null, 2), 'Agent context')}><Copy size={14} /> Copy context for agent</button>
      <details className="history"><summary>Change history ({history.length})</summary>{history.slice().reverse().map(a => <div className="review-history" key={a.id}><strong>{a.type}</strong><small>{a.channel ?? a.author} · {new Date(a.at).toLocaleString('en-GB')}</small></div>)}</details>
      {error && <div role="alert" className="form-error">{error}</div>}
    </aside></div>
  </section></div>
}
