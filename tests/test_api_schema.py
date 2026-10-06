import unittest

from app.main import app


class RestPatchSchemaTest(unittest.TestCase):
    def test_global_board_listing_is_not_exposed(self):
        self.assertFalse(any(
            route.path == "/api/boards" and "GET" in getattr(route, "methods", set())
            for route in app.routes
        ))

    def test_patch_routes_cover_editable_board_records(self):
        patch_routes = {
            route.path for route in app.routes
            if "PATCH" in getattr(route, "methods", set())
        }
        self.assertEqual(patch_routes, {
            "/api/boards/{board_id}",
            "/api/boards/{board_id}/entities/{entity_id}/position",
            "/api/boards/{board_id}/entities/{entity_id}",
            "/api/boards/{board_id}/sources/{source_id}",
            "/api/boards/{board_id}/entities/{entity_id}/identifiers/{identifier_id}",
            "/api/boards/{board_id}/types/{type_id}",
            "/api/boards/{board_id}/relations/{relation_id}",
            "/api/boards/{board_id}/relations/{relation_id}/evidence/{evidence_id}",
            "/api/boards/{board_id}/activities/{activity_id}",
            "/api/boards/{board_id}/groups/{group_id}",
            "/api/boards/{board_id}/perspectives/{perspective_id}",
        })

    def test_delete_routes_cover_board_records(self):
        delete_routes = {
            route.path for route in app.routes
            if "DELETE" in getattr(route, "methods", set())
        }
        self.assertEqual(delete_routes, {
            "/api/boards/{board_id}/entities/{entity_id}",
            "/api/boards/{board_id}/sources/{source_id}",
            "/api/boards/{board_id}/entities/{entity_id}/identifiers/{identifier_id}",
            "/api/boards/{board_id}/types/{type_id}",
            "/api/boards/{board_id}/relations/{relation_id}",
            "/api/boards/{board_id}/relations/{relation_id}/evidence/{evidence_id}",
            "/api/boards/{board_id}/activities/{activity_id}",
            "/api/boards/{board_id}/groups/{group_id}",
            "/api/boards/{board_id}/perspectives/{perspective_id}",
        })


if __name__ == "__main__":
    unittest.main()


class TimeNormalisationTest(unittest.TestCase):
    """The API stores times the way the browser does: UTC with milliseconds, a zone-less time read as UTC."""

    def test_times_are_normalised_to_utc(self):
        from app.contracts import CompromiseInput, EntityUpdate, EvidenceInput
        from app.structures import ActivityInput
        self.assertEqual(EvidenceInput(valid_from="2026-09-17T10:00:00+02:00").valid_from, "2026-09-17T08:00:00.000Z")
        self.assertEqual(EvidenceInput(valid_from="2026-09-17T10:00:00").valid_from, "2026-09-17T10:00:00.000Z")
        self.assertEqual(ActivityInput(operation="x", participants=[{"entity_id": "a", "role": "actor"}, {"entity_id": "b", "role": "target"}],
                                       valid_from="2026-09-17T08:00:05.123456Z").valid_from, "2026-09-17T08:00:05.123Z")
        mark = EntityUpdate(compromise={"from": "2026-09-17T10:00:00+02:00"}, rotated_at="2026-09-18T00:00:00")
        self.assertEqual((mark.compromise.since, mark.rotated_at), ("2026-09-17T08:00:00.000Z", "2026-09-18T00:00:00.000Z"))
        with self.assertRaises(ValueError):
            CompromiseInput(**{"from": "2026-09-18T00:00:00Z", "to": "2026-09-17T00:00:00Z"})
