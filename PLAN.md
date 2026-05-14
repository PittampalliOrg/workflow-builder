# MLflow-Native Agent Lifecycle for Dapr Workflows

## Summary

Use this `/goal` objective:

```text
/goal Complete the MLflow-native agent lifecycle integration for workflow-builder without stopping until Dapr workflow executions, Dapr agent runs, SWE-bench evaluations, and normal workflow runs are linked through MLflow versions, runs, traces, datasets, and evaluation results; the implementation is validated by targeted tests plus a live multi-agent workflow canary that shows parent workflow run, child agent runs, linked traces, version lineage, and eval artifacts in MLflow.
```

The target architecture is: Dapr remains the durable execution engine; MLflow becomes the lifecycle and quality system for agent/workflow versions, traces, datasets, scorers, evaluations, and promotion decisions. MLflow writes must happen in replay-safe Dapr activities or BFF/runtime side effects, never as non-deterministic workflow-body I/O.

Official docs grounding:

- MLflow LoggedModel/version tracking links application versions to traces and evaluation runs via `mlflow.set_active_model()` and model params.
- MLflow Prompt Registry versions prompts and links prompt lineage to tracing/evaluation.
- `mlflow.genai.evaluate(data=traces)` supports trace-based scoring, built-in/custom scorers, datasets, and eval runs.
- Dapr Workflow requires deterministic workflow code; external state/network calls belong in activities.
- Dapr child workflows are the right boundary for large/multi-agent workflows, and Dapr Agents use DurableAgent/workflows for routed agent calls.

Sources:

