<script lang="ts">
	import { ChevronLeft, ChevronRight, Package } from "@lucide/svelte";

	import { Badge } from "$lib/components/ui/badge";
	import type { PipelineFreight, PipelineModel } from "$lib/gitops/pipeline-types";

	import FreightCard from "./FreightCard.svelte";

	type Props = {
		model: PipelineModel;
		pipelineFilter?: string[];
		selectedFreightId?: string | null;
		onselect?: (freightId: string | null) => void;
	};
	let { model, pipelineFilter = [], selectedFreightId = null, onselect }: Props = $props();

	const CARD_GAP = 4;
	const MIN_CARD_WIDTH = 140;

	const freights = $derived.by((): PipelineFreight[] => {
		if (pipelineFilter.length === 0) return model.freights;
		const set = new Set(pipelineFilter);
		return model.freights.filter((f) => set.has(f.warehouse));
	});

	let viewportEl = $state<HTMLDivElement>();
	let stripEl = $state<HTMLDivElement>();
	let cardWidth = $state(MIN_CARD_WIDTH);
	let offset = $state(0);
	let maxOffset = $state(0);

	// Exact per-card width so N cards fill the viewport with no peek-through
	// (ported from Kargo's use-freight-carousel width math).
	$effect(() => {
		const vp = viewportEl;
		if (!vp) return;
		const compute = () => {
			const W = vp.getBoundingClientRect().width;
			if (W <= 0) return;
			const n = Math.max(1, Math.floor((W + CARD_GAP) / (MIN_CARD_WIDTH + CARD_GAP)));
			cardWidth = (W - (n - 1) * CARD_GAP) / n;
			offset = 0;
		};
		compute();
		const ro = new ResizeObserver(compute);
		ro.observe(vp);
		return () => ro.disconnect();
	});

	// Track overflow so the chevrons enable/disable correctly.
	$effect(() => {
		void freights;
		void cardWidth;
		const vp = viewportEl;
		const strip = stripEl;
		if (!vp || !strip) {
			maxOffset = 0;
			return;
		}
		maxOffset = Math.max(0, strip.scrollWidth - vp.getBoundingClientRect().width);
		if (offset > maxOffset) offset = maxOffset;
	});

	const canSlideLeft = $derived(offset > 0);
	const canSlideRight = $derived(offset < maxOffset - 1);

	function slide(dir: -1 | 1) {
		const vp = viewportEl;
		if (!vp) return;
		const stride = vp.getBoundingClientRect().width + CARD_GAP;
		offset = Math.min(maxOffset, Math.max(0, offset + dir * stride));
	}
</script>

<div class="flex items-stretch gap-1 border-b bg-card px-2 py-2">
	<div class="flex shrink-0 items-center gap-1.5 pr-2 text-[0.68rem] text-muted-foreground">
		<Package class="size-3.5" />
		<span class="font-medium">Freight</span>
		<Badge variant="outline" class="h-4 px-1 text-[0.55rem]">{freights.length}</Badge>
	</div>

	<button
		type="button"
		class="flex w-6 shrink-0 items-center justify-center rounded text-muted-foreground transition hover:bg-muted disabled:opacity-30"
		disabled={!canSlideLeft}
		onclick={() => slide(-1)}
		aria-label="Scroll freight left"
	>
		<ChevronLeft class="size-4" />
	</button>

	<div bind:this={viewportEl} class="relative flex-1 overflow-hidden">
		{#if freights.length === 0}
			<div class="flex h-[112px] items-center text-xs text-muted-foreground">
				No freight for the selected pipeline.
			</div>
		{:else}
			<div
				bind:this={stripEl}
				class="flex"
				style={`gap:${CARD_GAP}px;transform:translateX(-${offset}px);transition:transform 0.25s ease;`}
			>
				{#each freights as freight (freight.id)}
					<FreightCard
						{freight}
						{model}
						width={cardWidth}
						selected={selectedFreightId === freight.id}
						onclick={() => onselect?.(selectedFreightId === freight.id ? null : freight.id)}
					/>
				{/each}
			</div>
		{/if}
	</div>

	<button
		type="button"
		class="flex w-6 shrink-0 items-center justify-center rounded text-muted-foreground transition hover:bg-muted disabled:opacity-30"
		disabled={!canSlideRight}
		onclick={() => slide(1)}
		aria-label="Scroll freight right"
	>
		<ChevronRight class="size-4" />
	</button>
</div>
