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

| Diagrid python-ai                                                     | This runtime                                                     | Why                                                                |
| --------------------------------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------ |
| Raw `openai.chat.completions` in the activity, model as a bare string | pydantic-ai `OpenAIChatModel`/`OpenAIProvider` + `ModelSettings` | keeps provider flexibility, usage accounting, native message types |
| Hand-rolled `Message` dataclasses                                     | native `ModelMessage` + `ModelMessagesTypeAdapter`               | faithful pydantic-ai history, no re-implementation drift           |
| Tools = plain callables introspected off the Agent                    | **harness capabilities → `get_toolset()`** (see below)           | first-class coding-agent tool surface                              |
| No cancellation, no platform events                                   | `check_cancellation` activity + CMA session-event mirroring      | platform lifecycle + observability contract                        |
| `runner.run_async` embedded host                                      | platform `session_workflow` + `/internal/sessions/spawn` bridge  | `durable/run` dispatch parity                                      |

## Tools: pydantic-ai-harness capabilities

Capabilities are extracted through the public `AbstractCapability.get_toolset()`
seam (`src/toolsets.py`) and routed by name in the `execute_tool` activity:

- **FileSystem** (rooted at `PYDANTIC_AI_WORKSPACE_ROOT`, default `/sandbox`;
  dynamic-script calls with `isolation: 'shared'` mount their JuiceFS execution
  workspace at `/sandbox/work`):
  `read_file, write_file, edit_file, list_directory, search_files, find_files,
create_directory, file_info` — mirrors dapr-agent-py's file builtins.
- **Shell** (same root): `run_command, start_command, check_command,
stop_command` — mirrors `execute_command`.
- **RepoContext**: CLAUDE.md/AGENTS.md instructions folded into the system
  prompt (instruction contributor; may also expose an inventory tool).
- **MCP**: `agentConfig.mcpServers` entries with `streamable_http` URLs are
  wired via the core `MCP` capability; stdio servers are skipped in v1.
- **ReadMediaFile**: reads png/jpeg/webp/gif files from the workspace and
  returns Pydantic AI `BinaryContent`, including overview downsampling and
  optional full-resolution crops. It is the image-verification path for Kimi
  K3 and also shares the same result handling as image-returning MCP tools.

`builtinTools` and `tools` form the saved agent's configured **local** tool set;
they do not hide tools from attached MCP servers. Node/session narrowing is
stamped into runtime-only `allowedTools`, which is an exact cross-source ceiling
and takes precedence even when it is empty. Per-server
`mcpServers[].allowedTools` is an additional MCP intersection. These ceilings
apply to model advertisement, cached MCP listings, and execution routing. The
Harness-owned `read_tool_result` support tool remains available when overflow is
enabled so a spill pointer can always be retrieved.

### Durable media

Pydantic AI already converts MCP image results to native `BinaryContent`; the
runtime must not stringify that value. Before an `execute_tool` activity
returns, the Harness media adapter stores every binary part once under
`<workspace>/.pydantic-ai/media` and replaces it with a compact
`media+sha256://` marker. `call_llm` restores the bytes only inside the model
activity, where `OpenAIChatModel` sends K3 a structured `image_url` data URI.
Every image from the current, not-yet-observed tool batch is restored. On later
turns, only the latest three previously seen visual results are restored by
default; older results become a short reminder and can be re-read from the
workspace or reacquired from their originating MCP tool. It externalizes the
history again before crossing the Dapr boundary.

The model-request admission budget defaults to eight images and 32 MiB across
both unseen and retained media. An image beyond either bound becomes an
explicit tool-result error asking the model to reacquire it in a later turn;
it is never silently dropped or appended to an oversized provider request.

This keeps pixels out of workflow state, session events, and content-bearing
OTel spans. Multimodal results bypass `OverflowingToolOutput`, whose text/JSON
spill path would otherwise replace large screenshots before externalization.
The adapter externalizes typed `BinaryContent` only, escapes colliding ordinary
tool JSON, and verifies each blob against its `media+sha256` digest on restore.
The current DiskMediaStore lives in the shared workspace so retries can restore
it; digest failure is fatal rather than allowing modified pixels to replay.
The registry advertises the narrower contract implemented today:
`userInputModalities: [text]`, `toolResultModalities: [text, image]`,
`supportsReadMediaFile: true`, `supportsMediaExternalization: true`, and
`durableMediaMode: content-addressed`. Direct user-uploaded image turns are not
claimed until the session event path preserves non-text blocks.

Video remains deliberately disabled. K3 expects a provider Files API
reference for video, while the configured Kimi-for-Coding endpoint provides
chat but no compatible Files endpoint. Do not inline or frame-extract video
implicitly; add a separate media-store adapter when that provider contract is
available.

### Capability hooks (compatibility with Dapr durability)

