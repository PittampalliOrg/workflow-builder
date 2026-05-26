# SWE-bench Concurrency Runbook

The SWE-bench benchmark path uses a Dapr Workflow preflight/inference split:

- `swebench_environment_preflight_workflow` prepares and validates inference images before any instance workflow starts.
- `swebench_run_workflow` admits instance child workflows through resource leases instead of scheduling all selected instances at once.
- `swebench_instance_workflow` requires a stamped, validated `inferenceEnvironment`; it must not submit environment build PipelineRuns.

## Dapr Workflow Operating Model

Dapr Workflow code runs in the application, while the Dapr sidecar drives
execution through a workflow work-item stream. The workflow engine is backed by
Dapr actors and reminders, so workflow and activity state is durable and can be
replayed after sidecar, pod, or node failure.

Operational consequences for SWE-bench:

- Workflow and activity limits are per sidecar. Effective capacity is replicas
  multiplied by the configured Dapr `maxConcurrentWorkflowInvocations` and
  `maxConcurrentActivityInvocations` values, then further capped by Kueue,
  leases, model capacity, and node pressure.
- Dapr has no global workflow fan-out limit by default. Keep explicit
  per-sidecar limits as safety rails, and let benchmark launch/admission choose
  run concurrency from live Kueue quota, leases, PSI, sandbox headroom, evaluator
  slots, and runtime health.
- Activities are at-least-once. Any activity that creates pods, leases,
  sandboxes, artifacts, or DB projections must be idempotent or have a durable
  dedupe key.
- All replicas of a workflow app must register the same workflows and
  activities. Do not roll `workflow-orchestrator`, agent runtime, or
  `swebench-coordinator` images during an active benchmark run unless the run has
  been cancelled and cleaned up.
- Child workflows have their own state and status. Terminating a parent
  terminates children, but normal cleanup should still release benchmark leases
  and delete sandbox/session resources explicitly.
- Purge is for terminal workflow state. Because SWE-bench runs do not need old
  workflow history after DB/evaluator projections are written, terminal
  workflows should be purged during cleanup. Do not force-purge active,
  suspended, or pending workflows while a run is still executing.

## Dev Cluster Architecture

The current `dev` spoke is a Crossplane-owned Talos cluster on Hetzner. It is
not a manually maintained HCloud/Talos cluster. Hub ArgoCD owns the spoke
through the stacks GitOps bridge, and workflow-builder changes reach dev by the
normal image-promotion path:

```text
workflow-builder origin/main
  -> hub outer-loop PipelineRun
  -> stacks release-pins/workflow-builder-images.yaml
  -> generated workflow-builder-system overlay
  -> source-hydrator env/spokes-dev-next
  -> GitOps Promoter env/spokes-dev
  -> hub ArgoCD dev-workflow-builder Application
```

The capacity-oriented dev shape is:

- 3 control-plane nodes.
- 6 benchmark worker nodes, currently `cpx51`, labeled
  `stacks.io/swebench-pool=dev-benchmark`.
- All SWE-bench OpenShell pods should schedule on that worker pool.
- Tailscale exposes the API through the spoke ProxyGroup; workflow-builder app
  access remains a promoted spoke workload.

The May 2026 rebuild intentionally keeps benchmark Kueue quota below raw node
capacity until higher-concurrency canaries prove the rest of the stack. The
current dev `benchmark-fast` nominal quota is 33.6 CPU, 84Gi memory, 381Gi
ephemeral-storage, and 134 pods, with bounded cohort borrowing up to another
16.8 CPU, 42Gi memory, 190Gi ephemeral-storage, and 67 pods when lower-priority
queues can lend. Memory, ephemeral-storage, and pod quotas are part of the same
admission budget; on the 2026-05-26 DeepSeek 50-way infrastructure checkpoint,
memory was the first Kueue limiter for full OpenShell plus agent-host
instances, not pod count or PSI pressure.

```text
84Gi nominal memory / 1.75Gi full-instance request = 48 full instances
381Gi nominal ephemeral-storage / 6.54Gi full-instance request = 58 full instances
134 nominal pods / 2 pods per full Kueue-backed instance = 67 full instances
```

The same profile can exceed 48 full instances only when it borrows memory from
the cohort and competing lower-priority queues are idle. Do not treat borrowed
headroom as deterministic capacity unless the launch capacity snapshot reports
the borrowed quota and the competing queue state.

## Image Build And Cache Strategy

For the dedicated image-build runbook, see
[`docs/swebench-image-builds-and-caching.md`](./swebench-image-builds-and-caching.md).

SWE-bench inference images are exact environment artifacts. A launch should use
an instance only when the image is validated for the current suite, repo,
version, base commit, digest, and computed `envSpecHash`. Coarse keys such as
repo/version/base commit are not sufficient because harness environment
generation can change without changing those fields.

The normal build path is hub Tekton, not the dev spoke. When preflight finds a
missing exact image, workflow-builder submits a `swe-env-<envSpecHash-prefix>`
PipelineRun to hub through `SWEBENCH_INFERENCE_BUILD_SUBMISSION_MODE=hub` and
`SWEBENCH_INFERENCE_BUILD_HUB_KUBECONFIG`. The validated result is stored in
`environment_image_builds` and exposed back to dev through the inference
environment ConfigMap mounted at `SWEBENCH_INFERENCE_ENVIRONMENTS_DIR`.

Cache behavior is intentionally layered:

- The durable cache key is the environment spec hash; reuse is safe only when
  that hash and digest match.
- Build concurrency is capped by `SWEBENCH_INFERENCE_BUILD_MAX_ACTIVE` so hub
  image builds do not starve GitOps or benchmark runtime work.
- `SWEBENCH_INFERENCE_BUILD_CACHE_SHARDS` and
  `SWEBENCH_INFERENCE_BUILD_CACHE_SHARD_NODES` spread build cache affinity
  across hub build nodes. This improves reuse for repeated repo/version images
  while avoiding a single hot cache node.
