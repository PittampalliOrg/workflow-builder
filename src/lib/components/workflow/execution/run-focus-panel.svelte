<script lang="ts">
	/**
	 * Run launchpad — the canvas's lightweight overview of a selected run.
	 *
	 * The canvas is the EDITOR; run/session REVIEW happens on the full run page (its own
	 * focused, full-width surface). So this panel does NOT embed the transcript (that was
	 * cramped + slow). Instead it's a launchpad: a one-line run header, a STRUCTURED node
	 * overview (every top-level node + live status), and a fork-branches disclosure.
	 * Clicking a node opens the full run page focused on that node; "Open run review"
	 * opens it at the top. Fast, structured, and never fights the editor for space.
	 */
	import { goto } from '$app/navigation';
	import { ChevronDown, ExternalLink, GitBranch, Inbox } from '@lucide/svelte';
	import { createExecutionStream, type ExecutionStreamStore } from '$lib/stores/execution-stream.svelte';
	import RunLineageTree from '$lib/components/workflow/execution/run-lineage-tree.svelte';
	import type { ExecutionStepLog } from '$lib/types/execution-stream';
	import { fmtTokens } from '$lib/utils/format-tokens';

	interface Props {
		executionId: string;
		slug: string;
		workflowId: string;
		/** Top-level node names (canvas order) — the structured overview spine. */
		nodeNames?: string[];
		/** The node currently selected on the canvas (highlighted). */
		focusNode?: string | null;
	}
	let { executionId, slug, workflowId, nodeNames = [], focusNode = null }: Props = $props();

	type SessionRow = { id: string; title: string | null; status: string | null };

	let runStatus = $state<string | null>(null);
	let currentNodeId = $state<string | null>(null);
	let currentNodeName = $state<string | null>(null);
	let nodeStatuses = $state<Record<string, string>>({});
	let steps = $state<ExecutionStepLog[]>([]);
	let sessions = $state<SessionRow[]>([]);
	let totalTokens = $state(0);
	let costLabel = $state<string | null>(null);
	let branchesOpen = $state(false);

	$effect(() => {
		const exec: ExecutionStreamStore = createExecutionStream(executionId);
		const unsub = exec.subscribe((s) => {
			runStatus = s.snapshot?.status ?? runStatus;
			currentNodeId = s.snapshot?.currentNodeId ?? currentNodeId;
			currentNodeName = s.snapshot?.currentNodeName ?? s.currentPhase ?? currentNodeName;
			if (s.snapshot?.nodeStatuses) nodeStatuses = s.snapshot.nodeStatuses;
			if (s.snapshot?.steps) steps = s.snapshot.steps;
		});
		return () => {
			unsub();
			exec.dispose();
		};
	});

	async function refresh() {
		try {
			const [sRes, mRes] = await Promise.all([
				fetch(`/api/workflows/executions/${executionId}/sessions`),
				fetch(`/api/workflows/executions/${executionId}/metrics`)
			]);
			if (sRes.ok) sessions = ((await sRes.json()) as { sessions?: SessionRow[] }).sessions ?? [];
			if (mRes.ok) {
				const m = (await mRes.json()) as { totals?: { totalTokens?: number }; totalCostLabel?: string };
				totalTokens = m.totals?.totalTokens ?? 0;
				costLabel = m.totalCostLabel ?? null;
			}
		} catch {
			/* best-effort */
		}
	}
	const runActive = $derived(runStatus === 'running' || runStatus === 'pending');
	$effect(() => {
		void executionId;
		void refresh();
		if (!runActive) return;
		const t = setInterval(refresh, 5000);
		return () => clearInterval(t);
	});

	function nodeOf(s: SessionRow): string {
		const title = s.title ?? '';
		const idx = title.lastIndexOf('·');
		return (idx >= 0 ? title.slice(idx + 1) : title).trim();
	}
	function sessionsFor(name: string): SessionRow[] {
		return sessions.filter((s) => {
			const n = nodeOf(s);
			return n === name || n.startsWith(name + '-') || n.startsWith(name + '/');
		});
	}
	function stepFor(name: string): ExecutionStepLog | null {
		return steps.find((s) => s.stepName === name) ?? null;
	}
	// Resolve a node's status from logs, then sessions, then the live current node.
	function nodeState(name: string): string {
		if (nodeStatuses[name]) return nodeStatuses[name];
		const st = stepFor(name);
		if (st) return st.status;
		const ss = sessionsFor(name);
		if (ss.length) {
			if (ss.some((s) => s.status === 'running' || s.status === 'idle' || s.status === 'rescheduling'))
				return 'running';
			if (ss.every((s) => s.status === 'terminated' || s.status === 'completed')) return 'success';
			if (ss.some((s) => s.status === 'error')) return 'error';
		}
		if (currentNodeId === name || currentNodeName === name) return 'running';
		return 'pending';
	}
	function dotClass(state: string): string {
		switch (state) {
			case 'running':
			case 'pending-active':
				return 'bg-teal-500 animate-pulse';
			case 'success':
				return 'bg-emerald-500';
			case 'error':
				return 'bg-red-500';
			case 'cancelled':
				return 'bg-amber-500';
			default:
				return 'bg-muted-foreground/30';
		}
	}
	function statusTone(s: string | null): string {
		switch (s) {
			case 'running':
			case 'pending':
				return 'bg-teal-500';
			case 'success':
				return 'bg-emerald-500';
			case 'error':
				return 'bg-red-500';
			default:
				return 'bg-muted-foreground/40';
		}
	}
	function openNode(name: string) {
		goto(`/workspaces/${slug}/workflows/${workflowId}/runs/${executionId}?node=${encodeURIComponent(name)}`);
	}
	function openReview() {
		goto(`/workspaces/${slug}/workflows/${workflowId}/runs/${executionId}`);
	}
