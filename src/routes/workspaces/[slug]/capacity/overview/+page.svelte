<script lang="ts">
	import { page } from '$app/state';
	import {
		Card,
		CardContent,
		CardHeader,
		CardTitle
	} from '$lib/components/ui/card';
	import { Skeleton } from '$lib/components/ui/skeleton';
	import { Alert, AlertDescription } from '$lib/components/ui/alert';
	import { Badge } from '$lib/components/ui/badge';
	import { Activity, ListChecks } from '@lucide/svelte';
	import { createClusterQueueStream } from '$lib/stores/kueueviz/cluster-queues.svelte';
	import { createWorkloadStream } from '$lib/stores/kueueviz/workloads.svelte';
	import { createResourceFlavorStream } from '$lib/stores/kueueviz/resource-flavors.svelte';
	import ClusterQueueCard from '$lib/components/capacity/cluster-queue-card.svelte';
	import ResourceFlavorStrip from '$lib/components/capacity/resource-flavor-strip.svelte';
	import StatusPill from '$lib/components/capacity/status-pill.svelte';

	const slug = $derived(page.params.slug as string);

	const queues = createClusterQueueStream();
	const workloads = createWorkloadStream();
	const flavors = createResourceFlavorStream();

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
					/>
				{/each}
			</div>
		{/if}
	</section>

	<section>
		<ResourceFlavorStrip flavors={flavors.data} />
	</section>

	<Card>
		<CardHeader>
			<CardTitle class="text-sm">How this view works</CardTitle>
		</CardHeader>
		<CardContent class="text-xs text-muted-foreground space-y-1">
			<p>
				Streams live from the cluster's <code class="font-mono">kueue-kueueviz-backend</code>
				Service. Each event is a full snapshot — the BFF caches the latest and fans out to all
				viewers, so opening this page on multiple tabs costs the upstream a single connection.
			</p>
			<p>
				Workloads admitted via <code class="font-mono">durable/run</code>,
				<code class="font-mono">benchmark</code> runs, and Sandbox-execution flows pass through
				these queues. Cross-links from Sessions and Benchmarks land in v1.1.
			</p>
		</CardContent>
	</Card>
</div>
