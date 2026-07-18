from __future__ import annotations

from contextlib import nullcontext

from activities import cli_workspace_command as subject


class Response:
    status_code = 200
    text = ""

    def json(self):
        return {
            "success": True,
            "result": {"exitCode": 0, "stdout": "healthy", "stderr": ""},
        }


def test_wraps_workspace_result_in_action_data(monkeypatch):
    monkeypatch.setenv("INTERNAL_API_TOKEN", "internal-token")
    monkeypatch.setattr(subject, "start_activity_span", lambda *_args, **_kwargs: nullcontext())
    monkeypatch.setattr(subject, "set_current_span_attrs", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(subject.requests, "post", lambda *_args, **_kwargs: Response())

    result = subject.cli_workspace_command(
        None,
        {"executionId": "exec-1", "command": "printf healthy"},
    )

    assert result == {
        "success": True,
        "data": {
            "success": True,
            "result": {"exitCode": 0, "stdout": "healthy", "stderr": ""},
        },
    }


def test_preserves_transport_failure_as_allow_failure_data(monkeypatch):
    class FailedResponse(Response):
        status_code = 502
        text = "upstream unavailable"

    monkeypatch.setenv("INTERNAL_API_TOKEN", "internal-token")
    monkeypatch.setattr(subject, "start_activity_span", lambda *_args, **_kwargs: nullcontext())
    monkeypatch.setattr(subject, "set_current_span_attrs", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(subject.requests, "post", lambda *_args, **_kwargs: FailedResponse())

    result = subject.cli_workspace_command(
        None,
        {"executionId": "exec-1", "command": "false"},
    )

    assert result["success"] is False
    assert "gate dispatch error 502" in result["error"]
    assert result["data"]["success"] is False
    assert result["data"]["result"]["exitCode"] == -1
