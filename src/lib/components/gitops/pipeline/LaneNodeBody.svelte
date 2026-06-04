<script lang="ts">
	import { getContext } from "svelte";
	import { Boxes, Warehouse } from "@lucide/svelte";

	import { healthVisual } from "$lib/gitops/kargo-status";
	import { PIPELINE_HOVER_CONTEXT, type PipelineHoverContext } from "$lib/gitops/pipeline-layout";
	import type { PipelineStage, PipelineWarehouse } from "$lib/gitops/pipeline-types";
	import { shortTag } from "$lib/utils/gitops-display";

	type Props = {
		warehouse?: PipelineWarehouse;
		stages: PipelineStage[];
		color?: string;
		selected?: boolean;
	};
	let { warehouse, stages, color, selected = false }: Props = $props();

	const hover = getContext<PipelineHoverContext | undefined>(PIPELINE_HOVER_CONTEXT);
	const name = $derived(warehouse?.name ?? stages[0]?.warehouse ?? "");
	const isBundle = $derived(warehouse?.kind === "bundle");

	function envStatus(stage: PipelineStage): string {
		if (stage.dormant) return "dormant";
		if (stage.rollup) return `${stage.rollup.synced}/${stage.rollup.total}`;
		return stage.desiredTag ? shortTag(stage.desiredTag) : "";
	}
</script>

<div
	role="group"
	onmouseenter={() => hover?.setHovered(name)}
	onmouseleave={() => hover?.setHovered(null)}
	class="flex h-[130px] w-[270px] flex-col overflow-hidden rounded-lg border bg-card text-card-foreground shadow-sm transition hover:shadow-md {selected
		? 'ring-2 ring-primary/50'
		: ''}"
	style={color ? `border-left:4px solid ${color};` : ""}
>
	<div class="flex items-center gap-1.5 border-b px-3 py-1.5" style={color ? `background:${color}1a` : ""}>
		{#if isBundle}<Boxes class="size-3.5 shrink-0" />{:else}<Warehouse class="size-3.5 shrink-0" />{/if}
		<span class="truncate text-xs font-semibold" title={name}>{name}</span>
		<span class="ml-auto shrink-0 text-[0.58rem] text-muted-foreground">{stages.length} env</span>
	</div>
	<div class="flex flex-1 flex-col divide-y">
		{#each stages as stage (stage.name)}
			{@const v = healthVisual(stage.health)}
			{@const Icon = v.icon}
			<div class="flex items-center gap-2 px-3 py-1 text-[0.66rem] {stage.dormant ? 'opacity-60' : ''}">
				<span class="w-12 shrink-0 font-medium">{stage.env}</span>
				<span class="flex items-center gap-1" style={`color:${v.color}`} title={v.label}>
					{#if Icon}<Icon class={v.spin ? "size-3 animate-spin" : "size-3"} />{/if}
				</span>
				<span class="ml-auto truncate font-mono text-[0.6rem] text-muted-foreground">{envStatus(stage)}</span>
			</div>
		{/each}
	</div>
</div>
