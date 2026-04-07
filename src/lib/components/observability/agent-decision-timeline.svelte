<script lang="ts">
	import { Badge } from '$lib/components/ui/badge';
	import type { ObservabilityAgentDecisionTurn } from '$lib/types/observability';
	import { Bot, Clock3, StopCircle, TriangleAlert, Wrench } from 'lucide-svelte';

	interface Props {
		decisions: ObservabilityAgentDecisionTurn[];
		selectedDecisionId?: string | null;
		onSelectDecision?: (decision: ObservabilityAgentDecisionTurn) => void;
	}

	let {
		decisions,
		selectedDecisionId = null,
		onSelectDecision = () => {}
	}: Props = $props();

	function tone(decisionType: ObservabilityAgentDecisionTurn['decisionType']): string {
		if (decisionType === 'tool_call') return 'border-emerald-500/20 bg-emerald-500/[0.08] text-emerald-100';
		if (decisionType === 'stop') return 'border-cyan-500/20 bg-cyan-500/[0.08] text-cyan-100';
		if (decisionType === 'wait_or_approval') return 'border-amber-500/20 bg-amber-500/[0.08] text-amber-100';
		if (decisionType === 'error') return 'border-red-500/20 bg-red-500/[0.08] text-red-100';
		return 'border-white/10 bg-white/[0.04] text-zinc-100';
	}

	function icon(decisionType: ObservabilityAgentDecisionTurn['decisionType']) {
		if (decisionType === 'tool_call') return Wrench;
		if (decisionType === 'stop') return StopCircle;
		if (decisionType === 'wait_or_approval') return Clock3;
		if (decisionType === 'error') return TriangleAlert;
		return Bot;
	}

	function formatDuration(value: number | null): string {
		if (value == null) return 'n/a';
		if (value < 1000) return `${Math.round(value)}ms`;
		return `${(value / 1000).toFixed(2)}s`;
	}
</script>

<div class="grid gap-3 lg:grid-cols-2 xl:grid-cols-1 2xl:grid-cols-2">
	{#each decisions as decision (decision.id)}
		{@const Icon = icon(decision.decisionType)}
		<button
			class={`group rounded-2xl border p-3 text-left transition-all hover:-translate-y-px hover:border-white/20 hover:bg-white/[0.06] ${
				selectedDecisionId === decision.id
					? 'border-cyan-400/35 bg-cyan-500/[0.08] shadow-[0_10px_26px_rgba(34,211,238,0.12)]'
					: 'border-white/10 bg-black/20'
			}`}
			onclick={() => onSelectDecision(decision)}
		>
			<div class="flex items-start justify-between gap-3">
				<div class="min-w-0">
					<div class="flex flex-wrap items-center gap-2">
						<Badge variant="outline" class={`text-[10px] ${tone(decision.decisionType)}`}>
							<Icon size={11} class="mr-1 inline" />
							{decision.decisionType.replaceAll('_', ' ')}
						</Badge>
						<Badge variant="outline" class="border-white/10 bg-white/5 font-mono text-[10px] text-zinc-300">
							Turn {decision.turnIndex}
						</Badge>
						{#if decision.totalTokens != null}
							<Badge variant="outline" class="border-white/10 bg-white/5 font-mono text-[10px] text-zinc-300">
								{decision.totalTokens} tokens
							</Badge>
						{/if}
					</div>
					<p class="mt-3 text-sm font-medium text-zinc-100">{decision.decisionLabel}</p>
					<p class="mt-1 text-xs text-zinc-400">
						{[decision.provider, decision.modelName].filter(Boolean).join('/')}
					</p>
				</div>
				<div class="text-right">
					<p class="font-mono text-[11px] text-zinc-300">{formatDuration(decision.durationMs)}</p>
					<p class="mt-1 text-[11px] text-zinc-500">{new Date(decision.startedAt).toLocaleTimeString()}</p>
				</div>
			</div>

			{#if decision.inputSummary}
				<div class="mt-3 rounded-xl border border-white/8 bg-white/[0.03] px-3 py-2">
					<p class="text-[10px] uppercase tracking-[0.18em] text-zinc-500">Input</p>
					<p class="mt-1 line-clamp-3 text-[12px] leading-5 text-zinc-300">{decision.inputSummary}</p>
				</div>
			{/if}

			{#if decision.outputSummary}
				<div class="mt-2 rounded-xl border border-white/8 bg-white/[0.03] px-3 py-2">
					<p class="text-[10px] uppercase tracking-[0.18em] text-zinc-500">Output</p>
					<p class="mt-1 line-clamp-3 text-[12px] leading-5 text-zinc-200">{decision.outputSummary}</p>
				</div>
			{/if}

			<div class="mt-3 flex flex-wrap gap-2 text-[11px] text-zinc-400">
				{#if decision.toolCalls.length > 0}
					<span>{decision.toolCalls.length} tool call{decision.toolCalls.length === 1 ? '' : 's'}</span>
				{/if}
				{#if decision.toolResults.length > 0}
					<span>{decision.toolResults.length} tool result{decision.toolResults.length === 1 ? '' : 's'}</span>
				{/if}
				{#if decision.stopReason}
					<span>stop: {decision.stopReason}</span>
				{/if}
			</div>
		</button>
	{/each}
</div>
