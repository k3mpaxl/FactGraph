import { useMemo, useState, type ReactNode } from 'react'
import { AlertTriangle, Check, Lightbulb, ChevronDown, ChevronRight, Copy, Crosshair, KeyRound, Route, Search, ShieldAlert, Terminal, X } from 'lucide-react'
import type { ActionDraft } from './board'
import type { Assertion, Entity, GraphData } from './types'
import { EFFECTS, EFFECT_LABEL, adviceFor, compromiseOf, impactMarkdown, rotatedAtOf, traceBack, type Advice, variableListingScript, type AttackFact, type Effect, type Impact, type RotationCategory, type Seed } from './impact'
import { evidenceQuery, type HuntQuery } from './hunting'

type Command = (drafts: ActionDraft[]) => Promise<unknown>
const day = (t: string | null | undefined) => t ? t.slice(0, 16).replace('T', ' ') : '—'
/** "2026-09-17 02:35 – 06:09" on one day, full times otherwise. */
const span = (a: string | null, b: string | null) => !a ? 'time unknown' : !b || day(a) === day(b) ? day(a) : a.slice(0, 10) === b.slice(0, 10) ? `${day(a)} – ${day(b).slice(11)}` : `${day(a)} – ${day(b)}`
const windowLabel = (c: { from?: string | null; to?: string | null }) => !c.from && !c.to ? 'always' : `${c.from ? `since ${day(c.from)}` : 'until'}${c.to ? `${c.from ? ' until' : ''} ${day(c.to)}` : ''} UTC`
/** datetime-local works in local time; logs are UTC, so the inputs are read and shown as UTC. */
const toInput = (iso: string | null | undefined) => iso ? iso.slice(0, 16) : ''
const fromInput = (value: string) => value ? `${value}:00Z` : null
const MARKABLE = /credential|secret|token|key|certificate|service principal|application|managed identity|user|account|\bip\b|address|device|host/i

export const EFFECT_SHORT: Record<Effect, string> = { secret: 'Secrets exposed', delete: 'Deleted', write: 'Changed', read: 'Read', auth: 'Signed in', attempt: 'Attempted', other: 'Touched' }

/** Mark an entity compromised, change its window or clear it; shown in the inspector and in the impact view. */
export function CompromiseForm({ entity, onCommand, onDone, compact, initialFrom }: { entity: Entity; onCommand: Command; onDone?: () => void; compact?: boolean; initialFrom?: string }) {
  const marked = compromiseOf(entity)
  const current = marked && !marked.cleared ? marked : null
  const [from, setFrom] = useState(toInput(current?.from ?? initialFrom))
  const [to, setTo] = useState(toInput(current?.to))
  const [note, setNote] = useState(current?.note ?? '')
  const [error, setError] = useState('')
  const save = () => {
    const payload = { from: fromInput(from), to: fromInput(to), note: note.trim() }
    if (payload.from && payload.to && payload.from > payload.to) { setError('Until must be after since'); return }
    void onCommand([{ type: 'entity.update', payload: { id: entity.id, compromise: payload } }]).then(() => onDone?.()).catch(problem => setError(String(problem)))
  }
  return <form className={`compromise-form${compact ? ' compact' : ''}`} onSubmit={event => { event.preventDefault(); save() }}>
    <div className="field-grid">
      <label>Since (UTC)<input type="datetime-local" value={from} onChange={e => setFrom(e.target.value)} aria-label={`Compromised since, ${entity.name}`} /></label>
      <label>Until (UTC, optional)<input type="datetime-local" value={to} onChange={e => setTo(e.target.value)} aria-label={`Compromised until, ${entity.name}`} /></label>
    </div>
    {!compact && <label>Note<input value={note} onChange={e => setNote(e.target.value)} placeholder="How it was compromised, ticket…" /></label>}
    <p className="hint">Leave since empty if it was always the attacker's (an IP of their infrastructure).</p>
    {error && <p className="form-error">{error}</p>}
    <div className="form-actions">
      {onDone && <button type="button" className="secondary-button small" onClick={onDone}>Cancel</button>}
      <button className="primary-button small danger-fill"><ShieldAlert size={13} /> {current ? 'Save window' : 'Mark compromised'}</button>
    </div>
  </form>
}

const confirmDerived = (entity: Entity, derived: NonNullable<Seed['derived']>, via: string): ActionDraft =>
  ({ type: 'entity.update', payload: { id: entity.id, compromise: { from: derived.at, to: null, note: `Used from ${via} on ${day(derived.at)} (derived, confirmed)` } } })
const notCompromised = (entity: Entity, note = 'Checked: not compromised'): ActionDraft => ({ type: 'entity.update', payload: { id: entity.id, compromise: { cleared: true, note } } })

/** The evidence item an attacker activity is shown with: its latest one inside the window. */
export const latestItem = (attack: AttackFact): Assertion | undefined =>
  attack.fact.assertions.filter(a => !a.retracted_at && a.valid_from && (!attack.last || a.valid_from <= attack.last)).sort((a, b) => (b.valid_from ?? '').localeCompare(a.valid_from ?? ''))[0]

