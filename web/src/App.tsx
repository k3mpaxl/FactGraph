import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, Fragment } from 'react'
import {
  Activity, ArrowDownToLine, ArrowLeft, ArrowRight, ChevronDown, ChevronRight, Clock, Command, Copy, CornerDownLeft,
  FileText, GitBranch, Keyboard, Link2, HardDrive, Info, Server, Users, AlertTriangle, Lock, CircleHelp, ListTree, Merge, Moon, Pause, Pencil, Play, Plus, Plug, Search, ShieldCheck,
  SkipBack, SkipForward, Sparkles, Sun, Trash2, Undo2, Redo2, Upload, X, Crosshair, CheckCircle2, CircleDashed, Boxes, Zap, Layers, Ungroup, ImageDown,
  RotateCcw, ShieldAlert, Braces, Bot, FileCheck2,
} from 'lucide-react'
import { addedText, reviewCounts, reviewKind, reviewText } from './provenance'
import { EntityPicker, entityContext } from './EntityPicker'
import { ownImportBatches } from './importBatches'
import { deleteBoard } from './store'
import { factsInWindow, timelineSteps, timelineEvents, periodLabel, evidencePeriod, fromUtcInput, toUtcInput } from './timeline'
import GraphView, { KindIcon, type CanvasRequest, type Lens, type Selection } from './GraphView'
import { ActivityDialog, GroupInspector, ParticipantList } from './Structures'
import ImportDialog from './ImportDialog'
import { CONNECTION_ERROR, describeTableImport, importFields, inspectImport, uploadImport } from './importApi'
import { loadFormats, markUsed, matchFormat, type Inspection } from './importFormats'
import { LAYERS, layerLabel, layerOf } from './layers'
import { defaultView, loadView, saveView } from './savedView'
import NotificationCenter from './NotificationCenter'
import { explainTruth, GLOSSARY } from './explain'
import { count, createLimiter, describe, loadNotices, noticesFor, saveNotices, type Notice } from './notifications'
import EvidenceReader, { EvidenceQueue } from './EvidenceReader'
import { CompromiseBox, ImpactPanel } from './ImpactPanel'
import { analyzeImpact, compromiseOf, effectOf, type Impact } from './impact'
import { huntingQueries } from './hunting'
import { ROW_FIELDS, rowFields, rowOf } from './rows'
import { Sentence } from './Sentence'
import { demoDrafts, factKey, legacyDrafts, normalizeIdentifier, type ActionDraft, type BoardAction } from './board'
import { useBoard, type ChangeListener } from './useBoard'
import { uuid } from './uuid'
import { entityVisual } from './entityVisual'
import type { Assertion, Entity, Fact, GraphData, Identifier, TruthState } from './types'

type DialogKind = 'entity' | 'entity-edit' | 'entity-merge' | 'fact' | 'source' | 'identifier' | 'assertion' | 'assertion-edit' | 'activity' | null
type WorkspaceTab = 'graph' | 'timeline' | 'activity' | 'review' | 'impact'
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

/** When an activity or relationship was observed: from the times of its evidence ("09-17 08:01 – 09-17 09:01"). */
function factSpan(fact: Fact) {
  let first = '', last = ''
  for (const a of fact.assertions) if (!a.retracted_at && a.valid_from) { if (!first || a.valid_from < first) first = a.valid_from; if (!last || a.valid_from > last) last = a.valid_from }
  const short = (t: string) => t.slice(5, 16).replace('T', ' ')
  return !first ? '' : short(first) === short(last) ? short(first) : `${short(first)} – ${short(last)}`
}

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

