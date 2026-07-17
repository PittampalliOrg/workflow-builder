"""durationMs fallback in persist_results_to_db (read-model persist fix).

The dynamic-script pump's terminal persist never passes durationMs, so
final_output.durationMs was null on completed runs even though the activity
already computed startedAt->completedAt for the duration column. When the
input value is absent, final_output must carry the computed fallback.
"""

from __future__ import annotations

import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from activities import persist_results_to_db as persist_module


class FakeWorkflowDataClient:
    def __init__(self, execution_row):
        self.execution_row = execution_row
        self.patches: list[tuple[str, dict]] = []

    def get_execution(self, _execution_id):
        return self.execution_row

    def patch_execution(self, execution_id, payload):
        self.patches.append((execution_id, payload))
        return {"ok": True}


def _run(monkeypatch, *, execution_row, input_overrides=None):
    client = FakeWorkflowDataClient(execution_row)
    monkeypatch.setattr(persist_module, "workflow_data_client", client)
    input_data = {
        "executionId": "dsw-exec-1",
        "dbExecutionId": "db-1",
        "success": True,
        "workflowOutput": {"ok": True},
        "outputs": {"returnValue": {"ok": True}},
    }
    input_data.update(input_overrides or {})
    result = persist_module.persist_results_to_db(None, input_data)
    assert result == {"success": True}
    assert len(client.patches) == 1
    return client.patches[0][1]


def test_duration_ms_falls_back_to_computed_when_input_absent(monkeypatch):
    started = datetime.now(timezone.utc) - timedelta(seconds=90)
    payload = _run(monkeypatch, execution_row={"startedAt": started.isoformat()})
    final_output = payload["output"]
    # The pump's terminal persist omits durationMs — final_output picks up the
    # startedAt->completedAt computed value instead of null.
    assert final_output["durationMs"] is not None
    assert 80_000 <= final_output["durationMs"] <= 120_000
    # ...and matches the duration column.
    assert payload["duration"] == str(final_output["durationMs"])


def test_explicit_duration_ms_input_still_wins_in_final_output(monkeypatch):
    # No startedAt on the row -> nothing computed; the caller's value persists.
    payload = _run(
        monkeypatch, execution_row={}, input_overrides={"durationMs": 1234}
    )
    assert payload["output"]["durationMs"] == 1234
    assert payload["duration"] == "1234"


def test_duration_ms_stays_null_when_nothing_available(monkeypatch):
    payload = _run(monkeypatch, execution_row={})
    assert payload["output"]["durationMs"] is None
    assert payload["duration"] is None
