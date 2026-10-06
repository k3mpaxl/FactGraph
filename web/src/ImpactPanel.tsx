import { Fragment, useEffect, useMemo, useState, type ReactNode } from 'react'
import { AlertTriangle, Check, Lightbulb, ChevronDown, ChevronRight, Copy, Crosshair, KeyRound, Route, Search, ShieldAlert, Terminal, X } from 'lucide-react'
import type { ActionDraft } from './board'
import type { Assertion, Entity, GraphData } from './types'
import { EFFECTS, EFFECT_LABEL, adviceFor, attackSessions, caseSummary, compromiseOf, activityBefore, defaultSince, gapText, firstUseOf, INFRASTRUCTURE, networkProviders, startingPoints, impactMarkdown, rotatedAtOf, traceBack, type Advice, variableListingScript, type AttackFact, type Effect, type Impact, type RotationCategory, type Seed } from './impact'
import { evidenceQuery, type HuntQuery } from './hunting'

type Command = (drafts: ActionDraft[]) => Promise<unknown>
const day = (t: string | null | undefined) => t ? t.slice(0, 16).replace('T', ' ') : '—'
/** "2026-09-17 02:35 – 06:09" on one day, full times otherwise. */
const span = (a: string | null, b: string | null) => !a ? 'time unknown' : !b || day(a) === day(b) ? day(a) : a.slice(0, 10) === b.slice(0, 10) ? `${day(a)} – ${day(b).slice(11)}` : `${day(a)} – ${day(b)}`
/** Short form for narrow places: no year, and the second time without the day when it is the same day. */
const compact = (a: string | null, b: string | null) => { if (!a) return 'time unknown'; const s = (t: string) => t.slice(5, 16).replace('T', ' '); return !b || s(a) === s(b) ? s(a) : a.slice(0, 10) === b.slice(0, 10) ? `${s(a)} – ${s(b).slice(6)}` : `${s(a)} – ${s(b)}` }
const windowLabel = (c: { from?: string | null; to?: string | null }) => !c.from && !c.to ? 'always' : `${c.from ? `since ${day(c.from)}` : 'until'}${c.to ? `${c.from ? ' until' : ''} ${day(c.to)}` : ''} UTC`
/** datetime-local works in local time; logs are UTC, so the inputs are read and shown as UTC. */
const toInput = (iso: string | null | undefined) => iso ? iso.slice(0, 16) : ''
const fromInput = (value: string) => value ? `${value}:00Z` : null
const MARKABLE = /credential|secret|token|key|certificate|service principal|application|managed identity|user|account|\bip\b|address|device|host/i

export const EFFECT_SHORT: Record<Effect, string> = { secret: 'Secrets exposed', delete: 'Deleted', write: 'Changed', read: 'Read', auth: 'Signed in', attempt: 'Attempted', other: 'Touched' }

