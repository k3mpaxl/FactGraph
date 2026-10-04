import type { BoardAction } from './board'

/**
 * Notifications: what agents, GTIEnricher and colleagues changed on the board, the analyst's own imports and exports,
 * and connection or storage problems. Kept per board in this browser (never synced), newest first.
 */
export type NoticeKind = 'agent' | 'gtienricher' | 'colleague' | 'import' | 'export' | 'connection' | 'error'
export type NoticeStatus = 'queued' | 'running' | 'done' | 'error' | 'info'
export type NoticeTarget = { kind: 'entity' | 'fact' | 'review' | 'activity'; id?: string }
export type Counts = { entities: number; relationships: number; evidence: number; reviewed: number; merged: number; deleted: number; other: number }
export type Notice = {
  id: string; kind: NoticeKind; status: NoticeStatus; title: string
  detail?: string; progress?: string; target?: NoticeTarget
  /** Batches of remote changes this notice summarises; later chunks of a batch and further batches of the same author update it. */
  batchIds?: string[]; counts?: Counts; author?: string
  at: string; finished?: string; read?: boolean
  /** Colleague changes are listed but never raise the badge. */
  quiet?: boolean
}

export const MAX_KEPT = 80
export const isActive = (n: Notice) => n.status === 'queued' || n.status === 'running'
export const emptyCounts = (): Counts => ({ entities: 0, relationships: 0, evidence: 0, reviewed: 0, merged: 0, deleted: 0, other: 0 })

export function count(actions: BoardAction[], into: Counts = emptyCounts()): Counts {
  const c = { ...into }
  for (const a of actions) {
    if (a.type === 'entity.add') c.entities++
    else if (a.type === 'fact.add') c.relationships++
    else if (a.type === 'assertion.add') c.evidence++
    else if (a.type === 'assertion.review') c.reviewed++
    else if (a.type === 'entity.merge') c.merged++
    else if (a.type.endsWith('.delete')) c.deleted++
    else if (!a.type.endsWith('.position') && !a.type.startsWith('action.')) c.other++
  }
  return c
}

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en')} ${n === 1 ? one : many}`

export function describe(c: Counts) {
  const parts = [
    c.entities && plural(c.entities, 'entity', 'entities'), c.relationships && plural(c.relationships, 'relationship'),
    c.evidence && plural(c.evidence, 'new evidence item'), c.reviewed && plural(c.reviewed, 'review'),
    c.merged && plural(c.merged, 'merge'), c.deleted && plural(c.deleted, 'deletion'), c.other && plural(c.other, 'other change'),
  ].filter(Boolean)
  return parts.length ? parts.join(', ') : 'layout changes'
}

/** Who made a batch of changes that did not come from this analyst's own canvas. */
export function classify(actions: BoardAction[], me: string): { kind: 'agent' | 'gtienricher' | 'colleague'; author: string } | null {
  const first = actions[0]
  if (!first) return null
  if (actions.every(a => a.actor === me && (a.channel ?? 'UI') === 'UI')) return null
  if (actions.some(a => a.author === 'GTIEnricher')) return { kind: 'gtienricher', author: 'GTIEnricher' }
  const channel = first.channel ?? 'UI'
  if (channel === 'MCP' || channel === 'REST') return { kind: 'agent', author: first.author && first.author !== channel ? `${first.author} (${channel})` : `Agent via ${channel}` }
  return { kind: 'colleague', author: first.author || 'A colleague' }
}

/** Where a notice should lead: new evidence to the review, a single new item to itself, everything else to the change log. */
export function targetOf(actions: BoardAction[], c: Counts): NoticeTarget {
  if (c.evidence) return { kind: 'review' }
  const entities = actions.filter(a => a.type === 'entity.add')
  const facts = actions.filter(a => a.type === 'fact.add')
  if (entities.length === 1 && !facts.length) return { kind: 'entity', id: String(entities[0].payload.id) }
  if (facts.length === 1) return { kind: 'fact', id: String(facts[0].payload.id) }
  return { kind: 'activity' }
}

/**
 * Turn remote batches into notices. Chunks of a batch that already has a notice update it. When a sync delivers many
 * batches at once (after being offline), colleagues are folded into one notice and agents beyond the first five too.
 */
/** An agent works in many small calls: notices of the same author within this time are combined (and become unread again). */
export const COMBINE_MS = 2 * 60_000

