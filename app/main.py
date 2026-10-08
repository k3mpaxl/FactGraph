"""Static FactGraph app and ephemeral WebSocket relay.

The server never stores board content. Browsers exchange their operation logs
when a peer joins and keep their own durable copy in IndexedDB.
"""

from __future__ import annotations

import asyncio
import csv
import contextvars
import json
import logging
import os
import re
import secrets
import zlib
from dataclasses import dataclass, field
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
from app.formats import ImportFormat, compile_format, inspect_rows, missing_columns, preview_rows


WEB_DIR = Path(__file__).resolve().parents[1] / "web" / "dist"
MCP_INSTRUCTIONS = """FactGraph is an evidence-first investigation graph that analysts and agents build together.

Connection: you work on one board, chosen by the analyst's board token in the X-FactGraph-Token header (set up with the plug icon in the board header → Connect an agent). Leave board_id and board_token empty: the server takes the board from the token. Never ask the analyst for a board ID or a token. The data lives in the analyst's open browser tab (the server only relays): HTTP 409 means that tab is closed; ask the analyst to open the board again. Only clients that cannot send headers pass board_token in each call. Your changes are recorded as the analyst's agent, e.g. "MCP (Gregor)".

Workflow
1. Read first: find_entities (q = name or identifier) or get_graph, and reuse existing IDs. Never create a second entity for the same object; merge_entities fixes duplicates.
2. Entities are concrete objects with a clear kind: IP, User, Service Principal, Device, Process, File, Repository, Key Vault, AKS Cluster, S3 Bucket, Threat Actor …
3. Two participants → create_relation (subject → specific verb → object, e.g. "reads", "has role on").
   One observed event with three or more participants → create_activity with operation and participant roles:
   actor (who acts), identity (account or service principal used), source (origin such as IP or device), tool (process/tool), via (intermediate system), target (what was acted on), other.
   Example: attacker used IP a.a.a.a and service principal B and listed Key Vault C → operation "listed secrets", actor=attacker, source=IP, identity=SP B, target=Key Vault C.
   Attribution ("this IP belongs to the attacker") is its own relationship with its own evidence.
4. Evidence: create_source for the origin (source_kind=primary for logs, telemetry, repository files; original rows in excerpt, query text in query), then add_evidence on the relationship or activity (observation = what the record shows, locator = event ID/CorrelationId/row, valid_from/valid_to = when it happened, stance supports|refutes). A query without results proves nothing; secondary sources are context only.
5. Review: everything you add starts unconfirmed, also rows you import (only the analyst's own file imports count as parsed and confirmed); a relationship is "unknown" until confirmed evidence exists, "disputed" when confirmed evidence points both ways. You may confirm with review_evidence only after checking the original record yourself: primary source with uri and excerpt, a concrete locator and observation, and a review_note stating what you compared. Keep contradicting evidence (stance refutes) instead of overwriting; retract_evidence instead of deleting.
6. Bulk: import_defender_rows for Defender XDR / Sentinel rows (recognised automatically) or any rows with a format: list_import_formats returns the column mappings the analyst saved; pass one as format. import_rows for two-column rows, import_activities for rows with several participant columns; always dry_run first. Imports are idempotent.
7. Large graphs: create_group bundles many similar entities into one collapsed node (members, or rule by kinds/name match, or a container's contents); excluded keeps anomalies visible on their own. Groups only change the view.
8. Layers (identity, network, endpoint, workload = Kubernetes/containers, cloud = control plane/Key Vaults, data = buckets/blobs/databases, code = repositories/CI, other) are inferred from the kind; set layer only to correct it.
9. export_image renders the graph as SVG (text) or PNG (base64) for reports.

Editing: update tools change only the fields you pass; explicit null clears nullable fields. Pass expected_revision for sources and evidence; HTTP 409 means someone changed it — re-read and retry; 404 means the record does not exist. undo reverts the last change batch made through REST/MCP (never the analyst's own edits) and refuses when someone built on it since. Content changes reset affected reviews.
Times: ISO 8601; a time without a zone is UTC. Compromise marks you set are "suspected" unless you pass level "confirmed" and the evidence proves it.
Tool profile: this server shows a compact agent tool set by default; with FACTGRAPH_MCP_TOOLS=full it exposes one rest_<operation> tool per REST endpoint instead.
"""
mcp = FastMCP("FactGraph Browser Boards", version="0.5.4", instructions=MCP_INSTRUCTIONS)
mcp_app = mcp.http_app(path="/")
app = FastAPI(title="FactGraph API", version="0.5.4", lifespan=mcp_app.lifespan)


