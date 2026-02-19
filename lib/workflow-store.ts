import type {
	Edge,
	EdgeChange,
	Node,
	NodeChange,
	XYPosition,
} from "@xyflow/react";
import { applyEdgeChanges, applyNodeChanges } from "@xyflow/react";
import { atom } from "jotai";
import { nanoid } from "nanoid";
import { api } from "./api-client";

export type WorkflowNodeType =
	| "trigger"
	| "action"
	| "add"
	| "group" // UI container: generic visual grouping
	// Dapr workflow node types
	| "activity" // ctx.call_activity()
	| "approval-gate" // ctx.wait_for_external_event() + timer
	| "timer" // ctx.create_timer()
	| "loop-until" // Dapr workflow: repeat a section until a condition is met
	| "while" // UI container: loop enclosed durable agent while CEL condition is true
	| "if-else" // Control flow: choose true/false branch based on a condition
	| "note" // Non-executing annotation
	| "set-state" // Data: set a workflow-scoped variable
	| "transform" // Data: build structured output from a JSON template
	| "publish-event" // publish to pub/sub
	| "sub-workflow"; // execute another workflow as a child step

export type WorkflowNodeData = {
	label: string;
	description?: string;
	type: WorkflowNodeType;
	config?: Record<string, unknown>;
	status?: "idle" | "running" | "success" | "error";
	enabled?: boolean; // Whether the step is enabled (defaults to true)
	onClick?: () => void; // For the "add" node type
};

export type WorkflowNode = Node<WorkflowNodeData>;
export type WorkflowEdge = Edge;

export type ConnectionEndpoint = {
	node: string;
	handle?: string | null;
};

export type ConnectionSite = {
	id: string;
	position: XYPosition;
	type?: "source" | "target";
	source?: ConnectionEndpoint;
	target?: ConnectionEndpoint;
};

export type WhileDropTargetState = "eligible" | "unsupported" | "occupied";

export type ActiveWhileDropTarget = {
	whileId: string;
	draggedNodeId: string;
	state: WhileDropTargetState;
} | null;

// Workflow visibility type
export type WorkflowVisibility = "private" | "public";

export type WorkflowAiMessage = {
	id: string;
	role: "user" | "assistant" | "system";
	content: string;
	operations: Array<Record<string, unknown>> | null;
	createdAt: string;
	updatedAt: string;
};

// Atoms for workflow state (now backed by database)
export const nodesAtom = atom<WorkflowNode[]>([]);
export const edgesAtom = atom<WorkflowEdge[]>([]);
export const selectedNodeAtom = atom<string | null>(null);
export const selectedEdgeAtom = atom<string | null>(null);
export const isExecutingAtom = atom(false);
export const isLoadingAtom = atom(false);
export const isGeneratingAtom = atom(false);
export const currentWorkflowIdAtom = atom<string | null>(null);
export const currentWorkflowNameAtom = atom<string>("");
export const currentWorkflowVisibilityAtom =
	atom<WorkflowVisibility>("private");
export const isWorkflowOwnerAtom = atom<boolean>(true); // Whether current user owns this workflow

// UI state atoms
export const propertiesPanelActiveTabAtom = atom<string>("properties");
export const showMinimapAtom = atom(false);
export const selectedExecutionIdAtom = atom<string | null>(null);
export const rightPanelWidthAtom = atom<string | null>(null);
export const isPanelAnimatingAtom = atom<boolean>(false);
export const hasSidebarBeenShownAtom = atom<boolean>(false);
export const isSidebarCollapsedAtom = atom<boolean>(false);
export const isTransitioningFromHomepageAtom = atom<boolean>(false);
export const workflowAiMessagesWorkflowIdAtom = atom<string | null>(null);
export const workflowAiMessagesAtom = atom<WorkflowAiMessage[]>([]);
export const workflowAiMessagesLoadingAtom = atom<boolean>(false);
export const connectionSitesAtom = atom<Record<string, ConnectionSite>>({});
export const potentialConnectionAtom = atom<ConnectionSite | null>(null);
export const activeWhileDropTargetAtom = atom<ActiveWhileDropTarget>(null);

// Tracks nodes that are pending integration auto-select check
// Don't show "missing integration" warning for these nodes
export const pendingIntegrationNodesAtom = atom<Set<string>>(new Set<string>());

// Tracks the ID of a newly created node (for auto-focusing search input)
// Cleared when the node gets an action type or is deselected
export const newlyCreatedNodeIdAtom = atom<string | null>(null);

// Trigger execute atom - set to true to trigger workflow execution
// This allows keyboard shortcuts to trigger the same execute flow as the button
export const triggerExecuteAtom = atom(false);

// Execution log entry type for storing run outputs per node
export type ExecutionLogEntry = {
	nodeId: string;
	nodeName: string;
	nodeType: string;
	actionType?: string | null; // Function slug like "openai/generate-text"
	status: "pending" | "running" | "success" | "error";
	output?: unknown;
};

export type NodeSimulationResult = {
	nodeId: string;
	status: "success" | "error";
	summary: string;
	output?: unknown;
	finishedAt: string;
};

// Map of nodeId -> execution log entry for the currently selected execution
export const executionLogsAtom = atom<Record<string, ExecutionLogEntry>>({});
export const simulationModeAtom = atom<boolean>(false);
export const workflowSimulationRunningAtom = atom<boolean>(false);
export const simulatingNodeIdsAtom = atom<Set<string>>(new Set<string>());
export const nodeSimulationResultsAtom = atom<
	Record<string, NodeSimulationResult>
>({});

const NODE_HALF_SIZE = 96;
const GROUP_PADDING = 24;
const DEFAULT_GROUP_WIDTH = 320;
const DEFAULT_GROUP_HEIGHT = 220;

function createWorkflowNodeData(nodeType: WorkflowNodeType): WorkflowNodeData {
	switch (nodeType) {
		case "trigger":
			return {
				label: "",
				description: "",
				type: "trigger",
				config: { triggerType: "Manual" },
				status: "idle",
			};
		case "action":
		case "activity":
		case "approval-gate":
		case "timer":
		case "loop-until":
		case "group":
		case "while":
		case "if-else":
		case "note":
		case "set-state":
		case "transform":
		case "publish-event":
		case "sub-workflow":
		default:
			return {
				label: "",
				description: "",
				type: nodeType,
				config: {},
				status: "idle",
			};
	}
}

