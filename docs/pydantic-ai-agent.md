# pydantic-ai-agent-py — durable Pydantic AI coding agent

**Runtime SSOT** for `services/pydantic-ai-agent-py/`: a substitute for
dapr-agent-py built on **pydantic-ai 2.x (pydantic v2) + pydantic-ai-harness**,
with Dapr durable execution where **every LLM message and every tool call runs
as its own Dapr workflow activity**.

## Architecture

The durable shape follows the **Diagrid python-ai** reference
(`diagrid/agent/pydantic_ai/`, local checkout `~/repos/diagridio/python-ai/main`):
one workflow (`agent_workflow`) + named activities, full message history as
JSON across every boundary.

```
session_workflow (platform contract wrapper, literal name)
  └─ agent_workflow (__turn__N child per auto-terminate turn)
       loop (≤ maxIterations):
         ├─ check_cancellation  activity  (session-cancel:{instance} key)
         ├─ call_llm            activity  (ONE LLM message)
         └─ execute_tool        activity  ×N per tool call — when_all fan-out
```

- `call_llm` speaks through **pydantic-ai's own model classes**
  (`OpenAIChatModel` + `OpenAIProvider` → Kimi-for-Coding), not the raw
  OpenAI SDK. History is pydantic-ai's native `ModelMessage` list, encoded
  with `ModelMessagesTypeAdapter` (`src/messages_io.py`) — tool calls,
  returns, and usage survive replay faithfully.
- Retry policy on every activity: 3 attempts, 2s first interval, 2.0 backoff,
  30s cap (`src/workflow.py:RETRY_POLICY`).
- The iteration-0 `call_llm` **bootstraps** the message list (system prompt =
  `agentConfig.systemPrompt` + capability instructions) so the workflow body
  stays deterministic/pure — the workflow never does I/O.

## Deltas from the Diagrid reference

| Diagrid python-ai | This runtime | Why |
|---|---|---|
| Raw `openai.chat.completions` in the activity, model as a bare string | pydantic-ai `OpenAIChatModel`/`OpenAIProvider` + `ModelSettings` | keeps provider flexibility, usage accounting, native message types |
| Hand-rolled `Message` dataclasses | native `ModelMessage` + `ModelMessagesTypeAdapter` | faithful pydantic-ai history, no re-implementation drift |
| Tools = plain callables introspected off the Agent | **harness capabilities → `get_toolset()`** (see below) | first-class coding-agent tool surface |
| No cancellation, no platform events | `check_cancellation` activity + CMA session-event mirroring | platform lifecycle + observability contract |
| `runner.run_async` embedded host | platform `session_workflow` + `/internal/sessions/spawn` bridge | `durable/run` dispatch parity |

## Tools: pydantic-ai-harness capabilities

Capabilities are extracted through the public `AbstractCapability.get_toolset()`
seam (`src/toolsets.py`) and routed by name in the `execute_tool` activity:

- **FileSystem** (rooted at `PYDANTIC_AI_WORKSPACE_ROOT`, default `/sandbox`,
  **pod-local** — `workspaceBackend: pod-local` like claude-agent-py/adk):
  `read_file, write_file, edit_file, list_directory, search_files, find_files,
  create_directory, file_info` — mirrors dapr-agent-py's file builtins.
- **Shell** (same root): `run_command, start_command, check_command,
  stop_command` — mirrors `execute_command`.
- **RepoContext**: CLAUDE.md/AGENTS.md instructions folded into the system
  prompt (instruction contributor; may also expose an inventory tool).
- **MCP**: `agentConfig.mcpServers` entries with `streamable_http` URLs are
  wired via the core `MCP` capability; stdio servers are skipped in v1.

