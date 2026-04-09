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
		filterFns,
		renderComponent,
		renderSnippet
	} from '@tanstack/svelte-table';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import * as AlertDialog from '$lib/components/ui/alert-dialog';
	import {
		Container,
		Plus,
		Trash2,
		ExternalLink,
		Loader2,
		ArrowUpDown,
		ArrowUp,
		ArrowDown,
		ChevronLeft,
		ChevronRight,
		ChevronsLeft,
		ChevronsRight,
		Search,
		RefreshCw,
		X
	} from 'lucide-svelte';
	import { createSandboxListStream } from '$lib/stores/sandbox-stream.svelte';
	import SandboxPhaseBadge from '$lib/components/sandbox/sandbox-phase-badge.svelte';
	import SandboxPreviewPopover from '$lib/components/sandbox/sandbox-preview-popover.svelte';
	import CreateSandboxDialog from '$lib/components/sandbox/create-sandbox-dialog.svelte';
	import { getSandboxes } from './data.remote';
	import type { Sandbox, SandboxPhase } from '$lib/types/sandbox';

	// -- Data sources --
	const stream = createSandboxListStream();
	const sandboxQuery = getSandboxes();

	// Use SSE stream data when actively streaming, otherwise remote function query
	const data = $derived(stream.isStreaming ? stream.sandboxes : (sandboxQuery.current ?? []));

	let createOpen = $state(false);
	let deleting = $state<string | null>(null);
	let globalFilter = $state('');
	let batchDeleteOpen = $state(false);
	let batchDeleting = $state(false);

	// -- TanStack Table setup --
	const _features = tableFeatures({
		rowSortingFeature,
		rowSelectionFeature,
		columnFilteringFeature,
		globalFilteringFeature,
		rowPaginationFeature
	});

	const columnHelper = createColumnHelper<typeof _features, Sandbox>();

	const columns = columnHelper.columns([
		columnHelper.display({
			id: 'select',
			header: () => '',
			cell: () => '',
			enableSorting: false
		}),
		columnHelper.accessor('name', {
			header: 'Name',
			cell: (info) => info.getValue(),
			enableSorting: true,
			enableColumnFilter: true
		}),
		columnHelper.accessor('type', {
			header: 'Type',
			cell: (info) => info.getValue() ?? 'openshell',
			enableSorting: true
		}),
		columnHelper.accessor('phase', {
			header: 'Phase',
			cell: (info) => info.getValue(),
			enableSorting: true,
			enableColumnFilter: true
		}),
		columnHelper.accessor(
			(row) => {
				if (!row.createdAt) return 0;
				return Date.now() - new Date(row.createdAt).getTime();
			},
			{
				id: 'age',
				header: 'Age',
				cell: (info) => {
					const ms = info.getValue() as number;
					if (!ms || ms < 0) return '-';
					const mins = Math.floor(ms / 60000);
					if (mins < 1) return 'just now';
					if (mins < 60) return `${mins}m`;
					const hrs = Math.floor(mins / 60);
					if (hrs < 24) return `${hrs}h ${mins % 60}m`;
					const days = Math.floor(hrs / 24);
					return `${days}d ${hrs % 24}h`;
				},
				enableSorting: true
			}
		),
		columnHelper.display({
			id: 'actions',
			header: 'Actions',
			cell: (info) => {
				const name = info.row.original.name;
				return name;
			}
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
			getRowId: (row) => row.name,
			get data() {
				return data;
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
			initialState: {
				pagination: { pageIndex: 0, pageSize: 20 },
				sorting: [{ id: 'age', desc: false }]
			}
		},
		(state) => state
	);

	const selectedCount = $derived(
		table ? Object.keys(table.state?.rowSelection ?? {}).length : 0
	);

	const selectedNames = $derived.by(() => {
		if (!table) return [];
		return Object.keys(table.state?.rowSelection ?? {});
	});

	async function deleteSandbox(name: string) {
		deleting = name;
		try {
			await fetch(`/api/sandboxes/${encodeURIComponent(name)}`, { method: 'DELETE' });
			sandboxQuery.refresh();
		} catch {
			// ignore
		} finally {
			deleting = null;
		}
	}

	async function batchDelete() {
		batchDeleting = true;
		try {
			await Promise.allSettled(
				selectedNames.map((name) =>
					fetch(`/api/sandboxes/${encodeURIComponent(name)}`, { method: 'DELETE' })
				)
			);
			table.resetRowSelection();
			sandboxQuery.refresh();
		} catch {
			// ignore
		} finally {
			batchDeleting = false;
			batchDeleteOpen = false;
		}
	}
</script>

{#snippet nameCell(name: string)}
	<a
		href="/sandboxes/{encodeURIComponent(name)}"
		class="font-mono text-sm font-medium text-foreground hover:underline"
	>
		{name}
	</a>
{/snippet}

{#snippet typeCell(type: string)}
	<Badge variant="outline" class="text-xs">{type}</Badge>
{/snippet}

{#snippet phaseCell(phase: SandboxPhase)}
	<SandboxPhaseBadge {phase} />
{/snippet}

{#snippet actionsCell(name: string)}
	<div class="flex items-center justify-end gap-1">
		<Button variant="ghost" size="icon" class="h-7 w-7" href="/sandboxes/{encodeURIComponent(name)}">
			<ExternalLink class="h-3.5 w-3.5" />
		</Button>
		<Button
			variant="ghost"
			size="icon"
			class="h-7 w-7 text-destructive hover:text-destructive"
			onclick={() => deleteSandbox(name)}
			disabled={deleting === name}
		>
			{#if deleting === name}
				<Loader2 class="h-3.5 w-3.5 animate-spin" />
			{:else}
				<Trash2 class="h-3.5 w-3.5" />
			{/if}
		</Button>
	</div>
{/snippet}

<div class="flex h-full flex-col">
	<header class="flex h-12 items-center justify-between border-b border-border px-6">
		<div class="flex items-center gap-3">
			<h1 class="text-sm font-semibold tracking-tight">Sandboxes</h1>
			<div
				class="h-2 w-2 rounded-full {stream.isConnected ? 'bg-green-500' : 'bg-red-500'}"
				title={stream.isConnected ? 'Connected' : 'Disconnected'}
			></div>
		</div>
		<div class="flex items-center gap-2">
			<!-- Global search -->
			<div class="relative">
				<Search class="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
				<input
					type="text"
					placeholder="Search sandboxes..."
					bind:value={globalFilter}
					class="h-8 rounded-md border border-border bg-background pl-8 pr-8 text-xs outline-none focus:ring-1 focus:ring-ring"
				/>
				{#if globalFilter}
					<button
						onclick={() => (globalFilter = '')}
						class="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
					>
						<X class="h-3.5 w-3.5" />
					</button>
				{/if}
			</div>

			<Button variant="outline" size="icon" class="h-8 w-8" onclick={() => sandboxQuery.refresh()}>
				<RefreshCw class="h-3.5 w-3.5" />
			</Button>

			<Button size="sm" onclick={() => (createOpen = true)}>
				<Plus class="mr-1 h-4 w-4" />
				New Sandbox
			</Button>
		</div>
	</header>

	<div class="flex flex-1 flex-col overflow-auto p-6">
		<svelte:boundary>
		{#if sandboxQuery.loading && !sandboxQuery.current && !stream.isStreaming}
			<div class="flex flex-col items-center justify-center py-12 gap-2">
				<Loader2 class="h-6 w-6 animate-spin text-muted-foreground" />
				<p class="text-sm text-muted-foreground">Loading sandboxes...</p>
			</div>
		{:else if data.length === 0 && !globalFilter}
			<div class="flex flex-col items-center justify-center py-16 text-center">
				<Container class="mb-4 h-12 w-12 text-muted-foreground/50" />
				<h2 class="text-lg font-medium text-foreground">No sandboxes</h2>
				<p class="mt-1 text-sm text-muted-foreground">
					Create a sandbox to get started, or wait for an agent run to provision one.
				</p>
			</div>
		{:else}
			<!-- Bulk action bar -->
			{#if selectedCount > 0}
				<div class="mb-3 flex items-center gap-3 rounded-md border border-border bg-muted/50 px-4 py-2">
					<span class="text-sm font-medium">{selectedCount} selected</span>
					<Button variant="outline" size="sm" class="text-xs" onclick={() => table.resetRowSelection()}>
						Deselect All
					</Button>
					<Button
						variant="destructive"
						size="sm"
						class="text-xs"
						onclick={() => (batchDeleteOpen = true)}
					>
						<Trash2 class="mr-1 h-3 w-3" />
						Delete Selected
					</Button>
				</div>
			{/if}

			<div class="rounded-md border border-border">
				<table class="w-full">
					<thead>
						{#each table.getHeaderGroups() as headerGroup}
							<tr class="border-b border-border bg-muted/50 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">
								{#each headerGroup.headers as header}
									<th
										class="px-4 py-3 {header.column.getCanSort() ? 'cursor-pointer select-none' : ''} {header.id === 'actions' ? 'text-right' : ''} {header.id === 'select' ? 'w-10' : ''}"
										onclick={header.id !== 'select' ? header.column.getToggleSortingHandler() : undefined}
									>
										{#if header.id === 'select'}
										<input
											type="checkbox"
											checked={table.getIsAllPageRowsSelected()}
											onchange={table.getToggleAllPageRowsSelectedHandler()}
											class="h-3.5 w-3.5 rounded border-border accent-primary"
										/>
									{:else}
										<div class="flex items-center gap-1 {header.id === 'actions' ? 'justify-end' : ''}">
											{#if !header.isPlaceholder}
												<FlexRender {header} />
											{/if}
											{#if header.column.getCanSort()}
												{#if header.column.getIsSorted() === 'asc'}
													<ArrowUp class="h-3 w-3" />
												{:else if header.column.getIsSorted() === 'desc'}
													<ArrowDown class="h-3 w-3" />
												{:else}
													<ArrowUpDown class="h-3 w-3 opacity-40" />
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
						{#each table.getRowModel().rows as row}
							<tr class="border-b border-border last:border-b-0 hover:bg-muted/30">
								{#each row.getAllCells() as cell}
									<td class="px-4 py-3 {cell.column.id === 'actions' ? 'text-right' : ''} {cell.column.id === 'select' ? 'w-10' : ''}">
										{#if cell.column.id === 'select'}
											<input
												type="checkbox"
												checked={row.getIsSelected()}
												onchange={row.getToggleSelectedHandler()}
												class="h-3.5 w-3.5 rounded border-border accent-primary"
											/>
										{:else if cell.column.id === 'name'}
											<SandboxPreviewPopover sandbox={row.original}>
												{@render nameCell(cell.getValue() as string)}
											</SandboxPreviewPopover>
										{:else if cell.column.id === 'type'}
											{@render typeCell(cell.getValue() as string)}
										{:else if cell.column.id === 'phase'}
											{@render phaseCell(cell.getValue() as SandboxPhase)}
										{:else if cell.column.id === 'actions'}
											{@render actionsCell(row.original.name)}
										{:else}
											<span class="text-sm text-muted-foreground">
												<FlexRender {cell} />
											</span>
										{/if}
									</td>
								{/each}
							</tr>
						{:else}
							<tr>
								<td colspan={columns.length} class="px-4 py-8 text-center text-sm text-muted-foreground">
									No sandboxes match your search.
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>

			<!-- Pagination -->
			{#if table.getPageCount() > 1}
				<div class="mt-4 flex items-center justify-between text-sm text-muted-foreground">
					<span>
						{table.getRowCount()} sandbox{table.getRowCount() === 1 ? '' : 'es'}
					</span>
					<div class="flex items-center gap-1">
						<Button
							variant="outline"
							size="icon"
							class="h-7 w-7"
							onclick={() => table.firstPage()}
							disabled={!table.getCanPreviousPage()}
						>
							<ChevronsLeft class="h-3.5 w-3.5" />
						</Button>
						<Button
							variant="outline"
							size="icon"
							class="h-7 w-7"
							onclick={() => table.previousPage()}
							disabled={!table.getCanPreviousPage()}
						>
							<ChevronLeft class="h-3.5 w-3.5" />
						</Button>
						<span class="px-2 text-xs">
							Page {table.state.pagination.pageIndex + 1} of {table.getPageCount()}
						</span>
						<Button
							variant="outline"
							size="icon"
							class="h-7 w-7"
							onclick={() => table.nextPage()}
							disabled={!table.getCanNextPage()}
						>
							<ChevronRight class="h-3.5 w-3.5" />
						</Button>
						<Button
							variant="outline"
							size="icon"
							class="h-7 w-7"
							onclick={() => table.lastPage()}
							disabled={!table.getCanNextPage()}
						>
							<ChevronsRight class="h-3.5 w-3.5" />
						</Button>
					</div>
				</div>
			{/if}
		{/if}

		{#snippet failed(error, reset)}
			<div class="flex flex-col items-center justify-center py-16 text-center">
				<Container class="mb-4 h-12 w-12 text-destructive/50" />
				<h2 class="text-lg font-medium text-foreground">Something went wrong</h2>
				<p class="mt-1 text-sm text-muted-foreground">
					{(error as Error)?.message ?? 'Failed to load sandboxes.'}
				</p>
				<Button variant="outline" size="sm" class="mt-4" onclick={reset}>
					Try again
				</Button>
			</div>
		{/snippet}
		</svelte:boundary>
	</div>
</div>

<CreateSandboxDialog
	bind:open={createOpen}
	onOpenChange={(v) => (createOpen = v)}
	onCreated={() => sandboxQuery.refresh()}
/>

<AlertDialog.Root bind:open={batchDeleteOpen}>
	<AlertDialog.Content>
		<AlertDialog.Header>
			<AlertDialog.Title>Delete {selectedCount} sandbox{selectedCount === 1 ? '' : 'es'}?</AlertDialog.Title>
			<AlertDialog.Description>
				This will permanently delete the selected sandboxes. This action cannot be undone.
			</AlertDialog.Description>
		</AlertDialog.Header>
		<AlertDialog.Footer>
			<AlertDialog.Cancel>Cancel</AlertDialog.Cancel>
			<AlertDialog.Action onclick={batchDelete} disabled={batchDeleting}>
				{#if batchDeleting}
					<Loader2 class="mr-2 h-4 w-4 animate-spin" />
				{/if}
				Delete {selectedCount}
			</AlertDialog.Action>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>
