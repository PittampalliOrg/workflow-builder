# Benchmark Statistics — Regression Detection

The compare page shows colored badges next to each metric (resolved rate, cost
per resolved, turn count, tokens, TTFT, tool calls). Those badges come from
**statistical hypothesis tests** that ask: *is the candidate run's metric
genuinely different from the baseline, or could the difference be noise?*

We treat the **first selected run as baseline**; every other run in the
comparison set is the **candidate**. Tests live in
[`src/lib/server/benchmarks/regression.ts`](../src/lib/server/benchmarks/regression.ts).

## Comparison Campaigns

The preferred way to compare agents is the Benchmarks launch sheet's
`Compare agents` mode. It creates one benchmark run per selected agent using
the same suite and exact instance ids, applies one shared campaign tag to every
run, and redirects to:

```text
/workspaces/<slug>/benchmarks/compare?runs=<runA>,<runB>[,<runC>,<runD>]&tag=<campaign-tag>
```

The compare route can also load the latest runs for a campaign directly with
`?tag=<campaign-tag>`. Use explicit `runs=` when the comparison set must be
fixed. See [`docs/swebench-mlflow-comparison.md`](./swebench-mlflow-comparison.md)
for the MLflow experiment/run/tag contract that keeps those UI comparisons
queryable outside workflow-builder.

These statistics are strongest when the campaign changes one primary axis:
agent, model, agent version, prompt/tooling, or concurrency. If multiple axes
change at once, the page still renders but the p-values should be treated as
exploratory diagnostics rather than a clean A/B result.

## Two test families

### Fisher's exact test — for binary outcomes

Used for `resolved_rate`. The 2×2 contingency table is:

|             | resolved | not resolved |
|-------------|----------|--------------|
| **baseline** | a       | b           |
| **candidate** | c     | d           |

Fisher computes the *exact* p-value from the hypergeometric distribution
(no large-N approximation). It's the right test for SWE-bench because runs
often have N=3..50 instances and chi-square breaks down at small N.

### Welch's t-test — for continuous metrics

Used for `cost_per_resolved`, `turn_count_p50`, `tokens_p50`, `ttft_p50`,
`tool_call_count_p50`. Two-sample, *unequal-variance* t-test on the per-instance
values. Welch's variant is the default because two runs may have different
spreads (e.g., a more expensive model has higher token variance).

We approximate the t-distribution CDF via the regularized incomplete beta
function (Lentz's continued fraction, Numerical Recipes §6.4) — accurate enough
for p-value display.

## What the badges mean

| Badge color | Meaning |
|------------|---------|
| 🟢 green `↑` | candidate is **significantly better** (p<0.05 + favorable direction) |
| 🔴 red `↓` | candidate is **significantly worse** (p<0.05 + adverse direction) |
| ⚪ gray `–` | no significant difference (p≥0.05) |

"Better" / "worse" depends on the metric:
- **resolved_rate**: higher is better
- **cost_per_resolved**, **turn_count**, **tokens**, **ttft**, **tool_call_count**: lower is better

## What the n= and CI annotations mean

Each cell shows the metric value plus `n=<sample size>`. The number is the
count of instances contributing to that metric (resolved-only for
`cost_per_resolved`; non-null for the rest).

When `n ≥ 5`, we attach a 95% confidence interval — Wilson score for
proportions, normal-approximation for continuous metrics. At smaller n we
suppress the CI rather than print a misleadingly tight interval.

## Caveats

1. **Multiple comparisons**: we run 6 tests per pair. With α=0.05 and 6 tests
   under a true null, you'd expect ~0.3 false positives on average. If you're
   making release decisions, treat a single significant red badge as a flag,
   not a verdict — re-run the candidate to see if the signal persists.

2. **N=1 instance runs**: Fisher's exact returns p=1 (no power). Welch's t-test
   returns p=1 for n<2. The badges will read "neutral" regardless.

3. **Cost-per-resolved is conditional**: only resolved instances contribute.
   A run with 0 resolved has no cost-per-resolved sample → the test is skipped.

4. **No multiple-testing correction (yet)**: we don't apply Bonferroni or BH
   adjustments. If you start sweeping many configurations, consider adding a
   correction at the UI layer.