- Static ConfigMap pins are useful for fast launch selection, but DB rows from
  successful dynamic builds are the source of truth for new exact-ready
  coverage.

Treat the build, validation, and publication phases as separate states. A hub
PipelineRun can build and validate an image, then fail later while publishing
the exact-ready pin back to Git. For example, a 2026-05-25 Django 3.1 build
completed `build-and-push` and `validate-image`, but `pin-environment` failed
after repeated GitHub `Internal Server Error` push responses. That is a pin
publication failure, not evidence that the image artifact or validation failed.
Do not count that environment as launch-ready until the DB row and ConfigMap
pin are persisted, but recover it by retrying or replaying the idempotent pin
step rather than rebuilding the image from scratch.

Follow-up build work should focus on raising exact-ready coverage before
raising dev runtime concurrency. The useful next optimizations are cache hit
metrics by repo/version/envSpecHash, build-duration histograms per shard,
explicit cache warm plans for high-value Verified repos, resumable pin
publication for already-validated images, and failure grouping by dependency,
validation, registry push, and Git publication phase so slow or flaky images do
not hide runtime capacity issues.

When exact-ready coverage is below a target run size, use the existing exact
cache as a model/runtime proof and mark the launch with `allowPartialSelection`.
That is valid for proving the agent path if every selected instance is distinct
and exact-ready. It is not evidence that the missing instances are ready or that
the cluster can run the full requested count; continue the build campaign after
the proof run and rerun the larger target only after the cache reaches coverage.

## Agent Turn Budget

`maxTurns` is a model-quality budget, not a capacity gate. A completed
SWE-bench evaluator run can still report `resolved=false` if the model stopped
at its turn cap, produced no patch, produced a patch that did not apply, or
left FAIL_TO_PASS/PASS_TO_PASS failures. Treat those as benchmark outcomes
unless the surrounding runtime lost a workflow, sandbox, lease, patch
extraction step, or evaluator artifact.

If every selected instance reports unresolved, audit the inference process
before classifying the result as model quality. A 2026-05-25 dev run showed
`extract_patch` failures with `sandbox not found` while rows were still marked
`inferred`; fallback extraction then picked up truncated session-event previews
that happened to contain `diff --git`. Authoritative SWE-bench predictions
must come from the workflow `modelPatch` output or the successful
`extract_patch` command stdout, not arbitrary agent/session logs.

For DeepSeek V4 Pro proof runs, avoid low turn caps intended only to shorten
infrastructure canaries. The dev smoke on 2026-05-25 showed repeated
`termination_reason=max_iters` at 30-50 tool calls, sometimes with no patch and
sometimes with an incomplete patch. Use a higher explicit cap, such as
`--max-turns 80` or `--max-turns 100`, for the next exact-ready model proof
canary, then compare no-patch rate, patch apply rate, and resolved rate before
raising concurrency. Keep shorter caps only for infrastructure-only tests where
model resolution is not the acceptance criterion.

## Evaluator Environment Failures

If all selected instances are unresolved, do not stop at the run summary. First
separate model output quality from evaluator process health:

- Confirm each inferred row has a non-empty authoritative `model_patch`, a
  successful extraction path, and no `inference_error`.
- Confirm the evaluator actually applied the patch and ran the target tests.
  `resolved=false` is a benchmark result only after the harness process itself
  is healthy.
- Inspect at least one known-solvable instance's raw `test_output.txt`. In the
  2026-05-25 Astropy proof run, every selected row had an extracted patch, but
  the evaluator environment failed during editable install with
  `ModuleNotFoundError: setuptools.dep_util`. Adding the Astropy-specific
  `setuptools<70` constraint in the evaluator Tekton task changed the follow-up
  proof run from 0/10 resolved to 4/10 resolved, with
  `astropy__astropy-12907` reporting `15 passed`.

That pattern means "zero resolved" is process evidence, not a model verdict.
Classify it as benchmark infrastructure until patch extraction, patch apply,
test execution, and finalization have all been proven healthy on at least one
known-solvable case.

## PSI Metrics

Kubernetes 1.36 makes kubelet PSI metrics stable and enabled by default when
the Linux nodes support PSI and cgroup v2. PSI reports stalled wall-clock time
for CPU, memory, and I/O at node, pod, and container scope. The useful values
are `some` and `full` pressure over `avg10`, `avg60`, and `avg300` windows plus
cumulative totals.

For benchmark capacity, PSI is a better launch signal than utilization alone:

- CPU `some` pressure can explain slow first-tool or long LLM/tool turn latency
  even when CPU utilization is below 100%.
- Memory `some` or `full` pressure should reduce admission before kubelet
  reaches `MemoryPressure` or the agent app is OOMKilled.
- I/O `full` pressure is a hard stop candidate for SWE-bench because image
  pulls, repo checkout, patch generation, and test discovery all become
  scheduler-amplified when storage stalls.

The dev capacity observer already samples worker-node PSI and stores
`clusterPressure` in each launch capacity snapshot. Keep using that path for
admission. Use kubelet Summary API or `/metrics/cadvisor` PSI directly for
debug drills when a run has first-tool latency, OOMKills, or slow sandbox
readiness without Kubernetes node-pressure conditions.

Do not replace Kueue quota with PSI thresholds. Kueue remains the deterministic
admission source for CPU, memory, ephemeral-storage, and pod count. PSI should
be a live derating and debugging signal layered on top of Kueue:

- Launch concurrency should default to exact selected count capped by Kueue
  full-instance slots, Dapr parent workflow capacity, active leases, model caps,
  and evaluator Kueue slots.
- PSI should reduce or pause new starts when the cluster is admitted on paper
  but tasks are stalling in practice.
- Static PSI values in code are fail-safe watermarks, not desired steady-state
  concurrency settings. Prefer observed Kueue headroom, live leases, and PSI
  trends over fixed `BENCHMARK_MAX_ACTIVE_*` caps; leave the static caps unset
  except for emergency ceilings or diagnostic canaries.
