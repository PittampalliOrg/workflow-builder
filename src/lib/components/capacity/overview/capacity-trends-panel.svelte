<script lang="ts">
	/**
	 * Three side-by-side time-series charts driven by the page-level rolling
	 * history. Hidden by default; expand to peek the last 5/15/60 minutes.
	 *
	 *   Chart A — Scheduling latency: P50 + P95 (ms) over time.
	 *   Chart B — Active workloads: admitted / pending / reserving (stacked area).
	 *   Chart C — Cluster headroom %: single line with 70% + 90% reference lines.
	 *
	 * Each chart has its own tooltip; the x-axis is a shared time scale, so
	 * mental alignment works without explicit cross-cursor wiring (which
	 * LayerChart v2 supports but adds complexity we don't need on first pass).
	 */
	import * as Chart from '$lib/components/ui/chart';
	import { AreaChart, LineChart, Spline, Area, AnnotationLine, AnnotationRange } from 'layerchart';
	import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '$lib/components/ui/collapsible';
	import { ChevronDown, ChevronRight, LineChart as LineChartIcon } from '@lucide/svelte';
	import TrendsWindowToggle, { type TrendsWindow } from './trends-window-toggle.svelte';
	import CapacityCandlestick, { type Candle } from './capacity-candlestick.svelte';
	import CapacityOwnerStack, { type ResolvedOwner } from './capacity-owner-stack.svelte';
	import type { CapacityOwnerTimeline } from '../../../../routes/workspaces/[slug]/capacity/overview/data.remote';
	import type { GaugeResource } from './gauge-resource-toggle.svelte';

	export type HistoryPoint = {
		t: number; // ms epoch
		/**
		 * Requested resource amount for the currently-selected gauge resource.
		 * Nulled out for past entries when the user flips the gauge resource —
		 * slopes don't translate across units. The forecast component
		 * filters these out at the call site.
		 */
		requested: number | null;
		schedulingP50Ms: number | null;
		schedulingP95Ms: number | null;
		admittedCount: number;
		pendingCount: number;
		reservingCount: number;
		/** Cluster-wide headroom % for the currently-selected gauge resource. */
		headroomPct: number | null;
		/**
		 * Phase C: PSI `some.avg60` per resource (% of 60s window with ANY
		 * task stalled). Null until kubelet returns data — first ~10s after
		 * page-load + on K8s < 1.36 / no scrape permission.
		 */
		psiCpuSome60: number | null;
		psiMemorySome60: number | null;
		psiIoSome60: number | null;
		psiCoverageRatioPct: number | null;
	};

	export type CapacityPsiTrendsSnapshot = {
		source: 'clickhouse' | 'unavailable';
		cpuSomeAvg60Pct: Array<{ t: string; value: number }>;
		memorySomeAvg60Pct: Array<{ t: string; value: number }>;
		ioSomeAvg60Pct: Array<{ t: string; value: number }>;
		coverageRatioPct: Array<{ t: string; value: number }>;
		hasData: boolean;
	};

	/**
	 * ClickHouse-backed trends (durable; populate instantly). Preferred over the
	 * in-memory `history` buffer for the headroom / workloads / latency charts —
	 * the buffer resets on reload + resource flip and pauses when the tab is
	 * hidden, so on a quiet/backgrounded tab it never crosses the render
	 * threshold. Falls back to the buffer when ClickHouse has no data.
	 */
	export type CapacityTrendsSnapshot = {
		utilizationPctByResource: Record<string, Array<{ t: string; value: number }>>;
		admitted: Array<{ t: string; value: number }>;
		pending: Array<{ t: string; value: number }>;
		reserving: Array<{ t: string; value: number }>;
		latencyAvgMs: Array<{ t: string; value: number }>;
		hasData: boolean;
	};

	type Props = {
		history: HistoryPoint[];
		psiTrends?: CapacityPsiTrendsSnapshot | null;
		capacityTrends?: CapacityTrendsSnapshot | null;
		ownerTimeline?: CapacityOwnerTimeline | null;
		resolveOwner?: (kind: string, id: string) => ResolvedOwner;
		window: TrendsWindow;
		resource: GaugeResource;
		onWindowChange: (next: TrendsWindow) => void;
	};

	let {
		history,
		psiTrends = null,
		capacityTrends = null,
		ownerTimeline = null,
		resolveOwner = (kind, id) => ({ label: id, kind }),
		window: windowSel,
		resource,
		onWindowChange
	}: Props = $props();

	const WINDOW_MS: Record<TrendsWindow, number> = {
		'5m': 5 * 60 * 1000,
		'15m': 15 * 60 * 1000,
		'60m': 60 * 60 * 1000
	};

	const RESOURCE_LABELS: Record<GaugeResource, string> = {
		cpu: 'CPU',
		memory: 'memory',
		pods: 'pods',
		'ephemeral-storage': 'storage'
	};

	const windowed = $derived.by(() => {
		if (history.length === 0) return [];
		const cutoff = Date.now() - WINDOW_MS[windowSel];
		return history.filter((p) => p.t >= cutoff).map((p) => ({ ...p, ts: new Date(p.t) }));
	});

	const psiWindowed = $derived.by(() => {
		const cutoff = Date.now() - WINDOW_MS[windowSel];
		if (psiTrends?.hasData) {
			const byTs = new Map<
				string,
				{
					t: number;
					ts: Date;
					psiCpuSome60: number | null;
					psiMemorySome60: number | null;
					psiIoSome60: number | null;
					psiCoverageRatioPct: number | null;
				}
			>();
			const merge = (
				points: Array<{ t: string; value: number }>,
				key: 'psiCpuSome60' | 'psiMemorySome60' | 'psiIoSome60' | 'psiCoverageRatioPct'
			) => {
				for (const point of points) {
					const t = new Date(point.t).getTime();
					if (!Number.isFinite(t) || t < cutoff) continue;
					const id = String(t);
					const row =
						byTs.get(id) ??
						{
							t,
							ts: new Date(t),
							psiCpuSome60: null,
							psiMemorySome60: null,
							psiIoSome60: null,
							psiCoverageRatioPct: null
						};
					row[key] = point.value;
					byTs.set(id, row);
				}
			};
			merge(psiTrends.cpuSomeAvg60Pct, 'psiCpuSome60');
			merge(psiTrends.memorySomeAvg60Pct, 'psiMemorySome60');
			merge(psiTrends.ioSomeAvg60Pct, 'psiIoSome60');
			merge(psiTrends.coverageRatioPct, 'psiCoverageRatioPct');
			return [...byTs.values()].sort((a, b) => a.t - b.t);
		}
		return windowed.map((p) => ({
			t: p.t,
			ts: p.ts,
			psiCpuSome60: p.psiCpuSome60,
			psiMemorySome60: p.psiMemorySome60,
			psiIoSome60: p.psiIoSome60,
			psiCoverageRatioPct: p.psiCoverageRatioPct
		}));
	});

	// --- ClickHouse-preferred series (fall back to client buffer) ----------
	const cutoffMs = $derived(Date.now() - WINDOW_MS[windowSel]);

	// Utilization % (requested ÷ allocatable) per the selected resource, from
	// ClickHouse. Rises as workloads consume capacity. ClickHouse is the source
	// of truth here; no buffer fallback (the buffer only held the old headroom
	// metric).
	const utilizationWindowed = $derived.by<Array<{ ts: Date; value: number }>>(() => {
		const ch = capacityTrends?.utilizationPctByResource?.[resource];
		if (!ch || ch.length === 0) return [];
		return ch
			.map((p) => ({ t: new Date(p.t).getTime(), value: p.value }))
			.filter((p) => Number.isFinite(p.t) && p.t >= cutoffMs)
			.map((p) => ({ ts: new Date(p.t), value: p.value }));
	});

	// Candlestick: bucket the utilization% points into ~12 OHLC candles across
	// the window so each candle shows how capacity utilization churned within
	// the bucket as workloads activated (up candle = more capacity consumed).
	const candles = $derived.by<Candle[]>(() => {
		const pts = utilizationWindowed;
		if (pts.length < 2) return [];
		const span = WINDOW_MS[windowSel];
		const candleMs = Math.max(30_000, Math.floor(span / 12));
		const byBucket = new Map<number, Candle>();
		for (const p of pts) {
			const t = p.ts.getTime();
			const key = Math.floor(t / candleMs) * candleMs;
			const existing = byBucket.get(key);
			if (!existing) {
				byBucket.set(key, { t: key, open: p.value, high: p.value, low: p.value, close: p.value });
			} else {
				existing.high = Math.max(existing.high, p.value);
				existing.low = Math.min(existing.low, p.value);
				existing.close = p.value; // points are time-ordered → last is close
			}
		}
		return [...byBucket.values()].sort((a, b) => a.t - b.t);
	});

	type WorkloadRow = { ts: Date; admitted: number; pending: number; reserving: number };
	const workloadsWindowed = $derived.by<WorkloadRow[]>(() => {
		const ct = capacityTrends;
		if (ct?.hasData && (ct.admitted.length || ct.pending.length || ct.reserving.length)) {
			const byTs = new Map<number, WorkloadRow>();
			const merge = (pts: Array<{ t: string; value: number }>, key: 'admitted' | 'pending' | 'reserving') => {
				for (const p of pts) {
					const t = new Date(p.t).getTime();
					if (!Number.isFinite(t) || t < cutoffMs) continue;
					const row = byTs.get(t) ?? { ts: new Date(t), admitted: 0, pending: 0, reserving: 0 };
					row[key] = p.value;
					byTs.set(t, row);
				}
			};
			merge(ct.admitted, 'admitted');
			merge(ct.pending, 'pending');
			merge(ct.reserving, 'reserving');
			return [...byTs.values()].sort((a, b) => a.ts.getTime() - b.ts.getTime());
		}
		return windowed.map((p) => ({
			ts: p.ts,
			admitted: p.admittedCount,
			pending: p.pendingCount,
			reserving: p.reservingCount
		}));
	});

	// Latency: ClickHouse gives an avg-per-bucket line; the buffer gives P50/P95.
	const latencyClickhouse = $derived.by<Array<{ ts: Date; value: number }>>(() => {
		const ch = capacityTrends?.latencyAvgMs;
		if (capacityTrends?.hasData && ch && ch.length > 0) {
			return ch
				.map((p) => ({ t: new Date(p.t).getTime(), value: p.value }))
				.filter((p) => Number.isFinite(p.t) && p.t >= cutoffMs)
				.map((p) => ({ ts: new Date(p.t), value: p.value }));
		}
		return [];
	});

	const sampleCount = $derived(
		Math.max(
			windowed.length,
			utilizationWindowed.length,
			workloadsWindowed.length,
			latencyClickhouse.length,
			psiWindowed.length
		)
	);

	let open = $state(false);

	const latencyConfig = {
		p50: { label: 'P50', color: 'var(--chart-2)' },
		p95: { label: 'P95', color: 'var(--chart-1)' }
	} satisfies Chart.ChartConfig;

	const workloadsConfig = {
		admitted: { label: 'admitted', color: 'rgb(16 185 129)' },
		pending: { label: 'pending', color: 'rgb(245 158 11)' },
		reserving: { label: 'reserving', color: 'rgb(14 165 233)' }
	} satisfies Chart.ChartConfig;

	const headroomConfig = {
		headroom: { label: 'Utilization %', color: 'var(--chart-1)' }
	} satisfies Chart.ChartConfig;

	const latencyAvgConfig = {
		latency: { label: 'avg latency', color: 'var(--chart-1)' }
	} satisfies Chart.ChartConfig;

	const psiConfig = {
		cpu: { label: 'CPU PSI', color: 'rgb(14 165 233)' },
		memory: { label: 'Memory PSI', color: 'rgb(244 63 94)' },
		io: { label: 'IO PSI', color: 'rgb(245 158 11)' },
		coverage: { label: 'Coverage %', color: 'rgb(16 185 129)' }
	} satisfies Chart.ChartConfig;

	type Row = (typeof windowed)[number];
	type PsiRow = (typeof psiWindowed)[number];
