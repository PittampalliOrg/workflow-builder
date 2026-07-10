<!--
  TeamPulse — THE shared team surface: topology (hub + members + message
  pulses), unified activity timeline, and a collapsible task ledger. Used by
  the dynamic-script run console, the team-run panel, and the session-detail
  team panel so every team reads the same everywhere.

  Dual-mode like ScriptPhaseRail: presentational when `view` is provided (the
  host owns polling), self-polling (~3s while isRunning) when only `teamId` is
  given. `view.team === null` renders nothing (safe probe).
-->
<script lang="ts" module>
	export type TeamPulseView = {
		team: { id: string; name: string; status: string } | null;
		members: Array<{
			name: string;
			role: string;
			status: string;
			sessionId: string;
			currentTaskId: string | null;
		}>;
		tasks: Array<{
			id: string;
			title: string;
			status: string;
			assignee: string | null;
			assigneeName: string | null;
			dependsOn: string[];
		}>;
		activity?: Array<{
			ts: string;
			kind: 'claimed' | 'completed';
			taskId: string;
			taskTitle: string;
			memberName: string | null;
		}>;
		recentMessages?: Array<{
			ts: string;
			from: string | null;
			to: string | null;
			toSessionId: string;
			kind: string;
			preview: string | null;
		}>;
	};
</script>

<script lang="ts">
	import { ChevronDown, ChevronRight, Users } from '@lucide/svelte';
	import { Badge } from '$lib/components/ui/badge';
	import TeamTopology from './team-topology.svelte';
	import TeamActivityFeed from './team-activity-feed.svelte';

	interface Props {
		/** Self-polling mode: probe /api/v1/teams/{teamId} every 3s while running. */
		teamId?: string | null;
		/** Presentational mode: the host owns the data + polling. */
		view?: TeamPulseView | null;
		isRunning?: boolean;
		hubKind?: 'script' | 'lead';
		selectedSessionId?: string | null;
		onSelectMember?: (m: { name: string; sessionId: string }) => void;
		hrefForSession?: (sessionId: string) => string;
		compact?: boolean;
		class?: string;
	}
	let {
		teamId = null,
		view = null,
		isRunning = false,
		hubKind = 'lead',
		selectedSessionId = null,
		onSelectMember,
		hrefForSession,
		compact = false,
		class: klass = ''
	}: Props = $props();

	let polled = $state<TeamPulseView | null>(null);
	const effective = $derived(view ?? polled);

	async function load() {
		if (!teamId) return;
		try {
			const r = await fetch(`/api/v1/teams/${encodeURIComponent(teamId)}`);
			if (r.ok) polled = (await r.json()) as TeamPulseView;
		} catch {
			/* transient */
		}
	}
	$effect(() => {
		if (view !== null || !teamId) return; // presentational — host owns polling
		void teamId;
		load();
		if (!isRunning) return;
		const t = setInterval(load, 3000);
		return () => clearInterval(t);
	});

	const doneCount = $derived(
		effective?.tasks.filter((t) => t.status === 'completed').length ?? 0
	);
	const taskCount = $derived(effective?.tasks.length ?? 0);
	const taskTitleById = $derived(new Map((effective?.tasks ?? []).map((t) => [t.id, t.title])));
	const taskById = $derived(new Map((effective?.tasks ?? []).map((t) => [t.id, t])));

	// Open by default on full surfaces; the user's toggle wins once used.
	let tasksOpenOverride = $state<boolean | null>(null);
	const tasksOpen = $derived(tasksOpenOverride ?? !compact);

	function taskTone(s: string) {
		return s === 'completed' ? 'default' : s === 'in_progress' ? 'secondary' : 'outline';
	}
	/** Unmet blockers for a pending task ("needs …" caption). */
	function blockedBy(t: { status: string; dependsOn: string[] }): string[] {
		if (t.status !== 'pending') return [];
		return t.dependsOn.filter((d) => taskById.get(d)?.status !== 'completed');
	}
	// SVG progress ring geometry (r=8 → C ≈ 50.27).
	const RING_C = 2 * Math.PI * 8;