/** Attacker activities an entity took part in, latest first: when, what, with whom, and the original row in KQL. */
function AttackEvents({ entity, impact, data, nameOf, onCopy, onOpenEvidence }: { entity: Entity; impact: Impact; data: GraphData; nameOf: (id: string) => string; onCopy: (value: string, label: string) => void; onOpenEvidence: (id: string) => void }) {
  const [all, setAll] = useState(false)
  const events = [...impact.facts.values()].filter(a => (a.fact.participants?.length ? a.fact.participants.some(p => p.entity_id === entity.id) : a.fact.subject_id === entity.id || a.fact.object_id === entity.id))
    .sort((a, b) => (b.last ?? '').localeCompare(a.last ?? ''))
  if (!events.length) return null
  return <div className="attack-events"><h4>Attacker activity <b>{events.length}</b></h4>
    {events.slice(0, all ? 100 : 6).map(attack => { const item = latestItem(attack); const query = item ? evidenceQuery(item, data.sources) : null
      const others = (attack.fact.participants ?? []).filter(p => p.entity_id !== entity.id).map(p => `${p.role} ${nameOf(p.entity_id)}`)
      return <div key={attack.fact.id} className={`attack-event${attack.before ? ' regular' : ''}`}>
        <div className="attack-event-head"><span className="step-time">{span(attack.first, attack.last)}</span><span className={`effect-badge ${attack.effect}`}>{EFFECT_SHORT[attack.effect]}</span><b>{attack.count}×</b></div>
        <strong>{attack.fact.predicate}</strong><small className="muted">{others.join(' · ')}</small>
        {attack.before > 0 && <small className="regular-hint">Happened exactly so {attack.before}× before the compromise: likely regular activity.</small>}
        <div className="attack-event-actions">
          {item && <button className="text-button" onClick={() => onOpenEvidence(item.id)}>Evidence</button>}
          {query && <button className="text-button" onClick={() => onCopy(query, 'KQL for the original row')}><Copy size={11} /> KQL</button>}
          {item?.locator && <button className="text-button" onClick={() => onCopy(item.locator!, 'Locator')}><Copy size={11} /> Locator</button>}
        </div>
      </div> })}
    {events.length > 6 && !all && <button className="text-button" onClick={() => setAll(true)}>Show all {events.length}</button>}
  </div>
}

