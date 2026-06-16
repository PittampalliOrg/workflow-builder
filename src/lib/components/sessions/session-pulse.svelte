<script lang="ts">
	import * as Tooltip from '$lib/components/ui/tooltip';
	import {
		Coins,
		Zap,
		Gauge,
		Clock,
		Repeat2,
		Target,
		ArrowDownToLine,
		ArrowUpFromLine,
		CircleDollarSign,
		Cpu
	} from '@lucide/svelte';
	import type { SessionEventEnvelope } from '$lib/types/sessions';

	interface Props {
		sessionId: string;
		events: SessionEventEnvelope[];
		status?: string | null;
		createdAt?: string | null;
	}

	let { sessionId, events, status = null, createdAt = null }: Props = $props();

	type Goal = {
		objective: string;
		status: 'active' | 'paused' | 'budget_limited' | 'complete';
		tokensUsed: number;
		tokenBudget: number | null;
		iterations: number;
		maxIterations: number;
	};
	let goal = $state<Goal | null>(null);

	async function loadGoal() {
		try {
			const res = await fetch(`/api/v1/sessions/${sessionId}/goal`);
			if (!res.ok) return;
			goal = ((await res.json()) as { goal: Goal | null }).goal ?? null;
		} catch {
			/* keep last known */
		}
	}

	// Live ACTUAL compute (CPU/mem) of the session's sandbox pod vs its requests.
	type Compute = {
		podName: string | null;
		usage: { cpuMillicores: number; memoryMiB: number } | null;
		requests: { cpuMillicores: number; memoryMiB: number } | null;
	};
	let compute = $state<Compute | null>(null);
	async function loadCompute() {
		try {
			const res = await fetch(`/api/v1/sessions/${sessionId}/compute`);
			if (!res.ok) return;
			compute = (await res.json()) as Compute;
		} catch {
			/* keep last known */
		}
	}

	// Live clock for the elapsed tile + goal refresh. Ticks only while the
	// session is alive; terminal sessions freeze at the last event.
	let nowMs = $state(Date.now());
	const live = $derived(status === 'running' || status === 'idle' || status === 'rescheduling');
	$effect(() => {
		void sessionId;
		loadGoal();
		const goalTimer = setInterval(loadGoal, 5000);
		const clock = setInterval(() => (nowMs = Date.now()), 1000);
		// Compute (CPU/mem) only matters while the pod is alive; poll while live.
		let computeTimer: ReturnType<typeof setInterval> | null = null;
		if (live) {
			loadCompute();
			computeTimer = setInterval(loadCompute, 5000);
		}
		return () => {
			clearInterval(goalTimer);
			clearInterval(clock);
			if (computeTimer) clearInterval(computeTimer);
		};
	});

	// ── Token + cache rollups from agent.llm_usage (flat fields) ───────────
	const usage = $derived.by(() => {
		let input = 0;
		let output = 0;
		let cacheRead = 0;
		let cacheCreate = 0;
		let llmCalls = 0;
		for (const e of events) {
			if (e.type !== 'agent.llm_usage') continue;
			const d = e.data as Record<string, unknown>;
			input += Number(d.input_tokens ?? 0) || 0;
			output += Number(d.output_tokens ?? 0) || 0;
			cacheRead += Number(d.cache_read_input_tokens ?? 0) || 0;
			cacheCreate += Number(d.cache_creation_input_tokens ?? 0) || 0;
			llmCalls += 1;
		}
		const promptTotal = input + cacheRead;
		return {
			input,
			output,
			cacheRead,
			cacheCreate,
			llmCalls,
			total: input + output,
			cachePct: promptTotal > 0 ? Math.round((cacheRead / promptTotal) * 100) : null
		};
	});

	// ── Latest context-window snapshot ──────────────────────────────────────
	// Both agent.llm_usage (post-ingest stamp: provider-reported prompt +
	// cache tokens for the call that just ran) and agent.context_usage
	// (pre-call local heuristic) carry context_* fields. Latest-wins across
	// BOTH types: an llm_usage always lands right after its context_usage, so
	// the tile tracks provider truth and only falls back to the heuristic
	// estimate before the first call of a session.
	const context = $derived.by(() => {
		for (let i = events.length - 1; i >= 0; i--) {
			const e = events[i];
			if (e.type !== 'agent.llm_usage' && e.type !== 'agent.context_usage') continue;
			const d = e.data as Record<string, unknown>;
			const used = Number(d.context_used_percentage ?? NaN);
			if (!Number.isFinite(used)) continue;
			return {
				usedPct: Math.min(100, Math.max(0, used)),
				inputTokens: Number(d.context_input_tokens ?? 0) || 0,
				windowSize: Number(d.context_window_size ?? 0) || 0,
				compactAt: Number(d.context_auto_compact_threshold ?? 0) || 0,
				providerReported: d.context_count_method === 'provider_usage'
			};
		}
		return null;
	});

	// ── Live cost from provider rates ───────────────────────────────────────
	// Per-model usage sums × per-million rates fetched from /api/v1/pricing
	// (same table the workspace cost dashboard uses). Cache-read savings =
	// what those tokens would have cost at the full input rate.
	type Pricing = {
		inputPerMillion: number;
		outputPerMillion: number;
		cacheReadPerMillion?: number;
		cacheWritePerMillion?: number;
	};
	let pricingByModel = $state<Record<string, Pricing | null>>({});

	const usageByModel = $derived.by(() => {
		const acc: Record<
			string,
			{ input: number; output: number; cacheRead: number; cacheCreate: number }
		> = {};
		for (const e of events) {
			if (e.type !== 'agent.llm_usage') continue;
			const d = e.data as Record<string, unknown>;
			const model = String(d.model ?? d.providerModel ?? 'unknown');
			const m = (acc[model] ??= { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 });
			m.input += Number(d.input_tokens ?? 0) || 0;
			m.output += Number(d.output_tokens ?? 0) || 0;
			m.cacheRead += Number(d.cache_read_input_tokens ?? 0) || 0;
			m.cacheCreate += Number(d.cache_creation_input_tokens ?? 0) || 0;
		}
		return acc;
	});

	$effect(() => {
		for (const model of Object.keys(usageByModel)) {
			if (model === 'unknown' || model in pricingByModel) continue;
			pricingByModel[model] = null; // mark in-flight
			fetch(`/api/v1/pricing?model=${encodeURIComponent(model)}`)
				.then((r) => (r.ok ? r.json() : null))
				.then((d) => {
					if (d?.pricing) pricingByModel[model] = d.pricing as Pricing;
				})
				.catch(() => {});
		}
	});

	const cost = $derived.by(() => {
		let total = 0;
		let cacheSavings = 0;
		let priced = false;
		for (const [model, u] of Object.entries(usageByModel)) {
			const p = pricingByModel[model];
			if (!p) continue;
			priced = true;
			const cacheReadRate = p.cacheReadPerMillion ?? p.inputPerMillion * 0.1;
			const cacheWriteRate = p.cacheWritePerMillion ?? p.inputPerMillion * 1.25;
			total +=
				(u.input / 1e6) * p.inputPerMillion +
				(u.output / 1e6) * p.outputPerMillion +
				(u.cacheRead / 1e6) * cacheReadRate +
				(u.cacheCreate / 1e6) * cacheWriteRate;
			cacheSavings += (u.cacheRead / 1e6) * Math.max(0, p.inputPerMillion - cacheReadRate);
		}
		return priced ? { total, cacheSavings } : null;
	});

	function fmtCost(n: number): string {
		if (n === 0) return '$0.00';
		if (n < 0.01) return `$${n.toFixed(4)}`;
		if (n < 1) return `$${n.toFixed(3)}`;
		return `$${n.toFixed(2)}`;
	}

	const turns = $derived(events.filter((e) => e.type === 'session.turn_started').length);

	const elapsed = $derived.by(() => {
		if (!createdAt) return null;
		const start = new Date(createdAt).getTime();
		if (live) return nowMs - start;
		const last = events[events.length - 1];
		return last ? new Date(last.createdAt).getTime() - start : null;
	});

	function fmtTokens(n: number): string {
		if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
		if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
		return String(n);
	}
	function fmtElapsed(ms: number | null): string {
		if (ms === null || ms < 0) return '—';
		const s = Math.floor(ms / 1000);
		if (s < 60) return `${s}s`;
		const m = Math.floor(s / 60);
		if (m < 60) return `${m}m ${(s % 60).toString().padStart(2, '0')}s`;
		return `${Math.floor(m / 60)}h ${(m % 60).toString().padStart(2, '0')}m`;
	}
	function fmtCpu(millicores: number): string {
		return millicores >= 1000 ? `${(millicores / 1000).toFixed(1)}c` : `${millicores}m`;
	}
	function fmtMem(miB: number): string {
		return miB >= 1024 ? `${(miB / 1024).toFixed(1)}Gi` : `${miB}Mi`;
	}
	// Tone the compute readout when actual usage nears its requested reservation.
	const computeTone = $derived.by(() => {
		const u = compute?.usage;
		const r = compute?.requests;
		if (!u || !r) return 'text-foreground';
		const cpuPct = r.cpuMillicores ? (u.cpuMillicores / r.cpuMillicores) * 100 : 0;
		const memPct = r.memoryMiB ? (u.memoryMiB / r.memoryMiB) * 100 : 0;
		const p = Math.max(cpuPct, memPct);
		if (p >= 100) return 'text-red-600 dark:text-red-400';
		if (p >= 80) return 'text-amber-600 dark:text-amber-400';
		return 'text-foreground';
	});

	// Health color for the context bar: calm → warm → hot.
	const contextTone = $derived.by(() => {
		const p = context?.usedPct ?? 0;
		if (p >= 90) return { bar: 'bg-red-500', text: 'text-red-600 dark:text-red-400' };
		if (p >= 70) return { bar: 'bg-amber-500', text: 'text-amber-600 dark:text-amber-400' };
		return { bar: 'bg-emerald-500', text: 'text-emerald-600 dark:text-emerald-400' };
	});

	const goalTone = $derived.by(() => {
		switch (goal?.status) {
			case 'active':
				return 'text-blue-600 dark:text-blue-400';
			case 'complete':
				return 'text-emerald-600 dark:text-emerald-400';
			case 'budget_limited':
				return 'text-red-600 dark:text-red-400';
			case 'paused':
				return 'text-amber-600 dark:text-amber-400';
			default:
				return 'text-muted-foreground';
		}
	});

	const inPct = $derived(
		usage.total > 0 ? Math.round((usage.input / usage.total) * 100) : 50
	);

	// Cache ring geometry (SVG circle, r=9 → circumference ≈ 56.55).
	const RING_C = 2 * Math.PI * 9;
