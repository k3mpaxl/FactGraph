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
        })


if __name__ == "__main__":
    unittest.main()
