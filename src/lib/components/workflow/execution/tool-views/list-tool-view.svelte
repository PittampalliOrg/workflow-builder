<script lang="ts">
	import { ToolCall, ToolCallHeader, ToolCallContent, ToolCallResult } from '$lib/components/ui/ai-elements/tool-call';
	import FolderOpen from 'lucide-svelte/icons/folder-open';
	import { getDisplayPath, countListEntries } from './tool-utils';

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

	let dirPath = $derived((args?.path as string) ?? '.');
	let pattern = $derived((args?.pattern as string) ?? '');
	let displayLabel = $derived(pattern ? `pattern: "${pattern}"` : getDisplayPath(dirPath));
	let entryCount = $derived(output ? countListEntries(output) : 0);
	let state = $derived(stateOverride ?? (phase === 'start' ? 'running' as const : (success ? 'completed' as const : 'error' as const)));

	/**
	 * Claude Code: GlobTool collapsed shows "Found N files" only (height={1}).
	 * Expand shows the full file list.
	 */
	let label = $derived(phase === 'start' ? displayLabel : `Found ${entryCount} ${entryCount === 1 ? 'file' : 'files'}`);
</script>

<ToolCall>
	<ToolCallHeader {toolName} {label} {state} icon={FolderOpen} iconClass="text-yellow-500/80" />
	<ToolCallContent>
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
	</ToolCallContent>
</ToolCall>
