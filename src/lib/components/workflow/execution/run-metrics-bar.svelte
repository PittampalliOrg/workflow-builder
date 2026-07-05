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
	import * as Popover from '$lib/components/ui/popover';
	import {
		Coins,
		Clock,
		Layers,
		Gauge,
		Wrench,
		CircleCheck,
		CircleAlert,
		CircleDot,
		Database,
		MoreHorizontal
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

<!--
	Single-line HUD strip. It NEVER wraps to a second row: primary chips are
	always visible, secondary live chips + outcome pills collapse into an overflow
	menu on narrow viewports, and `flex-nowrap` + `overflow-x-auto` is the final
	guard so the row scrolls rather than breaking. Numerals are mono (JetBrains).
-->
{#snippet chip(Icon: typeof Layers, label: string, value: string, sub: string, title: string)}
	<div
		class="flex shrink-0 flex-col rounded-md border bg-background px-2.5 py-1 leading-tight"
		{title}
	>
		<span class="flex items-center gap-1 text-[10px] uppercase tracking-wide text-muted-foreground">
			<Icon class="size-3" />
			{label}
		</span>
		<span class="hud-nums text-sm font-semibold">{value}</span>
		{#if sub}<span class="truncate text-[10px] text-muted-foreground">{sub}</span>{/if}
	</div>
{/snippet}

{#snippet sessionsChip()}
	<div class="flex shrink-0 flex-col rounded-md border bg-background px-2.5 py-1 leading-tight">
		<span class="flex items-center gap-1 text-[10px] uppercase tracking-wide text-muted-foreground">
			<CircleDot class="size-3" /> Sessions
		</span>
		<span class="hud-nums text-sm font-semibold">{counts.total}</span>
		<span class="hud-nums flex items-center gap-1.5 text-[10px] text-muted-foreground">
			{#if counts.running > 0}<span style="color:var(--cockpit-phosphor)">▶ {counts.running}</span>{/if}
			{#if counts.done > 0}<span class="text-emerald-600 dark:text-emerald-400">✓ {counts.done}</span>{/if}
			{#if counts.error > 0}<span class="text-red-600 dark:text-red-400">✕ {counts.error}</span>{/if}
		</span>
	</div>
{/snippet}

{#snippet secondaryChips()}
	{@render chip(
		Database,
		'Cache',
		cacheHit === null ? '—' : `${cacheHit}%`,
		`${fmtTokens(metrics?.totals.cacheReadTokens ?? 0)} read`,
		'Cache-read hit rate'
	)}
	{#if live?.tokensPerSec != null && live.tokensPerSec > 0}
		{@render chip(
			Gauge,
			'Rate',
			`${fmtTokens(Math.round(live.tokensPerSec))}/s`,
			live.isStreaming ? 'streaming' : 'idle',
			'Tokens per second (last 30s)'
		)}
	{/if}
	{#if live?.toolCallTotal != null && live.toolCallTotal > 0}
		{@render chip(Wrench, 'Tools', String(live.toolCallTotal), 'calls', 'Tool calls this run')}
	{/if}
{/snippet}

{#snippet outcomeChips()}
	{#if outcome?.terminalState}
		{@const ok = outcome?.terminalState === 'satisfied'}
		<span
			class="inline-flex shrink-0 items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-medium {ok
				? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
				: 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300'}"
		>
			{#if ok}<CircleCheck class="size-3.5" />{:else}<CircleAlert class="size-3.5" />{/if}
			{outcome?.terminalState}
		</span>
	{/if}
	{#if outcome?.criteriaTotal != null}
		<span class="hud-nums inline-flex shrink-0 items-center gap-1 rounded-full border px-2.5 py-1 text-xs">
			{outcome?.criteriaPassed ?? 0}/{outcome?.criteriaTotal} criteria
		</span>
	{/if}
	{#if outcome?.negotiationRounds != null}
		<span class="hud-nums inline-flex shrink-0 items-center gap-1 rounded-full border px-2.5 py-1 text-xs text-muted-foreground">
			{outcome?.negotiationRounds} rounds · {outcome?.iterations ?? 0} iters
		</span>
	{/if}
{/snippet}

<div class="flex flex-nowrap items-center gap-1.5 overflow-x-auto border-b bg-muted/20 px-3 py-1.5">
	{@render chip(
		Layers,
		'Tokens',
		fmtTokens(totalTokens),
		`${fmtTokens(metrics?.totals.inputTokens ?? 0)} in · ${fmtTokens(metrics?.totals.outputTokens ?? 0)} out`,
		metrics
			? `Input ${metrics.totals.inputTokens.toLocaleString()} · Output ${metrics.totals.outputTokens.toLocaleString()} · Cache read ${metrics.totals.cacheReadTokens.toLocaleString()} · Cache write ${metrics.totals.cacheCreateTokens.toLocaleString()}`
			: 'Aggregating…'
	)}
	{@render chip(
		Coins,
		'Cost',
		metrics?.totalCostLabel ?? '—',
		metrics && metrics.byModel.length > 1 ? `${metrics.byModel.length} models` : (metrics?.byModel[0]?.model ?? ''),
		metrics && metrics.byModel.length > 0
			? metrics.byModel.map((m) => `${m.model}: ${modelCost(m.cost)}`).join('\n')
			: 'Cost by model'
	)}
	{@render chip(
		Clock,
		'Duration',
		fmtDuration(wallMs),
		`${fmtDuration(activeMs)} active`,
		`Wall-clock ${fmtDuration(wallMs)} · Agent active ${fmtDuration(activeMs)}`
	)}
	{@render sessionsChip()}

	<!-- Secondary live chips: inline on wide, overflow menu below xl -->
	<div class="hidden shrink-0 items-center gap-1.5 xl:flex">
		{@render secondaryChips()}
	</div>

	<!-- Outcome pills: inline on wide -->
	{#if outcome && (outcome.terminalState || outcome.criteriaTotal != null)}
		<div class="ml-auto hidden shrink-0 items-center gap-2 xl:flex">
			{@render outcomeChips()}
		</div>
	{/if}

	<!-- Overflow menu (below xl) — holds every chip that doesn't fit, so nothing
	     is ever hidden and the strip stays on one line. -->
	<div class="ml-auto shrink-0 xl:hidden">
		<Popover.Root>
			<Popover.Trigger
				class="inline-flex items-center gap-1 rounded-md border bg-background px-2 py-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--cockpit-ion)]"
				title="More metrics"
			>
				<MoreHorizontal class="size-3.5" /> More
			</Popover.Trigger>
			<Popover.Content align="end" class="w-60 p-2">
				<div class="flex flex-col gap-2">
					<div class="flex flex-wrap gap-1.5">
						{@render secondaryChips()}
					</div>
					{#if outcome && (outcome.terminalState || outcome.criteriaTotal != null)}
						<div class="flex flex-wrap items-center gap-2 border-t pt-2">
							{@render outcomeChips()}
						</div>
					{/if}
				</div>
			</Popover.Content>
		</Popover.Root>
	</div>
</div>
