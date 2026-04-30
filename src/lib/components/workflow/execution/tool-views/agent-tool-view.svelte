<script lang="ts">
	import { ToolCall, ToolCallHeader, ToolCallContent, ToolCallResult } from '$lib/components/ui/ai-elements/tool-call';
	import { cn } from '$lib/components/ui/utils';
	import Bot from '@lucide/svelte/icons/bot';
	import { getAgentColor, truncateSummary, firstLine } from './tool-utils';

	interface Props {
		phase: 'start' | 'end';
		toolName: string;
		args?: Record<string, unknown>;
		output?: string;
		success?: boolean;
		error?: string;
		state?: 'running' | 'completed' | 'error' | 'pending';
	}

	let { phase, toolName, args, output = '', success = true, error = '', state: stateOverride }: Props = $props();

	/**
	 * Agent type resolution — ported from AgentTool/UI.tsx userFacingName:
	 * Returns subagent_type if not 'general-purpose'/'worker', else 'Agent'
	 */
	let agentType = $derived.by(() => {
		const t = (args?.subagent_type as string) ?? (args?.type as string) ?? (args?.agent_name as string) ?? '';
		if (t && t !== 'general-purpose' && t !== 'worker') return t;
		return 'Agent';
	});

	let description = $derived((args?.description as string) ?? '');
	let prompt = $derived((args?.prompt as string) ?? '');

	/**
	 * Color assignment — ported from AgentTool/agentColorManager.ts
	 * Deterministic hash-based color per agent type name.
	 */
	let colorSet = $derived(getAgentColor(agentType));
	let iconClass = $derived(colorSet?.text ?? 'text-blue-400');

	let state = $derived(stateOverride ?? (phase === 'start' ? 'running' as const : (success ? 'completed' as const : 'error' as const)));

	/**
	 * Label logic ported from AgentTool/UI.tsx:
	 * - renderToolUseMessage: description string
	 * - Result: first line of output or "Agent completed"
	 */
	let label = $derived.by(() => {
		if (phase === 'start') {
			return description ? truncateSummary(description, 80) : (prompt ? truncateSummary(prompt, 80) : agentType);
		}
		return firstLine(output) || 'Agent completed';
	});
</script>

<ToolCall class={cn(colorSet && `${colorSet.bg} ${colorSet.border} border`)}>
	<ToolCallHeader
		toolName={agentType}
		{label}
		{state}
		icon={Bot}
		{iconClass}
		nameBadgeClass={colorSet?.name}
	/>
	<ToolCallContent>
		{#if phase === 'start'}
			<div class="space-y-2 p-3">
				{#if description}
					<p class="text-[13px] text-foreground">{description}</p>
				{/if}
				{#if prompt}
					<h4 class="text-muted-foreground text-[10px] font-medium tracking-wider uppercase">Prompt</h4>
					<pre class="max-h-[20vh] overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted/50 p-3 text-[12px] font-mono ring-1 ring-border/50">{prompt}</pre>
				{/if}
			</div>
		{:else if phase === 'end'}
			{#if error}
				<ToolCallResult error>
					<pre class="max-h-[30vh] overflow-auto whitespace-pre-wrap break-all p-3 font-mono">{error}</pre>
				</ToolCallResult>
			{:else if output}
				<ToolCallResult>
					<pre class="max-h-[40vh] overflow-auto whitespace-pre-wrap break-all bg-[#0d1117] p-3 font-mono text-zinc-300 leading-relaxed">{output}</pre>
				</ToolCallResult>
			{/if}
		{/if}
	</ToolCallContent>
</ToolCall>
