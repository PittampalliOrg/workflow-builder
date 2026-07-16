<script lang="ts">
	import {
		SvelteFlow,
		Background,
		BackgroundVariant,
		Controls,
		type Node,
		type Edge,
		type NodeTypes,
		type EdgeTypes
	} from '@xyflow/svelte';
	import '@xyflow/svelte/dist/style.css';
	import { CircleAlert, RefreshCw } from '@lucide/svelte';
	import { Button } from '$lib/components/ui/button';
	import { createLayoutConfig, layoutWorkflowGraph } from '$lib/utils/layout';
	import type { GraphSelection, ServiceGraphNode as SGNode, ServiceGraphPayload } from '$lib/types/service-graph';
	import ServiceGraphNode, { phaseHue } from './service-graph-node.svelte';
	import ServiceGraphEdge from './service-graph-edge.svelte';

	let {
		payload,
		loading = false,
		error = null,
		onRetry,
		onSelect
	}: {
		payload: ServiceGraphPayload | null;
		loading?: boolean;
		error?: string | null;
		onRetry?: () => void;
		onSelect?: (sel: GraphSelection | null) => void;
	} = $props();

	const nodeTypes: NodeTypes = { metric: ServiceGraphNode };
	const edgeTypes: EdgeTypes = { metric: ServiceGraphEdge };

	const NODE_W = 196;
	const NODE_H = 76;

	let canvasNodes = $state.raw<Node[]>([]);
	let canvasEdges = $state.raw<Edge[]>([]);

	let colorMode = $derived<'light' | 'dark' | 'system'>('system');

	// Re-layout whenever the payload identity changes. Insight + critical-path are
	// part of the payload, so they're baked here (no relayout on selection).
	$effect(() => {
		const p = payload;
		if (!p || p.nodes.length === 0) {
			canvasNodes = [];
			canvasEdges = [];
			return;
		}

		const maxRate = Math.max(1, ...p.edges.map((e) => e.red.rate));
		const path = p.insights?.criticalPath ?? [];
		const criticalNodes = new Set(path);
		const criticalEdges = new Set<string>();
		for (let i = 0; i < path.length - 1; i++) criticalEdges.add(`${path[i]}__${path[i + 1]}`);
		const liveNodes = new Set(p.nodes.filter((n) => n.live).map((n) => n.id));
		const hasBadges = p.nodes.some((n) => n.group || n.detail);

		const rawNodes: Node[] = p.nodes.map((n) => ({
			id: n.id,
			type: 'metric',
			position: { x: 0, y: 0 },
			width: NODE_W,
			height: hasBadges ? NODE_H + 22 : NODE_H,
			data: { node: n, insight: p.insights?.nodes[n.id] ?? null, onCritical: criticalNodes.has(n.id) }
		}));
		const edges: Edge[] = p.edges.map((e) => ({
			id: e.id,
			source: e.source,
			target: e.target,
			type: 'metric',
			data: {
				edge: e,
				maxRate,
				scope: p.scope,
				onCritical: criticalEdges.has(e.id),
				liveFlow: liveNodes.has(e.target) || liveNodes.has(e.source)
			}
		}));

		const preset = p.nodes.length > 25 ? 'review' : 'flow';
		const config = createLayoutConfig({ direction: 'LR', preset });
		let cancelled = false;
		layoutWorkflowGraph(rawNodes, edges, config).then((positioned) => {
			if (cancelled) return;
			canvasNodes = positioned;
			canvasEdges = edges;
		});
		return () => {
			cancelled = true;
		};
	});

	let isEmpty = $derived(!loading && !error && (!payload || payload.nodes.length === 0));

	// Phase legend (dynamic-script step graphs): distinct groups in node order.
	let phases = $derived.by(() => {
		const seen: string[] = [];
		for (const n of payload?.nodes ?? []) {
			if (n.group && !seen.includes(n.group)) seen.push(n.group);
		}
		return seen;
	});
</script>

<div class="relative h-full w-full">
	{#if phases.length > 0}
		<div class="pointer-events-none absolute left-3 top-3 z-10 flex flex-wrap items-center gap-2 rounded-md border border-border/50 bg-background/80 px-2.5 py-1.5 backdrop-blur">
			<span class="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">Phases</span>
			{#each phases as phase (phase)}
				<span class="inline-flex items-center gap-1.5 text-[10px] text-muted-foreground">
					<span class="size-2 rounded-full" style="background: {phaseHue(phase)}"></span>
					{phase}
				</span>
			{/each}
		</div>
	{/if}
	{#if error}
		<div
			class="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 px-6 text-center"
			role="alert"
		>
			<CircleAlert class="size-5 text-destructive" />
			<p class="max-w-md text-sm text-foreground">{error}</p>
			{#if onRetry}
				<Button variant="outline" size="sm" class="h-7 gap-1.5" onclick={onRetry}>
					<RefreshCw class="size-3" /> Retry
				</Button>
			{/if}
		</div>
	{:else if isEmpty}
		<div
			class="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 text-center text-sm text-muted-foreground"
		>
			<p>No graph data for this selection.</p>
			{#if payload?.meta.warnings?.length}
				<p class="text-xs">{payload.meta.warnings.join(' · ')}</p>
			{/if}
		</div>
	{/if}
	<SvelteFlow
		bind:nodes={canvasNodes}
		bind:edges={canvasEdges}
		{nodeTypes}
		{edgeTypes}
		{colorMode}
		nodesDraggable={false}
		nodesConnectable={false}
		elementsSelectable={true}
		zoomOnDoubleClick={false}
		minZoom={0.1}
		maxZoom={2}
		fitView
		onnodeclick={({ node }) =>
			onSelect?.({ kind: 'node', id: node.id, nodeKind: (node.data.node as SGNode).kind })}
		onedgeclick={({ edge }) =>
			onSelect?.({ kind: 'edge', id: edge.id, source: edge.source, target: edge.target })}
		onpaneclick={() => onSelect?.(null)}
	>
		<Controls showLock={false} />
		<Background
			variant={BackgroundVariant.Dots}
			bgColor="var(--background)"
			patternColor="var(--border)"
			gap={24}
			size={2}
		/>
	</SvelteFlow>
</div>
