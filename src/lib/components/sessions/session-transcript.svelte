<script lang="ts">
	/**
	 * Self-contained CMA-style transcript for ONE session: opens its own
	 * per-session SSE stream, renders the SessionPulse vitals + the compact
	 * event list + the expanded detail panel, with a transcript/debug toggle.
	 *
	 * It is the main-pane renderer for the unified Run Console and a reusable
	 * sibling to the full `sessions/[id]` page (which additionally hosts the
	 * terminal/browser/shell/goal modes + the message composer). The derive
	 * pipeline is shared via `transcript-model.ts`, so both surfaces render
	 * identically.
	 *
	 * `sessionId` is reactive: when it changes (the console focusing a new
	 * session) the old stream is disposed and a fresh one opened.
	 */
	import type { SessionDetail, SessionEventEnvelope } from '$lib/types/sessions';
	import {
		createSessionStream,
		type SessionStreamStore,
		type InFlightPartial
	} from '$lib/stores/session-stream.svelte';
	import { findToolPair, computeTokenAssignments } from '$lib/utils/tool-pair';
	import {
		filterDisplayEvents,
		batchEvents,
		buildListRows,
		buildProvisioningTimeline,
		fmtIdleGap
	} from '$lib/components/sessions/transcript-model';
	import ProvisioningStepper from '$lib/components/workflow/execution/provisioning-stepper.svelte';
	import EventRow from '$lib/components/sessions/event-row.svelte';
	import EventDetailPanel from '$lib/components/sessions/event-detail-panel.svelte';
	import BatchDetailPanel from '$lib/components/sessions/batch-detail-panel.svelte';
	import SessionTimelineBar from '$lib/components/sessions/session-timeline-bar.svelte';
	import SessionPulse from '$lib/components/sessions/session-pulse.svelte';
	import { Skeleton } from '$lib/components/ui/skeleton';

	interface Props {
		sessionId: string;
		/** Show the SessionPulse vitals strip above the transcript. */
		showPulse?: boolean;
		/** Render the timeline bar above the list. */
		showTimeline?: boolean;
		/** Narrow-container mode (e.g. the canvas right panel): force a SINGLE column
		 *  (the event-list│detail split is viewport-gated via `lg:` and wrongly triggers
		 *  in a narrow panel because the window is wide), and show event detail as an
		 *  overlay over the list instead of a side column. */
		compact?: boolean;
		/** Extra classes for the root element. */
		class?: string;
	}

	let {
		sessionId,
		showPulse = true,
		showTimeline = true,
		compact = false,
		class: className = ''
	}: Props = $props();

	let viewMode = $state<'transcript' | 'debug'>('transcript');
	let events = $state<SessionEventEnvelope[]>([]);
	let session = $state<SessionDetail | null>(null);
	let inFlightPartials = $state<Record<string, InFlightPartial>>({});
	let isConsolidating = $state(false);
	let isConnected = $state(false);
	let loading = $state(true);
	let selectedEventId = $state<string | null>(null);
	let scrollEl: HTMLDivElement | undefined = $state();

	// (Re)open the per-session stream whenever sessionId changes. Disposes the
	// prior stream so the Run Console never leaks EventSources when the user
	// switches focus.
	$effect(() => {
		const id = sessionId;
		// Reset view state for the newly-focused session.
		events = [];
		session = null;
		inFlightPartials = {};
		loading = true;
		selectedEventId = null;
		const stream: SessionStreamStore = createSessionStream(id);
		const unsub = stream.subscribe((state) => {
			isConnected = state.isConnected;
			isConsolidating = state.isConsolidating;
			events = state.events;
			inFlightPartials = state.inFlightPartials;
			if (state.session) session = state.session;
			if (state.events.length > 0 || state.session) loading = false;
			queueScroll();
		});
		return () => {
			unsub();
			stream.dispose();
		};
	});

	function queueScroll() {
		queueMicrotask(() => {
			if (scrollEl) scrollEl.scrollTop = scrollEl.scrollHeight;
		});
	}

	const displayEvents = $derived.by(() =>
		filterDisplayEvents(events, { debug: viewMode === 'debug' })
	);
	const provisioning = $derived(buildProvisioningTimeline(events));
	const tokenAssignments = $derived(computeTokenAssignments(events));
	const batchedEvents = $derived(batchEvents(displayEvents, viewMode === 'debug'));
	const listRows = $derived(buildListRows(batchedEvents, viewMode === 'debug'));

	const sessionStartMs = $derived.by(() => {
		if (!session?.createdAt) return null;
		return new Date(session.createdAt).getTime();
	});
	const selectedEvent = $derived.by(() => {
		const list = displayEvents;
		if (list.length === 0) return null;
		const explicit = list.find((e) => String(e.id) === selectedEventId);
		return explicit ?? list[list.length - 1];
	});
	const selectedBatch = $derived.by(() => {
		if (!selectedEvent) return null;
		return batchedEvents.find((b) => String(b.event.id) === String(selectedEvent.id)) ?? null;
	});
	const selectedPairedResult = $derived.by(() => {
		if (!selectedEvent) return null;
		const pair = findToolPair(events, selectedEvent);
		if (pair.start === selectedEvent) return pair.end ?? null;
		if (pair.end === selectedEvent) return pair.start ?? null;
		return null;
	});
