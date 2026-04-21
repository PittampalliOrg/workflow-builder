<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import type { SessionEventEnvelope } from '$lib/types/sessions';
	import EventTypePill, { eventKindFor } from './event-type-pill.svelte';
	import JsonView from './json-view.svelte';
	import { Check, Clock, Copy, Download, Loader2, X } from 'lucide-svelte';

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
			</div>
		</div>
		<div class="flex items-center gap-1">
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
		{:else}
			<JsonView value={effectiveData} />
		{/if}
	</div>
</div>
