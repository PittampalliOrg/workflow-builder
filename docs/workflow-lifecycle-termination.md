# Workflow & Agent Lifecycle: Stop / Terminate / Purge

> **Status:** Design proposal (not yet implemented) — **2026-06-07**
> **Scope:** A single vetted method for stopping/terminating/purging Dapr Workflows and durable agent runs, the root-cause fixes for stale/corrupt state across reruns, and a full-cutover plan to route every user-facing "stop" through it.
> **Decision pending:** approve this doc, then implement (Phases 0–5 below).

This doc is the output of a deep audit (external Dapr best-practices research + a 9-slice code audit of `workflow-builder:main` and `stacks:main`). Every behavioral claim is cited to `file:line` (current as of 2026-06-07 — re-verify before editing) or to a Dapr primary source (Appendix B).

---

## TL;DR

There are **≥8 user-facing "stop" affordances across 6 backend contracts**, and the operation users most need — *"actually stop this run and leave nothing behind that breaks the next run"* — is implemented **correctly in exactly one place** (benchmark **instance** terminate) and **wrong or absent everywhere else**.

The "stale/corrupt data from prior runs" pain has a concrete root cause: **deterministic IDs are reused without purging the prior occupant**, and in the worst case the per-session **Sandbox CR create silently swallows HTTP 409 and *adopts* the stale pod** (`services/sandbox-execution-api/src/app.py:1371-1373`).

Dapr already gives us the right primitives (terminate / purge / pause / resume / raiseEvent; recursive-by-default; **v1.17 purge-force + reminder-cleanup-on-purge** — we run control plane **1.17.9**), and we already have a **reference-quality cascade** in `cleanupBenchmarkDurableWorkflowCascade` (`src/lib/server/benchmarks/service.ts:2518`). The plan: **generalize that into one Lifecycle Controller, route every surface through it, fix the four root-cause bugs, and add the two missing safety nets** (a `workflow-builder`-namespace Sandbox GC + a terminal-status reaper).

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

## Part 2 — Current-state map (the fragmentation)

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

## Part 4 — The vetted method: one **Lifecycle Controller**

A single target-agnostic server-side module that every surface calls. One contract, fail-closed, idempotent, retryable. Generalizes `cleanupBenchmarkDurableWorkflowCascade`.

### API — `src/lib/server/lifecycle/`

```ts
stopDurableRun(
  target: { kind: 'workflowExecution'|'session'|'benchmarkRun'|'benchmarkInstance'|'evalRun'; id: string },
  opts: { mode: 'interrupt'|'terminate'|'purge'|'reset'; reason?: string; graceMs?: number }
): Promise<{ confirmed: boolean; steps: StepResult[]; retryToken?: string }>
```

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

### Root-cause fixes bundled with the controller (the "no stale state" half)

- **Stop adopting stale Sandbox CRs** — on 409, `reset` deletes-and-recreates (or verifies the CR belongs to the current run) instead of swallow-adopt (`sandbox-execution-api/src/app.py:1371`).
- **Purge-before-reuse** — `_idempotent_schedule` terminates+purges a stuck non-terminal instance before reusing the ID (`app.py:886-978`), or the spawn path resets it.
- **Fix the cooperative-cancel key mismatch** for durable/run (`dapr-agent-py/src/main.py` write/read keys must agree).
- **Give `claude-agent-py` the same management surface** (terminate/pause/resume/purge + cooperative cancel) so the controller's fan-out is runtime-symmetric. Replace dead `terminate_durable_runs_by_parent_execution` with the explicit per-session app-id fan-out (or delete it).
- **Auth-gate** `/api/workflow-ops/*`; delete the dead unauthenticated `/api/orchestrator/workflows/[id]` purge route + the 404 api-client methods.
- **Forward `recursive`/`force`** in `_workflow_http_post` (or drop the params from the API to stop lying).

### GitOps safety nets (stacks)

- **Unify Dapr `stateRetentionPolicy`** parent==child (kill the 168h/30m split-brain), and/or rely on explicit purge.
- **Add a `workflow-builder`-namespace Sandbox-GC CronJob** (mirror `packages/base/manifests/openshell/CronJob-sandbox-gc.yaml`); extend `stuck-workflow-watchdog` to cover per-session hosts.
- **Add a terminal-status reaper** (productionize `reconcile-stale-workflow-agent-runs` + a safe `CLEANUP_STALE_ON_STARTUP`) on a timer.

---

## Part 5 — Full-cutover plan (disruption OK, purge data freely)

- **Phase 0 — Clean slate** (one-time, destructive, dev/ryzen): run `reset` over all non-terminal instances; purge across `workflow-orchestrator` + per-session app-ids; `kubectl -n workflow-builder delete sandboxes.agents.x-k8s.io --all`; truncate stuck `crawl4ai_jobs`/`crawl4ai_cache`, stale `sessions`/`workflow_executions`/`workflow_agent_runs`/`workflow_workspace_sessions`. Start from zero.
- **Phase 1 — Lifecycle Controller (BFF):** build `src/lib/server/lifecycle/`, lift the benchmark cascade in, make it target-agnostic + fail-closed + retryable. Unit-test the per-session app-id fan-out.
- **Phase 2 — Re-point every surface** (the "all user functionality uses the vetted method" requirement): sessions (interrupt=cooperative; **new real Terminate** = `purge` + CR reap), workflow run detail (**add the missing Stop/Terminate button**), workflow execution terminate route (delete the 2s-swallow body → controller), benchmark cancel/instance + eval cancel → controller, crawl (**add a stop**), admin ops → controller + **add auth**. Delete divergent paths + dead routes. One UI vocabulary: **Interrupt / Stop / Stop & Reset**.
- **Phase 3 — Runtime + orchestrator fixes:** cancel-key fix; `claude-agent-py` management surface; purge-before-reuse; Sandbox-CR no-adopt; forward recursive/force. (`dapr-agent-py` needs **both** image builds — see `docs/` + the dual-image note.)
- **Phase 4 — GitOps safety nets (stacks):** unify retention; `workflow-builder` Sandbox-GC CronJob; terminal-status reaper; watchdog covers per-session hosts. Via the cluster-update/GitOps flow, not kubectl patches.
- **Phase 5 — Verify end-to-end:** Start → Stop mid-turn (both runtimes) → confirm durable terminal + CR gone + DB terminal + **re-run same node starts byte-clean**. Kill a pod mid-run → reaper flips DB + purges within one interval.

---

## Part 6 — Verification checklist

- [ ] Stop a running **direct UI session** mid-turn → durable instance `TERMINATED`, Sandbox CR deleted, `sessions.status='terminated'`, pod gone.
- [ ] Stop a running **workflow-driven session** (durable/run) mid-turn → parent + child app-id both terminated+purged; cooperative cancel actually fires (key fix).
- [ ] Stop on **claude-agent-py** = parity with dapr-agent-py (management surface exists).
- [ ] **Re-run the same workflow node** after a stop → fresh Sandbox CR (no 409-adopt), fresh durable instance (no zombie block), fresh crawl job.
- [ ] **Kill a sandbox pod** mid-run → terminal-status reaper flips DB + purges orphan within one interval; no stuck `running` rows.
- [ ] **Orphaned reminders**: after purge, no `new-event-*` reminders remain (1.17 cleanup).
- [ ] **Auth**: `/api/workflow-ops/*` rejects non-admin; cross-workspace stop 404s.
- [ ] **No `workflow-builder` Sandbox/Workload accumulation** after a soak of start/stop cycles.

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
