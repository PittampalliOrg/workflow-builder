<script lang="ts">
	/**
	 * Chat-style conversation view showing the full agent loop.
	 *
	 * Renders LLM turns as message bubbles with inline tool calls/results.
	 * Designed for the right panel's "Conversation" tab.
	 */
	import { getContext } from 'svelte';
	import type { ObservabilitySelectionStore } from '$lib/stores/observability-selection.svelte';
	import type {
		ObservabilityAgentDecisionTurn,
		ObservabilityLlmSpan,
		ObservabilityLlmMessage
	} from '$lib/types/observability';
	import { Bot, User, Wrench, ChevronDown, ChevronRight, Terminal } from 'lucide-svelte';

	interface Props {
		decisions: ObservabilityAgentDecisionTurn[];
		llmSpans: ObservabilityLlmSpan[];
	}

	let { decisions, llmSpans }: Props = $props();

	const store = getContext<ObservabilitySelectionStore>('observability-selection');
	const activeDecisionId = $derived(store.selectedDecisionId);

	let expandedTools = $state<Set<string>>(new Set());
	const turnElements = new Map<string, HTMLElement>();
	const toolElements = new Map<string, HTMLElement>();

	function trackTurn(el: HTMLElement, id: string) {
		turnElements.set(id, el);
		return { destroy() { turnElements.delete(id); } };
	}

	function trackTool(el: HTMLElement, key: string) {
		toolElements.set(key, el);
		return { destroy() { toolElements.delete(key); } };
	}

	// Scroll to selected turn when it changes (e.g. clicked from left rail)
	$effect(() => {
		const id = activeDecisionId;
		if (!id) return;
		// Use a tick to let the DOM update first
		requestAnimationFrame(() => {
			const el = turnElements.get(id);
			if (el) el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
		});
	});

	function toggleToolExpanded(id: string) {
		const next = new Set(expandedTools);
		if (next.has(id)) next.delete(id);
		else next.add(id);
		expandedTools = next;

		// Scroll the tool detail into view after expanding
		if (next.has(id)) {
			requestAnimationFrame(() => {
				// Wait for the DOM to render the expanded content
				requestAnimationFrame(() => {
					const el = toolElements.get(id);
					if (el) el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
				});
			});
		}
	}

	function getLlmSpanForDecision(decision: ObservabilityAgentDecisionTurn): ObservabilityLlmSpan | null {
		return llmSpans.find(
			(l) => l.traceId === decision.evidence.traceId && l.spanId === decision.evidence.spanId
		) ?? null;
	}

	function roleTone(role: string): string {
		if (role === 'assistant') return 'border-cyan-500/30 bg-cyan-500/5';
		if (role === 'system') return 'border-orange-500/30 bg-orange-500/5';
		if (role === 'tool') return 'border-emerald-500/30 bg-emerald-500/5';
		return 'border-zinc-600/30 bg-zinc-800/30';
	}

	function roleIcon(role: string) {
		if (role === 'assistant') return Bot;
		if (role === 'tool') return Terminal;
		return User;
	}

	function roleLabel(role: string): string {
		if (role === 'assistant') return 'Assistant';
		if (role === 'system') return 'System';
		if (role === 'tool') return 'Tool';
		return 'User';
	}

	function roleTextColor(role: string): string {
		if (role === 'assistant') return 'text-cyan-400';
		if (role === 'system') return 'text-orange-400';
		if (role === 'tool') return 'text-emerald-400';
		return 'text-zinc-300';
	}

	function formatDuration(ms: number | null): string {
		if (ms == null || !Number.isFinite(ms)) return '';
		if (ms < 1000) return `${Math.round(ms)}ms`;
		return `${(ms / 1000).toFixed(1)}s`;
	}

	function formatJson(value: unknown): string {
		if (typeof value === 'string') {
			try { return JSON.stringify(JSON.parse(value), null, 2); }
			catch { return value; }
		}
		return JSON.stringify(value, null, 2);
	}

	function summarizeToolCall(name: string, args: string | null): string {
		if (!args) return `${name}()`;
		try {
			const parsed = JSON.parse(args);
			const keys = Object.keys(parsed);
			if (keys.length === 0) return `${name}()`;
			const preview = keys.slice(0, 3).map((k) => `${k}: ${JSON.stringify(parsed[k]).slice(0, 40)}`).join(', ');
			return `${name}(${preview}${keys.length > 3 ? ', ...' : ''})`;
		} catch {
			return `${name}(${args.slice(0, 60)})`;
		}
	}
</script>

