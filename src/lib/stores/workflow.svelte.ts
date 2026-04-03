import type { Node, Edge } from '@xyflow/svelte';
import { createHistoryStore, type HistorySnapshot } from './history-store.svelte';

// CNCF Serverless Workflow 1.0 node types (SW 1.0 only)
export type WorkflowNodeType =
	| 'start'
	| 'end'
	| 'call'
	| 'set'
	| 'switch'
	| 'wait'
	| 'emit'
	| 'listen'
	| 'for'
	| 'fork'
	| 'try'
	| 'run'
	| 'raise'
	| 'do';

export type NodeStatus = 'idle' | 'running' | 'success' | 'error';

export interface WorkflowNodeData extends Record<string, unknown> {
	label: string;
	description?: string;
	type: WorkflowNodeType;
	config?: Record<string, unknown>;
	taskConfig?: Record<string, unknown>;
	status?: NodeStatus;
	enabled?: boolean;
}

export type WorkflowNode = Node<WorkflowNodeData>;
export type WorkflowEdge = Edge;

export function createWorkflowStore() {
	// Canvas state — $state.raw avoids deep proxy overhead on large arrays
	let nodes = $state.raw<WorkflowNode[]>([]);
	let edges = $state.raw<WorkflowEdge[]>([]);
	let selectedNodeId = $state<string | null>(null);
	let selectedEdgeId = $state<string | null>(null);

	// Workflow metadata
	let workflowId = $state<string | null>(null);
	let workflowName = $state('Untitled Workflow');
	let isSaving = $state(false);
	let isLoading = $state(false);
	let publishedRuntime = $state<Record<string, unknown> | null>(null);

	// Version-based dirty detection (O(1) instead of boolean)
	let _editVersion = $state(0);
	let _savedVersion = $state(0);
	let isDirty = $derived(_editVersion !== _savedVersion);

	// Execution state
	let currentRunningNodeId = $state<string | null>(null);
	let selectedExecutionId = $state<string | null>(null);

	// UI state
	let activeConfigTab = $state('runs');
	let showMinimap = $state(true);
	let showRunsPanel = $state(true);

	// History integration
	const history = createHistoryStore();

	// Derived
	let selectedNode = $derived(
		selectedNodeId ? nodes.find((n) => n.id === selectedNodeId) ?? null : null
	);
	let nodeCount = $derived(nodes.length);

	function _snapshot(): HistorySnapshot {
		return {
			nodes: structuredClone(nodes),
			edges: structuredClone(edges)
		};
	}

	function pushHistory() {
		history.pushState(_snapshot());
		_editVersion++;
	}

	function undo() {
		const entry = history.undo(_snapshot);
		if (entry) {
			nodes = entry.nodes as WorkflowNode[];
			edges = entry.edges as WorkflowEdge[];
		}
	}

	function redo() {
		const entry = history.redo(_snapshot);
		if (entry) {
			nodes = entry.nodes as WorkflowNode[];
			edges = entry.edges as WorkflowEdge[];
		}
	}

	function addNode(type: WorkflowNodeType, position: { x: number; y: number }, label?: string) {
		pushHistory();
		const id = crypto.randomUUID();
		const newNode: WorkflowNode = {
			id,
			type,
			position,
			data: {
				label: label || type.charAt(0).toUpperCase() + type.slice(1),
				type,
				status: 'idle',
				enabled: true
			}
		};
		nodes = [...nodes, newNode];
		selectedNodeId = id;
		return id;
	}

	function removeNode(id: string) {
		pushHistory();
		nodes = nodes.filter((n) => n.id !== id);
		edges = edges.filter((e) => e.source !== id && e.target !== id);
		if (selectedNodeId === id) selectedNodeId = null;
	}

	function updateNodeData(id: string, data: Partial<WorkflowNodeData>) {
		pushHistory();
		nodes = nodes.map((n) => (n.id === id ? { ...n, data: { ...n.data, ...data } } : n));
	}

	function updateNodeStatus(id: string, status: NodeStatus) {
		nodes = nodes.map((n) =>
			n.id === id ? { ...n, data: { ...n.data, status } } : n
		);
	}

	function addEdge(source: string, target: string, sourceHandle?: string, targetHandle?: string) {
		pushHistory();
		const id = sourceHandle
			? `${source}-${sourceHandle}-${target}`
			: `${source}-${target}`;
		if (edges.some((e) => e.id === id)) return;
		const newEdge: WorkflowEdge = { id, source, target };
		if (sourceHandle) newEdge.sourceHandle = sourceHandle;
		if (targetHandle) newEdge.targetHandle = targetHandle;
		edges = [...edges, newEdge];
	}

	function removeEdge(id: string) {
		pushHistory();
		edges = edges.filter((e) => e.id !== id);
	}

	function insertNodeOnEdge(
		edgeId: string,
		nodeType: WorkflowNodeType,
		position: { x: number; y: number }
	) {
		const edge = edges.find((e) => e.id === edgeId);
		if (!edge) return;

		pushHistory();
		const newId = crypto.randomUUID();
		const newNode: WorkflowNode = {
			id: newId,
			type: nodeType,
			position,
			data: {
				label: nodeType.charAt(0).toUpperCase() + nodeType.slice(1),
				type: nodeType,
				status: 'idle',
				enabled: true
			}
		};

		// Remove old edge, add node, add two new edges
		edges = edges.filter((e) => e.id !== edgeId);
		nodes = [...nodes, newNode];
		const edgeBefore: WorkflowEdge = {
			id: `${edge.source}-${newId}`,
			source: edge.source,
			target: newId
		};
		if (edge.sourceHandle) edgeBefore.sourceHandle = edge.sourceHandle;
		const edgeAfter: WorkflowEdge = {
			id: `${newId}-${edge.target}`,
			source: newId,
			target: edge.target
		};
		if (edge.targetHandle) edgeAfter.targetHandle = edge.targetHandle;
		edges = [...edges, edgeBefore, edgeAfter];
		selectedNodeId = newId;
		return newId;
	}

	function getSelectedNodes(): WorkflowNode[] {
		return nodes.filter((n) => n.selected);
	}

	function getSelectedEdges(): WorkflowEdge[] {
		return edges.filter((e) => e.selected);
	}

	function loadWorkflow(
		id: string,
		name: string,
		loadedNodes: WorkflowNode[],
		loadedEdges: WorkflowEdge[]
	) {
		workflowId = id;
		workflowName = name;
		nodes = loadedNodes;
		edges = loadedEdges;
		history.clear();
		_editVersion = 0;
		_savedVersion = 0;
		selectedNodeId = null;
		selectedEdgeId = null;
	}

	function markSaved() {
		_savedVersion = _editVersion;
	}

	function clearAll() {
		pushHistory();
		nodes = [];
		edges = [];
		selectedNodeId = null;
		selectedEdgeId = null;
	}

	return {
		// Canvas state (getters/setters for reactivity)
		get nodes() { return nodes; },
		set nodes(v) { nodes = v; },
		get edges() { return edges; },
		set edges(v) { edges = v; },
		get selectedNodeId() { return selectedNodeId; },
		set selectedNodeId(v) { selectedNodeId = v; },
		get selectedEdgeId() { return selectedEdgeId; },
		set selectedEdgeId(v) { selectedEdgeId = v; },

		// Metadata
		get workflowId() { return workflowId; },
		get workflowName() { return workflowName; },
		set workflowName(v) { workflowName = v; _editVersion++; },
		get isSaving() { return isSaving; },
		set isSaving(v) { isSaving = v; },
		get isLoading() { return isLoading; },
		set isLoading(v) { isLoading = v; },
		get isDirty() { return isDirty; },
		set isDirty(v) {
			// Legacy compat: setting isDirty = false marks as saved
			if (!v) _savedVersion = _editVersion;
			else _editVersion++;
		},
		get publishedRuntime() { return publishedRuntime; },
		set publishedRuntime(v) { publishedRuntime = v; },

		// Execution
		get currentRunningNodeId() { return currentRunningNodeId; },
		set currentRunningNodeId(v) { currentRunningNodeId = v; },
		get selectedExecutionId() { return selectedExecutionId; },
		set selectedExecutionId(v) { selectedExecutionId = v; },

		// UI
		get activeConfigTab() { return activeConfigTab; },
		set activeConfigTab(v) { activeConfigTab = v; },
		get showMinimap() { return showMinimap; },
		set showMinimap(v) { showMinimap = v; },
		get showRunsPanel() { return showRunsPanel; },
		set showRunsPanel(v) { showRunsPanel = v; },

		// Derived
		get selectedNode() { return selectedNode; },
		get canUndo() { return history.canUndo; },
		get canRedo() { return history.canRedo; },
		get nodeCount() { return nodeCount; },

		// History
		history,

		// Methods
		pushHistory,
		undo,
		redo,
		addNode,
		removeNode,
		updateNodeData,
		updateNodeStatus,
		addEdge,
		removeEdge,
		insertNodeOnEdge,
		getSelectedNodes,
		getSelectedEdges,
		loadWorkflow,
		markSaved,
		clearAll
	};
}
