# SWE-bench Dapr Workflow Operations

This note captures the Dapr workflow behavior that matters for SWE-bench
benchmark scale tests and cleanup.

> **Cleanup is now unified with the platform Lifecycle Controller.** The benchmark
> cancellation cascade (`cleanupBenchmarkDurableWorkflowCascade`) was the reference
> implementation that the vetted server-side **Lifecycle Controller**
> (`src/lib/server/lifecycle/`) generalized and now **shares** — see
> `docs/workflow-lifecycle-termination.md` (the lifecycle SSOT; IMPLEMENTED PR1–PR4).
> Routine reconciliation of orphaned/stuck state is automated by the
> `lifecycle-terminal-reaper` CronJob (`POST /api/internal/lifecycle/reap-terminal`),
> which **reconciles the terminal/gone divergence even during benchmark activity** (post-#69; the
> per-row terminal/gone guard is the safety) — only its *aged stuck-execution* pass defers to an
> execution owned by a **still-active** coordinator run (post-#79) so it never purges an instance the
> coordinator is about to re-drive;
> orphaned per-session Sandbox CRs in `workflow-builder` are age-GC'd by the
> `workflow-builder-sandbox-gc` CronJob. `stateRetentionPolicy` is now unified at
> `168h` across the parent (`workflow-orchestrator-no-tracing`) and the per-session
> child Configs, closing the cascade-termination race. The Dapr workflow model +
> cleanup-lifecycle guidance below still applies; reach for direct state deletion
> only as operator break-glass (see also `docs/dapr-workflow-purge-runbook.md`).

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
- https://docs.dapr.io/developing-applications/building-blocks/workflow/workflow-multi-app/
- https://docs.dapr.io/operations/resiliency/health-checks/sidecar-health/
- https://docs.dapr.io/developing-ai/dapr-agents/dapr-agents-core-concepts/
- https://docs.dapr.io/concepts/dapr-services/scheduler/

The important upstream constraints for benchmark operations are:

- Dapr Workflow is event-sourced and replay-based. On every work item, the SDK
  re-executes the orchestration function from the beginning and matches each
  scheduled task against the persisted history. Any code path that changes the
  activity or child-workflow sequence can fail replay with a non-determinism
  error such as `previous execution called call_activity...`.
- Workflow code must replay deterministically. Do not change the order or shape
  of workflow, activity, or child-workflow calls for an in-flight app id unless
  the change uses Dapr workflow patching/versioning.
- Keep orchestration bodies free of direct I/O, random values, current wall
  time, and mutable process-global decisions. Put side effects behind
  activities so replay observes the same action history.
- All replicas for a workflow app id must register the same workflows and
  activities. Rollouts that briefly mix registrations can stall or fail replay.
- Multi-application activities and child workflows are scoped to one
  Kubernetes namespace and one workflow/actor state store. Dapr routes by app
  id; if the target app is missing or not ready, workflow retry policy handles
  the call, but the parent can wait indefinitely until that target is actually
  available.
- Dapr sidecar `/healthz` is an infrastructure probe, not an application-level
  readiness proof for actor/workflow apps. For agent hosts, application
  readiness must include the sidecar metadata signal that at least one workflow
  worker is connected.
- Workflow state remains in the actor state store after terminal completion
  until purged or removed by retention. Completed histories are not free.
- By default, Dapr imposes no global workflow/activity concurrency ceiling.
  Concurrency must come from Dapr configuration and benchmark admission logic,
  not from assuming the runtime will self-throttle.
- Termination stops the workflow state machine and child workflows, but it does
  not cancel already-running activity code. Cleanup must still poll and handle
  in-flight side effects.
- For Dapr-enabled Kubernetes pods, `dapr.io/graceful-shutdown-seconds` must be
  lower than `terminationGracePeriodSeconds`. If the pod grace period is shorter,
  Kubernetes can SIGKILL the app and sidecar before Dapr drains in-flight calls,
  flushes telemetry, or closes state-store connections.

## Cleanup Rules

- Treat workflow cleanup as a lifecycle, not a database update.
- Terminate running workflows first, poll until they are terminal or missing,
  then purge workflow metadata.
- The best long-term cancellation path is a hybrid one: raise a workflow-level
  cancellation event first, let the workflow run deterministic cleanup
  activities, then escalate to hard terminate if the workflow does not reach a
  terminal state inside the bounded cleanup window. This is now the shape of the
  Lifecycle Controller's cascade: graceful raise (`session.terminate` /
  `user.interrupt`) → terminate parent + every per-session child app-id (explicit
  fan-out) → poll to terminal → purge (recursive; purge-force when the worker is
  gone). Both runtimes now honor a shared cancel contract — dapr-agent-py's
  cancel-key write/read agree for `durable/run`, and claude-agent-py has
  management parity (terminate/pause/resume/purge + a between-turn cooperative
  cancel + `TERMINAL_CONTROL_EVENT_TYPES`).
