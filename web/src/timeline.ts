import type { Assertion, Fact } from './types'

function timestamp(value: unknown): string | null {
  return typeof value === 'string' && value.trim() && Number.isFinite(Date.parse(value)) ? value : null
}

export function evidencePeriod(assertion: Assertion, fact: Fact) {
  let from = timestamp(assertion.valid_from)
  let to = timestamp(assertion.valid_to)
  // Older log imports preserved the original row in the evidence note.
  if (!from && !to) {
    try {
      const row = JSON.parse(assertion.note)
      for (const key of ['valid_from', 'StartTime', 'TimeGenerated', 'timestamp', 'Timestamp', 'time', 'event_time']) {
        from = timestamp(row?.[key]); if (from) break
      }
      for (const key of ['valid_to', 'EndTime']) { to = timestamp(row?.[key]); if (to) break }
    } catch { /* Free-text evidence has no embedded log timestamp. */ }
  }
  if (!from && !to) { from = timestamp(fact.valid_from); to = timestamp(fact.valid_to) }
  return { from, to }
}

export function timelineEntries(facts: Fact[]) {
  return facts.flatMap(fact => fact.assertions.filter(a => !a.retracted_at).map(assertion => ({
    fact, assertion, ...evidencePeriod(assertion, fact),
  }))).sort((a, b) => {
    const time = (entry: typeof a) => Date.parse(entry.from || entry.to || '')
    return (Number.isFinite(time(a)) ? time(a) : Infinity) - (Number.isFinite(time(b)) ? time(b) : Infinity)
      || a.assertion.id.localeCompare(b.assertion.id)
  })
}

export function factIntersects(fact: Fact, from: string | null, to: string | null) {
  if (!from && !to) return true
  const lower = from ? Date.parse(from) : Number.NEGATIVE_INFINITY
  const upper = to ? Date.parse(to) : Number.POSITIVE_INFINITY
  return fact.assertions.some(assertion => {
    if (assertion.retracted_at) return false
    const period = evidencePeriod(assertion, fact)
    const start = period.from ? Date.parse(period.from) : period.to ? Date.parse(period.to) : Number.NaN
    const end = period.to ? Date.parse(period.to) : period.from ? Date.parse(period.from) : Number.NaN
    return Number.isFinite(start) && Number.isFinite(end) && start <= upper && end >= lower
  })
}

export function timelineBounds(facts: Fact[]) {
  const values = timelineEntries(facts).flatMap(entry => [entry.from, entry.to])
    .filter((value): value is string => Boolean(value)).map(value => Date.parse(value)).filter(Number.isFinite)
  if (!values.length) return { from: null, to: null }
  return { from: new Date(Math.min(...values)).toISOString(), to: new Date(Math.max(...values)).toISOString() }
}

export function periodLabel(from: string | null, to: string | null) {
  const format = (value: string) => new Date(value).toLocaleString('de-DE', { timeZone: 'UTC', dateStyle: 'medium', timeStyle: 'medium' })
  if (!from && !to) return 'Evidenzzeit unbekannt'
  if (!from) return `Bis ${format(to!)} UTC`
  return `${format(from)}${to && to !== from ? ` – ${format(to)}` : ''} UTC`
}
