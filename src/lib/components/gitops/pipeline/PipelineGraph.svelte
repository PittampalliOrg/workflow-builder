<script lang="ts">
	import { onDestroy, setContext, untrack } from "svelte";
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
	import { isFlowing } from "$lib/gitops/gitops-flow.svelte";
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

	// The warehouse whose edges should be emphasized (selected node's warehouse),
	// parsed from the selection id so this never reads the hot `model`.
	const emphasizedWarehouse = $derived.by(() => {
		if (!selected) return null;
		if (selected.kind === "warehouse") return selected.id.replace(/^warehouse\//, "");
		if (selected.kind === "stage") {
			const name = selected.id.replace(/^stage\//, "");
			const sep = name.lastIndexOf("::");
			return sep >= 0 ? name.slice(0, sep) : null;
		}
		return null;
	});

	// Structural fingerprint — changes only when the graph SHAPE changes
	// (warehouses, stages, edges, filter/options), NOT when live activity or the
	// clock ticks. The GitOps event stream re-derives `model` many times/sec;
	// re-running the dagre layout each time remounts nodes and is the root cause of
	// the hover flicker, so layout is keyed on shape alone.
	const layoutKey = $derived(
		[
			pipelineFilter.join(","),
			String(hideSubscriptions),
			String(stepEdges),
			String(groupLanes),
			model.warehouses
				.map((w) => `${w.name}:${w.subscriptions.map((s) => s.id).join("+")}`)
				.join(";"),
			model.stages
				.map(
					(s) =>
						`${s.name}>${s.requestedFreight
							.map(
								(r) =>
									`${r.origin}|${r.sources.direct ? "d" : ""}${(r.sources.stages ?? []).join("/")}`,
							)
							.join("&")}`,
				)
				.join(";"),
		].join("::"),
	);

	// Lay out only when `layoutKey` changes; read `model` untracked so activity
	// churn never retriggers the expensive dagre pass. `base` stays a stable
	// reference between shape changes.
	const base = $derived.by(() => {
		void layoutKey;
		return untrack(() =>
			computePipelineGraph(model, { pipelineFilter, hideSubscriptions, stepEdges, groupLanes }),
		);
	});

	// Throttle live-activity refresh: refreshing node data on every streamed event
	// churns the xyflow node array and fights hover. A fixed ~600ms cadence keeps
	// activity chips live enough; structural changes still apply instantly via
	// `base`, and interactions (search/selection) are never throttled.
	let liveModel = $state<PipelineModel>(untrack(() => model));
	const liveSync = setInterval(() => {
		if (liveModel !== model) liveModel = model;
	}, 600);
	onDestroy(() => clearInterval(liveSync));

	// Build nodes: stable id/position from `base`, fresh stage/warehouse (live
	// activity) from the throttled `liveModel`, plus search highlight + selection.
	// Does NOT read `hoveredWarehouse`, so hovering never rebuilds nodes.
	$effect(() => {
		const s = search;
		const sel = selected;
		const m = liveModel;
		const stageByName = new Map(m.stages.map((st) => [st.name, st]));
		const whByName = new Map(m.warehouses.map((w) => [w.name, w]));

		flowNodes = base.nodes.map((node) => {
			const data = node.data as PipelineNodeData;
			let fresh = data;
			if (data.kind === "stage" && data.stage) {
				const cur = stageByName.get(data.stage.name);
				if (cur) fresh = { ...data, stage: cur };
			} else if (data.kind === "warehouse" && data.warehouse) {
				const cur = whByName.get(data.warehouse.name);
				if (cur) fresh = { ...data, warehouse: cur };
			} else if (data.kind === "lane" && data.warehouse) {
				const wh = data.warehouse;
				const cur = whByName.get(wh.name);
				if (cur) {
					fresh = { ...data, warehouse: cur, stages: m.stages.filter((st) => st.warehouse === wh.name) };
				}
			}
			let highlight = false;
			if (s && fresh.kind === "stage" && fresh.stage) {
				highlight =
					fresh.stage.warehouse.toLowerCase().includes(s) ||
					fresh.stage.env.toLowerCase().includes(s);
			}
			return { ...node, selected: sel?.id === node.id, data: { ...fresh, highlight } };
		});
	});

	// Style edges only: emphasis follows hover or selection, and an edge whose
	// warehouse is currently "flowing" (a fresh event batch) gets a marching
	// dash pulse. Separate effect so hovering / event-flow restyles edges without
	// ever touching the node array (reading `isFlowing` subscribes to the decaying
	// flow set, so this re-runs on mark / decay only — not every frame).
	$effect(() => {
		const emphasize = hoveredWarehouse ?? emphasizedWarehouse;
		const colorMap = liveModel.warehouseColorMap;
		flowEdges = base.edges.map((edge) => {
			const warehouseName = (edge.data as { warehouseName?: string } | undefined)?.warehouseName;
			const color = warehouseName ? (colorMap[warehouseName] ?? "#9ca3af") : "#9ca3af";
			const flowing = warehouseName ? isFlowing(warehouseName) : false;
			const active = !emphasize || warehouseName === emphasize;
			const opacity = flowing ? 1 : !emphasize ? 0.3 : active ? 0.9 : 0.08;
			const head = `stroke:${color};stroke-width:4;stroke-opacity:${opacity};`;
			return {
				...edge,
				style: flowing
					? `${head}stroke-dasharray:6 5;animation:gitops-edge-flow 0.6s linear infinite;`
					: `${head}transition:stroke-opacity 0.2s ease;`,
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
