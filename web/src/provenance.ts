import type { Assertion } from './types'

/**
 * What a confirmation is worth. `import`: the import parsed the original log row (a parser decision, nobody read it).
 * `analyst`: a person checked it against the original. `agent`: an agent confirmed it through REST or MCP. `open`: to review.
 */
export type ReviewKind = 'import' | 'analyst' | 'agent' | 'open'
const PARSED = 'Parsed from the original log row by the import'

export function reviewKind(item: Assertion): ReviewKind {
  if (item.retracted_at || item.review_status !== 'confirmed') return 'open'
  if (item.review_kind) return item.review_kind
  // Evidence from before the field existed: the import wrote its own note.
  return item.review_note === PARSED ? 'import' : 'analyst'
}

export const REVIEW_LABEL: Record<ReviewKind, string> = {
  import: 'Parsed by the import', analyst: 'Reviewed by an analyst', agent: 'Confirmed by an agent', open: 'To review',
}

const AGENT_CHANNELS = ['REST', 'MCP']

/**
 * The author of a change an agent made through REST or MCP: the agent's own name, or the channel, and in brackets the
 * analyst whose board token it used ("MCP (Gregor)", "Claude (Gregor)"). The browser that applies the change knows its
 * analyst; the board token belongs to that tab.
 */
export function onBehalf(author: string | null | undefined, channel: string, analyst: string): string {
  const base = !author || author === 'API' ? channel : author
  return !analyst || base.endsWith(`(${analyst})`) ? base : `${base} (${analyst})`
}

/**
 * Such an author for people: "MCP (Gregor)" → "Agent via MCP (Gregor)", "Claude (Gregor)" over MCP → "Claude via MCP
 * (Gregor)". Changes from before the analyst was recorded ("MCP", "Claude") read "Agent via MCP", "Claude via MCP".
 */
export function agentText(author: string | null | undefined, channel?: string | null): string {
  const match = /^(.*?)(?: \(([^()]+)\))?$/.exec((author ?? '').trim())!
  let name = match[1].trim()
  const analyst = match[2]
  const via = channel && AGENT_CHANNELS.includes(channel) ? channel : AGENT_CHANNELS.includes(name) ? name : null
  if (!name || name === via || name === 'API') name = 'Agent'
  return `${name}${via ? ` via ${via}` : ''}${analyst ? ` (${analyst})` : ''}`
}

/** "Reviewed by Jo Doe", "Parsed by the import", "Confirmed by an agent via MCP (Gregor)". */
export function reviewText(item: Assertion): string {
  const kind = reviewKind(item)
  if (kind === 'analyst') return item.reviewer_name ? `Reviewed by ${item.reviewer_name}` : REVIEW_LABEL.analyst
  if (kind === 'agent') {
    const who = agentText(item.reviewer_name)
    return `Confirmed by ${who.replace(/^Agent\b/, 'an agent')}${who.includes(' via ') ? '' : ' via REST/MCP'}, not checked by an analyst`
  }
  return REVIEW_LABEL[kind]
}

/** "File import by an analyst", "Jo Doe by hand", "Agent via MCP (Gregor)", "Import by an agent via REST (Gregor)". */
export function addedText(item: Assertion): string {
  const via = item.created_via ?? null, by = item.created_by ?? null
  if (!via && !by) return 'Unknown (added before this was recorded)'
  if (by === 'Import' && (via === 'Import' || via === 'UI' || !via)) return 'File import by an analyst'
  if (via === 'REST' || via === 'MCP') {
    const who = agentText(by, via)
    return /^Import\b/.test(who) ? who.replace(/^Import/, 'Import by an agent') : who
  }
  return `${by ?? 'Someone'} by hand`
}

/** Counts per kind, for summaries that must not equate "nothing open" with "all checked by a person". */
export function reviewCounts(items: Assertion[]): Record<ReviewKind, number> {
  const counts: Record<ReviewKind, number> = { import: 0, analyst: 0, agent: 0, open: 0 }
  for (const item of items) if (!item.retracted_at) counts[reviewKind(item)]++
  return counts
}
