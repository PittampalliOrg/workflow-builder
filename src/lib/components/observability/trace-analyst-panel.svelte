<script lang="ts">
	/**
	 * "Ask the trace" — a Kimi K3 analyst session bound to one execution.
	 *
	 * Embeds SessionTranscript (self-contained SSE) + a composer, exactly like
	 * the canvas author panel. The exceptional part: the analyst cites evidence
	 * as [call:<id>] / [session:<id>] / [span:<id>] tokens; this panel extracts
	 * them from the agent's messages (via the shared refcounted session stream)
	 * into an EVIDENCE strip whose chips navigate the graph (onCite → select
	 * the node / open the drilldown). Answers become a guided tour of the run.
	 */
	import { Sparkles, Send, RotateCcw, Loader2, ExternalLink, Crosshair } from '@lucide/svelte';
	import { page } from '$app/state';
	import {
		createSessionStream,
		type SessionStreamStore,
		type SessionStreamState
	} from '$lib/stores/session-stream.svelte';
	import SessionTranscript from '$lib/components/sessions/session-transcript.svelte';

	export type TraceCitation = { kind: 'call' | 'session' | 'span'; id: string };

	let {
		executionId,
		onCite
	}: {
		executionId: string;
		onCite?: (citation: TraceCitation) => void;
	} = $props();

	const slug = $derived(page.params.slug as string);

	let sessionId = $state<string | null>(null);
	let starting = $state(false);
	let sending = $state(false);
	let errorMessage = $state<string | null>(null);
	let input = $state('');

	const storageKey = $derived(`wb-analyst-session:${executionId}`);

	$effect(() => {
		if (typeof localStorage === 'undefined') return;
		const saved = localStorage.getItem(storageKey);
		if (saved && !sessionId) void adopt(saved);
	});

	async function adopt(id: string) {
		try {
			const res = await fetch(`/api/v1/sessions/${id}`);
			if (res.ok) sessionId = id;
			else localStorage.removeItem(storageKey);
		} catch {
			/* offline */
		}
	}

	async function startSession() {
		if (starting) return;
		starting = true;
		errorMessage = null;
		try {
			const res = await fetch(
				`/api/workflows/executions/${encodeURIComponent(executionId)}/analyst-session`,
				{ method: 'POST' }
			);
			const body = (await res.json().catch(() => ({}))) as {
				sessionId?: string;
				message?: string;
			};
			if (!res.ok || !body.sessionId) {
				errorMessage = body.message || `Could not start analyst session (${res.status})`;
				return;
			}
			sessionId = body.sessionId;
			localStorage.setItem(storageKey, body.sessionId);
		} catch (err) {
			errorMessage = err instanceof Error ? err.message : 'Failed to start analyst session';
		} finally {
			starting = false;
		}
	}

	function resetSession() {
		localStorage.removeItem(storageKey);
		sessionId = null;
		errorMessage = null;
	}

	async function send() {
		const text = input.trim();
		if (!text || !sessionId || sending) return;
		input = '';
		sending = true;
		errorMessage = null;
		try {
			const res = await fetch(`/api/v1/sessions/${sessionId}/events`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					events: [{ type: 'user.message', content: [{ type: 'text', text }] }]
				})
			});
			if (!res.ok) {
				errorMessage = `Send failed (${res.status})`;
				input = text;
			}
		} catch {
			errorMessage = 'Send failed';
			input = text;
		} finally {
			sending = false;
		}
	}

	// ── Evidence extraction from the agent's messages ────────────────────────
	// The session stream store is refcounted, so this shares the SSE connection
	// SessionTranscript already holds — no second stream.
	let streamState = $state<SessionStreamState | null>(null);
	$effect(() => {
		const id = sessionId;
		if (!id) {
			streamState = null;
			return;
		}
		const stream: SessionStreamStore = createSessionStream(id);
		const unsub = stream.subscribe((s) => (streamState = s));
		return () => {
			unsub();
			stream.dispose();
		};
	});

	const CITE_RE = /\[(call|session|span):([A-Za-z0-9_.\-:]+)\]/g;
	// Heuristic fallbacks: models sometimes quote ids in prose/backticks instead
	// of bracket tokens — bare child-session ids (dsw-…__run__N) and journal
	// callIds (40-hex_occurrence) still become evidence chips.
	const SESSION_RE = /\b(dsw-[A-Za-z0-9_-]{8,}__run__\d+)\b/g;
	const CALLID_RE = /\b([a-f0-9]{40}_\d+)\b/g;

	const citations = $derived.by((): TraceCitation[] => {
		if (!streamState) return [];
		const seen = new Set<string>();
		const out: TraceCitation[] = [];
		const add = (kind: TraceCitation['kind'], id: string) => {
			const key = `${kind}:${id}`;
			if (seen.has(key)) return;
			seen.add(key);
			out.push({ kind, id });
		};
		for (const event of streamState.events) {
			if (event.type !== 'agent.message') continue;
			const content = (event.data as { content?: unknown })?.content;
			if (!Array.isArray(content)) continue;
			for (const block of content) {
				const text = (block as { text?: unknown })?.text;
				if (typeof text !== 'string') continue;
				for (const m of text.matchAll(CITE_RE)) add(m[1] as TraceCitation['kind'], m[2]);
				for (const m of text.matchAll(SESSION_RE)) add('session', m[1]);
				for (const m of text.matchAll(CALLID_RE)) add('call', m[1]);
			}
		}
		return out.slice(-12); // most recent evidence wins the strip
	});

	function citeLabel(c: TraceCitation): string {
		return `${c.kind}:${c.id.length > 14 ? `${c.id.slice(0, 14)}…` : c.id}`;
	}
