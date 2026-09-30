import type { Assertion, Entity, EntityType, Fact, GraphData, Identifier, Source, TruthState } from './types'
import { initialPosition } from './layout'
import { uuid } from './uuid'

export type ActionType =
  | 'type.add' | 'type.update' | 'type.delete' | 'board.rename' | 'entity.add' | 'entity.update' | 'entity.position' | 'entity.delete' | 'entity.merge' | 'identifier.add' | 'identifier.delete'
  | 'source.add' | 'source.update' | 'source.delete' | 'fact.add' | 'fact.update' | 'fact.delete'
  | 'assertion.add' | 'assertion.update' | 'assertion.retract' | 'assertion.restore' | 'assertion.review' | 'assertion.delete' | 'action.undo' | 'action.redo' | 'identifier.update'

export type BoardAction = {
  boardId: string; id: string; actor: string; author: string; clock: number;
  at: string; batch_id?: string; channel?: string; type: ActionType; payload: Record<string, unknown>;
}
export type ActionDraft = { id?: string; type: ActionType; payload: Record<string, unknown>; at?: string; author?: string; batch_id?: string; channel?: string }
export type BoardProjection = { data: GraphData; name: string }

const actionTypes: ActionType[] = [
  'type.add', 'type.update', 'type.delete', 'board.rename', 'entity.add', 'entity.update', 'entity.position', 'entity.delete', 'entity.merge', 'identifier.add', 'identifier.delete',
  'source.add', 'source.update', 'source.delete', 'fact.add', 'fact.update', 'fact.delete',
  'assertion.add', 'assertion.update', 'assertion.retract', 'assertion.restore', 'assertion.review', 'assertion.delete', 'action.undo', 'action.redo', 'identifier.update',
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

export function truth(assertions: Assertion[]): TruthState {
  const active = new Set(assertions.filter(item => !item.retracted_at && item.review_status === 'confirmed').map(item => item.stance))
  if (active.has('supports') && active.has('refutes')) return 'disputed'
  if (active.has('supports')) return 'supported'
  if (active.has('refutes')) return 'refuted'
  return 'unknown'
}

export function project(boardId: string, operations: BoardAction[]): BoardProjection {
  const entityTypes = new Map<string, EntityType>()
  const entities = new Map<string, Entity>()
  const sources = new Map<string, Source>()
  const identifiers = new Map<string, Identifier>()
  const facts = new Map<string, Fact>()
  const assertions = new Map<string, Assertion>()
  const canonicalFacts = new Map<string, string>()
  const aliases = new Map<string, string>()
  let name = `Board ${boardId.slice(0, 8)}`
  let placementIndex = 0

  const ordered = sortActions(operations)
  const undone = undoneActions(ordered)

  for (const operation of ordered) {
    if (operation.type === 'action.undo' || operation.type === 'action.redo' || undone.has(operation.id)) continue
    try {
      const item = operation.payload
      const id = typeof item.id === 'string' ? item.id : ''
      switch (operation.type) {
        case 'type.add':
          if (id && typeof item.name === 'string') entityTypes.set(id, {id,name:item.name,color:String(item.color ?? '#8da9ce'),icon:String(item.icon ?? 'Box')})
          break
        case 'type.update': {
          const type = entityTypes.get(id)
          if (!type) break
          const oldName = type.name
          for (const key of ['name', 'color', 'icon'] as const) if (typeof item[key] === 'string') type[key] = item[key]
          for (const entity of entities.values()) if (entity.kind === oldName) entity.kind = type.name
          break
        }
        case 'type.delete': entityTypes.delete(id); break
        case 'board.rename':
          if (typeof item.name === 'string' && item.name.trim()) name = item.name.trim().slice(0, 80)
          break
        case 'entity.add':
          if (id && typeof item.name === 'string' && typeof item.kind === 'string' && !entities.has(id)) {
            const fallback = initialPosition(placementIndex++)
            entities.set(id, { id, name: item.name, kind: item.kind,
              description: String(item.description ?? ''), created_at: String(item.created_at ?? operation.at), identifiers: [],
              color: typeof item.color === 'string' ? item.color : undefined, pinned: item.pinned === true,
              position: validPosition(item.x, item.y) ? { x: item.x as number, y: item.y as number } : fallback })
          }
          break
        case 'entity.update': {
          const entity = entities.get(id)
          if (entity && item.color === null) entity.color = undefined
          if (entity && typeof item.pinned === 'boolean') entity.pinned = item.pinned
          if (entity) for (const field of ['name', 'kind', 'description', 'color'] as const) {
            if (typeof item[field] === 'string' && (field === 'description' || item[field].trim()))
              entity[field] = item[field].trim()
          }
          break
        }
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
        case 'entity.merge': {
          const sourceId = typeof item.source_id === 'string' ? item.source_id : ''
          const targetId = typeof item.target_id === 'string' ? item.target_id : ''
          if (!sourceId || !targetId || sourceId === targetId || !entities.has(sourceId) || !entities.has(targetId)) break
          for (const identifier of identifiers.values()) if (identifier.entity_id === sourceId) identifier.entity_id = targetId
          for (const [factId, fact] of [...facts]) {
            if (fact.subject_id !== sourceId && fact.object_id !== sourceId) continue
            canonicalFacts.delete(factKey(fact))
            if (fact.subject_id === sourceId) fact.subject_id = targetId
            if (fact.object_id === sourceId) fact.object_id = targetId
            for (const evidence of assertions.values()) if (evidence.fact_id === factId) invalidateReview(evidence)
            const key = factKey(fact)
            const existingId = canonicalFacts.get(key)
            if (existingId && existingId !== factId) {
              for (const assertion of assertions.values()) if (assertion.fact_id === factId) assertion.fact_id = existingId
              facts.delete(factId)
              aliases.set(factId, existingId)
            } else canonicalFacts.set(key, factId)
          }
          entities.delete(sourceId)
          break
        }
        case 'source.add':
          if (id && typeof item.title === 'string' && !sources.has(id))
            sources.set(id, { id, title: item.title, uri: String(item.uri ?? ''),
              excerpt: String(item.excerpt ?? ''), source_kind: item.source_kind === 'primary' || item.source_kind === 'secondary' ? item.source_kind : 'unknown', query: String(item.query ?? ''), revision: operation.id, created_at: String(item.created_at ?? operation.at) })
          break
        case 'source.update': {
          const source = sources.get(id)
          if (source) {
            source.revision = operation.id
            for (const evidence of assertions.values()) if (evidence.source_id === id) invalidateReview(evidence)
          }
          if (source && ['primary', 'secondary', 'unknown'].includes(String(item.source_kind))) source.source_kind = item.source_kind as Source['source_kind']
          if (source) for (const field of ['title', 'uri', 'excerpt', 'query'] as const)
            if (typeof item[field] === 'string' && (field !== 'title' || item[field].trim())) source[field] = item[field].trim()
          break
        }
        case 'source.delete':
          if (id) {
            sources.delete(id)
            for (const identifier of identifiers.values()) if (identifier.source_id === id) identifier.source_id = null
            for (const assertion of assertions.values()) if (assertion.source_id === id) { assertion.source_id = null; invalidateReview(assertion) }
          }
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
        case 'identifier.update': {
          const identifier = identifiers.get(id)
          if (identifier) {
            for (const field of ['scheme', 'namespace', 'raw_value'] as const) if (typeof item[field] === 'string') identifier[field] = item[field]
            identifier.normalized_value = normalizeIdentifier(identifier.scheme, identifier.raw_value)
            for (const field of ['source_id', 'valid_from', 'valid_to'] as const) if (field in item) identifier[field] = typeof item[field] === 'string' ? item[field] : null
            if (typeof item.confidence === 'number') identifier.confidence = item.confidence
          }
          break
        }
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
        case 'fact.update': {
          const canonical = aliases.get(id) ?? id
          const fact = facts.get(canonical)
          if (!fact) break
          for (const evidence of assertions.values()) if (evidence.fact_id === canonical) invalidateReview(evidence)
          const subject = typeof item.subject_id === 'string' ? item.subject_id : fact.subject_id
          const object = typeof item.object_id === 'string' ? item.object_id : fact.object_id
          if (!entities.has(subject) || !entities.has(object)) break
          canonicalFacts.delete(factKey(fact))
          fact.subject_id = subject; fact.object_id = object
          if (typeof item.predicate === 'string' && item.predicate.trim()) fact.predicate = item.predicate.trim()
          if (item.valid_from === null) fact.valid_from = null
          else if (typeof item.valid_from === 'string') fact.valid_from = item.valid_from
          if (item.valid_to === null) fact.valid_to = null
          else if (typeof item.valid_to === 'string') fact.valid_to = item.valid_to
          canonicalFacts.set(factKey(fact), canonical)
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
              valid_from: typeof item.valid_from === 'string' ? item.valid_from : null,
              valid_to: typeof item.valid_to === 'string' ? item.valid_to : null,
              note: String(item.note ?? ''), observation: String(item.observation ?? ''), locator: String(item.locator ?? ''), interpretation: String(item.interpretation ?? ''), review_status: 'unconfirmed', revision: operation.id, created_at: String(item.created_at ?? operation.at),
              retracted_at: typeof item.retracted_at === 'string' ? item.retracted_at : null })
          break
        }
        case 'assertion.update': {
          const assertion = assertions.get(id)
          if (assertion) {
            invalidateReview(assertion)
            assertion.revision = operation.id
            for (const field of ['locator', 'observation', 'interpretation'] as const) if (typeof item[field] === 'string') assertion[field] = item[field]
            if (item.stance === 'supports' || item.stance === 'refutes') assertion.stance = item.stance
            if (typeof item.confidence === 'number') assertion.confidence = Math.max(0, Math.min(1, item.confidence))
            if (item.source_id === null) assertion.source_id = null
            else if (typeof item.source_id === 'string') assertion.source_id = item.source_id
            if (typeof item.note === 'string') assertion.note = item.note
            if (item.valid_from === null) assertion.valid_from = null
            else if (typeof item.valid_from === 'string') assertion.valid_from = item.valid_from
            if (item.valid_to === null) assertion.valid_to = null
            else if (typeof item.valid_to === 'string') assertion.valid_to = item.valid_to
          }
          break
        }
        case 'assertion.review': {
          const evidence = assertions.get(id)
          if (!evidence || item.expected_revision !== evidence.revision) break
          if (item.review_status === 'unconfirmed') { invalidateReview(evidence); break }
          const source = sources.get(evidence.source_id ?? '')
          if (item.review_status !== 'confirmed' || evidence.retracted_at || !source ||
              source.source_kind !== 'primary' || !source.uri.trim() || !source.excerpt.trim() ||
              !evidence.locator?.trim() || !(evidence.observation || evidence.note).trim() ||
              !String(item.review_note ?? '').trim() || item.expected_source_revision !== source.revision) break
          evidence.review_status = 'confirmed'
          evidence.reviewed_by = operation.actor
          evidence.reviewed_at = operation.at
          evidence.review_note = String(item.review_note)
          evidence.reviewed_revision = evidence.revision
          evidence.reviewed_source_revision = source.revision
          break
        }
        case 'assertion.restore': {
          const evidence = assertions.get(id)
          if (evidence) { evidence.retracted_at = null; invalidateReview(evidence); evidence.revision = operation.id }
          break
        }
        case 'assertion.retract': {
          const assertion = assertions.get(id)
          if (assertion && !assertion.retracted_at) { assertion.retracted_at = String(item.retracted_at ?? operation.at); invalidateReview(assertion) }
          break
        }
        case 'assertion.delete':
          if (id) assertions.delete(id)
          break
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
    entity_types: [...entityTypes.values()],
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
  const drafts: ActionDraft[] = (graph.entity_types ?? []).map(type => ({type: 'type.add', payload: {...type}, author: 'Import'}))
  for (const source of graph.sources) drafts.push({ type: 'source.add', payload: { ...source }, author: 'Import' })
  for (const entity of graph.entities) drafts.push({ type: 'entity.add', payload: {
    id: entity.id, name: entity.name, kind: entity.kind, description: entity.description, created_at: entity.created_at, color: entity.color, x: entity.position?.x, y: entity.position?.y, pinned: entity.pinned,
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

function invalidateReview(evidence: Assertion) {
  evidence.review_status = 'unconfirmed'
  evidence.reviewed_at = null
  evidence.reviewed_by = null
  evidence.reviewed_revision = null
  evidence.reviewed_source_revision = null
}

export function undoneActions(ordered: BoardAction[]) {
  const undone = new Set<string>()
  for (const action of ordered) {
    if (action.type !== 'action.undo' && action.type !== 'action.redo') continue
    const targets = Array.isArray(action.payload.action_ids) ? action.payload.action_ids : [action.payload.action_id]
    for (const id of targets) if (typeof id === 'string') {
      if (action.type === 'action.undo') undone.add(id)
      else undone.delete(id)
    }
  }
  return undone
}
