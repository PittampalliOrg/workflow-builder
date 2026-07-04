<script lang="ts">
	import { goto } from '$app/navigation';
	import { onMount, onDestroy } from 'svelte';
	import { page } from '$app/state';
	import { Alert, AlertDescription } from '$lib/components/ui/alert';
	import { Button } from '$lib/components/ui/button';
	import {
		AlertDialog,
		AlertDialogAction,
		AlertDialogCancel,
		AlertDialogContent,
		AlertDialogDescription,
		AlertDialogFooter,
		AlertDialogHeader,
		AlertDialogTitle
	} from '$lib/components/ui/alert-dialog';
	import { Container, Plus } from '@lucide/svelte';
	import DevEnvironmentCard, {
		type DevEnvironmentSummary
	} from '$lib/components/dev/dev-environment-card.svelte';
	import DevLaunchDialog from '$lib/components/dev/dev-launch-dialog.svelte';
	import VclusterPreviewPanel from '$lib/components/dev/vcluster-preview-panel.svelte';
	import PreviewRunFeedPanel from '$lib/components/dev/preview-run-feed-panel.svelte';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	const slug = $derived((page.params.slug as string) ?? 'default');

	let environments = $state<DevEnvironmentSummary[]>([]);
	let loading = $state(true);
	let errorMessage = $state<string | null>(null);
	let launchOpen = $state(false);
	let toTeardown = $state<DevEnvironmentSummary | null>(null);
	let busyId = $state<string | null>(null);
	let pollTimer: ReturnType<typeof setInterval> | null = null;

	async function load() {
		try {
			const res = await fetch('/api/dev-environments');
			if (!res.ok) {
				errorMessage = `Failed to load dev environments (${res.status})`;
				return;
			}
			const body = (await res.json()) as { environments: DevEnvironmentSummary[] };
			environments = body.environments ?? [];
			errorMessage = null;
		} catch (err) {
			errorMessage = err instanceof Error ? err.message : String(err);
		} finally {
			loading = false;
		}
	}

	function openEnv(env: DevEnvironmentSummary) {
		goto(`/workspaces/${slug}/dev/${env.executionId}`);
	}

	async function confirmTeardown() {
		if (!toTeardown) return;
		const env = toTeardown;
		busyId = env.executionId;
		toTeardown = null;
		try {
			const res = await fetch(`/api/dev-environments/${env.executionId}`, { method: 'DELETE' });
			if (!res.ok) {
				errorMessage = `Teardown failed (${res.status})`;
				return;
			}
			environments = environments.filter((e) => e.executionId !== env.executionId);
		} finally {
			busyId = null;
		}
	}

	function onLaunched(executionId: string) {
		goto(`/workspaces/${slug}/dev/${executionId}`);
	}

	onMount(() => {
		load();
		pollTimer = setInterval(load, 4000);
	});
	onDestroy(() => {
		if (pollTimer) clearInterval(pollTimer);
	});
</script>

<div class="h-full overflow-y-auto p-6 space-y-5 max-w-6xl mx-auto w-full">
	<header class="flex items-start justify-between gap-4 flex-wrap">
		<div>
			<h1 class="text-2xl font-semibold">Dev environments</h1>
			<p class="text-sm text-muted-foreground mt-1">
				Spin up a live, hot-reloading dev server for a microservice and drive it from an interactive
				coding-agent session — Dapr-coupled services run in an isolated shadow.
			</p>
		</div>
		<Button onclick={() => (launchOpen = true)}>
			<Plus class="size-4" /> Launch
		</Button>
	</header>

	{#if errorMessage}
		<Alert variant="destructive">
			<AlertDescription>{errorMessage}</AlertDescription>
		</Alert>
	{/if}

	<VclusterPreviewPanel />

	{#if data.previewRunFeedEnabled}
		<PreviewRunFeedPanel />
	{/if}

	{#if loading && environments.length === 0}
		<div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
			{#each Array(3) as _, i (i)}
				<div class="h-40 rounded-xl border bg-muted/30 animate-pulse"></div>
			{/each}
		</div>
	{:else if environments.length === 0}
		<div class="flex flex-col items-center justify-center py-16 space-y-3">
			<div class="size-14 rounded-full bg-primary/10 flex items-center justify-center">
				<Container class="size-6 text-primary" />
			</div>
			<h2 class="text-base font-semibold">No dev environments running</h2>
			<p class="text-muted-foreground text-sm max-w-md text-center">
				Launch one to get a live preview pod (vite / uvicorn / tsx watch) plus a coding agent that
				edits the code and hot-reloads it in seconds.
			</p>
			<Button onclick={() => (launchOpen = true)}>
				<Plus class="size-4" /> Launch dev environment
			</Button>
		</div>
	{:else}
		<div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
			{#each environments as env (env.executionId)}
				<DevEnvironmentCard
					environment={env}
					{slug}
					busy={busyId === env.executionId}
					onopen={openEnv}
					onteardown={(e) => (toTeardown = e)}
				/>
			{/each}
		</div>
	{/if}
</div>

<DevLaunchDialog
	bind:open={launchOpen}
	services={data.services}
	devWorkflowId={data.devWorkflowId}
	devWorkflowName={data.devWorkflowName}
	onlaunched={onLaunched}
/>

<AlertDialog open={toTeardown !== null} onOpenChange={(open) => !open && (toTeardown = null)}>
	<AlertDialogContent>
		<AlertDialogHeader>
			<AlertDialogTitle>Tear down {toTeardown?.service}?</AlertDialogTitle>
			<AlertDialogDescription>
				Deletes the preview pod and purges the interactive session. This can't be undone.
			</AlertDialogDescription>
		</AlertDialogHeader>
		<AlertDialogFooter>
			<AlertDialogCancel>Cancel</AlertDialogCancel>
			<AlertDialogAction onclick={confirmTeardown}>Tear down</AlertDialogAction>
		</AlertDialogFooter>
	</AlertDialogContent>
</AlertDialog>
