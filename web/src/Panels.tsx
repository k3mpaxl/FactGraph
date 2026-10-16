import { useEffect, useMemo, useRef, useState, type ReactNode, Fragment } from 'react'
import { Activity, ChevronDown, ChevronRight, Clock, Pause, Play, Search, SkipBack, SkipForward, X, Boxes, Zap } from 'lucide-react'
import { timelineSteps, timelineEvents, periodLabel } from './timeline'
import { type Selection } from './GraphView'
import { effectOf, type Impact } from './impact'
import { Sentence } from './Sentence'
import { type BoardAction } from './board'
import type { Entity, Fact, GraphData } from './types'
import { readPref, writePref, EntityAvatar, Kbd } from './ui'

export function actionLabel(action: BoardAction) {
  const names: Record<BoardAction['type'], string> = {
    'type.add': 'Type created',
    'type.update': 'Type edited',
    'type.delete': 'Type deleted',
    'board.rename': 'Board renamed',
    'entity.add': 'Entity created',
    'entity.update': 'Entity edited',
    'entity.position': 'Node moved',
    'entity.delete': 'Entity deleted',
    'entity.merge': 'Entities merged',
    'identifier.add': 'Identifier added',
    'identifier.delete': 'Identifier deleted',
    'source.add': 'Source created',
    'source.update': 'Source edited',
    'source.delete': 'Source deleted',
    'fact.add': 'Relationship created',
    'fact.update': 'Relationship edited',
    'fact.delete': 'Relationship deleted',
    'assertion.add': 'Evidence added',
    'assertion.update': 'Evidence edited',
    'assertion.retract': 'Evidence retracted',
    'assertion.delete': 'Evidence deleted',
    'action.undo': 'Change undone',
    'action.redo': 'Change restored',
    'assertion.restore': 'Evidence restored',
    'assertion.review': 'Evidence reviewed',
    'identifier.update': 'Identifier edited',
    'fact.position': 'Activity moved',
    'group.add': 'Group created',
    'group.update': 'Group changed',
    'group.delete': 'Group removed',
    'view.add': 'Perspective saved',
    'view.update': 'Perspective changed',
    'view.delete': 'Perspective deleted',
  }
  const subject =
    typeof action.payload.name === 'string'
      ? action.payload.name
      : typeof action.payload.title === 'string'
        ? action.payload.title
        : typeof action.payload.predicate === 'string'
          ? action.payload.predicate
          : ''
  return `${names[action.type]}${subject ? ` · ${subject}` : ''}`
}