<div class="flex flex-col gap-3 p-3">
	{#each decisions as decision, idx (decision.id)}
		{@const isSelected = activeDecisionId === decision.id}
		{@const llmSpan = getLlmSpanForDecision(decision)}

		<!-- Turn header -->
		<button
			class="w-full text-left"
			use:trackTurn={decision.id}
			onclick={() => store.selectDecision(decision.id)}
		>
			<div
				class="rounded-lg border p-3 transition-all duration-150
					{isSelected ? 'ring-1 ring-orange-500/50 border-orange-500/30 bg-orange-500/5' : 'border-zinc-800 hover:border-zinc-700'}"
			>
				<!-- Turn label -->
				<div class="flex items-center gap-2 mb-2">
					<span class="text-[10px] font-mono px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-400">
						Turn {decision.turnIndex}
					</span>
					<span class="text-xs text-zinc-500">{formatDuration(decision.durationMs)}</span>
					{#if decision.totalTokens}
						<span class="text-[10px] text-zinc-600">{decision.totalTokens} tokens</span>
					{/if}
					{#if decision.modelName}
						<span class="text-[10px] text-zinc-600 ml-auto">
							{decision.modelName.replace('anthropic/', '')}
						</span>
					{/if}
				</div>

				<!-- Input: show only the first user message (skip tool_result context) -->
				{#if llmSpan?.inputMessages?.length}
					{@const userMsg = llmSpan.inputMessages.find((m) => m.role === 'user' && typeof m.content === 'string' && m.content.trim())}
					{#if userMsg}
						<div class="rounded-md border p-2 mb-2 {roleTone('user')}">
							<div class="flex items-center gap-1.5 mb-1">
								<User class="w-3 h-3 text-zinc-300" />
								<span class="text-[10px] font-semibold uppercase text-zinc-400">User</span>
								{#if llmSpan.inputMessages.length > 1}
									<span class="text-[10px] text-zinc-600">+{llmSpan.inputMessages.length - 1} context msgs</span>
								{/if}
							</div>
							<div class="text-xs text-zinc-300 whitespace-pre-wrap break-words max-h-40 overflow-y-auto">
								{userMsg.content && userMsg.content.length > 500 ? userMsg.content.slice(0, 500) + '...' : userMsg.content}
							</div>
						</div>
					{/if}
				{:else if decision.inputSummary}
					<div class="rounded-md border p-2 mb-2 border-zinc-700 bg-zinc-800/30">
						<div class="text-xs text-zinc-400 whitespace-pre-wrap break-words line-clamp-3">
							{decision.inputSummary}
						</div>
					</div>
				{/if}

				<!-- Output message (LLM response) -->
				{#if llmSpan?.outputMessages?.length}
					{#each llmSpan.outputMessages as msg}
						{#if msg.content?.trim() || msg.toolCalls?.length}
							<div class="rounded-md border p-2 mb-2 {roleTone('assistant')}">
								<div class="flex items-center gap-1.5 mb-1">
									<Bot class="w-3 h-3 text-cyan-400" />
									<span class="text-[10px] font-semibold uppercase text-cyan-400">Assistant</span>
								</div>
								{#if msg.content?.trim()}
									<div class="text-xs text-zinc-300 whitespace-pre-wrap break-words max-h-60 overflow-y-auto">
										{msg.content}
									</div>
								{/if}
								{#if msg.toolCalls?.length}
									<div class="mt-1 flex flex-wrap gap-1">
										{#each msg.toolCalls as tc}
											<span class="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-400 font-mono">
												{tc.function?.name ?? tc.id}
											</span>
										{/each}
									</div>
								{/if}
							</div>
						{/if}
					{/each}
				{:else if decision.outputSummary}
					<div class="rounded-md border p-2 mb-2 border-cyan-500/20 bg-cyan-500/5">
						<div class="flex items-center gap-1.5 mb-1">
							<Bot class="w-3 h-3 text-cyan-400" />
							<span class="text-[10px] font-semibold uppercase text-cyan-400">Assistant</span>
						</div>
						<div class="text-xs text-zinc-400 whitespace-pre-wrap break-words line-clamp-3">
							{decision.outputSummary}
						</div>
					</div>
				{/if}

				<!-- Tool calls -->
				{#if decision.toolCalls.length > 0}
					<div class="flex flex-col gap-1.5 mt-2">
						{#each decision.toolCalls as tc, tcIdx}
							{@const toolKey = `${decision.id}:${tcIdx}`}
							{@const isExpanded = expandedTools.has(toolKey)}
							{@const matchingResult = decision.toolResults.find((r) => r.toolName === tc.name)}

							<div
								class="rounded-md border border-emerald-500/20 bg-emerald-500/5"
								use:trackTool={toolKey}
							>
								<button
									class="w-full flex items-center gap-1.5 px-2 py-1.5 text-left"
									onclick={(e) => { e.stopPropagation(); toggleToolExpanded(toolKey); }}
								>
									{#if isExpanded}
										<ChevronDown class="w-3 h-3 text-emerald-400 flex-none" />
									{:else}
										<ChevronRight class="w-3 h-3 text-emerald-400 flex-none" />
									{/if}
									<Wrench class="w-3 h-3 text-emerald-400 flex-none" />
									<span class="text-xs text-emerald-300 font-mono truncate">
										{summarizeToolCall(tc.name, tc.arguments)}
									</span>
									{#if matchingResult}
										<span class="text-[10px] ml-auto flex-none
											{matchingResult.statusCode === 'error' ? 'text-red-400' : 'text-zinc-500'}">
											{matchingResult.statusCode === 'error' ? 'error' : 'ok'}
										</span>
									{/if}
								</button>

								{#if isExpanded}
									<div class="border-t border-emerald-500/10 px-2 py-1.5">
										{#if tc.arguments}
											<div class="mb-1">
												<div class="text-[10px] text-zinc-500 uppercase mb-0.5">Arguments</div>
												<pre class="text-[11px] text-zinc-400 bg-zinc-900/50 rounded p-1.5 overflow-x-auto max-h-40 overflow-y-auto">{formatJson(tc.arguments)}</pre>
											</div>
										{/if}
										{#if matchingResult?.result != null}
											<div>
												<div class="text-[10px] text-zinc-500 uppercase mb-0.5">Result</div>
												<pre class="text-[11px] text-zinc-400 bg-zinc-900/50 rounded p-1.5 overflow-x-auto max-h-40 overflow-y-auto">{formatJson(matchingResult.result)}</pre>
											</div>
										{/if}
									</div>
								{/if}
							</div>
						{/each}
					</div>
				{/if}

				<!-- Stop reason -->
				{#if decision.stopReason}
					<div class="mt-2 text-[10px] text-blue-400 italic">
						Stop: {decision.stopReason}
					</div>
				{/if}
			</div>
		</button>
	{/each}

	{#if decisions.length === 0}
		<div class="text-center text-sm text-zinc-600 py-8">
			No agent conversation turns found
		</div>
	{/if}
</div>
