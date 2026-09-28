export type Identifier = {
  id: string; entity_id: string; scheme: string; namespace: string;
  raw_value: string; normalized_value: string; confidence: number;
  source_id: string | null; valid_from: string | null; valid_to: string | null;
}
export type Entity = {
  id: string; name: string; kind: string; description: string;
  created_at: string; identifiers: Identifier[];
  color?: string;
  position?: { x: number; y: number };
}
export type Source = {
  id: string; title: string; uri: string; excerpt: string; created_at: string;
}
export type Assertion = {
  id: string; fact_id: string; stance: 'supports' | 'refutes';
  confidence: number; source_id: string | null; note: string;
  valid_from: string | null; valid_to: string | null; created_at: string; retracted_at: string | null;
}
export type TruthState = 'supported' | 'disputed' | 'refuted' | 'unknown'
export type Fact = {
  id: string; subject_id: string; predicate: string; object_id: string;
  valid_from: string | null; valid_to: string | null; created_at: string;
  assertions: Assertion[]; truth_state: TruthState;
}
export type GraphData = { entities: Entity[]; facts: Fact[]; sources: Source[] }