/** The entity's part in the attack, for the inspector: compromised, a pivot, or impacted by it. */
export function CompromiseBox({ entity, impact, data, nameOf, onCommand, onOpenImpact, onCopy, onOpenEvidence }: { entity: Entity; impact: Impact | null; data: GraphData; nameOf: (id: string) => string; onCommand: Command; onOpenImpact: () => void
  onCopy: (value: string, label: string) => void; onOpenEvidence: (id: string) => void }) {
  const [editing, setEditing] = useState(false)
  const marked = compromiseOf(entity)
  const current = marked && !marked.cleared ? marked : null
  const cleared = marked?.cleared ? marked : null
  const derived = impact?.seeds.find(s => s.entity.id === entity.id)?.derived
  const trace = useMemo(() => impact ? traceBack(impact).find(t => t.entity.id === entity.id) : undefined, [impact, entity.id])
  const about = useMemo(() => impact ? adviceFor(data, impact).filter(a => a.severity !== 'info' && (a.mark?.includes(entity.id) || (a.id.startsWith('uti-') && a.entities.includes(entity.id)))).slice(0, 3) : [], [impact, data, entity.id])
  const impacted = impact?.impacted.find(i => i.entity.id === entity.id)
  const pivot = impact?.pivots.find(p => p.entity.id === entity.id)
  const rotation = impact?.rotation.filter(r => r.entityId === entity.id) ?? []
  const rotatedAt = rotatedAtOf(entity)
  const setRotated = (value: string | null) => void onCommand([{ type: 'entity.update', payload: { id: entity.id, rotated_at: value } }]).catch(() => {})
  return <div className="compromise-box">
    {current && !editing && <div className="impact-callout compromised">
      <ShieldAlert size={15} /><div><strong>Compromised</strong><span>{windowLabel(current)}{current.note ? ` · ${current.note}` : ''}</span>
        <small>Marked by {current.by ?? 'someone'}{current.at ? ` on ${day(current.at)}` : ''}</small></div>
      <div className="callout-actions"><button className="text-button" onClick={() => setEditing(true)}>Edit</button>
        <button className="text-button" onClick={() => void onCommand([{ type: 'entity.update', payload: { id: entity.id, compromise: null } }]).catch(() => {})}>Clear</button></div>
    </div>}
    {derived && !editing && <div className="impact-callout compromised derived">
      <ShieldAlert size={15} /><div><strong>Compromised (derived)</strong><span>Used successfully from {nameOf(derived.via)} on {day(derived.at)} UTC, so compromised no later than then. It may have been stolen earlier.</span></div>
      <div className="callout-actions"><button className="text-button" onClick={() => void onCommand([confirmDerived(entity, derived, nameOf(derived.via))]).catch(() => {})}>Confirm</button>
        <button className="text-button" onClick={() => void onCommand([notCompromised(entity)]).catch(() => {})}>Not compromised</button></div>
    </div>}
    {cleared && !editing && <div className="impact-callout cleared">
      <Check size={15} /><div><strong>Checked: not compromised</strong><span>{cleared.note || 'Never derived from attacker infrastructure'}</span><small>By {cleared.by ?? 'someone'}{cleared.at ? ` on ${day(cleared.at)}` : ''}</small></div>
      <div className="callout-actions"><button className="text-button" onClick={() => void onCommand([{ type: 'entity.update', payload: { id: entity.id, compromise: null } }]).catch(() => {})}>Undo</button></div>
    </div>}
    {editing && <CompromiseForm entity={entity} onCommand={onCommand} onDone={() => setEditing(false)} />}
    {!current && !derived && !editing && pivot && <div className={`impact-callout ${pivot.before ? 'cleared' : 'pivot'}`}>
      {pivot.before ? <Check size={15} /> : <Route size={15} />}<div><strong>{pivot.before ? 'Likely regular' : 'New since the compromise'}</strong>
        <span>{pivot.roles.join(', ')} in {pivot.count} {pivot.count === 1 ? 'event' : 'events'} with compromised {pivot.seeds.map(nameOf).join(', ')} · {span(pivot.first, pivot.last)} UTC</span>
        <small>{pivot.before ? `Already used with it ${pivot.before}× before the compromise. Using a stolen credential does not make an IP the attacker's: this is most likely the legitimate owner.` : 'Never seen with it before the compromise: a candidate for the attacker. Check its other activity before marking it.'}</small></div>
    </div>}
    {trace && <div className="trace-mini"><strong>First used by the attacker {day(trace.at)} UTC</strong>{trace.via && <span> from {nameOf(trace.via)}</span>}
      {trace.exposedBy.length > 0 && <small>Possibly obtained from: {trace.exposedBy.map(step => `${step.operation} by ${step.seeds.map(nameOf).join(', ')} (${span(step.first, step.last)})`).join('; ')}</small>}
      {!trace.exposedBy.length && <small>Nothing on the board explains how it was obtained: hunt before this time (Impact → Hunt next).</small>}</div>}
    {impacted && <div className={`impact-callout impacted ${impacted.regular ? 'regular' : impacted.effect}`}>
      {impacted.regular ? <Check size={15} /> : <AlertTriangle size={15} />}<div><strong>{impacted.regular ? `Likely regular · ${EFFECT_LABEL[impacted.effect].toLowerCase()}` : EFFECT_LABEL[impacted.effect]}</strong>
        <span>{impacted.operations.slice(0, 4).map(o => `${o.operation} ×${o.count}`).join(' · ')}</span>
        <small>{span(impacted.first, impacted.last)} UTC · by {impacted.actors.slice(0, 3).map(nameOf).join(', ')}{impacted.actors.length > 3 ? ` +${impacted.actors.length - 3}` : ''}</small>
        {impacted.regular && <small>Every one of these activities also happened exactly so before the compromise.</small>}
        {!impacted.regular && impacted.routine > 0 && <small>The compromised identity did the same here {impacted.routine}× before the compromise (from other sources): routine operation, new circumstances.</small>}</div>
    </div>}
    {about.map(a => <div key={a.id} className={`advice compact ${a.severity}`}><div className="advice-head"><span className={`advice-level ${a.severity}`}>{a.severity === 'high' ? 'Act' : a.severity === 'medium' ? 'Check' : 'Note'}</span><strong>{a.title}</strong></div><p>{a.detail}</p>
      {a.mark?.includes(entity.id) && !current && <button className="secondary-button small danger-outline" onClick={() => void onCommand([{ type: 'entity.update', payload: { id: entity.id, compromise: { from: null, to: null, note: `From advice: ${a.title}` } } }]).catch(() => {})}><ShieldAlert size={12} /> Mark compromised</button>}</div>)}
    {impact && <AttackEvents entity={entity} impact={impact} data={data} nameOf={nameOf} onCopy={onCopy} onOpenEvidence={onOpenEvidence} />}
    {rotation.length > 0 && <div className="rotation-mini">{rotation.map(item => <div key={item.id} className={`rotation-line${item.stale ? ' stale' : ''}`}>
      <KeyRound size={13} /><span>{item.title}{item.stale && <b> · attacker active after rotation</b>}</span></div>)}
      <button className="secondary-button small" onClick={() => setRotated(rotatedAt && !rotation.some(r => r.stale) ? null : new Date().toISOString())}>
        <Check size={13} /> {rotatedAt && !rotation.some(r => r.stale) ? `Rotated ${day(rotatedAt)} · undo` : 'Mark rotated now'}</button></div>}
    {!current && !derived && !editing && <div className="compromise-actions">
      <button className="secondary-button small danger-outline" onClick={() => setEditing(true)}><ShieldAlert size={13} /> Mark compromised…</button>
      {impact && impact.seeds.length > 0 && <button className="text-button" onClick={onOpenImpact}>Attack impact</button>}
    </div>}
  </div>
}

