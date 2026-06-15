<script lang="ts">
	/**
	 * Compact demand-vs-capacity timeline: a filled area of REQUESTED utilization
	 * (% of allocatable — how much of the cluster is committed) rising toward the
	 * 100% capacity ceiling, with an ACTUAL-usage line beneath it. Threshold zones
	 * at 70%/90% read the pressure at a glance. Modeled on the Capacity Overview
	 * Trends panel's "requested vs actual" chart, sized down for the Fleet band.
	 */
	import * as Chart from '$lib/components/ui/chart';
	import { AreaChart, Spline, Area, AnnotationLine, AnnotationRange } from 'layerchart';

	type Pt = { t: string; value: number };
	type Props = {
		requested: Pt[];
		actual?: Pt[];
		height?: number;
	};
	let { requested, actual = [], height = 130 }: Props = $props();

	type Row = { ts: Date; requested: number | null; actual: number | null };
	const data = $derived.by<Row[]>(() => {
		const map = new Map<number, Row>();
		for (const p of requested) {
			const ms = new Date(p.t).getTime();
			if (!Number.isFinite(ms)) continue;
			map.set(ms, { ts: new Date(ms), requested: p.value, actual: null });
		}
		for (const p of actual) {
			const ms = new Date(p.t).getTime();
			if (!Number.isFinite(ms)) continue;
			const row = map.get(ms) ?? { ts: new Date(ms), requested: null, actual: null };
			row.actual = p.value;
			map.set(ms, row);
		}
		return [...map.values()].sort((a, b) => a.ts.getTime() - b.ts.getTime());
	});

	const hasActual = $derived(actual.some((p) => Number.isFinite(p.value)));
	const latestReq = $derived(requested.at(-1)?.value ?? null);
	const latestActual = $derived(hasActual ? (actual.at(-1)?.value ?? null) : null);
	function tone(pct: number | null): string {
		if (pct === null) return 'text-muted-foreground';
		if (pct >= 90) return 'text-rose-500';
		if (pct >= 70) return 'text-amber-500';
		return 'text-emerald-600 dark:text-emerald-400';
	}

	const chartConfig = {
		requested: { label: 'Requested', color: 'var(--chart-1)' },
		actual: { label: 'Actual', color: 'rgb(16 185 129)' }
	} satisfies Chart.ChartConfig;
</script>

<div class="space-y-2">
	<div class="flex items-center gap-3 text-[10px] tabular-nums text-muted-foreground">
		<span class="inline-flex items-center gap-1">
			<span class="size-2 rounded-full" style="background: var(--chart-1)"></span>
			requested <span class="font-mono {tone(latestReq)}">{latestReq?.toFixed(0) ?? '—'}%</span>
		</span>
		{#if hasActual}
			<span class="inline-flex items-center gap-1">
				<span class="h-0.5 w-3 rounded-full bg-emerald-500"></span>
				actual <span class="font-mono {tone(latestActual)}">{latestActual?.toFixed(0) ?? '—'}%</span>
			</span>
		{/if}
		<span class="ml-auto">100% = at capacity</span>
	</div>

	{#if data.length < 2}
		<p class="py-6 text-center text-[11px] text-muted-foreground/70">Waiting for capacity samples…</p>
	{:else}
		<div style:height="{height}px">
			<Chart.Container config={chartConfig} class="h-full w-full">
				<AreaChart
					{data}
					x="ts"
					yDomain={[0, 100]}
					series={[
						{ key: 'requested', value: (d: Row) => d.requested, color: 'var(--chart-1)' },
						{ key: 'actual', value: (d: Row) => d.actual, color: 'rgb(16 185 129)' }
					]}
					legend={false}
				>
					{#snippet marks()}
						<AnnotationRange y={[0, 70]} class="fill-emerald-500/5" />
						<AnnotationRange y={[70, 90]} class="fill-amber-500/10" />
						<AnnotationRange y={[90, 100]} class="fill-rose-500/15" />
						<Area
							seriesKey="requested"
							fill="var(--chart-1)"
							fill-opacity={0.16}
							defined={(d: Row) => d.requested !== null}
						/>
						<Spline
							seriesKey="requested"
							stroke="var(--chart-1)"
							stroke-width={1.75}
							defined={(d: Row) => d.requested !== null}
						/>
						{#if hasActual}
							<Spline
								seriesKey="actual"
								stroke="rgb(16 185 129)"
								stroke-width={1.5}
								stroke-dasharray="4 2"
								defined={(d: Row) => d.actual !== null}
							/>
						{/if}
					{/snippet}
					{#snippet aboveMarks()}
						<AnnotationLine y={70} stroke="rgb(245 158 11)" stroke-width={1} stroke-dasharray="3 2" opacity={0.5} />
						<AnnotationLine y={90} stroke="rgb(239 68 68)" stroke-width={1} stroke-dasharray="3 2" opacity={0.55} />
					{/snippet}
					{#snippet tooltip()}
						<Chart.Tooltip />
					{/snippet}
				</AreaChart>
			</Chart.Container>
		</div>
	{/if}
</div>
