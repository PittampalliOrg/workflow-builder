<script lang="ts">
	/**
	 * Headroom forecast: projects when the current resource trajectory will
	 * cross the budget threshold (saturation) given a least-squares fit of
	 * the last ~minute of `requested` samples.
	 *
	 * Output is a small chart with:
	 *   - solid line: actual `requested` samples
	 *   - dashed line: forecast projection from the last sample at the
	 *     fitted slope
	 *   - horizontal reference line at the budget threshold
	 *   - inline ETA badge
	 *
	 * Falls back to a one-line text label when there's not enough history
	 * to fit a slope (samples < 3) or the slope is below the flat-floor —
	 * matches the pre-chart behaviour so the empty + steady-state cases
	 * stay quiet.
	 */
	import { TrendingUp, TrendingDown, Minus } from '@lucide/svelte';
	import * as Chart from '$lib/components/ui/chart';
	import { LineChart, Spline, AnnotationLine } from 'layerchart';
	import { formatQuantityForResource } from '$lib/components/capacity/quantity';
	import type { GaugeResource } from './gauge-resource-toggle.svelte';

	type Sample = {
		t: number; // ms epoch
		requested: number;
	};

	type Props = {
		samples: Sample[];
		headroom: number;
		resource: GaugeResource;
	};

	let { samples, headroom, resource }: Props = $props();

	const RESOURCE_LABELS: Record<GaugeResource, string> = {
		cpu: 'CPU',
		memory: 'memory',
		pods: 'pod',
		'ephemeral-storage': 'storage'
	};

	type Forecast =
		| { kind: 'stable' }
		| { kind: 'draining'; perMinute: number; slopePerSecond: number }
		| { kind: 'rising'; perMinute: number; slopePerSecond: number; etaSeconds: number | null };

	const forecast = $derived.by<Forecast>(() => {
		if (samples.length < 3) return { kind: 'stable' };
		const n = samples.length;
		const t0 = samples[0].t;
		let sumX = 0;
		let sumY = 0;
		let sumXY = 0;
		let sumXX = 0;
		for (const s of samples) {
			const x = (s.t - t0) / 1000;
			const y = s.requested;
			sumX += x;
			sumY += y;
			sumXY += x * y;
			sumXX += x * x;
		}
		const denom = n * sumXX - sumX * sumX;
		if (denom <= 0) return { kind: 'stable' };
		const slopePerSecond = (n * sumXY - sumX * sumY) / denom;
		const perMinute = slopePerSecond * 60;

		const flatFloor = Math.max(0.005, Math.abs(headroom) * 0.01);
		if (Math.abs(perMinute) < flatFloor) return { kind: 'stable' };

		if (slopePerSecond < 0) {
			return { kind: 'draining', perMinute: Math.abs(perMinute), slopePerSecond };
		}

		if (headroom <= 0)
			return { kind: 'rising', perMinute, slopePerSecond, etaSeconds: 0 };
		const etaSeconds = headroom / slopePerSecond;
		return {
			kind: 'rising',
			perMinute,
			slopePerSecond,
			etaSeconds: Number.isFinite(etaSeconds) ? etaSeconds : null
		};
	});

	function formatEta(seconds: number | null): string {
		if (seconds === null) return '—';
		if (seconds < 60) return `${Math.round(seconds)}s`;
		if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
		return `${(seconds / 3600).toFixed(1)}h`;
	}

	// --- chart series construction ---------------------------------------
	// We build one combined dataset keyed on Date so the chart's x-axis is
	// a true time scale (LayerChart auto-detects). Each row carries either
	// an `actual` value or a `forecast` value (the other side is null) so
	// the two series stay visually separate.
	type Row = { t: Date; actual: number | null; forecast: number | null };

	const budget = $derived(
		samples.length === 0 ? 0 : samples[samples.length - 1].requested + headroom
	);

	const chartData = $derived.by<Row[]>(() => {
		if (samples.length < 2) return [];
		const rows: Row[] = samples.map((s) => ({
			t: new Date(s.t),
			actual: s.requested,
			forecast: null
		}));
		// Bridge the actual → forecast handoff at the last point so the dashed
		// line starts visually attached.
		const last = samples[samples.length - 1];
		rows[rows.length - 1].forecast = last.requested;

		if (forecast.kind === 'rising' || forecast.kind === 'draining') {
			// Project forward 8 samples at the inter-sample stride seen in the
			// actual data (defaults to 5s if we can't infer).
			const strideMs =
				samples.length >= 2
					? Math.max(1000, samples[1].t - samples[0].t)
					: 5000;
			const startT = last.t;
			const slope =
				forecast.kind === 'rising' ? forecast.slopePerSecond : -forecast.slopePerSecond;
			const horizonMs =
				forecast.kind === 'rising' && forecast.etaSeconds !== null && forecast.etaSeconds > 0
					? Math.min(forecast.etaSeconds * 1000 + strideMs * 2, strideMs * 24)
					: strideMs * 8;
			const steps = Math.max(2, Math.min(24, Math.ceil(horizonMs / strideMs)));
			for (let i = 1; i <= steps; i += 1) {
				const tt = startT + i * strideMs;
				const projected = last.requested + slope * ((tt - last.t) / 1000);
				rows.push({
					t: new Date(tt),
					actual: null,
					forecast: Math.max(0, projected)
				});
			}
		}
		return rows;
	});

	const chartConfig = {
		actual: { label: 'Actual', color: 'var(--chart-1)' },
		forecast: { label: 'Forecast', color: 'var(--chart-4, hsl(280 65% 60%))' }
	} satisfies Chart.ChartConfig;
