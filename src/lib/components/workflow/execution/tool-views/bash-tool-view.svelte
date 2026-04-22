<script lang="ts">
	import { ToolCall, ToolCallHeader, ToolCallContent, ToolCallResult } from '$lib/components/ui/ai-elements/tool-call';
	import SandboxCodeViewer from '$lib/components/sandbox/sandbox-code-viewer.svelte';
	import { Badge } from '$lib/components/ui/badge';
	import Terminal from 'lucide-svelte/icons/terminal';
	import { truncateCommand, extractExitCode, truncateLines, MAX_OUTPUT_COLLAPSED_LINES } from './tool-utils';

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

	let command = $derived((args?.command as string) ?? '');
	let displayCommand = $derived(truncateCommand(command));
	let parsed = $derived(extractExitCode(output));
	let exitCode = $derived(parsed.exitCode);
	let cleanOutput = $derived(parsed.cleanOutput);

	let preview = $derived(truncateLines(cleanOutput, MAX_OUTPUT_COLLAPSED_LINES));
	let isTruncated = $derived(preview.remainingLines > 0);

	let toolState = $derived(stateOverride ?? (phase === 'start' ? 'running' as const : (success ? 'completed' as const : 'error' as const)));
	let label = $derived(phase === 'start' ? displayCommand : displayCommand || toolName);

	// Claude Code pattern: when closed, show a truncated preview below the
	// header. When open, show the full output inside ToolCallContent. The
	// preview and the full view are mutually exclusive — `isOpen` is bound so
	// we can hide the preview when the user expands (previously both rendered
	// simultaneously, duplicating the first N lines).
	let isOpen = $state(phase === 'end' && !isTruncated);
</script>

<ToolCall bind:open={isOpen}>
	<ToolCallHeader {toolName} {label} state={toolState} icon={Terminal} iconClass="text-amber-400" />
	<ToolCallContent>
		{#if phase === 'start' && command}
			<div class="max-h-[20vh] overflow-auto">
				<SandboxCodeViewer code={command} lang="bash" />
			</div>
		{:else if phase === 'end'}
			{#if exitCode !== null && exitCode !== 0}
				<div class="px-3 pt-2">
					<Badge variant="destructive" class="text-[10px]">exit {exitCode}</Badge>
				</div>
			{/if}
			{#if error}
				<ToolCallResult error>
					<pre class="max-h-[40vh] overflow-auto whitespace-pre-wrap break-all p-3 font-mono">{error}</pre>
				</ToolCallResult>
			{:else if cleanOutput}
				<ToolCallResult>
					<pre class="max-h-[40vh] overflow-auto whitespace-pre-wrap break-all bg-[#0d1117] p-3 font-mono text-zinc-300 leading-relaxed">{cleanOutput}</pre>
				</ToolCallResult>
			{/if}
		{/if}
	</ToolCallContent>

	{#if !isOpen && phase === 'end' && cleanOutput && isTruncated}
		<div class="border-t px-3 py-2">
			<pre class="whitespace-pre-wrap break-all text-[12px] font-mono text-muted-foreground leading-relaxed">{preview.text}</pre>
			<p class="mt-1 text-[11px] text-muted-foreground/60">… +{preview.remainingLines} lines</p>
		</div>
	{/if}
</ToolCall>