</script>

{#if effective?.team}
	<div class="space-y-2.5 {klass}" data-testid="team-pulse">
		<!-- header -->
		<div class="flex items-center gap-2">
			<Users class="size-4 shrink-0 text-violet-300" />
			<span class="truncate text-sm font-semibold">{effective.team.name}</span>
			<Badge variant="outline" class="text-[10px]">{effective.team.status}</Badge>
			<span class="ml-auto flex shrink-0 items-center gap-1.5 text-[11px] text-muted-foreground">
				{#if taskCount > 0}
					<svg viewBox="0 0 20 20" class="size-4 -rotate-90">
						<circle cx="10" cy="10" r="8" class="fill-none stroke-muted-foreground/20" stroke-width="3" />
						<circle
							cx="10"
							cy="10"
							r="8"
							class="fill-none stroke-emerald-400 transition-all duration-700"
							stroke-width="3"
							stroke-linecap="round"
							stroke-dasharray={RING_C}
							stroke-dashoffset={RING_C * (1 - (taskCount ? doneCount / taskCount : 0))}
						/>
					</svg>
					{doneCount}/{taskCount} tasks
				{/if}
				<span>· {effective.members.length} members</span>
			</span>
		</div>

		<!-- topology -->
		<TeamTopology
			members={effective.members}
			recentMessages={effective.recentMessages ?? []}
			{taskTitleById}
			{hubKind}
			{selectedSessionId}
			{onSelectMember}
			{hrefForSession}
		/>

		<!-- unified feed -->
		<TeamActivityFeed
			activity={effective.activity ?? []}
			recentMessages={effective.recentMessages ?? []}
			maxItems={compact ? 8 : 20}
			class="max-h-56 overflow-y-auto pr-1"
		/>

		<!-- task ledger -->
		{#if taskCount > 0}
			<div class="rounded-lg border border-border/60">
				<button
					type="button"
					class="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium hover:bg-accent/40"
					onclick={() => (tasksOpenOverride = !tasksOpen)}
				>
					{#if tasksOpen}<ChevronDown class="size-3.5" />{:else}<ChevronRight class="size-3.5" />{/if}
					Tasks
					<span class="text-muted-foreground">({doneCount}/{taskCount})</span>
				</button>
				{#if tasksOpen}
					<div class="divide-y divide-border/40 border-t border-border/60">
						{#each effective.tasks as t (t.id)}
							{@const blockers = blockedBy(t)}
							<button
								type="button"
								class="flex w-full flex-col gap-0.5 px-2.5 py-1.5 text-left hover:bg-accent/30 disabled:cursor-default disabled:hover:bg-transparent"
								disabled={!t.assignee || !onSelectMember}
								onclick={() =>
									t.assignee &&
									onSelectMember?.({ name: t.assigneeName ?? '', sessionId: t.assignee })}
								title={t.assignee ? `View ${t.assigneeName ?? 'assignee'}'s transcript` : undefined}
							>
								<span class="flex items-center justify-between gap-2 text-xs">
									<span class="truncate">{t.title}</span>
									<Badge variant={taskTone(t.status)} class="text-[9px]">{t.status}</Badge>
								</span>
								{#if t.assigneeName || blockers.length}
									<span class="truncate text-[10px] text-muted-foreground">
										{#if t.assigneeName}→ {t.assigneeName}{/if}
										{#if blockers.length}
											{t.assigneeName ? ' · ' : ''}needs {blockers
												.map((b) => taskById.get(b)?.title ?? b)
												.join(', ')}
										{/if}
									</span>
								{/if}
							</button>
						{/each}
					</div>
				{/if}
			</div>
		{/if}
	</div>
{/if}
