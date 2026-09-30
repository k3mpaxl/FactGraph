"""Board-scoped operations and REST/MCP adapters using exactly the same contracts."""
from __future__ import annotations

import inspect
from typing import Literal, get_type_hints
from uuid import uuid4
from fastapi import HTTPException
from fastapi.routing import APIRoute
from pydantic import Field, ValidationError
from app.contracts import LAYER_HELP, Layer, StrictModel
from app.descriptions import describe_routes, tool_description
from app.ingest import action


class ReviewInput(StrictModel):
    review_status: Literal['confirmed', 'unconfirmed']
    expected_revision: str
    expected_source_revision: str | None = None
    review_note: str = ''


class IdentifierInput(StrictModel):
    id: str | None = None
    scheme: str = 'other'
    raw_value: str = Field(min_length=1)
    namespace: str = ''
    confidence: float = Field(default=1, ge=0, le=1)
    source_id: str | None = None
    valid_from: str | None = None
    valid_to: str | None = None


class IdentifierPatch(StrictModel):
    scheme: str | None = None
    raw_value: str | None = Field(default=None, min_length=1)
    namespace: str | None = None
    confidence: float | None = Field(default=None, ge=0, le=1)
    source_id: str | None = None
    valid_from: str | None = None
    valid_to: str | None = None


class BoardPatch(StrictModel):
    name: str = Field(min_length=1, max_length=80)


class PositionInput(StrictModel):
    x: float = Field(ge=-100000, le=100000, allow_inf_nan=False)
    y: float = Field(ge=-100000, le=100000, allow_inf_nan=False)


class TypeInput(StrictModel):
    id: str | None = None
    name: str = Field(min_length=1)
    color: str = Field(default='#8da9ce', pattern=r'^#[0-9a-fA-F]{6}$')
    icon: str = Field(default='Box', description='One of Box, User, Monitor, KeyRound, Cloud, FileText, Network, Layers.')
    layer: Layer | None = Field(default=None, description=LAYER_HELP)


class TypePatch(StrictModel):
    name: str | None = Field(default=None, min_length=1)
    color: str | None = Field(default=None, pattern=r'^#[0-9a-fA-F]{6}$')
    icon: str | None = None
    layer: Layer | None = Field(default=None, description=LAYER_HELP + ' Explicit null returns to the inferred layer.')


