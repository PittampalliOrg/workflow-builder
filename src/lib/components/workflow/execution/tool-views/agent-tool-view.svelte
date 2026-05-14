<script lang="ts">
	import { ToolCall, ToolCallHeader, ToolCallContent, ToolCallResult } from '$lib/components/ui/ai-elements/tool-call';
	import { cn } from '$lib/components/ui/utils';
	import Bot from '@lucide/svelte/icons/bot';
	import { getAgentColor, truncateSummary, firstLine } from './tool-utils';
	import type { ToolViewProps } from './index';

	let { phase, toolName, args, output = '', success = true, error = '', state: stateOverride, variant = 'card' }: ToolViewProps = $props();

	let agentType = $derived.by(() => {
		const t = (args?.subagent_type as string) ?? (args?.type as string) ?? (args?.agent_name as string) ?? '';
		if (t && t !== 'general-purpose' && t !== 'worker') return t;
		return 'Agent';
	});

	let description = $derived((args?.description as string) ?? '');
	let prompt = $derived((args?.prompt as string) ?? '');

	let colorSet = $derived(getAgentColor(agentType));
	let iconClass = $derived(colorSet?.text ?? 'text-blue-400');

	let state = $derived(stateOverride ?? (phase === 'start' ? 'running' as const : (success ? 'completed' as const : 'error' as const)));

	let label = $derived.by(() => {
		if (phase === 'start') {
			return description ? truncateSummary(description, 80) : (prompt ? truncateSummary(prompt, 80) : agentType);
		}
		return firstLine(output) || 'Agent completed';
	});
</script>

{#snippet inputBlock()}
	{#if description || prompt}
		<div class="space-y-2">
			{#if description}
				<p class="text-[13px] text-foreground">{description}</p>
			{/if}
			{#if prompt}
				<h4 class="text-muted-foreground text-[10px] font-medium tracking-wider uppercase">Prompt</h4>
				<pre class="max-h-[20vh] overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted/50 p-3 text-[12px] font-mono ring-1 ring-border/50">{prompt}</pre>
			{/if}
		</div>
	{/if}
{/snippet}

{#snippet cardBody()}
	{#if phase === 'start'}
		<div class="p-3">{@render inputBlock()}</div>
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
{/snippet}

{#if variant === 'panel'}
	<div class="space-y-3">
		<div>
			<div class="text-[10px] uppercase tracking-wider text-muted-foreground">Agent</div>
			<span class={cn('mt-1 inline-block rounded px-1.5 py-0.5 text-[11px] font-semibold', colorSet?.name)}>{agentType}</span>
		</div>
		{@render inputBlock()}
		{#if phase === 'end'}
			<div>
				<div class="text-[10px] uppercase tracking-wider text-muted-foreground">Result</div>
				{#if error}
					<pre class="mt-1 max-h-[30vh] overflow-auto whitespace-pre-wrap break-all rounded border border-red-500/20 bg-red-950/20 p-3 font-mono text-red-400">{error}</pre>
				{:else if output}
					<pre class="mt-1 max-h-[40vh] overflow-auto whitespace-pre-wrap break-all rounded bg-[#0d1117] p-3 font-mono text-zinc-300 leading-relaxed">{output}</pre>
				{:else}
					<div class="mt-1 text-[12px] text-muted-foreground italic">Agent completed</div>
				{/if}
			</div>
		{/if}
	</div>
{:else}
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
			{@render cardBody()}
		</ToolCallContent>
	</ToolCall>
{/if}
