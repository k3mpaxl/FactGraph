import { useMemo, useRef, useState } from 'react'
import { Copy, Search } from 'lucide-react'
import type { Entity, GraphData } from './types'

/** Kinds that tell two same-named entities apart: the repository a file is in, the host, the subscription. */
const CONTEXT = /repository|project|device|host|server|workstation|machine|subscription|resource group|cluster|vault|storage|tenant|account/i

const belongsCache = new WeakMap<object, Map<string, string[]>>()
/** What each entity belongs to (repository, host, subscription …), in one pass over the activities, cached per board state. */
function belongsTo(data: Pick<GraphData, 'entities' | 'facts'>, byId: Map<string, Entity>) {
  const cached = belongsCache.get(data.facts)
  if (cached) return cached
  const map = new Map<string, string[]>()
  for (const fact of data.facts) {
    const ids = fact.participants?.length ? fact.participants.map(p => p.entity_id) : [fact.subject_id, fact.object_id]
    for (const id of ids) {
      const list = map.get(id) ?? []
      if (list.length >= 2) continue
      const entity = byId.get(id)
      for (const otherId of ids) {
        const other = otherId === id ? null : byId.get(otherId)
        const label = other ? `${other.kind} ${other.name}` : ''
        if (other && entity && CONTEXT.test(other.kind) && other.kind !== entity.kind && !list.includes(label)) { list.push(label); break }
      }
      map.set(id, list)
    }
  }
  belongsCache.set(data.facts, map)
  return map
}

/** One line that tells same-named entities apart: what they belong to and their identifiers. */
export function entityContext(entity: Entity, data: Pick<GraphData, 'entities' | 'facts'>, byId?: Map<string, Entity>): string {
  const parts = [...(belongsTo(data, byId ?? new Map(data.entities.map(e => [e.id, e]))).get(entity.id) ?? [])]
  for (const identifier of entity.identifiers.slice(0, 2)) {
    const value = identifier.raw_value
    parts.push(value.length > 64 ? `${value.slice(0, 28)}…${value.slice(-30)}` : value)
  }
  return parts.join(' · ')
}

/**
 * A searchable entity choice for boards with thousands of entities: name, type, what it belongs to, identifiers and its
 * ID, searched across all of them. `name` adds a hidden input for forms read with FormData.
 */
export function EntityPicker({ data, value, onChange, name, required, placeholder = 'Search name, type, identifier or ID…', exclude, preferKind, label, autoFocus }: {
  data: Pick<GraphData, 'entities' | 'facts'>; value: string; onChange: (id: string) => void; name?: string; required?: boolean; placeholder?: string
  exclude?: string[]; preferKind?: string; label: string; autoFocus?: boolean
}) {
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const [copied, setCopied] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const byId = useMemo(() => new Map(data.entities.map(e => [e.id, e])), [data.entities])
  const sameName = useMemo(() => { const counts = new Map<string, number>(); for (const e of data.entities) counts.set(`${e.name}\u0000${e.kind}`, (counts.get(`${e.name}\u0000${e.kind}`) ?? 0) + 1); return counts }, [data.entities])
  const selected = value ? byId.get(value) : undefined
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase()
    const skip = new Set(exclude ?? [])
    const scored: { entity: Entity; score: number }[] = []
    for (const entity of data.entities) {
      if (skip.has(entity.id)) continue
      const name = entity.name.toLowerCase()
      let score = !q ? 1 : name === q ? 0 : name.startsWith(q) ? 1 : name.includes(q) ? 2
        : entity.kind.toLowerCase().includes(q) ? 3 : entity.id.startsWith(q) || entity.identifiers.some(i => i.raw_value.toLowerCase().includes(q) || i.normalized_value.toLowerCase().includes(q)) ? 3 : -1
      if (score < 0) continue
      if (preferKind && entity.kind !== preferKind) score += 10
      scored.push({ entity, score })
    }
    return scored.sort((a, b) => a.score - b.score || a.entity.name.localeCompare(b.entity.name)).slice(0, 60).map(x => x.entity)
  }, [query, data.entities, exclude, preferKind])
  const pick = (entity: Entity) => { onChange(entity.id); setQuery(''); setOpen(false) }
  const copyId = (id: string) => { void navigator.clipboard?.writeText(id).then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 1200) }).catch(() => {}) }
  return <div className="entity-picker" onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setOpen(false) }}>
    {name && <input type="hidden" name={name} value={value} />}
    {selected && !open ? <div className="picker-chosen">
      <button type="button" className="picker-current" aria-label={`${label}: ${selected.name}, change`} onClick={() => { setOpen(true); window.setTimeout(() => input.current?.focus(), 0) }}>
        <strong>{selected.name}</strong><span className="kind-label">{selected.kind}</span><small>{entityContext(selected, data, byId) || 'no identifiers'}</small></button>
      <button type="button" className="icon-button" title={copied ? 'Copied' : `Copy ID ${selected.id}`} aria-label="Copy entity ID" onClick={() => copyId(selected.id)}><Copy size={13} /></button>
    </div> : <label className="input-with-icon picker-search"><Search size={14} />
      <input ref={input} autoFocus={autoFocus} role="combobox" aria-expanded={open} aria-label={label} aria-autocomplete="list" value={query} placeholder={placeholder}
        // An empty hidden value does not block submit; this keeps the browser's "required" message on the visible field.
        required={required && !value} onFocus={() => setOpen(true)} onChange={e => { setQuery(e.target.value); setOpen(true); setActive(0) }}
        onKeyDown={e => {
          if (e.key === 'ArrowDown') { e.preventDefault(); setActive(Math.min(active + 1, matches.length - 1)) }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(Math.max(active - 1, 0)) }
          else if (e.key === 'Enter' && open && matches[active]) { e.preventDefault(); pick(matches[active]) }
          else if (e.key === 'Escape' && open) { e.stopPropagation(); setOpen(false) }
        }} /></label>}
    {open && <div className="picker-list" role="listbox" aria-label={`${label} options`}>
      {matches.map((entity, i) => { const twins = sameName.get(`${entity.name}\u0000${entity.kind}`) ?? 1
        return <button type="button" role="option" aria-selected={entity.id === value} key={entity.id} className={`${i === active ? 'active' : ''}${entity.id === value ? ' chosen' : ''}`}
          onMouseEnter={() => setActive(i)} onMouseDown={e => e.preventDefault()} onClick={() => pick(entity)}>
          <span className="picker-name"><strong>{entity.name}</strong><span className="kind-label">{entity.kind}</span>{preferKind && entity.kind !== preferKind && <span className="picker-flag">other type</span>}{twins > 1 && <span className="picker-flag" title="Other entities have the same name and type: check the context">{twins}× this name</span>}</span>
          <small>{entityContext(entity, data, byId) || 'no identifiers'} · <span className="mono">{entity.id.slice(0, 8)}</span></small></button> })}
      {!matches.length && <p className="muted small picker-empty">No entity matches “{query}”.</p>}
      {matches.length === 60 && <p className="muted small picker-empty">First 60 matches: type more to narrow down.</p>}
    </div>}
  </div>
}