@dataclass
class Peer:
    websocket: WebSocket
    name: str
    session_token: str | None = None
    # Messages for this browser, sent by its own writer at its pace (see deliver).
    outbox: asyncio.Queue = field(default_factory=asyncio.Queue)
    queued: int = 0
    writer: asyncio.Task | None = None
    dropped: bool = False


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

BOARD_IN_PATH = re.compile(r"(/boards/)[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}")


class HideBoardIds(logging.Filter):
    """The board ID is the board's access key. Uvicorn logs every WebSocket connection with its path (/ws/boards/<id>), also
    with --no-access-log, and hosting platforms keep container logs (App Service log stream and storage): the ID is
    replaced in every Uvicorn record, and in access log lines should someone switch them on."""
    def filter(self, record: logging.LogRecord) -> bool:
        if isinstance(record.msg, str):
            record.msg = BOARD_IN_PATH.sub(r"\1<board>", record.msg)
        if isinstance(record.args, tuple):
            record.args = tuple(BOARD_IN_PATH.sub(r"\1<board>", arg) if isinstance(arg, str) else arg for arg in record.args)
        return True


for _logger in ("uvicorn.error", "uvicorn.access"):
    logging.getLogger(_logger).addFilter(HideBoardIds())


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


# A browser may fall this far behind (a large sync to a stalled or very slow browser) before it is disconnected; it
# fetches what it lacks when it reconnects (sync by summary).
MAX_OUTBOX_BYTES = 64 * 1024 * 1024
background: set[asyncio.Task] = set()


def deliver(peer: Peer, message: str | bytes) -> None:
    """Queue a message for one browser. Its own writer sends it at that browser's pace, so a slow browser holds back
    neither the sender nor the others: waiting for it inside the sender's loop stopped reading the sender (uvicorn reads one
    message ahead), the sender's pong stayed unread and uvicorn closed the healthy sender ("keepalive ping timeout"); on
    large boards the sync then started over and over."""
    if peer.dropped:
        return
    if peer.queued + len(message) > MAX_OUTBOX_BYTES:
        peer.dropped = True
        task = asyncio.create_task(refuse(peer.websocket, 1013))  # try again later
        background.add(task)
        task.add_done_callback(background.discard)
        return
    peer.queued += len(message)
    peer.outbox.put_nowait(message)


async def write(peer: Peer) -> None:
    """Send what is queued for one browser, in order; ends with its connection."""
    try:
        while True:
            message = await peer.outbox.get()
            try:
                if isinstance(message, bytes):
                    await peer.websocket.send_bytes(message)
                else:
                    await peer.websocket.send_text(message)
            finally:
                peer.queued -= len(message)
    except (RuntimeError, OSError, WebSocketDisconnect):
        pass


def start_peer(peer: Peer) -> Peer:
    peer.writer = asyncio.create_task(write(peer))
    return peer


async def send_to_room(board_id: str, message: dict, *, exclude: str | None = None,
                       target: str | None = None) -> None:
    text = json.dumps(message)
    async with rooms_lock:
        recipients = [peer for actor, peer in rooms.get(board_id, {}).items()
                      if actor != exclude and (target is None or actor == target)]
    for peer in recipients:
        deliver(peer, text)


