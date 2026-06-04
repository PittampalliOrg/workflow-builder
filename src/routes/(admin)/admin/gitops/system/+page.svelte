<script lang="ts">
	import { onDestroy, onMount, setContext, untrack } from "svelte";
	import { AlertTriangle, GitBranch, RefreshCw, Route } from "@lucide/svelte";

	import { PIPELINE_LINKS_CONTEXT } from "$lib/gitops/pipeline-layout";

	import FreightTimeline from "$lib/components/gitops/pipeline/FreightTimeline.svelte";
	import GraphFilters from "$lib/components/gitops/pipeline/GraphFilters.svelte";
	import PipelineDrawer from "$lib/components/gitops/pipeline/PipelineDrawer.svelte";
	import PipelineGraph, { type PipelineSelection } from "$lib/components/gitops/pipeline/PipelineGraph.svelte";
	import PipelineListView from "$lib/components/gitops/pipeline/PipelineListView.svelte";
	import { Badge } from "$lib/components/ui/badge";
	import { Button } from "$lib/components/ui/button";
	import { buildPipelineModel } from "$lib/gitops/pipeline-model";
	import {
		DEFAULT_PREFERRED_FILTER,
		loadPreferredFilter,
		savePreferredFilter,
		type PipelineViewMode,
		type PreferredFilter,
	} from "$lib/gitops/preferred-filter";
	import type { PromotionStrategiesResponse } from "$lib/server/promoter/types";
	import type { DeploymentMetadataResponse } from "$lib/types/deployment-metadata";
	import { relativeTime } from "$lib/utils/gitops-display";

	import type { PageData } from "./$types";

	type Props = { data: PageData };
	let { data }: Props = $props();

	let metadata = $state<DeploymentMetadataResponse>(untrack(() => data.initial));
	let promotions = $state<PromotionStrategiesResponse>(untrack(() => data.promotions));
	const links = untrack(() => data.links);
	setContext(PIPELINE_LINKS_CONTEXT, links);

	let loading = $state(false);
	let requestError = $state<string | null>(null);
	let now = $state(Date.now());
	let timer: ReturnType<typeof setInterval> | null = null;
	let clockTimer: ReturnType<typeof setInterval> | null = null;

	// View preferences (persisted) + transient UI state.
	let filter = $state<PreferredFilter>({ ...DEFAULT_PREFERRED_FILTER });
	let stageSearch = $state("");
	let selection = $state<PipelineSelection>(null);
	let selectedFreightId = $state<string | null>(null);

	const model = $derived(buildPipelineModel(metadata, promotions));
	const errors = $derived(
		[
			requestError,
			metadata.live.error,
			metadata.gitops.releasePinsError,
			metadata.inventory.error,
			promotions.error,
		].filter((m): m is string => Boolean(m)),
	);
	const stacksShortSha = $derived(metadata.gitops.stacksMain?.shortSha ?? "unknown");
	const stacksUrl = $derived(metadata.gitops.stacksMain?.url ?? `${links.stacksRepo}/commits/main`);

	// The workflow-builder build this UI is itself running (from the live
	// deployment on the current cluster) — a GitOps page should show its own version.
	const runningBuildShort = $derived.by(() => {
		const tag = metadata.live.deployments
			.find((d) => d.name === "workflow-builder")
			?.containers.find((c) => c.containerName === "workflow-builder")?.tag;
		return tag ? tag.replace(/^git-/, "").slice(0, 8) : null;
	});

	async function refresh() {
		loading = true;
		try {
			const [metaRes, promoRes] = await Promise.all([
				fetch("/api/v1/gitops/deployment-metadata"),
				fetch("/api/v1/gitops/promotions"),
			]);
			if (!metaRes.ok) throw new Error(`metadata: ${metaRes.status} ${metaRes.statusText}`);
			if (!promoRes.ok) throw new Error(`promotions: ${promoRes.status} ${promoRes.statusText}`);
			metadata = (await metaRes.json()) as DeploymentMetadataResponse;
			promotions = (await promoRes.json()) as PromotionStrategiesResponse;
			requestError = null;
		} catch (err) {
			requestError = err instanceof Error ? err.message : String(err);
		} finally {
			loading = false;
		}
	}

	onMount(() => {
		filter = loadPreferredFilter();
		timer = setInterval(() => void refresh(), 15_000);
		clockTimer = setInterval(() => (now = Date.now()), 30_000);
	});
	onDestroy(() => {
		if (timer) clearInterval(timer);
		if (clockTimer) clearInterval(clockTimer);
	});

	function updateFilter(patch: Partial<PreferredFilter>) {
		filter = { ...filter, ...patch };
		savePreferredFilter(filter);
	}

	function selectNode(sel: PipelineSelection) {
		selection = sel;
		selectedFreightId = null;
	}
	function selectFreight(id: string | null) {
		selectedFreightId = id;
		if (id) selection = null;
	}
	function closeDrawer() {
		selection = null;
		selectedFreightId = null;
	}
