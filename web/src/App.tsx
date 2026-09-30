import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import {
  Activity, ArrowDownToLine, ArrowLeft, ArrowRight, ChevronDown, ChevronRight, Clock, Command, Copy, CornerDownLeft,
  FileText, GitBranch, Keyboard, Link2, HardDrive, Server, Users, AlertTriangle, Lock, CircleHelp, ListTree, Merge, Moon, Pause, Pencil, Play, Plus, Plug, Search, ShieldCheck,
  SkipBack, SkipForward, Sparkles, Sun, Trash2, Undo2, Redo2, Upload, X, Crosshair, CheckCircle2, CircleDashed, Boxes, Zap, Layers, Ungroup, ImageDown,
} from 'lucide-react'
import { factsInWindow, timelineSteps, timelineEvents, periodLabel, evidencePeriod } from './timeline'
import GraphView, { KindIcon, type CanvasRequest, type Lens, type Selection } from './GraphView'
import { ActivityDialog, GroupInspector, ParticipantList, ROLES } from './Structures'
import { LAYERS, LAYER_IDS, layerLabel, layerOf } from './layers'
import EvidenceReader, { EvidenceQueue } from './EvidenceReader'
import { demoDrafts, factKey, legacyDrafts, normalizeIdentifier, type ActionDraft, type BoardAction } from './board'
import { useBoard } from './useBoard'
import { uuid } from './uuid'
import { entityVisual } from './entityVisual'
import type { Assertion, Entity, Fact, GraphData, Identifier, TruthState } from './types'

type DialogKind = 'entity' | 'entity-edit' | 'entity-merge' | 'fact' | 'source' | 'identifier' | 'assertion' | 'assertion-edit' | 'activity' | null
type WorkspaceTab = 'graph' | 'timeline' | 'activity' | 'review'
type Theme = 'light' | 'dark'

const labels: Record<TruthState, string> = {
  supported: 'Supported', disputed: 'Disputed', refuted: 'Refuted', unknown: 'Unknown',
}
const allStates: TruthState[] = ['supported', 'disputed', 'refuted', 'unknown']
const kinds = ['Threat Actor', 'User', 'Person', 'Organization', 'Device', 'Service', 'Service Principal', 'Managed Identity', 'AKS Cluster', 'AKS Workload', 'Kubernetes Pod', 'System', 'IP', 'File', 'Repository', 'Process', 'Environment Variable', 'Credential', 'Secret', 'Key Vault', 'Azure Resource', 'Blob Storage', 'S3 Bucket', 'Location', 'Event', 'Document', 'Other']
const customKindValue = '__custom__'
const schemes = ['hostname', 'fqdn', 'ip', 'email', 'url', 'resource_id', 'external_id', 'other']
const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)
const mod = isMac ? '⌘' : 'Ctrl'

function date(value: string | null | undefined) {
  if (!value) return 'No date'
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
}
function nameOf(data: GraphData, id: string) {
  return data.entities.find(item => item.id === id)?.name ?? 'Unknown'
}
function sourceOf(data: GraphData, id: string | null) {
  return data.sources.find(item => item.id === id)
}
function readPref(key: string) { try { return localStorage.getItem(`factgraph:${key}`) } catch { return null } }
function writePref(key: string, value: string) { try { localStorage.setItem(`factgraph:${key}`, value) } catch { /* private mode */ } }

function EntityAvatar({ entity, data, size = 'md' }: { entity: Pick<Entity, 'kind' | 'color'>; data?: GraphData; size?: 'sm' | 'md' | 'lg' }) {
  const type = data?.entity_types?.find(t => t.name === entity.kind)
  const color = entity.color || type?.color || entityVisual(entity.kind).border
  return <span className={`entity-avatar ${size}`} style={{ '--entity-color': color } as CSSProperties}><KindIcon kind={entity.kind} icon={type?.icon} size={size === 'lg' ? 18 : size === 'sm' ? 12 : 14} /></span>
}
function StatePill({ state }: { state: TruthState }) {
  return <span className={`state-pill ${state}`}><span className="state-dot" />{labels[state]}</span>
}
function Kbd({ children }: { children: ReactNode }) { return <kbd>{children}</kbd> }

function Section({ title, count, action, children, defaultOpen = true }: { title: string; count?: number; action?: ReactNode; children: ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen)
  return <section className="inspector-section">
    <div className="section-heading">
      <button className="section-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}<h3>{title}</h3>{count !== undefined && <span className="count">{count}</span>}</button>
      {action}
    </div>
    {open && <div className="section-body">{children}</div>}
  </section>
}

