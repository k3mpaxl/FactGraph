import type { Fact } from './types'

/** A piece of an activity sentence: plain text, or an entity (shown and highlighted by the caller). */
export type Segment = { text: string; id?: string }

/**
 * An activity as one sentence, every entity once: who did it, what, to what, on which device, from where, as whom,
 * with which credential. "outlook.exe process created powershell.exe on ws-0142 as j.doe" instead of a list of roles.
 */
export function activitySentence(fact: Fact, name: (id: string) => string, kind: (id: string) => string): Segment[] {
  const parts = fact.participants ?? []
  if (!parts.length) return [{ text: name(fact.subject_id), id: fact.subject_id }, { text: ` ${fact.predicate} ` }, { text: name(fact.object_id), id: fact.object_id }]
  const used = new Set<string>()
  const is = (pattern: RegExp) => (p: { entity_id: string }) => pattern.test(kind(p.entity_id))
  const take = (list: { entity_id: string }[]) => list.filter(p => !used.has(p.entity_id) && used.add(p.entity_id)).map(p => p.entity_id)
  const process = is(/process|file|script/i), device = is(/device|host|server|computer|machine|\bvm\b/i), ip = is(/\bip\b/i)
  const credential = is(/credential|secret|certificate|token|key/i), place = is(/^location$/i)
  const doer = parts.find(p => p.role === 'via' && process(p)) ?? parts.find(p => p.role === 'actor') ?? parts.find(p => p.role === 'identity') ?? parts.find(p => p.role !== 'target') ?? parts[0]
  const [subject] = take([doer])
  const targets = take(parts.filter(p => p.role === 'target' && !device(p)))
  const devices = take(parts.filter(device))
  const sources = take(parts.filter(p => p.role === 'source' && ip(p)))
  const people = take(parts.filter(p => (p.role === 'actor' || p.role === 'identity') && !credential(p)))
  const credentials = take(parts.filter(credential))
  const rest = take(parts.filter(p => !place(p)))
  const list = (ids: string[]) => ids.flatMap((id, i) => [...(i ? [{ text: ', ' }] : []), { text: name(id), id }])
  const signIn = /sign(ed)?[ -]?in/i.test(fact.predicate) && !/ to\b/i.test(fact.predicate)
  const out: Segment[] = [{ text: name(subject), id: subject }, { text: ` ${fact.predicate}${signIn && targets.length ? ' to' : ''} ` }, ...list(targets)]
  if (devices.length) out.push({ text: ' on ' }, ...list(devices))
  if (sources.length) out.push({ text: ' from ' }, ...list(sources))
  if (people.length) out.push({ text: ' as ' }, ...list(people))
  if (credentials.length) out.push({ text: ' with ' }, ...list(credentials))
  if (rest.length) out.push({ text: ' · ' }, ...list(rest))
  return out
}

export const sentenceText = (segments: Segment[]) => segments.map(s => s.text).join('').replace(/\s+/g, ' ').trim()
