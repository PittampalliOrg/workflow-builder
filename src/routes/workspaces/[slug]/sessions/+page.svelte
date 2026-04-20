<script lang="ts">
	import { goto } from '$app/navigation';
	import { onDestroy, onMount } from 'svelte';
	import { Alert, AlertDescription } from '$lib/components/ui/alert';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Switch } from '$lib/components/ui/switch';
	import { Label } from '$lib/components/ui/label';
	import { ArrowRight, MessagesSquare, Plus } from 'lucide-svelte';
	import CopyIdButton from '$lib/components/console/copy-id-button.svelte';
	import ResourceTable from '$lib/components/console/resource-table.svelte';
	import RowMoreActions from '$lib/components/console/row-more-actions.svelte';
	import type { SessionStatus, SessionSummary } from '$lib/types/sessions';
	import type { AgentSummary } from '$lib/types/agents';
	import { page } from '$app/state';

	const slug = $derived((page.params.slug as string) ?? 'default');

	type StatusFilter = 'all' | SessionStatus;

	let sessions = $state<SessionSummary[]>([]);
	let agents = $state<AgentSummary[]>([]);
	let loading = $state(true);
	let errorMessage = $state<string | null>(null);
	let statusFilter = $state<StatusFilter>('all');
	// Pre-fill from `?agentId=<id>` so deep-links from the agent detail page
	// land on a pre-filtered list.
	let agentFilter = $state<string>(page.url.searchParams.get('agentId') ?? 'all');
	let created = $state<'all' | '7d' | '30d' | '90d'>('all');
	let includeArchived = $state(false);
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

	// Slug → whether that agent has a browser sidecar. Fetched alongside
	// the sessions + agents batch so a 🌐 can render inline in the Agent
	// column when applicable. One extra round trip per page load.
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
		return sessions
			.filter((s) => {
				if (statusFilter !== 'all' && s.status !== statusFilter) return false;
				if (agentFilter !== 'all' && s.agentId !== agentFilter) return false;
				if (cutoff && new Date(s.createdAt).getTime() < cutoff) return false;
				if (!includeArchived && s.archivedAt) return false;
				return true;
			})
			.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
	});

	const hasActiveSessions = $derived(
		sessions.some((s) => s.status === 'running' || s.status === 'rescheduling')
	);

	async function load(opts: { silent?: boolean } = {}) {
		if (!opts.silent) loading = true;
		if (!opts.silent) errorMessage = null;
		try {
			const qs = new URLSearchParams();
			if (statusFilter !== 'all') qs.set('status', statusFilter);
			if (includeArchived) qs.set('includeArchived', 'true');
			const [sRes, aRes, rRes] = await Promise.all([
				fetch(`/api/v1/sessions?${qs}`),
				fetch('/api/agents'),
				fetch('/api/v1/agent-runtimes'),
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

	$effect(() => {
		void statusFilter;
		void includeArchived;
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

<div class="p-6 space-y-5 max-w-6xl mx-auto w-full">
	<header class="flex items-start justify-between gap-4 flex-wrap">
		<div>
			<h1 class="text-2xl font-semibold">Sessions</h1>
			<p class="text-sm text-muted-foreground mt-1">
				Trace and debug Claude Managed Agents sessions.
			</p>
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

	<div class="flex items-center gap-3 flex-wrap">
		<div class="relative flex-1 min-w-[240px] max-w-md">
			<ArrowRight class="size-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
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
			<span class="text-xs text-muted-foreground">Created</span>
			<select class="bg-transparent text-sm focus:outline-none" bind:value={created}>
				<option value="all">All time</option>
				<option value="7d">Past 7 days</option>
				<option value="30d">Past 30 days</option>
				<option value="90d">Past 90 days</option>
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
			<span class="text-xs text-muted-foreground">Status</span>
			<select
				class="bg-transparent text-sm focus:outline-none"
				bind:value={statusFilter}
			>
				<option value="all">All</option>
				<option value="running">Running</option>
				<option value="idle">Idle</option>
				<option value="rescheduling">Rescheduling</option>
				<option value="terminated">Terminated</option>
			</select>
		</div>
		<div class="flex items-center gap-2 h-9 rounded-md border px-3">
			<Label for="show-archived" class="text-sm">Show archived</Label>
			<Switch id="show-archived" bind:checked={includeArchived} />
		</div>
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
			<th class="px-4 py-2.5 font-medium">Agent</th>
			<th class="px-4 py-2.5 font-medium">Tokens</th>
			<th class="px-4 py-2.5 font-medium">Updated</th>
			<th class="px-4 py-2.5 font-medium w-10"></th>
		{/snippet}
		{#snippet row(s: SessionSummary)}
			{@const agent = agentsById.get(s.agentId)}
			<td class="px-4 py-2.5">
				<CopyIdButton value={s.id} />
			</td>
			<td class="px-4 py-2.5">
				<span class="truncate block max-w-[200px]">{s.title ?? '—'}</span>
			</td>
			<td class="px-4 py-2.5">
				<span
					class="rounded-full px-2 py-0.5 text-[10px] font-medium {statusColor(s.status)}"
				>
					{s.status}
				</span>
			</td>
			<td class="px-4 py-2.5">
				{#if agent}
					<Badge variant="outline" class="text-[11px] gap-1">
						<span>{agent.avatar ?? '🤖'}</span>
						<span class="truncate max-w-[140px]">{agent.name}</span>
						{#if browserSidecarBySlug[agent.slug]}
							<span
								title="Browser sidecar (chromium + playwright-mcp)"
								aria-label="Browser agent"
								class="text-[10px] leading-none"
							>
								🌐
							</span>
						{/if}
					</Badge>
				{:else}
					<code class="text-[10px] text-muted-foreground">{s.agentId.slice(0, 10)}</code>
				{/if}
			</td>
			<td class="px-4 py-2.5 text-xs text-muted-foreground">
				{#if s.usage?.input_tokens || s.usage?.output_tokens}
					{(s.usage.input_tokens ?? 0).toLocaleString()} /
					{(s.usage.output_tokens ?? 0).toLocaleString()}
				{:else}
					—
				{/if}
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
				<h2 class="text-base font-semibold">No sessions yet</h2>
				<p class="text-muted-foreground text-sm max-w-md text-center">
					Sessions appear here once created through the API, the Quickstart flow, or a workflow
					<code class="text-[10px]">durable/run</code> node.
				</p>
				<Button onclick={() => goto(`/workspaces/${slug}/sessions/new`)}>
					<Plus class="size-4" /> Start your first session
				</Button>
			</div>
		{/snippet}
	</ResourceTable>
</div>
