"""Environment configuration for the browser-use durable agent.

Mirrors the dapr-agent-py conventions (state store, pubsub, key prefixes) so
the service drops into the same Dapr Component scopes, and adds the
browser-use-specific knobs (CDP attach URL, step budget, vision).
"""

from __future__ import annotations

import os


def env_bool(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None or not raw.strip():
        return default
    return raw.strip().lower() in ("1", "true", "yes", "on")


def env_int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if raw is None or not raw.strip():
        return default
    try:
        return int(raw)
    except ValueError:
        return default


# ---------------------------------------------------------------------------
# Dapr / platform identity (same shape as services/dapr-agent-py)
# ---------------------------------------------------------------------------

AGENT_SERVICE_NAME = os.environ.get("AGENT_SERVICE_NAME", "browser-use-agent")
AGENT_STATE_STORE = os.environ.get("AGENT_STATE_STORE", "dapr-agent-py-statestore")
AGENT_STATE_KEY_PREFIX = os.environ.get(
    "AGENT_STATE_KEY_PREFIX", f"{AGENT_SERVICE_NAME}:_workflow"
)
AGENT_MEMORY_KEY_PREFIX = os.environ.get(
    "AGENT_MEMORY_KEY_PREFIX", f"{AGENT_SERVICE_NAME}:_memory"
)
AGENT_PUBSUB_NAME = os.environ.get("DAPR_PUBSUB_NAME", "pubsub")
AGENT_TOPIC = os.environ.get("AGENT_TOPIC", f"{AGENT_SERVICE_NAME}.requests")
AGENT_BROADCAST_TOPIC = os.environ.get(
    "AGENT_BROADCAST_TOPIC", f"{AGENT_SERVICE_NAME}.broadcast"
)
AGENT_REGISTRY_STORE = os.environ.get("AGENT_REGISTRY_STORE", "agent-registry")
AGENT_REGISTRY_TEAM = os.environ.get("AGENT_REGISTRY_TEAM", "default")

# Durable-state payload ceiling — matches the 16 MiB `dapr.io/max-body-size`
# on sandbox + orchestrator pods.
WORKFLOW_GRPC_MAX_MESSAGE_BYTES = env_int(
    "DAPR_WORKFLOW_GRPC_MAX_MESSAGE_BYTES", 16 * 1024 * 1024
)

# ---------------------------------------------------------------------------
# Browser attach (remote CDP; the chromium sidecar owns the browser)
# ---------------------------------------------------------------------------

BROWSER_CDP_URL = os.environ.get("BROWSER_USE_CDP_URL", "http://localhost:9222")

# ---------------------------------------------------------------------------
# browser-use loop tuning
# ---------------------------------------------------------------------------

# Step budget when agentConfig carries no maxTurns/maxIterations. One
# browser-use "step" = one vision-LLM call + up to MAX_ACTIONS_PER_STEP
# browser actions. Deliberately overridable per run — the frozen internal
# budget of the legacy image is one of the defects this service fixes.
DEFAULT_MAX_STEPS = env_int("BROWSER_USE_MAX_STEPS", 40)
USE_VISION = env_bool("BROWSER_USE_USE_VISION", True)
MAX_ACTIONS_PER_STEP = env_int("BROWSER_USE_MAX_ACTIONS_PER_STEP", 4)
MAX_HISTORY_ITEMS = env_int("BROWSER_USE_MAX_HISTORY_ITEMS", 40)
MAX_FAILURES = env_int("BROWSER_USE_MAX_FAILURES", 3)
CALCULATE_COST = env_bool("BROWSER_USE_CALCULATE_COST", False)
# Cap per-action tool_result payloads mirrored into session events / durable
# state. Full page extractions stay in the in-process browser-use history.
TOOL_RESULT_MAX_CHARS = env_int("BROWSER_USE_TOOL_RESULT_MAX_CHARS", 4000)

# ---------------------------------------------------------------------------
# Kimi K3 — the default LLM (platform model contract)
# ---------------------------------------------------------------------------

KIMI_BASE_URL = (
    os.environ.get("KIMI_BASE_URL", "").strip()
    or "https://api.kimi.com/coding/v1"
).rstrip("/")
KIMI_DEFAULT_MODEL = "kimi-k3"
# K3 is a reasoning model — a too-small completion cap yields empty output.
KIMI_MAX_COMPLETION_TOKENS = env_int("KIMI_MAX_COMPLETION_TOKENS", 32768)
# When true, degrade structured output to schema-in-prompt + parse instead of
# provider-native response_format (escape hatch if the endpoint rejects the
# dynamically-built AgentOutput json schema).
SCHEMA_IN_PROMPT = env_bool("BROWSER_USE_SCHEMA_IN_PROMPT", False)
