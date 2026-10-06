import { uuid } from './uuid'

/**
 * Import formats: how the columns of one kind of export become entities, what happened, when and which row it was.
 * Built-in formats (Defender XDR, Sentinel) are recognised by the server; for any other export the analyst maps the
 * columns once in the import dialog and saves the mapping here, in this browser, for all boards. Every import that uses
 * a format sends it along (the server keeps nothing). Formats can be exported as a file and imported by colleagues.
 */

export type IdType = 'entra-object-id' | 'entra-app-id' | 'entra-device-id' | 'mde-device-id' | 'windows-sid' | 'sha256' | 'sha1' | 'md5' |
  'resource-id' | 'email' | 'ip' | 'fqdn' | 'other'
export const ID_TYPES: { id: IdType; label: string }[] = [
  { id: 'entra-object-id', label: 'Entra object ID' }, { id: 'entra-app-id', label: 'Entra app ID' }, { id: 'entra-device-id', label: 'Entra device ID' },
  { id: 'mde-device-id', label: 'Defender device ID' }, { id: 'windows-sid', label: 'Windows SID' }, { id: 'sha256', label: 'SHA-256' },
  { id: 'sha1', label: 'SHA-1' }, { id: 'md5', label: 'MD5' }, { id: 'resource-id', label: 'Azure resource ID' }, { id: 'email', label: 'E-mail / UPN' },
  { id: 'ip', label: 'IP address' }, { id: 'fqdn', label: 'Host name (FQDN)' }, { id: 'other', label: 'Other ID' },
]

/** Roles of the participants of an activity, as the board knows them, with what they mean for a log row. */
export const ROLE_LABELS: Record<string, string> = {
  actor: 'actor (who)', identity: 'identity (as whom)', source: 'source (from where)', tool: 'tool (with what)',
  via: 'via (through what)', target: 'target (on what)', other: 'other',
}
/** The longer explanation, shown as the tooltip of the role. */
export const ROLE_HELP: Record<string, string> = {
  actor: 'Who did it: a user or account', identity: 'As which identity: the account, app or service principal used',
  source: 'From where: an IP address or device', tool: 'With what: a key, token, certificate or other credential',
  via: 'Through which process or application', target: 'On what: the resource, file, URL or account acted on', other: 'Takes part in another way',
}

/**
 * An ID column of an entity. The entity's own column can be one: then its value is the ID (an object ID column without a
 * display name), and the entity is found by it. namespace: for "other", the ID namespace as the board knows it.
 */
export type IdColumn = { column: string; type: IdType; namespace?: string }
export type EntityColumn = { column: string; kind: string; role: string; ids: IdColumn[] }
export type ImportFormat = {
  version: 1; id: string; name: string
  /** activity: each row is an event with several participants; relationship: each row links the first entity to the second. */
  rows: 'activity' | 'relationship'
  /** Columns of the export the format was made from: further exports with (mostly) the same columns are recognised. */
  columns: string[]
  entities: EntityColumn[]
  /** What happened (or the relationship) when no operation column is given or it is empty. */
  operation: string
  operation_column: string | null
  time: string | null; end: string | null
  locator: string[]
  details: { column: string; label: string }[]
  created_at?: string; updated_at?: string; used_at?: string
}

/** Entities on the board whose names or IDs the values of a column are (e.g. object IDs from a Sentinel import). */
export type KnownOnBoard = { kind: string; id_type: IdType | null; namespace: string; matches: number; of: number }
export type ColumnProfile = { name: string; type: string; filled: number; of: number; samples: string[]; known?: KnownOnBoard | null }
export type Builtin = { table: string; product: string; roles?: { field: string; role: string; kind: string; identifiers?: string[] }[]; operation?: string | null; known_columns?: number; total_columns?: number; doc?: string }
/** What the server read from a file before anything is imported (POST /imports/inspect). */
export type Inspection = { file: string; rows: number; columns: ColumnProfile[]; sample: Record<string, unknown>[]; builtin: Builtin | null; suggestion: ImportFormat
  /** IDs in the sample rows that belong to entities on the board, with their names (lowercase ID → name). */
  board_names?: Record<string, string> }
export type PreviewRow = { row: number; time: string | null; end: string | null; operation: string; participants: { role: string; kind: string; name: string }[]; details: string[]; locator: string; skipped: string | null }

// ------------------------------------------------------------------------------------------------- editing

/** What one column is used for. A column has one use; the whole row always stays in the evidence. */
export type ColumnUse =
  | { use: 'ignore' }
  | { use: 'entity'; kind: string; role: string; own?: IdColumn | null }
  | { use: 'id'; of: string; type: IdType; namespace?: string }
  | { use: 'time' } | { use: 'end' } | { use: 'operation' } | { use: 'locator' }
  | { use: 'detail'; label: string }