/** Mark an entity compromised, change its window or clear it; shown in the inspector and in the impact view. */
export function CompromiseForm({ entity, data, onCommand, onDone, compact, initialFrom }: { entity: Entity; data: Pick<GraphData, 'entities' | 'facts'>; onCommand: Command; onDone?: () => void; compact?: boolean; initialFrom?: string }) {
  const marked = compromiseOf(entity)
  const current = marked && !marked.cleared ? marked : null
  const infrastructure = INFRASTRUCTURE.test(entity.kind)
  const firstUse = useMemo(() => infrastructure ? firstUseOf(data, entity.id) : null, [infrastructure, data, entity.id])
  // A new mark of an IP starts at its first proven use of a credential: before that it may have served someone else.
  const [from, setFrom] = useState(toInput(current ? current.from : initialFrom ?? firstUse))
  const [to, setTo] = useState(toInput(current?.to))
  const [note, setNote] = useState(current?.note ?? '')
  const [level, setLevel] = useState<'suspected' | 'confirmed'>(current ? current.level ?? 'confirmed' : 'suspected')
  const [error, setError] = useState('')
  const save = () => {
    const payload = { from: fromInput(from), to: fromInput(to), note: note.trim(), level }
    if (payload.from && payload.to && payload.from > payload.to) { setError('Until must be after since'); return }
    void onCommand([{ type: 'entity.update', payload: { id: entity.id, compromise: payload } }]).then(() => onDone?.()).catch(problem => setError(String(problem)))
  }
  return <form className={`compromise-form${compact ? ' compact' : ''}`} onSubmit={event => { event.preventDefault(); save() }}>
    <div className="segmented level-choice" role="group" aria-label="How sure">
      <button type="button" className={level === 'suspected' ? 'active' : ''} aria-pressed={level === 'suspected'} onClick={() => setLevel('suspected')}>Suspected</button>
      <button type="button" className={level === 'confirmed' ? 'active' : ''} aria-pressed={level === 'confirmed'} onClick={() => setLevel('confirmed')}>Confirmed</button></div>
    <div className="field-grid">
      <label>Since (UTC)<input type="datetime-local" value={from} onChange={e => setFrom(e.target.value)} aria-label={`Compromised since, ${entity.name}`} /></label>
      <label>Until (UTC, optional)<input type="datetime-local" value={to} onChange={e => setTo(e.target.value)} aria-label={`Compromised until, ${entity.name}`} /></label>
    </div>
    {!compact && <label>Note<input value={note} onChange={e => setNote(e.target.value)} placeholder="How it was compromised, ticket…" /></label>}
    {infrastructure ? <p className="hint">{firstUse ? <>Its first successful use of a credential or identity was <b>{firstUse.slice(0, 16).replace('T', ' ')} UTC</b>{from !== toInput(firstUse) && <> · <button type="button" className="text-button" onClick={() => setFrom(toInput(firstUse))}>use it</button></>}. </> : null}Activity before since is not counted as the attacker's. Leave it empty only if everything this IP ever did was the attacker's.</p>
      : <p className="hint">Since: when it was stolen or first misused, as far as the evidence shows. Without it, all its activity counts as the attacker's.</p>}
    {error && <p className="form-error">{error}</p>}
    <div className="form-actions">
      {onDone && <button type="button" className="secondary-button small" onClick={onDone}>Cancel</button>}
      <button className="primary-button small danger-fill"><ShieldAlert size={13} /> {current ? 'Save' : level === 'suspected' ? 'Mark suspected' : 'Mark compromised'}</button>
    </div>
  </form>
}

/** An IP marked without a start counts everything it ever did; offer to start at its first proven use instead. */
function OpenStart({ entity, data, onCommand }: { entity: Entity; data: Pick<GraphData, 'entities' | 'facts'>; onCommand: Command }) {
  const c = compromiseOf(entity)
  const open = !!c && !c.cleared && !c.from && INFRASTRUCTURE.test(entity.kind)
  const firstUse = useMemo(() => open ? firstUseOf(data, entity.id) : null, [open, data, entity.id])
  const earlier = useMemo(() => firstUse ? activityBefore(data, entity.id, firstUse) : 0, [firstUse, data, entity.id])
  if (!open || !firstUse || !earlier) return null
  return <span className="compromise-scope"><AlertTriangle size={12} /><span>No start: <b>{earlier.toLocaleString('en')}</b> earlier {earlier === 1 ? 'item counts' : 'items count'} as attacker activity, before its first use of a credential ({compact(firstUse, null)} UTC).</span>
    <button className="text-button" onClick={() => void onCommand([{ type: 'entity.update', payload: { id: entity.id, compromise: { ...c!, from: firstUse } } }]).catch(() => {})}>Start there</button></span>
}

const confirmDerived = (entity: Entity, derived: NonNullable<Seed['derived']>, via: string): ActionDraft =>
  ({ type: 'entity.update', payload: { id: entity.id, compromise: { from: derived.at, to: null, level: 'confirmed', note: `Used from ${via} on ${day(derived.at)} (derived, confirmed)` } } })
const notCompromised = (entity: Entity, note = 'Known good (legitimate)'): ActionDraft => ({ type: 'entity.update', payload: { id: entity.id, compromise: { cleared: true, note } } })

/** Who took part, by what they are: IPs, credentials, identities. */
function byKind(ids: string[], data: GraphData) {
  const kinds = new Map(data.entities.map(e => [e.id, e.kind]))
  const of = (pattern: RegExp) => ids.filter(id => pattern.test(kinds.get(id) ?? ''))
  return { ips: of(/\bip\b/i), credentials: of(/credential|secret|token|certificate|key/i), identities: of(/service principal|application|managed identity|user|account/i) }
}
const list = (ids: string[], nameOf: (id: string) => string, max = 3) => ids.slice(0, max).map(nameOf).join(', ') + (ids.length > max ? ` +${ids.length - max}` : '')

/** The evidence item an attacker activity is shown with: its latest one inside the window. */
export const latestItem = (attack: AttackFact): Assertion | undefined =>
  attack.fact.assertions.filter(a => !a.retracted_at && a.valid_from && (!attack.last || a.valid_from <= attack.last)).sort((a, b) => (b.valid_from ?? '').localeCompare(a.valid_from ?? ''))[0]

/** Attacker activities an entity took part in, latest first: when, what, with whom, and the original row in KQL. */
function AttackEvents({ entity, impact, data, nameOf, onCopy, onOpenEvidence }: { entity: Entity; impact: Impact; data: GraphData; nameOf: (id: string) => string; onCopy: (value: string, label: string) => void; onOpenEvidence: (id: string) => void }) {
  const [all, setAll] = useState(false)
  // Most important first: what reached secrets or changed things, then the rest; likely regular and failed attempts last.
  const rank = (a: AttackFact) => (a.before ? 20 : 0) + EFFECTS.indexOf(a.effect)
  const events = [...impact.facts.values()].filter(a => (a.fact.participants?.length ? a.fact.participants.some(p => p.entity_id === entity.id) : a.fact.subject_id === entity.id || a.fact.object_id === entity.id))
    .sort((a, b) => rank(a) - rank(b) || (b.last ?? '').localeCompare(a.last ?? ''))
  if (!events.length) return null
  const regular = events.filter(a => a.before).length
  // Neutral heading: inside the window is not the same as the attacker's; the rating per activity says which it likely is.
  return <div className="attack-events"><h4>In the compromise window <b>{events.length}</b></h4>
    <p className="rating-legend"><span className="effect-badge secret">likely attacker</span> {events.length - regular} · <span className="effect-badge other">likely regular</span> {regular} <small>(happened exactly so before the compromise too)</small></p>
    {events.slice(0, all ? 100 : 6).map((attack, i, shown) => {
      const heading = i === 0 || !!shown[i - 1].before !== !!attack.before ? <h5 key={`h-${attack.fact.id}`} className="rating-head">{attack.before ? 'Likely regular' : 'Likely the attacker'}</h5> : null
      const item = latestItem(attack); const query = item ? evidenceQuery(item, data.sources) : null
      const parts = (attack.fact.participants ?? []).filter(p => p.entity_id !== entity.id)
      const k = byKind(parts.filter(p => p.role !== 'target').map(p => p.entity_id), data)
      const targets = parts.filter(p => p.role === 'target').map(p => p.entity_id)
      return <Fragment key={attack.fact.id}>{heading}<div className={`attack-event${attack.before ? ' regular' : ''}`}>
        <div className="attack-event-head"><span className="step-time">{compact(attack.first, attack.last)}</span><span className={`effect-badge ${attack.before ? 'other' : attack.effect}`}>{attack.before ? 'Likely regular' : EFFECT_SHORT[attack.effect]}</span><b>{attack.count}×</b></div>
        <strong>{attack.fact.predicate}</strong>
        <dl className="impact-fields">
          {k.identities.length > 0 && <><dt>As</dt><dd>{list(k.identities, nameOf)}</dd></>}
          {k.credentials.length > 0 && <><dt>Credential</dt><dd>{list(k.credentials, nameOf)}</dd></>}
          {k.ips.length > 0 && <><dt>From</dt><dd>{list(k.ips, nameOf)}</dd></>}
          {targets.length > 0 && <><dt>On</dt><dd>{list(targets, nameOf)}</dd></>}
          {attack.before > 0 && <><dt>Before</dt><dd className="regular-hint">{attack.before}× exactly so before the compromise</dd></>}
        </dl>
        <div className="attack-event-actions">
          {item && <button className="text-button" onClick={() => onOpenEvidence(item.id)}>Evidence</button>}
          {query && <button className="text-button" title="KQL that returns the original row from its table" onClick={() => onCopy(query, 'KQL for the original row')}><Copy size={11} /> KQL</button>}
        </div>
      </div></Fragment> })}
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
      <ShieldAlert size={15} /><div><strong>{current.level === 'suspected' ? 'Suspected compromised' : 'Compromised'}</strong><span>{windowLabel(current)}{current.note ? ` · ${current.note}` : ''}</span>
        <OpenStart entity={entity} data={data} onCommand={onCommand} />
        <small>Marked by {current.by ?? 'someone'}{current.via === 'REST' || current.via === 'MCP' ? <b className="warn-text"> (agent, via {current.via})</b> : null}{current.at ? ` on ${day(current.at)}` : ''}</small></div>
      <div className="callout-actions">{current.level === 'suspected' && <button className="text-button" onClick={() => void onCommand([{ type: 'entity.update', payload: { id: entity.id, compromise: { ...current, level: 'confirmed' } } }]).catch(() => {})}>Confirm</button>}<button className="text-button" onClick={() => setEditing(true)}>Edit</button>
        <button className="text-button" onClick={() => void onCommand([{ type: 'entity.update', payload: { id: entity.id, compromise: null } }]).catch(() => {})}>Clear</button></div>
    </div>}
    {derived && !editing && <div className="impact-callout compromised derived">
      <ShieldAlert size={15} /><div><strong>{impact?.seeds.find(x => x.entity.id === entity.id)?.suspected ? 'Suspected (derived)' : 'Compromised (derived)'}</strong>
        <dl className="impact-fields"><dt>Since</dt><dd>no later than {day(derived.at)} UTC</dd><dt>Because</dt><dd>{derived.reason === 'session' ? `it used the attacker's session token after ${nameOf(derived.via)}` : `it was used successfully from ${nameOf(derived.via)}`}</dd>
          <dt>Means</dt><dd>{derived.reason === 'session' ? 'a redirector, proxy or second exit of the attacker' : 'it may have been stolen earlier; confirm it or mark it good'}</dd></dl></div>
      <div className="callout-actions"><button className="text-button" onClick={() => void onCommand([confirmDerived(entity, derived, nameOf(derived.via))]).catch(() => {})}>Confirm</button>
        <button className="text-button" onClick={() => void onCommand([notCompromised(entity)]).catch(() => {})} title="Known legitimate: never derived, and what runs from it is not attacker activity">Good</button></div>
    </div>}
    {cleared && !editing && <div className="impact-callout cleared">
      <Check size={15} /><div><strong>Good (legitimate)</strong><span>{cleared.note || 'Known legitimate'}: never derived as compromised; what runs from it is not counted as attacker activity.</span><small>By {cleared.by ?? 'someone'}{cleared.at ? ` on ${day(cleared.at)}` : ''}</small></div>
      <div className="callout-actions"><button className="text-button" onClick={() => void onCommand([{ type: 'entity.update', payload: { id: entity.id, compromise: null } }]).catch(() => {})}>Undo</button></div>
    </div>}
    {editing && <CompromiseForm entity={entity} data={data} onCommand={onCommand} onDone={() => setEditing(false)} />}
    {!current && !derived && !editing && pivot && <div className={`impact-callout ${pivot.before ? 'cleared' : 'pivot'}`}>
      {pivot.before ? <Check size={15} /> : <Route size={15} />}<div><strong>{pivot.before ? 'Likely regular' : 'New since the compromise'}</strong>
        <dl className="impact-fields"><dt>Role</dt><dd>{pivot.roles.join(', ')}</dd><dt>With</dt><dd>{pivot.seeds.map(nameOf).join(', ')}</dd><dt>Events</dt><dd>{pivot.count} · {span(pivot.first, pivot.last)} UTC</dd><dt>Before</dt><dd>{pivot.before ? `${pivot.before}× before the compromise` : 'never'}</dd></dl>
        <small>{pivot.before ? `Already used with it ${pivot.before}× before the compromise. Using a stolen credential does not make an IP the attacker's: this is most likely the legitimate owner.` : 'Never seen with it before the compromise: a candidate for the attacker. Check its other activity before marking it.'}</small></div>
    </div>}
    {trace && <div className="trace-mini"><span><b>First attacker use</b> {compact(trace.at, null)} UTC{trace.via ? ` from ${nameOf(trace.via)}` : ''}</span>
      {trace.exposedBy.length > 0 ? <><small>Possible origin, by timing only (not proven)</small><ul>{trace.exposedBy.map((step, i) => <li key={i}><b>{step.operation}</b> by {step.seeds.map(nameOf).join(', ')} <span className="muted">({compact(step.first, step.last)}, {gapText(step.last ?? step.first ?? trace.at, trace.at)} before)</span></li>)}</ul></>
        : <small>Nothing on the board explains how it was obtained: hunt before this time (Impact → Hunt next).</small>}</div>}
    {impacted && <div className={`impact-callout impacted ${impacted.regular ? 'regular' : impacted.effect}`}>
      {impacted.regular ? <Check size={15} /> : <AlertTriangle size={15} />}<div><strong>{impacted.regular ? `Likely regular · ${EFFECT_LABEL[impacted.effect].toLowerCase()}` : EFFECT_LABEL[impacted.effect]}</strong>
        {(() => { const k = byKind(impacted.actors, data); return <dl className="impact-fields">
          <dt>Operations</dt><dd>{impacted.operations.slice(0, 4).map(o => `${o.operation} ×${o.count}`).join(' · ')}</dd>
          <dt>When</dt><dd>{span(impacted.first, impacted.last)} UTC</dd>
          {k.identities.length > 0 && <><dt>By</dt><dd>{list(k.identities, nameOf)}</dd></>}
          {k.credentials.length > 0 && <><dt>Credential</dt><dd>{list(k.credentials, nameOf, 4)}</dd></>}
          {k.ips.length > 0 && <><dt>From</dt><dd>{list(k.ips, nameOf)}</dd></>}
          <dt>Baseline</dt><dd>{impacted.regular ? 'every activity also happened exactly so before the compromise' : impacted.routine ? `same operation ${impacted.routine}× before the compromise, from other sources` : 'nothing like it before the compromise'}</dd>
        </dl> })()}</div>
    </div>}
    {about.map(a => <div key={a.id} className={`advice compact ${a.severity}`}><div className="advice-head"><span className={`advice-level ${a.severity}`}>{a.severity === 'high' ? 'Act' : a.severity === 'medium' ? 'Check' : 'Note'}</span><strong>{a.title}</strong></div><p>{a.detail}</p>
      {a.mark?.includes(entity.id) && !current && <button className="secondary-button small danger-outline" onClick={() => void onCommand([{ type: 'entity.update', payload: { id: entity.id, compromise: { from: defaultSince(data, entity), to: null, level: 'suspected', note: `From advice: ${a.title}` } } }]).catch(() => {})}><ShieldAlert size={12} /> Mark suspected</button>}</div>)}
    {impact && <AttackEvents entity={entity} impact={impact} data={data} nameOf={nameOf} onCopy={onCopy} onOpenEvidence={onOpenEvidence} />}
    {rotation.length > 0 && <div className="rotation-mini">{rotation.map(item => <div key={item.id} className={`rotation-line${item.stale ? ' stale' : ''}`}>
      <KeyRound size={13} /><span>{item.title}{item.stale && <b> · attacker active after rotation</b>}</span></div>)}
      <button className="secondary-button small" onClick={() => setRotated(rotatedAt && !rotation.some(r => r.stale) ? null : new Date().toISOString())}>
        <Check size={13} /> {rotatedAt && !rotation.some(r => r.stale) ? `Rotated ${day(rotatedAt)} · undo` : 'Mark rotated now'}</button></div>}
    {!current && !derived && !editing && <div className="compromise-actions">
      <button className="secondary-button small danger-outline" onClick={() => setEditing(true)}><ShieldAlert size={13} /> Mark compromised…</button>
      {!cleared && <button className="secondary-button small good-outline" onClick={() => void onCommand([notCompromised(entity)]).catch(() => {})} title="Known legitimate: never derived, and what runs from it is not attacker activity"><Check size={13} /> Good</button>}
      {impact && impact.seeds.length > 0 && <button className="text-button" onClick={onOpenImpact}>Attack impact</button>}
    </div>}
  </div>
}

