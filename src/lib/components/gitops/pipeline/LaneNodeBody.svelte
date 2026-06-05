<script lang="ts">
	import { getContext } from "svelte";
	import { Boxes, Radio, Warehouse } from "@lucide/svelte";

	import { pipelineActivityTone, toneClasses } from "$lib/gitops/activity-tone";
	import { isFlowing } from "$lib/gitops/gitops-flow.svelte";
	import { nowTick } from "$lib/gitops/gitops-tick.svelte";
	import { healthVisual } from "$lib/gitops/kargo-status";
	import { PIPELINE_HOVER_CONTEXT, type PipelineHoverContext } from "$lib/gitops/pipeline-layout";
	import type { PipelineStage, PipelineWarehouse } from "$lib/gitops/pipeline-types";
	import { relativeTime, shortTag } from "$lib/utils/gitops-display";

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
	class="flex h-[130px] w-[270px] flex-col overflow-hidden rounded-xl border border-border/70 bg-card text-card-foreground shadow-sm transition-shadow hover:shadow-md {selected
		? 'ring-2 ring-primary/40'
		: ''} {isFlowing(name) ? 'gitops-flow' : ''}"
	style={color ? `border-left:3px solid ${color};` : ""}
>
	<div class="flex items-center gap-1.5 border-b border-border/60 px-3 py-2" style={color ? `background:${color}0d` : ""}>
		<span class="flex size-5 shrink-0 items-center justify-center rounded-md bg-muted/60 text-muted-foreground">
			{#if isBundle}<Boxes class="size-3.5" />{:else}<Warehouse class="size-3.5" />{/if}
		</span>
		<span class="truncate text-[0.8rem] font-semibold" title={name}>{name}</span>
		{#if warehouse?.activity}
			{@const tone = pipelineActivityTone(warehouse.activity, nowTick())}
			<Radio
				class="size-3 shrink-0 {tone === 'active' ? 'animate-pulse' : ''} {toneClasses(tone).text}"
				title={`${warehouse.activity.phase ?? warehouse.activity.activityType} · ${relativeTime(warehouse.activity.observedAt, nowTick())}`}
			/>
		{/if}
		<span class="ml-auto shrink-0 rounded-full bg-muted/60 px-1.5 py-0.5 text-[0.55rem] font-medium tabular-nums text-muted-foreground">{stages.length} env</span>
	</div>
	<div class="flex flex-1 flex-col divide-y divide-border/50">
		{#each stages as stage (stage.name)}
			{@const v = healthVisual(stage.health)}
			{@const Icon = v.icon}
			{@const status = envStatus(stage)}
			<div class="flex items-center gap-2 px-3 py-1.5 text-[0.66rem] {stage.dormant ? 'opacity-60' : ''}">
				<span class="flex size-3.5 shrink-0 items-center justify-center" style={`color:${v.color}`} title={v.label}>
					{#if Icon}<Icon class={v.spin ? "size-3 animate-spin" : "size-3"} />{/if}
				</span>
				<span class="w-12 shrink-0 font-medium">{stage.env}</span>
				{#if status}
					<span class="ml-auto truncate rounded bg-muted/60 px-1.5 py-0.5 font-mono text-[0.6rem] text-muted-foreground">{status}</span>
				{/if}
			</div>
		{/each}
	</div>
</div>