async def send_bytes_to_room(board_id: str, data: bytes, *, exclude: str | None = None, target: str | None = None) -> None:
    async with rooms_lock:
        recipients = [peer for actor, peer in rooms.get(board_id, {}).items()
                      if actor != exclude and (target is None or actor == target)]
    for peer in recipients:
        deliver(peer, data)


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
            raise HTTPException(401, "Board token is required (X-FactGraph-Token header)")
        future: asyncio.Future[dict] = loop.create_future()
        pending[request_id] = (peer.websocket, future)
    try:
        deliver(peer, json.dumps({"type": "api-command", "requestId": request_id,
                                  "boardId": board_id, "operation": operation, **values}))
        result = await asyncio.wait_for(future, timeout=30)
        if not result.get("ok"):
            error = str(result.get("error") or "Browser rejected the command")
            # The browser validates every write against the board: a missing record is a 404, a concurrent change a 409.
            status = 409 if 'changed.' in error or 'revision' in error else 404 if 'does not exist' in error else 422
            raise HTTPException(status, error)
        return result
    except asyncio.TimeoutError as error:
        raise HTTPException(504, "The browser did not confirm the request") from error
    except (RuntimeError, WebSocketDisconnect) as error:
        raise HTTPException(503, "Browser connection lost") from error
    finally:
        pending.pop(request_id, None)
        result_parts.pop(request_id, None)


async def board_record(board_id: str, collection: str, record_id: str) -> dict | None:
    """One complete record (entities, facts, activities, sources, evidence, groups, views), looked up in the browser: only
    this record crosses the WebSocket, not the whole board."""
    return (await browser_command(board_id, "query", collection=collection, id=record_id)).get("record")


async def apply_drafts(board_id: str, drafts: list[dict]) -> int:
    if len(drafts) > 200_000:
        raise HTTPException(413, "Too many actions in one request")
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
    return await import_mapped(board_id, rows, detection.mapping, title=title, query=query, dry_run=dry_run, detection=detection.summary())


async def import_mapped(board_id: str, rows: list[dict], mapping, *, title: str, query: str, dry_run: bool, detection: dict) -> dict:
    """Rows with a known mapping (a built-in table or a saved format): entities matched by their IDs with the board."""
    index = (await browser_command(board_id, "index"))["index"]
    entities = {(item["kind"].casefold(), item["name"].casefold()): item["id"] for item in index["entities"]}
    by_identifier, owned = {}, set()
    for item in index["entities"]:
        for ident in item.get("identifiers", []):
            key = identifier_key(item["kind"], ident["scheme"], ident.get("namespace") or "", ident["normalized_value"])
            by_identifier.setdefault(key, item["id"])
            owned.add((item["id"], *key[1:]))
    try:
        drafts, summary = table_rows_to_actions(board_id, rows, mapping, title=title, query=query,
            existing_entities=entities, existing_identifiers=by_identifier, known_identifiers=owned,
            existing_facts={item["id"] for item in index["facts"]}, existing_sources={item["id"] for item in index["sources"]})
    except (ValueError, KeyError) as error:
        raise HTTPException(422, str(error)) from error
    summary["detection"] = detection
    summary["title"] = title
    if dry_run:
        return {**summary, "dry_run": True, "action_count": len(drafts)}
    summary["accepted_actions"] = await apply_drafts(board_id, drafts)
    return summary