</script>

<svelte:head>
	<title>GitOps Pipeline · Workflow Builder</title>
</svelte:head>

<div class="flex h-full flex-col overflow-hidden">
	<header class="border-b px-5 py-3">
		<div class="flex flex-wrap items-center justify-between gap-3">
			<div class="flex min-w-0 items-center gap-2">
				<Route class="size-5 shrink-0 text-muted-foreground" />
				<h1 class="truncate text-lg font-semibold">GitOps Pipeline</h1>
				<Badge variant="outline" class="h-5 px-1.5 text-[0.65rem]">Kargo lens</Badge>
				<Badge variant="outline" class="h-5 px-1.5 text-[0.65rem]">{metadata.environment.name ?? "unknown"}</Badge>
				{#if runningBuildShort}
					<Badge
						variant="outline"
						class="h-5 px-1.5 text-[0.65rem]"
						title="workflow-builder build this UI is running"
					>
						build <span class="font-mono">{runningBuildShort}</span>
					</Badge>
				{/if}
			</div>
			<div class="flex flex-wrap items-center gap-2">
				<a
					class="inline-flex items-center gap-1 text-[0.7rem] text-muted-foreground hover:text-foreground"
					href={stacksUrl}
					target="_blank"
					rel="noreferrer"
				>
					<GitBranch class="size-3" />
					stacks/main <span class="font-mono">{stacksShortSha}</span>
				</a>
				<span class="text-[0.7rem] text-muted-foreground">Updated {relativeTime(metadata.generatedAt, now)}</span>
				<Button variant="outline" size="sm" onclick={refresh} disabled={loading} class="h-7">
					<RefreshCw class="size-3.5 {loading ? 'animate-spin' : ''}" />
					Refresh
				</Button>
			</div>
		</div>
	</header>

	{#if errors.length > 0}
		<div class="border-b bg-destructive/5 px-5 py-2 text-xs text-destructive">
			<div class="flex items-center gap-2">
				<AlertTriangle class="size-3.5 shrink-0" />
				<span class="truncate">{errors.join(" / ")}</span>
			</div>
		</div>
	{/if}

	<!-- Prominent freight carousel (Kargo's freightline) -->
	<FreightTimeline
		{model}
		pipelineFilter={filter.warehouses}
		{selectedFreightId}
		onselect={selectFreight}
	/>

	<!-- Filter bar -->
	<div class="flex items-center justify-between gap-2 border-b px-4 py-2">
		<GraphFilters
			{model}
			pipelineFilter={filter.warehouses}
			{stageSearch}
			view={filter.view}
			showSubscriptions={filter.showSubscriptions}
			showMinimap={filter.showMinimap}
			stepEdges={filter.stepEdges}
			groupLanes={filter.groupLanes}
			onPipelineFilter={(warehouses) => updateFilter({ warehouses })}
			onStageSearch={(value) => (stageSearch = value)}
			onView={(value: PipelineViewMode) => updateFilter({ view: value })}
			onToggle={(key, value) => updateFilter({ [key]: value })}
		/>
		<span class="hidden text-[0.68rem] text-muted-foreground sm:inline">Warehouse → Freight → Stage</span>
	</div>

	<!-- Graph / list -->
	<div class="relative min-h-0 flex-1">
		{#if filter.view === "graph"}
			<div class="h-full w-full">
				<PipelineGraph
					{model}
					pipelineFilter={filter.warehouses}
					hideSubscriptions={!filter.showSubscriptions}
					stepEdges={filter.stepEdges}
					showMinimap={filter.showMinimap}
					groupLanes={filter.groupLanes}
					{stageSearch}
					selected={selection}
					onselect={selectNode}
				/>
			</div>
		{:else}
			<PipelineListView
				{model}
				pipelineFilter={filter.warehouses}
				{stageSearch}
				selected={selection}
				onselect={selectNode}
			/>
		{/if}
	</div>

	<PipelineDrawer {model} {selection} freightId={selectedFreightId} {links} onClose={closeDrawer} />
</div>
