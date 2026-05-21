<script lang="ts">
	/**
	 * Detail drawer for a single capacity contributor (pod, or pod group).
	 *
	 * Opens when a row in <ContributorHeatmap /> is clicked. Surfaces:
	 *   - full identity (name, namespace, queue, kind, pod count)
	 *   - per-resource consumption + share of cluster allocatable
	 *   - trend sparkline (last 60 samples from the page-level history of
	 *     this contributor's weighted share %)
	 *   - Headlamp deep-link.
	 *
	 * Smaller and simpler than `workload-detail-sheet.svelte` — no tabs, no
	 * raw-YAML fetch, no remote streams. Pure projection of what the parent
	 * already holds.
	 */
	import * as Sheet from '$lib/components/ui/sheet';
	import { Badge } from '$lib/components/ui/badge';
	import { ExternalLink, Activity } from '@lucide/svelte';
	import type {
		CapacityContributorSnapshot,
		CapacityResourceSnapshot
	} from '$lib/types/capacity';
	import { formatQuantityForResource } from '$lib/components/capacity/quantity';
	import CapacityOwnerLinks from './capacity-owner-links.svelte';
	import {
		embeddedHeadlampResourceUrl,
		normalizeHeadlampCluster,
		type HeadlampCluster
	} from '$lib/headlamp/links';

	type Props = {
		open: boolean;
		contributor: CapacityContributorSnapshot | null;
		resources: CapacityResourceSnapshot[];
		cluster: HeadlampCluster;
		slug: string;
		/**
		 * Series of weighted-share % values, oldest → newest, for the small
		 * trend sparkline. Caller is responsible for keeping this aligned
		 * with the open contributor (e.g. resetting on contributor change).
		 */
		trend: number[];
		onOpenChange: (next: boolean) => void;
	};

	let {
		open,
		contributor,
		resources,
		cluster,
		slug,
		trend,
		onOpenChange
	}: Props = $props();

	const RESOURCES = ['cpu', 'memory', 'pods', 'ephemeral-storage'] as const;
	type ResKey = (typeof RESOURCES)[number];

	const LABELS: Record<ResKey, string> = {
		cpu: 'CPU',
		memory: 'Memory',
		pods: 'Pods',
		'ephemeral-storage': 'Storage'
	};

	const allocatable = $derived.by<Record<ResKey, number>>(() => {
		const acc: Record<ResKey, number> = {
			cpu: 0,
			memory: 0,
			pods: 0,
			'ephemeral-storage': 0
		};
		for (const r of resources) {
			if (RESOURCES.includes(r.resource as ResKey)) {
				acc[r.resource as ResKey] = r.allocatable;
			}
		}
		return acc;
	});

	const rows = $derived(
		RESOURCES.map((r) => {
			const value = contributor?.resources?.[r] ?? 0;
			const alloc = allocatable[r];
			const pct = alloc > 0 ? (value / alloc) * 100 : 0;
			return { resource: r, value, alloc, pct };
		})
	);

	const podHeadlampHref = $derived.by(() => {
		if (!contributor || !contributor.namespace) return null;
		return embeddedHeadlampResourceUrl({
			workspaceSlug: slug,
			cluster: normalizeHeadlampCluster(cluster),
			kind: 'Pod',
			namespace: contributor.namespace,
			name: contributor.name
		});
	});

	// Sparkline geometry — fixed size, no library; matches the inline
	// MetricSparkline visual language.
	const SPARK_W = 200;
	const SPARK_H = 40;
	const sparkPath = $derived.by(() => {
		if (trend.length < 2) return '';
		const min = Math.min(...trend);
		const max = Math.max(...trend, min + 0.0001);
		const range = max - min;
		const stepX = SPARK_W / Math.max(1, trend.length - 1);
		return trend
			.map((v, i) => {
				const x = i * stepX;
				const y = SPARK_H - ((v - min) / range) * SPARK_H;
				return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
			})
			.join(' ');
	});
</script>

