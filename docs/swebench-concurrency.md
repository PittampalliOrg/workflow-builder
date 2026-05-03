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

## Rollout Rules

Do not roll `workflow-builder`, `swebench-coordinator`, `workflow-orchestrator`, or agent runtime pool images during an active SWE-bench benchmark run. Dapr replay/versioning is safest when old workflow registrations remain available until all in-flight instances complete.

Before a dev rollout, terminate or purge only terminal stale workflow instances. Do not force-purge active benchmark workflows or active resource leases.

## Capacity Model

Effective agent runtime workflow capacity is:

```text
runtime replicas * per-sidecar Dapr workflow invocation limit
```

The run admission path also leases global inference slots, OpenShell sandbox slots, agent runtime slots, Dapr workflow slots, and model request slots. Increasing only the UI concurrency value will not increase throughput unless these backing capacities are also raised.
