<script lang="ts">
	import { formatDuration, formatTokens, formatCostUsd } from './run-status-helpers';

	type Props = {
		resolved: number;
		total: number;
		resolvedRate: number;
		inferenceDone: number;
		evaluationDone: number;
		tokensTotal: number;
		costUsdTotal: number;
		inferenceP50: number | null;
		inferenceP90: number | null;
	};

	const {
		resolved,
		total,
		resolvedRate,
		inferenceDone,
		evaluationDone,
		tokensTotal,
		costUsdTotal,
		inferenceP50,
		inferenceP90
	}: Props = $props();

	const resolvedPctText = $derived.by(() => {
		if (total <= 0) return '—';
		return `${Math.round(resolvedRate * 100)}%`;
	});
</script>

<div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
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
		<div class="text-[11px] uppercase tracking-wider text-muted-foreground">Inference duration</div>
		<div class="mt-1 text-2xl font-semibold tabular-nums leading-none">
			{formatDuration(inferenceP50)}
		</div>
		<div class="mt-2 text-xs text-muted-foreground">
			P50 · P90 {formatDuration(inferenceP90)}
		</div>
	</div>

	<div class="rounded-md border border-border bg-background p-4">
		<div class="text-[11px] uppercase tracking-wider text-muted-foreground">Tokens / cost</div>
		<div class="mt-1 text-2xl font-semibold tabular-nums leading-none">
			{formatTokens(tokensTotal)}
		</div>
		<div class="mt-2 text-xs text-muted-foreground">
			{costUsdTotal > 0 ? formatCostUsd(costUsdTotal) : '—'}
		</div>
	</div>
</div>
