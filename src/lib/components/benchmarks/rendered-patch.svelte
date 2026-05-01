<script lang="ts">
	import { onMount } from 'svelte';
	import { Loader2 } from '@lucide/svelte';

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

	/*
	 * Explicit light-mode color baseline.
	 *
	 * The drawer that hosts the patch uses `text-popover-foreground`, which
	 * inherits down into the diff2html DOM. If a parent or sibling style
	 * stomps on that inheritance, code rows can come out unreadable
	 * (white-on-white in light mode, observed). Lock the colors here so
	 * patches always render correctly regardless of host context.
	 */
	.rendered-patch :global(.d2h-wrapper) {
		color: #1f2937;
	}
	.rendered-patch :global(.d2h-cntx),
	.rendered-patch :global(.d2h-code-line.d2h-cntx),
	.rendered-patch :global(.d2h-code-side-line.d2h-cntx),
	.rendered-patch :global(.d2h-code-line-ctn) {
		color: #1f2937;
	}
	.rendered-patch :global(.d2h-ins),
	.rendered-patch :global(.d2h-code-line.d2h-ins),
	.rendered-patch :global(.d2h-code-side-line.d2h-ins) {
		color: #14532d;
	}
	.rendered-patch :global(.d2h-del),
	.rendered-patch :global(.d2h-code-line.d2h-del),
	.rendered-patch :global(.d2h-code-side-line.d2h-del) {
		color: #7f1d1d;
	}
	.rendered-patch :global(.d2h-info),
	.rendered-patch :global(.d2h-code-line.d2h-info),
	.rendered-patch :global(.d2h-code-side-line.d2h-info) {
		color: #1e40af;
	}

	/*
	 * Dark-mode overrides for diff2html.
	 *
	 * diff2html ships with hard-coded near-white backgrounds and near-black text,
	 * which makes patches unreadable when the app is in dark mode (`.dark` on
	 * <html>). The selectors below flip every diff2html surface to dark-friendly
	 * colors aligned with our neutral palette. Light mode keeps diff2html's
	 * defaults.
	 */
	:global(.dark) .rendered-patch :global(.d2h-wrapper) {
		color: #e5e5e5;
		background: transparent;
	}
	:global(.dark) .rendered-patch :global(.d2h-file-list-wrapper),
	:global(.dark) .rendered-patch :global(.d2h-files-diff),
	:global(.dark) .rendered-patch :global(.d2h-file-diff),
	:global(.dark) .rendered-patch :global(.d2h-diff-table) {
		background: transparent;
		color: inherit;
	}
	:global(.dark) .rendered-patch :global(.d2h-file-header) {
		background-color: #171717;
		border-color: #262626;
		color: #fafafa;
	}
	:global(.dark) .rendered-patch :global(.d2h-file-name),
	:global(.dark) .rendered-patch :global(.d2h-file-name-wrapper),
	:global(.dark) .rendered-patch :global(.d2h-file-stats) {
		color: #fafafa;
	}
	:global(.dark) .rendered-patch :global(.d2h-tag) {
		background-color: #262626;
		color: #d4d4d4;
		border-color: #404040;
	}
	:global(.dark) .rendered-patch :global(.d2h-cntx),
	:global(.dark) .rendered-patch :global(.d2h-code-line.d2h-cntx),
	:global(.dark) .rendered-patch :global(.d2h-code-side-line.d2h-cntx) {
		background-color: #0a0a0a;
		color: #d4d4d4;
		border-color: #1f1f1f;
	}
	:global(.dark) .rendered-patch :global(.d2h-emptyplaceholder),
	:global(.dark) .rendered-patch :global(.d2h-code-line.d2h-emptyplaceholder),
	:global(.dark) .rendered-patch :global(.d2h-code-side-line.d2h-emptyplaceholder),
	:global(.dark) .rendered-patch :global(.d2h-code-side-emptyplaceholder),
	:global(.dark) .rendered-patch :global(.d2h-code-line-prefix.d2h-emptyplaceholder) {
		background-color: #0a0a0a;
		border-color: #1f1f1f;
	}
	:global(.dark) .rendered-patch :global(.d2h-ins),
	:global(.dark) .rendered-patch :global(.d2h-code-line.d2h-ins),
	:global(.dark) .rendered-patch :global(.d2h-code-side-line.d2h-ins) {
		background-color: rgba(34, 197, 94, 0.12);
		color: #bbf7d0;
		border-color: rgba(34, 197, 94, 0.25);
	}
	:global(.dark) .rendered-patch :global(.d2h-ins.d2h-change),
	:global(.dark) .rendered-patch :global(.d2h-code-line.d2h-ins.d2h-change),
	:global(.dark) .rendered-patch :global(.d2h-code-side-line.d2h-ins.d2h-change) {
		background-color: rgba(34, 197, 94, 0.18);
	}
	:global(.dark) .rendered-patch :global(.d2h-ins-light),
	:global(.dark) .rendered-patch :global(del.d2h-change) {
		background-color: rgba(34, 197, 94, 0.06);
	}
	:global(.dark) .rendered-patch :global(ins) {
		background-color: rgba(34, 197, 94, 0.32);
		color: #dcfce7;
	}
	:global(.dark) .rendered-patch :global(.d2h-del),
	:global(.dark) .rendered-patch :global(.d2h-code-line.d2h-del),
	:global(.dark) .rendered-patch :global(.d2h-code-side-line.d2h-del) {
		background-color: rgba(239, 68, 68, 0.12);
		color: #fecaca;
		border-color: rgba(239, 68, 68, 0.25);
	}
	:global(.dark) .rendered-patch :global(.d2h-del.d2h-change),
	:global(.dark) .rendered-patch :global(.d2h-code-line.d2h-del.d2h-change),
	:global(.dark) .rendered-patch :global(.d2h-code-side-line.d2h-del.d2h-change) {
		background-color: rgba(239, 68, 68, 0.18);
	}
	:global(.dark) .rendered-patch :global(.d2h-del-light) {
		background-color: rgba(239, 68, 68, 0.06);
	}
	:global(.dark) .rendered-patch :global(del) {
		background-color: rgba(239, 68, 68, 0.32);
		color: #fee2e2;
	}
	:global(.dark) .rendered-patch :global(.d2h-info),
	:global(.dark) .rendered-patch :global(.d2h-code-line.d2h-info),
	:global(.dark) .rendered-patch :global(.d2h-code-side-line.d2h-info) {
		background-color: #1e293b;
		color: #cbd5e1;
		border-color: #334155;
	}
	:global(.dark) .rendered-patch :global(.d2h-code-linenumber),
	:global(.dark) .rendered-patch :global(.d2h-code-side-linenumber) {
		background-color: #0a0a0a;
		color: #737373;
		border-color: #1f1f1f;
	}
	:global(.dark) .rendered-patch :global(.d2h-code-line-prefix) {
		color: #737373;
		background: transparent;
	}
	:global(.dark) .rendered-patch :global(.d2h-code-line-ctn) {
		color: inherit;
	}
	:global(.dark) .rendered-patch :global(.d2h-diff-tbody) {
		border-color: #1f1f1f;
	}
	:global(.dark) .rendered-patch :global(.d2h-file-side-diff + .d2h-file-side-diff) {
		border-left-color: #1f1f1f;
	}
	/* Hover state */
	:global(.dark) .rendered-patch :global(tr:hover .d2h-code-linenumber),
	:global(.dark) .rendered-patch :global(tr:hover .d2h-code-side-linenumber) {
		background-color: #171717;
	}
</style>
