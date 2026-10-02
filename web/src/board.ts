import type { Assertion, Entity, EntityType, Fact, GraphData, Group, GroupRule, Identifier, Participant, Perspective, Source, TruthState } from './types'
import { initialPosition } from './layout'
import { uuid } from './uuid'

export type ActionType =
  | 'type.add' | 'type.update' | 'type.delete' | 'board.rename' | 'entity.add' | 'entity.update' | 'entity.position' | 'entity.delete' | 'entity.merge' | 'identifier.add' | 'identifier.delete'
  | 'source.add' | 'source.update' | 'source.delete' | 'fact.add' | 'fact.update' | 'fact.delete'
  | 'assertion.add' | 'assertion.update' | 'assertion.retract' | 'assertion.restore' | 'assertion.review' | 'assertion.delete' | 'action.undo' | 'action.redo' | 'identifier.update'
  | 'fact.position' | 'group.add' | 'group.update' | 'group.delete' | 'view.add' | 'view.update' | 'view.delete'

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
  'fact.position', 'group.add', 'group.update', 'group.delete', 'view.add', 'view.update', 'view.delete',
]
export const CONTAINS_PREDICATES = ['contains', 'runs', 'hosts', 'includes', 'enthält', 'has']

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

export function factKey(fact: Pick<Fact, 'subject_id' | 'predicate' | 'object_id' | 'valid_from' | 'valid_to'> & { participants?: Participant[] }) {
  const base = [fact.subject_id, fact.predicate.trim().toLowerCase(), fact.object_id, fact.valid_from ?? '', fact.valid_to ?? '']
  // Activities with the same operation but different participants are different events.
  return JSON.stringify(fact.participants?.length ? [...base, participantKey(fact.participants)] : base)
}

export function participantKey(participants: Participant[]) {
  return participants.map(p => `${p.role.trim().toLowerCase()}:${p.entity_id}`).sort().join('|')
}

export function parseParticipants(value: unknown): Participant[] | null {
  if (!Array.isArray(value)) return null
  const seen = new Set<string>()
  const items: Participant[] = []
  for (const item of value) {
    if (!item || typeof item !== 'object') return null
    const entity_id = (item as Record<string, unknown>).entity_id, role = (item as Record<string, unknown>).role
    if (typeof entity_id !== 'string' || typeof role !== 'string' || !role.trim()) return null
    const key = `${role.trim().toLowerCase()}:${entity_id}`
    if (!seen.has(key)) { seen.add(key); items.push({ entity_id, role: role.trim().toLowerCase() }) }
  }
  return items
}

/** Subject is the first acting participant, object the first target; this keeps activities usable as edges. */
export function activityEnds(participants: Participant[]) {
  const target = participants.find(p => p.role === 'target') ?? participants[participants.length - 1]
  const subject = participants.find(p => p.entity_id !== target.entity_id && p.role !== 'target') ?? participants.find(p => p.entity_id !== target.entity_id) ?? participants[0]
  return { subject_id: subject.entity_id, object_id: target.entity_id }
}