Because the **Dapr workflow is the run loop** (not pydantic-ai's graph), a
harness capability is compatible iff every seam it uses maps onto one of our
two activities. The rule and the seam-by-seam verdicts:

| Capability seam                                                     | Hosted in                                          | Durable?                                                    |
| ------------------------------------------------------------------- | -------------------------------------------------- | ----------------------------------------------------------- |
| `get_toolset` / `prepare_tools`                                     | tools offered in `call_llm`, run in `execute_tool` | ✅ per-activity                                             |
| `get_instructions`                                                  | system-prompt bootstrap in `call_llm`              | ✅ recorded in history                                      |
| `before/wrap/after_model_request`                                   | around `model.request()` in `call_llm`             | ✅ — the transformed history is the activity's RETURN value |
| `after_tool_execute`                                                | around the tool result in `execute_tool`           | ✅ result is the activity's return                          |
| `wrap_run` / `before_run` / `after_run` / node & event-stream hooks | —                                                  | ❌ no pydantic-ai run to attach to                          |

`src/toolsets.py::ToolRouter` hosts the `before/wrap/after_model_request`
chains inside `call_llm` and the `after_tool_execute` chain inside
`execute_tool`. Crucially, the compacted/transformed message list is what the
activity **returns**, so Dapr replay and the durable history stay consistent
and bounded.

**Enabled in v1** (env-gated, on by default):

- **OverflowingToolOutput** (`after_tool_execute`, `get_toolset`): large tool
  results spill to a `LocalFileStore` under `<workspace>/.overflow` and are
  truncated in-history; the model fetches the rest via the injected
  `read_tool_result` tool. Replaces the earlier `TOOL_RESULT_MAX_CHARS` hard
  truncation. Env: `PYDANTIC_AI_OVERFLOW_ENABLED`.
- **Compaction** (`before_model_request`), deterministic (no LLM call):
  `ClampOversizedMessages` then `SlidingWindow`. Env:
  `PYDANTIC_AI_COMPACTION_ENABLED`, `PYDANTIC_AI_CLAMP_MAX_PART_CHARS`,
  `PYDANTIC_AI_COMPACTION_MAX_MESSAGES`, `PYDANTIC_AI_COMPACTION_KEEP_MESSAGES`.
  Together with Overflow these are the **16 MiB workflow-payload ceiling
  mitigation** — not just compatible but wanted.

**Verified scope distinction (would bite otherwise):**
`ClampOversizedMessages` clamps **`ModelResponse` parts only** (prior
assistant text + tool-call args) — NOT `UserPromptPart` or `ToolReturnPart`
(`_clamp_oversized_messages.py:143` skips non-`ModelResponse` messages).
Tool RESULTS are the domain of **OverflowingToolOutput** instead. The two are
complementary; neither shrinks user prompts (those ride the SlidingWindow).

**Available but NOT enabled** (compatible; add by appending to
`build_capabilities` when needed): `Memory` (toolset + instructions +
`before_model_request`; point its store at the workspace — cross-session
needs an external backend), `Guardrails` `InputGuard` (`wrap_model_request`),
`Planning` (verify it keeps no cross-step in-process state first),
`SummarizingCompaction`/`TieredCompaction` (LLM-backed — fine, the call runs
inside `call_llm`).

**Incompatible / deliberately excluded** (need the run graph or duplicate the
platform): `SubAgents` and `StepPersistence` (`wrap_run`; the Dapr workflow
already IS the run + step persistence — use platform delegation / replay
instead); harness `Dynamic Workflow` (conflicts with the platform
dynamic-script engine).

**Hook retry rule:** hook chains re-run on **activity retry** (up to
`retryMaxAttempts`=3). Side effects inside them must be idempotent, and error
hooks must not swallow exceptions Dapr's RetryPolicy needs to see. The chains
are fail-soft per capability (a throwing hook is logged and skipped) so a
buggy capability can't wedge a turn.

**Granularity note (goal constraint):** every enabled capability splits
cleanly — each tool call is its own activity, each model call its own. The
one capability that would violate per-activity granularity is **CodeMode**
(collapses N tool calls into one `run_code` activity); it stays disabled for
that reason, documented here per the granularity escape hatch.

## Model: kimi-k3 (only v1 provider)

`KIMI_BASE_URL` (default `https://api.kimi.com/coding/v1`) + `KIMI_API_KEY`;
kimi-k3 accepts only `temperature=1`, `frequency_penalty=0`, and always runs
max reasoning (`extra_body.reasoning_effort=max`) — enforced in
`build_model_settings()`. Registry declares `supportedProviders: ["kimi"]`,
`multiProvider: false`; widening happens by adding pydantic-ai provider
classes in `build_model()`.

## Structured output

Dynamic-script `agent(..., { schema })` calls use the same mechanism proven in
`dapr-agent-py`: the adapter adds an ordinary synthetic `StructuredOutput`
function tool whose parameters are the caller's raw JSON Schema. Pydantic AI's
public `ToolDefinition(kind="function")` and model transport carry it to Kimi;
this is deliberately not Pydantic AI's high-level Tool Output mode. Text and
normal coding tools remain enabled, so the wire request uses
`tool_choice=auto` and K3 can finish filesystem, shell, or MCP work before it
submits the final result.

Kimi K3 also supports strict `response_format=json_schema`, and Pydantic AI can
force a native output tool. Neither fits this durable coding loop: a live probe
combining response format with required coding tools returned schema content
without executing the tools, while `Agent.run()` would move loop ownership out
of the per-model-call and per-tool-call Dapr activities.

`execute_tool` validates `StructuredOutput` arguments with a fail-closed Draft
2020-12 validator. Invalid calls become bounded, model-visible tool errors;
valid calls become canonical JSON and end the local session. Plain-text
finishes are corrected in-loop, also with a bounded budget. Exhaustion and
configuration errors cross into the dynamic-script journal as typed terminal
failures, so the journal does not multiply the runtime's retry budget. The
journal still performs the platform's final schema validation.

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
`ownsSandbox: true`, `workspaceBackend: juicefs-shared`, `imageEnvKey:
AGENT_RUNTIME_PYDANTIC_DEFAULT_IMAGE`, `instancePrefix: durable-pydantic`.
Dispatch is registry-driven (per-session ephemeral Kueue sandbox pods, same
lane as adk-agent-py — no routing code changes); the per-session pod gets
`pydantic-ai-agent-py-config` via the sandbox-execution-api image-substring
envFrom branch, next to the always-mounted `dapr-agent-py-config` +
`dapr-agent-py-secrets` (KIMI_API_KEY). `ANTHROPIC_API_KEY` is not read by
this service and must never be added to its env.

## Shared workspace (isolation:'shared' / workspaceRef)

The runtime's registry descriptor is **`workspaceBackend: juicefs-shared`**
with execution class `pydantic-ai-agent-py`: when a run wires a
`sharedWorkspaceKey` (dynamic-script `agent(..., { isolation: 'shared' })` →
`ws_script_<execId>`, or a `durable/run` `workspaceRef`),
sandbox-execution-api mounts the per-EXECUTION JuiceFS subtree at
`/sandbox/work` and the class env points `PYDANTIC_AI_WORKSPACE_ROOT` there —
so the harness FileSystem/Shell tools operate DIRECTLY on the shared tree
with plain file semantics (no RPC), and every agent of the run sees the same
files. This is the same lane the CLI family and `dapr-agent-py-juicefs` use
(same JuiceFS secret, same subPath keying), which also means pydantic nodes
can now legally share a `workspaceRef` with those families and appear in the
run-page Files tab. Sessions without a shared key (direct UI sessions) fall
back to the pod-local durable-scratch `/sandbox` unchanged. The class runs
the pod as uid/fsGroup 10001 (matching CLI writers on the shared FS); the
image CMD execs the venv binary directly so non-root startup works.

## Shell credential scrubbing

The harness `Shell` capability runs with `denied_env_patterns`
(`SHELL_DENIED_ENV_PATTERNS`, override via
`PYDANTIC_AI_SHELL_DENIED_ENV_PATTERNS`) so an agent-run command cannot read
the pod's secrets out of the environment: `*_API_KEY` / `KIMI_*` /
`ANTHROPIC_*` / provider prefixes / `INTERNAL_API_TOKEN` / `AP_ENCRYPTION_KEY`
/ `JWT_SIGNING_KEY` / `*_DATABASE_URL` are stripped from the subprocess's
INHERITED env (glob match), while `PATH`/`HOME`/non-secret vars survive so
commands still resolve. This scrubs at the subprocess boundary — defense in
depth under the platform "keys must never leak" invariant — not a substitute
for pod-level isolation. Shell also exposes background-process tools
(`start_command`/`check_command`/`stop_command`) automatically for
dev-server / watcher workflows. Command allow/deny filtering is best-effort
(an agent can defeat it via `bash -c`); real command safety stays at the
per-session sandbox boundary.

## Durable per-sandbox scratch (/sandbox on a PVC)

The pod's `/sandbox` workspace rides a small per-sandbox **RWO PVC** instead of
an emptyDir (sandbox-execution-api swaps the volume when the agent image
matches `pydantic-ai-agent-py`): an evicted/restarted pod resumes with its
files, and the claim is ownerRef'd to the Sandbox CR so it GCs with the
session. This is the upstream agent-sandbox `volumeClaimTemplates` pattern
(StatefulSet-like volume identity) implemented through the platform's
direct-PVC+ownerRef lane — see `docs/agent-sandbox-v0.5.0-upgrade-evaluation.md` §6.

- Env (on sandbox-execution-api): `SANDBOX_PYDANTIC_SCRATCH_ENABLED`
  (default true), `SANDBOX_PYDANTIC_SCRATCH_SIZE` (default `2Gi`),
  `SANDBOX_PYDANTIC_SCRATCH_STORAGE_CLASS` (default: cluster default).
- Claim name: `pyd-scratch-<sessionId>`.
- **Node-affinity caveat**: the default `local-path` StorageClass pins the PV
  to the first node; a same-node pod restart resumes cleanly, but if that node
  is unschedulable the replacement pod pends on volume affinity. Point the
  storage-class env at a network-attached class (e.g. a JuiceFS SC) if
  cross-node reschedule matters more than local-disk speed.
- Workspace semantics stay `pod-local` in the runtime registry — the scratch
  changes the volume's _lifetime_, not its sharing domain.

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
