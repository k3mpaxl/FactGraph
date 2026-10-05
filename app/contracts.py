"""Shared request contracts for REST and MCP."""
from __future__ import annotations
from typing import Literal
from datetime import datetime, timezone
from pydantic import BaseModel, Field, ConfigDict, model_validator

LAYERS = ("identity", "network", "endpoint", "workload", "cloud", "data", "code", "other")
Layer = Literal["identity", "network", "endpoint", "workload", "cloud", "data", "code", "other"]
LAYER_HELP = "Investigation layer (see server instructions). Omit to infer it from the entity type."
TIME_HELP = "ISO 8601 timestamp (UTC recommended) of the observed activity, not of the record creation."


def as_utc(value: str):
    date = datetime.fromisoformat(value.replace("Z", "+00:00"))
    return date.astimezone(timezone.utc) if date.tzinfo else date.replace(tzinfo=timezone.utc)

class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")

    @model_validator(mode="after")
    def field_invariants(self):
        nullable = {'id', 'source_id', 'valid_from', 'valid_to', 'color', 'x', 'y', 'subject_field', 'object_field', 'predicate_field', 'expected_source_revision', 'expected_revision',
                    'layer', 'rule', 'technique', 'container_id', 'operation_field', 'layers', 'since', 'until', 'compromise', 'rotated_at'}
        for key in self.model_fields_set:
            value = getattr(self, key)
            if value is None and key not in nullable:
                raise ValueError(f'{key} cannot be null')
        for key in ('valid_from', 'valid_to'):
            value = getattr(self, key, None)
            if value:
                datetime.fromisoformat(value.replace('Z', '+00:00'))
        start, end = getattr(self, 'valid_from', None), getattr(self, 'valid_to', None)
        if start and end and as_utc(start) > as_utc(end):
            raise ValueError('End must be after start')
        return self

class EntityInput(StrictModel):
    name: str = Field(min_length=1, description="Concrete, human-readable name, e.g. 10.0.0.8, sp-deploy-prod, kv-prod-secrets.")
    kind: str = Field(default="Other", description="Entity type such as IP, User, Service Principal, Key Vault, Repository, AKS Cluster, S3 Bucket, Threat Actor.")
    description: str = ""
    color: str | None = Field(default=None, pattern=r"^#[0-9a-fA-F]{6}$")
    layer: Layer | None = Field(default=None, description=LAYER_HELP)
    pinned: bool = False
    x: float | None = Field(default=None, ge=-100000, le=100000, allow_inf_nan=False)
    y: float | None = Field(default=None, ge=-100000, le=100000, allow_inf_nan=False)
    id: str | None = None

class RelationInput(StrictModel):
    subject_id: str = Field(description="Entity ID the claim starts from.")
    predicate: str = Field(min_length=1, description="Specific verb, e.g. reads, signed in to, has role on. For events with more than two participants use an activity instead.")
    object_id: str = Field(description="Entity ID the claim points to.")
    source_id: str | None = None
    note: str = ""
    stance: str = "supports"
    confidence: float = 1
    valid_from: str | None = None
    valid_to: str | None = None
    id: str | None = None

class SourceInput(StrictModel):
    title: str = Field(min_length=1)
    uri: str = Field(default="", description="Where the original lives: log export path, repository path@commit, portal link.")
    excerpt: str = Field(default="", description="Original result rows (JSON) or quoted text. Required before an analyst can confirm evidence.")
    source_kind: Literal["primary", "secondary", "unknown"] = Field(default="unknown", description="primary = original logs, telemetry, files; secondary = context only, never proof.")
    query: str = Field(default="", description="Query text (e.g. KQL) that produced the excerpt. FactGraph never executes it.")
    id: str | None = None

class EvidenceInput(StrictModel):
    observation: str = Field(default="", description="What the original record shows, in one factual sentence.")
    locator: str = Field(default="", description="Exact place in the source: event ID, CorrelationId, result row, file:line.")
    interpretation: str = ""
    valid_from: str | None = None
    valid_to: str | None = None
    stance: str = "supports"
    confidence: float = Field(default=1, ge=0, le=1)
    source_id: str | None = None
    note: str = ""
    id: str | None = None

class ActionInput(StrictModel):
    id: str | None = None
    type: str
    payload: dict
    author: str = "API"

class ActionBatch(StrictModel):
    actions: list[ActionInput]

class RowsInput(StrictModel):
    dry_run: bool = False
    rows: list[dict]
    title: str = "Activity logs"
    query: str = ""
    subject_field: str | None = None
    object_field: str | None = None
    predicate: str = "accessed"
    predicate_field: str | None = None
    subject_kind: str = "IP"
    object_kind: str = "File"

class CompromiseInput(StrictModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)
    since: str | None = Field(default=None, alias="from")
    until: str | None = Field(default=None, alias="to")
    note: str = Field(default="", max_length=2000)
    cleared: bool = False

    @model_validator(mode="after")
    def window(self):
        if self.since and self.until and as_utc(self.since) > as_utc(self.until):
            raise ValueError("Compromise end must be after its start")
        for value in (self.since, self.until):
            if value:
                as_utc(value)
        return self

class EntityUpdate(StrictModel):
    compromise: CompromiseInput | None = Field(default=None, description="Stolen credential / attacker IP, ISO from/to optional; null clears.")
    rotated_at: str | None = None
    pinned: bool | None = None

    @model_validator(mode="after")
    def rotation_time(self):
        if self.rotated_at:
            as_utc(self.rotated_at)
        return self
    layer: Layer | None = Field(default=None, description=LAYER_HELP + " Explicit null returns to the inferred layer.")
    name: str | None = Field(default=None, min_length=1)
    kind: str | None = Field(default=None, min_length=1)
    description: str | None = None
    color: str | None = Field(default=None, pattern=r"^#[0-9a-fA-F]{6}$")

class EntityMergeInput(StrictModel):
    target_id: str

class SourceUpdate(StrictModel):
    expected_revision: str | None = None
    source_kind: Literal["primary", "secondary", "unknown"] | None = None
    query: str | None = None
    title: str | None = Field(default=None, min_length=1)
    uri: str | None = None
    excerpt: str | None = None

class RelationUpdate(StrictModel):
    subject_id: str | None = None
    predicate: str | None = Field(default=None, min_length=1)
    object_id: str | None = None
    valid_from: str | None = None
    valid_to: str | None = None

class EvidenceUpdate(StrictModel):
    expected_revision: str | None = None
    observation: str | None = None
    locator: str | None = None
    interpretation: str | None = None
    valid_from: str | None = None
    valid_to: str | None = None
    stance: str | None = None
    confidence: float | None = Field(default=None, ge=0, le=1)
    source_id: str | None = None
    note: str | None = None

