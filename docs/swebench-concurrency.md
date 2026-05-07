# SWE-bench Concurrency Runbook

The SWE-bench benchmark path uses a Dapr Workflow preflight/inference split:

- `swebench_environment_preflight_workflow` prepares and validates inference images before any instance workflow starts.
- `swebench_run_workflow` admits instance child workflows through resource leases instead of scheduling all selected instances at once.
- `swebench_instance_workflow` requires a stamped, validated `inferenceEnvironment`; it must not submit environment build PipelineRuns.

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

The May 2026 rebuild targets a conservative 72-instance inference ceiling. That
number is a runtime/model admission cap, not a raw Kubernetes maximum. The six
workers have more sandbox headroom than 72, but workflow-builder only admits 72
concurrent inference instances until the runtime pool and global caps are raised
again.

## PipelineRun Guardrails

Dynamic SWE-bench inference image builds require `allowBuild=true` and `SWEBENCH_INFERENCE_BUILD_SUBMISSION_MODE=hub`. Hub submission also requires a scoped hub kubeconfig at `SWEBENCH_INFERENCE_BUILD_HUB_KUBECONFIG` or equivalent content env var. If hub submission is not configured, preflight fails closed instead of creating a local PipelineRun.

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

For a benchmark run, stored inference concurrency is effectively:

```text
min(
  requested concurrency,
  selected instance count,
  runtime replicas * slots per replica,
  runtime replicas * per-sidecar Dapr workflow limit,
  explicit runtime maxActiveSessions when configured,
  BENCHMARK_MAX_ACTIVE_INFERENCE_INSTANCES,
  BENCHMARK_AGENT_WORKFLOW_MAX_ACTIVE_TURNS / BENCHMARK_MAX_ACTIVE_AGENT_WORKFLOWS,
  min(BENCHMARK_MAX_ACTIVE_SANDBOXES, live schedulable sandbox headroom),
  BENCHMARK_MODEL_MAX_ACTIVE_REQUESTS / BENCHMARK_MAX_ACTIVE_MODEL_REQUESTS
)
```

The live resource-lease gate re-checks the same classes before each instance
starts. Run admission and global lease capacity deliberately use different
sandbox values: run admission is capped by remaining schedulable sandbox
headroom at launch time, while the stored `maxActiveSandboxes` lease limit is
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
  `blockedBy`, sandbox schedulable headroom, runtime slots, Dapr workflow slots,
  and model caps for an existing run.

The launch sheet's `Max safe` control uses the launch-candidate diagnostics
instead of the static default of 10.

## Host Execution Plane Backend

The current Dapr SWE-bench runner remains the default backend. The host-level
sandbox execution plane is selected only when the BFF has
`BENCHMARK_EXECUTION_BACKEND=host` and `SANDBOX_EXECUTION_API_URL` (or
`HOST_EXECUTION_API_URL`) configured.

Workflow-builder submits the existing generated SWE-bench instance workflow,
trigger data, validated inference environment, timeout, and execution class to
`POST /api/v1/executions` on the host execution API. The host API creates a
Kueue-managed Kubernetes `Job` by setting the `kueue.x-k8s.io/queue-name` label
on the Job and leaves Kueue to manage suspension/admission. The Job pod uses the
requested execution class:

| Execution class | Queue | RuntimeClass | Intended use |
| --- | --- | --- | --- |
| `benchmark-fast` | `benchmark-fast` | unset | runc/OpenShell parity path for trusted SWE-bench throughput comparisons. |
| `secure-gvisor` | `secure-gvisor` | `secure-gvisor` | gVisor-isolated path for less trusted agent code once Talos exposes the runtime. |

Both classes keep the benchmark worker node selector
`stacks.io/swebench-pool=dev-benchmark`, hostname topology spread, and the
initial `16Gi` ephemeral-storage request. The host execution worker reports
state back through
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

