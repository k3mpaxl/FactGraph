"""Defender XDR and Sentinel exports: table recognition, column mapping, identifiers across imports."""
import csv
import io
import json
import unittest
from uuid import uuid4

from app.ingest import identifier_key, parse_rows, table_rows_to_actions
from app.tables import clean_rows, detect, parse_time, schemas


def csv_bytes(rows: list[dict]) -> bytes:
    out = io.StringIO()
    writer = csv.DictWriter(out, fieldnames=list(rows[0]))
    writer.writeheader()
    writer.writerows(rows)
    return ("﻿" + out.getvalue()).encode()


NETWORK = [{
    "Timestamp": "2026-09-28T10:42:07.1234567Z", "DeviceId": "a1b2c3d4e5f6", "DeviceName": "WS-0142.corp.example",
    "ActionType": "ConnectionSuccess", "RemoteIP": "203.0.113.7", "RemotePort": "443", "RemoteUrl": "evil.example",
    "LocalIP": "10.0.0.5", "LocalPort": "51234", "Protocol": "Tcp", "InitiatingProcessFileName": "powershell.exe",
    "InitiatingProcessSHA1": "AB" * 20, "InitiatingProcessAccountName": "jdoe", "InitiatingProcessAccountDomain": "corp",
    "InitiatingProcessAccountUpn": "J.Doe@corp.example", "InitiatingProcessAccountObjectId": "11111111-2222-3333-4444-555555555555",
    "ReportId": "18842", "AppGuardContainerId": ""}]

# Log Analytics "Export to CSV": " [UTC]" on datetime headers, US date format, dynamic columns as JSON text.
SIGNIN = [{
    "TimeGenerated [UTC]": "9/28/2026, 10:40:01.512 AM", "UserPrincipalName": "j.doe@corp.example",
    "UserId": "11111111-2222-3333-4444-555555555555", "AppDisplayName": "Azure Portal", "AppId": "c44b4083-3bb0-49c1-b47d-974e53cbdf3c",
    "IPAddress": "203.0.113.7", "ResultType": "0", "ConditionalAccessStatus": "success", "CorrelationId": "corr-1",
    "DeviceDetail": json.dumps({"deviceId": "dev-guid-1", "displayName": "WS-0142", "operatingSystem": "Windows 11"})},
    {"TimeGenerated [UTC]": "9/28/2026, 10:41:12.000 AM", "UserPrincipalName": "j.doe@corp.example",
     "UserId": "11111111-2222-3333-4444-555555555555", "AppDisplayName": "Azure Portal", "AppId": "c44b4083-3bb0-49c1-b47d-974e53cbdf3c",
     "IPAddress": "198.51.100.9", "ResultType": "50126", "ConditionalAccessStatus": "notApplied", "CorrelationId": "corr-2", "DeviceDetail": "{}"}]


def apply(board: str, drafts: list[dict], index: dict) -> None:
    """Update a minimal stand-in for the browser's index with what an import created."""
    entities = {e["id"]: e for e in index["entities"]}
    for draft in drafts:
        p = draft["payload"]
        if draft["type"] == "entity.add":
            entities[p["id"]] = {"id": p["id"], "kind": p["kind"], "name": p["name"], "identifiers": []}
        elif draft["type"] == "identifier.add":
            entities[p["entity_id"]]["identifiers"].append({"scheme": p["scheme"], "namespace": p["namespace"], "normalized_value": p["normalized_value"]})
        elif draft["type"] == "fact.add":
            index["facts"].append({"id": p["id"]})
        elif draft["type"] == "source.add":
            index["sources"].append({"id": p["id"]})
    index["entities"] = list(entities.values())


def run(board: str, rows: list[dict], index: dict):
    detection = detect(set().union(*(r.keys() for r in rows)))
    by_name = {(e["kind"].casefold(), e["name"].casefold()): e["id"] for e in index["entities"]}
    by_identifier, owned = {}, set()
    for e in index["entities"]:
        for i in e["identifiers"]:
            key = identifier_key(e["kind"], i["scheme"], i["namespace"], i["normalized_value"])
            by_identifier.setdefault(key, e["id"])
            owned.add((e["id"], *key[1:]))
    drafts, summary = table_rows_to_actions(board, rows, detection.mapping, title=detection.table, existing_entities=by_name,
        existing_identifiers=by_identifier, known_identifiers=owned, existing_facts={f["id"] for f in index["facts"]},
        existing_sources={s["id"] for s in index["sources"]})
    apply(board, drafts, index)
    return detection, drafts, summary


