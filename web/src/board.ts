import type { Assertion, Entity, Fact, GraphData, Identifier, Source, TruthState } from './types'
import { initialPosition } from './layout'
import { uuid } from './uuid'

export type ActionType =
  | 'board.rename' | 'entity.add' | 'entity.position' | 'entity.delete' | 'identifier.add' | 'identifier.delete'
  | 'source.add' | 'fact.add' | 'fact.delete' | 'assertion.add' | 'assertion.retract'

export type BoardAction = {
  boardId: string; id: string; actor: string; author: string; clock: number;
  at: string; type: ActionType; payload: Record<string, unknown>;
}
export type ActionDraft = { id?: string; type: ActionType; payload: Record<string, unknown>; at?: string; author?: string }
export type BoardProjection = { data: GraphData; name: string }

const actionTypes: ActionType[] = [
  'board.rename', 'entity.add', 'entity.position', 'entity.delete', 'identifier.add', 'identifier.delete',
  'source.add', 'fact.add', 'fact.delete', 'assertion.add', 'assertion.retract',
]

export function isAction(value: unknown): value is BoardAction {
  if (!value || typeof value !== 'object') return false
  const item = value as Partial<BoardAction>
  return typeof item.boardId === 'string' && typeof item.id === 'string' &&
    typeof item.actor === 'string' && typeof item.author === 'string' &&
    Number.isSafeInteger(item.clock) && (item.clock ?? -1) >= 0 &&
    typeof item.at === 'string' && actionTypes.includes(item.type as ActionType) &&
    !!item.payload && typeof item.payload === 'object' && !Array.isArray(item.payload)
}

export function isDraft(value: unknown): value is ActionDraft {
  if (!value || typeof value !== 'object') return false
  const item = value as Partial<ActionDraft>
  return (item.id === undefined || typeof item.id === 'string') &&
    actionTypes.includes(item.type as ActionType) && !!item.payload &&
    typeof item.payload === 'object' && !Array.isArray(item.payload) &&
    (item.author === undefined || typeof item.author === 'string')
}

export function sortActions(actions: BoardAction[]): BoardAction[] {
  const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0
  return [...actions].sort((a, b) => a.clock - b.clock || compare(a.actor, b.actor) || compare(a.id, b.id))
}

export function normalizeIdentifier(scheme: string, raw: string) {
  const trimmed = raw.trim()
  return ['hostname', 'fqdn', 'email'].includes(scheme.toLowerCase()) ? trimmed.replace(/\.$/, '').toLowerCase() : trimmed
}

export function factKey(fact: Pick<Fact, 'subject_id' | 'predicate' | 'object_id' | 'valid_from' | 'valid_to'>) {
  return JSON.stringify([fact.subject_id, fact.predicate.trim().toLowerCase(), fact.object_id,
    fact.valid_from ?? '', fact.valid_to ?? ''])
}

function truth(assertions: Assertion[]): TruthState {
  const active = new Set(assertions.filter(item => !item.retracted_at).map(item => item.stance))
  if (active.has('supports') && active.has('refutes')) return 'disputed'
  if (active.has('supports')) return 'supported'
  if (active.has('refutes')) return 'refuted'
  return 'unknown'
}