def register_extensions(app, mcp, core):
    read_graph = core['get_graph']
    apply = core['apply_drafts']
    command = core['browser_command']

    async def evidence_record(board_id, relation_id, evidence_id):
        graph = await read_graph(board_id)
        relation = next((f for f in graph['facts'] if f['id'] == relation_id), None)
        evidence = next((a for a in (relation or {}).get('assertions', []) if a['id'] == evidence_id), None)
        if not evidence:
            raise HTTPException(404, 'Evidence does not exist on this relationship and board')
        return graph, evidence

    @app.post('/api/boards/{board_id}/relations/{relation_id}/evidence/{evidence_id}/review')
    async def review_evidence(board_id: str, relation_id: str, evidence_id: str, body: ReviewInput):
        graph, evidence = await evidence_record(board_id, relation_id, evidence_id)
        if evidence.get('revision') != body.expected_revision:
            raise HTTPException(409, 'Evidence revision changed')
        if body.review_status == 'confirmed':
            source = next((s for s in graph['sources'] if s['id'] == evidence.get('source_id')), None)
            if not source or source.get('revision') != body.expected_source_revision:
                raise HTTPException(409, 'Source missing or revision changed')
            if evidence.get('retracted_at') or source.get('source_kind') != 'primary' or not source.get('uri', '').strip() or not source.get('excerpt', '').strip():
                raise HTTPException(422, 'Active evidence requires a primary source with reference and original results')
            if not evidence.get('locator', '').strip() or not (evidence.get('observation') or evidence.get('note', '')).strip() or not body.review_note.strip():
                raise HTTPException(422, 'Observation, locator and review note are required')
        accepted = await apply(board_id, [action('assertion.review', {'id': evidence_id, **body.model_dump()})])
        return {'board_id': board_id, 'id': evidence_id, 'accepted_actions': accepted}

    @app.post('/api/boards/{board_id}/relations/{relation_id}/evidence/{evidence_id}/retract')
    async def retract_evidence(board_id: str, relation_id: str, evidence_id: str):
        await evidence_record(board_id, relation_id, evidence_id)
        return {'board_id': board_id, 'id': evidence_id, 'accepted_actions': await apply(board_id, [action('assertion.retract', {'id': evidence_id})])}

    @app.post('/api/boards/{board_id}/relations/{relation_id}/evidence/{evidence_id}/restore')
    async def restore_evidence(board_id: str, relation_id: str, evidence_id: str):
        await evidence_record(board_id, relation_id, evidence_id)
        return {'board_id': board_id, 'id': evidence_id, 'accepted_actions': await apply(board_id, [action('assertion.restore', {'id': evidence_id})])}

    @app.patch('/api/boards/{board_id}')
    async def rename_board(board_id: str, body: BoardPatch):
        return {'board_id': board_id, 'accepted_actions': await apply(board_id, [action('board.rename', body.model_dump())])}

    @app.patch('/api/boards/{board_id}/entities/{entity_id}/position')
    async def position_entity(board_id: str, entity_id: str, body: PositionInput):
        return {'board_id': board_id, 'id': entity_id, 'accepted_actions': await apply(board_id, [action('entity.position', {'id': entity_id, **body.model_dump()})])}

    @app.post('/api/boards/{board_id}/entities/{entity_id}/identifiers', status_code=201)
    async def create_identifier(board_id: str, entity_id: str, body: IdentifierInput):
        identifier_id = body.id or str(uuid4())
        return {'board_id': board_id, 'id': identifier_id, 'accepted_actions': await apply(board_id, [action('identifier.add', {**body.model_dump(), 'id': identifier_id, 'entity_id': entity_id})])}

    async def check_identifier(board_id, entity_id, identifier_id):
        graph = await read_graph(board_id)
        entity = next((e for e in graph['entities'] if e['id'] == entity_id), {})
        if not any(i['id'] == identifier_id for i in entity.get('identifiers', [])):
            raise HTTPException(404, 'Identifier does not exist on this entity and board')

    @app.patch('/api/boards/{board_id}/entities/{entity_id}/identifiers/{identifier_id}')
    async def update_identifier(board_id: str, entity_id: str, identifier_id: str, body: IdentifierPatch):
        await check_identifier(board_id, entity_id, identifier_id)
        patch = body.model_dump(exclude_unset=True)
        if not patch:
            raise HTTPException(422, 'Empty patch')
        return {'board_id': board_id, 'id': identifier_id, 'accepted_actions': await apply(board_id, [action('identifier.update', {'id': identifier_id, **patch})])}

    @app.delete('/api/boards/{board_id}/entities/{entity_id}/identifiers/{identifier_id}')
    async def delete_identifier(board_id: str, entity_id: str, identifier_id: str):
        await check_identifier(board_id, entity_id, identifier_id)
        return {'board_id': board_id, 'id': identifier_id, 'accepted_actions': await apply(board_id, [action('identifier.delete', {'id': identifier_id})])}

    @app.get('/api/boards/{board_id}/entities/{entity_id}/identifiers')
    async def list_identifiers(board_id: str, entity_id: str):
        graph = await read_graph(board_id)
        entity = next((e for e in graph['entities'] if e['id'] == entity_id), None)
        if not entity:
            raise HTTPException(404, 'Entity not found')
        return {'board_id': board_id, 'items': entity.get('identifiers', [])}

    @app.get('/api/boards/{board_id}/entities/{entity_id}/identifiers/{identifier_id}')
    async def get_identifier(board_id: str, entity_id: str, identifier_id: str):
        await check_identifier(board_id, entity_id, identifier_id)
        records = await list_identifiers(board_id, entity_id)
        return next(i for i in records['items'] if i['id'] == identifier_id)

    @app.get('/api/boards/{board_id}/relations/{relation_id}/evidence')
    async def list_relation_evidence(board_id: str, relation_id: str):
        graph = await read_graph(board_id)
        relation = next((f for f in graph['facts'] if f['id'] == relation_id), None)
        if relation is None:
            raise HTTPException(404, 'Relationship not found')
        return {'board_id': board_id, 'items': relation['assertions']}

    @app.get('/api/boards/{board_id}/relations/{relation_id}/evidence/{evidence_id}')
    async def get_relation_evidence(board_id: str, relation_id: str, evidence_id: str):
        return (await evidence_record(board_id, relation_id, evidence_id))[1]

    @app.get('/api/boards/{board_id}/history')
    async def board_history(board_id: str, offset: int = 0, limit: int = 100):
        result = await command(board_id, 'history')
        items = result['actions']
        if offset < 0 or not 1 <= limit <= 1000:
            raise HTTPException(422, 'Invalid pagination')
        return {'board_id': board_id, 'items': items[offset:offset+limit], 'total': len(items)}

    @app.post('/api/boards/{board_id}/undo')
    async def undo_board(board_id: str):
        return await command(board_id, 'undo')

    @app.post('/api/boards/{board_id}/redo')
    async def redo_board(board_id: str):
        return await command(board_id, 'redo')

    @app.get('/api/guidelines')
    async def guidelines():
        return {'rules': core['MCP_INSTRUCTIONS'].strip().splitlines()}

    def collection_routes(resource, key):
        def records(graph):
            return [a for f in graph['facts'] for a in f['assertions']] if key == 'evidence' else graph.get(key, [])

        async def list_records(board_id: str, q: str = '', offset: int = 0, limit: int = 100):
            graph = await read_graph(board_id)
            if offset < 0 or not 1 <= limit <= 1000:
                raise HTTPException(422, 'Invalid pagination')
            items = [item for item in records(graph) if not q or q.casefold() in str(item).casefold()]
            return {'board_id': board_id, 'items': items[offset:offset+limit], 'total': len(items), 'revision': graph.get('revision')}

        async def get_record(board_id: str, record_id: str):
            graph = await read_graph(board_id)
            record = next((item for item in records(graph) if item['id'] == record_id), None)
            if record is None:
                raise HTTPException(404, f'{resource} record not found on this board')
            return record

        list_records.__name__ = 'list_' + resource
        get_record.__name__ = 'get_' + resource
        app.add_api_route(f'/api/boards/{{board_id}}/{resource}', list_records, methods=['GET'])
        app.add_api_route(f'/api/boards/{{board_id}}/{resource}/{{record_id}}', get_record, methods=['GET'])

    for resource, key in [('entities', 'entities'), ('relations', 'facts'), ('sources', 'sources'), ('evidence', 'evidence')]:
        collection_routes(resource, key)

    @app.post('/api/boards/{board_id}/types', status_code=201)
    async def create_type(board_id: str, body: TypeInput):
        type_id = body.id or str(uuid4())
        return {'board_id': board_id, 'id': type_id, 'accepted_actions': await apply(board_id, [action('type.add', {**body.model_dump(), 'id': type_id})])}

    @app.patch('/api/boards/{board_id}/types/{type_id}')
    async def update_type(board_id: str, type_id: str, body: TypePatch):
        patch = body.model_dump(exclude_unset=True)
        if not patch:
            raise HTTPException(422, 'Empty patch')
        return {'board_id': board_id, 'id': type_id, 'accepted_actions': await apply(board_id, [action('type.update', {'id': type_id, **patch})])}

    @app.delete('/api/boards/{board_id}/types/{type_id}')
    async def delete_type(board_id: str, type_id: str):
        return {'board_id': board_id, 'id': type_id, 'accepted_actions': await apply(board_id, [action('type.delete', {'id': type_id})])}

    collection_routes('types', 'entity_types')
    collection_routes('groups', 'groups')
    collection_routes('perspectives', 'views')

    from app.structures import register_structures
    register_structures(app, core)
    describe_routes(app)

    # Generate thin typed MCP adapters from the same endpoint functions. The canonical
    # names are rest_<operation>; legacy tools remain aliases for existing clients.
    for route in list(app.routes):
        if not isinstance(route, APIRoute) or not route.path.startswith('/api/') or route.path.endswith('/imports/file'):
            continue
        register_mcp_adapter(mcp, route, core['run_mcp_session'])


