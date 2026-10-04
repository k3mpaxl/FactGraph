import { truth } from './board'
import type { Assertion, Fact } from './types'

function timestamp(value: unknown): string | null {
  return typeof value === 'string' && value.trim() && Number.isFinite(Date.parse(value)) ? value : null
}

type Period = { from: string | null; to: string | null; start: number; end: number }
// Projections create new assertion objects on every change, so the object is a safe cache key for its period.
const periods = new WeakMap<Assertion, Period>()

function computePeriod(assertion: Assertion, fact: Fact): Period {
  let from = timestamp(assertion.valid_from)
  let to = timestamp(assertion.valid_to)
  // Older log imports preserved the original row in the evidence note. Only parse notes that look like JSON:
  // a failing JSON.parse on every free-text note made the timeline slow on large boards.
  if (!from && !to && assertion.note?.trimStart().startsWith('{')) {
    try {
      const row = JSON.parse(assertion.note)
      for (const key of ['valid_from', 'StartTime', 'TimeGenerated', 'timestamp', 'Timestamp', 'time', 'event_time']) {
        from = timestamp(row?.[key]); if (from) break
      }
      for (const key of ['valid_to', 'EndTime']) { to = timestamp(row?.[key]); if (to) break }
    } catch { /* Not JSON after all. */ }
  }
  if (!from && !to) { from = timestamp(fact.valid_from); to = timestamp(fact.valid_to) }
  const start = from ? Date.parse(from) : to ? Date.parse(to) : Number.NaN
  const end = to ? Date.parse(to) : from ? Date.parse(from) : Number.NaN
  return { from, to, start, end }
}

function period(assertion: Assertion, fact: Fact): Period {
  let cached = periods.get(assertion)
  if (!cached) { cached = computePeriod(assertion, fact); periods.set(assertion, cached) }
  return cached
}

export function evidencePeriod(assertion: Assertion, fact: Fact) {
  const { from, to } = period(assertion, fact)
  return { from, to }
}

export function timelineEntries(facts: Fact[]) {
  const entries = facts.flatMap(fact => fact.assertions.filter(a => !a.retracted_at).map(assertion => {
    const p = period(assertion, fact)
    return { fact, assertion, from: p.from, to: p.to, sortKey: Number.isFinite(p.start) ? p.start : Infinity }
  }))
  entries.sort((a, b) => (a.sortKey - b.sortKey) || a.assertion.id.localeCompare(b.assertion.id))
  return entries.map(({ sortKey: _sortKey, ...entry }) => entry)
}

export function timelineEvents(facts: Fact[]) {
  const groups = new Map<string, ReturnType<typeof timelineEntries>[number] & { assertions: Assertion[] }>()
  for (const entry of timelineEntries(facts)) {
    const key = JSON.stringify([entry.fact.id, entry.from ?? '', entry.to ?? '', entry.assertion.locator ?? ''])
    const group = groups.get(key)
    if (group) group.assertions.push(entry.assertion)
    else groups.set(key, { ...entry, assertions: [entry.assertion] })
  }
  return [...groups.values()]
}

function intersects(p: Period, lower: number, upper: number, includeUndated: boolean) {
  if (!Number.isFinite(p.start) || !Number.isFinite(p.end)) return includeUndated
  return p.start <= upper && p.end >= lower
}

export function factIntersects(fact: Fact, from: string | null, to: string | null, includeUndated = true) {
  if (!from && !to) return true
  const lower = from ? Date.parse(from) : Number.NEGATIVE_INFINITY
  const upper = to ? Date.parse(to) : Number.POSITIVE_INFINITY
  return fact.assertions.some(assertion => !assertion.retracted_at && intersects(period(assertion, fact), lower, upper, includeUndated))
}

/** All evidence times in milliseconds (from and to of every unretracted assertion). */
function times(facts: Fact[]) {
  const values: number[] = []
  for (const fact of facts) for (const assertion of fact.assertions) {
    if (assertion.retracted_at) continue
    const p = period(assertion, fact)
    if (p.from && Number.isFinite(p.start)) values.push(p.start)
    if (p.to && Number.isFinite(p.end)) values.push(p.end)
  }
  return values
}

export function timelineBounds(facts: Fact[]) {
  const values = times(facts)
  if (!values.length) return { from: null, to: null }
  // reduce, not Math.min(...values): spreading 100k+ values overflows the call stack.
  return { from: new Date(values.reduce((a, b) => Math.min(a, b))).toISOString(), to: new Date(values.reduce((a, b) => Math.max(a, b))).toISOString() }
}

export function timelineSteps(facts: Fact[]) {
  return [...new Set(times(facts))].sort((a, b) => a - b).map(value => new Date(value).toISOString())
}

export function periodLabel(from: string | null, to: string | null) {
  const format = (value: string) => new Date(value).toLocaleString('en-GB', { timeZone: 'UTC', dateStyle: 'medium', timeStyle: 'medium' })
  if (!from && !to) return 'Evidence time unknown'
  if (!from) return `Until ${format(to!)} UTC`
  return `${format(from)}${to && to !== from ? ` – ${format(to)}` : ''} UTC`
}

export function factsInWindow(facts: Fact[], from: string | null, to: string | null, includeUndated = true) {
  if (!from && !to) return facts
  const lower = from ? Date.parse(from) : Number.NEGATIVE_INFINITY
  const upper = to ? Date.parse(to) : Number.POSITIVE_INFINITY
  const out: Fact[] = []
  for (const fact of facts) {
    const assertions = fact.assertions.filter(assertion => !assertion.retracted_at && intersects(period(assertion, fact), lower, upper, includeUndated))
    if (assertions.length) out.push(assertions.length === fact.assertions.length ? fact : { ...fact, assertions, truth_state: truth(assertions) })
  }
  return out
}
