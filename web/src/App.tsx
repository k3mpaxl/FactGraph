import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  Activity,
  ArrowDownToLine,
  ChevronDown,
  Clock,
  Command,
  Copy,
  FileText,
  GitBranch,
  Keyboard,
  Link2,
  HardDrive,
  Info,
  AlertTriangle,
  CircleHelp,
  ListTree,
  Moon,
  Pencil,
  Plus,
  Plug,
  Search,
  ShieldCheck,
  Sparkles,
  Sun,
  Trash2,
  Undo2,
  Redo2,
  Upload,
  X,
  Crosshair,
  CheckCircle2,
  Boxes,
  Zap,
  Layers,
  ImageDown,
  RotateCcw,
  ShieldAlert,
} from 'lucide-react'
import { ownImportBatches } from './importBatches'
import { deleteBoard } from './store'
import { factsInWindow, timelineEvents, periodLabel } from './timeline'
import GraphView, { type CanvasRequest, type Lens, type Selection } from './GraphView'
import { ActivityDialog, GroupInspector } from './Structures'
import ImportDialog from './ImportDialog'
import { CONNECTION_ERROR, describeTableImport, importFields, inspectImport, uploadImport } from './importApi'
import { loadFormats, markUsed, matchFormat, type Inspection } from './importFormats'
import { LAYERS } from './layers'
import { defaultView, loadView, saveView } from './savedView'
import NotificationCenter from './NotificationCenter'
import { count, createLimiter, describe, loadNotices, noticesFor, saveNotices, type Notice } from './notifications'
import EvidenceReader, { EvidenceQueue } from './EvidenceReader'
import { ImpactPanel } from './ImpactPanel'
import { analyzeImpact } from './impact'
import { huntingQueries } from './hunting'
import { boardGaps } from './gaps'
import { demoDrafts, factKey, legacyDrafts, normalizeIdentifier, type BoardAction } from './board'
import { useBoard, type ChangeListener } from './useBoard'
import { uuid } from './uuid'
import type { TruthState } from './types'
import { labels, allStates, kinds, mod, readPref, writePref, EntityAvatar, Kbd, PersonAvatar, Menu } from './ui'
import { Inspector } from './Inspector'
import { DialogKind, Dialog, HelpDialog, AgentConnectDialog, WelcomeDialog } from './Dialogs'
import { TimelinePanel, EvidenceWindow, ActivityPanel, Explorer, PaletteItem, CommandPalette } from './Panels'

type WorkspaceTab = 'graph' | 'timeline' | 'activity' | 'review' | 'impact'
type Theme = 'light' | 'dark'

function currentBoardId() {
  const fromUrl = window.location.pathname.match(/^\/boards\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?$/i)?.[1]
  const stored = readPref('lastBoard') ?? ''
  const id = fromUrl?.toLowerCase() ?? (/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(stored) ? stored : uuid())
  window.history.replaceState(null, '', `/boards/${id}${window.location.search}`)
  writePref('lastBoard', id)
  return id
}

/** Who is on this board right now (browsers connected to the relay) and who changed it recently (including agents). */
/** "Syncing… 1,240 changes" while changes come in or go out, "Synced" for a moment after, "Loading" before the board is read. */
function SyncStatus({
  sync,
  connected,
  ready,
}: {
  sync: { incoming: number; outgoing: number; doneAt: number | null; peak: number }
  connected: boolean
  ready: boolean
}) {
  const [, tick] = useState(0)
  useEffect(() => {
    if (!sync.doneAt) return
    const timer = window.setTimeout(() => tick(n => n + 1), 2600)
    return () => window.clearTimeout(timer)
  }, [sync.doneAt])
  const pending = sync.incoming + sync.outgoing
  if (!ready)
    return (
      <span className="sync-status busy" role="status">
        <RotateCcw size={12} className="spin" /> Loading board…
      </span>
    )
  // Single edits are not worth a message; imports, reconnects and colleagues' batches are.
  if (pending >= 20)
    return (
      <span
        className="sync-status busy"
        role="status"
        title={`${sync.incoming.toLocaleString('en')} received, being stored · ${sync.outgoing.toLocaleString('en')} being sent`}
      >
        <RotateCcw size={12} className="spin" /> Syncing {pending.toLocaleString('en')} change{pending === 1 ? '' : 's'}…
      </span>
    )
  if (connected && sync.doneAt && sync.peak >= 20 && Date.now() - sync.doneAt < 2500)
    return (
      <span className="sync-status done" role="status">
        <CheckCircle2 size={12} /> Synced
      </span>
    )
  return null
}

function PresenceMenu({
  connected,
  self,
  peers,
  actions,
  onRename,
}: {
  connected: boolean
  self: { id: string; name: string }
  peers: { id: string; name: string }[]
  actions: { author: string; at: string }[]
  onRename: () => void
}) {
  const sorted = [...peers].sort((a, b) => a.name.localeCompare(b.name))
  const online = new Set([self.name, ...peers.map(p => p.name)])
  const recent = new Map<string, string>()
  const since = Date.now() - 30 * 60_000
  for (let i = actions.length - 1; i >= 0 && recent.size < 8; i--) {
    const action = actions[i]
    if (Date.parse(action.at) < since) break
    if (action.author && !online.has(action.author) && !recent.has(action.author)) recent.set(action.author, action.at)
  }
  const ago = (at: string) => {
    const minutes = Math.max(0, Math.round((Date.now() - Date.parse(at)) / 60_000))
    return minutes < 1 ? 'just now' : `${minutes} min ago`
  }
  const shown = sorted.slice(0, 3)
  const trigger = (
    <>
      <span className="connection-dot" />
      {connected && (
        <span className="avatar-stack">
          {shown.map(p => (
            <PersonAvatar key={p.id} id={p.id} name={p.name} />
          ))}
          {sorted.length > shown.length && <span className="person-avatar more">+{sorted.length - shown.length}</span>}
        </span>
      )}
      <span className="presence-text">{connected ? `${peers.length + 1} online` : 'Offline'}</span>
    </>
  )
  return (
    <Menu
      label={connected ? `${peers.length + 1} online` : 'Offline'}
      className={`presence-menu presence ${connected ? 'online' : 'offline'}`}
      trigger={trigger}
    >
      <div className="menu-label">{connected ? 'On this board now' : 'Relay offline'}</div>
      {!connected && <p className="menu-note">Changes stay in this browser and sync when the connection returns.</p>}
      <div className="menu-scroll presence-list">
        <button onClick={onRename} title="Change your display name">
          <PersonAvatar id={self.id} name={self.name} self />
          <span className="menu-board-name">{self.name}</span>
          <small>you</small>
        </button>
        {connected &&
          sorted.map(p => (
            <div key={p.id} className="presence-row">
              <PersonAvatar id={p.id} name={p.name} />
              <span className="menu-board-name">{p.name}</span>
            </div>
          ))}
        {connected && !sorted.length && <p className="menu-note">Nobody else is connected. Share the board link to work together.</p>}
      </div>
      {recent.size > 0 && (
        <>
          <div className="menu-sep" />
          <div className="menu-label">Recent changes by</div>
          {[...recent].map(([name, at]) => (
            <div key={name} className="presence-row muted">
              <PersonAvatar id={name} name={name} />
              <span className="menu-board-name">{name}</span>
              <small>{ago(at)}</small>
            </div>
          ))}
        </>
      )}
    </Menu>
  )
}

