"""Turn exported activity/KQL rows into deterministic, evidence-backed graph actions.

No query is executed here. The caller supplies the query text and its result rows.
"""

from __future__ import annotations

import csv
import hashlib
import io
import json
from datetime import datetime, timezone
from uuid import UUID, uuid4, uuid5


def action(action_type: str, payload: dict, *, action_id: str | None = None,
           author: str = "API") -> dict:
    return {"id": action_id or str(uuid4()), "type": action_type,
            "payload": payload, "author": author}


def entity_actions(name: str, kind: str = "Sonstiges", description: str = "",
                   entity_id: str | None = None) -> tuple[str, list[dict]]:
    name = name.strip()
    if not name:
        raise ValueError("Entity name must not be empty")
    entity_id = entity_id or str(uuid4())
    return entity_id, [action("entity.add", {"id": entity_id, "name": name,
        "kind": kind.strip() or "Sonstiges", "description": description.strip()})]


def relation_actions(subject_id: str, predicate: str, object_id: str,
                     *, source_id: str | None = None, note: str = "",
                     stance: str = "supports", confidence: float = 1,
                     valid_from: str | None = None, valid_to: str | None = None, relation_id: str | None = None) -> tuple[str, list[dict]]:
    if not subject_id or not object_id or subject_id == object_id:
        raise ValueError("A relationship needs two different entity IDs")
    if not predicate.strip():
        raise ValueError("A relationship needs a predicate")
    if stance not in {"supports", "refutes"} or not 0 <= confidence <= 1:
        raise ValueError("Invalid stance or confidence")
    relation_id = relation_id or str(uuid4())
    drafts = [action("fact.add", {"id": relation_id, "subject_id": subject_id,
        "predicate": predicate.strip(), "object_id": object_id,
        "valid_from": valid_from, "valid_to": valid_to})]
    if source_id or note:
        drafts.append(action("assertion.add", {"id": str(uuid4()), "fact_id": relation_id,
            "stance": stance, "confidence": confidence, "source_id": source_id,
            "note": note, "valid_from": valid_from, "valid_to": valid_to}))
    return relation_id, drafts


SUBJECT_FIELDS = ("IPAddress", "ClientIP", "SourceIp", "source_ip", "ip", "ActorIP", "actor")
OBJECT_FIELDS = ("FilePath", "file_path", "TargetResource", "Resource", "target", "ObjectName", "resource")
TIME_FIELDS = ("TimeGenerated", "timestamp", "Timestamp", "time", "event_time", "CreatedDateTime", "EventStartTime")


def parse_rows(content: bytes, filename: str) -> list[dict]:
    text = content.decode("utf-8-sig")
    if filename.lower().endswith((".jsonl", ".ndjson")):
        rows = [json.loads(line) for line in text.splitlines() if line.strip()]
    elif filename.lower().endswith(".json"):
        parsed = json.loads(text)
        if isinstance(parsed, dict):
            rows = parsed.get("rows", parsed.get("value", parsed.get("results", [])))
        else:
            rows = parsed
    else:
        rows = list(csv.DictReader(io.StringIO(text)))
    if not isinstance(rows, list) or any(not isinstance(row, dict) for row in rows):
        raise ValueError("Expected CSV, a JSON array or JSONL with object rows")
    return rows


def _field(rows: list[dict], explicit: str | None, candidates: tuple[str, ...], label: str) -> str:
    keys = set().union(*(row.keys() for row in rows)) if rows else set()
    if explicit:
        if explicit not in keys:
            raise ValueError(f"Column {explicit!r} is missing. Available: {', '.join(sorted(keys))}")
        return explicit
    for candidate in candidates:
        if candidate in keys:
            return candidate
    raise ValueError(f"No {label} column detected. Available: {', '.join(sorted(keys))}")


def _time(value: str | None) -> str | None:
    """ISO UTC for the formats portals export ("9/28/2026, 10:42:07 AM"); unknown formats stay as they are."""
    from app.tables import parse_time
    return (parse_time(value) or value) if value else None


def _stable(board_id: str, *parts: str) -> str:
    return str(uuid5(UUID(board_id), "\x1f".join(parts)))


