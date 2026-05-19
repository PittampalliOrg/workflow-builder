<script lang="ts">
	import {
		Card,
		CardContent,
		CardDescription,
		CardHeader,
		CardTitle
	} from '$lib/components/ui/card';
	import { Badge } from '$lib/components/ui/badge';
	import { Layers, Network } from '@lucide/svelte';
	import type { ClusterQueueSnapshot, WorkloadSnapshot } from '$lib/server/kueueviz';
	import type {
		CapacityQueueSnapshot as ObserverQueueSnapshot,
		CapacitySessionSnapshot
	} from '$lib/types/capacity';
	import UsageBar from './usage-bar.svelte';
	import WorkloadStatusBadge from './workload-status-badge.svelte';
	import { formatQuantityForResource, quantityRatios } from './quantity';

	type Props = {
		clusterQueue: ClusterQueueSnapshot;
		recentWorkloads: WorkloadSnapshot[];
		viewAllHref: string;
		observerQueue?: ObserverQueueSnapshot | null;
		sessionCapacity?: CapacitySessionSnapshot | null;
	};

	let {
		clusterQueue,
		recentWorkloads,
		viewAllHref,
		observerQueue = null,
		sessionCapacity = null
	}: Props = $props();

	const totalActive = $derived(
		clusterQueue.admittedWorkloads +
			clusterQueue.pendingWorkloads +
			clusterQueue.reservingWorkloads
	);

	type ResourceRow = {
		flavor: string;
		resource: string;
		used: number;
		reserved: number;
		over: number;
		usedAbs: number;
		reservedAbs: number;
		nominalAbs: number;
		usedLabel: string;
		nominalLabel: string;
		reservedLabel: string;
	};

	const rows = $derived.by<ResourceRow[]>(() => {
		const out: ResourceRow[] = [];
		for (const flavor of clusterQueue.flavorsUsage) {
			for (const r of flavor.resources) {
				const ratios = quantityRatios(r.used, r.reserved, r.nominal);
				out.push({
					flavor: flavor.flavor,
					resource: r.resource,
					used: ratios.used,
					reserved: ratios.reserved,
					over: ratios.over,
					usedAbs: ratios.usedAbs,
					reservedAbs: ratios.reservedAbs,
					nominalAbs: ratios.nominal,
					usedLabel: formatQuantityForResource(r.resource, ratios.usedAbs),
					nominalLabel: formatQuantityForResource(r.resource, ratios.nominal),
					reservedLabel:
						ratios.reservedAbs > 0
							? formatQuantityForResource(r.resource, ratios.reservedAbs)
							: '0'
				});
			}
		}
		return out;
	});

	const groupedRows = $derived.by(() => {
		const map = new Map<string, ResourceRow[]>();
		for (const row of rows) {
			const list = map.get(row.flavor) ?? [];
			list.push(row);
			map.set(row.flavor, list);
		}
		return Array.from(map.entries());
	});

	const waitP95 = $derived(observerQueue?.admissionWaitP95Seconds ?? null);
</script>

<Card>
	<CardHeader class="pb-2">
		<div class="flex items-start justify-between gap-3">
			<div class="space-y-1">
				<CardTitle class="text-base flex items-center gap-2">
					<Layers class="size-4 text-muted-foreground" />
					<span class="font-mono">{clusterQueue.name}</span>
					{#if clusterQueue.cohort}
						<Badge variant="outline" class="text-[10px]">
							<Network class="size-3" />
							{clusterQueue.cohort}
						</Badge>
					{/if}
					{#if sessionCapacity?.fits !== null && sessionCapacity?.fits !== undefined}
						<Badge variant="outline" class="text-[10px]">
							fits {sessionCapacity.fits}
						</Badge>
					{/if}
				</CardTitle>
				<CardDescription class="text-[11px]">
					{totalActive} workload{totalActive === 1 ? '' : 's'} currently held by this queue
				</CardDescription>
			</div>
			<div class="flex flex-col items-end gap-1 text-[10px]">
				<div class="flex items-center gap-2">
					<span class="text-muted-foreground">Admitted</span>
					<span class="font-mono font-semibold tabular-nums">{clusterQueue.admittedWorkloads}</span>
				</div>
				<div class="flex items-center gap-2">
					<span class="text-muted-foreground">Pending</span>
					<span class="font-mono font-semibold tabular-nums">{clusterQueue.pendingWorkloads}</span>
				</div>
				<div class="flex items-center gap-2">
					<span class="text-muted-foreground">Reserving</span>
					<span class="font-mono font-semibold tabular-nums">{clusterQueue.reservingWorkloads}</span>
				</div>
				{#if waitP95 !== null}
					<div class="flex items-center gap-2">
						<span class="text-muted-foreground">Wait P95</span>
						<span class="font-mono font-semibold tabular-nums">{Math.round(waitP95)}s</span>
					</div>
				{/if}
			</div>
		</div>
	</CardHeader>
	<CardContent class="space-y-4">
		{#if groupedRows.length === 0}
			<p class="text-xs text-muted-foreground">No flavor usage reported yet.</p>
		{:else}
			{#each groupedRows as [flavor, flavorRows] (flavor)}
				<section class="space-y-2">
					<header class="flex items-center justify-between gap-2 text-[11px]">
						<span class="font-medium">Flavor: <span class="font-mono">{flavor}</span></span>
						<span class="text-muted-foreground">{flavorRows.length} resource{flavorRows.length === 1 ? '' : 's'}</span>
					</header>
					<div class="space-y-2">
						{#each flavorRows as row (row.flavor + ':' + row.resource)}
							<UsageBar
								used={row.used}
								reserved={row.reserved}
								over={row.over}
								label={row.resource}
								usedAbsLabel={row.usedLabel}
								reservedAbsLabel={row.reservedAbs > 0 ? row.reservedLabel : undefined}
								nominalLabel={row.nominalLabel}
							/>
						{/each}
					</div>
				</section>
			{/each}
		{/if}

		<section class="space-y-2 border-t pt-3">
			<header class="flex items-center justify-between gap-2 text-[11px]">
				<span class="font-medium">Recent workloads</span>
				<a href={viewAllHref} class="text-primary hover:underline">View all →</a>
			</header>
			{#if recentWorkloads.length === 0}
				<p class="text-xs text-muted-foreground">No workloads on this queue.</p>
			{:else}
				<ul class="divide-y">
					{#each recentWorkloads as wl (wl.uid || wl.name)}
						<li class="flex items-center justify-between gap-2 py-1.5 text-xs">
							<div class="flex items-center gap-2 min-w-0">
								<WorkloadStatusBadge status={wl.status} />
								<span class="font-mono truncate" title={wl.name}>{wl.name}</span>
								<span class="text-muted-foreground/70 truncate hidden sm:inline">{wl.namespace}</span>
							</div>
							<span class="text-muted-foreground tabular-nums text-[10px]">
								{wl.totalPods} pod{wl.totalPods === 1 ? '' : 's'}
							</span>
						</li>
					{/each}
				</ul>
			{/if}
		</section>
	</CardContent>
</Card>
