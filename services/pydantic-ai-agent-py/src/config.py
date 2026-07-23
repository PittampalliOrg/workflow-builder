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
DURABLE_ACTIVITY_TRANSPORT_RESERVE_BYTES = min(
    max(0, WORKFLOW_GRPC_MAX_MESSAGE_BYTES - 1),
    max(
        0,
        env_int(
            "PYDANTIC_AI_DURABLE_ACTIVITY_TRANSPORT_RESERVE_BYTES",
            256 * 1024,
        ),
    ),
)
DURABLE_ACTIVITY_MAX_BYTES = max(
    1, WORKFLOW_GRPC_MAX_MESSAGE_BYTES - DURABLE_ACTIVITY_TRANSPORT_RESERVE_BYTES
)
# Private session context (including MCP credentials) stays inside Dapr
# history, never the agent-readable workspace. Bound its one-copy activity
# representation so forty K3 iterations still remain below the gRPC ceiling.
DURABLE_CONTEXT_MAX_BYTES = min(
    DURABLE_ACTIVITY_MAX_BYTES,
    16 * 1024,
    max(1, env_int("PYDANTIC_AI_DURABLE_CONTEXT_MAX_BYTES", 16 * 1024)),
)
DURABLE_TOOL_CONTEXT_MAX_BYTES = min(
    DURABLE_CONTEXT_MAX_BYTES,
    8 * 1024,
    max(1, env_int("PYDANTIC_AI_DURABLE_TOOL_CONTEXT_MAX_BYTES", 8 * 1024)),
)
DURABLE_TASK_MAX_BYTES = min(
    DURABLE_ACTIVITY_MAX_BYTES,
    512 * 1024,
    max(1, env_int("PYDANTIC_AI_DURABLE_TASK_MAX_BYTES", 512 * 1024)),
)
DURABLE_HISTORY_RESERVE_BYTES = min(
    max(0, WORKFLOW_GRPC_MAX_MESSAGE_BYTES - 1),
    max(
        0,
        env_int("PYDANTIC_AI_DURABLE_HISTORY_RESERVE_BYTES", 2 * 1024 * 1024),
    ),
)
DURABLE_HISTORY_MAX_BYTES = max(
    1, WORKFLOW_GRPC_MAX_MESSAGE_BYTES - DURABLE_HISTORY_RESERVE_BYTES
)
DURABLE_HISTORY_KEEP_BYTES = min(
    DURABLE_HISTORY_MAX_BYTES,
    max(
        1,
        env_int(
            "PYDANTIC_AI_DURABLE_HISTORY_KEEP_BYTES",
            max(1, DURABLE_HISTORY_MAX_BYTES - 2 * 1024 * 1024),
        ),
    ),
)

# Reference-backed transcripts live on the per-execution workspace PVC rather
# than in Dapr workflow payloads. Keep this storage policy independent from the
# gRPC envelope ceiling so long K3 histories can remain exact on disk.
TRANSCRIPT_MAX_BYTES = max(
    1,
    env_int("PYDANTIC_AI_TRANSCRIPT_MAX_BYTES", 64 * 1024 * 1024),
)
TRANSCRIPT_KEEP_BYTES = min(
    TRANSCRIPT_MAX_BYTES,
    max(
        1,
        env_int("PYDANTIC_AI_TRANSCRIPT_KEEP_BYTES", 48 * 1024 * 1024),
    ),
)

# ---------------------------------------------------------------------------
# Agent loop
# ---------------------------------------------------------------------------

# One iteration = one LLM message (call_llm activity); tool calls fan out as
# their own activities. agentConfig.maxTurns/maxIterations override per run.
MAX_ITERATIONS_PER_TURN = 120
# The exact Dapr protobuf budget proof leaves at least 2 MiB of gRPC headroom
# through 40 worst-case iterations. Longer public turn budgets continue-as-new
# only between fully committed iterations so each execution history stays safe.
DURABLE_HISTORY_ITERATIONS_PER_SEGMENT = 40
DEFAULT_MAX_ITERATIONS = min(
    MAX_ITERATIONS_PER_TURN,
    max(1, env_int("PYDANTIC_AI_MAX_ITERATIONS", MAX_ITERATIONS_PER_TURN)),
)
MAX_TOOL_CALLS_PER_RESPONSE = min(
    8,
    max(1, env_int("PYDANTIC_AI_MAX_TOOL_CALLS_PER_RESPONSE", 8)),
)
TOOL_DESCRIPTOR_MAX_BYTES = 256
WORKFLOW_IDENTIFIER_MAX_BYTES = 256
DURABLE_ERROR_MAX_BYTES = 2 * 1024
TOOL_ERROR_MAX_BYTES = DURABLE_ERROR_MAX_BYTES
TERMINAL_CONTENT_MAX_BYTES = 256 * 1024
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
# Cap tool output text copied into telemetry and session events. Durable model
# history is bounded by OverflowingToolOutput plus exact activity-envelope sizing.
TOOL_RESULT_MAX_CHARS = env_int("PYDANTIC_AI_TOOL_RESULT_MAX_CHARS", 8000)
# All not-yet-observed visual results are eligible for their first model turn;
# later turns keep only the latest seen images. MCP media can be reacquired by
# invoking its originating tool rather than reading a workspace path.
MEDIA_HISTORY_MAX_IMAGES = env_int("PYDANTIC_AI_MEDIA_HISTORY_MAX_IMAGES", 3)
MEDIA_REQUEST_MAX_IMAGES = env_int("PYDANTIC_AI_MEDIA_REQUEST_MAX_IMAGES", 8)
MEDIA_REQUEST_MAX_BYTES = env_int(
    "PYDANTIC_AI_MEDIA_REQUEST_MAX_BYTES", 32 * 1024 * 1024
)

