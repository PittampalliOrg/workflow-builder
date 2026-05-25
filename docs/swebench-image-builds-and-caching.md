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

Build concurrency is separately capped by
`SWEBENCH_INFERENCE_BUILD_MAX_ACTIVE`. Keep this cap conservative enough that
hub image builds do not starve GitOps or release-image pipelines.

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

## Follow-Up Improvements

Prioritize these before using missing image coverage as a reason to lower dev
runtime capacity:

- add build-duration histograms by repo, version, and cache shard;
- expose cache-hit/miss counters per `envSpecHash` and repo/version group;
- add a resumable pin-publication path for already validated images;
- group build failures by phase in the Benchmarks UI;
- pre-warm high-value SWE-bench_Verified repo/version cohorts before large
  capacity runs;
- record peak image-build memory and storage by repo/version so hub build
  quotas can be tuned from measured demand.

