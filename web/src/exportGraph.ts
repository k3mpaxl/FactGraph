import type { EntityType, TruthState } from './types'
import { entityVisual } from './entityVisual'
import { LAYERS } from './layers'
import { edgeGeometry, edgeOffsets, edgeWidth, type NodeBox, type VEdge, type VNode } from './viewModel'

export type ExportTheme = 'light' | 'dark'
export type ExportOptions = {
  nodes: VNode[]; edges: VEdge[]; entityTypes: EntityType[];
  theme: ExportTheme;
  /** Measured canvas sizes by node id; estimates are used for nodes that were never rendered. */
  sizes?: Map<string, { width: number; height: number }>;
  /** Restrict to this flow-coordinate rectangle (visible area) or to these node ids (selection). */
  area?: { x: number; y: number; width: number; height: number } | null;
  only?: Set<string> | null;
  title?: string; subtitle?: string; legend?: boolean; transparent?: boolean;
  measure?: (text: string, size: number, weight: number) => number;
  icon?: (kind: string, icon: string | undefined, color: string) => string;
  /** Attack impact: badges by entity ID (groups as "group:<id>") and the attacker's fact IDs, drawn like on the canvas. */
  impact?: { badges: Map<string, { tone: 'bad' | 'warn' | 'pivot' | 'muted' | 'good'; label: string }>; attack: Set<string> } | null;
}

type Palette = Record<'canvas' | 'node' | 'border' | 'text' | 'text2' | 'text3' | 'accent' | 'labelBg' | 'lane' | TruthState, string>
export const PALETTES: Record<ExportTheme, Palette> = {
  dark: { canvas: '#0f1117', node: '#171a23', border: '#2c3240', text: '#e7e9ee', text2: '#a6adbb', text3: '#6d7586', accent: '#7c86ff', labelBg: '#171a23', lane: '#e7e9ee',
    supported: '#3dd68c', disputed: '#f0b34a', refuted: '#f36b7f', unknown: '#8a93a6' },
  light: { canvas: '#fbfbfc', node: '#ffffff', border: '#dfe2e8', text: '#171a21', text2: '#4d5565', text3: '#818998', accent: '#4f5bd5', labelBg: '#ffffff', lane: '#171a21',
    supported: '#12a066', disputed: '#c7860a', refuted: '#d63d55', unknown: '#7e8799' },
}
const STATES: TruthState[] = ['supported', 'disputed', 'refuted', 'unknown']
const FONT = "Inter, ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
const MONO = "ui-monospace, 'SF Mono', Menlo, Consolas, monospace"

export const escapeXml = (value: string) => value.replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]!))
// Strip characters XML 1.0 forbids so arbitrary log values never produce an invalid file.
const clean = (value: string) => value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '')
const text = (value: string) => escapeXml(clean(value))
const n = (value: number) => Math.round(value * 10) / 10

function hexToRgb(hex: string) {
  const value = /^#([\da-f]{6})$/i.exec(hex.trim())?.[1]
  if (!value) return null
  return [0, 2, 4].map(i => parseInt(value.slice(i, i + 2), 16))
}
/** color-mix(in srgb, a p%, b) for hex colours, used for tinted icon tiles. */
export function mix(a: string, b: string, weight: number) {
  const x = hexToRgb(a), y = hexToRgb(b)
  // The result goes into SVG attributes: a value that is not a colour falls back instead of being copied.
  if (!x || !y) return /^#[\da-f]{3,8}$/i.test(a) ? a : '#8da9ce'
  return '#' + x.map((v, i) => Math.round(v * weight + y[i] * (1 - weight)).toString(16).padStart(2, '0')).join('')
}

const approxMeasure = (value: string, size: number, weight: number) => value.length * size * (weight >= 600 ? 0.6 : 0.56)
function fit(value: string, max: number, size: number, weight: number, measure: NonNullable<ExportOptions['measure']>) {
  if (measure(value, size, weight) <= max) return value
  let low = 0, high = value.length
  while (low < high) { const mid = Math.ceil((low + high) / 2); if (measure(value.slice(0, mid) + '…', size, weight) <= max) low = mid; else high = mid - 1 }
  return value.slice(0, low) + '…'
}

