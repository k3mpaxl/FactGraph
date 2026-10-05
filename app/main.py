"""Static FactGraph app and ephemeral WebSocket relay.

The server never stores board content. Browsers exchange their operation logs
when a peer joins and keep their own durable copy in IndexedDB.
"""

from __future__ import annotations

import asyncio
import csv
import contextvars
import json
import os
import secrets
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlsplit
from uuid import UUID

from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastmcp import FastMCP
from pydantic import BaseModel, Field, ConfigDict
from typing import Literal

from app.contracts import (StrictModel, EntityInput, RelationInput, SourceInput, EvidenceInput, ActionInput, ActionBatch, RowsInput, EntityUpdate, EntityMergeInput, SourceUpdate, RelationUpdate, EvidenceUpdate)

from app.ingest import OBJECT_FIELDS, SUBJECT_FIELDS, action, entity_actions, identifier_key, parse_rows, relation_actions, rows_to_actions, table_rows_to_actions
from app.tables import clean_rows, detect


WEB_DIR = Path(__file__).resolve().parents[1] / "web" / "dist"
MCP_INSTRUCTIONS = """FactGraph is an evidence-first investigation graph that analysts and agents build together.

Connection: every tool needs board_id and the board open in a browser (data lives in the browser; the server only relays). Pass the board's session token as session_token or header X-FactGraph-Token. HTTP 409 "offline" means nobody has the board open: ask the analyst to open it. There is no board listing; the analyst gives you board ID and token (board menu → API/MCP).

Workflow
1. Read first: find_entities (q = name or identifier) or get_graph, and reuse existing IDs. Never create a second entity for the same object; merge_entities fixes duplicates.
2. Entities are concrete objects with a clear kind: IP, User, Service Principal, Device, Process, File, Repository, Key Vault, AKS Cluster, S3 Bucket, Threat Actor …
3. Two participants → create_relation (subject → specific verb → object, e.g. "reads", "has role on").
   One observed event with three or more participants → create_activity with operation and participant roles:
   actor (who acts), identity (account or service principal used), source (origin such as IP or device), tool (process/tool), via (intermediate system), target (what was acted on), other.
   Example: attacker used IP a.a.a.a and service principal B and listed Key Vault C → operation "listed secrets", actor=attacker, source=IP, identity=SP B, target=Key Vault C.
   Attribution ("this IP belongs to the attacker") is its own relationship with its own evidence.
4. Evidence: create_source for the origin (source_kind=primary for logs, telemetry, repository files; original rows in excerpt, query text in query), then add_evidence on the relationship or activity (observation = what the record shows, locator = event ID/CorrelationId/row, valid_from/valid_to = when it happened, stance supports|refutes). A query without results proves nothing; secondary sources are context only.
5. Review: new evidence starts unconfirmed; a relationship is "unknown" until confirmed evidence exists, "disputed" when confirmed evidence points both ways. You may confirm with review_evidence only after checking the original record yourself: primary source with uri and excerpt, a concrete locator and observation, and a review_note stating what you compared. Keep contradicting evidence (stance refutes) instead of overwriting; retract_evidence instead of deleting.
6. Bulk: import_rows for two-column rows, import_activities for rows with several participant columns; always dry_run first. Imports are idempotent.
7. Large graphs: create_group bundles many similar entities into one collapsed node (members, or rule by kinds/name match, or a container's contents); excluded keeps anomalies visible on their own. Groups only change the view.
8. Layers (identity, network, endpoint, workload = Kubernetes/containers, cloud = control plane/Key Vaults, data = buckets/blobs/databases, code = repositories/CI, other) are inferred from the kind; set layer only to correct it.
9. export_image renders the graph as SVG (text) or PNG (base64) for reports.

Editing: update tools change only the fields you pass; explicit null clears nullable fields. Pass expected_revision for sources and evidence; HTTP 409 means someone changed it — re-read and retry. undo reverts your session's last change batch. Content changes reset affected reviews.
Tool profile: this server shows a compact agent tool set by default; with FACTGRAPH_MCP_TOOLS=full it exposes one rest_<operation> tool per REST endpoint instead.
"""
mcp = FastMCP("FactGraph Browser Boards", version="0.5.1", instructions=MCP_INSTRUCTIONS)
mcp_app = mcp.http_app(path="/")
app = FastAPI(title="FactGraph API", version="0.5.1", lifespan=mcp_app.lifespan)


@dataclass
class Peer:
    websocket: WebSocket
    name: str
    session_token: str | None = None


