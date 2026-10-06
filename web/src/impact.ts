import type { Entity, Fact, GraphData } from './types'
import { CONTAINS_PREDICATES } from './board'

/**
 * Attack impact: what was done with compromised credentials, identities and IPs, what it touched, what else to look
 * at and what to rotate. Everything is derived from the board in one pass over the activities, so it stays fast on
 * large imports and changes as soon as the analyst marks or clears a compromise.
 */

/**
 * Set on an entity: compromised (a stolen credential, an attacker's IP) from `from` until `to`; both are optional.
 * `cleared`: the analyst checked it and it is not compromised, so it is never derived either.
 */
/** via: the channel it was marked through (UI, REST, MCP): an agent's mark is shown as such. */
export type Compromise = { from?: string | null; to?: string | null; note?: string; by?: string; at?: string; via?: string; cleared?: boolean; level?: 'suspected' | 'confirmed' }

export type Effect = 'secret' | 'delete' | 'write' | 'read' | 'auth' | 'attempt' | 'other'
export const EFFECTS: Effect[] = ['secret', 'delete', 'write', 'read', 'auth', 'attempt', 'other']
export const EFFECT_LABEL: Record<Effect, string> = {
  secret: 'Secrets exposed', delete: 'Deleted', write: 'Changed', read: 'Read', auth: 'Signed in to', attempt: 'Attempted (failed)', other: 'Touched',
}

const SECRET_OPERATION = /list[ _-]?keys|list[ _-]?secrets?|list\w*credentials?|listaccountsas|listservicesas|regeneratekey|publishxml|publishingcredentials|listconnectionstrings|secret ?get|key ?get|certificate ?get|get ?secret|variables? (viewed|accessed|read)|variable viewed/i
const DELETE_OPERATION = /\b(delete|deleted|remove|removed|purge)\b/i
const WRITE_OPERATION = /\b(write|create|created|update|updated|modify|put|patch|set|add|added|assign|deploy|push|upload|disable|enable|reset|restart|stop|start|run|exec)\b/i
const FAILED_OPERATION = /\bfail(ed|ure)?\b|\bdenied\b|unauthori[sz]ed|forbidden|^deny |^audit /i
const READ_OPERATION = /\b(read|get|list|view|viewed|accessed|access|download|downloaded|clone|pull|fetch|export|archive)\b/i
const AUTH_OPERATION = /sign(ed)?[ -]?in|log ?on|log ?in|authenticat|token used/i
/** Files whose content is a secret, or usually holds one. */
export const SECRET_FILE = /(^|[\\/])(\.env(\.[\w-]+)?|[^\\/]*\.(pem|key|p12|pfx|jks|kdbx|tfvars|tfstate|ppk)|id_(rsa|dsa|ecdsa|ed25519)|\.npmrc|\.pypirc|\.netrc|\.git-credentials|\.dockercfg|[^\\/]*(credential|secret|password|passwd|token|kubeconfig)[^\\/]*)$/i
const CI_FILE = /(^|[\\/])(\.gitlab-ci\.ya?ml|jenkinsfile|azure-pipelines\.ya?ml|[^\\/]*\.github[\\/]workflows[\\/][^\\/]+)$/i

/** What an operation did to its target, worst first: reading a secret beats deleting beats changing beats reading. */
export function effectOf(operation: string, target?: Pick<Entity, 'kind' | 'name'>): Effect {
  const op = operation.toLowerCase()
  // A failed or denied attempt reached nothing, but shows intent.
  if (FAILED_OPERATION.test(op)) return 'attempt'
  if (SECRET_OPERATION.test(op)) return 'secret'
  if (DELETE_OPERATION.test(op)) return 'delete'
  if (AUTH_OPERATION.test(op)) return 'auth'
  if (WRITE_OPERATION.test(op)) return 'write'
  if (READ_OPERATION.test(op)) return target && /file/i.test(target.kind) && SECRET_FILE.test(target.name) ? 'secret' : 'read'
  return 'other'
}

/** `derived`: not marked, but used successfully from attacker infrastructure; compromised no later than its first use. */
export type Derivation = { via: string; fact: string; at: string; reason?: 'used' | 'session' }
/** suspected: marked as suspected, or derived from something only suspected; the analysis is the same, the wording is not. */
export type Seed = { entity: Entity; from: number; to: number; derived?: Derivation; suspected?: boolean }
/** before: evidence of this very activity (same identity, credential, IP, target) before the compromise: likely regular. */
/** hits: the evidence items inside the window (the rest of the activity happened before or after it). */
export type AttackFact = { fact: Fact; seeds: string[]; count: number; first: string | null; last: string | null; effect: Effect; before: number; hits: Set<string> }
export type OperationUse = { operation: string; effect: Effect; count: number; first: string | null; last: string | null }
/**
 * regular: every attacker activity on it also happened, exactly so, before the compromise (likely harmless).
 * routine: how often the compromised identities did the same operation on it before the compromise, from anywhere.
 */
export type Impacted = { entity: Entity; effect: Effect; operations: OperationUse[]; count: number; first: string | null; last: string | null; seeds: string[]; actors: string[]; regular: boolean; routine: number }
export type Pivot = { entity: Entity; roles: string[]; count: number; first: string | null; last: string | null; seeds: string[]; before: number }
/** One thing the attacker did: an operation by the same compromised entities; `others` are the IPs, identities … they used. */
export type Step = { operation: string; effect: Effect; seeds: string[]; others: string[]; targets: string[]; count: number; first: string | null; last: string | null; facts: string[]; regular: boolean }
export type RotationCategory = 'revoke' | 'rotate' | 'block' | 'review'
/** `key` and `label` name the measure ("Rotate CI/CD variables"), so many entities that need the same are listed together. */
export type RotationItem = { id: string; entityId: string; category: RotationCategory; key: string; label: string; title: string; detail: string; lastUse: string | null; rotatedAt: string | null; stale: boolean
  /** Imported evidence that it happened (key removed in AuditLogs, regenerateKey in AzureActivity), the latest one. */
  proof: { at: string; fact: string; operation: string } | null }
export type VariableExposure = { entity: Entity; path: string; groups: string[]; count: number; first: string | null; last: string | null }
export type Impact = {
  seeds: Seed[]; facts: Map<string, AttackFact>; impacted: Impacted[]; pivots: Pivot[]; steps: Step[]
  rotation: RotationItem[]; variables: VariableExposure[]
  /** Evidence items without a time that could not be placed inside or outside a window. */
  undated: number
  first: string | null; last: string | null
  /** Entity IDs by their part in the attack, for the graph. */
  marks: Map<string, 'compromised' | 'derived' | 'pivot' | 'impacted' | 'good'>
  /** Evidence items per compromised entity before its window: how much there is to tell regular from new. */
  history: Map<string, number>
}

/** Evidence that key material was replaced: a key removed or revoked (AuditLogs), keys regenerated (AzureActivity), a reset. */
export const ROTATION_EVIDENCE = /credential (removed|deleted|revoked)|remove (service principal )?credentials?|(key|secret|certificate|token|password) (removed|deleted|revoked)|regeneratekey|regeneratecredential|regenerate(d)? keys?|rotatecertificate|rotate-?certs|reset ?(password|credentials)|revoke/i
type Proof = { at: string; fact: string; operation: string }
export type RotationContext = { proofs?: Map<string, Proof>; lastUse?: Map<string, string>; links?: Map<string, Set<string>> }
const parse = (value: string | null | undefined, fallback: number) => { const t = value ? Date.parse(value) : NaN; return Number.isNaN(t) ? fallback : t }
const earlier = (a: string | null, b: string | null) => !a ? b : !b ? a : a < b ? a : b
const later = (a: string | null, b: string | null) => !a ? b : !b ? a : a > b ? a : b

export const compromiseOf = (entity: Entity) => (entity as Entity & { compromise?: Compromise | null }).compromise ?? null
const marked = (entity: Entity) => { const c = compromiseOf(entity); return !!c && !c.cleared }
/** Attacker infrastructure: what it uses successfully is in the attacker's hands. */
export const INFRASTRUCTURE = /\bip\b|address|network|asn|device|host|server|endpoint|workstation|machine|\bvm\b/i
/** What can be stolen and used: credentials and the identities they belong to. */
export const USABLE = /credential|secret|token|key|certificate|service principal|application|managed identity|workload|user|account/i
const DRIVING_ROLES = new Set(['actor', 'identity', 'tool', 'via', 'other'])

/**
 * Credentials and identities used successfully from compromised infrastructure (an attacker's IP, a compromised host)
 * inside its window: compromised no later than the first such use. One hop only, and never the other way round: an IP
 * that used a stolen secret may well be its legitimate owner. Failed attempts prove nothing.
 */
export function derivedCompromises(data: Pick<GraphData, 'entities' | 'facts'>): Map<string, Derivation> {
  const byId = new Map(data.entities.map(e => [e.id, e]))
  const infrastructure = new Map<string, { from: number; to: number }>()
  for (const entity of data.entities) if (marked(entity) && INFRASTRUCTURE.test(entity.kind)) {
    const c = compromiseOf(entity)!
    infrastructure.set(entity.id, { from: parse(c.from, -Infinity), to: parse(c.to, Infinity) })
  }
  const derived = new Map<string, Derivation>()
  if (!infrastructure.size) return derived
  // A session token is one sign-in: whoever else used it holds the attacker's session (a redirector, a second exit).
  const inWindow = (id: string, at: string) => { const w = infrastructure.get(id); const t = Date.parse(at); return !!w && t >= w.from && t <= w.to }
  for (const uses of sessionUses(data).values()) {
    const attacker = uses.filter(u => u.ip && inWindow(u.ip, u.at)).sort((a, b) => a.at.localeCompare(b.at))[0]
    if (!attacker) continue
    for (const use of uses) {
      // Before the attacker the session was the victim's: that IP is where the token was stolen, not the attacker.
      if (!use.ip || use.at < attacker.at || infrastructure.has(use.ip) || compromiseOf(byId.get(use.ip) ?? ({} as Entity))) continue
      const current = derived.get(use.ip)
      if (!current || use.at < current.at) derived.set(use.ip, { via: attacker.ip!, fact: use.fact, at: use.at, reason: 'session' })
    }
  }
  for (const [id, d] of derived) infrastructure.set(id, { from: Date.parse(d.at), to: Infinity })
  for (const fact of data.facts) {
    const plain = !fact.participants?.length
    const parts = plain ? [{ entity_id: fact.subject_id, role: 'actor' }, { entity_id: fact.object_id, role: 'tool' }] : fact.participants!
    const hosts = parts.filter(p => p.role !== 'target' && infrastructure.has(p.entity_id))
    if (!hosts.length || effectOf(fact.predicate) === 'attempt') continue
    const used = parts.filter(p => DRIVING_ROLES.has(p.role) && !infrastructure.has(p.entity_id)).map(p => byId.get(p.entity_id))
      .filter((e): e is Entity => !!e && USABLE.test(e.kind) && !compromiseOf(e))
    if (!used.length) continue
    for (const item of fact.assertions) {
      if (item.retracted_at || item.stance !== 'supports' || !item.valid_from) continue
      const t = Date.parse(item.valid_from)
      const host = hosts.find(h => { const w = infrastructure.get(h.entity_id)!; return t >= w.from && t <= w.to })
      if (!host) continue
      for (const entity of used) {
        const current = derived.get(entity.id)
        if (!current || item.valid_from < current.at) derived.set(entity.id, { via: host.entity_id, fact: fact.id, at: item.valid_from, reason: 'used' })
      }
    }
  }
  return derived
}
/**
 * When infrastructure is proven in the attacker's hands: its first successful use of a credential or identity. Before
 * that, an IP (a shared exit, a cloud range) may well have served someone else; nothing on the board says otherwise.
 */
