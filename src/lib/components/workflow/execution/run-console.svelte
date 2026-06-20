<script lang="ts">
	/**
	 * Unified Run Console — "mission control" for one workflow run. Master-detail:
	 * a live session rail (every `durable/run` session as it spawns, grouped by
	 * node, with status + last-line preview + mini-vitals for active ones) plus a
	 * main pane streaming the full transcript of the focused session, which
	 * auto-follows the newest active session unless the user pins one. A top strip
	 * shows aggregate run metrics. Replaces the run page's old Overview link-list.
	 *
	 * Data: the sessions list (`…/sessions`, polled + refreshed on snapshot) drives
	 * the rail; the execution SSE stream supplies live run status + tokens/sec for
	 * the metrics bar + outcome chips; only ACTIVE sessions hold a lightweight
	 * preview stream (capped) so concurrent EventSources stay bounded; the focused
	 * session opens one full stream in the main pane.
	 */
	import { onDestroy, type Snippet } from 'svelte';
	import { createExecutionStream, type ExecutionStreamStore } from '$lib/stores/execution-stream.svelte';
	import { createSessionStream, type SessionStreamStore } from '$lib/stores/session-stream.svelte';
	import type { SessionEventEnvelope } from '$lib/types/sessions';
	import SessionTranscript from '$lib/components/sessions/session-transcript.svelte';
	import RunMetricsBar, {
		type RunMetricsLive,
		type RunMetricsOutcome
	} from '$lib/components/workflow/execution/run-metrics-bar.svelte';
	import { Collapsible, CollapsibleTrigger, CollapsibleContent } from '$lib/components/ui/collapsible';
	import { fmtTokens } from '$lib/utils/format-tokens';
	import { ChevronDown, ExternalLink, Pin, Radio, Inbox } from '@lucide/svelte';

	interface Props {
		executionId: string;
		slug: string;
		workflowId: string;
		/** Preserved run-level cards (live preview, workspace, input/output,
		 *  artifacts) rendered by the parent page inside the Run details drawer. */
		details?: Snippet;
	}

	let { executionId, slug, workflowId, details }: Props = $props();

	type SessionRow = {
		id: string;
		title: string | null;
		status: string | null;
		agentId: string | null;
		createdAt: string | null;
		completedAt: string | null;
	};

	let sessions = $state<SessionRow[]>([]);
	let detailsOpen = $state(false);

	// ── Execution stream (run-level live signals) ──────────────────────────
	let runStatus = $state<string | null>(null);
	let currentNodeName = $state<string | null>(null);
	let tokensPerSec = $state<number | null>(null);
	let toolCallTotal = $state<number | null>(null);
	let isStreaming = $state(false);
	let summaryOutput = $state<Record<string, unknown> | null>(null);
	let output = $state<unknown>(null);

	$effect(() => {
		const exec: ExecutionStreamStore = createExecutionStream(executionId);
		const unsub = exec.subscribe((s) => {
			runStatus = s.snapshot?.status ?? runStatus;
			currentNodeName = s.snapshot?.currentNodeName ?? s.currentPhase ?? currentNodeName;
			toolCallTotal = s.toolCallTotal || toolCallTotal;
			isStreaming = s.isLlmStreaming;
			summaryOutput = s.snapshot?.summaryOutput ?? summaryOutput;
			output = s.snapshot?.output ?? output;
			// tokens/sec from the last-30s rate window
			const win = s.tokenRateWindow;
			if (win.length > 1) {
				const span = (win[win.length - 1].ts - win[0].ts) / 1000;
				const sum = win.reduce((a, b) => a + b.totalDelta, 0);
				tokensPerSec = span > 0 ? sum / span : null;
			} else {
				tokensPerSec = null;
			}
			// New snapshot is a good moment to refresh the authoritative session list.
			if (s.snapshot) void refreshSessions();
		});
		return () => {
			unsub();
			exec.dispose();
		};
	});

	// ── Sessions list (rail source of truth) ───────────────────────────────
	async function refreshSessions() {
		try {
			const res = await fetch(`/api/workflows/executions/${executionId}/sessions`);
			if (res.ok) {
				const data = (await res.json()) as { sessions?: SessionRow[] };
				sessions = data.sessions ?? [];
			}
		} catch {
			// best-effort
		}
	}

	const runActive = $derived(
		runStatus === 'running' ||
			runStatus === 'pending' ||
			sessions.some(
				(s) => s.status === 'running' || s.status === 'idle' || s.status === 'rescheduling'
			)
	);

	$effect(() => {
		void refreshSessions();
		if (!runActive) return;
		const t = setInterval(refreshSessions, 4000);
		return () => clearInterval(t);
	});

	// ── Node grouping ──────────────────────────────────────────────────────
	function nodeOf(s: SessionRow): string {
		const title = s.title ?? '';
		const idx = title.lastIndexOf('·');
		const label = idx >= 0 ? title.slice(idx + 1).trim() : title.trim();
		return label || s.id.slice(0, 12);
	}
	function groupBaseOf(node: string): string {
		// Group by the top-level loop node: "negotiate/propose[0]" → "negotiate",
		// "negotiate-review-0" → "negotiate-review", "plan" → "plan".
		const slash = node.indexOf('/');
		if (slash > 0) return node.slice(0, slash);
		return node.replace(/\[\d+\]$/, '').replace(/-\d+$/, '');
	}
	function isActive(s: SessionRow): boolean {
		return s.status === 'running' || s.status === 'idle' || s.status === 'rescheduling';
	}
	function statusDot(status: string | null): { sym: string; cls: string; label: string } {
		switch (status) {
			case 'running':
			case 'rescheduling':
				return { sym: '▶', cls: 'text-teal-500', label: 'running' };
			case 'idle':
				return { sym: '◷', cls: 'text-amber-500', label: 'idle' };
			case 'error':
				return { sym: '✕', cls: 'text-red-500', label: 'error' };
			case 'terminated':
			case 'completed':
				return { sym: '✓', cls: 'text-emerald-500', label: 'done' };
			default:
				return { sym: '○', cls: 'text-muted-foreground', label: status ?? 'pending' };
		}
	}

	// Ordered by spawn time; render a group header when the base node changes.
	const orderedSessions = $derived.by(() =>
		[...sessions].sort((a, b) => {
			const ta = a.createdAt ? new Date(a.createdAt).getTime() : 0;
			const tb = b.createdAt ? new Date(b.createdAt).getTime() : 0;
			return ta - tb;
		})
	);

	// ── Focus / auto-follow ────────────────────────────────────────────────
	let pinnedId = $state<string | null>(null);
	const newestActiveId = $derived.by(() => {
		const active = orderedSessions.filter(isActive);
		return active.length > 0 ? active[active.length - 1].id : null;
	});
	const focusedId = $derived(
		pinnedId ?? newestActiveId ?? (orderedSessions.length > 0 ? orderedSessions[orderedSessions.length - 1].id : null)
	);
	const following = $derived(pinnedId === null);

	// ── Per-active-session preview streams (capped) ─────────────────────────
	const MAX_PREVIEW_STREAMS = 4;
	type PreviewData = { lastLine: string; inTok: number; outTok: number };
	let previews = $state<Record<string, PreviewData>>({});
	const previewStreams = new Map<string, { store: SessionStreamStore; unsub: () => void }>();

	function summarize(events: SessionEventEnvelope[]): PreviewData {
		let lastLine = '';
		let inTok = 0;
		let outTok = 0;
		for (const e of events) {
			const d = e.data as Record<string, unknown>;
			if (e.type === 'agent.llm_usage') {
				inTok += Number(d.input_tokens ?? 0) || 0;
				outTok += Number(d.output_tokens ?? 0) || 0;
			}
		}
		for (let i = events.length - 1; i >= 0; i--) {
			const e = events[i];
			const d = e.data as Record<string, unknown>;
			if (e.type === 'agent.message' || e.type === 'user.message') {
				const content = (d.content as Array<{ text?: string }>) ?? [];
				const text = content.map((c) => c?.text ?? '').join(' ').trim();
				if (text) {
					lastLine = text;
					break;
				}
			}
			if (
				(e.type === 'agent.tool_use' ||
					e.type === 'agent.mcp_tool_use' ||
					e.type === 'agent.custom_tool_use') &&
				!lastLine
			) {
				const name = (d.name as string) ?? (d.tool_name as string) ?? 'tool';
				lastLine = `⚙ ${name}`;
				break;
			}
		}
		return { lastLine: lastLine.slice(0, 220), inTok, outTok };
	}

	// Reconcile desired preview streams against open ones. Incremental — never
	// disposes everything on each re-run (onDestroy handles full teardown).
	$effect(() => {
		const desired = orderedSessions
			.filter(isActive)
			.slice(-MAX_PREVIEW_STREAMS)
			.map((s) => s.id);
		for (const [id, h] of previewStreams) {
			if (!desired.includes(id)) {
				h.unsub();
				h.store.dispose();
				previewStreams.delete(id);
				const { [id]: _, ...rest } = previews;
				previews = rest;
			}
		}
		for (const id of desired) {
			if (previewStreams.has(id)) continue;
			const store = createSessionStream(id);
			const unsub = store.subscribe((st) => {
				previews = { ...previews, [id]: summarize(st.events) };
			});
			previewStreams.set(id, { store, unsub });
		}
	});

	onDestroy(() => {
		for (const [, h] of previewStreams) {
			h.unsub();
			h.store.dispose();
		}
		previewStreams.clear();
	});

	// ── Resizable rail ─────────────────────────────────────────────────────
	const RAIL_MIN = 240;
	const RAIL_MAX = 560;
	const RAIL_DEFAULT = 340;
	const RAIL_KEY = 'wfb:run-console:rail-width';
	let railWidth = $state(RAIL_DEFAULT);
	let resizing = $state(false);
	let startX = 0;
	let startWidth = RAIL_DEFAULT;

	$effect(() => {
		if (typeof localStorage === 'undefined') return;
		const saved = Number(localStorage.getItem(RAIL_KEY));
		if (Number.isFinite(saved) && saved >= RAIL_MIN && saved <= RAIL_MAX) railWidth = saved;
	});

	function onResizeStart(e: MouseEvent) {
		resizing = true;
		startX = e.clientX;
		startWidth = railWidth;
		e.preventDefault();
	}
	function onResizeMove(e: MouseEvent) {
		if (!resizing) return;
		railWidth = Math.max(RAIL_MIN, Math.min(startWidth + (e.clientX - startX), RAIL_MAX));
	}
	function onResizeEnd() {
		if (!resizing) return;
		resizing = false;
		if (typeof localStorage !== 'undefined') localStorage.setItem(RAIL_KEY, String(railWidth));
	}

	// ── Outcome chips from the run summary output ──────────────────────────
	const outcome = $derived.by<RunMetricsOutcome>(() => {
		const src = (summaryOutput ?? (output as Record<string, unknown> | null)) ?? null;
		if (!src || typeof src !== 'object') return null;
		const o = src as Record<string, unknown>;
		const num = (v: unknown) => (typeof v === 'number' ? v : null);
		const terminalState = typeof o.terminalState === 'string' ? o.terminalState : null;
		const criteriaTotal = num(o.criteriaTotal);
		if (!terminalState && criteriaTotal === null) return null;
		return {
			terminalState,
			criteriaPassed: num(o.criteriaPassed),
			criteriaTotal,
			negotiationRounds: num(o.negotiationRounds),
			iterations: num(o.iterations)
		};
	});

	const live = $derived<RunMetricsLive>({
		tokensPerSec,
		toolCallTotal,
		currentPhase: currentNodeName,
		isStreaming
	});

	function relTime(s: string | null): string {
		if (!s) return '';
		const ms = Date.now() - new Date(s).getTime();
		if (!Number.isFinite(ms)) return '';
		const sec = Math.floor(ms / 1000);
		if (sec < 60) return `${sec}s ago`;
		const m = Math.floor(sec / 60);
		if (m < 60) return `${m}m ago`;
		const h = Math.floor(m / 60);
		return `${h}h ago`;
	}