function Inspector({ data, selection, onAdd, onDelete, onRetract, onOpenEvidence, onCopy, onClose, onSelect, onFocus, onCommand }: {
  data: GraphData; selection: NonNullable<Selection>; onAdd: (kind: DialogKind) => void; onCommand: (drafts: ActionDraft[]) => Promise<unknown>;
  onDelete: (kind: 'entity' | 'fact' | 'identifier', id: string) => void;
  onRetract: (id: string) => void; onOpenEvidence: (id: string) => void;
  onCopy: (value: string, label: string) => void; onClose: () => void;
  onSelect: (selection: Selection, focus?: boolean) => void; onFocus: (id: string) => void;
}) {
  const closeButton = <button className="icon-button" onClick={onClose} aria-label="Close" title="Close · Esc"><X size={16} /></button>
  if (selection.kind === 'entity') {
    const entity = data.entities.find(item => item.id === selection.id)
    if (!entity) return null
    const related = data.facts.filter(item => item.subject_id === entity.id || item.object_id === entity.id || item.participants?.some(p => p.entity_id === entity.id))
    const group = data.groups?.find(g => g.member_ids.includes(entity.id))
    const autoLayer = layerOf({ kind: entity.kind }, data.entity_types)
    return <aside className="inspector" aria-label="Inspector">
      <div className="inspector-head"><span className="eyebrow">Entity</span><div className="head-actions">
        <button className="icon-button" title="Copy context for agent" aria-label="Copy context for agent" onClick={() => onCopy(JSON.stringify({ entity, relationships: related }, null, 2), 'Entity context')}><Copy size={15} /></button>{closeButton}</div></div>
      <div className="inspector-scroll">
        <div className="inspector-title"><EntityAvatar entity={entity} data={data} size="lg" /><div><h2>{entity.name}</h2><span className="kind-label">{entity.kind}</span></div></div>
        <div className="inspector-actions">
          <button className="primary-button small" onClick={() => onAdd('fact')}><Link2 size={14} /> Connect</button>
          <button className="secondary-button small" onClick={() => onAdd('entity-edit')}><Pencil size={14} /> Edit</button>
          <button className="secondary-button small" onClick={() => onAdd('entity-merge')}><Merge size={14} /> Merge</button>
          <button className="secondary-button small icon-only" title="Center in graph · F" aria-label="Center in graph" onClick={() => onFocus(entity.id)}><Crosshair size={14} /></button>
        </div>
        {entity.description && <p className="inspector-description">{entity.description}</p>}
        {group && <div className="membership"><Boxes size={14} /><span>In {group.rule?.container_id ? 'contents of' : 'group'} <button className="link" onClick={() => onSelect({ kind: 'group', id: group.id }, true)}>{group.name}</button></span>
          <button className="text-button" onClick={() => void onCommand([{ type: 'group.update', payload: { id: group.id, exclude: [entity.id] } }]).catch(() => {})}><Ungroup size={13} /> Take out</button></div>}
        <Section title="Relationships" count={related.length}>
          {related.length ? <div className="relation-list">{related.map(fact => {
            if (fact.participants?.length) {
              const role = fact.participants.find(p => p.entity_id === entity.id)?.role ?? ''
              return <div key={fact.id} className="relation-row">
                <button className="relation-main" onClick={() => onSelect({ kind: 'fact', id: fact.id }, true)} title="Open activity">
                  <span className={`state-dot ${fact.truth_state}`} /><span className="relation-dir"><Zap size={13} /></span><span className="relation-predicate">{fact.predicate}</span></button>
                <span className={`role-badge ${role}`}>{role}</span></div>
            }
            const outgoing = fact.subject_id === entity.id
            const other = outgoing ? fact.object_id : fact.subject_id
            return <div key={fact.id} className="relation-row">
              <button className="relation-main" onClick={() => onSelect({ kind: 'fact', id: fact.id }, true)} title="Open relationship">
                <span className={`state-dot ${fact.truth_state}`} title={labels[fact.truth_state]} />
                <span className="relation-dir" title={outgoing ? 'Outgoing' : 'Incoming'}>{outgoing ? <ArrowRight size={13} /> : <ArrowLeft size={13} />}</span>
                <span className="relation-predicate">{fact.predicate}</span>
              </button>
              <button className="relation-target" onClick={() => onSelect({ kind: 'entity', id: other }, true)} title="Go to entity">{nameOf(data, other)}</button>
            </div>
          })}</div> : <p className="muted small">No relationships yet. Drag from a node's right handle to connect.</p>}
        </Section>
        <Section title="Identifiers" count={entity.identifiers.length} action={<button className="text-button" onClick={() => onAdd('identifier')}><Plus size={14} /> Add</button>}>
          {entity.identifiers.length ? entity.identifiers.map(identifier => <IdentifierRow key={identifier.id} identifier={identifier} data={data} onCopy={onCopy} onDelete={() => onDelete('identifier', identifier.id)} />) :
            <p className="muted small">No identifiers yet.</p>}
        </Section>
        <Section title="Details" defaultOpen={false}>
          <dl className="meta-list"><dt>Layer</dt><dd><select className="inline-select" aria-label="Entity layer" value={entity.layer ?? ''} onChange={e => void onCommand([{ type: 'entity.update', payload: { id: entity.id, layer: e.target.value || null } }]).catch(() => {})}>
            <option value="">Automatic · {layerLabel(autoLayer)}</option>{LAYERS.map(l => <option key={l.id} value={l.id}>{l.label}</option>)}</select></dd>
            <dt>Created</dt><dd>{date(entity.created_at)}</dd><dt>Position</dt><dd>{entity.pinned ? 'Pinned' : 'Free'}</dd><dt>ID</dt><dd><button className="copy-id" onClick={() => onCopy(entity.id, 'Entity ID')} title="Copy entity ID">{entity.id} <Copy size={12} /></button></dd></dl>
        </Section>
      </div>
      <div className="inspector-foot"><button className="danger-link" onClick={() => onDelete('entity', entity.id)}><Trash2 size={14} /> Delete entity</button></div>
    </aside>
  }

  const fact = data.facts.find(item => item.id === selection.id)
  if (!fact) return null
  const active = fact.assertions.filter(a => !a.retracted_at)
  const confirmed = active.filter(a => a.review_status === 'confirmed').length
  const isActivity = !!fact.participants?.length
  return <aside className="inspector" aria-label="Inspector">
    <div className="inspector-head"><span className="eyebrow">{isActivity ? 'Activity' : 'Relationship'}</span><div className="head-actions">
      <button className="icon-button" title="Copy relationship ID" aria-label="Copy relationship ID" onClick={() => onCopy(fact.id, 'Relationship ID')}><Copy size={15} /></button>{closeButton}</div></div>
    <div className="inspector-scroll">
      {isActivity ? <>
        <div className="inspector-title"><span className={`entity-avatar lg activity-avatar ${fact.truth_state}`}><Zap size={18} /></span><div><h2>{fact.predicate}</h2>
          <span className="kind-label">{fact.participants!.length} participants{fact.technique ? ` · ${fact.technique}` : ''}</span></div></div>
        <div className="inspector-actions">
          <button className="secondary-button small" onClick={() => { const value = window.prompt('Operation', fact.predicate); if (value?.trim()) void onCommand([{ type: 'fact.update', payload: { id: fact.id, predicate: value.trim() } }]).catch(() => {}) }}><Pencil size={14} /> Operation</button>
          <button className="secondary-button small" onClick={() => { const value = window.prompt('ATT&CK technique (empty to clear)', fact.technique ?? ''); if (value !== null) void onCommand([{ type: 'fact.update', payload: { id: fact.id, technique: value.trim() || null } }]).catch(() => {}) }}>Technique</button>
          <button className="secondary-button small icon-only" title="Center in graph" aria-label="Center in graph" onClick={() => onFocus(fact.id)}><Crosshair size={14} /></button>
        </div>
        <Section title="Participants" count={fact.participants!.length}><ParticipantList data={data} fact={fact} onCommand={onCommand} onSelect={onSelect} /></Section>
      </> : <div className="fact-path">
        <button onClick={() => onSelect({ kind: 'entity', id: fact.subject_id }, true)}>{nameOf(data, fact.subject_id)}</button>
        <div className={`fact-predicate ${fact.truth_state}`}><span>{fact.predicate}</span><ArrowDownIcon /></div>
        <button onClick={() => onSelect({ kind: 'entity', id: fact.object_id }, true)}>{nameOf(data, fact.object_id)}</button>
      </div>}
      <div className="fact-state"><StatePill state={fact.truth_state} /><span>{active.length} active · {confirmed} confirmed</span>{!isActivity && confirmed > 0 && <span className="lock-note" title="Confirmed evidence refers to these two entities. Retract or unconfirm it before moving an end.">Ends locked</span>}</div>
      <dl className="meta-list"><dt>Valid from</dt><dd>{date(fact.valid_from)}</dd>{fact.valid_to && <><dt>Valid to</dt><dd>{date(fact.valid_to)}</dd></>}</dl>
      <Section title="Evidence" count={fact.assertions.length} action={<button className="text-button" onClick={() => onAdd('assertion')}><Plus size={14} /> Add evidence</button>}>
        {fact.assertions.length ? fact.assertions.map(assertion => <AssertionRow key={assertion.id} assertion={assertion} fact={fact} data={data} onCopy={onCopy} onOpen={() => onOpenEvidence(assertion.id)} onRetract={() => onRetract(assertion.id)} />)
          : <p className="muted small">No evidence yet. A relationship stays <em>unknown</em> until confirmed evidence exists.</p>}
      </Section>
      <p className="inspector-note"><ShieldCheck size={14} /> Status is derived from confirmed, active evidence. Supporting and refuting evidence can coexist.</p>
    </div>
    <div className="inspector-foot"><button className="danger-link" onClick={() => onDelete('fact', fact.id)}><Trash2 size={14} /> Delete {isActivity ? 'activity' : 'relationship'}</button></div>
  </aside>
}
function ArrowDownIcon() { return <svg width="12" height="18" viewBox="0 0 12 18" aria-hidden="true"><path d="M6 0v15M1.5 11 6 16l4.5-5" fill="none" stroke="currentColor" strokeWidth="1.6" /></svg> }

function IdentifierRow({ identifier, data, onCopy, onDelete }: { identifier: Identifier; data: GraphData; onCopy: (value: string, label: string) => void; onDelete: () => void }) {
  const source = sourceOf(data, identifier.source_id)
  return <div className="identifier-row">
    <span className="scheme-badge">{identifier.scheme}</span>
    <button className="identifier-value" onClick={() => onCopy(identifier.raw_value, 'Identifier')} title="Copy identifier">{identifier.raw_value}</button>
    <button title="Delete identifier" aria-label="Delete identifier" className="row-delete" onClick={onDelete}><X size={13} /></button>
    <div className="identifier-meta">{identifier.namespace && <span>{identifier.namespace} · </span>}{source ? source.title : 'Manual'} · {Math.round(identifier.confidence * 100)}%
      {(identifier.valid_from || identifier.valid_to) && <> · {date(identifier.valid_from)} – {identifier.valid_to ? date(identifier.valid_to) : 'now'}</>}</div>
  </div>
}

function AssertionRow({ assertion, fact, data, onCopy, onOpen, onRetract }: { assertion: Assertion; fact: Fact; data: GraphData; onCopy: (value: string, label: string) => void; onOpen: () => void; onRetract: () => void }) {
  const source = sourceOf(data, assertion.source_id)
  const period = evidencePeriod(assertion, fact)
  const status = assertion.retracted_at ? 'retracted' : assertion.review_status ?? 'unconfirmed'
  return <div className={`assertion-card ${assertion.retracted_at ? 'retracted' : ''}`}>
    <div className="assertion-top">
      <span className={`stance ${assertion.stance}`}>{assertion.stance === 'supports' ? 'Supports' : 'Refutes'}</span>
      <span className={`review-badge ${status}`}>{status === 'confirmed' ? <CheckCircle2 size={12} /> : <CircleDashed size={12} />}{status}</span>
      <span className="assertion-conf">{Math.round(assertion.confidence * 100)}%</span>
    </div>
    <p className="assertion-text">{assertion.observation || assertion.note || <span className="muted">No observation recorded.</span>}</p>
    <div className="assertion-source"><FileText size={13} /><span>{source ? source.title : 'Manual entry'}</span>{assertion.locator && <code>{assertion.locator}</code>}</div>
    <div className="assertion-footer"><span>{periodLabel(period.from, period.to)}</span>
      <span className="assertion-actions">
        <button onClick={() => onCopy(assertion.id, 'Evidence ID')} title="Copy evidence ID" aria-label="Copy evidence ID"><Copy size={12} /></button>
        {!assertion.retracted_at && <button onClick={onRetract}>Retract</button>}
        <button className="strong" onClick={onOpen}>Open & review</button>
      </span></div>
  </div>
}

function Dialog({ kind, data, selection, editingAssertionId, relationTargetId, busy, error, onClose, onSubmit }: {
  kind: Exclude<DialogKind, null>; data: GraphData; selection: Selection; busy: boolean;
  editingAssertionId: string | null; relationTargetId: string | null;
  error: string; onClose: () => void; onSubmit: (kind: Exclude<DialogKind, null>, values: Record<string, unknown>) => Promise<void>;
}) {
  const titles = { activity: 'New activity', entity: 'New entity', 'entity-edit': 'Edit entity', 'entity-merge': 'Merge entity', fact: 'New relationship', source: 'New source', identifier: 'Add identifier', assertion: 'Add evidence', 'assertion-edit': 'Edit evidence' }
  const editing = kind === 'entity-edit' ? data.entities.find(e => e.id === selection?.id) : undefined
  const editingAssertion = kind === 'assertion-edit' ? data.facts.flatMap(fact => fact.assertions).find(assertion => assertion.id === editingAssertionId) : undefined
  const [stance, setStance] = useState<'supports' | 'refutes'>(editingAssertion?.stance ?? 'supports')
  const [newTarget, setNewTarget] = useState(selection?.kind === 'entity' && !relationTargetId)
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
    else if (kind === 'source') values = { title: get('title'), uri: get('uri'), excerpt: get('excerpt'), source_kind: get('source_kind'), query: get('query') }
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
    else values = { locator: get('locator'), observation: get('note'), stance, confidence, source_id: get('source_id') || null, note: get('note'), valid_from: asDate('valid_from'), valid_to: asDate('valid_to') }
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
  const entityOptions = [...data.entities].sort((a, b) => a.name.localeCompare(b.name)).map(item => <option key={item.id} value={item.id}>{item.name} · {item.kind}</option>)
  return <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}>
    <div className="modal" role="dialog" aria-modal="true" aria-label={titles[kind]}>
      <div className="modal-header"><h2>{titles[kind]}</h2><button className="icon-button" onClick={onClose} aria-label="Close dialog"><X size={18} /></button></div>
      <form onSubmit={submit}>
        <div className="modal-body">
          {(kind === 'entity' || kind === 'entity-edit') && <><label>Name<input name="name" defaultValue={editing?.name} autoFocus required placeholder="e.g. Web server 01" /></label><div className="field-grid"><label>Type<select aria-label="Type" name="kind" defaultValue={editing ? (kinds.includes(editing.kind) ? editing.kind : customKindValue) : kinds[0]} onChange={event => setCustomEntityKind(event.target.value === customKindValue)}>{kinds.map(value => <option key={value}>{value}</option>)}<option value={customKindValue}>Custom type…</option></select>{customEntityKind && <input name="custom_kind" defaultValue={editing?.kind} required autoFocus placeholder="e.g. SaaS application" />}</label><label>Node color<input name="color" className="color-input" type="color" defaultValue={editing?.color || entityVisual(editing?.kind || kinds[0]).border} /></label></div><label>Description <span className="optional">optional</span><textarea name="description" defaultValue={editing?.description} rows={3} placeholder="What is known about this entity?" /></label></>}
          {kind === 'entity-merge' && selection?.kind === 'entity' && <><div className="modal-context">Merge <strong>{nameOf(data, selection.id)}</strong> into another entity. Its identifiers, relationships and evidence are retained.</div><label>Keep entity<select name="target_id" required autoFocus defaultValue=""><option value="" disabled>Choose target entity</option>{data.entities.filter(item => item.id !== selection.id).map(item => <option key={item.id} value={item.id}>{item.name} · {item.kind}</option>)}</select></label><div className="form-warning">The selected source entity will disappear. Use Undo if you change your mind.</div></>}
          {kind === 'source' && <><label>Title<input name="title" autoFocus required placeholder="e.g. EDR export from Sep 27" /></label><label>URL or reference <span className="optional">optional</span><input name="uri" placeholder="https://… or file path" /></label><label>Source classification<select name="source_kind"><option value="unknown">Unclassified</option><option value="primary">Primary evidence</option><option value="secondary">Secondary context</option></select></label><label>KQL query <span className="optional">optional</span><textarea name="query" rows={2} className="mono" /></label><label>Original excerpt / results <span className="optional">optional</span><textarea name="excerpt" rows={4} className="mono" placeholder="Relevant passage from the source" /></label></>}
          {kind === 'identifier' && <><div className="modal-context">Entity: <strong>{selection?.kind === 'entity' ? nameOf(data, selection.id) : ''}</strong></div><div className="field-grid"><label>Scheme<select name="scheme">{schemes.map(value => <option key={value}>{value}</option>)}</select></label><label>Namespace <span className="optional">optional</span><input name="namespace" placeholder="e.g. prod" /></label></div><label>Value<input name="raw_value" autoFocus required placeholder="External identifier" /></label>{dateFields}{sourceSelect}{confidenceField}</>}
          {kind === 'fact' && <><div className="field-grid"><label>From<select name="subject_id" defaultValue={selection?.kind === 'entity' ? selection.id : ''} required><option value="" disabled>Choose entity</option>{entityOptions}</select></label><div className="field-stack"><span className="field-label">To</span><div className="segmented" role="group" aria-label="Target"><button type="button" className={newTarget ? 'active' : ''} aria-pressed={newTarget} onClick={() => setNewTarget(true)}>New node</button><button type="button" className={!newTarget ? 'active' : ''} aria-pressed={!newTarget} onClick={() => setNewTarget(false)}>Existing node</button></div></div></div>{newTarget ? <div className="field-grid"><label>New node name<input name="new_object_name" required placeholder="e.g. Azure secret" /></label><label>Type<select name="new_object_kind" defaultValue={kinds[0]} onChange={event => setCustomTargetKind(event.target.value === customKindValue)}>{kinds.map(value => <option key={value}>{value}</option>)}<option value={customKindValue}>Custom type…</option></select>{customTargetKind && <input name="custom_new_object_kind" required autoFocus placeholder="e.g. SaaS application" />}</label></div> : <label>Target node<select name="object_id" defaultValue={relationTargetId ?? ''} required><option value="" disabled>Choose entity</option>{entityOptions}</select></label>}<label>Relationship / predicate<input name="predicate" autoFocus required placeholder="e.g. reads, grants access to, accessed" /></label>{dateFields}<div className="form-divider">First evidence statement</div><StanceSelect value={stance} onChange={setStance} /><div className="field-grid">{sourceSelect}{confidenceField}</div><label>Note <span className="optional">optional</span><textarea name="note" rows={2} placeholder="What supports this statement?" /></label></>}
          {(kind === 'assertion' || kind === 'assertion-edit') && <><div className="modal-context">Relationship: <strong>{selection?.kind === 'fact' ? data.facts.find(item => item.id === selection.id)?.predicate : ''}</strong></div>{dateFields}<StanceSelect value={stance} onChange={setStance} /><div className="field-grid">{sourceSelect}{confidenceField}</div><label>Locator / event ID / result row<input name="locator" defaultValue={editingAssertion?.locator} /></label><label>Observation<textarea name="note" defaultValue={editingAssertion?.observation || editingAssertion?.note} rows={3} placeholder="What does the source show?" /></label></>}
          {(error || localError) && <div className="form-error">{localError || error}</div>}
        </div>
        <div className="modal-actions"><button type="button" className="secondary-button" onClick={onClose}>Cancel</button><button className="primary-button" disabled={busy}>{busy ? 'Saving…' : 'Save'} <CornerDownLeft size={14} /></button></div>
      </form>
    </div>
  </div>
}