async def import_with_format(board_id: str, rows: list[dict], fmt: ImportFormat, *, title: str = "", query: str = "",
                             dry_run: bool = False, filename: str = "") -> dict:
    """Rows of an export the analyst mapped in the import dialog and saved as a format."""
    if not valid_uuid(board_id):
        raise HTTPException(422, "Invalid board UUID")
    if not rows:
        raise HTTPException(422, "The file contains no result rows")
    missing = missing_columns(fmt, set().union(*(row.keys() for row in rows)))
    if missing:
        raise HTTPException(422, f"{filename or 'The rows'} lack{'s' if filename else ''} columns of the format {fmt.name}: {', '.join(missing)}")
    if not title or title in ("Activity logs", "Access Logs"):
        title = fmt.name
    if filename and filename not in title:
        title = f"{title} · {filename}"
    described = {"table": fmt.name, "product": "format", "format": fmt.name, "confident": True}
    if fmt.rows == "relationship":
        first, second = fmt.entities
        summary = await import_rows(board_id, RowsInput(rows=rows, title=title, query=query, dry_run=dry_run, subject_field=first.column,
                                                        object_field=second.column, predicate=fmt.operation.strip() or "related to",
                                                        predicate_field=fmt.operation_column, subject_kind=first.kind, object_kind=second.kind),
                                    time_field=fmt.time, end_field=fmt.end, locator_fields=tuple(fmt.locator))
        return {**summary, "table": fmt.name, "product": "format", "detection": described, "title": title}
    return await import_mapped(board_id, rows, compile_format(fmt), title=title, query=query, dry_run=dry_run, detection=described)


async def import_rows(board_id: str, data: RowsInput, **columns) -> dict:
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
            existing_sources={item["id"] for item in index["sources"]}, **columns)
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
    evidence = await board_record(board_id, "evidence", evidence_id)
    if evidence is None or evidence.get("fact_id") != relation_id:
        if await board_record(board_id, "facts", relation_id) is None:
            raise HTTPException(404, "Relationship does not exist on this board")
        raise HTTPException(404, "Evidence does not exist on this relationship")
    values = body.model_dump(exclude_unset=True)
    if "stance" in values and values["stance"] not in {"supports", "refutes"}:
        raise HTTPException(422, "Evidence stance must be supports or refutes")
    if "source_id" in values and values["source_id"] and await board_record(board_id, "sources", values["source_id"]) is None:
        raise HTTPException(422, "Source does not exist on this board")
    if not values:
        raise HTTPException(422, "At least one evidence field is required")
    accepted = await apply_drafts(board_id, [action("assertion.update", {"id": evidence_id, **values})])
    return {"board_id": str(UUID(board_id)), "relation_id": relation_id,
            "id": evidence_id, "accepted_actions": accepted}


@app.delete("/api/boards/{board_id}/relations/{relation_id}/evidence/{evidence_id}")
async def delete_evidence(board_id: str, relation_id: str, evidence_id: str):
    evidence = await board_record(board_id, "evidence", evidence_id)
    if evidence is None or evidence.get("fact_id") != relation_id:
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
    # An object, validated below: the full schema would cost every agent session about 800 tokens of tool definition.
    format: dict | None = Field(default=None, description="An import format as list_import_formats returns it, used instead of recognising the table.")


@app.post("/api/boards/{board_id}/imports/table")
async def import_table_export(board_id: str, body: TableRowsInput):
    """Import rows from Defender XDR advanced hunting or Microsoft Sentinel (DeviceNetworkEvents, SigninLogs, AuditLogs, ASIM …).

    The table is recognised from the column names; devices, accounts, IPs, files and apps become entities matched by their
    IDs (DeviceId, Entra object ID, SID, hashes, resource IDs) with what is already on the board; each row becomes one
    evidence item of an activity with its timestamp and a locator such as ReportId. Rows sent through REST or MCP stay
    unconfirmed until an analyst reviews them (only an analyst's own file import counts as parsed and confirmed). Use dry_run first. An
    unrecognised table returns 422 with a suggested column mapping; then pass a format (one the analyst saved, see list_import_formats,
    or the suggestion completed) or use import_activities with explicit roles."""
    try:
        rows = clean_rows(body.rows)
    except ValueError as error:
        raise HTTPException(422, str(error)) from error
    if body.format:
        return await import_with_format(board_id, rows, parse_format(json.dumps(body.format)), title=body.title, query=body.query, dry_run=body.dry_run)
    return await import_table(board_id, rows, title=body.title, query=body.query, dry_run=body.dry_run)


