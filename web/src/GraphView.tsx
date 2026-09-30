import { memo, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { ReactFlow, ReactFlowProvider, Background, BackgroundVariant, Controls, MiniMap, Handle, Position, BaseEdge, EdgeLabelRenderer,
  useReactFlow, useNodesState, useInternalNode, useStore, type Node, type Edge, type NodeProps, type EdgeProps, type Connection,
  type XYPosition, type InternalNode } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { Box, User, Monitor, KeyRound, Cloud, FileText, Network, Layers, Plus, Search, X, Pin, Sparkles, Copy, ArrowDown,
  Grid3x3, Map as MapIcon, Crosshair, Pencil, Merge, Trash2, PinOff, Settings2 } from 'lucide-react'
import type { Entity, EntityType, Fact, TruthState } from './types'
import type { ActionDraft } from './board'
import { snapPosition } from './layout'
import { entityVisual } from './entityVisual'
import { uuid } from './uuid'

type Selection = { kind: 'entity' | 'fact'; id: string } | null
export type CanvasRequest = { type: 'focus' | 'fit' | 'arrange' | 'place'; id?: string; kind?: string; n: number }
type Props = {
  entityTypes: EntityType[]; entities: Entity[]; facts: Fact[]; selection: Selection; search: string;
  theme: 'light' | 'dark'; request: CanvasRequest | null;
  onSelect: (value: Selection) => void;
  onCommand: (drafts: ActionDraft[]) => Promise<unknown>;
  onEdit: (id: string) => void; onMerge: (id: string) => void;
  onCopy: (value: string, label: string) => void;
}
const builtInKinds = ['User', 'Device', 'IP', 'Service Principal', 'AKS Cluster', 'File', 'Repository', 'Credential', 'Environment Variable', 'Blob Storage']
const typeIcons = { Box, User, Monitor, KeyRound, Cloud, FileText, Network, Layers }
export function KindIcon({ kind, icon, size = 16 }: { kind: string; icon?: string; size?: number }) {
  const Icon = icon && icon in typeIcons ? typeIcons[icon as keyof typeof typeIcons] : /user|person/i.test(kind) ? User : /device|host|system/i.test(kind) ? Monitor : /secret|credential|variable/i.test(kind) ? KeyRound : /file|repo/i.test(kind) ? FileText : /aks/i.test(kind) ? Layers : /\bip\b|network/i.test(kind) ? Network : /cloud|storage|principal/i.test(kind) ? Cloud : Box
  return <Icon size={size} strokeWidth={1.9} />
}

// Callbacks live in a ref so node data stays referentially stable and memoised cards do not re-render on every parent render.
type CardHandlers = { rename: (id: string, name: string) => void; cancelSelect: () => void }
type CardData = { entity: Entity; icon?: string; color: string; dimmed: boolean; match: boolean; handlers: { current: CardHandlers } }
const EntityCard = memo(function EntityCard({ data, selected }: NodeProps<Node<CardData>>) {
  const { entity } = data
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(entity.name)
  useEffect(() => setName(entity.name), [entity.name])
  const hint = entity.identifiers[0]?.raw_value
  return <div className={`entity-node${selected ? ' selected' : ''}${data.dimmed ? ' dimmed' : ''}${data.match ? ' match' : ''}`} style={{ '--entity-color': data.color } as CSSProperties}>
    <Handle type="target" position={Position.Left} id="in" aria-label={`Connect to ${entity.name}`} />
    <div className="node-icon"><KindIcon kind={entity.kind} icon={data.icon} /></div>
    <div className="node-copy">
      {editing ? <form className="nodrag" onSubmit={event => { event.preventDefault(); if (name.trim()) { data.handlers.current.rename(entity.id, name.trim()); setEditing(false) } }}>
        <input autoFocus aria-label="Entity name" value={name} onChange={e => setName(e.target.value)} onBlur={() => { setEditing(false); setName(entity.name) }}
          onKeyDown={e => { if (e.key === 'Escape') { setEditing(false); setName(entity.name); e.stopPropagation() } }} />
      </form> : <strong onDoubleClick={event => { event.stopPropagation(); data.handlers.current.cancelSelect(); setEditing(true) }} title={entity.name}>{entity.name}</strong>}
      <small>{entity.kind}{hint ? <> · <span>{hint}</span></> : null}</small>
    </div>
    {entity.pinned && <Pin className="node-pin" size={12} aria-label="Pinned" />}
    <Handle type="source" position={Position.Right} id="out" aria-label={`Connect from ${entity.name}`} />
  </div>
})

// Floating edges attach to the node border along the line between centres, so edges never loop around cards.
type Box2 = { x: number; y: number; w: number; h: number }
const boxOf = (node: InternalNode): Box2 => {
  const w = node.measured.width ?? 200, h = node.measured.height ?? 56
  return { x: node.internals.positionAbsolute.x + w / 2, y: node.internals.positionAbsolute.y + h / 2, w, h }
}
function borderPoint(from: Box2, toward: { x: number; y: number }, pad = 0) {
  const dx = toward.x - from.x, dy = toward.y - from.y
  if (!dx && !dy) return { x: from.x, y: from.y }
  const scale = Math.min((from.w / 2 + pad) / Math.abs(dx || 1e-9), (from.h / 2 + pad) / Math.abs(dy || 1e-9))
  return { x: from.x + dx * scale, y: from.y + dy * scale }
}
type EdgeData = { state: TruthState; offset: number; dimmed: boolean; onPick: (id: string) => void; onEdit: (id: string) => void }
const FloatingEdge = memo(function FloatingEdge({ id, source, target, label, selected, data }: EdgeProps<Edge<EdgeData>>) {
  const s = useInternalNode(source), t = useInternalNode(target)
  const showLabel = useStore(store => store.transform[2] >= 0.55)
  if (!s || !t || !data) return null
  const a = boxOf(s), b = boxOf(t)
  let path: string, lx: number, ly: number
  if (source === target) {
    const x = a.x + a.w / 2 - 20, y = a.y - a.h / 2
    path = `M ${x} ${y} C ${x + 10} ${y - 60}, ${x + 70} ${y - 30}, ${a.x + a.w / 2} ${a.y - 8}`; lx = x + 36; ly = y - 36
  } else {
    // Parallel relations between the same pair bend apart instead of overlapping.
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1
    const cx = mx + (-(b.y - a.y) / len) * data.offset * 2, cy = my + ((b.x - a.x) / len) * data.offset * 2
    const start = borderPoint(a, data.offset ? { x: cx, y: cy } : b)
    const end = borderPoint(b, data.offset ? { x: cx, y: cy } : a, 3)
    path = data.offset ? `M ${start.x} ${start.y} Q ${cx} ${cy} ${end.x} ${end.y}` : `M ${start.x} ${start.y} L ${end.x} ${end.y}`
    lx = data.offset ? 0.25 * start.x + 0.5 * cx + 0.25 * end.x : (start.x + end.x) / 2
    ly = data.offset ? 0.25 * start.y + 0.5 * cy + 0.25 * end.y : (start.y + end.y) / 2
  }
  return <>
    <BaseEdge id={id} path={path} interactionWidth={16} markerEnd={`url(#fg-arrow-${selected ? 'selected' : data.state})`}
      className={`fg-edge ${data.state}${selected ? ' selected' : ''}${data.dimmed ? ' dimmed' : ''}`} />
    {(showLabel || selected) && label && <EdgeLabelRenderer>
      <button type="button" className={`edge-label nodrag nopan ${data.state}${selected ? ' selected' : ''}${data.dimmed ? ' dimmed' : ''}`}
        style={{ transform: `translate(-50%, -50%) translate(${lx}px, ${ly}px)` }}
        onClick={event => { event.stopPropagation(); data.onPick(id) }} onDoubleClick={event => { event.stopPropagation(); data.onEdit(id) }}>{label}</button>
    </EdgeLabelRenderer>}
  </>
})

const nodeTypes = { entity: EntityCard }
const edgeTypes = { floating: FloatingEdge }
type Draft = { position: XYPosition; source?: string; target?: string; kind: string; name: string; predicate: string; relationId?: string }
const pref = (key: string, fallback: boolean) => { try { const v = localStorage.getItem(`factgraph:${key}`); return v === null ? fallback : v === 'true' } catch { return fallback } }
const savePref = (key: string, value: boolean) => { try { localStorage.setItem(`factgraph:${key}`, String(value)) } catch { /* private mode */ } }

function ArrowDefs() {
  return <svg className="fg-defs" aria-hidden="true"><defs>
    {(['supported', 'disputed', 'refuted', 'unknown', 'selected'] as const).map(state => <marker key={state} id={`fg-arrow-${state}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M 0 0 L 10 5 L 0 10 z" className={`fg-arrow ${state}`} />
    </marker>)}
  </defs></svg>
}

function Canvas(props: Props) {
  const { entities, facts, selection, search, onSelect, onCommand, entityTypes, request } = props
  const flow = useReactFlow<Node<CardData>>()
  const [nodes, setNodes, onNodesChange] = useNodesState<Node<CardData>>([])
  const [palette, setPalette] = useState(false)
  const [typeEdit, setTypeEdit] = useState<EntityType | null>(null)
  const [typeSearch, setTypeSearch] = useState('')
  const [draft, setDraft] = useState<Draft | null>(null)
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [grid, setGrid] = useState(() => pref('snap', true))
  const [minimapPref, setMinimapPref] = useState<boolean | null>(() => { try { const v = localStorage.getItem('factgraph:minimap'); return v === null ? null : v === 'true' } catch { return null } })
  const minimap = minimapPref ?? entities.length > 60
  const setMinimap = (value: boolean) => setMinimapPref(value)
  const pendingFit = useRef(false)
  const [focusMode, setFocusMode] = useState(() => pref('focus', true))
  const far = useStore(store => store.transform[2] < 0.45)
  const fitted = useRef(false)
  const clickTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const cancelSelect = () => { if (clickTimer.current) clearTimeout(clickTimer.current) }
  useEffect(() => () => cancelSelect(), [])
  const run = async (drafts: ActionDraft[]) => { setError(''); try { await onCommand(drafts) } catch (e) { setError(String(e)); throw e } }
  const handlers = useRef<CardHandlers>({ rename: () => {}, cancelSelect })
  handlers.current = { rename: (id, name) => { void run([{ type: 'entity.update', payload: { id, name } }]).catch(() => {}) }, cancelSelect }

  const typeByName = useMemo(() => new Map(entityTypes.map(t => [t.name, t])), [entityTypes])
  // Selecting a node or edge highlights its direct neighbourhood; everything else recedes.
  const focusIds = useMemo(() => {
    if (!focusMode || !selection) return null
    const ids = new Set<string>()
    if (selection.kind === 'entity') {
      ids.add(selection.id)
      for (const f of facts) if (f.subject_id === selection.id || f.object_id === selection.id) { ids.add(f.subject_id); ids.add(f.object_id) }
    } else {
      const fact = facts.find(f => f.id === selection.id)
      if (fact) { ids.add(fact.subject_id); ids.add(fact.object_id) }
    }
    return ids
  }, [focusMode, selection, facts])
  const needle = search.trim().toLowerCase()
  const lastSelection = useRef<string | undefined>(undefined)
  useEffect(() => {
    const selectionChanged = lastSelection.current !== selection?.id
    lastSelection.current = selection?.id
    setNodes(current => {
      const previous = new Map(current.map(n => [n.id, n]))
      return entities.map(entity => {
        const old = previous.get(entity.id)
        const type = typeByName.get(entity.kind)
        const color = entity.color || type?.color || entityVisual(entity.kind).border
        const match = !!needle && `${entity.name} ${entity.kind} ${entity.identifiers.map(i => i.raw_value).join(' ')}`.toLowerCase().includes(needle)
        const dimmed = (!!needle && !match) || (!!focusIds && !focusIds.has(entity.id))
        const selected = selection?.kind === 'entity' && selection.id === entity.id || (!selectionChanged && !!old?.selected)
        const position = old?.dragging ? old.position : entity.position ?? { x: 0, y: 0 }
        if (old && old.data.entity === entity && old.data.dimmed === dimmed && old.data.match === match && old.data.color === color && old.data.icon === type?.icon
          && old.selected === selected && old.position.x === position.x && old.position.y === position.y && old.draggable === !entity.pinned) return old
        return { id: entity.id, type: 'entity', position, selected, draggable: !entity.pinned,
          data: { entity, icon: type?.icon, color, dimmed, match, handlers } }
      })
    })
  }, [entities, selection, needle, typeByName, focusIds])
  useEffect(() => { if (pendingFit.current) { pendingFit.current = false; requestAnimationFrame(() => void flow.fitView({ padding: 0.2, maxZoom: 1.1, duration: 400 })) } }, [entities])
  useEffect(() => { if (!fitted.current && nodes.length) { fitted.current = true; requestAnimationFrame(() => void flow.fitView({ padding: 0.2, maxZoom: 1.1 })) } }, [nodes.length, flow])

  const pickEdge = useRef((id: string) => onSelect({ kind: 'fact', id }))
  pickEdge.current = (id: string) => onSelect({ kind: 'fact', id })
  const editEdge = useRef((_id: string) => {})
  editEdge.current = (id: string) => { const f = facts.find(x => x.id === id); if (f) setDraft({ source: f.subject_id, target: f.object_id, position: { x: 0, y: 0 }, kind: '', name: '', predicate: f.predicate, relationId: f.id }) }
  const edgeCallbacks = useMemo(() => ({ onPick: (id: string) => pickEdge.current(id), onEdit: (id: string) => editEdge.current(id) }), [])
  const edges = useMemo<Edge<EdgeData>[]>(() => {
    const pairs = new Map<string, Fact[]>()
    for (const fact of facts) {
      const key = fact.subject_id < fact.object_id ? `${fact.subject_id}|${fact.object_id}` : `${fact.object_id}|${fact.subject_id}`
      const list = pairs.get(key); if (list) list.push(fact); else pairs.set(key, [fact])
    }
    const offsets = new Map<string, number>()
    for (const list of pairs.values()) list.forEach((fact, index) => {
      const raw = list.length > 1 ? (index - (list.length - 1) / 2) * 34 : 0
      offsets.set(fact.id, fact.subject_id < fact.object_id ? raw : -raw)
    })
    return facts.map(fact => ({ id: fact.id, source: fact.subject_id, target: fact.object_id, sourceHandle: 'out', targetHandle: 'in', type: 'floating',
      label: fact.predicate, reconnectable: true, selected: selection?.id === fact.id,
      data: { state: fact.truth_state, offset: offsets.get(fact.id) ?? 0, dimmed: !!focusIds && !(focusIds.has(fact.subject_id) && focusIds.has(fact.object_id) && (selection?.kind === 'entity' ? fact.subject_id === selection.id || fact.object_id === selection.id : fact.id === selection?.id)), ...edgeCallbacks } }))
  }, [facts, selection, focusIds, edgeCallbacks])

  const center = () => flow.screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 })
  const beginConnection = (connection: Connection) => {
    const target = entities.find(e => e.id === connection.target)
    if (connection.source && target) setDraft({ source: connection.source, target: target.id, position: target.position ?? { x: 0, y: 0 }, kind: target.kind, name: target.name, predicate: '' })
  }
  const focusOn = (id: string) => {
    const fact = facts.find(f => f.id === id)
    const ids = fact ? [fact.subject_id, fact.object_id] : [id]
    if (!fact) for (const f of facts) { if (ids.length > 24) break; if (f.subject_id === id) ids.push(f.object_id); else if (f.object_id === id) ids.push(f.subject_id) }
    void flow.fitView({ nodes: ids.map(x => ({ id: x })), padding: ids.length > 1 ? 0.35 : 1.2, maxZoom: 1.1, duration: 450 })
  }
  useEffect(() => {
    if (!request) return
    if (request.type === 'focus' && request.id) focusOn(request.id)
    else if (request.type === 'fit') void flow.fitView({ padding: 0.2, maxZoom: 1.1, duration: 400 })
    else if (request.type === 'arrange') void align()
    else if (request.type === 'place') setDraft({ position: center(), kind: request.kind || 'Device', name: '', predicate: '' })
  }, [request?.n])
  useEffect(() => {
    const keyboard = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && (draft || palette || menu || typeEdit)) { setDraft(null); setPalette(false); setMenu(null); setTypeEdit(null); e.stopImmediatePropagation() }
      if ((e.target as HTMLElement)?.closest('input,textarea,select,[contenteditable]') || e.metaKey || e.ctrlKey || e.altKey) return
      if (document.querySelector('.modal-backdrop, .evidence-backdrop, .command-backdrop')) return
      const key = e.key.toLowerCase()
      if (key === 'n') { setDraft({ position: center(), kind: 'Device', name: '', predicate: '' }); e.preventDefault() }
      if (key === 'f') { const sel = selection?.id; if (sel) focusOn(sel); else void flow.fitView({ padding: 0.2, maxZoom: 1.1, duration: 400 }); e.preventDefault() }
      if ((e.key === 'Delete' || e.key === 'Backspace') && !draft) { const selected = flow.getNodes().filter(n => n.selected); if (selected.length > 1) { e.stopImmediatePropagation(); e.preventDefault(); void run(selected.map(n => ({ type: 'entity.delete', payload: { id: n.id } }))).catch(() => {}); onSelect(null) } }
    }
    window.addEventListener('keydown', keyboard, true)
    return () => window.removeEventListener('keydown', keyboard, true)
  }, [draft, palette, menu, typeEdit, nodes, selection, facts])
  const save = async () => {
    if (!draft) return
    setBusy(true)
    try {
      const targetId = draft.target || uuid()
      const items: ActionDraft[] = []
      if (!draft.target) items.push({ type: 'entity.add', payload: { id: targetId, name: draft.name.trim(), kind: draft.kind.trim(), ...snapPosition(draft.position) } })
      if (draft.source) {
        if (draft.relationId) items.push({ type: 'fact.update', payload: { id: draft.relationId, predicate: draft.predicate.trim() } })
        else if (!facts.some(f => f.subject_id === draft.source && f.object_id === targetId && f.predicate.toLowerCase() === draft.predicate.trim().toLowerCase()))
          items.push({ type: 'fact.add', payload: { id: uuid(), subject_id: draft.source, object_id: targetId, predicate: draft.predicate.trim() } })
      }
      await run(items)
      setDraft(null)
      onSelect(draft.target ? null : { kind: 'entity', id: targetId })
    } catch { /* shown as canvas error */ } finally { setBusy(false) }
  }
  const align = async (direction = 'RIGHT') => {
    setBusy(true); setError('')
    try {
      const selected = flow.getNodes().filter(n => n.selected)
      const chosen = selected.length > 1 ? selected : flow.getNodes()
      const movable = chosen.filter(n => !n.data.entity.pinned)
      const ids = new Set(movable.map(n => n.id))
      const { default: ELK } = await import('elkjs/lib/elk.bundled.js')
      const result = await new ELK().layout({ id: 'root', layoutOptions: { 'elk.algorithm': 'layered', 'elk.direction': direction, 'elk.spacing.nodeNode': '36', 'elk.layered.spacing.nodeNodeBetweenLayers': '120', 'elk.spacing.componentComponent': '60', 'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES' },
        children: movable.map(n => ({ id: n.id, width: n.measured?.width ?? 220, height: n.measured?.height ?? 56 })), edges: facts.filter(f => ids.has(f.subject_id) && ids.has(f.object_id)).map(f => ({ id: f.id, sources: [f.subject_id], targets: [f.object_id] })) })
      const pinned = chosen.filter(n => n.data.entity.pinned)
      const offsetX = pinned.length ? Math.max(...pinned.map(n => n.position.x + 350)) : 0
      pendingFit.current = true
      await run((result.children ?? []).map(n => ({ type: 'entity.position', payload: { id: n.id, ...snapPosition({ x: (n.x ?? 0) + offsetX, y: n.y ?? 0 }) } })))
    } catch (e) { setError(String(e)) } finally { setBusy(false) }
  }
  const toggle = (key: string, value: boolean, set: (v: boolean) => void) => { set(value); savePref(key, value) }
  const selectedNodes = nodes.filter(n => n.selected)
  const kinds = [...new Set([...builtInKinds, ...entityTypes.map(t => t.name), ...entities.map(e => e.kind)])].filter(k => k.toLowerCase().includes(typeSearch.toLowerCase()))
  const menuEntity = entities.find(e => e.id === menu?.id)
  const nameOf = (id?: string) => entities.find(e => e.id === id)?.name ?? 'New entity'
  return <div className={`graph-shell flow-shell${far ? ' zoom-far' : ''}${focusIds ? ' has-focus' : ''}`} onDragOver={e => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy' }} onDrop={e => {
    e.preventDefault(); const kind = e.dataTransfer.getData('application/factgraph-kind'); if (kind) { setDraft({ position: flow.screenToFlowPosition({ x: e.clientX, y: e.clientY }), kind, name: '', predicate: '' }); setPalette(false) }
  }}>
    <ArrowDefs />
    <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes} onNodesChange={onNodesChange}
      onNodeClick={(_, n) => { cancelSelect(); clickTimer.current = setTimeout(() => onSelect({ kind: 'entity', id: n.id }), 220); setMenu(null) }} onEdgeClick={(_, edge) => onSelect({ kind: 'fact', id: edge.id })}
      onEdgeDoubleClick={(_, edge) => editEdge.current(edge.id)}
      onPaneClick={() => { onSelect(null); setMenu(null) }} onConnect={beginConnection}
      onConnectEnd={(event, state) => {
        if (state.isValid || !state.fromNode || state.fromHandle?.type !== 'source') return
        const target = event.target as HTMLElement
        if (!target.closest('.react-flow__pane')) return
        const point = 'changedTouches' in event ? event.changedTouches[0] : event
        setDraft({ source: state.fromNode.id, position: flow.screenToFlowPosition({ x: point.clientX, y: point.clientY }), kind: 'Device', name: '', predicate: '' })
      }}
      onReconnect={(edge, c) => { void run([{ type: 'fact.update', payload: { id: edge.id, subject_id: c.source, object_id: c.target } }]).catch(() => {}) }}
      onNodeDragStop={(_, node, moved) => { void run((moved.length ? moved : [node]).map(n => ({ type: 'entity.position', payload: { id: n.id, ...(grid ? snapPosition(n.position) : n.position) } }))).catch(() => {}) }}
      onNodeContextMenu={(e, n) => { e.preventDefault(); onSelect({ kind: 'entity', id: n.id }); setMenu({ id: n.id, x: e.clientX, y: e.clientY }) }}
      onDoubleClick={e => { if ((e.target as HTMLElement).classList.contains('react-flow__pane')) setDraft({ position: flow.screenToFlowPosition({ x: e.clientX, y: e.clientY }), kind: 'Device', name: '', predicate: '' }) }}
      deleteKeyCode={null} selectionOnDrag panOnDrag={[1, 2]} panOnScroll zoomOnDoubleClick={false} selectionKeyCode="Shift" multiSelectionKeyCode="Shift"
      minZoom={0.05} maxZoom={2.5} snapToGrid={grid} snapGrid={[20, 20]} connectionRadius={40} colorMode={props.theme} onlyRenderVisibleElements proOptions={{ hideAttribution: true }}>
      <Background variant={BackgroundVariant.Dots} gap={20} size={1.2} />
      <Controls showInteractive={false} fitViewOptions={{ padding: 0.2, maxZoom: 1.1, duration: 300 }} position="bottom-left" />
      {minimap && <MiniMap pannable zoomable position="bottom-right" nodeBorderRadius={6} nodeColor={n => (n.data as CardData).color} maskColor="var(--minimap-mask)" />}
    </ReactFlow>
    <div className="canvas-toolbar" role="toolbar" aria-label="Canvas tools">
      <button className={`tool-primary${palette ? ' active' : ''}`} onClick={() => setPalette(!palette)} title="Add entity · N"><Plus size={15} /><span>Add entity</span></button>
      <span className="tool-sep" />
      <button onClick={() => void align()} disabled={busy} title="Auto layout selection or whole graph (left → right)" aria-label="Arrange"><Sparkles size={15} /><span>Arrange</span></button>
      <button className="icon-only" onClick={() => void align('DOWN')} disabled={busy} title="Arrange top to bottom" aria-label="Arrange top to bottom"><ArrowDown size={15} /></button>
      <span className="tool-sep" />
      <button className={`icon-only${focusMode ? ' active' : ''}`} aria-pressed={focusMode} onClick={() => toggle('focus', !focusMode, setFocusMode)} title="Focus: highlight neighbours of the selection"><Crosshair size={15} /></button>
      <button className={`icon-only${grid ? ' active' : ''}`} aria-pressed={grid} onClick={() => toggle('snap', !grid, setGrid)} title="Snap to grid"><Grid3x3 size={15} /></button>
      <button className={`icon-only${minimap ? ' active' : ''}`} aria-pressed={minimap} onClick={() => toggle('minimap', !minimap, setMinimap)} title="Minimap"><MapIcon size={15} /></button>
    </div>
    {palette && <div className="entity-palette popover">
      <div className="popover-head"><strong>Add entity</strong><button className="icon-button" aria-label="Close palette" onClick={() => setPalette(false)}><X size={15} /></button></div>
      <label className="input-with-icon"><Search size={14} /><input autoFocus placeholder="Find or create a type…" value={typeSearch} onChange={e => setTypeSearch(e.target.value)} /></label>
      <p className="hint">Click to place in the centre, or drag onto the canvas.</p>
      <div className="palette-grid">
        {[...kinds, ...(typeSearch.trim() && !kinds.some(k => k.toLowerCase() === typeSearch.trim().toLowerCase()) ? [typeSearch.trim()] : [])].map(kind => {
          const color = typeByName.get(kind)?.color || entityVisual(kind).border
          return <button key={kind} draggable style={{ '--entity-color': color } as CSSProperties} onDragStart={e => e.dataTransfer.setData('application/factgraph-kind', kind)}
            onClick={() => { setDraft({ position: center(), kind, name: '', predicate: '' }); setPalette(false) }}><span className="palette-icon"><KindIcon kind={kind} icon={typeByName.get(kind)?.icon} size={14} /></span>{kind}</button>
        })}
      </div>
      <button className="ghost-button full" onClick={() => setTypeEdit({ id: uuid(), name: typeSearch, color: '#8da9ce', icon: 'Box' })}><Settings2 size={14} /> Manage types…</button>
    </div>}
    {typeEdit && <div className="canvas-composer popover" role="dialog" aria-label="Entity type editor"><form onSubmit={e => { e.preventDefault(); void run([{ type: entityTypes.some(t => t.id === typeEdit.id) ? 'type.update' : 'type.add', payload: { ...typeEdit } }]).then(() => setTypeEdit(null)).catch(() => {}) }}>
      <div className="popover-head"><strong>Entity type</strong><button type="button" className="icon-button" aria-label="Close type editor" onClick={() => setTypeEdit(null)}><X size={15} /></button></div>
      <label>Existing type<select value={entityTypes.some(t => t.id === typeEdit.id) ? typeEdit.id : ''} onChange={e => setTypeEdit(entityTypes.find(t => t.id === e.target.value) ?? { id: uuid(), name: '', color: '#8da9ce', icon: 'Box' })}><option value="">New type</option>{entityTypes.map(t => <option value={t.id} key={t.id}>{t.name}</option>)}</select></label>
      <label>Type name<input required value={typeEdit.name} onChange={e => setTypeEdit({ ...typeEdit, name: e.target.value })} /></label>
      <div className="field-grid"><label>Icon<select value={typeEdit.icon} onChange={e => setTypeEdit({ ...typeEdit, icon: e.target.value })}>{Object.keys(typeIcons).map(icon => <option key={icon}>{icon}</option>)}</select></label>
        <label>Default color<input type="color" className="color-input" value={typeEdit.color} onChange={e => setTypeEdit({ ...typeEdit, color: e.target.value })} /></label></div>
      <div className="composer-actions">{entityTypes.some(t => t.id === typeEdit.id) && <button type="button" className="ghost-button danger" onClick={() => void run([{ type: 'type.delete', payload: { id: typeEdit.id } }]).then(() => setTypeEdit(null)).catch(() => {})}>Delete unused type</button>}<button className="primary-button">Save type</button></div>
    </form></div>}
    {selectedNodes.length > 1 && <div className="selection-tools"><span>{selectedNodes.length} selected</span>
      <button onClick={() => { const y = selectedNodes[0].position.y; void run(selectedNodes.filter(n => !n.data.entity.pinned).map(n => ({ type: 'entity.position', payload: { id: n.id, x: n.position.x, y } }))).catch(() => {}) }}>Align row</button>
      <button onClick={() => { const x = selectedNodes[0].position.x; void run(selectedNodes.filter(n => !n.data.entity.pinned).map(n => ({ type: 'entity.position', payload: { id: n.id, x, y: n.position.y } }))).catch(() => {}) }}>Align column</button>
      <button onClick={() => { const sorted = [...selectedNodes].sort((a, b) => a.position.x - b.position.x); void run(sorted.filter(n => !n.data.entity.pinned).map((n, i) => ({ type: 'entity.position', payload: { id: n.id, x: sorted[0].position.x + i * 280, y: n.position.y } }))).catch(() => {}) }}>Distribute</button>
      <button onClick={() => void align()}>Arrange selection</button>
    </div>}
    {menu && menuEntity && <div className="canvas-menu popover" role="menu" style={{ left: Math.min(menu.x, window.innerWidth - 230), top: Math.min(menu.y, window.innerHeight - 280) }}>
      <button onClick={() => { props.onEdit(menu.id); setMenu(null) }}><Pencil size={14} /> Edit name, type & color</button>
      <button onClick={() => { setDraft({ source: menu.id, position: { x: (menuEntity.position?.x ?? 0) + 320, y: menuEntity.position?.y ?? 0 }, kind: 'Device', name: '', predicate: '' }); setMenu(null) }}><Plus size={14} /> Add connected entity</button>
      <button onClick={() => { props.onMerge(menu.id); setMenu(null) }}><Merge size={14} /> Merge entity…</button>
      <button onClick={() => { props.onCopy(menu.id, 'Entity ID'); setMenu(null) }}><Copy size={14} /> Copy ID</button>
      <button onClick={() => { void run([{ type: 'entity.update', payload: { id: menu.id, pinned: !menuEntity.pinned } }]).catch(() => {}); setMenu(null) }}>{menuEntity.pinned ? <><PinOff size={14} /> Unpin</> : <><Pin size={14} /> Pin position</>}</button>
      <div className="menu-sep" />
      <button className="danger" onClick={() => { void run([{ type: 'entity.delete', payload: { id: menu.id } }]).catch(() => {}); setMenu(null); onSelect(null) }}><Trash2 size={14} /> Delete · undo available</button>
    </div>}
    {draft && <div className="canvas-composer popover" role="dialog" aria-label={draft.source ? 'Connect entities' : 'Place entity'}>
      <form onSubmit={e => { e.preventDefault(); void save() }}>
        <div className="popover-head"><strong>{draft.relationId ? 'Edit relationship' : draft.source ? 'New connection' : 'Place entity'}</strong><button type="button" className="icon-button" aria-label="Cancel creation" onClick={() => setDraft(null)}><X size={15} /></button></div>
        {draft.source && <><div className="composer-path"><span>{nameOf(draft.source)}</span><i>→</i><span>{draft.target ? nameOf(draft.target) : draft.name || 'New entity'}</span></div>
          <label>Relationship<input autoFocus required placeholder="reads, accessed, grants access to…" value={draft.predicate} onChange={e => setDraft({ ...draft, predicate: e.target.value })} /></label></>}
        {!draft.target && <div className="field-grid"><label>Entity name<input autoFocus={!draft.source} required value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })} /></label>
          <label>Type<input aria-label="Type" list="entity-types" required value={draft.kind} onChange={e => setDraft({ ...draft, kind: e.target.value })} /><datalist id="entity-types">{kinds.map(k => <option key={k}>{k}</option>)}</datalist></label></div>}
        <div className="composer-actions"><span className="hint">{draft.source ? 'Attach evidence afterwards in the inspector.' : 'Enter to save · Esc to cancel'}</span><button className="primary-button" disabled={busy}>Save {draft.source ? 'connection' : 'entity'}</button></div>
      </form>
    </div>}
    {error && <div className="canvas-error" role="alert" onClick={() => setError('')}>{error}</div>}
  </div>
}
export default function GraphView(props: Props) { return <ReactFlowProvider><Canvas {...props} /></ReactFlowProvider> }
