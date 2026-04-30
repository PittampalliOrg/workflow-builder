<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { onDestroy, onMount } from 'svelte';
	import { Alert, AlertDescription } from '$lib/components/ui/alert';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Activity, ExternalLink, Search, Workflow as WorkflowIcon, X } from '@lucide/svelte';
	import AppBreadcrumb from '$lib/components/console/app-breadcrumb.svelte';
	import CopyIdButton from '$lib/components/console/copy-id-button.svelte';
	import ResourceTable from '$lib/components/console/resource-table.svelte';

	type RunStatus = 'all' | 'pending' | 'running' | 'success' | 'error' | 'cancelled';
	type Created = 'all' | '7d' | '30d' | '90d';

	type RunAgent = { id: string; name: string; avatar: string | null; slug: string | null };
	// `id` alias matches ResourceTable's `{ id: string }` constraint; the
	// real value is the execution id. `executionId` kept for readability
	// in the row snippet.
	type RunRow = {
		id: string;
		executionId: string;
		workflowId: string;
		workflowName: string;
		status: Exclude<RunStatus, 'all'>;
		startedAt: string;
		completedAt: string | null;
		durationMs: number | null;
		sessionCount: number;
		agents: RunAgent[];
	};
	type WorkflowOption = { id: string; name: string };

	const slug = $derived((page.params.slug as string) ?? 'default');

	// URL-bound filter state.
	const url = page.url;
	let statusFilter = $state<RunStatus>((url.searchParams.get('status') as RunStatus) ?? 'all');
	let workflowIdFilter = $state<string>(url.searchParams.get('workflowId') ?? '');
	let created = $state<Created>((url.searchParams.get('created') as Created) ?? '30d');
	let searchText = $state<string>(url.searchParams.get('q') ?? '');

	let runs = $state<RunRow[]>([]);
	let workflows = $state<WorkflowOption[]>([]);
	let loading = $state(true);
	let errorMessage = $state<string | null>(null);

	const hasActiveRuns = $derived(
		runs.some((r) => r.status === 'running' || r.status === 'pending')
	);
	const ACTIVE_POLL_MS = 3_000;
	const IDLE_POLL_MS = 30_000;
	let pollTimer: ReturnType<typeof setTimeout> | null = null;

	function sinceFromRange(range: Created): Date | null {
		if (range === 'all') return null;
		const now = Date.now();
		const days = range === '7d' ? 7 : range === '30d' ? 30 : 90;
		return new Date(now - days * 86_400_000);
	}

	$effect(() => {
		const next = new URLSearchParams();
		if (statusFilter !== 'all') next.set('status', statusFilter);
		if (workflowIdFilter) next.set('workflowId', workflowIdFilter);
		if (created !== '30d') next.set('created', created);
		if (searchText.trim()) next.set('q', searchText.trim());
		const qs = next.toString();
		const href = qs ? `?${qs}` : page.url.pathname;
		if (typeof window !== 'undefined' && window.location.search !== (qs ? `?${qs}` : '')) {
			window.history.replaceState(window.history.state, '', href);
		}
	});

	async function load(opts: { silent?: boolean } = {}) {
		if (!opts.silent) {
			loading = true;
			errorMessage = null;
		}
		try {
			const qs = new URLSearchParams();
			if (statusFilter !== 'all') qs.set('status', statusFilter);
			if (workflowIdFilter) qs.set('workflowId', workflowIdFilter);
			const since = sinceFromRange(created);
			if (since) qs.set('since', since.toISOString());
			if (searchText.trim().length >= 2) qs.set('q', searchText.trim());
			const res = await fetch(`/api/v1/runs?${qs}`);
			if (!res.ok) {
				if (!opts.silent) errorMessage = `Failed to load runs (${res.status})`;
				return;
			}
			const body = (await res.json()) as { runs: Omit<RunRow, 'id'>[] };
			runs = (body.runs ?? []).map((r) => ({ ...r, id: r.executionId }));
		} catch (err) {
			if (!opts.silent) errorMessage = err instanceof Error ? err.message : String(err);
		} finally {
			if (!opts.silent) loading = false;
		}
	}

	async function loadWorkflows() {
		try {
			const res = await fetch('/api/workflows');
			if (!res.ok) return;
			const body = (await res.json()) as Array<{ id: string; name: string | null }>;
			workflows = body
				.map((w) => ({ id: w.id, name: w.name || w.id }))
				.sort((a, b) => a.name.localeCompare(b.name));
		} catch {
			// best effort — dropdown just stays empty
		}
	}

	function schedulePoll() {
		if (pollTimer) clearTimeout(pollTimer);
		const delay = hasActiveRuns ? ACTIVE_POLL_MS : IDLE_POLL_MS;
		pollTimer = setTimeout(async () => {
			if (typeof document === 'undefined' || document.visibilityState === 'visible') {
				await load({ silent: true });
			}
			schedulePoll();
		}, delay);
	}

	// Server-visible filter changes re-fetch. Text search <2 chars is a no-op in the API.
	$effect(() => {
		void statusFilter;
		void workflowIdFilter;
		void created;
		void searchText;
		void load();
	});

	onMount(async () => {
		await Promise.all([load(), loadWorkflows()]);
		schedulePoll();
	});

	onDestroy(() => {
		if (pollTimer) clearTimeout(pollTimer);
	});

	function clearFilters() {
		statusFilter = 'all';
		workflowIdFilter = '';
		created = '30d';
		searchText = '';
	}

	const hasActiveFilter = $derived(
		statusFilter !== 'all' ||
			workflowIdFilter !== '' ||
			created !== '30d' ||
			searchText.trim() !== ''
	);

	function statusColor(status: RunRow['status']): string {
		switch (status) {
			case 'running':
				return 'bg-blue-500/15 text-blue-600';
			case 'pending':
				return 'bg-amber-500/15 text-amber-600';
			case 'success':
				return 'bg-emerald-500/15 text-emerald-600';
			case 'error':
				return 'bg-red-500/15 text-red-600';
			case 'cancelled':
				return 'bg-gray-400/15 text-gray-600';
			default:
				return 'bg-muted text-muted-foreground';
		}
	}

	function formatRelative(iso: string): string {
		const diff = Date.now() - new Date(iso).getTime();
		if (diff < 60_000) return 'just now';
		if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
		if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
		if (diff < 30 * 86_400_000) return `${Math.floor(diff / 86_400_000)}d ago`;
		return new Date(iso).toLocaleDateString();
	}

	function formatDuration(r: RunRow): string {
		// For still-running executions, show wall-clock since start.
		let ms: number | null = r.durationMs;
		if (ms === null) {
			if (r.status === 'running' || r.status === 'pending') {
				ms = Date.now() - new Date(r.startedAt).getTime();
			} else {
				return '—';
			}
		}
		if (ms < 1000) return `${ms}ms`;
		if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
		const m = Math.floor(ms / 60_000);
		const s = Math.floor((ms % 60_000) / 1000);
		if (m < 60) return s ? `${m}m ${s}s` : `${m}m`;
		const h = Math.floor(m / 60);
		const rest = m % 60;
		return rest ? `${h}h ${rest}m` : `${h}h`;
	}
