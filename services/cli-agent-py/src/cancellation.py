"""Cooperative session-cancellation persistence for cli-agent-py.

Near-verbatim port of claude-agent-py's cancellation surface
(services/claude-agent-py/src/cancellation.py) so the BFF lifecycle controller +
benchmark cascade can cooperatively stop a CLI run: the raise-event endpoint
persists a ``session-cancel:{instance}`` flag when a terminal control event
(``session.terminate`` / ``user.interrupt``) arrives, and the lifecycle workflow
reads that flag on its idle-probe path via ``check_cancellation_activity``.

Lives in its own module so both main.py (write side + activity registration) and
session_workflow.py (the probe-path check) can import it without a cycle.
"""
from __future__ import annotations

import json
import os
import re
import urllib.parse
import urllib.request
from typing import Any

# Non-actor agent/session state store visible to the per-session sandbox daprd.
AGENT_STATE_STORE = os.environ.get("AGENT_STATE_STORE", "dapr-agent-py-statestore")

# Terminal control events that cooperatively stop a run. Sent by the BFF
# lifecycle controller / benchmark cascade as direct events; mapped onto the
# session.lifecycle_events lane so the lifecycle workflow's batch loop sees them.
TERMINAL_CONTROL_EVENT_TYPES = {
    "session.terminate",
    "user.interrupt",
}


def _session_cancel_state_key(instance_id: str) -> str:
    return f"session-cancel:{instance_id}"


def _cancellation_candidate_ids(instance_id: str) -> list[str]:
    """Flag lookup keys for a durable instance id: the exact id, then the base
    session id (stripping a ``__turn__N`` / ``:turn-N`` suffix) so a flag written
    under the session instance is still found if a turn-scoped id reads it."""
    text = str(instance_id or "").strip()
    if not text:
        return []
    ids = [text]
    base = re.sub(r"__turn__\d+$", "", text)
    base = re.sub(r":turn-\d+$", "", base)
    if base and base != text and base not in ids:
        ids.append(base)
    return ids


def _dapr_sidecar() -> str:
    return (
        f"http://{os.environ.get('DAPR_HOST', '127.0.0.1')}:"
        f"{os.environ.get('DAPR_HTTP_PORT', '3500')}"
    )


def _save_agent_state_key(key: str, value: Any) -> None:
    encoded_key = urllib.parse.quote(key, safe="")
    payload = json.dumps(
        [{"key": key, "value": value, "metadata": {"partitionKey": encoded_key}}]
    ).encode("utf-8")
    req = urllib.request.Request(
        f"{_dapr_sidecar()}/v1.0/state/{urllib.parse.quote(AGENT_STATE_STORE, safe='')}",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    urllib.request.urlopen(req, timeout=5)


def _read_agent_state_key(key: str, timeout_seconds: float = 5) -> Any:
    encoded_key = urllib.parse.quote(key, safe="")
    url = (
        f"{_dapr_sidecar()}/v1.0/state/{urllib.parse.quote(AGENT_STATE_STORE, safe='')}/{encoded_key}"
        f"?metadata.partitionKey={encoded_key}"
    )
    try:
        with urllib.request.urlopen(url, timeout=timeout_seconds) as response:
            raw = response.read().decode("utf-8")
    except Exception:
        return None
    if not raw:
        return None
    try:
        return json.loads(raw)
    except Exception:
        return None


def _save_session_cancellation_request(
    instance_id: str,
    event_name: str,
    payload: Any,
) -> None:
    event: dict[str, Any] = {"type": event_name}
    if isinstance(payload, dict):
        event.update(payload)
    else:
        event["data"] = payload
    _save_agent_state_key(_session_cancel_state_key(instance_id), event)


def check_cancellation_for_instance(instance_id: str) -> dict[str, Any]:
    text = str(instance_id or "").strip()
    if not text:
        return {"cancelled": False, "reason": "no_instance_id"}
    for key_id in _cancellation_candidate_ids(text):
        request = _read_agent_state_key(
            _session_cancel_state_key(key_id), timeout_seconds=1
        )
        if isinstance(request, dict):
            return {"cancelled": True, "request": request}
    return {"cancelled": False}


def check_cancellation_activity(ctx, payload: dict[str, Any]) -> dict[str, Any]:
    """Dapr workflow activity wrapper — the workflow can't read state directly."""
    data = payload or {}
    instance_id = str(data.get("instanceId") or data.get("instance_id") or "").strip()
    return check_cancellation_for_instance(instance_id)
