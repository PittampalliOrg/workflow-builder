import asyncio
import ast
from pathlib import Path
import unittest

import websockets

from app.websocket_transport import (
    DEFAULT_WS_MAX_MESSAGE_BYTES,
    DEFAULT_WS_MAX_QUEUE,
    MAX_WS_MAX_MESSAGE_BYTES,
    MAX_WS_MAX_QUEUE,
    MAX_WS_DECODED_BUFFER_BYTES,
    UPSTREAM_TO_CLIENT,
    WS_MAX_MESSAGE_BYTES_ENV,
    WS_MAX_QUEUE_ENV,
    relay_websocket_messages,
    websocket_limits,
    websocket_max_message_bytes,
    websocket_max_queue,
)


class WebsocketConfigurationTests(unittest.TestCase):
    def test_default_allows_multi_megabyte_cdp_frames_with_a_finite_cap(self):
        self.assertEqual(16 * 1024 * 1024, DEFAULT_WS_MAX_MESSAGE_BYTES)
        self.assertEqual(DEFAULT_WS_MAX_MESSAGE_BYTES, websocket_max_message_bytes({}))
        self.assertEqual((16 * 1024 * 1024, 1), websocket_limits({}))
        self.assertLessEqual(
            4 * DEFAULT_WS_MAX_MESSAGE_BYTES * DEFAULT_WS_MAX_QUEUE,
            MAX_WS_DECODED_BUFFER_BYTES,
        )

    def test_max_message_bytes_can_be_overridden(self):
        configured = 24 * 1024 * 1024
        self.assertEqual(
            configured,
            websocket_max_message_bytes({WS_MAX_MESSAGE_BYTES_ENV: str(configured)}),
        )

    def test_max_message_bytes_rejects_unbounded_or_invalid_values(self):
        for value in ("0", "-1", "not-a-number", str(MAX_WS_MAX_MESSAGE_BYTES + 1)):
            with self.subTest(value=value), self.assertRaises(ValueError):
                websocket_max_message_bytes({WS_MAX_MESSAGE_BYTES_ENV: value})

    def test_frame_queue_is_small_configurable_and_bounded(self):
        self.assertEqual(DEFAULT_WS_MAX_QUEUE, websocket_max_queue({}))
        self.assertEqual(2, websocket_max_queue({WS_MAX_QUEUE_ENV: "2"}))
        for value in ("0", "-1", "not-a-number", str(MAX_WS_MAX_QUEUE + 1)):
            with self.subTest(value=value), self.assertRaises(ValueError):
                websocket_max_queue({WS_MAX_QUEUE_ENV: value})

    def test_frame_and_queue_product_cannot_exceed_decoded_memory_budget(self):
        self.assertEqual(
            (16 * 1024 * 1024, 2),
            websocket_limits(
                {
                    WS_MAX_MESSAGE_BYTES_ENV: str(16 * 1024 * 1024),
                    WS_MAX_QUEUE_ENV: "2",
                }
            ),
        )
        with self.assertRaisesRegex(ValueError, "receive buffer exceeds"):
            websocket_limits(
                {
                    WS_MAX_MESSAGE_BYTES_ENV: str(32 * 1024 * 1024),
                    WS_MAX_QUEUE_ENV: "2",
                }
            )

    def test_service_wires_frame_and_queue_bounds_into_chrome_connection(self):
        service_path = Path(__file__).parents[1] / "app" / "service.py"
        module = ast.parse(service_path.read_text(encoding="utf-8"))
        connect_calls = [
            node
            for node in ast.walk(module)
            if isinstance(node, ast.Call)
            and isinstance(node.func, ast.Attribute)
            and isinstance(node.func.value, ast.Name)
            and node.func.value.id == "websockets"
            and node.func.attr == "connect"
        ]
        self.assertEqual(1, len(connect_calls))
        keywords = {keyword.arg for keyword in connect_calls[0].keywords}
        self.assertTrue({"open_timeout", "max_size", "max_queue"} <= keywords)


