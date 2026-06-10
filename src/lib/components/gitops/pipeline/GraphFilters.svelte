<script lang="ts">
	import { Bug, Check, List, ListFilter, Network, Search, Settings2, X } from "@lucide/svelte";

	import { Badge } from "$lib/components/ui/badge";
	import { Button } from "$lib/components/ui/button";
	import { Input } from "$lib/components/ui/input";
	import * as Popover from "$lib/components/ui/popover";
	import { Switch } from "$lib/components/ui/switch";
	import * as ToggleGroup from "$lib/components/ui/toggle-group";
	import {
		STAGE_STATUS_FILTERS,
		statusCounts,
		type StageStatusFilter,
	} from "$lib/gitops/stage-status-filters";
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
		statusFilter: StageStatusFilter[];
		onPipelineFilter: (warehouses: string[]) => void;
		onStageSearch: (value: string) => void;
		onView: (value: PipelineViewMode) => void;
		onToggle: (
			key: "showSubscriptions" | "showMinimap" | "stepEdges" | "groupLanes",
			value: boolean,
		) => void;
		onStatusFilter: (filters: StageStatusFilter[]) => void;
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
		statusFilter,
		onPipelineFilter,
		onStageSearch,
		onView,
		onToggle,
		onStatusFilter,
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

	const counts = $derived(statusCounts(model.stages));

	// Tone-aligned chip styling per status (active state).
	const STATUS_CHIP_ACTIVE: Record<StageStatusFilter, string> = {
		failing: "border-destructive/70 bg-destructive/10 text-destructive",
		building: "border-sky-500/70 bg-sky-500/10 text-sky-700 dark:text-sky-300",
		drifting: "border-amber-400/70 bg-amber-500/10 text-amber-700 dark:text-amber-300",
		promoting: "border-amber-400/70 bg-amber-500/10 text-amber-700 dark:text-amber-300",
	};

	function toggleWarehouse(name: string) {
		onPipelineFilter(
			pipelineFilter.includes(name)
				? pipelineFilter.filter((n) => n !== name)
				: [...pipelineFilter, name],
		);
	}

	function toggleStatus(filter: StageStatusFilter) {
		onStatusFilter(
			statusFilter.includes(filter)
				? statusFilter.filter((f) => f !== filter)
				: [...statusFilter, filter],
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

	<!-- Semantic status filters: emphasize stages that are failing / building /
	     drifting / promoting. Graph dims non-matching; list filters rows. -->
	<div class="flex items-center gap-1">
		{#each STAGE_STATUS_FILTERS as status (status)}
			{@const active = statusFilter.includes(status)}
			{@const count = counts[status]}
			<button
				type="button"
				class="inline-flex h-7 items-center gap-1 rounded-md border px-1.5 text-[0.66rem] font-medium transition {active
					? STATUS_CHIP_ACTIVE[status]
					: count > 0
						? 'bg-background text-foreground hover:bg-muted'
						: 'bg-background text-muted-foreground/60 hover:bg-muted'}"
				title={`${count} stage${count === 1 ? "" : "s"} ${status}`}
				onclick={() => toggleStatus(status)}
			>
				{status}
				{#if count > 0}
					<span class="rounded bg-muted px-1 font-mono text-[0.58rem] {active ? 'bg-background/60' : ''}">{count}</span>
				{/if}
			</button>
		{/each}
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
