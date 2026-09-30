"""Static FactGraph app and ephemeral WebSocket relay.

The server never stores board content. Browsers exchange their operation logs
when a peer joins and keep their own durable copy in IndexedDB.
"""

from __future__ import annotations

import asyncio
import csv
import contextvars
import secrets
from dataclasses import dataclass
from pathlib import Path
from uuid import UUID

from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastmcp import FastMCP
from pydantic import BaseModel, Field, ConfigDict
from typing import Literal

from app.contracts import (StrictModel, EntityInput, RelationInput, SourceInput, EvidenceInput, ActionInput, ActionBatch, RowsInput, EntityUpdate, EntityMergeInput, SourceUpdate, RelationUpdate, EvidenceUpdate)

from app.ingest import action, entity_actions, parse_rows, relation_actions, rows_to_actions


WEB_DIR = Path(__file__).resolve().parents[1] / "web" / "dist"
MCP_INSTRUCTIONS = """FactGraph is an evidence-first investigation graph. Analysts and agents build it together in one board.

Connection
- Every tool works on one board_id and needs the board open in a browser (data lives in that browser's IndexedDB; the server only relays). Pass the board's session token as session_token or X-FactGraph-Token. HTTP 409 means no browser holds the board open; ask the analyst to open the board URL.
- There is no board listing. Ask the analyst for the board ID and token (board menu → API/MCP → Copy session token).

Workflow
1. Read first: rest_get_graph (or rest_list_entities with q=…) and reuse existing entity IDs. Never create a second entity for the same object; use rest_merge_entity for duplicates.
2. Entities are concrete objects: one IP, account, service principal, device, file, repository, Key Vault, bucket, pod. Use a clear kind (IP, User, Service Principal, Key Vault, Repository, AKS Cluster, S3 Bucket, Threat Actor …). Set layer only if the automatic one is wrong.
3. Two participants → relationship: rest_create_relation (subject → predicate → object, specific verb such as "reads", "has role on").
   Three or more participants in one observed event → activity: rest_create_activity with operation and role-tagged participants
   (actor, identity, source, tool, via, target, other). Example: attacker used IP a.a.a.a and service principal B and listed Key Vault C →
   operation "listed secrets", participants actor=attacker, source=IP, identity=SP B, target=Key Vault C.
   Attribution ("IP belongs to the attacker") is a separate claim with its own evidence, not part of the activity.
4. Evidence: register the origin with rest_create_source (source_kind=primary for logs, telemetry, repository files; put the original rows into excerpt and the query into query). Attach evidence to a relationship or activity with rest_create_evidence (observation = what the record shows, locator = event ID/CorrelationId/row, valid_from/valid_to = when the activity happened, stance supports|refutes).
   A query without results is not proof. Secondary sources are context only.
5. New evidence is always unconfirmed. Never confirm your own research; the analyst reviews against the original record. A relationship stays "unknown" until confirmed evidence exists; supporting and refuting evidence may coexist ("disputed"). Do not overwrite uncertainty; add refuting evidence instead.
6. Bulk data: rest_import_kql / rest_import_activity for two-column rows, rest_import_activities for rows with several participant columns (roles), always dry_run first. Imports are idempotent: repeating them does not duplicate records. MCP is best for focused edits; very large imports go through REST.
7. Keep large graphs readable: rest_create_group bundles many similar entities (explicit members, or a rule by kinds/name match, or a container's contents) into one collapsed node; use excluded to keep the anomalous ones visible on their own. Groups and perspectives (rest_create_perspective: visible layers) change only the view, never claims or evidence.

Editing and concurrency
- PATCH-style tools change only the fields you pass; explicit null clears nullable fields. Pass expected_revision for sources and evidence to avoid overwriting concurrent edits (HTTP 409 on conflict: re-read and retry).
- Every change is an action with channel (UI/REST/MCP), actor and batch; rest_board_history shows them, rest_undo_board undoes the session's last batch.
- Content changes of a relationship, activity, evidence or source reset affected reviews.
"""
mcp = FastMCP("FactGraph Browser Boards", version="0.4.2", instructions=MCP_INSTRUCTIONS)
mcp_app = mcp.http_app(path="/")
app = FastAPI(title="FactGraph API", version="0.4.2", lifespan=mcp_app.lifespan)


