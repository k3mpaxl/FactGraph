import { useEffect, useState, type CSSProperties } from 'react'
import {
  ArrowDownToLine,
  ArrowRight,
  Copy,
  CornerDownLeft,
  GitBranch,
  HardDrive,
  Server,
  Users,
  AlertTriangle,
  Lock,
  Plug,
  ShieldCheck,
  X,
} from 'lucide-react'
import { EntityPicker, entityContext } from './EntityPicker'
import { fromUtcInput, toUtcInput } from './timeline'
import { type Selection } from './GraphView'
import { GLOSSARY } from './explain'
import { compromiseOf } from './impact'
import { entityVisual } from './entityVisual'
import type { Entity, Fact, GraphData, TruthState } from './types'
import { kinds, customKindValue, schemes, mod, nameOf, StatePill, Kbd } from './ui'

export type DialogKind =
  'entity' | 'entity-edit' | 'entity-merge' | 'fact' | 'source' | 'identifier' | 'assertion' | 'assertion-edit' | 'activity' | null
export const defaultColors = ['#ef4444', '#f97316', '#eab308', '#22c55e', '#14b8a6', '#3b82f6', '#8b5cf6', '#ec4899', '#64748b']

/** Color choice with quick swatches: fixed defaults plus colors already used on this board, so related infrastructure can share one color. */
export function ColorField({ data, initial }: { data: GraphData; initial: string }) {
  const [color, setColor] = useState(initial.toLowerCase())
  const counts = new Map<string, number>()
  for (const entity of data.entities)
    if (entity.color) {
      const c = entity.color.toLowerCase()
      counts.set(c, (counts.get(c) ?? 0) + 1)
    }
  const used = [...counts]
    .filter(([c]) => !defaultColors.includes(c))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 9)
    .map(([c]) => c)
  const swatch = (c: string, title: string) => (
    <button
      key={c}
      type="button"
      className={`color-swatch${c === color ? ' active' : ''}`}
      style={{ '--swatch': c } as CSSProperties}
      title={title}
      aria-label={`Color ${c}`}
      aria-pressed={c === color}
      onClick={() => setColor(c)}
    />
  )
  return (
    <div className="color-field">
      <span className="field-label">Node color</span>
      <input type="hidden" name="color" value={color} />
      <div className="color-swatches">
        {defaultColors.map(c => swatch(c, c))}
        <label
          className={`color-custom${defaultColors.includes(color) || used.includes(color) ? '' : ' active'}`}
          title={`Custom color · ${color}`}
          style={defaultColors.includes(color) || used.includes(color) ? undefined : { background: color }}
        >
          <input
            type="color"
            aria-label="Custom color"
            value={/^#[0-9a-f]{6}$/.test(color) ? color : '#000000'}
            onChange={e => setColor(e.target.value.toLowerCase())}
          />
        </label>
      </div>
      {used.length > 0 && (
        <>
          <span className="color-used-label">In use on this board</span>
          <div className="color-swatches">
            {used.map(c => swatch(c, `${c} · ${counts.get(c)} ${counts.get(c) === 1 ? 'entity' : 'entities'}`))}
          </div>
        </>
      )}
    </div>
  )
}

