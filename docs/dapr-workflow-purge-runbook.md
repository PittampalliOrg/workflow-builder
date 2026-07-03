# Dapr Workflow Purge Runbook

This runbook applies to workflow-builder, workflow-orchestrator, agent-runtime, and SWE-bench cleanup paths.

> **Prefer the vetted automated path.** As of the lifecycle cutover (PR1–PR4; see `docs/workflow-lifecycle-termination.md`, the lifecycle SSOT), the **Lifecycle Controller** (`src/lib/server/lifecycle/`) is the single vetted method for stopping/terminating/purging workflows + durable agent runs. User-facing stops route through `POST /api/v1/sessions/[id]/stop` and `POST /api/workflows/executions/[id]/stop` (`mode ∈ interrupt | terminate | purge | reset`); it is request/confirm (returns **202 "stopping"** + persists `stop_requested_at`, then flips DB / reaps only once Dapr is confirmed terminal — not a one-shot 409), does explicit per-session app-id fan-out, force-finalizes a cross-app `durable/run` parent wedged awaiting a child Dapr's recursive terminate can't reach, and uses **purge-force** (Dapr 1.17.9) when the worker pod is already gone. Orphaned per-session Sandbox CRs are age-GC'd by the `workflow-builder-sandbox-gc` CronJob. The guarded one-time clean-slate is `runbooks/phase0-lifecycle-clean-slate.{sh,md}` (dry-run-by-default). The break-glass procedure below remains for an operator when those automated paths cannot prove closure.

## Normal Rule

Dapr workflow purge is only a metadata cleanup step. Do not use it to stop active work. The Lifecycle Controller sequences terminate→confirm-terminal→purge for you; reach for the manual steps below only as operator break-glass.

Normal terminal cleanup order:

1. Request workflow termination.
2. Poll status until the workflow is terminal or missing.
3. Purge workflow metadata.
4. Finalize application DB rows, sandbox resources, and leases.

Dapr only supports normal purge for terminal workflow states: `COMPLETED`, `FAILED`, or `TERMINATED`. If status still reports `RUNNING`, `PENDING`, or `SUSPENDED`, keep retrying termination/status polling before purge.

For SWE-bench run cleanup, this ordering also applies to cancelled runs.
Cancellation makes the benchmark row terminal, but it does not prove that
parent, session, or turn workflows have stopped. If closure is not confirmed,
leave leases and sandboxes in place so retry cleanup can still discover and
terminate the durable workflow tree.

## What Not To Do

Do not manually delete workflow state as routine cleanup.

Do not purge child workflow history before the parent workflow has stopped. Parent replay can still need child completion or termination events.

Do not use force-style purge semantics while any related workflow, activity, sandbox, benchmark run, or resource lease is active.

Do not delete only the workflow state-store rows and assume the workflow is
gone. Dapr Scheduler stores workflow and actor reminder jobs separately from
the workflow actor state store. If scheduler reminders survive a direct state
delete, they can keep waking missing workflow actors and produce repeated
`no such instance exists` or `cannot add event to workflow as state has been
purged` errors.

## Break-Glass Recovery

First try the normal lifecycle path: explicit user-facing stop/cancel routes drive the Lifecycle Controller, and `workflow-builder-sandbox-gc` age-GCs orphaned per-session Sandbox CRs. With unified `stateRetentionPolicy = 168h` across parent + per-session child Configs, children are no longer auto-purged before the parent finishes (the old 168h-vs-30m split-brain that caused cascade-termination races is gone).

Use the manual steps below only for a failed or cancelled run that is already operationally dead but Dapr keeps reporting stale non-terminal workflow state and explicit stop/status confirmation cannot resolve it.

Before deleting state directly, verify all of the following:

1. No active benchmark runs: no rows in `benchmark_runs` with `queued`, `inferencing`, or `evaluating`.
2. No active benchmark leases: no rows in `benchmark_resource_leases` with `status='active'`.
3. No related OpenShell Sandbox CRs or pods remain.
4. The exact parent and child workflow instance IDs are known.
5. The deletion predicate is scoped to those exact instance IDs only.

After scoped state deletion:

1. If scheduler reminders keep replaying missing workflow instances, reset the
   Dapr Scheduler state only when all old workflow state is disposable.
2. Restart only the owning workflow app or sidecar, such as `workflow-orchestrator`, to clear cached actor status.
3. Use the normal application cleanup endpoint again.
4. Confirm benchmark instances are terminal, sandbox cleanup is recorded, and leases remain released.

## References

- Dapr Workflow API: purge only terminal workflows: https://docs.dapr.io/reference/api/workflow_api/
- Dapr Manage Workflows: purge requires a running workflow client to preserve state-machine integrity: https://docs.dapr.io/developing-applications/building-blocks/workflow/howto-manage-workflow/
- Dapr CLI: non-terminal force purge is dangerous and should only be used when no workflow instances are running: https://docs.dapr.io/reference/cli/dapr-workflow/
