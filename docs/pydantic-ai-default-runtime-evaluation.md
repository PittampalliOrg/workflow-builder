# Evaluation: pydantic-ai-agent-py as the Default Agent Runtime

Question under evaluation: can `pydantic-ai-agent-py` replace `dapr-agent-py`
as the platform default runtime, and — since both are durable Dapr agents —
does the swap lose any functionality?

## The premise to correct first

**`pydantic-ai-agent-py` does not use the dapr-agents `DurableAgent` class.**
Three distinct things get conflated under "durable dapr agent":

1. **The dapr-agents framework** (`dapr_agents` pip package, pinned 1.0.3) —
   `dapr-agent-py` subclasses its `DurableAgent`, uses its `Hooks`, configs,
   and state-store services, and monkeypatches `DaprChatClient.generate` for
   direct provider calls.
2. **The Diagrid python-ai pydantic-ai integration** — the _pattern_ our new
   runtime ports (one `call_llm` activity per LLM message, one `execute_tool`
   activity per tool call, history as JSON across boundaries).
3. **Our `pydantic-ai-agent-py`** — a plain `dapr.ext.workflow`
   `WorkflowRuntime` implementing that pattern by hand, with pydantic-ai's own
   model classes and pydantic-ai-harness capabilities. **No `dapr_agents`
   dependency at all.**

What the two runtimes _do_ share is the **durability substrate**: the Dapr
Workflow engine (replay, retry policies, placement routing, task-hub state,
the 16 MiB payload ceiling, terminate/purge semantics). At that layer the
swap loses nothing — per-activity durability granularity is identical, and
that part of the intuition is correct.

**But the conclusion does not follow.** Most of what `dapr-agent-py` does for
the platform is not durability — it is six-plus months of feature surface
built _on top of_ the durable loop. Those layers do not come along for free.

## Capability delta (registry-declared + code-verified)

| Capability                                                                                               | dapr-agent-py                                                                                                                           | pydantic-ai-agent-py                                                                                                | Loss class                                                      |
| -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Durability granularity                                                                                   | per-activity                                                                                                                            | per-activity                                                                                                        | **parity**                                                      |
| Activity retry depth                                                                                     | 8                                                                                                                                       | 3                                                                                                                   | minor                                                           |
| Providers                                                                                                | 10 (anthropic, openai, deepseek, zai, nvidia, kimi, alibaba, together, googleai, foundry) + `modelSpec` switching + MLflow gateway lane | **kimi only**                                                                                                       | **REJECT-class** (swap-safety gate)                             |
| Durable structured output (`responseJsonSchema` → synthetic function tool + validation)                  | yes (`structured_output.py` + per-adapter)                                                                                              | yes (same ordinary-function contract transported by Pydantic AI, Draft 2020-12 validation, bounded correction loop) | **parity for Kimi object schemas**                              |
| Hooks (Claude Code port: PreToolUse/PostToolUse/…, blocking exit-2, per-run `agentConfig.hooks` overlay) | yes, durable placement in `run_tool`                                                                                                    | **no** (harness capability hooks only — a different, internal seam)                                                 | major                                                           |
| Plugins (`claude-plugins-official` init container)                                                       | yes                                                                                                                                     | no                                                                                                                  | moderate                                                        |
| Portable hooks / event-driven invocation descriptors                                                     | yes                                                                                                                                     | no                                                                                                                  | moderate                                                        |
| Skills (`agentConfig.skills` / `agent_skill_registry` injection)                                         | yes                                                                                                                                     | no                                                                                                                  | moderate                                                        |
| Permission gating                                                                                        | yes                                                                                                                                     | no                                                                                                                  | moderate                                                        |
| Tool surface                                                                                             | OpenShell suite (remote mTLS workspace/browser/openshell routes) + MCP                                                                  | pod-local FileSystem(8)/Shell(4)/RepoContext/ReadMediaFile + MCP                                                    | different, see workspace                                        |
| Workspace backend                                                                                        | `openshell-shared` (cross-pod share w/ browser-use family)                                                                              | `juicefs-shared` for `isolation: 'shared'`; pod-local fallback for direct sessions                                  | different backends; bridge required for OpenShell browser tools |
| Vision / image tool results                                                                              | yes (provider adapter)                                                                                                                  | yes (`BinaryContent` + content-addressed durable externalization); direct user images and video remain unsupported | parity for image-returning tools                                 |
| `CallAgent` peer delegation tool                                                                         | yes                                                                                                                                     | no                                                                                                                  | moderate                                                        |
| Compaction                                                                                               | summarizing auto-compact engine + context-window math                                                                                   | deterministic Clamp → SlidingWindow (bounded, non-summarizing)                                                      | different; acceptable for most runs                             |
| Overflow of huge tool outputs                                                                            | truncation                                                                                                                              | **better**: OverflowingToolOutput spill + `read_tool_result`                                                        | pydantic wins                                                   |
| Safety nets                                                                                              | empty-response circuit breaker, host-monitor stall thread, image compaction, MCP timeout                                                | MCP timeout + cancellation checks only                                                                              | moderate                                                        |
| Session lifecycle (terminate/pause/resume/purge endpoints)                                               | yes                                                                                                                                     | yes                                                                                                                 | **parity**                                                      |
| Session events / `agent.llm_usage` net-of-cache / Pulse `context_*`                                      | yes                                                                                                                                     | yes                                                                                                                 | **parity**                                                      |
| Goal loop (evaluator-gated completion, BFF-driven)                                                       | yes (+ stop-hook single-driver)                                                                                                         | yes (BFF idle-hook path)                                                                                            | **parity**                                                      |
| Observability (OTEL traces, curated views, event trace-links)                                            | hand-rolled `claude_code.*` stack                                                                                                       | pydantic-ai-native GenAI semconv + platform contract                                                                | **parity** (arguably cleaner on pydantic)                       |
| Benchmarks (SWE-bench pool, `benchmarkEligible`)                                                         | yes                                                                                                                                     | no                                                                                                                  | moderate                                                        |
| `capabilitiesVerified`                                                                                   | true                                                                                                                                    | false                                                                                                               | process flag                                                    |

