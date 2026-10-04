import { LAYER_IDS } from './layers'
import type { TruthState } from './types'

/**
 * The analyst's own view of a board: status filter, layers, evidence time window, selection and zoom. Stored per board
 * in this browser only and never synced, so colleagues keep their own view while the board itself stays in sync.
 */
export type SavedLens = { layers: string[] | null; collapseActivities: boolean; showLanes: boolean }
export type SavedView = {
  stateFilter: TruthState | 'all'
  lens: SavedLens
  from: string; to: string; includeUndated: boolean; showTime: boolean
  selection: { kind: 'entity' | 'fact' | 'group'; id: string } | null
  viewport: { x: number; y: number; zoom: number } | null
}

const STATES = ['all', 'supported', 'disputed', 'refuted', 'unknown']
const key = (boardId: string) => `factgraph:view:${boardId}`
const LEGACY_LENS = 'factgraph:lens'
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const text = (v: unknown) => typeof v === 'string' && v.length <= 64 ? v : ''

function parseLens(raw: unknown): SavedLens {
  const value = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  return {
    layers: Array.isArray(value.layers) ? value.layers.filter((l): l is string => typeof l === 'string' && LAYER_IDS.includes(l)) : null,
    collapseActivities: value.collapseActivities === true, showLanes: value.showLanes === true,
  }
}

/** Tolerant parse: unknown or malformed fields fall back to defaults, so an old or edited entry never breaks the board. */
export function parseView(raw: string | null, fallbackLens: string | null = null): SavedView {
  let value: Record<string, unknown> = {}
  try { const parsed = raw ? JSON.parse(raw) : null; if (parsed && typeof parsed === 'object') value = parsed } catch { /* defaults */ }
  let legacy: unknown = null
  try { legacy = fallbackLens ? JSON.parse(fallbackLens) : null } catch { /* ignore */ }
  const s = value.selection as Record<string, unknown> | undefined
  const v = value.viewport as Record<string, unknown> | undefined
  return {
    stateFilter: STATES.includes(String(value.stateFilter)) ? value.stateFilter as SavedView['stateFilter'] : 'all',
    // Boards without a saved view start with the lens that used to be global for all boards.
    lens: parseLens(value.lens ?? legacy),
    from: text(value.from), to: text(value.to),
    includeUndated: value.includeUndated !== false, showTime: value.showTime === true,
    selection: s && ['entity', 'fact', 'group'].includes(String(s.kind)) && typeof s.id === 'string' ? { kind: s.kind as 'entity' | 'fact' | 'group', id: s.id } : null,
    viewport: v && finite(v.x) && finite(v.y) && finite(v.zoom) && v.zoom > 0 ? { x: v.x, y: v.y, zoom: v.zoom } : null,
  }
}

export function loadView(boardId: string): SavedView {
  try { return parseView(localStorage.getItem(key(boardId)), localStorage.getItem(LEGACY_LENS)) } catch { return parseView(null) }
}

export function saveView(boardId: string, view: SavedView) {
  try { localStorage.setItem(key(boardId), JSON.stringify(view)) } catch { /* private mode: the view is just not remembered */ }
}

export const defaultView = (): SavedView => parseView(null)