- For dev as of 2026-05-26, `benchmark-fast` was Kueue-memory limited for full
  SWE-bench instances while PSI memory pressure stayed near zero. That means
  raising concurrency should happen by adding exact-ready images and queue
  quota only after successful canaries, not by overriding PSI thresholds.

## PipelineRun Guardrails

Dynamic SWE-bench inference image builds require `allowBuild=true` and `SWEBENCH_INFERENCE_BUILD_SUBMISSION_MODE=hub`. Hub submission also requires a scoped hub kubeconfig at `SWEBENCH_INFERENCE_BUILD_HUB_KUBECONFIG` or equivalent content env var. If hub submission is not configured, preflight fails closed instead of creating a local PipelineRun.

When hub Kueue is installed for build workloads, set
`SWEBENCH_INFERENCE_BUILD_KUEUE_QUEUE_NAME` to the Tekton build LocalQueue name.
Generated SWE-bench inference-image `PipelineRun`s will carry
`kueue.x-k8s.io/queue-name`, which Kueue's Tekton integration propagates to the
TaskRun pods. Leave it unset until the hub LocalQueue and ClusterQueue exist.

Local PipelineRun submission is blocked by default. It is only available for intentional one-off local testing with both:

- `SWEBENCH_INFERENCE_BUILD_SUBMISSION_MODE=local`
- `SWEBENCH_INFERENCE_BUILD_ALLOW_LOCAL_PIPELINERUNS=true`

For routine direct-Kimi canaries, prefer a small validated pair such as
`sympy__sympy-20590` and `django__django-11099`. Avoid
`psf__requests-2317` unless the Requests environment is the thing under test:
the image now avoids JIT setup fallback, but the Requests suite still takes
materially longer than the faster Lite smoke instances.

## Rollout Rules

Do not roll `workflow-builder`, `swebench-coordinator`, `workflow-orchestrator`, or agent runtime pool images during an active SWE-bench benchmark run. Dapr replay/versioning is safest when old workflow registrations remain available until all in-flight instances complete.

Before a dev rollout, terminate or purge only terminal stale workflow instances. Do not force-purge active benchmark workflows or active resource leases.

## Start-Path Readiness Gates

Benchmark instance start is fail-closed on the parent Dapr runtime. Before the
BFF creates the instance `workflow_executions` row or dispatches
`/api/v2/sw-workflows`, it calls `workflow-orchestrator` `GET /readyz`.
Readiness requires Dapr outbound health, Dapr metadata, at least one connected
Dapr workflow worker, and a taskhub probe. If the check fails, the BFF returns
503 with `workflow_runtime_unavailable`.

The coordinator treats BFF start 503s caused by orchestrator readiness as
retryable infrastructure backpressure. It releases the resource lease, requeues
the instance at the front of the run queue, and sleeps
`SWEBENCH_ORCHESTRATOR_NOT_READY_RETRY_SECONDS` (defaulting to
`SWEBENCH_LEASE_RETRY_SECONDS`) before trying again.

Capacity diagnostics also scan recent `workflow-orchestrator` application logs
for `workflow_start_pending_timeout`. Any count in the active log window marks
the parent Dapr runtime as under pressure and blocks new benchmark starts via
the same `dapr_runtime_pressure` launch gate. This is intentionally
metric-driven: do not lower a static global concurrency cap just because one
run hit start-path overload; pause starts while the signal is present, inspect
Dapr/orchestrator/agent-host state, and resume when the pressure window is
clear.

MLflow is not part of the start gate. With `MLFLOW_FAILURE_MODE=best_effort`,
the BFF starts benchmark MLflow run creation in the background. A tracking
timeout should only leave MLflow IDs null and log a warning; it must not block
run creation, Dapr workflow IDs, agent sessions, token usage, or evaluator
handoff.

The parent `workflow-orchestrator` SWE-bench workflow also treats MLflow as
non-critical. Benchmark-triggered parent workflows skip orchestrator-level
MLflow node-span emission and final trace reconciliation by default because
those activities run on the same Dapr workflow activity workers that need to
finish `extract_patch` and persist benchmark output. If parent trace projection
is needed for a controlled diagnostic run, opt in with
`WORKFLOW_ORCHESTRATOR_BENCHMARK_MLFLOW_NODE_SPANS_ENABLED=true` and/or
`WORKFLOW_ORCHESTRATOR_BENCHMARK_MLFLOW_FINALIZE_ENABLED=true`; do not enable
them for capacity runs unless MLflow egress is proven healthy under that load.

## MLflow Tracking And Comparison Campaigns

SWE-bench execution is durable workflow state first. MLflow is the tracking and
evaluation projection for the completed benchmark rows. A normal run creates one
MLflow parent run for the `benchmark_runs` row, one child run per
`benchmark_run_instances` row, and one child `swebench_mlflow_eval` run when the
post-hoc MLflow evaluation step can run.

Agent comparisons should be launched as a campaign: one benchmark run per agent
or configuration, all using the same suite and exact instance ids. The
Benchmarks launch sheet's `Compare agents` mode does this automatically and
applies a shared campaign tag. That tag is copied into parent, instance, and
eval MLflow runs as `workflow_builder.benchmark_tags` plus
`workflow_builder.benchmark_tag.<tag>=true`, so the whole campaign can be
searched in MLflow.

For the full hierarchy, query pattern, and live canary checklist, see
[`docs/swebench-mlflow-comparison.md`](./swebench-mlflow-comparison.md).

If hub ArgoCD reports the dev app as `Synced` but the live Deployment image
still points at the previous tag, hard-refresh the app before diagnosing the
runtime:

```bash
kubectl --kubeconfig ~/.kube/hub-config -n argocd annotate app dev-workflow-orchestrator argocd.argoproj.io/refresh=hard --overwrite
```

## Orchestrator Workflow Runtime Watchdog

`workflow-orchestrator` polls Dapr metadata for `workflowConnectedWorkers`.
When that count remains zero past the configured threshold, the watchdog deletes
its own pod through the Kubernetes API, then falls back to process exit if pod
deletion does not complete.