function Inspector({ data, selection, onAdd, onDelete, onRetract, onOpenEvidence, onCopy, onClose, onSelect, onFocus, onCommand, impact, onOpenImpact }: {
  data: GraphData; selection: NonNullable<Selection>; onAdd: (kind: DialogKind) => void; onCommand: (drafts: ActionDraft[]) => Promise<unknown>;
  impact: Impact | null; onOpenImpact: () => void;
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
        <button className="icon-button" title={`Copy ${entity.name}`} aria-label="Copy value" onClick={() => onCopy(entity.identifiers.find(i => i.scheme === 'ip')?.raw_value ?? entity.name, entity.kind)}><Copy size={15} /></button>
        <button className="icon-button" title="Copy context for an agent (JSON)" aria-label="Copy context for agent" onClick={() => onCopy(JSON.stringify({ entity, relationships: related }, null, 2), 'Entity context')}><Braces size={15} /></button>{closeButton}</div></div>
      <div className="inspector-scroll">
        <div className="inspector-title"><EntityAvatar entity={entity} data={data} size="lg" /><div><h2>{entity.name}</h2><span className="kind-label">{entity.kind}</span></div></div>
        <CompromiseBox entity={entity} impact={impact} data={data} nameOf={id => nameOf(data, id)} onCommand={onCommand} onOpenImpact={onOpenImpact} onCopy={onCopy} onOpenEvidence={onOpenEvidence} />
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
              const attack = impact?.facts.get(fact.id)
              return <div key={fact.id} className={`relation-row${attack ? attack.before ? ' regular' : ' attack' : ''}`} title={attack ? `${attack.count} of ${fact.assertions.length} evidence items in the attacker window${attack.before ? '; it also happened exactly so before the compromise: likely regular' : ''}` : undefined}>
                <button className="relation-main" onClick={() => onSelect({ kind: 'fact', id: fact.id }, true)} title="Open activity">
                  <span className={`state-dot ${fact.truth_state}`} /><span className="relation-dir"><Zap size={13} /></span><span className="relation-predicate">{fact.predicate}</span><span className="relation-time">{factSpan(fact)}</span></button>
                <span className={`role-badge ${role}`}>{role}</span></div>
            }
            const outgoing = fact.subject_id === entity.id
            const other = outgoing ? fact.object_id : fact.subject_id
            const attack = impact?.facts.get(fact.id)
            return <div key={fact.id} className={`relation-row${attack ? attack.before ? ' regular' : ' attack' : ''}`} title={attack ? `${attack.count} of ${fact.assertions.length} evidence items in the attacker window` : undefined}>
              <button className="relation-main" onClick={() => onSelect({ kind: 'fact', id: fact.id }, true)} title="Open relationship">
                <span className={`state-dot ${fact.truth_state}`} title={labels[fact.truth_state]} />
                <span className="relation-dir" title={outgoing ? 'Outgoing' : 'Incoming'}>{outgoing ? <ArrowRight size={13} /> : <ArrowLeft size={13} />}</span>
                <span className="relation-predicate">{fact.predicate}</span><span className="relation-time">{factSpan(fact)}</span>
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
  return <aside className="inspector wide" aria-label="Inspector">
    <div className="inspector-head"><span className="eyebrow">{isActivity ? 'Activity' : 'Relationship'}</span><div className="head-actions">
      <button className="icon-button" title="Copy relationship ID" aria-label="Copy relationship ID" onClick={() => onCopy(fact.id, 'Relationship ID')}><Copy size={15} /></button>{closeButton}</div></div>
    <div className="inspector-scroll">
      {isActivity ? <>
        <div className="inspector-title"><span className={`entity-avatar lg activity-avatar ${fact.truth_state}`}><Zap size={18} /></span><div><h2>{fact.predicate}</h2>
          <span className="kind-label">{fact.participants!.length} participants{fact.technique ? ` · ${fact.technique}` : ''}</span></div></div>
        <p className="activity-sentence"><Sentence fact={fact} data={data} marked={id => { const m = impact?.marks.get(id); return m === 'compromised' || m === 'derived' }} /></p>
        <div className="inspector-actions">
          <button className="secondary-button small" onClick={() => { const value = window.prompt('Operation', fact.predicate); if (value?.trim()) void onCommand([{ type: 'fact.update', payload: { id: fact.id, predicate: value.trim() } }]).catch(() => {}) }}><Pencil size={14} /> Operation</button>
          <button className="secondary-button small" onClick={() => { const value = window.prompt('ATT&CK technique (empty to clear)', fact.technique ?? ''); if (value !== null) void onCommand([{ type: 'fact.update', payload: { id: fact.id, technique: value.trim() || null } }]).catch(() => {}) }}>Technique</button>
          <button className="secondary-button small icon-only" title="Center in graph" aria-label="Center in graph" onClick={() => onFocus(fact.id)}><Crosshair size={14} /></button>
        </div>
        <ActivityDiagram data={data} fact={fact} onSelect={onSelect} impact={impact} />
        <Section title="Participants" count={fact.participants!.length} defaultOpen={false}><ParticipantList data={data} fact={fact} onCommand={onCommand} onSelect={onSelect} /></Section>
      </> : <div className="fact-path">
        <button onClick={() => onSelect({ kind: 'entity', id: fact.subject_id }, true)}>{nameOf(data, fact.subject_id)}</button>
        <div className={`fact-predicate ${fact.truth_state}`}><span>{fact.predicate}</span><ArrowDownIcon /></div>
        <button onClick={() => onSelect({ kind: 'entity', id: fact.object_id }, true)}>{nameOf(data, fact.object_id)}</button>
      </div>}
      <div className="fact-state"><StatePill state={fact.truth_state} /><span>{active.length} active · {confirmed} confirmed</span>{!isActivity && confirmed > 0 && <span className="lock-note" title="Confirmed evidence refers to these two entities. Retract or unconfirm it before moving an end.">Ends locked</span>}</div>
      {(() => { const why = explainTruth(fact.truth_state, fact.assertions); return <p className="truth-why"><CircleHelp size={13} /><span>{why.sentence}{why.notCounted ? ` ${why.notCounted}` : ''}</span></p> })()}
      <dl className="meta-list">{fact.valid_from ? <><dt>Valid from</dt><dd>{date(fact.valid_from)}</dd></> : factSpan(fact) ? <><dt>Observed</dt><dd>{factSpan(fact)} UTC</dd></> : <><dt>Valid from</dt><dd>No date</dd></>}{fact.valid_to && <><dt>Valid to</dt><dd>{date(fact.valid_to)}</dd></>}</dl>
      <Section title="Evidence" count={fact.assertions.length} action={<button className="text-button" onClick={() => onAdd('assertion')}><Plus size={14} /> Add evidence</button>}>
        {fact.assertions.length ? <EvidenceList fact={fact} data={data} onCopy={onCopy} onOpen={onOpenEvidence} onRetract={onRetract} hits={impact?.facts.get(fact.id)?.hits} />
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
    <div className="identifier-meta">{identifier.namespace && <span>{identifier.namespace} · </span>}{source ? source.title : 'Manual'}{identifier.confidence < 1 ? ` · confidence ${Math.round(identifier.confidence * 100)}%` : ''}
      {(identifier.valid_from || identifier.valid_to) && <> · {date(identifier.valid_from)} – {identifier.valid_to ? date(identifier.valid_to) : 'now'}</>}</div>
  </div>
}

/** The activity as a small picture: who and with what on the left, the operation, what it reached on the right. */
function ActivityDiagram({ data, fact, onSelect, impact }: { data: GraphData; fact: Fact; onSelect: (selection: Selection, focus?: boolean) => void; impact: Impact | null }) {
  const parts = fact.participants ?? []
  const left = parts.filter(p => p.role !== 'target'), right = parts.filter(p => p.role === 'target')
  const label = { compromised: 'compromised', derived: 'compromised (derived)', pivot: 'new with attacker', impacted: 'impacted', good: 'good' } as const
  const node = (p: { entity_id: string; role: string }) => { const mark = impact?.marks.get(p.entity_id); const kind = data.entities.find(e => e.id === p.entity_id)?.kind
    return <button key={`${p.role}${p.entity_id}`} className={`diagram-node ${p.role}${mark ? ` mark-${mark}` : ''}`} onClick={() => onSelect({ kind: 'entity', id: p.entity_id }, true)} title={nameOf(data, p.entity_id)}>
      <small>{p.role}{kind ? ` · ${kind}` : ''}{mark ? <b> · {label[mark]}</b> : null}</small><span>{nameOf(data, p.entity_id)}</span></button> }
  return <div className="activity-diagram">
    <div className="diagram-side">{left.map(node)}</div>
    <div className={`diagram-op ${fact.truth_state}`}><Zap size={13} /><span>{fact.predicate}</span></div>
    <div className="diagram-side">{right.map(node)}</div>
  </div>
}

/**
 * Evidence of an activity: what all rows share is said once (operation, who, on what); a table then shows per row only
 * what differs (time, IP, result, user agent, session …). Hand-written evidence without a row keeps its card.
 */
function EvidenceList({ fact, data, onCopy, onOpen, onRetract, hits }: { fact: Fact; data: GraphData; onCopy: (value: string, label: string) => void; onOpen: (id: string) => void; onRetract: (id: string) => void
  /** Evidence items inside the attacker window; the others happened before or after it. */
  hits?: Set<string> }) {
  const [limit, setLimit] = useState(25)
  const items = [...fact.assertions].sort((a, b) => (b.valid_from ?? '').localeCompare(a.valid_from ?? ''))
  const rows = items.filter(a => rowFields(a).length), cards = items.filter(a => !rowFields(a).length)
  const values = new Map(rows.map(a => [a.id, new Map(rowFields(a))]))
  const labels = ROW_FIELDS.map(([label]) => label).filter(label => rows.some(a => values.get(a.id)!.has(label)))
  const common = labels.filter(label => rows.every(a => values.get(a.id)!.get(label) === values.get(rows[0].id)!.get(label)))
  const varying = labels.filter(label => !common.includes(label)).slice(0, 4)
  const sources = [...new Set(items.map(a => sourceOf(data, a.source_id)?.title.split(' · ')[0] ?? 'Manual entry'))]
  const counts = reviewCounts(items)
  const time = (a: Assertion) => a.valid_from ? a.valid_from.slice(5, 19).replace('T', ' ') : '—'
  // Parsed by the import is a parser decision, not a person's check: say which is which.
  const parts = ([['analyst', 'reviewed by analysts', 'ok-text'], ['import', 'parsed by the import', ''], ['agent', 'confirmed by agents only', 'warn-text'], ['open', 'to review', 'warn-text']] as const)
    .filter(([kind]) => counts[kind])
  return <>
    <p className="evidence-summary"><b>{items.length.toLocaleString('en')}</b> {items.length === 1 ? 'item' : 'items'} from {sources.join(', ')} · {parts.map(([kind, label, tone], i) => <Fragment key={kind}>{i ? ', ' : ''}<b className={tone}>{counts[kind].toLocaleString('en')}</b> {label}</Fragment>)}{hits ? <> · <b className="danger-text">{hits.size}</b> in the attacker window</> : null}</p>
    {rows.length > 0 && <>
      {common.length > 0 && <dl className="row-fields common">{common.map(label => <Fragment key={label}><dt>{label}</dt><dd><button className="copy-value" title={`Copy ${label}`} onClick={() => onCopy(values.get(rows[0].id)!.get(label)!, label)}>{values.get(rows[0].id)!.get(label)}</button></dd></Fragment>)}</dl>}
      <div className="evidence-grid-scroll"><table className="evidence-grid">
        <thead><tr><th>Time (UTC)</th>{varying.map(label => <th key={label}>{label}</th>)}<th aria-label="Review" /></tr></thead>
        <tbody>{rows.slice(0, limit).map(a => <tr key={a.id} className={a.retracted_at ? 'retracted' : hits?.has(a.id) ? 'attack' : ''} onClick={() => onOpen(a.id)} title="Open the evidence and its original row">
          <td className="mono">{time(a)}</td>{varying.map(label => <td key={label} title={values.get(a.id)!.get(label)}>{values.get(a.id)!.get(label) ?? '—'}</td>)}
          <td>{a.retracted_at ? <span className="muted">retracted</span> : <ReviewIcon item={a} />}</td>
        </tr>)}</tbody></table></div>
      {rows.length > limit && <button className="text-button" onClick={() => setLimit(limit + 100)}>Show {Math.min(100, rows.length - limit)} more of {rows.length - limit}</button>}
    </>}
    {cards.map(assertion => <AssertionRow key={assertion.id} assertion={assertion} fact={fact} data={data} onCopy={onCopy} onOpen={() => onOpen(assertion.id)} onRetract={() => onRetract(assertion.id)} />)}
  </>
}

/** Analyst-checked, parsed by the import, confirmed by an agent only, or open; the title says who. */
function ReviewIcon({ item }: { item: Assertion }) {
  const kind = reviewKind(item), title = `${reviewText(item)} · added: ${addedText(item)}`
  return kind === 'analyst' ? <CheckCircle2 size={13} className="ok-text" aria-label={title}><title>{title}</title></CheckCircle2>
    : kind === 'import' ? <FileCheck2 size={13} className="muted" aria-label={title}><title>{title}</title></FileCheck2>
    : kind === 'agent' ? <Bot size={13} className="warn-text" aria-label={title}><title>{title}</title></Bot>
    : <CircleDashed size={13} className="warn-text" aria-label={title}><title>{title}</title></CircleDashed>
}

function AssertionRow({ assertion, fact, data, onCopy, onOpen, onRetract }: { assertion: Assertion; fact: Fact; data: GraphData; onCopy: (value: string, label: string) => void; onOpen: () => void; onRetract: () => void }) {
  const source = sourceOf(data, assertion.source_id)
  const period = evidencePeriod(assertion, fact)
  const fields = rowFields(assertion)
  const status = assertion.retracted_at ? 'retracted' : assertion.review_status ?? 'unconfirmed'
  return <div className={`assertion-card ${assertion.retracted_at ? 'retracted' : ''}`}>
    <div className="assertion-top">
      <span className={`stance ${assertion.stance}`}>{assertion.stance === 'supports' ? 'Supports' : 'Refutes'}</span>
      <span className={`review-badge ${status} ${reviewKind(assertion)}`} title={`Added: ${addedText(assertion)}`}><ReviewIcon item={assertion} />{assertion.retracted_at ? 'retracted' : reviewText(assertion)}</span>
      {assertion.confidence < 1 && <span className="assertion-conf" title="Confidence an analyst or agent assigned to this observation">confidence {Math.round(assertion.confidence * 100)}%</span>}
    </div>
    {fields.length ? <dl className="row-fields">{fields.map(([label, value]) => <Fragment key={label}><dt>{label}</dt><dd><button className="copy-value" title={`Copy ${label}`} onClick={() => onCopy(value, label)}>{value}</button></dd></Fragment>)}</dl>
      : <p className="assertion-text">{assertion.observation || assertion.note || <span className="muted">No observation recorded.</span>}</p>}
    {fields.length > 0 && <details className="row-raw"><summary>Observation and original row</summary><p className="assertion-text">{assertion.observation}</p><pre>{JSON.stringify(rowOf(assertion), null, 2)}</pre></details>}
    <div className="assertion-source"><FileText size={13} /><span>{source ? source.title : 'Manual entry'}</span>{assertion.locator && <code title="Where the row is in its source: the table and the columns that identify it (used for the KQL that finds it)">{assertion.locator}</code>}</div>
    <div className="assertion-footer"><span>{periodLabel(period.from, period.to)}</span>
      <span className="assertion-actions">
        <button onClick={() => onCopy(assertion.id, 'Evidence ID')} title="Copy evidence ID" aria-label="Copy evidence ID"><Copy size={12} /></button>
        {!assertion.retracted_at && <button onClick={onRetract}>Retract</button>}
        <button className="strong" onClick={onOpen}>Open & review</button>
      </span></div>
  </div>
}

const defaultColors = ['#ef4444', '#f97316', '#eab308', '#22c55e', '#14b8a6', '#3b82f6', '#8b5cf6', '#ec4899', '#64748b']

/** Color choice with quick swatches: fixed defaults plus colors already used on this board, so related infrastructure can share one color. */
function ColorField({ data, initial }: { data: GraphData; initial: string }) {
  const [color, setColor] = useState(initial.toLowerCase())
  const counts = new Map<string, number>()
  for (const entity of data.entities) if (entity.color) { const c = entity.color.toLowerCase(); counts.set(c, (counts.get(c) ?? 0) + 1) }
  const used = [...counts].filter(([c]) => !defaultColors.includes(c)).sort((a, b) => b[1] - a[1]).slice(0, 9).map(([c]) => c)
  const swatch = (c: string, title: string) => <button key={c} type="button" className={`color-swatch${c === color ? ' active' : ''}`} style={{ '--swatch': c } as CSSProperties} title={title} aria-label={`Color ${c}`} aria-pressed={c === color} onClick={() => setColor(c)} />
  return <div className="color-field"><span className="field-label">Node color</span>
    <input type="hidden" name="color" value={color} />
    <div className="color-swatches">
      {defaultColors.map(c => swatch(c, c))}
      <label className={`color-custom${defaultColors.includes(color) || used.includes(color) ? '' : ' active'}`} title={`Custom color · ${color}`} style={defaultColors.includes(color) || used.includes(color) ? undefined : { background: color }}><input type="color" aria-label="Custom color" value={/^#[0-9a-f]{6}$/.test(color) ? color : '#000000'} onChange={e => setColor(e.target.value.toLowerCase())} /></label>
    </div>
    {used.length > 0 && <><span className="color-used-label">In use on this board</span><div className="color-swatches">{used.map(c => swatch(c, `${c} · ${counts.get(c)} ${counts.get(c) === 1 ? 'entity' : 'entities'}`))}</div></>}
  </div>
}

/** What a merge does before it is saved: which entity stays, what moves over, what is dropped, what needs review again. */
function MergePreview({ data, sourceId, targetId }: { data: GraphData; sourceId: string; targetId: string }) {
  const source = data.entities.find(e => e.id === sourceId), target = data.entities.find(e => e.id === targetId)
  if (!source || !target) return null
  const touches = (f: Fact, id: string) => f.subject_id === id || f.object_id === id || !!f.participants?.some(p => p.entity_id === id)
  const moved = data.facts.filter(f => touches(f, sourceId))
  const evidence = moved.reduce((n, f) => n + f.assertions.filter(a => !a.retracted_at).length, 0)
  const confirmed = moved.reduce((n, f) => n + f.assertions.filter(a => !a.retracted_at && a.review_status === 'confirmed').length, 0)
  const shared = moved.filter(f => touches(f, targetId)).length
  const groups = (data.groups ?? []).filter(g => g.member_ids.includes(sourceId)).length
  const sc = compromiseOf(source), tc = compromiseOf(target)
  const conflicts: string[] = []
  if (source.kind !== target.kind) conflicts.push(`Type: keeps “${target.kind}”, drops “${source.kind}”.`)
  if (source.description && source.description !== target.description) conflicts.push(`Description of ${source.name} is dropped${target.description ? '' : ' (the kept entity has none)'}.`)
  if (sc && JSON.stringify(sc) !== JSON.stringify(tc)) conflicts.push(`Marking of ${source.name} (${sc.cleared ? 'good' : sc.level === 'suspected' ? 'suspected' : 'compromised'}) is dropped${tc ? `; ${target.name} keeps its own` : `: mark ${target.name} afterwards if it applies`}.`)
  if ((source.color ?? '') !== (target.color ?? '') && source.color) conflicts.push('Colour: the kept entity’s colour stays.')
  const card = (e: Entity, role: string) => <div className={`merge-card ${role}`}><span className="eyebrow">{role === 'keep' ? 'Stays' : 'Disappears'}</span><strong>{e.name}</strong><span className="kind-label">{e.kind}</span>
    <small>{entityContext(e, data) || 'no identifiers'}</small><small className="mono">{e.id}</small></div>
  return <div className="merge-preview">
    <div className="merge-cards">{card(source, 'drop')}<ArrowRight size={16} />{card(target, 'keep')}</div>
    <ul className="merge-effects">
      <li><b>{source.identifiers.length}</b> identifier{source.identifiers.length === 1 ? '' : 's'} and <b>{moved.length}</b> relationship{moved.length === 1 ? '' : 's'}/activit{moved.length === 1 ? 'y' : 'ies'} move to {target.name}{shared ? <> ({shared} between the two become relationships of {target.name} with itself)</> : null}{groups ? <>; it takes its place in {groups} group{groups === 1 ? '' : 's'}</> : null}.</li>
      {evidence > 0 && <li><b className={confirmed ? 'warn-text' : ''}>{evidence.toLocaleString('en')}</b> evidence item{evidence === 1 ? '' : 's'} on them {confirmed ? <>need a review again (<b>{confirmed.toLocaleString('en')}</b> confirmed now)</> : 'stay unconfirmed'}: the statements now name a different entity.</li>}
      {conflicts.map(c => <li key={c} className="warn-text">{c}</li>)}
      <li className="muted">Undo reverses the merge with all of this.</li>
    </ul>
    {source.kind !== target.kind && <div className="form-warning">Different types: make sure these are really the same thing.</div>}
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
  const [subjectId, setSubjectId] = useState(selection?.kind === 'entity' ? selection.id : '')
  const [objectId, setObjectId] = useState(relationTargetId ?? '')
  const [mergeTarget, setMergeTarget] = useState('')
  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const get = (field: string) => String(form.get(field) ?? '').trim()
    const asDate = (field: string) => fromUtcInput(get(field))
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
  const localDate = (value: string | null | undefined) => toUtcInput(value)
  const sourceSelect = <label>Source <span className="optional">optional</span><select name="source_id" defaultValue={editingAssertion?.source_id ?? ''}><option value="">Manual entry</option>{data.sources.map(source => <option key={source.id} value={source.id}>{source.title}</option>)}</select></label>
  const confidenceField = <label>Confidence <span className="optional">0–100 %</span><input name="confidence" type="number" min="0" max="100" defaultValue={editingAssertion ? Math.round(editingAssertion.confidence * 100) : 100} /></label>
  const dateFields = <div className="field-grid"><label>Evidence from <span className="optional">UTC, optional</span><input name="valid_from" type="datetime-local" defaultValue={localDate(editingAssertion?.valid_from)} /></label><label>Evidence to <span className="optional">UTC, optional</span><input name="valid_to" type="datetime-local" defaultValue={localDate(editingAssertion?.valid_to)} /></label></div>
  return <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}>
    <div className="modal" role="dialog" aria-modal="true" aria-label={titles[kind]}>
      <div className="modal-header"><h2>{titles[kind]}</h2><button className="icon-button" onClick={onClose} aria-label="Close dialog"><X size={18} /></button></div>
      <form onSubmit={submit}>
        <div className="modal-body">
          {(kind === 'entity' || kind === 'entity-edit') && <><label>Name<input name="name" defaultValue={editing?.name} autoFocus required placeholder="e.g. Web server 01" /></label><div className="field-grid"><label>Type<select aria-label="Type" name="kind" defaultValue={editing ? (kinds.includes(editing.kind) ? editing.kind : customKindValue) : kinds[0]} onChange={event => setCustomEntityKind(event.target.value === customKindValue)}>{kinds.map(value => <option key={value}>{value}</option>)}<option value={customKindValue}>Custom type…</option></select>{customEntityKind && <input name="custom_kind" defaultValue={editing?.kind} required autoFocus placeholder="e.g. SaaS application" />}</label></div><ColorField data={data} initial={editing?.color || entityVisual(editing?.kind || kinds[0]).border} /><label>Description <span className="optional">optional</span><textarea name="description" defaultValue={editing?.description} rows={3} placeholder="What is known about this entity?" /></label></>}
          {kind === 'entity-merge' && selection?.kind === 'entity' && <><div className="modal-context">Merge <strong>{nameOf(data, selection.id)}</strong> into another entity. Its identifiers, relationships and evidence are retained.</div><div className="field-stack"><span className="field-label">Keep entity (the target)</span><EntityPicker data={data} label="Keep entity" name="target_id" value={mergeTarget} onChange={setMergeTarget} exclude={[selection.id]} preferKind={data.entities.find(e => e.id === selection.id)?.kind} autoFocus required /></div>
            {mergeTarget ? <MergePreview data={data} sourceId={selection.id} targetId={mergeTarget} /> : <div className="form-warning">The entity you merge disappears; the one you keep takes over its identifiers and relationships. Undo reverses it.</div>}</>}
          {kind === 'source' && <><label>Title<input name="title" autoFocus required placeholder="e.g. EDR export from Sep 27" /></label><label>URL or reference <span className="optional">optional</span><input name="uri" placeholder="https://… or file path" /></label><label>Source classification<select name="source_kind"><option value="unknown">Unclassified</option><option value="primary">Primary evidence</option><option value="secondary">Secondary context</option></select></label><label>KQL query <span className="optional">optional</span><textarea name="query" rows={2} className="mono" /></label><label>Original excerpt / results <span className="optional">optional</span><textarea name="excerpt" rows={4} className="mono" placeholder="Relevant passage from the source" /></label></>}
          {kind === 'identifier' && <><div className="modal-context">Entity: <strong>{selection?.kind === 'entity' ? nameOf(data, selection.id) : ''}</strong></div><div className="field-grid"><label>Scheme<select name="scheme">{schemes.map(value => <option key={value}>{value}</option>)}</select></label><label>Namespace <span className="optional">optional</span><input name="namespace" placeholder="e.g. prod" /></label></div><label>Value<input name="raw_value" autoFocus required placeholder="External identifier" /></label>{dateFields}{sourceSelect}{confidenceField}</>}
          {kind === 'fact' && <><div className="field-grid"><div className="field-stack"><span className="field-label">From</span><EntityPicker data={data} label="From" name="subject_id" value={subjectId} onChange={setSubjectId} required /></div><div className="field-stack"><span className="field-label">To</span><div className="segmented" role="group" aria-label="Target"><button type="button" className={newTarget ? 'active' : ''} aria-pressed={newTarget} onClick={() => setNewTarget(true)}>New node</button><button type="button" className={!newTarget ? 'active' : ''} aria-pressed={!newTarget} onClick={() => setNewTarget(false)}>Existing node</button></div></div></div>{newTarget ? <div className="field-grid"><label>New node name<input name="new_object_name" required placeholder="e.g. Azure secret" /></label><label>Type<select name="new_object_kind" defaultValue={kinds[0]} onChange={event => setCustomTargetKind(event.target.value === customKindValue)}>{kinds.map(value => <option key={value}>{value}</option>)}<option value={customKindValue}>Custom type…</option></select>{customTargetKind && <input name="custom_new_object_kind" required autoFocus placeholder="e.g. SaaS application" />}</label></div> : <div className="field-stack"><span className="field-label">Target node</span><EntityPicker data={data} label="Target node" name="object_id" value={objectId} onChange={setObjectId} exclude={subjectId ? [subjectId] : undefined} required /></div>}<label>Relationship / predicate<input name="predicate" autoFocus required placeholder="e.g. reads, grants access to, accessed" /></label>{dateFields}<div className="form-divider">First evidence statement</div><StanceSelect value={stance} onChange={setStance} /><div className="field-grid">{sourceSelect}{confidenceField}</div><label>Note <span className="optional">optional</span><textarea name="note" rows={2} placeholder="What supports this statement?" /></label></>}
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

function TimelinePanel({ data, facts, selection, onSelect, impact }: {
  data: GraphData; facts: GraphData['facts']; selection: Selection; onSelect: (selection: Selection) => void; impact: Impact | null;
}) {
  const [showFailed, setShowFailed] = useState(() => readPref('showFailed') === 'true')
  const [attackOnly, setAttackOnly] = useState(false)
  const [limit, setLimit] = useState(300)
  // The same activity on one day is one row (time span and count): the time bar narrows it down further.
  const rows = useMemo(() => {
    // Attacker activity is decided per evidence item: the same activity before the compromise window is not the attacker's.
    const merged = new Map<string, { fact: Fact; day: string; first: string | null; last: string | null; count: number; refutes: boolean; attack: boolean }>()
    for (const entry of timelineEvents(facts)) {
      if (!showFailed && effectOf(entry.fact.predicate) === 'attempt') continue
      const hits = impact?.facts.get(entry.fact.id)?.hits
      const attack = !!hits && entry.assertions.some(a => hits.has(a.id))
      if (attackOnly && !attack) continue
      const day = entry.from ? entry.from.slice(0, 10) : 'undated'
      const key = `${day}|${entry.fact.id}|${attack ? 'a' : ''}`
      const row = merged.get(key) ?? { fact: entry.fact, day, first: entry.from, last: entry.to ?? entry.from, count: 0, refutes: false, attack }
      row.count += entry.assertions.length
      if (entry.from && (!row.first || entry.from < row.first)) row.first = entry.from
      const end = entry.to ?? entry.from
      if (end && (!row.last || end > row.last)) row.last = end
      if (entry.assertions.some(a => a.stance === 'refutes')) row.refutes = true
      merged.set(key, row)
    }
    return [...merged.values()].sort((a, b) => (a.first ?? '9').localeCompare(b.first ?? '9'))
  }, [facts, showFailed, attackOnly, impact])
  const marked = (id: string) => { const m = impact?.marks.get(id); return m === 'compromised' || m === 'derived' }
  const groups: { day: string; items: typeof rows }[] = []
  for (const row of rows.slice(0, limit)) {
    const day = row.day === 'undated' ? 'Undated' : new Date(row.day).toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' })
    const last = groups[groups.length - 1]
    if (last?.day === day) last.items.push(row); else groups.push({ day, items: [row] })
  }
  const time = (t: string | null) => t ? t.slice(11, 16) : '—'
  const events = rows.reduce((n, r) => n + r.count, 0)
  return <section className="view-page">
    <header className="view-header"><div><h2>Timeline</h2><p>One row = one activity (same operation, same participants) on one day, with its first–last time in UTC. <b>N×</b> = its evidence items, one per original log row; open a row to see each of them.</p></div>
      <div className="head-actions">
        {impact?.seeds.length ? <div className="segmented" role="group" aria-label="Timeline filter"><button className={!attackOnly ? 'active' : ''} onClick={() => setAttackOnly(false)}>All</button><button className={attackOnly ? 'active' : ''} onClick={() => setAttackOnly(true)}>Attacker activity</button></div> : null}
        <label className="check"><input type="checkbox" checked={showFailed} onChange={e => { setShowFailed(e.target.checked); writePref('showFailed', String(e.target.checked)) }} /> Failed attempts</label>
        <span className="count-chip" title="Rows: activities per day. Evidence items: the original log rows behind them.">{rows.length.toLocaleString('en')} rows · {events.toLocaleString('en')} evidence items</span></div></header>
    {rows.length ? groups.map(group => <div key={group.day} className="timeline-group"><div className="timeline-day">{group.day}</div>
      {group.items.map(row => { const attack = row.attack ? impact?.facts.get(row.fact.id) : undefined
        return <button key={`${row.day}|${row.fact.id}|${row.attack}`} title={`${row.fact.predicate} · ${row.count} evidence item${row.count === 1 ? '' : 's'} · ${row.first ?? 'no time'}${row.last && row.last !== row.first ? ` – ${row.last}` : ''} UTC${row.attack ? ' · inside the attacker window' : ''}`} className={`timeline-item${selection?.id === row.fact.id ? ' active' : ''}${attack ? attack.before ? ' regular' : ' attack' : ''}`} onClick={() => onSelect({ kind: 'fact', id: row.fact.id })}>
        <span className="timeline-time">{time(row.first)}{row.last && time(row.last) !== time(row.first) ? <small>–{time(row.last)}</small> : null}</span>
        <span className={`timeline-dot ${row.fact.truth_state}`} />
        <span className="timeline-body"><span className="timeline-line"><Zap size={12} /> <Sentence fact={row.fact} data={data} marked={marked} /></span>
          <small>{row.count > 1 ? <b>{row.count}× </b> : null}{row.count > 1 ? '· ' : ''}{attack ? attack.before ? 'attacker window, but likely regular · ' : 'attacker activity · ' : ''}{row.refutes ? 'refuting evidence · ' : ''}{row.fact.truth_state}</small></span>
      </button> })}</div>) : <div className="view-empty"><Clock size={22} /><p>No active evidence in this view.</p></div>}
    {rows.length > limit && <footer className="pager"><button className="secondary-button small" onClick={() => setLimit(limit + 500)}>Show {Math.min(500, rows.length - limit)} more of {rows.length - limit} rows</button></footer>}
  </section>
}

type StepSize = 'auto' | 'day' | 'hour' | 'minute' | 'event'
const STEP_MS: Record<Exclude<StepSize, 'auto' | 'event'>, number> = { minute: 60_000, hour: 3_600_000, day: 86_400_000 }
/**
 * Steps for the time bar, each with its first and last time and how many evidence times fall in it. Auto picks minute,
 * hour, day or week so there are about 150 steps; "event" is every distinct time.
 */
function coarseSteps(steps: string[], size: StepSize = 'auto', all: number[] = []): { starts: string[]; ends: string[]; counts: number[] } {
  const bucketed = (ms: number) => {
    const buckets = new Map<number, [string, string]>()
    for (const step of steps) {
      const key = Math.floor(Date.parse(step) / ms), current = buckets.get(key)
      if (!current) buckets.set(key, [step, step]); else { if (step < current[0]) current[0] = step; if (step > current[1]) current[1] = step }
    }
    return [...buckets.entries()].sort((a, b) => a[0] - b[0])
  }
  const sizes = size === 'auto' ? [60_000, 3_600_000, 86_400_000, 7 * 86_400_000] : size === 'event' ? [] : [STEP_MS[size]]
  let chosen: [number, [string, string]][] | null = null, ms = 0
  for (const candidate of sizes) { ms = candidate; chosen = bucketed(candidate); if (chosen.length <= 150) break }
  if (!chosen) { const keys = steps.map(s => Date.parse(s)); chosen = steps.map((s, i) => [keys[i], [s, s]]); ms = 0 }
  const counts = new Array(chosen.length).fill(0)
  if (all.length) {
    const index = new Map(chosen.map(([key], i) => [key, i]))
    for (const t of all) { const i = index.get(ms ? Math.floor(t / ms) : t); if (i !== undefined) counts[i]++ }
  }
  return { starts: chosen.map(([, b]) => b[0]), ends: chosen.map(([, b]) => b[1]), counts }
}

function EvidenceWindow({ facts, from, to, includeUndated, onIncludeUndatedChange, onFromChange, onToChange, onReset, onClose, attack }: {
  facts: GraphData['facts']; from: string; to: string; attack?: { first: string | null; last: string | null } | null;
  includeUndated: boolean; onIncludeUndatedChange: (value: boolean) => void;
  onFromChange: (value: string) => void; onToChange: (value: string) => void; onReset: () => void; onClose: () => void;
}) {
  const [playing, setPlaying] = useState(false)
  const [size, setSize] = useState<StepSize>(() => (readPref('timeStep') as StepSize | null) ?? 'auto')
  const evidenceTimes = useMemo(() => facts.flatMap(f => f.assertions.filter(a => !a.retracted_at && a.valid_from).map(a => Date.parse(a.valid_from!))).filter(t => !Number.isNaN(t)), [facts])
  const buckets = useMemo(() => coarseSteps(timelineSteps(facts), size, evidenceTimes), [facts, size, evidenceTimes])
  const peak = Math.max(1, ...buckets.counts)
  const steps = buckets.ends
  const maxStep = Math.max(steps.length - 1, 0)
  // A step is a bucket (a minute, hour, day…): the left handle stands for its first event, the right one for its last.
  const starts = buckets.starts
  const nearestStep = (value: string, fallback: number, list = steps) => {
    if (!value || !list.length) return fallback
    const target = Date.parse(value)
    return list.reduce((best, step, index) => Math.abs(Date.parse(step) - target) < Math.abs(Date.parse(list[best]) - target) ? index : best, 0)
  }
  const fromStep = Math.min(nearestStep(from, 0, starts), maxStep)
  const toStep = Math.max(nearestStep(to, maxStep), 0)
  const position = (step: number) => maxStep ? (step / maxStep) * 100 : 0
  const moveFrom = (step: number) => onFromChange(starts[Math.min(step, toStep)] ?? '')
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
      <button className="icon-button play" aria-label={playing ? 'Pause evidence playback' : 'Play evidence steps'} disabled={!hasRange} onClick={() => { if (toStep === maxStep) { onFromChange(buckets.starts[0]); onToChange(steps[0]) } setPlaying(!playing) }}>{playing ? <Pause size={14} /> : <Play size={14} />}</button>
      <button className="icon-button" aria-label="Next evidence step" disabled={!hasRange || toStep === maxStep} onClick={() => moveTo(toStep + 1)}><SkipForward size={14} /></button>
    </div>
    <div className="time-main">
      {buckets.counts.length > 1 && buckets.counts.length <= 600 && <div className="time-density" aria-hidden="true" title="Evidence items per step">{buckets.counts.map((n, i) => <i key={i} style={{ height: `${Math.max(8, (n / peak) * 100)}%` }} />)}</div>}
      <div className="window-range" aria-label="Evidence time range"><div className="window-track" />
        {attack?.first && hasRange && <div className="window-attack" title={`Attacker activity ${attack.first.slice(0, 16).replace('T', ' ')} – ${(attack.last ?? attack.first).slice(0, 16).replace('T', ' ')} UTC`} style={{ left: `${position(nearestStep(attack.first, 0, starts))}%`, right: `${100 - position(nearestStep(attack.last ?? attack.first, maxStep))}%` }} />}
        <div className="window-selection" style={{ left: `${position(fromStep)}%`, right: `${100 - position(toStep)}%` }} />
        <input aria-label="Evidence from" aria-valuetext={starts[fromStep] ? periodLabel(starts[fromStep], null) : 'No dated evidence'} className="range-input" type="range" min="0" max={maxStep} step="1" value={fromStep} disabled={!hasRange} onChange={event => moveFrom(Number(event.target.value))} />
        <input aria-label="Evidence to" aria-valuetext={steps[toStep] ? periodLabel(steps[toStep], null) : 'No dated evidence'} className="range-input" type="range" min="0" max={maxStep} step="1" value={toStep} disabled={!hasRange} onChange={event => moveTo(Number(event.target.value))} /></div>
      <div className="window-labels"><span>{starts.length ? periodLabel(starts[fromStep], null) : 'No dated evidence'}</span><em>{steps.length ? `step ${fromStep + 1}–${toStep + 1} of ${steps.length}` : ''}</em><span>{steps.length ? periodLabel(steps[toStep], null) : ''}</span></div>
    </div>
    <select className="time-step-size" aria-label="Step size" title="How far one step moves: auto keeps about 150 steps; each event steps through every distinct time" value={size} onChange={e => { const next = e.target.value as StepSize; setSize(next); writePref('timeStep', next) }}>
      <option value="auto">Auto steps</option><option value="day">Per day</option><option value="hour">Per hour</option><option value="minute">Per minute</option><option value="event">Each event</option></select>
    <label className="check"><input type="checkbox" checked={includeUndated} onChange={event => onIncludeUndatedChange(event.target.checked)} /> Undated</label>
    {(from || to) && <button className="text-button" onClick={onReset}>Show all</button>}
    <button className="icon-button" aria-label="Close evidence window" onClick={onClose}><X size={14} /></button>
  </div>
}

type ChangeKind = 'all' | 'entity' | 'relationship' | 'evidence' | 'review' | 'structure'
const changeKind = (type: BoardAction['type']): Exclude<ChangeKind, 'all'> =>
  type === 'assertion.review' ? 'review' : type.startsWith('assertion.') ? 'evidence' : type.startsWith('fact.') ? 'relationship'
    : type.startsWith('entity.') || type.startsWith('identifier.') ? 'entity' : 'structure'
const HIDDEN_FIELDS = new Set(['id', 'expected_revision', 'expected_source_revision', 'created_at'])
const shown = (value: unknown) => value === null || value === undefined || value === '' ? '—' : typeof value === 'object' ? JSON.stringify(value) : String(value)

/** One change, readable: what it touched (with a link) and each changed field, with its earlier value where there was one. */
function ChangeDetail({ action, before, data, onSelect }: { action: BoardAction; before: (field: string) => unknown; data: GraphData; onSelect: (selection: Selection) => void }) {
  const id = typeof action.payload.id === 'string' ? action.payload.id : ''
  const entity = data.entities.find(e => e.id === id || e.id === action.payload.entity_id || e.id === action.payload.target_id)
  const fact = data.facts.find(f => f.id === id || f.id === action.payload.fact_id)
  const fields = Object.entries(action.payload).filter(([k]) => !HIDDEN_FIELDS.has(k))
  const update = action.type.endsWith('.update')
  // Sources, groups, perspectives, types and evidence have no link target here, but they may well still exist.
  const exists = [data.sources, data.groups ?? [], data.views ?? [], data.entity_types ?? [], data.facts.flatMap(f => f.assertions)].some(list => (list as { id: string }[]).some(x => x.id === id))
  return <div className="activity-detail">
    <div className="change-head"><strong>{actionLabel(action)}</strong>
      {entity && <button className="link" onClick={() => onSelect({ kind: 'entity', id: entity.id })}>{entity.name} · {entity.kind}</button>}
      {!entity && fact && <button className="link" onClick={() => onSelect({ kind: 'fact', id: fact.id })}>{fact.predicate}</button>}
      {!entity && !fact && id && !exists && <span className="muted small">no longer on the board</span>}</div>
    {fields.length > 0 && <dl className="change-fields">{fields.map(([field, value]) => { const old = update ? before(field) : undefined
      return <Fragment key={field}><dt>{field.replace(/_/g, ' ')}</dt><dd>{update && old !== undefined && shown(old) !== shown(value) ? <><s>{shown(old)}</s> → </> : null}<span>{shown(value)}</span></dd></Fragment> })}</dl>}
    <details className="raw-payload"><summary>Raw change for agents</summary><small>{action.actor} · {action.id}</small><pre>{JSON.stringify(action.payload, null, 2)}</pre></details>
  </div>
}

/** Who changed the board, through which channel (UI, REST, MCP, import): searchable, with each change readable. */
function ActivityPanel({ actions, data, onSelect }: { actions: BoardAction[]; data: GraphData; onSelect: (selection: Selection) => void }) {
  const [page, setPage] = useState(0)
  const [query, setQuery] = useState('')
  const [channel, setChannel] = useState('all')
  const [author, setAuthor] = useState('all')
  const [kind, setKind] = useState<ChangeKind>('all')
  const names = useMemo(() => new Map(data.entities.map(e => [e.id, e.name])), [data.entities])
  const authors = useMemo(() => [...new Set(actions.map(a => a.author))].sort(), [actions])
  const channels = useMemo(() => [...new Set(actions.map(a => a.channel ?? 'UI'))].sort(), [actions])
  const batches = useMemo(() => {
    const q = query.trim().toLowerCase()
    const keep = (a: BoardAction) => (channel === 'all' || (a.channel ?? 'UI') === channel) && (author === 'all' || a.author === author) && (kind === 'all' || changeKind(a.type) === kind)
      && (!q || `${actionLabel(a)} ${a.author} ${names.get(String(a.payload.id ?? '')) ?? ''} ${names.get(String(a.payload.entity_id ?? '')) ?? ''} ${a.payload.id ?? ''}`.toLowerCase().includes(q))
    const groups = new Map<string, BoardAction[]>()
    for (const action of actions) { if (!keep(action)) continue; const key = action.batch_id ?? action.id; const list = groups.get(key); if (list) list.push(action); else groups.set(key, [action]) }
    return [...groups.entries()].reverse()
  }, [actions, query, channel, author, kind, names])
  // The value a field had before a change: the latest earlier action on the same record that set it.
  const index = useMemo(() => new Map(actions.map((a, i) => [a.id, i])), [actions])
  const beforeOf = (action: BoardAction) => (field: string) => {
    const id = action.payload.id
    for (let i = (index.get(action.id) ?? 0) - 1; i >= 0; i--) { const a = actions[i]; if (a.payload.id === id && field in a.payload) return a.payload[field] }
    return undefined
  }
  const total = batches.reduce((n, [, items]) => n + items.length, 0)
  return <section className="view-page">
    <header className="view-header"><div><h2>Change log</h2><p>Every change to the board: who, through which channel (UI, REST, MCP, import), and what changed. Not the activities in the logs: those are in the timeline.</p></div>
      <div className="pager"><button className="secondary-button small" disabled={page === 0} onClick={() => setPage(page - 1)}>Previous</button><span>{page + 1} / {Math.max(1, Math.ceil(batches.length / 50))}</span><button className="secondary-button small" disabled={(page + 1) * 50 >= batches.length} onClick={() => setPage(page + 1)}>Next</button></div></header>
    <div className="change-filters">
      <label className="input-with-icon"><Search size={14} /><input aria-label="Search the change log" placeholder="Search changes, entities, authors, IDs…" value={query} onChange={e => { setQuery(e.target.value); setPage(0) }} /></label>
      <select aria-label="Channel" value={channel} onChange={e => { setChannel(e.target.value); setPage(0) }}><option value="all">All channels</option>{channels.map(c => <option key={c}>{c}</option>)}</select>
      <select aria-label="Author" value={author} onChange={e => { setAuthor(e.target.value); setPage(0) }}><option value="all">All authors</option>{authors.map(a => <option key={a}>{a}</option>)}</select>
      <select aria-label="Kind of change" value={kind} onChange={e => { setKind(e.target.value as ChangeKind); setPage(0) }}><option value="all">All changes</option><option value="entity">Entities</option><option value="relationship">Relationships, activities</option><option value="evidence">Evidence</option><option value="review">Reviews</option><option value="structure">Groups, types, views</option></select>
      <span className="count-chip">{total.toLocaleString('en')} of {actions.length.toLocaleString('en')} changes · {batches.length.toLocaleString('en')} groups</span>
    </div>
    <div className="activity-list">{batches.slice(page * 50, (page + 1) * 50).map(([id, items]) => <details key={id} className="activity-item"><summary>
      <span className={`channel-badge ${(items[0].channel ?? 'UI').toLowerCase()}`}>{items[0].channel ?? 'UI'}</span>
      <strong>{items.length === 1 ? actionLabel(items[0]) : `${items.length.toLocaleString('en')} changes · ${actionLabel(items[0])}`}</strong>
      <span className="activity-meta">{items[0].author} · {new Date(items[0].at).toLocaleString('en-GB', { timeZone: 'UTC' })} UTC</span></summary>
      {items.slice(0, 50).map(action => <ChangeDetail key={action.id} action={action} before={beforeOf(action)} data={data} onSelect={onSelect} />)}
      {items.length > 50 && <p className="muted small">… and {(items.length - 50).toLocaleString('en')} more changes in this group.</p>}</details>)}
      {!batches.length && <div className="view-empty"><Activity size={22} /><p>{actions.length ? 'No change matches the filters.' : 'No changes yet.'}</p></div>}</div>
  </section>
}

function Explorer({ data, search, selection, onSelect, onClose }: { data: GraphData; search: string; selection: Selection; onSelect: (selection: Selection, focus?: boolean) => void; onClose: () => void }) {
  const groupOf = useMemo(() => new Map((data.groups ?? []).flatMap(g => g.member_ids.map(id => [id, g.name] as const))), [data.groups])
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const needle = search.trim().toLowerCase()
  const degree = useMemo(() => {
    const map = new Map<string, number>()
    // Relationships and activities alike: an IP that only takes part in activities has relationships too.
    for (const f of data.facts) for (const id of new Set(f.participants?.length ? f.participants.map(p => p.entity_id) : [f.subject_id, f.object_id])) map.set(id, (map.get(id) ?? 0) + 1)
    return map
  }, [data.facts])
  // Exact or prefix hits on the name or an identifier come first, above the groups and the list by type.
  const best = useMemo(() => !needle ? [] : data.entities.filter(e => e.name.toLowerCase() === needle || e.name.toLowerCase().startsWith(needle) || e.identifiers.some(i => i.raw_value.toLowerCase() === needle || i.normalized_value === needle)).slice(0, 8), [data.entities, needle])
  const shownGroups = useMemo(() => (data.groups ?? []).filter(g => !needle || g.name.toLowerCase().includes(needle) || (best.length > 0 && best.some(e => g.member_ids.includes(e.id)))), [data.groups, needle, best])
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
      {best.length > 0 && <div className="explorer-group"><div className="explorer-section-label">Best matches</div>
        {best.map(entity => <button key={entity.id} className={`explorer-item ${selection?.id === entity.id ? 'active' : ''}`} onClick={() => onSelect({ kind: 'entity', id: entity.id }, true)} title={`${entity.name} · ${entity.kind}`}>
          <span className="explorer-name">{entity.name}</span><span className="explorer-hint">{entity.kind}</span><span className="explorer-degree" title="Relationships and activities">{degree.get(entity.id) ?? 0}</span></button>)}</div>}
      {shownGroups.length > 0 && <div className="explorer-group">
        <div className="explorer-section-label">Groups</div>
        {shownGroups.map(group => <button key={group.id} className={`explorer-item group-item ${selection?.kind === 'group' && selection.id === group.id ? 'active' : ''}`} onClick={() => onSelect({ kind: 'group', id: group.id }, true)} title={group.name}>
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
            <span className="explorer-name">{entity.name}</span>{groupOf.has(entity.id) ? <span className="explorer-hint" title={`In group ${groupOf.get(entity.id)}`}><Boxes size={10} /></span> : entity.identifiers[0] && <span className="explorer-hint">{entity.identifiers[0].raw_value}</span>}<span className="explorer-degree" title="Relationships and activities">{degree.get(entity.id) ?? 0}</span></button>)}
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
function HelpDialog({ boardCount, onExport, onClose, initialTab = 'data' }: { boardCount: number; onExport: () => void; onClose: () => void; initialTab?: 'data' | 'keys' | 'glossary' }) {
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
    ['Group selected entities', ['G']], ['Switch view: graph, timeline, review, change log, impact', ['1', '–', '5']], ['Toggle explorer', ['E']], ['Toggle evidence window', ['T']], ['Undo / redo', [mod, 'Z', '·', '⇧', mod, 'Z']],
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
        <button role="tab" aria-selected={tab === 'keys'} className={tab === 'keys' ? 'active' : ''} onClick={() => setTab('keys')}>Keyboard & mouse</button>
        <button role="tab" aria-selected={tab === 'glossary'} className={tab === 'glossary' ? 'active' : ''} onClick={() => setTab('glossary')}>Glossary</button></div></div>
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
        </> : tab === 'glossary' ? <>
          <p className="hint">How FactGraph decides what is known. The status of a relationship comes only from confirmed, unretracted evidence.</p>
          <dl className="glossary-list">{GLOSSARY.map(entry => <div key={entry.term}><dt>{['Supported', 'Disputed', 'Refuted', 'Unknown'].includes(entry.term) ? <StatePill state={entry.term.toLowerCase() as TruthState} /> : entry.term}</dt><dd>{entry.text}</dd></div>)}</dl>
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
function AgentConnectDialog({ boardId, token, name, onCopy, onClose }: { boardId: string; token: string; name: string; onCopy: (value: string, label: string) => void; onClose: () => void }) {
  const [client, setClient] = useState<AgentClient>('vscode')
  const [embed, setEmbed] = useState(false)
  const origin = window.location.origin
  const mcpUrl = `${origin}/mcp/`
  const vscode = JSON.stringify(embed
    ? { servers: { factgraph: { type: 'http', url: mcpUrl, headers: { 'X-FactGraph-Token': token } } } }
    : { inputs: [{ type: 'promptString', id: 'factgraph-token', description: 'FactGraph board token (plug icon → Copy board token)', password: true }],
        servers: { factgraph: { type: 'http', url: mcpUrl, headers: { 'X-FactGraph-Token': '${input:factgraph-token}' } } } }, null, 2)
  const claude = `claude mcp add --transport http factgraph ${mcpUrl} --header "X-FactGraph-Token: ${token}"`
  // Single quotes keep the variable unexpanded: .mcp.json stores the placeholder and Claude Code reads the token at start.
  const claudeShared = `claude mcp add --scope project --transport http factgraph ${mcpUrl} --header 'X-FactGraph-Token: \${FACTGRAPH_TOKEN}'`
  // The token in the MCP configuration names the board: the prompt needs no board ID.
  const prompt = `Use the FactGraph MCP server for this investigation; it is connected to my board through my board token. Before adding anything, look up what exists with find_entities (q = a name or identifier, paginate with offset/limit) and get_impact; read the whole board with get_graph only when it is small.`
  // A targeted, paginated read: large boards are thousands of records, a full graph read is megabytes.
  const curl = `curl -s "${origin}/api/boards/${boardId}/entities?q=203.0.113.7&limit=50" -H "X-FactGraph-Token: ${token}"`
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
        <p className="hint">Your <b>board token</b> connects an agent to this board as you: it is valid while this tab has the board open, a colleague has their own, and the agent needs no board ID. Its changes appear as yours, for example “MCP ({name})”.</p>
        {client === 'vscode' && <>
          <Snippet label=".vscode/mcp.json" value={vscode} hint={embed ? 'Contains this session’s token — do not commit it.' : 'VS Code asks for the token when the server starts, so the file can be committed.'} />
          <label className="check"><input type="checkbox" checked={embed} onChange={e => setEmbed(e.target.checked)} /> Put the token into the file instead of asking</label>
          <Snippet label="Token" value={token} hint="Paste it when VS Code asks for “FactGraph board token”." />
          <p className="hint">Then run <strong>MCP: List Servers</strong> → factgraph → Start, and pick the FactGraph tools in the agent tool picker.</p>
        </>}
        {client === 'claude' && <>
          <Snippet label="Terminal · only for you" value={claude} hint="Contains this session’s token and stays in your local Claude Code configuration. Do not share it." />
          <Snippet label="Terminal · shared project config (.mcp.json)" value={claudeShared} hint="Stores a placeholder, not the token, so .mcp.json can be committed. Each analyst sets FACTGRAPH_TOKEN before starting Claude Code:" />
          <Snippet label="Token for FACTGRAPH_TOKEN" value={`export FACTGRAPH_TOKEN=${token}`} hint="Run in the terminal that starts Claude Code; do not commit it." />
        </>}
        {client === 'other' && <>
          <Snippet label="MCP endpoint (Streamable HTTP)" value={mcpUrl} />
          <Snippet label="Header" value={`X-FactGraph-Token: ${token}`} hint="The token names this board: MCP tools need no board ID. Clients that cannot send headers pass board_token in every tool call." />
          <Snippet label="REST example: find an entity" value={curl} hint="Lists are paginated (offset, limit up to 1000) and searched with q; the same for /relations, /activities, /sources. Full reference under /docs." />
          <div className="agent-errors"><strong>When a call fails</strong><dl>
            <dt>401 / 403</dt><dd>Token missing or wrong: copy it again (plug icon → Copy board token). A new tab or browser has its own token.</dd>
            <dt>404</dt><dd>Wrong board ID, or the record no longer exists: list again with q.</dd>
            <dt>409 “Board offline”, “No open board for this board token”</dt><dd>No browser has the board open, or not this tab: the data lives in browsers, keep this tab open while agents work.</dd>
            <dt>409 “changed”</dt><dd>Someone changed the record meanwhile: read it again and retry with the new revision.</dd>
            <dt>503</dt><dd>The browser connection dropped during the call: retry; repeated IDs are not stored twice.</dd></dl></div>
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

const initials = (name: string) => name.trim().split(/\s+/).slice(0, 2).map(part => [...part][0] ?? '').join('').toUpperCase() || '?'
const personHue = (id: string) => { let hash = 0; for (const c of id) hash = (hash * 31 + c.charCodeAt(0)) | 0; return Math.abs(hash) % 360 }
function PersonAvatar({ id, name, self }: { id: string; name: string; self?: boolean }) {
  return <span className={`person-avatar${self ? ' self' : ''}`} style={{ '--hue': personHue(id) } as CSSProperties} aria-hidden="true">{initials(name)}</span>
}

/** Who is on this board right now (browsers connected to the relay) and who changed it recently (including agents). */
/** "Syncing… 1,240 changes" while changes come in or go out, "Synced" for a moment after, "Loading" before the board is read. */
function SyncStatus({ sync, connected, ready }: { sync: { incoming: number; outgoing: number; doneAt: number | null; peak: number }; connected: boolean; ready: boolean }) {
  const [, tick] = useState(0)
  useEffect(() => { if (!sync.doneAt) return; const timer = window.setTimeout(() => tick(n => n + 1), 2600); return () => window.clearTimeout(timer) }, [sync.doneAt])
  const pending = sync.incoming + sync.outgoing
  if (!ready) return <span className="sync-status busy" role="status"><RotateCcw size={12} className="spin" /> Loading board…</span>
  // Single edits are not worth a message; imports, reconnects and colleagues' batches are.
  if (pending >= 20) return <span className="sync-status busy" role="status" title={`${sync.incoming.toLocaleString('en')} received, being stored · ${sync.outgoing.toLocaleString('en')} being sent`}>
    <RotateCcw size={12} className="spin" /> Syncing {pending.toLocaleString('en')} change{pending === 1 ? '' : 's'}…</span>
  if (connected && sync.doneAt && sync.peak >= 20 && Date.now() - sync.doneAt < 2500) return <span className="sync-status done" role="status"><CheckCircle2 size={12} /> Synced</span>
  return null
}

function PresenceMenu({ connected, self, peers, actions, onRename }: { connected: boolean; self: { id: string; name: string }; peers: { id: string; name: string }[]; actions: { author: string; at: string }[]; onRename: () => void }) {
  const sorted = [...peers].sort((a, b) => a.name.localeCompare(b.name))
  const online = new Set([self.name, ...peers.map(p => p.name)])
  const recent = new Map<string, string>()
  const since = Date.now() - 30 * 60_000
  for (let i = actions.length - 1; i >= 0 && recent.size < 8; i--) {
    const action = actions[i]
    if (Date.parse(action.at) < since) break
    if (action.author && !online.has(action.author) && !recent.has(action.author)) recent.set(action.author, action.at)
  }
  const ago = (at: string) => { const minutes = Math.max(0, Math.round((Date.now() - Date.parse(at)) / 60_000)); return minutes < 1 ? 'just now' : `${minutes} min ago` }
  const shown = sorted.slice(0, 3)
  const trigger = <>
    <span className="connection-dot" />
    {connected && <span className="avatar-stack">{shown.map(p => <PersonAvatar key={p.id} id={p.id} name={p.name} />)}{sorted.length > shown.length && <span className="person-avatar more">+{sorted.length - shown.length}</span>}</span>}
    <span className="presence-text">{connected ? `${peers.length + 1} online` : 'Offline'}</span>
  </>
  return <Menu label={connected ? `${peers.length + 1} online` : 'Offline'} className={`presence-menu presence ${connected ? 'online' : 'offline'}`} trigger={trigger}>
    <div className="menu-label">{connected ? 'On this board now' : 'Relay offline'}</div>
    {!connected && <p className="menu-note">Changes stay in this browser and sync when the connection returns.</p>}
    <div className="menu-scroll presence-list">
      <button onClick={onRename} title="Change your display name"><PersonAvatar id={self.id} name={self.name} self /><span className="menu-board-name">{self.name}</span><small>you</small></button>
      {connected && sorted.map(p => <div key={p.id} className="presence-row"><PersonAvatar id={p.id} name={p.name} /><span className="menu-board-name">{p.name}</span></div>)}
      {connected && !sorted.length && <p className="menu-note">Nobody else is connected. Share the board link to work together.</p>}
    </div>
    {recent.size > 0 && <><div className="menu-sep" /><div className="menu-label">Recent changes by</div>
      {[...recent].map(([name, at]) => <div key={name} className="presence-row muted"><PersonAvatar id={name} name={name} /><span className="menu-board-name">{name}</span><small>{ago(at)}</small></div>)}</>}
  </Menu>
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
  const changes: ChangeListener = useRef(null)
  const board = useBoard(boardId, changes)
  const data = board.ready ? board.data : null
  // The hint that this board is open in other tabs too: once dismissed, not again in this tab.
  const [tabsHintSeen, setTabsHintSeen] = useState(() => { try { return sessionStorage.getItem(`factgraph:tabsHint:${boardId}`) === '1' } catch { return false } })
  const dismissTabsHint = () => { setTabsHintSeen(true); try { sessionStorage.setItem(`factgraph:tabsHint:${boardId}`, '1') } catch { /* private mode */ } }
  // Filters, layers, time window, selection and zoom are this analyst's own: per board in this browser, never synced.
  const saved = useMemo(() => loadView(boardId), [boardId])
  const [selection, setSelectionState] = useState<Selection>(saved.selection)
  const [dialog, setDialog] = useState<DialogKind>(null)
  const [readerId, setReaderId] = useState<string | null>(null)
  const [editingAssertionId, setEditingAssertionId] = useState<string | null>(null)
  const [relationTargetId, setRelationTargetId] = useState<string | null>(null)
  // Remembered per view: the entity list helps on the graph, it mostly takes room in the timeline, review and impact.
  const [explorerByView, setExplorerByView] = useState<Record<string, boolean>>(() => {
    const legacy = readPref('explorer')
    const graph = legacy === null ? window.innerWidth >= 1280 : legacy === 'true'
    const all: Record<string, boolean> = {}
    for (const tab of ['graph', 'timeline', 'review', 'activity', 'impact']) { const v = readPref(`explorer:${tab}`); all[tab] = v === null ? tab === 'graph' && graph : v === 'true' }
    return all
  })
  // Light is the default; dark is an explicit choice that is remembered.
  const [theme, setTheme] = useState<Theme>(() => readPref('theme') === 'dark' ? 'dark' : 'light')
  const [search, setSearch] = useState('')
  const [stateFilter, setStateFilter] = useState<TruthState | 'all'>(saved.stateFilter)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [toast, setToast] = useState('')
  const [showLogImport, setShowLogImport] = useState(false)
  const [showPalette, setShowPalette] = useState(false)
  const [showHelp, setShowHelp] = useState<false | 'data' | 'keys' | 'glossary'>(false)
  const [showConnect, setShowConnect] = useState(false)
  const [askName, setAskName] = useState(() => { try { return !localStorage.getItem('factgraph:displayName') } catch { return false } })
  const [showTime, setShowTime] = useState(saved.showTime)
  const [request, setRequest] = useState<CanvasRequest | null>(null)
  // Layer visibility and display options; a saved perspective can set them in one step.
  const [lens, setLensState] = useState<Lens>(() => ({ layers: saved.lens.layers ? new Set(saved.lens.layers) : null,
    collapseActivities: saved.lens.collapseActivities, showLanes: saved.lens.showLanes }))
  const [activePerspective, setActivePerspective] = useState<string | null>(() => new URLSearchParams(location.search).get('lens'))
  const setLens = (next: Lens, keepPerspective = false) => {
    setLensState(next)
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
    return tab === 'timeline' || tab === 'review' || tab === 'activity' || tab === 'impact' ? tab : 'graph'
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
    // A shared link opened in a fresh browser: the perspective arrives with the sync, so wait until it is there.
    const view = data.views?.find(v => v.id === activePerspective)
    if (!view) return
    perspectiveApplied.current = true
    setLens({ layers: view.layers ? new Set(view.layers) : null, collapseActivities: view.collapse_activities, showLanes: view.show_lanes }, true)
  }, [data, activePerspective])
  const applyPerspective = (id: string | null) => {
    const view = id ? data?.views?.find(v => v.id === id) : null
    if (!view) { setPerspectiveParam(null); return }
    setLens({ layers: view.layers ? new Set(view.layers) : null, collapseActivities: view.collapse_activities, showLanes: view.show_lanes }, true)
    setPerspectiveParam(view.id)
  }
  const [evidenceFrom, setEvidenceFrom] = useState(saved.from)
  const [evidenceTo, setEvidenceTo] = useState(saved.to)
  const [includeUndated, setIncludeUndated] = useState(saved.includeUndated)
  const viewport = useRef(saved.viewport)
  const persistView = useCallback(() => saveView(boardId, { stateFilter, from: evidenceFrom, to: evidenceTo, includeUndated, showTime, selection, viewport: viewport.current,
    lens: { layers: lens.layers ? [...lens.layers] : null, collapseActivities: lens.collapseActivities, showLanes: lens.showLanes } }),
    [boardId, stateFilter, evidenceFrom, evidenceTo, includeUndated, showTime, selection, lens])
  useEffect(persistView, [persistView])
  // A remembered selection that no longer exists (deleted by a colleague, undone) is dropped once the board is loaded.
  useEffect(() => {
    if (!data || !selection) return
    const exists = selection.kind === 'entity' ? data.entities.some(e => e.id === selection.id) : selection.kind === 'fact' ? data.facts.some(f => f.id === selection.id) : (data.groups ?? []).some(g => g.id === selection.id)
    if (!exists) setSelectionState(null)
  }, [data, selection])
  const resetView = () => {
    const base = defaultView()
    setStateFilter(base.stateFilter); setEvidenceFrom(''); setEvidenceTo(''); setIncludeUndated(true); setShowTime(false)
    setLens({ layers: null, collapseActivities: false, showLanes: false })
    canvas('fit'); setToast('View reset: all filters cleared')
  }
  const importInput = useRef<HTMLInputElement>(null)

  useEffect(() => { if (toast) { const timer = window.setTimeout(() => setToast(''), 3000); return () => clearTimeout(timer) } }, [toast])

  // ---------------------------------------------------------------------------------------------- notifications
  const [notices, setNotices] = useState<Notice[]>(() => loadNotices(boardId))
  useEffect(() => { const timer = window.setTimeout(() => saveNotices(boardId, notices), 400); return () => window.clearTimeout(timer) }, [boardId, notices])
  // A reload right after an import must not lose the last notices still waiting for the debounced save.
  const latestNotices = useRef(notices)
  /** Set once the board was removed from this browser: nothing about it may be written again while the page unloads. */
  const boardRemoved = useRef(false)
  latestNotices.current = notices
  useEffect(() => {
    const flush = () => { if (!boardRemoved.current) saveNotices(boardId, latestNotices.current) }
    window.addEventListener('pagehide', flush)
    return () => window.removeEventListener('pagehide', flush)
  }, [boardId])
  const notify = useCallback((notice: Omit<Notice, 'id' | 'at'> & { id?: string }) => {
    const full: Notice = { id: notice.id ?? uuid(), at: new Date().toISOString(), ...notice }
    setNotices(list => [full, ...list.filter(n => n.id !== full.id)])
    return full.id
  }, [])
  const updateNotice = useCallback((id: string, patch: Partial<Notice>) => setNotices(list => list.map(n => n.id === id ? { ...n, ...patch } : n)), [])
  // Remote batches arrive in chunks of 100; collect them briefly so one batch becomes one notice.
  const pendingBatches = useRef(new Map<string, BoardAction[]>())
  const batchTimer = useRef<number | undefined>(undefined)
  const syncCount = useRef<{ id: string; count: number } | null>(null)
  // Joining a board that others have open: what arrives is its history, not news. One quiet notice once it is in.
  const joined = useRef<{ actions: BoardAction[]; authors: Set<string> } | null>(null)
  useEffect(() => {
    if (board.joining) { joined.current = joined.current ?? { actions: [], authors: new Set() }; return }
    const done = joined.current
    joined.current = null
    if (!done?.actions.length) return
    const counts = count(done.actions)
    notify({ kind: 'colleague', status: 'info', quiet: true, read: true, counts, target: { kind: 'activity' },
      title: `Board received from ${[...done.authors].slice(0, 3).join(', ')}${done.authors.size > 3 ? ` +${done.authors.size - 3}` : ''}`, detail: describe(counts) })
  }, [board.joining])
  changes.current = fresh => {
    if (board.joining && !joined.current) joined.current = { actions: [], authors: new Set() }
    if (joined.current) { for (const item of fresh) { joined.current.actions.push(item); if (item.author) joined.current.authors.add(item.author) } return }
    for (const item of fresh) {
      if (item.actor === board.actor && (item.channel ?? 'UI') === 'UI') continue
      // The analyst's own file imports have their own notice.
      if (item.batch_id && ownImportBatches.has(item.batch_id)) continue
      if (syncCount.current && item.actor !== board.actor) syncCount.current.count++
      const key = item.batch_id ?? item.id
      const list = pendingBatches.current.get(key)
      if (list) list.push(item); else pendingBatches.current.set(key, [item])
    }
    if (!pendingBatches.current.size) return
    window.clearTimeout(batchTimer.current)
    batchTimer.current = window.setTimeout(() => {
      const batches = pendingBatches.current
      pendingBatches.current = new Map()
      setNotices(list => {
        const { updates, created } = noticesFor(batches, board.actor, list)
        const changed = new Map(updates.map(n => [n.id, n]))
        return [...created, ...updates, ...list.filter(n => !changed.has(n.id))]
      })
    }, 800)
  }
  // Connection: only lasting outages (> 5 s) are worth a notice; when back, say how long and what was synced.
  const wasConnected = useRef(false)
  const outage = useRef<{ since: string; id: string | null; timer?: number } | null>(null)
  useEffect(() => {
    if (!board.ready) return
    if (board.connected) {
      const lost = outage.current
      outage.current = null
      if (lost?.timer) window.clearTimeout(lost.timer)
      if (lost?.id) {
        const id = lost.id
        const minutes = Math.round((Date.now() - Date.parse(lost.since)) / 60000)
        updateNotice(id, { status: 'done', title: 'Connection restored', finished: new Date().toISOString(), read: false,
          detail: `Offline for ${minutes < 1 ? 'less than a minute' : `${minutes} min`}. Changes made meanwhile were kept in this browser and sent now.` })
        syncCount.current = { id, count: 0 }
        window.setTimeout(() => {
          const synced = syncCount.current
          syncCount.current = null
          if (synced?.count) setNotices(list => list.map(n => n.id === synced.id ? { ...n, detail: `${n.detail} ${synced.count.toLocaleString('en')} changes from others synced.` } : n))
        }, 6000)
      }
      wasConnected.current = true
    } else if (wasConnected.current && !outage.current) {
      const since = new Date().toISOString()
      outage.current = { since, id: null }
      outage.current.timer = window.setTimeout(() => {
        if (outage.current?.since !== since) return
        outage.current.id = notify({ kind: 'connection', status: 'error', title: 'Connection to the server lost',
          detail: 'Your changes are kept in this browser and sent when the connection is back. Agents cannot reach this board meanwhile.' })
      }, 5000)
    }
  }, [board.ready, board.connected, notify, updateNotice])
  useEffect(() => {
    if (board.unsynced.length) notify({ id: `unsynced:${boardId}`, kind: 'error', status: 'error', title: `${board.unsynced.length} change${board.unsynced.length === 1 ? '' : 's'} too large to share`,
      detail: 'Larger than the 16 MiB the relay accepts per message (usually a source with a very large excerpt). It stays in this browser; colleagues and agents do not see it. Import large exports again: they are now split into source parts.' })
  }, [board.unsynced.length, boardId, notify])
  useEffect(() => { if (board.storageError) notify({ id: `storage:${board.storageError}`, kind: 'error', status: 'error', title: 'Browser storage problem', detail: board.storageError }) }, [board.storageError, notify])
  const markNoticesRead = useCallback(() => setNotices(list => list.map(n => n.read || n.status === 'running' || n.status === 'queued' ? n : { ...n, read: true })), [])
  const openNotice = (notice: Notice) => {
    const target = notice.target
    if (!target) return
    if (target.kind === 'review') setActiveTab('review')
    else if (target.kind === 'activity') setActiveTab('activity')
    else if (target.id && data && (target.kind === 'entity' ? data.entities.some(e => e.id === target.id) : data.facts.some(f => f.id === target.id))) setSelection({ kind: target.kind, id: target.id }, true)
    else setToast('That item is no longer on the board')
  }
  // Several log files: one after another, each with its own notice; the dialog closes right away.
  const importSlots = useMemo(() => createLimiter(1), [])
  const connectedRef = useRef(false)
  connectedRef.current = board.connected
  const waitForConnection = async (ms = 60_000) => {
    for (const until = Date.now() + ms; !connectedRef.current && Date.now() < until;) await new Promise(resolve => window.setTimeout(resolve, 300))
  }
  const runImports = (jobs: { name: string; run: () => Promise<string> }[]) => {
    const done: Promise<unknown>[] = []
    for (const job of jobs) {
      const id = notify({ kind: 'import', status: 'queued', title: `Import ${job.name}` })
      done.push(importSlots(async () => {
        updateNotice(id, { status: 'running', progress: connectedRef.current ? 'Importing rows…' : 'Waiting for the connection…' })
        try {
          // The import is confirmed once the browser has stored every chunk; the next file starts right away. The
          // server writes through this browser, so a file waits for the connection, and one that lost it is retried
          // once it is back (import IDs are stable: what was already stored is skipped).
          await waitForConnection()
          const summary = await job.run().catch(async problem => {
            if (!(problem instanceof Error) || !CONNECTION_ERROR.test(problem.message)) throw problem
            updateNotice(id, { progress: 'Connection lost · retrying when it is back…' })
            await new Promise(resolve => window.setTimeout(resolve, 1500))
            await waitForConnection()
            return job.run()
          })
          updateNotice(id, { status: 'done', detail: `${summary}. Evidence from the log rows is confirmed.`, finished: new Date().toISOString(), progress: undefined, target: { kind: 'review' }, read: false })
        } catch (problem) {
          updateNotice(id, { status: 'error', detail: problem instanceof Error ? problem.message : 'Import failed',
            finished: new Date().toISOString(), progress: undefined, read: false })
        }
      }))
    }
    setToast(`${jobs.length} import${jobs.length === 1 ? '' : 's'} started · see notifications`)
    return Promise.allSettled(done)
  }

  // Drag & drop: every file is read first. Exports with the columns of a saved format and Defender XDR / Sentinel tables
  // are imported right away; a FactGraph board export is imported as such; any other export opens the import dialog,
  // where its columns are mapped once and saved as a format for the next export of the same kind.
  const [dropping, setDropping] = useState(false)
  const dragDepth = useRef(0)
  const [importRequest, setImportRequest] = useState<{ file: File; inspection?: Inspection }[] | null>(null)
  const hasFiles = (event: React.DragEvent) => event.dataTransfer.types.includes('Files')
  const dropFiles = async (files: File[]) => {
    const supported = files.filter(file => /\.(csv|tsv|json|jsonl|ndjson)$/i.test(file.name))
    if (supported.length < files.length) setToast(`Skipped ${files.length - supported.length} file${files.length - supported.length === 1 ? '' : 's'}: only CSV, JSON and JSONL exports can be imported`)
    const tables: File[] = []
    for (const file of supported) {
      if (/\.json$/i.test(file.name) && (await file.slice(0, 2048).text()).includes('"factgraph-board-v1"')) void importFile(file)
      else tables.push(file)
    }
    if (!tables.length) return
    setToast(`Reading ${tables.length} file${tables.length === 1 ? '' : 's'}…`)
    const read = await Promise.all(tables.map(file => inspectImport(boardId, board.sessionToken, file).then(inspection => ({ file, inspection }),
      (problem: unknown) => ({ file, problem: problem instanceof Error ? problem.message : String(problem) }))))
    const formats = loadFormats()
    const jobs: { name: string; run: () => Promise<string> }[] = []
    const unknown: { file: File; inspection: Inspection }[] = []
    const used: string[] = []
    for (const entry of read) {
      if ('problem' in entry) {
        notify({ kind: 'import', status: 'error', title: `Import ${entry.file.name}`, detail: entry.problem, finished: new Date().toISOString(), read: false })
        continue
      }
      // A saved format wins over the built-in table: the analyst made it for exactly these columns.
      const match = matchFormat(formats, entry.inspection.columns.map(c => c.name))
      if (match) used.push(match.format.id)
      if (match || entry.inspection.builtin) jobs.push({ name: entry.file.name, run: async () =>
        describeTableImport(await uploadImport(boardId, board.sessionToken, entry.file, { ...importFields(match?.format ?? null), dry_run: 'false' })) })
      else unknown.push(entry)
    }
    if (used.length) markUsed(used)
    if (unknown.length) setImportRequest(current => [...(current ?? []), ...unknown])
    if (!jobs.length) return
    // Once everything is in, similar new entities are collapsed into groups. On an empty board the result is arranged;
    // otherwise new nodes keep their spots.
    const existing = data?.entities.map(e => e.id) ?? []
    await runImports(jobs)
    setActiveTab('graph')
    window.setTimeout(() => canvas('group-similar', { existing, arrange: !existing.length }), 300)
  }

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
  const explorerOpen = explorerByView[activeTab] ?? false
  const toggleExplorer = () => setExplorerByView(current => { const next = !current[activeTab]; writePref(`explorer:${activeTab}`, String(next)); return { ...current, [activeTab]: next } })
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
      else if (['1', '2', '3', '4', '5'].includes(event.key)) setActiveTab((['graph', 'timeline', 'review', 'activity', 'impact'] as WorkspaceTab[])[Number(event.key) - 1])
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [board.undo, board.redo, dialog, selection, showLogImport, readerId, showPalette, showHelp, showConnect, askName, activeTab])

  const navigate = (id: string) => { writePref('lastBoard', id); window.location.assign(`/boards/${id}`) }
  // Investigation data must not stay on an analyst's machine forever: remove it here, deliberately.
  const removeBoard = async () => {
    const others = board.peers.length
    const ok = window.confirm(`Remove “${board.boardName}” from this browser?\n\nIts ${board.actions.length.toLocaleString('en')} changes are deleted here. ${others ? `${others} other analyst${others === 1 ? ' has' : 's have'} it open and keep${others === 1 ? 's' : ''} their copy.` : 'Nobody else has it open right now: if no colleague or export has a copy, it is gone for good.'}\n\nExport it as JSON first if you may need it again.`)
    if (!ok) return
    try {
      boardRemoved.current = true
      await deleteBoard(boardId)
      writePref('lastBoard', '')
      window.location.assign(`/boards/${uuid()}`)
    } catch (problem) { setError(`Could not remove the board: ${String(problem)}`) }
  }
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
    notify({ kind: 'export', status: 'done', title: 'Board exported as JSON', detail: `${board.actions.length.toLocaleString('en')} actions · ${anchor.download}`, read: true })
  }
  const importFile = async (file: File | undefined) => {
    if (!file) return
    setError('')
    try {
      const parsed = JSON.parse(await file.text()) as Record<string, unknown>
      if (parsed.format === 'factgraph-board-v1' && Array.isArray(parsed.actions)) {
        const count = await board.importActions(parsed.actions as unknown[])
        setToast('Actions imported')
        notify({ kind: 'import', status: 'done', title: `Imported ${file.name}`, detail: `${count.toLocaleString('en')} new actions (already known ones are skipped)`, target: { kind: 'activity' }, read: true })
      } else {
        const count = await board.emitMany(legacyDrafts(parsed))
        setToast('Legacy data imported')
        notify({ kind: 'import', status: 'done', title: `Imported ${file.name}`, detail: `${count.toLocaleString('en')} changes from a legacy export`, target: { kind: 'activity' }, read: true })
      }
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : 'Import failed')
      notify({ kind: 'import', status: 'error', title: `Import of ${file.name} failed`, detail: problem instanceof Error ? problem.message : 'Import failed' })
    }
  }
  const renameBoard = () => { const value = window.prompt('Board name', board.boardName); if (value?.trim()) void act(() => board.emit('board.rename', { name: value.trim() }), 'Board renamed') }
  const renameSelf = () => { const value = window.prompt('Your display name', board.name); if (value?.trim()) board.setName(value) }
  const openDialog = (kind: DialogKind) => { setError(''); setDialog(kind) }

  const timeFacts = useMemo(() => factsInWindow(data?.facts ?? [], evidenceFrom || null, evidenceTo || null, includeUndated), [data, evidenceFrom, evidenceTo, includeUndated])
  const filteredFacts = useMemo(() => timeFacts.filter(item => stateFilter === 'all' || item.truth_state === stateFilter), [timeFacts, stateFilter])
  const counts = useMemo(() => Object.fromEntries(allStates.map(state => [state, timeFacts.filter(item => item.truth_state === state).length])) as Record<TruthState, number>, [timeFacts])
  const reviewCount = useMemo(() => data?.facts.reduce((sum, f) => sum + f.assertions.filter(a => !a.retracted_at && a.review_status !== 'confirmed').length, 0) ?? 0, [data])
  const timelineCount = useMemo(() => timelineEvents(filteredFacts).length, [filteredFacts])
  // The attack impact follows every change; without a compromised entity it is a single pass over the entities.
  const impact = useMemo(() => data ? analyzeImpact(data) : null, [data])
  const hunting = useMemo(() => data && impact?.seeds.length && activeTab === 'impact' ? huntingQueries(data, impact) : [], [data, impact, activeTab])
  const [impactLens, setImpactLens] = useState(false)
  useEffect(() => { if (!impact?.seeds.length) setImpactLens(false) }, [impact?.seeds.length])
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
      { id: 'v-activity', group: 'View', label: 'Change log (who changed what, via UI, REST, MCP, import)', hint: '4', icon: <Activity size={15} />, run: () => setActiveTab('activity') },
      { id: 'i-impact', group: 'View', label: 'Attack impact: compromised, impacted, rotate, hunt', hint: '5', icon: <ShieldAlert size={15} />, run: () => setActiveTab('impact') },
      { id: 'c-fit', group: 'Canvas', label: 'Fit graph to screen', hint: 'F', icon: <Crosshair size={15} />, run: () => { setActiveTab('graph'); canvas('fit') } },
      { id: 'i-lens', group: 'Canvas', label: 'Show the attack in the graph (impact lens)', icon: <ShieldAlert size={15} />, run: () => { setImpactLens(true); setActiveTab('graph') } },
      { id: 'c-group-similar', group: 'Changes the board (shared, undo)', label: 'Group all similar entities and arrange', hint: `${mod}Z undoes`, icon: <Boxes size={15} />, run: () => { setActiveTab('graph'); canvas('group-similar') } },
      { id: 'c-arrange', group: 'Changes the board (shared, undo)', label: 'Auto-arrange graph (saves positions for everyone)', hint: `${mod}Z undoes`, icon: <Sparkles size={15} />, run: () => { setActiveTab('graph'); canvas('arrange') } },
      { id: 'c-arrange-organic', group: 'Changes the board (shared, undo)', label: 'Arrange organically (large graphs, saves positions)', hint: `${mod}Z undoes`, icon: <Sparkles size={15} />, run: () => { setActiveTab('graph'); canvas('arrange-organic') } },
      { id: 'c-arrange-layers', group: 'Changes the board (shared, undo)', label: 'Arrange by layer (swimlanes, saves positions)', hint: `${mod}Z undoes`, icon: <Layers size={15} />, run: () => { setActiveTab('graph'); canvas('arrange-layers') } },
      { id: 'c-all-layers', group: 'Canvas', label: 'Show all layers', icon: <Layers size={15} />, run: () => setLens({ ...lens, layers: null }) },
      { id: 'c-activities', group: 'Canvas', label: lens.collapseActivities ? 'Show activities as event nodes' : 'Show activities as edges', icon: <Zap size={15} />, run: () => setLens({ ...lens, collapseActivities: !lens.collapseActivities }) },
      ...LAYERS.map(layer => ({ id: `l-${layer.id}`, group: 'Layers', label: `Only ${layer.label}`, hint: layer.hint, icon: <Layers size={15} />, run: () => { setActiveTab('graph'); setLens({ ...lens, layers: new Set([layer.id]) }) } })),
      ...(data?.views ?? []).map(view => ({ id: `p-${view.id}`, group: 'Perspectives', label: view.name, icon: <Layers size={15} />, run: () => { setActiveTab('graph'); applyPerspective(view.id) } })),
      ...(data?.groups ?? []).map(group => ({ id: `g-${group.id}`, group: 'Groups', label: group.name, hint: `${group.member_ids.length} members`, icon: <Boxes size={15} />, run: () => setSelection({ kind: 'group', id: group.id }, true) })),
      { id: 'c-explorer', group: 'Canvas', label: explorerOpen ? 'Hide entity explorer' : 'Show entity explorer', hint: 'E', icon: <ListTree size={15} />, run: toggleExplorer },
      { id: 'c-time', group: 'Canvas', label: showTime ? 'Hide evidence window' : 'Show evidence window', hint: 'T', icon: <Clock size={15} />, run: () => setShowTime(!showTime) },
      { id: 'c-reset-view', group: 'Canvas', label: 'Reset my view (filters, layers, evidence window)', icon: <RotateCcw size={15} />, run: resetView },
      { id: 'c-theme', group: 'Canvas', label: theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme', icon: theme === 'dark' ? <Sun size={15} /> : <Moon size={15} />, run: toggleTheme },
      { id: 'x-png', group: 'Export', label: 'Export graph as PNG', icon: <ImageDown size={15} />, run: () => { setActiveTab('graph'); window.setTimeout(() => canvas('export', { kind: 'png' }), 50) } },
      { id: 'x-svg', group: 'Export', label: 'Export graph as SVG (vector)', icon: <ImageDown size={15} />, run: () => { setActiveTab('graph'); window.setTimeout(() => canvas('export', { kind: 'svg' }), 50) } },
      { id: 'b-import-logs', group: 'Board', label: 'Import logs and exports…', icon: <Upload size={15} />, run: () => setShowLogImport(true) },
      { id: 'b-export', group: 'Board', label: 'Export board JSON', icon: <ArrowDownToLine size={15} />, run: download },
      { id: 'b-import', group: 'Board', label: 'Import board JSON…', icon: <Upload size={15} />, run: () => importInput.current?.click() },
      { id: 'b-link', group: 'Board', label: 'Copy board link', icon: <Copy size={15} />, run: () => void copyValue(window.location.href, 'Board link') },
      { id: 'b-token', group: 'Board', label: 'Copy board token (REST + MCP)', icon: <Plug size={15} />, run: () => void copyValue(board.sessionToken, 'Session token') },
      { id: 'b-connect', group: 'Board', label: 'Connect an agent (VS Code, Claude Code)…', icon: <Plug size={15} />, run: () => setShowConnect(true) },
      { id: 'b-help', group: 'Board', label: 'Keyboard & mouse controls', hint: '?', icon: <Keyboard size={15} />, run: () => setShowHelp('keys') },
      { id: 'b-glossary', group: 'Board', label: 'Glossary: status, evidence, review…', icon: <CircleHelp size={15} />, run: () => setShowHelp('glossary') },
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
    { id: 'activity', label: 'Change log', short: 'Changes', icon: <Activity size={14} />, count: board.actions.length },
    { id: 'impact', label: 'Attack impact', short: 'Impact', icon: <ShieldAlert size={14} />, count: impact?.impacted.length ?? 0 },
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
          <button onClick={resetView} title="Filters, layers, evidence window and zoom are remembered per board in this browser"><RotateCcw size={14} /> Reset my view</button>
          <div className="menu-sep" />
          <button onClick={() => setShowLogImport(true)}><Upload size={14} /> Import logs and exports</button>
          <button onClick={() => importInput.current?.click()}><Upload size={14} /> Import board JSON</button>
          <button onClick={download}><ArrowDownToLine size={14} /> Export board JSON</button>
          <button onClick={() => { setActiveTab('graph'); window.setTimeout(() => canvas('export', { kind: 'png' }), 50) }}><ImageDown size={14} /> Export graph as PNG</button>
          <button onClick={() => { setActiveTab('graph'); window.setTimeout(() => canvas('export', { kind: 'svg' }), 50) }}><ImageDown size={14} /> Export graph as SVG</button>
          <button onClick={() => void copyValue(exportJson(), 'Board JSON')}><Copy size={14} /> Copy board JSON</button>
          <div className="menu-sep" />
          <div className="menu-label">Boards in this browser</div>
          <div className="menu-scroll">{board.boards.map(item => <button key={item.id} className={item.id === boardId ? 'current' : ''} onClick={() => navigate(item.id)}><span className="menu-board-name">{item.name}</span><small>{item.id.slice(0, 8)}</small></button>)}</div>
          <button onClick={() => navigate(uuid())}><Plus size={14} /> New board</button>
          <button className="danger" onClick={() => void removeBoard()} title="Deletes this board's data from this browser; colleagues keep their copies"><Trash2 size={14} /> Remove board from this browser…</button>
          <div className="menu-sep" />
          <button onClick={renameSelf}>Display name · <strong>{board.name}</strong></button>
          <div className="menu-sep" />
          <button className="menu-footer" onClick={() => setShowHelp('data')}><HardDrive size={14} /><span>Stored only in this browser</span><small>v{__APP_VERSION__}</small></button>
        </Menu>
        <PresenceMenu connected={board.connected} self={{ id: board.actor, name: board.name }} peers={board.peers} actions={board.actions} onRename={renameSelf} />
        <SyncStatus sync={board.sync} connected={board.connected} ready={board.ready} />
      </div>
      <nav className="view-tabs" role="tablist" aria-label="Board views">
        {tabs.map(tab => <button key={tab.id} role="tab" aria-label={tab.label} aria-selected={activeTab === tab.id} className={activeTab === tab.id ? 'active' : ''} onClick={() => setActiveTab(tab.id)} title={tab.label}>
          {tab.icon}<span className="tab-text">{tab.short}</span>{tab.count > 0 && <b className={tab.id === 'review' ? 'attention' : tab.id === 'impact' ? 'attention danger' : ''}>{tab.count > 9999 ? '9k+' : tab.count}</b>}</button>)}
      </nav>
      <div className="topbar-right">
        <div className={`header-search ${search ? 'has-value' : ''}`}><Search size={14} /><input ref={searchInput} aria-label="Find entity" title="Find an entity by name, type or identifier: filters the entity explorer, Enter opens the best match" placeholder="Find entity…" value={search} onChange={e => setSearch(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && search.trim() && data) { const q = search.trim().toLowerCase(); const hit = data.entities.find(x => x.name.toLowerCase() === q || x.identifiers.some(i => i.raw_value.toLowerCase() === q)) ?? data.entities.find(x => x.name.toLowerCase().startsWith(q)) ?? data.entities.find(x => `${x.name} ${x.kind} ${x.identifiers.map(i => i.raw_value).join(' ')}`.toLowerCase().includes(q)); if (hit) setSelection({ kind: 'entity', id: hit.id }, true) } }} />
          {search ? <><span className="search-count">{matchCount}</span><button className="icon-button" aria-label="Clear search" onClick={() => setSearch('')}><X size={12} /></button></> : <Kbd>/</Kbd>}</div>
        <button className="icon-button command-button hide-sm" onClick={() => setShowPalette(true)} aria-label="Command palette" title={`Command palette · ${mod}K`}><Command size={15} /></button>
        <button className={`icon-button hide-sm ${showTime ? 'active' : ''} ${timeActive ? 'flagged' : ''}`} onClick={() => setShowTime(!showTime)} aria-label="Evidence window" aria-pressed={showTime} title="Evidence time window · T"><Clock size={15} /></button>
        <NotificationCenter notices={notices} onOpen={openNotice} onDismiss={id => setNotices(list => list.filter(n => n.id !== id))}
          onClearFinished={() => setNotices(list => list.filter(n => n.status === 'running' || n.status === 'queued'))}
          onMarkRead={markNoticesRead} />
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
          <button onClick={() => void copyValue(board.sessionToken, 'Board token')}><Copy size={14} /> Copy board token</button>
          <a href={restDocsEndpoint} target="_blank" rel="noreferrer"><FileText size={14} /> REST documentation</a>
          <p className="menu-note">Same token for REST + MCP. Keep this board open while agents write.</p>
        </Menu>
        <button className="icon-button theme-toggle" onClick={toggleTheme} aria-label={theme === 'dark' ? 'Light theme' : 'Dark theme'} title="Toggle theme">{theme === 'dark' ? <Sun size={15} /> : <Moon size={15} />}</button>
        <button className="icon-button help-button" onClick={() => setShowHelp('data')} aria-label="Help and data storage" title="Help · data storage · shortcuts"><CircleHelp size={16} /></button>
      </div>
    </header>

    <div className={`workspace${dropping ? ' dropping' : ''}`}
      onDragEnter={event => { if (!hasFiles(event) || !data) return; dragDepth.current++; setDropping(true) }}
      onDragLeave={event => { if (!hasFiles(event)) return; dragDepth.current = Math.max(0, dragDepth.current - 1); if (!dragDepth.current) setDropping(false) }}
      onDragOver={event => { if (!hasFiles(event) || !data) return; event.preventDefault(); event.dataTransfer.dropEffect = 'copy' }}
      onDrop={event => { if (!hasFiles(event) || !data) return; event.preventDefault(); dragDepth.current = 0; setDropping(false); void dropFiles([...event.dataTransfer.files]) }}>
      {dropping && <div className="drop-overlay" aria-hidden="true"><Upload size={26} /><strong>Drop exports to import them</strong>
        <span>Defender XDR advanced hunting and Microsoft Sentinel exports (CSV, JSON) are recognised and mapped automatically. FactGraph board exports work too.</span></div>}
      {explorerOpen && data && <Explorer data={data} search={search} selection={selection} onSelect={setSelection} onClose={toggleExplorer} />}
      <main className={`stage${showTime ? ' time-open' : ''}`}>
        {activeTab === 'graph' && <div className="graph-stage">
          {data && <GraphView entityTypes={data.entity_types ?? []} onCommand={board.emitMany} theme={theme} request={request}
            onEdit={id => { setSelection({ kind: 'entity', id }); openDialog('entity-edit') }} onMerge={id => { setSelection({ kind: 'entity', id }); openDialog('entity-merge') }}
            onCopy={(value, label) => void copyValue(value, label)}
            entities={data.entities} facts={filteredFacts} groups={data.groups ?? []} perspectives={data.views ?? []} lens={lens} onLensChange={next => setLens(next)}
            impact={impact} impactLens={impactLens} onImpactLensChange={setImpactLens} onOpenImpact={() => setActiveTab('impact')}
            activePerspective={activePerspective} onApplyPerspective={applyPerspective}
            onSavePerspective={name => { const id = uuid(); void act(async () => { await board.emit('view.add', { id, name, layers: lens.layers ? [...lens.layers] : null, collapse_activities: lens.collapseActivities, show_lanes: lens.showLanes }); setPerspectiveParam(id) }, 'Perspective saved') }}
            onDeletePerspective={id => { void act(() => board.emit('view.delete', { id }), 'Perspective deleted'); if (id === activePerspective) setPerspectiveParam(null) }}
            boardName={board.boardName} filterSummary={filterSummary} onNotice={setToast} onRequestDone={() => setRequest(null)}
            selection={selection} search={search} onSelect={setSelectionState}
            onExported={detail => notify({ kind: 'export', status: 'done', title: 'Graph exported', detail, read: true })}
            initialViewport={viewport.current} onViewportChange={v => { viewport.current = v; persistView() }} />}
          {data && data.entities.length > 0 && <div className="status-filter" role="group" aria-label="Filter relationships by status">
            <span className="status-filter-label" title="Line colour = evidence status (is it confirmed?). Red markers and red names = compromise. Grey “likely regular” = activity rating.">Evidence</span>
            <button className={stateFilter === 'all' ? 'active' : ''} onClick={() => setStateFilter('all')}>All <b>{timeFacts.length}</b></button>
            {allStates.map(state => <button key={state} className={`${state} ${stateFilter === state ? 'active' : ''}`} onClick={() => setStateFilter(stateFilter === state ? 'all' : state)} title={`Show only ${labels[state].toLowerCase()} relationships`}><span className="legend-line" />{labels[state]} <b>{counts[state]}</b></button>)}
          </div>}
          {data && data.entities.length === 0 && board.joining && <div className="empty-overlay"><div className="empty-card joining" role="status">
            <div className="empty-graphic"><RotateCcw size={24} className="spin" /></div><h2>Receiving the board…</h2>
            <p>Other analysts have this board open; their changes are on the way into this browser. Large boards take a few seconds.</p></div></div>}
          {data && data.entities.length === 0 && !board.joining && <div className="empty-overlay"><div className="empty-card">
            <div className="empty-graphic"><GitBranch size={26} /></div><h2>Start your investigation</h2>
            <p>Create entities and connect them with evidence-backed relationships, drop Defender XDR or Sentinel exports (CSV, JSON) here, or let an agent fill the board via REST / MCP.</p>
            <div className="empty-actions"><button className="primary-button" onClick={() => canvas('place')}><Plus size={15} /> First entity</button><button className="secondary-button" onClick={() => void act(() => board.emitMany(demoDrafts()), 'Example data loaded')}><Sparkles size={15} /> Load example</button><button className="secondary-button" onClick={() => setShowLogImport(true)}><Upload size={15} /> Import logs</button></div>
            <button className="empty-storage" onClick={() => setShowHelp('data')}><HardDrive size={13} /> Data stays in this browser — learn more</button>
            <div className="empty-keys"><span><Kbd>N</Kbd> new entity</span><span><Kbd>{mod}</Kbd><Kbd>K</Kbd> commands</span><span><Kbd>?</Kbd> shortcuts</span></div>
          </div></div>}
        </div>}
        {activeTab === 'review' && data && <div className="scroll-stage"><EvidenceQueue data={data} onOpen={setReaderId} attack={impact?.facts.size ? impact.facts : null} /></div>}
        {activeTab === 'timeline' && data && <div className="scroll-stage"><TimelinePanel data={data} facts={filteredFacts} selection={selection} onSelect={setSelection} impact={impact} /></div>}
        {activeTab === 'activity' && data && <div className="scroll-stage"><ActivityPanel actions={board.actions} data={data} onSelect={next => setSelection(next)} /></div>}
        {activeTab === 'impact' && data && impact && <div className="scroll-stage"><ImpactPanel data={data} impact={impact} queries={hunting} onCommand={board.emitMany}
          onShow={id => setSelection({ kind: 'entity', id }, true)} onShowFact={id => setSelection({ kind: 'fact', id }, true)}
          onLens={() => { setImpactLens(true); setActiveTab('graph') }} onCopy={(value, label) => void copyValue(value, label)} /></div>}
        {showTime && data && <EvidenceWindow facts={data.facts} from={evidenceFrom} to={evidenceTo} includeUndated={includeUndated} onIncludeUndatedChange={setIncludeUndated} onFromChange={setEvidenceFrom} onToChange={setEvidenceTo} onReset={() => { setEvidenceFrom(''); setEvidenceTo(''); setIncludeUndated(true) }} onClose={() => setShowTime(false)} attack={impact?.seeds.length ? impact : null} />}
        {!showTime && timeActive && <button className="time-chip" onClick={() => setShowTime(true)}><Clock size={13} /> Time window active</button>}
      </main>
      {showInspector && selection?.kind === 'group' && data && (() => { const group = data.groups?.find(g => g.id === selection.id); return group ? <GroupInspector data={data} group={group} impact={impact} onCommand={board.emitMany}
        onSelect={setSelection} onFocus={id => { setActiveTab('graph'); canvas('focus', { id }) }} onClose={() => setSelection(null)} /> : null })()}
      {showInspector && selection && selection.kind !== 'group' && data && <Inspector data={data} selection={selection} onAdd={openDialog} onDelete={deleteItem} onCopy={(value, label) => void copyValue(value, label)} onCommand={board.emitMany}
        onOpenEvidence={id => setReaderId(id)} onRetract={id => void act(() => board.emit('assertion.retract', { id, retracted_at: new Date().toISOString() }), 'Evidence retracted')}
        onClose={() => setSelection(null)} onSelect={setSelection} onFocus={id => { setActiveTab('graph'); canvas('focus', { id }) }}
        impact={impact} onOpenImpact={() => setActiveTab('impact')} />}
    </div>
    {readerId && data && <EvidenceReader data={data} evidenceId={readerId} actions={board.actions} onCommand={board.emitMany} onClose={() => setReaderId(null)} onCopy={(value, label) => void copyValue(value, label)} onNavigate={setReaderId} />}
    {dialog === 'activity' && data && <ActivityDialog data={data} initialEntity={selection?.kind === 'entity' ? selection.id : undefined} onClose={() => setDialog(null)} onCommand={board.emitMany}
      onCreated={id => { setDialog(null); setToast('Activity saved'); setSelection({ kind: 'fact', id }, true) }} />}
    {dialog && dialog !== 'activity' && data && <Dialog key={`${dialog}:${editingAssertionId ?? ''}:${relationTargetId ?? ''}`} kind={dialog} data={data} selection={selection} editingAssertionId={editingAssertionId} relationTargetId={relationTargetId} busy={busy} error={error} onClose={() => { setDialog(null); setEditingAssertionId(null); setRelationTargetId(null) }} onSubmit={submit} />}
    {(showLogImport || importRequest) && <ImportDialog boardId={boardId} sessionToken={board.sessionToken} initial={importRequest ?? undefined}
      kinds={[...new Set([...kinds, ...(data?.entity_types ?? []).map(type => type.name), ...(data?.entities ?? []).map(entity => entity.kind)])]}
      onClose={() => { setShowLogImport(false); setImportRequest(null) }} onApply={runImports} />}
    {showPalette && <CommandPalette items={paletteItems} onClose={() => setShowPalette(false)} />}
    {showConnect && <AgentConnectDialog boardId={boardId} token={board.sessionToken} name={board.name} onCopy={(value, label) => void copyValue(value, label)} onClose={() => setShowConnect(false)} />}
    {askName && board.ready && !showHelp && <WelcomeDialog current={board.name} onSave={name => { board.setName(name); setAskName(false) }} onLearnMore={() => setShowHelp('data')} />}
    {showHelp && <HelpDialog key={showHelp} initialTab={showHelp} boardCount={board.boards.length} onExport={download} onClose={() => setShowHelp(false)} />}
    <input ref={importInput} type="file" accept="application/json,.json" hidden onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; void importFile(file) }} />
    {board.replaced && <div className="replaced-banner" role="alert"><AlertTriangle size={15} /><span><b>This board was opened with this tab's identity in another tab</b> (for example a duplicated tab), so this tab is no longer connected. Your changes here are kept.</span>
        <button className="primary-button small" onClick={board.reidentify}>Continue here as a new session</button></div>}
    {board.otherTabs > 0 && !tabsHintSeen && !board.replaced && <div className="tabs-banner" role="status"><Info size={15} /><span><b>This board is also open in {board.otherTabs === 1 ? 'another tab' : `${board.otherTabs} other tabs`} of this browser.</b> Every tab loads and syncs the whole board, so a large board stays faster with one tab.</span>
        <button className="secondary-button small" onClick={dismissTabsHint}>Got it</button></div>}
    <div className="toasts" aria-live="polite">
      {board.storageError && <div className="toast error">{board.storageError}</div>}
      {error && !dialog && <div className="toast error" onClick={() => setError('')}>{error} <X size={14} /></div>}
      {toast && <div className="toast success"><CheckCircle2 size={14} /> {toast}</div>}
    </div>
  </div>
}
