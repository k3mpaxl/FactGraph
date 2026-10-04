import { organicLayout, type LayoutEdge, type LayoutNode } from './organicLayout'

/** Runs the organic layout off the UI thread; posts progress and finally the positions. */
const scope = self as unknown as { postMessage(message: unknown): void; onmessage: ((event: MessageEvent<{ nodes: LayoutNode[]; edges: LayoutEdge[] }>) => void) | null }
scope.onmessage = event => {
  const positions = organicLayout(event.data.nodes, event.data.edges, 320, (done, total) => scope.postMessage({ type: 'progress', done, total }))
  scope.postMessage({ type: 'done', positions: [...positions] })
}
