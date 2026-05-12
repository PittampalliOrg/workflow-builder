"""Env-var names and defaults for adk-agent-py.

Parallel to `DAPR_AGENT_PY_*` from `services/dapr-agent-py/`. Falls back to the
dapr-agent-py names where useful (MCP bootstrap) so the BFF cutover doesn't
require renaming env vars in the existing `dapr-agent-py-config` ConfigMap.
"""

from __future__ import annotations

import os


def _int_env(name: str, default: int) -> int:
    raw = (os.environ.get(name) or "").strip()
    if not raw:
        return default
    try:
        return int(raw)
    except ValueError:
        return default


# --- Runtime / model ---------------------------------------------------------
# Default model. Plan locks in Gemini 3 Pro Preview; precise model ID is
# overridable at deploy time via ConfigMap. `google.genai.Client` resolves the
# string against Google's Gemini API.
DEFAULT_MODEL: str = (
    os.environ.get("ADK_AGENT_PY_DEFAULT_MODEL") or "gemini-3-pro-preview"
).strip() or "gemini-3-pro-preview"

# Diagrid's `agent_workflow` loops up to this many LLM calls before bailing
# out with `max_iterations_reached`. Matches dapr-agent-py's default of 120.
MAX_ITERATIONS: int = _int_env("ADK_AGENT_PY_MAX_ITERATIONS", 120)


# --- Durability safety nets --------------------------------------------------
# Outer `session_workflow` wraps each `ctx.call_child_workflow(diagrid_workflow,
# ...)` call in `when_any([child, timer])`. Past this many seconds without a
# child completion the timer fires and we raise AgentError. Default mirrors
# dapr-agent-py.
SESSION_TURN_TIMEOUT_SECONDS: int = _int_env(
    "ADK_AGENT_PY_SESSION_TURN_TIMEOUT_SECONDS", 600
)

# Sandbox-execution-api stamps `WORKFLOW_BUILDER_TRACEPARENT` on the pod from
# the BFF inbound request; telemetry.providers honors it. The heartbeat env
# is reserved for parity with dapr-agent-py and is not wired yet.
SESSION_TURN_HEARTBEAT_SECONDS: int = _int_env(
    "ADK_AGENT_PY_SESSION_TURN_HEARTBEAT_SECONDS", 60
)

# Image tool_result compaction — Gemini's 1M-token context window can still be
# exceeded with many screenshots. `session_workflow` runs the compactor on the
# `messages` list before the child activity reads it.
MAX_IMAGE_TOOL_RESULTS: int = _int_env("ADK_AGENT_PY_MAX_IMAGE_TOOL_RESULTS", 3)

# Maximum size of any single Dapr workflow event envelope (bytes). Larger
# envelopes are summarised to a preview field. Parity with dapr-agent-py.
MAX_ENVELOPE_BYTES: int = _int_env("ADK_AGENT_PY_MAX_ENVELOPE_BYTES", 262_144)


# --- MCP bootstrap -----------------------------------------------------------
# JSON list of MCP server configs (name, transport, url/command, args, env,
# headers). Format identical to `DAPR_AGENT_PY_BOOTSTRAP_MCP_SERVERS_JSON`;
# falls back to that env var so the BFF can keep writing the same key.
BOOTSTRAP_MCP_SERVERS_JSON: str = (
    os.environ.get("ADK_AGENT_PY_BOOTSTRAP_MCP_SERVERS_JSON")
    or os.environ.get("DAPR_AGENT_PY_BOOTSTRAP_MCP_SERVERS_JSON")
    or ""
).strip()


# --- Identity / Dapr ---------------------------------------------------------
AGENT_SLUG: str = (
    os.environ.get("AGENT_SLUG")
    or os.environ.get("DAPR_APP_ID")
    or os.environ.get("WORKFLOW_BUILDER_APP_ID")
    or "adk-agent-py"
)

# Pub/sub component name used by `event_publisher.py` for the legacy stream;
# session events go through the BFF ingest endpoint, not pub/sub, so this is
# only kept for parity with dapr-agent-py's plumbing.
DAPR_PUBSUB_NAME: str = (
    os.environ.get("DAPR_PUBSUB_NAME") or "agent-pubsub"
).strip()
