<script lang="ts">
	import { ToolCall, ToolCallHeader, ToolCallContent, ToolCallResult } from '$lib/components/ui/ai-elements/tool-call';
	import FileText from 'lucide-svelte/icons/file-text';
	import { getDisplayPath, countLines } from './tool-utils';

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

	let filePath = $derived((args?.file_path as string) ?? (args?.path as string) ?? '');
	let displayPath = $derived(getDisplayPath(filePath));
	let lineCount = $derived(output ? countLines(output) : 0);
	let state = $derived(stateOverride ?? (phase === 'start' ? 'running' as const : (success ? 'completed' as const : 'error' as const)));

	let label = $derived(phase === 'start' ? displayPath : `Read ${lineCount} lines`);
</script>

<ToolCall>
	<ToolCallHeader {toolName} {label} {state} icon={FileText} iconClass="text-blue-400" />
	{#if phase === 'end' && error}
		<ToolCallContent>
			<ToolCallResult error>
				<pre class="max-h-[30vh] overflow-auto whitespace-pre-wrap break-all p-3 font-mono">{error}</pre>
			</ToolCallResult>
		</ToolCallContent>
	{/if}
</ToolCall>
