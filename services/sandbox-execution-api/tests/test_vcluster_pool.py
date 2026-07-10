"""Retirement contract for the old profiled vCluster warm pool.

Agent-runtime SandboxWarmPools are unrelated and remain covered by their own
tests. PreviewEnvironment allocation is intentionally cold-only.
"""

from types import SimpleNamespace

import pytest

import src.app as app_module
from src.app import VclusterPreviewClaimRequest


def _request():
    return SimpleNamespace(headers={"authorization": "Bearer test-token"})


def test_preview_environment_pool_stays_disabled_when_legacy_env_is_set(
    monkeypatch,
) -> None:
    monkeypatch.setenv("VCLUSTER_PREVIEW_POOL_SIZE", "10")
    assert app_module._vcluster_preview_pool_size() == 0


def test_profiled_claim_is_rejected_before_any_cluster_mutation(monkeypatch) -> None:
    monkeypatch.setenv("SANDBOX_EXECUTION_API_TOKEN", "test-token")
    load = monkeypatch.setattr(
        app_module,
        "_load_k8s_clients",
        lambda: pytest.fail("claim retirement must precede Kubernetes access"),
    )
    assert load is None

    with pytest.raises(app_module.HTTPException) as caught:
        app_module.claim_vcluster_preview(
            _request(), VclusterPreviewClaimRequest(name="retired")
        )

    assert caught.value.status_code == 409
    assert "warm pools are retired" in str(caught.value.detail)


def test_pool_manager_never_starts(monkeypatch) -> None:
    monkeypatch.setenv("VCLUSTER_PREVIEW_POOL_SIZE", "10")
    monkeypatch.setattr(
        app_module.threading,
        "Thread",
        lambda **_kwargs: pytest.fail("retired pool manager must not start"),
    )
    app_module._pool_manager_started = False
    app_module._start_pool_manager()
    assert app_module._pool_manager_started is False
