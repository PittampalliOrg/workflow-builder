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
	import { createLayoutConfig, layoutWorkflowGraph } from '$lib/utils/layout';
	import type { ServiceGraphPayload } from '$lib/types/service-graph';
	import ServiceGraphNode from './service-graph-node.svelte';
	import ServiceGraphEdge from './service-graph-edge.svelte';

	let { payload, loading = false }: { payload: ServiceGraphPayload | null; loading?: boolean } =
		$props();

	const nodeTypes: NodeTypes = { metric: ServiceGraphNode };
	const edgeTypes: EdgeTypes = { metric: ServiceGraphEdge };

	const NODE_W = 196;
	const NODE_H = 76;

	let canvasNodes = $state.raw<Node[]>([]);
	let canvasEdges = $state.raw<Edge[]>([]);

	let colorMode = $derived<'light' | 'dark' | 'system'>('system');

	// Re-layout whenever the payload identity changes.
	$effect(() => {
		const p = payload;
		if (!p || p.nodes.length === 0) {
			canvasNodes = [];
			canvasEdges = [];
			return;
		}

		const maxRate = Math.max(1, ...p.edges.map((e) => e.red.rate));
		const rawNodes: Node[] = p.nodes.map((n) => ({
			id: n.id,
			type: 'metric',
			position: { x: 0, y: 0 },
			width: NODE_W,
			height: NODE_H,
			data: { node: n }
		}));
		const edges: Edge[] = p.edges.map((e) => ({
			id: e.id,
			source: e.source,
			target: e.target,
			type: 'metric',
			data: { edge: e, maxRate, scope: p.scope }
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

	let isEmpty = $derived(!loading && (!payload || payload.nodes.length === 0));
</script>

<div class="relative h-full w-full">
	{#if isEmpty}
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