function StanceSelect({ value, onChange }: { value: 'supports' | 'refutes'; onChange: (value: 'supports' | 'refutes') => void }) {
  return <div className="stance-field"><span>Evidence stance</span><div className="segmented"><button type="button" className={value === 'supports' ? 'active supports' : ''} onClick={() => onChange('supports')}>Supports</button><button type="button" className={value === 'refutes' ? 'active refutes' : ''} onClick={() => onChange('refutes')}>Refutes</button></div></div>
}

function LogImportDialog({ boardId, sessionToken, onClose, onDone }: {
  boardId: string; sessionToken: string; onClose: () => void; onDone: (summary: string) => void;
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [preview, setPreview] = useState<Record<string, unknown> | null>(null)
  const [mode, setMode] = useState<'relation' | 'activity'>('relation')
  const [roles, setRoles] = useState([{ field: 'CallerIPAddress', role: 'source', kind: 'IP' }, { field: 'AppId', role: 'identity', kind: 'Service Principal' }, { field: 'ResourceId', role: 'target', kind: 'Key Vault' }])
  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setBusy(true); setError('')
    try {
      const body = new FormData(event.currentTarget)
      body.set('dry_run', preview ? 'false' : 'true')
      if (mode === 'activity') body.set('roles', JSON.stringify(roles.filter(r => r.field.trim())))
      const response = await fetch(`/api/boards/${boardId}/imports/file`, {
        method: 'POST', headers: { 'X-FactGraph-Token': sessionToken }, body,
      })
      const result = await response.json() as Record<string, unknown>
      if (!response.ok) throw new Error(String(result.detail ?? 'Import failed'))
      if (!preview) { setPreview(result); return }
      onDone(`${result.rows} log rows · ${result.entities} entities · ${result.relations} ${mode === 'activity' ? 'activities' : 'relationships'} · ${result.evidence} evidence items`)
    } catch (problem) { setError(problem instanceof Error ? problem.message : 'Import failed') }
    finally { setBusy(false) }
  }
  return <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}>
    <div className="modal" role="dialog" aria-modal="true" aria-label="Import activity logs">
      <div className="modal-header"><h2>Import logs & KQL results</h2><button className="icon-button" onClick={onClose} aria-label="Close dialog"><X size={18} /></button></div>
      <form onChange={() => setPreview(null)} onSubmit={event => void submit(event)}>
        <div className="modal-body">
          <p className="hint">CSV, JSON or JSONL result rows. KQL is not executed here; the query and supplied rows are stored as the evidence source.</p>
          <div className="segmented full" role="group" aria-label="Import mode"><button type="button" className={mode === 'relation' ? 'active' : ''} onClick={() => { setMode('relation'); setPreview(null) }}>Relationships · 2 columns</button><button type="button" className={mode === 'activity' ? 'active' : ''} onClick={() => { setMode('activity'); setPreview(null) }}>Activities · several roles</button></div>
          <label>File<input name="file" type="file" accept=".csv,.json,.jsonl,.ndjson" required /></label>
          <label>Source title<input name="title" defaultValue="Access Logs" required /></label>
          <label>KQL query <span className="optional">optional</span><textarea name="query" rows={3} className="mono" placeholder="AccessLogs | project IPAddress, FilePath, TimeGenerated" /></label>
          {mode === 'relation' ? <>
            <div className="field-grid"><label>Source column <span className="optional">blank = auto</span><input name="subject_field" placeholder="IPAddress" /></label><label>Target column <span className="optional">blank = auto</span><input name="object_field" placeholder="FilePath" /></label></div>
            <div className="field-grid"><label>Source type<input name="subject_kind" defaultValue="IP" /></label><label>Target type<input name="object_kind" defaultValue="File" /></label></div>
          </> : <div className="stack role-mapping">
            <span className="field-label">Columns → roles <span className="optional">each row becomes evidence for one activity</span></span>
            {roles.map((row, index) => <div key={index} className="role-map-row">
              <input aria-label={`Column ${index + 1}`} placeholder="Column" value={row.field} onChange={e => { setPreview(null); setRoles(roles.map((r, i) => i === index ? { ...r, field: e.target.value } : r)) }} />
              <select aria-label={`Role ${index + 1}`} value={row.role} onChange={e => { setPreview(null); setRoles(roles.map((r, i) => i === index ? { ...r, role: e.target.value } : r)) }}>{ROLES.map(role => <option key={role}>{role}</option>)}</select>
              <input aria-label={`Type ${index + 1}`} placeholder="Entity type" value={row.kind} onChange={e => { setPreview(null); setRoles(roles.map((r, i) => i === index ? { ...r, kind: e.target.value } : r)) }} />
              <button type="button" className="icon-button" aria-label="Remove mapping" disabled={roles.length <= 2} onClick={() => setRoles(roles.filter((_, i) => i !== index))}><X size={14} /></button>
            </div>)}
            <button type="button" className="text-button" onClick={() => setRoles([...roles, { field: '', role: 'actor', kind: 'User' }])}><Plus size={14} /> Add column</button>
          </div>}
          <div className="field-grid"><label>{mode === 'activity' ? 'Operation' : 'Relationship'}<input name="predicate" defaultValue={mode === 'activity' ? 'performed' : 'accessed'} key={mode} required /></label><label>{mode === 'activity' ? 'Operation column' : 'Relationship column'} <span className="optional">optional</span><input name="predicate_field" placeholder="OperationName" /></label></div>
          {preview && <div className="import-preview"><strong>Preview · no changes saved yet</strong><p>{String(preview.rows)} rows · {String(preview.entities)} entities · {String(preview.relations)} {mode === 'activity' ? 'activities' : 'relationships'} · {String(preview.skipped)} skipped</p><p>{mode === 'activity' ? `Roles: ${roles.filter(r => r.field).map(r => `${r.field} → ${r.role}`).join(', ')}` : `Mapping: ${String(preview.subject_field)} → ${String(preview.object_field)}`}. New evidence is unconfirmed.</p></div>}{error && <div className="form-error">{error}</div>}
        </div>
        <div className="modal-actions"><button type="button" className="secondary-button" onClick={onClose}>Cancel</button><button className="primary-button" disabled={busy}>{busy ? 'Processing…' : preview ? 'Apply import' : 'Preview import'} <ArrowRight size={14} /></button></div>
      </form>
    </div>
  </div>
}

function currentBoardId() {
  const fromUrl = window.location.pathname.match(/^\/boards\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?$/i)?.[1]
  const stored = readPref('lastBoard') ?? ''
  const id = fromUrl?.toLowerCase() ?? (/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(stored) ? stored : uuid())
  window.history.replaceState(null, '', `/boards/${id}${window.location.search}`)
  writePref('lastBoard', id)
  return id
}

function actionLabel(action: BoardAction) {
  const names: Record<BoardAction['type'], string> = {
    'type.add': 'Type created', 'type.update': 'Type edited', 'type.delete': 'Type deleted', 'board.rename': 'Board renamed', 'entity.add': 'Entity created',
    'entity.update': 'Entity edited', 'entity.position': 'Node moved', 'entity.delete': 'Entity deleted', 'entity.merge': 'Entities merged', 'identifier.add': 'Identifier added',
    'identifier.delete': 'Identifier deleted', 'source.add': 'Source created', 'source.update': 'Source edited', 'source.delete': 'Source deleted',
    'fact.add': 'Relationship created', 'fact.update': 'Relationship edited', 'fact.delete': 'Relationship deleted',
    'assertion.add': 'Evidence added', 'assertion.update': 'Evidence edited', 'assertion.retract': 'Evidence retracted',
    'assertion.delete': 'Evidence deleted', 'action.undo': 'Change undone', 'action.redo': 'Change restored', 'assertion.restore': 'Evidence restored', 'assertion.review': 'Evidence reviewed', 'identifier.update': 'Identifier edited',
    'fact.position': 'Activity moved', 'group.add': 'Group created', 'group.update': 'Group changed', 'group.delete': 'Group removed',
    'view.add': 'Perspective saved', 'view.update': 'Perspective changed', 'view.delete': 'Perspective deleted',
  }
  const subject = typeof action.payload.name === 'string' ? action.payload.name :
    typeof action.payload.title === 'string' ? action.payload.title :
      typeof action.payload.predicate === 'string' ? action.payload.predicate : ''
  return `${names[action.type]}${subject ? ` · ${subject}` : ''}`
}

function TimelinePanel({ data, facts, selection, onSelect }: {
  data: GraphData; facts: GraphData['facts']; selection: Selection; onSelect: (selection: Selection) => void;
}) {
  const entries = timelineEvents(facts)
  const groups: { day: string; items: typeof entries }[] = []
  for (const entry of entries) {
    const day = entry.from ? new Date(entry.from).toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' }) : 'Undated'
    const last = groups[groups.length - 1]
    if (last?.day === day) last.items.push(entry); else groups.push({ day, items: [entry] })
  }
  return <section className="view-page">
    <header className="view-header"><div><h2>Timeline</h2><p>Evidence periods in chronological order · UTC</p></div><span className="count-chip">{entries.length} events</span></header>
    {entries.length ? groups.map(group => <div key={group.day} className="timeline-group"><div className="timeline-day">{group.day}</div>
      {group.items.map(({ fact, assertions, from, to }) => <button key={`${fact.id}:${from}:${to}:${assertions[0]?.locator ?? ''}`} className={`timeline-item ${selection?.id === fact.id ? 'active' : ''}`} onClick={() => onSelect({ kind: 'fact', id: fact.id })}>
        <span className="timeline-time">{from ? new Date(from).toISOString().slice(11, 16) : '—'}</span>
        <span className={`timeline-dot ${fact.truth_state}`} />
        <span className="timeline-body"><strong>{fact.participants?.length ? <><Zap size={12} /> <em>{fact.predicate}</em> {fact.participants.map(p => nameOf(data, p.entity_id)).join(' · ')}</> : <>{nameOf(data, fact.subject_id)} <em>{fact.predicate}</em> {nameOf(data, fact.object_id)}</>}</strong>
          <small>{periodLabel(from, to)} · {assertions.length} evidence {assertions.length === 1 ? 'item' : 'items'} · {[...new Set(assertions.map(item => item.stance === 'supports' ? 'supports' : 'refutes'))].join(' + ')}</small></span>
      </button>)}</div>) : <div className="view-empty"><Clock size={22} /><p>No active evidence yet.</p></div>}
  </section>
}