@app.post("/api/boards/{board_id}/imports/inspect")
async def inspect_import(board_id: str, file: UploadFile = File(...)):
    """Read an export without importing anything: its columns with value types and sample values (and which entities on the
    board their values name or identify), the first rows, whether it is a built-in Defender XDR / Sentinel table, and a
    suggested format (column mapping) to start from. Nothing is stored."""
    rows = await read_upload(file)
    try:
        # The board's entities and their IDs: columns whose values are already known (e.g. object IDs from a Defender
        # import) are recognised as those entities.
        index = (await browser_command(board_id, "index"))["index"]
    except HTTPException:
        index = None
    return inspect_rows(rows, file.filename or "", index)


class FormatPreviewInput(StrictModel):
    rows: list[dict] = Field(max_length=100, description="A few rows of the export, e.g. the sample from /imports/inspect.")
    format: ImportFormat


@app.post("/api/boards/{board_id}/imports/preview")
async def preview_import(board_id: str, body: FormatPreviewInput):
    """What a format makes of the given rows: participants with role and type, what happened, the UTC time, the locator, and
    why a row would be skipped. Reads nothing from the board and stores nothing."""
    try:
        rows = clean_rows(body.rows)
    except ValueError as error:
        raise HTTPException(422, str(error)) from error
    columns = set().union(*(row.keys() for row in rows)) if rows else set()
    return {"rows": preview_rows(rows, body.format), "missing": missing_columns(body.format, columns) if rows else []}


@app.get("/api/boards/{board_id}/imports/formats")
async def list_import_formats(board_id: str):
    """Import formats the analyst saved in the browser of this session: column mappings for exports FactGraph does not know.
    Pass one as format to /imports/table (rows) or /imports/file."""
    return {"formats": (await browser_command(board_id, "formats")).get("formats", [])}


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
                      format: str = Form("", description="A saved import format as JSON (see GET /imports/formats); used instead of the other mapping fields."),
                      batch_id: str = Form("", description="Optional UUID for the change batch, so the uploading browser recognises its own import.")):
    # File uploads are imports: the change log and the notifications show them as such, not as agent writes.
    channel_context = request_channel.set("Import")
    batch_context = request_batch.set(str(UUID(batch_id)) if batch_id and valid_uuid(batch_id) else None)
    try:
        return await _import_file(board_id, file, title, query, dry_run, subject_field, object_field, predicate, predicate_field,
                                  subject_kind, object_kind, roles, auto, format)
    finally:
        request_channel.reset(channel_context)
        request_batch.reset(batch_context)


async def read_upload(file: UploadFile) -> list[dict]:
    content = await file.read(20_000_001)
    if len(content) > 20_000_000:
        raise HTTPException(413, "File is larger than 20 MB")
    try:
        return clean_rows(parse_rows(content, file.filename or ""))
    except (UnicodeError, ValueError, csv.Error) as error:
        raise HTTPException(422, str(error)) from error


def parse_format(text: str) -> ImportFormat:
    from pydantic import ValidationError
    try:
        return ImportFormat.model_validate_json(text)
    except ValidationError as error:
        problems = "; ".join(f"{'.'.join(str(p) for p in e['loc']) or 'format'}: {e['msg']}" for e in error.errors()[:5])
        raise HTTPException(422, f"Invalid import format: {problems}") from error


async def _import_file(board_id, file, title, query, dry_run, subject_field, object_field, predicate, predicate_field,
                       subject_kind, object_kind, roles, auto=False, format=""):
    rows = await read_upload(file)
    if format.strip():
        return await import_with_format(board_id, rows, parse_format(format), title=title, query=query, dry_run=dry_run, filename=file.filename or "")
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


