<script lang="ts">
	/**
	 * First-class AI authoring for code-first workflows.
	 *
	 * The primary way users author workflows is describing them to an LLM: a
	 * real interactive session (Kimi K3 + the workflow-authoring MCP tools)
	 * bound to THIS workflow row. The agent authors → validates → saves the
	 * script; the canvas re-projects it live.
	 *
	 * This panel makes that loop legible:
	 *  - intent-first start: describe the workflow (or pick a pattern) BEFORE
	 *    the session spawns — one action, no empty-chat dead air;
	 *  - a VERSION TIMELINE: every save the agent lands becomes a card with the
	 *    structural delta (+2 agents, +1 gate …) computed by the same adapter
	 *    the canvas uses, so you can watch the workflow take shape;
	 *  - quick asks: one-tap follow-ups for the edits people actually make
	 *    (approval gates, schema'd verdicts, fan-out, error handling).
	 */
	import { getContext } from 'svelte';
	import {
		Sparkles,
		Send,
		RotateCcw,
		Loader2,
		ExternalLink,
		GitCommitVertical,
		Bot,
		Zap,
		Hand,
		Repeat,
		GitFork,
		Layers
	} from '@lucide/svelte';
	import { page } from '$app/state';
	import type { createWorkflowStore } from '$lib/stores/workflow.svelte';
	import SessionTranscript from '$lib/components/sessions/session-transcript.svelte';
	import {
		parseScriptStructure,
		type ScriptGraphModel
	} from '$lib/utils/script-graph-adapter';

	const store = getContext<ReturnType<typeof createWorkflowStore>>('workflow');
	const slug = $derived(page.params.slug as string);
	const workflowId = $derived(store.workflowId);

	/** Selectable authors: the platform Kimi K3 loop (instant) or a CLI agent
	 * (user's own subscription auth, stronger coding model, pod cold-start). */
	const AUTHORS = [
		{
			runtime: 'dapr-agent-py',
			label: 'Kimi K3',
			hint: 'instant · platform-metered'
		},
		{
			runtime: 'claude-code-cli',
			label: 'Claude Code',
			hint: 'your subscription · ~1–2 min cold start'
		},
		{
			runtime: 'codex-cli',
			label: 'Codex',
			hint: 'your subscription · ~1–2 min cold start'
		},
		{
			runtime: 'agy-cli',
			label: 'Agy',
			hint: 'your subscription · ~1–2 min cold start'
		}
	] as const;
	type AuthorRuntime = (typeof AUTHORS)[number]['runtime'];
	let authorRuntime = $state<AuthorRuntime>('dapr-agent-py');
	const activeAuthor = $derived(
		AUTHORS.find((a) => a.runtime === authorRuntime) ?? AUTHORS[0]
	);

	let sessionId = $state<string | null>(null);
	let starting = $state(false);
	let sending = $state(false);
	let errorMessage = $state<string | null>(null);
	let input = $state('');
	let intent = $state('');

	const storageKey = $derived(workflowId ? `wb-author-session:${workflowId}` : null);
	const runtimeKey = $derived(workflowId ? `wb-author-runtime:${workflowId}` : null);
	$effect(() => {
		if (!runtimeKey || typeof localStorage === 'undefined') return;
		const saved = localStorage.getItem(runtimeKey);
		if (saved && AUTHORS.some((a) => a.runtime === saved)) {
			authorRuntime = saved as AuthorRuntime;
		}
	});

	// ── Starter patterns: proven workflow shapes as one-tap intents ────────────
	const STARTERS: Array<{ title: string; Icon: typeof Bot; prompt: string }> = [
		{
			title: 'Research → report',
			Icon: Bot,
			prompt:
				'Fan out three researcher agents over different angles of a topic (taken from args.topic), then a synthesizer agent that merges their findings into a structured report with a schema.'
		},
		{
			title: 'Generate ↔ critique loop',
			Icon: Repeat,
			prompt:
				'A generator agent produces work, a deterministic check runs, then a critic agent grades it with a SCHEMA-typed verdict ({accepted, score, failing[]}). Loop until accepted or 5 iterations, feeding the failing items back to the generator.'
		},
		{
			title: 'Gated automation',
			Icon: Hand,
			prompt:
				'Run an action to gather data (e.g. web/crawl over args.url), have an agent summarize it, then WAIT FOR HUMAN APPROVAL with a clear message before a final agent publishes the result.'
		},
		{
			title: 'Scheduled pipeline',
			Icon: Layers,
			prompt:
				'A pipeline over a list of items from args.items: each flows through an extract agent then a classify agent (schema-typed). Include a sleep between batches to respect rate limits, and return a summary object.'
		}
	];

	// ── Version timeline: every save the agent lands, as a structural delta ───
	interface ScriptVersion {
		at: number;
		model: ScriptGraphModel;
		script: string;
		/** call-count deltas vs the previous version, by kind (only non-zero). */
		delta: Array<{ kind: string; n: number }> | null;
	}
	let versions = $state<ScriptVersion[]>([]);
	const KIND_META: Record<string, { Icon: typeof Bot; cls: string }> = {
		agent: { Icon: Bot, cls: 'text-teal-300' },
		action: { Icon: Zap, cls: 'text-violet-300' },
		event: { Icon: Hand, cls: 'text-rose-300' },
		parallel: { Icon: GitFork, cls: 'text-amber-300' },
		pipeline: { Icon: GitFork, cls: 'text-sky-300' },
		workflow: { Icon: Layers, cls: 'text-indigo-300' },
		team: { Icon: Bot, cls: 'text-cyan-300' },
		sleep: { Icon: Repeat, cls: 'text-slate-300' }
	};

	function countByKind(model: ScriptGraphModel): Record<string, number> {
		const out: Record<string, number> = {};
		for (const c of model.calls) out[c.kind] = (out[c.kind] ?? 0) + 1;
		return out;
	}

	$effect(() => {
		const src = store.scriptSource;
		if (!src) return;
		const last = versions[versions.length - 1];
		if (last?.script === src) return;
		const model = parseScriptStructure(src, store.scriptMeta);
		let delta: ScriptVersion['delta'] = null;
		if (last) {
			const prev = countByKind(last.model);
			const next = countByKind(model);
			const kinds = new Set([...Object.keys(prev), ...Object.keys(next)]);
			delta = [...kinds]
				.map((kind) => ({ kind, n: (next[kind] ?? 0) - (prev[kind] ?? 0) }))
				.filter((d) => d.n !== 0);
		}
		versions = [...versions, { at: Date.now(), model, script: src, delta }];
	});
	const recentVersions = $derived([...versions].reverse().slice(0, 5));

	// ── Quick asks: the follow-up edits people actually make ──────────────────
	const QUICK_ASKS: string[] = [
		'Add a human approval gate before the final step',
		'Make the last agent return a schema-typed object',
		'Fan the main step out in parallel over args items',
		'Add allowFailure + a fallback path to the action',
		'Add a meta.input schema for the run arguments',
		"Make the agents selectable per run (x-wfb agent inputs)"
	];

	// ── Session lifecycle ──────────────────────────────────────────────────────
	$effect(() => {
		if (!storageKey || typeof localStorage === 'undefined') return;
		const saved = localStorage.getItem(storageKey);
		if (saved && !sessionId) void adopt(saved);
	});

	async function adopt(id: string) {
		try {
			const res = await fetch(`/api/v1/sessions/${id}`);
			if (res.ok) sessionId = id;
			else if (storageKey) localStorage.removeItem(storageKey);
		} catch {
			/* offline — leave unbound */
		}
	}

	async function startSession(firstMessage?: string) {
		if (!workflowId || starting) return;
		starting = true;
		errorMessage = null;
		try {
			const res = await fetch(`/api/workflows/${workflowId}/author-session`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ runtime: authorRuntime })
			});
			const body = (await res.json().catch(() => ({}))) as {
				sessionId?: string;
				message?: string;
			};
			if (!res.ok || !body.sessionId) {
				errorMessage = body.message || `Could not start authoring session (${res.status})`;
				return;
			}
			sessionId = body.sessionId;
			if (storageKey) localStorage.setItem(storageKey, body.sessionId);
			if (runtimeKey) localStorage.setItem(runtimeKey, authorRuntime);
			if (firstMessage?.trim()) {
				await postMessage(firstMessage.trim());
				intent = '';
			}
		} catch (err) {
			errorMessage = err instanceof Error ? err.message : 'Failed to start authoring session';
		} finally {
			starting = false;
		}
	}

	function resetSession() {
		if (storageKey) localStorage.removeItem(storageKey);
		sessionId = null;
		errorMessage = null;
		versions = [];
	}

	async function postMessage(text: string): Promise<boolean> {
		if (!sessionId) return false;
		const res = await fetch(`/api/v1/sessions/${sessionId}/events`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				events: [{ type: 'user.message', content: [{ type: 'text', text }] }]
			})
		}).catch(() => null);
		return Boolean(res?.ok);
	}

	async function send(preset?: string) {
		const text = (preset ?? input).trim();
		if (!text || !sessionId || sending) return;
		if (!preset) input = '';
		sending = true;
		errorMessage = null;
		const ok = await postMessage(text);
		if (!ok) {
			errorMessage = 'Send failed';
			if (!preset) input = text;
		}
		sending = false;
	}

	function onKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter' && !e.shiftKey) {
			e.preventDefault();
			void send();
		}
	}
	function onIntentKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
			e.preventDefault();
			void startSession(intent);
		}
	}

	function timeAgo(at: number): string {
		const s = Math.max(1, Math.round((Date.now() - at) / 1000));
		if (s < 60) return `${s}s ago`;
		const m = Math.round(s / 60);
		if (m < 60) return `${m}m ago`;
		return `${Math.round(m / 60)}h ago`;
	}
