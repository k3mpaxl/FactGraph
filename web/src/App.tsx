import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Activity, ArrowDownToLine, ArrowRight, Box, ChevronRight, CircleHelp, Copy,
  Database, FileText, Fingerprint, GitBranch, Link2, Merge, Pencil, Plus, Search,
  ShieldCheck, Sparkles, Trash2, Undo2, Upload, Users, Wifi, WifiOff, X,
} from 'lucide-react'
import { factIntersects, timelineSteps, timelineEvents, periodLabel, evidencePeriod } from './timeline'
import GraphView from './GraphView'
import { demoDrafts, factKey, legacyDrafts, normalizeIdentifier, type BoardAction } from './board'
import { useBoard } from './useBoard'
import { uuid } from './uuid'
import { entityVisual } from './entityVisual'
import type { Assertion, GraphData, Identifier, TruthState } from './types'

type Selection = { kind: 'entity' | 'fact'; id: string } | null
type DialogKind = 'entity' | 'entity-edit' | 'entity-merge' | 'fact' | 'source' | 'identifier' | 'assertion' | 'assertion-edit' | null

const labels: Record<TruthState, string> = {
  supported: 'Supported', disputed: 'Disputed', refuted: 'Refuted', unknown: 'Unknown',
}
const allStates: TruthState[] = ['supported', 'disputed', 'refuted', 'unknown']
const kinds = ['User', 'Person', 'Organization', 'Device', 'Service', 'Service Principal', 'Managed Identity', 'AKS Cluster', 'AKS Workload', 'System', 'IP', 'File', 'Repository', 'Process', 'Environment Variable', 'Credential', 'Secret', 'Azure Resource', 'Blob Storage', 'Location', 'Event', 'Document', 'Other']
const customKindValue = '__custom__'
const schemes = ['hostname', 'fqdn', 'ip', 'email', 'url', 'resource_id', 'external_id', 'other']

function date(value: string | null | undefined) {
  if (!value) return 'No date'
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleDateString('de-DE', { day: '2-digit', month: 'short', year: 'numeric' })
}

function nameOf(data: GraphData, id: string) {
  return data.entities.find(item => item.id === id)?.name ?? 'Unknown'
}

function sourceOf(data: GraphData, id: string | null) {
  return data.sources.find(item => item.id === id)
}

function IconForKind({ kind, color }: { kind: string; color?: string }) {
  const visual = entityVisual(kind)
  return <span className="entity-avatar" style={{ background: color || visual.fill, border: `1px solid ${color || visual.border}` }}>{kind.slice(0, 1).toUpperCase() || <Box size={16} />}</span>
}

function StatePill({ state }: { state: TruthState }) {
  return <span className={`state-pill ${state}`}><span className="state-dot" />{labels[state]}</span>
}

function SourceLine({ data, sourceId }: { data: GraphData; sourceId: string | null }) {
  const source = sourceOf(data, sourceId)
  return <span>{source ? source.title : 'Manual entry'}</span>
}

function DetailPanel({ data, selection, onAdd, onDelete, onRetract, onEditEvidence, onCopy, onClose }: {
  data: GraphData; selection: Selection; onAdd: (kind: DialogKind) => void;
  onDelete: (kind: 'entity' | 'fact' | 'identifier', id: string) => void;
  onRetract: (id: string) => void; onEditEvidence: (id: string) => void;
  onCopy: (value: string, label: string) => void; onClose: () => void;
}) {
  if (!selection) return <aside className="detail-panel detail-empty">
    <div className="detail-head"><span>INSPECTOR</span><CircleHelp size={17} /></div>
    <div className="detail-intro-icon"><GitBranch size={30} /></div>
    <h2>Understand the connection.</h2>
    <p>Select an entity or relationship in the graph. Identifiers, sources and evidence statements appear here.</p>
    <div className="detail-tip"><ShieldCheck size={18} /><span>A relationship status is calculated from active evidence.</span></div>
  </aside>

  if (selection.kind === 'entity') {
    const entity = data.entities.find(item => item.id === selection.id)
    if (!entity) return null
    const related = data.facts.filter(item => item.subject_id === entity.id || item.object_id === entity.id)
    return <aside className="detail-panel">
      <div className="detail-head"><span>ENTITY</span><button className="icon-button" onClick={onClose} title="Close"><X size={17} /></button></div>
      <div className="detail-title-row"><IconForKind kind={entity.kind} color={entity.color} /><div><div className="detail-kind">{entity.kind}</div><h2>{entity.name}</h2><div className="entity-quick-actions"><button className="text-button" onClick={() => onAdd('entity-edit')}><Pencil size={14} /> Edit</button><button className="text-button" onClick={() => onAdd('entity-merge')}><Merge size={14} /> Merge</button></div></div></div>
      {entity.description && <p className="detail-description">{entity.description}</p>}
      <button className="id-line copy-id" onClick={() => onCopy(entity.id, 'Entity ID')} title="Copy entity ID">ID {entity.id} <Copy size={13} /></button>
      <section className="detail-section">
        <div className="section-heading"><h3>Identifiers <small>{entity.identifiers.length}</small></h3><button className="text-button" onClick={() => onAdd('identifier')}><Plus size={15} /> Add</button></div>
        {entity.identifiers.length ? entity.identifiers.map(identifier => <IdentifierRow key={identifier.id} identifier={identifier} data={data} onCopy={onCopy} onDelete={() => onDelete('identifier', identifier.id)} />) :
          <p className="muted small">No identifiers yet.</p>}
      </section>
      <section className="detail-section">
        <div className="section-heading"><h3>Relationships <small>{related.length}</small></h3></div>
        {related.length ? related.map(fact => <div key={fact.id} className="related-row"><StatePill state={fact.truth_state} /><span>{fact.predicate} · {nameOf(data, fact.subject_id === entity.id ? fact.object_id : fact.subject_id)}</span></div>) :
          <p className="muted small">No relationships yet.</p>}
      </section>
      <button className="primary-button link-from-node" onClick={() => onAdd('fact')}><Link2 size={15} /> Create relationship</button>
      <div className="detail-bottom"><button className="danger-link" onClick={() => onDelete('entity', entity.id)}><Trash2 size={15} /> Delete entity</button></div>
    </aside>
  }

  const fact = data.facts.find(item => item.id === selection.id)
  if (!fact) return null
  return <aside className="detail-panel">
    <div className="detail-head"><span>RELATIONSHIP / FACT</span><button className="icon-button" onClick={onClose} title="Close"><X size={17} /></button></div>
    <div className="fact-heading"><span>{nameOf(data, fact.subject_id)}</span><ArrowRight size={19} /><span>{nameOf(data, fact.object_id)}</span></div>
    <div className="predicate-label">{fact.predicate}</div>
    <button className="id-line copy-id" onClick={() => onCopy(fact.id, 'Relationship ID')} title="Copy relationship ID">ID {fact.id} <Copy size={13} /></button>
    <div className="fact-state"><StatePill state={fact.truth_state} /><span>{fact.assertions.filter(a => !a.retracted_at).length} active evidence items</span></div>
    <div className="fact-meta"><span>Relation valid from</span><strong>{date(fact.valid_from)}</strong></div>
    {fact.valid_to && <div className="fact-meta"><span>Relation valid to</span><strong>{date(fact.valid_to)}</strong></div>}
    <section className="detail-section">
      <div className="section-heading"><h3>Evidence <small>{fact.assertions.length}</small></h3><button className="text-button" onClick={() => onAdd('assertion')}><Plus size={15} /> Add evidence</button></div>
      {fact.assertions.map(assertion => <AssertionRow key={assertion.id} assertion={assertion} data={data} onCopy={onCopy} onEdit={() => onEditEvidence(assertion.id)} onRetract={() => onRetract(assertion.id)} />)}
    </section>
    <div className="truth-explanation"><ShieldCheck size={18} /><span>Supporting and refuting evidence can coexist. Retracted evidence remains traceable.</span></div>
    <div className="detail-bottom"><button className="danger-link" onClick={() => onDelete('fact', fact.id)}><Trash2 size={15} /> Delete relationship</button></div>
  </aside>
}

