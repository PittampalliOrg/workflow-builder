<script lang="ts">
	import { page } from '$app/state';
	import { Card, CardContent, CardHeader, CardTitle } from '$lib/components/ui/card';
	import { Skeleton } from '$lib/components/ui/skeleton';
	import { Alert, AlertDescription } from '$lib/components/ui/alert';
	import { Badge } from '$lib/components/ui/badge';
	import { ChevronRight, Layers, ListTree } from '@lucide/svelte';
	import { createClusterQueueStream } from '$lib/stores/kueueviz/cluster-queues.svelte';
	import { createLocalQueueStream } from '$lib/stores/kueueviz/local-queues.svelte';
	import { createWorkloadStream } from '$lib/stores/kueueviz/workloads.svelte';
	import StatusPill from '$lib/components/capacity/status-pill.svelte';
	import WorkloadStatusBadge from '$lib/components/capacity/workload-status-badge.svelte';
	import WorkloadDetailSheet from '$lib/components/capacity/workload-detail-sheet.svelte';
	import type { WorkloadSnapshot } from '$lib/server/kueueviz';

	const slug = $derived(page.params.slug as string);

	const clusterQueues = createClusterQueueStream();
	const localQueues = createLocalQueueStream();
	const workloads = createWorkloadStream();

	let selectedClusterQueue = $state<string | null>(null);
	let selectedLocalQueue = $state<string | null>(null); // formatted as `<ns>/<name>`

	// Default-select the first ClusterQueue once we have data so the right
	// pane has something to show on first paint.
	$effect(() => {
		if (selectedClusterQueue === null && clusterQueues.data.length > 0) {
			selectedClusterQueue = clusterQueues.data[0].name;
		}
	});

	// Reset LocalQueue selection when the ClusterQueue changes.
	$effect(() => {
		if (!selectedClusterQueue) {
			selectedLocalQueue = null;
			return;
		}
		const matching = localQueues.data.filter(
			(lq) => lq.clusterQueue === selectedClusterQueue,
		);
		if (
			selectedLocalQueue &&
			!matching.some((lq) => `${lq.namespace}/${lq.name}` === selectedLocalQueue)
		) {
			selectedLocalQueue = null;
		}
	});

	const localQueuesForCq = $derived(
		selectedClusterQueue
			? localQueues.data.filter((lq) => lq.clusterQueue === selectedClusterQueue)
			: [],
	);

	const workloadsForLq = $derived.by(() => {
		if (!selectedLocalQueue) return [];
		const [ns, name] = selectedLocalQueue.split('/');
		// Upstream `/ws/local-queue/:ns/:name/workloads` returns the whole
		// namespace — same trade-off applies here, so we filter client-side
		// against the full workloads stream.
		return workloads.data.filter(
			(wl) => wl.namespace === ns && wl.queueName === name,
		);
	});

	let detailOpen = $state(false);
	let detailNs = $state<string | null>(null);
	let detailName = $state<string | null>(null);

	function selectWorkload(wl: WorkloadSnapshot): void {
		detailNs = wl.namespace;
		detailName = wl.name;
		detailOpen = true;
	}

	const aggregateStatus = $derived.by(() => {
		const statuses = [clusterQueues.status, localQueues.status, workloads.status];
		if (statuses.includes('connecting')) return 'connecting';
		if (statuses.includes('degraded')) return 'degraded';
		if (statuses.includes('closed')) return 'closed';
		return 'open';
	});
	const aggregateUpdate = $derived.by(() => {
		const us = [clusterQueues.lastUpdate, localQueues.lastUpdate, workloads.lastUpdate].filter(
			(u): u is string => Boolean(u),
		);
		return us.sort().at(-1) ?? null;
	});
</script>

