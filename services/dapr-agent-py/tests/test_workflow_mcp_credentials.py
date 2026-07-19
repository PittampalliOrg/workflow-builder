import base64
import json

from src.workflow_mcp_credentials import (
    WorkflowMcpCredentialCache,
    workflow_mcp_token_refresh_due,
)


def test_credential_cache_is_private_and_resolves_candidate_instances() -> None:
    cache = WorkflowMcpCredentialCache()
    cache.remember("session-1", "signed-token")

    assert cache.lookup(["turn-1", "session-1"]) == "signed-token"
    assert "signed-token" not in repr(cache.__dict__.keys())

    cache.remember("session-1", None)
    assert cache.lookup(["session-1"]) == ""


def _token(exp: int) -> str:
    encoded = base64.urlsafe_b64encode(json.dumps({"exp": exp}).encode()).decode()
    return f"wfb_session_v3.{encoded.rstrip('=')}.signature"


def test_token_refresh_due_honors_expiry_and_refresh_window() -> None:
    assert not workflow_mcp_token_refresh_due(
        _token(10_000), now_seconds=1_000, refresh_ahead_seconds=300
    )
    assert workflow_mcp_token_refresh_due(
        _token(1_250), now_seconds=1_000, refresh_ahead_seconds=300
    )
    assert workflow_mcp_token_refresh_due("opaque", now_seconds=1_000)
