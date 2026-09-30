import unittest
from uuid import uuid4

from app.ingest import rows_to_actions


class IngestTest(unittest.TestCase):
    def test_kql_rows_create_deduplicated_graph_with_evidence(self):
        board = str(uuid4())
        rows = [
            {"IPAddress": "10.0.0.1", "FilePath": "repo/.env", "TimeGenerated": "2026-09-28T10:00:00Z"},
            {"IPAddress": "10.0.0.1", "FilePath": "repo/.env", "TimeGenerated": "2026-09-28T10:01:00Z"},
        ]
        first, summary = rows_to_actions(board, rows, title="Access Logs", query="AccessLogs | project IPAddress, FilePath")
        second, _ = rows_to_actions(board, rows, title="Access Logs", query="AccessLogs | project IPAddress, FilePath")
        self.assertEqual([item["id"] for item in first], [item["id"] for item in second])
        self.assertEqual(summary["entities"], 2)
        self.assertEqual(summary["relations"], 1)
        self.assertEqual(summary["evidence"], 2)
        self.assertEqual(sum(item["type"] == "assertion.add" for item in first), 2)
        self.assertIn("AccessLogs", first[0]["payload"]["query"])
        evidence = [item["payload"] for item in first if item["type"] == "assertion.add"]
        self.assertEqual([item["valid_from"] for item in evidence], [row["TimeGenerated"] for row in rows])
        self.assertNotEqual(evidence[0]["created_at"], evidence[0]["valid_from"])

    def test_evidence_period_and_missing_time(self):
        rows = [{"ip": "a", "target": "b", "StartTime": "2026-01-01T10:00:00Z",
                 "EndTime": "2026-01-01T11:00:00Z"}, {"ip": "a", "target": "b"}]
        drafts, _ = rows_to_actions(str(uuid4()), rows, title="Periods")
        evidence = [d["payload"] for d in drafts if d["type"] == "assertion.add"]
        self.assertEqual(evidence[0]["valid_to"], rows[0]["EndTime"])
        self.assertIsNone(evidence[1]["valid_from"])

    def test_import_reuses_existing_manual_entity_and_relation(self):
        board, ip_id, file_id, fact_id = (str(uuid4()) for _ in range(4))
        drafts, _ = rows_to_actions(board, [{"IPAddress": "10.0.0.8", "FilePath": "repo/.env"}],
            title="Access Logs", existing_entities={("ip", "10.0.0.8"): ip_id,
            ("datei", "repo/.env"): file_id},
            existing_facts={(ip_id, "accessed", file_id): fact_id})
        self.assertEqual([item["type"] for item in drafts], ["source.add", "assertion.add"])
        self.assertEqual(drafts[1]["payload"]["fact_id"], fact_id)

    def test_operation_column_creates_distinct_relations(self):
        rows = [{"source_ip": "10.0.0.8", "target": "repo/.env", "operation": "read"},
                {"source_ip": "10.0.0.8", "target": "repo/.env", "operation": "write"}]
        drafts, summary = rows_to_actions(str(uuid4()), rows, title="Audit",
            predicate_field="operation")
        self.assertEqual(summary["relations"], 2)
        self.assertEqual({item["payload"]["predicate"] for item in drafts
                          if item["type"] == "fact.add"}, {"read", "write"})


if __name__ == "__main__":
    unittest.main()


class ActivityIngestTest(unittest.TestCase):
    ROLES = [{"field": "CallerIPAddress", "role": "source", "kind": "IP"},
             {"field": "AppId", "role": "identity", "kind": "Service Principal"},
             {"field": "Resource", "role": "target", "kind": "Key Vault"}]

    def test_rows_with_same_participants_share_one_activity_with_row_evidence(self):
        from app.ingest import activity_rows_to_actions
        board = str(uuid4())
        rows = [{"CallerIPAddress": "1.2.3.4", "AppId": "sp-b", "Resource": "kv-c", "OperationName": "SecretList", "TimeGenerated": "2026-09-28T10:00:00Z"},
                {"CallerIPAddress": "1.2.3.4", "AppId": "sp-b", "Resource": "kv-c", "OperationName": "SecretList", "TimeGenerated": "2026-09-28T10:05:00Z"},
                {"CallerIPAddress": "1.2.3.4", "AppId": "sp-b", "Resource": "kv-c", "OperationName": "SecretGet", "TimeGenerated": "2026-09-28T10:06:00Z"},
                {"CallerIPAddress": "", "AppId": "", "Resource": "kv-c", "OperationName": "SecretGet"}]
        drafts, summary = activity_rows_to_actions(board, rows, title="KV audit", roles=self.ROLES, operation_field="OperationName")
        again, _ = activity_rows_to_actions(board, rows, title="KV audit", roles=self.ROLES, operation_field="OperationName")
        self.assertEqual([d["id"] for d in drafts], [d["id"] for d in again])
        self.assertEqual(summary["activities"], 2)
        self.assertEqual(summary["entities"], 3)
        self.assertEqual(summary["evidence"], 3)
        self.assertEqual(summary["skipped"], 1)
        activity = next(d["payload"] for d in drafts if d["type"] == "fact.add")
        self.assertEqual({p["role"] for p in activity["participants"]}, {"source", "identity", "target"})
        evidence = [d["payload"] for d in drafts if d["type"] == "assertion.add"]
        self.assertEqual(evidence[0]["valid_from"], "2026-09-28T10:00:00Z")

    def test_missing_role_column_is_reported(self):
        from app.ingest import activity_rows_to_actions
        with self.assertRaisesRegex(ValueError, "fehlt"):
            activity_rows_to_actions(str(uuid4()), [{"a": 1}], title="x", roles=self.ROLES)
