<script lang="ts">
	import { getContext } from "svelte";
	import { Boxes, CircleAlert, ExternalLink, LoaderCircle, Radio, Warehouse } from "@lucide/svelte";

	import { Badge } from "$lib/components/ui/badge";
	import { pipelineActivityTone, toneClasses } from "$lib/gitops/activity-tone";
	import { isFlowing } from "$lib/gitops/gitops-flow.svelte";
	import { nowTick } from "$lib/gitops/gitops-tick.svelte";
	import { PIPELINE_HOVER_CONTEXT, type PipelineHoverContext } from "$lib/gitops/pipeline-layout";
	import type { PipelineWarehouse } from "$lib/gitops/pipeline-types";
	import { relativeTime } from "$lib/utils/gitops-display";

	type Props = { warehouse: PipelineWarehouse; color?: string; selected?: boolean };
	let { warehouse, color, selected = false }: Props = $props();

	const hover = getContext<PipelineHoverContext | undefined>(PIPELINE_HOVER_CONTEXT);
	const isBundle = $derived(warehouse.kind === "bundle");
	const longName = $derived(warehouse.name.length > 22);
</script>

<div
	role="group"
	onmouseenter={() => hover?.setHovered(warehouse.name)}
	onmouseleave={() => hover?.setHovered(null)}
	class="flex h-[96px] w-[270px] flex-col overflow-hidden rounded-xl border border-border/70 bg-card text-card-foreground shadow-sm transition-shadow hover:shadow-md {selected
		? 'ring-2 ring-primary/40'
		: ''} {isFlowing(warehouse.name) ? 'gitops-flow' : ''}"
	style={color ? `border-left: 3px solid ${color};` : ""}
>
	<div
		class="flex items-center justify-between gap-2 border-b border-border/60 px-3 py-2"
		style={color ? `background:${color}0d` : ""}
	>
		<div class="flex min-w-0 items-center gap-1.5 {warehouse.hasError ? 'text-destructive' : ''}">
			<span class="flex size-5 shrink-0 items-center justify-center rounded-md bg-muted/60 text-muted-foreground">
				{#if warehouse.reconciling}
					<LoaderCircle class="size-3.5 animate-spin" />
				{:else if isBundle}
					<Boxes class="size-3.5" />
				{:else}
					<Warehouse class="size-3.5" />
				{/if}
			</span>
			<span class="truncate text-[0.8rem] font-semibold" title={longName ? warehouse.name : undefined}>
				{warehouse.name}
			</span>
			{#if warehouse.hasError}
				<CircleAlert class="size-3 shrink-0 text-destructive" />
			{/if}
			{#if warehouse.activity}
				{@const tone = pipelineActivityTone(warehouse.activity, nowTick())}
				<Radio
					class="size-3 shrink-0 {tone === 'active' ? 'animate-pulse' : ''} {toneClasses(tone).text}"
					title={`${warehouse.activity.phase ?? warehouse.activity.activityType} · ${relativeTime(warehouse.activity.observedAt, nowTick())}`}
				/>
			{/if}
		</div>
		<ExternalLink class="size-3.5 shrink-0 text-muted-foreground/50" />
	</div>

	<div class="flex flex-1 flex-col justify-center gap-1.5 px-3 py-2">
		{#if isBundle}
			<span class="text-[0.62rem] text-muted-foreground">{warehouse.subscriptions.length} subscriptions · images + config</span>
		{:else}
			<span class="truncate rounded bg-muted/60 px-1.5 py-0.5 font-mono text-[0.68rem]" title={warehouse.subscriptions[0]?.repoURL}>
				{warehouse.subscriptions[0]?.repoURL ?? "ghcr.io"}
			</span>
		{/if}
		<div class="flex flex-wrap items-center gap-1">
			<Badge variant="outline" class="h-4 rounded-full px-1.5 text-[0.55rem]">{warehouse.subsystem}</Badge>
			{#if warehouse.dependedOnBy?.length}
				<Badge variant="outline" class="h-4 rounded-full border-sky-300 px-1.5 text-[0.55rem] text-sky-700 dark:text-sky-300" title={warehouse.dependedOnBy.join("\n")}>
					depended-on ×{warehouse.dependedOnBy.length}
				</Badge>
			{/if}
		</div>
	</div>
</div>
