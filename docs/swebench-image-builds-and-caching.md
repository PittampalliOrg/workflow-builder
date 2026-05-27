# SWE-bench Image Builds And Caching

This note captures the current image-build model for SWE-bench inference
environments and the follow-up work needed to improve build coverage and speed.
It complements `docs/swebench-concurrency.md`, which covers launch-time
capacity decisions.

## Invariants

SWE-bench inference images are exact environment artifacts, not generic
repo/version cache entries. A benchmark instance is launch-ready only when the
resolved image matches the current environment specification:

- suite and dataset;
- instance repo, version, and base commit;
- generated SWE-bench harness spec;
- computed `envSpecHash`;
- digest-pinned sandbox image;
- validation status.

The durable cache key is `envSpecHash`. Coarser keys such as repo/version/base
commit are useful for grouping and cache locality, but they are not safe launch
keys because the generated environment spec can change without those fields
changing.

## Build Flow

The normal dynamic build flow is hub-owned:

1. Workflow-builder computes `buildSwebenchEnvironmentSpec()` for each selected
   instance.
2. If no exact validated image exists, preflight submits a hub Tekton
   `swe-env-<envSpecHash-prefix>` PipelineRun when
   `SWEBENCH_INFERENCE_BUILD_SUBMISSION_MODE=hub` is configured.
3. Hub builds and validates the image, then records the result in
   `environment_image_builds`.
4. The exact-ready mapping is exposed back to dev through the inference
   environment ConfigMap mounted at `SWEBENCH_INFERENCE_ENVIRONMENTS_DIR`.
5. Benchmark launch selection admits only instances whose current spec resolves
   to a validated mapping.

Dev benchmark workers should not build these images. If a dev run sits queued
while a hub `swe-env-*` PipelineRun is active, the run is waiting for
environment validation, not for dev inference capacity.

The supported production path is the organic harness-generated image path. A
2026-05-27 experiment with Epoch/prebuilt SWE-bench images failed before agent
work in OpenShell sandbox readiness/workspace profile. Treat those rows and
PipelineRuns as stale experimental data unless a new compatibility canary proves
the full path: sandbox readiness, workspace profile, session creation, LLM/tool
activity, evaluator harness, cleanup, and released leases.

## Cache Layers

There are three practical cache layers:

- **Exact-ready DB rows**: `environment_image_builds.env_spec_hash` is the
  authoritative dynamic cache. Rows with validated status and digest-pinned
  images are safe to reuse.
- **Static ConfigMap pins**: these make launch selection fast, but they should
  be treated as exact-ready only when their `envSpecHash` matches the current
  generated spec.
- **Hub Buildah cache shards**: `SWEBENCH_INFERENCE_BUILD_CACHE_SHARDS` and
  `SWEBENCH_INFERENCE_BUILD_CACHE_SHARD_NODES` spread cache affinity across hub
  nodes. This improves repeated repo/version builds without concentrating all
  cache traffic on one node.
- **Hub Nix/Cachix backend**: `SWEBENCH_INFERENCE_BUILD_BACKEND=nix` or a
  per-instance `buildBackend: "nix"` override routes exact SWE-bench harness
  specs to `swebench-inference-image-build-nix`. Nix builds publish a separate
  `env-<hash>-nix` tag, push the closure to Cachix, and avoid Buildah cache PVC
  node affinity. The backend is intentionally parallel to Buildah during rollout
  and does not change `envSpecHash`.

Build concurrency is separately capped by
`SWEBENCH_INFERENCE_BUILD_MAX_ACTIVE`. Keep this cap conservative enough that
hub image builds do not starve GitOps or release-image pipelines.

When reusing an existing hub `swe-env-*` PipelineRun, verify the source/strategy
matches the current build lane. Stale experimental PipelineRuns can collide on
the same env-hash prefix. If the PipelineRun params or DB row mention
`epoch-research`, `prebuiltImage`, or `swe-bench.eval`, delete the stale
experimental data before submitting organic builds for that instance.

## Runtime Pull Caching

Image build capacity and benchmark runtime capacity are related but separate
limits. After an environment is exact-ready, dev still has to pull the
digest-pinned sandbox image onto the node that admits the OpenShell sandbox.
Large distinct cohorts therefore benefit from spreading instances across
repo/version groups that already have image locality on the dev worker pool.

