import { Box, Boxes, User, Monitor, KeyRound, Cloud, FileText, Network, Layers, Skull } from 'lucide-react'

export const typeIcons = { Box, User, Monitor, KeyRound, Cloud, FileText, Network, Layers }

export function KindIcon({ kind, icon, size = 16 }: { kind: string; icon?: string; size?: number }) {
  const Icon = icon && icon in typeIcons ? typeIcons[icon as keyof typeof typeIcons] : /threat|attacker|adversary|\bactor\b|angreifer/i.test(kind) ? Skull : /user|person/i.test(kind) ? User : /device|host|system/i.test(kind) ? Monitor : /secret|credential|variable|vault/i.test(kind) ? KeyRound : /file|repo/i.test(kind) ? FileText : /aks|kubernetes|pod/i.test(kind) ? Layers : /\bip\b|network/i.test(kind) ? Network : /cloud|storage|principal|bucket|s3/i.test(kind) ? Cloud : Box
  return <Icon size={size} strokeWidth={1.9} />
}

const cache = new Map<string, string>()
let render: ((element: React.ReactElement) => string) | null = null
/** The static renderer is only needed for image export, so it is loaded on first use. */
export async function prepareIconMarkup() {
  if (!render) render = (await import('react-dom/server')).renderToStaticMarkup
}
/** Inner SVG markup (24×24 viewBox) of the same icon the canvas shows, with a fixed colour for image export. */
export function iconMarkup(kind: string, icon: string | undefined, color: string) {
  const key = `${kind}\u0000${icon ?? ''}`
  let inner = cache.get(key)
  if (inner === undefined) {
    if (!render) return ''
    const markup = render(kind === '__group__' ? <Boxes size={24} strokeWidth={1.9} /> : <KindIcon kind={kind} icon={icon} size={24} />)
    const attributes = /<svg([^>]*)>/.exec(markup)?.[1] ?? ''
    const stroke = / stroke-width="([^"]+)"/.exec(attributes)?.[1] ?? '2'
    inner = `<g fill="none" stroke="currentColor" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round">${markup.replace(/^<svg[^>]*>/, '').replace(/<\/svg>$/, '')}</g>`
    cache.set(key, inner)
  }
  // The colour goes into SVG attributes: only a plain colour value, never markup.
  return inner.replaceAll('currentColor', /^#[0-9a-f]{3,8}$|^[a-z]+$/i.test(color) ? color : '#8da9ce')
}
