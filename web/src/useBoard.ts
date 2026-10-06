import { impactReport } from './hunting'
import { analyzeImpact, exportMarks } from './impact'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { type ActionDraft, type BoardAction, type UndoScope, isAction, isDraft, participantKey, project, redoTarget, sortActions, undoTargets } from './board'
import { listBoards, loadActions, saveActions, touchBoard, type BoardMeta } from './store'
import { placeNew } from './layout'
import { actionChunks, messageParts, queryRecords, COMPRESS_ABOVE, COMPRESSED_RAW_LIMIT, RELAY_LIMIT, gzipText, packFrame, unpackFrame } from './query'
import { uuid } from './uuid'
import { trustedDrafts } from './importBatches'
import { actorTaken, freshIdentity, holdActor, releaseActor, storedIdentity } from './identity'
import { isSummary, summarize, syncPlan } from './sync'
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
  const impact = analyzeImpact(data)
  const result = buildGraphSvg({ nodes: view.nodes, edges: view.edges, entityTypes: data.entity_types ?? [], theme, legend: options.legend !== false, impact: impact.seeds.length ? exportMarks(impact, data.groups ?? []) : null,
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

/** Receives every batch of actions that was newly stored, local or remote (for notifications). */
export type ChangeListener = { current: ((fresh: BoardAction[]) => void) | null }

export function useBoard(boardId: string, listener?: ChangeListener) {
  // Actor and token of this tab; a duplicated tab gets its own before it connects (see identity.ts).
  const [identity, setIdentity] = useState(() => storedIdentity(boardId))
  const { actor, token: sessionToken } = identity
  /** The relay replaced this tab's connection by another tab with the same identity: no automatic reconnect. */
  const [replaced, setReplaced] = useState(false)
  const reidentify = useCallback(() => { setReplaced(false); setIdentity(freshIdentity(boardId)) }, [boardId])
  const [name, setNameState] = useState(() => initialName(actor))
  const nameRef = useRef(name)
  const [actions, setActions] = useState<BoardAction[]>([])
  const [boards, setBoards] = useState<BoardMeta[]>([])
  const [peers, setPeers] = useState<Peer[]>([])
  const [ready, setReady] = useState(false)
  // A fresh browser joining analysts who are online: the board is on its way, not empty.
  const [joining, setJoining] = useState(false)
  const joinTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const syncPrimary = useRef<string | null>(null)
  const syncTimer2 = useRef<number | undefined>(undefined)
  const settleJoin = (delay: number) => { clearTimeout(joinTimer.current); joinTimer.current = setTimeout(() => setJoining(false), delay) }
  const [connected, setConnected] = useState(false)
  const [storageError, setStorageError] = useState('')
  /** Actions too large for the relay: kept in this browser, never shared. */
  const [unsynced, setUnsynced] = useState<string[]>([])
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

  // Messages go out in order; large ones gzip-compressed (the 16 MiB relay limit then applies to the compressed size).
  // Sync progress: changes received but not stored yet, and changes waiting to go out. Shown as "Syncing…".
  const syncCounts = useRef({ incoming: 0, outgoing: 0, peak: 0 })
  const [sync, setSync] = useState<{ incoming: number; outgoing: number; doneAt: number | null; peak: number }>({ incoming: 0, outgoing: 0, doneAt: null, peak: 0 })
  const syncTimer = useRef<number | undefined>(undefined)
  const reportSync = useCallback(() => {
    if (syncTimer.current) return
    syncTimer.current = window.setTimeout(() => {
      syncTimer.current = undefined
      const counts = syncCounts.current, pending = counts.incoming + counts.outgoing
      counts.peak = Math.max(counts.peak, pending)
      const peak = counts.peak
      if (!pending) counts.peak = 0
      setSync(current => ({ incoming: counts.incoming, outgoing: counts.outgoing, peak, doneAt: !pending && (current.incoming || current.outgoing) ? Date.now() : current.doneAt }))
    }, 250)
  }, [])
  const sendQueue = useRef<Promise<void>>(Promise.resolve())
  const send = useCallback((message: object, onTooLarge?: () => void) => {
    const text = JSON.stringify(message)
    const count = Array.isArray((message as { actions?: unknown[] }).actions) ? (message as { actions: unknown[] }).actions.length : 0
    if (count) { syncCounts.current.outgoing += count; reportSync() }
    const done = () => { if (count) { syncCounts.current.outgoing -= count; reportSync() } }
    sendQueue.current = sendQueue.current.then(async () => {
      if (socketRef.current?.readyState !== WebSocket.OPEN) return
      if (text.length > COMPRESS_ABOVE) {
        const packed = await gzipText(text)
        if (packed) {
          if (packed.byteLength > RELAY_LIMIT) { onTooLarge?.(); return }
          const { type, target, deferRender } = message as Record<string, unknown>
          if (socketRef.current?.readyState === WebSocket.OPEN) socketRef.current.send(packFrame({ type, ...(target ? { target } : {}), deferRender: deferRender === true }, packed))
          return
        }
      }
      socketRef.current.send(text)
    }).catch(() => {}).finally(done)
  }, [reportSync])

  const sendActions = useCallback((items: BoardAction[], target?: string, deferRender = false, syncDone = false) => {
    // By count and by size: a few actions with large source excerpts must not form one message above the relay limit.
    const tooLarge: BoardAction[] = []
    const markUnsynced = (list: BoardAction[]) => setUnsynced(current => { const ids = new Set([...current, ...list.map(a => a.id)]); return ids.size === current.length ? current : [...ids] })
    const chunks = actionChunks(items, 100, 4_000_000, tooLarge, typeof CompressionStream === 'undefined' ? RELAY_LIMIT : COMPRESSED_RAW_LIMIT)
    if (tooLarge.length) markUnsynced(tooLarge)
    // The answer to a sync request ends with syncDone (also when nothing was missing), so the requester knows it has all.
    if (syncDone && !chunks.length) chunks.push([])
    chunks.forEach((chunk, index) => send({ type: 'actions', actions: chunk,
      deferRender: deferRender || index < chunks.length - 1,
      ...(target ? { target } : {}), ...(syncDone && index === chunks.length - 1 ? { syncDone: true, responder: actor } : {}) }, () => markUnsynced(chunk)))
  }, [send, actor])
  // Replies to REST/MCP commands; large ones go in parts that the server reassembles.
  const reply = useCallback((requestId: string, payload: Record<string, unknown>) => {
    const socket = socketRef.current
    if (socket?.readyState !== WebSocket.OPEN) return
    for (const part of messageParts(requestId, payload)) socket.send(part)
  }, [])

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
    // Known action IDs are skipped, and so is a repeat within the batch (stable import IDs of an identical row).
    const inBatch = new Set<string>()
    const freshDrafts = placeNew(drafts.filter(draft => !draft.id || (!actionIdsRef.current.has(draft.id) && !inBatch.has(draft.id) && !!inBatch.add(draft.id))),
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

  // Analyst (UI) and agents (REST/MCP) undo their own batches only; the undo action carries the same channel.
  const undo = useCallback(async (scope: UndoScope = 'analyst') => {
    const targets = undoTargets(actionsRef.current, actor, scope)
    if (!targets) return false
    await emitMany([{ type: 'action.undo', payload: { action_ids: targets.map(item => item.id) }, channel: scope === 'agent' ? 'REST' : 'UI' }])
    return true
  }, [actor, emitMany])

  const redo = useCallback(async (scope: UndoScope = 'analyst') => {
    const target = redoTarget(actionsRef.current, actor, scope)
    if (!target) return false
    await emitMany([{ type: 'action.redo', payload: target.payload, channel: scope === 'agent' ? 'REST' : 'UI' }])
    return true
  }, [actor, emitMany])

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

    const requestSync = (target?: string, reply = false) => send({ type: 'sync-request', summary: summarize(actionsRef.current), ...(target ? { target } : {}), ...(reply ? { reply: true } : {}) })
    // The first peer has answered (or did not in time): ask everyone for what only they have; their answers are small.
    const finishPrimary = () => {
      if (!syncPrimary.current) return
      syncPrimary.current = null
      window.clearTimeout(syncTimer2.current)
      settleJoin(300)
      requestSync()
    }
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
        // Syncing starts with the welcome (who is online), with summaries instead of the whole log.
      }
      socket.binaryType = 'arraybuffer'
      socket.onmessage = event => {
        // Large batches arrive as compressed binary frames (forwarded unchanged by the relay).
        if (event.data instanceof ArrayBuffer) { void unpackFrame(event.data).then(message => { if (message && socketRef.current === socket) handle(message) }); return }
        let message: Record<string, unknown>
        try { message = JSON.parse(event.data) as Record<string, unknown> } catch { return }
        handle(message)
      }
      const handle = (message: Record<string, unknown>) => {
        if (message.type === 'welcome' && Array.isArray(message.peers)) {
          const others = message.peers.filter((peer): peer is Peer => !!peer && typeof peer === 'object' && typeof (peer as Peer).id === 'string' && (peer as Peer).id !== actor)
          if (!actionsRef.current.length && others.length) { setJoining(true); settleJoin(15000) }
          // First one peer (it answers with what is missing here), then the others for what only they have.
          if (others.length) {
            syncPrimary.current = others[0].id
            requestSync(others[0].id)
            window.clearTimeout(syncTimer2.current)
            syncTimer2.current = window.setTimeout(finishPrimary, 15000)
          }
          setPeers(message.peers.filter((peer): peer is Peer =>
            !!peer && typeof peer === 'object' && typeof peer.id === 'string' && typeof peer.name === 'string'))
        } else if ((message.type === 'peer-joined' || message.type === 'peer-profile') && message.peer && typeof message.peer === 'object') {
          const peer = message.peer as Peer
          if (typeof peer.id === 'string' && typeof peer.name === 'string')
            setPeers(current => [...current.filter(item => item.id !== peer.id), { ...current.find(item => item.id === peer.id), ...peer }])
        } else if (message.type === 'peer-left' && typeof message.id === 'string') {
          setPeers(current => current.filter(item => item.id !== message.id))
          if (message.id === syncPrimary.current) finishPrimary()
        } else if (message.type === 'sync-request' && typeof message.from === 'string') {
          const { send: missing, askBack } = syncPlan(actionsRef.current, isSummary(message.summary) ? message.summary : null)
          sendActions(missing, message.from, false, true)
          // The requester holds something this browser lacks (offline changes): ask it back once, never in a loop.
          if (askBack && message.reply !== true) requestSync(message.from, true)
        } else if (message.type === 'actions' && Array.isArray(message.actions)) {
          const incoming = message.actions.length
          syncCounts.current.incoming += incoming; reportSync()
          const responder = typeof message.from === 'string' ? message.from : typeof message.responder === 'string' ? message.responder : null
          const done = message.syncDone === true && !!responder && responder === syncPrimary.current
          void merge(message.actions, message.deferRender === true).catch(error => setStorageError(String(error)))
            .finally(() => { syncCounts.current.incoming -= incoming; reportSync(); if (done) finishPrimary(); else settleJoin(1500) })
        } else if (message.type === 'api-command' && typeof message.requestId === 'string') {
          const requestId = message.requestId
          void (async () => {
            try {
              if (message.boardId !== undefined && message.boardId !== boardId) throw new Error('Wrong target board')
              await mergeQueue.current
              if (message.operation === 'history') {
                const all = actionsRef.current
                const offset = Math.max(0, Number(message.offset ?? 0)), limit = message.limit === undefined ? all.length : Math.max(1, Number(message.limit))
                reply(requestId, { ok: true, actions: all.slice(offset, offset + limit), total: all.length })
              } else if (message.operation === 'undo' || message.operation === 'redo') {
                const changed = await (message.operation === 'undo' ? undo('agent') : redo('agent'))
                reply(requestId, { ok: true, changed })
              } else if (message.operation === 'export') {
                reply(requestId, { ok: true, export: await renderExport(projectCached(actionsRef.current), (message.options ?? {}) as Record<string, unknown>) })
              } else if (message.operation === 'snapshot') {
                const snapshot = projectCached(actionsRef.current)
                reply(requestId, { ok: true, graph: {
                  board_id: boardId, name: snapshot.name, ...snapshot.data,
                  action_count: actionsRef.current.length, revision: actionsRef.current.at(-1)?.id ?? null,
                } })
              } else if (message.operation === 'impact') {
                reply(requestId, { ok: true, impact: impactReport(projectCached(actionsRef.current).data) })
              } else if (message.operation === 'query') {
                const result = queryRecords(projectCached(actionsRef.current).data, { collection: String(message.collection ?? ''),
                  q: typeof message.q === 'string' ? message.q : '', offset: Number(message.offset ?? 0), limit: Number(message.limit ?? 100),
                  id: typeof message.id === 'string' ? message.id : undefined, entity_id: typeof message.entity_id === 'string' ? message.entity_id : undefined })
                reply(requestId, { ok: true, ...result, revision: actionsRef.current.at(-1)?.id ?? null })
              } else if (message.operation === 'index') {
                const snapshot = projectCached(actionsRef.current).data
                reply(requestId, { ok: true, index: {
                  entities: snapshot.entities.map(({ id, kind, name, identifiers }) => ({ id, kind, name,
                    identifiers: identifiers.map(({ scheme, namespace, normalized_value }) => ({ scheme, namespace, normalized_value })) })),
                  facts: snapshot.facts.map(({ id, subject_id, predicate, object_id, valid_from, valid_to, participants }) =>
                    ({ id, subject_id, predicate, object_id, valid_from, valid_to, activity: !!participants?.length,
                      ...(participants?.length ? { participants_key: participantKey(participants) } : {}) })),
                  sources: snapshot.sources.map(({ id }) => ({ id })),
                } })
              } else if (message.operation === 'apply' && Array.isArray(message.drafts) &&
                         message.drafts.length <= 200 && message.drafts.every(isDraft)) {
                const accepted = await emitMany(trustedDrafts(message.drafts), message.deferRender === true)
                reply(requestId, { ok: true, accepted })
              } else reply(requestId, { ok: false, error: 'Invalid API request' })
            } catch (error) {
              reply(requestId, { ok: false, error: String(error) })
            }
          })()
        }
      }
      socket.onclose = event => {
        if (cancelled || socketRef.current !== socket) return
        setConnected(false)
        setPeers([])
        // Another tab connected with this identity: reconnecting would push it out again, and so on every 2 s.
        if (event.code === 4001) { setReplaced(true); return }
        retry = window.setTimeout(connect, 2000)
      }
    }

    void (async () => {
      try {
        const [loaded, taken] = await Promise.all([loadActions(boardId), actorTaken(actor)])
        if (cancelled) return
        if (taken) { setIdentity(freshIdentity(boardId)); return }
        holdActor(actor)
        const stored = sortActions(loaded)
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
      releaseActor(actor)
      if (retry) window.clearTimeout(retry)
      if (flushTimer.current) window.clearTimeout(flushTimer.current)
      websocket?.close()
      socketRef.current = null
    }
  }, [actor, boardId, emitMany, merge, projectCached, reply, send, sendActions, sessionToken, undo, redo])

  return { actor, name, setName, actions, boards, peers, ready, joining, replaced, reidentify, connected, storageError, unsynced, sync,
    boardName: projection.name, data: projection.data, emit, emitMany, undo, redo, importActions, sessionToken }
}
