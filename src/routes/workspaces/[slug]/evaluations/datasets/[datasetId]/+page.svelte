<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { Alert, AlertDescription } from '$lib/components/ui/alert';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { Skeleton } from '$lib/components/ui/skeleton';
	import {
		Sheet,
		SheetContent,
		SheetDescription,
		SheetHeader,
		SheetTitle
	} from '$lib/components/ui/sheet';
	import AppBreadcrumb from '$lib/components/console/app-breadcrumb.svelte';
	import ResourceTable from '$lib/components/console/resource-table.svelte';
	import { ArrowLeft, Database } from 'lucide-svelte';

	type DatasetRow = {
		id: string;
		externalId: string | null;
		input: Record<string, unknown>;
		expectedOutput: unknown;
		generatedOutput: unknown;
		annotations: Record<string, unknown>;
		rating: number | null;
		feedback: string | null;
		createdAt: string;
		updatedAt: string;
	};

	type DatasetDetail = {
		id: string;
		name: string;
		description: string | null;
		sourceType: string;
		schema: Record<string, unknown>;
		metadata: Record<string, unknown>;
		rowCount: number;
		createdAt: string;
		updatedAt: string;
		rows: DatasetRow[];
	};

	const slug = $derived((page.params.slug as string) ?? 'default');
	const datasetId = $derived(page.params.datasetId as string);

	let dataset = $state<DatasetDetail | null>(null);
	let loading = $state(true);
	let errorMessage = $state<string | null>(null);
	let selectedRowId = $state<string | null>(null);

	const selectedRow = $derived(dataset?.rows.find((r) => r.id === selectedRowId) ?? null);

	async function load() {
		loading = true;
		errorMessage = null;
		try {
			const res = await fetch(`/api/evaluations/datasets/${datasetId}`);
			if (!res.ok) {
				errorMessage = `Failed to load dataset (${res.status})`;
				return;
			}
			const data = (await res.json()) as { dataset: DatasetDetail };
			dataset = data.dataset;
		} catch (err) {
			errorMessage = err instanceof Error ? err.message : 'Failed to load dataset';
		} finally {
			loading = false;
		}
	}

	function shortJson(value: unknown, max = 60): string {
		if (value === undefined || value === null) return '—';
		try {
			const s = typeof value === 'string' ? value : JSON.stringify(value);
			return s.length > max ? `${s.slice(0, max)}…` : s;
		} catch {
			return String(value);
		}
	}

	function formatDate(value: string) {
		return new Date(value).toLocaleString();
	}

	$effect(() => {
		if (datasetId) load();
	});
</script>

<svelte:head>
	<title>{dataset?.name ?? 'Dataset'}</title>
</svelte:head>

