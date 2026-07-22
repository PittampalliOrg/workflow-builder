from __future__ import annotations

import json
from typing import Any

from src.runtime_readiness import workflow_runtime_readiness


class _Response:
    def __init__(self, payload: Any):
        self._raw = json.dumps(payload).encode("utf-8")

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def read(self) -> bytes:
        return self._raw


def test_ready_only_with_a_connected_dapr_workflow_worker(monkeypatch) -> None:
    monkeypatch.setenv("DAPR_HOST", "dapr-sidecar")
    monkeypatch.setenv("DAPR_HTTP_PORT", "3500")
    calls: list[tuple[str, float]] = []

    def open_metadata(request, timeout):
        calls.append((request.full_url, timeout))
        return _Response(
            {
                "id": "pydantic-session",
                "runtimeVersion": "1.16.6",
                "workflows": {"connectedWorkers": 1},
            }
        )

    ready, details = workflow_runtime_readiness(urlopen=open_metadata)

    assert ready is True
    assert details["workflowConnectedWorkers"] == 1
    assert calls == [("http://dapr-sidecar:3500/v1.0/metadata", 2.0)]


def test_not_ready_before_the_dapr_workflow_worker_connects() -> None:
    ready, details = workflow_runtime_readiness(
        urlopen=lambda *_args, **_kwargs: _Response(
            {"workflows": {"connectedWorkers": 0}}
        )
    )

    assert ready is False
    assert details["workflowConnectedWorkers"] == 0
    assert details["error"] == "workflow runtime has no connected Dapr workflow workers"


def test_worker_requirement_can_be_disabled_without_contacting_dapr(
    monkeypatch,
) -> None:
    monkeypatch.setenv("DAPR_AGENT_READYZ_REQUIRE_WORKFLOW_WORKERS", "false")

    def unexpected_call(*_args, **_kwargs):
        raise AssertionError("metadata endpoint must not be called")

    ready, details = workflow_runtime_readiness(urlopen=unexpected_call)

    assert ready is True
    assert details["requireWorkflowWorkers"] is False


def test_metadata_transport_failure_is_not_ready() -> None:
    def unavailable(*_args, **_kwargs):
        raise OSError("sidecar unavailable")

    ready, details = workflow_runtime_readiness(urlopen=unavailable)

    assert ready is False
    assert details["metadataError"] == "sidecar unavailable"
