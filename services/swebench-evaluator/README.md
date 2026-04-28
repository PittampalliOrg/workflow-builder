# SWE-bench Evaluator

This image is the grading authority for workflow-builder SWE-bench Benchmark runs.
The coordinator writes an official predictions JSONL artifact with exactly
`instance_id`, `model_name_or_path`, and `model_patch`, then this job runs
`python -m swebench.harness.run_evaluation` inside a Docker-in-Docker pod.

## SWE-bench Pin

`Dockerfile` installs the PittampalliOrg SWE-bench fork at:

- Fork commit: `6b32ec7dc48358aa7a6e3f8e12e9c72e5647e3cd`
- Upstream base: `f7bbbb2ccdf479001d6467c9e34af59e44a840f9`

The fork delta from upstream base is intentionally limited to:

- `swebench/harness/dapr_native.py` and `docs/guides/dapr_native_evaluation.md`
- `run_evaluation --report_dir` plumbing and report JSON path handling
- packaged harness fixture data needed by evaluator image tests

Re-check with:

```bash
git fetch https://github.com/swe-bench/SWE-bench.git main
git diff --stat FETCH_HEAD...6b32ec7dc48358aa7a6e3f8e12e9c72e5647e3cd
```
