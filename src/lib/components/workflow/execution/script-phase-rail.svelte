<script lang="ts" module>
	export type ScriptCall = {
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

	export function scriptCallLabel(call: ScriptCall): string {
		if (call.label) return call.label;
		return `${call.kind} #${call.seq + 1}`;
	}
</script>

<script lang="ts">
	/**
	 * Compact phase-lane graph of a dynamic-script run's call journal.
	 *
	 * Presentational when `calls` is provided; self-polling (~3s while
	 * isRunning) when only `executionId` is given. Used two ways:
	 *   - run-console (Live tab): a small collapsible "graph" in the left rail —
	 *     clicking a call pins its session in the main Live pane (onSelect).
	 *   - script-run-panel (Canvas tab): the left half of the split
	 *     follow-along view (passes `calls` + showActions for Kill/Skip).
	 */
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
		SkipForward as SkipIcon,
		Users,
		UserPlus,
		Timer
	} from '@lucide/svelte';

	interface Props {
		executionId: string;
		/** Provide to make the rail presentational (no internal polling). */
		calls?: ScriptCall[] | null;
		/** Declared meta.phases titles (lanes render before any call lands). */
		declaredPhases?: string[];
		currentPhase?: string | null;
		isRunning?: boolean;
		/** Highlight the call whose session is focused in the host view. */
		focusedSessionId?: string | null;
		onSelect?: (call: ScriptCall) => void;
		/** Show Kill/Skip + open-session hover actions (needs slug). */
		showActions?: boolean;
		slug?: string;
	}

	let {
		executionId,
		calls = null,
		declaredPhases = [],
		currentPhase = null,
		isRunning = false,
		focusedSessionId = null,
		onSelect,
		showActions = false,
		slug = ''
	}: Props = $props();

	let polled = $state<ScriptCall[]>([]);
	let pending = $state<Record<string, boolean>>({});
	const effectiveCalls = $derived(calls ?? polled);

	async function fetchCalls() {
		try {
			const res = await fetch(
				`/api/workflows/executions/${encodeURIComponent(executionId)}/script-calls`
			);
			if (!res.ok) return;
			const data = (await res.json()) as { scriptCalls?: ScriptCall[] };
			polled = Array.isArray(data.scriptCalls) ? data.scriptCalls : [];
		} catch {
			// best-effort
		}
	}

	$effect(() => {
		if (calls !== null) return; // presentational mode — host owns the data
		void executionId;
		fetchCalls();
		if (!isRunning) return;
		const t = setInterval(fetchCalls, 3000);
		return () => clearInterval(t);
	});

	const lanes = $derived.by(() => {
		const byPhase = new Map<string, ScriptCall[]>();
		const order: string[] = [];
		const ensure = (key: string) => {
			if (!byPhase.has(key)) {
				byPhase.set(key, []);
				order.push(key);
			}
		};
		for (const p of declaredPhases) ensure(p);
		for (const c of effectiveCalls) ensure(c.phase ?? '__unphased__');
		for (const c of effectiveCalls) byPhase.get(c.phase ?? '__unphased__')!.push(c);
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

	const KIND_STYLE: Record<
		string,
		{ ring: string; bg: string; fg: string; Icon: typeof Bot; name: string }
	> = {
		agent: { ring: 'border-teal-400/40', bg: 'bg-teal-500/10', fg: 'text-teal-300', Icon: Bot, name: 'agent' },
		parallel: { ring: 'border-amber-400/40', bg: 'bg-amber-500/10', fg: 'text-amber-300', Icon: GitFork, name: 'parallel' },
		pipeline: { ring: 'border-sky-400/40', bg: 'bg-sky-500/10', fg: 'text-sky-300', Icon: ArrowRight, name: 'pipeline' },
		workflow: { ring: 'border-indigo-400/40', bg: 'bg-indigo-500/10', fg: 'text-indigo-300', Icon: Layers, name: 'workflow' },
		team: { ring: 'border-violet-400/40', bg: 'bg-violet-500/10', fg: 'text-violet-300', Icon: Users, name: 'team' }
	};
	function kindStyle(kind: string, label?: string | null) {
		const base = KIND_STYLE[kind] ?? KIND_STYLE.agent;
		if (kind === 'team' && label) {
			// Op-specific glyphs where they add meaning; the violet identity stays.
			if (label.startsWith('spawn')) return { ...base, Icon: UserPlus };
			if (label.startsWith('join')) return { ...base, Icon: Timer };
		}
		return base;
	}

	async function killSession(call: ScriptCall) {
		if (!call.sessionId) return;
		if (!confirm(`Kill the session for "${scriptCallLabel(call)}"? The call resolves to null.`)) return;
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
		if (!confirm(`Skip "${scriptCallLabel(call)}"? The script sees null for this call.`)) return;
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
</script>

<div class="space-y-2">
	{#each lanes as lane (lane.key)}
		{@const st = laneStatus(lane.calls)}
		{@const isCurrent = currentPhase != null && lane.key === currentPhase}
		<div class="overflow-hidden rounded-lg border {isCurrent ? 'border-primary/40 bg-primary/[0.03]' : 'border-border'}">
			<div class="flex items-center gap-2 border-l-2 px-2.5 py-1.5
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
				<span class="truncate text-xs font-semibold uppercase tracking-wide">{lane.title}</span>
				<span class="ml-auto shrink-0 text-[10px] text-muted-foreground">{lane.calls.length}</span>
			</div>

			{#if lane.calls.length === 0}
				<div class="px-2.5 py-1.5 text-[11px] italic text-muted-foreground/60">waiting…</div>
			{:else}
				<div class="divide-y divide-border/50">
					{#each lane.calls as call (call.callId)}
						{@const ks = kindStyle(call.kind, call.label)}
						{@const isSel = focusedSessionId != null && call.sessionId === focusedSessionId}
						{@const clickable = !!onSelect && (!!call.sessionId || call.kind === 'team')}
						<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
						<div
							class="group flex items-center gap-2 px-2.5 py-1.5 {clickable ? 'cursor-pointer hover:bg-accent/40' : ''} {isSel ? 'bg-primary/10' : ''}"
							onclick={() => clickable && onSelect?.(call)}
							role={clickable ? 'button' : undefined}
							tabindex={clickable ? 0 : -1}
							onkeydown={(e) => {
								if (clickable && (e.key === 'Enter' || e.key === ' ')) {
									e.preventDefault();
									onSelect?.(call);
								}
							}}
						>
							<div class="flex size-6 shrink-0 items-center justify-center rounded-md border {ks.ring} {ks.bg}">
								<ks.Icon class="size-3 {ks.fg}" />
							</div>
							<div class="min-w-0 flex-1">
								<div class="flex items-center gap-1">
									<span class="text-[9px] font-medium uppercase tracking-wide {ks.fg}">{ks.name}</span>
									{#if call.retries > 0}
										<span class="rounded bg-amber-500/15 px-1 text-[9px] text-amber-300">↻{call.retries}</span>
									{/if}
								</div>
								<div class="truncate text-xs font-medium" title={scriptCallLabel(call)}>{scriptCallLabel(call)}</div>
								{#if call.errorCode}
									<div class="truncate text-[10px] text-destructive">{call.errorCode}</div>
								{/if}
							</div>

							{#if call.status === 'running'}
								<Loader2 class="size-3.5 shrink-0 animate-spin text-primary" />
							{:else if call.status === 'done'}
								<CheckCircle2 class="size-3.5 shrink-0 text-emerald-400" />
							{:else if call.status === 'error'}
								<XCircle class="size-3.5 shrink-0 text-destructive" />
							{:else if call.status === 'skipped'}
								<SkipIcon class="size-3.5 shrink-0 text-muted-foreground" />
							{:else}
								<CircleDashed class="size-3.5 shrink-0 text-muted-foreground/50" />
							{/if}

							{#if showActions}
								<div class="flex shrink-0 items-center opacity-0 transition group-hover:opacity-100">
									{#if call.sessionId && slug}
										<a
											href={`/workspaces/${encodeURIComponent(slug)}/sessions/${encodeURIComponent(call.sessionId)}`}
											class="rounded p-1 hover:bg-accent"
											title="Open session (full page)"
											onclick={(e) => e.stopPropagation()}
										>
											<ExternalLink class="size-3.5" />
										</a>
										<button
											class="rounded p-1 hover:bg-accent hover:text-destructive disabled:opacity-50"
											disabled={pending[call.callId]}
											onclick={(e) => {
												e.stopPropagation();
												killSession(call);
											}}
											title="Kill session"
										>
											<Ban class="size-3.5" />
										</button>
									{/if}
									{#if call.status === 'running'}
										<button
											class="rounded p-1 hover:bg-accent disabled:opacity-50"
											disabled={pending[call.callId]}
											onclick={(e) => {
												e.stopPropagation();
												skipCall(call);
											}}
											title="Skip call"
										>
											<SkipForward class="size-3.5" />
										</button>
									{/if}
								</div>
							{/if}
						</div>
					{/each}
				</div>
			{/if}
		</div>
	{/each}

	{#if lanes.length === 0}
		<div class="rounded-md border px-3 py-6 text-center text-xs text-muted-foreground">
			No calls issued yet.
		</div>
	{/if}
</div>