export function TimelinePanel({
  data,
  facts,
  selection,
  onSelect,
  impact,
}: {
  data: GraphData
  facts: GraphData['facts']
  selection: Selection
  onSelect: (selection: Selection) => void
  impact: Impact | null
}) {
  const [showFailed, setShowFailed] = useState(() => readPref('showFailed') === 'true')
  const [attackOnly, setAttackOnly] = useState(false)
  const [limit, setLimit] = useState(300)
  // The same activity on one day is one row (time span and count): the time bar narrows it down further.
  const rows = useMemo(() => {
    // Attacker activity is decided per evidence item: the same activity before the compromise window is not the attacker's.
    const merged = new Map<
      string,
      { fact: Fact; day: string; first: string | null; last: string | null; count: number; refutes: boolean; attack: boolean }
    >()
    for (const entry of timelineEvents(facts)) {
      if (!showFailed && effectOf(entry.fact.predicate) === 'attempt') continue
      const hits = impact?.facts.get(entry.fact.id)?.hits
      const attack = !!hits && entry.assertions.some(a => hits.has(a.id))
      if (attackOnly && !attack) continue
      const day = entry.from ? entry.from.slice(0, 10) : 'undated'
      const key = `${day}|${entry.fact.id}|${attack ? 'a' : ''}`
      const row = merged.get(key) ?? {
        fact: entry.fact,
        day,
        first: entry.from,
        last: entry.to ?? entry.from,
        count: 0,
        refutes: false,
        attack,
      }
      row.count += entry.assertions.length
      if (entry.from && (!row.first || entry.from < row.first)) row.first = entry.from
      const end = entry.to ?? entry.from
      if (end && (!row.last || end > row.last)) row.last = end
      if (entry.assertions.some(a => a.stance === 'refutes')) row.refutes = true
      merged.set(key, row)
    }
    return [...merged.values()].sort((a, b) => (a.first ?? '9').localeCompare(b.first ?? '9'))
  }, [facts, showFailed, attackOnly, impact])
  const marked = (id: string) => {
    const m = impact?.marks.get(id)
    return m === 'compromised' || m === 'derived'
  }
  const groups: { day: string; items: typeof rows }[] = []
  for (const row of rows.slice(0, limit)) {
    const day =
      row.day === 'undated'
        ? 'Undated'
        : new Date(row.day).toLocaleDateString('en-GB', {
            weekday: 'short',
            day: '2-digit',
            month: 'short',
            year: 'numeric',
            timeZone: 'UTC',
          })
    const last = groups[groups.length - 1]
    if (last?.day === day) last.items.push(row)
    else groups.push({ day, items: [row] })
  }
  const time = (t: string | null) => (t ? t.slice(11, 16) : '—')
  const events = rows.reduce((n, r) => n + r.count, 0)
  return (
    <section className="view-page">
      <header className="view-header">
        <div>
          <h2>Timeline</h2>
          <p>
            One row = one activity (same operation, same participants) on one day, with its first–last time in UTC. <b>N×</b> = its evidence
            items, one per original log row; open a row to see each of them.
          </p>
        </div>
        <div className="head-actions">
          {impact?.seeds.length ? (
            <div className="segmented" role="group" aria-label="Timeline filter">
              <button className={!attackOnly ? 'active' : ''} onClick={() => setAttackOnly(false)}>
                All
              </button>
              <button className={attackOnly ? 'active' : ''} onClick={() => setAttackOnly(true)}>
                Attacker activity
              </button>
            </div>
          ) : null}
          <label className="check">
            <input
              type="checkbox"
              checked={showFailed}
              onChange={e => {
                setShowFailed(e.target.checked)
                writePref('showFailed', String(e.target.checked))
              }}
            />{' '}
            Failed attempts
          </label>
          <span className="count-chip" title="Rows: activities per day. Evidence items: the original log rows behind them.">
            {rows.length.toLocaleString('en')} rows · {events.toLocaleString('en')} evidence items
          </span>
        </div>
      </header>
      {rows.length ? (
        groups.map(group => (
          <div key={group.day} className="timeline-group">
            <div className="timeline-day">{group.day}</div>
            {group.items.map(row => {
              const attack = row.attack ? impact?.facts.get(row.fact.id) : undefined
              return (
                <button
                  key={`${row.day}|${row.fact.id}|${row.attack}`}
                  title={`${row.fact.predicate} · ${row.count} evidence item${row.count === 1 ? '' : 's'} · ${row.first ?? 'no time'}${row.last && row.last !== row.first ? ` – ${row.last}` : ''} UTC${row.attack ? ' · inside the attacker window' : ''}`}
                  className={`timeline-item${selection?.id === row.fact.id ? ' active' : ''}${attack ? (attack.before ? ' regular' : ' attack') : ''}`}
                  onClick={() => onSelect({ kind: 'fact', id: row.fact.id })}
                >
                  <span className="timeline-time">
                    {time(row.first)}
                    {row.last && time(row.last) !== time(row.first) ? <small>–{time(row.last)}</small> : null}
                  </span>
                  <span className={`timeline-dot ${row.fact.truth_state}`} />
                  <span className="timeline-body">
                    <span className="timeline-line">
                      <Zap size={12} /> <Sentence fact={row.fact} data={data} marked={marked} />
                    </span>
                    <small>
                      {row.count > 1 ? <b>{row.count}× </b> : null}
                      {row.count > 1 ? '· ' : ''}
                      {attack ? (attack.before ? 'attacker window, but likely regular · ' : 'attacker activity · ') : ''}
                      {row.refutes ? 'refuting evidence · ' : ''}
                      {row.fact.truth_state}
                    </small>
                  </span>
                </button>
              )
            })}
          </div>
        ))
      ) : (
        <div className="view-empty">
          <Clock size={22} />
          <p>No active evidence in this view.</p>
        </div>
      )}
      {rows.length > limit && (
        <footer className="pager">
          <button className="secondary-button small" onClick={() => setLimit(limit + 500)}>
            Show {Math.min(500, rows.length - limit)} more of {rows.length - limit} rows
          </button>
        </footer>
      )}
    </section>
  )
}

