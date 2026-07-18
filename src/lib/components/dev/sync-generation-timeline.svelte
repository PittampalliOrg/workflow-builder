<!--
	Compact vertical timeline of live-sync generations for one dev execution,
	derived from the code-version artifacts the checkpoints panel already loads
	(payload.generation / captureProtocol "atomic-generation-v2"). Each entry
	shows the services touched plus capture → promote → acceptance markers; a
	layerchart sparkline summarizes sync cadence across the run.
-->
<script lang="ts">
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import * as Chart from '$lib/components/ui/chart';
	import { AreaChart } from 'layerchart';
	import { ExternalLink, GitCommitVertical, GitPullRequest, Save, ShieldCheck, ShieldX } from '@lucide/svelte';
	import { relativeTime } from '$lib/components/dev/preview-lifecycle';
	import {
		buildSyncCadenceSeries,
		buildSyncGenerationTimeline,
		describeSyncCadence,
		type SyncCadencePoint,
		type SyncTimelineVersionInput
	} from './sync-generation-timeline';

	let {
		versions = [],
		loading = false
	}: {
		/** The execution's code-version artifacts (versions-endpoint records). */
		versions?: SyncTimelineVersionInput[];
		/** True while the first versions load is still in flight. */
		loading?: boolean;
	} = $props();

	const COLLAPSED_LIMIT = 8;
	const SERVICE_BADGE_LIMIT = 4;

	let expanded = $state(false);

	const entries = $derived(buildSyncGenerationTimeline(versions));
	const cadence = $derived<SyncCadencePoint[]>(buildSyncCadenceSeries(entries));
	const cadenceLabel = $derived(describeSyncCadence(entries));
	const visibleEntries = $derived(expanded ? entries : entries.slice(0, COLLAPSED_LIMIT));
	const hiddenCount = $derived(entries.length - visibleEntries.length);

	const chartConfig: Chart.ChartConfig = {
		count: { label: 'captures', color: 'var(--chart-1)' }
	};

	function dotClass(entry: (typeof entries)[number]): string {
		if (entry.accepted === true) return 'bg-emerald-500';
		if (entry.accepted === false) return 'bg-destructive';
		if (entry.promoted) return 'bg-primary';
		return 'bg-muted-foreground/50';
	}
</script>

<section class="space-y-2" aria-labelledby="sync-generations-heading">
	<div class="flex flex-wrap items-center justify-between gap-2">
		<div class="flex items-center gap-2">
			<GitCommitVertical class="size-4 text-muted-foreground" aria-hidden="true" />
			<h3 id="sync-generations-heading" class="text-sm font-medium">Sync generations</h3>
			{#if entries.length > 0}
				<Badge variant="secondary" class="h-4 px-1 text-[10px]">{entries.length}</Badge>
			{/if}
		</div>
		{#if cadenceLabel}
			<span class="text-[11px] text-muted-foreground">{cadenceLabel}</span>
		{/if}
	</div>

	{#if cadence.length > 0}
		<!-- Sync-cadence sparkline: capture count per time bucket across the run.
		     Decorative — the cadence summary above carries the text equivalent. -->
		<div style:height="40px" aria-hidden="true">
			<Chart.Container config={chartConfig} class="h-full w-full">
				<AreaChart
					data={cadence}
					x="ts"
					series={[
						{
							key: 'count',
							value: (d: SyncCadencePoint) => d.count,
							color: 'var(--chart-1)'
						}
					]}
					axis={false}
					grid={false}
					legend={false}
				/>
			</Chart.Container>
		</div>
	{/if}

	{#if loading && entries.length === 0}
		<div class="space-y-2" role="status" aria-label="Loading sync generations">
			{#each Array(3) as _, i (i)}
				<div class="h-9 rounded-md border bg-muted/30 motion-safe:animate-pulse"></div>
			{/each}
		</div>
	{:else if entries.length === 0}
		<div class="rounded-md border border-dashed px-3 py-4 text-center">
			<p class="text-xs text-muted-foreground">No sync generations yet.</p>
			<p class="mt-1 text-[11px] text-muted-foreground/80">
				Each atomic checkpoint capture records one coherent live-sync generation; captures appear
				here as the agent edits and syncs code.
			</p>
		</div>
	{:else}
		<ol class="relative ml-1.5 space-y-1 border-l border-border/70 pl-4">
			{#each visibleEntries as entry (entry.artifactId)}
				<li class="group relative rounded-md px-2 py-1.5 text-xs transition-colors hover:bg-muted/40">
					<span
						class="absolute top-2.5 -left-[21.5px] size-2.5 rounded-full border-2 border-background {dotClass(entry)}"
						aria-hidden="true"
					></span>
					<div class="flex flex-wrap items-center gap-x-2 gap-y-1">
						<code class="font-mono text-[11px]" title={entry.generation}>{entry.shortGeneration}</code>
						{#if entry.strict}
							<Badge variant="outline" class="h-4 px-1 text-[10px]">atomic</Badge>
						{/if}
						{#if entry.iteration != null}
							<Badge variant="secondary" class="h-4 px-1 text-[10px]">iter {entry.iteration}</Badge>
						{/if}
						<span class="ml-auto text-[11px] text-muted-foreground">
							{relativeTime(entry.createdAt) ?? new Date(entry.createdAt).toLocaleString()}
						</span>
					</div>
					{#if entry.services.length > 0}
						<div class="mt-1 flex flex-wrap items-center gap-1">
							{#each entry.services.slice(0, SERVICE_BADGE_LIMIT) as service (service)}
								<Badge variant="outline" class="h-4 px-1 font-mono text-[10px]">{service}</Badge>
							{/each}
							{#if entry.services.length > SERVICE_BADGE_LIMIT}
								<span
									class="text-[10px] text-muted-foreground"
									title={entry.services.slice(SERVICE_BADGE_LIMIT).join(', ')}
								>
									+{entry.services.length - SERVICE_BADGE_LIMIT} more
								</span>
							{/if}
						</div>
					{:else if entry.serviceCount > 0}
						<p class="mt-1 text-[11px] text-muted-foreground">{entry.serviceCount} services</p>
					{/if}
					<div class="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
						<span class="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
							<Save class="size-3" aria-hidden="true" /> captured
						</span>
						{#if entry.promoted && entry.prUrl}
							<a
								href={entry.prUrl}
								target="_blank"
								rel="noopener noreferrer"
								class="inline-flex items-center gap-1 text-[11px] font-medium text-emerald-600 hover:underline dark:text-emerald-400"
							>
								<GitPullRequest class="size-3" aria-hidden="true" /> promoted
								<ExternalLink class="size-2.5" aria-hidden="true" />
							</a>
						{/if}
						{#if entry.accepted === true}
							<span
								class="inline-flex items-center gap-1 text-[11px] text-emerald-600 dark:text-emerald-400"
							>
								<ShieldCheck class="size-3" aria-hidden="true" /> accepted
							</span>
						{:else if entry.accepted === false}
							<span class="inline-flex items-center gap-1 text-[11px] text-destructive">
								<ShieldX class="size-3" aria-hidden="true" /> acceptance failed
							</span>
						{/if}
					</div>
				</li>
			{/each}
		</ol>
		{#if hiddenCount > 0 || expanded}
			<Button
				variant="ghost"
				size="sm"
				class="h-7 w-full text-[11px] text-muted-foreground"
				onclick={() => (expanded = !expanded)}
			>
				{expanded ? 'Show fewer' : `Show all ${entries.length} generations`}
			</Button>
		{/if}
	{/if}
</section>