| Variable or constant | Default | Dev GitOps value | Effect |
| --- | ---: | ---: | --- |
| `DEFAULT_INFERENCE_CONCURRENCY` | `10` | n/a | Launch sheet initial inference request. |
| `DEFAULT_EVALUATION_CONCURRENCY` | `24` | n/a | Launch sheet initial evaluation request and BFF fallback. |
| `MAX_INFERENCE_CONCURRENCY` | `128` | n/a | Launch sheet slider maximum. Backend still clamps. |
| `MAX_EVALUATION_CONCURRENCY` | `128` | n/a | Launch sheet evaluation slider maximum. Backend/evaluator also clamp to 128. |
| `BENCHMARK_DEFAULT_CONCURRENCY` | `10` | `10` | BFF fallback requested inference concurrency when the request omits or passes an invalid value. |
| `BENCHMARK_MAX_ACTIVE_INFERENCE_INSTANCES` | `56` | `72` | Global active inference cap across benchmark resource leases. |
| `BENCHMARK_AGENT_WORKFLOW_MAX_ACTIVE_TURNS` | unset | `72` | Global Dapr agent child-workflow cap used by capacity estimates and `dapr_workflow_slot` leases. |
| `BENCHMARK_MAX_ACTIVE_AGENT_WORKFLOWS` | unset | unset | Backward-compatible alias for `BENCHMARK_AGENT_WORKFLOW_MAX_ACTIVE_TURNS`. |
| `BENCHMARK_MAX_ACTIVE_SANDBOXES` | unset | `80` | Configured OpenShell sandbox cap. Per-run admission also considers remaining live schedulable headroom; stored global lease capacity should use configured cap plus total schedulable capacity. |
| `BENCHMARK_MODEL_MAX_ACTIVE_REQUESTS` | unset | unset | Optional per-model request cap for `model_slot` leases. |
| `BENCHMARK_MAX_ACTIVE_MODEL_REQUESTS` | unset | unset | Backward-compatible alias for `BENCHMARK_MODEL_MAX_ACTIVE_REQUESTS`. |
| `BENCHMARK_RESOURCE_LEASE_SECONDS` | `max(900, timeoutSeconds + 900)` | unset | Resource lease TTL. Not a throughput cap, but too-long leases can hold capacity after failures. |
| `BENCHMARK_LEASE_RETRY_SECONDS` | `15` | unset | Retry-after returned when the BFF resource-lease gate denies capacity. |
| `BENCHMARK_INFERENCE_STALL_SECONDS` | `480` | `480` | Marks stale inference progress; not a dispatch cap. |
| `BENCHMARK_EXECUTION_BACKEND` | `host` | unset | Host sandbox execution API is the default SWE-bench inference path. `legacy-dapr` is accepted only for rollback tests. |
| `BENCHMARK_EXECUTION_CLASS` | `benchmark-fast` | unset | Host backend execution class; supported initial values are `benchmark-fast` and `secure-gvisor`. |
| `SANDBOX_EXECUTION_API_URL` / `HOST_EXECUTION_API_URL` | unset | unset | Host execution API base URL required by the host backend. |
| `SANDBOX_EXECUTION_API_TOKEN` / `HOST_EXECUTION_API_TOKEN` | `INTERNAL_API_TOKEN` fallback | unset | Bearer token used by the BFF when calling the host execution API. |

Sandbox headroom is sampled by `src/lib/server/benchmarks/sandbox-capacity.ts`:

| Variable | Default | Effect |
| --- | ---: | --- |
| `BENCHMARK_SANDBOX_CAPACITY_DISABLED` | false | Disables live schedulable sandbox capacity if set to `1`, `true`, or `yes`. |
| `BENCHMARK_SANDBOX_CAPACITY_NAMESPACE` | `OPENSHELL_NAMESPACE` or `openshell` | Namespace used when pod listing falls back from all namespaces. |
| `BENCHMARK_SANDBOX_REQUEST_CPU` | `100m` | Per-sandbox request used to estimate schedulable slots when pod requests are unavailable. |
| `BENCHMARK_SANDBOX_REQUEST_MEMORY` | `256Mi` | Per-sandbox request used to estimate schedulable slots when pod requests are unavailable. |
| `OPENSHELL_NAMESPACE` | `openshell` | Fallback namespace for sandbox capacity sampling. |

### Agent Runtime Capacity

These control the runtime-side dimensions that benchmark admission consumes.
The BFF route resolver lives in `src/lib/server/agents/runtime-routing.ts`; the
controller status calculation lives in `services/agent-runtime-controller/src/main.py`.