</script>

{#if samples.length < 3 || forecast.kind === 'stable'}
	<div class="flex items-center gap-1.5 text-[11px] text-muted-foreground">
		{#if forecast.kind === 'stable'}
			<Minus class="size-3" />
			<span>stable load on {RESOURCE_LABELS[resource]}</span>
		{:else}
			<Minus class="size-3" />
			<span>warming up forecast…</span>
		{/if}
	</div>
{:else}
	<div class="space-y-1.5">
		<div class="flex items-center gap-1.5 text-[11px]">
			{#if forecast.kind === 'draining'}
				<TrendingDown class="size-3 text-emerald-600 dark:text-emerald-400" />
				<span class="text-muted-foreground">
					releasing
					<span class="font-mono text-foreground">
						{formatQuantityForResource(resource, forecast.perMinute)}
					</span>
					/ min on {RESOURCE_LABELS[resource]}
				</span>
			{:else}
				<TrendingUp
					class="size-3 {forecast.etaSeconds !== null && forecast.etaSeconds < 300
						? 'text-rose-600 dark:text-rose-400'
						: 'text-amber-600 dark:text-amber-400'}"
				/>
				<span class="text-muted-foreground">
					≈
					<span class="font-mono text-foreground">{formatEta(forecast.etaSeconds)}</span>
					to {RESOURCE_LABELS[resource]} budget saturated
				</span>
			{/if}
		</div>
		<div style:height="64px">
			<Chart.Container config={chartConfig} class="h-full w-full">
				<LineChart
					data={chartData}
					x="t"
					series={[
						{ key: 'actual', value: (d: Row) => d.actual, color: 'var(--chart-1)' },
						{ key: 'forecast', value: (d: Row) => d.forecast, color: 'var(--chart-4, hsl(280 65% 60%))' }
					]}
					axis={false}
					grid={false}
					rule={false}
					legend={false}
				>
					{#snippet marks()}
						<Spline
							seriesKey="actual"
							defined={(d: Row) => d.actual !== null}
							stroke="var(--chart-1)"
							stroke-width={1.5}
						/>
						<Spline
							seriesKey="forecast"
							defined={(d: Row) => d.forecast !== null}
							stroke="var(--chart-4, hsl(280 65% 60%))"
							stroke-width={1.25}
							stroke-dasharray="3 2"
						/>
					{/snippet}
					{#snippet aboveMarks()}
						{#if budget > 0}
							<AnnotationLine
								y={budget}
								stroke="hsl(var(--destructive, 0 84% 60%))"
								stroke-width={1}
								stroke-dasharray="2 2"
								opacity={0.55}
							/>
						{/if}
					{/snippet}
				</LineChart>
			</Chart.Container>
		</div>
	</div>
{/if}