export function project(boardId: string, operations: BoardAction[]): BoardProjection {
  const entities = new Map<string, Entity>()
  const sources = new Map<string, Source>()
  const identifiers = new Map<string, Identifier>()
  const facts = new Map<string, Fact>()
  const assertions = new Map<string, Assertion>()
  const canonicalFacts = new Map<string, string>()
  const aliases = new Map<string, string>()
  let name = `Board ${boardId.slice(0, 8)}`
  let placementIndex = 0

  for (const operation of sortActions(operations)) {
    try {
      const item = operation.payload
      const id = typeof item.id === 'string' ? item.id : ''
      switch (operation.type) {
        case 'board.rename':
          if (typeof item.name === 'string' && item.name.trim()) name = item.name.trim().slice(0, 80)
          break
        case 'entity.add':
          if (id && typeof item.name === 'string' && typeof item.kind === 'string' && !entities.has(id)) {
            const fallback = initialPosition(placementIndex++)
            entities.set(id, { id, name: item.name, kind: item.kind,
              description: String(item.description ?? ''), created_at: String(item.created_at ?? operation.at), identifiers: [],
              position: validPosition(item.x, item.y) ? { x: item.x as number, y: item.y as number } : fallback })
          }
          break
        case 'entity.position': {
          const entity = entities.get(id)
          if (entity && validPosition(item.x, item.y))
            entity.position = { x: item.x as number, y: item.y as number }
          break
        }
        case 'entity.delete':
          if (id) {
            entities.delete(id)
            for (const [key, claim] of identifiers) if (claim.entity_id === id) identifiers.delete(key)
            for (const [key, fact] of facts) if (fact.subject_id === id || fact.object_id === id) {
              facts.delete(key)
              canonicalFacts.delete(factKey(fact))
              for (const [assertionId, assertion] of assertions) if (assertion.fact_id === key) assertions.delete(assertionId)
            }
          }
          break
        case 'source.add':
          if (id && typeof item.title === 'string' && !sources.has(id))
            sources.set(id, { id, title: item.title, uri: String(item.uri ?? ''),
              excerpt: String(item.excerpt ?? ''), created_at: String(item.created_at ?? operation.at) })
          break
        case 'identifier.add':
          if (id && typeof item.entity_id === 'string' && entities.has(item.entity_id) && !identifiers.has(id))
            identifiers.set(id, { id, entity_id: item.entity_id, scheme: String(item.scheme ?? 'other'),
              namespace: String(item.namespace ?? ''), raw_value: String(item.raw_value ?? ''),
              normalized_value: String(item.normalized_value ?? normalizeIdentifier(String(item.scheme ?? ''), String(item.raw_value ?? ''))),
              confidence: Number(item.confidence ?? 1), source_id: typeof item.source_id === 'string' ? item.source_id : null,
              valid_from: typeof item.valid_from === 'string' ? item.valid_from : null,
              valid_to: typeof item.valid_to === 'string' ? item.valid_to : null })
          break
        case 'identifier.delete':
          if (id) identifiers.delete(id)
          break
        case 'fact.add': {
          if (!id || typeof item.subject_id !== 'string' || typeof item.object_id !== 'string' ||
              !entities.has(item.subject_id) || !entities.has(item.object_id)) break
          const fact: Fact = { id, subject_id: item.subject_id, object_id: item.object_id,
            predicate: String(item.predicate ?? ''), valid_from: typeof item.valid_from === 'string' ? item.valid_from : null,
            valid_to: typeof item.valid_to === 'string' ? item.valid_to : null,
            created_at: String(item.created_at ?? operation.at), assertions: [], truth_state: 'unknown' }
          const key = factKey(fact)
          const existing = canonicalFacts.get(key)
          if (existing) aliases.set(id, existing)
          else { canonicalFacts.set(key, id); facts.set(id, fact) }
          break
        }
        case 'fact.delete': {
          const canonical = aliases.get(id) ?? id
          if (canonical) {
            const existing = facts.get(canonical)
            if (existing) canonicalFacts.delete(factKey(existing))
            facts.delete(canonical)
            for (const [assertionId, assertion] of assertions)
              if (assertion.fact_id === canonical) assertions.delete(assertionId)
          }
          break
        }
        case 'assertion.add': {
          const factId = typeof item.fact_id === 'string' ? (aliases.get(item.fact_id) ?? item.fact_id) : ''
          if (id && facts.has(factId) && !assertions.has(id) && (item.stance === 'supports' || item.stance === 'refutes'))
            assertions.set(id, { id, fact_id: factId, stance: item.stance, confidence: Number(item.confidence ?? 1),
              source_id: typeof item.source_id === 'string' ? item.source_id : null,
              note: String(item.note ?? ''), created_at: String(item.created_at ?? operation.at),
              retracted_at: typeof item.retracted_at === 'string' ? item.retracted_at : null })
          break
        }
        case 'assertion.retract': {
          const assertion = assertions.get(id)
          if (assertion && !assertion.retracted_at) assertion.retracted_at = String(item.retracted_at ?? operation.at)
          break
        }
      }
    } catch {
      // A malformed imported or remote action cannot prevent the rest of the board rendering.
    }
  }

  for (const claim of identifiers.values()) entities.get(claim.entity_id)?.identifiers.push(claim)
  for (const assertion of assertions.values()) facts.get(assertion.fact_id)?.assertions.push(assertion)
  for (const fact of facts.values()) {
    fact.assertions.sort((a, b) => b.created_at.localeCompare(a.created_at))
    fact.truth_state = truth(fact.assertions)
  }
  return { name, data: {
    entities: [...entities.values()].sort((a, b) => a.name.localeCompare(b.name, 'de')),
    facts: [...facts.values()].sort((a, b) => b.created_at.localeCompare(a.created_at)),
    sources: [...sources.values()].sort((a, b) => b.created_at.localeCompare(a.created_at)),
  } }
}

function validPosition(x: unknown, y: unknown): x is number {
  return typeof x === 'number' && typeof y === 'number' &&
    Number.isFinite(x) && Number.isFinite(y) && Math.abs(x) <= 100_000 && Math.abs(y) <= 100_000
}