/** What a merge does before it is saved: which entity stays, what moves over, what is dropped, what needs review again. */
export function MergePreview({ data, sourceId, targetId }: { data: GraphData; sourceId: string; targetId: string }) {
  const source = data.entities.find(e => e.id === sourceId),
    target = data.entities.find(e => e.id === targetId)
  if (!source || !target) return null
  const touches = (f: Fact, id: string) => f.subject_id === id || f.object_id === id || !!f.participants?.some(p => p.entity_id === id)
  const moved = data.facts.filter(f => touches(f, sourceId))
  const evidence = moved.reduce((n, f) => n + f.assertions.filter(a => !a.retracted_at).length, 0)
  const confirmed = moved.reduce((n, f) => n + f.assertions.filter(a => !a.retracted_at && a.review_status === 'confirmed').length, 0)
  const shared = moved.filter(f => touches(f, targetId)).length
  const groups = (data.groups ?? []).filter(g => g.member_ids.includes(sourceId)).length
  const sc = compromiseOf(source),
    tc = compromiseOf(target)
  const conflicts: string[] = []
  if (source.kind !== target.kind) conflicts.push(`Type: keeps “${target.kind}”, drops “${source.kind}”.`)
  if (source.description && source.description !== target.description)
    conflicts.push(`Description of ${source.name} is dropped${target.description ? '' : ' (the kept entity has none)'}.`)
  if (sc && JSON.stringify(sc) !== JSON.stringify(tc))
    conflicts.push(
      `Marking of ${source.name} (${sc.cleared ? 'good' : sc.level === 'suspected' ? 'suspected' : 'compromised'}) is dropped${tc ? `; ${target.name} keeps its own` : `: mark ${target.name} afterwards if it applies`}.`,
    )
  if ((source.color ?? '') !== (target.color ?? '') && source.color) conflicts.push('Colour: the kept entity’s colour stays.')
  const card = (e: Entity, role: string) => (
    <div className={`merge-card ${role}`}>
      <span className="eyebrow">{role === 'keep' ? 'Stays' : 'Disappears'}</span>
      <strong>{e.name}</strong>
      <span className="kind-label">{e.kind}</span>
      <small>{entityContext(e, data) || 'no identifiers'}</small>
      <small className="mono">{e.id}</small>
    </div>
  )
  return (
    <div className="merge-preview">
      <div className="merge-cards">
        {card(source, 'drop')}
        <ArrowRight size={16} />
        {card(target, 'keep')}
      </div>
      <ul className="merge-effects">
        <li>
          <b>{source.identifiers.length}</b> identifier{source.identifiers.length === 1 ? '' : 's'} and <b>{moved.length}</b> relationship
          {moved.length === 1 ? '' : 's'}/activit{moved.length === 1 ? 'y' : 'ies'} move to {target.name}
          {shared ? (
            <>
              {' '}
              ({shared} between the two become relationships of {target.name} with itself)
            </>
          ) : null}
          {groups ? (
            <>
              ; it takes its place in {groups} group{groups === 1 ? '' : 's'}
            </>
          ) : null}
          .
        </li>
        {evidence > 0 && (
          <li>
            <b className={confirmed ? 'warn-text' : ''}>{evidence.toLocaleString('en')}</b> evidence item{evidence === 1 ? '' : 's'} on them{' '}
            {confirmed ? (
              <>
                need a review again (<b>{confirmed.toLocaleString('en')}</b> confirmed now)
              </>
            ) : (
              'stay unconfirmed'
            )}
            : the statements now name a different entity.
          </li>
        )}
        {conflicts.map(c => (
          <li key={c} className="warn-text">
            {c}
          </li>
        ))}
        <li className="muted">Undo reverses the merge with all of this.</li>
      </ul>
      {source.kind !== target.kind && <div className="form-warning">Different types: make sure these are really the same thing.</div>}
    </div>
  )
}

