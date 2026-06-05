/**
 * dagre layout port — framework-neutral re-implementation of Kargo's
 * ui/src/features/project/pipelines/graph/{layout-graph,use-pipeline-graph}.ts,
 * adapted to our PipelineModel and emitting @xyflow/svelte Node[]/Edge[].
 *
 * Faithful details preserved from Kargo:
 *  - multigraph, rankdir LR, ranksep 150, nodesep 60
 *  - inflated layout height (200/100) with re-center to the real card height
 *  - `warehouseY` map so each stage sorts its per-warehouse handles by the
 *    vertical order of their source warehouses (prevents edge crossings)
 *  - warehouse-keyed edges (sourceHandle/targetHandle = warehouse name)
 */
import dagre from "@dagrejs/dagre";
import { MarkerType, Position, type Edge, type Node } from "@xyflow/svelte";

import type {
	PipelineModel,
	PipelineStage,
	PipelineSubscription,
	PipelineWarehouse,
} from "./pipeline-types";

export const PIPELINE_NODE_TYPE = "pipelineNode";

/** Svelte context key for warehouse hover-highlight (set by PipelineGraph). */
export const PIPELINE_HOVER_CONTEXT = "gitops-pipeline-hover";
export type PipelineHoverContext = { setHovered: (name: string | null) => void };

/** Svelte context key for operator deep-links (set by the page). */
export const PIPELINE_LINKS_CONTEXT = "gitops-pipeline-links";
export type PipelineLinks = {
	argoCdBase?: string;
	stacksRepo?: string;
	workflowBuilderRepo?: string;
	ghcrOrg?: string;
	tektonBase?: string | null;
};

const SIZE = {
	warehouse: { width: 270, height: 100 },
	subscription: { width: 250, height: 100 },
	stage: { width: 270, height: 170 },
	lane: { width: 270, height: 132 },
} as const;
const MAX_STAGE_HEIGHT = 200;
const MAX_SUBSCRIPTION_HEIGHT = 100;

export type PipelineNodeKind = "warehouse" | "subscription" | "stage" | "lane";

export type PipelineNodeData = {
	kind: PipelineNodeKind;
	warehouse?: PipelineWarehouse;
	subscription?: PipelineSubscription;
	subscriptionParentName?: string;
	stage?: PipelineStage;
	/** Collapsed env stages for a "lane" node (group-lanes mode). */
	stages?: PipelineStage[];
	/** Post-layout y of every warehouse, for per-warehouse handle sorting. */
	warehouseY?: Record<string, number>;
	color?: string;
	[key: string]: unknown;
};

export type ComputeOptions = {
	/** Warehouse names to isolate (Kargo's warehouse filter). Empty = all. */
	pipelineFilter?: string[];
	/** Hide all subscription nodes, or per-warehouse. */
	hideSubscriptions?: boolean | Record<string, boolean>;
	/** Use orthogonal step edges instead of bezier. */
	stepEdges?: boolean;
	/** Collapse each warehouse's env stages into one "lane" node. */
	groupLanes?: boolean;
};

const warehouseNodeId = (name: string) => `warehouse/${name}`;
const stageNodeId = (name: string) => `stage/${name}`;
const laneNodeId = (name: string) => `lane/${name}`;
const subscriptionNodeId = (warehouseName: string, sub: PipelineSubscription) =>
	`subscription/${warehouseName}/${sub.id}`;

type DagreNodeMeta = {
	kind: PipelineNodeKind;
	warehouseName?: string;
	stageName?: string;
	subscriptionParentName?: string;
	subscriptionId?: string;
	width: number;
	height: number;
};

