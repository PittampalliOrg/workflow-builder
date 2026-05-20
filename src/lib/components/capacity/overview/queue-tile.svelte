<script lang="ts">
	/**
	 * One queue tile in the Zone C horizontal rail. Shows the cluster queue's
	 * primary-resource gauge (driven by the page-level resource toggle), the
	 * three other resources as thin UsageBars, current counts, wait P95, and
	 * up to 3 recent workloads — each linkable into Headlamp.
	 */
	import { ArrowRight, ChevronRight, ExternalLink, Hourglass, Network } from '@lucide/svelte';
	import { Badge } from '$lib/components/ui/badge';
	import type { ClusterQueueSnapshot, WorkloadSnapshot } from '$lib/server/kueueviz';
	import type {
		CapacityQueueSnapshot,
		CapacitySessionSnapshot
	} from '$lib/types/capacity';
	import UsageBar from '$lib/components/capacity/usage-bar.svelte';
	import WorkloadStatusBadge from '$lib/components/capacity/workload-status-badge.svelte';
	import {
		formatQuantityForResource,
		parseQuantity,
		quantityRatios
	} from '$lib/components/capacity/quantity';
	import {
		headlampKueueUrl,
		normalizeHeadlampCluster,
		type HeadlampCluster
	} from '$lib/headlamp/links';
	import CapacityGauge from './capacity-gauge.svelte';
	import type { GaugeResource } from './gauge-resource-toggle.svelte';

	type Props = {
		queue: ClusterQueueSnapshot;
		observerQueue?: CapacityQueueSnapshot | null;
		sessionCapacity?: CapacitySessionSnapshot | null;
		recentWorkloads: WorkloadSnapshot[];
		primaryResource: GaugeResource;
		cluster: HeadlampCluster;
		slug: string;
		/**
		 * Override the outer container width. Default matches the legacy
		 * rail layout (240px fixed, snap-start). Pass an empty string when
		 * embedding in a Sheet so the tile expands to its container.
		 */
		layoutClass?: string;
	};

	let {
		queue,
		observerQueue = null,
		sessionCapacity = null,
		recentWorkloads,
		primaryResource,
		cluster,
		slug,
		layoutClass = 'w-[240px] shrink-0 snap-start'
	}: Props = $props();

	const ALL_RESOURCES: GaugeResource[] = ['cpu', 'memory', 'pods', 'ephemeral-storage'];
	const SECONDARY_RESOURCES = $derived(
		ALL_RESOURCES.filter((r) => r !== primaryResource)
	);

	function resourceRow(resource: GaugeResource) {
		const observerResource = observerQueue?.resources.find((r) => r.resource === resource);
		if (observerResource) {
			const usedAbs = observerResource.used;
			const reservedAbs = Math.max(0, observerResource.reserved - usedAbs);
			const nominalAbs = observerResource.nominal;
			const overAbs = Math.max(0, observerResource.used + observerResource.reserved - nominalAbs);
			return {
				usedAbs,
				reservedAbs,
				nominalAbs,
				usedPct: nominalAbs > 0 ? Math.min(100, (usedAbs / nominalAbs) * 100) : 0,
				reservedPct:
					nominalAbs > 0
						? Math.max(
								0,
								Math.min(100 - (usedAbs / nominalAbs) * 100, (reservedAbs / nominalAbs) * 100)
							)
						: 0,
				overPct: nominalAbs > 0 ? Math.min(100, (overAbs / nominalAbs) * 100) : 0
			};
		}
		const flavor = queue.flavorsUsage[0];
		const r = flavor?.resources.find((rr) => rr.resource === resource);
		if (!r) {
			return {
				usedAbs: 0,
				reservedAbs: 0,
				nominalAbs: 0,
				usedPct: 0,
				reservedPct: 0,
				overPct: 0
			};
		}
		const ratios = quantityRatios(r.used, r.reserved, r.nominal);
		return {
			usedAbs: ratios.usedAbs,
			reservedAbs: ratios.reservedAbs,
			nominalAbs: parseQuantity(r.nominal),
			usedPct: ratios.used,
			reservedPct: ratios.reserved,
			overPct: ratios.over
		};
	}

	const primary = $derived(resourceRow(primaryResource));
	const overAbs = $derived(Math.max(0, primary.usedAbs - primary.nominalAbs));

	const headlampUrl = $derived(
		headlampKueueUrl({
			cluster: normalizeHeadlampCluster(cluster),
			kind: 'ClusterQueue',
			name: queue.name
		})
	);

	function workloadHeadlampUrl(wl: WorkloadSnapshot): string | null {
		return headlampKueueUrl({
			cluster: normalizeHeadlampCluster(cluster),
			kind: 'Workload',
			namespace: wl.namespace,
			name: wl.name
		});
	}

	const totalActive = $derived(
		queue.admittedWorkloads + queue.pendingWorkloads + queue.reservingWorkloads
	);

	const waitP95 = $derived(observerQueue?.admissionWaitP95Seconds ?? null);

	const RESOURCE_LABELS: Record<GaugeResource, string> = {
		cpu: 'CPU',
		memory: 'Memory',
		pods: 'Pods',
		'ephemeral-storage': 'Storage'
	};

	const detailHref = $derived(
		`/workspaces/${slug}/capacity/workloads?queue=${encodeURIComponent(queue.name)}`
	);
</script>

<article
	class="group flex h-full flex-col rounded-md border bg-card p-3 shadow-sm transition-shadow hover:border-primary/40 hover:shadow-md focus-within:ring-2 focus-within:ring-primary/30 {layoutClass}"
