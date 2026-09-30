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
