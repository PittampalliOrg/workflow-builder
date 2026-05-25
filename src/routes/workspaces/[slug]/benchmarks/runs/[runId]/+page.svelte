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
	import LifecycleTiles from '$lib/components/benchmarks/lifecycle-tiles.svelte';
	import ScorerTiles from '$lib/components/benchmarks/scorer-tiles.svelte';
	import CohortPivot from '$lib/components/benchmarks/cohort-pivot.svelte';
	import TerminationDonut from '$lib/components/benchmarks/termination-donut.svelte';
	import ToolUsageHistogram from '$lib/components/benchmarks/tool-usage-histogram.svelte';
	import RepoAccuracyBars from '$lib/components/benchmarks/repo-accuracy-bars.svelte';
	import StatusDonut from '$lib/components/benchmarks/status-donut.svelte';
	import CumulativeResolvedSparkline from '$lib/components/benchmarks/cumulative-resolved-sparkline.svelte';
	import RunInstanceTable from '$lib/components/benchmarks/run-instance-table.svelte';
	import RunInstanceDrawer from '$lib/components/benchmarks/run-instance-drawer.svelte';
	import HeadlampLogo from '$lib/components/gitops/icons/HeadlampLogo.svelte';
	import MetricWaterfall from '$lib/components/metrics/MetricWaterfall.svelte';
	import { embeddedHeadlampResourceUrl } from '$lib/headlamp/links';
	import { createWorkloadStream } from '$lib/stores/kueueviz/workloads.svelte';
	import type { WorkloadSnapshot } from '$lib/server/kueueviz';
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
	// svelte-ignore state_referenced_locally
	let capacityDiagnostics = $state(data.capacityDiagnostics);
	let pollTimer: ReturnType<typeof setTimeout> | null = null;
	let drawerOpen = $state(false);
	let drawerInstanceId = $state<string | null>(null);
	let cancelling = $state(false);
	let cleaningUp = $state(false);
	let errorMessage = $state<string | null>(null);
	let selectedInstanceId = $state<string | null>(null);

	const isActive = $derived(isActiveRunStatus(run?.status));
	const canRetryCleanup = $derived(
		!!run && ['cancelled', 'failed', 'completed'].includes(run.status)
	);
	const evaluatorHeadlampUrl = $derived(
		run?.evaluatorJobName
			? embeddedHeadlampResourceUrl({
					workspaceSlug: slug,
					cluster: data.headlampCluster,
					kind: 'Job',
					namespace: 'workflow-builder',
					name: run.evaluatorJobName,
					logs: true
				})
			: null
	);

	// Live workloads stream — used to surface "Queue" status next to each
	// instance row. Subscribed once per page; the BFF pool dedupes upstream
	// across all viewers. Map keyed on the `benchmark-instance-id` label
	// stamped onto the Sandbox pod template at provisioning time.
	const workloadStream = createWorkloadStream();
	const capacityByInstance = $derived.by(() => {
		const out = new Map<string, WorkloadSnapshot>();
		for (const wl of workloadStream.data) {
			const id = wl.labels['benchmark-instance-id'];
			if (!id) continue;
			// Prefer the most recent active workload over a finished one — for
			// re-runs the older finished entry would otherwise win the lookup.
			const existing = out.get(id);
			if (!existing) {
				out.set(id, wl);
			} else if (wl.active && !existing.active) {
				out.set(id, wl);
			} else if (
				wl.active === existing.active &&
				wl.creationTimestamp > existing.creationTimestamp
			) {
				out.set(id, wl);
			}
		}
		return out;
	});

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
			const body = (await res.json()) as {
				run: typeof run;
				runStats: typeof runStats;
				capacityDiagnostics: typeof capacityDiagnostics;
			};
			run = body.run;
			if (body.runStats) runStats = body.runStats;
			if (body.capacityDiagnostics) capacityDiagnostics = body.capacityDiagnostics;
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

	async function retryCleanup() {
		if (!run || !runId) return;
		cleaningUp = true;
		try {
			const res = await fetch(`/api/benchmarks/runs/${encodeURIComponent(runId)}/cleanup`, {
				method: 'POST'
			});
			if (!res.ok) {
				errorMessage = `Cleanup failed (${res.status})`;
				return;
			}
			await refresh({ silent: true });
		} finally {
			cleaningUp = false;
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

	function resourceLabel(value: string): string {
		return value.replace(/_/g, ' ');
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
						<span>inference concurrency {run.concurrency}</span>
						<span>eval concurrency {run.evaluationConcurrency}</span>
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
					{#if run.mlflowUrl}
						<a href={run.mlflowUrl} target="_blank" rel="noopener noreferrer">
							<Button variant="outline" size="sm">
								<ExternalLink class="size-3.5" /> MLflow
							</Button>
						</a>
					{/if}
					{#if isActive}
						<Button variant="destructive" size="sm" onclick={cancelRun} disabled={cancelling}>
							<StopCircle class="size-3.5" /> Cancel
						</Button>
					{/if}
					{#if canRetryCleanup}
						<Button variant="outline" size="sm" onclick={retryCleanup} disabled={cleaningUp}>
							<RefreshCw class="size-3.5" /> Cleanup
						</Button>
					{/if}
				</div>
			</div>
			{#if run.coordinatorExecutionId || run.evaluatorJobName || run.predictionsPath || run.mlflowRunId}
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
						<a
							href={evaluatorHeadlampUrl ?? undefined}
							class="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground"
						>
							<HeadlampLogo class="h-3 w-3" />
							evaluator <span class="font-mono">{run.evaluatorJobName}</span>
							<ExternalLink class="h-3 w-3" />
						</a>
					{/if}
					{#if run.predictionsPath}
						<span class="break-all text-muted-foreground">
							predictions <span class="font-mono">{run.predictionsPath}</span>
						</span>
					{/if}
					{#if run.mlflowRunId}
						<span class="break-all text-muted-foreground">
							mlflow <span class="font-mono">{run.mlflowRunId}</span>
						</span>
					{/if}
				</div>
			{/if}

			{#if capacityDiagnostics}
				<div class="rounded-md border border-border bg-muted/20 p-3 text-xs">
					<div class="flex flex-wrap items-center justify-between gap-2">
						<div class="font-medium">Capacity diagnostics</div>
						<div class="flex flex-wrap gap-x-3 gap-y-1 text-muted-foreground">
							<span>requested {capacityDiagnostics.requestedConcurrency}</span>
							<span>stored effective {capacityDiagnostics.storedEffectiveConcurrency}</span>
							<span>
								runtime {capacityDiagnostics.runtime.replicas ?? '—'}×{capacityDiagnostics.runtime.slotsPerReplica ?? '—'}
								= {capacityDiagnostics.runtime.slots ?? '—'} slots
							</span>
							<span>dapr {capacityDiagnostics.daprWorkflow.effectiveCapacity ?? '—'} slots</span>
							<span>
								parent {capacityDiagnostics.parentWorkflow.replicas ?? '—'} replicas ·
								{capacityDiagnostics.parentWorkflow.connectedWorkers ?? '—'} workers ·
								{capacityDiagnostics.parentWorkflow.effectiveWorkflowCapacity ?? '—'} slots
							</span>
							<span>
								parent activity {capacityDiagnostics.parentWorkflow.effectiveActivityCapacity ?? '—'}
								{#if capacityDiagnostics.parentWorkflow.workerActivityLimitPerSidecar !== null && capacityDiagnostics.parentWorkflow.configurationActivityLimitPerSidecar !== null && capacityDiagnostics.parentWorkflow.workerActivityLimitPerSidecar < capacityDiagnostics.parentWorkflow.configurationActivityLimitPerSidecar}
									(worker cap {capacityDiagnostics.parentWorkflow.workerActivityLimitPerSidecar})
								{/if}
							</span>
							{#if capacityDiagnostics.workflowLifecycle?.parentActorStateStore?.maxConns}
								<span>
									state-store pool {capacityDiagnostics.workflowLifecycle.parentActorStateStore.maxConns}
								</span>
							{/if}
							{#if capacityDiagnostics.parentWorkflow.schedulerPods !== null}
								<span>
									scheduler {capacityDiagnostics.parentWorkflow.schedulerReadyPods ?? '—'}/{capacityDiagnostics.parentWorkflow.schedulerPods}
								</span>
							{/if}
							<span>sandbox headroom {capacityDiagnostics.sandbox.schedulableSandboxCapacity ?? '—'}</span>
							{#if capacityDiagnostics.sandbox.ephemeralStorageLimitedCapacity !== null}
								<span>storage {capacityDiagnostics.sandbox.ephemeralStorageLimitedCapacity}</span>
							{/if}
							{#if capacityDiagnostics.sandbox.nodeFsLimitedCapacity !== null}
								<span>node fs {capacityDiagnostics.sandbox.nodeFsLimitedCapacity}</span>
							{/if}
							{#if capacityDiagnostics.sandbox.kueueAvailableSandboxSlots !== null && capacityDiagnostics.sandbox.kueueAvailableSandboxSlots !== undefined}
								<span>kueue {capacityDiagnostics.sandbox.kueueAvailableSandboxSlots}</span>
							{/if}
							{#if capacityDiagnostics.evaluator?.effectiveEvaluationConcurrency}
								<span>
									eval {capacityDiagnostics.evaluator.requestedEvaluationConcurrency ?? '—'}→{capacityDiagnostics.evaluator.effectiveEvaluationConcurrency}
								</span>
							{/if}
							{#if capacityDiagnostics.sharedCapacity?.available}
								<span>shared fits {capacityDiagnostics.sharedCapacity.fitsAdditionalSessions ?? '—'}</span>
							{/if}
							{#if capacityDiagnostics.sandbox.diskPressureNodeCount}
								<span class="text-amber-600">
									disk pressure {capacityDiagnostics.sandbox.diskPressureNodeCount}
								</span>
							{/if}
							{#if capacityDiagnostics.modelCaps.modelMaxActiveRequests}
								<span>model cap {capacityDiagnostics.modelCaps.modelMaxActiveRequests}</span>
							{/if}
							{#if capacityDiagnostics.parentWorkflow.daprRuntimePressure}
								<span class="text-amber-600">
									dapr pressure actor {capacityDiagnostics.parentWorkflow.recentActorErrorCount ?? '—'} reminder {capacityDiagnostics.parentWorkflow.recentReminderErrorCount ?? '—'}
								</span>
							{/if}
						</div>
					</div>
					{#if capacityDiagnostics.blockedBy.length > 0}
						<div class="mt-2 rounded border border-amber-300 bg-amber-50 px-2 py-1 text-amber-900 dark:border-amber-900/40 dark:bg-amber-950/30 dark:text-amber-200">
							Blocked by {capacityDiagnostics.blockedBy.map(resourceLabel).join(', ')}
						</div>
					{/if}
					{#if capacityDiagnostics.workflowLifecycle?.issue === 'dapr_actor_state_store_mismatch'}
						<div class="mt-2 rounded border border-amber-300 bg-amber-50 px-2 py-1 text-amber-900 dark:border-amber-900/40 dark:bg-amber-950/30 dark:text-amber-200">
							Dapr workflow lifecycle risk: parent store {capacityDiagnostics.workflowLifecycle.parentActorStateStore?.componentName ?? 'unknown'}
							{#if capacityDiagnostics.workflowLifecycle.parentActorStateStore?.tablePrefix}
								({capacityDiagnostics.workflowLifecycle.parentActorStateStore.tablePrefix})
							{/if}
							and child store {capacityDiagnostics.workflowLifecycle.childActorStateStore?.componentName ?? 'unknown'}
							{#if capacityDiagnostics.workflowLifecycle.childActorStateStore?.tablePrefix}
								({capacityDiagnostics.workflowLifecycle.childActorStateStore.tablePrefix})
							{/if}
							do not share actor state.
						</div>
					{:else if capacityDiagnostics.workflowLifecycle?.issue && capacityDiagnostics.workflowLifecycle.issue !== 'dapr_component_diagnostics_unavailable'}
						<div class="mt-2 rounded border border-amber-300 bg-amber-50 px-2 py-1 text-amber-900 dark:border-amber-900/40 dark:bg-amber-950/30 dark:text-amber-200">
							Dapr workflow lifecycle check: {capacityDiagnostics.workflowLifecycle.issue.replace(/_/g, ' ')}
						</div>
					{/if}
					<div class="mt-2 grid gap-1 sm:grid-cols-2 lg:grid-cols-3">
						{#each capacityDiagnostics.resources as resource (resource.resourceType + resource.capacityKey)}
							<div class="flex items-center justify-between gap-2 rounded border border-border bg-background/70 px-2 py-1">
								<span class="truncate">{resourceLabel(resource.resourceType)}</span>
								<span class="font-mono tabular-nums">
									{resource.active}/{resource.limit}
									{#if resource.staleActive > 0}
										<span class="text-amber-600"> +{resource.staleActive} stale</span>
									{/if}
								</span>
							</div>
						{/each}
					</div>
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

			{#if data.failureContext}
				{@const ctx = data.failureContext}
				<div class="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-xs">
					<div class="mb-2 text-xs font-semibold uppercase tracking-wider text-destructive">
						Platform state at failure time
					</div>
					<dl class="grid gap-x-4 gap-y-1 sm:grid-cols-2 lg:grid-cols-3">
						<div>
							<dt class="text-muted-foreground">Kueue pending @ end</dt>
							<dd class="font-mono">{ctx.kueue.pendingWorkloadsAtEnd ?? '—'}</dd>
						</div>
						<div>
							<dt class="text-muted-foreground">Preemptions in window</dt>
							<dd class="font-mono">{ctx.kueue.preemptionsInWindow}</dd>
						</div>
						<div>
							<dt class="text-muted-foreground">Admission wait P95</dt>
							<dd class="font-mono">
								{ctx.kueue.admissionWaitP95Ms !== null
									? `${(ctx.kueue.admissionWaitP95Ms / 1000).toFixed(1)}s`
									: '—'}
							</dd>
						</div>
						<div>
							<dt class="text-muted-foreground">Sandbox reconcile errors</dt>
							<dd class="font-mono">{ctx.agentSandbox.reconcileErrorsInWindow}</dd>
						</div>
						<div>
							<dt class="text-muted-foreground">Workflow failed (Dapr)</dt>
							<dd class="font-mono">{ctx.dapr.workflowFailedInWindow}</dd>
						</div>
						<div>
							<dt class="text-muted-foreground">Workflow recoverable (Dapr)</dt>
							<dd class="font-mono">{ctx.dapr.workflowRecoverableInWindow}</dd>
						</div>
						<div>
							<dt class="text-muted-foreground">Scheduling P95</dt>
							<dd class="font-mono">
								{ctx.dapr.schedulingLatencyP95Ms !== null
									? `${ctx.dapr.schedulingLatencyP95Ms.toFixed(0)}ms`
									: '—'}
							</dd>
						</div>
					</dl>
					<p class="mt-2 italic text-muted-foreground">
						If counts are spiking near your run window the platform was contended.
						Otherwise the failure is likely run-internal — check the trace.
					</p>
				</div>
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

		{#if runStats.byScorer && runStats.byScorer.length > 0}
			<ScorerTiles data={runStats.byScorer} />
		{/if}

		{#if runStats.byTerminationReason.length > 0 || runStats.byTool.length > 0 || runStats.turnCountP50 !== null}
			<LifecycleTiles
				turnCountP50={runStats.turnCountP50}
				turnCountP90={runStats.turnCountP90}
				ttftP50={runStats.ttftP50}
				ttftP90={runStats.ttftP90}
				toolCallsTotal={runStats.byTool.reduce((a, b) => a + b.count, 0)}
				distinctTools={runStats.byTool.length}
			/>
			<div class="grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
				<TerminationDonut data={runStats.byTerminationReason} />
				<ToolUsageHistogram data={runStats.byTool} />
			</div>
		{/if}

		{#if data.phaseAttribution?.hasMetricsCoverage}
			{@const agg = data.phaseAttribution.aggregate}
			{@const phaseTotal =
				(agg.queueWaitP50Ms ?? 0) +
				(agg.coldStartP50Ms ?? 0) +
				(agg.inferenceP50Ms ?? 0) +
				(agg.evaluationP50Ms ?? 0)}
			<div class="rounded-md border border-border bg-background p-4">
				<h3 class="mb-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
					Run-time attribution (P50)
				</h3>
				<p class="mb-3 text-xs text-muted-foreground">
					Where wall-clock time went across queue admission, sandbox startup, inference, and evaluation.
					{#if data.phaseAttribution.caveat}
						<span class="block italic">{data.phaseAttribution.caveat}</span>
					{/if}
				</p>
				<MetricWaterfall
					totalMs={phaseTotal}
					phases={[
						{ label: 'Queue', ms: agg.queueWaitP50Ms ?? 0, color: '#94a3b8' },
						{ label: 'Sandbox start', ms: agg.coldStartP50Ms ?? 0, color: '#fb923c' },
						{ label: 'Inference', ms: agg.inferenceP50Ms ?? 0, color: '#6366f1' },
						{ label: 'Evaluation', ms: agg.evaluationP50Ms ?? 0, color: '#14b8a6' }
					]}
				/>
				<table class="mt-4 w-full text-xs">
					<thead>
						<tr class="text-left text-muted-foreground">
							<th class="font-normal">Phase</th>
							<th class="font-normal">P50</th>
							<th class="font-normal">P95</th>
							<th class="font-normal">Samples</th>
						</tr>
					</thead>
					<tbody class="font-mono">
						<tr>
							<td>Queue wait</td>
							<td>{agg.queueWaitP50Ms !== null ? `${Math.round(agg.queueWaitP50Ms)}ms` : '—'}</td>
							<td>{agg.queueWaitP95Ms !== null ? `${Math.round(agg.queueWaitP95Ms)}ms` : '—'}</td>
							<td>{agg.queueWaitSamples}</td>
						</tr>
						<tr>
							<td>Sandbox cold-start</td>
							<td>{agg.coldStartP50Ms !== null ? `${Math.round(agg.coldStartP50Ms)}ms` : '—'}</td>
							<td>{agg.coldStartP95Ms !== null ? `${Math.round(agg.coldStartP95Ms)}ms` : '—'}</td>
							<td>{agg.coldStartSamples}</td>
						</tr>
						<tr>
							<td>Inference</td>
							<td>{agg.inferenceP50Ms !== null ? `${(agg.inferenceP50Ms / 1000).toFixed(1)}s` : '—'}</td>
							<td>{agg.inferenceP95Ms !== null ? `${(agg.inferenceP95Ms / 1000).toFixed(1)}s` : '—'}</td>
							<td>{agg.inferenceSamples}</td>
						</tr>
						<tr>
							<td>Evaluation</td>
							<td>{agg.evaluationP50Ms !== null ? `${(agg.evaluationP50Ms / 1000).toFixed(1)}s` : '—'}</td>
							<td>{agg.evaluationP95Ms !== null ? `${(agg.evaluationP95Ms / 1000).toFixed(1)}s` : '—'}</td>
							<td>{agg.evaluationSamples}</td>
						</tr>
					</tbody>
				</table>
			</div>
		{/if}

		{#if runStats.cohortRows && runStats.cohortRows.length > 0}
			<CohortPivot rows={runStats.cohortRows} />
		{/if}

		{#if runStats.humanAnnotations && runStats.humanAnnotations.totalAnnotated > 0}
			<div class="rounded-md border border-border bg-background p-4">
				<h3 class="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
					Human annotations
				</h3>
				<div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
					<div class="rounded-md border border-border p-3">
						<div class="text-[10px] uppercase tracking-wider text-muted-foreground">
							Annotated
						</div>
						<div class="mt-1 text-xl font-semibold tabular-nums">
							{runStats.humanAnnotations.totalAnnotated}<span
								class="ml-1 text-xs font-normal text-muted-foreground"
								>/{runStats.total}</span
							>
						</div>
					</div>
					<div class="rounded-md border border-border p-3">
						<div class="text-[10px] uppercase tracking-wider text-muted-foreground">
							Correct
						</div>
						<div
							class="mt-1 text-xl font-semibold tabular-nums text-emerald-600 dark:text-emerald-400"
						>
							{runStats.humanAnnotations.counts.correct}
						</div>
					</div>
					<div class="rounded-md border border-border p-3">
						<div class="text-[10px] uppercase tracking-wider text-muted-foreground">
							Incorrect
						</div>
						<div
							class="mt-1 text-xl font-semibold tabular-nums text-red-600 dark:text-red-400"
						>
							{runStats.humanAnnotations.counts.incorrect}
						</div>
					</div>
					<div class="rounded-md border border-border p-3">
						<div class="text-[10px] uppercase tracking-wider text-muted-foreground">
							Partial / Unsure
						</div>
						<div class="mt-1 text-xl font-semibold tabular-nums">
							{runStats.humanAnnotations.counts.partial +
								runStats.humanAnnotations.counts.unsure}
						</div>
					</div>
					<div
						class="rounded-md border border-border p-3"
						title="Instances where harness pass/fail disagrees with human verdict (correct/incorrect only)"
					>
						<div class="text-[10px] uppercase tracking-wider text-muted-foreground">
							Harness disagreement
						</div>
						<div
							class="mt-1 text-xl font-semibold tabular-nums {runStats.humanAnnotations
								.harnessDisagreement > 0
								? 'text-amber-600 dark:text-amber-400'
								: ''}"
						>
							{runStats.humanAnnotations.harnessDisagreement}
						</div>
					</div>
				</div>
			</div>
		{/if}

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
				capacityByInstance={capacityByInstance}
			/>
		</section>
	{/if}
</div>

<RunInstanceDrawer
	bind:open={drawerOpen}
	{runId}
	instanceId={drawerInstanceId}
	workspaceSlug={slug}
	headlampCluster={data.headlampCluster}
	onOpenChange={closeDrawer}
	onTerminated={() => refresh({ silent: true })}
/>