<div class="space-y-4">
	<div class="flex items-center justify-between">
		<StatusPill status={aggregateStatus} lastUpdate={aggregateUpdate} />
		<a
			href={`/workspaces/${slug}/capacity/workloads`}
			class="text-xs text-muted-foreground hover:text-foreground"
		>
			View all workloads →
		</a>
	</div>

	{#if clusterQueues.error && aggregateStatus !== 'open'}
		<Alert variant="destructive">
			<AlertDescription class="text-xs font-mono">{clusterQueues.error}</AlertDescription>
		</Alert>
	{/if}

	<div class="grid gap-4 md:grid-cols-[260px_1fr]">
		<!-- Left rail: cluster queues -->
		<aside class="space-y-2">
			<h2 class="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
				Cluster Queues
			</h2>
			{#if clusterQueues.data.length === 0 && clusterQueues.status !== 'open'}
				<div class="space-y-2">
					<Skeleton class="h-10 w-full" />
					<Skeleton class="h-10 w-full" />
				</div>
			{:else if clusterQueues.data.length === 0}
				<p class="text-xs text-muted-foreground">No cluster queues registered.</p>
			{:else}
				<ul class="space-y-1">
					{#each clusterQueues.data as cq (cq.name)}
						{@const active = selectedClusterQueue === cq.name}
						<li>
							<button
								type="button"
								class="w-full rounded-md border px-3 py-2 text-left text-xs transition-colors {active
									? 'border-primary bg-primary/5'
									: 'hover:bg-muted/40'}"
								onclick={() => (selectedClusterQueue = cq.name)}
							>
								<div class="flex items-center justify-between">
									<span class="font-mono font-medium flex items-center gap-1.5">
										<Layers class="size-3 text-muted-foreground" />
										{cq.name}
									</span>
									<ChevronRight class="size-3 text-muted-foreground" />
								</div>
								<div class="mt-1 text-[10px] text-muted-foreground tabular-nums flex flex-wrap gap-2">
									<span>admitted {cq.admittedWorkloads}</span>
									<span>pending {cq.pendingWorkloads}</span>
									<span>reserving {cq.reservingWorkloads}</span>
								</div>
								{#if cq.cohort}
									<Badge variant="outline" class="mt-1 text-[10px]">cohort: {cq.cohort}</Badge>
								{/if}
							</button>
						</li>
					{/each}
				</ul>
			{/if}
		</aside>

		<!-- Right pane: local queues + workloads -->
		<section class="space-y-3">
			{#if !selectedClusterQueue}
				<Card>
					<CardContent class="py-10 text-center text-xs text-muted-foreground">
						Select a Cluster Queue on the left to see its Local Queues.
					</CardContent>
				</Card>
			{:else}
				<Card>
					<CardHeader class="pb-2">
						<CardTitle class="text-sm flex items-center gap-2">
							<ListTree class="size-3.5 text-muted-foreground" />
							Local Queues admitting through
							<span class="font-mono">{selectedClusterQueue}</span>
						</CardTitle>
					</CardHeader>
					<CardContent>
						{#if localQueuesForCq.length === 0}
							<p class="text-xs text-muted-foreground">
								No Local Queues bind to <span class="font-mono">{selectedClusterQueue}</span>.
							</p>
						{:else}
							<ul class="grid gap-2 sm:grid-cols-2">
								{#each localQueuesForCq as lq (lq.namespace + '/' + lq.name)}
									{@const key = `${lq.namespace}/${lq.name}`}
									{@const active = selectedLocalQueue === key}
									<li>
										<button
											type="button"
											class="w-full rounded-md border px-3 py-2 text-left text-xs transition-colors {active
												? 'border-primary bg-primary/5'
												: 'hover:bg-muted/40'}"
											onclick={() => (selectedLocalQueue = key)}
										>
											<div class="flex items-baseline justify-between gap-2">
												<span class="font-mono font-medium truncate">{lq.name}</span>
												<span class="text-[10px] text-muted-foreground">{lq.namespace}</span>
											</div>
											<div class="mt-1 text-[10px] text-muted-foreground tabular-nums flex flex-wrap gap-2">
												<span>admitted {lq.admittedWorkloads}</span>
												<span>pending {lq.pendingWorkloads}</span>
												<span>reserving {lq.reservingWorkloads}</span>
											</div>
										</button>
									</li>
								{/each}
							</ul>
						{/if}
					</CardContent>
				</Card>

				{#if selectedLocalQueue}
					<Card>
						<CardHeader class="pb-2">
							<CardTitle class="text-sm flex items-center gap-2">
								<ListTree class="size-3.5 text-muted-foreground" />
								Workloads on <span class="font-mono">{selectedLocalQueue}</span>
							</CardTitle>
						</CardHeader>
						<CardContent>
							{#if workloadsForLq.length === 0}
								<p class="text-xs text-muted-foreground">
									No workloads currently held by this Local Queue.
								</p>
							{:else}
								<ul class="divide-y">
									{#each workloadsForLq as wl (wl.uid || wl.name)}
										<li>
											<button
												type="button"
												class="flex w-full items-center justify-between gap-2 py-1.5 text-xs hover:bg-muted/40 rounded px-1"
												onclick={() => selectWorkload(wl)}
											>
												<div class="flex items-center gap-2 min-w-0">
													<WorkloadStatusBadge status={wl.status} />
													<span class="font-mono truncate" title={wl.name}>{wl.name}</span>
												</div>
												<span class="text-muted-foreground tabular-nums text-[10px]">
													{wl.totalPods} pod{wl.totalPods === 1 ? '' : 's'}
												</span>
											</button>
										</li>
									{/each}
								</ul>
							{/if}
						</CardContent>
					</Card>
				{/if}
			{/if}
		</section>
	</div>

	<WorkloadDetailSheet
		open={detailOpen}
		namespace={detailNs}
		name={detailName}
		onOpenChange={(next) => {
			detailOpen = next;
			if (!next) {
				detailNs = null;
				detailName = null;
			}
		}}
	/>
</div>
