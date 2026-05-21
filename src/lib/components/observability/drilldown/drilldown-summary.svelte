<script lang="ts">
	import { Clock, Coins, DollarSign, AlertTriangle, Activity } from '@lucide/svelte';
	import type { ObservabilityInvestigationPayload, ObservabilityTraceSpan } from '$lib/types/observability';
	import type { NodeInsight, RedMetrics } from '$lib/types/service-graph';
	import { presentSpan, fmtMs, fmtTokens, fmtCost } from '$lib/utils/span-presentation';

	let {
		summary,
		insight,
		red,
		spans,
		onSeeTimeline
	}: {
		summary: ObservabilityInvestigationPayload['summary'];
		insight: NodeInsight | null;
		red: RedMetrics | null;
		spans: ObservabilityTraceSpan[];
		onSeeTimeline: () => void;
	} = $props();

	let totalTokens = $derived(insight?.tokens?.total ?? summary.totalTokens ?? 0);
	let errors = $derived(summary.errorCount ?? red?.errors ?? 0);
	let durationMs = $derived(summary.totalDurationMs ?? red?.p95 ?? 0);

	type Card = { label: string; value: string; icon: typeof Clock; tone: string; sub?: string };
	let cards = $derived.by<Card[]>(() => [
		{ label: 'Duration', value: fmtMs(durationMs), icon: Clock, tone: 'text-foreground' },
		{ label: 'Tokens', value: fmtTokens(totalTokens), icon: Coins, tone: 'text-chart-2' },
		{ label: 'Cost', value: fmtCost(insight?.costUsd ?? null), icon: DollarSign, tone: 'text-chart-4' },
		{
			label: errors > 0 ? 'Errors' : 'Spans',
			value: errors > 0 ? String(errors) : String(summary.spanCount ?? spans.length),
			icon: errors > 0 ? AlertTriangle : Activity,
			tone: errors > 0 ? 'text-destructive' : 'text-muted-foreground'
		}
	]);

	// Mini timeline: absolute segments by real start/duration, colored by category.
	let segments = $derived.by(() => {
		if (spans.length === 0) return [];
		const starts = spans.map((s) => new Date(s.startTime).getTime());
		const ends = spans.map((s, i) => starts[i] + s.duration);
		const t0 = Math.min(...starts);
		const t1 = Math.max(...ends);
		const range = Math.max(1, t1 - t0);
		return spans.map((s, i) => ({
			key: s.spanId + i,
			left: ((starts[i] - t0) / range) * 100,
			width: Math.max(0.4, (s.duration / range) * 100),
			barClass: s.status === 'error' ? 'bg-destructive' : presentSpan(s).barClass
		}));
	});
</script>

<div class="space-y-2.5 px-3 pt-3">
	<div class="grid grid-cols-4 gap-2">
		{#each cards as card}
			{@const Icon = card.icon}
			<div class="rounded-md border bg-card px-2.5 py-2">
				<div class="flex items-center gap-1 text-[10px] uppercase tracking-wide text-muted-foreground">
					<Icon size={11} />
					{card.label}
				</div>
				<div class="mt-0.5 font-mono text-sm font-semibold {card.tone}">{card.value}</div>
			</div>
		{/each}
	</div>

	{#if segments.length > 0}
		<button
			class="group block w-full text-left"
			onclick={onSeeTimeline}
			title="Open the timeline"
			aria-label="Open the timeline"
		>
			<div class="relative h-6 overflow-hidden rounded-md border bg-muted/40">
				{#each segments as seg (seg.key)}
					<div
						class="absolute top-1 bottom-1 rounded-[2px] {seg.barClass} opacity-70 group-hover:opacity-90"
						style="left: {seg.left}%; width: {seg.width}%;"
					></div>
				{/each}
			</div>
			<div class="mt-0.5 flex justify-between text-[10px] text-muted-foreground">
				<span>timeline</span>
				<span class="opacity-0 transition-opacity group-hover:opacity-100">open →</span>
			</div>
		</button>
	{/if}
</div>
