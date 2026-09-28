import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Activity, ArrowDownToLine, ArrowRight, Box, ChevronRight, CircleHelp, Copy,
  Database, FileText, Fingerprint, GitBranch, Link2, Plus, Search,
  ShieldCheck, Sparkles, Trash2, Upload, Users, Wifi, WifiOff, X,
} from 'lucide-react'
import GraphView from './GraphView'
import { demoDrafts, factKey, legacyDrafts, normalizeIdentifier, type BoardAction } from './board'
import { useBoard } from './useBoard'
import { uuid } from './uuid'
import { entityVisual } from './entityVisual'
import type { Assertion, GraphData, Identifier, TruthState } from './types'

type Selection = { kind: 'entity' | 'fact'; id: string } | null
type DialogKind = 'entity' | 'fact' | 'source' | 'identifier' | 'assertion' | null

const labels: Record<TruthState, string> = {
  supported: 'Gestützt', disputed: 'Umstritten', refuted: 'Widerlegt', unknown: 'Ungeklärt',
}
const allStates: TruthState[] = ['supported', 'disputed', 'refuted', 'unknown']
const kinds = ['User', 'Person', 'Organisation', 'Device', 'Service', 'Service Principal', 'Managed Identity', 'AKS-Cluster', 'AKS-Workload', 'System', 'IP', 'Datei', 'Repository', 'Prozess', 'Umgebungsvariable', 'Credential', 'Secret', 'Azure-Ressource', 'Blob-Storage', 'Ort', 'Ereignis', 'Dokument', 'Sonstiges']
const customKindValue = '__custom__'
const schemes = ['hostname', 'fqdn', 'ip', 'email', 'url', 'resource_id', 'external_id', 'other']

function date(value: string | null | undefined) {
  if (!value) return 'Ohne Datum'
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleDateString('de-DE', { day: '2-digit', month: 'short', year: 'numeric' })
}

function nameOf(data: GraphData, id: string) {
  return data.entities.find(item => item.id === id)?.name ?? 'Unbekannt'
}

function sourceOf(data: GraphData, id: string | null) {
  return data.sources.find(item => item.id === id)
}

function IconForKind({ kind }: { kind: string }) {
  const visual = entityVisual(kind)
  return <span className="entity-avatar" style={{ background: visual.fill, border: `1px solid ${visual.border}` }}>{kind.slice(0, 1).toUpperCase() || <Box size={16} />}</span>
}

function StatePill({ state }: { state: TruthState }) {
  return <span className={`state-pill ${state}`}><span className="state-dot" />{labels[state]}</span>
}

function SourceLine({ data, sourceId }: { data: GraphData; sourceId: string | null }) {
  const source = sourceOf(data, sourceId)
  return <span>{source ? source.title : 'Manuelle Eingabe'}</span>
}

