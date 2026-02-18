import type { WorkflowEdge, WorkflowNode } from "@/lib/workflow-store";

export const WHILE_NODE_WIDTH = 420;
export const WHILE_NODE_HEIGHT = 300;
export const WORKFLOW_NODE_SIZE = 192;
export const WHILE_NODE_PADDING = 16;
export const WHILE_NODE_HEADER_HEIGHT = 44;

const SUPPORTED_WHILE_BODY_ACTION_TYPES = new Set<string>(["durable/run"]);

export function isWhileNode(node: Pick<WorkflowNode, "type">): boolean {
	return node.type === "while";
}

export function isWhileBodyCandidate(
	node: Pick<WorkflowNode, "type" | "data">,
): boolean {
	if (node.type !== "action") return false;
	const actionType = node.data?.config?.actionType;
	return (
		typeof actionType === "string" &&
		SUPPORTED_WHILE_BODY_ACTION_TYPES.has(actionType)
	);
}

export function getAbsolutePosition(
	node: Pick<WorkflowNode, "id" | "position" | "parentId">,
	lookup: Map<string, Pick<WorkflowNode, "id" | "position" | "parentId">>,
): { x: number; y: number } {
	let x = node.position.x;
	let y = node.position.y;
	let current = node;

	while (current.parentId) {
		const parent = lookup.get(current.parentId);
		if (!parent) break;
		x += parent.position.x;
		y += parent.position.y;
		current = parent;
	}

	return { x, y };
}

export function isPointInsideWhileNode(
	point: { x: number; y: number },
	whileNodeAbs: { x: number; y: number },
): boolean {
	return (
		point.x >= whileNodeAbs.x &&
		point.x <= whileNodeAbs.x + WHILE_NODE_WIDTH &&
		point.y >= whileNodeAbs.y &&
		point.y <= whileNodeAbs.y + WHILE_NODE_HEIGHT
	);
}

export function clampWhileChildPosition(relative: { x: number; y: number }): {
	x: number;
	y: number;
} {
	const minX = WHILE_NODE_PADDING;
	const maxX = WHILE_NODE_WIDTH - WORKFLOW_NODE_SIZE - WHILE_NODE_PADDING;
	const minY = WHILE_NODE_HEADER_HEIGHT;
	const maxY = WHILE_NODE_HEIGHT - WORKFLOW_NODE_SIZE - WHILE_NODE_PADDING;

	return {
		x: Math.min(maxX, Math.max(minX, relative.x)),
		y: Math.min(maxY, Math.max(minY, relative.y)),
	};
}

function nextUniqueId(base: string, usedIds: Set<string>): string {
	if (!usedIds.has(base)) return base;
	let i = 1;
	while (usedIds.has(`${base}-${i}`)) i += 1;
	return `${base}-${i}`;
}

function nextUniqueEdgeId(base: string, usedIds: Set<string>): string {
	return nextUniqueId(base, usedIds);
}

function normalizePositiveInt(value: unknown, fallback: number): number {
	const asNumber =
		typeof value === "number" ? value : Number(String(value || "").trim());
	if (!Number.isFinite(asNumber) || asNumber < 1) return fallback;
	return Math.floor(asNumber);
}

function normalizeNonNegativeInt(value: unknown, fallback: number): number {
	const asNumber =
		typeof value === "number" ? value : Number(String(value || "").trim());
	if (!Number.isFinite(asNumber) || asNumber < 0) return fallback;
	return Math.floor(asNumber);
}

