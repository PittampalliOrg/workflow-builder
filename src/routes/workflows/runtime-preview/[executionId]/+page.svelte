<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/state';

	let loading = $state(true);
	let errorMessage = $state('');
	let previewUrl = $state('');
	let pageUrl = $state('');

	async function startPreview() {
		loading = true;
		errorMessage = '';
		try {
			const executionId = page.params.executionId;
			const previewId = page.url.searchParams.get('previewId') ?? executionId;
			const response = await fetch(`/api/workflows/executions/${executionId}/sandbox-preview`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ previewId })
			});
			const payload = await response.json().catch(() => ({}));
			if (!response.ok || payload.success === false) {
				throw new Error(
					typeof payload.message === 'string'
						? payload.message
						: typeof payload.error === 'string'
							? payload.error
							: 'Failed to start sandbox preview'
				);
			}
			previewUrl = payload.proxyUrl;
			pageUrl = payload.pageUrl;
		} catch (error) {
			errorMessage = error instanceof Error ? error.message : 'Failed to start sandbox preview';
		} finally {
			loading = false;
		}
	}

	onMount(() => {
		void startPreview();
	});
</script>

<svelte:head>
	<title>Runtime Preview</title>
</svelte:head>

<div class="preview-shell">
	<header class="preview-header">
		<div>
			<h1>Runtime Preview</h1>
			<p>Interactive preview from the retained OpenShell workspace for this workflow execution.</p>
		</div>
		<div class="preview-actions">
			<button type="button" onclick={startPreview} disabled={loading}>
				{loading ? 'Starting…' : 'Restart Preview'}
			</button>
			{#if previewUrl}
				<a href={previewUrl} target="_blank" rel="noreferrer">Open Raw Preview</a>
			{/if}
		</div>
	</header>

	{#if errorMessage}
		<div class="preview-error">{errorMessage}</div>
	{:else if loading}
		<div class="preview-loading">Starting preview…</div>
	{:else if previewUrl}
		<iframe title="Runtime Preview" src={previewUrl} class="preview-frame"></iframe>
	{/if}

	{#if pageUrl}
		<p class="preview-footnote">Shareable page: {pageUrl}</p>
	{/if}
</div>

<style>
	.preview-shell {
		display: flex;
		flex-direction: column;
		gap: 1rem;
		height: 100%;
		padding: 1.25rem;
	}

	.preview-header {
		display: flex;
		justify-content: space-between;
		align-items: flex-start;
		gap: 1rem;
	}

	.preview-header h1 {
		margin: 0;
		font-size: 1.1rem;
	}

	.preview-header p {
		margin: 0.35rem 0 0;
		color: var(--muted-foreground, #666);
		font-size: 0.95rem;
	}

	.preview-actions {
		display: flex;
		gap: 0.75rem;
		align-items: center;
	}

	.preview-actions button,
	.preview-actions a {
		border: 1px solid #d0d7de;
		background: white;
		color: #111827;
		padding: 0.55rem 0.9rem;
		border-radius: 0.6rem;
		font: inherit;
		text-decoration: none;
		cursor: pointer;
	}

	.preview-actions button:disabled {
		cursor: progress;
		opacity: 0.7;
	}

	.preview-loading,
	.preview-error {
		border: 1px solid #e5e7eb;
		border-radius: 0.75rem;
		padding: 1rem;
		background: white;
	}

	.preview-error {
		color: #b42318;
	}

	.preview-frame {
		flex: 1 1 auto;
		width: 100%;
		min-height: 70vh;
		border: 1px solid #d0d7de;
		border-radius: 0.9rem;
		background: white;
	}

	.preview-footnote {
		margin: 0;
		font-size: 0.85rem;
		color: #667085;
	}
</style>