export function useOf(format: ImportFormat, column: string): ColumnUse {
  const entity = format.entities.find(e => e.column === column)
  if (entity) return { use: 'entity', kind: entity.kind, role: entity.role, own: entity.ids.find(i => i.column === column) ?? null }
  const owner = format.entities.find(e => e.ids.some(i => i.column === column))
  if (owner) { const id = owner.ids.find(i => i.column === column)!; return { use: 'id', of: owner.column, type: id.type, namespace: id.namespace } }
  if (format.time === column) return { use: 'time' }
  if (format.end === column) return { use: 'end' }
  if (format.operation_column === column) return { use: 'operation' }
  if (format.locator.includes(column)) return { use: 'locator' }
  const detail = format.details.find(d => d.column === column)
  if (detail) return { use: 'detail', label: detail.label }
  return { use: 'ignore' }
}

/** The format with `column` used as `use` (and no longer as anything else). */
export function setUse(format: ImportFormat, column: string, use: ColumnUse): ImportFormat {
  const wasEntity = format.entities.some(e => e.column === column)
  let entities = format.entities.filter(e => e.column !== column).map(e => ({ ...e, ids: e.ids.filter(i => i.column !== column) }))
  let next: ImportFormat = { ...format, entities,
    time: format.time === column ? null : format.time, end: format.end === column ? null : format.end,
    operation_column: format.operation_column === column ? null : format.operation_column,
    locator: format.locator.filter(c => c !== column), details: format.details.filter(d => d.column !== column) }
  if (use.use === 'entity') {
    // Its ID columns stay; its own value is an ID when `own` says so.
    const before = wasEntity ? format.entities.find(e => e.column === column)!.ids.filter(i => i.column !== column) : []
    const own = use.own === undefined ? format.entities.find(e => e.column === column)?.ids.find(i => i.column === column) ?? null : use.own
    const entity = { column, kind: use.kind.trim() || 'Other', role: use.role || 'other', ids: own ? [{ ...own, column }, ...before] : before }
    // Keep the column's place: the first two entities of a relationship are its from and to.
    const at = format.entities.findIndex(e => e.column === column)
    entities = at >= 0 ? [...entities.slice(0, at), entity, ...entities.slice(at)] : [...entities, entity]
    next = { ...next, entities }
  } else if (use.use === 'id') next = { ...next, entities: entities.map(e => e.column === use.of ? { ...e, ids: [...e.ids, { column, type: use.type, ...(use.namespace ? { namespace: use.namespace } : {}) }] } : e) }
  else if (use.use === 'time') next.time = column
  else if (use.use === 'end') next.end = column
  else if (use.use === 'operation') next.operation_column = column
  else if (use.use === 'locator') next.locator = [...next.locator, column].slice(0, 5)
  else if (use.use === 'detail') next.details = [...next.details, { column, label: use.label }]
  return next
}

export const idLabel = (type: IdType, namespace?: string) =>
  type === 'other' && namespace ? `ID (${namespace})` : ID_TYPES.find(t => t.id === type)?.label ?? type

export function usedColumns(format: ImportFormat): string[] {
  return [...new Set([...format.entities.map(e => e.column), ...format.entities.flatMap(e => e.ids.map(i => i.column)),
    ...[format.operation_column, format.time, format.end].filter((c): c is string => !!c), ...format.locator, ...format.details.map(d => d.column)])]
}

/** What keeps a format from being used, in the words of the dialog (the server checks the same). */
export function formatProblems(format: ImportFormat): string[] {
  const problems: string[] = []
  if (!format.name.trim()) problems.push('Give the format a name.')
  if (format.rows === 'relationship' && format.entities.length !== 2) problems.push('A relationship needs exactly two entity columns: from and to.')
  if (format.rows === 'activity' && format.entities.length < 2) problems.push('Choose at least two columns as entities: who or what takes part in each event.')
  if (format.entities.some(e => !e.kind.trim())) problems.push('Every entity column needs a type.')
  if (!format.operation.trim() && !format.operation_column) problems.push(format.rows === 'relationship' ? 'Name the relationship.' : 'Say what happened, as text or from a column.')
  return problems
}

/** A suggestion or a saved format, ready for this file: a fresh name from the file name when it has none. */
export function draftFrom(format: ImportFormat, fileName: string, columns: string[]): ImportFormat {
  const base = fileName.replace(/\.[^.]+$/, '').replace(/[_-]?\d{4}-?\d{2}-?\d{2}.*$/, '').replace(/[_-]+/g, ' ').trim()
  return { ...format, version: 1, id: format.id || '', name: format.name || (base ? base[0].toUpperCase() + base.slice(1) : 'New format'), columns: format.columns.length ? format.columns : columns }
}

