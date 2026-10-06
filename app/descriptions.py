"""Purpose texts shared by OpenAPI and MCP so REST and agent clients read identical guidance."""
from __future__ import annotations

import inspect

from fastapi.routing import APIRoute

# Short purpose lines for routes whose endpoint functions carry no docstring of their own.
ROUTE_HELP = {
    'health': 'Check that the FactGraph server is running. Needs no board and no token.',
    'rename_board': 'Rename the board shown to analysts in the board menu and browser list.',
    'position_entity': 'Move an entity on the canvas to x/y (graph coordinates). Does not change claims or evidence.',
    'update_identifier': 'Patch an external identifier of an entity (scheme, value, namespace, confidence, source, period).',
    'delete_identifier': 'Delete an external identifier from an entity; the entity stays.',
    'restore_evidence': 'Restore retracted evidence. It returns as unconfirmed and needs a new analyst review.',
    'redo_board': 'Redo the last undone action group of this session (same batch as the undo).',
    'guidelines': 'Return the evidence-first modelling rules for agents (same text as the server instructions).',
    'delete_source': 'Delete a source. Refused while evidence or identifiers still reference it; detach them first.',
    'delete_relation': 'Delete a relationship or an activity together with all its evidence. Entities stay.',
    'create_type': 'Create an entity type with default color, icon and layer; entities of this kind use it automatically.',
    'delete_type': 'Delete an entity type that no entity uses anymore. Entities themselves are never deleted by this.',
    'get_relation_evidence': 'Read one evidence item of a relationship or activity, including review status and revision.',
    'get_graph': 'Read the whole board: entities, relationships, activities (facts with participants), sources, evidence, groups, perspectives and types. Call this first to reuse existing IDs instead of creating duplicates.',
    'board_status': 'Check whether a browser currently holds this board open. Every read and write needs an open board.',
    'create_entity': 'Create one concrete investigation object (IP, user, service principal, device, Key Vault, repository …). Look up existing entities first to avoid duplicates.',
    'update_entity': 'Patch an entity: name, kind, description, color, pinned, layer.',
    'merge_entity': 'Merge a duplicate entity into target_id. Identifiers, relationships, activity participations, group memberships and evidence move to the target.',
    'delete_entity': 'Delete an entity with its relationships. Prefer merge for duplicates.',
    'create_relation': 'Create a directed claim subject → predicate → object with optional first evidence. An identical existing claim receives the evidence instead of a duplicate. For one event with three or more participants use create_activity.',
    'update_relation': 'Patch a relationship. Content changes reset its evidence reviews.',
    '__old_delete_relation': 'Delete a relationship or activity and all its evidence.',
    'create_source': 'Register where evidence comes from: log export, KQL results, repository file. Put the original rows into excerpt and set source_kind=primary for first-party records.',
    'update_source': 'Patch a source. Changes reset the review of all evidence citing it; pass expected_revision to detect concurrent edits.',
    '__old_delete_source': 'Delete a source that no evidence or identifier references.',
    'create_evidence': 'Attach a supporting or refuting observation to a relationship or activity (relation_id = relationship or activity ID). New evidence starts unconfirmed.',
    'update_evidence': 'Patch evidence. Content changes reset the review; pass expected_revision to detect concurrent edits.',
    'delete_evidence': 'Delete one evidence item. Prefer retract_evidence to keep the audit trail.',
    'create_actions': 'Low-level batch of raw board actions (up to 50,000) with optional own action IDs for idempotent retries. Prefer the typed operations.',
    'import_kql': 'Import already exported KQL result rows as subject → predicate → object relationships; every row becomes one evidence item, unconfirmed until an analyst reviews it (agent imports are not trusted automatically). Requires query text. Use dry_run first. For rows with three or more participant columns use import_activities.',
    'import_activity': 'Import log rows as subject → predicate → object relationships; every row becomes one evidence item, unconfirmed until an analyst reviews it. Use dry_run first.',
    'review_evidence': 'Confirm or unconfirm evidence after checking the original record: needs a primary source with uri and excerpt, locator, observation, the current expected_revision/expected_source_revision and a review_note saying what was compared.',
    'retract_evidence': 'Retract evidence: it stays in the history but no longer counts for the status.',
    '__old_restore_evidence': 'Restore retracted evidence as unconfirmed.',
    '__old_rename_board': 'Rename the board.',
    '__old_position_entity': 'Move an entity on the canvas.',
    'create_identifier': 'Attach an external identifier (hostname, IP, e-mail, resource ID …) to an entity.',
    '__old_update_identifier': 'Patch an identifier.',
    '__old_delete_identifier': 'Delete an identifier.',
    'board_history': 'Paged action history with channel (UI/REST/MCP), actor and batch ID.',
    'undo_board': 'Undo the last own action group of this session. Refuses when another analyst changed the same records later.',
    '__old_redo_board': 'Redo the last undone action group of this session.',
    '__old_guidelines': 'Evidence-first modelling rules for agents.',
    '__old_create_type': 'Create an entity type with color, icon and layer.',
    'update_type': 'Patch an entity type; renaming updates all entities of that type.',
    '__old_delete_type': 'Delete an entity type that no entity uses.',
}


def purpose(route: APIRoute) -> str:
    name = route.endpoint.__name__
    doc = inspect.getdoc(route.endpoint) or ROUTE_HELP.get(name, '')
    if not doc and name.startswith(('list_', 'get_')):
        noun = name.split('_', 1)[1].replace('_', ' ')
        singular = {'entities': 'entity', 'evidence': 'evidence item'}.get(noun, noun.rstrip('s'))
        doc = (f'List {noun} of the board with IDs. q filters by text; offset/limit paginate (limit ≤ 1000). Long texts are cut to 2,000 characters (<field>_truncated); read one record for the full text.' if name.startswith('list_')
               else f'Read one {singular} of the board by its ID, with all stored fields. Returns 404 if it does not exist on this board.')
    return doc


def tool_description(route: APIRoute) -> str:
    method = next(iter(route.methods))
    notes = [f'REST equivalent: {method} {route.path}.']
    if any(p.name == 'board_id' for p in route.dependant.path_params):
        notes.append('The board must be open in a browser. With the board token in the X-FactGraph-Token header, leave board_id and board_token empty: the token names the board.')
    if method == 'PATCH':
        notes.append('Omitted fields stay unchanged; explicit null clears nullable fields.')
    return f"{purpose(route)}\n\n{' '.join(notes)}"


def describe_routes(app) -> None:
    for route in app.routes:
        if isinstance(route, APIRoute) and route.path.startswith('/api/'):
            text = purpose(route)
            if text and not route.description:
                route.description = text
            if text and not route.summary:
                route.summary = text.split('. ')[0].split('\n')[0][:100]