- [MLflow version tracking](https://www.mlflow.org/docs/latest/genai/version-tracking/track-application-versions-with-mlflow/)
- [MLflow Prompt Registry](https://www.mlflow.org/docs/latest/genai/prompt-registry/)
- [MLflow trace evaluation](https://www.mlflow.org/docs/latest/genai/eval-monitor/running-evaluation/traces/)
- [MLflow GenAI API](https://mlflow.org/docs/latest/api_reference/python_api/mlflow.genai.html)
- [Dapr Workflow concepts](https://docs.dapr.io/developing-applications/building-blocks/workflow/workflow-features-concepts/)
- [Dapr Agents concepts](https://docs.dapr.io/developing-ai/dapr-agents/dapr-agents-core-concepts/)

## Key Changes

- Add a general MLflow lineage layer while keeping existing direct benchmark columns:
  - Add `mlflow_lineage_links` for local entity to MLflow entity mapping: `agent_version`, `workflow_version`, `workflow_execution`, `workflow_node_run`, `session`, `agent_run`, `benchmark_run`, `evaluation_run`, `dataset`, `trace_proxy`.
  - Store MLflow experiment ID, run ID, trace ID, dataset ID, logged model ID/URI, prompt URI, public URL, local entity ID, entity type, tags, and timestamps.
  - Keep current `agent_versions.*`, `benchmark_runs.*`, and `benchmark_run_instances.*` MLflow fields as hot-path denormalized columns.

- Adopt MLflow versioning for agents and workflow specs:
  - On agent publish/version creation, create or resolve an MLflow LoggedModel named from workspace, agent slug, version/hash, and environment.
  - Log model params for model provider, model name, temperature, tools, MCP config hash, system prompt hash, workflow/runtime isolation, Dapr app ID, Git commit, and workflow-builder agent version ID.
  - Register prompt templates in MLflow Prompt Registry when the agent has editable prompts; store prompt URI/version on the local agent version and lineage link.
  - For inline `durable/run` agent configs, create an ephemeral LoggedModel keyed by deterministic config hash so evals and traces still attach to a version.

- Represent workflow executions in MLflow as a run hierarchy:
  - Create one parent MLflow run per `workflow_executions` row in `workflow-builder/<env>/workflows`.
  - Create child MLflow runs for each `durable/run` agent invocation or Dapr session child workflow.
  - Use MLflow traces/spans for LLM calls, tool calls, node execution, Dapr workflow events, and artifacts; do not create runs for every tool call.
  - Tag every MLflow run and trace with `workflow_builder.workflow_id`, `workflow_builder.workflow_execution_id`, `workflow_builder.workflow_version_hash`, `workflow_builder.node_id`, `workflow_builder.session_id`, `agent.id`, `agent.version_id`, `agent.slug`, `dapr.instance_id`, `dapr.app_id`, and `mlflow.modelId` when available.

- Integrate at Dapr-safe boundaries:
  - Add idempotent workflow-orchestrator activities for `ensure_mlflow_workflow_run`, `ensure_mlflow_child_run`, `link_mlflow_trace_to_run`, and `finalize_mlflow_workflow_run`.
  - Pass MLflow context through existing `durable/run` child input: parent run ID, experiment ID, workflow trace ID, active model ID/URI, prompt URI, workflow execution ID, and node ID.
  - Keep terminal trace finalization in the existing activity/finalizer pattern; no network calls, UUID generation, env reads, or MLflow SDK calls inside replayed workflow code.
  - Version any workflow-history-shaping additions behind a new workflow version/gate so in-flight Dapr histories are not broken.

- Upgrade Dapr agent telemetry to MLflow-native lifecycle data:
  - In `dapr-agent-py`, set active MLflow model context before LLM/tool execution when model ID is provided.
  - Stamp existing `AGENT`, `CHAT_MODEL`, and `TOOL` spans with agent version, workflow execution, Dapr child workflow, session, MCP server/tool, sandbox, and token/cost metadata.
  - For agent-to-agent calls, preserve parent workflow/run context and mark the target `DurableAgent` invocation as a child run plus child trace/span.
  - Keep OpenTelemetry export as the transport; use MLflow SDK/REST only for version, run, dataset, evaluation, and artifact lifecycle calls.

- Make MLflow the evaluation and improvement loop:
  - Mirror workflow-builder eval datasets and SWE-bench rows into MLflow GenAI datasets.
  - Use `mlflow.genai.evaluate()` for SWE-bench post-hoc trace eval and for general workflow/agent evals.
  - Keep official SWE-bench harness pass/fail authoritative; MLflow scorers remain analytics and promotion signals.
  - Preserve row context for trace evals by mapping `trace_id -> local eval row`; scorers must read original local `inputs`, `outputs`, and `expectations` when MLflow trace-derived fields are incomplete.
  - Add reusable scorers for trace health, tool trajectory, harness result, patch/result quality, mutation/efficiency, regression gates, and workflow-specific assertions.

- Update product surfaces around MLflow concepts:
  - Agent version page: show MLflow LoggedModel, prompt version, linked traces, eval scorecards, promotion status, and compare-to-prior-version.
  - Workflow execution page: show parent MLflow run, child agent runs, trace timeline, linked artifacts, Dapr instance IDs, and eval results.
  - Benchmarks page: keep existing UI but add MLflow dataset/eval run links, scorer outputs, trace linkage health, and missing-link diagnostics.
  - Add an Improve path that turns failed traces/eval rows into a dataset slice, creates a candidate agent/prompt version, runs eval comparison, and records promotion decision.

- Fix trace-to-evaluation linkage explicitly:
  - Evaluation runs must log or proxy the traces they evaluate into the same MLflow experiment context when required by the MLflow UI.
  - The eval artifact must include `evaluated_trace_ids`, `missing_trace_ids`, `local_row_ids`, scorer summaries, and links to parent/child run IDs.
  - If MLflow UI cannot render JSONL natively in this deployment, log a JSON mirror and a compact HTML/Markdown preview artifact next to the JSONL; keep JSONL as the canonical machine-readable artifact.

## Test Plan

- Unit and integration tests:
  - BFF tests for agent publish/version MLflow linkage and best-effort failure handling.
  - Workflow-orchestrator tests proving MLflow side effects are activity-only, idempotent, and replay-safe.
  - `dapr-agent-py` telemetry tests for active model linkage, parent/child run context, span tags, and agent-to-agent calls.
  - Coordinator tests for trace experiment lookup, `locations` trace search, trace-to-row scorer context, missing trace mapping, and eval-run trace linkage.
  - DB migration tests for `mlflow_lineage_links` uniqueness and backward-compatible benchmark columns.

- Targeted commands:
  - `pnpm vitest run src/lib/server/benchmarks/mlflow.test.ts src/lib/server/benchmarks/trace-bundle.test.ts --reporter=dot`
  - `python -m py_compile services/workflow-orchestrator/workflows/sw_workflow.py services/dapr-agent-py/src/main.py services/swebench-coordinator/src/app.py`
  - `MLFLOW_ENABLED=true python -m pytest services/swebench-coordinator/tests/test_evaluation_lifecycle.py services/dapr-agent-py/tests/test_telemetry.py -q`

- Live canary:
  - Run a workflow with at least two `durable/run` nodes using different agent versions.
  - Verify one parent MLflow workflow run, two child agent runs, linked traces, active model IDs, prompt URIs, Dapr instance IDs, and artifacts.
  - Run one eval over those traces and verify the eval run links back to the traces in MLflow UI.
  - Run a one-instance SWE-bench canary and verify parent run, child run, trace ID, dataset ID, eval run ID, and DB persistence.
  - Confirm workflow-builder UI still uses official harness result as authoritative while exposing MLflow analytics.

## Assumptions

- MLflow failures stay best-effort for runtime execution and benchmark inference; only schema/setup validation can block rollout.
- Dapr Workflow remains the durable execution authority; MLflow does not replace Dapr state, replay, retry, child workflow, or cancellation behavior.
- Existing `workflow-builder/<env>/traces` and `workflow-builder/<env>/swebench` experiments remain; add `workflow-builder/<env>/workflows` for normal workflow and agent lifecycle.
- Use MLflow SDK in Python services where available; use REST wrappers from TypeScript BFF/runtime code.
- Keep ClickHouse/raw OTel fallback until MLflow trace search, artifacts, and UI links are proven across dev canaries.