/** Opens and scrolls to an impact section, from the numbers at the top. */
const jumpTo = (id: string) => { window.dispatchEvent(new CustomEvent('impact-open', { detail: id })); window.setTimeout(() => document.getElementById(`impact-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 30) }

function Block({ title, count, icon, action, children, open: initial = true, id }: { title: string; count?: number; icon: ReactNode; action?: ReactNode; children: ReactNode; open?: boolean; id?: string }) {
  const [open, setOpen] = useState(initial)
  useEffect(() => {
    if (!id) return
    const listener = (event: Event) => { if ((event as CustomEvent).detail === id) setOpen(true) }
    window.addEventListener('impact-open', listener)
    return () => window.removeEventListener('impact-open', listener)
  }, [id])
  return <section className="impact-block" id={id ? `impact-${id}` : undefined}>
    <header><button className="impact-block-toggle" onClick={() => setOpen(!open)} aria-expanded={open}>{open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}{icon}<h3>{title}</h3>{count !== undefined && <b>{count.toLocaleString('en')}</b>}</button>{action}</header>
    {open && <div className="impact-block-body">{children}</div>}
  </section>
}

/** Text with the names of the entities it is about in bold, so the eye finds them first. */
function Emphasized({ text, names }: { text: string; names: string[] }) {
  const wanted = [...new Set(names.filter(n => n && n.length > 2))].sort((a, b) => b.length - a.length).slice(0, 12)
  if (!wanted.length) return <>{text}</>
  const pattern = new RegExp(`(${wanted.map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'g')
  return <>{text.split(pattern).map((part, i) => wanted.includes(part) ? <b key={i}>{part}</b> : part)}</>
}

/** One recommendation with the evidence it rests on and what to do about it. */
function AdviceCard({ advice, nameOf, onShow, onShowFact, onMark, onGood, onConfirm, query, onCopy }: { advice: Advice; nameOf: (id: string) => string; onShow: (id: string) => void; onShowFact: (id: string) => void
  onMark: (id: string, note: string) => void; onGood: (id: string) => void; onConfirm: (ids: string[]) => void; query?: HuntQuery; onCopy: (value: string, label: string) => void }) {
  return <div className={`advice ${advice.severity}`}>
    <div className="advice-head"><span className={`advice-level ${advice.severity}`}>{advice.severity === 'high' ? 'Act' : advice.severity === 'medium' ? 'Check' : 'Note'}</span><strong>{advice.title}</strong></div>
    <p><Emphasized text={advice.detail} names={[...advice.entities, ...(advice.mark ?? [])].map(nameOf)} /></p>
    <div className="advice-actions">
      {advice.entities.slice(0, 6).map(id => <button key={id} className="entity-chip" onClick={() => onShow(id)}>{nameOf(id)}</button>)}
      {(advice.mark ?? []).slice(0, 4).map(id => <span key={`m${id}`} className="advice-pair"><button className="secondary-button small danger-outline" onClick={() => onMark(id, advice.title)}><ShieldAlert size={12} /> Mark {nameOf(id)}</button>
        <button className="secondary-button small good-outline" onClick={() => onGood(id)} title={`${nameOf(id)} is known legitimate`}>Good</button></span>)}
      {advice.confirm?.length ? <button className="secondary-button small" onClick={() => onConfirm(advice.confirm!)}><Check size={12} /> Confirm all</button> : null}
      {advice.facts?.[0] && <button className="text-button" onClick={() => onShowFact(advice.facts![0])}><Crosshair size={12} /> Evidence</button>}
      {query && <button className="text-button" onClick={() => onCopy(query.query, `KQL: ${query.title}`)}><Copy size={12} /> KQL</button>}
    </div>
  </div>
}

/** Impacted resources of one type: a header with what happened to them, the rows on demand. */
function KindSection({ kind, items, chip, open: initial }: { kind: string; items: Impact['impacted']; chip: (id: string) => ReactNode; open: boolean }) {
  const [open, setOpen] = useState(initial)
  const [limit, setLimit] = useState(30)
  const effects = EFFECTS.map(e => [e, items.filter(i => i.effect === e && !i.regular).length] as const).filter(([, n]) => n)
  const regular = items.filter(i => i.regular).length
  return <div className="kind-section">
    <button className="kind-section-head" onClick={() => setOpen(!open)} aria-expanded={open}>{open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}<strong>{items.length} {kind}</strong>
      {effects.map(([e, n]) => <span key={e} className={`effect-badge ${e}`}>{n} {EFFECT_SHORT[e].toLowerCase()}</span>)}{regular > 0 && <span className="pivot-tag">{regular} likely regular</span>}</button>
    {open && <div className="impact-list">{items.slice(0, limit).map(i => <div key={i.entity.id} className={`impact-row impacted ${i.effect}${i.regular ? ' regular' : ''}`}>
      <div className="impact-row-main">{chip(i.entity.id)}<span className={`effect-badge ${i.regular ? 'other' : i.effect}`}>{i.regular ? 'likely regular' : EFFECT_SHORT[i.effect]}</span>
        {!i.regular && i.routine > 0 && <span className="pivot-tag" title="The identity did the same operation here before the compromise, from other sources">routine · new source</span>}
        <small className="muted">{i.operations.slice(0, 3).map(o => `${o.operation} ×${o.count}`).join(' · ')} · last {day(i.last)}</small></div>
    </div>)}
      {items.length > limit && <button className="text-button" onClick={() => setLimit(limit + 100)}>Show {Math.min(100, items.length - limit)} more of {items.length - limit}</button>}</div>}
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
  const [openStep, setOpenStep] = useState<number | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const [needle, setNeedle] = useState('')
  const [pivotLimit, setPivotLimit] = useState(15)
  const cleared = useMemo(() => data.entities.filter(e => compromiseOf(e)?.cleared), [data.entities])
  const trace = useMemo(() => traceBack(impact), [impact])
  // Good and likely-regular entities that are in no group yet: one collapsed group keeps them out of the way.
  const harmless = useMemo(() => {
    const grouped = new Set((data.groups ?? []).flatMap(g => g.member_ids))
    return [...new Set([...data.entities.filter(e => compromiseOf(e)?.cleared).map(e => e.id), ...impact.impacted.filter(i => i.regular).map(i => i.entity.id)])].filter(id => !grouped.has(id))
  }, [data.entities, data.groups, impact])
  const groupHarmless = () => void onCommand([{ type: 'group.add', payload: { id: crypto.randomUUID(), name: `${harmless.length} harmless · good or likely regular`, members: harmless, rule: null, excluded: [], collapsed: true } }]).catch(() => {})
  const advice = useMemo(() => adviceFor(data, impact), [data, impact])
  const summary = useMemo(() => impact.seeds.length ? caseSummary(data, impact) : null, [data, impact])
  const starts = useMemo(() => impact.seeds.length ? [] : startingPoints(data), [data, impact])
  const [adviceLimit, setAdviceLimit] = useState({ high: 5, medium: 3, info: 0 })
  const providers = useMemo(() => impact.pivots.length ? networkProviders(data, impact) : null, [data, impact])
  const pivotList = useMemo(() => {
    const usual = (id: string, seeds: string[]) => { const asn = providers?.ipAsn.get(id); return !!asn && seeds.some(s => providers!.before.get(s)?.has(asn)) }
    // Locations are attributes of IPs (shown as flags), not candidates; new providers before rotating cloud egress.
    return impact.pivots.filter(p => !/^location$/i.test(p.entity.kind)).map(p => ({ ...p, asn: providers?.ipAsn.get(p.entity.id), usual: usual(p.entity.id, p.seeds) }))
      .sort((a, b) => Number(a.before > 0) - Number(b.before > 0) || Number(a.usual) - Number(b.usual) || b.count - a.count)
  }, [impact, providers])
  const sessions = useMemo(() => attackSessions(data, impact), [data, impact])
  const confirmAll = (ids: string[]) => void onCommand(ids.map(id => { const seed = impact.seeds.find(x => x.entity.id === id)!; return confirmDerived(seed.entity, seed.derived!, nameOf(seed.derived!.via)) })).catch(() => {})
  const sinceOf = (id: string) => { const e = byId.get(id); return e ? defaultSince(data, e) : null }
  const markWith = (id: string, note: string) => void onCommand([{ type: 'entity.update', payload: { id, compromise: { from: sinceOf(id), to: null, level: 'suspected', note: `From advice: ${note}` } } }]).catch(() => {})
  /** "ci-reader" or "41 IP · 2 Location" for the partners of a step. */
  const withSummary = (ids: string[]) => {
    if (ids.length <= 2) return ids.map(nameOf).join(', ')
    const kinds = new Map<string, number>()
    for (const id of ids) { const kind = byId.get(id)?.kind ?? '?'; kinds.set(kind, (kinds.get(kind) ?? 0) + 1) }
    return [...kinds].sort((a, b) => b[1] - a[1]).map(([kind, n]) => `${n} ${kind}`).join(' · ')
  }
  const chip = (id: string) => <button key={id} className="entity-chip" onClick={() => onShow(id)} title={`Show ${nameOf(id)} in the graph`}>{nameOf(id)}</button>
  const mark = (id: string) => void onCommand([{ type: 'entity.update', payload: { id, compromise: { from: sinceOf(id), to: null, level: 'suspected', note: 'Pivot from the impact view' } } }]).catch(() => {})
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
        {harmless.length >= 2 && <button className="secondary-button small" onClick={groupHarmless} title="Collapse everything marked good or likely regular into one group"><Check size={13} /> Group {harmless.length} harmless</button>}
        <button className="secondary-button small" onClick={() => onCopy(impactMarkdown(impact, nameOf, queries), 'Impact report (Markdown)')}><Copy size={13} /> Copy report</button></div>}
    </header>

    {impact.seeds.length > 0 && <div className="impact-summary">
      <button className="impact-stat compromised" onClick={() => jumpTo('compromised')} title="Entities marked or derived as compromised: open the list"><b>{impact.seeds.length}</b><span>entities compromised{impact.seeds.some(x => x.suspected) ? ` · ${impact.seeds.filter(x => x.suspected).length} only suspected` : ''}{impact.seeds.some(x => x.derived) ? ` · ${impact.seeds.filter(x => x.derived).length} derived` : ''}</span></button>
      <button className="impact-stat" onClick={() => jumpTo('steps')} title="Evidence items (original log rows) inside the compromise windows, driven by a compromised entity"><b>{[...impact.facts.values()].reduce((n, f) => n + f.count, 0).toLocaleString('en')}</b><span>evidence items in the window · {impact.facts.size.toLocaleString('en')} activities</span></button>
      <button className="impact-stat impacted" onClick={() => jumpTo('impacted')} title="Resources that were the target of such an activity. A secret-read operation means the secrets were reachable: possible exposure, not proof which ones were read."><b>{impact.impacted.length.toLocaleString('en')}</b><span>resources reached · {secretCount.toLocaleString('en')} with a secret-read operation (possible exposure)</span></button>
      <button className="impact-stat rotate" onClick={() => jumpTo('rotate')} title="Measures not yet done or to repeat (attacker active after the rotation)"><b>{open}</b><span>measures open of {impact.rotation.length} (rotate, revoke, block)</span></button>
      <div className="impact-stat"><b className="small-stat">{span(impact.first, impact.last)}</b><span>attacker activity (UTC)</span></div>
    </div>}

    {summary && <section className="case-summary" aria-label="Case summary">
      <div className="case-col known"><h3>Known</h3>{summary.known.length ? <ul>{summary.known.map((line, i) => <li key={i}>{line}</li>)}</ul> : <p className="muted small">Nothing confirmed yet.</p>}</div>
      <div className="case-col suspected"><h3>Suspected</h3>{summary.suspected.length ? <ul>{summary.suspected.map((line, i) => <li key={i}>{line}</li>)}</ul> : <p className="muted small">Nothing open.</p>}</div>
      <div className="case-col gaps"><h3>Missing evidence</h3>{summary.gaps.length ? <ul>{summary.gaps.map((gap, i) => { const q = queries.find(x => x.id === gap.query); return <li key={i}><b>{gap.question}</b> <span className="muted">{gap.why}</span>
        {q && <button className="text-button" onClick={() => onCopy(q.query, `KQL: ${q.title}`)}><Copy size={11} /> KQL</button>}</li> })}</ul> : <p className="muted small">No open questions.</p>}</div>
    </section>}

    {!impact.seeds.length && starts.length > 0 && <Block title="Where to start" count={starts.length} icon={<Lightbulb size={14} />}>
      <p className="hint">Nothing is marked yet. These patterns in the evidence usually mean an attack; mark what you suspect, the analysis follows from it and stays labelled as suspected until you confirm.</p>
      {starts.map(point => <div key={point.id} className="advice medium">
        <div className="advice-head"><span className="advice-level medium">Check</span><strong>{point.title}</strong></div>
        <p><Emphasized text={point.detail} names={point.entities.map(nameOf)} /></p>
        <div className="advice-actions">{point.entities.slice(0, 5).map(id => <button key={id} className="entity-chip" onClick={() => onShow(id)}>{nameOf(id)}</button>)}
          {point.mark.slice(0, 3).map(id => <button key={`m${id}`} className="secondary-button small danger-outline" onClick={() => markWith(id, point.title)}><ShieldAlert size={12} /> Suspect {nameOf(id)}</button>)}
          <button className="text-button" onClick={() => onShowFact(point.fact)}><Crosshair size={12} /> Evidence</button></div>
      </div>)}
    </Block>}

    {advice.length > 0 && <Block title="Advice" count={advice.length} icon={<Lightbulb size={14} />}>
      <p className="hint">What the evidence on this board suggests, most important first. Each advice names what it rests on.</p>
      {(['high', 'medium', 'info'] as const).map(level => { const list = advice.filter(a => a.severity === level); const limit = adviceLimit[level]; return list.length ? <div key={level} className="advice-group">
        <h4 className={`advice-group-head ${level}`}>{level === 'high' ? 'Act now' : level === 'medium' ? 'Check' : 'Good to know'} <b>{list.length}</b></h4>
        {list.slice(0, limit).map(a => <AdviceCard key={a.id} advice={a} nameOf={nameOf} onShow={onShow} onShowFact={onShowFact} onMark={markWith} onGood={id => { const e = byId.get(id); if (e) void onCommand([notCompromised(e)]).catch(() => {}) }} onConfirm={confirmAll} query={queries.find(q => q.id === a.query)} onCopy={onCopy} />)}
        {list.length > limit && <button className="text-button" onClick={() => setAdviceLimit({ ...adviceLimit, [level]: limit + 20 })}>Show {list.length - limit} more</button>}
      </div> : null })}
    </Block>}

    <Block id="compromised" title="Compromised" count={impact.seeds.length} icon={<ShieldAlert size={14} />}>
      {impact.seeds.some(x => x.derived) && <h4 className="sub-head">Marked <b>{impact.seeds.filter(x => !x.derived).length}</b></h4>}
      {impact.seeds.filter(s => !s.derived).map(({ entity }) => { const c = compromiseOf(entity)!; return <div key={entity.id} className="impact-row seed">
        <div className="impact-row-main">{chip(entity.id)}<span className="kind-label">{entity.kind}</span>
          {c.level === 'suspected' && <span className="pivot-tag new">suspected</span>}{(c.via === 'REST' || c.via === 'MCP') && <span className="pivot-tag" title={`Marked by ${c.by ?? 'an agent'} through ${c.via}`}>by agent</span>}<span className="impact-window">{windowLabel(c)}</span>{c.note && <small className="muted">{c.note}</small>}
          <OpenStart entity={entity} data={data} onCommand={onCommand} /></div>
        <div className="row-actions">{c.level === 'suspected' && <button className="text-button" onClick={() => void onCommand([{ type: 'entity.update', payload: { id: entity.id, compromise: { ...c, level: 'confirmed' } } }]).catch(() => {})}>Confirm</button>}<button className="text-button" onClick={() => setEditing(editing === entity.id ? null : entity.id)}>Window</button>
          <button className="icon-button" aria-label={`Clear compromise of ${entity.name}`} title="No longer compromised" onClick={() => void onCommand([{ type: 'entity.update', payload: { id: entity.id, compromise: null } }]).catch(() => {})}><X size={14} /></button></div>
        {editing === entity.id && <CompromiseForm entity={entity} data={data} onCommand={onCommand} onDone={() => setEditing(null)} compact />}
      </div> })}
      {impact.seeds.some(x => x.derived) && <h4 className="sub-head">Derived from the evidence <b>{impact.seeds.filter(x => x.derived).length}</b>
        <button className="text-button" onClick={() => confirmAll(impact.seeds.filter(x => x.derived).map(x => x.entity.id))}><Check size={12} /> Confirm all</button></h4>}
      {impact.seeds.filter(s => s.derived).map(({ entity, derived }) => <div key={entity.id} className="impact-row seed derived">
        <div className="impact-row-main">{chip(entity.id)}<span className="kind-label">{entity.kind}</span><span className="pivot-tag new">derived</span>
          <span className="impact-window">no later than {day(derived!.at)} UTC</span><small className="muted">{derived!.reason === 'session' ? `used the same session token as ${nameOf(derived!.via)} after it: holds the attacker's session` : `used successfully from ${nameOf(derived!.via)}; may have been stolen earlier`}</small></div>
        <div className="row-actions"><button className="text-button" onClick={() => onShowFact(derived!.fact)}>Evidence</button>
          <button className="text-button" onClick={() => void onCommand([confirmDerived(entity, derived!, nameOf(derived!.via))]).catch(() => {})}>Confirm</button>
          <button className="text-button" onClick={() => void onCommand([notCompromised(entity)]).catch(() => {})} title="Known legitimate: never derived, and what runs from it is not attacker activity">Good</button></div>
      </div>)}
      {cleared.length > 0 && <p className="hint cleared-line">Good (legitimate): {cleared.map(e => <span key={e.id} className="cleared-chip">{chip(e.id)}<button className="text-button" onClick={() => void onCommand([{ type: 'entity.update', payload: { id: e.id, compromise: null } }]).catch(() => {})}>undo</button></span>)}</p>}
      <div className="impact-search"><Search size={14} /><input value={needle} onChange={e => setNeedle(e.target.value)} placeholder="Mark compromised: search a credential, IP, identity…" aria-label="Find entity to mark compromised" /></div>
      {candidates.map(e => <div key={e.id} className="impact-row candidate"><div className="impact-row-main">{chip(e.id)}<span className="kind-label">{e.kind}</span></div>
        <div className="row-actions"><button className="secondary-button small danger-outline" onClick={() => { setEditing(e.id); setNeedle('') }}>Mark compromised…</button></div></div>)}
      {editing && !impact.seeds.some(s => s.entity.id === editing) && byId.get(editing) && <div className="impact-row"><div className="impact-row-main">{chip(editing)}</div>
        <CompromiseForm entity={byId.get(editing)!} data={data} onCommand={onCommand} onDone={() => setEditing(null)} /></div>}
      {!impact.seeds.length && <p className="muted small">Nothing is marked yet. Mark the stolen credential (since when?) or the attacker's IPs; everything below follows from that. You can also do it in the inspector of any entity.</p>}
    </Block>

    {impact.seeds.length > 0 && <>
      <Block title="Pivot next" count={pivotList.length} icon={<Route size={14} />}>
        <p className="hint">Identities, IPs and credentials that appeared together with what is compromised. <b>New since the compromise</b> is a candidate for the attacker. <b>Seen before</b> the compromise is most likely the legitimate owner: using a stolen credential does not make an IP the attacker's.</p>
        {pivotList.slice(0, pivotLimit).map(p => <div key={p.entity.id} className={`impact-row pivot${p.before || p.usual ? ' known' : ''}`}>
          <div className="impact-row-main">{chip(p.entity.id)}<span className="kind-label">{p.entity.kind}</span>
            <span className={`pivot-tag${p.before ? '' : ' new'}`}>{p.before ? `seen ${p.before}× before` : 'new since compromise'}</span>
            {p.asn && <span className={`pivot-tag${p.usual ? '' : ' new'}`} title={p.usual ? 'The compromised identity already used this network before the compromise: likely a rotating cloud or CI egress' : 'A network the compromised identity did not use before'}>{p.usual ? `usual provider AS${p.asn}` : `new provider AS${p.asn}`}</span>}
            <small className="muted">{p.roles.join(', ')} · {p.count}× with {p.seeds.map(nameOf).join(', ')} · {span(p.first, p.last)}</small></div>
          <div className="row-actions"><button className="secondary-button small good-outline" onClick={() => void onCommand([notCompromised(p.entity)]).catch(() => {})} title="Known legitimate">Good</button>{MARKABLE.test(p.entity.kind) ? <button className="secondary-button small danger-outline" onClick={() => mark(p.entity.id)} title="Its own activity becomes attacker activity too">Mark compromised</button>
            : <button className="text-button" onClick={() => onShow(p.entity.id)}>Show</button>}</div>
        </div>)}
        {pivotList.length > pivotLimit && <button className="text-button" onClick={() => setPivotLimit(pivotLimit + 50)}>Show {Math.min(50, pivotList.length - pivotLimit)} more of {pivotList.length - pivotLimit}</button>}
        {!impact.pivots.length && <p className="muted small">No other identities or IPs were involved.</p>}
      </Block>

      <Block title="Trace back: how it started" count={trace.length} icon={<Route size={14} />}>
        <p className="hint">When each compromised entity was first used by the attacker, earliest first, and which secrets other compromised entities had read before that. These are <b>candidates by timing</b>: the read happened earlier, nothing on the board shows the credential was among what was read.</p>
        <ol className="trace-list">{trace.map(t => <li key={t.entity.id} className="trace-entry">
          <span className="step-time">{day(t.at)}</span>
          <span className="trace-text">{chip(t.entity.id)}<span className="kind-label">{t.entity.kind}</span>{t.derived ? <span className="pivot-tag new">derived</span> : null}
            <span>first used by the attacker{t.via ? <> from {chip(t.via)}</> : null}</span>
            {t.exposedBy.length > 0 ? <small>possible origin, by timing only: {t.exposedBy.map((step, i) => <button key={i} className="text-button" onClick={() => onShowFact(step.facts[0])}>{step.operation} by {step.seeds.map(nameOf).join(', ')} ({span(step.first, step.last)}, {gapText(step.last ?? step.first ?? t.at, t.at)} before)</button>)}</small>
              : <small className="muted">nothing earlier on the board explains it</small>}</span>
        </li>)}</ol>
        {trace[0] && <p className="hint">Nothing before {day(trace[0].at)} UTC is on the board. To find the real start, run <b>Everything from the attacker's IPs</b> and <b>Where else was the stolen credential used</b> under Hunt next: they start two weeks earlier.</p>}
      </Block>

      {sessions.length > 0 && <Block title="Sessions the attacker worked in" count={sessions.length} icon={<KeyRound size={14} />} open={false}>
        <p className="hint">One session token (Entra UniqueTokenIdentifier, the uti claim) is one sign-in: everything done with it until it expires belongs to whoever holds it. A session used from more than one IP is a redirector or a stolen token.</p>
        {sessions.slice(0, 50).map(x => <div key={x.uti} className={`impact-row session${x.ips.length > 1 ? ' moved' : ''}`}>
          <div className="impact-row-main"><span className="step-time">{span(x.start, x.end)}</span>{x.identity && chip(x.identity)}
            <span className="kind-label">session {x.uti.slice(0, 10)}…</span>{x.ips.length > 1 && <span className="pivot-tag new">{x.ips.length} IPs</span>}
            <small className="muted">{x.uses} uses from {x.ips.map(nameOf).join(', ') || 'unknown IP'} · {x.operations.slice(0, 4).map(([op, count]) => `${op} ×${count}`).join(' · ')}</small></div>
          <div className="row-actions"><button className="text-button" onClick={() => onCopy(x.uti, 'Session token ID')}><Copy size={12} /> ID</button><button className="text-button" onClick={() => onShowFact(x.facts[0])}>Show</button></div>
        </div>)}
      </Block>}

      <Block id="steps" title="What the attacker did" count={impact.steps.length} icon={<Route size={14} />}>
        <ol className="attack-steps">{impact.steps.slice(0, 200).map((step, index) => <li key={index} className={`attack-step ${step.regular ? 'other' : step.effect}`}>
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

      <Block id="impacted" title="Impacted resources" count={impact.impacted.length} icon={<AlertTriangle size={14} />}>
        <div className="segmented" role="group" aria-label="Impact filter">
          <button className={effect === 'all' ? 'active' : ''} onClick={() => setEffect('all')}>All <b>{impact.impacted.length}</b></button>
          {EFFECTS.filter(e => counts.get(e)).map(e => <button key={e} className={effect === e ? 'active' : ''} onClick={() => setEffect(e)}>{EFFECT_SHORT[e]} <b>{counts.get(e)}</b></button>)}</div>
        {[...new Set(shown.map(i => i.entity.kind))].map(kind => { const list = shown.filter(i => i.entity.kind === kind); return <KindSection key={kind} kind={kind} items={list} chip={chip} open={shown.length <= 40} /> })}
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

      <Block id="rotate" title="Rotate, revoke, block" count={open} icon={<KeyRound size={14} />} action={<button className="text-button" onClick={() => onCopy(impact.rotation.map(r => `- [${r.rotatedAt && !r.stale ? 'x' : ' '}] ${r.category}: ${r.title} — ${r.detail}`).join('\n'), 'Rotation checklist')}><Copy size={12} /> Copy</button>}>
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
          <details className="query-details"><summary>Show query</summary><pre className="code-block">{q.query}</pre></details>
        </div>)}
      </Block>
    </>}
  </section>
}
