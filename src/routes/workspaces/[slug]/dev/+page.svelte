<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { onMount, untrack } from 'svelte';
	import { Alert, AlertDescription } from '$lib/components/ui/alert';
	import { Button } from '$lib/components/ui/button';
	import { Badge } from '$lib/components/ui/badge';
	import { Tabs, TabsContent, TabsList, TabsTrigger } from '$lib/components/ui/tabs';
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
	import {
		Activity,
		Boxes,
		CheckCircle2,
		Container,
		GitPullRequest,
		Loader2,
		Plus,
		Radio,
		Workflow
	} from '@lucide/svelte';
	import DevContextHeader from '$lib/components/dev/dev-context-header.svelte';
	import DevEnvironmentCard, {
		type DevEnvironmentSummary
	} from '$lib/components/dev/dev-environment-card.svelte';
	import DevLaunchDialog from '$lib/components/dev/dev-launch-dialog.svelte';
	import VclusterPreviewPanel from '$lib/components/dev/vcluster-preview-panel.svelte';
	import PrPreviewsPanel from '$lib/components/dev/pr-previews-panel.svelte';
	import PreviewRunFeedPanel from '$lib/components/dev/preview-run-feed-panel.svelte';
	import {
		pendingDevEnvironmentTeardowns,
		teardownDevEnvironmentUntilComplete,
		type DevEnvironmentTeardownProgress
	} from '$lib/dev-environment-teardown';
	import {
		getDevEnvironmentGroups,
		getPrPreviews,
		getVclusterPreview,
		getVclusterPreviews
	} from './data.remote';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	const slug = $derived((page.params.slug as string) ?? 'default');
	const previewEnvironmentId = untrack(() => data.previewEnvironment?.id ?? null);
	const controlPlane = previewEnvironmentId === null;

	// One query per surface (dev grid, vcluster previews + counts, PR previews),
	// driven by a single visibility-gated 5s tick — replaces the old 4s blanket poll.
	const groupsQuery = getDevEnvironmentGroups();
	const vclusterQuery = previewEnvironmentId
		? getVclusterPreview(previewEnvironmentId)
		: getVclusterPreviews();
	const prPreviewsQuery = controlPlane ? getPrPreviews() : null;

	const groups = $derived(groupsQuery.current ?? []);
	const firstLoad = $derived(groupsQuery.current === undefined);
	const vcluster = $derived(vclusterQuery.current);
	const prPreviews = $derived(prPreviewsQuery?.current);
	const visiblePreviews = $derived(
		(vcluster?.previews ?? []).filter(
			(preview) => controlPlane || preview.name === previewEnvironmentId
		)
	);
	const visibleCounts = $derived(controlPlane ? (vcluster?.counts ?? null) : null);

	let launchOpen = $state(false);
	let activeTab = $state<'environments' | 'activity' | 'pull-requests'>('environments');
	let toTeardown = $state<DevEnvironmentSummary | null>(null);
	let busyId = $state<string | null>(null);
	let teardownProgress = $state<DevEnvironmentTeardownProgress | null>(null);
	let teardownDiscardUncaptured = $state(false);

	$effect(() => {
		if (!page.url.searchParams.has('launch')) return;
		launchOpen = true;
		if (typeof window !== 'undefined') {
			const next = new URL(window.location.href);
			next.searchParams.delete('launch');
			window.history.replaceState(window.history.state, '', next.pathname + next.search);
		}
	});
	let errorMessage = $state<string | null>(null);
	let operationNotice = $state<string | null>(null);
	let refreshErrorMessage = $state<string | null>(null);
	let refreshing = $state(false);
	let lastRefreshedAt = $state<number | null>(null);
	const surfaceError = $derived(errorMessage ?? refreshErrorMessage);

	let liveSyncProof = $state(false);
	onMount(() => {
		void (async () => {
			try {
				const res = await fetch('/api/health', { headers: { 'cache-control': 'no-store' } });
				if (res.ok) {
					const body = await res.json();
					if (body?.liveSyncProof) liveSyncProof = true;
				}
			} catch {
				/* non-fatal — proof is best-effort */
			}
		})();
	});

	async function tick() {
		if (refreshing) return;
		refreshing = true;
		try {
			const refreshes: Promise<unknown>[] = [groupsQuery.refresh(), vclusterQuery.refresh()];
			if (prPreviewsQuery) refreshes.push(prPreviewsQuery.refresh());
			await Promise.all(refreshes);
			lastRefreshedAt = Date.now();
			refreshErrorMessage = null;
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			refreshErrorMessage = `Lifecycle refresh failed: ${detail}. Showing the last successful snapshot.`;
		} finally {
			refreshing = false;
		}
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
				untrack(() => void tick());
				start();
			} else {
				stop();
			}
		};
		untrack(onVisibility);
		document.addEventListener('visibilitychange', onVisibility);
		return () => {
			stop();
			document.removeEventListener('visibilitychange', onVisibility);
		};
	});

	function openEnv(env: DevEnvironmentSummary) {
		goto(`/workspaces/${slug}/dev/${env.executionId}`);
	}

	function teardownProgressMessage(
		progress: DevEnvironmentTeardownProgress,
		discardUncaptured: boolean
	): string {
		switch (progress) {
			case 'submitting':
				return discardUncaptured
					? 'Discarding uncaptured changes and starting cleanup…'
					: 'Preserving the latest live-sync generation…';
			case 'reconciling':
				return 'Connection changed. Verifying the durable teardown receipt…';
			case 'pending':
				return discardUncaptured
					? 'Discard accepted. Finalizing cleanup…'
					: 'Checkpoint accepted. Finalizing cleanup…';
			case 'complete':
				return 'Cleanup confirmed. Refreshing environments…';
		}
	}

	async function runTeardown(executionId: string, discardUncaptured = false) {
		if (busyId) return;
		busyId = executionId;
		teardownProgress = null;
		teardownDiscardUncaptured = discardUncaptured;
		errorMessage = null;
		operationNotice = null;
		let completed = false;
		try {
			await teardownDevEnvironmentUntilComplete(executionId, {
				discardUncaptured,
				onProgress: (progress) => (teardownProgress = progress)
			});
			completed = true;
			errorMessage = null;
		} catch (error) {
			errorMessage = error instanceof Error ? error.message : String(error);
		}

		if (completed) {
			operationNotice = 'Cleanup is confirmed. Refreshing the environment list…';
			try {
				await groupsQuery.refresh();
				operationNotice = null;
			} catch {
				operationNotice =
					'Cleanup is confirmed, but this view could not refresh. Use Refresh to load the current environment list.';
			}
		}
		busyId = null;
		teardownProgress = null;
	}

	async function confirmTeardown() {
		if (!toTeardown) return;
		const env = toTeardown;
		toTeardown = null;
		await runTeardown(env.executionId);
	}

	onMount(() => {
		void (async () => {
			for (const pending of pendingDevEnvironmentTeardowns()) {
				await runTeardown(pending.executionId, pending.discardUncaptured);
			}
		})();
	});

	function onLaunched(executionId: string) {
		goto(`/workspaces/${slug}/dev/${executionId}`);
	}
