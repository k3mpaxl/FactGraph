/**
 * One time format everywhere: ISO 8601 in UTC with milliseconds ("2026-09-17T08:00:05.123Z"). Logs are UTC, so a time
 * without a zone is read as UTC, never as the browser's local time (two analysts in different time zones would
 * otherwise see different windows). Normalised times also sort correctly as text.
 */
export function utc(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const text = value.trim()
  if (!text) return null
  const zoned = /(?:[zZ]|[+-]\d\d:?\d\d|\bUTC|\bGMT)$/.test(text)
  const iso = /^\d{4}-\d\d-\d\d/.test(text)
  let parsed = Date.parse(zoned ? text : iso ? (/\d:\d/.test(text) ? `${text.replace(' ', 'T')}Z` : text) : `${text} UTC`)
  if (Number.isNaN(parsed) && !zoned && !iso) parsed = Date.parse(text)
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString()
}

/** Only a normalised time may go into a query (`datetime(…)` takes it unquoted). */
export const isUtc = (value: string | null | undefined): value is string => !!value && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{1,6})?Z$/.test(value)
