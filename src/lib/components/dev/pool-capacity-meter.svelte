<script lang="ts">
	import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '$lib/components/ui/tooltip';
	import { Snowflake } from '@lucide/svelte';
	import type { VclusterPreviewCounts } from '$lib/types/dev-previews';

	let { counts }: { counts: VclusterPreviewCounts | null } = $props();

	type Segment = { key: string; label: string; value: number; class: string; hint: string };

	// PreviewEnvironment launches are cold-only. Legacy pool counters are ignored.
	const segments = $derived.by<Segment[]>(() => {
		if (!counts) return [];
		return counts.awake > 0
			? [{ key: 'active', label: 'Active', value: counts.awake, class: 'bg-sky-500', hint: 'Cold-provisioned preview environments currently awake.' }]
			: [];
	});

	const max = $derived(counts && counts.max > 0 ? counts.max : 0);
	const awake = $derived(counts?.awake ?? 0);
	// Empty (unused) slots to pad the bar out to `max`.
	const empty = $derived(Math.max(0, max - awake));
	const denom = $derived(Math.max(max, awake, 1));
	const totalMaxLabel = $derived(counts && counts.totalMax > 0 ? String(counts.totalMax) : '∞');
</script>

<div class="rounded-lg border bg-muted/20 p-3 space-y-2">
	<div class="flex items-center justify-between gap-2 text-xs">
		<span class="font-medium">Preview capacity</span>
		{#if counts}
			<span
				class="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-muted-foreground"
			>
				<Snowflake class="size-3" /> isolated cold launch
			</span>
		{/if}
	</div>

	{#if !counts}
		<div class="h-2.5 w-full rounded-full bg-muted"></div>
		<p class="text-[11px] text-muted-foreground">Capacity unavailable (older SEA or list error).</p>
	{:else}
		<TooltipProvider>
			<div class="flex h-2.5 w-full overflow-hidden rounded-full bg-muted" role="img" aria-label="Preview capacity">
				{#each segments as seg (seg.key)}
					<Tooltip>
						<TooltipTrigger
							class="{seg.class} h-full"
							style="width: {(seg.value / denom) * 100}%"
							aria-label="{seg.label}: {seg.value}"
						></TooltipTrigger>
						<TooltipContent>
							<p class="text-xs"><span class="font-medium">{seg.label} · {seg.value}</span></p>
							<p class="max-w-[220px] text-xs text-muted-foreground">{seg.hint}</p>
						</TooltipContent>
					</Tooltip>
				{/each}
				{#if empty > 0}
					<div class="h-full" style="width: {(empty / denom) * 100}%"></div>
				{/if}
			</div>
		</TooltipProvider>

		<div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
			<span>awake <span class="font-medium text-foreground">{awake}/{max || '—'}</span></span>
			<span>total <span class="font-medium text-foreground">{counts.total}/{totalMaxLabel}</span></span>
			{#if counts.slept > 0}<span>· {counts.slept} slept</span>{/if}
			{#each segments as seg (seg.key)}
				<span class="inline-flex items-center gap-1">
					<span class="size-2 rounded-full {seg.class}"></span>{seg.label} {seg.value}
				</span>
			{/each}
		</div>
	{/if}
</div>
