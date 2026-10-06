import type { Fact, GraphData } from './types'
import { activitySentence } from './describe'

/** An activity as a sentence: entity names in bold, the operation highlighted, marked entities (compromised …) in red. */
export function Sentence({ fact, data, marked }: { fact: Fact; data: Pick<GraphData, 'entities'>; marked?: (id: string) => boolean }) {
  const byId = new Map(data.entities.map(e => [e.id, e]))
  const segments = activitySentence(fact, id => byId.get(id)?.name ?? id, id => byId.get(id)?.kind ?? '')
  return <span className="sentence">{segments.map((segment, i) => segment.id
    ? <b key={i} className={marked?.(segment.id) ? 'sentence-marked' : undefined}>{segment.text}</b>
    : i === 1 ? <span key={i} className="sentence-op">{segment.text}</span> : <span key={i}>{segment.text}</span>)}</span>
}
