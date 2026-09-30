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
  pinned?: boolean;
  /** Explicit layer override; otherwise the type's layer or an inferred one applies. */
  layer?: string;
}
export type Source = {
  id: string; title: string; uri: string; excerpt: string; created_at: string;
  source_kind?: 'primary' | 'secondary' | 'unknown'; query?: string; revision?: string;
}
export type Assertion = {
  id: string; fact_id: string; stance: 'supports' | 'refutes';
  confidence: number; source_id: string | null; note: string;
  valid_from: string | null; valid_to: string | null; created_at: string; retracted_at: string | null;
  review_status?: 'confirmed' | 'unconfirmed'; revision?: string;
  locator?: string; observation?: string; interpretation?: string;
  reviewed_by?: string | null; reviewed_at?: string | null; review_note?: string;
  reviewed_revision?: string | null; reviewed_source_revision?: string | null;
}
export type TruthState = 'supported' | 'disputed' | 'refuted' | 'unknown'
export type Fact = {
  id: string; subject_id: string; predicate: string; object_id: string;
  valid_from: string | null; valid_to: string | null; created_at: string;
  assertions: Assertion[]; truth_state: TruthState;
  /** Present for activities: one observed event with several role-tagged participants. */
  participants?: Participant[]; technique?: string; position?: { x: number; y: number };
}
export type Participant = { entity_id: string; role: string }
export type EntityType = { id: string; name: string; color: string; icon: string; layer?: string }
export type GroupRule = { kinds?: string[]; match?: string; container_id?: string | null }
/** A view structure: it bundles entities on the canvas and never changes claims or evidence. */
export type Group = {
  id: string; name: string; members: string[]; excluded: string[]; rule: GroupRule | null;
  collapsed: boolean; color?: string; position?: { x: number; y: number }; created_at: string;
  member_ids: string[];
}
export type Perspective = { id: string; name: string; layers: string[] | null; collapse_activities: boolean; show_lanes: boolean }
export type GraphData = { entity_types?: EntityType[]; entities: Entity[]; facts: Fact[]; sources: Source[]; groups?: Group[]; views?: Perspective[] }