/** Standalone SVG of the current canvas view: no CSS, no web fonts, no external references. */
export function buildGraphSvg(options: ExportOptions) {
  const p = PALETTES[options.theme]
  const measure = options.measure ?? approxMeasure
  const typeByName = new Map(options.entityTypes.map(t => [t.name, t]))
  const colorOf = (kind: string, own?: string) => own || typeByName.get(kind)?.color || entityVisual(kind).border

  // Node boxes (top-left + size) in flow coordinates.
  const boxes = new Map<string, { x: number; y: number; w: number; h: number }>()
  for (const node of options.nodes) {
    const measured = options.sizes?.get(node.id)
    let w: number, h: number
    if (node.kind === 'frame') { w = node.width; h = node.height }
    else if (node.kind === 'activity') { w = 28; h = 28 }
    else if (node.kind === 'group') { w = measured?.width ?? 250; h = measured?.height ?? 62 }
    else {
      const label = Math.max(measure(node.entity.name, 13, 600), measure(`${node.entity.kind} · ${node.entity.identifiers[0]?.raw_value ?? ''}`, 11, 400))
      w = measured?.width ?? Math.min(260, Math.max(168, 62 + label)); h = measured?.height ?? 48
    }
    boxes.set(node.id, { x: node.position.x, y: node.position.y, w, h })
  }
  const intersects = (b: { x: number; y: number; w: number; h: number }) => !options.area || (b.x + b.w >= options.area.x && b.x <= options.area.x + options.area.width && b.y + b.h >= options.area.y && b.y <= options.area.y + options.area.height)
  const keep = new Set(options.nodes.filter(node => {
    const box = boxes.get(node.id)!
    if (options.only) return node.kind !== 'frame' && options.only.has(node.id)
    return node.kind === 'frame' ? !options.area || intersects(box) : intersects(box)
  }).map(node => node.id))
  const nodes = options.nodes.filter(node => keep.has(node.id))
  const edges = options.edges.filter(edge => keep.has(edge.source) && keep.has(edge.target))

  // Content bounds including activity labels below their diamonds.
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const node of nodes) {
    const b = boxes.get(node.id)!
    const extraW = node.kind === 'activity' ? Math.max(0, measure(node.count > 1 ? `${node.fact.predicate} ×${node.count}` : node.fact.predicate, 11, 650) / 2 - 14) : 0
    minX = Math.min(minX, b.x - extraW); minY = Math.min(minY, b.y); maxX = Math.max(maxX, b.x + b.w + extraW); maxY = Math.max(maxY, b.y + b.h + (node.kind === 'activity' ? 32 : 0) + (node.kind === 'entity' && (node.container || node.hidden) ? 10 : 0))
  }
  if (!nodes.length) { minX = 0; minY = 0; maxX = 320; maxY = 120 }
  const pad = 40
  const header = options.title ? 64 : 0
  const legendH = options.legend ? 44 : 0
  const width = Math.ceil(Math.max(maxX - minX + pad * 2, options.legend ? 560 : 0, options.title ? 420 : 0))
  const height = Math.ceil(maxY - minY + pad * 2 + header + legendH)
  const ox = pad - minX + Math.max(0, (width - (maxX - minX + pad * 2)) / 2), oy = pad - minY + header

  const out: string[] = []
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="${FONT}">`)
  out.push(`<title>${text(options.title ?? 'FactGraph')}</title>`)
  out.push('<defs>' + STATES.map(state => `<marker id="arrow-${state}" viewBox="0 0 10 10" refX="9" refY="5" markerUnits="userSpaceOnUse" markerWidth="10" markerHeight="10" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="${p[state]}"/></marker>`).join('')
    + `<filter id="shadow" x="-10%" y="-20%" width="120%" height="150%"><feDropShadow dx="0" dy="1" stdDeviation="1.2" flood-color="#000" flood-opacity="${options.theme === 'dark' ? 0.35 : 0.08}"/></filter></defs>`)
  if (!options.transparent) out.push(`<rect width="100%" height="100%" fill="${p.canvas}"/>`)
  if (options.title) {
    out.push(`<text x="${pad}" y="34" font-size="18" font-weight="650" fill="${p.text}">${text(fit(options.title, width - pad * 2, 18, 650, measure))}</text>`)
    if (options.subtitle) out.push(`<text x="${pad}" y="54" font-size="11.5" fill="${p.text3}">${text(fit(options.subtitle, width - pad * 2, 11.5, 400, measure))}</text>`)
  }
  out.push(`<g transform="translate(${n(ox)} ${n(oy)})">`)

  // Frames (group outlines and layer lanes) sit behind everything.
  for (const node of nodes) if (node.kind === 'frame') {
    const b = boxes.get(node.id)!
    const lane = node.tone === 'lane'
    const label = lane ? (LAYERS.find(l => l.id === node.label)?.label ?? node.label).toUpperCase() : node.label
    out.push(lane
      ? `<rect x="${n(b.x)}" y="${n(b.y)}" width="${n(b.w)}" height="${n(b.h)}" rx="20" fill="${p.lane}" fill-opacity="0.04"/>`
      : `<rect x="${n(b.x)}" y="${n(b.y)}" width="${n(b.w)}" height="${n(b.h)}" rx="16" fill="${p.accent}" fill-opacity="0.04" stroke="${p.accent}" stroke-opacity="0.45" stroke-width="1.5" stroke-dasharray="6 5"/>`)
    out.push(`<text x="${n(b.x + 14)}" y="${n(b.y + (lane ? 24 : 20))}" font-size="11" font-weight="650" letter-spacing="${lane ? 0.8 : 0}" fill="${lane ? p.text3 : p.accent}">${text(label)}</text>`)
  }

  const center = (id: string): NodeBox => { const b = boxes.get(id)!; return { x: b.x + b.w / 2, y: b.y + b.h / 2, w: b.w, h: b.h } }
  const offsets = edgeOffsets(edges)
  const labels: string[] = []
  for (const edge of edges) {
    const geometry = edgeGeometry(center(edge.source), center(edge.target), offsets.get(edge.id) ?? 0)
    const attack = !!options.impact?.attack.size && edge.factIds.some(id => options.impact!.attack.has(id))
    const color = attack ? p.refuted : p[edge.state]
    const dash = edge.state === 'unknown' && !attack ? ' stroke-dasharray="5 4"' : ''
    out.push(`<path d="${geometry.path.replace(/-?\d+\.\d+/g, v => String(n(Number(v))))}" fill="none" stroke="${color}" stroke-width="${attack ? 2 : edge.role ? 1.2 : edgeWidth(edge.count)}"${dash} marker-end="url(#arrow-${attack ? 'refuted' : edge.state})"/>`)
    if (!edge.label) continue
    const { x, y } = geometry.label
    if (edge.role) {
      const value = edge.label.toUpperCase()
      const w = measure(value, 9.5, 650) + 10
      labels.push(`<rect x="${n(x - w / 2)}" y="${n(y - 8)}" width="${n(w)}" height="16" rx="4" fill="${p.canvas}" fill-opacity="${options.transparent ? 0.85 : 1}"/><text x="${n(x)}" y="${n(y + 3.5)}" text-anchor="middle" font-size="9.5" font-weight="650" letter-spacing="0.4" fill="${p.text3}">${text(value)}</text>`)
    } else {
      const value = fit(edge.label, 170, 11, 550, measure)
      const count = edge.count > 1 ? `×${edge.count}` : ''
      const w = measure(value, 11, 550) + (count ? measure(count, 11, 700) + 5 : 0) + 16
      const labelColor = edge.state === 'unknown' ? p.text2 : mix(color, p.text, 0.72)
      labels.push(`<rect x="${n(x - w / 2)}" y="${n(y - 10)}" width="${n(w)}" height="20" rx="10" fill="${p.labelBg}" stroke="${p.border}"/>`
        + `<text x="${n(x - w / 2 + 8)}" y="${n(y + 4)}" font-size="11" font-weight="550" fill="${labelColor}">${text(value)}${count ? `<tspan dx="5" font-weight="700" fill="${p.accent}">${count}</tspan>` : ''}</text>`)
    }
  }

  const tones = { bad: [p.refuted, '#ffffff'], warn: [p.disputed, '#1a1205'], pivot: [p.node, p.refuted], muted: [mix(p.text3, p.node, 0.25), p.text2], good: [p.supported, '#ffffff'] } as const
  for (const node of nodes) {
    const b = boxes.get(node.id)!
    const badge = (node.kind === 'entity' || node.kind === 'group') ? options.impact?.badges.get(node.id) : undefined
    if (badge) {
      const [fill, ink] = tones[badge.tone]
      const w = measure(badge.label, 9.5, 700) + 12
      labels.push(`<rect x="${n(b.x + 10)}" y="${n(b.y - 9)}" width="${n(w)}" height="16" rx="8" fill="${fill}"${badge.tone === 'pivot' ? ` stroke="${p.refuted}" stroke-dasharray="3 2"` : ''}/>`
        + `<text x="${n(b.x + 16)}" y="${n(b.y + 2.5)}" font-size="9.5" font-weight="700" fill="${ink}">${text(badge.label)}</text>`)
    }
    if (node.kind === 'entity') {
      const color = colorOf(node.entity.kind, node.entity.color)
      const type = typeByName.get(node.entity.kind)
      const tile = mix(color, p.node, 0.18), glyph = mix(color, p.text, 0.82)
      const hint = node.entity.identifiers[0]?.raw_value
      const maxText = b.w - 62
      const ring = badge ? (badge.tone === 'pivot' ? p.refuted : badge.tone === 'muted' ? p.border : tones[badge.tone][0]) : p.border
      out.push(`<g filter="url(#shadow)"><rect x="${n(b.x)}" y="${n(b.y)}" width="${n(b.w)}" height="${n(b.h)}" rx="10" fill="${p.node}" stroke="${ring}"${badge && badge.tone !== 'muted' ? ` stroke-width="1.6"${badge.tone === 'pivot' ? ' stroke-dasharray="4 3"' : ''}` : ''}/></g>`)
      out.push(`<rect x="${n(b.x - 0.5)}" y="${n(b.y + 10)}" width="3" height="${n(b.h - 20)}" rx="1.5" fill="${escapeXml(color)}"/>`)
      out.push(`<rect x="${n(b.x + 8)}" y="${n(b.y + b.h / 2 - 15)}" width="30" height="30" rx="8" fill="${tile}"/>`)
      const icon = options.icon?.(node.entity.kind, type?.icon, glyph)
      out.push(icon ? `<svg x="${n(b.x + 15)}" y="${n(b.y + b.h / 2 - 8)}" width="16" height="16" viewBox="0 0 24 24">${icon}</svg>`
        : `<text x="${n(b.x + 23)}" y="${n(b.y + b.h / 2 + 4.5)}" text-anchor="middle" font-size="12" font-weight="700" fill="${glyph}">${text((node.entity.kind[0] ?? '?').toUpperCase())}</text>`)
      out.push(`<text x="${n(b.x + 48)}" y="${n(b.y + b.h / 2 - 2)}" font-size="13" font-weight="600" fill="${p.text}">${text(fit(node.entity.name, maxText, 13, 600, measure))}</text>`)
      const kindText = fit(node.entity.kind, maxText, 11, 400, measure)
      const hintText = hint ? fit(hint, Math.max(0, maxText - measure(kindText + ' · ', 11, 400)), 10.5, 400, measure) : ''
      out.push(`<text x="${n(b.x + 48)}" y="${n(b.y + b.h / 2 + 13)}" font-size="11" fill="${p.text3}">${text(kindText)}${hintText ? ` · <tspan font-family="${MONO}" font-size="10.5">${text(hintText)}</tspan>` : ''}</text>`)
      const chips = [node.container ? `${node.container.collapsed ? '▸' : '▾'} ${node.container.count} inside` : '', node.hidden ? `+${node.hidden} hidden` : ''].filter(Boolean)
      let cx = b.x + 10
      for (const chip of chips) {
        const w = measure(chip, 10.5, 600) + 12
        out.push(`<rect x="${n(cx)}" y="${n(b.y + b.h - 9)}" width="${n(w)}" height="18" rx="9" fill="${p.node}" stroke="${p.border}"/><text x="${n(cx + 6)}" y="${n(b.y + b.h + 3.5)}" font-size="10.5" font-weight="600" fill="${p.text2}">${text(chip)}</text>`)
        cx += w + 4
      }
    } else if (node.kind === 'group') {
      const color = node.group.color || p.accent
      for (const shift of [10, 5]) out.push(`<rect x="${n(b.x + shift)}" y="${n(b.y + shift)}" width="${n(b.w)}" height="${n(b.h)}" rx="12" fill="${shift === 10 ? mix(p.node, p.text, 0.9) : mix(p.node, p.text, 0.95)}" stroke="${p.border}"/>`)
      out.push(`<g filter="url(#shadow)"><rect x="${n(b.x)}" y="${n(b.y)}" width="${n(b.w)}" height="${n(b.h)}" rx="12" fill="${p.node}" stroke="${badge ? tones[badge.tone][0] : mix(color, p.border, 0.45)}"${badge ? ' stroke-width="1.6"' : ''}/></g>`)
      out.push(`<rect x="${n(b.x + 10)}" y="${n(b.y + 10)}" width="30" height="30" rx="8" fill="${mix(color, p.node, 0.18)}"/>`)
      out.push(options.icon ? `<svg x="${n(b.x + 17)}" y="${n(b.y + 17)}" width="16" height="16" viewBox="0 0 24 24">${options.icon('__group__', undefined, color)}</svg>` : '')
      const summary = `${node.count} members · ${node.kinds.length === 1 ? node.kinds[0][0] : `${node.kinds.length} types`}${node.internal ? ` · ${node.internal} internal` : ''}`
      out.push(`<text x="${n(b.x + 50)}" y="${n(b.y + 23)}" font-size="13" font-weight="600" fill="${p.text}">${text(fit(node.group.name, b.w - 62, 13, 600, measure))}</text>`)
      out.push(`<text x="${n(b.x + 50)}" y="${n(b.y + 38)}" font-size="11" fill="${p.text3}">${text(fit(summary, b.w - 62, 11, 400, measure))}</text>`)
      const total = STATES.reduce((sum, s) => sum + node.states[s], 0)
      if (total) {
        let x = b.x + 10
        const full = b.w - 20
        for (const state of STATES) if (node.states[state]) {
          const w = Math.max(1, full * node.states[state] / total - 1)
          out.push(`<rect x="${n(x)}" y="${n(b.y + b.h - 9)}" width="${n(w)}" height="3" rx="1.5" fill="${p[state]}" fill-opacity="${state === 'unknown' ? 0.5 : 1}"/>`)
          x += w + 1
        }
      }
    } else if (node.kind === 'activity') {
      const attack = !!options.impact?.attack.size && node.facts.some(f => options.impact!.attack.has(f.id))
      const color = attack ? p.refuted : p[node.fact.truth_state]
      const cx = b.x + 14, cy = b.y + 14
      out.push(`<rect x="${n(cx - 12)}" y="${n(cy - 12)}" width="24" height="24" rx="6" transform="rotate(45 ${n(cx)} ${n(cy)})" fill="${p.node}" stroke="${color}" stroke-width="1.5"${node.fact.truth_state === 'unknown' ? ' stroke-dasharray="3 2"' : ''}/>`)
      out.push(`<path d="M ${n(cx + 1)} ${n(cy - 6)} L ${n(cx - 4)} ${n(cy + 1)} L ${n(cx)} ${n(cy + 1)} L ${n(cx - 1)} ${n(cy + 6)} L ${n(cx + 4)} ${n(cy - 1)} L ${n(cx)} ${n(cy - 1)} Z" fill="${escapeXml(color)}"/>`)
      const when = node.fact.assertions.map(a => a.valid_from).filter(Boolean).sort()[0] ?? node.fact.valid_from
      const sub = `${when ? new Date(when).toISOString().slice(5, 16).replace('T', ' ') : ''}${node.fact.technique ? ` ${node.fact.technique}` : ''}`.trim()
      const label = node.count > 1 ? `${node.fact.predicate} ×${node.count}` : node.fact.predicate
      const w = measure(label, 11, 650) + 8
      labels.push(`<rect x="${n(cx - w / 2)}" y="${n(b.y + 33)}" width="${n(w)}" height="15" rx="4" fill="${p.canvas}"/><text x="${n(cx)}" y="${n(b.y + 44)}" text-anchor="middle" font-size="11" font-weight="650" fill="${p.text}">${text(label)}</text>`
        + (sub ? `<text x="${n(cx)}" y="${n(b.y + 57)}" text-anchor="middle" font-size="10" fill="${p.text3}">${text(sub)}</text>` : ''))
    }
  }
  for (const label of labels) out.push(label)  // no spread: very large graphs would overflow the call stack
  out.push('</g>')

  if (options.legend) {
    const y = height - 22
    let x = pad
    const counts = new Map<TruthState, number>()
    for (const edge of edges) if (!edge.role) counts.set(edge.state, (counts.get(edge.state) ?? 0) + edge.count)
    for (const state of STATES) {
      const label = `${state[0].toUpperCase()}${state.slice(1)} ${counts.get(state) ?? 0}`
      out.push(`<line x1="${x}" y1="${y - 4}" x2="${x + 16}" y2="${y - 4}" stroke="${p[state]}" stroke-width="2"${state === 'unknown' ? ' stroke-dasharray="4 3"' : ''}/><text x="${x + 22}" y="${y}" font-size="11" fill="${p.text2}">${text(label)}</text>`)
      x += 34 + measure(label, 11, 400) + 14
    }
    const entityCount = nodes.filter(node => node.kind === 'entity').length + nodes.reduce((sum, node) => sum + (node.kind === 'group' ? node.count : 0), 0)
    const stats = `${entityCount} entities · ${edges.filter(e => !e.role).reduce((s, e) => s + e.count, 0)} relationships · ${nodes.filter(node => node.kind === 'activity').length} activities`
    out.push(`<text x="${width - pad}" y="${y}" text-anchor="end" font-size="11" fill="${p.text3}">${text(stats)}</text>`)
  }
  out.push('</svg>')
  return { svg: out.join('\n'), width, height, nodeCount: nodes.filter(node => node.kind !== 'frame').length }
}

/** Browser canvases fail beyond ~16k px per side or very large areas; reduce the scale instead of failing. */
export function safeScale(width: number, height: number, requested: number, maxSide = 16000, maxArea = 100_000_000) {
  return Math.max(0.1, Math.min(requested, maxSide / width, maxSide / height, Math.sqrt(maxArea / (width * height))))
}

export async function svgToPng(svg: string, width: number, height: number, scale: number): Promise<{ blob: Blob; scale: number }> {
  const actual = safeScale(width, height, scale)
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }))
  try {
    const image = new Image()
    image.decoding = 'async'
    image.src = url
    await image.decode()
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(width * actual)); canvas.height = Math.max(1, Math.round(height * actual))
    const context = canvas.getContext('2d')
    if (!context) throw new Error('Canvas is not available in this browser')
    context.scale(actual, actual)
    context.drawImage(image, 0, 0, width, height)
    const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'))
    if (!blob) throw new Error('PNG encoding failed; try SVG or a smaller scale')
    return { blob, scale: actual }
  } finally { URL.revokeObjectURL(url) }
}

let measureContext: CanvasRenderingContext2D | null | undefined
/** Real text widths from the browser's font engine; falls back to an estimate outside the browser. */
export function browserMeasure(value: string, size: number, weight: number) {
  if (measureContext === undefined) measureContext = typeof document !== 'undefined' ? document.createElement('canvas').getContext('2d') : null
  if (!measureContext) return approxMeasure(value, size, weight)
  measureContext.font = `${weight} ${size}px ${FONT}`
  return measureContext.measureText(value).width
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url; anchor.download = filename; anchor.style.display = 'none'
  document.body.appendChild(anchor); anchor.click(); anchor.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 1500)
}

export const exportFilename = (board: string, extension: string) =>
  `factgraph-${board.toLowerCase().normalize('NFKD').replace(/[^\w]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'board'}-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '')}.${extension}`
