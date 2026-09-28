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
  for (const action of actions) await transaction.objectStore('actions').put(action)
  await transaction.objectStore('boards').put({ id: boardId, name, updatedAt: new Date().toISOString() })
  await transaction.done
}

export async function touchBoard(boardId: string, name: string) {
  const db = await database
  const current = await db.get('boards', boardId)
  if (!current) await db.put('boards', { id: boardId, name, updatedAt: new Date().toISOString() })
}

export async function listBoards(): Promise<BoardMeta[]> {
  return (await (await database).getAll('boards')).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}
