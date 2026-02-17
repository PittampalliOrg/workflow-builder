import dagre from "@dagrejs/dagre";
import type { WorkflowEdge, WorkflowNode } from "@/lib/workflow-store";

export type DagreLayoutOptions = {
	direction?: "LR" | "TB";
	nodeWidth?: number;
	nodeHeight?: number;
	rankSep?: number;
	nodeSep?: number;
	rowGap?: number;
	columnGap?: number;
	viewportWidth?: number;
	maxColumns?: number;
	strategy?: "auto" | "dagre" | "compact";
};

type NodeWithMeasurements = WorkflowNode & {
	width?: number;
	height?: number;
	measured?: {
		width?: number;
		height?: number;
	};
};

const DEFAULT_NODE_WIDTH = 192;
const DEFAULT_NODE_HEIGHT = 192;
const DEFAULT_ROW_GAP = 120;
const DEFAULT_COLUMN_GAP = 100;

type GraphDegreeMaps = {
	inDegree: Map<string, number>;
	outDegree: Map<string, number>;
};

function getNodeSize(
	node: WorkflowNode,
	options: DagreLayoutOptions,
): { width: number; height: number } {
	const typedNode = node as NodeWithMeasurements;
	const measuredWidth = typedNode.measured?.width;
	const measuredHeight = typedNode.measured?.height;

	const width =
		measuredWidth ?? typedNode.width ?? options.nodeWidth ?? DEFAULT_NODE_WIDTH;
	const height =
		measuredHeight ??
		typedNode.height ??
		options.nodeHeight ??
		DEFAULT_NODE_HEIGHT;

	return {
		width: Math.max(width, 1),
		height: Math.max(height, 1),
	};
}

function buildDegreeMaps(
	nodes: WorkflowNode[],
	edges: WorkflowEdge[],
): GraphDegreeMaps {
	const ids = new Set(nodes.map((node) => node.id));
	const inDegree = new Map<string, number>();
	const outDegree = new Map<string, number>();

	for (const node of nodes) {
		inDegree.set(node.id, 0);
		outDegree.set(node.id, 0);
	}

	for (const edge of edges) {
		if (!ids.has(edge.source) || !ids.has(edge.target)) {
			continue;
		}
		if (edge.source === edge.target) {
			continue;
		}

		inDegree.set(edge.target, (inDegree.get(edge.target) ?? 0) + 1);
		outDegree.set(edge.source, (outDegree.get(edge.source) ?? 0) + 1);
	}

	return { inDegree, outDegree };
}

function getTopologicalOrder(
	nodes: WorkflowNode[],
	edges: WorkflowEdge[],
): WorkflowNode[] {
	const ids = new Set(nodes.map((node) => node.id));
	const byId = new Map(nodes.map((node) => [node.id, node] as const));
	const incoming = new Map<string, number>();
	const outgoing = new Map<string, string[]>();

	for (const node of nodes) {
		incoming.set(node.id, 0);
		outgoing.set(node.id, []);
	}

	for (const edge of edges) {
		if (!ids.has(edge.source) || !ids.has(edge.target)) {
			continue;
		}
		if (edge.source === edge.target) {
			continue;
		}

		outgoing.get(edge.source)?.push(edge.target);
		incoming.set(edge.target, (incoming.get(edge.target) ?? 0) + 1);
	}

	for (const [key, nextIds] of outgoing) {
		outgoing.set(
			key,
			nextIds.sort((a, b) => a.localeCompare(b)),
		);
	}

	const queue = Array.from(ids)
		.filter((id) => (incoming.get(id) ?? 0) === 0)
		.sort((a, b) => a.localeCompare(b));

	const orderedIds: string[] = [];
	while (queue.length > 0) {
		const id = queue.shift();
		if (!id) {
			continue;
		}

		orderedIds.push(id);
		const nextIds = outgoing.get(id) ?? [];
		for (const nextId of nextIds) {
			const nextIncoming = (incoming.get(nextId) ?? 0) - 1;
			incoming.set(nextId, nextIncoming);
			if (nextIncoming === 0) {
				queue.push(nextId);
				queue.sort((a, b) => a.localeCompare(b));
			}
		}
	}

	const missingIds = Array.from(ids).filter((id) => !orderedIds.includes(id));
	missingIds.sort((a, b) => a.localeCompare(b));
	orderedIds.push(...missingIds);

	return orderedIds
		.map((id) => byId.get(id))
		.filter((node): node is WorkflowNode => Boolean(node));
}

function shouldUseCompactLayout(
	nodes: WorkflowNode[],
	edges: WorkflowEdge[],
	options: DagreLayoutOptions,
): boolean {
	if (options.strategy === "compact") {
		return true;
	}
	if (options.strategy === "dagre") {
		return false;
	}
	if (nodes.length < 4) {
		return false;
	}

	const { inDegree, outDegree } = buildDegreeMaps(nodes, edges);
	const isChainLike = nodes.every((node) => {
		const nodeInDegree = inDegree.get(node.id) ?? 0;
		const nodeOutDegree = outDegree.get(node.id) ?? 0;
		return nodeInDegree <= 1 && nodeOutDegree <= 1;
	});

	return isChainLike;
}