export type StepSize = 'auto' | 'day' | 'hour' | 'minute' | 'event'
export const STEP_MS: Record<Exclude<StepSize, 'auto' | 'event'>, number> = { minute: 60_000, hour: 3_600_000, day: 86_400_000 }
/**
 * Steps for the time bar, each with its first and last time and how many evidence times fall in it. Auto picks minute,
 * hour, day or week so there are about 150 steps; "event" is every distinct time.
 */
export function coarseSteps(
  steps: string[],
  size: StepSize = 'auto',
  all: number[] = [],
): { starts: string[]; ends: string[]; counts: number[] } {
  const bucketed = (ms: number) => {
    const buckets = new Map<number, [string, string]>()
    for (const step of steps) {
      const key = Math.floor(Date.parse(step) / ms),
        current = buckets.get(key)
      if (!current) buckets.set(key, [step, step])
      else {
        if (step < current[0]) current[0] = step
        if (step > current[1]) current[1] = step
      }
    }
    return [...buckets.entries()].sort((a, b) => a[0] - b[0])
  }
  const sizes = size === 'auto' ? [60_000, 3_600_000, 86_400_000, 7 * 86_400_000] : size === 'event' ? [] : [STEP_MS[size]]
  let chosen: [number, [string, string]][] | null = null,
    ms = 0
  for (const candidate of sizes) {
    ms = candidate
    chosen = bucketed(candidate)
    if (chosen.length <= 150) break
  }
  if (!chosen) {
    const keys = steps.map(s => Date.parse(s))
    chosen = steps.map((s, i) => [keys[i], [s, s]])
    ms = 0
  }
  const counts = new Array(chosen.length).fill(0)
  if (all.length) {
    const index = new Map(chosen.map(([key], i) => [key, i]))
    for (const t of all) {
      const i = index.get(ms ? Math.floor(t / ms) : t)
      if (i !== undefined) counts[i]++
    }
  }
  return { starts: chosen.map(([, b]) => b[0]), ends: chosen.map(([, b]) => b[1]), counts }
}