export function computePipelineGraph(
	model: PipelineModel,
	opts: ComputeOptions = {},
): { nodes: Node[]; edges: Edge[] } {
	const { pipelineFilter = [], hideSubscriptions, stepEdges, groupLanes } = opts;
	const filterSet = new Set(pipelineFilter);
	const ignoreWarehouse = (w?: PipelineWarehouse | null) =>
		!w || (filterSet.size > 0 && !filterSet.has(w.name));

	const warehouseByName = new Map(model.warehouses.map((w) => [w.name, w]));
	const stageByName = new Map(model.stages.map((s) => [s.name, s]));

	const graph = new dagre.graphlib.Graph({ multigraph: true });
	graph.setGraph({ rankdir: "LR", ranksep: 150, nodesep: 60 });
	graph.setDefaultEdgeLabel(() => ({}));

	const subHidden = (name: string) =>
		hideSubscriptions === true ||
		(typeof hideSubscriptions === "object" && Boolean(hideSubscriptions?.[name]));

	// Warehouses + their subscriptions (subscription → warehouse).
	for (const w of model.warehouses) {
		if (ignoreWarehouse(w)) continue;
		graph.setNode(warehouseNodeId(w.name), {
			kind: "warehouse",
			warehouseName: w.name,
			...SIZE.warehouse,
			height: MAX_STAGE_HEIGHT,
		});
		if (subHidden(w.name)) continue;
		for (const sub of w.subscriptions) {
			const sid = subscriptionNodeId(w.name, sub);
			graph.setNode(sid, {
				kind: "subscription",
				subscriptionParentName: w.name,
				subscriptionId: sub.id,
				...SIZE.subscription,
				height: MAX_SUBSCRIPTION_HEIGHT,
			});
			graph.setEdge(sid, warehouseNodeId(w.name));
		}
	}

	if (groupLanes) {
		// Collapse each warehouse's env stages into a single "lane" node
		// (warehouse → lane), so dense multi-service views stay readable.
		const laned = new Set<string>();
		for (const s of model.stages) {
			const owner = warehouseByName.get(s.warehouse);
			if (ignoreWarehouse(owner)) continue;
			laned.add(s.warehouse);
		}
		for (const name of laned) {
			const laneIdx = laneNodeId(name);
			graph.setNode(laneIdx, {
				kind: "lane",
				warehouseName: name,
				...SIZE.lane,
				height: MAX_STAGE_HEIGHT,
			});
			graph.setEdge(
				warehouseNodeId(name),
				laneIdx,
				{ edgeColor: model.warehouseColorMap[name] },
				name,
			);
		}
	} else {
		// Stages + edges (warehouse → stage for `direct`; upstream stage → stage).
		for (const s of model.stages) {
			const owner = warehouseByName.get(s.warehouse);
			if (ignoreWarehouse(owner)) continue;
			const sIdx = stageNodeId(s.name);
			graph.setNode(sIdx, {
				kind: "stage",
				stageName: s.name,
				...SIZE.stage,
				height: MAX_STAGE_HEIGHT,
			});

			for (const req of s.requestedFreight) {
				const origin = warehouseByName.get(req.origin);
				if (ignoreWarehouse(origin)) continue;
				const edgeColor = model.warehouseColorMap[req.origin];
				if (req.sources.direct) {
					graph.setEdge(warehouseNodeId(req.origin), sIdx, { edgeColor }, req.origin);
				}
				for (const up of req.sources.stages ?? []) {
					if (!stageByName.has(up)) continue;
					graph.setEdge(stageNodeId(up), sIdx, { edgeColor }, req.origin);
				}
			}
		}
	}

	dagre.layout(graph, { disableOptimalOrderHeuristic: true });

	// Record each warehouse's post-layout y so stages can sort their handles.
	const warehouseY: Record<string, number> = {};
	for (const id of graph.nodes()) {
		const n = graph.node(id) as DagreNodeMeta & { y?: number };
		if (n?.kind === "warehouse" && n.warehouseName != null && typeof n.y === "number") {
			warehouseY[n.warehouseName] = n.y;
		}
	}

	const nodes: Node[] = [];
	for (const id of graph.nodes()) {
		const n = graph.node(id) as DagreNodeMeta & { x?: number; y?: number; width?: number };
		const x = (n.x ?? 0) - (n.width ?? 0) / 2;

		let data: PipelineNodeData;
		let actualHeight: number;
		if (n.kind === "warehouse") {
			actualHeight = SIZE.warehouse.height;
			const warehouse = warehouseByName.get(n.warehouseName ?? "");
			data = { kind: "warehouse", warehouse, color: warehouse?.color, warehouseY };
		} else if (n.kind === "subscription") {
			actualHeight = SIZE.subscription.height;
			const parent = warehouseByName.get(n.subscriptionParentName ?? "");
			const subscription = parent?.subscriptions.find((s) => s.id === n.subscriptionId);
			data = {
				kind: "subscription",
				subscription,
				subscriptionParentName: n.subscriptionParentName,
				color: parent?.color,
			};
		} else if (n.kind === "lane") {
			actualHeight = SIZE.lane.height;
			const warehouse = warehouseByName.get(n.warehouseName ?? "");
			const laneStages = model.stages.filter((s) => s.warehouse === n.warehouseName);
			data = { kind: "lane", warehouse, stages: laneStages, color: warehouse?.color };
		} else {
			actualHeight = SIZE.stage.height;
			const stage = stageByName.get(n.stageName ?? "");
			data = { kind: "stage", stage, warehouseY, color: model.stageColorMap[n.stageName ?? ""] };
		}

		nodes.push({
			id,
			type: PIPELINE_NODE_TYPE,
			position: { x, y: (n.y ?? 0) - actualHeight / 2 },
			data: data as Record<string, unknown>,
			sourcePosition: Position.Right,
			targetPosition: Position.Left,
			draggable: false,
			selectable: true,
		});
	}

	const edges: Edge[] = [];
	for (const e of graph.edges()) {
		const belongsToWarehouse = e.name || undefined; // warehouse name, or undefined for sub→wh
		const dagreEdge = graph.edge(e) as { edgeColor?: string } | undefined;
		const color = dagreEdge?.edgeColor || "#9ca3af";
		edges.push({
			id: `${belongsToWarehouse ?? "sub"}/${e.v}/${e.w}`,
			source: e.v,
			target: e.w,
			sourceHandle: belongsToWarehouse,
			targetHandle: belongsToWarehouse,
			type: stepEdges ? "step" : "default",
			animated: false,
			data: { warehouseName: belongsToWarehouse },
			markerEnd: { type: MarkerType.ArrowClosed, color: "#777", width: 10, height: 10 },
			style: `stroke: ${color}; stroke-width: 4; stroke-opacity: 0.3; transition: stroke-opacity 0.2s ease, filter 0.2s ease;`,
		});
	}

	return { nodes, edges };
}
