<script lang="ts">
	import type { GoalFlow, ObservabilitySessionSummary } from '$lib/types/observability';
	import { formatDuration, formatTokens } from './span-kind';
	import { Clock, Layers, Sparkles, Wrench, CircleAlert, Database, Boxes, ShieldCheck } from '@lucide/svelte';

	interface Props {
		summary: ObservabilitySessionSummary;
		rootOperation?: string | null;
		rootService?: string | null;
		/** LLM-turn count (agentDecisions length). */
		llmTurns?: number;
		toolCalls?: number;
		goalFlow?: GoalFlow | null;
	}

	let { summary, rootOperation = null, rootService = null, llmTurns = 0, toolCalls = 0, goalFlow = null }: Props = $props();

	const goalChip = $derived.by(() => {
		if (!goalFlow) return null;
		const s = goalFlow.status;
		if (s === 'complete') return { text: 'text-emerald-300', bg: 'bg-emerald-500/10', border: 'border-emerald-500/30' };
		if (s === 'budget_limited') return { text: 'text-amber-300', bg: 'bg-amber-500/10', border: 'border-amber-500/30' };
		if (s === 'paused') return { text: 'text-zinc-300', bg: 'bg-white/5', border: 'border-white/15' };
		return { text: 'text-cyan-300', bg: 'bg-cyan-500/10', border: 'border-cyan-500/30' };
	});

	const hasError = $derived((summary.errorCount ?? 0) > 0);
	const cachePct = $derived.by(() => {
		const read = summary.cacheReadInputTokens ?? 0;
		const total = (summary.totalTokens ?? 0) + read;
		return total > 0 ? Math.round((read / total) * 100) : 0;
	});
</script>

<div class="border-b border-white/10 bg-[#0b0c0e] px-4 py-3">
	{#if rootOperation}
		<div class="mb-2.5 flex items-center gap-2">
			<span
				class="size-2 shrink-0 rounded-full {hasError
					? 'bg-red-400 shadow-[0_0_8px] shadow-red-500/50'
					: 'bg-emerald-400 shadow-[0_0_8px] shadow-emerald-500/40'}"
			></span>
			<h2 class="truncate font-mono text-sm font-semibold text-zinc-100">{rootOperation}</h2>
			{#if rootService}
				<span class="shrink-0 rounded border border-white/10 px-1.5 py-0.5 text-[10px] text-zinc-400">{rootService}</span>
			{/if}
			{#if goalFlow && goalChip}
				<span class="ml-auto inline-flex shrink-0 items-center gap-1 rounded-full border {goalChip.border} {goalChip.bg} px-2 py-0.5 text-[10px] font-medium {goalChip.text}">
					<ShieldCheck size={11} /> Goal: {goalFlow.outcome.label}
				</span>
			{/if}
		</div>
	{/if}

	<div class="flex flex-wrap items-stretch gap-2">
		<!-- Duration -->
		<div class="flex min-w-[88px] flex-col rounded-lg border border-white/10 bg-white/[0.03] px-3 py-1.5">
			<span class="flex items-center gap-1 text-[9px] uppercase tracking-wide text-zinc-500"><Clock size={10} /> Duration</span>
			<span class="mt-0.5 font-mono text-sm tabular-nums text-zinc-100">{formatDuration(summary.totalDurationMs)}</span>
		</div>

		<!-- Spans / services -->
		<div class="flex min-w-[88px] flex-col rounded-lg border border-white/10 bg-white/[0.03] px-3 py-1.5">
			<span class="flex items-center gap-1 text-[9px] uppercase tracking-wide text-zinc-500"><Layers size={10} /> Spans</span>
			<span class="mt-0.5 font-mono text-sm tabular-nums text-zinc-100">{summary.spanCount}<span class="ml-1 text-[10px] text-zinc-500">{summary.serviceCount} svc</span></span>
		</div>

		<!-- LLM turns + tokens -->
		<div class="flex min-w-[110px] flex-col rounded-lg border border-cyan-500/20 bg-cyan-500/[0.05] px-3 py-1.5">
			<span class="flex items-center gap-1 text-[9px] uppercase tracking-wide text-cyan-300/70"><Sparkles size={10} /> LLM</span>
			<span class="mt-0.5 font-mono text-sm tabular-nums text-cyan-100">
				{llmTurns}<span class="ml-1 text-[10px] text-cyan-300/70">turns</span>
				{#if summary.totalTokens}<span class="ml-1.5 text-[10px] text-cyan-300/70">{formatTokens(summary.totalTokens)} tok</span>{/if}
			</span>
		</div>

		<!-- Cache -->
		{#if (summary.cacheReadInputTokens ?? 0) > 0}
			<div class="flex min-w-[88px] flex-col rounded-lg border border-violet-500/20 bg-violet-500/[0.05] px-3 py-1.5">
				<span class="flex items-center gap-1 text-[9px] uppercase tracking-wide text-violet-300/70"><Database size={10} /> Cache</span>
				<span class="mt-0.5 font-mono text-sm tabular-nums text-violet-100">{cachePct}%<span class="ml-1 text-[10px] text-violet-300/70">{formatTokens(summary.cacheReadInputTokens)} read</span></span>
			</div>
		{/if}

		<!-- Tools -->
		<div class="flex min-w-[80px] flex-col rounded-lg border border-emerald-500/20 bg-emerald-500/[0.05] px-3 py-1.5">
			<span class="flex items-center gap-1 text-[9px] uppercase tracking-wide text-emerald-300/70"><Wrench size={10} /> Tools</span>
			<span class="mt-0.5 font-mono text-sm tabular-nums text-emerald-100">{toolCalls}</span>
		</div>

		<!-- Errors -->
		<div class="flex min-w-[80px] flex-col rounded-lg border px-3 py-1.5 {hasError ? 'border-red-500/30 bg-red-500/[0.07]' : 'border-white/10 bg-white/[0.03]'}">
			<span class="flex items-center gap-1 text-[9px] uppercase tracking-wide {hasError ? 'text-red-300/80' : 'text-zinc-500'}"><CircleAlert size={10} /> Errors</span>
			<span class="mt-0.5 font-mono text-sm tabular-nums {hasError ? 'text-red-200' : 'text-zinc-100'}">{summary.errorCount ?? 0}</span>
		</div>

		<!-- Reasoning (if any) -->
		{#if (summary.reasoningTokens ?? 0) > 0}
			<div class="flex min-w-[88px] flex-col rounded-lg border border-white/10 bg-white/[0.03] px-3 py-1.5">
				<span class="flex items-center gap-1 text-[9px] uppercase tracking-wide text-zinc-500"><Boxes size={10} /> Reasoning</span>
				<span class="mt-0.5 font-mono text-sm tabular-nums text-zinc-100">{formatTokens(summary.reasoningTokens)}</span>
			</div>
		{/if}
	</div>
</div>