# ---------------------------------------------------------------------------
# Harness hook capabilities (hosted inside the durable activities)
# ---------------------------------------------------------------------------

# OverflowingToolOutput: big tool results spill to a LocalFileStore under
# <workspace>/.overflow (readable later via the read_tool_result tool) and
# are truncated in-history — protects the 16 MiB workflow payload ceiling.
OVERFLOW_ENABLED = env_bool("PYDANTIC_AI_OVERFLOW_ENABLED", True)
# Unified K3 history window: evict complete old messages/tool pairs without
# mutating retained provider responses. Deterministic (no LLM summary call).
COMPACTION_ENABLED = env_bool("PYDANTIC_AI_COMPACTION_ENABLED", True)
COMPACTION_MAX_MESSAGES = env_int("PYDANTIC_AI_COMPACTION_MAX_MESSAGES", 120)
COMPACTION_KEEP_MESSAGES = env_int("PYDANTIC_AI_COMPACTION_KEEP_MESSAGES", 60)

# Outer deadline for an MCP tool call. Browser tools can own long bounded
# operations (capture finalization is up to 420s), so dev raises the existing
# env knob to 480s.
MCP_CALL_TIMEOUT_SECONDS = env_int("PYDANTIC_AI_MCP_TIMEOUT_SECONDS", 30)
# Discovery remains short and fail-soft. A slow or broken server must not tax
# every model turn merely because long tool calls are permitted.
MCP_LIST_TIMEOUT_SECONDS = env_int("PYDANTIC_AI_MCP_LIST_TIMEOUT_SECONDS", 30)
# FastMCP owns an inner read deadline. Keep it below the outer activity guard
# so client cleanup finishes deterministically before the activity deadline.
_MCP_READ_TIMEOUT_CEILING = max(MCP_CALL_TIMEOUT_SECONDS - 1, 1)
MCP_READ_TIMEOUT_SECONDS = min(
    max(
        env_int(
            "PYDANTIC_AI_MCP_READ_TIMEOUT_SECONDS",
            max(MCP_CALL_TIMEOUT_SECONDS - 10, 1),
        ),
        1,
    ),
    _MCP_READ_TIMEOUT_CEILING,
)
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
KIMI_K3_MAX_CONTEXT_WINDOW = 1_048_576
KIMI_K3_MAX_COMPLETION_TOKENS = 1_048_576


def bounded_kimi_token_limits(
    context_window: int, completion_tokens: int
) -> tuple[int, int]:
    """Clamp operator overrides to K3's provider contract."""

    bounded_context = min(
        KIMI_K3_MAX_CONTEXT_WINDOW,
        max(2, int(context_window)),
    )
    bounded_completion = min(
        KIMI_K3_MAX_COMPLETION_TOKENS,
        bounded_context - 1,
        max(1, int(completion_tokens)),
    )
    return bounded_context, bounded_completion


KIMI_CONTEXT_WINDOW, KIMI_MAX_COMPLETION_TOKENS = bounded_kimi_token_limits(
    env_int("KIMI_CONTEXT_WINDOW", KIMI_K3_MAX_CONTEXT_WINDOW),
    env_int("KIMI_MAX_COMPLETION_TOKENS", 131_072),
)
# Reserve the completion budget and provider/tool-schema headroom before a
# request enters K3's shared input+output context window.
KIMI_INPUT_SAFETY_BUFFER_TOKENS = min(
    KIMI_CONTEXT_WINDOW - KIMI_MAX_COMPLETION_TOKENS - 1,
    max(0, env_int("KIMI_INPUT_SAFETY_BUFFER_TOKENS", 13_000)),
)
KIMI_MAX_INPUT_TOKENS = (
    KIMI_CONTEXT_WINDOW - KIMI_MAX_COMPLETION_TOKENS - KIMI_INPUT_SAFETY_BUFFER_TOKENS
)
KIMI_COMPACTION_KEEP_TOKENS = min(
    KIMI_MAX_INPUT_TOKENS,
    max(
        1,
        env_int(
            "PYDANTIC_AI_COMPACTION_KEEP_TOKENS",
            KIMI_MAX_INPUT_TOKENS - 32_768,
        ),
    ),
)
# K3 max-reasoning requests can remain silent for 15-25 minutes. This is the
# total blocking request timeout; activity retries remain the transport retry.
KIMI_TIMEOUT_SECONDS = env_int("KIMI_TIMEOUT_SECONDS", 1800)
# K3 thinking responses can exceed intermediary non-streaming response limits.
# Stream on the wire, then persist only the assembled ModelResponse at the
# existing durable activity boundary. Keep an emergency rollback knob.
KIMI_STREAMING_ENABLED = env_bool("KIMI_STREAMING_ENABLED", True)
