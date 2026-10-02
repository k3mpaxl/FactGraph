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
                graph_task = asyncio.create_task(client.call_tool("get_graph", {"board_id": board}))
                command = await receive(websocket)
                self.assertEqual(command["operation"], "snapshot")
                await websocket.send(json.dumps({
                    "type": "api-result", "requestId": command["requestId"], "ok": True,
                    "graph": {"board_id": board, "name": "MCP", "entities": [],
                              "facts": [], "sources": [], "action_count": 0},
                }))
                graph = await graph_task
                self.assertEqual(graph.data["board_id"], board)

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
            self.assertEqual(command["operation"], "snapshot")
            await websocket.send(json.dumps({
                "type": "api-result", "requestId": command["requestId"], "ok": True,
                "graph": {"board_id": board, "name": "Patch", "entities": [],
                          "sources": [], "action_count": 2, "facts": [{
                              "id": relation_id, "assertions": [{"id": evidence_id}],
                          }]},
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


if __name__ == "__main__":
    unittest.main()
