"""Contract tests for the pinned dapr-agents state-client factory."""

from __future__ import annotations


def test_state_client_factory_honors_inbound_message_size_env(monkeypatch) -> None:
    from dapr_agents.utils.dapr_client_factory import (
        INBOUND_MESSAGE_SIZE_ENV,
        dapr_client_kwargs,
    )

    monkeypatch.setenv(INBOUND_MESSAGE_SIZE_ENV, "16777216")

    assert dapr_client_kwargs()["max_grpc_message_length"] == 16777216
