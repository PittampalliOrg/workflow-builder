<script lang="ts">
	import {
		createTable,
		FlexRender,
		tableFeatures,
		rowSortingFeature,
		rowSelectionFeature,
		columnFilteringFeature,
		globalFilteringFeature,
		rowPaginationFeature,
		createSortedRowModel,
		createFilteredRowModel,
		createPaginatedRowModel,
		createColumnHelper,
		sortFns,
		filterFns
	} from '@tanstack/svelte-table';
	import { Button } from '$lib/components/ui/button';
	import {
		ArrowUpDown,
		ArrowUp,
		ArrowDown,
		ChevronLeft,
		ChevronRight,
		ExternalLink,
		Search,
		X
	} from '@lucide/svelte';
	import RunStatusBadge from './run-status-badge.svelte';
	import { formatDuration, formatTokens } from './run-status-helpers';
	import WorkloadStatusBadge from '$lib/components/capacity/workload-status-badge.svelte';
	import type { WorkloadSnapshot } from '$lib/server/kueueviz';

	type Instance = {
		id: string;
		instanceId: string;
		repo: string | null;
		status: string;
		inferenceStatus: string;
		evaluationStatus: string;
		patchBytes: number | null;
		startedAt: string | null;
		inferenceCompletedAt: string | null;
		evaluatedAt: string | null;
		usage: Record<string, unknown> | null;
		sessionId: string | null;
	};

	type Props = {
		instances: Instance[];
		workspaceSlug: string;
		selectedInstanceId: string | null;
		onSelect: (instanceId: string) => void;
		/**
		 * Optional reverse index from `benchmark-instance-id` → live Workload
		 * snapshot. Provided by the run detail page when capacity-by-instance
		 * lookup is wanted; omitted when there's no value (e.g. the table is
		 * mounted without an active workloads stream).
		 */
		capacityByInstance?: Map<string, WorkloadSnapshot>;
	};

	const {
		instances,
		workspaceSlug,
		selectedInstanceId,
		onSelect,
		capacityByInstance,
	}: Props = $props();

	const showCapacityColumn = $derived(capacityByInstance !== undefined);

	let globalFilter = $state('');

	function durationMs(row: Instance): number | null {
		if (row.startedAt && row.inferenceCompletedAt) {
			const a = new Date(row.startedAt).getTime();
			const b = new Date(row.inferenceCompletedAt).getTime();
			if (Number.isFinite(a) && Number.isFinite(b) && b >= a) return b - a;
		}
		return null;
	}

	function tokenSum(row: Instance): number {
		const u = row.usage ?? {};
		const t =
			(u as Record<string, unknown>).total_tokens ??
			(u as Record<string, unknown>).totalTokens;
		if (typeof t === 'number' && Number.isFinite(t)) return t;
		const i = Number(
			(u as Record<string, unknown>).input_tokens ??
				(u as Record<string, unknown>).inputTokens ??
				0,
		);
		const o = Number(
			(u as Record<string, unknown>).output_tokens ??
				(u as Record<string, unknown>).outputTokens ??
				0,
		);
		return (Number.isFinite(i) ? i : 0) + (Number.isFinite(o) ? o : 0);
	}

	const _features = tableFeatures({
		rowSortingFeature,
		rowSelectionFeature,
		columnFilteringFeature,
		globalFilteringFeature,
		rowPaginationFeature
	});

	const columnHelper = createColumnHelper<typeof _features, Instance>();

	const columns = columnHelper.columns([
		columnHelper.accessor('instanceId', {
			header: 'Instance',
			enableSorting: true,
			enableGlobalFilter: true
		}),
		columnHelper.accessor('repo', {
			header: 'Repo',
			enableSorting: true,
			enableGlobalFilter: true
		}),
		columnHelper.accessor('inferenceStatus', { header: 'Inference', enableSorting: true }),
		columnHelper.accessor('evaluationStatus', { header: 'Harness', enableSorting: true }),
		columnHelper.accessor('status', { header: 'Final', enableSorting: true }),
		columnHelper.accessor((r) => durationMs(r) ?? -1, {
			id: 'duration',
			header: 'Duration',
			enableSorting: true
		}),
		columnHelper.accessor((r) => tokenSum(r), {
			id: 'tokens',
			header: 'Tokens',
			enableSorting: true
		}),
		columnHelper.accessor('patchBytes', {
			header: 'Patch B',
			enableSorting: true
		})
	]);

	const table = createTable(
		{
			_features,
			_rowModels: {
				sortedRowModel: createSortedRowModel(sortFns),
				filteredRowModel: createFilteredRowModel(filterFns),
				paginatedRowModel: createPaginatedRowModel()
			},
			columns,
			getRowId: (row) => row.instanceId,
			get data() {
				return instances;
			},
			get globalFilterFn() {
				return 'includesString' as const;
			},
			state: {
				get globalFilter() {
					return globalFilter;
				}
			},
			onGlobalFilterChange: (updater) => {
				globalFilter = typeof updater === 'function' ? updater(globalFilter) : updater;
			},
			// svelte-ignore state_referenced_locally
			initialState: {
				pagination: { pageIndex: 0, pageSize: 100 },
				sorting: [{ id: 'instanceId', desc: false }]
			}
		},
		(state) => state
	);

	const filteredCount = $derived(table?.getFilteredRowModel().rows.length ?? 0);
</script>