| Variable or config field | Default | Dev GitOps value | Effect |
| --- | ---: | ---: | --- |
| `AGENT_RUNTIME_POOL_MAX_REPLICAS` | `2` | `9` | Shared-pool replica fallback when a pool config omits `maxReplicas`. |
| `AGENT_RUNTIME_POOL_MIN_REPLICAS` | unset | unset | Shared-pool minimum replica metadata when configured. |
| `AGENT_RUNTIME_POOL_APP_IDS_JSON` | unset | `{"coding":{"appId":"agent-runtime-pool-coding","maxReplicas":9,"slotsPerReplica":8}}` | Maps runtime classes to shared pool app IDs and optional pool capacity. Explicit `slotsPerReplica` here wins for that shared pool. Dev coding pool capacity is `9 * 8 = 72` runtime slots. |
| `AGENT_RUNTIME_SLOTS_PER_REPLICA_JSON` | `{"coding":5,"office":2,"browser":1,"testing":2}` | `{"coding":12,"office":2,"browser":1,"testing":2}` | Slots-per-replica fallback by runtime class. For dev, dedicated coding runtimes use `12`; the shared coding pool still uses the explicit pool value `8`. |
| `AGENT_RUNTIME_DAPR_WORKFLOW_LIMIT_PER_SIDECAR` | `slotsPerReplica` | `12` | Per-sidecar Dapr workflow invocation capacity used by BFF capacity estimates and controller status. |
| `DAPR_WORKFLOW_MAX_CONCURRENT_WORKFLOW_INVOCATIONS` | unset | unset | BFF capacity-estimate override checked before `AGENT_RUNTIME_DAPR_WORKFLOW_LIMIT_PER_SIDECAR`; use carefully because controller status reads the `AGENT_RUNTIME_*` value. |
| agent `runtimePool.maxActiveSessions` | unset | unset | Explicit per-agent or pool active-session cap when present in agent config. |
| agent runtime lifecycle `slotsPerReplica` | runtime-class fallback | varies | `AgentRuntime.spec.lifecycle.slotsPerReplica`; controller reports this in status and BFF uses it when routing metadata includes it. |
| agent runtime lifecycle `daprWorkflowLimitPerSidecar` / `maxConcurrentWorkflowInvocations` | `AGENT_RUNTIME_DAPR_WORKFLOW_LIMIT_PER_SIDECAR` or slots | varies | Per-AgentRuntime override for Dapr child-workflow capacity. |

### SWE-bench Coordinator

These live in `services/swebench-coordinator/src/concurrency.py` and
`services/swebench-coordinator/src/app.py`.

| Variable | Default | Dev GitOps value | Effect |
| --- | ---: | ---: | --- |
| `SWEBENCH_COORDINATOR_MAX_INFERENCE_CONCURRENCY` | `56` | `72` | Coordinator-side backstop for active `swebench_instance_workflow` children. |
| `SWEBENCH_COORDINATOR_INSTANCE_START_BATCH_SIZE` | `10` | `18` | Max new instance child workflows to start before an optional pacing delay. |
| `SWEBENCH_COORDINATOR_INSTANCE_START_BATCH_DELAY_SECONDS` | `5` | `1` | Delay between start batches. `0` disables pacing delay. |
| `SWEBENCH_LEASE_RETRY_SECONDS` | `15` | `15` | Coordinator sleep interval when a resource lease is denied. |
| `SWEBENCH_EVAL_MAX_PARALLEL` | `24` | `24` | Evaluation TaskRun batch size passed to the evaluator Job. Clamped to `1..128`. |
| `SWEBENCH_MAX_WORKERS` | `24` via evaluator fallback | unset | Backward-compatible alias used only when `SWEBENCH_EVAL_MAX_PARALLEL` is absent. |

### SWE-bench Evaluator

These live in `services/swebench-evaluator/entrypoint.py`.

| Variable | Default | Maximum | Effect |
| --- | ---: | ---: | --- |
| `SWEBENCH_EVAL_MAX_PARALLEL` | `24` | `128` | Number of per-instance Tekton TaskRuns active during official grading. |
| `SWEBENCH_MAX_WORKERS` | `24` | `128` | Backward-compatible alias used only when `SWEBENCH_EVAL_MAX_PARALLEL` is absent. |

