<script lang="ts">
	import { goto, invalidateAll } from '$app/navigation';
	import { onDestroy, onMount } from 'svelte';
	import { page } from '$app/state';
	import { Alert, AlertDescription } from '$lib/components/ui/alert';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import {
		ArrowLeft,
		Bot,
		Download,
		ExternalLink,
		FlaskConical,
		GitBranch,
		Layers,
		RefreshCw,
		StopCircle
	} from '@lucide/svelte';
	import RunStatusBadge from '$lib/components/benchmarks/run-status-badge.svelte';
	import RunStatTiles from '$lib/components/benchmarks/run-stat-tiles.svelte';
	import RepoAccuracyBars from '$lib/components/benchmarks/repo-accuracy-bars.svelte';
	import StatusDonut from '$lib/components/benchmarks/status-donut.svelte';
	import CumulativeResolvedSparkline from '$lib/components/benchmarks/cumulative-resolved-sparkline.svelte';
	import RunInstanceTable from '$lib/components/benchmarks/run-instance-table.svelte';
	import RunInstanceDrawer from '$lib/components/benchmarks/run-instance-drawer.svelte';
	import {
		formatRelative,
		formatStatus,
		isActiveRunStatus,
		suiteShortLabel
	} from '$lib/components/benchmarks/run-status-helpers';
	import type { PageData } from './$types';

	const { data }: { data: PageData } = $props();

	const slug = $derived((page.params.slug as string) ?? 'default');
	const runId = $derived(data.runId);

	// svelte-ignore state_referenced_locally
	let run = $state(data.run);
	// svelte-ignore state_referenced_locally
	let runStats = $state(data.runStats);
	let pollTimer: ReturnType<typeof setTimeout> | null = null;
	let drawerOpen = $state(false);
	let drawerInstanceId = $state<string | null>(null);
	let cancelling = $state(false);
	let errorMessage = $state<string | null>(null);
	let selectedInstanceId = $state<string | null>(null);

	const isActive = $derived(isActiveRunStatus(run?.status));

	const inferenceDone = $derived.by(() => {
		const counts = countByKey(run?.instances ?? [], 'inferenceStatus');
		return (
			(counts.inferred ?? 0) +
			(counts.error ?? 0) +
			(counts.timeout ?? 0) +
			(counts.cancelled ?? 0)
		);
	});

	const evaluationDone = $derived.by(() => {
		const counts = countByKey(run?.instances ?? [], 'evaluationStatus');
		return (
			(counts.resolved ?? 0) +
			(counts.unresolved ?? 0) +
			(counts.empty_patch ?? 0) +
			(counts.error ?? 0) +
			(counts.timeout ?? 0) +
			(counts.cancelled ?? 0)
		);
	});

	function countByKey(
		items: Array<{ inferenceStatus: string; evaluationStatus: string }>,
		key: 'inferenceStatus' | 'evaluationStatus'
	) {
		const counts: Record<string, number> = {};
		for (const item of items) {
			const status = item[key] || 'pending';
			counts[status] = (counts[status] ?? 0) + 1;
		}
		return counts;
	}

	async function refresh(opts: { silent?: boolean } = {}) {
		if (!runId) return;
		try {
			const res = await fetch(`/api/benchmarks/runs/${encodeURIComponent(runId)}?lite=true`);
			if (!res.ok) {
				if (!opts.silent) errorMessage = `Failed to refresh (${res.status})`;
				return;
			}
			const body = (await res.json()) as { run: typeof run; runStats: typeof runStats };
			run = body.run;
			if (body.runStats) runStats = body.runStats;
			errorMessage = null;
		} catch (err) {
			if (!opts.silent) errorMessage = err instanceof Error ? err.message : String(err);
		}
	}

	async function cancelRun() {
		if (!run || !runId) return;
		cancelling = true;
		try {
			const res = await fetch(`/api/benchmarks/runs/${encodeURIComponent(runId)}/cancel`, {
				method: 'POST'
			});
			if (!res.ok) {
				errorMessage = `Cancel failed (${res.status})`;
				return;
			}
			await refresh({ silent: true });
		} finally {
			cancelling = false;
		}
	}

	function schedulePoll() {
		if (pollTimer) clearTimeout(pollTimer);
		pollTimer = setTimeout(
			async () => {
				if (typeof document === 'undefined' || document.visibilityState === 'visible') {
					await refresh({ silent: true });
				}
				schedulePoll();
			},
			isActive ? 4000 : 30000
		);
	}

	function openDrawer(instanceId: string) {
		drawerInstanceId = instanceId;
		selectedInstanceId = instanceId;
		drawerOpen = true;
		const params = new URLSearchParams(window.location.search);
		params.set('instance', instanceId);
		window.history.replaceState(window.history.state, '', `?${params.toString()}`);
	}

	function closeDrawer(next: boolean) {
		drawerOpen = next;
		if (!next) {
			const params = new URLSearchParams(window.location.search);
			params.delete('instance');
			const qs = params.toString();
			window.history.replaceState(window.history.state, '', qs ? `?${qs}` : window.location.pathname);
		}
	}

	function compareWith() {
		if (!run) return;
		goto(`/workspaces/${slug}/benchmarks/compare?runs=${encodeURIComponent(run.id)}`);
	}

	onMount(() => {
		const initialInstance = page.url.searchParams.get('instance');
		if (initialInstance && run?.instances.find((i) => i.instanceId === initialInstance)) {
			openDrawer(initialInstance);
		}
		schedulePoll();
	});

	onDestroy(() => {
		if (pollTimer) clearTimeout(pollTimer);
	});
