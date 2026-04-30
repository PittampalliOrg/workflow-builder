<script lang="ts">
	import { goto } from '$app/navigation';
	import { onDestroy, onMount } from 'svelte';
	import { page } from '$app/state';
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
	import { Alert, AlertDescription } from '$lib/components/ui/alert';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import {
		ArrowDown,
		ArrowUp,
		ArrowUpDown,
		ChevronLeft,
		ChevronRight,
		History,
		Layers,
		RefreshCw,
		Search,
		X
	} from '@lucide/svelte';
	import RunStatusBadge from '$lib/components/benchmarks/run-status-badge.svelte';
	import MultiSelectCommand from '$lib/components/benchmarks/multi-select-command.svelte';
	import {
		formatRelative,
		isActiveRunStatus,
		suiteShortLabel
	} from '$lib/components/benchmarks/run-status-helpers';
	import type { PageData } from './$types';

	const { data }: { data: PageData } = $props();

	const slug = $derived((page.params.slug as string) ?? 'default');
	const MAX_COMPARE = 4;

	type Run = (typeof data.runs)[number];

	// svelte-ignore state_referenced_locally
	let runs = $state<Run[]>(data.runs);
	let loading = $state(false);
	let errorMessage = $state<string | null>(null);
	let pollTimer: ReturnType<typeof setTimeout> | null = null;

	const urlState = page.url;
	let globalFilter = $state(urlState.searchParams.get('q') ?? '');
	let statusFilter = $state(urlState.searchParams.get('status') ?? 'all');
	let suiteFilter = $state<string[]>(
		(urlState.searchParams.get('suites') ?? '')
			.split(',')
			.map((s) => s.trim())
			.filter(Boolean)
	);
	let agentFilter = $state<string[]>(
		(urlState.searchParams.get('agents') ?? '')
			.split(',')
			.map((s) => s.trim())
			.filter(Boolean)
	);
	let tagFilter = $state<string[]>(
		(urlState.searchParams.get('tags') ?? '')
			.split(',')
			.map((s) => s.trim())
			.filter(Boolean)
	);

	const _features = tableFeatures({
		rowSortingFeature,
		rowSelectionFeature,
		columnFilteringFeature,
		globalFilteringFeature,
		rowPaginationFeature
	});

	const columnHelper = createColumnHelper<typeof _features, Run>();

	function pctOf(run: Run): number {
		const total = (run.summary?.total as number | undefined) ?? run.selectedInstanceIds.length;
		const resolved = (run.summary?.resolved as number | undefined) ?? 0;
		return total > 0 ? resolved / total : 0;
	}

	// "Cell value is one of the selected" — TanStack's `arrIncludesSome`
	// expects the inverse (cell array contains some filter values), so we
	// roll our own. Returns true for an empty filter set.
	const cellInFilterArray = (
		row: { getValue: (id: string) => unknown },
		columnId: string,
		filterValue: unknown
	) => {
		const wanted = Array.isArray(filterValue) ? (filterValue as string[]) : [];
		if (wanted.length === 0) return true;
		return wanted.includes(row.getValue(columnId) as string);
	};

	const columns = columnHelper.columns([
		columnHelper.display({ id: 'select', enableSorting: false }),
		columnHelper.accessor('suiteName', {
			header: 'Suite',
			enableSorting: true,
			enableColumnFilter: true,
			filterFn: cellInFilterArray
		}),
		columnHelper.accessor('status', {
			header: 'Status',
			enableSorting: true,
			enableColumnFilter: true,
			filterFn: 'equalsString'
		}),
		columnHelper.accessor((r) => r.modelConfigLabel ?? '', {
			id: 'label',
			header: 'Label',
			enableSorting: true
		}),
		columnHelper.accessor('agentName', {
			header: 'Agent',
			enableSorting: true,
			enableGlobalFilter: true,
			enableColumnFilter: true,
			filterFn: cellInFilterArray
		}),
		columnHelper.accessor('modelNameOrPath', {
			header: 'Model',
			enableSorting: true,
			enableGlobalFilter: true
		}),
		columnHelper.accessor((r) => r.selectedInstanceIds.length, {
			id: 'count',
			header: 'Instances',
			enableSorting: true
		}),
		columnHelper.accessor((r) => pctOf(r), {
			id: 'resolved',
			header: 'Resolved',
			enableSorting: true
		}),
		// Tags column is hidden by default (rendered as chips in the row);
		// only the column filter is used.
		columnHelper.accessor((r) => r.tags ?? [], {
			id: 'tags',
			header: 'Tags',
			enableColumnFilter: true,
			filterFn: (row, columnId, filterValue) => {
				const rowTags = (row.getValue(columnId) as string[] | undefined) ?? [];
				const wanted = (filterValue as string[]) ?? [];
				return wanted.length === 0 || rowTags.some((t) => wanted.includes(t));
			}
		}),
		columnHelper.accessor('createdAt', { header: 'Started', enableSorting: true })
	]);

	// Stable-identity filters: $derived caches until inputs actually change,
	// so TanStack sees the same array reference on re-reads (no infinite loop).
	// MUST be declared before createTable — the `state.columnFilters` getter
	// reads it during table construction (TDZ violation otherwise).
	const columnFilters = $derived.by(() => {
		const next: Array<{ id: string; value: unknown }> = [];
		if (statusFilter !== 'all') next.push({ id: 'status', value: statusFilter });
		if (suiteFilter.length > 0) {
			const slugs = suiteFilter
				.map((s) => data.suiteOptions.find((o) => o.slug === s)?.name ?? s)
				.filter(Boolean);
			next.push({ id: 'suiteName', value: slugs });
		}
		if (agentFilter.length > 0) next.push({ id: 'agentName', value: [...agentFilter] });
		if (tagFilter.length > 0) next.push({ id: 'tags', value: [...tagFilter] });
		return next;
	});

	const table = createTable(
		{
			_features,
			_rowModels: {
				sortedRowModel: createSortedRowModel(sortFns),
				filteredRowModel: createFilteredRowModel(filterFns),
				paginatedRowModel: createPaginatedRowModel()
			},
			columns,
			getRowId: (row) => row.id,
			get data() {
				return runs;
			},
			get globalFilterFn() {
				return 'includesString' as const;
			},
			state: {
				get globalFilter() {
					return globalFilter;
				},
				get columnFilters() {
					return columnFilters;
				}
			},
			onGlobalFilterChange: (updater) => {
				globalFilter = typeof updater === 'function' ? updater(globalFilter) : updater;
			},
			// svelte-ignore state_referenced_locally
			initialState: {
				pagination: { pageIndex: 0, pageSize: 25 },
				sorting: [{ id: 'createdAt', desc: true }]
			}
		},
		(state) => state
	);

	const TABLE_OWNED_KEYS = ['q', 'status', 'suites', 'agents', 'tags'] as const;

	$effect(() => {
		if (typeof window === 'undefined') return;
		const params = new URLSearchParams(window.location.search);
		for (const key of TABLE_OWNED_KEYS) params.delete(key);
		if (globalFilter.trim()) params.set('q', globalFilter.trim());
		if (statusFilter !== 'all') params.set('status', statusFilter);
		if (suiteFilter.length > 0) params.set('suites', suiteFilter.join(','));
		if (agentFilter.length > 0) params.set('agents', agentFilter.join(','));
		if (tagFilter.length > 0) params.set('tags', tagFilter.join(','));
		const qs = params.toString();
		if (window.location.search !== (qs ? `?${qs}` : '')) {
			window.history.replaceState(window.history.state, '', qs ? `?${qs}` : window.location.pathname);
		}
	});

	const selectedCount = $derived(Object.keys(table?.state?.rowSelection ?? {}).length);
	const selectedIds = $derived(Object.keys(table?.state?.rowSelection ?? {}));
	const filteredCount = $derived(table?.getFilteredRowModel().rows.length ?? 0);

	function compareSelected() {
		if (selectedIds.length < 2) return;
		const ids = selectedIds.slice(0, MAX_COMPARE);
		goto(`/workspaces/${slug}/benchmarks/compare?runs=${ids.join(',')}`);
	}

	async function refresh(opts: { silent?: boolean } = {}) {
		if (!opts.silent) loading = true;
		try {
			const res = await fetch('/api/benchmarks/runs?limit=100');
			if (!res.ok) {
				if (!opts.silent) errorMessage = `Failed to load runs (${res.status})`;
				return;
			}
			const body = (await res.json()) as { runs: Run[] };
			runs = body.runs ?? [];
		} catch (err) {
			if (!opts.silent) errorMessage = err instanceof Error ? err.message : String(err);
		} finally {
			if (!opts.silent) loading = false;
		}
	}

	const hasActiveRuns = $derived(runs.some((r) => isActiveRunStatus(r.status)));

	function schedulePoll() {
		if (pollTimer) clearTimeout(pollTimer);
		pollTimer = setTimeout(
			async () => {
				if (typeof document === 'undefined' || document.visibilityState === 'visible') {
					await refresh({ silent: true });
				}
				schedulePoll();
			},
			hasActiveRuns ? 5000 : 30000
		);
	}

	const hasFilters = $derived(
		Boolean(globalFilter.trim()) ||
			statusFilter !== 'all' ||
			suiteFilter.length > 0 ||
			agentFilter.length > 0 ||
			tagFilter.length > 0
	);

	function clearFilters() {
		globalFilter = '';
		statusFilter = 'all';
		suiteFilter = [];
		agentFilter = [];
		tagFilter = [];
	}

	const STATUS_OPTIONS = [
		{ value: 'all', label: 'All' },
		{ value: 'queued', label: 'Queued' },
		{ value: 'inferencing', label: 'Inferencing' },
		{ value: 'evaluating', label: 'Evaluating' },
		{ value: 'completed', label: 'Completed' },
		{ value: 'failed', label: 'Failed' },
		{ value: 'cancelled', label: 'Cancelled' }
	];

	onMount(() => schedulePoll());
	onDestroy(() => {
		if (pollTimer) clearTimeout(pollTimer);
	});