This must be a full pod replacement, not only a Python process restart. A stale
`daprd` sidecar can keep logging workflow actor registration errors while the
application container is replaced inside the same pod; replacing the pod
restarts both the app container and the Dapr sidecar.

## Dapr Workflow Cleanup

Dapr workflow termination is asynchronous. Benchmark cleanup must request
termination, poll the parent and child workflow instances until each is
terminal or missing, and only then purge durable state. Purging child workflow
state before the parent has observed termination can leave the parent replay
loop stuck on a missing sub-orchestration reference.

For SWE-bench cancellation and stall cleanup, use this order:

1. Terminate child agent-runtime workflow instances and wait for them to close.
2. Terminate parent `workflow-orchestrator` instances and wait for them to close.
3. Purge parent workflow state.
4. Purge child agent-runtime workflow state.
5. Mark `sessions` and `workflow_executions` terminal only after durable
   closure is confirmed.

Operationally, prefer Dapr SDK or CLI workflow management where it is reliable.
The local sidecar HTTP workflow API is a bounded fallback for status,
terminate, and purge calls in benchmark cleanup paths; it must use short
timeouts and treat missing instances as already closed.

## Capacity Model

Effective agent runtime workflow capacity is:

```text
runtime replicas * per-sidecar Dapr workflow invocation limit
```

The run admission path also leases global inference slots, OpenShell sandbox
slots, agent runtime slots, Dapr workflow slots, and model request slots.
Increasing only the UI concurrency value will not increase throughput unless
these backing capacities are also raised.

Set `BENCHMARK_CAPACITY_MODE=auto` when the BFF should derive the active
inference budget from runtime, Dapr, sandbox, and model capacity. In this mode,
`BENCHMARK_MAX_ACTIVE_INFERENCE_INSTANCES` is a hard safety ceiling, not the
primary source of capacity. The coordinator should use the BFF's stored run
capacity snapshot and only apply `SWEBENCH_COORDINATOR_MAX_INFERENCE_CONCURRENCY`
when an explicit emergency backstop is needed.

For a benchmark run, stored inference concurrency is effectively:

```text
min(
  requested concurrency,
  selected instance count,
  runtime replicas * slots per replica when not using the Kueue execution backend,
  runtime replicas * per-sidecar Dapr workflow limit when not using the Kueue execution backend,
  explicit runtime maxActiveSessions when configured,
  BENCHMARK_MAX_ACTIVE_INFERENCE_INSTANCES,
  BENCHMARK_AGENT_WORKFLOW_MAX_ACTIVE_TURNS / BENCHMARK_MAX_ACTIVE_AGENT_WORKFLOWS,
  min(BENCHMARK_MAX_ACTIVE_SANDBOXES, live schedulable sandbox headroom),
  BENCHMARK_MODEL_MAX_ACTIVE_REQUESTS / BENCHMARK_MAX_ACTIVE_MODEL_REQUESTS
)
```

The live resource-lease gate re-checks the same classes before each instance
starts. Run admission and global lease capacity deliberately use different
sandbox values: run admission is capped by remaining Kueue and schedulable
sandbox headroom at launch time, while the stored `maxActiveSandboxes` lease limit is
capped by configured sandbox capacity and total schedulable sandbox capacity.
Do not store launch-time remaining headroom as the global active sandbox limit,
or overlapping runs can freeze at the amount of headroom that happened to be
available when the newest run was created. If a requested concurrency is higher
than the runtime or cluster can actually admit, the run should slow down instead
of over-scheduling.

Capacity diagnostics are exposed in two places:

- `POST /api/benchmarks/capacity` computes a launch-candidate safe capacity for
  the selected agent/instances and reports active lease usage by resource.
- `GET /api/benchmarks/runs/<runId>/capacity` reports the stored effective
  concurrency, active/stale lease counts, active/limit per resource type,
  `blockedBy`, Kueue/sandbox schedulable headroom, runtime slots, Dapr workflow
  slots, and model caps for an existing run.

The launch sheet's `Max safe` control uses the launch-candidate diagnostics
instead of the static default of 10.

## Dev Maximization Note

As of the May 2026 c32/c40 ladder, dev's raw six-worker pool is not the
first limiter. Each benchmark instance consumes two Kueue-admitted pods:

1. the OpenShell sandbox pod;
2. the per-session agent-host pod.

For the current `benchmark-fast` host-execution profile those requests are about
250m CPU, 896Mi memory, 3880Mi ephemeral storage, and 2 pods per active
instance: one short-lived host worker plus one OpenShell sandbox pod with its
Dapr sidecar. The agent-host container must set an explicit memory limit at
least equal to its configured request; otherwise the namespace `LimitRange`
default limit can be lower than the request and Kubernetes will reject the pod
before Kueue can run it. The BFF derives this full-instance shape from
`SANDBOX_EXECUTION_CLASSES_JSON.<class>` and the configured sandbox/Dapr
requests unless `BENCHMARK_KUEUE_INSTANCE_POD_COUNT` explicitly overrides it.
Set `BENCHMARK_KUEUE_INSTANCE_REQUEST_MODE=openshell-pod` only for an
architecture where Kueue admits just the OpenShell pod per instance.

The BFF should treat nominal Kueue quota as the deterministic default and
include borrowing diagnostics separately so operators can tell whether a run is
using only the cohort's share or relying on reclaimable headroom from another
queue.

The c12 failure mode was not Kueue starvation: all parents left `PENDING`,
all sessions were created, and all Kueue Workloads were admitted. One
SWE-bench turn scheduled a second tool but never emitted
`tool_activity.started` after the one-shot per-turn child workflow actor was
cancelled during Dapr placement churn. Later high-concurrency dev checkpoints
also reproduced durabletask replay mismatches when the one-shot turn was forced
behind a child `agent_workflow`. SWE-bench now always keeps both tool execution
and the one-shot agent turn inline with the session workflow; the SWE-bench
specific child-turn override was removed so an operator cannot accidentally
re-enable the higher-churn sub-orchestration path during capacity tests.

