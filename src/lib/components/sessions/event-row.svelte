<script lang="ts">
	import type { SessionEventEnvelope } from '$lib/types/sessions';
	import EventTypePill, { eventKindFor } from './event-type-pill.svelte';
	import { Clock, FileText, Moon, Zap, Megaphone, TriangleAlert } from '@lucide/svelte';
	import { memberColor } from '$lib/components/teams/member-color';

	interface Props {
		event: SessionEventEnvelope;
		selected?: boolean;
		onClick?: () => void;
		/** Time relative to the session start, in ms. */
		elapsedMs?: number;
		/** Number of events collapsed into this row (consecutive same-tool). */
		batchCount?: number;
		/** Token usage paired from the next agent.llm_usage / span.model_request_end
		 *  with a matching tool_use_id. Surfaced as `(in/out)` next to tool rows
		 *  so users can scan the cost of each tool call without expanding it. */
		pairedTokens?: { input: number; output: number } | null;
	}

	const {
		event,
		selected = false,
		onClick,
		elapsedMs,
		batchCount = 1,
		pairedTokens = null
	}: Props = $props();

	const kind = $derived(eventKindFor(event.type));

	// Team-origin messages carry sender identity (origin/fromAgent set by
	// team-messaging) — surfaced as a member-colored sender chip on the row.
	const teamSender = $derived.by(() => {
		if (event.type !== 'user.message') return null;
		const d = event.data as Record<string, unknown>;
		const origin = typeof d.origin === 'string' ? d.origin : '';
		if (
			origin !== 'teammate-message' &&
			origin !== 'team-broadcast' &&
			origin !== 'team-idle' &&
			origin !== 'team-error'
		) {
			return null;
		}
		return {
			name: typeof d.fromAgent === 'string' ? d.fromAgent : 'team',
			broadcast: origin === 'team-broadcast',
			failed: origin === 'team-error'
		};
	});

	const preview = $derived.by(() => {
		const d = event.data as Record<string, unknown>;
		// User / Agent / Thinking: first chunk of text content. Falls back to
		// `data.preview` (set by stripFullPayload when `content` is replaced
		// for the list/stream shape) so the row never shows an empty label.
		if (kind === 'user' || kind === 'agent' || kind === 'thinking') {
			const content = Array.isArray(d.content) ? (d.content as Array<{ text?: string }>) : [];
			const joined = content
				.map((c) => (typeof c?.text === 'string' ? c.text : ''))
				.join(' ')
				.trim();
			if (joined) return joined.slice(0, 200);
			if (typeof d.preview === 'string' && d.preview.trim()) {
				return d.preview.trim().slice(0, 200);
			}
			return kind === 'thinking' ? '(no thinking text)' : '(no content)';
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
			if (event.type === 'llm_start') {
				return String(d.model ?? d.component ?? 'LLM started');
			}
			if (event.type === 'agent.context_usage') {
				const active = Number(d.context_input_tokens ?? 0);
				const parts = [`active ${fmtTokens(active)}`];
				const ctxUsed = contextUsedPercentage(d);
				if (ctxUsed !== null) parts.push(`ctx ${fmtPercent(ctxUsed)}`);
				if (d.context_count_method) parts.push(String(d.context_count_method));
				return parts.join(' · ');
			}
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
			const ctxUsed = contextUsedPercentage(d);
			if (ctxUsed !== null) parts.push(`ctx ${fmtPercent(ctxUsed)}`);
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
		if (kind === 'adk') {
			return event.type.replace('adk.', 'ADK ');
		}
		if (kind === 'lifecycle') {
			// Hibernation storytelling — the sandbox scaled 0↔1, not an error.
			if (event.type === 'session.host_suspended') {
				const idle = Number(d.idleSeconds ?? 0);
				return idle > 0
					? `Hibernated — sandbox scaled to zero after ${idle}s idle`
					: 'Hibernated — sandbox scaled to zero';
			}
			const n = Number(d.raisedEvents ?? 0);
			return `Woken — ${n} message${n === 1 ? '' : 's'} delivered`;
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
		// Paired-tokens win — when set, the parent already resolved the
		// downstream model usage for this tool_use, which is the cost users
		// actually want to see on a tool row (CMA parity).
		if (pairedTokens) {
			return `${fmtTokens(pairedTokens.input)} / ${fmtTokens(pairedTokens.output)}`;
		}
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

	function fmtPercent(value: number): string {
		if (!Number.isFinite(value)) return '0%';
		const clamped = Math.max(0, Math.min(100, value));
		if (clamped > 0 && clamped < 10) return `${clamped.toFixed(1).replace(/\.0$/, '')}%`;
		return `${Math.round(clamped)}%`;
	}

	function contextUsedPercentage(d: Record<string, unknown>): number | null {
		const input = Number(d.context_input_tokens ?? 0);
		const window = Number(d.context_window_size ?? 0);
		if (Number.isFinite(input) && Number.isFinite(window) && input >= 0 && window > 0) {
			return (input / window) * 100;
		}
		if (d.context_used_percentage !== undefined) return Number(d.context_used_percentage);
		return null;
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
	{#if kind === 'lifecycle'}
		{#if event.type === 'session.host_suspended'}
			<Moon class="size-3 shrink-0 text-indigo-300" />
		{:else}
			<Zap class="size-3 shrink-0 text-amber-400" />
		{/if}
	{/if}
	{#if teamSender}
		{@const c = memberColor(teamSender.name)}
		<span class="inline-flex shrink-0 items-center gap-1 rounded-full border px-1.5 py-0 text-[9px] font-medium {teamSender.failed ? 'border-red-400/50 bg-red-500/10 text-red-300' : `${c.ring} ${c.bg} ${c.text}`}">
			<span class="size-1.5 rounded-full {teamSender.failed ? 'bg-red-400' : c.dot}"></span>{teamSender.name}
			{#if teamSender.broadcast}<Megaphone class="size-2.5 text-amber-400" />{/if}
			{#if teamSender.failed}<TriangleAlert class="size-2.5 text-red-400" />{/if}
		</span>
	{/if}
	<span class="flex-1 truncate text-foreground/90" title={preview}>
		{preview}{#if batchCount > 1}<span class="ml-1 text-muted-foreground/80">×{batchCount}</span>{/if}
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