The evaluator dispatches per-instance TaskRuns with a sliding window. It keeps
up to `SWEBENCH_EVAL_MAX_PARALLEL` TaskRuns active and starts the next instance
as soon as any active TaskRun finishes. Evaluator leases are released per
completed TaskRun, not at the end of a fixed batch.

## Current Dev Ramp Profile

Dev currently runs the 72-slot inference profile:

- `AGENT_RUNTIME_POOL_MAX_REPLICAS=9`
- coding pool `maxReplicas=9`
- coding pool `slotsPerReplica=8`
- `BENCHMARK_AGENT_WORKFLOW_MAX_ACTIVE_TURNS=72`
- `BENCHMARK_MAX_ACTIVE_INFERENCE_INSTANCES=72`
- `SWEBENCH_COORDINATOR_MAX_INFERENCE_CONCURRENCY=72`
- `BENCHMARK_MAX_ACTIVE_SANDBOXES=80`
- `SWEBENCH_COORDINATOR_INSTANCE_START_BATCH_SIZE=18`
- `SWEBENCH_COORDINATOR_INSTANCE_START_BATCH_DELAY_SECONDS=1`

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

For the current dev deployment, the practical inference ceiling is:

```text
min(
  72 runtime slots,
  108 Dapr workflow effective capacity,
  80 configured OpenShell sandbox slots,
  108 live schedulable sandbox slots,
  72 global inference slots,
  72 global agent workflow slots,
  selected instance count,
  requested concurrency
) = 72
```

The worker pool has more physical headroom than 72. Raising above 72 requires
changing the runtime pool and global caps together, then rerunning capacity
diagnostics. A plausible next infrastructure ceiling is `80`, because
`BENCHMARK_MAX_ACTIVE_SANDBOXES=80` is the next configured limiter. Going past
`80` requires increasing the sandbox cap and validating nodefs/disk-pressure
behavior under load.

Because the 24-run had 8 stalled inferences that held slots until the
`BENCHMARK_INFERENCE_STALL_SECONDS=480` detector fired, extrapolate wall-clock
from the slow tail, not only from successful inference medians. At 72
concurrent instances, expect a single inference wave to last about as long as
the slowest timeout tail if provider behavior is similar.

### OpenAI-Parity Evaluation Coordinator

This is separate from official SWE-bench Benchmarks. It lives in
`services/evaluation-coordinator/src/app.py`.

| Variable | Default | Dev GitOps value | Effect |
| --- | ---: | ---: | --- |
| `EVALUATION_MAX_CONCURRENCY` | `32` | `32` | Upper bound for `executionConfig.concurrency` across evaluation item child workflows. |

### Internal Constants

These are code constants, not environment variables.

| Constant | Value | Effect |
| --- | ---: | --- |
| `BENCHMARK_TERMINATION_CONCURRENCY` | `8` | BFF-side parallelism when terminating sessions, turns, or workflows during cancellation/cleanup. |
| `BENCHMARK_SANDBOX_CLEANUP_CONCURRENCY` | `8` | BFF-side parallelism for benchmark sandbox cleanup. |

### Provider Rate-Limit Retry Knobs

These are not concurrency caps. They only control retry behavior after provider
rate limits.

| Provider | Variables | Default in code | Dev GitOps value |
| --- | --- | ---: | ---: |
| DeepSeek | `DEEPSEEK_RATE_LIMIT_MAX_RETRIES`, `DEEPSEEK_RATE_LIMIT_BACKOFF_SECONDS` | `3`, `65` | `3`, `65` |
| Together | `TOGETHER_RATE_LIMIT_MAX_RETRIES`, `TOGETHER_RATE_LIMIT_BACKOFF_SECONDS` | `3`, `65` | `3`, `65` |
| Azure AI Foundry | `AZURE_AI_FOUNDRY_RATE_LIMIT_MAX_RETRIES`, `AZURE_AI_FOUNDRY_RATE_LIMIT_BACKOFF_SECONDS` | `3`, `65` | `3`, `65` |

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
