# SWE-bench Concurrency Runbook

The SWE-bench benchmark path uses a Dapr Workflow preflight/inference split:

- `swebench_environment_preflight_workflow` prepares and validates inference images before any instance workflow starts.
- `swebench_run_workflow` admits instance child workflows through resource leases instead of scheduling all selected instances at once.
- `swebench_instance_workflow` requires a stamped, validated `inferenceEnvironment`; it must not submit environment build PipelineRuns.

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
  BENCHMARK_MAX_ACTIVE_SANDBOXES and live schedulable sandbox headroom,
  BENCHMARK_MODEL_MAX_ACTIVE_REQUESTS / BENCHMARK_MAX_ACTIVE_MODEL_REQUESTS
)
```

The live resource-lease gate re-checks the same classes before each instance
starts. If a requested concurrency is higher than the runtime or cluster can
actually admit, the run should slow down instead of over-scheduling.

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
| `BENCHMARK_MAX_ACTIVE_INFERENCE_INSTANCES` | `56` | `56` | Global active inference cap across benchmark resource leases. |
| `BENCHMARK_AGENT_WORKFLOW_MAX_ACTIVE_TURNS` | unset | `56` | Global Dapr agent child-workflow cap used by capacity estimates and `dapr_workflow_slot` leases. |
| `BENCHMARK_MAX_ACTIVE_AGENT_WORKFLOWS` | unset | unset | Backward-compatible alias for `BENCHMARK_AGENT_WORKFLOW_MAX_ACTIVE_TURNS`. |
| `BENCHMARK_MAX_ACTIVE_SANDBOXES` | unset | `60` | Configured OpenShell sandbox cap. Effective sandbox cap is the minimum of this and live schedulable headroom when available. |
| `BENCHMARK_MODEL_MAX_ACTIVE_REQUESTS` | unset | unset | Optional per-model request cap for `model_slot` leases. |
| `BENCHMARK_MAX_ACTIVE_MODEL_REQUESTS` | unset | unset | Backward-compatible alias for `BENCHMARK_MODEL_MAX_ACTIVE_REQUESTS`. |
| `BENCHMARK_RESOURCE_LEASE_SECONDS` | `max(900, timeoutSeconds + 900)` | unset | Resource lease TTL. Not a throughput cap, but too-long leases can hold capacity after failures. |
| `BENCHMARK_LEASE_RETRY_SECONDS` | `15` | unset | Retry-after returned when the BFF resource-lease gate denies capacity. |
| `BENCHMARK_INFERENCE_STALL_SECONDS` | `480` | `480` | Marks stale inference progress; not a dispatch cap. |

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
| `AGENT_RUNTIME_POOL_MAX_REPLICAS` | `2` | `7` | Shared-pool replica fallback when a pool config omits `maxReplicas`. |
| `AGENT_RUNTIME_POOL_MIN_REPLICAS` | unset | unset | Shared-pool minimum replica metadata when configured. |
| `AGENT_RUNTIME_POOL_APP_IDS_JSON` | unset | `{"coding":{"appId":"agent-runtime-pool-coding","maxReplicas":7,"slotsPerReplica":8}}` | Maps runtime classes to shared pool app IDs and optional pool capacity. Explicit `slotsPerReplica` here wins for that shared pool. |
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
| `SWEBENCH_COORDINATOR_MAX_INFERENCE_CONCURRENCY` | `56` | `56` | Coordinator-side backstop for active `swebench_instance_workflow` children. |
| `SWEBENCH_COORDINATOR_INSTANCE_START_BATCH_SIZE` | `10` | `12` | Max new instance child workflows to start before an optional pacing delay. |
| `SWEBENCH_COORDINATOR_INSTANCE_START_BATCH_DELAY_SECONDS` | `5` | `2` | Delay between start batches. `0` disables pacing delay. |
| `SWEBENCH_LEASE_RETRY_SECONDS` | `15` | `15` | Coordinator sleep interval when a resource lease is denied. |
| `SWEBENCH_EVAL_MAX_PARALLEL` | `24` | `24` | Evaluation TaskRun batch size passed to the evaluator Job. Clamped to `1..128`. |
| `SWEBENCH_MAX_WORKERS` | `24` via evaluator fallback | unset | Backward-compatible alias used only when `SWEBENCH_EVAL_MAX_PARALLEL` is absent. |

### SWE-bench Evaluator

These live in `services/swebench-evaluator/entrypoint.py`.

| Variable | Default | Maximum | Effect |
| --- | ---: | ---: | --- |
| `SWEBENCH_EVAL_MAX_PARALLEL` | `24` | `128` | Number of per-instance Tekton TaskRuns active during official grading. |
| `SWEBENCH_MAX_WORKERS` | `24` | `128` | Backward-compatible alias used only when `SWEBENCH_EVAL_MAX_PARALLEL` is absent. |

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
5. Resource leases: sandbox and model caps plus live schedulable sandbox headroom.
6. Coordinator backstop and start pacing: `SWEBENCH_COORDINATOR_*`.
7. Evaluation: `SWEBENCH_EVAL_MAX_PARALLEL` on the coordinator and evaluator.

Do not roll `workflow-builder`, `swebench-coordinator`, `workflow-orchestrator`,
or agent runtime images while benchmark workflows are mid-run. Wait for active
runs to reach terminal status, or cancel and verify durable shutdown first.
