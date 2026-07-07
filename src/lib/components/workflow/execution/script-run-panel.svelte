<!--
  Run-detail surface for a dynamic-script (engineType `dynamic-script`) execution.

  A SPLIT "follow-along" view: the phase-swimlane graph on the left (phases as
  lanes, each agent()/parallel()/pipeline()/workflow() call a selectable card
  with a live status chip, retries/error, session link + Kill/Skip), and the
  selected call's LIVE session transcript on the right. "Follow latest" tracks
  the currently-running agent so you watch the active agent while the graph
  shows where the run is. Polls /script-calls (~3s) while the run is active.

  Note: the journal does not track per-call tokens (real usage lives in
  session_events, surfaced by the transcript's SessionPulse), so the left
  summary shows a call-progress ring, not a token ring.
-->
<script lang="ts">
	import { Loader2, Bot, Radio, MessageSquare } from '@lucide/svelte';
	import SessionTranscript from '$lib/components/sessions/session-transcript.svelte';
	import ScriptPhaseRail, {
		scriptCallLabel,
		type ScriptCall
	} from './script-phase-rail.svelte';

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

	// Selection + follow-along. The user's explicit click lands in
	// manualCallId; the EFFECTIVE selection is derived — when followLatest is
	// on it tracks the running (else most recent) agent automatically.
	let manualCallId = $state<string | null>(null);
	let followLatest = $state(true);

	const agentCalls = $derived(calls.filter((c) => c.kind === 'agent'));
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

	const selectedCallId = $derived.by(() => {
		if (!followLatest) return manualCallId;
		const withSession = agentCalls.filter((c) => c.sessionId);
		const running = withSession.find((c) => c.status === 'running');
		const latest = running ?? [...withSession].sort((a, b) => b.seq - a.seq)[0] ?? null;
		return latest?.callId ?? manualCallId;
	});
	const selectedCall = $derived(calls.find((c) => c.callId === selectedCallId) ?? null);
	const selectedSessionId = $derived(selectedCall?.sessionId ?? null);

	function selectCall(call: ScriptCall) {
		if (!call.sessionId) return;
		followLatest = false;
		manualCallId = call.callId;
	}

	async function fetchCalls() {
		try {
			const res = await fetch(
				`/api/workflows/executions/${encodeURIComponent(executionId)}/script-calls`
			);
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const data = (await res.json()) as { scriptCalls?: ScriptCall[] };
			calls = Array.isArray(data.scriptCalls) ? data.scriptCalls : [];
			error = null;
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
	<!-- LEFT: phase graph -->
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
				<ScriptPhaseRail
					{executionId}
					{slug}
					{calls}
					declaredPhases={meta.phases}
					{currentPhase}
					{isRunning}
					focusedSessionId={selectedSessionId}
					onSelect={selectCall}
					showActions
				/>
			</div>
		{/if}
	</div>

	<!-- RIGHT: live transcript of the selected/followed call's session -->
	<div class="flex min-w-0 flex-1 flex-col">
		<div class="flex items-center justify-between border-b border-border px-3 py-1.5">
			<div class="flex min-w-0 items-center gap-2 text-xs">
				<MessageSquare class="size-3.5 shrink-0 text-muted-foreground" />
				{#if selectedCall}
					<span class="truncate font-medium">{scriptCallLabel(selectedCall)}</span>
					{#if selectedCall.phase}
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
					if (followLatest) manualCallId = selectedCallId;
					followLatest = !followLatest;
				}}
				title="Auto-follow the running agent"
			>
				<Radio class="size-3 {followLatest ? 'animate-pulse' : ''}" />
				Follow latest
			</button>
		</div>

		<div class="min-h-0 flex-1 overflow-hidden">
			{#if selectedSessionId}
				{#key selectedSessionId}
					<SessionTranscript sessionId={selectedSessionId} compact showTimeline={false} />
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