# Presence only. No board data or action history is retained on the server.
rooms: dict[str, dict[str, Peer]] = {}
rooms_lock = asyncio.Lock()
pending: dict[str, tuple[WebSocket, asyncio.Future[dict]]] = {}
# Large browser replies arrive in parts of about 1 MB; 512 parts cap one reply at roughly 0.5 GB of text.
result_parts: dict[str, list[str]] = {}
MAX_RESULT_PARTS = 512
request_token: contextvars.ContextVar[str | None] = contextvars.ContextVar("factgraph_request_token", default=None)
request_channel: contextvars.ContextVar[str] = contextvars.ContextVar("factgraph_request_channel", default="REST")
# A batch ID chosen by the client (file import from the board UI), so the browser recognises its own import exactly.
request_batch: contextvars.ContextVar[str | None] = contextvars.ContextVar("factgraph_request_batch", default=None)


def token_matches(expected: str | None, given: str) -> bool:
    return bool(expected) and secrets.compare_digest(expected.encode(), given.encode())


# The board UUID in the URL is the access key: never leak it via Referer, framing or third-party content.
# Swagger UI (/docs) loads its assets from a CDN and keeps FastAPI's defaults.
CSP = ("default-src 'self'; script-src 'self' 'sha256-{theme}'; style-src 'self' 'unsafe-inline'; "
       "img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; worker-src 'self' blob:; "
       "object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'")
SECURITY_HEADERS = {
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
}


def inline_script_hash() -> str:
    """CSP hash of the small theme script in index.html, so scripts need no 'unsafe-inline'."""
    import base64
    import hashlib
    import re
    try:
        html = (WEB_DIR / "index.html").read_text(encoding="utf-8")
    except OSError:
        return ""
    match = re.search(r"<script>(.*?)</script>", html, re.S)
    return base64.b64encode(hashlib.sha256(match.group(1).encode()).digest()).decode() if match else ""


CONTENT_SECURITY_POLICY = CSP.format(theme=inline_script_hash())


async def security_headers(request: Request, call_next):
    response = await call_next(request)
    for name, value in SECURITY_HEADERS.items():
        response.headers.setdefault(name, value)
    path = request.url.path
    if not (path.startswith("/docs") or path.startswith("/redoc")):
        response.headers.setdefault("Content-Security-Policy", CONTENT_SECURITY_POLICY)
    if path.startswith("/api/") or path.startswith("/mcp"):
        response.headers.setdefault("Cache-Control", "no-store")
    # Behind a TLS-terminating proxy (Azure App Service, Caddy, nginx) the original scheme arrives here.
    if request.headers.get("x-forwarded-proto", request.url.scheme).split(",")[0].strip() == "https":
        response.headers.setdefault("Strict-Transport-Security", "max-age=31536000")
    return response


@app.middleware("http")
async def require_board_token(request: Request, call_next):
    """Bind every REST board request to a token from an open browser session."""
    path = request.url.path
    if path.startswith("/api/boards/"):
        board_id = path.removeprefix("/api/boards/").split("/", 1)[0]
        # Header only: tokens in URLs end up in proxy and platform access logs.
        token = request.headers.get("X-FactGraph-Token")
        if not token:
            return JSONResponse({"detail": "X-FactGraph-Token is required"}, status_code=401)
        if not valid_uuid(board_id):
            return await call_next(request)
        async with rooms_lock:
            authorized = any(token_matches(peer.session_token, token) for peer in rooms.get(str(UUID(board_id)), {}).values())
        if not authorized:
            return JSONResponse({"detail": "Token is not connected to this open board"}, status_code=403)
        token_context = request_token.set(token)
        channel_context = request_channel.set("REST")
        try:
            return await call_next(request)
        finally:
            request_token.reset(token_context)
            request_channel.reset(channel_context)
    if path.startswith("/mcp") and (token := request.headers.get("X-FactGraph-Token")):
        token_context = request_token.set(token)
        channel_context = request_channel.set("MCP")
        try:
            return await call_next(request)
        finally:
            request_token.reset(token_context)
            request_channel.reset(channel_context)
    return await call_next(request)


app.middleware("http")(security_headers)


def allowed_origin(websocket: WebSocket) -> bool:
    """Browsers always send Origin; only pages served by this host may join the relay (no cross-site WebSocket hijacking).
    Clients without Origin (scripts, tests) still need the board UUID. FACTGRAPH_ALLOWED_ORIGINS adds origins, e.g. a dev server."""
    origin = websocket.headers.get("origin")
    if not origin:
        return True
    hosts = {websocket.headers.get("host", "")}
    hosts.update(h.strip() for h in websocket.headers.get("x-forwarded-host", "").split(",") if h.strip())
    extra = {o.strip().rstrip("/") for o in os.environ.get("FACTGRAPH_ALLOWED_ORIGINS", "").split(",") if o.strip()}
    return urlsplit(origin).netloc in hosts or origin.rstrip("/") in extra


def valid_uuid(value: str) -> bool:
    try:
        return str(UUID(value)) == value.lower()
    except (ValueError, AttributeError):
        return False


async def send_to_room(board_id: str, message: dict, *, exclude: str | None = None,
                       target: str | None = None) -> None:
    async with rooms_lock:
        recipients = [peer.websocket for actor, peer in rooms.get(board_id, {}).items()
                      if actor != exclude and (target is None or actor == target)]
    for websocket in recipients:
        try:
            await websocket.send_json(message)
        except (RuntimeError, WebSocketDisconnect):
            pass


