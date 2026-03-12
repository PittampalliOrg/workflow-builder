import { layoutWorkflowNodes } from "@/lib/workflow-layout/dagre-layout";
import type { WorkflowEdge, WorkflowNode } from "@/lib/workflow-store";
import type {
	DaprExecutionEvent,
	DaprWorkflowRuntimeStatus,
} from "@/lib/types/workflow-ui";
import type {
	WorkflowGraphEdge,
	WorkflowGraphNode,
	WorkflowGraphNodeStatus,
	WorkflowRuntimeGraph,
} from "@/lib/types/workflow-graph";

function normalizeNodeType(node: WorkflowNode): string {
	return String(node.data?.type || node.type || "action");
}

function shouldAutoLayout(nodes: WorkflowNode[]): boolean {
	const visibleNodes = nodes.filter((node) => node.type !== "add");
	if (visibleNodes.length === 0) return false;
	return visibleNodes.every((node) => {
		const x = node.position?.x ?? 0;
		const y = node.position?.y ?? 0;
		return x === 0 && y === 0;
	});
}

function normalizeNodes(
	nodes: WorkflowNode[],
	edges: WorkflowEdge[],
): { nodes: WorkflowNode[]; layout: WorkflowRuntimeGraph["layout"] } {
	const filteredNodes = nodes.filter((node) => node.type !== "add");
	if (shouldAutoLayout(filteredNodes)) {
		return {
			nodes: layoutWorkflowNodes(filteredNodes, edges, { direction: "TB" }),
			layout: "auto",
		};
	}
	return { nodes: filteredNodes, layout: "saved" };
}

function nodeMatchesEvent(
	node: WorkflowNode,
	event: DaprExecutionEvent,
): boolean {
	const nodeId = event.metadata?.nodeId;
	if (typeof nodeId === "string" && nodeId.length > 0) {
		return node.id === nodeId;
	}

	const names = [
		event.metadata?.nodeName,
		event.metadata?.activityName,
		event.name,
	].filter(
		(value): value is string => typeof value === "string" && value.length > 0,
	);

	if (names.length === 0) return false;

	const label = String(node.data?.label || "").trim();
	const id = node.id.trim();
	return names.some((value) => value === id || value === label);
}

function getEventNodeId(
	nodeLookup: Map<string, WorkflowNode>,
	labelLookup: Map<string, string>,
	event: DaprExecutionEvent,
): string | null {
	const metadataNodeId = event.metadata?.nodeId;
	if (
		typeof metadataNodeId === "string" &&
		metadataNodeId.length > 0 &&
		nodeLookup.has(metadataNodeId)
	) {
		return metadataNodeId;
	}

	for (const candidate of [
		event.metadata?.nodeName,
		event.metadata?.activityName,
		event.name,
	]) {
		if (typeof candidate !== "string" || candidate.length === 0) continue;
		const matchedId = labelLookup.get(candidate);
		if (matchedId) return matchedId;
	}

	return null;
}

function resolveEventStatus(
	current: WorkflowGraphNodeStatus,
	event: DaprExecutionEvent,
): WorkflowGraphNodeStatus {
	const eventType = String(event.eventType || "").toLowerCase();
	const metadataStatus = String(event.metadata?.status || "").toLowerCase();
	const error = event.metadata?.error;

	if (
		metadataStatus.includes("fail") ||
		eventType.includes("fail") ||
		eventType.includes("error") ||
		typeof error === "string"
	) {
		return "error";
	}

	if (
		eventType === "eventraised" &&
		typeof event.name === "string" &&
		event.name.toLowerCase().includes("approval")
	) {
		return current === "error" ? current : "waiting";
	}

	if (
		eventType.includes("completed") ||
		metadataStatus === "success" ||
		metadataStatus === "completed"
	) {
		return current === "error" ? current : "success";
	}

	if (
		eventType.includes("scheduled") ||
		eventType.includes("started") ||
		eventType.includes("invoked")
	) {
		return current === "error" || current === "success" ? current : "running";
	}

	return current;
}

function toEdgeStatus(input: {
	edge: WorkflowEdge;
	nodeStatuses: Map<string, WorkflowGraphNodeStatus>;
	currentNodeId?: string | null;
}): WorkflowGraphEdge["status"] {
	if (
		input.currentNodeId &&
		(input.edge.source === input.currentNodeId ||
			input.edge.target === input.currentNodeId)
	) {
		return "active";
	}

	const sourceStatus = input.nodeStatuses.get(input.edge.source) ?? "idle";
	const targetStatus = input.nodeStatuses.get(input.edge.target) ?? "idle";
	const traversedStatuses = new Set<WorkflowGraphNodeStatus>([
		"running",
		"success",
		"error",
		"waiting",
	]);

	if (
		traversedStatuses.has(sourceStatus) &&
		traversedStatuses.has(targetStatus)
	) {
		return "traversed";
	}

	return "idle";
}

