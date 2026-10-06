import { uuid } from './uuid'

/**
 * A duplicated browser tab inherits sessionStorage, and with it the actor ID and session token of the original tab. Two
 * tabs with one actor make the relay replace one socket with the other in turn, and their actions share one identity.
 * Tabs that hold an actor answer a probe on a BroadcastChannel, so a duplicate takes a fresh identity before it connects.
 */
const instance = uuid()
const held = new Set<string>()
let channel: BroadcastChannel | null | undefined

function open(): BroadcastChannel | null {
  if (channel !== undefined) return channel
  channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel('factgraph-identity')
  channel?.addEventListener('message', event => {
    const message = event.data as { type?: string; actor?: string; instance?: string }
    if (message?.type === 'probe' && message.actor && held.has(message.actor) && message.instance !== instance)
      channel!.postMessage({ type: 'taken', actor: message.actor, to: message.instance })
  })
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
