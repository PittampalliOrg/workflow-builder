# SWE-bench MLflow Comparison Campaigns

This document describes the supported way to compare multiple agents or model
configurations on the same SWE-bench instances while keeping the result aligned
with workflow-builder's Benchmarks UI and MLflow.

## Mental Model

SWE-bench execution remains owned by workflow-builder, Dapr Workflows,
`swebench-coordinator`, Kueue/OpenShell sandboxes, and the official evaluator
Job. MLflow is the tracking and evaluation projection. It must make comparisons
easy to query, but it is not the execution engine and it is not the authority for
resolved/unresolved.

The MLflow hierarchy is:

```text
MLflow experiment: workflow-builder/<env>/swebench
  parent run: workflow_builder.kind=swebench_run
    child run: workflow_builder.kind=swebench_instance
    child run: workflow_builder.kind=swebench_instance
    child run: workflow_builder.kind=swebench_mlflow_eval
```

For agent comparisons, create one workflow-builder `benchmark_runs` row per
agent/configuration. Every run in the campaign must use the same suite and the
same ordered instance id set. The comparison identity is a shared benchmark tag
on each run, for example:

```text
deepseek-kimi-agent-comparison-2026-05-14
```

The tag is copied into all MLflow parent, instance, and eval runs as:

- `workflow_builder.benchmark_tags=<comma-separated-tags>`
- `workflow_builder.benchmark_tag.<normalized-tag>=true`

This makes the campaign queryable in MLflow without relying on run names.

## Launching From The UI

Use `/workspaces/<slug>/benchmarks`:

1. Select a suite and exact instances.
2. Open the launch sheet.
3. Choose `Compare agents`.
4. Select 2-4 registered `dapr-agent-py` or `adk-agent-py` agents.
5. Set a comparison campaign label.
6. Launch.

The UI creates one benchmark run per selected agent, applies the same instance
ids and campaign tag to every run, then redirects to:

```text
/workspaces/<slug>/benchmarks/compare?runs=<runA>,<runB>[,<runC>,<runD>]&tag=<campaign-tag>
```

The compare route can also expand a campaign tag directly:

```text
/workspaces/<slug>/benchmarks/compare?tag=<campaign-tag>
```

Tag expansion loads the most recent four runs with that tag. Use explicit
`runs=` when you need a fixed comparison set.

## Comparing Multiple Tests

A campaign is the unit of comparison. Keep each planned matrix together with a
stable tag and vary only the axis under test:

| Scenario | Campaign shape |
| --- | --- |
| Agent A vs Agent B | Same suite, same instances, one run per agent. |
| Same agent, different model | Same suite, same instances, one run per model/config label. |
| Same agent, different prompt/tooling | Same suite, same instances, one run per agent version or config label. |
| Repeated trials | Same suite, same instances, one campaign per trial batch, or add an explicit trial tag such as `trial-2`. |

Do not mix unrelated axes in one campaign unless that is the experiment. The
compare UI highlights changed axes, and the statistics are most meaningful when
only one major axis differs.

## MLflow Tags And Params

Parent `swebench_run` runs carry:

- `workflow_builder.kind=swebench_run`
- `workflow_builder.benchmark_run_id`
- `workflow_builder.project_id`
- `workflow_builder.env`
- `swebench.suite`
- `agent.id`, `agent.slug`, `agent.version`, `agent.runtime`
- `workflow_builder.benchmark_tags`
- `workflow_builder.benchmark_tag.<tag>=true`

Child `swebench_instance` runs carry:

- `mlflow.parentRunId=<parent-run-id>`
- `workflow_builder.kind=swebench_instance`
- `workflow_builder.benchmark_run_id`
- `workflow_builder.benchmark_run_instance_id`
- `swebench.instance_id`, `swebench.repo`, `swebench.base_commit`
- `workflow_builder.workflow_execution_id`
- `workflow_builder.primary_trace_id`
- `workflow_builder.mlflow_trace_id`
- `agent.id`, `agent.version`, `agent.runtime`
- the same campaign tag keys as the parent