export function EvidenceWindow({
  facts,
  from,
  to,
  includeUndated,
  onIncludeUndatedChange,
  onFromChange,
  onToChange,
  onReset,
  onClose,
  attack,
}: {
  facts: GraphData['facts']
  from: string
  to: string
  attack?: { first: string | null; last: string | null } | null
  includeUndated: boolean
  onIncludeUndatedChange: (value: boolean) => void
  onFromChange: (value: string) => void
  onToChange: (value: string) => void
  onReset: () => void
  onClose: () => void
}) {
  const [playing, setPlaying] = useState(false)
  const [size, setSize] = useState<StepSize>(() => (readPref('timeStep') as StepSize | null) ?? 'auto')
  const evidenceTimes = useMemo(
    () =>
      facts
        .flatMap(f => f.assertions.filter(a => !a.retracted_at && a.valid_from).map(a => Date.parse(a.valid_from!)))
        .filter(t => !Number.isNaN(t)),
    [facts],
  )
  const buckets = useMemo(() => coarseSteps(timelineSteps(facts), size, evidenceTimes), [facts, size, evidenceTimes])
  const peak = Math.max(1, ...buckets.counts)
  const steps = buckets.ends
  const maxStep = Math.max(steps.length - 1, 0)
  // A step is a bucket (a minute, hour, day…): the left handle stands for its first event, the right one for its last.
  const starts = buckets.starts
  const nearestStep = (value: string, fallback: number, list = steps) => {
    if (!value || !list.length) return fallback
    const target = Date.parse(value)
    return list.reduce(
      (best, step, index) => (Math.abs(Date.parse(step) - target) < Math.abs(Date.parse(list[best]) - target) ? index : best),
      0,
    )
  }
  const fromStep = Math.min(nearestStep(from, 0, starts), maxStep)
  const toStep = Math.max(nearestStep(to, maxStep), 0)
  const position = (step: number) => (maxStep ? (step / maxStep) * 100 : 0)
  const moveFrom = (step: number) => onFromChange(starts[Math.min(step, toStep)] ?? '')
  const moveTo = (step: number) => onToChange(steps[Math.max(step, fromStep)] ?? '')
  const hasRange = steps.length > 1
  useEffect(() => {
    if (!playing) return
    if (toStep >= maxStep) {
      setPlaying(false)
      return
    }
    const timer = window.setTimeout(() => moveTo(toStep + 1), 900)
    return () => window.clearTimeout(timer)
  }, [playing, toStep, maxStep])
  return (
    <div className="time-bar" role="region" aria-label="Evidence window">
      <div className="time-controls">
        <button
          className="icon-button"
          aria-label="Previous evidence step"
          disabled={!hasRange || toStep <= fromStep}
          onClick={() => moveTo(toStep - 1)}
        >
          <SkipBack size={14} />
        </button>
        <button
          className="icon-button play"
          aria-label={playing ? 'Pause evidence playback' : 'Play evidence steps'}
          disabled={!hasRange}
          onClick={() => {
            if (toStep === maxStep) {
              onFromChange(buckets.starts[0])
              onToChange(steps[0])
            }
            setPlaying(!playing)
          }}
        >
          {playing ? <Pause size={14} /> : <Play size={14} />}
        </button>
        <button
          className="icon-button"
          aria-label="Next evidence step"
          disabled={!hasRange || toStep === maxStep}
          onClick={() => moveTo(toStep + 1)}
        >
          <SkipForward size={14} />
        </button>
      </div>
      <div className="time-main">
        {buckets.counts.length > 1 && buckets.counts.length <= 600 && (
          <div className="time-density" aria-hidden="true" title="Evidence items per step">
            {buckets.counts.map((n, i) => (
              <i key={i} style={{ height: `${Math.max(8, (n / peak) * 100)}%` }} />
            ))}
          </div>
        )}
        <div className="window-range" aria-label="Evidence time range">
          <div className="window-track" />
          {attack?.first && hasRange && (
            <div
              className="window-attack"
              title={`Attacker activity ${attack.first.slice(0, 16).replace('T', ' ')} – ${(attack.last ?? attack.first).slice(0, 16).replace('T', ' ')} UTC`}
              style={{
                left: `${position(nearestStep(attack.first, 0, starts))}%`,
                right: `${100 - position(nearestStep(attack.last ?? attack.first, maxStep))}%`,
              }}
            />
          )}
          <div className="window-selection" style={{ left: `${position(fromStep)}%`, right: `${100 - position(toStep)}%` }} />
          <input
            aria-label="Evidence from"
            aria-valuetext={starts[fromStep] ? periodLabel(starts[fromStep], null) : 'No dated evidence'}
            className="range-input"
            type="range"
            min="0"
            max={maxStep}
            step="1"
            value={fromStep}
            disabled={!hasRange}
            onChange={event => moveFrom(Number(event.target.value))}
          />
          <input
            aria-label="Evidence to"
            aria-valuetext={steps[toStep] ? periodLabel(steps[toStep], null) : 'No dated evidence'}
            className="range-input"
            type="range"
            min="0"
            max={maxStep}
            step="1"
            value={toStep}
            disabled={!hasRange}
            onChange={event => moveTo(Number(event.target.value))}
          />
        </div>
        <div className="window-labels">
          <span>{starts.length ? periodLabel(starts[fromStep], null) : 'No dated evidence'}</span>
          <em>{steps.length ? `step ${fromStep + 1}–${toStep + 1} of ${steps.length}` : ''}</em>
          <span>{steps.length ? periodLabel(steps[toStep], null) : ''}</span>
        </div>
      </div>
      <select
        className="time-step-size"
        aria-label="Step size"
        title="How far one step moves: auto keeps about 150 steps; each event steps through every distinct time"
        value={size}
        onChange={e => {
          const next = e.target.value as StepSize
          setSize(next)
          writePref('timeStep', next)
        }}
      >
        <option value="auto">Auto steps</option>
        <option value="day">Per day</option>
        <option value="hour">Per hour</option>
        <option value="minute">Per minute</option>
        <option value="event">Each event</option>
      </select>
      <label className="check">
        <input type="checkbox" checked={includeUndated} onChange={event => onIncludeUndatedChange(event.target.checked)} /> Undated
      </label>
      {(from || to) && (
        <button className="text-button" onClick={onReset}>
          Show all
        </button>
      )}
      <button className="icon-button" aria-label="Close evidence window" onClick={onClose}>
        <X size={14} />
      </button>
    </div>
  )
}