function Block({ title, count, icon, action, children, open: initial = true }: { title: string; count?: number; icon: ReactNode; action?: ReactNode; children: ReactNode; open?: boolean }) {
  const [open, setOpen] = useState(initial)
  return <section className="impact-block">
    <header><button className="impact-block-toggle" onClick={() => setOpen(!open)} aria-expanded={open}>{open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}{icon}<h3>{title}</h3>{count !== undefined && <b>{count.toLocaleString('en')}</b>}</button>{action}</header>
    {open && <div className="impact-block-body">{children}</div>}
  </section>
}

/** One recommendation with the evidence it rests on and what to do about it. */
function AdviceCard({ advice, nameOf, onShow, onShowFact, onMark, onConfirm, query, onCopy }: { advice: Advice; nameOf: (id: string) => string; onShow: (id: string) => void; onShowFact: (id: string) => void
  onMark: (id: string, note: string) => void; onConfirm: (ids: string[]) => void; query?: HuntQuery; onCopy: (value: string, label: string) => void }) {
  return <div className={`advice ${advice.severity}`}>
    <div className="advice-head"><span className={`advice-level ${advice.severity}`}>{advice.severity === 'high' ? 'Act' : advice.severity === 'medium' ? 'Check' : 'Note'}</span><strong>{advice.title}</strong></div>
    <p>{advice.detail}</p>
    <div className="advice-actions">
      {advice.entities.slice(0, 6).map(id => <button key={id} className="entity-chip" onClick={() => onShow(id)}>{nameOf(id)}</button>)}
      {(advice.mark ?? []).slice(0, 4).map(id => <button key={`m${id}`} className="secondary-button small danger-outline" onClick={() => onMark(id, advice.title)}><ShieldAlert size={12} /> Mark {nameOf(id)}</button>)}
      {advice.confirm?.length ? <button className="secondary-button small" onClick={() => onConfirm(advice.confirm!)}><Check size={12} /> Confirm all</button> : null}
      {advice.facts?.[0] && <button className="text-button" onClick={() => onShowFact(advice.facts![0])}><Crosshair size={12} /> Evidence</button>}
      {query && <button className="text-button" onClick={() => onCopy(query.query, `KQL: ${query.title}`)}><Copy size={12} /> KQL</button>}
    </div>
  </div>
}

type Measure = { key: string; label: string; category: RotationCategory; detail: string; items: Impact['rotation'] }

/** One measure ("Rotate CI/CD variables") with the entities that need it as a checklist; done items move to the end. */
function RotationMeasure({ measure, nameOf, onShow, onShowFact, onRotated }: { measure: Measure; nameOf: (id: string) => string; onShow: (id: string) => void; onShowFact: (id: string) => void; onRotated: (entityId: string, done: boolean) => void }) {
  const [open, setOpen] = useState(measure.items.length <= 5)
  const [limit, setLimit] = useState(30)
  const done = measure.items.filter(i => i.rotatedAt && !i.stale).length
  const stale = measure.items.filter(i => i.stale).length
  const ordered = [...measure.items].sort((a, b) => Number(!!a.rotatedAt && !a.stale) - Number(!!b.rotatedAt && !b.stale))
  return <div className={`rotation-measure${stale ? ' stale' : ''}`}>
    <button className="rotation-measure-head" onClick={() => setOpen(!open)} aria-expanded={open}>
      {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}<strong>{measure.label}</strong>
      <span className="measure-progress"><i style={{ width: `${(done / measure.items.length) * 100}%` }} /></span>
      <span className="measure-count">{done}/{measure.items.length} done{stale ? ` · ${stale} again` : ''}</span></button>
    <p className="measure-detail">{measure.detail}</p>
    {open && <div className="rotation-items">{ordered.slice(0, limit).map(item => { const isDone = !!item.rotatedAt && !item.stale; const proven = isDone && item.proof && item.rotatedAt === item.proof.at; return <label key={item.id} className={`rotation-item${isDone ? ' done' : ''}${item.stale ? ' stale' : ''}${proven ? ' proven' : ''}`}>
      <input type="checkbox" checked={isDone} disabled={!!proven} title={proven ? 'Proven by imported evidence' : undefined} onChange={e => onRotated(item.entityId, e.target.checked)} aria-label={item.title} />
      <span><strong>{nameOf(item.entityId)}</strong>
        {item.proof && <small className="proof-line"><Check size={11} /> Proven: {item.proof.operation} {day(item.proof.at)} UTC <button type="button" className="text-button" onClick={event => { event.preventDefault(); onShowFact(item.proof!.fact) }}>evidence</button></small>}
        <small className="muted">{item.lastUse ? `attacker's last use ${day(item.lastUse)}` : 'last use unknown'}{item.rotatedAt && !proven ? ` · rotated ${day(item.rotatedAt)}` : ''}{item.stale ? ' · attacker active after rotation: rotate again and find out how' : ''}</small></span>
      <button type="button" className="icon-button" aria-label={`Show ${nameOf(item.entityId)}`} onClick={event => { event.preventDefault(); onShow(item.entityId) }}><Crosshair size={13} /></button>
    </label> })}
      {ordered.length > limit && <button className="text-button" onClick={() => setLimit(limit + 100)}>Show {Math.min(100, ordered.length - limit)} more of {ordered.length - limit}</button>}</div>}
  </div>
}

