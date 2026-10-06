"""Saved import formats: suggestions for unknown exports, preview rows, validation, and imports like the built-in tables."""
import unittest
from uuid import uuid4

from pydantic import ValidationError

from app.formats import ImportFormat, compile_format, inspect_rows, missing_columns, preview_rows, suggest, value_type
from app.ingest import rows_to_actions, table_rows_to_actions
from app.tables import detect

# A proxy export with column names no built-in table knows: the values tell what the columns are.
PROXY = [
    {"when": "2026-09-28 10:00:05", "client_addr": "198.51.100.9", "who": "eve@corp.example", "verb": "Download",
     "target_url": "https://files.example/payload.zip", "req_id": "r-1", "bytes": "5120"},
    {"when": "2026-09-28 10:02:00", "client_addr": "198.51.100.9", "who": "eve@corp.example", "verb": "Upload",
     "target_url": "https://files.example/drop", "req_id": "r-2", "bytes": "77"},
    {"when": "", "client_addr": "198.51.100.10", "who": "", "verb": "Download", "target_url": "", "req_id": "r-3", "bytes": "1"},
]

KEYVAULT = ImportFormat(name="Key Vault diagnostics", entities=[
    {"column": "CallerIPAddress", "kind": "IP", "role": "source"},
    {"column": "identity_claim_upn_s", "kind": "User", "role": "actor", "ids": [{"column": "identity_claim_oid_g", "type": "entra-object-id"}]},
    {"column": "Resource", "kind": "Key Vault", "role": "target"}],
    operation_column="OperationName", time="TimeGenerated", locator=["CorrelationId"], details=[{"column": "ResultSignature", "label": "result"}])
KV_ROWS = [{"TimeGenerated": "9/28/2026, 10:42:07.000 AM", "CallerIPAddress": "203.0.113.7", "identity_claim_upn_s": "J.Doe@corp.example",
            "identity_claim_oid_g": "11111111-2222-3333-4444-555555555555", "Resource": "KV-PROD-SECRETS", "OperationName": "SecretGet",
            "ResultSignature": "OK", "CorrelationId": "c-1"}]


class Suggestions(unittest.TestCase):
    def test_values_tell_what_unknown_columns_are(self):
        self.assertEqual(value_type(["198.51.100.9", "2001:db8::1"]), "ip")
        self.assertEqual(value_type(["2026-09-28 10:00:05", "9/28/2026, 10:42:07 AM"]), "time")
        self.assertEqual(value_type(["powershell.exe", "invoice.pdf"]), "file")
        self.assertEqual(value_type(["ws-0142.corp.example", "evil.example"]), "domain")
        self.assertEqual(value_type(["18842", "77"]), "number")
        self.assertEqual(value_type(["ab" * 32]), "sha256")
        columns = list(PROXY[0])
        format = suggest(columns, PROXY)
        kinds = {e["column"]: (e["kind"], e["role"]) for e in format["entities"]}
        self.assertEqual(kinds, {"client_addr": ("IP", "source"), "who": ("User", "actor"), "target_url": ("URL", "target")})
        self.assertEqual((format["time"], format["operation_column"], format["rows"]), ("when", "verb", "activity"))
        # The suggestion is a valid format once it has a name.
        ImportFormat.model_validate({**format, "name": "Proxy"})

    def test_classic_two_column_log_stays_a_relationship(self):
        rows = [{"IPAddress": "10.0.0.5", "FilePath": "repo/.env", "TimeGenerated": "2026-09-28T10:00:00Z"}]
        format = suggest(list(rows[0]), rows)
        self.assertEqual((format["rows"], format["operation"], [e["column"] for e in format["entities"]]), ("relationship", "accessed", ["IPAddress", "FilePath"]))
        self.assertEqual(inspect_rows(rows, "access.csv")["builtin"]["table"], "Log rows")

    def test_inspect_reports_columns_samples_and_builtin_tables(self):
        report = inspect_rows(PROXY, "proxy.csv")
        self.assertIsNone(report["builtin"])
        who = next(c for c in report["columns"] if c["name"] == "who")
        self.assertEqual((who["type"], who["filled"], who["of"], who["samples"]), ("email", 2, 3, ["eve@corp.example"]))
        self.assertEqual(len(report["sample"]), 3)
        builtin = inspect_rows([{"Timestamp": "2026-09-28T10:00:00Z", "DeviceId": "d1", "DeviceName": "ws", "ActionType": "ConnectionSuccess",
                                 "RemoteIP": "203.0.113.7", "RemotePort": "443", "RemoteUrl": "", "LocalIP": "10.0.0.5", "ReportId": "1"}])["builtin"]
        self.assertEqual(builtin["table"], "DeviceNetworkEvents")


