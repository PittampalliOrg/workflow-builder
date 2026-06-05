<script lang="ts">
	import { onDestroy, onMount, untrack } from "svelte";
	import {
		AlertTriangle,
		Bug,
		CheckCircle2,
		Clock,
		Pause,
		Play,
		Radio,
		RefreshCw,
		Search,
		X,
	} from "@lucide/svelte";

	import { Badge } from "$lib/components/ui/badge";
	import { Button } from "$lib/components/ui/button";
	import { Input } from "$lib/components/ui/input";
	import type {
		GitOpsActivityEvent,
		GitOpsActivityEventsResponse,
		GitOpsResourceRef,
	} from "$lib/types/gitops-activity";
	import { formatAbsoluteTime, relativeTime } from "$lib/utils/gitops-display";

	import type { PageData } from "./$types";

	type Props = { data: PageData };
	let { data }: Props = $props();

	type PhaseFilter = "all" | "active" | "failed" | "passing" | "unknown";

	const FAILING = /fail|error|degraded|false|cancel/i;
	const PASSING = /succeed|success|healthy|synced|ready|true/i;

	let events = $state<GitOpsActivityEvent[]>(untrack(() => data.events ?? []));
	let loading = $state(false);
	let streamConnected = $state(false);
	let paused = $state(false);
	let requestError = $state<string | null>(null);
	let streamError = $state<string | null>(null);
	let search = $state("");
	let sourceFilter = $state("all");
	let activityFilter = $state("all");
	let resourceFilter = $state("all");
	let phaseFilter = $state<PhaseFilter>("all");
	let selectedEventId = $state<string | null>(untrack(() => data.events?.[0]?.eventId ?? null));
	let now = $state(Date.now());

	let eventSource: EventSource | null = null;
	let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	let clockTimer: ReturnType<typeof setInterval> | null = null;

	const sourceOptions = $derived(uniqueOptions(events.map((event) => event.source)));
	const activityOptions = $derived(uniqueOptions(events.map((event) => event.activityType)));
	const resourceOptions = $derived(
		uniqueOptions(events.map((event) => event.resourceRef.kind ?? event.resourceRef.resource ?? "unknown")),
	);

	const filteredEvents = $derived.by(() => {
		const query = search.trim().toLowerCase();
		return events.filter((event) => {
			if (sourceFilter !== "all" && event.source !== sourceFilter) return false;
			if (activityFilter !== "all" && event.activityType !== activityFilter) return false;
			const resourceKind = event.resourceRef.kind ?? event.resourceRef.resource ?? "unknown";
			if (resourceFilter !== "all" && resourceKind !== resourceFilter) return false;
			if (phaseFilter !== "all" && !matchesPhaseFilter(event, phaseFilter)) return false;
			if (!query) return true;
			return eventSearchText(event).includes(query);
		});
	});

	const selectedEvent = $derived(
		events.find((event) => event.eventId === selectedEventId) ??
			filteredEvents[0] ??
			events[0] ??
			null,
	);
	const selectedCorrelation = $derived(
		selectedEvent ? Object.entries(selectedEvent.correlation).sort(([a], [b]) => a.localeCompare(b)) : [],
	);
	const selectedRawJson = $derived(selectedEvent ? JSON.stringify(selectedEvent.raw, null, 2) : "");
	const stats = $derived.by(() => summarizeEvents(events, filteredEvents));
	const latestEvent = $derived(events[0] ?? null);

	async function refresh() {
		loading = true;
		try {
			const res = await fetch("/api/v1/gitops/events?limit=500");
			if (!res.ok) throw new Error(`events: ${res.status} ${res.statusText}`);
			const body = (await res.json()) as GitOpsActivityEventsResponse;
			events = mergeEvents(events, body.events);
			if (!selectedEventId && events[0]) selectedEventId = events[0].eventId;
			requestError = null;
		} catch (err) {
			requestError = err instanceof Error ? err.message : String(err);
		} finally {
			loading = false;
		}
	}

	function latestSequence(): number {
		return events.reduce((max, event) => Math.max(max, event.sequence), 0);
	}

	function mergeEvents(current: GitOpsActivityEvent[], incoming: GitOpsActivityEvent[]) {
		const byId = new Map(current.map((event) => [event.eventId, event]));
		for (const event of incoming) byId.set(event.eventId, event);
		return [...byId.values()]
			.sort((a, b) => b.sequence - a.sequence)
			.slice(0, 1000);
	}

	function closeStream() {
		eventSource?.close();
		eventSource = null;
		streamConnected = false;
	}

	function connectStream() {
		closeStream();
		if (reconnectTimer) {
			clearTimeout(reconnectTimer);
			reconnectTimer = null;
		}
		const es = new EventSource(`/api/v1/gitops/events/stream?since=${latestSequence()}`);
		eventSource = es;
		es.onopen = () => {
			streamConnected = true;
			streamError = null;
		};
		es.addEventListener("gitops.event", (message) => {
			if (paused) return;
			try {
				const event = JSON.parse((message as MessageEvent<string>).data) as GitOpsActivityEvent;
				events = mergeEvents(events, [event]);
				if (!selectedEventId) selectedEventId = event.eventId;
			} catch (err) {
				streamError = err instanceof Error ? err.message : String(err);
			}
		});
		es.onerror = () => {
			streamConnected = false;
			es.close();
			if (!reconnectTimer) {
				reconnectTimer = setTimeout(() => {
					reconnectTimer = null;
					connectStream();
				}, 5_000);
			}
		};
	}

	function resetFilters() {
		search = "";
		sourceFilter = "all";
		activityFilter = "all";
		resourceFilter = "all";
		phaseFilter = "all";
	}

	function selectEvent(event: GitOpsActivityEvent) {
		selectedEventId = event.eventId;
	}

	onMount(() => {
		connectStream();
		clockTimer = setInterval(() => (now = Date.now()), 30_000);
	});

	onDestroy(() => {
		closeStream();
		if (reconnectTimer) clearTimeout(reconnectTimer);
		if (clockTimer) clearInterval(clockTimer);
	});

	function uniqueOptions(values: Array<string | null | undefined>): string[] {
		return [...new Set(values.filter((value): value is string => Boolean(value)))].sort((a, b) =>
			a.localeCompare(b),
		);
	}

	function summarizeEvents(allEvents: GitOpsActivityEvent[], visibleEvents: GitOpsActivityEvent[]) {
		const failed = allEvents.filter(isFailedEvent).length;
		const passing = allEvents.filter(isPassingEvent).length;
		const active = allEvents.length - failed - passing;
		const bySource = new Map<string, number>();
		for (const event of allEvents) {
			bySource.set(event.source, (bySource.get(event.source) ?? 0) + 1);
		}
		return {
			total: allEvents.length,
			visible: visibleEvents.length,
			failed,
			passing,
			active,
			bySource: [...bySource.entries()].sort(([a], [b]) => a.localeCompare(b)),
		};
	}

	function matchesPhaseFilter(event: GitOpsActivityEvent, filter: PhaseFilter): boolean {
		if (filter === "failed") return isFailedEvent(event);
		if (filter === "passing") return isPassingEvent(event);
		if (filter === "active") return !isFailedEvent(event) && !isPassingEvent(event);
		if (filter === "unknown") return !event.phase && !event.reason;
		return true;
	}

	function eventSearchText(event: GitOpsActivityEvent): string {
		return [
			event.eventId,
			event.sequence,
			event.source,
			event.activityType,
			event.activityKey,
			event.phase,
			event.reason,
			event.message,
			event.resourceRef.group,
			event.resourceRef.kind,
			event.resourceRef.namespace,
			event.resourceRef.name,
			JSON.stringify(event.correlation),
		]
			.filter(Boolean)
			.join(" ")
			.toLowerCase();
	}

	function phaseText(event: GitOpsActivityEvent): string {
		return [event.phase, event.reason].filter(Boolean).join(" / ") || "unknown";
	}

	function eventTone(event: GitOpsActivityEvent): "failed" | "passing" | "active" | "unknown" {
		if (isFailedEvent(event)) return "failed";
		if (isPassingEvent(event)) return "passing";
		if (!event.phase && !event.reason) return "unknown";
		return "active";
	}

	function isFailedEvent(event: GitOpsActivityEvent): boolean {
		return FAILING.test(`${event.phase ?? ""} ${event.reason ?? ""}`);
	}

	function isPassingEvent(event: GitOpsActivityEvent): boolean {
		return PASSING.test(`${event.phase ?? ""} ${event.reason ?? ""}`);
	}

	function resourceLabel(ref: GitOpsResourceRef): string {
		const kind = ref.kind ?? ref.resource ?? "Resource";
		const scope = ref.namespace ? `${ref.namespace}/` : "";
		return `${kind} ${scope}${ref.name ?? "unknown"}`;
	}

	function shortValue(value: unknown): string {
		if (value === null || value === undefined || value === "") return "-";
		if (typeof value === "string") return value;
		return JSON.stringify(value);
	}