export default function App() {
  const [boardId] = useState(currentBoardId)
  const changes: ChangeListener = useRef(null)
  const board = useBoard(boardId, changes)
  const data = board.ready ? board.data : null
  // The hint that this board is open in other tabs too: once dismissed, not again in this tab.
  const [tabsHintSeen, setTabsHintSeen] = useState(() => {
    try {
      return sessionStorage.getItem(`factgraph:tabsHint:${boardId}`) === '1'
    } catch {
      return false
    }
  })
  const dismissTabsHint = () => {
    setTabsHintSeen(true)
    try {
      sessionStorage.setItem(`factgraph:tabsHint:${boardId}`, '1')
    } catch {
      /* private mode */
    }
  }
  // Filters, layers, time window, selection and zoom are this analyst's own: per board in this browser, never synced.
  const saved = useMemo(() => loadView(boardId), [boardId])
  const [selection, setSelectionState] = useState<Selection>(saved.selection)
  const [dialog, setDialog] = useState<DialogKind>(null)
  const [readerId, setReaderId] = useState<string | null>(null)
  const [editingAssertionId, setEditingAssertionId] = useState<string | null>(null)
  const [relationTargetId, setRelationTargetId] = useState<string | null>(null)
  // Remembered per view: the entity list helps on the graph, it mostly takes room in the timeline, review and impact.
  const [explorerByView, setExplorerByView] = useState<Record<string, boolean>>(() => {
    const legacy = readPref('explorer')
    const graph = legacy === null ? window.innerWidth >= 1280 : legacy === 'true'
    const all: Record<string, boolean> = {}
    for (const tab of ['graph', 'timeline', 'review', 'activity', 'impact']) {
      const v = readPref(`explorer:${tab}`)
      all[tab] = v === null ? tab === 'graph' && graph : v === 'true'
    }
    return all
  })
  // Light is the default; dark is an explicit choice that is remembered.
  const [theme, setTheme] = useState<Theme>(() => (readPref('theme') === 'dark' ? 'dark' : 'light'))
  const [search, setSearch] = useState('')
  const [stateFilter, setStateFilter] = useState<TruthState | 'all'>(saved.stateFilter)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [toast, setToast] = useState('')
  const [showLogImport, setShowLogImport] = useState(false)
  const [showPalette, setShowPalette] = useState(false)
  const [showHelp, setShowHelp] = useState<false | 'data' | 'keys' | 'glossary'>(false)
  const [showConnect, setShowConnect] = useState(false)
  const [askName, setAskName] = useState(() => {
    try {
      return !localStorage.getItem('factgraph:displayName')
    } catch {
      return false
    }
  })
  const [showTime, setShowTime] = useState(saved.showTime)
  const [request, setRequest] = useState<CanvasRequest | null>(null)
  // Layer visibility and display options; a saved perspective can set them in one step.
  const [lens, setLensState] = useState<Lens>(() => ({
    layers: saved.lens.layers ? new Set(saved.lens.layers) : null,
    collapseActivities: saved.lens.collapseActivities,
    showLanes: saved.lens.showLanes,
  }))
  const [activePerspective, setActivePerspective] = useState<string | null>(() => new URLSearchParams(location.search).get('lens'))
  const setLens = (next: Lens, keepPerspective = false) => {
    setLensState(next)
    if (!keepPerspective) setPerspectiveParam(null)
  }
  const setPerspectiveParam = (id: string | null) => {
    setActivePerspective(id)
    const url = new URL(location.href)
    if (id) url.searchParams.set('lens', id)
    else url.searchParams.delete('lens')
    history.replaceState(null, '', url)
  }
  const searchInput = useRef<HTMLInputElement>(null)
  const canvas = (type: CanvasRequest['type'], extra: Partial<CanvasRequest> = {}) =>
    setRequest(current => ({ type, n: (current?.n ?? 0) + 1, ...extra }))
  const tabFromUrl = (): WorkspaceTab => {
    const tab = new URLSearchParams(location.search).get('view')
    return tab === 'timeline' || tab === 'review' || tab === 'activity' || tab === 'impact' ? tab : 'graph'
  }
  const [activeTab, updateActiveTab] = useState<WorkspaceTab>(tabFromUrl)
  const setActiveTab = (tab: WorkspaceTab) => {
    if (tab === activeTab) return
    const url = new URL(location.href)
    if (tab === 'graph') url.searchParams.delete('view')
    else url.searchParams.set('view', tab)
    history.pushState(null, '', url)
    updateActiveTab(tab)
  }
  const setSelection = (next: Selection, focus = false) => {
    setSelectionState(next)
    if (next && focus) {
      if (activeTab !== 'graph') setActiveTab('graph')
      window.setTimeout(() => canvas('focus', { id: next.id }), 30)
    }
  }
  useEffect(() => {
    const onBack = () => updateActiveTab(tabFromUrl())
    window.addEventListener('popstate', onBack)
    return () => window.removeEventListener('popstate', onBack)
  }, [])
  useEffect(() => {
    document.documentElement.dataset.theme = theme
    document.querySelector('meta[name=theme-color]')?.setAttribute('content', theme === 'dark' ? '#0c0e13' : '#f7f8fa')
  }, [theme])
  const perspectiveApplied = useRef(false)
  useEffect(() => {
    if (perspectiveApplied.current || !data || !activePerspective) return
    // A shared link opened in a fresh browser: the perspective arrives with the sync, so wait until it is there.
    const view = data.views?.find(v => v.id === activePerspective)
    if (!view) return
    perspectiveApplied.current = true
    setLens(
      { layers: view.layers ? new Set(view.layers) : null, collapseActivities: view.collapse_activities, showLanes: view.show_lanes },
      true,
    )
  }, [data, activePerspective])
  const applyPerspective = (id: string | null) => {
    const view = id ? data?.views?.find(v => v.id === id) : null
    if (!view) {
      setPerspectiveParam(null)
      return
    }
    setLens(
      { layers: view.layers ? new Set(view.layers) : null, collapseActivities: view.collapse_activities, showLanes: view.show_lanes },
      true,
    )
    setPerspectiveParam(view.id)
  }
  const [evidenceFrom, setEvidenceFrom] = useState(saved.from)
  const [evidenceTo, setEvidenceTo] = useState(saved.to)
  const [includeUndated, setIncludeUndated] = useState(saved.includeUndated)
  const viewport = useRef(saved.viewport)
  const persistView = useCallback(
    () =>
      saveView(boardId, {
        stateFilter,
        from: evidenceFrom,
        to: evidenceTo,
        includeUndated,
        showTime,
        selection,
        viewport: viewport.current,
        lens: { layers: lens.layers ? [...lens.layers] : null, collapseActivities: lens.collapseActivities, showLanes: lens.showLanes },
      }),
    [boardId, stateFilter, evidenceFrom, evidenceTo, includeUndated, showTime, selection, lens],
  )
  useEffect(persistView, [persistView])
  // A remembered selection that no longer exists (deleted by a colleague, undone) is dropped once the board is loaded.
  useEffect(() => {
    if (!data || !selection) return
    const exists =
      selection.kind === 'entity'
        ? data.entities.some(e => e.id === selection.id)
        : selection.kind === 'fact'
          ? data.facts.some(f => f.id === selection.id)
          : (data.groups ?? []).some(g => g.id === selection.id)
    if (!exists) setSelectionState(null)
  }, [data, selection])
  const resetView = () => {
    const base = defaultView()
    setStateFilter(base.stateFilter)
    setEvidenceFrom('')
    setEvidenceTo('')
    setIncludeUndated(true)
    setShowTime(false)
    setLens({ layers: null, collapseActivities: false, showLanes: false })
    canvas('fit')
    setToast('View reset: all filters cleared')
  }
  const importInput = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (toast) {
      const timer = window.setTimeout(() => setToast(''), 3000)
      return () => clearTimeout(timer)
    }
  }, [toast])

  // ---------------------------------------------------------------------------------------------- notifications
  const [notices, setNotices] = useState<Notice[]>(() => loadNotices(boardId))
  useEffect(() => {
    const timer = window.setTimeout(() => saveNotices(boardId, notices), 400)
    return () => window.clearTimeout(timer)
  }, [boardId, notices])
  // A reload right after an import must not lose the last notices still waiting for the debounced save.
  const latestNotices = useRef(notices)
  /** Set once the board was removed from this browser: nothing about it may be written again while the page unloads. */
  const boardRemoved = useRef(false)
  latestNotices.current = notices
  useEffect(() => {
    const flush = () => {
      if (!boardRemoved.current) saveNotices(boardId, latestNotices.current)
    }
    window.addEventListener('pagehide', flush)
    return () => window.removeEventListener('pagehide', flush)
  }, [boardId])
  const notify = useCallback((notice: Omit<Notice, 'id' | 'at'> & { id?: string }) => {
    const full: Notice = { id: notice.id ?? uuid(), at: new Date().toISOString(), ...notice }
    setNotices(list => [full, ...list.filter(n => n.id !== full.id)])
    return full.id
  }, [])
  const updateNotice = useCallback(
    (id: string, patch: Partial<Notice>) => setNotices(list => list.map(n => (n.id === id ? { ...n, ...patch } : n))),
    [],
  )
  // Remote batches arrive in chunks of 100; collect them briefly so one batch becomes one notice.
  const pendingBatches = useRef(new Map<string, BoardAction[]>())
  const batchTimer = useRef<number | undefined>(undefined)
  const syncCount = useRef<{ id: string; count: number } | null>(null)
  // Joining a board that others have open: what arrives is its history, not news. One quiet notice once it is in.
  const joined = useRef<{ actions: BoardAction[]; authors: Set<string> } | null>(null)
  useEffect(() => {
    if (board.joining) {
      joined.current = joined.current ?? { actions: [], authors: new Set() }
      return
    }
    const done = joined.current
    joined.current = null
    if (!done?.actions.length) return
    const counts = count(done.actions)
    notify({
      kind: 'colleague',
      status: 'info',
      quiet: true,
      read: true,
      counts,
      target: { kind: 'activity' },
      title: `Board received from ${[...done.authors].slice(0, 3).join(', ')}${done.authors.size > 3 ? ` +${done.authors.size - 3}` : ''}`,
      detail: describe(counts),
    })
  }, [board.joining])
  changes.current = fresh => {
    if (board.joining && !joined.current) joined.current = { actions: [], authors: new Set() }
    if (joined.current) {
      for (const item of fresh) {
        joined.current.actions.push(item)
        if (item.author) joined.current.authors.add(item.author)
      }
      return
    }
    for (const item of fresh) {
      if (item.actor === board.actor && (item.channel ?? 'UI') === 'UI') continue
      // The analyst's own file imports have their own notice.
      if (item.batch_id && ownImportBatches.has(item.batch_id)) continue
      if (syncCount.current && item.actor !== board.actor) syncCount.current.count++
      const key = item.batch_id ?? item.id
      const list = pendingBatches.current.get(key)
      if (list) list.push(item)
      else pendingBatches.current.set(key, [item])
    }
    if (!pendingBatches.current.size) return
    window.clearTimeout(batchTimer.current)
    batchTimer.current = window.setTimeout(() => {
      const batches = pendingBatches.current
      pendingBatches.current = new Map()
      setNotices(list => {
        const { updates, created } = noticesFor(batches, board.actor, list)
        const changed = new Map(updates.map(n => [n.id, n]))
        return [...created, ...updates, ...list.filter(n => !changed.has(n.id))]
      })
    }, 800)
  }
  // Connection: only lasting outages (> 5 s) are worth a notice; when back, say how long and what was synced.
  const wasConnected = useRef(false)
  const outage = useRef<{ since: string; id: string | null; timer?: number } | null>(null)
  useEffect(() => {
    if (!board.ready) return
    if (board.connected) {
      const lost = outage.current
      outage.current = null
      if (lost?.timer) window.clearTimeout(lost.timer)
      if (lost?.id) {
        const id = lost.id
        const minutes = Math.round((Date.now() - Date.parse(lost.since)) / 60000)
        updateNotice(id, {
          status: 'done',
          title: 'Connection restored',
          finished: new Date().toISOString(),
          read: false,
          detail: `Offline for ${minutes < 1 ? 'less than a minute' : `${minutes} min`}. Changes made meanwhile were kept in this browser and sent now.`,
        })
        syncCount.current = { id, count: 0 }
        window.setTimeout(() => {
          const synced = syncCount.current
          syncCount.current = null
          if (synced?.count)
            setNotices(list =>
              list.map(n =>
                n.id === synced.id ? { ...n, detail: `${n.detail} ${synced.count.toLocaleString('en')} changes from others synced.` } : n,
              ),
            )
        }, 6000)
      }
      wasConnected.current = true
    } else if (wasConnected.current && !outage.current) {
      const since = new Date().toISOString()
      outage.current = { since, id: null }
      outage.current.timer = window.setTimeout(() => {
        if (outage.current?.since !== since) return
        outage.current.id = notify({
          kind: 'connection',
          status: 'error',
          title: 'Connection to the server lost',
          detail: 'Your changes are kept in this browser and sent when the connection is back. Agents cannot reach this board meanwhile.',
        })
      }, 5000)
    }
  }, [board.ready, board.connected, notify, updateNotice])
  useEffect(() => {
    if (board.unsynced.length)
      notify({
        id: `unsynced:${boardId}`,
        kind: 'error',
        status: 'error',
        title: `${board.unsynced.length} change${board.unsynced.length === 1 ? '' : 's'} too large to share`,
        detail:
          'Larger than the 16 MiB the relay accepts per message (usually a source with a very large excerpt). It stays in this browser; colleagues and agents do not see it. Import large exports again: they are now split into source parts.',
      })
  }, [board.unsynced.length, boardId, notify])
  useEffect(() => {
    if (board.storageError)
      notify({
        id: `storage:${board.storageError}`,
        kind: 'error',
        status: 'error',
        title: 'Browser storage problem',
        detail: board.storageError,
      })
  }, [board.storageError, notify])
  const markNoticesRead = useCallback(
    () => setNotices(list => list.map(n => (n.read || n.status === 'running' || n.status === 'queued' ? n : { ...n, read: true }))),
    [],
  )
  const openNotice = (notice: Notice) => {
    const target = notice.target
    if (!target) return
    if (target.kind === 'review') setActiveTab('review')
    else if (target.kind === 'activity') setActiveTab('activity')
    else if (
      target.id &&
      data &&
      (target.kind === 'entity' ? data.entities.some(e => e.id === target.id) : data.facts.some(f => f.id === target.id))
    )
      setSelection({ kind: target.kind, id: target.id }, true)
    else setToast('That item is no longer on the board')
  }
  // Several log files: one after another, each with its own notice; the dialog closes right away.
  const importSlots = useMemo(() => createLimiter(1), [])
  const connectedRef = useRef(false)
  connectedRef.current = board.connected
  const waitForConnection = async (ms = 60_000) => {
    for (const until = Date.now() + ms; !connectedRef.current && Date.now() < until;)
      await new Promise(resolve => window.setTimeout(resolve, 300))
  }
  const runImports = (jobs: { name: string; run: () => Promise<string> }[]) => {
    const done: Promise<unknown>[] = []
    for (const job of jobs) {
      const id = notify({ kind: 'import', status: 'queued', title: `Import ${job.name}` })
      done.push(
        importSlots(async () => {
          updateNotice(id, { status: 'running', progress: connectedRef.current ? 'Importing rows…' : 'Waiting for the connection…' })
          try {
            // The import is confirmed once the browser has stored every chunk; the next file starts right away. The
            // server writes through this browser, so a file waits for the connection, and one that lost it is retried
            // once it is back (import IDs are stable: what was already stored is skipped).
            await waitForConnection()
            const summary = await job.run().catch(async problem => {
              if (!(problem instanceof Error) || !CONNECTION_ERROR.test(problem.message)) throw problem
              updateNotice(id, { progress: 'Connection lost · retrying when it is back…' })
              await new Promise(resolve => window.setTimeout(resolve, 1500))
              await waitForConnection()
              return job.run()
            })
            updateNotice(id, {
              status: 'done',
              detail: `${summary}. Evidence from the log rows is confirmed.`,
              finished: new Date().toISOString(),
              progress: undefined,
              target: { kind: 'review' },
              read: false,
            })
          } catch (problem) {
            updateNotice(id, {
              status: 'error',
              detail: problem instanceof Error ? problem.message : 'Import failed',
              finished: new Date().toISOString(),
              progress: undefined,
              read: false,
            })
          }
        }),
      )
    }
    setToast(`${jobs.length} import${jobs.length === 1 ? '' : 's'} started · see notifications`)
    return Promise.allSettled(done)
  }

  // Drag & drop: every file is read first. Exports with the columns of a saved format and Defender XDR / Sentinel tables
  // are imported right away; a FactGraph board export is imported as such; any other export opens the import dialog,
  // where its columns are mapped once and saved as a format for the next export of the same kind.
  const [dropping, setDropping] = useState(false)
  const dragDepth = useRef(0)
  const [importRequest, setImportRequest] = useState<{ file: File; inspection?: Inspection }[] | null>(null)
  const hasFiles = (event: React.DragEvent) => event.dataTransfer.types.includes('Files')
  const dropFiles = async (files: File[]) => {
    const supported = files.filter(file => /\.(csv|tsv|json|jsonl|ndjson)$/i.test(file.name))
    if (supported.length < files.length)
      setToast(
        `Skipped ${files.length - supported.length} file${files.length - supported.length === 1 ? '' : 's'}: only CSV, JSON and JSONL exports can be imported`,
      )
    const tables: File[] = []
    for (const file of supported) {
      if (/\.json$/i.test(file.name) && (await file.slice(0, 2048).text()).includes('"factgraph-board-v1"')) void importFile(file)
      else tables.push(file)
    }
    if (!tables.length) return
    setToast(`Reading ${tables.length} file${tables.length === 1 ? '' : 's'}…`)
    const read = await Promise.all(
      tables.map(file =>
        inspectImport(boardId, board.sessionToken, file).then(
          inspection => ({ file, inspection }),
          (problem: unknown) => ({ file, problem: problem instanceof Error ? problem.message : String(problem) }),
        ),
      ),
    )
    const formats = loadFormats()
    const jobs: { name: string; run: () => Promise<string> }[] = []
    const unknown: { file: File; inspection: Inspection }[] = []
    const used: string[] = []
    for (const entry of read) {
      if ('problem' in entry) {
        notify({
          kind: 'import',
          status: 'error',
          title: `Import ${entry.file.name}`,
          detail: entry.problem,
          finished: new Date().toISOString(),
          read: false,
        })
        continue
      }
      // A saved format wins over the built-in table: the analyst made it for exactly these columns.
      const match = matchFormat(
        formats,
        entry.inspection.columns.map(c => c.name),
      )
      if (match) used.push(match.format.id)
      if (match || entry.inspection.builtin)
        jobs.push({
          name: entry.file.name,
          run: async () =>
            describeTableImport(
              await uploadImport(boardId, board.sessionToken, entry.file, { ...importFields(match?.format ?? null), dry_run: 'false' }),
            ),
        })
      else unknown.push(entry)
    }
    if (used.length) markUsed(used)
    if (unknown.length) setImportRequest(current => [...(current ?? []), ...unknown])
    if (!jobs.length) return
    // Once everything is in, similar new entities are collapsed into groups. On an empty board the result is arranged;
    // otherwise new nodes keep their spots.
    const existing = data?.entities.map(e => e.id) ?? []
    await runImports(jobs)
    setActiveTab('graph')
    window.setTimeout(() => canvas('group-similar', { existing, arrange: !existing.length }), 300)
  }

  const act = async (action: () => Promise<unknown>, message: string) => {
    setBusy(true)
    setError('')
    try {
      await action()
      setDialog(null)
      setRelationTargetId(null)
      setToast(message)
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : 'Something went wrong.')
    } finally {
      setBusy(false)
    }
  }

  const submit = async (kind: Exclude<DialogKind, null>, values: Record<string, unknown>) => {
    if (!data) return
    const created_at = new Date().toISOString()
    if (kind === 'entity') {
      const id = uuid()
      await act(async () => {
        await board.emit('entity.add', { id, ...values, created_at })
        setSelection({ kind: 'entity', id }, true)
      }, 'Entity saved')
    } else if (kind === 'entity-edit' && selection?.kind === 'entity')
      await act(() => board.emit('entity.update', { id: selection.id, ...values }), 'Entity updated')
    else if (kind === 'entity-merge' && selection?.kind === 'entity')
      await act(async () => {
        await board.emit('entity.merge', { source_id: selection.id, target_id: values.target_id })
        setSelection({ kind: 'entity', id: String(values.target_id) })
      }, 'Entities merged')
    else if (kind === 'source') await act(() => board.emit('source.add', { id: uuid(), ...values, created_at }), 'Source saved')
    else if (kind === 'identifier' && selection?.kind === 'entity') {
      const raw = String(values.raw_value ?? '')
      const scheme = String(values.scheme ?? 'other')
      await act(
        () =>
          board.emit('identifier.add', {
            id: uuid(),
            entity_id: selection.id,
            ...values,
            normalized_value: normalizeIdentifier(scheme, raw),
          }),
        'Identifier saved',
      )
    } else if (kind === 'fact') {
      const assertion = values.assertion as Record<string, unknown>
      const newObjectName = String(values.new_object_name ?? '').trim()
      const newObjectId = newObjectName ? uuid() : ''
      const subject = data.entities.find(e => e.id === String(values.subject_id))
      const fact = {
        id: uuid(),
        subject_id: String(values.subject_id),
        predicate: String(values.predicate).trim(),
        object_id: newObjectId || String(values.object_id),
        valid_from: values.valid_from as string | null,
        valid_to: values.valid_to as string | null,
        created_at,
      }
      const existing = data.facts.find(item => factKey(item) === factKey(fact))
      const assertionPayload = { id: uuid(), fact_id: existing?.id ?? fact.id, ...assertion, created_at }
      if (existing) await act(() => board.emit('assertion.add', assertionPayload), 'Evidence added to existing relationship')
      else
        await act(async () => {
          await board.emitMany([
            ...(newObjectId
              ? [
                  {
                    type: 'entity.add' as const,
                    payload: {
                      id: newObjectId,
                      name: newObjectName,
                      kind: String(values.new_object_kind || 'Other'),
                      description: '',
                      created_at,
                      ...(subject?.position ? { x: subject.position.x + 320, y: subject.position.y } : {}),
                    },
                  },
                ]
              : []),
            { type: 'fact.add', payload: fact },
            { type: 'assertion.add', payload: assertionPayload },
          ])
          setSelection({ kind: 'fact', id: fact.id })
        }, 'Relationship saved')
    } else if (kind === 'assertion' && selection?.kind === 'fact')
      await act(() => board.emit('assertion.add', { id: uuid(), fact_id: selection.id, ...values, created_at }), 'Evidence saved')
    else if (kind === 'assertion-edit' && editingAssertionId)
      await act(() => board.emit('assertion.update', { id: editingAssertionId, ...values }), 'Evidence updated')
  }

  const deleteItem = (kind: 'entity' | 'fact' | 'identifier' | 'group', id: string) => {
    const text =
      kind === 'entity'
        ? 'Delete this entity and its relationships?'
        : kind === 'fact'
          ? 'Delete this relationship and all evidence?'
          : kind === 'group'
            ? 'Ungroup? The entities stay on the board.'
            : 'Delete this identifier?'
    if (!window.confirm(text)) return
    const type =
      kind === 'entity' ? 'entity.delete' : kind === 'fact' ? 'fact.delete' : kind === 'group' ? 'group.delete' : 'identifier.delete'
    void act(async () => {
      await board.emit(type, { id })
      if (kind !== 'identifier') setSelection(null)
    }, 'Deleted · undo available')
  }
  const undo = () =>
    void board
      .undo()
      .then(changed => setToast(changed ? 'Change undone' : 'Nothing to undo'))
      .catch(e => setError(String(e)))
  const redo = () =>
    void board
      .redo()
      .then(changed => setToast(changed ? 'Change restored' : 'Nothing to redo'))
      .catch(e => setError(String(e)))
  const explorerOpen = explorerByView[activeTab] ?? false
  const toggleExplorer = () =>
    setExplorerByView(current => {
      const next = !current[activeTab]
      writePref(`explorer:${activeTab}`, String(next))
      return { ...current, [activeTab]: next }
    })
  const toggleTheme = () =>
    setTheme(current => {
      const next = current === 'dark' ? 'light' : 'dark'
      writePref('theme', next)
      return next
    })

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      const typing = !!target && (['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || target.isContentEditable)
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setShowPalette(open => !open)
        return
      }
      if (event.key === 'Escape') {
        if (showPalette) setShowPalette(false)
        else if (showConnect) setShowConnect(false)
        else if (showHelp) setShowHelp(false)
        else if (dialog) setDialog(null)
        else if (showLogImport) setShowLogImport(false)
        else if (readerId) setReaderId(null)
        else if (typing && target === searchInput.current) {
          setSearch('')
          target.blur()
        } else setSelection(null)
        return
      }
      if (typing || showPalette || dialog || readerId || showLogImport || showHelp || showConnect || askName) return
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault()
        if (event.shiftKey) redo()
        else undo()
        return
      }
      if (event.metaKey || event.ctrlKey || event.altKey) return
      if ((event.key === 'Delete' || event.key === 'Backspace') && selection) {
        event.preventDefault()
        deleteItem(selection.kind, selection.id)
        return
      }
      if (event.key === '/') {
        event.preventDefault()
        searchInput.current?.focus()
      } else if (event.key === '?') setShowHelp('keys')
      else if (event.key.toLowerCase() === 'e') toggleExplorer()
      else if (event.key.toLowerCase() === 't') setShowTime(open => !open)
      else if (['1', '2', '3', '4', '5'].includes(event.key))
        setActiveTab((['graph', 'timeline', 'review', 'activity', 'impact'] as WorkspaceTab[])[Number(event.key) - 1])
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [board.undo, board.redo, dialog, selection, showLogImport, readerId, showPalette, showHelp, showConnect, askName, activeTab])

  const navigate = (id: string) => {
    writePref('lastBoard', id)
    window.location.assign(`/boards/${id}`)
  }
  // Investigation data must not stay on an analyst's machine forever: remove it here, deliberately.
  const removeBoard = async () => {
    const others = board.peers.length
    const ok = window.confirm(
      `Remove “${board.boardName}” from this browser?\n\nIts ${board.actions.length.toLocaleString('en')} changes are deleted here. ${others ? `${others} other analyst${others === 1 ? ' has' : 's have'} it open and keep${others === 1 ? 's' : ''} their copy.` : 'Nobody else has it open right now: if no colleague or export has a copy, it is gone for good.'}\n\nExport it as JSON first if you may need it again.`,
    )
    if (!ok) return
    try {
      boardRemoved.current = true
      await deleteBoard(boardId)
      writePref('lastBoard', '')
      window.location.assign(`/boards/${uuid()}`)
    } catch (problem) {
      setError(`Could not remove the board: ${String(problem)}`)
    }
  }
  const copyValue = async (value: string, label: string) => {
    try {
      await navigator.clipboard.writeText(value)
      setToast(`${label} copied`)
    } catch {
      window.prompt(`Copy ${label}:`, value)
    }
  }
  const mcpEndpoint = `${window.location.origin}/mcp/`
  const restDocsEndpoint = `${window.location.origin}/docs`
  const exportJson = () => JSON.stringify({ format: 'factgraph-board-v1', boardId, name: board.boardName, actions: board.actions }, null, 2)
  const download = () => {
    const url = URL.createObjectURL(new Blob([exportJson()], { type: 'application/json' }))
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `factgraph-${boardId.slice(0, 8)}.json`
    anchor.style.display = 'none'
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
    window.setTimeout(() => URL.revokeObjectURL(url), 1000)
    setToast('Board export started')
    notify({
      kind: 'export',
      status: 'done',
      title: 'Board exported as JSON',
      detail: `${board.actions.length.toLocaleString('en')} actions · ${anchor.download}`,
      read: true,
    })
  }
  const importFile = async (file: File | undefined) => {
    if (!file) return
    setError('')
    try {
      const parsed = JSON.parse(await file.text()) as Record<string, unknown>
      if (parsed.format === 'factgraph-board-v1' && Array.isArray(parsed.actions)) {
        const count = await board.importActions(parsed.actions as unknown[])
        setToast('Actions imported')
        notify({
          kind: 'import',
          status: 'done',
          title: `Imported ${file.name}`,
          detail: `${count.toLocaleString('en')} new actions (already known ones are skipped)`,
          target: { kind: 'activity' },
          read: true,
        })
      } else {
        const count = await board.emitMany(legacyDrafts(parsed))
        setToast('Legacy data imported')
        notify({
          kind: 'import',
          status: 'done',
          title: `Imported ${file.name}`,
          detail: `${count.toLocaleString('en')} changes from a legacy export`,
          target: { kind: 'activity' },
          read: true,
        })
      }
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : 'Import failed')
      notify({
        kind: 'import',
        status: 'error',
        title: `Import of ${file.name} failed`,
        detail: problem instanceof Error ? problem.message : 'Import failed',
      })
    }
  }
  const renameBoard = () => {
    const value = window.prompt('Board name', board.boardName)
    if (value?.trim()) void act(() => board.emit('board.rename', { name: value.trim() }), 'Board renamed')
  }
  const renameSelf = () => {
    const value = window.prompt('Your display name', board.name)
    if (value?.trim()) board.setName(value)
  }
  const openDialog = (kind: DialogKind) => {
    setError('')
    setDialog(kind)
  }

  const timeFacts = useMemo(
    () => factsInWindow(data?.facts ?? [], evidenceFrom || null, evidenceTo || null, includeUndated),
    [data, evidenceFrom, evidenceTo, includeUndated],
  )
  const filteredFacts = useMemo(
    () => timeFacts.filter(item => stateFilter === 'all' || item.truth_state === stateFilter),
    [timeFacts, stateFilter],
  )
  const counts = useMemo(
    () =>
      Object.fromEntries(allStates.map(state => [state, timeFacts.filter(item => item.truth_state === state).length])) as Record<
        TruthState,
        number
      >,
    [timeFacts],
  )
  const reviewCount = useMemo(
    () => data?.facts.reduce((sum, f) => sum + f.assertions.filter(a => !a.retracted_at && a.review_status !== 'confirmed').length, 0) ?? 0,
    [data],
  )
  const timelineCount = useMemo(() => timelineEvents(filteredFacts).length, [filteredFacts])
  // The attack impact follows every change; without a compromised entity it is a single pass over the entities.
  const impact = useMemo(() => (data ? analyzeImpact(data) : null), [data])
  const hunting = useMemo(
    () => (data && impact?.seeds.length && activeTab === 'impact' ? huntingQueries(data, impact) : []),
    [data, impact, activeTab],
  )
  const gaps = useMemo(() => (data && impact && activeTab === 'impact' ? boardGaps(data, impact) : null), [data, impact, activeTab])
  const [impactLens, setImpactLens] = useState(false)
  useEffect(() => {
    if (!impact?.seeds.length) setImpactLens(false)
  }, [impact?.seeds.length])
  const matchCount = useMemo(() => {
    const q = search.trim().toLowerCase()
    return q && data
      ? data.entities.filter(e => `${e.name} ${e.kind} ${e.identifiers.map(i => i.raw_value).join(' ')}`.toLowerCase().includes(q)).length
      : 0
  }, [data, search])
  const timeActive = !!(evidenceFrom || evidenceTo) || !includeUndated
  const filterSummary = [
    activePerspective ? `Perspective ${data?.views?.find(v => v.id === activePerspective)?.name ?? ''}` : '',
    lens.layers
      ? `Layers: ${LAYERS.filter(l => lens.layers!.has(l.id))
          .map(l => l.label)
          .join(', ')}`
      : '',
    stateFilter !== 'all' ? `Status: ${labels[stateFilter]}` : '',
    evidenceFrom || evidenceTo ? `Evidence ${periodLabel(evidenceFrom || null, evidenceTo || null)}` : '',
    !includeUndated ? 'dated evidence only' : '',
  ]
    .filter(Boolean)
    .join(' · ')

  const paletteItems = useMemo<PaletteItem[]>(() => {
    const actions: PaletteItem[] = [
      {
        id: 'a-entity',
        group: 'Create',
        label: 'New entity',
        hint: 'N',
        icon: <Plus size={15} />,
        run: () => {
          setActiveTab('graph')
          canvas('place')
        },
      },
      {
        id: 'a-entity-form',
        group: 'Create',
        label: 'New entity with details…',
        icon: <Plus size={15} />,
        run: () => openDialog('entity'),
      },
      { id: 'a-fact', group: 'Create', label: 'New relationship…', icon: <Link2 size={15} />, run: () => openDialog('fact') },
      { id: 'a-source', group: 'Create', label: 'New source…', icon: <FileText size={15} />, run: () => openDialog('source') },
      {
        id: 'a-activity',
        group: 'Create',
        label: 'New activity (several participants)…',
        icon: <Zap size={15} />,
        run: () => openDialog('activity'),
      },
      { id: 'v-graph', group: 'View', label: 'Graph', hint: '1', icon: <GitBranch size={15} />, run: () => setActiveTab('graph') },
      { id: 'v-timeline', group: 'View', label: 'Timeline', hint: '2', icon: <Clock size={15} />, run: () => setActiveTab('timeline') },
      {
        id: 'v-review',
        group: 'View',
        label: 'Evidence review',
        hint: '3',
        icon: <ShieldCheck size={15} />,
        run: () => setActiveTab('review'),
      },
      {
        id: 'v-activity',
        group: 'View',
        label: 'Change log (who changed what, via UI, REST, MCP, import)',
        hint: '4',
        icon: <Activity size={15} />,
        run: () => setActiveTab('activity'),
      },
      {
        id: 'i-impact',
        group: 'View',
        label: 'Attack impact: compromised, impacted, rotate, hunt',
        hint: '5',
        icon: <ShieldAlert size={15} />,
        run: () => setActiveTab('impact'),
      },
      {
        id: 'c-fit',
        group: 'Canvas',
        label: 'Fit graph to screen',
        hint: 'F',
        icon: <Crosshair size={15} />,
        run: () => {
          setActiveTab('graph')
          canvas('fit')
        },
      },
      {
        id: 'i-lens',
        group: 'Canvas',
        label: 'Show the attack in the graph (impact lens)',
        icon: <ShieldAlert size={15} />,
        run: () => {
          setImpactLens(true)
          setActiveTab('graph')
        },
      },
      {
        id: 'c-group-similar',
        group: 'Changes the board (shared, undo)',
        label: 'Group all similar entities and arrange',
        hint: `${mod}Z undoes`,
        icon: <Boxes size={15} />,
        run: () => {
          setActiveTab('graph')
          canvas('group-similar')
        },
      },
      {
        id: 'c-arrange',
        group: 'Changes the board (shared, undo)',
        label: 'Auto-arrange graph (saves positions for everyone)',
        hint: `${mod}Z undoes`,
        icon: <Sparkles size={15} />,
        run: () => {
          setActiveTab('graph')
          canvas('arrange')
        },
      },
      {
        id: 'c-arrange-organic',
        group: 'Changes the board (shared, undo)',
        label: 'Arrange organically (large graphs, saves positions)',
        hint: `${mod}Z undoes`,
        icon: <Sparkles size={15} />,
        run: () => {
          setActiveTab('graph')
          canvas('arrange-organic')
        },
      },
      {
        id: 'c-arrange-layers',
        group: 'Changes the board (shared, undo)',
        label: 'Arrange by layer (swimlanes, saves positions)',
        hint: `${mod}Z undoes`,
        icon: <Layers size={15} />,
        run: () => {
          setActiveTab('graph')
          canvas('arrange-layers')
        },
      },
      {
        id: 'c-all-layers',
        group: 'Canvas',
        label: 'Show all layers',
        icon: <Layers size={15} />,
        run: () => setLens({ ...lens, layers: null }),
      },
      {
        id: 'c-activities',
        group: 'Canvas',
        label: lens.collapseActivities ? 'Show activities as event nodes' : 'Show activities as edges',
        icon: <Zap size={15} />,
        run: () => setLens({ ...lens, collapseActivities: !lens.collapseActivities }),
      },
      ...LAYERS.map(layer => ({
        id: `l-${layer.id}`,
        group: 'Layers',
        label: `Only ${layer.label}`,
        hint: layer.hint,
        icon: <Layers size={15} />,
        run: () => {
          setActiveTab('graph')
          setLens({ ...lens, layers: new Set([layer.id]) })
        },
      })),
      ...(data?.views ?? []).map(view => ({
        id: `p-${view.id}`,
        group: 'Perspectives',
        label: view.name,
        icon: <Layers size={15} />,
        run: () => {
          setActiveTab('graph')
          applyPerspective(view.id)
        },
      })),
      ...(data?.groups ?? []).map(group => ({
        id: `g-${group.id}`,
        group: 'Groups',
        label: group.name,
        hint: `${group.member_ids.length} members`,
        icon: <Boxes size={15} />,
        run: () => setSelection({ kind: 'group', id: group.id }, true),
      })),
      {
        id: 'c-explorer',
        group: 'Canvas',
        label: explorerOpen ? 'Hide entity explorer' : 'Show entity explorer',
        hint: 'E',
        icon: <ListTree size={15} />,
        run: toggleExplorer,
      },
      {
        id: 'c-time',
        group: 'Canvas',
        label: showTime ? 'Hide evidence window' : 'Show evidence window',
        hint: 'T',
        icon: <Clock size={15} />,
        run: () => setShowTime(!showTime),
      },
      {
        id: 'c-reset-view',
        group: 'Canvas',
        label: 'Reset my view (filters, layers, evidence window)',
        icon: <RotateCcw size={15} />,
        run: resetView,
      },
      {
        id: 'c-theme',
        group: 'Canvas',
        label: theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme',
        icon: theme === 'dark' ? <Sun size={15} /> : <Moon size={15} />,
        run: toggleTheme,
      },
      {
        id: 'x-png',
        group: 'Export',
        label: 'Export graph as PNG',
        icon: <ImageDown size={15} />,
        run: () => {
          setActiveTab('graph')
          window.setTimeout(() => canvas('export', { kind: 'png' }), 50)
        },
      },
      {
        id: 'x-svg',
        group: 'Export',
        label: 'Export graph as SVG (vector)',
        icon: <ImageDown size={15} />,
        run: () => {
          setActiveTab('graph')
          window.setTimeout(() => canvas('export', { kind: 'svg' }), 50)
        },
      },
      {
        id: 'b-import-logs',
        group: 'Board',
        label: 'Import logs and exports…',
        icon: <Upload size={15} />,
        run: () => setShowLogImport(true),
      },
      { id: 'b-export', group: 'Board', label: 'Export board JSON', icon: <ArrowDownToLine size={15} />, run: download },
      { id: 'b-import', group: 'Board', label: 'Import board JSON…', icon: <Upload size={15} />, run: () => importInput.current?.click() },
      {
        id: 'b-link',
        group: 'Board',
        label: 'Copy board link',
        icon: <Copy size={15} />,
        run: () => void copyValue(window.location.href, 'Board link'),
      },
      {
        id: 'b-token',
        group: 'Board',
        label: 'Copy board token (REST + MCP)',
        icon: <Plug size={15} />,
        run: () => void copyValue(board.sessionToken, 'Session token'),
      },
      {
        id: 'b-connect',
        group: 'Board',
        label: 'Connect an agent (VS Code, Claude Code)…',
        icon: <Plug size={15} />,
        run: () => setShowConnect(true),
      },
      {
        id: 'b-help',
        group: 'Board',
        label: 'Keyboard & mouse controls',
        hint: '?',
        icon: <Keyboard size={15} />,
        run: () => setShowHelp('keys'),
      },
      {
        id: 'b-glossary',
        group: 'Board',
        label: 'Glossary: status, evidence, review…',
        icon: <CircleHelp size={15} />,
        run: () => setShowHelp('glossary'),
      },
      { id: 'b-data', group: 'Board', label: 'Where is my data stored?', icon: <HardDrive size={15} />, run: () => setShowHelp('data') },
    ]
    const entities: PaletteItem[] = (data?.entities ?? []).map(entity => ({
      id: `e-${entity.id}`,
      group: 'Entities',
      label: entity.name,
      hint: `${entity.kind}${entity.identifiers[0] ? ` · ${entity.identifiers[0].raw_value}` : ''}`,
      icon: <EntityAvatar entity={entity} data={data ?? undefined} size="sm" />,
      run: () => setSelection({ kind: 'entity', id: entity.id }, true),
    }))
    return [...actions, ...entities]
  }, [data, explorerOpen, showTime, theme, board.sessionToken, activeTab, lens, activePerspective])

  const tabs: { id: WorkspaceTab; label: string; short: string; icon: ReactNode; count: number }[] = [
    { id: 'graph', label: 'Graph', short: 'Graph', icon: <GitBranch size={14} />, count: data?.entities.length ?? 0 },
    { id: 'timeline', label: 'Timeline', short: 'Timeline', icon: <Clock size={14} />, count: timelineCount },
    { id: 'review', label: 'Evidence review', short: 'Review', icon: <ShieldCheck size={14} />, count: reviewCount },
    { id: 'activity', label: 'Change log', short: 'Changes', icon: <Activity size={14} />, count: board.actions.length },
    { id: 'impact', label: 'Attack impact', short: 'Impact', icon: <ShieldAlert size={14} />, count: impact?.impacted.length ?? 0 },
  ]
  const showInspector = !!(data && selection)

  return (
    <div className={`app-shell${explorerOpen ? ' explorer-open' : ''}${showInspector ? ' inspector-open' : ''}`}>
      <header className="topbar compact-header">
        <div className="topbar-left">
          <button
            className={`icon-button explorer-toggle ${explorerOpen ? 'active' : ''}`}
            onClick={toggleExplorer}
            aria-label={explorerOpen ? 'Hide explorer' : 'Show explorer'}
            title="Entity explorer · E"
          >
            <ListTree size={16} />
          </button>
          <Menu
            label="Board menu"
            className="board-menu"
            trigger={
              <>
                <span className="brand-mark">
                  <GitBranch size={13} strokeWidth={2.4} />
                </span>
                <strong className="board-name">{board.boardName}</strong>
                <ChevronDown size={13} />
              </>
            }
          >
            <div className="menu-label">Board</div>
            <button onClick={renameBoard}>
              <Pencil size={14} /> Rename board
            </button>
            <button onClick={() => void copyValue(window.location.href, 'Board link')}>
              <Link2 size={14} /> Copy board link
            </button>
            <button onClick={() => void copyValue(boardId, 'Board ID')}>
              <Copy size={14} /> Copy board ID
            </button>
            <button onClick={resetView} title="Filters, layers, evidence window and zoom are remembered per board in this browser">
              <RotateCcw size={14} /> Reset my view
            </button>
            <div className="menu-sep" />
            <button onClick={() => setShowLogImport(true)}>
              <Upload size={14} /> Import logs and exports
            </button>
            <button onClick={() => importInput.current?.click()}>
              <Upload size={14} /> Import board JSON
            </button>
            <button onClick={download}>
              <ArrowDownToLine size={14} /> Export board JSON
            </button>
            <button
              onClick={() => {
                setActiveTab('graph')
                window.setTimeout(() => canvas('export', { kind: 'png' }), 50)
              }}
            >
              <ImageDown size={14} /> Export graph as PNG
            </button>
            <button
              onClick={() => {
                setActiveTab('graph')
                window.setTimeout(() => canvas('export', { kind: 'svg' }), 50)
              }}
            >
              <ImageDown size={14} /> Export graph as SVG
            </button>
            <button onClick={() => void copyValue(exportJson(), 'Board JSON')}>
              <Copy size={14} /> Copy board JSON
            </button>
            <div className="menu-sep" />
            <div className="menu-label">Boards in this browser</div>
            <div className="menu-scroll">
              {board.boards.map(item => (
                <button key={item.id} className={item.id === boardId ? 'current' : ''} onClick={() => navigate(item.id)}>
                  <span className="menu-board-name">{item.name}</span>
                  <small>{item.id.slice(0, 8)}</small>
                </button>
              ))}
            </div>
            <button onClick={() => navigate(uuid())}>
              <Plus size={14} /> New board
            </button>
            <button
              className="danger"
              onClick={() => void removeBoard()}
              title="Deletes this board's data from this browser; colleagues keep their copies"
            >
              <Trash2 size={14} /> Remove board from this browser…
            </button>
            <div className="menu-sep" />
            <button onClick={renameSelf}>
              Display name · <strong>{board.name}</strong>
            </button>
            <div className="menu-sep" />
            <button className="menu-footer" onClick={() => setShowHelp('data')}>
              <HardDrive size={14} />
              <span>Stored only in this browser</span>
              <small>v{__APP_VERSION__}</small>
            </button>
          </Menu>
          <PresenceMenu
            connected={board.connected}
            self={{ id: board.actor, name: board.name }}
            peers={board.peers}
            actions={board.actions}
            onRename={renameSelf}
          />
          <SyncStatus sync={board.sync} connected={board.connected} ready={board.ready} />
        </div>
        <nav className="view-tabs" role="tablist" aria-label="Board views">
          {tabs.map(tab => (
            <button
              key={tab.id}
              role="tab"
              aria-label={tab.label}
              aria-selected={activeTab === tab.id}
              className={activeTab === tab.id ? 'active' : ''}
              onClick={() => setActiveTab(tab.id)}
              title={tab.label}
            >
              {tab.icon}
              <span className="tab-text">{tab.short}</span>
              {tab.count > 0 && (
                <b className={tab.id === 'review' ? 'attention' : tab.id === 'impact' ? 'attention danger' : ''}>
                  {tab.count > 9999 ? '9k+' : tab.count}
                </b>
              )}
            </button>
          ))}
        </nav>
        <div className="topbar-right">
          <div className={`header-search ${search ? 'has-value' : ''}`}>
            <Search size={14} />
            <input
              ref={searchInput}
              aria-label="Find entity"
              title="Find an entity by name, type or identifier: filters the entity explorer, Enter opens the best match"
              placeholder="Find entity…"
              value={search}
              onChange={e => setSearch(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && search.trim() && data) {
                  const q = search.trim().toLowerCase()
                  const hit =
                    data.entities.find(x => x.name.toLowerCase() === q || x.identifiers.some(i => i.raw_value.toLowerCase() === q)) ??
                    data.entities.find(x => x.name.toLowerCase().startsWith(q)) ??
                    data.entities.find(x =>
                      `${x.name} ${x.kind} ${x.identifiers.map(i => i.raw_value).join(' ')}`.toLowerCase().includes(q),
                    )
                  if (hit) setSelection({ kind: 'entity', id: hit.id }, true)
                }
              }}
            />
            {search ? (
              <>
                <span className="search-count">{matchCount}</span>
                <button className="icon-button" aria-label="Clear search" onClick={() => setSearch('')}>
                  <X size={12} />
                </button>
              </>
            ) : (
              <Kbd>/</Kbd>
            )}
          </div>
          <button
            className="icon-button command-button hide-sm"
            onClick={() => setShowPalette(true)}
            aria-label="Command palette"
            title={`Command palette · ${mod}K`}
          >
            <Command size={15} />
          </button>
          <button
            className={`icon-button hide-sm ${showTime ? 'active' : ''} ${timeActive ? 'flagged' : ''}`}
            onClick={() => setShowTime(!showTime)}
            aria-label="Evidence window"
            aria-pressed={showTime}
            title="Evidence time window · T"
          >
            <Clock size={15} />
          </button>
          <NotificationCenter
            notices={notices}
            onOpen={openNotice}
            onDismiss={id => setNotices(list => list.filter(n => n.id !== id))}
            onClearFinished={() => setNotices(list => list.filter(n => n.status === 'running' || n.status === 'queued'))}
            onMarkRead={markNoticesRead}
          />
          <span className="topbar-sep" />
          <button className="icon-button" aria-label="Undo" title={`Undo · ${mod}Z`} onClick={undo}>
            <Undo2 size={15} />
          </button>
          <button className="icon-button hide-sm" aria-label="Redo" title={`Redo · ⇧${mod}Z`} onClick={redo}>
            <Redo2 size={15} />
          </button>
          <span className="topbar-sep" />
          <Menu
            label="Create"
            align="right"
            className="create-menu"
            trigger={
              <>
                <Plus size={15} />
                <span className="trigger-text">Create</span>
              </>
            }
          >
            <button
              onClick={() => {
                setActiveTab('graph')
                canvas('place')
              }}
            >
              <Plus size={14} /> Entity <Kbd>N</Kbd>
            </button>
            <button onClick={() => openDialog('entity')}>
              <Pencil size={14} /> Entity with details…
            </button>
            <button onClick={() => openDialog('fact')} disabled={!data || data.entities.length < 2}>
              <Link2 size={14} /> Relationship…
            </button>
            <button onClick={() => openDialog('activity')} disabled={!data || data.entities.length < 2}>
              <Zap size={14} /> Activity…
            </button>
            <button onClick={() => openDialog('source')}>
              <FileText size={14} /> Source…
            </button>
          </Menu>
          <Menu label="API and MCP" align="right" className="api-menu" trigger={<Plug size={15} />}>
            <div className="menu-label">Integrations</div>
            <button onClick={() => setShowConnect(true)}>
              <Plug size={14} /> Connect an agent…
            </button>
            <button onClick={() => void copyValue(mcpEndpoint, 'MCP endpoint')}>
              <Copy size={14} /> Copy MCP endpoint
            </button>
            <button onClick={() => void copyValue(`${window.location.origin}/api/boards/${boardId}`, 'REST endpoint')}>
              <Copy size={14} /> Copy REST board endpoint
            </button>
            <button onClick={() => void copyValue(board.sessionToken, 'Board token')}>
              <Copy size={14} /> Copy board token
            </button>
            <a href={restDocsEndpoint} target="_blank" rel="noreferrer">
              <FileText size={14} /> REST documentation
            </a>
            <p className="menu-note">Same token for REST + MCP. Keep this board open while agents write.</p>
          </Menu>
          <button
            className="icon-button theme-toggle"
            onClick={toggleTheme}
            aria-label={theme === 'dark' ? 'Light theme' : 'Dark theme'}
            title="Toggle theme"
          >
            {theme === 'dark' ? <Sun size={15} /> : <Moon size={15} />}
          </button>
          <button
            className="icon-button help-button"
            onClick={() => setShowHelp('data')}
            aria-label="Help and data storage"
            title="Help · data storage · shortcuts"
          >
            <CircleHelp size={16} />
          </button>
        </div>
      </header>

      <div
        className={`workspace${dropping ? ' dropping' : ''}`}
        onDragEnter={event => {
          if (!hasFiles(event) || !data) return
          dragDepth.current++
          setDropping(true)
        }}
        onDragLeave={event => {
          if (!hasFiles(event)) return
          dragDepth.current = Math.max(0, dragDepth.current - 1)
          if (!dragDepth.current) setDropping(false)
        }}
        onDragOver={event => {
          if (!hasFiles(event) || !data) return
          event.preventDefault()
          event.dataTransfer.dropEffect = 'copy'
        }}
        onDrop={event => {
          if (!hasFiles(event) || !data) return
          event.preventDefault()
          dragDepth.current = 0
          setDropping(false)
          void dropFiles([...event.dataTransfer.files])
        }}
      >
        {dropping && (
          <div className="drop-overlay" aria-hidden="true">
            <Upload size={26} />
            <strong>Drop exports to import them</strong>
            <span>
              Defender XDR advanced hunting and Microsoft Sentinel exports (CSV, JSON) are recognised and mapped automatically. FactGraph
              board exports work too.
            </span>
          </div>
        )}
        {explorerOpen && data && (
          <Explorer data={data} search={search} selection={selection} onSelect={setSelection} onClose={toggleExplorer} />
        )}
        <main className={`stage${showTime ? ' time-open' : ''}`}>
          {activeTab === 'graph' && (
            <div className="graph-stage">
              {data && (
                <GraphView
                  entityTypes={data.entity_types ?? []}
                  onCommand={board.emitMany}
                  theme={theme}
                  request={request}
                  onEdit={id => {
                    setSelection({ kind: 'entity', id })
                    openDialog('entity-edit')
                  }}
                  onMerge={id => {
                    setSelection({ kind: 'entity', id })
                    openDialog('entity-merge')
                  }}
                  onCopy={(value, label) => void copyValue(value, label)}
                  entities={data.entities}
                  facts={filteredFacts}
                  groups={data.groups ?? []}
                  perspectives={data.views ?? []}
                  lens={lens}
                  onLensChange={next => setLens(next)}
                  impact={impact}
                  impactLens={impactLens}
                  onImpactLensChange={setImpactLens}
                  onOpenImpact={() => setActiveTab('impact')}
                  activePerspective={activePerspective}
                  onApplyPerspective={applyPerspective}
                  onSavePerspective={name => {
                    const id = uuid()
                    void act(async () => {
                      await board.emit('view.add', {
                        id,
                        name,
                        layers: lens.layers ? [...lens.layers] : null,
                        collapse_activities: lens.collapseActivities,
                        show_lanes: lens.showLanes,
                      })
                      setPerspectiveParam(id)
                    }, 'Perspective saved')
                  }}
                  onDeletePerspective={id => {
                    void act(() => board.emit('view.delete', { id }), 'Perspective deleted')
                    if (id === activePerspective) setPerspectiveParam(null)
                  }}
                  boardName={board.boardName}
                  filterSummary={filterSummary}
                  onNotice={setToast}
                  onRequestDone={() => setRequest(null)}
                  selection={selection}
                  search={search}
                  onSelect={setSelectionState}
                  onExported={detail => notify({ kind: 'export', status: 'done', title: 'Graph exported', detail, read: true })}
                  initialViewport={viewport.current}
                  onViewportChange={v => {
                    viewport.current = v
                    persistView()
                  }}
                />
              )}
              {data && data.entities.length > 0 && (
                <div className="status-filter" role="group" aria-label="Filter relationships by status">
                  <span
                    className="status-filter-label"
                    title="Line colour = evidence status (is it confirmed?). Red markers and red names = compromise. Grey “likely regular” = activity rating."
                  >
                    Evidence
                  </span>
                  <button className={stateFilter === 'all' ? 'active' : ''} onClick={() => setStateFilter('all')}>
                    All <b>{timeFacts.length}</b>
                  </button>
                  {allStates.map(state => (
                    <button
                      key={state}
                      className={`${state} ${stateFilter === state ? 'active' : ''}`}
                      onClick={() => setStateFilter(stateFilter === state ? 'all' : state)}
                      title={`Show only ${labels[state].toLowerCase()} relationships`}
                    >
                      <span className="legend-line" />
                      {labels[state]} <b>{counts[state]}</b>
                    </button>
                  ))}
                </div>
              )}
              {data && data.entities.length === 0 && board.joining && (
                <div className="empty-overlay">
                  <div className="empty-card joining" role="status">
                    <div className="empty-graphic">
                      <RotateCcw size={24} className="spin" />
                    </div>
                    <h2>Receiving the board…</h2>
                    <p>
                      Other analysts have this board open; their changes are on the way into this browser. Large boards take a few seconds.
                    </p>
                  </div>
                </div>
              )}
              {data && data.entities.length === 0 && !board.joining && (
                <div className="empty-overlay">
                  <div className="empty-card">
                    <div className="empty-graphic">
                      <GitBranch size={26} />
                    </div>
                    <h2>Start your investigation</h2>
                    <p>
                      Create entities and connect them with evidence-backed relationships, drop Defender XDR or Sentinel exports (CSV, JSON)
                      here, or let an agent fill the board via REST / MCP.
                    </p>
                    <div className="empty-actions">
                      <button className="primary-button" onClick={() => canvas('place')}>
                        <Plus size={15} /> First entity
                      </button>
                      <button
                        className="secondary-button"
                        onClick={() => void act(() => board.emitMany(demoDrafts()), 'Example data loaded')}
                      >
                        <Sparkles size={15} /> Load example
                      </button>
                      <button className="secondary-button" onClick={() => setShowLogImport(true)}>
                        <Upload size={15} /> Import logs
                      </button>
                    </div>
                    <button className="empty-storage" onClick={() => setShowHelp('data')}>
                      <HardDrive size={13} /> Data stays in this browser — learn more
                    </button>
                    <div className="empty-keys">
                      <span>
                        <Kbd>N</Kbd> new entity
                      </span>
                      <span>
                        <Kbd>{mod}</Kbd>
                        <Kbd>K</Kbd> commands
                      </span>
                      <span>
                        <Kbd>?</Kbd> shortcuts
                      </span>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}
          {activeTab === 'review' && data && (
            <div className="scroll-stage">
              <EvidenceQueue data={data} onOpen={setReaderId} attack={impact?.facts.size ? impact.facts : null} />
            </div>
          )}
          {activeTab === 'timeline' && data && (
            <div className="scroll-stage">
              <TimelinePanel data={data} facts={filteredFacts} selection={selection} onSelect={setSelection} impact={impact} />
            </div>
          )}
          {activeTab === 'activity' && data && (
            <div className="scroll-stage">
              <ActivityPanel actions={board.actions} data={data} onSelect={next => setSelection(next)} />
            </div>
          )}
          {activeTab === 'impact' && data && impact && (
            <div className="scroll-stage">
              <ImpactPanel
                data={data}
                impact={impact}
                queries={hunting}
                gaps={gaps}
                onCommand={board.emitMany}
                onShow={id => setSelection({ kind: 'entity', id }, true)}
                onShowFact={id => setSelection({ kind: 'fact', id }, true)}
                onLens={() => {
                  setImpactLens(true)
                  setActiveTab('graph')
                }}
                onCopy={(value, label) => void copyValue(value, label)}
              />
            </div>
          )}
          {showTime && data && (
            <EvidenceWindow
              facts={data.facts}
              from={evidenceFrom}
              to={evidenceTo}
              includeUndated={includeUndated}
              onIncludeUndatedChange={setIncludeUndated}
              onFromChange={setEvidenceFrom}
              onToChange={setEvidenceTo}
              onReset={() => {
                setEvidenceFrom('')
                setEvidenceTo('')
                setIncludeUndated(true)
              }}
              onClose={() => setShowTime(false)}
              attack={impact?.seeds.length ? impact : null}
            />
          )}
          {!showTime && timeActive && (
            <button className="time-chip" onClick={() => setShowTime(true)}>
              <Clock size={13} /> Time window active
            </button>
          )}
        </main>
        {showInspector &&
          selection?.kind === 'group' &&
          data &&
          (() => {
            const group = data.groups?.find(g => g.id === selection.id)
            return group ? (
              <GroupInspector
                data={data}
                group={group}
                impact={impact}
                onCommand={board.emitMany}
                onSelect={setSelection}
                onFocus={id => {
                  setActiveTab('graph')
                  canvas('focus', { id })
                }}
                onClose={() => setSelection(null)}
              />
            ) : null
          })()}
        {showInspector && selection && selection.kind !== 'group' && data && (
          <Inspector
            data={data}
            selection={selection}
            onAdd={openDialog}
            onDelete={deleteItem}
            onCopy={(value, label) => void copyValue(value, label)}
            onCommand={board.emitMany}
            onOpenEvidence={id => setReaderId(id)}
            onRetract={id =>
              void act(() => board.emit('assertion.retract', { id, retracted_at: new Date().toISOString() }), 'Evidence retracted')
            }
            onClose={() => setSelection(null)}
            onSelect={setSelection}
            onFocus={id => {
              setActiveTab('graph')
              canvas('focus', { id })
            }}
            impact={impact}
            onOpenImpact={() => setActiveTab('impact')}
          />
        )}
      </div>
      {readerId && data && (
        <EvidenceReader
          data={data}
          evidenceId={readerId}
          actions={board.actions}
          onCommand={board.emitMany}
          onClose={() => setReaderId(null)}
          onCopy={(value, label) => void copyValue(value, label)}
          onNavigate={setReaderId}
        />
      )}
      {dialog === 'activity' && data && (
        <ActivityDialog
          data={data}
          initialEntity={selection?.kind === 'entity' ? selection.id : undefined}
          onClose={() => setDialog(null)}
          onCommand={board.emitMany}
          onCreated={id => {
            setDialog(null)
            setToast('Activity saved')
            setSelection({ kind: 'fact', id }, true)
          }}
        />
      )}
      {dialog && dialog !== 'activity' && data && (
        <Dialog
          key={`${dialog}:${editingAssertionId ?? ''}:${relationTargetId ?? ''}`}
          kind={dialog}
          data={data}
          selection={selection}
          editingAssertionId={editingAssertionId}
          relationTargetId={relationTargetId}
          busy={busy}
          error={error}
          onClose={() => {
            setDialog(null)
            setEditingAssertionId(null)
            setRelationTargetId(null)
          }}
          onSubmit={submit}
        />
      )}
      {(showLogImport || importRequest) && (
        <ImportDialog
          boardId={boardId}
          sessionToken={board.sessionToken}
          initial={importRequest ?? undefined}
          kinds={[
            ...new Set([
              ...kinds,
              ...(data?.entity_types ?? []).map(type => type.name),
              ...(data?.entities ?? []).map(entity => entity.kind),
            ]),
          ]}
          onClose={() => {
            setShowLogImport(false)
            setImportRequest(null)
          }}
          onApply={runImports}
        />
      )}
      {showPalette && <CommandPalette items={paletteItems} onClose={() => setShowPalette(false)} />}
      {showConnect && (
        <AgentConnectDialog
          boardId={boardId}
          token={board.sessionToken}
          name={board.name}
          onCopy={(value, label) => void copyValue(value, label)}
          onClose={() => setShowConnect(false)}
        />
      )}
      {askName && board.ready && !showHelp && (
        <WelcomeDialog
          current={board.name}
          onSave={name => {
            board.setName(name)
            setAskName(false)
          }}
          onLearnMore={() => setShowHelp('data')}
        />
      )}
      {showHelp && (
        <HelpDialog
          key={showHelp}
          initialTab={showHelp}
          boardCount={board.boards.length}
          onExport={download}
          onClose={() => setShowHelp(false)}
        />
      )}
      <input
        ref={importInput}
        type="file"
        accept="application/json,.json"
        hidden
        onChange={event => {
          const file = event.target.files?.[0]
          event.target.value = ''
          void importFile(file)
        }}
      />
      {board.replaced && (
        <div className="replaced-banner" role="alert">
          <AlertTriangle size={15} />
          <span>
            <b>This board was opened with this tab's identity in another tab</b> (for example a duplicated tab), so this tab is no longer
            connected. Your changes here are kept.
          </span>
          <button className="primary-button small" onClick={board.reidentify}>
            Continue here as a new session
          </button>
        </div>
      )}
      {board.otherTabs > 0 && !tabsHintSeen && !board.replaced && (
        <div className="tabs-banner" role="status">
          <Info size={15} />
          <span>
            <b>This board is also open in {board.otherTabs === 1 ? 'another tab' : `${board.otherTabs} other tabs`} of this browser.</b>{' '}
            Every tab loads and syncs the whole board, so a large board stays faster with one tab.
          </span>
          <button className="secondary-button small" onClick={dismissTabsHint}>
            Got it
          </button>
        </div>
      )}
      <div className="toasts" aria-live="polite">
        {board.storageError && <div className="toast error">{board.storageError}</div>}
        {error && !dialog && (
          <div className="toast error" onClick={() => setError('')}>
            {error} <X size={14} />
          </div>
        )}
        {toast && (
          <div className="toast success">
            <CheckCircle2 size={14} /> {toast}
          </div>
        )}
      </div>
    </div>
  )
}