**Granularity note (goal constraint):** every capability above splits cleanly —
each tool call is its own activity. Capabilities that intrinsically wrap the
model call or the whole run (`CodeMode`, `Planning`, `Memory`, `Guardrails`,
compaction) are **not enabled in v1**: they hook `wrap_model_request`/
`wrap_run`, which would execute coarser than per-activity granularity. Enable
them later by folding their wrappers into `call_llm` (still one activity per
LLM message) — documented here per the granularity escape hatch.

## Model: kimi-k3 (only v1 provider)

`KIMI_BASE_URL` (default `https://api.kimi.com/coding/v1`) + `KIMI_API_KEY`;
kimi-k3 accepts only `temperature=1`, `frequency_penalty=0`, and always runs
max reasoning (`extra_body.reasoning_effort=max`) — enforced in
`build_model_settings()`. Registry declares `supportedProviders: ["kimi"]`,
`multiProvider: false`; widening happens by adding pydantic-ai provider
classes in `build_model()`.

## Platform contract (ported from browser-use-agent / dapr-agent-py)

`session_workflow` (literal name) accepts the BFF childInput shape and emits
the `session.status_*` vocabulary (`status_rescheduled`, `status_running`,
`turn_started`, `status_idle{end_turn}`, `status_terminating/terminated`,
`session.error`), with `autoTerminateAfterEndTurn` one-shot turns as
`__turn__N` child workflows. Multi-turn continuity: each turn's serialized
message history seeds the next (workflow-local, durable via replay).
CMA events (`agent.message`/`agent.tool_use`/`agent.tool_result` +
`agent.llm_usage` **net of cache reads**) publish from inside activities via
the byte-identical vendored `src/event_publisher.py`. Endpoints:
`/internal/sessions/{spawn,raise-event}`, `/api/v2/agent-runs/{id}/
{terminate,pause,resume}` + `DELETE` purge, `/healthz`, `/readyz`,
`/agent/instances/{id}`; FastAPI on **:8002**; 16 MiB workflow gRPC limits.

## Registry + dispatch

Descriptor in `services/shared/runtime-registry.json` (copies regenerated ONLY
via `scripts/sync-runtime-registry.mjs`): `family: durable-session`,
`durabilityGranularity: per-activity`, `workflowDispatch: auto-turn`,
`ownsSandbox: true`, `workspaceBackend: pod-local`, `imageEnvKey:
AGENT_RUNTIME_PYDANTIC_DEFAULT_IMAGE`, `instancePrefix: durable-pydantic`.
Dispatch is registry-driven (per-session ephemeral Kueue sandbox pods, same
lane as adk-agent-py — no routing code changes); the per-session pod gets
`pydantic-ai-agent-py-config` via the sandbox-execution-api image-substring
envFrom branch, next to the always-mounted `dapr-agent-py-config` +
`dapr-agent-py-secrets` (KIMI_API_KEY). `ANTHROPIC_API_KEY` is not read by
this service and must never be added to its env.

## Gotchas (live-verified during bring-up)

- harness top-level exports are lazy and partial — `RepoContext` imports from
  `pydantic_ai_harness.context`, not the package root.
- `RunContext(deps=None, model=None, usage=RunUsage())` is sufficient for
  `get_tools`/`call_tool` outside `Agent.run`.
- browser-use-style zombie uvicorn: `dapr stop` leaves the app holding :8002
  (publisher daemon threads) — `pkill -9 -f uvicorn` before local reruns.
- Local smoke workspace: set `PYDANTIC_AI_WORKSPACE_ROOT` to a writable dir
  (`/sandbox` requires the container).

## Develop

```bash
cd services/pydantic-ai-agent-py
uv sync && uv run pytest tests/ -q
# local durable smoke (dapr init'd, redis components):
KIMI_API_KEY=… PYDANTIC_AI_WORKSPACE_ROOT=/tmp/pydantic-ws \
  dapr run --app-id pydantic-ai-agent-py --app-port 8002 \
  --resources-path ../browser-use-agent/.local-dapr/components \
  -- uv run uvicorn src.main:app --host 127.0.0.1 --port 8002
```
