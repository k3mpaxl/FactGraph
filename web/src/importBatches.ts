import type { ActionDraft } from './board'

/**
 * Change batches of this tab's own file uploads. The server marks every upload to /imports/file as channel "Import", but
 * the board token that authorises it is also the agents' token: only the tab that started an upload knows its batch.
 */
export const ownImportBatches = new Set<string>()

/** Rows that arrive as a file import this tab did not start were sent by an agent (or a script): treat them as REST. */
export function trustedDrafts(drafts: ActionDraft[]): ActionDraft[] {
  return drafts.map(draft => draft.channel === 'Import' && !(draft.batch_id && ownImportBatches.has(draft.batch_id)) ? { ...draft, channel: 'REST' } : draft)
}