export function firstUseOf(data: Pick<GraphData, 'entities' | 'facts'>, entityId: string): string | null {
  const byId = new Map(data.entities.map(e => [e.id, e]))
  let first: string | null = null
  for (const fact of data.facts) {
    const parts = fact.participants?.length ? fact.participants : [{ entity_id: fact.subject_id, role: 'actor' }, { entity_id: fact.object_id, role: 'tool' }]
    if (!parts.some(p => p.entity_id === entityId && p.role !== 'target') || effectOf(fact.predicate) === 'attempt') continue
    if (!parts.some(p => p.entity_id !== entityId && DRIVING_ROLES.has(p.role) && USABLE.test(byId.get(p.entity_id)?.kind ?? ''))) continue
    for (const item of fact.assertions) if (!item.retracted_at && item.stance === 'supports' && item.valid_from) first = earlier(first, item.valid_from)
  }
  return first
}
/** Evidence items of an entity's own activity before a time: what a mark without a start would count as the attacker's. */
export function activityBefore(data: Pick<GraphData, 'facts'>, entityId: string, at: string): number {
  let count = 0
  for (const fact of data.facts) {
    const parts = fact.participants?.length ? fact.participants : [{ entity_id: fact.subject_id, role: 'actor' }, { entity_id: fact.object_id, role: 'target' }]
    if (!parts.some(p => p.entity_id === entityId && p.role !== 'target')) continue
    for (const item of fact.assertions) if (!item.retracted_at && item.stance === 'supports' && item.valid_from && item.valid_from < at) count++
  }
  return count
}
/** Where a new mark starts by default: infrastructure from its first proven use, everything else is the analyst's call. */
export const defaultSince = (data: Pick<GraphData, 'entities' | 'facts'>, entity: Entity) => INFRASTRUCTURE.test(entity.kind) ? firstUseOf(data, entity.id) : null
export const rotatedAtOf = (entity: Entity) => (entity as Entity & { rotated_at?: string | null }).rotated_at ?? null

export function analyzeImpact(data: Pick<GraphData, 'entities' | 'facts'>): Impact {
  const byId = new Map(data.entities.map(e => [e.id, e]))
  const seeds: Seed[] = []
  for (const entity of data.entities) {
    const compromise = compromiseOf(entity)
    if (compromise && !compromise.cleared) seeds.push({ entity, from: parse(compromise.from, -Infinity), to: parse(compromise.to, Infinity), suspected: compromise.level === 'suspected' })
  }
  const explicitSuspected = new Set(seeds.filter(x => x.suspected).map(x => x.entity.id))
  const derivations = derivedCompromises(data)
  // Derived from something only suspected stays suspected; follows chains of session-derived IPs too.
  const suspectedVia = (id: string, depth = 0): boolean => explicitSuspected.has(id) || (depth < 4 && !!derivations.get(id) && suspectedVia(derivations.get(id)!.via, depth + 1))
  for (const [id, derived] of derivations) seeds.push({ entity: byId.get(id)!, from: Date.parse(derived.at), to: Infinity, derived, suspected: suspectedVia(derived.via) })
  const seedById = new Map(seeds.map(s => [s.entity.id, s]))
  // Marked good: known legitimate. What runs from good infrastructure is the owner, not the attacker.
  const good = new Set(data.entities.filter(e => compromiseOf(e)?.cleared).map(e => e.id))
  const facts = new Map<string, AttackFact>()
  const impacted = new Map<string, Impacted & { ops: Map<string, OperationUse>; seedSet: Set<string>; actorSet: Set<string>; keys: Set<string>; irregular: number }>()
  // Seed × operation × target seen before the compromise, from any source: what the identity normally does.
  const baseline = new Map<string, number>()
  const baseKey = (seed: string, predicate: string, target: string) => `${seed}\u0000${predicate.trim().toLowerCase()}\u0000${target}`
  const pivots = new Map<string, Pivot & { roleSet: Set<string>; seedSet: Set<string> }>()
  const before = new Map<string, number>()
  const steps = new Map<string, Step & { targetSet: Set<string>; otherSet: Set<string>; irregular: number }>()
  let undated = 0, first: string | null = null, last: string | null = null
  const history = new Map<string, number>()
  if (!seeds.length) return { seeds, facts, impacted: [], pivots: [], steps: [], rotation: [], variables: [], undated, first, last, marks: new Map(), history }

  for (const fact of data.facts) {
    const plain = !fact.participants?.length
    if (plain && CONTAINS_PREDICATES.includes(fact.predicate.trim().toLowerCase())) continue
    const parts = plain ? [{ entity_id: fact.subject_id, role: 'actor' }, { entity_id: fact.object_id, role: 'target' }] : fact.participants!
    // An activity is the attacker's when a compromised entity drove it (any role but target) inside its window.
    const drivers = parts.filter(p => p.role !== 'target' && seedById.has(p.entity_id)).map(p => seedById.get(p.entity_id)!)
    if (!drivers.length) continue
    if (good.size && parts.some(p => p.role === 'source' && good.has(p.entity_id))) continue
    const unbounded = drivers.every(s => s.from === -Infinity && s.to === Infinity)
    let count = 0, earlierCount = 0, factFirst: string | null = null, factLast: string | null = null
    const hits = new Set<string>()
    for (const item of fact.assertions) {
      if (item.retracted_at || item.stance !== 'supports') continue
      const t = parse(item.valid_from, NaN)
      if (Number.isNaN(t)) { if (unbounded) { count++; hits.add(item.id) } else undated++; continue }
      if (drivers.some(s => t >= s.from && t <= s.to)) { count++; hits.add(item.id); factFirst = earlier(factFirst, item.valid_from); factLast = later(factLast, item.valid_from) }
      else if (drivers.some(s => t < s.from)) earlierCount++
    }
    // Seen together before the compromise: a hint that the partner is legitimate (the usual runner IP, the owner).
    if (earlierCount) {
      for (const s of drivers) history.set(s.entity.id, (history.get(s.entity.id) ?? 0) + earlierCount)
      for (const p of parts) if (p.role !== 'target' && !seedById.has(p.entity_id)) before.set(p.entity_id, (before.get(p.entity_id) ?? 0) + earlierCount)
      for (const s of drivers) for (const p of parts) if (p.role === 'target') { const k = baseKey(s.entity.id, fact.predicate, p.entity_id); baseline.set(k, (baseline.get(k) ?? 0) + earlierCount) }
    }
    if (!count) continue
    first = earlier(first, factFirst); last = later(last, factLast)
    const targets = parts.filter(p => p.role === 'target').map(p => p.entity_id)
    const effect = effectOf(fact.predicate, byId.get(targets[0] ?? ''))
    const seedIds = drivers.map(s => s.entity.id)
    facts.set(fact.id, { fact, seeds: seedIds, count, first: factFirst, last: factLast, effect, before: earlierCount, hits })
    const actors = [...new Set(parts.filter(p => p.role !== 'target').map(p => p.entity_id))].sort()
    for (const p of parts) {
      const entity = byId.get(p.entity_id)
      if (!entity) continue
      if (p.role === 'target') {
        let entry = impacted.get(entity.id)
        if (!entry) impacted.set(entity.id, entry = { entity, effect: 'other', operations: [], count: 0, first: null, last: null, seeds: [], actors: [], regular: false, routine: 0, ops: new Map(), seedSet: new Set(), actorSet: new Set(), keys: new Set(), irregular: 0 })
        if (!earlierCount) entry.irregular++
        for (const id of seedIds) entry.keys.add(baseKey(id, fact.predicate, entity.id))
        const own = effectOf(fact.predicate, entity)
        const use = entry.ops.get(fact.predicate) ?? { operation: fact.predicate, effect: own, count: 0, first: null, last: null }
        use.count += count; use.first = earlier(use.first, factFirst); use.last = later(use.last, factLast)
        entry.ops.set(fact.predicate, use)
        entry.count += count; entry.first = earlier(entry.first, factFirst); entry.last = later(entry.last, factLast)
        if (EFFECTS.indexOf(own) < EFFECTS.indexOf(entry.effect)) entry.effect = own
        seedIds.forEach(id => entry!.seedSet.add(id)); actors.forEach(id => entry!.actorSet.add(id))
      } else if (!seedById.has(entity.id) && !compromiseOf(entity)?.cleared) {
        let entry = pivots.get(entity.id)
        if (!entry) pivots.set(entity.id, entry = { entity, roles: [], count: 0, first: null, last: null, seeds: [], before: 0, roleSet: new Set(), seedSet: new Set() })
        entry.count += count; entry.first = earlier(entry.first, factFirst); entry.last = later(entry.last, factLast)
        entry.roleSet.add(p.role); seedIds.forEach(id => entry!.seedSet.add(id))
      }
    }
    const key = `${fact.predicate.trim().toLowerCase()}\u0000${[...seedIds].sort().join(',')}`
    let step = steps.get(key)
    if (!step) steps.set(key, step = { operation: fact.predicate, effect, seeds: [...seedIds].sort(), others: [], targets: [], count: 0, first: null, last: null, facts: [], regular: false, targetSet: new Set(), otherSet: new Set(), irregular: 0 })
    if (!earlierCount) step.irregular++
    step.count += count; step.first = earlier(step.first, factFirst); step.last = later(step.last, factLast); step.facts.push(fact.id)
    targets.forEach(id => step!.targetSet.add(id))
    actors.forEach(id => { if (!seedById.has(id)) step!.otherSet.add(id) })
  }

  const impactedList = [...impacted.values()].map(({ ops, seedSet, actorSet, keys, irregular, ...rest }) => ({ ...rest,
    operations: [...ops.values()].sort((a, b) => EFFECTS.indexOf(a.effect) - EFFECTS.indexOf(b.effect) || b.count - a.count),
    seeds: [...seedSet], actors: [...actorSet], regular: irregular === 0, routine: [...keys].reduce((n, k) => n + (baseline.get(k) ?? 0), 0) }))
    // Worst first; what also happened exactly so before the compromise goes to the end of its kind.
    .sort((a, b) => EFFECTS.indexOf(a.effect) - EFFECTS.indexOf(b.effect) || Number(a.regular) - Number(b.regular) || b.count - a.count || a.entity.name.localeCompare(b.entity.name))
  const pivotList = [...pivots.values()].map(({ roleSet, seedSet, ...rest }) => ({ ...rest, roles: [...roleSet], seeds: [...seedSet], before: before.get(rest.entity.id) ?? 0 }))
    // New since the compromise first, then by how much they were used.
    .sort((a, b) => Number(a.before > 0) - Number(b.before > 0) || b.count - a.count)
  const stepList = [...steps.values()].map(({ targetSet, otherSet, irregular, ...rest }) => ({ ...rest, targets: [...targetSet], others: [...otherSet], regular: irregular === 0 }))
    .sort((a, b) => (a.first ?? '9').localeCompare(b.first ?? '9') || b.count - a.count)
  const marks = new Map<string, 'compromised' | 'derived' | 'pivot' | 'impacted' | 'good'>()
  for (const entry of impactedList) marks.set(entry.entity.id, 'impacted')
  for (const entry of pivotList) if (!entry.before) marks.set(entry.entity.id, 'pivot')
  for (const seed of seeds) marks.set(seed.entity.id, seed.derived ? 'derived' : 'compromised')
  for (const id of good) if (!marks.has(id) || marks.get(id) === 'pivot') marks.set(id, 'good')
  // Last successful use of each compromised entity by the attacker: a rotation before it has to be repeated.
  const lastUse = new Map<string, string>()
  for (const attack of facts.values()) if (attack.effect !== 'attempt' && attack.last) for (const id of attack.seeds) if (!lastUse.has(id) || attack.last > lastUse.get(id)!) lastUse.set(id, attack.last)
  return { seeds, facts, impacted: impactedList, pivots: pivotList, steps: stepList, rotation: rotationPlan(seeds, impactedList, { proofs: rotationProofs(data, facts), lastUse, links: credentialLinks(data, seeds) }), variables: variableExposures(impactedList),
    undated, first, last, marks, history }
}