function parseRule(value: unknown): GroupRule | null {
  if (!value || typeof value !== 'object') return null
  const item = value as Record<string, unknown>
  const kinds = Array.isArray(item.kinds) ? item.kinds.filter((k): k is string => typeof k === 'string' && !!k.trim()) : []
  const match = typeof item.match === 'string' ? item.match : ''
  const container_id = typeof item.container_id === 'string' ? item.container_id : null
  return kinds.length || match.trim() || container_id ? { kinds, match, container_id } : null
}
const ids = (value: unknown) => Array.isArray(value) ? [...new Set(value.filter((v): v is string => typeof v === 'string'))] : []

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
  // Merged entity IDs keep pointing at their target, so concurrent edits by other analysts that still
  // reference the old ID (made offline or before the merge arrived) land on the merged entity instead of vanishing.
  const merged = new Map<string, string>()
  const entityRef = (value: unknown): unknown => {
    if (typeof value !== 'string') return value
    let current = value
    for (let hops = 0; merged.has(current) && hops < 50; hops++) current = merged.get(current)!
    return current
  }
  const refParticipants = (value: unknown) => {
    const list = parseParticipants(value)
    return list ? parseParticipants(list.map(p => ({ ...p, entity_id: entityRef(p.entity_id) }))) : null
  }
  const groups = new Map<string, Group>()
  const views = new Map<string, Perspective>()
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
          if (id && typeof item.name === 'string') entityTypes.set(id, {id,name:item.name,color:String(item.color ?? '#8da9ce'),icon:String(item.icon ?? 'Box'),...(typeof item.layer === 'string' && item.layer ? {layer:item.layer} : {})})
          break
        case 'type.update': {
          const type = entityTypes.get(id)
          if (!type) break
          const oldName = type.name
          for (const key of ['name', 'color', 'icon'] as const) if (typeof item[key] === 'string') type[key] = item[key]
          if (item.layer === null || item.layer === '') delete type.layer
          else if (typeof item.layer === 'string') type.layer = item.layer
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
              ...(typeof item.layer === 'string' && item.layer ? { layer: item.layer } : {}),
              position: validPosition(item.x, item.y) ? { x: item.x as number, y: item.y as number } : fallback })
          }
          break
        case 'entity.update': {
          const entity = entities.get(id)
          if (entity && item.color === null) entity.color = undefined
          if (entity && typeof item.pinned === 'boolean') entity.pinned = item.pinned
          if (entity && (item.layer === null || item.layer === '')) delete entity.layer
          else if (entity && typeof item.layer === 'string') entity.layer = item.layer
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
            } else if (fact.participants?.some(p => p.entity_id === id)) {
              canonicalFacts.delete(factKey(fact))
              fact.participants = fact.participants.filter(p => p.entity_id !== id)
              canonicalFacts.set(factKey(fact), key)
            }
            for (const group of groups.values()) { group.members = group.members.filter(m => m !== id); group.excluded = group.excluded.filter(m => m !== id) }
          }
          break
        case 'entity.merge': {
          const sourceId = typeof item.source_id === 'string' ? item.source_id : ''
          const targetId = typeof item.target_id === 'string' ? item.target_id : ''
          if (!sourceId || !targetId || sourceId === targetId || !entities.has(sourceId) || !entities.has(targetId)) break
          for (const identifier of identifiers.values()) if (identifier.entity_id === sourceId) identifier.entity_id = targetId
          for (const [factId, fact] of [...facts]) {
            if (fact.subject_id !== sourceId && fact.object_id !== sourceId && !fact.participants?.some(p => p.entity_id === sourceId)) continue
            canonicalFacts.delete(factKey(fact))
            if (fact.subject_id === sourceId) fact.subject_id = targetId
            if (fact.object_id === sourceId) fact.object_id = targetId
            if (fact.participants) fact.participants = parseParticipants(fact.participants.map(p => p.entity_id === sourceId ? { ...p, entity_id: targetId } : p)) ?? fact.participants
            for (const evidence of assertions.values()) if (evidence.fact_id === factId) invalidateReview(evidence)
            const key = factKey(fact)
            const existingId = canonicalFacts.get(key)
            if (existingId && existingId !== factId) {
              for (const assertion of assertions.values()) if (assertion.fact_id === factId) assertion.fact_id = existingId
              facts.delete(factId)
              aliases.set(factId, existingId)
            } else canonicalFacts.set(key, factId)
          }
          for (const group of groups.values()) {
            group.members = [...new Set(group.members.map(m => m === sourceId ? targetId : m))]
            group.excluded = [...new Set(group.excluded.map(m => m === sourceId ? targetId : m))]
            if (group.rule?.container_id === sourceId) group.rule.container_id = targetId
          }
          entities.delete(sourceId)
          merged.set(sourceId, targetId)
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
        case 'identifier.add': {
          const owner = entityRef(item.entity_id)
          if (id && typeof owner === 'string' && entities.has(owner) && !identifiers.has(id))
            identifiers.set(id, { id, entity_id: owner, scheme: String(item.scheme ?? 'other'),
              namespace: String(item.namespace ?? ''), raw_value: String(item.raw_value ?? ''),
              normalized_value: String(item.normalized_value ?? normalizeIdentifier(String(item.scheme ?? ''), String(item.raw_value ?? ''))),
              confidence: Number(item.confidence ?? 1), source_id: typeof item.source_id === 'string' ? item.source_id : null,
              valid_from: typeof item.valid_from === 'string' ? item.valid_from : null,
              valid_to: typeof item.valid_to === 'string' ? item.valid_to : null })
          break
        }
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
          const given = refParticipants(item.participants)
          const ends = given && given.length >= 2 && (typeof item.subject_id !== 'string' || typeof item.object_id !== 'string') ? activityEnds(given) : { subject_id: entityRef(item.subject_id), object_id: entityRef(item.object_id) }
          if (!id || typeof ends.subject_id !== 'string' || typeof ends.object_id !== 'string' ||
              !entities.has(ends.subject_id) || !entities.has(ends.object_id)) break
          const fact: Fact = { id, subject_id: ends.subject_id, object_id: ends.object_id,
            predicate: String(item.predicate ?? ''), valid_from: typeof item.valid_from === 'string' ? item.valid_from : null,
            valid_to: typeof item.valid_to === 'string' ? item.valid_to : null,
            created_at: String(item.created_at ?? operation.at), assertions: [], truth_state: 'unknown' }
          const participants = given
          if (participants) {
            if (participants.some(p => !entities.has(p.entity_id))) break
            fact.participants = participants
            if (typeof item.technique === 'string' && item.technique.trim()) fact.technique = item.technique.trim()
            if (validPosition(item.x, item.y)) fact.position = { x: item.x as number, y: item.y as number }
          }
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
          const subject = typeof item.subject_id === 'string' ? entityRef(item.subject_id) as string : fact.subject_id
          const object = typeof item.object_id === 'string' ? entityRef(item.object_id) as string : fact.object_id
          if (!entities.has(subject) || !entities.has(object)) break
          const participants = refParticipants(item.participants)
          if (participants && participants.some(p => !entities.has(p.entity_id))) break
          canonicalFacts.delete(factKey(fact))
          fact.subject_id = subject; fact.object_id = object
          if (participants) {
            fact.participants = participants
            Object.assign(fact, activityEnds(participants))
          }
          if (item.technique === null || item.technique === '') delete fact.technique
          else if (typeof item.technique === 'string') fact.technique = item.technique.trim()
          if (typeof item.predicate === 'string' && item.predicate.trim()) fact.predicate = item.predicate.trim()
          if (item.valid_from === null) fact.valid_from = null
          else if (typeof item.valid_from === 'string') fact.valid_from = item.valid_from
          if (item.valid_to === null) fact.valid_to = null
          else if (typeof item.valid_to === 'string') fact.valid_to = item.valid_to
          canonicalFacts.set(factKey(fact), canonical)
          break
        }
        case 'fact.position': {
          const fact = facts.get(aliases.get(id) ?? id)
          if (fact && validPosition(item.x, item.y)) fact.position = { x: item.x as number, y: item.y as number }
          break
        }
        case 'group.add':
          if (id && typeof item.name === 'string' && item.name.trim() && !groups.has(id))
            groups.set(id, { id, name: item.name.trim().slice(0, 120), members: [...new Set(ids(item.members).map(m => entityRef(m) as string))].filter(m => entities.has(m)),
              excluded: ids(item.excluded).map(m => entityRef(m) as string), rule: parseRule(item.rule), collapsed: item.collapsed !== false,
              color: typeof item.color === 'string' ? item.color : undefined,
              position: validPosition(item.x, item.y) ? { x: item.x as number, y: item.y as number } : undefined,
              created_at: String(item.created_at ?? operation.at), member_ids: [] })
          break
        case 'group.update': {
          const group = groups.get(id)
          if (!group) break
          if (typeof item.name === 'string' && item.name.trim()) group.name = item.name.trim().slice(0, 120)
          const refs = (value: unknown) => ids(value).map(m => entityRef(m) as string)
          if (Array.isArray(item.members)) group.members = refs(item.members)
          if (Array.isArray(item.excluded)) group.excluded = refs(item.excluded)
          // Incremental edits keep concurrent membership changes from other analysts.
          for (const m of refs(item.add_members)) if (!group.members.includes(m)) group.members.push(m)
          group.members = group.members.filter(m => !refs(item.remove_members).includes(m))
          for (const m of refs(item.exclude)) if (!group.excluded.includes(m)) group.excluded.push(m)
          group.excluded = group.excluded.filter(m => !refs(item.include).includes(m))
          for (const m of refs(item.exclude)) group.members = group.members.filter(x => x !== m)
          if ('rule' in item) group.rule = parseRule(item.rule)
          if (typeof item.collapsed === 'boolean') group.collapsed = item.collapsed
          if (item.color === null) group.color = undefined
          else if (typeof item.color === 'string') group.color = item.color
          if (validPosition(item.x, item.y)) group.position = { x: item.x as number, y: item.y as number }
          break
        }
        case 'group.delete': groups.delete(id); break
        case 'view.add':
        case 'view.update': {
          const existing = views.get(id)
          if (!id || (operation.type === 'view.add' ? existing : !existing)) break
          const view: Perspective = existing ?? { id, name: '', layers: null, collapse_activities: false, show_lanes: false }
          if (typeof item.name === 'string' && item.name.trim()) view.name = item.name.trim().slice(0, 80)
          if (item.layers === null) view.layers = null
          else if (Array.isArray(item.layers)) view.layers = ids(item.layers)
          if (typeof item.collapse_activities === 'boolean') view.collapse_activities = item.collapse_activities
          if (typeof item.show_lanes === 'boolean') view.show_lanes = item.show_lanes
          if (view.name) views.set(id, view)
          break
        }
        case 'view.delete': views.delete(id); break
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
  const factList = [...facts.values()]
  resolveGroups([...groups.values()], [...entities.values()], factList)
  return { name, data: {
    groups: [...groups.values()].sort((a, b) => a.created_at.localeCompare(b.created_at)),
    views: [...views.values()],
    entity_types: [...entityTypes.values()],
    entities: [...entities.values()].sort((a, b) => a.name.localeCompare(b.name, 'de')),
    facts: factList.sort((a, b) => b.created_at.localeCompare(a.created_at)),
    sources: [...sources.values()].sort((a, b) => b.created_at.localeCompare(a.created_at)),
  } }
}