def rows_to_actions(board_id: str, rows: list[dict], *, title: str,
                    query: str = "", subject_field: str | None = None,
                    object_field: str | None = None, predicate: str = "accessed",
                    predicate_field: str | None = None,
                    subject_kind: str = "IP", object_kind: str = "File",
                    existing_entities: dict[tuple[str, str], str] | None = None,
                    existing_facts: dict[tuple[str, str, str], str] | None = None,
                    existing_sources: set[str] | None = None) -> tuple[list[dict], dict]:
    if not rows:
        raise ValueError("The file contains no result rows")
    if len(rows) > 50_000:
        raise ValueError("At most 50,000 rows per import")
    subject_field = _field(rows, subject_field, SUBJECT_FIELDS, "source")
    object_field = _field(rows, object_field, OBJECT_FIELDS, "target")
    if predicate_field:
        predicate_field = _field(rows, predicate_field, (), "predicate")
    predicate = predicate.strip()
    if not predicate:
        raise ValueError("The predicate must not be empty")

    canonical_rows = json.dumps(rows, sort_keys=True, ensure_ascii=False, default=str)
    digest = hashlib.sha256((title + "\n" + query + "\n" + canonical_rows).encode()).hexdigest()
    source_id = _stable(board_id, "import", digest)
    now = datetime.now(timezone.utc).isoformat()
    drafts = []
    if source_id not in (existing_sources or set()):
        drafts.append(action("source.add", {"id": source_id, "title": title,
            "uri": f"import://{digest[:16]}", "excerpt": canonical_rows, "query": query, "source_kind": "primary",
            "created_at": now}, action_id=_stable(board_id, "source-action", source_id), author="Import"))
    seen_entities: set[str] = set()
    seen_facts: set[str] = set()
    assertions = 0
    skipped = 0
    for row_number, row in enumerate(rows, 1):
        subject = str(row.get(subject_field) or "").strip()
        object_name = str(row.get(object_field) or "").strip()
        if not subject or not object_name:
            skipped += 1
            continue
        row_predicate = str(row.get(predicate_field) or predicate).strip() if predicate_field else predicate
        if not row_predicate:
            skipped += 1
            continue
        subject_id = (existing_entities or {}).get((subject_kind.casefold(), subject.casefold())) or _stable(board_id, "entity", subject_kind, subject.casefold())
        object_id = (existing_entities or {}).get((object_kind.casefold(), object_name.casefold())) or _stable(board_id, "entity", object_kind, object_name.casefold())
        for entity_id, name, kind in ((subject_id, subject, subject_kind),
                                      (object_id, object_name, object_kind)):
            if entity_id not in seen_entities:
                seen_entities.add(entity_id)
                if entity_id not in (existing_entities or {}).values():
                    drafts.append(action("entity.add", {"id": entity_id, "name": name,
                        "kind": kind, "description": ""},
                        action_id=_stable(board_id, "entity-action", entity_id), author="Import"))
        fact_key = (subject_id, row_predicate.casefold(), object_id)
        fact_id = (existing_facts or {}).get(fact_key) or _stable(board_id, "fact", *fact_key)
        if fact_id not in seen_facts:
            seen_facts.add(fact_id)
            if fact_id not in (existing_facts or {}).values():
                drafts.append(action("fact.add", {"id": fact_id, "subject_id": subject_id,
                    "predicate": row_predicate, "object_id": object_id, "valid_from": None,
                    "valid_to": None, "created_at": now},
                    action_id=_stable(board_id, "fact-action", fact_id), author="Import"))
        row_text = json.dumps(row, sort_keys=True, ensure_ascii=False, default=str)
        assertion_id = _stable(board_id, "assertion", source_id, fact_id, row_text)
        timestamp = _time(next((str(row[key]) for key in ("valid_from", "StartTime", *TIME_FIELDS) if row.get(key)), None))
        end = _time(next((str(row[key]) for key in ("valid_to", "EndTime") if row.get(key)), None))
        drafts.append(action("assertion.add", {"id": assertion_id, "fact_id": fact_id,
            "stance": "supports", "confidence": 1, "source_id": source_id,
            "note": row_text, "observation": f"{subject} {row_predicate} {object_name}", "locator": str(row.get("EventId") or row.get("event_id") or f"result row {row_number}"), "created_at": now, "valid_from": timestamp, "valid_to": end},
            action_id=_stable(board_id, "assertion-action", assertion_id), author="Import"))
        assertions += 1
    return drafts, {"rows": len(rows), "skipped": skipped, "entities": len(seen_entities),
                    "relations": len(seen_facts), "evidence": assertions,
                    "source_id": source_id, "subject_field": subject_field,
                    "object_field": object_field}


