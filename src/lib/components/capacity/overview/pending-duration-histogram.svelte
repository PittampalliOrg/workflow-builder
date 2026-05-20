<script lang="ts">
	/**
	 * Buckets blocked workloads by how long they've been pending.
	 *
	 * Renders a horizontal LayerChart BarChart with four buckets:
	 * `<30s`, `30s–2m`, `2m–10m`, `10m+`. Clicking a bucket emits `onSelect`
	 * with the bucket key — the parent uses that to filter or scroll the
	 * blocked-workloads list below.
	 */
	import * as Chart from '$lib/components/ui/chart';
	import { BarChart } from 'layerchart';
	import type { CapacityBlockedWorkload } from '$lib/types/capacity';

	type BucketKey = 'lt30s' | 'lt2m' | 'lt10m' | 'gte10m';

	type Props = {
		workloads: CapacityBlockedWorkload[];
		selected?: BucketKey | null;
		onSelect?: (bucket: BucketKey | null) => void;
		class?: string;
	};

	let { workloads, selected = null, onSelect, class: className = '' }: Props = $props();

	const BUCKETS: Array<{ key: BucketKey; label: string; min: number; max: number }> = [
		{ key: 'lt30s', label: '< 30s', min: 0, max: 30 },
		{ key: 'lt2m', label: '30s–2m', min: 30, max: 120 },
		{ key: 'lt10m', label: '2m–10m', min: 120, max: 600 },
		{ key: 'gte10m', label: '10m+', min: 600, max: Number.POSITIVE_INFINITY }
	];

	const buckets = $derived.by(() => {
		const counts: Record<BucketKey, number> = { lt30s: 0, lt2m: 0, lt10m: 0, gte10m: 0 };
		for (const wl of workloads) {
			const s = wl.pendingSeconds;
			if (s < 30) counts.lt30s += 1;
			else if (s < 120) counts.lt2m += 1;
			else if (s < 600) counts.lt10m += 1;
			else counts.gte10m += 1;
		}
		return BUCKETS.map((b) => ({
			key: b.key,
			label: b.label,
			count: counts[b.key]
		}));
	});

	const total = $derived(workloads.length);
	const maxCount = $derived(Math.max(1, ...buckets.map((b) => b.count)));

	let chartConfig = {
		count: { label: 'Pending', color: 'var(--chart-1)' }
	} satisfies Chart.ChartConfig;

	function handleClick(bucket: BucketKey) {
		if (!onSelect) return;
		onSelect(selected === bucket ? null : bucket);
	}
</script>

<div class="rounded-md border border-border bg-background p-3 {className}">
	<div class="mb-2 flex items-center justify-between">
		<h3 class="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
			Pending duration
		</h3>
		<span class="text-[10px] text-muted-foreground">
			{total} blocked
			{#if selected}
				· filtered: <button
					type="button"
					class="font-mono text-foreground hover:underline"
					onclick={() => onSelect?.(null)}
				>
					{BUCKETS.find((b) => b.key === selected)?.label} ×
				</button>
			{/if}
		</span>
	</div>

	{#if total === 0}
		<p class="py-3 text-center text-[11px] text-muted-foreground/70">
			No blocked workloads.
		</p>
	{:else}
		<div style:height="140px">
			<Chart.Container config={chartConfig} class="h-full w-full">
				<BarChart
					data={buckets}
					orientation="horizontal"
					x="count"
					y="label"
					bandPadding={0.3}
					xDomain={[0, maxCount]}
					series={[{ key: 'count', value: (d: { count: number }) => d.count, color: 'var(--chart-1)' }]}
					onBarClick={(_e, detail) => {
						const data = detail.data as { key?: BucketKey } | undefined;
						if (data?.key) handleClick(data.key);
					}}
				>
					{#snippet tooltip()}
						<Chart.Tooltip />
					{/snippet}
				</BarChart>
			</Chart.Container>
		</div>
		<p class="mt-1.5 text-[10px] text-muted-foreground/70">
			Click a bucket to filter the list below.
		</p>
	{/if}
</div>