export function demoDrafts(): ActionDraft[] {
  const at = new Date().toISOString()
  const day = new Date(Date.now() - 86_400_000).toISOString()
  const ids = Array.from({ length: 7 }, () => uuid())
  const [web, db, incident, team, firewall, note, relation] = ids
  const investigation = uuid()
  const review = uuid()
  return [
    { type: 'board.rename', payload: { name: 'Demo: Incident Analyse' }, author: 'Demo' },
    { type: 'source.add', payload: { id: firewall, title: 'Firewall-Log', uri: 'logs/firewall.csv', excerpt: '10.20.30.41 → db-prod:5432', created_at: at }, author: 'Demo' },
    { type: 'source.add', payload: { id: note, title: 'Admin-Notiz', uri: 'notizen/admin.md', excerpt: 'Keine direkte Datenbankverbindung im Wartungsfenster.', created_at: at }, author: 'Demo' },
    { type: 'entity.add', payload: { id: web, name: 'Webserver 01', kind: 'System', description: 'Produktionsserver im Web-Tier', created_at: at }, author: 'Demo' },
    { type: 'entity.add', payload: { id: db, name: 'Datenbank Cluster', kind: 'System', description: 'Primärer Datenbankverbund', created_at: at }, author: 'Demo' },
    { type: 'entity.add', payload: { id: incident, name: 'Incident', kind: 'Ereignis', description: 'Auffällige Verbindung', created_at: at }, author: 'Demo' },
    { type: 'entity.add', payload: { id: team, name: 'SOC Team', kind: 'Organisation', description: 'Analysiert die Belege', created_at: at }, author: 'Demo' },
    { type: 'identifier.add', payload: { id: uuid(), entity_id: web, scheme: 'hostname', namespace: 'prod', raw_value: 'WEB-01', normalized_value: 'web-01', confidence: 0.98, source_id: firewall, valid_from: null, valid_to: null }, author: 'Demo' },
    { type: 'fact.add', payload: { id: relation, subject_id: web, predicate: 'kommuniziert mit', object_id: db, valid_from: day, valid_to: null, created_at: at }, author: 'Demo' },
    { type: 'assertion.add', payload: { id: uuid(), fact_id: relation, stance: 'supports', confidence: 0.96, source_id: firewall, note: 'Verbindung im Log sichtbar.', created_at: at }, author: 'Demo' },
    { type: 'assertion.add', payload: { id: uuid(), fact_id: relation, stance: 'refutes', confidence: 0.65, source_id: note, note: 'Admin bestreitet direkte Verbindung.', created_at: at }, author: 'Demo' },
    { type: 'fact.add', payload: { id: investigation, subject_id: incident, predicate: 'betrifft', object_id: web, valid_from: day, valid_to: null, created_at: at }, author: 'Demo' },
    { type: 'assertion.add', payload: { id: uuid(), fact_id: investigation, stance: 'supports', confidence: 0.94, source_id: firewall, note: '', created_at: at }, author: 'Demo' },
    { type: 'fact.add', payload: { id: review, subject_id: team, predicate: 'untersucht', object_id: incident, valid_from: day, valid_to: null, created_at: at }, author: 'Demo' },
    { type: 'assertion.add', payload: { id: uuid(), fact_id: review, stance: 'supports', confidence: 1, source_id: note, note: '', created_at: at }, author: 'Demo' },
  ]
}

export function legacyDrafts(value: unknown): ActionDraft[] {
  if (!value || typeof value !== 'object') throw new Error('Ungültige JSON-Datei')
  const graph = value as Partial<GraphData>
  if (!Array.isArray(graph.entities) || !Array.isArray(graph.facts) || !Array.isArray(graph.sources))
    throw new Error('Keine FactGraph-Exportdatei')
  const drafts: ActionDraft[] = []
  for (const source of graph.sources) drafts.push({ type: 'source.add', payload: { ...source }, author: 'Import' })
  for (const entity of graph.entities) drafts.push({ type: 'entity.add', payload: {
    id: entity.id, name: entity.name, kind: entity.kind, description: entity.description, created_at: entity.created_at,
  }, author: 'Import' })
  for (const entity of graph.entities) for (const identifier of entity.identifiers ?? [])
    drafts.push({ type: 'identifier.add', payload: { ...identifier }, author: 'Import' })
  for (const fact of graph.facts) {
    drafts.push({ type: 'fact.add', payload: { id: fact.id, subject_id: fact.subject_id,
      predicate: fact.predicate, object_id: fact.object_id, valid_from: fact.valid_from,
      valid_to: fact.valid_to, created_at: fact.created_at }, author: 'Import' })
    for (const assertion of fact.assertions ?? []) drafts.push({ type: 'assertion.add', payload: { ...assertion }, author: 'Import' })
  }
  return drafts
}