export type ChangeKind = 'all' | 'entity' | 'relationship' | 'evidence' | 'review' | 'structure'
export const changeKind = (type: BoardAction['type']): Exclude<ChangeKind, 'all'> =>
  type === 'assertion.review'
    ? 'review'
    : type.startsWith('assertion.')
      ? 'evidence'
      : type.startsWith('fact.')
        ? 'relationship'
        : type.startsWith('entity.') || type.startsWith('identifier.')
          ? 'entity'
          : 'structure'
export const HIDDEN_FIELDS = new Set(['id', 'expected_revision', 'expected_source_revision', 'created_at'])
export const shown = (value: unknown) =>
  value === null || value === undefined || value === '' ? '—' : typeof value === 'object' ? JSON.stringify(value) : String(value)

/** One change, readable: what it touched (with a link) and each changed field, with its earlier value where there was one. */
export function ChangeDetail({
  action,
  before,
  data,
  onSelect,
}: {
  action: BoardAction
  before: (field: string) => unknown
  data: GraphData
  onSelect: (selection: Selection) => void
}) {
  const id = typeof action.payload.id === 'string' ? action.payload.id : ''
  const entity = data.entities.find(e => e.id === id || e.id === action.payload.entity_id || e.id === action.payload.target_id)
  const fact = data.facts.find(f => f.id === id || f.id === action.payload.fact_id)
  const fields = Object.entries(action.payload).filter(([k]) => !HIDDEN_FIELDS.has(k))
  const update = action.type.endsWith('.update')
  // Sources, groups, perspectives, types and evidence have no link target here, but they may well still exist.
  const exists = [data.sources, data.groups ?? [], data.views ?? [], data.entity_types ?? [], data.facts.flatMap(f => f.assertions)].some(
    list => (list as { id: string }[]).some(x => x.id === id),
  )
  return (
    <div className="activity-detail">
      <div className="change-head">
        <strong>{actionLabel(action)}</strong>
        {entity && (
          <button className="link" onClick={() => onSelect({ kind: 'entity', id: entity.id })}>
            {entity.name} · {entity.kind}
          </button>
        )}
        {!entity && fact && (
          <button className="link" onClick={() => onSelect({ kind: 'fact', id: fact.id })}>
            {fact.predicate}
          </button>
        )}
        {!entity && !fact && id && !exists && <span className="muted small">no longer on the board</span>}
      </div>
      {fields.length > 0 && (
        <dl className="change-fields">
          {fields.map(([field, value]) => {
            const old = update ? before(field) : undefined
            return (
              <Fragment key={field}>
                <dt>{field.replace(/_/g, ' ')}</dt>
                <dd>
                  {update && old !== undefined && shown(old) !== shown(value) ? (
                    <>
                      <s>{shown(old)}</s> →{' '}
                    </>
                  ) : null}
                  <span>{shown(value)}</span>
                </dd>
              </Fragment>
            )
          })}
        </dl>
      )}
      <details className="raw-payload">
        <summary>Raw change for agents</summary>
        <small>
          {action.actor} · {action.id}
        </small>
        <pre>{JSON.stringify(action.payload, null, 2)}</pre>
      </details>
    </div>
  )
}

