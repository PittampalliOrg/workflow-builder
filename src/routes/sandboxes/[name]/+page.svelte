<script lang="ts">
	import { page } from '$app/state';
	import { Button } from '$lib/components/ui/button';
	import * as Tabs from '$lib/components/ui/tabs';
	import { ArrowLeft, Trash2, Loader2, Container, RefreshCw } from 'lucide-svelte';
	import { createSandboxDetailStream } from '$lib/stores/sandbox-detail-stream.svelte';
	import SandboxPhaseBadge from '$lib/components/sandbox/sandbox-phase-badge.svelte';
	import SandboxLogViewer from '$lib/components/sandbox/sandbox-log-viewer.svelte';
	import SandboxTerminal from '$lib/components/sandbox/sandbox-terminal.svelte';
	import { goto } from '$app/navigation';

	const sandboxName = $derived(decodeURIComponent(page.params.name ?? ''));
	const stream = $derived(createSandboxDetailStream(sandboxName));

	let deleting = $state(false);
	let activeTab = $state('logs');

	async function deleteSandbox() {
		deleting = true;
		try {
			await fetch(`/api/sandboxes/${encodeURIComponent(sandboxName)}`, {
				method: 'DELETE'
			});
			goto('/sandboxes');
		} catch {
			deleting = false;
		}
	}

	function formatAge(createdAt: string | undefined): string {
		if (!createdAt) return '';
		try {
			const ms = Date.now() - new Date(createdAt).getTime();
			if (ms < 0) return 'just now';
			const mins = Math.floor(ms / 60000);
			if (mins < 1) return 'just now';
			if (mins < 60) return `${mins}m ago`;
			const hrs = Math.floor(mins / 60);
			if (hrs < 24) return `${hrs}h ${mins % 60}m ago`;
			const days = Math.floor(hrs / 24);
			return `${days}d ${hrs % 24}h ago`;
		} catch {
			return createdAt;
		}
	}
</script>

<div class="flex h-full flex-col">
	<!-- Header -->
	<header class="flex h-12 items-center justify-between border-b border-border px-6">
		<div class="flex items-center gap-3">
			<a href="/sandboxes" class="text-muted-foreground hover:text-foreground">
				<ArrowLeft class="h-4 w-4" />
			</a>
			<span class="text-xs text-muted-foreground">/</span>
			<h1 class="font-mono text-sm font-semibold tracking-tight">{sandboxName}</h1>

			{#if stream.status}
				<SandboxPhaseBadge phase={stream.status.phase} />
			{/if}

			<div
				class="h-2 w-2 rounded-full {stream.isConnected ? 'bg-green-500' : stream.isStreaming ? 'bg-yellow-500' : 'bg-red-500'}"
				title={stream.isConnected ? 'Connected' : stream.isStreaming ? 'Reconnecting...' : 'Disconnected'}
			></div>
		</div>

		<div class="flex items-center gap-2">
			{#if stream.status?.type}
				<span class="text-xs text-muted-foreground">{stream.status.type}</span>
			{/if}
			{#if stream.status?.createdAt}
				<span class="text-xs text-muted-foreground">{formatAge(stream.status.createdAt)}</span>
			{/if}
			<Button
				variant="outline"
				size="sm"
				class="text-destructive hover:text-destructive"
				onclick={deleteSandbox}
				disabled={deleting}
			>
				{#if deleting}
					<Loader2 class="mr-1 h-3.5 w-3.5 animate-spin" />
				{:else}
					<Trash2 class="mr-1 h-3.5 w-3.5" />
				{/if}
				Delete
			</Button>
		</div>
	</header>

	<!-- Content -->
	<div class="flex flex-1 flex-col overflow-hidden">
		<svelte:boundary>
		{#if !stream.isStreaming && !stream.error}
			<div class="flex flex-col items-center justify-center py-12 gap-2">
				<Loader2 class="h-6 w-6 animate-spin text-muted-foreground" />
				<p class="text-sm text-muted-foreground">Connecting to sandbox...</p>
			</div>
		{:else if stream.notFound}
			<div class="flex flex-col items-center justify-center py-16 text-center">
				<Container class="mb-4 h-12 w-12 text-muted-foreground/50" />
				<h2 class="text-lg font-medium text-foreground">Sandbox not found</h2>
				<p class="mt-1 text-sm text-muted-foreground">
					{sandboxName} may have been deleted or garbage collected.
				</p>
				<Button variant="outline" size="sm" class="mt-4" href="/sandboxes">
					Back to sandboxes
				</Button>
			</div>
		{:else if !stream.isStreaming && stream.error}
			<div class="flex flex-col items-center justify-center py-16 text-center">
				<Container class="mb-4 h-12 w-12 text-muted-foreground/50" />
				<h2 class="text-lg font-medium text-foreground">Unable to connect</h2>
				<p class="mt-1 text-sm text-muted-foreground">
					Could not reach the sandbox runtime.
				</p>
			</div>
		{:else}
			<Tabs.Root bind:value={activeTab} class="flex flex-1 flex-col overflow-hidden">
				<Tabs.List class="mx-6 mt-3">
					<Tabs.Trigger value="logs">
						Logs
						{#if stream.logs.length > 0}
							<span class="ml-1 text-xs text-muted-foreground">({stream.logs.length})</span>
						{/if}
					</Tabs.Trigger>
					<Tabs.Trigger value="events">
						Events
						{#if stream.events.length > 0}
							<span class="ml-1 text-xs text-muted-foreground">({stream.events.length})</span>
						{/if}
					</Tabs.Trigger>
					<Tabs.Trigger value="terminal">Terminal</Tabs.Trigger>
				</Tabs.List>

				<Tabs.Content value="logs" class="flex-1 overflow-hidden p-6 pt-3">
					<SandboxLogViewer logs={stream.logs} />
				</Tabs.Content>

				<Tabs.Content value="events" class="flex-1 overflow-hidden p-6 pt-3">
					<div class="h-full overflow-auto rounded border border-border">
						{#if stream.events.length === 0}
							<div class="flex items-center justify-center py-12 text-sm text-muted-foreground">
								Waiting for events...
							</div>
						{:else}
							<div class="divide-y divide-border">
								{#each stream.events as event}
									<div class="flex items-start gap-3 px-4 py-2.5">
										<span class="shrink-0 text-xs text-muted-foreground/60">
											{event.timestamp}
										</span>
										{#if event.reason}
											<span class="shrink-0 rounded bg-muted px-1.5 py-0.5 text-xs font-medium">
												{event.reason}
											</span>
										{/if}
										<span class="text-sm text-foreground/80">{event.message}</span>
										{#if event.source}
											<span class="ml-auto shrink-0 text-xs text-muted-foreground">
												{event.source}
											</span>
										{/if}
									</div>
								{/each}
							</div>
						{/if}
					</div>
				</Tabs.Content>

				<Tabs.Content value="terminal" class="flex-1 overflow-hidden p-6 pt-3">
					<SandboxTerminal {sandboxName} />
				</Tabs.Content>
			</Tabs.Root>
		{/if}

		{#snippet failed(error, reset)}
			<div class="flex flex-col items-center justify-center py-16 text-center">
				<h2 class="text-lg font-medium text-foreground">Something went wrong</h2>
				<p class="mt-1 text-sm text-muted-foreground">
					{(error as Error)?.message ?? 'Failed to load sandbox details.'}
				</p>
				<button onclick={reset} class="mt-4 rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted">
					Try again
				</button>
			</div>
		{/snippet}
		</svelte:boundary>
	</div>
</div>