- Purge is only valid for terminal workflow instances. If an instance is still
  running, termination must happen before purge.
- For SWE-bench agent sessions, terminate child session and turn workflows
  before deleting sandboxes, marking DB rows terminal, or releasing leases.
- If cleanup cannot prove durable shutdown, leave leases and sandboxes in place
  so retry cleanup can find the still-running workflow. The exception is a
  benchmark instance that has already crossed the no-session-progress timeout:
  after best-effort durable termination, advance benchmark bookkeeping and
  clean up host pods, sandboxes, and leases so one stuck workflow cannot hold
  the whole run open.
- Cancelled run cleanup follows the same rule. A cancelled benchmark row is not
  enough evidence to delete sandboxes, release leases, or directly purge
  workflow state. Run-level cleanup must first close the parent workflow plus
  agent session and turn workflows; if closure is not confirmed, retry later.
- Completed benchmark cleanup is backgrounded so evaluator callbacks do not
  block on every sandbox deletion. The background path retries durable closure
  briefly and schedules the run cleanup endpoint for recently terminal runs that
  still have active session or workflow projections. Platform-wide reconciliation
  of DB rows stuck non-terminal vs terminal/gone Dapr instances is now the
  `lifecycle-terminal-reaper` CronJob (post-#69 it reconciles even during
  benchmark activity — the per-row terminal/gone guard is the safety; post-#79
  only its aged-stuck pass defers to an execution owned by a still-active
  coordinator run, so it never purges an instance the coordinator will re-drive),
  and orphaned per-session
  Sandbox CRs in `workflow-builder` are age-GC'd by `workflow-builder-sandbox-gc`.
  If sandboxes remain after a completed run, use the cleanup endpoint (or let the
  reaper/GC sweep) instead of direct DB updates.
- If old workflow state is intentionally disposable, quiesce workflow-producing
  apps before clearing state stores or scheduler data. Deleting only Postgres
  workflow rows can leave scheduler reminders behind.
- For dev-only benchmark runs where no workflow history must be retained,
  prefer normal terminate-then-purge after terminal status. Use direct state
  deletion only after all related benchmark runs, leases, sessions, sandboxes,
  and workflow-producing pods are quiesced.
- Keep direct state deletion scoped to dev break-glass recovery. Our normal path
  must preserve the app id plus instance id boundary, because SWE-bench uses
  multi-app Dapr workflows: parent workflows run on `workflow-orchestrator`,
  session/turn workflows can run on stable agent-runtime pools or session-host
  app ids, and OpenShell resources are external side effects.

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

If Dapr keeps retrying old scheduler reminders after all benchmark runs and
leases are gone, verify `workflow-orchestrator` sidecar logs for repeated
`cannot add event to workflow as state has been purged`, `no such instance
exists`, or `execution aborted` lines. On disposable dev state, a full
`wfstate_state` reset plus `workflow-orchestrator` rollout restart is a valid
break-glass baseline reset only after confirming there are no active benchmark
runs, active benchmark leases, active SWE-bench sandboxes, or active workflow
executions that must be preserved.

## Benchmark Best Practices

- Do not roll workflow-orchestrator, swebench-coordinator, or agent-runtime
  images while a run is active. Durable replay depends on the worker code shape
  matching persisted workflow history.
- Rollout safety depends on both application shutdown and sidecar shutdown.
  Workflow-bearing Deployments should set `dapr.io/graceful-shutdown-seconds`
  and a larger Kubernetes `terminationGracePeriodSeconds`; agent hosts created
  by the OpenShell Dapr webhook should receive the same treatment.
- For Dapr multi-app workflows, treat the target app id as part of the durable
  workflow contract. The target app should be a stable service or pool, already
  running in the same Kubernetes namespace, with the same workflow/activity
  registrations on every replica and access to the same actor state store.
  Creating a brand-new target app id per benchmark instance and immediately
  routing child workflow work to it is an anti-pattern for high concurrency:
  it couples benchmark admission to actor placement churn.
- Keep every workflow-enabled configuration used by agent runtimes and
  sandboxes on Dapr's multi-app workflow safeguard feature set. In Dapr 1.17,
  `WorkflowsRemoteActivityReminder` is the relevant feature for remote
  activities because it lets the remote app save a reminder before notifying
  the parent app, reducing lost-completion windows when the parent app is
  temporarily unreachable.
- Use Dapr metadata as a readiness input, not only Kubernetes pod readiness.
  `/healthz` proves the sidecar is alive, but workflow-bearing apps also need
  worker connection metadata before parent workflows start routing durable work
  to them. This is necessary but not sufficient: placement churn and recent
  actor lock warnings should still block benchmark scale-up.