@dataclass
class Peer:
    websocket: WebSocket
    name: str
    session_token: str | None = None


# Presence only. No board data or action history is retained on the server.
rooms: dict[str, dict[str, Peer]] = {}
rooms_lock = asyncio.Lock()
pending: dict[str, tuple[WebSocket, asyncio.Future[dict]]] = {}
request_token: contextvars.ContextVar[str | None] = contextvars.ContextVar("factgraph_request_token", default=None)
request_channel: contextvars.ContextVar[str] = contextvars.ContextVar("factgraph_request_channel", default="REST")


@app.middleware("http")
async def require_board_token(request: Request, call_next):
    """Bind every REST board request to a token from an open browser session."""
    path = request.url.path
    if path.startswith("/api/boards/"):
        board_id = path.removeprefix("/api/boards/").split("/", 1)[0]
        token = request.headers.get("X-FactGraph-Token") or request.query_params.get("token")
        if not token:
            return JSONResponse({"detail": "X-FactGraph-Token is required"}, status_code=401)
        if not valid_uuid(board_id):
            return await call_next(request)
        async with rooms_lock:
            authorized = any(peer.session_token == token for peer in rooms.get(str(UUID(board_id)), {}).values())
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
        raise HTTPException(422, "Ungültige Board-UUID")
    board_id = str(UUID(board_id))
    session_token = values.pop("session_token", None) or request_token.get()
    request_id = str(uuid4())
    loop = asyncio.get_running_loop()
    async with rooms_lock:
        room = rooms.get(board_id, {})
        if not room:
            raise HTTPException(409, "Board offline: zuerst die Board-URL in einem Browser öffnen")
        if session_token:
            matching = [(actor, peer) for actor, peer in room.items() if peer.session_token == session_token]
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
        raise HTTPException(504, "Browser hat den Auftrag nicht bestätigt") from error
    except (RuntimeError, WebSocketDisconnect) as error:
        raise HTTPException(503, "Browser-Verbindung unterbrochen") from error
    finally:
        pending.pop(request_id, None)


async def apply_drafts(board_id: str, drafts: list[dict]) -> int:
    if len(drafts) > 200_000:
        raise HTTPException(413, "Zu viele Aktionen in einem Auftrag")
    from uuid import uuid4
    batch_id = str(uuid4())
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


async def import_rows(board_id: str, data: RowsInput) -> dict:
    if not valid_uuid(board_id):
        raise HTTPException(422, "Ungültige Board-UUID")
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
    return {"ok": True, "storage": "browser", "relay": "memory"}


@app.get("/api/boards/{board_id}/status")
async def board_status(board_id: str):
    if not valid_uuid(board_id):
        raise HTTPException(422, "Ungültige Board-UUID")
    async with rooms_lock:
        peers = len(rooms.get(str(UUID(board_id)), {}))
    return {"board_id": board_id, "online_browsers": peers,
            "durable_storage": "browser-indexeddb"}


@app.get("/api/boards/{board_id}/graph")
async def get_graph(board_id: str):
    return (await browser_command(board_id, "snapshot"))["graph"]


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
        raise HTTPException(404, "Entität existiert im Board nicht")
    values = body.model_dump(exclude_unset=True)
    if not values:
        raise HTTPException(422, "At least one entity field is required")
    if any(not isinstance(values[key], str) or not values[key].strip() for key in ("name", "kind") if key in values):
        raise HTTPException(422, "Name und Typ dürfen nicht leer sein")
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
        raise HTTPException(422, "Quell- oder Zielentität existiert im Board nicht")
    if body.source_id and body.source_id not in {source["id"] for source in index["sources"]}:
        raise HTTPException(422, "Quelle existiert im Board nicht")
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
        raise HTTPException(422, "Beziehung existiert im Board nicht")
    if body.source_id and body.source_id not in {source["id"] for source in index["sources"]}:
        raise HTTPException(422, "Quelle existiert im Board nicht")
    if body.stance not in {"supports", "refutes"}:
        raise HTTPException(422, "Aussage muss supports oder refutes sein")
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
        raise HTTPException(413, "Maximal 50.000 Aktionen pro Anfrage")
    drafts = [action(item.type, item.payload, action_id=item.id,
                     author=item.author) for item in body.actions]
    return {"accepted_actions": await apply_drafts(board_id, drafts)}