/**
 * The latest imported evidence per entity that its key material was replaced (successful operations only). What the
 * attacker did is no proof: regenerateKey by a compromised identity hands the new keys to the attacker, and removing a
 * credential may lock out the owner. `attack` are the attacker's activities; their evidence inside the window is skipped.
 */
export function rotationProofs(data: Pick<GraphData, 'facts'>, attack?: Map<string, AttackFact>): Map<string, Proof> {
  const proofs = new Map<string, Proof>()
  for (const fact of data.facts) {
    if (!ROTATION_EVIDENCE.test(fact.predicate) || effectOf(fact.predicate) === 'attempt') continue
    const targets = fact.participants?.length ? fact.participants.filter(p => p.role === 'target').map(p => p.entity_id) : [fact.object_id]
    const byAttacker = attack?.get(fact.id)?.hits
    for (const item of fact.assertions) {
      if (item.retracted_at || item.stance !== 'supports' || !item.valid_from || byAttacker?.has(item.id)) continue
      for (const id of targets) { const current = proofs.get(id); if (!current || item.valid_from > current.at) proofs.set(id, { at: item.valid_from, fact: fact.id, operation: fact.predicate }) }
    }
  }
  return proofs
}

/** Credentials seen together with each compromised identity (sign-ins, credential changes). */
function credentialLinks(data: Pick<GraphData, 'entities' | 'facts'>, seeds: Seed[]): Map<string, Set<string>> {
  const identities = new Set(seeds.filter(s => /service principal|application|managed identity|workload/i.test(s.entity.kind)).map(s => s.entity.id))
  const links = new Map<string, Set<string>>()
  if (!identities.size) return links
  const credential = new Set(data.entities.filter(e => /credential|secret|certificate/i.test(e.kind)).map(e => e.id))
  for (const fact of data.facts) {
    const ids = fact.participants?.length ? fact.participants.map(p => p.entity_id) : [fact.subject_id, fact.object_id]
    const owners = ids.filter(id => identities.has(id))
    if (!owners.length) continue
    for (const id of ids) if (credential.has(id)) for (const owner of owners) { let set = links.get(owner); if (!set) links.set(owner, set = new Set()); set.add(id) }
  }
  return links
}

const identifier = (entity: Entity, namespace: string) => entity.identifiers.find(i => i.namespace === namespace || i.scheme === namespace)?.normalized_value

/** Revoke what was stolen, block the attacker's infrastructure, rotate what was exposed, review what was copied. */
export function rotationPlan(seeds: Seed[], impacted: Impacted[], context: RotationContext = {}): RotationItem[] {
  const items: RotationItem[] = []
  const seedIds = new Set(seeds.map(s => s.entity.id))
  const add = (entity: Entity, category: RotationCategory, key: string, label: string, title: string, detail: string, lastUse: string | null, proof: Proof | null = context.proofs?.get(entity.id) ?? null) => {
    const manual = rotatedAtOf(entity)
    // Marked by hand or proven by an import, whichever is later.
    const rotatedAt = !proof ? manual : !manual || proof.at > manual ? proof.at : manual
    items.push({ id: `${entity.id}:${key}`, entityId: entity.id, category, key, label, title, detail, lastUse, rotatedAt, proof,
      // Rotated, but the attacker was there again afterwards (or still is): rotate again and find out how.
      stale: !!rotatedAt && !!lastUse && lastUse > rotatedAt })
  }
  /** A compromised identity is rotated once every compromised credential seen with it was removed. */
  const identityProof = (entity: Entity): Proof | null => {
    const own = [...(context.links?.get(entity.id) ?? [])].filter(id => seedIds.has(id))
    if (!own.length) return context.proofs?.get(entity.id) ?? null
    const proofs = own.map(id => context.proofs?.get(id))
    if (proofs.some(p => !p)) return null
    return proofs.reduce((latest, p) => !latest || p!.at > latest.at ? p! : latest, null as Proof | null)
  }
  for (const { entity } of seeds) {
    const kind = entity.kind.toLowerCase()
    const until = context.lastUse?.get(entity.id) ?? compromiseOf(entity)?.to ?? null
    if (/credential|secret|token|key|certificate/.test(kind)) {
      if (identifier(entity, 'entra-credential-key-id')) add(entity, 'revoke', 'revoke-secret', 'Remove stolen client secrets and certificates', `Remove client secret / certificate ${entity.name}`, 'Delete the credential from the app registration and issue a new one to the legitimate owner; check that no other credential was added meanwhile.', until)
      else if (identifier(entity, 'gitlab-access-token-id')) add(entity, 'revoke', 'revoke-token', 'Revoke GitLab access tokens', `Revoke GitLab access token ${entity.name}`, 'Revoke the token, create a new one with the smallest scope, and check what it could reach.', until)
      else if (identifier(entity, 'gitlab-ssh-key-id')) add(entity, 'revoke', 'revoke-ssh', 'Remove SSH keys', `Remove SSH key ${entity.name}`, 'Delete the key from the GitLab account and replace it on the legitimate machine.', until)
      else add(entity, 'revoke', 'revoke-credential', 'Revoke stolen credentials', `Revoke credential ${entity.name}`, 'Revoke and replace it everywhere it is used.', until)
    } else if (/service principal|application|app registration|managed identity|workload/.test(kind)) {
      add(entity, 'rotate', 'rotate-identity', 'Rotate all credentials of compromised identities', `Rotate all credentials of ${entity.name}`, 'Replace every secret and certificate, remove credentials or federated identities the attacker added, and review owners and role assignments.', until, identityProof(entity))
    } else if (/user|account|person/.test(kind)) {
      add(entity, 'rotate', 'reset-user', 'Reset compromised accounts', `Reset ${entity.name}`, 'Reset the password, revoke sessions and refresh tokens, review MFA methods and mailbox / OAuth consents.', until)
    } else if (/\bip\b|address|network|asn/.test(kind)) {
      add(entity, 'block', 'block-ip', "Block the attacker's IPs", `Block ${entity.name}`, 'Block it in Conditional Access (named location), firewalls and GitLab IP allowlists; keep it in the hunting queries.', until)
    } else add(entity, 'review', 'contain', 'Contain compromised systems', `Contain ${entity.name}`, 'Isolate it and check what else it reached.', until)
  }
  for (const entry of impacted) {
    // Everything the attacker did there also happened exactly so before the compromise: likely the regular owner.
    if (entry.regular) continue
    const { entity } = entry
    const done = new Set<string>()
    for (const use of entry.operations) {
      if (use.effect === 'attempt') continue
      const rule = rotationRule(use.operation, entity)
      if (!rule || done.has(rule.key)) continue
      done.add(rule.key)
      add(entity, rule.category, rule.key, rule.label, rule.title, rule.detail, use.last)
    }
  }
  const order: RotationCategory[] = ['revoke', 'rotate', 'block', 'review']
  return items.sort((a, b) => order.indexOf(a.category) - order.indexOf(b.category) || (b.lastUse ?? '').localeCompare(a.lastUse ?? ''))
}

