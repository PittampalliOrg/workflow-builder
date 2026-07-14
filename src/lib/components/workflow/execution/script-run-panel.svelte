<!--
  Run-detail surface for a dynamic-script (engineType `dynamic-script`) execution.

  A SPLIT "follow-along" view: the phase-swimlane graph on the left (phases as
  lanes, each agent()/parallel()/pipeline()/workflow()/team.*() call a
  selectable card with a live status chip, retries/error, session link +
  Kill/Skip), and the selected call's LIVE session transcript on the right.
  "Follow latest" tracks the currently-running agent — and, when the run leads
  a team, the most recently ACTIVE teammate — so you watch the action while
  the graph shows where the run is. Polls /script-calls (~3s) while active.

  Team-led runs (the `team.*` dialect) additionally get the shared TeamPulse
  surface: a compact ledger in the left rail, and the full pulse (topology +
  message pulses + activity) as the right pane when a sessionless team row
  (task/send/broadcast/join) is selected. teamId is deterministic
  (`team-<executionId>`); the probe returns {team:null} for team-less runs.
-->
<script lang="ts">
	import { Loader2, Bot, Radio, MessageSquare, Users } from '@lucide/svelte';
	import SessionTranscript from '$lib/components/sessions/session-transcript.svelte';
	import ScriptCanvas from '$lib/components/workflow/script-canvas.svelte';
	import type { CallLineState } from '$lib/utils/script-graph-adapter';
	import ScriptPhaseRail, {
		scriptCallLabel,
		type ScriptCall
	} from './script-phase-rail.svelte';
	import TeamPulse, { type TeamPulseView } from '$lib/components/teams/team-pulse.svelte';

	interface Props {
		executionId: string;
		slug: string;
		/** executionIr: { engine, script, meta:{name,description,phases,...}, args, budgetTotal } */
		executionIr: Record<string, unknown> | null;
		/** Current phase from the live custom status / execution.phase column. */
		currentPhase?: string | null;
		isRunning?: boolean;
	}

	let { executionId, slug, executionIr, currentPhase = null, isRunning = false }: Props = $props();

	const meta = $derived.by(() => {
		const m = (executionIr?.meta ?? {}) as Record<string, unknown>;
		return {
			name: typeof m.name === 'string' ? m.name : 'Dynamic script',
			description: typeof m.description === 'string' ? m.description : null,
			phases: normalizePhases(m.phases)
		};
	});

	function normalizePhases(raw: unknown): string[] {
		if (!Array.isArray(raw)) return [];
		const out: string[] = [];
		for (const p of raw) {
			if (typeof p === 'string') out.push(p);
			else if (p && typeof p === 'object') {
				const t = (p as Record<string, unknown>).title;
				if (typeof t === 'string') out.push(t);
			}
		}
		return out;
	}

	const budgetTotal = $derived(
		typeof executionIr?.budgetTotal === 'number' ? (executionIr.budgetTotal as number) : null
	);

	let calls = $state<ScriptCall[]>([]);
	let loaded = $state(false);
	let error = $state<string | null>(null);

	// Team probe: deterministic id; {team:null} for team-less runs (hides all
	// team UI). Fetched in the same 3s cycle as the call journal.
	const teamId = $derived(`team-${executionId}`);
	let teamView = $state<TeamPulseView | null>(null);
	const hasTeam = $derived(!!teamView?.team);

	// Selection + follow-along. The user's explicit click lands in
	// manualCallId/teamSelected; the EFFECTIVE selection is derived — when
	// followLatest is on it tracks the action automatically.
	let manualCallId = $state<string | null>(null);
	let teamSelected = $state(false);
	let followLatest = $state(true);

	const agentCalls = $derived(calls.filter((c) => c.kind === 'agent'));

	// P2b: List | Graph toggle. Graph = the static ScriptCanvas (parsed from the
	// run's FROZEN source) with a live per-line journal overlay joined on the
	// evaluator-captured call_site.line.
	let view = $state<'list' | 'graph'>('list');
	const scriptSource = $derived(
		typeof (executionIr as { script?: unknown } | null)?.script === 'string'
			? ((executionIr as { script: string }).script)
			: null
	);
	const callStates = $derived.by(() => {
		const map: Record<number, CallLineState> = {};
		for (const c of calls) {
			const line = c.callSite?.line;
			if (typeof line !== 'number') continue;
			const st = (map[line] ??= {
				total: 0,
				running: 0,
				done: 0,
				error: 0,
				skipped: 0,
				runningSessionIds: [],
				runningCallIds: []
			});
			st.total += 1;
			if (c.status === 'running') {
				st.running += 1;
				st.runningCallIds.push(c.callId);
				if (c.sessionId) st.runningSessionIds.push(c.sessionId);
			} else if (c.status === 'done') st.done += 1;
			else if (c.status === 'error') st.error += 1;
			else if (c.status === 'skipped') st.skipped += 1;
		}
		return map;
	});
	const unmappedCalls = $derived(
		calls.filter((c) => typeof c.callSite?.line !== 'number').length
	);

	async function killSessionById(sessionId: string) {
		try {
			await fetch(`/api/v1/sessions/${encodeURIComponent(sessionId)}/stop`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ mode: 'interrupt' })
			});
			fetchCalls();
		} catch {
			/* poll surfaces the state */
		}
	}
	async function skipCallById(callId: string) {
		try {
			await fetch(
				`/api/workflows/executions/${encodeURIComponent(executionId)}/script-calls/${encodeURIComponent(callId)}/skip`,
				{ method: 'POST' }
			);
			fetchCalls();
		} catch {
			/* poll surfaces the state */
		}
	}
	const tallies = $derived({
		total: calls.length,
		done: calls.filter((c) => c.status === 'done').length,
		running: calls.filter((c) => c.status === 'running').length,
		error: calls.filter((c) => c.status === 'error').length,
		agents: agentCalls.length
	});
	// Progress ring = resolved calls / total (the journal has no per-call tokens).
	const progressPct = $derived(
		calls.length > 0
			? Math.round(
					(calls.filter((c) => c.status === 'done' || c.status === 'skipped' || c.status === 'error').length /
						calls.length) *
						100
				)
			: 0
	);

	/** Most recently ACTIVE teammate session (activity ∪ messages), prefer working. */
	const latestTeammateSessionId = $derived.by(() => {
		if (!teamView?.team) return null;
		const bySession = new Map<string, string>(); // sessionId -> latest ts
		const nameToSession = new Map(teamView.members.map((m) => [m.name, m.sessionId]));
		for (const a of teamView.activity ?? []) {
			const sid = a.memberName ? nameToSession.get(a.memberName) : null;
			if (sid && (bySession.get(sid) ?? '') < a.ts) bySession.set(sid, a.ts);
		}
		for (const m of teamView.recentMessages ?? []) {
			if ((bySession.get(m.toSessionId) ?? '') < m.ts) bySession.set(m.toSessionId, m.ts);
		}
		const ranked = [...bySession.entries()].sort((a, b) => (a[1] < b[1] ? 1 : -1));
		const working = new Set(
			teamView.members.filter((m) => m.status === 'working').map((m) => m.sessionId)
		);
		const preferred = ranked.find(([sid]) => working.has(sid)) ?? ranked[0];
		return preferred?.[0] ?? null;
	});

	// Effective right-pane selection.
	const selection = $derived.by<{ kind: 'team' } | { kind: 'call'; call: ScriptCall } | null>(() => {
		if (!followLatest) {
			if (teamSelected) return { kind: 'team' };
			const call = calls.find((c) => c.callId === manualCallId);
			return call ? { kind: 'call', call } : null;
		}
		// follow-the-action: running agent → active teammate → latest resolved agent
		const withSession = agentCalls.filter((c) => c.sessionId);
		const running = withSession.find((c) => c.status === 'running');
		if (running) return { kind: 'call', call: running };
		if (latestTeammateSessionId) {
			// synthesize a call-like selection targeting the teammate session
			return { kind: 'call', call: teammateAsCall(latestTeammateSessionId) };
		}
		const latest = [...withSession].sort((a, b) => b.seq - a.seq)[0];
		return latest ? { kind: 'call', call: latest } : hasTeam ? { kind: 'team' } : null;
	});

	function teammateAsCall(sessionId: string): ScriptCall {
		const member = teamView?.members.find((m) => m.sessionId === sessionId);
		return {
			callId: `teammate:${sessionId}`,
			seq: Number.MAX_SAFE_INTEGER,
			kind: 'team',
			label: member ? `teammate ${member.name}` : 'teammate',
			phase: null,
			status: 'running',
			sessionId,
			tokensUsed: 0,
			errorCode: null,
			retries: 0
		};
	}

	const selectedCall = $derived(selection?.kind === 'call' ? selection.call : null);
	const selectedSessionId = $derived(selectedCall?.sessionId ?? null);
	const showTeamPane = $derived(selection?.kind === 'team' && hasTeam);

	function selectCall(call: ScriptCall) {
		followLatest = false;
		if (call.sessionId) {
			teamSelected = false;
			manualCallId = call.callId;
		} else if (call.kind === 'team') {
			// sessionless team rows (task/send/broadcast/join) open the pulse
			teamSelected = true;
			manualCallId = null;
		}
	}

	function selectMember(m: { name: string; sessionId: string }) {
		followLatest = false;
		teamSelected = false;
		// synthesize a manual selection via a teammate pseudo-call
		manualCallId = null;
		pinnedTeammateSession = m.sessionId;
	}
	let pinnedTeammateSession = $state<string | null>(null);
	const effectiveSessionId = $derived(
		!followLatest && pinnedTeammateSession && !teamSelected && !manualCallId
			? pinnedTeammateSession
			: selectedSessionId
	);
	const effectiveHeaderLabel = $derived.by(() => {
		if (showTeamPane) return 'Team pulse';
		if (!followLatest && pinnedTeammateSession && !manualCallId) {
			const member = teamView?.members.find((m) => m.sessionId === pinnedTeammateSession);
			return member ? `teammate ${member.name}` : 'teammate';
		}
		return selectedCall ? scriptCallLabel(selectedCall) : null;
	});

	async function fetchCalls() {
		try {
			const [callsRes, teamRes] = await Promise.all([
				fetch(`/api/workflows/executions/${encodeURIComponent(executionId)}/script-calls`),
				fetch(`/api/v1/teams/${encodeURIComponent(teamId)}`)
			]);
			if (callsRes.ok) {
				const data = (await callsRes.json()) as { scriptCalls?: ScriptCall[] };
				calls = Array.isArray(data.scriptCalls) ? data.scriptCalls : [];
				error = null;
			} else {
				throw new Error(`HTTP ${callsRes.status}`);
			}
			if (teamRes.ok) teamView = (await teamRes.json()) as TeamPulseView;
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to load script calls';
		} finally {
			loaded = true;
		}
	}

	$effect(() => {
		void executionId;
		fetchCalls();
		if (!isRunning) return;
		const t = setInterval(fetchCalls, 3000);
		return () => clearInterval(t);
	});

	const R = 26;
	const CIRC = 2 * Math.PI * R;
