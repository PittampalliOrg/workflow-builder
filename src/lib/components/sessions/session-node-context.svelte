<script lang="ts">
	/**
	 * Session → run node context. When a session was spawned by a workflow node, this
	 * shows "where am I in the run": the run's top-level nodes (from the execution
	 * snapshot's steps) with the node that owns this session highlighted. Gives an
	 * agent-centric session page the same node-level legibility as the run console.
	 */
	import { ExternalLink } from '@lucide/svelte';
	import type { ExecutionStepLog } from '$lib/types/execution-stream';

	interface Props {
		executionId: string;
		slug: string;
		workflowId: string;
		/** This session's node label (best-effort) — the matching step is highlighted. */
		highlightNode?: string | null;
	}
	let { executionId, slug, workflowId, highlightNode = null }: Props = $props();

	let steps = $state<ExecutionStepLog[]>([]);
	let loading = $state(true);

	$effect(() => {
		void executionId;
		loading = true;
		fetch(`/api/workflows/executions/${executionId}/status`)
			.then((r) => (r.ok ? r.json() : null))
			.then((d) => {
				steps = (d?.steps ?? []) as ExecutionStepLog[];
			})
			.catch(() => {})
			.finally(() => (loading = false));
	});

	// A step "owns" this session when its name prefixes the session's node label
	// (top-level node `negotiate` owns sub-node `negotiate-review-0`).
	function isOwner(stepName: string): boolean {
		if (!highlightNode) return false;
		return (
			highlightNode === stepName ||
			highlightNode.startsWith(stepName + '-') ||
			highlightNode.startsWith(stepName + '/')
		);
	}
	function dot(status: string): string {
		switch (status) {
			case 'running':
				return 'bg-teal-500';
			case 'success':
				return 'bg-emerald-500';
			case 'error':
				return 'bg-red-500';
			default:
				return 'bg-muted-foreground/40';
		}
	}
</script>

<div class="border-b bg-muted/20 px-4 py-2">
	<div class="mb-1 flex items-center justify-between">
		<span class="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/70">
			Run steps
		</span>
		<a
			href="/workspaces/{slug}/workflows/{workflowId}/runs/{executionId}"
			class="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
		>
			<ExternalLink class="size-3" /> Full run
		</a>
	</div>
	{#if loading}
		<p class="text-[11px] text-muted-foreground">Loading…</p>
	{:else if steps.length === 0}
		<p class="text-[11px] text-muted-foreground">No node steps recorded for this run.</p>
	{:else}
		<div class="flex flex-wrap items-center gap-1">
			{#each steps as s (s.stepName)}
				{@const owner = isOwner(s.stepName)}
				<span
					class="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] {owner
						? 'border-primary/50 bg-primary/10 font-medium text-primary'
						: 'border-transparent bg-muted text-muted-foreground'}"
					title="{s.actionType} · {s.status}"
				>
					<span class="size-1.5 rounded-full {dot(s.status)}"></span>
					{s.displayLabel ?? s.label ?? s.stepName}{#if owner} · here{/if}
				</span>
			{/each}
		</div>
	{/if}
</div>
