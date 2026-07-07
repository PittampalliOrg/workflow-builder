<!--
  Run-detail surface for a dynamic-script (engineType `dynamic-script`) execution.
  Renders the script meta, a budget ring + live agent tallies, and a PHASE-
  SWIMLANE view of the call journal: each phase is a lane (header with a live
  status rollup + call count), and each agent()/parallel()/pipeline()/workflow()
  call is a card (kind icon, label, status, tokens, retries/error, session
  click-through + Kill/Skip). Polls /script-calls (~3s) while the run is active.
-->
<script lang="ts">
	import {
		Loader2,
		ExternalLink,
		Ban,
		SkipForward,
		Bot,
		GitFork,
		ArrowRight,
		Layers,
		CheckCircle2,
		CircleDashed,
		XCircle,
		SkipForward as SkipIcon
	} from '@lucide/svelte';
	import { Button } from '$lib/components/ui/button';

	type ScriptCall = {
		callId: string;
		seq: number;
		kind: string;
		label: string | null;
		phase: string | null;
		status: string;
		sessionId: string | null;
		tokensUsed: number;
		errorCode: string | null;
		retries: number;
	};

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
	let pending = $state<Record<string, boolean>>({});

	const spentTokens = $derived(calls.reduce((sum, c) => sum + (c.tokensUsed || 0), 0));
	const budgetPct = $derived(
		budgetTotal && budgetTotal > 0 ? Math.min(100, Math.round((spentTokens / budgetTotal) * 100)) : null
	);
	const agentCalls = $derived(calls.filter((c) => c.kind === 'agent'));
	const tallies = $derived({
		total: calls.length,
		done: calls.filter((c) => c.status === 'done').length,
		running: calls.filter((c) => c.status === 'running').length,
		error: calls.filter((c) => c.status === 'error').length,
		agents: agentCalls.length
	});

	// Lanes: declared meta.phases first (canonical order), then any phase only
	// seen in the journal, then an implicit "(no phase)" bucket. Empty declared
	// lanes still render so the plan is visible before calls arrive.
	const lanes = $derived.by(() => {
		const byPhase = new Map<string, ScriptCall[]>();
		const order: string[] = [];
		const ensure = (key: string) => {
			if (!byPhase.has(key)) {
				byPhase.set(key, []);
				order.push(key);
			}
		};
		for (const p of meta.phases) ensure(p);
		for (const c of calls) ensure(c.phase ?? '__unphased__');
		for (const c of calls) byPhase.get(c.phase ?? '__unphased__')!.push(c);
		return order.map((key) => ({
			key,
			title: key === '__unphased__' ? '(no phase)' : key,
			calls: (byPhase.get(key) ?? []).sort((a, b) => a.seq - b.seq)
		}));
	});

	function laneStatus(phaseCalls: ScriptCall[]): 'idle' | 'running' | 'error' | 'done' {
		if (phaseCalls.length === 0) return 'idle';
		if (phaseCalls.some((c) => c.status === 'error')) return 'error';
		if (phaseCalls.some((c) => c.status === 'running')) return 'running';
		if (phaseCalls.every((c) => c.status === 'done' || c.status === 'skipped')) return 'done';
		return 'idle';
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

	function callLabel(call: ScriptCall): string {
		if (call.label) return call.label;
		return `${call.kind}·${call.callId.slice(0, 8)}`;
	}

	const KIND_STYLE: Record<string, { ring: string; bg: string; fg: string; Icon: typeof Bot; name: string }> = {
		agent: { ring: 'border-teal-400/40', bg: 'bg-teal-500/10', fg: 'text-teal-300', Icon: Bot, name: 'agent' },
		parallel: { ring: 'border-amber-400/40', bg: 'bg-amber-500/10', fg: 'text-amber-300', Icon: GitFork, name: 'parallel' },
		pipeline: { ring: 'border-sky-400/40', bg: 'bg-sky-500/10', fg: 'text-sky-300', Icon: ArrowRight, name: 'pipeline' },
		workflow: { ring: 'border-indigo-400/40', bg: 'bg-indigo-500/10', fg: 'text-indigo-300', Icon: Layers, name: 'workflow' }
	};
	function kindStyle(kind: string) {
		return KIND_STYLE[kind] ?? KIND_STYLE.agent;
	}

	async function killSession(call: ScriptCall) {
		if (!call.sessionId) return;
		if (!confirm(`Kill the session for "${callLabel(call)}"? The call resolves to null.`)) return;
		pending = { ...pending, [call.callId]: true };
		try {
			await fetch(`/api/v1/sessions/${encodeURIComponent(call.sessionId)}/stop`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ mode: 'interrupt' })
			});
			await fetchCalls();
		} finally {
			pending = { ...pending, [call.callId]: false };
		}
	}

	async function skipCall(call: ScriptCall) {
		if (!confirm(`Skip "${callLabel(call)}"? The script sees null for this call.`)) return;
		pending = { ...pending, [call.callId]: true };
		try {
			await fetch(
				`/api/workflows/executions/${encodeURIComponent(executionId)}/script-calls/${encodeURIComponent(call.callId)}/skip`,
				{ method: 'POST' }
			);
			await fetchCalls();
		} finally {
			pending = { ...pending, [call.callId]: false };
		}
	}

	function sessionHref(sessionId: string): string {
		return `/workspaces/${encodeURIComponent(slug)}/sessions/${encodeURIComponent(sessionId)}`;
	}

	// Budget ring geometry (SVG).
	const R = 26;
	const CIRC = 2 * Math.PI * R;
