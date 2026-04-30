<script lang="ts">
	import { Badge } from '$lib/components/ui/badge';
	import { TrendingUp, TrendingDown, Minus } from '@lucide/svelte';
	import type { RegressionTest, RegressionMetric } from '$lib/server/benchmarks/regression';
	import type { RunConfigSummary } from '$lib/server/benchmarks/comparison';

	type Props = {
		// Outer index = candidate run (vs runs[0] baseline). Inner array = one
		// RegressionTest per metric. Length = runs.length - 1.
		regression: RegressionTest[][];
		runs: RunConfigSummary[];
	};

	const { regression, runs }: Props = $props();

	const METRIC_LABELS: Record<RegressionMetric, string> = {
		resolved_rate: 'Resolved rate',
		cost_per_resolved: 'Cost / resolved',
		turn_count_p50: 'Turn count P50',
		tokens_p50: 'Tokens P50',
		ttft_p50: 'TTFT P50',
		tool_call_count_p50: 'Tool calls P50'
	};

	function fmtMean(metric: RegressionMetric, value: number): string {
		if (!Number.isFinite(value)) return '—';
		switch (metric) {
			case 'resolved_rate':
				return `${(value * 100).toFixed(0)}%`;
			case 'cost_per_resolved':
				return `$${value.toFixed(2)}`;
			case 'turn_count_p50':
			case 'tool_call_count_p50':
				return value.toFixed(0);
			case 'tokens_p50':
				return value >= 1000 ? `${(value / 1000).toFixed(1)}k` : value.toFixed(0);
			case 'ttft_p50':
				return value >= 1000 ? `${(value / 1000).toFixed(2)}s` : `${value.toFixed(0)}ms`;
			default:
				return String(value);
		}
	}

	function fmtDelta(metric: RegressionMetric, delta: number): string {
		const prefix = delta > 0 ? '+' : '';
		return `${prefix}${fmtMean(metric, delta)}`;
	}

	function fmtP(p: number): string {
		if (p < 0.001) return 'p<0.001';
		if (p < 0.01) return `p=${p.toFixed(3)}`;
		return `p=${p.toFixed(2)}`;
	}

	const baselineLabel = $derived(
		runs[0] ? `${runs[0].modelLabel ?? runs[0].modelLabel ?? runs[0].runId.slice(0, 8)}` : 'baseline'
	);
</script>

{#if regression.length > 0}
	<div class="rounded-md border border-border bg-background p-4">
		<div class="mb-2 flex items-center gap-2">
			<TrendingUp class="h-3.5 w-3.5 text-muted-foreground" />
			<h3 class="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
				Metric regression vs run #1
			</h3>
			<span class="text-[11px] text-muted-foreground">
				baseline: <span class="font-mono">{runs[0]?.runId.slice(0, 8)}</span>
				{#if runs[0]?.modelLabel}· {runs[0].modelLabel}{/if}
			</span>
		</div>

		<div class="overflow-x-auto">
			<table class="w-full border-collapse text-[11px]">
				<thead>
					<tr class="border-b border-border text-left text-muted-foreground">
						<th class="py-1 pr-4 font-medium">Metric</th>
						<th class="py-1 pr-4 font-medium">Baseline</th>
						{#each regression as _, i (i)}
							<th class="py-1 pr-4 font-medium">
								<span class="font-mono">{runs[i + 1]?.runId.slice(0, 8) ?? `run ${i + 2}`}</span>
							</th>
						{/each}
					</tr>
				</thead>
				<tbody>
					{#each regression[0] ?? [] as test0, metricIdx (test0.metric)}
						<tr class="border-b border-border/50 last:border-b-0">
							<td class="py-1.5 pr-4 font-medium">
								{METRIC_LABELS[test0.metric]}
								<span class="ml-1 text-[9px] text-muted-foreground">
									{test0.kind === 'fisher_exact' ? "Fisher's" : 'Welch t'}
								</span>
							</td>
							<td class="py-1.5 pr-4 font-mono tabular-nums">
								{fmtMean(test0.metric, test0.baseline.mean)}
								<span class="ml-1 text-[9px] text-muted-foreground">
									n={test0.baseline.n}
								</span>
							</td>
							{#each regression as runTests, runIdx (runIdx)}
								{@const t = runTests[metricIdx]}
								<td class="py-1.5 pr-4 font-mono tabular-nums">
									{#if t}
										{fmtMean(t.metric, t.candidate.mean)}
										<span class="ml-1 text-[9px] text-muted-foreground">
											n={t.candidate.n}
										</span>
										<div class="mt-0.5 flex items-center gap-1.5">
											{#if t.direction === 'better'}
												<Badge
													variant="outline"
													class="h-4 gap-0.5 border-emerald-500/40 bg-emerald-500/10 px-1 text-[9px] text-emerald-700 dark:text-emerald-400"
												>
													<TrendingUp class="h-2.5 w-2.5" />
													{fmtDelta(t.metric, t.delta)}
												</Badge>
											{:else if t.direction === 'worse'}
												<Badge
													variant="outline"
													class="h-4 gap-0.5 border-red-500/40 bg-red-500/10 px-1 text-[9px] text-red-700 dark:text-red-400"
												>
													<TrendingDown class="h-2.5 w-2.5" />
													{fmtDelta(t.metric, t.delta)}
												</Badge>
											{:else}
												<Badge
													variant="outline"
													class="h-4 gap-0.5 px-1 text-[9px] text-muted-foreground"
												>
													<Minus class="h-2.5 w-2.5" />
													{fmtDelta(t.metric, t.delta)}
												</Badge>
											{/if}
											<span
												class="text-[9px] tabular-nums {t.significant
													? 'font-semibold text-foreground'
													: 'text-muted-foreground'}"
											>
												{fmtP(t.pValue)}
											</span>
										</div>
									{:else}
										<span class="text-muted-foreground">—</span>
									{/if}
								</td>
							{/each}
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
		<p class="mt-2 text-[10px] text-muted-foreground">
			Significance threshold p&lt;0.05. Resolved rate uses Fisher's exact test (binary outcome);
			others use Welch's t-test on per-instance values. Direction badge color reflects whether
			the metric movement is favorable for the candidate run.
		</p>
	</div>
{/if}
