<script lang="ts">
	/**
	 * Session → run node context. When a session was spawned by a workflow node, this
	 * shows "where am I in the run": the run's top-level nodes with the node that owns
	 * this session highlighted + live per-node status. Gives an agent-centric session
	 * page the same node-level legibility as the run console.
	 *
	 * The spine is built from the WORKFLOW NODES + the execution snapshot (via
	 * `buildExecutionCanvasState`, the same source the run-page progress band uses) —
	 * NOT from `workflow_execution_logs` steps. That matters because agent (`durable/run`)
	 * nodes report via sessions, not log steps, and a FORK's skipped prefix nodes never
	 * dispatch — so a logs-only spine is empty for exactly the runs (forks / agent-only)
	 * where the user most wants this context.
	 */
	import { ExternalLink } from '@lucide/svelte';
	import type { Node, Edge } from '@xyflow/svelte';
	import type { ExecutionReadModel } from '$lib/types/execution-stream';
	import {
		buildExecutionCanvasState,
		type ExecutionCanvasStatus
	} from '$lib/utils/execution-canvas';

	interface Props {
		executionId: string;
		slug: string;
		workflowId: string;
		/** This session's node label (best-effort) — the matching node is highlighted. */
		highlightNode?: string | null;
	}
	let { executionId, slug, workflowId, highlightNode = null }: Props = $props();

	let nodes = $state<Node[]>([]);
	let edges = $state<Edge[]>([]);
	let snapshot = $state<ExecutionReadModel | null>(null);
	let loadingNodes = $state(true);
	let loadingSnapshot = $state(true);

	// Workflow graph (all top-level nodes) — fetched once. For a fork this is the same
	// workflow, so its nodes cover the executed spec (incl. resumed/added steps).
	$effect(() => {
		void workflowId;
		loadingNodes = true;
		fetch(`/api/workflows/${workflowId}`)
			.then((r) => (r.ok ? r.json() : null))
			.then((d) => {
				nodes = (d?.nodes ?? []) as Node[];
				edges = (d?.edges ?? []) as Edge[];
			})
			.catch(() => {})
			.finally(() => (loadingNodes = false));
	});

	// Execution snapshot — polled while the run is active so status stays live.
	$effect(() => {
		void executionId;
		let stopped = false;
		let timer: ReturnType<typeof setInterval> | null = null;
		const load = async () => {
			try {
				const r = await fetch(`/api/workflows/executions/${executionId}/status`);
				if (r.ok) snapshot = (await r.json()) as ExecutionReadModel;
			} catch {
				/* best-effort */
			} finally {
				loadingSnapshot = false;
			}
			const st = snapshot?.status;
			if ((st === 'success' || st === 'error' || st === 'cancelled') && timer) {
				clearInterval(timer);
				timer = null;
			}
		};
		void load();
		timer = setInterval(() => {
			if (!stopped) void load();
		}, 4000);
		return () => {
			stopped = true;
			if (timer) clearInterval(timer);
		};
	});

	const canvas = $derived(buildExecutionCanvasState(snapshot, nodes, edges));
	// Ordered, meaningful nodes (drop synthetic start/end + non-executing notes).
	const steps = $derived.by(() =>
		nodes
			.filter((n) => n.type !== 'start' && n.type !== 'end' && n.type !== 'note')
			.map((n) => {
				const d = (n.data ?? {}) as Record<string, unknown>;
				const label =
					(typeof d.label === 'string' && d.label) ||
					(typeof d.stepName === 'string' && d.stepName) ||
					(typeof d.name === 'string' && d.name) ||
					n.id;
				return {
					id: n.id,
					label: String(label),
					status: (canvas.nodeStatuses[n.id] ?? 'idle') as ExecutionCanvasStatus
				};
			})
	);
	const loading = $derived(loadingNodes && loadingSnapshot);

	// A node "owns" this session when its name prefixes the session's node label
	// (top-level node `negotiate` owns sub-node `negotiate-review-0`).
	function isOwner(nodeId: string): boolean {
		if (!highlightNode) return false;
		return (
			highlightNode === nodeId ||
			highlightNode.startsWith(nodeId + '-') ||
			highlightNode.startsWith(nodeId + '/')
		);
	}
	function dot(status: ExecutionCanvasStatus): string {
		switch (status) {
			case 'running':
				return 'bg-teal-500 animate-pulse';
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
		<p class="text-[11px] text-muted-foreground">No nodes to show for this run.</p>
	{:else}
		<div class="flex flex-wrap items-center gap-1">
			{#each steps as s (s.id)}
				{@const owner = isOwner(s.id)}
				<span
					class="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] {owner
						? 'border-primary/50 bg-primary/10 font-medium text-primary'
						: 'border-transparent bg-muted text-muted-foreground'}"
					title="{s.label} · {s.status}"
				>
					<span class="size-1.5 rounded-full {dot(s.status)}"></span>
					{s.label}{#if owner} · here{/if}
				</span>
			{/each}
		</div>
	{/if}
</div>
