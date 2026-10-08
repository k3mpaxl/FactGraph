import { uuid } from './uuid'

/**
 * A duplicated browser tab inherits sessionStorage, and with it the actor ID and board token of the original tab. Two
 * tabs with one actor make the relay replace one socket with the other in turn, and their actions share one identity.
 * Tabs that hold an actor answer a probe on a BroadcastChannel, so a duplicate takes a fresh identity before it connects.
 */
const instance = uuid()
const held = new Set<string>()
/** Boards open in this tab, so other tabs can tell how often a board is open in this browser (see otherTabs). */
const boards = new Map<string, number>()
const boardListeners = new Set<(boardId: string) => void>()
let leaving = false
let channel: BroadcastChannel | null | undefined

function open(): BroadcastChannel | null {
  if (channel !== undefined) return channel
  channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel('factgraph-identity')
  channel?.addEventListener('message', event => {
    const message = event.data as { type?: string; actor?: string; instance?: string; board?: string }
    if (message?.type === 'probe' && message.actor && held.has(message.actor) && message.instance !== instance)
      channel!.postMessage({ type: 'taken', actor: message.actor, to: message.instance })
    if (message?.type === 'board-probe' && message.board && boards.has(message.board) && !leaving && message.instance !== instance)
      channel!.postMessage({ type: 'board-here', board: message.board, to: message.instance, from: instance })
    if (message?.type === 'board-changed' && message.board) boardListeners.forEach(listener => listener(message.board!))
  })
  // A closed tab never unmounts its board: it stops answering and lets the others count again.
  if (channel && typeof window !== 'undefined') {
    const changed = () => boards.forEach((_, board) => channel!.postMessage({ type: 'board-changed', board }))
    window.addEventListener('pagehide', () => { leaving = true; changed() })
    window.addEventListener('pageshow', event => { if (event.persisted) { leaving = false; changed() } })
  }
  return channel
}

/** true when another open tab already uses this actor (answers within `wait` ms). */
export function actorTaken(actor: string, wait = 150): Promise<boolean> {
  const bus = open()
  if (!bus || held.has(actor)) return Promise.resolve(false)
  return new Promise(resolve => {
    const listener = (event: MessageEvent) => {
      const message = event.data as { type?: string; actor?: string; to?: string }
      if (message?.type === 'taken' && message.actor === actor && message.to === instance) done(true)
    }
    const done = (taken: boolean) => { bus.removeEventListener('message', listener); window.clearTimeout(timer); resolve(taken) }
    const timer = window.setTimeout(() => done(false), wait)
    bus.addEventListener('message', listener)
    bus.postMessage({ type: 'probe', actor, instance })
  })
}

/** This tab uses the actor from now on: later duplicates are told so. */
export function holdActor(actor: string) { open(); held.add(actor) }
export function releaseActor(actor: string) { held.delete(actor) }

/** This tab shows the board: other tabs with it count this one. */
export function holdBoard(boardId: string) {
  boards.set(boardId, (boards.get(boardId) ?? 0) + 1)
  open()?.postMessage({ type: 'board-changed', board: boardId })
}
export function releaseBoard(boardId: string) {
  const count = (boards.get(boardId) ?? 1) - 1
  if (count > 0) boards.set(boardId, count); else boards.delete(boardId)
  open()?.postMessage({ type: 'board-changed', board: boardId })
}

/**
 * How many other tabs of this browser show the board (they answer within `wait` ms). Each tab loads, stores and syncs
 * the whole board, which with a large board makes them all slow.
 */
export function otherTabs(boardId: string, wait = 200): Promise<number> {
  const bus = open()
  if (!bus) return Promise.resolve(0)
  return new Promise(resolve => {
    const seen = new Set<string>()
    const listener = (event: MessageEvent) => {
      const message = event.data as { type?: string; board?: string; to?: string; from?: string }
      if (message?.type === 'board-here' && message.board === boardId && message.to === instance && message.from) seen.add(message.from)
    }
    bus.addEventListener('message', listener)
    bus.postMessage({ type: 'board-probe', board: boardId, instance })
    window.setTimeout(() => { bus.removeEventListener('message', listener); resolve(seen.size) }, wait)
  })
}

/** Calls the listener with a board's ID when a tab opens or closes it. */
export function onBoardTabs(listener: (boardId: string) => void) {
  open()
  boardListeners.add(listener)
  return () => { boardListeners.delete(listener) }
}

const actorKey = (boardId: string) => `factgraph:actor:${boardId}`
const tokenKey = (boardId: string) => `factgraph:sessionToken:${boardId}`
const newToken = () => `${uuid()}${uuid()}`.replaceAll('-', '')

/** The identity of this tab for a board: kept for reloads (sessionStorage), new for a new tab. */
export function storedIdentity(boardId: string): { actor: string; token: string } {
  try {
    const actor = sessionStorage.getItem(actorKey(boardId)) || uuid()
    const token = sessionStorage.getItem(tokenKey(boardId)) || newToken()
    sessionStorage.setItem(actorKey(boardId), actor); sessionStorage.setItem(tokenKey(boardId), token)
    return { actor, token }
  } catch { return { actor: uuid(), token: newToken() } }
}

/** A fresh actor and token for this tab (a duplicate, or a tab replaced by one). */
export function freshIdentity(boardId: string): { actor: string; token: string } {
  const next = { actor: uuid(), token: newToken() }
  try { sessionStorage.setItem(actorKey(boardId), next.actor); sessionStorage.setItem(tokenKey(boardId), next.token) } catch { /* private mode */ }
  return next
}
