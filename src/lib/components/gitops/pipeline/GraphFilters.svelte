<script lang="ts">
	import { Bug, Check, List, ListFilter, Network, Search, Settings2, X } from "@lucide/svelte";

	import { Badge } from "$lib/components/ui/badge";
	import { Button } from "$lib/components/ui/button";
	import { Input } from "$lib/components/ui/input";
	import * as Popover from "$lib/components/ui/popover";
	import { Switch } from "$lib/components/ui/switch";
	import * as ToggleGroup from "$lib/components/ui/toggle-group";
	import type { PipelineModel } from "$lib/gitops/pipeline-types";
	import type { PipelineViewMode } from "$lib/gitops/preferred-filter";

	type Props = {
		model: PipelineModel;
		pipelineFilter: string[];
		stageSearch: string;
		view: PipelineViewMode;
		showSubscriptions: boolean;
		showMinimap: boolean;
		stepEdges: boolean;
		groupLanes: boolean;
		onPipelineFilter: (warehouses: string[]) => void;
		onStageSearch: (value: string) => void;
		onView: (value: PipelineViewMode) => void;
		onToggle: (
			key: "showSubscriptions" | "showMinimap" | "stepEdges" | "groupLanes",
			value: boolean,
		) => void;
		debug: boolean;
		onDebugToggle: (value: boolean) => void;
	};
	let {
		model,
		pipelineFilter,
		stageSearch,
		view,
		showSubscriptions,
		showMinimap,
		stepEdges,
		groupLanes,
		onPipelineFilter,
		onStageSearch,
		onView,
		onToggle,
		debug,
		onDebugToggle,
	}: Props = $props();

	const label = $derived(
		pipelineFilter.length === 0
			? "All pipelines"
			: pipelineFilter.length === 1
				? pipelineFilter[0]
				: `${pipelineFilter.length} pipelines`,
	);

	function toggleWarehouse(name: string) {
		onPipelineFilter(
			pipelineFilter.includes(name)
				? pipelineFilter.filter((n) => n !== name)
				: [...pipelineFilter, name],
		);
	}
</script>

<div class="flex flex-wrap items-center gap-2">
	<!-- Pipeline (warehouse) filter — our per-service drill-down -->
	<Popover.Root>
		<Popover.Trigger
			class="inline-flex h-7 items-center gap-1.5 rounded-md border bg-background px-2 text-xs font-medium transition hover:bg-muted"
		>
			<ListFilter class="size-3.5 text-muted-foreground" />
			<span class="max-w-[14rem] truncate">{label}</span>
			{#if pipelineFilter.length > 0}
				<Badge variant="secondary" class="h-4 px-1 text-[0.55rem]">{pipelineFilter.length}</Badge>
			{/if}
		</Popover.Trigger>
		<Popover.Content class="w-72 p-0" align="start">
			<div class="flex items-center justify-between border-b px-3 py-2">
				<span class="text-xs font-semibold">Pipelines</span>
				<button
					type="button"
					class="text-[0.68rem] text-primary hover:underline disabled:opacity-40"
					disabled={pipelineFilter.length === 0}
					onclick={() => onPipelineFilter([])}
				>
					All
				</button>
			</div>
			<div class="max-h-80 overflow-y-auto py-1">
				{#each model.subsystems as subsystem (subsystem)}
					<div class="px-3 pb-0.5 pt-1.5 text-[0.6rem] uppercase tracking-wide text-muted-foreground">
						{subsystem}
					</div>
					{#each model.warehousesBySubsystem[subsystem] ?? [] as wh (wh.name)}
						{@const active = pipelineFilter.includes(wh.name)}
						<button
							type="button"
							class="flex w-full items-center gap-2 px-3 py-1 text-left text-xs transition hover:bg-muted {active ? 'bg-muted/60' : ''}"
							onclick={() => toggleWarehouse(wh.name)}
						>
							<span class="size-2 shrink-0 rounded-full" style={`background:${wh.color ?? "#ccc"}`}></span>
							<span class="flex-1 truncate">{wh.name}</span>
							{#if active}<Check class="size-3.5 text-primary" />{/if}
						</button>
					{/each}
				{/each}
			</div>
		</Popover.Content>
	</Popover.Root>

	<!-- Stage search -->
	<div class="relative">
		<Search class="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
		<Input
			value={stageSearch}
			oninput={(e) => onStageSearch((e.currentTarget as HTMLInputElement).value)}
			placeholder="Search stages…"
			class="h-7 w-44 px-7 text-xs"
		/>
		{#if stageSearch}
			<button
				type="button"
				class="absolute right-1.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
				onclick={() => onStageSearch("")}
				aria-label="Clear search"
			>
				<X class="size-3.5" />
			</button>
		{/if}
	</div>

	<!-- Graph / list view toggle -->
	<ToggleGroup.Root
		type="single"
		value={view}
		onValueChange={(v: string | undefined) => v && onView(v as PipelineViewMode)}
		class="h-7"
	>
		<ToggleGroup.Item value="graph" class="h-7 px-2" aria-label="Graph view">
			<Network class="size-3.5" />
		</ToggleGroup.Item>
		<ToggleGroup.Item value="list" class="h-7 px-2" aria-label="List view">
			<List class="size-3.5" />
		</ToggleGroup.Item>
	</ToggleGroup.Root>

	<!-- Display settings -->
	<Popover.Root>
		<Popover.Trigger
			class="inline-flex h-7 items-center gap-1.5 rounded-md border bg-background px-2 text-xs transition hover:bg-muted"
		>
			<Settings2 class="size-3.5 text-muted-foreground" />
		</Popover.Trigger>
		<Popover.Content class="w-56 p-2" align="end">
			<label class="flex items-center justify-between gap-2 px-1 py-1.5 text-xs">
				<span>Group lanes</span>
				<Switch checked={groupLanes} onCheckedChange={(v) => onToggle("groupLanes", v)} />
			</label>
			<label class="flex items-center justify-between gap-2 px-1 py-1.5 text-xs">
				<span>Show subscriptions</span>
				<Switch checked={showSubscriptions} onCheckedChange={(v) => onToggle("showSubscriptions", v)} />
			</label>
			<label class="flex items-center justify-between gap-2 px-1 py-1.5 text-xs">
				<span>Minimap</span>
				<Switch checked={showMinimap} onCheckedChange={(v) => onToggle("showMinimap", v)} />
			</label>
			<label class="flex items-center justify-between gap-2 px-1 py-1.5 text-xs">
				<span>Step edges</span>
				<Switch checked={stepEdges} onCheckedChange={(v) => onToggle("stepEdges", v)} />
			</label>
			<div class="my-1 border-t"></div>
			<label class="flex items-center justify-between gap-2 px-1 py-1.5 text-xs">
				<span class="flex items-center gap-1.5">
					<Bug class="size-3.5 text-muted-foreground" />
					Debug mode
				</span>
				<Switch checked={debug} onCheckedChange={onDebugToggle} />
			</label>
		</Popover.Content>
	</Popover.Root>
</div>