function IdentifierRow({ identifier, data, onCopy, onDelete }: { identifier: Identifier; data: GraphData; onCopy: (value: string, label: string) => void; onDelete: () => void }) {
  return <div className="identifier-row">
    <div className="identifier-top"><span className="scheme-badge">{identifier.scheme}</span><button title="Delete identifier" className="row-delete" onClick={onDelete}><X size={14} /></button></div>
    <button className="identifier-value copy-value" onClick={() => onCopy(identifier.raw_value, 'Identifier')} title="Copy identifier">{identifier.raw_value} <Copy size={12} /></button>
    <button className="identifier-id" onClick={() => onCopy(identifier.id, 'Identifier ID')} title="Copy identifier record ID">ID {identifier.id.slice(0, 8)}…</button>
    <div className="identifier-meta">{identifier.namespace && <span>{identifier.namespace} · </span>}<SourceLine data={data} sourceId={identifier.source_id} /> · {Math.round(identifier.confidence * 100)} %</div>
    {(identifier.valid_from || identifier.valid_to) && <div className="identifier-meta">{date(identifier.valid_from)} – {identifier.valid_to ? date(identifier.valid_to) : 'heute'}</div>}
  </div>
}

function AssertionRow({ assertion, data, onCopy, onEdit, onRetract }: { assertion: Assertion; data: GraphData; onCopy: (value: string, label: string) => void; onEdit: () => void; onRetract: () => void }) {
  const source = sourceOf(data, assertion.source_id)
  const period = evidencePeriod(assertion, data.facts.find(f => f.id === assertion.fact_id)!)
  return <div className={`assertion-row ${assertion.retracted_at ? 'retracted' : ''}`}>
    <div className="assertion-top"><span className={assertion.stance === 'supports' ? 'supports-text' : 'refutes-text'}>{assertion.stance === 'supports' ? '● Supports' : '● Refutes'}</span><span>{Math.round(assertion.confidence * 100)} %</span></div>
    <div className="assertion-source"><FileText size={14} /><SourceLine data={data} sourceId={assertion.source_id} /></div>
    {source && (source.excerpt || source.uri) && <details className="source-details"><summary>View source</summary>{source.excerpt && <blockquote>{source.excerpt}</blockquote>}{source.uri && <div>{source.uri}</div>}</details>}
    {assertion.note && <p>{assertion.note}</p>}
    <div className="assertion-id"><button onClick={() => onCopy(assertion.id, 'Evidence ID')} title="Copy evidence ID">ID {assertion.id.slice(0, 8)}… <Copy size={11} /></button></div>
    <div className="assertion-footer"><span>{periodLabel(period.from, period.to)}{assertion.retracted_at && ' · Retracted'}</span><span className="assertion-actions"><button onClick={onEdit}>Edit</button>{!assertion.retracted_at && <button onClick={onRetract}>Retract</button>}</span></div>
  </div>
}

