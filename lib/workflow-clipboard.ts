import { nanoid } from "nanoid";
import type { XYPosition } from "@xyflow/react";
import type { WorkflowEdge, WorkflowNode } from "@/lib/workflow-store";

export const WORKFLOW_CLIPBOARD_FORMAT = "workflow-builder/clipboard";
export const WORKFLOW_CLIPBOARD_VERSION = 1;

export type WorkflowClipboardPayloadV1 = {
	format: typeof WORKFLOW_CLIPBOARD_FORMAT;
	version: typeof WORKFLOW_CLIPBOARD_VERSION;
	copiedAt: string;
	nodes: WorkflowNode[];
	edges: WorkflowEdge[];
};

function getAbsoluteNodePosition(
	node: Pick<WorkflowNode, "id" | "position" | "parentId">,
	lookup: Map<string, Pick<WorkflowNode, "id" | "position" | "parentId">>,
): XYPosition {
	let x = node.position.x;
	let y = node.position.y;
	let current: Pick<WorkflowNode, "id" | "position" | "parentId"> | undefined =
		node;

	while (current?.parentId) {
		const parent = lookup.get(current.parentId);
		if (!parent) {
			break;
		}
		x += parent.position.x;
		y += parent.position.y;
		current = parent;
	}

	return { x, y };
}

export function collectSelectionForClipboard(
	nodes: WorkflowNode[],
	edges: WorkflowEdge[],
): WorkflowClipboardPayloadV1 | null {
	const selectedNodes = nodes.filter(
		(node) => node.selected && node.type !== "trigger",
	);
	if (selectedNodes.length === 0) {
		return null;
	}

	const selectedNodeIds = new Set(selectedNodes.map((node) => node.id));
	const nodeLookup = new Map(nodes.map((node) => [node.id, node] as const));

	const normalizedNodes = selectedNodes.map((node) => ({
		...node,
		parentId: undefined,
		extent: undefined,
		selected: false,
		position: getAbsoluteNodePosition(node, nodeLookup),
	}));
	const selectedEdges = edges
		.filter(
			(edge) =>
				selectedNodeIds.has(edge.source) && selectedNodeIds.has(edge.target),
		)
		.map((edge) => ({ ...edge, selected: false }));

	return {
		format: WORKFLOW_CLIPBOARD_FORMAT,
		version: WORKFLOW_CLIPBOARD_VERSION,
		copiedAt: new Date().toISOString(),
		nodes: normalizedNodes,
		edges: selectedEdges,
	};
}

export function serializeWorkflowClipboardPayload(
	payload: WorkflowClipboardPayloadV1,
): string {
	return JSON.stringify(payload);
}

export function parseWorkflowClipboardPayload(
	text: string,
): WorkflowClipboardPayloadV1 | null {
	try {
		const parsed = JSON.parse(text) as Partial<WorkflowClipboardPayloadV1>;
		if (
			parsed?.format !== WORKFLOW_CLIPBOARD_FORMAT ||
			parsed?.version !== WORKFLOW_CLIPBOARD_VERSION ||
			!Array.isArray(parsed.nodes) ||
			!Array.isArray(parsed.edges)
		) {
			return null;
		}
		return parsed as WorkflowClipboardPayloadV1;
	} catch {
		return null;
	}
}

export function remapClipboardPayloadForPaste(
	payload: WorkflowClipboardPayloadV1,
	pastePosition: XYPosition,
): {
	nodes: WorkflowNode[];
	edges: WorkflowEdge[];
} {
	if (payload.nodes.length === 0) {
		return { nodes: [], edges: [] };
	}

	const minX = Math.min(...payload.nodes.map((node) => node.position.x));
	const minY = Math.min(...payload.nodes.map((node) => node.position.y));
	const idMap = new Map<string, string>();

	const nextNodes = payload.nodes.map((node) => {
		const nextId = nanoid();
		idMap.set(node.id, nextId);
		return {
			...node,
			id: nextId,
			parentId: undefined,
			extent: undefined,
			selected: true,
			position: {
				x: pastePosition.x + (node.position.x - minX),
				y: pastePosition.y + (node.position.y - minY),
			},
		};
	});

	const nextEdges = payload.edges.flatMap((edge) => {
		const source = idMap.get(edge.source);
		const target = idMap.get(edge.target);
		if (!(source && target)) {
			return [];
		}
		return [
			{
				...edge,
				id: nanoid(),
				source,
				target,
				selected: false,
			},
		];
	});

	return { nodes: nextNodes, edges: nextEdges };
}
