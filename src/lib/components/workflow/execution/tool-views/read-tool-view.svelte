<script lang="ts">
	import { ToolCall, ToolCallHeader, ToolCallContent, ToolCallResult } from '$lib/components/ui/ai-elements/tool-call';
	import SandboxCodeViewer from '$lib/components/sandbox/sandbox-code-viewer.svelte';
	import FileText from '@lucide/svelte/icons/file-text';
	import { getDisplayPath, countLines, detectLang } from './tool-utils';
	import type { ToolViewProps } from './index';

	let { phase, toolName, args, output = '', success = true, error = '', state: stateOverride, variant = 'card' }: ToolViewProps = $props();

	let filePath = $derived((args?.file_path as string) ?? (args?.path as string) ?? '');
	let displayPath = $derived(getDisplayPath(filePath));
	let lineCount = $derived(output ? countLines(output) : 0);
	let lang = $derived(detectLang(filePath));
	let state = $derived(stateOverride ?? (phase === 'start' ? 'running' as const : (success ? 'completed' as const : 'error' as const)));

	let label = $derived(phase === 'start' ? displayPath : `Read ${lineCount} lines`);
</script>

{#if variant === 'panel'}
	<div class="space-y-3">
		{#if displayPath}
			<div>
				<div class="text-[10px] uppercase tracking-wider text-muted-foreground">File</div>
				<code class="mt-1 inline-block text-xs font-mono">{displayPath}</code>
				{#if lineCount > 0}
					<span class="ml-2 text-[11px] text-muted-foreground">{lineCount} {lineCount === 1 ? 'line' : 'lines'}</span>
				{/if}
			</div>
		{/if}
		{#if phase === 'end' && output && !error}
			<div>
				<div class="text-[10px] uppercase tracking-wider text-muted-foreground">Content</div>
				<div class="mt-1 max-h-[60vh] overflow-auto rounded border border-border/40">
					<SandboxCodeViewer code={output} {lang} />
				</div>
			</div>
		{/if}
		{#if phase === 'end' && error}
			<ToolCallResult error>
				<pre class="max-h-[30vh] overflow-auto whitespace-pre-wrap break-all p-3 font-mono">{error}</pre>
			</ToolCallResult>
		{/if}
	</div>
{:else}
	<ToolCall>
		<ToolCallHeader {toolName} {label} {state} icon={FileText} iconClass="text-blue-500/80" />
		{#if phase === 'end' && error}
			<ToolCallContent>
				<ToolCallResult error>
					<pre class="max-h-[30vh] overflow-auto whitespace-pre-wrap break-all p-3 font-mono">{error}</pre>
				</ToolCallResult>
			</ToolCallContent>
		{/if}
	</ToolCall>
{/if}
