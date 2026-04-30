<script lang="ts">
	import { Grid2X2, List, RefreshCw, Search, Workflow } from '@lucide/svelte';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import {
		Table,
		TableBody,
		TableCell,
		TableHead,
		TableHeader,
		TableRow
	} from '$lib/components/ui/table';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
	let search = $state('');
	let viewMode = $state<'list' | 'grid'>('list');

	const workflows = $derived(
		data.overview.workflowTypes.filter((workflowType) => {
			const needle = search.trim().toLowerCase();
			if (!needle) return true;
			return `${workflowType.name} ${workflowType.appId}`.toLowerCase().includes(needle);
		})
	);

	function workflowHref(appId: string, name: string): string {
		return `/admin/instances/names/${encodeURIComponent(appId)}/${encodeURIComponent(name)}`;
	}

	function formatTime(value: string | null | undefined): string {
		if (!value) return '-';
		return new Date(value).toLocaleString('en-US', {
			month: 'short',
			day: 'numeric',
			hour: '2-digit',
			minute: '2-digit'
		});
	}

	function statusSegments(counts: PageData['overview']['workflowTypes'][number]['statusCounts']) {
		return [
			{ label: 'Running', value: counts.running + counts.pending, class: 'bg-blue-500' },
			{ label: 'Suspended', value: counts.suspended, class: 'bg-amber-500' },
			{ label: 'Success', value: counts.completed, class: 'bg-emerald-500' },
			{ label: 'Failed', value: counts.failed + counts.terminated, class: 'bg-red-500' },
			{ label: 'Unknown', value: counts.unknown, class: 'bg-muted-foreground' }
		].filter((segment) => segment.value > 0);
	}
</script>