</script>

<div class="flex h-full min-h-0">
	<!-- LEFT: phase graph (+ compact team pulse when the run leads a team) -->
	<div class="flex w-[400px] shrink-0 flex-col overflow-y-auto border-r border-border">
		<!-- Summary header -->
		<div class="flex items-start justify-between gap-3 border-b border-border p-3">
			<div class="min-w-0 space-y-1">
				<div class="flex items-center gap-2">
					<h2 class="truncate text-base font-semibold">{meta.name}</h2>
					{#if isRunning}
						<span class="inline-flex items-center gap-1 rounded-full bg-primary/15 px-2 py-0.5 text-[10px] font-medium text-primary">
							<Loader2 class="size-3 animate-spin" /> running
						</span>
					{/if}
				</div>
				{#if meta.description}
					<p class="line-clamp-2 text-xs text-muted-foreground">{meta.description}</p>
				{/if}
				<div class="flex flex-wrap items-center gap-x-2.5 gap-y-1 pt-0.5 text-[11px] text-muted-foreground">
					<span><span class="font-medium text-foreground">{tallies.agents}</span> agents</span>
					{#if hasTeam}
						<span class="text-violet-300">{teamView!.members.filter((m) => m.role !== 'lead').length} teammates</span>
					{/if}
					<span class="text-emerald-400">{tallies.done} done</span>
					{#if tallies.running > 0}<span class="text-primary">{tallies.running} running</span>{/if}
					{#if tallies.error > 0}<span class="text-destructive">{tallies.error} failed</span>{/if}
				</div>
				{#if budgetTotal != null}
					<div class="text-[10px] text-muted-foreground/70">budget {Math.round(budgetTotal / 1000)}k tokens</div>
				{/if}
			</div>

			<!-- Progress ring (resolved calls / total) -->
			<div class="flex shrink-0 flex-col items-center">
				<svg width="60" height="60" viewBox="0 0 64 64" class="-rotate-90">
					<circle cx="32" cy="32" r={R} fill="none" stroke="currentColor" class="text-muted/40" stroke-width="6" />
					<circle
						cx="32"
						cy="32"
						r={R}
						fill="none"
						stroke="currentColor"
						class={tallies.error > 0 ? 'text-destructive' : 'text-primary'}
						stroke-width="6"
						stroke-linecap="round"
						stroke-dasharray={CIRC}
						stroke-dashoffset={CIRC * (1 - progressPct / 100)}
						style="transition: stroke-dashoffset 0.6s ease"
					/>
				</svg>
				<div class="-mt-11 text-center">
					<div class="text-sm font-semibold tabular-nums">{progressPct}%</div>
				</div>
			</div>
		</div>

		{#if hasTeam}
			<div class="space-y-2 border-b border-border p-3 {showTeamPane ? 'bg-primary/5' : ''}">
				<TeamPulse view={teamView} compact hubKind="script" selectedSessionId={effectiveSessionId} onSelectMember={selectMember} />
				<button
					type="button"
					class="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-violet-300 transition hover:bg-violet-500/10"
					onclick={() => {
						followLatest = false;
						teamSelected = true;
						manualCallId = null;
						pinnedTeammateSession = null;
					}}
				>
					<Users class="size-3" /> Open team pulse →
				</button>
			</div>
		{/if}

		{#if !loaded}
			<div class="flex items-center justify-center py-12">
				<Loader2 class="size-6 animate-spin text-muted-foreground" />
			</div>
		{:else if error}
			<div class="m-3 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-4 text-sm text-destructive">
				{error}
			</div>
		{:else}
			<div class="p-3">
				<div class="mb-2 flex items-center gap-1">
					<button
						class="rounded-md border px-2 py-0.5 text-[11px] font-medium {view === 'list'
							? 'border-border bg-muted text-foreground'
							: 'border-transparent text-muted-foreground hover:bg-muted/50'}"
						onclick={() => (view = 'list')}
					>List</button>
					<button
						class="rounded-md border px-2 py-0.5 text-[11px] font-medium {view === 'graph'
							? 'border-border bg-muted text-foreground'
							: 'border-transparent text-muted-foreground hover:bg-muted/50'}"
						onclick={() => (view = 'graph')}
						disabled={!scriptSource}
						title={scriptSource ? 'Node-graph view with live status' : 'Run has no frozen script source'}
					>Graph</button>
					{#if view === 'graph' && unmappedCalls > 0}
						<span class="ml-auto text-[10px] text-muted-foreground" title="Rows without a call-site (e.g. imported from a pre-edit run) — see the List view">
							{unmappedCalls} unmapped
						</span>
					{/if}
				</div>
				{#if view === 'graph' && scriptSource}
					<div class="h-[520px] overflow-hidden rounded-lg border border-border/60">
						<ScriptCanvas
							{scriptSource}
							scriptMeta={meta}
							{callStates}
							onKillSession={killSessionById}
							onSkipCall={skipCallById}
						/>
					</div>
				{:else}
					<ScriptPhaseRail
						{executionId}
						{slug}
						{calls}
						declaredPhases={meta.phases}
						{currentPhase}
						{isRunning}
						focusedSessionId={effectiveSessionId}
						onSelect={selectCall}
						showActions
					/>
				{/if}
			</div>
		{/if}
	</div>

	<!-- RIGHT: live transcript of the followed session — or the full team pulse -->
	<div class="flex min-w-0 flex-1 flex-col">
		<div class="flex items-center justify-between border-b border-border px-3 py-1.5">
			<div class="flex min-w-0 items-center gap-2 text-xs">
				{#if showTeamPane}
					<Users class="size-3.5 shrink-0 text-violet-300" />
				{:else}
					<MessageSquare class="size-3.5 shrink-0 text-muted-foreground" />
				{/if}
				{#if effectiveHeaderLabel}
					<span class="truncate font-medium">{effectiveHeaderLabel}</span>
					{#if selectedCall?.phase && !showTeamPane}
						<span class="shrink-0 text-muted-foreground">· {selectedCall.phase}</span>
					{/if}
				{:else}
					<span class="text-muted-foreground">Select a call to follow its session</span>
				{/if}
			</div>
			<button
				class="inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-0.5 text-[11px] transition
					{followLatest ? 'bg-primary/15 text-primary' : 'text-muted-foreground hover:bg-accent'}"
				onclick={() => {
					// Turning follow OFF freezes the current selection in place.
					if (followLatest) manualCallId = selectedCall?.callId ?? null;
					followLatest = !followLatest;
					if (followLatest) {
						teamSelected = false;
						pinnedTeammateSession = null;
					}
				}}
				title="Auto-follow the action (running agents, active teammates)"
			>
				<Radio class="size-3 {followLatest ? 'animate-pulse' : ''}" />
				Follow latest
			</button>
		</div>

		<div class="min-h-0 flex-1 overflow-hidden">
			{#if showTeamPane}
				<div class="h-full overflow-y-auto p-4">
					<TeamPulse view={teamView} hubKind="script" selectedSessionId={effectiveSessionId} onSelectMember={selectMember} />
				</div>
			{:else if effectiveSessionId}
				{#key effectiveSessionId}
					<SessionTranscript sessionId={effectiveSessionId} compact showTimeline={false} />
				{/key}
			{:else}
				<div class="flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-muted-foreground">
					<Bot class="size-8 opacity-40" />
					<p class="max-w-xs text-xs">
						Click an agent call on the left — or keep <span class="font-medium text-primary">Follow latest</span>
						on — to watch its session here while the graph shows where the run is.
					</p>
				</div>
			{/if}
		</div>
	</div>
</div>
