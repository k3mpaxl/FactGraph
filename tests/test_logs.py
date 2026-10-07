"""Server logs: no board IDs (they are the boards' access keys), the client's real IP behind a trusted proxy, and no
traceback when a browser leaves before saying hello (a reload, or many tabs reconnecting after a restart)."""
import asyncio
import json
import os
import socket
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from urllib.request import urlopen
from uuid import uuid4

import websockets


class ServerLogTest(unittest.IsolatedAsyncioTestCase):
    @classmethod
    def setUpClass(cls):
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            cls.port = sock.getsockname()[1]
        handle, cls.log = tempfile.mkstemp(suffix=".log")
        # As in the Docker image: INFO logs, no access log, proxies trusted only on loopback and link-local addresses.
        env = {**os.environ, "FORWARDED_ALLOW_IPS": "127.0.0.1,::1,169.254.0.0/16"}
        cls.process = subprocess.Popen([sys.executable, "-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", str(cls.port),
                                        "--log-level", "info", "--no-access-log"], cwd=Path(__file__).resolve().parents[1],
                                       stdout=handle, stderr=subprocess.STDOUT, env=env)
        os.close(handle)
        for _ in range(100):
            try:
                with urlopen(f"http://127.0.0.1:{cls.port}/api/health", timeout=0.1):
                    return
            except Exception:
                time.sleep(0.05)
        cls.process.terminate()
        raise RuntimeError("Test server could not be started")

    @classmethod
    def tearDownClass(cls):
        cls.process.terminate()
        cls.process.wait(5)
        os.unlink(cls.log)

    async def test_logs_hide_board_ids_show_real_ip_and_no_traceback(self):
        board = str(uuid4())
        url = f"ws://127.0.0.1:{self.port}/ws/boards/{board}"
        # The platform's front end forwards the client as "IP:port" (Azure App Service).
        proxy = {"X-Forwarded-For": "203.0.113.9:51515"}
        # Browsers that leave before saying hello: one closes cleanly, one drops the connection (as after a restart).
        leaving = await websockets.connect(url, additional_headers=proxy)
        await leaving.close()
        dropping = await websockets.connect(url, additional_headers=proxy)
        dropping.transport.abort()
        async with websockets.connect(url, additional_headers=proxy) as browser:
            await browser.send(json.dumps({"type": "hello", "actor": str(uuid4()), "name": "Log test"}))
            self.assertEqual(json.loads(await asyncio.wait_for(browser.recv(), timeout=3))["type"], "welcome")
        await asyncio.sleep(0.5)
        log = Path(self.log).read_text()
        self.assertNotIn(board, log, "the board ID is the board's access key")
        self.assertIn('"WebSocket /ws/boards/<board>" [accepted]', log)
        self.assertIn("203.0.113.9", log, "the client's real IP, not the proxy's")
        self.assertNotIn("Traceback", log)
        self.assertNotIn("Exception in ASGI application", log)


if __name__ == "__main__":
    unittest.main()
