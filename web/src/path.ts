import type { Fact } from './types'

export function directedPath(facts: Fact[], start: string, end: string): Fact[] {
  if (!start || !end || start === end) return []
  const outgoing = new Map<string, Fact[]>()
  for (const fact of facts) {
    const list = outgoing.get(fact.subject_id) ?? []
    list.push(fact)
    outgoing.set(fact.subject_id, list)
  }
  const queue = [start]
  const visited = new Set([start])
  const previous = new Map<string, Fact>()
  for (let index = 0; index < queue.length; index++) {
    for (const fact of outgoing.get(queue[index]) ?? []) {
      if (visited.has(fact.object_id)) continue
      visited.add(fact.object_id)
      previous.set(fact.object_id, fact)
      if (fact.object_id === end) {
        const path: Fact[] = []
        let cursor = end
        while (cursor !== start) {
          const step = previous.get(cursor)
          if (!step) return []
          path.push(step)
          cursor = step.subject_id
        }
        return path.reverse()
      }
      queue.push(fact.object_id)
    }
  }
  return []
}
