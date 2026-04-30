<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import { Badge } from '$lib/components/ui/badge';
	import {
		ChevronLeft,
		ChevronRight,
		Search,
		X,
		Check,
		AlertTriangle,
		Loader2
	} from 'lucide-svelte';
	import RunStatusBadge from './run-status-badge.svelte';
	import { formatTokens, formatDuration, isActiveRunStatus } from './run-status-helpers';
	import type { CompareData, InstanceCell, RunConfigSummary } from '$lib/server/benchmarks/comparison';

	type Props = {
		data: CompareData;
		view: 'all' | 'shared' | 'disagreement';
		onView: (next: 'all' | 'shared' | 'disagreement') => void;
		onCellClick: (args: { runId: string; instanceId: string }) => void;
	};

	const { data, view, onView, onCellClick }: Props = $props();

	let search = $state('');
	let pageIndex = $state(0);
	const pageSize = 50;

	const visibleInstanceIds = $derived.by(() => {
		const base =
			view === 'disagreement'
				? data.disagreements
				: view === 'shared'
					? data.sharedInstanceIds
					: data.allInstanceIds;
		const q = search.trim().toLowerCase();
		return q ? base.filter((id) => id.toLowerCase().includes(q)) : base;
	});

	const pageCount = $derived(Math.max(1, Math.ceil(visibleInstanceIds.length / pageSize)));

	const pageInstances = $derived(
		visibleInstanceIds.slice(pageIndex * pageSize, (pageIndex + 1) * pageSize)
	);

	function cellSummary(cell: InstanceCell | undefined) {
		if (!cell) {
			return {
				icon: '—',
				color: 'bg-muted/30 text-muted-foreground',
				title: 'Not in this run'
			};
		}
		if (cell.resolved) {
			return {
				icon: 'check',
				color: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400',
				title: 'Resolved'
			};
		}
		if (isActiveRunStatus(cell.status) || cell.status === 'inferred') {
			return {
				icon: 'loader',
				color: 'bg-blue-500/15 text-blue-700 dark:text-blue-400',
				title: cell.status
			};
		}
		if (cell.status === 'cancelled') {
			return {
				icon: 'x',
				color: 'bg-gray-400/15 text-gray-600',
				title: 'Cancelled'
			};
		}
		return {
			icon: 'alert',
			color: 'bg-red-500/15 text-red-700 dark:text-red-400',
			title: cell.status
		};
	}

	const VIEWS = [
		{ value: 'disagreement', label: 'Disagree', count: () => data.disagreements.length },
		{ value: 'shared', label: 'Shared', count: () => data.sharedInstanceIds.length },
		{ value: 'all', label: 'All', count: () => data.allInstanceIds.length }
	] as const;

	function clamp(n: number, min: number, max: number) {
		return Math.max(min, Math.min(max, n));
	}

	function setPage(p: number) {
		pageIndex = clamp(p, 0, pageCount - 1);
	}
</script>

<div class="space-y-2">
	<div class="flex flex-wrap items-center gap-2">
		<div class="flex h-8 items-center gap-0.5 rounded-md border border-border p-0.5 text-[11px]">
			{#each VIEWS as v (v.value)}
				<button
					type="button"
					class="h-7 rounded px-2.5 transition-colors {view === v.value
						? 'bg-muted font-medium'
						: 'hover:bg-muted/40'}"
					onclick={() => {
						onView(v.value);
						pageIndex = 0;
					}}
				>
					{v.label}
					<span class="ml-1 text-muted-foreground">{v.count()}</span>
				</button>
			{/each}
		</div>

		<div class="relative max-w-xs flex-1">
			<Search class="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
			<input
				type="text"
				placeholder="Search instance…"
				bind:value={search}
				class="h-8 w-full rounded-md border border-border bg-background pl-8 pr-8 text-xs outline-none focus:ring-1 focus:ring-ring"
			/>
			{#if search}
				<button
					type="button"
					onclick={() => (search = '')}
					class="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
					aria-label="Clear search"
				>
					<X class="h-3.5 w-3.5" />
				</button>
			{/if}
		</div>

		<div class="flex-1"></div>

		<span class="text-[11px] tabular-nums text-muted-foreground">
			{visibleInstanceIds.length} instances
		</span>
	</div>

	<div class="overflow-x-auto rounded-md border border-border">
		<table class="w-full text-sm">
			<thead>
				<tr class="border-b border-border bg-muted/40 text-left text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
					<th class="px-3 py-2">Instance</th>
					{#each data.runs as run, idx (run.runId)}
						<th class="px-3 py-2 text-center">
							<div class="flex flex-col items-center">
								<span>Run #{idx + 1}</span>
								<span class="font-mono text-[9px] normal-case text-muted-foreground">
									{run.modelLabel ?? run.model}
								</span>
							</div>
						</th>
					{/each}
				</tr>
			</thead>
			<tbody>
				{#each pageInstances as instanceId (instanceId)}
					<tr class="border-b border-border last:border-b-0 hover:bg-muted/20">
						<td class="px-3 py-1.5 align-middle">
							<span class="font-mono text-xs text-foreground">{instanceId}</span>
						</td>
						{#each data.runs as run (run.runId)}
							{@const cell = data.grid[run.runId]?.[instanceId]}
							{@const sum = cellSummary(cell)}
							<td class="px-3 py-1.5 text-center">
								<button
									type="button"
									class="inline-flex h-7 min-w-[28px] items-center justify-center gap-1 rounded px-2 text-xs transition-colors hover:opacity-80 {sum.color}"
									title={sum.title}
									onclick={() => cell && onCellClick({ runId: run.runId, instanceId })}
									disabled={!cell}
								>
									{#if sum.icon === 'check'}
										<Check class="h-3.5 w-3.5" />
									{:else if sum.icon === 'loader'}
										<Loader2 class="h-3.5 w-3.5 animate-spin" />
									{:else if sum.icon === 'alert'}
										<AlertTriangle class="h-3.5 w-3.5" />
									{:else if sum.icon === 'x'}
										<X class="h-3.5 w-3.5" />
									{:else}
										<span class="text-muted-foreground">—</span>
									{/if}
									{#if cell?.tokens}
										<span class="text-[10px] tabular-nums opacity-60">
											{formatTokens(cell.tokens)}
										</span>
									{/if}
								</button>
							</td>
						{/each}
					</tr>
				{:else}
					<tr>
						<td
							colspan={data.runs.length + 1}
							class="px-3 py-12 text-center text-sm text-muted-foreground"
						>
							{#if view === 'disagreement' && data.disagreements.length === 0}
								No disagreements — all runs returned the same verdicts on shared instances.
							{:else if view === 'shared' && data.sharedInstanceIds.length === 0}
								No instances shared across all runs.
							{:else}
								No instances match.
							{/if}
						</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</div>

	{#if pageCount > 1}
		<div class="flex items-center justify-end gap-1 text-xs">
			<Button
				variant="outline"
				size="icon"
				class="h-7 w-7"
				onclick={() => setPage(pageIndex - 1)}
				disabled={pageIndex === 0}
				aria-label="Previous page"
			>
				<ChevronLeft class="h-3.5 w-3.5" />
			</Button>
			<span class="px-2 tabular-nums">
				Page {pageIndex + 1} of {pageCount}
			</span>
			<Button
				variant="outline"
				size="icon"
				class="h-7 w-7"
				onclick={() => setPage(pageIndex + 1)}
				disabled={pageIndex >= pageCount - 1}
				aria-label="Next page"
			>
				<ChevronRight class="h-3.5 w-3.5" />
			</Button>
		</div>
	{/if}
</div>