export function noticesFor(batches: Map<string, BoardAction[]>, me: string, existing: Notice[], now = new Date().toISOString()): { updates: Notice[]; created: Notice[] } {
  const updates: Notice[] = [], created: Notice[] = []
  const touched = new Map<string, Notice>()
  const merge = (notice: Notice, batchId: string, actions: BoardAction[]) => {
    const base = touched.get(notice.id) ?? notice
    const counts = count(actions, base.counts)
    const next: Notice = { ...base, counts, detail: describe(counts), read: false, at: now, batchIds: [...new Set([...(base.batchIds ?? []), batchId])],
      target: counts.evidence ? { kind: 'review' } : (base.batchIds?.length ?? 0) > 0 || base.target?.kind === 'activity' ? { kind: 'activity' } : base.target }
    touched.set(notice.id, next)
  }
  const fold = batches.size > 8
  const folded = new Map<string, { kind: Notice['kind']; actions: BoardAction[]; authors: Set<string> }>()
  let agents = 0
  for (const [batchId, actions] of batches) {
    const who = classify(actions, me)
    if (!who) continue
    const pool = [...touched.values(), ...existing, ...created]
    const sameBatch = pool.find(n => n.batchIds?.includes(batchId))
    if (sameBatch) { merge(sameBatch, batchId, actions); continue }
    // Read or not: looking at the panel while an agent works must not split its session.
    const recent = pool.find(n => n.kind === who.kind && n.author === who.author && n.status === 'info' && n.batchIds?.length &&
      Date.parse(now) - Date.parse(n.at) < COMBINE_MS)
    if (recent) { merge(recent, batchId, actions); continue }
    if (fold && (who.kind === 'colleague' || (who.kind === 'agent' && ++agents > 5))) {
      const key = who.kind
      const group = folded.get(key) ?? { kind: who.kind, actions: [], authors: new Set<string>() }
      for (const item of actions) group.actions.push(item)  // a batch can hold tens of thousands of actions
      group.authors.add(who.author)
      folded.set(key, group)
      continue
    }
    const counts = count(actions)
    if (counts.entities + counts.relationships + counts.evidence + counts.reviewed + counts.merged + counts.deleted + counts.other === 0) continue  // moves only
    created.push({ id: `batch:${batchId}`, batchIds: [batchId], kind: who.kind, status: 'info', author: who.author, counts, quiet: who.kind === 'colleague',
      title: who.kind === 'gtienricher' ? 'GTIEnricher sent intelligence' : `${who.author} changed the board`,
      detail: describe(counts), target: targetOf(actions, counts), at: now })
  }
  for (const [, group] of folded) {
    const counts = count(group.actions)
    created.push({ id: `sync:${group.kind}:${now}`, kind: group.kind, status: 'info', counts, quiet: group.kind === 'colleague',
      title: `${group.kind === 'colleague' ? 'Colleagues' : 'More agent changes'} synced: ${[...group.authors].slice(0, 3).join(', ')}${group.authors.size > 3 ? ` +${group.authors.size - 3}` : ''}`,
      detail: describe(counts), target: { kind: 'activity' }, at: now })
  }
  // Notices created in this round and merged again stay "created"; the others are updates of existing ones.
  for (const [id, notice] of touched) {
    const index = created.findIndex(n => n.id === id)
    if (index >= 0) created[index] = notice; else updates.push(notice)
  }
  return { updates, created }
}

// ------------------------------------------------------------------------------------------------- storage

const key = (boardId: string) => `factgraph:notifications:${boardId}`

export function loadNotices(boardId: string): Notice[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(key(boardId)) ?? '[]') as Notice[]
    if (!Array.isArray(parsed)) return []
    // Work that was running when the page went away did not finish here.
    return parsed.filter(n => n && typeof n.id === 'string' && typeof n.title === 'string').map(n => isActive(n)
      ? { ...n, status: 'error' as const, finished: n.finished ?? new Date().toISOString(), detail: 'Interrupted by a reload. Check the board before running it again.' }
      : n)
  } catch { return [] }
}

export function saveNotices(boardId: string, notices: Notice[]) {
  try { localStorage.setItem(key(boardId), JSON.stringify(notices.slice(0, MAX_KEPT))) } catch { /* private mode: this session only */ }
}

/** At most `size` tasks at once (e.g. several log imports); the rest wait in order. */
export function createLimiter(size: number) {
  let active = 0
  const waiting: (() => void)[] = []
  return async function run<T>(task: () => Promise<T>, onQueued?: () => void): Promise<T> {
    if (active >= size) {
      onQueued?.()
      await new Promise<void>(resolve => waiting.push(resolve))  // the finishing task hands its slot over
    } else active++
    try { return await task() } finally {
      const next = waiting.shift()
      if (next) next(); else active--
    }
  }
}