</script>

<svelte:head>
	<title>GitOps Events · Workflow Builder</title>
</svelte:head>

<div class="flex h-full flex-col overflow-hidden">
	<header class="border-b px-5 py-3">
		<div class="flex flex-wrap items-center justify-between gap-3">
			<div class="flex min-w-0 items-center gap-2">
				<Bug class="size-5 shrink-0 text-muted-foreground" />
				<h1 class="truncate text-lg font-semibold">GitOps Events</h1>
				<Badge variant="outline" class="h-5 gap-1 px-1.5 text-[0.65rem]">
					<Radio class="size-2.5 {streamConnected ? 'animate-pulse text-sky-600 dark:text-sky-300' : ''}" />
					{streamConnected ? "live" : "poll"} {stats.total}
				</Badge>
				{#if paused}
					<Badge variant="outline" class="h-5 px-1.5 text-[0.65rem]">paused</Badge>
				{/if}
				{#if latestEvent}
					<span class="hidden text-xs text-muted-foreground sm:inline">
						seq <span class="font-mono">{latestEvent.sequence}</span> · {relativeTime(latestEvent.observedAt, now)}
					</span>
				{/if}
			</div>
			<div class="flex flex-wrap items-center gap-2">
				<Button variant="outline" size="sm" href="/admin/gitops/system">
					<CheckCircle2 class="size-3.5" />
					Pipeline
				</Button>
				<Button variant="outline" size="sm" onclick={() => (paused = !paused)}>
					{#if paused}
						<Play class="size-3.5" />
						Resume
					{:else}
						<Pause class="size-3.5" />
						Pause
					{/if}
				</Button>
				<Button variant="outline" size="sm" onclick={connectStream}>
					<Radio class="size-3.5" />
					Reconnect
				</Button>
				<Button variant="outline" size="sm" onclick={refresh} disabled={loading}>
					<RefreshCw class="size-3.5 {loading ? 'animate-spin' : ''}" />
					Refresh
				</Button>
			</div>
		</div>
	</header>

	{#if requestError || streamError}
		<div class="border-b bg-destructive/5 px-5 py-2 text-xs text-destructive">
			<div class="flex items-center gap-2">
				<AlertTriangle class="size-3.5 shrink-0" />
				<span class="truncate">{[requestError, streamError].filter(Boolean).join(" / ")}</span>
			</div>
		</div>
	{/if}

	<div class="border-b px-5 py-3">
		<div class="grid gap-2 md:grid-cols-[minmax(12rem,1fr)_10rem_14rem_10rem_auto]">
			<label class="relative">
				<Search class="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
				<Input class="h-8 pl-7 text-sm" placeholder="Search events" bind:value={search} />
			</label>
			<select bind:value={sourceFilter} class="h-8 rounded-md border bg-background px-2 text-sm">
				<option value="all">All sources</option>
				{#each sourceOptions as source (source)}
					<option value={source}>{source}</option>
				{/each}
			</select>
			<select bind:value={activityFilter} class="h-8 rounded-md border bg-background px-2 text-sm">
				<option value="all">All activity</option>
				{#each activityOptions as activity (activity)}
					<option value={activity}>{activity}</option>
				{/each}
			</select>
			<select bind:value={resourceFilter} class="h-8 rounded-md border bg-background px-2 text-sm">
				<option value="all">All resources</option>
				{#each resourceOptions as resource (resource)}
					<option value={resource}>{resource}</option>
				{/each}
			</select>
			<div class="flex items-center gap-2">
				<select bind:value={phaseFilter} class="h-8 rounded-md border bg-background px-2 text-sm">
					<option value="all">All phases</option>
					<option value="active">Active</option>
					<option value="failed">Failed</option>
					<option value="passing">Passing</option>
					<option value="unknown">Unknown</option>
				</select>
				<Button variant="ghost" size="icon-sm" onclick={resetFilters} title="Clear filters">
					<X class="size-3.5" />
				</Button>
			</div>
		</div>
		<div class="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
			<span>{stats.visible} visible</span>
			<span class="text-muted-foreground/40">/</span>
			<span>{stats.failed} failed</span>
			<span class="text-muted-foreground/40">/</span>
			<span>{stats.active} active</span>
			<span class="text-muted-foreground/40">/</span>
			<span>{stats.passing} passing</span>
			{#each stats.bySource as [source, count] (source)}
				<Badge variant="outline" class="h-5 px-1.5 text-[0.65rem]">{source} {count}</Badge>
			{/each}
		</div>
	</div>

	<div class="grid min-h-0 flex-1 grid-cols-1 overflow-hidden xl:grid-cols-[minmax(0,1fr)_minmax(24rem,34rem)]">
		<section class="min-h-0 overflow-auto border-r">
			<div class="min-w-[920px]">
				<div class="sticky top-0 z-10 grid grid-cols-[5rem_10rem_12rem_18rem_minmax(16rem,1fr)_10rem] border-b bg-background/95 px-4 py-2 text-[0.68rem] font-medium uppercase text-muted-foreground backdrop-blur">
					<div>Seq</div>
					<div>Observed</div>
					<div>Source</div>
					<div>Resource</div>
					<div>Message</div>
					<div>Phase</div>
				</div>
				{#each filteredEvents as event (event.eventId)}
					{@const tone = eventTone(event)}
					<button
						type="button"
						class="grid w-full grid-cols-[5rem_10rem_12rem_18rem_minmax(16rem,1fr)_10rem] items-center border-b px-4 py-2 text-left text-xs hover:bg-muted/50 {selectedEvent?.eventId === event.eventId ? 'bg-muted/70' : ''}"
						onclick={() => selectEvent(event)}
					>
						<div class="font-mono text-muted-foreground">{event.sequence}</div>
						<div class="truncate" title={formatAbsoluteTime(event.observedAt, now)}>
							{relativeTime(event.observedAt, now)}
						</div>
						<div class="min-w-0">
							<div class="truncate font-medium">{event.source}</div>
							<div class="truncate font-mono text-[0.65rem] text-muted-foreground">{event.activityType}</div>
						</div>
						<div class="min-w-0">
							<div class="truncate font-medium" title={resourceLabel(event.resourceRef)}>
								{resourceLabel(event.resourceRef)}
							</div>
							<div class="truncate font-mono text-[0.65rem] text-muted-foreground">{event.activityKey}</div>
						</div>
						<div class="min-w-0 truncate text-muted-foreground" title={event.message ?? event.reason ?? ""}>
							{event.message ?? event.reason ?? "-"}
						</div>
						<div>
							<Badge
								variant={tone === "failed" ? "destructive" : "outline"}
								class="h-5 max-w-full px-1.5 text-[0.65rem] {tone === 'passing'
									? 'border-emerald-400/40 bg-emerald-50/60 text-emerald-700 dark:bg-emerald-950/20 dark:text-emerald-300'
									: tone === 'active'
										? 'border-sky-400/40 bg-sky-50/70 text-sky-700 dark:bg-sky-950/20 dark:text-sky-300'
										: ''}"
							>
								<span class="truncate">{phaseText(event)}</span>
							</Badge>
						</div>
					</button>
				{/each}
				{#if filteredEvents.length === 0}
					<div class="p-8 text-center text-sm text-muted-foreground">No matching events.</div>
				{/if}
			</div>
		</section>

		<aside class="min-h-0 overflow-auto bg-muted/20">
			{#if selectedEvent}
				<div class="border-b bg-background px-4 py-3">
					<div class="flex items-start justify-between gap-3">
						<div class="min-w-0">
							<div class="truncate text-sm font-semibold">{resourceLabel(selectedEvent.resourceRef)}</div>
							<div class="mt-1 truncate font-mono text-[0.68rem] text-muted-foreground">{selectedEvent.eventId}</div>
						</div>
						<Badge variant="outline" class="h-5 px-1.5 text-[0.65rem]">seq {selectedEvent.sequence}</Badge>
					</div>
					<div class="mt-3 grid grid-cols-2 gap-2 text-xs">
						<div>
							<div class="text-muted-foreground">Source</div>
							<div class="font-medium">{selectedEvent.source}</div>
						</div>
						<div>
							<div class="text-muted-foreground">Activity</div>
							<div class="font-medium">{selectedEvent.activityType}</div>
						</div>
						<div>
							<div class="text-muted-foreground">Observed</div>
							<div class="font-medium">{formatAbsoluteTime(selectedEvent.observedAt, now)}</div>
						</div>
						<div>
							<div class="text-muted-foreground">Stored</div>
							<div class="font-medium">{relativeTime(selectedEvent.createdAt, now)}</div>
						</div>
					</div>
				</div>

				<div class="space-y-4 p-4">
					<section>
						<div class="mb-2 flex items-center gap-2 text-xs font-medium uppercase text-muted-foreground">
							<Clock class="size-3.5" />
							Status
						</div>
						<div class="rounded-md border bg-background p-3 text-sm">
							<div class="font-medium">{phaseText(selectedEvent)}</div>
							{#if selectedEvent.message}
								<div class="mt-1 text-sm text-muted-foreground">{selectedEvent.message}</div>
							{/if}
						</div>
					</section>

					<section>
						<div class="mb-2 text-xs font-medium uppercase text-muted-foreground">Correlation</div>
						<div class="divide-y rounded-md border bg-background">
							{#each selectedCorrelation as [key, value] (key)}
								<div class="grid grid-cols-[9rem_minmax(0,1fr)] gap-2 px-3 py-2 text-xs">
									<div class="truncate font-mono text-muted-foreground">{key}</div>
									<div class="truncate font-mono" title={shortValue(value)}>{shortValue(value)}</div>
								</div>
							{/each}
							{#if selectedCorrelation.length === 0}
								<div class="px-3 py-2 text-xs text-muted-foreground">No correlation fields.</div>
							{/if}
						</div>
					</section>

					<section>
						<div class="mb-2 text-xs font-medium uppercase text-muted-foreground">Raw</div>
						<pre class="max-h-[32rem] overflow-auto rounded-md border bg-background p-3 text-[0.68rem] leading-relaxed text-muted-foreground">{selectedRawJson}</pre>
					</section>
				</div>
			{:else}
				<div class="p-8 text-center text-sm text-muted-foreground">No event selected.</div>
			{/if}
		</aside>
	</div>
</div>