<div class="space-y-2">
	<div class="flex items-center justify-between gap-2">
		<div class="relative max-w-md flex-1">
			<Search class="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
			<input
				type="text"
				placeholder="Search instance, repo…"
				bind:value={globalFilter}
				class="h-8 w-full rounded-md border border-border bg-background pl-8 pr-8 text-xs outline-none focus:ring-1 focus:ring-ring"
			/>
			{#if globalFilter}
				<button
					type="button"
					onclick={() => (globalFilter = '')}
					class="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
					aria-label="Clear search"
				>
					<X class="h-3.5 w-3.5" />
				</button>
			{/if}
		</div>
		<span class="text-[11px] tabular-nums text-muted-foreground">
			{filteredCount}{filteredCount !== instances.length ? ` of ${instances.length}` : ''} instances
		</span>
	</div>

	<div class="overflow-x-auto rounded-md border border-border">
		<table class="w-full text-sm">
			<thead>
				{#each table.getHeaderGroups() as headerGroup (headerGroup.id)}
					<tr class="border-b border-border bg-muted/40 text-left text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
						{#each headerGroup.headers as header (header.id)}
							<th
								class="px-3 py-2 {header.column.getCanSort() ? 'cursor-pointer select-none' : ''}"
								onclick={header.column.getToggleSortingHandler()}
							>
								<div class="flex items-center gap-1">
									{#if !header.isPlaceholder}<FlexRender {header} />{/if}
									{#if header.column.getCanSort()}
										{#if header.column.getIsSorted() === 'asc'}
											<ArrowUp class="h-3 w-3" />
										{:else if header.column.getIsSorted() === 'desc'}
											<ArrowDown class="h-3 w-3" />
										{:else}
											<ArrowUpDown class="h-3 w-3 opacity-30" />
										{/if}
									{/if}
								</div>
							</th>
						{/each}
						{#if showCapacityColumn}
							<th class="px-3 py-2">Queue</th>
						{/if}
						<th class="px-3 py-2"></th>
					</tr>
				{/each}
			</thead>
			<tbody>
				{#each table.getRowModel().rows as row (row.id)}
					{@const isSelected = row.original.instanceId === selectedInstanceId}
					<tr
						class="border-b border-border last:border-b-0 cursor-pointer hover:bg-muted/40 {isSelected ? 'bg-muted/60' : ''}"
						onclick={() => onSelect(row.original.instanceId)}
					>
						<td class="px-3 py-2">
							<span class="font-mono text-xs text-foreground">{row.original.instanceId}</span>
						</td>
						<td class="px-3 py-2">
							<span class="font-mono text-xs text-muted-foreground">{row.original.repo ?? '—'}</span>
						</td>
						<td class="px-3 py-2">
							<RunStatusBadge status={row.original.inferenceStatus} />
						</td>
						<td class="px-3 py-2">
							<RunStatusBadge status={row.original.evaluationStatus} />
						</td>
						<td class="px-3 py-2">
							<RunStatusBadge status={row.original.status} />
						</td>
						<td class="px-3 py-2 font-mono text-xs tabular-nums text-muted-foreground">
							{formatDuration(durationMs(row.original))}
						</td>
						<td class="px-3 py-2 font-mono text-xs tabular-nums text-muted-foreground">
							{formatTokens(tokenSum(row.original))}
						</td>
						<td class="px-3 py-2 text-right font-mono text-xs tabular-nums text-muted-foreground">
							{row.original.patchBytes ? `${row.original.patchBytes}` : '—'}
						</td>
						{#if showCapacityColumn}
							{@const wl = capacityByInstance?.get(row.original.instanceId) ?? null}
							<td class="px-3 py-2">
								{#if wl}
									<a
										href={`/workspaces/${workspaceSlug}/capacity/workloads?queue=${encodeURIComponent(wl.queueName || wl.clusterQueueName || '')}`}
										onclick={(e) => e.stopPropagation()}
										class="inline-flex items-center gap-1.5"
										title={wl.name}
									>
										<WorkloadStatusBadge status={wl.status} />
										<span class="font-mono text-[10px] text-muted-foreground">{wl.queueName}</span>
									</a>
								{:else}
									<span class="text-[10px] text-muted-foreground">—</span>
								{/if}
							</td>
						{/if}
						<td class="px-3 py-2 text-right">
							<div class="flex items-center justify-end gap-1">
								{#if row.original.sessionId}
									<a
										href={`/workspaces/${workspaceSlug}/sessions/${row.original.sessionId}`}
										onclick={(e) => e.stopPropagation()}
										class="text-muted-foreground hover:text-foreground"
										title="Open session"
										aria-label="Open session"
									>
										<ExternalLink class="h-3.5 w-3.5" />
									</a>
								{/if}
							</div>
						</td>
					</tr>
				{:else}
					<tr>
						<td colspan={columns.length + 1 + (showCapacityColumn ? 1 : 0)} class="px-4 py-12 text-center text-sm text-muted-foreground">
							No instances match.
						</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</div>

	{#if table.getPageCount() > 1}
		<div class="flex items-center justify-end gap-1 text-xs">
			<Button
				variant="outline"
				size="icon"
				class="h-7 w-7"
				onclick={() => table.previousPage()}
				disabled={!table.getCanPreviousPage()}
				aria-label="Previous page"
			>
				<ChevronLeft class="h-3.5 w-3.5" />
			</Button>
			<span class="px-2 text-xs tabular-nums">
				Page {table.state.pagination.pageIndex + 1} of {table.getPageCount()}
			</span>
			<Button
				variant="outline"
				size="icon"
				class="h-7 w-7"
				onclick={() => table.nextPage()}
				disabled={!table.getCanNextPage()}
				aria-label="Next page"
			>
				<ChevronRight class="h-3.5 w-3.5" />
			</Button>
		</div>
	{/if}
</div>
