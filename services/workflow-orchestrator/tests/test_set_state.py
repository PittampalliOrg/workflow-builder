from __future__ import annotations

import importlib.util
from pathlib import Path
import sys

MODULE_PATH = Path(__file__).resolve().parent.parent / "core" / "set_state.py"
SERVICE_ROOT = MODULE_PATH.parent.parent
if str(SERVICE_ROOT) not in sys.path:
    sys.path.insert(0, str(SERVICE_ROOT))

SPEC = importlib.util.spec_from_file_location("set_state", MODULE_PATH)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"Unable to load module from {MODULE_PATH}")
SET_STATE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(SET_STATE)

resolve_set_state_updates = SET_STATE.resolve_set_state_updates


def test_resolve_set_state_updates_single_entry_legacy_shape():
    updates, error = resolve_set_state_updates(
        {"key": "customerId", "value": "abc123"},
        {},
    )
    assert error is None
    assert updates == {"customerId": "abc123"}


def test_resolve_set_state_updates_entries_array():
    updates, error = resolve_set_state_updates(
        {
            "entries": [
                {"key": "firstName", "value": "SpongeBob"},
                {"key": "lastName", "value": "SquarePants"},
            ]
        },
        {},
    )
    assert error is None
    assert updates == {
        "firstName": "SpongeBob",
        "lastName": "SquarePants",
    }


def test_resolve_set_state_updates_entries_object_map():
    updates, error = resolve_set_state_updates(
        {
            "entries": {
                "customerId": "cust_123",
                "address": '{"city":"Bikini Bottom"}',
            }
        },
        {},
    )
    assert error is None
    assert updates == {
        "customerId": "cust_123",
        "address": {"city": "Bikini Bottom"},
    }


def test_resolve_set_state_updates_resolves_templates():
    updates, error = resolve_set_state_updates(
        {"entries": [{"key": "customerId", "value": "{{$Step.id}}"}]},
        {"Step": {"label": "Step", "data": {"id": "cust_789"}}},
    )
    assert error is None
    assert updates == {"customerId": "cust_789"}


def test_resolve_set_state_updates_rejects_missing_key():
    updates, error = resolve_set_state_updates(
        {"entries": [{"key": "", "value": "x"}]},
        {},
    )
    assert updates == {}
    assert error is not None
    assert "missing key" in error