</script>

<svelte:head>
	<title>Development · Workflow Builder</title>
</svelte:head>

<div class="flex h-full min-h-0 flex-col overflow-hidden">
	<DevContextHeader
		previews={visiblePreviews}
		{groups}
		counts={visibleCounts}
		previewEnvironment={data.previewEnvironment}
		previewRunFeedEnabled={controlPlane && data.previewRunFeedEnabled}
		{slug}
		{lastRefreshedAt}
		{refreshing}
		onrefresh={() => void tick()}
		onlaunch={() => (launchOpen = true)}
	/>

	{#if surfaceError}
		<div class="px-5 pt-3 lg:px-6">
			<Alert variant="destructive">
				<AlertDescription>{surfaceError}</AlertDescription>
			</Alert>
		</div>
	{/if}
	{#if liveSyncProof}
		<div class="px-5 pt-3 lg:px-6">
			<p class="text-xs text-muted-foreground">Live sync proof: ARCHAPP-0715E-HMR-1</p>
		</div>
	{/if}
	{#if operationNotice}
		<div class="px-5 pt-3 lg:px-6">
			<Alert>
				<CheckCircle2 class="size-4 text-emerald-600 dark:text-emerald-400" />
				<AlertDescription role="status" aria-live="polite">
					{operationNotice}
				</AlertDescription>
			</Alert>
		</div>
	{/if}
	{#if busyId && teardownProgress}
		<div class="px-5 pt-3 lg:px-6">
			<Alert>
				<Loader2 class="size-4 motion-safe:animate-spin" />
				<AlertDescription role="status" aria-live="polite" aria-atomic="true">
					{teardownProgressMessage(teardownProgress, teardownDiscardUncaptured)}
				</AlertDescription>
			</Alert>
		</div>
	{/if}

	<Tabs bind:value={activeTab} class="flex min-h-0 flex-1 flex-col gap-0">
		<div class="overflow-x-auto border-b px-5 py-2 lg:px-6">
			<TabsList class="h-9 min-w-max">
				<TabsTrigger value="environments" class="gap-1.5 text-xs">
				<Boxes class="size-3.5" /> Environments
				<Badge variant="secondary" class="ml-1 h-4 px-1 text-[10px]">{visiblePreviews.length + groups.length}</Badge>
			</TabsTrigger>
			{#if controlPlane}
				<TabsTrigger value="activity" class="gap-1.5 text-xs">
					<Activity class="size-3.5" /> Activity
					{#if data.previewRunFeedEnabled}<span class="size-1.5 rounded-full bg-emerald-500"></span>{/if}
				</TabsTrigger>
				<TabsTrigger value="pull-requests" class="gap-1.5 text-xs">
					<GitPullRequest class="size-3.5" /> Pull requests
					{#if (prPreviews?.items.length ?? 0) > 0}<Badge variant="secondary" class="ml-1 h-4 px-1 text-[10px]">{prPreviews?.items.length}</Badge>{/if}
				</TabsTrigger>
			{/if}
			</TabsList>
		</div>

		<TabsContent value="environments" class="mt-0 min-h-0 flex-1 overflow-y-auto">
			<div class="mx-auto w-full max-w-[1400px] space-y-8 px-5 py-5 pb-10 lg:px-6">
				<VclusterPreviewPanel
					previews={visiblePreviews}
					counts={visibleCounts}
					previewNativeServices={data.previewNativeServices}
					readProxyEnabled={data.previewReadProxyEnabled}
					{controlPlane}
					{slug}
					onchanged={() => void tick()}
				/>

				<section class="space-y-3" aria-labelledby="live-sessions-heading">
					<div class="flex flex-wrap items-center justify-between gap-3 border-b pb-3">
						<div>
							<div class="flex items-center gap-2">
								<Workflow class="size-4 text-violet-500" />
								<h2 id="live-sessions-heading" class="text-sm font-semibold">Hot-reload sessions</h2>
							</div>
							<p class="mt-1 text-xs text-muted-foreground">Workflow-owned workspaces and their interactive agent sessions.</p>
						</div>
						<Button size="sm" variant="outline" onclick={() => (launchOpen = true)}>
							<Plus class="size-4" /> Start session
						</Button>
					</div>

					{#if firstLoad}
						<div class="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
							{#each Array(3) as _, i (i)}
								<div class="h-40 rounded-md border bg-muted/30 motion-safe:animate-pulse"></div>
							{/each}
						</div>
					{:else if groups.length === 0}
						<div class="flex min-h-44 flex-col items-center justify-center gap-3 border border-dashed px-5 py-8 text-center">
							<Container class="size-6 text-muted-foreground" />
							<div>
								<h3 class="text-sm font-medium">No active coding sessions</h3>
								<p class="mt-1 text-xs text-muted-foreground">Start a workflow-backed session to create a live workspace.</p>
							</div>
							<Button size="sm" onclick={() => (launchOpen = true)}><Plus class="size-4" /> Start coding session</Button>
						</div>
					{:else}
						<div class="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
							{#each groups as group (group.executionId)}
								<DevEnvironmentCard
									environment={group.primary}
									services={group.services}
									{slug}
									busy={busyId === group.executionId}
									busyLabel={busyId === group.executionId && teardownProgress
											? teardownProgressMessage(
													teardownProgress,
													teardownDiscardUncaptured
												)
											: null}
									onopen={openEnv}
									onteardown={(e) => (toTeardown = e)}
								/>
							{/each}
						</div>
					{/if}
				</section>
			</div>
		</TabsContent>

		{#if controlPlane}
			<TabsContent value="activity" class="mt-0 min-h-0 flex-1 overflow-y-auto">
				<div class="mx-auto w-full max-w-[1400px] px-5 py-5 pb-10 lg:px-6">
					{#if data.previewRunFeedEnabled}
						<PreviewRunFeedPanel />
					{:else}
						<section class="flex min-h-64 flex-col items-center justify-center gap-3 border border-dashed text-center">
							<Radio class="size-6 text-muted-foreground" />
							<div>
								<h2 class="text-sm font-medium">Live workflow activity is unavailable</h2>
								<p class="mt-1 text-xs text-muted-foreground">Lifecycle snapshots continue to refresh on the Environments tab.</p>
							</div>
						</section>
					{/if}
				</div>
			</TabsContent>

			<TabsContent value="pull-requests" class="mt-0 min-h-0 flex-1 overflow-y-auto">
				<div class="mx-auto w-full max-w-[1400px] px-5 py-5 pb-10 lg:px-6">
					<PrPreviewsPanel enabled={prPreviews?.enabled ?? false} items={prPreviews?.items ?? []} />
				</div>
			</TabsContent>
		{/if}
	</Tabs>
</div>

<DevLaunchDialog
	bind:open={launchOpen}
	services={data.services}
	previewNativeServices={data.previewNativeServices}
	previewEnvironment={data.previewEnvironment}
	devWorkflowId={data.devWorkflowId}
	devWorkflowName={data.devWorkflowName}
	onlaunched={onLaunched}
/>

<AlertDialog open={toTeardown !== null} onOpenChange={(open) => !open && (toTeardown = null)}>
	<AlertDialogContent>
		<AlertDialogHeader>
			<AlertDialogTitle>Tear down {toTeardown?.service}?</AlertDialogTitle>
			<AlertDialogDescription>
				Captures one coherent live-sync generation into the environment's stable draft pull
				request before deleting the preview workload and purging the interactive session. A failed
				checkpoint leaves the environment intact for recovery from its detail page.
			</AlertDialogDescription>
		</AlertDialogHeader>
		<AlertDialogFooter>
			<AlertDialogCancel>Cancel</AlertDialogCancel>
			<AlertDialogAction onclick={confirmTeardown}>Tear down</AlertDialogAction>
		</AlertDialogFooter>
	</AlertDialogContent>
</AlertDialog>