Child `swebench_mlflow_eval` runs carry:

- `mlflow.parentRunId=<parent-run-id>`
- `workflow_builder.kind=swebench_mlflow_eval`
- `workflow_builder.benchmark_run_id`
- `swebench.suite`
- `agent.id`, `agent.version`, `agent.runtime`
- `model.name_or_path`
- the same campaign tag keys as the parent

The expected MLflow count for a two-agent campaign over `N` instances is:

```text
2 parent runs + (2 * N) instance child runs + 2 eval child runs
```

For example, two agents over two instances should produce eight MLflow runs.

## MLflow Query

Use the tag-specific boolean key for campaign lookup:

```text
tags.`workflow_builder.benchmark_tag.<campaign-tag>` = 'true'
```

When querying from a workflow-builder pod:

```bash
kubectl -n workflow-builder exec deploy/workflow-builder -c workflow-builder -- \
  node --input-type=module <<'NODE'
const base = process.env.MLFLOW_TRACKING_URI.replace(/\/$/, '');
const campaign = 'deepseek-kimi-agent-comparison-2026-05-14';
const body = {
  experiment_ids: ['1'],
  filter: `tags.\`workflow_builder.benchmark_tag.${campaign}\` = 'true'`,
  max_results: 100,
  order_by: ['attributes.start_time ASC']
};
const res = await fetch(`${base}/api/2.0/mlflow/runs/search`, {
  method: 'POST',
  headers: {'content-type': 'application/json'},
  body: JSON.stringify(body)
});
const json = await res.json();
console.log(JSON.stringify({
  count: json.runs?.length ?? 0,
  runs: (json.runs ?? []).map((run) => {
    const tags = Object.fromEntries((run.data.tags ?? []).map((t) => [t.key, t.value]));
    return {
      run_id: run.info.run_id,
      status: run.info.status,
      kind: tags['workflow_builder.kind'],
      parent: tags['mlflow.parentRunId'],
      agent: tags['agent.id'],
      benchmarkRunId: tags['workflow_builder.benchmark_run_id'],
      instance: tags['swebench.instance_id']
    };
  })
}, null, 2));
NODE
```

## Interpreting Results

The official SWE-bench harness result stored in `benchmark_run_instances` is the
source of truth for `resolved`, `unresolved`, and `empty_patch`. MLflow eval
metrics and trace-linked scorers enrich the run and make cross-run comparisons
easier, but they do not replace the official harness outcome.

Useful comparison checks:

- every run in the campaign has identical `selected_instance_ids`;
- the compare page shows only the intended differing axis;
- the MLflow campaign query returns the expected parent, instance, and eval
  child runs;
- instance child runs have `mlflow.parentRunId`;
- eval child runs have `swebench_harness_resolved/mean` and patch-quality
  metrics;
- traces listed in the run summary are linked to the parent and eval run where
  available.

## Live Canary Pattern

For a small operator canary after changing comparison UI or MLflow wiring:

1. Pick two validated instances from the same suite.
2. Launch `Compare agents` with two agents and `concurrency=1`.
3. Wait for both runs to reach terminal status.
4. Verify the compare page, DB summary, and MLflow campaign query.
5. Check no benchmark pods remain for the run IDs after cleanup.

The 2026-05-14 dev canary used:

- DeepSeek Pro agent: `agnt_deepseek_v4_pro_swe_smoke`
- Kimi agent: `agnt_kimi_k26_swe_canary`
- instances: `astropy__astropy-12907`, `astropy__astropy-13033`
- campaign: `deepseek-kimi-agent-comparison-2026-05-14`

Both agents completed and produced the expected MLflow hierarchy. Neither
resolved the two selected instances; DeepSeek produced well-formed patches for
both, while Kimi produced one well-formed patch and one empty patch due to the
turn limit. That canary validated the comparison architecture, not model quality.