def register_mcp_adapter(mcp, route, run_session):
    endpoint = route.endpoint
    signature = inspect.signature(endpoint)
    hints = get_type_hints(endpoint)
    parameters = [p.replace(annotation=hints.get(p.name, p.annotation)) for p in signature.parameters.values()]
    parameters.append(inspect.Parameter('session_token', inspect.Parameter.KEYWORD_ONLY, default=None, annotation=str | None))
    parameters = [p.replace(kind=inspect.Parameter.KEYWORD_ONLY) for p in parameters]

    async def invoke(**kwargs):
        token = kwargs.pop('session_token', None)
        try:
            for name, annotation in hints.items():
                if name in kwargs and inspect.isclass(annotation) and issubclass(annotation, StrictModel) and isinstance(kwargs[name], dict):
                    kwargs[name] = annotation.model_validate(kwargs[name])
            if 'board_id' in signature.parameters:
                return await run_session(token, lambda: endpoint(**kwargs))
            result = endpoint(**kwargs)
            return await result if inspect.isawaitable(result) else result
        except HTTPException as exc:
            raise ValueError(f'HTTP {exc.status_code}: {exc.detail}') from exc
        except ValidationError as exc:
            raise ValueError(f'HTTP 422: {exc}') from exc

    invoke.__annotations__ = {p.name: p.annotation for p in parameters}
    invoke.__annotations__['return'] = dict
    invoke.__signature__ = signature.replace(parameters=parameters, return_annotation=dict)
    invoke.__name__ = 'rest_' + endpoint.__name__
    invoke.__doc__ = tool_description(route)
    mcp.tool(invoke, name=invoke.__name__)