</script>

<svelte:head><title>Runs</title></svelte:head>

<div class="p-6 space-y-5 max-w-7xl mx-auto w-full">
	<AppBreadcrumb
		items={[
			{ label: 'Workspace', href: `/workspaces/${slug}` },
			{ label: 'Runs' }
		]}
	/>

	<header class="flex items-start justify-between gap-4 flex-wrap">
		<div>
			<h1 class="text-2xl font-semibold flex items-center gap-2">
				<Activity class="size-6" /> Runs
			</h1>
			<p class="text-sm text-muted-foreground mt-1">
				Workflow executions across every workflow in this workspace. Click a run to open its
				cockpit.
			</p>
			{#if runs.length > 0}
				<div class="flex items-center gap-2 mt-2 text-xs text-muted-foreground">
					<span>{runs.length} total</span>
					{#if hasActiveRuns}
						<span class="text-muted-foreground/40">·</span>
						<span class="text-blue-600 inline-flex items-center gap-1">
							<span class="size-1.5 rounded-full bg-blue-500 animate-pulse"></span>
							{runs.filter((r) => r.status === 'running' || r.status === 'pending').length}
							active
						</span>
					{/if}
				</div>
			{/if}
		</div>
	</header>

	{#if errorMessage}
		<Alert variant="destructive">
			<AlertDescription>{errorMessage}</AlertDescription>
		</Alert>
	{/if}

	<div class="flex items-center gap-2 flex-wrap">
		<div class="relative flex-1 min-w-[240px] max-w-md">
			<Search class="size-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
			<Input
				class="pl-9 pr-3 h-9"
				placeholder="Search workflow name or execution ID"
				bind:value={searchText}
			/>
		</div>
		<div class="flex items-center gap-2 h-9 rounded-md border px-3">
			<span class="text-xs text-muted-foreground">Workflow</span>
			<select
				class="bg-transparent text-sm focus:outline-none max-w-[200px]"
				bind:value={workflowIdFilter}
			>
				<option value="">All workflows</option>
				{#each workflows as w (w.id)}
					<option value={w.id}>{w.name}</option>
				{/each}
			</select>
		</div>
		<div class="flex items-center gap-2 h-9 rounded-md border px-3">
			<span class="text-xs text-muted-foreground">Status</span>
			<select class="bg-transparent text-sm focus:outline-none" bind:value={statusFilter}>
				<option value="all">All</option>
				<option value="running">Running</option>
				<option value="pending">Pending</option>
				<option value="success">Success</option>
				<option value="error">Error</option>
				<option value="cancelled">Cancelled</option>
			</select>
		</div>
		<div class="flex items-center gap-2 h-9 rounded-md border px-3">
			<span class="text-xs text-muted-foreground">Started</span>
			<select class="bg-transparent text-sm focus:outline-none" bind:value={created}>
				<option value="7d">Past 7 days</option>
				<option value="30d">Past 30 days</option>
				<option value="90d">Past 90 days</option>
				<option value="all">All time</option>
			</select>
		</div>
		{#if hasActiveFilter}
			<Button variant="ghost" size="sm" class="h-9 gap-1" onclick={clearFilters}>
				<X class="size-3" /> Clear
			</Button>
		{/if}
		{#if hasActiveRuns}
			<Badge variant="outline" class="text-[10px] gap-1">
				<span class="size-1.5 rounded-full bg-blue-500 animate-pulse"></span>
				Live · 3s
			</Badge>
		{/if}
	</div>

	<ResourceTable
		rows={runs}
		{loading}
		onRowClick={(r: RunRow) =>
			goto(`/workspaces/${slug}/workflows/${r.workflowId}/runs/${r.executionId}`)}
	>
		{#snippet header()}
			<th class="px-4 py-2.5 font-medium">Execution</th>
			<th class="px-4 py-2.5 font-medium">Workflow</th>
			<th class="px-4 py-2.5 font-medium">Status</th>
			<th class="px-4 py-2.5 font-medium">Started</th>
			<th class="px-4 py-2.5 font-medium">Duration</th>
			<th class="px-4 py-2.5 font-medium">Agents</th>
			<th class="px-4 py-2.5 font-medium">Sessions</th>
			<th class="px-4 py-2.5 font-medium w-10"></th>
		{/snippet}
		{#snippet row(r: RunRow)}
			<td class="px-4 py-2.5">
				<CopyIdButton value={r.executionId} />
			</td>
			<td class="px-4 py-2.5">
				<a
					href={`/workspaces/${slug}/workflows/${r.workflowId}`}
					onclick={(e) => e.stopPropagation()}
					class="inline-flex items-center gap-1 text-xs hover:underline text-foreground"
					title={r.workflowName}
				>
					<WorkflowIcon class="size-3 text-muted-foreground" />
					<span class="truncate max-w-[220px]">{r.workflowName}</span>
				</a>
			</td>
			<td class="px-4 py-2.5">
				<span class="rounded-full px-2 py-0.5 text-[10px] font-medium {statusColor(r.status)}">
					{r.status}
				</span>
			</td>
			<td class="px-4 py-2.5 text-xs text-muted-foreground" title={r.startedAt}>
				{formatRelative(r.startedAt)}
			</td>
			<td class="px-4 py-2.5 text-xs tabular-nums">{formatDuration(r)}</td>
			<td class="px-4 py-2.5">
				{#if r.agents.length === 0}
					<span class="text-[11px] text-muted-foreground">—</span>
				{:else}
					<div class="flex items-center gap-1 flex-wrap">
						{#each r.agents.slice(0, 3) as a (a.id)}
							<Badge variant="outline" class="text-[10px] gap-1" title={a.name}>
								<span>{a.avatar ?? '🤖'}</span>
								<span class="truncate max-w-[100px]">{a.name}</span>
							</Badge>
						{/each}
						{#if r.agents.length > 3}
							<span class="text-[10px] text-muted-foreground">+{r.agents.length - 3}</span>
						{/if}
					</div>
				{/if}
			</td>
			<td class="px-4 py-2.5">
				{#if r.sessionCount === 0}
					<span class="text-[11px] text-muted-foreground">—</span>
				{:else}
					<a
						href={`/workspaces/${slug}/sessions?executionId=${r.executionId}`}
						onclick={(e) => e.stopPropagation()}
						class="inline-flex items-center gap-1 text-xs hover:underline"
						title={`${r.sessionCount} session${r.sessionCount === 1 ? '' : 's'} spawned by this run`}
					>
						{r.sessionCount}
						<ExternalLink class="size-2.5 text-muted-foreground" />
					</a>
				{/if}
			</td>
			<td class="px-4 py-2.5 text-right">
				<span class="text-muted-foreground text-[10px]">→</span>
			</td>
		{/snippet}
	</ResourceTable>

	{#if !loading && runs.length === 0 && !hasActiveFilter}
		<div
			class="rounded-lg border border-dashed p-12 text-center text-sm text-muted-foreground"
		>
			No workflow runs yet. Open a workflow in the editor and submit a run to see it here.
		</div>
	{:else if !loading && runs.length === 0 && hasActiveFilter}
		<div
			class="rounded-lg border border-dashed p-12 text-center text-sm text-muted-foreground"
		>
			No runs match the current filters.
		</div>
	{/if}
</div>
