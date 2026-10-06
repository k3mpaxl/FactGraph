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

    def test_exports_in_local_time_are_refused(self):
        with self.assertRaisesRegex(ValueError, "local time"):
            clean_rows([{"TimeGenerated [Local]": "9/28/2026, 12:42:07 PM", "OperationName": "x"}])
        self.assertEqual(list(clean_rows([{"TimeGenerated [UTC]": "x"}])[0]), ["TimeGenerated"])

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

    def test_files_on_different_devices_or_folders_stay_apart(self):
        board, index = str(uuid4()), {"entities": [], "facts": [], "sources": []}
        row = lambda device, folder, report: {"Timestamp": "2026-09-28T10:00:00Z", "DeviceId": f"id-{device}", "DeviceName": device,  # noqa: E731
                                              "ActionType": "FileCreated", "FileName": ".env", "FolderPath": folder,
                                              "InitiatingProcessFileName": "git.exe", "InitiatingProcessFolderPath": "C:\\Program Files\\Git\\git.exe",
                                              "ReportId": report}
        rows = [row("ws-a", "C:\\repo-a\\.env", "1"), row("ws-b", "C:\\repo-b\\.env", "2")]
        detection, drafts, _ = run(board, rows, index)
        self.assertEqual(detection.table, "DeviceFileEvents")
        files = [d["payload"] for d in drafts if d["type"] == "entity.add" and d["payload"]["kind"] == "File"]
        self.assertEqual(len(files), 2, "two .env files on two devices are two entities")
        targets = {p["entity_id"] for d in drafts if d["type"] == "fact.add" for p in d["payload"]["participants"] if p["role"] == "target"}
        self.assertEqual(targets, {f["id"] for f in files})
        paths = {d["payload"]["normalized_value"] for d in drafts if d["type"] == "identifier.add" and d["payload"]["namespace"] == "device-path"}
        self.assertIn("ws-a|c:\\repo-a\\.env", paths)
        # git.exe without a hash: one entity per device too.
        self.assertEqual(sum(d["payload"]["name"] == "git.exe" for d in drafts if d["type"] == "entity.add"), 2)
        # The same file again (also a new row on the same device and path): no duplicate.
        _, again, _ = run(board, [row("ws-a", "C:\\Repo-A\\.env", "3")], index)
        self.assertFalse([d for d in again if d["type"] == "entity.add"])
        # The same hash on two devices is deliberately one binary.
        hashed = [{**row("ws-a", "C:\\x\\tool.exe", "4"), "FileName": "tool.exe", "SHA256": "e" * 64},
                  {**row("ws-b", "D:\\y\\tool.exe", "5"), "FileName": "tool.exe", "SHA256": "e" * 64}]
        _, drafts, _ = run(board, hashed, index)
        self.assertEqual(sum(d["payload"]["name"] == "tool.exe" for d in drafts if d["type"] == "entity.add"), 1)
        # First seen without a hash on ws-c, later with its hash on ws-c and on ws-d: still one entity.
        first = [{**row("ws-c", "C:\\z\\agent.exe", "6"), "FileName": "agent.exe"}]
        _, drafts, _ = run(board, first, index)
        agent = next(d["payload"]["id"] for d in drafts if d["type"] == "entity.add" and d["payload"]["name"] == "agent.exe")
        later = [{**row("ws-c", "C:\\z\\agent.exe", "7"), "FileName": "agent.exe", "SHA256": "f" * 64},
                 {**row("ws-d", "E:\\agent.exe", "8"), "FileName": "agent.exe", "SHA256": "f" * 64}]
        _, drafts, _ = run(board, later, index)
        self.assertFalse([d for d in drafts if d["type"] == "entity.add" and d["payload"]["name"] == "agent.exe"])
        self.assertEqual({p["entity_id"] for d in drafts if d["type"] == "fact.add" for p in d["payload"]["participants"] if p["role"] == "target"}, {agent})

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