<Sheet.Root {open} onOpenChange={(next) => onOpenChange(next)}>
	<Sheet.Content side="right" class="flex min-h-0 w-full flex-col gap-0 sm:max-w-md">
		<Sheet.Header class="space-y-1 border-b px-5 py-3">
			<Sheet.Title class="flex items-center gap-2 text-base">
				<Activity class="size-4" />
				<span class="truncate font-mono text-sm" title={contributor?.name ?? ''}>
					{contributor?.name ?? ''}
				</span>
				{#if contributor}
					<Badge
						variant={contributor.kind === 'critical' ? 'secondary' : 'outline'}
						class="text-[10px]"
					>
						{contributor.kind}
					</Badge>
				{/if}
			</Sheet.Title>
			<Sheet.Description class="flex flex-wrap items-center gap-2 text-[11px]">
				{#if contributor}
					<span class="font-mono">{contributor.namespace}</span>
					{#if contributor.queue}
						<span class="text-muted-foreground/70">/</span>
						<span class="font-mono">{contributor.queue}</span>
					{/if}
					<span class="text-muted-foreground/70">·</span>
					<span>
						{contributor.podCount} pod{contributor.podCount === 1 ? '' : 's'}
					</span>
				{/if}
			</Sheet.Description>
		</Sheet.Header>

		<div class="flex-1 overflow-auto px-5 py-4 text-sm">
			{#if !contributor}
				<p class="text-xs text-muted-foreground">No contributor selected.</p>
			{:else}
				<section class="space-y-3">
					<h3 class="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
						Resource consumption
					</h3>
					<ul class="space-y-2">
						{#each rows as r (r.resource)}
							<li class="space-y-1">
								<div class="flex items-baseline justify-between text-xs">
									<span class="text-muted-foreground">{LABELS[r.resource]}</span>
									<span class="font-mono tabular-nums">
										{formatQuantityForResource(r.resource, r.value)}
										<span class="text-muted-foreground/70">
											/ {formatQuantityForResource(r.resource, r.alloc)}
										</span>
										<span class="ml-1.5 text-muted-foreground">
											({r.pct.toFixed(1)}%)
										</span>
									</span>
								</div>
								<div class="h-1.5 w-full overflow-hidden rounded-full bg-muted">
									<div
										class="h-full transition-all {r.pct >= 25
											? 'bg-rose-500/70'
											: r.pct >= 10
												? 'bg-amber-500/70'
												: 'bg-emerald-500/70'}"
										style:width="{Math.min(100, r.pct)}%"
									></div>
								</div>
							</li>
						{/each}
					</ul>
				</section>

				<section class="mt-5 space-y-2">
					<h3 class="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
						Trend (weighted share %)
					</h3>
					{#if trend.length < 2}
						<p class="text-[11px] text-muted-foreground/70">
							Collecting samples — open this contributor again in a few seconds for a trend.
						</p>
					{:else}
						<svg
							viewBox="0 0 {SPARK_W} {SPARK_H}"
							width="100%"
							height={SPARK_H}
							class="text-primary"
							aria-label="Contributor share-% trend"
						>
							<path
								d={sparkPath}
								stroke="currentColor"
								stroke-width="1.5"
								fill="none"
								vector-effect="non-scaling-stroke"
							/>
						</svg>
						<p class="text-[10px] text-muted-foreground/70">
							{trend.length} samples · most recent first on the right.
						</p>
					{/if}
				</section>

				{#if contributor.owners?.length}
					<section class="mt-5 space-y-2">
						<h3 class="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
							Related
						</h3>
						<CapacityOwnerLinks owners={contributor.owners} max={5} />
					</section>
				{/if}

				{#if podHeadlampHref}
					<section class="mt-5">
						<a
							href={podHeadlampHref}
							class="inline-flex items-center gap-1.5 text-xs text-primary hover:underline"
						>
							<ExternalLink class="size-3.5" />
							Open pod in Headlamp
						</a>
					</section>
				{/if}
			{/if}
		</div>
	</Sheet.Content>
</Sheet.Root>