</script>

<div class="flex h-full min-h-0 flex-col">
	{#if !sessionId}
		<div class="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
			<div class="flex size-11 items-center justify-center rounded-xl border border-primary/30 bg-primary/10">
				<Sparkles class="size-5 text-primary" />
			</div>
			<div class="max-w-xs space-y-1">
				<h3 class="text-sm font-semibold">Ask the trace</h3>
				<p class="text-xs text-muted-foreground">
					A Kimi&nbsp;K3 analyst investigates this run's trace with tools (digest, spans, LLM
					turns, logs) and answers with clickable evidence.
				</p>
			</div>
			{#if errorMessage}
				<p class="max-w-xs text-xs text-destructive">{errorMessage}</p>
			{/if}
			<button
				class="inline-flex items-center gap-1.5 rounded-md border border-primary/30 bg-primary/10 px-3 py-1.5 text-xs font-medium text-primary hover:bg-primary/20 disabled:opacity-60"
				onclick={startSession}
				disabled={starting}
			>
				{#if starting}
					<Loader2 class="size-3.5 animate-spin" /> Starting…
				{:else}
					<Sparkles class="size-3.5" /> Start analysis
				{/if}
			</button>
		</div>
	{:else}
		<div class="flex items-center justify-between border-b border-border px-2.5 py-1 text-[10px] text-muted-foreground">
			<span class="inline-flex items-center gap-1">
				<span class="size-1.5 rounded-full bg-primary"></span> Trace analyst
			</span>
			<div class="flex items-center gap-1">
				<a
					href={`/workspaces/${slug}/sessions/${sessionId}`}
					class="inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 hover:bg-accent"
					title="Open full session"
				>
					<ExternalLink class="size-3" /> Session
				</a>
				<button
					class="inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 hover:bg-accent hover:text-destructive"
					onclick={resetSession}
					title="New analysis session"
				>
					<RotateCcw class="size-3" /> Reset
				</button>
			</div>
		</div>

		<div class="min-h-0 flex-1 overflow-hidden">
			<SessionTranscript {sessionId} compact showPulse={false} showTimeline={false} />
		</div>

		{#if citations.length > 0}
			<div class="flex flex-wrap items-center gap-1 border-t border-border px-2 py-1.5">
				<span class="text-[9px] font-semibold uppercase tracking-wider text-muted-foreground/70">
					Evidence
				</span>
				{#each citations as c (c.kind + c.id)}
					<button
						class="inline-flex items-center gap-1 rounded-full border border-primary/30 bg-primary/10 px-1.5 py-0.5 font-mono text-[10px] text-primary hover:bg-primary/20"
						title="Highlight in graph"
						onclick={() => onCite?.(c)}
					>
						<Crosshair class="size-2.5" />
						{citeLabel(c)}
					</button>
				{/each}
			</div>
		{/if}

		{#if errorMessage}
			<div class="border-t border-destructive/30 bg-destructive/10 px-3 py-1 text-[11px] text-destructive">
				{errorMessage}
			</div>
		{/if}

		<div class="border-t border-border p-2">
			<div class="flex items-end gap-1.5">
				<textarea
					bind:value={input}
					onkeydown={(e) => {
						if (e.key === 'Enter' && !e.shiftKey) {
							e.preventDefault();
							void send();
						}
					}}
					rows="2"
					placeholder="Ask about this run… (why slow? what failed? what did the judge see?)"
					class="flex-1 resize-none rounded-md border border-input bg-background px-2.5 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
				></textarea>
				<button
					class="inline-flex size-8 items-center justify-center rounded-md bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
					onclick={send}
					disabled={sending || !input.trim()}
					title="Send"
				>
					{#if sending}
						<Loader2 class="size-3.5 animate-spin" />
					{:else}
						<Send class="size-3.5" />
					{/if}
				</button>
			</div>
		</div>
	{/if}
</div>
