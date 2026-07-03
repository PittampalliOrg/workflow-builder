# Goal Loop: Autonomous Session Goals (Codex `/goal` parity)

> **Status:** ✅ IMPLEMENTED — **2026-06-09/10**. Core loop **wfb #84**, budget-accrual fix **#87**, UI + spawn-time MCP auto-wire **#88**, usage-event net-of-cache convention (dapr-agent-py) **#90**; Session Pulse **#85/#86**; stacks: workflow-mcp-server Deployment/Service. The old `goal-loop-tick` CronJob was later retired with unused cron-driven internals. Shipped to `main`, deployed dev + ryzen. This is the **goal-loop SSOT**.
> **Scope:** A persistent per-session objective ("goal") that the platform autonomously drives across turns until the agent self-judges completion, a token budget is exhausted, or an iteration cap fires — Codex's `/goal` feature ported onto workflow-builder live sessions, with explicit divergences documented (Part 6).

---

## TL;DR

A goal is a row in `thread_goals` (one ACTIVE per session). A BFF-side **driver** watches the session-event stream: each `agent.llm_usage` accrues tokens into the goal's budget; each `session.status_idle{end_turn}` injects the next **continuation turn** — a normal `user.message` carrying the verbatim Codex continuation prompt — back into the live `session_workflow`. The agent ends the loop by calling the MCP tool **`update_goal(status:"complete")`** after a completion audit; the platform ends it via budget/iteration guardrails or a user pause. Exactly-once injection = atomic DB iteration claim + "latest event is idle" gate + deterministic `sourceEventId`.

The **budget accounting convention is load-bearing system-wide** (Part 4): all runtimes emit `agent.llm_usage.input_tokens` **net of cache reads**; goal budgets, Session Pulse cost, and the `context_*` stamp all depend on it.

---

## Part 1 — Architecture

### Data model — `thread_goals` (migration `drizzle/0079_thread_goals.sql`)

`id, session_id (FK sessions, cascade), goal_id, objective, status, token_budget (nullable), tokens_used, time_used_seconds, iterations, max_iterations (default 50), budget_steered_at, last_continuation_at, stop_reason, workflow_execution_id, created_at/updated_at/completed_at`.

- **One ACTIVE goal per session** — partial unique index `uq_thread_goals_session_active` (`WHERE status='active'`).
- `status ∈ active | paused | budget_limited | complete`. `stop_reason ∈ complete | interrupt | budget | iteration_cap`.
- **Replace semantics** (`createOrReplaceGoal`, `src/lib/server/goals/repo.ts`): setting a new objective UPDATEs the existing **drivable** row (active **or** budget_limited — see re-arm, Part 8), rotates `goal_id` (`crypto.randomUUID()`), and **resets all accounting** (`tokens_used/time_used_seconds/iterations/budget_steered_at/last_continuation_at/stop_reason` → zero/null) — codex `thread/goal/set` semantics.

### Driver — `src/lib/server/goals/{goal-loop,repo,render}.ts` (BFF)

Event-driven off `appendEvent` side-effects (`src/lib/server/sessions/events.ts:207` — dynamic import to avoid the events↔goal-loop cycle; fire-and-forget, swallows its own errors). No in-process timer.

- **`agent.llm_usage`** → `accrueUsage`: atomic SQL `tokens_used += delta`, refresh `time_used_seconds = now() - created_at`, and flip `active → budget_limited` in the same UPDATE when `token_budget` is crossed (mirrors codex `account_thread_goal_usage`).
- **`session.status_idle` with `stop_reason.type == "end_turn"`** (only; terminal idles ignored) → `driveContinuationIfIdle`:
  1. No drivable goal → return. Session stopping/terminal → return (and `pauseGoal` if a stop was requested on an active goal).
  2. **Idle gate**: the session's *latest* stored event must be a `session.status_idle` — proves no turn is mid-flight AND no newer `user.message` (human or already-posted continuation) is queued.
  3. `active` + under cap → **`claimNextContinuation`** (atomic UPDATE: `iterations += 1`, stamp `last_continuation_at`, guarded by `status='active' AND iterations < max_iterations AND last_continuation_at` older than the 2s spacing guard). Null result = raced/capped → no post.
  4. Post the rendered **continuation prompt** as `user.message` with `origin: "goal-continuation"`, `goalKind`, `goalIteration`, and deterministic `sourceEventId = goal-continuation:<sessionId>:<iteration>` → `appendEvent` (DB, deduped on `sourceEventId`) + `raiseSessionUserEvents` (Dapr raise-event into the live `session_workflow`). Conversation history is preserved because an interactive session is ONE durable instance.

**Exactly-once contract**: atomic iteration claim (3) + idle gate (2) + `sourceEventId` dedup — the inline hook, goal-set API kick, and stop-hook evaluation can all race safely and never double-drive.

