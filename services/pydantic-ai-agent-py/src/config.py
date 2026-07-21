"""Environment configuration for the pydantic-ai durable agent.

Mirrors the dapr-agent-py / browser-use-agent conventions (state store,
pubsub, key prefixes) so the service drops into the same Dapr Component
scopes, plus the pydantic-ai/kimi knobs. Harness FileSystem/Shell execute in
this container's own filesystem rooted at WORKSPACE_ROOT — the pod-local
durable scratch (/sandbox) by default, or the per-execution JuiceFS shared
workspace (/sandbox/work) when the pydantic-ai-agent-py execution class
wires one (registry workspaceBackend: juicefs-shared).
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


def env_list(name: str, default: list[str]) -> list[str]:
    raw = os.environ.get(name)
    if raw is None or not raw.strip():
        return default
    return [item.strip() for item in raw.split(",") if item.strip()]


# Glob names scrubbed from the Shell subprocess's INHERITED env (via
# `denied_env_patterns` — keeps PATH/HOME, strips only matches), so an
# agent-run command (e.g. `env`, `echo $KIMI_API_KEY`) can't exfiltrate the
# pod's credentials. Provider prefixes + the platform secrets the harness
# default list omits (KIMI/ANTHROPIC model auth, internal token, AP
# encryption key, JWT signer, DB URL). `*_API_KEY` catches every provider
# key generically. Override with a comma-separated env list.
SHELL_DENIED_ENV_PATTERNS = env_list(
    "PYDANTIC_AI_SHELL_DENIED_ENV_PATTERNS",
    [
        "*_API_KEY",
        "*_SECRET",
        "*_SECRET_KEY",
        "KIMI_*",
        "ANTHROPIC_*",
        "OPENAI_*",
        "DEEPSEEK_*",
        "ZAI_*",
        "GLM_*",
        "MOONSHOT_*",
        "GATEWAY_*",
        "GOOGLE_*",
        "GEMINI_*",
        "NVIDIA_*",
        "TOGETHER_*",
        "ALIBABA_*",
        "INTERNAL_API_TOKEN",
        "AP_ENCRYPTION_KEY",
        "JWT_SIGNING_KEY",
        "DATABASE_URL",
        "*_DATABASE_URL",
    ],
)
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

# Total per-operation timeout for network (MCP) toolset get_tools/call_tool.
# Upstream MCP ClientSession has no per-call timeout, so a stalled
# streamable-HTTP session would otherwise wedge a durable activity forever.
MCP_TIMEOUT_SECONDS = env_int("PYDANTIC_AI_MCP_TIMEOUT_SECONDS", 30)
# MCP LISTING caches (per pod): successes reused for the session's activities,
# failing servers skipped without re-probing. See ToolRouter.tools().
MCP_TOOLS_CACHE_SECONDS = env_int("PYDANTIC_AI_MCP_TOOLS_CACHE_SECONDS", 300)
# RepoContext inventory tool (+ its "read and translate it" system-prompt hint)
# — default OFF: the hint reads as a standing mission and hijacks vague turns.
REPO_INVENTORY_TOOL_ENABLED = env_bool("PYDANTIC_AI_REPO_INVENTORY_TOOL", False)
MCP_FAIL_CACHE_SECONDS = env_int("PYDANTIC_AI_MCP_FAIL_CACHE_SECONDS", 120)

# ---------------------------------------------------------------------------
# Kimi K3 — the default (and only v1) provider
# ---------------------------------------------------------------------------

KIMI_BASE_URL = (
    os.environ.get("KIMI_BASE_URL", "").strip() or "https://api.kimi.com/coding/v1"
).rstrip("/")
KIMI_DEFAULT_MODEL = "kimi-k3"
KIMI_TIMEOUT_SECONDS = env_int("KIMI_TIMEOUT_SECONDS", 300)
