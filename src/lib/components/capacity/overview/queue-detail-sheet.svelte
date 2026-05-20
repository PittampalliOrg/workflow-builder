<script lang="ts">
	/**
	 * Detail drawer for a single ClusterQueue, opened by clicking a row in
	 * the headroom table. Holds the full QueueTile content (gauge + status
	 * bar + secondary resources + recent workloads) plus the action links
	 * that used to live inline on QueueHeadroomRow / QueueTile (Headlamp
	 * external + workloads-tab deep-link).
	 *
	 * Embeds <QueueTile> directly with `layoutClass=""` so the tile expands
	 * to the sheet's content width instead of being pinned to the legacy
	 * 240px rail width.
	 */
	import * as Sheet from '$lib/components/ui/sheet';
	import { ExternalLink, ListChecks, Network } from '@lucide/svelte';
	import type { ClusterQueueSnapshot, WorkloadSnapshot } from '$lib/server/kueueviz';
	import type {
		CapacityQueueSnapshot,
		CapacitySessionSnapshot
	} from '$lib/types/capacity';
	import {
		embeddedHeadlampKueueUrl,
		normalizeHeadlampCluster,
		type HeadlampCluster
	} from '$lib/headlamp/links';
	import QueueTile from './queue-tile.svelte';
	import type { GaugeResource } from './gauge-resource-toggle.svelte';

	type Props = {
		open: boolean;
		queue: ClusterQueueSnapshot | null;
		observerQueue?: CapacityQueueSnapshot | null;
		sessionCapacity?: CapacitySessionSnapshot | null;
		recentWorkloads: WorkloadSnapshot[];
		primaryResource: GaugeResource;
		cluster: HeadlampCluster;
		slug: string;
		onOpenChange: (next: boolean) => void;
	};

	let {
		open,
		queue,
		observerQueue = null,
		sessionCapacity = null,
		recentWorkloads,
		primaryResource,
		cluster,
		slug,
		onOpenChange
	}: Props = $props();

	const headlampUrl = $derived(
		queue
			? embeddedHeadlampKueueUrl({
					workspaceSlug: slug,
					cluster: normalizeHeadlampCluster(cluster),
					kind: 'ClusterQueue',
					name: queue.name
				})
			: null
	);

	const workloadsHref = $derived(
		queue ? `/workspaces/${slug}/capacity/workloads?queue=${encodeURIComponent(queue.name)}` : null
	);
</script>

<Sheet.Root {open} onOpenChange={(next) => onOpenChange(next)}>
	<Sheet.Content side="right" class="flex min-h-0 w-full flex-col gap-0 sm:max-w-md">
		<Sheet.Header class="space-y-1 border-b px-5 py-3">
			<Sheet.Title class="flex items-center gap-2 text-base">
				<Network class="size-4 text-muted-foreground" />
				<span class="truncate font-mono text-sm" title={queue?.name ?? ''}>
					{queue?.name ?? ''}
				</span>
			</Sheet.Title>
			<Sheet.Description class="flex flex-wrap items-center gap-3 text-[11px]">
				{#if queue?.cohort}
					<span class="font-mono text-muted-foreground">cohort: {queue.cohort}</span>
				{/if}
				{#if workloadsHref}
					<a
						href={workloadsHref}
						class="inline-flex items-center gap-1 text-primary hover:underline"
					>
						<ListChecks class="size-3" />
						View workloads
					</a>
				{/if}
				{#if headlampUrl}
					<a
						href={headlampUrl}
						class="inline-flex items-center gap-1 text-primary hover:underline"
					>
						<ExternalLink class="size-3" />
						Headlamp
					</a>
				{/if}
			</Sheet.Description>
		</Sheet.Header>

		<div class="flex-1 overflow-auto px-5 py-4">
			{#if queue}
				<QueueTile
					{queue}
					{observerQueue}
					{sessionCapacity}
					{recentWorkloads}
					{primaryResource}
					{cluster}
					{slug}
					layoutClass=""
				/>
			{:else}
				<p class="text-xs text-muted-foreground">No queue selected.</p>
			{/if}
		</div>
	</Sheet.Content>
</Sheet.Root>
