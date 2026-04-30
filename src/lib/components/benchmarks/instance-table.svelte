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
		columnVisibilityFeature,
		createSortedRowModel,
		createFilteredRowModel,
		createPaginatedRowModel,
		createColumnHelper,
		sortFns,
		filterFns
	} from '@tanstack/svelte-table';
	import { page } from '$app/state';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import * as ToggleGroup from '$lib/components/ui/toggle-group';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import {
		ArrowUpDown,
		ArrowUp,
		ArrowDown,
		Check,
		ChevronLeft,
		ChevronRight,
		ChevronsLeft,
		ChevronsRight,
		Columns3,
		Dices,
		ExternalLink,
		Play,
		Search,
		Sparkles,
		X
	} from '@lucide/svelte';
	import MultiSelectCommand from './multi-select-command.svelte';
	import type {
		BenchmarkInstanceRow,
		RepoFacet,
		SuiteFacet
	} from '$lib/types/benchmark-instance';

	type Props = {
		instances: BenchmarkInstanceRow[];
		repoFacets: RepoFacet[];
		suiteFacets: SuiteFacet[];
		onLaunch: (args: { instanceIds: string[]; suiteSlug: string }) => void;
		onInstanceClick: (args: { instanceId: string; suiteSlug: string }) => void;
		canLaunch?: boolean;
	};

	const { instances, repoFacets, suiteFacets, onLaunch, onInstanceClick, canLaunch = true }: Props =
		$props();

	const MAX_RUN_INSTANCES = 500;

	// ---- URL-bound filter state -----------------------------------------------
	const urlState = page.url;
	let globalFilter = $state(urlState.searchParams.get('q') ?? '');
	let suiteFilter = $state<'all' | string>(urlState.searchParams.get('suite') ?? 'all');
	let repoFilter = $state<string[]>(
		(urlState.searchParams.get('repos') ?? '')
			.split(',')
			.map((s) => s.trim())
			.filter(Boolean)
	);
	let pageSize = $state(Number.parseInt(urlState.searchParams.get('pageSize') ?? '50', 10));
	let pageIndex = $state(Number.parseInt(urlState.searchParams.get('page') ?? '0', 10));
	let sortKey = $state(urlState.searchParams.get('sort') ?? 'instanceId');
	let sortDesc = $state(urlState.searchParams.get('dir') === 'desc');
	const RANDOM_COUNT_OPTIONS = [1, 3, 5, 10, 25, 50, 100] as const;
	let randomCount = $state<number>(3);

	// ---- Column visibility ----------------------------------------------------
	// Owned by TanStack's internal state. Mirroring it in Svelte $state and
	// returning a snapshot from the state getter on every read breaks
	// reference identity, which triggers an `effect_update_depth_exceeded`
	// loop (TanStack thinks state changed → re-renders → re-reads state →
	// new snapshot → loop). Read via `table.getState().columnVisibility`
	// in templates and update via `table.setColumnVisibility(...)`.
	const DEFAULT_COLUMN_VISIBILITY: Record<string, boolean> = {
		baseCommit: false,
		version: false,
		hintsLen: false,
		testPatchLines: false
	};

	// ---- TanStack setup -------------------------------------------------------
	const _features = tableFeatures({
		rowSortingFeature,
		rowSelectionFeature,
		columnFilteringFeature,
		globalFilteringFeature,
		rowPaginationFeature,
		columnVisibilityFeature
	});

	const columnHelper = createColumnHelper<typeof _features, BenchmarkInstanceRow>();

	const columns = columnHelper.columns([
		columnHelper.display({ id: 'select', enableSorting: false }),
		columnHelper.accessor('instanceId', {
			header: 'Instance',
			enableSorting: true,
			enableGlobalFilter: true
		}),
		columnHelper.accessor('suiteSlug', {
			header: 'Suite',
			enableColumnFilter: true,
			filterFn: 'equalsString',
			enableSorting: true
		}),
		columnHelper.accessor('repo', {
			header: 'Repo',
			enableColumnFilter: true,
			// `arrIncludesSome` from TanStack expects the CELL value to be an
			// array; ours is a string. We need the inverse: cell value is one
			// of the (array of) selected repos.
			filterFn: (row, columnId, filterValue) => {
				const wanted = (filterValue as string[]) ?? [];
				if (wanted.length === 0) return true;
				return wanted.includes(row.getValue(columnId) as string);
			},
			enableSorting: true,
			enableGlobalFilter: true
		}),
		columnHelper.accessor('problemPreview', {
			header: 'Problem',
			enableSorting: false,
			enableGlobalFilter: true
		}),
		columnHelper.accessor('failToPassCount', {
			header: 'F2P',
			enableSorting: true
		}),
		columnHelper.accessor('passToPassCount', {
			header: 'P2P',
			enableSorting: true
		}),
		columnHelper.accessor('hasGoldPatch', {
			header: 'Gold',
			enableSorting: true
		}),
		// Toggleable columns
		columnHelper.accessor('baseCommit', {
			header: 'Base commit',
			enableSorting: true
		}),
		columnHelper.accessor('version', {
			header: 'Version',
			enableSorting: true
		}),
		columnHelper.accessor('hintsLen', {
			header: 'Hints',
			enableSorting: true
		}),
		columnHelper.accessor('testPatchLines', {
			header: 'Test Δ',
			enableSorting: true
		})
	]);

	// IMPORTANT: TanStack's `getInitialTableState` calls `structuredClone` on
	// the `initialState`, which throws DataCloneError on Svelte 5 `$state`
	// proxies. Build a plain-object snapshot at construction and use a
	// `$derived.by` for ongoing state.columnFilters so identity is stable
	// (otherwise TanStack triggers an `effect_update_depth_exceeded` loop).
	function buildInitialColumnFilters() {
		const filters: Array<{ id: string; value: unknown }> = [];
		if (suiteFilter !== 'all') filters.push({ id: 'suiteSlug', value: suiteFilter });
		if (repoFilter.length > 0) filters.push({ id: 'repo', value: [...repoFilter] });
		return filters;
	}

	// Stable-identity column filters: $derived caches the array result until
	// suiteFilter/repoFilter actually change, so TanStack sees the same
	// reference on re-reads (no spurious updates → no infinite loop).
	const columnFilters = $derived.by(() => {
		const filters: Array<{ id: string; value: unknown }> = [];
		if (suiteFilter !== 'all') filters.push({ id: 'suiteSlug', value: suiteFilter });
		if (repoFilter.length > 0) filters.push({ id: 'repo', value: [...repoFilter] });
		return filters;
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
			// Use the DB primary key, not `instanceId` — the same SWE-bench
			// instance can appear in both Verified and Lite suites, which would
			// duplicate the keyed-each block and crash hydration.
			getRowId: (row) => row.id,
			get data() {
				return instances;
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
				pagination: { pageIndex, pageSize },
				sorting: [{ id: sortKey, desc: sortDesc }],
				columnFilters: buildInitialColumnFilters(),
				columnVisibility: { ...DEFAULT_COLUMN_VISIBILITY }
			}
		},
		(state) => state
	);

	// (column-filter sync is handled by the `state.columnFilters` getter above)

	// ---- URL state sync -------------------------------------------------------
	// We own these keys; everything else (e.g. ?run=, ?instance=) is preserved
	// so deep-links from the launch flow and run-detail panel keep working.
	const TABLE_OWNED_KEYS = ['q', 'suite', 'repos', 'sort', 'dir', 'page', 'pageSize'] as const;

	$effect(() => {
		if (typeof window === 'undefined') return;
		const params = new URLSearchParams(window.location.search);
		for (const key of TABLE_OWNED_KEYS) params.delete(key);
		if (globalFilter.trim()) params.set('q', globalFilter.trim());
		if (suiteFilter !== 'all') params.set('suite', suiteFilter);
		if (repoFilter.length > 0) params.set('repos', repoFilter.join(','));
		const sortState = table?.state?.sorting?.[0];
		if (sortState && sortState.id !== 'instanceId') {
			params.set('sort', sortState.id);
			if (sortState.desc) params.set('dir', 'desc');
		}
		if (pageSize !== 50) params.set('pageSize', String(pageSize));
		if (pageIndex !== 0) params.set('page', String(pageIndex));
		const qs = params.toString();
		const next = qs ? `?${qs}` : page.url.pathname;
		const current = window.location.search;
		if (current !== (qs ? `?${qs}` : '')) {
			window.history.replaceState(window.history.state, '', next);
		}
	});

	// ---- Selection helpers ----------------------------------------------------
	const selectedCount = $derived(table ? Object.keys(table.state?.rowSelection ?? {}).length : 0);
	const filteredRowCount = $derived(table?.getFilteredRowModel().rows.length ?? 0);
	const pageRowCount = $derived(table?.getRowModel().rows.length ?? 0);
	const allFilteredSelected = $derived(
		filteredRowCount > 0 && selectedCount >= filteredRowCount
	);
	const showSelectAllBanner = $derived(
		selectedCount > 0 &&
			selectedCount < filteredRowCount &&
			table?.getIsAllPageRowsSelected() === true
	);

	function selectAllFiltered() {
		if (!table) return;
		const filtered = table.getFilteredRowModel().rows;
		const cap = Math.min(filtered.length, MAX_RUN_INSTANCES);
		const next: Record<string, boolean> = {};
		for (let i = 0; i < cap; i++) {
			next[filtered[i].id] = true;
		}
		table.setRowSelection(next);
	}

	function selectedRows(): BenchmarkInstanceRow[] {
		const selectedRowIds = Object.keys(table?.state?.rowSelection ?? {});
		const ids = new Set(selectedRowIds);
		return instances.filter((i) => ids.has(i.id));
	}

	function effectiveSuiteSlug(rows: BenchmarkInstanceRow[]): string {
		if (suiteFilter !== 'all') return suiteFilter;
		const slugs = new Set(rows.map((r) => r.suiteSlug));
		if (slugs.size === 1) return [...slugs][0];
		// User mixed suites in their selection — pick the most-represented slug.
		const counts = new Map<string, number>();
		for (const r of rows) counts.set(r.suiteSlug, (counts.get(r.suiteSlug) ?? 0) + 1);
		return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'SWE-bench_Verified';
	}

	function launchSelected() {
		const rows = selectedRows();
		if (rows.length === 0) return;
		const suite = effectiveSuiteSlug(rows);
		// Filter to a single suite — the coordinator only targets one per run.
		const filteredRows = rows.filter((r) => r.suiteSlug === suite);
		onLaunch({
			instanceIds: filteredRows.map((r) => r.instanceId),
			suiteSlug: suite
		});
	}

	function launchRandom() {
		if (!table) return;
		// 1) Pick the suite FIRST so cross-suite samples don't get dropped
		// downstream — coordinator only targets one suite per run. If the user
		// has a suite pinned in the filter use that; otherwise pick the
		// most-represented suite across the *visible* (filter-respecting) rows.
		const filteredRowModel = table.getFilteredRowModel().rows;
		const allFilteredRows = filteredRowModel.map((r) => r.original);
		if (allFilteredRows.length === 0) return;
		const suite = effectiveSuiteSlug(allFilteredRows);
		// 2) Restrict to that suite, then sample N — guarantees we hit `n`
		// instances, never fewer.
		const suiteRows = allFilteredRows.filter((r) => r.suiteSlug === suite);
		const n = Math.min(Math.max(1, randomCount), suiteRows.length, MAX_RUN_INSTANCES);
		if (n === 0) return;
		const indexes = new Set<number>();
		while (indexes.size < n) {
			indexes.add(Math.floor(Math.random() * suiteRows.length));
		}
		const sampledRows = [...indexes].map((idx) => suiteRows[idx]);
		onLaunch({
			instanceIds: sampledRows.map((r) => r.instanceId),
			suiteSlug: suite
		});
	}

	function clearAllFilters() {
		globalFilter = '';
		suiteFilter = 'all';
		repoFilter = [];
		table?.resetRowSelection();
	}

	function suiteLabel(slug: string): string {
		return suiteFacets.find((s) => s.slug === slug)?.name ?? slug;
	}

	function suiteShortLabel(slug: string): string {
		if (slug === 'SWE-bench_Verified') return 'Verified';
		if (slug === 'SWE-bench_Lite') return 'Lite';
		return slug;
	}

	const hasActiveFilters = $derived(
		Boolean(globalFilter.trim()) || suiteFilter !== 'all' || repoFilter.length > 0
	);
