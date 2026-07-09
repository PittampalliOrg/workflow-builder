<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { Card, CardContent, CardHeader, CardTitle } from '$lib/components/ui/card';
	import { Badge } from '$lib/components/ui/badge';

	// Agent Teams panel: shows the team this session belongs to — its members and
	// the shared task list — polling the session's team endpoint. Renders nothing
	// when the session is not part of a team.
	let { sessionId }: { sessionId: string } = $props();

	type View = {
		team: { id: string; name: string; status: string } | null;
		members: Array<{ name: string; role: string; status: string; sessionId: string }>;
		tasks: Array<{ id: string; title: string; status: string; assignee: string | null }>;
	};

	let view = $state<View | null>(null);
	let timer: ReturnType<typeof setInterval> | undefined;

	async function load() {
		try {
			const r = await fetch(`/api/v1/sessions/${encodeURIComponent(sessionId)}/team`);
			if (r.ok) view = (await r.json()) as View;
		} catch {
			/* transient */
		}
	}

	onMount(() => {
		load();
		timer = setInterval(load, 5000);
	});
	onDestroy(() => timer && clearInterval(timer));

	function memberTone(s: string) {
		return s === 'working' ? 'default' : s === 'idle' ? 'secondary' : 'outline';
	}
	function taskTone(s: string) {
		return s === 'completed' ? 'default' : s === 'in_progress' ? 'secondary' : 'outline';
	}
</script>

{#if view?.team}
	<Card data-testid="team-panel">
		<CardHeader>
			<CardTitle class="flex items-center gap-2 text-sm">
				Team · {view.team.name}
				<Badge variant="outline">{view.members.length} members</Badge>
				<Badge variant="outline">{view.tasks.length} tasks</Badge>
			</CardTitle>
		</CardHeader>
		<CardContent class="space-y-3">
			<div>
				<div class="mb-1 text-xs font-medium text-muted-foreground">Teammates</div>
				<ul class="space-y-1" data-testid="team-members">
					{#each view.members as m (m.sessionId)}
						<li class="flex items-center justify-between gap-2 text-sm">
							<span>{m.name} <span class="text-muted-foreground">({m.role})</span></span>
							<Badge variant={memberTone(m.status)}>{m.status}</Badge>
						</li>
					{/each}
				</ul>
			</div>
			<div>
				<div class="mb-1 text-xs font-medium text-muted-foreground">Tasks</div>
				<ul class="space-y-1" data-testid="team-tasks">
					{#each view.tasks as t (t.id)}
						<li class="flex items-center justify-between gap-2 text-sm">
							<span class="truncate">{t.title}</span>
							<Badge variant={taskTone(t.status)}>{t.status}</Badge>
						</li>
					{:else}
						<li class="text-sm text-muted-foreground">No tasks yet.</li>
					{/each}
				</ul>
			</div>
		</CardContent>
	</Card>
{/if}