async def browser_command(board_id: str, operation: str, **values) -> dict:
    """Ask a connected browser to read or durably apply work, then await its ACK."""
    from uuid import uuid4

    if not valid_uuid(board_id):
        raise HTTPException(422, "Invalid board UUID")
    board_id = str(UUID(board_id))
    session_token = values.pop("session_token", None) or request_token.get()
    request_id = str(uuid4())
    loop = asyncio.get_running_loop()
    async with rooms_lock:
        room = rooms.get(board_id, {})
        if not room:
            raise HTTPException(409, "Board offline: open the board URL in a browser first")
        if session_token:
            matching = [(actor, peer) for actor, peer in room.items() if token_matches(peer.session_token, session_token)]
            if not matching:
                raise HTTPException(403, "Token is not connected to this open board")
            actor, peer = matching[0]
        else:
            raise HTTPException(401, "Session token is required")
        future: asyncio.Future[dict] = loop.create_future()
        pending[request_id] = (peer.websocket, future)
    try:
        await peer.websocket.send_json({"type": "api-command", "requestId": request_id,
                                        "boardId": board_id, "operation": operation, **values})
        result = await asyncio.wait_for(future, timeout=30)
        if not result.get("ok"):
            error = str(result.get("error") or "Browser rejected the command")
            raise HTTPException(409 if 'changed.' in error or 'revision' in error else 422, error)
        return result
    except asyncio.TimeoutError as error:
        raise HTTPException(504, "The browser did not confirm the request") from error
    except (RuntimeError, WebSocketDisconnect) as error:
        raise HTTPException(503, "Browser connection lost") from error
    finally:
        pending.pop(request_id, None)
        result_parts.pop(request_id, None)


async def apply_drafts(board_id: str, drafts: list[dict]) -> int:
    if len(drafts) > 200_000:
        raise HTTPException(413, "Zu viele Aktionen in einem Auftrag")
    from uuid import uuid4
    batch_id = request_batch.get() or str(uuid4())
    channel = request_channel.get()
    drafts = [{**draft, "batch_id": batch_id, "channel": channel, "author": channel if draft.get("author") in (None, "API") else draft["author"]}
              for draft in drafts]
    accepted = 0
    for offset in range(0, len(drafts), 200):
        chunk_number = offset // 200 + 1
        defer_render = offset + 200 < len(drafts) and chunk_number % 25 != 0
        try:
            response = await browser_command(board_id, "apply", drafts=drafts[offset:offset + 200],
                                             deferRender=defer_render)
        except HTTPException as error:
            if offset:
                raise HTTPException(error.status_code, {
                    "message": error.detail, "accepted_actions": accepted,
                    "acknowledged_drafts": offset, "batch_id": batch_id,
                    "retry": "Retry the same import or action IDs; already stored operations are deduplicated. The last chunk may have been saved before the connection failed.",
                }) from error
            raise
        accepted += int(response.get("accepted", 0))
    return accepted


async def import_table(board_id: str, rows: list[dict], *, title: str = "", query: str = "", dry_run: bool = False, filename: str = "") -> dict:
    """A Defender XDR / Sentinel export: detect the table, map its columns, import. Unsure detection → 422 with a suggestion."""
    if not valid_uuid(board_id):
        raise HTTPException(422, "Invalid board UUID")
    if not rows:
        raise HTTPException(422, "The file contains no result rows")
    columns = set().union(*(row.keys() for row in rows))
    detection = detect(columns)
    if (not detection.confident or not detection.mapping) and any(c in columns for c in SUBJECT_FIELDS) and any(c in columns for c in OBJECT_FIELDS):
        # Not an XDR/Sentinel table, but the classic two-column log (IPAddress → FilePath): import it as before.
        summary = await import_rows(board_id, RowsInput(rows=rows, title=title or (filename or "Activity logs"), query=query, dry_run=dry_run))
        return {**summary, "table": "Log rows", "product": f"{summary['subject_field']} → {summary['object_field']}",
                "detection": {**detection.summary(), "table": "Log rows", "confident": True}}
    if not detection.confident or not detection.mapping:
        mapping = detection.mapping
        raise HTTPException(422, {
            "message": f"Could not recognise the table of {filename or 'this file'}. Check the column mapping.",
            "needs_mapping": True, "detection": detection.summary(),
            "suggestion": {"roles": [{"field": p.fields[0], "role": p.role, "kind": p.kind} for p in (mapping.parts if mapping else ())],
                           "operation_field": next((c for c in ("ActionType", "OperationName", "Operation", "Activity", "EventType") if c in columns), None)}})
    if not title or title in ("Activity logs", "Access Logs"):
        title = f"{detection.table} ({detection.product})" if detection.product else detection.table
    if filename and filename not in title:
        title = f"{title} · {filename}"
    index = (await browser_command(board_id, "index"))["index"]
    entities = {(item["kind"].casefold(), item["name"].casefold()): item["id"] for item in index["entities"]}
    by_identifier, owned = {}, set()
    for item in index["entities"]:
        for ident in item.get("identifiers", []):
            key = identifier_key(item["kind"], ident["scheme"], ident.get("namespace") or "", ident["normalized_value"])
            by_identifier.setdefault(key, item["id"])
            owned.add((item["id"], *key[1:]))
    try:
        drafts, summary = table_rows_to_actions(board_id, rows, detection.mapping, title=title, query=query,
            existing_entities=entities, existing_identifiers=by_identifier, known_identifiers=owned,
            existing_facts={item["id"] for item in index["facts"]}, existing_sources={item["id"] for item in index["sources"]})
    except (ValueError, KeyError) as error:
        raise HTTPException(422, str(error)) from error
    summary["detection"] = detection.summary()
    summary["title"] = title
    if dry_run:
        return {**summary, "dry_run": True, "action_count": len(drafts)}
    summary["accepted_actions"] = await apply_drafts(board_id, drafts)
    return summary


