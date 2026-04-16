<script lang="ts">
	import { ToolCall, ToolCallHeader, ToolCallContent, ToolCallResult } from '$lib/components/ui/ai-elements/tool-call';
	import Download from 'lucide-svelte/icons/download';
	import { truncateSummary, formatFileSize } from './tool-utils';

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

	let url = $derived((args?.url as string) ?? '');
	let prompt = $derived((args?.prompt as string) ?? '');

	/**
	 * Extract hostname from URL for display.
	 * Ported from WebFetchTool/UI.tsx getToolUseSummary pattern.
	 */
	let hostname = $derived.by(() => {
		if (!url) return '';
		try {
			return new URL(url).hostname;
		} catch {
			return truncateSummary(url, 60);
		}
	});

	/**
	 * Parse fetch result for display.
	 * Ported from WebFetchTool/UI.tsx renderToolResultMessage:
	 * "Received {formatFileSize(bytes)} ({code} {codeText})"
	 */
	let resultSummary = $derived.by(() => {
		if (!output) return null;
		try {
			const parsed = JSON.parse(output);
			if (parsed.bytes !== undefined) {
				const size = formatFileSize(parsed.bytes);
				const code = parsed.code ?? '';
				const codeText = parsed.codeText ?? '';
				return `Received ${size}${code ? ` (${code}${codeText ? ' ' + codeText : ''})` : ''}`;
			}
		} catch {
			// Not structured — fall back
		}
		const byteCount = new TextEncoder().encode(output).length;
		return `Received ${formatFileSize(byteCount)}`;
	});

	let state = $derived(stateOverride ?? (phase === 'start' ? 'running' as const : (success ? 'completed' as const : 'error' as const)));

	/**
	 * Label logic ported from WebFetchTool/UI.tsx:
	 * - renderToolUseMessage (non-verbose): url
	 * - renderToolResultMessage: "Received {size} ({code} {codeText})"
	 */
	let label = $derived.by(() => {
		if (phase === 'start') {
			return hostname || truncateSummary(url, 60) || toolName;
		}
		return resultSummary || 'Done';
	});
</script>

<ToolCall>
	<ToolCallHeader {toolName} {label} {state} icon={Download} iconClass="text-teal-400" />
	{#if phase === 'start' || (phase === 'end' && error)}
		<ToolCallContent>
			{#if phase === 'start'}
				<div class="space-y-2 p-3">
					<p class="text-[13px] font-mono text-foreground break-all">{url}</p>
					{#if prompt}
						<p class="text-[11px] text-muted-foreground">{prompt}</p>
					{/if}
				</div>
			{:else if phase === 'end'}
				{#if error}
					<ToolCallResult error>
						<pre class="max-h-[30vh] overflow-auto whitespace-pre-wrap break-all p-3 font-mono">{error}</pre>
					</ToolCallResult>
				{/if}
			{/if}
		</ToolCallContent>
	{/if}
</ToolCall>
