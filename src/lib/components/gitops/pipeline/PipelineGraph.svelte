<script lang="ts">
	import { setContext } from "svelte";
	import {
		Background,
		BackgroundVariant,
		Controls,
		MiniMap,
		SvelteFlow,
		type Edge,
		type Node,
		type NodeTypes,
	} from "@xyflow/svelte";

	import {
		computePipelineGraph,
		PIPELINE_HOVER_CONTEXT,
		PIPELINE_NODE_TYPE,
		type PipelineNodeData,
	} from "$lib/gitops/pipeline-layout";
	import type { PipelineModel } from "$lib/gitops/pipeline-types";

	import PipelineFitView from "./PipelineFitView.svelte";
	import PipelineNode from "./PipelineNode.svelte";

	export type PipelineSelection =
		| { kind: "stage" | "warehouse" | "subscription"; id: string }
		| null;

	type Props = {
		model: PipelineModel;
		pipelineFilter?: string[];
		hideSubscriptions?: boolean;
		stepEdges?: boolean;
		showMinimap?: boolean;
		groupLanes?: boolean;
		stageSearch?: string;
		selected?: PipelineSelection;
		onselect?: (sel: PipelineSelection) => void;
	};
	let {
		model,
		pipelineFilter = [],
		hideSubscriptions = true,
		stepEdges = false,
		showMinimap = false,
		groupLanes = false,
		stageSearch = "",
		selected = null,
		onselect,
	}: Props = $props();

	const nodeTypes: NodeTypes = { [PIPELINE_NODE_TYPE]: PipelineNode };

	let flowNodes = $state<Node[]>([]);
	let flowEdges = $state<Edge[]>([]);

	// Warehouse the cursor is hovering — set by warehouse nodes through context.
	// Hover highlights that warehouse's edges and dims the rest (ported from Kargo).
	let hoveredWarehouse = $state<string | null>(null);
	setContext(PIPELINE_HOVER_CONTEXT, {
		setHovered: (name: string | null) => (hoveredWarehouse = name),
	});

	const search = $derived(stageSearch.trim().toLowerCase());

	// The warehouse whose edges should be emphasized (selected node's warehouse).
	const emphasizedWarehouse = $derived.by(() => {
		if (!selected) return null;
		if (selected.kind === "warehouse") return selected.id.replace(/^warehouse\//, "");
		if (selected.kind === "stage") {
			const stage = model.stages.find((s) => `stage/${s.name}` === selected.id);
			return stage?.warehouse ?? null;
		}
		return null;
	});

	// Expensive dagre layout recomputes only when the graph SHAPE changes
	// (model / filter / subscription visibility / edge style) — NOT on every
	// hover/select/search, which only re-style the already-laid-out elements.
	const base = $derived(
		computePipelineGraph(model, { pipelineFilter, hideSubscriptions, stepEdges, groupLanes }),
	);

	$effect(() => {
		const s = search;
		const emphasize = hoveredWarehouse ?? emphasizedWarehouse;

		flowNodes = base.nodes.map((node) => {
			const data = node.data as PipelineNodeData;
			let highlight = false;
			if (s && data.kind === "stage" && data.stage) {
				highlight =
					data.stage.warehouse.toLowerCase().includes(s) ||
					data.stage.env.toLowerCase().includes(s);
			}
			return { ...node, selected: selected?.id === node.id, data: { ...data, highlight } };
		});

		flowEdges = base.edges.map((edge) => {
			const warehouseName = (edge.data as { warehouseName?: string } | undefined)?.warehouseName;
			const color = warehouseName
				? (model.warehouseColorMap[warehouseName] ?? "#9ca3af")
				: "#9ca3af";
			const active = !emphasize || warehouseName === emphasize;
			const opacity = !emphasize ? 0.3 : active ? 0.9 : 0.08;
			return {
				...edge,
				style: `stroke:${color};stroke-width:4;stroke-opacity:${opacity};transition:stroke-opacity 0.2s ease;`,
			};
		});
	});

	// Stage node ids matching the current search — used to centre the viewport.
	const matchedNodeIds = $derived(
		search
			? base.nodes
					.filter((node) => {
						const data = node.data as PipelineNodeData;
						return (
							data.kind === "stage" &&
							!!data.stage &&
							(data.stage.warehouse.toLowerCase().includes(search) ||
								data.stage.env.toLowerCase().includes(search))
						);
					})
					.map((node) => node.id)
			: [],
	);

	const minZoom = $derived(flowNodes.length > 100 ? 0.4 : 0.1);

	function selectionFromNode(node: Node): PipelineSelection {
		const kind = node.id.split("/")[0];
		if (kind === "warehouse" || kind === "stage" || kind === "subscription") {
			return { kind, id: node.id };
		}
		// A collapsed lane selects its warehouse (drawer lists the env stages).
		if (kind === "lane") {
			return { kind: "warehouse", id: `warehouse/${node.id.slice("lane/".length)}` };
		}
		return null;
	}

	// Re-fit when the active pipeline / subscription visibility / grouping changes.
	const fitKey = $derived(`${pipelineFilter.join("|")}::${hideSubscriptions}::${groupLanes}`);
</script>

<SvelteFlow
	bind:nodes={flowNodes}
	bind:edges={flowEdges}
	{nodeTypes}
	nodesDraggable={false}
	nodesConnectable={false}
	elementsSelectable={true}
	zoomOnDoubleClick={false}
	onlyRenderVisibleElements
	{minZoom}
	maxZoom={1.4}
	onnodeclick={({ node }) => onselect?.(selectionFromNode(node))}
	onpaneclick={() => onselect?.(null)}
>
	<PipelineFitView {fitKey} focusKey={search} focusNodeIds={matchedNodeIds} />
	<Controls showLock={false} />
	{#if showMinimap}
		<MiniMap pannable zoomable />
	{/if}
	<Background
		variant={BackgroundVariant.Dots}
		bgColor="var(--background)"
		patternColor="var(--border)"
		gap={24}
		size={2}
	/>
</SvelteFlow>
