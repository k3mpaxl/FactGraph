"""MCP tool profiles.

The default "agent" profile exposes a small, task-oriented set of tools: fewer tools cost less context
and lead to better tool choices. FACTGRAPH_MCP_TOOLS=full exposes one rest_<operation> tool per REST
operation instead (complete REST parity). REST itself always stays complete.
"""
from __future__ import annotations

import os

from mcp.types import ToolAnnotations

# REST endpoint function name -> agent tool name, with an optional sharper purpose text.
AGENT_TOOLS: dict[str, tuple[str, str | None]] = {
    'get_graph': ('get_graph', None),
    'list_entities': ('find_entities', 'Find existing entities by name, identifier or type (q) before creating new ones; returns IDs and identifiers. Paginate with offset/limit.'),
    'create_entity': ('create_entity', None),
    'update_entity': ('update_entity', None),
    'merge_entity': ('merge_entities', None),
    'delete_entity': ('delete_entity', None),
    'create_identifier': ('add_identifier', None),
    'create_relation': ('create_relation', None),
    'update_relation': ('update_relation', None),
    'delete_relation': ('delete_relation', None),
    'create_activity': ('create_activity', None),
    'update_activity': ('update_activity', None),
    'create_source': ('create_source', None),
    'update_source': ('update_source', None),
    'create_evidence': ('add_evidence', None),
    'update_evidence': ('update_evidence', None),
    'review_evidence': ('review_evidence', None),
    'retract_evidence': ('retract_evidence', None),
    'import_activity': ('import_rows', 'Import already exported log or query result rows as subject → predicate → object relationships; every row becomes one unconfirmed evidence item. query is optional. Use dry_run first; repeating an import never duplicates.'),
    'import_activities': ('import_activities', None),
    'import_table_export': ('import_defender_rows', 'Import Defender XDR / Sentinel result rows: table recognised from columns, entities matched by IDs. dry_run first.'),
    'create_group': ('create_group', None),
    'update_group': ('update_group', None),
    'export_image': ('export_image', None),
    'undo_board': ('undo', None),
}

PROFILES = ('agent', 'full')


def annotations_for(method: str, name: str) -> ToolAnnotations:
    read_only = method == 'GET'
    return ToolAnnotations(readOnlyHint=read_only, destructiveHint=method == 'DELETE' or name in ('merge_entity', 'undo_board'),
                           idempotentHint=read_only or method in ('PATCH', 'DELETE'), openWorldHint=False)


def set_tool_profile(mcp, profile: str, agent_names: set[str], full_names: set[str]) -> str:
    """Show exactly one profile; the later visibility transform wins, so switching back and forth is safe."""
    profile = profile if profile in PROFILES else 'agent'
    shown, hidden = (full_names, agent_names) if profile == 'full' else (agent_names, full_names)
    mcp.enable(names=shown)
    mcp.disable(names=hidden)
    return profile


def configured_profile() -> str:
    return os.environ.get('FACTGRAPH_MCP_TOOLS', 'agent').strip().lower()
