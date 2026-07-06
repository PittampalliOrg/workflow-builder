<script lang="ts">
	import { goto, invalidateAll } from '$app/navigation';
	import { page } from '$app/state';
	import { Alert, AlertDescription } from '$lib/components/ui/alert';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Switch } from '$lib/components/ui/switch';
	import { NativeSelect } from '$lib/components/ui/native-select';
	import { Avatar, AvatarFallback, AvatarImage } from '$lib/components/ui/avatar';
	import CopyIdButton from '$lib/components/console/copy-id-button.svelte';
	import ResourceTable from '$lib/components/console/resource-table.svelte';
	import StatusPill from '$lib/components/shared/status-pill.svelte';
	import StopReasonChip from '$lib/components/sessions/stop-reason-chip.svelte';
	import {
		Boxes,
		ExternalLink,
		MessageSquare,
		Play,
		RefreshCw,
		Search,
		Sparkles,
		Workflow,
		X
	} from '@lucide/svelte';
	import type { SessionKind } from '$lib/server/application/session-kind';
	import type { SessionStatus, SessionUsage } from '$lib/types/sessions';
	import { getSessionsPage } from './data.remote';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	const slug = $derived((page.params.slug as string) ?? 'default');
	const filters = $derived(data.filters);

	type SessionRow = PageData['page']['sessions'][number];

	// Seeded from the SSR first page; load-more appends, filter navigation
	// re-seeds via the effect below. `loadedPages` tracks the RAW page offset so
	// post-classified kinds (interactive/experiment, which drop rows) still page
	// the underlying DB correctly.
	let sessions = $state<SessionRow[]>([...data.page.sessions]);
	let hasMore = $state(data.page.hasMore);
	let loadedPages = $state(1);
	let loadingMore = $state(false);
	let refreshing = $state(false);
	let errorMessage = $state<string | null>(null);
	let searchDraft = $state(data.filters.q);

	$effect(() => {
		// Re-seed on SSR navigation (new filters / manual reload). `data.page` is a
		// fresh object each load, so this resets exactly when the server payload
		// changes — load-more mutations of `sessions` don't retrigger it.
		const p = data.page;
		sessions = [...p.sessions];
		hasMore = p.hasMore;
		loadedPages = 1;
		searchDraft = data.filters.q;
	});

	const KIND_META: Record<SessionKind, { label: string; icon: typeof Workflow; cls: string }> = {
		interactive: {
			label: 'Interactive',
			icon: MessageSquare,
			cls: 'border-sky-500/40 text-sky-500'
		},
		workflow: { label: 'Workflow', icon: Workflow, cls: 'border-indigo-500/40 text-indigo-500' },
		experiment: { label: 'Experiment', icon: Sparkles, cls: 'border-amber-500/40 text-amber-500' },
		dev: { label: 'Dev', icon: Boxes, cls: 'border-emerald-500/40 text-emerald-500' }
	};

	const KIND_TABS: { key: SessionKind | null; label: string }[] = [
		{ key: null, label: 'All' },
		{ key: 'interactive', label: 'Interactive' },
		{ key: 'workflow', label: 'Workflow' },
		{ key: 'experiment', label: 'Experiment' },
		{ key: 'dev', label: 'Dev' }
	];

	const SESSION_STATUSES: SessionStatus[] = [
		'running',
		'idle',
		'paused',
		'rescheduling',
		'failed',
		'terminated'
	];

	// Agent select options are derived from the loaded rows (no extra catalog
	// query); more agents surface as pages load.
	const agentOptions = $derived.by(() => {
		const byId = new Map<string, string>();
		for (const s of sessions) {
			if (s.agentId) byId.set(s.agentId, s.agentName ?? s.agentSlug ?? s.agentId);
		}
		return [...byId.entries()]
			.map(([id, name]) => ({ id, name }))
			.sort((a, b) => a.name.localeCompare(b.name));
	});

	function sessionTokens(usage: SessionUsage): number {
		return (
			(usage.input_tokens ?? 0) +
			(usage.output_tokens ?? 0) +
			(usage.cache_creation_input_tokens ?? 0) +
			(usage.cache_read_input_tokens ?? 0)
		);
	}
	function fmtTokens(n: number): string {
		if (!n) return '—';
		if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
		if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
		return `${n}`;
	}
	function formatRelative(iso: string): string {
		const diff = Date.now() - new Date(iso).getTime();
		if (diff < 60_000) return 'just now';
		if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
		if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
		if (diff < 30 * 86_400_000) return `${Math.floor(diff / 86_400_000)}d ago`;
		return new Date(iso).toLocaleDateString();
	}
	function initials(name: string | null): string {
		const n = (name ?? '').trim();
		if (!n) return '?';
		return n
			.split(/\s+/)
			.slice(0, 2)
			.map((p) => p[0]?.toUpperCase() ?? '')
			.join('');
	}

	function filterInput(offset: number, limit = data.pageSize) {
		return {
			kind: filters.kind,
			status: filters.status,
			agentId: filters.agentId,
			q: filters.q,
			includeArchived: filters.includeArchived,
			source: filters.source,
			workflowId: filters.workflowId,
			offset,
			limit
		};
	}

	// Filter changes are URL-synced (shareable + SSR): update the query string and
	// let the server load re-run, which re-seeds the table via the effect above.
	function navigate(patch: Record<string, string | null>) {
		const url = new URL(page.url);
		for (const [key, value] of Object.entries(patch)) {
			if (value === null || value === '') url.searchParams.delete(key);
			else url.searchParams.set(key, value);
		}
		void goto(`${url.pathname}${url.search}`, { keepFocus: true, noScroll: true });
	}

	let searchTimer: ReturnType<typeof setTimeout> | null = null;
	function onSearchInput(value: string) {
		searchDraft = value;
		if (searchTimer) clearTimeout(searchTimer);
		searchTimer = setTimeout(() => navigate({ q: value.trim() || null }), 300);
	}

	function clearWorkflowScope() {
		navigate({ workflowId: null, source: null });
	}

	async function loadMore() {
		if (loadingMore || !hasMore) return;
		loadingMore = true;
		errorMessage = null;
		try {
			const res = await getSessionsPage(filterInput(loadedPages * data.pageSize));
			sessions = [...sessions, ...res.sessions];
			hasMore = res.hasMore;
			loadedPages += 1;
		} catch (err) {
			errorMessage = err instanceof Error ? err.message : String(err);
		} finally {
			loadingMore = false;
		}
	}

	// Visibility-gated refresh of the first page (paused once the user has loaded
	// more, so a tick never yanks appended rows). Manual refresh resets to page 1.
	async function refreshFirstPage() {
		if (loadingMore || refreshing || loadedPages !== 1) return;
		refreshing = true;
		try {
			const res = await getSessionsPage(filterInput(0));
			sessions = [...res.sessions];
			hasMore = res.hasMore;
		} catch {
			/* transient — the next tick retries */
		} finally {
			refreshing = false;
		}
	}
	function manualRefresh() {
		void invalidateAll();
	}

	$effect(() => {
		if (typeof document === 'undefined') return;
		let timer: ReturnType<typeof setInterval> | null = null;
		const start = () => {
			if (timer === null) timer = setInterval(() => void refreshFirstPage(), 5000);
		};
		const stop = () => {
			if (timer !== null) {
				clearInterval(timer);
				timer = null;
			}
		};
		const onVisibility = () => {
			if (document.visibilityState === 'visible') start();
			else stop();
		};
		onVisibility();
		document.addEventListener('visibilitychange', onVisibility);
		return () => {
			stop();
			document.removeEventListener('visibilitychange', onVisibility);
		};
	});

	const hasActiveFilters = $derived(
		!!(filters.kind || filters.status || filters.agentId || filters.q || filters.includeArchived)
	);
	const fleetHref = $derived(`/workspaces/${slug}/capacity/active?kind=session&scope=all`);
