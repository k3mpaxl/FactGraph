import type { GraphData } from './types'

/**
 * Targeted reads for REST and MCP: one collection, filtered and paginated in the browser, so only the requested slice
 * crosses the WebSocket. Lists shorten long texts (source excerpts, evidence notes); a single record comes complete.
 */
export const COLLECTIONS: Record<string, keyof GraphData | 'evidence' | 'activities'> = {
  entities: 'entities', relations: 'facts', facts: 'facts', sources: 'sources', evidence: 'evidence', activities: 'activities',
  types: 'entity_types', entity_types: 'entity_types', groups: 'groups', perspectives: 'views', views: 'views',
}
export const LIST_TEXT = 2_000
const TEXT_FIELDS = ['excerpt', 'note', 'observation', 'query', 'interpretation', 'description', 'review_note']

type Item = Record<string, unknown>

export function records(data: GraphData, collection: string): Item[] {
  const key = COLLECTIONS[collection]
  if (!key) throw new Error(`Unknown collection ${collection}`)
  if (key === 'evidence') return data.facts.flatMap(f => f.assertions) as unknown as Item[]
  if (key === 'activities') return data.facts.filter(f => f.participants?.length) as unknown as Item[]
  return ((data as unknown as Record<string, unknown>)[key] as Item[] | undefined) ?? []
}

/** Long text fields cut to LIST_TEXT characters; `<field>_truncated` and `<field>_length` say so. Evidence inside relations too. */
export function shorten(item: Item): Item {
  const out: Item = { ...item }
  for (const field of TEXT_FIELDS) {
    const value = out[field]
    if (typeof value === 'string' && value.length > LIST_TEXT) {
      out[field] = value.slice(0, LIST_TEXT)
      out[`${field}_truncated`] = true
      out[`${field}_length`] = value.length
    }
  }
  if (Array.isArray(out.assertions)) out.assertions = (out.assertions as Item[]).map(shorten)
  return out
}

export function queryRecords(data: GraphData, options: { collection: string; q?: string; offset?: number; limit?: number; id?: string; entity_id?: string }) {
  let all = records(data, options.collection)
  // Activities (and relationships) of one entity, in any role.
  if (options.entity_id) all = all.filter(item => item.subject_id === options.entity_id || item.object_id === options.entity_id ||
    (Array.isArray(item.participants) && (item.participants as { entity_id: string }[]).some(p => p.entity_id === options.entity_id)))
  if (options.id !== undefined) {
    const record = all.find(item => item.id === options.id)
    return { record: record ?? null }
  }
  const needle = (options.q ?? '').trim().toLocaleLowerCase()
  // Search the complete record (including long texts); only the returned page is shortened.
  const matches = needle ? all.filter(item => JSON.stringify(item).toLocaleLowerCase().includes(needle)) : all
  const offset = Math.max(0, options.offset ?? 0)
  const limit = Math.min(1000, Math.max(1, options.limit ?? 100))
  return { items: matches.slice(offset, offset + limit).map(shorten), total: matches.length }
}

/**
 * Split a JSON message for the WebSocket into parts: Uvicorn closes connections on messages above 16 MiB, and one
 * reply can carry several large source excerpts. Parts are reassembled by the server before parsing.
 */
export const MAX_PART = 1_000_000
export function messageParts(requestId: string, payload: Record<string, unknown>, size = MAX_PART): string[] {
  const text = JSON.stringify({ type: 'api-result', requestId, ...payload })
  if (text.length <= size) return [text]
  const total = Math.ceil(text.length / size)
  return Array.from({ length: total }, (_, index) =>
    JSON.stringify({ type: 'api-result-part', requestId, index, total, data: text.slice(index * size, (index + 1) * size) }))
}

/** Uvicorn closes a connection on a message above 16 MiB; an action alone above this (with room for the envelope) cannot be sent. */
export const RELAY_LIMIT = 15 * 1024 * 1024
/** With gzip the limit applies to the compressed message; this caps what one action may be before compression (the relay accepts no more). */
export const COMPRESSED_RAW_LIMIT = 60 * 1024 * 1024
/** Messages above this are sent gzip-compressed in a binary frame (the relay inflates them). */
export const COMPRESS_ABOVE = 1_000_000

/** Keep at most this much queued on a socket before sending more (see drained). */
export const SEND_BACKLOG = 1_000_000

/**
 * Wait until the browser has passed most of what is queued on a socket to the network. Queuing a whole large sync at
 * once put the browser's own pong and heartbeat behind megabytes of upload: the server took the healthy browser for gone
 * and closed it, and the sync of a large board started over and over.
 */
export async function drained(socket: WebSocket, limit = SEND_BACKLOG) {
  while (socket.readyState === WebSocket.OPEN && socket.bufferedAmount > limit) await new Promise(resolve => setTimeout(resolve, 50))
}

/** gzip in the browser (CompressionStream); null where it is not available. */
export async function gzipText(text: string): Promise<Uint8Array | null> {
  if (typeof CompressionStream === 'undefined') return null
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

/**
 * Split actions for the relay by size as well as count, so a few very large actions never form one oversized message.
 * An action that alone exceeds RELAY_LIMIT is left out (and collected in `tooLarge`): sending it would close the
 * connection, and on reconnect the browser would send it again and again.
 */
export function actionChunks<T>(items: T[], maxCount = 100, maxChars = 4_000_000, tooLarge?: T[], limit = RELAY_LIMIT): T[][] {
  const chunks: T[][] = []
  let current: T[] = []
  let size = 0
  for (const item of items) {
    const text = JSON.stringify(item)
    const length = text.length
    // UTF-8 takes at most three bytes per UTF-16 unit, so only long texts need the exact count.
    if (length * 3 > limit && new TextEncoder().encode(text).length > limit) { tooLarge?.push(item); continue }
    if (current.length && (current.length >= maxCount || size + length > maxChars)) { chunks.push(current); current = []; size = 0 }
    current.push(item)
    size += length
  }
  if (current.length) chunks.push(current)
  return chunks
}

/**
 * A large message travels as one binary frame: "FGZ1", the length of a small JSON header (type, target), the header and the
 * gzip-compressed message. The relay reads only the header and forwards the frame as it is, so it neither inflates nor
 * re-serialises board data (memory) and the peers get it compressed as well (bandwidth).
 */
const MAGIC = [0x46, 0x47, 0x5a, 0x31]
export function packFrame(header: Record<string, unknown>, packed: Uint8Array): Uint8Array {
  const head = new TextEncoder().encode(JSON.stringify(header))
  const frame = new Uint8Array(8 + head.length + packed.length)
  frame.set(MAGIC, 0)
  new DataView(frame.buffer).setUint32(4, head.length)
  frame.set(head, 8)
  frame.set(packed, 8 + head.length)
  return frame
}

/** The message of a binary frame, or null if it is not one. */
export async function unpackFrame(data: ArrayBuffer): Promise<Record<string, unknown> | null> {
  const bytes = new Uint8Array(data)
  if (bytes.length < 8 || MAGIC.some((b, i) => bytes[i] !== b) || typeof DecompressionStream === 'undefined') return null
  const headLength = new DataView(data).getUint32(4)
  if (8 + headLength > bytes.length) return null
  const stream = new Blob([bytes.subarray(8 + headLength)]).stream().pipeThrough(new DecompressionStream('gzip'))
  try { return JSON.parse(await new Response(stream).text()) as Record<string, unknown> } catch { return null }
}
