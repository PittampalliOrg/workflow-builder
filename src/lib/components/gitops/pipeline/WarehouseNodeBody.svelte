<script lang="ts">
	import { getContext } from "svelte";
	import { Boxes, CircleAlert, ExternalLink, LoaderCircle, Warehouse } from "@lucide/svelte";

	import { Badge } from "$lib/components/ui/badge";
	import { PIPELINE_HOVER_CONTEXT, type PipelineHoverContext } from "$lib/gitops/pipeline-layout";
	import type { PipelineWarehouse } from "$lib/gitops/pipeline-types";

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
	class="flex h-[96px] w-[270px] flex-col overflow-hidden rounded-lg bg-card text-card-foreground shadow-sm transition hover:shadow-md {selected
		? 'ring-2 ring-primary/50'
		: ''}"
	style={`border: 1px solid ${color ?? "var(--border)"};`}
>
	<div
		class="flex items-center justify-between gap-2 border-b px-3 py-1.5"
		style={color ? `background:${color}1a` : ""}
	>
		<div class="flex min-w-0 items-center gap-1.5 {warehouse.hasError ? 'text-destructive' : ''}">
			{#if warehouse.reconciling}
				<LoaderCircle class="size-3.5 shrink-0 animate-spin" />
			{:else if isBundle}
				<Boxes class="size-3.5 shrink-0" />
			{:else}
				<Warehouse class="size-3.5 shrink-0" />
			{/if}
			<span class="truncate text-xs font-semibold" title={longName ? warehouse.name : undefined}>
				{warehouse.name}
			</span>
			{#if warehouse.hasError}
				<CircleAlert class="size-3 shrink-0 text-destructive" />
			{/if}
		</div>
		<ExternalLink class="size-3 shrink-0 text-muted-foreground" />
	</div>

	<div class="flex flex-1 flex-col justify-center gap-1 px-3 py-1.5 text-[0.66rem] text-muted-foreground">
		{#if isBundle}
			<span>{warehouse.subscriptions.length} subscriptions · images + config</span>
		{:else}
			<span class="truncate font-mono" title={warehouse.subscriptions[0]?.repoURL}>
				{warehouse.subscriptions[0]?.repoURL ?? "ghcr.io"}
			</span>
		{/if}
		<div class="flex flex-wrap items-center gap-1">
			<Badge variant="outline" class="h-4 px-1 text-[0.55rem]">{warehouse.subsystem}</Badge>
			{#if warehouse.dependedOnBy?.length}
				<Badge variant="outline" class="h-4 border-sky-300 px-1 text-[0.55rem] text-sky-700 dark:text-sky-300" title={warehouse.dependedOnBy.join("\n")}>
					depended-on ×{warehouse.dependedOnBy.length}
				</Badge>
			{/if}
		</div>
	</div>
</div>