function getAbsoluteNodePosition(
	node: Pick<WorkflowNode, "position" | "parentId" | "id">,
	lookup: Map<string, Pick<WorkflowNode, "position" | "parentId" | "id">>,
): { x: number; y: number } {
	let x = node.position.x;
	let y = node.position.y;
	let current: Pick<WorkflowNode, "position" | "parentId" | "id"> | undefined =
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

function isGroupableNode(node: WorkflowNode): boolean {
	if (node.parentId) {
		return false;
	}
	return !["trigger", "add", "group", "while"].includes(node.type ?? "");
}

// Autosave functionality
let autosaveTimeoutId: NodeJS.Timeout | null = null;
const AUTOSAVE_DELAY = 1000; // 1 second debounce for field typing

// Autosave atom that handles saving workflow state
export const autosaveAtom = atom(
	null,
	async (get, set, options?: { immediate?: boolean }) => {
		const workflowId = get(currentWorkflowIdAtom);
		const nodes = get(nodesAtom);
		const edges = get(edgesAtom);

		// Only autosave if we have a workflow ID
		if (!workflowId) {
			return;
		}

		const saveFunc = async () => {
			try {
				await api.workflow.update(workflowId, { nodes, edges });
				// Clear the unsaved changes indicator after successful save
				set(hasUnsavedChangesAtom, false);
			} catch (error) {
				console.error("Autosave failed:", error);
			}
		};

		if (options?.immediate) {
			// Save immediately (for add/delete/connect operations)
			await saveFunc();
		} else {
			// Debounce for typing operations
			if (autosaveTimeoutId) {
				clearTimeout(autosaveTimeoutId);
			}
			autosaveTimeoutId = setTimeout(saveFunc, AUTOSAVE_DELAY);
		}
	},
);

// Derived atoms for node/edge operations
export const onNodesChangeAtom = atom(
	null,
	(get, set, changes: NodeChange[]) => {
		const currentNodes = get(nodesAtom);

		// Filter out deletion attempts on trigger nodes
		const filteredChanges = changes.filter((change) => {
			if (change.type === "remove") {
				const nodeToRemove = currentNodes.find((n) => n.id === change.id);
				// Prevent deletion of trigger nodes
				return nodeToRemove?.data.type !== "trigger";
			}
			return true;
		});

		const removedNodeIds = new Set(
			filteredChanges
				.filter((change) => change.type === "remove")
				.map((change) => change.id),
		);
		const removedGroupIds = new Set(
			currentNodes
				.filter((node) => removedNodeIds.has(node.id) && node.type === "group")
				.map((node) => node.id),
		);

		const nodeLookup = new Map(
			currentNodes.map((node) => [node.id, node] as const),
		);
		let newNodes = applyNodeChanges(
			filteredChanges,
			currentNodes,
		) as WorkflowNode[];
		if (removedGroupIds.size > 0) {
			newNodes = newNodes.map((node) => {
				if (!(node.parentId && removedGroupIds.has(node.parentId))) {
					return node;
				}

				return {
					...node,
					parentId: undefined,
					extent: undefined,
					position: getAbsoluteNodePosition(node, nodeLookup),
				};
			});
		}
		set(nodesAtom, newNodes);

		// Sync selection state with selectedNodeAtom
		const selectedNode = newNodes.find((n) => n.selected);
		if (selectedNode) {
			set(selectedNodeAtom, selectedNode.id);
			// Clear edge selection when a node is selected
			set(selectedEdgeAtom, null);
			// Clear newly created node tracking if a different node is selected
			const newlyCreatedId = get(newlyCreatedNodeIdAtom);
			if (newlyCreatedId && newlyCreatedId !== selectedNode.id) {
				set(newlyCreatedNodeIdAtom, null);
			}
		} else if (get(selectedNodeAtom)) {
			// If no node is selected in ReactFlow but we have a selection, clear it
			const currentSelection = get(selectedNodeAtom);
			const stillExists = newNodes.find((n) => n.id === currentSelection);
			if (!stillExists) {
				set(selectedNodeAtom, null);
			}
			// Clear newly created node tracking when no node is selected
			set(newlyCreatedNodeIdAtom, null);
		}

		// Check if there were any deletions to trigger immediate save
		const hadDeletions = filteredChanges.some(
			(change) => change.type === "remove",
		);
		if (hadDeletions) {
			set(autosaveAtom, { immediate: true });
			return;
		}

		// Check if there were any position changes (node moved) to trigger debounced save
		const hadPositionChanges = filteredChanges.some(
			(change) => change.type === "position" && change.dragging === false,
		);
		const hadDimensionChanges = filteredChanges.some(
			(change) => change.type === "dimensions" && change.resizing === false,
		);
		if (hadPositionChanges || hadDimensionChanges) {
			set(hasUnsavedChangesAtom, true);
			set(autosaveAtom); // Debounced save
		}
	},
);

export const onEdgesChangeAtom = atom(
	null,
	(get, set, changes: EdgeChange[]) => {
		const currentEdges = get(edgesAtom);
		const newEdges = applyEdgeChanges(changes, currentEdges) as WorkflowEdge[];
		set(edgesAtom, newEdges);

		// Sync selection state with selectedEdgeAtom
		const selectedEdge = newEdges.find((e) => e.selected);
		if (selectedEdge) {
			set(selectedEdgeAtom, selectedEdge.id);
			// Clear node selection when an edge is selected
			set(selectedNodeAtom, null);
		} else if (get(selectedEdgeAtom)) {
			// If no edge is selected in ReactFlow but we have a selection, clear it
			const currentSelection = get(selectedEdgeAtom);
			const stillExists = newEdges.find((e) => e.id === currentSelection);
			if (!stillExists) {
				set(selectedEdgeAtom, null);
			}
		}

		// Check if there were any deletions to trigger immediate save
		const hadDeletions = changes.some((change) => change.type === "remove");
		if (hadDeletions) {
			set(autosaveAtom, { immediate: true });
		}
	},
);

const POTENTIAL_CONNECTION_RADIUS = 150;

export const upsertConnectionSiteAtom = atom(
	null,
	(_get, set, site: ConnectionSite) => {
		set(connectionSitesAtom, (current) => ({
			...current,
			[site.id]: site,
		}));
	},
);

export const removeConnectionSiteAtom = atom(null, (get, set, id: string) => {
	const current = get(connectionSitesAtom);
	if (!current[id]) {
		return;
	}

	const next = { ...current };
	delete next[id];
	set(connectionSitesAtom, next);

	const potential = get(potentialConnectionAtom);
	if (potential?.id === id) {
		set(potentialConnectionAtom, null);
	}
});

export const checkForPotentialConnectionAtom = atom(
	null,
	(
		get,
		set,
		{
			position,
			options,
		}: {
			position: XYPosition;
			options?: { exclude?: string[]; type?: "source" | "target" };
		},
	) => {
		const excluded = new Set(options?.exclude ?? []);
		const sites = Object.values(get(connectionSitesAtom)).filter((site) => {
			if (excluded.has(site.id)) {
				return false;
			}
			if (options?.type && site.type && options.type !== site.type) {
				return false;
			}
			return true;
		});

		if (sites.length === 0) {
			set(potentialConnectionAtom, null);
			return;
		}

		let best: { distance: number; site: ConnectionSite } | null = null;
		for (const site of sites) {
			const dx = site.position.x - position.x;
			const dy = site.position.y - position.y;
			const distance = Math.hypot(dx, dy);
			if (!best || distance < best.distance) {
				best = { distance, site };
			}
		}

		if (!best || best.distance > POTENTIAL_CONNECTION_RADIUS) {
			set(potentialConnectionAtom, null);
			return;
		}

		set(potentialConnectionAtom, best.site);
	},
);

export const resetPotentialConnectionAtom = atom(null, (_get, set) => {
	set(potentialConnectionAtom, null);
});

export const insertNodeAtConnectionAtom = atom(
	null,
	(
		get,
		set,
		{
			position,
			source,
			target,
			edgeId,
			nodeType = "action",
			selectNode = true,
		}: {
			position: XYPosition;
			source?: ConnectionEndpoint;
			target?: ConnectionEndpoint;
			edgeId?: string;
			nodeType?: WorkflowNodeType;
			selectNode?: boolean;
		},
	) => {
		const effectiveNodeType = nodeType === "add" ? "action" : nodeType;
		const currentNodes = get(nodesAtom);
		const currentEdges = get(edgesAtom);
		const history = get(historyAtom);

		set(historyAtom, [
			...history,
			{ nodes: currentNodes, edges: currentEdges },
		]);
		set(futureAtom, []);

		const newNode: WorkflowNode = {
			id: nanoid(),
			type: effectiveNodeType,
			position: {
				x: position.x - NODE_HALF_SIZE,
				y: position.y - NODE_HALF_SIZE,
			},
			data: createWorkflowNodeData(effectiveNodeType),
			selected: selectNode,
		};

		const nextNodes: WorkflowNode[] = [
			...currentNodes.map(
				(node) => ({ ...node, selected: false }) as WorkflowNode,
			),
			newNode,
		];

		const baseEdges = currentEdges.filter((edge) => {
			if (edgeId) {
				return edge.id !== edgeId;
			}
			if (!(source && target)) {
				return true;
			}
			return !(
				edge.source === source.node &&
				edge.target === target.node &&
				(edge.sourceHandle ?? null) === (source.handle ?? null) &&
				(edge.targetHandle ?? null) === (target.handle ?? null)
			);
		});

		const nextEdges = [...baseEdges];

		if (source) {
			nextEdges.push({
				id: nanoid(),
				type: "animated",
				source: source.node,
				target: newNode.id,
				sourceHandle: source.handle ?? null,
			});
		}

		if (target) {
			nextEdges.push({
				id: nanoid(),
				type: "animated",
				source: newNode.id,
				target: target.node,
				targetHandle: target.handle ?? null,
			});
		}

		set(nodesAtom, nextNodes);
		set(edgesAtom, nextEdges);
		set(selectedEdgeAtom, null);
		if (selectNode) {
			set(selectedNodeAtom, newNode.id);
			if (newNode.data.type === "action" && !newNode.data.config?.actionType) {
				set(newlyCreatedNodeIdAtom, newNode.id);
			}
		}

		set(potentialConnectionAtom, null);
		set(hasUnsavedChangesAtom, true);
		set(autosaveAtom, { immediate: true });
	},
);

export const addNodeAtom = atom(null, (get, set, node: WorkflowNode) => {
	// Save current state to history before making changes
	const currentNodes = get(nodesAtom);
	const currentEdges = get(edgesAtom);
	const history = get(historyAtom);
	set(historyAtom, [...history, { nodes: currentNodes, edges: currentEdges }]);
	set(futureAtom, []);

	// Deselect all existing nodes and add new node as selected
	const updatedNodes = currentNodes.map((n) => ({ ...n, selected: false }));
	const newNode = { ...node, selected: true };
	const newNodes = [...updatedNodes, newNode];
	set(nodesAtom, newNodes);

	// Auto-select the newly added node
	set(selectedNodeAtom, node.id);

	// Track newly created action nodes (for auto-focusing search input)
	if (node.data.type === "action" && !node.data.config?.actionType) {
		set(newlyCreatedNodeIdAtom, node.id);
	}

	// Mark as having unsaved changes
	set(hasUnsavedChangesAtom, true);

	// Trigger immediate autosave
	set(autosaveAtom, { immediate: true });
});

export const updateNodeDataAtom = atom(
	null,
	(get, set, { id, data }: { id: string; data: Partial<WorkflowNodeData> }) => {
		const currentNodes = get(nodesAtom);
		const oldNode = currentNodes.find((node) => node.id === id);
		if (!oldNode) {
			return;
		}

		const updateKeys = Object.keys(data) as Array<keyof WorkflowNodeData>;
		const isStatusOnlyUpdate =
			updateKeys.length > 0 && updateKeys.every((key) => key === "status");
		const hasDirectDataChanges = updateKeys.some(
			(key) => oldNode.data[key] !== data[key],
		);

		// Check if label is being updated
		const oldLabel = oldNode?.data.label;
		const newLabel = data.label;
		const isLabelChange = newLabel !== undefined && oldLabel !== newLabel;
		if (!hasDirectDataChanges && !isLabelChange) {
			return;
		}

		let hasNodeChanges = false;
		const newNodes = currentNodes.map((node) => {
			if (node.id === id) {
				// Update the node itself
				hasNodeChanges = true;
				return { ...node, data: { ...node.data, ...data } };
			}

			// If label changed, update all templates in other nodes that reference this node
			if (isLabelChange && oldLabel) {
				const updatedConfig = updateTemplatesInConfig(
					node.data.config || {},
					id,
					oldLabel,
					newLabel,
				);

				if (updatedConfig !== node.data.config) {
					hasNodeChanges = true;
					return {
						...node,
						data: {
							...node.data,
							config: updatedConfig,
						},
					};
				}
			}

			return node;
		});

		if (!hasNodeChanges) {
			return;
		}

		if (!isStatusOnlyUpdate) {
			const currentEdges = get(edgesAtom);
			const history = get(historyAtom);
			set(historyAtom, [
				...history,
				{ nodes: currentNodes, edges: currentEdges },
			]);
			set(futureAtom, []);
		}

		set(nodesAtom, newNodes);

		// Mark as having unsaved changes (except for status updates during execution)
		if (!isStatusOnlyUpdate) {
			set(hasUnsavedChangesAtom, true);
			// Trigger debounced autosave (for typing)
			set(autosaveAtom);
		}
	},
);

// Batch update node statuses in a single atomic write.
// This avoids stale-ref issues when polling: the atom setter
// always reads the latest nodes via get(nodesAtom).
export const batchSetNodeStatusesAtom = atom(
	null,
	(
		get,
		set,
		statusMap: Map<string, "idle" | "running" | "success" | "error">,
	) => {
		const currentNodes = get(nodesAtom);
		let hasChanges = false;

		const newNodes = currentNodes.map((node) => {
			const status = statusMap.get(node.id) || "idle";
			if (node.data.status !== status) {
				hasChanges = true;
				return { ...node, data: { ...node.data, status } };
			}
			return node;
		});

		if (hasChanges) {
			set(nodesAtom, newNodes);
		}
	},
);

const NODE_SIMULATION_BASE_DELAY_MS = 700;
const canceledSimulationNodes = new Set<string>();
let workflowSimulationRunToken = 0;

function getNodeSimulationError(node: WorkflowNode): string | null {
	const config = node.data.config ?? {};

	switch (node.data.type) {
		case "action": {
			const actionType = String(config.actionType ?? "").trim();
			return actionType ? null : "Action type is required";
		}
		case "activity": {
			const activityName = String(config.activityName ?? "").trim();
			return activityName ? null : "Activity name is required";
		}
		case "timer": {
			const duration = Number(config.durationSeconds ?? 0);
			return Number.isFinite(duration) && duration > 0
				? null
				: "Timer duration must be greater than 0";
		}
		case "approval-gate": {
			const eventName = String(config.eventName ?? "").trim();
			return eventName ? null : "Approval event name is required";
		}
		case "if-else": {
			const expression = String(config.expression ?? "").trim();
			return expression ? null : "Condition expression is required";
		}
		case "loop-until": {
			const condition = String(config.untilCondition ?? "").trim();
			return condition ? null : "Loop exit condition is required";
		}
		case "set-state": {
			const hasEntries =
				Array.isArray((config as Record<string, unknown>).entries) &&
				(config as { entries: unknown[] }).entries.length > 0;
			const singleKey = String(config.key ?? "").trim();
			return hasEntries || singleKey
				? null
				: "At least one state key is required";
		}
		case "transform": {
			const template = String(config.template ?? "").trim();
			return template ? null : "Transform template is required";
		}
		case "while": {
			const expression = String(config.expression ?? "").trim();
			return expression ? null : "While condition is required";
		}
		case "group":
			return "Group steps are not executable";
		case "note":
			return "Note steps are not executable";
		default:
			return null;
	}
}

function getTopologicalSimulationOrder(
	nodes: WorkflowNode[],
	edges: WorkflowEdge[],
): string[] {
	const executableNodes = nodes.filter(
		(node) =>
			node.type !== "add" && node.type !== "note" && node.type !== "group",
	);
	const executableIds = new Set(executableNodes.map((node) => node.id));
	const filteredEdges = edges.filter(
		(edge) => executableIds.has(edge.source) && executableIds.has(edge.target),
	);

	const incomingCount = new Map<string, number>();
	const outgoing = new Map<string, string[]>();
	for (const node of executableNodes) {
		incomingCount.set(node.id, 0);
		outgoing.set(node.id, []);
	}
	for (const edge of filteredEdges) {
		incomingCount.set(edge.target, (incomingCount.get(edge.target) ?? 0) + 1);
		outgoing.set(edge.source, [
			...(outgoing.get(edge.source) ?? []),
			edge.target,
		]);
	}

	const queue = executableNodes
		.filter((node) => (incomingCount.get(node.id) ?? 0) === 0)
		.sort((a, b) => a.position.x - b.position.x || a.position.y - b.position.y)
		.map((node) => node.id);
	const ordered: string[] = [];

	while (queue.length > 0) {
		const nodeId = queue.shift();
		if (!nodeId) {
			break;
		}
		ordered.push(nodeId);
		for (const nextId of outgoing.get(nodeId) ?? []) {
			const remaining = (incomingCount.get(nextId) ?? 0) - 1;
			incomingCount.set(nextId, remaining);
			if (remaining === 0) {
				queue.push(nextId);
			}
		}
	}

	// Cycles or disconnected fragments: append remaining nodes by canvas position.
	if (ordered.length < executableNodes.length) {
		const seen = new Set(ordered);
		const remaining = executableNodes
			.filter((node) => !seen.has(node.id))
			.sort(
				(a, b) => a.position.x - b.position.x || a.position.y - b.position.y,
			)
			.map((node) => node.id);
		return [...ordered, ...remaining];
	}

	return ordered;
}

export const clearNodeSimulationResultAtom = atom(
	null,
	(get, set, nodeId: string) => {
		const current = get(nodeSimulationResultsAtom);
		if (!current[nodeId]) {
			return;
		}
		const next = { ...current };
		delete next[nodeId];
		set(nodeSimulationResultsAtom, next);
	},
);

export const cancelNodeSimulationAtom = atom(
	null,
	(get, set, nodeId: string) => {
		canceledSimulationNodes.add(nodeId);
		const running = get(simulatingNodeIdsAtom);
		if (!running.has(nodeId)) {
			return;
		}

		const nextRunning = new Set(running);
		nextRunning.delete(nodeId);
		set(simulatingNodeIdsAtom, nextRunning);
		set(updateNodeDataAtom, { id: nodeId, data: { status: "idle" } });
	},
);

export const simulateNodeRunAtom = atom(
	null,
	async (
		get,
		set,
		{
			nodeId,
			delayMs = NODE_SIMULATION_BASE_DELAY_MS,
			preserveSelection = false,
		}: {
			nodeId: string;
			delayMs?: number;
			preserveSelection?: boolean;
		},
	) => {
		const node = get(nodesAtom).find((candidate) => candidate.id === nodeId);
		if (!node) {
			return;
		}
		if (node.type === "add" || node.type === "note" || node.type === "group") {
			return;
		}

		const running = get(simulatingNodeIdsAtom);
		if (running.has(nodeId)) {
			return;
		}

		canceledSimulationNodes.delete(nodeId);
		set(simulatingNodeIdsAtom, new Set([...running, nodeId]));
		if (!preserveSelection) {
			set(selectedExecutionIdAtom, null);
		}
		set(updateNodeDataAtom, { id: nodeId, data: { status: "running" } });

		await new Promise((resolve) => {
			setTimeout(resolve, delayMs);
		});

		if (canceledSimulationNodes.has(nodeId)) {
			canceledSimulationNodes.delete(nodeId);
			set(updateNodeDataAtom, { id: nodeId, data: { status: "idle" } });
			set(simulatingNodeIdsAtom, (current) => {
				const next = new Set(current);
				next.delete(nodeId);
				return next;
			});
			return;
		}

		const latestNode = get(nodesAtom).find(
			(candidate) => candidate.id === nodeId,
		);
		if (!latestNode) {
			set(simulatingNodeIdsAtom, (current) => {
				const next = new Set(current);
				next.delete(nodeId);
				return next;
			});
			return;
		}

		const errorMessage = getNodeSimulationError(latestNode);
		const status: "success" | "error" = errorMessage ? "error" : "success";
		set(updateNodeDataAtom, { id: nodeId, data: { status } });
		set(nodeSimulationResultsAtom, (current) => ({
			...current,
			[nodeId]: {
				nodeId,
				status,
				summary:
					status === "success"
						? "Dry run completed"
						: "Dry run validation failed",
				output:
					status === "success"
						? {
								nodeType: latestNode.data.type,
								configured:
									Object.keys(latestNode.data.config ?? {}).length > 0,
							}
						: { error: errorMessage },
				finishedAt: new Date().toISOString(),
			},
		}));
		set(simulatingNodeIdsAtom, (current) => {
			const next = new Set(current);
			next.delete(nodeId);
			return next;
		});
	},
);

export const cancelWorkflowSimulationAtom = atom(null, (get, set) => {
	workflowSimulationRunToken += 1;
	set(workflowSimulationRunningAtom, false);
	for (const nodeId of get(simulatingNodeIdsAtom)) {
		set(cancelNodeSimulationAtom, nodeId);
	}
});

export const simulateWorkflowRunAtom = atom(
	null,
	async (
		get,
		set,
		{ delayMs = NODE_SIMULATION_BASE_DELAY_MS }: { delayMs?: number } = {},
	) => {
		if (get(workflowSimulationRunningAtom)) {
			return;
		}

		workflowSimulationRunToken += 1;
		const currentRunToken = workflowSimulationRunToken;
		set(workflowSimulationRunningAtom, true);
		set(selectedExecutionIdAtom, null);

		try {
			const order = getTopologicalSimulationOrder(
				get(nodesAtom),
				get(edgesAtom),
			);
			for (const nodeId of order) {
				if (currentRunToken !== workflowSimulationRunToken) {
					break;
				}
				await set(simulateNodeRunAtom, {
					nodeId,
					delayMs,
					preserveSelection: true,
				});
			}
		} finally {
			if (currentRunToken === workflowSimulationRunToken) {
				set(workflowSimulationRunningAtom, false);
			}
		}
	},
);

// Helper function to update templates in a config object when a node label changes
function updateTemplatesInConfig(
	config: Record<string, unknown>,
	nodeId: string,
	oldLabel: string,
	newLabel: string,
): Record<string, unknown> {
	let hasChanges = false;
	const updated: Record<string, unknown> = {};

	for (const [key, value] of Object.entries(config)) {
		if (typeof value === "string") {
			// Update template references to this node
			// Pattern: {{@nodeId:OldLabel}} or {{@nodeId:OldLabel.field}}
			const pattern = new RegExp(
				`\\{\\{@${escapeRegex(nodeId)}:${escapeRegex(oldLabel)}(\\.[^}]+)?\\}\\}`,
				"g",
			);
			const newValue = value.replace(pattern, (_match, fieldPart) => {
				hasChanges = true;
				return `{{@${nodeId}:${newLabel}${fieldPart || ""}}}`;
			});
			updated[key] = newValue;
		} else if (
			typeof value === "object" &&
			value !== null &&
			!Array.isArray(value)
		) {
			const nestedUpdated = updateTemplatesInConfig(
				value as Record<string, unknown>,
				nodeId,
				oldLabel,
				newLabel,
			);
			if (nestedUpdated !== value) {
				hasChanges = true;
			}
			updated[key] = nestedUpdated;
		} else {
			updated[key] = value;
		}
	}

	return hasChanges ? updated : config;
}

// Helper to escape special regex characters
function escapeRegex(str: string): string {
	return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export const deleteNodeAtom = atom(null, (get, set, nodeId: string) => {
	const currentNodes = get(nodesAtom);

	// Prevent deletion of trigger nodes
	const nodeToDelete = currentNodes.find((node) => node.id === nodeId);
	if (nodeToDelete?.data.type === "trigger") {
		return;
	}

	// Save current state to history before making changes
	const currentEdges = get(edgesAtom);
	const history = get(historyAtom);
	set(historyAtom, [...history, { nodes: currentNodes, edges: currentEdges }]);
	set(futureAtom, []);

	const nodeLookup = new Map(
		currentNodes.map((node) => [node.id, node] as const),
	);
	const newNodes = currentNodes
		.filter((node) => node.id !== nodeId)
		.map((node) => {
			if (!(node.parentId && node.parentId === nodeId)) {
				return node;
			}
			const abs = getAbsoluteNodePosition(node, nodeLookup);
			return {
				...node,
				parentId: undefined,
				extent: undefined,
				position: abs,
			};
		});
	const newEdges = currentEdges.filter(
		(edge) => edge.source !== nodeId && edge.target !== nodeId,
	);

	set(nodesAtom, newNodes);
	set(edgesAtom, newEdges);

	if (get(selectedNodeAtom) === nodeId) {
		set(selectedNodeAtom, null);
	}

	// Mark as having unsaved changes
	set(hasUnsavedChangesAtom, true);

	// Trigger immediate autosave
	set(autosaveAtom, { immediate: true });
});

export const addEdgeAtom = atom(
	null,
	(
		get,
		set,
		edge: {
			id: string;
			source: string;
			target: string;
			sourceHandle?: string | null;
			targetHandle?: string | null;
			type?: string;
		},
	) => {
		// Save current state to history before making changes
		const currentNodes = get(nodesAtom);
		const currentEdges = get(edgesAtom);
		const history = get(historyAtom);
		set(historyAtom, [
			...history,
			{ nodes: currentNodes, edges: currentEdges },
		]);
		set(futureAtom, []);

		const newEdge: WorkflowEdge = {
			id: edge.id,
			source: edge.source,
			target: edge.target,
			...(edge.sourceHandle ? { sourceHandle: edge.sourceHandle } : {}),
			...(edge.targetHandle ? { targetHandle: edge.targetHandle } : {}),
			type: edge.type || "animated",
		};

		set(edgesAtom, [...currentEdges, newEdge]);

		// Mark as having unsaved changes
		set(hasUnsavedChangesAtom, true);

		// Trigger immediate autosave
		set(autosaveAtom, { immediate: true });
	},
);

export const deleteEdgeAtom = atom(null, (get, set, edgeId: string) => {
	// Save current state to history before making changes
	const currentNodes = get(nodesAtom);
	const currentEdges = get(edgesAtom);
	const history = get(historyAtom);
	set(historyAtom, [...history, { nodes: currentNodes, edges: currentEdges }]);
	set(futureAtom, []);

	const newEdges = currentEdges.filter((edge) => edge.id !== edgeId);
	set(edgesAtom, newEdges);

	if (get(selectedEdgeAtom) === edgeId) {
		set(selectedEdgeAtom, null);
	}

	// Mark as having unsaved changes
	set(hasUnsavedChangesAtom, true);

	// Trigger immediate autosave
	set(autosaveAtom, { immediate: true });
});

export const deleteSelectedItemsAtom = atom(null, (get, set) => {
	// Save current state to history before making changes
	const currentNodes = get(nodesAtom);
	const currentEdges = get(edgesAtom);
	const history = get(historyAtom);
	set(historyAtom, [...history, { nodes: currentNodes, edges: currentEdges }]);
	set(futureAtom, []);

	// Get all selected nodes, excluding trigger nodes
	const selectedNodeIds = currentNodes
		.filter((node) => node.selected && node.data.type !== "trigger")
		.map((node) => node.id);
	const selectedNodeIdSet = new Set(selectedNodeIds);
	const selectedGroupIds = new Set(
		currentNodes
			.filter((node) => selectedNodeIdSet.has(node.id) && node.type === "group")
			.map((node) => node.id),
	);
	const nodeLookup = new Map(
		currentNodes.map((node) => [node.id, node] as const),
	);

	// Delete selected nodes (excluding trigger nodes) and their connected edges
	const newNodes = currentNodes
		.filter((node) => {
			// Keep trigger nodes even if selected
			if (node.data.type === "trigger") {
				return true;
			}
			// Remove other selected nodes
			return !node.selected;
		})
		.map((node) => {
			if (
				!(node.parentId && selectedGroupIds.has(node.parentId)) ||
				selectedNodeIdSet.has(node.id)
			) {
				return node;
			}

			const abs = getAbsoluteNodePosition(node, nodeLookup);
			return {
				...node,
				parentId: undefined,
				extent: undefined,
				position: abs,
			};
		});

	const newEdges = currentEdges.filter(
		(edge) =>
			!(
				edge.selected ||
				selectedNodeIds.includes(edge.source) ||
				selectedNodeIds.includes(edge.target)
			),
	);

	set(nodesAtom, newNodes);
	set(edgesAtom, newEdges);
	set(selectedNodeAtom, null);
	set(selectedEdgeAtom, null);

	// Mark as having unsaved changes
	set(hasUnsavedChangesAtom, true);

	// Trigger immediate autosave
	set(autosaveAtom, { immediate: true });
});

export const clearWorkflowAtom = atom(null, (get, set) => {
	// Save current state to history before making changes
	const currentNodes = get(nodesAtom);
	const currentEdges = get(edgesAtom);
	const history = get(historyAtom);
	set(historyAtom, [...history, { nodes: currentNodes, edges: currentEdges }]);
	set(futureAtom, []);

	set(nodesAtom, []);
	set(edgesAtom, []);
	set(selectedNodeAtom, null);
	set(selectedEdgeAtom, null);

	// Mark as having unsaved changes
	set(hasUnsavedChangesAtom, true);
});

// Counter atom: increment to request fitView from outside React Flow context
export const fitViewRequestAtom = atom(0);

// Auto-arrange nodes using dagre layout (imported lazily to avoid circular deps)
export const autoArrangeAtom = atom(null, async (get, set) => {
	const currentNodes = get(nodesAtom);
	const currentEdges = get(edgesAtom);

	// Save current state to history for undo
	const history = get(historyAtom);
	set(historyAtom, [...history, { nodes: currentNodes, edges: currentEdges }]);
	set(futureAtom, []);

	// Lazy import to avoid circular dependency
	const { layoutWorkflowNodes } = await import(
		"@/lib/workflow-layout/dagre-layout"
	);
	const nextNodes = layoutWorkflowNodes(currentNodes, currentEdges);
	set(nodesAtom, nextNodes);

	// Mark as having unsaved changes
	set(hasUnsavedChangesAtom, true);

	// Trigger autosave
	set(autosaveAtom, { immediate: true });

	// Request fitView
	set(fitViewRequestAtom, (c) => c + 1);
});

// Load workflow from database
export const loadWorkflowAtom = atom(null, async (_get, set) => {
	try {
		set(isLoadingAtom, true);
		const workflow = await api.workflow.getCurrent();
		set(nodesAtom, workflow.nodes);
		set(edgesAtom, workflow.edges);
		if (workflow.id) {
			set(currentWorkflowIdAtom, workflow.id);
		}
	} catch (error) {
		console.error("Failed to load workflow:", error);
	} finally {
		set(isLoadingAtom, false);
	}
});

// Save workflow with a name
export const saveWorkflowAsAtom = atom(
	null,
	async (
		get,
		_set,
		{ name, description }: { name: string; description?: string },
	) => {
		const nodes = get(nodesAtom);
		const edges = get(edgesAtom);

		try {
			const workflow = await api.workflow.create({
				name,
				description,
				nodes,
				edges,
			});
			return workflow;
		} catch (error) {
			console.error("Failed to save workflow:", error);
			throw error;
		}
	},
);

// Workflow toolbar UI state atoms
export const showClearDialogAtom = atom(false);
export const showDeleteDialogAtom = atom(false);
export const isSavingAtom = atom(false);
export const hasUnsavedChangesAtom = atom(false);
export const workflowNotFoundAtom = atom(false);

// Undo/Redo state
type HistoryState = {
	nodes: WorkflowNode[];
	edges: WorkflowEdge[];
};

const historyAtom = atom<HistoryState[]>([]);
const futureAtom = atom<HistoryState[]>([]);

export const pushHistorySnapshotAtom = atom(null, (get, set) => {
	const currentNodes = get(nodesAtom);
	const currentEdges = get(edgesAtom);
	const history = get(historyAtom);
	set(historyAtom, [...history, { nodes: currentNodes, edges: currentEdges }]);
	set(futureAtom, []);
});

export const groupSelectedNodesAtom = atom(null, (get, set) => {
	const currentNodes = get(nodesAtom);
	const currentEdges = get(edgesAtom);
	const selectedNodes = currentNodes.filter((node) => node.selected);
	const groupableNodes = selectedNodes.filter(isGroupableNode);

	if (groupableNodes.length < 2) {
		return;
	}

	set(pushHistorySnapshotAtom);

	const nodeLookup = new Map(
		currentNodes.map((node) => [node.id, node] as const),
	);
	const groupableIds = new Set(groupableNodes.map((node) => node.id));
	const absolutePositions = new Map(
		groupableNodes.map((node) => [
			node.id,
			getAbsoluteNodePosition(node, nodeLookup),
		]),
	);

	const minX = Math.min(
		...groupableNodes.map((node) => absolutePositions.get(node.id)?.x ?? 0),
	);
	const minY = Math.min(
		...groupableNodes.map((node) => absolutePositions.get(node.id)?.y ?? 0),
	);
	const maxX = Math.max(
		...groupableNodes.map(
			(node) => (absolutePositions.get(node.id)?.x ?? 0) + NODE_HALF_SIZE * 2,
		),
	);
	const maxY = Math.max(
		...groupableNodes.map(
			(node) => (absolutePositions.get(node.id)?.y ?? 0) + NODE_HALF_SIZE * 2,
		),
	);

	const groupId = nanoid();
	const groupPosition = { x: minX - GROUP_PADDING, y: minY - GROUP_PADDING };
	const groupNode: WorkflowNode = {
		id: groupId,
		type: "group",
		position: groupPosition,
		data: {
			...createWorkflowNodeData("group"),
			label: "Group",
			description: "Grouped steps",
		},
		selected: true,
		style: {
			width: Math.max(maxX - minX + GROUP_PADDING * 2, DEFAULT_GROUP_WIDTH),
			height: Math.max(maxY - minY + GROUP_PADDING * 2, DEFAULT_GROUP_HEIGHT),
		},
	};

	const nextNodes = [
		...currentNodes.map((node) => {
			if (!groupableIds.has(node.id)) {
				return { ...node, selected: false };
			}

			const absolutePosition = absolutePositions.get(node.id);
			if (!absolutePosition) {
				return { ...node, selected: false };
			}

			return {
				...node,
				parentId: groupId,
				extent: "parent" as const,
				selected: false,
				position: {
					x: absolutePosition.x - groupPosition.x,
					y: absolutePosition.y - groupPosition.y,
				},
			};
		}),
		groupNode,
	];

	set(nodesAtom, nextNodes);
	set(selectedNodeAtom, groupId);
	set(selectedEdgeAtom, null);
	set(hasUnsavedChangesAtom, true);
	set(autosaveAtom, { immediate: true });
});

export const ungroupNodeAtom = atom(null, (get, set, groupId: string) => {
	const currentNodes = get(nodesAtom);
	const currentEdges = get(edgesAtom);
	const groupNode = currentNodes.find(
		(node) => node.id === groupId && node.type === "group",
	);
	if (!groupNode) {
		return;
	}

	const nodeLookup = new Map(
		currentNodes.map((node) => [node.id, node] as const),
	);
	const childNodes = currentNodes.filter((node) => node.parentId === groupId);

	set(pushHistorySnapshotAtom);

	const nextNodes = currentNodes
		.filter((node) => node.id !== groupId)
		.map((node) => {
			if (node.parentId !== groupId) {
				return { ...node, selected: false };
			}

			return {
				...node,
				parentId: undefined,
				extent: undefined,
				selected: true,
				position: getAbsoluteNodePosition(node, nodeLookup),
			};
		});

	set(nodesAtom, nextNodes);
	set(edgesAtom, currentEdges);
	set(
		selectedNodeAtom,
		childNodes.length === 1 ? (childNodes[0]?.id ?? null) : null,
	);
	set(selectedEdgeAtom, null);
	set(hasUnsavedChangesAtom, true);
	set(autosaveAtom, { immediate: true });
});

export const detachNodeFromParentAtom = atom(
	null,
	(get, set, nodeId: string) => {
		const currentNodes = get(nodesAtom);
		const nodeToDetach = currentNodes.find((node) => node.id === nodeId);
		if (!nodeToDetach?.parentId) {
			return;
		}

		const currentEdges = get(edgesAtom);
		const history = get(historyAtom);
		set(historyAtom, [
			...history,
			{ nodes: currentNodes, edges: currentEdges },
		]);
		set(futureAtom, []);

		const nodeLookup = new Map(
			currentNodes.map((node) => [node.id, node] as const),
		);
		const absolutePosition = getAbsoluteNodePosition(nodeToDetach, nodeLookup);

		const nextNodes = currentNodes.map((node) => {
			if (node.id === nodeId) {
				return {
					...node,
					parentId: undefined,
					extent: undefined,
					selected: true,
					position: absolutePosition,
				};
			}

			return {
				...node,
				selected: false,
			};
		});

		set(nodesAtom, nextNodes);
		set(selectedNodeAtom, nodeId);
		set(selectedEdgeAtom, null);
		set(hasUnsavedChangesAtom, true);
		set(autosaveAtom, { immediate: true });
	},
);

// Undo atom
export const undoAtom = atom(null, (get, set) => {
	const history = get(historyAtom);
	if (history.length === 0) {
		return;
	}

	const currentNodes = get(nodesAtom);
	const currentEdges = get(edgesAtom);
	const future = get(futureAtom);

	// Save current state to future
	set(futureAtom, [...future, { nodes: currentNodes, edges: currentEdges }]);

	// Pop from history and set as current
	const newHistory = [...history];
	const previousState = newHistory.pop();
	if (!previousState) {
		return; // No history to undo
	}
	set(historyAtom, newHistory);
	set(nodesAtom, previousState.nodes);
	set(edgesAtom, previousState.edges);

	// Mark as having unsaved changes
	set(hasUnsavedChangesAtom, true);
});

// Redo atom
export const redoAtom = atom(null, (get, set) => {
	const future = get(futureAtom);
	if (future.length === 0) {
		return;
	}

	const currentNodes = get(nodesAtom);
	const currentEdges = get(edgesAtom);
	const history = get(historyAtom);

	// Save current state to history
	set(historyAtom, [...history, { nodes: currentNodes, edges: currentEdges }]);

	// Pop from future and set as current
	const newFuture = [...future];
	const nextState = newFuture.pop();
	if (!nextState) {
		return; // No future to redo
	}
	set(futureAtom, newFuture);
	set(nodesAtom, nextState.nodes);
	set(edgesAtom, nextState.edges);

	// Mark as having unsaved changes
	set(hasUnsavedChangesAtom, true);
});

// Can undo/redo atoms
export const canUndoAtom = atom((get) => get(historyAtom).length > 0);
export const canRedoAtom = atom((get) => get(futureAtom).length > 0);

// Clear all node statuses (used when clearing runs)
export const clearNodeStatusesAtom = atom(null, (get, set) => {
	const currentNodes = get(nodesAtom);
	const newNodes = currentNodes.map((node) => ({
		...node,
		data: { ...node.data, status: "idle" as const },
	}));
	set(nodesAtom, newNodes);
});

// Currently running node ID (set from orchestrator status polling)
export const currentRunningNodeIdAtom = atom<string | null>(null);

// Dapr workflow execution state atoms
export type DaprPhase =
	| "planning"
	| "persisting"
	| "awaiting_approval"
	| "executing"
	| "completed"
	| "failed"
	| null;

export const daprPhaseAtom = atom<DaprPhase>(null);
export const daprProgressAtom = atom<number>(0); // 0-100
export const daprMessageAtom = atom<string>(""); // Human-readable status message
export const daprInstanceIdAtom = atom<string | null>(null);

// Approval gate context — set when a workflow reaches awaiting_approval phase
export const approvalEventNameAtom = atom<string | null>(null);
export const approvalExecutionIdAtom = atom<string | null>(null);
// Sticky flag: true after user clicks approve/reject, prevents polling from re-clearing atoms
export const approvalRespondedAtom = atom<boolean>(false);

// Engine type for the current workflow
export type WorkflowEngineType = "vercel" | "dapr";
export const currentWorkflowEngineTypeAtom = atom<WorkflowEngineType>("dapr");

// Morph node type atom - changes a node's type after creation (e.g., action -> activity)
export const morphNodeTypeAtom = atom(
	null,
	(
		get,
		set,
		{
			id,
			nodeType,
			data,
		}: {
			id: string;
			nodeType: WorkflowNodeType;
			data: Partial<WorkflowNodeData>;
		},
	) => {
		// Save current state to history before making changes
		const currentNodes = get(nodesAtom);
		const currentEdges = get(edgesAtom);
		const history = get(historyAtom);
		set(historyAtom, [
			...history,
			{ nodes: currentNodes, edges: currentEdges },
		]);
		set(futureAtom, []);

		// Update the node's type and data
		const newNodes = currentNodes.map((node) => {
			if (node.id === id) {
				return {
					...node,
					type: nodeType,
					data: {
						...node.data,
						...data,
						type: nodeType,
					},
				};
			}
			return node;
		});

		set(nodesAtom, newNodes);

		// Mark as having unsaved changes
		set(hasUnsavedChangesAtom, true);

		// Trigger immediate autosave
		set(autosaveAtom, { immediate: true });
	},
);