</script>

<svelte:head>
	<title>{run?.suiteName ?? 'Run'} · {run?.modelNameOrPath ?? 'benchmark run'}</title>
</svelte:head>

<div class="space-y-5">
	{#if !run}
		<Alert variant="destructive">
			<AlertDescription>Run not found.</AlertDescription>
		</Alert>
	{:else}
		<header class="space-y-3">
			<div class="flex flex-wrap items-start justify-between gap-3">
				<div class="min-w-0 flex-1 space-y-1">
					<div class="flex flex-wrap items-center gap-2">
						<Button
							variant="ghost"
							size="sm"
							class="-ml-2 h-7 text-xs"
							onclick={() => goto(`/workspaces/${slug}/benchmarks/runs`)}
						>
							<ArrowLeft class="mr-1 h-3.5 w-3.5" /> Runs
						</Button>
						<Badge variant="default" class="text-[10px]">{suiteShortLabel(run.suiteSlug)}</Badge>
						<RunStatusBadge status={run.status} />
						{#if isActive}
							<span class="inline-flex h-2 w-2 animate-pulse rounded-full bg-blue-500"></span>
						{/if}
					</div>
					<h1 class="flex items-center gap-2 text-2xl font-semibold">
						<FlaskConical class="size-6 shrink-0" />
						<span class="break-words">{run.suiteName}</span>
						{#if run.modelConfigLabel}
							<Badge variant="secondary" class="text-[10px]">{run.modelConfigLabel}</Badge>
						{/if}
					</h1>
					<p class="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
						<span class="inline-flex items-center gap-1">
							<Bot class="h-3 w-3" /> {run.agentName} v{run.agentVersion}
						</span>
						<span class="font-mono">{run.modelNameOrPath}</span>
						<span>concurrency {run.concurrency}</span>
						<span>{run.evaluatorResourceClass}</span>
						<span>started {formatRelative(run.createdAt)}</span>
						{#if run.completedAt}
							<span>completed {formatRelative(run.completedAt)}</span>
						{/if}
					</p>
				</div>

				<div class="flex flex-wrap items-center gap-2">
					<Button variant="outline" size="sm" onclick={() => refresh()}>
						<RefreshCw class="size-3.5" /> Refresh
					</Button>
					<Button variant="outline" size="sm" onclick={compareWith}>
						<Layers class="size-3.5" /> Compare with…
					</Button>
					<a href={`/api/benchmarks/runs/${run.id}/predictions.jsonl`}>
						<Button variant="outline" size="sm">
							<Download class="size-3.5" /> Predictions
						</Button>
					</a>
					{#if isActive}
						<Button variant="destructive" size="sm" onclick={cancelRun} disabled={cancelling}>
							<StopCircle class="size-3.5" /> Cancel
						</Button>
					{/if}
				</div>
			</div>
			{#if run.coordinatorExecutionId || run.evaluatorJobName || run.predictionsPath}
				<div class="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-md border border-border bg-muted/20 px-3 py-2 text-[11px]">
					{#if run.coordinatorExecutionId}
						<a
							href={`/workspaces/${slug}/runs/${run.coordinatorExecutionId}`}
							class="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground"
						>
							<GitBranch class="h-3 w-3" /> coordinator
							<span class="font-mono">{run.coordinatorExecutionId.slice(0, 12)}…</span>
							<ExternalLink class="h-3 w-3" />
						</a>
					{/if}
					{#if run.evaluatorJobName}
						<span class="text-muted-foreground">
							evaluator <span class="font-mono">{run.evaluatorJobName}</span>
						</span>
					{/if}
					{#if run.predictionsPath}
						<span class="break-all text-muted-foreground">
							predictions <span class="font-mono">{run.predictionsPath}</span>
						</span>
					{/if}
				</div>
			{/if}

			{#if run.error}
				<Alert variant="destructive">
					<AlertDescription>{run.error}</AlertDescription>
				</Alert>
			{/if}
			{#if errorMessage}
				<Alert variant="destructive">
					<AlertDescription>{errorMessage}</AlertDescription>
				</Alert>
			{/if}
		</header>

		<RunStatTiles
			resolved={runStats.resolved}
			total={runStats.total || run.instances.length}
			resolvedRate={runStats.resolvedRate}
			inferenceDone={inferenceDone}
			evaluationDone={evaluationDone}
			tokensInTotal={runStats.tokensInTotal}
			tokensOutTotal={runStats.tokensOutTotal}
			tokensCacheReadTotal={runStats.tokensCacheReadTotal}
			costUsdTotal={runStats.costUsdTotal}
			costPerResolved={runStats.costPerResolved}
			cacheHitRate={runStats.cacheHitRate}
			llmCallCount={runStats.llmCallCount}
			inferenceP50={runStats.inferenceDurationMs.p50}
			inferenceP90={runStats.inferenceDurationMs.p90}
		/>

		<div class="grid gap-3 lg:grid-cols-[minmax(0,1fr)_280px_minmax(0,1.3fr)]">
			<RepoAccuracyBars data={runStats.byRepo} />
			<StatusDonut data={runStats.byStatus} />
			<CumulativeResolvedSparkline
				data={runStats.cumulativeResolved}
				total={runStats.total || run.instances.length}
				startedAt={run.startedAt ?? run.createdAt}
				completedAt={run.completedAt}
			/>
		</div>

		{#if runStats.byDifficulty && runStats.byDifficulty.length > 0}
			<div class="rounded-md border border-border bg-background p-4">
				<h3 class="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
					By difficulty (Verified)
				</h3>
				<div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
					{#each runStats.byDifficulty as bucket (bucket.bucket)}
						<div class="rounded-md border border-border p-3">
							<div class="text-[11px] uppercase tracking-wider text-muted-foreground">
								{bucket.bucket}
							</div>
							<div class="mt-1 text-xl font-semibold tabular-nums">
								{Math.round(bucket.resolvedRate * 100)}%
							</div>
							<div class="mt-1 text-xs text-muted-foreground">
								{bucket.resolved}/{bucket.total} resolved
							</div>
						</div>
					{/each}
				</div>
			</div>
		{/if}

		{#if runStats.failureCategoryCounts.test_failed +
			runStats.failureCategoryCounts.patch_apply_failed +
			runStats.failureCategoryCounts.empty_patch +
			runStats.failureCategoryCounts.test_timeout +
			runStats.failureCategoryCounts.error +
			runStats.failureCategoryCounts.timeout >
			0}
			<div class="rounded-md border border-border bg-background p-4">
				<h3 class="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
					Failure categories
				</h3>
				<div class="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
					{#each [
						{ key: 'test_failed', label: 'Test failed' },
						{ key: 'patch_apply_failed', label: 'Patch apply' },
						{ key: 'empty_patch', label: 'Empty patch' },
						{ key: 'test_timeout', label: 'Test timeout' },
						{ key: 'error', label: 'Error' },
						{ key: 'timeout', label: 'Timeout' }
					] as cat (cat.key)}
						{@const n = runStats.failureCategoryCounts[
							cat.key as keyof typeof runStats.failureCategoryCounts
						] ?? 0}
						{#if n > 0}
							<div class="rounded-md border border-border p-3">
								<div class="text-[10px] uppercase tracking-wider text-muted-foreground">
									{cat.label}
								</div>
								<div class="mt-1 text-2xl font-semibold tabular-nums text-red-600 dark:text-red-400">
									{n}
								</div>
							</div>
						{/if}
					{/each}
				</div>
			</div>
		{/if}

		<section class="space-y-2">
			<div class="flex items-end justify-between">
				<h2 class="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
					Per-instance results
				</h2>
				<span class="text-[11px] text-muted-foreground">
					{run.instances.length} {run.instances.length === 1 ? 'instance' : 'instances'}
				</span>
			</div>
			<RunInstanceTable
				instances={run.instances}
				workspaceSlug={slug}
				selectedInstanceId={selectedInstanceId}
				onSelect={openDrawer}
			/>
		</section>
	{/if}
</div>

<RunInstanceDrawer
	bind:open={drawerOpen}
	{runId}
	instanceId={drawerInstanceId}
	workspaceSlug={slug}
	onOpenChange={closeDrawer}
/>