// ------------------------------------------------------------------------------------------------- recognising

/**
 * The saved format that fits these columns best: every column it uses must be there, and the columns mostly the same as
 * the export it was made from (another export of the same table, maybe with a column more or less).
 */
export function matchFormat(formats: ImportFormat[], columns: string[]): { format: ImportFormat; score: number } | null {
  const have = new Set(columns)
  let best: { format: ImportFormat; score: number } | null = null
  for (const format of formats) {
    if (!usedColumns(format).every(c => have.has(c))) continue
    const known = new Set(format.columns.length ? format.columns : usedColumns(format))
    const shared = [...known].filter(c => have.has(c)).length
    const score = shared / new Set([...known, ...columns]).size
    if (score >= 0.5 && (!best || score > best.score)) best = { format, score }
  }
  return best
}

export const fingerprint = (columns: string[]) => [...columns].sort().join('\u001f')

// ------------------------------------------------------------------------------------------------- storage

const KEY = 'factgraph:importFormats'
const text = (value: unknown, max = 300) => typeof value === 'string' && value.trim().length > 0 && value.length <= max

export function isFormat(value: unknown): value is ImportFormat {
  if (!value || typeof value !== 'object') return false
  const f = value as Partial<ImportFormat>
  return text(f.id, 100) && text(f.name, 120) && (f.rows === 'activity' || f.rows === 'relationship') && Array.isArray(f.columns) &&
    Array.isArray(f.entities) && f.entities.length > 0 && f.entities.every(e => !!e && text(e.column) && text(e.kind, 80) && typeof e.role === 'string' &&
      Array.isArray(e.ids) && e.ids.every(i => !!i && text(i.column) && ID_TYPES.some(t => t.id === i.type) && (i.namespace === undefined || typeof i.namespace === 'string'))) &&
    typeof f.operation === 'string' && (f.operation_column === null || text(f.operation_column)) && (f.time === null || text(f.time)) &&
    (f.end === null || text(f.end)) && Array.isArray(f.locator) && Array.isArray(f.details)
}

export function loadFormats(): ImportFormat[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) ?? '[]') as unknown
    return Array.isArray(parsed) ? parsed.filter(isFormat) : []
  } catch { return [] }
}

function store(formats: ImportFormat[]) {
  try { localStorage.setItem(KEY, JSON.stringify(formats)) } catch { /* private mode: kept for this session only */ }
  return formats
}

/** Save (by id) and return the stored list; a format without an id gets one. */
export function saveFormat(format: ImportFormat, now = new Date().toISOString()): { formats: ImportFormat[]; saved: ImportFormat } {
  const formats = loadFormats()
  const existing = formats.find(f => f.id === format.id)
  const saved: ImportFormat = { ...format, id: format.id || uuid(), name: format.name.trim(), created_at: existing?.created_at ?? format.created_at ?? now, updated_at: now }
  return { formats: store([...formats.filter(f => f.id !== saved.id), saved].sort((a, b) => a.name.localeCompare(b.name, 'en'))), saved }
}

export function deleteFormat(id: string) { return store(loadFormats().filter(f => f.id !== id)) }

export function markUsed(ids: string[], now = new Date().toISOString()) {
  return store(loadFormats().map(f => ids.includes(f.id) ? { ...f, used_at: now } : f))
}

export function exportFormats(formats: ImportFormat[]) {
  return JSON.stringify({ format: 'factgraph-import-formats-v1', formats }, null, 2)
}

/** Formats from a file a colleague exported; same id: the newer one wins. */
export function importFormats(textContent: string): { formats: ImportFormat[]; added: number } {
  const parsed = JSON.parse(textContent) as unknown
  const list = Array.isArray(parsed) ? parsed : (parsed as { formats?: unknown })?.formats
  if (!Array.isArray(list)) throw new Error('Not a FactGraph import format file')
  const incoming = list.filter(isFormat)
  if (!incoming.length) throw new Error('The file contains no valid import formats')
  const current = loadFormats()
  const byId = new Map(current.map(f => [f.id, f]))
  let added = 0
  for (const format of incoming) {
    const known = byId.get(format.id)
    if (!known) added++
    if (!known || (format.updated_at ?? '') > (known.updated_at ?? '')) byId.set(format.id, format)
  }
  return { formats: store([...byId.values()].sort((a, b) => a.name.localeCompare(b.name, 'en'))), added }
}
