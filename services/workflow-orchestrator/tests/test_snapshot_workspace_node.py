from __future__ import annotations

from contextlib import nullcontext

from activities import snapshot_workspace_node as subject


class Response:
    def __init__(self, status_code: int = 200, payload: dict | None = None) -> None:
        self.status_code = status_code
        self.text = ""
        self.content = b"{}"
        self._payload = payload or {"job": "snap-1"}

    def json(self):
        return self._payload


def _patch_common(monkeypatch):
    monkeypatch.setenv("INTERNAL_API_TOKEN", "internal-token")
    monkeypatch.setattr(
        subject, "start_activity_span", lambda *_a, **_k: nullcontext()
    )


def test_snapshot_posts_and_returns_job(monkeypatch):
    _patch_common(monkeypatch)
    captured = {}

    def fake_post(url, json, headers, timeout):
        captured["url"] = url
        captured["json"] = json
        return Response(200, {"job": "snap-xyz"})

    monkeypatch.setattr(subject.requests, "post", fake_post)

    result = subject.snapshot_workspace_node(
        None,
        {
            "sharedWorkspaceKey": "exec_1",
            "snapshotId": "planning",
            "executionId": "exec_1",
        },
    )
    assert result == {
        "success": True,
        "key": "exec_1",
        "snapshotId": "planning",
        "job": "snap-xyz",
    }
    assert captured["url"].endswith("/api/internal/workspace/snapshot")
    assert captured["json"]["sharedWorkspaceKey"] == "exec_1"
    assert captured["json"]["snapshotId"] == "planning"


def test_snapshot_missing_fields_is_noop(monkeypatch):
    _patch_common(monkeypatch)
    monkeypatch.setattr(
        subject.requests,
        "post",
        lambda *_a, **_k: (_ for _ in ()).throw(AssertionError("must not POST")),
    )
    result = subject.snapshot_workspace_node(None, {"sharedWorkspaceKey": "exec_1"})
    assert result == {"success": True, "skipped": "missing_key_or_snapshot"}


def test_snapshot_http_error_never_raises(monkeypatch):
    _patch_common(monkeypatch)
    monkeypatch.setattr(
        subject.requests, "post", lambda *_a, **_k: Response(500, {})
    )
    result = subject.snapshot_workspace_node(
        None, {"sharedWorkspaceKey": "exec_1", "snapshotId": "plan"}
    )
    assert result["success"] is True
    assert result["skipped"] == "http_500"


def test_snapshot_transport_failure_never_raises(monkeypatch):
    _patch_common(monkeypatch)

    def boom(*_a, **_k):
        raise ConnectionError("unreachable")

    monkeypatch.setattr(subject.requests, "post", boom)
    result = subject.snapshot_workspace_node(
        None, {"sharedWorkspaceKey": "exec_1", "snapshotId": "plan"}
    )
    assert result["success"] is True
    assert result["skipped"] == "request_failed"


def test_snapshot_without_internal_token_skips(monkeypatch):
    monkeypatch.delenv("INTERNAL_API_TOKEN", raising=False)
    monkeypatch.setattr(
        subject, "start_activity_span", lambda *_a, **_k: nullcontext()
    )
    monkeypatch.setattr(
        subject.requests,
        "post",
        lambda *_a, **_k: (_ for _ in ()).throw(AssertionError("must not POST")),
    )
    result = subject.snapshot_workspace_node(
        None, {"sharedWorkspaceKey": "exec_1", "snapshotId": "plan"}
    )
    assert result == {"success": True, "skipped": "no_internal_token"}


def test_snapshot_activity_matches_the_autodiscovery_contract():
    # activities/__init__ auto-registers every module-level, non-underscore function
    # with exactly (ctx, input_data) params (see _is_activity). Assert the activity
    # satisfies that contract — so it IS discovered — WITHOUT importing the package-level
    # ACTIVITIES aggregate: under pytest's import mode `activities` resolves as a namespace
    # package (its __init__ never runs), so `from activities import ACTIVITIES` isn't
    # available in the test context even though it is in the app (run from the service root).
    import inspect

    fn = subject.snapshot_workspace_node
    assert inspect.isfunction(fn)
    assert not fn.__name__.startswith("_")
    assert fn.__module__.startswith("activities")
    assert len(inspect.signature(fn).parameters) == 2
