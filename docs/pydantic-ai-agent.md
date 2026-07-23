# pydantic-ai-agent-py — durable Pydantic AI coding agent

**Runtime SSOT** for `services/pydantic-ai-agent-py/`: a substitute for
dapr-agent-py built on **pydantic-ai 2.x (pydantic v2) + pydantic-ai-harness**,
with Dapr durable execution where **every LLM message and every tool call runs
as its own Dapr workflow activity**.

## Architecture

The durable shape follows the **Diagrid python-ai** reference
(`diagrid/agent/pydantic_ai/`, local checkout `~/repos/diagridio/python-ai/main`):
one workflow (`agent_workflow`) plus named activities. Full native Pydantic AI
messages live in an immutable, content-addressed transcript store on the
per-sandbox workspace; Dapr history carries only opaque transcript/message
references and strictly bounded private execution context.

```
session_workflow (platform contract wrapper, literal name)
  └─ agent_workflow (__turn__N child per auto-terminate turn)
       loop (≤ maxIterations):
         ├─ check_cancellation  activity  (session-cancel:{instance} key)
         ├─ call_llm            activity  (ONE LLM message)
         ├─ execute_tool        activity  ×N per tool call — when_all fan-out
         └─ commit_tool_results activity  (validate + publish balanced history)
```

- `call_llm` speaks through **pydantic-ai's own model classes**
  (`OpenAIChatModel` + `OpenAIProvider` → Kimi-for-Coding), not the raw
  OpenAI SDK. History is pydantic-ai's native `ModelMessage` list, encoded
  with `ModelMessagesTypeAdapter` (`src/messages_io.py`) — tool calls,
  returns, and usage survive replay faithfully.
- Retry policy on every activity: 3 attempts, 2s first interval, 2.0 backoff,
  30s cap (`src/workflow.py:RETRY_POLICY`).
- The public per-turn cap is 80 iterations. The child workflow checkpoints with
  `continue_as_new` every 40 completed iterations, carrying only its immutable
  transcript reference, iteration counters, structured-output retry state, and
  static turn context. The checkpoint runs before the next cancellation/LLM
  activity is scheduled, so it never discards an incomplete tool wave.
- The iteration-0 `call_llm` **bootstraps** the message list (system prompt =
  `agentConfig.systemPrompt` + capability instructions) so the workflow body
  stays deterministic/pure — the workflow never does I/O.
- `call_llm` publishes a `history+sha256://...` manifest plus the exact final
  assistant `message+sha256://...`. Tool activities resolve their arguments
  from that response, publish one correlated result reference each, and
  `commit_tool_results` validates the whole call/result wave before advancing
  the history. A legacy inline history is imported once and then migrates to
  references.
- Private activity context can contain MCP credentials, so it remains inside
  bounded Dapr payloads and is never persisted in the agent-readable workspace.

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
harness capability is compatible iff every seam it uses maps onto a durable
activity. The rule and the seam-by-seam verdicts:

| Capability seam                                                     | Hosted in                                          | Durable?                                                    |
| ------------------------------------------------------------------- | -------------------------------------------------- | ----------------------------------------------------------- |
| `get_toolset` / `prepare_tools`                                     | tools offered in `call_llm`, run in `execute_tool` | ✅ per-activity                                             |
| `get_instructions`                                                  | system-prompt bootstrap in `call_llm`              | ✅ recorded in history                                      |
| `before/wrap/after_model_request`                                   | around `model.request()` in `call_llm`             | ✅ — transformed history is stored behind an immutable ref  |
| `after_tool_execute`                                                | around the tool result in `execute_tool`           | ✅ result is the activity's return                          |
| `wrap_run` / `before_run` / `after_run` / node & event-stream hooks | —                                                  | ❌ no pydantic-ai run to attach to                          |

`src/toolsets.py::ToolRouter` hosts the `before/wrap/after_model_request`
chains inside `call_llm` and the `after_tool_execute` chain inside
`execute_tool`. Crucially, the compacted/transformed message list is what the
activity **stores before returning its reference**, so Dapr replay and the
durable history stay consistent and bounded without copying the transcript
through every workflow event.

**Enabled in v1** (env-gated, on by default):

- **OverflowingToolOutput** (`after_tool_execute`, `get_toolset`): large tool
  results spill to a `LocalFileStore` under `<workspace>/.overflow` and are
  truncated in-history; the model fetches the rest via the injected
  `read_tool_result` tool. Replaces the earlier `TOOL_RESULT_MAX_CHARS` hard
  truncation. Env: `PYDANTIC_AI_OVERFLOW_ENABLED`. Every `execute_tool` result
  is also measured with Dapr's exact durable encoder; if overflow is disabled
  or its store fails, an oversized result becomes a bounded, correlated tool
  error rather than crossing the activity transport limit.
- **Compaction** (`before_model_request`), deterministic (no LLM call): the
  K3-aware `KimiHistoryWindow` includes `ThinkingPart` content,
  preserves tool-call/return pairs, and enforces both model-token and transcript
  JSON-byte budgets. Env:
  `PYDANTIC_AI_COMPACTION_ENABLED`, `PYDANTIC_AI_COMPACTION_MAX_MESSAGES`,
  `PYDANTIC_AI_COMPACTION_KEEP_MESSAGES`,
  `PYDANTIC_AI_COMPACTION_KEEP_TOKENS`,
  `PYDANTIC_AI_TRANSCRIPT_MAX_BYTES`, and
  `PYDANTIC_AI_TRANSCRIPT_KEEP_BYTES`. Retained K3 reasoning is never
  truncated: only complete messages/tool pairs are evicted; if the newest group
  cannot fit, the activity returns `model_context_window_error`.
  Together with Overflow and reference transport, these keep exact transcripts
  outside Dapr's 16 MiB workflow-message ceiling.