function DetailPanel({ data, selection, onAdd, onDelete, onRetract, onClose }: {
  data: GraphData; selection: Selection; onAdd: (kind: DialogKind) => void;
  onDelete: (kind: 'entity' | 'fact' | 'identifier', id: string) => void;
  onRetract: (id: string) => void; onClose: () => void;
}) {
  if (!selection) return <aside className="detail-panel detail-empty">
    <div className="detail-head"><span>INSPEKTOR</span><CircleHelp size={17} /></div>
    <div className="detail-intro-icon"><GitBranch size={30} /></div>
    <h2>Den Zusammenhang verstehen.</h2>
    <p>Wähle eine Entität oder Beziehung im Graphen aus. Hier erscheinen Kennungen, Quellen und die Aussagen, auf denen der Status beruht.</p>
    <div className="detail-tip"><ShieldCheck size={18} /><span>Der Status einer Beziehung wird aus aktiven Aussagen berechnet.</span></div>
  </aside>

  if (selection.kind === 'entity') {
    const entity = data.entities.find(item => item.id === selection.id)
    if (!entity) return null
    const related = data.facts.filter(item => item.subject_id === entity.id || item.object_id === entity.id)
    return <aside className="detail-panel">
      <div className="detail-head"><span>ENTITÄT</span><button className="icon-button" onClick={onClose} title="Schließen"><X size={17} /></button></div>
      <div className="detail-title-row"><IconForKind kind={entity.kind} /><div><div className="detail-kind">{entity.kind}</div><h2>{entity.name}</h2></div></div>
      {entity.description && <p className="detail-description">{entity.description}</p>}
      <div className="id-line">ID {entity.id.slice(0, 8)}…</div>
      <section className="detail-section">
        <div className="section-heading"><h3>Kennungen <small>{entity.identifiers.length}</small></h3><button className="text-button" onClick={() => onAdd('identifier')}><Plus size={15} /> Hinzufügen</button></div>
        {entity.identifiers.length ? entity.identifiers.map(identifier => <IdentifierRow key={identifier.id} identifier={identifier} data={data} onDelete={() => onDelete('identifier', identifier.id)} />) :
          <p className="muted small">Noch keine Kennungen erfasst.</p>}
      </section>
      <section className="detail-section">
        <div className="section-heading"><h3>Beziehungen <small>{related.length}</small></h3></div>
        {related.length ? related.map(fact => <div key={fact.id} className="related-row"><StatePill state={fact.truth_state} /><span>{fact.predicate} · {nameOf(data, fact.subject_id === entity.id ? fact.object_id : fact.subject_id)}</span></div>) :
          <p className="muted small">Noch keine Beziehungen erfasst.</p>}
      </section>
      <button className="primary-button link-from-node" onClick={() => onAdd('fact')}><Link2 size={15} /> Von hier Kante erstellen</button>
      <div className="detail-bottom"><button className="danger-link" onClick={() => onDelete('entity', entity.id)}><Trash2 size={15} /> Entität löschen</button></div>
    </aside>
  }

  const fact = data.facts.find(item => item.id === selection.id)
  if (!fact) return null
  return <aside className="detail-panel">
    <div className="detail-head"><span>BEZIEHUNG / FACT</span><button className="icon-button" onClick={onClose} title="Schließen"><X size={17} /></button></div>
    <div className="fact-heading"><span>{nameOf(data, fact.subject_id)}</span><ArrowRight size={19} /><span>{nameOf(data, fact.object_id)}</span></div>
    <div className="predicate-label">{fact.predicate}</div>
    <div className="fact-state"><StatePill state={fact.truth_state} /><span>{fact.assertions.filter(a => !a.retracted_at).length} aktive Aussagen</span></div>
    <div className="fact-meta"><span>Gültig ab</span><strong>{date(fact.valid_from)}</strong></div>
    {fact.valid_to && <div className="fact-meta"><span>Gültig bis</span><strong>{date(fact.valid_to)}</strong></div>}
    <section className="detail-section">
      <div className="section-heading"><h3>Aussagen <small>{fact.assertions.length}</small></h3><button className="text-button" onClick={() => onAdd('assertion')}><Plus size={15} /> Aussage</button></div>
      {fact.assertions.map(assertion => <AssertionRow key={assertion.id} assertion={assertion} data={data} onRetract={() => onRetract(assertion.id)} />)}
    </section>
    <div className="truth-explanation"><ShieldCheck size={18} /><span>Stützung und Widerlegung können nebeneinander bestehen. Zurückgezogene Aussagen bleiben nachvollziehbar.</span></div>
    <div className="detail-bottom"><button className="danger-link" onClick={() => onDelete('fact', fact.id)}><Trash2 size={15} /> Beziehung löschen</button></div>
  </aside>
}

function IdentifierRow({ identifier, data, onDelete }: { identifier: Identifier; data: GraphData; onDelete: () => void }) {
  return <div className="identifier-row">
    <div className="identifier-top"><span className="scheme-badge">{identifier.scheme}</span><button title="Kennung löschen" className="row-delete" onClick={onDelete}><X size={14} /></button></div>
    <div className="identifier-value">{identifier.raw_value}</div>
    <div className="identifier-meta">{identifier.namespace && <span>{identifier.namespace} · </span>}<SourceLine data={data} sourceId={identifier.source_id} /> · {Math.round(identifier.confidence * 100)} %</div>
    {(identifier.valid_from || identifier.valid_to) && <div className="identifier-meta">{date(identifier.valid_from)} – {identifier.valid_to ? date(identifier.valid_to) : 'heute'}</div>}
  </div>
}

function AssertionRow({ assertion, data, onRetract }: { assertion: Assertion; data: GraphData; onRetract: () => void }) {
  const source = sourceOf(data, assertion.source_id)
  return <div className={`assertion-row ${assertion.retracted_at ? 'retracted' : ''}`}>
    <div className="assertion-top"><span className={assertion.stance === 'supports' ? 'supports-text' : 'refutes-text'}>{assertion.stance === 'supports' ? '● Stützt' : '● Widerlegt'}</span><span>{Math.round(assertion.confidence * 100)} %</span></div>
    <div className="assertion-source"><FileText size={14} /><SourceLine data={data} sourceId={assertion.source_id} /></div>
    {source && (source.excerpt || source.uri) && <details className="source-details"><summary>Quelle ansehen</summary>{source.excerpt && <blockquote>{source.excerpt}</blockquote>}{source.uri && <div>{source.uri}</div>}</details>}
    {assertion.note && <p>{assertion.note}</p>}
    <div className="assertion-footer"><span>{date(assertion.created_at)}{assertion.retracted_at && ' · Zurückgezogen'}</span>{!assertion.retracted_at && <button onClick={onRetract}>Zurückziehen</button>}</div>
  </div>
}

