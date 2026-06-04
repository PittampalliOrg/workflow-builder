<script lang="ts">
	import { Clock3 } from "@lucide/svelte";

	import { Badge } from "$lib/components/ui/badge";
	import { healthVisual } from "$lib/gitops/kargo-status";
	import type { PipelineModel, PipelineStage } from "$lib/gitops/pipeline-types";
	import type { PipelineSelection } from "$lib/components/gitops/pipeline/PipelineGraph.svelte";
	import { relativeTime, shortTag } from "$lib/utils/gitops-display";

	type Props = {
		model: PipelineModel;
		pipelineFilter?: string[];
		stageSearch?: string;
		selected?: PipelineSelection;
		onselect?: (sel: PipelineSelection) => void;
	};
	let { model, pipelineFilter = [], stageSearch = "", selected = null, onselect }: Props = $props();

	const rows = $derived.by((): PipelineStage[] => {
		const set = new Set(pipelineFilter);
		const needle = stageSearch.trim().toLowerCase();
		return model.stages.filter((s) => {
			if (set.size > 0 && !set.has(s.warehouse)) return false;
			if (needle && !s.warehouse.toLowerCase().includes(needle) && !s.env.toLowerCase().includes(needle))
				return false;
			return true;
		});
	});
</script>

<div class="h-full overflow-auto">
	<table class="w-full border-collapse text-xs">
		<thead class="sticky top-0 z-10 bg-card">
			<tr class="border-b text-left text-[0.66rem] uppercase tracking-wide text-muted-foreground">
				<th class="px-3 py-2 font-medium">Pipeline</th>
				<th class="px-3 py-2 font-medium">Env</th>
				<th class="px-3 py-2 font-medium">Health</th>
				<th class="px-3 py-2 font-medium">Sync</th>
				<th class="px-3 py-2 font-medium">Version</th>
				<th class="px-3 py-2 font-medium">Updated</th>
			</tr>
		</thead>
		<tbody>
			{#each rows as stage (stage.name)}
				{@const health = healthVisual(stage.health)}
				{@const Icon = health.icon}
				<tr
					class="cursor-pointer border-b transition hover:bg-muted/50 {selected?.id === `stage/${stage.name}` ? 'bg-muted' : ''}"
					onclick={() => onselect?.({ kind: "stage", id: `stage/${stage.name}` })}
				>
					<td class="px-3 py-1.5">
						<span class="flex items-center gap-1.5">
							<span class="size-2 rounded-full" style={`background:${model.warehouseColorMap[stage.warehouse] ?? "#ccc"}`}></span>
							<span class="truncate font-medium">{stage.warehouse}</span>
						</span>
					</td>
					<td class="px-3 py-1.5">{stage.env}</td>
					<td class="px-3 py-1.5">
						<span class="flex items-center gap-1" style={`color:${health.color}`}>
							{#if Icon}<Icon class={health.spin ? "size-3 animate-spin" : "size-3"} />{/if}
							{health.label}
						</span>
					</td>
					<td class="px-3 py-1.5 text-muted-foreground">{stage.syncStatus ?? (stage.dormant ? "dormant" : "—")}</td>
					<td class="px-3 py-1.5">
						{#if stage.desiredTag}
							<span class="font-mono text-[0.66rem]" title={stage.desiredTag}>{shortTag(stage.desiredTag)}</span>
						{:else if stage.rollup}
							<Badge variant="secondary" class="h-4 px-1 text-[0.58rem]">{stage.rollup.synced}/{stage.rollup.total}</Badge>
						{:else}
							<span class="text-muted-foreground">—</span>
						{/if}
					</td>
					<td class="px-3 py-1.5 text-muted-foreground">
						{#if stage.updatedAt}
							<span class="flex items-center gap-1"><Clock3 class="size-2.5" />{relativeTime(stage.updatedAt)}</span>
						{:else}
							—
						{/if}
					</td>
				</tr>
			{/each}
			{#if rows.length === 0}
				<tr><td colspan="6" class="px-3 py-6 text-center text-muted-foreground">No stages match the current filter.</td></tr>
			{/if}
		</tbody>
	</table>
</div>
