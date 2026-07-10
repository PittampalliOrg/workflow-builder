<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { Card, CardContent, CardHeader, CardTitle } from '$lib/components/ui/card';
	import { Users } from '@lucide/svelte';
	import TeamPulse, { type TeamPulseView } from '$lib/components/teams/team-pulse.svelte';
	import { page } from '$app/state';

	// Agent Teams panel: shows the team this session belongs to via the shared
	// TeamPulse surface (topology + activity + tasks), polling the session's team
	// endpoint. Renders nothing when the session is not part of a team. Member
	// clicks navigate to that member's session detail page.
	let { sessionId }: { sessionId: string } = $props();

	let view = $state<TeamPulseView | null>(null);
	let timer: ReturnType<typeof setInterval> | undefined;

	async function load() {
		try {
			const r = await fetch(`/api/v1/sessions/${encodeURIComponent(sessionId)}/team`);
			if (r.ok) view = (await r.json()) as TeamPulseView;
		} catch {
			/* transient */
		}
	}

	onMount(() => {
		load();
		timer = setInterval(load, 5000);
	});
	onDestroy(() => timer && clearInterval(timer));

	const slug = $derived(page.params.slug ?? null);
	function hrefForSession(id: string): string {
		return slug ? `/workspaces/${slug}/sessions/${id}` : `/sessions/${id}`;
	}
</script>

{#if view?.team}
	<Card data-testid="team-panel">
		<CardHeader>
			<CardTitle class="flex items-center gap-2 text-sm">
				<Users class="size-4 text-violet-300" /> Team
			</CardTitle>
		</CardHeader>
		<CardContent>
			<TeamPulse {view} selectedSessionId={sessionId} {hrefForSession} compact />
		</CardContent>
	</Card>
{/if}