## Kueue Execution Plane Backend

Dev uses the Kueue-backed Dapr path: `BENCHMARK_EXECUTION_BACKEND=dapr-kueue`,
`AGENT_WORKFLOW_HOST_BACKEND=kueue`, and
`SANDBOX_EXECUTION_API_URL=http://sandbox-execution-api.workflow-builder.svc.cluster.local:8080`.
The BFF still submits the generated SWE-bench instance workflow and validated
inference environment, but each instance gets its own Kueue-managed OpenShell
sandbox instead of being capped by the legacy shared runtime pool.

The sandbox-execution-api creates Kueue-managed Kubernetes workloads by setting
the `kueue.x-k8s.io/queue-name` label and leaves Kueue to manage
suspension/admission. The pod uses the requested execution class:

| Execution class  | Queue            | RuntimeClass    | Intended use                                                                     |
| ---------------- | ---------------- | --------------- | -------------------------------------------------------------------------------- |
| `benchmark-fast` | `benchmark-fast` | unset           | runc/OpenShell parity path for trusted SWE-bench throughput comparisons.         |
| `secure-gvisor`  | `secure-gvisor`  | `secure-gvisor` | gVisor-isolated path for less trusted agent code once Talos exposes the runtime. |

Both classes keep the benchmark worker node selector
`stacks.io/swebench-pool=dev-benchmark`, hostname topology spread, and the
configured sandbox and agent-host resource requests. The current
`benchmark-fast` admission profile is about 450m CPU, 1792Mi memory, and
6.54Gi ephemeral-storage per full Kueue-backed SWE-bench instance. The host
execution worker reports state back through
`POST /api/internal/benchmarks/runs/<runId>/instances/<instanceId>/execution`.
Terminal success updates the existing `workflow_executions` row and reuses the
normal `syncBenchmarkInstanceFromExecution` path, so benchmark summaries,
patch extraction, MLflow sync, evaluator handoff, and UI state stay on the
current schema.

Relevant upstream contracts:

- Kueue Jobs: `https://kueue.sigs.k8s.io/docs/tasks/run/jobs/`
- Kubernetes RuntimeClass: `https://kubernetes.io/docs/concepts/containers/runtime-class/`

## Concurrency Variable Inventory

### Benchmarks UI and BFF

These live in `src/lib/components/benchmarks/launch-run-sheet.svelte`,
`src/lib/server/benchmarks/runtime-capacity.ts`, and
`src/lib/server/benchmarks/service.ts`.

