"""Which columns join Defender XDR and Sentinel tables, from the relationship catalog of xdrinternals.com.

app/data/column_relations.json (built by scripts/build_column_relations.py; MIT License, Copyright (c) 2025 Fabian &
Nathan) lists for token and session IDs, users, devices, apps, resources … the column pairs that refer to the same
thing, with the guidance and KQL for the join. An agent or analyst looking at an evidence row asks: with this column,
where else can I look?
"""
from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path

CATALOG = Path(__file__).parent / "data" / "column_relations.json"


@lru_cache(maxsize=1)
def catalog() -> dict:
    try:
        return json.loads(CATALOG.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {"families": {}, "relations": []}


def end_matches(end: dict, table: str, column: str) -> bool:
    """A column matches by name, by its JSON path (AppAccessContext.UniqueTokenId) or by the path's last part."""
    if table and end["table"].lower() != table.lower():
        return False
    if not column:
        return True
    column = column.lower()
    path = end.get("path", "").lower()
    return column in (end["column"].lower(), path, path.rsplit(".", 1)[-1]) or (path and column == f"{end['column']}.{path}".lower())


def find_joins(table: str = "", column: str = "", family: str = "", limit: int = 20) -> dict:
    """Relations with one end at table/column, seen from that end: `here` is the given column, `there` where to look next.
    Without any filter: the kinds of keys (families) and how many relations each has."""
    data = catalog()
    meta = {"source": data.get("source"), "license": data.get("license")}
    if not (table or column or family):
        counts: dict[str, int] = {}
        for relation in data["relations"]:
            counts[relation["family"]] = counts.get(relation["family"], 0) + 1
        return {**meta, "families": [{"family": key, "label": label, "relations": counts.get(key, 0)}
                                     for key, label in sorted(data["families"].items(), key=lambda item: -counts.get(item[0], 0))]}
    items = []
    for relation in data["relations"]:
        if family and relation["family"] != family:
            continue
        for here, there in (("from", "to"), ("to", "from")):
            if (table or column) and not end_matches(relation[here], table, column):
                continue
            items.append({"id": relation["id"], "title": relation["title"], "family": relation["family"],
                          "key": data["families"].get(relation["family"], relation["family"]),
                          "here": relation[here], "there": relation[there], "guidance": relation["guidance"],
                          **({"kql": relation["kql"]} if relation.get("kql") else {}),
                          **({"sources": relation["sources"]} if relation.get("sources") else {})})
            break
    return {**meta, "total": len(items), "items": items[:limit]}
