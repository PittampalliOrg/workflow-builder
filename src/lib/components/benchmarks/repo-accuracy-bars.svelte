<script lang="ts">
	type Bar = { repo: string; total: number; resolved: number; resolvedRate: number };

	type Props = {
		data: Bar[];
		/** Max bars to render. Smaller repos collapse into "other". */
		maxBars?: number;
		class?: string;
	};

	const { data, maxBars = 12, class: className = '' }: Props = $props();

	const visible = $derived.by(() => {
		if (data.length <= maxBars) return data;
		const head = data.slice(0, maxBars - 1);
		const tail = data.slice(maxBars - 1);
		const totalTail = tail.reduce((a, b) => a + b.total, 0);
		const resolvedTail = tail.reduce((a, b) => a + b.resolved, 0);
		head.push({
			repo: `+${tail.length} more`,
			total: totalTail,
			resolved: resolvedTail,
			resolvedRate: totalTail > 0 ? resolvedTail / totalTail : 0
		});
		return head;
	});

	function color(rate: number): string {
		if (rate >= 0.7) return 'rgb(16 185 129)'; // emerald
		if (rate >= 0.4) return 'rgb(59 130 246)'; // blue
		if (rate >= 0.15) return 'rgb(245 158 11)'; // amber
		return 'rgb(239 68 68)'; // red
	}
</script>

<div class="rounded-md border border-border bg-background p-4 {className}">
	<div class="mb-3 flex items-center justify-between">
		<h3 class="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
			By repository
		</h3>
		<span class="text-[10px] text-muted-foreground">{data.length} repos</span>
	</div>
	{#if data.length === 0}
		<p class="py-6 text-center text-xs text-muted-foreground">No data yet.</p>
	{:else}
		<div class="space-y-1.5">
			{#each visible as bar (bar.repo)}
				{@const pct = Math.round(bar.resolvedRate * 100)}
				<div>
					<div class="flex items-baseline justify-between gap-2 text-[11px]">
						<span class="truncate font-mono text-muted-foreground" title={bar.repo}>{bar.repo}</span>
						<span class="shrink-0 tabular-nums">
							<span class="font-semibold">{bar.resolved}</span>
							<span class="text-muted-foreground">/{bar.total}</span>
							<span class="ml-1 text-muted-foreground">({pct}%)</span>
						</span>
					</div>
					<div class="mt-0.5 h-1.5 overflow-hidden rounded-full bg-muted">
						<div
							class="h-full transition-all"
							style:width="{Math.min(100, pct)}%"
							style:background-color={color(bar.resolvedRate)}
						></div>
					</div>
				</div>
			{/each}
		</div>
	{/if}
</div>