/** Who changed the board, through which channel (UI, REST, MCP, import): searchable, with each change readable. */
export function ActivityPanel({
  actions,
  data,
  onSelect,
}: {
  actions: BoardAction[]
  data: GraphData
  onSelect: (selection: Selection) => void
}) {
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
    const keep = (a: BoardAction) =>
      (channel === 'all' || (a.channel ?? 'UI') === channel) &&
      (author === 'all' || a.author === author) &&
      (kind === 'all' || changeKind(a.type) === kind) &&
      (!q ||
        `${actionLabel(a)} ${a.author} ${names.get(String(a.payload.id ?? '')) ?? ''} ${names.get(String(a.payload.entity_id ?? '')) ?? ''} ${a.payload.id ?? ''}`
          .toLowerCase()
          .includes(q))
    const groups = new Map<string, BoardAction[]>()
    for (const action of actions) {
      if (!keep(action)) continue
      const key = action.batch_id ?? action.id
      const list = groups.get(key)
      if (list) list.push(action)
      else groups.set(key, [action])
    }
    return [...groups.entries()].reverse()
  }, [actions, query, channel, author, kind, names])
  // The value a field had before a change: the latest earlier action on the same record that set it.
  const index = useMemo(() => new Map(actions.map((a, i) => [a.id, i])), [actions])
  const beforeOf = (action: BoardAction) => (field: string) => {
    const id = action.payload.id
    for (let i = (index.get(action.id) ?? 0) - 1; i >= 0; i--) {
      const a = actions[i]
      if (a.payload.id === id && field in a.payload) return a.payload[field]
    }
    return undefined
  }
  const total = batches.reduce((n, [, items]) => n + items.length, 0)
  return (
    <section className="view-page">
      <header className="view-header">
        <div>
          <h2>Change log</h2>
          <p>
            Every change to the board: who, through which channel (UI, REST, MCP, import), and what changed. Not the activities in the logs:
            those are in the timeline.
          </p>
        </div>
        <div className="pager">
          <button className="secondary-button small" disabled={page === 0} onClick={() => setPage(page - 1)}>
            Previous
          </button>
          <span>
            {page + 1} / {Math.max(1, Math.ceil(batches.length / 50))}
          </span>
          <button className="secondary-button small" disabled={(page + 1) * 50 >= batches.length} onClick={() => setPage(page + 1)}>
            Next
          </button>
        </div>
      </header>
      <div className="change-filters">
        <label className="input-with-icon">
          <Search size={14} />
          <input
            aria-label="Search the change log"
            placeholder="Search changes, entities, authors, IDs…"
            value={query}
            onChange={e => {
              setQuery(e.target.value)
              setPage(0)
            }}
          />
        </label>
        <select
          aria-label="Channel"
          value={channel}
          onChange={e => {
            setChannel(e.target.value)
            setPage(0)
          }}
        >
          <option value="all">All channels</option>
          {channels.map(c => (
            <option key={c}>{c}</option>
          ))}
        </select>
        <select
          aria-label="Author"
          value={author}
          onChange={e => {
            setAuthor(e.target.value)
            setPage(0)
          }}
        >
          <option value="all">All authors</option>
          {authors.map(a => (
            <option key={a}>{a}</option>
          ))}
        </select>
        <select
          aria-label="Kind of change"
          value={kind}
          onChange={e => {
            setKind(e.target.value as ChangeKind)
            setPage(0)
          }}
        >
          <option value="all">All changes</option>
          <option value="entity">Entities</option>
          <option value="relationship">Relationships, activities</option>
          <option value="evidence">Evidence</option>
          <option value="review">Reviews</option>
          <option value="structure">Groups, types, views</option>
        </select>
        <span className="count-chip">
          {total.toLocaleString('en')} of {actions.length.toLocaleString('en')} changes · {batches.length.toLocaleString('en')} groups
        </span>
      </div>
      <div className="activity-list">
        {batches.slice(page * 50, (page + 1) * 50).map(([id, items]) => (
          <details key={id} className="activity-item">
            <summary>
              <span className={`channel-badge ${(items[0].channel ?? 'UI').toLowerCase()}`}>{items[0].channel ?? 'UI'}</span>
              <strong>
                {items.length === 1 ? actionLabel(items[0]) : `${items.length.toLocaleString('en')} changes · ${actionLabel(items[0])}`}
              </strong>
              <span className="activity-meta">
                {items[0].author} · {new Date(items[0].at).toLocaleString('en-GB', { timeZone: 'UTC' })} UTC
              </span>
            </summary>
            {items.slice(0, 50).map(action => (
              <ChangeDetail key={action.id} action={action} before={beforeOf(action)} data={data} onSelect={onSelect} />
            ))}
            {items.length > 50 && (
              <p className="muted small">… and {(items.length - 50).toLocaleString('en')} more changes in this group.</p>
            )}
          </details>
        ))}
        {!batches.length && (
          <div className="view-empty">
            <Activity size={22} />
            <p>{actions.length ? 'No change matches the filters.' : 'No changes yet.'}</p>
          </div>
        )}
      </div>
    </section>
  )
}

