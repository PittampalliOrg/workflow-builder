# Workflow & Agent Lifecycle: Stop / Terminate / Purge

> **Status:** ✅ IMPLEMENTED — **2026-06-07**. Shipped across **PR1–PR4** (wfb #62 / #63 / #64, stacks #2523, wfb #65). This is the **lifecycle SSOT**.
> **Scope:** A single vetted method for stopping/terminating/purging Dapr Workflows and durable agent runs, the root-cause fixes for stale/corrupt state across reruns, and the full cutover that routes every user-facing "stop" through it.

This doc began as the output of a deep audit (external Dapr best-practices research + a 9-slice code audit of `workflow-builder:main` and `stacks:main`); the design has since been **implemented in full**. Parts 1–3 retain the audit framing (the *why* + the original current-state map / root-causes — historical baseline). Parts 4–6 are now **as-built**. Every original behavioral claim was cited to `file:line` (as of the audit, 2026-06-07 — re-verify before editing) or to a Dapr primary source (Appendix B); file:line references in Parts 1–3 describe the **pre-fix** state and are kept for traceability.

---

## TL;DR

**Before this work** there were **≥8 user-facing "stop" affordances across 6 backend contracts**, and the operation users most need — *"actually stop this run and leave nothing behind that breaks the next run"* — was implemented **correctly in exactly one place** (benchmark **instance** terminate) and **wrong or absent everywhere else**. **Now** all of them route through one Lifecycle Controller.

The "stale/corrupt data from prior runs" pain had a concrete root cause: **deterministic IDs were reused without purging the prior occupant**, and in the worst case the per-session **Sandbox CR create silently swallowed HTTP 409 and *adopted* the stale pod** (`services/sandbox-execution-api/src/app.py:1371-1373`). Both are fixed (guarded purge-before-reuse + owner-run-id no-adopt).

Dapr already gives us the right primitives (terminate / purge / pause / resume / raiseEvent; recursive-by-default; **v1.17 purge-force + reminder-cleanup-on-purge** — we run control plane **1.17.9**), and we already had a **reference-quality cascade** in `cleanupBenchmarkDurableWorkflowCascade` (`src/lib/server/benchmarks/service.ts:2518`). **This was done:** that cascade was generalized into one **Lifecycle Controller** (`src/lib/server/lifecycle/{cascade,resolvers,index,reaper}.ts`), every user surface now routes through it, the root-cause bugs are fixed, and the two missing safety nets shipped (the `workflow-builder`-namespace `workflow-builder-sandbox-gc` CronJob + the `lifecycle-terminal-reaper` CronJob). See **Part 4 (as-built)** and **Part 5 (what shipped)**.

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
| 11 | Admin Workflow Ops (`/admin/instances/[id]`) | `runWorkflowOperation` | ✓ | ✓ (force/recursive) | ~legacy | ✗ | ✗ | Only terminate+purge UI — **but the API routes are UNAUTHENTICATED** |

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
8. **`/api/workflow-ops/*` operation routes have no auth gate** — only the `(admin)` *page* group is guarded, not the JSON API (`src/routes/api/workflow-ops/instances/[instanceId]/[operation]/+server.ts`, `.../agent-runs/[agentRunId]/[operation]/+server.ts`; only `reminders/delete` checks `requirePlatformAdmin`). Any authenticated caller can terminate/purge/rerun any instance by ID. The dead `DELETE /api/orchestrator/workflows/[id]` purge route is likewise unauthenticated; `api-client.ts` `orchestrator.terminate`/`raiseEvent` point at routes that don't exist (404).
9. **`recursive`/`force` purge flags are dropped at the orchestrator.** The BFF forwards them, but `_workflow_http_post(instance_id, "/purge")` (`app.py:611,3647`) never appends query params — `recursive` is a logged no-op; `force` only triggers the legacy single-app-id child cleanup. (Dapr's default purge is recursive anyway, so this is cosmetic — but it diverges from what the UI checkbox implies.)

**Runtime asymmetry:** `dapr-agent-py` has terminate/pause/resume/purge endpoints + cooperative cancel + host-monitor (default action `"warn"`, `main.py:6343`); `claude-agent-py` has **none** of these and is un-stoppable mid-turn (its only cutoff is a 15-min per-turn `when_any` timer that then retries 3×, `services/claude-agent-py/src/session_workflow.py:239-250`). Terminate does not interrupt an in-flight activity, so claude's whole-turn-in-one-activity model can only be truly stopped by deleting the Sandbox CR.

---

## Part 4 — The vetted method: one **Lifecycle Controller** (AS-BUILT)

A single target-agnostic server-side module that every surface calls. One contract, fail-closed, idempotent, retryable. Generalizes `cleanupBenchmarkDurableWorkflowCascade` (which is now shared with it). **Shipped** in `src/lib/server/lifecycle/{cascade,resolvers,index,reaper}.ts`.

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
- ✅ **Auth-gated** `/api/workflow-ops/*` (now requires platform admin); deleted the dead unauthenticated `DELETE /api/orchestrator/workflows/[id]` purge route + the dead api-client methods (`workflows.terminateExecution`, `orchestrator.terminate/raiseEvent`).
- ✅ **Forward `recursive`/`force`** — `_workflow_http_post` now forwards query params; `purge_workflow` is recursive-by-default + forwards `force` (purge-force, Dapr 1.17.9).

### GitOps safety nets (stacks, PR4) — ✅ SHIPPED

- ✅ **Unified Dapr `stateRetentionPolicy = 168h`** across the parent (`workflow-orchestrator-no-tracing`) AND the per-session child Configs (`workflow-builder-agent-runtime`, `openshell-sandbox-dapr`) — closing the cascade-termination race (children were auto-purged before the parent finished; the old split was 168h vs 30m).
- ✅ **`workflow-builder-sandbox-gc` CronJob** — age-based GC of orphaned per-session agent-host Sandbox CRs in the `workflow-builder` namespace (excludes SandboxWarmPool-owned).
- ✅ **`lifecycle-terminal-reaper` CronJob** → `POST /api/internal/lifecycle/reap-terminal` — reconciles DB rows stuck non-terminal vs terminal/gone Dapr instances, purges orphans, and **SKIPS while a benchmark run/lease is active**.
- ✅ **`runbooks/phase0-lifecycle-clean-slate.{sh,md}`** — guarded, dry-run-by-default one-time purge (NOT auto-run).

---

## Part 5 — What shipped (full cutover, PR1–PR4)

The cutover landed across four PRs (wfb #62/#63/#64, stacks #2523, wfb #65). The original phasing maps to the PRs as follows:

- **Phase 0 — Clean slate.** Delivered as the **guarded** `runbooks/phase0-lifecycle-clean-slate.{sh,md}` (dry-run-by-default, NOT auto-run) rather than a single destructive sweep — `reset`/purge across `workflow-orchestrator` + per-session app-ids, Sandbox CRs, and stuck DB rows, run on demand.
- **Phase 1 — Lifecycle Controller (BFF).** ✅ `src/lib/server/lifecycle/{cascade,resolvers,index,reaper}.ts`: target-agnostic, fail-closed (409 if not confirmed terminal), idempotent/retryable; lifted from and now **shared with** the benchmark cascade (`cleanupBenchmarkDurableWorkflowCascade`). Explicit per-session app-id fan-out.
- **Phase 2 — Every surface re-pointed.** ✅ `POST /api/v1/sessions/[id]/stop`, `POST /api/workflows/executions/[id]/stop`, session interrupt, workflow-execution terminate, and eval cancel all route through the controller. UI **Stop** / **Stop & Reset** buttons on the session-detail + workflow-run pages. The sessions-list "Archive" row action was relabeled **"Delete"** (it always hard-DELETEd). Delete/Archive are **BLOCKED** (409 "Stop the run first") while a run is active. Divergent/dead routes removed; `/api/workflow-ops/*` now requires platform admin. UI vocabulary: **Interrupt / Stop / Stop & Reset**.
- **Phase 3 — Runtime + orchestrator fixes.** ✅ dapr-agent-py cancel-key write/read agreement; claude-agent-py management parity (terminate/pause/resume/purge + cooperative cancel + `TERMINAL_CONTROL_EVENT_TYPES`); guarded purge-before-reuse; sandbox-execution-api owner-run-id no-adopt; `_workflow_http_post` forwards query params + recursive/force purge. (`dapr-agent-py` needs **both** image builds — see the dual-image note in `CLAUDE.md`.)
- **Phase 4 — GitOps safety nets (stacks #2523).** ✅ unified `stateRetentionPolicy = 168h` (parent + per-session children); `workflow-builder-sandbox-gc` CronJob; `lifecycle-terminal-reaper` CronJob → `POST /api/internal/lifecycle/reap-terminal` (skips while a benchmark run/lease is active). Via the cluster-update/GitOps flow.
- **Phase 5 — Verified end-to-end:** Start → Stop mid-turn (both runtimes) → durable terminal + CR gone + DB terminal + re-run same node starts byte-clean; pod kill mid-run → reaper flips DB + purges within one interval (see Part 6).

---

## Part 6 — Verification checklist (use to re-validate)

These were exercised during the PR1–PR4 cutover; keep them as the regression checklist.

- [x] Stop a running **direct UI session** mid-turn → durable instance `TERMINATED`, Sandbox CR deleted, `sessions.status='terminated'`, pod gone.
- [x] Stop a running **workflow-driven session** (durable/run) mid-turn → parent + child app-id both terminated+purged; cooperative cancel actually fires (key fix).
- [x] Stop on **claude-agent-py** = parity with dapr-agent-py (management surface exists).
- [x] **Re-run the same workflow node** after a stop → fresh Sandbox CR (no 409-adopt; owner-run-id no-adopt), fresh durable instance (guarded purge-before-reuse), fresh crawl job.
- [x] **Kill a sandbox pod** mid-run → `lifecycle-terminal-reaper` flips DB + purges orphan within one interval; no stuck `running` rows.
- [x] **Orphaned reminders**: after purge, no `new-event-*` reminders remain (1.17 cleanup).
- [x] **Auth**: `/api/workflow-ops/*` rejects non-admin; cross-workspace stop 404s.
- [x] **No `workflow-builder` Sandbox/Workload accumulation** after a soak of start/stop cycles (`workflow-builder-sandbox-gc` CronJob).

---

## Appendix A — File index (re-verify before editing)

**BFF**
- `src/lib/server/sessions/registry.ts` — `deleteSession:487` (bare DELETE), `archiveSession:469`, `updateSessionStatus:391`
- `src/lib/server/sessions/control.ts` — `raiseSessionEvent:12` (interrupt)
- `src/routes/api/v1/sessions/[id]/+server.ts` — GET/PUT/DELETE/PATCH; `[id]/control/interrupt/+server.ts`; `[id]/sandbox/+server.ts` (only CR-delete path)
- `src/routes/api/workflows/executions/[executionId]/terminate/+server.ts` — 2s-swallow, no purge, dead UI caller
- `src/lib/server/workflow-ops/index.ts` — `runWorkflowOperation:1484`, `runAgentRunOperation:1385`, `deleteWorkflowActorReminders:420`, `candidateAgentRuntimes:449`
- `src/routes/api/workflow-ops/instances/[instanceId]/[operation]/+server.ts`, `.../agent-runs/[agentRunId]/[operation]/+server.ts` — **no auth**; `.../reminders/delete/+server.ts` — only admin-gated one
- `src/routes/api/orchestrator/workflows/[id]/+server.ts` — dead unauthenticated DELETE purge
- `src/lib/server/benchmarks/service.ts` — `cancelBenchmarkRun:1769`, `cleanupBenchmarkDurableWorkflowCascade:2518` (**reference**), `terminateBenchmarkRunInstance:6018`, `terminateBenchmarkAgentRuntimeInstance:3129`
- `src/lib/server/evaluations/service.ts` — `cancelEvaluationRun:1489` (weakest)
- `src/lib/server/kube/client.ts` — `deleteKubernetesSandbox:928`; warm-pool `1078-1311`
- `src/routes/api/internal/sessions/[id]/events/ingest/+server.ts:138-142` — only `sessions.status` terminal writer
- `src/lib/api-client.ts` — `workflows.terminateExecution:265` (uncalled), `orchestrator.terminate:312` (404)

**Orchestrator (Python)**
- `services/workflow-orchestrator/app.py` — `terminate_workflow:3405`, `purge_workflow:3613`, `pause/resume:3678/3702`, `delete_workflow_actor_reminders:3526`, `_idempotent_schedule:886`, `_workflow_http_post:611` (drops query), `_cleanup_stale_instances_on_startup:1924`, parent id `3141`
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
