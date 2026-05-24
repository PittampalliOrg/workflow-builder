# SWE-bench Dapr Workflow Operations

This note captures the Dapr workflow behavior that matters for SWE-bench
benchmark scale tests and cleanup.

## Dapr Workflow Model

- Dapr Workflows are backed by Dapr actors. Each workflow instance has a
  workflow actor, and activities or child workflows are driven through related
  actor work.
- Workflow state is stored in the configured actor state store. History records
  are append-only until the instance is purged.
- Dapr Scheduler stores workflow and actor reminder jobs separately from the
  workflow state store. These reminders are what make workflow execution
  durable across sidecar or node failures.
- Workflow work is distributed across replicas for a given app id. A start
  request does not pin later workflow execution to the same pod that accepted
  the request.

Useful upstream docs:

- https://docs.dapr.io/developing-applications/building-blocks/workflow/workflow-architecture/
- https://docs.dapr.io/developing-applications/building-blocks/workflow/howto-manage-workflow/
- https://docs.dapr.io/concepts/dapr-services/scheduler/

## Cleanup Rules

- Treat workflow cleanup as a lifecycle, not a database update.
- Terminate running workflows first, poll until they are terminal or missing,
  then purge workflow metadata.
- Purge is only valid for terminal workflow instances. If an instance is still
  running, termination must happen before purge.
- For SWE-bench agent sessions, terminate child session and turn workflows
  before deleting sandboxes, marking DB rows terminal, or releasing leases.
- If cleanup cannot prove durable shutdown, leave leases and sandboxes in place
  so retry cleanup can find the still-running workflow.
- If old workflow state is intentionally disposable, quiesce workflow-producing
  apps before clearing state stores or scheduler data. Deleting only Postgres
  workflow rows can leave scheduler reminders behind.

## Reset Guidance

For dev-only benchmark recovery where prior workflow state does not need to be
preserved:

1. Cancel active benchmark runs through the benchmark API.
2. Wait for cleanup to release benchmark leases and remove run sandboxes.
3. Scale down workflow-producing apps before destructive state reset.
4. Clear the workflow actor state store used by `workflowstatestore`.
5. Reset Scheduler state only when old reminder jobs are disposable.
6. Bring Dapr scheduler, placement, workflow-orchestrator, coordinator, and
   workflow-builder back to ready state before launching another run.

Do not use this as a production retention policy. Production should use normal
workflow terminate and purge APIs, plus scheduled retention, backups, and
capacity monitoring for the actor state store and Scheduler embedded etcd.

## Benchmark Best Practices

- Do not roll workflow-orchestrator, swebench-coordinator, or agent-runtime
  images while a run is active. Durable replay depends on the worker code shape
  matching persisted workflow history.
- Gate benchmark launches while workflow-builder is rolling, Argo hooks are
  running, or the managing Argo Application is not stable.
- Keep session-host pods bounded. For benchmark hosts, a nonterminal workflow
  that stays active past the idle timeout should be terminated and the pod
  should exit nonzero so Kueue/runtime slots are not held indefinitely.
- Keep interactive sessions on warning behavior unless a user-facing timeout is
  explicitly desired.
- Treat model max-iteration, no-patch, and empty-patch outcomes as model
  quality outcomes, not benchmark infrastructure failures. Treat stuck Dapr
  workflows, unreleased leases, first-tool failures, and deleted sandboxes with
  running workflows as infrastructure failures.