async def import_rows(board_id: str, data: RowsInput) -> dict:
    if not valid_uuid(board_id):
        raise HTTPException(422, "Invalid board UUID")
    index = (await browser_command(board_id, "index"))["index"]
    entity_index = {(item["kind"].casefold(), item["name"].casefold()): item["id"]
                    for item in index["entities"]}
    fact_index = {(item["subject_id"], item["predicate"].casefold(), item["object_id"]): item["id"]
                  for item in index["facts"] if item.get("valid_from") is None and item.get("valid_to") is None and not item.get("activity")}
    try:
        drafts, summary = rows_to_actions(board_id, data.rows, title=data.title,
            query=data.query, subject_field=data.subject_field,
            object_field=data.object_field, predicate=data.predicate,
            predicate_field=data.predicate_field,
            subject_kind=data.subject_kind, object_kind=data.object_kind,
            existing_entities=entity_index, existing_facts=fact_index,
            existing_sources={item["id"] for item in index["sources"]})
    except (ValueError, KeyError) as error:
        raise HTTPException(422, str(error)) from error
    if data.dry_run:
        return {**summary, "dry_run": True, "preview": drafts[:20], "action_count": len(drafts)}
    summary["accepted_actions"] = await apply_drafts(board_id, drafts)
    return summary


@app.get("/api/health")
def health():
    return {"ok": True, "version": app.version, "storage": "browser", "relay": "memory"}


@app.get("/api/boards/{board_id}/status")
async def board_status(board_id: str):
    if not valid_uuid(board_id):
        raise HTTPException(422, "Invalid board UUID")
    async with rooms_lock:
        peers = len(rooms.get(str(UUID(board_id)), {}))
    return {"board_id": board_id, "online_browsers": peers,
            "durable_storage": "browser-indexeddb"}


@app.get("/api/boards/{board_id}/graph")
async def get_graph(board_id: str):
    return (await browser_command(board_id, "snapshot"))["graph"]


@app.get("/api/boards/{board_id}/impact")
async def get_impact(board_id: str):
    """Attack impact of entities marked compromised: attacker steps, impacted resources, new pivots, what to rotate, KQL to hunt."""
    return (await browser_command(board_id, "impact"))["impact"]


@app.post("/api/boards/{board_id}/entities", status_code=201)
async def create_entity(board_id: str, body: EntityInput):
    try:
        entity_id, drafts = entity_actions(body.name, body.kind, body.description, body.id)
    except ValueError as error:
        raise HTTPException(422, str(error)) from error
    drafts[0]["payload"]["pinned"] = body.pinned
    if body.layer:
        drafts[0]["payload"]["layer"] = body.layer
    if body.color:
        drafts[0]["payload"]["color"] = body.color
    if body.x is not None or body.y is not None:
        if body.x is None or body.y is None:
            raise HTTPException(422, "Both x and y are required")
        drafts[0]["payload"].update(x=body.x, y=body.y)
    accepted = await apply_drafts(board_id, drafts)
    return {"board_id": str(UUID(board_id)), "id": entity_id, "accepted_actions": accepted}


@app.patch("/api/boards/{board_id}/entities/{entity_id}")
async def update_entity(board_id: str, entity_id: str, body: EntityUpdate):
    index = (await browser_command(board_id, "index"))["index"]
    if entity_id not in {entity["id"] for entity in index["entities"]}:
        raise HTTPException(404, "Entity does not exist on this board")
    values = body.model_dump(exclude_unset=True, by_alias=True)
    if not values:
        raise HTTPException(422, "At least one entity field is required")
    if any(not isinstance(values[key], str) or not values[key].strip() for key in ("name", "kind") if key in values):
        raise HTTPException(422, "Name and type must not be empty")
    accepted = await apply_drafts(board_id, [action("entity.update", {"id": entity_id, **values})])
    return {"board_id": str(UUID(board_id)), "id": entity_id, "accepted_actions": accepted}


