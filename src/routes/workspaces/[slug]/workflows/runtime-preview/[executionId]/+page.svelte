<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import StatusPill from '$lib/components/shared/status-pill.svelte';

	let loading = $state(true);
	let stopping = $state(false);
	let errorMessage = $state('');
	let previewUrl = $state('');
	let pageUrl = $state('');
	let workspaceRef = $state('');
	let workingDir = $state('');
	let provider = $state('');
	let statusMessage = $state('');

	function previewId(): string {
		return page.url.searchParams.get('previewId') ?? page.params.executionId ?? '';
	}

	function queryParam(name: string): string {
		return page.url.searchParams.get(name)?.trim() ?? '';
	}

	function previewStartBody(): Record<string, string | number> {
		const body: Record<string, string | number> = { previewId: previewId() };
		const repoPath = queryParam('repoPath');
		const installCommand = queryParam('installCommand');
		const baseUrl = queryParam('baseUrl');
		// Only forward an explicit devServerCommand if the URL carries one.
		// Otherwise let the runtime auto-detect via _local_devserver_runner.
		// Forcing `npm run dev` here breaks static sites that have no
		// package.json (npm ENOENTs on the missing manifest).
		const devServerCommand = queryParam('devServerCommand');
		const timeoutSeconds = Number(queryParam('timeoutSeconds'));

		if (repoPath) body.repoPath = repoPath;
		if (installCommand) body.installCommand = installCommand;
		if (devServerCommand) body.devServerCommand = devServerCommand;
		if (baseUrl) body.baseUrl = baseUrl;
		if (Number.isFinite(timeoutSeconds) && timeoutSeconds > 0) {
			body.timeoutSeconds = timeoutSeconds;
		}

		return body;
	}

	async function startPreview() {
		loading = true;
		errorMessage = '';
		statusMessage = '';
		try {
			const executionId = page.params.executionId;
			const response = await fetch(`/api/workflows/executions/${executionId}/sandbox-preview`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(previewStartBody())
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
			pageUrl = globalThis.location?.href ?? payload.pageUrl;
			workspaceRef = payload.workspaceRef ?? '';
			workingDir = payload.workingDir ?? '';
			provider = payload.provider ?? '';
		} catch (error) {
			errorMessage = error instanceof Error ? error.message : 'Failed to start sandbox preview';
		} finally {
			loading = false;
		}
	}

	async function stopPreview() {
		stopping = true;
		errorMessage = '';
		statusMessage = '';
		try {
			const executionId = page.params.executionId;
			const response = await fetch(
				`/api/workflows/executions/${executionId}/sandbox-preview?previewId=${encodeURIComponent(previewId())}`,
				{ method: 'DELETE' }
			);
			const payload = await response.json().catch(() => ({}));
			if (!response.ok || payload.success === false) {
				throw new Error(
					typeof payload.message === 'string'
						? payload.message
						: typeof payload.error === 'string'
							? payload.error
							: 'Failed to stop sandbox preview'
				);
			}
			previewUrl = '';
			statusMessage = 'Preview stopped';
		} catch (error) {
			errorMessage = error instanceof Error ? error.message : 'Failed to stop sandbox preview';
		} finally {
			stopping = false;
		}
	}

	// Single derived state for the shared StatusPill (replaces the ad-hoc
	// green/red status divs).
	const previewState = $derived(
		errorMessage
			? 'error'
			: stopping
				? 'stopping'
				: loading
					? 'starting'
					: previewUrl
						? 'running'
						: statusMessage
							? 'stopped'
							: 'idle'
	);

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
			<button type="button" onclick={stopPreview} disabled={loading || stopping || !previewUrl}>
				{stopping ? 'Stopping…' : 'Stop Preview'}
			</button>
			{#if previewUrl}
				<a href={previewUrl} target="_blank" rel="noreferrer">Open Raw Preview</a>
			{/if}
		</div>
	</header>

	{#if workspaceRef || workingDir}
		<div class="preview-meta">
			{#if workspaceRef}
				<p><strong>Workspace:</strong> <code>{workspaceRef}</code></p>
			{/if}
			{#if workingDir}
				<p><strong>Working Dir:</strong> <code>{workingDir}</code></p>
			{/if}
			{#if provider}
				<p><strong>Provider:</strong> <code>{provider}</code></p>
			{/if}
		</div>
	{/if}

	<div class="preview-state">
		<StatusPill status={previewState} />
		{#if errorMessage}
			<span class="preview-state-error">{errorMessage}</span>
		{:else if statusMessage}
			<span class="preview-state-muted">{statusMessage}</span>
		{:else if loading}
			<span class="preview-state-muted">Starting preview…</span>
		{/if}
	</div>
	{#if previewUrl && !errorMessage}
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
		color: var(--muted-foreground);
		font-size: 0.95rem;
	}

	.preview-actions {
		display: flex;
		gap: 0.75rem;
		align-items: center;
	}

	.preview-actions button,
	.preview-actions a {
		border: 1px solid var(--border);
		background: var(--card);
		color: var(--foreground);
		padding: 0.55rem 0.9rem;
		border-radius: var(--radius);
		font: inherit;
		text-decoration: none;
		cursor: pointer;
	}

	.preview-actions button:disabled {
		cursor: progress;
		opacity: 0.7;
	}

	.preview-state {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		flex-wrap: wrap;
	}

	.preview-state-error {
		color: var(--destructive);
		font-size: 0.9rem;
	}

	.preview-state-muted {
		color: var(--muted-foreground);
		font-size: 0.9rem;
	}

	.preview-meta {
		display: grid;
		gap: 0.4rem;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		padding: 0.9rem 1rem;
		background: var(--card);
		font-size: 0.9rem;
	}

	.preview-meta p {
		margin: 0;
	}

	.preview-meta code {
		font-family: var(--font-mono, ui-monospace, SFMono-Regular, monospace);
		font-size: 0.85rem;
		word-break: break-all;
	}

	.preview-frame {
		flex: 1 1 auto;
		width: 100%;
		min-height: 70vh;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		background: var(--card);
	}

	.preview-footnote {
		margin: 0;
		font-size: 0.85rem;
		color: var(--muted-foreground);
	}
</style>