function Dialog({ kind, data, selection, busy, error, onClose, onSubmit }: {
  kind: Exclude<DialogKind, null>; data: GraphData; selection: Selection; busy: boolean;
  error: string; onClose: () => void; onSubmit: (kind: Exclude<DialogKind, null>, values: Record<string, unknown>) => Promise<void>;
}) {
  const titles = { entity: 'Neue Entität', fact: 'Neue Beziehung', source: 'Neue Quelle', identifier: 'Kennung hinzufügen', assertion: 'Aussage hinzufügen' }
  const [stance, setStance] = useState<'supports' | 'refutes'>('supports')
  const [newTarget, setNewTarget] = useState(selection?.kind === 'entity')
  const [customEntityKind, setCustomEntityKind] = useState(false)
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
    if (kind === 'entity') values = { name: get('name'), kind: entityKind, description: get('description') }
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
    else values = { stance, confidence, source_id: get('source_id') || null, note: get('note') }
    if (kind === 'entity' && !entityKind) { setLocalError('Bitte einen Typ angeben.'); return }
    if (kind === 'fact' && newTarget && !targetKind) { setLocalError('Bitte einen Typ für den neuen Knoten angeben.'); return }
    if (kind === 'fact' && !newTarget && values.subject_id === values.object_id) { setLocalError('Bitte zwei verschiedene Entitäten wählen.'); return }
    setLocalError('')
    await onSubmit(kind, values)
  }
  const sourceSelect = <label>Quelle <span className="optional">optional</span><select name="source_id" defaultValue=""><option value="">Manuelle Eingabe</option>{data.sources.map(source => <option key={source.id} value={source.id}>{source.title}</option>)}</select></label>
  const confidenceField = <label>Konfidenz <span className="optional">0–100 %</span><input name="confidence" type="number" min="0" max="100" defaultValue="100" /></label>
  const dateFields = <div className="field-grid"><label>Gültig ab <span className="optional">optional</span><input name="valid_from" type="datetime-local" /></label><label>Gültig bis <span className="optional">optional</span><input name="valid_to" type="datetime-local" /></label></div>
  return <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}>
    <div className="modal" role="dialog" aria-modal="true" aria-label={titles[kind]}>
      <div className="modal-header"><div><span className="eyebrow">FACTGRAPH · ERFASSEN</span><h2>{titles[kind]}</h2></div><button className="icon-button" onClick={onClose}><X size={20} /></button></div>
      <form onSubmit={submit}>
        {kind === 'entity' && <><label>Name<input name="name" autoFocus required placeholder="z. B. Webserver 01" /></label><label>Typ<select name="kind" defaultValue={kinds[0]} onChange={event => setCustomEntityKind(event.target.value === customKindValue)}>{kinds.map(value => <option key={value}>{value}</option>)}<option value={customKindValue}>Eigener Typ…</option></select>{customEntityKind && <input name="custom_kind" required autoFocus placeholder="z. B. SaaS-Anwendung" />}</label><label>Beschreibung <span className="optional">optional</span><textarea name="description" rows={3} placeholder="Was ist über diese Entität bekannt?" /></label></>}
        {kind === 'source' && <><label>Titel<input name="title" autoFocus required placeholder="z. B. EDR Export vom 27.09." /></label><label>URL oder Referenz <span className="optional">optional</span><input name="uri" placeholder="https://… oder Dateipfad" /></label><label>Auszug <span className="optional">optional</span><textarea name="excerpt" rows={4} placeholder="Relevante Stelle aus der Quelle" /></label></>}
        {kind === 'identifier' && <><div className="modal-context">Entität: <strong>{selection?.kind === 'entity' ? nameOf(data, selection.id) : ''}</strong></div><div className="field-grid"><label>Schema<select name="scheme">{schemes.map(value => <option key={value}>{value}</option>)}</select></label><label>Namespace <span className="optional">optional</span><input name="namespace" placeholder="z. B. prod" /></label></div><label>Wert<input name="raw_value" autoFocus required placeholder="Externer Kennwert" /></label>{dateFields}{sourceSelect}{confidenceField}</>}
        {kind === 'fact' && <><div className="field-grid"><label>Von<select name="subject_id" defaultValue={selection?.kind === 'entity' ? selection.id : ''} required><option value="" disabled>Entität wählen</option>{data.entities.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><label>Nach<div className="target-choice"><button type="button" className={newTarget ? 'active' : ''} onClick={() => setNewTarget(true)}>Neuer Knoten</button><button type="button" className={!newTarget ? 'active' : ''} onClick={() => setNewTarget(false)}>Vorhandener Knoten</button></div></label></div>{newTarget ? <div className="field-grid"><label>Name des neuen Knotens<input name="new_object_name" required placeholder="z. B. Azure-Secret" /></label><label>Typ<select name="new_object_kind" defaultValue={kinds[0]} onChange={event => setCustomTargetKind(event.target.value === customKindValue)}>{kinds.map(value => <option key={value}>{value}</option>)}<option value={customKindValue}>Eigener Typ…</option></select>{customTargetKind && <input name="custom_new_object_kind" required autoFocus placeholder="z. B. SaaS-Anwendung" />}</label></div> : <label>Zielknoten<select name="object_id" defaultValue="" required><option value="" disabled>Entität wählen</option>{data.entities.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>}<label>Beziehung / Prädikat<input name="predicate" autoFocus required placeholder="z. B. liest, erhält Zugriff auf, accessed" /></label>{dateFields}<div className="form-divider">Erste Aussage zu dieser Beziehung</div><StanceSelect value={stance} onChange={setStance} />{sourceSelect}{confidenceField}<label>Begründung <span className="optional">optional</span><textarea name="note" rows={2} placeholder="Worauf stützt sich diese Aussage?" /></label></>}
        {kind === 'assertion' && <><div className="modal-context">Beziehung: <strong>{selection?.kind === 'fact' ? data.facts.find(item => item.id === selection.id)?.predicate : ''}</strong></div><StanceSelect value={stance} onChange={setStance} />{sourceSelect}{confidenceField}<label>Begründung <span className="optional">optional</span><textarea name="note" rows={3} placeholder="Was sagt die Quelle konkret?" /></label></>}
        {(error || localError) && <div className="form-error">{localError || error}</div>}
        <div className="modal-actions"><button type="button" className="secondary-button" onClick={onClose}>Abbrechen</button><button className="primary-button" disabled={busy}>{busy ? 'Speichere…' : 'Speichern'} <ArrowRight size={16} /></button></div>
      </form>
    </div>
  </div>
}

function StanceSelect({ value, onChange }: { value: 'supports' | 'refutes'; onChange: (value: 'supports' | 'refutes') => void }) {
  return <div className="stance-field"><span>Aussage</span><div className="stance-options"><button type="button" className={value === 'supports' ? 'active supports' : ''} onClick={() => onChange('supports')}>● Stützt</button><button type="button" className={value === 'refutes' ? 'active refutes' : ''} onClick={() => onChange('refutes')}>● Widerlegt</button></div></div>
}

function LogImportDialog({ boardId, onClose, onDone }: {
  boardId: string; onClose: () => void; onDone: (summary: string) => void;
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setBusy(true); setError('')
    try {
      const response = await fetch(`/api/boards/${boardId}/imports/file`, {
        method: 'POST', body: new FormData(event.currentTarget),
      })
      const result = await response.json() as Record<string, unknown>
      if (!response.ok) throw new Error(String(result.detail ?? 'Import fehlgeschlagen'))
      onDone(`${result.rows} Logzeilen · ${result.entities} Knoten · ${result.relations} Kanten · ${result.evidence} Belege`)
    } catch (problem) { setError(problem instanceof Error ? problem.message : 'Import fehlgeschlagen') }
    finally { setBusy(false) }
  }
  return <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}>
    <div className="modal" role="dialog" aria-modal="true" aria-label="Aktivitätslogs importieren">
      <div className="modal-header"><div><span className="eyebrow">FACTGRAPH · EVIDENCE</span><h2>Logs und KQL-Ergebnisse</h2></div><button className="icon-button" onClick={onClose}><X size={20} /></button></div>
      <form onSubmit={event => void submit(event)}>
        <p className="import-explanation">CSV, JSON oder JSONL mit Ergebniszeilen importieren. KQL wird hier nicht ausgeführt: Die Abfrage wird zusammen mit den gelieferten Zeilen als Quelle gespeichert.</p>
        <label>Datei<input name="file" type="file" accept=".csv,.json,.jsonl,.ndjson" required /></label>
        <label>Quellentitel<input name="title" defaultValue="Access Logs" required /></label>
        <label>KQL-Abfrage <span className="optional">optional</span><textarea name="query" rows={4} placeholder="AccessLogs | project IPAddress, FilePath, TimeGenerated" /></label>
        <div className="field-grid"><label>Quellspalte <span className="optional">leer = automatisch</span><input name="subject_field" placeholder="IPAddress" /></label><label>Zielspalte <span className="optional">leer = automatisch</span><input name="object_field" placeholder="FilePath" /></label></div>
        <div className="field-grid"><label>Quelltyp<input name="subject_kind" defaultValue="IP" /></label><label>Zieltyp<input name="object_kind" defaultValue="Datei" /></label></div>
        <div className="field-grid"><label>Kante / Beziehung<input name="predicate" defaultValue="accessed" required /></label><label>Kanten-Spalte <span className="optional">optional</span><input name="predicate_field" placeholder="OperationName" /></label></div>
        {error && <div className="form-error">{error}</div>}
        <div className="modal-actions"><button type="button" className="secondary-button" onClick={onClose}>Abbrechen</button><button className="primary-button" disabled={busy}>{busy ? 'Importiere…' : 'Ergebnisse importieren'} <ArrowRight size={16} /></button></div>
      </form>
    </div>
  </div>
}

