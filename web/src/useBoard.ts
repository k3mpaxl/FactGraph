import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { type ActionDraft, type BoardAction, isAction, isDraft, project, sortActions, undoneActions } from './board'
import { listBoards, loadActions, saveActions, touchBoard, type BoardMeta } from './store'
import { placeNew } from './layout'
import { uuid } from './uuid'
import { validateDrafts } from './validation'
import { buildViewModel } from './viewModel'
import { browserMeasure, buildGraphSvg, svgToPng } from './exportGraph'
import { iconMarkup, prepareIconMarkup } from './KindIcon'

const MAX_EXPORT_CHARS = 12_000_000

/** Render the board for REST/MCP with a saved perspective (or everything) and the stored group state. */
async function renderExport({ data, name }: ReturnType<typeof project>, options: Record<string, unknown>) {
  const perspective = typeof options.perspective_id === 'string' ? data.views?.find(v => v.id === options.perspective_id) : undefined
  if (options.perspective_id && !perspective) throw new Error('Perspective does not exist on this board')
  const view = buildViewModel(data.entities, data.facts, data.groups ?? [], { visibleLayers: perspective?.layers ? new Set(perspective.layers) : null,
    collapseActivities: options.collapse_activities === true || !!perspective?.collapse_activities, showLanes: !!perspective?.show_lanes, entityTypes: data.entity_types ?? [] })
  await prepareIconMarkup()
  const theme = options.theme === 'dark' ? 'dark' : 'light'
  const title = typeof options.title === 'string' ? options.title : name
  const result = buildGraphSvg({ nodes: view.nodes, edges: view.edges, entityTypes: data.entity_types ?? [], theme, legend: options.legend !== false,
    transparent: options.transparent === true, title: title || undefined, subtitle: [perspective ? `Perspective ${perspective.name}` : '', `exported ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`].filter(Boolean).join(' · '),
    measure: browserMeasure, icon: iconMarkup })
  if (options.format === 'png') {
    const { blob, scale } = await svgToPng(result.svg, result.width, result.height, Number(options.scale ?? 2))
    const bytes = new Uint8Array(await blob.arrayBuffer())
    let binary = ''
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
    const content = btoa(binary)
    if (content.length > MAX_EXPORT_CHARS) throw new Error('PNG too large for the API; use format svg or a lower scale')
    return { format: 'png', mime: 'image/png', encoding: 'base64', content, width: Math.round(result.width * scale), height: Math.round(result.height * scale), scale, node_count: result.nodeCount }
  }
  if (result.svg.length > MAX_EXPORT_CHARS) throw new Error('SVG too large for the API; export it from the board UI instead')
  return { format: 'svg', mime: 'image/svg+xml', encoding: 'utf-8', content: result.svg, width: result.width, height: result.height, node_count: result.nodeCount }
}

export type Peer = { id: string; name: string }

function initialName(actor: string) {
  try { return localStorage.getItem('factgraph:displayName') || `Guest ${actor.slice(0, 4)}` }
  catch { return `Guest ${actor.slice(0, 4)}` }
}

function initialSessionToken(boardId: string) {
  const key = `factgraph:sessionToken:${boardId}`
  try {
    const existing = sessionStorage.getItem(key)
    if (existing) return existing
    const token = `${uuid()}${uuid()}`.replaceAll('-', '')
    sessionStorage.setItem(key, token)
    return token
  } catch {
    return `${uuid()}${uuid()}`.replaceAll('-', '')
  }
}

/** Receives every batch of actions that was newly stored, local or remote (for notifications). */
export type ChangeListener = { current: ((fresh: BoardAction[]) => void) | null }