</script>

<div class="flex h-full flex-col overflow-hidden">
	{#if !sessionId}
		<!-- Intent-first start: describe it, or pick a proven pattern -->
		<div class="flex flex-1 flex-col gap-3 overflow-y-auto p-3">
			<div class="rounded-xl border border-fuchsia-400/25 bg-gradient-to-b from-fuchsia-500/10 to-transparent p-3">
				<div class="flex items-center gap-2">
					<div class="flex size-8 items-center justify-center rounded-lg border border-fuchsia-400/30 bg-fuchsia-500/10">
						<Sparkles class="size-4 text-fuchsia-300" />
					</div>
					<div>
						<h3 class="text-sm font-semibold leading-tight">Author with AI</h3>
						<p class="text-[11px] text-muted-foreground">
							Describe the workflow — the agent writes, validates, and saves the script.
						</p>
					</div>
				</div>
				<textarea
					bind:value={intent}
					onkeydown={onIntentKeydown}
					rows="4"
					placeholder="e.g. Crawl the docs site from args.url, have three agents review different sections in parallel, gate on my approval, then publish a summary…"
					class="mt-2.5 w-full resize-none rounded-lg border border-input bg-background/70 px-2.5 py-2 text-xs leading-relaxed focus:outline-none focus:ring-1 focus:ring-fuchsia-400/50"
				></textarea>
				<div class="mt-2 flex flex-wrap items-center gap-1">
					{#each AUTHORS as a (a.runtime)}
						<button
							class="rounded-full border px-2 py-0.5 text-[10px] font-medium transition
								{authorRuntime === a.runtime
								? 'border-fuchsia-400/50 bg-fuchsia-500/15 text-fuchsia-200'
								: 'border-border/60 bg-card/40 text-muted-foreground hover:text-foreground'}"
							onclick={() => (authorRuntime = a.runtime)}
							title={a.hint}
						>
							{a.label}
						</button>
					{/each}
					<span class="ml-1 text-[9.5px] text-muted-foreground/60">{activeAuthor.hint}</span>
				</div>
				<div class="mt-2 flex items-center justify-between">
					<span class="text-[10px] text-muted-foreground/70">⌘↵ to start</span>
					<button
						class="inline-flex items-center gap-1.5 rounded-md bg-fuchsia-500/90 px-3 py-1.5 text-xs font-semibold text-white shadow hover:bg-fuchsia-500 disabled:opacity-60"
						onclick={() => startSession(intent)}
						disabled={starting || !workflowId}
					>
						{#if starting}
							<Loader2 class="size-3.5 animate-spin" /> Starting…
						{:else}
							<Sparkles class="size-3.5" /> Start authoring
						{/if}
					</button>
				</div>
			</div>

			<div>
				<div class="px-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/70">
					Or start from a pattern
				</div>
				<div class="mt-1.5 grid grid-cols-1 gap-1.5">
					{#each STARTERS as starter (starter.title)}
						<button
							class="group flex items-start gap-2.5 rounded-lg border border-border/60 bg-card/50 p-2.5 text-left transition hover:border-fuchsia-400/40 hover:bg-fuchsia-500/5"
							onclick={() => startSession(starter.prompt)}
							disabled={starting}
						>
							<starter.Icon class="mt-0.5 size-3.5 shrink-0 text-fuchsia-300/80" />
							<div class="min-w-0">
								<div class="text-xs font-medium text-foreground/90">{starter.title}</div>
								<div class="line-clamp-2 text-[10.5px] leading-snug text-muted-foreground">
									{starter.prompt}
								</div>
							</div>
						</button>
					{/each}
				</div>
			</div>

			{#if errorMessage}
				<p class="text-xs text-destructive">{errorMessage}</p>
			{/if}
		</div>
	{:else}
		<div class="flex items-center justify-between border-b border-border px-2.5 py-1 text-[10px] text-muted-foreground">
			<span class="inline-flex items-center gap-1">
				<span class="size-1.5 animate-pulse rounded-full bg-fuchsia-400"></span>
				{activeAuthor.label} author
			</span>
			<div class="flex items-center gap-1">
				<a
					href={`/workspaces/${slug}/sessions/${sessionId}`}
					class="inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 hover:bg-accent"
					title="Open full session"
				>
					<ExternalLink class="size-3" /> Session
				</a>
				<button
					class="inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 hover:bg-accent hover:text-destructive"
					onclick={resetSession}
					title="New authoring session"
				>
					<RotateCcw class="size-3" /> Reset
				</button>
			</div>
		</div>

		{#if recentVersions.length > 0}
			<!-- Version timeline: each save the agent lands, with structure deltas -->
			<div class="border-b border-border/60 bg-background/40 px-2 py-1.5">
				<div class="flex items-center gap-1 overflow-x-auto pb-0.5">
					<GitCommitVertical class="size-3.5 shrink-0 text-fuchsia-300/70" />
					{#each recentVersions as v, i (v.at)}
						<div
							class="flex shrink-0 items-center gap-1.5 rounded-md border px-2 py-1 text-[10px]
								{i === 0
								? 'border-fuchsia-400/40 bg-fuchsia-500/10'
								: 'border-border/50 bg-card/40 opacity-70'}"
							title="{v.model.phases.length} phases · {v.model.calls.length} calls"
						>
							<span class="font-medium text-foreground/80">
								{v.model.calls.length} step{v.model.calls.length === 1 ? '' : 's'}
							</span>
							{#if v.delta && v.delta.length > 0}
								{#each v.delta.slice(0, 3) as d (d.kind)}
									{@const km = KIND_META[d.kind]}
									<span class="inline-flex items-center gap-0.5 {d.n > 0 ? (km?.cls ?? '') : 'text-muted-foreground/60'}">
										{#if km}<km.Icon class="size-2.5" />{/if}
										{d.n > 0 ? '+' : ''}{d.n}
									</span>
								{/each}
							{:else if i === recentVersions.length - 1}
								<span class="text-muted-foreground/60">initial</span>
							{/if}
							<span class="text-muted-foreground/50">{timeAgo(v.at)}</span>
						</div>
					{/each}
				</div>
			</div>
		{/if}

		<div class="min-h-0 flex-1 overflow-hidden">
			<SessionTranscript {sessionId} compact showPulse={false} showTimeline={false} />
		</div>

		{#if errorMessage}
			<div class="border-t border-destructive/30 bg-destructive/10 px-3 py-1 text-[11px] text-destructive">
				{errorMessage}
			</div>
		{/if}

		<div class="border-t border-border p-2">
			<div class="mb-1.5 flex gap-1 overflow-x-auto pb-0.5">
				{#each QUICK_ASKS as ask (ask)}
					<button
						class="shrink-0 rounded-full border border-border/60 bg-card/50 px-2 py-0.5 text-[10px] text-muted-foreground transition hover:border-fuchsia-400/40 hover:text-foreground"
						onclick={() => send(ask)}
						disabled={sending}
						title={ask}
					>
						{ask}
					</button>
				{/each}
			</div>
			<div class="flex items-end gap-1.5">
				<textarea
					bind:value={input}
					onkeydown={onKeydown}
					rows="2"
					placeholder="Refine the workflow…"
					class="flex-1 resize-none rounded-md border border-input bg-background px-2.5 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
				></textarea>
				<button
					class="inline-flex size-8 items-center justify-center rounded-md bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
					onclick={() => send()}
					disabled={sending || !input.trim()}
					title="Send"
				>
					{#if sending}
						<Loader2 class="size-3.5 animate-spin" />
					{:else}
						<Send class="size-3.5" />
					{/if}
				</button>
			</div>
		</div>
	{/if}
</div>