def activity_rows_to_actions(board_id: str, rows: list[dict], *, title: str, roles: list[dict],
                             query: str = "", operation: str = "performed", operation_field: str | None = None,
                             existing_entities: dict[tuple[str, str], str] | None = None,
                             existing_facts: set[str] | None = None,
                             existing_sources: set[str] | None = None) -> tuple[list[dict], dict]:
    """Each row becomes evidence for one activity whose participants come from several columns.

    Rows with the same operation and the same participants share one activity; the row keeps its
    own timestamp as the evidence period, so the timeline still shows every single occurrence.
    """
    if not rows:
        raise ValueError("The file contains no result rows")
    if len(rows) > 50_000:
        raise ValueError("At most 50,000 rows per import")
    if len(roles) < 2:
        raise ValueError("Map at least two columns to roles")
    keys = set().union(*(row.keys() for row in rows))
    for mapping in roles:
        if mapping["field"] not in keys:
            raise ValueError(f"Column {mapping['field']!r} is missing. Available: {', '.join(sorted(keys))}")
    if operation_field and operation_field not in keys:
        raise ValueError(f"Column {operation_field!r} is missing. Available: {', '.join(sorted(keys))}")
    canonical_rows = json.dumps(rows, sort_keys=True, ensure_ascii=False, default=str)
    digest = hashlib.sha256((title + "\n" + query + "\n" + json.dumps(roles, sort_keys=True) + "\n" + canonical_rows).encode()).hexdigest()
    source_id = _stable(board_id, "import", digest)
    now = datetime.now(timezone.utc).isoformat()
    drafts: list[dict] = []
    if source_id not in (existing_sources or set()):
        drafts.append(action("source.add", {"id": source_id, "title": title, "uri": f"import://{digest[:16]}",
            "excerpt": canonical_rows, "query": query, "source_kind": "primary", "created_at": now},
            action_id=_stable(board_id, "source-action", source_id), author="Import"))
    seen_entities: set[str] = set()
    seen_activities: set[str] = set()
    evidence = skipped = 0
    for row_number, row in enumerate(rows, 1):
        participants = []
        for mapping in roles:
            value = str(row.get(mapping["field"]) or "").strip()
            if not value:
                continue
            kind = (mapping.get("kind") or "Other").strip() or "Other"
            entity_id = (existing_entities or {}).get((kind.casefold(), value.casefold())) or _stable(board_id, "entity", kind, value.casefold())
            if entity_id not in seen_entities:
                seen_entities.add(entity_id)
                if entity_id not in (existing_entities or {}).values():
                    drafts.append(action("entity.add", {"id": entity_id, "name": value, "kind": kind, "description": ""},
                        action_id=_stable(board_id, "entity-action", entity_id), author="Import"))
            role = mapping["role"].strip().casefold()
            if not any(p["entity_id"] == entity_id and p["role"] == role for p in participants):
                participants.append({"entity_id": entity_id, "role": role})
        row_operation = str(row.get(operation_field) or operation).strip() if operation_field else operation.strip()
        if len({p["entity_id"] for p in participants}) < 2 or not row_operation:
            skipped += 1
            continue
        key = "|".join(sorted(f"{p['role']}:{p['entity_id']}" for p in participants))
        activity_id = _stable(board_id, "activity", row_operation.casefold(), key)
        if activity_id not in seen_activities:
            seen_activities.add(activity_id)
            if activity_id not in (existing_facts or set()):
                drafts.append(action("fact.add", {"id": activity_id, "predicate": row_operation, "participants": participants,
                    "valid_from": None, "valid_to": None, "created_at": now},
                    action_id=_stable(board_id, "activity-action", activity_id), author="Import"))
        row_text = json.dumps(row, sort_keys=True, ensure_ascii=False, default=str)
        assertion_id = _stable(board_id, "assertion", source_id, activity_id, row_text)
        timestamp = _time(next((str(row[k]) for k in ("valid_from", "StartTime", *TIME_FIELDS) if row.get(k)), None))
        end = _time(next((str(row[k]) for k in ("valid_to", "EndTime") if row.get(k)), None))
        names = ", ".join(f"{m['role']} {row.get(m['field'])}" for m in roles if row.get(m["field"]))
        drafts.append(action("assertion.add", {"id": assertion_id, "fact_id": activity_id, "stance": "supports", "confidence": 1,
            "source_id": source_id, "note": row_text, "observation": f"{row_operation}: {names}",
            "locator": str(row.get("CorrelationId") or row.get("EventId") or row.get("event_id") or f"result row {row_number}"),
            "created_at": now, "valid_from": timestamp, "valid_to": end},
            action_id=_stable(board_id, "assertion-action", assertion_id), author="Import"))
        evidence += 1
    return drafts, {"rows": len(rows), "skipped": skipped, "entities": len(seen_entities), "relations": len(seen_activities),
                    "activities": len(seen_activities), "evidence": evidence, "source_id": source_id,
                    "roles": [f"{m['field']} → {m['role']}" for m in roles]}