</script>

<svelte:head><title>Benchmark runs</title></svelte:head>

<div class="space-y-4">
	<header class="flex flex-wrap items-start justify-between gap-3">
		<div>
			<h1 class="flex items-center gap-2 text-2xl font-semibold">
				<History class="size-6" /> Benchmark runs
			</h1>
			<p class="mt-1 text-sm text-muted-foreground">
				{runs.length} runs · select 2–{MAX_COMPARE} to compare across configurations.
			</p>
		</div>
		<Button variant="outline" size="sm" onclick={() => refresh()}>
			<RefreshCw class="size-3.5" /> Refresh
		</Button>
	</header>

	{#if errorMessage}
		<Alert variant="destructive">
			<AlertDescription>{errorMessage}</AlertDescription>
		</Alert>
	{/if}

	<div class="space-y-3">
		<!-- Toolbar -->
		<div class="flex flex-wrap items-center gap-2">
			<div class="relative max-w-sm flex-1">
				<Search class="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
				<input
					type="text"
					placeholder="Search agent, model…"
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

			<select
				class="h-8 rounded-md border border-border bg-background px-2 text-xs"
				bind:value={statusFilter}
			>
				{#each STATUS_OPTIONS as opt (opt.value)}
					<option value={opt.value}>{opt.label}</option>
				{/each}
			</select>

			<MultiSelectCommand
				options={data.suiteOptions.map((s) => ({
					value: s.slug,
					label: suiteShortLabel(s.slug),
					count: s.count
				}))}
				selected={suiteFilter}
				onChange={(v) => (suiteFilter = v)}
				label="Suite"
				placeholder="Filter by suite…"
			/>

			<MultiSelectCommand
				options={data.agentOptions.map((a) => ({ value: a.name, label: a.name, count: a.count }))}
				selected={agentFilter}
				onChange={(v) => (agentFilter = v)}
				label="Agent"
				placeholder="Filter by agent…"
			/>

			{#if (data.tagOptions ?? []).length > 0}
				<MultiSelectCommand
					options={(data.tagOptions ?? []).map((t) => ({
						value: t.tag,
						label: `#${t.tag}`,
						count: t.count
					}))}
					selected={tagFilter}
					onChange={(v) => (tagFilter = v)}
					label="Tag"
					placeholder="Filter by tag…"
					emptyText="No tags."
				/>
			{/if}

			{#if hasFilters}
				<Button variant="ghost" size="sm" class="h-8 text-xs" onclick={clearFilters}>
					<X class="mr-1 h-3 w-3" /> Clear filters
				</Button>
			{/if}
		</div>

		<!-- Bulk-action bar -->
		{#if selectedCount > 0}
			<div class="flex flex-wrap items-center gap-3 rounded-md border border-border bg-muted/40 px-4 py-2">
				<span class="text-xs font-medium tabular-nums">
					{selectedCount} of {MAX_COMPARE} selected
					{#if selectedCount > MAX_COMPARE}
						<span class="ml-1 text-amber-700 dark:text-amber-400">
							(max {MAX_COMPARE} compare)
						</span>
					{/if}
				</span>
				<Button
					variant="ghost"
					size="sm"
					class="h-7 text-xs"
					onclick={() => table?.resetRowSelection()}
				>
					Clear
				</Button>
				<div class="flex-1"></div>
				<Button
					size="sm"
					class="h-7 text-xs"
					onclick={compareSelected}
					disabled={selectedCount < 2}
					title={selectedCount < 2
						? 'Pick at least 2 runs to compare'
						: 'Open compare view with the selected runs'}
				>
					<Layers class="mr-1 h-3 w-3" />
					Compare {Math.min(selectedCount, MAX_COMPARE)}
				</Button>
			</div>
		{/if}

		<!-- Table -->
		<div class="overflow-x-auto rounded-md border border-border">
			<table class="w-full text-sm">
				<thead>
					{#each table.getHeaderGroups() as headerGroup (headerGroup.id)}
						<tr class="border-b border-border bg-muted/40 text-left text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
							{#each headerGroup.headers as header (header.id)}
								<th
									class="px-3 py-2 {header.column.getCanSort() ? 'cursor-pointer select-none' : ''} {header.id === 'select' ? 'w-10' : ''}"
									onclick={header.id !== 'select'
										? header.column.getToggleSortingHandler()
										: undefined}
								>
									{#if header.id === 'select'}
										<input
											type="checkbox"
											checked={table.getIsAllPageRowsSelected()}
											indeterminate={table.getIsSomePageRowsSelected() && !table.getIsAllPageRowsSelected()}
											onchange={table.getToggleAllPageRowsSelectedHandler()}
											class="h-3.5 w-3.5 rounded border-border accent-primary"
											aria-label="Select all on page"
										/>
									{:else}
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
									{/if}
								</th>
							{/each}
						</tr>
					{/each}
				</thead>
				<tbody>
					{#each table.getRowModel().rows as row (row.id)}
						{@const r = row.original}
						{@const total = (r.summary?.total as number | undefined) ?? r.selectedInstanceIds.length}
						{@const resolved = (r.summary?.resolved as number | undefined) ?? 0}
						{@const pct = total > 0 ? Math.round((resolved / total) * 100) : 0}
						<tr
							class="cursor-pointer border-b border-border last:border-b-0 hover:bg-muted/40"
							onclick={() => goto(`/workspaces/${slug}/benchmarks/runs/${r.id}`)}
						>
							<td class="px-3 py-2 align-middle" onclick={(e) => e.stopPropagation()}>
								<input
									type="checkbox"
									checked={row.getIsSelected()}
									onchange={row.getToggleSelectedHandler()}
									class="h-3.5 w-3.5 rounded border-border accent-primary"
									aria-label="Select run {r.id}"
									disabled={!row.getIsSelected() && selectedCount >= MAX_COMPARE}
								/>
							</td>
							<td class="px-3 py-2">
								<Badge variant="secondary" class="text-[10px]">{suiteShortLabel(r.suiteSlug)}</Badge>
							</td>
							<td class="px-3 py-2">
								<RunStatusBadge status={r.status} />
								{#if isActiveRunStatus(r.status)}
									<span class="ml-1 inline-flex h-1.5 w-1.5 animate-pulse rounded-full bg-blue-500" aria-hidden="true"></span>
								{/if}
							</td>
							<td class="px-3 py-2">
								{#if r.modelConfigLabel}
									<Badge variant="outline" class="text-[10px]">{r.modelConfigLabel}</Badge>
								{:else}
									<span class="text-xs text-muted-foreground">—</span>
								{/if}
							</td>
							<td class="px-3 py-2 text-xs">
								<span class="font-medium">{r.agentName}</span>
								<span class="text-muted-foreground"> v{r.agentVersion}</span>
							</td>
							<td class="px-3 py-2 font-mono text-xs">{r.modelNameOrPath}</td>
							<td class="px-3 py-2 font-mono text-xs tabular-nums text-muted-foreground">
								{r.selectedInstanceIds.length}
							</td>
							<td class="px-3 py-2">
								<div class="flex items-center gap-2">
									<span class="text-base font-semibold tabular-nums">{pct}%</span>
									<span class="text-[10px] text-muted-foreground tabular-nums">
										{resolved}/{total}
									</span>
								</div>
							</td>
							<td class="px-3 py-2">
								{#if (r.tags ?? []).length > 0}
									<div class="flex flex-wrap gap-1">
										{#each r.tags ?? [] as tag (tag)}
											<button
												type="button"
												class="inline-flex h-5 items-center rounded bg-primary/10 px-1.5 font-mono text-[10px] text-primary hover:bg-primary/15"
												onclick={(e) => {
													e.stopPropagation();
													tagFilter = tagFilter.includes(tag)
														? tagFilter.filter((t) => t !== tag)
														: [...tagFilter, tag];
												}}
												title="Filter to runs tagged #{tag}"
											>
												#{tag}
											</button>
										{/each}
									</div>
								{:else}
									<span class="text-xs text-muted-foreground">—</span>
								{/if}
							</td>
							<td class="px-3 py-2 text-xs text-muted-foreground">
								{formatRelative(r.createdAt)}
							</td>
						</tr>
					{:else}
						<tr>
							<td colspan={columns.length} class="px-4 py-12 text-center text-sm text-muted-foreground">
								{#if runs.length === 0}
									No benchmark runs yet. Launch a run from the Instances tab.
								{:else}
									No runs match the current filter.
								{/if}
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>

		<!-- Pagination -->
		<div class="flex items-center justify-between gap-3 text-xs text-muted-foreground">
			<span class="tabular-nums">
				{filteredCount} {filteredCount === 1 ? 'run' : 'runs'}
				{#if filteredCount !== runs.length}
					· of {runs.length}
				{/if}
			</span>
			{#if table.getPageCount() > 1}
				<div class="flex items-center gap-1">
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
					<span class="px-2 tabular-nums">
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
	</div>
</div>
