<script lang="ts">
	import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '$lib/components/ui/tooltip';
	import { Zap, Snowflake } from '@lucide/svelte';
	import type { VclusterPreviewCounts } from '$lib/types/dev-previews';

	let { counts }: { counts: VclusterPreviewCounts | null } = $props();

	type Segment = { key: string; label: string; value: number; class: string; pulse?: boolean; hint: string };

	// Awake-slot composition against `max`. `claimed`+`free`+`baking` come from
	// the SEA counts; the remainder of awake is regular (non-pool) hot previews.
	const segments = $derived.by<Segment[]>(() => {
		if (!counts) return [];
		const claimed = Math.max(0, counts.claimed);
		const free = Math.max(0, counts.free);
		const baking = Math.max(0, counts.baking);
		const other = Math.max(0, counts.awake - claimed - free - baking);
		return [
			{ key: 'claimed', label: 'In use', value: claimed, class: 'bg-sky-500', hint: 'Previews claimed and running.' },
			{ key: 'other', label: 'Active', value: other, class: 'bg-indigo-500', hint: 'Cold-provisioned previews not backed by the warm pool.' },
			{ key: 'free', label: 'Warm', value: free, class: 'bg-emerald-500', hint: 'Pre-baked pool members — a launch claims one instantly.' },
			{ key: 'baking', label: 'Baking', value: baking, class: 'bg-amber-500', pulse: true, hint: 'Pool members still provisioning (an up-Job is running).' }
		].filter((s) => s.value > 0);
	});

	const max = $derived(counts && counts.max > 0 ? counts.max : 0);
	const awake = $derived(counts?.awake ?? 0);
	// Empty (unused) slots to pad the bar out to `max`.
	const empty = $derived(Math.max(0, max - awake));
	const denom = $derived(Math.max(max, awake, 1));
	const instant = $derived((counts?.free ?? 0) > 0);
	const totalMaxLabel = $derived(counts && counts.totalMax > 0 ? String(counts.totalMax) : '∞');
</script>

<div class="rounded-lg border bg-muted/20 p-3 space-y-2">
	<div class="flex items-center justify-between gap-2 text-xs">
		<span class="font-medium">Pool capacity</span>
		{#if counts}
			<span
				class="inline-flex items-center gap-1 rounded px-1.5 py-0.5 {instant
					? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
					: 'bg-muted text-muted-foreground'}"
			>
				{#if instant}<Zap class="size-3" /> instant claims{:else}<Snowflake class="size-3" /> cold boot ~5 min{/if}
			</span>
		{/if}
	</div>

	{#if !counts}
		<div class="h-2.5 w-full rounded-full bg-muted"></div>
		<p class="text-[11px] text-muted-foreground">Capacity unavailable (older SEA or list error).</p>
	{:else}
		<TooltipProvider>
			<div class="flex h-2.5 w-full overflow-hidden rounded-full bg-muted" role="img" aria-label="Preview pool capacity">
				{#each segments as seg (seg.key)}
					<Tooltip>
						<TooltipTrigger
							class="{seg.class} {seg.pulse ? 'animate-pulse' : ''} h-full"
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