function Dialog({ kind, data, selection, editingAssertionId, busy, error, onClose, onSubmit }: {
  kind: Exclude<DialogKind, null>; data: GraphData; selection: Selection; busy: boolean;
  editingAssertionId: string | null;
  error: string; onClose: () => void; onSubmit: (kind: Exclude<DialogKind, null>, values: Record<string, unknown>) => Promise<void>;
}) {
  const titles = { entity: 'New entity', 'entity-edit': 'Edit entity', 'entity-merge': 'Merge entity', fact: 'New relationship', source: 'New source', identifier: 'Add identifier', assertion: 'Add evidence', 'assertion-edit': 'Edit evidence' }
  const editing = kind === 'entity-edit' ? data.entities.find(e => e.id === selection?.id) : undefined
  const editingAssertion = kind === 'assertion-edit' ? data.facts.flatMap(fact => fact.assertions).find(assertion => assertion.id === editingAssertionId) : undefined
  const [stance, setStance] = useState<'supports' | 'refutes'>(editingAssertion?.stance ?? 'supports')
  const [newTarget, setNewTarget] = useState(selection?.kind === 'entity')
  const [customEntityKind, setCustomEntityKind] = useState(!!editing && !kinds.includes(editing.kind))
  const [customTargetKind, setCustomTargetKind] = useState(false)
  const [localError, setLocalError] = useState('')
  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const get = (field: string) => String(form.get(field) ?? '').trim()
    const asDate = (field: string) => get(field) ? new Date(get(field)).toISOString() : null
    const confidence = Number(get('confidence') || 100) / 100
    let values: Record<string, unknown>
    const entityKind = get('kind') === customKindValue ? get('custom_kind') : get('kind')
    const targetKind = get('new_object_kind') === customKindValue ? get('custom_new_object_kind') : get('new_object_kind')
    if (kind === 'entity' || kind === 'entity-edit') values = { name: get('name'), kind: entityKind, description: get('description'), color: get('color') }
    else if (kind === 'entity-merge') values = { target_id: get('target_id') }
    else if (kind === 'source') values = { title: get('title'), uri: get('uri'), excerpt: get('excerpt') }
    else if (kind === 'identifier') values = {
      scheme: get('scheme'), namespace: get('namespace'), raw_value: get('raw_value'),
      confidence, source_id: get('source_id') || null, valid_from: asDate('valid_from'), valid_to: asDate('valid_to'),
    }
    else if (kind === 'fact') values = {
      subject_id: get('subject_id'), predicate: get('predicate'), object_id: get('object_id'),
      new_object_name: newTarget ? get('new_object_name') : '',
      new_object_kind: newTarget ? targetKind : '',
      valid_from: asDate('valid_from'), valid_to: asDate('valid_to'),
      assertion: { stance, confidence, source_id: get('source_id') || null, note: get('note') },
    }
    else values = { stance, confidence, source_id: get('source_id') || null, note: get('note'), valid_from: asDate('valid_from'), valid_to: asDate('valid_to') }
    if (kind === 'entity' && !entityKind) { setLocalError('Please choose a type.'); return }
    if (kind === 'fact' && newTarget && !targetKind) { setLocalError('Please choose a type for the new node.'); return }
    if (kind === 'fact' && !newTarget && values.subject_id === values.object_id) { setLocalError('Choose two different entities.'); return }
    if (get('valid_from') && get('valid_to') && get('valid_from') > get('valid_to')) { setLocalError('The end must be after the start.'); return }
    setLocalError('')
    await onSubmit(kind, values)
  }
  const localDate = (value: string | null | undefined) => {
    if (!value) return ''
    const parsed = new Date(value)
    return new Date(parsed.getTime() - parsed.getTimezoneOffset() * 60_000).toISOString().slice(0, 16)
  }
  const sourceSelect = <label>Source <span className="optional">optional</span><select name="source_id" defaultValue={editingAssertion?.source_id ?? ''}><option value="">Manual entry</option>{data.sources.map(source => <option key={source.id} value={source.id}>{source.title}</option>)}</select></label>
  const confidenceField = <label>Confidence <span className="optional">0–100 %</span><input name="confidence" type="number" min="0" max="100" defaultValue={editingAssertion ? Math.round(editingAssertion.confidence * 100) : 100} /></label>
  const dateFields = <div className="field-grid"><label>Evidence from <span className="optional">optional</span><input name="valid_from" type="datetime-local" defaultValue={localDate(editingAssertion?.valid_from)} /></label><label>Evidence to <span className="optional">optional</span><input name="valid_to" type="datetime-local" defaultValue={localDate(editingAssertion?.valid_to)} /></label></div>
  return <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}>
    <div className="modal" role="dialog" aria-modal="true" aria-label={titles[kind]}>
      <div className="modal-header"><div><span className="eyebrow">FACTGRAPH · ERFASSEN</span><h2>{titles[kind]}</h2></div><button className="icon-button" onClick={onClose}><X size={20} /></button></div>
      <form onSubmit={submit}>
        {(kind === 'entity' || kind === 'entity-edit') && <><label>Name<input name="name" defaultValue={editing?.name} autoFocus required placeholder="e.g. Web server 01" /></label><div className="field-grid"><label>Type<select name="kind" defaultValue={editing ? (kinds.includes(editing.kind) ? editing.kind : customKindValue) : kinds[0]} onChange={event => setCustomEntityKind(event.target.value === customKindValue)}>{kinds.map(value => <option key={value}>{value}</option>)}<option value={customKindValue}>Custom type…</option></select>{customEntityKind && <input name="custom_kind" defaultValue={editing?.kind} required autoFocus placeholder="e.g. SaaS application" />}</label><label>Node color<input name="color" className="color-input" type="color" defaultValue={editing?.color || entityVisual(editing?.kind || kinds[0]).fill} /></label></div><label>Description <span className="optional">optional</span><textarea name="description" defaultValue={editing?.description} rows={3} placeholder="What is known about this entity?" /></label></>}
        {kind === 'entity-merge' && selection?.kind === 'entity' && <><div className="modal-context">Merge <strong>{nameOf(data, selection.id)}</strong> into another entity. Its identifiers, relationships and evidence are retained.</div><label>Keep entity<select name="target_id" required autoFocus><option value="" disabled>Choose target entity</option>{data.entities.filter(item => item.id !== selection.id).map(item => <option key={item.id} value={item.id}>{item.name} · {item.kind}</option>)}</select></label><div className="form-warning">The selected source entity will disappear. Use Undo if you change your mind.</div></>}
        {kind === 'source' && <><label>Title<input name="title" autoFocus required placeholder="e.g. EDR export from Sep 27" /></label><label>URL or reference <span className="optional">optional</span><input name="uri" placeholder="https://… or file path" /></label><label>Excerpt <span className="optional">optional</span><textarea name="excerpt" rows={4} placeholder="Relevant passage from the source" /></label></>}
        {kind === 'identifier' && <><div className="modal-context">Entity: <strong>{selection?.kind === 'entity' ? nameOf(data, selection.id) : ''}</strong></div><div className="field-grid"><label>Scheme<select name="scheme">{schemes.map(value => <option key={value}>{value}</option>)}</select></label><label>Namespace <span className="optional">optional</span><input name="namespace" placeholder="e.g. prod" /></label></div><label>Value<input name="raw_value" autoFocus required placeholder="External identifier" /></label>{dateFields}{sourceSelect}{confidenceField}</>}
        {kind === 'fact' && <><div className="field-grid"><label>From<select name="subject_id" defaultValue={selection?.kind === 'entity' ? selection.id : ''} required><option value="" disabled>Choose entity</option>{data.entities.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><label>To<div className="target-choice"><button type="button" className={newTarget ? 'active' : ''} onClick={() => setNewTarget(true)}>New node</button><button type="button" className={!newTarget ? 'active' : ''} onClick={() => setNewTarget(false)}>Existing node</button></div></label></div>{newTarget ? <div className="field-grid"><label>New node name<input name="new_object_name" required placeholder="e.g. Azure secret" /></label><label>Type<select name="new_object_kind" defaultValue={kinds[0]} onChange={event => setCustomTargetKind(event.target.value === customKindValue)}>{kinds.map(value => <option key={value}>{value}</option>)}<option value={customKindValue}>Custom type…</option></select>{customTargetKind && <input name="custom_new_object_kind" required autoFocus placeholder="e.g. SaaS application" />}</label></div> : <label>Target node<select name="object_id" defaultValue="" required><option value="" disabled>Choose entity</option>{data.entities.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>}<label>Relationship / predicate<input name="predicate" autoFocus required placeholder="e.g. reads, grants access to, accessed" /></label>{dateFields}<div className="form-divider">First evidence statement</div><StanceSelect value={stance} onChange={setStance} />{sourceSelect}{confidenceField}<label>Note <span className="optional">optional</span><textarea name="note" rows={2} placeholder="What supports this statement?" /></label></>}
        {(kind === 'assertion' || kind === 'assertion-edit') && <>{dateFields}<div className="modal-context">Relationship: <strong>{selection?.kind === 'fact' ? data.facts.find(item => item.id === selection.id)?.predicate : ''}</strong></div><StanceSelect value={stance} onChange={setStance} />{sourceSelect}{confidenceField}<label>Note <span className="optional">optional</span><textarea name="note" defaultValue={editingAssertion?.note} rows={3} placeholder="What does the source show?" /></label></>}
        {(error || localError) && <div className="form-error">{localError || error}</div>}
        <div className="modal-actions"><button type="button" className="secondary-button" onClick={onClose}>Cancel</button><button className="primary-button" disabled={busy}>{busy ? 'Saving…' : 'Save'} <ArrowRight size={16} /></button></div>
      </form>
    </div>
  </div>
}

function StanceSelect({ value, onChange }: { value: 'supports' | 'refutes'; onChange: (value: 'supports' | 'refutes') => void }) {
  return <div className="stance-field"><span>Evidence stance</span><div className="stance-options"><button type="button" className={value === 'supports' ? 'active supports' : ''} onClick={() => onChange('supports')}>● Supports</button><button type="button" className={value === 'refutes' ? 'active refutes' : ''} onClick={() => onChange('refutes')}>● Refutes</button></div></div>
}

function LogImportDialog({ boardId, sessionToken, onClose, onDone }: {
  boardId: string; sessionToken: string; onClose: () => void; onDone: (summary: string) => void;
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setBusy(true); setError('')
    try {
      const response = await fetch(`/api/boards/${boardId}/imports/file`, {
        method: 'POST', headers: { 'X-FactGraph-Token': sessionToken }, body: new FormData(event.currentTarget),
      })
      const result = await response.json() as Record<string, unknown>
      if (!response.ok) throw new Error(String(result.detail ?? 'Import failed'))
      onDone(`${result.rows} log rows · ${result.entities} entities · ${result.relations} relationships · ${result.evidence} evidence items`)
    } catch (problem) { setError(problem instanceof Error ? problem.message : 'Import failed') }
    finally { setBusy(false) }
  }
  return <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}>
    <div className="modal" role="dialog" aria-modal="true" aria-label="Import activity logs">
      <div className="modal-header"><div><span className="eyebrow">FACTGRAPH · EVIDENCE</span><h2>Logs and KQL results</h2></div><button className="icon-button" onClick={onClose}><X size={20} /></button></div>
      <form onSubmit={event => void submit(event)}>
        <p className="import-explanation">Import CSV, JSON or JSONL result rows. KQL is not executed here; the query and supplied rows are stored as the evidence source.</p>
        <label>File<input name="file" type="file" accept=".csv,.json,.jsonl,.ndjson" required /></label>
        <label>Source title<input name="title" defaultValue="Access Logs" required /></label>
        <label>KQL query <span className="optional">optional</span><textarea name="query" rows={4} placeholder="AccessLogs | project IPAddress, FilePath, TimeGenerated" /></label>
        <div className="field-grid"><label>Source column <span className="optional">blank = auto</span><input name="subject_field" placeholder="IPAddress" /></label><label>Target column <span className="optional">blank = auto</span><input name="object_field" placeholder="FilePath" /></label></div>
        <div className="field-grid"><label>Source type<input name="subject_kind" defaultValue="IP" /></label><label>Target type<input name="object_kind" defaultValue="File" /></label></div>
        <div className="field-grid"><label>Relationship<input name="predicate" defaultValue="accessed" required /></label><label>Relationship column <span className="optional">optional</span><input name="predicate_field" placeholder="OperationName" /></label></div>
        {error && <div className="form-error">{error}</div>}
        <div className="modal-actions"><button type="button" className="secondary-button" onClick={onClose}>Cancel</button><button className="primary-button" disabled={busy}>{busy ? 'Importing…' : 'Import results'} <ArrowRight size={16} /></button></div>
      </form>
    </div>
  </div>
}

