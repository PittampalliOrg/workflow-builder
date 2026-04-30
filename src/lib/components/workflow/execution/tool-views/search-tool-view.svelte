<script lang="ts">
	import { ToolCall, ToolCallHeader, ToolCallContent, ToolCallResult } from '$lib/components/ui/ai-elements/tool-call';
	import Search from '@lucide/svelte/icons/search';
	import { getDisplayPath, parseGrepOutput } from './tool-utils';

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

	let pattern = $derived((args?.pattern as string) ?? '');
	let searchPath = $derived((args?.path as string) ?? '');
	let fileGlob = $derived((args?.file_glob as string) ?? '');
	let displayPath = $derived(searchPath ? getDisplayPath(searchPath) : '');
	let grepResult = $derived(parseGrepOutput(output));
	let state = $derived(stateOverride ?? (phase === 'start' ? 'running' as const : (success ? 'completed' as const : 'error' as const)));

	/**
	 * Claude Code: GrepTool collapsed shows "Found N matches across M files" (height={1}).
	 * Expand shows the full match content or file list.
	 */
	let label = $derived.by(() => {
		if (phase === 'start') {
			let l = `"${pattern}"`;
			if (displayPath) l += ` in ${displayPath}`;
			if (fileGlob) l += ` (${fileGlob})`;
			return l;
		}
		if (grepResult.matchCount === 0) return 'No matches found';
		let l = `Found ${grepResult.matchCount} ${grepResult.matchCount === 1 ? 'match' : 'matches'}`;
		if (grepResult.files.length > 0) l += ` across ${grepResult.files.length} ${grepResult.files.length === 1 ? 'file' : 'files'}`;
		return l;
	});
</script>

<ToolCall>
	<ToolCallHeader {toolName} {label} {state} icon={Search} iconClass="text-violet-500/80" />
	<ToolCallContent>
		{#if phase === 'end'}
			{#if error}
				<ToolCallResult error>
					<pre class="max-h-[30vh] overflow-auto whitespace-pre-wrap break-all p-3 font-mono">{error}</pre>
				</ToolCallResult>
			{:else if output && grepResult.matchCount > 0}
				<ToolCallResult label="Matches">
					<pre class="max-h-[30vh] overflow-auto whitespace-pre-wrap break-all bg-[#0d1117] p-3 font-mono text-zinc-300 leading-relaxed">{output}</pre>
				</ToolCallResult>
			{/if}
		{/if}
	</ToolCallContent>
</ToolCall>
