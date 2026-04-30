<script lang="ts">
	import { goto } from '$app/navigation';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import ResourceListShell from '$lib/components/console/resource-list-shell.svelte';
	import ResourceTable from '$lib/components/console/resource-table.svelte';
	import { FlaskConical } from '@lucide/svelte';

	type RunStatus = 'queued' | 'running' | 'grading' | 'completed' | 'failed' | 'cancelled';

	type RunSummary = {
		id: string;
		status: RunStatus;
		summary: Record<string, number | string | null | Record<string, unknown>>;
		createdAt: string;
	};

	type Evaluation = {
		id: string;
		name: string;
		description: string | null;
		datasetId: string | null;
		datasetName: string | null;
		taskConfig: Record<string, unknown>;
		latestRun: RunSummary | null;
		createdAt: string;
	};

	interface Props {
		slug: string;
	}

	let { slug }: Props = $props();

	let evaluations = $state<Evaluation[]>([]);
	let loading = $state(true);
	let errorMessage = $state<string | null>(null);
	let search = $state('');

	const filtered = $derived(
		search.trim()
			? evaluations.filter((e) => e.name.toLowerCase().includes(search.trim().toLowerCase()))
			: evaluations
	);

	async function load() {
		loading = true;
		errorMessage = null;
		try {
			const res = await fetch('/api/evaluations/evals');
			if (!res.ok) {
				errorMessage = `Failed to load evaluations (${res.status})`;
				return;
			}
			const data = (await res.json()) as { evaluations: Evaluation[] };
			evaluations = data.evaluations ?? [];
		} catch (err) {
			errorMessage = err instanceof Error ? err.message : 'Failed to load evaluations';
		} finally {
			loading = false;
		}
	}

	function onCreate() {
		goto(`/workspaces/${slug}/evaluations/evals/create`);
	}

	function formatDate(value: string) {
		return new Date(value).toLocaleString();
	}

	function statusVariant(status?: RunStatus): 'default' | 'secondary' | 'destructive' | 'outline' {
		if (!status) return 'outline';
		if (status === 'completed') return 'default';
		if (status === 'failed' || status === 'cancelled') return 'destructive';
		return 'secondary';
	}

	function passRate(run: RunSummary | null): string {
		if (!run) return '—';
		const passed = Number(run.summary?.passed ?? 0);
		const total = Number(run.summary?.total ?? 0);
		if (!total) return '—';
		return `${Math.round((passed / total) * 100)}%`;
	}

	$effect(() => {
		load();
	});
</script>

<ResourceListShell
	title="Evals"
	subtitle="Assess your model and agent responses."
	itemLabel="evaluation"
	itemCount={filtered.length}
	searchPlaceholder="Search evals…"
	onSearch={(v) => (search = v)}
	primaryLabel="Create"
	onPrimary={onCreate}
	{loading}
	{errorMessage}
	isEmpty={!loading && evaluations.length === 0}
>
	{#snippet empty()}
		<div class="flex flex-col items-center justify-center text-center py-20 gap-4">
			<div class="size-12 rounded-full bg-muted flex items-center justify-center">
				<FlaskConical class="size-6 text-muted-foreground" />
			</div>
			<div>
				<p class="text-sm font-medium">Your evaluations will appear here</p>
				<p class="text-xs text-muted-foreground mt-1">
					Create an evaluation to assess your model's responses.
				</p>
			</div>
			<Button onclick={onCreate}>Create</Button>
		</div>
	{/snippet}

	{#snippet content()}
		<ResourceTable
			rows={filtered}
			{loading}
			onRowClick={(e) => goto(`/workspaces/${slug}/evaluations/evals/${e.id}`)}
		>
			{#snippet header()}
				<th class="px-4 py-2 font-medium">Name</th>
				<th class="px-4 py-2 font-medium">Dataset</th>
				<th class="px-4 py-2 font-medium">Latest run</th>
				<th class="px-4 py-2 font-medium text-right">Pass rate</th>
				<th class="px-4 py-2 font-medium">Updated</th>
			{/snippet}
			{#snippet row(e)}
				<td class="px-4 py-3 align-middle">
					<div class="font-medium">{e.name}</div>
					{#if e.description}
						<div class="text-xs text-muted-foreground truncate max-w-md">{e.description}</div>
					{/if}
				</td>
				<td class="px-4 py-3 align-middle text-xs text-muted-foreground">
					{e.datasetName ?? '—'}
				</td>
				<td class="px-4 py-3 align-middle">
					{#if e.latestRun}
						<Badge variant={statusVariant(e.latestRun.status)} class="font-normal capitalize">
							{e.latestRun.status}
						</Badge>
					{:else}
						<span class="text-xs text-muted-foreground">No runs</span>
					{/if}
				</td>
				<td class="px-4 py-3 align-middle text-right tabular-nums text-sm">
					{passRate(e.latestRun)}
				</td>
				<td class="px-4 py-3 align-middle text-xs text-muted-foreground">
					{formatDate(e.createdAt)}
				</td>
			{/snippet}
		</ResourceTable>
	{/snippet}
</ResourceListShell>
