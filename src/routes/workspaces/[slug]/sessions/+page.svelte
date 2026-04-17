<script lang="ts">
	import { goto } from '$app/navigation';
	import { onMount } from 'svelte';
	import { Badge } from '$lib/components/ui/badge';
	import {
		Card,
		CardContent,
		CardHeader,
		CardTitle
	} from '$lib/components/ui/card';
	import { MessagesSquare, Plus } from 'lucide-svelte';
	import ResourceListShell from '$lib/components/console/resource-list-shell.svelte';
	import { Button } from '$lib/components/ui/button';
	import type { SessionSummary } from '$lib/types/sessions';
	import type { AgentSummary } from '$lib/types/agents';

	let sessions = $state<SessionSummary[]>([]);
	let agents = $state<AgentSummary[]>([]);
	let loading = $state(true);
	let errorMessage = $state<string | null>(null);
	let search = $state('');

	let agentsById = $derived.by(() => {
		const m = new Map<string, AgentSummary>();
		for (const a of agents) m.set(a.id, a);
		return m;
	});
	let filtered = $derived.by(() => {
		const q = search.trim().toLowerCase();
		if (!q) return sessions;
		return sessions.filter((s) => {
			const agent = agentsById.get(s.agentId);
			const hay = `${s.title ?? ''} ${agent?.name ?? ''}`.toLowerCase();
			return hay.includes(q);
		});
	});

	async function load() {
		loading = true;
		errorMessage = null;
		try {
			const [sRes, aRes] = await Promise.all([
				fetch('/api/v1/sessions'),
				fetch('/api/agents')
			]);
			if (!sRes.ok) {
				errorMessage = `Failed to load sessions (${sRes.status})`;
				return;
			}
			const sData = (await sRes.json()) as { sessions: SessionSummary[] };
			sessions = sData.sessions ?? [];
			if (aRes.ok) {
				const aData = (await aRes.json()) as { agents: AgentSummary[] };
				agents = aData.agents ?? [];
			}
		} catch (err) {
			errorMessage = err instanceof Error ? err.message : String(err);
		} finally {
			loading = false;
		}
	}

	function statusColor(status: string): string {
		switch (status) {
			case 'running':
				return 'bg-blue-500/15 text-blue-600';
			case 'idle':
				return 'bg-amber-500/15 text-amber-600';
			case 'terminated':
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
		return new Date(iso).toLocaleDateString();
	}

	onMount(load);
</script>

<ResourceListShell
	title="Sessions"
	subtitle="Trace and debug Claude Managed Agents sessions."
	itemLabel="session"
	itemCount={sessions.length}
	onSearch={(v) => (search = v)}
	primaryLabel="New Session"
	onPrimary={() => goto('/workspaces/default/sessions/new')}
	{loading}
	{errorMessage}
	isEmpty={sessions.length === 0 || filtered.length === 0}
	{content}
	{empty}
/>

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
		<div class="text-center text-muted-foreground py-12">No sessions match your search.</div>
	{/if}
{/snippet}
