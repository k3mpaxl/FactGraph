"""Activities (n-ary events), groups, perspectives and layers.

Activities are relationships with role-tagged participants, so evidence, review status,
timeline and time window work unchanged. Groups and perspectives only change how a board is
displayed; they never alter claims or evidence.
"""
from __future__ import annotations

from typing import Literal
from uuid import uuid4

from fastapi import HTTPException
from pydantic import Field

from app.contracts import LAYER_HELP, LAYERS, Layer, StrictModel, TIME_HELP
from app.ingest import action, activity_rows_to_actions

ROLE_HELP = "actor, identity, source, tool, via, target or other (see server instructions)."


class ParticipantInput(StrictModel):
    entity_id: str = Field(min_length=1, description="Existing entity ID on this board.")
    role: str = Field(min_length=1, description=ROLE_HELP)


class ActivityInput(StrictModel):
    id: str | None = Field(default=None, description="Optional own UUID; repeating a request with the same ID is idempotent.")
    operation: str = Field(min_length=1, description='What happened, as a short verb phrase, e.g. "listed secrets", "signed in", "read blob".')
    participants: list[ParticipantInput] = Field(min_length=2, description="At least two different entities with roles, e.g. actor, identity, source, target.")
    technique: str = Field(default="", description="Optional MITRE ATT&CK technique ID, e.g. T1555.006.")
    valid_from: str | None = Field(default=None, description=TIME_HELP)
    valid_to: str | None = Field(default=None, description="End of the activity period, if it is an interval.")
    source_id: str | None = Field(default=None, description="Source that proves the event. If observation, locator or source_id is set, a first unconfirmed evidence item is created.")
    observation: str = Field(default="", description="What the original record shows.")
    locator: str = Field(default="", description="Event ID, CorrelationId, result row or file:line in the source.")
    stance: Literal["supports", "refutes"] = "supports"
    confidence: float = Field(default=1, ge=0, le=1)


class ActivityUpdate(StrictModel):
    operation: str | None = Field(default=None, min_length=1)
    participants: list[ParticipantInput] | None = Field(default=None, min_length=2, description="Replaces the whole participant list.")
    technique: str | None = Field(default=None, description="Explicit null or empty clears the technique.")
    valid_from: str | None = None
    valid_to: str | None = None


class RoleColumn(StrictModel):
    field: str = Field(min_length=1, description="Column name in the result rows, e.g. CallerIPAddress.")
    role: str = Field(min_length=1, description=ROLE_HELP)
    kind: str = Field(default="Other", description="Entity type created for values of this column, e.g. IP, Service Principal, Key Vault.")


class ActivityRowsInput(StrictModel):
    dry_run: bool = Field(default=False, description="true returns counts and a preview without saving anything.")
    rows: list[dict] = Field(description="Already exported result rows (KQL, CSV converted to objects). FactGraph never runs queries.")
    title: str = "Activity logs"
    query: str = Field(default="", description="Query text that produced the rows, stored with the source.")
    roles: list[RoleColumn] = Field(min_length=2, description="Which columns are participants and in which role.")
    operation: str = Field(default="performed", description="Operation name when no operation_field is given.")
    operation_field: str | None = Field(default=None, description="Column with the operation per row, e.g. OperationName.")


class GroupRuleInput(StrictModel):
    kinds: list[str] = Field(default_factory=list, description="Entity types that belong to the group, e.g. [\"Repository\"].")
    match: str = Field(default="", description="Only entities whose name or identifier contains this text (case-insensitive).")
    container_id: str | None = Field(default=None, description="Group everything a container reaches via contains/runs/hosts relationships (device → processes → files).")


class GroupInput(StrictModel):
    id: str | None = None
    name: str = Field(min_length=1, max_length=120)
    members: list[str] = Field(default_factory=list, description="Explicit member entity IDs.")
    rule: GroupRuleInput | None = Field(default=None, description="Rule membership; matching entities join automatically, including later imports.")
    excluded: list[str] = Field(default_factory=list, description="Entity IDs kept outside the group even if they match, e.g. the one repository where something different happened.")
    collapsed: bool = Field(default=True, description="Collapsed groups are shown as one node with bundled, counted edges.")
    color: str | None = Field(default=None, pattern=r"^#[0-9a-fA-F]{6}$")


