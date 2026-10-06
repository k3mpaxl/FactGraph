"""Import formats: which column of an export is which entity, what happened, when, and which row it was.

The built-in formats for Defender XDR and Sentinel tables live in tables.py. For any other export the analyst maps the
columns once in the import dialog and saves the mapping as a format in their browser; it travels with every import that
uses it, so the server keeps nothing. A format compiles into the same Mapping as the built-in tables, so the import
behaves the same: entities found by their identifiers, one evidence item per row with its own time and locator.
"""
from __future__ import annotations

import ipaddress
import re
from collections import Counter
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from app.tables import (HEURISTIC, LOCATOR_FIELDS, OPERATION_FIELDS, SCOPED_KINDS, TIME_FIELDS, Ident, Mapping, Part, details_of,
                        detect, locator_of, operation_of, parse_time, participants_of, phrase, resource_kind, text, time_of, url_kind)

ROLES = ("actor", "identity", "source", "tool", "via", "target", "other")

# What an ID column identifies, as the built-in formats record it: same scheme and namespace, so an entity a saved format
# imports is found again by a Defender or Sentinel import (and the other way round).
IdType = Literal["entra-object-id", "entra-app-id", "entra-device-id", "mde-device-id", "windows-sid", "sha256", "sha1", "md5",
                 "resource-id", "email", "ip", "fqdn", "other"]
ID_TYPES: dict[str, tuple[str, str]] = {
    "entra-object-id": ("external_id", "entra-object-id"), "entra-app-id": ("external_id", "entra-app-id"),
    "entra-device-id": ("external_id", "entra-device-id"), "mde-device-id": ("external_id", "mde-device-id"),
    "windows-sid": ("external_id", "windows-sid"), "sha256": ("external_id", "sha256"), "sha1": ("external_id", "sha1"),
    "md5": ("external_id", "md5"), "resource-id": ("resource_id", ""), "email": ("email", ""), "ip": ("ip", ""),
    "fqdn": ("fqdn", ""), "other": ("external_id", ""),
}
ID_TYPE_OF = {pair: name for name, pair in ID_TYPES.items() if name != "other"} | {("hostname", ""): "fqdn"}
# Types whose name identifies them on its own, as in the built-in heuristic mapping.
NAME_IDS = {"IP": "ip", "User": "email", "Device": "fqdn", "Azure Resource": "resource_id"}
LOWERCASE = ("User", "Device")


class FormatPart(BaseModel):
    # Saved formats come from the browser and may carry fields a later version adds (last used …): ignored, not refused.
    model_config = ConfigDict(extra="ignore")


class IdColumn(FormatPart):
    """A column with an ID of the entity. The entity's own column can be one too: then its value is the ID (an object ID
    column without a display name); the entity is found by it and named by it until an export brings the name."""
    column: str = Field(min_length=1, max_length=300)
    type: IdType = "other"
    namespace: str = Field(default="", max_length=100, description="For type other: the ID namespace as the board knows it, e.g. gitlab-user-id.")


