import { memo, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { ReactFlow, ReactFlowProvider, Background, BackgroundVariant, Controls, MiniMap, Handle, Position, BaseEdge, EdgeLabelRenderer,
  useReactFlow, useNodesState, useInternalNode, useStore, type Node, type Edge, type NodeProps, type EdgeProps, type Connection,
  type XYPosition, type InternalNode } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { Layers, Plus, Search, X, Pin, Sparkles, Copy, ArrowDown,
  Grid3x3, Map as MapIcon, Crosshair, Pencil, Merge, Trash2, PinOff, Settings2, Boxes, Zap, ChevronRight, ChevronDown,
  FolderTree, Group as GroupIcon, Ungroup, EyeOff, Save, Columns3, Workflow, Download, ClipboardCopy, ImageDown } from 'lucide-react'
import type { Entity, EntityType, Fact, Group, Perspective, TruthState } from './types'
import { CONTAINS_PREDICATES, type ActionDraft } from './board'
import { snapPosition } from './layout'
import { KindIcon, iconMarkup, prepareIconMarkup, typeIcons } from './KindIcon'
import { browserMeasure, buildGraphSvg, downloadBlob, exportFilename, svgToPng } from './exportGraph'
import { entityVisual } from './entityVisual'
import { LAYERS, layerOf } from './layers'
import { buildViewModel, groupSuggestions, activityNodeId, groupNodeId, edgeGeometry, edgeOffsets, edgeWidth, NODE_H, NODE_W, type NodeBox, type VNode } from './viewModel'
import { uuid } from './uuid'

export type Selection = { kind: 'entity' | 'fact' | 'group'; id: string } | null
export type CanvasRequest = { type: 'focus' | 'fit' | 'arrange' | 'arrange-layers' | 'place' | 'export'; id?: string; kind?: string; n: number }
type ExportSettings = { format: 'png' | 'svg'; area: 'all' | 'visible' | 'selection'; theme: 'current' | 'light' | 'dark'; scale: number; title: boolean; legend: boolean; transparent: boolean }
const defaultExport: ExportSettings = { format: 'png', area: 'all', theme: 'current', scale: 2, title: true, legend: true, transparent: false }
export type Lens = { layers: Set<string> | null; collapseActivities: boolean; showLanes: boolean }
type Props = {
  entityTypes: EntityType[]; entities: Entity[]; facts: Fact[]; groups: Group[]; perspectives: Perspective[];
  selection: Selection; search: string; theme: 'light' | 'dark'; request: CanvasRequest | null;
  lens: Lens; onLensChange: (lens: Lens) => void; activePerspective: string | null;
  onApplyPerspective: (id: string | null) => void; onSavePerspective: (name: string) => void; onDeletePerspective: (id: string) => void;
  onSelect: (value: Selection) => void;
  onCommand: (drafts: ActionDraft[]) => Promise<unknown>;
  onEdit: (id: string) => void; onMerge: (id: string) => void;
  onCopy: (value: string, label: string) => void;
  boardName: string; filterSummary: string; onNotice: (message: string) => void;
  /** Called once a request was handled, so a remounted canvas never replays it. */
  onRequestDone: () => void;
}
const builtInKinds = ['User', 'Device', 'IP', 'Service Principal', 'Key Vault', 'AKS Cluster', 'S3 Bucket', 'File', 'Repository', 'Credential', 'Environment Variable', 'Blob Storage']
export { KindIcon }

// Callbacks live in a ref so node data stays referentially stable and memoised cards do not re-render on every parent render.
type Handlers = { rename: (id: string, name: string) => void; cancelSelect: () => void; toggleGroup: (groupId: string, collapsed: boolean) => void }
type HandlerRef = { current: Handlers }
type EntityData = { v: Extract<VNode, { kind: 'entity' }>; icon?: string; color: string; dimmed: boolean; match: boolean; handlers: HandlerRef }
type GroupData = { v: Extract<VNode, { kind: 'group' }>; dimmed: boolean; match: boolean; handlers: HandlerRef }
type ActivityData = { v: Extract<VNode, { kind: 'activity' }>; dimmed: boolean }
type FrameData = { v: Extract<VNode, { kind: 'frame' }>; handlers: HandlerRef }
type AnyData = EntityData | GroupData | ActivityData | FrameData

const hiddenHandles = <>
  <Handle type="target" position={Position.Left} id="in" isConnectable={false} className="hidden-handle" />
  <Handle type="source" position={Position.Right} id="out" isConnectable={false} className="hidden-handle" />
</>

const EntityCard = memo(function EntityCard({ data, selected }: NodeProps<Node<EntityData>>) {
  const { entity, container, hidden } = data.v
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
    {(container || hidden > 0) && <div className="node-chips">
      {container && <button className="node-chip nodrag" title={container.collapsed ? 'Show contents' : 'Collapse contents'} onClick={event => { event.stopPropagation(); data.handlers.current.toggleGroup(container.groupId, !container.collapsed) }}>
        {container.collapsed ? <ChevronRight size={11} /> : <ChevronDown size={11} />}{container.count} inside</button>}
      {hidden > 0 && <span className="node-chip muted-chip" title="Connections to entities in hidden layers"><EyeOff size={10} />{hidden}</span>}
    </div>}
    <Handle type="source" position={Position.Right} id="out" aria-label={`Connect from ${entity.name}`} />
  </div>
})

const GroupCard = memo(function GroupCard({ data, selected }: NodeProps<Node<GroupData>>) {
  const { group, count, kinds, states, internal } = data.v
  const total = states.supported + states.disputed + states.refuted + states.unknown
  return <div className={`group-node${selected ? ' selected' : ''}${data.dimmed ? ' dimmed' : ''}${data.match ? ' match' : ''}`} style={{ '--entity-color': group.color || 'var(--accent)' } as CSSProperties}>
    {hiddenHandles}
    <div className="group-stack" />
    <div className="group-body">
      <div className="node-icon"><Boxes size={16} /></div>
      <div className="node-copy"><strong title={group.name}>{group.name}</strong>
        <small>{count} {kinds.length === 1 ? kinds[0][0] : `entities · ${kinds.length} types`}{internal ? ` · ${internal} internal` : ''}</small></div>
      <button className="node-chip nodrag" title="Expand group" aria-label={`Expand ${group.name}`} onClick={event => { event.stopPropagation(); data.handlers.current.toggleGroup(group.id, false) }}><ChevronRight size={11} /></button>
    </div>
    {total > 0 && <div className="state-bar" title={`${states.supported} supported · ${states.disputed} disputed · ${states.refuted} refuted · ${states.unknown} unknown`}>
      {(['supported', 'disputed', 'refuted', 'unknown'] as TruthState[]).map(s => states[s] ? <i key={s} className={s} style={{ flex: states[s] }} /> : null)}</div>}
  </div>
})

const ActivityHub = memo(function ActivityHub({ data, selected }: NodeProps<Node<ActivityData>>) {
  const { fact } = data.v
  const when = fact.assertions.map(a => a.valid_from).filter(Boolean).sort()[0] ?? fact.valid_from
  return <div className={`activity-node ${fact.truth_state}${selected ? ' selected' : ''}${data.dimmed ? ' dimmed' : ''}`} title={`${fact.predicate}${fact.technique ? ` · ${fact.technique}` : ''}`}>
    {hiddenHandles}
    <div className="activity-diamond"><Zap size={13} /></div>
    <div className="activity-label"><strong>{fact.predicate}</strong>{(when || fact.technique) && <small>{when ? new Date(when).toISOString().slice(5, 16).replace('T', ' ') : ''}{fact.technique ? ` ${fact.technique}` : ''}</small>}</div>
  </div>
})

const FrameNode = memo(function FrameNode({ data }: NodeProps<Node<FrameData>>) {
  const { v } = data
  return <div className={`frame-node ${v.tone}`} style={{ width: v.width, height: v.height }}>
    <div className="frame-head">{v.tone === 'group' && v.groupId && <button className="nodrag" aria-label={`Collapse ${v.label}`} title="Collapse group" onClick={() => data.handlers.current.toggleGroup(v.groupId!, true)}><ChevronDown size={12} /></button>}
      <span>{v.tone === 'lane' ? LAYERS.find(l => l.id === v.label)?.label ?? v.label : v.label}</span></div>
  </div>
})

// Floating edges attach to the node border along the line between centres, so edges never loop around cards.
const boxOf = (node: InternalNode): NodeBox => {
  const w = node.measured.width ?? 200, h = node.measured.height ?? 56
  return { x: node.internals.positionAbsolute.x + w / 2, y: node.internals.positionAbsolute.y + h / 2, w, h }
}
type EdgeData = { state: TruthState; offset: number; dimmed: boolean; count: number; spoke: boolean; onPick: (id: string) => void; onEdit: (id: string) => void }
const FloatingEdge = memo(function FloatingEdge({ id, source, target, label, selected, data }: EdgeProps<Edge<EdgeData>>) {
  const s = useInternalNode(source), t = useInternalNode(target)
  const showLabel = useStore(store => store.transform[2] >= 0.55)
  if (!s || !t || !data) return null
  const { path, label: { x: lx, y: ly } } = edgeGeometry(boxOf(s), boxOf(t), data.offset)
  const width = data.count > 1 ? edgeWidth(data.count) : undefined
  return <>
    <BaseEdge id={id} path={path} interactionWidth={16} markerEnd={`url(#fg-arrow-${selected ? 'selected' : data.state})`} style={width ? { strokeWidth: width } : undefined}
      className={`fg-edge ${data.state}${selected ? ' selected' : ''}${data.dimmed ? ' dimmed' : ''}${data.spoke ? ' spoke' : ''}`} />
    {(showLabel || selected) && label && <EdgeLabelRenderer>
      <button type="button" className={`edge-label nodrag nopan ${data.state}${selected ? ' selected' : ''}${data.dimmed ? ' dimmed' : ''}${data.spoke ? ' spoke' : ''}`}
        style={{ transform: `translate(-50%, -50%) translate(${lx}px, ${ly}px)` }}
        onClick={event => { event.stopPropagation(); data.onPick(id) }} onDoubleClick={event => { event.stopPropagation(); data.onEdit(id) }}>
        {label}{data.count > 1 && <b>×{data.count}</b>}</button>
    </EdgeLabelRenderer>}
  </>
})

const nodeTypes = { entity: EntityCard, group: GroupCard, activity: ActivityHub, frame: FrameNode }
const edgeTypes = { floating: FloatingEdge }
type Draft = { position: XYPosition; source?: string; target?: string; kind: string; name: string; predicate: string; relationId?: string }
type GroupDraft = { members: string[]; name: string; rule?: { kinds: string[] } }
const pref = (key: string, fallback: boolean) => { try { const v = localStorage.getItem(`factgraph:${key}`); return v === null ? fallback : v === 'true' } catch { return fallback } }
const savePref = (key: string, value: boolean) => { try { localStorage.setItem(`factgraph:${key}`, String(value)) } catch { /* private mode */ } }

// Cheap structural comparison so unchanged cards keep their identity and skip re-rendering.
function sameV(a: VNode, b: VNode) {
  if (a.kind !== b.kind || a.position.x !== b.position.x || a.position.y !== b.position.y) return false
  if (a.kind === 'entity' && b.kind === 'entity') return a.entity === b.entity && a.hidden === b.hidden && a.inGroup === b.inGroup && a.container?.count === b.container?.count && a.container?.collapsed === b.container?.collapsed
  if (a.kind === 'group' && b.kind === 'group') return a.group === b.group && a.count === b.count && a.internal === b.internal && (['supported', 'disputed', 'refuted', 'unknown'] as const).every(s => a.states[s] === b.states[s])
  if (a.kind === 'activity' && b.kind === 'activity') return a.fact === b.fact
  if (a.kind === 'frame' && b.kind === 'frame') return a.label === b.label && a.width === b.width && a.height === b.height
  return false
}

function ArrowDefs() {
  return <svg className="fg-defs" aria-hidden="true"><defs>
    {(['supported', 'disputed', 'refuted', 'unknown', 'selected'] as const).map(state => <marker key={state} id={`fg-arrow-${state}`} viewBox="0 0 10 10" refX="9" refY="5" markerUnits="userSpaceOnUse" markerWidth="10" markerHeight="10" orient="auto-start-reverse">
      <path d="M 0 0 L 10 5 L 0 10 z" className={`fg-arrow ${state}`} />
    </marker>)}
  </defs></svg>
}

function Canvas(props: Props) {
  const { entities, facts, groups, selection, search, onSelect, onCommand, entityTypes, request, lens } = props
  const flow = useReactFlow<Node<AnyData>>()
  const [nodes, setNodes, onNodesChange] = useNodesState<Node<AnyData>>([])
  const [popover, setPopover] = useState<'palette' | 'layers' | 'suggest' | 'export' | null>(null)
  const [exportSettings, setExportSettingsState] = useState<ExportSettings>(() => { try { return { ...defaultExport, ...JSON.parse(localStorage.getItem('factgraph:export') ?? '{}') } } catch { return defaultExport } })
  const setExportSettings = (next: ExportSettings) => { setExportSettingsState(next); try { localStorage.setItem('factgraph:export', JSON.stringify(next)) } catch { /* private mode */ } }
  const [exporting, setExporting] = useState(false)
  const shellRef = useRef<HTMLDivElement>(null)
  const [typeEdit, setTypeEdit] = useState<EntityType | null>(null)
  const [typeSearch, setTypeSearch] = useState('')
  const [draft, setDraft] = useState<Draft | null>(null)
  const [groupDraft, setGroupDraft] = useState<GroupDraft | null>(null)
  const [menu, setMenu] = useState<{ id: string; kind: 'entity' | 'group'; x: number; y: number } | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [grid, setGrid] = useState(() => pref('snap', true))
  const [minimapPref, setMinimapPref] = useState<boolean | null>(() => { try { const v = localStorage.getItem('factgraph:minimap'); return v === null ? null : v === 'true' } catch { return null } })
  const minimap = minimapPref ?? entities.length > 60
  const [focusMode, setFocusMode] = useState(() => pref('focus', true))
  const [perspectiveName, setPerspectiveName] = useState('')
  const pendingFit = useRef(false)
  // Locally expanded groups get focused once their members are on the canvas; remote changes never move the viewport.
  const pendingFocus = useRef<string | null>(null)
  const far = useStore(store => store.transform[2] < 0.45)
  const fitted = useRef(false)
  const clickTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const cancelSelect = () => { if (clickTimer.current) clearTimeout(clickTimer.current) }
  useEffect(() => () => cancelSelect(), [])
  const run = async (drafts: ActionDraft[]) => { setError(''); try { await onCommand(drafts) } catch (e) { setError(String(e)); throw e } }
  const handlers = useRef<Handlers>({ rename: () => {}, cancelSelect, toggleGroup: () => {} })
  handlers.current = {
    rename: (id, name) => { void run([{ type: 'entity.update', payload: { id, name } }]).catch(() => {}) },
    cancelSelect,
    toggleGroup: (groupId, collapsed) => { void run([{ type: 'group.update', payload: { id: groupId, collapsed } }]).then(() => { if (!collapsed) pendingFocus.current = groupId }).catch(() => {}) },
  }

  const typeByName = useMemo(() => new Map(entityTypes.map(t => [t.name, t])), [entityTypes])
  const view = useMemo(() => buildViewModel(entities, facts, groups, { visibleLayers: lens.layers, collapseActivities: lens.collapseActivities, showLanes: lens.showLanes, entityTypes }),
    [entities, facts, groups, lens, entityTypes])
  const layerCounts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const e of entities) { const l = layerOf(e, entityTypes); counts.set(l, (counts.get(l) ?? 0) + 1) }
    return counts
  }, [entities, entityTypes])
  const suggestions = useMemo(() => groupSuggestions(entities, facts, groups), [entities, facts, groups])
  const containers = useMemo(() => {
    const set = new Set<string>()
    for (const f of facts) if (CONTAINS_PREDICATES.includes(f.predicate.trim().toLowerCase())) set.add(f.subject_id)
    return set
  }, [facts])

  // The canvas node a selection refers to: a member of a collapsed group points at its group.
  const selectedNodeId = useMemo(() => {
    if (!selection) return null
    if (selection.kind === 'group') return groupNodeId(selection.id)
    if (selection.kind === 'entity') return view.repOf(selection.id)
    const fact = facts.find(f => f.id === selection.id)
    return fact?.participants?.length && !lens.collapseActivities ? activityNodeId(fact.id) : null
  }, [selection, view, facts, lens.collapseActivities])
  const selectedEdgeIds = useMemo(() => new Set(selection?.kind === 'fact' ? view.edges.filter(e => !e.activityId && e.factIds.includes(selection.id)).map(e => e.id) : []), [selection, view])
  const focusIds = useMemo(() => {
    if (!focusMode || !selection) return null
    const ids = new Set<string>()
    if (selectedNodeId) {
      ids.add(selectedNodeId)
      for (const e of view.edges) {
        const other = e.source === selectedNodeId ? e.target : e.target === selectedNodeId ? e.source : null
        if (!other) continue
        ids.add(other)
        // Reaching an activity also reveals its other participants.
        if (other.startsWith('act:')) for (const s of view.edges) if (s.source === other || s.target === other) { ids.add(s.source); ids.add(s.target) }
      }
    } else for (const e of view.edges) if (selectedEdgeIds.has(e.id)) { ids.add(e.source); ids.add(e.target) }
    return ids.size ? ids : null
  }, [focusMode, selection, selectedNodeId, selectedEdgeIds, view])
  const needle = search.trim().toLowerCase()
  const matches = (entity: Entity) => `${entity.name} ${entity.kind} ${entity.identifiers.map(i => i.raw_value).join(' ')}`.toLowerCase().includes(needle)

  const lastSelection = useRef<string | null | undefined>(undefined)
  useEffect(() => {
    const selectionChanged = lastSelection.current !== selectedNodeId
    lastSelection.current = selectedNodeId
    setNodes(current => {
      const previous = new Map(current.map(n => [n.id, n]))
      return view.nodes.map(v => {
        const old = previous.get(v.id)
        const selected = v.kind !== 'frame' && (v.id === selectedNodeId || (!selectionChanged && !!old?.selected))
        const dimmedByFocus = !!focusIds && !focusIds.has(v.id)
        const base = { id: v.id, measured: old?.measured, selected, position: old?.dragging ? old.position : v.position }
        let data: AnyData
        if (v.kind === 'entity') {
          const type = typeByName.get(v.entity.kind)
          const match = !!needle && matches(v.entity)
          data = { v, icon: type?.icon, color: v.entity.color || type?.color || entityVisual(v.entity.kind).border, match, dimmed: (!!needle && !match) || dimmedByFocus, handlers }
        } else if (v.kind === 'group') {
          const match = !!needle && v.group.member_ids.some(id => { const e = entities.find(x => x.id === id); return !!e && matches(e) })
          data = { v, match, dimmed: (!!needle && !match) || dimmedByFocus, handlers }
        } else if (v.kind === 'activity') data = { v, dimmed: !!needle || dimmedByFocus }
        else data = { v, handlers }
        const sameData = old && old.type === v.kind && Object.keys(data).every(k => k === 'v' ? sameV(old.data.v, v) : (old.data as Record<string, unknown>)[k] === (data as Record<string, unknown>)[k])
        if (old && sameData && old.selected === selected && old.position.x === base.position.x && old.position.y === base.position.y) return old
        return { ...base, type: v.kind, data: sameData ? old!.data : data,
          draggable: v.kind === 'frame' ? false : v.kind === 'entity' ? !v.entity.pinned : true,
          selectable: v.kind !== 'frame', zIndex: v.kind === 'frame' ? -1 : undefined, ...(v.kind === 'frame' ? { width: v.width, height: v.height } : {}) } as Node<AnyData>
      })
    })
  }, [view, selectedNodeId, needle, typeByName, focusIds])
  useEffect(() => { if (pendingFocus.current && groups.some(g => g.id === pendingFocus.current && !g.collapsed)) { const id = pendingFocus.current; pendingFocus.current = null; requestAnimationFrame(() => focusOn(id)) } }, [view])
  useEffect(() => { if (pendingFit.current) { pendingFit.current = false; requestAnimationFrame(() => void flow.fitView({ padding: 0.2, maxZoom: 1.1, duration: 400 })) } }, [view])
  useEffect(() => { if (!fitted.current && nodes.length) { fitted.current = true; requestAnimationFrame(() => void flow.fitView({ padding: 0.2, maxZoom: 1.1 })) } }, [nodes.length, flow])

  const pickEdge = useRef((_id: string) => {})
  pickEdge.current = (id: string) => {
    const edge = view.edges.find(e => e.id === id)
    if (!edge) return
    if (edge.activityId || edge.factIds.length === 1) onSelect({ kind: 'fact', id: edge.activityId ?? edge.factIds[0] })
    else { const end = [edge.source, edge.target].find(x => x.startsWith('group:')); onSelect(end ? { kind: 'group', id: end.slice(6) } : { kind: 'fact', id: edge.factIds[0] }) }
  }
  const editEdge = useRef((_id: string) => {})
  editEdge.current = (id: string) => {
    const edge = view.edges.find(e => e.id === id)
    const f = edge && facts.find(x => x.id === (edge.activityId ?? edge.factIds[0]))
    if (f && edge && edge.factIds.length === 1) setDraft({ source: f.subject_id, target: f.object_id, position: { x: 0, y: 0 }, kind: '', name: '', predicate: f.predicate, relationId: f.id })
  }
  const edgeCallbacks = useMemo(() => ({ onPick: (id: string) => pickEdge.current(id), onEdit: (id: string) => editEdge.current(id) }), [])
  const edges = useMemo<Edge<EdgeData>[]>(() => {
    const offsets = edgeOffsets(view.edges)
    return view.edges.map(edge => {
      const selected = selectedEdgeIds.has(edge.id) || (!!edge.activityId && selection?.kind === 'fact' && selection.id === edge.activityId)
      const incident = !focusIds || (selectedNodeId ? edge.source === selectedNodeId || edge.target === selectedNodeId || (focusIds.has(edge.source) && focusIds.has(edge.target) && (edge.source.startsWith('act:') || edge.target.startsWith('act:'))) : selected)
      return { id: edge.id, source: edge.source, target: edge.target, sourceHandle: 'out', targetHandle: 'in', type: 'floating', label: edge.label,
        reconnectable: !edge.activityId && edge.count === 1 && !edge.source.includes(':') && !edge.target.includes(':'), selected,
        data: { state: edge.state, offset: offsets.get(edge.id) ?? 0, dimmed: !incident, count: edge.count, spoke: !!edge.role, ...edgeCallbacks } }
    })
  }, [view, selection, selectedEdgeIds, selectedNodeId, focusIds, edgeCallbacks])

  const center = () => flow.screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 })
  const beginConnection = (connection: Connection) => {
    const target = entities.find(e => e.id === connection.target)
    if (connection.source && target && entities.some(e => e.id === connection.source)) setDraft({ source: connection.source, target: target.id, position: target.position ?? { x: 0, y: 0 }, kind: target.kind, name: target.name, predicate: '' })
  }
  const focusOn = (id: string) => {
    const fact = facts.find(f => f.id === id)
    const group = groups.find(g => g.id === id)
    let ids: string[]
    if (fact) ids = [fact.participants?.length && !lens.collapseActivities ? activityNodeId(fact.id) : '', ...(fact.participants?.map(p => p.entity_id) ?? [fact.subject_id, fact.object_id])].map(x => x.startsWith('act:') ? x : view.repOf(x) ?? '').filter(Boolean)
    else if (group) ids = group.collapsed ? [groupNodeId(group.id)] : group.member_ids.slice(0, 200)
    else {
      const node = view.repOf(id) ?? id
      ids = [node]
      for (const e of view.edges) { if (ids.length > 24) break; if (e.source === node) ids.push(e.target); else if (e.target === node) ids.push(e.source) }
    }
    void flow.fitView({ nodes: [...new Set(ids)].map(x => ({ id: x })), padding: ids.length > 1 ? 0.35 : 1.2, maxZoom: 1.1, duration: 450 })
  }
  useEffect(() => {
    if (!request) return
    props.onRequestDone()
    if (request.type === 'focus' && request.id) focusOn(request.id)
    else if (request.type === 'fit') void flow.fitView({ padding: 0.2, maxZoom: 1.1, duration: 400 })
    else if (request.type === 'arrange') void align()
    else if (request.type === 'arrange-layers') void align('RIGHT', true)
    else if (request.type === 'export') void runExport({ ...exportSettings, format: request.kind === 'svg' ? 'svg' : 'png', area: 'all' }, 'download')
    else if (request.type === 'place') setDraft({ position: center(), kind: request.kind || 'Device', name: '', predicate: '' })
  }, [request?.n])
  useEffect(() => {
    const keyboard = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && (draft || popover || menu || typeEdit || groupDraft)) { setDraft(null); setPopover(null); setMenu(null); setTypeEdit(null); setGroupDraft(null); e.stopImmediatePropagation() }
      if ((e.target as HTMLElement)?.closest('input,textarea,select,[contenteditable]') || e.metaKey || e.ctrlKey || e.altKey) return
      if (document.querySelector('.modal-backdrop, .evidence-backdrop, .command-backdrop')) return
      const key = e.key.toLowerCase()
      if (key === 'n') { setDraft({ position: center(), kind: 'Device', name: '', predicate: '' }); e.preventDefault() }
      if (key === 'f') { if (selection) focusOn(selection.id); else void flow.fitView({ padding: 0.2, maxZoom: 1.1, duration: 400 }); e.preventDefault() }
      if (key === 'g') { const selected = flow.getNodes().filter(n => n.selected && n.type === 'entity'); if (selected.length > 1) { openGroupDraft(selected.map(n => n.id)); e.preventDefault() } }
      if ((e.key === 'Delete' || e.key === 'Backspace') && !draft) { const selected = flow.getNodes().filter(n => n.selected && n.type === 'entity'); if (selected.length > 1) { e.stopImmediatePropagation(); e.preventDefault(); void run(selected.map(n => ({ type: 'entity.delete', payload: { id: n.id } }))).catch(() => {}); onSelect(null) } }
    }
    window.addEventListener('keydown', keyboard, true)
    return () => window.removeEventListener('keydown', keyboard, true)
  }, [draft, popover, menu, typeEdit, groupDraft, nodes, selection, facts, view])
  const save = async () => {
    if (!draft) return
    setBusy(true)
    try {
      const targetId = draft.target || uuid()
      const items: ActionDraft[] = []
      if (!draft.target) items.push({ type: 'entity.add', payload: { id: targetId, name: draft.name.trim(), kind: draft.kind.trim(), ...snapPosition(draft.position) } })
      if (draft.source) {
        if (draft.relationId) items.push({ type: 'fact.update', payload: { id: draft.relationId, predicate: draft.predicate.trim() } })
        else if (!facts.some(f => !f.participants?.length && f.subject_id === draft.source && f.object_id === targetId && f.predicate.toLowerCase() === draft.predicate.trim().toLowerCase()))
          items.push({ type: 'fact.add', payload: { id: uuid(), subject_id: draft.source, object_id: targetId, predicate: draft.predicate.trim() } })
      }
      await run(items)
      setDraft(null)
      onSelect(draft.target ? null : { kind: 'entity', id: targetId })
    } catch { /* shown as canvas error */ } finally { setBusy(false) }
  }
  const openGroupDraft = (members: string[]) => {
    const kinds = new Map<string, number>()
    for (const id of members) { const k = entities.find(e => e.id === id)?.kind; if (k) kinds.set(k, (kinds.get(k) ?? 0) + 1) }
    const main = [...kinds.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'entities'
    setGroupDraft({ members, name: `${members.length} ${main}` }); setPopover(null)
  }
  const saveGroup = async () => {
    if (!groupDraft) return
    const id = uuid()
    const inner = entities.filter(e => groupDraft.members.includes(e.id) && e.position)
    const position = inner.length ? snapPosition({ x: inner.reduce((s, e) => s + e.position!.x, 0) / inner.length, y: inner.reduce((s, e) => s + e.position!.y, 0) / inner.length }) : undefined
    try {
      await run([{ type: 'group.add', payload: { id, name: groupDraft.name.trim(), members: groupDraft.rule ? [] : groupDraft.members, rule: groupDraft.rule ?? null, excluded: [], collapsed: true, ...position } }])
      setGroupDraft(null); onSelect({ kind: 'group', id })
    } catch { /* shown as canvas error */ }
  }
  const align = async (direction = 'RIGHT', byLayer = false) => {
    setBusy(true); setError('')
    try {
      const all = flow.getNodes().filter(n => n.type !== 'frame')
      const selected = all.filter(n => n.selected)
      const chosen = selected.length > 1 ? selected : all
      const isPinned = (n: Node<AnyData>) => n.type === 'entity' && !!(n.data as EntityData).v.entity.pinned
      const movable = chosen.filter(n => !isPinned(n))
      const ids = new Set(movable.map(n => n.id))
      const layerIndex = (id: string) => { const n = view.nodes.find(x => x.id === id); return n && (n.kind === 'entity' || n.kind === 'group') ? LAYERS.findIndex(l => l.id === n.layer) : -1 }
      const partition = (id: string) => {
        const own = layerIndex(id)
        if (own >= 0) return own
        // Activities sit in the lane of what they act on.
        const target = view.edges.find(e => e.source === id && e.role === 'target')
        if (target && layerIndex(target.target) >= 0) return layerIndex(target.target)
        const near = view.edges.filter(e => e.source === id || e.target === id).map(e => layerIndex(e.source === id ? e.target : e.source)).filter(i => i >= 0)
        return near.length ? Math.max(...near) : 0
      }
      const { default: ELK } = await import('elkjs/lib/elk.bundled.js')
      const result = await new ELK().layout({ id: 'root', layoutOptions: { 'elk.algorithm': 'layered', 'elk.direction': direction, 'elk.spacing.nodeNode': '36', 'elk.layered.spacing.nodeNodeBetweenLayers': '110', 'elk.spacing.componentComponent': '60', 'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES', ...(byLayer ? { 'elk.partitioning.activate': 'true' } : {}) },
        children: movable.map(n => ({ id: n.id, width: n.measured?.width ?? NODE_W, height: n.measured?.height ?? NODE_H, ...(byLayer ? { layoutOptions: { 'elk.partitioning.partition': String(partition(n.id)) } } : {}) })),
        edges: view.edges.filter(e => ids.has(e.source) && ids.has(e.target)).map(e => ({ id: e.id, sources: [e.source], targets: [e.target] })) })
      const pinned = chosen.filter(isPinned)
      const offsetX = pinned.length ? Math.max(...pinned.map(n => n.position.x + 350)) : 0
      pendingFit.current = true
      await run((result.children ?? []).map(n => {
        const position = snapPosition({ x: (n.x ?? 0) + offsetX, y: n.y ?? 0 })
        if (n.id.startsWith('group:')) return { type: 'group.update' as const, payload: { id: n.id.slice(6), ...position } }
        if (n.id.startsWith('act:')) return { type: 'fact.position' as const, payload: { id: n.id.slice(4), ...position } }
        return { type: 'entity.position' as const, payload: { id: n.id, ...position } }
      }))
      if (byLayer && !lens.showLanes) props.onLensChange({ ...lens, showLanes: true })
    } catch (e) { setError(String(e)) } finally { setBusy(false) }
  }
  /** Render the current canvas state (filters, layers, groups, activities) to a standalone SVG, optionally rasterised to PNG. */
  const runExport = async (settings: ExportSettings, mode: 'download' | 'copy') => {
    setExporting(true); setError('')
    try {
      await prepareIconMarkup()
      const flowNodes = flow.getNodes()
      const sizes = new Map(flowNodes.filter(n => n.measured?.width && n.measured?.height).map(n => [n.id, { width: n.measured!.width!, height: n.measured!.height! }]))
      let area = null, only = null
      if (settings.area === 'visible' && shellRef.current) {
        const rect = shellRef.current.getBoundingClientRect()
        const a = flow.screenToFlowPosition({ x: rect.left, y: rect.top }), b = flow.screenToFlowPosition({ x: rect.right, y: rect.bottom })
        area = { x: a.x, y: a.y, width: b.x - a.x, height: b.y - a.y }
      }
      if (settings.area === 'selection') {
        only = new Set(flowNodes.filter(n => n.selected).map(n => n.id))
        if (selectedNodeId) only.add(selectedNodeId)
        if (!only.size) throw new Error('Select nodes first (click, or Shift + drag) to export a selection.')
        // Activities between selected participants come along so their spokes stay intact.
        for (const edge of view.edges) if (edge.activityId && (only.has(edge.source) || only.has(edge.target))) only.add(edge.source.startsWith('act:') ? edge.source : edge.target)
      }
      const theme = settings.theme === 'current' ? props.theme : settings.theme
      const result = buildGraphSvg({ nodes: view.nodes, edges: view.edges, entityTypes, theme, sizes, area, only, legend: settings.legend,
        transparent: settings.transparent, measure: browserMeasure, icon: iconMarkup,
        title: settings.title ? props.boardName : undefined,
        subtitle: settings.title ? [props.filterSummary, `exported ${new Date().toLocaleString('en-GB')}`].filter(Boolean).join(' · ') : undefined })
      if (!result.nodeCount) throw new Error('Nothing to export in this area.')
      if (settings.format === 'svg') {
        if (mode === 'copy') { await navigator.clipboard.writeText(result.svg); props.onNotice('SVG markup copied') }
        else { downloadBlob(new Blob([result.svg], { type: 'image/svg+xml;charset=utf-8' }), exportFilename(props.boardName, 'svg')); props.onNotice(`SVG exported · ${result.nodeCount} nodes`) }
      } else {
        const { blob, scale } = await svgToPng(result.svg, result.width, result.height, settings.scale)
        const note = scale < settings.scale - 0.01 ? ` · reduced to ${scale.toFixed(2)}× (browser size limit; use SVG for full detail)` : ''
        if (mode === 'copy') { await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]); props.onNotice(`PNG copied to clipboard${note}`) }
        else { downloadBlob(blob, exportFilename(props.boardName, 'png')); props.onNotice(`PNG exported · ${Math.round(result.width * scale)}×${Math.round(result.height * scale)} px${note}`) }
      }
      setPopover(null)
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) } finally { setExporting(false) }
  }
  const moveDrafts = (moved: Node<AnyData>[]): ActionDraft[] => moved.filter(n => n.type !== 'frame').map(n => {
    const position = grid ? snapPosition(n.position) : n.position
    if (n.type === 'group') return { type: 'group.update', payload: { id: n.id.slice(6), ...position } }
    if (n.type === 'activity') return { type: 'fact.position', payload: { id: n.id.slice(4), ...position } }
    return { type: 'entity.position', payload: { id: n.id, ...position } }
  })
  const toggle = (key: string, value: boolean, set: (v: boolean) => void) => { set(value); savePref(key, value) }
  const setLayer = (id: string, on: boolean) => {
    const current = new Set(lens.layers ?? LAYERS.map(l => l.id))
    if (on) current.add(id); else current.delete(id)
    props.onLensChange({ ...lens, layers: current.size === LAYERS.length ? null : current })
  }
  const selectedNodes = nodes.filter(n => n.selected && n.type === 'entity')
  const kinds = [...new Set([...builtInKinds, ...entityTypes.map(t => t.name), ...entities.map(e => e.kind)])].filter(k => k.toLowerCase().includes(typeSearch.toLowerCase()))
  const menuEntity = menu?.kind === 'entity' ? entities.find(e => e.id === menu.id) : undefined
  const menuGroup = menu?.kind === 'group' ? groups.find(g => g.id === menu.id) : undefined
  const memberGroup = menuEntity ? view.groupOf.get(menuEntity.id) : undefined
  const containerGroup = menuEntity ? groups.find(g => g.rule?.container_id === menuEntity.id) : undefined
  const nameOf = (id?: string) => entities.find(e => e.id === id)?.name ?? 'New entity'
  const hiddenLayers = lens.layers ? LAYERS.length - lens.layers.size : 0
  return <div ref={shellRef} className={`graph-shell flow-shell${far ? ' zoom-far' : ''}${focusIds ? ' has-focus' : ''}`} onDragOver={e => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy' }} onDrop={e => {
    e.preventDefault(); const kind = e.dataTransfer.getData('application/factgraph-kind'); if (kind) { setDraft({ position: flow.screenToFlowPosition({ x: e.clientX, y: e.clientY }), kind, name: '', predicate: '' }); setPopover(null) }
  }}>
    <ArrowDefs />
    <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes} onNodesChange={onNodesChange}
      onNodeClick={(_, n) => {
        cancelSelect(); setMenu(null)
        const next: Selection = n.type === 'group' ? { kind: 'group', id: n.id.slice(6) } : n.type === 'activity' ? { kind: 'fact', id: n.id.slice(4) } : n.type === 'entity' ? { kind: 'entity', id: n.id } : null
        if (next) clickTimer.current = setTimeout(() => onSelect(next), n.type === 'entity' ? 220 : 0)
      }}
      onNodeDoubleClick={(_, n) => { if (n.type === 'group') handlers.current.toggleGroup(n.id.slice(6), false) }}
      onEdgeClick={(_, edge) => pickEdge.current(edge.id)}
      onEdgeDoubleClick={(_, edge) => editEdge.current(edge.id)}
      onPaneClick={() => { onSelect(null); setMenu(null) }} onConnect={beginConnection}
      // Right-drag pans the canvas; suppress the browser menu that would otherwise open on release.
      onPaneContextMenu={event => event.preventDefault()} onEdgeContextMenu={event => event.preventDefault()}
      onConnectEnd={(event, state) => {
        if (state.isValid || !state.fromNode || state.fromHandle?.type !== 'source' || state.fromNode.type !== 'entity') return
        const target = event.target as HTMLElement
        if (!target.closest('.react-flow__pane')) return
        const point = 'changedTouches' in event ? event.changedTouches[0] : event
        setDraft({ source: state.fromNode.id, position: flow.screenToFlowPosition({ x: point.clientX, y: point.clientY }), kind: 'Device', name: '', predicate: '' })
      }}
      onReconnect={(edge, c) => { if (entities.some(e => e.id === c.source) && entities.some(e => e.id === c.target)) void run([{ type: 'fact.update', payload: { id: edge.id, subject_id: c.source, object_id: c.target } }]).catch(() => {}) }}
      onNodeDragStop={(_, node, moved) => { void run(moveDrafts(moved.length ? moved : [node])).catch(() => {}) }}
      onNodeContextMenu={(e, n) => {
        e.preventDefault()
        if (n.type === 'entity') { onSelect({ kind: 'entity', id: n.id }); setMenu({ id: n.id, kind: 'entity', x: e.clientX, y: e.clientY }) }
        else if (n.type === 'group') { onSelect({ kind: 'group', id: n.id.slice(6) }); setMenu({ id: n.id.slice(6), kind: 'group', x: e.clientX, y: e.clientY }) }
      }}
      onDoubleClick={e => { if ((e.target as HTMLElement).classList.contains('react-flow__pane')) setDraft({ position: flow.screenToFlowPosition({ x: e.clientX, y: e.clientY }), kind: 'Device', name: '', predicate: '' }) }}
      deleteKeyCode={null} selectionOnDrag panOnDrag={[1, 2]} zoomOnScroll zoomOnPinch panActivationKeyCode="Space" zoomOnDoubleClick={false} selectionKeyCode="Shift" multiSelectionKeyCode="Shift"
      minZoom={0.05} maxZoom={2.5} snapToGrid={grid} snapGrid={[20, 20]} connectionRadius={40} colorMode={props.theme} onlyRenderVisibleElements proOptions={{ hideAttribution: true }}>
      <Background variant={BackgroundVariant.Dots} gap={20} size={1.2} />
      <Controls showInteractive={false} fitViewOptions={{ padding: 0.2, maxZoom: 1.1, duration: 300 }} position="bottom-left" />
      {minimap && <MiniMap pannable zoomable position="bottom-right" nodeBorderRadius={6} nodeColor={n => n.type === 'entity' ? (n.data as EntityData).color : n.type === 'group' ? 'var(--accent)' : 'transparent'} maskColor="var(--minimap-mask)" />}
    </ReactFlow>
    <div className="canvas-toolbar" role="toolbar" aria-label="Canvas tools">
      <button className={`tool-primary${popover === 'palette' ? ' active' : ''}`} onClick={() => setPopover(popover === 'palette' ? null : 'palette')} title="Add entity · N"><Plus size={15} /><span>Add entity</span></button>
      <span className="tool-sep" />
      <button onClick={() => void align()} disabled={busy} title="Auto layout selection or whole graph (left → right)" aria-label="Arrange"><Sparkles size={15} /><span>Arrange</span></button>
      <button className="icon-only" onClick={() => void align('DOWN')} disabled={busy} title="Arrange top to bottom" aria-label="Arrange top to bottom"><ArrowDown size={15} /></button>
      <span className="tool-sep" />
      <button className={`${popover === 'layers' || hiddenLayers || lens.showLanes || lens.collapseActivities ? 'active' : ''}`} onClick={() => setPopover(popover === 'layers' ? null : 'layers')} title="Layers & perspectives" aria-label="Layers"><Layers size={15} /><span>{props.activePerspective ? props.perspectives.find(p => p.id === props.activePerspective)?.name ?? 'Layers' : hiddenLayers ? `${LAYERS.length - hiddenLayers}/${LAYERS.length} layers` : 'Layers'}</span></button>
      <button className={`${popover === 'suggest' ? 'active' : ''}`} onClick={() => setPopover(popover === 'suggest' ? null : 'suggest')} title="Group suggestions" aria-label="Group suggestions"><Boxes size={15} /><span>Groups</span>{suggestions.length > 0 && <b className="tool-badge">{suggestions.length}</b>}</button>
      <span className="tool-sep" />
      <button className={`icon-only${focusMode ? ' active' : ''}`} aria-pressed={focusMode} onClick={() => toggle('focus', !focusMode, setFocusMode)} title="Focus: highlight neighbours of the selection"><Crosshair size={15} /></button>
      <button className={`icon-only${grid ? ' active' : ''}`} aria-pressed={grid} onClick={() => toggle('snap', !grid, setGrid)} title="Snap to grid"><Grid3x3 size={15} /></button>
      <button className={`icon-only${minimap ? ' active' : ''}`} aria-pressed={minimap} onClick={() => { setMinimapPref(!minimap); savePref('minimap', !minimap) }} title="Minimap"><MapIcon size={15} /></button>
      <span className="tool-sep" />
      <button className={`icon-only${popover === 'export' ? ' active' : ''}`} onClick={() => setPopover(popover === 'export' ? null : 'export')} title="Export as PNG or SVG" aria-label="Export image"><ImageDown size={15} /></button>
    </div>
    {popover === 'export' && <div className="export-popover popover" role="dialog" aria-label="Export image">
      <div className="popover-head"><strong>Export image</strong><button className="icon-button" aria-label="Close export" onClick={() => setPopover(null)}><X size={15} /></button></div>
      <div className="segmented full" role="group" aria-label="Format">{(['png', 'svg'] as const).map(f => <button key={f} className={exportSettings.format === f ? 'active' : ''} aria-pressed={exportSettings.format === f} onClick={() => setExportSettings({ ...exportSettings, format: f })}>{f.toUpperCase()}</button>)}</div>
      <p className="hint">{exportSettings.format === 'svg' ? 'Vector file for reports and slides; text stays editable in Illustrator, Inkscape, Word or PowerPoint.' : 'Image for chats, tickets and documents.'} The export shows what the canvas shows: filters, hidden layers, groups and activities.</p>
      <label>Area<select aria-label="Export area" value={exportSettings.area} onChange={e => setExportSettings({ ...exportSettings, area: e.target.value as ExportSettings['area'] })}>
        <option value="all">Whole graph</option><option value="visible">Visible area</option><option value="selection">Selection</option></select></label>
      <div className="field-grid">
        <label>Theme<select aria-label="Export theme" value={exportSettings.theme} onChange={e => setExportSettings({ ...exportSettings, theme: e.target.value as ExportSettings['theme'] })}><option value="current">Current</option><option value="light">Light</option><option value="dark">Dark</option></select></label>
        {exportSettings.format === 'png' && <label>Resolution<select aria-label="Export resolution" value={exportSettings.scale} onChange={e => setExportSettings({ ...exportSettings, scale: Number(e.target.value) })}><option value={1}>1×</option><option value={2}>2× (sharp)</option><option value={3}>3× (print)</option></select></label>}
      </div>
      <label className="check"><input type="checkbox" checked={exportSettings.title} onChange={e => setExportSettings({ ...exportSettings, title: e.target.checked })} /> Title, filters and date</label>
      <label className="check"><input type="checkbox" checked={exportSettings.legend} onChange={e => setExportSettings({ ...exportSettings, legend: e.target.checked })} /> Status legend and counts</label>
      <label className="check"><input type="checkbox" checked={exportSettings.transparent} onChange={e => setExportSettings({ ...exportSettings, transparent: e.target.checked })} /> Transparent background</label>
      <div className="composer-actions">
        <button className="secondary-button small" disabled={exporting} onClick={() => void runExport(exportSettings, 'copy')}><ClipboardCopy size={14} /> Copy</button>
        <button className="primary-button" disabled={exporting} onClick={() => void runExport(exportSettings, 'download')}><Download size={14} /> {exporting ? 'Rendering…' : `Download ${exportSettings.format.toUpperCase()}`}</button>
      </div>
    </div>}
    {popover === 'palette' && <div className="entity-palette popover">
      <div className="popover-head"><strong>Add entity</strong><button className="icon-button" aria-label="Close palette" onClick={() => setPopover(null)}><X size={15} /></button></div>
      <label className="input-with-icon"><Search size={14} /><input autoFocus placeholder="Find or create a type…" value={typeSearch} onChange={e => setTypeSearch(e.target.value)} /></label>
      <p className="hint">Click to place in the centre, or drag onto the canvas.</p>
      <div className="palette-grid">
        {[...kinds, ...(typeSearch.trim() && !kinds.some(k => k.toLowerCase() === typeSearch.trim().toLowerCase()) ? [typeSearch.trim()] : [])].map(kind => {
          const color = typeByName.get(kind)?.color || entityVisual(kind).border
          return <button key={kind} draggable style={{ '--entity-color': color } as CSSProperties} onDragStart={e => e.dataTransfer.setData('application/factgraph-kind', kind)}
            onClick={() => { setDraft({ position: center(), kind, name: '', predicate: '' }); setPopover(null) }}><span className="palette-icon"><KindIcon kind={kind} icon={typeByName.get(kind)?.icon} size={14} /></span>{kind}</button>
        })}
      </div>
      <button className="ghost-button full" onClick={() => setTypeEdit({ id: uuid(), name: typeSearch, color: '#8da9ce', icon: 'Box' })}><Settings2 size={14} /> Manage types…</button>
    </div>}
    {popover === 'layers' && <div className="layers-popover popover" role="dialog" aria-label="Layers and perspectives">
      <div className="popover-head"><strong>Layers</strong><div className="head-actions">
        <button className="text-button" onClick={() => props.onLensChange({ ...lens, layers: null })}>All</button>
        <button className="icon-button" aria-label="Close layers" onClick={() => setPopover(null)}><X size={15} /></button></div></div>
      <div className="layer-list">{LAYERS.map(layer => <label key={layer.id} className="layer-row" title={layer.hint}>
        <input type="checkbox" checked={!lens.layers || lens.layers.has(layer.id)} onChange={e => setLayer(layer.id, e.target.checked)} />
        <span className="layer-name">{layer.label}</span><span className="count">{layerCounts.get(layer.id) ?? 0}</span>
        <button type="button" className="text-button only" onClick={event => { event.preventDefault(); props.onLensChange({ ...lens, layers: new Set([layer.id]) }) }}>only</button></label>)}</div>
      <div className="menu-sep" />
      <label className="check"><input type="checkbox" checked={lens.showLanes} onChange={e => props.onLensChange({ ...lens, showLanes: e.target.checked })} /> Show layer lanes</label>
      <label className="check"><input type="checkbox" checked={lens.collapseActivities} onChange={e => props.onLensChange({ ...lens, collapseActivities: e.target.checked })} /> Show activities as edges</label>
      <button className="secondary-button small full" disabled={busy} onClick={() => { void align('RIGHT', true); setPopover(null) }}><Columns3 size={14} /> Arrange by layer</button>
      <div className="menu-sep" />
      <div className="popover-sub">Perspectives</div>
      {props.perspectives.map(p => <div key={p.id} className={`perspective-row${props.activePerspective === p.id ? ' active' : ''}`}>
        <button onClick={() => props.onApplyPerspective(props.activePerspective === p.id ? null : p.id)}>{p.name}<small>{p.layers ? `${p.layers.length} layers` : 'all layers'}</small></button>
        <button className="icon-button" aria-label={`Delete perspective ${p.name}`} onClick={() => props.onDeletePerspective(p.id)}><Trash2 size={13} /></button></div>)}
      <form className="inline-form" onSubmit={e => { e.preventDefault(); if (perspectiveName.trim()) { props.onSavePerspective(perspectiveName.trim()); setPerspectiveName('') } }}>
        <input placeholder="Save current view as…" value={perspectiveName} onChange={e => setPerspectiveName(e.target.value)} aria-label="Perspective name" />
        <button className="icon-button" aria-label="Save perspective" disabled={!perspectiveName.trim()}><Save size={14} /></button></form>
    </div>}
    {popover === 'suggest' && <div className="suggest-popover popover" role="dialog" aria-label="Group suggestions">
      <div className="popover-head"><strong>Group suggestions</strong><button className="icon-button" aria-label="Close suggestions" onClick={() => setPopover(null)}><X size={15} /></button></div>
      <p className="hint">Entities of one type with identical connections. Those that differ stay separate — they are usually the interesting ones.</p>
      <div className="suggest-list">
        {suggestions.map(s => <div key={s.id} className="suggest-item">
          <div><strong>{s.name}</strong><small>{s.reason}</small>
            {s.outliers.length > 0 && <button className="outlier-link" onClick={() => { onSelect({ kind: 'entity', id: s.outliers[0] }); focusOn(s.outliers[0]) }}>{s.outliers.length} similar {s.outliers.length === 1 ? 'entity differs' : 'entities differ'}: {s.outliers.slice(0, 2).map(nameOf).join(', ')}</button>}</div>
          <button className="secondary-button small" onClick={() => { setGroupDraft({ members: s.members, name: s.name, rule: s.rule }); setPopover(null) }}><GroupIcon size={13} /> Group</button>
        </div>)}
        {!suggestions.length && <p className="muted small">No suggestions. Select several entities and press <kbd>G</kbd> to group them manually.</p>}
      </div>
      <div className="menu-sep" />
      <p className="hint">Groups: {groups.length ? groups.map(g => g.name).join(', ') : 'none yet'}</p>
    </div>}
    {typeEdit && <div className="canvas-composer popover" role="dialog" aria-label="Entity type editor"><form onSubmit={e => { e.preventDefault(); void run([{ type: entityTypes.some(t => t.id === typeEdit.id) ? 'type.update' : 'type.add', payload: { ...typeEdit } }]).then(() => setTypeEdit(null)).catch(() => {}) }}>
      <div className="popover-head"><strong>Entity type</strong><button type="button" className="icon-button" aria-label="Close type editor" onClick={() => setTypeEdit(null)}><X size={15} /></button></div>
      <label>Existing type<select value={entityTypes.some(t => t.id === typeEdit.id) ? typeEdit.id : ''} onChange={e => setTypeEdit(entityTypes.find(t => t.id === e.target.value) ?? { id: uuid(), name: '', color: '#8da9ce', icon: 'Box' })}><option value="">New type</option>{entityTypes.map(t => <option value={t.id} key={t.id}>{t.name}</option>)}</select></label>
      <label>Type name<input required value={typeEdit.name} onChange={e => setTypeEdit({ ...typeEdit, name: e.target.value })} /></label>
      <div className="field-grid"><label>Icon<select value={typeEdit.icon} onChange={e => setTypeEdit({ ...typeEdit, icon: e.target.value })}>{Object.keys(typeIcons).map(icon => <option key={icon}>{icon}</option>)}</select></label>
        <label>Default color<input type="color" className="color-input" value={typeEdit.color} onChange={e => setTypeEdit({ ...typeEdit, color: e.target.value })} /></label></div>
      <label>Layer<select value={typeEdit.layer ?? ''} onChange={e => setTypeEdit({ ...typeEdit, layer: e.target.value || undefined })}><option value="">Automatic ({LAYERS.find(l => l.id === layerOf({ kind: typeEdit.name }))?.label})</option>{LAYERS.map(l => <option key={l.id} value={l.id}>{l.label}</option>)}</select></label>
      <div className="composer-actions">{entityTypes.some(t => t.id === typeEdit.id) && <button type="button" className="ghost-button danger" onClick={() => void run([{ type: 'type.delete', payload: { id: typeEdit.id } }]).then(() => setTypeEdit(null)).catch(() => {})}>Delete unused type</button>}<button className="primary-button">Save type</button></div>
    </form></div>}
    {selectedNodes.length > 1 && <div className="selection-tools"><span>{selectedNodes.length} selected</span>
      <button onClick={() => openGroupDraft(selectedNodes.map(n => n.id))} title="Group · G"><GroupIcon size={13} /> Group</button>
      <button onClick={() => { const y = selectedNodes[0].position.y; void run(selectedNodes.map(n => ({ type: 'entity.position', payload: { id: n.id, x: n.position.x, y } }))).catch(() => {}) }}>Align row</button>
      <button onClick={() => { const x = selectedNodes[0].position.x; void run(selectedNodes.map(n => ({ type: 'entity.position', payload: { id: n.id, x, y: n.position.y } }))).catch(() => {}) }}>Align column</button>
      <button onClick={() => { const sorted = [...selectedNodes].sort((a, b) => a.position.x - b.position.x); void run(sorted.map((n, i) => ({ type: 'entity.position', payload: { id: n.id, x: sorted[0].position.x + i * 280, y: n.position.y } }))).catch(() => {}) }}>Distribute</button>
      <button onClick={() => void align()}>Arrange selection</button>
    </div>}
    {menu && (menuEntity || menuGroup) && <div className="canvas-menu popover" role="menu" style={{ left: Math.min(menu.x, window.innerWidth - 230), top: Math.min(menu.y, window.innerHeight - 320) }}>
      {menuEntity && <>
        <button onClick={() => { props.onEdit(menu.id); setMenu(null) }}><Pencil size={14} /> Edit name, type & color</button>
        <button onClick={() => { setDraft({ source: menu.id, position: { x: (menuEntity.position?.x ?? 0) + 320, y: menuEntity.position?.y ?? 0 }, kind: 'Device', name: '', predicate: '' }); setMenu(null) }}><Plus size={14} /> Add connected entity</button>
        <button onClick={() => { props.onMerge(menu.id); setMenu(null) }}><Merge size={14} /> Merge entity…</button>
        {containers.has(menu.id) && !containerGroup && <button onClick={() => { void run([{ type: 'group.add', payload: { id: uuid(), name: `${menuEntity.name} contents`, members: [], rule: { container_id: menu.id }, excluded: [], collapsed: true } }]).catch(() => {}); setMenu(null) }}><FolderTree size={14} /> Collapse contents</button>}
        {containerGroup && <button onClick={() => { handlers.current.toggleGroup(containerGroup.id, !containerGroup.collapsed); setMenu(null) }}><FolderTree size={14} /> {containerGroup.collapsed ? 'Show contents' : 'Collapse contents'}</button>}
        {memberGroup && <button onClick={() => { void run([{ type: 'group.update', payload: { id: memberGroup.id, exclude: [menu.id] } }]).catch(() => {}); setMenu(null) }}><Ungroup size={14} /> Take out of “{memberGroup.name}”</button>}
        <button onClick={() => { props.onCopy(menu.id, 'Entity ID'); setMenu(null) }}><Copy size={14} /> Copy ID</button>
        <button onClick={() => { void run([{ type: 'entity.update', payload: { id: menu.id, pinned: !menuEntity.pinned } }]).catch(() => {}); setMenu(null) }}>{menuEntity.pinned ? <><PinOff size={14} /> Unpin</> : <><Pin size={14} /> Pin position</>}</button>
        <div className="menu-sep" />
        <button className="danger" onClick={() => { void run([{ type: 'entity.delete', payload: { id: menu.id } }]).catch(() => {}); setMenu(null); onSelect(null) }}><Trash2 size={14} /> Delete · undo available</button>
      </>}
      {menuGroup && <>
        <button onClick={() => { handlers.current.toggleGroup(menuGroup.id, !menuGroup.collapsed); setMenu(null) }}><Workflow size={14} /> {menuGroup.collapsed ? 'Expand group' : 'Collapse group'}</button>
        <button onClick={() => { const name = window.prompt('Group name', menuGroup.name); if (name?.trim()) void run([{ type: 'group.update', payload: { id: menuGroup.id, name: name.trim() } }]).catch(() => {}); setMenu(null) }}><Pencil size={14} /> Rename group</button>
        <div className="menu-sep" />
        <button className="danger" onClick={() => { void run([{ type: 'group.delete', payload: { id: menuGroup.id } }]).catch(() => {}); setMenu(null); onSelect(null) }}><Ungroup size={14} /> Ungroup · entities stay</button>
      </>}
    </div>}
    {groupDraft && <div className="canvas-composer popover" role="dialog" aria-label="Create group">
      <form onSubmit={e => { e.preventDefault(); void saveGroup() }}>
        <div className="popover-head"><strong>Create group</strong><button type="button" className="icon-button" aria-label="Cancel group" onClick={() => setGroupDraft(null)}><X size={15} /></button></div>
        <label>Group name<input autoFocus required value={groupDraft.name} onChange={e => setGroupDraft({ ...groupDraft, name: e.target.value })} /></label>
        <p className="hint">{groupDraft.rule ? `Rule: every entity of type ${groupDraft.rule.kinds.join(', ')} — new ones join automatically.` : `${groupDraft.members.length} entities. Take single entities out later via right-click or the inspector.`} The group only changes the view; relationships and evidence stay untouched.</p>
        <div className="composer-actions"><button className="primary-button">Create collapsed group</button></div>
      </form>
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