export function useBoard(boardId: string, listener?: ChangeListener) {
  const actor = useRef((() => {
    const key = `factgraph:actor:${boardId}`
    try { const stored = sessionStorage.getItem(key); if(stored) return stored; const id=uuid(); sessionStorage.setItem(key,id); return id } catch { return uuid() }
  })()).current
  const sessionToken = useRef(initialSessionToken(boardId)).current
  const [name, setNameState] = useState(() => initialName(actor))
  const nameRef = useRef(name)
  const [actions, setActions] = useState<BoardAction[]>([])
  const [boards, setBoards] = useState<BoardMeta[]>([])
  const [peers, setPeers] = useState<Peer[]>([])
  const [ready, setReady] = useState(false)
  const [connected, setConnected] = useState(false)
  const [storageError, setStorageError] = useState('')
  const actionsRef = useRef<BoardAction[]>([])
  const actionIdsRef = useRef<Set<string>>(new Set())
  const boardNameRef = useRef(`Board ${boardId.slice(0, 8)}`)
  const clockRef = useRef(0)
  const socketRef = useRef<WebSocket | null>(null)
  const emissionQueue = useRef<Promise<unknown>>(Promise.resolve())
  const mergeQueue = useRef<Promise<unknown>>(Promise.resolve())
  const flushTimer = useRef<number | undefined>(undefined)
  // One projection per action list. Rendering, emitMany and every REST/MCP command share it instead of re-projecting
  // the whole log each time; the list is replaced on every change (never mutated), so its identity is the cache key.
  const projectionCache = useRef<{ actions: BoardAction[]; result: ReturnType<typeof project> } | null>(null)
  const projectCached = useCallback((list: BoardAction[]) => {
    if (projectionCache.current?.actions !== list) projectionCache.current = { actions: list, result: project(boardId, list) }
    return projectionCache.current.result
  }, [boardId])
  const projection = useMemo(() => projectCached(actions), [projectCached, actions])

  const send = useCallback((message: object) => {
    if (socketRef.current?.readyState === WebSocket.OPEN)
      socketRef.current.send(JSON.stringify(message))
  }, [])

  const sendActions = useCallback((items: BoardAction[], target?: string, deferRender = false) => {
    for (let index = 0; index < items.length; index += 100)
      send({ type: 'actions', actions: items.slice(index, index + 100),
        deferRender: deferRender || index + 100 < items.length,
        ...(target ? { target } : {}) })
  }, [send])

  const merge = useCallback((incoming: unknown[], deferRender = false): Promise<number> => {
    const work = mergeQueue.current.then(async () => {
      const batchKnown = new Set<string>()
      const fresh = incoming.filter((item): item is BoardAction => {
        if (!isAction(item) || item.boardId !== boardId || actionIdsRef.current.has(item.id) || batchKnown.has(item.id)) return false
        batchKnown.add(item.id)
        return true
      })
      if (!fresh.length) {
        if (!deferRender) setActions(actionsRef.current)
        return 0
      }
      const current = actionsRef.current
      const ordered = sortActions(fresh)
      const canAppend = !current.length || ordered[0].clock > current[current.length - 1].clock
      const next = canAppend ? [...current, ...ordered] : sortActions([...current, ...ordered])
      const boardName = fresh.some(item => item.type === 'board.rename') ? projectCached(next).name : boardNameRef.current
      await saveActions(boardId, fresh, boardName)
      for (const item of fresh) actionIdsRef.current.add(item.id)
      actionsRef.current = next
      boardNameRef.current = boardName
      // reduce, not Math.max(...list): spreading 100k+ values overflows the call stack.
      clockRef.current = fresh.reduce((max, item) => Math.max(max, item.clock), clockRef.current)
      if (flushTimer.current) window.clearTimeout(flushTimer.current)
      if (deferRender) flushTimer.current = window.setTimeout(() => setActions(actionsRef.current), 1000)
      else setActions(next)
      setBoards(await listBoards())
      try { listener?.current?.(fresh) } catch { /* a notification problem must never break storage */ }
      return fresh.length
    })
    mergeQueue.current = work.catch(error => { setStorageError(String(error)) })
    return work
  }, [boardId, listener, projectCached])

  const emitMany = useCallback((drafts: ActionDraft[], deferRender = false): Promise<number> => {
    const work = emissionQueue.current.then(async () => {
    await mergeQueue.current
    const currentGraph = projectCached(actionsRef.current).data
    const freshDrafts = placeNew(drafts.filter(draft => !draft.id || !actionIdsRef.current.has(draft.id)),
      currentGraph.entities.map(e => e.position ?? { x: 0, y: 0 }))
    validateDrafts(currentGraph, freshDrafts)
    const batchId = uuid()
    const created = freshDrafts.map(draft => ({
      boardId, id: draft.id ?? uuid(), actor, author: draft.author ?? nameRef.current,
      clock: ++clockRef.current, at: draft.at ?? new Date().toISOString(),
      type: draft.type, payload: draft.payload, batch_id: draft.batch_id ?? batchId, channel: draft.channel ?? 'UI',
    } satisfies BoardAction))
    const accepted = await merge(created, deferRender)
    sendActions(created, undefined, deferRender)
    return accepted
    })
    emissionQueue.current = work.catch(() => undefined)
    return work
  }, [actor, boardId, merge, projectCached, sendActions])

  const emit = useCallback((type: ActionDraft['type'], payload: Record<string, unknown>) =>
    emitMany([{ type, payload }]), [emitMany])

  const undo = useCallback(async () => {
    const alreadyUndone = undoneActions(actionsRef.current)
    const target = [...actionsRef.current].reverse().find(item =>
      item.actor === actor && !item.type.startsWith('action.') && !alreadyUndone.has(item.id))
    if (!target) return false
    const targets = actionsRef.current.filter(item => item.id === target.id || (target.batch_id && item.batch_id === target.batch_id))
    const ids = new Set(targets.flatMap(item => [item.payload.id, item.payload.source_id, item.payload.target_id]).filter(Boolean))
    if (actionsRef.current.some(item => item.actor !== actor && item.clock > target.clock && ids.has(item.payload.id) && !alreadyUndone.has(item.id)))
      throw new Error('Another analyst changed these records. Review their changes before undoing.')
    await emit('action.undo', { action_ids: targets.map(item => item.id) })
    return true
  }, [actor, emit])

  const redo = useCallback(async () => {
    const undone = undoneActions(actionsRef.current)
    const target = [...actionsRef.current].reverse().find(item => item.actor === actor && item.type === 'action.undo' &&
      (item.payload.action_ids as string[] ?? [item.payload.action_id]).some(id => undone.has(String(id))))
    if (!target) return false
    await emit('action.redo', target.payload)
    return true
  }, [actor, emit])

  const importActions = useCallback(async (items: unknown[]) => {
    const received = items.filter(isAction).map(item => ({ ...item, boardId }))
    const count = await merge(received)
    sendActions(received)
    return count
  }, [boardId, merge, sendActions])

  const setName = useCallback((updated: string) => {
    const trimmed = updated.trim().slice(0, 40)
    if (!trimmed) return
    nameRef.current = trimmed
    setNameState(trimmed)
    try { localStorage.setItem('factgraph:displayName', trimmed) } catch { /* private mode */ }
    send({ type: 'profile', name: trimmed })
  }, [send])

  useEffect(() => {
    let cancelled = false
    let retry: number | undefined
    let websocket: WebSocket | null = null

    const connect = () => {
      if (cancelled) return
      const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
      // Identity and token go in the first message, not the URL, so they never appear in access logs.
      const socket = new WebSocket(`${scheme}//${window.location.host}/ws/boards/${boardId}`)
      websocket = socket
      socketRef.current = socket
      socket.onopen = () => {
        if (cancelled) return
        socket.send(JSON.stringify({ type: 'hello', actor, name: nameRef.current, token: sessionToken }))
        setConnected(true)
        sendActions(actionsRef.current)
        send({ type: 'sync-request' })
      }
      socket.onmessage = event => {
        let message: Record<string, unknown>
        try { message = JSON.parse(event.data) as Record<string, unknown> } catch { return }
        if (message.type === 'welcome' && Array.isArray(message.peers)) {
          setPeers(message.peers.filter((peer): peer is Peer =>
            !!peer && typeof peer === 'object' && typeof peer.id === 'string' && typeof peer.name === 'string'))
        } else if ((message.type === 'peer-joined' || message.type === 'peer-profile') && message.peer && typeof message.peer === 'object') {
          const peer = message.peer as Peer
          if (typeof peer.id === 'string' && typeof peer.name === 'string')
            setPeers(current => [...current.filter(item => item.id !== peer.id), { ...current.find(item => item.id === peer.id), ...peer }])
        } else if (message.type === 'peer-left' && typeof message.id === 'string') {
          setPeers(current => current.filter(item => item.id !== message.id))
        } else if (message.type === 'sync-request' && typeof message.from === 'string') {
          sendActions(actionsRef.current, message.from)
        } else if (message.type === 'actions' && Array.isArray(message.actions)) {
          void merge(message.actions, message.deferRender === true).catch(error => setStorageError(String(error)))
        } else if (message.type === 'api-command' && typeof message.requestId === 'string') {
          const requestId = message.requestId
          void (async () => {
            try {
              if (message.boardId !== undefined && message.boardId !== boardId) throw new Error('Wrong target board')
              await mergeQueue.current
              if (message.operation === 'history') {
                send({ type: 'api-result', requestId, ok: true, actions: actionsRef.current })
              } else if (message.operation === 'undo' || message.operation === 'redo') {
                const changed = await (message.operation === 'undo' ? undo() : redo())
                send({ type: 'api-result', requestId, ok: true, changed })
              } else if (message.operation === 'export') {
                send({ type: 'api-result', requestId, ok: true, export: await renderExport(projectCached(actionsRef.current), (message.options ?? {}) as Record<string, unknown>) })
              } else if (message.operation === 'snapshot') {
                const snapshot = projectCached(actionsRef.current)
                send({ type: 'api-result', requestId, ok: true, graph: {
                  board_id: boardId, name: snapshot.name, ...snapshot.data,
                  action_count: actionsRef.current.length, revision: actionsRef.current.at(-1)?.id ?? null,
                } })
              } else if (message.operation === 'index') {
                const snapshot = projectCached(actionsRef.current).data
                send({ type: 'api-result', requestId, ok: true, index: {
                  entities: snapshot.entities.map(({ id, kind, name, identifiers }) => ({ id, kind, name,
                    identifiers: identifiers.map(({ scheme, namespace, normalized_value }) => ({ scheme, namespace, normalized_value })) })),
                  facts: snapshot.facts.map(({ id, subject_id, predicate, object_id, valid_from, valid_to, participants }) =>
                    ({ id, subject_id, predicate, object_id, valid_from, valid_to, activity: !!participants?.length })),
                  sources: snapshot.sources.map(({ id }) => ({ id })),
                } })
              } else if (message.operation === 'apply' && Array.isArray(message.drafts) &&
                         message.drafts.length <= 200 && message.drafts.every(isDraft)) {
                const accepted = await emitMany(message.drafts, message.deferRender === true)
                send({ type: 'api-result', requestId, ok: true, accepted })
              } else send({ type: 'api-result', requestId, ok: false, error: 'Invalid API request' })
            } catch (error) {
              send({ type: 'api-result', requestId, ok: false, error: String(error) })
            }
          })()
        }
      }
      socket.onclose = () => {
        if (cancelled) return
        setConnected(false)
        setPeers([])
        retry = window.setTimeout(connect, 2000)
      }
    }

    void (async () => {
      try {
        const stored = sortActions(await loadActions(boardId))
        if (cancelled) return
        actionsRef.current = stored
        actionIdsRef.current = new Set(stored.map(item => item.id))
        boardNameRef.current = projectCached(stored).name
        clockRef.current = stored.reduce((max, item) => Math.max(max, item.clock), 0)
        setActions(stored)
        await touchBoard(boardId, boardNameRef.current)
        setBoards(await listBoards())
        setReady(true)
        connect()
      } catch (error) {
        if (!cancelled) setStorageError(`Browser storage unavailable: ${String(error)}`)
      }
    })()
    return () => {
      cancelled = true
      if (retry) window.clearTimeout(retry)
      if (flushTimer.current) window.clearTimeout(flushTimer.current)
      websocket?.close()
      socketRef.current = null
    }
  }, [actor, boardId, emitMany, merge, projectCached, send, sendActions, sessionToken, undo, redo])

  return { actor, name, setName, actions, boards, peers, ready, connected, storageError,
    boardName: projection.name, data: projection.data, emit, emitMany, undo, redo, importActions, sessionToken }
}