function currentBoardId() {
  const fromUrl = window.location.pathname.match(/^\/boards\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?$/i)?.[1]
  let stored = ''
  try { stored = localStorage.getItem('factgraph:lastBoard') ?? '' } catch { /* private mode */ }
  const id = fromUrl?.toLowerCase() ?? (/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(stored) ? stored : uuid())
  window.history.replaceState(null, '', `/boards/${id}`)
  try { localStorage.setItem('factgraph:lastBoard', id) } catch { /* private mode */ }
  return id
}

function actionLabel(action: BoardAction) {
  const names: Record<BoardAction['type'], string> = {
    'board.rename': 'Board renamed', 'entity.add': 'Entity created',
    'entity.update': 'Entity edited', 'entity.position': 'Node moved', 'entity.delete': 'Entity deleted', 'entity.merge': 'Entities merged', 'identifier.add': 'Identifier added',
    'identifier.delete': 'Identifier deleted', 'source.add': 'Source created', 'source.update': 'Source edited', 'source.delete': 'Source deleted',
    'fact.add': 'Relationship created', 'fact.update': 'Relationship edited', 'fact.delete': 'Relationship deleted',
    'assertion.add': 'Evidence added', 'assertion.update': 'Evidence edited', 'assertion.retract': 'Evidence retracted',
    'assertion.delete': 'Evidence deleted', 'action.undo': 'Change undone',
  }
  const subject = typeof action.payload.name === 'string' ? action.payload.name :
    typeof action.payload.title === 'string' ? action.payload.title :
      typeof action.payload.predicate === 'string' ? action.payload.predicate : ''
  return `${names[action.type]}${subject ? ` · ${subject}` : ''}`
}

function peerColor(id: string) {
  let hash = 0
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) % 360
  return `hsl(${hash} 74% 68%)`
}

type WorkspaceTab = 'graph' | 'timeline' | 'activity'

