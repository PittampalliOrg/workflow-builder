<script lang="ts">
	import type { GoalFlow, GoalFlowAttempt, ObservabilityAgentDecisionTurn } from '$lib/types/observability';
	import { formatTokens, formatDuration } from './span-kind';
	import {
		Target,
		Bot,
		Wrench,
		ShieldCheck,
		Check,
		X,
		RotateCw,
		ChevronDown,
		ChevronRight,
		CircleDot,
		Send,
		ListChecks
	} from '@lucide/svelte';

	interface Props {
		goalFlow: GoalFlow;
		agentDecisions?: ObservabilityAgentDecisionTurn[];
		onSelectAttempt?: (attempt: GoalFlowAttempt) => void;
	}

	let { goalFlow, agentDecisions = [], onSelectAttempt }: Props = $props();

	// Expand reject attempts by default (the interesting ones).
	let expanded = $state<Set<string>>(
		new Set(goalFlow.attempts.filter((a) => a.verdict.kind === 'reject').map((a) => a.id))
	);
	function toggle(id: string) {
		const next = new Set(expanded);
		if (next.has(id)) next.delete(id);
		else next.add(id);
		expanded = next;
	}

	const statusStyle: Record<string, { text: string; bg: string; border: string; dot: string }> = {
		complete: { text: 'text-emerald-300', bg: 'bg-emerald-500/10', border: 'border-emerald-500/30', dot: 'bg-emerald-400' },
		active: { text: 'text-cyan-300', bg: 'bg-cyan-500/10', border: 'border-cyan-500/30', dot: 'bg-cyan-400' },
		budget_limited: { text: 'text-amber-300', bg: 'bg-amber-500/10', border: 'border-amber-500/30', dot: 'bg-amber-400' },
		paused: { text: 'text-zinc-300', bg: 'bg-white/5', border: 'border-white/15', dot: 'bg-zinc-400' }
	};
	const ss = $derived(statusStyle[goalFlow.status] ?? statusStyle.active);

	function relTime(iso: string | null): string {
		if (!iso) return '';
		return new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
	}
	function attemptDuration(a: GoalFlowAttempt): string {
		if (!a.startedAt || !a.endedAt) return '';
		const ms = Date.parse(a.endedAt) - Date.parse(a.startedAt);
		return ms > 0 ? formatDuration(ms) : '';
	}
</script>

