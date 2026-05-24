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
- https://docs.dapr.io/developing-applications/building-blocks/workflow/workflow-features-concepts/
- https://docs.dapr.io/developing-applications/building-blocks/workflow/workflow-versioning/
- https://docs.dapr.io/developing-applications/building-blocks/workflow/howto-manage-workflow/
- https://docs.dapr.io/concepts/dapr-services/scheduler/

The important upstream constraints for benchmark operations are:

- Workflow code must replay deterministically. Do not change the order or shape
  of workflow, activity, or child-workflow calls for an in-flight app id unless
  the change uses Dapr workflow patching/versioning.
- Keep orchestration bodies free of direct I/O, random values, current wall
  time, and mutable process-global decisions. Put side effects behind
  activities so replay observes the same action history.
- All replicas for a workflow app id must register the same workflows and
  activities. Rollouts that briefly mix registrations can stall or fail replay.
- Workflow state remains in the actor state store after terminal completion
  until purged or removed by retention. Completed histories are not free.
- By default, Dapr imposes no global workflow/activity concurrency ceiling.
  Concurrency must come from Dapr configuration and benchmark admission logic,
  not from assuming the runtime will self-throttle.
- Termination stops the workflow state machine and child workflows, but it does
  not cancel already-running activity code. Cleanup must still poll and handle
  in-flight side effects.

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
- For dev-only benchmark runs where no workflow history must be retained,
  prefer normal terminate-then-purge after terminal status. Use direct state
  deletion only after all related benchmark runs, leases, sessions, sandboxes,
  and workflow-producing pods are quiesced.

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
- Gate benchmark launches when recent agent-host daprd logs show actor lock,
  scheduler/reminder, or workflow retry pressure, or when any active agent-host
  app container has OOMKilled. Parent workflow-orchestrator pressure alone is
  not enough for Kueue-backed session-host runs.
- Keep session-host pods bounded. For benchmark hosts, a nonterminal workflow
  that stays active past the idle timeout should be terminated and the pod
  should exit nonzero so Kueue/runtime slots are not held indefinitely.
- For SWE-bench one-shot agent hosts, prefer the inline session turn path over
  a nested child `agent_workflow`. The inline path keeps seed activities and
  the agent turn in one deterministic `session_workflow` history and avoids
  high-concurrency sub-orchestration replay churn. Set
  `DAPR_AGENT_SWEBENCH_SESSION_ONE_SHOT_CHILD_WORKFLOW_ENABLED=true` only for a
  focused canary that proves the nested path is needed.
- Keep interactive sessions on warning behavior unless a user-facing timeout is
  explicitly desired.
- Treat model max-iteration, no-patch, and empty-patch outcomes as model
  quality outcomes, not benchmark infrastructure failures. Treat stuck Dapr
  workflows, unreleased leases, first-tool failures, and deleted sandboxes with
  running workflows as infrastructure failures.
