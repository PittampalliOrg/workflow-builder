<script lang="ts">
	import { ToolCall, ToolCallHeader, ToolCallContent, ToolCallResult } from '$lib/components/ui/ai-elements/tool-call';
	import Download from '@lucide/svelte/icons/download';
	import { truncateSummary, formatFileSize } from './tool-utils';
	import type { ToolViewProps } from './index';

	let { phase, toolName, args, output = '', success = true, error = '', state: stateOverride, variant = 'card' }: ToolViewProps = $props();

	let url = $derived((args?.url as string) ?? '');
	let prompt = $derived((args?.prompt as string) ?? '');

	let hostname = $derived.by(() => {
		if (!url) return '';
		try {
			return new URL(url).hostname;
		} catch {
			return truncateSummary(url, 60);
		}
	});

	let resultSummary = $derived.by(() => {
		if (!output) return null;
		try {
			const parsed = JSON.parse(output);
			if (parsed.bytes !== undefined) {
				const size = formatFileSize(parsed.bytes);
				const code = parsed.code ?? '';
				const codeText = parsed.codeText ?? '';
				return `Received ${size}${code ? ` (${code}${codeText ? ' ' + codeText : ''})` : ''}`;
			}
		} catch {
			// Not structured — fall back
		}
		const byteCount = new TextEncoder().encode(output).length;
		return `Received ${formatFileSize(byteCount)}`;
	});

	let state = $derived(stateOverride ?? (phase === 'start' ? 'running' as const : (success ? 'completed' as const : 'error' as const)));

	let label = $derived.by(() => {
		if (phase === 'start') {
			return hostname || truncateSummary(url, 60) || toolName;
		}
		return resultSummary || 'Done';
	});
</script>

{#snippet urlBlock()}
	<div class="space-y-2 p-3">
		<div class="text-[10px] uppercase tracking-wider text-muted-foreground">URL</div>
		<p class="text-[13px] font-mono text-foreground break-all">{url}</p>
		{#if prompt}
			<div class="text-[10px] uppercase tracking-wider text-muted-foreground">Prompt</div>
			<p class="text-[12px] text-muted-foreground">{prompt}</p>
		{/if}
	</div>
{/snippet}

{#snippet errorBlock()}
	{#if phase === 'end' && error}
		<ToolCallResult error>
			<pre class="max-h-[30vh] overflow-auto whitespace-pre-wrap break-all p-3 font-mono">{error}</pre>
		</ToolCallResult>
	{/if}
{/snippet}

{#if variant === 'panel'}
	<div class="space-y-3">
		{@render urlBlock()}
		{#if phase === 'end' && resultSummary && !error}
			<div class="px-3">
				<div class="text-[10px] uppercase tracking-wider text-muted-foreground">Result</div>
				<p class="mt-1 text-[12px]">{resultSummary}</p>
			</div>
		{/if}
		{@render errorBlock()}
		{#if phase === 'end' && output && !error}
			<div class="px-3 pb-3">
				<div class="text-[10px] uppercase tracking-wider text-muted-foreground">Raw output</div>
				<pre class="mt-1 max-h-[40vh] overflow-auto whitespace-pre-wrap break-all rounded bg-[#0d1117] p-3 text-[11px] font-mono text-zinc-300">{output}</pre>
			</div>
		{/if}
	</div>
{:else}
	<ToolCall>
		<ToolCallHeader {toolName} {label} {state} icon={Download} iconClass="text-teal-500/80" />
		{#if phase === 'start' || (phase === 'end' && error)}
			<ToolCallContent>
				{#if phase === 'start'}
					{@render urlBlock()}
				{:else if phase === 'end'}
					{@render errorBlock()}
				{/if}
			</ToolCallContent>
		{/if}
	</ToolCall>
{/if}
