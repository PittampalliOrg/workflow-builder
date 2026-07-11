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
	import { fly } from 'svelte/transition';
	import type { Node, Edge } from '@xyflow/svelte';
	import { createExecutionStream, type ExecutionStreamStore } from '$lib/stores/execution-stream.svelte';
	import { createSessionStream, type SessionStreamStore } from '$lib/stores/session-stream.svelte';
	import type { SessionEventEnvelope } from '$lib/types/sessions';
	import type { ExecutionReadModel, ExecutionStepLog } from '$lib/types/execution-stream';
	import SessionTranscript from '$lib/components/sessions/session-transcript.svelte';
	import CliTerminalTabs from '$lib/components/sessions/cli-terminal-tabs.svelte';
	import TeamLiveBoard from '$lib/components/teams/team-live-board.svelte';
	import TeamKnowledgeDrawer from '$lib/components/teams/team-knowledge-drawer.svelte';
	import RunMetricsBar, {
		type RunMetricsLive,
		type RunMetricsOutcome
	} from '$lib/components/workflow/execution/run-metrics-bar.svelte';
	import ProvisioningStepper from '$lib/components/workflow/execution/provisioning-stepper.svelte';
	import ScriptPhaseRail from '$lib/components/workflow/execution/script-phase-rail.svelte';
	import { Collapsible, CollapsibleTrigger, CollapsibleContent } from '$lib/components/ui/collapsible';
	import { fmtTokens } from '$lib/utils/format-tokens';
	import {
		ChevronDown,
		ExternalLink,
		Pin,
		Radio,
		Inbox,
		Loader2,
		Terminal,
		ScrollText,
		PanelLeftClose,
		PanelLeftOpen
	} from '@lucide/svelte';

	interface Props {
		executionId: string;
		slug: string;
		workflowId: string;
		/** Workflow graph (for the live node-progress stepper). */
		nodes?: Node[];
		edges?: Edge[];
		/** Preserved run-level cards (live preview, workspace, input/output,
		 *  artifacts) rendered by the parent page inside the Run details drawer. */
		details?: Snippet;
		/** Deep-link: focus this node (its step or owning session) on mount/change. */
		focusNode?: string | null;
		/** Dynamic-script runs: the executionIr — renders the phase graph in the
		 *  left rail so the graph is visible alongside the live session view. */
		scriptIr?: Record<string, unknown> | null;
		/** Team-led runs: probe id for the metrics bar's Team chip. */
		teamId?: string | null;
	}

	let {
		executionId,
		slug,
		workflowId,
		nodes = [],
		edges = [],
		details,
		focusNode = null,
		scriptIr = null,
		teamId = null
	}: Props = $props();

	type SessionRow = {
		id: string;
		title: string | null;
		status: string | null;
		agentId: string | null;
		createdAt: string | null;
		completedAt: string | null;
		// Resume/fork: session belongs to a source run this run was forked from
		// (the skipped-prefix activity). Shown but labeled as inherited.
		inherited?: boolean;
		sourceExecutionId?: string | null;
	};

	let sessions = $state<SessionRow[]>([]);
	let detailsOpen = $state(false);

	// ── Execution stream (run-level live signals) ──────────────────────────
	let runStatus = $state<string | null>(null);
	let currentNodeName = $state<string | null>(null);
	let tokensPerSec = $state<number | null>(null);
	let toolCallTotal = $state<number | null>(null);
	let isStreaming = $state(false);
	let activeToolName = $state<string | null>(null);
	let snapshot = $state<ExecutionReadModel | null>(null);
	let summaryOutput = $state<Record<string, unknown> | null>(null);
	let output = $state<unknown>(null);

	$effect(() => {
		const exec: ExecutionStreamStore = createExecutionStream(executionId);
		const unsub = exec.subscribe((s) => {
			runStatus = s.snapshot?.status ?? runStatus;
			currentNodeName = s.snapshot?.currentNodeName ?? s.currentPhase ?? currentNodeName;
			toolCallTotal = s.toolCallTotal || toolCallTotal;
			isStreaming = s.isLlmStreaming;
			activeToolName = s.activeToolName;
			if (s.snapshot) snapshot = s.snapshot;
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

	// ── Node-step spine ────────────────────────────────────────────────────
	// The run's top-level node executions (from the snapshot's workflow_execution_logs).
	// This is the rail's spine so EVERY run reads as "what it did" — including
	// non-agent runs and non-agent-suffix FORKS (e.g. publish_contract → pr → summary),
	// which spawn no agent sessions and otherwise left the console blank. Agent
	// sessions nest under their owning step.
	const steps = $derived<ExecutionStepLog[]>(snapshot?.steps ?? []);

	function stepStatusDot(status: string): { sym: string; cls: string; label: string } {
		switch (status) {
			case 'running':
				return { sym: '▶', cls: 'text-teal-500', label: 'running' };
			case 'success':
				return { sym: '✓', cls: 'text-emerald-500', label: 'done' };
			case 'error':
				return { sym: '✕', cls: 'text-red-500', label: 'error' };
			case 'pending':
				return { sym: '○', cls: 'text-muted-foreground', label: 'pending' };
			default:
				return { sym: '○', cls: 'text-muted-foreground', label: status };
		}
	}

	// Map each session to its owning top-level step (longest stepName that prefixes the
	// session's node label). Sessions with no matching step fall into "other".
	function ownerStepOf(s: SessionRow): string | null {
		const node = nodeOf(s);
		const base = groupBaseOf(node);
		let best: string | null = null;
		for (const st of steps) {
			const name = st.stepName;
			if (node === name || base === name || node.startsWith(name + '/') || node.startsWith(name + '-')) {
				if (!best || name.length > best.length) best = name;
			}
		}
		return best;
	}
	const sessionsByStep = $derived.by(() => {
		const m = new Map<string, SessionRow[]>();
		const other: SessionRow[] = [];
		for (const s of orderedSessions) {
			const owner = ownerStepOf(s);
			if (owner) {
				const arr = m.get(owner) ?? [];
				arr.push(s);
				m.set(owner, arr);
			} else {
				other.push(s);
			}
		}
		return { byStep: m, other };
	});
	// Show the node spine when we have step data; otherwise fall back to the flat
	// sessions list (older runs / before the first snapshot arrives).
	const hasSpine = $derived(steps.length > 0);

	// A non-agent step the user clicked to inspect (output/error in the main pane).
	let selectedStep = $state<string | null>(null);
	const selectedStepLog = $derived.by(() =>
		selectedStep ? (steps.find((s) => s.stepName === selectedStep) ?? null) : null
	);
	function selectStep(name: string) {
		selectedStep = name;
		pinnedId = null;
	}
	function focusSession(id: string) {
		pinnedId = id;
		selectedStep = null;
	}

	// Deep-link focus (`?node=` on the run page): once data loads, focus the node's
	// owning session (transcript) if it has one, else its step. Applied once per change.
	let lastFocusNode = $state<string | null>(null);
	$effect(() => {
		const fn = focusNode;
		if (!fn || fn === lastFocusNode) return;
		if (steps.length === 0 && orderedSessions.length === 0) return; // wait for data
		lastFocusNode = fn;
		const sess = orderedSessions.find((s) => {
			const n = nodeOf(s);
			return n === fn || n.startsWith(fn + '-') || n.startsWith(fn + '/');
		});
		if (sess) focusSession(sess.id);
		else if (steps.some((s) => s.stepName === fn)) selectStep(fn);
	});

	// ── Dynamic-script phase graph (left-rail drawer) ──────────────────────
	let graphOpen = $state(true);
	const scriptPhases = $derived.by(() => {
		const m = (scriptIr?.meta ?? {}) as Record<string, unknown>;
		const raw = m.phases;
		if (!Array.isArray(raw)) return [] as string[];
		const out: string[] = [];
		for (const p of raw) {
			if (typeof p === 'string') out.push(p);
			else if (p && typeof p === 'object' && typeof (p as Record<string, unknown>).title === 'string')
				out.push((p as Record<string, unknown>).title as string);
		}
		return out;
	});

	// ── Focus / auto-follow ────────────────────────────────────────────────
	let pinnedId = $state<string | null>(null);
	const newestActiveId = $derived.by(() => {
		const active = orderedSessions.filter(isActive);
		return active.length > 0 ? active[active.length - 1].id : null;
	});
	const focusedId = $derived(
		pinnedId ?? newestActiveId ?? (orderedSessions.length > 0 ? orderedSessions[orderedSessions.length - 1].id : null)
	);
	const following = $derived(pinnedId === null && selectedStep === null);

	// ── Focused-session view mode: Transcript vs live CLI Terminal ──────────
	// The cockpit's focus pane carries the interactive-CLI TUI the old session
	// page rendered. We fetch the focused session's runtime flags; when it is an
	// interactive-CLI session we offer a Transcript/Terminal segmented toggle and
	// embed the same CliTerminalTabs (xterm over the cli-terminal WebSocket).
	let focusViewMode = $state<'transcript' | 'terminal'>('transcript');
	let focusFlags = $state<{ interactiveTerminal: boolean; cliLabel: string | null }>({
		interactiveTerminal: false,
		cliLabel: null
	});
	$effect(() => {
		const id = focusedId;
		if (!id) {
			focusFlags = { interactiveTerminal: false, cliLabel: null };
			focusViewMode = 'transcript';
			return;
		}
		let cancelled = false;
		(async () => {
			try {
				const res = await fetch(`/api/v1/sessions/${id}/runtime-flags`);
				if (cancelled) return;
				if (!res.ok) {
					focusFlags = { interactiveTerminal: false, cliLabel: null };
					focusViewMode = 'transcript';
					return;
				}
				const body = (await res.json()) as { interactiveTerminal?: boolean; cliLabel?: string | null };
				if (cancelled) return;
				const interactive = body.interactiveTerminal === true;
				focusFlags = { interactiveTerminal: interactive, cliLabel: body.cliLabel ?? null };
				// Match the old session page: interactive-CLI sessions open on the
				// live TUI; everything else shows the transcript.
				focusViewMode = interactive ? 'terminal' : 'transcript';
			} catch {
				if (!cancelled) {
					focusFlags = { interactiveTerminal: false, cliLabel: null };
					focusViewMode = 'transcript';
				}
			}
		})();
		return () => {
			cancelled = true;
		};
	});

	// ── Collapsible sessions rail (lets the focus pane widen full-bleed) ────
	let railCollapsed = $state(false);
	const RAIL_COLLAPSE_KEY = 'wfb:run-console:rail-collapsed';
	$effect(() => {
		if (typeof localStorage === 'undefined') return;
		railCollapsed = localStorage.getItem(RAIL_COLLAPSE_KEY) === '1';
	});
	function toggleRail() {
		railCollapsed = !railCollapsed;
		if (typeof localStorage !== 'undefined')
			localStorage.setItem(RAIL_COLLAPSE_KEY, railCollapsed ? '1' : '0');
	}

	// ── Knowledge drawer (team runs): the right-hand counterpart of the rail —
	// keep the OKF bundle in view WHILE watching live activity. Collapsed to a
	// slim strip by default; preference persisted like the rail's.
	let knowledgeOpen = $state(false);
	const KNOWLEDGE_OPEN_KEY = 'wfb:run-console:knowledge-open';
	$effect(() => {
		if (typeof localStorage === 'undefined') return;
		knowledgeOpen = localStorage.getItem(KNOWLEDGE_OPEN_KEY) === '1';
	});
	function toggleKnowledge(open: boolean) {
		knowledgeOpen = open;
		if (typeof localStorage !== 'undefined')
			localStorage.setItem(KNOWLEDGE_OPEN_KEY, open ? '1' : '0');
	}

	// ── Per-active-session preview streams (capped) ─────────────────────────
	const MAX_PREVIEW_STREAMS = 4;
	type PreviewData = { lastLine: string; inTok: number; outTok: number; activity: string | null };
	let previews = $state<Record<string, PreviewData>>({});
	const previewStreams = new Map<string, { store: SessionStreamStore; unsub: () => void }>();

	function summarize(
		events: SessionEventEnvelope[],
		inFlight: Record<string, { kind: string }>
	): PreviewData {
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
		// What is this session doing RIGHT NOW (drives the live activity chip)?
		let activity: string | null = null;
		const partial = Object.values(inFlight)[0];
		if (partial) {
			activity =
				partial.kind === 'thinking'
					? 'thinking…'
					: partial.kind === 'tool_input'
						? 'preparing tool…'
						: 'writing…';
		} else {
			// Recent unmatched tool_use (no result yet) → that tool is in flight.
			for (let i = events.length - 1; i >= 0; i--) {
				const e = events[i];
				if (
					e.type === 'agent.tool_result' ||
					e.type === 'agent.mcp_tool_result' ||
					e.type === 'agent.custom_tool_result' ||
					e.type === 'agent.message'
				)
					break;
				if (
					e.type === 'agent.tool_use' ||
					e.type === 'agent.mcp_tool_use' ||
					e.type === 'agent.custom_tool_use'
				) {
					const d = e.data as Record<string, unknown>;
					activity = `⚙ ${(d.name as string) ?? (d.tool_name as string) ?? 'tool'}`;
					break;
				}
			}
		}
		return { lastLine: lastLine.slice(0, 220), inTok, outTok, activity };
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
				previews = { ...previews, [id]: summarize(st.events, st.inFlightPartials) };
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

	// ── Sandbox provisioning status (fills the pre-session "rescheduling" gap) ──
	type ProvMark = { phase: string; at: string; durationMs: number | null };
	type Provisioning = {
		phase: string;
		label: string;
		detail: string | null;
		timeline?: ProvMark[];
		source?: string;
	};
	let provisioning = $state<Record<string, Provisioning>>({});
	$effect(() => {
		const pending = orderedSessions.filter((s) => s.status === 'rescheduling').map((s) => s.id);
		if (pending.length === 0) return;
		let cancelled = false;
		async function poll() {
			for (const id of pending) {
				try {
					const res = await fetch(`/api/v1/sessions/${id}/provisioning`);
					if (res.ok && !cancelled) {
						provisioning = { ...provisioning, [id]: (await res.json()) as Provisioning };
					}
				} catch {
					// best-effort
				}
			}
		}
		void poll();
		const t = setInterval(poll, 4000);
		return () => {
			cancelled = true;
			clearInterval(t);
		};
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
	<RunMetricsBar {executionId} {sessions} {runActive} {live} {outcome} {teamId} />

	<!-- Team runs: the live "newsroom" board — what every member is doing right
	     now (classified, member-colored, pulsing while fresh) + a merged event
	     ticker. Clicking a member focuses its transcript below. -->
	{#if teamId}
		<TeamLiveBoard
			{teamId}
			isRunning={runActive}
			selectedSessionId={focusedId}
			onSelectMember={(id) => focusSession(id)}
		/>
	{/if}

	<!-- Flow-progress band is now rendered once at the run-page level (persistent
	     header on every tab) so switching tabs doesn't shift layout. -->

	{#snippet sessionRow(s: SessionRow, indented: boolean)}
		{@const node = nodeOf(s)}
		{@const dot = statusDot(s.status)}
		{@const pv = previews[s.id]}
		<button
			in:fly={{ y: -6, duration: 200 }}
			class="mb-1 w-full rounded-md border px-2.5 py-2 text-left transition-colors {indented
				? 'ml-3'
				: ''} {focusedId === s.id && selectedStep === null
				? 'border-primary/50 bg-primary/5'
				: 'border-transparent hover:border-border hover:bg-muted/50'}"
			onclick={() => focusSession(s.id)}
		>
			<div class="flex items-center gap-2">
				<span class="{dot.cls} text-xs" title={dot.label}>{dot.sym}</span>
				<span class="min-w-0 flex-1 truncate text-xs font-medium">{node}</span>
				{#if s.inherited}
					<span
						class="inline-flex shrink-0 items-center rounded-full bg-muted px-1.5 py-0.5 text-[9px] font-medium text-muted-foreground"
						title="Replayed from the source run this run was resumed/forked from"
					>
						inherited
					</span>
				{/if}
				{#if isActive(s) && pv?.activity}
					<span
						class="inline-flex shrink-0 items-center gap-1 rounded-full bg-teal-500/10 px-1.5 py-0.5 text-[9px] font-medium text-teal-600 dark:text-teal-300"
					>
						<span class="size-1 animate-pulse rounded-full bg-teal-400"></span>{pv.activity}
					</span>
				{:else if isActive(s)}
					<span class="inline-block size-1.5 animate-pulse rounded-full bg-teal-400/80"></span>
				{/if}
			</div>
			{#if s.status === 'rescheduling'}
				{@const prov = provisioning[s.id]}
				<div class="mt-1 flex items-center gap-1.5 text-[11px] text-amber-600 dark:text-amber-400">
					<Loader2 class="size-3 shrink-0 animate-spin" />
					<span class="truncate">{prov?.label ?? 'Provisioning sandbox…'}</span>
					{#if prov?.detail}<span class="truncate text-muted-foreground/70">· {prov.detail}</span>{/if}
				</div>
				{#if prov?.timeline && prov.timeline.length > 0}
					<div class="mt-1">
						<ProvisioningStepper timeline={prov.timeline} phase={prov.phase} compact />
					</div>
				{/if}
			{/if}
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
	{/snippet}

	{#snippet stepRow(st: ExecutionStepLog)}
		{@const sdot = stepStatusDot(st.status)}
		{@const kids = sessionsByStep.byStep.get(st.stepName) ?? []}
		<button
			class="mb-0.5 w-full rounded-md border px-2.5 py-1.5 text-left transition-colors {selectedStep ===
			st.stepName
				? 'border-primary/50 bg-primary/5'
				: 'border-transparent hover:border-border hover:bg-muted/50'}"
			onclick={() => selectStep(st.stepName)}
		>
			<div class="flex items-center gap-2">
				<span class="{sdot.cls} text-xs" title={sdot.label}>{sdot.sym}</span>
				<span class="min-w-0 flex-1 truncate text-xs font-semibold">{st.displayLabel ?? st.label ?? st.stepName}</span>
				<span class="shrink-0 rounded bg-muted px-1 py-0.5 text-[9px] font-medium text-muted-foreground/80">
					{st.actionType}
				</span>
				{#if st.durationMs != null}
					<span class="shrink-0 text-[10px] text-muted-foreground/70">{Math.round(st.durationMs / 1000)}s</span>
				{/if}
			</div>
			{#if st.error}
				<p class="mt-0.5 line-clamp-2 text-[11px] text-red-500/90">{st.error}</p>
			{/if}
		</button>
		{#each kids as s (s.id)}
			{@render sessionRow(s, true)}
		{/each}
	{/snippet}

	{#if !hasSpine && orderedSessions.length === 0}
		<div class="flex flex-1 flex-col items-center justify-center text-muted-foreground">
			<div class="rounded-full bg-muted p-3"><Inbox size={24} /></div>
			<p class="mt-3 text-sm font-medium">
				{runActive ? 'Waiting for the first step…' : 'No steps recorded for this run'}
			</p>
			<p class="mt-1 text-xs">
				Each workflow node — and the agent sessions it spawns — will appear here live.
			</p>
		</div>
	{:else}
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div
			class="grid min-h-0 flex-1 overflow-hidden"
			style:grid-template-columns="{railCollapsed ? '2.5rem' : railWidth + 'px'} 1fr{teamId
				? knowledgeOpen
					? ' 340px'
					: ' 2.5rem'
				: ''}"
			onmousemove={onResizeMove}
			onmouseup={onResizeEnd}
			onmouseleave={onResizeEnd}
		>
			{#if railCollapsed}
				<!-- Collapsed rail: a slim strip that keeps sessions reachable while the
				     focus pane widens full-bleed (no 1400px cap). -->
				<div class="flex min-h-0 flex-col items-center gap-2 border-r py-2">
					<button
						class="rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--cockpit-ion)]"
						onclick={toggleRail}
						title="Expand sessions rail"
						aria-label="Expand sessions rail"
						aria-expanded="false"
					>
						<PanelLeftOpen class="size-4" />
					</button>
					<div class="flex flex-1 flex-col items-center gap-1.5 overflow-y-auto">
						{#each orderedSessions as s (s.id)}
							{@const dot = statusDot(s.status)}
							<button
								class="rounded-full p-1 transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--cockpit-ion)] {focusedId ===
									s.id && selectedStep === null
									? 'ring-2 ring-[var(--cockpit-phosphor)]'
									: ''}"
								onclick={() => focusSession(s.id)}
								title={nodeOf(s)}
								aria-label={nodeOf(s)}
							>
								{#if isActive(s)}
									<span class="cockpit-live-dot block size-2 rounded-full"></span>
								{:else}
									<span class="{dot.cls} block text-xs leading-none">{dot.sym}</span>
								{/if}
							</button>
						{/each}
					</div>
				</div>
			{:else}
			<!-- LEFT RAIL -->
			<div class="flex min-h-0 flex-col border-r">
				<div class="flex items-center justify-between gap-2 border-b px-3 py-1.5">
					<span class="hud-nums text-xs font-medium text-muted-foreground">
						{#if hasSpine}{steps.length} step{steps.length === 1 ? '' : 's'}{#if orderedSessions.length > 0} · {orderedSessions.length} session{orderedSessions.length === 1 ? '' : 's'}{/if}{:else}{orderedSessions.length} session{orderedSessions.length === 1 ? '' : 's'}{/if}
					</span>
					<div class="flex items-center gap-1">
						<button
							class="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--cockpit-ion)] {following
								? 'bg-[var(--cockpit-phosphor)]/15 text-[var(--cockpit-phosphor)]'
								: 'text-muted-foreground hover:bg-muted'}"
							onclick={() => { pinnedId = null; selectedStep = null; }}
							title={following ? 'Following the newest active session' : 'Resume following latest'}
						>
							{#if following}<Radio class="size-3" /> Following latest{:else}<Pin class="size-3" /> Pinned{/if}
						</button>
						<button
							class="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--cockpit-ion)]"
							onclick={toggleRail}
							title="Collapse sessions rail"
							aria-label="Collapse sessions rail"
							aria-expanded="true"
						>
							<PanelLeftClose class="size-3.5" />
						</button>
					</div>
				</div>

				<div class="min-h-0 flex-1 overflow-y-auto p-1.5">
					{#if scriptIr}
						<Collapsible bind:open={graphOpen} class="mb-1.5">
							<CollapsibleTrigger
								class="flex w-full items-center justify-between rounded px-1.5 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70 hover:bg-muted/50"
							>
								Script graph
								<ChevronDown class="size-3 transition-transform {graphOpen ? 'rotate-180' : ''}" />
							</CollapsibleTrigger>
							<CollapsibleContent>
								<div class="px-0.5 pb-1">
									<ScriptPhaseRail
										{executionId}
										declaredPhases={scriptPhases}
										currentPhase={snapshot?.phase ?? null}
										isRunning={runActive}
										focusedSessionId={focusedId}
										onSelect={(call) => {
											if (call.sessionId) {
												pinnedId = call.sessionId;
												selectedStep = null;
											}
										}}
									/>
								</div>
							</CollapsibleContent>
						</Collapsible>
					{/if}
					{#if hasSpine}
						{#each steps as st (st.stepName)}
							{@render stepRow(st)}
						{/each}
						{#if sessionsByStep.other.length > 0}
							<div class="px-1.5 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">
								other sessions
							</div>
							{#each sessionsByStep.other as s (s.id)}
								{@render sessionRow(s, false)}
							{/each}
						{/if}
					{:else}
						{#each orderedSessions as s, i (s.id)}
							{@const base = groupBaseOf(nodeOf(s))}
							{@const prevBase = i > 0 ? groupBaseOf(nodeOf(orderedSessions[i - 1])) : null}
							{#if base !== prevBase}
								<div class="px-1.5 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">
									{base}
								</div>
							{/if}
							{@render sessionRow(s, false)}
						{/each}
					{/if}
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
			{/if}

			<!-- Resize handle + MAIN PANE -->
			<div class="relative flex min-h-0 flex-col overflow-hidden">
				{#if !railCollapsed}
					<!-- svelte-ignore a11y_no_static_element_interactions -->
					<div
						class="absolute left-0 top-0 bottom-0 z-10 -ml-0.5 w-1 cursor-col-resize transition-colors hover:bg-primary/40"
						class:bg-primary={resizing}
						onmousedown={onResizeStart}
					></div>
				{/if}
				<div class="flex items-center justify-between gap-2 border-b px-3 py-1.5">
					<div class="flex min-w-0 items-center gap-2">
						<span class="truncate text-xs font-medium">
							{#if selectedStepLog}{selectedStepLog.displayLabel ?? selectedStepLog.label ?? selectedStepLog.stepName}{:else}{focusedId ? nodeOf(orderedSessions.find((s) => s.id === focusedId) ?? ({} as SessionRow)) : '—'}{/if}
						</span>
						{#if selectedStepLog}
							<span class="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
								{selectedStepLog.actionType}
							</span>
						{:else if !following}
							<span class="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] text-amber-600 dark:text-amber-400">
								Pinned
							</span>
						{/if}
					</div>
					{#if !selectedStepLog && focusedId}
						<div class="flex items-center gap-2">
							{#if focusFlags.interactiveTerminal}
								<!-- Signature: hardware-style Transcript/Terminal segmented switch. The
								     phosphor that blinks the embedded xterm cursor also lights the active
								     Terminal segment, wiring the HUD to the running agent. -->
								<div
									role="radiogroup"
									aria-label="Focused-session view"
									class="hud-nums inline-flex items-center gap-0.5 rounded-md border border-border bg-muted/40 p-0.5 text-[11px]"
								>
									<button
										type="button"
										role="radio"
										aria-checked={focusViewMode === 'transcript'}
										onclick={() => (focusViewMode = 'transcript')}
										class="inline-flex items-center gap-1 rounded px-2 py-1 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--cockpit-ion)] {focusViewMode ===
										'transcript'
											? 'bg-background font-medium text-foreground shadow-sm'
											: 'text-muted-foreground hover:text-foreground'}"
									>
										<ScrollText class="size-3.5" /> Transcript
									</button>
									<button
										type="button"
										role="radio"
										aria-checked={focusViewMode === 'terminal'}
										onclick={() => (focusViewMode = 'terminal')}
										class="inline-flex items-center gap-1 rounded px-2 py-1 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--cockpit-ion)] {focusViewMode ===
										'terminal'
											? 'bg-background font-medium text-[var(--cockpit-phosphor)] shadow-sm'
											: 'text-muted-foreground hover:text-foreground'}"
									>
										<Terminal class="size-3.5" /> Terminal
										{#if focusViewMode === 'terminal'}
											<span class="cockpit-live-dot block size-1.5 rounded-full"></span>
										{/if}
									</button>
								</div>
							{/if}
							<a
								href="/workspaces/{slug}/sessions/{focusedId}"
								class="inline-flex items-center gap-1 rounded text-[11px] text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--cockpit-ion)]"
								title="Open the full session page (terminal / browser / shell / goal)"
							>
								<ExternalLink class="size-3" /> Full page
							</a>
						</div>
					{/if}
				</div>
				<div class="min-h-0 flex-1 overflow-hidden">
					{#if selectedStepLog}
						{@const sdot = stepStatusDot(selectedStepLog.status)}
						<div class="h-full overflow-y-auto p-4 text-sm">
							<div class="mb-3 flex items-center gap-2">
								<span class="{sdot.cls}" title={sdot.label}>{sdot.sym}</span>
								<span class="font-medium">{sdot.label}</span>
								{#if selectedStepLog.durationMs != null}
									<span class="text-xs text-muted-foreground">· {Math.round(selectedStepLog.durationMs / 1000)}s</span>
								{/if}
							</div>
							<p class="mb-3 text-xs text-muted-foreground">
								This step ran in the workflow orchestrator (no agent session). Its outputs and any
								diffs/artifacts are on the <span class="font-medium">Outputs</span> and
								<span class="font-medium">Changes</span> tabs.
							</p>
							{#if selectedStepLog.error}
								<div class="mb-3 rounded-md border border-red-500/30 bg-red-500/5 p-3">
									<div class="mb-1 text-xs font-semibold text-red-500">Error</div>
									<pre class="whitespace-pre-wrap break-words text-[11px] text-red-500/90">{selectedStepLog.error}</pre>
								</div>
							{/if}
							{#if selectedStepLog.output != null}
								<div class="rounded-md border bg-muted/30 p-3">
									<div class="mb-1 text-xs font-semibold text-muted-foreground">Output</div>
									<pre class="max-h-[50vh] overflow-auto whitespace-pre-wrap break-words text-[11px]">{typeof selectedStepLog.output === 'string' ? selectedStepLog.output : JSON.stringify(selectedStepLog.output, null, 2)}</pre>
								</div>
							{/if}
						</div>
					{:else if focusedId}
						{#if focusFlags.interactiveTerminal && focusViewMode === 'terminal'}
							{#key focusedId}
								<div class="h-full min-h-0 p-2">
									<CliTerminalTabs sessionId={focusedId} cliLabel={focusFlags.cliLabel ?? undefined} />
								</div>
							{/key}
						{:else}
							{#key focusedId}
								<SessionTranscript sessionId={focusedId} />
							{/key}
						{/if}
					{:else}
						<div class="flex h-full items-center justify-center text-sm text-muted-foreground">
							Select a step or session on the left.
						</div>
					{/if}
				</div>
			</div>

			<!-- Right rail (team runs): the knowledge bundle beside the activity —
			     slim pulsing strip when closed, index + inline OKF docs when open. -->
			{#if teamId}
				<TeamKnowledgeDrawer
					{teamId}
					isRunning={runActive}
					open={knowledgeOpen}
					onToggle={toggleKnowledge}
				/>
			{/if}
		</div>
	{/if}

	{#if resizing}
		<div class="fixed inset-0 z-50 cursor-col-resize"></div>
	{/if}
</div>
