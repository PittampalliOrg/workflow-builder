<script lang="ts">
	import type { SessionEventEnvelope } from '$lib/types/sessions';
	import EventTypePill, { eventKindFor } from './event-type-pill.svelte';
	import { Clock, FileText } from 'lucide-svelte';

	interface Props {
		event: SessionEventEnvelope;
		selected?: boolean;
		onClick?: () => void;
		/** Time relative to the session start, in ms. */
		elapsedMs?: number;
		/** Number of events collapsed into this row (consecutive same-tool). */
		batchCount?: number;
	}

	const { event, selected = false, onClick, elapsedMs, batchCount = 1 }: Props = $props();

	const kind = $derived(eventKindFor(event.type));

	const preview = $derived.by(() => {
		const d = event.data as Record<string, unknown>;
		// User / Agent / Thinking: first chunk of text content.
		if (kind === 'user' || kind === 'agent' || kind === 'thinking') {
			const content = (d.content as Array<{ text?: string }>) ?? [];
			const joined = content
				.map((c) => (typeof c?.text === 'string' ? c.text : ''))
				.join(' ')
				.trim();
			return joined.slice(0, 80);
		}
		// Tool use: tool name.
		if (kind === 'tool') {
			return String(d.name ?? d.tool_name ?? 'tool_use');
		}
		// Tool result: truncated summary or 'Tool result'.
		if (kind === 'result') {
			return 'Tool result';
		}
		if (kind === 'model') {
			const inTok = Number(d.input_tokens ?? 0);
			const outTok = Number(d.output_tokens ?? 0);
			const cacheRead = Number(d.cache_read_input_tokens ?? 0);
			const cacheCreate = Number(d.cache_creation_input_tokens ?? 0);
			const parts = [`${fmtTokens(inTok)} in`, `${fmtTokens(outTok)} out`];
			if (cacheRead > 0) {
				const denom = cacheRead + inTok;
				const pct = denom > 0 ? Math.round((cacheRead / denom) * 100) : 0;
				parts.push(`cache ${fmtTokens(cacheRead)} (${pct}%)`);
			}
			if (cacheCreate > 0) parts.push(`+${fmtTokens(cacheCreate)} cached`);
			return parts.join(' · ');
		}
		if (kind === 'status') {
			return String(event.type).replace('session.status_', '').replace(/^./, (c) => c.toUpperCase());
		}
		if (kind === 'hook') {
			const ev = String(d.hook_event ?? '');
			const decision = String(d.decision ?? d.outcome ?? '');
			const matcher = d.matcher ? ` (${String(d.matcher)})` : '';
			return `${ev}${matcher} · ${decision}`;
		}
		if (kind === 'mcp') {
			const name = String(d.tool_name ?? 'tool');
			const server = d.server ? ` @${String(d.server)}` : '';
			const dur = Number(d.duration_ms ?? 0);
			const status = d.success === false ? ' · failed' : '';
			return `${name}${server} · ${dur}ms${status}`;
		}
		if (kind === 'alert') {
			if (event.type === 'agent.circuit_breaker_tripped') {
				return `Circuit breaker: ${String(d.reason ?? '')} (${d.streak ?? '?'}/${d.threshold ?? '?'})`;
			}
			if (event.type === 'session.turn_timeout') {
				return `Turn ${d.turn ?? '?'} timed out after ${d.timeout_seconds ?? '?'}s`;
			}
			if (event.type === 'agent.thread_images_compacted') {
				return `Collapsed ${d.collapsed ?? '?'} screenshot(s); kept last ${d.kept ?? '?'}`;
			}
			if (event.type === 'agent.thread_context_compacted') {
				return 'Thread context compacted';
			}
			if (event.type === 'session.error') {
				const err = String(d.error ?? '').slice(0, 80);
				return `Session error${err ? `: ${err}` : ''}`;
			}
		}
		return event.type;
	});

	const tokens = $derived.by(() => {
		const d = event.data as { usage?: { input_tokens?: number; output_tokens?: number } };
		if (d?.usage) {
			const i = d.usage.input_tokens;
			const o = d.usage.output_tokens;
			if (i !== undefined || o !== undefined) {
				return `${fmtTokens(i ?? 0)} / ${fmtTokens(o ?? 0)}`;
			}
		}
		return null;
	});

	const durationMs = $derived.by(() => {
		const d = event.data as { duration_ms?: number; durationMs?: number };
		const v = Number(d?.duration_ms ?? d?.durationMs ?? 0);
		return Number.isFinite(v) && v > 0 ? v : null;
	});

	function fmtTokens(n: number): string {
		if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
		if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
		return String(n);
	}

	function fmtDuration(ms: number): string {
		if (ms < 1000) return `${Math.round(ms)}ms`;
		if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
		const mins = Math.floor(ms / 60_000);
		const secs = Math.floor((ms % 60_000) / 1000);
		return `${mins}m ${secs.toString().padStart(2, '0')}s`;
	}

	function fmtElapsed(ms: number): string {
		const totalSec = Math.floor(ms / 1000);
		const h = Math.floor(totalSec / 3600);
		const m = Math.floor((totalSec % 3600) / 60);
		const s = totalSec % 60;
		return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
	}
</script>

<button
	type="button"
	class="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs transition-colors hover:bg-muted/40 {selected
		? 'bg-muted/60'
		: ''}"
	onclick={onClick}
>
	<EventTypePill {kind} size="xs" />
	<span class="flex-1 truncate text-foreground/90" title={preview}>
		{preview}{#if batchCount > 1}
			<span class="ml-1 rounded bg-muted px-1 py-0 text-[9px] text-muted-foreground"
				>× {batchCount}</span
			>
		{/if}
	</span>
	{#if tokens}
		<span class="inline-flex items-center gap-0.5 text-[10px] text-muted-foreground" title="tokens in / out">
			<FileText class="size-2.5" />
			{tokens}
		</span>
	{/if}
	{#if durationMs !== null}
		<span class="inline-flex items-center gap-0.5 text-[10px] text-muted-foreground" title="duration">
			<Clock class="size-2.5" />
			{fmtDuration(durationMs)}
		</span>
	{/if}
	{#if elapsedMs !== undefined}
		<span class="w-14 shrink-0 text-right font-mono text-[10px] text-muted-foreground/70">
			{fmtElapsed(elapsedMs)}
		</span>
	{/if}
</button>
