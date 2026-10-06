import type { Assertion, TruthState } from './types'

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/**
 * Why a relationship has its status, in the same terms as truth() in board.ts: only confirmed, unretracted evidence
 * decides; supporting and refuting confirmed evidence together make it disputed. Confidence does not change the status.
 */
export function explainTruth(state: TruthState, assertions: Assertion[]) {
  const active = assertions.filter(a => !a.retracted_at)
  const confirmed = active.filter(a => a.review_status === 'confirmed')
  const supports = confirmed.filter(a => a.stance === 'supports').length
  const refutes = confirmed.filter(a => a.stance === 'refutes').length
  const unconfirmed = active.length - confirmed.length
  const retracted = assertions.length - active.length
  const sentence = state === 'supported' ? `${plural(supports, 'confirmed evidence item')} ${supports === 1 ? 'supports' : 'support'} it and none refutes it.`
    : state === 'refuted' ? `${plural(refutes, 'confirmed evidence item')} ${refutes === 1 ? 'refutes' : 'refute'} it and none supports it.`
    : state === 'disputed' ? `Confirmed evidence points both ways: ${supports} supporting, ${refutes} refuting. Weigh the sources, or retract what turned out wrong.`
    : !assertions.length ? 'There is no evidence yet.'
    : !active.length ? 'All evidence was retracted.'
    : `None of the evidence is confirmed yet. Confirm it in Review once you have checked the source.`
  const notCounted = [unconfirmed && state !== 'unknown' ? plural(unconfirmed, 'unconfirmed item') : '', retracted ? plural(retracted, 'retracted item') : ''].filter(Boolean)
  return { sentence, notCounted: notCounted.length ? `Not counted: ${notCounted.join(', ')}.` : '' }
}

export const GLOSSARY: { term: string; text: string }[] = [
  { term: 'Entity', text: 'Something the investigation is about: a user, device, IP, service principal, file, threat actor … Identifiers (hostname, IP, resource ID) let imports and agents find the same entity again.' },
  { term: 'Relationship', text: 'A statement between two entities, e.g. “IP accessed Key Vault”. It is only as good as its evidence: on its own it says nothing.' },
  { term: 'Activity', text: 'An event with several participants in roles (actor, source, identity, target …), e.g. one sign-in. Evidence attaches to the whole event.' },
  { term: 'Evidence', text: 'What a source shows about a relationship: an observation, a locator (log row, event ID) and its time. Each piece either supports or refutes the relationship.' },
  { term: 'Source', text: 'Where evidence comes from: a log export, a report, a ticket, GTIEnricher. Primary sources (the original log, the system itself) can confirm evidence; secondary ones (reports, enrichment) cannot on their own.' },
  { term: 'Review status', text: 'Evidence the analyst’s own file import parsed from an original log row counts as confirmed (“parsed by the import”): the row is the record, but nobody has read it. Evidence written by hand, sent by an agent (REST/MCP, also its imports) or edited later is unconfirmed until an analyst checks it against the source in Review and confirms it with a note (“reviewed”). An agent confirming evidence is shown as “confirmed by an agent”, not as reviewed.' },
  { term: 'Three different colours', text: 'Line colour (green, amber, red, grey dashed) is the evidence status of a relationship. A red marker, red name or red edge means compromise: marked compromised or used by what is. “Likely regular” (grey) rates an activity in the compromise window that also happened exactly so before it. One does not imply the other: a green (well-evidenced) edge can be the attacker’s, and a red one can lack confirmed evidence.' },
  { term: 'Compromise window', text: 'From the time an entity is marked compromised (“since”) to “until”. Only evidence inside it counts as the attacker’s; the same activity before it is regular. An IP is suggested from its first successful use of a credential.' },
  { term: 'Supported', text: 'Confirmed evidence supports the relationship and none refutes it.' },
  { term: 'Disputed', text: 'Confirmed evidence supports and refutes it. Something is wrong: a source, a mapping or the assumption itself.' },
  { term: 'Refuted', text: 'Confirmed evidence refutes it and none supports it. The relationship stays on the board so the conclusion remains traceable.' },
  { term: 'Unknown', text: 'No confirmed evidence yet: the relationship is a hypothesis or waits for review.' },
  { term: 'Confidence', text: 'How sure the analyst is about one piece of evidence (0–1). It is shown and exported, but does not change the status: a weak confirmed item still counts.' },
  { term: 'Retracted', text: 'Evidence withdrawn by an analyst. It stays visible in the history but no longer counts. Restoring brings it back as unconfirmed.' },
  { term: 'Evidence window', text: 'Shows only evidence observed in a time range; the status is recomputed from that evidence alone. Undated evidence can be included or hidden.' },
  { term: 'Layer', text: 'A domain such as identity, network, endpoint, cloud or data. Lenses and perspectives show only some layers; nothing is deleted.' },
  { term: 'Perspective', text: 'A saved, shared view: visible layers and display options under a name and a link.' },
  { term: 'Group', text: 'Entities shown together, collapsible to one card. Rules can keep a group filled, e.g. everything inside a container.' },
]