<div class="flex flex-col h-full">
	<header class="border-b px-6 py-4">
		<AppBreadcrumb
			items={[
				{ label: 'Evaluations', href: `/workspaces/${slug}/evaluations` },
				{ label: 'Datasets', href: `/workspaces/${slug}/evaluations?tab=datasets` },
				{ label: dataset?.name ?? datasetId.slice(0, 8), truncate: true }
			]}
		/>
		<div class="mt-3 flex items-baseline justify-between gap-4 flex-wrap">
			<div class="min-w-0">
				<h1 class="text-xl font-semibold tracking-tight truncate">{dataset?.name ?? '—'}</h1>
				{#if dataset?.description}
					<p class="text-sm text-muted-foreground mt-1">{dataset.description}</p>
				{/if}
			</div>
			<div class="flex items-center gap-2">
				<Button
					variant="outline"
					size="sm"
					onclick={() => goto(`/workspaces/${slug}/evaluations?tab=datasets`)}
				>
					<ArrowLeft class="size-3.5 mr-1" /> All datasets
				</Button>
			</div>
		</div>
	</header>

	<div class="flex-1 min-h-0 overflow-y-auto">
		<div class="max-w-7xl mx-auto w-full p-6 flex flex-col gap-6">
			{#if errorMessage}
				<Alert variant="destructive">
					<AlertDescription>{errorMessage}</AlertDescription>
				</Alert>
			{/if}

			{#if loading}
				<Skeleton class="h-32" />
				<Skeleton class="h-64" />
			{:else if dataset}
				<!-- Summary cards -->
				<div class="grid grid-cols-1 md:grid-cols-3 gap-4">
					<div class="border rounded-md p-4 bg-card">
						<div class="flex items-center gap-2 text-xs uppercase tracking-wide text-muted-foreground">
							<Database class="size-3.5" /> Source
						</div>
						<div class="mt-2">
							<Badge variant="secondary" class="font-normal">{dataset.sourceType}</Badge>
						</div>
					</div>
					<div class="border rounded-md p-4 bg-card">
						<div class="text-xs uppercase tracking-wide text-muted-foreground">Rows</div>
						<p class="mt-2 text-2xl font-semibold tabular-nums">{dataset.rowCount}</p>
					</div>
					<div class="border rounded-md p-4 bg-card">
						<div class="text-xs uppercase tracking-wide text-muted-foreground">Updated</div>
						<p class="mt-2 text-sm">{formatDate(dataset.updatedAt)}</p>
					</div>
				</div>

				<!-- Rows table -->
				<section class="flex flex-col gap-3">
					<div class="flex items-baseline justify-between">
						<h2 class="text-sm font-semibold">Rows</h2>
						<span class="text-xs text-muted-foreground">{dataset.rows.length} loaded</span>
					</div>
					<ResourceTable
						rows={dataset.rows}
						loading={false}
						onRowClick={(r) => (selectedRowId = r.id)}
					>
						{#snippet header()}
							<th class="px-4 py-2 font-medium w-8">#</th>
							<th class="px-4 py-2 font-medium">External ID</th>
							<th class="px-4 py-2 font-medium">Input</th>
							<th class="px-4 py-2 font-medium">Expected</th>
							<th class="px-4 py-2 font-medium">Generated</th>
						{/snippet}
						{#snippet row(r)}
							<td class="px-4 py-3 align-middle text-xs text-muted-foreground tabular-nums">
								{dataset?.rows.indexOf(r) ?? 0}
							</td>
							<td class="px-4 py-3 align-middle text-xs font-mono text-muted-foreground">
								{r.externalId ?? '—'}
							</td>
							<td class="px-4 py-3 align-middle text-xs font-mono">
								{shortJson(r.input)}
							</td>
							<td class="px-4 py-3 align-middle text-xs font-mono">
								{shortJson(r.expectedOutput)}
							</td>
							<td class="px-4 py-3 align-middle text-xs font-mono">
								{shortJson(r.generatedOutput)}
							</td>
						{/snippet}
						{#snippet empty()}
							<div class="text-sm text-muted-foreground py-8">No rows yet.</div>
						{/snippet}
					</ResourceTable>
				</section>
			{/if}
		</div>
	</div>
</div>

<Sheet open={selectedRowId !== null} onOpenChange={(o) => !o && (selectedRowId = null)}>
	<SheetContent side="right" class="w-[640px] sm:max-w-[640px]">
		{#if selectedRow}
			<SheetHeader>
				<SheetTitle class="text-sm font-mono">{selectedRow.id}</SheetTitle>
				<SheetDescription>
					Row {dataset?.rows.indexOf(selectedRow) ?? 0} · Updated
					{formatDate(selectedRow.updatedAt)}
				</SheetDescription>
			</SheetHeader>
			<div class="mt-6 flex flex-col gap-4 text-xs">
				<section>
					<div class="font-medium mb-1">Input</div>
					<pre class="bg-muted p-3 rounded-md overflow-auto text-xs">{JSON.stringify(
							selectedRow.input,
							null,
							2
						)}</pre>
				</section>
				<section>
					<div class="font-medium mb-1">Expected output</div>
					<pre class="bg-muted p-3 rounded-md overflow-auto text-xs">{JSON.stringify(
							selectedRow.expectedOutput,
							null,
							2
						)}</pre>
				</section>
				{#if selectedRow.generatedOutput !== undefined && selectedRow.generatedOutput !== null}
					<section>
						<div class="font-medium mb-1">Generated output</div>
						<pre class="bg-muted p-3 rounded-md overflow-auto text-xs">{JSON.stringify(
								selectedRow.generatedOutput,
								null,
								2
							)}</pre>
					</section>
				{/if}
			</div>
		{/if}
	</SheetContent>
</Sheet>
