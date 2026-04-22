<script lang="ts">
	import { ToolCall, ToolCallHeader, ToolCallContent, ToolCallResult } from '$lib/components/ui/ai-elements/tool-call';
	import Globe from 'lucide-svelte/icons/globe';
	import { truncateSummary } from './tool-utils';

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

	let query = $derived((args?.query as string) ?? '');

	/**
	 * Parse WebSearch result to extract search count and duration.
	 * Ported from WebSearchTool/UI.tsx getSearchSummary + renderToolResultMessage.
	 */
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

	/**
	 * Label logic ported from WebSearchTool/UI.tsx:
	 * - renderToolUseMessage: `"${query}"`
	 * - renderToolResultMessage: `Did N search(es) in Xs`
	 */
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
</script>

<ToolCall>
	<ToolCallHeader {toolName} {label} {state} icon={Globe} iconClass="text-sky-500/80" />
	{#if (phase === 'start' && query) || (phase === 'end' && error)}
		<ToolCallContent>
			{#if phase === 'start' && query}
				<div class="space-y-2 p-3">
					<h4 class="text-muted-foreground text-[10px] font-medium tracking-wider uppercase">Query</h4>
					<p class="text-[13px] text-foreground">{query}</p>
					{#if args?.allowed_domains && Array.isArray(args.allowed_domains)}
						<p class="text-[11px] text-muted-foreground">Allowed: {(args.allowed_domains as string[]).join(', ')}</p>
					{/if}
					{#if args?.blocked_domains && Array.isArray(args.blocked_domains)}
						<p class="text-[11px] text-muted-foreground">Blocked: {(args.blocked_domains as string[]).join(', ')}</p>
					{/if}
				</div>
			{:else if phase === 'end'}
				{#if error}
					<ToolCallResult error>
						<pre class="max-h-[30vh] overflow-auto whitespace-pre-wrap break-all p-3 font-mono">{error}</pre>
					</ToolCallResult>
				{/if}
			{/if}
		</ToolCallContent>
	{/if}
</ToolCall>
