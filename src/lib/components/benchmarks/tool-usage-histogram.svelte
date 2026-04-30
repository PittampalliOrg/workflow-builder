<script lang="ts">
	import * as Chart from '$lib/components/ui/chart';
	import { BarChart } from 'layerchart';

	type Row = { tool: string; count: number };
	type Props = {
		data: Row[];
		limit?: number;
		class?: string;
	};

	const { data, limit = 10, class: className = '' }: Props = $props();

	const top = $derived(data.slice(0, limit));
	const total = $derived(data.reduce((a, b) => a + b.count, 0));

	let chartConfig = {
		count: { label: 'Calls', color: 'var(--chart-1)' }
	} satisfies Chart.ChartConfig;
</script>

<div class="rounded-md border border-border bg-background p-4 {className}">
	<div class="mb-3 flex items-center justify-between">
		<h3 class="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
			Tool calls (top {limit})
		</h3>
		<span class="text-[10px] text-muted-foreground">{total} total</span>
	</div>
	{#if top.length === 0}
		<p class="py-6 text-center text-xs text-muted-foreground">
			No tool histogram yet. Phase B emits this from agent_workflow's finally-block.
		</p>
	{:else}
		<div style:height="{Math.max(120, top.length * 28)}px">
			<Chart.Container config={chartConfig} class="h-full w-full">
				<BarChart
					data={top}
					orientation="horizontal"
					x="count"
					y="tool"
					bandPadding={0.25}
					series={[{ key: 'count', value: (d: Row) => d.count, color: 'var(--chart-1)' }]}
				>
					{#snippet tooltip()}
						<Chart.Tooltip />
					{/snippet}
				</BarChart>
			</Chart.Container>
		</div>
	{/if}
</div>