async def board_of_session() -> str:
    """The board of the current board token. Every browser tab makes its own token for each board it opens, so the
    token names the board: agents connected with it never need the board ID."""
    token = request_token.get()
    async with rooms_lock:
        boards = {board for board, room in rooms.items() if any(token_matches(peer.session_token, token) for peer in room.values())}
    if len(boards) == 1:
        return boards.pop()
    if not boards:
        raise HTTPException(409, "No open board for this board token: ask the analyst to open the board in the browser "
                                 "(plug icon → Connect an agent shows the current token)")
    raise HTTPException(422, "This board token is connected to several boards; pass board_id")


async def run_mcp_session(session_token: str | None, operation):
    effective_token = session_token or request_token.get()
    if not effective_token:
        raise HTTPException(401, "MCP requires the board token in the X-FactGraph-Token header (or board_token)")
    token_context = request_token.set(effective_token)
    channel_context = request_channel.set("MCP")
    try:
        return await operation()
    finally:
        request_token.reset(token_context)
        request_channel.reset(channel_context)


# Large action batches arrive as binary frames: b"FGZ1", a 4-byte header length, a small JSON header (type, target) and
# the gzip-compressed message. The relay reads only the header and forwards the frame unchanged: it never inflates or
# re-serialises board data, so a frame costs its compressed size in memory, not hundreds of MB.
FRAME_MAGIC = b"FGZ1"
MAX_FRAME_HEADER = 4096
# Older browsers send plain gzip-compressed JSON; inflated here with a cap and one at a time.
MAX_INFLATED = 64 * 1024 * 1024
legacy_inflation = asyncio.Semaphore(1)


async def receive_message(websocket: WebSocket):
    """One message from a browser: JSON text, a binary frame (returned as (header, frame)), or legacy gzip JSON.
    None if unreadable or too large."""
    frame = await websocket.receive()
    if frame["type"] == "websocket.disconnect":
        raise WebSocketDisconnect(frame.get("code", 1000))
    data = frame.get("bytes")
    if data is not None:
        if data[:4] == FRAME_MAGIC and len(data) >= 8:
            length = int.from_bytes(data[4:8], "big")
            if length > MAX_FRAME_HEADER or 8 + length > len(data):
                return None
            try:
                header = json.loads(data[8:8 + length])
            except ValueError:
                return None
            return (header, data) if isinstance(header, dict) else None
        async with legacy_inflation:
            inflater = zlib.decompressobj(16 + zlib.MAX_WBITS)
            try:
                inflated = inflater.decompress(data, MAX_INFLATED)
            except zlib.error:
                return None
            if inflater.unconsumed_tail:
                return None
            text = inflated.decode("utf-8", errors="replace")
    else:
        text = frame.get("text") or ""
    try:
        return json.loads(text)
    except ValueError:
        return None


def idle_timeout(heartbeat) -> float | None:
    """How long a browser may stay silent: six of the heartbeat intervals it announced in hello (25 s → 150 s). Browsers
    without a heartbeat (older versions) are only closed by WebSocket pings, as before.

    Hosting platforms count WebSocket connections (Azure App Service: 5 on the free plan, 350 from Basic) and their front
    end may keep a connection alive whose browser vanished (closed laptop, changed network): the slot stays taken until a
    restart. Application data cannot be answered by a proxy, so a silent browser is detected and its slot freed."""
    if isinstance(heartbeat, bool) or not isinstance(heartbeat, (int, float)) or heartbeat <= 0:
        return None
    return min(max(float(heartbeat), 0.5), 60.0) * 6


async def refuse(websocket: WebSocket, code: int = 1008) -> None:
    """Close a connection whose browser may already be gone: a reload or a closed tab right after connecting, many at once
    after a server restart. Closing it again is no error worth a traceback."""
    try:
        await websocket.close(code=code)
    except (RuntimeError, OSError, WebSocketDisconnect):  # OSError: uvicorn's ClientDisconnected
        pass


