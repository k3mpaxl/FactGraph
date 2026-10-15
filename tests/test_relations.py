"""Column relations from xdrinternals.com: lookup, REST and MCP, and that imports link the IDs the catalog joins on."""
import asyncio
import json
import unittest

from fastapi.testclient import TestClient
from fastmcp import Client

from app.main import app, mcp
from app.relations import catalog, find_joins
from app.tables import MAPPINGS, participants_of

LINKED = "aad-managed-identity-sign-in-logs-aad-graph-activity-logs-sign-in-activity-id"

# Catalog families that are entities in FactGraph, and the identifier namespace an import gives their ID columns.
NAMESPACES = {"entra-user": "entra-object-id", "defender-device": "mde-device-id", "entra-device": "entra-device-id",
              "oauth-client": "entra-app-id", "service-principal": "entra-object-id"}
# Joins the catalog knows that imports deliberately do not make: each would add a participant (and change the activity
# key of rows already imported) or put a user's object ID on an email address entity.
NOT_LINKED = {
    ("AuditLogs", "TargetResources.[].id"),  # the first target is linked (TargetResources.0.id)
    ("CloudAppEvents", "RawEventData.Target"),
    ("CloudAppEvents", "OAuthAppId"),
    ("EmailEvents", "SenderObjectId"),
    ("EmailEvents", "RecipientObjectId"),
    ("SigninLogs", "ServicePrincipalId"),
    ("AADNonInteractiveUserSignInLogs", "ServicePrincipalId"),
}


class Catalog(unittest.TestCase):
    def test_catalog_is_complete_and_attributed(self):
        data = catalog()
        self.assertGreaterEqual(len(data["relations"]), 150)
        self.assertIn("MIT", data["license"])
        for relation in data["relations"]:
            self.assertIn(relation["family"], data["families"], relation["id"])
            self.assertTrue(relation["from"]["table"] and relation["to"]["column"], relation["id"])

    def test_join_is_found_from_both_ends(self):
        left = find_joins(table="AADManagedIdentitySignInLogs", column="UniqueTokenIdentifier", limit=100)
        right = find_joins(table="aadgraphactivitylogs", column="SignInActivityId", limit=100)
        for result, there in ((left, "AADGraphActivityLogs"), (right, "AADManagedIdentitySignInLogs")):
            item = next(i for i in result["items"] if i["id"] == LINKED)
            self.assertEqual(item["there"]["table"], there)
            self.assertEqual(item["family"], "entra-token")
            self.assertIn("trim_end", item["kql"])
            self.assertIn("padding", item["guidance"])

    def test_json_paths_match_by_leaf_or_full_path(self):
        by_leaf = find_joins(table="CloudAppEvents", column="UniqueTokenId", limit=100)["items"]
        by_path = find_joins(table="CloudAppEvents", column="RawEventData.AppAccessContext.UniqueTokenId", limit=100)["items"]
        # The leaf also finds RawEventData.uniqueTokenId; the full path only AppAccessContext.UniqueTokenId.
        self.assertTrue(by_path)
        self.assertLess({i["id"] for i in by_path}, {i["id"] for i in by_leaf})
        self.assertTrue(all(i["here"]["path"] == "AppAccessContext.UniqueTokenId" for i in by_path))
        self.assertTrue(all(i["here"]["table"] == "CloudAppEvents" for i in by_leaf))

    def test_overview_and_filters(self):
        overview = find_joins()
        self.assertEqual(overview["families"][0]["family"], "entra-token")
        self.assertEqual(sum(f["relations"] for f in overview["families"]), len(catalog()["relations"]))
        sessions = find_joins(family="entra-session", limit=100)
        self.assertEqual(sessions["total"], sum(1 for r in catalog()["relations"] if r["family"] == "entra-session"))
        self.assertEqual(find_joins(table="NoSuchTable")["total"], 0)

    def test_imports_link_the_ids_the_catalog_joins_on(self):
        mappings = {m.table: m for m in MAPPINGS}
        missing = []
        for relation in catalog()["relations"]:
            namespace = NAMESPACES.get(relation["family"])
            if not namespace:
                continue
            for end in (relation["from"], relation["to"]):
                mapping = mappings.get(end["table"])
                if not mapping:
                    continue
                column = f"{end['column']}.{end['path']}" if end.get("path") else end["column"]
                fields = {i.field for part in mapping.parts for i in part.ids if i.namespace == namespace}
                if not fields & {end["column"], column} and (end["table"], column) not in NOT_LINKED:
                    missing.append(f"{end['table']}.{column} ({namespace})")
        self.assertEqual(missing, [])

    def test_entra_device_id_under_its_current_name(self):
        mapping = next(m for m in MAPPINGS if m.table == "EntraIdSignInEvents")
        row = {"AccountUpn": "j.doe@corp.example", "Application": "Azure Portal", "ErrorCode": "0", "LogonType": "[\"interactiveUser\"]",
               "DeviceName": "WS-0142", "EntraIdDeviceId": "dev-guid-1", "UniqueTokenId": "tokenAAAA1111bbbb"}
        device = next(p for p in participants_of(mapping, row) if p["kind"] == "Device")
        self.assertIn({"scheme": "external_id", "namespace": "entra-device-id", "raw": "dev-guid-1"}, device["identifiers"])


class Interfaces(unittest.TestCase):
    def test_rest_needs_no_board_or_token(self):
        client = TestClient(app)
        response = client.get("/api/relations", params={"table": "AADGraphActivityLogs", "column": "SignInActivityId"})
        self.assertEqual(response.status_code, 200)
        self.assertIn(LINKED, {i["id"] for i in response.json()["items"]})
        self.assertEqual(client.get("/api/relations", params={"limit": 0}).status_code, 422)

    def test_agent_tool(self):
        async def call():
            async with Client(mcp) as client:
                tools = {t.name: t for t in await client.list_tools()}
                result = await client.call_tool("find_joins", {"table": "EntraIdSignInEvents", "column": "UniqueTokenId", "limit": 50})
            return tools["find_joins"], result.data
        tool, data = asyncio.run(call())
        self.assertTrue(tool.annotations.readOnlyHint)
        self.assertNotIn("board_token", json.dumps(tool.input_schema))
        self.assertIn("GraphAPIAuditEvents", {i["there"]["table"] for i in data["items"]})


if __name__ == "__main__":
    unittest.main()
