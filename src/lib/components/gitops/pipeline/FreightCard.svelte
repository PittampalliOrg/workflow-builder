<script lang="ts">
	import { Boxes, Clock3, Container, GitBranch, Warehouse } from "@lucide/svelte";

	import { nowTick } from "$lib/gitops/gitops-tick.svelte";
	import type { PipelineFreight, PipelineModel } from "$lib/gitops/pipeline-types";
	import { formatAbsoluteTime, relativeTime, shortDigest, shortSha, shortTag } from "$lib/utils/gitops-display";

	type Props = {
		freight: PipelineFreight;
		model: PipelineModel;
		width: number;
		selected?: boolean;
		onclick?: () => void;
	};
	let { freight, model, width, selected = false, onclick }: Props = $props();

	// One coloured bar per stage that currently holds this freight (in-use).
	const bars = $derived(
		freight.inStages.map((s) => model.stageColorMap[s]).filter((c): c is string => Boolean(c)),
	);
	const warehouseColor = $derived(model.warehouseColorMap[freight.warehouse]);
	const isBundle = $derived(freight.warehouse === "release-pins");
</script>

<button
	type="button"
	{onclick}
	style={`width:${width}px`}
	class="relative flex h-[112px] shrink-0 flex-col overflow-hidden rounded-md border bg-card p-2 pl-3 text-left transition hover:border-primary/40 {selected
		? 'ring-2 ring-primary/40'
		: ''}"
>
	<!-- in-use identity bars -->
	<div class="absolute inset-y-0 left-0 flex">
		{#if bars.length}
			{#each bars as c}<span class="w-1" style={`background:${c}`}></span>{/each}
		{:else}
			<span class="w-1 bg-muted"></span>
		{/if}
	</div>

	<div class="flex items-center gap-1">
		{#if isBundle}
			<Boxes class="size-3 shrink-0" style={warehouseColor ? `color:${warehouseColor}` : ""} />
		{:else}
			<Warehouse class="size-3 shrink-0" style={warehouseColor ? `color:${warehouseColor}` : ""} />
		{/if}
		<span class="truncate text-[0.66rem] font-semibold" title={freight.warehouse}>{freight.warehouse}</span>
	</div>

	<div class="mt-1 flex flex-1 flex-col gap-0.5 overflow-hidden">
		{#each freight.artifacts.slice(0, 2) as art}
			{#if art.kind === "image"}
				<div class="flex items-center gap-1 truncate font-mono text-[0.6rem]" title={art.tag ?? art.repoURL}>
					<Container class="size-2.5 shrink-0 text-muted-foreground" />
					<span class="truncate">{art.tag ? shortTag(art.tag) : "image"}</span>
				</div>
				{#if art.digest}
					<div class="truncate font-mono text-[0.55rem] text-muted-foreground" title={art.digest}>
						{shortDigest(art.digest)}
					</div>
				{/if}
			{:else if art.kind === "git"}
				<div class="flex items-center gap-1 truncate font-mono text-[0.6rem]" title={art.message ?? art.repoURL}>
					<GitBranch class="size-2.5 shrink-0 text-muted-foreground" />
					<span class="truncate">{art.sha ? shortSha(art.sha) : "config"}</span>
				</div>
			{/if}
		{/each}
		{#if freight.artifacts.length > 2}
			<div class="text-[0.55rem] text-muted-foreground">+{freight.artifacts.length - 2} more</div>
		{/if}
	</div>

	{#if freight.createdAt}
		<div class="mt-auto flex items-center gap-1 text-[0.55rem] text-muted-foreground" title={formatAbsoluteTime(freight.createdAt, nowTick())}>
			<Clock3 class="size-2.5" />{relativeTime(freight.createdAt, nowTick())}
		</div>
	{/if}
</button>
