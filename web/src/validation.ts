import { parseParticipants, type ActionDraft } from './board'
import { LAYER_IDS } from './layers'
import type { GraphData } from './types'

/** Validate new local/API commands before committing; legacy log replay stays tolerant. */
export function validateDrafts(graph: GraphData, drafts: ActionDraft[]) {
  const types = new Map((graph.entity_types ?? []).map(t=>[t.id,t]))
  const entities = new Set(graph.entities.map(e => e.id))
  const sources = new Map(graph.sources.map(s => [s.id, {...s}]))
  const facts = new Map(graph.facts.map(f => [f.id, f]))
  const evidence = new Map(graph.facts.flatMap(f => f.assertions).map(e => [e.id, {...e}]))
  const identifiers = new Set(graph.entities.flatMap(e => e.identifiers.map(i => i.id)))
  const groups = new Set((graph.groups ?? []).map(g => g.id))
  const views = new Set((graph.views ?? []).map(v => v.id))
  const idList = (value: unknown) => Array.isArray(value) && value.every(v => typeof v === 'string')
  for (const { type, payload: p } of drafts) {
    const id = String(p.id ?? '')
    const require = (ok: unknown, message: string) => { if (!ok) throw new Error(message) }
    for (const field of ['valid_from', 'valid_to']) if (p[field] !== undefined && p[field] !== null)
      require(typeof p[field] === 'string' && Number.isFinite(Date.parse(p[field] as string)), `Invalid ${field}`)
    if (p.valid_from && p.valid_to) require(Date.parse(String(p.valid_from)) <= Date.parse(String(p.valid_to)), 'End must be after start')
    const textFields = ['name', 'kind', 'description', 'title', 'uri', 'excerpt', 'query', 'observation', 'locator', 'interpretation', 'note', 'predicate', 'scheme', 'namespace', 'raw_value']
    for (const key of textFields) if (key in p) require(typeof p[key] === 'string', `${key} must be text`)
    if ('review_status' in p && type !== 'assertion.review') require(p.review_status === 'unconfirmed', 'Use the review operation to confirm evidence')
    if ('source_kind' in p) require(['primary','secondary','unknown'].includes(String(p.source_kind)), 'Invalid source classification')
    if ('confidence' in p) require(typeof p.confidence === 'number' && p.confidence >= 0 && p.confidence <= 1, 'Confidence must be between 0 and 1')
    if (type !== 'entity.merge' && 'source_id' in p && p.source_id !== null) require(sources.has(String(p.source_id)), 'Source does not exist on this board')
    if ('stance' in p) require(p.stance === 'supports' || p.stance === 'refutes', 'Invalid evidence stance')
    if ('layer' in p && p.layer !== null && p.layer !== '') require(LAYER_IDS.includes(String(p.layer)), `Unknown layer; use one of ${LAYER_IDS.join(', ')}`)
    if ('technique' in p && p.technique !== null) require(typeof p.technique === 'string', 'technique must be text')
    if ('participants' in p) {
      const participants = parseParticipants(p.participants)
      require(participants, 'participants must be a list of {entity_id, role}')
      require(new Set(participants!.map(x => x.entity_id)).size >= 2, 'An activity needs at least two different participants')
      require(participants!.every(x => entities.has(x.entity_id)), 'Activity participant does not exist on this board')
    }
    if (type === 'fact.position') { require(facts.has(id), 'Relationship does not exist'); require((p.x === null && p.y === null) || [p.x, p.y].every(n => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= 100000), 'Invalid position') }
    if (type === 'group.add') {
      require(id && String(p.name ?? '').trim(), 'Group needs ID and name'); require(!groups.has(id), 'Group ID already exists')
      for (const key of ['members', 'excluded']) if (key in p) require(idList(p[key]), `${key} must be a list of entity IDs`)
      require(((p.members as string[] | undefined) ?? []).every(m => entities.has(m)), 'Group member does not exist on this board')
      groups.add(id)
    }
    if (type === 'group.update' || type === 'group.delete') require(groups.has(id), 'Group does not exist')
    if (type === 'group.update') for (const key of ['members', 'excluded', 'add_members', 'remove_members', 'exclude', 'include']) if (key in p) require(idList(p[key]), `${key} must be a list of entity IDs`)
    if ((type === 'group.add' || type === 'group.update') && 'rule' in p && p.rule !== null) {
      const rule = p.rule as Record<string, unknown>
      require(rule && typeof rule === 'object' && (!('kinds' in rule) || idList(rule.kinds)) && (!('match' in rule) || typeof rule.match === 'string'), 'Invalid group rule')
      if (rule.container_id != null) require(entities.has(String(rule.container_id)), 'Container entity does not exist')
    }
    if ((type === 'group.add' || type === 'group.update') && ('x' in p || 'y' in p)) require([p.x, p.y].every(n => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= 100000), 'Invalid group position')
    if (type === 'group.delete') groups.delete(id)
    if (type === 'view.add') { require(id && String(p.name ?? '').trim(), 'Perspective needs ID and name'); require(!views.has(id), 'Perspective ID already exists'); views.add(id) }
    if (type === 'view.update' || type === 'view.delete') require(views.has(id), 'Perspective does not exist')
    if ((type === 'view.add' || type === 'view.update') && 'layers' in p && p.layers !== null) require(idList(p.layers) && (p.layers as string[]).every(l => LAYER_IDS.includes(l)), 'Invalid perspective layers')
    if (type === 'view.delete') views.delete(id)
    if ('color' in p && p.color !== null) require(/^#[\da-f]{6}$/i.test(String(p.color)), 'Invalid node color')
    if (type === 'type.add') { require(id && String(p.name ?? '').trim(), 'Type needs a name'); require(![...types.values()].some(t => t.name.toLowerCase() === String(p.name).toLowerCase()), 'Type already exists'); types.set(id,p as any) }
    if (type === 'type.update' || type === 'type.delete') require(types.has(id), 'Type does not exist')
    if (type === 'type.update' && 'name' in p) require(![...types.values()].some(t=>t.id!==id && t.name.toLowerCase()===String(p.name).toLowerCase()), 'Type name already exists')
    if (type === 'type.delete') require(!graph.entities.some(e => e.kind === types.get(id)?.name), 'Type is in use; change its entities first')
    if (type === 'entity.add') { require(id && String(p.name ?? '').trim() && String(p.kind ?? '').trim(), 'Entity needs ID, name and type'); require(!entities.has(id), 'Entity ID already exists'); entities.add(id) }
    if (['entity.update', 'entity.position', 'entity.delete'].includes(type)) require(entities.has(id), 'Entity does not exist on this board')
    if (type === 'entity.update') for (const field of ['name', 'kind']) if (field in p) require(typeof p[field] === 'string' && p[field].trim(), `${field} cannot be empty`)
    if (type === 'entity.update' && p.compromise) {
      const c = p.compromise as Record<string, unknown>
      require(typeof c === 'object', 'Invalid compromise')
      for (const field of ['from', 'to']) if (c[field] !== undefined && c[field] !== null) require(typeof c[field] === 'string' && Number.isFinite(Date.parse(c[field] as string)), `Invalid compromise ${field}`)
      if (c.from && c.to) require(Date.parse(String(c.from)) <= Date.parse(String(c.to)), 'Compromise end must be after its start')
    }
    if (type === 'entity.update' && p.rotated_at !== undefined && p.rotated_at !== null) require(typeof p.rotated_at === 'string' && Number.isFinite(Date.parse(p.rotated_at)), 'Invalid rotation time')
    if (type === 'entity.position' || (type === 'entity.add' && ('x' in p || 'y' in p)))
      require([p.x, p.y].every(n => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= 100000), 'Invalid node position')
    if (type === 'entity.merge') require(p.source_id !== p.target_id && entities.has(String(p.source_id)) && entities.has(String(p.target_id)), 'Invalid merge entities')
    if (type === 'identifier.add') { require(entities.has(String(p.entity_id)) && String(p.raw_value ?? '').trim(), 'Identifier needs an entity and value'); identifiers.add(id) }
    if (type === 'identifier.update' || type === 'identifier.delete') require(identifiers.has(id), 'Identifier does not exist')
    if (type === 'source.add') { require(id && String(p.title ?? '').trim(), 'Source needs a title'); require(!sources.has(id), 'Source ID already exists'); sources.set(id, p as any) }
    if (type === 'source.update' || type === 'source.delete') require(sources.has(id), 'Source does not exist')
    if (type === 'source.delete') require(![...evidence.values()].some(e => e.source_id === id) && !graph.entities.some(e => e.identifiers.some(i => i.source_id === id)), 'Source is referenced; detach its evidence and identifiers first')
    if (type === 'fact.add' || type === 'fact.update') {
      const current = facts.get(id)
      if (type === 'fact.update') require(current, 'Relationship does not exist')
      const derived = !current && !p.subject_id && Array.isArray(p.participants)
      if (!derived) require(entities.has(String(p.subject_id ?? current?.subject_id)) && entities.has(String(p.object_id ?? current?.object_id)), 'Relationship endpoints do not exist')
      require(String(p.predicate ?? current?.predicate ?? '').trim(), 'Relationship needs a predicate')
      const updated = {...current,...p} as any
      if(type === 'fact.update' && !updated.participants?.length) require(![...facts.values()].some(f=>f.id!==id && !f.participants?.length && f.subject_id===updated.subject_id && f.object_id===updated.object_id && f.predicate.toLowerCase()===updated.predicate.toLowerCase() && f.valid_from===updated.valid_from && f.valid_to===updated.valid_to), 'An identical relationship already exists; attach evidence there instead')
      facts.set(id, updated)
    }
    if (type === 'assertion.add') { require(facts.has(String(p.fact_id)) && id, 'Evidence needs a relationship'); require(!evidence.has(id), 'Evidence ID already exists'); evidence.set(id, { ...p, review_status: 'unconfirmed' } as any) }
    if (type.startsWith('assertion.') && type !== 'assertion.add') require(evidence.has(id), 'Evidence does not exist')
    if (type === 'entity.delete') {
      entities.delete(id)
      for (const [fid,f] of facts) if(f.subject_id===id||f.object_id===id) {facts.delete(fid);for(const [eid,e] of evidence) if(e.fact_id===fid)evidence.delete(eid)}
      for (const g of graph.groups ?? []) if (g.rule?.container_id === id) groups.delete(g.id)
    }
    if (type === 'fact.delete') {require(facts.has(id),'Relationship does not exist');facts.delete(id);for(const [eid,e] of evidence) if(e.fact_id===id)evidence.delete(eid)}
    if (type === 'identifier.delete') identifiers.delete(id)
    if (type === 'source.delete') sources.delete(id)
    if (type === 'assertion.delete') evidence.delete(id)
    if (type === 'source.update' && p.expected_revision != null) require(sources.get(id)?.revision === p.expected_revision, 'Source changed. Reload before saving.')
    if (type === 'assertion.update' && p.expected_revision != null) require(evidence.get(id)?.revision === p.expected_revision, 'Evidence changed. Reload before saving.')
    if (type === 'source.update') { const source = sources.get(id)!; source.revision = 'pending'; Object.assign(source, p) }
    if (type === 'assertion.update') { const current = evidence.get(id)!; Object.assign(current,p); current.revision = 'pending'; if(current.valid_from && current.valid_to) require(Date.parse(current.valid_from)<=Date.parse(current.valid_to),'End must be after start') }
    if (type === 'assertion.review') {
      const item = evidence.get(id)!
      require(typeof p.expected_revision === 'string' && p.expected_revision === item.revision, 'Evidence changed. Reload and review the current revision.')
      require(p.review_status === 'confirmed' || p.review_status === 'unconfirmed', 'Invalid review status')
      if (p.review_status === 'confirmed') {
        const source = sources.get(item.source_id ?? '')
        require(!item.retracted_at, 'Restore retracted evidence before reviewing it')
        require(source?.source_kind === 'primary' && source.uri.trim() && source.excerpt.trim(), 'Confirmation requires a primary source with reference and original excerpt/results')
        require(item.locator?.trim() && (item.observation || item.note).trim(), 'Add a specific locator and observation before confirming')
        require(String(p.review_note ?? '').trim(), 'Explain what you checked')
        require(p.expected_source_revision === source?.revision, 'Source changed. Review its current revision.')
      }
    }
  }
}