@app.post("/api/boards/{board_id}/entities/{entity_id}/merge")
async def merge_entity(board_id: str, entity_id: str, body: EntityMergeInput):
    index = (await browser_command(board_id, "index"))["index"]
    entity_ids = {entity["id"] for entity in index["entities"]}
    if entity_id not in entity_ids or body.target_id not in entity_ids:
        raise HTTPException(404, "Source or target entity does not exist on this board")
    if entity_id == body.target_id:
        raise HTTPException(422, "An entity cannot be merged into itself")
    accepted = await apply_drafts(board_id, [action("entity.merge", {
        "source_id": entity_id, "target_id": body.target_id})])
    return {"board_id": str(UUID(board_id)), "source_id": entity_id,
            "target_id": body.target_id, "accepted_actions": accepted}


@app.delete("/api/boards/{board_id}/entities/{entity_id}")
async def delete_entity(board_id: str, entity_id: str):
    index = (await browser_command(board_id, "index"))["index"]
    if entity_id not in {entity["id"] for entity in index["entities"]}:
        raise HTTPException(404, "Entity does not exist on this board")
    accepted = await apply_drafts(board_id, [action("entity.delete", {"id": entity_id})])
    return {"id": entity_id, "accepted_actions": accepted}


@app.patch("/api/boards/{board_id}/sources/{source_id}")
async def update_source(board_id: str, source_id: str, body: SourceUpdate):
    index = (await browser_command(board_id, "index"))["index"]
    if source_id not in {source["id"] for source in index["sources"]}:
        raise HTTPException(404, "Source does not exist on this board")
    values = body.model_dump(exclude_unset=True)
    if not values:
        raise HTTPException(422, "At least one source field is required")
    if "title" in values and (not isinstance(values["title"], str) or not values["title"].strip()):
        raise HTTPException(422, "Source title cannot be empty")
    accepted = await apply_drafts(board_id, [action("source.update", {"id": source_id, **values})])
    return {"board_id": str(UUID(board_id)), "id": source_id, "accepted_actions": accepted}


@app.delete("/api/boards/{board_id}/sources/{source_id}")
async def delete_source(board_id: str, source_id: str):
    index = (await browser_command(board_id, "index"))["index"]
    if source_id not in {source["id"] for source in index["sources"]}:
        raise HTTPException(404, "Source does not exist on this board")
    accepted = await apply_drafts(board_id, [action("source.delete", {"id": source_id})])
    return {"id": source_id, "accepted_actions": accepted}


@app.post("/api/boards/{board_id}/relations", status_code=201)
async def create_relation(board_id: str, body: RelationInput):
    try:
        relation_id, drafts = relation_actions(body.subject_id, body.predicate,
            body.object_id, source_id=body.source_id, note=body.note,
            stance=body.stance, confidence=body.confidence,
            valid_from=body.valid_from, valid_to=body.valid_to, relation_id=body.id)
    except ValueError as error:
        raise HTTPException(422, str(error)) from error
    index = (await browser_command(board_id, "index"))["index"]
    ids = {entity["id"] for entity in index["entities"]}
    if body.subject_id not in ids or body.object_id not in ids:
        raise HTTPException(422, "Source or target entity does not exist on this board")
    if body.source_id and body.source_id not in {source["id"] for source in index["sources"]}:
        raise HTTPException(422, "Source does not exist on this board")
    existing = next((f for f in index['facts'] if not f.get('activity') and f['subject_id'] == body.subject_id and f['object_id'] == body.object_id and f['predicate'].strip().casefold() == body.predicate.strip().casefold() and f.get('valid_from') == body.valid_from and f.get('valid_to') == body.valid_to), None)
    if existing:
        relation_id = existing['id']
        drafts = [d for d in drafts if d['type'] != 'fact.add']
        for draft in drafts:
            draft['payload']['fact_id'] = relation_id
    accepted = await apply_drafts(board_id, drafts)
    return {"id": relation_id, "accepted_actions": accepted}


@app.patch("/api/boards/{board_id}/relations/{relation_id}")
async def update_relation(board_id: str, relation_id: str, body: RelationUpdate):
    index = (await browser_command(board_id, "index"))["index"]
    relation = next((fact for fact in index["facts"] if fact["id"] == relation_id), None)
    if relation is None:
        raise HTTPException(404, "Relationship does not exist on this board")
    values = body.model_dump(exclude_unset=True)
    if "predicate" in values and (not isinstance(values["predicate"], str) or not values["predicate"].strip()):
        raise HTTPException(422, "Relationship predicate cannot be empty")
    entity_ids = {entity["id"] for entity in index["entities"]}
    if any(not isinstance(values.get(field), str) or values.get(field) not in entity_ids for field in ("subject_id", "object_id") if field in values):
        raise HTTPException(422, "Source or target entity does not exist on this board")
    if not values:
        raise HTTPException(422, "At least one relationship field is required")
    accepted = await apply_drafts(board_id, [action("fact.update", {"id": relation_id, **values})])
    return {"board_id": str(UUID(board_id)), "id": relation_id, "accepted_actions": accepted}


