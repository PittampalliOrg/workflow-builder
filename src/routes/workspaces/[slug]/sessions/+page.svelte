<script lang="ts">
	import { goto } from '$app/navigation';
	import { onDestroy, onMount } from 'svelte';
	import { Alert, AlertDescription } from '$lib/components/ui/alert';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Switch } from '$lib/components/ui/switch';
	import { Label } from '$lib/components/ui/label';
	import {
		AlertCircle,
		ArrowRight,
		ExternalLink,
		MessagesSquare,
		Plus,
		Search,
		Workflow,
		X
	} from '@lucide/svelte';
	import CopyIdButton from '$lib/components/console/copy-id-button.svelte';
	import AppBreadcrumb from '$lib/components/console/app-breadcrumb.svelte';
	import ResourceTable from '$lib/components/console/resource-table.svelte';
	import RowMoreActions from '$lib/components/console/row-more-actions.svelte';
	import type { SessionStatus, SessionSummary } from '$lib/types/sessions';
	import type { AgentSummary } from '$lib/types/agents';
	import { page } from '$app/state';

	const slug = $derived((page.params.slug as string) ?? 'default');

	type StatusFilter = 'all' | SessionStatus;
	type SourceFilter = 'all' | 'direct' | 'workflow';
	type CreatedFilter = 'all' | '7d' | '30d' | '90d';

	let sessions = $state<SessionSummary[]>([]);
	let agents = $state<AgentSummary[]>([]);
	let loading = $state(true);
	let errorMessage = $state<string | null>(null);

	// Filters — initial state is read from the URL so links are shareable.
	const url = page.url;
	let statusFilter = $state<StatusFilter>(
		(url.searchParams.get('status') as StatusFilter) ?? 'all'
	);
	let agentFilter = $state<string>(url.searchParams.get('agentId') ?? 'all');
	let sourceFilter = $state<SourceFilter>(
		(url.searchParams.get('source') as SourceFilter) ?? 'all'
	);
	// Deep-link filters: workflow detail "Runs" tab links to /sessions?workflowId=X,
	// and the old /workflows/runs/[id] redirects here with ?executionId=Y. Both
	// pin the list to a specific upstream workflow/run.
	let workflowIdFilter = $state<string>(url.searchParams.get('workflowId') ?? '');
	let executionIdFilter = $state<string>(url.searchParams.get('executionId') ?? '');
	// Default to 30d so the list stays bounded as sessions accumulate. Users
	// can explicitly switch to "All time" to see older history.
	let created = $state<CreatedFilter>(
		(url.searchParams.get('created') as CreatedFilter) ?? '30d'
	);
	let searchText = $state<string>(url.searchParams.get('q') ?? '');
	let includeArchived = $state(url.searchParams.get('archived') === 'true');
	let jumpId = $state('');
	let busyId = $state<string | null>(null);

	const ACTIVE_POLL_MS = 3_000;
	const IDLE_POLL_MS = 30_000;
	let pollTimer: ReturnType<typeof setTimeout> | null = null;

	const agentsById = $derived.by(() => {
		const m = new Map<string, AgentSummary>();
		for (const a of agents) m.set(a.id, a);
		return m;
	});

	// Slug → whether that agent has a browser sidecar.
	let browserSidecarBySlug = $state<Record<string, boolean>>({});

	const filtered = $derived.by(() => {
		const now = Date.now();
		const cutoff =
			created === '7d'
				? now - 7 * 86_400_000
				: created === '30d'
					? now - 30 * 86_400_000
					: created === '90d'
						? now - 90 * 86_400_000
						: 0;
		const q = searchText.trim().toLowerCase();
		return sessions
			.filter((s) => {
				if (statusFilter !== 'all' && s.status !== statusFilter) return false;
				if (agentFilter !== 'all' && s.agentId !== agentFilter) return false;
				if (sourceFilter === 'direct' && s.workflowExecutionId) return false;
				if (sourceFilter === 'workflow' && !s.workflowExecutionId) return false;
				if (cutoff && new Date(s.createdAt).getTime() < cutoff) return false;
				if (!includeArchived && s.archivedAt) return false;
				if (q) {
					const hay = [
						s.title ?? '',
						s.id,
						s.workflowName ?? '',
						s.workflowExecutionId ?? '',
						s.agentName ?? '',
						s.agentSlug ?? ''
					]
						.join(' ')
						.toLowerCase();
					if (!hay.includes(q)) return false;
				}
				return true;
			})
			.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
	});

	const hasActiveSessions = $derived(
		sessions.some((s) => s.status === 'running' || s.status === 'rescheduling')
	);

	const counts = $derived.by(() => ({
		total: sessions.length,
		direct: sessions.filter((s) => !s.workflowExecutionId).length,
		workflow: sessions.filter((s) => s.workflowExecutionId).length
	}));

	// Keep the URL in sync with filter state so deep-links round-trip. We
	// only replace state (no push) so the back button still goes to the
	// previous page, not the previous filter.
	$effect(() => {
		const next = new URLSearchParams();
		if (statusFilter !== 'all') next.set('status', statusFilter);
		if (agentFilter !== 'all') next.set('agentId', agentFilter);
		if (sourceFilter !== 'all') next.set('source', sourceFilter);
		if (workflowIdFilter) next.set('workflowId', workflowIdFilter);
		if (executionIdFilter) next.set('executionId', executionIdFilter);
		if (created !== 'all') next.set('created', created);
		if (searchText.trim()) next.set('q', searchText.trim());
		if (includeArchived) next.set('archived', 'true');
		const qs = next.toString();
		const href = qs ? `?${qs}` : page.url.pathname;
		if (typeof window !== 'undefined' && window.location.search !== (qs ? `?${qs}` : '')) {
			window.history.replaceState(window.history.state, '', href);
		}
	});

	async function load(opts: { silent?: boolean } = {}) {
		if (!opts.silent) loading = true;
		if (!opts.silent) errorMessage = null;
		try {
			const qs = new URLSearchParams();
			if (statusFilter !== 'all') qs.set('status', statusFilter);
			if (agentFilter !== 'all') qs.set('agentId', agentFilter);
			if (sourceFilter !== 'all') qs.set('source', sourceFilter);
			if (workflowIdFilter) qs.set('workflowId', workflowIdFilter);
			if (executionIdFilter) qs.set('executionId', executionIdFilter);
			if (searchText.trim().length >= 2) qs.set('q', searchText.trim());
			if (includeArchived) qs.set('includeArchived', 'true');
			const [sRes, aRes, rRes] = await Promise.all([
				fetch(`/api/v1/sessions?${qs}`),
				fetch('/api/agents'),
				fetch('/api/v1/agent-runtimes')
			]);
			if (!sRes.ok) {
				if (!opts.silent) errorMessage = `Failed to load sessions (${sRes.status})`;
				return;
			}
			const sData = (await sRes.json()) as { sessions: SessionSummary[] };
			sessions = sData.sessions ?? [];
			if (aRes.ok) {
				const aData = (await aRes.json()) as { agents: AgentSummary[] };
				agents = aData.agents ?? [];
			}
			if (rRes.ok) {
				const rData = (await rRes.json()) as {
					runtimes: Array<{ slug: string; browserSidecarEnabled?: boolean }>;
				};
				const map: Record<string, boolean> = {};
				for (const r of rData.runtimes ?? []) {
					if (r.browserSidecarEnabled) map[r.slug] = true;
				}
				browserSidecarBySlug = map;
			}
		} catch (err) {
			if (!opts.silent) errorMessage = err instanceof Error ? err.message : String(err);
		} finally {
			if (!opts.silent) loading = false;
		}
	}

	function schedulePoll() {
		if (pollTimer) clearTimeout(pollTimer);
		const delay = hasActiveSessions ? ACTIVE_POLL_MS : IDLE_POLL_MS;
		pollTimer = setTimeout(async () => {
			if (document.visibilityState === 'visible') {
				await load({ silent: true });
			}
			schedulePoll();
		}, delay);
	}

	async function archive(session: SessionSummary) {
		busyId = session.id;
		try {
			const res = await fetch(`/api/v1/sessions/${session.id}`, { method: 'DELETE' });
			if (!res.ok) {
				errorMessage = `Archive failed (${res.status})`;
				return;
			}
			await load({ silent: true });
		} finally {
			busyId = null;
		}
	}

	function jumpToSession() {
		const id = jumpId.trim();
		if (!id) return;
		goto(`/workspaces/${slug}/sessions/${id}`);
	}

	function clearFilters() {
		statusFilter = 'all';
		agentFilter = 'all';
		sourceFilter = 'all';
		workflowIdFilter = '';
		executionIdFilter = '';
		created = 'all';
		searchText = '';
		includeArchived = false;
	}

	const hasActiveFilter = $derived(
		statusFilter !== 'all' ||
			agentFilter !== 'all' ||
			sourceFilter !== 'all' ||
			workflowIdFilter !== '' ||
			executionIdFilter !== '' ||
			created !== 'all' ||
			searchText.trim() !== '' ||
			includeArchived
	);

	function statusColor(status: string): string {
		switch (status) {
			case 'running':
				return 'bg-blue-500/15 text-blue-600';
			case 'idle':
				return 'bg-amber-500/15 text-amber-600';
			case 'terminated':
				return 'bg-gray-400/15 text-gray-600';
			case 'rescheduling':
				return 'bg-purple-500/15 text-purple-600';
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

	function formatDuration(s: SessionSummary): string {
		// For running/idle sessions, show running time up to "now"; for
		// terminated sessions, show createdAt → completedAt (or updatedAt
		// as a fallback when completedAt didn't land).
		const start = new Date(s.createdAt).getTime();
		const end =
			s.status === 'terminated'
				? new Date(s.completedAt ?? s.updatedAt).getTime()
				: Date.now();
		const ms = Math.max(0, end - start);
		if (ms < 1_000) return '<1s';
		if (ms < 60_000) return `${Math.floor(ms / 1_000)}s`;
		if (ms < 3_600_000) {
			const m = Math.floor(ms / 60_000);
			const s2 = Math.floor((ms % 60_000) / 1_000);
			return s2 ? `${m}m ${s2}s` : `${m}m`;
		}
		const h = Math.floor(ms / 3_600_000);
		const m = Math.floor((ms % 3_600_000) / 60_000);
		return m ? `${h}h ${m}m` : `${h}h`;
	}

	function compactNumber(n: number): string {
		if (!Number.isFinite(n) || n <= 0) return '0';
		if (n < 1_000) return n.toString();
		if (n < 1_000_000) return `${(n / 1_000).toFixed(n < 10_000 ? 1 : 0)}k`;
		return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0)}M`;
	}

	function totalTokens(s: SessionSummary): number {
		return (
			(s.usage?.input_tokens ?? 0) +
			(s.usage?.output_tokens ?? 0) +
			(s.usage?.cache_creation_input_tokens ?? 0) +
			(s.usage?.cache_read_input_tokens ?? 0)
		);
	}

	/**
	 * Workflow-driven sessions ship with a verbose title like
	 * "Workflow <id> · <nodeId>". When we already have the workflow name
	 * in a Source column, the workflow-id prefix is pure noise — strip it
	 * so the table row reads as the node name.
	 */
	function displayTitle(s: SessionSummary): string {
		const t = s.title?.trim();
		if (!t) return '—';
		if (s.workflowExecutionId && s.workflowId) {
			const prefix = `Workflow ${s.workflowId}`;
			if (t.startsWith(prefix)) {
				const rest = t.slice(prefix.length).replace(/^[\s·:•-]+/, '');
				return rest || t;
			}
		}
		return t;
	}

	// Any filter change that maps to a server-side query param re-fetches the
	// list. Client-only filters (created, search <2 chars) stay derived.
	$effect(() => {
		void statusFilter;
		void includeArchived;
		void agentFilter;
		void sourceFilter;
		void workflowIdFilter;
		void executionIdFilter;
		void searchText;
		void load();
	});

	onMount(async () => {
		await load();
		schedulePoll();
	});

	onDestroy(() => {
		if (pollTimer) clearTimeout(pollTimer);
	});
</script>

<div class="p-6 space-y-5 max-w-7xl mx-auto w-full">
	<AppBreadcrumb
		items={[
			{ label: 'Workspace', href: `/workspaces/${slug}` },
			{ label: 'Sessions' }
		]}
	/>

	<header class="flex items-start justify-between gap-4 flex-wrap">
		<div>
			<h1 class="text-2xl font-semibold">Sessions</h1>
			<p class="text-sm text-muted-foreground mt-1">
				Trace and debug Claude Managed Agents sessions.
			</p>
			{#if counts.total > 0}
				<div class="flex items-center gap-2 mt-2 text-xs text-muted-foreground">
					<span>{counts.total} total</span>
					<span class="text-muted-foreground/40">·</span>
					<span>{counts.direct} direct</span>
					<span class="text-muted-foreground/40">·</span>
					<span>{counts.workflow} workflow-driven</span>
					{#if filtered.length !== counts.total}
						<span class="text-muted-foreground/40">·</span>
						<span class="text-foreground">{filtered.length} matching</span>
					{/if}
				</div>
			{/if}
		</div>
		<Button onclick={() => goto(`/workspaces/${slug}/sessions/new`)}>
			<Plus class="size-4" /> New session
		</Button>
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
				placeholder="Search title, ID, or workflow"
				bind:value={searchText}
			/>
		</div>
		<div class="relative w-[200px]">
			<ArrowRight
				class="size-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
			/>
			<Input
				class="pl-9 pr-3 h-9"
				placeholder="Go to session ID"
				bind:value={jumpId}
				onkeydown={(e) => {
					if (e.key === 'Enter') jumpToSession();
				}}
			/>
		</div>
		<div class="flex items-center gap-2 h-9 rounded-md border px-3">
			<span class="text-xs text-muted-foreground">Source</span>
			<select class="bg-transparent text-sm focus:outline-none" bind:value={sourceFilter}>
				<option value="all">All</option>
				<option value="direct">Direct</option>
				<option value="workflow">Workflow</option>
			</select>
		</div>
		<div class="flex items-center gap-2 h-9 rounded-md border px-3">
			<span class="text-xs text-muted-foreground">Status</span>
			<select class="bg-transparent text-sm focus:outline-none" bind:value={statusFilter}>
				<option value="all">All</option>
				<option value="running">Running</option>
				<option value="idle">Idle</option>
				<option value="rescheduling">Rescheduling</option>
				<option value="terminated">Terminated</option>
			</select>
		</div>
		<div class="flex items-center gap-2 h-9 rounded-md border px-3">
			<span class="text-xs text-muted-foreground">Agent</span>
			<select
				class="bg-transparent text-sm focus:outline-none max-w-[160px]"
				bind:value={agentFilter}
			>
				<option value="all">All agents</option>
				{#each agents as a (a.id)}
					<option value={a.id}>{a.name}</option>
				{/each}
			</select>
		</div>
		<div class="flex items-center gap-2 h-9 rounded-md border px-3">
			<span class="text-xs text-muted-foreground">Created</span>
			<select class="bg-transparent text-sm focus:outline-none" bind:value={created}>
				<option value="all">All time</option>
				<option value="7d">Past 7 days</option>
				<option value="30d">Past 30 days</option>
				<option value="90d">Past 90 days</option>
			</select>
		</div>
		<div class="flex items-center gap-2 h-9 rounded-md border px-3">
			<Label for="show-archived" class="text-sm">Archived</Label>
			<Switch id="show-archived" bind:checked={includeArchived} />
		</div>
		{#if hasActiveFilter}
			<Button variant="ghost" size="sm" class="h-9 gap-1" onclick={clearFilters}>
				<X class="size-3" /> Clear
			</Button>
		{/if}
		{#if hasActiveSessions}
			<Badge variant="outline" class="text-[10px] gap-1">
				<span class="size-1.5 rounded-full bg-blue-500 animate-pulse"></span>
				Live · 3s
			</Badge>
		{/if}
	</div>

	<ResourceTable
		rows={filtered}
		{loading}
		onRowClick={(s: SessionSummary) => goto(`/workspaces/${slug}/sessions/${s.id}`)}
	>
		{#snippet header()}
			<th class="px-4 py-2.5 font-medium">ID</th>
			<th class="px-4 py-2.5 font-medium">Name</th>
			<th class="px-4 py-2.5 font-medium">Status</th>
			<th class="px-4 py-2.5 font-medium">Source</th>
			<th class="px-4 py-2.5 font-medium">Agent</th>
			<th class="px-4 py-2.5 font-medium">Tokens</th>
			<th class="px-4 py-2.5 font-medium">Duration</th>
			<th class="px-4 py-2.5 font-medium">Updated</th>
			<th class="px-4 py-2.5 font-medium w-10"></th>
		{/snippet}
		{#snippet row(s: SessionSummary)}
			{@const agent = agentsById.get(s.agentId)}
			{@const tokens = totalTokens(s)}
			<td class="px-4 py-2.5">
				<CopyIdButton value={s.id} />
			</td>
			<td class="px-4 py-2.5">
				<div class="flex items-center gap-1.5 max-w-[260px]">
					<span class="truncate block" title={s.title ?? ''}>
						{displayTitle(s)}
					</span>
					{#if s.errorMessage && s.status === 'terminated'}
						<span
							class="text-red-500 shrink-0"
							title={s.errorMessage}
							aria-label="Session error"
						>
							<AlertCircle class="size-3.5" />
						</span>
					{/if}
				</div>
			</td>
			<td class="px-4 py-2.5">
				<span
					class="rounded-full px-2 py-0.5 text-[10px] font-medium {statusColor(s.status)}"
				>
					{s.status}
				</span>
			</td>
			<td class="px-4 py-2.5">
				{#if s.workflowExecutionId && s.workflowId}
					<a
						href={`/workspaces/${slug}/workflows/${s.workflowId}/runs/${s.workflowExecutionId}`}
						onclick={(e) => e.stopPropagation()}
						class="inline-flex items-center gap-1 text-xs hover:underline text-foreground"
						title={`Workflow run ${s.workflowExecutionId}`}
					>
						<Workflow class="size-3 text-muted-foreground" />
						<span class="truncate max-w-[160px]">{s.workflowName ?? s.workflowId}</span>
						<ExternalLink class="size-2.5 text-muted-foreground" />
					</a>
				{:else}
					<Badge variant="secondary" class="text-[10px]">Direct</Badge>
				{/if}
			</td>
			<td class="px-4 py-2.5">
				{#if s.agentName}
					{@const slug = s.agentSlug ?? agent?.slug}
					<Badge
						variant="outline"
						class="text-[11px] gap-1"
						title={s.agentEphemeral
							? 'Workflow-ephemeral agent (inline agentConfig in a durable/run step)'
							: s.agentName}
					>
						<span>{s.agentAvatar ?? agent?.avatar ?? (s.agentEphemeral ? '⚡' : '🤖')}</span>
						<span class="truncate max-w-[160px]">{s.agentName}</span>
						{#if slug && browserSidecarBySlug[slug]}
							<span
								title="Browser sidecar (chromium + playwright-mcp)"
								aria-label="Browser agent"
								class="text-[10px] leading-none"
							>
								🌐
							</span>
						{/if}
						{#if s.agentEphemeral}
							<span
								class="text-[9px] uppercase tracking-wide text-muted-foreground/70"
								title="Spawned from inline agentConfig — not a saved agent"
							>
								eph
							</span>
						{/if}
					</Badge>
				{:else}
					<code class="text-[10px] text-muted-foreground">{s.agentId.slice(0, 10)}</code>
				{/if}
			</td>
			<td class="px-4 py-2.5 text-xs text-muted-foreground">
				{#if tokens > 0}
					<span
						class="tabular-nums"
						title={`in ${(s.usage.input_tokens ?? 0).toLocaleString()} · out ${(s.usage.output_tokens ?? 0).toLocaleString()} · cache-read ${(s.usage.cache_read_input_tokens ?? 0).toLocaleString()} · cache-write ${(s.usage.cache_creation_input_tokens ?? 0).toLocaleString()}`}
					>
						{compactNumber(tokens)}
					</span>
				{:else}
					—
				{/if}
			</td>
			<td class="px-4 py-2.5 text-xs text-muted-foreground tabular-nums">
				{formatDuration(s)}
			</td>
			<td class="px-4 py-2.5 text-xs text-muted-foreground">
				{formatRelative(s.updatedAt)}
			</td>
			<td class="px-4 py-2.5" onclick={(e) => e.stopPropagation()}>
				<RowMoreActions
					actions={[
						{
							label: 'Archive',
							onClick: () => archive(s),
							destructive: true,
							disabled: busyId === s.id
						}
					]}
				/>
			</td>
		{/snippet}
		{#snippet empty()}
			<div class="flex flex-col items-center justify-center py-10 space-y-3">
				<div class="size-14 rounded-full bg-primary/10 flex items-center justify-center">
					<MessagesSquare class="size-7 text-primary" />
				</div>
				<h2 class="text-base font-semibold">
					{hasActiveFilter ? 'No sessions match your filters' : 'No sessions yet'}
				</h2>
				<p class="text-muted-foreground text-sm max-w-md text-center">
					{#if hasActiveFilter}
						Try widening the filters — or clear them to see every session in this workspace.
					{:else}
						Sessions appear here once created through the API, the Quickstart flow, or a workflow
						<code class="text-[10px]">durable/run</code>
						node.
					{/if}
				</p>
				{#if hasActiveFilter}
					<Button variant="outline" onclick={clearFilters}>
						<X class="size-4" /> Clear filters
					</Button>
				{:else}
					<Button onclick={() => goto(`/workspaces/${slug}/sessions/new`)}>
						<Plus class="size-4" /> Start your first session
					</Button>
				{/if}
			</div>
		{/snippet}
	</ResourceTable>
</div>