function validPosition(x: unknown, y: unknown): x is number {
  return typeof x === 'number' && typeof y === 'number' &&
    Number.isFinite(x) && Number.isFinite(y) && Math.abs(x) <= 100_000 && Math.abs(y) <= 100_000
}

export function demoDrafts(): ActionDraft[] {
  const at = new Date().toISOString()
  const [attacker, ip, sp, vault, device, pwsh, audit, intel, control, reads, listing] = Array.from({ length: 11 }, () => uuid())
  const drafts: ActionDraft[] = [
    { type: 'board.rename', payload: { name: 'Example: Key Vault secret access' } },
    { type: 'source.add', payload: { id: audit, title: 'Key Vault AuditEvent', source_kind: 'primary', uri: 'log-analytics://kv-prod-secrets/AuditEvent',
      query: 'AzureDiagnostics | where ResourceType == "VAULTS" and OperationName == "SecretList"',
      excerpt: '[{"TimeGenerated":"2026-09-28T10:42:07Z","OperationName":"SecretList","CallerIPAddress":"203.0.113.7","identity_claim_appid_g":"sp-deploy-prod","CorrelationId":"7f3a"}]', created_at: at } },
    { type: 'source.add', payload: { id: intel, title: 'Threat intel note', source_kind: 'secondary', uri: 'notes/intel.md', excerpt: '203.0.113.7 seen in earlier campaign infrastructure.', created_at: at } },
    { type: 'entity.add', payload: { id: attacker, name: 'Unknown actor', kind: 'Threat Actor', description: 'Working hypothesis', x: 0, y: 0, created_at: at } },
    { type: 'entity.add', payload: { id: ip, name: '203.0.113.7', kind: 'IP', x: 0, y: 220, created_at: at } },
    { type: 'entity.add', payload: { id: sp, name: 'sp-deploy-prod', kind: 'Service Principal', x: 380, y: -160, created_at: at } },
    { type: 'entity.add', payload: { id: vault, name: 'kv-prod-secrets', kind: 'Key Vault', x: 800, y: 20, created_at: at } },
    { type: 'entity.add', payload: { id: device, name: 'WS-0142', kind: 'Device', x: -420, y: 220, created_at: at } },
    { type: 'entity.add', payload: { id: pwsh, name: 'powershell.exe', kind: 'Process', x: -420, y: 420, created_at: at } },
    { type: 'identifier.add', payload: { id: uuid(), entity_id: device, scheme: 'hostname', namespace: 'corp', raw_value: 'WS-0142.corp.example', normalized_value: 'ws-0142.corp.example', confidence: 1, source_id: null, valid_from: null, valid_to: null } },
    { type: 'fact.add', payload: { id: uuid(), subject_id: device, predicate: 'runs', object_id: pwsh, created_at: at } },
    { type: 'fact.add', payload: { id: reads, subject_id: pwsh, predicate: 'connected to', object_id: ip, created_at: at } },
    { type: 'fact.add', payload: { id: control, subject_id: attacker, predicate: 'controls', object_id: ip, created_at: at } },
    { type: 'assertion.add', payload: { id: uuid(), fact_id: control, stance: 'supports', confidence: 0.6, source_id: intel, observation: 'IP listed in threat intel as campaign infrastructure', note: '', locator: 'intel.md line 3', created_at: at } },
    { type: 'fact.add', payload: { id: listing, predicate: 'listed secrets', technique: 'T1555.006', valid_from: '2026-09-28T10:42:07Z',
      participants: [{ entity_id: attacker, role: 'actor' }, { entity_id: ip, role: 'source' }, { entity_id: sp, role: 'identity' }, { entity_id: vault, role: 'target' }], created_at: at } },
    { type: 'assertion.add', payload: { id: uuid(), fact_id: listing, stance: 'supports', confidence: 1, source_id: audit, observation: 'SecretList on kv-prod-secrets from 203.0.113.7 as sp-deploy-prod',
      note: '', locator: 'CorrelationId=7f3a', valid_from: '2026-09-28T10:42:07Z', created_at: at } },
  ]
  return drafts.map(draft => ({ ...draft, author: 'Example' }))
}