export function Explorer({
  data,
  search,
  selection,
  onSelect,
  onClose,
}: {
  data: GraphData
  search: string
  selection: Selection
  onSelect: (selection: Selection, focus?: boolean) => void
  onClose: () => void
}) {
  const groupOf = useMemo(() => new Map((data.groups ?? []).flatMap(g => g.member_ids.map(id => [id, g.name] as const))), [data.groups])
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const needle = search.trim().toLowerCase()
  const degree = useMemo(() => {
    const map = new Map<string, number>()
    // Relationships and activities alike: an IP that only takes part in activities has relationships too.
    for (const f of data.facts)
      for (const id of new Set(f.participants?.length ? f.participants.map(p => p.entity_id) : [f.subject_id, f.object_id]))
        map.set(id, (map.get(id) ?? 0) + 1)
    return map
  }, [data.facts])
  // Exact or prefix hits on the name or an identifier come first, above the groups and the list by type.
  const best = useMemo(
    () =>
      !needle
        ? []
        : data.entities
            .filter(
              e =>
                e.name.toLowerCase() === needle ||
                e.name.toLowerCase().startsWith(needle) ||
                e.identifiers.some(i => i.raw_value.toLowerCase() === needle || i.normalized_value === needle),
            )
            .slice(0, 8),
    [data.entities, needle],
  )
  const shownGroups = useMemo(
    () =>
      (data.groups ?? []).filter(
        g => !needle || g.name.toLowerCase().includes(needle) || (best.length > 0 && best.some(e => g.member_ids.includes(e.id))),
      ),
    [data.groups, needle, best],
  )
  const groups = useMemo(() => {
    const byKind = new Map<string, Entity[]>()
    for (const entity of data.entities) {
      if (needle && !`${entity.name} ${entity.kind} ${entity.identifiers.map(i => i.raw_value).join(' ')}`.toLowerCase().includes(needle))
        continue
      const list = byKind.get(entity.kind)
      if (list) list.push(entity)
      else byKind.set(entity.kind, [entity])
    }
    return [...byKind.entries()]
      .map(([kind, items]) => [kind, items.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))] as const)
      .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
  }, [data.entities, needle])
  const total = groups.reduce((sum, [, items]) => sum + items.length, 0)
  return (
    <aside className="explorer" aria-label="Entity explorer">
      <div className="explorer-head">
        <div>
          <strong>Entities</strong>
          <span className="count">{needle ? `${total} / ${data.entities.length}` : data.entities.length}</span>
        </div>
        <button className="icon-button" aria-label="Hide explorer" title="Hide explorer" onClick={onClose}>
          <X size={15} />
        </button>
      </div>
      <div className="explorer-list">
        {best.length > 0 && (
          <div className="explorer-group">
            <div className="explorer-section-label">Best matches</div>
            {best.map(entity => (
              <button
                key={entity.id}
                className={`explorer-item ${selection?.id === entity.id ? 'active' : ''}`}
                onClick={() => onSelect({ kind: 'entity', id: entity.id }, true)}
                title={`${entity.name} · ${entity.kind}`}
              >
                <span className="explorer-name">{entity.name}</span>
                <span className="explorer-hint">{entity.kind}</span>
                <span className="explorer-degree" title="Relationships and activities">
                  {degree.get(entity.id) ?? 0}
                </span>
              </button>
            ))}
          </div>
        )}
        {shownGroups.length > 0 && (
          <div className="explorer-group">
            <div className="explorer-section-label">Groups</div>
            {shownGroups.map(group => (
              <button
                key={group.id}
                className={`explorer-item group-item ${selection?.kind === 'group' && selection.id === group.id ? 'active' : ''}`}
                onClick={() => onSelect({ kind: 'group', id: group.id }, true)}
                title={group.name}
              >
                <Boxes size={13} />
                <span className="explorer-name">{group.name}</span>
                {!group.collapsed && <span className="explorer-hint">open</span>}
                <span className="explorer-degree">{group.member_ids.length}</span>
              </button>
            ))}
            <div className="explorer-section-label">By type</div>
          </div>
        )}
        {groups.map(([kind, items]) => {
          const isCollapsed = collapsed[kind] ?? false
          const limit = expanded[kind] ? items.length : 100
          return (
            <div key={kind} className="explorer-group">
              <button
                className="explorer-group-head"
                aria-expanded={!isCollapsed}
                onClick={() => setCollapsed({ ...collapsed, [kind]: !isCollapsed })}
              >
                {isCollapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
                <EntityAvatar entity={{ kind }} data={data} size="sm" />
                <span>{kind}</span>
                <span className="count">{items.length}</span>
              </button>
              {!isCollapsed &&
                items.slice(0, limit).map(entity => (
                  <button
                    key={entity.id}
                    className={`explorer-item ${selection?.id === entity.id ? 'active' : ''}`}
                    onClick={() => onSelect({ kind: 'entity', id: entity.id }, true)}
                    title={entity.name}
                  >
                    <span className="explorer-name">{entity.name}</span>
                    {groupOf.has(entity.id) ? (
                      <span className="explorer-hint" title={`In group ${groupOf.get(entity.id)}`}>
                        <Boxes size={10} />
                      </span>
                    ) : (
                      entity.identifiers[0] && <span className="explorer-hint">{entity.identifiers[0].raw_value}</span>
                    )}
                    <span className="explorer-degree" title="Relationships and activities">
                      {degree.get(entity.id) ?? 0}
                    </span>
                  </button>
                ))}
              {!isCollapsed && items.length > limit && (
                <button className="explorer-more" onClick={() => setExpanded({ ...expanded, [kind]: true })}>
                  Show all {items.length}
                </button>
              )}
            </div>
          )
        })}
        {!groups.length && <div className="explorer-empty">{needle ? 'No matches.' : 'No entities yet.'}</div>}
      </div>
    </aside>
  )
}

