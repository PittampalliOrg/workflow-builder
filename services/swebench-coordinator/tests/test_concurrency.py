from __future__ import annotations

import sys
from pathlib import Path


SERVICE_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SERVICE_ROOT))

from src.concurrency import (  # noqa: E402
    bounded_swebench_concurrency,
    bounded_swebench_evaluation_concurrency,
    bounded_swebench_run_concurrency,
    instance_start_batch_delay_seconds,
    instance_start_batch_size,
    max_inference_concurrency,
)


def test_bounded_swebench_concurrency_uses_one_as_default_floor():
    assert bounded_swebench_concurrency(None) == 1
    assert bounded_swebench_concurrency("") == 1
    assert bounded_swebench_concurrency(0) == 1
    assert bounded_swebench_concurrency(-5) == 1


def test_bounded_swebench_concurrency_accepts_numeric_values():
    assert bounded_swebench_concurrency(3) == 3
    assert bounded_swebench_concurrency("4") == 4


def test_bounded_swebench_concurrency_caps_worker_count(monkeypatch):
    monkeypatch.delenv("SWEBENCH_COORDINATOR_MAX_INFERENCE_CONCURRENCY", raising=False)
    assert max_inference_concurrency() == 56
    assert bounded_swebench_concurrency(99) == 56
    assert bounded_swebench_concurrency("128") == 56
    assert bounded_swebench_concurrency("128", maximum=32) == 32


def test_bounded_swebench_concurrency_honors_env_backstop(monkeypatch):
    monkeypatch.setenv("SWEBENCH_COORDINATOR_MAX_INFERENCE_CONCURRENCY", "7")
    assert max_inference_concurrency() == 7
    assert bounded_swebench_concurrency(9) == 7


def test_instance_start_batch_defaults(monkeypatch):
    monkeypatch.delenv("SWEBENCH_COORDINATOR_INSTANCE_START_BATCH_SIZE", raising=False)
    monkeypatch.delenv(
        "SWEBENCH_COORDINATOR_INSTANCE_START_BATCH_DELAY_SECONDS", raising=False
    )
    assert instance_start_batch_size(16) == 16
    assert instance_start_batch_size() == 1
    assert instance_start_batch_delay_seconds() == 0


def test_instance_start_batch_honors_env(monkeypatch):
    monkeypatch.setenv("SWEBENCH_COORDINATOR_INSTANCE_START_BATCH_SIZE", "4")
    monkeypatch.setenv("SWEBENCH_COORDINATOR_INSTANCE_START_BATCH_DELAY_SECONDS", "0")
    assert instance_start_batch_size(16) == 4
    assert instance_start_batch_delay_seconds() == 0


def test_bounded_swebench_concurrency_falls_back_for_invalid_values():
    assert bounded_swebench_concurrency("many") == 1


def test_bounded_swebench_run_concurrency_uses_bff_capacity_without_default_backstop(
    monkeypatch,
):
    monkeypatch.delenv("SWEBENCH_COORDINATOR_MAX_INFERENCE_CONCURRENCY", raising=False)

    assert (
        bounded_swebench_run_concurrency(
            {
                "concurrency": 80,
                "summary": {
                    "capacity": {
                        "effectiveConcurrency": 80,
                        "maxActiveInferenceInstances": 80,
                    }
                },
            }
        )
        == 80
    )


def test_bounded_swebench_run_concurrency_honors_explicit_coordinator_guard(
    monkeypatch,
):
    monkeypatch.setenv("SWEBENCH_COORDINATOR_MAX_INFERENCE_CONCURRENCY", "72")

    assert (
        bounded_swebench_run_concurrency(
            {
                "concurrency": 80,
                "summary": {
                    "capacity": {
                        "effectiveConcurrency": 80,
                        "maxActiveInferenceInstances": 80,
                    }
                },
            }
        )
        == 72
    )


def test_bounded_swebench_evaluation_concurrency_defaults_to_dev_safe_cap():
    assert bounded_swebench_evaluation_concurrency(None) == 24
    assert bounded_swebench_evaluation_concurrency("") == 24
    assert bounded_swebench_evaluation_concurrency(0) == 24


def test_bounded_swebench_evaluation_concurrency_accepts_larger_eval_batches():
    assert bounded_swebench_evaluation_concurrency(32) == 32
    assert bounded_swebench_evaluation_concurrency("64") == 64
    assert bounded_swebench_evaluation_concurrency(999) == 128
