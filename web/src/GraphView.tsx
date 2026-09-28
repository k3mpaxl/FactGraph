import { useEffect, useRef, useState } from 'react'
import cytoscape from 'cytoscape'
import { Box, Focus, Link2, Minus, Plus, Sparkles, X } from 'lucide-react'
import type { Entity, Fact } from './types'
import { GRAPH_GRID, snapPosition } from './layout'
import { entityVisual } from './entityVisual'

type Selection = { kind: 'entity' | 'fact'; id: string } | null

export default function GraphView({ entities, facts, selection, search, pathIds, onSelect, onCreateNode, onCreateRelation, onMoveNode }: {
  entities: Entity[]; facts: Fact[]; selection: Selection; search: string;
  pathIds: string[];
  onSelect: (value: Selection) => void; onCreateNode: () => void; onCreateRelation: (sourceId: string, targetId?: string) => void;
  onMoveNode: (id: string, position: { x: number; y: number }) => void;
}) {
  const container = useRef<HTMLDivElement>(null)
  const graph = useRef<cytoscape.Core | null>(null)
  const selectRef = useRef(onSelect)
  const moveRef = useRef(onMoveNode)
  const relationRef = useRef(onCreateRelation)
  const selectionRef = useRef(selection)
  const connectionRef = useRef<string | null>(null)
  const refreshAnchorRef = useRef<() => void>(() => undefined)
  const fitted = useRef(false)
  const [connectionSource, setConnectionSource] = useState<string | null>(null)
  const [anchorPosition, setAnchorPosition] = useState<{ left: number; top: number } | null>(null)
  selectRef.current = onSelect
  moveRef.current = onMoveNode
  relationRef.current = onCreateRelation
  selectionRef.current = selection
  connectionRef.current = connectionSource

  useEffect(() => {
    if (!container.current) return
    const cy = cytoscape({
      container: container.current,
      elements: [],
      style: [
        { selector: 'node', style: {
          'background-color': 'data(fill)', 'border-width': 2, 'border-color': 'data(border)',
          'label': 'data(label)', 'color': '#eaf3fa', 'font-size': 12, 'font-weight': 600,
          'text-valign': 'center', 'text-halign': 'center', 'text-wrap': 'wrap',
          'text-max-width': '104px', 'width': 112, 'height': 58,
          'shape': 'data(shape)' as any, 'overlay-opacity': 0,
        } },
        { selector: 'edge', style: {
          'width': 2.5, 'line-color': '#5d8aab', 'target-arrow-color': '#5d8aab',
          'target-arrow-shape': 'triangle', 'curve-style': 'bezier',
          'label': 'data(label)', 'font-size': 10, 'font-weight': 600,
          'color': '#bdcfe0', 'text-background-color': '#152536',
          'text-background-opacity': 0.95, 'text-background-padding': '4px',
          'text-rotation': 'autorotate', 'overlay-opacity': 0,
        } },
        { selector: 'edge[truth="disputed"]', style: {
          'line-color': '#efa76c', 'target-arrow-color': '#efa76c', 'line-style': 'dashed',
        } },
        { selector: 'edge[truth="refuted"]', style: {
          'line-color': '#e57479', 'target-arrow-color': '#e57479', 'line-style': 'dotted',
        } },
        { selector: 'edge[truth="unknown"]', style: {
          'line-color': '#758497', 'target-arrow-color': '#758497',
        } },
        { selector: 'edge.path', style: { 'width': 5, 'line-color': '#f2d086',
          'target-arrow-color': '#f2d086', 'opacity': 1, 'z-index': 10 } },
        { selector: 'node.path', style: { 'border-width': 4, 'border-color': '#f2d086' } },
        { selector: '.dimmed', style: { 'opacity': 0.16 } },
        { selector: 'node.focused', style: {
          'border-width': 4, 'border-color': '#f5cc81',
        } },
        { selector: 'node.relation-source', style: {
          'border-width': 5, 'border-color': '#f2bf78',
        } },
        { selector: 'node.relation-target', style: {
          'border-width': 3, 'border-color': '#82c9b6',
        } },
        { selector: 'edge.focused', style: { 'width': 5, 'opacity': 1 } },
      ],
      layout: { name: 'preset' },
      minZoom: 0.35,
      maxZoom: 2.5,
    })
    let lastTap = { id: '', at: 0 }
    cy.on('tap', 'node', event => {
      const id = event.target.id()
      const source = connectionRef.current
      if (source) {
        if (id !== source) {
          setConnectionSource(null)
          relationRef.current(source, id)
        }
        return
      }
      const now = Date.now()
      selectRef.current({ kind: 'entity', id })
      if (lastTap.id === id && now - lastTap.at < 320) relationRef.current(id)
      lastTap = { id, at: now }
    })
    cy.on('cxttap', 'node', event => {
      const id = event.target.id()
      selectRef.current({ kind: 'entity', id })
      relationRef.current(id)
    })
    cy.on('tap', 'edge', event => selectRef.current({ kind: 'fact', id: event.target.id() }))
    cy.on('tap', event => { if (event.target === cy) { setConnectionSource(null); selectRef.current(null) } })
    cy.on('dragfree', 'node', event => {
      const node = event.target as cytoscape.NodeSingular
      const position = snapPosition(node.position())
      node.position(position)
      moveRef.current(node.id(), position)
      refreshAnchorRef.current()
    })
    const updateViewport = () => {
      if (!container.current) return
      const step = GRAPH_GRID * cy.zoom()
      const pan = cy.pan()
      container.current.style.backgroundSize = `${step}px ${step}px`
      container.current.style.backgroundPosition = `${pan.x}px ${pan.y}px`
      const selected = selectionRef.current
      if (selected?.kind !== 'entity') { setAnchorPosition(null); return }
      const node = cy.getElementById(selected.id)
      if (!node.length) { setAnchorPosition(null); return }
      const position = node.renderedPosition()
      setAnchorPosition({ left: position.x + node.renderedWidth() / 2 + 13, top: position.y })
    }
    refreshAnchorRef.current = updateViewport
    cy.on('pan zoom render', updateViewport)
    updateViewport()
    graph.current = cy
    return () => { graph.current = null; cy.destroy() }
  }, [])

  useEffect(() => {
    const cy = graph.current
    if (!cy) return
    const nodeIds = new Set(entities.map(entity => entity.id))
    const edgeIds = new Set(facts.map(fact => fact.id))
    cy.batch(() => {
      cy.edges().forEach(edge => { if (!edgeIds.has(edge.id())) edge.remove() })
      cy.nodes().forEach(node => { if (!nodeIds.has(node.id())) node.remove() })
      for (const entity of entities) {
        const position = entity.position ?? { x: 0, y: 0 }
        const visual = entityVisual(entity.kind)
        const fill = entity.color || visual.fill
        const node = cy.getElementById(entity.id)
        if (node.empty()) cy.add({ group: 'nodes', data: { id: entity.id, label: entity.name, kind: entity.kind,
          fill, border: entity.color || visual.border, shape: visual.shape }, position })
        else {
          node.data({ label: entity.name, kind: entity.kind,
            fill, border: entity.color || visual.border, shape: visual.shape })
          if (!node.grabbed() && (node.position('x') !== position.x || node.position('y') !== position.y))
            node.position(position)
        }
      }
      for (const fact of facts) {
        if (!nodeIds.has(fact.subject_id) || !nodeIds.has(fact.object_id)) continue
        const edge = cy.getElementById(fact.id)
        if (edge.empty()) cy.add({ group: 'edges', data: { id: fact.id, source: fact.subject_id,
          target: fact.object_id, label: fact.predicate, truth: fact.truth_state } })
        else edge.data({ label: fact.predicate, truth: fact.truth_state })
      }
    })
    if (!fitted.current && entities.length) {
      cy.fit(cy.elements(), 56)
      fitted.current = true
    }
  }, [entities, facts])

  useEffect(() => {
    const cy = graph.current
    if (!cy) return
    cy.elements().removeClass('focused dimmed path')
    const query = search.trim().toLocaleLowerCase()
    if (query) {
      const matching = new Set(entities.filter(entity =>
        entity.name.toLocaleLowerCase().includes(query) ||
        entity.kind.toLocaleLowerCase().includes(query) ||
        entity.identifiers.some(identifier => identifier.raw_value.toLocaleLowerCase().includes(query))
      ).map(entity => entity.id))
      cy.nodes().forEach(node => { if (!matching.has(node.id())) node.addClass('dimmed') })
      cy.edges().forEach(edge => {
        if (!matching.has(edge.source().id()) && !matching.has(edge.target().id())) edge.addClass('dimmed')
      })
    }
    if (selection) {
      const element = cy.getElementById(selection.id)
      if (element.length) {
        element.removeClass('dimmed').addClass('focused')
        if (selection.kind === 'entity') element.connectedEdges().removeClass('dimmed')
      }
    }
    refreshAnchorRef.current()
    for (const id of pathIds) {
      const edge = cy.getElementById(id)
      if (edge.length) {
        edge.addClass('path').removeClass('dimmed')
        edge.source().addClass('path').removeClass('dimmed')
        edge.target().addClass('path').removeClass('dimmed')
      }
    }
  }, [entities, facts, selection, search, pathIds])

  useEffect(() => {
    const cy = graph.current
    if (!cy) return
    cy.nodes().removeClass('relation-source relation-target')
    if (connectionSource) {
      cy.getElementById(connectionSource).addClass('relation-source')
      cy.nodes().filter(node => node.id() !== connectionSource).addClass('relation-target')
    }
  }, [connectionSource])

  useEffect(() => {
    if (connectionSource && (selection?.kind !== 'entity' || selection.id !== connectionSource))
      setConnectionSource(null)
  }, [connectionSource, selection])

  const autoAlign = () => {
    const cy = graph.current
    if (!cy || !cy.nodes().length) return
    cy.one('layoutstop', () => {
      cy.nodes().forEach(node => {
        const position = snapPosition(node.position())
        node.position(position)
        moveRef.current(node.id(), position)
      })
      cy.fit(cy.elements(), 56)
    })
    cy.layout({ name: 'cose', animate: true, animationDuration: 450,
      fit: true, padding: 64, nodeRepulsion: () => 900_000, idealEdgeLength: () => 180 }).run()
  }

  return <div className="graph-shell">
    <div className="graph-canvas" ref={container} aria-label="Interactive entity relationship graph" />
    {selection?.kind === 'entity' && anchorPosition && <button
      className={`node-anchor ${connectionSource ? 'active' : ''}`}
      style={anchorPosition}
      title={connectionSource ? 'Cancel relationship' : 'Start relationship from this node'}
      aria-label={connectionSource ? 'Cancel relationship' : 'Start relationship from selected node'}
      onClick={() => setConnectionSource(current => current ? null : selection.id)}>
      {connectionSource ? <X size={13} /> : <Link2 size={13} />}
    </button>}
    {connectionSource && <div className="connection-prompt">Select the target node <button onClick={() => setConnectionSource(null)}>Cancel</button></div>}
    <div className="graph-controls">
      <button title="Create node" aria-label="Create node" onClick={onCreateNode}><Box size={17} /></button>
      <button title="Auto align graph" aria-label="Auto align graph" onClick={autoAlign}><Sparkles size={17} /></button>
      <button title="Zoom in" onClick={() => graph.current?.zoom({ level: Math.min(graph.current.zoom() * 1.25, 2.5), renderedPosition: { x: graph.current.width() / 2, y: graph.current.height() / 2 } })}><Plus size={17} /></button>
      <button title="Zoom out" onClick={() => graph.current?.zoom({ level: Math.max(graph.current.zoom() / 1.25, 0.35), renderedPosition: { x: graph.current.width() / 2, y: graph.current.height() / 2 } })}><Minus size={17} /></button>
      <button title="Fit graph" onClick={() => graph.current?.fit(undefined, 56)}><Focus size={17} /></button>
    </div>
    <div className="graph-hint">Select a node, click its connector, then choose a target · drag → grid · auto align ✦</div>
  </div>
}