export function ImpactPanel({ data, impact, queries, onCommand, onShow, onShowFact, onLens, onCopy }: {
  data: GraphData; impact: Impact; queries: HuntQuery[]; onCommand: Command
  onShow: (entityId: string) => void; onShowFact: (factId: string) => void; onLens: () => void; onCopy: (value: string, label: string) => void
}) {
  const byId = useMemo(() => new Map(data.entities.map(e => [e.id, e])), [data.entities])
  const nameOf = (id: string) => byId.get(id)?.name ?? id
  const [effect, setEffect] = useState<Effect | 'all'>('all')
  const [limit, setLimit] = useState(100)
  const [openStep, setOpenStep] = useState<number | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const [needle, setNeedle] = useState('')
  const cleared = useMemo(() => data.entities.filter(e => compromiseOf(e)?.cleared), [data.entities])
  const trace = useMemo(() => traceBack(impact), [impact])
  const advice = useMemo(() => adviceFor(data, impact), [data, impact])
  const confirmAll = (ids: string[]) => void onCommand(ids.map(id => { const seed = impact.seeds.find(x => x.entity.id === id)!; return confirmDerived(seed.entity, seed.derived!, nameOf(seed.derived!.via)) })).catch(() => {})
  const markWith = (id: string, note: string) => void onCommand([{ type: 'entity.update', payload: { id, compromise: { from: null, to: null, note: `From advice: ${note}` } } }]).catch(() => {})
  /** "ci-reader" or "41 IP · 2 Location" for the partners of a step. */
  const withSummary = (ids: string[]) => {
    if (ids.length <= 2) return ids.map(nameOf).join(', ')
    const kinds = new Map<string, number>()
    for (const id of ids) { const kind = byId.get(id)?.kind ?? '?'; kinds.set(kind, (kinds.get(kind) ?? 0) + 1) }
    return [...kinds].sort((a, b) => b[1] - a[1]).map(([kind, n]) => `${n} ${kind}`).join(' · ')
  }
  const chip = (id: string) => <button key={id} className="entity-chip" onClick={() => onShow(id)} title={`Show ${nameOf(id)} in the graph`}>{nameOf(id)}</button>
  const mark = (id: string) => void onCommand([{ type: 'entity.update', payload: { id, compromise: { from: null, to: null, note: 'Pivot from the impact view' } } }]).catch(() => {})
  const candidates = useMemo(() => {
    const q = needle.trim().toLowerCase()
    if (!q) return []
    return data.entities.filter(e => !compromiseOf(e) && (`${e.name} ${e.kind} ${e.identifiers.map(i => i.raw_value).join(' ')}`).toLowerCase().includes(q))
      .sort((a, b) => Number(!MARKABLE.test(a.kind)) - Number(!MARKABLE.test(b.kind)) || a.name.localeCompare(b.name)).slice(0, 8)
  }, [needle, data.entities])
  const counts = useMemo(() => new Map(EFFECTS.map(e => [e, impact.impacted.filter(i => i.effect === e).length])), [impact])
  const shown = impact.impacted.filter(i => effect === 'all' || i.effect === effect)
  const open = impact.rotation.filter(r => !r.rotatedAt || r.stale).length
  const secretCount = counts.get('secret') ?? 0
  const categories: [RotationCategory, string][] = [['revoke', 'Revoke'], ['rotate', 'Rotate'], ['block', 'Block'], ['review', 'Review']]
  const setRotated = (entityId: string, done: boolean) => void onCommand([{ type: 'entity.update', payload: { id: entityId, rotated_at: done ? new Date().toISOString() : null } }]).catch(() => {})
  const script = impact.variables.length ? variableListingScript(impact.variables) : ''
  const rotationMeasures = useMemo(() => {
    const measures = new Map<string, Measure>()
    for (const item of impact.rotation) {
      const measure = measures.get(item.key) ?? { key: item.key, label: item.label, category: item.category, detail: item.detail, items: [] }
      measure.items.push(item); measures.set(item.key, measure)
    }
    return [...measures.values()]
  }, [impact.rotation])

  return <section className="view-page impact-page">
    <header className="view-header"><div><h2>Attack impact</h2><p>What was done with the compromised credentials, identities and IPs, what it reached, and what to do next.</p></div>
      {impact.seeds.length > 0 && <div className="head-actions">
        <button className="secondary-button small" onClick={onLens}><Crosshair size={13} /> Show in graph</button>
        <button className="secondary-button small" onClick={() => onCopy(impactMarkdown(impact, nameOf, queries), 'Impact report (Markdown)')}><Copy size={13} /> Copy report</button></div>}
    </header>

    {impact.seeds.length > 0 && <div className="impact-summary">
      <div className="impact-stat compromised"><b>{impact.seeds.length}</b><span>compromised{impact.seeds.some(x => x.derived) ? ` · ${impact.seeds.filter(x => x.derived).length} derived` : ''}</span></div>
      <div className="impact-stat"><b>{[...impact.facts.values()].reduce((n, f) => n + f.count, 0).toLocaleString('en')}</b><span>attacker events</span></div>
      <div className="impact-stat impacted"><b>{impact.impacted.length.toLocaleString('en')}</b><span>impacted · {secretCount} secrets exposed</span></div>
      <div className="impact-stat rotate"><b>{open}</b><span>to rotate / revoke</span></div>
      <div className="impact-stat"><b className="small-stat">{span(impact.first, impact.last)}</b><span>attacker activity (UTC)</span></div>
    </div>}

    {advice.length > 0 && <Block title="Advice" count={advice.length} icon={<Lightbulb size={14} />}>
      <p className="hint">What the evidence on this board suggests, most important first. Each advice names what it rests on.</p>
      {advice.slice(0, 30).map(a => <AdviceCard key={a.id} advice={a} nameOf={nameOf} onShow={onShow} onShowFact={onShowFact} onMark={markWith} onConfirm={confirmAll} query={queries.find(q => q.id === a.query)} onCopy={onCopy} />)}
    </Block>}

    <Block title="Compromised" count={impact.seeds.length} icon={<ShieldAlert size={14} />}>
      {impact.seeds.filter(s => s.derived).map(({ entity, derived }) => <div key={entity.id} className="impact-row seed derived">
        <div className="impact-row-main">{chip(entity.id)}<span className="kind-label">{entity.kind}</span><span className="pivot-tag new">derived</span>
          <span className="impact-window">no later than {day(derived!.at)} UTC</span><small className="muted">used successfully from {nameOf(derived!.via)}; may have been stolen earlier</small></div>
        <div className="row-actions"><button className="text-button" onClick={() => onShowFact(derived!.fact)}>Evidence</button>
          <button className="text-button" onClick={() => void onCommand([confirmDerived(entity, derived!, nameOf(derived!.via))]).catch(() => {})}>Confirm</button>
          <button className="text-button" onClick={() => void onCommand([notCompromised(entity)]).catch(() => {})}>Not compromised</button></div>
      </div>)}
      {impact.seeds.filter(s => !s.derived).map(({ entity }) => { const c = compromiseOf(entity)!; return <div key={entity.id} className="impact-row seed">
        <div className="impact-row-main">{chip(entity.id)}<span className="kind-label">{entity.kind}</span>
          <span className="impact-window">{windowLabel(c)}</span>{c.note && <small className="muted">{c.note}</small>}</div>
        <div className="row-actions"><button className="text-button" onClick={() => setEditing(editing === entity.id ? null : entity.id)}>Window</button>
          <button className="icon-button" aria-label={`Clear compromise of ${entity.name}`} title="No longer compromised" onClick={() => void onCommand([{ type: 'entity.update', payload: { id: entity.id, compromise: null } }]).catch(() => {})}><X size={14} /></button></div>
        {editing === entity.id && <CompromiseForm entity={entity} onCommand={onCommand} onDone={() => setEditing(null)} compact />}
      </div> })}
      {cleared.length > 0 && <p className="hint cleared-line">Checked, not compromised: {cleared.map(e => <span key={e.id} className="cleared-chip">{chip(e.id)}<button className="text-button" onClick={() => void onCommand([{ type: 'entity.update', payload: { id: e.id, compromise: null } }]).catch(() => {})}>undo</button></span>)}</p>}
      <div className="impact-search"><Search size={14} /><input value={needle} onChange={e => setNeedle(e.target.value)} placeholder="Mark compromised: search a credential, IP, identity…" aria-label="Find entity to mark compromised" /></div>
      {candidates.map(e => <div key={e.id} className="impact-row candidate"><div className="impact-row-main">{chip(e.id)}<span className="kind-label">{e.kind}</span></div>
        <div className="row-actions"><button className="secondary-button small danger-outline" onClick={() => { setEditing(e.id); setNeedle('') }}>Mark compromised…</button></div></div>)}
      {editing && !impact.seeds.some(s => s.entity.id === editing) && byId.get(editing) && <div className="impact-row"><div className="impact-row-main">{chip(editing)}</div>
        <CompromiseForm entity={byId.get(editing)!} onCommand={onCommand} onDone={() => setEditing(null)} /></div>}
      {!impact.seeds.length && <p className="muted small">Nothing is marked yet. Mark the stolen credential (since when?) or the attacker's IPs; everything below follows from that. You can also do it in the inspector of any entity.</p>}
    </Block>

    {impact.seeds.length > 0 && <>
      <Block title="Pivot next" count={impact.pivots.length} icon={<Route size={14} />}>
        <p className="hint">Identities, IPs and credentials that appeared together with what is compromised. <b>New since the compromise</b> is a candidate for the attacker. <b>Seen before</b> the compromise is most likely the legitimate owner: using a stolen credential does not make an IP the attacker's.</p>
        {impact.pivots.slice(0, 50).map(p => <div key={p.entity.id} className={`impact-row pivot${p.before ? ' known' : ''}`}>
          <div className="impact-row-main">{chip(p.entity.id)}<span className="kind-label">{p.entity.kind}</span>
            <span className={`pivot-tag${p.before ? '' : ' new'}`}>{p.before ? `seen ${p.before}× before` : 'new since compromise'}</span>
            <small className="muted">{p.roles.join(', ')} · {p.count}× with {p.seeds.map(nameOf).join(', ')} · {span(p.first, p.last)}</small></div>
          <div className="row-actions">{MARKABLE.test(p.entity.kind) ? <button className="secondary-button small danger-outline" onClick={() => mark(p.entity.id)} title="Its own activity becomes attacker activity too">Mark compromised</button>
            : <button className="text-button" onClick={() => onShow(p.entity.id)}>Show</button>}</div>
        </div>)}
        {!impact.pivots.length && <p className="muted small">No other identities or IPs were involved.</p>}
      </Block>

      <Block title="Trace back: how it started" count={trace.length} icon={<Route size={14} />}>
        <p className="hint">When each compromised entity was first used by the attacker, earliest first, and which secrets other compromised entities had read before that: where a credential was probably taken from.</p>
        <ol className="trace-list">{trace.map(t => <li key={t.entity.id} className="trace-entry">
          <span className="step-time">{day(t.at)}</span>
          <span className="trace-text">{chip(t.entity.id)}<span className="kind-label">{t.entity.kind}</span>{t.derived ? <span className="pivot-tag new">derived</span> : null}
            <span>first used by the attacker{t.via ? <> from {chip(t.via)}</> : null}</span>
            {t.exposedBy.length > 0 ? <small>possibly obtained from: {t.exposedBy.map((step, i) => <button key={i} className="text-button" onClick={() => onShowFact(step.facts[0])}>{step.operation} by {step.seeds.map(nameOf).join(', ')} ({span(step.first, step.last)})</button>)}</small>
              : <small className="muted">nothing earlier on the board explains it</small>}</span>
        </li>)}</ol>
        {trace[0] && <p className="hint">Nothing before {day(trace[0].at)} UTC is on the board. To find the real start, run <b>Everything from the attacker's IPs</b> and <b>Where else was the stolen credential used</b> under Hunt next: they start two weeks earlier.</p>}
      </Block>

      <Block title="What the attacker did" count={impact.steps.length} icon={<Route size={14} />}>
        <ol className="attack-steps">{impact.steps.slice(0, 200).map((step, index) => <li key={index} className={`attack-step ${step.effect}`}>
          <button className="attack-step-head" onClick={() => setOpenStep(openStep === index ? null : index)} aria-expanded={openStep === index}>
            <span className="step-time">{span(step.first, step.last)}</span>
            <span className="step-text"><span className="step-actors">{step.seeds.map(nameOf).join(' · ')}</span> <strong>{step.operation}</strong>{step.targets.length === 1 ? ` on ${nameOf(step.targets[0])}` : step.targets.length ? ` on ${step.targets.length} targets` : ''}
              {step.others.length > 0 && <span className="step-with"> · with {withSummary(step.others)}</span>}</span>
            <span className={`effect-badge ${step.regular ? 'other' : step.effect}`}>{step.regular ? 'Likely regular' : EFFECT_SHORT[step.effect]}</span><span className="step-count">{step.count}×</span></button>
          {openStep === index && <div className="attack-step-body"><div className="chip-list">{step.targets.slice(0, 60).map(chip)}{step.targets.length > 60 && <span className="muted small">+{step.targets.length - 60}</span>}</div>
            {step.others.length > 0 && <div className="chip-list"><span className="muted small">with</span>{step.others.slice(0, 40).map(chip)}{step.others.length > 40 && <span className="muted small">+{step.others.length - 40}</span>}</div>}
            <button className="text-button" onClick={() => onShowFact(step.facts[0])}><Crosshair size={12} /> Show activity</button></div>}
        </li>)}</ol>
        {impact.undated > 0 && <p className="hint">{impact.undated} evidence items have no time and could not be placed in a compromise window.</p>}
      </Block>

      <Block title="Impacted resources" count={impact.impacted.length} icon={<AlertTriangle size={14} />}>
        <div className="segmented" role="group" aria-label="Impact filter">
          <button className={effect === 'all' ? 'active' : ''} onClick={() => setEffect('all')}>All <b>{impact.impacted.length}</b></button>
          {EFFECTS.filter(e => counts.get(e)).map(e => <button key={e} className={effect === e ? 'active' : ''} onClick={() => { setEffect(e); setLimit(100) }}>{EFFECT_SHORT[e]} <b>{counts.get(e)}</b></button>)}</div>
        <div className="impact-list">{shown.slice(0, limit).map(i => <div key={i.entity.id} className={`impact-row impacted ${i.effect}`}>
          <div className="impact-row-main">{chip(i.entity.id)}<span className="kind-label">{i.entity.kind}</span><span className={`effect-badge ${i.effect}`}>{EFFECT_SHORT[i.effect]}</span>
            {i.regular ? <span className="pivot-tag" title="Every attacker activity here also happened exactly so before the compromise">likely regular</span> : i.routine > 0 ? <span className="pivot-tag" title="The identity did the same operation here before the compromise, from other sources">routine · new source</span> : null}
            <small className="muted">{i.operations.slice(0, 3).map(o => `${o.operation} ×${o.count}`).join(' · ')} · last {day(i.last)}</small></div>
        </div>)}</div>
        {shown.length > limit && <button className="text-button" onClick={() => setLimit(limit + 200)}>Show {Math.min(200, shown.length - limit)} more of {shown.length - limit}</button>}
      </Block>

      {(impact.variables.length > 0 || secretCount > 0) && <Block title="Secrets and variables read" count={impact.variables.length + secretCount} icon={<KeyRound size={14} />}>
        {impact.variables.length > 0 && <>
          <p className="hint">GitLab logs that the CI/CD variables of a project were read, not which ones: treat all of them as exposed, including the variables the project inherits from its groups. The script lists their keys.</p>
          <div className="code-head"><span>{impact.variables.length} projects · {new Set(impact.variables.flatMap(v => v.groups)).size} parent groups</span>
            <button className="text-button" onClick={() => onCopy(script, 'Variable listing script')}><Copy size={12} /> Copy script</button></div>
          <pre className="code-block small-code">{script}</pre>
          <div className="chip-list">{impact.variables.slice(0, 80).map(v => chip(v.entity.id))}{impact.variables.length > 80 && <span className="muted small">+{impact.variables.length - 80}</span>}</div>
        </>}
        {impact.impacted.filter(i => i.effect === 'secret' && !impact.variables.some(v => v.entity.id === i.entity.id)).slice(0, 60).map(i => <div key={i.entity.id} className="impact-row">
          <div className="impact-row-main">{chip(i.entity.id)}<span className="kind-label">{i.entity.kind}</span><small className="muted">{i.operations.filter(o => o.effect === 'secret').map(o => o.operation).join(' · ')}</small></div></div>)}
      </Block>}

      <Block title="Rotate, revoke, block" count={open} icon={<KeyRound size={14} />} action={<button className="text-button" onClick={() => onCopy(impact.rotation.map(r => `- [${r.rotatedAt && !r.stale ? 'x' : ' '}] ${r.category}: ${r.title} — ${r.detail}`).join('\n'), 'Rotation checklist')}><Copy size={12} /> Copy</button>}>
        {impact.rotation.some(r => r.key === 'revoke-secret' || r.key === 'rotate-identity') && <p className="hint">Prove it: run <b>Prove the rotation</b> under Hunt next and drop the CSV export here. Removed keys tick themselves off; keys added during the attack appear as backdoors to remove.</p>}
        {categories.map(([category, label]) => { const measures = rotationMeasures.filter(m => m.category === category); return measures.length ? <div key={category} className="rotation-group">
          <h4>{label} <b>{measures.reduce((n, m) => n + m.items.length, 0)}</b></h4>
          {measures.map(measure => <RotationMeasure key={measure.key} measure={measure} nameOf={nameOf} onShow={onShow} onShowFact={onShowFact} onRotated={setRotated} />)}
        </div> : null })}
        {!impact.rotation.length && <p className="muted small">Nothing to rotate yet.</p>}
      </Block>

      <Block title="Hunt next (KQL)" count={queries.length} icon={<Terminal size={14} />}>
        <p className="hint">Filled with the IDs, IPs, resources and window from this board. Run them in Sentinel / Log Analytics, export the results and drop them here: the graph and this view grow with them.</p>
        {queries.map(q => <div key={q.id} className="hunt-query">
          <div className="hunt-head"><div><strong>{q.title}</strong><small>{q.why}</small>
            <small className="muted">{q.tables.join(', ')}{q.imported ? ' · partly on the board already' : ''}</small>
            {q.importable && <small className="importable-tag">Importable: export the result as CSV and drop it on the board ({q.importable})</small>}</div>
            <button className="secondary-button small" onClick={() => onCopy(q.query, 'KQL')}><Copy size={12} /> Copy</button></div>
          <pre className="code-block">{q.query}</pre>
        </div>)}
      </Block>
    </>}
  </section>
}