### Prompt templates — `src/lib/server/goals/templates/` (verbatim codex ports)

`continuation.md` (next-turn steering: budget readout, "avoid repeating work", the **completion-audit** protocol — prompt-to-artifact checklist, no proxy signals, uncertainty = not achieved, call `update_goal` only when genuinely done) and `budget_limit.md` (wrap-up steering: no new substantive work, summarize + hand off). Rendered by `render.ts` (tiny `{{ var }}` replacer; objective stays wrapped in `<untrusted_objective>` so it's data, not instructions).

### Completion contract — goal MCP tools (workflow-mcp-server)

`services/workflow-mcp-server/src/{goal-tools,goal-context,goal-db}.ts`, registered alongside the workflow tools; **now actually deployed** (stacks `Deployment-workflow-mcp-server.yaml` + `Service-workflow-mcp-server.yaml`, port **3200**, `DATABASE_URL` + `INTERNAL_API_TOKEN` via `envFrom workflow-builder-secrets`; Dockerfile pnpm pinned `@9`).

- **`create_goal { objective, token_budget?, max_iterations? }`** — agent-initiated goal (replaces any existing one). The BFF driver picks it up on the next idle.
- **`update_goal { status }`** — accepts **ONLY `"complete"`** (pause/resume/budget transitions are user/system-owned). Returns a `completion_budget_report` so the agent reports final elapsed/consumed budget.
- **`get_goal {}`** — objective, status, tokens used/budget/remaining, elapsed, iterations.
- **Session scoping**: the BFF stamps `X-Wfb-Session-Id` into the goal MCP entry's headers at spawn (`stampGoalMcpSessionHeader`, `src/lib/server/sessions/spawn.ts:409` — matched by name `~goal` or URL `workflow-mcp-server`, never leaked to third-party servers); `index.ts` runs each MCP request inside an `AsyncLocalStorage` context (`goal-context.ts`), so the session id is **never a tool argument**.

### Auto-wire — every MCP-capable session gets the tools

`ensureGoalMcpServer` (`spawn.ts:384`) appends `{ name:"goal", transport:"streamable_http", url: GOAL_MCP_SERVER_URL }` to `agentConfig.mcpServers` on the session spawn path when the runtime descriptor declares `supportsMcp` — without the tools, a UI-set goal could only end via caps or manual pause. Opt-out `GOAL_MCP_AUTO_WIRE=false`; URL override `GOAL_MCP_SERVER_URL` (default `http://workflow-mcp-server.workflow-builder.svc.cluster.local:3200/mcp`). Skipped when an entry already matches the goal server.

---

## Part 2 — Guardrails

- **Token budget (soft cap)** — optional `token_budget`. Crossing it flips `active → budget_limited` (in `accrueUsage`); the next idle posts the `budget_limit.md` wrap-up as **exactly one** extra turn, claimed via `budget_steered_at IS NULL` (`claimBudgetSteer`; `stop_reason = coalesce(stop_reason,'budget')`). After that the loop posts nothing.
- **Iteration hard cap** — `max_iterations` (default 50). At idle with `iterations >= max_iterations`, `claimIterationCap` flips to `budget_limited` + `stop_reason='iteration_cap'` and claims the same one-time wrap-up (it stamps `budget_steered_at`, so the budget steer can't double-fire).
- **Stop/interrupt pauses the goal** — `POST /api/v1/sessions/[id]/stop` calls `pauseGoal` (`stop/+server.ts:71`), and the driver itself pauses an active goal when it observes `stop_requested_at` (`sessionStopState`). `status='paused'`, `stop_reason='interrupt'`.
- **Terminal sessions halt the driver** — `driveContinuationIfIdle` returns for `terminated/completed/failed/canceled` sessions; the goal row keeps its last state.
- **Spacing guard** — `CONTINUATION_MIN_SPACING_SECONDS = 2` collapses inline-hook ↔ tick-reaper races (real turns take far longer).

---

## Part 3 — Crash-Safety Boundary

The inline event hook is the active driver. The old **`goal-loop-tick` CronJob** and `POST /api/internal/goal-loop/tick` endpoint were retired with the unused cron-driven internals; the loop no longer has a timer-driven lost-idle probe. Goal-set and stop-hook paths still call the same idempotent `kickGoalLoop` driver, and exactly-once posting still comes from the DB claim + idle gate + deterministic `sourceEventId`.

**Pod-reschedule survival**: a per-session sandbox pod rescheduled mid-goal (e.g. during an image-pin rollout window) preserves conversation history — the interactive session is one durable Dapr instance and replays — so the loop continues across it (verified live, 2026-06-10).

---

## Part 4 — Budget accounting + the usage-event convention (LOAD-BEARING)

### Budget delta = codex semantics

Per `agent.llm_usage` event (`tokensFromUsage`, `goal-loop.ts`):

```
delta = input_tokens + output_tokens + cache_creation_input_tokens   // cache READS excluded
```

Cache creation counts (genuinely processed input, billed at a premium); cache reads do **not** — codex's `input - cached_input + output`. The pre-#87 bug counted cache reads: on agentic loops running 95%+ cached, budgets exhausted **~20x** faster than the work justified (observed: a $0.03 turn consuming 300k of "budget").

### SYSTEM INVARIANT: `input_tokens` is NET of cache reads

ALL dapr-agent-py adapters emit `agent.llm_usage` with `input_tokens` **disjoint from** `cache_read_input_tokens`. Anthropic reports this natively; **OpenAI + Alibaba report prompt tokens GROSS** (cached is a subset detail) — `openai_adapter.py` / `alibaba_adapter.py` now normalize with `input_tokens = max(0, gross - cached)` (`cached` from `input_tokens_details.cached_tokens` with a `prompt_tokens_details` fallback; `openai_adapter.py:362-378,617-622`; wfb #90). Three consumers depend on this convention — violating it in a new adapter silently corrupts all three:

1. **Goal budgets** (the delta above).
2. **Session Pulse cost** (sums per-model `input/output/cacheRead/cacheCreate` × per-million rates).
3. **The `context_*` stamp**: `event_publisher.py` post-ingest stamps every `agent.llm_usage` with `context_*` fields = `input + cache_read + cache_creation` (**full window occupancy**), `context_source/count_method = "provider_usage"`, scope `last_provider_call` (`event_publisher.py:413-431`, via `src/compaction/tokens.py::context_usage_fields`).

The bug was caught by the goal-loop eval (Part 7, scenario 1, on OpenAI gpt-5.5): **242 net tokens booked as 17,906**.

### Context % vs budget — deliberately different metrics

Session Pulse's **Context %** includes cached tokens (window occupancy — matches Claude Code's `calculateContextPercentages` exactly); the **goal budget** excludes cache reads (a *work* metric). Both are correct; don't "unify" them. Pulse prefers the latest provider-truth `context_*` fields (`context_count_method === 'provider_usage'`) over the pre-call `agent.context_usage` `local_advisory` heuristic, which undercounts 20–25%.

---

## Part 5 — API + UI surfaces

| Surface | Contract |
|---|---|
| `GET /api/v1/sessions/[id]/goal` | Current goal row (any status) or null. |
| `POST /api/v1/sessions/[id]/goal` | `{ objective, tokenBudget?, maxIterations? }` — create/replace + immediate `kickGoalLoop` (covers the already-idle session whose idle event won't re-fire). Workspace-scoped via `inspectDurableRun` + `isResourceInScope`. |
| `PATCH /api/v1/sessions/[id]/goal` | `{ status: "complete" \| "paused" }` only — active/budget_limited transitions are agent/driver-owned. |
| MCP `create_goal` / `update_goal` / `get_goal` | Agent-side contract (Part 1). |

**UI** — session detail (`src/routes/workspaces/[slug]/sessions/[id]/+page.svelte`):
- **Goal card** (`src/lib/components/sessions/session-goal-badge.svelte`): Set-goal dialog (objective, optional token budget, max iterations — dialog default 20; DB default 50), live tokens/iterations readout, status-dependent actions: **Pause** / **Mark complete** (active), **Resume / adjust** + **Mark complete** (paused/budget_limited — Resume re-opens the dialog, i.e. a re-set), **New goal** (complete).
- **Session Pulse** (`src/lib/components/sessions/session-pulse.svelte`, PRs #85/#86): vitals strip derived client-side from the event stream — Tokens (in/out split), Cache-hit % ring, **Cost** (live $ via `GET /api/v1/pricing?model=` backed by `src/lib/server/pricing/model-pricing.ts` `MODEL_PRICING`; shows "saved $X via cache"), **Context %** (provider-truth, Part 4), Elapsed (live tick), Turns + LLM calls, and a **Goal loop** tile.

---

## Part 6 — Codex parity divergences (audited)

| Area | Codex | Ours | Why |
|---|---|---|---|
| Continuation visibility | Hidden `developer`-role injection | **Visible `user.message`** (`origin: goal-continuation` lets the UI style/hide it) | CMA event stream has no hidden developer role; visibility aids debugging |
| Budget-limited behavior | Steering injected **mid-turn**; no continuations after BudgetLimited | One **extra autonomous wrap-up turn** at the next idle | We can't inject mid-turn into a durable activity; one bounded turn is the closest safe equivalent |
| `update_goal` accounting | The call itself excluded from usage | The call **IS accounted** | It rides a normal turn; not worth special-casing |
| Wall-clock | Active-time deltas | `now() - created_at` | Simpler; goals span idle gaps anyway |
| Plan-mode / feature-flag gates | Present | **None** | Always-on |
| Unpause | Accounting-preserving | **Re-set resets counters** (replace semantics) | One drivable row, rotate-and-reset keeps the model simple |
| Iteration cap | — | **Ours adds `max_iterations`** (hard cap) | Defense against infinite loops codex relies on budget for |
| Crash-safety | In-process | **DB-derived claims + event-driven retries** | Continuations remain idempotent across duplicate hooks and explicit kicks |

---

## Part 7 — Eval scenarios (reusable regression harness)

Run by setting the objective as a **goal on a live session** (dev agent `goal-eval-deepseek`, project `P-1UUm25pvbzh3da4TXJD`, exists for exactly this) with a token budget, then watching the loop drive to `update_goal(complete)`. They regression-test the loop mechanics AND the accounting invariant (scenario 1 caught the OpenAI net-of-cache bug, Part 4).

**Scenario 1 — itsdangerous TDD** (loop mechanics + accounting):

> Clone https://github.com/pallets/itsdangerous into the workspace and establish a **green baseline**: install dev dependencies, run the full test suite, record the pass count. Write `PLAN.md` identifying — with `file:line` references — the under-tested behaviors you will cover. Add **4 new tests** covering previously untested behavior. Re-run the **full** suite and perform a completion audit: all pre-existing tests still pass, the 4 new tests pass, and `PLAN.md`'s `file:line` references match the shipped tests. Deliverables: `PLAN.md`, the 4 committed tests, full-suite output with the final pass count.

**Scenario 2 — red-green TDD on pytest-dev/iniconfig** (false-completion probe — the REQUIRED failing stage at step 2 proves the agent can't shortcut to "complete"):

> Practice strict red-green TDD on https://github.com/pytest-dev/iniconfig: (1) clone + green baseline (full suite passes); (2) **REQUIRED failing stage** — write a new test for behavior not yet implemented and show the suite **RED**, capturing the failing output as evidence; (3) implement the minimal change to make it pass; (4) full-suite audit showing green. The goal is NOT complete unless evidence of the red stage at step 2 exists — a run that skips straight to green has failed the protocol.

---

## Part 8 — Operational notes

- **Re-arm semantics**: `createOrReplaceGoal` replaces **active AND budget_limited** rows (keeping a single drivable row per session) — re-setting after budget exhaustion re-arms the loop instead of leaving a stale steered row shadowing the new goal. `goal_id` rotates; accounting resets.
- **Goal stuck / not continuing**: check (1) is the latest non-telemetry `session_events` row a `status_idle`? (the gate); (2) `last_continuation_at`; (3) `stop_requested_at` on the session (a stop pauses the goal).
- **Goal never completes on its own**: verify the session actually has the goal MCP server (auto-wire is spawn-time only — sessions spawned before #88, or with `GOAL_MCP_AUTO_WIRE=false`, lack the tools and can only end via caps/pause).
- **Budget burned implausibly fast**: re-check the adapter invariant (Part 4) — a new/changed adapter emitting gross `input_tokens` reintroduces the 20x over-burn.
- **drizzle raw-SQL note**: `repo.ts` raw `db.execute(sql…)` rows come back **snake_case** (no field mapping) — `mapGoalRow` normalizes; keep using it for new raw queries.

## Appendix — file index

- BFF driver: `src/lib/server/goals/goal-loop.ts` (driver), `repo.ts` (atomic claims/transitions), `render.ts` + `templates/{continuation,budget_limit}.md`
- Event hook: `src/lib/server/sessions/events.ts:207`; spawn wiring: `src/lib/server/sessions/spawn.ts:373-424`
- Routes: `src/routes/api/v1/sessions/[id]/goal/+server.ts`
- MCP: `services/workflow-mcp-server/src/{goal-tools,goal-context,goal-db}.ts`, wired in `index.ts`
- UI: `src/lib/components/sessions/{session-goal-badge,session-pulse}.svelte`; pricing: `src/lib/server/pricing/model-pricing.ts`, `src/routes/api/v1/pricing/+server.ts`
- Runtime: `services/dapr-agent-py/src/{openai_adapter,alibaba_adapter}.py` (net-of-cache normalization), `event_publisher.py:405-435` (`context_*` stamp)
- stacks: `packages/components/workloads/workflow-builder/manifests/{Deployment-workflow-mcp-server,Service-workflow-mcp-server}.yaml`
- Schema: `drizzle/0079_thread_goals.sql`, `src/lib/server/db/schema.ts` (`threadGoals`)
