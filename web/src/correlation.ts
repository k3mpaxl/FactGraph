import type { GraphData } from './types'
import { JOIN_COLUMNS } from './joinColumns'

/**
 * Keys in the original rows that tie events together across tables, after the relationship catalog of xdrinternals.com
 * (app/data/column_relations.json): the token of one sign-in, the sign-in session it belongs to, the process launch an
 * endpoint event came from, and the email a click or attachment belongs to. Read from the evidence notes (the imported
 * row), never written to the board.
 */
export type KeyKind = 'token' | 'session' | 'process' | 'message'
export const KEY_LABEL: Record<KeyKind, string> = {
  token: 'Same token',
  session: 'Same sign-in session',
  process: 'Same process',
  message: 'Same email',
}

/**
 * The other kinds of key in the catalog, read by table and column: alerts, behaviors, threat intelligence objects, Teams
 * messages, exposure graph nodes, CVEs … Not those FactGraph keeps as entities (users, devices, apps, service
 * principals, hashes, cloud resources: the entity is the link) nor the four above, which have rules of their own.
 */
const OWN_RULES = new Set(['entra-token', 'entra-session', 'process-start-key', 'email-message'])
const AS_ENTITIES = new Set([
  'entra-user',
  'defender-device',
  'entra-device',
  'oauth-client',
  'service-principal',
  'file-sha1',
  'file-sha256',
  'azure-resource',
  'aws-resource',
  'gcp-resource',
])
const CATALOG_KEYS = new Map<string, { family: string; column: string; path: string[] }[]>()
for (const [family, { ends }] of Object.entries(JOIN_COLUMNS)) {
  if (OWN_RULES.has(family) || AS_ENTITIES.has(family)) continue
  for (const [table, column, path] of ends) {
    let list = CATALOG_KEYS.get(table)
    if (!list) CATALOG_KEYS.set(table, (list = []))
    list.push({ family, column, path: path ? path.split('.') : [] })
  }
}
export const keyLabel = (kind: string) => KEY_LABEL[kind as KeyKind] ?? `Same ${JOIN_COLUMNS[kind]?.label ?? kind}`

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
  const started = STARTED.exec(note)?.[1],
    by = BY.exec(note)?.[1]
  return {
    ...(started && started !== '0' ? { started: `${device}|${started}` } : {}),
    ...(by && by !== '0' ? { by: `${device}|${by}` } : {}),
  }
}

/** The Microsoft 365 NetworkMessageId: delivery, URLs, attachments, clicks, post-delivery actions and alerts of one email. */
const MESSAGE = new RegExp(`"NetworkMessageId":\\s*"(${GUID_TEXT})"`)
export function messageId(note: string): string | undefined {
  return note.includes('NetworkMessageId') ? MESSAGE.exec(note)?.[1].toLowerCase() : undefined
}

