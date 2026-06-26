<script lang="ts">
	/**
	 * Run focus panel — the canvas's "live feed" for a selected run.
	 *
	 * The canvas IS the node rail (every node shows live status via the overlay), so this
	 * panel does NOT repeat it. Instead it's single-column + transcript-first: a one-line
	 * run header, a slim session switcher, and the focused session's transcript at FULL
	 * panel width (readable in the narrow right panel). Clicking a node on the canvas
	 * (`focusNode`) focuses that node's session here. Branches + deep tabs live behind a
	 * disclosure / "Open full run".
	 */
	import { onDestroy } from 'svelte';
	import { ChevronDown, ExternalLink, GitBranch, Radio, Pin, Inbox } from '@lucide/svelte';
	import { createExecutionStream, type ExecutionStreamStore } from '$lib/stores/execution-stream.svelte';
	import SessionTranscript from '$lib/components/sessions/session-transcript.svelte';
	import RunLineageTree from '$lib/components/workflow/execution/run-lineage-tree.svelte';
	import { fmtTokens } from '$lib/utils/format-tokens';

	interface Props {
		executionId: string;
		slug: string;
		workflowId: string;
		/** Node clicked on the canvas → focus that node's session. */
		focusNode?: string | null;
	}
	let { executionId, slug, workflowId, focusNode = null }: Props = $props();

	type SessionRow = {
		id: string;
		title: string | null;
		status: string | null;
		createdAt: string | null;
		inherited?: boolean;
	};

	let sessions = $state<SessionRow[]>([]);
	let runStatus = $state<string | null>(null);
	let currentNodeName = $state<string | null>(null);
	let isStreaming = $state(false);
	let branchesOpen = $state(false);

	// Run totals (rolled up across lineage) — one-line header.
	let totalTokens = $state(0);
	let costLabel = $state<string | null>(null);

	$effect(() => {
		const exec: ExecutionStreamStore = createExecutionStream(executionId);
		const unsub = exec.subscribe((s) => {
			runStatus = s.snapshot?.status ?? runStatus;
			currentNodeName = s.snapshot?.currentNodeName ?? s.currentPhase ?? currentNodeName;
			isStreaming = s.isLlmStreaming;
			if (s.snapshot) void refreshSessions();
		});
		return () => {
			unsub();
			exec.dispose();
		};
	});

	async function refreshSessions() {
		try {
			const res = await fetch(`/api/workflows/executions/${executionId}/sessions`);
			if (res.ok) sessions = ((await res.json()) as { sessions?: SessionRow[] }).sessions ?? [];
		} catch {
			/* best-effort */
		}
	}
	async function refreshMetrics() {
		try {
			const res = await fetch(`/api/workflows/executions/${executionId}/metrics`);
			if (res.ok) {
				const m = (await res.json()) as { totals?: { totalTokens?: number }; totalCostLabel?: string };
				totalTokens = m.totals?.totalTokens ?? 0;
				costLabel = m.totalCostLabel ?? null;
			}
		} catch {
			/* best-effort */
		}
	}

	const runActive = $derived(
		runStatus === 'running' ||
			runStatus === 'pending' ||
			sessions.some((s) => s.status === 'running' || s.status === 'idle' || s.status === 'rescheduling')
	);
	$effect(() => {
		void executionId;
		void refreshSessions();
		void refreshMetrics();
		if (!runActive) return;
		const t = setInterval(() => {
			void refreshSessions();
			void refreshMetrics();
		}, 5000);
		return () => clearInterval(t);
	});

	function nodeOf(s: SessionRow): string {
		const title = s.title ?? '';
		const idx = title.lastIndexOf('·');
		return (idx >= 0 ? title.slice(idx + 1) : title).trim() || s.id.slice(0, 10);
	}
	function isActive(s: SessionRow): boolean {
		return s.status === 'running' || s.status === 'idle' || s.status === 'rescheduling';
	}
	const ordered = $derived(
		[...sessions].sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? ''))
	);

	// Focus: explicit pick > canvas-clicked node's session > newest active > last.
	let pinnedId = $state<string | null>(null);
	const focusBySession = $derived.by(() => {
		if (!focusNode) return null;
		const match = ordered.find((s) => {
			const n = nodeOf(s);
			return n === focusNode || n.startsWith(focusNode + '-') || n.startsWith(focusNode + '/');
		});
		return match?.id ?? null;
	});
	const newestActive = $derived.by(() => {
		const a = ordered.filter(isActive);
		return a.length ? a[a.length - 1].id : null;
	});
	const focusedId = $derived(
		pinnedId ?? focusBySession ?? newestActive ?? (ordered.length ? ordered[ordered.length - 1].id : null)
	);
	const following = $derived(pinnedId === null);

	function statusTone(s: string | null): string {
		switch (s) {
			case 'running':
			case 'pending':
				return 'bg-teal-500';
			case 'success':
				return 'bg-emerald-500';
			case 'error':
				return 'bg-red-500';
			case 'cancelled':
				return 'bg-amber-500';
			default:
				return 'bg-muted-foreground/40';
		}
	}
