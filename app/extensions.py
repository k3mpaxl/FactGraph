"""Board-scoped operations and REST/MCP adapters using exactly the same contracts."""

from __future__ import annotations

import inspect
from typing import Annotated, Literal, get_type_hints
import json
from uuid import UUID, uuid4, uuid5
from fastapi import HTTPException
from fastapi.routing import APIRoute
from fastmcp.tools import FunctionTool
from pydantic import Field, ValidationError
from app.contracts import LAYER_HELP, Layer, StrictModel
from app.descriptions import describe_routes, purpose, tool_description
from app.tool_profiles import AGENT_TOOLS, annotations_for, configured_profile, set_tool_profile
from app.ingest import action
from app.tables import clean_rows
from app.relations import find_joins


class GapRowsInput(StrictModel):
    rows: list[dict] = Field(
        default_factory=list,
        max_length=50_000,
        description="The result rows of the gap's query as returned. An empty list says it found nothing, which answers the gap too.",
    )
    note: str = Field(default='', max_length=2000, description='What was run, or why nothing came back (e.g. "table not in this tenant").')
    query: str = Field(default='', max_length=20_000, description="The KQL actually run, if it differs from the gap's query.")


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
    apply = core['apply_drafts']
    command = core['browser_command']

    record = core['board_record']

    async def evidence_record(board_id, relation_id, evidence_id):
        # Only the record itself crosses the WebSocket, not the whole board.
        evidence = await record(board_id, 'evidence', evidence_id)
        if not evidence or evidence.get('fact_id') != relation_id:
            raise HTTPException(404, 'Evidence does not exist on this relationship and board')
        return evidence

    @app.post('/api/boards/{board_id}/relations/{relation_id}/evidence/{evidence_id}/review')
    async def review_evidence(board_id: str, relation_id: str, evidence_id: str, body: ReviewInput):
        evidence = await evidence_record(board_id, relation_id, evidence_id)
        if evidence.get('revision') != body.expected_revision:
            raise HTTPException(409, 'Evidence revision changed')
        if body.review_status == 'confirmed':
            source = await record(board_id, 'sources', evidence['source_id']) if evidence.get('source_id') else None
            if not source or source.get('revision') != body.expected_source_revision:
                raise HTTPException(409, 'Source missing or revision changed')
            if (
                evidence.get('retracted_at')
                or source.get('source_kind') != 'primary'
                or not source.get('uri', '').strip()
                or not source.get('excerpt', '').strip()
            ):
                raise HTTPException(422, 'Active evidence requires a primary source with reference and original results')
            if (
                not evidence.get('locator', '').strip()
                or not (evidence.get('observation') or evidence.get('note', '')).strip()
                or not body.review_note.strip()
            ):
                raise HTTPException(422, 'Observation, locator and review note are required')
        accepted = await apply(board_id, [action('assertion.review', {'id': evidence_id, **body.model_dump()})])
        return {'board_id': board_id, 'id': evidence_id, 'accepted_actions': accepted}

    @app.post('/api/boards/{board_id}/relations/{relation_id}/evidence/{evidence_id}/retract')
    async def retract_evidence(board_id: str, relation_id: str, evidence_id: str):
        await evidence_record(board_id, relation_id, evidence_id)
        return {
            'board_id': board_id,
            'id': evidence_id,
            'accepted_actions': await apply(board_id, [action('assertion.retract', {'id': evidence_id})]),
        }

    @app.post('/api/boards/{board_id}/relations/{relation_id}/evidence/{evidence_id}/restore')
    async def restore_evidence(board_id: str, relation_id: str, evidence_id: str):
        await evidence_record(board_id, relation_id, evidence_id)
        return {
            'board_id': board_id,
            'id': evidence_id,
            'accepted_actions': await apply(board_id, [action('assertion.restore', {'id': evidence_id})]),
        }

    @app.patch('/api/boards/{board_id}')
    async def rename_board(board_id: str, body: BoardPatch):
        return {'board_id': board_id, 'accepted_actions': await apply(board_id, [action('board.rename', body.model_dump())])}

    @app.patch('/api/boards/{board_id}/entities/{entity_id}/position')
    async def position_entity(board_id: str, entity_id: str, body: PositionInput):
        return {
            'board_id': board_id,
            'id': entity_id,
            'accepted_actions': await apply(board_id, [action('entity.position', {'id': entity_id, **body.model_dump()})]),
        }

    @app.post('/api/boards/{board_id}/entities/{entity_id}/identifiers', status_code=201)
    async def create_identifier(board_id: str, entity_id: str, body: IdentifierInput):
        identifier_id = body.id or str(uuid4())
        return {
            'board_id': board_id,
            'id': identifier_id,
            'accepted_actions': await apply(
                board_id, [action('identifier.add', {**body.model_dump(), 'id': identifier_id, 'entity_id': entity_id})]
            ),
        }

    async def check_identifier(board_id, entity_id, identifier_id):
        entity = await record(board_id, 'entities', entity_id) or {}
        if not any(i['id'] == identifier_id for i in entity.get('identifiers', [])):
            raise HTTPException(404, 'Identifier does not exist on this entity and board')

    @app.patch('/api/boards/{board_id}/entities/{entity_id}/identifiers/{identifier_id}')
    async def update_identifier(board_id: str, entity_id: str, identifier_id: str, body: IdentifierPatch):
        await check_identifier(board_id, entity_id, identifier_id)
        patch = body.model_dump(exclude_unset=True)
        if not patch:
            raise HTTPException(422, 'Empty patch')
        return {
            'board_id': board_id,
            'id': identifier_id,
            'accepted_actions': await apply(board_id, [action('identifier.update', {'id': identifier_id, **patch})]),
        }

    @app.delete('/api/boards/{board_id}/entities/{entity_id}/identifiers/{identifier_id}')
    async def delete_identifier(board_id: str, entity_id: str, identifier_id: str):
        await check_identifier(board_id, entity_id, identifier_id)
        return {
            'board_id': board_id,
            'id': identifier_id,
            'accepted_actions': await apply(board_id, [action('identifier.delete', {'id': identifier_id})]),
        }

    @app.get('/api/boards/{board_id}/entities/{entity_id}/identifiers')
    async def list_identifiers(board_id: str, entity_id: str):
        entity = await record(board_id, 'entities', entity_id)
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
        relation = await record(board_id, 'facts', relation_id)
        if relation is None:
            raise HTTPException(404, 'Relationship not found')
        return {'board_id': board_id, 'items': relation['assertions']}

    @app.get('/api/boards/{board_id}/relations/{relation_id}/evidence/{evidence_id}')
    async def get_relation_evidence(board_id: str, relation_id: str, evidence_id: str):
        return await evidence_record(board_id, relation_id, evidence_id)

    @app.get('/api/boards/{board_id}/history')
    async def board_history(board_id: str, offset: int = 0, limit: int = 100):
        if offset < 0 or not 1 <= limit <= 1000:
            raise HTTPException(422, 'Invalid pagination')
        # The browser pages the history, so only the requested actions cross the WebSocket.
        result = await command(board_id, 'history', offset=offset, limit=limit)
        items = result['actions']
        total = result.get('total', len(items))
        return {'board_id': board_id, 'items': items if 'total' in result else items[offset : offset + limit], 'total': total}

    @app.post('/api/boards/{board_id}/undo')
    async def undo_board(board_id: str):
        return await command(board_id, 'undo')

    @app.post('/api/boards/{board_id}/redo')
    async def redo_board(board_id: str):
        return await command(board_id, 'redo')

    @app.get('/api/guidelines')
    async def guidelines():
        return {'rules': core['MCP_INSTRUCTIONS'].strip().splitlines()}

    @app.get('/api/relations')
    def list_column_relations(table: str = '', column: str = '', family: str = '', limit: int = 20):
        if not 1 <= limit <= 100:
            raise HTTPException(422, 'limit must be 1 to 100')
        return find_joins(table=table.strip(), column=column.strip(), family=family.strip(), limit=limit)

    @app.get('/api/boards/{board_id}/gaps')
    async def list_gaps(board_id: str, limit: int = 10):
        if not 1 <= limit <= 50:
            raise HTTPException(422, 'limit must be 1 to 50')
        report = await command(board_id, 'gaps')
        gaps = report.get('gaps', [])
        return {
            'board_id': board_id,
            'total': len(gaps),
            'answered': len(report.get('answered', [])),
            'gaps': gaps[:limit],
            'next': 'Run a gap\'s query (platform says where) and send its result rows with submit_gap_rows, also when it returns none.'
            if gaps
            else 'Nothing missing: every gap is answered.',
        }

    @app.post('/api/boards/{board_id}/gaps/{gap_id}/rows')
    async def submit_gap_rows(board_id: str, gap_id: str, body: GapRowsInput):
        report = await command(board_id, 'gaps')
        gaps = report.get('gaps', [])
        gap = next((g for g in gaps if g['id'] == gap_id), None)
        try:
            rows = clean_rows(body.rows) if body.rows else []
        except ValueError as error:
            raise HTTPException(422, str(error)) from error
        if gap is None:
            if any(a['id'] == gap_id for a in report.get('answered', [])):
                raise HTTPException(409, f'Gap {gap_id} is already answered; get_gaps lists what is still open')
            # The board moved on since get_gaps (new entities widen a gap, so its ID changes). Rows that fit a table are
            # still imported; a repeated submission adds nothing twice.
            imported = None
            if rows:
                try:
                    imported = await core['import_table'](board_id, rows, query=body.query)
                except HTTPException:
                    imported = None
            now = [g for g in gaps if g['rule'] == gap_id.split(':')[0]]
            raise HTTPException(
                409,
                f'Gap {gap_id} changed since get_gaps'
                + (f'; {imported.get("evidence", 0)} evidence items were imported from the rows' if imported else '')
                + (f'. It is now {now[0]["id"]}: run its query and submit to it.' if now else '. Call get_gaps again.'),
            )
        query = body.query or gap['query']
        imported, stored = None, False
        if rows:
            try:
                imported = await core['import_table'](board_id, rows, query=query)
            except HTTPException as error:
                if error.status_code != 422:
                    raise
                stored = True  # no table mapping reads these rows: they are kept in the answer's source
        meta = {'gap': gap_id, 'rule': gap['rule'], 'entities': gap.get('entities', []), 'rows': len(rows), 'note': body.note}
        excerpt = json.dumps(meta, ensure_ascii=False)
        if stored:
            excerpt += '\n' + json.dumps(rows, ensure_ascii=False, default=str)[:2_000_000]
        source_id = str(uuid5(UUID(board_id), f'gap-answer\x1f{gap_id}'))
        title = f'Answer: {gap["question"]} · ' + (f'{len(rows)} rows' if rows else 'nothing found')
        await apply(
            board_id,
            [
                action(
                    'source.add',
                    {
                        'id': source_id,
                        'title': title[:200],
                        'uri': f'factgraph:gap/{gap_id}',
                        'excerpt': excerpt,
                        'query': query,
                        'source_kind': 'primary' if stored else 'secondary',
                    },
                    action_id=str(uuid5(UUID(board_id), f'gap-answer-action\x1f{gap_id}')),
                    author='Agent',
                )
            ],
        )
        remaining = [g for g in gaps if g['id'] != gap_id]
        result = {
            'board_id': board_id,
            'gap_id': gap_id,
            'rows': len(rows),
            'answer_source_id': source_id,
            'remaining': len(remaining),
            **({'next_gap': {k: remaining[0][k] for k in ('id', 'priority', 'question')}} if remaining else {}),
        }
        if imported:
            result['imported'] = {
                k: imported.get(k)
                for k in ('table', 'evidence', 'relations', 'new_entities', 'identifiers', 'enriched', 'already_on_board')
                if imported.get(k) is not None
            }
        if stored:
            result['stored'] = (
                'No table mapping reads these rows: they are kept in the answer source. Model what they show with create_activity or add_evidence citing answer_source_id.'
            )
        return result

    @app.get('/api/boards/{board_id}/entities/{entity_id}/neighbors')
    async def get_neighbors(board_id: str, entity_id: str, hops: int = 1, limit: int = 200):
        if not 1 <= hops <= 3 or not 1 <= limit <= 1000:
            raise HTTPException(422, 'hops must be 1 to 3, limit 1 to 1000')
        result = await command(board_id, 'neighbors', entity_id=entity_id, hops=hops, limit=limit)
        return {k: v for k, v in result.items() if k not in ('ok', 'type', 'requestId')}

    def collection_routes(resource, key):
        # The browser filters and paginates, so only the requested slice crosses the WebSocket. Lists shorten long
        # texts (<field>_truncated, <field>_length); a single record is complete.
        async def list_records(board_id: str, q: str = '', offset: int = 0, limit: int = 100):
            if offset < 0 or not 1 <= limit <= 1000:
                raise HTTPException(422, 'Invalid pagination')
            result = await command(board_id, 'query', collection=key, q=q, offset=offset, limit=limit)
            return {
                'board_id': board_id,
                'items': result.get('items', []),
                'total': result.get('total', 0),
                'revision': result.get('revision'),
            }

        async def get_record(board_id: str, record_id: str):
            record = (await command(board_id, 'query', collection=key, id=record_id)).get('record')
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
        return {
            'board_id': board_id,
            'id': type_id,
            'accepted_actions': await apply(board_id, [action('type.add', {**body.model_dump(), 'id': type_id})]),
        }

    @app.patch('/api/boards/{board_id}/types/{type_id}')
    async def update_type(board_id: str, type_id: str, body: TypePatch):
        patch = body.model_dump(exclude_unset=True)
        if not patch:
            raise HTTPException(422, 'Empty patch')
        return {
            'board_id': board_id,
            'id': type_id,
            'accepted_actions': await apply(board_id, [action('type.update', {'id': type_id, **patch})]),
        }

    @app.delete('/api/boards/{board_id}/types/{type_id}')
    async def delete_type(board_id: str, type_id: str):
        return {'board_id': board_id, 'id': type_id, 'accepted_actions': await apply(board_id, [action('type.delete', {'id': type_id})])}

    collection_routes('types', 'entity_types')
    collection_routes('groups', 'groups')
    collection_routes('perspectives', 'views')

    from app.structures import register_structures

    register_structures(app, core)
    describe_routes(app)

    # Generate thin typed MCP adapters from the same endpoint functions: rest_<operation> for the full
    # profile and short task names for the default agent profile. Only one profile is visible.
    agent_names: set[str] = set()
    full_names: set[str] = set()
    for route in list(app.routes):
        if not isinstance(route, APIRoute) or not route.path.startswith('/api/') or route.path.endswith('/imports/file'):
            continue
        method = next(iter(route.methods))
        name = route.endpoint.__name__
        full_names.add(
            register_mcp_adapter(mcp, route, core['run_mcp_session'], core['board_of_session'], annotations=annotations_for(method, name))
        )
        if name in AGENT_TOOLS:
            tool_name, purpose_text = AGENT_TOOLS[name]
            agent_names.add(
                register_mcp_adapter(
                    mcp,
                    route,
                    core['run_mcp_session'],
                    core['board_of_session'],
                    name=tool_name,
                    description=purpose_text or purpose(route),
                    annotations=annotations_for(method, name),
                    show_board=False,
                )
            )
    missing = set(AGENT_TOOLS) - {r.endpoint.__name__ for r in app.routes if isinstance(r, APIRoute)}
    if missing:
        raise RuntimeError(f'Agent tool profile references unknown REST operations: {missing}')
    core['MCP_TOOL_PROFILE'] = set_tool_profile(mcp, configured_profile(), agent_names, full_names)
    core['MCP_TOOL_NAMES'] = {'agent': agent_names, 'full': full_names}