/** What exposing or touching a resource requires, by operation (ARM provider path or GitLab audit event). */
export function rotationRule(operation: string, entity: Entity): { category: RotationCategory; key: string; label: string; title: string; detail: string } | null {
  const op = operation.toLowerCase(), name = entity.name
  if (/listcluster(admin|user|monitoringuser)credential/.test(op)) return { category: 'rotate', key: 'aks-certs', label: 'Rotate cluster certificates (kubeconfig retrieved)', title: `Rotate cluster certificates of ${name}`, detail: 'The kubeconfig was retrieved: az aks rotate-certs, then check the Kubernetes audit log for what it was used for.' }
  if (/containerregistry|registries/.test(op) && /listcredentials|regeneratecredential/.test(op)) return { category: 'rotate', key: 'acr-passwords', label: 'Regenerate container registry passwords', title: `Regenerate registry passwords of ${name}`, detail: 'az acr credential renew for both passwords (or disable the admin user); check pushes and pulls since.' }
  if (/storage/.test(op) && /listkeys|listaccountsas|listservicesas|regeneratekey/.test(op)) return { category: 'rotate', key: 'storage-keys', label: 'Rotate storage account keys', title: `Rotate storage keys of ${name}`, detail: 'Renew key1 and key2 (invalidates SAS signed with them) and check key-authenticated access in the storage logs.' }
  if (/cognitiveservices|openai/.test(op) && /listkeys|regeneratekey/.test(op)) return { category: 'rotate', key: 'ai-keys', label: 'Regenerate AI service keys', title: `Regenerate keys of ${name}`, detail: 'az cognitiveservices account keys regenerate for both keys; check usage since the keys were listed.' }
  if (/documentdb/.test(op) && /listkeys|listconnectionstrings|readonlykeys/.test(op)) return { category: 'rotate', key: 'cosmos-keys', label: 'Regenerate Cosmos DB keys', title: `Regenerate Cosmos DB keys of ${name}`, detail: 'Regenerate primary and secondary (read-write and read-only) keys.' }
  if (/servicebus|eventhub|relay|notificationhubs|signalr|webpubsub|cache\/redis/.test(op) && /listkeys|regeneratekey/.test(op)) return { category: 'rotate', key: 'access-keys', label: 'Regenerate shared access keys', title: `Regenerate access keys of ${name}`, detail: 'Regenerate the shared access keys and update the legitimate clients.' }
  if (/web\/sites|app service/.test(op) && /publishxml|publishingcredentials|config\/list/.test(op)) return { category: 'rotate', key: 'publishing', label: 'Reset App Service publishing credentials', title: `Reset publishing credentials of ${name}`, detail: 'Reset the publish profile and rotate secrets in the app settings and connection strings.' }
  if (/web\/sites/.test(op) && /listkeys|functions|host/.test(op)) return { category: 'rotate', key: 'function-keys', label: 'Renew function and host keys', title: `Renew function and host keys of ${name}`, detail: 'Renew the master, host and function keys; check calls with keys since.' }
  if (/app\/(containerapps|jobs|managedenvironments)/.test(op) && /listsecrets/.test(op)) return { category: 'rotate', key: 'app-secrets', label: 'Rotate container app and job secrets', title: `Rotate the secrets of ${name}`, detail: 'Every secret of the container app or job was readable: replace them at their origin and update the app.' }
  if (/keyvault|vaults|secret ?get|get ?secret|key ?get|certificate ?get/.test(op)) return { category: 'rotate', key: 'vault-secrets', label: 'Rotate secrets read from vaults', title: `Rotate secrets read from ${name}`, detail: 'Replace the secrets, keys and certificates that were read, at their origin.' }
  if (/variables? (viewed|accessed|read)|variable viewed/.test(op)) return { category: 'rotate', key: 'ci-variables', label: 'Rotate CI/CD variables (all of the project and its groups)', title: `Rotate CI/CD variables of ${name}`, detail: 'All variables of the project were readable, including inherited group variables: list them (see "Secrets and variables read") and replace every secret.' }
  if (/list[ _-]?keys|list[ _-]?secrets?|listcredentials?|regeneratekey/.test(op)) return { category: 'rotate', key: 'keys', label: 'Regenerate resource keys', title: `Regenerate keys of ${name}`, detail: 'Keys or credentials of the resource were read: regenerate them and update the legitimate clients.' }
  if (/file/i.test(entity.kind) && SECRET_FILE.test(name) && READ_OPERATION.test(op)) return { category: 'rotate', key: 'secret-files', label: 'Rotate secrets in files that were read', title: `Rotate secrets in ${name}`, detail: 'The file usually holds secrets: replace every secret it contains and remove it from the repository history.' }
  if (/file/i.test(entity.kind) && CI_FILE.test(name) && READ_OPERATION.test(op)) return { category: 'review', key: 'pipelines', label: 'Review pipeline definitions that were read', title: `Review pipeline ${name}`, detail: 'It names the variables, runners and deploy targets the attacker now knows; check it for inline secrets.' }
  if (/repositor|project/i.test(entity.kind) && /clone|pull|archive|download|export/.test(op)) return { category: 'review', key: 'repo-scan', label: 'Scan copied repositories for secrets', title: `Scan ${name} for secrets`, detail: 'The code was copied: scan the history for hard-coded secrets (e.g. gitleaks) and rotate what you find.' }
  if (/credential added|add service principal credentials|addpassword|addkey/.test(op)) return { category: 'revoke', key: 'attacker-credentials', label: 'Remove credentials the attacker added', title: `Remove ${name}`, detail: 'Added during the attack, by a compromised identity or from attacker infrastructure: a backdoor that survives rotating the stolen credential.' }
  if (/roleassignments\/write|federatedidentitycredentials|credentials\/write/.test(op)) return { category: 'review', key: 'access-changes', label: 'Remove access the attacker added', title: `Review access changes on ${name}`, detail: 'Role assignments or credentials were added: remove what the attacker created (persistence).' }
  return null
}

/** GitLab projects whose CI/CD variables were read: the audit log names the project, not the variables. */
export function variableExposures(impacted: Impacted[]): VariableExposure[] {
  const result: VariableExposure[] = []
  for (const entry of impacted) {
    const uses = entry.operations.filter(u => /variables? (viewed|accessed|read)|variable viewed/i.test(u.operation))
    if (!uses.length) continue
    const path = entry.entity.name.replace(/^\/+|\/+$/g, '')
    const segments = path.split('/')
    result.push({ entity: entry.entity, path, groups: segments.slice(0, -1).map((_, i) => segments.slice(0, i + 1).join('/')),
      count: uses.reduce((n, u) => n + u.count, 0), first: uses.reduce<string | null>((t, u) => earlier(t, u.first), null), last: uses.reduce<string | null>((t, u) => later(t, u.last), null) })
  }
  return result.sort((a, b) => a.path.localeCompare(b.path))
}

/** Shell snippet that lists the variable keys of the exposed projects and of the groups they inherit from (glab CLI). */
export function variableListingScript(exposures: VariableExposure[]): string {
  const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`
  const projects = exposures.map(e => quote(e.path)).join(' ')
  const groups = [...new Set(exposures.flatMap(e => e.groups))].sort().map(quote).join(' ')
  return [
    '# Lists the keys (not the values) of every CI/CD variable the attacker could read. Needs glab (glab auth login) and jq.',
    `for p in ${projects}; do echo "## project $p"; glab api "projects/$(jq -rn --arg v "$p" '$v|@uri')/variables" --paginate | jq -r '.[] | "\\(.key)\\t\\(.environment_scope)\\tprotected=\\(.protected)"'; done`,
    groups ? `for g in ${groups}; do echo "## group $g"; glab api "groups/$(jq -rn --arg v "$g" '$v|@uri')/variables" --paginate | jq -r '.[] | "\\(.key)\\t\\(.environment_scope)\\tprotected=\\(.protected)"'; done` : '',
  ].filter(Boolean).join('\n')
}

/** The impact as Markdown for a ticket or a handover. */
export function impactMarkdown(impact: Impact, nameOf: (id: string) => string, queries: { title: string; query: string }[] = []): string {
  const day = (t: string | null) => t ? t.slice(0, 16).replace('T', ' ') : '—'
  const lines = ['# Attack impact', '', `Window of attacker activity: ${day(impact.first)} – ${day(impact.last)} (UTC)`, '', '## Compromised']
  for (const seed of impact.seeds) {
    const c = compromiseOf(seed.entity)
    if (seed.derived) { lines.push(`- ${seed.entity.kind} **${seed.entity.name}** (derived): used from ${nameOf(seed.derived.via)} on ${day(seed.derived.at)}, so compromised no later than then`); continue }
    lines.push(`- ${seed.entity.kind} **${seed.entity.name}**${c?.from ? ` since ${day(c.from)}` : ''}${c?.to ? ` until ${day(c.to)}` : ''}${c?.note ? ` — ${c.note}` : ''}`)
  }
  lines.push('', '## What the attacker did')
  for (const step of impact.steps) lines.push(`- ${day(step.first)} – ${day(step.last)}: ${step.seeds.map(nameOf).join(', ')} · **${step.operation}** on ${step.targets.length} target${step.targets.length === 1 ? '' : 's'}${step.others.length ? ` with ${step.others.length} other${step.others.length === 1 ? '' : 's'}` : ''} (${step.count}×)`)
  lines.push('', '## Impacted resources')
  for (const effect of EFFECTS) {
    const list = impact.impacted.filter(i => i.effect === effect)
    if (!list.length) continue
    lines.push(`### ${EFFECT_LABEL[effect]} (${list.length})`)
    for (const entry of list) lines.push(`- ${entry.entity.kind} ${entry.entity.name}: ${entry.operations.map(o => `${o.operation} ×${o.count}`).join(', ')} (last ${day(entry.last)})`)
  }
  lines.push('', '## Rotate, revoke, block')
  for (const item of impact.rotation) lines.push(`- [${item.rotatedAt && !item.stale ? 'x' : ' '}] ${item.category}: ${item.title}${item.stale ? ' — attacker active after rotation' : ''}`)
  if (queries.length) {
    lines.push('', '## Hunting queries')
    for (const q of queries) lines.push('', `### ${q.title}`, '```kusto', q.query, '```')
  }
  return lines.join('\n')
}

