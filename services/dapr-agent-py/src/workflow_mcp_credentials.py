"""Private per-instance Workflow MCP credentials.

This cache is deliberately separate from runtime inspection/audit context. The
signed token is persisted only in the existing private runtime-context state and
is rehydrated into this cache by the agent's state adapter.
"""

from __future__ import annotations

import threading
import base64
import json
import time
from collections.abc import Iterable


class WorkflowMcpCredentialCache:
    def __init__(self) -> None:
        self._tokens: dict[str, str] = {}
        self._lock = threading.RLock()

    def remember(self, instance_id: str, token: object) -> None:
        key = str(instance_id or "").strip()
        if not key:
            return
        value = str(token or "").strip()
        with self._lock:
            if value:
                self._tokens[key] = value
            else:
                self._tokens.pop(key, None)

    def lookup(self, instance_ids: Iterable[str]) -> str:
        with self._lock:
            for instance_id in instance_ids:
                token = self._tokens.get(str(instance_id or "").strip(), "")
                if token:
                    return token
        return ""


def workflow_mcp_token_refresh_due(
    token: object,
    *,
    now_seconds: int | None = None,
    refresh_ahead_seconds: int = 300,
) -> bool:
    """Treat an opaque/malformed token as due; the BFF remains authoritative."""
    value = str(token or "").strip()
    try:
        parts = value.split(".")
        if len(parts) != 3:
            return True
        encoded = parts[1]
        padding = "=" * (-len(encoded) % 4)
        payload = json.loads(
            base64.urlsafe_b64decode(f"{encoded}{padding}").decode("utf-8")
        )
        expires_at = int(payload["exp"])
    except (KeyError, TypeError, ValueError, json.JSONDecodeError):
        return True
    now = int(time.time()) if now_seconds is None else now_seconds
    return expires_at <= now + max(0, refresh_ahead_seconds)
