import unittest
from fastapi.routing import APIRoute
from fastmcp import Client
from app.main import app, mcp

class ParityContracts(unittest.IsolatedAsyncioTestCase):
    async def test_every_rest_operation_has_typed_mcp_equivalent(self):
        async with Client(mcp) as client:
            tools = {t.name: t for t in await client.list_tools()}
        routes = [r for r in app.routes if isinstance(r, APIRoute) and r.path.startswith('/api/') and not r.path.endswith('/imports/file')]
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
    async def test_every_tool_explains_its_purpose(self):
        async with Client(mcp) as client:
            tools = await client.list_tools()
        names = {t.name for t in tools}
        for required in ('rest_create_activity', 'rest_import_activities', 'rest_create_group', 'rest_update_group', 'rest_create_perspective',
                         'rest_list_layers', 'rest_list_activities', 'rest_list_groups', 'add_activity', 'group_entities'):
            self.assertIn(required, names)
        for tool in tools:
            purpose = (tool.description or '').split('\n\nREST equivalent')[0].strip()
            self.assertGreater(len(purpose), 30, tool.name)
            self.assertNotIn('REST parity', purpose, tool.name)
        activity = next(t for t in tools if t.name == 'rest_create_activity')
        body = activity.input_schema['properties']['body']
        body = activity.input_schema.get('$defs', {}).get(body.get('$ref', '').rsplit('/', 1)[-1], body)
        self.assertIn('role', str(body['properties']['participants']))

    def test_instructions_cover_workflow(self):
        from app.main import MCP_INSTRUCTIONS
        for phrase in ('rest_get_graph', 'rest_create_activity', 'unconfirmed', 'rest_create_group', 'dry_run', 'session_token', '409'):
            self.assertIn(phrase, MCP_INSTRUCTIONS)