function layoutCompactWorkflowNodes(
	nodes: WorkflowNode[],
	edges: WorkflowEdge[],
	options: DagreLayoutOptions = {},
): WorkflowNode[] {
	const orderedNodes = getTopologicalOrder(nodes, edges);
	if (orderedNodes.length === 0) {
		return nodes;
	}

	const columnGap = options.columnGap ?? DEFAULT_COLUMN_GAP;
	const rowGap = options.rowGap ?? DEFAULT_ROW_GAP;
	const averageWidth =
		orderedNodes.reduce(
			(sum, node) => sum + getNodeSize(node, options).width,
			0,
		) / orderedNodes.length;

	const computedColumns = options.viewportWidth
		? Math.floor(
				(options.viewportWidth + columnGap) / (averageWidth + columnGap),
			)
		: 3;
	const maxColumns = options.maxColumns ?? 3;
	const columnCount = Math.max(
		2,
		Math.min(computedColumns || 2, maxColumns, orderedNodes.length),
	);

	const rowHeights = new Map<number, number>();
	for (let index = 0; index < orderedNodes.length; index += 1) {
		const node = orderedNodes[index];
		if (!node) {
			continue;
		}

		const row = Math.floor(index / columnCount);
		const { height } = getNodeSize(node, options);
		rowHeights.set(row, Math.max(rowHeights.get(row) ?? 0, height));
	}

	const rowOffsets = new Map<number, number>();
	let cumulativeY = 0;
	const totalRows = Math.ceil(orderedNodes.length / columnCount);
	for (let row = 0; row < totalRows; row += 1) {
		rowOffsets.set(row, cumulativeY);
		cumulativeY += (rowHeights.get(row) ?? DEFAULT_NODE_HEIGHT) + rowGap;
	}

	const positions = new Map<string, { x: number; y: number }>();
	for (let index = 0; index < orderedNodes.length; index += 1) {
		const node = orderedNodes[index];
		if (!node) {
			continue;
		}

		const row = Math.floor(index / columnCount);
		const indexInRow = index % columnCount;
		const visualColumn =
			row % 2 === 0 ? indexInRow : columnCount - 1 - indexInRow;
		const { width } = getNodeSize(node, options);
		const x = visualColumn * (width + columnGap);
		const y = rowOffsets.get(row) ?? 0;

		positions.set(node.id, { x, y });
	}

	return nodes.map((node) => {
		const position = positions.get(node.id);
		if (!position) {
			return node;
		}
		return {
			...node,
			position,
		};
	});
}

function layoutDagreWorkflowNodes(
	nodes: WorkflowNode[],
	edges: WorkflowEdge[],
	options: DagreLayoutOptions = {},
): WorkflowNode[] {
	try {
		const graph = new dagre.graphlib.Graph();
		graph.setDefaultEdgeLabel(() => ({}));
		graph.setGraph({
			rankdir: options.direction ?? "LR",
			ranksep: options.rankSep ?? 120,
			nodesep: options.nodeSep ?? 80,
			marginx: 20,
			marginy: 20,
		});

		for (const node of nodes) {
			const { width, height } = getNodeSize(node, options);
			graph.setNode(node.id, { width, height });
		}

		const sortedEdges = [...edges].sort((a, b) => {
			const left = `${a.source}\n${a.sourceHandle ?? ""}\n${a.target}`;
			const right = `${b.source}\n${b.sourceHandle ?? ""}\n${b.target}`;
			return left.localeCompare(right);
		});

		for (const edge of sortedEdges) {
			if (edge.source === edge.target) {
				continue;
			}
			if (!graph.hasNode(edge.source) || !graph.hasNode(edge.target)) {
				continue;
			}

			graph.setEdge(edge.source, edge.target);
		}

		dagre.layout(graph);

		const positions = new Map<string, { x: number; y: number }>();
		for (const node of nodes) {
			const layoutNode = graph.node(node.id) as
				| { x: number; y: number }
				| undefined;
			if (!layoutNode) {
				continue;
			}

			const { width, height } = getNodeSize(node, options);
			positions.set(node.id, {
				x: layoutNode.x - width / 2,
				y: layoutNode.y - height / 2,
			});
		}

		return nodes.map((node) => {
			const position = positions.get(node.id);
			if (!position) {
				return node;
			}

			return {
				...node,
				position,
			};
		});
	} catch (error) {
		console.error("Failed to auto-arrange workflow nodes:", error);
		return nodes;
	}
}

export function layoutWorkflowNodes(
	nodes: WorkflowNode[],
	edges: WorkflowEdge[],
	options: DagreLayoutOptions = {},
): WorkflowNode[] {
	if (nodes.length === 0) {
		return nodes;
	}

	const nodesToLayout = [...nodes]
		.filter((node) => node.type !== "add")
		.sort((a, b) => a.id.localeCompare(b.id));

	if (nodesToLayout.length === 0) {
		return nodes;
	}

	const nodeIds = new Set(nodesToLayout.map((node) => node.id));
	const edgesToLayout = edges.filter(
		(edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target),
	);

	const arrangedLayoutNodes = shouldUseCompactLayout(
		nodesToLayout,
		edgesToLayout,
		options,
	)
		? layoutCompactWorkflowNodes(nodesToLayout, edgesToLayout, options)
		: layoutDagreWorkflowNodes(nodesToLayout, edgesToLayout, options);

	const positionsById = new Map(
		arrangedLayoutNodes.map((node) => [node.id, node.position] as const),
	);

	return nodes.map((node) => {
		const position = positionsById.get(node.id);
		if (!position) {
			return node;
		}
		return {
			...node,
			position,
		};
	});
}
