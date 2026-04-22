<script lang="ts">
	import { ToolCall, ToolCallHeader, ToolCallContent, ToolCallResult } from '$lib/components/ui/ai-elements/tool-call';
	import Wrench from 'lucide-svelte/icons/wrench';
	import { renderArgsSummary, firstLine, formatOutputForDisplay, summarizeCollapsedOutput } from './tool-utils';

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

	let toolState = $derived(stateOverride ?? (phase === 'start' ? 'running' as const : (success ? 'completed' as const : 'error' as const)));
	let formattedOutput = $derived(formatOutputForDisplay(output));
	let preview = $derived(summarizeCollapsedOutput(output));
	let isTruncated = $derived(preview.remainingLines > 0);

	/**
	 * Label logic upgraded to show arg VALUES not just key names.
	 * Uses MCPTool-style "key: value, key: value" rendering from claude-code-src.
	 */
	let label = $derived.by(() => {
		if (phase === 'start' && args && Object.keys(args).length > 0) {
			const summary = renderArgsSummary(args);
			return summary || toolName;
		}
		if (phase === 'start') return toolName;
		return firstLine(formattedOutput) || '(no output)';
	});

	let isOpen = $state(phase === 'end' && !!output && !isTruncated);
</script>

<ToolCall bind:open={isOpen}>
	<ToolCallHeader {toolName} {label} state={toolState} icon={Wrench} iconClass="text-orange-500/80" />
	<ToolCallContent>
		{#if phase === 'start' && args && Object.keys(args).length > 0}
			<div class="space-y-2 p-3">
				<h4 class="text-muted-foreground text-[10px] font-medium tracking-wider uppercase">Parameters</h4>
				{#if Object.keys(args).length <= 5}
					<dl class="space-y-1">
						{#each Object.entries(args) as [key, value]}
							<div class="flex gap-2 text-[12px]">
								<dt class="text-muted-foreground font-medium shrink-0">{key}:</dt>
								<dd class="text-foreground font-mono break-all">{typeof value === 'string' ? value : JSON.stringify(value)}</dd>
							</div>
						{/each}
					</dl>
				{:else}
					<pre class="max-h-[30vh] overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted/50 p-3 text-[12px] font-mono ring-1 ring-border/50">{JSON.stringify(args, null, 2)}</pre>
				{/if}
			</div>
		{:else if phase === 'end'}
			{#if error}
				<ToolCallResult error>
					<pre class="max-h-[30vh] overflow-auto whitespace-pre-wrap break-all p-3 font-mono">{error}</pre>
				</ToolCallResult>
			{:else if output}
				<ToolCallResult>
					<pre class="max-h-[40vh] overflow-auto whitespace-pre-wrap break-all bg-[#0d1117] p-3 font-mono text-zinc-300 leading-relaxed">{formattedOutput}</pre>
				</ToolCallResult>
			{/if}
		{/if}
	</ToolCallContent>
	{#if !isOpen && phase === 'end' && output && isTruncated}
		<div class="border-t px-3 py-2">
			<pre class="whitespace-pre-wrap break-all text-[12px] font-mono text-muted-foreground leading-relaxed">{preview.text}</pre>
			<p class="mt-1 text-[11px] text-muted-foreground/60">… +{preview.remainingLines} lines</p>
		</div>
	{/if}
</ToolCall>
