<script lang="ts">
	/**
	 * Donut breakdown of where the active workload pressure lives.
	 *
	 * Slices are ClusterQueues. Size of each slice = admitted + pending +
	 * reserving on that queue. Tooltip shows the per-status breakdown.
	 *
	 * Originally planned as a "per-flavor allocatable" donut, but
	 * `ResourceFlavorSnapshot` only carries metadata (node labels/taints) and
	 * the observer reports a single active flavor — there's nothing to size
	 * the slices by. "Workloads by queue" is the meaningful distribution we
	 * actually have at this layer.
	 */
	import * as Chart from '$lib/components/ui/chart';
	import { PieChart } from 'layerchart';
	import type { ClusterQueueSnapshot } from '$lib/server/kueueviz';

	type Props = {
		queues: ClusterQueueSnapshot[];
		class?: string;
	};

	let { queues, class: className = '' }: Props = $props();

	// Palette — re-uses the same Tailwind chart color slots the existing
	// LayerChart-rendered components already pick up via Chart.Container.
	const PALETTE = [
		'var(--chart-1)',
		'var(--chart-2)',
		'var(--chart-3)',
		'var(--chart-4)',
		'var(--chart-5)',
		'var(--chart-1, hsl(220 70% 50%))',
		'var(--chart-2, hsl(160 60% 45%))'
	];

	type Slice = {
		queue: string;
		active: number;
		admitted: number;
		pending: number;
		reserving: number;
		fill: string;
	};

	const slices = $derived.by<Slice[]>(() => {
		const rows = queues
			.map((q) => ({
				queue: q.name,
				admitted: q.admittedWorkloads,
				pending: q.pendingWorkloads,
				reserving: q.reservingWorkloads,
				active: q.admittedWorkloads + q.pendingWorkloads + q.reservingWorkloads
			}))
			.filter((r) => r.active > 0)
			.sort((a, b) => b.active - a.active);
		return rows.map((r, i) => ({ ...r, fill: PALETTE[i % PALETTE.length] }));
	});

	const total = $derived(slices.reduce((acc, s) => acc + s.active, 0));

	let chartConfig = {
		active: { label: 'Active workloads', color: 'var(--chart-1)' }
	} satisfies Chart.ChartConfig;
</script>

<div class="rounded-md border border-border bg-background p-3 {className}">
	<div class="mb-2 flex items-center justify-between">
		<h3 class="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
			Workloads by queue
		</h3>
		<span class="text-[10px] text-muted-foreground">{total} active</span>
	</div>
	{#if total === 0}
		<p class="py-6 text-center text-[11px] text-muted-foreground/70">
			No active workloads across cluster queues.
		</p>
	{:else}
		<div class="flex items-center gap-3">
			<Chart.Container config={chartConfig} class="h-28 w-28 shrink-0">
				<PieChart
					data={slices}
					key="queue"
					value="active"
					c={(d: Slice) => d.fill}
					innerRadius={0.55}
					padAngle={0.02}
				>
					{#snippet tooltip()}
						<Chart.Tooltip hideLabel />
					{/snippet}
				</PieChart>
			</Chart.Container>
			<ul class="flex-1 space-y-1 text-[11px]">
				{#each slices as s (s.queue)}
					<li class="flex items-center justify-between gap-2">
						<span class="flex min-w-0 items-center gap-1.5">
							<span
								class="block size-2.5 shrink-0 rounded-sm"
								style:background-color={s.fill}
								aria-hidden="true"
							></span>
							<span class="truncate font-mono" title={s.queue}>{s.queue}</span>
						</span>
						<span class="shrink-0 tabular-nums text-muted-foreground">
							<span class="font-semibold text-foreground">{s.active}</span>
							<span class="text-muted-foreground/70">
								({Math.round((s.active / total) * 100)}%)
							</span>
						</span>
					</li>
				{/each}
			</ul>
		</div>
	{/if}
</div>