</script>

<div class="flex min-h-0 flex-col">
	<!-- One-line run header -->
	<div class="flex items-center gap-2 border-b px-3 py-1.5 text-[11px]">
		<span class="size-2 shrink-0 rounded-full {statusTone(runStatus)} {runActive ? 'animate-pulse' : ''}"></span>
		<span class="font-medium">{runStatus ?? '—'}</span>
		{#if currentNodeName && runActive}<span class="truncate text-muted-foreground">· {currentNodeName}</span>{/if}
		<span class="ml-auto flex shrink-0 items-center gap-2 text-muted-foreground">
			{#if totalTokens > 0}<span>{fmtTokens(totalTokens)} tok</span>{/if}
			{#if costLabel}<span>{costLabel}</span>{/if}
		</span>
	</div>

	<!-- Controls: open full review + branches -->
	<div class="flex items-center gap-2 border-b px-3 py-1.5 text-[11px]">
		<button
			class="inline-flex flex-1 items-center justify-center gap-1.5 rounded-md border border-primary/40 bg-primary/10 px-2 py-1 font-medium text-primary hover:bg-primary/15"
			onclick={openReview}
		>
			<ExternalLink class="size-3" /> Open run review
		</button>
		<button
			class="inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-1 hover:bg-muted {branchesOpen ? 'text-primary' : 'text-muted-foreground'}"
			onclick={() => (branchesOpen = !branchesOpen)}
			title="Fork branches"
		>
			<GitBranch class="size-3" /><ChevronDown class="size-2.5 transition-transform {branchesOpen ? 'rotate-180' : ''}" />
		</button>
	</div>

	{#if branchesOpen}
		<div class="max-h-48 shrink-0 overflow-y-auto border-b">
			<RunLineageTree {executionId} {slug} {workflowId} selectedId={executionId} />
		</div>
	{/if}

	<!-- Structured node overview -->
	<div class="min-h-0 flex-1 overflow-y-auto p-1.5">
		<div class="px-1.5 pb-1 pt-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">
			Nodes
		</div>
		{#if nodeNames.length === 0}
			<div class="flex flex-col items-center justify-center py-10 text-center text-muted-foreground">
				<div class="rounded-full bg-muted p-3"><Inbox size={20} /></div>
				<p class="mt-2 text-[11px]">No nodes to show.</p>
			</div>
		{:else}
			{#each nodeNames as name (name)}
				{@const state = nodeState(name)}
				{@const ss = sessionsFor(name)}
				{@const st = stepFor(name)}
				<button
					class="mb-0.5 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors {focusNode === name
						? 'bg-primary/10 ring-1 ring-primary/40'
						: 'hover:bg-muted/60'}"
					onclick={() => openNode(name)}
					title="Open this node's activity on the run review page"
				>
					<span class="size-2 shrink-0 rounded-full {dotClass(state)}"></span>
					<span class="min-w-0 flex-1 truncate text-xs font-medium">{name}</span>
					{#if ss.length > 0}
						<span class="shrink-0 text-[10px] text-muted-foreground">{ss.length} session{ss.length === 1 ? '' : 's'}</span>
					{/if}
					{#if st?.durationMs != null}
						<span class="shrink-0 text-[10px] text-muted-foreground/70">{Math.round(st.durationMs / 1000)}s</span>
					{/if}
					<ExternalLink class="size-3 shrink-0 text-muted-foreground/50" />
				</button>
			{/each}
		{/if}
	</div>
</div>