class TablesTest(unittest.TestCase):
    def test_schemas_come_from_the_docs(self):
        tables = schemas()["tables"]
        self.assertGreater(len(tables), 50)
        self.assertEqual(tables["DeviceNetworkEvents"]["columns"]["RemotePort"], "int")
        self.assertIn("SrcIpAddr", schemas()["asim"]["network"]["columns"])

    def test_times_from_portal_exports(self):
        self.assertEqual(parse_time("2026-09-28T10:42:07.1234567Z"), "2026-09-28T10:42:07.123456Z")
        self.assertEqual(parse_time("9/28/2026, 10:42:07.512 AM"), "2026-09-28T10:42:07.512000Z")
        self.assertEqual(parse_time("9/28/2026, 1:02:03 PM"), "2026-09-28T13:02:03Z")
        self.assertEqual(parse_time("2026-09-28 10:42:07"), "2026-09-28T10:42:07Z")
        self.assertIsNone(parse_time("yesterday"))

    def test_xdr_export_is_recognised_and_mapped(self):
        rows = clean_rows(parse_rows(csv_bytes(NETWORK), "network.csv"))
        detection = detect(set(rows[0]))
        self.assertEqual((detection.table, detection.product, detection.confident), ("DeviceNetworkEvents", "Defender XDR", True))
        self.assertGreaterEqual(detection.known_columns, 17)
        _, drafts, summary = run(str(uuid4()), rows, {"entities": [], "facts": [], "sources": []})
        activity = next(d["payload"] for d in drafts if d["type"] == "fact.add")
        self.assertEqual(activity["predicate"], "connection success")
        names = {d["payload"]["name"]: d["payload"]["kind"] for d in drafts if d["type"] == "entity.add"}
        self.assertEqual(names, {"ws-0142.corp.example": "Device", "j.doe@corp.example": "User", "powershell.exe": "Process",
                                 "203.0.113.7": "IP", "evil.example": "Domain"})
        evidence = next(d["payload"] for d in drafts if d["type"] == "assertion.add")
        self.assertEqual(evidence["valid_from"], "2026-09-28T10:42:07.123456Z")
        self.assertEqual(evidence["locator"], "DeviceNetworkEvents ReportId=18842 DeviceId=a1b2c3d4e5f6")
        self.assertIn("source ws-0142.corp.example", evidence["observation"])
        idents = {(d["payload"]["namespace"] or d["payload"]["scheme"], d["payload"]["normalized_value"]) for d in drafts if d["type"] == "identifier.add"}
        self.assertIn(("mde-device-id", "a1b2c3d4e5f6"), idents)
        self.assertIn(("sha1", "ab" * 20), idents)
        self.assertIn(("entra-object-id", "11111111-2222-3333-4444-555555555555"), idents)
        self.assertEqual(summary["skipped"], 0)

    def test_sentinel_export_joins_the_same_user_and_ip(self):
        board, index = str(uuid4()), {"entities": [], "facts": [], "sources": []}
        run(board, clean_rows(parse_rows(csv_bytes(NETWORK), "network.csv")), index)
        before = len(index["entities"])
        rows = clean_rows(parse_rows(csv_bytes(SIGNIN), "signins.csv"))
        detection, drafts, summary = run(board, rows, index)
        self.assertEqual((detection.table, detection.product), ("SigninLogs", "Sentinel"))
        # j.doe (by Entra object ID) and 203.0.113.7 already exist; new are the app, the second IP and the sign-in device.
        new = sorted(d["payload"]["name"] for d in drafts if d["type"] == "entity.add")
        self.assertEqual(new, ["198.51.100.9", "Azure Portal", "ws-0142"])
        self.assertEqual(len(index["entities"]), before + 3)
        predicates = sorted(d["payload"]["predicate"] for d in drafts if d["type"] == "fact.add")
        self.assertEqual(predicates, ["sign-in failed (50126)", "signed in"])
        times = [d["payload"]["valid_from"] for d in drafts if d["type"] == "assertion.add"]
        self.assertEqual(times, ["2026-09-28T10:40:01.512000Z", "2026-09-28T10:41:12Z"])
        # Importing the same file again creates nothing new.
        _, again, _ = run(board, rows, index)
        self.assertFalse([d for d in again if d["type"] in ("entity.add", "fact.add", "identifier.add", "source.add")])

    def test_device_id_joins_differently_named_devices(self):
        board, index = str(uuid4()), {"entities": [], "facts": [], "sources": []}
        run(board, NETWORK, index)
        logon = [{"Timestamp": "2026-09-28T11:00:00Z", "DeviceId": "A1B2C3D4E5F6", "DeviceName": "ws-0142", "ActionType": "LogonSuccess",
                  "LogonType": "RemoteInteractive", "AccountName": "adm-jdoe", "AccountDomain": "corp", "AccountSid": "S-1-5-21-1",
                  "RemoteIP": "203.0.113.7", "ReportId": "7"}]
        detection, drafts, _ = run(board, logon, index)
        self.assertEqual(detection.table, "DeviceLogonEvents")
        self.assertEqual(sorted(d["payload"]["name"] for d in drafts if d["type"] == "entity.add"), ["corp\\adm-jdoe"])
        self.assertEqual(next(d["payload"]["predicate"] for d in drafts if d["type"] == "fact.add"), "logon success (RemoteInteractive)")

    def test_same_name_with_a_different_id_is_another_entity(self):
        board, index = str(uuid4()), {"entities": [], "facts": [], "sources": []}
        run(board, NETWORK, index)
        other = [{**NETWORK[0], "DeviceId": "ffff0000", "ReportId": "99", "InitiatingProcessSHA1": "cd" * 20}]
        _, drafts, _ = run(board, other, index)
        names = sorted(d["payload"]["name"] for d in drafts if d["type"] == "entity.add")
        # Another DeviceId and another SHA-1 under the same names: two new entities, not a merge.
        self.assertEqual(names, ["powershell.exe", "ws-0142.corp.example"])
        kinds = detect({"TimeGenerated", "Caller", "OperationNameValue", "ResourceGroup", "CallerIpAddress", "_ResourceId"})
        from app.tables import participants_of
        row = {"Caller": "a@b.c", "OperationNameValue": "x", "ResourceGroup": "rg", "CallerIpAddress": "1.2.3.4",
               "_ResourceId": "/subscriptions/0/resourceGroups/rg/providers/Microsoft.KeyVault/vaults/kv-prod"}
        target = next(p for p in participants_of(kinds.mapping, row) if p["role"] == "target")
        self.assertEqual((target["name"], target["kind"]), ("kv-prod", "Key Vault"))

    def test_asim_and_heuristics(self):
        asim = detect({"TimeGenerated", "EventType", "EventResult", "EventSchema", "SrcIpAddr", "TargetUsername", "TargetAppName", "EventProduct"})
        self.assertEqual(asim.product, "Sentinel ASIM")
        self.assertTrue(asim.table.startswith("ASIM"))
        # A documented table without a curated mapping gets the heuristic and is still imported automatically.
        info = detect({"Timestamp", "DeviceId", "DeviceName", "ClientVersion", "PublicIP", "OSPlatform", "OSBuild", "IsAzureADJoined", "LoggedOnUsers", "ReportId"})
        self.assertEqual(info.table, "DeviceInfo")
        # Unknown columns: no automatic import, but a suggestion for the dialog.
        unknown = detect({"src", "dst", "when"})
        self.assertFalse(unknown.confident)
        guess = detect({"ClientIP", "UserPrincipalName", "Operation", "Workload"})
        self.assertFalse(guess.confident)
        self.assertEqual([p.role for p in guess.mapping.parts], ["actor", "source"])

    def test_json_exports_and_nested_columns(self):
        rows = parse_rows(json.dumps([{**SIGNIN[0], "TimeGenerated": "2026-09-28T10:40:01Z"}]).encode(), "export.json")
        rows = clean_rows(rows)
        detection, drafts, _ = run(str(uuid4()), rows, {"entities": [], "facts": [], "sources": []})
        device = next(d["payload"] for d in drafts if d["type"] == "entity.add" and d["payload"]["kind"] == "Device")
        self.assertEqual(device["name"], "ws-0142")
        ids = [d["payload"] for d in drafts if d["type"] == "identifier.add" and d["payload"]["entity_id"] == device["id"]]
        self.assertEqual({(i["namespace"], i["normalized_value"]) for i in ids}, {("entra-device-id", "dev-guid-1")})


