<script lang="ts">
	import { ToolCall, ToolCallHeader, ToolCallContent, ToolCallResult } from '$lib/components/ui/ai-elements/tool-call';
	import SandboxCodeViewer from '$lib/components/sandbox/sandbox-code-viewer.svelte';
	import FileEdit from '@lucide/svelte/icons/file-edit';
	import { getDisplayPath, countLines, truncateLines, detectLang, MAX_FILE_WRITE_RENDER_LINES } from './tool-utils';
	import type { ToolViewProps } from './index';

	let { phase, toolName, args, output = '', success = true, error = '', state: stateOverride, variant = 'card' }: ToolViewProps = $props();

	let filePath = $derived((args?.path as string) ?? (args?.file_path as string) ?? '');
	let content = $derived((args?.content as string) ?? '');
	let displayPath = $derived(getDisplayPath(filePath));
	let lineCount = $derived(content ? countLines(content) : 0);
	let preview = $derived(truncateLines(content, MAX_FILE_WRITE_RENDER_LINES));
	let isTruncated = $derived(preview.remainingLines > 0);
	let lang = $derived(detectLang(filePath));

	let parsedOutput = $derived.by(() => {
		if (!output) return { lines: 0, path: '' };
		const match = output.match(/wrote (\d+) lines? to (.+?)(?:\s*\(|$)/i);
		if (match) return { lines: parseInt(match[1], 10), path: getDisplayPath(match[2].trim()) };
		return { lines: 0, path: '' };
	});

	let toolState = $derived(stateOverride ?? (phase === 'start' ? 'running' as const : (success ? 'completed' as const : 'error' as const)));
	let label = $derived.by(() => {
		if (phase === 'start') return displayPath || 'file';
		const p = parsedOutput;
		if (p.lines > 0) return `Wrote ${p.lines} lines to ${p.path}`;
		return output.slice(0, 60) || 'Done';
	});

	let isOpen = $state(false);
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
		{#if content}
			<div>
				<div class="text-[10px] uppercase tracking-wider text-muted-foreground">Content</div>
				<div class="mt-1 max-h-[60vh] overflow-auto rounded border border-border/40">
					<SandboxCodeViewer code={content} {lang} />
				</div>
			</div>
		{/if}
		{#if phase === 'end' && error}
			<ToolCallResult error>
				<pre class="max-h-[30vh] overflow-auto whitespace-pre-wrap break-all p-3 font-mono">{error}</pre>
			</ToolCallResult>
		{:else if phase === 'end' && parsedOutput.lines > 0}
			<div class="text-[11px] text-muted-foreground">Wrote {parsedOutput.lines} lines to {parsedOutput.path}</div>
		{/if}
	</div>
{:else}
	<ToolCall bind:open={isOpen}>
		<ToolCallHeader {toolName} {label} state={toolState} icon={FileEdit} iconClass="text-emerald-500/80" />

		{#if content && (!isOpen || !isTruncated)}
			<div class="border-t">
				<div class="max-h-[30vh] overflow-auto">
					<SandboxCodeViewer code={preview.text} {lang} />
				</div>
				{#if isTruncated}
					<p class="px-3 py-1.5 text-[11px] text-muted-foreground/60 border-t">… +{preview.remainingLines} more lines</p>
				{/if}
			</div>
		{/if}

		{#if isTruncated}
			<ToolCallContent>
				<ToolCallResult label="Full content">
					<div class="max-h-[50vh] overflow-auto">
						<SandboxCodeViewer code={content} lang={detectLang(parsedOutput.path || displayPath)} />
					</div>
				</ToolCallResult>
			</ToolCallContent>
		{/if}

		{#if phase === 'end' && error}
			<div class="border-t">
				<ToolCallResult error>
					<pre class="max-h-[30vh] overflow-auto whitespace-pre-wrap break-all p-3 font-mono">{error}</pre>
				</ToolCallResult>
			</div>
		{/if}
	</ToolCall>
{/if}