<div class="mx-auto max-w-4xl space-y-4 p-4">
	<!-- Goal header card -->
	<div class="rounded-2xl border {ss.border} bg-gradient-to-b from-white/[0.04] to-white/[0.01] p-4">
		<div class="flex items-start gap-3">
			<span class="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg {ss.bg} ring-1 ring-inset {ss.border}">
				<Target size={16} class={ss.text} />
			</span>
			<div class="min-w-0 flex-1">
				<div class="flex flex-wrap items-center gap-2">
					<span class="text-[10px] font-semibold uppercase tracking-[0.18em] text-zinc-500">Goal</span>
					<span class="rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide {ss.bg} {ss.text}">{goalFlow.status}</span>
					<span class="font-mono text-[11px] text-zinc-500">{goalFlow.outcome.label}</span>
				</div>
				<p class="mt-1.5 text-sm leading-6 text-zinc-100">{goalFlow.objective}</p>

				<div class="mt-3 flex flex-wrap items-center gap-2 text-[11px] text-zinc-400">
					<span class="rounded-md border border-white/10 bg-white/5 px-2 py-1">iterations {goalFlow.iterations}/{goalFlow.maxIterations}</span>
					<span class="rounded-md border border-white/10 bg-white/5 px-2 py-1 font-mono tabular-nums">
						{formatTokens(goalFlow.tokensUsed)}{goalFlow.tokenBudget ? ` / ${formatTokens(goalFlow.tokenBudget)}` : ''} tok
					</span>
					<span class="rounded-md border border-white/10 bg-white/5 px-2 py-1">{goalFlow.attempts.length} attempt{goalFlow.attempts.length === 1 ? '' : 's'}</span>
					{#if goalFlow.stopReason}<span class="rounded-md border border-white/10 bg-white/5 px-2 py-1">stop: {goalFlow.stopReason}</span>{/if}
					{#if goalFlow.completionSource}<span class="rounded-md border border-white/10 bg-white/5 px-2 py-1 font-mono">{goalFlow.completionSource}</span>{/if}
				</div>

				{#if goalFlow.acceptanceCriteria.length}
					<div class="mt-3">
						<p class="mb-1 flex items-center gap-1.5 text-[10px] uppercase tracking-[0.18em] text-zinc-500"><ListChecks size={11} /> Acceptance criteria</p>
						<ul class="space-y-1">
							{#each goalFlow.acceptanceCriteria as c (c)}
								<li class="flex items-start gap-1.5 text-[12px] leading-5 text-zinc-300">
									<CircleDot size={11} class="mt-1 shrink-0 text-zinc-600" /><span>{c}</span>
								</li>
							{/each}
						</ul>
					</div>
				{/if}
				{#if goalFlow.evidenceCommands.length}
					<div class="mt-3">
						<p class="mb-1 flex items-center gap-1.5 text-[10px] uppercase tracking-[0.18em] text-zinc-500"><ShieldCheck size={11} class="text-pink-300" /> Evidence checks ({goalFlow.evidenceCommands.length})</p>
						<div class="space-y-1">
							{#each goalFlow.evidenceCommands as cmd (cmd)}
								<code class="block overflow-x-auto rounded-md border border-pink-500/15 bg-black/30 px-2 py-1 font-mono text-[10.5px] text-pink-200/90">{cmd}</code>
							{/each}
						</div>
					</div>
				{/if}
			</div>
		</div>
	</div>

	<!-- Attempt timeline -->
	<div class="space-y-0">
		{#each goalFlow.attempts as attempt, i (attempt.id)}
			{@const v = attempt.verdict}
			{@const isExp = expanded.has(attempt.id)}
			<!-- loop connector before re-attempts -->
			{#if i > 0}
				<div class="flex items-center gap-2 py-1 pl-4 text-[10px] text-zinc-500">
					<div class="ml-[14px] h-5 w-px bg-white/10"></div>
					{#if goalFlow.attempts[i - 1].verdict.kind === 'reject'}
						<RotateCw size={11} class="text-amber-400" /><span>loop — re-attempt after rejection</span>
					{/if}
				</div>
			{/if}

			<div
				role="button"
				tabindex="0"
				class="block w-full cursor-pointer rounded-xl border border-white/10 bg-white/[0.02] p-3 text-left transition hover:border-white/20 hover:bg-white/[0.04]"
				onclick={() => onSelectAttempt?.(attempt)}
				onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelectAttempt?.(attempt); } }}
			>
				<!-- attempt header -->
				<div class="flex flex-wrap items-center gap-2">
					<span class="rounded-md bg-white/10 px-2 py-0.5 text-[11px] font-semibold text-zinc-200">Attempt {i + 1}</span>
					<span class="text-[11px] text-zinc-500">{relTime(attempt.startedAt)}{attemptDuration(attempt) ? ` · ${attemptDuration(attempt)}` : ''}</span>
				</div>

				<!-- flow row: work → submit → evaluate -->
				<div class="mt-2.5 space-y-1.5">
					<!-- agent work -->
					<div class="flex items-center gap-2 text-[12px]">
						<span class="flex size-5 shrink-0 items-center justify-center rounded bg-amber-500/10 text-amber-300 ring-1 ring-inset ring-amber-500/25"><Bot size={12} /></span>
						<span class="text-zinc-300">Agent worked</span>
						<span class="text-[11px] text-zinc-500">
							{attempt.work.turnCount} turn{attempt.work.turnCount === 1 ? '' : 's'}
							{#if attempt.work.toolNames.length}<span class="text-emerald-300/70"> · {attempt.work.toolNames.slice(0, 5).join(', ')}{attempt.work.toolNames.length > 5 ? '…' : ''}</span>{/if}
							{#if attempt.work.tokenDelta}<span class="font-mono"> · {formatTokens(attempt.work.tokenDelta)} tok</span>{/if}
						</span>
					</div>
					<div class="ml-2.5 h-2 w-px bg-white/10"></div>
					<!-- submission -->
					<div class="flex items-center gap-2 text-[12px]">
						<span class="flex size-5 shrink-0 items-center justify-center rounded bg-emerald-500/10 text-emerald-300 ring-1 ring-inset ring-emerald-500/25"><Send size={11} /></span>
						{#if attempt.submission.kind === 'update_goal'}
							<span class="text-zinc-300">Submitted <code class="text-emerald-300/90">update_goal(complete)</code></span>
						{:else if attempt.submission.kind === 'idle_backstop'}
							<span class="text-zinc-300">Submitted via idle backstop</span>
						{:else}
							<span class="text-zinc-500">No submission yet</span>
						{/if}
					</div>
					<div class="ml-2.5 h-2 w-px bg-white/10"></div>
					<!-- evaluator verdict -->
					<div class="rounded-lg border p-2.5 {v.kind === 'pass' ? 'border-emerald-500/30 bg-emerald-500/[0.06]' : v.kind === 'reject' ? 'border-red-500/30 bg-red-500/[0.06]' : 'border-white/10 bg-white/[0.03]'}">
						<div class="flex items-center gap-2">
							<span class="flex size-5 shrink-0 items-center justify-center rounded bg-pink-500/10 text-pink-300 ring-1 ring-inset ring-pink-500/25"><ShieldCheck size={12} /></span>
							<span class="text-[11px] font-semibold uppercase tracking-wide text-zinc-400">Evaluator</span>
							{#if v.kind === 'pass'}
								<span class="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-0.5 text-[11px] font-semibold text-emerald-300"><Check size={12} /> PASS</span>
								<span class="text-[11px] text-zinc-400">
									{#if v.verifiedCount != null}{v.verifiedCount} evidence check{v.verifiedCount === 1 ? '' : 's'} verified{:else}completed (self-judged — no evidence){/if}
								</span>
							{:else if v.kind === 'reject'}
								<span class="inline-flex items-center gap-1 rounded-full bg-red-500/15 px-2 py-0.5 text-[11px] font-semibold text-red-300"><X size={12} /> REJECT</span>
								<span class="text-[11px] text-red-200/80">{v.failingCount} check{v.failingCount === 1 ? '' : 's'} failed</span>
								{#if v.checks.length}
									<button type="button" class="ml-auto inline-flex items-center gap-0.5 text-[11px] text-zinc-400 hover:text-zinc-200" onclick={(e) => { e.stopPropagation(); toggle(attempt.id); }}>
										{#if isExp}<ChevronDown size={12} />{:else}<ChevronRight size={12} />{/if} details
									</button>
								{/if}
							{:else}
								<span class="text-[11px] text-zinc-500">working… (no verdict yet)</span>
							{/if}
						</div>

						{#if v.kind === 'reject' && isExp && v.checks.length}
							<div class="mt-2 space-y-2">
								{#each [...v.checks].sort((a, b) => Number(a.ok) - Number(b.ok)) as chk (chk.command)}
									<div class="rounded-md border {chk.ok ? 'border-white/10 bg-white/[0.02]' : 'border-red-500/20 bg-red-500/[0.04]'} p-2">
										<div class="flex items-center gap-2 text-[11px]">
											{#if chk.ok}<Check size={11} class="text-emerald-400" />{:else}<X size={11} class="text-red-400" />{/if}
											<span class="font-mono text-zinc-500">exit {chk.exitCode}</span>
										</div>
										<code class="mt-1 block overflow-x-auto whitespace-pre-wrap break-words font-mono text-[10.5px] text-zinc-400">{chk.command}</code>
										{#if chk.output}
											<pre class="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded bg-black/40 p-1.5 font-mono text-[10.5px] leading-5 {chk.ok ? 'text-zinc-400' : 'text-red-200/90'}">{chk.output}</pre>
										{/if}
									</div>
								{/each}
							</div>
						{:else if v.kind === 'reject' && isExp && v.feedback}
							<pre class="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded bg-black/40 p-2 font-mono text-[10.5px] leading-5 text-red-200/90">{v.feedback}</pre>
						{/if}
					</div>
				</div>
			</div>
		{/each}
	</div>

	<!-- Outcome banner -->
	<div class="flex items-center gap-2 rounded-xl border {ss.border} {ss.bg} px-4 py-3">
		{#if goalFlow.outcome.verdict === 'pass'}
			<Check size={16} class="text-emerald-300" />
		{:else}
			<Wrench size={16} class={ss.text} />
		{/if}
		<span class="text-sm font-semibold {ss.text}">{goalFlow.outcome.label}</span>
		{#if goalFlow.completionSource}<span class="font-mono text-[11px] text-zinc-500">· {goalFlow.completionSource}</span>{/if}
	</div>
</div>