</script>

<Collapsible bind:open class="rounded-md border bg-card">
	<CollapsibleTrigger
		class="group flex w-full items-center justify-between gap-2 px-4 py-2.5 text-left text-sm hover:bg-muted/20"
	>
		<div class="flex items-center gap-2">
			{#if open}
				<ChevronDown class="size-4 text-muted-foreground" />
			{:else}
				<ChevronRight class="size-4 text-muted-foreground" />
			{/if}
			<LineChartIcon class="size-3.5 text-muted-foreground" />
			<span class="font-medium">Trends</span>
			<span class="text-[11px] text-muted-foreground">
				last {windowSel}
				{#if sampleCount > 0}
					· {sampleCount} sample{sampleCount === 1 ? '' : 's'}
				{/if}
			</span>
		</div>
		{#if open}
			<div
				onclick={(e) => e.stopPropagation()}
				onkeydown={(e) => {
					if (e.key === ' ' || e.key === 'Enter') e.stopPropagation();
				}}
				role="none"
			>
				<TrendsWindowToggle value={windowSel} onChange={onWindowChange} />
			</div>
		{/if}
	</CollapsibleTrigger>
	<CollapsibleContent>
		<div class="grid gap-3 border-t p-3 md:grid-cols-2 xl:grid-cols-4">
			<!-- Chart A: scheduling latency P50/P95 -->
			<div class="rounded-md border bg-background p-3">
				<div class="mb-2 flex items-baseline justify-between">
					<h4 class="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
						Scheduling latency (ms)
					</h4>
					{#if latencyClickhouse.length > 0}
						{@const last = latencyClickhouse[latencyClickhouse.length - 1]}
						<span class="text-[10px] tabular-nums text-muted-foreground">
							avg <span class="font-mono text-foreground">{Math.round(last.value)}</span>ms
						</span>
					{:else if windowed.length > 0}
						{@const last = windowed[windowed.length - 1]}
						<span class="text-[10px] tabular-nums text-muted-foreground">
							P95 <span class="font-mono text-foreground">{last.schedulingP95Ms ?? '—'}</span>
						</span>
					{/if}
				</div>
				{#if latencyClickhouse.length >= 2}
					<div style:height="120px">
						<Chart.Container config={latencyAvgConfig} class="h-full w-full">
							<LineChart
								data={latencyClickhouse}
								x="ts"
								series={[{ key: 'latency', value: (d: { value: number }) => d.value, color: 'var(--chart-1)' }]}
								legend={false}
							>
								{#snippet marks()}
									<Spline seriesKey="latency" stroke="var(--chart-1)" stroke-width={1.75} />
								{/snippet}
								{#snippet tooltip()}
									<Chart.Tooltip />
								{/snippet}
							</LineChart>
						</Chart.Container>
					</div>
				{:else if windowed.filter((p) => p.schedulingP95Ms !== null).length < 2}
					<p class="py-6 text-center text-[11px] text-muted-foreground/70">
						Waiting for scheduling samples…
					</p>
				{:else}
					<div style:height="120px">
						<Chart.Container config={latencyConfig} class="h-full w-full">
							<LineChart
								data={windowed}
								x="ts"
								series={[
									{ key: 'p50', value: (d: Row) => d.schedulingP50Ms, color: 'var(--chart-2)' },
									{ key: 'p95', value: (d: Row) => d.schedulingP95Ms, color: 'var(--chart-1)' }
								]}
								legend={false}
							>
								{#snippet marks()}
									<Spline
										seriesKey="p50"
										defined={(d: Row) => d.schedulingP50Ms !== null}
										stroke="var(--chart-2)"
										stroke-width={1.25}
									/>
									<Spline
										seriesKey="p95"
										defined={(d: Row) => d.schedulingP95Ms !== null}
										stroke="var(--chart-1)"
										stroke-width={1.5}
									/>
								{/snippet}
								{#snippet tooltip()}
									<Chart.Tooltip />
								{/snippet}
							</LineChart>
						</Chart.Container>
					</div>
				{/if}
			</div>

			<!-- Chart B: workload counts stacked area -->
			<div class="rounded-md border bg-background p-3">
				<div class="mb-2 flex items-baseline justify-between">
					<h4 class="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
						Active workloads
					</h4>
					{#if workloadsWindowed.length > 0}
						{@const last = workloadsWindowed[workloadsWindowed.length - 1]}
						<span class="text-[10px] tabular-nums text-muted-foreground">
							{last.admitted + last.pending + last.reserving} now
						</span>
					{/if}
				</div>
				{#if workloadsWindowed.length < 2}
					<p class="py-6 text-center text-[11px] text-muted-foreground/70">
						Waiting for workload samples…
					</p>
				{:else}
					<div style:height="120px">
						<Chart.Container config={workloadsConfig} class="h-full w-full">
							<AreaChart
								data={workloadsWindowed}
								x="ts"
								seriesLayout="stack"
								series={[
									{ key: 'admitted', value: (d: WorkloadRow) => d.admitted, color: 'rgb(16 185 129)' },
									{ key: 'pending', value: (d: WorkloadRow) => d.pending, color: 'rgb(245 158 11)' },
									{ key: 'reserving', value: (d: WorkloadRow) => d.reserving, color: 'rgb(14 165 233)' }
								]}
								legend={false}
							>
								{#snippet tooltip()}
									<Chart.Tooltip />
								{/snippet}
							</AreaChart>
						</Chart.Container>
					</div>
				{/if}
			</div>

			<!-- Chart C: cluster utilization % (requested ÷ allocatable) -->
			<div class="rounded-md border bg-background p-3">
				<div class="mb-2 flex items-baseline justify-between">
					<h4 class="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
						{RESOURCE_LABELS[resource]} utilization %
					</h4>
					{#if utilizationWindowed.length > 0}
						{@const last = utilizationWindowed[utilizationWindowed.length - 1]}
						<span class="text-[10px] tabular-nums text-muted-foreground">
							<span
								class="font-mono {last.value >= 90
									? 'text-rose-500'
									: last.value >= 70
										? 'text-amber-500'
										: 'text-foreground'}">{last.value.toFixed(1)}</span
							>%
						</span>
					{/if}
				</div>
				{#if ownerTimeline?.hasData}
					<!-- Stacked by owner: each band is a session/workflow/benchmark
					     consuming this resource; hover lists them, legend links out. -->
					<CapacityOwnerStack timeline={ownerTimeline} {resolveOwner} height={120} />
				{:else if utilizationWindowed.length < 2}
					<p class="py-6 text-center text-[11px] text-muted-foreground/70">
						Waiting for utilization samples…
					</p>
				{:else}
					<div style:height="120px">
						<Chart.Container config={headroomConfig} class="h-full w-full">
							<LineChart
								data={utilizationWindowed}
								x="ts"
								yDomain={[0, 100]}
								series={[
									{ key: 'headroom', value: (d: { value: number }) => d.value, color: 'var(--chart-1)' }
								]}
								legend={false}
							>
								{#snippet marks()}
									<!-- Bold threshold zone bands: emerald <70% · amber 70–90% · rose ≥90%. -->
									<AnnotationRange y={[0, 70]} class="fill-emerald-500/10" />
									<AnnotationRange y={[70, 90]} class="fill-amber-500/15" />
									<AnnotationRange y={[90, 100]} class="fill-rose-500/20" />
									<!-- Threshold-zoned line: color tracks the danger zone the
									     utilization is currently in (one Spline per zone). -->
									<Spline
										seriesKey="headroom"
										defined={(d: { value: number }) => d.value < 70}
										stroke="rgb(16 185 129)"
										stroke-width={1.75}
									/>
									<Spline
										seriesKey="headroom"
										defined={(d: { value: number }) => d.value >= 70 && d.value < 90}
										stroke="rgb(245 158 11)"
										stroke-width={1.75}
									/>
									<Spline
										seriesKey="headroom"
										defined={(d: { value: number }) => d.value >= 90}
										stroke="rgb(244 63 94)"
										stroke-width={1.75}
									/>
								{/snippet}
								{#snippet aboveMarks()}
									<AnnotationLine
										y={70}
										stroke="rgb(245 158 11)"
										stroke-width={1}
										stroke-dasharray="3 2"
										opacity={0.5}
									/>
									<AnnotationLine
										y={90}
										stroke="rgb(239 68 68)"
										stroke-width={1}
										stroke-dasharray="3 2"
										opacity={0.55}
									/>
								{/snippet}
								{#snippet tooltip()}
									<Chart.Tooltip />
								{/snippet}
							</LineChart>
						</Chart.Container>
					</div>
				{/if}
			</div>

			<!-- Chart D: persisted PSI + coverage when ClickHouse has samples; live history otherwise -->
			<div class="rounded-md border bg-background p-3">
				<div class="mb-2 flex items-baseline justify-between">
					<h4 class="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
						PSI + telemetry
					</h4>
					{#if psiWindowed.length > 0}
						{@const last = psiWindowed[psiWindowed.length - 1]}
						<span class="text-[10px] tabular-nums text-muted-foreground">
							mem <span class="font-mono text-foreground">{last.psiMemorySome60?.toFixed(1) ?? '—'}</span>%
						</span>
					{/if}
				</div>
				{#if psiWindowed.filter((p) => p.psiCpuSome60 !== null || p.psiMemorySome60 !== null || p.psiIoSome60 !== null || p.psiCoverageRatioPct !== null).length < 2}
					<p class="py-6 text-center text-[11px] text-muted-foreground/70">
						Waiting for PSI trend samples…
					</p>
				{:else}
					<div style:height="120px">
						<Chart.Container config={psiConfig} class="h-full w-full">
							<LineChart
								data={psiWindowed}
								x="ts"
								yDomain={[0, 100]}
								series={[
									{ key: 'cpu', value: (d: PsiRow) => d.psiCpuSome60, color: 'rgb(14 165 233)' },
									{ key: 'memory', value: (d: PsiRow) => d.psiMemorySome60, color: 'rgb(244 63 94)' },
									{ key: 'io', value: (d: PsiRow) => d.psiIoSome60, color: 'rgb(245 158 11)' },
									{ key: 'coverage', value: (d: PsiRow) => d.psiCoverageRatioPct, color: 'rgb(16 185 129)' }
								]}
								legend={false}
							>
								{#snippet marks()}
									<Spline
										seriesKey="cpu"
										defined={(d: PsiRow) => d.psiCpuSome60 !== null}
										stroke="rgb(14 165 233)"
										stroke-width={1.2}
									/>
									<Spline
										seriesKey="memory"
										defined={(d: PsiRow) => d.psiMemorySome60 !== null}
										stroke="rgb(244 63 94)"
										stroke-width={1.35}
									/>
									<Spline
										seriesKey="io"
										defined={(d: PsiRow) => d.psiIoSome60 !== null}
										stroke="rgb(245 158 11)"
										stroke-width={1.2}
									/>
									<Spline
										seriesKey="coverage"
										defined={(d: PsiRow) => d.psiCoverageRatioPct !== null}
										stroke="rgb(16 185 129)"
										stroke-width={1}
										stroke-dasharray="3 2"
									/>
								{/snippet}
								{#snippet aboveMarks()}
									<AnnotationLine
										y={10}
										stroke="rgb(244 63 94)"
										stroke-width={1}
										stroke-dasharray="3 2"
										opacity={0.45}
									/>
								{/snippet}
								{#snippet tooltip()}
									<Chart.Tooltip />
								{/snippet}
							</LineChart>
						</Chart.Container>
					</div>
					<p class="mt-1 text-[10px] text-muted-foreground">
						{psiTrends?.hasData ? 'ClickHouse metrics' : 'live snapshot history'}
					</p>
				{/if}
			</div>

			<!-- Chart E: utilization % OHLC candlestick (capacity consumed over time) -->
			<div class="rounded-md border bg-background p-3">
				<div class="mb-2 flex items-baseline justify-between">
					<h4 class="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
						{RESOURCE_LABELS[resource]} utilization range (OHLC)
					</h4>
					{#if candles.length > 0}
						{@const last = candles[candles.length - 1]}
						<span class="text-[10px] tabular-nums text-muted-foreground">
							<span
								class="font-mono {last.close >= last.open ? 'text-emerald-500' : 'text-rose-500'}"
							>{last.close.toFixed(0)}</span>%
						</span>
					{/if}
				</div>
				<div style:height="120px">
					<CapacityCandlestick {candles} valueMax={100} height={120} zones={{ warn: 70, crit: 90 }} />
				</div>
			</div>
		</div>
	</CollapsibleContent>
</Collapsible>
