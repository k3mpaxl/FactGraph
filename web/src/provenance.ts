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

/** "Reviewed by Jo Doe", "Parsed by the import", "Confirmed by Claude via MCP". */
export function reviewText(item: Assertion): string {
  const kind = reviewKind(item)
  if (kind === 'analyst') return item.reviewer_name ? `Reviewed by ${item.reviewer_name}` : REVIEW_LABEL.analyst
  if (kind === 'agent') return `Confirmed by ${item.reviewer_name || 'an agent'} via REST/MCP, not checked by an analyst`
  return REVIEW_LABEL[kind]
}

/** "File import", "Jo Doe (UI)", "Claude (MCP)". */
export function addedText(item: Assertion): string {
  const via = item.created_via ?? null, by = item.created_by ?? null
  if (!via && !by) return 'Unknown (added before this was recorded)'
  if (by === 'Import' && (via === 'Import' || via === 'UI' || !via)) return 'File import by an analyst'
  if (via === 'REST' || via === 'MCP') return `${by && by !== via && by !== 'Import' ? by : 'An agent'} via ${via}${by === 'Import' ? ' (import)' : ''}`
  return `${by ?? 'Someone'} by hand`
}

/** Counts per kind, for summaries that must not equate "nothing open" with "all checked by a person". */
export function reviewCounts(items: Assertion[]): Record<ReviewKind, number> {
  const counts: Record<ReviewKind, number> = { import: 0, analyst: 0, agent: 0, open: 0 }
  for (const item of items) if (!item.retracted_at) counts[reviewKind(item)]++
  return counts
}
