import { openDB, type DBSchema } from 'idb'
import type { BoardAction } from './board'

export type BoardMeta = { id: string; name: string; updatedAt: string }

interface FactGraphDB extends DBSchema {
  actions: {
    key: [string, string];
    value: BoardAction;
    indexes: { byBoard: string };
  };
  boards: { key: string; value: BoardMeta };
}

const database = openDB<FactGraphDB>('factgraph-browser', 1, {
  upgrade(db) {
    const actions = db.createObjectStore('actions', { keyPath: ['boardId', 'id'] })
    actions.createIndex('byBoard', 'boardId')
    db.createObjectStore('boards', { keyPath: 'id' })
  },
})

export async function loadActions(boardId: string) {
  return (await database).getAllFromIndex('actions', 'byBoard', boardId)
}

export async function saveActions(boardId: string, actions: BoardAction[], name: string) {
  const db = await database
  const transaction = db.transaction(['actions', 'boards'], 'readwrite')
  // All writes issued at once in one transaction; awaiting each put serialises tens of thousands of round trips.
  const store = transaction.objectStore('actions')
  const writes: Promise<unknown>[] = actions.map(action => store.put(action))
  writes.push(transaction.objectStore('boards').put({ id: boardId, name, updatedAt: new Date().toISOString() }))
  await Promise.all([...writes, transaction.done])
}

export async function touchBoard(boardId: string, name: string) {
  const db = await database
  const current = await db.get('boards', boardId)
  if (!current) await db.put('boards', { id: boardId, name, updatedAt: new Date().toISOString() })
}

export async function listBoards(): Promise<BoardMeta[]> {
  return (await (await database).getAll('boards')).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

/**
 * Remove a board from this browser: its actions, its entry in the board list and what the browser remembers about it
 * (view, notifications, identity). Colleagues keep their copies; opening the link again fetches it from them.
 */
export async function deleteBoard(boardId: string) {
  const db = await database
  const transaction = db.transaction(['actions', 'boards'], 'readwrite')
  const actions = transaction.objectStore('actions')
  let cursor = await actions.index('byBoard').openKeyCursor(IDBKeyRange.only(boardId))
  while (cursor) { void actions.delete(cursor.primaryKey); cursor = await cursor.continue() }
  await transaction.objectStore('boards').delete(boardId)
  await transaction.done
  for (const key of [`factgraph:view:${boardId}`, `factgraph:notifications:${boardId}`]) try { localStorage.removeItem(key) } catch { /* private mode */ }
  for (const key of [`factgraph:actor:${boardId}`, `factgraph:sessionToken:${boardId}`]) try { sessionStorage.removeItem(key) } catch { /* private mode */ }
}
