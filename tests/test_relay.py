import asyncio
import json
import socket
import subprocess
import sys
import time
import unittest
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from uuid import uuid4

import websockets
from fastmcp import Client
from fastmcp.client.transports import StreamableHttpTransport


async def receive(websocket):
    return json.loads(await asyncio.wait_for(websocket.recv(), timeout=2))


class join:
    """Open a relay connection the way the browser does: identity and token in the first message, not the URL."""
    def __init__(self, url, actor, name, token=None, **options):
        self.connection = websockets.connect(url, **options)
        self.hello = {"type": "hello", "actor": actor, "name": name, **({"token": token} if token else {})}

    async def __aenter__(self):
        self.websocket = await self.connection.__aenter__()
        await self.websocket.send(json.dumps(self.hello))
        return self.websocket

    async def __aexit__(self, *exc):
        return await self.connection.__aexit__(*exc)


class RelayTest(unittest.IsolatedAsyncioTestCase):
    @classmethod
    def setUpClass(cls):
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            cls.port = sock.getsockname()[1]
        cls.process = subprocess.Popen(
            [sys.executable, "-m", "uvicorn", "app.main:app", "--host", "127.0.0.1",
             "--port", str(cls.port), "--log-level", "error"],
            cwd=Path(__file__).resolve().parents[1], stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        for _ in range(100):
            try:
                with urlopen(f"http://127.0.0.1:{cls.port}/api/health", timeout=0.1) as response:
                    if json.load(response)["storage"] == "browser":
                        return
            except Exception:
                time.sleep(0.05)
        cls.process.terminate()
        raise RuntimeError("Test relay could not be started")

    @classmethod
    def tearDownClass(cls):
        cls.process.terminate()
        cls.process.wait(timeout=3)

    async def test_join_history_and_departure(self):
        board, first, second = str(uuid4()), str(uuid4()), str(uuid4())
        base = f"ws://127.0.0.1:{self.port}/ws/boards/{board}"
        async with join(base, first, "Alex") as a:
            self.assertEqual(await receive(a), {"type": "welcome", "peers": []})
            async with join(base, second, "Sam") as b:
                self.assertEqual((await receive(b))["peers"], [{"id": first, "name": "Alex"}])
                self.assertEqual((await receive(a))["type"], "peer-joined")
                await b.send(json.dumps({"type": "sync-request"}))
                self.assertEqual(await receive(a), {"type": "sync-request", "from": second})
                action = {"id": str(uuid4()), "clock": 1, "type": "entity.add", "payload": {"id": str(uuid4())}}
                await a.send(json.dumps({"type": "actions", "actions": [action], "target": second}))
                self.assertEqual((await receive(b))["actions"], [action])
            self.assertEqual(await receive(a), {"type": "peer-left", "id": second})

    async def test_large_batches_arrive_gzip_compressed(self):
        """A batch far above the 16 MiB message limit gets through compressed, the way the browser sends it."""
        import gzip
        board, first, second = str(uuid4()), str(uuid4()), str(uuid4())
        base = f"ws://127.0.0.1:{self.port}/ws/boards/{board}"
        async with join(base, first, "Alex") as a, join(base, second, "Sam", max_size=None) as b:
            await receive(a); await receive(b); await receive(a)
            action = {"id": str(uuid4()), "clock": 1, "type": "source.add", "payload": {"id": str(uuid4()), "excerpt": "row,value\n" * 2_000_000}}
            packed = gzip.compress(json.dumps({"type": "actions", "actions": [action]}).encode())
            self.assertGreater(len(json.dumps(action)), 18 * 1024 * 1024)
            self.assertLess(len(packed), 1024 * 1024)
            await a.send(packed)
            received = json.loads(await asyncio.wait_for(b.recv(), timeout=10))
            self.assertEqual(received["actions"][0]["payload"]["excerpt"], action["payload"]["excerpt"])
            # The browser's own format: a small header the relay reads, the compressed message forwarded as it is.
            header = json.dumps({"type": "actions", "deferRender": False}).encode()
            frame = b"FGZ1" + len(header).to_bytes(4, "big") + header + packed
            await a.send(frame)
            forwarded = await asyncio.wait_for(b.recv(), timeout=10)
            self.assertEqual(forwarded, frame, "forwarded unchanged, still compressed")
            self.assertEqual(json.loads(gzip.decompress(forwarded[8 + len(header):]))["actions"][0]["id"], action["id"])
            await a.send(b"FGZ1" + (10**6).to_bytes(4, "big") + b"{}")
            await a.send(b"not gzip")
            await a.send(json.dumps({"type": "sync-request"}))
            self.assertEqual((await receive(b))["type"], "sync-request", "an unreadable frame is skipped, the connection stays")

    async def test_boards_are_isolated(self):
        first, second = str(uuid4()), str(uuid4())
        async with join(f"ws://127.0.0.1:{self.port}/ws/boards/{first}", str(uuid4()), "A") as a:
            await receive(a)
            async with join(f"ws://127.0.0.1:{self.port}/ws/boards/{second}", str(uuid4()), "B") as b:
                self.assertEqual((await receive(b))["peers"], [])

    async def test_rest_write_requires_browser_ack(self):
        board, actor = str(uuid4()), str(uuid4())
        url = f"http://127.0.0.1:{self.port}/api/boards/{board.upper()}/entities"

        def post(token=None):
            headers = {"Content-Type": "application/json"}
            if token:
                headers["X-FactGraph-Token"] = token
            request = Request(url, json.dumps({"name": "10.1.2.3", "kind": "IP"}).encode(),
                              headers, method="POST")
            with urlopen(request, timeout=3) as response:
                return json.load(response)

        with self.assertRaises(HTTPError) as caught:
            await asyncio.to_thread(post)
        self.assertEqual(caught.exception.code, 401)
        caught.exception.close()

        token = "test-session-token"
        async with join(f"ws://127.0.0.1:{self.port}/ws/boards/{board}", actor, "Writer", token) as websocket:
            await receive(websocket)
            request_task = asyncio.create_task(asyncio.to_thread(post, token))
            command = await receive(websocket)
            self.assertEqual(command["type"], "api-command")
            self.assertEqual(command["operation"], "apply")
            self.assertEqual(command["boardId"], board)
            self.assertEqual(command["drafts"][0]["payload"]["name"], "10.1.2.3")
            self.assertEqual(command["drafts"][0]["author"], "REST")
            self.assertFalse(request_task.done())
            await websocket.send(json.dumps({"type": "api-result", "requestId": command["requestId"],
                                             "ok": True, "accepted": 1}))
            self.assertEqual((await request_task)["accepted_actions"], 1)

    async def test_mcp_header_token_reads_and_writes_board(self):
        board, actor, token = str(uuid4()), str(uuid4()), "b" * 64
        async with join(f"ws://127.0.0.1:{self.port}/ws/boards/{board}", actor, "MCP", token) as websocket:
            await receive(websocket)
            transport = StreamableHttpTransport(
                f"http://127.0.0.1:{self.port}/mcp/",
                headers={"X-FactGraph-Token": token},
            )
            async with Client(transport) as client:
                # The token in the header names the board: agents pass no board_id (the agent tools do not even show it).
                tools = {tool.name: tool for tool in await client.list_tools()}
                self.assertNotIn("board_id", tools["get_graph"].input_schema["properties"])
                graph_task = asyncio.create_task(client.call_tool("get_graph", {}))
                command = await receive(websocket)
                self.assertEqual(command["operation"], "snapshot")
                await websocket.send(json.dumps({
                    "type": "api-result", "requestId": command["requestId"], "ok": True,
                    "graph": {"board_id": board, "name": "MCP", "entities": [],
                              "facts": [], "sources": [], "action_count": 0},
                }))
                graph = await graph_task
                self.assertEqual(graph.data["board_id"], board)

                # A board_id passed anyway (older prompts) is still accepted.
                entity_task = asyncio.create_task(client.call_tool("create_entity", {
                    "board_id": board, "body": {"name": "MCP entity", "kind": "Test"},
                }))
                command = await receive(websocket)
                self.assertEqual(command["operation"], "apply")
                self.assertEqual(command["drafts"][0]["author"], "MCP")
                await websocket.send(json.dumps({
                    "type": "api-result", "requestId": command["requestId"], "ok": True,
                    "accepted": 1,
                }))
                result = await entity_task
                self.assertEqual(result.data["accepted_actions"], 1)

                deleted_id = str(uuid4())
                delete_task = asyncio.create_task(client.call_tool("delete_entity", {
                    "board_id": board, "entity_id": deleted_id,
                }))
                command = await receive(websocket)
                self.assertEqual(command["operation"], "index")
                await websocket.send(json.dumps({
                    "type": "api-result", "requestId": command["requestId"], "ok": True,
                    "index": {"entities": [{"id": deleted_id, "name": "Delete me", "kind": "Test"}],
                              "facts": [], "sources": []},
                }))
                command = await receive(websocket)
                self.assertEqual(command["operation"], "apply")
                self.assertEqual(command["drafts"][0]["type"], "entity.delete")
                self.assertEqual(command["drafts"][0]["author"], "MCP")
                await websocket.send(json.dumps({
                    "type": "api-result", "requestId": command["requestId"], "ok": True,
                    "accepted": 1,
                }))
                self.assertEqual((await delete_task).data["accepted_actions"], 1)

            # A token whose browser tab is not open names no board: a clear answer instead of a question about IDs.
            stranger = StreamableHttpTransport(f"http://127.0.0.1:{self.port}/mcp/", headers={"X-FactGraph-Token": "z" * 64})
            async with Client(stranger) as client:
                result = await client.call_tool("get_graph", {}, raise_on_error=False)
                self.assertTrue(result.is_error)
                self.assertIn("No open board for this board token", result.content[0].text)

    async def test_rest_patch_evidence_reaches_the_right_board(self):
        board, actor, token = str(uuid4()), str(uuid4()), "c" * 64
        relation_id, evidence_id = str(uuid4()), str(uuid4())
        url = (f"http://127.0.0.1:{self.port}/api/boards/{board}/relations/"
               f"{relation_id}/evidence/{evidence_id}")

        def patch():
            request = Request(url, json.dumps({"note": "edited", "confidence": 0.75}).encode(),
                              {"Content-Type": "application/json", "X-FactGraph-Token": token},
                              method="PATCH")
            with urlopen(request, timeout=3) as response:
                return json.load(response)

        async with join(f"ws://127.0.0.1:{self.port}/ws/boards/{board}", actor, "REST", token) as websocket:
            await receive(websocket)
            request_task = asyncio.create_task(asyncio.to_thread(patch))
            command = await receive(websocket)
            # Only the evidence record is read, not the whole board.
            self.assertEqual((command["operation"], command["collection"], command["id"]), ("query", "evidence", evidence_id))
            await websocket.send(json.dumps({
                "type": "api-result", "requestId": command["requestId"], "ok": True,
                "record": {"id": evidence_id, "fact_id": relation_id},
            }))
            command = await receive(websocket)
            self.assertEqual(command["operation"], "apply")
            draft = command["drafts"][0]
            self.assertEqual(draft["type"], "assertion.update")
            self.assertEqual(draft["payload"], {"id": evidence_id, "note": "edited", "confidence": 0.75})
            self.assertEqual(draft["author"], "REST")
            await websocket.send(json.dumps({
                "type": "api-result", "requestId": command["requestId"], "ok": True,
                "accepted": 1,
            }))
            self.assertEqual((await request_task)["accepted_actions"], 1)

    async def test_relay_rejects_foreign_origins_and_missing_hello(self):
        board = str(uuid4())
        url = f"ws://127.0.0.1:{self.port}/ws/boards/{board}"
        with self.assertRaises(websockets.exceptions.InvalidStatus):
            async with join(url, str(uuid4()), "Evil", origin="https://evil.example"):
                pass
        async with join(url, str(uuid4()), "Same", origin=f"http://127.0.0.1:{self.port}") as same:
            self.assertEqual((await receive(same))["type"], "welcome")
        async with websockets.connect(url) as silent:
            await silent.send(json.dumps({"type": "sync-request"}))
            with self.assertRaises(websockets.exceptions.ConnectionClosed):
                await receive(silent)

    async def test_tokens_only_in_headers_and_security_headers_set(self):
        board, actor, token = str(uuid4()), str(uuid4()), "c" * 64

        def get(url, headers=None):
            with urlopen(Request(url, headers=headers or {}), timeout=3) as response:
                return response.headers

        async with join(f"ws://127.0.0.1:{self.port}/ws/boards/{board}", actor, "Header", token) as websocket:
            await receive(websocket)
            with self.assertRaises(HTTPError) as caught:
                await asyncio.to_thread(get, f"http://127.0.0.1:{self.port}/api/boards/{board}/status?token={token}")
            self.assertEqual(caught.exception.code, 401)
            self.assertEqual(caught.exception.headers["Referrer-Policy"], "no-referrer")
            caught.exception.close()
        headers = await asyncio.to_thread(get, f"http://127.0.0.1:{self.port}/api/health", {"X-Forwarded-Proto": "https"})
        self.assertEqual(headers["X-Frame-Options"], "DENY")
        self.assertIn("frame-ancestors 'none'", headers["Content-Security-Policy"])
        self.assertEqual(headers["Cache-Control"], "no-store")
        self.assertIn("max-age", headers["Strict-Transport-Security"])


    async def test_import_formats_inspect_with_board_knowledge_preview_and_list(self):
        board, actor, token = str(uuid4()), str(uuid4()), "formats-token"
        csv = b"ts,caller_oid,verb,vault\n2026-09-28T11:00:00Z,11111111-2222-3333-4444-555555555555,SecretGet,kv-prod\n"
        boundary = "factgraphboundary"
        upload = (f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"vault.csv\"\r\nContent-Type: text/csv\r\n\r\n").encode() + csv + f"\r\n--{boundary}--\r\n".encode()

        def call(method, path, body=None, content_type="application/json"):
            request = Request(f"http://127.0.0.1:{self.port}/api/boards/{board}{path}", method=method, data=body,
                              headers={"X-FactGraph-Token": token, **({"Content-Type": content_type} if body is not None else {})})
            with urlopen(request, timeout=5) as response:
                return json.load(response)

        saved = {"version": 1, "id": "f1", "name": "Vault audit", "rows": "activity", "columns": ["ts", "caller_oid", "verb", "vault"],
                 "entities": [{"column": "caller_oid", "kind": "User", "role": "actor", "ids": [{"column": "caller_oid", "type": "entra-object-id"}]},
                              {"column": "vault", "kind": "Key Vault", "role": "target", "ids": []}],
                 "operation": "observed", "operation_column": "verb", "time": "ts", "end": None, "locator": [], "details": []}
        async with join(f"ws://127.0.0.1:{self.port}/ws/boards/{board}", actor, "Browser", token) as websocket:
            await receive(websocket)
            # Reading a file asks the browser for the board's entities, to recognise values it knows.
            inspect = asyncio.create_task(asyncio.to_thread(call, "POST", "/imports/inspect", upload, f"multipart/form-data; boundary={boundary}"))
            command = await receive(websocket)
            self.assertEqual(command["operation"], "index")
            await websocket.send(json.dumps({"type": "api-result", "requestId": command["requestId"], "ok": True, "index": {"entities": [
                {"id": "u1", "kind": "User", "name": "j.doe@corp.example", "identifiers": [
                    {"scheme": "external_id", "namespace": "entra-object-id", "normalized_value": "11111111-2222-3333-4444-555555555555"}]}], "facts": [], "sources": []}}))
            report = await inspect
            self.assertIsNone(report["builtin"])
            column = next(c for c in report["columns"] if c["name"] == "caller_oid")
            self.assertEqual((column["type"], column["known"]["kind"], column["known"]["id_type"]), ("guid", "User", "entra-object-id"))
            self.assertEqual(report["board_names"], {"11111111-2222-3333-4444-555555555555": "j.doe@corp.example"})
            # The preview needs no browser: it only applies the format to the rows it is given.
            preview = await asyncio.to_thread(call, "POST", "/imports/preview", json.dumps({"rows": report["sample"], "format": saved}).encode())
            self.assertEqual((preview["rows"][0]["operation"], preview["rows"][0]["time"], preview["missing"]), ("secret get", "2026-09-28T11:00:00Z", []))
            # Agents list the formats saved in the analyst's browser.
            listing = asyncio.create_task(asyncio.to_thread(call, "GET", "/imports/formats"))
            command = await receive(websocket)
            self.assertEqual(command["operation"], "formats")
            await websocket.send(json.dumps({"type": "api-result", "requestId": command["requestId"], "ok": True, "formats": [saved]}))
            self.assertEqual((await listing)["formats"][0]["name"], "Vault audit")
            # A format that lacks columns of the rows is refused with the missing columns named.
            with self.assertRaises(HTTPError) as caught:
                await asyncio.to_thread(call, "POST", "/imports/table", json.dumps({"rows": [{"ts": "2026-09-28T11:00:00Z"}], "format": saved, "dry_run": True}).encode())
            self.assertEqual(caught.exception.code, 422)
            self.assertIn("caller_oid", json.load(caught.exception)["detail"])

    async def test_heartbeat_keeps_browsers_and_silence_frees_their_connection(self):
        """Hosting front ends may keep a vanished browser's connection open (and answer pings for it); a browser that
        announced a heartbeat and stays silent for six of them is closed, which frees the platform's connection slot."""
        url = f"ws://127.0.0.1:{self.port}/ws/boards/{uuid4()}"
        async with websockets.connect(url) as websocket:
            await websocket.send(json.dumps({"type": "hello", "actor": str(uuid4()), "name": "Beat", "heartbeat": 0.5}))
            self.assertEqual((await receive(websocket))["type"], "welcome")
            # Heartbeats are answered and keep the connection beyond the 3 s silence limit.
            for _ in range(5):
                await websocket.send(json.dumps({"type": "heartbeat"}))
                self.assertEqual((await receive(websocket))["type"], "heartbeat")
                await asyncio.sleep(1)
            # Then silence: closed with 4000.
            with self.assertRaises(websockets.ConnectionClosed) as closed:
                await asyncio.wait_for(websocket.recv(), timeout=6)
            self.assertEqual(closed.exception.rcvd.code, 4000)
        # Browsers without a heartbeat (older versions) are not closed for silence.
        async with join(url, str(uuid4()), "Old") as websocket:
            await receive(websocket)
            with self.assertRaises(asyncio.TimeoutError):
                await asyncio.wait_for(websocket.recv(), timeout=4)

    async def test_large_replies_arrive_in_parts_and_lists_query_the_browser(self):
        board, actor, token = str(uuid4()), str(uuid4()), "parts-token"

        def get(path):
            request = Request(f"http://127.0.0.1:{self.port}/api/boards/{board}{path}", headers={"X-FactGraph-Token": token})
            with urlopen(request, timeout=5) as response:
                return json.load(response)

        async with join(f"ws://127.0.0.1:{self.port}/ws/boards/{board}", actor, "Browser", token) as websocket:
            await receive(websocket)
            # A list asks the browser for one page of one collection, not for the whole graph.
            listing = asyncio.create_task(asyncio.to_thread(get, "/entities?limit=1&q=host"))
            command = await receive(websocket)
            self.assertEqual((command["operation"], command["collection"], command["limit"], command["q"]), ("query", "entities", 1, "host"))
            await websocket.send(json.dumps({"type": "api-result", "requestId": command["requestId"], "ok": True,
                                             "items": [{"id": "e1"}], "total": 3, "revision": "r9"}))
            self.assertEqual(await listing, {"board_id": board, "items": [{"id": "e1"}], "total": 3, "revision": "r9"})
            # A large single record comes in parts and is joined before parsing.
            record = asyncio.create_task(asyncio.to_thread(get, "/sources/s1"))
            command = await receive(websocket)
            self.assertEqual((command["operation"], command["id"]), ("query", "s1"))
            text = json.dumps({"type": "api-result", "requestId": command["requestId"], "ok": True, "record": {"id": "s1", "excerpt": "x" * 3_000_000}})
            chunks = [text[i:i + 1_000_000] for i in range(0, len(text), 1_000_000)]
            for index, chunk in enumerate(chunks):
                await websocket.send(json.dumps({"type": "api-result-part", "requestId": command["requestId"], "index": index, "total": len(chunks), "data": chunk}))
            self.assertEqual(len((await record)["excerpt"]), 3_000_000)
            # Parts out of order fail the request instead of producing garbage.
            broken = asyncio.create_task(asyncio.to_thread(get, "/sources/s2"))
            command = await receive(websocket)
            await websocket.send(json.dumps({"type": "api-result-part", "requestId": command["requestId"], "index": 1, "total": 2, "data": "}"}))
            with self.assertRaises(HTTPError) as caught:
                await broken
            self.assertEqual(caught.exception.code, 422)
            caught.exception.close()


if __name__ == "__main__":
    unittest.main()