</script>

<div class="space-y-3">
	<!-- Toolbar: search, suite picker, repo facet, columns -->
	<div class="flex flex-wrap items-center gap-2">
		<div class="relative flex-1 min-w-[200px] max-w-md">
			<Search class="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
			<input
				type="text"
				placeholder="Search instances, repos, problem text…"
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

		<ToggleGroup.Root
			type="single"
			value={suiteFilter}
			onValueChange={(v) => {
				if (typeof v === 'string') suiteFilter = v as 'all' | string;
			}}
			class="h-8"
		>
			<ToggleGroup.Item value="all" class="h-8 px-3 text-xs">
				All <span class="ml-1 text-muted-foreground">{instances.length}</span>
			</ToggleGroup.Item>
			{#each suiteFacets as suite (suite.slug)}
				<ToggleGroup.Item value={suite.slug} class="h-8 px-3 text-xs">
					{suiteShortLabel(suite.slug)}
					<span class="ml-1 text-muted-foreground">{suite.instanceCount}</span>
				</ToggleGroup.Item>
			{/each}
		</ToggleGroup.Root>

		<MultiSelectCommand
			options={repoFacets}
			selected={repoFilter}
			onChange={(next) => (repoFilter = next)}
			placeholder="Filter by repo…"
			label="Repo"
			emptyText="No repos."
		/>

		<DropdownMenu.Root>
			<DropdownMenu.Trigger class="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-background px-2.5 text-xs font-medium hover:bg-muted/40 transition-colors">
				<Columns3 class="h-3.5 w-3.5" />
				Columns
			</DropdownMenu.Trigger>
			<DropdownMenu.Content align="end" class="w-48">
				<DropdownMenu.Label class="text-[10px] uppercase text-muted-foreground">
					Optional columns
				</DropdownMenu.Label>
				{@const visibility = (table?.state?.columnVisibility ?? {}) as Record<string, boolean>}
				<DropdownMenu.CheckboxItem
					checked={visibility.baseCommit !== false}
					onCheckedChange={(v) =>
						table.setColumnVisibility({ ...visibility, baseCommit: v })}
				>
					Base commit
				</DropdownMenu.CheckboxItem>
				<DropdownMenu.CheckboxItem
					checked={visibility.version !== false}
					onCheckedChange={(v) =>
						table.setColumnVisibility({ ...visibility, version: v })}
				>
					Version
				</DropdownMenu.CheckboxItem>
				<DropdownMenu.CheckboxItem
					checked={visibility.hintsLen !== false}
					onCheckedChange={(v) =>
						table.setColumnVisibility({ ...visibility, hintsLen: v })}
				>
					Hints length
				</DropdownMenu.CheckboxItem>
				<DropdownMenu.CheckboxItem
					checked={visibility.testPatchLines !== false}
					onCheckedChange={(v) =>
						table.setColumnVisibility({ ...visibility, testPatchLines: v })}
				>
					Test patch lines
				</DropdownMenu.CheckboxItem>
			</DropdownMenu.Content>
		</DropdownMenu.Root>

		{#if hasActiveFilters}
			<Button variant="ghost" size="sm" class="h-8 text-xs" onclick={clearAllFilters}>
				<X class="mr-1 h-3 w-3" /> Clear filters
			</Button>
		{/if}

		<div class="ml-auto flex items-center gap-2">
			<div class="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-2.5 h-8 text-xs">
				<Dices class="h-3.5 w-3.5 text-muted-foreground" />
				<select
					bind:value={randomCount}
					class="h-5 bg-transparent text-xs outline-none cursor-pointer pr-1"
					aria-label="Random sample size"
				>
					{#each RANDOM_COUNT_OPTIONS as opt (opt)}
						{#if opt <= filteredRowCount && opt <= MAX_RUN_INSTANCES}
							<option value={opt}>{opt}</option>
						{/if}
					{/each}
				</select>
				<Button
					variant="ghost"
					size="sm"
					class="h-6 px-2 text-xs"
					onclick={launchRandom}
					disabled={!canLaunch || filteredRowCount === 0}
					title="Sample N at random from current filter (single suite)"
				>
					Run Random
				</Button>
			</div>
		</div>
	</div>

	<!-- Bulk action toolbar -->
	{#if selectedCount > 0}
		<div class="flex flex-wrap items-center gap-3 rounded-md border border-border bg-muted/40 px-4 py-2">
			<span class="text-xs font-medium tabular-nums">
				{selectedCount} selected
				{#if hasActiveFilters}
					<span class="text-muted-foreground">· of {filteredRowCount} matching filter</span>
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
				onclick={launchSelected}
				disabled={!canLaunch || selectedCount > MAX_RUN_INSTANCES}
				title={selectedCount > MAX_RUN_INSTANCES
					? `Max ${MAX_RUN_INSTANCES} instances per run`
					: 'Launch a run with the selected instances'}
			>
				<Play class="mr-1 h-3 w-3" />
				Run Selected ({selectedCount})
			</Button>
		</div>
	{/if}

	<!-- Select-all banner -->
	{#if showSelectAllBanner}
		<div class="flex items-center gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-1.5 text-xs dark:border-amber-900/40 dark:bg-amber-950/30">
			<Sparkles class="h-3.5 w-3.5 text-amber-600 dark:text-amber-400" />
			<span class="text-amber-900 dark:text-amber-200">
				All {pageRowCount} on this page selected.
			</span>
			<Button
				variant="link"
				size="sm"
				class="h-auto p-0 text-xs underline"
				onclick={selectAllFiltered}
			>
				{filteredRowCount > MAX_RUN_INSTANCES
					? `Select first ${MAX_RUN_INSTANCES} matching the filter`
					: `Select all ${filteredRowCount} matching the filter`}
			</Button>
		</div>
	{/if}

	<!-- Table -->
	<div class="rounded-md border border-border overflow-x-auto">
		<table class="w-full text-sm">
			<thead>
				{#each table.getHeaderGroups() as headerGroup (headerGroup.id)}
					<tr class="border-b border-border bg-muted/40 text-left text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
						{#each headerGroup.headers as header (header.id)}
							<th
								class="px-3 py-2.5 {header.column.getCanSort() ? 'cursor-pointer select-none' : ''} {header.id === 'select' ? 'w-10' : ''} {header.id === 'problemPreview' ? 'min-w-[280px]' : ''}"
								onclick={header.id !== 'select'
									? header.column.getToggleSortingHandler()
									: undefined}
							>
								{#if header.id === 'select'}
									<input
										type="checkbox"
										checked={table.getIsAllPageRowsSelected()}
										indeterminate={table.getIsSomePageRowsSelected() &&
											!table.getIsAllPageRowsSelected()}
										onchange={table.getToggleAllPageRowsSelectedHandler()}
										class="h-3.5 w-3.5 rounded border-border accent-primary"
										aria-label="Select all on page"
									/>
								{:else}
									<div class="flex items-center gap-1">
										{#if !header.isPlaceholder}
											<FlexRender {header} />
										{/if}
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
					<tr class="border-b border-border last:border-b-0 hover:bg-muted/30">
						{#each row.getAllCells() as cell (cell.id)}
							{#if cell.column.getIsVisible()}
								<td class="px-3 py-2 align-middle">
									{#if cell.column.id === 'select'}
										<input
											type="checkbox"
											checked={row.getIsSelected()}
											onchange={row.getToggleSelectedHandler()}
											class="h-3.5 w-3.5 rounded border-border accent-primary"
											aria-label="Select {row.original.instanceId}"
										/>
									{:else if cell.column.id === 'instanceId'}
										<button
											type="button"
											onclick={() =>
												onInstanceClick({
													instanceId: row.original.instanceId,
													suiteSlug: row.original.suiteSlug
												})}
											class="font-mono text-xs text-foreground hover:text-primary hover:underline inline-flex items-center gap-1"
										>
											<span class="truncate max-w-[260px]">{row.original.instanceId}</span>
											<ExternalLink class="h-3 w-3 opacity-40" />
										</button>
									{:else if cell.column.id === 'suiteSlug'}
										<Badge
											variant={row.original.suiteSlug === 'SWE-bench_Verified'
												? 'default'
												: 'secondary'}
											class="font-medium text-[10px]"
										>
											{suiteShortLabel(row.original.suiteSlug)}
										</Badge>
									{:else if cell.column.id === 'repo'}
										<span class="font-mono text-xs text-muted-foreground">{row.original.repo ?? '—'}</span>
									{:else if cell.column.id === 'problemPreview'}
										<span class="text-xs text-muted-foreground line-clamp-1">{row.original.problemPreview}</span>
									{:else if cell.column.id === 'failToPassCount'}
										<span class="font-mono text-xs tabular-nums">{row.original.failToPassCount}</span>
									{:else if cell.column.id === 'passToPassCount'}
										<span class="font-mono text-xs tabular-nums text-muted-foreground">{row.original.passToPassCount}</span>
									{:else if cell.column.id === 'hasGoldPatch'}
										{#if row.original.hasGoldPatch}
											<Check class="h-3.5 w-3.5 text-emerald-500" aria-label="Has gold patch" />
										{:else}
											<span class="text-xs text-muted-foreground">—</span>
										{/if}
									{:else if cell.column.id === 'baseCommit'}
										<span class="font-mono text-[11px] text-muted-foreground">{row.original.baseCommit ?? '—'}</span>
									{:else if cell.column.id === 'version'}
										<span class="font-mono text-[11px] text-muted-foreground">{row.original.version ?? '—'}</span>
									{:else if cell.column.id === 'hintsLen'}
										<span class="font-mono text-xs tabular-nums text-muted-foreground">
											{row.original.hintsLen > 0 ? row.original.hintsLen : '—'}
										</span>
									{:else if cell.column.id === 'testPatchLines'}
										<span class="font-mono text-xs tabular-nums text-muted-foreground">
											{row.original.testPatchLines > 0 ? row.original.testPatchLines : '—'}
										</span>
									{:else}
										<FlexRender {cell} />
									{/if}
								</td>
							{/if}
						{/each}
					</tr>
				{:else}
					<tr>
						<td colspan={columns.length} class="px-4 py-12 text-center">
							{#if instances.length === 0}
								<div class="flex flex-col items-center gap-2 text-sm text-muted-foreground">
									<span>No SWE-bench instances imported yet.</span>
									<code class="text-[11px] rounded bg-muted px-2 py-1 font-mono">
										pnpm tsx scripts/import-swebench-benchmark-instances.ts --suite all --apply
									</code>
								</div>
							{:else}
								<div class="flex flex-col items-center gap-2 text-sm text-muted-foreground">
									<span>No instances match the current filter.</span>
									<Button variant="outline" size="sm" onclick={clearAllFilters}>
										Clear filters
									</Button>
								</div>
							{/if}
						</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</div>

	<!-- Pagination -->
	<div class="flex items-center justify-between gap-3 text-xs text-muted-foreground">
		<div class="flex items-center gap-2">
			<span class="tabular-nums">
				{filteredRowCount} {filteredRowCount === 1 ? 'instance' : 'instances'}
				{#if filteredRowCount !== instances.length}
					· of {instances.length} total
				{/if}
			</span>
			<div class="ml-2 inline-flex items-center gap-1">
				<span class="text-[11px]">Per page:</span>
				<select
					bind:value={pageSize}
					onchange={() => {
						table?.setPageSize(pageSize);
						pageIndex = 0;
						table?.setPageIndex(0);
					}}
					class="h-6 rounded border border-border bg-background px-1 text-xs"
				>
					<option value={20}>20</option>
					<option value={50}>50</option>
					<option value={100}>100</option>
				</select>
			</div>
		</div>
		{#if table.getPageCount() > 1}
			<div class="flex items-center gap-1">
				<Button
					variant="outline"
					size="icon"
					class="h-7 w-7"
					onclick={() => {
						table.firstPage();
						pageIndex = 0;
					}}
					disabled={!table.getCanPreviousPage()}
					aria-label="First page"
				>
					<ChevronsLeft class="h-3.5 w-3.5" />
				</Button>
				<Button
					variant="outline"
					size="icon"
					class="h-7 w-7"
					onclick={() => {
						table.previousPage();
						pageIndex = table.state.pagination.pageIndex;
					}}
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
					onclick={() => {
						table.nextPage();
						pageIndex = table.state.pagination.pageIndex;
					}}
					disabled={!table.getCanNextPage()}
					aria-label="Next page"
				>
					<ChevronRight class="h-3.5 w-3.5" />
				</Button>
				<Button
					variant="outline"
					size="icon"
					class="h-7 w-7"
					onclick={() => {
						table.lastPage();
						pageIndex = table.state.pagination.pageIndex;
					}}
					disabled={!table.getCanNextPage()}
					aria-label="Last page"
				>
					<ChevronsRight class="h-3.5 w-3.5" />
				</Button>
			</div>
		{/if}
	</div>
</div>