</script>

<div class="flex h-full flex-col overflow-hidden {className}">
	{#if showPulse}
		<SessionPulse {sessionId} {events} status={session?.status} createdAt={session?.createdAt} />
	{/if}

	<!-- Transcript / Debug toggle -->
	<div class="flex items-center gap-2 border-b px-3 py-1.5">
		<div class="inline-flex rounded-md border bg-muted/30 p-0.5">
			<button
				class="rounded px-3 py-1 text-xs {viewMode === 'transcript'
					? 'bg-background shadow-sm'
					: 'text-muted-foreground'}"
				onclick={() => (viewMode = 'transcript')}
			>
				Transcript
			</button>
			<button
				class="rounded px-3 py-1 text-xs {viewMode === 'debug'
					? 'bg-background shadow-sm'
					: 'text-muted-foreground'}"
				onclick={() => (viewMode = 'debug')}
			>
				Debug
			</button>
		</div>
		<span class="text-[11px] text-muted-foreground">
			{displayEvents.length} of {events.length}
		</span>
		{#if isConsolidating}
			<span class="text-[11px] text-amber-500">catching up…</span>
		{:else if isConnected}
			<span class="inline-block size-1.5 rounded-full bg-teal-400/80" title="streaming"></span>
		{/if}
	</div>

	{#if provisioning}
		<div class="flex items-center gap-2 border-b px-3 py-1.5">
			<span class="text-[10px] font-medium uppercase tracking-wide text-muted-foreground"
				>Sandbox</span
			>
			<ProvisioningStepper
				timeline={provisioning.marks}
				phase={provisioning.phase}
				failedReason={provisioning.failedReason}
			/>
		</div>
	{/if}

	{#if showTimeline && displayEvents.length > 0}
		<div class="border-b px-3 py-2">
			<SessionTimelineBar
				events={displayEvents}
				selectedId={selectedEvent ? String(selectedEvent.id) : null}
				onSelect={(id) => (selectedEventId = id)}
			/>
		</div>
	{/if}

	<div
		class="relative grid flex-1 grid-cols-1 overflow-hidden {compact
			? ''
			: 'lg:grid-cols-[minmax(240px,360px)_1fr]'}"
	>
		<!-- Left: compact event list -->
		<div bind:this={scrollEl} class="overflow-y-auto py-1 {compact ? '' : 'border-r'}">
			{#if loading}
				<div class="space-y-1.5 p-3">
					<Skeleton class="h-6" />
					<Skeleton class="h-6" />
					<Skeleton class="h-6" />
				</div>
			{:else if displayEvents.length === 0}
				<div class="px-4 py-16 text-center text-sm text-muted-foreground">
					{session?.status === 'terminated'
						? 'Session ended with no events.'
						: 'Waiting for the agent to start…'}
				</div>
			{:else}
				<div class="space-y-0.5 px-1.5">
					{#each listRows as row (row.key)}
						{#if row.kind === 'separator'}
							<div
								class="my-2 flex items-center gap-2 text-[10px] uppercase tracking-wider text-muted-foreground/70"
							>
								<span class="h-px flex-1 bg-border/60"></span>
								<span>Session idle · {fmtIdleGap(row.sinceMs)}</span>
								<span class="h-px flex-1 bg-border/60"></span>
							</div>
						{:else}
							{@const batch = row.batch}
							{@const elapsed =
								sessionStartMs !== null
									? new Date(batch.event.createdAt).getTime() - sessionStartMs
									: undefined}
							{@const tokens = tokenAssignments.get(batch.event.id) ?? null}
							<EventRow
								event={batch.event}
								batchCount={batch.count}
								pairedTokens={tokens}
								selected={selectedEvent
									? String(selectedEvent.id) === String(batch.event.id)
									: false}
								elapsedMs={elapsed}
								onClick={() => (selectedEventId = String(batch.event.id))}
							/>
						{/if}
					{/each}
					{#each Object.entries(inFlightPartials) as [key, partial] (key)}
						<div
							class="flex items-start gap-2 rounded border border-dashed border-teal-400/20 bg-teal-500/5 px-2 py-1.5 text-xs"
							title="streaming from the model"
						>
							<span
								class="inline-flex shrink-0 items-center rounded border px-1.5 py-0 text-[9px] font-medium
								{partial.kind === 'thinking'
									? 'border-emerald-400/20 bg-emerald-500/25 text-emerald-200'
									: partial.kind === 'tool_input'
										? 'border-border bg-muted text-muted-foreground'
										: 'border-teal-400/20 bg-teal-500/25 text-teal-200'}"
							>
								{partial.kind === 'thinking'
									? 'Thinking…'
									: partial.kind === 'tool_input'
										? 'Tool…'
										: 'Agent…'}
							</span>
							<span class="flex-1 truncate font-mono text-[11px] text-foreground/80">
								{partial.text.slice(-120)}
							</span>
							<span
								class="inline-block size-1.5 shrink-0 animate-pulse rounded-full bg-teal-400/80"
							></span>
						</div>
					{/each}
				</div>
			{/if}
		</div>

		<!-- Detail panel: a side column normally; in compact (narrow panel) an overlay
		     over the list, shown only when an event is selected, so the list keeps full
		     width. -->
		{#if compact}
			{#if selectedBatch || selectedEvent}
				<div class="absolute inset-0 z-10 overflow-hidden border-l-0 bg-background">
					{#if selectedBatch && selectedBatch.count > 1}
						<BatchDetailPanel
							children={selectedBatch.children}
							{events}
							{sessionStartMs}
							debug={viewMode === 'debug'}
							onClose={() => (selectedEventId = null)}
						/>
					{:else if selectedEvent}
						{@const elapsedC =
							sessionStartMs !== null
								? new Date(selectedEvent.createdAt).getTime() - sessionStartMs
								: undefined}
						<EventDetailPanel
							event={selectedEvent}
							pairedResult={selectedPairedResult}
							elapsedMs={elapsedC}
							debug={viewMode === 'debug'}
							onClose={() => (selectedEventId = null)}
						/>
					{/if}
				</div>
			{/if}
		{:else}
			<div class="overflow-hidden">
				{#if selectedBatch && selectedBatch.count > 1}
					<BatchDetailPanel
						children={selectedBatch.children}
						{events}
						{sessionStartMs}
						debug={viewMode === 'debug'}
						onClose={() => (selectedEventId = null)}
					/>
				{:else if selectedEvent}
					{@const elapsed =
						sessionStartMs !== null
							? new Date(selectedEvent.createdAt).getTime() - sessionStartMs
							: undefined}
					<EventDetailPanel
						event={selectedEvent}
						pairedResult={selectedPairedResult}
						elapsedMs={elapsed}
						debug={viewMode === 'debug'}
						onClose={() => (selectedEventId = null)}
					/>
				{:else if !loading}
					<div class="flex h-full items-center justify-center p-8 text-sm text-muted-foreground">
						Select an event on the left to see its content.
					</div>
				{/if}
			</div>
		{/if}
	</div>
</div>