>
	<header class="flex items-start justify-between gap-2">
		<div class="min-w-0 space-y-1">
			<a
				href={detailHref}
				class="group/name flex min-w-0 items-center gap-0.5 truncate font-mono text-xs font-semibold hover:underline"
				title={`Open ${queue.name} workloads`}
			>
				<span class="truncate">{queue.name}</span>
				<ChevronRight
					class="size-3 shrink-0 text-muted-foreground/60 transition-transform group-hover/name:translate-x-0.5 group-hover/name:text-primary"
				/>
			</a>
			<div class="flex flex-wrap items-center gap-1 text-[10px]">
				{#if queue.cohort}
					<Badge variant="outline" class="font-mono text-[9px]">
						<Network class="size-2.5" />
						{queue.cohort}
					</Badge>
				{/if}
				{#if sessionCapacity?.fits !== null && sessionCapacity?.fits !== undefined}
					<Badge variant="outline" class="font-mono text-[9px]">
						fits {sessionCapacity.fits}
					</Badge>
				{/if}
			</div>
		</div>
		{#if headlampUrl}
			<a
				href={headlampUrl}
				target="_blank"
				rel="noopener noreferrer"
				class="shrink-0 text-muted-foreground/70 hover:text-foreground"
				title={`Open ${queue.name} in Headlamp`}
			>
				<ExternalLink class="size-3.5" />
			</a>
		{/if}
	</header>

	<div class="mt-2 flex flex-col items-center">
		<CapacityGauge
			used={primary.usedAbs}
			nominal={primary.nominalAbs}
			over={overAbs}
			primaryLabel={RESOURCE_LABELS[primaryResource]}
			secondaryLabel={`${formatQuantityForResource(primaryResource, primary.usedAbs)} / ${formatQuantityForResource(primaryResource, primary.nominalAbs)}`}
			size={120}
			strokeWidth={10}
		/>
	</div>

	{#if totalActive === 0}
		<div class="mt-2 text-center text-[10px] text-muted-foreground/70">no active workloads</div>
	{:else}
		{@const admPct = (queue.admittedWorkloads / totalActive) * 100}
		{@const pendPct = (queue.pendingWorkloads / totalActive) * 100}
		{@const resPct = (queue.reservingWorkloads / totalActive) * 100}
		<div class="mt-2 space-y-1">
			<div
				class="flex h-2 w-full overflow-hidden rounded-full bg-muted"
				title={`admitted ${queue.admittedWorkloads} · pending ${queue.pendingWorkloads} · reserving ${queue.reservingWorkloads}`}
			>
				{#if admPct > 0}
					<div class="h-full bg-emerald-500/80" style:width="{admPct}%"></div>
				{/if}
				{#if pendPct > 0}
					<div class="h-full bg-amber-500/80" style:width="{pendPct}%"></div>
				{/if}
				{#if resPct > 0}
					<div class="h-full bg-sky-500/80" style:width="{resPct}%"></div>
				{/if}
			</div>
			<div class="flex items-center justify-between text-[10px] tabular-nums">
				<span class="font-mono text-emerald-600 dark:text-emerald-400">
					{queue.admittedWorkloads}
					<span class="text-muted-foreground/70">adm</span>
				</span>
				<span class="font-mono text-amber-600 dark:text-amber-400">
					{queue.pendingWorkloads}
					<span class="text-muted-foreground/70">pend</span>
				</span>
				<span class="font-mono text-sky-600 dark:text-sky-400">
					{queue.reservingWorkloads}
					<span class="text-muted-foreground/70">res</span>
				</span>
			</div>
		</div>
	{/if}

	{#if waitP95 !== null && waitP95 > 0}
		<div class="mt-1.5 flex items-center justify-center gap-1 text-[10px] text-muted-foreground">
			<Hourglass class="size-2.5" />
			wait P95 <span class="font-mono">{Math.round(waitP95)}s</span>
		</div>
	{/if}

	<div class="mt-2 space-y-1.5 border-t pt-2">
		{#each SECONDARY_RESOURCES as resource (resource)}
			{@const row = resourceRow(resource)}
			<div class="space-y-0.5">
				<div class="flex items-baseline justify-between text-[10px]">
					<span class="text-muted-foreground">{RESOURCE_LABELS[resource]}</span>
					<span class="font-mono tabular-nums text-muted-foreground">
						{formatQuantityForResource(resource, row.usedAbs)}
						<span class="text-muted-foreground/60"> / {formatQuantityForResource(resource, row.nominalAbs)}</span>
					</span>
				</div>
				<UsageBar
					used={row.usedPct}
					reserved={row.reservedPct}
					over={row.overPct}
					hideHeader={true}
				/>
			</div>
		{/each}
	</div>

	<div class="mt-auto pt-2">
		<div class="flex items-center justify-between gap-2 text-[10px]">
			<span class="text-muted-foreground">Recent ({totalActive})</span>
			<a href={detailHref} class="inline-flex items-center gap-0.5 text-primary hover:underline">
				all
				<ArrowRight class="size-2.5" />
			</a>
		</div>
		{#if recentWorkloads.length === 0}
			<p class="mt-1 text-[10px] text-muted-foreground/70">idle</p>
		{:else}
			<ul class="mt-1 space-y-0.5">
				{#each recentWorkloads.slice(0, 3) as wl (wl.uid || wl.name)}
					{@const wlUrl = workloadHeadlampUrl(wl)}
					<li class="flex items-center gap-1 text-[10px]">
						<WorkloadStatusBadge status={wl.status} />
						<a
							href={wlUrl ?? detailHref}
							target={wlUrl ? '_blank' : undefined}
							rel={wlUrl ? 'noopener noreferrer' : undefined}
							class="min-w-0 truncate font-mono hover:underline"
							title={wl.name}
						>
							{wl.name}
						</a>
					</li>
				{/each}
			</ul>
		{/if}
	</div>
</article>
