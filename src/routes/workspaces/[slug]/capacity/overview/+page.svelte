<script lang="ts">
	import { page } from '$app/state';
	import {
		Card,
		CardContent,
		CardHeader
	} from '$lib/components/ui/card';
	import { Skeleton } from '$lib/components/ui/skeleton';
	import { Alert, AlertDescription } from '$lib/components/ui/alert';
	import { Badge } from '$lib/components/ui/badge';
	import { Activity, AlertTriangle, CheckCircle2, Clock3, ListChecks, Server } from '@lucide/svelte';
	import { createClusterQueueStream } from '$lib/stores/kueueviz/cluster-queues.svelte';
	import { createWorkloadStream } from '$lib/stores/kueueviz/workloads.svelte';
	import { createResourceFlavorStream } from '$lib/stores/kueueviz/resource-flavors.svelte';
	import ClusterQueueCard from '$lib/components/capacity/cluster-queue-card.svelte';
	import ResourceFlavorStrip from '$lib/components/capacity/resource-flavor-strip.svelte';
	import StatusPill from '$lib/components/capacity/status-pill.svelte';
	import UsageBar from '$lib/components/capacity/usage-bar.svelte';
	import { formatQuantityForResource } from '$lib/components/capacity/quantity';
	import MetricSparkline from '$lib/components/metrics/MetricSparkline.svelte';
	import { getCapacityOverview, getSchedulingLatency } from './data.remote';
	import type {
		CapacityBlockedWorkload,
		CapacityObserverSnapshot,
		CapacityQueueSnapshot,
		CapacitySessionSnapshot
	} from '$lib/types/capacity';

	const slug = $derived(page.params.slug as string);

	const queues = createClusterQueueStream();
	const workloads = createWorkloadStream();
	const flavors = createResourceFlavorStream();
	const schedulingQuery = getSchedulingLatency();
	const capacityQuery = getCapacityOverview();

	const observer = $derived<CapacityObserverSnapshot | null>(
		capacityQuery.current?.observer.available ? capacityQuery.current.observer.snapshot : null
	);
	const observerError = $derived(
		capacityQuery.current?.observer.available === false ? capacityQuery.current.observer.error : null
	);

	const sparklinePoints = $derived(
		(schedulingQuery.current?.sparkline ?? []).map((p) => ({
			t: new Date(p.t),
			value: p.valueMs
		}))
	);

	// Aggregate connection state — show the worst of the three so the
	// user sees "Reconnecting" if any feed is degraded.
	const aggregateStatus = $derived.by(() => {
		const statuses = [queues.status, workloads.status, flavors.status];
		if (statuses.includes('connecting')) return 'connecting';
		if (statuses.includes('degraded')) return 'degraded';
		if (statuses.includes('closed')) return 'closed';
		return 'open';
	});

	const aggregateError = $derived(queues.error ?? workloads.error ?? flavors.error);
	const aggregateUpdate = $derived.by(() => {
		const updates = [queues.lastUpdate, workloads.lastUpdate, flavors.lastUpdate].filter(
			(u): u is string => Boolean(u)
		);
		if (updates.length === 0) return null;
		return updates.sort().at(-1) ?? null;
	});

	function recentForQueue(name: string) {
		return workloads.data
			.filter((wl) => wl.clusterQueueName === name || wl.queueName === name)
			.filter((wl) => wl.active)
			.sort((a, b) => (a.creationTimestamp < b.creationTimestamp ? 1 : -1))
			.slice(0, 3);
	}

	const totals = $derived.by(() => {
		const counts = { admitted: 0, pending: 0, reserving: 0, finished: 0 };
		for (const wl of workloads.data) {
			if (wl.status === 'admitted') counts.admitted += 1;
			else if (wl.status === 'pending') counts.pending += 1;
			else if (wl.status === 'reserving') counts.reserving += 1;
			else if (wl.status === 'finished') counts.finished += 1;
		}
		return counts;
	});

	function percent(value: number, total: number) {
		if (!Number.isFinite(value) || !Number.isFinite(total) || total <= 0) return 0;
		return Math.max(0, Math.min(100, (value / total) * 100));
	}

	function queueSnapshot(name: string): CapacityQueueSnapshot | null {
		return observer?.queues.find((queue) => queue.name === name) ?? null;
	}

	function sessionSnapshot(name: string): CapacitySessionSnapshot | null {
		return (
			observer?.sessionCapacity.find(
				(entry) => entry.queue === name || entry.executionClass === name
			) ?? null
		);
	}

	function workloadReason(wl: (typeof workloads.data)[number]) {
		const condition = [...wl.conditions]
			.reverse()
			.find((entry) => entry.status !== 'True' && (entry.reason || entry.message));
		return condition?.reason || condition?.message || wl.status;
	}

	const blockedWorkloads = $derived.by<CapacityBlockedWorkload[]>(() => {
		if (observer?.blockedWorkloads?.length) return observer.blockedWorkloads.slice(0, 8);
		return workloads.data
			.filter((wl) => wl.status === 'pending' || wl.status === 'reserving')
			.slice(0, 8)
			.map((wl) => ({
				namespace: wl.namespace,
				name: wl.name,
				queue: wl.queueName || wl.clusterQueueName || '',
				status: wl.status,
				reason: workloadReason(wl),
				message: '',
				pendingSeconds: Math.max(
					0,
					(Date.now() - new Date(wl.creationTimestamp).getTime()) / 1000
				)
			}));
	});