Current runtime rules:

- SWE-bench environment images are immutable digest refs and should use normal
  node image cache reuse. Re-pulling is not needed unless the digest changes.
- Agent-host images are mutable `git-<sha>` tags during active development, so
  sandbox-execution forces fresh pulls for mutable refs and caches immutable
  digest refs.
- Exact-ready selection is the admission contract. Do not use duplicate
  repeated instances as a substitute for missing coverage when measuring real
  SWE-bench capacity.
- For capacity-only canaries, `maxTurns=25` is enough to exercise sandbox
  startup, Dapr workflow scheduling, tool activity traffic, and evaluator
  handoff without letting unsolved instances dominate wall-clock time.

When a run appears slow, separate these cases before changing concurrency:

- image not exact-ready yet: hub Tekton build/validation/pin path;
- image exact-ready but cold on dev node: node pull/cache locality;
- sandbox image ready but repository checkout slow: `checkout_repo` workflow
  node timing and OpenShell logs. This is pre-agent work; changing the prompt or
  max-turn budget will not help because the agent has not started yet;
- sandbox pod admitted but slow to ready: OpenShell workspace/profile or node
  pressure;
- agent host admitted but slow to first tool: Dapr workflow/app readiness or
  agent runtime behavior.

## Current Capacity Checkpoint

As of the 2026-05-27 ryzen/dev parity checkpoint, the launch preview reported
161 exact-ready SWE-bench_Verified instances out of 500. That is enough for
distinct small and medium infrastructure canaries, but it is not enough for a
true distinct 200-concurrent SWE-bench_Verified run. The 200-run blocker is
therefore split:

- build coverage must reach at least 200 exact-ready, current-`envSpecHash`
  mappings;
- runtime capacity still needs staged proof at the current exact-ready sizes;
- launch selection must remain distinct-instance and exact-ready, not repeated
  duplicate load.

The 25-way and 50-way post-reset canaries showed all selected instances
exact-ready, admitted, and able to reach first tool without Dapr workflow,
lease, sandbox admission, or evaluator setup failures. The 50-way
infrastructure checkpoint used 50 distinct exact-ready instances with
`maxTurns=50`; Kueue initially admitted 48 and admitted the final 2 as earlier
instances completed. All 50 reached first tool, then the run was intentionally
cancelled and cleanup returned active runs, leases, Dapr workflow state, Kueue
workloads, and OpenShell pods to zero.

The same 50-way run showed why checkout observability matters. Median
`repo_checkout_ms` was about 5.4s and p95 about 6.3s, but one Django instance
spent about 355s in the actual Git fetch/checkout path. That outlier delayed
agent start but was not an agent-loop, statestore, or max-turn issue. Future
checkout improvements should prefer prebuilt worktrees or a repo mirror/object
cache for high-fanout repos, and should add trace-linked checkout events so a
slow GitHub fetch is visible beside the agent trace instead of only in
workflow logs and DB timings.

For approximate memory trend data, capture peak pod/container memory during
canaries and group it by SWE-bench repo/version and sandbox image digest. This
does not need exact per-process accounting for now; `kubectl top pod
--containers`, metrics-server snapshots, and benchmark run timestamps are
enough to estimate whether a repo/version group is near the Kueue memory
request or materially below it. Use that data to tune Kueue requests and
runtime admission before assuming the cluster can run all 500 instances at
once.

As of the 2026-05-27 image-coverage campaign, the organic builder was restarted
after deleting stale Epoch/prebuilt rows. Fresh organic Django images for
`django__django-14376` and `django__django-14404` validated on hub, then a
personal-user canary run `r30r9I76rLiwv-BGz9VL5` launched those exact images at
concurrency 2 and `maxTurns=5`. Both instances reached LLM/tool activity and
evaluation with zero infra/image/sandbox errors; both were unresolved as
expected for a short compatibility canary. This is the template for validating
new image batches before relying on them for a larger capacity run.

Ryzen can consume the same validated organic SWE-bench inference images because
the benchmark selector resolves digest-pinned GHCR image refs from the same
exact-ready metadata. The ryzen 3-instance canary `MPIlRkKWC7UdvHgwFQEiR`
selected three existing exact-ready organic Astropy images, ran effective
concurrency 2 after the full-instance capacity fix, reached LLM/tool activity
for all three instances, evaluated successfully, and released all leases. That
validates image compatibility on ryzen separately from the hub build campaign.

