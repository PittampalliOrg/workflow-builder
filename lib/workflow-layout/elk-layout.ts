import ELK from "elkjs/lib/elk.bundled.js";
import type { WorkflowEdge, WorkflowNode } from "@/lib/workflow-store";
import type { DagreLayoutOptions } from "./dagre-layout";

const DEFAULT_NODE_WIDTH = 192;
const DEFAULT_NODE_HEIGHT = 192;
const WHILE_NODE_WIDTH = 420;
const WHILE_NODE_HEIGHT = 300;

type NodeWithMeasurements = WorkflowNode & {
	width?: number;
	height?: number;
	measured?: {
		width?: number;
		height?: number;
	};
};

function getNodeSize(
	node: WorkflowNode,
	options: Pick<DagreLayoutOptions, "nodeWidth" | "nodeHeight">,
): { width: number; height: number } {
	const typedNode = node as NodeWithMeasurements;
	const isWhileNode = node.type === "while" || node.data?.type === "while";

	const width =
		typedNode.measured?.width ??
		typedNode.width ??
		options.nodeWidth ??
		DEFAULT_NODE_WIDTH;
	const height =
		typedNode.measured?.height ??
		typedNode.height ??
		options.nodeHeight ??
		DEFAULT_NODE_HEIGHT;

	return {
		width: Math.max(isWhileNode ? WHILE_NODE_WIDTH : width, 1),
		height: Math.max(isWhileNode ? WHILE_NODE_HEIGHT : height, 1),
	};
}

export async function layoutWorkflowNodesElk(
	nodes: WorkflowNode[],
	edges: WorkflowEdge[],
	options: Pick<
		DagreLayoutOptions,
		"direction" | "rankSep" | "nodeSep" | "nodeWidth" | "nodeHeight"
	> = {},
): Promise<WorkflowNode[]> {
	if (nodes.length === 0) {
		return nodes;
	}

	const nodesToLayout = nodes.filter((node) => node.type !== "add");
	if (nodesToLayout.length === 0) {
		return nodes;
	}

	const nodeIds = new Set(nodesToLayout.map((node) => node.id));
	const edgesToLayout = edges.filter(
		(edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target),
	);

	const elk = new ELK();
	const graph = {
		id: "root",
		layoutOptions: {
			"elk.algorithm": "layered",
			"elk.direction": options.direction === "TB" ? "DOWN" : "RIGHT",
			"elk.layered.spacing.edgeNodeBetweenLayers": String(
				options.rankSep ?? 120,
			),
			"elk.spacing.nodeNode": String(options.nodeSep ?? 80),
			"elk.layered.nodePlacement.strategy": "SIMPLE",
			"elk.separateConnectedComponents": "true",
			"elk.spacing.componentComponent": "140",
		},
		children: nodesToLayout
			.map((node) => {
				const size = getNodeSize(node, options);
				return {
					id: node.id,
					width: size.width,
					height: size.height,
				};
			})
			.sort((a, b) => a.id.localeCompare(b.id)),
		edges: edgesToLayout
			.map((edge) => ({
				id: edge.id,
				sources: [edge.source],
				targets: [edge.target],
			}))
			.sort((a, b) => a.id.localeCompare(b.id)),
	};

	try {
		const result = await elk.layout(graph);
		const positions = new Map<string, { x: number; y: number }>();
		for (const child of result.children ?? []) {
			if (typeof child.x !== "number" || typeof child.y !== "number") {
				continue;
			}
			positions.set(child.id, { x: child.x, y: child.y });
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
		console.error("Failed to run ELK layout:", error);
		return nodes;
	}
}
