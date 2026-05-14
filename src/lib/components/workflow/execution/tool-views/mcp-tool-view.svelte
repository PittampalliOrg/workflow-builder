<script lang="ts">
	import { ToolCall, ToolCallHeader, ToolCallContent, ToolCallResult } from '$lib/components/ui/ai-elements/tool-call';
	import Plug from '@lucide/svelte/icons/plug';
	import {
		parseMcpToolName,
		renderArgsSummary,
		firstLine,
		formatOutputForDisplay,
		summarizeCollapsedOutput
	} from './tool-utils';
	import type { ToolViewProps } from './index';

	let { phase, toolName, args, output = '', success = true, error = '', state: stateOverride, variant = 'card' }: ToolViewProps = $props();

	let mcpParts = $derived(parseMcpToolName(toolName));
	let displayName = $derived(
		mcpParts.server ? `${mcpParts.server}: ${mcpParts.action}` : mcpParts.action || toolName
	);

	let argsSummary = $derived(args ? renderArgsSummary(args) : '');

	let toolState = $derived(stateOverride ?? (phase === 'start' ? 'running' as const : (success ? 'completed' as const : 'error' as const)));
	let formattedOutput = $derived(formatOutputForDisplay(output));
	let preview = $derived(summarizeCollapsedOutput(output));
	let isTruncated = $derived(preview.remainingLines > 0);

	let label = $derived.by(() => {
		if (phase === 'start') {
			return argsSummary || displayName;
		}
		if (!output) return '(No content)';
		return firstLine(formattedOutput) || '(No content)';
	});

	let isOpen = $state(phase === 'end' && !!output && !isTruncated);
</script>

{#snippet paramsBlock()}
	{#if args && Object.keys(args).length > 0}
		<div class="space-y-2">
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
	{/if}
{/snippet}

{#snippet cardBody()}
	{#if phase === 'start'}
		<div class="p-3">
			{@render paramsBlock()}
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
{/snippet}

{#if variant === 'panel'}
	<div class="space-y-3">
		<div>
			<div class="text-[10px] uppercase tracking-wider text-muted-foreground">MCP tool</div>
			<code class="mt-1 inline-block text-xs font-mono">{displayName}</code>
		</div>
		{@render paramsBlock()}
		{#if phase === 'end'}
			<div>
				<div class="text-[10px] uppercase tracking-wider text-muted-foreground">Result</div>
				{#if error}
					<pre class="mt-1 max-h-[30vh] overflow-auto whitespace-pre-wrap break-all rounded border border-red-500/20 bg-red-950/20 p-3 font-mono text-red-400">{error}</pre>
				{:else if output}
					<pre class="mt-1 max-h-[40vh] overflow-auto whitespace-pre-wrap break-all rounded bg-[#0d1117] p-3 font-mono text-zinc-300 leading-relaxed">{formattedOutput}</pre>
				{:else}
					<div class="mt-1 text-[12px] text-muted-foreground italic">(no content)</div>
				{/if}
			</div>
		{/if}
	</div>
{:else}
	<ToolCall bind:open={isOpen}>
		<ToolCallHeader toolName={displayName} {label} state={toolState} icon={Plug} iconClass="text-purple-500/80" />
		<ToolCallContent>
			{@render cardBody()}
		</ToolCallContent>
		{#if !isOpen && phase === 'end' && output && isTruncated}
			<div class="border-t px-3 py-2">
				<pre class="whitespace-pre-wrap break-all text-[12px] font-mono text-muted-foreground leading-relaxed">{preview.text}</pre>
				<p class="mt-1 text-[11px] text-muted-foreground/60">… +{preview.remainingLines} lines</p>
			</div>
		{/if}
	</ToolCall>
{/if}
