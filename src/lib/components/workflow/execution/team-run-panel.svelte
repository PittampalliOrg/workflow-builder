<!--
  Run-detail surface for a team run (engine `team-run`). A split view that reads
  like a dynamic-script run: the shared TeamPulse surface on the left (topology
  with live message pulses, unified activity feed, task ledger) and the selected
  participant's LIVE session transcript on the right. Member/task clicks drive
  the transcript. Thin wrapper — TeamPulse owns the data + polling.
-->
<script lang="ts">
	import { Loader2, Bot } from '@lucide/svelte';
	import SessionTranscript from '$lib/components/sessions/session-transcript.svelte';
	import TeamPulse from '$lib/components/teams/team-pulse.svelte';

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
	const leadSessionId = $derived(
		typeof executionIr?.leadSessionId === 'string' ? (executionIr.leadSessionId as string) : null
	);
	const runName = $derived.by(() => {
		const m = (executionIr?.meta ?? {}) as Record<string, unknown>;
		return typeof m.name === 'string' ? m.name : 'Agent Team Run';
	});

	// Default to the lead's transcript; member/task clicks re-target it.
	let manualSessionId = $state<string | null>(null);
	const selectedSessionId = $derived(manualSessionId ?? leadSessionId);
</script>

<div class="flex h-full min-h-0">
	<!-- Left: the shared team pulse (self-polling) -->
	<div class="w-96 shrink-0 space-y-3 overflow-y-auto border-r p-3">
		<div class="flex items-center gap-2 text-sm font-medium">
			<Bot class="size-4" /> {runName}
		</div>
		{#if teamId}
			<TeamPulse
				{teamId}
				{isRunning}
				{selectedSessionId}
				onSelectMember={(m) => (manualSessionId = m.sessionId)}
			/>
		{:else}
			<div class="text-sm text-muted-foreground">No team attached to this run.</div>
		{/if}
	</div>

	<!-- Right: selected participant's live transcript -->
	<div class="min-w-0 flex-1 overflow-hidden">
		{#if selectedSessionId}
			{#key selectedSessionId}
				<SessionTranscript sessionId={selectedSessionId} compact showTimeline={false} />
			{/key}
		{:else}
			<div class="flex h-full items-center justify-center text-sm text-muted-foreground">
				{#if isRunning}<Loader2 size={16} class="mr-2 animate-spin" />{/if}
				Select a teammate to view its transcript.
			</div>
		{/if}
	</div>
</div>
