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
        raise ValueError("Der Entitätsname darf nicht leer sein")
    entity_id = entity_id or str(uuid4())
    return entity_id, [action("entity.add", {"id": entity_id, "name": name,
        "kind": kind.strip() or "Sonstiges", "description": description.strip()})]


def relation_actions(subject_id: str, predicate: str, object_id: str,
                     *, source_id: str | None = None, note: str = "",
                     stance: str = "supports", confidence: float = 1,
                     valid_from: str | None = None, valid_to: str | None = None, relation_id: str | None = None) -> tuple[str, list[dict]]:
    if not subject_id or not object_id or subject_id == object_id:
        raise ValueError("Die Beziehung braucht zwei verschiedene Entitäts-IDs")
    if not predicate.strip():
        raise ValueError("Die Beziehung braucht einen Bezeichner")
    if stance not in {"supports", "refutes"} or not 0 <= confidence <= 1:
        raise ValueError("Ungültige Aussage oder Konfidenz")
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
TIME_FIELDS = ("TimeGenerated", "timestamp", "Timestamp", "time", "event_time")


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
        raise ValueError("Erwartet wurde CSV, JSON-Array oder JSONL mit Objekt-Zeilen")
    return rows


def _field(rows: list[dict], explicit: str | None, candidates: tuple[str, ...], label: str) -> str:
    keys = set().union(*(row.keys() for row in rows)) if rows else set()
    if explicit:
        if explicit not in keys:
            raise ValueError(f"Spalte {explicit!r} fehlt. Vorhanden: {', '.join(sorted(keys))}")
        return explicit
    for candidate in candidates:
        if candidate in keys:
            return candidate
    raise ValueError(f"Keine {label}-Spalte erkannt. Vorhanden: {', '.join(sorted(keys))}")


def _stable(board_id: str, *parts: str) -> str:
    return str(uuid5(UUID(board_id), "\x1f".join(parts)))


def rows_to_actions(board_id: str, rows: list[dict], *, title: str,
                    query: str = "", subject_field: str | None = None,
                    object_field: str | None = None, predicate: str = "accessed",
                    predicate_field: str | None = None,
                    subject_kind: str = "IP", object_kind: str = "Datei",
                    existing_entities: dict[tuple[str, str], str] | None = None,
                    existing_facts: dict[tuple[str, str, str], str] | None = None,
                    existing_sources: set[str] | None = None) -> tuple[list[dict], dict]:
    if not rows:
        raise ValueError("Die Datei enthält keine Ergebniszeilen")
    if len(rows) > 50_000:
        raise ValueError("Maximal 50.000 Zeilen pro Import")
    subject_field = _field(rows, subject_field, SUBJECT_FIELDS, "Quell")
    object_field = _field(rows, object_field, OBJECT_FIELDS, "Ziel")
    if predicate_field:
        predicate_field = _field(rows, predicate_field, (), "Beziehungs")
    predicate = predicate.strip()
    if not predicate:
        raise ValueError("Der Kantenbezeichner darf nicht leer sein")

    canonical_rows = json.dumps(rows, sort_keys=True, ensure_ascii=False, default=str)
    digest = hashlib.sha256((title + "\n" + query + "\n" + canonical_rows).encode()).hexdigest()
    source_id = _stable(board_id, "import", digest)
    now = datetime.now(timezone.utc).isoformat()
    drafts = []
    if source_id not in (existing_sources or set()):
        drafts.append(action("source.add", {"id": source_id, "title": title,
            "uri": f"import://{digest[:16]}", "excerpt": query or f"Importierte Ergebniszeilen: {len(rows)}",
            "created_at": now}, action_id=_stable(board_id, "source-action", source_id), author="Import"))
    seen_entities: set[str] = set()
    seen_facts: set[str] = set()
    assertions = 0
    skipped = 0
    for row in rows:
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
        timestamp = next((str(row[key]) for key in ("valid_from", "StartTime", *TIME_FIELDS) if row.get(key)), None)
        end = next((str(row[key]) for key in ("valid_to", "EndTime") if row.get(key)), None)
        drafts.append(action("assertion.add", {"id": assertion_id, "fact_id": fact_id,
            "stance": "supports", "confidence": 1, "source_id": source_id,
            "note": row_text, "created_at": now, "valid_from": timestamp, "valid_to": end},
            action_id=_stable(board_id, "assertion-action", assertion_id), author="Import"))
        assertions += 1
    return drafts, {"rows": len(rows), "skipped": skipped, "entities": len(seen_entities),
                    "relations": len(seen_facts), "evidence": assertions,
                    "source_id": source_id, "subject_field": subject_field,
                    "object_field": object_field}
