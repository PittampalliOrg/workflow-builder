<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import type { SessionEventEnvelope } from '$lib/types/sessions';
	import EventTypePill, { eventKindFor } from './event-type-pill.svelte';
	import { EventRenderer } from '$lib/components/events';
	import { Check, Clock, Copy, Download, ExternalLink, Loader2, X } from '@lucide/svelte';

	interface Props {
		event: SessionEventEnvelope;
		/** Mate of the selected event when it's part of a tool_use/tool_result pair.
		 *  Resolved by the parent page via `findToolPair`. Null when the selected
		 *  event isn't a tool event or its mate hasn't streamed in yet. */
		pairedResult?: SessionEventEnvelope | null;
		/** Elapsed time from session start, ms. */
		elapsedMs?: number;
		/** Debug mode: show raw JSON regardless of event kind. */
		debug?: boolean;
		onClose?: () => void;
	}

	const { event, pairedResult = null, elapsedMs, debug = false, onClose }: Props = $props();

	const kind = $derived(eventKindFor(event.type));

	// Full-payload fetch: the stream + list endpoints default to preview-only
	// shape so burst traffic stays light. Clicking "Load full payload" hits
	// /api/v1/sessions/[id]/events/[id] which returns the un-stripped envelope.
	let fullPayload = $state<Record<string, unknown> | null>(null);
	let pairedFullPayload = $state<Record<string, unknown> | null>(null);
	let loadingFull = $state(false);
	let fullError = $state<string | null>(null);

	function isPreviewShape(d: Record<string, unknown> | undefined | null): boolean {
		if (!d) return false;
		return (
			('preview' in d && !('content' in d)) ||
			('input_preview' in d && !('input' in d)) ||
			('output_preview' in d && !('output' in d)) ||
			d.oversized === true
		);
	}

	const hasPreviewShape = $derived(isPreviewShape(event.data as Record<string, unknown>));
	const pairedHasPreviewShape = $derived(
		pairedResult ? isPreviewShape(pairedResult.data as Record<string, unknown>) : false
	);

	async function fetchFull(targetSessionId: string, targetEventId: string): Promise<Record<string, unknown> | null> {
		const res = await fetch(`/api/v1/sessions/${targetSessionId}/events/${targetEventId}`);
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const body = (await res.json()) as { event?: { data?: Record<string, unknown> } };
		return body.event?.data ?? null;
	}

	// "Load full" expands the selected event AND its paired mate in one click —
	// otherwise users would have to click Load full on each half of a tool
	// invocation to see both the command and the result.
	async function loadFull() {
		if (loadingFull) return;
		if (fullPayload && (!pairedResult || pairedFullPayload || !pairedHasPreviewShape)) return;
		loadingFull = true;
		fullError = null;
		try {
			const tasks: Promise<unknown>[] = [];
			if (!fullPayload) {
				tasks.push(
					fetchFull(event.sessionId, event.id).then((d) => {
						fullPayload = d ?? {};
					})
				);
			}
			if (pairedResult && !pairedFullPayload && pairedHasPreviewShape) {
				tasks.push(
					fetchFull(pairedResult.sessionId, pairedResult.id).then((d) => {
						pairedFullPayload = d ?? {};
					})
				);
			}
			await Promise.all(tasks);
		} catch (err) {
			fullError = err instanceof Error ? err.message : String(err);
		} finally {
			loadingFull = false;
		}
	}

	// When the user navigates to a different event, reset the full-payload
	// fetch state so the next event starts with preview-only again, then
	// auto-prefetch the full payload (and its pair) so the user doesn't
	// have to click "Load full" on every selection. loadFull is deferred
	// to a microtask so its synchronous state reads/writes (loadingFull,
	// fullPayload) don't leak into this effect's reactive tracking
	// context — otherwise the writes loop the effect (Svelte 5
	// effect_update_depth_exceeded).
	$effect(() => {
		void event.id;
		fullPayload = null;
		pairedFullPayload = null;
		loadingFull = false;
		fullError = null;
		const shouldLoad = hasPreviewShape || pairedHasPreviewShape;
		if (shouldLoad) {
			queueMicrotask(() => {
				void loadFull();
			});
		}
	});

	const effectiveData = $derived(fullPayload ?? event.data);
	// Build a synthetic envelope with the full payload swapped in so EventRenderer
	// renders the latest data without losing event metadata (id, type, sessionId).
	const effectiveEvent = $derived({ ...event, data: effectiveData });
	const effectivePaired = $derived.by(() => {
		if (!pairedResult) return null;
		if (!pairedFullPayload) return pairedResult;
		return { ...pairedResult, data: pairedFullPayload };
	});
	const showLoadFullAffordance = $derived(
		(hasPreviewShape && !fullPayload) || (pairedHasPreviewShape && !pairedFullPayload)
	);

	// OTEL trace deep-link. The agent stamps traceId + spanId on every event
	// envelope in event_publisher._post_ingest (via get_current_trace_context).
	// If present, show a link to the trace explorer so users can pivot from
	// any event row to its backing OTEL span without reconstructing the
	// correlation manually.
	const traceId = $derived.by(() => {
		const d = event.data as { traceId?: unknown };
		return typeof d.traceId === 'string' && d.traceId ? d.traceId : null;
	});
	const spanId = $derived.by(() => {
		const d = event.data as { spanId?: unknown };
		return typeof d.spanId === 'string' && d.spanId ? d.spanId : null;
	});

	const title = $derived.by(() => {
		if (kind === 'user') return 'Message';
		if (kind === 'agent') return 'Message';
		if (kind === 'thinking') return 'Thinking';
		if (kind === 'tool') {
			const d = event.data as { name?: string; tool_name?: string };
			return String(d.name ?? d.tool_name ?? 'Tool use');
		}
		if (kind === 'result') {
			const d = event.data as { name?: string; tool_name?: string };
			return String(d.name ?? d.tool_name ?? 'Tool result');
		}
		if (kind === 'model') {
			if (event.type === 'agent.llm_usage') return 'LLM usage';
			return 'Model request';
		}
		if (kind === 'status') return event.type.replace('session.status_', 'Status: ');
		if (kind === 'adk') return event.type.replace('adk.', 'ADK ');
		if (event.type === 'hook.decision') return 'Hook decision';
		if (event.type === 'mcp.tool_call') return 'MCP tool call';
		if (event.type === 'agent.circuit_breaker_tripped') return 'Circuit breaker tripped';
		if (event.type === 'session.turn_timeout') return 'Turn timeout';
		if (event.type === 'agent.thread_images_compacted') return 'Images compacted';
		if (event.type === 'agent.thread_context_compacted') return 'Context compacted';
		return event.type;
	});

	const durationMs = $derived.by(() => {
		const d = event.data as { duration_ms?: number; durationMs?: number };
		const v = Number(d?.duration_ms ?? d?.durationMs ?? 0);
		return Number.isFinite(v) && v > 0 ? v : null;
	});

	let copied = $state(false);
	async function copyAll() {
		try {
			const text = JSON.stringify(effectiveData, null, 2);
			await navigator.clipboard.writeText(text);
			copied = true;
			setTimeout(() => (copied = false), 1400);
		} catch {
			/* clipboard blocked */
		}
	}

	function fmtElapsed(ms: number): string {
		const t = Math.floor(ms / 1000);
		const h = Math.floor(t / 3600);
		const m = Math.floor((t % 3600) / 60);
		const s = t % 60;
		return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
	}

	function fmtDuration(ms: number): string {
		if (ms < 1000) return `${Math.round(ms)}ms`;
		if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
		const mins = Math.floor(ms / 60_000);
		const secs = Math.floor((ms % 60_000) / 1000);
		return `${mins}m ${secs.toString().padStart(2, '0')}s`;
	}