</script>

<div class="space-y-6">
	<div class="flex flex-wrap items-center justify-between gap-2">
		<div class="flex items-center gap-3">
			<StatusPill
				status={aggregateStatus}
				lastUpdate={aggregateUpdate}
				error={aggregateError}
			/>
			<a
				href={`/workspaces/${slug}/capacity/workloads`}
				class="text-xs text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
			>
				<ListChecks class="size-3" /> {workloads.data.length} workload{workloads.data.length === 1 ? '' : 's'} tracked
			</a>
		</div>
		<div class="flex items-center gap-1">
			{#if schedulingQuery.current?.hasData}
				{@const snap = schedulingQuery.current}
				<Badge
					variant="outline"
					class="font-mono text-[10px] inline-flex items-center gap-1.5"
					title={`Dapr workflow scheduling latency over the last ${snap.windowSeconds / 60}m. P50/P95 measure the lag between CreateWorkflowInstance and the runtime picking it up — rising P95 = sidecar concurrency caps saturated.`}
				>
					<span class="text-muted-foreground">sched P95:</span>
					<span>{snap.p95Ms !== null ? `${Math.round(snap.p95Ms)}ms` : '—'}</span>
					{#if sparklinePoints.length > 1}
						<MetricSparkline points={sparklinePoints} height={14} width={48} />
					{/if}
				</Badge>
			{/if}
			<Badge variant="outline" class="font-mono text-[10px]">
				<Activity class="size-3" />
				{totals.admitted} admitted
			</Badge>
			<Badge variant="outline" class="font-mono text-[10px]">{totals.pending} pending</Badge>
			<Badge variant="outline" class="font-mono text-[10px]">{totals.reserving} reserving</Badge>
		</div>
	</div>

	{#if aggregateError && aggregateStatus !== 'open'}
		<Alert variant="destructive">
			<AlertDescription class="text-xs">
				Capacity stream {aggregateStatus === 'degraded' ? 'is reconnecting' : 'is unavailable'}.
				{#if aggregateError}
					<span class="font-mono">{aggregateError}</span>
				{/if}
			</AlertDescription>
		</Alert>
	{/if}

	{#if observerError}
		<Alert>
			<AlertDescription class="text-xs">
				Capacity observer snapshot unavailable. <span class="font-mono">{observerError}</span>
			</AlertDescription>
		</Alert>
	{/if}

	{#if observer}
		<section class="grid gap-3 xl:grid-cols-[1fr_auto]">
			<div class="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
				{#each observer.resources as resource (resource.flavor + ':' + resource.resource)}
					<div class="rounded-md border bg-card p-3">
						<div class="mb-2 flex items-start justify-between gap-2">
							<div>
								<div class="text-[11px] uppercase text-muted-foreground">{resource.resource}</div>
								<div class="font-mono text-sm font-semibold">
									{formatQuantityForResource(resource.resource, resource.requested)}
									<span class="text-xs font-normal text-muted-foreground">
										/ {formatQuantityForResource(resource.resource, resource.renderedBudget)}
									</span>
								</div>
							</div>
							<Badge variant="outline" class="text-[10px]">{resource.flavor}</Badge>
						</div>
						<UsageBar
							used={percent(resource.requested, resource.renderedBudget)}
							reserved={0}
							label="requested"
							usedAbsLabel={formatQuantityForResource(resource.resource, resource.requested)}
							nominalLabel={formatQuantityForResource(resource.resource, resource.renderedBudget)}
							hideHeader
						/>
						<div class="mt-2 flex justify-between gap-2 text-[10px] text-muted-foreground">
							<span>reserve {formatQuantityForResource(resource.resource, resource.criticalReserve)}</span>
							<span>headroom {formatQuantityForResource(resource.resource, resource.headroom)}</span>
						</div>
					</div>
				{/each}
			</div>
			<div class="grid min-w-[260px] gap-2 rounded-md border bg-card p-3">
				<div class="flex items-center justify-between gap-2">
					<div class="flex items-center gap-2 text-sm font-medium">
						<Server class="size-4 text-muted-foreground" />
						<span>{observer.cluster}</span>
					</div>
					<Badge variant="outline" class="text-[10px]">{observer.flavor}</Badge>
				</div>
				<div class="grid grid-cols-2 gap-2 text-[11px]">
					{#each observer.criticalHealth as item (item.name)}
						<div class="flex items-center justify-between gap-2 rounded border px-2 py-1.5">
							<span class="capitalize text-muted-foreground">{item.name}</span>
							<span class="inline-flex items-center gap-1 font-mono">
								{#if item.status === 'healthy'}
									<CheckCircle2 class="size-3 text-emerald-500" />
								{:else}
									<AlertTriangle class="size-3 text-amber-500" />
								{/if}
								{item.ready}/{item.total}
							</span>
						</div>
					{/each}
				</div>
				<div class="flex flex-wrap gap-1 text-[10px] text-muted-foreground">
					<span>{observer.nodePressure.schedulableWorkers ?? 0} workers</span>
					<span>{observer.nodePressure.unschedulableWorkers ?? 0} unschedulable</span>
					<span>{observer.recentPreemptions} preemptions</span>
				</div>
			</div>
		</section>
	{/if}

	<section class="space-y-3">
		<header class="flex items-baseline justify-between gap-2">
			<h2 class="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Cluster Queues</h2>
			{#if queues.data.length > 0}
				<span class="text-[11px] text-muted-foreground tabular-nums">{queues.data.length} queue{queues.data.length === 1 ? '' : 's'}</span>
			{/if}
		</header>
		{#if queues.status !== 'open' && queues.data.length === 0}
			<div class="grid gap-4 md:grid-cols-2">
				{#each [0, 1] as i (i)}
					<Card>
						<CardHeader class="pb-2">
							<Skeleton class="h-4 w-32" />
						</CardHeader>
						<CardContent class="space-y-3">
							<Skeleton class="h-2 w-full" />
							<Skeleton class="h-2 w-full" />
							<Skeleton class="h-2 w-3/4" />
						</CardContent>
					</Card>
				{/each}
			</div>
		{:else if queues.data.length === 0}
			<Card>
				<CardContent class="py-8 text-center text-xs text-muted-foreground">
					No ClusterQueues registered in the cluster yet.
				</CardContent>
			</Card>
		{:else}
			<div class="grid gap-4 md:grid-cols-2">
				{#each queues.data as cq (cq.name)}
					<ClusterQueueCard
						clusterQueue={cq}
						recentWorkloads={recentForQueue(cq.name)}
						viewAllHref={`/workspaces/${slug}/capacity/workloads?queue=${encodeURIComponent(cq.name)}`}
						observerQueue={queueSnapshot(cq.name)}
						sessionCapacity={sessionSnapshot(cq.name)}
					/>
				{/each}
			</div>
		{/if}
	</section>

	<section class="space-y-3">
		<header class="flex items-baseline justify-between gap-2">
			<h2 class="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Blocked Workloads</h2>
			{#if blockedWorkloads.length > 0}
				<span class="text-[11px] text-muted-foreground tabular-nums">{blockedWorkloads.length} shown</span>
			{/if}
		</header>
		<Card>
			<CardContent class="p-0">
				{#if blockedWorkloads.length === 0}
					<div class="py-6 text-center text-xs text-muted-foreground">No pending or reserving workloads.</div>
				{:else}
					<ul class="divide-y">
						{#each blockedWorkloads as wl (wl.namespace + ':' + wl.name)}
							<li class="grid gap-2 px-3 py-2 text-xs md:grid-cols-[minmax(0,1fr)_120px_120px_90px] md:items-center">
								<a
									href={`/workspaces/${slug}/capacity/workloads?queue=${encodeURIComponent(wl.queue)}`}
									class="min-w-0 font-mono hover:underline"
									title={wl.name}
								>
									{wl.name}
								</a>
								<span class="font-mono text-muted-foreground">{wl.queue || '—'}</span>
								<span class="truncate text-muted-foreground" title={wl.message || wl.reason}>{wl.reason}</span>
								<span class="inline-flex items-center gap-1 font-mono text-muted-foreground">
									<Clock3 class="size-3" />
									{Math.round(wl.pendingSeconds)}s
								</span>
							</li>
						{/each}
					</ul>
				{/if}
			</CardContent>
		</Card>
	</section>

	<section>
		<ResourceFlavorStrip flavors={flavors.data} />
	</section>
</div>
