<script lang="ts">
	/**
	 * Preview-capacity meter (control-plane header of the previews panel).
	 * Layerchart mini-donut of awake / slept / free slots plus stat tiles for the
	 * two capacity budgets: awake/max (compute) and total/totalMax (records).
	 * PreviewEnvironment launches are cold-only; legacy pool counters are ignored.
	 */
	import { PieChart } from 'layerchart';
	import { Moon, Snowflake, Zap } from '@lucide/svelte';
	import * as Chart from '$lib/components/ui/chart';
	import type { VclusterPreviewCounts } from '$lib/types/dev-previews';

	let { counts }: { counts: VclusterPreviewCounts | null } = $props();

	type Slice = { key: string; label: string; value: number; fill: string };

	const awake = $derived(counts?.awake ?? 0);
	const slept = $derived(counts?.slept ?? 0);
	const max = $derived(counts && counts.max > 0 ? counts.max : 0);
	const total = $derived(counts?.total ?? 0);
	const totalMaxLabel = $derived(counts && counts.totalMax > 0 ? String(counts.totalMax) : '∞');
	const freeSlots = $derived(Math.max(0, max - awake));
	const atCapacity = $derived(max > 0 && awake >= max);

	const slices = $derived.by<Slice[]>(() => {
		if (!counts) return [];
		const rows: Slice[] = [];
		if (awake > 0)
			rows.push({ key: 'awake', label: 'Awake', value: awake, fill: 'var(--chart-1)' });
		if (slept > 0)
			rows.push({ key: 'slept', label: 'Slept', value: slept, fill: 'var(--chart-4)' });
		if (freeSlots > 0)
			rows.push({
				key: 'free',
				label: 'Free slots',
				value: freeSlots,
				fill: 'color-mix(in srgb, var(--muted-foreground) 18%, transparent)'
			});
		return rows;
	});

	let chartConfig = {
		value: { label: 'Previews', color: 'var(--chart-1)' }
	} satisfies Chart.ChartConfig;
</script>

<div class="rounded-lg border bg-muted/20 p-3">
	<div class="flex items-center justify-between gap-2 text-xs">
		<span class="font-medium">Preview capacity</span>
		{#if counts}
			<span class="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-muted-foreground">
				<Snowflake class="size-3" /> isolated cold launch
			</span>
		{/if}
	</div>

	{#if !counts}
		<div class="mt-2 h-2.5 w-full rounded-full bg-muted"></div>
		<p class="mt-2 text-[11px] text-muted-foreground">Capacity unavailable (older SEA or list error).</p>
	{:else}
		<div class="mt-2 flex flex-wrap items-center gap-4">
			<div class="relative shrink-0" role="img" aria-label={`Preview capacity: ${awake} awake of ${max || 'unlimited'} slots, ${slept} slept`}>
				<Chart.Container config={chartConfig} class="h-20 w-20">
					<PieChart
						data={slices.length > 0 ? slices : [{ key: 'empty', label: 'Empty', value: 1, fill: 'color-mix(in srgb, var(--muted-foreground) 12%, transparent)' }]}
						key="key"
						value="value"
						c={(d: Slice) => d.fill}
						innerRadius={0.68}
						padAngle={0.03}
					>
						{#snippet tooltip()}
							<Chart.Tooltip hideLabel />
						{/snippet}
					</PieChart>
				</Chart.Container>
				<div class="pointer-events-none absolute inset-0 flex flex-col items-center justify-center leading-none" aria-hidden="true">
					<span class="text-sm font-semibold tabular-nums {atCapacity ? 'text-amber-600 dark:text-amber-400' : ''}">{awake}</span>
					<span class="text-[9px] text-muted-foreground">of {max || '—'}</span>
				</div>
			</div>

			<div class="grid min-w-0 flex-1 grid-cols-2 gap-2 sm:grid-cols-4">
				<div class="min-w-0 rounded-md border bg-background/60 px-2.5 py-2">
					<div class="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-muted-foreground">
						<Zap class="size-3 text-sky-500" /> Awake
					</div>
					<div class="mt-0.5 text-base font-semibold tabular-nums {atCapacity ? 'text-amber-600 dark:text-amber-400' : ''}">
						{awake}<span class="text-xs font-normal text-muted-foreground">/{max || '—'}</span>
					</div>
				</div>
				<div class="min-w-0 rounded-md border bg-background/60 px-2.5 py-2">
					<div class="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-muted-foreground">
						<Moon class="size-3 text-indigo-500" /> Slept
					</div>
					<div class="mt-0.5 text-base font-semibold tabular-nums">{slept}</div>
				</div>
				<div class="min-w-0 rounded-md border bg-background/60 px-2.5 py-2">
					<div class="text-[10px] uppercase tracking-wide text-muted-foreground">Total</div>
					<div class="mt-0.5 text-base font-semibold tabular-nums">
						{total}<span class="text-xs font-normal text-muted-foreground">/{totalMaxLabel}</span>
					</div>
				</div>
				<div class="min-w-0 rounded-md border bg-background/60 px-2.5 py-2">
					<div class="text-[10px] uppercase tracking-wide text-muted-foreground">Free slots</div>
					<div class="mt-0.5 text-base font-semibold tabular-nums {atCapacity ? 'text-amber-600 dark:text-amber-400' : ''}">
						{max > 0 ? freeSlots : '—'}
					</div>
				</div>
			</div>
		</div>

		{#if atCapacity}
			<p class="mt-2 text-[11px] text-amber-700 dark:text-amber-300">
				Awake capacity is full — sleep or tear down a preview to free a slot before launching.
			</p>
		{/if}
	{/if}
</div>