export function buildWorkflowRuntimeGraph(input: {
	nodes: WorkflowNode[];
	edges: WorkflowEdge[];
	executionHistory?: DaprExecutionEvent[];
	daprStatus?: DaprWorkflowRuntimeStatus;
}): WorkflowRuntimeGraph {
	const normalized = normalizeNodes(input.nodes, input.edges);
	const nodeLookup = new Map(normalized.nodes.map((node) => [node.id, node]));
	const labelLookup = new Map(
		normalized.nodes.flatMap((node) => {
			const values = [node.id, String(node.data?.label || "").trim()].filter(
				(value) => value.length > 0,
			);
			return values.map((value) => [value, node.id] as const);
		}),
	);

	const nodeStatuses = new Map<string, WorkflowGraphNodeStatus>(
		normalized.nodes.map((node) => [node.id, "idle"]),
	);
	const nodeErrors = new Map<string, string | null>();

	const sortedEvents = [...(input.executionHistory ?? [])].sort((a, b) =>
		a.timestamp.localeCompare(b.timestamp),
	);
	for (const event of sortedEvents) {
		const matchedId =
			getEventNodeId(nodeLookup, labelLookup, event) ??
			normalized.nodes.find((node) => nodeMatchesEvent(node, event))?.id ??
			null;
		if (!matchedId) continue;
		const nextStatus = resolveEventStatus(
			nodeStatuses.get(matchedId) ?? "idle",
			event,
		);
		nodeStatuses.set(matchedId, nextStatus);
		if (
			typeof event.metadata?.error === "string" &&
			event.metadata.error.length > 0
		) {
			nodeErrors.set(matchedId, event.metadata.error);
		}
	}

	const currentNodeId =
		(typeof input.daprStatus?.currentNodeId === "string" &&
		input.daprStatus.currentNodeId.length > 0 &&
		nodeLookup.has(input.daprStatus.currentNodeId)
			? input.daprStatus.currentNodeId
			: typeof input.daprStatus?.currentNodeName === "string"
				? (labelLookup.get(input.daprStatus.currentNodeName) ?? null)
				: null) ?? null;

	if (currentNodeId) {
		nodeStatuses.set(currentNodeId, "running");
	}

	if (
		input.daprStatus?.runtimeStatus === "FAILED" &&
		currentNodeId &&
		(nodeStatuses.get(currentNodeId) ?? "idle") !== "success"
	) {
		nodeStatuses.set(currentNodeId, "error");
		if (typeof input.daprStatus.error === "string" && input.daprStatus.error) {
			nodeErrors.set(currentNodeId, input.daprStatus.error);
		}
	}

	const graphNodes: WorkflowGraphNode[] = normalized.nodes.map((node) => ({
		id: node.id,
		type: normalizeNodeType(node),
		position: {
			x: node.position?.x ?? 0,
			y: node.position?.y ?? 0,
		},
		data: {
			label: String(node.data?.label || node.id),
			description: node.data?.description,
			type: normalizeNodeType(node),
			config:
				node.data?.config && typeof node.data.config === "object"
					? node.data.config
					: {},
			enabled: node.data?.enabled !== false,
			status: nodeStatuses.get(node.id) ?? "idle",
			isCurrent: currentNodeId === node.id,
			error: nodeErrors.get(node.id) ?? null,
		},
	}));

	const graphEdges: WorkflowGraphEdge[] = input.edges
		.filter(
			(edge) =>
				nodeLookup.has(edge.source) &&
				nodeLookup.has(edge.target) &&
				edge.source !== "add" &&
				edge.target !== "add",
		)
		.map((edge) => ({
			id: edge.id,
			source: edge.source,
			target: edge.target,
			sourceHandle:
				typeof edge.sourceHandle === "string" ? edge.sourceHandle : null,
			targetHandle:
				typeof edge.targetHandle === "string" ? edge.targetHandle : null,
			label:
				edge.sourceHandle === "true"
					? "True"
					: edge.sourceHandle === "false"
						? "False"
						: undefined,
			status: toEdgeStatus({ edge, nodeStatuses, currentNodeId }),
		}));

	return {
		nodes: graphNodes,
		edges: graphEdges,
		source:
			sortedEvents.length > 0 || currentNodeId
				? "definition+runtime"
				: "definition",
		layout: normalized.layout,
	};
}
