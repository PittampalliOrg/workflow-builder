from __future__ import annotations

import io
import json
import urllib.error
import urllib.request
from pathlib import Path

import pytest

import src.runtime_start_authority as activity_module
from src.adapters.workflow_builder_runtime_start_authority import (
    WorkflowBuilderRuntimeStartAuthorityAdapter,
)
from src.ports.runtime_start_authority import (
    RuntimeStartAuthorityDecision,
    RuntimeStartAuthorityRequest,
)
from src.runtime_start_authority import authorize_session_runtime_start


class _FakeAuthorityPort:
    def __init__(self, decision: RuntimeStartAuthorityDecision) -> None:
        self.decision = decision
        self.requests: list[RuntimeStartAuthorityRequest] = []

    def authorize(
        self, request: RuntimeStartAuthorityRequest
    ) -> RuntimeStartAuthorityDecision:
        self.requests.append(request)
        return self.decision


class _Response:
    def __init__(self, body: dict) -> None:
        self._body = json.dumps(body).encode("utf-8")

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def read(self) -> bytes:
        return self._body


def _request() -> RuntimeStartAuthorityRequest:
    return RuntimeStartAuthorityRequest(
        session_id="session/1",
        session_token="signed-token",
        runtime_app_id="cli-runtime-generation",
        runtime_instance_id="runtime-generation-1",
    )


def _adapter() -> WorkflowBuilderRuntimeStartAuthorityAdapter:
    return WorkflowBuilderRuntimeStartAuthorityAdapter(
        internal_token="internal-token",
        workflow_builder_app_id="workflow-builder",
        dapr_http_port="3500",
    )


def test_activity_calls_authority_port_with_exact_generation(monkeypatch):
    port = _FakeAuthorityPort(RuntimeStartAuthorityDecision(authorized=True))
    monkeypatch.setattr(activity_module, "runtime_start_authority_port", lambda: port)

    result = authorize_session_runtime_start(
        object(),
        {
            "sessionId": " session/1 ",
            "workflowMcpSessionToken": " signed-token ",
            "runtimeAppId": " cli-runtime-generation ",
            "runtimeInstanceId": " runtime-generation-1 ",
        },
    )

    assert result == {"authorized": True}
    assert port.requests == [_request()]


@pytest.mark.parametrize(
    ("code", "declared_retryable", "expected_retryable"),
    [
        ("runtime_unpublished", True, True),
        ("team_pending", True, True),
        ("runtime_superseded", True, False),
        ("runtime_unpublished", False, False),
    ],
)
def test_adapter_only_retries_explicit_publication_pending_codes(
    monkeypatch, code, declared_retryable, expected_retryable
):
    body = json.dumps(
        {
            "code": code,
            "retryable": declared_retryable,
            "message": "not authorized",
        }
    ).encode("utf-8")

    def fake_urlopen(req, timeout):
        raise urllib.error.HTTPError(
            req.full_url,
            409,
            "Conflict",
            hdrs=None,
            fp=io.BytesIO(body),
        )

    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)

    assert _adapter().authorize(_request()) == RuntimeStartAuthorityDecision(
        authorized=False,
        status=409,
        code=code,
        retryable=expected_retryable,
        reason="not authorized",
    )


def test_main_registers_authority_activity():
    source = (Path(__file__).parents[1] / "src/main.py").read_text()
    assert "_runtime.register_activity(\n    authorize_session_runtime_start," in source
    assert "name=AUTHORIZE_SESSION_RUNTIME_START_ACTIVITY" in source