@app.delete("/api/boards/{board_id}/relations/{relation_id}")
async def delete_relation(board_id: str, relation_id: str):
    index = (await browser_command(board_id, "index"))["index"]
    if relation_id not in {fact["id"] for fact in index["facts"]}:
        raise HTTPException(404, "Relationship does not exist on this board")
    accepted = await apply_drafts(board_id, [action("fact.delete", {"id": relation_id})])
    return {"id": relation_id, "accepted_actions": accepted}


@app.post("/api/boards/{board_id}/sources", status_code=201)
async def create_source(board_id: str, body: SourceInput):
    from uuid import uuid4
    source_id = body.id or str(uuid4())
    accepted = await apply_drafts(board_id, [action("source.add", {
        "id": source_id, "title": body.title, "uri": body.uri,
        "excerpt": body.excerpt, "source_kind": body.source_kind, "query": body.query})])
    return {"id": source_id, "accepted_actions": accepted}


@app.post("/api/boards/{board_id}/relations/{relation_id}/evidence", status_code=201)
async def create_evidence(board_id: str, relation_id: str, body: EvidenceInput):
    from uuid import uuid4
    index = (await browser_command(board_id, "index"))["index"]
    if relation_id not in {fact["id"] for fact in index["facts"]}:
        raise HTTPException(422, "Relationship does not exist on this board")
    if body.source_id and body.source_id not in {source["id"] for source in index["sources"]}:
        raise HTTPException(422, "Source does not exist on this board")
    if body.stance not in {"supports", "refutes"}:
        raise HTTPException(422, "Stance must be supports or refutes")
    evidence_id = body.id or str(uuid4())
    accepted = await apply_drafts(board_id, [action("assertion.add", {
        "id": evidence_id, "fact_id": relation_id, "stance": body.stance,
        "confidence": body.confidence, "source_id": body.source_id,
        "note": body.note, "observation": body.observation, "locator": body.locator, "interpretation": body.interpretation, "valid_from": body.valid_from, "valid_to": body.valid_to})])
    return {"id": evidence_id, "accepted_actions": accepted}


@app.patch("/api/boards/{board_id}/relations/{relation_id}/evidence/{evidence_id}")
async def update_evidence(board_id: str, relation_id: str, evidence_id: str, body: EvidenceUpdate):
    graph = (await browser_command(board_id, "snapshot"))["graph"]
    relation = next((fact for fact in graph["facts"] if fact["id"] == relation_id), None)
    if relation is None:
        raise HTTPException(404, "Relationship does not exist on this board")
    if not any(assertion["id"] == evidence_id for assertion in relation.get("assertions", [])):
        raise HTTPException(404, "Evidence does not exist on this relationship")
    values = body.model_dump(exclude_unset=True)
    if "stance" in values and values["stance"] not in {"supports", "refutes"}:
        raise HTTPException(422, "Evidence stance must be supports or refutes")
    if "source_id" in values and values["source_id"] and values["source_id"] not in {source["id"] for source in graph["sources"]}:
        raise HTTPException(422, "Source does not exist on this board")
    if not values:
        raise HTTPException(422, "At least one evidence field is required")
    accepted = await apply_drafts(board_id, [action("assertion.update", {"id": evidence_id, **values})])
    return {"board_id": str(UUID(board_id)), "relation_id": relation_id,
            "id": evidence_id, "accepted_actions": accepted}


@app.delete("/api/boards/{board_id}/relations/{relation_id}/evidence/{evidence_id}")
async def delete_evidence(board_id: str, relation_id: str, evidence_id: str):
    graph = (await browser_command(board_id, "snapshot"))["graph"]
    relation = next((fact for fact in graph["facts"] if fact["id"] == relation_id), None)
    if relation is None or not any(item["id"] == evidence_id for item in relation.get("assertions", [])):
        raise HTTPException(404, "Evidence does not exist on this relationship")
    accepted = await apply_drafts(board_id, [action("assertion.delete", {"id": evidence_id})])
    return {"relation_id": relation_id, "id": evidence_id, "accepted_actions": accepted}


@app.post("/api/boards/{board_id}/actions")
async def create_actions(board_id: str, body: ActionBatch):
    if len(body.actions) > 50_000:
        raise HTTPException(413, "At most 50,000 actions per request")
    drafts = [action(item.type, item.payload, action_id=item.id,
                     author=item.author) for item in body.actions]
    return {"accepted_actions": await apply_drafts(board_id, drafts)}


