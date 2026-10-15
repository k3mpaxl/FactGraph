import type { GraphData } from './types'

/**
 * Keys in the original rows that tie events together across tables, after the relationship catalog of xdrinternals.com
 * (app/data/column_relations.json): the token of one sign-in, the sign-in session it belongs to, the process launch an
 * endpoint event came from, and the email a click or attachment belongs to. Read from the evidence notes (the imported
 * row), never written to the board.
 */
export type KeyKind = 'token' | 'session' | 'process' | 'message'
export const KEY_LABEL: Record<KeyKind, string> = { token: 'Same token', session: 'Same sign-in session', process: 'Same process', message: 'Same email' }

const GUID_TEXT = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}'
const GUID = new RegExp(`^${GUID_TEXT}$`)

/**
 * The token ID under every name the logs use (Sentinel UniqueTokenIdentifier, Defender XDR UniqueTokenId, the uti claim,
 * Graph SignInActivityId), with trailing Base64 padding dropped: Azure AD Graph pads some values. Case is kept, a UTI is
 * case-sensitive. GUID-shaped SignInActivityIds are no token IDs and are not matched with sign-ins.
 */
const UTI = /"(?:UniqueTokenIdentifier|UniqueTokenId|uniqueTokenId|uti|SignInActivityId)":\s*"([A-Za-z0-9_-]{12,})=*"/g
export function tokenId(note: string): string | undefined {
  for (const match of note.matchAll(UTI)) if (!GUID.test(match[1])) return match[1]
  return undefined
}

/**
 * The Entra session ID (the sid claim): SessionId in sign-in and Graph logs, AADSessionId in Microsoft 365 and Cloud App
 * events, claims.sid. A GUID, compared in lower case. SessionId is a common column name, so it counts only in a row that
 * is an Entra record (it has a token ID, or Microsoft 365 / Cloud App context); Windows SIDs are never GUID-shaped.
 */
const SID = new RegExp(`"(SessionId|AADSessionId|sid)":\\s*"(${GUID_TEXT})"`, 'g')
export function sessionId(note: string): string | undefined {
  const entra = tokenId(note) !== undefined || note.includes('"AppAccessContext"') || note.includes('"RawEventData"')
  for (const match of note.matchAll(SID)) if (match[1] !== 'SessionId' || entra) return match[2].toLowerCase()
  return undefined
}

/**
 * The Windows process start key of the process a row created (DeviceProcessEvents ProcessUniqueId) and of the process
 * that did what the row records (InitiatingProcessUniqueId), each with the device: a key alone is not unique across devices.
 */
const DEVICE = /"DeviceId":\s*"([^"]+)"/
const STARTED = /"ProcessUniqueId":\s*"?(\d+)"?/
const BY = /"InitiatingProcessUniqueId":\s*"?(\d+)"?/
export function processKeys(note: string): { started?: string; by?: string } {
  if (!note.includes('ProcessUniqueId')) return {}
  const device = DEVICE.exec(note)?.[1]?.toLowerCase()
  if (!device) return {}
  const started = STARTED.exec(note)?.[1], by = BY.exec(note)?.[1]
  return { ...(started && started !== '0' ? { started: `${device}|${started}` } : {}), ...(by && by !== '0' ? { by: `${device}|${by}` } : {}) }
}

/** The Microsoft 365 NetworkMessageId: delivery, URLs, attachments, clicks, post-delivery actions and alerts of one email. */
const MESSAGE = new RegExp(`"NetworkMessageId":\\s*"(${GUID_TEXT})"`)
export function messageId(note: string): string | undefined {
  return note.includes('NetworkMessageId') ? MESSAGE.exec(note)?.[1].toLowerCase() : undefined
}

/** started: the row that launched the process; by: a row of something the process did. */
export type KeyUse = { kind: KeyKind; value: string; fact: string; item: string; at: string | null; role?: 'started' | 'by' }

export function keysOf(note: string): Omit<KeyUse, 'fact' | 'item' | 'at'>[] {
  const keys: Omit<KeyUse, 'fact' | 'item' | 'at'>[] = []
  const token = tokenId(note), session = sessionId(note), message = messageId(note), process = processKeys(note)
  if (token) keys.push({ kind: 'token', value: token })
  if (session) keys.push({ kind: 'session', value: session })
  if (message) keys.push({ kind: 'message', value: message })
  if (process.started) keys.push({ kind: 'process', value: process.started, role: 'started' })
  if (process.by) keys.push({ kind: 'process', value: process.by, role: 'by' })
  return keys
}

const indexCache = new WeakMap<object, Map<string, KeyUse[]>>()
/** Every key in the active evidence of the board, as `${kind}:${value}` → its uses. One pass, cached per board state. */
export function correlationIndex(data: Pick<GraphData, 'facts'>): Map<string, KeyUse[]> {
  const cached = indexCache.get(data.facts)
  if (cached) return cached
  const index = new Map<string, KeyUse[]>()
  for (const fact of data.facts) for (const item of fact.assertions) {
    if (item.retracted_at || !item.note || item.note[0] !== '{') continue
    for (const key of keysOf(item.note)) {
      const id = `${key.kind}:${key.value}`
      let list = index.get(id); if (!list) index.set(id, list = [])
      list.push({ ...key, fact: fact.id, item: item.id, at: item.valid_from })
    }
  }
  indexCache.set(data.facts, index)
  return index
}

/**
 * Activities tied to one by a key in their original rows, per key and relation: for a process, `launched by` is the row
 * that started the process this activity ran in, `then` what the process this activity started did, `also` what the same
 * process did besides. Other activities only, earliest first.
 */
export type Linked = { kind: KeyKind; value: string; relation: 'same' | 'launched by' | 'then' | 'also'; facts: { fact: string; at: string | null }[]; total: number }
export function linkedActivities(data: Pick<GraphData, 'facts'>, factId: string, limit = 20): Linked[] {
  const fact = data.facts.find(f => f.id === factId)
  if (!fact) return []
  const index = correlationIndex(data)
  const groups = new Map<string, Linked>()
  const add = (kind: KeyKind, value: string, relation: Linked['relation'], use: KeyUse) => {
    if (use.fact === factId) return
    const id = `${kind}|${value}|${relation}`
    let group = groups.get(id); if (!group) groups.set(id, group = { kind, value, relation, facts: [], total: 0 })
    const known = group.facts.find(f => f.fact === use.fact)
    if (!known) group.facts.push({ fact: use.fact, at: use.at })
    else if (use.at && (!known.at || use.at < known.at)) known.at = use.at
  }
  for (const item of fact.assertions) {
    if (item.retracted_at || !item.note || item.note[0] !== '{') continue
    for (const key of keysOf(item.note)) for (const use of index.get(`${key.kind}:${key.value}`) ?? []) {
      if (key.kind !== 'process') add(key.kind, key.value, 'same', use)
      else if (key.role === 'by') add('process', key.value, use.role === 'started' ? 'launched by' : 'also', use)
      else if (use.role === 'by') add('process', key.value, 'then', use)
    }
  }
  const order: Record<Linked['relation'], number> = { 'launched by': 0, then: 1, also: 2, same: 3 }
  const kinds: KeyKind[] = ['process', 'session', 'token', 'message']
  return [...groups.values()].map(g => ({ ...g, total: g.facts.length, facts: g.facts.sort((a, b) => (a.at ?? '￿').localeCompare(b.at ?? '￿')).slice(0, limit) }))
    .sort((a, b) => kinds.indexOf(a.kind) - kinds.indexOf(b.kind) || order[a.relation] - order[b.relation])
}
