export type WorkflowGraphNodeStatus =
	| "idle"
	| "running"
	| "success"
	| "error"
	| "waiting";

export type WorkflowGraphEdgeStatus = "idle" | "active" | "traversed";

export type WorkflowGraphNodeData = {
	label: string;
	description?: string;
	type: string;
	config?: Record<string, unknown>;
	enabled?: boolean;
	status: WorkflowGraphNodeStatus;
	isCurrent?: boolean;
	error?: string | null;
};

export type WorkflowGraphNode = {
	id: string;
	type: string;
	position: { x: number; y: number };
	data: WorkflowGraphNodeData;
};

export type WorkflowGraphEdge = {
	id: string;
	source: string;
	target: string;
	sourceHandle?: string | null;
	targetHandle?: string | null;
	label?: string;
	status: WorkflowGraphEdgeStatus;
};

export type WorkflowRuntimeGraph = {
	nodes: WorkflowGraphNode[];
	edges: WorkflowGraphEdge[];
	source: "definition" | "definition+runtime";
	layout: "saved" | "auto";
};