- Prefer Dapr configuration and admission control for concurrency. Dapr does
  not provide a cluster-wide automatic workflow throttle; app-level
  `maxConcurrentWorkflowInvocations` and `maxConcurrentActivityInvocations`
  protect a worker process, while benchmark admission must account for
  Kueue quota, node requests, sandbox headroom, statestore pressure, and Dapr
  workflow-worker health.
- Gate benchmark launches while workflow-builder is rolling, Argo hooks are
  running, or the managing Argo Application is not stable.
- Gate benchmark launches when recent agent-host daprd logs show actor lock,
  scheduler/reminder, or workflow retry pressure, or when any active agent-host
  app container has OOMKilled. Parent workflow-orchestrator pressure alone is
  not enough for Kueue-backed session-host runs.
- Keep session-host pods bounded. For benchmark hosts, a nonterminal workflow
  that makes no Dapr status progress past the idle timeout should be
  terminated and the pod should exit nonzero so Kueue/runtime slots are not
  held indefinitely. Do not use raw wall-clock age as the timeout signal:
  longer SWE-bench attempts can legitimately run past 15 minutes while still
  updating workflow status. When the monitor falls back to benchmark session
  activity, preserve the actual `activityAgeSeconds`; do not reset the local
  progress clock to "now" for an event that is already near the timeout.
- Let evaluator callbacks commit official harness results and return quickly.
  Completed-run cleanup, full summary recompute, MLflow sync, and trace-summary
  artifact writes can involve Dapr termination waits and external services, so
  run them as background post-processing after the run row is marked completed.
  Otherwise a successful finalize can exceed the evaluator's HTTP read timeout
  even though the database already contains the SWE-bench results.
- For SWE-bench one-shot agent hosts, keep tool execution inline and keep the
  strict sequential agent loop deterministic. Do not add an extra per-turn
  child `agent_workflow` for SWE-bench. A 2026-05-25 c5 dev checkpoint showed
  three of five brand-new ephemeral agent-host app IDs stalled after scheduling
  the first tool, with Dapr sidecars logging `Ignoring complete task which no
  longer exists` for the `__turn__1` child workflow. That pattern points at
  startup-time workflow actor routing/placement churn, not model behavior. The
  current SWE-bench path runs the one-shot turn inline inside the already
  started `session_workflow`, while still stamping
  `agentWorkflowMode=strict_sequential` and seeding runtime/MCP context through
  activities before the first LLM call.
- Do not treat the inline-turn change as the final scale fix. A follow-up c5
  checkpoint on 2026-05-25 still lost one base `session_workflow` after the
  first `tool_activity.scheduled` event. The sidecar logged
  `Timed out waiting for actor in-flight lock claims to be released` and then
  `Ignoring complete task which no longer exists` for the session workflow
  instance itself. That proves the remaining problem is the ephemeral
  per-session Dapr app-id and actor-placement churn, not only the old per-turn
  child workflow.
- Prefer stable workflow-host app IDs for capacity runs. Dapr multi-application
  workflow routing is app-id based: a parent can call activities or child
  workflows on another app id, and Dapr may execute that work on any replica
  serving the target app id. That pattern fits a stable benchmark agent
  workflow pool where all replicas register the same workflows and activities.
  It does not fit creating hundreds of short-lived Dapr app IDs at launch time
  and immediately scheduling child workflows to each one.
- If a temporary per-session host path remains for interactive or low-volume
  sessions, do not use it as evidence for 25+ SWE-bench capacity. It creates
  actor placement updates at the same rate as benchmark admission, and each
  session-host shutdown creates additional placement churn while sibling
  workflows may still be active.
- Do not solve placement churn with an unbounded static sleep. The useful
  readiness gates are Dapr sidecar metadata showing workflow workers connected,
  no recent actor in-flight-lock or unknown-instance logs, stable control-plane
  rollout state, and benchmark capacity signals. If a short settle delay is
  needed as a tactical guard, document it as a workaround and keep the durable
  direction a stable app-id worker pool.
- Keep the SWE-bench sandbox alive until the parent workflow has completed
  `extract_patch`. The agent session can reach `end_turn` before the parent
  workflow runs the post-solve patch command; deleting the sandbox at that
  boundary turns a valid model attempt into an infrastructure failure and can
  corrupt predictions if logs are used as a fallback patch source.
- Freeze SWE-bench turns onto `agentWorkflowMode=strict_sequential`.
  Runtime agent settings, hooks, or orchestration strategy must not decide
  whether the agent loop uses the repo-owned sequential action order after the
  workflow has started. That decision is part of durable history, so the mode
  is stamped into the turn input and runtime context.
- Keep interactive sessions on warning behavior unless a user-facing timeout is
  explicitly desired.
- Treat model max-iteration, no-patch, and empty-patch outcomes as model
  quality outcomes, not benchmark infrastructure failures. Treat stuck Dapr
  workflows, unreleased leases, first-tool failures, and deleted sandboxes with
  running workflows as infrastructure failures.
