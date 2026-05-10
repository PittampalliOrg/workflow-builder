<script lang="ts">
	import { untrack } from "svelte";
	import { Filter, History, Workflow } from "@lucide/svelte";

	import TimelineEntry from "$lib/components/promoter/TimelineEntry.svelte";
	import TimelineLineage from "$lib/components/promoter/TimelineLineage.svelte";
	import { Badge } from "$lib/components/ui/badge";
	import { Button } from "$lib/components/ui/button";
	import { buildTimelineView } from "$lib/promoter/timeline-view";
	import type { PromotionStrategiesResponse } from "$lib/server/promoter/types";

	import type { GitopsPageLinks } from "../../../routes/(admin)/admin/gitops/+page.server";

	type Props = {
		promotions: PromotionStrategiesResponse;
		links: GitopsPageLinks;
		selectedStrategy: string | null;
		onSelectStrategy: (name: string | null) => void;
	};

	let { promotions, selectedStrategy, onSelectStrategy }: Props = $props();

	const strategies = $derived(promotions.strategies);
	const activeName = $derived.by(() => {
		if (selectedStrategy && strategies.some((s) => s.metadata.name === selectedStrategy)) {
			return selectedStrategy;
		}
		return strategies[0]?.metadata.name ?? null;
	});
	const activeStrategy = $derived(
		activeName ? strategies.find((s) => s.metadata.name === activeName) ?? null : null,
	);

	let showOnlyFailed = $state(false);

	const view = $derived(
		activeStrategy ? buildTimelineView(activeStrategy, { showOnlyFailed }) : null,
	);

	let container = $state<HTMLElement | null>(null);
	let revision = $state(0);

	// Bump `revision` whenever `view` changes so TimelineLineage recomputes
	// path positions. Read+write of `revision` happens inside `untrack` so the
	// effect doesn't subscribe to its own write (which would loop).
	$effect(() => {
		void view;
		untrack(() => {
			revision += 1;
		});
	});
</script>

<div class="flex flex-1 min-h-0 flex-col overflow-hidden">
	{#if strategies.length === 0}
		<div class="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
			<History class="size-10 text-muted-foreground/50" />
			<div class="max-w-md">
				<p class="text-sm font-medium">No timeline data</p>
				<p class="mt-1 text-xs text-muted-foreground">
					{promotions.error ??
						"No PromotionStrategy resources to render history for. Land the stacks-repo Phase A change to populate this view."}
				</p>
			</div>
		</div>
	{:else}
		<div class="flex items-center justify-between gap-3 border-b px-5 py-2">
			<div class="flex items-center gap-2">
				<Workflow class="size-4 text-muted-foreground" />
				<label class="flex items-center gap-1.5 text-sm">
					<span class="text-xs text-muted-foreground">Strategy</span>
					<select
						class="rounded-md border border-input bg-background px-2 py-1 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-ring"
						value={activeName ?? ""}
						onchange={(e) => onSelectStrategy((e.currentTarget as HTMLSelectElement).value || null)}
					>
						{#each strategies as strategy (strategy.metadata.uid ?? strategy.metadata.name)}
							<option value={strategy.metadata.name}>
								{strategy.metadata.name}
							</option>
						{/each}
					</select>
				</label>
				{#if view}
					<Badge variant="outline" class="h-5 px-1.5 text-[0.65rem]">
						{view.branches.length} env{view.branches.length === 1 ? "" : "s"}
					</Badge>
					{#if view.edges.length > 0}
						<Badge variant="secondary" class="h-5 px-1.5 text-[0.65rem]">
							{view.edges.length} cross-env link{view.edges.length === 1 ? "" : "s"}
						</Badge>
					{/if}
				{/if}
			</div>
			<div class="flex items-center gap-2">
				<Button
					variant={showOnlyFailed ? "default" : "outline"}
					size="sm"
					class="h-7 gap-1"
					onclick={() => (showOnlyFailed = !showOnlyFailed)}
				>
					<Filter class="size-3.5" />
					Failed only
				</Button>
			</div>
		</div>

		{#if view && view.branches.length > 0}
			<div class="relative flex-1 overflow-hidden">
				<div
					bind:this={container}
					class="grid h-full overflow-auto p-4"
					style:grid-template-columns="repeat({view.branches.length}, minmax(15rem, 1fr))"
					style:gap="1rem"
				>
					{#each view.branches as branch (branch)}
						<section class="flex min-w-0 flex-col gap-2">
							<header class="sticky top-0 z-10 flex items-center gap-1 bg-background/80 py-1 backdrop-blur">
								<History class="size-3.5 text-muted-foreground" />
								<span class="font-mono text-xs">{branch}</span>
								<span class="ml-auto text-[0.6rem] text-muted-foreground">
									{view.entriesByBranch[branch]?.length ?? 0}
								</span>
							</header>
							{#if (view.entriesByBranch[branch]?.length ?? 0) === 0}
								<div class="rounded-md border border-dashed p-3 text-center text-[0.7rem] text-muted-foreground">
									{showOnlyFailed ? "No failed promotions on this branch." : "No history yet."}
								</div>
							{:else}
								{#each view.entriesByBranch[branch] as entry (entry.id)}
									<TimelineEntry {entry} />
								{/each}
							{/if}
						</section>
					{/each}
				</div>
				<TimelineLineage edges={view?.edges ?? []} {container} {revision} />
			</div>
		{:else}
			<div class="flex flex-1 items-center justify-center p-8 text-sm text-muted-foreground">
				This strategy has no environments yet.
			</div>
		{/if}
	{/if}
</div>
