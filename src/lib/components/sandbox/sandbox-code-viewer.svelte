<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import { Copy, Check } from 'lucide-svelte';

	interface Props {
		code: string;
		filename?: string;
		lang?: string;
	}

	let { code, filename, lang }: Props = $props();

	let highlighted = $state('');
	let copied = $state(false);

	// Detect language from filename extension
	const detectedLang = $derived.by(() => {
		if (lang) return lang;
		if (!filename) return 'text';
		const ext = filename.split('.').pop()?.toLowerCase() ?? '';
		const langMap: Record<string, string> = {
			ts: 'typescript', js: 'javascript', tsx: 'tsx', jsx: 'jsx',
			py: 'python', svelte: 'svelte', json: 'json', css: 'css',
			sh: 'bash', bash: 'bash', yml: 'yaml', yaml: 'yaml',
			md: 'markdown', html: 'html', sql: 'sql', rs: 'rust',
			go: 'go', rb: 'ruby', java: 'java', toml: 'toml'
		};
		return langMap[ext] ?? 'text';
	});

	// Lazy-load shiki and highlight
	$effect(() => {
		const currentCode = code;
		const currentLang = detectedLang;

		import('shiki').then(async ({ createHighlighter }) => {
			try {
				const highlighter = await createHighlighter({
					themes: ['github-dark-default'],
					langs: [currentLang]
				});
				highlighted = highlighter.codeToHtml(currentCode, {
					lang: currentLang,
					theme: 'github-dark-default'
				});
			} catch {
				// Fallback: plain text with escaping
				highlighted = `<pre class="shiki"><code>${escapeHtml(currentCode)}</code></pre>`;
			}
		});
	});

	function escapeHtml(s: string): string {
		return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
	}

	async function copyCode() {
		await navigator.clipboard.writeText(code);
		copied = true;
		setTimeout(() => (copied = false), 2000);
	}
</script>

<div class="relative h-full overflow-auto bg-[#0d1117]">
	<!-- Copy button -->
	<div class="absolute right-2 top-2 z-10">
		<Button variant="ghost" size="icon" class="h-7 w-7 text-zinc-400 hover:text-zinc-100" onclick={copyCode}>
			{#if copied}
				<Check class="h-3.5 w-3.5 text-green-400" />
			{:else}
				<Copy class="h-3.5 w-3.5" />
			{/if}
		</Button>
	</div>

	{#if highlighted}
		<div class="code-viewer">
			{@html highlighted}
		</div>
	{:else}
		<pre class="p-4 font-mono text-xs text-zinc-300">{code}</pre>
	{/if}
</div>

<style>
	.code-viewer :global(pre.shiki) {
		overflow-x: auto;
		padding: 1rem;
		font-size: 0.8125rem;
		line-height: 1.5;
		background: #0d1117 !important;
	}

	.code-viewer :global(pre.shiki code) {
		display: grid;
		min-width: 100%;
	}

	.code-viewer :global(pre.shiki .line) {
		display: inline-block;
		min-height: 1.25rem;
		padding: 0 0.5rem;
	}
</style>
