<script lang="ts">
	import { ToolCall, ToolCallHeader, ToolCallContent, ToolCallResult } from '$lib/components/ui/ai-elements/tool-call';
	import Globe from '@lucide/svelte/icons/globe';
	import { truncateSummary } from './tool-utils';
	import type { ToolViewProps } from './index';

	let { phase, toolName, args, output = '', success = true, error = '', state: stateOverride, variant = 'card' }: ToolViewProps = $props();

	let query = $derived((args?.query as string) ?? '');

	let resultSummary = $derived.by(() => {
		if (!output) return null;
		try {
			const parsed = JSON.parse(output);
			if (parsed.results && Array.isArray(parsed.results)) {
				const searchCount = parsed.results.filter((r: unknown) => r != null && typeof r !== 'string').length;
				const duration = parsed.durationSeconds;
				const timeDisplay = duration >= 1
					? `${Math.round(duration)}s`
					: `${Math.round(duration * 1000)}ms`;
				return { searchCount, timeDisplay };
			}
		} catch {
			// Output is not structured JSON — fall back to line count
		}
		const lines = output.split('\n').filter((l) => l.trim());
		return { searchCount: lines.length > 0 ? 1 : 0, timeDisplay: '' };
	});

	let state = $derived(stateOverride ?? (phase === 'start' ? 'running' as const : (success ? 'completed' as const : 'error' as const)));

	let label = $derived.by(() => {
		if (phase === 'start') {
			if (!query) return toolName;
			return `"${truncateSummary(query, 80)}"`;
		}
		if (!resultSummary || resultSummary.searchCount === 0) return 'No results';
		const count = resultSummary.searchCount;
		let l = `Did ${count} search${count !== 1 ? 'es' : ''}`;
		if (resultSummary.timeDisplay) l += ` in ${resultSummary.timeDisplay}`;
		return l;
	});

	let allowedDomains = $derived(args?.allowed_domains && Array.isArray(args.allowed_domains) ? args.allowed_domains as string[] : null);
	let blockedDomains = $derived(args?.blocked_domains && Array.isArray(args.blocked_domains) ? args.blocked_domains as string[] : null);
</script>

{#snippet queryBlock()}
	{#if query}
		<div class="space-y-2 p-3">
			<h4 class="text-muted-foreground text-[10px] font-medium tracking-wider uppercase">Query</h4>
			<p class="text-[13px] text-foreground">{query}</p>
			{#if allowedDomains}
				<p class="text-[11px] text-muted-foreground">Allowed: {allowedDomains.join(', ')}</p>
			{/if}
			{#if blockedDomains}
				<p class="text-[11px] text-muted-foreground">Blocked: {blockedDomains.join(', ')}</p>
			{/if}
		</div>
	{/if}
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
		{@render queryBlock()}
		{#if phase === 'end' && resultSummary && resultSummary.searchCount > 0}
			<div class="px-3">
				<div class="text-[10px] uppercase tracking-wider text-muted-foreground">Result</div>
				<p class="mt-1 text-[12px]">Did {resultSummary.searchCount} search{resultSummary.searchCount !== 1 ? 'es' : ''}{resultSummary.timeDisplay ? ` in ${resultSummary.timeDisplay}` : ''}</p>
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
		<ToolCallHeader {toolName} {label} {state} icon={Globe} iconClass="text-sky-500/80" />
		{#if (phase === 'start' && query) || (phase === 'end' && error)}
			<ToolCallContent>
				{#if phase === 'start'}
					{@render queryBlock()}
				{:else if phase === 'end'}
					{@render errorBlock()}
				{/if}
			</ToolCallContent>
		{/if}
	</ToolCall>
{/if}