**Verified K3 replay distinction:** retained assistant messages cannot be
rewritten. Harness `ClampOversizedMessages` is therefore disabled because it
mutates assistant text and tool-call arguments. `OverflowingToolOutput` bounds
tool results before they enter the transcript; `KimiHistoryWindow` evicts only
whole messages and matched tool-call/return pairs. Older user prompts can leave
the history, while the first and current request are never silently truncated.

**Available but NOT enabled** (compatible; add by appending to
`build_capabilities` when needed): `Memory` (toolset + instructions +
`before_model_request`; point its store at the workspace — cross-session
needs an external backend), `Guardrails` `InputGuard` (`wrap_model_request`),
`Planning` (verify it keeps no cross-step in-process state first),
`SummarizingCompaction`/`TieredCompaction` (LLM-backed — fine, the call runs
inside `call_llm`).

**Incompatible / deliberately excluded** (need the run graph or duplicate the
platform): `ClampOversizedMessages` (violates K3 complete-assistant replay),
`SubAgents` and `StepPersistence` (`wrap_run`; the Dapr workflow
already IS the run + step persistence — use platform delegation / replay
instead); harness `Dynamic Workflow` (conflicts with the platform
dynamic-script engine).

**Hook retry rule:** hook chains re-run on **activity retry** (up to
`retryMaxAttempts`=3). Side effects inside them must be idempotent, and error
hooks must not swallow exceptions Dapr's RetryPolicy needs to see. The chains
are fail-soft per capability except the intentional
`ContextWindowBudgetError`, which is converted into one terminal
`model_context_window_error` result so Dapr does not retry an impossible
request.

**Granularity note (goal constraint):** every enabled capability splits
cleanly — each tool call is its own activity, each model call its own. The
one capability that would violate per-activity granularity is **CodeMode**
(collapses N tool calls into one `run_code` activity); it stays disabled for
that reason, documented here per the granularity escape hatch.

## Model: kimi-k3 (only v1 provider)

`KIMI_BASE_URL` (default `https://api.kimi.com/coding/v1`) + `KIMI_API_KEY`;
kimi-k3 accepts only `temperature=1`, `frequency_penalty=0`, and always runs
max reasoning (`extra_body.reasoning_effort=max`) — enforced in
`build_model_settings()`. The same settings apply to ordinary and structured
output calls. Replay-safe K3 history compaction reserves K3's configured
131,072-token completion budget plus a 13,000-token provider/tool-schema safety
buffer inside the provider-capped 1,048,576-token context window
(`KIMI_CONTEXT_WINDOW`). Near the estimated boundary, the request adapter
reduces `max_completion_tokens` to the remaining capacity. This is deliberately
best-effort: the Kimi-for-Coding endpoint does not expose exact request-token
estimation, and tool schemas, provider tokenization, and image payloads can add
tokens beyond the harness estimate. A provider context-limit rejection is
normalized into one terminal `model_context_window_error` result instead of
retrying the same invalid request. Reference-backed transcripts are limited to
64 MiB and compact toward 48 MiB by default, independently of Dapr's message
ceiling. Workflow inputs are bounded to a 512 KiB task and 16 KiB private
model context; ordinary tool activities receive at most 8 KiB of private
context, the structured-output activity may receive the full 16 KiB model
context, and one response may contain at most eight tool calls. Registry declares
`supportedProviders: ["kimi"]` and
`multiProvider: false`; widening happens by adding pydantic-ai provider classes
in `build_model()`.

The transport regression uses Dapr's actual protobuf `WorkflowRequest` shape,
not a JSON-size estimate, and records three scheduled attempts, two bounded
failures, two retry-timer pairs, and one completion for every activity. The
40-wave, eight-tool retry storm is 4,401 events and 13,544,601 bytes, leaving
3,232,615 bytes below the 16 MiB ceiling. A 39-wave run followed by the maximum
256 KiB no-tool answer is 4,311 events and 13,576,682 bytes, leaving 3,200,534
bytes. The reachable structured-output maximum is 34 ordinary waves, five
mixed invalid StructuredOutput waves, then a maximum valid result; it is 4,331
events and 13,766,055 bytes, leaving 3,011,161 bytes. The largest individual
activity payload is 540,810 bytes. The 512 KiB initial task appears four times
under maximum retry history (once in `ExecutionStarted` and once in each of the
three first-LLM schedules); every iteration also includes its bounded 16 KiB
model context, 8 KiB ordinary-tool contexts, and reference-only tool/result/
commit envelopes.

K3 requests stream on the HTTP connection by default
(`KIMI_STREAMING_ENABLED=true`) because max-thinking turns can outlive an
intermediary's non-streaming response window. The stream is fully consumed
inside the existing `call_llm` activity and Pydantic AI assembles one final
`ModelResponse`, including reasoning, tool calls, finish reason, and usage.
Only that completed response crosses the Dapr boundary; token deltas are not
journaled, written to session events, or stored as workflow data. An incomplete
stream, missing finish reason, or missing final usage fails the activity and
uses the existing bounded retry policy. The OpenAI SDK's internal retry count
is zero so Dapr is the single retry authority rather than multiplying one
activity failure into nested provider requests.

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
`__turn__N` child workflows. Multi-turn continuity: each turn's transcript
reference seeds the next. Long-lived sessions `continue_as_new` after every
completed turn, carrying only the latest reference and compact session/mailbox
state; one-shot auto-terminate turns preserve their existing terminal behavior.
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