export function Dialog({
  kind,
  data,
  selection,
  editingAssertionId,
  relationTargetId,
  busy,
  error,
  onClose,
  onSubmit,
}: {
  kind: Exclude<DialogKind, null>
  data: GraphData
  selection: Selection
  busy: boolean
  editingAssertionId: string | null
  relationTargetId: string | null
  error: string
  onClose: () => void
  onSubmit: (kind: Exclude<DialogKind, null>, values: Record<string, unknown>) => Promise<void>
}) {
  const titles = {
    activity: 'New activity',
    entity: 'New entity',
    'entity-edit': 'Edit entity',
    'entity-merge': 'Merge entity',
    fact: 'New relationship',
    source: 'New source',
    identifier: 'Add identifier',
    assertion: 'Add evidence',
    'assertion-edit': 'Edit evidence',
  }
  const editing = kind === 'entity-edit' ? data.entities.find(e => e.id === selection?.id) : undefined
  const editingAssertion =
    kind === 'assertion-edit'
      ? data.facts.flatMap(fact => fact.assertions).find(assertion => assertion.id === editingAssertionId)
      : undefined
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
    if (kind === 'entity' || kind === 'entity-edit')
      values = { name: get('name'), kind: entityKind, description: get('description'), color: get('color') }
    else if (kind === 'entity-merge') values = { target_id: get('target_id') }
    else if (kind === 'source')
      values = { title: get('title'), uri: get('uri'), excerpt: get('excerpt'), source_kind: get('source_kind'), query: get('query') }
    else if (kind === 'identifier')
      values = {
        scheme: get('scheme'),
        namespace: get('namespace'),
        raw_value: get('raw_value'),
        confidence,
        source_id: get('source_id') || null,
        valid_from: asDate('valid_from'),
        valid_to: asDate('valid_to'),
      }
    else if (kind === 'fact')
      values = {
        subject_id: get('subject_id'),
        predicate: get('predicate'),
        object_id: get('object_id'),
        new_object_name: newTarget ? get('new_object_name') : '',
        new_object_kind: newTarget ? targetKind : '',
        valid_from: asDate('valid_from'),
        valid_to: asDate('valid_to'),
        assertion: { stance, confidence, source_id: get('source_id') || null, note: get('note') },
      }
    else
      values = {
        locator: get('locator'),
        observation: get('note'),
        stance,
        confidence,
        source_id: get('source_id') || null,
        note: get('note'),
        valid_from: asDate('valid_from'),
        valid_to: asDate('valid_to'),
      }
    if (kind === 'entity' && !entityKind) {
      setLocalError('Please choose a type.')
      return
    }
    if (kind === 'fact' && newTarget && !targetKind) {
      setLocalError('Please choose a type for the new node.')
      return
    }
    if (kind === 'fact' && !newTarget && values.subject_id === values.object_id) {
      setLocalError('Choose two different entities.')
      return
    }
    if (get('valid_from') && get('valid_to') && get('valid_from') > get('valid_to')) {
      setLocalError('The end must be after the start.')
      return
    }
    setLocalError('')
    await onSubmit(kind, values)
  }
  const localDate = (value: string | null | undefined) => toUtcInput(value)
  const sourceSelect = (
    <label>
      Source <span className="optional">optional</span>
      <select name="source_id" defaultValue={editingAssertion?.source_id ?? ''}>
        <option value="">Manual entry</option>
        {data.sources.map(source => (
          <option key={source.id} value={source.id}>
            {source.title}
          </option>
        ))}
      </select>
    </label>
  )
  const confidenceField = (
    <label>
      Confidence <span className="optional">0–100 %</span>
      <input
        name="confidence"
        type="number"
        min="0"
        max="100"
        defaultValue={editingAssertion ? Math.round(editingAssertion.confidence * 100) : 100}
      />
    </label>
  )
  const dateFields = (
    <div className="field-grid">
      <label>
        Evidence from <span className="optional">UTC, optional</span>
        <input name="valid_from" type="datetime-local" defaultValue={localDate(editingAssertion?.valid_from)} />
      </label>
      <label>
        Evidence to <span className="optional">UTC, optional</span>
        <input name="valid_to" type="datetime-local" defaultValue={localDate(editingAssertion?.valid_to)} />
      </label>
    </div>
  )
  return (
    <div
      className="modal-backdrop"
      onMouseDown={event => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div className="modal" role="dialog" aria-modal="true" aria-label={titles[kind]}>
        <div className="modal-header">
          <h2>{titles[kind]}</h2>
          <button className="icon-button" onClick={onClose} aria-label="Close dialog">
            <X size={18} />
          </button>
        </div>
        <form onSubmit={submit}>
          <div className="modal-body">
            {(kind === 'entity' || kind === 'entity-edit') && (
              <>
                <label>
                  Name
                  <input name="name" defaultValue={editing?.name} autoFocus required placeholder="e.g. Web server 01" />
                </label>
                <div className="field-grid">
                  <label>
                    Type
                    <select
                      aria-label="Type"
                      name="kind"
                      defaultValue={editing ? (kinds.includes(editing.kind) ? editing.kind : customKindValue) : kinds[0]}
                      onChange={event => setCustomEntityKind(event.target.value === customKindValue)}
                    >
                      {kinds.map(value => (
                        <option key={value}>{value}</option>
                      ))}
                      <option value={customKindValue}>Custom type…</option>
                    </select>
                    {customEntityKind && (
                      <input name="custom_kind" defaultValue={editing?.kind} required autoFocus placeholder="e.g. SaaS application" />
                    )}
                  </label>
                </div>
                <ColorField data={data} initial={editing?.color || entityVisual(editing?.kind || kinds[0]).border} />
                <label>
                  Description <span className="optional">optional</span>
                  <textarea
                    name="description"
                    defaultValue={editing?.description}
                    rows={3}
                    placeholder="What is known about this entity?"
                  />
                </label>
              </>
            )}
            {kind === 'entity-merge' && selection?.kind === 'entity' && (
              <>
                <div className="modal-context">
                  Merge <strong>{nameOf(data, selection.id)}</strong> into another entity. Its identifiers, relationships and evidence are
                  retained.
                </div>
                <div className="field-stack">
                  <span className="field-label">Keep entity (the target)</span>
                  <EntityPicker
                    data={data}
                    label="Keep entity"
                    name="target_id"
                    value={mergeTarget}
                    onChange={setMergeTarget}
                    exclude={[selection.id]}
                    preferKind={data.entities.find(e => e.id === selection.id)?.kind}
                    autoFocus
                    required
                  />
                </div>
                {mergeTarget ? (
                  <MergePreview data={data} sourceId={selection.id} targetId={mergeTarget} />
                ) : (
                  <div className="form-warning">
                    The entity you merge disappears; the one you keep takes over its identifiers and relationships. Undo reverses it.
                  </div>
                )}
              </>
            )}
            {kind === 'source' && (
              <>
                <label>
                  Title
                  <input name="title" autoFocus required placeholder="e.g. EDR export from Sep 27" />
                </label>
                <label>
                  URL or reference <span className="optional">optional</span>
                  <input name="uri" placeholder="https://… or file path" />
                </label>
                <label>
                  Source classification
                  <select name="source_kind">
                    <option value="unknown">Unclassified</option>
                    <option value="primary">Primary evidence</option>
                    <option value="secondary">Secondary context</option>
                  </select>
                </label>
                <label>
                  KQL query <span className="optional">optional</span>
                  <textarea name="query" rows={2} className="mono" />
                </label>
                <label>
                  Original excerpt / results <span className="optional">optional</span>
                  <textarea name="excerpt" rows={4} className="mono" placeholder="Relevant passage from the source" />
                </label>
              </>
            )}
            {kind === 'identifier' && (
              <>
                <div className="modal-context">
                  Entity: <strong>{selection?.kind === 'entity' ? nameOf(data, selection.id) : ''}</strong>
                </div>
                <div className="field-grid">
                  <label>
                    Scheme
                    <select name="scheme">
                      {schemes.map(value => (
                        <option key={value}>{value}</option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Namespace <span className="optional">optional</span>
                    <input name="namespace" placeholder="e.g. prod" />
                  </label>
                </div>
                <label>
                  Value
                  <input name="raw_value" autoFocus required placeholder="External identifier" />
                </label>
                {dateFields}
                {sourceSelect}
                {confidenceField}
              </>
            )}
            {kind === 'fact' && (
              <>
                <div className="field-grid">
                  <div className="field-stack">
                    <span className="field-label">From</span>
                    <EntityPicker data={data} label="From" name="subject_id" value={subjectId} onChange={setSubjectId} required />
                  </div>
                  <div className="field-stack">
                    <span className="field-label">To</span>
                    <div className="segmented" role="group" aria-label="Target">
                      <button
                        type="button"
                        className={newTarget ? 'active' : ''}
                        aria-pressed={newTarget}
                        onClick={() => setNewTarget(true)}
                      >
                        New node
                      </button>
                      <button
                        type="button"
                        className={!newTarget ? 'active' : ''}
                        aria-pressed={!newTarget}
                        onClick={() => setNewTarget(false)}
                      >
                        Existing node
                      </button>
                    </div>
                  </div>
                </div>
                {newTarget ? (
                  <div className="field-grid">
                    <label>
                      New node name
                      <input name="new_object_name" required placeholder="e.g. Azure secret" />
                    </label>
                    <label>
                      Type
                      <select
                        name="new_object_kind"
                        defaultValue={kinds[0]}
                        onChange={event => setCustomTargetKind(event.target.value === customKindValue)}
                      >
                        {kinds.map(value => (
                          <option key={value}>{value}</option>
                        ))}
                        <option value={customKindValue}>Custom type…</option>
                      </select>
                      {customTargetKind && <input name="custom_new_object_kind" required autoFocus placeholder="e.g. SaaS application" />}
                    </label>
                  </div>
                ) : (
                  <div className="field-stack">
                    <span className="field-label">Target node</span>
                    <EntityPicker
                      data={data}
                      label="Target node"
                      name="object_id"
                      value={objectId}
                      onChange={setObjectId}
                      exclude={subjectId ? [subjectId] : undefined}
                      required
                    />
                  </div>
                )}
                <label>
                  Relationship / predicate
                  <input name="predicate" autoFocus required placeholder="e.g. reads, grants access to, accessed" />
                </label>
                {dateFields}
                <div className="form-divider">First evidence statement</div>
                <StanceSelect value={stance} onChange={setStance} />
                <div className="field-grid">
                  {sourceSelect}
                  {confidenceField}
                </div>
                <label>
                  Note <span className="optional">optional</span>
                  <textarea name="note" rows={2} placeholder="What supports this statement?" />
                </label>
              </>
            )}
            {(kind === 'assertion' || kind === 'assertion-edit') && (
              <>
                <div className="modal-context">
                  Relationship:{' '}
                  <strong>{selection?.kind === 'fact' ? data.facts.find(item => item.id === selection.id)?.predicate : ''}</strong>
                </div>
                {dateFields}
                <StanceSelect value={stance} onChange={setStance} />
                <div className="field-grid">
                  {sourceSelect}
                  {confidenceField}
                </div>
                <label>
                  Locator / event ID / result row
                  <input name="locator" defaultValue={editingAssertion?.locator} />
                </label>
                <label>
                  Observation
                  <textarea
                    name="note"
                    defaultValue={editingAssertion?.observation || editingAssertion?.note}
                    rows={3}
                    placeholder="What does the source show?"
                  />
                </label>
              </>
            )}
            {(error || localError) && <div className="form-error">{localError || error}</div>}
          </div>
          <div className="modal-actions">
            <button type="button" className="secondary-button" onClick={onClose}>
              Cancel
            </button>
            <button className="primary-button" disabled={busy}>
              {busy ? 'Saving…' : 'Save'} <CornerDownLeft size={14} />
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

export function StanceSelect({ value, onChange }: { value: 'supports' | 'refutes'; onChange: (value: 'supports' | 'refutes') => void }) {
  return (
    <div className="stance-field">
      <span>Evidence stance</span>
      <div className="segmented">
        <button type="button" className={value === 'supports' ? 'active supports' : ''} onClick={() => onChange('supports')}>
          Supports
        </button>
        <button type="button" className={value === 'refutes' ? 'active refutes' : ''} onClick={() => onChange('refutes')}>
          Refutes
        </button>
      </div>
    </div>
  )
}

export type StorageInfo = { persisted: boolean | null; usage: number | null; quota: number | null }
export const formatBytes = (value: number) =>
  value < 1024 * 1024
    ? `${Math.max(1, Math.round(value / 1024))} KB`
    : value < 1024 ** 3
      ? `${(value / 1024 / 1024).toFixed(1)} MB`
      : `${(value / 1024 ** 3).toFixed(1)} GB`

/** Help: where data lives, version, and the keyboard and mouse controls. */
export function HelpDialog({
  boardCount,
  onExport,
  onClose,
  initialTab = 'data',
}: {
  boardCount: number
  onExport: () => void
  onClose: () => void
  initialTab?: 'data' | 'keys' | 'glossary'
}) {
  const [tab, setTab] = useState(initialTab)
  const [storage, setStorage] = useState<StorageInfo>({ persisted: null, usage: null, quota: null })
  const [server, setServer] = useState<string | null>(null)
  useEffect(() => {
    void (async () => {
      try {
        const [persisted, estimate] = await Promise.all([navigator.storage?.persisted?.() ?? null, navigator.storage?.estimate?.() ?? null])
        setStorage({ persisted, usage: estimate?.usage ?? null, quota: estimate?.quota ?? null })
      } catch {
        /* storage API unavailable */
      }
    })()
    fetch('/api/health')
      .then(r => r.json())
      .then(body => setServer(typeof body.version === 'string' ? body.version : null))
      .catch(() => setServer(null))
  }, [])
  const persist = async () => {
    try {
      const granted = await navigator.storage.persist()
      setStorage(current => ({ ...current, persisted: granted }))
    } catch {
      setStorage(current => ({ ...current, persisted: false }))
    }
  }
  const rows: [string, string[]][] = [
    ['Command palette / jump to entity', [mod, 'K']],
    ['Focus search', ['/']],
    ['New entity at centre', ['N']],
    ['Fit view / center selection', ['F']],
    ['Group selected entities', ['G']],
    ['Switch view: graph, timeline, review, change log, impact', ['1', '–', '5']],
    ['Toggle explorer', ['E']],
    ['Toggle evidence window', ['T']],
    ['Undo / redo', [mod, 'Z', '·', '⇧', mod, 'Z']],
    ['Delete selection', ['⌫']],
    ['Close / deselect', ['Esc']],
    ['Rename node', ['double-click']],
    ['Connect', ['drag right handle']],
  ]
  const pointer: [string, string][] = [
    ['Zoom', 'Mouse wheel · trackpad pinch'],
    ['Pan', 'Right-drag · trackpad two-finger scroll · Space + drag'],
    ['Select area', 'Left-drag on empty canvas'],
    ['Add to selection', 'Shift + click'],
    ['Scroll sideways', 'Shift + mouse wheel'],
  ]
  const mismatch = server && server !== __APP_VERSION__
  return (
    <div
      className="modal-backdrop"
      onMouseDown={event => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div className="modal help-modal" role="dialog" aria-modal="true" aria-label="Help">
        <div className="modal-header">
          <div className="help-title">
            <span className="brand-mark">
              <GitBranch size={13} strokeWidth={2.4} />
            </span>
            <h2>FactGraph</h2>
            <span className="version-chip" title="App version">
              v{__APP_VERSION__}
            </span>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="Close dialog">
            <X size={18} />
          </button>
        </div>
        <div className="help-tabs">
          <div className="segmented full" role="tablist" aria-label="Help topics">
            <button role="tab" aria-selected={tab === 'data'} className={tab === 'data' ? 'active' : ''} onClick={() => setTab('data')}>
              Where your data lives
            </button>
            <button role="tab" aria-selected={tab === 'keys'} className={tab === 'keys' ? 'active' : ''} onClick={() => setTab('keys')}>
              Keyboard & mouse
            </button>
            <button
              role="tab"
              aria-selected={tab === 'glossary'}
              className={tab === 'glossary' ? 'active' : ''}
              onClick={() => setTab('glossary')}
            >
              Glossary
            </button>
          </div>
        </div>
        <div className="modal-body">
          {tab === 'data' ? (
            <>
              <div className="storage-hero">
                <HardDrive size={20} />
                <div>
                  <strong>Everything stays in this browser.</strong>
                  <p>
                    Boards, entities, evidence and their history are stored only in this browser's local database (IndexedDB) on this
                    device.
                  </p>
                </div>
              </div>
              <ul className="help-list">
                <li>
                  <Server size={15} />
                  <span>
                    <strong>The server stores nothing.</strong> It delivers the app and relays changes live between browsers that have the
                    same board open.
                  </span>
                </li>
                <li>
                  <Users size={15} />
                  <span>
                    <strong>Sharing works while a browser is open.</strong> Another device receives the board only while a browser that
                    holds it is connected. The board link itself contains no data.
                  </span>
                </li>
                <li>
                  <Plug size={15} />
                  <span>
                    <strong>Agents need an open board.</strong> REST and MCP write through this browser tab; without it they report the
                    board as offline.
                  </span>
                </li>
                <li>
                  <AlertTriangle size={15} />
                  <span>
                    <strong>Deleting browser data deletes the boards.</strong> Clearing site data, private windows or cleanup tools remove
                    them for good — export a JSON backup regularly.
                  </span>
                </li>
                <li>
                  <Lock size={15} />
                  <span>
                    <strong>No login.</strong> Anyone who can reach this server and knows a board link can read and change that board. Only
                    expose FactGraph in trusted networks.
                  </span>
                </li>
              </ul>
              <div className="storage-status">
                <div>
                  <span>This browser</span>
                  <strong>
                    {boardCount} {boardCount === 1 ? 'board' : 'boards'}
                    {storage.usage !== null ? ` · ${formatBytes(storage.usage)} used` : ''}
                    {storage.quota ? ` of ${formatBytes(storage.quota)}` : ''}
                  </strong>
                </div>
                <div>
                  <span>Protected from automatic cleanup</span>
                  <strong className={storage.persisted ? 'ok-text' : 'warn-text'}>
                    {storage.persisted === null ? 'unknown' : storage.persisted ? 'Yes' : 'No'}
                  </strong>
                </div>
                <div className="storage-actions">
                  {storage.persisted === false && (
                    <button className="secondary-button small" onClick={() => void persist()}>
                      <ShieldCheck size={14} /> Ask browser to keep data
                    </button>
                  )}
                  <button className="secondary-button small" onClick={onExport}>
                    <ArrowDownToLine size={14} /> Export board JSON
                  </button>
                </div>
              </div>
              <p className="hint version-line">
                App v{__APP_VERSION__}
                {server ? ` · server v${server}` : ''}
                {mismatch ? ' — versions differ, reload the page after an update.' : ''} ·{' '}
                <a href="/docs" target="_blank" rel="noreferrer">
                  REST documentation
                </a>
              </p>
            </>
          ) : tab === 'glossary' ? (
            <>
              <p className="hint">
                How FactGraph decides what is known. The status of a relationship comes only from confirmed, unretracted evidence.
              </p>
              <dl className="glossary-list">
                {GLOSSARY.map(entry => (
                  <div key={entry.term}>
                    <dt>
                      {['Supported', 'Disputed', 'Refuted', 'Unknown'].includes(entry.term) ? (
                        <StatePill state={entry.term.toLowerCase() as TruthState} />
                      ) : (
                        entry.term
                      )}
                    </dt>
                    <dd>{entry.text}</dd>
                  </div>
                ))}
              </dl>
            </>
          ) : (
            <>
              <dl className="shortcut-list">
                {rows.map(([label, keys]) => (
                  <div key={label}>
                    <dt>{label}</dt>
                    <dd>
                      {keys.map((k, i) =>
                        ['–', '·'].includes(k) || k.includes(' ') ? (
                          <span key={i} className="muted">
                            {k}
                          </span>
                        ) : (
                          <Kbd key={i}>{k}</Kbd>
                        ),
                      )}
                    </dd>
                  </div>
                ))}
              </dl>
              <div className="form-divider">Mouse & trackpad</div>
              <dl className="shortcut-list">
                {pointer.map(([label, text]) => (
                  <div key={label}>
                    <dt>{label}</dt>
                    <dd className="muted">{text}</dd>
                  </div>
                ))}
              </dl>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

export type AgentClient = 'vscode' | 'claude' | 'other'
/** Copy-ready MCP/REST configuration for this board, including the token header. */
export function AgentConnectDialog({
  boardId,
  token,
  name,
  onCopy,
  onClose,
}: {
  boardId: string
  token: string
  name: string
  onCopy: (value: string, label: string) => void
  onClose: () => void
}) {
  const [client, setClient] = useState<AgentClient>('vscode')
  const [embed, setEmbed] = useState(false)
  const origin = window.location.origin
  const mcpUrl = `${origin}/mcp/`
  const vscode = JSON.stringify(
    embed
      ? { servers: { factgraph: { type: 'http', url: mcpUrl, headers: { 'X-FactGraph-Token': token } } } }
      : {
          inputs: [
            {
              type: 'promptString',
              id: 'factgraph-token',
              description: 'FactGraph board token (plug icon → Copy board token)',
              password: true,
            },
          ],
          servers: { factgraph: { type: 'http', url: mcpUrl, headers: { 'X-FactGraph-Token': '${input:factgraph-token}' } } },
        },
    null,
    2,
  )
  const claude = `claude mcp add --transport http factgraph ${mcpUrl} --header "X-FactGraph-Token: ${token}"`
  // Single quotes keep the variable unexpanded: .mcp.json stores the placeholder and Claude Code reads the token at start.
  const claudeShared = `claude mcp add --scope project --transport http factgraph ${mcpUrl} --header 'X-FactGraph-Token: \${FACTGRAPH_TOKEN}'`
  // The token in the MCP configuration names the board: the prompt needs no board ID.
  const prompt = `Use the FactGraph MCP server for this investigation; it is connected to my board through my board token. Before adding anything, look up what exists with find_entities (q = a name or identifier, paginate with offset/limit) and get_impact; read the whole board with get_graph only when it is small.`
  // A targeted, paginated read: large boards are thousands of records, a full graph read is megabytes.
  const curl = `curl -s "${origin}/api/boards/${boardId}/entities?q=203.0.113.7&limit=50" -H "X-FactGraph-Token: ${token}"`
  const Snippet = ({ label, value, hint }: { label: string; value: string; hint?: string }) => (
    <div className="snippet">
      <div className="snippet-head">
        <span>{label}</span>
        <button className="text-button" onClick={() => onCopy(value, label)}>
          <Copy size={13} /> Copy
        </button>
      </div>
      <pre>{value}</pre>
      {hint && <p className="hint">{hint}</p>}
    </div>
  )
  return (
    <div
      className="modal-backdrop"
      onMouseDown={event => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div className="modal help-modal" role="dialog" aria-modal="true" aria-label="Connect an agent">
        <div className="modal-header">
          <h2>Connect an agent</h2>
          <button className="icon-button" onClick={onClose} aria-label="Close dialog">
            <X size={18} />
          </button>
        </div>
        <div className="help-tabs">
          <div className="segmented full" role="tablist" aria-label="Agent client">
            {(
              [
                ['vscode', 'VS Code / Copilot'],
                ['claude', 'Claude Code'],
                ['other', 'Other / REST'],
              ] as [AgentClient, string][]
            ).map(([id, label]) => (
              <button
                key={id}
                role="tab"
                aria-selected={client === id}
                className={client === id ? 'active' : ''}
                onClick={() => setClient(id)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        <div className="modal-body">
          <p className="hint">
            Your <b>board token</b> connects an agent to this board as you: it is valid while this tab has the board open, a colleague has
            their own, and the agent needs no board ID. Its changes appear as yours, for example “MCP ({name})”.
          </p>
          {client === 'vscode' && (
            <>
              <Snippet
                label=".vscode/mcp.json"
                value={vscode}
                hint={
                  embed
                    ? 'Contains this session’s token — do not commit it.'
                    : 'VS Code asks for the token when the server starts, so the file can be committed.'
                }
              />
              <label className="check">
                <input type="checkbox" checked={embed} onChange={e => setEmbed(e.target.checked)} /> Put the token into the file instead of
                asking
              </label>
              <Snippet label="Token" value={token} hint="Paste it when VS Code asks for “FactGraph board token”." />
              <p className="hint">
                Then run <strong>MCP: List Servers</strong> → factgraph → Start, and pick the FactGraph tools in the agent tool picker.
              </p>
            </>
          )}
          {client === 'claude' && (
            <>
              <Snippet
                label="Terminal · only for you"
                value={claude}
                hint="Contains this session’s token and stays in your local Claude Code configuration. Do not share it."
              />
              <Snippet
                label="Terminal · shared project config (.mcp.json)"
                value={claudeShared}
                hint="Stores a placeholder, not the token, so .mcp.json can be committed. Each analyst sets FACTGRAPH_TOKEN before starting Claude Code:"
              />
              <Snippet
                label="Token for FACTGRAPH_TOKEN"
                value={`export FACTGRAPH_TOKEN=${token}`}
                hint="Run in the terminal that starts Claude Code; do not commit it."
              />
            </>
          )}
          {client === 'other' && (
            <>
              <Snippet label="MCP endpoint (Streamable HTTP)" value={mcpUrl} />
              <Snippet
                label="Header"
                value={`X-FactGraph-Token: ${token}`}
                hint="The token names this board: MCP tools need no board ID. Clients that cannot send headers pass board_token in every tool call."
              />
              <Snippet
                label="REST example: find an entity"
                value={curl}
                hint="Lists are paginated (offset, limit up to 1000) and searched with q; the same for /relations, /activities, /sources. Full reference under /docs."
              />
              <div className="agent-errors">
                <strong>When a call fails</strong>
                <dl>
                  <dt>401 / 403</dt>
                  <dd>Token missing or wrong: copy it again (plug icon → Copy board token). A new tab or browser has its own token.</dd>
                  <dt>404</dt>
                  <dd>Wrong board ID, or the record no longer exists: list again with q.</dd>
                  <dt>409 “Board offline”, “No open board for this board token”</dt>
                  <dd>No browser has the board open, or not this tab: the data lives in browsers, keep this tab open while agents work.</dd>
                  <dt>409 “changed”</dt>
                  <dd>Someone changed the record meanwhile: read it again and retry with the new revision.</dd>
                  <dt>503</dt>
                  <dd>The browser connection dropped during the call: retry; repeated IDs are not stored twice.</dd>
                </dl>
              </div>
            </>
          )}
          <Snippet
            label="First message for the agent"
            value={prompt}
            hint="Tools need the board ID; the token only authorises the connection."
          />
          <p className="hint lock-hint">
            <Lock size={13} /> The token belongs to this browser tab and stays valid while it is open. Opening the board in a new tab or
            browser creates a new token.
          </p>
        </div>
      </div>
    </div>
  )
}

/** First visit: choose the name other analysts see next to presence and changes. */
export function WelcomeDialog({
  current,
  onSave,
  onLearnMore,
}: {
  current: string
  onSave: (name: string) => void
  onLearnMore: () => void
}) {
  const [name, setName] = useState('')
  return (
    <div className="modal-backdrop">
      <div className="modal narrow" role="dialog" aria-modal="true" aria-label="Welcome">
        <div className="modal-header">
          <div className="help-title">
            <span className="brand-mark">
              <GitBranch size={13} strokeWidth={2.4} />
            </span>
            <h2>Welcome to FactGraph</h2>
          </div>
        </div>
        <form
          onSubmit={event => {
            event.preventDefault()
            onSave(name.trim() || current)
          }}
        >
          <div className="modal-body">
            <label>
              Your name
              <input
                autoFocus
                value={name}
                onChange={e => setName(e.target.value)}
                placeholder={current}
                maxLength={40}
                aria-label="Your name"
              />
            </label>
            <p className="hint">
              Shown to other analysts on the same board and stored with your changes. You can change it later in the board menu.
            </p>
            <button type="button" className="empty-storage" onClick={onLearnMore}>
              <HardDrive size={13} /> Your boards are stored only in this browser — learn more
            </button>
          </div>
          <div className="modal-actions">
            <button type="button" className="secondary-button" onClick={() => onSave(current)}>
              Skip
            </button>
            <button className="primary-button">Continue</button>
          </div>
        </form>
      </div>
    </div>
  )
}