class GroupPatch(StrictModel):
    name: str | None = Field(default=None, min_length=1, max_length=120)
    members: list[str] | None = Field(default=None, description="Replaces explicit members. Prefer add_members/remove_members for concurrent edits.")
    add_members: list[str] | None = None
    remove_members: list[str] | None = None
    exclude: list[str] | None = Field(default=None, description="Take these entities out of the group and keep them separate.")
    include: list[str] | None = Field(default=None, description="Remove entities from the exclusion list again.")
    rule: GroupRuleInput | None = Field(default=None, description="Explicit null removes the rule.")
    collapsed: bool | None = None
    color: str | None = Field(default=None, pattern=r"^#[0-9a-fA-F]{6}$")


class PerspectiveInput(StrictModel):
    id: str | None = None
    name: str = Field(min_length=1, max_length=80, description='E.g. "Cloud path", "Endpoint forensics".')
    layers: list[Layer] | None = Field(default=None, description="Visible layers; null shows all. " + LAYER_HELP)
    collapse_activities: bool = Field(default=False, description="Show activities as simple edges instead of event nodes.")
    show_lanes: bool = Field(default=False, description="Draw layer swimlanes behind the graph.")


class ExportInput(StrictModel):
    format: Literal["svg", "png"] = Field(default="svg", description="svg = vector (editable text, best for reports); png = raster image returned as base64.")
    theme: Literal["light", "dark"] = Field(default="light", description="Light suits documents and print; dark matches the dark canvas.")
    scale: float = Field(default=2, ge=0.5, le=4, description="PNG pixel density; 2 is sharp on screens, 3 for print. Reduced automatically for very large graphs.")
    perspective_id: str | None = Field(default=None, description="Render a saved perspective (visible layers, activity display, lanes). Omit for all layers.")
    collapse_activities: bool = Field(default=False, description="Draw activities as simple edges instead of event nodes.")
    title: str | None = Field(default=None, description="Heading above the graph; defaults to the board name. Empty string omits it.")
    legend: bool = Field(default=True, description="Status legend with relationship counts below the graph.")
    transparent: bool = False


class PerspectivePatch(StrictModel):
    name: str | None = Field(default=None, min_length=1, max_length=80)
    layers: list[Layer] | None = None
    collapse_activities: bool | None = None
    show_lanes: bool | None = None


