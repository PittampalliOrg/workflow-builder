<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { Alert, AlertDescription } from '$lib/components/ui/alert';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { Skeleton } from '$lib/components/ui/skeleton';
	import { Tabs, TabsList, TabsTrigger } from '$lib/components/ui/tabs';
	import AppBreadcrumb from '$lib/components/console/app-breadcrumb.svelte';
	import ResourceTable from '$lib/components/console/resource-table.svelte';
	import RunItemsTable from '$lib/components/evaluations/run-items-table.svelte';
	import RunInspectDrawer from '$lib/components/evaluations/run-inspect-drawer.svelte';
	import type { RunDetail, RunItem } from '$lib/components/evaluations/types';
	import { ArrowLeft, ChevronRight, Database, FlaskConical, Play } from '@lucide/svelte';

	type GraderType =
		| 'string_check'
		| 'text_similarity'
		| 'score_model'
		| 'python'
		| 'multi'
		| 'external_harness';

	type Grader = {
		id: string;
		name: string;
		type: GraderType;
		config: Record<string, unknown>;
		weight: number;
		passThreshold: number;
		orderIndex: number;
		enabled: boolean;
	};

	type RunStatus = 'queued' | 'running' | 'grading' | 'completed' | 'failed' | 'cancelled';

	type RunSummary = {
		id: string;
		evaluationId: string;
		evaluationName: string | null;
		datasetName: string | null;
		status: RunStatus;
		subjectType: string;
		subjectId: string | null;
		summary: Record<string, number | string | null | Record<string, unknown>>;
		error: string | null;
		createdAt: string;
		updatedAt: string;
	};

	type EvaluationDetail = {
		id: string;
		name: string;
		description: string | null;
		datasetId: string | null;
		datasetName: string | null;
		taskConfig: Record<string, unknown>;
		latestRun: RunSummary | null;
		createdAt: string;
		graders: Grader[];
		runs: RunSummary[];
	};

	type Tab = 'report' | 'data';

	const slug = $derived((page.params.slug as string) ?? 'default');
	const evalId = $derived(page.params.evalId as string);
	const activeTab: Tab = $derived(
		(page.url.searchParams.get('tab') as Tab) === 'data' ? 'data' : 'report'
	);

	let evaluation = $state<EvaluationDetail | null>(null);
	let loading = $state(true);
	let errorMessage = $state<string | null>(null);

	// Data-tab state: which run is being inspected, that run's full detail, item drawer.
	let selectedRunId = $state<string | null>(null);
	let selectedRun = $state<RunDetail | null>(null);
	let dataLoading = $state(false);
	let dataError = $state<string | null>(null);
	let selectedItemId = $state<string | null>(null);
	let selectedItemDetail = $state<RunItem | null>(null);
	let selectedItemLoading = $state(false);
	let selectedItemRequest = 0;

	async function load() {
		loading = true;
		errorMessage = null;
		try {
			const res = await fetch(`/api/evaluations/evals/${evalId}`);
			if (!res.ok) {
				errorMessage = `Failed to load evaluation (${res.status})`;
				return;
			}
			const data = (await res.json()) as { evaluation: EvaluationDetail };
			evaluation = data.evaluation;
			if (!selectedRunId && evaluation?.runs?.length) {
				selectedRunId = evaluation.runs[0].id;
			}
		} catch (err) {
			errorMessage = err instanceof Error ? err.message : 'Failed to load evaluation';
		} finally {
			loading = false;
		}
	}

	async function loadRunDetail(runId: string) {
		dataLoading = true;
		dataError = null;
		selectedItemId = null;
		selectedItemDetail = null;
		try {
			const res = await fetch(`/api/evaluations/runs/${runId}?items=summary`);
			if (!res.ok) {
				dataError = `Failed to load run (${res.status})`;
				return;
			}
			const data = (await res.json()) as { run: RunDetail };
			selectedRun = data.run;
		} catch (err) {
			dataError = err instanceof Error ? err.message : 'Failed to load run';
		} finally {
			dataLoading = false;
		}
	}

	async function loadSelectedItemDetail(runId: string, itemId: string) {
		const requestId = ++selectedItemRequest;
		selectedItemLoading = true;
		try {
			const res = await fetch(`/api/evaluations/runs/${runId}/items/${itemId}`);
			if (!res.ok) return;
			const data = (await res.json()) as { item: RunItem };
			if (requestId === selectedItemRequest) selectedItemDetail = data.item;
		} catch {
			// The compact row stays visible in the drawer if the detail request fails.
		} finally {
			if (requestId === selectedItemRequest) selectedItemLoading = false;
		}
	}

	function selectTab(tab: Tab) {
		const url = new URL(page.url);
		if (tab === 'data') url.searchParams.set('tab', 'data');
		else url.searchParams.delete('tab');
		goto(url.pathname + url.search, { replaceState: true, keepFocus: true, noScroll: true });
	}

	function formatDate(value: string) {
		return new Date(value).toLocaleString();
	}

	function statusVariant(
		status: RunStatus
	): 'default' | 'secondary' | 'destructive' | 'outline' {
		if (status === 'completed') return 'default';
		if (status === 'failed' || status === 'cancelled') return 'destructive';
		return 'secondary';
	}

	function passRate(summary: RunSummary['summary']): string {
		const passed = Number(summary?.passed ?? 0);
		const total = Number(summary?.total ?? 0);
		if (!total) return '—';
		return `${Math.round((passed / total) * 100)}%`;
	}

	function graderTypeLabel(t: GraderType): string {
		switch (t) {
			case 'string_check':
				return 'String check';
			case 'text_similarity':
				return 'Text similarity';
			case 'score_model':
				return 'Model labeler';
			case 'python':
				return 'Python';
			case 'multi':
				return 'Composite';
			case 'external_harness':
				return 'External harness';
		}
	}

	$effect(() => {
		if (evalId) load();
	});

	// When the Data tab is active and the user picks a run (or first load
	// auto-selects the latest run), fetch its detail.
	$effect(() => {
		if (activeTab !== 'data') return;
		const id = selectedRunId;
		if (!id) return;
		loadRunDetail(id);
	});

	$effect(() => {
		const runId = selectedRunId;
		const itemId = selectedItemId;
		selectedItemDetail = null;
		if (!runId || !itemId) {
			selectedItemLoading = false;
			return;
		}
		loadSelectedItemDetail(runId, itemId);
	});
