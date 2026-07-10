<!--
  Run-detail surface for a team run (engine `team-run`). A split view that reads
  like a dynamic-script run: the team ledger on the left (members with their
  CURRENT task, the shared task list with assignees, and a coordination activity
  feed) and the selected participant's LIVE session transcript on the right.
  Every member/task is selectable and drives the transcript, giving the
  task↔member↔transcript linkage a dynamic-script's script-graph has. Reuses the
  team-view endpoint and SessionTranscript. Polls while the run is active.
-->
<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { Loader2, Bot, Crown, CheckCircle2, CircleDot } from '@lucide/svelte';
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

	type Member = {
		name: string;
		role: string;
		status: string;
		sessionId: string;
		currentTaskId: string | null;
	};
	type Task = {
		id: string;
		title: string;
		status: string;
		assignee: string | null;
		assigneeName: string | null;
		dependsOn: string[];
	};
	type Activity = {
		ts: string;
		kind: 'claimed' | 'completed';
		taskId: string;
		taskTitle: string;
		memberName: string | null;
	};
	type View = {
		team: { id: string; name: string; status: string } | null;
		members: Member[];
		tasks: Task[];
		activity: Activity[];
	};
	let view = $state<View | null>(null);
	let selectedSessionId = $state<string | null>(null);
	let now = $state(0);
	let timer: ReturnType<typeof setInterval> | undefined;
	let clock: ReturnType<typeof setInterval> | undefined;

	async function load() {
		if (!teamId) return;
		try {
			const r = await fetch(`/api/v1/teams/${encodeURIComponent(teamId)}`);
			if (r.ok) {
				view = (await r.json()) as View;
				if (!selectedSessionId && view?.members.length) {
					// Default to the first working member, else the lead, else the first.
					const working = view.members.find((m) => m.status === 'working' && m.role !== 'lead');
					const lead = view.members.find((m) => m.role === 'lead');
					selectedSessionId = (working ?? lead ?? view.members[0]).sessionId;
				}
			}
		} catch {
			/* transient */
		}
	}

	onMount(() => {
		now = Date.now();
		load();
		clock = setInterval(() => (now = Date.now()), 1000);
		if (isRunning) timer = setInterval(load, 3000);
	});
	onDestroy(() => {
		if (timer) clearInterval(timer);
		if (clock) clearInterval(clock);
	});

	const doneCount = $derived(view?.tasks.filter((t) => t.status === 'completed').length ?? 0);
	const taskById = $derived(new Map((view?.tasks ?? []).map((t) => [t.id, t])));

	function memberTone(s: string) {
		return s === 'working' ? 'default' : s === 'idle' ? 'secondary' : 'outline';
	}
	function taskTone(s: string) {
		return s === 'completed' ? 'default' : s === 'in_progress' ? 'secondary' : 'outline';
	}
	/** Blocking deps that aren't completed yet — surfaced on pending task rows. */
	function blockedBy(t: Task): string[] {
		if (t.status !== 'pending') return [];
		return t.dependsOn.filter((d) => taskById.get(d)?.status !== 'completed');
	}
	function ago(ts: string): string {
		const ms = now - new Date(ts).getTime();
		if (!Number.isFinite(ms) || ms < 0) return 'just now';
		const s = Math.round(ms / 1000);
		if (s < 60) return `${s}s ago`;
		const m = Math.round(s / 60);
		if (m < 60) return `${m}m ago`;
		const h = Math.round(m / 60);
		if (h < 24) return `${h}h ago`;
		return `${Math.round(h / 24)}d ago`;
	}
	function selectTask(t: Task) {
		if (t.assignee) selectedSessionId = t.assignee;
	}
</script>

<div class="flex h-full min-h-0">
	<!-- Left: team ledger -->
	<div class="w-80 shrink-0 space-y-3 overflow-y-auto border-r p-3">
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
					{@const cur = m.currentTaskId ? taskById.get(m.currentTaskId) : null}
					<button
						class="flex w-full flex-col gap-0.5 rounded px-2 py-1 text-left text-sm hover:bg-muted {selectedSessionId ===
						m.sessionId
							? 'bg-muted'
							: ''}"
						onclick={() => (selectedSessionId = m.sessionId)}
					>
						<span class="flex items-center justify-between gap-2">
							<span class="flex items-center gap-1">
								{#if m.role === 'lead'}<Crown class="size-3 text-amber-500" />{/if}
								{m.name}
								<span class="text-muted-foreground">({m.role})</span>
							</span>
							<Badge variant={memberTone(m.status)}>{m.status}</Badge>
						</span>
						<span class="truncate text-xs text-muted-foreground">
							{#if cur}on {cur.title}{:else if m.role === 'lead'}coordinating{:else}—{/if}
						</span>
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
					{@const blockers = blockedBy(t)}
					<button
						class="flex w-full flex-col gap-0.5 rounded px-2 py-1 text-left hover:bg-muted disabled:cursor-default disabled:hover:bg-transparent {t.assignee &&
						selectedSessionId === t.assignee
							? 'bg-muted'
							: ''}"
						onclick={() => selectTask(t)}
						disabled={!t.assignee}
						title={t.assignee ? `View ${t.assigneeName ?? 'assignee'}'s transcript` : undefined}
					>
						<span class="flex items-center justify-between gap-2 text-sm">
							<span class="truncate">{t.title}</span>
							<Badge variant={taskTone(t.status)}>{t.status}</Badge>
						</span>
						<span class="truncate text-xs text-muted-foreground">
							{#if t.assigneeName}→ {t.assigneeName}{/if}
							{#if blockers.length}
								{t.assigneeName ? ' · ' : ''}needs {blockers
									.map((b) => taskById.get(b)?.title ?? b)
									.join(', ')}
							{/if}
						</span>
					</button>
				{:else}
					<div class="text-sm text-muted-foreground">No tasks yet.</div>
				{/each}
			</CardContent>
		</Card>

		{#if view?.activity?.length}
			<Card>
				<CardHeader class="pb-2"><CardTitle class="text-xs">Activity</CardTitle></CardHeader>
				<CardContent class="space-y-1.5" data-testid="team-run-activity">
					{#each view.activity as a (a.taskId + a.kind)}
						<div class="flex items-start gap-2 text-xs">
							{#if a.kind === 'completed'}
								<CheckCircle2 class="mt-0.5 size-3 shrink-0 text-emerald-500" />
							{:else}
								<CircleDot class="mt-0.5 size-3 shrink-0 text-sky-500" />
							{/if}
							<span class="min-w-0 flex-1">
								<span class="font-medium">{a.memberName ?? 'someone'}</span>
								{a.kind === 'completed' ? 'completed' : 'claimed'}
								<span class="text-muted-foreground">{a.taskTitle}</span>
								<span class="text-muted-foreground"> · {ago(a.ts)}</span>
							</span>
						</div>
					{/each}
				</CardContent>
			</Card>
		{/if}
	</div>

	<!-- Right: selected participant's live transcript -->
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