export type PaletteItem = { id: string; group: string; label: string; hint?: string; icon: ReactNode; run: () => void }
export function CommandPalette({ items, onClose }: { items: PaletteItem[]; onClose: () => void }) {
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
    const matched = q
      ? items
          .filter(item => `${item.label} ${item.hint ?? ''} ${item.group}`.toLowerCase().includes(q))
          .map(item => [rank(item), item] as const)
          .sort((a, b) => a[0] - b[0])
          .map(([, item]) => item)
      : items.filter(item => item.group !== 'Entities').concat(items.filter(item => item.group === 'Entities').slice(0, 8))
    return matched.slice(0, 60)
  }, [items, q])
  useEffect(() => setIndex(0), [q])
  useEffect(() => {
    list.current?.querySelector('.active')?.scrollIntoView({ block: 'nearest' })
  }, [index])
  const choose = (item?: PaletteItem) => {
    if (!item) return
    onClose()
    item.run()
  }
  let lastGroup = ''
  return (
    <div
      className="command-backdrop"
      onMouseDown={event => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div className="command-palette" role="dialog" aria-modal="true" aria-label="Command palette">
        <label className="command-input">
          <Search size={16} />
          <input
            autoFocus
            placeholder="Search entities or run a command…"
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'ArrowDown') {
                e.preventDefault()
                setIndex(Math.min(index + 1, results.length - 1))
              } else if (e.key === 'ArrowUp') {
                e.preventDefault()
                setIndex(Math.max(index - 1, 0))
              } else if (e.key === 'Enter') {
                e.preventDefault()
                choose(results[index])
              } else if (e.key === 'Escape') {
                e.preventDefault()
                e.stopPropagation()
                onClose()
              }
            }}
          />
          <Kbd>esc</Kbd>
        </label>
        <div className="command-list" ref={list}>
          {results.map((item, i) => {
            const header =
              item.group !== lastGroup ? (
                <div className="command-group" key={`g-${item.group}`}>
                  {item.group}
                </div>
              ) : null
            lastGroup = item.group
            return [
              header,
              <button
                key={item.id}
                className={`command-item ${i === index ? 'active' : ''}`}
                onMouseMove={() => setIndex(i)}
                onClick={() => choose(item)}
              >
                <span className="command-icon">{item.icon}</span>
                <span className="command-label">{item.label}</span>
                {item.hint && <span className="command-hint">{item.hint}</span>}
              </button>,
            ]
          })}
          {!results.length && <div className="command-empty">No results for “{query}”.</div>}
        </div>
        <div className="command-foot">
          <span>
            <Kbd>↑</Kbd>
            <Kbd>↓</Kbd> navigate
          </span>
          <span>
            <Kbd>↵</Kbd> select
          </span>
        </div>
      </div>
    </div>
  )
}
