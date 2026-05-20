<script lang="ts">
	/**
	 * One row in the Zone B right column ("Queues · Headroom"): queue name,
	 * compressed UsageBar for the active gauge resource, used/nominal labels,
	 * and a Headlamp deep-link.
	 */
	import { ChevronRight, Hourglass } from '@lucide/svelte';
	import type { ClusterQueueSnapshot } from '$lib/server/kueueviz';
	import type { CapacityQueueSnapshot } from '$lib/types/capacity';
	import {
		formatQuantityForResource,
		parseQuantity,
		quantityRatios
	} from '$lib/components/capacity/quantity';
	import UsageBar from '$lib/components/capacity/usage-bar.svelte';
	import { type HeadlampCluster } from '$lib/headlamp/links';
	import type { GaugeResource } from './gauge-resource-toggle.svelte';

	type Props = {
		queue: ClusterQueueSnapshot;
		observerQueue?: CapacityQueueSnapshot | null;
		resource: GaugeResource;
		cluster: HeadlampCluster;
		slug: string;
		/**
		 * Fires when the row is clicked. Parent opens the per-queue detail
		 * sheet. The Headlamp link + "view workloads" link that used to live
		 * inline have moved into the sheet so the row stays a single click
		 * target (nested interactive elements are an a11y/HTML pitfall).
		 */
		onSelect?: (queue: ClusterQueueSnapshot) => void;
	};

	let { queue, observerQueue = null, resource, onSelect }: Props = $props();

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

	const waitP95 = $derived(observerQueue?.admissionWaitP95Seconds ?? null);

	// Status dot tone matches UsageBar thresholds (<70 / 70-89 / ≥90 %).
	// When the queue has pending workloads, the dot pulses amber regardless
	// of utilization — admission backpressure is the headline signal.
	const dotTone = $derived.by(() => {
		const pct = resourceRow.usedPct + resourceRow.reservedPct;
		if (pct >= 90 || resourceRow.overPct > 0) return 'rose';
		if (pct >= 70) return 'amber';
		return 'emerald';
	});
	const pending = $derived(queue.pendingWorkloads + queue.reservingWorkloads);
	const dotClass = $derived(
		pending > 0
			? 'bg-amber-500 animate-pulse'
			: dotTone === 'rose'
				? 'bg-rose-500'
				: dotTone === 'amber'
					? 'bg-amber-500'
					: 'bg-emerald-500'
	);

	const showCounts = $derived(
		queue.admittedWorkloads > 0 || queue.pendingWorkloads > 0 || queue.reservingWorkloads > 0
	);
</script>

<button
	type="button"
	class="grid w-full grid-cols-[auto_minmax(0,1fr)_140px_auto_auto_auto] items-center gap-3 rounded px-2 py-1.5 text-left transition-colors hover:bg-muted/40 focus-visible:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
	onclick={() => onSelect?.(queue)}
	aria-label={`Open ${queue.name} detail`}
>
	<span
		class="size-2 shrink-0 rounded-full {dotClass}"
		aria-hidden="true"
		title={pending > 0
			? `${pending} pending / reserving`
			: `${Math.round(resourceRow.usedPct + resourceRow.reservedPct)}% utilized`}
	></span>

	<div class="flex min-w-0 items-center gap-2">
		<span class="min-w-0 truncate font-mono text-xs" title={queue.name}>
			{queue.name}
		</span>
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
	</div>

	{#if showCounts}
		<span
			class="inline-flex shrink-0 items-center gap-1 rounded border bg-muted/30 px-1.5 py-0 text-[9px] font-mono tabular-nums"
			title={`${queue.admittedWorkloads} admitted · ${queue.pendingWorkloads} pending · ${queue.reservingWorkloads} reserving`}
		>
			<span class="text-emerald-600 dark:text-emerald-400">{queue.admittedWorkloads}</span>
			<span class="text-muted-foreground/40">·</span>
			<span class="text-amber-600 dark:text-amber-400">{queue.pendingWorkloads}</span>
			<span class="text-muted-foreground/40">·</span>
			<span class="text-sky-600 dark:text-sky-400">{queue.reservingWorkloads}</span>
		</span>
	{:else}
		<span class="w-[1px]"></span>
	{/if}

	<ChevronRight class="size-3.5 text-muted-foreground/50 transition-transform group-hover:translate-x-0.5" />
</button>
