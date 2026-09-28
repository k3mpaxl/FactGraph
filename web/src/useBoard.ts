import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { type ActionDraft, type BoardAction, isAction, isDraft, project, sortActions } from './board'
import { listBoards, loadActions, saveActions, touchBoard, type BoardMeta } from './store'
import { uuid } from './uuid'

export type Peer = { id: string; name: string }

function initialName(actor: string) {
  try { return localStorage.getItem('factgraph:displayName') || `Gast ${actor.slice(0, 4)}` }
  catch { return `Gast ${actor.slice(0, 4)}` }
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

export function useBoard(boardId: string) {
  const actor = useRef(uuid()).current
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
  const mergeQueue = useRef<Promise<unknown>>(Promise.resolve())
  const flushTimer = useRef<number | undefined>(undefined)
  const projection = useMemo(() => project(boardId, actions), [boardId, actions])

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
      const boardName = fresh.some(item => item.type === 'board.rename') ? project(boardId, next).name : boardNameRef.current
      await saveActions(boardId, fresh, boardName)
      for (const item of fresh) actionIdsRef.current.add(item.id)
      actionsRef.current = next
      boardNameRef.current = boardName
      clockRef.current = Math.max(clockRef.current, ...fresh.map(item => item.clock))
      if (flushTimer.current) window.clearTimeout(flushTimer.current)
      if (deferRender) flushTimer.current = window.setTimeout(() => setActions(actionsRef.current), 1000)
      else setActions(next)
      setBoards(await listBoards())
      return fresh.length
    })
    mergeQueue.current = work.catch(error => { setStorageError(String(error)) })
    return work
  }, [boardId])

  const emitMany = useCallback(async (drafts: ActionDraft[], deferRender = false) => {
    const created = drafts.map(draft => ({
      boardId, id: draft.id ?? uuid(), actor, author: draft.author ?? nameRef.current,
      clock: ++clockRef.current, at: draft.at ?? new Date().toISOString(),
      type: draft.type, payload: draft.payload,
    } satisfies BoardAction))
    const accepted = await merge(created, deferRender)
    sendActions(created, undefined, deferRender)
    return accepted
  }, [actor, boardId, merge, sendActions])

  const emit = useCallback((type: ActionDraft['type'], payload: Record<string, unknown>) =>
    emitMany([{ type, payload }]), [emitMany])

  const undo = useCallback(async () => {
    const alreadyUndone = new Set(actionsRef.current.filter(item => item.type === 'action.undo')
      .map(item => item.payload.action_id).filter((id): id is string => typeof id === 'string'))
    const target = [...actionsRef.current].reverse().find(item =>
      item.actor === actor && item.type !== 'action.undo' && !alreadyUndone.has(item.id))
    if (!target) return false
    await emit('action.undo', { action_id: target.id })
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
      websocket = new WebSocket(`${scheme}//${window.location.host}/ws/boards/${boardId}?actor=${actor}&name=${encodeURIComponent(nameRef.current)}&token=${encodeURIComponent(sessionToken)}`)
      socketRef.current = websocket
      websocket.onopen = () => {
        if (cancelled) return
        setConnected(true)
        sendActions(actionsRef.current)
        send({ type: 'sync-request' })
      }
      websocket.onmessage = event => {
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
              if (message.boardId !== undefined && message.boardId !== boardId) throw new Error('Falsches Zielboard')
              await mergeQueue.current
              if (message.operation === 'snapshot') {
                const snapshot = project(boardId, actionsRef.current)
                send({ type: 'api-result', requestId, ok: true, graph: {
                  board_id: boardId, name: snapshot.name, ...snapshot.data,
                  action_count: actionsRef.current.length,
                } })
              } else if (message.operation === 'index') {
                const snapshot = project(boardId, actionsRef.current).data
                send({ type: 'api-result', requestId, ok: true, index: {
                  entities: snapshot.entities.map(({ id, kind, name }) => ({ id, kind, name })),
                  facts: snapshot.facts.map(({ id, subject_id, predicate, object_id, valid_from, valid_to }) =>
                    ({ id, subject_id, predicate, object_id, valid_from, valid_to })),
                  sources: snapshot.sources.map(({ id }) => ({ id })),
                } })
              } else if (message.operation === 'apply' && Array.isArray(message.drafts) &&
                         message.drafts.length <= 200 && message.drafts.every(isDraft)) {
                const accepted = await emitMany(message.drafts, message.deferRender === true)
                send({ type: 'api-result', requestId, ok: true, accepted })
              } else send({ type: 'api-result', requestId, ok: false, error: 'Ungültiger API-Auftrag' })
            } catch (error) {
              send({ type: 'api-result', requestId, ok: false, error: String(error) })
            }
          })()
        }
      }
      websocket.onclose = () => {
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
        boardNameRef.current = project(boardId, stored).name
        clockRef.current = Math.max(0, ...stored.map(item => item.clock))
        setActions(stored)
        await touchBoard(boardId, project(boardId, stored).name)
        setBoards(await listBoards())
        setReady(true)
        connect()
      } catch (error) {
        if (!cancelled) setStorageError(`Browser-Speicher nicht verfügbar: ${String(error)}`)
      }
    })()
    return () => {
      cancelled = true
      if (retry) window.clearTimeout(retry)
      if (flushTimer.current) window.clearTimeout(flushTimer.current)
      websocket?.close()
      socketRef.current = null
    }
  }, [actor, boardId, emitMany, merge, send, sendActions, sessionToken])

  return { actor, name, setName, actions, boards, peers, ready, connected, storageError,
    boardName: projection.name, data: projection.data, emit, emitMany, undo, importActions, sessionToken }
}