export type ExportBadge = { tone: 'bad' | 'warn' | 'pivot' | 'muted' | 'good'; label: string }
const BADGE_LABEL: Record<Effect, string> = { secret: 'Secrets exposed', delete: 'Deleted', write: 'Changed', read: 'Read', auth: 'Signed in', attempt: 'Attempted', other: 'Touched' }
/** Labels for exported images: the same markers as on the canvas, by entity and by group, and the attacker's facts. */
export function exportMarks(impact: Impact, groups: { id: string; member_ids: string[] }[]): { badges: Map<string, ExportBadge>; attack: Set<string> } {
  const badges = new Map<string, ExportBadge>()
  if (!impact.seeds.length) return { badges, attack: new Set() }
  const effects = new Map(impact.impacted.map(i => [i.entity.id, i.effect]))
  const regular = new Set(impact.impacted.filter(i => i.regular).map(i => i.entity.id))
  const suspected = new Set(impact.seeds.filter(s => s.suspected).map(s => s.entity.id))
  for (const [id, mark] of impact.marks) {
    const effect = effects.get(id) ?? 'other'
    if (mark === 'impacted' && regular.has(id)) { badges.set(id, { tone: 'muted', label: 'Likely regular' }); continue }
    if (mark === 'good') { badges.set(id, { tone: 'good', label: 'Good' }); continue }
    badges.set(id, mark === 'compromised' ? { tone: 'bad', label: suspected.has(id) ? 'Suspected' : 'Compromised' } : mark === 'derived' ? { tone: 'bad', label: suspected.has(id) ? 'Suspected (derived)' : 'Compromised (derived)' } : mark === 'pivot' ? { tone: 'pivot', label: 'New with attacker' }
      : { tone: effect === 'secret' || effect === 'delete' ? 'bad' : effect === 'attempt' || effect === 'other' ? 'muted' : 'warn', label: BADGE_LABEL[effect] })
  }
  for (const group of groups) {
    let compromised = 0, impacted = 0
    for (const id of group.member_ids) { const mark = impact.marks.get(id); if (mark === 'compromised' || mark === 'derived') compromised++; else if (mark === 'impacted') impacted++ }
    if (compromised || impacted) badges.set(`group:${group.id}`, { tone: compromised ? 'bad' : 'warn', label: [compromised && `${compromised} compromised`, impacted && `${impacted} impacted`].filter(Boolean).join(' · ') })
  }
  // Red edges for what is likely the attacker's; "likely regular" activity keeps its normal colour, as on the canvas.
  return { badges, attack: new Set([...impact.facts.values()].filter(f => !f.before).map(f => f.fact.id)) }
}

/** Readouts that can hand out someone else's credential (as opposed to a resource's own service keys). */
const HOLDS_SECRETS = /variable|secret ?get|get ?secret|vaults?\/secrets|listsecrets|file accessed|publishxml|publishingcredentials|config\/list|listconnectionstrings|git (clone|pull)|archive|download/i
export type TraceEntry = { at: string; entity: Entity; via: string | null; derived: boolean; exposedBy: Step[] }
/**
 * How it started: when each compromised entity was first used by the attacker, earliest first, and the secret readouts
 * by other compromised entities that ended before that first use: where a derived credential was probably taken from.
 */
