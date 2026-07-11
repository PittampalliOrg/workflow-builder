<!--
  Team Live Board — the "newsroom" strip for the Live tab of a team run: one
  card per member showing WHAT IT IS DOING RIGHT NOW (classified from its
  latest session event, member-identity colored, pulsing while fresh), plus an
  expandable merged ticker of the last events across the whole team. Clicking
  a member focuses its transcript in the host console.

  Self-polls /api/v1/teams/{teamId}/live (~3s while isRunning; one final fetch
  when the run stops so the board settles on terminal states).
-->
<script lang="ts">
	import { ChevronDown, ChevronRight, Activity } from '@lucide/svelte';
	import { fly } from 'svelte/transition';
	import { memberColor, memberInitials } from './member-color';
	import {
		classifyMemberStatus,
		classifyTeamEvent,
		type ActivityTone
	} from './team-activity-classify';

	type LiveMember = {
		name: string;
		role: string;
		status: string;
		sessionId: string;
		event: {
			type: string;
			tool: string | null;
			origin: string | null;
			from: string | null;
			preview: string | null;
			at: string;
		} | null;
	};
	type LiveStreamItem = {
		member: string;
		sessionId: string;
		type: string;
		tool: string | null;
		origin: string | null;
		from: string | null;
		preview: string | null;
		at: string;
	};

	interface Props {
		teamId: string;
		isRunning?: boolean;
		selectedSessionId?: string | null;
		onSelectMember?: (sessionId: string) => void;
		class?: string;
	}
	let {
		teamId,
		isRunning = false,
		selectedSessionId = null,
		onSelectMember,
		class: klass = ''
	}: Props = $props();

	let members = $state<LiveMember[]>([]);
	let stream = $state<LiveStreamItem[]>([]);
	let tickerOpen = $state(false);

	async function load() {
		try {
			const r = await fetch(`/api/v1/teams/${encodeURIComponent(teamId)}/live`);
			if (!r.ok) return;
			const d = (await r.json()) as { members: LiveMember[]; stream: LiveStreamItem[] };
			members = d.members ?? [];
			stream = d.stream ?? [];
		} catch {
			/* transient */
		}
	}
	$effect(() => {
		void teamId;
		load();
		if (!isRunning) return;
		const t = setInterval(load, 3000);
		return () => clearInterval(t);
	});

	// Live clock for freshness pulses + ago labels.
	let now = $state(Date.now());
	$effect(() => {
		if (!isRunning) return;
		const t = setInterval(() => (now = Date.now()), 1000);
		return () => clearInterval(t);
	});
	function ageMs(at: string | null | undefined): number {
		if (!at) return Number.POSITIVE_INFINITY;
		const t = new Date(at).getTime();
		return Number.isFinite(t) ? Math.max(0, now - t) : Number.POSITIVE_INFINITY;
	}
	function ago(at: string | null | undefined): string {
		const ms = ageMs(at);
		if (!Number.isFinite(ms)) return '';
		const s = Math.round(ms / 1000);
		if (s < 5) return 'now';
		if (s < 60) return `${s}s`;
		const m = Math.round(s / 60);
		if (m < 60) return `${m}m`;
		return `${Math.round(m / 60)}h`;
	}

	function activityFor(m: LiveMember): { label: string; tone: ActivityTone } {
		// Terminal member states beat stale events.
		if (m.status === 'failed' || m.status === 'shutdown' || m.status === 'suspended') {
			return classifyMemberStatus(m.status);
		}
		return m.event ? classifyTeamEvent(m.event) : classifyMemberStatus(m.status);
	}

	const TONE_TEXT: Record<ActivityTone, string> = {
		working: 'text-teal-300',
		coord: 'text-violet-300',
		idle: 'text-muted-foreground',
		error: 'text-red-300'
	};
</script>

{#if members.length > 0}
	<div class="border-b border-border bg-muted/10 {klass}" data-testid="team-live-board">
		<!-- member "now" cards -->
		<div class="flex flex-nowrap items-stretch gap-1.5 overflow-x-auto px-3 py-1.5">
			{#each members as m (m.sessionId)}
				{@const c = memberColor(m.role === 'lead' ? 'lead' : m.name)}
				{@const act = activityFor(m)}
				{@const fresh = ageMs(m.event?.at) < 10_000 && m.status === 'working'}
				<button
					type="button"
					class="flex min-w-40 shrink-0 items-center gap-2 rounded-md border px-2 py-1 text-left transition hover:bg-accent/40
						{selectedSessionId === m.sessionId ? 'border-primary/50 bg-primary/10' : 'border-border/60 bg-background'}"
					onclick={() => onSelectMember?.(m.sessionId)}
					title={m.event?.preview ? `${act.label} — ${m.event.preview}` : act.label}
				>
					<span class="relative flex size-7 shrink-0 items-center justify-center rounded-full {c.bg} border {c.ring}">
						<span class="text-[10px] font-bold {m.status === 'shutdown' ? 'text-muted-foreground' : c.text}">
							{memberInitials(m.name)}
						</span>
						{#if fresh}
							<span class="absolute -right-0.5 -top-0.5 size-2 animate-ping rounded-full {c.dot}"></span>
							<span class="absolute -right-0.5 -top-0.5 size-2 rounded-full {c.dot}"></span>
						{/if}
					</span>
					<span class="min-w-0 leading-tight">
						<span class="block truncate text-[11px] font-medium {m.status === 'shutdown' ? 'text-muted-foreground line-through' : ''}">
							{m.name}
						</span>
						<span class="block truncate text-[10px] {TONE_TEXT[act.tone]}">
							{act.label}{m.event?.at ? ` · ${ago(m.event.at)}` : ''}
						</span>
					</span>
				</button>
			{/each}

			<!-- ticker toggle -->
			<button
				type="button"
				class="ml-auto flex shrink-0 items-center gap-1 self-center rounded-md px-2 py-1 text-[11px] text-muted-foreground transition hover:bg-accent/40"
				onclick={() => (tickerOpen = !tickerOpen)}
				title="Merged team event ticker"
			>
				<Activity class="size-3.5" />
				{#if tickerOpen}<ChevronDown class="size-3" />{:else}<ChevronRight class="size-3" />{/if}
			</button>
		</div>

		<!-- merged ticker -->
		{#if tickerOpen}
			<div class="max-h-44 overflow-y-auto border-t border-border/60 px-3 py-1.5" transition:fly={{ y: -4, duration: 150 }}>
				{#each stream as e (e.at + e.sessionId + e.type)}
					{@const c = memberColor(e.member === 'lead' ? 'lead' : e.member)}
					{@const act = classifyTeamEvent(e)}
					<button
						type="button"
						class="flex w-full items-baseline gap-2 rounded px-1 py-0.5 text-left text-[11px] hover:bg-accent/30"
						onclick={() => onSelectMember?.(e.sessionId)}
					>
						<span class="w-10 shrink-0 text-right font-mono text-[10px] text-muted-foreground/60">{ago(e.at)}</span>
						<span class="inline-flex shrink-0 items-center gap-1 font-medium {c.text}">
							<span class="size-1.5 rounded-full {c.dot}"></span>{e.member}
						</span>
						<span class="shrink-0 {TONE_TEXT[act.tone]}">{act.label}</span>
						{#if e.preview}
							<span class="truncate text-muted-foreground/70">— {e.preview}</span>
						{/if}
					</button>
				{/each}
			</div>
		{/if}
	</div>
{/if}
