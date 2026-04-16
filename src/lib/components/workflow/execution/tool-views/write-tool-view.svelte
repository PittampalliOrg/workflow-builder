<script lang="ts">
	import { ToolCall, ToolCallHeader, ToolCallContent, ToolCallResult } from '$lib/components/ui/ai-elements/tool-call';
	import SandboxCodeViewer from '$lib/components/sandbox/sandbox-code-viewer.svelte';
	import Pencil from 'lucide-svelte/icons/pencil';
	import { getDisplayPath, countLines, truncateLines, detectLang, MAX_FILE_WRITE_RENDER_LINES } from './tool-utils';

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

	let filePath = $derived((args?.path as string) ?? (args?.file_path as string) ?? '');
	let content = $derived((args?.content as string) ?? '');
	let displayPath = $derived(getDisplayPath(filePath));
	let lineCount = $derived(content ? countLines(content) : 0);
	let preview = $derived(truncateLines(content, MAX_FILE_WRITE_RENDER_LINES));
	let isTruncated = $derived(preview.remainingLines > 0);
	let lang = $derived(detectLang(filePath));

	// Parse output for end phase
	let parsedOutput = $derived.by(() => {
		if (!output) return { lines: 0, path: '' };
		const match = output.match(/wrote (\d+) lines? to (.+?)(?:\s*\(|$)/i);
		if (match) return { lines: parseInt(match[1], 10), path: getDisplayPath(match[2].trim()) };
		return { lines: 0, path: '' };
	});

	let state = $derived(stateOverride ?? (phase === 'start' ? 'running' as const : (success ? 'completed' as const : 'error' as const)));
	let label = $derived.by(() => {
		if (phase === 'start') return displayPath || 'file';
		const p = parsedOutput;
		if (p.lines > 0) return `Wrote ${p.lines} lines to ${p.path}`;
		return output.slice(0, 60) || 'Done';
	});
</script>

<ToolCall>
	<ToolCallHeader {toolName} {label} {state} icon={Pencil} iconClass="text-emerald-400" />

	<!-- Claude Code: FileWrite shows first 10 lines of code by DEFAULT (not hidden behind expand) -->
	{#if content}
		<div class="border-t">
			<div class="max-h-[30vh] overflow-auto">
				<SandboxCodeViewer code={preview.text} {lang} />
			</div>
			{#if isTruncated}
				<p class="px-3 py-1.5 text-[11px] text-muted-foreground/60 border-t">… +{preview.remainingLines} more lines</p>
			{/if}
		</div>
	{/if}

	<!-- Expanded: full content (only if truncated) -->
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
