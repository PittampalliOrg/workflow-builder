<script lang="ts">
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import {
		Card,
		CardContent,
		CardHeader,
		CardTitle
	} from '$lib/components/ui/card';
	import { Skeleton } from '$lib/components/ui/skeleton';
	import { Alert, AlertDescription } from '$lib/components/ui/alert';
	import { createWorkloadStream } from '$lib/stores/kueueviz/workloads.svelte';
	import StatusPill from '$lib/components/capacity/stream-status-pill.svelte';
	import WorkloadTable from '$lib/components/capacity/workload-table.svelte';
	import WorkloadDetailSheet from '$lib/components/capacity/workload-detail-sheet.svelte';
	import type { WorkloadSnapshot } from '$lib/server/kueueviz';

	const stream = createWorkloadStream();
	const slug = $derived(page.params.slug as string);

	// Honor `?queue=<name>` deep-link from Overview cards by pre-filtering.
	const queueParam = $derived(page.url.searchParams.get('queue'));
	const filteredByQueue = $derived(
		queueParam
			? stream.data.filter(
					(wl) => wl.clusterQueueName === queueParam || wl.queueName === queueParam
				)
			: stream.data
	);

	let detailOpen = $state(false);
	let detailNs = $state<string | null>(null);
	let detailName = $state<string | null>(null);

	function selectWorkload(wl: WorkloadSnapshot): void {
		detailNs = wl.namespace;
		detailName = wl.name;
		detailOpen = true;
	}
</script>

<div class="space-y-4">
	<div class="flex flex-wrap items-center justify-between gap-2">
		<StatusPill
			status={stream.status}
			lastUpdate={stream.lastUpdate}
			error={stream.error}
		/>
		{#if queueParam}
			<div class="flex items-center gap-2 text-xs">
				<span class="text-muted-foreground">Filtering by queue:</span>
				<code class="font-mono">{queueParam}</code>
				<button
					type="button"
					class="text-primary hover:underline"
					onclick={() => goto(`/workspaces/${slug}/capacity/workloads`)}
				>
					Clear
				</button>
			</div>
		{/if}
	</div>

	{#if stream.error && stream.status !== 'open'}
		<Alert variant="destructive">
			<AlertDescription class="text-xs">
				Workload stream {stream.status === 'degraded' ? 'is reconnecting' : 'is unavailable'}.
				{#if stream.error}
					<span class="font-mono">{stream.error}</span>
				{/if}
			</AlertDescription>
		</Alert>
	{/if}

	<Card>
		<CardHeader class="pb-2">
			<CardTitle class="text-base">Workloads</CardTitle>
		</CardHeader>
		<CardContent>
			{#if stream.status !== 'open' && stream.data.length === 0}
				<div class="space-y-2">
					{#each [0, 1, 2, 3] as i (i)}
						<Skeleton class="h-8 w-full" />
					{/each}
				</div>
			{:else}
				<WorkloadTable
					workloads={filteredByQueue}
					onSelect={selectWorkload}
					emptyMessage={queueParam
						? `No workloads on the ${queueParam} queue.`
						: 'No workloads admitted into Kueue.'}
				/>
			{/if}
		</CardContent>
	</Card>

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