function EvidenceWindow({ facts, from, to, includeUndated, onIncludeUndatedChange, onFromChange, onToChange, onReset, onClose }: {
  facts: GraphData['facts']; from: string; to: string;
  includeUndated: boolean; onIncludeUndatedChange: (value: boolean) => void;
  onFromChange: (value: string) => void; onToChange: (value: string) => void; onReset: () => void; onClose: () => void;
}) {
  const [playing, setPlaying] = useState(false)
  const steps = useMemo(() => timelineSteps(facts), [facts])
  const maxStep = Math.max(steps.length - 1, 0)
  const nearestStep = (value: string, fallback: number) => {
    if (!value || !steps.length) return fallback
    const target = Date.parse(value)
    return steps.reduce((best, step, index) => Math.abs(Date.parse(step) - target) < Math.abs(Date.parse(steps[best]) - target) ? index : best, 0)
  }
  const fromStep = Math.min(nearestStep(from, 0), maxStep)
  const toStep = Math.max(nearestStep(to, maxStep), 0)
  const position = (step: number) => maxStep ? (step / maxStep) * 100 : 0
  const moveFrom = (step: number) => onFromChange(steps[Math.min(step, toStep)] ?? '')
  const moveTo = (step: number) => onToChange(steps[Math.max(step, fromStep)] ?? '')
  const hasRange = steps.length > 1
  useEffect(() => {
    if (!playing) return
    if (toStep >= maxStep) { setPlaying(false); return }
    const timer = window.setTimeout(() => moveTo(toStep + 1), 900)
    return () => window.clearTimeout(timer)
  }, [playing, toStep, maxStep])
  return <div className="time-bar" role="region" aria-label="Evidence window">
    <div className="time-controls">
      <button className="icon-button" aria-label="Previous evidence step" disabled={!hasRange || toStep <= fromStep} onClick={() => moveTo(toStep - 1)}><SkipBack size={14} /></button>
      <button className="icon-button play" aria-label={playing ? 'Pause evidence playback' : 'Play evidence steps'} disabled={!hasRange} onClick={() => { if (toStep === maxStep) { onFromChange(steps[0]); onToChange(steps[0]) } setPlaying(!playing) }}>{playing ? <Pause size={14} /> : <Play size={14} />}</button>
      <button className="icon-button" aria-label="Next evidence step" disabled={!hasRange || toStep === maxStep} onClick={() => moveTo(toStep + 1)}><SkipForward size={14} /></button>
    </div>
    <div className="time-main">
      <div className="window-range" aria-label="Evidence time range"><div className="window-track" /><div className="window-selection" style={{ left: `${position(fromStep)}%`, right: `${100 - position(toStep)}%` }} />
        <input aria-label="Evidence from" aria-valuetext={steps[fromStep] ?? 'No dated evidence'} className="range-input" type="range" min="0" max={maxStep} step="1" value={fromStep} disabled={!hasRange} onChange={event => moveFrom(Number(event.target.value))} />
        <input aria-label="Evidence to" aria-valuetext={steps[toStep] ?? 'No dated evidence'} className="range-input" type="range" min="0" max={maxStep} step="1" value={toStep} disabled={!hasRange} onChange={event => moveTo(Number(event.target.value))} /></div>
      <div className="window-labels"><span>{steps.length ? periodLabel(steps[fromStep], null) : 'No dated evidence'}</span><em>{steps.length ? `step ${fromStep + 1}–${toStep + 1} of ${steps.length}` : ''}</em><span>{steps.length ? periodLabel(steps[toStep], null) : ''}</span></div>
    </div>
    <label className="check"><input type="checkbox" checked={includeUndated} onChange={event => onIncludeUndatedChange(event.target.checked)} /> Undated</label>
    {(from || to) && <button className="text-button" onClick={onReset}>Show all</button>}
    <button className="icon-button" aria-label="Close evidence window" onClick={onClose}><X size={14} /></button>
  </div>
}

function ActivityPanel({ actions }: { actions: BoardAction[] }) {
  const [page, setPage] = useState(0)
  const batches = useMemo(() => {
    const groups = new Map<string, BoardAction[]>()
    for (const action of actions) { const key = action.batch_id ?? action.id; const list = groups.get(key); if (list) list.push(action); else groups.set(key, [action]) }
    return [...groups.entries()].reverse()
  }, [actions])
  return <section className="view-page">
    <header className="view-header"><div><h2>Activity</h2><p>{actions.length} changes in {batches.length} groups · UI, REST and MCP</p></div>
      <div className="pager"><button className="secondary-button small" disabled={page === 0} onClick={() => setPage(page - 1)}>Previous</button><span>{page + 1} / {Math.max(1, Math.ceil(batches.length / 50))}</span><button className="secondary-button small" disabled={(page + 1) * 50 >= batches.length} onClick={() => setPage(page + 1)}>Next</button></div></header>
    <div className="activity-list">{batches.slice(page * 50, (page + 1) * 50).map(([id, items]) => <details key={id} className="activity-item"><summary>
      <span className={`channel-badge ${(items[0].channel ?? 'UI').toLowerCase()}`}>{items[0].channel ?? 'UI'}</span>
      <strong>{items.length === 1 ? actionLabel(items[0]) : `${items.length} changes · ${actionLabel(items[0])}`}</strong>
      <span className="activity-meta">{items[0].author} · {new Date(items[0].at).toLocaleString('en-GB')}</span></summary>
      {items.map(action => <div key={action.id} className="activity-detail"><strong>{actionLabel(action)}</strong><small>{action.actor} · {action.id}</small><pre>{JSON.stringify(action.payload, null, 2)}</pre></div>)}</details>)}
      {!batches.length && <div className="view-empty"><Activity size={22} /><p>No changes yet.</p></div>}</div>
  </section>
}

function Explorer({ data, search, selection, onSelect, onClose }: { data: GraphData; search: string; selection: Selection; onSelect: (selection: Selection, focus?: boolean) => void; onClose: () => void }) {
  const groupOf = useMemo(() => new Map((data.groups ?? []).flatMap(g => g.member_ids.map(id => [id, g.name] as const))), [data.groups])
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const needle = search.trim().toLowerCase()
  const degree = useMemo(() => {
    const map = new Map<string, number>()
    for (const f of data.facts) { map.set(f.subject_id, (map.get(f.subject_id) ?? 0) + 1); map.set(f.object_id, (map.get(f.object_id) ?? 0) + 1) }
    return map
  }, [data.facts])
  const groups = useMemo(() => {
    const byKind = new Map<string, Entity[]>()
    for (const entity of data.entities) {
      if (needle && !`${entity.name} ${entity.kind} ${entity.identifiers.map(i => i.raw_value).join(' ')}`.toLowerCase().includes(needle)) continue
      const list = byKind.get(entity.kind); if (list) list.push(entity); else byKind.set(entity.kind, [entity])
    }
    return [...byKind.entries()].map(([kind, items]) => [kind, items.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))] as const).sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
  }, [data.entities, needle])
  const total = groups.reduce((sum, [, items]) => sum + items.length, 0)
  return <aside className="explorer" aria-label="Entity explorer">
    <div className="explorer-head"><div><strong>Entities</strong><span className="count">{needle ? `${total} / ${data.entities.length}` : data.entities.length}</span></div><button className="icon-button" aria-label="Hide explorer" title="Hide explorer" onClick={onClose}><X size={15} /></button></div>
    <div className="explorer-list">
      {!!data.groups?.length && <div className="explorer-group">
        <div className="explorer-section-label">Groups</div>
        {data.groups.map(group => <button key={group.id} className={`explorer-item group-item ${selection?.kind === 'group' && selection.id === group.id ? 'active' : ''}`} onClick={() => onSelect({ kind: 'group', id: group.id }, true)} title={group.name}>
          <Boxes size={13} /><span className="explorer-name">{group.name}</span>{!group.collapsed && <span className="explorer-hint">open</span>}<span className="explorer-degree">{group.member_ids.length}</span></button>)}
        <div className="explorer-section-label">By type</div>
      </div>}
      {groups.map(([kind, items]) => {
        const isCollapsed = collapsed[kind] ?? false
        const limit = expanded[kind] ? items.length : 100
        return <div key={kind} className="explorer-group">
          <button className="explorer-group-head" aria-expanded={!isCollapsed} onClick={() => setCollapsed({ ...collapsed, [kind]: !isCollapsed })}>
            {isCollapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}<EntityAvatar entity={{ kind }} data={data} size="sm" /><span>{kind}</span><span className="count">{items.length}</span></button>
          {!isCollapsed && items.slice(0, limit).map(entity => <button key={entity.id} className={`explorer-item ${selection?.id === entity.id ? 'active' : ''}`} onClick={() => onSelect({ kind: 'entity', id: entity.id }, true)} title={entity.name}>
            <span className="explorer-name">{entity.name}</span>{groupOf.has(entity.id) ? <span className="explorer-hint" title={`In group ${groupOf.get(entity.id)}`}><Boxes size={10} /></span> : entity.identifiers[0] && <span className="explorer-hint">{entity.identifiers[0].raw_value}</span>}<span className="explorer-degree" title="Relationships">{degree.get(entity.id) ?? 0}</span></button>)}
          {!isCollapsed && items.length > limit && <button className="explorer-more" onClick={() => setExpanded({ ...expanded, [kind]: true })}>Show all {items.length}</button>}
        </div>
      })}
      {!groups.length && <div className="explorer-empty">{needle ? 'No matches.' : 'No entities yet.'}</div>}
    </div>
  </aside>
}

type PaletteItem = { id: string; group: string; label: string; hint?: string; icon: ReactNode; run: () => void }
function CommandPalette({ items, onClose }: { items: PaletteItem[]; onClose: () => void }) {
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  const list = useRef<HTMLDivElement>(null)
  const q = query.trim().toLowerCase()
  const results = useMemo(() => {
    // Name matches rank above hint matches, and entity names above commands, so typing a name jumps to it.
    const rank = (item: PaletteItem) => {
      const label = item.label.toLowerCase()
      const base = label === q ? 0 : label.startsWith(q) ? 1 : label.includes(q) ? 2 : 4
      return base * 2 + (item.group === 'Entities' ? 0 : 1)
    }
    const matched = q ? items.filter(item => `${item.label} ${item.hint ?? ''} ${item.group}`.toLowerCase().includes(q)).map(item => [rank(item), item] as const).sort((a, b) => a[0] - b[0]).map(([, item]) => item)
      : items.filter(item => item.group !== 'Entities').concat(items.filter(item => item.group === 'Entities').slice(0, 8))
    return matched.slice(0, 60)
  }, [items, q])
  useEffect(() => setIndex(0), [q])
  useEffect(() => { list.current?.querySelector('.active')?.scrollIntoView({ block: 'nearest' }) }, [index])
  const choose = (item?: PaletteItem) => { if (!item) return; onClose(); item.run() }
  let lastGroup = ''
  return <div className="command-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}>
    <div className="command-palette" role="dialog" aria-modal="true" aria-label="Command palette">
      <label className="command-input"><Search size={16} /><input autoFocus placeholder="Search entities or run a command…" value={query} onChange={e => setQuery(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'ArrowDown') { e.preventDefault(); setIndex(Math.min(index + 1, results.length - 1)) }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setIndex(Math.max(index - 1, 0)) }
          else if (e.key === 'Enter') { e.preventDefault(); choose(results[index]) }
          else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose() }
        }} /><Kbd>esc</Kbd></label>
      <div className="command-list" ref={list}>
        {results.map((item, i) => {
          const header = item.group !== lastGroup ? <div className="command-group" key={`g-${item.group}`}>{item.group}</div> : null
          lastGroup = item.group
          return [header, <button key={item.id} className={`command-item ${i === index ? 'active' : ''}`} onMouseMove={() => setIndex(i)} onClick={() => choose(item)}>
            <span className="command-icon">{item.icon}</span><span className="command-label">{item.label}</span>{item.hint && <span className="command-hint">{item.hint}</span>}</button>]
        })}
        {!results.length && <div className="command-empty">No results for “{query}”.</div>}
      </div>
      <div className="command-foot"><span><Kbd>↑</Kbd><Kbd>↓</Kbd> navigate</span><span><Kbd>↵</Kbd> select</span></div>
    </div>
  </div>
}