if __name__ == "__main__":
    unittest.main()


class TableEndpointTest(unittest.TestCase):
    """The REST/MCP endpoint goes through the browser for the index and the write; a stand-in answers here."""

    def test_rest_import_detects_and_falls_back(self):
        import asyncio
        from app import main

        board = str(uuid4())
        applied: list[dict] = []

        async def browser_command(board_id, operation, **values):
            if operation == "index":
                return {"index": {"entities": [], "facts": [], "sources": []}}
            applied.extend(values["drafts"])
            return {"accepted": len(values["drafts"])}

        original = main.browser_command
        main.browser_command = browser_command
        try:
            result = asyncio.run(main.import_table_export(board, main.TableRowsInput(rows=SIGNIN, dry_run=False)))
            self.assertEqual((result["table"], result["product"]), ("SigninLogs", "Sentinel"))
            self.assertEqual(result["title"], "SigninLogs (Sentinel)")
            self.assertEqual(result["accepted_actions"], len(applied))
            # Classic two-column logs still import as relationships.
            legacy = asyncio.run(main.import_table(board, [{"IPAddress": "10.0.0.1", "FilePath": "repo/.env"}]))
            self.assertEqual((legacy["table"], legacy["product"]), ("Log rows", "IPAddress → FilePath"))
            # Unknown columns: 422 with a suggestion for the dialog.
            with self.assertRaises(main.HTTPException) as caught:
                asyncio.run(main.import_table(board, [{"ClientIP": "198.51.100.9", "UserPrincipalName": "eve@corp.example", "Operation": "FileDownloaded"}]))
            self.assertEqual(caught.exception.status_code, 422)
            self.assertTrue(caught.exception.detail["needs_mapping"])
            self.assertEqual(caught.exception.detail["suggestion"]["operation_field"], "Operation")
        finally:
            main.browser_command = original