</script>

<div class="flex h-full flex-col overflow-hidden">
	<div class="flex items-start justify-between gap-2 border-b px-4 py-3">
		<div class="min-w-0 flex-1 space-y-1">
			<div class="flex items-center gap-2">
				<EventTypePill {kind} />
				<h3 class="text-sm font-semibold truncate">{title}</h3>
			</div>
			<div class="flex items-center gap-3 text-[11px] text-muted-foreground">
				{#if elapsedMs !== undefined}
					<span class="font-mono">{fmtElapsed(elapsedMs)}</span>
				{/if}
				{#if durationMs !== null}
					<span class="inline-flex items-center gap-1">
						<Clock class="size-3" />
						{fmtDuration(durationMs)}
					</span>
				{/if}
				<code class="text-[10px] text-muted-foreground/70">{event.id}</code>
				{#if event.producerId}
					<code
						class="text-[10px] text-muted-foreground/70"
						title="Producer epoch {event.producerEpoch ?? '(unset)'}"
					>
						{event.producerId}
					</code>
				{/if}
			</div>
		</div>
		<div class="flex items-center gap-1">
			{#if traceId}
				<Button
					variant="ghost"
					size="icon"
					class="size-7"
					href="/observability/{traceId}"
					title="View OTEL trace ({spanId ? `span ${spanId.slice(0, 8)}…` : 'trace'})"
				>
					<ExternalLink class="size-3.5" />
				</Button>
			{/if}
			{#if showLoadFullAffordance}
				<Button
					variant="ghost"
					size="icon"
					class="size-7"
					onclick={loadFull}
					disabled={loadingFull}
					title="Load full payload (and paired event if any)"
				>
					{#if loadingFull}
						<Loader2 class="size-3.5 animate-spin" />
					{:else}
						<Download class="size-3.5" />
					{/if}
				</Button>
			{/if}
			<Button variant="ghost" size="icon" class="size-7" onclick={copyAll} title="Copy contents">
				{#if copied}
					<Check class="size-3.5 text-green-500" />
				{:else}
					<Copy class="size-3.5" />
				{/if}
			</Button>
			{#if onClose}
				<Button variant="ghost" size="icon" class="size-7" onclick={onClose}>
					<X class="size-3.5" />
				</Button>
			{/if}
		</div>
	</div>

	{#if fullError}
		<div class="border-b border-rose-400/20 bg-rose-500/10 px-4 py-1 text-[11px] text-rose-200">
			Full payload fetch failed: {fullError}
		</div>
	{/if}

	<div class="flex-1 overflow-y-auto px-4 py-3">
		<EventRenderer
			event={effectiveEvent}
			pairedResult={effectivePaired}
			variant="panel"
			{debug}
			hasFullPayload={showLoadFullAffordance}
			loadingFull={loadingFull}
			onLoadFull={loadFull}
		/>
	</div>
</div>