type StorageInfo = { persisted: boolean | null; usage: number | null; quota: number | null }
const formatBytes = (value: number) => value < 1024 * 1024 ? `${Math.max(1, Math.round(value / 1024))} KB` : value < 1024 ** 3 ? `${(value / 1024 / 1024).toFixed(1)} MB` : `${(value / 1024 ** 3).toFixed(1)} GB`

/** Help: where data lives, version, and the keyboard and mouse controls. */
function HelpDialog({ boardCount, onExport, onClose, initialTab = 'data' }: { boardCount: number; onExport: () => void; onClose: () => void; initialTab?: 'data' | 'keys' }) {
  const [tab, setTab] = useState(initialTab)
  const [storage, setStorage] = useState<StorageInfo>({ persisted: null, usage: null, quota: null })
  const [server, setServer] = useState<string | null>(null)
  useEffect(() => {
    void (async () => {
      try {
        const [persisted, estimate] = await Promise.all([navigator.storage?.persisted?.() ?? null, navigator.storage?.estimate?.() ?? null])
        setStorage({ persisted, usage: estimate?.usage ?? null, quota: estimate?.quota ?? null })
      } catch { /* storage API unavailable */ }
    })()
    fetch('/api/health').then(r => r.json()).then(body => setServer(typeof body.version === 'string' ? body.version : null)).catch(() => setServer(null))
  }, [])
  const persist = async () => {
    try { const granted = await navigator.storage.persist(); setStorage(current => ({ ...current, persisted: granted })) } catch { setStorage(current => ({ ...current, persisted: false })) }
  }
  const rows: [string, string[]][] = [
    ['Command palette / jump to entity', [mod, 'K']], ['Focus search', ['/']], ['New entity at centre', ['N']], ['Fit view / center selection', ['F']],
    ['Group selected entities', ['G']], ['Switch view', ['1', '–', '4']], ['Toggle explorer', ['E']], ['Toggle evidence window', ['T']], ['Undo / redo', [mod, 'Z', '·', '⇧', mod, 'Z']],
    ['Delete selection', ['⌫']], ['Close / deselect', ['Esc']], ['Rename node', ['double-click']], ['Connect', ['drag right handle']],
  ]
  const pointer: [string, string][] = [
    ['Zoom', 'Mouse wheel · trackpad pinch'], ['Pan', 'Right-drag · trackpad two-finger scroll · Space + drag'],
    ['Select area', 'Left-drag on empty canvas'], ['Add to selection', 'Shift + click'], ['Scroll sideways', 'Shift + mouse wheel'],
  ]
  const mismatch = server && server !== __APP_VERSION__
  return <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}>
    <div className="modal help-modal" role="dialog" aria-modal="true" aria-label="Help">
      <div className="modal-header"><div className="help-title"><span className="brand-mark"><GitBranch size={13} strokeWidth={2.4} /></span><h2>FactGraph</h2><span className="version-chip" title="App version">v{__APP_VERSION__}</span></div>
        <button className="icon-button" onClick={onClose} aria-label="Close dialog"><X size={18} /></button></div>
      <div className="help-tabs"><div className="segmented full" role="tablist" aria-label="Help topics">
        <button role="tab" aria-selected={tab === 'data'} className={tab === 'data' ? 'active' : ''} onClick={() => setTab('data')}>Where your data lives</button>
        <button role="tab" aria-selected={tab === 'keys'} className={tab === 'keys' ? 'active' : ''} onClick={() => setTab('keys')}>Keyboard & mouse</button></div></div>
      <div className="modal-body">
        {tab === 'data' ? <>
          <div className="storage-hero"><HardDrive size={20} /><div><strong>Everything stays in this browser.</strong><p>Boards, entities, evidence and their history are stored only in this browser's local database (IndexedDB) on this device.</p></div></div>
          <ul className="help-list">
            <li><Server size={15} /><span><strong>The server stores nothing.</strong> It delivers the app and relays changes live between browsers that have the same board open.</span></li>
            <li><Users size={15} /><span><strong>Sharing works while a browser is open.</strong> Another device receives the board only while a browser that holds it is connected. The board link itself contains no data.</span></li>
            <li><Plug size={15} /><span><strong>Agents need an open board.</strong> REST and MCP write through this browser tab; without it they report the board as offline.</span></li>
            <li><AlertTriangle size={15} /><span><strong>Deleting browser data deletes the boards.</strong> Clearing site data, private windows or cleanup tools remove them for good — export a JSON backup regularly.</span></li>
            <li><Lock size={15} /><span><strong>No login.</strong> Anyone who can reach this server and knows a board link can read and change that board. Only expose FactGraph in trusted networks.</span></li>
          </ul>
          <div className="storage-status">
            <div><span>This browser</span><strong>{boardCount} {boardCount === 1 ? 'board' : 'boards'}{storage.usage !== null ? ` · ${formatBytes(storage.usage)} used` : ''}{storage.quota ? ` of ${formatBytes(storage.quota)}` : ''}</strong></div>
            <div><span>Protected from automatic cleanup</span><strong className={storage.persisted ? 'ok-text' : 'warn-text'}>{storage.persisted === null ? 'unknown' : storage.persisted ? 'Yes' : 'No'}</strong></div>
            <div className="storage-actions">
              {storage.persisted === false && <button className="secondary-button small" onClick={() => void persist()}><ShieldCheck size={14} /> Ask browser to keep data</button>}
              <button className="secondary-button small" onClick={onExport}><ArrowDownToLine size={14} /> Export board JSON</button>
            </div>
          </div>
          <p className="hint version-line">App v{__APP_VERSION__}{server ? ` · server v${server}` : ''}{mismatch ? ' — versions differ, reload the page after an update.' : ''} · <a href="/docs" target="_blank" rel="noreferrer">REST documentation</a></p>
        </> : <>
          <dl className="shortcut-list">{rows.map(([label, keys]) => <div key={label}><dt>{label}</dt><dd>{keys.map((k, i) => ['–', '·'].includes(k) || k.includes(' ') ? <span key={i} className="muted">{k}</span> : <Kbd key={i}>{k}</Kbd>)}</dd></div>)}</dl>
          <div className="form-divider">Mouse & trackpad</div>
          <dl className="shortcut-list">{pointer.map(([label, text]) => <div key={label}><dt>{label}</dt><dd className="muted">{text}</dd></div>)}</dl>
        </>}
      </div>
    </div>
  </div>
}

type AgentClient = 'vscode' | 'claude' | 'other'
/** Copy-ready MCP/REST configuration for this board, including the token header. */
function AgentConnectDialog({ boardId, token, onCopy, onClose }: { boardId: string; token: string; onCopy: (value: string, label: string) => void; onClose: () => void }) {
  const [client, setClient] = useState<AgentClient>('vscode')
  const [embed, setEmbed] = useState(false)
  const origin = window.location.origin
  const mcpUrl = `${origin}/mcp/`
  const vscode = JSON.stringify(embed
    ? { servers: { factgraph: { type: 'http', url: mcpUrl, headers: { 'X-FactGraph-Token': token } } } }
    : { inputs: [{ type: 'promptString', id: 'factgraph-token', description: 'FactGraph session token (board menu → API/MCP)', password: true }],
        servers: { factgraph: { type: 'http', url: mcpUrl, headers: { 'X-FactGraph-Token': '${input:factgraph-token}' } } } }, null, 2)
  const claude = `claude mcp add --transport http factgraph ${mcpUrl} --header "X-FactGraph-Token: ${token}"`
  const prompt = `Use the FactGraph MCP server for this investigation. Board ID: ${boardId}. Read the board with get_graph or find_entities before adding anything.`
  const curl = `curl -s "${origin}/api/boards/${boardId}/graph" -H "X-FactGraph-Token: ${token}"`
  const Snippet = ({ label, value, hint }: { label: string; value: string; hint?: string }) => <div className="snippet">
    <div className="snippet-head"><span>{label}</span><button className="text-button" onClick={() => onCopy(value, label)}><Copy size={13} /> Copy</button></div>
    <pre>{value}</pre>{hint && <p className="hint">{hint}</p>}</div>
  return <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}>
    <div className="modal help-modal" role="dialog" aria-modal="true" aria-label="Connect an agent">
      <div className="modal-header"><h2>Connect an agent</h2><button className="icon-button" onClick={onClose} aria-label="Close dialog"><X size={18} /></button></div>
      <div className="help-tabs"><div className="segmented full" role="tablist" aria-label="Agent client">
        {([['vscode', 'VS Code / Copilot'], ['claude', 'Claude Code'], ['other', 'Other / REST']] as [AgentClient, string][]).map(([id, label]) =>
          <button key={id} role="tab" aria-selected={client === id} className={client === id ? 'active' : ''} onClick={() => setClient(id)}>{label}</button>)}</div></div>
      <div className="modal-body">
        {client === 'vscode' && <>
          <Snippet label=".vscode/mcp.json" value={vscode} hint={embed ? 'Contains this session’s token — do not commit it.' : 'VS Code asks for the token when the server starts, so the file can be committed.'} />
          <label className="check"><input type="checkbox" checked={embed} onChange={e => setEmbed(e.target.checked)} /> Put the token into the file instead of asking</label>
          <Snippet label="Token" value={token} hint="Paste it when VS Code asks for “FactGraph session token”." />
          <p className="hint">Then run <strong>MCP: List Servers</strong> → factgraph → Start, and pick the FactGraph tools in the agent tool picker.</p>
        </>}
        {client === 'claude' && <Snippet label="Terminal" value={claude} hint="Adds the server with the token header to Claude Code (use --scope project to share the config, without the token)." />}
        {client === 'other' && <>
          <Snippet label="MCP endpoint (Streamable HTTP)" value={mcpUrl} />
          <Snippet label="Header" value={`X-FactGraph-Token: ${token}`} hint="Or pass session_token in every tool call." />
          <Snippet label="REST example" value={curl} hint="Full REST reference under /docs." />
        </>}
        <Snippet label="First message for the agent" value={prompt} hint="Tools need the board ID; the token only authorises the connection." />
        <p className="hint lock-hint"><Lock size={13} /> The token belongs to this browser tab and stays valid while it is open. Opening the board in a new tab or browser creates a new token.</p>
      </div>
    </div>
  </div>
}

/** First visit: choose the name other analysts see next to presence and changes. */
function WelcomeDialog({ current, onSave, onLearnMore }: { current: string; onSave: (name: string) => void; onLearnMore: () => void }) {
  const [name, setName] = useState('')
  return <div className="modal-backdrop">
    <div className="modal narrow" role="dialog" aria-modal="true" aria-label="Welcome">
      <div className="modal-header"><div className="help-title"><span className="brand-mark"><GitBranch size={13} strokeWidth={2.4} /></span><h2>Welcome to FactGraph</h2></div></div>
      <form onSubmit={event => { event.preventDefault(); onSave(name.trim() || current) }}>
        <div className="modal-body">
          <label>Your name<input autoFocus value={name} onChange={e => setName(e.target.value)} placeholder={current} maxLength={40} aria-label="Your name" /></label>
          <p className="hint">Shown to other analysts on the same board and stored with your changes. You can change it later in the board menu.</p>
          <button type="button" className="empty-storage" onClick={onLearnMore}><HardDrive size={13} /> Your boards are stored only in this browser — learn more</button>
        </div>
        <div className="modal-actions"><button type="button" className="secondary-button" onClick={() => onSave(current)}>Skip</button><button className="primary-button">Continue</button></div>
      </form>
    </div>
  </div>
}

function Menu({ label, trigger, children, className = '', align = 'left' }: { label: string; trigger: ReactNode; children: ReactNode; className?: string; align?: 'left' | 'right' }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (event: MouseEvent) => { if (!ref.current?.contains(event.target as Node)) setOpen(false) }
    const esc = (event: KeyboardEvent) => { if (event.key === 'Escape') { setOpen(false); event.stopImmediatePropagation() } }
    document.addEventListener('mousedown', close); window.addEventListener('keydown', esc, true)
    return () => { document.removeEventListener('mousedown', close); window.removeEventListener('keydown', esc, true) }
  }, [open])
  return <div className={`menu ${className}`} ref={ref}>
    <button className={`menu-trigger ${open ? 'open' : ''}`} aria-label={label} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>{trigger}</button>
    {open && <div className={`menu-content popover ${align}`} role="menu" onClick={event => { if ((event.target as HTMLElement).closest('button, a')) setOpen(false) }}>{children}</div>}
  </div>
}