export function lowerWhileNodesForExecution(input: {
	nodes: WorkflowNode[];
	edges: WorkflowEdge[];
}): { nodes: WorkflowNode[]; edges: WorkflowEdge[] } {
	const whileNodes = input.nodes.filter(isWhileNode);
	if (whileNodes.length === 0) {
		return { nodes: input.nodes, edges: input.edges };
	}

	let nodes = [...input.nodes];
	let edges = [...input.edges];

	for (const whileNode of whileNodes) {
		const whileId = whileNode.id;
		const nodeLookup = new Map(nodes.map((node) => [node.id, node] as const));
		const whileAbs = getAbsolutePosition(whileNode, nodeLookup);
		const config = (whileNode.data.config || {}) as Record<string, unknown>;
		const whileExpression = String(config.expression || "").trim();
		const maxIterations = normalizePositiveInt(config.maxIterations, 20);
		const delaySeconds = normalizeNonNegativeInt(config.delaySeconds, 0);
		const onMaxIterations =
			String(config.onMaxIterations || "continue").toLowerCase() === "fail"
				? "fail"
				: "continue";

		const children = nodes
			.filter((node) => node.parentId === whileId)
			.sort((a, b) => a.id.localeCompare(b.id));
		const childIds = new Set(children.map((node) => node.id));
		const bodyNode = children.find((node) => isWhileBodyCandidate(node));

		// If no valid child is enclosed, keep the node executable as a misconfigured
		// loop-until so runtime can return a clear configuration error.
		if (!bodyNode) {
			nodes = nodes.filter(
				(node) => !childIds.has(node.id) || node.id === whileId,
			);
			edges = edges.filter(
				(edge) => !childIds.has(edge.source) && !childIds.has(edge.target),
			);

			nodes = nodes.map((node) => {
				if (node.id !== whileId) return node;
				return {
					...node,
					type: "loop-until",
					data: {
						...node.data,
						type: "loop-until",
						config: {
							loopStartNodeId: "",
							maxIterations,
							delaySeconds,
							onMaxIterations,
							operator: "BOOLEAN_IS_TRUE",
							left: true,
							conditionMode: "celExpression",
							celExpression: whileExpression ? `!(${whileExpression})` : "true",
							whileExpression,
						},
					},
				};
			});
			continue;
		}

		const bodyAbs = getAbsolutePosition(bodyNode, nodeLookup);
		const loopNodeId = whileId;

		const incoming = edges.filter((edge) => edge.target === whileId);
		const outgoing = edges.filter((edge) => edge.source === whileId);

		nodes = nodes
			.filter(
				(node) =>
					node.id !== whileId &&
					(!childIds.has(node.id) || node.id === bodyNode.id),
			)
			.map((node) => {
				if (node.id !== bodyNode.id) return node;
				return {
					...node,
					parentId: undefined,
					extent: undefined,
					position: bodyAbs,
				};
			});

		nodes.push({
			id: loopNodeId,
			type: "loop-until",
			position: {
				x: Math.max(whileAbs.x + WHILE_NODE_WIDTH - 170, bodyAbs.x + 240),
				y: bodyAbs.y,
			},
			data: {
				label: whileNode.data.label || "While",
				description:
					whileNode.data.description || "Loop while condition is true",
				type: "loop-until",
				config: {
					loopStartNodeId: bodyNode.id,
					maxIterations,
					delaySeconds,
					onMaxIterations,
					operator: "BOOLEAN_IS_TRUE",
					left: true,
					conditionMode: "celExpression",
					celExpression: whileExpression ? `!(${whileExpression})` : "true",
					whileExpression,
				},
				status: whileNode.data.status || "idle",
				enabled: whileNode.data.enabled !== false,
			},
		});

		edges = edges.filter(
			(edge) =>
				edge.source !== whileId &&
				edge.target !== whileId &&
				!childIds.has(edge.source) &&
				!childIds.has(edge.target),
		);

		const edgeIds = new Set(edges.map((edge) => edge.id));
		const pushEdge = (edge: Omit<WorkflowEdge, "id">) => {
			const base = `${edge.source}->${edge.target}${edge.sourceHandle ? `:${edge.sourceHandle}` : ""}`;
			const id = nextUniqueEdgeId(base, edgeIds);
			edgeIds.add(id);
			edges.push({ id, ...edge });
		};

		for (const edge of incoming) {
			pushEdge({
				source: edge.source,
				target: bodyNode.id,
				sourceHandle: edge.sourceHandle,
				targetHandle: edge.targetHandle,
				type: edge.type || "animated",
			});
		}

		pushEdge({
			source: bodyNode.id,
			target: loopNodeId,
			type: "animated",
		});

		for (const edge of outgoing) {
			pushEdge({
				source: loopNodeId,
				target: edge.target,
				sourceHandle: edge.sourceHandle,
				targetHandle: edge.targetHandle,
				type: edge.type || "animated",
			});
		}
	}

	return { nodes, edges };
}