class Formats(unittest.TestCase):
    def test_validation(self):
        with self.assertRaises(ValidationError):
            ImportFormat(name="One", entities=[{"column": "a", "kind": "IP", "role": "source"}])
        with self.assertRaises(ValidationError):
            ImportFormat(name="Three", rows="relationship", entities=[{"column": c, "kind": "IP"} for c in "abc"])
        with self.assertRaises(ValidationError):
            ImportFormat(name="Role", entities=[{"column": "a", "kind": "IP", "role": "boss"}, {"column": "b", "kind": "IP", "role": "target"}])
        # Fields a later version adds are ignored, not refused (formats are kept in browsers of different versions).
        ImportFormat.model_validate({"name": "Future", "last_used": "2026-10-06", "entities": [{"column": "a", "kind": "IP", "role": "source", "colour": "#fff"},
                                                                                                {"column": "b", "kind": "IP", "role": "target"}]})
        self.assertEqual(missing_columns(KEYVAULT, {"CallerIPAddress", "Resource"}),
                         ["identity_claim_upn_s", "identity_claim_oid_g", "OperationName", "TimeGenerated", "CorrelationId", "ResultSignature"])

    def test_preview_shows_what_the_import_will_create(self):
        row = preview_rows(KV_ROWS, KEYVAULT)[0]
        self.assertEqual(row["time"], "2026-09-28T10:42:07Z")
        self.assertEqual(row["operation"], "secret get")
        self.assertEqual(row["participants"], [{"role": "source", "kind": "IP", "name": "203.0.113.7"},
                                               {"role": "actor", "kind": "User", "name": "j.doe@corp.example"},
                                               {"role": "target", "kind": "Key Vault", "name": "KV-PROD-SECRETS"}])
        self.assertEqual((row["details"], row["locator"], row["skipped"]), (["result OK"], "Key Vault diagnostics CorrelationId=c-1", None))
        lonely = preview_rows([{**KV_ROWS[0], "CallerIPAddress": "", "identity_claim_upn_s": ""}], KEYVAULT)[0]
        self.assertEqual(lonely["skipped"], "fewer than two entities in this row")
        fixed = ImportFormat(name="Fixed", entities=KEYVAULT.entities, operation="read secret")
        self.assertEqual(preview_rows(KV_ROWS, fixed)[0]["operation"], "read secret", "a fixed operation, even a single word, is text, not a column")

    def test_saved_format_imports_like_a_builtin_table(self):
        board = str(uuid4())
        drafts, summary = table_rows_to_actions(board, KV_ROWS, compile_format(KEYVAULT), title="Key Vault diagnostics · kv.csv")
        identifiers = {(d["payload"]["scheme"], d["payload"]["namespace"]) for d in drafts if d["type"] == "identifier.add"}
        self.assertIn(("external_id", "entra-object-id"), identifiers, "the user is found again by a Sentinel import through the object ID")
        self.assertIn(("ip", ""), identifiers)
        evidence = next(d["payload"] for d in drafts if d["type"] == "assertion.add")
        self.assertEqual((evidence["valid_from"], evidence["locator"]), ("2026-09-28T10:42:07Z", "Key Vault diagnostics CorrelationId=c-1"))
        self.assertIn("result OK", evidence["observation"])
        self.assertEqual((summary["relations"], summary["evidence"], summary["time_field"]), (1, 1, "TimeGenerated"))
        # A SigninLogs export of the same user joins the same entity.
        signin = [{"TimeGenerated": "2026-09-28T10:40:01Z", "UserPrincipalName": "j.doe@corp.example", "UserId": "11111111-2222-3333-4444-555555555555",
                   "AppDisplayName": "Azure Portal", "AppId": "c44b4083-3bb0-49c1-b47d-974e53cbdf3c", "IPAddress": "203.0.113.7", "ResultType": "0",
                   "ConditionalAccessStatus": "success", "CorrelationId": "corr-1"}]
        user = next(d["payload"]["id"] for d in drafts if d["type"] == "entity.add" and d["payload"]["kind"] == "User")
        known = {("external_id", "entra-object-id", "11111111-2222-3333-4444-555555555555"): user}
        by_identifier = {("", s, n, v): owner for (s, n, v), owner in known.items()}
        signin_drafts, _ = table_rows_to_actions(board, signin, detect(set(signin[0])).mapping, title="SigninLogs",
                                                 existing_identifiers=by_identifier, existing_entities={("user", "j.doe@corp.example"): user})
        self.assertFalse(any(d["type"] == "entity.add" and d["payload"]["kind"] == "User" for d in signin_drafts))

    def test_relationship_format_uses_its_time_and_locator_columns(self):
        rows = [{"host": "build-01", "secret": "deploy-key", "seen": "28.09.2026 10:00:00", "line": "17"}]
        drafts, summary = rows_to_actions(str(uuid4()), rows, title="Inventory", subject_field="host", object_field="secret", predicate="stores",
                                          subject_kind="Device", object_kind="Secret", time_field="seen", locator_fields=("line",))
        evidence = next(d["payload"] for d in drafts if d["type"] == "assertion.add")
        self.assertEqual((evidence["valid_from"], evidence["locator"], summary["time_field"]), ("2026-09-28T10:00:00Z", "line=17", "seen"))
        inventory = ImportFormat(name="Inventory", rows="relationship", operation="stores", time="seen", locator=["line"],
                                 entities=[{"column": "host", "kind": "Device"}, {"column": "secret", "kind": "Secret"}])
        row = preview_rows(rows, inventory)[0]
        self.assertEqual((row["time"], row["operation"], [p["name"] for p in row["participants"]]), ("2026-09-28T10:00:00Z", "stores", ["build-01", "deploy-key"]))