export default function App() {
  const [boardId] = useState(currentBoardId)
  const board = useBoard(boardId)
  const data = board.ready ? board.data : null
  const [selection, setSelectionState] = useState<Selection>(null)
  const [dialog, setDialog] = useState<DialogKind>(null)
  const [readerId, setReaderId] = useState<string | null>(null)
  const [editingAssertionId, setEditingAssertionId] = useState<string | null>(null)
  const [relationTargetId, setRelationTargetId] = useState<string | null>(null)
  const [explorerOpen, setExplorerOpen] = useState(() => { const v = readPref('explorer'); return v === null ? window.innerWidth >= 1280 : v === 'true' })
  // Light is the default; dark is an explicit choice that is remembered.
  const [theme, setTheme] = useState<Theme>(() => readPref('theme') === 'dark' ? 'dark' : 'light')
  const [search, setSearch] = useState('')
  const [stateFilter, setStateFilter] = useState<TruthState | 'all'>('all')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [toast, setToast] = useState('')
  const [showLogImport, setShowLogImport] = useState(false)
  const [showPalette, setShowPalette] = useState(false)
  const [showHelp, setShowHelp] = useState<false | 'data' | 'keys'>(false)
  const [showConnect, setShowConnect] = useState(false)
  const [askName, setAskName] = useState(() => { try { return !localStorage.getItem('factgraph:displayName') } catch { return false } })
  const [showTime, setShowTime] = useState(false)
  const [request, setRequest] = useState<CanvasRequest | null>(null)
  // Layer visibility and display options; a saved perspective can set them in one step.
  const [lens, setLensState] = useState<Lens>(() => {
    try { const raw = JSON.parse(localStorage.getItem('factgraph:lens') ?? 'null'); if (raw) return { layers: Array.isArray(raw.layers) ? new Set<string>(raw.layers.filter((l: string) => LAYER_IDS.includes(l))) : null, collapseActivities: !!raw.collapseActivities, showLanes: !!raw.showLanes } } catch { /* ignore */ }
    return { layers: null, collapseActivities: false, showLanes: false }
  })
  const [activePerspective, setActivePerspective] = useState<string | null>(() => new URLSearchParams(location.search).get('lens'))
  const setLens = (next: Lens, keepPerspective = false) => {
    setLensState(next)
    writePref('lens', JSON.stringify({ layers: next.layers ? [...next.layers] : null, collapseActivities: next.collapseActivities, showLanes: next.showLanes }))
    if (!keepPerspective) setPerspectiveParam(null)
  }
  const setPerspectiveParam = (id: string | null) => {
    setActivePerspective(id)
    const url = new URL(location.href)
    if (id) url.searchParams.set('lens', id); else url.searchParams.delete('lens')
    history.replaceState(null, '', url)
  }
  const searchInput = useRef<HTMLInputElement>(null)
  const canvas = (type: CanvasRequest['type'], extra: Partial<CanvasRequest> = {}) => setRequest(current => ({ type, n: (current?.n ?? 0) + 1, ...extra }))
  const tabFromUrl = (): WorkspaceTab => {
    const tab = new URLSearchParams(location.search).get('view')
    return tab === 'timeline' || tab === 'review' || tab === 'activity' ? tab : 'graph'
  }
  const [activeTab, updateActiveTab] = useState<WorkspaceTab>(tabFromUrl)
  const setActiveTab = (tab: WorkspaceTab) => {
    if (tab === activeTab) return
    const url = new URL(location.href)
    if (tab === 'graph') url.searchParams.delete('view'); else url.searchParams.set('view', tab)
    history.pushState(null, '', url)
    updateActiveTab(tab)
  }
  const setSelection = (next: Selection, focus = false) => {
    setSelectionState(next)
    if (next && focus) { if (activeTab !== 'graph') setActiveTab('graph'); window.setTimeout(() => canvas('focus', { id: next.id }), 30) }
  }
  useEffect(() => {
    const onBack = () => updateActiveTab(tabFromUrl())
    window.addEventListener('popstate', onBack)
    return () => window.removeEventListener('popstate', onBack)
  }, [])
  useEffect(() => { document.documentElement.dataset.theme = theme; document.querySelector('meta[name=theme-color]')?.setAttribute('content', theme === 'dark' ? '#0c0e13' : '#f7f8fa') }, [theme])
  const perspectiveApplied = useRef(false)
  useEffect(() => {
    if (perspectiveApplied.current || !data || !activePerspective) return
    perspectiveApplied.current = true
    const view = data.views?.find(v => v.id === activePerspective)
    if (view) setLens({ layers: view.layers ? new Set(view.layers) : null, collapseActivities: view.collapse_activities, showLanes: view.show_lanes }, true)
  }, [data, activePerspective])
  const applyPerspective = (id: string | null) => {
    const view = id ? data?.views?.find(v => v.id === id) : null
    if (!view) { setPerspectiveParam(null); return }
    setLens({ layers: view.layers ? new Set(view.layers) : null, collapseActivities: view.collapse_activities, showLanes: view.show_lanes }, true)
    setPerspectiveParam(view.id)
  }
  const [evidenceFrom, setEvidenceFrom] = useState('')
  const [evidenceTo, setEvidenceTo] = useState('')
  const [includeUndated, setIncludeUndated] = useState(true)
  const importInput = useRef<HTMLInputElement>(null)

  useEffect(() => { if (toast) { const timer = window.setTimeout(() => setToast(''), 3000); return () => clearTimeout(timer) } }, [toast])

  const act = async (action: () => Promise<unknown>, message: string) => {
    setBusy(true); setError('')
    try { await action(); setDialog(null); setRelationTargetId(null); setToast(message) }
    catch (problem) { setError(problem instanceof Error ? problem.message : 'Something went wrong.') }
    finally { setBusy(false) }
  }

  const submit = async (kind: Exclude<DialogKind, null>, values: Record<string, unknown>) => {
    if (!data) return
    const created_at = new Date().toISOString()
    if (kind === 'entity') {
      const id = uuid()
      await act(async () => { await board.emit('entity.add', { id, ...values, created_at }); setSelection({ kind: 'entity', id }, true) }, 'Entity saved')
    }
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
        ...values, normalized_value: normalizeIdentifier(scheme, raw) }), 'Identifier saved')
    } else if (kind === 'fact') {
      const assertion = values.assertion as Record<string, unknown>
      const newObjectName = String(values.new_object_name ?? '').trim()
      const newObjectId = newObjectName ? uuid() : ''
      const subject = data.entities.find(e => e.id === String(values.subject_id))
      const fact = { id: uuid(), subject_id: String(values.subject_id),
        predicate: String(values.predicate).trim(), object_id: newObjectId || String(values.object_id),
        valid_from: values.valid_from as string | null, valid_to: values.valid_to as string | null, created_at }
      const existing = data.facts.find(item => factKey(item) === factKey(fact))
      const assertionPayload = { id: uuid(), fact_id: existing?.id ?? fact.id, ...assertion, created_at }
      if (existing) await act(() => board.emit('assertion.add', assertionPayload), 'Evidence added to existing relationship')
      else await act(async () => {
        await board.emitMany([
          ...(newObjectId ? [{ type: 'entity.add' as const, payload: { id: newObjectId,
            name: newObjectName, kind: String(values.new_object_kind || 'Other'),
            description: '', created_at, ...(subject?.position ? { x: subject.position.x + 320, y: subject.position.y } : {}) } }] : []),
          { type: 'fact.add', payload: fact }, { type: 'assertion.add', payload: assertionPayload },
        ])
        setSelection({ kind: 'fact', id: fact.id })
      }, 'Relationship saved')
    } else if (kind === 'assertion' && selection?.kind === 'fact')
      await act(() => board.emit('assertion.add', { id: uuid(), fact_id: selection.id,
        ...values, created_at }), 'Evidence saved')
    else if (kind === 'assertion-edit' && editingAssertionId)
      await act(() => board.emit('assertion.update', { id: editingAssertionId, ...values }), 'Evidence updated')
  }

  const deleteItem = (kind: 'entity' | 'fact' | 'identifier' | 'group', id: string) => {
    const text = kind === 'entity' ? 'Delete this entity and its relationships?' : kind === 'fact' ? 'Delete this relationship and all evidence?' : kind === 'group' ? 'Ungroup? The entities stay on the board.' : 'Delete this identifier?'
    if (!window.confirm(text)) return
    const type = kind === 'entity' ? 'entity.delete' : kind === 'fact' ? 'fact.delete' : kind === 'group' ? 'group.delete' : 'identifier.delete'
    void act(async () => { await board.emit(type, { id }); if (kind !== 'identifier') setSelection(null) }, 'Deleted · undo available')
  }
  const undo = () => void board.undo().then(changed => setToast(changed ? 'Change undone' : 'Nothing to undo')).catch(e => setError(String(e)))
  const redo = () => void board.redo().then(changed => setToast(changed ? 'Change restored' : 'Nothing to redo')).catch(e => setError(String(e)))
  const toggleExplorer = () => setExplorerOpen(current => { writePref('explorer', String(!current)); return !current })
  const toggleTheme = () => setTheme(current => { const next = current === 'dark' ? 'light' : 'dark'; writePref('theme', next); return next })

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      const typing = !!target && (['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || target.isContentEditable)
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); setShowPalette(open => !open); return }
      if (event.key === 'Escape') {
        if (showPalette) setShowPalette(false)
        else if (showConnect) setShowConnect(false)
        else if (showHelp) setShowHelp(false)
        else if (dialog) setDialog(null)
        else if (showLogImport) setShowLogImport(false)
        else if (readerId) setReaderId(null)
        else if (typing && target === searchInput.current) { setSearch(''); target.blur() }
        else setSelection(null)
        return
      }
      if (typing || showPalette || dialog || readerId || showLogImport || showHelp || showConnect || askName) return
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); if (event.shiftKey) redo(); else undo(); return }
      if (event.metaKey || event.ctrlKey || event.altKey) return
      if ((event.key === 'Delete' || event.key === 'Backspace') && selection) { event.preventDefault(); deleteItem(selection.kind, selection.id); return }
      if (event.key === '/') { event.preventDefault(); searchInput.current?.focus() }
      else if (event.key === '?') setShowHelp('keys')
      else if (event.key.toLowerCase() === 'e') toggleExplorer()
      else if (event.key.toLowerCase() === 't') setShowTime(open => !open)
      else if (['1', '2', '3', '4'].includes(event.key)) setActiveTab((['graph', 'timeline', 'review', 'activity'] as WorkspaceTab[])[Number(event.key) - 1])
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [board.undo, board.redo, dialog, selection, showLogImport, readerId, showPalette, showHelp, showConnect, askName, activeTab])

  const navigate = (id: string) => { writePref('lastBoard', id); window.location.assign(`/boards/${id}`) }
  const copyValue = async (value: string, label: string) => {
    try { await navigator.clipboard.writeText(value); setToast(`${label} copied`) }
    catch { window.prompt(`Copy ${label}:`, value) }
  }
  const mcpEndpoint = `${window.location.origin}/mcp/`
  const restDocsEndpoint = `${window.location.origin}/docs`
  const exportJson = () => JSON.stringify({ format: 'factgraph-board-v1', boardId, name: board.boardName, actions: board.actions }, null, 2)
  const download = () => {
    const url = URL.createObjectURL(new Blob([exportJson()], { type: 'application/json' }))
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
  const renameBoard = () => { const value = window.prompt('Board name', board.boardName); if (value?.trim()) void act(() => board.emit('board.rename', { name: value.trim() }), 'Board renamed') }
  const renameSelf = () => { const value = window.prompt('Your display name', board.name); if (value?.trim()) board.setName(value) }
  const openDialog = (kind: DialogKind) => { setError(''); setDialog(kind) }

  const timeFacts = useMemo(() => factsInWindow(data?.facts ?? [], evidenceFrom || null, evidenceTo || null, includeUndated), [data, evidenceFrom, evidenceTo, includeUndated])
  const filteredFacts = useMemo(() => timeFacts.filter(item => stateFilter === 'all' || item.truth_state === stateFilter), [timeFacts, stateFilter])
  const counts = useMemo(() => Object.fromEntries(allStates.map(state => [state, timeFacts.filter(item => item.truth_state === state).length])) as Record<TruthState, number>, [timeFacts])
  const reviewCount = useMemo(() => data?.facts.reduce((sum, f) => sum + f.assertions.filter(a => !a.retracted_at && a.review_status !== 'confirmed').length, 0) ?? 0, [data])
  const timelineCount = useMemo(() => timelineEvents(filteredFacts).length, [filteredFacts])
  const matchCount = useMemo(() => {
    const q = search.trim().toLowerCase()
    return q && data ? data.entities.filter(e => `${e.name} ${e.kind} ${e.identifiers.map(i => i.raw_value).join(' ')}`.toLowerCase().includes(q)).length : 0
  }, [data, search])
  const timeActive = !!(evidenceFrom || evidenceTo) || !includeUndated
  const filterSummary = [
    activePerspective ? `Perspective ${data?.views?.find(v => v.id === activePerspective)?.name ?? ''}` : '',
    lens.layers ? `Layers: ${LAYERS.filter(l => lens.layers!.has(l.id)).map(l => l.label).join(', ')}` : '',
    stateFilter !== 'all' ? `Status: ${labels[stateFilter]}` : '',
    evidenceFrom || evidenceTo ? `Evidence ${periodLabel(evidenceFrom || null, evidenceTo || null)}` : '',
    !includeUndated ? 'dated evidence only' : '',
  ].filter(Boolean).join(' · ')

  const paletteItems = useMemo<PaletteItem[]>(() => {
    const actions: PaletteItem[] = [
      { id: 'a-entity', group: 'Create', label: 'New entity', hint: 'N', icon: <Plus size={15} />, run: () => { setActiveTab('graph'); canvas('place') } },
      { id: 'a-entity-form', group: 'Create', label: 'New entity with details…', icon: <Plus size={15} />, run: () => openDialog('entity') },
      { id: 'a-fact', group: 'Create', label: 'New relationship…', icon: <Link2 size={15} />, run: () => openDialog('fact') },
      { id: 'a-source', group: 'Create', label: 'New source…', icon: <FileText size={15} />, run: () => openDialog('source') },
      { id: 'a-activity', group: 'Create', label: 'New activity (several participants)…', icon: <Zap size={15} />, run: () => openDialog('activity') },
      { id: 'v-graph', group: 'View', label: 'Graph', hint: '1', icon: <GitBranch size={15} />, run: () => setActiveTab('graph') },
      { id: 'v-timeline', group: 'View', label: 'Timeline', hint: '2', icon: <Clock size={15} />, run: () => setActiveTab('timeline') },
      { id: 'v-review', group: 'View', label: 'Evidence review', hint: '3', icon: <ShieldCheck size={15} />, run: () => setActiveTab('review') },
      { id: 'v-activity', group: 'View', label: 'Activity', hint: '4', icon: <Activity size={15} />, run: () => setActiveTab('activity') },
      { id: 'c-fit', group: 'Canvas', label: 'Fit graph to screen', hint: 'F', icon: <Crosshair size={15} />, run: () => { setActiveTab('graph'); canvas('fit') } },
      { id: 'c-arrange', group: 'Canvas', label: 'Auto-arrange graph', icon: <Sparkles size={15} />, run: () => { setActiveTab('graph'); canvas('arrange') } },
      { id: 'c-arrange-organic', group: 'Canvas', label: 'Arrange organically (large graphs)', icon: <Sparkles size={15} />, run: () => { setActiveTab('graph'); canvas('arrange-organic') } },
      { id: 'c-arrange-layers', group: 'Canvas', label: 'Arrange by layer (swimlanes)', icon: <Layers size={15} />, run: () => { setActiveTab('graph'); canvas('arrange-layers') } },
      { id: 'c-all-layers', group: 'Canvas', label: 'Show all layers', icon: <Layers size={15} />, run: () => setLens({ ...lens, layers: null }) },
      { id: 'c-activities', group: 'Canvas', label: lens.collapseActivities ? 'Show activities as event nodes' : 'Show activities as edges', icon: <Zap size={15} />, run: () => setLens({ ...lens, collapseActivities: !lens.collapseActivities }) },
      ...LAYERS.map(layer => ({ id: `l-${layer.id}`, group: 'Layers', label: `Only ${layer.label}`, hint: layer.hint, icon: <Layers size={15} />, run: () => { setActiveTab('graph'); setLens({ ...lens, layers: new Set([layer.id]) }) } })),
      ...(data?.views ?? []).map(view => ({ id: `p-${view.id}`, group: 'Perspectives', label: view.name, icon: <Layers size={15} />, run: () => { setActiveTab('graph'); applyPerspective(view.id) } })),
      ...(data?.groups ?? []).map(group => ({ id: `g-${group.id}`, group: 'Groups', label: group.name, hint: `${group.member_ids.length} members`, icon: <Boxes size={15} />, run: () => setSelection({ kind: 'group', id: group.id }, true) })),
      { id: 'c-explorer', group: 'Canvas', label: explorerOpen ? 'Hide entity explorer' : 'Show entity explorer', hint: 'E', icon: <ListTree size={15} />, run: toggleExplorer },
      { id: 'c-time', group: 'Canvas', label: showTime ? 'Hide evidence window' : 'Show evidence window', hint: 'T', icon: <Clock size={15} />, run: () => setShowTime(!showTime) },
      { id: 'c-theme', group: 'Canvas', label: theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme', icon: theme === 'dark' ? <Sun size={15} /> : <Moon size={15} />, run: toggleTheme },
      { id: 'x-png', group: 'Export', label: 'Export graph as PNG', icon: <ImageDown size={15} />, run: () => { setActiveTab('graph'); window.setTimeout(() => canvas('export', { kind: 'png' }), 50) } },
      { id: 'x-svg', group: 'Export', label: 'Export graph as SVG (vector)', icon: <ImageDown size={15} />, run: () => { setActiveTab('graph'); window.setTimeout(() => canvas('export', { kind: 'svg' }), 50) } },
      { id: 'b-import-logs', group: 'Board', label: 'Import logs / KQL results…', icon: <Upload size={15} />, run: () => setShowLogImport(true) },
      { id: 'b-export', group: 'Board', label: 'Export board JSON', icon: <ArrowDownToLine size={15} />, run: download },
      { id: 'b-import', group: 'Board', label: 'Import board JSON…', icon: <Upload size={15} />, run: () => importInput.current?.click() },
      { id: 'b-link', group: 'Board', label: 'Copy board link', icon: <Copy size={15} />, run: () => void copyValue(window.location.href, 'Board link') },
      { id: 'b-token', group: 'Board', label: 'Copy session token (REST + MCP)', icon: <Plug size={15} />, run: () => void copyValue(board.sessionToken, 'Session token') },
      { id: 'b-connect', group: 'Board', label: 'Connect an agent (VS Code, Claude Code)…', icon: <Plug size={15} />, run: () => setShowConnect(true) },
      { id: 'b-help', group: 'Board', label: 'Keyboard & mouse controls', hint: '?', icon: <Keyboard size={15} />, run: () => setShowHelp('keys') },
      { id: 'b-data', group: 'Board', label: 'Where is my data stored?', icon: <HardDrive size={15} />, run: () => setShowHelp('data') },
    ]
    const entities: PaletteItem[] = (data?.entities ?? []).map(entity => ({ id: `e-${entity.id}`, group: 'Entities', label: entity.name,
      hint: `${entity.kind}${entity.identifiers[0] ? ` · ${entity.identifiers[0].raw_value}` : ''}`, icon: <EntityAvatar entity={entity} data={data ?? undefined} size="sm" />,
      run: () => setSelection({ kind: 'entity', id: entity.id }, true) }))
    return [...actions, ...entities]
  }, [data, explorerOpen, showTime, theme, board.sessionToken, activeTab, lens, activePerspective])

  const tabs: { id: WorkspaceTab; label: string; short: string; icon: ReactNode; count: number }[] = [
    { id: 'graph', label: 'Graph', short: 'Graph', icon: <GitBranch size={14} />, count: data?.entities.length ?? 0 },
    { id: 'timeline', label: 'Timeline', short: 'Timeline', icon: <Clock size={14} />, count: timelineCount },
    { id: 'review', label: 'Evidence review', short: 'Review', icon: <ShieldCheck size={14} />, count: reviewCount },
    { id: 'activity', label: 'Activity', short: 'Activity', icon: <Activity size={14} />, count: board.actions.length },
  ]
  const showInspector = !!(data && selection)

  return <div className={`app-shell${explorerOpen ? ' explorer-open' : ''}${showInspector ? ' inspector-open' : ''}`}>
    <header className="topbar compact-header">
      <div className="topbar-left">
        <button className={`icon-button explorer-toggle ${explorerOpen ? 'active' : ''}`} onClick={toggleExplorer} aria-label={explorerOpen ? 'Hide explorer' : 'Show explorer'} title="Entity explorer · E"><ListTree size={16} /></button>
        <Menu label="Board menu" className="board-menu" trigger={<><span className="brand-mark"><GitBranch size={13} strokeWidth={2.4} /></span><strong className="board-name">{board.boardName}</strong><ChevronDown size={13} /></>}>
          <div className="menu-label">Board</div>
          <button onClick={renameBoard}><Pencil size={14} /> Rename board</button>
          <button onClick={() => void copyValue(window.location.href, 'Board link')}><Link2 size={14} /> Copy board link</button>
          <button onClick={() => void copyValue(boardId, 'Board ID')}><Copy size={14} /> Copy board ID</button>
          <div className="menu-sep" />
          <button onClick={() => setShowLogImport(true)}><Upload size={14} /> Import logs / KQL</button>
          <button onClick={() => importInput.current?.click()}><Upload size={14} /> Import board JSON</button>
          <button onClick={download}><ArrowDownToLine size={14} /> Export board JSON</button>
          <button onClick={() => { setActiveTab('graph'); window.setTimeout(() => canvas('export', { kind: 'png' }), 50) }}><ImageDown size={14} /> Export graph as PNG</button>
          <button onClick={() => { setActiveTab('graph'); window.setTimeout(() => canvas('export', { kind: 'svg' }), 50) }}><ImageDown size={14} /> Export graph as SVG</button>
          <button onClick={() => void copyValue(exportJson(), 'Board JSON')}><Copy size={14} /> Copy board JSON</button>
          <div className="menu-sep" />
          <div className="menu-label">Boards in this browser</div>
          <div className="menu-scroll">{board.boards.map(item => <button key={item.id} className={item.id === boardId ? 'current' : ''} onClick={() => navigate(item.id)}><span className="menu-board-name">{item.name}</span><small>{item.id.slice(0, 8)}</small></button>)}</div>
          <button onClick={() => navigate(uuid())}><Plus size={14} /> New board</button>
          <div className="menu-sep" />
          <button onClick={renameSelf}>Display name · <strong>{board.name}</strong></button>
          <div className="menu-sep" />
          <button className="menu-footer" onClick={() => setShowHelp('data')}><HardDrive size={14} /><span>Stored only in this browser</span><small>v{__APP_VERSION__}</small></button>
        </Menu>
        <span className={`presence ${board.connected ? 'online' : 'offline'}`} title={board.connected ? `Relay connected${board.peers.length ? ` · ${board.peers.map(p => p.name).join(', ')}` : ''}` : 'Relay offline: changes stay in this browser and sync when the connection returns.'}>
          <span className="connection-dot" /><span className="presence-text">{board.connected ? `${board.peers.length + 1} online` : 'Offline'}</span></span>
      </div>
      <nav className="view-tabs" role="tablist" aria-label="Board views">
        {tabs.map(tab => <button key={tab.id} role="tab" aria-label={tab.label} aria-selected={activeTab === tab.id} className={activeTab === tab.id ? 'active' : ''} onClick={() => setActiveTab(tab.id)} title={tab.label}>
          {tab.icon}<span className="tab-text">{tab.short}</span>{tab.count > 0 && <b className={tab.id === 'review' ? 'attention' : ''}>{tab.count > 9999 ? '9k+' : tab.count}</b>}</button>)}
      </nav>
      <div className="topbar-right">
        <div className={`header-search ${search ? 'has-value' : ''}`}><Search size={14} /><input ref={searchInput} aria-label="Search graph" placeholder="Search…" value={search} onChange={e => setSearch(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && search.trim() && data) { const q = search.trim().toLowerCase(); const hit = data.entities.find(x => `${x.name} ${x.kind} ${x.identifiers.map(i => i.raw_value).join(' ')}`.toLowerCase().includes(q)); if (hit) setSelection({ kind: 'entity', id: hit.id }, true) } }} />
          {search ? <><span className="search-count">{matchCount}</span><button className="icon-button" aria-label="Clear search" onClick={() => setSearch('')}><X size={12} /></button></> : <Kbd>/</Kbd>}</div>
        <button className="icon-button command-button hide-sm" onClick={() => setShowPalette(true)} aria-label="Command palette" title={`Command palette · ${mod}K`}><Command size={15} /></button>
        <button className={`icon-button hide-sm ${showTime ? 'active' : ''} ${timeActive ? 'flagged' : ''}`} onClick={() => setShowTime(!showTime)} aria-label="Evidence window" aria-pressed={showTime} title="Evidence time window · T"><Clock size={15} /></button>
        <span className="topbar-sep" />
        <button className="icon-button" aria-label="Undo" title={`Undo · ${mod}Z`} onClick={undo}><Undo2 size={15} /></button>
        <button className="icon-button hide-sm" aria-label="Redo" title={`Redo · ⇧${mod}Z`} onClick={redo}><Redo2 size={15} /></button>
        <span className="topbar-sep" />
        <Menu label="Create" align="right" className="create-menu" trigger={<><Plus size={15} /><span className="trigger-text">Create</span></>}>
          <button onClick={() => { setActiveTab('graph'); canvas('place') }}><Plus size={14} /> Entity <Kbd>N</Kbd></button>
          <button onClick={() => openDialog('entity')}><Pencil size={14} /> Entity with details…</button>
          <button onClick={() => openDialog('fact')} disabled={!data || data.entities.length < 2}><Link2 size={14} /> Relationship…</button>
          <button onClick={() => openDialog('activity')} disabled={!data || data.entities.length < 2}><Zap size={14} /> Activity…</button>
          <button onClick={() => openDialog('source')}><FileText size={14} /> Source…</button>
        </Menu>
        <Menu label="API and MCP" align="right" className="api-menu" trigger={<Plug size={15} />}>
          <div className="menu-label">Integrations</div>
          <button onClick={() => setShowConnect(true)}><Plug size={14} /> Connect an agent…</button>
          <button onClick={() => void copyValue(mcpEndpoint, 'MCP endpoint')}><Copy size={14} /> Copy MCP endpoint</button>
          <button onClick={() => void copyValue(`${window.location.origin}/api/boards/${boardId}`, 'REST endpoint')}><Copy size={14} /> Copy REST board endpoint</button>
          <button onClick={() => void copyValue(board.sessionToken, 'Session token')}><Copy size={14} /> Copy session token</button>
          <a href={restDocsEndpoint} target="_blank" rel="noreferrer"><FileText size={14} /> REST documentation</a>
          <p className="menu-note">Same token for REST + MCP. Keep this board open while agents write.</p>
        </Menu>
        <button className="icon-button theme-toggle" onClick={toggleTheme} aria-label={theme === 'dark' ? 'Light theme' : 'Dark theme'} title="Toggle theme">{theme === 'dark' ? <Sun size={15} /> : <Moon size={15} />}</button>
        <button className="icon-button help-button" onClick={() => setShowHelp('data')} aria-label="Help and data storage" title="Help · data storage · shortcuts"><CircleHelp size={16} /></button>
      </div>
    </header>

    <div className="workspace">
      {explorerOpen && data && <Explorer data={data} search={search} selection={selection} onSelect={setSelection} onClose={toggleExplorer} />}
      <main className={`stage${showTime ? ' time-open' : ''}`}>
        {activeTab === 'graph' && <div className="graph-stage">
          {data && <GraphView entityTypes={data.entity_types ?? []} onCommand={board.emitMany} theme={theme} request={request}
            onEdit={id => { setSelection({ kind: 'entity', id }); openDialog('entity-edit') }} onMerge={id => { setSelection({ kind: 'entity', id }); openDialog('entity-merge') }}
            onCopy={(value, label) => void copyValue(value, label)}
            entities={data.entities} facts={filteredFacts} groups={data.groups ?? []} perspectives={data.views ?? []} lens={lens} onLensChange={next => setLens(next)}
            activePerspective={activePerspective} onApplyPerspective={applyPerspective}
            onSavePerspective={name => { const id = uuid(); void act(async () => { await board.emit('view.add', { id, name, layers: lens.layers ? [...lens.layers] : null, collapse_activities: lens.collapseActivities, show_lanes: lens.showLanes }); setPerspectiveParam(id) }, 'Perspective saved') }}
            onDeletePerspective={id => { void act(() => board.emit('view.delete', { id }), 'Perspective deleted'); if (id === activePerspective) setPerspectiveParam(null) }}
            boardName={board.boardName} filterSummary={filterSummary} onNotice={setToast} onRequestDone={() => setRequest(null)}
            selection={selection} search={search} onSelect={setSelectionState} />}
          {data && data.entities.length > 0 && <div className="status-filter" role="group" aria-label="Filter relationships by status">
            <button className={stateFilter === 'all' ? 'active' : ''} onClick={() => setStateFilter('all')}>All <b>{timeFacts.length}</b></button>
            {allStates.map(state => <button key={state} className={`${state} ${stateFilter === state ? 'active' : ''}`} onClick={() => setStateFilter(stateFilter === state ? 'all' : state)} title={`Show only ${labels[state].toLowerCase()} relationships`}><span className="legend-line" />{labels[state]} <b>{counts[state]}</b></button>)}
          </div>}
          {data && data.entities.length === 0 && <div className="empty-overlay"><div className="empty-card">
            <div className="empty-graphic"><GitBranch size={26} /></div><h2>Start your investigation</h2>
            <p>Create entities and connect them with evidence-backed relationships — or let an agent fill the board via REST / MCP.</p>
            <div className="empty-actions"><button className="primary-button" onClick={() => canvas('place')}><Plus size={15} /> First entity</button><button className="secondary-button" onClick={() => void act(() => board.emitMany(demoDrafts()), 'Example data loaded')}><Sparkles size={15} /> Load example</button><button className="secondary-button" onClick={() => setShowLogImport(true)}><Upload size={15} /> Import logs</button></div>
            <button className="empty-storage" onClick={() => setShowHelp('data')}><HardDrive size={13} /> Data stays in this browser — learn more</button>
            <div className="empty-keys"><span><Kbd>N</Kbd> new entity</span><span><Kbd>{mod}</Kbd><Kbd>K</Kbd> commands</span><span><Kbd>?</Kbd> shortcuts</span></div>
          </div></div>}
        </div>}
        {activeTab === 'review' && data && <div className="scroll-stage"><EvidenceQueue data={data} onOpen={setReaderId} /></div>}
        {activeTab === 'timeline' && data && <div className="scroll-stage"><TimelinePanel data={data} facts={filteredFacts} selection={selection} onSelect={setSelection} /></div>}
        {activeTab === 'activity' && <div className="scroll-stage"><ActivityPanel actions={board.actions} /></div>}
        {showTime && data && <EvidenceWindow facts={data.facts} from={evidenceFrom} to={evidenceTo} includeUndated={includeUndated} onIncludeUndatedChange={setIncludeUndated} onFromChange={setEvidenceFrom} onToChange={setEvidenceTo} onReset={() => { setEvidenceFrom(''); setEvidenceTo(''); setIncludeUndated(true) }} onClose={() => setShowTime(false)} />}
        {!showTime && timeActive && <button className="time-chip" onClick={() => setShowTime(true)}><Clock size={13} /> Time window active</button>}
      </main>
      {showInspector && selection?.kind === 'group' && data && (() => { const group = data.groups?.find(g => g.id === selection.id); return group ? <GroupInspector data={data} group={group} onCommand={board.emitMany}
        onSelect={setSelection} onFocus={id => { setActiveTab('graph'); canvas('focus', { id }) }} onClose={() => setSelection(null)} /> : null })()}
      {showInspector && selection && selection.kind !== 'group' && data && <Inspector data={data} selection={selection} onAdd={openDialog} onDelete={deleteItem} onCopy={(value, label) => void copyValue(value, label)} onCommand={board.emitMany}
        onOpenEvidence={id => setReaderId(id)} onRetract={id => void act(() => board.emit('assertion.retract', { id, retracted_at: new Date().toISOString() }), 'Evidence retracted')}
        onClose={() => setSelection(null)} onSelect={setSelection} onFocus={id => { setActiveTab('graph'); canvas('focus', { id }) }} />}
    </div>
    {readerId && data && <EvidenceReader data={data} evidenceId={readerId} actions={board.actions} onCommand={board.emitMany} onClose={() => setReaderId(null)} onCopy={(value, label) => void copyValue(value, label)} />}
    {dialog === 'activity' && data && <ActivityDialog data={data} initialEntity={selection?.kind === 'entity' ? selection.id : undefined} onClose={() => setDialog(null)} onCommand={board.emitMany}
      onCreated={id => { setDialog(null); setToast('Activity saved'); setSelection({ kind: 'fact', id }, true) }} />}
    {dialog && dialog !== 'activity' && data && <Dialog key={`${dialog}:${editingAssertionId ?? ''}:${relationTargetId ?? ''}`} kind={dialog} data={data} selection={selection} editingAssertionId={editingAssertionId} relationTargetId={relationTargetId} busy={busy} error={error} onClose={() => { setDialog(null); setEditingAssertionId(null); setRelationTargetId(null) }} onSubmit={submit} />}
    {showLogImport && <LogImportDialog boardId={boardId} sessionToken={board.sessionToken} onClose={() => setShowLogImport(false)} onDone={summary => { setShowLogImport(false); setToast(summary) }} />}
    {showPalette && <CommandPalette items={paletteItems} onClose={() => setShowPalette(false)} />}
    {showConnect && <AgentConnectDialog boardId={boardId} token={board.sessionToken} onCopy={(value, label) => void copyValue(value, label)} onClose={() => setShowConnect(false)} />}
    {askName && board.ready && !showHelp && <WelcomeDialog current={board.name} onSave={name => { board.setName(name); setAskName(false) }} onLearnMore={() => setShowHelp('data')} />}
    {showHelp && <HelpDialog key={showHelp} initialTab={showHelp} boardCount={board.boards.length} onExport={download} onClose={() => setShowHelp(false)} />}
    <input ref={importInput} type="file" accept="application/json,.json" hidden onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; void importFile(file) }} />
    <div className="toasts" aria-live="polite">
      {board.storageError && <div className="toast error">{board.storageError}</div>}
      {error && !dialog && <div className="toast error" onClick={() => setError('')}>{error} <X size={14} /></div>}
      {toast && <div className="toast success"><CheckCircle2 size={14} /> {toast}</div>}
    </div>
  </div>
}