## Failure Classification

Classify failures by phase before rebuilding:

- **spec/metadata**: missing repo, base commit, version, or unsupported harness
  version;
- **dependency build**: package install, conda/pip resolution, or upstream
  dependency failure;
- **validation**: image built but SWE-bench validation command failed;
- **registry push**: image built but upload/digest publication failed;
- **pin publication**: build and validation succeeded, but writing the exact
  mapping back to Git/ConfigMap failed.

Pin publication failures should usually be retried or replayed idempotently,
not rebuilt from scratch. A 2026-05-25 Django 3.1 build reached build and
validation but failed while pushing the pin after repeated GitHub server errors;
that was not evidence that the image artifact was bad.

Capacity throttles are not image failures. If the queueing script records a
synthetic `dynamic_build_capacity_exhausted` row, classify it as a controller
throttle artifact and keep it out of real failed-build counts. The preferred
repo-owned behavior is to sleep/retry without persisting a failed build row.

## Operator Commands

Queue a dry-run build audit:

```bash
kubectl --context dev -n workflow-builder exec deploy/workflow-builder -c workflow-builder -- \
  node /app/scripts/queue-swebench-environment-validation.bundle.js \
  --suite SWE-bench_Verified \
  --limit 100 \
  --exact-for-random-runs
```

Submit builds until enough exact-ready or building entries exist:

```bash
kubectl --context dev -n workflow-builder exec deploy/workflow-builder -c workflow-builder -- \
  node /app/scripts/queue-swebench-environment-validation.bundle.js \
  --suite SWE-bench_Verified \
  --limit 200 \
  --target-validated 120 \
  --exact-for-random-runs \
  --apply
```

Check exact-ready coverage directly:

```sql
select suite, repo, environment_key, status, validation_status, count(*)
from environment_image_builds
group by suite, repo, environment_key, status, validation_status
order by suite, repo, environment_key;
```

Check active hub builds from the hub cluster:

```bash
kubectl --context hub -n tekton-pipelines get pipelineruns | grep '^swe-env-'
```

Delete abandoned Epoch/prebuilt experiment PipelineRuns from hub:

```bash
kubectl --context hub -n tekton-pipelines get pipelineruns -o json |
  jq -r '.items[]
    | select((.metadata.name | startswith("swe-env-"))
      and ((.spec.params // []) | tostring | test("epoch-research|prebuiltImage|swe-bench.eval")))
    | .metadata.name' |
  xargs -r kubectl --context hub -n tekton-pipelines delete pipelinerun
```

Delete abandoned Epoch/prebuilt DB rows from workflow-builder:

```sql
delete from environment_image_builds
where suite = 'SWE-bench_Verified'
  and (
    spec::text like '%epoch-research%'
    or spec::text like '%prebuiltImage%'
    or spec::text like '%swe-bench.eval%'
  );
```

Run the long-running organic queue controller as a Kubernetes Job on dev, but
remember that this only controls submissions; actual builds run on hub when
`SWEBENCH_INFERENCE_BUILD_SUBMISSION_MODE=hub` is configured:

```bash
node scripts/queue-swebench-environment-validation.bundle.js \
  --suite SWE-bench_Verified \
  --limit 500 \
  --target-validated 200 \
  --loop \
  --poll-seconds 300 \
  --exact-for-random-runs \
  --api-url http://workflow-builder.workflow-builder.svc.cluster.local:3000 \
  --apply
```

## Follow-Up Improvements

Prioritize these before using missing image coverage as a reason to lower dev
runtime capacity:

- add build-duration histograms by repo, version, and cache shard;
- expose cache-hit/miss counters per `envSpecHash` and repo/version group;
- compare Buildah shard hit rate against the Nix/Cachix backend on the same
  repo/version groups before flipping the global default;
- add a resumable pin-publication path for already validated images;
- group build failures by phase in the Benchmarks UI;
- pre-warm high-value SWE-bench_Verified repo/version cohorts before large
  capacity runs;
- record peak image-build memory and storage by repo/version so hub build
  quotas can be tuned from measured demand.
