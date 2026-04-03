<script lang="ts">
	import { Copy, Check, ChevronDown, ChevronRight } from 'lucide-svelte';
	import { ScrollArea } from '$lib/components/ui/scroll-area';

	interface Props {
		data: unknown;
		label?: string;
		collapsed?: boolean;
	}

	let { data, label = 'JSON', collapsed = false }: Props = $props();

	let isCollapsed = $derived(collapsed);
	let showFull = $state(false);
	let copyFeedback = $state(false);

	const MAX_PREVIEW_LENGTH = 2000;

	const formatted = $derived.by(() => {
		try {
			return JSON.stringify(data, null, 2);
		} catch {
			return String(data);
		}
	});

	const isTruncated = $derived(formatted.length > MAX_PREVIEW_LENGTH);
	const displayText = $derived(showFull || !isTruncated ? formatted : formatted.slice(0, MAX_PREVIEW_LENGTH) + '\n...');

	/**
	 * Syntax-highlight JSON string into HTML spans.
	 * Handles: strings, numbers, booleans, null, keys, punctuation.
	 */
	const highlighted = $derived.by(() => {
		return displayText.replace(
			/("(?:\\.|[^"\\])*")\s*:|("(?:\\.|[^"\\])*")|((?:-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?))|\b(true|false)\b|\b(null)\b/g,
			(match, key, str, num, bool, nul) => {
				if (key) {
					// JSON key (before colon)
					return `<span class="json-key">${escapeHtml(key)}</span>:`;
				}
				if (str) return `<span class="json-string">${escapeHtml(str)}</span>`;
				if (num) return `<span class="json-number">${num}</span>`;
				if (bool) return `<span class="json-boolean">${bool}</span>`;
				if (nul) return `<span class="json-null">${nul}</span>`;
				return match;
			}
		);
	});

	function escapeHtml(s: string): string {
		return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
	}

	async function copyToClipboard() {
		try {
			await navigator.clipboard.writeText(formatted);
			copyFeedback = true;
			setTimeout(() => (copyFeedback = false), 1500);
		} catch {
			// Clipboard not available
		}
	}
</script>

<div class="json-viewer min-w-0 overflow-hidden rounded-md border border-border bg-muted/30">
	<div class="flex items-center gap-1.5 px-2.5 py-1.5" role="group">
		<button
			class="flex flex-1 items-center gap-1.5 text-left text-xs font-medium hover:opacity-80 transition-opacity"
			onclick={() => (isCollapsed = !isCollapsed)}
		>
			{#if isCollapsed}
				<ChevronRight size={11} class="shrink-0 text-muted-foreground" />
			{:else}
				<ChevronDown size={11} class="shrink-0 text-muted-foreground" />
			{/if}
			<span class="text-foreground">{label}</span>
		</button>
		<button
			class="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
			onclick={copyToClipboard}
			title="Copy to clipboard"
		>
			{#if copyFeedback}
				<Check size={10} class="text-green-500" />
			{:else}
				<Copy size={10} />
			{/if}
		</button>
	</div>

	{#if !isCollapsed}
		<ScrollArea orientation="both" class="max-h-[60vh] border-t border-border px-2.5 py-1.5">
			<pre class="whitespace-pre-wrap break-all font-mono text-[10px] leading-relaxed text-foreground">{@html highlighted}</pre>
			{#if isTruncated && !showFull}
				<button
					class="mt-1 text-xs text-blue-500 hover:underline"
					onclick={() => (showFull = true)}
				>
					Show more ({(formatted.length / 1000).toFixed(1)}KB)
				</button>
			{/if}
		</ScrollArea>
	{/if}
</div>

<style>
	.json-viewer :global(.json-key) {
		color: #7dd3fc; /* sky-300 */
	}
	.json-viewer :global(.json-string) {
		color: #86efac; /* green-300 */
	}
	.json-viewer :global(.json-number) {
		color: #fbbf24; /* amber-400 */
	}
	.json-viewer :global(.json-boolean) {
		color: #c084fc; /* purple-400 */
	}
	.json-viewer :global(.json-null) {
		color: #94a3b8; /* slate-400 */
		font-style: italic;
	}

	/* Light mode overrides */
	:global(.light) .json-viewer :global(.json-key),
	:global([data-theme="light"]) .json-viewer :global(.json-key) {
		color: #0369a1; /* sky-700 */
	}
	:global(.light) .json-viewer :global(.json-string),
	:global([data-theme="light"]) .json-viewer :global(.json-string) {
		color: #15803d; /* green-700 */
	}
	:global(.light) .json-viewer :global(.json-number),
	:global([data-theme="light"]) .json-viewer :global(.json-number) {
		color: #b45309; /* amber-700 */
	}
	:global(.light) .json-viewer :global(.json-boolean),
	:global([data-theme="light"]) .json-viewer :global(.json-boolean) {
		color: #7e22ce; /* purple-700 */
	}
</style>