export function legacyDrafts(value: unknown): ActionDraft[] {
  if (!value || typeof value !== 'object') throw new Error('Invalid JSON file')
  const graph = value as Partial<GraphData>
  if (!Array.isArray(graph.entities) || !Array.isArray(graph.facts) || !Array.isArray(graph.sources))
    throw new Error('Not a FactGraph export file')
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

/** Everything reachable from a container through containment relationships (device → process → file). */
export function containedBy(containerId: string, facts: Fact[]) {
  const children = new Map<string, string[]>()
  for (const fact of facts) if (CONTAINS_PREDICATES.includes(fact.predicate.trim().toLowerCase())) {
    const list = children.get(fact.subject_id); if (list) list.push(fact.object_id); else children.set(fact.subject_id, [fact.object_id])
  }
  const found = new Set<string>()
  const queue = [...(children.get(containerId) ?? [])]
  while (queue.length) {
    const next = queue.shift()!
    if (next === containerId || found.has(next)) continue
    found.add(next); queue.push(...(children.get(next) ?? []))
  }
  return [...found]
}

/** Each entity belongs to at most one group: explicit members first, then rules, in creation order. */
function resolveGroups(groups: Group[], entities: Entity[], facts: Fact[]) {
  const owner = new Map<string, string>()
  const ordered = [...groups].sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id))
  const entityIds = new Set(entities.map(e => e.id))
  const claim = (group: Group, id: string) => { if (!owner.has(id) && entityIds.has(id) && !group.excluded.includes(id) && group.rule?.container_id !== id) { owner.set(id, group.id); group.member_ids.push(id) } }
  for (const group of ordered) group.member_ids = []
  for (const group of ordered) for (const id of group.members) claim(group, id)
  for (const group of ordered) {
    const rule = group.rule
    if (!rule) continue
    if (rule.container_id) { for (const id of containedBy(rule.container_id, facts)) claim(group, id); continue }
    const kinds = (rule.kinds ?? []).map(k => k.toLowerCase())
    const needle = (rule.match ?? '').trim().toLowerCase()
    for (const entity of entities) {
      if (kinds.length && !kinds.includes(entity.kind.toLowerCase())) continue
      if (needle && !`${entity.name} ${entity.identifiers.map(i => i.raw_value).join(' ')}`.toLowerCase().includes(needle)) continue
      claim(group, entity.id)
    }
  }
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
