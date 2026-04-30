<script lang="ts">
	type Row = { tool: string; count: number };
	type Props = {
		data: Row[];
		limit?: number;
		class?: string;
	};

	const { data, limit = 10, class: className = '' }: Props = $props();

	const top = $derived(data.slice(0, limit));
	const max = $derived(top.reduce((m, r) => Math.max(m, r.count), 0));
	const total = $derived(data.reduce((a, b) => a + b.count, 0));
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
		<ul class="space-y-1.5">
			{#each top as row (row.tool)}
				<li class="flex items-center gap-2 text-xs">
					<span class="w-32 shrink-0 truncate font-mono">{row.tool}</span>
					<div class="relative h-3 flex-1 overflow-hidden rounded-sm bg-muted/40">
						<div
							class="absolute inset-y-0 left-0 bg-blue-500/70 dark:bg-blue-400/70"
							style:width={`${max > 0 ? (row.count / max) * 100 : 0}%`}
						></div>
					</div>
					<span class="w-10 shrink-0 text-right font-semibold tabular-nums">
						{row.count}
					</span>
				</li>
			{/each}
		</ul>
	{/if}
</div>
