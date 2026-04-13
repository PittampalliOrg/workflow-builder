<script lang="ts">
	import { ToolCall, ToolCallHeader, ToolCallContent, ToolCallResult } from '$lib/components/ui/ai-elements/tool-call';
	import SandboxCodeViewer from '$lib/components/sandbox/sandbox-code-viewer.svelte';
	import FileText from 'lucide-svelte/icons/file-text';
	import { getDisplayPath, countLines, truncateLines, detectLang } from './tool-utils';

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

	/**
	 * Claude Code: FileRead result shows "Read N lines" ONLY in collapsed state.
	 * Full content is never shown in renderToolResultMessage — it appears
	 * separately in the message flow. We show a preview on expand since
	 * our timeline doesn't have that separate display.
	 */
	const MAX_PREVIEW_LINES = 20;

	let filePath = $derived((args?.file_path as string) ?? (args?.path as string) ?? '');
	let displayPath = $derived(getDisplayPath(filePath));
	let lineCount = $derived(output ? countLines(output) : 0);
	let preview = $derived(truncateLines(output, MAX_PREVIEW_LINES));
	let lang = $derived(detectLang(filePath));
	let state = $derived(stateOverride ?? (phase === 'start' ? 'running' as const : (success ? 'completed' as const : 'error' as const)));

	// Claude Code: collapsed shows "Read N lines" only (height={1})
	let label = $derived(phase === 'start' ? displayPath : `Read ${lineCount} lines`);
</script>

<ToolCall>
	<ToolCallHeader {toolName} {label} {state} icon={FileText} iconClass="text-blue-400" />
	<ToolCallContent>
		{#if phase === 'end'}
			{#if error}
				<ToolCallResult error>
					<pre class="max-h-[30vh] overflow-auto whitespace-pre-wrap break-all p-3 font-mono">{error}</pre>
				</ToolCallResult>
			{:else if output}
				<ToolCallResult label="Content">
					<div class="max-h-[40vh] overflow-auto">
						<SandboxCodeViewer code={preview.text} {lang} />
					</div>
				</ToolCallResult>
				{#if preview.remainingLines > 0}
					<p class="px-3 pb-2 text-[11px] text-muted-foreground/60">… +{preview.remainingLines} more lines</p>
				{/if}
			{/if}
		{/if}
	</ToolCallContent>
</ToolCall>
