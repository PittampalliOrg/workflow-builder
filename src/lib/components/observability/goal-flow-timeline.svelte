<script lang="ts">
	import type { GoalFlow, GoalFlowAttempt, ObservabilityAgentDecisionTurn } from '$lib/types/observability';
	import { formatTokens, formatDuration } from './span-kind';
	import {
		Target,
		Bot,
		ShieldCheck,
		Send,
		Check,
		X,
		RotateCw,
		ChevronDown,
		ChevronRight,
		ListChecks,
		GitBranch,
		Activity,
		Loader2,
		ArrowRight
	} from '@lucide/svelte';

	interface Props {
		goalFlow: GoalFlow;
		agentDecisions?: ObservabilityAgentDecisionTurn[];
		onSelectAttempt?: (attempt: GoalFlowAttempt) => void;
	}

	let { goalFlow, onSelectAttempt }: Props = $props();

	type ViewMode = 'flow' | 'timeline';
	let viewMode = $state<ViewMode>('flow');
	// Selected attempt — default to the last (most relevant). Re-derive when the
	// flow identity changes so the component is reusable across traces/sessions.
	let selectedId = $state<string | null>(null);
	let flowKey = $state<string>('');
	$effect(() => {
		const key = `${goalFlow.goalId}:${goalFlow.attempts.length}`;
		if (key !== flowKey) {
			flowKey = key;
			selectedId = goalFlow.attempts.at(-1)?.id ?? null;
		}
	});
	const selected = $derived(
		goalFlow.attempts.find((a) => a.id === selectedId) ?? goalFlow.attempts.at(-1) ?? null
	);

	let openOutputs = $state<Set<string>>(new Set());
	function toggleOutput(k: string) {
		const next = new Set(openOutputs);
		if (next.has(k)) next.delete(k);
		else next.add(k);
		openOutputs = next;
	}
	let goalDetailsOpen = $state(false);

	const totalChecks = $derived(goalFlow.evidenceCommands.length);

	// status → color tokens (status is the ONLY saturated color in this view).
	function vStyle(kind: 'pass' | 'reject' | 'none') {
		if (kind === 'pass')
			return { text: 'text-emerald-300', bg: 'bg-emerald-500/12', ring: 'ring-emerald-500/40', dot: 'bg-emerald-400', solid: 'text-emerald-400' };
		if (kind === 'reject')
			return { text: 'text-red-300', bg: 'bg-red-500/12', ring: 'ring-red-500/40', dot: 'bg-red-400', solid: 'text-red-400' };
		return { text: 'text-amber-300', bg: 'bg-amber-500/12', ring: 'ring-amber-500/40', dot: 'bg-amber-400', solid: 'text-amber-400' };
	}
	const statusStyle: Record<string, ReturnType<typeof vStyle>> = {
		complete: vStyle('pass'),
		active: { text: 'text-cyan-300', bg: 'bg-cyan-500/12', ring: 'ring-cyan-500/40', dot: 'bg-cyan-400', solid: 'text-cyan-400' },
		budget_limited: vStyle('none'),
		paused: { text: 'text-zinc-300', bg: 'bg-white/8', ring: 'ring-white/20', dot: 'bg-zinc-400', solid: 'text-zinc-400' }
	};
	const ss = $derived(statusStyle[goalFlow.status] ?? statusStyle.active);

	// checks passed for an attempt (pass = all verified; reject = ok count).
	function checksPassed(a: GoalFlowAttempt): number | null {
		if (a.verdict.kind === 'pass') return a.verdict.verifiedCount ?? totalChecks;
		if (a.verdict.kind === 'reject')
			return a.verdict.checks.length
				? a.verdict.checks.filter((c) => c.ok).length
				: Math.max(0, totalChecks - a.verdict.failingCount);
		return null;
	}
	function attemptDurMs(a: GoalFlowAttempt): number | null {
		if (!a.startedAt || !a.endedAt) return null;
		const ms = Date.parse(a.endedAt) - Date.parse(a.startedAt);
		return ms > 0 ? ms : null;
	}
	const elapsedMs = $derived.by(() => {
		if (!goalFlow.startedAt) return null;
		const end = goalFlow.completedAt ?? goalFlow.attempts.at(-1)?.endedAt ?? null;
		if (!end) return null;
		const ms = Date.parse(end) - Date.parse(goalFlow.startedAt);
		return ms > 0 ? ms : null;
	});
	const lastAttempt = $derived(goalFlow.attempts.at(-1) ?? null);
	const totalPassed = $derived(lastAttempt ? (checksPassed(lastAttempt) ?? 0) : 0);

	// Newly-passing checks vs the previous attempt (the "diff").
	function newlyPassing(idx: number): string[] {
		if (idx <= 0) return [];
		const prev = goalFlow.attempts[idx - 1];
		const cur = goalFlow.attempts[idx];
		const prevFail = new Set(prev.verdict.checks.filter((c) => !c.ok).map((c) => c.command));
		if (cur.verdict.kind === 'pass') return [...prevFail];
		return cur.verdict.checks.filter((c) => c.ok && prevFail.has(c.command)).map((c) => c.command);
	}

	// Sparkline points (checks-passed ratio per attempt).
	const spark = $derived.by(() => {
		if (totalChecks === 0) return [];
		return goalFlow.attempts.map((a) => {
			const p = checksPassed(a);
			return p == null ? 0 : p / totalChecks;
		});
	});

	function pillLabel(a: GoalFlowAttempt): string {
		return a.verdict.kind === 'pass' ? 'PASS' : a.verdict.kind === 'reject' ? 'REJECT' : 'running';
	}
	function shortCmd(cmd: string): string {
		return cmd.length > 90 ? cmd.slice(0, 90) + '…' : cmd;
	}
	function selectAttempt(a: GoalFlowAttempt) {
		selectedId = a.id;
		onSelectAttempt?.(a);
	}

	// Waterfall geometry (timeline view).
	const tl = $derived.by(() => {
		const starts = goalFlow.attempts
			.map((a) => (a.startedAt ? Date.parse(a.startedAt) : NaN))
			.filter(Number.isFinite);
		const ends = goalFlow.attempts
			.map((a) => (a.endedAt ? Date.parse(a.endedAt) : NaN))
			.filter(Number.isFinite);
		const min = starts.length ? Math.min(...starts) : 0;
		const max = ends.length ? Math.max(...ends) : min + 1;
		return { min, span: Math.max(1, max - min) };
	});