class SentinelNestedTest(unittest.TestCase):
    """AzureActivity, service principal sign-ins and GitLab audit events with nested JSON columns (synthetic values)."""
    SP = "0b7f0c1e-1111-4222-8333-444444444444"
    APP = "5a5a5a5a-1111-4222-8333-555555555555"
    KEY = "45f3c2d1-1111-4222-8333-666666666666"

    def activity(self, status, operation="MICROSOFT.COGNITIVESERVICES/ACCOUNTS/DEPLOYMENTS/WRITE", event="e1"):
        return {"TimeGenerated [UTC]": "9/27/2026, 10:15:00.250 AM", "Caller": self.SP, "CallerIpAddress": "203.0.113.50", "OperationName": "",
                "OperationNameValue": operation, "ActivityStatusValue": status, "ResourceGroup": "rg-ai", "CorrelationId": "c1", "EventDataId": event,
                "_ResourceId": "/subscriptions/0/resourcegroups/rg-ai/providers/microsoft.cognitiveservices/accounts/ai-acc",
                "Claims": json.dumps({"appid": self.APP, "idtyp": "app", "http://schemas.microsoft.com/identity/claims/objectidentifier": self.SP}),
                "Authorization": json.dumps({"action": operation, "evidence": {"role": "Owner", "principalType": "ServicePrincipal"}}),
                "Properties": json.dumps({"statusMessage": {"error": {"code": "InvalidTemplate"}}} if status == "Failure" else {}),
                "Category": ""}

    def test_paths_in_json_columns(self):
        from app.tables import get
        row = {"Claims": json.dumps({"http://schemas.microsoft.com/identity/claims/objectidentifier": "abc"}), "LocationDetails": '{"countryOrRegion": "DE"}'}
        self.assertEqual(get(row, "Claims[http://schemas.microsoft.com/identity/claims/objectidentifier]"), "abc")
        self.assertEqual(get(row, "LocationDetails.CountryOrRegion"), "DE")

    def test_azure_activity_service_principal_and_operations(self):
        rows = clean_rows([self.activity("Start", event="e1"), self.activity("Success", event="e2"), self.activity("Failure", event="e3")])
        detection, drafts, _ = run(str(uuid4()), rows, {"entities": [], "facts": [], "sources": []})
        self.assertEqual(detection.table, "AzureActivity")
        sp = next(d["payload"] for d in drafts if d["type"] == "entity.add" and d["payload"]["kind"] == "Service Principal")
        ids = {(d["payload"]["namespace"], d["payload"]["normalized_value"]) for d in drafts if d["type"] == "identifier.add" and d["payload"]["entity_id"] == sp["id"]}
        self.assertEqual(ids, {("entra-object-id", self.SP), ("entra-app-id", self.APP)}, "object ID from Caller, app ID from the token claims")
        predicates = sorted(d["payload"]["predicate"] for d in drafts if d["type"] == "fact.add")
        self.assertEqual(predicates, ["write cognitiveservices/accounts/deployments", "write cognitiveservices/accounts/deployments (failed)"],
                         "Start and Success are one activity; the failure is its own")
        failed = next(d["payload"] for d in drafts if d["type"] == "assertion.add" and "Failure" in d["payload"]["observation"])
        self.assertIn("role Owner", failed["observation"])
        self.assertIn("error InvalidTemplate", failed["observation"])
        note = json.loads(failed["note"])
        self.assertEqual(note["Claims"]["appid"], self.APP, "nested JSON is stored as objects in the evidence note")
        self.assertNotIn("Category", note, "empty columns are left out")
        target = next(d["payload"] for d in drafts if d["type"] == "entity.add" and d["payload"]["name"] == "ai-acc")
        self.assertEqual(target["kind"], "Azure Resource")

    def test_service_principal_sign_ins_join_and_name_the_service_principal(self):
        board, index = str(uuid4()), {"entities": [], "facts": [], "sources": []}
        run(board, clean_rows([self.activity("Success")]), index)
        signin = {"TimeGenerated [UTC]": "9/27/2026, 10:00:00.000 AM", "ServicePrincipalName": "deploy-bot", "ServicePrincipalId": self.SP,
                  "AppId": self.APP, "ServicePrincipalCredentialKeyId": self.KEY, "ServicePrincipalCredentialThumbprint": "", "ClientCredentialType": "clientSecret",
                  "IPAddress": "203.0.113.50", "ResourceDisplayName": "Azure Resource Manager", "ResourceIdentity": "797f4846-ba00-4fd7-ba43-dac1f8f63013",
                  "ResourceServicePrincipalId": "9b9b9b9b-1111-4222-8333-777777777777", "ResultType": "0", "CorrelationId": "s1", "Id": "i1",
                  "AutonomousSystemNumber": "64500", "Location": "DE", "UserAgent": "python-requests/2.32",
                  "LocationDetails": json.dumps({"city": "Springfield", "state": "Testland", "countryOrRegion": "DE"}),
                  "NetworkLocationDetails": json.dumps([{"networkType": "namedNetwork", "networkNames": ["Office"]}])}
        detection, drafts, _ = run(board, clean_rows([signin]), index)
        self.assertEqual(detection.table, "AADServicePrincipalSignInLogs")
        # The service principal from AzureActivity (known only by its object ID) is the same one and gets its display name.
        renames = [d["payload"] for d in drafts if d["type"] == "entity.update"]
        self.assertEqual([r["name"] for r in renames], ["deploy-bot"])
        self.assertFalse([d for d in drafts if d["type"] == "entity.add" and d["payload"]["kind"] == "Service Principal"])
        new = {d["payload"]["kind"]: d["payload"]["name"] for d in drafts if d["type"] == "entity.add"}
        self.assertEqual(new["Credential"], f"clientSecret {self.KEY}")
        self.assertEqual(new["Location"], "DE")
        credential = next(d["payload"] for d in drafts if d["type"] == "identifier.add" and d["payload"]["namespace"] == "entra-credential-key-id")
        self.assertEqual(credential["normalized_value"], self.KEY)
        observation = next(d["payload"]["observation"] for d in drafts if d["type"] == "assertion.add")
        for part in ("tool clientSecret", "location Springfield, Testland", "ASN 64500", "named network Office", "user agent python-requests/2.32"):
            self.assertIn(part, observation)

    def test_gitlab_audit_events(self):
        base = {"author_id": "4711", "author_name": "release-bot", "entity_type": "Project", "target_type": "Project", "ip_address": "198.51.100.77",
                "created_at [UTC]": "9/27/2026, 10:15:00.250 AM", "TimeGenerated [UTC]": "9/27/2026, 10:15:00.250 AM"}
        rows = clean_rows([
            {**base, "id": "1", "entity_id": "101", "entity_path": "team/app", "event_type": "repository_file_accessed_api",
             "details": json.dumps({"event_name": "repository_file_accessed_api", "file_path": "config/secrets.yml", "ref": "main",
                                    "custom_message": "User accessed repository file 'config/secrets.yml' at ref 'main' via API"})},
            {**base, "id": "2", "entity_id": "102", "entity_path": "team/other", "event_type": "repository_file_accessed_api",
             "details": json.dumps({"event_name": "repository_file_accessed_api", "file_path": "config/secrets.yml", "ref": "main"})},
            {**base, "id": "3", "entity_id": "101", "entity_path": "team/app", "event_type": "repository_git_operation",
             "details": json.dumps({"custom_message": {"protocol": "ssh", "verb": "push", "gl_key_id": 555, "gl_key_type": "key"}})},
            {**base, "id": "4", "entity_id": "4711", "entity_path": "release-bot", "entity_type": "User", "event_type": "personal_access_token_used_from_unseen_ip",
             "details": json.dumps({"pat_id": 9001, "pat_name": "ci-token", "custom_message": "Personal access token used from a previously unseen IP address"})},
        ])
        detection, drafts, _ = run(str(uuid4()), rows, {"entities": [], "facts": [], "sources": []})
        self.assertEqual((detection.table, detection.product), ("GitLab audit events", "GitLab"))
        entities = [d["payload"] for d in drafts if d["type"] == "entity.add"]
        self.assertEqual(sorted(e["name"] for e in entities if e["kind"] == "Repository"), ["team/app", "team/other"])
        self.assertEqual(sum(e["name"] == "config/secrets.yml" for e in entities), 2, "the same file path in two repositories is two files")
        self.assertEqual(sorted(e["name"] for e in entities if e["kind"] == "Credential"), ["SSH key 555", "access token ci-token"])
        predicates = {d["payload"]["predicate"] for d in drafts if d["type"] == "fact.add"}
        self.assertEqual(predicates, {"repository file accessed api", "git push (ssh)", "personal access token used from unseen ip"})
        self.assertEqual(next(d["payload"]["valid_from"] for d in drafts if d["type"] == "assertion.add"), "2026-09-27T10:15:00.250000Z")


