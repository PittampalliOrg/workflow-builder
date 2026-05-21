<script lang="ts">
	/**
	 * Compact heatmap of pods that are currently consuming worker capacity.
	 *
	 * Rows are pods (top N by `contributorScore`), columns are CPU / Memory /
	 * Pods / Storage. Each cell's tone (emerald → amber → rose) tracks the
	 * contributor's share of `observer.flavor` allocatable so the cluster's
	 * heavy hitters jump out without needing to read numbers.
	 *
	 * Clicking a row deep-links the pod into Headlamp.
	 */
	import { ExternalLink } from '@lucide/svelte';
	import { Badge } from '$lib/components/ui/badge';
	import CapacityOwnerLinks from './capacity-owner-links.svelte';
	import type {
		CapacityContributorSnapshot,
		CapacityResourceSnapshot
	} from '$lib/types/capacity';
	import { formatQuantityForResource } from '$lib/components/capacity/quantity';
	import {
		embeddedHeadlampResourceUrl,
		normalizeHeadlampCluster,
		type HeadlampCluster
	} from '$lib/headlamp/links';

	type Props = {
		contributors: CapacityContributorSnapshot[];
		resources: CapacityResourceSnapshot[];
		cluster: HeadlampCluster;
		slug: string;
		max?: number;
		/**
		 * Optional per-contributor share-% history, keyed by `contributor.key`.
		 * When present, an inline sparkline is rendered per row. The parent owns
		 * the buffer; this component is a pure projection.
		 */
		trends?: Record<string, number[]>;
		/**
		 * Fires when a row is clicked. Receives the contributor; parent decides
		 * whether to open a sheet, navigate, etc.
		 */
		onSelect?: (c: CapacityContributorSnapshot) => void;
	};

	let {
		contributors,
		resources,
		cluster,
		slug,
		max = 12,
		trends,
		onSelect
	}: Props = $props();

	const SPARK_W = 56;
	const SPARK_H = 14;
	function sparkPath(values: number[]): string {
		if (values.length < 2) return '';
		const min = Math.min(...values);
		const max_ = Math.max(...values, min + 0.0001);
		const range = max_ - min;
		const stepX = SPARK_W / Math.max(1, values.length - 1);
		return values
			.map((v, i) => {
				const x = i * stepX;
				const y = SPARK_H - ((v - min) / range) * SPARK_H;
				return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
			})
			.join(' ');
	}

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

	function contributorScore(c: CapacityContributorSnapshot): number {
		return (
			(c.resources?.cpu ?? 0) * 1000 +
			((c.resources?.memory ?? 0) / 1024 ** 3) * 25 +
			(c.resources?.['ephemeral-storage'] ?? 0) / 1024 ** 3 +
			(c.resources?.pods ?? 0) * 10
		);
	}

	const top = $derived(
		[...contributors].sort((a, b) => contributorScore(b) - contributorScore(a)).slice(0, max)
	);

	function cellTone(value: number, allocatableValue: number): string {
		if (allocatableValue <= 0 || value <= 0) {
			return 'bg-muted/30 text-muted-foreground/60';
		}
		const pct = (value / allocatableValue) * 100;
		if (pct >= 25) return 'bg-rose-500/15 text-rose-700 dark:text-rose-300';
		if (pct >= 10) return 'bg-amber-500/15 text-amber-700 dark:text-amber-300';
		return 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300';
	}

	function podHeadlampUrl(c: CapacityContributorSnapshot): string | null {
		// Contributor `name` is the pod or owner name. We assume the row
		// represents a pod when `podCount === 1` AND `kind === 'workload'`;
		// for higher pod counts there's no single pod URL — fall through to
		// the Pods list filtered to this namespace.
		if (!c.namespace) return null;
		return embeddedHeadlampResourceUrl({
			workspaceSlug: slug,
			cluster: normalizeHeadlampCluster(cluster),
			kind: 'Pod',
			namespace: c.namespace,
			name: c.name
		});
	}
</script>

