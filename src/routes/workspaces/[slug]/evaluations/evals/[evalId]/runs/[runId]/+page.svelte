<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { onDestroy } from 'svelte';
	import { Alert, AlertDescription } from '$lib/components/ui/alert';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { Skeleton } from '$lib/components/ui/skeleton';
	import AppBreadcrumb from '$lib/components/console/app-breadcrumb.svelte';
	import RunItemsTable from '$lib/components/evaluations/run-items-table.svelte';
	import RunInspectDrawer from '$lib/components/evaluations/run-inspect-drawer.svelte';
	import type { RunDetail } from '$lib/components/evaluations/types';
	import { ArrowLeft, Download, RefreshCw, StopCircle } from 'lucide-svelte';

	type RunStatus = RunDetail['status'];

	const slug = $derived((page.params.slug as string) ?? 'default');
	const evalId = $derived(page.params.evalId as string);
	const runId = $derived(page.params.runId as string);

	let run = $state<RunDetail | null>(null);
	let loading = $state(true);
	let busy = $state(false);
	let errorMessage = $state<string | null>(null);
	let selectedItemId = $state<string | null>(null);
	let pollHandle: ReturnType<typeof setTimeout> | null = null;

	const isActive = $derived(
		run?.status === 'queued' || run?.status === 'running' || run?.status === 'grading'
	);

	// OpenAI-shape result_counts: { total, passed, failed, errored }
	const resultCounts = $derived.by(() => {
		const s = run?.summary ?? {};
		const total = Number(s.total ?? 0);
		const passed = Number(s.passed ?? 0);
		const failed = Number(s.failed ?? 0);
		// Service uses "errors" today; mirror OpenAI's "errored"
		const errored = Number((s.errored ?? s.errors) ?? 0);
		const passRate = total > 0 ? passed / total : 0;
		return { total, passed, failed, errored, passRate };
	});

	// graderId → display name from item results (used by the per-criteria table
	// header so the row labels read e.g. "String check grader" instead of the
	// raw id). Items table + drawer compute their own copy.
	const graderNames = $derived.by(() => {
		const names = new Map<string, string>();
		for (const item of run?.items ?? []) {
			for (const [gid, result] of Object.entries(item.graderResults ?? {})) {
				if (!names.has(gid) && result?.name) names.set(gid, result.name);
			}
		}
		return names;
	});

	function nameFor(gid: string): string {
		return graderNames.get(gid) ?? gid;
	}

	// Per-grader breakdown from summary.perGrader
	const perGrader = $derived.by(() => {
		const pg = run?.summary?.perGrader;
		if (!pg || typeof pg !== 'object') return [];
		return Object.entries(pg as Record<string, Record<string, unknown>>).map(([id, stats]) => ({
			id,
			name: nameFor(id),
			total: Number(stats.total ?? 0),
			passed: Number(stats.passed ?? 0),
			failed: Number(stats.failed ?? 0),
			scoreMean:
				typeof stats.scoreMean === 'number'
					? stats.scoreMean
					: Number(stats.scored ?? 0) > 0
						? Number(stats.scoreTotal ?? 0) / Number(stats.scored ?? 0)
						: null
		}));
	});

	async function load(opts: { silent?: boolean } = {}) {
		if (!opts.silent) {
			loading = true;
			errorMessage = null;
		}
		try {
			const res = await fetch(`/api/evaluations/runs/${runId}`);
			if (!res.ok) {
				errorMessage = `Failed to load run (${res.status})`;
				return;
			}
			const data = (await res.json()) as { run: RunDetail };
			run = data.run;
		} catch (err) {
			errorMessage = err instanceof Error ? err.message : 'Failed to load run';
		} finally {
			loading = false;
		}
	}

	async function cancelRun() {
		if (!run || busy) return;
		busy = true;
		try {
			const res = await fetch(`/api/evaluations/runs/${runId}/cancel`, { method: 'POST' });
			if (!res.ok) {
				errorMessage = `Cancel failed (${res.status})`;
				return;
			}
			await load({ silent: true });
		} finally {
			busy = false;
		}
	}

	async function regrade() {
		if (!run || busy) return;
		busy = true;
		try {
			const res = await fetch(`/api/evaluations/runs/${runId}/grade`, { method: 'POST' });
			if (!res.ok) {
				errorMessage = `Re-grade failed (${res.status})`;
				return;
			}
			await load({ silent: true });
		} finally {
			busy = false;
		}
	}

	function downloadPredictions() {
		const a = document.createElement('a');
		a.href = `/api/evaluations/runs/${runId}/predictions.jsonl`;
		a.download = `${runId}.predictions.jsonl`;
		document.body.appendChild(a);
		a.click();
		document.body.removeChild(a);
	}

	function statusVariant(
		status: RunStatus
	): 'default' | 'secondary' | 'destructive' | 'outline' {
		if (status === 'completed') return 'default';
		if (status === 'failed' || status === 'cancelled') return 'destructive';
		return 'secondary';
	}

	function onSelectItem(e: CustomEvent<{ id: string }>) {
		selectedItemId = e.detail.id;
	}

	function schedulePoll() {
		if (pollHandle) clearTimeout(pollHandle);
		pollHandle = setTimeout(() => {
			if (isActive) load({ silent: true }).then(schedulePoll);
		}, 4000);
	}

	$effect(() => {
		if (runId) load();
	});

	$effect(() => {
		if (isActive) schedulePoll();
		else if (pollHandle) {
			clearTimeout(pollHandle);
			pollHandle = null;
		}
	});

	onDestroy(() => {
		if (pollHandle) clearTimeout(pollHandle);
	});
