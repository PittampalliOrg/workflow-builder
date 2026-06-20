<script lang="ts">
	/**
	 * Aggregate run-level metrics for the unified Run Console — a compact tile
	 * strip summing every session of one workflow run. Authoritative token/cost
	 * totals come from the per-execution `/metrics` endpoint (server-aggregated
	 * `sessions.usage`, correct regardless of when the UI connected); duration +
	 * status counts are derived from the sessions list; tokens/sec + the "live"
	 * pulse come from the execution SSE stream (passed in via `live`); the
	 * Outcome chips read the run's summary output when present.
	 */
	import { fmtTokens } from '$lib/utils/format-tokens';
	import {
		Coins,
		Clock,
		Layers,
		Gauge,
		Wrench,
		CircleCheck,
		CircleAlert,
		CircleDot,
		Database
	} from '@lucide/svelte';

	export type RunMetricsSession = {
		id: string;
		status: string | null;
		createdAt: string | null;
		completedAt: string | null;
	};

	export type RunMetricsLive = {
		tokensPerSec?: number | null;
		toolCallTotal?: number | null;
		currentPhase?: string | null;
		isStreaming?: boolean;
	} | null;

	export type RunMetricsOutcome = {
		terminalState?: string | null;
		criteriaPassed?: number | null;
		criteriaTotal?: number | null;
		negotiationRounds?: number | null;
		iterations?: number | null;
	} | null;

	interface MetricsResponse {
		totals: {
			inputTokens: number;
			outputTokens: number;
			cacheReadTokens: number;
			cacheCreateTokens: number;
			totalTokens: number;
		};
		cacheHitPct: number | null;
		totalCost: number;
		totalCostLabel: string;
		byModel: Array<{
			model: string;
			inputTokens: number;
			outputTokens: number;
			cost: number;
		}>;
	}

	interface Props {
		executionId: string;
		sessions: RunMetricsSession[];
		/** Keep polling while the run is still active. */
		runActive?: boolean;
		live?: RunMetricsLive;
		outcome?: RunMetricsOutcome;
	}

	let { executionId, sessions, runActive = false, live = null, outcome = null }: Props = $props();

	let metrics = $state<MetricsResponse | null>(null);

	async function loadMetrics() {
		try {
			const res = await fetch(`/api/workflows/executions/${executionId}/metrics`);
			if (res.ok) metrics = (await res.json()) as MetricsResponse;
		} catch {
			// best-effort; tiles fall back to placeholders
		}
	}

	// Initial load + poll while the run is active. Re-runs when executionId or
	// runActive changes; tears the interval down on cleanup.
	$effect(() => {
		void executionId;
		void loadMetrics();
		if (!runActive) return;
		const t = setInterval(loadMetrics, 5000);
		return () => clearInterval(t);
	});

	// Live clock so wall-clock duration ticks while the run is active.
	let now = $state(Date.now());
	$effect(() => {
		if (!runActive) return;
		const t = setInterval(() => (now = Date.now()), 1000);
		return () => clearInterval(t);
	});

	function ts(s: string | null): number | null {
		if (!s) return null;
		const n = new Date(s).getTime();
		return Number.isFinite(n) ? n : null;
	}

	// Wall-clock: first session start → last completion (or now while running).
	const wallMs = $derived.by(() => {
		const starts = sessions.map((s) => ts(s.createdAt)).filter((n): n is number => n !== null);
		if (starts.length === 0) return null;
		const start = Math.min(...starts);
		const anyActive = sessions.some(
			(s) => s.status === 'running' || s.status === 'idle' || s.status === 'rescheduling'
		);
		if (anyActive) return now - start;
		const ends = sessions.map((s) => ts(s.completedAt)).filter((n): n is number => n !== null);
		const end = ends.length > 0 ? Math.max(...ends) : now;
		return Math.max(0, end - start);
	});

	// Sum of per-session active time (differs from wall-clock when sessions run
	// sequentially with idle gaps between them).
	const activeMs = $derived.by(() => {
		let sum = 0;
		for (const s of sessions) {
			const start = ts(s.createdAt);
			if (start === null) continue;
			const end = ts(s.completedAt) ?? (s.status === 'terminated' ? start : now);
			sum += Math.max(0, end - start);
		}
		return sum;
	});

	const counts = $derived.by(() => {
		const c = { total: sessions.length, running: 0, idle: 0, done: 0, error: 0 };
		for (const s of sessions) {
			if (s.status === 'running' || s.status === 'rescheduling') c.running++;
			else if (s.status === 'idle') c.idle++;
			else if (s.status === 'error') c.error++;
			else if (s.status === 'terminated' || s.status === 'completed') c.done++;
		}
		return c;
	});

	function fmtDuration(ms: number | null): string {
		if (ms === null) return '—';
		const s = Math.floor(ms / 1000);
		if (s < 60) return `${s}s`;
		const m = Math.floor(s / 60);
		const rs = s % 60;
		if (m < 60) return `${m}m ${rs}s`;
		const h = Math.floor(m / 60);
		const rm = m % 60;
		return `${h}h ${rm}m`;
	}

	function modelCost(n: number): string {
		if (n <= 0) return '$0.00';
		if (n < 0.01) return '<$0.01';
		return `$${n.toFixed(2)}`;
	}

	const totalTokens = $derived(metrics?.totals.totalTokens ?? 0);
	const cacheHit = $derived(metrics?.cacheHitPct ?? null);
