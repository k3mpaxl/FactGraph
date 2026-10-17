import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { KindIcon } from './GraphView'
import { entityVisual } from './entityVisual'
import type { Entity, Fact, GraphData, TruthState } from './types'

export const labels: Record<TruthState, string> = {
  supported: 'Supported',
  disputed: 'Disputed',
  refuted: 'Refuted',
  unknown: 'Unknown',
}
export const allStates: TruthState[] = ['supported', 'disputed', 'refuted', 'unknown']
export const kinds = [
  'Threat Actor',
  'User',
  'Person',
  'Organization',
  'Device',
  'Service',
  'Service Principal',
  'Managed Identity',
  'AKS Cluster',
  'AKS Workload',
  'Kubernetes Pod',
  'System',
  'IP',
  'File',
  'Repository',
  'Process',
  'Environment Variable',
  'Credential',
  'Secret',
  'Key Vault',
  'Azure Resource',
  'Blob Storage',
  'S3 Bucket',
  'Location',
  'Event',
  'Document',
  'Other',
]
export const customKindValue = '__custom__'
export const schemes = ['hostname', 'fqdn', 'ip', 'email', 'url', 'resource_id', 'external_id', 'other']
export const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)
export const mod = isMac ? '⌘' : 'Ctrl'

/** When an activity or relationship was observed: from the times of its evidence ("09-17 08:01 – 09-17 09:01"). */
export function factSpan(fact: Fact) {
  let first = '',
    last = ''
  for (const a of fact.assertions)
    if (!a.retracted_at && a.valid_from) {
      if (!first || a.valid_from < first) first = a.valid_from
      if (!last || a.valid_from > last) last = a.valid_from
    }
  const short = (t: string) => t.slice(5, 16).replace('T', ' ')
  return !first ? '' : short(first) === short(last) ? short(first) : `${short(first)} – ${short(last)}`
}

export function date(value: string | null | undefined) {
  if (!value) return 'No date'
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
}
export function nameOf(data: GraphData, id: string) {
  return data.entities.find(item => item.id === id)?.name ?? 'Unknown'
}
export function sourceOf(data: GraphData, id: string | null) {
  return data.sources.find(item => item.id === id)
}
export function readPref(key: string) {
  try {
    return localStorage.getItem(`factgraph:${key}`)
  } catch {
    return null
  }
}
export function writePref(key: string, value: string) {
  try {
    localStorage.setItem(`factgraph:${key}`, value)
  } catch {
    /* private mode */
  }
}

export function EntityAvatar({
  entity,
  data,
  size = 'md',
}: {
  entity: Pick<Entity, 'kind' | 'color'>
  data?: GraphData
  size?: 'sm' | 'md' | 'lg'
}) {
  const type = data?.entity_types?.find(t => t.name === entity.kind)
  const color = entity.color || type?.color || entityVisual(entity.kind).border
  return (
    <span className={`entity-avatar ${size}`} style={{ '--entity-color': color } as CSSProperties}>
      <KindIcon kind={entity.kind} icon={type?.icon} size={size === 'lg' ? 18 : size === 'sm' ? 12 : 14} />
    </span>
  )
}
export function StatePill({ state }: { state: TruthState }) {
  return (
    <span className={`state-pill ${state}`}>
      <span className="state-dot" />
      {labels[state]}
    </span>
  )
}
export function Kbd({ children }: { children: ReactNode }) {
  return <kbd>{children}</kbd>
}

export function Section({
  title,
  count,
  action,
  children,
  defaultOpen = true,
}: {
  title: string
  count?: number
  action?: ReactNode
  children: ReactNode
  defaultOpen?: boolean
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <section className="inspector-section">
      <div className="section-heading">
        <button className="section-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          <h3>{title}</h3>
          {count !== undefined && <span className="count">{count}</span>}
        </button>
        {action}
      </div>
      {open && <div className="section-body">{children}</div>}
    </section>
  )
}

export const initials = (name: string) =>
  name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map(part => [...part][0] ?? '')
    .join('')
    .toUpperCase() || '?'
export const personHue = (id: string) => {
  let hash = 0
  for (const c of id) hash = (hash * 31 + c.charCodeAt(0)) | 0
  return Math.abs(hash) % 360
}
export function PersonAvatar({ id, name, self }: { id: string; name: string; self?: boolean }) {
  return (
    <span className={`person-avatar${self ? ' self' : ''}`} style={{ '--hue': personHue(id) } as CSSProperties} aria-hidden="true">
      {initials(name)}
    </span>
  )
}

export function Menu({
  label,
  trigger,
  children,
  className = '',
  align = 'left',
}: {
  label: string
  trigger: ReactNode
  children: ReactNode
  className?: string
  align?: 'left' | 'right'
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false)
    }
    const esc = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false)
        event.stopImmediatePropagation()
      }
    }
    document.addEventListener('mousedown', close)
    window.addEventListener('keydown', esc, true)
    return () => {
      document.removeEventListener('mousedown', close)
      window.removeEventListener('keydown', esc, true)
    }
  }, [open])
  return (
    <div className={`menu ${className}`} ref={ref}>
      <button
        className={`menu-trigger ${open ? 'open' : ''}`}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {trigger}
      </button>
      {open && (
        <div
          className={`menu-content popover ${align}`}
          role="menu"
          onClick={event => {
            if ((event.target as HTMLElement).closest('button, a')) setOpen(false)
          }}
        >
          {children}
        </div>
      )}
    </div>
  )
}
