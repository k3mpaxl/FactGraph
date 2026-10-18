import type { Entity, Fact, GraphData } from './types'
import { analyzeImpact, compromiseOf, type Impact } from './impact'
import { huntingQueries } from './hunting'
import { correlationIndex } from './correlation'
import { rowKey } from './rowKey'

/**
 * What the board still lacks to make its entities and their relationships clear, as questions an agent (or analyst)
 * answers with one query each: who a user is and which roles they hold, what a device is and who uses it, which app a
 * service principal is, where a process came from, and the hunts the attack impact suggests that nothing answered yet.
 * Every gap carries filled-in KQL and says which built-in table mapping reads its result rows; submit_gap_rows imports
 * them and closes the gap. A gap answered (also with no rows: "nothing there" is an answer) is remembered on the board
 * as a source with the URI factgraph:gap/<id>, so every browser and agent sees it closed.
 */
export type Gap = {
  id: string
  rule: GapRule
  priority: 'high' | 'medium' | 'low'
  question: string
  why: string
  /** Entities the answer is about (the IDs submit_gap_rows marks as answered). */
  entities: string[]
  tables: string[]
  /** Where the query runs: Defender XDR advanced hunting, or Microsoft Sentinel / Log Analytics. */
  platform: 'defender' | 'sentinel'
  query: string
  /** The built-in mapping that imports the result rows; without one the rows are kept as a source. */
  imports_as?: string
}
export type GapRule = 'identity-info' | 'device-info' | 'app-info' | 'process-launch' | 'hunt'
export type AnsweredGap = { id: string; rule: string; entities: string[]; rows: number; note: string; source_id: string; at: string }
export type GapReport = { gaps: Gap[]; answered: AnsweredGap[] }

