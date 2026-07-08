<script lang="ts">
	/**
	 * Deterministic run digest strip: what happened, instantly, zero LLM calls.
	 * Status + wall clock, phase chips (duration · tokens), totals (tokens,
	 * cost, cache hit), the critical path in words, budget burn — and the
	 * ISSUES RAIL: one chip per problem; clicking a chip selects the owning
	 * call in the graph (onSelectCall) so the drilldown opens on the evidence.
	 */
	import {
		ChevronDown,
		AlertTriangle,
		RefreshCcw,
		Timer,
		Coins,
		Route,
		Gauge
	} from '@lucide/svelte';
	import type { RunDigest, RunIssue } from '$lib/types/run-digest';

	let {
		executionId,
		active = false,
		onSelectCall
	}: {
		executionId: string;
		active?: boolean;
		onSelectCall?: (callId: string) => void;
	} = $props();

	let digest = $state<RunDigest | null>(null);
	let open = $state(true);

	async function fetchDigest() {
		try {
			const res = await fetch(
				`/api/observability/executions/${encodeURIComponent(executionId)}/digest`
			);
			if (res.ok) digest = (await res.json()) as RunDigest;
		} catch {
			/* best-effort */
		}
	}

	$effect(() => {
		void executionId;
		fetchDigest();
	});
	$effect(() => {
		if (!active) return;
		const t = setInterval(fetchDigest, 6000);
		return () => clearInterval(t);
	});

	function fmtMs(ms: number | null): string {
		if (ms == null || !Number.isFinite(ms)) return '—';
		if (ms >= 60_000) return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
		return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
	}
	function fmtTokens(n: number): string {
		if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
		if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
		return `${n}`;
	}
	function fmtCost(n: number): string {
		if (n > 0 && n < 0.01) return '<$0.01';
		return `$${n.toFixed(2)}`;
	}

	function issueTone(issue: RunIssue): string {
		return issue.kind === 'call_retries'
			? 'border-amber-400/40 bg-amber-500/10 text-amber-300 hover:bg-amber-500/20'
			: 'border-destructive/40 bg-destructive/10 text-destructive hover:bg-destructive/20';
	}

	const budgetPct = $derived(
		digest?.budget && digest.budget.total > 0
			? Math.min(100, Math.round((digest.budget.spentTokens / digest.budget.total) * 100))
			: null
	);
</script>

{#if digest}
	<div class="border-b bg-card/40">
		<button
			class="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-muted/30"
			onclick={() => (open = !open)}
		>
			<Gauge class="size-3.5 text-primary" />
			<span class="text-xs font-semibold">Run digest</span>
			<span class="text-[11px] text-muted-foreground">
				{digest.status} · {fmtMs(digest.wallClockMs)} · {fmtTokens(digest.totals.tokens)} tokens ·
				{fmtCost(digest.totals.costUsd)}
				{#if digest.totals.cacheHitRate != null}
					· {Math.round(digest.totals.cacheHitRate * 100)}% cache
				{/if}
			</span>
			{#if digest.issues.length > 0}
				<span
					class="inline-flex items-center gap-1 rounded-full border border-destructive/40 bg-destructive/10 px-1.5 text-[10px] font-medium text-destructive"
				>
					<AlertTriangle class="size-2.5" />
					{digest.issues.length} issue{digest.issues.length === 1 ? '' : 's'}
				</span>
			{/if}
			<ChevronDown
				class="ml-auto size-3.5 text-muted-foreground transition-transform {open ? 'rotate-180' : ''}"
			/>
		</button>

		{#if open}
			<div class="space-y-2 px-3 pb-2.5">
				<!-- Phases -->
				{#if digest.phases.length > 0}
					<div class="flex flex-wrap items-center gap-1.5">
						{#each digest.phases as phase (phase.title)}
							<span
								class="inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-[11px]
									{phase.errors > 0
									? 'border-destructive/40 bg-destructive/5'
									: phase.running > 0
										? 'border-primary/40 bg-primary/5'
										: 'border-border bg-muted/30'}"
							>
								<span class="font-medium">{phase.title}</span>
								<span class="text-muted-foreground">
									<Timer class="mr-0.5 inline size-2.5" />{fmtMs(phase.durationMs)}
								</span>
								{#if phase.tokens > 0}
									<span class="text-muted-foreground">
										<Coins class="mr-0.5 inline size-2.5" />{fmtTokens(phase.tokens)}
									</span>
								{/if}
							</span>
						{/each}
					</div>
				{/if}

				<!-- Critical path sentence + budget -->
				<div class="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
					{#if digest.criticalPath}
						<span class="inline-flex items-center gap-1">
							<Route class="size-3 text-primary/70" />
							Critical path: <span class="text-foreground/80">{digest.criticalPath.labels.join(' → ')}</span>
							({fmtMs(digest.criticalPath.durationMs)}{#if digest.criticalPath.pctOfWallClock != null},
								{digest.criticalPath.pctOfWallClock}% of wall clock{/if})
						</span>
					{/if}
					{#if digest.budget && budgetPct != null}
						<span class="inline-flex items-center gap-1.5">
							Budget
							<span class="inline-block h-1.5 w-20 overflow-hidden rounded-full bg-muted">
								<span
									class="block h-full rounded-full {budgetPct >= 100 ? 'bg-destructive' : 'bg-primary'}"
									style="width: {budgetPct}%"
								></span>
							</span>
							{fmtTokens(digest.budget.spentTokens)}/{fmtTokens(digest.budget.total)}
						</span>
					{/if}
				</div>

				<!-- Issues rail -->
				{#if digest.issues.length > 0}
					<div class="flex flex-wrap items-center gap-1.5">
						{#each digest.issues as issue, i (i)}
							<button
								class="inline-flex max-w-[340px] items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] transition {issueTone(issue)} {issue.callId ? 'cursor-pointer' : 'cursor-default'}"
								title={[issue.detail, issue.chain ? `chain: ${issue.chain.map((c) => c.name).join(' → ')}` : null]
									.filter(Boolean)
									.join('\n') || issue.label}
								onclick={() => issue.callId && onSelectCall?.(issue.callId)}
							>
								{#if issue.kind === 'call_retries'}
									<RefreshCcw class="size-2.5 shrink-0" />
								{:else}
									<AlertTriangle class="size-2.5 shrink-0" />
								{/if}
								<span class="truncate">{issue.label}</span>
							</button>
						{/each}
					</div>
				{/if}
			</div>
		{/if}
	</div>
{/if}