</script>

<div class="flex h-full flex-col overflow-hidden">
	<!-- Top strip: aggregate run metrics -->
	<RunMetricsBar {executionId} {sessions} {runActive} {live} {outcome} />

	{#if orderedSessions.length === 0}
		<div class="flex flex-1 flex-col items-center justify-center text-muted-foreground">
			<div class="rounded-full bg-muted p-3"><Inbox size={24} /></div>
			<p class="mt-3 text-sm font-medium">
				{runActive ? 'Waiting for sessions…' : 'No sessions in this run'}
			</p>
			<p class="mt-1 text-xs">
				Agent sessions spawned by <code>durable/run</code> nodes will appear here live.
			</p>
		</div>
	{:else}
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div
			class="grid min-h-0 flex-1 overflow-hidden"
			style:grid-template-columns="{railWidth}px 1fr"
			onmousemove={onResizeMove}
			onmouseup={onResizeEnd}
			onmouseleave={onResizeEnd}
		>
			<!-- LEFT RAIL -->
			<div class="flex min-h-0 flex-col border-r">
				<div class="flex items-center justify-between gap-2 border-b px-3 py-1.5">
					<span class="text-xs font-medium text-muted-foreground">
						{orderedSessions.length} session{orderedSessions.length === 1 ? '' : 's'}
					</span>
					<button
						class="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] {following
							? 'bg-teal-500/15 text-teal-600 dark:text-teal-400'
							: 'text-muted-foreground hover:bg-muted'}"
						onclick={() => (pinnedId = null)}
						title={following ? 'Following the newest active session' : 'Resume following latest'}
					>
						{#if following}<Radio class="size-3" /> Following latest{:else}<Pin class="size-3" /> Pinned{/if}
					</button>
				</div>

				<div class="min-h-0 flex-1 overflow-y-auto p-1.5">
					{#each orderedSessions as s, i (s.id)}
						{@const node = nodeOf(s)}
						{@const base = groupBaseOf(node)}
						{@const prevBase = i > 0 ? groupBaseOf(nodeOf(orderedSessions[i - 1])) : null}
						{@const dot = statusDot(s.status)}
						{@const pv = previews[s.id]}
						{#if base !== prevBase}
							<div class="px-1.5 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">
								{base}
							</div>
						{/if}
						<button
							class="mb-1 w-full rounded-md border px-2.5 py-2 text-left transition-colors {focusedId ===
							s.id
								? 'border-primary/50 bg-primary/5'
								: 'border-transparent hover:border-border hover:bg-muted/50'}"
							onclick={() => (pinnedId = s.id)}
						>
							<div class="flex items-center gap-2">
								<span class="{dot.cls} text-xs" title={dot.label}>{dot.sym}</span>
								<span class="min-w-0 flex-1 truncate text-xs font-medium">{node}</span>
								{#if isActive(s)}
									<span class="inline-block size-1.5 animate-pulse rounded-full bg-teal-400/80"></span>
								{/if}
							</div>
							{#if pv?.lastLine}
								<p class="mt-1 line-clamp-2 text-[11px] text-muted-foreground">{pv.lastLine}</p>
							{/if}
							<div class="mt-1 flex items-center gap-2 text-[10px] text-muted-foreground/80">
								{#if pv && pv.inTok + pv.outTok > 0}
									<span>{fmtTokens(pv.inTok)}↓ {fmtTokens(pv.outTok)}↑</span>
								{/if}
								<span class="ml-auto">{relTime(s.createdAt)}</span>
							</div>
						</button>
					{/each}
				</div>

				{#if details}
					<Collapsible bind:open={detailsOpen} class="border-t">
						<CollapsibleTrigger
							class="flex w-full items-center justify-between px-3 py-2 text-xs font-medium hover:bg-muted/50"
						>
							Run details
							<ChevronDown class="size-3.5 transition-transform {detailsOpen ? 'rotate-180' : ''}" />
						</CollapsibleTrigger>
						<CollapsibleContent>
							<div class="max-h-[40vh] space-y-3 overflow-y-auto p-3">
								{@render details()}
							</div>
						</CollapsibleContent>
					</Collapsible>
				{/if}
			</div>

			<!-- Resize handle + MAIN PANE -->
			<div class="relative flex min-h-0 flex-col overflow-hidden">
				<!-- svelte-ignore a11y_no_static_element_interactions -->
				<div
					class="absolute left-0 top-0 bottom-0 z-10 -ml-0.5 w-1 cursor-col-resize transition-colors hover:bg-primary/40"
					class:bg-primary={resizing}
					onmousedown={onResizeStart}
				></div>
				<div class="flex items-center justify-between gap-2 border-b px-3 py-1.5">
					<div class="flex min-w-0 items-center gap-2">
						<span class="truncate text-xs font-medium">
							{focusedId ? nodeOf(orderedSessions.find((s) => s.id === focusedId) ?? ({} as SessionRow)) : '—'}
						</span>
						{#if !following}
							<span class="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] text-amber-600 dark:text-amber-400">
								Pinned
							</span>
						{/if}
					</div>
					{#if focusedId}
						<a
							href="/workspaces/{slug}/sessions/{focusedId}"
							class="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
							title="Open the full session page (terminal / browser / shell / goal)"
						>
							<ExternalLink class="size-3" /> Full page
						</a>
					{/if}
				</div>
				<div class="min-h-0 flex-1 overflow-hidden">
					{#if focusedId}
						{#key focusedId}
							<SessionTranscript sessionId={focusedId} />
						{/key}
					{:else}
						<div class="flex h-full items-center justify-center text-sm text-muted-foreground">
							Select a session on the left.
						</div>
					{/if}
				</div>
			</div>
		</div>
	{/if}

	{#if resizing}
		<div class="fixed inset-0 z-50 cursor-col-resize"></div>
	{/if}
</div>
