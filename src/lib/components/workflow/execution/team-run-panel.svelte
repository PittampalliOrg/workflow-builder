<!--
  Run-detail surface for a team run (engine `team-run`). A split view: the team
  ledger on the left (members + shared task list, each member selectable) and the
  selected teammate's LIVE session transcript on the right. Reuses the team-view
  endpoint (members + tasks) and SessionTranscript. Polls while the run is active.
-->
<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { Loader2, Bot } from '@lucide/svelte';
	import { Card, CardContent, CardHeader, CardTitle } from '$lib/components/ui/card';
	import { Badge } from '$lib/components/ui/badge';
	import SessionTranscript from '$lib/components/sessions/session-transcript.svelte';

	interface Props {
		executionId: string;
		slug: string;
		/** executionIr: { engine:'team-run', teamId, leadSessionId, meta:{name,description} } */
		executionIr: Record<string, unknown> | null;
		isRunning?: boolean;
	}
	let { executionIr, isRunning = false }: Props = $props();

	const teamId = $derived(
		typeof executionIr?.teamId === 'string' ? (executionIr.teamId as string) : null
	);
	const runName = $derived.by(() => {
		const m = (executionIr?.meta ?? {}) as Record<string, unknown>;
		return typeof m.name === 'string' ? m.name : 'Agent Team Run';
	});

	type View = {
		team: { id: string; name: string; status: string } | null;
		members: Array<{ name: string; role: string; status: string; sessionId: string }>;
		tasks: Array<{ id: string; title: string; status: string; assignee: string | null }>;
	};
	let view = $state<View | null>(null);
	let selectedSessionId = $state<string | null>(null);
	let timer: ReturnType<typeof setInterval> | undefined;

	async function load() {
		if (!teamId) return;
		try {
			const r = await fetch(`/api/v1/teams/${encodeURIComponent(teamId)}`);
			if (r.ok) {
				view = (await r.json()) as View;
				if (!selectedSessionId && view?.members.length) {
					// Default to the first working member, else the lead.
					const working = view.members.find((m) => m.status === 'working');
					selectedSessionId = (working ?? view.members[0]).sessionId;
				}
			}
		} catch {
			/* transient */
		}
	}

	onMount(() => {
		load();
		if (isRunning) timer = setInterval(load, 3000);
	});
	onDestroy(() => timer && clearInterval(timer));

	const doneCount = $derived(view?.tasks.filter((t) => t.status === 'completed').length ?? 0);
	function memberTone(s: string) {
		return s === 'working' ? 'default' : s === 'idle' ? 'secondary' : 'outline';
	}
	function taskTone(s: string) {
		return s === 'completed' ? 'default' : s === 'in_progress' ? 'secondary' : 'outline';
	}
</script>

<div class="flex h-full min-h-0">
	<!-- Left: team ledger -->
	<div class="w-80 shrink-0 overflow-y-auto border-r p-3 space-y-3">
		<div>
			<div class="flex items-center gap-2 text-sm font-medium">
				<Bot class="size-4" /> {runName}
			</div>
			{#if view?.team}
				<div class="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
					<Badge variant="outline">{view.team.status}</Badge>
					<span>{doneCount}/{view.tasks.length} tasks</span>
					<span>· {view.members.length} members</span>
				</div>
			{/if}
		</div>

		<Card>
			<CardHeader class="pb-2"><CardTitle class="text-xs">Teammates</CardTitle></CardHeader>
			<CardContent class="space-y-1" data-testid="team-run-members">
				{#each view?.members ?? [] as m (m.sessionId)}
					<button
						class="flex w-full items-center justify-between gap-2 rounded px-2 py-1 text-left text-sm hover:bg-muted {selectedSessionId ===
						m.sessionId
							? 'bg-muted'
							: ''}"
						onclick={() => (selectedSessionId = m.sessionId)}
					>
						<span>{m.name} <span class="text-muted-foreground">({m.role})</span></span>
						<Badge variant={memberTone(m.status)}>{m.status}</Badge>
					</button>
				{:else}
					<div class="px-2 text-sm text-muted-foreground">No members yet.</div>
				{/each}
			</CardContent>
		</Card>

		<Card>
			<CardHeader class="pb-2"><CardTitle class="text-xs">Tasks</CardTitle></CardHeader>
			<CardContent class="space-y-1" data-testid="team-run-tasks">
				{#each view?.tasks ?? [] as t (t.id)}
					<div class="flex items-center justify-between gap-2 text-sm">
						<span class="truncate">{t.title}</span>
						<Badge variant={taskTone(t.status)}>{t.status}</Badge>
					</div>
				{:else}
					<div class="text-sm text-muted-foreground">No tasks yet.</div>
				{/each}
			</CardContent>
		</Card>
	</div>

	<!-- Right: selected teammate's live transcript -->
	<div class="min-w-0 flex-1 overflow-hidden">
		{#if selectedSessionId}
			<SessionTranscript sessionId={selectedSessionId} compact showTimeline={false} />
		{:else}
			<div class="flex h-full items-center justify-center text-sm text-muted-foreground">
				{#if isRunning}<Loader2 size={16} class="mr-2 animate-spin" />{/if}
				Select a teammate to view its transcript.
			</div>
		{/if}
	</div>
</div>
