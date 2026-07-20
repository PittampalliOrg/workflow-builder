# Browser-Use × Dapr DurableAgent — Feasibility & Architecture Evaluation

**Question**: Can we build an agent on the [browser-use](https://github.com/browser-use/browser-use)
framework that is compatible with the dapr-agents framework's `DurableAgent` class, shipped as a
standalone in-repo service like `services/dapr-agent-py/`?

**Verdict: YES — feasible, and partially proven already.** The platform's `browser-use-agent`
runtime *already* runs on the DurableAgent stack in production, but its source lives only in a
hand-pushed image with no Dockerfile or code in any repo. The real task is therefore to build a
**proper, in-repo, reproducible standalone service** — and both the browser-use framework and
dapr-agents 1.0.4 expose exactly the seams needed to do it cleanly.

Researched 2026-07-20 against: `services/dapr-agent-py` (this repo), dapr-agents **v1.0.4**
(the pinned version; source at `~/repos/PittampalliOrg/dapr-agents/main`, verified via
`git show v1.0.4:`), browser-use **v0.13.6** (2026-07-17, MIT, Python ≥3.11), and the live
registry/stacks manifests.

---

## 1. Where we are today (the surprising part)

The runtime registry (`services/shared/runtime-registry.json:149-183`) already declares
`browser-use-agent` with `durabilityGranularity: "per-activity"`, `agentMetadataFramework:
"Dapr Agents"`, warm-pool dispatch, and chromium + playwright-mcp sidecars. Facts about the
current implementation:

- **The source is out-of-repo.** `services/browser-use-agent/` contains only two workflow JSON
  fixtures. The runtime is the prebuilt image
  `ghcr.io/pittampalliorg/browser-use-agent-sandbox:git-04cea66a…`, release-pin provenance
  **`manual-local-docker-push`** (built 2026-04-25). `nix/images.nix:430-437` marks it
  `buildable = false; blocker = "No current workflow-builder Dockerfile is present…"`.
- **It is already DurableAgent-based.** The orchestrator relies on it registering
  `session_workflow` + `agent_workflow` (`sw_workflow.py:1979` cites the out-of-repo
  `browser_use/dapr_runtime/service.py:335-340`), with the same childInput shape as
  dapr-agent-py. The warm-pool pod even names its main container `dapr-agent-py` and loads
  `dapr-agent-py-config` (`sandbox-warmpool-builder.ts:249`) — it is effectively a
  dapr-agent-py variant bundling `browser-use`.
- **Known production defects** (documented, unfixable without the source):
  - Internal **step budget (~15)** exhausts on multi-URL tasks (`docs/tiered-crawl-pipeline.md:272`),
    which is why research/extraction moved to the crawl pipeline.
  - **Leaks Browserstation Chrome actors** — never calls `DELETE /browsers/{id}` on session end;
    only mitigated by the 900 s TTL backstop
    (`stacks/.../RayCluster-browserstation.yaml:59-68`).
  - Frozen `browser-use` version (unknown, baked into an image from April) while upstream ships
    breaking waves quarterly.
  - Per-slug **shared single-pod host** carve-out in dispatch (`runtime-routing.ts:225-229`),
    called the "load-bearing carve-out" in `docs/agent-runtime-comparison.md:111`.

Building the standalone service replaces an unreproducible artifact with owned code and lets us
fix all four defects.

## 2. Framework findings (what makes this possible)

### 2.1 dapr-agents 1.0.4 — two sanctioned ways to replace the inner loop

1. **The executor seam (new finding).** v1.0.4 (identical in 1.0.3/1.0.5) ships
   `AgentExecutorBase` (`dapr_agents/agents/executors/base.py`):
   `DurableAgent(executor=…)` (mutually exclusive with `llm=`) routes the stock
   `agent_workflow` to a single `run_executor` activity that drives your async
   `run(prompt, session_id, context) -> AsyncGenerator[AgentEvent]` stream
   (`durable.py:568`, `_consume_executor` at `durable.py:2175-2400`). Event types:
   `message`, `tool_call`, `tool_result`, `session` (checkpoint), `complete`, `error`.
   Retried activities resume the same executor session (session-id resolution:
   caller → persisted entry → auto-assign). The docstring names Claude Agent SDK /
   LangGraph-class frameworks as intended targets — browser-use fits the same contract.
   **No subclassing required**; AgentRunner, pub/sub, HTTP routes, state infra, HITL all
   come for free. Durability granularity: **per-session** (one activity wraps the whole loop).

2. **The subclass pattern (the dapr-agent-py precedent).** `OpenShellDurableAgent(DurableAgent)`
   (`services/dapr-agent-py/src/main.py:1687`) overrides `agent_workflow` (custom driver loop),
   `call_llm`, `run_tool`, and `register_workflows` (to add `session_workflow` +
   custom activities), with a shared `WorkflowRetryPolicy(max_attempts=8)` on every
   `ctx.call_activity`. Durability granularity: **per-activity**, with in-loop cancellation
   polling (`check_cancellation_for_instance`, key `session-cancel:{instance}`), compaction,
   and byte-budget guards. This is the proven template for a runtime that needs per-step
   durable control.

### 2.2 browser-use 0.13.x — the seams line up

- **The step loop is externally drivable.** `Agent.step()` / `take_step() -> (is_done, is_valid)`
  are public and designed for external driving; `run()` merely adds signal handling, hooks, and
  max-steps. One step = browser-state capture (DOM + screenshot) → one vision-LLM call
  (`ainvoke(messages, output_format=AgentOutput)`) → `multi_act()` over the action registry.
- **The LLM seam is a Protocol, not a registry.** `BaseChatModel` is a `@runtime_checkable
  Protocol` — any object with `model`, `provider`, and `async ainvoke(messages, output_format)`
  works. A custom shim can delegate to our provider adapters/gateway and emit `agent.llm_usage`.
  Structured output (`AgentOutput`: thinking/evaluation/memory/next_goal/action list, schema
  built dynamically per step) is required from whatever the shim returns.
- **CDP-native, remote-attach first-class.** Playwright was removed (Aug 2025) for their own
  `cdp-use` client; `Browser(cdp_url="http://host:9222", is_local=False)` attaches to an
  existing Chrome — i.e., our chromium sidecar (`:9222`) or a Browserstation lane. Cookie/
  storage state lives in the remote browser and survives activity boundaries; `storage_state` +
  `keep_alive` cover save/restore.
- **State is serializable by design.** `AgentState` (pydantic: steps, failures, last results,
  plan, message-manager state, pause/stop flags) can be passed back via the
  `injected_agent_state` constructor param; `AgentHistoryList` has `save_to_file`/
  `load_from_file`; `rerun_history()` gives deterministic no-LLM replay. There is **no official
  cross-process checkpoint/resume story** — the affordances exist at source level only.
- **Eventing hooks for CMA mirroring**: `register_new_step_callback` (per-LLM-response, with
  `BrowserStateSummary` + `AgentOutput` + step number), `on_step_start/end`, `register_done_callback`,
  plus their `bubus` event bus.
- **Caveats**: internal (underscore) step phases are churn-prone — upstream ships breaking waves
  quarterly (LangChain→own LLM layer, Playwright→CDP, `Controller`→`Tools` in 0.7.0, Rust-backed
  beta agent in 0.13.0). The in-tree MCP *client* is **stdio-only** (no streamable-HTTP), so
  in-cluster MCP services need a bridge — but browser control itself needs no MCP at all
  (direct CDP). Pin the version; depend only on documented seams (`take_step`, `BaseChatModel`,
  `Tools.action`, `cdp_url`, `AgentHistoryList`); never call underscore internals.
- **No public prior art** for browser-use inside Temporal/Dapr. Closest published pattern:
  Browserbase + Stagehand + Temporal ("each browser step = one retryable activity, idempotent
  session reuse") — which is exactly the shape Option B below takes.

## 3. Options

| | **A. Executor seam** (`DurableAgent(executor=BrowserUseExecutor)`) | **B. Subclass + per-step activity** (`BrowserUseDurableAgent(DurableAgent)`) | **C. Whole-run-in-one-activity** (claude-agent-py shape) |
|---|---|---|---|
| dapr-agents surface | `AgentExecutorBase` (v1.0.4 built-in, stable across 1.0.3–1.0.5) | Override `agent_workflow` + `register_workflows` (dapr-agent-py precedent) | Trivial workflow, one activity |
| Durability granularity | per-session (one `run_executor` activity) | **per-activity** (one activity per browser step) | per-session |
| Registry descriptor honesty | must downgrade `durabilityGranularity` to `per-session` | matches the declared `per-activity` | must downgrade |
| Crash/retry behavior | activity retry re-enters executor with same session-id; browser survives via remote CDP; agent restarts loop from its own state | retry redoes only the failed step against the still-live remote browser; `AgentState` rehydrated via `injected_agent_state` | retry redoes the whole browsing task |
| Mid-run cancellation (Lifecycle Controller contract) | inside executor only (poll between steps in our own code) | native — `check_cancellation_for_instance` between steps in the workflow loop, same as dapr-agent-py | only at activity boundary (i.e., not really) |
| Step budget / goal-loop / per-turn hooks | in-executor | natural per-step workflow control (fixes the "15-step budget" class of problems with a real `maxTurns`) | none |
| Code volume | **smallest** — no subclass; reuse stock workflow, AgentRunner, HITL, state infra | moderate — but most of it is clonable from dapr-agent-py (`session_workflow`, publisher, cancel keys, admin routes) | smallest, least value |
| Risk | executor loop is opaque to Dapr; checkpoint only at `session` events | slightly more coupling to dapr-agents internals (same coupling dapr-agent-py already carries) | loses everything the platform values |

**Payload discipline (applies to A and B):** screenshots/DOM ride in LLM messages as base64 —
never let `AgentState`/history transit workflow activity payloads. Persist `AgentState` in the
agent state store *inside* the activity (keyed on instance-id, same `DaprInfra` etag pattern the
framework uses), return only a small step summary `{is_done, success, results[], state_ref,
usage}` from the activity, and offload screenshots to the Files API / multimodal offload port
(dapr-agent-py's `_compact_image_tool_results` + `offload_multimodal_tool_result` are the
in-repo precedents). This respects the 16 MiB gRPC ceiling and the Dapr 1.18 silent
payload-size pre-check stall.

## 4. Recommended architecture

**Option B (subclass + per-step activity), with the Option C-style LLM shim as a shared
component, and Option A kept as the documented fallback/prototype path.** Rationale: the
platform's contract is built around per-activity durability — in-loop cancellation for the
Lifecycle Controller, per-turn goal/stop hooks, `retryMaxAttempts: 8`, incremental CMA events —
and the registry already advertises `per-activity` for this runtime. The subclass route is more
code than the executor, but nearly all of it is proven code we clone from `dapr-agent-py`
rather than invent.

### `services/browser-use-agent/` (real service, replacing the JSON-only stub)

```
src/
  main.py                  # FastAPI app on :8002, AgentRunner().serve(agent, app=app)
  browser_agent.py         # class BrowserUseDurableAgent(DurableAgent)
  browser_step.py          # the per-step activity implementation
  llm_shim.py              # browser-use BaseChatModel Protocol impl → provider adapters
  browser_session.py       # cdp_url attach/reattach, Browserstation lease + DELETE on end
  event_publisher.py       # vendored byte-identical from services/shared/session_events/
pyproject.toml             # dapr-agents==1.0.4, browser-use==0.13.6 (pinned), dapr>=1.18,<1.19
Dockerfile.sandbox         # modeled on dapr-agent-py's; NO chromium inside (sidecar owns it)
```

**Workflow shape** (`BrowserUseDurableAgent`):

- `register_workflows` override: `super()` + `session_workflow` (cloned from dapr-agent-py's,
  same `autoTerminateAfterEndTurn` / `session.status_*` semantics) + `check_cancellation_for_instance`.
- `agent_workflow` driver loop, one iteration per browser step:
  1. `check_cancellation_for_instance` (cancel key `session-cancel:{instance}`, turn-suffix
     stripping — required for Lifecycle Controller convergence).
  2. `browser_step` activity: rehydrate `Agent(task=…, llm=shim, browser=Browser(cdp_url=…),
     injected_agent_state=load(state_ref), tools=…)` → `take_step()` → persist `AgentState` +
     history delta to the state store → offload screenshots → emit CMA events
     (`agent.message` from `AgentOutput.next_goal/thinking`, `agent.tool_use`/`agent.tool_result`
     per `ActionResult`, `agent.llm_usage` from the shim) → return the small summary dict.
  3. Break on `is_done` or `maxTurns` (from `agentConfig`, not browser-use's internal budget —
     pass `max_steps` per-call so upstream's cap never binds first).
  4. `finalize_workflow` + **guaranteed browser teardown** (Browserstation
     `DELETE /browsers/{id}` / CDP disconnect) on every terminal path — fixes the actor leak.
- Retry policy: shared `WorkflowRetryPolicy(max_attempts=8, …)` on every activity, matching the
  descriptor.

**LLM shim** (`llm_shim.py`): implements the `BaseChatModel` Protocol; `ainvoke` routes through
the same provider-adapter layer dapr-agent-py uses (or the gateway), enforces structured output
into `AgentOutput`, applies image compaction (keep last N screenshots) before the call, and
emits net-of-cache-reads `agent.llm_usage`. This is also what unlocks `multiProvider` honestly
(descriptor currently says `supportedProviders: ["anthropic"]` — vision-capable models via the
adapters can widen this later).

**Browser layer**: attach-only via `cdp_url`. Default: the existing chromium sidecar
(`localhost:9222`) from the warm-pool pod shape — zero new infra. Optional: a Browserstation
lane with an explicit lease + delete. The `playwright-mcp` sidecar becomes unnecessary for this
runtime (browser-use speaks CDP directly); keep it only if agents should also expose
Playwright-MCP tools.

**What we deliberately do NOT do**:
- Do not fork/reimplement browser-use's private step phases (`_prepare_context` etc.) to split
  capture/LLM/act into separate Dapr activities — whole-step-as-one-activity is the stable
  boundary; upstream churn makes anything deeper a treadmill.
- Do not put chromium in the agent image (sidecar/Browserstation owns the browser; the agent
  container stays slim and the image becomes CI-buildable — fixes `nix/images.nix` blocker).
- Do not use browser-use's stdio MCP client for in-cluster MCP; custom `@tools.action` entries
  or the platform's MCP wiring cover tool extension.

### Delivery notes

- **Image**: add `browser-use-agent-sandbox` to the Tekton outer-loop set with an in-repo
  Dockerfile → kills the `manual-local-docker-push` provenance; release-pin flows like every
  other service.
- **Registry**: descriptor mostly stands as-is (`per-activity`, warm-pool, browser sidecars).
  If we later drop the playwright-mcp sidecar for this runtime, flip `requiresBrowserSidecars`
  semantics accordingly.
- **Dispatch**: unchanged — `session_workflow` bridge + warm-pool lane keep working because the
  new service registers the same two workflows with the same childInput shape the current image
  does. The per-slug shared-host carve-out is a separate (pre-existing) concern; this rebuild
  neither fixes nor worsens it, but owning the source is the prerequisite for ever moving it to
  per-session pods.
- **Suggested phasing**: P1 skeleton service + executor-seam spike (fastest end-to-end proof,
  Option A) → P2 per-step subclass loop + cancellation + CMA events (Option B) → P3 LLM shim
  through the adapters + screenshot offload/compaction → P4 CI image + pin cutover + delete the
  hand-built image pin → P5 Browserstation lease hygiene + widen providers.

## 5. Risks

| Risk | Severity | Mitigation |
|---|---|---|
| Upstream API churn (quarterly breaking waves; Rust beta agent may deprioritize the Python loop) | Med | Hard-pin `browser-use==0.13.6`; touch only documented seams; upgrade deliberately behind the runtime canary |
| Screenshot/DOM payloads vs 16 MiB ceiling + silent Dapr 1.18 payload stall | High if ignored | State-store-by-ref + image compaction + multimodal offload (all precedented in dapr-agent-py); watch `dapr_runtime_workflow_*_payload_size_ratio` |
| Browser (external, non-durable state) diverges from replayed workflow expectations | Med | Whole-step activities are idempotent-ish only at step granularity; on retry, rehydrated `AgentState` + live browser continue forward — never replay browser actions; `rerun_history` exists for deliberate deterministic replays |
| Vision-model structured output failures (`AgentOutput` schema per step) | Med | Shim retries/nudges like dapr-agent-py's structured-output nudge; provider-native json-schema where available |
| dapr-agents internals coupling (same as dapr-agent-py's) | Low | Version already pinned (1.0.4); executor seam verified stable 1.0.3→1.0.5 as escape hatch |

## 6. Implementation status

**P1 (IMPLEMENTED 2026-07-20)** — `services/browser-use-agent/` is now a real service:
`BrowserUseDurableAgent(DurableAgent)` using the **executor seam**
(`BrowserUseExecutor(AgentExecutorBase)` drives `browser_use.Agent` via public
`take_step()`, remote CDP attach, between-step cancellation on
`session-cancel:{instance}`, in-memory `AgentState` for same-pod retry resume) plus a
minimal-but-faithful `session_workflow` port (same input shape, `session.status_*`
vocabulary, `autoTerminateAfterEndTurn`, terminal-control events, `__turn__N` child
instances) and the platform HTTP surface (`/internal/sessions/{spawn,raise-event}`,
`/api/v2/agent-runs/*`). **Default model: kimi-k3** via browser-use's
OpenAI-compatible `ChatOpenAI` → `KIMI_BASE_URL`/`KIMI_API_KEY`
(`agentConfig.modelSpec` `kimi/kimi-k3` resolution; non-Kimi specs fall back with a
warning in P1). Vendored `event_publisher.py`/`session_native.py`/`session_config.py`
are byte-identical to the shared/dapr-agent-py copies. Dependency note: browser-use
0.13.6 pins `anthropic==0.76.0` exactly vs dapr-agents' `>=0.98` — resolved via
`tool.uv.override-dependencies` (neither Anthropic client is on this service's path).
Verified: 21 unit tests (executor event stream, cancellation, budgets, retry-state,
kimi resolution) + a live local `dapr run` smoke (daprd 1.18.1, redis components):
boot registers `browser-use-agent` workflow/activity actor types, spawn-bridge starts
`session_workflow` with the platform childInput, turn dispatches
`sesn-…__turn__1` as a child workflow. Remaining phases: P2 per-step activities +
state-store AgentState, P3 adapter-layer LLM shim + screenshot offload, P4 CI image +
pin cutover, P5 Browserstation lease hygiene.

## 7. Bottom line

Compatibility is not in question — the current production runtime already proves
browser-use-on-DurableAgent works end-to-end through the `session_workflow` bridge. What's
missing is an owned, reproducible implementation. Build `services/browser-use-agent/` as a
`DurableAgent` subclass with a per-step `browser_step` activity (browser attached over
`cdp_url`, `AgentState` in the state store, screenshots offloaded), a `BaseChatModel` shim into
the existing adapter layer, and the platform contract cloned from `dapr-agent-py`. That
matches the registry's declared `per-activity` durability, restores Lifecycle Controller
cancellation, fixes the step-budget and Browserstation-leak defects, and makes the image
CI-buildable.
