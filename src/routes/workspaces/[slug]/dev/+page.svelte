<script lang="ts">
	import { goto } from '$app/navigation';
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
	import { Container, Plus, Radio } from '@lucide/svelte';
	import DevEnvironmentCard, {
		type DevEnvironmentSummary
	} from '$lib/components/dev/dev-environment-card.svelte';
	import DevLaunchDialog from '$lib/components/dev/dev-launch-dialog.svelte';
	import VclusterPreviewPanel from '$lib/components/dev/vcluster-preview-panel.svelte';
	import PrPreviewsPanel from '$lib/components/dev/pr-previews-panel.svelte';
	import PreviewRunFeedPanel from '$lib/components/dev/preview-run-feed-panel.svelte';
	import { getDevEnvironmentGroups, getPrPreviews, getVclusterPreviews } from './data.remote';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	const slug = $derived((page.params.slug as string) ?? 'default');

	// One query per surface (dev grid, vcluster previews + counts, PR previews),
	// driven by a single visibility-gated 5s tick — replaces the old 4s blanket poll.
	const groupsQuery = getDevEnvironmentGroups();
	const vclusterQuery = getVclusterPreviews();
	const prPreviewsQuery = getPrPreviews();

	const groups = $derived(groupsQuery.current ?? []);
	const firstLoad = $derived(groupsQuery.current === undefined);
	const vcluster = $derived(vclusterQuery.current);
	const prPreviews = $derived(prPreviewsQuery.current);

	let launchOpen = $state(false);
	let toTeardown = $state<DevEnvironmentSummary | null>(null);
	let busyId = $state<string | null>(null);
	let errorMessage = $state<string | null>(null);

	async function tick() {
		await Promise.all([
			groupsQuery.refresh(),
			vclusterQuery.refresh(),
			prPreviewsQuery.refresh()
		]);
	}

	$effect(() => {
		if (typeof document === 'undefined') return;
		let timer: ReturnType<typeof setInterval> | null = null;
		const start = () => {
			if (timer === null) timer = setInterval(tick, 5000);
		};
		const stop = () => {
			if (timer !== null) {
				clearInterval(timer);
				timer = null;
			}
		};
		const onVisibility = () => {
			if (document.visibilityState === 'visible') {
				void tick();
				start();
			} else {
				stop();
			}
		};
		onVisibility();
		document.addEventListener('visibilitychange', onVisibility);
		return () => {
			stop();
			document.removeEventListener('visibilitychange', onVisibility);
		};
	});

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
			await groupsQuery.refresh();
		} finally {
			busyId = null;
		}
	}

	function onLaunched(executionId: string) {
		goto(`/workspaces/${slug}/dev/${executionId}`);
	}
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

	<VclusterPreviewPanel
		previews={vcluster?.previews ?? []}
		counts={vcluster?.counts ?? null}
		readProxyEnabled={data.previewReadProxyEnabled}
		{slug}
		onchanged={() => void vclusterQuery.refresh()}
	/>

	<PrPreviewsPanel enabled={prPreviews?.enabled ?? false} items={prPreviews?.items ?? []} />

	{#if data.previewRunFeedEnabled}
		<PreviewRunFeedPanel />
	{:else}
		<section class="rounded-xl border border-dashed bg-card p-4">
			<div class="flex items-center gap-2 text-sm text-muted-foreground">
				<Radio class="size-4" />
				Cross-preview live run feed is off. Set
				<code class="text-xs">PREVIEW_RUN_FEED_ENABLED=1</code> to stream every preview's workflow runs
				here.
			</div>
		</section>
	{/if}

	{#if firstLoad}
		<div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
			{#each Array(3) as _, i (i)}
				<div class="h-40 rounded-xl border bg-muted/30 animate-pulse"></div>
			{/each}
		</div>
	{:else if groups.length === 0}
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
			{#each groups as group (group.executionId)}
				<DevEnvironmentCard
					environment={group.primary}
					services={group.services}
					{slug}
					busy={busyId === group.executionId}
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