class EntityColumn(FormatPart):
    column: str = Field(min_length=1, max_length=300, description="Column whose value names the entity, e.g. CallerIPAddress.")
    kind: str = Field(min_length=1, max_length=80, description="Entity type, e.g. IP, User, Service Principal, Key Vault.")
    role: str = Field(default="other", description="actor, identity, source, tool, via, target or other (ignored for relationship rows).")
    ids: list[IdColumn] = Field(default_factory=list, max_length=10, description="Columns with IDs of the same entity (object ID, DeviceId, SHA-256 …).")

    @field_validator("role")
    @classmethod
    def known_role(cls, value: str) -> str:
        value = value.strip().casefold()
        if value not in ROLES:
            raise ValueError(f"role must be one of {', '.join(ROLES)}")
        return value

    @field_validator("kind")
    @classmethod
    def trimmed(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("kind must not be empty")
        return value.strip()


class DetailColumn(FormatPart):
    column: str = Field(min_length=1, max_length=300)
    label: str = Field(default="", max_length=60)


class ImportFormat(FormatPart):
    """How the rows of one kind of export become board data."""
    version: int = 1
    id: str = Field(default="", max_length=100)
    name: str = Field(min_length=1, max_length=120, description="Name of the format, e.g. Key Vault diagnostics. Used in source titles and locators.")
    rows: Literal["activity", "relationship"] = Field(default="activity", description="activity: each row is an event with several participants; relationship: each row links the first entity to the second.")
    columns: list[str] = Field(default_factory=list, max_length=2000, description="Columns of the export the format was made from; used to recognise further exports.")
    entities: list[EntityColumn] = Field(min_length=1, max_length=30)
    operation: str = Field(default="observed", max_length=200, description="What happened (activities) or the relationship, when no operation_column is given or it is empty.")
    operation_column: str | None = Field(default=None, max_length=300, description="Column with what happened per row, e.g. OperationName.")
    time: str | None = Field(default=None, max_length=300, description="Column with the event time (read as UTC unless it names a zone).")
    end: str | None = Field(default=None, max_length=300)
    locator: list[str] = Field(default_factory=list, max_length=5, description="Columns that identify the original row, e.g. CorrelationId.")
    details: list[DetailColumn] = Field(default_factory=list, max_length=20, description="Columns shown with each evidence item, e.g. ResultType.")

    @model_validator(mode="after")
    def enough_entities(self):
        if self.rows == "relationship" and len(self.entities) != 2:
            raise ValueError("A relationship format needs exactly two entity columns: from and to")
        if self.rows == "activity" and len(self.entities) < 2:
            raise ValueError("An activity needs at least two entity columns (who or what takes part)")
        if not self.operation.strip() and not self.operation_column:
            raise ValueError("Give the operation as text or as a column")
        return self


def used_columns(fmt: ImportFormat) -> list[str]:
    columns = [e.column for e in fmt.entities] + [i.column for e in fmt.entities for i in e.ids]
    columns += [c for c in (fmt.operation_column, fmt.time, fmt.end) if c] + fmt.locator + [d.column for d in fmt.details]
    return list(dict.fromkeys(columns))


def missing_columns(fmt: ImportFormat, columns: set[str]) -> list[str]:
    return [c for c in used_columns(fmt) if c not in columns]


def _entity_name(column: str, kind: str):
    def build(row, g) -> str:
        value = text(g(column))
        if kind in SCOPED_KINDS:
            # A file or process is named by its file name; the full path identifies it together with the device.
            return value.replace("/", "\\").rstrip("\\").split("\\")[-1]
        if "/subscriptions/" in value.lower():
            # An Azure resource ID: named by its last segment, as the built-in mappings do.
            return value.rstrip("/").split("/")[-1]
        return value
    return build


def compile_format(fmt: ImportFormat) -> Mapping:
    """The Mapping the built-in tables use, so a saved format imports exactly like them."""
    parts = []
    for entity in fmt.entities:
        kind = entity.kind
        # The name identifies IPs, users and devices on its own, unless the column holds an ID instead (an object ID).
        own_id = any(i.column == entity.column for i in entity.ids)
        ids = [Ident(entity.column, NAME_IDS[kind])] if kind in NAME_IDS and not own_id else []
        for ident in entity.ids:
            scheme, namespace = ID_TYPES[ident.type]
            if ident.type == "other":
                namespace = ident.namespace or re.sub(r"[^a-z0-9]+", "-", ident.column.casefold()).strip("-") or "id"
            if Ident(ident.column, scheme, namespace) not in ids:
                ids.append(Ident(ident.column, scheme, namespace))
        parts.append(Part(entity.role, kind, (entity.column,), tuple(ids), lower=kind in LOWERCASE,
                          name=_entity_name(entity.column, kind), path=(entity.column,) if kind in SCOPED_KINDS else (),
                          kind_of=url_kind if kind == "URL" else resource_kind if kind == "Azure Resource" else None))
    fixed = fmt.operation.strip() or "observed"
    operation = (lambda row, g, c=fmt.operation_column: phrase(g(c)) or fixed) if fmt.operation_column else (lambda row, g: fixed)
    return Mapping(fmt.name, "format", (), tuple(parts), operation=operation,
                   time=(fmt.time,) if fmt.time else (), end=(fmt.end,) if fmt.end else (), locator=tuple(fmt.locator),
                   details=tuple((d.label.strip() or d.column, d.column) for d in fmt.details))


# ------------------------------------------------------------------------------------------------ reading an export

GUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", re.I)
EMAIL = re.compile(r"[^@\s]+@[^@\s]+\.[^@\s]+")
URL = re.compile(r"[a-z][a-z0-9+.-]*://\S+", re.I)
DOMAIN = re.compile(r"(?=.{4,253}$)(?:[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}\.?", re.I)
FILE_EXTENSIONS = {"exe", "dll", "sys", "ps1", "psm1", "bat", "cmd", "vbs", "js", "jar", "msi", "lnk", "sh", "py", "txt", "pdf",
                   "doc", "docx", "docm", "xls", "xlsx", "xlsm", "ppt", "pptx", "zip", "rar", "7z", "gz", "tar", "iso", "img", "json",
                   "xml", "csv", "log", "yml", "yaml", "env", "ini", "cfg", "conf", "config", "png", "jpg", "jpeg", "gif", "html", "htm",
                   "php", "aspx", "db", "key", "pem", "pfx", "crt"}


def value_type(values: list[str]) -> str:
    """What most values of a column look like: ip, email, url, domain, file, path, guid, sha256/sha1/md5, time, number, json or text."""
    values = [v for v in values if v][:50]
    if not values:
        return "empty"

    def share(test) -> float:
        hits = 0
        for v in values:
            try:
                hits += bool(test(v))
            except (ValueError, TypeError):
                pass
        return hits / len(values)

    checks = (
        ("json", lambda v: v[:1] in "[{"),
        ("guid", GUID.fullmatch),
        ("ip", lambda v: ipaddress.ip_address(v)),
        ("email", EMAIL.fullmatch),
        ("url", URL.fullmatch),
        ("sha256", lambda v: re.fullmatch(r"[0-9a-f]{64}", v, re.I)),
        ("sha1", lambda v: re.fullmatch(r"[0-9a-f]{40}", v, re.I)),
        ("md5", lambda v: re.fullmatch(r"[0-9a-f]{32}", v, re.I)),
        ("number", lambda v: re.fullmatch(r"-?\d+(?:[.,]\d+)?", v)),
        ("time", lambda v: re.search(r"\d[-/.:]\d|\d, \d", v) and parse_time(v)),
        ("file", lambda v: "/" not in v and "\\" not in v and " " not in v and v.rsplit(".", 1)[-1].lower() in FILE_EXTENSIONS and "." in v),
        ("domain", DOMAIN.fullmatch),
        ("path", lambda v: "\\" in v or (v.count("/") >= 1 and " " not in v.strip("/"))),
    )
    for name, test in checks:
        if share(test) >= 0.8:
            return name
    return "text"


Known = dict[str, set[tuple[str, str, str]]]


def board_names(index: dict | None, rows: list[dict]) -> dict[str, str]:
    """For the preview: values of the sample rows that are IDs of entities on the board, with those entities' names (an
    object ID shows as the user it belongs to, as the import will find it)."""
    values = {text(v).casefold() for row in rows for v in row.values() if isinstance(v, str) and text(v)}
    names: dict[str, str] = {}
    for entity in (index or {}).get("entities", []):
        for ident in entity.get("identifiers") or []:
            value = str(ident.get("normalized_value") or "").strip().casefold()
            if value in values and value != str(entity.get("name") or "").casefold():
                names.setdefault(value, str(entity.get("name") or ""))
    return names


def board_values(index: dict | None) -> Known:
    """Every name and identifier of the entities on the board, lowercased, with the (type, scheme, namespace) it belongs to."""
    known: Known = {}
    for entity in (index or {}).get("entities", []):
        kind = str(entity.get("kind") or "Other")
        known.setdefault(str(entity.get("name") or "").strip().casefold(), set()).add((kind, "name", ""))
        for ident in entity.get("identifiers") or []:
            known.setdefault(str(ident.get("normalized_value") or "").strip().casefold(), set()).add(
                (kind, str(ident.get("scheme") or ""), str(ident.get("namespace") or "")))
    known.pop("", None)
    return known


# Values unique enough that one match on the board says what the column is; others need most values to match.
UNIQUE_TYPES = {"guid", "ip", "email", "sha256", "sha1", "md5"}


def board_match(values: list[str], kind_of_values: str, known: Known) -> dict | None:
    """Which entities on the board the values of a column name or identify: e.g. object IDs a Sentinel import stored with
    users. The type, the ID type and how many of the distinct values matched."""
    distinct = list(dict.fromkeys(v.strip().rstrip(".").casefold() for v in values if v))[:200]
    if not distinct or not known:
        return None
    counts: Counter = Counter()
    for value in distinct:
        for key in known.get(value, ()):
            counts[key] += 1
    if not counts:
        return None
    # The most matches; on a tie an identifier rather than a name (an IP is both).
    (kind, scheme, namespace), hits = max(counts.items(), key=lambda item: (item[1], item[0][1] != "name"))
    if hits / len(distinct) < 0.5 and kind_of_values not in UNIQUE_TYPES:
        return None
    id_type = None if scheme == "name" else ID_TYPE_OF.get((scheme, namespace), "other")
    return {"kind": kind, "id_type": id_type, "namespace": namespace if id_type == "other" else "", "matches": hits, "of": len(distinct)}


def column_profiles(columns: list[str], rows: list[dict], known: Known | None = None) -> list[dict]:
    """Per column: its value type, how many of the first rows have a value, a few distinct sample values, and which
    entities on the board its values name or identify."""
    out = []
    for column in columns:
        values = [text(row.get(column)) for row in rows[:200]]
        filled = [v for v in values if v]
        kind = value_type(filled)
        out.append({"name": column, "type": kind, "filled": len(filled), "of": len(values),
                    "samples": list(dict.fromkeys(v[:80] for v in filled))[:4], "known": board_match(filled, kind, known) if known else None})
    return out


# Columns with an ID of an entity that another column names: suffix, entity types it belongs to, ID type, value type.
ID_COLUMNS = (("ObjectId", ("User", "Service Principal", "Managed Identity"), "entra-object-id", "guid"),
              ("AppId", ("Service Principal", "Service"), "entra-app-id", "guid"),
              ("UserId", ("User",), "entra-object-id", "guid"),
              ("DeviceId", ("Device",), "mde-device-id", None),
              ("Sid", ("User",), "windows-sid", None),
              ("SHA256", ("File", "Process"), "sha256", "sha256"), ("SHA1", ("File", "Process"), "sha1", "sha1"),
              ("MD5", ("File", "Process"), "md5", "md5"))
DETAIL_COLUMNS = (("ResultType", "result"), ("ResultDescription", "result"), ("Result", "result"), ("Status", "status"),
                  ("status", "status"), ("ResultSignature", "result"))
OPERATION_NAMES = re.compile(r"action|operation|event|activity|method|verb|command", re.I)


def suggest(columns: list[str], rows: list[dict], known: Known | None = None, profiles: dict | None = None) -> dict:
    """A starting point for a new format: known column names first (as the built-in heuristic), then what the values look
    like (IPs, mail addresses, URLs …), then what the board already knows about the values (an object ID a Defender or
    Sentinel import stored with a user). The analyst checks and adjusts it in the import dialog."""
    profiles = profiles or {p["name"]: p for p in column_profiles(columns, rows, known)}
    available = set(columns)
    entities: list[dict] = []
    used: set[str] = set()

    def add(column: str, kind: str, role: str) -> None:
        entities.append({"column": column, "kind": kind, "role": role, "ids": []})
        used.add(column)

    for role, kind, candidates, _ in HEURISTIC:
        column = next((c for c in candidates if c in available and c not in used), None)
        if column:
            add(column, kind, role)
    by_value = {"ip": "IP", "email": "User", "url": "URL", "domain": "Domain", "file": "File"}
    def role_for(kind: str) -> str:
        roles = {e["role"] for e in entities}
        if kind == "IP":
            return "source" if not any(e["kind"] == "IP" for e in entities) else "target"
        if kind == "User":
            return "actor" if "actor" not in roles else "target"
        if kind in ("Service Principal", "Managed Identity"):
            return "identity" if "identity" not in roles else "target"
        if kind == "Device":
            return "source" if "source" not in roles else "target"
        return "target"

    for column in columns:
        kind = by_value.get(profiles[column]["type"])
        if not kind or column in used or len(entities) >= 6:
            continue
        add(column, kind, role_for(kind))
    for column in columns:
        if column in used:
            continue
        for suffix, kinds, id_type, value in ID_COLUMNS:
            if column.casefold().endswith(suffix.casefold()) and (value is None or profiles[column]["type"] == value):
                owner = next((e for e in entities if e["kind"] in kinds), None)
                if owner:
                    owner["ids"].append({"column": column, "type": id_type})
                    used.add(column)
                break
    # What the board knows decides over names and looks: these values are entities of that type already.
    for column in columns:
        match = profiles[column].get("known")
        if not match:
            continue
        own = {"column": column, "type": match["id_type"], "namespace": match["namespace"]} if match["id_type"] else None
        entity = next((e for e in entities if e["column"] == column), None)
        names_itself = own and ID_TYPES[own["type"]][0] == NAME_IDS.get(match["kind"])
        if entity:
            entity["kind"] = match["kind"]
            if own and not names_itself:
                entity["ids"].append(own)
            continue
        if column in used:
            continue
        owner = next((e for e in entities if e["kind"] == match["kind"]), None)
        if owner and own:
            owner["ids"].append(own)
            used.add(column)
        elif len(entities) < 8:
            add(column, match["kind"], role_for(match["kind"]))
            if own and not names_itself:
                entities[-1]["ids"].append(own)
    operation = next((c for c in OPERATION_FIELDS if c in available and c not in used), None) or next(
        (c for c in columns if c not in used and OPERATION_NAMES.search(c) and profiles[c]["type"] == "text"), None)
    time = next((c for c in TIME_FIELDS if c in available), None) or next((c for c in columns if c not in used and profiles[c]["type"] == "time"), None)
    end = next((c for c in ("EndTime", "EventEndTime", "end_time", "EndDateTime") if c in available and c != time), None)
    # The classic two-column access log (IPAddress → FilePath) is a relationship per row, as the automatic import treats it.
    from app.ingest import OBJECT_FIELDS, SUBJECT_FIELDS
    classic = len(entities) == 2 and entities[0]["column"] in SUBJECT_FIELDS and entities[1]["column"] in OBJECT_FIELDS
    return {"version": 1, "name": "", "rows": "relationship" if classic else "activity", "columns": columns, "entities": entities,
            "operation": "accessed" if classic else "observed", "operation_column": operation, "time": time, "end": end,
            "locator": [c for c in LOCATOR_FIELDS if c in available][:2],
            "details": [{"column": c, "label": label} for c, label in DETAIL_COLUMNS if c in available and c not in used][:2]}


def inspect_rows(rows: list[dict], filename: str = "", index: dict | None = None) -> dict:
    """Everything the import dialog shows before anything is imported. index: the board's entities with their identifiers,
    so columns whose values the board already knows are recognised."""
    columns = list(dict.fromkeys(key for row in rows[:1000] for key in row))
    known = board_values(index)
    profiles = column_profiles(columns, rows, known)
    detection = detect(set(columns))
    from app.ingest import OBJECT_FIELDS, SUBJECT_FIELDS
    builtin = None
    if detection.confident and detection.mapping:
        builtin = {"table": detection.table, "product": detection.product, **{k: v for k, v in detection.summary().items() if k in ("roles", "operation", "known_columns", "total_columns", "doc")}}
    elif any(c in columns for c in SUBJECT_FIELDS) and any(c in columns for c in OBJECT_FIELDS):
        builtin = {"table": "Log rows", "product": "two-column access log", "roles": [], "operation": "accessed"}
    sample = [{k: (v[:2000] if isinstance(v, str) else v) for k, v in row.items()} for row in rows[:30]]
    return {"file": filename, "rows": len(rows), "columns": profiles, "sample": sample, "builtin": builtin,
            "detection": detection.summary(), "suggestion": suggest(columns, rows, known, {p["name"]: p for p in profiles}),
            "board_names": board_names(index, sample)}


def preview_rows(rows: list[dict], fmt: ImportFormat) -> list[dict]:
    """The first rows as the import will see them: participants, what happened, when, and why a row would be skipped."""
    out = []
    if fmt.rows == "relationship":
        first, second = fmt.entities
        from app.ingest import TIME_FIELDS as AUTO_TIMES
        for number, row in enumerate(rows, 1):
            names = [text(row.get(first.column)), text(row.get(second.column))]
            relation = text(row.get(fmt.operation_column)) if fmt.operation_column else fmt.operation.strip()
            stamp = parse_time(row.get(fmt.time)) if fmt.time else next((parse_time(row[k]) for k in ("valid_from", "StartTime", *AUTO_TIMES) if text(row.get(k))), None)
            skipped = "an entity column is empty" if not all(names) else "no relationship" if not relation else None
            out.append({"row": number, "time": stamp, "end": parse_time(row.get(fmt.end)) if fmt.end else None, "operation": relation, "skipped": skipped,
                        "participants": [{"role": "from", "kind": first.kind, "name": names[0]}, {"role": "to", "kind": second.kind, "name": names[1]}],
                        "details": [], "locator": " ".join(f"{c}={text(row.get(c))}" for c in fmt.locator if text(row.get(c))) or f"row {number}"})
        return out
    mapping = compile_format(fmt)
    for number, row in enumerate(rows, 1):
        participants = participants_of(mapping, row)
        start, end = time_of(mapping, row)
        distinct = {(p["kind"].casefold(), p["name"].casefold()) for p in participants}
        out.append({"row": number, "time": start, "end": end, "operation": operation_of(mapping, row),
                    "participants": [{"role": p["role"], "kind": p["kind"], "name": p["name"]} for p in participants],
                    "details": details_of(mapping, row), "locator": locator_of(mapping, row, number),
                    "skipped": None if len(distinct) >= 2 else "fewer than two entities in this row"})
    return out
