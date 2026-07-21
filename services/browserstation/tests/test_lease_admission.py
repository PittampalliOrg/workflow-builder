import asyncio
import json
from threading import Event
import unittest
from unittest.mock import patch

from fastapi import HTTPException

from app import routes
from app import service as service_module
from app.service import (
    BrowserService,
    LeaseAdmissionConflictError,
    LeaseAdmissionDrainingError,
)


CONTRACT = "a" * 64
OTHER_CONTRACT = "b" * 64
HOLDER = "00000000-0000-4000-8000-000000000001"
OTHER_HOLDER = "00000000-0000-4000-8000-000000000002"
TOKEN_ONE = "token_one_abcdefghijklmnopqrstuvwxyz012345"
TOKEN_TWO = "token_two_abcdefghijklmnopqrstuvwxyz012345"


class LeaseAdmissionTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.now = 100.0
        self.tokens = iter((TOKEN_ONE, TOKEN_TWO))
        self.service = BrowserService(
            monotonic=lambda: self.now,
            token_factory=lambda: next(self.tokens),
        )
        self.service._actor_creation_times = {}

    async def test_fence_renews_for_exact_owner_and_expires_fail_open(self):
        status = await self.service.begin_lease_admission(CONTRACT, HOLDER, 30, None)
        self.assertFalse(status.accepting_new_leases)
        self.assertEqual(CONTRACT, status.contract_sha256)
        self.assertEqual(30, status.expires_in_seconds)
        self.assertEqual(TOKEN_ONE, status.lease_token)

        self.now += 10
        renewed = await self.service.begin_lease_admission(
            CONTRACT, HOLDER, 30, TOKEN_ONE
        )
        self.assertEqual(30, renewed.expires_in_seconds)
        self.assertEqual(TOKEN_ONE, renewed.lease_token)
        with self.assertRaises(LeaseAdmissionConflictError):
            await self.service.begin_lease_admission(
                OTHER_CONTRACT, OTHER_HOLDER, 30, None
            )

        self.now += 31
        expired = await self.service.lease_admission_status()
        self.assertTrue(expired.accepting_new_leases)
        self.assertIsNone(expired.contract_sha256)
        self.assertIsNone(expired.expires_in_seconds)

    async def test_only_exact_owner_can_release_a_live_fence(self):
        lease = await self.service.begin_lease_admission(CONTRACT, HOLDER, 30, None)
        with self.assertRaises(LeaseAdmissionConflictError):
            await self.service.end_lease_admission(
                CONTRACT, OTHER_HOLDER, lease.lease_token
            )
        self.assertFalse(
            (await self.service.lease_admission_status()).accepting_new_leases
        )

        await self.service.end_lease_admission(CONTRACT, HOLDER, lease.lease_token)
        self.assertTrue(
            (await self.service.lease_admission_status()).accepting_new_leases
        )
        await self.service.end_lease_admission(CONTRACT, HOLDER, lease.lease_token)

    async def test_expired_generation_cannot_release_same_owner_reacquisition(self):
        first = await self.service.begin_lease_admission(CONTRACT, HOLDER, 30, None)
        self.now += 31
        with self.assertRaises(LeaseAdmissionConflictError):
            await self.service.begin_lease_admission(
                CONTRACT, HOLDER, 30, first.lease_token
            )

        second = await self.service.begin_lease_admission(CONTRACT, HOLDER, 30, None)
        self.assertNotEqual(first.lease_token, second.lease_token)
        with self.assertRaises(LeaseAdmissionConflictError):
            await self.service.end_lease_admission(CONTRACT, HOLDER, first.lease_token)
        status = await self.service.lease_admission_status()
        self.assertFalse(status.accepting_new_leases)
        self.assertEqual(CONTRACT, status.contract_sha256)
        self.assertNotIn("lease_token", status.model_dump())
        await self.service.end_lease_admission(CONTRACT, HOLDER, second.lease_token)

    async def test_fence_ack_waits_for_prior_create_and_blocks_later_create(self):
        create_started = Event()
        finish_create = Event()

        class ActorOptions:
            def remote(self, _browser_id):
                create_started.set()
                if not finish_create.wait(timeout=1):
                    raise TimeoutError("test did not release actor creation")

        class BrowserActor:
            @staticmethod
            def options(**_kwargs):
                return ActorOptions()

        with patch.object(service_module, "BrowserActor", BrowserActor):
            creating = asyncio.create_task(self.service.create_browser())
            self.assertTrue(await asyncio.to_thread(create_started.wait, 1))
            fencing = asyncio.create_task(
                self.service.begin_lease_admission(CONTRACT, HOLDER, 30, None)
            )
            await asyncio.sleep(0.01)
            self.assertFalse(fencing.done())

            finish_create.set()
            await creating
            await fencing
            with self.assertRaises(LeaseAdmissionDrainingError):
                await self.service.create_browser()

    async def test_create_route_returns_exact_retryable_drain_body(self):
        with patch.object(
            routes.service,
            "create_browser",
            side_effect=LeaseAdmissionDrainingError(
                "BrowserStation is temporarily not accepting new leases"
            ),
        ):
            response = await routes.create_browser()

        self.assertEqual(503, response.status_code)
        self.assertEqual("5", response.headers["retry-after"])
        self.assertEqual(
            {
                "code": "lease_admission_draining",
                "detail": "BrowserStation is temporarily not accepting new leases",
            },
            json.loads(response.body),
        )

    async def test_rollout_auth_fails_closed_when_secret_is_unconfigured(self):
        with patch.object(routes, "ROLLOUT_API_KEY", None):
            with self.assertRaisesRegex(HTTPException, "Invalid API key"):
                await routes.verify_rollout_api_key("provided")

        with patch.object(routes, "ROLLOUT_API_KEY", "expected"):
            self.assertEqual(
                "expected", await routes.verify_rollout_api_key("expected")
            )

    async def test_non_ascii_api_keys_are_rejected_instead_of_raising_type_error(self):
        with patch.object(routes, "API_KEY", "expected"):
            with self.assertRaises(HTTPException) as browser_error:
                await routes.verify_api_key("éxpected")
            self.assertEqual(401, browser_error.exception.status_code)

        with patch.object(routes, "ROLLOUT_API_KEY", "expected"):
            with self.assertRaises(HTTPException) as rollout_error:
                await routes.verify_rollout_api_key("éxpected")
            self.assertEqual(401, rollout_error.exception.status_code)


if __name__ == "__main__":
    unittest.main()