</script>

<svelte:head>
	<title>Run · {run?.evaluationName ?? 'Evaluation'}</title>
</svelte:head>

<div class="flex flex-col h-full">
	<header class="border-b px-6 py-4">
		<AppBreadcrumb
			items={[
				{ label: 'Evaluations', href: `/workspaces/${slug}/evaluations` },
				{ label: 'Evals', href: `/workspaces/${slug}/evaluations?tab=evals` },
				{
					label: run?.evaluationName ?? evalId.slice(0, 8),
					href: `/workspaces/${slug}/evaluations/evals/${evalId}`,
					truncate: true
				},
				{ label: 'Run', mono: true, truncate: true }
			]}
		/>
		<div class="mt-3 flex items-center justify-between gap-4 flex-wrap">
			<div class="flex items-center gap-3 min-w-0">
				<Button
					variant="outline"
					size="sm"
					onclick={() => goto(`/workspaces/${slug}/evaluations/evals/${evalId}`)}
				>
					<ArrowLeft class="size-3.5 mr-1" /> Eval
				</Button>
				{#if run}
					<Badge variant={statusVariant(run.status)} class="font-normal capitalize">
						{run.status}
					</Badge>
					<span class="text-sm text-muted-foreground">
						<span class="capitalize">{run.subjectType}</span>
						{#if run.subjectId}<span class="ml-1 font-mono">{run.subjectId.slice(0, 12)}…</span>{/if}
					</span>
				{/if}
			</div>
			<div class="flex items-center gap-2">
				<Button
					variant="outline"
					size="sm"
					onclick={() => load()}
					disabled={loading || busy}
				>
					<RefreshCw class="size-3.5 mr-1 {loading ? 'animate-spin' : ''}" /> Refresh
				</Button>
				<Button
					variant="outline"
					size="sm"
					onclick={downloadPredictions}
					disabled={!run}
				>
					<Download class="size-3.5 mr-1" /> Predictions
				</Button>
				<Button
					variant="outline"
					size="sm"
					onclick={regrade}
					disabled={!run || busy || run.status !== 'completed'}
				>
					Re-grade
				</Button>
				<Button
					variant="destructive"
					size="sm"
					onclick={cancelRun}
					disabled={!run || busy || !isActive}
				>
					<StopCircle class="size-3.5 mr-1" /> Cancel
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

			{#if loading && !run}
				<div class="grid grid-cols-2 md:grid-cols-5 gap-3">
					{#each Array(5) as _, i (i)}
						<Skeleton class="h-20" />
					{/each}
				</div>
				<Skeleton class="h-64" />
			{:else if run}
				<!-- KPI strip — mirrors OpenAI's result_counts: { total, passed, failed, errored } -->
				<div class="grid grid-cols-2 md:grid-cols-5 gap-3">
					<div class="border rounded-md p-4 bg-card">
						<div class="text-[10px] uppercase tracking-wide text-muted-foreground">Total</div>
						<div class="mt-1 text-2xl font-semibold tabular-nums">{resultCounts.total}</div>
					</div>
					<div class="border rounded-md p-4 bg-card">
						<div class="text-[10px] uppercase tracking-wide text-muted-foreground">Passed</div>
						<div class="mt-1 text-2xl font-semibold tabular-nums text-green-600">
							{resultCounts.passed}
						</div>
					</div>
					<div class="border rounded-md p-4 bg-card">
						<div class="text-[10px] uppercase tracking-wide text-muted-foreground">Failed</div>
						<div class="mt-1 text-2xl font-semibold tabular-nums text-destructive">
							{resultCounts.failed}
						</div>
					</div>
					<div class="border rounded-md p-4 bg-card">
						<div class="text-[10px] uppercase tracking-wide text-muted-foreground">Errored</div>
						<div class="mt-1 text-2xl font-semibold tabular-nums text-amber-600">
							{resultCounts.errored}
						</div>
					</div>
					<div class="border rounded-md p-4 bg-card">
						<div class="text-[10px] uppercase tracking-wide text-muted-foreground">Pass rate</div>
						<div class="mt-1 text-2xl font-semibold tabular-nums">
							{Math.round(resultCounts.passRate * 100)}%
						</div>
					</div>
				</div>

				{#if run.error}
					<Alert variant="destructive">
						<AlertDescription>{run.error}</AlertDescription>
					</Alert>
				{/if}

				<!-- Per-criteria breakdown (mirrors OpenAI's per_testing_criteria_results) -->
				{#if perGrader.length > 0}
					<section class="flex flex-col gap-2">
						<h2 class="text-sm font-semibold">Test criteria</h2>
						<div class="border rounded-md overflow-hidden">
							<table class="w-full text-sm">
								<thead class="bg-muted/30 text-[11px] uppercase tracking-wide text-muted-foreground">
									<tr class="border-b">
										<th class="px-4 py-2 text-left font-medium">Criterion</th>
										<th class="px-4 py-2 text-right font-medium">Passed</th>
										<th class="px-4 py-2 text-right font-medium">Failed</th>
										<th class="px-4 py-2 text-right font-medium">Pass rate</th>
										<th class="px-4 py-2 text-right font-medium">Mean score</th>
									</tr>
								</thead>
								<tbody class="divide-y">
									{#each perGrader as g (g.id)}
										<tr>
											<td class="px-4 py-3 text-xs">
												<div class="font-medium">{g.name}</div>
												{#if g.name !== g.id}
													<div class="font-mono text-[10px] text-muted-foreground">{g.id}</div>
												{/if}
											</td>
											<td class="px-4 py-3 text-right tabular-nums text-green-600">{g.passed}</td>
											<td class="px-4 py-3 text-right tabular-nums text-destructive">{g.failed}</td>
											<td class="px-4 py-3 text-right tabular-nums">
												{g.total > 0 ? Math.round((g.passed / g.total) * 100) : 0}%
											</td>
											<td class="px-4 py-3 text-right tabular-nums">
												{g.scoreMean !== null ? g.scoreMean.toFixed(3) : '—'}
											</td>
										</tr>
									{/each}
								</tbody>
							</table>
						</div>
					</section>
				{/if}

				<RunItemsTable {run} onSelectItem={(id) => (selectedItemId = id)} />
			{/if}
		</div>
	</div>
</div>


<!-- Inspect drawer with row-rail navigation (extracted to RunInspectDrawer) -->
{#if run}
	<RunInspectDrawer
		{run}
		{selectedItemId}
		onClose={() => (selectedItemId = null)}
		onSelect={(id) => (selectedItemId = id)}
	/>
{/if}