function TimelinePanel({ data, facts, selection, onSelect }: {
  data: GraphData; facts: GraphData['facts']; selection: Selection; onSelect: (selection: Selection) => void;
}) {
  const entries = timelineEvents(facts)
  return <section className="timeline-panel"><div className="card-header"><div><div className="card-title"><Activity size={18} /> Timeline</div><span>Evidence periods · chronological · UTC</span></div><span className="mini-count">{entries.length} evidence events</span></div><div className="timeline-list">{entries.length ? entries.map(({ fact, assertions, from, to }) => <button key={`${fact.id}:${from}:${to}`} className={`timeline-item ${selection?.id === fact.id ? 'active' : ''}`} onClick={() => onSelect({ kind: 'fact', id: fact.id })}><span className={`timeline-dot ${fact.truth_state}`} /><span className="timeline-date">{periodLabel(from, to)}</span><strong>{nameOf(data, fact.subject_id)} <span>→</span> {nameOf(data, fact.object_id)}</strong><small>{fact.predicate} · {assertions.length} evidence {assertions.length === 1 ? 'item' : 'items'} · {[...new Set(assertions.map(item => item.stance === 'supports' ? 'Supports' : 'Refutes'))].join(' + ')}</small></button>) : <div className="timeline-empty">No active evidence yet.</div>}</div></section>
}

function EvidenceWindow({ facts, from, to, includeUndated, onIncludeUndatedChange, onFromChange, onToChange, onReset }: {
  facts: GraphData['facts']; from: string; to: string;
  includeUndated: boolean; onIncludeUndatedChange: (value: boolean) => void;
  onFromChange: (value: string) => void; onToChange: (value: string) => void; onReset: () => void;
}) {
  const steps = timelineSteps(facts)
  const maxStep = Math.max(steps.length - 1, 0)
  const nearestStep = (value: string, fallback: number) => {
    if (!value || !steps.length) return fallback
    const target = Date.parse(value)
    return steps.reduce((best, step, index) => Math.abs(Date.parse(step) - target) < Math.abs(Date.parse(steps[best]) - target) ? index : best, 0)
  }
  const fromStep = Math.min(nearestStep(from, 0), maxStep)
  const toStep = Math.max(nearestStep(to, maxStep), 0)
  const position = (step: number) => maxStep ? Math.round((step / maxStep) * 1000) : 0
  const moveFrom = (step: number) => onFromChange(steps[Math.min(step, toStep)] ?? '')
  const moveTo = (step: number) => onToChange(steps[Math.max(step, fromStep)] ?? '')
  const hasRange = steps.length > 1
  return <div className="evidence-window"><div><strong>Evidence window</strong><span>{from || to ? 'Edges update at each evidence step.' : 'Drag the handles through evidence activity.'}</span></div><div className="window-range" aria-label="Evidence time range"><div className="window-track" /><div className="window-selection" style={{ left: `${position(fromStep) / 10}%`, right: `${100 - position(toStep) / 10}%` }} /> <input aria-label="Evidence from" aria-valuetext={steps[fromStep] ?? 'No dated evidence'} className="range-input range-from" type="range" min="0" max={maxStep} step="1" value={fromStep} disabled={!hasRange} onChange={event => moveFrom(Number(event.target.value))} /><input aria-label="Evidence to" aria-valuetext={steps[toStep] ?? 'No dated evidence'} className="range-input range-to" type="range" min="0" max={maxStep} step="1" value={toStep} disabled={!hasRange} onChange={event => moveTo(Number(event.target.value))} /><div className="window-labels"><span>From <strong>{steps.length ? periodLabel(steps[fromStep], null) : 'No dated evidence'}</strong></span><span>To <strong>{steps.length ? periodLabel(steps[toStep], null) : 'No dated evidence'}</strong></span><em>{steps.length ? `${fromStep + 1}–${toStep + 1} / ${steps.length} steps` : ''}</em></div></div><label className="undated-toggle"><input type="checkbox" checked={includeUndated} onChange={event => onIncludeUndatedChange(event.target.checked)} /> Include undated</label>{(from || to) && <button className="text-button" onClick={onReset}>Show all</button>}</div>
}

function ActivityPanel({ actions }: { actions: BoardAction[] }) {
  return <section className="activity-panel"><div className="card-header"><div><div className="card-title"><Activity size={18} /> Activity</div><span>Synchronised changes on this board</span></div><span className="mini-count">{actions.length} {actions.length === 1 ? 'action' : 'actions'}</span></div><div className="activity-list">{actions.length ? [...actions].slice(-6).reverse().map(action => <div key={action.id} className="activity-item"><span className="activity-mark" style={{ background: peerColor(action.actor) }} /><span><strong>{actionLabel(action)}</strong><small><b className={`activity-source ${action.author.toLowerCase()}`}>{action.author}</b> · {date(action.at)}</small></span></div>) : <span className="timeline-empty">No actions yet.</span>}</div></section>
}

