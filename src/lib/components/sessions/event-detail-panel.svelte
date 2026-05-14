<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import type { SessionEventEnvelope } from '$lib/types/sessions';
	import EventTypePill, { eventKindFor } from './event-type-pill.svelte';
	import JsonView from './json-view.svelte';
	import { Check, Clock, Copy, Download, ExternalLink, Loader2, X } from '@lucide/svelte';

	interface Props {
		event: SessionEventEnvelope;
		/** Elapsed time from session start, ms. */
		elapsedMs?: number;
		/** Debug mode: show raw JSON regardless of event kind. */
		debug?: boolean;
		onClose?: () => void;
	}

	const { event, elapsedMs, debug = false, onClose }: Props = $props();

	const kind = $derived(eventKindFor(event.type));

	// Full-payload fetch: the stream + list endpoints default to preview-only
	// shape so burst traffic stays light. Clicking "Load full payload" hits
	// /api/v1/sessions/[id]/events/[id] which returns the un-stripped envelope.
	let fullPayload = $state<Record<string, unknown> | null>(null);
	let loadingFull = $state(false);
	let fullError = $state<string | null>(null);

	const hasPreviewShape = $derived.by(() => {
		const d = event.data as Record<string, unknown>;
		return (
			('preview' in d && !('content' in d)) ||
			('input_preview' in d && !('input' in d)) ||
			('output_preview' in d && !('output' in d)) ||
			d.oversized === true
		);
	});

	async function loadFull() {
		if (loadingFull || fullPayload) return;
		loadingFull = true;
		fullError = null;
		try {
			const res = await fetch(
				`/api/v1/sessions/${event.sessionId}/events/${event.id}`,
			);
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const body = (await res.json()) as { event?: { data?: Record<string, unknown> } };
			fullPayload = body.event?.data ?? {};
		} catch (err) {
			fullError = err instanceof Error ? err.message : String(err);
		} finally {
			loadingFull = false;
		}
	}

	// When the user navigates to a different event, reset the full-payload
	// fetch state so the next event starts with preview-only again.
	$effect(() => {
		// Depend on event.id so this fires on navigation.
		void event.id;
		fullPayload = null;
		loadingFull = false;
		fullError = null;
	});

	const effectiveData = $derived(fullPayload ?? event.data);

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
		if (kind === 'result') return 'Tool result';
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

	type LlmUsageData = {
		model?: string;
		input_tokens?: number;
		output_tokens?: number;
		cache_read_input_tokens?: number;
		cache_creation_input_tokens?: number;
		ttft_ms?: number | null;
		recovery_attempts?: number;
		success?: boolean;
		error?: string;
	};

	const llmUsage = $derived.by<LlmUsageData | null>(() => {
		if (event.type !== 'agent.llm_usage') return null;
		return event.data as LlmUsageData;
	});

	const llmUsageHitPct = $derived.by(() => {
		const u = llmUsage;
		if (!u) return null;
		const r = Number(u.cache_read_input_tokens ?? 0);
		const i = Number(u.input_tokens ?? 0);
		const denom = r + i;
		if (denom <= 0) return null;
		return Math.round((r / denom) * 100);
	});

	function fmtTokens(n: number | undefined): string {
		const v = Number(n ?? 0);
		if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
		if (v >= 1_000) return `${(v / 1_000).toFixed(1)}k`;
		return String(v);
	}

	const textContent = $derived.by(() => {
		const d = effectiveData as Record<string, unknown>;
		const content = (d.content as Array<{ text?: string }>) ?? [];
		const joined = content
			.map((c) => (typeof c?.text === 'string' ? c.text : ''))
			.filter(Boolean)
			.join('\n\n');
		if (joined) return joined;
		// Fallback to preview when content was stripped for the list shape.
		const preview = d.preview;
		return typeof preview === 'string' ? preview : '';
	});

	// Anthropic-shape image blocks from `content[]`. Rendered inline as a
	// data: URL — browser-use attaches one per `agent.tool_result` to give
	// the Timeline a live filmstrip of the page state per step.
	const imageContent = $derived.by(() => {
		const d = effectiveData as Record<string, unknown>;
		const content = Array.isArray(d.content) ? d.content : [];
		const out: Array<{ url: string; mediaType: string }> = [];
		for (const block of content) {
			if (!block || typeof block !== 'object') continue;
			const b = block as Record<string, unknown>;
			if (b.type !== 'image') continue;
			const src = b.source as Record<string, unknown> | undefined;
			if (src && src.type === 'base64' && typeof src.media_type === 'string' && typeof src.data === 'string') {
				out.push({ url: `data:${src.media_type};base64,${src.data}`, mediaType: src.media_type });
				continue;
			}
			if (typeof b.url === 'string' && b.url.trim()) {
				out.push({ url: b.url.trim(), mediaType: 'image/*' });
			}
		}
		return out;
	});

	const toolInput = $derived.by(() => {
		const d = effectiveData as { input?: unknown; input_preview?: unknown };
		if (d.input !== undefined) return d.input;
		return d.input_preview ?? null;
	});

	const durationMs = $derived.by(() => {
		const d = event.data as { duration_ms?: number; durationMs?: number };
		const v = Number(d?.duration_ms ?? d?.durationMs ?? 0);
		return Number.isFinite(v) && v > 0 ? v : null;
	});

	let copied = $state(false);
	async function copyAll() {
		try {
			const text = debug
				? JSON.stringify(event.data, null, 2)
				: textContent || JSON.stringify(event.data, null, 2);
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
			{#if hasPreviewShape && !fullPayload}
				<Button
					variant="ghost"
					size="icon"
					class="size-7"
					onclick={loadFull}
					disabled={loadingFull}
					title="Load full payload"
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
		{#if debug}
			<div class="text-[10px] font-mono text-muted-foreground mb-2">{event.type}</div>
			<JsonView value={effectiveData} />
		{:else if kind === 'user' || kind === 'agent'}
			<div class="text-[10px] uppercase tracking-wider text-muted-foreground">Content</div>
			<div class="prose prose-sm dark:prose-invert mt-2 max-w-none whitespace-pre-wrap">
				{textContent || '(empty)'}
			</div>
		{:else if kind === 'thinking'}
			<div class="text-[10px] uppercase tracking-wider text-muted-foreground">Reasoning</div>
			<div class="mt-2 whitespace-pre-wrap text-sm text-muted-foreground">
				{textContent || '(no text captured)'}
			</div>
		{:else if kind === 'tool'}
			<div class="text-[10px] uppercase tracking-wider text-muted-foreground">Input</div>
			<div class="mt-2">
				<JsonView value={toolInput} />
			</div>
			{#if imageContent.length > 0}
				<div class="mt-4 text-[10px] uppercase tracking-wider text-muted-foreground">Screenshot</div>
				<div class="mt-2 flex flex-col gap-2">
					{#each imageContent as img, i (i)}
						<img
							src={img.url}
							alt="Browser state"
							loading="lazy"
							class="max-h-[60vh] w-full rounded border border-border/40 object-contain"
						/>
					{/each}
				</div>
			{/if}
		{:else if llmUsage}
			<div class="space-y-3">
				<div class="flex items-center gap-2">
					<span class="text-[10px] uppercase tracking-wider text-muted-foreground">Model</span>
					<code class="text-xs">{llmUsage.model ?? 'unknown'}</code>
					{#if llmUsage.success === false}
						<span class="rounded bg-rose-500/20 px-1.5 py-0 text-[10px] text-rose-200">failed</span>
					{/if}
				</div>
				<div class="grid grid-cols-2 gap-3 text-xs">
					<div>
						<div class="text-[10px] uppercase tracking-wider text-muted-foreground">Input</div>
						<div class="mt-1 font-mono">{fmtTokens(llmUsage.input_tokens)}</div>
					</div>
					<div>
						<div class="text-[10px] uppercase tracking-wider text-muted-foreground">Output</div>
						<div class="mt-1 font-mono">{fmtTokens(llmUsage.output_tokens)}</div>
					</div>
					<div>
						<div class="text-[10px] uppercase tracking-wider text-muted-foreground">
							Cache read{#if llmUsageHitPct !== null} (hit {llmUsageHitPct}%){/if}
						</div>
						<div class="mt-1 font-mono">{fmtTokens(llmUsage.cache_read_input_tokens)}</div>
					</div>
					<div>
						<div class="text-[10px] uppercase tracking-wider text-muted-foreground">Cache created</div>
						<div class="mt-1 font-mono">{fmtTokens(llmUsage.cache_creation_input_tokens)}</div>
					</div>
					{#if llmUsage.ttft_ms != null}
						<div>
							<div class="text-[10px] uppercase tracking-wider text-muted-foreground">TTFT</div>
							<div class="mt-1 font-mono">{Math.round(Number(llmUsage.ttft_ms))}ms</div>
						</div>
					{/if}
					{#if (llmUsage.recovery_attempts ?? 0) > 0}
						<div>
							<div class="text-[10px] uppercase tracking-wider text-muted-foreground">Recoveries</div>
							<div class="mt-1 font-mono">{llmUsage.recovery_attempts}</div>
						</div>
					{/if}
				</div>
				{#if llmUsage.error}
					<div>
						<div class="text-[10px] uppercase tracking-wider text-muted-foreground">Error</div>
						<div class="mt-1 whitespace-pre-wrap text-xs text-rose-300">{llmUsage.error}</div>
					</div>
				{/if}
			</div>
		{:else if event.type === 'hook.decision'}
			{@const d = effectiveData as {
				hook_event?: string;
				matcher?: string | null;
				hook_type?: string;
				plugin_id?: string | null;
				outcome?: string;
				decision?: string | null;
				duration_ms?: number;
				exit_code?: number | null;
				reason?: string | null;
				tool_use_id?: string | null;
			}}
			<div class="grid grid-cols-2 gap-3 text-xs">
				<div>
					<div class="text-[10px] uppercase tracking-wider text-muted-foreground">Hook event</div>
					<div class="mt-1 font-mono">{d.hook_event ?? '-'}</div>
				</div>
				<div>
					<div class="text-[10px] uppercase tracking-wider text-muted-foreground">Decision</div>
					<div class="mt-1 font-mono">{d.decision ?? '-'}</div>
				</div>
				<div>
					<div class="text-[10px] uppercase tracking-wider text-muted-foreground">Matcher</div>
					<div class="mt-1 font-mono truncate">{d.matcher ?? '-'}</div>
				</div>
				<div>
					<div class="text-[10px] uppercase tracking-wider text-muted-foreground">Type</div>
					<div class="mt-1 font-mono">{d.hook_type ?? '-'}</div>
				</div>
				<div>
					<div class="text-[10px] uppercase tracking-wider text-muted-foreground">Outcome</div>
					<div class="mt-1 font-mono">{d.outcome ?? '-'}</div>
				</div>
				<div>
					<div class="text-[10px] uppercase tracking-wider text-muted-foreground">Duration</div>
					<div class="mt-1 font-mono">{d.duration_ms ?? 0}ms</div>
				</div>
				{#if d.plugin_id}
					<div>
						<div class="text-[10px] uppercase tracking-wider text-muted-foreground">Plugin</div>
						<div class="mt-1 font-mono truncate">{d.plugin_id}</div>
					</div>
				{/if}
				{#if d.exit_code != null}
					<div>
						<div class="text-[10px] uppercase tracking-wider text-muted-foreground">Exit code</div>
						<div class="mt-1 font-mono">{d.exit_code}</div>
					</div>
				{/if}
			</div>
			{#if d.reason}
				<div class="mt-3">
					<div class="text-[10px] uppercase tracking-wider text-muted-foreground">Reason</div>
					<div class="mt-1 whitespace-pre-wrap text-xs">{d.reason}</div>
				</div>
			{/if}
		{:else if event.type === 'mcp.tool_call'}
			{@const d = effectiveData as {
				tool_name?: string;
				server?: string | null;
				transport?: string | null;
				tool_use_id?: string | null;
				duration_ms?: number;
				success?: boolean;
				error?: string | null;
			}}
			<div class="grid grid-cols-2 gap-3 text-xs">
				<div>
					<div class="text-[10px] uppercase tracking-wider text-muted-foreground">Tool</div>
					<div class="mt-1 font-mono truncate">{d.tool_name ?? '-'}</div>
				</div>
				<div>
					<div class="text-[10px] uppercase tracking-wider text-muted-foreground">Server</div>
					<div class="mt-1 font-mono truncate">{d.server ?? '-'}</div>
				</div>
				<div>
					<div class="text-[10px] uppercase tracking-wider text-muted-foreground">Transport</div>
					<div class="mt-1 font-mono">{d.transport ?? '-'}</div>
				</div>
				<div>
					<div class="text-[10px] uppercase tracking-wider text-muted-foreground">Duration</div>
					<div class="mt-1 font-mono">{d.duration_ms ?? 0}ms</div>
				</div>
				<div>
					<div class="text-[10px] uppercase tracking-wider text-muted-foreground">Status</div>
					<div class="mt-1 font-mono">{d.success === false ? 'failed' : 'ok'}</div>
				</div>
			</div>
			{#if d.error}
				<div class="mt-3">
					<div class="text-[10px] uppercase tracking-wider text-muted-foreground">Error</div>
					<div class="mt-1 whitespace-pre-wrap text-xs text-rose-300">{d.error}</div>
				</div>
			{/if}
		{:else if kind === 'alert'}
			<JsonView value={effectiveData} />
		{:else}
			<JsonView value={effectiveData} />
		{/if}
	</div>
</div>