class TableRowsInput(StrictModel):
    rows: list[dict] = Field(max_length=50_000)
    title: str = Field(default="", max_length=200)
    query: str = Field(default="", max_length=20_000, description="KQL that produced the rows (provenance).")
    dry_run: bool = False


@app.post("/api/boards/{board_id}/imports/table")
async def import_table_export(board_id: str, body: TableRowsInput):
    """Import rows from Defender XDR advanced hunting or Microsoft Sentinel (DeviceNetworkEvents, SigninLogs, AuditLogs, ASIM …).

    The table is recognised from the column names; devices, accounts, IPs, files and apps become entities matched by their
    IDs (DeviceId, Entra object ID, SID, hashes, resource IDs) with what is already on the board; each row becomes one
    unconfirmed evidence item of an activity with its timestamp and a locator such as ReportId. Use dry_run first. An
    unrecognised table returns 422 with a suggested column mapping; then use import_activities with explicit roles."""
    return await import_table(board_id, clean_rows(body.rows), title=body.title, query=body.query, dry_run=body.dry_run)


@app.post("/api/boards/{board_id}/imports/kql")
async def import_kql(board_id: str, body: RowsInput):
    if not body.query.strip():
        raise HTTPException(422, "KQL text is missing")
    return await import_rows(board_id, body)


@app.post("/api/boards/{board_id}/imports/activity")
async def import_activity(board_id: str, body: RowsInput):
    return await import_rows(board_id, body)


@app.post("/api/boards/{board_id}/imports/file")
async def import_file(board_id: str, file: UploadFile = File(...),
                      title: str = Form("Activity logs"), query: str = Form(""), dry_run: bool = Form(False),
                      subject_field: str = Form(""), object_field: str = Form(""),
                      predicate: str = Form("accessed"), predicate_field: str = Form(""),
                      subject_kind: str = Form("IP"),
                      object_kind: str = Form("File"), roles: str = Form(""),
                      auto: bool = Form(False, description="Recognise Defender XDR / Sentinel exports and map their columns automatically."),
                      batch_id: str = Form("", description="Optional UUID for the change batch, so the uploading browser recognises its own import.")):
    # File uploads are imports: the change log and the notifications show them as such, not as agent writes.
    channel_context = request_channel.set("Import")
    batch_context = request_batch.set(str(UUID(batch_id)) if batch_id and valid_uuid(batch_id) else None)
    try:
        return await _import_file(board_id, file, title, query, dry_run, subject_field, object_field, predicate, predicate_field,
                                  subject_kind, object_kind, roles, auto)
    finally:
        request_channel.reset(channel_context)
        request_batch.reset(batch_context)


async def _import_file(board_id, file, title, query, dry_run, subject_field, object_field, predicate, predicate_field,
                       subject_kind, object_kind, roles, auto=False):
    content = await file.read(20_000_001)
    if len(content) > 20_000_000:
        raise HTTPException(413, "File is larger than 20 MB")
    try:
        rows = clean_rows(parse_rows(content, file.filename or ""))
    except (UnicodeError, ValueError, csv.Error) as error:
        raise HTTPException(422, str(error)) from error
    if auto:
        return await import_table(board_id, rows, title=title, query=query, dry_run=dry_run, filename=file.filename or "")
    if roles.strip():
        from app.structures import ActivityRowsInput
        from pydantic import ValidationError
        import json
        try:
            body = ActivityRowsInput(rows=rows, title=title, query=query, dry_run=dry_run, roles=json.loads(roles),
                                     operation=predicate or "performed", operation_field=predicate_field or None)
        except (ValueError, ValidationError) as error:
            raise HTTPException(422, str(error)) from error
        return await import_activity_rows(board_id, body)
    return await import_rows(board_id, RowsInput(rows=rows, title=title, query=query, dry_run=dry_run,
        subject_field=subject_field or None, object_field=object_field or None,
        predicate=predicate, predicate_field=predicate_field or None,
        subject_kind=subject_kind, object_kind=object_kind))


async def import_activity_rows(board_id: str, body):
    return await globals()["import_activity_rows_impl"](board_id, body)


async def run_mcp_session(session_token: str | None, operation):
    effective_token = session_token or request_token.get()
    if not effective_token:
        raise HTTPException(401, "MCP requires X-FactGraph-Token or session_token")
    token_context = request_token.set(effective_token)
    channel_context = request_channel.set("MCP")
    try:
        return await operation()
    finally:
        request_token.reset(token_context)
        request_channel.reset(channel_context)