</script>

<div class="flex h-full flex-col bg-[#0b0c0e] text-zinc-200">
	<!-- ============ 1. SUMMARY STRIP (sticky overview) ============ -->
	<div class="sticky top-0 z-10 border-b border-white/10 bg-[#0b0c0e]/95 px-4 py-3 backdrop-blur">
		<div class="flex items-center gap-3">
			<span class="flex size-7 shrink-0 items-center justify-center rounded-lg {ss.bg} ring-1 ring-inset {ss.ring}">
				<Target size={15} class={ss.text} />
			</span>
			<div class="min-w-0 flex-1">
				<div class="flex items-center gap-2">
					<span class="text-[10px] font-semibold uppercase tracking-[0.18em] text-zinc-500">Goal</span>
					<span class="truncate text-sm text-zinc-100">{goalFlow.objective}</span>
				</div>
			</div>
			<span class="inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide {ss.bg} {ss.text} ring-1 ring-inset {ss.ring}">
				{#if goalFlow.status === 'active'}<Loader2 size={11} class="animate-spin" />{:else if goalFlow.status === 'complete'}<Check size={12} />{/if}
				{goalFlow.status}
			</span>
		</div>

		<!-- counters + loop glyph + view toggle -->
		<div class="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2 text-[11px] text-zinc-400">
			<span class="font-medium text-zinc-300">{goalFlow.attempts.length} attempt{goalFlow.attempts.length === 1 ? '' : 's'}</span>
			{#if totalChecks > 0}<span class="tabular-nums">{totalPassed}/{totalChecks} checks</span>{/if}
			<span class="tabular-nums">iter {goalFlow.iterations}/{goalFlow.maxIterations}</span>
			<span class="font-mono tabular-nums">{formatTokens(goalFlow.tokensUsed)}{goalFlow.tokenBudget ? `/${formatTokens(goalFlow.tokenBudget)}` : ''} tok</span>
			{#if elapsedMs}<span class="tabular-nums">{formatDuration(elapsedMs)}</span>{/if}
			{#if goalFlow.completionSource}<span class="font-mono text-zinc-500">{goalFlow.completionSource}</span>{/if}

			<!-- loop / cycle glyph (the evaluator-optimizer mechanism) -->
			<span class="hidden items-center gap-1 text-zinc-600 sm:inline-flex" title="agent submits → evaluator checks → reject loops back, accept exits">
				<Bot size={11} /> <ArrowRight size={9} /> <ShieldCheck size={11} class="text-pink-400/60" />
				<RotateCw size={9} class="text-amber-400/60" /> <Check size={9} class="text-emerald-400/60" />
			</span>

			<div class="ml-auto flex items-center rounded-lg border border-white/10 bg-white/5 p-0.5">
				<button class="flex items-center gap-1 rounded px-2 py-0.5 text-[10px] {viewMode === 'flow' ? 'bg-white/10 text-zinc-100' : 'text-zinc-500 hover:text-zinc-300'}" onclick={() => (viewMode = 'flow')}><GitBranch size={10} /> Flow</button>
				<button class="flex items-center gap-1 rounded px-2 py-0.5 text-[10px] {viewMode === 'timeline' ? 'bg-white/10 text-zinc-100' : 'text-zinc-500 hover:text-zinc-300'}" onclick={() => (viewMode = 'timeline')}><Activity size={10} /> Timeline</button>
			</div>
		</div>

		<!-- collapsible goal details (criteria + evidence) — hidden by default -->
		<button class="mt-2 inline-flex items-center gap-1 text-[10px] text-zinc-500 hover:text-zinc-300" onclick={() => (goalDetailsOpen = !goalDetailsOpen)}>
			{#if goalDetailsOpen}<ChevronDown size={11} />{:else}<ChevronRight size={11} />{/if}
			criteria & evidence ({goalFlow.acceptanceCriteria.length} criteria · {totalChecks} checks)
		</button>
		{#if goalDetailsOpen}
			<div class="mt-2 grid gap-3 rounded-lg border border-white/10 bg-white/[0.02] p-3 md:grid-cols-2">
				<div>
					<p class="mb-1 flex items-center gap-1 text-[10px] uppercase tracking-[0.18em] text-zinc-500"><ListChecks size={11} /> Acceptance criteria</p>
					<ul class="space-y-1">
						{#each goalFlow.acceptanceCriteria as c (c)}<li class="text-[11px] leading-5 text-zinc-400">• {c}</li>{/each}
					</ul>
				</div>
				<div>
					<p class="mb-1 flex items-center gap-1 text-[10px] uppercase tracking-[0.18em] text-zinc-500"><ShieldCheck size={11} class="text-pink-300" /> Evidence checks</p>
					<div class="space-y-1">
						{#each goalFlow.evidenceCommands as cmd (cmd)}<code class="block overflow-x-auto rounded border border-white/10 bg-black/30 px-1.5 py-1 font-mono text-[10px] text-zinc-400">{shortCmd(cmd)}</code>{/each}
					</div>
				</div>
			</div>
		{/if}
	</div>

	{#if viewMode === 'flow'}
		<!-- ============ 2. PIPELINE (overview) ============ -->
		<div class="border-b border-white/10 px-4 py-3">
			<div class="flex items-center gap-1 overflow-x-auto pb-1">
				{#each goalFlow.attempts as a, i (a.id)}
					{@const vs = vStyle(a.verdict.kind)}
					{@const isSel = a.id === selected?.id}
					{#if i > 0}
						<span class="flex shrink-0 items-center gap-0.5 px-0.5 text-[9px] {goalFlow.attempts[i - 1].verdict.kind === 'reject' ? 'text-amber-400/70' : 'text-zinc-600'}">
							{#if goalFlow.attempts[i - 1].verdict.kind === 'reject'}<RotateCw size={11} /> retry{:else}<ArrowRight size={12} />{/if}
						</span>
					{/if}
					<button
						class="flex shrink-0 items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[11px] ring-1 ring-inset transition {vs.bg} {vs.ring} {isSel ? 'outline outline-1 outline-offset-1 outline-white/30' : 'hover:brightness-125'}"
						onclick={() => selectAttempt(a)}
					>
						<span class="font-semibold tabular-nums {vs.text}">#{i + 1}</span>
						{#if a.verdict.kind === 'pass'}<Check size={12} class={vs.solid} />{:else if a.verdict.kind === 'reject'}<X size={12} class={vs.solid} />{:else}<Loader2 size={11} class="{vs.solid} animate-spin" />{/if}
						{#if totalChecks > 0 && a.verdict.kind !== 'none'}<span class="tabular-nums {vs.text}">{checksPassed(a)}/{totalChecks}</span>{/if}
					</button>
				{/each}
				{#if goalFlow.status === 'complete'}
					<span class="flex shrink-0 items-center gap-0.5 px-0.5 text-zinc-600"><ArrowRight size={12} /></span>
					<span class="flex shrink-0 items-center gap-1 rounded-lg bg-emerald-500/12 px-2.5 py-1.5 text-[11px] font-semibold text-emerald-300 ring-1 ring-inset ring-emerald-500/40"><Check size={12} /> done</span>
				{/if}

				{#if spark.length > 1}
					<div class="ml-3 hidden items-center lg:flex" title="checks passed per attempt">
						<svg width={Math.max(40, spark.length * 16)} height="20" class="overflow-visible">
							<polyline points={spark.map((v, i) => `${i * 16},${16 - v * 14}`).join(' ')} fill="none" stroke="currentColor" stroke-width="1.5" class="text-cyan-400/70" />
							{#each spark as v, i (i)}<circle cx={i * 16} cy={16 - v * 14} r="2" class={v === 1 ? 'fill-emerald-400' : 'fill-zinc-500'} />{/each}
						</svg>
					</div>
				{/if}
			</div>
		</div>

		<!-- ============ 3. DETAIL PANE (details on demand) ============ -->
		<div class="flex-1 overflow-y-auto p-4">
			{#if selected}
				{@const idx = goalFlow.attempts.indexOf(selected)}
				{@const vs = vStyle(selected.verdict.kind)}
				{@const diff = newlyPassing(idx)}
				<div class="mx-auto max-w-3xl space-y-3">
					<div class="flex flex-wrap items-center gap-2">
						<h3 class="text-sm font-semibold text-zinc-100">Attempt {idx + 1}</h3>
						<span class="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase {vs.bg} {vs.text}">
							{#if selected.verdict.kind === 'pass'}<Check size={11} />{:else if selected.verdict.kind === 'reject'}<X size={11} />{/if}{pillLabel(selected)}
						</span>
						<span class="text-[11px] text-zinc-500">
							{selected.work.turnCount} turn{selected.work.turnCount === 1 ? '' : 's'}
							{#if selected.work.toolNames.length}· {selected.work.toolNames.slice(0, 6).join(', ')}{/if}
							{#if selected.work.tokenDelta}· {formatTokens(selected.work.tokenDelta)} tok{/if}
							{#if attemptDurMs(selected)}· {formatDuration(attemptDurMs(selected))}{/if}
						</span>
					</div>

					<div class="flex items-center gap-1.5 text-[11px] text-zinc-400">
						<Send size={11} class="text-zinc-500" />
						{#if selected.submission.kind === 'update_goal'}submitted <code class="text-zinc-300">update_goal(complete)</code>
						{:else if selected.submission.kind === 'idle_backstop'}submitted via idle backstop
						{:else}no submission yet{/if}
						<ArrowRight size={10} class="text-zinc-600" />
						<ShieldCheck size={11} class="text-pink-400/70" /> evaluator
					</div>

					{#if diff.length > 0}
						<div class="rounded-lg border border-emerald-500/20 bg-emerald-500/[0.05] px-3 py-1.5 text-[11px] text-emerald-300">
							<Check size={11} class="mr-1 inline" />{diff.length} check{diff.length === 1 ? '' : 's'} now passing vs attempt {idx}
						</div>
					{/if}

					{#if selected.verdict.kind === 'reject' && selected.verdict.checks.length}
						<div class="space-y-1.5">
							{#each [...selected.verdict.checks].sort((a, b) => Number(a.ok) - Number(b.ok)) as chk, ci (chk.command + ci)}
								{@const ok = chk.ok}
								<div class="rounded-lg border {ok ? 'border-white/10 bg-white/[0.02]' : 'border-red-500/25 bg-red-500/[0.05]'}">
									<div class="flex items-center gap-2 px-3 py-2">
										{#if ok}<Check size={13} class="shrink-0 text-emerald-400" />{:else}<X size={13} class="shrink-0 text-red-400" />{/if}
										<code class="min-w-0 flex-1 truncate font-mono text-[11px] {ok ? 'text-zinc-400' : 'text-zinc-200'}" title={chk.command}>{shortCmd(chk.command)}</code>
										<span class="shrink-0 font-mono text-[10px] text-zinc-500">exit {chk.exitCode}</span>
										{#if chk.output}
											<button class="shrink-0 text-[10px] text-zinc-500 hover:text-zinc-300" onclick={() => toggleOutput(selected.id + ':' + ci)}>
												{openOutputs.has(selected.id + ':' + ci) ? '▾' : '▸'} output
											</button>
										{/if}
									</div>
									{#if chk.output && openOutputs.has(selected.id + ':' + ci)}
										<pre class="max-h-48 overflow-auto whitespace-pre-wrap break-words border-t border-white/10 bg-black/40 px-3 py-2 font-mono text-[10.5px] leading-5 {ok ? 'text-zinc-400' : 'text-red-200/90'}">{chk.output}</pre>
									{/if}
								</div>
							{/each}
						</div>
					{:else if selected.verdict.kind === 'pass'}
						<div class="rounded-lg border border-emerald-500/25 bg-emerald-500/[0.05] p-3">
							<p class="flex items-center gap-1.5 text-[12px] text-emerald-300"><Check size={13} /> {selected.verdict.verifiedCount ?? totalChecks} evidence check{(selected.verdict.verifiedCount ?? totalChecks) === 1 ? '' : 's'} verified</p>
							{#if totalChecks > 0}
								<div class="mt-2 space-y-1">
									{#each goalFlow.evidenceCommands as cmd (cmd)}
										<div class="flex items-center gap-2"><Check size={11} class="shrink-0 text-emerald-400" /><code class="truncate font-mono text-[10.5px] text-zinc-400" title={cmd}>{shortCmd(cmd)}</code></div>
									{/each}
								</div>
							{:else}
								<p class="mt-1 text-[11px] text-zinc-500">self-judged — no evidence commands declared</p>
							{/if}
						</div>
					{:else}
						<div class="rounded-lg border border-white/10 bg-white/[0.03] p-3 text-[12px] text-zinc-400">Working… no evaluator verdict yet for this attempt.</div>
					{/if}
				</div>
			{/if}
		</div>
	{:else}
		<!-- ============ TIMELINE (waterfall) ============ -->
		<div class="flex-1 overflow-y-auto p-4">
			<div class="mx-auto max-w-3xl space-y-1.5">
				{#each goalFlow.attempts as a, i (a.id)}
					{@const vs = vStyle(a.verdict.kind)}
					{@const start = a.startedAt ? Date.parse(a.startedAt) : tl.min}
					{@const dur = attemptDurMs(a) ?? 0}
					{@const offsetPct = ((start - tl.min) / tl.span) * 100}
					{@const widthPct = Math.max(2, (dur / tl.span) * 100)}
					<button class="block w-full rounded-lg border border-white/10 bg-white/[0.02] p-2 text-left hover:bg-white/[0.04] {a.id === selected?.id ? 'ring-1 ring-inset ring-white/20' : ''}" onclick={() => { selectAttempt(a); viewMode = 'flow'; }}>
						<div class="flex items-center gap-2 text-[11px]">
							<span class="w-16 shrink-0 font-medium {vs.text}">Attempt {i + 1}</span>
							<div class="relative h-4 flex-1 rounded bg-white/[0.03]">
								<div class="absolute top-0.5 bottom-0.5 rounded {vs.bg} ring-1 ring-inset {vs.ring}" style="left:{offsetPct}%; width:{widthPct}%"></div>
							</div>
							<span class="w-14 shrink-0 text-right font-mono tabular-nums text-zinc-500">{dur ? formatDuration(dur) : '—'}</span>
							{#if a.verdict.kind === 'pass'}<Check size={12} class="shrink-0 text-emerald-400" />{:else if a.verdict.kind === 'reject'}<X size={12} class="shrink-0 text-red-400" />{:else}<Loader2 size={11} class="shrink-0 animate-spin text-amber-400" />{/if}
						</div>
					</button>
				{/each}
			</div>
		</div>
	{/if}
</div>