| Variable or constant                                       |                                   Default |                  Dev GitOps value | Effect                                                                                                                                                                                                    |
| ---------------------------------------------------------- | ----------------------------------------: | --------------------------------: | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DEFAULT_INFERENCE_CONCURRENCY`                            |                                      `10` |                               n/a | Launch sheet initial inference request.                                                                                                                                                                   |
| `DEFAULT_EVALUATION_CONCURRENCY`                           |                                      `24` |                               n/a | Launch sheet initial evaluation request and BFF fallback.                                                                                                                                                 |
| `MAX_INFERENCE_CONCURRENCY`                                |                                     `500` |                               n/a | Launch sheet slider maximum. Backend still clamps by selected instances and live capacity.                                                                                                                |
| `MAX_EVALUATION_CONCURRENCY`                               |                                     `128` |                               n/a | Launch sheet evaluation slider maximum. Backend/evaluator also clamp to 128.                                                                                                                              |
| `BENCHMARK_CAPACITY_MODE`                                  |                                  `manual` |                            `auto` | `manual` preserves the historical global default cap; `auto` derives capacity from live/runtime limits and treats explicit caps as safety rails.                                                          |
| `BENCHMARK_DEFAULT_CONCURRENCY`                            |                                      `10` |                              `10` | BFF fallback requested inference concurrency when the request omits or passes an invalid value.                                                                                                           |
| `BENCHMARK_MAX_ACTIVE_INFERENCE_INSTANCES`                 | `56` in manual mode, derived in auto mode |                             unset | Global active inference hard cap across benchmark resource leases. In Kueue/auto mode, leave unset unless an emergency ceiling is needed.                                                                 |
| `BENCHMARK_AGENT_WORKFLOW_MAX_ACTIVE_TURNS`                |                                     unset |                             unset | Optional hard cap for Dapr agent child workflows. Prefer leaving unset so `dapr_workflow_slot` capacity derives from runtime sidecar capacity.                                                            |
| `BENCHMARK_MAX_ACTIVE_AGENT_WORKFLOWS`                     |                                     unset |                             unset | Backward-compatible alias for `BENCHMARK_AGENT_WORKFLOW_MAX_ACTIVE_TURNS`.                                                                                                                                |
| `BENCHMARK_MAX_ACTIVE_SANDBOXES`                           |                                     unset |                             unset | Configured OpenShell sandbox cap. Per-run admission also considers remaining live Kueue and schedulable headroom; stored global lease capacity should use configured cap plus total schedulable capacity. |
| `BENCHMARK_MODEL_MAX_ACTIVE_REQUESTS`                      |                                     unset |                             unset | Optional per-model request cap for `model_slot` leases. Prefer unset unless a provider has a lower quota than the cluster can otherwise run.                                                              |
| `BENCHMARK_MAX_ACTIVE_MODEL_REQUESTS`                      |                                     unset |                             unset | Backward-compatible alias for `BENCHMARK_MODEL_MAX_ACTIVE_REQUESTS`.                                                                                                                                      |
| `BENCHMARK_RESOURCE_LEASE_SECONDS`                         |          `max(900, timeoutSeconds + 900)` |                             unset | Resource lease TTL. Not a throughput cap, but too-long leases can hold capacity after failures.                                                                                                           |
| `BENCHMARK_LEASE_RETRY_SECONDS`                            |                                      `15` |                             unset | Retry-after returned when the BFF resource-lease gate denies capacity.                                                                                                                                    |
| `BENCHMARK_INFERENCE_STALL_SECONDS`                        |                                     `480` |                             `900` | Marks stale inference progress; not a dispatch cap.                                                                                                                                                       |
| `BENCHMARK_EXECUTION_BACKEND`                              |                                    `host` |                      `dapr-kueue` | Kueue-backed Dapr/OpenShell inference path. `legacy-dapr` is accepted only for rollback tests.                                                                                                            |
| `BENCHMARK_EXECUTION_CLASS`                                |                          `benchmark-fast` |                  `benchmark-fast` | Execution class; supported initial values are `benchmark-fast` and `secure-gvisor`.                                                                                                                       |
| `SANDBOX_EXECUTION_API_URL` / `HOST_EXECUTION_API_URL`     |                                     unset | sandbox-execution-api service URL | Host execution API base URL required by the Kueue backend.                                                                                                                                                |
| `SANDBOX_EXECUTION_API_TOKEN` / `HOST_EXECUTION_API_TOKEN` |             `INTERNAL_API_TOKEN` fallback |                             unset | Bearer token used by the BFF when calling the host execution API.                                                                                                                                         |
| `MLFLOW_ENABLED`                                           |                                      true |                              true | Enables benchmark tracking metadata. Start-path behavior should remain non-blocking when tracking is unavailable.                                                                                         |
| `MLFLOW_FAILURE_MODE`                                      |                             `best_effort` |                     `best_effort` | In best-effort mode, MLflow creation failures are logged and do not block benchmark instance start.                                                                                                       |
| `MLFLOW_REQUEST_TIMEOUT_MS`                                |                                   `30000` |                           `30000` | Per-request timeout for MLflow calls. A timeout should not prevent Dapr workflow dispatch.                                                                                                                |
| `WORKFLOW_ORCHESTRATOR_BENCHMARK_MLFLOW_NODE_SPANS_ENABLED` |                                    false |                             false | Opt-in parent workflow node-span emission for SWE-bench. Keep false for capacity runs so MLflow egress cannot consume Dapr activity workers needed for terminal inference.                                |
| `WORKFLOW_ORCHESTRATOR_BENCHMARK_MLFLOW_FINALIZE_ENABLED`  |                                    false |                             false | Opt-in parent workflow final trace reconciliation for SWE-bench. Keep false for capacity runs; benchmark completion must not wait on MLflow trace search/link/export.                                      |

Sandbox headroom is sampled by `src/lib/server/benchmarks/sandbox-capacity.ts`:

| Variable                                      |                              Default | Effect                                                                                                                                      |
| --------------------------------------------- | -----------------------------------: | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `BENCHMARK_SANDBOX_CAPACITY_NAMESPACE`        | `OPENSHELL_NAMESPACE` or `openshell` | Namespace used when pod listing falls back from all namespaces.                                                                             |
| `BENCHMARK_SANDBOX_REQUEST_CPU`               |                               `100m` | Per-sandbox request used to estimate schedulable slots when pod requests are unavailable.                                                   |
| `BENCHMARK_SANDBOX_REQUEST_MEMORY`            |                              `256Mi` | Per-sandbox request used to estimate schedulable slots when pod requests are unavailable. Dev live value is `512Mi`.                        |
| `BENCHMARK_SANDBOX_REQUEST_EPHEMERAL_STORAGE` |                                `4Gi` | Per-sandbox ephemeral request used for schedulable and Kueue capacity estimates. Keep this aligned with sandbox-execution-api pod requests. |
| `BENCHMARK_KUEUE_CLUSTER_QUEUE`               | `BENCHMARK_EXECUTION_CLASS` fallback | ClusterQueue used for live Kueue capacity sampling.                                                                                         |
| `OPENSHELL_NAMESPACE`                         |                          `openshell` | Fallback namespace for sandbox capacity sampling.                                                                                           |

### Agent Runtime Capacity

These control the runtime-side dimensions that benchmark admission consumes.
The BFF route resolver lives in `src/lib/server/agents/runtime-routing.ts`; the
controller status calculation lives in `services/agent-runtime-controller/src/main.py`.

| Variable or config field                                                                   |                                                  Default |                                                                              Dev live value sampled 2026-05-24 | Effect                                                                                                                                                                                        |
| ------------------------------------------------------------------------------------------ | -------------------------------------------------------: | -------------------------------------------------------------------------------------------------------------: | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AGENT_RUNTIME_POOL_MAX_REPLICAS`                                                          |                                                      `2` |                                                                                                           `16` | Shared-pool replica fallback when a pool config omits `maxReplicas`.                                                                                                                          |
| `AGENT_RUNTIME_POOL_MIN_REPLICAS`                                                          |                                                    unset |                                                                                                          unset | Shared-pool minimum replica metadata when configured.                                                                                                                                         |
| `AGENT_RUNTIME_POOL_APP_IDS_JSON`                                                          |                                                    unset | `{"coding":{"appId":"agent-runtime-pool-coding","idleTtlSeconds":7200,"maxReplicas":16,"slotsPerReplica":12}}` | Maps runtime classes to shared pool app IDs and optional pool capacity. Explicit `slotsPerReplica` here wins for that shared pool. Dev coding pool capacity is `16 * 12 = 192` runtime slots. |
| `AGENT_RUNTIME_SLOTS_PER_REPLICA_JSON`                                                     |        `{"coding":5,"office":2,"browser":1,"testing":2}` |                                                             `{"coding":12,"office":2,"browser":1,"testing":2}` | Slots-per-replica fallback by runtime class. For dev, coding runtime capacity uses `12`.                                                                                                      |
| `AGENT_RUNTIME_DAPR_WORKFLOW_LIMIT_PER_SIDECAR`                                            |                                        `slotsPerReplica` |                                                                                                           `12` | Per-sidecar Dapr workflow invocation capacity used by BFF capacity estimates and controller status.                                                                                           |
| `DAPR_WORKFLOW_MAX_CONCURRENT_WORKFLOW_INVOCATIONS`                                        |                                                    unset |                                                                                                          unset | BFF capacity-estimate override checked before `AGENT_RUNTIME_DAPR_WORKFLOW_LIMIT_PER_SIDECAR`; use carefully because controller status reads the `AGENT_RUNTIME_*` value.                     |
| agent `runtimePool.maxActiveSessions`                                                      |                                                    unset |                                                                                                          unset | Explicit per-agent or pool active-session cap when present in agent config.                                                                                                                   |
| agent runtime lifecycle `slotsPerReplica`                                                  |                                   runtime-class fallback |                                                                                                         varies | `AgentRuntime.spec.lifecycle.slotsPerReplica`; controller reports this in status and BFF uses it when routing metadata includes it.                                                           |
| agent runtime lifecycle `daprWorkflowLimitPerSidecar` / `maxConcurrentWorkflowInvocations` | `AGENT_RUNTIME_DAPR_WORKFLOW_LIMIT_PER_SIDECAR` or slots |                                                                                                         varies | Per-AgentRuntime override for Dapr child-workflow capacity.                                                                                                                                   |

