<script lang="ts">
	import { Check, Copy } from '@lucide/svelte';
	import { cn } from '$lib/components/ui/utils';

	interface Props {
		value: unknown;
		class?: string;
		maxHeight?: string;
		emptyText?: string;
		humanizeStrings?: boolean;
	}

	let {
		value,
		class: className = '',
		maxHeight = 'max-h-56',
		emptyText = '-',
		humanizeStrings = true
	}: Props = $props();

	let copied = $state(false);

	const rendered = $derived.by(() => formatInspectable(value, emptyText));
	const highlighted = $derived.by(() =>
		rendered.language === 'json'
			? highlightJson(rendered.text, humanizeStrings)
			: escapeHtml(rendered.text)
	);

	async function copyPayload() {
		try {
			await navigator.clipboard.writeText(rendered.copyText);
			copied = true;
			setTimeout(() => (copied = false), 1500);
		} catch {
			// Clipboard access is best-effort.
		}
	}

	type RenderedPayload = {
		text: string;
		copyText: string;
		language: 'json' | 'text';
	};

	function formatInspectable(input: unknown, fallback: string): RenderedPayload {
		if (input === undefined || input === null) {
			return { text: fallback, copyText: fallback, language: 'text' };
		}

		const normalized = normalizeInspectable(input);
		if (typeof normalized === 'string') {
			const text = decodeEscapedText(normalized);
			return { text, copyText: text, language: 'text' };
		}

		try {
			const text = JSON.stringify(normalized, null, 2);
			return { text, copyText: text, language: 'json' };
		} catch {
			const text = String(normalized);
			return { text, copyText: text, language: 'text' };
		}
	}

	function normalizeInspectable(input: unknown): unknown {
		const state = { count: 0, seen: new WeakSet<object>() };
		return normalizeValue(input, state, 0);
	}

	function normalizeValue(input: unknown, state: { count: number; seen: WeakSet<object> }, depth: number): unknown {
		state.count += 1;
		if (state.count > 1000 || depth > 12) return input;

		if (typeof input === 'string') {
			const parsed = parseJsonLike(input);
			return parsed.ok ? normalizeValue(parsed.value, state, depth + 1) : input;
		}

		if (!input || typeof input !== 'object') return input;
		if (state.seen.has(input)) return '[Circular]';
		state.seen.add(input);

		if (Array.isArray(input)) {
			return input.map((item) => normalizeValue(item, state, depth + 1));
		}

		const output: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
			output[key] = normalizeValue(value, state, depth + 1);
		}
		return output;
	}

	function parseJsonLike(input: string): { ok: true; value: unknown } | { ok: false } {
		let current = input.trim();
		if (!current || !['{', '[', '"'].includes(current[0])) return { ok: false };

		for (let i = 0; i < 3; i += 1) {
			try {
				const parsed = JSON.parse(current) as unknown;
				if (typeof parsed === 'string') {
					const nested = parsed.trim();
					if (nested !== current && nested && ['{', '[', '"'].includes(nested[0])) {
						current = nested;
						continue;
					}
				}
				return { ok: true, value: parsed };
			} catch {
				return { ok: false };
			}
		}

		return { ok: false };
	}

	function decodeEscapedText(input: string): string {
		if (!/(\\n|\\r|\\t|\\")/.test(input)) return input;
		return input
			.replace(/\\r\\n/g, '\n')
			.replace(/\\n/g, '\n')
			.replace(/\\r/g, '\n')
			.replace(/\\t/g, '\t')
			.replace(/\\"/g, '"');
	}

	function highlightJson(input: string, humanize: boolean): string {
		return input.replace(
			/("(?:\\.|[^"\\])*")\s*:|("(?:\\.|[^"\\])*")|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|\b(true|false)\b|\b(null)\b/g,
			(match, key: string | undefined, str: string | undefined, num: string | undefined, bool: string | undefined, nul: string | undefined) => {
				if (key) return `<span class="json-key">${escapeHtml(key)}</span>:`;
				if (str) return `<span class="json-string">${escapeHtml(humanize ? humanizeJsonString(str) : str)}</span>`;
				if (num) return `<span class="json-number">${num}</span>`;
				if (bool) return `<span class="json-boolean">${bool}</span>`;
				if (nul) return `<span class="json-null">${nul}</span>`;
				return escapeHtml(match);
			}
		);
	}

	function humanizeJsonString(token: string): string {
		if (!/(\\n|\\r|\\t|\\")/.test(token)) return token;
		try {
			const parsed = JSON.parse(token) as unknown;
			if (typeof parsed !== 'string') return token;
			return `"${parsed}"`;
		} catch {
			return token;
		}
	}

	function escapeHtml(input: string): string {
		return input.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
	}
</script>

<div class={cn('inspectable-payload relative overflow-hidden rounded-md bg-muted', className)}>
	<button
		type="button"
		class="absolute right-1.5 top-1.5 z-10 rounded-md p-1 text-muted-foreground hover:bg-background/80 hover:text-foreground"
		aria-label="Copy payload"
		onclick={copyPayload}
	>
		{#if copied}
			<Check size={12} class="text-green-500" />
		{:else}
			<Copy size={12} />
		{/if}
	</button>
	<pre class={cn(maxHeight, 'overflow-auto whitespace-pre-wrap break-words p-3 pr-9 font-mono text-xs leading-relaxed text-foreground')}>{@html highlighted}</pre>
</div>

<style>
	.inspectable-payload :global(.json-key) {
		color: #38bdf8;
	}

	.inspectable-payload :global(.json-string) {
		color: #4ade80;
	}

	.inspectable-payload :global(.json-number) {
		color: #f59e0b;
	}

	.inspectable-payload :global(.json-boolean) {
		color: #fb7185;
	}

	.inspectable-payload :global(.json-null) {
		color: #94a3b8;
		font-style: italic;
	}

	:global(.light) .inspectable-payload :global(.json-key),
	:global([data-theme='light']) .inspectable-payload :global(.json-key) {
		color: #0369a1;
	}

	:global(.light) .inspectable-payload :global(.json-string),
	:global([data-theme='light']) .inspectable-payload :global(.json-string) {
		color: #15803d;
	}

	:global(.light) .inspectable-payload :global(.json-number),
	:global([data-theme='light']) .inspectable-payload :global(.json-number) {
		color: #b45309;
	}

	:global(.light) .inspectable-payload :global(.json-boolean),
	:global([data-theme='light']) .inspectable-payload :global(.json-boolean) {
		color: #be123c;
	}
</style>