function currentBoardId() {
  const fromUrl = window.location.pathname.match(/^\/boards\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?$/i)?.[1]
  let stored = ''
  try { stored = localStorage.getItem('factgraph:lastBoard') ?? '' } catch { /* private mode */ }
  const id = fromUrl ?? (/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(stored) ? stored : uuid())
  window.history.replaceState(null, '', `/boards/${id}`)
  try { localStorage.setItem('factgraph:lastBoard', id) } catch { /* private mode */ }
  return id
}

function actionLabel(action: BoardAction) {
  const names: Record<BoardAction['type'], string> = {
    'board.rename': 'Board umbenannt', 'entity.add': 'Entität angelegt',
    'entity.position': 'Knoten verschoben', 'entity.delete': 'Entität gelöscht', 'identifier.add': 'Kennung hinzugefügt',
    'identifier.delete': 'Kennung gelöscht', 'source.add': 'Quelle angelegt',
    'fact.add': 'Beziehung angelegt', 'fact.delete': 'Beziehung gelöscht',
    'assertion.add': 'Aussage hinzugefügt', 'assertion.retract': 'Aussage zurückgezogen',
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
  return <section className="timeline-panel"><div className="card-header"><div><div className="card-title"><Activity size={18} /> Zeitachse</div><span>Beziehungen nach Gültigkeitsbeginn oder Erfassung</span></div><span className="mini-count">{facts.length} Ereignisse</span></div><div className="timeline-list">{facts.length ? [...facts].sort((a, b) => (a.valid_from || a.created_at).localeCompare(b.valid_from || b.created_at)).map(fact => <button key={fact.id} className={`timeline-item ${selection?.id === fact.id ? 'active' : ''}`} onClick={() => onSelect({ kind: 'fact', id: fact.id })}><span className={`timeline-dot ${fact.truth_state}`} /><span className="timeline-date">{date(fact.valid_from || fact.created_at)}</span><strong>{nameOf(data, fact.subject_id)} <span>→</span> {nameOf(data, fact.object_id)}</strong><small>{fact.predicate}</small></button>) : <div className="timeline-empty">Beziehungen mit Datum erscheinen hier.</div>}</div></section>
}

function ActivityPanel({ actions }: { actions: BoardAction[] }) {
  return <section className="activity-panel"><div className="card-header"><div><div className="card-title"><Activity size={18} /> Aktionen</div><span>Synchronisierte Änderungen dieses Boards</span></div><span className="mini-count">{actions.length} {actions.length === 1 ? 'Aktion' : 'Aktionen'}</span></div><div className="activity-list">{actions.length ? [...actions].slice(-6).reverse().map(action => <div key={action.id} className="activity-item"><span className="activity-mark" style={{ background: peerColor(action.actor) }} /><span><strong>{actionLabel(action)}</strong><small>{action.author} · {date(action.at)}</small></span></div>) : <span className="timeline-empty">Noch keine Aktionen.</span>}</div></section>
}

export default function App() {
  const [boardId] = useState(currentBoardId)
  const board = useBoard(boardId)
  const data = board.ready ? board.data : null
  const [selection, setSelection] = useState<Selection>(null)
  const [dialog, setDialog] = useState<DialogKind>(null)
  const [search, setSearch] = useState('')
  const [stateFilter, setStateFilter] = useState<TruthState | 'all'>('all')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [toast, setToast] = useState('')
  const [showBoards, setShowBoards] = useState(false)
  const [showLogImport, setShowLogImport] = useState(false)
  const [activeTab, setActiveTab] = useState<WorkspaceTab>('graph')
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
    if (kind === 'entity') await act(() => board.emit('entity.add', { id: uuid(), ...values, created_at }), 'Entität gespeichert')
    else if (kind === 'source') await act(() => board.emit('source.add', { id: uuid(), ...values, created_at }), 'Quelle gespeichert')
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
      if (existing) await act(() => board.emit('assertion.add', assertionPayload), 'Aussage zur vorhandenen Beziehung hinzugefügt')
      else await act(() => board.emitMany([
        ...(newObjectId ? [{ type: 'entity.add' as const, payload: { id: newObjectId,
          name: newObjectName, kind: String(values.new_object_kind || 'Sonstiges'),
          description: '', created_at } }] : []),
        { type: 'fact.add', payload: fact }, { type: 'assertion.add', payload: assertionPayload },
      ]), 'Beziehung gespeichert')
    } else if (kind === 'assertion' && selection?.kind === 'fact')
      await act(() => board.emit('assertion.add', { id: uuid(), fact_id: selection.id,
        ...values, created_at }), 'Aussage gespeichert')
  }

  const deleteItem = (kind: 'entity' | 'fact' | 'identifier', id: string) => {
    const text = kind === 'entity' ? 'Diese Entität und ihre Beziehungen wirklich löschen?' : kind === 'fact' ? 'Diese Beziehung und alle Aussagen wirklich löschen?' : 'Diese Kennung wirklich löschen?'
    if (!window.confirm(text)) return
    const type = kind === 'entity' ? 'entity.delete' : kind === 'fact' ? 'fact.delete' : 'identifier.delete'
    void act(async () => { await board.emit(type, { id }); if (kind !== 'identifier') setSelection(null) }, 'Eintrag gelöscht')
  }

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (target && (['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || target.isContentEditable)) return
      if (event.key === 'Escape') {
        if (dialog) setDialog(null)
        else if (showLogImport) setShowLogImport(false)
        else setSelection(null)
        return
      }
      if ((event.key === 'Delete' || event.key === 'Backspace') && selection) {
        event.preventDefault()
        deleteItem(selection.kind, selection.id)
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [dialog, selection, showLogImport])

  const navigate = (id: string) => {
    try { localStorage.setItem('factgraph:lastBoard', id) } catch { /* private mode */ }
    window.location.assign(`/boards/${id}`)
  }
  const copyLink = async () => {
    try { await navigator.clipboard.writeText(window.location.href); setToast('Board-Link kopiert') }
    catch { window.prompt('Board-Link kopieren:', window.location.href) }
  }
  const mcpEndpoint = `${window.location.origin}/mcp/`
  const restDocsEndpoint = `${window.location.origin}/docs`
  const copyMcpEndpoint = async () => {
    try { await navigator.clipboard.writeText(mcpEndpoint); setToast('MCP-Endpunkt kopiert') }
    catch { window.prompt('MCP-Endpunkt kopieren:', mcpEndpoint) }
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
    setToast('Board-Export gestartet')
  }
  const copyExport = async () => {
    const content = JSON.stringify({ format: 'factgraph-board-v1', boardId, name: board.boardName, actions: board.actions }, null, 2)
    try { await navigator.clipboard.writeText(content); setToast('Board-JSON kopiert') }
    catch { window.prompt('Board-JSON kopieren:', content) }
  }
  const importFile = async (file: File | undefined) => {
    if (!file) return
    setError('')
    try {
      const parsed = JSON.parse(await file.text()) as Record<string, unknown>
      if (parsed.format === 'factgraph-board-v1' && Array.isArray(parsed.actions))
        await act(() => board.importActions(parsed.actions as unknown[]), 'Aktionen importiert')
      else await act(() => board.emitMany(legacyDrafts(parsed)), 'Alter Datenstand importiert')
    } catch (problem) { setError(problem instanceof Error ? problem.message : 'Import fehlgeschlagen') }
  }

  const filteredFacts = useMemo(() => data?.facts.filter(item => stateFilter === 'all' || item.truth_state === stateFilter) ?? [], [data, stateFilter])
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
  const counts = Object.fromEntries(allStates.map(state => [state, data?.facts.filter(item => item.truth_state === state).length ?? 0])) as Record<TruthState, number>

  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand"><div className="brand-mark"><GitBranch size={21} strokeWidth={2.6} /></div><div><strong>FactGraph</strong><small>BROWSER BOARDS</small></div></div>
      <div className="sidebar-section-label">BOARDS</div>
      <button className="workspace-card" onClick={() => setShowBoards(!showBoards)}><div className="workspace-icon"><Database size={18} /></div><div><strong>{board.boardName}</strong><span>Im Browser gespeichert</span></div><ChevronRight size={16} /></button>
      {showBoards && <div className="board-list">{board.boards.map(item => <button key={item.id} className={item.id === boardId ? 'active' : ''} onClick={() => navigate(item.id)}><span>{item.name}</span><small>{item.id.slice(0, 8)}</small></button>)}<button className="new-board" onClick={() => navigate(uuid())}><Plus size={14} /> Neues Board</button></div>}
      <div className="sidebar-section-label list-heading">ENTITÄTEN <span>{data?.entities.length ?? 0}</span></div>
      <div className="search-box"><Search size={16} /><input aria-label="Entitäten suchen" placeholder="Entitäten suchen…" value={search} onChange={event => setSearch(event.target.value)} />{search && <button onClick={() => setSearch('')}><X size={14} /></button>}</div>
      <div className="entity-list">
        {searchResults.map(entity => <button key={entity.id} className={`entity-list-item ${selection?.id === entity.id ? 'active' : ''}`} onClick={() => setSelection({ kind: 'entity', id: entity.id })}><IconForKind kind={entity.kind} /><span><strong>{entity.name}</strong><small>{entity.kind} · {entity.identifiers.length} Kennungen</small></span><ChevronRight size={15} /></button>)}
        {data && data.entities.length > 150 && <div className="sidebar-empty">Maximal 150 Treffer · Suche eingrenzen</div>}
        {data && !searchResults.length && <div className="sidebar-empty">{search ? 'Keine Treffer.' : 'Noch keine Entitäten.'}</div>}
      </div>
      <div className="sidebar-footer"><div className="local-badge"><span /> Browser-Speicher · ohne Anmeldung</div><button onClick={() => setShowLogImport(true)}><Upload size={15} /> Logs / KQL importieren</button><button onClick={download}><ArrowDownToLine size={15} /> JSON exportieren</button><button onClick={() => importInput.current?.click()}><Upload size={15} /> JSON importieren</button></div>
    </aside>

    <main className="main-area">
      <header className="topbar"><div className="breadcrumbs">WORKSPACE <ChevronRight size={14} /> <strong>Übersicht</strong></div><div className="top-actions"><button className="secondary-button" onClick={() => { setError(''); setDialog('source') }}><FileText size={16} /> Quelle</button><button className="secondary-button" onClick={() => { setError(''); setDialog('entity') }}><Plus size={17} /> Entität</button><button className="primary-button" onClick={() => { setError(''); setDialog('fact') }} disabled={!data || data.entities.length < 2}><Link2 size={17} /> Beziehung</button></div></header>
      <div className="page-heading"><div><div className="eyebrow">INVESTIGATION CANVAS</div><h1>Zusammenhänge sichtbar machen<span>.</span></h1><p>Entitäten, Beziehungen und Belege an einem Ort.</p></div><div className="heading-meta"><span className="live-dot" /> Im Browser gespeichert</div></div>
      <div className="board-toolbar"><div className="board-identity"><span>BOARD</span><strong>{board.boardName}</strong><code>{boardId.slice(0, 8)}…</code><button title="Board umbenennen" onClick={() => { const value = window.prompt('Board-Name', board.boardName); if (value?.trim()) void act(() => board.emit('board.rename', { name: value.trim() }), 'Board umbenannt') }}>Umbenennen</button></div><div className="board-tools"><button onClick={() => void copyLink()} title="Board-Link kopieren"><Copy size={15} /> Link</button><button onClick={() => setShowLogImport(true)} title="Aktivitätslogs oder KQL-Ergebnisse importieren"><Upload size={15} /> Logs/KQL</button><button onClick={() => importInput.current?.click()} title="JSON importieren"><Upload size={15} /> Import</button><button onClick={download} title="JSON als Datei speichern"><ArrowDownToLine size={15} /> Export</button><button onClick={() => void copyExport()} title="Board-JSON kopieren"><Copy size={15} /> JSON</button><button onClick={() => navigate(uuid())} title="Neues Board"><Plus size={15} /> Board</button></div><div className="presence-group"><span className={`connection-dot ${board.connected ? 'online' : ''}`} />{board.connected ? <Wifi size={15} /> : <WifiOff size={15} />}<span>{board.connected ? `${board.peers.length + 1} online` : 'Offline'}</span>{board.peers.map(peer => <span key={peer.id} className="peer-avatar" title={peer.name} style={{ background: peerColor(peer.id) }}>{peer.name.slice(0, 1).toUpperCase()}</span>)}<button className="profile-button" onClick={() => { const value = window.prompt('Dein Anzeigename', board.name); if (value?.trim()) board.setName(value) }} title="Anzeigenamen ändern"><Users size={14} /> {board.name}</button></div></div>
      <div className="integration-note"><span><strong>API</strong> · <button className="integration-action" onClick={() => void copyMcpEndpoint()} title="MCP-Endpunkt kopieren">MCP</button> · <a href={restDocsEndpoint} target="_blank" rel="noreferrer">REST /docs</a> · ohne Token</span><small>Browser-Board muss geöffnet sein</small></div>
      {board.ready && !board.connected && <div className="offline-note">Relay offline: Änderungen bleiben in diesem Browser und werden bei erneuter Verbindung synchronisiert.</div>}
      <div className="workspace-grid">
        <div className="visual-column"><section className="workspace-tabs" aria-label="Board-Ansichten"><div className="tab-list" role="tablist" aria-label="Board-Ansichten"><button role="tab" aria-selected={activeTab === 'graph'} className={activeTab === 'graph' ? 'active' : ''} onClick={() => setActiveTab('graph')}><GitBranch size={15} /> Graph <b>{data?.entities.length ?? 0}</b></button><button role="tab" aria-selected={activeTab === 'timeline'} className={activeTab === 'timeline' ? 'active' : ''} onClick={() => setActiveTab('timeline')}><Activity size={15} /> Zeitachse <b>{filteredFacts.length}</b></button><button role="tab" aria-selected={activeTab === 'activity'} className={activeTab === 'activity' ? 'active' : ''} onClick={() => setActiveTab('activity')}><Activity size={15} /> Aktionen <b>{board.actions.length}</b></button></div><div className="tab-panel" role="tabpanel">{activeTab === 'graph' && <section className="graph-card"><div className="card-header"><div><div className="card-title"><GitBranch size={18} /> Beziehungsgraph</div><span>Interaktive Ansicht aller Entitäten und Facts</span></div><div className="graph-count">{visibleEntities.length} / {data?.entities.length ?? 0} KNOTEN · {visibleFacts.length} / {filteredFacts.length} KANTEN</div></div><div className="filter-row"><button className={stateFilter === 'all' ? 'filter-chip active' : 'filter-chip'} onClick={() => setStateFilter('all')}>Alle <b>{data?.facts.length ?? 0}</b></button>{allStates.map(state => <button key={state} className={`filter-chip ${state} ${stateFilter === state ? 'active' : ''}`} onClick={() => setStateFilter(stateFilter === state ? 'all' : state)}><span className="state-dot" />{labels[state]} <b>{counts[state]}</b></button>)}</div>
          <div className="graph-stage">{data && <GraphView entities={visibleEntities} facts={visibleFacts} selection={selection} search={search} pathIds={[]} onSelect={setSelection} onCreateNode={() => setDialog('entity')} onCreateRelation={() => setDialog('fact')} onMoveNode={(id, position) => void board.emit('entity.position', { id, ...position })} />}{data && data.entities.length === 0 && <div className="empty-overlay"><div className="empty-graphic"><GitBranch size={31} /></div><h2>Dein Graph beginnt hier.</h2><p>Lege Entitäten an und verbinde sie mit belegbaren Aussagen – oder lade einen kleinen Beispieldatensatz.</p><div><button className="primary-button" onClick={() => setDialog('entity')}><Plus size={16} /> Erste Entität</button><button className="secondary-button" onClick={() => void act(() => board.emitMany(demoDrafts()), 'Beispieldaten geladen')}><Sparkles size={16} /> Demo laden</button></div></div>}</div>
          <div className="legend"><span><i className="legend-line supported" /> Gestützt</span><span><i className="legend-line disputed" /> Umstritten</span><span><i className="legend-line refuted" /> Widerlegt</span><span><i className="legend-line unknown" /> Ungeklärt</span></div>
        </section>}
        {activeTab === 'timeline' && data && <TimelinePanel data={data} facts={filteredFacts} selection={selection} onSelect={setSelection} />}{activeTab === 'activity' && <ActivityPanel actions={board.actions} />}</div></section></div>
        {data && <DetailPanel data={data} selection={selection} onAdd={kind => { setError(''); setDialog(kind) }} onDelete={deleteItem} onRetract={id => void act(() => board.emit('assertion.retract', { id, retracted_at: new Date().toISOString() }), 'Aussage zurückgezogen')} onClose={() => setSelection(null)} />}
      </div>
      {selectedFact && <div className="selection-footnote"><Fingerprint size={14} /> Ausgewählter Fact: {selectedFact.id}</div>}
    </main>
    {dialog && data && <Dialog key={dialog} kind={dialog} data={data} selection={selection} busy={busy} error={error} onClose={() => setDialog(null)} onSubmit={submit} />}
    {showLogImport && <LogImportDialog boardId={boardId} onClose={() => setShowLogImport(false)} onDone={summary => { setShowLogImport(false); setToast(summary) }} />}
    <input ref={importInput} type="file" accept="application/json,.json" hidden onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; void importFile(file) }} />
    {board.storageError && <div className="toast error">{board.storageError}</div>}
    {error && !dialog && <div className="toast error" onClick={() => setError('')}>{error} <X size={15} /></div>}
    {toast && <div className="toast success">{toast}</div>}
  </div>
}