<div class="flex h-full flex-col">
	<header class="flex h-12 items-center justify-between border-b border-border px-6">
		<div class="flex items-center gap-2">
			<Workflow size={16} class="text-muted-foreground" />
			<h1 class="text-sm font-semibold tracking-tight">Workflows</h1>
			<span class="text-xs text-muted-foreground">Project workflow store: Dapr</span>
		</div>
		<div class="flex items-center gap-2">
			<Button variant="outline" size="sm" href="/admin/instances">All workflow executions</Button>
			<Button variant="outline" size="icon" onclick={() => location.reload()}>
				<RefreshCw size={14} />
			</Button>
		</div>
	</header>

	<div class="flex-1 overflow-auto p-6">
		<div class="mb-5 flex border-b border-border">
			<a href="/admin/instances/names" class="border-b-2 border-primary px-4 py-2 text-sm font-medium">Workflows</a>
			<a href="/admin/instances" class="px-4 py-2 text-sm text-muted-foreground hover:text-foreground">All workflow executions</a>
		</div>

		<div class="mb-4 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
			<label class="relative max-w-md flex-1">
				<span class="sr-only">Search</span>
				<Search size={14} class="absolute left-2.5 top-2.5 text-muted-foreground" />
				<Input class="pl-8" placeholder="Search" bind:value={search} />
			</label>
			<div class="flex items-center gap-2">
				<Button variant="outline" size="icon" aria-pressed={viewMode === 'list'} onclick={() => (viewMode = 'list')}>
					<List size={14} />
				</Button>
				<Button variant="outline" size="icon" aria-pressed={viewMode === 'grid'} onclick={() => (viewMode = 'grid')}>
					<Grid2X2 size={14} />
				</Button>
			</div>
		</div>

		{#if data.overview.orchestratorError}
			<div class="mb-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
				Dapr workflow runtime unavailable: {data.overview.orchestratorError}
			</div>
		{/if}

		{#if viewMode === 'grid'}
			<div class="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
				{#each workflows as workflowType (`${workflowType.appId}:${workflowType.name}`)}
					<a
						href={workflowHref(workflowType.appId, workflowType.name)}
						class="rounded-md border border-border bg-background p-4 text-left transition-colors hover:bg-muted/40"
					>
						<div class="flex items-start justify-between gap-3">
							<div class="min-w-0">
								<div class="truncate text-sm font-semibold">{workflowType.name}</div>
								<div class="mt-1 truncate font-mono text-xs text-muted-foreground">{workflowType.appId}</div>
							</div>
							<Badge variant="outline">{workflowType.totalExecutions}</Badge>
						</div>
						<div class="mt-4 h-2 overflow-hidden rounded bg-muted">
							{#each statusSegments(workflowType.statusCounts) as segment}
								<div class="{segment.class} inline-block h-full" style={`width: ${(segment.value / Math.max(1, workflowType.statusCounts.total)) * 100}%`}></div>
							{/each}
						</div>
						<div class="mt-3 text-xs text-muted-foreground">Latest start: {formatTime(workflowType.latestStartedAt)}</div>
					</a>
				{/each}
			</div>
		{:else}
			<div class="overflow-hidden rounded-md border border-border">
				<Table class="w-full">
					<TableHeader>
						<TableRow class="border-b border-border bg-muted/50">
							<TableHead class="px-4 py-3 text-left text-xs font-medium text-muted-foreground">Name</TableHead>
							<TableHead class="px-4 py-3 text-left text-xs font-medium text-muted-foreground">App ID</TableHead>
							<TableHead class="px-4 py-3 text-left text-xs font-medium text-muted-foreground">Total Executions</TableHead>
							<TableHead class="px-4 py-3 text-left text-xs font-medium text-muted-foreground">Execution Status Breakdown</TableHead>
							<TableHead class="px-4 py-3 text-left text-xs font-medium text-muted-foreground">Latest Start</TableHead>
						</TableRow>
					</TableHeader>
					<TableBody class="divide-y divide-border">
						{#if workflows.length === 0}
							<TableRow>
								<TableCell colspan={5} class="py-12 text-center text-sm text-muted-foreground">No workflows matched the current search.</TableCell>
							</TableRow>
						{:else}
							{#each workflows as workflowType (`${workflowType.appId}:${workflowType.name}`)}
								<TableRow class="transition-colors hover:bg-muted/30">
									<TableCell class="p-0 text-sm font-medium">
										<a class="block px-4 py-3 underline-offset-4 hover:underline" href={workflowHref(workflowType.appId, workflowType.name)}>{workflowType.name}</a>
									</TableCell>
									<TableCell class="p-0 font-mono text-xs text-muted-foreground">
										<a class="block px-4 py-3" href={workflowHref(workflowType.appId, workflowType.name)}>{workflowType.appId}</a>
									</TableCell>
									<TableCell class="p-0 text-sm">
										<a class="block px-4 py-3" href={workflowHref(workflowType.appId, workflowType.name)}>{workflowType.totalExecutions}</a>
									</TableCell>
									<TableCell class="p-0">
										<a class="block px-4 py-3" href={workflowHref(workflowType.appId, workflowType.name)}>
											<div class="flex max-w-sm overflow-hidden rounded bg-muted">
												{#each statusSegments(workflowType.statusCounts) as segment}
													<div
														class="{segment.class} h-2"
														title={`${segment.label}: ${segment.value}`}
														style={`width: ${(segment.value / Math.max(1, workflowType.statusCounts.total)) * 100}%`}
													></div>
												{/each}
											</div>
											<div class="mt-1 text-[11px] text-muted-foreground">
												{workflowType.statusCounts.completed} success, {workflowType.statusCounts.failed} failed, {workflowType.statusCounts.running} running
											</div>
										</a>
									</TableCell>
									<TableCell class="p-0 text-sm text-muted-foreground">
										<a class="block px-4 py-3" href={workflowHref(workflowType.appId, workflowType.name)}>{formatTime(workflowType.latestStartedAt)}</a>
									</TableCell>
								</TableRow>
							{/each}
						{/if}
					</TableBody>
				</Table>
			</div>
		{/if}

		<div class="mt-3 text-xs text-muted-foreground">Total Rows: {workflows.length}</div>
	</div>
</div>
