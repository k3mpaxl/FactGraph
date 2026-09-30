/**
 * Canvas wheel handling: mouse wheels zoom, trackpad two-finger scrolling pans, trackpad pinch zooms.
 *
 * Browsers do not say whether a wheel event comes from a mouse or a trackpad, so this uses the usual signals:
 * - pinch gestures arrive as wheel events with ctrlKey (Chrome, Edge, Firefox; Safari sends gesture events instead),
 * - line/page based deltas (deltaMode 1/2) only come from mouse wheels,
 * - a horizontal component or fine-grained pixel deltas come from trackpads,
 * - Chrome/Safari report trackpad deltas with wheelDeltaY === -3 × deltaY, mouse notches in steps of 120.
 * Inertial trackpad scrolling keeps the pan classification for a short time so momentum never turns into zooming.
 */
export type WheelKind = 'pinch' | 'pan' | 'zoom'
export type WheelLike = { deltaX: number; deltaY: number; deltaMode: number; ctrlKey: boolean; shiftKey?: boolean; wheelDeltaY?: number; timeStamp?: number }

export function classifyWheel(event: WheelLike): WheelKind {
  if (event.ctrlKey) return 'pinch'
  if (event.deltaMode !== 0) return 'zoom'
  if (event.deltaX !== 0) return 'pan'
  const legacy = event.wheelDeltaY
  if (typeof legacy === 'number' && legacy !== 0) return legacy === -3 * event.deltaY ? 'pan' : 'zoom'
  return Number.isInteger(event.deltaY) && Math.abs(event.deltaY) >= 50 ? 'zoom' : 'pan'
}

/** Remembers a trackpad scroll so momentum events that look like mouse notches keep panning. */
export function createWheelClassifier(stickyMs = 300) {
  let lastPan = -Infinity
  return (event: WheelLike): WheelKind => {
    const now = event.timeStamp ?? Date.now()
    let kind = classifyWheel(event)
    if (kind === 'zoom' && now - lastPan < stickyMs && event.deltaMode === 0) kind = 'pan'
    if (kind === 'pan') lastPan = now
    return kind
  }
}

/** Same zoom speed as d3-zoom (React Flow's default), so mouse zooming feels unchanged. */
export function zoomFactor(event: WheelLike) {
  const delta = -event.deltaY * (event.deltaMode === 1 ? 0.05 : event.deltaMode ? 1 : 0.002) * (event.ctrlKey ? 10 : 1)
  return Math.pow(2, delta)
}

export type Viewport = { x: number; y: number; zoom: number }
/** Zoom around a point (canvas-relative pixels) so the content under the cursor stays in place. */
export function zoomAround(viewport: Viewport, point: { x: number; y: number }, factor: number, minZoom: number, maxZoom: number): Viewport {
  const zoom = Math.min(maxZoom, Math.max(minZoom, viewport.zoom * factor))
  const ratio = zoom / viewport.zoom
  return { x: point.x - (point.x - viewport.x) * ratio, y: point.y - (point.y - viewport.y) * ratio, zoom }
}