### SWE-bench Coordinator

These live in `services/swebench-coordinator/src/concurrency.py` and
`services/swebench-coordinator/src/app.py`.

| Variable                                                  |                        Default | Dev live value sampled 2026-05-24 | Effect                                                                                                                                         |
| --------------------------------------------------------- | -----------------------------: | --------------------------------: | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `SWEBENCH_COORDINATOR_MAX_INFERENCE_CONCURRENCY`          |          unset for run fan-out |                             unset | Optional emergency backstop for active `swebench_instance_workflow` children. Normal fan-out uses the BFF capacity snapshot stored on the run. |
| `SWEBENCH_COORDINATOR_INSTANCE_START_BATCH_SIZE`          |          effective concurrency |              `0` / unset target | Max new instance child workflows to start before an optional pacing delay. Non-positive or unset means full effective concurrency. This is a diagnostic pacing knob, not a capacity source. |
| `SWEBENCH_COORDINATOR_INSTANCE_START_BATCH_DELAY_SECONDS` |                            `0` |                             `0` target | Delay between start batches. Keep this at `0` for normal Kueue-gated runs; use a positive value only for a diagnostic canary.                  |
| `SWEBENCH_LEASE_RETRY_SECONDS`                            |                           `15` |                              `15` | Coordinator sleep interval when a resource lease is denied.                                                                                    |
| `SWEBENCH_ORCHESTRATOR_NOT_READY_RETRY_SECONDS`           | `SWEBENCH_LEASE_RETRY_SECONDS` |                             unset | Coordinator sleep interval after BFF reports orchestrator runtime unready during instance start.                                               |
| `SWEBENCH_EVAL_MAX_PARALLEL`                              |                           `24` |                              `24` | Evaluation TaskRun batch size passed to the evaluator Job. Clamped to `1..128`.                                                                |
| `SWEBENCH_MAX_WORKERS`                                    |    `24` via evaluator fallback |                             unset | Backward-compatible alias used only when `SWEBENCH_EVAL_MAX_PARALLEL` is absent.                                                               |

### SWE-bench Evaluator

These live in `services/swebench-evaluator/entrypoint.py`.

| Variable                     | Default | Maximum | Effect                                                                           |
| ---------------------------- | ------: | ------: | -------------------------------------------------------------------------------- |
| `SWEBENCH_EVAL_MAX_PARALLEL` |    `24` |   `128` | Number of per-instance Tekton TaskRuns active during official grading.           |
| `SWEBENCH_MAX_WORKERS`       |    `24` |   `128` | Backward-compatible alias used only when `SWEBENCH_EVAL_MAX_PARALLEL` is absent. |

The evaluator dispatches per-instance TaskRuns with a sliding window. It keeps
up to `SWEBENCH_EVAL_MAX_PARALLEL` TaskRuns active and starts the next instance
as soon as any active TaskRun finishes. Evaluator leases are released per
completed TaskRun, not at the end of a fixed batch.

## Current Dev Ramp Profile

Dev currently runs the Kueue-backed auto-capacity inference profile:

- `BENCHMARK_CAPACITY_MODE=auto`
- `BENCHMARK_EXECUTION_BACKEND=dapr-kueue`
- `BENCHMARK_EXECUTION_CLASS=benchmark-fast`
- `benchmark-fast` ClusterQueue nominal quota: 24 CPU, 60Gi memory, 272Gi ephemeral-storage, 96 pods
- `benchmark-fast` bounded borrowing: 12 CPU, 30Gi memory, 136Gi ephemeral-storage, 48 pods
- sandbox request profile: 100m CPU, 512Mi memory, 2600Mi ephemeral-storage
- agent-host request profile: 250m CPU, 1Gi memory, 3Gi ephemeral-storage
- no separate `BENCHMARK_AGENT_WORKFLOW_MAX_ACTIVE_TURNS` cap; Dapr workflow capacity derives from runtime sidecar capacity
- no separate `BENCHMARK_MAX_ACTIVE_INFERENCE_INSTANCES` cap in the Kueue path
- no separate `BENCHMARK_MAX_ACTIVE_SANDBOXES` cap; Kueue and live schedulable headroom cap admission
- no separate `SWEBENCH_COORDINATOR_MAX_INFERENCE_CONCURRENCY` cap; coordinator uses the BFF run capacity snapshot
- `SWEBENCH_COORDINATOR_INSTANCE_START_BATCH_SIZE=0` (full effective concurrency)
- `SWEBENCH_COORDINATOR_INSTANCE_START_BATCH_DELAY_SECONDS=0`

Keep evaluator concurrency at `24` until the evaluator finalization path has a
clean passing canary on object storage, then test `32`. Do not raise evaluator
concurrency beyond scheduler capacity unless evaluator TaskRun requests are
reduced or more nodes are schedulable.

### May 2026 24-Instance Validation