</script>

<div class="p-6 space-y-4">
	<header class="flex items-start justify-between gap-4">
		<div>
			<h1 class="text-xl font-semibold">Sessions</h1>
			<p class="text-sm text-muted-foreground mt-1">
				Every agent session in this workspace — interactive, workflow-driven, experiment forks,
				and Microservice dev-sessions.
			</p>
		</div>
		<div class="flex items-center gap-2">
			<Button variant="outline" size="sm" onclick={manualRefresh} disabled={refreshing}>
				<RefreshCw class="size-4 {refreshing ? 'animate-spin' : ''}" />
				Refresh
			</Button>
			<Button variant="ghost" size="sm" href={fleetHref}>
				Open in Fleet <ExternalLink class="size-4" />
			</Button>
		</div>
	</header>

	{#if errorMessage}
		<Alert variant="destructive">
			<AlertDescription>{errorMessage}</AlertDescription>
		</Alert>
	{/if}

	<!-- Kind tabs -->
	<div class="flex items-center gap-1 border-b">
		{#each KIND_TABS as tab (tab.label)}
			<button
				type="button"
				class="px-3 py-2 text-sm border-b-2 -mb-px transition-colors {(filters.kind ?? null) ===
				tab.key
					? 'border-primary text-foreground font-medium'
					: 'border-transparent text-muted-foreground hover:text-foreground'}"
				onclick={() => navigate({ kind: tab.key })}
			>
				{tab.label}
			</button>
		{/each}
	</div>

	<!-- Secondary filters -->
	<div class="flex items-center gap-3 flex-wrap">
		<div class="relative flex-1 min-w-[220px] max-w-sm">
			<Search
				class="size-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none"
			/>
			<Input
				class="pl-9 pr-3 h-9"
				placeholder="Search title, id, workflow, agent…"
				value={searchDraft}
				oninput={(e) => onSearchInput((e.currentTarget as HTMLInputElement).value)}
			/>
		</div>

		<NativeSelect
			size="sm"
			value={filters.status ?? ''}
			onchange={(e) => navigate({ status: (e.currentTarget as HTMLSelectElement).value || null })}
		>
			<option value="">All statuses</option>
			{#each SESSION_STATUSES as s (s)}
				<option value={s}>{s}</option>
			{/each}
		</NativeSelect>

		<NativeSelect
			size="sm"
			value={filters.agentId ?? ''}
			onchange={(e) => navigate({ agentId: (e.currentTarget as HTMLSelectElement).value || null })}
		>
			<option value="">All agents</option>
			{#each agentOptions as a (a.id)}
				<option value={a.id}>{a.name}</option>
			{/each}
		</NativeSelect>

		<label class="flex items-center gap-2 text-sm text-muted-foreground">
			<Switch
				checked={filters.includeArchived}
				onCheckedChange={(v) => navigate({ includeArchived: v ? 'true' : null })}
			/>
			Include archived
		</label>
	</div>

	<!-- Deep-link scope chip (editor "runs" / workflow-source links) -->
	{#if filters.workflowId || filters.source}
		<div class="flex items-center gap-2 flex-wrap">
			{#if filters.workflowId}
				<Badge variant="secondary" class="gap-1 font-normal">
					Workflow: <span class="font-mono">{filters.workflowId.slice(0, 18)}</span>
					<button type="button" aria-label="Clear workflow filter" onclick={clearWorkflowScope}>
						<X class="size-3" />
					</button>
				</Badge>
			{:else if filters.source}
				<Badge variant="secondary" class="gap-1 font-normal">
					Source: {filters.source}
					<button type="button" aria-label="Clear source filter" onclick={() => navigate({ source: null })}>
						<X class="size-3" />
					</button>
				</Badge>
			{/if}
		</div>
	{/if}

	<ResourceTable rows={sessions}>
		{#snippet header()}
			<th class="px-4 py-2.5 font-medium">Session</th>
			<th class="px-4 py-2.5 font-medium">Agent</th>
			<th class="px-4 py-2.5 font-medium">Kind</th>
			<th class="px-4 py-2.5 font-medium">Status</th>
			<th class="px-4 py-2.5 font-medium">Workflow</th>
			<th class="px-4 py-2.5 font-medium text-right">Tokens</th>
			<th class="px-4 py-2.5 font-medium">Updated</th>
		{/snippet}
		{#snippet row(s: SessionRow)}
			{@const kindMeta = KIND_META[s.kind]}
			<td class="px-4 py-2.5">
				<div class="flex items-center gap-2 min-w-0">
					<a
						href="/workspaces/{slug}/sessions/{s.id}"
						class="truncate text-primary hover:underline max-w-[280px]"
						title={s.title ?? s.id}
					>
						{s.title ?? 'Untitled session'}
					</a>
					<CopyIdButton value={s.id} />
				</div>
			</td>
			<td class="px-4 py-2.5">
				<div class="flex items-center gap-2 min-w-0">
					<Avatar class="size-6">
						{#if s.agentAvatar}
							<AvatarImage src={s.agentAvatar} alt={s.agentName ?? ''} />
						{/if}
						<AvatarFallback class="text-[9px]">{initials(s.agentName)}</AvatarFallback>
					</Avatar>
					<span class="truncate max-w-[160px]" title={s.agentSlug ?? s.agentId}>
						{s.agentName ?? s.agentSlug ?? s.agentId}
					</span>
				</div>
			</td>
			<td class="px-4 py-2.5">
				{#if s.kind === 'dev' && s.workflowExecutionId}
					<a href="/workspaces/{slug}/dev/{s.workflowExecutionId}" class="inline-block">
						<Badge variant="outline" class="text-[10px] gap-1 {kindMeta.cls} hover:underline">
							<kindMeta.icon class="size-2.5" />
							{kindMeta.label}
						</Badge>
					</a>
				{:else}
					<Badge variant="outline" class="text-[10px] gap-1 {kindMeta.cls}">
						<kindMeta.icon class="size-2.5" />
						{kindMeta.label}
					</Badge>
				{/if}
			</td>
			<td class="px-4 py-2.5">
				<div class="flex items-center gap-1.5">
					<StatusPill status={s.status} />
					{#if s.stopReason}
						<StopReasonChip stopReason={s.stopReason} />
					{/if}
				</div>
			</td>
			<td class="px-4 py-2.5">
				{#if s.workflowId}
					<div class="flex items-center gap-2 min-w-0">
						<a
							href="/workspaces/{slug}/workflows/{s.workflowId}"
							class="truncate text-primary hover:underline max-w-[180px]"
							title={s.workflowName ?? s.workflowId}
						>
							{s.workflowName ?? s.workflowId}
						</a>
						{#if s.workflowExecutionId}
							<a
								href="/workspaces/{slug}/workflows/{s.workflowId}/runs/{s.workflowExecutionId}"
								class="text-muted-foreground hover:text-foreground"
								title="Open run cockpit"
								aria-label="Open run cockpit"
							>
								<Play class="size-3.5" />
							</a>
						{/if}
					</div>
				{:else}
					<span class="text-muted-foreground">—</span>
				{/if}
			</td>
			<td class="px-4 py-2.5 text-right font-mono text-xs text-muted-foreground">
				{fmtTokens(sessionTokens(s.usage))}
			</td>
			<td class="px-4 py-2.5 text-xs text-muted-foreground">
				{formatRelative(s.updatedAt)}
			</td>
		{/snippet}
		{#snippet empty()}
			{#if hasActiveFilters}
				<div class="space-y-2">
					<p>No sessions match these filters.</p>
					<Button variant="outline" size="sm" onclick={() => goto(`/workspaces/${slug}/sessions`)}>
						Clear filters
					</Button>
				</div>
			{:else}
				<div class="space-y-2">
					<p>No sessions yet in this workspace.</p>
					<Button variant="ghost" size="sm" href={fleetHref}>
						Open the Fleet <ExternalLink class="size-4" />
					</Button>
				</div>
			{/if}
		{/snippet}
	</ResourceTable>

	{#if hasMore}
		<div class="flex justify-center pt-1">
			<Button variant="outline" size="sm" onclick={loadMore} disabled={loadingMore}>
				{loadingMore ? 'Loading…' : 'Load more'}
			</Button>
		</div>
	{/if}
</div>
