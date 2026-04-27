<script lang="ts">
	import { goto } from '$app/navigation';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import ResourceListShell from '$lib/components/console/resource-list-shell.svelte';
	import ResourceTable from '$lib/components/console/resource-table.svelte';
	import { Database } from 'lucide-svelte';

	type Dataset = {
		id: string;
		name: string;
		description: string | null;
		sourceType: string;
		rowCount: number;
		createdAt: string;
		updatedAt: string;
	};

	interface Props {
		slug: string;
	}

	let { slug }: Props = $props();

	let datasets = $state<Dataset[]>([]);
	let loading = $state(true);
	let errorMessage = $state<string | null>(null);
	let search = $state('');

	const filtered = $derived(
		search.trim()
			? datasets.filter((d) => d.name.toLowerCase().includes(search.trim().toLowerCase()))
			: datasets
	);

	async function load() {
		loading = true;
		errorMessage = null;
		try {
			const res = await fetch('/api/evaluations/datasets');
			if (!res.ok) {
				errorMessage = `Failed to load datasets (${res.status})`;
				return;
			}
			const data = (await res.json()) as { datasets: Dataset[] };
			datasets = data.datasets ?? [];
		} catch (err) {
			errorMessage = err instanceof Error ? err.message : 'Failed to load datasets';
		} finally {
			loading = false;
		}
	}

	function onCreate() {
		// TODO(step-2): point to dedicated dataset create page; for now use legacy editor
		goto(`/workspaces/${slug}/evaluations/evals-legacy`);
	}

	function formatDate(value: string) {
		return new Date(value).toLocaleString();
	}

	$effect(() => {
		load();
	});
</script>

<ResourceListShell
	title="Datasets"
	subtitle="Label, annotate, and evaluate test data."
	itemLabel="dataset"
	itemCount={filtered.length}
	searchPlaceholder="Search datasets…"
	onSearch={(v) => (search = v)}
	primaryLabel="Create"
	onPrimary={onCreate}
	{loading}
	{errorMessage}
	isEmpty={!loading && datasets.length === 0}
>
	{#snippet empty()}
		<div class="flex flex-col items-center justify-center text-center py-20 gap-4">
			<div class="size-12 rounded-full bg-muted flex items-center justify-center">
				<Database class="size-6 text-muted-foreground" />
			</div>
			<div>
				<p class="text-sm font-medium">Your datasets will appear here</p>
				<p class="text-xs text-muted-foreground mt-1">
					Create a dataset to label, annotate, and evaluate your data.
				</p>
			</div>
			<Button onclick={onCreate}>Create</Button>
		</div>
	{/snippet}

	{#snippet content()}
		<ResourceTable
			rows={filtered}
			{loading}
			onRowClick={(d) => goto(`/workspaces/${slug}/evaluations/datasets/${d.id}`)}
		>
			{#snippet header()}
				<th class="px-4 py-2 font-medium">Name</th>
				<th class="px-4 py-2 font-medium">Source</th>
				<th class="px-4 py-2 font-medium text-right">Rows</th>
				<th class="px-4 py-2 font-medium">Updated</th>
			{/snippet}
			{#snippet row(d)}
				<td class="px-4 py-3 align-middle">
					<div class="font-medium">{d.name}</div>
					{#if d.description}
						<div class="text-xs text-muted-foreground truncate max-w-md">{d.description}</div>
					{/if}
				</td>
				<td class="px-4 py-3 align-middle">
					<Badge variant="secondary" class="font-normal">{d.sourceType}</Badge>
				</td>
				<td class="px-4 py-3 align-middle text-right tabular-nums">{d.rowCount}</td>
				<td class="px-4 py-3 align-middle text-xs text-muted-foreground">
					{formatDate(d.updatedAt)}
				</td>
			{/snippet}
		</ResourceTable>
	{/snippet}
</ResourceListShell>
