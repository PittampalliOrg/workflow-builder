<script lang="ts">
	import { onDestroy, onMount, setContext, untrack } from "svelte";
	import { AlertTriangle, GitBranch, Radio, RefreshCw, Route } from "@lucide/svelte";

	import { goto } from "$app/navigation";
	import { page } from "$app/state";

	import { PIPELINE_LINKS_CONTEXT } from "$lib/gitops/pipeline-layout";

	import ActivityFeed from "$lib/components/gitops/pipeline/ActivityFeed.svelte";
	import FreightTimeline from "$lib/components/gitops/pipeline/FreightTimeline.svelte";
	import GraphFilters from "$lib/components/gitops/pipeline/GraphFilters.svelte";
	import PipelineDrawer from "$lib/components/gitops/pipeline/PipelineDrawer.svelte";
	import PipelineGraph, { type PipelineSelection } from "$lib/components/gitops/pipeline/PipelineGraph.svelte";
	import PipelineListView from "$lib/components/gitops/pipeline/PipelineListView.svelte";
	import { Badge } from "$lib/components/ui/badge";
	import { Button } from "$lib/components/ui/button";
	import * as Popover from "$lib/components/ui/popover";
	import { activityTargetKeys, applyPipelineActivityOverlay } from "$lib/gitops/activity-overlay";
	import { clearFlowing, markFlowing } from "$lib/gitops/gitops-flow.svelte";
	import { nowTick, startClock } from "$lib/gitops/gitops-tick.svelte";
	import {
		GITOPS_EVENT_REFRESH_DEBOUNCE_MS,
		gitOpsDeploymentMetadataUrl,
		mergeActivityEvents,
		shouldRefreshGitOpsMetadata,
	} from "$lib/gitops/event-driven-refresh";
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
	// One shared clock for every relative-time label + freshness derivation. The
	// model no longer depends on it, so ticking restyles only timestamps, not the graph.
	const now = $derived(nowTick());
	let timer: ReturnType<typeof setInterval> | null = null;
	let clockStop: (() => void) | null = null;
	let eventRefreshTimer: ReturnType<typeof setTimeout> | null = null;
	let activityEventSource: EventSource | null = null;
	let activityReconnectTimer: ReturnType<typeof setTimeout> | null = null;
	let activityConnected = $state(false);
	let activityReconnecting = $state(false);
	let activityError = $state<string | null>(null);
	// Client-side coalescing of SSE bursts (Argo ListWatch-style): buffer events
	// and flush once per ~80ms so the model re-derives per batch, not per event.
	let eventBuffer: GitOpsActivityEvent[] = [];
	let flushTimer: ReturnType<typeof setTimeout> | null = null;
	// Exponential reconnect backoff (3s → ×1.5 → cap 30s), reset on open.
	let reconnectDelay = 3000;

	// View preferences (persisted) + transient UI state.
	let filter = $state<PreferredFilter>({ ...DEFAULT_PREFERRED_FILTER });
	let stageSearch = $state("");
	let selection = $state<PipelineSelection>(null);
	let selectedFreightId = $state<string | null>(null);

	// C1 — base (inventory) model recomputes only when metadata/promotions change
	// (the 15s poll), NOT on every event; the activity overlay is the only thing
	// that re-derives per event batch.
	const baseModel = $derived(buildPipelineModel(metadata, promotions));
	const model = $derived(applyPipelineActivityOverlay(baseModel, activityEvents));
	const streamState = $derived(
		activityConnected ? "live" : activityReconnecting ? "reconnecting" : "poll",
	);
	const latestEvent = $derived(activityEvents[0] ?? null);
	const debug = $derived(page.url.searchParams.get("debug") === "1");
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

	async function refresh(options: { fresh?: boolean } = {}) {
		loading = true;
		try {
			const [metaRes, promoRes, eventsRes] = await Promise.all([
				fetch(gitOpsDeploymentMetadataUrl(options)),
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
		startFallbackPolling();
		clockStop = startClock();
		connectActivityStream();
	});
	onDestroy(() => {
		stopFallbackPolling();
		clockStop?.();
		flushEvents();
		if (eventRefreshTimer) clearTimeout(eventRefreshTimer);
		closeActivityStream();
		if (activityReconnectTimer) clearTimeout(activityReconnectTimer);
		clearFlowing();
	});

	function updateFilter(patch: Partial<PreferredFilter>) {
		filter = { ...filter, ...patch };
		savePreferredFilter(filter);
	}

	// Debug mode is URL-driven (`?debug=1`) so it stays shareable and resets on
	// navigation — toggle it by patching the query param without a reload.
	function toggleDebug(value: boolean) {
		const url = new URL(page.url);
		if (value) url.searchParams.set("debug", "1");
		else url.searchParams.delete("debug");
		void goto(url, { replaceState: true, keepFocus: true, noScroll: true });
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

	function startFallbackPolling() {
		if (!timer) timer = setInterval(() => void refresh(), 15_000);
	}

	function stopFallbackPolling() {
		if (timer) clearInterval(timer);
		timer = null;
	}

	function scheduleMetadataRefresh() {
		if (eventRefreshTimer) clearTimeout(eventRefreshTimer);
		eventRefreshTimer = setTimeout(() => {
			eventRefreshTimer = null;
			void refresh({ fresh: true });
		}, GITOPS_EVENT_REFRESH_DEBOUNCE_MS);
	}

	// Drain the SSE buffer: merge the whole batch once, light up the touched
	// nodes/edges (live-flow motion), and schedule a metadata refresh if any
	// event in the batch warrants one.
	function flushEvents() {
		if (flushTimer) {
			clearTimeout(flushTimer);
			flushTimer = null;
		}
		if (eventBuffer.length === 0) return;
		const batch = eventBuffer;
		eventBuffer = [];
		activityEvents = mergeActivityEvents(activityEvents, batch);
		const keys = new Set<string>();
		let refreshNeeded = false;
		for (const event of batch) {
			for (const key of activityTargetKeys(event, baseModel)) keys.add(key);
			if (shouldRefreshGitOpsMetadata(event)) refreshNeeded = true;
		}
		if (keys.size > 0) markFlowing([...keys]);
		if (refreshNeeded) scheduleMetadataRefresh();
	}

	function scheduleFlush() {
		if (flushTimer) return;
		flushTimer = setTimeout(flushEvents, 80);
	}

	function closeActivityStream() {
		activityEventSource?.close();
		activityEventSource = null;
		activityConnected = false;
	}

	function connectActivityStream() {
		closeActivityStream();
		activityReconnecting = false;
		if (activityReconnectTimer) {
			clearTimeout(activityReconnectTimer);
			activityReconnectTimer = null;
		}
		const es = new EventSource(`/api/v1/gitops/events/stream?since=${latestSequence()}`);
		activityEventSource = es;
		es.onopen = () => {
			activityConnected = true;
			activityReconnecting = false;
			activityError = null;
			reconnectDelay = 3000;
			stopFallbackPolling();
		};
		es.addEventListener("gitops.event", (event) => {
			const message = event as MessageEvent<string>;
			try {
				eventBuffer.push(JSON.parse(message.data) as GitOpsActivityEvent);
				scheduleFlush();
			} catch (err) {
				activityError = err instanceof Error ? err.message : String(err);
			}
		});
		es.onerror = () => {
			activityConnected = false;
			activityError = null;
			es.close();
			startFallbackPolling();
			if (!activityReconnectTimer) {
				activityReconnecting = true;
				const delay = reconnectDelay;
				reconnectDelay = Math.min(reconnectDelay * 1.5, 30_000);
				activityReconnectTimer = setTimeout(() => {
					activityReconnectTimer = null;
					connectActivityStream();
				}, delay);
			}
		};
	}

</script>

<svelte:head>
	<title>GitOps Pipeline · Workflow Builder</title>
</svelte:head>

{#snippet streamPill()}
	<Badge
		variant="outline"
		class="h-5 gap-1 px-1.5 text-[0.65rem] {debug ? 'cursor-pointer' : ''}"
		title={streamState === "live"
			? `GitOps event stream connected · seq ${latestSequence()}`
			: streamState === "reconnecting"
				? `GitOps event stream reconnecting · seq ${latestSequence()}`
				: `GitOps event stream fallback polling · seq ${latestSequence()}`}
	>
		<Radio
			class="size-2.5 {streamState === 'live'
				? 'animate-pulse text-sky-600 dark:text-sky-300'
				: streamState === 'reconnecting'
					? 'animate-pulse text-amber-600 dark:text-amber-300'
					: 'text-muted-foreground'}"
		/>
		{streamState} {activityEvents.length}
	</Badge>
{/snippet}

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
				{#if debug}
					<Popover.Root>
						<Popover.Trigger>
							{@render streamPill()}
						</Popover.Trigger>
						<Popover.Content class="w-96 p-0" align="start">
							<ActivityFeed events={activityEvents} {now} />
						</Popover.Content>
					</Popover.Root>
					{#if latestEvent}
						<span class="hidden text-[0.7rem] text-muted-foreground sm:inline">
							seq <span class="font-mono">{latestEvent.sequence}</span> · {relativeTime(latestEvent.observedAt, now)}
						</span>
					{/if}
				{:else}
					{@render streamPill()}
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
				<Button
					variant="outline"
					size="sm"
					onclick={() => void refresh({ fresh: true })}
					disabled={loading}
					class="h-7"
				>
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
			{debug}
			onDebugToggle={toggleDebug}
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

	<PipelineDrawer
		{model}
		{selection}
		freightId={selectedFreightId}
		{links}
		events={activityEvents}
		{now}
		onClose={closeDrawer}
	/>
</div>

<style>
	/* Live event-flow motion (Argo event-flow). A node/list-chip pulses when its
	   pipeline target receives a fresh event batch; edges march a dash. Driven by
	   the decaying `gitops-flow` set (CSS only) so it can't churn the model. */
	@keyframes -global-gitops-node-flow {
		0% {
			box-shadow: 0 0 0 0 rgba(56, 189, 248, 0.5);
		}
		100% {
			box-shadow: 0 0 0 8px rgba(56, 189, 248, 0);
		}
	}
	:global(.gitops-flow) {
		animation: gitops-node-flow 1.3s ease-out 2;
	}
	@keyframes -global-gitops-edge-flow {
		to {
			stroke-dashoffset: -22;
		}
	}
</style>