</script>

<div class="flex h-full flex-col gap-4 overflow-y-auto p-4">
	<!-- Summary header: meta + budget ring + tallies -->
	<div class="flex items-start justify-between gap-4">
		<div class="min-w-0 space-y-1">
			<div class="flex items-center gap-2">
				<h2 class="truncate text-lg font-semibold">{meta.name}</h2>
				{#if isRunning}
					<span class="inline-flex items-center gap-1 rounded-full bg-primary/15 px-2 py-0.5 text-[10px] font-medium text-primary">
						<Loader2 class="size-3 animate-spin" /> running
					</span>
				{/if}
			</div>
			{#if meta.description}
				<p class="text-sm text-muted-foreground">{meta.description}</p>
			{/if}
			<div class="flex flex-wrap items-center gap-x-3 gap-y-1 pt-1 text-xs text-muted-foreground">
				<span><span class="font-medium text-foreground">{tallies.agents}</span> agents</span>
				<span class="text-emerald-400">{tallies.done} done</span>
				{#if tallies.running > 0}<span class="text-primary">{tallies.running} running</span>{/if}
				{#if tallies.error > 0}<span class="text-destructive">{tallies.error} failed</span>{/if}
				<span>· {meta.phases.length || lanes.length} phase{(meta.phases.length || lanes.length) === 1 ? '' : 's'}</span>
			</div>
		</div>

		<!-- Budget ring -->
		<div class="flex shrink-0 flex-col items-center gap-0.5">
			<svg width="64" height="64" viewBox="0 0 64 64" class="-rotate-90">
				<circle cx="32" cy="32" r={R} fill="none" stroke="currentColor" class="text-muted/40" stroke-width="6" />
				<circle
					cx="32"
					cy="32"
					r={R}
					fill="none"
					stroke="currentColor"
					class={budgetPct != null && budgetPct >= 100 ? 'text-destructive' : 'text-primary'}
					stroke-width="6"
					stroke-linecap="round"
					stroke-dasharray={CIRC}
					stroke-dashoffset={CIRC * (1 - (budgetPct ?? 0) / 100)}
					style="transition: stroke-dashoffset 0.6s ease"
				/>
			</svg>
			<div class="text-center">
				<div class="text-xs font-semibold tabular-nums">
					{budgetPct != null ? `${budgetPct}%` : spentTokens.toLocaleString()}
				</div>
				<div class="text-[9px] text-muted-foreground">
					{#if budgetTotal != null}
						{Math.round(spentTokens / 1000)}k / {Math.round(budgetTotal / 1000)}k
					{:else}
						tokens
					{/if}
				</div>
			</div>
		</div>
	</div>

	{#if !loaded}
		<div class="flex items-center justify-center py-12">
			<Loader2 class="size-6 animate-spin text-muted-foreground" />
		</div>
	{:else if error}
		<div class="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-6 text-sm text-destructive">
			{error}
		</div>
	{:else}
		<!-- Phase swimlanes -->
		<div class="space-y-3">
			{#each lanes as lane (lane.key)}
				{@const st = laneStatus(lane.calls)}
				{@const isCurrent = currentPhase != null && lane.key === currentPhase}
				<div
					class="rounded-lg border {isCurrent
						? 'border-primary/40 bg-primary/[0.03]'
						: 'border-border'} overflow-hidden"
				>
					<!-- Lane header -->
					<div class="flex items-center gap-2 border-l-2 px-3 py-1.5
						{st === 'error' ? 'border-l-destructive bg-destructive/5' : st === 'running' ? 'border-l-primary bg-primary/5' : st === 'done' ? 'border-l-emerald-500 bg-emerald-500/[0.04]' : 'border-l-muted-foreground/30 bg-muted/20'}">
						{#if st === 'running'}
							<Loader2 class="size-3.5 animate-spin text-primary" />
						{:else if st === 'done'}
							<CheckCircle2 class="size-3.5 text-emerald-400" />
						{:else if st === 'error'}
							<XCircle class="size-3.5 text-destructive" />
						{:else}
							<CircleDashed class="size-3.5 text-muted-foreground/60" />
						{/if}
						<span class="text-xs font-semibold uppercase tracking-wide">{lane.title}</span>
						<span class="ml-auto text-[10px] text-muted-foreground">
							{lane.calls.length} call{lane.calls.length === 1 ? '' : 's'}
						</span>
					</div>

					<!-- Lane calls -->
					{#if lane.calls.length === 0}
						<div class="px-3 py-2 text-[11px] italic text-muted-foreground/60">
							waiting…
						</div>
					{:else}
						<div class="divide-y divide-border/50">
							{#each lane.calls as call (call.callId)}
								{@const ks = kindStyle(call.kind)}
								<div class="flex items-center gap-2.5 px-3 py-2">
									<div class="flex size-7 shrink-0 items-center justify-center rounded-md border {ks.ring} {ks.bg}">
										<ks.Icon class="size-3.5 {ks.fg}" />
									</div>
									<div class="min-w-0 flex-1">
										<div class="flex items-center gap-1.5">
											<span class="text-[9px] font-medium uppercase tracking-wide {ks.fg}">{ks.name}</span>
											{#if call.retries > 0}
												<span class="rounded bg-amber-500/15 px-1 text-[9px] text-amber-300">↻{call.retries}</span>
											{/if}
										</div>
										<div class="truncate text-sm font-medium" title={callLabel(call)}>{callLabel(call)}</div>
										{#if call.errorCode}
											<div class="truncate text-[11px] text-destructive">{call.errorCode}</div>
										{/if}
									</div>

									<!-- status chip -->
									<div class="shrink-0">
										{#if call.status === 'running'}
											<span class="inline-flex items-center gap-1 rounded-full bg-primary/15 px-2 py-0.5 text-[10px] font-medium text-primary">
												<Loader2 class="size-2.5 animate-spin" /> running
											</span>
										{:else if call.status === 'done'}
											<span class="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-medium text-emerald-300">
												<CheckCircle2 class="size-2.5" /> done
											</span>
										{:else if call.status === 'error'}
											<span class="inline-flex items-center gap-1 rounded-full bg-destructive/15 px-2 py-0.5 text-[10px] font-medium text-destructive">
												<XCircle class="size-2.5" /> error
											</span>
										{:else if call.status === 'skipped'}
											<span class="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
												<SkipIcon class="size-2.5" /> skipped
											</span>
										{:else}
											<span class="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">{call.status}</span>
										{/if}
									</div>

									<span class="w-14 shrink-0 text-right text-[11px] tabular-nums text-muted-foreground">
										{(call.tokensUsed || 0).toLocaleString()}
									</span>

									<div class="flex shrink-0 items-center gap-0.5">
										{#if call.sessionId}
											<Button variant="ghost" size="icon" href={sessionHref(call.sessionId)} title="Open child session">
												<ExternalLink class="size-3.5" />
											</Button>
											<Button
												variant="ghost"
												size="icon"
												disabled={pending[call.callId]}
												onclick={() => killSession(call)}
												title="Kill session"
											>
												<Ban class="size-3.5" />
											</Button>
										{/if}
										{#if call.status === 'running'}
											<Button
												variant="ghost"
												size="icon"
												disabled={pending[call.callId]}
												onclick={() => skipCall(call)}
												title="Skip call"
											>
												<SkipForward class="size-3.5" />
											</Button>
										{/if}
									</div>
								</div>
							{/each}
						</div>
					{/if}
				</div>
			{/each}

			{#if lanes.length === 0}
				<div class="rounded-md border px-3 py-8 text-center text-sm text-muted-foreground">
					No calls issued yet.
				</div>
			{/if}
		</div>
	{/if}
</div>