The **swap-safety gate** (`src/lib/server/agents/swap-safety.ts`) already
encodes this delta mechanically: retargeting an existing agent with a
non-kimi `modelSpec` (or MCP loss) to pydantic is REJECT-class; hooks /
permission / plugin / compaction downgrades are WARN-class. A blanket default
flip today would reject or degrade a large share of existing agent configs.

## What is genuinely equivalent

Per-activity durability and replay semantics; the `session_workflow` platform
contract (bridge, two-name dispatch, `autoTerminateAfterEndTurn`, raise-event
lane); Lifecycle Controller convergence (stop/terminate/pause/purge); CMA
session-event stream with the token-accounting invariant; the goal loop;
MCP client support (with a per-call timeout guard on both); per-session
Kueue sandbox dispatch; first-class OTEL observability.

## Where pydantic-ai is structurally _better_

- **Cheaper provider expansion**: pydantic-ai ships maintained model classes
  (Anthropic, OpenAI, Google, Bedrock, Groq…) — adding providers means
  wiring `build_model()`, not writing a monkeypatched adapter per provider.
- **Structured output without graph takeover**: Pydantic AI transports the
  Dapr-style synthetic function definition while the durable loop retains
  platform validation and retry authority.
- **Maintained instrumentation** (GenAI semconv) vs our bespoke telemetry
  stack.
- **Harness capabilities** (overflow spill, deterministic compaction) are
  upstream-maintained rather than in-repo.
- No dependence on the drifting `dapr_agents` pin (1.0.3 vs 1.0.4 docs
  drift; monkeypatch surface).

## Recommendation

Do **not** flip `defaultRuntimeId` yet. The durability argument is sound but
answers the wrong layer; the losses live above it.

Phased path if the goal is pydantic-as-default:

1. **Now (no risk)**: keep per-agent/per-node runtime selection — dispatch is
   already runtime-agnostic, so kimi-first coding agents can standardize on
   pydantic today (as `pydantic-ai-coder` does).
2. **P1 — close the remaining REJECT-class gap**: multi-provider
   `build_model()` (pydantic-ai native model classes + per-provider settings
   quirks). Kimi object-schema structured output is now implemented.
3. **P2 — close the WARN-class gaps that matter to us**: `agentConfig.hooks`
   portable-hooks execution (the event-driven-invocation design already
   assumes it), skills injection, circuit breaker + host monitor ports.
4. **P3 — keep the workspace boundary explicit**: shared Pydantic calls use
   JuiceFS, while browser validation uses OpenShell. Workflows that need both
   must materialize validated files or screenshots across that boundary before
   `ReadMediaFile` can inspect them.
5. **Flip** `defaultRuntimeId` + `benchmarkEligible` + `capabilitiesVerified`
   only after a benchmark A/B on the coding pool.

`CallAgent`, plugins, and the goal stop-hook can trail; nothing else depends
on them structurally.