/** "10 days", "3 hours", "12 minutes": the time between two moments, for wording that does not overstate closeness. */
export function gapText(from: string, to: string): string {
  const minutes = Math.max(0, Math.round((Date.parse(to) - Date.parse(from)) / 60_000))
  const unit = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`
  return minutes < 60 ? unit(minutes, 'minute') : minutes < 48 * 60 ? unit(Math.round(minutes / 60), 'hour') : unit(Math.round(minutes / 1440), 'day')
}

export function traceBack(impact: Impact): TraceEntry[] {
  const entries: TraceEntry[] = []
  for (const seed of impact.seeds) {
    let at = seed.derived?.at ?? null
    if (!at) for (const attack of impact.facts.values()) if (attack.seeds.includes(seed.entity.id) && attack.first && attack.effect !== 'attempt' && (!at || attack.first < at)) at = attack.first
    if (!at) continue
    const exposedBy = impact.steps.filter(step => (step.effect === 'secret' || step.effect === 'read') && HOLDS_SECRETS.test(step.operation) && !step.regular && step.first && step.first < at! && !step.seeds.includes(seed.entity.id))
      .sort((a, b) => (b.first ?? '').localeCompare(a.first ?? '')).slice(0, 3)
    entries.push({ at, entity: seed.entity, via: seed.derived?.via ?? null, derived: !!seed.derived, exposedBy })
  }
  return entries.sort((a, b) => a.at.localeCompare(b.at))
}

/** One use of a session token (Entra UniqueTokenIdentifier / `uti` claim), read from the original row of an evidence item. */
export type SessionUse = { at: string; fact: string; item: string; ip: string | null; identity: string | null; agent: string | null }
/**
 * A session token used from more than one IP. With an attacker IP among them: `redirector` when the other source came
 * up with or after the attacker (their proxy or second exit), `theft` when it used the session first (the token was
 * taken from there). Without one: `replay`, a candidate.
 */
export type SessionFinding = { uti: string; kind: 'redirector' | 'theft' | 'replay'; identity: string | null; uses: SessionUse[]; sources: string[]; attacker: string[]; others: string[]; first: string; last: string }

const UTI = /"(?:UniqueTokenIdentifier|uti|SignInActivityId)":\s*"([A-Za-z0-9_-]{12,})"/
const AGENT = /"(?:UserAgent|userAgent|user_agent)":\s*"([^"]{3,300})"/
type Signals = { sessions: Map<string, SessionUse[]>; agents: Map<string, SessionUse[]>; agentOf: Map<string, string> }
const signalCache = new WeakMap<object, Signals>()

/**
 * Session tokens and user agents from the original rows of every evidence item, with when, from which IP and as whom
 * they were used. One pass over the evidence, cached per board state.
 */
export function rowSignals(data: Pick<GraphData, 'entities' | 'facts'>): Signals {
  const cached = signalCache.get(data.facts)
  if (cached) return cached
  const kinds = new Map(data.entities.map(e => [e.id, e.kind]))
  const sessions = new Map<string, SessionUse[]>(), agents = new Map<string, SessionUse[]>(), agentOf = new Map<string, string>()
  for (const fact of data.facts) {
    const parts = fact.participants ?? []
    const ip = parts.find(p => p.role === 'source' && /\bip\b/i.test(kinds.get(p.entity_id) ?? ''))?.entity_id ?? null
    const identity = parts.find(p => (p.role === 'identity' || p.role === 'actor') && USABLE.test(kinds.get(p.entity_id) ?? ''))?.entity_id ?? null
    for (const item of fact.assertions) {
      if (item.retracted_at || !item.valid_from || !item.note) continue
      const hasSession = item.note.includes('niqueTokenIdentifier') || item.note.includes('"uti"') || item.note.includes('SignInActivityId')
      const hasAgent = item.note.includes('serAgent') || item.note.includes('user_agent')
      if (!hasSession && !hasAgent) continue
      const uti = hasSession ? UTI.exec(item.note)?.[1] : undefined
      const agent = hasAgent ? AGENT.exec(item.note)?.[1] ?? null : null
      const use = { at: item.valid_from, fact: fact.id, item: item.id, ip, identity, agent }
      if (uti) { let list = sessions.get(uti); if (!list) sessions.set(uti, list = []); list.push(use) }
      if (agent) { let list = agents.get(agent); if (!list) agents.set(agent, list = []); list.push(use); agentOf.set(item.id, agent) }
    }
  }
  const signals = { sessions, agents, agentOf }
  signalCache.set(data.facts, signals)
  return signals
}
export const sessionUses = (data: Pick<GraphData, 'entities' | 'facts'>) => rowSignals(data).sessions

/**
 * A user agent that came with the attacker: first seen in an attacker activity, not used by the compromised identities
 * before the compromise. `others`: unmarked IPs with the same agent (the same tooling, possibly the same attacker).
 * `common`: also widely used elsewhere, so a weak signal.
 */
export type AgentFinding = { agent: string; attackerIps: string[]; others: string[]; first: string; uses: number; baseline: boolean; common: boolean; facts: string[] }
const SCRIPTED = /python|curl|wget|go-http|powershell|okhttp|axios|node-fetch|httpclient|libwww|java\/|ruby|perl|postman|insomnia|sqlmap|nmap|masscan|zgrab/i
export function agentFindings(data: Pick<GraphData, 'entities' | 'facts'>, impact: Impact): AgentFinding[] {
  if (!impact.facts.size) return []
  const { agents, agentOf } = rowSignals(data)
  if (!agents.size) return []
  const seedFrom = new Map(impact.seeds.map(s => [s.entity.id, s.from]))
  const marked = (id: string) => impact.marks.get(id) === 'compromised' || impact.marks.get(id) === 'derived'
  const good = new Set(data.entities.filter(e => compromiseOf(e)?.cleared).map(e => e.id))
  const factById = new Map(data.facts.map(f => [f.id, f]))
  const used = new Map<string, { ips: Set<string>; first: string; facts: Set<string> }>()
  for (const attack of impact.facts.values()) for (const item of attack.fact.assertions) {
    const agent = agentOf.get(item.id)
    if (!agent || !item.valid_from || (attack.first && item.valid_from < attack.first)) continue
    const entry = used.get(agent) ?? { ips: new Set<string>(), first: item.valid_from, facts: new Set<string>() }
    const ip = (attack.fact.participants ?? []).find(p => p.role === 'source' && marked(p.entity_id))?.entity_id
    if (ip) entry.ips.add(ip)
    if (item.valid_from < entry.first) entry.first = item.valid_from
    entry.facts.add(attack.fact.id); used.set(agent, entry)
  }
  const findings: AgentFinding[] = []
  for (const [agent, entry] of used) {
    const all = agents.get(agent) ?? []
    // Used by a compromised identity before its compromise: their normal tooling.
    const baseline = all.some(u => (factById.get(u.fact)?.participants ?? []).some(p => p.role !== 'target' && seedFrom.has(p.entity_id) && Date.parse(u.at) < seedFrom.get(p.entity_id)!))
    const ips = new Set(all.map(u => u.ip).filter(Boolean))
    const others = [...new Set(all.filter(u => u.ip && !marked(u.ip) && !good.has(u.ip)).map(u => u.ip!))]
    findings.push({ agent, attackerIps: [...entry.ips], others, first: entry.first, uses: all.length, baseline, common: ips.size > 25, facts: [...entry.facts] })
  }
  return findings.sort((a, b) => Number(a.baseline) - Number(b.baseline) || Number(a.common) - Number(b.common) || Number(!SCRIPTED.test(a.agent)) - Number(!SCRIPTED.test(b.agent)) || a.others.length - b.others.length)
}

/** Sessions the attacker worked in: what happened within one sign-in, from where, until the token's last use. */
export type AttackSession = { uti: string; identity: string | null; start: string; end: string; ips: string[]; facts: string[]; operations: [string, number][]; uses: number }
export function attackSessions(data: Pick<GraphData, 'entities' | 'facts'>, impact: Impact): AttackSession[] {
  const facts = new Map(data.facts.map(f => [f.id, f]))
  const result: AttackSession[] = []
  for (const [uti, uses] of rowSignals(data).sessions) {
    if (!uses.some(u => impact.facts.has(u.fact))) continue
    uses.sort((a, b) => a.at.localeCompare(b.at))
    const ops = new Map<string, number>()
    for (const u of uses) { const op = facts.get(u.fact)?.predicate ?? '?'; ops.set(op, (ops.get(op) ?? 0) + 1) }
    result.push({ uti, identity: uses.find(u => u.identity)?.identity ?? null, start: uses[0].at, end: uses[uses.length - 1].at, ips: [...new Set(uses.map(u => u.ip).filter((x): x is string => !!x))],
      facts: [...new Set(uses.map(u => u.fact))], operations: [...ops].sort((a, b) => b[1] - a[1]), uses: uses.length })
  }
  return result.sort((a, b) => b.ips.length - a.ips.length || b.uses - a.uses || a.start.localeCompare(b.start))
}

export function sessionFindings(data: Pick<GraphData, 'entities' | 'facts'>, impact: Impact): SessionFinding[] {
  const byId = new Map(data.entities.map(e => [e.id, e]))
  // Explicit or derived attacker infrastructure, but not what was derived from the session itself (those are its findings).
  const bySession = new Set(impact.seeds.filter(s => s.derived?.reason === 'session').map(s => s.entity.id))
  const attackerIp = (id: string) => { const mark = impact.marks.get(id); return (mark === 'compromised' || mark === 'derived') && !bySession.has(id) && INFRASTRUCTURE.test(byId.get(id)?.kind ?? '') }
  const findings: SessionFinding[] = []
  for (const [uti, uses] of sessionUses(data)) {
    const sources = [...new Set(uses.map(u => u.ip).filter((ip): ip is string => !!ip))]
    if (sources.length < 2) continue
    uses.sort((a, b) => a.at.localeCompare(b.at))
    const firstAt = (ip: string) => uses.find(u => u.ip === ip)!.at
    const attacker = sources.filter(attackerIp), others = sources.filter(ip => !attackerIp(ip))
    let kind: SessionFinding['kind'] = 'replay'
    if (attacker.length && others.length) {
      const attackerFirst = attacker.map(firstAt).sort()[0]
      kind = others.some(ip => firstAt(ip) < attackerFirst) ? 'theft' : 'redirector'
    } else if (attacker.length) continue  // only attacker IPs: nothing new
    findings.push({ uti, kind, identity: uses.find(u => u.identity)?.identity ?? null, uses, sources, attacker, others, first: uses[0].at, last: uses[uses.length - 1].at })
  }
  const order = { redirector: 0, theft: 1, replay: 2 }
  return findings.sort((a, b) => order[a.kind] - order[b.kind] || b.uses.length - a.uses.length)
}

export type Advice = {
  id: string; severity: 'high' | 'medium' | 'info'; title: string; detail: string
  /** Entities to look at; `mark` are the ones the advice suggests marking compromised. */
  entities: string[]; mark?: string[]; confirm?: string[]; facts?: string[]; query?: string
}

const ASN = /"AutonomousSystemNumber":\s*"?(\d+)|\bASN (\d+)/
/** Network provider (AS number) per IP, and the providers each compromised entity used before its window. */
export function networkProviders(data: Pick<GraphData, 'entities' | 'facts'>, impact: Impact) {
  const kinds = new Map(data.entities.map(e => [e.id, e.kind]))
  const seeds = new Map(impact.seeds.map(s => [s.entity.id, s]))
  const ipAsn = new Map<string, string>(), before = new Map<string, Set<string>>()
  for (const fact of data.facts) {
    const parts = fact.participants ?? []
    const ip = parts.find(p => p.role === 'source' && /\bip\b/i.test(kinds.get(p.entity_id) ?? ''))?.entity_id
    if (!ip) continue
    for (const item of fact.assertions) {
      const m = ASN.exec(item.observation ?? '') ?? (item.note?.includes('AutonomousSystemNumber') ? ASN.exec(item.note) : null)
      const asn = m?.[1] ?? m?.[2]
      if (!asn) continue
      ipAsn.set(ip, asn)
      const t = item.valid_from ? Date.parse(item.valid_from) : NaN
      for (const p of parts) { const seed = seeds.get(p.entity_id); if (seed && p.role !== 'target' && t < seed.from) { let set = before.get(seed.entity.id); if (!set) before.set(seed.entity.id, set = new Set()); set.add(asn) } }
    }
  }
  return { ipAsn, before }
}

/** The network an address sits in: /24 for IPv4, /64 for IPv6 (one customer or host network). */
export function subnet(ip: string): string | null {
  const v4 = /^(\d{1,3}\.\d{1,3}\.\d{1,3})\.\d{1,3}$/.exec(ip.trim())?.[1]
  if (v4) return `${v4}.0/24`
  const text = ip.trim().toLowerCase().replace(/^\[|\]$/g, '').split('%')[0]
  if (!/^[0-9a-f:]+$/.test(text) || !text.includes(':') || (text.match(/::/g)?.length ?? 0) > 1) return null
  const [head, tail = ''] = text.split('::')
  const left = head ? head.split(':') : [], right = text.includes('::') ? (tail ? tail.split(':') : []) : []
  const groups = text.includes('::') ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right] : left
  if (groups.length !== 8 || groups.some(g => !/^[0-9a-f]{1,4}$/.test(g))) return null
  return `${groups.slice(0, 4).map(g => parseInt(g, 16).toString(16)).join(':')}::/64`
}

/** What the evidence suggests doing next, most important first; every advice names the evidence it rests on. */
export function adviceFor(data: Pick<GraphData, 'entities' | 'facts'>, impact: Impact): Advice[] {
  if (!impact.seeds.length) return []
  const byId = new Map(data.entities.map(e => [e.id, e]))
  const name = (id: string) => byId.get(id)?.name ?? id
  const short = (t: string) => t.slice(0, 16).replace('T', ' ')
  const advice: Advice[] = []
  const attackerIps = impact.seeds.filter(s => INFRASTRUCTURE.test(s.entity.kind)).map(s => s.entity)
  const attackerNets = new Set(attackerIps.map(e => subnet(e.name)).filter(Boolean))
  for (const finding of sessionFindings(data, impact).slice(0, 20)) {
    const who = finding.identity ? name(finding.identity) : 'an identity'
    const facts = [...new Set(finding.uses.map(u => u.fact))]
    if (finding.kind === 'redirector') advice.push({ id: `uti-${finding.uti}`, severity: 'high', title: `Same session from the attacker and ${finding.others.map(name).join(', ')}: likely attacker infrastructure`,
      detail: `The token ${finding.uti.slice(0, 10)}… of ${who} was used from ${finding.attacker.map(name).join(', ')} and, not before that, from ${finding.others.map(name).join(', ')} (${short(finding.first)} – ${short(finding.last)} UTC). A session does not move between machines by itself: the other source is most likely a redirector, proxy or second exit of the attacker.`,
      entities: finding.sources, mark: finding.others, facts, query: 'session-replay' })
    else if (finding.kind === 'theft') advice.push({ id: `uti-${finding.uti}`, severity: 'high', title: `Session token stolen from ${finding.others.map(name).join(', ')}?`,
      detail: `The token ${finding.uti.slice(0, 10)}… of ${who} was first used from ${finding.others.map(name).join(', ')} and later from the attacker's ${finding.attacker.map(name).join(', ')}. If the first source is legitimate, the token leaked there (infostealer, logs, a proxy): investigate that system, revoke the sessions of ${who} and consider token protection / continuous access evaluation.`,
      entities: finding.sources, facts, query: 'session-replay' })
    else advice.push({ id: `uti-${finding.uti}`, severity: 'medium', title: `Session of ${who} used from ${finding.sources.length} IPs`,
      detail: `Token ${finding.uti.slice(0, 10)}… came from ${finding.sources.map(name).join(', ')} between ${short(finding.first)} and ${short(finding.last)} UTC. Unless these are known egress points of the same network, this is a replayed token.`,
      entities: finding.sources, mark: finding.sources, facts, query: 'session-replay' })
  }
  for (const finding of agentFindings(data, impact).filter(f => !f.baseline).slice(0, 6)) {
    const weak = finding.common || !SCRIPTED.test(finding.agent)
    advice.push({ id: `ua-${finding.agent}`, severity: finding.others.length && !weak ? 'high' : 'medium',
      title: finding.others.length ? `${finding.others.length} other IP${finding.others.length === 1 ? '' : 's'} used the attacker's user agent ${finding.agent}` : `The attacker's user agent: ${finding.agent}`,
      detail: `First seen in attacker activity ${short(finding.first)} UTC${finding.attackerIps.length ? ` from ${finding.attackerIps.map(name).join(', ')}` : ''}, never used by the compromised identities before the compromise. ${finding.others.length ? `Also used from ${finding.others.slice(0, 5).map(name).join(', ')}${finding.others.length > 5 ? ` +${finding.others.length - 5}` : ''}: the same tooling, possibly the same attacker.` : 'Hunt for it elsewhere.'}${weak ? ' A common or browser agent: weak on its own, combine it with the IP, ASN or time.' : ''}`,
      entities: [...finding.attackerIps, ...finding.others.slice(0, 5)], mark: finding.others.slice(0, 4), facts: finding.facts.slice(0, 1), query: 'agent-hunt' })
  }
  const blind = impact.seeds.filter(s => !(impact.history.get(s.entity.id) ?? 0) && s.from !== -Infinity)
  if (blind.length) advice.push({ id: 'baseline', severity: 'medium', title: `No events before the compromise for ${blind.length === 1 ? name(blind[0].entity.id) : `${blind.length} compromised entities`}`,
    detail: `${blind.slice(0, 5).map(s => name(s.entity.id)).join(', ')}: nothing on the board from before ${short(new Date(Math.min(...blind.map(s => s.from))).toISOString())} UTC, so FactGraph cannot tell their usual IPs, agents and operations from the attacker's. Import an export that starts two weeks or more earlier ("Where else was the stolen credential used" starts there) to build a baseline.`,
    entities: blind.map(s => s.entity.id), query: 'credential-use' })
  for (const entry of traceBack(impact)) if (entry.exposedBy.length && entry.derived) {
    const step = entry.exposedBy[0]
    const gap = gapText(step.last ?? step.first ?? entry.at, entry.at)
    // Only the order in time points there: a hypothesis to check, not a proven way in.
    advice.push({ id: `trace-${entry.entity.id}`, severity: 'medium', title: `Possible origin of ${name(entry.entity.id)}: ${step.operation} (${gap} earlier)`,
      detail: `Hypothesis from timing only. ${step.seeds.map(name).join(', ')} ran ${step.operation} on ${step.targets.length} target${step.targets.length === 1 ? '' : 's'} (${short(step.first ?? '')} – ${short(step.last ?? '')} UTC); the attacker first used ${name(entry.entity.id)} ${gap} later (${short(entry.at)} UTC). Nothing on the board ties what was read there to this credential (no secret name or key ID in common). Confirm it by finding the credential among what was read, or rule it out.`,
      entities: [entry.entity.id, ...step.targets.slice(0, 5)], facts: step.facts.slice(0, 1) })
  }
  // Keys regenerated or credentials removed by the attacker: the new keys are theirs, or the owner was locked out.
  for (const attack of impact.facts.values()) if (ROTATION_EVIDENCE.test(attack.fact.predicate) && attack.effect !== 'attempt' && !attack.before) {
    const targets = (attack.fact.participants?.filter(p => p.role === 'target').map(p => p.entity_id) ?? [attack.fact.object_id])
    advice.push({ id: `attacker-rotation-${attack.fact.id}`, severity: 'high', title: `The attacker ran ${attack.fact.predicate} on ${targets.map(name).join(', ')}`,
      detail: `${attack.count}× between ${short(attack.first ?? '')} and ${short(attack.last ?? '')} UTC by ${attack.seeds.map(name).join(', ')}. This is not a rotation in your favour: regenerated keys are in the attacker's hands, removed credentials may lock out the owner. Rotate again once the attacker's access is cut, and check that the legitimate clients still work.`,
      entities: [...attack.seeds, ...targets], facts: [attack.fact.id] })
  }
  for (const item of impact.rotation.filter(r => r.stale)) advice.push({ id: `stale-${item.id}`, severity: 'high', title: `Attacker active after rotation: ${item.title}`,
    detail: `Rotated ${short(item.rotatedAt ?? '')} UTC, but used by the attacker until ${short(item.lastUse ?? '')} UTC. Rotate again and find the second way in (another credential, a session token, persistence).`, entities: [item.entityId] })
  const newIps = impact.pivots.filter(p => !p.before && INFRASTRUCTURE.test(p.entity.kind) && !compromiseOf(p.entity)?.cleared)
  const providers = newIps.length ? networkProviders(data, impact) : null
  const attackerAsns = new Set(attackerIps.map(e => providers?.ipAsn.get(e.id)).filter(Boolean))
  for (const pivot of newIps.slice(0, 12)) {
    const sameNet = attackerNets.has(subnet(pivot.entity.name))
    const asn = providers?.ipAsn.get(pivot.entity.id)
    const usualProvider = !!asn && pivot.seeds.some(id => providers!.before.get(id)?.has(asn)) && !attackerAsns.has(asn)
    const attackerProvider = !!asn && attackerAsns.has(asn)
    // "New" only means something if the compromised entity had history before: otherwise everything is new.
    const known = Math.max(0, ...pivot.seeds.map(id => impact.history.get(id) ?? 0))
    const thin = known < 20
    advice.push({ id: `pivot-${pivot.entity.id}`, severity: sameNet || attackerProvider || (pivot.count >= 5 && !thin && !usualProvider) ? 'high' : usualProvider ? 'info' : 'medium',
      title: `${pivot.entity.name}: ${sameNet ? `same network (${subnet(pivot.entity.name)}) as a known attacker IP` : attackerProvider ? `same network provider (AS${asn}) as the attacker` : usualProvider ? `new IP, but the usual provider (AS${asn})` : 'new since the compromise'}`,
      detail: `Used ${pivot.count}× with compromised ${pivot.seeds.map(name).join(', ')} (${short(pivot.first ?? '')} – ${short(pivot.last ?? '')} UTC) and never before the compromise.${sameNet ? ' Its network neighbour is already known as attacker infrastructure.' : ''}${usualProvider ? ` Its network (AS${asn}) was already used by the same identity before the compromise: most likely a rotating cloud or CI egress, not the attacker.` : asn && !attackerProvider ? ` Network provider AS${asn} was not seen with it before.` : ''}${thin ? ` Only ${known} event${known === 1 ? '' : 's'} before the compromise to compare with, so "new" says little: check whether it is one of your own cloud or CI egress addresses first.` : ''} If it is not a known egress of yours, mark it: its own activity then joins the analysis.`,
      entities: [pivot.entity.id], mark: [pivot.entity.id] })
  }
  const attempts = [...impact.facts.values()].filter(a => a.effect === 'attempt')
  const tried = new Map<string, string>()
  for (const attempt of attempts) for (const p of attempt.fact.participants ?? []) {
    const entity = byId.get(p.entity_id)
    if (entity && p.role !== 'target' && /credential|token|secret|certificate/i.test(entity.kind) && !impact.marks.has(entity.id) && !tried.has(entity.id)) tried.set(entity.id, attempt.fact.id)
  }
  if (tried.size) advice.push({ id: 'tried', severity: 'medium', title: `The attacker also tried ${tried.size} other credential${tried.size === 1 ? '' : 's'} (failed)`,
    detail: `${[...tried.keys()].slice(0, 5).map(name).join(', ')}: they knew these, so they were exposed somewhere. Check whether they work elsewhere or worked before, and rotate them.`, entities: [...tried.keys()], facts: [...tried.values()] })
  const derived = impact.seeds.filter(s => s.derived)
  if (derived.length) advice.push({ id: 'confirm-derived', severity: 'info', title: `${derived.length} derived compromise${derived.length === 1 ? '' : 's'} to confirm`,
    detail: `Used successfully from attacker infrastructure: ${derived.slice(0, 5).map(s => `${name(s.entity.id)} (${short(s.derived!.at)})`).join(', ')}. Confirm them, or mark the ones that are not compromised.`, entities: derived.map(s => s.entity.id), confirm: derived.map(s => s.entity.id) })
  const unproven = impact.rotation.filter(r => (r.key === 'revoke-secret' || r.key === 'rotate-identity') && !r.proof && !r.rotatedAt)
  if (unproven.length) advice.push({ id: 'prove', severity: 'medium', title: `Rotation of ${unproven.length} stolen credential${unproven.length === 1 ? '' : 's'} not proven yet`,
    detail: 'Run "Prove the rotation", export the result as CSV and drop it here: removed keys tick themselves off, keys added during the attack show up as backdoors.', entities: unproven.map(r => r.entityId), query: 'rotation-proof' })
  if (impact.first) advice.push({ id: 'earlier', severity: 'info', title: `Nothing known before ${short(impact.first)} UTC`,
    detail: 'The first attacker activity on the board is rarely the first one. Run the queries for the attacker IPs and the stolen credentials (they start two weeks earlier) and drop the exports here.', entities: [], query: 'ip-everywhere' })
  const order = { high: 0, medium: 1, info: 2 }
  return advice.sort((a, b) => order[a.severity] - order[b.severity])
}