The first post-rebuild Kimi Verified 24-run validated the inference-side
concurrency mechanics even though official grading failed during evaluator
finalization:

- Requested/effective inference concurrency was `24`.
- Observed max active leases reached `24` for all inference resource classes:
  `agent_runtime_slot`, `dapr_workflow_slot`, `inference_slot`, `model_slot`,
  and `openshell_sandbox`.
- Observed max active evaluator leases reached `24`.
- Inference resource leases released cleanly; the two evaluator leases left by
  the failed finalizer were released manually after diagnosis.
- The run capacity snapshot reported:
  - `runtimeSlots: 72`
  - `agentWorkflowMaxActiveTurns: 72`
  - `daprWorkflowEffectiveCapacity: 108`
  - `configuredMaxActiveSandboxes: 80`
  - `schedulableSandboxCapacity: 108`
- The failure was post-inference: the evaluator's finalize TaskRun treated a
  Dapr blob-storage "blob not found" response as HTTP 500. That path is fixed
  by `fix(benchmarks): tolerate missing object artifacts`.

Use this run as evidence that the cluster and runtime can admit at least 24
fully concurrent instances. It is not an official score run because the
evaluation callback did not persist per-instance harness results.

### Estimating Maximum Concurrency

For the current dev deployment, deterministic nominal inference capacity is:

```text
min(
  24 CPU Kueue quota / 450m full-instance CPU request = 53,
  272Gi Kueue ephemeral quota / 6.54Gi full-instance ephemeral request = 41,
  96 Kueue pod quota / 2 pods per instance = 48,
  live schedulable sandbox slots,
  selected instance count,
  requested concurrency
) = 41 when the cluster is otherwise idle and launch diagnostics agree
```

If `benchmark-fast` borrows its full configured headroom, ephemeral-storage
capacity rises to about 408Gi, or about 62 full instances at the current
request profile. Going above that requires a GitOps quota change or lower
verified per-instance requests. The six-worker pool reports
about 91.8 allocatable CPU, 177Gi memory, 1.8Ti ephemeral storage, and 660 pod
slots, so the next quota expansion should be deliberate and should preserve
reserve for daprd, node agents, image pulls, cleanup jobs, and unrelated
platform workloads.

Random high-concurrency runs also require enough exact prevalidated inference
images. The random selector only admits instances whose computed environment
spec hash has a validated image. If the selector returns fewer instances than
the requested limit while Kueue headroom is available, check and sync
`environment_image_builds` before treating dev Kueue as the limiter.

Because stalled inferences can hold slots until the
`BENCHMARK_INFERENCE_STALL_SECONDS` detector fires, extrapolate wall-clock
from the slow tail, not only from successful inference medians. At high
concurrency, expect a single inference wave to last about as long as the
slowest timeout tail if provider behavior is similar.

### OpenAI-Parity Evaluation Coordinator

This is separate from official SWE-bench Benchmarks. It lives in
`services/evaluation-coordinator/src/app.py`.

| Variable                     | Default | Dev GitOps value | Effect                                                                                |
| ---------------------------- | ------: | ---------------: | ------------------------------------------------------------------------------------- |
| `EVALUATION_MAX_CONCURRENCY` |    `32` |             `32` | Upper bound for `executionConfig.concurrency` across evaluation item child workflows. |

### Internal Constants

These are code constants, not environment variables.

| Constant                                | Value | Effect                                                                                           |
| --------------------------------------- | ----: | ------------------------------------------------------------------------------------------------ |
| `BENCHMARK_TERMINATION_CONCURRENCY`     |   `8` | BFF-side parallelism when terminating sessions, turns, or workflows during cancellation/cleanup. |
| `BENCHMARK_SANDBOX_CLEANUP_CONCURRENCY` |   `8` | BFF-side parallelism for benchmark sandbox cleanup.                                              |

### Provider Rate-Limit Retry Knobs

These are not concurrency caps. They only control retry behavior after provider
rate limits.

| Provider         | Variables                                                                                | Default in code | Dev GitOps value |
| ---------------- | ---------------------------------------------------------------------------------------- | --------------: | ---------------: |
| DeepSeek         | `DEEPSEEK_RATE_LIMIT_MAX_RETRIES`, `DEEPSEEK_RATE_LIMIT_BACKOFF_SECONDS`                 |       `3`, `65` |        `3`, `65` |
| Together         | `TOGETHER_RATE_LIMIT_MAX_RETRIES`, `TOGETHER_RATE_LIMIT_BACKOFF_SECONDS`                 |       `3`, `65` |        `3`, `65` |
| Azure AI Foundry | `AZURE_AI_FOUNDRY_RATE_LIMIT_MAX_RETRIES`, `AZURE_AI_FOUNDRY_RATE_LIMIT_BACKOFF_SECONDS` |       `3`, `65` |        `3`, `65` |

## Change Checklist

When increasing SWE-bench inference concurrency, check all of these before
assuming the change is effective:

1. UI default/range: `launch-run-sheet.svelte`.
2. BFF stored run cap: `BENCHMARK_DEFAULT_CONCURRENCY` and `BENCHMARK_MAX_ACTIVE_INFERENCE_INSTANCES`.
3. Runtime capacity: shared-pool replica/slot config or dedicated runtime `slotsPerReplica`.
4. Dapr capacity: `AGENT_RUNTIME_DAPR_WORKFLOW_LIMIT_PER_SIDECAR` and, if used, lifecycle overrides.
5. Resource leases: sandbox and model caps; use live sandbox headroom for per-run admission and total sandbox capacity for global active lease limits.
6. Coordinator backstop and start pacing: `SWEBENCH_COORDINATOR_*`.
7. Evaluation: `SWEBENCH_EVAL_MAX_PARALLEL` on the coordinator and evaluator.

Do not roll `workflow-builder`, `swebench-coordinator`, `workflow-orchestrator`,
or agent runtime images while benchmark workflows are mid-run. Wait for active
runs to reach terminal status, or cancel and verify durable shutdown first.
