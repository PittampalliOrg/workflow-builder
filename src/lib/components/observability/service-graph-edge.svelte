<script lang="ts">
	import { BaseEdge, EdgeLabel, getBezierPath, type EdgeProps } from '@xyflow/svelte';
	import type { ServiceGraphEdge } from '$lib/types/service-graph';

	let { id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data }: EdgeProps =
		$props();

	let edge = $derived(data?.edge as ServiceGraphEdge);
	// Canvas passes the graph-wide max rate so thickness is relative (works for
	// both per-second windowed rates and raw single-execution counts).
	let maxRate = $derived((data?.maxRate as number) || 1);
	let scope = $derived((data?.scope as string) || 'window');

	let [edgePath, labelX, labelY] = $derived(
		getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition })
	);

	// Thickness ∝ rate (Grafana drives edge width off request rate).
	let strokeWidth = $derived.by(() => {
		const frac = Math.min(1, (edge?.red.rate ?? 0) / maxRate);
		return Math.max(1.25, 1.25 + frac * 7);
	});

	// Color ∝ error rate: primary → destructive ramp (Grafana colors by errors).
	let stroke = $derived.by(() => {
		const pct = Math.round((edge?.red.errorRate ?? 0) * 100);
		if ((edge?.red.total ?? 0) === 0) return 'var(--border)';
		if (pct === 0) return 'color-mix(in oklch, var(--primary) 70%, var(--muted-foreground))';
		return `color-mix(in oklch, var(--destructive) ${Math.max(20, pct)}%, var(--primary))`;
	});

	function fmtMs(ms: number): string {
		if (!ms) return '0ms';
		if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
		return `${Math.round(ms)}ms`;
	}
	let rateText = $derived(
		scope === 'execution'
			? `${edge?.red.total ?? 0}×`
			: (edge?.red.rate ?? 0) >= 1
				? `${Math.round(edge?.red.rate ?? 0)}/s`
				: `${(edge?.red.rate ?? 0).toFixed(2)}/s`
	);
	let errorPct = $derived(Math.round((edge?.red.errorRate ?? 0) * 100));
</script>

<BaseEdge
	{id}
	path={edgePath}
	markerEnd="url(#arrowclosed)"
	style="stroke: {stroke}; stroke-width: {strokeWidth};"
	class="wb-sg-edge"
/>

<EdgeLabel x={labelX} y={labelY} class="!bg-transparent !p-0">
	<div class="wb-sg-edge__tip nodrag nopan">
		<div class="wb-sg-edge__rate">{rateText}</div>
		<div class="wb-sg-edge__detail">
			<span class:wb-sg-edge__err={errorPct > 0}>{errorPct}% err</span>
			<span>p50 {fmtMs(edge?.red.p50 ?? 0)}</span>
			<span>p95 {fmtMs(edge?.red.p95 ?? 0)}</span>
			<span>p99 {fmtMs(edge?.red.p99 ?? 0)}</span>
		</div>
	</div>
</EdgeLabel>

<style>
	.wb-sg-edge__tip {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 2px;
		pointer-events: none;
	}
	.wb-sg-edge__rate {
		font-size: 10px;
		font-weight: 600;
		color: var(--foreground);
		background: var(--background);
		border: 1px solid var(--border);
		border-radius: 999px;
		padding: 0 6px;
		font-variant-numeric: tabular-nums;
	}
	/* Latency/error detail reveals only on edge hover to avoid clutter. */
	.wb-sg-edge__detail {
		display: none;
		gap: 6px;
		font-size: 10px;
		color: var(--muted-foreground);
		background: var(--popover);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		padding: 2px 6px;
		white-space: nowrap;
		font-variant-numeric: tabular-nums;
	}
	.wb-sg-edge__err {
		color: var(--destructive);
		font-weight: 600;
	}
	:global(.svelte-flow__edge:hover) .wb-sg-edge__detail {
		display: flex;
	}
	:global(.svelte-flow__edge:hover) .wb-sg-edge {
		filter: drop-shadow(0 0 3px var(--primary));
	}
</style>