/** Where to start when nothing is marked yet: patterns in the evidence that usually mean an attack. */
export type StartingPoint = { id: string; title: string; detail: string; entities: string[]; mark: string[]; fact: string }
const ENCODED = /(?:^|\s)-(?:e|en|enc|encodedcommand)\s+[A-Za-z0-9+/=]{8,}|frombase64string|iex\s*\(|invoke-expression|downloadstring|downloadfile|invoke-webrequest|certutil[^\n]*-urlcache|bitsadmin[^\n]*\/transfer|mshta\s+https?:|regsvr32[^\n]*\/i:http/i
const OFFICE = /^(winword|excel|outlook|powerpnt|onenote|msaccess|mspub)\.exe$/i
const SHELL = /^(powershell|pwsh|cmd|wscript|cscript|mshta|rundll32|regsvr32|bash|sh)(\.exe)?$/i
export function startingPoints(data: Pick<GraphData, 'entities' | 'facts'>): StartingPoint[] {
  const byId = new Map(data.entities.map(e => [e.id, e]))
  const name = (id: string) => byId.get(id)?.name ?? id
  const points: StartingPoint[] = []
  const seen = new Set<string>()
  const markable = (ids: string[]) => ids.filter(id => /device|host|user|account|service principal|credential|\bip\b/i.test(byId.get(id)?.kind ?? '') && !compromiseOf(byId.get(id)!))
  const spray = new Map<string, { failed: number; ok: number; identities: Set<string>; fact: string }>()
  const secretReads = new Map<string, { ops: number; targets: Set<string>; fact: string }>()
  for (const fact of data.facts) {
    const parts = fact.participants ?? []
    const ids = parts.map(p => p.entity_id)
    const command = fact.assertions.map(a => a.note).find(note => note && ENCODED.test(note))
    if (command && !seen.has(`cmd${fact.id}`)) {
      seen.add(`cmd${fact.id}`)
      const line = (/"(?:ProcessCommandLine|CommandLine|InitiatingProcessCommandLine)":\s*"([^"]{0,140})/.exec(command)?.[1] ?? ENCODED.exec(command)?.[0] ?? '').trim()
      points.push({ id: `cmd-${fact.id}`, title: `Encoded or download command: ${line.slice(0, 80)}`, detail: `${fact.predicate} with ${ids.map(name).join(', ')}. Obfuscated PowerShell or a download cradle is a typical first step; mark the device or account as suspected to see what followed.`, entities: ids, mark: markable(ids), fact: fact.id })
    }
    const names = parts.map(p => byId.get(p.entity_id)?.name.split(/[\\/]/).pop() ?? '')
    if (names.some(n => OFFICE.test(n)) && names.some(n => SHELL.test(n)) && !seen.has(`office${fact.id}`)) {
      seen.add(`office${fact.id}`)
      points.push({ id: `office-${fact.id}`, title: `${names.find(n => OFFICE.test(n))} started ${names.find(n => SHELL.test(n))}`, detail: `An Office application launching a shell (${ids.map(name).join(', ')}) is the classic sign of a malicious document or mail attachment.`, entities: ids, mark: markable(ids), fact: fact.id })
    }
    const effect = effectOf(fact.predicate)
    const ip = parts.find(p => p.role === 'source' && /\bip\b/i.test(byId.get(p.entity_id)?.kind ?? ''))?.entity_id
    if (ip && AUTH_OPERATION.test(fact.predicate)) {
      const entry = spray.get(ip) ?? { failed: 0, ok: 0, identities: new Set<string>(), fact: fact.id }
      const count = fact.assertions.length
      if (effect === 'attempt') entry.failed += count; else { entry.ok += count; entry.fact = fact.id }
      for (const p of parts) if (p.role === 'identity' || p.role === 'actor') entry.identities.add(p.entity_id)
      spray.set(ip, entry)
    }
    if (effect === 'secret') for (const p of parts) if ((p.role === 'identity' || p.role === 'actor') && USABLE.test(byId.get(p.entity_id)?.kind ?? '')) {
      const entry = secretReads.get(p.entity_id) ?? { ops: 0, targets: new Set<string>(), fact: fact.id }
      entry.ops += fact.assertions.length
      parts.filter(t => t.role === 'target').forEach(t => entry.targets.add(t.entity_id))
      secretReads.set(p.entity_id, entry)
    }
  }
  for (const [ip, entry] of spray) if (entry.failed >= 5 && entry.ok > 0)
    points.push({ id: `spray-${ip}`, title: `${entry.failed} failed, then ${entry.ok} successful sign-ins from ${name(ip)}`, detail: `Against ${entry.identities.size} identit${entry.identities.size === 1 ? 'y' : 'ies'}: guessing or spraying that eventually worked.`, entities: [ip, ...entry.identities], mark: markable([ip]), fact: entry.fact })
  for (const [id, entry] of [...secretReads].sort((a, b) => b[1].targets.size - a[1].targets.size).slice(0, 3)) if (entry.targets.size >= 3)
    points.push({ id: `secrets-${id}`, title: `${name(id)} read keys or secrets of ${entry.targets.size} resources`, detail: 'Collecting credentials across many resources in a short time is how attackers widen access. Check whether this is its normal job.', entities: [id], mark: markable([id]), fact: entry.fact })
  return points.slice(0, 12)
}

