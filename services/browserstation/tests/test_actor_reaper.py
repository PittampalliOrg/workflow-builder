from types import SimpleNamespace
import unittest

from app.actor_reaper import (
    merge_reconciled_actor_times,
    reconcile_actor_start_times,
    stale_actor_ages,
)


NAMESPACE = "browserstation"


def identity(name: str):
    return (NAMESPACE, name)


class ActorReconciliationTests(unittest.TestCase):
    def test_available_start_time_metadata_is_used_and_absent_records_are_pruned(self):
        now_monotonic = 4_000.0
        now_epoch_ms = 1_750_000_000_000.0
        records = [
            SimpleNamespace(
                name="discovered",
                ray_namespace=NAMESPACE,
                start_time_ms=now_epoch_ms - (15 * 60 * 1000),
            )
        ]

        reconciled = reconcile_actor_start_times(
            records,
            {identity("no-longer-alive"): 10.0},
            now_monotonic=now_monotonic,
            now_epoch_ms=now_epoch_ms,
        )

        self.assertEqual({identity("discovered"): 3_100.0}, reconciled)

    def test_start_time_is_preferred_when_it_becomes_available(self):
        reconciled = reconcile_actor_start_times(
            [
                {
                    "name": "browser",
                    "ray_namespace": NAMESPACE,
                    "start_time_ms": 1_000_000.0,
                }
            ],
            {identity("browser"): 995.0},
            now_monotonic=2_000.0,
            now_epoch_ms=2_000_000.0,
        )

        self.assertEqual(1_000.0, reconciled[identity("browser")])

    def test_missing_start_time_uses_stable_first_seen_fallback(self):
        first = reconcile_actor_start_times(
            [SimpleNamespace(name="legacy", ray_namespace=NAMESPACE)],
            {},
            now_monotonic=100.0,
            now_epoch_ms=2_000_000.0,
        )
        second = reconcile_actor_start_times(
            [SimpleNamespace(name="legacy", ray_namespace=NAMESPACE)],
            first,
            now_monotonic=125.0,
            now_epoch_ms=2_025_000.0,
        )

        self.assertEqual({identity("legacy"): 100.0}, first)
        self.assertEqual(first, second)

    def test_invalid_or_future_start_time_uses_first_seen_fallback(self):
        records = [
            {
                "name": "invalid",
                "ray_namespace": NAMESPACE,
                "start_time_ms": "not-a-number",
            },
            {
                "name": "future",
                "ray_namespace": NAMESPACE,
                "start_time_ms": 2_100_000.0,
            },
            {
                "name": "boolean",
                "ray_namespace": NAMESPACE,
                "start_time_ms": True,
            },
        ]

        reconciled = reconcile_actor_start_times(
            records,
            {},
            now_monotonic=100.0,
            now_epoch_ms=2_000_000.0,
        )

        self.assertEqual(
            {
                identity("invalid"): 100.0,
                identity("future"): 100.0,
                identity("boolean"): 100.0,
            },
            reconciled,
        )

    def test_unnamed_and_duplicate_records_do_not_corrupt_reconciliation(self):
        reconciled = reconcile_actor_start_times(
            [
                {"name": None, "ray_namespace": NAMESPACE},
                {"name": "", "ray_namespace": NAMESPACE},
                {"name": "browser", "ray_namespace": None},
                {"name": "browser", "ray_namespace": NAMESPACE},
                {
                    "name": "browser",
                    "ray_namespace": NAMESPACE,
                    "start_time_ms": 1_000_000.0,
                },
            ],
            {},
            now_monotonic=100.0,
            now_epoch_ms=2_000_000.0,
        )

        self.assertEqual({identity("browser"): 100.0}, reconciled)

    def test_same_actor_name_in_legacy_namespaces_keeps_distinct_cleanup_identity(self):
        reconciled = reconcile_actor_start_times(
            [
                {"name": "same-name", "ray_namespace": "legacy-a"},
                {"name": "same-name", "ray_namespace": "legacy-b"},
            ],
            {},
            now_monotonic=100.0,
            now_epoch_ms=2_000_000.0,
        )

        self.assertEqual(
            {("legacy-a", "same-name"): 100.0, ("legacy-b", "same-name"): 100.0},
            reconciled,
        )

    def test_reconciliation_does_not_erase_actor_created_during_state_scan(self):
        existing = identity("existing")
        created_during_scan = identity("created-during-scan")
        current = {existing: 10.0, created_during_scan: 99.0}

        merge_reconciled_actor_times(
            current,
            {existing: 10.0},
            {existing: 10.0},
        )

        self.assertEqual({existing: 10.0, created_during_scan: 99.0}, current)


class ActorTtlTests(unittest.TestCase):
    def test_actor_at_ttl_boundary_is_stale(self):
        self.assertEqual(
            {identity("at-boundary"): 60.0, identity("older"): 90.0},
            stale_actor_ages(
                {
                    identity("fresh"): 41.0,
                    identity("at-boundary"): 40.0,
                    identity("older"): 10.0,
                },
                now_monotonic=100.0,
                ttl_seconds=60.0,
            ),
        )

    def test_non_positive_ttl_disables_reaping(self):
        for ttl in (0.0, -1.0):
            with self.subTest(ttl=ttl):
                self.assertEqual(
                    {},
                    stale_actor_ages(
                        {identity("old"): 1.0},
                        now_monotonic=100.0,
                        ttl_seconds=ttl,
                    ),
                )


if __name__ == "__main__":
    unittest.main()
