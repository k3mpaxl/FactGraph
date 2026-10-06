import type { BoardAction } from './board'

/**
 * What a browser holds of a board, per actor: highest clock, number of actions and a digest of their IDs. A peer answers
 * a sync request with only what the requester lacks, instead of every peer sending the whole log on every (re)connect.
 * An actor's clock only grows, so "everything up to my highest clock, and the same set" is the usual case; a different
 * digest (a gap after a failed transfer, actions merged out of order) falls back to that actor's complete history.
 */
export type SyncSummary = Record<string, [maxClock: number, count: number, digest: number]>

/** FNV-1a of an ID; XOR over a set is independent of order. */
function hash(id: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < id.length; i++) { h ^= id.charCodeAt(i); h = Math.imul(h, 0x01000193) }
  return h >>> 0
}

export function summarize(actions: BoardAction[]): SyncSummary {
  const summary: SyncSummary = {}
  for (const action of actions) {
    const entry = summary[action.actor] ?? (summary[action.actor] = [-1, 0, 0])
    entry[0] = Math.max(entry[0], action.clock); entry[1]++; entry[2] = (entry[2] ^ hash(action.id)) >>> 0
  }
  return summary
}

export function isSummary(value: unknown): value is SyncSummary {
  return !!value && typeof value === 'object' && !Array.isArray(value) &&
    Object.values(value).every(v => Array.isArray(v) && v.length === 3 && v.every(n => typeof n === 'number' && Number.isFinite(n)))
}

/**
 * The actions a peer with `theirs` lacks, and whether it holds something this browser lacks (then ask it back once).
 * Without a summary (an older browser) everything is sent, as before.
 */
export function syncPlan(actions: BoardAction[], theirs: SyncSummary | null): { send: BoardAction[]; askBack: boolean } {
  if (!theirs) return { send: actions, askBack: false }
  const byActor = new Map<string, BoardAction[]>()
  for (const action of actions) { const list = byActor.get(action.actor); if (list) list.push(action); else byActor.set(action.actor, [action]) }
  const send: BoardAction[] = []
  let askBack = Object.keys(theirs).some(actor => !byActor.has(actor))
  for (const [actor, mine] of byActor) {
    const [max, count, digest] = theirs[actor] ?? [-1, 0, 0]
    let below = 0, belowDigest = 0
    for (const action of mine) if (action.clock <= max) { below++; belowDigest = (belowDigest ^ hash(action.id)) >>> 0 }
    if (below === count && belowDigest === digest) { for (const action of mine) if (action.clock > max) send.push(action) }
    else { send.push(...mine); askBack = true }
  }
  return { send, askBack }
}
