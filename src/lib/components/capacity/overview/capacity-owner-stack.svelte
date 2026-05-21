<script lang="ts">
	/**
	 * Stacked-by-owner utilization over time: each band is a session / workflow /
	 * benchmark consuming the focused resource (% of allocatable), so the chart
	 * itself correlates the actual entities to the capacity timeline. Hovering a
	 * bucket lists every owner's contribution (built-in tooltip); the legend
	 * links each owner to its detail page. Sourced from
	 * `capacity_observer_owner_requested` via getCapacityOwnerTimeline.
	 */
	import * as Chart from '$lib/components/ui/chart';
	import { AreaChart } from 'layerchart';
	import type { CapacityOwnerTimeline } from '../../../../routes/workspaces/[slug]/capacity/overview/data.remote';

	export type ResolvedOwner = { label: string; href?: string; kind: string };

	type Props = {
		timeline: CapacityOwnerTimeline | null;
		resolveOwner: (kind: string, id: string) => ResolvedOwner;
		height?: number;
	};

	let { timeline, resolveOwner, height = 120 }: Props = $props();

	const PALETTE = [
		'rgb(16 185 129)',
		'rgb(14 165 233)',
		'rgb(168 85 247)',
		'rgb(245 158 11)',
		'rgb(244 63 94)',
		'rgb(34 197 94)',
		'rgb(99 102 241)',
		'rgb(236 72 153)'
	];
	const OTHER_COLOR = 'var(--muted-foreground)';

	// Stable seriesKey per owner (o0, o1, …) — ClickHouse owner keys contain ':'
	// which is invalid in the CSS-var names the chart wrapper derives from keys.
	const owners = $derived(timeline?.owners ?? []);
	const seriesMeta = $derived(
		owners.map((o, i) => ({
			seriesKey: `o${i}`,
			color: PALETTE[i % PALETTE.length],
			...resolveOwner(o.kind, o.id),
			ownerKey: o.key
		}))
	);

	const rows = $derived(
		(timeline?.buckets ?? []).map((b) => {
			const row: Record<string, number | Date> = { ts: new Date(b.t) };
			owners.forEach((o, i) => {
				row[`o${i}`] = b.values[o.key] ?? 0;
			});
			row.other = b.other;
			return row;
		})
	);

	const chartConfig = $derived.by<Chart.ChartConfig>(() => {
		const cfg: Chart.ChartConfig = {};
		for (const s of seriesMeta) cfg[s.seriesKey] = { label: s.label, color: s.color };
		cfg.other = { label: 'other', color: OTHER_COLOR };
		return cfg;
	});

	type StackRow = Record<string, number | Date>;
	const series = $derived([
		...seriesMeta.map((s) => ({
			key: s.seriesKey,
			value: (d: StackRow) => (d[s.seriesKey] as number) ?? 0,
			color: s.color
		})),
		{ key: 'other', value: (d: StackRow) => (d.other as number) ?? 0, color: OTHER_COLOR }
	]);

	const hasData = $derived(rows.length >= 2 && owners.length > 0);
</script>

{#if !hasData}
	<p class="py-6 text-center text-[11px] text-muted-foreground/70">
		Waiting for per-owner samples…
	</p>
{:else}
	<div style:height="{height}px">
		<Chart.Container config={chartConfig} class="h-full w-full">
			<!-- Auto-scaled (not 0–100): per-owner shares are small on a large
			     cluster; auto-scale keeps the entity bands legible. Tooltip + legend
			     still report the actual % of allocatable. -->
			<AreaChart data={rows} x="ts" seriesLayout="stack" {series} legend={false}>
				{#snippet tooltip()}
					<Chart.Tooltip />
				{/snippet}
			</AreaChart>
		</Chart.Container>
	</div>
	<!-- Linked legend: navigate to each owner's detail page. -->
	<ul class="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[10px]">
		{#each seriesMeta as s (s.seriesKey)}
			<li class="inline-flex min-w-0 items-center gap-1">
				<span class="size-2 shrink-0 rounded-sm" style:background-color={s.color} aria-hidden="true"></span>
				{#if s.href}
					<a href={s.href} class="max-w-[12rem] truncate text-muted-foreground hover:text-foreground hover:underline" title={s.label}>{s.label}</a>
				{:else}
					<span class="max-w-[12rem] truncate text-muted-foreground" title={s.label}>{s.label}</span>
				{/if}
			</li>
		{/each}
		<li class="inline-flex items-center gap-1">
			<span class="size-2 shrink-0 rounded-sm bg-muted-foreground/60" aria-hidden="true"></span>
			<span class="text-muted-foreground/70">other</span>
		</li>
	</ul>
{/if}
