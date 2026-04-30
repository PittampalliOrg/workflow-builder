<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import { Plus, Check, Loader2 } from '@lucide/svelte';
	import * as Popover from '$lib/components/ui/popover';

	type Props = {
		runId: string;
		instanceId: string;
	};

	const { runId, instanceId }: Props = $props();

	type Dataset = { id: string; name: string };

	let open = $state(false);
	let datasets = $state<Dataset[] | null>(null);
	let loading = $state(false);
	let busyDatasetId = $state<string | null>(null);
	let succeeded = $state<string | null>(null);
	let errorMessage = $state<string | null>(null);

	async function loadDatasets() {
		if (datasets || loading) return;
		loading = true;
		errorMessage = null;
		try {
			const res = await fetch('/api/evaluations/datasets');
			if (!res.ok) throw new Error(`Failed to load datasets (${res.status})`);
			const body = (await res.json()) as { datasets: Dataset[] };
			datasets = body.datasets ?? [];
		} catch (err) {
			errorMessage = err instanceof Error ? err.message : String(err);
		} finally {
			loading = false;
		}
	}

	async function promote(datasetId: string) {
		busyDatasetId = datasetId;
		errorMessage = null;
		try {
			const res = await fetch(
				`/api/evaluations/datasets/${encodeURIComponent(datasetId)}/rows-from-benchmark`,
				{
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ runId, instanceId })
				}
			);
			if (!res.ok) {
				const text = await res.text().catch(() => '');
				throw new Error(`Promote failed (${res.status}): ${text.slice(0, 200)}`);
			}
			succeeded = datasetId;
			setTimeout(() => {
				if (succeeded === datasetId) {
					succeeded = null;
					open = false;
				}
			}, 1500);
		} catch (err) {
			errorMessage = err instanceof Error ? err.message : String(err);
		} finally {
			busyDatasetId = null;
		}
	}

	$effect(() => {
		if (open) void loadDatasets();
	});
</script>

<Popover.Root bind:open>
	<Popover.Trigger>
		{#snippet child({ props })}
			<Button
				{...props}
				variant="outline"
				size="sm"
				class="h-7 gap-1.5 text-[11px]"
				title="Capture this instance as a regression test in an evaluation dataset"
			>
				<Plus class="h-3 w-3" />
				Add to dataset
			</Button>
		{/snippet}
	</Popover.Trigger>
	<Popover.Content class="w-72 p-2" align="end">
		<div class="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-1">
			Promote to dataset
		</div>
		{#if loading}
			<div class="flex items-center gap-1.5 px-2 py-3 text-xs text-muted-foreground">
				<Loader2 class="h-3 w-3 animate-spin" /> Loading datasets…
			</div>
		{:else if errorMessage}
			<div class="px-2 py-1.5 text-[11px] text-red-600 dark:text-red-400">{errorMessage}</div>
		{:else if !datasets || datasets.length === 0}
			<div class="px-2 py-3 text-xs text-muted-foreground">
				No datasets yet. Create one in the Evaluations tab first.
			</div>
		{:else}
			<ul class="max-h-64 space-y-0.5 overflow-y-auto">
				{#each datasets as dataset (dataset.id)}
					<li>
						<button
							type="button"
							class="flex w-full items-center justify-between gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-accent"
							onclick={() => promote(dataset.id)}
							disabled={busyDatasetId !== null}
						>
							<span class="truncate">{dataset.name}</span>
							{#if succeeded === dataset.id}
								<Check class="h-3 w-3 text-emerald-600" />
							{:else if busyDatasetId === dataset.id}
								<Loader2 class="h-3 w-3 animate-spin text-muted-foreground" />
							{/if}
						</button>
					</li>
				{/each}
			</ul>
		{/if}
	</Popover.Content>
</Popover.Root>
