"""Environment configuration for the pydantic-ai durable agent.

Mirrors the dapr-agent-py / browser-use-agent conventions (state store,
pubsub, key prefixes) so the service drops into the same Dapr Component
scopes, plus the pydantic-ai/kimi knobs. Workspace is POD-LOCAL
(workspaceBackend pod-local): harness FileSystem/Shell execute in this
container's own filesystem rooted at WORKSPACE_ROOT.
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
# Dapr / platform identity
# ---------------------------------------------------------------------------

AGENT_SERVICE_NAME = os.environ.get("AGENT_SERVICE_NAME", "pydantic-ai-agent-py")
AGENT_STATE_STORE = os.environ.get("AGENT_STATE_STORE", "dapr-agent-py-statestore")
WORKFLOW_GRPC_MAX_MESSAGE_BYTES = env_int(
    "DAPR_WORKFLOW_GRPC_MAX_MESSAGE_BYTES", 16 * 1024 * 1024
)

# ---------------------------------------------------------------------------
# Agent loop
# ---------------------------------------------------------------------------

# One iteration = one LLM message (call_llm activity); tool calls fan out as
# their own activities. agentConfig.maxTurns/maxIterations override per run.
DEFAULT_MAX_ITERATIONS = env_int("PYDANTIC_AI_MAX_ITERATIONS", 40)
# Pod-local workspace the harness FileSystem/Shell capabilities are rooted at.
WORKSPACE_ROOT = os.environ.get("PYDANTIC_AI_WORKSPACE_ROOT", "/sandbox")
SHELL_TIMEOUT_SECONDS = env_int("PYDANTIC_AI_SHELL_TIMEOUT_SECONDS", 120)
# Cap tool outputs mirrored into durable history / session events. Full
# outputs stay in the tool's own return to the model for the current turn.
TOOL_RESULT_MAX_CHARS = env_int("PYDANTIC_AI_TOOL_RESULT_MAX_CHARS", 8000)

# ---------------------------------------------------------------------------
# Harness hook capabilities (hosted inside the durable activities)
# ---------------------------------------------------------------------------

# OverflowingToolOutput: big tool results spill to a LocalFileStore under
# <workspace>/.overflow (readable later via the read_tool_result tool) and
# are truncated in-history — protects the 16 MiB workflow payload ceiling.
OVERFLOW_ENABLED = env_bool("PYDANTIC_AI_OVERFLOW_ENABLED", True)
# Compaction chain (before_model_request, in order): clamp oversized parts,
# then slide the window. Deterministic (no LLM summarization) in v1.
COMPACTION_ENABLED = env_bool("PYDANTIC_AI_COMPACTION_ENABLED", True)
CLAMP_MAX_PART_CHARS = env_int("PYDANTIC_AI_CLAMP_MAX_PART_CHARS", 20000)
COMPACTION_MAX_MESSAGES = env_int("PYDANTIC_AI_COMPACTION_MAX_MESSAGES", 120)
COMPACTION_KEEP_MESSAGES = env_int("PYDANTIC_AI_COMPACTION_KEEP_MESSAGES", 60)

# ---------------------------------------------------------------------------
# Kimi K3 — the default (and only v1) provider
# ---------------------------------------------------------------------------

KIMI_BASE_URL = (
    os.environ.get("KIMI_BASE_URL", "").strip() or "https://api.kimi.com/coding/v1"
).rstrip("/")
KIMI_DEFAULT_MODEL = "kimi-k3"
KIMI_TIMEOUT_SECONDS = env_int("KIMI_TIMEOUT_SECONDS", 300)