class BoardKnowledge(unittest.TestCase):
    """Columns whose values the board already knows, e.g. object IDs a Sentinel import stored with users."""
    INDEX = {"entities": [
        {"id": "u1", "kind": "User", "name": "j.doe@corp.example", "identifiers": [
            {"scheme": "external_id", "namespace": "entra-object-id", "normalized_value": "11111111-2222-3333-4444-555555555555"},
            {"scheme": "email", "namespace": "", "normalized_value": "j.doe@corp.example"}]},
        {"id": "sp", "kind": "Service Principal", "name": "sp-deploy-prod", "identifiers": [
            {"scheme": "external_id", "namespace": "entra-app-id", "normalized_value": "c44b4083-3bb0-49c1-b47d-974e53cbdf3c"}]},
        {"id": "r1", "kind": "Repository", "name": "group/app", "identifiers": [
            {"scheme": "external_id", "namespace": "gitlab-project-id", "normalized_value": "4711"}]},
        {"id": "d1", "kind": "Device", "name": "build-01", "identifiers": []}]}

    def test_known_ids_and_names_become_their_entities(self):
        rows = [{"ts": "2026-09-28T10:00:00Z", "caller_oid": "11111111-2222-3333-4444-555555555555", "app": "C44B4083-3BB0-49C1-B47D-974E53CBDF3C",
                 "project": "4711", "host": "build-01", "op": "read"},
                {"ts": "2026-09-28T10:01:00Z", "caller_oid": "99999999-2222-3333-4444-555555555555", "app": "c44b4083-3bb0-49c1-b47d-974e53cbdf3c",
                 "project": "4711", "host": "build-01", "op": "write"}]
        report = inspect_rows(rows, "custom.csv", self.INDEX)
        known = {c["name"]: c["known"] for c in report["columns"] if c["known"]}
        self.assertEqual(known["caller_oid"], {"kind": "User", "id_type": "entra-object-id", "namespace": "", "matches": 1, "of": 2},
                         "one known GUID is enough: GUIDs are unique")
        self.assertEqual((known["app"]["kind"], known["app"]["id_type"]), ("Service Principal", "entra-app-id"), "case does not matter")
        self.assertEqual((known["project"]["kind"], known["project"]["id_type"], known["project"]["namespace"]), ("Repository", "other", "gitlab-project-id"))
        self.assertEqual((known["host"]["kind"], known["host"]["id_type"]), ("Device", None), "a known name: the type, no ID")
        entities = {e["column"]: e for e in report["suggestion"]["entities"]}
        self.assertEqual((entities["caller_oid"]["kind"], entities["caller_oid"]["ids"]), ("User", [{"column": "caller_oid", "type": "entra-object-id", "namespace": ""}]))
        self.assertEqual(entities["app"]["kind"], "Service Principal")
        self.assertEqual(entities["project"]["ids"], [{"column": "project", "type": "other", "namespace": "gitlab-project-id"}])
        # The import finds the entities by these IDs: no second user, the repository under its board ID namespace.
        fmt = ImportFormat.model_validate({**report["suggestion"], "name": "Custom"})
        mapping = compile_format(fmt)
        user = next(p for p in mapping.parts if p.fields == ("caller_oid",))
        self.assertEqual([(i.scheme, i.namespace) for i in user.ids], [("external_id", "entra-object-id")], "no e-mail identifier for an object ID column")
        self.assertEqual(report["board_names"], {"11111111-2222-3333-4444-555555555555": "j.doe@corp.example",
                                                 "c44b4083-3bb0-49c1-b47d-974e53cbdf3c": "sp-deploy-prod", "4711": "group/app"},
                         "the preview names known IDs as the board does")
        repo = next(p for p in mapping.parts if p.fields == ("project",))
        self.assertEqual([(i.scheme, i.namespace) for i in repo.ids], [("external_id", "gitlab-project-id")])

    def test_rare_name_matches_do_not_decide(self):
        rows = [{"who": n, "where": "203.0.113.7"} for n in ("build-01", "laptop-7", "laptop-8", "laptop-9")]
        report = inspect_rows(rows, "x.csv", self.INDEX)
        self.assertIsNone(next(c for c in report["columns"] if c["name"] == "who")["known"], "one of four names is chance, not a type")


if __name__ == "__main__":
    unittest.main()
