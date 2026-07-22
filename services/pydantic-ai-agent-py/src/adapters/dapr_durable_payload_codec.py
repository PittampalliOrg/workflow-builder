"""Dapr durable-task payload sizing adapter."""

from __future__ import annotations

from typing import Any

from dapr.ext.workflow._durabletask.internal.shared import to_json


class DaprDurablePayloadCodecAdapter:
    def size_bytes(self, payload: Any) -> int:
        return len(to_json(payload).encode("utf-8"))
