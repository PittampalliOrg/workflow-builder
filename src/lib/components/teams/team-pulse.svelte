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
		team: {
			id: string;
			name: string;
			status: string;
			tokenBudget?: number | null;
			tokensUsed?: number;
		} | null;
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
			/** Deliverable text the completer passed via update_task note. */
			note?: string | null;
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
		/** OKF knowledge index — what the team has published (no bodies). */
		knowledge?: Array<{
			path: string;
			type: string;
			title: string | null;
			description: string | null;
			author: string | null;
			updatedAt: string;
		}>;
	};
</script>

<script lang="ts">
	import { BookOpen, ChevronDown, ChevronRight, Users } from '@lucide/svelte';
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

	const knowledge = $derived(effective?.knowledge ?? []);
	let knowledgeOpenOverride = $state<boolean | null>(null);
	const knowledgeOpen = $derived(knowledgeOpenOverride ?? !compact);

	// Token budget (enforced server-side; this is the legibility half).
	const budget = $derived.by(() => {
		const b = effective?.team?.tokenBudget;
		if (b == null || b <= 0) return null;
		const used = effective?.team?.tokensUsed ?? 0;
		return { total: b, used, pct: Math.min(100, Math.round((used / b) * 100)) };
	});
	function fmtTok(n: number): string {
		if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
		if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`;
		return String(n);
	}
</script>

{#if effective?.team}
	<div class="space-y-2.5 {klass}" data-testid="team-pulse">
		<!-- header -->
		<div class="flex items-center gap-2">
			<Users class="size-4 shrink-0 text-violet-300" />
			<span class="truncate text-sm font-semibold">{effective.team.name}</span>
			<Badge variant="outline" class="text-[10px]">{effective.team.status}</Badge>
			<span class="ml-auto flex shrink-0 items-center gap-1.5 text-[11px] text-muted-foreground">
				{#if budget}
					<span
						class="rounded-full border px-1.5 py-0 text-[10px] tabular-nums {budget.pct >= 100
							? 'border-red-400/40 text-red-300'
							: budget.pct >= 80
								? 'border-amber-400/40 text-amber-300'
								: 'border-border/60 text-muted-foreground'}"
						title="Team token budget: {budget.used.toLocaleString()} of {budget.total.toLocaleString()} tokens used{budget.pct >= 100 ? ' — exhausted: no new spawns or claim nudges' : ''}"
					>
						{fmtTok(budget.used)}/{fmtTok(budget.total)}
					</span>
				{/if}
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
								{#if t.note}
									<!-- The deliverable: what the completer handed back via update_task. -->
									<span
										class="line-clamp-2 rounded border-l-2 border-emerald-400/40 bg-emerald-500/5 px-1.5 py-0.5 text-[10px] leading-snug text-foreground/80"
										title={t.note}
									>
										{t.note}
									</span>
								{/if}
							</button>
						{/each}
					</div>
				{/if}
			</div>
		{/if}

		<!-- knowledge (OKF bundle index) -->
		{#if knowledge.length > 0}
			<div class="rounded-lg border border-border/60">
				<button
					type="button"
					class="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium hover:bg-accent/40"
					onclick={() => (knowledgeOpenOverride = !knowledgeOpen)}
				>
					{#if knowledgeOpen}<ChevronDown class="size-3.5" />{:else}<ChevronRight class="size-3.5" />{/if}
					<BookOpen class="size-3.5 text-sky-300" />
					Knowledge
					<span class="text-muted-foreground">({knowledge.length})</span>
				</button>
				{#if knowledgeOpen}
					<div class="divide-y divide-border/40 border-t border-border/60">
						{#each knowledge as k (k.path)}
							<div class="flex flex-col gap-0.5 px-2.5 py-1.5" title={k.description ?? k.path}>
								<span class="flex items-center justify-between gap-2 text-xs">
									<span class="truncate">{k.title ?? k.path}</span>
									<Badge variant="outline" class="shrink-0 text-[9px]">{k.type}</Badge>
								</span>
								<span class="truncate text-[10px] text-muted-foreground">
									/{k.path}{k.author ? ` · by ${k.author}` : ''}
								</span>
							</div>
						{/each}
					</div>
				{/if}
			</div>
		{/if}
	</div>
{/if}
