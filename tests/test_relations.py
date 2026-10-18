"""Column relations from xdrinternals.com: lookup, REST and MCP, and that imports link the IDs the catalog joins on."""

import asyncio
import importlib.util
import json
import unittest
from pathlib import Path
from uuid import uuid4

from fastapi.testclient import TestClient
from fastmcp import Client

from app.main import app, mcp
from app.relations import catalog, find_joins
from dataclasses import replace

from app.ingest import identifier_key, row_key, table_rows_to_actions
from app.tables import MAPPINGS, Ident, Part, participants_of
from tests.test_tables import NETWORK, SIGNIN, run

ROOT = Path(__file__).resolve().parents[1]
LINKED = "aad-managed-identity-sign-in-logs-aad-graph-activity-logs-sign-in-activity-id"

# Catalog families that are entities in FactGraph, and the identifier namespace an import gives their ID columns.
NAMESPACES = {
    "entra-user": "entra-object-id",
    "defender-device": "mde-device-id",
    "entra-device": "entra-device-id",
    "oauth-client": "entra-app-id",
    "service-principal": "entra-object-id",
}
# Joins the catalog knows that imports deliberately do not make: an email address is no user entity (the object ID would
# join the two), and the sign-in logs' ServicePrincipalId is not the signed-in user.
NOT_LINKED = {
    ("AuditLogs", "TargetResources.[].id"),  # the first target is linked (TargetResources.0.id)
    ("CloudAppEvents", "RawEventData.Target"),
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

    def test_browser_columns_match_the_catalog(self):
        spec = importlib.util.spec_from_file_location("build_column_relations", ROOT / "scripts" / "build_column_relations.py")
        build = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(build)
        self.assertEqual(
            (ROOT / "web" / "src" / "joinColumns.ts").read_text(encoding="utf-8"),
            build.browser_columns(catalog()),
            "web/src/joinColumns.ts is out of date: run scripts/build_column_relations.py",
        )

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
        row = {
            "AccountUpn": "j.doe@corp.example",
            "Application": "Azure Portal",
            "ErrorCode": "0",
            "LogonType": "[\"interactiveUser\"]",
            "DeviceName": "WS-0142",
            "EntraIdDeviceId": "dev-guid-1",
            "UniqueTokenId": "tokenAAAA1111bbbb",
        }
        device = next(p for p in participants_of(mapping, row) if p["kind"] == "Device")
        self.assertIn({"scheme": "external_id", "namespace": "entra-device-id", "raw": "dev-guid-1"}, device["identifiers"])


class Inventory(unittest.TestCase):
    """DeviceInfo, IdentityInfo and OAuthAppInfo describe what is already on the board; they never fill it."""

    def test_rows_enrich_entities_on_the_board_and_add_nothing_else(self):
        board, index = str(uuid4()), {"entities": [], "facts": [], "sources": []}
        run(board, [dict(r) for r in NETWORK], index)  # device a1b2c3d4e5f6, user j.doe
        device = next(e for e in index["entities"] if e["kind"] == "Device")
        devices = [
            {
                "Timestamp": "2026-09-28T09:00:00Z",
                "DeviceId": "a1b2c3d4e5f6",
                "DeviceName": "ws-0142.corp.example",
                "OSPlatform": "Windows11",
                "PublicIP": "198.51.100.20",
                "AadDeviceId": "dev-guid-1",
                "JoinType": "Hybrid Azure AD Join",
                "ReportId": "7",
            },
            {
                "Timestamp": "2026-09-28T09:00:00Z",
                "DeviceId": "ffff0000",
                "DeviceName": "other.corp.example",
                "OSPlatform": "Windows11",
                "PublicIP": "198.51.100.21",
                "ReportId": "8",
            },
        ]
        detection, drafts, summary = run(board, devices, index)
        self.assertEqual(detection.table, "DeviceInfo")
        self.assertEqual((summary["not_on_board"], summary["evidence"], summary["new_entities"]), (1, 1, 1), "only the public IP is new")
        activity = next(d["payload"] for d in drafts if d["type"] == "fact.add")
        self.assertEqual(activity["predicate"], "reported from public IP")
        self.assertIn({"entity_id": device["id"], "role": "actor"}, activity["participants"])
        added = {
            (d["payload"]["entity_id"], d["payload"]["namespace"], d["payload"]["raw_value"])
            for d in drafts
            if d["type"] == "identifier.add"
        }
        self.assertIn((device["id"], "entra-device-id", "dev-guid-1"), added)
        self.assertNotIn("other.corp.example", {d["payload"]["name"] for d in drafts if d["type"] == "entity.add"})

        identities = [
            {
                "AccountObjectId": "11111111-2222-3333-4444-555555555555",
                "AccountUpn": "J.Doe@corp.example",
                "OnPremSid": "S-1-5-21-1-2-3-1104",
                "AccountDisplayName": "Jane Doe",
                "ReportId": "1",
            },
            {
                "AccountObjectId": "99999999-2222-3333-4444-555555555555",
                "AccountUpn": "someone@corp.example",
                "OnPremSid": "S-1-5-21-1-2-3-1105",
                "ReportId": "2",
            },
        ]
        detection, drafts, summary = run(board, identities, index)
        self.assertEqual(detection.table, "IdentityInfo")
        self.assertEqual((summary["enriched"], summary["not_on_board"], summary["new_entities"], summary["evidence"]), (1, 1, 0, 0))
        self.assertIn(
            ("windows-sid", "S-1-5-21-1-2-3-1104"),
            {(d["payload"]["namespace"], d["payload"]["raw_value"]) for d in drafts if d["type"] == "identifier.add"},
        )

    def test_roles_and_logged_on_users_become_relationships(self):
        board, index = str(uuid4()), {"entities": [], "facts": [], "sources": []}
        run(board, [dict(r) for r in NETWORK], index)  # user j.doe (object ID 11111111-…), device a1b2c3d4e5f6
        identities = [
            {
                "AccountObjectId": "11111111-2222-3333-4444-555555555555",
                "AccountUpn": "J.Doe@corp.example",
                "OnPremSid": "S-1-5-21-1-2-3-1104",
                "AssignedRoles": '["Global Administrator", "Security Reader"]',
                "PrivilegedEntraPimRoles": '["Privileged Role Administrator"]',
                "ReportId": "1",
                "Timestamp": "2026-09-28T08:00:00Z",
            }
        ]
        _, drafts, summary = run(board, identities, index)
        user = next(e["id"] for e in index["entities"] if e["kind"] == "User")
        holds = next(d["payload"] for d in drafts if d["type"] == "fact.add")
        roles = {e["id"]: e["name"] for e in index["entities"] if e["kind"] == "Role"}
        self.assertEqual(holds["predicate"], "holds roles")
        self.assertEqual(
            sorted((roles.get(p["entity_id"], p["entity_id"]), p["role"]) for p in holds["participants"]),
            sorted(
                [
                    ("Global Administrator", "target"),
                    ("Privileged Role Administrator", "other"),
                    ("Security Reader", "target"),
                    (user, "identity"),
                ]
            ),
        )
        self.assertEqual(summary["evidence"], 1)
        # The on-premises SID IdentityInfo added joins DeviceInfo's logged-on user to the same entity.
        devices = [
            {
                "Timestamp": "2026-09-28T09:00:00Z",
                "DeviceId": "a1b2c3d4e5f6",
                "DeviceName": "ws-0142.corp.example",
                "OSPlatform": "Windows11",
                "PublicIP": "198.51.100.20",
                "LoggedOnUsers": '[{"UserName": "jdoe", "DomainName": "CORP", "Sid": "S-1-5-21-1-2-3-1104"}, {"UserName": "ghost", "Sid": "S-1-5-21-9"}]',
                "ReportId": "7",
            }
        ]
        _, drafts, _ = run(board, devices, index)
        report = next(d["payload"] for d in drafts if d["type"] == "fact.add")
        self.assertIn({"entity_id": user, "role": "identity"}, report["participants"])
        self.assertNotIn("ghost", {d["payload"]["name"] for d in drafts if d["type"] == "entity.add"}, "unknown users are not added")

    def test_an_app_known_only_by_its_id_gets_its_name_and_both_sides_are_linked(self):
        board, index = str(uuid4()), {"entities": [], "facts": [], "sources": []}
        # The app as users sign in to it (Service "Azure Portal", app ID c44b4083-…) and its service principal, known only
        # by its object ID (as AzureActivity knows it): two entities until OAuthAppInfo says they are one app.
        run(board, [dict(r) for r in SIGNIN], index)
        spn = [
            {
                "TimeGenerated": "2026-09-28T10:00:00Z",
                "ServicePrincipalName": "0b7f0c1e-1111-4222-8333-444444444444",
                "ServicePrincipalId": "0b7f0c1e-1111-4222-8333-444444444444",
                "ResourceDisplayName": "Microsoft Graph",
                "ResultType": "0",
                "IPAddress": "203.0.113.7",
                "CorrelationId": "s-1",
            }
        ]
        run(board, spn, index)
        principal = next(e for e in index["entities"] if e["kind"] == "Service Principal")
        self.assertEqual(principal["name"], "0b7f0c1e-1111-4222-8333-444444444444")
        apps = [
            {
                "OAuthAppId": "c44b4083-3bb0-49c1-b47d-974e53cbdf3c",
                "ServicePrincipalId": "0b7f0c1e-1111-4222-8333-444444444444",
                "AppName": "Azure Portal",
                "PrivilegeLevel": "High",
                "ReportId": "a-1",
                "Timestamp": "2026-09-28T11:00:00Z",
            }
        ]
        detection, drafts, summary = run(board, apps, index)
        self.assertEqual(detection.table, "OAuthAppInfo")
        self.assertIn({"id": principal["id"], "name": "Azure Portal"}, [d["payload"] for d in drafts if d["type"] == "entity.update"])
        link = next(d["payload"] for d in drafts if d["type"] == "fact.add")
        self.assertEqual(
            (link["predicate"], sorted(p["role"] for p in link["participants"])), ("service principal of", ["identity", "target"])
        )
        self.assertEqual(summary["new_entities"], 0)


class ProcessStartKey(unittest.TestCase):
    """A launch seen with its path (DeviceProcessEvents) and without it (DeviceNetworkEvents) is one process entity."""

    LAUNCH = {
        "Timestamp": "2026-09-28T10:00:00Z",
        "DeviceId": "DEV-0142",
        "DeviceName": "ws-0142.corp.example",
        "ActionType": "ProcessCreated",
        "FileName": "powershell.exe",
        "FolderPath": "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
        "ProcessCommandLine": "powershell -enc SQBFAFgA",
        "InitiatingProcessFileName": "winword.exe",
        "ProcessUniqueId": "200",
        "InitiatingProcessUniqueId": "100",
        "ReportId": "1",
    }
    CONNECT = {
        "Timestamp": "2026-09-28T10:00:05Z",
        "DeviceId": "DEV-0142",
        "DeviceName": "ws-0142.corp.example",
        "ActionType": "ConnectionSuccess",
        "RemoteIP": "203.0.113.7",
        "RemotePort": "443",
        "InitiatingProcessFileName": "powershell.exe",
        "InitiatingProcessUniqueId": "200",
        "ReportId": "2",
    }

    def test_one_process_across_tables(self):
        board, index = str(uuid4()), {"entities": [], "facts": [], "sources": []}
        run(board, [dict(self.LAUNCH)], index)
        _, drafts, summary = run(board, [dict(self.CONNECT)], index)
        self.assertEqual([e["name"] for e in index["entities"] if e["kind"] == "Process"].count("powershell.exe"), 1)
        self.assertNotIn("powershell.exe", {d["payload"]["name"] for d in drafts if d["type"] == "entity.add"})
        self.assertIn(
            ("process-start-key", "dev-0142|200"),
            {(d["payload"]["scheme"], d["payload"]["normalized_value"]) for d in drafts if d["type"] == "identifier.add"}
            | {(i["scheme"], i["normalized_value"]) for e in index["entities"] for i in e["identifiers"]},
        )

    def test_a_board_imported_before_gets_nothing_twice(self):
        # The old way: the connection first, so its process exists by device and name before the launch is known.
        board, index = str(uuid4()), {"entities": [], "facts": [], "sources": []}
        _, first, _ = run(board, [dict(self.CONNECT)], index)
        run(board, [dict(self.LAUNCH)], index)
        _, again, _ = run(board, [dict(self.CONNECT)], index)
        # The browser drops actions it knows (the IDs are stable): nothing new may come from the repeat.
        known = {d["payload"]["id"] for d in first}
        self.assertFalse([d for d in again if d["type"] in ("entity.add", "fact.add", "assertion.add") and d["payload"]["id"] not in known])


class GraphActivity(unittest.TestCase):
    """Microsoft Graph, Azure AD Graph and Defender's Graph audit rows: who called what, grouped by request."""

    def test_calls_on_many_objects_are_one_activity_per_request(self):
        board, index = str(uuid4()), {"entities": [], "facts": [], "sources": []}
        run(board, [dict(r) for r in SIGNIN], index)  # j.doe, object ID 11111111-…
        base = {
            "TimeGenerated": "2026-09-28T10:00:00Z",
            "RequestMethod": "GET",
            "ResponseStatusCode": "200",
            "IPAddress": "203.0.113.7",
            "SignInActivityId": "tokenAAAA1111bbbb",
            "UserId": "11111111-2222-3333-4444-555555555555",
            "AppId": "d3590ed6-52b3-4102-aeff-aad2292ab01c",
            "ServicePrincipalId": "",
        }
        rows = [
            {**base, "RequestId": f"r{i}", "RequestUri": f"https://graph.microsoft.com/v1.0/users/{user}/messages?$top=50"}
            for i, user in enumerate(["a@corp.example", "b@corp.example", "0b7f0c1e-1111-4222-8333-444444444444"])
        ] + [
            {
                **base,
                "RequestId": "r9",
                "RequestUri": "https://graph.microsoft.com/v1.0/applications",
                "RequestMethod": "POST",
                "ResponseStatusCode": "403",
            }
        ]
        detection, drafts, summary = run(board, rows, index)
        self.assertEqual(detection.table, "MicrosoftGraphActivityLogs")
        operations = sorted(d["payload"]["predicate"] for d in drafts if d["type"] == "fact.add")
        self.assertEqual(operations, ["GET /v1.0/users/{id}/messages", "POST /v1.0/applications (failed 403)"])
        self.assertEqual(summary["evidence"], 4)
        user = next(e["id"] for e in index["entities"] if e["kind"] == "User")
        read = next(d["payload"] for d in drafts if d["type"] == "fact.add" and d["payload"]["predicate"].startswith("GET"))
        names = {e["id"]: e["name"] for e in index["entities"]}
        self.assertIn({"entity_id": user, "role": "identity"}, read["participants"], "the user from the sign-in logs, by object ID")
        self.assertEqual(
            sorted(names[p["entity_id"]] for p in read["participants"] if p["role"] in ("target", "source")),
            ["203.0.113.7", "Microsoft Graph"],
        )

    def test_tables_are_told_apart(self):
        from app.tables import detect

        graph = {"RequestMethod", "RequestUri", "ResponseStatusCode", "SignInActivityId"}
        self.assertEqual(detect(graph | {"IPAddress", "UserId"}).table, "MicrosoftGraphActivityLogs")
        self.assertEqual(detect(graph | {"CallerIpAddress", "UserId"}).table, "AADGraphActivityLogs")
        self.assertEqual(
            detect({"RequestMethod", "RequestUri", "ResponseStatusCode", "IpAddress", "UniqueTokenIdentifier"}).table, "GraphAPIAuditEvents"
        )
        sp = {"ServicePrincipalName", "ServicePrincipalId", "ResourceDisplayName", "ResultType"}
        self.assertEqual(detect(sp | {"ManagedServiceIdentity"}).table, "AADManagedIdentitySignInLogs")
        self.assertEqual(detect(sp).table, "AADServicePrincipalSignInLogs")


class RowKeys(unittest.TestCase):
    """A row already on the board adds no evidence again, also when a newer mapping sees other entities in it."""

    # The same values as rowKey in web/src/rowKey.ts (web/tests/correlation.cjs checks them there).
    REFERENCE = {
        "": "488bdcb81aee8d83",
        '{"ReportId": "18842"}': "7c4ea6c59c353090",
        "Größe 😀 ü": "c697395edc13c23e",
        "a" * 1000: "4a3c0002518a359e",
    }

    def test_same_key_as_the_browser(self):
        for text, key in self.REFERENCE.items():
            self.assertEqual(row_key(text), key, text[:20])

    def test_a_changed_mapping_does_not_duplicate_rows_already_on_the_board(self):
        board, index = str(uuid4()), {"entities": [], "facts": [], "sources": []}
        _, drafts, _ = run(board, [dict(r) for r in NETWORK], index)
        rows = {row_key(d["payload"]["note"]) for d in drafts if d["type"] == "assertion.add"}
        mapping = next(m for m in MAPPINGS if m.table == "DeviceNetworkEvents")
        # A newer mapping: the remote port as a participant of its own, and an ID for the device it reads now.
        newer = replace(
            mapping,
            parts=mapping.parts
            + (Part("other", "Port", ("RemotePort",)), Part("source", "Device", ("DeviceName",), (Ident("LocalIP", "ip"),), lower=True)),
        )
        by_name = {(e["kind"].casefold(), e["name"].casefold()): e["id"] for e in index["entities"]}
        by_identifier, owned = {}, set()
        for e in index["entities"]:
            for i in e["identifiers"]:
                key = identifier_key(e["kind"], i["scheme"], i["namespace"], i["normalized_value"])
                by_identifier.setdefault(key, e["id"])
                owned.add((e["id"], *key[1:]))
        common = dict(
            title="DeviceNetworkEvents",
            existing_entities=by_name,
            existing_identifiers=by_identifier,
            known_identifiers=owned,
            existing_facts={f["id"] for f in index["facts"]},
            existing_sources={s["id"] for s in index["sources"]},
        )
        drafts, summary = table_rows_to_actions(board, [dict(r) for r in NETWORK], newer, existing_rows=rows, **common)
        self.assertEqual(summary["already_on_board"], 1)
        self.assertFalse(
            [d for d in drafts if d["type"] in ("entity.add", "fact.add", "assertion.add")],
            "nothing new: no port entity, no activity, no evidence",
        )
        device = next(e["id"] for e in index["entities"] if e["kind"] == "Device")
        self.assertIn(
            (device, "10.0.0.5"),
            {(d["payload"]["entity_id"], d["payload"]["raw_value"]) for d in drafts if d["type"] == "identifier.add"},
            "the entity on the board gets the ID the newer mapping reads",
        )
        # Without the board's rows (an older browser) the newer mapping makes a second activity, as before.
        drafts, _ = table_rows_to_actions(board, [dict(r) for r in NETWORK], newer, **common)
        self.assertTrue([d for d in drafts if d["type"] == "fact.add"])


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
        self.assertTrue(tool.annotations.read_only_hint)
        self.assertNotIn("board_token", json.dumps(tool.input_schema))
        self.assertIn("GraphAPIAuditEvents", {i["there"]["table"] for i in data["items"]})


if __name__ == "__main__":
    unittest.main()
