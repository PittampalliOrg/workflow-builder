"""ReadSessionEvents tool — slice the CMA session event log positionally.

Ports Anthropic's Managed-Agents ``getEvents(id, range)`` primitive into
our Dapr-durable harness. Instead of compacting messages irreversibly,
the brain can re-fetch earlier events from the durable session log when
it needs to rewind before a tool call, reread context before a decision,
or pick up from where it last stopped reading.

Design notes
------------
* This tool is only meaningful when ``agentConfig.contextStrategy ==
  "event_log"``. When the default ``compaction`` strategy is active, the
  tool is still registered but the agent isn't told about it in its
  system prompt. We ship both strategies and let the agent config pick
  one per run — see ``src/compaction/config.py``.
* Session id is read from the process-local ``OpenShellRuntime`` that
  ``session_workflow`` stamps at entry. The agent never passes session
  ids explicitly — each tool invocation is scoped to the caller's own
  session, preventing cross-session reads.
* Reads go through the workflow-builder BFF via Dapr service invoke
  (``POST /v1.0/invoke/workflow-builder/method/api/internal/sessions/<id>/events``).
  No direct DB access from dapr-agent-py — preserves the "harness has
  no DB driver" invariant and reuses the existing internal-auth shim.
* Dapr activity-level durability: the tool is wrapped by the
  DurableAgent's ``run_tool`` activity, so its output lands in the
  workflow's event log like any other tool call. Replays hit the
  recorded result, not a live HTTP call.
"""

from __future__ import annotations

import json
import logging
import os
from typing import Any

from dapr.clients import DaprClient

from src.openshell_runtime import get_runtime

logger = logging.getLogger(__name__)

_WORKFLOW_BUILDER_APP_ID = os.environ.get(
    "WORKFLOW_BUILDER_APP_ID", "workflow-builder"
)
_INTERNAL_TOKEN_ENV = "INTERNAL_API_TOKEN"


def read_session_events(
    after_sequence: int | None = None, limit: int = 100
) -> str:
    """Read session events for the current session, positional slice.

    Use this when your context window is missing information from earlier
    in the conversation and you need to pull specific events back in.
    Prefer this over compaction when the full event history is useful.

    Args:
        after_sequence: Return events with sequence strictly greater than
            this cursor. Omit to get events starting from the beginning.
        limit: Max events to return (default 100, max 500).

    Returns:
        JSON-serialized envelope:
            {"sessionId": "...", "events": [...], "nextAfterSequence": N,
             "returned": N, "limit": N}
    """
    runtime = get_runtime()
    session_id = runtime.session_id
    if not session_id:
        return json.dumps(
            {
                "error": (
                    "read_session_events requires an active CMA session. "
                    "This agent run is not bound to a session — nothing to "
                    "read."
                )
            }
        )

    token = os.environ.get(_INTERNAL_TOKEN_ENV, "").strip()
    if not token:
        return json.dumps(
            {
                "error": (
                    "INTERNAL_API_TOKEN not configured; the BFF read "
                    "endpoint requires internal-token auth."
                )
            }
        )

    # Pass the path and query separately. Newer Dapr Python SDKs expose
    # service-invoke headers as metadata, not as a `headers=` kwarg.
    params: dict[str, Any] = {}
    if after_sequence is not None:
        try:
            params["afterSequence"] = int(after_sequence)
        except (TypeError, ValueError):
            return json.dumps({"error": "after_sequence must be an integer"})
    params["limit"] = max(1, min(int(limit or 100), 500))
    query = tuple((k, str(v)) for k, v in params.items())
    method = f"api/internal/sessions/{session_id}/events"

    try:
        with DaprClient() as client:
            response = client.invoke_method(
                app_id=_WORKFLOW_BUILDER_APP_ID,
                method_name=method,
                http_verb="GET",
                metadata=(("x-internal-token", token),),
                http_querystring=query,
                timeout=15,
            )
            text = (
                response.text()
                if hasattr(response, "text")
                else response.data.decode("utf-8")
            )
            return text or json.dumps({"error": "empty response"})
    except Exception as exc:  # noqa: BLE001
        logger.warning(
            "[read_session_events] invoke failed for session %s: %s",
            session_id,
            exc,
        )
        return json.dumps({"error": f"read_session_events failed: {exc}"})