@app.websocket("/ws/boards/{board_id}")
async def board_socket(websocket: WebSocket, board_id: str):
    if not valid_uuid(board_id) or not allowed_origin(websocket):
        await websocket.close(code=1008)
        return
    await websocket.accept()
    # Identity and token arrive in the first message, never in the URL, so they stay out of access logs.
    try:
        hello = json.loads(await asyncio.wait_for(websocket.receive_text(), timeout=10))
    except (asyncio.TimeoutError, ValueError, WebSocketDisconnect, RuntimeError):
        await websocket.close(code=1008)
        return
    actor = str(hello.get("actor", "")) if isinstance(hello, dict) and hello.get("type") == "hello" else ""
    if not valid_uuid(actor):
        await websocket.close(code=1008)
        return
    name = str(hello.get("name", "Guest")).strip()[:40] or "Guest"
    session_token = str(hello.get("token", "")).strip()[:200] or None

    board_id = str(UUID(board_id))
    async with rooms_lock:
        room = rooms.setdefault(board_id, {})
        previous = room.get(actor)
        peers = [{"id": peer_id, "name": peer.name} for peer_id, peer in room.items()
                 if peer_id != actor]
        room[actor] = Peer(websocket=websocket, name=name, session_token=session_token)
    if previous:
        try:
            await previous.websocket.close(code=1000)
        except RuntimeError:
            pass
    await websocket.send_json({"type": "welcome", "peers": peers})
    await send_to_room(board_id, {"type": "peer-joined", "peer": {"id": actor, "name": name}}, exclude=actor)

    try:
        while True:
            message = await websocket.receive_json()
            if not isinstance(message, dict):
                continue
            kind = message.get("type")
            if kind == "actions":
                actions = message.get("actions")
                if isinstance(actions, list) and len(actions) <= 1000:
                    target = message.get("target")
                    await send_to_room(board_id, {"type": "actions", "from": actor, "actions": actions, "deferRender": message.get("deferRender") is True},
                                       exclude=actor, target=target if isinstance(target, str) else None)
            elif kind == "sync-request":
                await send_to_room(board_id, {"type": "sync-request", "from": actor}, exclude=actor)
            elif kind == "profile":
                updated = str(message.get("name", "")).strip()[:40]
                if updated:
                    async with rooms_lock:
                        if rooms.get(board_id, {}).get(actor, None) is not None:
                            rooms[board_id][actor].name = updated
                    await send_to_room(board_id, {"type": "peer-profile", "peer": {"id": actor, "name": updated}}, exclude=actor)
            elif kind == "api-result" and isinstance(message.get("requestId"), str):
                entry = pending.get(message["requestId"])
                if entry and entry[0] is websocket and not entry[1].done():
                    entry[1].set_result(message)
            elif kind == "api-result-part" and isinstance(message.get("requestId"), str):
                # Large replies arrive in parts (each far below the WebSocket message limit) and are joined here.
                request_id = message["requestId"]
                entry = pending.get(request_id)
                index, total, data = message.get("index"), message.get("total"), message.get("data")
                if not entry or entry[0] is not websocket or entry[1].done() or not isinstance(data, str) or \
                        not isinstance(index, int) or not isinstance(total, int) or not 0 <= index < total <= MAX_RESULT_PARTS:
                    continue
                buffer = result_parts.setdefault(request_id, [])
                if index != len(buffer):
                    result_parts.pop(request_id, None)
                    entry[1].set_result({"ok": False, "error": "Reply parts arrived out of order"})
                    continue
                buffer.append(data)
                if len(buffer) == total:
                    joined = "".join(result_parts.pop(request_id))
                    try:
                        result = json.loads(joined)
                    except ValueError:
                        result = {"ok": False, "error": "Malformed reply"}
                    entry[1].set_result(result if isinstance(result, dict) else {"ok": False, "error": "Malformed reply"})
    except (WebSocketDisconnect, RuntimeError):
        pass
    finally:
        async with rooms_lock:
            room = rooms.get(board_id)
            if room and room.get(actor, None) and room[actor].websocket is websocket:
                del room[actor]
                if not room:
                    del rooms[board_id]
                removed = True
            else:
                removed = False
        if removed:
            for request_id, (writer, future) in list(pending.items()):
                if writer is websocket and not future.done():
                    future.set_result({"ok": False, "error": "Browser connection lost"})
            await send_to_room(board_id, {"type": "peer-left", "id": actor})


from app.extensions import register_extensions
register_extensions(app, mcp, globals())

app.mount("/mcp", mcp_app)

if WEB_DIR.is_dir():
    app.mount("/assets", StaticFiles(directory=WEB_DIR / "assets"), name="assets")

    @app.get("/{path:path}", include_in_schema=False)
    def spa(path: str):
        requested = (WEB_DIR / path).resolve()
        if requested.is_file() and requested.is_relative_to(WEB_DIR.resolve()):
            return FileResponse(requested)
        if path == "api" or path.startswith("api/"):
            raise HTTPException(404, "Unknown API endpoint; see /docs")
        return FileResponse(WEB_DIR / "index.html")


def set_mcp_tool_profile(profile: str) -> str:
    """Switch the visible MCP tools at runtime (tests, embedding); FACTGRAPH_MCP_TOOLS sets the default."""
    from app.tool_profiles import set_tool_profile
    names = globals()["MCP_TOOL_NAMES"]
    return set_tool_profile(mcp, profile, names["agent"], names["full"])
