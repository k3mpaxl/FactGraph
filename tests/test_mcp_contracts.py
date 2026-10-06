import unittest
from fastapi.routing import APIRoute
from fastmcp import Client
import json
from app.main import app, mcp, set_mcp_tool_profile


class ParityContracts(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        set_mcp_tool_profile('full')

    async def asyncTearDown(self):
        set_mcp_tool_profile('agent')

    async def test_every_rest_operation_has_typed_mcp_equivalent(self):
        async with Client(mcp) as client:
            tools = {t.name: t for t in await client.list_tools()}
        self.assertTrue(all(name.startswith('rest_') for name in tools), 'full profile shows only rest_ tools')
        # File uploads (import, inspect) have no MCP equivalent: agents send rows to /imports/table and /imports/preview.
        routes = [r for r in app.routes if isinstance(r, APIRoute) and r.path.startswith('/api/') and not r.path.endswith(('/imports/file', '/imports/inspect'))]
        self.assertGreater(len(routes), 40)
        for route in routes:
            tool = tools['rest_' + route.endpoint.__name__]
            fields = tool.input_schema['properties']
            for field in route.dependant.path_params + route.dependant.query_params:
                self.assertIn(field.name, fields, route.path)
            for field in route.dependant.body_params:
                self.assertIn(field.name, fields, route.path)
                schema = fields[field.name]
                if '$ref' in schema:
                    schema = tool.input_schema['$defs'][schema['$ref'].rsplit('/',1)[1]]
                self.assertEqual(set(schema['properties']), set(field.field_info.annotation.model_fields), route.path)
                self.assertFalse(schema['additionalProperties'])
        self.assertFalse(any('list_board' in name for name in tools))

    async def test_canonical_patch_preserves_explicit_null_and_rejects_extra(self):
        from app.contracts import EvidenceUpdate, SourceInput, EntityUpdate
        from pydantic import ValidationError
        self.assertEqual(EvidenceUpdate(valid_from=None).model_dump(exclude_unset=True), {'valid_from':None})
        self.assertEqual(EvidenceUpdate().model_dump(exclude_unset=True), {})
        self.assertEqual(EntityUpdate(color=None).model_dump(exclude_unset=True), {'color':None})
        with self.assertRaises(ValidationError):
            EvidenceUpdate(review_status='confirmed')
        with self.assertRaises(ValidationError):
            SourceInput(title='Log', source_kind='probably')
        with self.assertRaises(ValidationError):
            EvidenceUpdate(note=None)
        with self.assertRaises(ValidationError):
            EvidenceUpdate(valid_from='invalid timestamp')


class AgentGuidance(unittest.IsolatedAsyncioTestCase):
    AGENT_TOOLS = {'get_graph', 'get_impact', 'import_defender_rows', 'find_entities', 'create_entity', 'update_entity', 'merge_entities', 'delete_entity', 'add_identifier',
                   'create_relation', 'update_relation', 'delete_relation', 'create_activity', 'update_activity', 'create_source', 'update_source',
                   'add_evidence', 'update_evidence', 'review_evidence', 'retract_evidence', 'import_rows', 'import_activities',
                   'create_group', 'update_group', 'export_image', 'undo', 'list_import_formats'}

    async def test_default_agent_profile_is_small_and_explained(self):
        async with Client(mcp) as client:
            tools = await client.list_tools()
        self.assertEqual({t.name for t in tools}, self.AGENT_TOOLS)
        # Tool definitions are loaded into every agent session; keep them lean.
        size = sum(len(json.dumps(t.model_dump(exclude_none=True))) for t in tools)
        # 9,300: import_defender_rows (about 250 tokens) was added in v0.5.0; 9,500: get_impact and the compromise
        # marking on update_entity (about 250 tokens) for attack impact; 9,700: list_import_formats and the format of
        # import_defender_rows (about 500 tokens) for saved import formats. Keep further growth deliberate.
        self.assertLess(size // 4, 9700, f'agent tool definitions use about {size // 4} tokens')
        for tool in tools:
            self.assertGreater(len(tool.description or ''), 30, tool.name)
            self.assertNotIn('REST equivalent', tool.description, tool.name)
            self.assertIsNotNone(tool.annotations, tool.name)
        by_name = {t.name: t for t in tools}
        self.assertTrue(by_name['find_entities'].annotations.readOnlyHint)
        self.assertTrue(by_name['delete_entity'].annotations.destructiveHint)
        self.assertIn('role', json.dumps(by_name['create_activity'].input_schema))
        # The board token names the board: agents are never asked for a board ID.
        self.assertFalse([t.name for t in tools if 'board_id' in t.input_schema.get('properties', {})])
        self.assertFalse([t.name for t in tools if 'board_id' in (t.input_schema.get('required') or [])])

    async def test_full_profile_describes_every_tool(self):
        set_mcp_tool_profile('full')
        try:
            async with Client(mcp) as client:
                tools = await client.list_tools()
        finally:
            set_mcp_tool_profile('agent')
        self.assertGreater(len(tools), 60)
        for tool in tools:
            purpose = (tool.description or '').split('\n\nREST equivalent')[0].strip()
            self.assertGreater(len(purpose), 30, tool.name)

    def test_instructions_cover_workflow(self):
        from app.main import MCP_INSTRUCTIONS
        for phrase in ('find_entities', 'create_activity', 'unconfirmed', 'review_evidence', 'review_note', 'create_group', 'dry_run', 'board_token', '409', 'FACTGRAPH_MCP_TOOLS'):
            self.assertIn(phrase, MCP_INSTRUCTIONS)