class LargeExportTest(unittest.TestCase):
    """A large export is kept in several sources, so no action outgrows the relay's 16 MiB WebSocket message limit."""

    def rows(self, count):
        return clean_rows([{"TimeGenerated [UTC]": "9/27/2026, 10:15:00.250 AM", "Caller": "0b7f0c1e-1111-4222-8333-444444444444",
                            "CallerIpAddress": "203.0.113.50", "OperationNameValue": "MICROSOFT.COGNITIVESERVICES/ACCOUNTS/WRITE",
                            "ActivityStatusValue": "Success", "ResourceGroup": "rg", "CorrelationId": f"c{i}", "EventDataId": f"e{i}",
                            "_ResourceId": f"/subscriptions/0/resourcegroups/rg/providers/microsoft.cognitiveservices/accounts/acc-{i % 7}",
                            "Properties": json.dumps({"padding": "x" * 400, "quote": 'a "quoted" value'})} for i in range(count)])

    def test_large_export_keeps_a_sample_in_the_source_and_every_row_with_its_evidence(self):
        from unittest import mock
        import app.ingest as ingest
        board, index, rows = str(uuid4()), {"entities": [], "facts": [], "sources": []}, self.rows(40)
        with mock.patch.object(ingest, "SOURCE_PART_BYTES", 5_000), mock.patch.object(ingest, "SOURCE_SAMPLE_BYTES", 3_000):
            _, drafts, summary = run(board, rows, index)
        sources = [d["payload"] for d in drafts if d["type"] == "source.add"]
        self.assertEqual((len(sources), summary["source_parts"]), (1, 1), "one source, not every row twice")
        sample = json.loads(sources[0]["excerpt"])
        self.assertEqual(sample, rows[:len(sample)])
        self.assertTrue(0 < len(sample) < 40 and len(sources[0]["excerpt"].encode()) <= 3_000)
        self.assertIn(f"first {len(sample)} of 40 rows", sources[0]["title"])
        evidence = [d["payload"] for d in drafts if d["type"] == "assertion.add"]
        self.assertEqual(len(evidence), 40)
        self.assertTrue(all(item["source_id"] == sources[0]["id"] for item in evidence))
        self.assertEqual(sorted(json.loads(item["note"])["CorrelationId"] for item in evidence), sorted(f"c{i}" for i in range(40)), "every row is kept with its evidence")
        # The same file again: nothing new.
        with mock.patch.object(ingest, "SOURCE_PART_BYTES", 5_000), mock.patch.object(ingest, "SOURCE_SAMPLE_BYTES", 3_000):
            _, again, _ = run(board, rows, {**index, "sources": [{"id": sources[0]["id"]}]})
        self.assertFalse([d for d in again if d["type"] == "source.add"])
        self.assertEqual({d["id"] for d in again if d["type"] == "assertion.add"}, {d["id"] for d in drafts if d["type"] == "assertion.add"})

    def test_an_export_imported_in_parts_before_keeps_its_parts(self):
        from unittest import mock
        import hashlib
        import app.ingest as ingest
        board, rows = str(uuid4()), self.rows(40)
        canonical = json.dumps(rows, sort_keys=True, ensure_ascii=False, default=str)
        digest = hashlib.sha256(("AzureActivity\n\nAzureActivity\n" + canonical).encode()).hexdigest()
        first_part = ingest._stable(board, "import", digest, "1")
        with mock.patch.object(ingest, "SOURCE_PART_BYTES", 5_000):
            _, drafts, summary = run(board, rows, {"entities": [], "facts": [], "sources": [{"id": first_part}]})
        evidence = [d["payload"] for d in drafts if d["type"] == "assertion.add"]
        self.assertGreater(summary["source_parts"], 3)
        self.assertIn(first_part, {item["source_id"] for item in evidence}, "evidence of the first rows points to the old part 1")

    def test_small_export_keeps_one_source_with_its_former_id(self):
        import hashlib
        from app.ingest import _stable
        board, rows = str(uuid4()), self.rows(3)
        _, drafts, summary = run(board, rows, {"entities": [], "facts": [], "sources": []})
        source = next(d["payload"] for d in drafts if d["type"] == "source.add")
        canonical = json.dumps(rows, sort_keys=True, ensure_ascii=False, default=str)
        digest = hashlib.sha256(("AzureActivity\n\nAzureActivity\n" + canonical).encode()).hexdigest()
        self.assertEqual(source["id"], _stable(board, "import", digest), "re-imports of files imported before the split are still recognised")
        self.assertEqual((source["title"], source["excerpt"], summary["source_parts"]), ("AzureActivity", canonical, 1))

    def test_a_single_oversized_row_is_rejected(self):
        from unittest import mock
        import app.ingest as ingest
        with mock.patch.object(ingest, "MAX_ROW_BYTES", 500), self.assertRaisesRegex(ValueError, "Row 1 is larger"):
            run(str(uuid4()), self.rows(2), {"entities": [], "facts": [], "sources": []})

    def test_a_repeated_row_is_one_piece_of_evidence(self):
        rows = self.rows(3)
        _, drafts, summary = run(str(uuid4()), rows + [dict(rows[1])], {"entities": [], "facts": [], "sources": []})
        ids = [d["payload"]["id"] for d in drafts if d["type"] == "assertion.add"]
        self.assertEqual((len(ids), len(set(ids)), summary["evidence"], summary["duplicates"]), (3, 3, 3, 1))
        # The preview names the column the event time comes from and how many rows have none.
        self.assertIn(summary["time_field"], ("TimeGenerated", "Timestamp"))
        self.assertEqual(summary["undated"], 0)


