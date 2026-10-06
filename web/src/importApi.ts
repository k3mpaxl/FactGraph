import { ownImportBatches } from './importBatches'
import type { ImportFormat, Inspection, PreviewRow } from './importFormats'
import { uuid } from './uuid'

/** Import failures that mean the browser was not reachable for a moment, not that the file is wrong. */
export const CONNECTION_ERROR = /Browser connection lost|Token is not connected|Board offline|did not confirm/

export class ImportProblem extends Error {}

async function answer<T>(response: Response): Promise<T> {
  const result = await response.json().catch(() => ({})) as Record<string, unknown>
  if (!response.ok) {
    const detail = result.detail as Record<string, unknown> | string | unknown[] | undefined
    const message = typeof detail === 'string' ? detail : Array.isArray(detail) ? detail.map(d => String((d as { msg?: string }).msg ?? '')).join('; ')
      : detail && typeof detail === 'object' ? String((detail as Record<string, unknown>).message ?? 'Import failed') : `Import failed (HTTP ${response.status})`
    throw new ImportProblem(message)
  }
  return result as T
}

/**
 * Upload one file to the import endpoint. auto = a built-in Defender XDR / Sentinel table, recognised by the server;
 * format = a column mapping the analyst made (JSON).
 */
export async function uploadImport(boardId: string, sessionToken: string, file: File, fields: Record<string, string>) {
  const body = new FormData()
  for (const [key, value] of Object.entries(fields)) body.set(key, value)
  if (fields.dry_run !== 'true') {
    // The server uses this ID for the whole import, so it is known here before the first action arrives.
    const batch = uuid()
    ownImportBatches.add(batch)
    body.set('batch_id', batch)
  }
  body.set('file', file)
  return answer<Record<string, unknown>>(await fetch(`/api/boards/${boardId}/imports/file`, { method: 'POST', headers: { 'X-FactGraph-Token': sessionToken }, body }))
}

/** Columns, sample values, built-in table and a suggested format of a file, before anything is imported. */
export async function inspectImport(boardId: string, sessionToken: string, file: File) {
  const body = new FormData()
  body.set('file', file)
  return answer<Inspection>(await fetch(`/api/boards/${boardId}/imports/inspect`, { method: 'POST', headers: { 'X-FactGraph-Token': sessionToken }, body }))
}

/** What a format makes of a few sample rows, computed by the same code as the import. */
export async function previewImport(boardId: string, sessionToken: string, rows: Record<string, unknown>[], format: ImportFormat) {
  return answer<{ rows: PreviewRow[]; missing: string[] }>(await fetch(`/api/boards/${boardId}/imports/preview`, {
    method: 'POST', headers: { 'X-FactGraph-Token': sessionToken, 'Content-Type': 'application/json' }, body: JSON.stringify({ rows, format }) }))
}

/** The fields that make the server import a file with a built-in table or with a format. */
export const importFields = (format: ImportFormat | null): Record<string, string> => format ? { format: JSON.stringify(format) } : { auto: 'true' }

export const describeTableImport = (r: Record<string, unknown>) => {
  const relationships = r.table === 'Log rows' || r.subject_field !== undefined
  return `${r.table} (${r.product}) · ${Number(r.rows).toLocaleString('en')} rows · ${r.new_entities !== undefined ? `${Number(r.new_entities).toLocaleString('en')} new of ` : ''}${Number(r.entities).toLocaleString('en')} entities · ${Number(r.relations).toLocaleString('en')} ${relationships ? 'relationships' : 'activities'} · ${Number(r.evidence).toLocaleString('en')} evidence items${r.duplicates ? ` · ${r.duplicates} repeated rows counted once` : ''}${r.skipped ? ` · ${r.skipped} rows skipped` : ''}`
}
