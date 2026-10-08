"""A large sync to a slow browser must not cost the sending browser its connection.

The relay forwards a browser's messages to the others. When it waited for a slow receiver inside the sender's loop, it
stopped reading the sender (uvicorn reads one message ahead), the sender's pong stayed unread, and uvicorn closed the
healthy sender with "keepalive ping timeout": both reconnected and the sync of a large board started over and over.
"""
import asyncio
import json
import os
import socket
import subprocess
import sys
import time
import unittest
from pathlib import Path
from urllib.request import urlopen
from uuid import uuid4

import websockets

FRAME = 512 * 1024
FRAMES = 40


class RelayFlowTest(unittest.IsolatedAsyncioTestCase):
    @classmethod
    def setUpClass(cls):
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            cls.port = sock.getsockname()[1]
        # Fast keepalive pings, so a stalled reader is noticed within seconds.
        cls.process = subprocess.Popen([sys.executable, "-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", str(cls.port),
                                        "--log-level", "error", "--ws-ping-interval", "1", "--ws-ping-timeout", "4"],
                                       cwd=Path(__file__).resolve().parents[1], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                       env={**os.environ})
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

    async def hello(self, websocket, name):
        await websocket.send(json.dumps({"type": "hello", "actor": str(uuid4()), "name": name}))
        return json.loads(await asyncio.wait_for(websocket.recv(), timeout=3))

    async def test_a_slow_browser_holds_back_neither_the_sender_nor_the_others(self):
        url = f"ws://127.0.0.1:{self.port}/ws/boards/{uuid4()}"
        header = json.dumps({"type": "actions"}).encode()
        frame = b"FGZ1" + len(header).to_bytes(4, "big") + header + os.urandom(FRAME)
        # The stalled browser stops reading after one message (a closed laptop, a very slow link).
        async with websockets.connect(url, max_queue=1) as stalled, websockets.connect(url) as fast, websockets.connect(url) as sender:
            await self.hello(stalled, "Stalled")
            await self.hello(fast, "Fast")
            await self.hello(sender, "Sender")
            received = 0

            async def read_fast():
                nonlocal received
                while received < FRAMES:
                    if isinstance(await fast.recv(), bytes):
                        received += 1

            async def drain(websocket):
                async for _ in websocket:
                    pass
            reader, drainer = asyncio.create_task(read_fast()), asyncio.create_task(drain(sender))
            started = time.monotonic()
            try:
                for _ in range(FRAMES):
                    await sender.send(frame)
                await asyncio.wait_for(reader, timeout=60)
                took = time.monotonic() - started
                # The sender stays connected and answers a ping.
                await asyncio.wait_for(await sender.ping(), timeout=5)
            finally:
                reader.cancel()
                drainer.cancel()
            self.assertEqual(received, FRAMES)
            # 20 MB over loopback take well under a second; waiting for the stalled browser would take until its keepalive
            # timeout (about 5 s here, 120 s in production).
            self.assertLess(took, 3, f"the fast browser waited {took:.1f} s for the stalled one")


if __name__ == "__main__":
    unittest.main()