@app.post("/api/boards/{board_id}/imports/kql")
async def import_kql(board_id: str, body: RowsInput):
    if not body.query.strip():
        raise HTTPException(422, "KQL-Text fehlt")
    return await import_rows(board_id, body)


@app.post("/api/boards/{board_id}/imports/activity")
async def import_activity(board_id: str, body: RowsInput):
    return await import_rows(board_id, body)


@app.post("/api/boards/{board_id}/imports/file")
async def import_file(board_id: str, file: UploadFile = File(...),
                      title: str = Form("Aktivitätslogs"), query: str = Form(""), dry_run: bool = Form(False),
                      subject_field: str = Form(""), object_field: str = Form(""),
                      predicate: str = Form("accessed"), predicate_field: str = Form(""),
                      subject_kind: str = Form("IP"),
                      object_kind: str = Form("Datei"), roles: str = Form("")):
    content = await file.read(20_000_001)
    if len(content) > 20_000_000:
        raise HTTPException(413, "Datei größer als 20 MB")
    try:
        rows = parse_rows(content, file.filename or "")
    except (UnicodeError, ValueError, csv.Error) as error:
        raise HTTPException(422, str(error)) from error
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


@mcp.tool
async def board_graph(board_id: str, session_token: str | None = None) -> dict:
    """Read the whole board (entities, relationships, activities, sources, evidence, groups, perspectives). Call first to reuse existing IDs."""
    return await run_mcp_session(session_token, lambda: get_graph(board_id))


@mcp.tool
async def add_entity(board_id: str, name: str, kind: str = "Other",
                     description: str = "", color: str | None = None,
                     session_token: str | None = None) -> dict:
    """Create one concrete entity (IP, user, service principal, device, Key Vault, repository …). Check existing entities with board_graph first to avoid duplicates. Returns its id."""
    return await run_mcp_session(session_token, lambda: create_entity(board_id, EntityInput(name=name, kind=kind, description=description, color=color)))


@mcp.tool(name="update_entity")
async def mcp_update_entity(board_id: str, entity_id: str,
                            name: str | None = None, kind: str | None = None,
                            description: str | None = None, color: str | None = None,
                            session_token: str | None = None, patch: dict | None = None) -> dict:
    """Patch an existing entity. Pass only fields that should change."""
    values = {key: value for key, value in {"name": name, "kind": kind,
             "description": description, "color": color}.items() if value is not None}
    if patch is not None:
        values.update(patch)
    return await run_mcp_session(session_token, lambda: update_entity(board_id, entity_id, EntityUpdate(**values)))


@mcp.tool(name="merge_entities")
async def mcp_merge_entities(board_id: str, source_id: str, target_id: str,
                             session_token: str | None = None) -> dict:
    """Merge the source entity into the target while retaining identifiers, relationships and evidence."""
    return await run_mcp_session(session_token, lambda: merge_entity(
        board_id, source_id, EntityMergeInput(target_id=target_id)))


@mcp.tool(name="delete_entity")
async def mcp_delete_entity(board_id: str, entity_id: str,
                            session_token: str | None = None) -> dict:
    """Delete an entity and its attached relationships from an open board."""
    return await run_mcp_session(session_token, lambda: delete_entity(board_id, entity_id))


@mcp.tool
async def add_source(board_id: str, title: str, uri: str = "", excerpt: str = "",
                     session_token: str | None = None) -> dict:
    """Register an evidence source (log export, KQL results, repository file). Put original rows into excerpt. Use rest_create_source to set source_kind=primary and the query."""
    return await run_mcp_session(session_token, lambda: create_source(board_id, SourceInput(title=title, uri=uri, excerpt=excerpt)))