class CredentialChangesTest(unittest.TestCase):
    """The output of the rotation KQL: removed keys join the credential seen in sign-ins, new keys become credentials."""

    def test_removed_key_joins_the_signed_in_credential(self):
        board, index = str(uuid4()), {"entities": [], "facts": [], "sources": []}
        key, new_key, app = "45f3c2d1-1111-4222-8333-666666666666", "7c7c7c7c-1111-4222-8333-888888888888", "a1a1a1a1-1111-4222-8333-999999999999"
        run(board, clean_rows([{"TimeGenerated [UTC]": "9/27/2026, 10:00:00.000 AM", "ServicePrincipalName": "deploy-bot", "ServicePrincipalId": "0b7f0c1e-1111-4222-8333-444444444444",
            "AppId": "5a5a5a5a-1111-4222-8333-555555555555", "ServicePrincipalCredentialKeyId": key, "ClientCredentialType": "clientSecret", "IPAddress": "198.51.100.66",
            "ResourceDisplayName": "Azure Resource Manager", "ResultType": "0", "CorrelationId": "s1", "Id": "i1"}]), index)
        change = {"TimeGenerated [UTC]": "9/28/2026, 09:30:00.000 AM", "KeyType": "Password", "KeyName": "ci", "Application": "deploy-bot", "ApplicationObjectId": app,
                  "Actor": "admin@contoso.example", "ActorId": "c0c0c0c0-1111-4222-8333-000000000001", "ActorIp": "203.0.113.20",
                  "OperationName": "Update application – Certificates and secrets management ", "Result": "success", "CorrelationId": "c1"}
        detection, drafts, _ = run(board, clean_rows([{**change, "CredentialChange": "removed", "KeyId": key}, {**change, "CredentialChange": "added", "KeyId": new_key}]), index)
        self.assertEqual(detection.table, "Entra credential changes")
        credentials = [e for e in index["entities"] if e["kind"] == "Credential"]
        self.assertEqual(sorted(e["name"] for e in credentials), [f"clientSecret {key}", f"clientSecret {new_key}"], "the removed key is the one from the sign-in")
        principals = [e for e in index["entities"] if e["kind"] == "Service Principal"]
        self.assertEqual(len(principals), 1, "the application joins the service principal of the same name")
        self.assertIn(("entra-application-object-id", app), {(i["namespace"], i["normalized_value"]) for i in principals[0]["identifiers"]})
        predicates = sorted(d["payload"]["predicate"] for d in drafts if d["type"] == "fact.add")
        self.assertEqual(predicates, ["credential added", "credential removed"])
        removed = next(d["payload"] for d in drafts if d["type"] == "fact.add" and d["payload"]["predicate"] == "credential removed")
        roles = {p["role"] for p in removed["participants"]}
        self.assertEqual(roles, {"actor", "source", "target"})