# Identifiers that are unique on their own (GUIDs, hashes, resource IDs) may join entities of different types
# (a File and a Process with the same SHA-256 are one binary); names like IPs, FQDNs or emails only within a type.
GLOBAL_SCHEMES = {"external_id", "resource_id"}


def normalize_identifier(scheme: str, namespace: str, raw: str) -> str:
    value = raw.strip()
    if scheme in ("hostname", "fqdn", "email", "resource_id") or namespace in ("sha256", "sha1", "md5", "entra-object-id",
                                                                                 "entra-app-id", "entra-device-id", "mde-device-id"):
        value = value.rstrip(".").lower()
    return value


def identifier_key(kind: str, scheme: str, namespace: str, normalized: str) -> tuple[str, str, str, str]:
    return ("" if scheme in GLOBAL_SCHEMES else kind.casefold(), scheme, namespace, normalized)


def table_rows_to_actions(board_id: str, rows: list[dict], mapping, *, title: str, query: str = "",
                          existing_entities: dict[tuple[str, str], str] | None = None,
                          existing_identifiers: dict[tuple[str, str, str, str], str] | None = None,
                          known_identifiers: set[tuple[str, str, str, str]] | None = None,
                          existing_facts: set[str] | None = None,
                          existing_sources: set[str] | None = None) -> tuple[list[dict], dict]:
    """Rows of a recognised Defender XDR / Sentinel table become activities with role-tagged participants.

    Entities are found by their identifiers first (DeviceId, AccountObjectId, SHA-256 …), then by type and name, so a
    device seen in DeviceNetworkEvents and in SigninLogs is one entity. Missing identifiers are added to it. Every row
    is its own unconfirmed evidence item with its own time and a locator such as "DeviceNetworkEvents ReportId=… DeviceId=…".
    """
    from app.tables import locator_of, operation_of, participants_of, time_of

    if not rows:
        raise ValueError("The file contains no result rows")
    if len(rows) > 50_000:
        raise ValueError("At most 50,000 rows per import; split the export or narrow the query")
    canonical_rows = json.dumps(rows, sort_keys=True, ensure_ascii=False, default=str)
    digest = hashlib.sha256((title + "\n" + query + "\n" + mapping.table + "\n" + canonical_rows).encode()).hexdigest()
    source_id = _stable(board_id, "import", digest)
    now = datetime.now(timezone.utc).isoformat()
    drafts: list[dict] = []
    if source_id not in (existing_sources or set()):
        drafts.append(action("source.add", {"id": source_id, "title": title, "uri": f"import://{digest[:16]}",
            "excerpt": canonical_rows, "query": query, "source_kind": "primary", "created_at": now},
            action_id=_stable(board_id, "source-action", source_id), author="Import"))
    by_name = dict(existing_entities or {})
    by_identifier = dict(existing_identifiers or {})
    have_identifier = set(known_identifiers or set())
    existing_ids = set(by_name.values()) | set(by_identifier.values())
    # Which ID namespaces each entity already has, to refuse a name match that contradicts them.
    id_namespaces = {(owner, scheme, namespace) for owner, scheme, namespace, _ in have_identifier}
    created: set[str] = set()
    touched: set[str] = set()
    activities: set[str] = set()
    evidence = skipped = identifiers_added = 0
    times: list[str] = []
    for row_number, row in enumerate(rows, 1):
        participants: list[dict] = []
        labels: list[str] = []
        for part in participants_of(mapping, row):
            kind, name = part["kind"], part["name"]
            keys = [(identifier_key(kind, i["scheme"], i["namespace"], normalize_identifier(i["scheme"], i["namespace"], i["raw"])), i)
                    for i in part["identifiers"]]
            def contradicts(candidate: str) -> bool:
                # Same name or FQDN, but a different ID of the same kind (another DeviceId, another SHA-256): a different thing.
                return any(k[1] in GLOBAL_SCHEMES and (candidate, k[1], k[2]) in id_namespaces and (candidate, *k[1:]) not in have_identifier
                           for k, _ in keys)
            # Strong IDs first (DeviceId, object IDs, hashes), then name-like identifiers (FQDN, IP, email), then the name.
            entity_id = next((by_identifier[k] for k, _ in keys if k[1] in GLOBAL_SCHEMES and k in by_identifier), None)
            if not entity_id:
                weak = [by_identifier[k] for k, _ in keys if k[1] not in GLOBAL_SCHEMES and k in by_identifier]
                named = by_name.get((kind.casefold(), name.casefold()))
                entity_id = next((c for c in [*weak, named] if c and not contradicts(c)), None)
            if not entity_id:
                anchor = next((f"{k[1]}:{k[2]}:{k[3]}" for k, _ in keys if k[1] in GLOBAL_SCHEMES), name.casefold())
                entity_id = _stable(board_id, "entity", kind, anchor)
            if entity_id not in existing_ids and entity_id not in created:
                created.add(entity_id)
                drafts.append(action("entity.add", {"id": entity_id, "name": name, "kind": kind, "description": ""},
                    action_id=_stable(board_id, "entity-action", entity_id), author="Import"))
            touched.add(entity_id)
            by_name.setdefault((kind.casefold(), name.casefold()), entity_id)
            for key, ident in keys:
                by_identifier.setdefault(key, entity_id)
                owned = (entity_id, *key[1:])
                if owned in have_identifier:
                    continue
                have_identifier.add(owned)
                id_namespaces.add((entity_id, key[1], key[2]))
                identifier_id = _stable(board_id, "identifier", entity_id, key[1], key[2], key[3])
                drafts.append(action("identifier.add", {"id": identifier_id, "entity_id": entity_id, "scheme": ident["scheme"],
                    "namespace": ident["namespace"], "raw_value": ident["raw"], "normalized_value": key[3], "confidence": 1,
                    "source_id": source_id}, action_id=_stable(board_id, "identifier-action", identifier_id), author="Import"))
                identifiers_added += 1
            role = part["role"]
            if not any(p["entity_id"] == entity_id and p["role"] == role for p in participants):
                participants.append({"entity_id": entity_id, "role": role})
                labels.append(f"{role} {name}")
        operation = operation_of(mapping, row)
        if len({p["entity_id"] for p in participants}) < 2 or not operation:
            skipped += 1
            continue
        key = "|".join(sorted(f"{p['role']}:{p['entity_id']}" for p in participants))
        activity_id = _stable(board_id, "activity", operation.casefold(), key)
        if activity_id not in activities:
            activities.add(activity_id)
            if activity_id not in (existing_facts or set()):
                drafts.append(action("fact.add", {"id": activity_id, "predicate": operation, "participants": participants,
                    "valid_from": None, "valid_to": None, "created_at": now},
                    action_id=_stable(board_id, "activity-action", activity_id), author="Import"))
        row_text = json.dumps(row, sort_keys=True, ensure_ascii=False, default=str)
        assertion_id = _stable(board_id, "assertion", source_id, activity_id, row_text)
        start, end = time_of(mapping, row)
        if start:
            times.append(start)
        drafts.append(action("assertion.add", {"id": assertion_id, "fact_id": activity_id, "stance": "supports", "confidence": 1,
            "source_id": source_id, "note": row_text, "observation": f"{operation}: {', '.join(labels)}",
            "locator": locator_of(mapping, row, row_number), "created_at": now, "valid_from": start, "valid_to": end},
            action_id=_stable(board_id, "assertion-action", assertion_id), author="Import"))
        evidence += 1
    return drafts, {"rows": len(rows), "skipped": skipped, "entities": len(touched), "new_entities": len(created),
                    "relations": len(activities), "evidence": evidence, "identifiers": identifiers_added, "source_id": source_id,
                    "table": mapping.table, "product": mapping.product,
                    "first_seen": min(times) if times else None, "last_seen": max(times) if times else None}