/** The case at a glance: what is known, what is only suspected, and the questions the evidence does not answer yet. */
export type CaseGap = { question: string; why: string; query?: string; entities: string[] }
export type CaseSummary = { known: string[]; suspected: string[]; gaps: CaseGap[] }
export function caseSummary(data: Pick<GraphData, 'entities' | 'facts'>, impact: Impact): CaseSummary {
  const byId = new Map(data.entities.map(e => [e.id, e]))
  const name = (id: string) => byId.get(id)?.name ?? id
  const short = (t: string | null) => t ? t.slice(0, 16).replace('T', ' ') : '?'
  const list = (ids: string[], max = 3) => ids.slice(0, max).map(name).join(', ') + (ids.length > max ? ` and ${ids.length - max} more` : '')
  const confirmed = impact.seeds.filter(s => !s.suspected && !s.derived).map(s => s.entity.id)
  const suspected = impact.seeds.filter(s => s.suspected && !s.derived).map(s => s.entity.id)
  const derived = impact.seeds.filter(s => s.derived).map(s => s.entity.id)
  const known: string[] = [], maybe: string[] = [], gaps: CaseGap[] = []
  if (confirmed.length) known.push(`Compromised: ${list(confirmed)}.`)
  // "Known" rests on confirmed compromises only; what only suspected or derived entities did is listed as suspected.
  const sure = new Set(confirmed)
  const byConfirmed = (ids: string[]) => ids.some(id => sure.has(id))
  const sureFacts = [...impact.facts.values()].filter(f => byConfirmed(f.seeds) && !f.before)
  const window = sureFacts.reduce<[string | null, string | null]>(([a, b], f) => [earlier(a, f.first), later(b, f.last)], [null, null])
  if (window[0]) known.push(`Attacker activity by confirmed compromised entities from ${short(window[0])} to ${short(window[1])} UTC (${sureFacts.reduce((n, f) => n + f.count, 0).toLocaleString('en')} evidence items).`)
  else if (impact.first) maybe.push(`Activity in the compromise windows from ${short(impact.first)} to ${short(impact.last)} UTC, by suspected or derived entities only.`)
  const kindsOf = (entries: Impacted[]) => { const kinds = new Map<string, number>(); entries.forEach(i => kinds.set(i.entity.kind, (kinds.get(i.entity.kind) ?? 0) + 1)); return [...kinds].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${n} ${k}`).join(', ') }
  const secrets = impact.impacted.filter(i => i.effect === 'secret' && !i.regular)
  const sureSecrets = secrets.filter(i => byConfirmed(i.seeds)), maybeSecrets = secrets.filter(i => !byConfirmed(i.seeds))
  if (sureSecrets.length) known.push(`Secrets possibly exposed on ${sureSecrets.length} resources (a secret-read operation succeeded): ${kindsOf(sureSecrets)}.`)
  if (maybeSecrets.length) maybe.push(`Secrets possibly exposed on ${maybeSecrets.length} more resources, by suspected or derived entities: ${kindsOf(maybeSecrets)}.`)
  const changed = impact.impacted.filter(i => (i.effect === 'write' || i.effect === 'delete') && !i.regular)
  const sureChanged = changed.filter(i => byConfirmed(i.seeds))
  if (sureChanged.length) known.push(`${sureChanged.length} resources changed or deleted by confirmed compromised entities.`)
  if (changed.length > sureChanged.length) maybe.push(`${changed.length - sureChanged.length} resources changed or deleted by suspected or derived entities.`)
  const proven = impact.rotation.filter(r => r.proof && !r.stale)
  if (proven.length) known.push(`Rotation proven for ${proven.length} item${proven.length === 1 ? '' : 's'}.`)
  if (suspected.length) maybe.push(`Suspected compromised: ${list(suspected)}.`)
  if (derived.length) maybe.push(`Derived from the evidence, not yet confirmed: ${list(derived)}.`)
  const newPivots = impact.pivots.filter(p => !p.before && INFRASTRUCTURE.test(p.entity.kind))
  if (newPivots.length) maybe.push(`${newPivots.length} IP${newPivots.length === 1 ? '' : 's'} appeared with compromised entities and never before.`)
  const regular = impact.impacted.filter(i => i.regular).length
  if (regular) maybe.push(`${regular} impacted resources look like regular activity (it happened exactly so before the compromise).`)
  // Questions the board cannot answer yet, each with the query that can.
  for (const entry of traceBack(impact)) if (!entry.exposedBy.length && /credential|secret|token|key|service principal|user|account/i.test(entry.entity.kind))
    gaps.push({ question: `How was ${name(entry.entity.id)} obtained?`, why: `First used by the attacker ${short(entry.at)} UTC; nothing on the board shows it being read or stolen before.`, query: 'credential-use', entities: [entry.entity.id] })
  const vaults = secrets.filter(i => /vault/i.test(i.entity.kind) || i.operations.some(o => /secret ?get|vaults/i.test(o.operation)))
  if (vaults.length) gaps.push({ question: `Which secrets were read from ${list(vaults.map(v => v.entity.id), 2)}, and where were they used?`, why: 'The board shows access to the vault, not which secret values left it or what they unlock.', query: 'sp-keyvault', entities: vaults.map(v => v.entity.id) })
  const exposedKinds: [RegExp, string, string][] = [[/listcluster\w*credential/, 'aks-admin', 'the kubeconfigs'], [/storage.*listkeys|listkeys.*storage/, 'storage-keys', 'the storage keys'], [/listcredentials.*regist|regist.*listcredentials/, 'acr-use', 'the registry passwords'], [/cognitiveservices|openai/, 'ai-keys', 'the AI service keys']]
  for (const [pattern, query, label] of exposedKinds) { const hit = secrets.filter(i => i.operations.some(o => pattern.test(o.operation.toLowerCase()))); if (hit.length) gaps.push({ question: `What did ${label} enable after they were read?`, why: `${hit.length} resource${hit.length === 1 ? '' : 's'} affected; using the stolen material leaves traces in the resource's own logs.`, query, entities: hit.map(i => i.entity.id) }) }
  if (impact.variables.length) gaps.push({ question: `Which CI/CD variables of the ${impact.variables.length} projects held secrets, and where are those secrets used?`, why: 'GitLab logs that variables were read, not which: list the keys, then rotate and hunt for each secret.', entities: impact.variables.map(v => v.entity.id) })
  const unproven = impact.rotation.filter(r => (r.key === 'revoke-secret' || r.key === 'rotate-identity') && !r.proof)
  if (unproven.length) gaps.push({ question: `Were the stolen credentials removed (${unproven.length})?`, why: 'No key removal or rotation is on the board yet.', query: 'rotation-proof', entities: unproven.map(r => r.entityId) })
  const blind = impact.seeds.filter(s => !(impact.history.get(s.entity.id) ?? 0) && s.from !== -Infinity)
  if (blind.length) gaps.push({ question: `What is normal for ${list(blind.map(s => s.entity.id), 2)}?`, why: 'No events from before the compromise: without a baseline, regular use and the attacker look the same.', query: 'credential-use', entities: blind.map(s => s.entity.id) })
  if (impact.first) gaps.push({ question: `What happened before ${short(impact.first)} UTC?`, why: 'The first attacker activity on the board is rarely the first one.', query: 'ip-everywhere', entities: [] })
  return { known, suspected: maybe, gaps }
}