</script>

<div class="flex flex-wrap items-stretch gap-2 border-b bg-muted/20 px-3 py-2">
	<!-- Tokens -->
	<div
		class="flex min-w-[7rem] flex-col rounded-md border bg-background px-2.5 py-1.5"
		title={metrics
			? `Input ${metrics.totals.inputTokens.toLocaleString()} · Output ${metrics.totals.outputTokens.toLocaleString()} · Cache read ${metrics.totals.cacheReadTokens.toLocaleString()} · Cache write ${metrics.totals.cacheCreateTokens.toLocaleString()}`
			: 'Aggregating…'}
	>
		<span class="flex items-center gap-1 text-[10px] uppercase tracking-wide text-muted-foreground">
			<Layers class="size-3" /> Tokens
		</span>
		<span class="text-sm font-semibold tabular-nums">{fmtTokens(totalTokens)}</span>
		<span class="text-[10px] text-muted-foreground">
			{fmtTokens(metrics?.totals.inputTokens ?? 0)} in · {fmtTokens(
				metrics?.totals.outputTokens ?? 0
			)} out
		</span>
	</div>

	<!-- Cache hit -->
	<div class="flex min-w-[5.5rem] flex-col rounded-md border bg-background px-2.5 py-1.5">
		<span class="flex items-center gap-1 text-[10px] uppercase tracking-wide text-muted-foreground">
			<Database class="size-3" /> Cache
		</span>
		<span class="text-sm font-semibold tabular-nums">{cacheHit === null ? '—' : `${cacheHit}%`}</span>
		<span class="text-[10px] text-muted-foreground">{fmtTokens(metrics?.totals.cacheReadTokens ?? 0)} read</span>
	</div>

	<!-- Cost -->
	<div
		class="flex min-w-[6rem] flex-col rounded-md border bg-background px-2.5 py-1.5"
		title={metrics && metrics.byModel.length > 0
			? metrics.byModel.map((m) => `${m.model}: ${modelCost(m.cost)}`).join('\n')
			: 'Cost by model'}
	>
		<span class="flex items-center gap-1 text-[10px] uppercase tracking-wide text-muted-foreground">
			<Coins class="size-3" /> Cost
		</span>
		<span class="text-sm font-semibold tabular-nums">{metrics?.totalCostLabel ?? '—'}</span>
		<span class="text-[10px] text-muted-foreground">
			{metrics && metrics.byModel.length > 1 ? `${metrics.byModel.length} models` : (metrics?.byModel[0]?.model ?? '')}
		</span>
	</div>

	<!-- Duration -->
	<div
		class="flex min-w-[6rem] flex-col rounded-md border bg-background px-2.5 py-1.5"
		title={`Wall-clock ${fmtDuration(wallMs)} · Agent active ${fmtDuration(activeMs)}`}
	>
		<span class="flex items-center gap-1 text-[10px] uppercase tracking-wide text-muted-foreground">
			<Clock class="size-3" /> Duration
		</span>
		<span class="text-sm font-semibold tabular-nums">{fmtDuration(wallMs)}</span>
		<span class="text-[10px] text-muted-foreground">{fmtDuration(activeMs)} active</span>
	</div>

	<!-- Sessions -->
	<div class="flex min-w-[7rem] flex-col rounded-md border bg-background px-2.5 py-1.5">
		<span class="flex items-center gap-1 text-[10px] uppercase tracking-wide text-muted-foreground">
			<CircleDot class="size-3" /> Sessions
		</span>
		<span class="text-sm font-semibold tabular-nums">{counts.total}</span>
		<span class="flex items-center gap-1.5 text-[10px] text-muted-foreground">
			{#if counts.running > 0}<span class="text-teal-500">▶ {counts.running}</span>{/if}
			{#if counts.done > 0}<span class="text-emerald-500">✓ {counts.done}</span>{/if}
			{#if counts.error > 0}<span class="text-red-500">✕ {counts.error}</span>{/if}
		</span>
	</div>

	<!-- Tokens/sec (live) -->
	{#if live?.tokensPerSec != null && live.tokensPerSec > 0}
		<div class="flex min-w-[5.5rem] flex-col rounded-md border bg-background px-2.5 py-1.5">
			<span class="flex items-center gap-1 text-[10px] uppercase tracking-wide text-muted-foreground">
				<Gauge class="size-3" /> Rate
			</span>
			<span class="text-sm font-semibold tabular-nums">{fmtTokens(Math.round(live.tokensPerSec))}/s</span>
			<span class="text-[10px] text-muted-foreground">{live.isStreaming ? 'streaming' : 'idle'}</span>
		</div>
	{/if}

	<!-- Tool calls (live) -->
	{#if live?.toolCallTotal != null && live.toolCallTotal > 0}
		<div class="flex min-w-[5rem] flex-col rounded-md border bg-background px-2.5 py-1.5">
			<span class="flex items-center gap-1 text-[10px] uppercase tracking-wide text-muted-foreground">
				<Wrench class="size-3" /> Tools
			</span>
			<span class="text-sm font-semibold tabular-nums">{live.toolCallTotal}</span>
			<span class="text-[10px] text-muted-foreground">calls</span>
		</div>
	{/if}

	<!-- Outcome chips (workflow summary output, when present) -->
	{#if outcome && (outcome.terminalState || outcome.criteriaTotal != null)}
		<div class="ml-auto flex items-center gap-2">
			{#if outcome.terminalState}
				{@const ok = outcome.terminalState === 'satisfied'}
				<span
					class="inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-medium {ok
						? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
						: 'border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400'}"
				>
					{#if ok}<CircleCheck class="size-3.5" />{:else}<CircleAlert class="size-3.5" />{/if}
					{outcome.terminalState}
				</span>
			{/if}
			{#if outcome.criteriaTotal != null}
				<span class="inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs">
					{outcome.criteriaPassed ?? 0}/{outcome.criteriaTotal} criteria
				</span>
			{/if}
			{#if outcome.negotiationRounds != null}
				<span class="inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs text-muted-foreground">
					{outcome.negotiationRounds} rounds · {outcome.iterations ?? 0} iters
				</span>
			{/if}
		</div>
	{/if}
</div>
