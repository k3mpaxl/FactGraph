import { organicLayout, type LayoutEdge, type LayoutNode } from './organicLayout'

export class LayoutCancelled extends Error {}

/**
 * The organic layout in a Web Worker: pan, zoom and clicks stay responsive while it runs (about 2.6 s for 1,100
 * nodes). Aborting terminates the worker, so nothing half-done is returned. Without Worker support it runs inline.
 */
export function organicLayoutAsync(nodes: LayoutNode[], edges: LayoutEdge[], options: { onProgress?: (done: number, total: number) => void; signal?: AbortSignal } = {}) {
  if (typeof Worker === 'undefined') return Promise.resolve(organicLayout(nodes, edges, 320, options.onProgress))
  return new Promise<Map<string, { x: number; y: number }>>((resolve, reject) => {
    const worker = new Worker(new URL('./layoutWorker.ts', import.meta.url), { type: 'module' })
    const stop = () => { worker.terminate(); reject(new LayoutCancelled('Layout cancelled')) }
    if (options.signal?.aborted) { stop(); return }
    options.signal?.addEventListener('abort', stop, { once: true })
    worker.onmessage = (event: MessageEvent<{ type: 'progress'; done: number; total: number } | { type: 'done'; positions: [string, { x: number; y: number }][] }>) => {
      if (event.data.type === 'progress') { options.onProgress?.(event.data.done, event.data.total); return }
      options.signal?.removeEventListener('abort', stop)
      worker.terminate()
      resolve(new Map(event.data.positions))
    }
    worker.onerror = event => { options.signal?.removeEventListener('abort', stop); worker.terminate(); reject(new Error(event.message || 'Layout failed')) }
    worker.postMessage({ nodes, edges })
  })
}
