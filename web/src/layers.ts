import type { Entity, EntityType } from './types'

export type Layer = { id: string; label: string; hint: string }

// Ordered from who acts to what is reached; the order drives swimlane layout.
export const LAYERS: Layer[] = [
  { id: 'identity', label: 'Identity & access', hint: 'Threat actors, users, principals, credentials, secrets' },
  { id: 'network', label: 'Network', hint: 'IPs, domains, URLs' },
  { id: 'endpoint', label: 'Endpoint', hint: 'Devices, processes, local files' },
  { id: 'workload', label: 'Workload', hint: 'Kubernetes, containers, pods' },
  { id: 'cloud', label: 'Cloud control plane', hint: 'Subscriptions, Key Vaults, cloud resources' },
  { id: 'data', label: 'Data & storage', hint: 'Buckets, blobs, databases' },
  { id: 'code', label: 'Code & CI', hint: 'Repositories, pipelines, commits' },
  { id: 'other', label: 'Other', hint: 'Events, organisations, everything else' },
]
export const LAYER_IDS = LAYERS.map(layer => layer.id)

const rules: [RegExp, string][] = [
  [/registry/, 'endpoint'],
  [/aks|kubernetes|k8s|pod|namespace|container|workload|deployment|helm/, 'workload'],
  [/repo|repository|git|commit|pipeline|workflow|build|package/, 'code'],
  [/bucket|s3|blob|storage|database|datenbank|\bdb\b|table|datalake|share/, 'data'],
  [/key ?vault|keyvault|subscription|resource|azure|aws|gcp|cloud|tenant|function|app service|vm\b|virtual machine/, 'cloud'],
  [/threat|attacker|adversary|actor|apt\b|user|person|account|principal|identity|group|role|credential|secret|token|password|key|certificate|mailbox|e-?mail address|benutzer|konto|angreifer/, 'identity'],
  [/\bip\b|ip address|domain|dns|url|hostname|fqdn|network|subnet|firewall|netz/, 'network'],
  [/device|host|workstation|laptop|server|system|process|file|datei|variable|env|endpoint|computer|registry|gerät/, 'endpoint'],
]

export function inferLayer(kind: string) {
  const normalized = kind.trim().toLowerCase()
  return rules.find(([pattern]) => pattern.test(normalized))?.[1] ?? 'other'
}

export function layerOf(entity: Pick<Entity, 'kind' | 'layer'>, types?: EntityType[]) {
  if (entity.layer && LAYER_IDS.includes(entity.layer)) return entity.layer
  const type = types?.find(item => item.name === entity.kind)
  if (type?.layer && LAYER_IDS.includes(type.layer)) return type.layer
  return inferLayer(entity.kind)
}

export const layerLabel = (id: string) => LAYERS.find(layer => layer.id === id)?.label ?? id
