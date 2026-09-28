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


async def receive(websocket):
    return json.loads(await asyncio.wait_for(websocket.recv(), timeout=2))


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
        raise RuntimeError("Test-Relay konnte nicht gestartet werden")

    @classmethod
    def tearDownClass(cls):
        cls.process.terminate()
        cls.process.wait(timeout=3)

    async def test_join_history_and_departure(self):
        board, first, second = str(uuid4()), str(uuid4()), str(uuid4())
        base = f"ws://127.0.0.1:{self.port}/ws/boards/{board}"
        async with websockets.connect(f"{base}?actor={first}&name=Alex") as a:
            self.assertEqual(await receive(a), {"type": "welcome", "peers": []})
            async with websockets.connect(f"{base}?actor={second}&name=Sam") as b:
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
        async with websockets.connect(f"ws://127.0.0.1:{self.port}/ws/boards/{first}?actor={uuid4()}&name=A") as a:
            await receive(a)
            async with websockets.connect(f"ws://127.0.0.1:{self.port}/ws/boards/{second}?actor={uuid4()}&name=B") as b:
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
        async with websockets.connect(
            f"ws://127.0.0.1:{self.port}/ws/boards/{board}?actor={actor}&name=Writer&token={token}"
        ) as websocket:
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


if __name__ == "__main__":
    unittest.main()
