<script lang="ts">
	import * as Chart from '$lib/components/ui/chart';
	import { PieChart } from 'layerchart';

	type Slice = { reason: string; count: number };
	type Datum = { reason: string; count: number; fill: string };
	type Props = {
		data: Slice[];
		class?: string;
	};

	const { data, class: className = '' }: Props = $props();

	const total = $derived(data.reduce((a, b) => a + b.count, 0));

	// Termination semantics → CSS variable color (resolved by Chart.Container).
	// end_turn = green (clean), max_iters = amber, *_breaker / timeout / error = red,
	// cancelled = gray, anything else = slate.
	function colorVar(reason: string): string {
		switch (reason) {
			case 'end_turn':
				return 'var(--color-end_turn)';
			case 'max_iters':
				return 'var(--color-max_iters)';
			case 'circuit_breaker_empty':
			case 'circuit_breaker_failure':
			case 'session_turn_timeout':
			case 'agent_error':
				return 'var(--color-error)';
			case 'cancelled':
				return 'var(--color-cancelled)';
			default:
				return 'var(--color-other)';
		}
	}

	let chartConfig = {
		end_turn: { label: 'end_turn', color: 'rgb(16 185 129)' },
		max_iters: { label: 'max_iters', color: 'rgb(245 158 11)' },
		error: { label: 'error', color: 'rgb(239 68 68)' },
		cancelled: { label: 'cancelled', color: 'rgb(156 163 175)' },
		other: { label: 'other', color: 'rgb(100 116 139)' }
	} satisfies Chart.ChartConfig;

	let chartData = $derived(
		data.map((s) => ({
			reason: s.reason,
			count: s.count,
			fill: colorVar(s.reason)
		}))
	);
</script>

<div class="rounded-md border border-border bg-background p-4 {className}">
	<div class="mb-3 flex items-center justify-between">
		<h3 class="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
			By termination
		</h3>
		<span class="text-[10px] text-muted-foreground">{total} reported</span>
	</div>
	{#if total === 0}
		<p class="py-6 text-center text-xs text-muted-foreground">
			No termination data yet — runs predating Phase B won't have it.
		</p>
	{:else}
		<div class="flex items-center gap-4">
			<Chart.Container config={chartConfig} class="h-32 w-32 shrink-0">
				<PieChart
					data={chartData}
					key="reason"
					value="count"
					c={(d: Datum) => d.fill}
					innerRadius={0.55}
					padAngle={0.02}
				>
					{#snippet tooltip()}
						<Chart.Tooltip hideLabel />
					{/snippet}
				</PieChart>
			</Chart.Container>
			<ul class="flex-1 space-y-1 text-xs">
				{#each data as s (s.reason)}
					<li class="flex items-center justify-between gap-2">
						<span class="flex min-w-0 items-center gap-2">
							<span
								class="block h-2.5 w-2.5 shrink-0 rounded-sm"
								style:background-color={colorVar(s.reason)}
								aria-hidden="true"
							></span>
							<span class="truncate font-mono">{s.reason}</span>
						</span>
						<span class="shrink-0 tabular-nums">
							<span class="font-semibold">{s.count}</span>
							<span class="text-muted-foreground">
								({Math.round((s.count / total) * 100)}%)
							</span>
						</span>
					</li>
				{/each}
			</ul>
		</div>
	{/if}
</div>