@mcp.tool(name="update_source")
async def mcp_update_source(board_id: str, source_id: str, title: str | None = None,
                            uri: str | None = None, excerpt: str | None = None,
                            session_token: str | None = None, patch: dict | None = None) -> dict:
    """Patch an existing evidence source. Pass only fields that should change."""
    values = {key: value for key, value in {"title": title, "uri": uri,
             "excerpt": excerpt}.items() if value is not None}
    if patch is not None:
        values.update(patch)
    return await run_mcp_session(session_token, lambda: update_source(board_id, source_id, SourceUpdate(**values)))


@mcp.tool(name="delete_source")
async def mcp_delete_source(board_id: str, source_id: str,
                            session_token: str | None = None) -> dict:
    """Delete a source; linked evidence remains and becomes a manual entry."""
    return await run_mcp_session(session_token, lambda: delete_source(board_id, source_id))


@mcp.tool
async def link_entities(board_id: str, subject_id: str, predicate: str,
                        object_id: str, note: str = "", source_id: str | None = None,
                        valid_from: str | None = None, valid_to: str | None = None,
                        session_token: str | None = None) -> dict:
    """Create a directed claim subject → predicate → object; note/source_id add a first unconfirmed evidence item. For events with three or more participants use add_activity."""
    return await run_mcp_session(session_token, lambda: create_relation(board_id, RelationInput(subject_id=subject_id,
        predicate=predicate, object_id=object_id, note=note, source_id=source_id, valid_from=valid_from, valid_to=valid_to))
    )


@mcp.tool(name="update_relationship")
async def mcp_update_relationship(board_id: str, relation_id: str,
                                  subject_id: str | None = None, predicate: str | None = None,
                                  object_id: str | None = None,
                                  valid_from: str | None = None, valid_to: str | None = None,
                                  session_token: str | None = None, patch: dict | None = None) -> dict:
    """Patch a directed relationship. Pass only fields that should change."""
    values = {key: value for key, value in {"subject_id": subject_id, "predicate": predicate,
             "object_id": object_id, "valid_from": valid_from, "valid_to": valid_to}.items()
             if value is not None}
    if patch is not None:
        values.update(patch)
    return await run_mcp_session(session_token, lambda: update_relation(board_id, relation_id, RelationUpdate(**values)))


@mcp.tool(name="delete_relationship")
async def mcp_delete_relationship(board_id: str, relation_id: str,
                                  session_token: str | None = None) -> dict:
    """Delete a relationship (or activity) and all evidence attached to it. Entities stay on the board."""
    return await run_mcp_session(session_token, lambda: delete_relation(board_id, relation_id))


@mcp.tool
async def add_evidence(board_id: str, relation_id: str, note: str,
                       source_id: str | None = None, stance: str = "supports",
                       confidence: float = 1, valid_from: str | None = None, valid_to: str | None = None,
                       session_token: str | None = None) -> dict:
    """Attach a supporting or refuting observation to a relationship or activity (relation_id). New evidence is always unconfirmed."""
    return await run_mcp_session(session_token, lambda: create_evidence(board_id, relation_id, EvidenceInput(note=note,
        source_id=source_id, stance=stance, confidence=confidence, valid_from=valid_from, valid_to=valid_to))
    )


@mcp.tool(name="update_evidence")
async def mcp_update_evidence(board_id: str, relation_id: str, evidence_id: str,
                              valid_from: str | None = None, valid_to: str | None = None,
                              stance: str | None = None, confidence: float | None = None,
                              source_id: str | None = None, note: str | None = None,
                              session_token: str | None = None, patch: dict | None = None) -> dict:
    """Patch evidence attached to a relationship. Pass only fields that should change."""
    values = {key: value for key, value in {"valid_from": valid_from, "valid_to": valid_to,
             "stance": stance, "confidence": confidence, "source_id": source_id,
             "note": note}.items() if value is not None}
    if patch is not None:
        values.update(patch)
    return await run_mcp_session(session_token, lambda: update_evidence(board_id, relation_id, evidence_id, EvidenceUpdate(**values)))


