"""Shared request contracts for REST and MCP."""
from __future__ import annotations
from typing import Literal
from datetime import datetime, timezone
from pydantic import BaseModel, Field, ConfigDict, model_validator

def as_utc(value: str):
    date = datetime.fromisoformat(value.replace("Z", "+00:00"))
    return date.astimezone(timezone.utc) if date.tzinfo else date.replace(tzinfo=timezone.utc)

class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")

    @model_validator(mode="after")
    def field_invariants(self):
        nullable = {'id', 'source_id', 'valid_from', 'valid_to', 'color', 'x', 'y', 'subject_field', 'object_field', 'predicate_field', 'expected_source_revision', 'expected_revision'}
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
    name: str = Field(min_length=1)
    kind: str = "Other"
    description: str = ""
    color: str | None = Field(default=None, pattern=r"^#[0-9a-fA-F]{6}$")
    pinned: bool = False
    x: float | None = Field(default=None, ge=-100000, le=100000, allow_inf_nan=False)
    y: float | None = Field(default=None, ge=-100000, le=100000, allow_inf_nan=False)
    id: str | None = None

class RelationInput(StrictModel):
    subject_id: str
    predicate: str = Field(min_length=1)
    object_id: str
    source_id: str | None = None
    note: str = ""
    stance: str = "supports"
    confidence: float = 1
    valid_from: str | None = None
    valid_to: str | None = None
    id: str | None = None

class SourceInput(StrictModel):
    title: str = Field(min_length=1)
    uri: str = ""
    excerpt: str = ""
    source_kind: Literal["primary", "secondary", "unknown"] = "unknown"
    query: str = ""
    id: str | None = None

class EvidenceInput(StrictModel):
    observation: str = ""
    locator: str = ""
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
    title: str = "Aktivitätslogs"
    query: str = ""
    subject_field: str | None = None
    object_field: str | None = None
    predicate: str = "accessed"
    predicate_field: str | None = None
    subject_kind: str = "IP"
    object_kind: str = "Datei"

class EntityUpdate(StrictModel):
    pinned: bool | None = None
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

