<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/state';

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

	function defaultDevServerCommand(baseUrl: string): string {
		try {
			const parsed = new URL(baseUrl);
			return parsed.port ? `npm run dev -- --host 0.0.0.0 --port ${parsed.port}` : '';
		} catch {
			return '';
		}
	}

	function previewStartBody(): Record<string, string | number> {
		const body: Record<string, string | number> = { previewId: previewId() };
		const repoPath = queryParam('repoPath');
		const installCommand = queryParam('installCommand');
		const baseUrl = queryParam('baseUrl');
		const devServerCommand = queryParam('devServerCommand') || defaultDevServerCommand(baseUrl);
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

	{#if errorMessage}
		<div class="preview-error">{errorMessage}</div>
	{:else if statusMessage}
		<div class="preview-status">{statusMessage}</div>
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
	.preview-status,
	.preview-error {
		border: 1px solid #e5e7eb;
		border-radius: 0.75rem;
		padding: 1rem;
		background: white;
	}

	.preview-error {
		color: #b42318;
	}

	.preview-status {
		color: #166534;
	}

	.preview-meta {
		display: grid;
		gap: 0.4rem;
		border: 1px solid #e5e7eb;
		border-radius: 0.75rem;
		padding: 0.9rem 1rem;
		background: white;
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
