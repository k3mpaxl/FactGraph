import { useEffect, useRef, useState } from 'react'
import { Bell, Bot, CheckCircle2, CircleAlert, Clock, Crosshair, Download, Loader2, Radar, ShieldCheck, Trash2, Upload, Users, Wifi, X } from 'lucide-react'
import { isActive, type Notice } from './notifications'

type Props = {
  notices: Notice[]
  onDismiss: (id: string) => void; onClearFinished: () => void; onMarkRead: () => void
  onOpen: (notice: Notice) => void
}

const KIND_ICON: Record<Notice['kind'], typeof Bell> = { agent: Bot, gtienricher: Radar, colleague: Users, import: Upload, export: Download, connection: Wifi, error: CircleAlert }

function ago(at: string) {
  const seconds = Math.max(0, (Date.now() - Date.parse(at)) / 1000)
  if (seconds < 45) return 'just now'
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`
  if (seconds < 86400) return `${Math.round(seconds / 3600)} h ago`
  return new Date(at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
}

const action = (n: Notice) => !n.target ? '' : n.target.kind === 'review' ? 'Review' : n.target.kind === 'activity' ? 'Change log' : 'Show'

/**
 * Bell with badge and a panel: what agents, GTIEnricher and colleagues changed, own imports and exports with progress,
 * and connection or storage problems. The badge counts unread entries except quiet colleague changes; red on errors.
 */
export default function NotificationCenter({ notices, onDismiss, onClearFinished, onMarkRead, onOpen }: Props) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const running = notices.filter(isActive)
  const unread = notices.filter(n => !n.read && !n.quiet && !isActive(n))
  const alarm = unread.some(n => n.status === 'error')
  useEffect(() => {
    if (!open) return
    const close = (event: MouseEvent) => { if (!ref.current?.contains(event.target as Node)) setOpen(false) }
    const esc = (event: KeyboardEvent) => { if (event.key === 'Escape') { setOpen(false); event.stopImmediatePropagation() } }
    document.addEventListener('mousedown', close); window.addEventListener('keydown', esc, true)
    return () => { document.removeEventListener('mousedown', close); window.removeEventListener('keydown', esc, true) }
  }, [open])
  // While the panel is open, whatever arrives is seen.
  useEffect(() => { if (open && notices.some(n => !n.read && !isActive(n))) onMarkRead() }, [open, notices, onMarkRead])
  const badge = running.length || unread.length
  const row = (n: Notice) => {
    const Icon = KIND_ICON[n.kind]
    return <li key={n.id} className={`notice ${n.status}${n.quiet ? ' quiet' : ''}`}>
      <span className="notice-icon">{n.status === 'running' ? <Loader2 size={14} className="spin" /> : n.status === 'queued' ? <Clock size={14} />
        : n.status === 'error' ? <CircleAlert size={14} /> : n.status === 'done' ? <CheckCircle2 size={14} /> : <Icon size={14} />}</span>
      <div className="notice-text">
        <strong title={n.title}>{n.title}</strong>
        {(isActive(n) ? n.progress ?? (n.status === 'queued' ? 'Queued: waiting for the previous import' : 'Running…') : n.detail) && <span>{isActive(n) ? n.progress ?? (n.status === 'queued' ? 'Queued: waiting for the previous import' : 'Running…') : n.detail}</span>}
        <small>{ago(n.finished ?? n.at)}{n.kind === 'colleague' ? ' · colleague' : ''}</small>
      </div>
      <div className="notice-actions">
        {n.target && !isActive(n) && <button className="secondary-button small" onClick={() => { setOpen(false); onOpen(n) }}>
          {n.target.kind === 'review' ? <ShieldCheck size={12} /> : <Crosshair size={12} />}{action(n)}</button>}
        {!isActive(n) && <button className="icon-button" aria-label="Dismiss" onClick={() => onDismiss(n.id)}><X size={13} /></button>}
      </div>
    </li>
  }
  return <div className="menu notifications" ref={ref}>
    <button className={`menu-trigger icon-button notifications-trigger${open ? ' open' : ''}`} aria-label="Notifications" aria-expanded={open} title="Notifications" onClick={() => setOpen(!open)}>
      {running.length ? <Loader2 size={15} className="spin" /> : <Bell size={15} />}
      {badge > 0 && <b className={`notifications-badge${alarm ? ' alarm' : ''}`}>{badge > 99 ? '99+' : badge}</b>}
    </button>
    {open && <div className="menu-content popover right notifications-panel" role="dialog" aria-label="Notifications">
      <div className="notifications-head"><span className="menu-label">Notifications</span>
        {notices.some(n => !isActive(n)) && <button className="secondary-button small" onClick={onClearFinished}><Trash2 size={12} /> Clear</button>}</div>
      {!notices.length && <p className="menu-note">Nothing yet. Changes by agents, GTIEnricher and colleagues, your imports and exports, and connection problems show up here.</p>}
      {running.length > 0 && <ul className="notice-list">{running.map(row)}</ul>}
      {notices.some(n => !isActive(n)) && <ul className="notice-list">{notices.filter(n => !isActive(n)).map(row)}</ul>}
    </div>}
  </div>
}