</script>

<div class="flex min-h-0 flex-col">
	<!-- One-line run header -->
	<div class="flex items-center gap-2 border-b px-3 py-1.5 text-[11px]">
		<span class="size-2 shrink-0 rounded-full {statusTone(runStatus)} {runActive ? 'animate-pulse' : ''}"></span>
		<span class="font-medium">{runStatus ?? '—'}</span>
		{#if currentNodeName}<span class="truncate text-muted-foreground">· {currentNodeName}</span>{/if}
		<span class="ml-auto flex shrink-0 items-center gap-2 text-muted-foreground">
			{#if totalTokens > 0}<span>{fmtTokens(totalTokens)} tok</span>{/if}
			{#if costLabel}<span>{costLabel}</span>{/if}
		</span>
	</div>

	<!-- Slim controls: session switcher + branches + full page -->
	<div class="flex items-center gap-2 border-b px-3 py-1.5 text-[11px]">
		<select
			class="min-w-0 flex-1 rounded border bg-background px-1.5 py-0.5 text-[11px]"
			value={focusedId ?? ''}
			onchange={(e) => (pinnedId = (e.currentTarget as HTMLSelectElement).value || null)}
			disabled={ordered.length === 0}
		>
			{#if ordered.length === 0}
				<option value="">No sessions yet</option>
			{/if}
			{#each ordered as s (s.id)}
				<option value={s.id}>{nodeOf(s)}{s.inherited ? ' (inherited)' : ''} · {s.status ?? '—'}</option>
			{/each}
		</select>
		{#if following}
			<span class="inline-flex shrink-0 items-center gap-1 text-teal-600 dark:text-teal-400" title="Following the newest active session">
				<Radio class="size-3" />
			</span>
		{:else}
			<button class="inline-flex shrink-0 items-center gap-1 text-amber-600 dark:text-amber-400" title="Pinned — click to follow latest" onclick={() => (pinnedId = null)}>
				<Pin class="size-3" />
			</button>
		{/if}
		<button
			class="inline-flex shrink-0 items-center gap-1 rounded px-1 py-0.5 hover:bg-muted {branchesOpen ? 'text-primary' : 'text-muted-foreground'}"
			onclick={() => (branchesOpen = !branchesOpen)}
			title="Fork branches"
		>
			<GitBranch class="size-3" /><ChevronDown class="size-2.5 transition-transform {branchesOpen ? 'rotate-180' : ''}" />
		</button>
		<a
			class="inline-flex shrink-0 items-center gap-1 rounded px-1 py-0.5 text-muted-foreground hover:bg-muted"
			href="/workspaces/{slug}/workflows/{workflowId}/runs/{executionId}"
			title="Open the full run page (outputs, code, plan, browser, traces)"
		>
			<ExternalLink class="size-3" />
		</a>
	</div>

	{#if branchesOpen}
		<div class="max-h-48 shrink-0 overflow-y-auto border-b">
			<RunLineageTree {executionId} {slug} {workflowId} selectedId={executionId} />
		</div>
	{/if}

	<!-- Transcript — FULL panel width, single column -->
	<div class="min-h-0 flex-1 overflow-hidden">
		{#if focusedId}
			{#key focusedId}
				<SessionTranscript sessionId={focusedId} compact showPulse={false} showTimeline={false} />
			{/key}
		{:else}
			<div class="flex h-full flex-col items-center justify-center px-4 text-center text-muted-foreground">
				<div class="rounded-full bg-muted p-3"><Inbox size={22} /></div>
				<p class="mt-3 text-xs font-medium">{runActive ? 'Waiting for the first session…' : 'No agent sessions in this run'}</p>
				<p class="mt-1 text-[11px]">Click a node on the canvas to focus its activity, or watch node status on the graph.</p>
			</div>
		{/if}
	</div>
</div>