# The board token names the board (each browser tab makes its own token for each board it opens), so agents connected
# with it in the X-FactGraph-Token header leave both empty; passing them stays possible for clients that cannot send headers.
BOARD_ID = Annotated[str | None, Field(description='Leave empty: the board of your board token.')]
BOARD_TOKEN = Annotated[str | None, Field(description='Omit if the header is set.')]


def register_mcp_adapter(
    mcp,
    route,
    run_session,
    board_of_session,
    *,
    name: str | None = None,
    description: str | None = None,
    annotations=None,
    show_board: bool = True,
) -> str:
    """An MCP tool for a REST operation. show_board=False (the agent profile) leaves board_id out of the schema agents see,
    so they never ask for it; a board_id passed anyway (older prompts) is still accepted and checked against the token."""
    endpoint = route.endpoint
    signature = inspect.signature(endpoint)
    hints = get_type_hints(endpoint)
    parameters = [
        p.replace(annotation=BOARD_ID, default=None) if p.name == 'board_id' else p.replace(annotation=hints.get(p.name, p.annotation))
        for p in signature.parameters.values()
    ]
    parameters.append(inspect.Parameter('board_token', inspect.Parameter.KEYWORD_ONLY, default=None, annotation=BOARD_TOKEN))
    # The former name, still accepted from older clients, no longer shown.
    parameters.append(inspect.Parameter('session_token', inspect.Parameter.KEYWORD_ONLY, default=None, annotation=str | None))
    parameters = [p.replace(kind=inspect.Parameter.KEYWORD_ONLY) for p in parameters]

    async def invoke(**kwargs):
        token = kwargs.pop('board_token', None) or kwargs.pop('session_token', None)
        kwargs.pop('session_token', None)
        try:
            for name, annotation in hints.items():
                if (
                    name in kwargs
                    and inspect.isclass(annotation)
                    and issubclass(annotation, StrictModel)
                    and isinstance(kwargs[name], dict)
                ):
                    kwargs[name] = annotation.model_validate(kwargs[name])
            if 'board_id' in signature.parameters:

                async def run():
                    if not kwargs.get('board_id'):
                        kwargs['board_id'] = await board_of_session()
                    return await endpoint(**kwargs)

                return await run_session(token, run)
            result = endpoint(**kwargs)
            return await result if inspect.isawaitable(result) else result
        except HTTPException as exc:
            raise ValueError(f'HTTP {exc.status_code}: {exc.detail}') from exc
        except ValidationError as exc:
            raise ValueError(f'HTTP 422: {exc}') from exc

    invoke.__annotations__ = {p.name: p.annotation for p in parameters}
    invoke.__annotations__['return'] = dict
    invoke.__signature__ = signature.replace(parameters=parameters, return_annotation=dict)
    invoke.__name__ = name or 'rest_' + endpoint.__name__
    invoke.__doc__ = description or tool_description(route)
    tool = FunctionTool.from_function(invoke, name=invoke.__name__, annotations=annotations)
    # Only the advertised schema: arguments are validated against the function, which still accepts what is left out.
    hidden = (
        {'session_token'} | (set() if show_board else {'board_id'}) | (set() if 'board_id' in signature.parameters else {'board_token'})
    )
    tool.parameters = {
        **tool.parameters,
        'properties': {key: value for key, value in tool.parameters.get('properties', {}).items() if key not in hidden},
    }
    mcp.add_tool(tool)
    return invoke.__name__
