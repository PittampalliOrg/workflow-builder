<script lang="ts">
	import { onMount } from 'svelte';
	import { Loader2 } from 'lucide-svelte';

	type Props = {
		patch: string;
		/** "side-by-side" or "line-by-line" (unified). */
		layout?: 'side-by-side' | 'line-by-line';
		class?: string;
	};

	const { patch, layout = 'line-by-line', class: className = '' }: Props = $props();

	let html = $state<string>('');
	let loading = $state(true);
	let errorMessage = $state<string | null>(null);

	// Lazy-import diff2html on mount so the ~100KB library only loads when the
	// drawer's Patch tab is opened. Bundle stays light for everyone else.
	onMount(async () => {
		await renderPatch();
	});

	$effect(() => {
		// Re-render when patch or layout changes after mount.
		if (patch !== undefined) {
			void renderPatch();
		}
	});

	async function renderPatch() {
		if (!patch || !patch.trim()) {
			html = '';
			loading = false;
			return;
		}
		loading = true;
		errorMessage = null;
		try {
			const [{ html: diffHtml }] = await Promise.all([
				import('diff2html'),
				// Side-effect import for the diff2html stylesheet — lazy-loaded
				// alongside the JS so consumers don't have to remember.
				import('diff2html/bundles/css/diff2html.min.css')
			]);
			html = diffHtml(patch, {
				drawFileList: false,
				matching: 'lines',
				outputFormat: layout,
				renderNothingWhenEmpty: false
			});
		} catch (err) {
			errorMessage = err instanceof Error ? err.message : String(err);
		} finally {
			loading = false;
		}
	}
</script>

{#if loading}
	<div class="flex items-center justify-center py-8">
		<Loader2 class="h-4 w-4 animate-spin text-muted-foreground" />
	</div>
{:else if errorMessage}
	<div class="px-3 py-4 text-xs text-destructive">Failed to render diff: {errorMessage}</div>
{:else if !html}
	<div class="px-3 py-6 text-center text-xs text-muted-foreground">No patch.</div>
{:else}
	<!-- diff2html outputs trusted HTML from a unified diff string; safe to inject. -->
	<div class="rendered-patch overflow-x-auto text-[11px] {className}">
		{@html html}
	</div>
{/if}

<style>
	/* Tighten diff2html's defaults to match the dark/light surfaces of the app. */
	.rendered-patch :global(.d2h-wrapper) {
		font-family:
			ui-monospace,
			SFMono-Regular,
			Menlo,
			Monaco,
			Consolas,
			'Liberation Mono',
			'Courier New',
			monospace;
		font-size: 11px;
	}
	.rendered-patch :global(.d2h-file-header) {
		padding: 6px 10px;
	}
	.rendered-patch :global(.d2h-file-name-wrapper),
	.rendered-patch :global(.d2h-file-name) {
		font-size: 11px;
	}
	.rendered-patch :global(.d2h-code-line),
	.rendered-patch :global(.d2h-code-side-line) {
		line-height: 1.4;
	}
</style>
