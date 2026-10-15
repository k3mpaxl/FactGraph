"""Build app/data/column_relations.json from the relationship catalog of https://xdrinternals.com/relationships/.

Usage:
    python scripts/build_column_relations.py                      # download https://xdrinternals.com/data/column-relations.json
    python scripts/build_column_relations.py column-relations.json   # or a saved copy

The catalog (MIT License, Copyright (c) 2025 Fabian & Nathan, https://github.com/MSCloudInternals/XDRInternals) says
which columns join Defender XDR and Sentinel tables: token and session IDs, user, device, app and resource IDs. Kept
per relation: both ends (table, column, JSON path, time column), the kind of key (family), the join guidance, the KQL and
the links to the write-ups it rests on. The longer notes stay on the site.
"""
from __future__ import annotations

import json
import sys
import urllib.request
from datetime import date
from pathlib import Path

SOURCE = "https://xdrinternals.com/data/column-relations.json"
LICENSE = "MIT License, Copyright (c) 2025 Fabian & Nathan (https://github.com/MSCloudInternals/XDRInternals)"
SIDE = ("table", "column", "path", "timeColumn")


def load(location: str) -> dict:
    if location.startswith("https://"):
        with urllib.request.urlopen(location, timeout=60) as response:
            return json.load(response)
    return json.loads(Path(location).read_text(encoding="utf-8"))


def main(location: str) -> None:
    catalog = load(location)
    relations = []
    for item in catalog["relations"]:
        relation = {"id": item["id"], "title": item["title"], "family": item["family"],
                    "from": {k: item["from"][k] for k in SIDE if item["from"].get(k)},
                    "to": {k: item["to"][k] for k in SIDE if item["to"].get(k)},
                    "guidance": item["guidance"]}
        if item.get("kql"):
            relation["kql"] = item["kql"]
        sources = sorted({note["sourceUrl"] for note in item.get("otherNotes", []) if note.get("sourceUrl")})
        if sources:
            relation["sources"] = sources
        relations.append(relation)
    out = {"generated": date.today().isoformat(), "source": "https://xdrinternals.com/relationships/", "license": LICENSE,
           "families": {f["id"]: f["label"] for f in catalog["families"]},
           "relations": sorted(relations, key=lambda r: (r["family"], r["id"]))}
    target = Path(__file__).resolve().parents[1] / "app" / "data" / "column_relations.json"
    target.write_text(json.dumps(out, indent=1, sort_keys=True, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"{len(relations)} relations in {len(out['families'])} families → {target}")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else SOURCE)
