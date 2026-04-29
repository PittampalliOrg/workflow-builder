from __future__ import annotations

import sys
from pathlib import Path


SERVICE_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SERVICE_ROOT))

from src.concurrency import bounded_swebench_concurrency  # noqa: E402


def test_bounded_swebench_concurrency_uses_one_as_default_floor():
    assert bounded_swebench_concurrency(None) == 1
    assert bounded_swebench_concurrency("") == 1
    assert bounded_swebench_concurrency(0) == 1
    assert bounded_swebench_concurrency(-5) == 1


def test_bounded_swebench_concurrency_accepts_numeric_values():
    assert bounded_swebench_concurrency(3) == 3
    assert bounded_swebench_concurrency("4") == 4


def test_bounded_swebench_concurrency_caps_worker_count():
    assert bounded_swebench_concurrency(99) == 32
    assert bounded_swebench_concurrency("128") == 32


def test_bounded_swebench_concurrency_falls_back_for_invalid_values():
    assert bounded_swebench_concurrency("many") == 1
