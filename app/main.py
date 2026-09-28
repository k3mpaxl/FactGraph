"""Static FactGraph app and ephemeral WebSocket relay.

The server never stores board content. Browsers exchange their operation logs
when a peer joins and keep their own durable copy in IndexedDB.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from pathlib import Path
from uuid import UUID

from fastapi import FastAPI, File, Form, HTTPException, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from fastmcp import FastMCP
from pydantic import BaseModel, Field

from app.ingest import action, entity_actions, parse_rows, relation_actions, rows_to_actions


WEB_DIR = Path(__file__).resolve().parents[1] / "web" / "dist"
mcp = FastMCP("FactGraph Browser Boards")
mcp_app = mcp.http_app(path="/")
app = FastAPI(title="FactGraph API", version="0.3.0", lifespan=mcp_app.lifespan)


@dataclass
class Peer:
    websocket: WebSocket
    name: str


# Presence only. No board data or action history is retained on the server.
rooms: dict[str, dict[str, Peer]] = {}
rooms_lock = asyncio.Lock()
pending: dict[str, tuple[str, asyncio.Future[dict]]] = {}


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
    request_id = str(uuid4())
    loop = asyncio.get_running_loop()
    async with rooms_lock:
        room = rooms.get(board_id, {})
        if not room:
            raise HTTPException(409, "Board offline: zuerst die Board-URL in einem Browser öffnen")
        actor, peer = next(iter(room.items()))
        future: asyncio.Future[dict] = loop.create_future()
        pending[request_id] = (actor, future)
    try:
        await peer.websocket.send_json({"type": "api-command", "requestId": request_id,
                                        "operation": operation, **values})
        result = await asyncio.wait_for(future, timeout=30)
        if not result.get("ok"):
            raise HTTPException(422, str(result.get("error") or "Browser hat den Auftrag abgelehnt"))
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
    accepted = 0
    for offset in range(0, len(drafts), 200):
        chunk_number = offset // 200 + 1
        defer_render = offset + 200 < len(drafts) and chunk_number % 25 != 0
        response = await browser_command(board_id, "apply", drafts=drafts[offset:offset + 200],
                                         deferRender=defer_render)
        accepted += int(response.get("accepted", 0))
    return accepted


class EntityInput(BaseModel):
    name: str = Field(min_length=1)
    kind: str = "Sonstiges"
    description: str = ""
    id: str | None = None


class RelationInput(BaseModel):
    subject_id: str
    predicate: str = Field(min_length=1)
    object_id: str
    source_id: str | None = None
    note: str = ""
    stance: str = "supports"
    confidence: float = 1
    valid_from: str | None = None
    id: str | None = None


class SourceInput(BaseModel):
    title: str = Field(min_length=1)
    uri: str = ""
    excerpt: str = ""
    id: str | None = None


class EvidenceInput(BaseModel):
    stance: str = "supports"
    confidence: float = Field(default=1, ge=0, le=1)
    source_id: str | None = None
    note: str = ""
    id: str | None = None


class ActionInput(BaseModel):
    id: str | None = None
    type: str
    payload: dict
    author: str = "API"


class ActionBatch(BaseModel):
    actions: list[ActionInput]


class RowsInput(BaseModel):
    rows: list[dict]
    title: str = "Aktivitätslogs"
    query: str = ""
    subject_field: str | None = None
    object_field: str | None = None
    predicate: str = "accessed"
    predicate_field: str | None = None
    subject_kind: str = "IP"
    object_kind: str = "Datei"


async def import_rows(board_id: str, data: RowsInput) -> dict:
    if not valid_uuid(board_id):
        raise HTTPException(422, "Ungültige Board-UUID")
    index = (await browser_command(board_id, "index"))["index"]
    entity_index = {(item["kind"].casefold(), item["name"].casefold()): item["id"]
                    for item in index["entities"]}
    fact_index = {(item["subject_id"], item["predicate"].casefold(), item["object_id"]): item["id"]
                  for item in index["facts"] if item.get("valid_from") is None and item.get("valid_to") is None}
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
        peers = len(rooms.get(board_id, {}))
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
    accepted = await apply_drafts(board_id, drafts)
    return {"id": entity_id, "accepted_actions": accepted}


@app.post("/api/boards/{board_id}/relations", status_code=201)
async def create_relation(board_id: str, body: RelationInput):
    try:
        relation_id, drafts = relation_actions(body.subject_id, body.predicate,
            body.object_id, source_id=body.source_id, note=body.note,
            stance=body.stance, confidence=body.confidence,
            valid_from=body.valid_from, relation_id=body.id)
    except ValueError as error:
        raise HTTPException(422, str(error)) from error
    index = (await browser_command(board_id, "index"))["index"]
    ids = {entity["id"] for entity in index["entities"]}
    if body.subject_id not in ids or body.object_id not in ids:
        raise HTTPException(422, "Quell- oder Zielentität existiert im Board nicht")
    if body.source_id and body.source_id not in {source["id"] for source in index["sources"]}:
        raise HTTPException(422, "Quelle existiert im Board nicht")
    accepted = await apply_drafts(board_id, drafts)
    return {"id": relation_id, "accepted_actions": accepted}


@app.post("/api/boards/{board_id}/sources", status_code=201)
async def create_source(board_id: str, body: SourceInput):
    from uuid import uuid4
    source_id = body.id or str(uuid4())
    accepted = await apply_drafts(board_id, [action("source.add", {
        "id": source_id, "title": body.title, "uri": body.uri,
        "excerpt": body.excerpt})])
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
        "note": body.note})])
    return {"id": evidence_id, "accepted_actions": accepted}


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
                      title: str = Form("Aktivitätslogs"), query: str = Form(""),
                      subject_field: str = Form(""), object_field: str = Form(""),
                      predicate: str = Form("accessed"), predicate_field: str = Form(""),
                      subject_kind: str = Form("IP"),
                      object_kind: str = Form("Datei")):
    content = await file.read(20_000_001)
    if len(content) > 20_000_000:
        raise HTTPException(413, "Datei größer als 20 MB")
    try:
        rows = parse_rows(content, file.filename or "")
    except (UnicodeError, ValueError, csv.Error) as error:
        raise HTTPException(422, str(error)) from error
    return await import_rows(board_id, RowsInput(rows=rows, title=title, query=query,
        subject_field=subject_field or None, object_field=object_field or None,
        predicate=predicate, predicate_field=predicate_field or None,
        subject_kind=subject_kind, object_kind=object_kind))


@mcp.tool
async def board_graph(board_id: str) -> dict:
    """Read the current graph from an open browser board. The UUID identifies the board."""
    return await get_graph(board_id)


@mcp.tool
async def add_entity(board_id: str, name: str, kind: str = "Sonstiges",
                     description: str = "") -> dict:
    """Create one entity on an open board. Use REST /actions for large batches."""
    return await create_entity(board_id, EntityInput(name=name, kind=kind, description=description))


@mcp.tool
async def add_source(board_id: str, title: str, uri: str = "", excerpt: str = "") -> dict:
    """Create an evidence source, such as a repository path, log export or query."""
    return await create_source(board_id, SourceInput(title=title, uri=uri, excerpt=excerpt))


@mcp.tool
async def link_entities(board_id: str, subject_id: str, predicate: str,
                        object_id: str, note: str = "", source_id: str | None = None) -> dict:
    """Create a directed relationship and optional supporting evidence on an open board."""
    return await create_relation(board_id, RelationInput(subject_id=subject_id,
        predicate=predicate, object_id=object_id, note=note, source_id=source_id))


@mcp.tool
async def add_evidence(board_id: str, relation_id: str, note: str,
                       source_id: str | None = None, stance: str = "supports",
                       confidence: float = 1) -> dict:
    """Attach a supporting or refuting statement to an existing relation."""
    return await create_evidence(board_id, relation_id, EvidenceInput(note=note,
        source_id=source_id, stance=stance, confidence=confidence))


@mcp.tool
async def add_kql_evidence(board_id: str, query: str, rows: list[dict],
                           title: str = "KQL-Abfrage", subject_field: str = "IPAddress",
                           object_field: str = "FilePath", predicate: str = "accessed") -> dict:
    """Add already exported KQL result rows as evidence. This tool does not execute KQL.

    Each row links its IP to its file; the query is retained as the evidence source.
    For thousands of rows, use REST /imports/kql instead.
    """
    if len(rows) > 100:
        raise ValueError("MCP-Import ist auf 100 Zeilen begrenzt; bitte REST verwenden")
    return await import_rows(board_id, RowsInput(rows=rows, query=query, title=title,
        subject_field=subject_field, object_field=object_field,
        predicate=predicate))


@app.websocket("/ws/boards/{board_id}")
async def board_socket(websocket: WebSocket, board_id: str):
    actor = websocket.query_params.get("actor", "")
    name = websocket.query_params.get("name", "Gast").strip()[:40] or "Gast"
    if not valid_uuid(board_id) or not valid_uuid(actor):
        await websocket.close(code=1008)
        return

    await websocket.accept()
    async with rooms_lock:
        room = rooms.setdefault(board_id, {})
        previous = room.get(actor)
        peers = [{"id": peer_id, "name": peer.name} for peer_id, peer in room.items()
                 if peer_id != actor]
        room[actor] = Peer(websocket=websocket, name=name)
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
                    await send_to_room(board_id, {"type": "actions", "from": actor, "actions": actions},
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
                if entry and entry[0] == actor and not entry[1].done():
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
                if writer == actor and not future.done():
                    future.set_result({"ok": False, "error": "Browser-Verbindung unterbrochen"})
            await send_to_room(board_id, {"type": "peer-left", "id": actor})


app.mount("/mcp", mcp_app)

if WEB_DIR.is_dir():
    app.mount("/assets", StaticFiles(directory=WEB_DIR / "assets"), name="assets")

    @app.get("/{path:path}", include_in_schema=False)
    def spa(path: str):
        requested = (WEB_DIR / path).resolve()
        if requested.is_file() and requested.is_relative_to(WEB_DIR.resolve()):
            return FileResponse(requested)
        return FileResponse(WEB_DIR / "index.html")
