<script lang="ts">
	import {
		formatDuration,
		formatTokens,
		formatCostUsd,
		formatPercent
	} from './run-status-helpers';

	type Props = {
		resolved: number;
		total: number;
		resolvedRate: number;
		inferenceDone: number;
		evaluationDone: number;
		tokensInTotal: number;
		tokensOutTotal: number;
		tokensCacheReadTotal: number;
		costUsdTotal: number;
		costPerResolved: number;
		cacheHitRate: number;
		llmCallCount: number;
		inferenceP50: number | null;
		inferenceP90: number | null;
	};

	const {
		resolved,
		total,
		resolvedRate,
		inferenceDone,
		evaluationDone,
		tokensInTotal,
		tokensOutTotal,
		tokensCacheReadTotal,
		costUsdTotal,
		costPerResolved,
		cacheHitRate,
		llmCallCount,
		inferenceP50,
		inferenceP90
	}: Props = $props();

	const resolvedPctText = $derived.by(() => {
		if (total <= 0) return '—';
		return `${Math.round(resolvedRate * 100)}%`;
	});

	// $ per resolved is undefined when nothing is resolved yet — we render
	// the total-spent number with "n/a per resolved" rather than a giant "—",
	// so the user still sees the live $ ticking up during inference.
	const costHeadline = $derived(
		resolved > 0 ? formatCostUsd(costPerResolved) : formatCostUsd(costUsdTotal),
	);
	const costSubline = $derived.by(() => {
		if (costUsdTotal <= 0) return 'no LLM spend yet';
		if (resolved <= 0) return `${formatCostUsd(costUsdTotal)} spent · 0 resolved`;
		return `${formatCostUsd(costUsdTotal)} total spend`;
	});

	// Cache-hit % is "fraction of input tokens served from prior-cached prompt
	// reads". Anthropic's prompt caching reduces input cost ~10× when high.
	const cacheHitText = $derived.by(() => {
		const totalIn = tokensInTotal + tokensCacheReadTotal;
		if (totalIn <= 0) return '—';
		return formatPercent(cacheHitRate, 0);
	});
	const cacheSubline = $derived.by(() => {
		const totalIn = tokensInTotal + tokensCacheReadTotal;
		if (totalIn <= 0) return 'no input tokens yet';
		return `${formatTokens(tokensCacheReadTotal)} cached · ${formatTokens(tokensInTotal)} fresh`;
	});

	const tokenBreakdown = $derived.by(() => {
		if (tokensInTotal + tokensOutTotal <= 0) return '—';
		return `${formatTokens(tokensInTotal)} in · ${formatTokens(tokensOutTotal)} out`;
	});
</script>

<div class="grid gap-3 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-7">
	<div class="rounded-md border border-border bg-background p-4">
		<div class="text-[11px] uppercase tracking-wider text-muted-foreground">% Resolved</div>
		<div class="mt-1 text-3xl font-semibold tabular-nums leading-none">{resolvedPctText}</div>
		<div class="mt-2 text-xs text-muted-foreground">
			{resolved} <span class="opacity-50">of</span> {total} instances
		</div>
		<div class="mt-2 h-1.5 overflow-hidden rounded-full bg-muted">
			<div
				class="h-full bg-emerald-500 transition-all"
				style:width="{Math.min(100, Math.round(resolvedRate * 100))}%"
			></div>
		</div>
	</div>

	<div class="rounded-md border border-border bg-background p-4">
		<div class="text-[11px] uppercase tracking-wider text-muted-foreground">Inference</div>
		<div class="mt-1 text-3xl font-semibold tabular-nums leading-none">
			{inferenceDone}<span class="text-xl text-muted-foreground">/{total}</span>
		</div>
		<div class="mt-2 text-xs text-muted-foreground">
			{total > 0 ? Math.round((inferenceDone / total) * 100) : 0}% finished
		</div>
		<div class="mt-2 h-1.5 overflow-hidden rounded-full bg-muted">
			<div
				class="h-full bg-blue-500 transition-all"
				style:width="{total > 0 ? Math.round((inferenceDone / total) * 100) : 0}%"
			></div>
		</div>
	</div>

	<div class="rounded-md border border-border bg-background p-4">
		<div class="text-[11px] uppercase tracking-wider text-muted-foreground">Official harness</div>
		<div class="mt-1 text-3xl font-semibold tabular-nums leading-none">
			{evaluationDone}<span class="text-xl text-muted-foreground">/{total}</span>
		</div>
		<div class="mt-2 text-xs text-muted-foreground">
			{total > 0 ? Math.round((evaluationDone / total) * 100) : 0}% graded
		</div>
		<div class="mt-2 h-1.5 overflow-hidden rounded-full bg-muted">
			<div
				class="h-full bg-violet-500 transition-all"
				style:width="{total > 0 ? Math.round((evaluationDone / total) * 100) : 0}%"
			></div>
		</div>
	</div>

	<div class="rounded-md border border-border bg-background p-4">
		<div class="text-[11px] uppercase tracking-wider text-muted-foreground">
			{resolved > 0 ? 'Cost / resolved' : 'Cost'}
		</div>
		<div class="mt-1 text-2xl font-semibold tabular-nums leading-none">{costHeadline}</div>
		<div class="mt-2 text-xs text-muted-foreground">{costSubline}</div>
	</div>

	<div class="rounded-md border border-border bg-background p-4">
		<div class="text-[11px] uppercase tracking-wider text-muted-foreground">Cache hit</div>
		<div class="mt-1 text-2xl font-semibold tabular-nums leading-none">{cacheHitText}</div>
		<div class="mt-2 text-xs text-muted-foreground">{cacheSubline}</div>
	</div>

	<div class="rounded-md border border-border bg-background p-4">
		<div class="text-[11px] uppercase tracking-wider text-muted-foreground">Inference duration</div>
		<div class="mt-1 text-2xl font-semibold tabular-nums leading-none">
			{formatDuration(inferenceP50)}
		</div>
		<div class="mt-2 text-xs text-muted-foreground">
			P50 · P90 {formatDuration(inferenceP90)}
		</div>
	</div>

	<div class="rounded-md border border-border bg-background p-4">
		<div class="text-[11px] uppercase tracking-wider text-muted-foreground">Tokens</div>
		<div class="mt-1 text-2xl font-semibold tabular-nums leading-none">
			{formatTokens(tokensInTotal + tokensOutTotal)}
		</div>
		<div class="mt-2 text-xs text-muted-foreground">{tokenBreakdown}</div>
		{#if llmCallCount > 0}
			<div class="text-[10px] text-muted-foreground tabular-nums">
				{llmCallCount} LLM call{llmCallCount === 1 ? '' : 's'}
			</div>
		{/if}
	</div>
</div>