/** Values at a column and a JSON path inside it ("Data.id", "AlertIds.[]" for each element). */
function valuesAt(row: Record<string, unknown>, column: string, path: string[]): string[] {
  let values: unknown[] = [row[column]]
  for (const part of path)
    values = values.flatMap(v => {
      if (typeof v === 'string' && /^[[{]/.test(v.trim()))
        try {
          v = JSON.parse(v)
        } catch {
          return []
        }
      if (part === '[]') return Array.isArray(v) ? v : []
      return v && typeof v === 'object' && !Array.isArray(v) ? [(v as Record<string, unknown>)[part]] : []
    })
  return values
    .filter(v => (typeof v === 'string' && v.trim()) || typeof v === 'number')
    .map(v => String(v).trim())
    .map(v => (GUID.test(v) ? v.toLowerCase() : v))
}

/**
 * The table a row comes from: the locator of an imported row starts with it ("AlertEvidence AlertId=…"), Log Analytics
 * exports name it in Type, and an import's source is titled after it. Only tables with catalog keys count.
 */
function tableOf(row: Record<string, unknown>, locator: string | undefined, sourceTitle: string | undefined): string | undefined {
  for (const candidate of [
    /^([A-Za-z]\w+)/.exec(locator ?? '')?.[1],
    typeof row.Type === 'string' ? row.Type : undefined,
    /^([A-Za-z]\w+)/.exec(sourceTitle ?? '')?.[1],
  ])
    if (candidate && CATALOG_KEYS.has(candidate)) return candidate
  return undefined
}

/** kind: a KeyKind or a catalog family. started: the row that launched the process; by: a row of something the process did. */
export type KeyUse = { kind: string; value: string; fact: string; item: string; at: string | null; role?: 'started' | 'by' }

/** The keys of one evidence row; `where` names its locator and source title, for the keys that depend on the table. */
export function keysOf(note: string, where: { locator?: string; source?: string } = {}): Omit<KeyUse, 'fact' | 'item' | 'at'>[] {
  const keys: Omit<KeyUse, 'fact' | 'item' | 'at'>[] = []
  const token = tokenId(note),
    session = sessionId(note),
    message = messageId(note),
    process = processKeys(note)
  if (token) keys.push({ kind: 'token', value: token })
  if (session) keys.push({ kind: 'session', value: session })
  if (message) keys.push({ kind: 'message', value: message })
  if (process.started) keys.push({ kind: 'process', value: process.started, role: 'started' })
  if (process.by) keys.push({ kind: 'process', value: process.by, role: 'by' })
  const quick = /^([A-Za-z]\w+)/.exec(where.locator ?? '')?.[1]
  if (!(quick && CATALOG_KEYS.has(quick)) && !note.includes('"Type"') && !where.source) return keys
  let row: Record<string, unknown> | null = null
  try {
    row = JSON.parse(note)
  } catch {
    /* not a row */
  }
  const table = row && tableOf(row, where.locator, where.source)
  if (row && table)
    for (const { family, column, path } of CATALOG_KEYS.get(table)!)
      for (const value of valuesAt(row, column, path))
        if (!keys.some(k => k.kind === family && k.value === value)) keys.push({ kind: family, value })
  return keys
}

type Board = Pick<GraphData, 'facts'> & Partial<Pick<GraphData, 'sources'>>
const where = (item: { locator?: string; source_id: string | null }, titles: Map<string, string>) => ({
  locator: item.locator,
  source: item.source_id ? titles.get(item.source_id) : undefined,
})
const indexCache = new WeakMap<object, Map<string, KeyUse[]>>()
/** Every key in the active evidence of the board, as `${kind}:${value}` → its uses. One pass, cached per board state. */
export function correlationIndex(data: Board): Map<string, KeyUse[]> {
  const cached = indexCache.get(data.facts)
  if (cached) return cached
  const index = new Map<string, KeyUse[]>()
  const titles = new Map((data.sources ?? []).map(s => [s.id, s.title]))
  for (const fact of data.facts)
    for (const item of fact.assertions) {
      if (item.retracted_at || !item.note || item.note[0] !== '{') continue
      for (const key of keysOf(item.note, where(item, titles))) {
        const id = `${key.kind}:${key.value}`
        let list = index.get(id)
        if (!list) index.set(id, (list = []))
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
export type Linked = {
  kind: string
  value: string
  relation: 'same' | 'launched by' | 'then' | 'also'
  facts: { fact: string; at: string | null }[]
  total: number
}
export function linkedActivities(data: Board, factId: string, limit = 20): Linked[] {
  const fact = data.facts.find(f => f.id === factId)
  if (!fact) return []
  const index = correlationIndex(data)
  const titles = new Map((data.sources ?? []).map(s => [s.id, s.title]))
  const groups = new Map<string, Linked>()
  const add = (kind: string, value: string, relation: Linked['relation'], use: KeyUse) => {
    if (use.fact === factId) return
    const id = `${kind}|${value}|${relation}`
    let group = groups.get(id)
    if (!group) groups.set(id, (group = { kind, value, relation, facts: [], total: 0 }))
    const known = group.facts.find(f => f.fact === use.fact)
    if (!known) group.facts.push({ fact: use.fact, at: use.at })
    else if (use.at && (!known.at || use.at < known.at)) known.at = use.at
  }
  for (const item of fact.assertions) {
    if (item.retracted_at || !item.note || item.note[0] !== '{') continue
    for (const key of keysOf(item.note, where(item, titles)))
      for (const use of index.get(`${key.kind}:${key.value}`) ?? []) {
        if (key.kind !== 'process') add(key.kind, key.value, 'same', use)
        else if (key.role === 'by') add('process', key.value, use.role === 'started' ? 'launched by' : 'also', use)
        else if (use.role === 'by') add('process', key.value, 'then', use)
      }
  }
  const order: Record<Linked['relation'], number> = { 'launched by': 0, then: 1, also: 2, same: 3 }
  const rank = (kind: string) => {
    const i = ['process', 'session', 'token', 'message'].indexOf(kind)
    return i < 0 ? 4 : i
  }
  return [...groups.values()]
    .map(g => ({
      ...g,
      total: g.facts.length,
      facts: g.facts.sort((a, b) => (a.at ?? '\uffff').localeCompare(b.at ?? '\uffff')).slice(0, limit),
    }))
    .sort((a, b) => rank(a.kind) - rank(b.kind) || a.kind.localeCompare(b.kind) || order[a.relation] - order[b.relation])
}
