<script lang="ts">
	import { onDestroy, onMount, setContext, untrack } from "svelte";
	import { AlertTriangle, GitBranch, Radio, RefreshCw, Route } from "@lucide/svelte";

	import { PIPELINE_LINKS_CONTEXT } from "$lib/gitops/pipeline-layout";

	import FreightTimeline from "$lib/components/gitops/pipeline/FreightTimeline.svelte";
	import GraphFilters from "$lib/components/gitops/pipeline/GraphFilters.svelte";
	import PipelineDrawer from "$lib/components/gitops/pipeline/PipelineDrawer.svelte";
	import PipelineGraph, { type PipelineSelection } from "$lib/components/gitops/pipeline/PipelineGraph.svelte";
	import PipelineListView from "$lib/components/gitops/pipeline/PipelineListView.svelte";
	import { Badge } from "$lib/components/ui/badge";
	import { Button } from "$lib/components/ui/button";
	import { applyPipelineActivityOverlay } from "$lib/gitops/activity-overlay";
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
	import type {
		GitOpsActivityEvent,
		GitOpsActivityEventsResponse,
	} from "$lib/types/gitops-activity";
	import { relativeTime } from "$lib/utils/gitops-display";

	import type { PageData } from "./$types";

	type Props = { data: PageData };
	let { data }: Props = $props();

	let metadata = $state<DeploymentMetadataResponse>(untrack(() => data.initial));
	let promotions = $state<PromotionStrategiesResponse>(untrack(() => data.promotions));
	let activityEvents = $state<GitOpsActivityEvent[]>(untrack(() => data.activityEvents ?? []));
	const links = untrack(() => data.links);
	setContext(PIPELINE_LINKS_CONTEXT, links);

	let loading = $state(false);
	let requestError = $state<string | null>(null);
	let now = $state(Date.now());
	let timer: ReturnType<typeof setInterval> | null = null;
	let clockTimer: ReturnType<typeof setInterval> | null = null;
	let activityEventSource: EventSource | null = null;
	let activityReconnectTimer: ReturnType<typeof setTimeout> | null = null;
	let activityConnected = $state(false);
	let activityError = $state<string | null>(null);

	// View preferences (persisted) + transient UI state.
	let filter = $state<PreferredFilter>({ ...DEFAULT_PREFERRED_FILTER });
	let stageSearch = $state("");
	let selection = $state<PipelineSelection>(null);
	let selectedFreightId = $state<string | null>(null);

	const model = $derived(
		applyPipelineActivityOverlay(buildPipelineModel(metadata, promotions), activityEvents, now),
	);
	const latestEvents = $derived(
		[...activityEvents].sort((a, b) => b.sequence - a.sequence).slice(0, 8),
	);
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
	const runningBuildTag = $derived.by(
		() =>
			metadata.live.deployments
				.find((d) => d.name === "workflow-builder")
				?.containers.find((c) => c.containerName === "workflow-builder")?.tag ?? null,
	);
	const runningBuildShort = $derived(
		runningBuildTag ? runningBuildTag.replace(/^git-/, "").slice(0, 8) : null,
	);
	const runningBuildUrl = $derived(
		runningBuildTag?.startsWith("git-")
			? `${links.workflowBuilderRepo}/commit/${runningBuildTag.slice(4)}`
			: null,
	);

	async function refresh() {
		loading = true;
		try {
			const [metaRes, promoRes, eventsRes] = await Promise.all([
				fetch("/api/v1/gitops/deployment-metadata"),
				fetch("/api/v1/gitops/promotions"),
				fetch("/api/v1/gitops/events?limit=200"),
			]);
			if (!metaRes.ok) throw new Error(`metadata: ${metaRes.status} ${metaRes.statusText}`);
			if (!promoRes.ok) throw new Error(`promotions: ${promoRes.status} ${promoRes.statusText}`);
			if (!eventsRes.ok) throw new Error(`events: ${eventsRes.status} ${eventsRes.statusText}`);
			metadata = (await metaRes.json()) as DeploymentMetadataResponse;
			promotions = (await promoRes.json()) as PromotionStrategiesResponse;
			const activity = (await eventsRes.json()) as GitOpsActivityEventsResponse;
			activityEvents = mergeActivityEvents(activityEvents, activity.events);
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
		connectActivityStream();
	});
	onDestroy(() => {
		if (timer) clearInterval(timer);
		if (clockTimer) clearInterval(clockTimer);
		closeActivityStream();
		if (activityReconnectTimer) clearTimeout(activityReconnectTimer);
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

	function latestSequence(): number {
		return activityEvents.reduce((max, event) => Math.max(max, event.sequence), 0);
	}

	function mergeActivityEvents(
		current: GitOpsActivityEvent[],
		incoming: GitOpsActivityEvent[],
	): GitOpsActivityEvent[] {
		const byId = new Map(current.map((event) => [event.eventId, event]));
		for (const event of incoming) byId.set(event.eventId, event);
		return [...byId.values()]
			.sort((a, b) => b.sequence - a.sequence)
			.slice(0, 300);
	}

	function closeActivityStream() {
		activityEventSource?.close();
		activityEventSource = null;
		activityConnected = false;
	}

	function connectActivityStream() {
		closeActivityStream();
		if (activityReconnectTimer) {
			clearTimeout(activityReconnectTimer);
			activityReconnectTimer = null;
		}
		const es = new EventSource(`/api/v1/gitops/events/stream?since=${latestSequence()}`);
		activityEventSource = es;
		es.onopen = () => {
			activityConnected = true;
			activityError = null;
		};
		es.addEventListener("gitops.event", (event) => {
			const message = event as MessageEvent<string>;
			try {
				const parsed = JSON.parse(message.data) as GitOpsActivityEvent;
				activityEvents = mergeActivityEvents(activityEvents, [parsed]);
			} catch (err) {
				activityError = err instanceof Error ? err.message : String(err);
			}
		});
		es.onerror = () => {
			activityConnected = false;
			activityError = null;
			es.close();
			if (!activityReconnectTimer) {
				activityReconnectTimer = setTimeout(() => {
					activityReconnectTimer = null;
					connectActivityStream();
				}, 5_000);
			}
		};
	}

	function eventTargetLabel(event: GitOpsActivityEvent): string {
		const imageName = event.correlation.imageName;
		if (typeof imageName === "string" && imageName) return imageName;
		return event.resourceRef.name ?? event.activityKey;
	}

	function eventTone(event: GitOpsActivityEvent): string {
		const phase = `${event.phase ?? ""} ${event.reason ?? ""}`.toLowerCase();
		if (/fail|error|degraded|false|cancel/.test(phase)) return "destructive";
		if (/succeed|success|healthy|synced|true/.test(phase)) return "success";
		return "active";
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
					{#if runningBuildUrl}
						<a
							href={runningBuildUrl}
							target="_blank"
							rel="noreferrer"
							title="workflow-builder build this UI is running — open commit"
						>
							<Badge variant="outline" class="h-5 px-1.5 text-[0.65rem] hover:bg-muted">
								build <span class="font-mono">{runningBuildShort}</span>
							</Badge>
						</a>
					{:else}
						<Badge
							variant="outline"
							class="h-5 px-1.5 text-[0.65rem]"
							title="workflow-builder build this UI is running"
						>
							build <span class="font-mono">{runningBuildShort}</span>
						</Badge>
					{/if}
				{/if}
				<Badge
					variant="outline"
					class="h-5 gap-1 px-1.5 text-[0.65rem]"
					title={activityConnected ? "GitOps event stream connected" : "GitOps event stream fallback polling"}
				>
					<Radio class="size-2.5 {activityConnected ? 'animate-pulse text-sky-600 dark:text-sky-300' : ''}" />
					{activityConnected ? "live" : "poll"} {activityEvents.length}
				</Badge>
			</div>
			<div class="flex flex-wrap items-center gap-2">
				<Button variant="outline" size="sm" href="/admin/gitops/events" class="h-7">
					<Radio class="size-3.5" />
					Events
				</Button>
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

	{#if latestEvents.length > 0}
		<div class="border-b bg-muted/30 px-4 py-1.5">
			<div class="flex gap-2 overflow-x-auto">
				{#each latestEvents as event (event.eventId)}
					{@const tone = eventTone(event)}
					<div
						class="flex h-7 shrink-0 items-center gap-1.5 rounded-md border px-2 text-[0.66rem] {tone === 'destructive'
							? 'border-destructive/40 bg-destructive/5 text-destructive'
							: tone === 'success'
								? 'border-emerald-400/40 bg-emerald-50/60 text-emerald-700 dark:bg-emerald-950/20 dark:text-emerald-300'
								: 'border-sky-400/40 bg-sky-50/70 text-sky-700 dark:bg-sky-950/20 dark:text-sky-300'}"
						title={event.message ?? event.reason ?? event.activityType}
					>
						<Radio class="size-2.5 {tone === 'active' ? 'animate-pulse' : ''}" />
						<span class="max-w-[10rem] truncate font-medium">{eventTargetLabel(event)}</span>
						<span class="max-w-[8rem] truncate font-mono">{event.phase ?? event.activityType}</span>
						<span class="text-muted-foreground">{relativeTime(event.observedAt, now)}</span>
					</div>
				{/each}
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
