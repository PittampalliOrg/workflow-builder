import asyncio
import ast
from pathlib import Path
from types import SimpleNamespace
import time
import unittest
from unittest.mock import AsyncMock, patch

from app import service as service_module
from app.service import (
    BrowserService,
    QUEUED_ACTOR_STATES,
    RAY_NAMESPACE,
    REAPABLE_ACTOR_STATES,
)


class RayNamespaceContractTests(unittest.TestCase):
    def test_driver_creation_and_lookup_use_one_explicit_namespace(self):
        app_dir = Path(__file__).parents[1] / "app"
        main_source = (app_dir / "main.py").read_text(encoding="utf-8")
        service_source = (app_dir / "service.py").read_text(encoding="utf-8")
        main_module = ast.parse(main_source)
        service_module_ast = ast.parse(service_source)

        ray_init_calls = [
            node
            for node in ast.walk(main_module)
            if isinstance(node, ast.Call)
            and isinstance(node.func, ast.Attribute)
            and isinstance(node.func.value, ast.Name)
            and node.func.value.id == "ray"
            and node.func.attr == "init"
        ]
        self.assertEqual(1, len(ray_init_calls))
        self.assertIn(
            "namespace", {keyword.arg for keyword in ray_init_calls[0].keywords}
        )

        threaded_get_actor_calls = [
            node
            for node in ast.walk(service_module_ast)
            if isinstance(node, ast.Call)
            and isinstance(node.func, ast.Attribute)
            and isinstance(node.func.value, ast.Name)
            and node.func.value.id == "asyncio"
            and node.func.attr == "to_thread"
            and node.args
            and isinstance(node.args[0], ast.Attribute)
            and isinstance(node.args[0].value, ast.Name)
            and node.args[0].value.id == "ray"
            and node.args[0].attr == "get_actor"
        ]
        self.assertGreaterEqual(len(threaded_get_actor_calls), 4)
        self.assertTrue(
            all(
                "namespace" in {keyword.arg for keyword in call.keywords}
                for call in threaded_get_actor_calls
            )
        )
        self.assertIn("namespace=RAY_NAMESPACE", service_source)
        self.assertEqual("browserstation", RAY_NAMESPACE)


class ReaperRuntimeTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.service = BrowserService()
        self.service._actor_creation_times = {}

    async def test_reaps_legacy_pending_actor_in_its_original_namespace(self):
        identity = ("legacy-anonymous-namespace", "pending-browser")
        self.service._actor_creation_times[identity] = time.monotonic() - 120
        record = SimpleNamespace(
            name=identity[1],
            ray_namespace=identity[0],
            state="PENDING_CREATION",
            start_time_ms=None,
        )
        actor_handle = object()

        with (
            patch.object(service_module, "_ACTOR_TTL_SECONDS", 60),
            patch.object(
                service_module, "_query_browser_actors", return_value=[record]
            ) as query,
            patch.object(
                service_module.ray, "get_actor", return_value=actor_handle
            ) as get_actor,
            patch.object(service_module.ray, "kill") as kill,
        ):
            await self.service.reap_stale_actors_once()

        query.assert_called_once_with(
            REAPABLE_ACTOR_STATES, all_namespaces=True, detail=True
        )
        get_actor.assert_called_once_with(identity[1], namespace=identity[0])
        kill.assert_called_once_with(actor_handle)
        self.assertNotIn(identity, self.service._actor_creation_times)

    async def test_transient_kill_failure_retains_original_actor_age(self):
        identity = (RAY_NAMESPACE, "retry-browser")
        started_at = time.monotonic() - 120
        self.service._actor_creation_times[identity] = started_at
        record = SimpleNamespace(
            name=identity[1],
            ray_namespace=identity[0],
            state="ALIVE",
            start_time_ms=None,
        )

        with (
            patch.object(service_module, "_ACTOR_TTL_SECONDS", 60),
            patch.object(
                service_module, "_query_browser_actors", return_value=[record]
            ),
            patch.object(service_module.ray, "get_actor", return_value=object()),
            patch.object(
                service_module.ray, "kill", side_effect=RuntimeError("temporary")
            ),
        ):
            await self.service.reap_stale_actors_once()

        self.assertEqual(started_at, self.service._actor_creation_times[identity])

    async def test_state_scan_does_not_block_the_fastapi_event_loop(self):
        scan_started = asyncio.Event()
        loop = asyncio.get_running_loop()

        def slow_scan(*_args, **_kwargs):
            loop.call_soon_threadsafe(scan_started.set)
            time.sleep(0.05)
            return []

        with patch.object(
            service_module, "_query_browser_actors", side_effect=slow_scan
        ):
            reaping = asyncio.create_task(self.service.reap_stale_actors_once())
            await asyncio.wait_for(scan_started.wait(), timeout=0.1)
            await asyncio.sleep(0.005)
            self.assertFalse(reaping.done())
            await asyncio.wait_for(reaping, timeout=0.2)

    async def test_all_queued_states_report_as_not_ready(self):
        browser_id = "00000000-0000-4000-8000-000000000001"
        for state in QUEUED_ACTOR_STATES:
            with self.subTest(state=state):
                self.service._find_actor = AsyncMock(
                    return_value=SimpleNamespace(state=state)
                )
                result = await self.service.get_browser(browser_id)
                self.assertFalse(result.chrome_ready)


if __name__ == "__main__":
    unittest.main()