@mcp.tool(name="delete_evidence")
async def mcp_delete_evidence(board_id: str, relation_id: str, evidence_id: str,
                              session_token: str | None = None) -> dict:
    """Delete one evidence item. Prefer update_evidence or retraction when audit history matters."""
    return await run_mcp_session(session_token, lambda: delete_evidence(board_id, relation_id, evidence_id))


@mcp.tool
async def add_activity(board_id: str, operation: str, participants: list[dict], technique: str = "",
                       valid_from: str | None = None, valid_to: str | None = None, source_id: str | None = None,
                       observation: str = "", locator: str = "", session_token: str | None = None) -> dict:
    """Record one observed event with several participants, e.g. attacker used IP a.a.a.a and service principal B and listed Key Vault C.

    participants: [{"entity_id": "...", "role": "actor|identity|source|tool|via|target|other"}, ...] (at least two different entities).
    Optional source_id/observation/locator create the first unconfirmed evidence. Same as rest_create_activity."""
    from app.structures import ActivityInput
    create = core_routes()["create_activity"]
    return await run_mcp_session(session_token, lambda: create(board_id, ActivityInput(operation=operation, participants=participants,
        technique=technique, valid_from=valid_from, valid_to=valid_to, source_id=source_id, observation=observation, locator=locator)))


@mcp.tool
async def group_entities(board_id: str, name: str, members: list[str] | None = None, kinds: list[str] | None = None,
                         match: str = "", excluded: list[str] | None = None, session_token: str | None = None) -> dict:
    """Bundle many similar entities into one collapsed node to keep large graphs readable, e.g. 699 repositories with the same access pattern.

    Pass members (entity IDs) or a rule via kinds/match; excluded keeps single entities visible on their own. Same as rest_create_group."""
    from app.structures import GroupInput
    create = core_routes()["create_group"]
    rule = {"kinds": kinds or [], "match": match} if kinds or match else None
    return await run_mcp_session(session_token, lambda: create(board_id, GroupInput(name=name, members=members or [], rule=rule, excluded=excluded or [])))


def core_routes() -> dict:
    from fastapi.routing import APIRoute as _Route
    return {route.endpoint.__name__: route.endpoint for route in app.routes if isinstance(route, _Route)}


@mcp.tool
async def factgraph_guidelines() -> dict:
    """Return the evidence-first modeling rules for this FactGraph server."""
    return {"rules": MCP_INSTRUCTIONS.strip().splitlines()}


@mcp.tool
async def add_kql_evidence(board_id: str, query: str, rows: list[dict],
                           title: str = "KQL-Abfrage", subject_field: str = "IPAddress",
                           object_field: str = "FilePath", predicate: str = "accessed",
                           session_token: str | None = None) -> dict:
    """Add up to 100 already exported KQL result rows as subject → predicate → object evidence (default IPAddress → accessed → FilePath). FactGraph never executes KQL.

    For rows with several participant columns use rest_import_activities; for thousands of rows use REST /imports/kql."""
    if len(rows) > 100:
        raise ValueError("MCP-Import ist auf 100 Zeilen begrenzt; bitte REST verwenden")
    return await run_mcp_session(session_token, lambda: import_rows(board_id, RowsInput(rows=rows, query=query, title=title,
        subject_field=subject_field, object_field=object_field,
        predicate=predicate)))


@app.websocket("/ws/boards/{board_id}")
async def board_socket(websocket: WebSocket, board_id: str):
    actor = websocket.query_params.get("actor", "")
    name = websocket.query_params.get("name", "Gast").strip()[:40] or "Gast"
    session_token = websocket.query_params.get("token", "").strip() or None
    if not valid_uuid(board_id) or not valid_uuid(actor):
        await websocket.close(code=1008)
        return

    board_id = str(UUID(board_id))
    await websocket.accept()
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
                    future.set_result({"ok": False, "error": "Browser-Verbindung unterbrochen"})
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
            raise HTTPException(404, "Unbekannter API-Endpunkt; siehe /docs")
        return FileResponse(WEB_DIR / "index.html")
