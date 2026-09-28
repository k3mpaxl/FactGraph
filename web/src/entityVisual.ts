export type EntityVisual = { fill: string; border: string; shape: string }

const palette: EntityVisual[] = [
  { fill: '#294865', border: '#75b9df', shape: 'round-rectangle' },
  { fill: '#493868', border: '#c7a2ed', shape: 'ellipse' },
  { fill: '#2c5550', border: '#83d8bb', shape: 'rectangle' },
  { fill: '#604a31', border: '#e5b477', shape: 'diamond' },
  { fill: '#633c48', border: '#ef9fa9', shape: 'hexagon' },
  { fill: '#30466b', border: '#91bff4', shape: 'octagon' },
  { fill: '#435056', border: '#a8bac7', shape: 'round-rectangle' },
]

const known: Array<{ match: RegExp; visual: EntityVisual }> = [
  { match: /person|user|benutzer|konto|identität/, visual: { fill: '#493868', border: '#c7a2ed', shape: 'ellipse' } },
  { match: /aks|kubernetes|workload/, visual: { fill: '#294b72', border: '#82c6f4', shape: 'hexagon' } },
  { match: /device|gerät|endpoint|computer|laptop|host/, visual: { fill: '#2c5550', border: '#83d8bb', shape: 'rectangle' } },
  { match: /service.?principal|managed.?identity|service|api/, visual: { fill: '#66502e', border: '#edc778', shape: 'ellipse' } },
  { match: /ip|hostname|domain|netz|network/, visual: { fill: '#5b4430', border: '#f0ad70', shape: 'diamond' } },
  { match: /datei|file|repository|repo|blob|storage/, visual: { fill: '#2c4c3f', border: '#9ad39e', shape: 'round-rectangle' } },
  { match: /credential|secret|token|password|passwort|key|umgebung|env/, visual: { fill: '#633c48', border: '#f09aa6', shape: 'hexagon' } },
  { match: /azure|ressource|resource|cloud/, visual: { fill: '#30466b', border: '#91bff4', shape: 'octagon' } },
  { match: /prozess|process|ereignis|event|incident/, visual: { fill: '#604259', border: '#dfa1bf', shape: 'diamond' } },
  { match: /organisation|organisation|team|gruppe|group/, visual: { fill: '#295655', border: '#7dd4b8', shape: 'round-rectangle' } },
  { match: /ort|location|place/, visual: { fill: '#654d35', border: '#e7b475', shape: 'ellipse' } },
]

export function entityVisual(kind: string): EntityVisual {
  const normalized = kind.trim().toLocaleLowerCase()
  const match = known.find(item => item.match.test(normalized))
  if (match) return match.visual
  let hash = 0
  for (const character of normalized) hash = (hash * 31 + character.charCodeAt(0)) | 0
  return palette[Math.abs(hash) % palette.length]
}