def register_structures(app, core):
    apply = core['apply_drafts']
    command = core['browser_command']

    async def entity_ids(board_id):
        return {e['id'] for e in (await command(board_id, 'index'))['index']['entities']}

    def check_participants(participants, known):
        items = [p.model_dump() for p in participants]
        missing = [p['entity_id'] for p in items if p['entity_id'] not in known]
        if missing:
            raise HTTPException(422, f'Participant entity does not exist on this board: {", ".join(missing)}')
        if len({p['entity_id'] for p in items}) < 2:
            raise HTTPException(422, 'An activity needs at least two different participants')
        return [{'entity_id': p['entity_id'], 'role': p['role'].strip().casefold()} for p in items]

    record_of = core['board_record']

    async def activity_record(board_id, activity_id):
        record = await record_of(board_id, 'activities', activity_id)
        if record is None:
            raise HTTPException(404, 'Activity does not exist on this board')
        return record

    @app.get('/api/layers')
    async def list_layers():
        """List the investigation layers used to separate identity, network, endpoint, Kubernetes, cloud, data and code views."""
        return {'items': list(LAYERS), 'help': LAYER_HELP, 'roles': ROLE_HELP}

    @app.post('/api/boards/{board_id}/activities', status_code=201)
    async def create_activity(board_id: str, body: ActivityInput):
        """Record one observed event with several participants, e.g. attacker used IP a.a.a.a and service principal B to list Key Vault C.

        Prefer this over several separate relationships when one log record shows all participants together.
        Evidence attaches to the whole activity; the returned id works with all /relations/{id}/evidence endpoints."""
        index = (await command(board_id, 'index'))['index']
        participants = check_participants(body.participants, {e['id'] for e in index['entities']})
        if body.source_id and body.source_id not in {s['id'] for s in index['sources']}:
            raise HTTPException(422, 'Source does not exist on this board')
        activity_id = body.id or str(uuid4())
        # The same activity again (operation, participants, time): the board merges it, so evidence goes to the existing one.
        key = '|'.join(sorted(f"{p['role']}:{p['entity_id']}" for p in participants))
        existing = next((f for f in index['facts'] if f.get('participants_key') == key and f['predicate'].strip().casefold() == body.operation.strip().casefold()
                         and f.get('valid_from') == body.valid_from and f.get('valid_to') == body.valid_to), None)
        if existing:
            activity_id = existing['id']
        drafts = [] if existing else [action('fact.add', {'id': activity_id, 'predicate': body.operation.strip(), 'participants': participants,
                                      'technique': body.technique.strip(), 'valid_from': body.valid_from, 'valid_to': body.valid_to})]
        evidence_id = None
        if body.observation or body.locator or body.source_id:
            evidence_id = str(uuid4())
            drafts.append(action('assertion.add', {'id': evidence_id, 'fact_id': activity_id, 'stance': body.stance, 'confidence': body.confidence,
                                                   'source_id': body.source_id, 'observation': body.observation, 'note': body.observation,
                                                   'locator': body.locator, 'valid_from': body.valid_from, 'valid_to': body.valid_to}))
        return {'board_id': board_id, 'id': activity_id, 'evidence_id': evidence_id, 'accepted_actions': await apply(board_id, drafts)}

    @app.get('/api/boards/{board_id}/activities')
    async def list_activities(board_id: str, q: str = '', entity_id: str = '', offset: int = 0, limit: int = 100):
        """List activities (events with role-tagged participants). Filter by text q or by a participating entity_id."""
        if offset < 0 or not 1 <= limit <= 1000:
            raise HTTPException(422, 'Invalid pagination')
        # Filtered and paginated in the browser; long evidence texts are shortened in lists (get_activity is complete).
        result = await command(board_id, 'query', collection='activities', q=q, offset=offset, limit=limit, entity_id=entity_id or None)
        return {'board_id': board_id, 'items': result.get('items', []), 'total': result.get('total', 0)}

    @app.get('/api/boards/{board_id}/activities/{activity_id}')
    async def get_activity(board_id: str, activity_id: str):
        """Read one activity including participants, evidence and derived truth_state."""
        return await activity_record(board_id, activity_id)

    @app.patch('/api/boards/{board_id}/activities/{activity_id}')
    async def update_activity(board_id: str, activity_id: str, body: ActivityUpdate):
        """Change operation, participants (replaces the list), technique or period. Content changes reset evidence reviews."""
        await activity_record(board_id, activity_id)
        values = body.model_dump(exclude_unset=True)
        if not values:
            raise HTTPException(422, 'Empty patch')
        payload = {'id': activity_id}
        if 'operation' in values:
            payload['predicate'] = values.pop('operation').strip()
        if body.participants is not None:
            payload['participants'] = check_participants(body.participants, await entity_ids(board_id))
            values.pop('participants')
        payload.update(values)
        return {'board_id': board_id, 'id': activity_id, 'accepted_actions': await apply(board_id, [action('fact.update', payload)])}

    @app.delete('/api/boards/{board_id}/activities/{activity_id}')
    async def delete_activity(board_id: str, activity_id: str):
        """Delete an activity and its evidence. Participant entities stay on the board."""
        await activity_record(board_id, activity_id)
        return {'board_id': board_id, 'id': activity_id, 'accepted_actions': await apply(board_id, [action('fact.delete', {'id': activity_id})])}

    @app.post('/api/boards/{board_id}/imports/activities')
    async def import_activities(board_id: str, body: ActivityRowsInput):
        """Import result rows where several columns are participants of one event (e.g. CallerIPAddress → source, AppId → identity, ResourceId → target).

        Rows with the same operation and participants share one activity; every row becomes its own unconfirmed evidence with its timestamp.
        Repeating the same import does not duplicate anything. Use dry_run first."""
        return await import_activity_rows(board_id, body)

    async def import_activity_rows(board_id, body: ActivityRowsInput):
        index = (await command(board_id, 'index'))['index']
        entity_index = {(e['kind'].casefold(), e['name'].casefold()): e['id'] for e in index['entities']}
        try:
            drafts, summary = activity_rows_to_actions(board_id, body.rows, title=body.title, query=body.query,
                roles=[r.model_dump() for r in body.roles], operation=body.operation, operation_field=body.operation_field,
                existing_entities=entity_index, existing_facts={f['id'] for f in index['facts']},
                existing_sources={s['id'] for s in index['sources']})
        except (ValueError, KeyError) as error:
            raise HTTPException(422, str(error)) from error
        if body.dry_run:
            return {**summary, 'dry_run': True, 'preview': drafts[:20], 'action_count': len(drafts)}
        summary['accepted_actions'] = await apply(board_id, drafts)
        return summary
    core['import_activity_rows_impl'] = import_activity_rows

    async def group_record(board_id, group_id):
        group = await record_of(board_id, 'groups', group_id)
        if group is None:
            raise HTTPException(404, 'Group does not exist on this board')
        return group

    def check_members(ids, known, label):
        missing = [i for i in ids or [] if i not in known]
        if missing:
            raise HTTPException(422, f'{label} entity does not exist on this board: {", ".join(missing[:5])}')

    @app.post('/api/boards/{board_id}/groups', status_code=201)
    async def create_group(board_id: str, body: GroupInput):
        """Bundle entities into one collapsible node, e.g. 699 repositories with the same access pattern.

        Use members for an explicit list, rule for automatic membership (types, name match, or a container's contents),
        and excluded to keep single entities visible on their own. Groups never change claims or evidence."""
        known = await entity_ids(board_id)
        check_members(body.members, known, 'Member')
        if body.rule and body.rule.container_id:
            check_members([body.rule.container_id], known, 'Container')
        if not body.members and not body.rule:
            raise HTTPException(422, 'A group needs members or a rule')
        group_id = body.id or str(uuid4())
        payload = {**body.model_dump(exclude={'id'}), 'id': group_id}
        return {'board_id': board_id, 'id': group_id, 'accepted_actions': await apply(board_id, [action('group.add', payload)])}

    @app.patch('/api/boards/{board_id}/groups/{group_id}')
    async def update_group(board_id: str, group_id: str, body: GroupPatch):
        """Rename, collapse/expand, change the rule, or add/remove/exclude/include members of a group."""
        await group_record(board_id, group_id)
        values = body.model_dump(exclude_unset=True)
        if not values:
            raise HTTPException(422, 'Empty patch')
        known = await entity_ids(board_id)
        for key in ('members', 'add_members'):
            check_members(values.get(key), known, 'Member')
        return {'board_id': board_id, 'id': group_id, 'accepted_actions': await apply(board_id, [action('group.update', {'id': group_id, **values})])}

    @app.delete('/api/boards/{board_id}/groups/{group_id}')
    async def delete_group(board_id: str, group_id: str):
        """Remove a group (ungroup). All member entities, relationships and evidence stay unchanged."""
        await group_record(board_id, group_id)
        return {'board_id': board_id, 'id': group_id, 'accepted_actions': await apply(board_id, [action('group.delete', {'id': group_id})])}

    @app.post('/api/boards/{board_id}/export')
    async def export_image(board_id: str, body: ExportInput):
        """Render the board graph as an image for reports: a standalone SVG (vector, content is the SVG text) or PNG (content is base64).

        Groups are shown as stored (collapsed or expanded); use perspective_id to hide layers. The browser holding the board renders it, so it
        looks like the canvas. Save with: jq -r .content > graph.svg, or for PNG: jq -r .content | base64 -d > graph.png."""
        result = await command(board_id, 'export', options=body.model_dump())
        return {'board_id': board_id, **result['export']}

    async def view_record(board_id, view_id):
        if await record_of(board_id, 'views', view_id) is None:
            raise HTTPException(404, 'Perspective does not exist on this board')

    @app.post('/api/boards/{board_id}/perspectives', status_code=201)
    async def create_perspective(board_id: str, body: PerspectiveInput):
        """Save a named view (visible layers, activity display, swimlanes) that analysts can switch to, e.g. only identity + cloud."""
        view_id = body.id or str(uuid4())
        return {'board_id': board_id, 'id': view_id, 'accepted_actions': await apply(board_id, [action('view.add', {**body.model_dump(exclude={'id'}), 'id': view_id})])}

    @app.patch('/api/boards/{board_id}/perspectives/{perspective_id}')
    async def update_perspective(board_id: str, perspective_id: str, body: PerspectivePatch):
        """Change a saved perspective (name, visible layers, activity display, swimlanes)."""
        await view_record(board_id, perspective_id)
        values = body.model_dump(exclude_unset=True)
        if not values:
            raise HTTPException(422, 'Empty patch')
        return {'board_id': board_id, 'id': perspective_id, 'accepted_actions': await apply(board_id, [action('view.update', {'id': perspective_id, **values})])}

    @app.delete('/api/boards/{board_id}/perspectives/{perspective_id}')
    async def delete_perspective(board_id: str, perspective_id: str):
        """Delete a saved perspective. Only the saved view is removed; board data stays unchanged."""
        await view_record(board_id, perspective_id)
        return {'board_id': board_id, 'id': perspective_id, 'accepted_actions': await apply(board_id, [action('view.delete', {'id': perspective_id})])}
