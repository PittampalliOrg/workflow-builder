<script lang="ts">
	import { goto } from '$app/navigation';
	import { onDestroy, onMount } from 'svelte';
	import { Badge } from '$lib/components/ui/badge';
	import {
		Card,
		CardContent,
		CardHeader,
		CardTitle
	} from '$lib/components/ui/card';
	import * as Select from '$lib/components/ui/select';
	import { MessagesSquare, Plus } from 'lucide-svelte';
	import ResourceListShell from '$lib/components/console/resource-list-shell.svelte';
	import { Button } from '$lib/components/ui/button';
	import type { SessionStatus, SessionSummary } from '$lib/types/sessions';
	import type { AgentSummary } from '$lib/types/agents';

	type StatusFilter = 'all' | SessionStatus;
	type SortBy = 'updated' | 'tokens' | 'title' | 'agent';

	let sessions = $state<SessionSummary[]>([]);
	let agents = $state<AgentSummary[]>([]);
	let loading = $state(true);
	let errorMessage = $state<string | null>(null);
	let search = $state('');
	let statusFilter = $state<StatusFilter>('all');
	let agentFilter = $state<string>('all');
	let sortBy = $state<SortBy>('updated');

	// Active sessions get fast refreshes; idle lists back off to 30s so an
	// unattended tab doesn't hammer the DB.
	const ACTIVE_POLL_MS = 3_000;
	const IDLE_POLL_MS = 30_000;
	let pollTimer: ReturnType<typeof setTimeout> | null = null;

	let agentsById = $derived.by(() => {
		const m = new Map<string, AgentSummary>();
		for (const a of agents) m.set(a.id, a);
		return m;
	});

	const statusFilterLabel = $derived(
		statusFilter === 'all' ? 'All statuses' : statusFilter
	);
	const agentFilterLabel = $derived(
		agentFilter === 'all'
			? 'All agents'
			: agentsById.get(agentFilter)?.name ?? agentFilter
	);
	const sortLabel = $derived(
		sortBy === 'updated'
			? 'Recently updated'
			: sortBy === 'tokens'
				? 'Tokens (high → low)'
				: sortBy === 'title'
					? 'Title (A–Z)'
					: 'Agent (A–Z)'
	);

	function tokenTotal(s: SessionSummary): number {
		return (s.usage?.input_tokens ?? 0) + (s.usage?.output_tokens ?? 0);
	}

	let filtered = $derived.by(() => {
		const q = search.trim().toLowerCase();
		let out = sessions.filter((s) => {
			if (statusFilter !== 'all' && s.status !== statusFilter) return false;
			if (agentFilter !== 'all' && s.agentId !== agentFilter) return false;
			if (!q) return true;
			const agent = agentsById.get(s.agentId);
			const hay = `${s.title ?? ''} ${agent?.name ?? ''} ${s.agentId}`.toLowerCase();
			return hay.includes(q);
		});
		out = [...out];
		switch (sortBy) {
			case 'tokens':
				out.sort((a, b) => tokenTotal(b) - tokenTotal(a));
				break;
			case 'title':
				out.sort((a, b) =>
					(a.title ?? '').localeCompare(b.title ?? '', undefined, {
						sensitivity: 'base'
					})
				);
				break;
			case 'agent':
				out.sort((a, b) => {
					const aa = agentsById.get(a.agentId)?.name ?? a.agentId;
					const bb = agentsById.get(b.agentId)?.name ?? b.agentId;
					return aa.localeCompare(bb, undefined, { sensitivity: 'base' });
				});
				break;
			default:
				out.sort(
					(a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
				);
				break;
		}
		return out;
	});

	const hasActiveSessions = $derived(
		sessions.some((s) => s.status === 'running' || s.status === 'rescheduling')
	);

	async function load(opts: { silent?: boolean } = {}) {
		if (!opts.silent) loading = true;
		if (!opts.silent) errorMessage = null;
		try {
			// Server-side status param narrows payload when possible. Leave agent
			// filter client-side so the dropdown can filter already-loaded data
			// without re-fetching the full agent list on every change.
			const qs = new URLSearchParams();
			if (statusFilter !== 'all') qs.set('status', statusFilter);
			const [sRes, aRes] = await Promise.all([
				fetch(`/api/v1/sessions${qs.toString() ? `?${qs}` : ''}`),
				fetch('/api/agents')
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
		return new Date(iso).toLocaleDateString();
	}

	onMount(async () => {
		await load();
		schedulePoll();
	});

	onDestroy(() => {
		if (pollTimer) clearTimeout(pollTimer);
	});

	// Re-fetch when the status filter changes because it narrows the server
	// query. Other filters (agent, search, sort) are client-side only.
	function onStatusFilterChange(v: string | undefined) {
		statusFilter = (v as StatusFilter) ?? 'all';
		void load({ silent: true });
	}
</script>

<ResourceListShell
	title="Sessions"
	subtitle="Trace and debug Claude Managed Agents sessions."
	itemLabel="session"
	itemCount={filtered.length}
	onSearch={(v) => (search = v)}
	primaryLabel="New Session"
	onPrimary={() => goto('/workspaces/default/sessions/new')}
	{loading}
	{errorMessage}
	isEmpty={sessions.length === 0 || filtered.length === 0}
	{content}
	{filters}
	{empty}
/>

{#snippet filters()}
	<div class="flex items-center gap-2 flex-wrap">
		<Select.Root
			type="single"
			value={statusFilter}
			onValueChange={onStatusFilterChange}
		>
			<Select.Trigger class="h-8 min-w-[150px] text-xs">
				{statusFilterLabel}
			</Select.Trigger>
			<Select.Content>
				<Select.Item value="all">All statuses</Select.Item>
				<Select.Item value="running">Running</Select.Item>
				<Select.Item value="idle">Idle</Select.Item>
				<Select.Item value="rescheduling">Rescheduling</Select.Item>
				<Select.Item value="terminated">Terminated</Select.Item>
			</Select.Content>
		</Select.Root>

		<Select.Root
			type="single"
			value={agentFilter}
			onValueChange={(v) => (agentFilter = v ?? 'all')}
		>
			<Select.Trigger class="h-8 min-w-[180px] text-xs">
				{agentFilterLabel}
			</Select.Trigger>
			<Select.Content>
				<Select.Item value="all">All agents</Select.Item>
				{#each agents as a (a.id)}
					<Select.Item value={a.id}>
						{a.avatar ?? '🤖'} {a.name}
					</Select.Item>
				{/each}
			</Select.Content>
		</Select.Root>

		<Select.Root
			type="single"
			value={sortBy}
			onValueChange={(v) => (sortBy = (v as SortBy) ?? 'updated')}
		>
			<Select.Trigger class="h-8 min-w-[180px] text-xs">
				{sortLabel}
			</Select.Trigger>
			<Select.Content>
				<Select.Item value="updated">Recently updated</Select.Item>
				<Select.Item value="tokens">Tokens (high → low)</Select.Item>
				<Select.Item value="title">Title (A–Z)</Select.Item>
				<Select.Item value="agent">Agent (A–Z)</Select.Item>
			</Select.Content>
		</Select.Root>

		{#if hasActiveSessions}
			<Badge variant="outline" class="text-[10px] gap-1">
				<span class="size-1.5 rounded-full bg-blue-500 animate-pulse"></span>
				Live updates every 3s
			</Badge>
		{/if}
	</div>
{/snippet}

{#snippet content()}
	<div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
		{#each filtered as session (session.id)}
			{@const agent = agentsById.get(session.agentId)}
			<Card class="cursor-pointer hover:shadow-md transition-shadow">
				<button
					type="button"
					class="text-left w-full h-full"
					onclick={() => goto(`/workspaces/default/sessions/${session.id}`)}
				>
					<CardHeader class="pb-2">
						<div class="flex items-start justify-between gap-2">
							<CardTitle class="text-base line-clamp-1">
								{session.title ?? 'Untitled session'}
							</CardTitle>
							<span
								class="rounded-full px-2 py-0.5 text-[10px] font-medium {statusColor(
									session.status
								)}"
							>
								{session.status}
							</span>
						</div>
						<p class="text-xs text-muted-foreground">
							{agent?.avatar ?? '🤖'} {agent?.name ?? session.agentId}
							{#if session.agentVersion !== null}
								<span class="text-[10px]">· v{session.agentVersion}</span>
							{/if}
						</p>
					</CardHeader>
					<CardContent class="pt-0 text-[11px] text-muted-foreground space-y-1">
						<div>Updated {formatRelative(session.updatedAt)}</div>
						{#if session.usage?.input_tokens || session.usage?.output_tokens}
							<div>
								<Badge variant="outline" class="text-[10px]">
									in {session.usage.input_tokens ?? 0} · out {session.usage.output_tokens ?? 0}
								</Badge>
							</div>
						{/if}
						{#if session.errorMessage}
							<div class="text-destructive line-clamp-1">{session.errorMessage}</div>
						{/if}
					</CardContent>
				</button>
			</Card>
		{/each}
	</div>
{/snippet}

{#snippet empty()}
	{#if sessions.length === 0}
		<div class="flex flex-col items-center justify-center text-center py-16">
			<div class="size-20 rounded-full bg-primary/10 flex items-center justify-center mb-4">
				<MessagesSquare class="size-10 text-primary" />
			</div>
			<h2 class="text-xl font-semibold mb-2">No sessions yet</h2>
			<p class="text-muted-foreground mb-6 max-w-md">
				Sessions will appear here once created through the API or the quickstart flow.
			</p>
			<Button onclick={() => goto('/workspaces/default/sessions/new')} size="lg">
				<Plus class="size-4 mr-1" /> Start your first session
			</Button>
		</div>
	{:else}
		<div class="text-center text-muted-foreground py-12">No sessions match your filters.</div>
	{/if}
{/snippet}
