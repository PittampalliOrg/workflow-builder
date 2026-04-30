<script lang="ts">
	/**
	 * Sequential vertical list of agent turns for the left rail.
	 * Primary navigation for "which LLM turn am I looking at?"
	 */
	import { getContext } from 'svelte';
	import type { ObservabilitySelectionStore } from '$lib/stores/observability-selection.svelte';
	import type { ObservabilityAgentDecisionTurn } from '$lib/types/observability';
	import { Bot, Wrench, StopCircle, Clock3, AlertTriangle, MessageSquare } from '@lucide/svelte';

	interface Props {
		decisions: ObservabilityAgentDecisionTurn[];
	}

	let { decisions }: Props = $props();

	const store = getContext<ObservabilitySelectionStore>('observability-selection');

	const activeDecisionId = $derived(store.selectedDecisionId);
	const activeHoveredId = $derived(store.hoveredDecisionId);

	function formatDuration(ms: number | null): string {
		if (ms == null || !Number.isFinite(ms)) return '';
		if (ms < 1000) return `${Math.round(ms)}ms`;
		return `${(ms / 1000).toFixed(1)}s`;
	}

	function decisionIcon(type: string) {
		switch (type) {
			case 'tool_call': return Wrench;
			case 'stop': return StopCircle;
			case 'wait_or_approval': return Clock3;
			case 'error': return AlertTriangle;
			case 'assistant_message': return MessageSquare;
			default: return Bot;
		}
	}

	function decisionBorderColor(type: string): string {
		switch (type) {
			case 'tool_call': return 'border-l-emerald-500';
			case 'stop': return 'border-l-blue-500';
			case 'wait_or_approval': return 'border-l-amber-500';
			case 'error': return 'border-l-red-500';
			case 'assistant_message': return 'border-l-cyan-500';
			default: return 'border-l-zinc-600';
		}
	}

	function decisionBgColor(type: string): string {
		switch (type) {
			case 'tool_call': return 'bg-emerald-500/10';
			case 'stop': return 'bg-blue-500/10';
			case 'error': return 'bg-red-500/10';
			default: return 'bg-zinc-800/50';
		}
	}

	function truncateLabel(label: string, max: number = 60): string {
		if (label.length <= max) return label;
		return label.slice(0, max) + '...';
	}
</script>

<div class="flex flex-col">
	<div class="px-3 py-2 text-xs font-semibold text-zinc-400 uppercase tracking-wider">
		Agent Turns
		{#if decisions.length > 0}
			<span class="text-zinc-600 ml-1">({decisions.length})</span>
		{/if}
	</div>

	{#if decisions.length === 0}
		<div class="px-3 py-4 text-xs text-zinc-600 italic">No agent turns detected</div>
	{:else}
		<div class="flex flex-col gap-0.5 px-1">
			{#each decisions as decision (decision.id)}
				{@const isSelected = activeDecisionId === decision.id}
				{@const isHovered = activeHoveredId === decision.id}
				{@const Icon = decisionIcon(decision.decisionType)}

				<button
					class="w-full text-left px-2 py-1.5 rounded-md border-l-2 transition-all duration-150
						{decisionBorderColor(decision.decisionType)}
						{isSelected ? decisionBgColor(decision.decisionType) + ' ring-1 ring-zinc-600' : 'hover:bg-zinc-800/40'}
						{isHovered && !isSelected ? 'bg-zinc-800/30' : ''}"
					onclick={() => store.selectDecision(decision.id)}
					onmouseenter={() => store.hoverDecision(decision.id)}
					onmouseleave={() => store.hoverDecision(null)}
				>
					<div class="flex items-center gap-1.5">
						<span class="text-[10px] font-mono text-zinc-500 w-4 text-right flex-none">
							{decision.turnIndex}
						</span>
						<Icon class="w-3 h-3 text-zinc-400 flex-none" />
						<span class="text-xs text-zinc-300 truncate flex-1">
							{truncateLabel(decision.decisionLabel)}
						</span>
						{#if decision.durationMs}
							<span class="text-[10px] text-zinc-600 flex-none">
								{formatDuration(decision.durationMs)}
							</span>
						{/if}
					</div>

					{#if decision.toolCalls.length > 0}
						<div class="ml-5 mt-0.5 flex flex-wrap gap-1">
							{#each decision.toolCalls as tc}
								<span class="text-[10px] px-1 py-0 rounded bg-emerald-500/10 text-emerald-400">
									{tc.name}
								</span>
							{/each}
						</div>
					{/if}

					{#if decision.totalTokens}
						<div class="ml-5 mt-0.5 text-[10px] text-zinc-600">
							{decision.totalTokens} tokens
							{#if decision.modelName}
								&middot; {decision.modelName.replace('anthropic/', '').replace('claude-', 'c-')}
							{/if}
						</div>
					{/if}
				</button>
			{/each}
		</div>
	{/if}
</div>