class WebsocketRelayTests(unittest.IsolatedAsyncioTestCase):
    async def test_pinned_websocket_client_accepts_multi_megabyte_cdp_frame(self):
        payload = "x" * (4 * 1024 * 1024)

        async def send_frame(websocket):
            await websocket.send(payload)

        async with websockets.serve(send_frame, "127.0.0.1", 0) as server:
            port = server.sockets[0].getsockname()[1]
            async with websockets.connect(
                f"ws://127.0.0.1:{port}",
                max_size=websocket_limits({})[0],
            ) as client:
                self.assertEqual(await client.recv(), payload)

    async def test_forwards_multi_megabyte_message_without_transforming_it(self):
        payload = "x" * (4 * 1024 * 1024)
        client_receive_started = asyncio.Event()
        client_receive_cancelled = asyncio.Event()
        client_messages = []

        async def receive_client():
            client_receive_started.set()
            try:
                await asyncio.Event().wait()
            finally:
                client_receive_cancelled.set()

        async def send_upstream(_message):
            self.fail("the blocked client side should not produce a message")

        async def upstream_messages():
            await client_receive_started.wait()
            yield payload

        async def send_client(message):
            client_messages.append(message)

        completed = await asyncio.wait_for(
            relay_websocket_messages(
                receive_client=receive_client,
                send_upstream=send_upstream,
                upstream_messages=upstream_messages(),
                send_client=send_client,
            ),
            timeout=0.5,
        )

        self.assertEqual([payload], client_messages)
        self.assertEqual(frozenset({UPSTREAM_TO_CLIENT}), completed)
        self.assertTrue(client_receive_cancelled.is_set())

    async def test_failed_pump_cancels_its_sibling_before_propagating(self):
        class ExpectedDisconnect(Exception):
            pass

        upstream_started = asyncio.Event()
        upstream_cancelled = asyncio.Event()

        async def receive_client():
            await upstream_started.wait()
            raise ExpectedDisconnect("client disconnected")

        async def send_upstream(_message):
            self.fail("the failed receive should not produce a message")

        async def upstream_messages():
            upstream_started.set()
            try:
                await asyncio.Event().wait()
            finally:
                upstream_cancelled.set()
            if False:
                yield "unreachable"

        async def send_client(_message):
            self.fail("the upstream receive remains blocked")

        with self.assertRaises(ExpectedDisconnect):
            await asyncio.wait_for(
                relay_websocket_messages(
                    receive_client=receive_client,
                    send_upstream=send_upstream,
                    upstream_messages=upstream_messages(),
                    send_client=send_client,
                ),
                timeout=0.5,
            )

        self.assertTrue(upstream_cancelled.is_set())

    async def test_cancelling_relay_cancels_both_receive_pumps_without_hanging(self):
        client_started = asyncio.Event()
        upstream_started = asyncio.Event()
        client_cancelled = asyncio.Event()
        upstream_cancelled = asyncio.Event()

        async def receive_client():
            client_started.set()
            try:
                await asyncio.Event().wait()
            finally:
                client_cancelled.set()

        async def send_upstream(_message):
            self.fail("the client receive remains blocked")

        async def upstream_messages():
            upstream_started.set()
            try:
                await asyncio.Event().wait()
            finally:
                upstream_cancelled.set()
            if False:
                yield "unreachable"

        async def send_client(_message):
            self.fail("the upstream receive remains blocked")

        relay = asyncio.create_task(
            relay_websocket_messages(
                receive_client=receive_client,
                send_upstream=send_upstream,
                upstream_messages=upstream_messages(),
                send_client=send_client,
            )
        )
        await asyncio.wait_for(
            asyncio.gather(client_started.wait(), upstream_started.wait()), timeout=0.5
        )

        relay.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await asyncio.wait_for(relay, timeout=0.5)

        self.assertTrue(client_cancelled.is_set())
        self.assertTrue(upstream_cancelled.is_set())


if __name__ == "__main__":
    unittest.main()
