# Workflow & Agent Lifecycle: Stop / Terminate / Purge

> **Status:** ✅ IMPLEMENTED — **2026-06-07**. The cutover shipped across **PR1–PR4** (wfb #62 / #63 / #64, stacks #2523, wfb #65); a production incident then hardened it into a **reliable** model across **wfb #69–#72** (request/confirm + stop-surface ownership + cooperative-first — see **Part 7**; deployed dev + ryzen on `git-c1470aa1`). This is the **lifecycle SSOT**.
> **Scope:** A single vetted method for stopping/terminating/purging Dapr Workflows and durable agent runs, the root-cause fixes for stale/corrupt state across reruns, and the full cutover that routes every user-facing "stop" through it.

This doc began as the output of a deep audit (external Dapr best-practices research + a 9-slice code audit of `workflow-builder:main` and `stacks:main`); the design has since been **implemented in full**. Parts 1–3 retain the audit framing (the *why* + the original current-state map / root-causes — historical baseline). Parts 4–6 are now **as-built**. Every original behavioral claim was cited to `file:line` (as of the audit, 2026-06-07 — re-verify before editing) or to a Dapr primary source (Appendix B); file:line references in Parts 1–3 describe the **pre-fix** state and are kept for traceability.

---

## TL;DR

**Before this work** there were **≥8 user-facing "stop" affordances across 6 backend contracts**, and the operation users most need — *"actually stop this run and leave nothing behind that breaks the next run"* — was implemented **correctly in exactly one place** (benchmark **instance** terminate) and **wrong or absent everywhere else**. **Now** all of them route through one Lifecycle Controller.

The "stale/corrupt data from prior runs" pain had a concrete root cause: **deterministic IDs were reused without purging the prior occupant**, and in the worst case the per-session **Sandbox CR create silently swallowed HTTP 409 and *adopted* the stale pod** (`services/sandbox-execution-api/src/app.py:1371-1373`). Both are fixed (guarded purge-before-reuse + owner-run-id no-adopt).

Dapr already gives us the right primitives (terminate / purge / pause / resume / raiseEvent; recursive-by-default; **v1.17 purge-force + reminder-cleanup-on-purge** — we run control plane **1.17.9**), and we already had a **reference-quality cascade** in `cleanupBenchmarkDurableWorkflowCascade` (`src/lib/server/benchmarks/service.ts:2518`). **This was done:** that cascade was generalized into one **Lifecycle Controller** (`src/lib/server/lifecycle/{cascade,resolvers,index}.ts`), every user surface now routes through it, the root-cause bugs are fixed, and the `workflow-builder`-namespace `workflow-builder-sandbox-gc` CronJob shipped as the remaining timer-driven safety net. The old terminal-status reaper CronJob was later retired with the unused internal lifecycle endpoints. See **Part 4 (as-built)** and **Part 5 (what shipped)**.

A later production incident — a Stop on a run blocked in a long activity reported a false 409 and a benchmark instance kept being re-driven — hardened this into a **reliable** model: stop is a persisted **intent** confirmed asynchronously (HTTP **202 "stopping"**, not a one-shot fail-closed 409), explicit stop/status confirmation reconciles convergence, each unit has a **single stop authority** (coordinator-owned instances redirect to their run), and terminate is **cooperative-first**. See **Part 7**.

---

## Part 1 — What Dapr says is correct (best practices)

Primary sources in Appendix B (docs.dapr.io workflow API + howto-manage-workflow + features-concepts; dapr/python-sdk workflow examples; Dapr v1.17 release notes; dapr/dapr#6393).

1. **Five distinct lifecycle ops — pick the right one.**
   - **Terminate** (`POST /v1.0/workflows/dapr/{id}/terminate`; SDK `terminate_workflow(instance_id)`) — the correct "user clicked Stop." Moves a running instance to `TERMINATED`. **Recursive to child workflows by default** (dapr/dapr#6393 shipped the cascade; `non_recursive=true` to disable). **Does NOT affect in-flight *activities*** — only child *workflows*.
   - **Purge** (`DELETE` / `POST .../purge`; SDK `purge_workflow(instance_id)`) — deletes metadata + inputs + outputs + **history**. **Only valid on terminal instances** (COMPLETED/FAILED/TERMINATED). Recursive to children by default.
   - **Pause/Resume** (`suspend_workflow` / `resume_workflow`) — reversible hold, not a stop.
   - **RaiseEvent** (`raise_workflow_event`) — cooperative signal; only works if the workflow is awaiting that event.
2. **Terminate → Purge is the canonical "stop and clean" sequence.** Cannot purge a running instance; terminate (or wait for completion), confirm terminal, then purge. Documented pattern: `wait_for_workflow_completion(id, timeout)` then `purge_workflow`.
3. **ID reuse is a first-class hazard.** One instance per ID; reusing an ID requires the prior to be **purged first** (`OrchestrationIdReusePolicy`). A stuck non-terminal instance under a reused ID is the canonical stale-state trap.
4. **Dapr v1.17 directly targets our two biggest pains** (we run 1.17.9):
   - **Purge cleans up the associated actor reminders / scheduled work** (no more orphaned `new-event-*`).
   - **"Purge force"** — purge even when the workflow **worker isn't connected** (the per-session pod is already dead). *Verify exact SDK flag against `dapr-ext-workflow==1.17.1`.*
5. **DurableAgent has no separate stop API.** Dapr-Agents' `DurableAgent` is backed by Dapr Workflows + event sourcing; **to stop an agent you terminate its workflow instance.**
6. **Cross-app-id children are the asterisk.** The recursive cascade operates within **one app's task hub**. Our `session_workflow` children run under **per-session sandbox app-ids** = separate task hubs, so the native cascade **does not reach them** — they must be terminated/purged **explicitly per app-id**.
7. **Dev reset** = terminate-then-purge per instance; `dapr workflow purge --all-older-than` for bulk. No "wipe one workflow type" primitive — build it from terminate+purge over the instance set.

---

## Part 2 — Current-state map (the fragmentation) — HISTORICAL (pre-cutover)

> This table captures the **pre-cutover** fragmentation that motivated the work. As of PR1–PR4 every surface routes through the Lifecycle Controller (Part 4/5); the table is kept as the before-picture.

User-reachable "stop" surfaces. Columns: **T**erminate durable instance? **P**urge state? reach **C**ross-app children? reap **S**andbox CR? flip **DB** rows?

| # | Surface | Backend | T | P | C | S | DB | Verdict |
|---|---|---|---|---|---|---|---|---|
| 1 | Session **Interrupt** (`/control/interrupt`) | `raiseSessionEvent` `user.interrupt` | ✗ | ✗ | ✗ | ✗ | ✗ | Turn-boundary only; **no-op mid-turn for durable/run** (key-mismatch bug) |
| 2 | Session **Archive** (PATCH) | `archiveSession` `registry.ts:469` | ✗ | ✗ | ✗ | ✗ | `archivedAt`, MLflow→KILLED | Agent keeps running |
| 3 | Session **Delete** (list → DELETE) | `deleteSession` `registry.ts:487` | ✗ | ✗ | ✗ | ✗ | `DELETE FROM sessions` | **Orphans live durable instance + pod**; mislabeled "Archive" in list |
| 4 | Session **Destroy sandbox** (`/sandbox` DELETE) | `deleteKubernetesSandbox` | ✗ | ✗ | n/a | ✓ CR | ✗ | Kills pod under a live workflow → wedged mid-turn |
| 5 | Workflow run detail | — | — | — | — | — | — | **No run-level stop button** (only "Stop Preview" = sandbox proxy) |
| 6 | Workflow exec terminate (`/api/workflows/executions/[id]/terminate`) | orchestrator `/terminate` | ~ | ✗ | ~legacy | ✗ | flips `executions`+`agent_runs`, not `sessions` | **Dead in UI**; **2s timeout swallowed** → flips DB `cancelled` w/o confirming; never purges |
| 7 | Benchmark run **Cancel** | `cancelBenchmarkRun` + coordinator | ✓ bg | ✓ | ✓ | ✓ | ✓ | Correct but fire-and-forget; force-purge-on-unclosed can leave reminders |
| 8 | Benchmark instance **Terminate** | `terminateBenchmarkRunInstance` | ✓ | ~ | ✓ **(only per-session app-id fan-out)** | ✓ | ✓ | **Reference implementation**; fail-closed (409 if unconfirmed) |
| 9 | Evaluation run **Cancel** | `cancelEvaluationRun` `evaluations/service.ts:1489` | ✗ BFF | ✗ | ✗ | ✗ | DB flip + best-effort HTTP | Weakest; trusts an out-of-band coordinator |
| 10 | Crawl (`web/crawl.async`) | — | — | — | — | — | — | **No stop affordance**; only SQL reset |
| 11 | Retired Admin Workflow Ops (`/admin/instances/[id]`) | removed | n/a | n/a | n/a | n/a | n/a | Obsolete diagnostic surface retired; use Lifecycle Controller stop/status routes and workflow execution read models |

**Six contracts, one concept.** The *correct* cascade (row 8) is benchmark-only; the *most-used* surfaces (sessions, workflow runs) are weakest. The benchmark cancel path (`cleanupBenchmarkDurableWorkflowCascade`, `service.ts:2518`) is the model to generalize: graceful event → terminate orchestrator + per-session agent app-ids → wait terminal → purge `recursive=true` → raw state-row delete → delete Sandbox/Job/Pod/ConfigMap → release leases → flip DB.

---

## Part 3 — Root causes of "stale/corrupt data breaks future runs"

> **Historical (pre-fix) audit.** Every mechanism/bug below is now **fixed** — see Part 4 (as-built) and Part 5 (what shipped). Kept verbatim for traceability; the `file:line` cites describe the pre-fix code.

**Stale-state mechanisms:**

1. **Sandbox CR 409-adopt (smoking gun).** `create_namespaced_custom_object` for the per-session `agent-host-agent-session-<sha20>` CR **swallows 409 AlreadyExists and adopts the existing CR/pod** (`services/sandbox-execution-api/src/app.py:1371-1373`). A deterministic CR name surviving a prior failed/retried run means the next run **inherits the old pod's filesystem, process state, and OpenShell gateway** — never reset.
2. **Idempotent-schedule returns zombies.** `_idempotent_schedule` purges only **terminal** prior instances; a stuck `RUNNING/PENDING/SUSPENDED` is returned as "existing" (`services/workflow-orchestrator/app.py:914-920`), and `_existing_live_execution_instance` short-circuits on a non-terminal DB row (`app.py:3149-3165`). A never-terminal prior run **permanently wedges** that deterministic ID.
3. **Deterministic IDs omit the execution ID.** Child `session_workflow` id = `{parent}__{prefix}__{node}__run__{index}` (`services/workflow-orchestrator/workflows/sw_workflow.py:1291-1293`); crawl jobId = `j_<sha256(workflowId|nodeId|url)>` (`services/workflow-orchestrator/activities/crawl4ai.py:41-52`) — **execution-independent**. With (2) + the crawl adapter returning existing PENDING/RUNNING jobs (`services/crawl4ai-adapter/app.py:580-618`), an un-purged prior occupant **blocks or silently shadows** the rerun.
4. **DB ↔ durable divergence; no terminal-status reaper.** `sessions.status='terminated'` is written **only** by the agent's `session.status_terminated` event (`src/routes/api/internal/sessions/[id]/events/ingest/+server.ts:138-142`); pod death before that event = stuck `running` forever. The workflow-terminate route flips `executions`/`agent_runs` but **never `sessions`**, even when the 2s Dapr call timed out. **Nothing on a timer reconciles DB vs Dapr.** The very existence of `scripts/reconcile-stale-workflow-agent-runs.ts`, `scripts/dev-purge-stale-workflows.ts`, and the documented `crawl4ai_jobs`/`workflow_workspace_sessions` SQL resets is the tell that automated GC is missing.
5. **Split-brain retention → cascade-termination race.** Parent orchestrator uses **168h** (`stacks .../Configuration-workflow-orchestrator-no-tracing.yaml`), per-session hosts inherit **30m** completed/terminated (`stacks .../Configuration-openshell-sandbox-dapr.yaml`). Children auto-purged before the parent finishes → parent loops on `no such instance exists`. The `stuck-workflow-watchdog` CronJob exists to clean this reactively — but it **excludes per-session agent-host pods**, and the Sandbox-GC CronJobs only sweep the **`openshell`** namespace, not `workflow-builder`. `workflowstatestore` has `cleanupInterval "0"` (no DB-level expiry); `CLEANUP_STALE_ON_STARTUP` is `"false"` in GitOps.

**Correctness bugs that make "stop" lie:**

6. **Cooperative cancel is a no-op for durable/run.** Interrupt writes `session-cancel:{session_instance}`, but in auto-terminate mode the inner `agent_workflow` reads `session-cancel:{<session>__turn__N}` (`services/dapr-agent-py/src/main.py:5253-5257`) — **keys never match**. Mid-turn interrupt silently does nothing for the most common workflow-driven case (works only for UI sessions where `agent_turn_instance_id == session_instance`).
7. **`terminate_durable_runs_by_parent_execution` is dead code** for real runtimes — fans out only to the retired `claude-code-agent` app-id (`services/workflow-orchestrator/activities/call_agent_service.py:320`); neither active runtime implements `api/runs/terminate-by-parent`.
8. **Historical workflow-ops bypass.** The old `/api/workflow-ops/*` operation routes were a diagnostic bypass around the lifecycle controller. They were first admin-gated during the stop cutover and later retired with the unused admin workflow-instance surface. The dead `/api/orchestrator/workflows/[id]` purge route and dead api-client methods were also removed.
9. **`recursive`/`force` purge flags are dropped at the orchestrator.** The BFF forwards them, but `_workflow_http_post(instance_id, "/purge")` (`app.py:611,3647`) never appends query params — `recursive` is a logged no-op; `force` only triggers the legacy single-app-id child cleanup. (Dapr's default purge is recursive anyway, so this is cosmetic — but it diverges from what the UI checkbox implies.)

**Runtime asymmetry:** `dapr-agent-py` has terminate/pause/resume/purge endpoints + cooperative cancel + host-monitor (default action `"warn"`, `main.py:6343`); `claude-agent-py` has **none** of these and is un-stoppable mid-turn (its only cutoff is a 15-min per-turn `when_any` timer that then retries 3×, `services/claude-agent-py/src/session_workflow.py:239-250`). Terminate does not interrupt an in-flight activity, so claude's whole-turn-in-one-activity model can only be truly stopped by deleting the Sandbox CR.

---

## Part 4 — The vetted method: one **Lifecycle Controller** (AS-BUILT)

A single target-agnostic server-side module that every surface calls. One contract, fail-closed, idempotent, retryable. Generalizes `cleanupBenchmarkDurableWorkflowCascade` (which is now shared with it). **Shipped** in `src/lib/server/lifecycle/{cascade,resolvers,index,ownership}.ts`.

### API — `src/lib/server/lifecycle/`

Entry point `stopDurableRun(target, { mode })`:

```ts
stopDurableRun(
  target: { kind: 'workflowExecution'|'session'|'evalRun'; id: string },
  opts: { mode: 'interrupt'|'terminate'|'purge'|'reset'; reason?: string; graceMs?: number }
): Promise<{ confirmed: boolean; steps: StepResult[]; retryToken?: string }>
```

> `target.kind` landed as `workflowExecution | session | evalRun`. Benchmark cancellation is **shared with** the controller (it generalized `cleanupBenchmarkDurableWorkflowCascade`) rather than being routed as its own `target.kind`.

**Modes:**
- **`interrupt`** — cooperative only (raise `session.terminate`/`user.interrupt`, bounded wait). "Pause the agent, keep the run."
- **`terminate`** — graceful raise → Dapr terminate parent **and every child app-id** → poll to terminal (bounded). "Stop."
- **`purge`** — terminate (if needed) → confirm terminal → Dapr purge (recursive; **1.17 purge-force when worker gone**) parent + each child app-id → reap Sandbox CRs → flip all DB rows terminal. "Stop & clean."
- **`reset`** (dev) — purge **+** delete the deterministic-ID occupants (workflow instance, child instances, Sandbox CRs, crawl jobs) so the next run starts byte-clean.

### Cascade (single implementation)

1. **Resolve the tree** — parent instance + child `session_workflow` instances **with their per-session app-ids** + Sandbox CR names + DB rows (sessions, agent_runs, workspace_sessions, crawl jobs).
2. **Graceful** (if `graceMs>0`) — raise `session.terminate` to each agent; bounded wait.
3. **Terminate** — Dapr terminate on parent **and each child app-id** (explicit fan-out — do **not** trust the native cascade across app-ids). Poll to terminal.
4. **Purge** — Dapr purge recursive on parent + each child app-id; **purge-force** when the worker is disconnected. 1.17 cleans the reminders.
5. **Reap K8s** — `deleteKubernetesSandbox` for each per-session CR (**the CR, not the pod** — respawn trap, `src/lib/server/kube/client.ts:928`); Kueue workloads GC via owner-ref.
6. **Flip DB terminal** — sessions→`terminated`, executions→`cancelled`, agent_runs→`failed`, workspace_sessions→`cleaned`, crawl jobs→`FAILED`, benchmark/eval rows.
7. **Confirm + report** — fail-closed (return `confirmed:false`/HTTP 409 like the benchmark-instance path); expose an idempotent **retry**; surface partial failures (no silent `console.warn`).

### Root-cause fixes bundled with the controller (the "no stale state" half) — ✅ SHIPPED

- ✅ **Stopped adopting stale Sandbox CRs** — sandbox-execution-api no longer blindly 409-adopts an existing CR; it stamps an **owner-run-id** annotation and adopts only the SAME run, else deletes + recreates (no inherited stale pod state).
- ✅ **Purge-before-reuse** — `_idempotent_schedule`'s purge-before-reuse is **GUARDED** to only the DB-terminal-but-Dapr-non-terminal divergence; it NEVER kills a legitimately running instance.
- ✅ **Fixed the cooperative-cancel key mismatch** for durable/run — dapr-agent-py's cancel-key write/read now AGREE (the check reads candidate keys, stripping `__turn__N` / `:turn-N`), so a mid-turn `user.interrupt` / `session.terminate` actually halts.
- ✅ **`claude-agent-py` management parity** with dapr-agent-py — `POST /api/v2/agent-runs/{id}/{terminate,pause,resume}` + `DELETE` purge (via `DaprWorkflowClient`), cancellation persistence, a between-turn cooperative-cancel check, and `TERMINAL_CONTROL_EVENT_TYPES`. **`terminate_durable_runs_by_parent_execution` was RETIRED** (it only ever fanned out to the legacy `claude-code-agent` app-id) — the BFF controller now does explicit per-session app-id fan-out; same-task-hub children rely on Dapr's native recursive cascade.
- ✅ **Retired bypass routes.** `/api/workflow-ops/*` was admin-gated during the lifecycle cutover and later removed with the obsolete admin workflow-instance surface. The dead unauthenticated `DELETE /api/orchestrator/workflows/[id]` purge route and dead api-client methods (`workflows.terminateExecution`, `orchestrator.terminate/raiseEvent`) were removed.
- ✅ **Forward `recursive`/`force`** — `_workflow_http_post` now forwards query params; `purge_workflow` is recursive-by-default + forwards `force` (purge-force, Dapr 1.17.9).

### GitOps safety nets (stacks, PR4) — ✅ SHIPPED

- ✅ **Unified Dapr `stateRetentionPolicy = 168h`** across the parent (`workflow-orchestrator-no-tracing`) AND the per-session child Configs (`workflow-builder-agent-runtime`, `openshell-sandbox-dapr`) — closing the cascade-termination race (children were auto-purged before the parent finished; the old split was 168h vs 30m).
- ✅ **`workflow-builder-sandbox-gc` CronJob** — age-based GC of orphaned per-session agent-host Sandbox CRs in the `workflow-builder` namespace (excludes SandboxWarmPool-owned).
- Retired: the old `lifecycle-terminal-reaper` CronJob and `/api/internal/lifecycle/reap-terminal` endpoint were removed with the unused cron-driven lifecycle internals. Explicit stop/cancel routes still use the Lifecycle Controller.
- ✅ **`runbooks/phase0-lifecycle-clean-slate.{sh,md}`** — guarded, dry-run-by-default one-time purge (NOT auto-run).

---

## Part 5 — What shipped (full cutover, PR1–PR4)

The cutover landed across four PRs (wfb #62/#63/#64, stacks #2523, wfb #65). The original phasing maps to the PRs as follows:

- **Phase 0 — Clean slate.** Delivered as the **guarded** `runbooks/phase0-lifecycle-clean-slate.{sh,md}` (dry-run-by-default, NOT auto-run) rather than a single destructive sweep — `reset`/purge across `workflow-orchestrator` + per-session app-ids, Sandbox CRs, and stuck DB rows, run on demand.
- **Phase 1 — Lifecycle Controller (BFF).** ✅ `src/lib/server/lifecycle/{cascade,resolvers,index,ownership}.ts`: target-agnostic, request/confirm (202 "stopping" → confirmed; not a one-shot fail-closed 409 — see Part 7), idempotent/retryable; lifted from and now **shared with** the benchmark cascade (`cleanupBenchmarkDurableWorkflowCascade`). Explicit per-session app-id fan-out.
- **Phase 2 — Every surface re-pointed.** ✅ `POST /api/v1/sessions/[id]/stop`, `POST /api/workflows/executions/[id]/stop`, session interrupt, workflow-execution terminate, and eval cancel all route through the controller. UI **Stop** / **Stop & Reset** buttons on the session-detail + workflow-run pages. The sessions-list "Archive" row action was relabeled **Delete** (it always hard-DELETEd). Delete/Archive are **BLOCKED** (409 "Stop the run first") while a run is active. Divergent/dead routes were removed; the obsolete workflow-ops diagnostic surface was later retired. UI vocabulary: **Interrupt / Stop / Stop & Reset**.
- **Phase 3 — Runtime + orchestrator fixes.** ✅ dapr-agent-py cancel-key write/read agreement; claude-agent-py management parity (terminate/pause/resume/purge + cooperative cancel + `TERMINAL_CONTROL_EVENT_TYPES`); guarded purge-before-reuse; sandbox-execution-api owner-run-id no-adopt; `_workflow_http_post` forwards query params + recursive/force purge. (`dapr-agent-py` needs **both** image builds — see the dual-image note in `CLAUDE.md`.)
- **Phase 4 — GitOps safety nets (stacks #2523).** ✅ unified `stateRetentionPolicy = 168h` (parent + per-session children); `workflow-builder-sandbox-gc` CronJob. The old terminal-status reaper CronJob was later retired with the unused internal lifecycle endpoints.
- **Phase 5 — Verified end-to-end:** Start → Stop mid-turn (both runtimes) → durable terminal + CR gone + DB terminal + re-run same node starts byte-clean; stale Sandbox cleanup is covered by the `workflow-builder-sandbox-gc` safety net.

---

## Part 6 — Verification checklist (use to re-validate)

These were exercised during the PR1–PR4 cutover; keep them as the regression checklist.

- [x] Stop a running **direct UI session** mid-turn → durable instance `TERMINATED`, Sandbox CR deleted, `sessions.status='terminated'`, pod gone.
- [x] Stop a running **workflow-driven session** (durable/run) mid-turn → parent + child app-id both terminated+purged; cooperative cancel actually fires (key fix).
- [x] Stop on **claude-agent-py** = parity with dapr-agent-py (management surface exists).
- [x] **Re-run the same workflow node** after a stop → fresh Sandbox CR (no 409-adopt; owner-run-id no-adopt), fresh durable instance (guarded purge-before-reuse), fresh crawl job.
- [x] **Kill a sandbox pod** mid-run → lifecycle controller cleanup and sandbox GC leave no stuck `running` rows.
- [x] **Orphaned reminders**: after purge, no `new-event-*` reminders remain (1.17 cleanup).
- [x] **Auth**: obsolete workflow-ops bypass routes are gone; cross-workspace stop 404s.
- [x] **No `workflow-builder` Sandbox/Workload accumulation** after a soak of start/stop cycles (`workflow-builder-sandbox-gc` CronJob).

---

## Part 7 — Reliable termination: request/confirm + stop-surface ownership (wfb #69–#72)

Parts 4–5 made stop *correct*. A production incident then exposed three reliability gaps, fixed across **wfb #69–#72** (merged 2026-06-07; deployed dev + ryzen on `git-c1470aa1`).

**The incident** (`Ruc6rD7…`, an instance of benchmark run `5dgaXl4AaK…`): a user's Stop reported a false **409** and left the row stuck `running`, because —
1. the BFF cascade waited a **hard-coded 45s, one-shot + fail-closed**, but a Dapr workflow blocked inside a long `solve` activity only applies `terminate` once the activity yields (here ~1m40s later — after the window expired);
2. the run was a **benchmark instance** whose coordinator re-dispatches any non-terminal instance, and the generic per-execution "Stop run" fought it; and
3. the then-active terminal reaper **skipped entirely** while any benchmark lease was active — and the run had leaked 2 active leases — so the divergence never self-healed. That cron-driven reaper path was later retired with the unused internal lifecycle endpoints.

### (P1, #69) Request/confirm separation — stop is a durable intent
Fail-closed now means "not yet confirmed; will reconcile," never "failed + DB stale forever."
- `stopDurableRun` stamps **`stop_requested_at`** (new columns on `workflow_executions` + `sessions`, migration `drizzle/0071_lifecycle_stop_requested.sql`) **before** the cascade (`resolvers.markStopRequested`).
- Its result gained `{ requested, state: "confirmed" | "stopping" | "notFound" }`. On `!allClosed` it returns **`stopping`** (intent persisted, converging) — but it **still never flips DB / reaps until Dapr is confirmed terminal** (no lying about success).
- `/stop` routes map `state` → **200** confirmed · **202** stopping · 404 · 409.
- The poll window is now env-tunable + raised: `LIFECYCLE_CASCADE_WAIT_SECONDS` (default **90**), `…_POLL_SECONDS`, `…_REQUEST_TIMEOUT_SECONDS` (wired in `index.ts` → `createDaprCascadeDeps`).

### (P1, #69) Historical terminal-reconciliation hardening
The now-retired `reaper.ts` stopped early-returning when a benchmark was active — the **per-row "Dapr terminal/gone" guard IS the safety**, so a leaked lease could not blind it to a genuine orphan. It also:
- runs a **priority stop-requested pass**: finalize rows with `stop_requested_at` the moment their Dapr handle is terminal/gone (**no age cutoff**) — closes "clicked Stop (202), then closed the tab"; and
- checks a **session's** terminal state via the per-session **agent-runtime** handle (`getAgentRuntimeStatus`, `isSessionTerminalOrGone`), not the orchestrator hub — a `session_workflow` doesn't live on the orchestrator task hub, so the old `getParentStatus` check could over-reap a live session.

### (P2, #70) Single stop authority — coordinator-owned instances redirect to their run
**Principle: a unit's stop affordance lives only on the surface owned by its lifecycle authority.** A benchmark/eval *instance* has a `workflow_executions` row, so it surfaced the generic per-execution "Stop run" — which is futile (its run coordinator re-drives a non-terminal instance).

| Durable unit | Single stop authority |
|---|---|
| Standalone workflow execution | its own workflow-run **Stop** |
| Agent session (direct) | session **Stop / Stop & Reset** |
| Workflow-driven child session | the parent execution's Stop (fans out to children) |
| Benchmark **instance** | the benchmark **run** Cancel |
| Eval **instance** | the eval **run** Cancel |

- `PostgresLifecycleCoordinatorOwnerStore` implements the coordinator-owner
  ports and maps an execution or Dapr instance id to its owning run via
  `benchmark_run_instances` / `evaluation_run_items`.
- `POST /api/workflows/executions/[id]/stop` **rejects** a coordinator-owned execution with a structured **409** `{ error:"coordinator_owned", ownedBy, runId }` (the guard is on the user route; the owning benchmark/evaluation run remains the lifecycle authority). `GET /api/workflows/executions/[id]` returns `owner`; the run-detail UI **hides** the generic Stop and shows **"Managed by benchmark/evaluation run →"**.

### (P3, #71) "Stopping…" confirm UI
`confirmDurableStop(target)` (idempotent — called by the status poll) re-checks every durable handle and, once all terminal/gone, reaps Sandbox CRs + flips DB. New **`GET /api/workflows/executions/[id]/stop/status`** and **`GET /api/v1/sessions/[id]/stop/status`** → `{ state }`. The session-detail + workflow-run Stop buttons show **"Stopping…"** on a 202 and poll to convergence. If the tab closes before confirmation, the row stays marked with `stop_requested_at` until a later explicit status read or control-plane action finalizes it.

### (P4, #72) Cooperative-first by default
`stopDurableRun` defaults a short grace (`LIFECYCLE_TERMINATE_GRACE_SECONDS`, default **5s**; `0` = pure force) for terminate/purge/reset, so the cascade raises the cooperative cancel first — which the dapr-agent-py cancel-key (Part 4) honors at the next turn/tool boundary — and force-terminates only if the agent doesn't yield.
> **Deferred (engineering call):** (a) raising `session.terminate` to a cross-app child *inside* the orchestrator workflow is redundant — the cascade already fans out cross-app; (b) cancel checkpoints *inside* a single long `call_llm`/tool activity are marginal — `solve` runs as per-activity calls so it already cancels *between* turns/tools (the incident's ~1m40s was one in-flight activity finishing) — at the cost of a high-risk dual-image agent-runtime change. Revisit only if mid-single-call cancellation is needed.

### (P5, #77) Cross-app child wedge — force-finalize after a grace
A `durable/run` step dispatches its agent child via `ctx.call_child_workflow(app_id=<per-session agent app-id>)` — a **cross-app-id sub-orchestration on a SEPARATE Dapr task hub**. Dapr's recursive terminate is **task-hub-bounded**, so a bare terminate on the SW-interpreter parent **never applies** while it awaits that child: the cascade terminates the child agent fine (verified — the child reaches terminal/gone, **no runaway compute**), but the parent hangs `RUNNING` forever and `confirmDurableStop` polled **"stopping" forever** (it required *both* parent and child closed). The earlier `when_any`/fire-and-poll attempts to fix this *in the orchestrator* (replacing `call_child_workflow`) regressed SWE-bench twice and were reverted (wfb #76) — `call_child_workflow` is the proven dispatch.

The fix is **BFF-only** (zero orchestrator/agent risk): treat the wedge as **DB-state cleanup**, since the agent is already stopped. `confirmDurableStop` force-deletes the wedged parent's durable state rows directly (`purgeStateRows` — the same mechanism `mode:"reset"` uses), best-effort `purgeParent`, then reaps + finalizes (→ exec `cancelled`). The explicit stop/status confirmation path routes Stop-requested rows whose parent isn't yet terminal through `confirmDurableStop`; `call_child_workflow` is **untouched**. Verified end-to-end on **both** clusters via real runs (ryzen zombie + a dev animation Stop: *"stop confirmed (cross-app wedge force-finalized)"*, parent → 404).

**Wedge gate — positive evidence only (hardened, wfb #78).** The first cut inferred "the agent side is done" from a coarse `agentClosed` boolean, which a cancellation audit showed could false-positive two ways: a parent that has **moved on to a later non-agent node** (its earlier durable/run session is terminal but it is legitimately running), and a **still-booting sandbox** whose agent app-id merely 404s (mis-read as terminal). The gate now requires **positive evidence**: `shouldForceFinalizeCrossAppWedge` fires per still-RUNNING parent only when, after `LIFECYCLE_WEDGE_FINALIZE_GRACE_SECONDS` (default **180s**) since `stop_requested_at`, a `durable/run` child **session is DB-`terminated`** (`resolvers.terminatedChildNodes`, parsed from the `…__durable__<node>__run__N` child id). A booting child isn't DB-terminated so its node isn't listed. Pure + unit-tested in `cascade.test.ts`.

**Wedge gate — decoupled from `currentNodeId` (advanced-node fix, 2026-07-06).** The #78 cut ALSO required the parent's **live `currentNodeId`** to still *match* the dead child's node. That left a real class of wedge un-finalizable, reproduced live on dev: a `durable/run` child crash-finalized **out-of-band** by the liveness reconciler (session `failed`+completedAt, PR #441) while the SW-interpreter parent **advanced** to a later node (e.g. `plan` crashed but `currentNodeId` moved to the `approve_goal_spec` approval-gate). The terminated child's node (`plan`) no longer equaled `currentNodeId`, so the gate never fired and the Stop polled **"stopping" forever**. The gate now decides on **child evidence alone**: fire when (stop requested + grace elapsed) **AND** ≥1 `durable/run` child node is DB-terminal (`terminatedChildNodes` non-empty) **AND** *no* child is still active **anywhere** (`activeChildNodes` empty). The **"no active child anywhere"** clause is the absolute conservatism guard that replaces the node-match — a parent with **any** live cross-app child (e.g. it crashed an early branch but is legitimately running a later one) is **never** force-finalized; it's left to the cascade + cooperative cancel and the normal parent+child-closed path. `currentNodeId` is retained for the diagnostic log only. False-finalize is further bounded because this is a **DB-state cleanup of a run the user already asked to stop**, gated behind the 180s grace (long enough for any normally-terminable parent to have applied the cascade's terminate). Pure + table-unit-tested in `cascade.test.ts`.

**Two related fixes shipped with it (wfb #78):**
- **State-row purge is boundary-anchored** (`daprStateKeyMatchPattern`): the old `position(id in key)>0` **substring** match let a deterministic id over-delete a sibling's Dapr state (`…_run__1` also nuked `…_run__10/11`) — a cross-run data-loss bug on *any* purge/reset, not just the wedge. Now the id must be a whole `||`/`_workflow_`-delimited token followed by `||`, `__turn__`, or end (lowercased for `agent_py_state`). Unit-tested.
- **Stop-intent write is retried** (`markStopRequested`, 3× with backoff): the whole request/confirm + wedge contract keys off `stop_requested_at`, so a swallowed write could leave a wedged run permanently un-finalizable. A hard failure is now surfaced as a `failed` step instead of proceeding silently.

### (P6, #79) Closing the cancellation-audit LOW items
A multi-agent cancellation audit (after #77/#78) confirmed the surface is structurally sound and closed the remaining edges. All BFF-only; orchestrators unchanged.
- **Historical reaper × active coordinator (#5).** The retired reaper's *aged stuck-execution* pass skipped an execution owned by a **still-active** benchmark/eval run (`reaper.ts::ownedByActiveCoordinatorRun`), so it could not purge an instance the coordinator was about to re-drive; it released once the owning run became terminal. (The terminal/gone reconcile + stop-requested priority passes still ran regardless — that's #69.)
- **Null-linkage fan-out (#6).** `resolvers.ts::agentTargetForSession` only synthesizes the deterministic per-session app-id when there's **per-session-sandbox evidence** (`runtimeSandboxName` set); an unstarted/pool-hosted session with no linkage resolves to *unresolved* → the cascade reports "stopping" instead of terminating a nonexistent instance and falsely declaring the agent closed.
- **Single stop authority on the session route (#8).** `POST /api/v1/sessions/[id]/stop` now resolves session coordinator ownership through the lifecycle owner port → **409 `coordinator_owned`**, mirroring the per-execution route.
- **Retired the orphan `/terminate` route (#9).** `POST /api/workflows/executions/[id]/terminate` (no callers; lacked the owner guard, mapped stopping→409) was removed — use `/stop`.
- **Interrupt 503-vs-409 (#12).** A transient runtime raise failure on a live session now surfaces as a retryable **503** (`stopDurableRun` `retryable` hint), distinct from "not running yet" (**409**).
- **`reset` clarified (#7).** `reset` is intentionally user-reachable (the "Stop & reset" byte-clean mode) and safe because every route runs `isResourceInScope` before `stopDurableRun` + the state purge is boundary-anchored (#78) — NOT gated to admin (that would break the button).
- **Admin workflow-ops bypass closed (#10).** The old raw-HTTP fallback for *uncorrelated* instances was retired with the workflow-ops diagnostic surface; user-facing stops continue to route through the Lifecycle Controller.
- **Session-detail UI parity (#11).** Stop / Stop & reset are gated on a non-terminated session; a `coordinator_owned` 409 swaps them for a "Managed by benchmark/evaluation run →" redirect; Archive shows "Stop the run before archiving" on a 409.

### Verification (exercised on ryzen, 2026-06-07; #77–#79 on both clusters 2026-06-08)
- [x] Stop a run blocked in a long activity → **202** + `stop_requested_at` set; explicit status confirmation finalizes after Dapr reports terminal; no false terminal DB flip before durable closure.
- [x] Benchmark-instance workflow page → generic Stop hidden + links to the run; `POST .../stop` → 409 `coordinator_owned`; `GET …` → `owner:{benchmarkRun,…}`; a standalone run still stops normally.
- [x] `/stop/status` endpoints live (401 unauth); "Stopping…" converges.
- [x] Retired cron-driven lifecycle reaper endpoints are absent; migration columns present; boot healthy.

---

## Appendix A — File index (re-verify before editing)

**BFF**
- `src/lib/server/sessions/registry.ts` — `deleteSession:487` (bare DELETE), `archiveSession:469`, `updateSessionStatus:391`
- `src/lib/server/sessions/control.ts` — `raiseSessionEvent:12` (interrupt)
- `src/routes/api/v1/sessions/[id]/+server.ts` — GET/PUT/DELETE/PATCH; `[id]/control/interrupt/+server.ts`; `[id]/sandbox/+server.ts` (only CR-delete path)
- `src/routes/api/workflows/executions/[executionId]/terminate/+server.ts` — 2s-swallow, no purge, dead UI caller
- Retired during hexagonal cleanup: `src/lib/server/workflow-ops/**`, `src/routes/api/workflow-ops/**`, `src/routes/(admin)/admin/instances/**`, `src/routes/api/monitor/**`, the unused `src/routes/api/orchestrator/workflows` proxy, and the orphan workflow-ops reminder recovery hook in `services/workflow-orchestrator/app.py`.
- `src/lib/server/benchmarks/service.ts` — `cancelBenchmarkRun:1769`, `cleanupBenchmarkDurableWorkflowCascade:2518` (**reference**), `terminateBenchmarkRunInstance:6018`, `terminateBenchmarkAgentRuntimeInstance:3129`
- `src/lib/server/evaluations/service.ts` — `cancelEvaluationRun:1489` (weakest)
- `src/lib/server/kube/client.ts` — `deleteKubernetesSandbox:928`; warm-pool `1078-1311`
- `src/routes/api/internal/sessions/[id]/events/ingest/+server.ts:138-142` — only `sessions.status` terminal writer
- `src/lib/api-client.ts` — `workflows.terminateExecution:265` (uncalled), `orchestrator.terminate:312` (404)

**Orchestrator (Python)**
- `services/workflow-orchestrator/app.py` — `terminate_workflow:3405`, `purge_workflow:3613`, `pause/resume:3678/3702`, `_idempotent_schedule:886`, `_workflow_http_post:611` (drops query), `_cleanup_stale_instances_on_startup:1924`, parent id `3141`
- `services/workflow-orchestrator/workflows/sw_workflow.py` — child id `1291-1293`, exec counter `1238-1241`, child dispatch `1838-1851`
- `services/workflow-orchestrator/activities/call_agent_service.py:298-366` — `terminate_durable_runs_by_parent_execution` (→ `claude-code-agent` only)
- `services/workflow-orchestrator/activities/crawl4ai.py:41-52` — deterministic jobId

**Agent runtimes**
- `services/dapr-agent-py/src/main.py` — session_workflow `5005+`, cancel checks `1815-1892`, `check_cancellation_for_instance:2187`, cancel persist `882`, agent-runs endpoints `7142-7325`, raise-event `7439`, host monitor `6315`, circuit breaker `2985-3140`, **cancel-key mismatch** `5253-5257`
- `services/claude-agent-py/src/session_workflow.py:239-250` — per-turn timer; `src/main.py` — **no** agent-runs/terminate surface
- `services/sandbox-execution-api/src/app.py` — CR name `621-622`, create `1328-1398`, **409-adopt `1371-1373`**, shutdownTime gate `1010-1013`

**stacks**
- `packages/components/workloads/workflow-builder/manifests/Component-workflowstatestore.yaml` (`cleanupInterval "0"`), `Configuration-openshell-sandbox-dapr.yaml` (30m), `CronJob-agent-runtime-idle-reaper.yaml`
- `packages/components/workloads/workflow-orchestrator/manifests/Configuration-workflow-orchestrator-no-tracing.yaml` (168h), `ConfigMap-workflow-orchestrator-config.yaml` (`CLEANUP_STALE_ON_STARTUP:"false"`)
- `packages/components/workloads/dapr-workflow-watchdog/manifests/*` (raw state-row delete; excludes per-session hosts)
- `packages/base/manifests/openshell/CronJob-sandbox-gc.yaml` (4h GC, **openshell ns only**); `packages/base/manifests/agent-sandbox/Deployment-agent-sandbox-controller.yaml` (v0.4.5)
- `packages/components/workloads/sandbox-execution-api/manifests/Deployment-sandbox-execution-api.yaml` (`JOB_TTL_SECONDS "30"`, `NONTERMINAL_TIMEOUT_ACTION terminate`)

**Operator scripts (compensating for missing GC)**
- `scripts/reconcile-stale-workflow-agent-runs.ts`, `scripts/dev-purge-stale-workflows.ts`, `scripts/repair-swebench-dapr-state.ts`, `scripts/reset-swebench-environment-builds.ts`, `scripts/session-native-cutover-purge.ts`

## Appendix B — External sources

- Dapr Workflow API reference — https://docs.dapr.io/reference/api/workflow_api/
- Manage workflows (terminate/purge/pause/resume) — https://docs.dapr.io/developing-applications/building-blocks/workflow/howto-manage-workflow/
- Workflow features & concepts (terminal-only purge, ID reuse, recursive cascade) — https://docs.dapr.io/developing-applications/building-blocks/workflow/workflow-features-concepts/
- Python SDK workflow ext — https://docs.dapr.io/developing-applications/sdks/python/python-sdk-extensions/python-workflow-ext/python-workflow/
- Python SDK example (`purge` + `wait_for_workflow_completion`) — https://github.com/dapr/python-sdk/blob/main/examples/workflow/simple.py
- Recursive cascade terminate/purge — https://github.com/dapr/dapr/issues/6393
- Dapr v1.17 release (purge-force + reminder cleanup on purge) — https://blog.dapr.io/posts/2026/02/27/dapr-v1.17-is-now-available/
- Dapr-Agents core concepts (DurableAgent backed by workflows) — https://docs.dapr.io/developing-ai/dapr-agents/dapr-agents-core-concepts/
