<script lang="ts">
	import { ToolCall, ToolCallHeader, ToolCallContent, ToolCallResult } from '$lib/components/ui/ai-elements/tool-call';
	import Search from '@lucide/svelte/icons/search';
	import { getDisplayPath, parseGrepOutput } from './tool-utils';
	import type { ToolViewProps } from './index';

	let { phase, toolName, args, output = '', success = true, error = '', state: stateOverride, variant = 'card' }: ToolViewProps = $props();

	let pattern = $derived((args?.pattern as string) ?? '');
	let searchPath = $derived((args?.path as string) ?? '');
	let fileGlob = $derived((args?.file_glob as string) ?? '');
	let displayPath = $derived(searchPath ? getDisplayPath(searchPath) : '');
	let grepResult = $derived(parseGrepOutput(output));
	let state = $derived(stateOverride ?? (phase === 'start' ? 'running' as const : (success ? 'completed' as const : 'error' as const)));

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

{#snippet body()}
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
{/snippet}

{#if variant === 'panel'}
	<div class="space-y-3">
		<div class="grid grid-cols-2 gap-3 text-xs">
			<div>
				<div class="text-[10px] uppercase tracking-wider text-muted-foreground">Pattern</div>
				<code class="mt-1 inline-block font-mono">{pattern || '-'}</code>
			</div>
			{#if displayPath}
				<div>
					<div class="text-[10px] uppercase tracking-wider text-muted-foreground">Path</div>
					<code class="mt-1 inline-block font-mono truncate">{displayPath}</code>
				</div>
			{/if}
			{#if fileGlob}
				<div>
					<div class="text-[10px] uppercase tracking-wider text-muted-foreground">Glob</div>
					<code class="mt-1 inline-block font-mono">{fileGlob}</code>
				</div>
			{/if}
		</div>
		{@render body()}
	</div>
{:else}
	<ToolCall>
		<ToolCallHeader {toolName} {label} {state} icon={Search} iconClass="text-violet-500/80" />
		<ToolCallContent>
			{@render body()}
		</ToolCallContent>
	</ToolCall>
{/if}
