import { memo, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { ReactFlow, ReactFlowProvider, Background, Controls, MiniMap, Handle, Position, MarkerType,
  useReactFlow, useNodesState, type Node, type NodeProps, type Connection, type XYPosition } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { Box, User, Monitor, KeyRound, Cloud, FileText, Network, Layers, Plus, Search, X, Pin, Sparkles, Copy } from 'lucide-react'
import type { Entity, EntityType, Fact } from './types'
import type { ActionDraft } from './board'
import { snapPosition } from './layout'
import { entityVisual } from './entityVisual'
import { uuid } from './uuid'

type Selection = { kind: 'entity' | 'fact'; id: string } | null
type Props = {
  entityTypes: EntityType[]; entities: Entity[]; facts: Fact[]; selection: Selection; search: string; pathIds: string[];
  onSelect: (value: Selection) => void; onCreateNode: () => void;
  onCreateRelation: (sourceId: string, targetId?: string) => void;
  onMoveNode: (id: string, position: XYPosition) => void;
  onCommand: (drafts: ActionDraft[]) => Promise<unknown>;
  onEdit: (id: string) => void; onMerge: (id: string) => void;
}
const builtInKinds = ['User', 'Device', 'IP', 'Service Principal', 'AKS Cluster', 'File', 'Repository', 'Credential', 'Environment Variable', 'Blob Storage']
const typeIcons = {Box, User, Monitor, KeyRound, Cloud, FileText, Network, Layers}
function KindIcon({kind,icon}: {kind: string;icon?: string}) {
  const Icon = icon && icon in typeIcons ? typeIcons[icon as keyof typeof typeIcons] : /user|person/i.test(kind) ? User : /device|host|system/i.test(kind) ? Monitor : /secret|credential|variable/i.test(kind) ? KeyRound : /file|repo/i.test(kind) ? FileText : /aks/i.test(kind) ? Layers : /ip/i.test(kind) ? Network : /cloud|storage|principal/i.test(kind) ? Cloud : Box
  return <Icon size={20}/>
}
type CardData = { entity: Entity; icon?: string; dimmed: boolean; rename: (id: string, name: string) => void; cancelSelect: () => void }
const EntityCard = memo(function EntityCard({data, selected}: NodeProps<Node<CardData>>) {
  const {entity} = data
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(entity.name)
  useEffect(() => setName(entity.name), [entity.name])
  const color = entity.color || entityVisual(entity.kind).border
  return <div className={`entity-node ${selected ? 'selected' : ''} ${data.dimmed ? 'dimmed' : ''}`} style={{'--entity-color':color} as CSSProperties}>
    <Handle type="target" position={Position.Left} id="in" aria-label={`Connect to ${entity.name}`} />
    <div className="node-icon"><KindIcon kind={entity.kind} icon={data.icon}/></div>
    <div className="node-copy"><small>{entity.kind} {entity.pinned && <Pin size={11}/>}</small>
      {editing ? <form className="nodrag" onSubmit={event => {event.preventDefault(); if(name.trim()) {data.rename(entity.id,name.trim()); setEditing(false)}}}>
        <input autoFocus aria-label="Entity name" value={name} onChange={e=>setName(e.target.value)} onKeyDown={e=>{if(e.key==='Escape'){setEditing(false);setName(entity.name); e.stopPropagation()}}}/>
      </form> : <strong onDoubleClick={event=>{event.stopPropagation();data.cancelSelect();setEditing(true)}} title="Double-click to rename">{entity.name}</strong>}
      <span>{entity.identifiers[0]?.raw_value || 'Investigation entity'}</span>
    </div>
    <Handle type="source" position={Position.Right} id="out" aria-label={`Connect from ${entity.name}`} />
  </div>
})
const nodeTypes = { entity: EntityCard }
type Draft = {position: XYPosition; source?: string; target?: string; kind: string; name: string; predicate: string; relationId?: string}

function Canvas(props: Props) {
  const {entities, facts, selection, search, onSelect, onCommand, entityTypes} = props
  const flow = useReactFlow<Node<CardData>>()
  const [nodes, setNodes, onNodesChange] = useNodesState<Node<CardData>>([])
  const [palette, setPalette] = useState(false)
  const [typeEdit, setTypeEdit] = useState<EntityType|null>(null)
  const [typeSearch, setTypeSearch] = useState('')
  const [draft, setDraft] = useState<Draft | null>(null)
  const [menu, setMenu] = useState<{id:string;x:number;y:number}|null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [grid, setGrid] = useState(true)
  const [minimap, setMinimap] = useState(false)
  const fitted = useRef(false)
  const clickTimer = useRef<ReturnType<typeof setTimeout>|undefined>(undefined)
  const cancelSelect = () => {if(clickTimer.current) clearTimeout(clickTimer.current)}
  useEffect(()=>()=>cancelSelect(),[])
  const run = async (drafts: ActionDraft[]) => {setError(''); try {await onCommand(drafts)} catch(e){setError(String(e)); throw e}}
  const rename = (id:string,name:string) => {void run([{type:'entity.update',payload:{id,name}}]).catch(()=>{})}
  useEffect(() => {
    setNodes(current => entities.map(entity => {
      const previous = current.find(n=>n.id===entity.id)
      const dimmed = !!search && !`${entity.name} ${entity.kind} ${entity.identifiers.map(i=>i.raw_value).join(' ')}`.toLowerCase().includes(search.toLowerCase())
      return {id:entity.id,type:'entity',position:previous?.dragging ? previous.position : entity.position ?? {x:0,y:0},
        selected: previous?.selected || selection?.id===entity.id, draggable:!entity.pinned,
        data:{entity: {...entity, color:entity.color || entityTypes.find(t=>t.name===entity.kind)?.color},icon:entityTypes.find(t=>t.name===entity.kind)?.icon,dimmed,rename,cancelSelect}}
    }))
  },[entities, selection, search, entityTypes])
  useEffect(()=>{if(!fitted.current && nodes.length){fitted.current=true; requestAnimationFrame(()=>void flow.fitView({padding:0.25,maxZoom:1.2}))}},[nodes.length,flow])
  const edges = useMemo(()=>facts.map(fact=>({id:fact.id,source:fact.subject_id,target:fact.object_id,
    sourceHandle:'out',targetHandle:'in',label:fact.predicate,type:'default',reconnectable:true,
    selected:selection?.id===fact.id,markerEnd:{type:MarkerType.ArrowClosed,color:fact.truth_state==='disputed'?'#edb36b':fact.truth_state==='refuted'?'#f28e9e':'#829bb9'},
    style:{stroke:fact.truth_state==='supported'?'#79cfb5':fact.truth_state==='disputed'?'#edb36b':fact.truth_state==='refuted'?'#f28e9e':'#829bb9',strokeWidth:selection?.id===fact.id?3:1.8,strokeDasharray:fact.truth_state==='unknown'?'5 5':undefined},
    labelStyle:{fill:'#e2eaf5',fontSize:11,fontWeight:600},labelBgStyle:{fill:'#182538'},labelBgPadding:[8,5] as [number,number],labelBgBorderRadius:5
  })),[facts,selection])
  const beginConnection = (connection:Connection) => {
    const target=entities.find(e=>e.id===connection.target)
    if(connection.source && target) setDraft({source:connection.source,target:target.id,position:target.position??{x:0,y:0},kind:target.kind,name:target.name,predicate:''})
  }
  useEffect(() => {
    const keyboard=(e:KeyboardEvent)=>{
      if(e.key==='Escape' && (draft||palette||menu||typeEdit)){setDraft(null);setPalette(false);setMenu(null);setTypeEdit(null);e.stopImmediatePropagation()}
      if((e.target as HTMLElement)?.closest('input,textarea,select,[contenteditable]')) return
      if(e.key.toLowerCase()==='n'&&!e.metaKey&&!e.ctrlKey){setDraft({position:flow.screenToFlowPosition({x:window.innerWidth/2,y:window.innerHeight/2}),kind:'Device',name:'',predicate:''});e.preventDefault()}
      if((e.key==='Delete'||e.key==='Backspace')&&!draft){const selected=flow.getNodes().filter(n=>n.selected);if(selected.length>1){e.stopImmediatePropagation();e.preventDefault();void run(selected.map(n=>({type:'entity.delete',payload:{id:n.id}}))).catch(()=>{});onSelect(null)}}
    }
    window.addEventListener('keydown',keyboard,true)
    return ()=>window.removeEventListener('keydown',keyboard,true)
  },[draft,palette,menu,typeEdit,nodes])
  const save = async () => {
    if(!draft) return
    setBusy(true)
    try {
      const targetId=draft.target || uuid()
      const items:ActionDraft[]=[]
      if(!draft.target) items.push({type:'entity.add',payload:{id:targetId,name:draft.name.trim(),kind:draft.kind.trim(),...snapPosition(draft.position)}})
      if(draft.source) {
        if(draft.relationId) items.push({type:'fact.update',payload:{id:draft.relationId,predicate:draft.predicate.trim()}})
        else if(!facts.some(f=>f.subject_id===draft.source && f.object_id===targetId && f.predicate.toLowerCase()===draft.predicate.trim().toLowerCase()))
          items.push({type:'fact.add',payload:{id:uuid(),subject_id:draft.source,object_id:targetId,predicate:draft.predicate.trim()}})
      }
      await run(items)
      setDraft(null)
      onSelect(null)
    } catch {/* show local error */} finally {setBusy(false)}
  }
  const align = async (direction='RIGHT') => {
    setBusy(true);setError('')
    try {
      const selected=flow.getNodes().filter(n=>n.selected)
      const chosen=selected.length>1?selected:flow.getNodes()
      const movable=chosen.filter(n=>!n.data.entity.pinned)
      const ids=new Set(movable.map(n=>n.id))
      const {default: ELK} = await import('elkjs/lib/elk.bundled.js')
      const result=await new ELK().layout({id:'root',layoutOptions:{'elk.algorithm':'layered','elk.direction':direction,'elk.spacing.nodeNode':'60','elk.layered.spacing.nodeNodeBetweenLayers':'110'},
        children:movable.map(n=>({id:n.id,width:240,height:90})),edges:facts.filter(f=>ids.has(f.subject_id)&&ids.has(f.object_id)).map(f=>({id:f.id,sources:[f.subject_id],targets:[f.object_id]}))})
      const pinned=chosen.filter(n=>n.data.entity.pinned)
      const offsetX=pinned.length?Math.max(...pinned.map(n=>n.position.x+350)):0
      await run((result.children??[]).map(n=>({type:'entity.position',payload:{id:n.id,...snapPosition({x:(n.x??0)+offsetX,y:n.y??0})}})))
    } catch(e){setError(String(e))} finally {setBusy(false)}
  }
  const selectedNodes=nodes.filter(n=>n.selected)
  const kinds=[...new Set([...builtInKinds,...entityTypes.map(t=>t.name),...entities.map(e=>e.kind)])].filter(k=>k.toLowerCase().includes(typeSearch.toLowerCase()))
  const menuEntity=entities.find(e=>e.id===menu?.id)
  return <div className="graph-shell flow-shell" onDragOver={e=>{e.preventDefault();e.dataTransfer.dropEffect='copy'}} onDrop={e=>{
    e.preventDefault();const kind=e.dataTransfer.getData('application/factgraph-kind');if(kind) {setDraft({position:flow.screenToFlowPosition({x:e.clientX,y:e.clientY}),kind,name:'',predicate:''});setPalette(false)}
  }}>
    <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} onNodesChange={onNodesChange}
      onNodeClick={(_,n)=>{cancelSelect();clickTimer.current=setTimeout(()=>onSelect({kind:'entity',id:n.id}),320);setMenu(null)}} onEdgeClick={(_,edge)=>onSelect({kind:'fact',id:edge.id})}
      onEdgeDoubleClick={(_,edge)=>setDraft({source:edge.source,target:edge.target,position:{x:0,y:0},kind:'',name:'',predicate:String(edge.label),relationId:edge.id})}
      onPaneClick={()=>{onSelect(null);setMenu(null)}} onConnect={beginConnection}
      onConnectEnd={(event,state)=>{
        if(state.isValid || !state.fromNode || state.fromHandle?.type!=='source') return
        const target=event.target as HTMLElement
        if(!target.closest('.react-flow__pane')) return
        const point='changedTouches' in event? event.changedTouches[0]:event
        setDraft({source:state.fromNode.id,position:flow.screenToFlowPosition({x:point.clientX,y:point.clientY}),kind:'Device',name:'',predicate:''})
      }}
      onReconnect={(edge,c)=>{void run([{type:'fact.update',payload:{id:edge.id,subject_id:c.source,object_id:c.target}}]).catch(()=>{})}}
      onNodeDragStop={(_,node,moved)=>{void run((moved.length?moved:[node]).map(n=>({type:'entity.position',payload:{id:n.id,...(grid?snapPosition(n.position):n.position)}}))).catch(()=>{})}}
      onNodeContextMenu={(e,n)=>{e.preventDefault();onSelect({kind:'entity',id:n.id});setMenu({id:n.id,x:e.clientX,y:e.clientY})}}
      onDoubleClick={e=>{if((e.target as HTMLElement).classList.contains('react-flow__pane'))setDraft({position:flow.screenToFlowPosition({x:e.clientX,y:e.clientY}),kind:'Device',name:'',predicate:''})}}
      deleteKeyCode={null} selectionOnDrag panOnDrag={[1,2]} panOnScroll zoomOnDoubleClick={false} selectionKeyCode="Shift" multiSelectionKeyCode="Shift" minZoom={0.15} maxZoom={2.5} snapToGrid={grid} snapGrid={[20,20]} colorMode="dark" style={{background:'#0f1b2a'}} onlyRenderVisibleElements>
      <Background color="#2d405a" gap={20}/><Controls showInteractive={false} fitViewOptions={{padding:0.25,maxZoom:1.2}}/>
      {minimap && <MiniMap pannable zoomable nodeColor={n=>(n.data as CardData).entity.color||entityVisual((n.data as CardData).entity.kind).border}/>}
    </ReactFlow>
    <div className="canvas-toolbar">
      <button onClick={()=>setPalette(!palette)}><Plus size={16}/> Add entity</button>
      <button onClick={()=>void align()} disabled={busy} title="Auto layout selection or graph"><Sparkles size={16}/> Arrange</button>
      <button onClick={()=>void align('DOWN')} disabled={busy} title="Arrange top to bottom">↓</button>
      <label><input type="checkbox" checked={grid} onChange={e=>setGrid(e.target.checked)}/> Snap</label>
      <label><input type="checkbox" checked={minimap} onChange={e=>setMinimap(e.target.checked)}/> Map</label>
    </div>
    {palette && <div className="entity-palette"><div><strong>Entity palette</strong><button aria-label="Close palette" onClick={()=>setPalette(false)}><X size={16}/></button></div>
      <label><Search size={14}/><input placeholder="Find or create a type…" value={typeSearch} onChange={e=>setTypeSearch(e.target.value)}/></label>
      <p>Drag a type onto the canvas, or click to place it.</p><button onClick={()=>setTypeEdit({id:uuid(),name:typeSearch,color:'#8da9ce',icon:'Box'})}>Manage / create type…</button>
      {[...kinds,...(typeSearch.trim()&&!kinds.some(k=>k.toLowerCase()===typeSearch.trim().toLowerCase())?[typeSearch.trim()]:[])].map(kind=><button key={kind} draggable onDragStart={e=>e.dataTransfer.setData('application/factgraph-kind',kind)} onClick={()=>{setDraft({position:flow.screenToFlowPosition({x:window.innerWidth/2,y:window.innerHeight/2}),kind,name:'',predicate:''});setPalette(false)}}><KindIcon kind={kind}/>{kind}</button>)}
    </div>}
    {typeEdit && <div className="canvas-composer" role="dialog" aria-label="Entity type editor"><form onSubmit={e=>{e.preventDefault();void run([{type:entityTypes.some(t=>t.id===typeEdit.id)?'type.update':'type.add',payload:{...typeEdit}}]).then(()=>setTypeEdit(null)).catch(()=>{})}}><div><strong>Entity type</strong><button type="button" onClick={()=>setTypeEdit(null)}><X size={16}/></button></div><label>Existing type<select value={entityTypes.some(t=>t.id===typeEdit.id)?typeEdit.id:''} onChange={e=>setTypeEdit(entityTypes.find(t=>t.id===e.target.value)??{id:uuid(),name:'',color:'#8da9ce',icon:'Box'})}><option value="">New type</option>{entityTypes.map(t=><option value={t.id} key={t.id}>{t.name}</option>)}</select></label><label>Type name<input required value={typeEdit.name} onChange={e=>setTypeEdit({...typeEdit,name:e.target.value})}/></label><label>Icon<select value={typeEdit.icon} onChange={e=>setTypeEdit({...typeEdit,icon:e.target.value})}>{Object.keys(typeIcons).map(icon=><option key={icon}>{icon}</option>)}</select></label><label>Default color<input type="color" value={typeEdit.color} onChange={e=>setTypeEdit({...typeEdit,color:e.target.value})}/></label><button className="primary-button">Save type</button>{entityTypes.some(t=>t.id===typeEdit.id)&&<button type="button" onClick={()=>void run([{type:'type.delete',payload:{id:typeEdit.id}}]).then(()=>setTypeEdit(null)).catch(()=>{})}>Delete unused type</button>}</form></div>}
    {selectedNodes.length>1 && <div className="selection-tools"><span>{selectedNodes.length} selected</span><button onClick={()=>{const y=selectedNodes[0].position.y;void run(selectedNodes.filter(n=>!n.data.entity.pinned).map(n=>({type:'entity.position',payload:{id:n.id,x:n.position.x,y}}))).catch(()=>{})}}>Align row</button><button onClick={()=>{const sorted=[...selectedNodes].sort((a,b)=>a.position.x-b.position.x);void run(sorted.filter(n=>!n.data.entity.pinned).map((n,i)=>({type:'entity.position',payload:{id:n.id,x:sorted[0].position.x+i*300,y:n.position.y}}))).catch(()=>{})}}>Distribute</button></div>}
    {menu && menuEntity && <div className="canvas-menu" style={{left:Math.min(menu.x,window.innerWidth-200),top:Math.min(menu.y,window.innerHeight-260)}}>
      <button onClick={()=>{props.onEdit(menu.id);setMenu(null)}}>Edit name, type & color</button>
      <button onClick={()=>{props.onMerge(menu.id);setMenu(null)}}>Merge entity…</button>
      <button onClick={()=>{void navigator.clipboard.writeText(menu.id);setMenu(null)}}><Copy size={14}/> Copy ID</button>
      <button onClick={()=>{void run([{type:'entity.update',payload:{id:menu.id,pinned:!menuEntity.pinned}}]).catch(()=>{});setMenu(null)}}>{menuEntity.pinned?'Unpin':'Pin position'}</button>
      <button onClick={()=>{void run([{type:'entity.delete',payload:{id:menu.id}}]).catch(()=>{});setMenu(null);onSelect(null)}}>Delete · undo available</button>
    </div>}
    {draft && <div className="canvas-composer" role="dialog" aria-label={draft.source?'Connect entities':'Place entity'}>
      <form onSubmit={e=>{e.preventDefault();void save()}}><div><strong>{draft.relationId?'Edit relationship':draft.source?'New connection':'Place entity'}</strong><button type="button" aria-label="Cancel creation" onClick={()=>setDraft(null)}><X size={16}/></button></div>
        {draft.source && <><p>{entities.find(e=>e.id===draft.source)?.name} → {draft.target?entities.find(e=>e.id===draft.target)?.name:'New entity'}</p><label>Relationship<input autoFocus required placeholder="reads, accessed, grants access to…" value={draft.predicate} onChange={e=>setDraft({...draft,predicate:e.target.value})}/></label></>}
        {!draft.target && <><label>Entity name<input autoFocus={!draft.source} required value={draft.name} onChange={e=>setDraft({...draft,name:e.target.value})}/></label><label>Type<input aria-label="Type" list="entity-types" required value={draft.kind} onChange={e=>setDraft({...draft,kind:e.target.value})}/><datalist id="entity-types">{kinds.map(k=><option key={k}>{k}</option>)}</datalist></label></>}
        <p>Evidence can be attached after creating the relationship.</p><button className="primary-button" disabled={busy}>Save {draft.source?'connection':'entity'}</button>
      </form>
    </div>}
    {error && <div className="canvas-error" role="alert" onClick={()=>setError('')}>{error}</div>}
    <div className="canvas-help">Drag handles to connect · double-click to create or rename · Shift selects · scroll to pan</div>
  </div>
}
export default function GraphView(props:Props) {return <ReactFlowProvider><Canvas {...props}/></ReactFlowProvider>}
