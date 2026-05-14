<script lang="ts">
	import { ToolCall, ToolCallHeader, ToolCallContent, ToolCallResult } from '$lib/components/ui/ai-elements/tool-call';
	import FolderOpen from '@lucide/svelte/icons/folder-open';
	import { getDisplayPath, countListEntries } from './tool-utils';
	import type { ToolViewProps } from './index';

	let { phase, toolName, args, output = '', success = true, error = '', state: stateOverride, variant = 'card' }: ToolViewProps = $props();

	let dirPath = $derived((args?.path as string) ?? '.');
	let pattern = $derived((args?.pattern as string) ?? '');
	let displayLabel = $derived(pattern ? `pattern: "${pattern}"` : getDisplayPath(dirPath));
	let entryCount = $derived(output ? countListEntries(output) : 0);
	let state = $derived(stateOverride ?? (phase === 'start' ? 'running' as const : (success ? 'completed' as const : 'error' as const)));

	let label = $derived(phase === 'start' ? displayLabel : `Found ${entryCount} ${entryCount === 1 ? 'file' : 'files'}`);
</script>

{#snippet body()}
	{#if phase === 'end'}
		{#if error}
			<ToolCallResult error>
				<pre class="max-h-[30vh] overflow-auto whitespace-pre-wrap break-all p-3 font-mono">{error}</pre>
			</ToolCallResult>
		{:else if output}
			<ToolCallResult label="Files">
				<pre class="max-h-[30vh] overflow-auto whitespace-pre-wrap break-all bg-[#0d1117] p-3 font-mono text-zinc-300 leading-relaxed">{output}</pre>
			</ToolCallResult>
		{/if}
	{/if}
{/snippet}

{#if variant === 'panel'}
	<div class="space-y-3">
		<div>
			<div class="text-[10px] uppercase tracking-wider text-muted-foreground">{pattern ? 'Pattern' : 'Path'}</div>
			<code class="mt-1 inline-block text-xs font-mono">{pattern || getDisplayPath(dirPath)}</code>
		</div>
		{@render body()}
	</div>
{:else}
	<ToolCall>
		<ToolCallHeader {toolName} {label} {state} icon={FolderOpen} iconClass="text-yellow-500/80" />
		<ToolCallContent>
			{@render body()}
		</ToolCallContent>
	</ToolCall>
{/if}
