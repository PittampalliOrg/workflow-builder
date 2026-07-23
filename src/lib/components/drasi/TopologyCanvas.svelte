<script lang="ts">
	import {
		SvelteFlow,
		Background,
		BackgroundVariant,
		Controls,
		MarkerType,
		type Node,
		type Edge,
		type NodeTypes,
		type EdgeTypes,
	} from "@xyflow/svelte";
	import "@xyflow/svelte/dist/style.css";
	import { DRASI_EDGES, DRASI_NODES } from "$lib/drasi/catalog";
	import type { DrasiSelection } from "$lib/types/drasi";
	import TopologyNode from "./TopologyNode.svelte";
	import TopologyEdge from "./TopologyEdge.svelte";

	let { onSelect }: { onSelect?: (selection: DrasiSelection | null) => void } = $props();

	const nodeTypes: NodeTypes = { drasi: TopologyNode };
	const edgeTypes: EdgeTypes = { drasi: TopologyEdge };

	const NODE_W = 232;
	const NODE_LABELS = new Map(DRASI_NODES.map((spec) => [spec.id, spec.label]));

	// The topology is curated configuration — nodes/edges are built once and
	// never change at runtime. `$state.raw` because we never mutate entries.
	// Every interactive element is exposed as a button (not a group) with an
	// aria-label that identifies the node, or the edge's source → target.
	let nodes = $state.raw<Node[]>(
		DRASI_NODES.map((spec) => ({
			id: spec.id,
			type: "drasi",
			position: { x: spec.x, y: spec.y },
			width: NODE_W,
			data: { spec },
			draggable: false,
			connectable: false,
			ariaRole: "button",
			ariaLabel: `${spec.label} — ${spec.subtitle}`,
		})),
	);
	let edges = $state.raw<Edge[]>(
		DRASI_EDGES.map((spec) => {
			const sourceLabel = NODE_LABELS.get(spec.source) ?? spec.source;
			const targetLabel = NODE_LABELS.get(spec.target) ?? spec.target;
			return {
				id: spec.id,
				source: spec.source,
				target: spec.target,
				type: "drasi",
				animated: spec.animated,
				data: { spec },
				selectable: true,
				ariaRole: "button",
				ariaLabel: `${sourceLabel} → ${targetLabel}`,
				markerEnd: {
					type: MarkerType.ArrowClosed,
					width: 14,
					height: 14,
					color: "var(--border)",
				},
			};
		}),
	);

	let colorMode = $derived<"light" | "dark" | "system">("system");

	/**
	 * Keyboard parity for pointer activation. XYFlow marks a focused node as
	 * selected on Enter but never emits `onnodeclick` for it, so the supported
	 * boundary is a delegated keydown on the flow container: the focused
	 * `.svelte-flow__node` / `.svelte-flow__edge` (already tabbable via
	 * `nodesFocusable` / `edgesFocusable`) resolves its `data-id` and opens the
	 * same detail sheet a pointer click would. No synthetic clicks, no extra
	 * tab stops. Escape/close focus-restore is handled by the dialog itself.
	 */
	function handleFlowKeydown(event: KeyboardEvent) {
		if (event.key !== "Enter" && event.key !== " ") return;
		const target = event.target as HTMLElement | null;
		if (!target) return;
		const nodeEl = target.closest<HTMLElement>(".svelte-flow__node");
		if (nodeEl?.dataset.id) {
			event.preventDefault();
			onSelect?.({ kind: "node", id: nodeEl.dataset.id });
			return;
		}
		const edgeEl = target.closest<HTMLElement>(".svelte-flow__edge");
		if (edgeEl?.dataset.id) {
			event.preventDefault();
			onSelect?.({ kind: "edge", id: edgeEl.dataset.id });
		}
	}
</script>

<div
	class="relative h-full w-full"
	role="region"
	aria-label="Drasi change-detection topology map"
>
	<div
		class="pointer-events-none absolute left-3 top-3 z-10 flex max-w-[calc(100%-4rem)] flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-border/50 bg-background/80 px-2.5 py-1.5 backdrop-blur"
	>
		<span class="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">
			Flow
		</span>
		<span class="inline-flex items-center gap-1.5 text-[10px] text-muted-foreground">
			<span class="h-0 w-4 border-t-2 border-solid border-muted-foreground/60" aria-hidden="true"></span>
			rows / CDC
		</span>
		<span class="inline-flex items-center gap-1.5 text-[10px] text-muted-foreground">
			<span class="h-0 w-4 border-t-2 border-dashed border-primary/70" aria-hidden="true"></span>
			added results → governed ingest
		</span>
	</div>
	<div
		class="pointer-events-none absolute bottom-3 right-3 z-10 rounded-md border border-border/50 bg-background/80 px-2 py-1 text-[10px] text-muted-foreground backdrop-blur"
	>
		Pan · zoom · select a node or edge for detail
	</div>
	<SvelteFlow
		bind:nodes
		bind:edges
		{nodeTypes}
		{edgeTypes}
		{colorMode}
		nodesDraggable={false}
		nodesConnectable={false}
		elementsSelectable={true}
		nodesFocusable={true}
		edgesFocusable={true}
		zoomOnDoubleClick={false}
		minZoom={0.05}
		maxZoom={1.75}
		fitView
		fitViewOptions={{ padding: 0.12, maxZoom: 1 }}
		onnodeclick={({ node }) => onSelect?.({ kind: "node", id: node.id })}
		onedgeclick={({ edge }) => onSelect?.({ kind: "edge", id: edge.id })}
		onpaneclick={() => onSelect?.(null)}
		onkeydown={handleFlowKeydown}
	>
		<!-- Controls sit top-right: the legend is capped at calc(100% - 4rem) so
			it never reaches them, and they stay clear of the global bottom status
			toast at every viewport. -->
		<Controls showLock={false} position="top-right" />
		<Background
			variant={BackgroundVariant.Dots}
			bgColor="var(--background)"
			patternColor="var(--border)"
			gap={24}
			size={2}
		/>
	</SvelteFlow>
</div>

<style>
	/* Marching-dash animation respects reduced motion. */
	@media (prefers-reduced-motion: reduce) {
		:global(.svelte-flow__edge.animated .svelte-flow__edge-path) {
			animation: none !important;
		}
	}
	:global(.svelte-flow__node:focus-visible) {
		outline: 2px solid var(--ring);
		outline-offset: 2px;
		border-radius: calc(var(--radius) + 4px);
	}
	:global(.svelte-flow__edge:focus-visible .svelte-flow__edge-path) {
		stroke: var(--ring);
	}
</style>
