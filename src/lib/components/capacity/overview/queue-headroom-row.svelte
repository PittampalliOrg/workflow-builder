<script lang="ts">
	/**
	 * One row in the Zone B right column ("Queues · Headroom"): queue name,
	 * compressed UsageBar for the active gauge resource, used/nominal labels,
	 * and a Headlamp deep-link.
	 */
	import { ExternalLink, Hourglass } from '@lucide/svelte';
	import type { ClusterQueueSnapshot } from '$lib/server/kueueviz';
	import type { CapacityQueueSnapshot } from '$lib/types/capacity';
	import {
		formatQuantityForResource,
		parseQuantity,
		quantityRatios
	} from '$lib/components/capacity/quantity';
	import UsageBar from '$lib/components/capacity/usage-bar.svelte';
	import {
		headlampKueueUrl,
		normalizeHeadlampCluster,
		type HeadlampCluster
	} from '$lib/headlamp/links';
	import type { GaugeResource } from './gauge-resource-toggle.svelte';

	type Props = {
		queue: ClusterQueueSnapshot;
		observerQueue?: CapacityQueueSnapshot | null;
		resource: GaugeResource;
		cluster: HeadlampCluster;
		slug: string;
	};

	let { queue, observerQueue = null, resource, cluster, slug }: Props = $props();

	const resourceRow = $derived.by(() => {
		// Prefer the observer-derived resource numbers (account for over-borrowing
		// across the cohort) but fall back to the KueueViz flavorsUsage strings.
		const observerResource = observerQueue?.resources.find((r) => r.resource === resource);
		if (observerResource) {
			const used = observerResource.used;
			const nominal = observerResource.nominal;
			const reserved = observerResource.reserved;
			const overAbs = Math.max(0, used + reserved - nominal);
			return {
				usedAbs: used,
				reservedAbs: Math.max(0, reserved - used),
				nominalAbs: nominal,
				usedPct: nominal > 0 ? Math.min(100, (used / nominal) * 100) : 0,
				reservedPct:
					nominal > 0
						? Math.max(0, Math.min(100 - (used / nominal) * 100, (reserved / nominal) * 100))
						: 0,
				overPct: nominal > 0 ? Math.min(100, (overAbs / nominal) * 100) : 0
			};
		}

		// KueueViz fallback — string-typed quantities.
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
	});

	const headlampUrl = $derived(
		headlampKueueUrl({
			cluster: normalizeHeadlampCluster(cluster),
			kind: 'ClusterQueue',
			name: queue.name
		})
	);

	const detailHref = $derived(
		`/workspaces/${slug}/capacity/workloads?queue=${encodeURIComponent(queue.name)}`
	);

	const waitP95 = $derived(observerQueue?.admissionWaitP95Seconds ?? null);
</script>

<div class="grid grid-cols-[minmax(0,1fr)_140px_auto] items-center gap-3 py-1.5">
	<div class="flex min-w-0 items-center gap-2">
		<a
			href={detailHref}
			class="min-w-0 truncate font-mono text-xs hover:underline"
			title={`${queue.name} — view workloads`}
		>
			{queue.name}
		</a>
		{#if waitP95 !== null && waitP95 > 0}
			<span
				class="inline-flex shrink-0 items-center gap-0.5 rounded border border-amber-500/30 bg-amber-500/10 px-1 py-0 text-[9px] font-mono text-amber-700 dark:text-amber-400"
				title="Admission wait P95 (last 5 min)"
			>
				<Hourglass class="size-2.5" />
				{Math.round(waitP95)}s
			</span>
		{/if}
	</div>

	<div class="min-w-0">
		<UsageBar
			used={resourceRow.usedPct}
			reserved={resourceRow.reservedPct}
			over={resourceRow.overPct}
			hideHeader={true}
		/>
	</div>

	<div class="flex items-center gap-1.5 text-[11px] tabular-nums whitespace-nowrap">
		<span class="font-mono text-foreground">
			{formatQuantityForResource(resource, resourceRow.usedAbs)}
		</span>
		<span class="text-muted-foreground/60">/</span>
		<span class="font-mono text-muted-foreground">
			{formatQuantityForResource(resource, resourceRow.nominalAbs)}
		</span>
		{#if headlampUrl}
			<a
				href={headlampUrl}
				target="_blank"
				rel="noopener noreferrer"
				class="text-muted-foreground/70 hover:text-foreground"
				title={`Open ${queue.name} in Headlamp`}
			>
				<ExternalLink class="size-3" />
			</a>
		{/if}
	</div>
</div>