{#if top.length === 0}
	<p class="text-xs text-muted-foreground">No worker pod requests reported.</p>
{:else if top.length < 3}
	<div class="flex flex-wrap items-center gap-1.5 text-xs">
		<Badge variant="outline" class="text-[10px]">
			{top.length} contributor{top.length === 1 ? '' : 's'} active
		</Badge>
		{#each top as c (c.key)}
			<span class="font-mono text-[11px]">{c.name}</span>
		{/each}
	</div>
{:else}
	<div class="overflow-x-auto">
		<table class="w-full text-[11px]">
			<thead>
				<tr class="text-[10px] uppercase text-muted-foreground">
					<th class="px-2 py-1.5 text-left font-medium">Contributor</th>
					{#each RESOURCES as r (r)}
						<th class="px-1.5 py-1.5 text-right font-medium tabular-nums">{LABELS[r]}</th>
					{/each}
					{#if trends}
						<th class="px-2 py-1.5 text-center font-medium">Trend</th>
					{/if}
					<th class="px-2 py-1.5"></th>
				</tr>
			</thead>
			<tbody class="divide-y">
				{#each top as c (c.key)}
					{@const url = podHeadlampUrl(c)}
					{@const series = trends?.[c.key] ?? []}
					{@const interactive = Boolean(onSelect)}
					<tr
						class="transition-colors {interactive
							? 'cursor-pointer hover:bg-muted/40 focus-within:bg-muted/30'
							: 'hover:bg-muted/30'}"
					>
						<td class="px-2 py-1.5">
							{#if interactive}
								<button
									type="button"
									class="block w-full text-left"
									onclick={() => onSelect?.(c)}
									aria-label={`Open ${c.name} detail`}
								>
									<div class="flex min-w-0 items-center gap-1.5">
										<span class="truncate font-mono" title={c.name}>{c.name}</span>
										<Badge
											variant={c.kind === 'critical' ? 'secondary' : 'outline'}
											class="shrink-0 text-[9px]"
										>
											{c.kind}
										</Badge>
										{#if c.queue}
											<Badge variant="outline" class="hidden shrink-0 text-[9px] sm:inline-flex">
												{c.queue}
											</Badge>
										{/if}
									</div>
									<div class="mt-0.5 truncate text-[10px] text-muted-foreground">
										{c.namespace} · {c.podCount} pod{c.podCount === 1 ? '' : 's'}
									</div>
								</button>
								<div class="mt-1">
									<CapacityOwnerLinks owners={c.owners} max={2} compact />
								</div>
							{:else}
								<div class="flex min-w-0 items-center gap-1.5">
									<span class="truncate font-mono" title={c.name}>{c.name}</span>
									<Badge
										variant={c.kind === 'critical' ? 'secondary' : 'outline'}
										class="shrink-0 text-[9px]"
									>
										{c.kind}
									</Badge>
									{#if c.queue}
										<Badge variant="outline" class="hidden shrink-0 text-[9px] sm:inline-flex">
											{c.queue}
										</Badge>
									{/if}
								</div>
								<div class="mt-0.5 truncate text-[10px] text-muted-foreground">
									{c.namespace} · {c.podCount} pod{c.podCount === 1 ? '' : 's'}
								</div>
								<div class="mt-1">
									<CapacityOwnerLinks owners={c.owners} max={2} compact />
								</div>
							{/if}
						</td>
						{#each RESOURCES as r (r)}
							{@const value = c.resources?.[r] ?? 0}
							<td class="px-1.5 py-1.5">
								<div
									class="rounded px-1.5 py-1 text-right font-mono tabular-nums {cellTone(value, allocatable[r])}"
								>
									{formatQuantityForResource(r, value)}
								</div>
							</td>
						{/each}
						{#if trends}
							<td class="px-2 py-1.5">
								{#if series.length >= 2}
									<svg
										viewBox="0 0 {SPARK_W} {SPARK_H}"
										width={SPARK_W}
										height={SPARK_H}
										class="mx-auto text-primary/80"
										aria-hidden="true"
									>
										<path
											d={sparkPath(series)}
											stroke="currentColor"
											stroke-width="1.25"
											fill="none"
											vector-effect="non-scaling-stroke"
										/>
									</svg>
								{:else}
									<span class="block text-center text-[10px] text-muted-foreground/50">—</span>
								{/if}
							</td>
						{/if}
						<td class="px-2 py-1.5 text-right">
							{#if url}
								<a
									href={url}
									class="text-muted-foreground/70 hover:text-foreground"
									title={`Open ${c.name} in Headlamp`}
									onclick={(e) => e.stopPropagation()}
								>
									<ExternalLink class="size-3" />
								</a>
							{/if}
						</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</div>
{/if}