</script>

<svelte:head>
	<title>{evaluation?.name ?? 'Evaluation'}</title>
</svelte:head>

<div class="flex flex-col h-full">
	<header class="border-b px-6 py-4">
		<AppBreadcrumb
			items={[
				{ label: 'Evaluations', href: `/workspaces/${slug}/evaluations` },
				{ label: 'Evals', href: `/workspaces/${slug}/evaluations?tab=evals` },
				{ label: evaluation?.name ?? evalId.slice(0, 8), truncate: true }
			]}
		/>
		<div class="mt-3 flex items-baseline justify-between gap-4 flex-wrap">
			<div class="min-w-0">
				<h1 class="text-xl font-semibold tracking-tight truncate">
					{evaluation?.name ?? '—'}
				</h1>
				{#if evaluation?.description}
					<p class="text-sm text-muted-foreground mt-1">{evaluation.description}</p>
				{/if}
			</div>
			<div class="flex items-center gap-2">
				<Tabs value={activeTab} onValueChange={(v) => selectTab(v as Tab)}>
					<TabsList class="h-9">
						<TabsTrigger value="report" class="text-xs">Report</TabsTrigger>
						<TabsTrigger value="data" class="text-xs">Data</TabsTrigger>
					</TabsList>
				</Tabs>
				<Button
					variant="outline"
					size="sm"
					onclick={() => goto(`/workspaces/${slug}/evaluations?tab=evals`)}
				>
					<ArrowLeft class="size-3.5 mr-1" /> All evals
				</Button>
				<Button
					size="sm"
					disabled={!evaluation}
					onclick={() => goto(`/workspaces/${slug}/evaluations/evals-legacy`)}
				>
					<Play class="size-3.5 mr-1" /> Run
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
				<div class="grid grid-cols-1 lg:grid-cols-3 gap-6">
					<Skeleton class="h-32" />
					<Skeleton class="h-32" />
					<Skeleton class="h-32" />
				</div>
				<Skeleton class="h-64" />
			{:else if evaluation && activeTab === 'report'}
				<!-- Summary cards -->
				<div class="grid grid-cols-1 lg:grid-cols-3 gap-4">
					<div class="border rounded-md p-4 bg-card">
						<div class="flex items-center gap-2 text-xs uppercase tracking-wide text-muted-foreground">
							<Database class="size-3.5" /> Test data
						</div>
						{#if evaluation.datasetId}
							<a
								href={`/workspaces/${slug}/evaluations/datasets/${evaluation.datasetId}`}
								class="mt-2 block font-medium text-sm hover:underline"
							>
								{evaluation.datasetName ?? 'Untitled dataset'}
							</a>
						{:else}
							<p class="mt-2 text-sm text-muted-foreground">No dataset linked</p>
						{/if}
					</div>

					<div class="border rounded-md p-4 bg-card">
						<div class="flex items-center gap-2 text-xs uppercase tracking-wide text-muted-foreground">
							<FlaskConical class="size-3.5" /> Testing criteria
						</div>
						<div class="mt-2 flex flex-wrap gap-1">
							{#each evaluation.graders as g (g.id)}
								<Badge
									variant={g.enabled ? 'secondary' : 'outline'}
									class="font-normal text-xs"
									title={g.name}
								>
									{graderTypeLabel(g.type)}
								</Badge>
							{:else}
								<span class="text-xs text-muted-foreground">No criteria</span>
							{/each}
						</div>
					</div>

					<div class="border rounded-md p-4 bg-card">
						<div class="text-xs uppercase tracking-wide text-muted-foreground">Runs</div>
						<p class="mt-2 text-2xl font-semibold tabular-nums">{evaluation.runs.length}</p>
					</div>
				</div>

				<!-- Runs table -->
				<section class="flex flex-col gap-3">
					<div class="flex items-baseline justify-between">
						<h2 class="text-sm font-semibold">Runs</h2>
						<span class="text-xs text-muted-foreground">
							{evaluation.runs.length} total
						</span>
					</div>
					<ResourceTable
						rows={evaluation.runs}
						loading={false}
						onRowClick={(r) =>
							goto(`/workspaces/${slug}/evaluations/evals/${evalId}/runs/${r.id}`)}
					>
						{#snippet header()}
							<th class="px-4 py-2 font-medium">Status</th>
							<th class="px-4 py-2 font-medium">Subject</th>
							<th class="px-4 py-2 font-medium text-right">Pass rate</th>
							<th class="px-4 py-2 font-medium text-right">Total</th>
							<th class="px-4 py-2 font-medium">Created</th>
							<th class="px-4 py-2 font-medium w-8"></th>
						{/snippet}
						{#snippet row(r)}
							<td class="px-4 py-3 align-middle">
								<Badge variant={statusVariant(r.status)} class="font-normal capitalize">
									{r.status}
								</Badge>
								{#if r.error}
									<div class="text-xs text-destructive mt-1 truncate max-w-md" title={r.error}>
										{r.error}
									</div>
								{/if}
							</td>
							<td class="px-4 py-3 align-middle">
								<div class="text-xs">
									<span class="text-muted-foreground capitalize">{r.subjectType}</span>
									{#if r.subjectId}
										<span class="ml-1 font-mono">{r.subjectId.slice(0, 12)}…</span>
									{/if}
								</div>
							</td>
							<td class="px-4 py-3 align-middle text-right tabular-nums">
								{passRate(r.summary)}
							</td>
							<td class="px-4 py-3 align-middle text-right tabular-nums">
								{r.summary?.total ?? '—'}
							</td>
							<td class="px-4 py-3 align-middle text-xs text-muted-foreground">
								{formatDate(r.createdAt)}
							</td>
							<td class="px-4 py-3 align-middle text-muted-foreground">
								<ChevronRight class="size-4" />
							</td>
						{/snippet}
						{#snippet empty()}
							<div class="text-sm text-muted-foreground py-8">
								No runs yet. Click <strong>Run</strong> to start one.
							</div>
						{/snippet}
					</ResourceTable>
				</section>
			{:else if evaluation && activeTab === 'data'}
				<!-- Data tab: run selector + items table for the chosen run (mirrors OpenAI's Data tab) -->
				{#if evaluation.runs.length === 0}
					<div class="border rounded-md p-12 text-center text-sm text-muted-foreground">
						No runs yet. Switch to the Report tab and click <strong>Run</strong>.
					</div>
				{:else}
					<div class="flex items-center gap-2">
						<span class="text-xs uppercase tracking-wide text-muted-foreground">Run</span>
						<select
							value={selectedRunId ?? ''}
							onchange={(e) => (selectedRunId = (e.target as HTMLSelectElement).value)}
							class="text-sm border rounded px-2 py-1.5 bg-background"
						>
							{#each evaluation.runs as r (r.id)}
								<option value={r.id}>
									{r.status} · {formatDate(r.createdAt)} · {passRate(r.summary)}
								</option>
							{/each}
						</select>
						{#if selectedRunId}
							<Button
								variant="outline"
								size="sm"
								onclick={() =>
									goto(`/workspaces/${slug}/evaluations/evals/${evalId}/runs/${selectedRunId}`)}
							>
								Open run detail
							</Button>
						{/if}
					</div>
					{#if dataError}
						<Alert variant="destructive">
							<AlertDescription>{dataError}</AlertDescription>
						</Alert>
					{/if}
					{#if dataLoading && !selectedRun}
						<Skeleton class="h-64" />
					{:else if selectedRun}
						<RunItemsTable run={selectedRun} onSelectItem={(id) => (selectedItemId = id)} />
					{/if}
				{/if}
			{/if}
		</div>
	</div>
</div>

<!-- Inspect drawer for the Data tab -->
{#if selectedRun}
	<RunInspectDrawer
		run={selectedRun}
		{selectedItemId}
		{selectedItemDetail}
		{selectedItemLoading}
		onClose={() => (selectedItemId = null)}
		onSelect={(id) => (selectedItemId = id)}
	/>
{/if}