export const GAP_URI = 'factgraph:gap/'
const MAX_VALUES = 200
const literal = (value: string) => `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
const list = (values: string[]) => `dynamic([${values.map(literal).join(', ')}])`
const ids = (entity: Entity, namespace: string) => entity.identifiers.filter(i => i.namespace === namespace).map(i => i.normalized_value)
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const hash = (parts: string[]) => rowKey([...parts].sort().join('\n')).slice(0, 12)

/** Gaps answered on the board: sources whose URI names the gap, with what the answer covered. */
export function answeredGaps(data: Pick<GraphData, 'sources'>): AnsweredGap[] {
  const out: AnsweredGap[] = []
  for (const source of data.sources) {
    if (!source.uri?.startsWith(GAP_URI)) continue
    let meta: Record<string, unknown> = {}
    try {
      meta = JSON.parse(source.excerpt.slice(0, source.excerpt.indexOf('\n') > 0 ? source.excerpt.indexOf('\n') : undefined))
    } catch {
      /* an answer written by hand */
    }
    const id = source.uri.slice(GAP_URI.length)
    out.push({
      id,
      rule: typeof meta.rule === 'string' ? meta.rule : id.split(':')[0],
      entities: Array.isArray(meta.entities) ? meta.entities.filter((e): e is string => typeof e === 'string') : [],
      rows: typeof meta.rows === 'number' ? meta.rows : 0,
      note: typeof meta.note === 'string' ? meta.note : '',
      source_id: source.id,
      at: source.created_at,
    })
  }
  return out
}

/**
 * The entities the attack touches: the attacker's activities, everything that met a marked entity (a device that
 * connected to the attacker's IP is not the attacker's activity, but it matters), pivots and impacted resources. Before
 * anything is marked: every connected entity.
 */
function relevant(data: Pick<GraphData, 'entities' | 'facts'>, impact: Impact): Set<string> {
  const out = new Set<string>()
  const ends = (fact: Fact) => (fact.participants?.length ? fact.participants.map(p => p.entity_id) : [fact.subject_id, fact.object_id])
  if (impact.seeds.length) {
    for (const attack of impact.facts.values()) for (const id of ends(attack.fact)) out.add(id)
    for (const fact of data.facts) if (ends(fact).some(id => impact.marks.has(id))) for (const id of ends(fact)) out.add(id)
    for (const pivot of impact.pivots) out.add(pivot.entity.id)
    for (const hit of impact.impacted) out.add(hit.entity.id)
  } else for (const fact of data.facts) for (const id of ends(fact)) out.add(id)
  return out
}

/** UTC times of the evidence of these facts, for a query window that also finds what happened just before. */
function windowOf(facts: Fact[]): string {
  const times = facts.flatMap(f => f.assertions.map(a => a.valid_from).filter((t): t is string => !!t && !Number.isNaN(Date.parse(t))))
  if (!times.length) return 'let start = ago(30d);\nlet end = now();\n'
  times.sort()
  const day = 86_400_000
  return `let start = datetime(${new Date(Date.parse(times[0]) - 7 * day).toISOString()});\nlet end = datetime(${new Date(Date.parse(times.at(-1)!) + day).toISOString()});\n`
}

export function boardGaps(data: GraphData, impact: Impact = analyzeImpact(data)): GapReport {
  const answered = answeredGaps(data)
  const covered = new Map<string, Set<string>>()
  for (const answer of answered) {
    const set = covered.get(answer.rule) ?? new Set<string>()
    for (const id of answer.entities) set.add(id)
    set.add(answer.id)
    covered.set(answer.rule, set)
  }
  const isCovered = (rule: GapRule, id: string) => covered.get(rule)?.has(id) ?? false
  const scope = relevant(data, impact)
  const byId = new Map(data.entities.map(e => [e.id, e]))
  const marked = (id: string) => impact.marks.get(id) === 'compromised' || impact.marks.get(id) === 'derived'
  const candidates = (pattern: RegExp, rule: GapRule, usable: (e: Entity) => boolean) =>
    [...scope]
      .map(id => byId.get(id))
      .filter((e): e is Entity => !!e && pattern.test(e.kind) && usable(e) && !isCovered(rule, e.id))
      .sort((a, b) => Number(marked(b.id)) - Number(marked(a.id)) || Number(GUID.test(b.name)) - Number(GUID.test(a.name)))
      .slice(0, MAX_VALUES)
  const gaps: Gap[] = []
  const add = (gap: Omit<Gap, 'id'>, covers: string[]) => gaps.push({ id: `${gap.rule}:${hash(covers)}`, ...gap })
  const urgent = (entities: Entity[]) => entities.some(e => marked(e.id) || GUID.test(e.name))

  // Users: names, on-premises SID (joins Windows logons and DeviceInfo's logged-on users) and Entra roles.
  const users = candidates(
    /\buser\b|account|person/i,
    'identity-info',
    e => ids(e, 'entra-object-id').length > 0 || e.identifiers.some(i => i.scheme === 'email'),
  )
  const userIds = users.flatMap(e => ids(e, 'entra-object-id'))
  const upns = users.flatMap(e => e.identifiers.filter(i => i.scheme === 'email').map(i => i.normalized_value))
  if (userIds.length || upns.length)
    add(
      {
        rule: 'identity-info',
        priority: urgent(users) ? 'high' : 'medium',
        question: `Who ${users.length === 1 ? 'is this user' : `are these ${users.length} users`}, and which Entra roles do they hold?`,
        why: 'Names users known only by an ID, adds the on-premises SID (so Windows logons and logged-on users join the same entity) and the active and PIM-eligible Entra roles as "holds roles": who is privileged, and who else holds the same role.',
        entities: users.map(e => e.id),
        tables: ['IdentityInfo'],
        platform: 'defender',
        imports_as: 'IdentityInfo',
        query: `IdentityInfo\n| where ${[userIds.length && `AccountObjectId in~ (${list(userIds)})`, upns.length && `AccountUpn in~ (${list(upns)})`].filter(Boolean).join(' or ')}\n| summarize arg_max(Timestamp, *) by AccountObjectId`,
      },
      users.map(e => e.id),
    )

  // Devices: Defender and Entra device IDs, public IPs it reported from (the egress), who is logged on.
  const reported = new Set(
    data.facts
      .filter(f => /^reported (from public IP|logged-on users)$/.test(f.predicate))
      .flatMap(f => (f.participants ?? []).map(p => p.entity_id)),
  )
  const devices = candidates(/device|host|workstation|server|endpoint|machine/i, 'device-info', e => !reported.has(e.id))
  const deviceIds = devices.flatMap(e => ids(e, 'mde-device-id'))
  const aadIds = devices.flatMap(e => ids(e, 'entra-device-id'))
  const names = devices.filter(e => !ids(e, 'mde-device-id').length).map(e => e.name)
  if (devices.length)
    add(
      {
        rule: 'device-info',
        priority: urgent(devices) ? 'high' : 'medium',
        question: `What ${devices.length === 1 ? 'is this device' : `are these ${devices.length} devices`}: its IDs, the public IPs it was online from, and who was logged on?`,
        why: 'Adds the Defender and Entra device IDs (so sign-ins and endpoint events join the same device), the public IPs it reported from (the legitimate egress: an attacker IP is then told apart from the office) and the logged-on users already on the board.',
        entities: devices.map(e => e.id),
        tables: ['DeviceInfo'],
        platform: 'defender',
        imports_as: 'DeviceInfo',
        query: `DeviceInfo\n| where Timestamp > ago(30d)\n| where ${[deviceIds.length && `DeviceId in~ (${list(deviceIds)})`, aadIds.length && `AadDeviceId in~ (${list(aadIds)})`, names.length && `DeviceName in~ (${list(names)})`].filter(Boolean).join(' or ')}\n| summarize arg_max(Timestamp, *) by DeviceId, PublicIP`,
      },
      devices.map(e => e.id),
    )

  // Apps and service principals: which app it is, its privilege level and permissions.
  const apps = candidates(
    /service principal|application|managed identity|^service$|\bapp\b/i,
    'app-info',
    e => ids(e, 'entra-app-id').length > 0 || ids(e, 'entra-object-id').length > 0,
  )
  const appIds = apps.flatMap(e => ids(e, 'entra-app-id'))
  const spIds = apps.filter(e => /service principal|managed identity/i.test(e.kind)).flatMap(e => ids(e, 'entra-object-id'))
  if (appIds.length || spIds.length)
    add(
      {
        rule: 'app-info',
        priority: urgent(apps) ? 'high' : 'low',
        question: `Which ${apps.length === 1 ? 'app is this' : `apps are these ${apps.length}`}, and how privileged?`,
        why: 'Names apps known only by an ID and links a service principal to the app users sign in to; the privilege level, permissions and consent are in the evidence row.',
        entities: apps.map(e => e.id),
        tables: ['OAuthAppInfo'],
        platform: 'defender',
        imports_as: 'OAuthAppInfo',
        query: `OAuthAppInfo\n| where ${[appIds.length && `OAuthAppId in~ (${list(appIds)})`, spIds.length && `ServicePrincipalId in~ (${list(spIds)})`].filter(Boolean).join(' or ')}\n| summarize arg_max(Timestamp, *) by OAuthAppId`,
      },
      apps.map(e => e.id),
    )

  // Processes whose launch is not on the board: the parent, the command line and who started it.
  const index = correlationIndex(data)
  const launched = new Set<string>()
  for (const [key, uses] of index) if (key.startsWith('process:') && uses.some(u => u.role === 'started')) launched.add(key.slice(8))
  // Facts that matter: the attacker's activities and whatever met a marked entity (everything, before anything is marked).
  const attackFacts = new Set(impact.facts.keys())
  for (const fact of data.facts)
    if ((fact.participants?.map(p => p.entity_id) ?? [fact.subject_id, fact.object_id]).some(id => impact.marks.has(id)))
      attackFacts.add(fact.id)
  const missing = new Map<string, { facts: Set<string>; attack: boolean }>()
  for (const [key, uses] of index) {
    if (!key.startsWith('process:') || launched.has(key.slice(8))) continue
    for (const use of uses) {
      if (use.role !== 'by') continue
      const inScope = attackFacts.size ? attackFacts.has(use.fact) : true
      if (!inScope) continue
      const entry = missing.get(key.slice(8)) ?? { facts: new Set<string>(), attack: false }
      entry.facts.add(use.fact)
      entry.attack ||= attackFacts.has(use.fact)
      missing.set(key.slice(8), entry)
    }
  }
  const processKeys = [...missing.keys()].filter(k => !isCovered('process-launch', k)).slice(0, MAX_VALUES)
  if (processKeys.length) {
    const facts = data.facts.filter(f => processKeys.some(k => missing.get(k)!.facts.has(f.id)))
    add(
      {
        rule: 'process-launch',
        priority: processKeys.some(k => missing.get(k)!.attack) ? 'high' : 'medium',
        question: `Where did ${processKeys.length === 1 ? 'this process' : `these ${processKeys.length} processes`} come from: parent, command line, account?`,
        why: 'Activities on the board ran in processes whose launch is not on the board (DeviceProcessEvents by the process start key and device). The launch shows the command line and the parent, the next step back in the attack chain.',
        entities: processKeys,
        tables: ['DeviceProcessEvents'],
        platform: 'defender',
        imports_as: 'DeviceProcessEvents',
        query: `${windowOf(facts)}DeviceProcessEvents\n| where Timestamp between (start .. end)\n| where strcat(tolower(DeviceId), "|", tostring(ProcessUniqueId)) in (${list(processKeys)})`,
      },
      processKeys,
    )
  }

  // The hunts the attack impact suggests for tables nothing was imported from yet.
  const urgentHunts = new Set(['session-replay', 'signin-session', 'ip-everywhere', 'credential-usage'])
  for (const hunt of huntingQueries(data, impact)) {
    if (hunt.imported) continue
    const id = `hunt:${hunt.id}:${hash([hunt.query])}`
    if (isCovered('hunt', id)) continue
    gaps.push({
      id,
      rule: 'hunt',
      priority: urgentHunts.has(hunt.id) ? 'high' : 'medium',
      question: hunt.title,
      why: hunt.why,
      entities: [],
      tables: hunt.tables,
      platform: 'sentinel',
      query: hunt.query,
      ...(hunt.importable ? { imports_as: hunt.importable } : {}),
    })
  }
  const order = { high: 0, medium: 1, low: 2 }
  gaps.sort((a, b) => order[a.priority] - order[b.priority])
  return { gaps, answered }
}

/**
 * The neighbourhood of an entity up to `hops` steps (1–3): the entities and the relationships and activities between
 * them, each shortened, so an agent reads what it needs instead of the whole board.
 */
export function neighborhood(data: GraphData, entityId: string, hops = 1, limit = 200) {
  const byId = new Map(data.entities.map(e => [e.id, e]))
  if (!byId.has(entityId)) return null
  const ends = (fact: Fact) => (fact.participants?.length ? fact.participants.map(p => p.entity_id) : [fact.subject_id, fact.object_id])
  const touching = new Map<string, Fact[]>()
  for (const fact of data.facts) for (const id of ends(fact)) touching.set(id, [...(touching.get(id) ?? []), fact])
  const seen = new Set([entityId])
  const facts = new Map<string, Fact>()
  let frontier = [entityId]
  for (let step = 0; step < Math.min(Math.max(hops, 1), 3) && frontier.length && facts.size < limit; step++) {
    const next: string[] = []
    for (const id of frontier)
      for (const fact of touching.get(id) ?? []) {
        if (facts.size >= limit) break
        if (!facts.has(fact.id)) facts.set(fact.id, fact)
        for (const other of ends(fact)) if (!seen.has(other)) (seen.add(other), next.push(other))
      }
    frontier = next
  }
  const times = (fact: Fact) =>
    fact.assertions
      .map(a => a.valid_from)
      .filter((t): t is string => !!t)
      .sort()
  return {
    entity_id: entityId,
    hops: Math.min(Math.max(hops, 1), 3),
    truncated: facts.size >= limit,
    entities: [...seen]
      .map(id => byId.get(id)!)
      .filter(Boolean)
      .map(e => ({
        id: e.id,
        name: e.name,
        kind: e.kind,
        identifiers: e.identifiers.map(i => `${i.namespace || i.scheme}:${i.raw_value}`).slice(0, 8),
        ...(compromiseOf(e) ? { compromise: compromiseOf(e) } : {}),
      })),
    relations: [...facts.values()].map(f => {
      const t = times(f)
      return {
        id: f.id,
        predicate: f.predicate,
        truth_state: f.truth_state,
        ...(f.participants?.length ? { participants: f.participants } : { subject_id: f.subject_id, object_id: f.object_id }),
        evidence: f.assertions.filter(a => !a.retracted_at).length,
        ...(t.length ? { first: t[0], last: t.at(-1) } : {}),
      }
    }),
  }
}