@app.websocket("/ws/boards/{board_id}")
async def board_socket(websocket: WebSocket, board_id: str):
    if not valid_uuid(board_id) or not allowed_origin(websocket):
        await refuse(websocket)
        return
    await websocket.accept()
    # Identity and token arrive in the first message, never in the URL, so they stay out of access logs.
    try:
        hello = json.loads(await asyncio.wait_for(websocket.receive_text(), timeout=10))
    except WebSocketDisconnect:
        return  # the browser left before saying hello
    except (asyncio.TimeoutError, ValueError, RuntimeError, KeyError):
        await refuse(websocket)
        return
    actor = str(hello.get("actor", "")) if isinstance(hello, dict) and hello.get("type") == "hello" else ""
    if not valid_uuid(actor):
        await refuse(websocket)
        return
    name = str(hello.get("name", "Guest")).strip()[:40] or "Guest"
    session_token = str(hello.get("token", "")).strip()[:200] or None
    idle = idle_timeout(hello.get("heartbeat"))

    board_id = str(UUID(board_id))
    async with rooms_lock:
        room = rooms.setdefault(board_id, {})
        previous = room.get(actor)
        peers = [{"id": peer_id, "name": peer.name} for peer_id, peer in room.items()
                 if peer_id != actor]
        own = room[actor] = start_peer(Peer(websocket=websocket, name=name, session_token=session_token))
    if previous:
        # 4001: replaced by a connection with the same identity. The browser does not reconnect on it (two tabs with
        # one actor would otherwise replace each other every few seconds) and offers a new identity instead.
        previous.dropped = True
        if previous.writer:
            previous.writer.cancel()
        try:
            await previous.websocket.close(code=4001, reason="replaced")
        except (RuntimeError, OSError, WebSocketDisconnect):  # the replaced tab may be gone already
            pass
        for request_id, (writer, future) in list(pending.items()):
            if writer is previous.websocket and not future.done():
                future.set_result({"ok": False, "error": "Browser connection replaced"})
    try:
        # Inside the try: a browser that leaves right now is still removed from the room below.
        deliver(own, json.dumps({"type": "welcome", "peers": peers}))
        await send_to_room(board_id, {"type": "peer-joined", "peer": {"id": actor, "name": name}}, exclude=actor)
        while True:
            try:
                message = await (asyncio.wait_for(receive_message(websocket), timeout=idle) if idle else receive_message(websocket))
            except asyncio.TimeoutError:
                # Silent for six heartbeats: the browser is gone, even if a proxy still answers WebSocket pings for it.
                await refuse(websocket, 4000)
                break
            if isinstance(message, tuple):
                header, data = message
                target = header.get("target")
                if header.get("type") == "actions":
                    await send_bytes_to_room(board_id, data, exclude=actor, target=target if isinstance(target, str) else None)
                continue
            if not isinstance(message, dict):
                continue
            kind = message.get("type")
            if kind == "heartbeat":
                # Answered, so the browser knows the whole path is alive (a laptop waking up finds a dead connection).
                deliver(own, '{"type":"heartbeat"}')
            elif kind == "actions":
                actions = message.get("actions")
                if isinstance(actions, list) and len(actions) <= 1000:
                    target = message.get("target")
                    await send_to_room(board_id, {"type": "actions", "from": actor, "actions": actions, "deferRender": message.get("deferRender") is True,
                                                  **({"syncDone": True} if message.get("syncDone") is True else {})},
                                       exclude=actor, target=target if isinstance(target, str) else None)
            elif kind == "sync-request":
                # A summary of what the requester holds lets peers answer with only what is missing.
                target, summary = message.get("target"), message.get("summary")
                await send_to_room(board_id, {"type": "sync-request", "from": actor, **({"summary": summary} if isinstance(summary, dict) else {}),
                                              **({"reply": True} if message.get("reply") is True else {})},
                                   exclude=actor, target=target if isinstance(target, str) else None)
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
        own.dropped = True
        if own.writer:
            own.writer.cancel()
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
