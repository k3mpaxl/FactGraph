"""Build app/data/table_schemas.json from a clone of https://github.com/merill/defender-docs-mirror.

Usage:
    git clone --depth 1 https://github.com/merill/defender-docs-mirror.git /tmp/ddm
    python scripts/build_table_schemas.py /tmp/ddm

Only table names, column names and data types are taken (and a link to the Microsoft Learn page); no description text.
Advanced hunting tables come from defender-xdr/advanced-hunting-*-table.md, Sentinel ASIM schemas from
sentinel/normalization-schema-*.md plus the common ASIM fields.
"""
from __future__ import annotations

import json
import re
import sys
from datetime import date
from pathlib import Path

ROW = re.compile(r"^\|\s*\**`?([A-Za-z_][A-Za-z0-9_]*)`?\**\s*\|(.*)$")


def columns(text: str, header: str) -> dict[str, str]:
    """Rows of every markdown table whose header starts with `header` (e.g. "| Column name")."""
    out: dict[str, str] = {}
    inside = False
    for line in text.splitlines():
        if line.startswith(header):
            inside = True
            continue
        if inside and not line.startswith("|"):
            inside = False
        if not inside or line.startswith("| ---"):
            continue
        match = ROW.match(line)
        if not match:
            continue
        cells = [c.strip().strip("`") for c in match.group(2).split("|")]
        # Advanced hunting: | Column | Type | Description |; ASIM: | Field | Class | Type | Description |
        kind = cells[0] if header.startswith("| Column") else (cells[1] if len(cells) > 1 else "")
        out.setdefault(match.group(1), re.sub(r"\s+", " ", kind).strip()[:40])
    return out


def main(mirror: Path) -> None:
    tables: dict[str, dict] = {}
    for path in sorted((mirror / "defender-xdr").glob("advanced-hunting-*-table.md")):
        text = path.read_text(encoding="utf-8")
        title = re.search(r"^# (\w+) table", text, re.M)
        cols = columns(text, "| Column name")
        if not title or len(cols) < 3:
            continue
        tables[title.group(1)] = {"product": "Defender XDR", "doc": f"https://learn.microsoft.com/en-us/defender-xdr/{path.stem}",
                                  "columns": cols}
    common = columns((mirror / "sentinel/normalization-common-fields.md").read_text(encoding="utf-8"), "| Field")
    asim: dict[str, dict] = {}
    for path in sorted((mirror / "sentinel").glob("normalization-schema-*.md")):
        name = path.stem.removeprefix("normalization-schema-")
        if name in ("v1",):
            continue
        cols = columns(path.read_text(encoding="utf-8"), "| Field")
        if len(cols) >= 5:
            asim[name] = {"doc": f"https://learn.microsoft.com/en-us/azure/sentinel/{path.stem}", "columns": cols}
    out = {"generated": date.today().isoformat(), "source": "https://github.com/merill/defender-docs-mirror",
           "tables": tables, "asim": asim, "asim_common": common}
    target = Path(__file__).resolve().parents[1] / "app" / "data" / "table_schemas.json"
    target.parent.mkdir(exist_ok=True)
    target.write_text(json.dumps(out, indent=1, sort_keys=True) + "\n", encoding="utf-8")
    print(f"{len(tables)} advanced hunting tables, {len(asim)} ASIM schemas, {len(common)} common fields → {target}")


if __name__ == "__main__":
    main(Path(sys.argv[1] if len(sys.argv) > 1 else "/tmp/ddm"))
