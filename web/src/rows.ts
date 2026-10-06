import type { Assertion } from './types'

/** The fields an analyst looks at first, picked from the original row of an evidence item (any table). */
export const ROW_FIELDS: [string, string[]][] = [
  ['Operation', ['OperationNameValue', 'OperationName', 'event_type', 'details.event_name', 'Operation', 'CredentialChange', 'ActionType']],
  ['Command line', ['ProcessCommandLine', 'CommandLine', 'InitiatingProcessCommandLine']],
  ['Parent process', ['InitiatingProcessFileName', 'ParentProcessName', 'InitiatingProcessParentFileName']],
  ['Device', ['DeviceName', 'Computer', 'HostName']],
  ['Who', ['Caller', 'ServicePrincipalName', 'UserPrincipalName', 'author_name', 'Actor', 'AccountUpn', 'InitiatingProcessAccountUpn', 'AccountName']],
  ['File', ['FileName', 'FolderPath', 'SHA256']],
  ['Remote', ['RemoteUrl', 'RemoteIP', 'DestinationIp']],
  ['On', ['_ResourceId', 'ResourceDisplayName', 'entity_path', 'Application', 'target_details']],
  ['IP', ['IPAddress', 'CallerIpAddress', 'CallerIPAddress', 'ip_address', 'ClientIP', 'RemoteIP', 'ActorIp']],
  ['Result', ['ResultType', 'ActivityStatusValue', 'Result', 'ResultSignature', 'ActionType']],
  ['Location', ['Location', 'LocationDetails.countryOrRegion']],
  ['ASN', ['AutonomousSystemNumber']],
  ['Credential', ['ServicePrincipalCredentialKeyId', 'KeyId', 'ClientCredentialType']],
  ['User agent', ['UserAgent', 'user_agent']],
  ['Session', ['UniqueTokenIdentifier', 'Claims.uti', 'SignInActivityId']],
  ['Correlation', ['CorrelationId', 'correlation_id']],
]
const rowCache = new WeakMap<Assertion, Record<string, unknown> | null>()
export function rowOf(assertion: Assertion): Record<string, unknown> | null {
  if (rowCache.has(assertion)) return rowCache.get(assertion)!
  let row: Record<string, unknown> | null = null
  if (assertion.note?.startsWith('{')) try { row = JSON.parse(assertion.note) } catch { row = null }
  rowCache.set(assertion, row)
  return row
}
const pick = (row: Record<string, unknown>, path: string) => path.split('.').reduce<unknown>((v, k) => v && typeof v === 'object' ? (v as Record<string, unknown>)[k] : undefined, row)
export function rowFields(assertion: Assertion): [string, string][] {
  const row = rowOf(assertion)
  if (!row) return []
  const fields: [string, string][] = []
  for (const [label, paths] of ROW_FIELDS) {
    const value = paths.map(path => pick(row, path)).find(v => v !== undefined && v !== null && v !== '')
    if (value !== undefined && typeof value !== 'object') fields.push([label, String(value)])
  }
  return fields
}


/** The column of a row that holds a given time (which one the import used as the event time), if any. */
export function timeSourceOf(row: Record<string, unknown> | null, iso: string | null): string | null {
  if (!row || !iso) return null
  const target = Date.parse(iso)
  if (Number.isNaN(target)) return null
  for (const [key, value] of Object.entries(row)) {
    if (typeof value !== 'string' || !/\d{4}-\d\d-\d\d|\d{1,2}\/\d{1,2}\/\d{4}/.test(value)) continue
    const parsed = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(value.trim()) || !/T|\d:\d/.test(value) ? value : `${value.replace(' ', 'T')}Z`)
    if (!Number.isNaN(parsed) && Math.abs(parsed - target) < 1000) return key
  }
  return null
}

/** The keys of a row in reading order: the fields an analyst looks at first, then the rest that has a value. */
export function orderedKeys(row: Record<string, unknown>): string[] {
  const first: string[] = []
  for (const [, paths] of ROW_FIELDS) for (const path of paths) { const key = path.split('.')[0]; if (key in row && !first.includes(key)) { first.push(key); break } }
  const filled = (k: string) => row[k] !== undefined && row[k] !== null && row[k] !== ''
  return [...first.filter(filled), ...Object.keys(row).filter(k => !first.includes(k) && filled(k))]
}
