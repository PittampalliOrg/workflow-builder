<script lang="ts">
	import {
		COHORT_DIMENSIONS,
		COHORT_MEASURES,
		pivot,
		type CohortDimension,
		type CohortMeasure,
		type CohortRow,
		type PivotBucket
	} from '$lib/server/benchmarks/stats';

	type Props = {
		rows: CohortRow[];
	};

	const { rows }: Props = $props();

	let dimension = $state<CohortDimension>('repo');
	let measure = $state<CohortMeasure>('resolved_rate');

	let buckets = $derived<PivotBucket[]>(pivot(rows, dimension, measure));

	let measureMeta = $derived(
		COHORT_MEASURES.find((m) => m.id === measure) ?? COHORT_MEASURES[0]
	);

	let maxAbsValue = $derived.by(() => {
		let m = 0;
		for (const b of buckets) {
			if (b.value !== null && Number.isFinite(b.value)) {
				m = Math.max(m, Math.abs(b.value));
			}
		}
		return m;
	});

	function formatValue(v: number | null, format: typeof measureMeta.format): string {
		if (v === null || !Number.isFinite(v)) return '—';
		switch (format) {
			case 'pct':
				return `${(v * 100).toFixed(1)}%`;
			case 'count':
				return v >= 100 ? v.toFixed(0) : v.toFixed(1).replace(/\.0$/, '');
			case 'usd':
				if (v < 0.01) return '< $0.01';
				if (v < 10) return `$${v.toFixed(2)}`;
				return `$${v.toFixed(0)}`;
			case 'tokens':
				if (v < 1_000) return v.toFixed(0);
				if (v < 1_000_000) return `${(v / 1_000).toFixed(1)}k`;
				return `${(v / 1_000_000).toFixed(2)}M`;
			case 'ms':
				if (v < 1000) return `${v.toFixed(0)}ms`;
				return `${(v / 1000).toFixed(1)}s`;
		}
	}

	function barWidthPct(v: number | null): number {
		if (v === null || !Number.isFinite(v) || maxAbsValue === 0) return 0;
		return Math.max(2, Math.min(100, (Math.abs(v) / maxAbsValue) * 100));
	}
</script>

<section class="rounded-md border border-border bg-background">
	<div class="flex flex-wrap items-center gap-2 border-b border-border bg-muted/20 px-3 py-2">
		<span class="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
			Cohort pivot
		</span>
		<div class="flex items-center gap-1.5">
			<label class="text-[10px] text-muted-foreground" for="cohort-dim">By</label>
			<select
				id="cohort-dim"
				class="h-7 rounded border border-border bg-background px-2 text-xs"
				bind:value={dimension}
			>
				{#each COHORT_DIMENSIONS as d (d.id)}
					<option value={d.id}>{d.label}</option>
				{/each}
			</select>
		</div>
		<div class="flex items-center gap-1.5">
			<label class="text-[10px] text-muted-foreground" for="cohort-measure">Measure</label>
			<select
				id="cohort-measure"
				class="h-7 rounded border border-border bg-background px-2 text-xs"
				bind:value={measure}
			>
				{#each COHORT_MEASURES as m (m.id)}
					<option value={m.id}>{m.label}</option>
				{/each}
			</select>
		</div>
		<span class="ml-auto text-[10px] text-muted-foreground">
			{rows.length} instance{rows.length === 1 ? '' : 's'}
		</span>
	</div>

	{#if rows.length === 0 || buckets.length === 0}
		<div class="px-3 py-6 text-center text-xs text-muted-foreground">
			No instance data to pivot.
		</div>
	{:else}
		<ul class="divide-y divide-border">
			{#each buckets as b (b.dimension)}
				<li class="flex items-center gap-3 px-3 py-2">
					<span class="w-32 truncate text-xs font-medium" title={b.dimension}>
						{b.dimension}
					</span>
					<span class="flex-1">
						<span
							class="block h-2 rounded bg-emerald-500/40"
							style="width: {barWidthPct(b.value)}%;"
						></span>
					</span>
					<span class="w-20 text-right text-xs tabular-nums">
						{formatValue(b.value, measureMeta.format)}
					</span>
					<span class="w-12 text-right text-[10px] tabular-nums text-muted-foreground">
						n={b.count}
					</span>
				</li>
			{/each}
		</ul>
	{/if}
</section>