</script>

{#if events.length > 0}
	<div
		class="grid grid-cols-2 gap-px overflow-hidden border-b bg-border sm:grid-cols-4 xl:grid-cols-7"
		data-testid="session-pulse"
	>
		<!-- Tokens -->
		<Tooltip.Provider delayDuration={150}>
			<Tooltip.Root>
				<Tooltip.Trigger class="cursor-default text-left">
					<div class="h-full bg-background px-4 py-2.5">
						<div class="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
							<Coins class="size-3" /> Tokens
						</div>
						<div class="mt-0.5 text-lg font-semibold leading-tight tabular-nums">
							{fmtTokens(usage.total)}
						</div>
						<div class="mt-1.5 flex h-1 w-full overflow-hidden rounded-full bg-muted">
							<div class="bg-sky-500 transition-all duration-700" style="width: {inPct}%"></div>
							<div class="bg-violet-500 transition-all duration-700" style="width: {100 - inPct}%"></div>
						</div>
						<div class="mt-1 flex gap-3 text-[10px] text-muted-foreground tabular-nums">
							<span class="inline-flex items-center gap-0.5"><ArrowDownToLine class="size-2.5 text-sky-500" />{fmtTokens(usage.input)} in</span>
							<span class="inline-flex items-center gap-0.5"><ArrowUpFromLine class="size-2.5 text-violet-500" />{fmtTokens(usage.output)} out</span>
						</div>
					</div>
				</Tooltip.Trigger>
				<Tooltip.Content side="bottom" class="text-xs tabular-nums">
					<div>Input: {usage.input.toLocaleString()}</div>
					<div>Output: {usage.output.toLocaleString()}</div>
					<div>Cache read: {usage.cacheRead.toLocaleString()}</div>
					<div>Cache write: {usage.cacheCreate.toLocaleString()}</div>
				</Tooltip.Content>
			</Tooltip.Root>
		</Tooltip.Provider>

		<!-- Cache hit -->
		<Tooltip.Provider delayDuration={150}>
			<Tooltip.Root>
				<Tooltip.Trigger class="cursor-default text-left">
					<div class="h-full bg-background px-4 py-2.5">
						<div class="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
							<Zap class="size-3" /> Cache hit
						</div>
						<div class="mt-0.5 flex items-center gap-2">
							<div class="text-lg font-semibold leading-tight tabular-nums">
								{usage.cachePct === null ? '—' : `${usage.cachePct}%`}
							</div>
							<svg viewBox="0 0 24 24" class="size-6 -rotate-90">
								<circle cx="12" cy="12" r="9" fill="none" class="stroke-muted" stroke-width="3" />
								<circle
									cx="12" cy="12" r="9" fill="none" stroke-width="3" stroke-linecap="round"
									class="stroke-emerald-500 transition-all duration-700"
									stroke-dasharray={RING_C}
									stroke-dashoffset={RING_C * (1 - (usage.cachePct ?? 0) / 100)}
								/>
							</svg>
						</div>
						<div class="mt-1 text-[10px] text-muted-foreground tabular-nums">
							{fmtTokens(usage.cacheRead)} read from cache
						</div>
					</div>
				</Tooltip.Trigger>
				<Tooltip.Content side="bottom" class="text-xs">
					Share of prompt tokens served from the provider cache.
				</Tooltip.Content>
			</Tooltip.Root>
		</Tooltip.Provider>

		<!-- Cost -->
		<Tooltip.Provider delayDuration={150}>
			<Tooltip.Root>
				<Tooltip.Trigger class="cursor-default text-left">
					<div class="h-full bg-background px-4 py-2.5">
						<div class="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
							<CircleDollarSign class="size-3" /> Cost
						</div>
						<div class="mt-0.5 text-lg font-semibold leading-tight tabular-nums">
							{cost ? fmtCost(cost.total) : '—'}
						</div>
						<div class="mt-1 text-[10px] text-muted-foreground tabular-nums">
							{#if cost && cost.cacheSavings > 0}
								saved {fmtCost(cost.cacheSavings)} via cache
							{:else if cost}
								provider list rates
							{:else}
								awaiting usage
							{/if}
						</div>
					</div>
				</Tooltip.Trigger>
				<Tooltip.Content side="bottom" class="text-xs tabular-nums">
					{#each Object.entries(usageByModel) as [model, u]}
						<div class="font-medium">{model}</div>
						<div>in {u.input.toLocaleString()} · out {u.output.toLocaleString()}</div>
						<div>cache read {u.cacheRead.toLocaleString()} · write {u.cacheCreate.toLocaleString()}</div>
					{/each}
					{#if cost}
						<div class="mt-1">Cache savings vs full input rate: {fmtCost(cost.cacheSavings)}</div>
					{/if}
				</Tooltip.Content>
			</Tooltip.Root>
		</Tooltip.Provider>

		<!-- Context window -->
		<Tooltip.Provider delayDuration={150}>
			<Tooltip.Root>
				<Tooltip.Trigger class="cursor-default text-left">
					<div class="h-full bg-background px-4 py-2.5">
						<div class="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
							<Gauge class="size-3" /> Context
						</div>
						<div class="mt-0.5 text-lg font-semibold leading-tight tabular-nums {context ? contextTone.text : ''}">
							{context ? `${Math.round(context.usedPct)}%` : '—'}
						</div>
						<div class="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-muted">
							<div
								class="h-full rounded-full {contextTone.bar} transition-all duration-700"
								style="width: {context?.usedPct ?? 0}%"
							></div>
						</div>
						<div class="mt-1 text-[10px] text-muted-foreground tabular-nums">
							{context ? `${fmtTokens(context.inputTokens)} / ${fmtTokens(context.windowSize)}` : 'no snapshot yet'}
						</div>
					</div>
				</Tooltip.Trigger>
				<Tooltip.Content side="bottom" class="text-xs tabular-nums">
					{#if context}
						<div>{context.inputTokens.toLocaleString()} of {context.windowSize.toLocaleString()} tokens</div>
						{#if context.compactAt > 0}
							<div>Auto-compacts at {context.compactAt.toLocaleString()}</div>
						{/if}
						<div class="text-muted-foreground">
							{context.providerReported ? 'provider-reported' : 'estimated (pre-call)'}
						</div>
					{:else}
						Context snapshot arrives with the first LLM call.
					{/if}
				</Tooltip.Content>
			</Tooltip.Root>
		</Tooltip.Provider>

		<!-- Elapsed -->
		<div class="bg-background px-4 py-2.5">
			<div class="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
				<Clock class="size-3" /> Elapsed
				{#if live}
					<span class="relative flex size-1.5">
						<span class="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75"></span>
						<span class="relative inline-flex size-1.5 rounded-full bg-emerald-500"></span>
					</span>
				{/if}
			</div>
			<div class="mt-0.5 text-lg font-semibold leading-tight tabular-nums">{fmtElapsed(elapsed)}</div>
			<div class="mt-1 text-[10px] text-muted-foreground capitalize">{status ?? '—'}</div>
		</div>

		<!-- Turns -->
		<div class="bg-background px-4 py-2.5">
			<div class="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
				<Repeat2 class="size-3" /> Turns
			</div>
			<div class="mt-0.5 text-lg font-semibold leading-tight tabular-nums">{turns}</div>
			<div class="mt-1 text-[10px] text-muted-foreground tabular-nums">{usage.llmCalls} LLM calls</div>
		</div>

		<!-- Compute (actual CPU/memory of the session's sandbox pod) -->
		<Tooltip.Provider delayDuration={150}>
			<Tooltip.Root>
				<Tooltip.Trigger class="cursor-default text-left">
					<div class="h-full bg-background px-4 py-2.5">
						<div class="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
							<Cpu class="size-3" /> Compute
						</div>
						{#if compute?.usage}
							<div class="mt-0.5 text-lg font-semibold leading-tight tabular-nums {computeTone}">
								{fmtCpu(compute.usage.cpuMillicores)}{#if compute.requests}<span
										class="text-sm font-normal text-muted-foreground">/{fmtCpu(compute.requests.cpuMillicores)}</span
									>{/if}
							</div>
							<div class="mt-1 text-[10px] text-muted-foreground tabular-nums">
								{fmtMem(compute.usage.memoryMiB)}{#if compute.requests} / {fmtMem(
										compute.requests.memoryMiB
									)}{/if} mem
							</div>
						{:else}
							<div class="mt-0.5 text-lg font-semibold leading-tight text-muted-foreground">—</div>
							<div class="mt-1 text-[10px] text-muted-foreground">{live ? 'awaiting sample' : 'no pod'}</div>
						{/if}
					</div>
				</Tooltip.Trigger>
				<Tooltip.Content side="bottom" class="text-xs tabular-nums">
					{#if compute?.usage}
						<div>CPU {fmtCpu(compute.usage.cpuMillicores)}{#if compute.requests} of {fmtCpu(compute.requests.cpuMillicores)} requested{/if}</div>
						<div>Memory {fmtMem(compute.usage.memoryMiB)}{#if compute.requests} of {fmtMem(compute.requests.memoryMiB)} requested{/if}</div>
						<div class="text-muted-foreground">actual sandbox-pod usage · 15s metrics-server sample</div>
					{:else}
						Live CPU/memory of the session's sandbox pod (metrics-server).
					{/if}
				</Tooltip.Content>
			</Tooltip.Root>
		</Tooltip.Provider>

		<!-- Goal loop -->
		<Tooltip.Provider delayDuration={150}>
			<Tooltip.Root>
				<Tooltip.Trigger class="cursor-default text-left">
					<div class="h-full bg-background px-4 py-2.5">
						<div class="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
							<Target class="size-3" /> Goal loop
						</div>
						{#if goal}
							<div class="mt-0.5 text-lg font-semibold leading-tight tabular-nums {goalTone}">
								{goal.iterations}<span class="text-sm font-normal text-muted-foreground">/{goal.maxIterations}</span>
							</div>
							{#if goal.tokenBudget}
								<div class="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-muted">
									<div
										class="h-full rounded-full transition-all duration-700 {goal.status === 'budget_limited' ? 'bg-red-500' : 'bg-blue-500'}"
										style="width: {Math.min(100, (goal.tokensUsed / goal.tokenBudget) * 100)}%"
									></div>
								</div>
							{/if}
							<div class="mt-1 text-[10px] capitalize {goalTone}">{goal.status.replace('_', ' ')}</div>
						{:else}
							<div class="mt-0.5 text-lg font-semibold leading-tight text-muted-foreground/50">—</div>
							<div class="mt-1 text-[10px] text-muted-foreground">no goal set</div>
						{/if}
					</div>
				</Tooltip.Trigger>
				<Tooltip.Content side="bottom" class="max-w-72 text-xs">
					{#if goal}
						<div class="font-medium capitalize">{goal.status.replace('_', ' ')}</div>
						<div class="mt-1 line-clamp-4">{goal.objective}</div>
						{#if goal.tokenBudget}
							<div class="mt-1 tabular-nums">{goal.tokensUsed.toLocaleString()} / {goal.tokenBudget.toLocaleString()} tokens</div>
						{/if}
					{:else}
						Autonomous goal loop — set via POST /api/v1/sessions/&lt;id&gt;/goal.
					{/if}
				</Tooltip.Content>
			</Tooltip.Root>
		</Tooltip.Provider>
	</div>
{/if}