export default function App() {
  const [boardId] = useState(currentBoardId)
  const board = useBoard(boardId)
  const data = board.ready ? board.data : null
  const [selection, setSelection] = useState<Selection>(null)
  const [dialog, setDialog] = useState<DialogKind>(null)
  const [editingAssertionId, setEditingAssertionId] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [stateFilter, setStateFilter] = useState<TruthState | 'all'>('all')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [toast, setToast] = useState('')
  const [showBoards, setShowBoards] = useState(false)
  const [showLogImport, setShowLogImport] = useState(false)
  const [activeTab, setActiveTab] = useState<WorkspaceTab>('graph')
  const [evidenceFrom, setEvidenceFrom] = useState('')
  const [evidenceTo, setEvidenceTo] = useState('')
  const [includeUndated, setIncludeUndated] = useState(true)
  const importInput = useRef<HTMLInputElement>(null)

  useEffect(() => { if (toast) { const timer = window.setTimeout(() => setToast(''), 3300); return () => clearTimeout(timer) } }, [toast])

  const act = async (action: () => Promise<unknown>, message: string) => {
    setBusy(true); setError('')
    try { await action(); setDialog(null); setToast(message) }
    catch (problem) { setError(problem instanceof Error ? problem.message : 'Ein Fehler ist aufgetreten.') }
    finally { setBusy(false) }
  }

  const submit = async (kind: Exclude<DialogKind, null>, values: Record<string, unknown>) => {
    if (!data) return
    const created_at = new Date().toISOString()
    if (kind === 'entity') await act(() => board.emit('entity.add', { id: uuid(), ...values, created_at }), 'Entity saved')
    else if (kind === 'entity-edit' && selection?.kind === 'entity') await act(() => board.emit('entity.update', { id: selection.id, ...values }), 'Entity updated')
    else if (kind === 'entity-merge' && selection?.kind === 'entity') await act(async () => {
      await board.emit('entity.merge', { source_id: selection.id, target_id: values.target_id })
      setSelection({ kind: 'entity', id: String(values.target_id) })
    }, 'Entities merged')
    else if (kind === 'source') await act(() => board.emit('source.add', { id: uuid(), ...values, created_at }), 'Source saved')
    else if (kind === 'identifier' && selection?.kind === 'entity') {
      const raw = String(values.raw_value ?? '')
      const scheme = String(values.scheme ?? 'other')
      await act(() => board.emit('identifier.add', { id: uuid(), entity_id: selection.id,
        ...values, normalized_value: normalizeIdentifier(scheme, raw) }), 'Kennung gespeichert')
    } else if (kind === 'fact') {
      const assertion = values.assertion as Record<string, unknown>
      const newObjectName = String(values.new_object_name ?? '').trim()
      const newObjectId = newObjectName ? uuid() : ''
      const fact = { id: uuid(), subject_id: String(values.subject_id),
        predicate: String(values.predicate).trim(), object_id: newObjectId || String(values.object_id),
        valid_from: values.valid_from as string | null, valid_to: values.valid_to as string | null, created_at }
      const existing = data.facts.find(item => factKey(item) === factKey(fact))
      const assertionPayload = { id: uuid(), fact_id: existing?.id ?? fact.id, ...assertion, created_at }
      if (existing) await act(() => board.emit('assertion.add', assertionPayload), 'Evidence added to existing relationship')
      else await act(() => board.emitMany([
        ...(newObjectId ? [{ type: 'entity.add' as const, payload: { id: newObjectId,
          name: newObjectName, kind: String(values.new_object_kind || 'Sonstiges'),
          description: '', created_at } }] : []),
        { type: 'fact.add', payload: fact }, { type: 'assertion.add', payload: assertionPayload },
      ]), 'Relationship saved')
    } else if (kind === 'assertion' && selection?.kind === 'fact')
      await act(() => board.emit('assertion.add', { id: uuid(), fact_id: selection.id,
        ...values, created_at }), 'Evidence saved')
    else if (kind === 'assertion-edit' && editingAssertionId)
      await act(() => board.emit('assertion.update', { id: editingAssertionId, ...values }), 'Evidence updated')
  }

  const deleteItem = (kind: 'entity' | 'fact' | 'identifier', id: string) => {
    const text = kind === 'entity' ? 'Delete this entity and its relationships?' : kind === 'fact' ? 'Delete this relationship and all evidence?' : 'Delete this identifier?'
    if (!window.confirm(text)) return
    const type = kind === 'entity' ? 'entity.delete' : kind === 'fact' ? 'fact.delete' : 'identifier.delete'
    void act(async () => { await board.emit(type, { id }); if (kind !== 'identifier') setSelection(null) }, 'Deleted')
  }

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (event.key === 'Escape') {
        if (dialog) setDialog(null)
        else if (showLogImport) setShowLogImport(false)
        else setSelection(null)
        return
      }
      if (target && (['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || target.isContentEditable)) return
      if ((event.key === 'Delete' || event.key === 'Backspace') && selection) {
        event.preventDefault()
        deleteItem(selection.kind, selection.id)
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault()
        void board.undo().then(changed => setToast(changed ? 'Last change undone' : 'Nothing to undo'))
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [board.undo, dialog, selection, showLogImport])

  const navigate = (id: string) => {
    try { localStorage.setItem('factgraph:lastBoard', id) } catch { /* private mode */ }
    window.location.assign(`/boards/${id}`)
  }
  const copyLink = async () => {
    try { await navigator.clipboard.writeText(window.location.href); setToast('Board link copied') }
    catch { window.prompt('Copy board link:', window.location.href) }
  }
  const mcpEndpoint = `${window.location.origin}/mcp/`
  const restDocsEndpoint = `${window.location.origin}/docs`
  const copyMcpEndpoint = async () => {
    try { await navigator.clipboard.writeText(mcpEndpoint); setToast('MCP-Endpunkt kopiert') }
    catch { window.prompt('MCP-Endpunkt kopieren:', mcpEndpoint) }
  }
  const copySessionToken = async () => {
    try { await navigator.clipboard.writeText(board.sessionToken); setToast('Session token copied') }
    catch { window.prompt('Session token:', board.sessionToken) }
  }
  const copyValue = async (value: string, label: string) => {
    try { await navigator.clipboard.writeText(value); setToast(`${label} copied`) }
    catch { window.prompt(`Copy ${label}:`, value) }
  }
  const download = () => {
    const content = JSON.stringify({ format: 'factgraph-board-v1', boardId, name: board.boardName, actions: board.actions }, null, 2)
    const url = URL.createObjectURL(new Blob([content], { type: 'application/json' }))
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `factgraph-${boardId.slice(0, 8)}.json`
    anchor.style.display = 'none'
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
    window.setTimeout(() => URL.revokeObjectURL(url), 1000)
    setToast('Board export started')
  }
  const copyExport = async () => {
    const content = JSON.stringify({ format: 'factgraph-board-v1', boardId, name: board.boardName, actions: board.actions }, null, 2)
    try { await navigator.clipboard.writeText(content); setToast('Board JSON copied') }
    catch { window.prompt('Copy board JSON:', content) }
  }
  const importFile = async (file: File | undefined) => {
    if (!file) return
    setError('')
    try {
      const parsed = JSON.parse(await file.text()) as Record<string, unknown>
      if (parsed.format === 'factgraph-board-v1' && Array.isArray(parsed.actions))
        await act(() => board.importActions(parsed.actions as unknown[]), 'Actions imported')
      else await act(() => board.emitMany(legacyDrafts(parsed)), 'Legacy data imported')
    } catch (problem) { setError(problem instanceof Error ? problem.message : 'Import failed') }
  }

  const timeFacts = useMemo(() => data?.facts.filter(item => factIntersects(item, evidenceFrom || null, evidenceTo || null, includeUndated)) ?? [], [data, evidenceFrom, evidenceTo, includeUndated])
  const filteredFacts = useMemo(() => timeFacts.filter(item => stateFilter === 'all' || item.truth_state === stateFilter), [timeFacts, stateFilter])
  const visibleFacts = useMemo(() => {
    if (filteredFacts.length <= 350) return filteredFacts
    if (selection?.kind === 'entity') return filteredFacts.filter(item =>
      item.subject_id === selection.id || item.object_id === selection.id).slice(0, 350)
    if (search.trim() && data) {
      const names = new Set(data.entities.filter(item => item.name.toLocaleLowerCase().includes(search.toLocaleLowerCase())).map(item => item.id))
      return filteredFacts.filter(item => names.has(item.subject_id) || names.has(item.object_id)).slice(0, 350)
    }
    return filteredFacts.slice(0, 250)
  }, [data, filteredFacts, search, selection])
  const visibleEntities = useMemo(() => {
    if (!data) return []
    if (filteredFacts.length <= 350 && data.entities.length <= 350) return data.entities
    const ids = new Set(visibleFacts.flatMap(item => [item.subject_id, item.object_id]))
    if (selection?.kind === 'entity') ids.add(selection.id)
    if (search.trim()) for (const item of data.entities) {
      if (ids.size >= 350) break
      if (item.name.toLocaleLowerCase().includes(search.toLocaleLowerCase())) ids.add(item.id)
    }
    if (!ids.size) for (const item of data.entities.slice(0, 150)) ids.add(item.id)
    return data.entities.filter(item => ids.has(item.id))
  }, [data, filteredFacts.length, visibleFacts, selection, search])
  const searchResults = useMemo(() => data?.entities.filter(item =>
    `${item.name} ${item.kind} ${item.identifiers.map(identifier => identifier.raw_value).join(' ')}`.toLocaleLowerCase().includes(search.toLocaleLowerCase())
  ).slice(0, 150) ?? [], [data, search])
  const selectedFact = selection?.kind === 'fact' ? data?.facts.find(item => item.id === selection.id) : null
  const counts = Object.fromEntries(allStates.map(state => [state, timeFacts.filter(item => item.truth_state === state).length])) as Record<TruthState, number>

  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand"><div className="brand-mark"><GitBranch size={21} strokeWidth={2.6} /></div><div><strong>FactGraph</strong><small>BROWSER BOARDS</small></div></div>
      <div className="sidebar-section-label">BOARDS</div>
      <button className="workspace-card" onClick={() => setShowBoards(!showBoards)}><div className="workspace-icon"><Database size={18} /></div><div><strong>{board.boardName}</strong><span>Stored in browser</span></div><ChevronRight size={16} /></button>
      {showBoards && <div className="board-list">{board.boards.map(item => <button key={item.id} className={item.id === boardId ? 'active' : ''} onClick={() => navigate(item.id)}><span>{item.name}</span><small>{item.id.slice(0, 8)}</small></button>)}<button className="new-board" onClick={() => navigate(uuid())}><Plus size={14} /> New board</button></div>}
      <div className="sidebar-section-label list-heading">ENTITIES <span>{data?.entities.length ?? 0}</span></div>
      <div className="search-box"><Search size={16} /><input aria-label="Search entities" placeholder="Search entities…" value={search} onChange={event => setSearch(event.target.value)} />{search && <button onClick={() => setSearch('')}><X size={14} /></button>}</div>
      <div className="entity-list">
        {searchResults.map(entity => <button key={entity.id} className={`entity-list-item ${selection?.id === entity.id ? 'active' : ''}`} onClick={() => setSelection({ kind: 'entity', id: entity.id })}><IconForKind kind={entity.kind} color={entity.color} /><span><strong>{entity.name}</strong><small>{entity.kind} · {entity.identifiers.length} identifiers</small></span><ChevronRight size={15} /></button>)}
        {data && data.entities.length > 150 && <div className="sidebar-empty">Maximum 150 results · narrow your search</div>}
        {data && !searchResults.length && <div className="sidebar-empty">{search ? 'No matches.' : 'No entities yet.'}</div>}
      </div>
      <div className="sidebar-footer"><div className="local-badge"><span /> Browser storage · no sign-in</div><button onClick={() => setShowLogImport(true)}><Upload size={15} /> Import logs / KQL</button><button onClick={download}><ArrowDownToLine size={15} /> Export JSON</button><button onClick={() => importInput.current?.click()}><Upload size={15} /> Import JSON</button></div>
    </aside>

    <main className="main-area">
      <header className="topbar"><div className="breadcrumbs">WORKSPACE <ChevronRight size={14} /> <strong>Overview</strong></div><div className="top-actions"><button className="secondary-button" onClick={() => void board.undo().then(changed => setToast(changed ? 'Last change undone' : 'Nothing to undo'))} title="Undo last change (Ctrl/Cmd+Z)"><Undo2 size={16} /> Undo</button><button className="secondary-button" onClick={() => { setError(''); setDialog('source') }}><FileText size={16} /> Source</button><button className="secondary-button" onClick={() => { setError(''); setDialog('entity') }}><Plus size={17} /> Entity</button><button className="primary-button" onClick={() => { setError(''); setDialog('fact') }} disabled={!data || data.entities.length < 2}><Link2 size={17} /> Relationship</button></div></header>
      <div className="integration-note"><span><strong>API</strong> · <button className="integration-action" onClick={() => void copyMcpEndpoint()} title="Copy MCP endpoint">MCP</button> · <a href={restDocsEndpoint} target="_blank" rel="noreferrer">REST</a> · <button className="integration-action" onClick={() => { const endpoint = `${window.location.origin}/api/boards/${boardId}`; void navigator.clipboard.writeText(endpoint).then(() => setToast('REST board endpoint copied')).catch(() => window.prompt('REST board endpoint:', endpoint)) }}>Copy</button> · <button className="integration-action" onClick={() => void copySessionToken()} title="Copy session token">Token</button></span><small>Same token for REST + MCP · keep board open</small></div>
      <div className="page-heading"><div><div className="eyebrow">INVESTIGATION CANVAS</div><h1>Make connections visible<span>.</span></h1><p>Entities, relationships and evidence in one place.</p></div><div className="heading-meta"><span className="live-dot" /> Stored in browser</div></div>
      <div className="board-toolbar"><div className="board-identity"><span>BOARD</span><strong>{board.boardName}</strong><button className="copy-board-id" title="Copy full board ID" onClick={() => void copyValue(boardId, 'Board ID')}><code>{boardId.slice(0, 8)}…</code><Copy size={12} /></button><button title="Rename board" onClick={() => { const value = window.prompt('Board name', board.boardName); if (value?.trim()) void act(() => board.emit('board.rename', { name: value.trim() }), 'Board renamed') }}>Rename</button></div><div className="board-tools"><button onClick={() => void copyLink()} title="Copy board link"><Copy size={15} /> Link</button><button onClick={() => setShowLogImport(true)} title="Import activity logs or KQL results"><Upload size={15} /> Logs/KQL</button><button onClick={() => importInput.current?.click()} title="Import JSON"> <Upload size={15} /> Import</button><button onClick={download} title="Save JSON file"><ArrowDownToLine size={15} /> Export</button><button onClick={() => void copyExport()} title="Copy board JSON"><Copy size={15} /> JSON</button><button onClick={() => navigate(uuid())} title="New board"><Plus size={15} /> Board</button></div><div className="presence-group"><span className={`connection-dot ${board.connected ? 'online' : ''}`} />{board.connected ? <Wifi size={15} /> : <WifiOff size={15} />}<span>{board.connected ? `${board.peers.length + 1} online` : 'Offline'}</span>{board.peers.map(peer => <span key={peer.id} className="peer-avatar" title={peer.name} style={{ background: peerColor(peer.id) }}>{peer.name.slice(0, 1).toUpperCase()}</span>)}<button className="profile-button" onClick={() => { const value = window.prompt('Your display name', board.name); if (value?.trim()) board.setName(value) }} title="Change display name"><Users size={14} /> {board.name}</button></div></div>
      {board.ready && !board.connected && <div className="offline-note">Relay offline: changes stay in this browser and sync when the connection returns.</div>}
      <EvidenceWindow facts={data?.facts ?? []} from={evidenceFrom} to={evidenceTo} includeUndated={includeUndated} onIncludeUndatedChange={setIncludeUndated} onFromChange={setEvidenceFrom} onToChange={setEvidenceTo} onReset={() => { setEvidenceFrom(''); setEvidenceTo('') }} />
      <div className="workspace-grid">
        <div className="visual-column"><section className="workspace-tabs" aria-label="Board views"><div className="tab-list" role="tablist" aria-label="Board views"><button role="tab" aria-selected={activeTab === 'graph'} className={activeTab === 'graph' ? 'active' : ''} onClick={() => setActiveTab('graph')}><GitBranch size={15} /> Graph <b>{data?.entities.length ?? 0}</b></button><button role="tab" aria-selected={activeTab === 'timeline'} className={activeTab === 'timeline' ? 'active' : ''} onClick={() => setActiveTab('timeline')}><Activity size={15} /> Timeline <b>{timelineEvents(filteredFacts).length}</b></button><button role="tab" aria-selected={activeTab === 'activity'} className={activeTab === 'activity' ? 'active' : ''} onClick={() => setActiveTab('activity')}><Activity size={15} /> Activity <b>{board.actions.length}</b></button></div><div className="tab-panel" role="tabpanel">{activeTab === 'graph' && <section className="graph-card"><div className="card-header"><div><div className="card-title"><GitBranch size={18} /> Relationship graph</div><span>Interactive view of all entities and facts</span></div><div className="graph-count">{visibleEntities.length} / {data?.entities.length ?? 0} NODES · {visibleFacts.length} / {filteredFacts.length} EDGES</div></div><div className="filter-row"><button className={stateFilter === 'all' ? 'filter-chip active' : 'filter-chip'} onClick={() => setStateFilter('all')}>All <b>{data?.facts.length ?? 0}</b></button>{allStates.map(state => <button key={state} className={`filter-chip ${state} ${stateFilter === state ? 'active' : ''}`} onClick={() => setStateFilter(stateFilter === state ? 'all' : state)}><span className="state-dot" />{labels[state]} <b>{counts[state]}</b></button>)}</div>
          <div className="graph-stage">{data && <GraphView entities={visibleEntities} facts={visibleFacts} selection={selection} search={search} pathIds={[]} onSelect={setSelection} onCreateNode={() => setDialog('entity')} onCreateRelation={entityId => { setSelection({ kind: 'entity', id: entityId }); setDialog('fact') }} onMoveNode={(id, position) => void board.emit('entity.position', { id, ...position })} />}{data && data.entities.length === 0 && <div className="empty-overlay"><div className="empty-graphic"><GitBranch size={31} /></div><h2>Your graph starts here.</h2><p>Create entities and connect them with evidence-backed statements, or load a small example dataset.</p><div><button className="primary-button" onClick={() => setDialog('entity')}><Plus size={16} /> First entity</button><button className="secondary-button" onClick={() => void act(() => board.emitMany(demoDrafts()), 'Example data loaded')}><Sparkles size={16} /> Load example</button></div></div>}</div>
          <div className="legend"><span><i className="legend-line supported" /> Supported</span><span><i className="legend-line disputed" /> Disputed</span><span><i className="legend-line refuted" /> Refuted</span><span><i className="legend-line unknown" /> Unknown</span></div>
        </section>}
        {activeTab === 'timeline' && data && <TimelinePanel data={data} facts={filteredFacts} selection={selection} onSelect={setSelection} />}{activeTab === 'activity' && <ActivityPanel actions={board.actions} />}</div></section></div>
        {data && <DetailPanel data={data} selection={selection} onAdd={kind => { setError(''); setDialog(kind) }} onDelete={deleteItem} onCopy={(value, label) => void copyValue(value, label)} onEditEvidence={id => { setEditingAssertionId(id); setError(''); setDialog('assertion-edit') }} onRetract={id => void act(() => board.emit('assertion.retract', { id, retracted_at: new Date().toISOString() }), 'Evidence retracted')} onClose={() => setSelection(null)} />}
      </div>
      {selectedFact && <div className="selection-footnote"><Fingerprint size={14} /> Selected fact: {selectedFact.id}</div>}
    </main>
    {dialog && data && <Dialog key={`${dialog}:${editingAssertionId ?? ''}`} kind={dialog} data={data} selection={selection} editingAssertionId={editingAssertionId} busy={busy} error={error} onClose={() => { setDialog(null); setEditingAssertionId(null) }} onSubmit={submit} />}
    {showLogImport && <LogImportDialog boardId={boardId} sessionToken={board.sessionToken} onClose={() => setShowLogImport(false)} onDone={summary => { setShowLogImport(false); setToast(summary) }} />}
    <input ref={importInput} type="file" accept="application/json,.json" hidden onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; void importFile(file) }} />
    {board.storageError && <div className="toast error">{board.storageError}</div>}
    {error && !dialog && <div className="toast error" onClick={() => setError('')}>{error} <X size={15} /></div>}
    {toast && <div className="toast success">{toast}</div>}
  </div>
}
