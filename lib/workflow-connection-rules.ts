import type {
	Connection as XYFlowConnection,
	Edge as XYFlowEdge,
} from "@xyflow/react";
import type {
	WorkflowEdge,
	WorkflowNode,
	WorkflowNodeType,
} from "@/lib/workflow-store";

export type WorkflowHandleDataType = "any" | "control" | "branch";

export type WorkflowHandleRule = {
	label?: string;
	dataType: WorkflowHandleDataType;
	accepts?: WorkflowHandleDataType[];
	maxConnections?: number;
};

type NodeHandleRuleConfig = {
	defaultSource?: Partial<WorkflowHandleRule>;
	defaultTarget?: Partial<WorkflowHandleRule>;
	sources?: Record<string, Partial<WorkflowHandleRule>>;
	targets?: Record<string, Partial<WorkflowHandleRule>>;
};

const DEFAULT_SOURCE_RULE: WorkflowHandleRule = {
	dataType: "control",
};

const DEFAULT_TARGET_RULE: WorkflowHandleRule = {
	dataType: "control",
	accepts: ["control", "branch", "any"],
};

const NODE_HANDLE_RULES: Partial<
	Record<WorkflowNodeType, NodeHandleRuleConfig>
> = {
	trigger: {
		defaultSource: {
			label: "next",
			maxConnections: 1,
		},
	},
	"if-else": {
		defaultTarget: {
			label: "input",
			accepts: ["control", "branch", "any"],
		},
		sources: {
			true: {
				label: "true",
				dataType: "branch",
				maxConnections: 1,
			},
			false: {
				label: "false",
				dataType: "branch",
				maxConnections: 1,
			},
		},
	},
	while: {
		defaultSource: {
			label: "loop",
			maxConnections: 1,
		},
		defaultTarget: {
			label: "in",
		},
	},
};

function mergeRule(
	base: WorkflowHandleRule,
	override?: Partial<WorkflowHandleRule>,
): WorkflowHandleRule {
	return {
		...base,
		...override,
		accepts: override?.accepts ?? base.accepts,
	};
}

export function getWorkflowHandleRule(input: {
	nodeType?: WorkflowNodeType | null;
	handleType: "source" | "target";
	handleId?: string | null;
}): WorkflowHandleRule {
	const { nodeType, handleType, handleId } = input;
	const config = nodeType ? NODE_HANDLE_RULES[nodeType] : undefined;
	const normalizedHandleId = handleId ?? "default";

	if (handleType === "source") {
		const base = mergeRule(DEFAULT_SOURCE_RULE, config?.defaultSource);
		const specific = config?.sources?.[normalizedHandleId];
		return mergeRule(base, specific);
	}

	const base = mergeRule(DEFAULT_TARGET_RULE, config?.defaultTarget);
	const specific = config?.targets?.[normalizedHandleId];
	return mergeRule(base, specific);
}

export function areHandleTypesCompatible(
	sourceType: WorkflowHandleDataType,
	targetRule: WorkflowHandleRule,
): boolean {
	if (sourceType === "any" || targetRule.dataType === "any") {
		return true;
	}
	if (sourceType === targetRule.dataType) {
		return true;
	}
	const accepts = targetRule.accepts ?? [targetRule.dataType];
	return accepts.includes(sourceType);
}

function countHandleConnections(input: {
	edges: WorkflowEdge[];
	nodeId: string;
	handleType: "source" | "target";
	handleId?: string | null;
}): number {
	const { edges, nodeId, handleType, handleId } = input;
	const normalized = handleId ?? null;

	if (handleType === "source") {
		return edges.filter(
			(edge) =>
				edge.source === nodeId && (edge.sourceHandle ?? null) === normalized,
		).length;
	}

	return edges.filter(
		(edge) =>
			edge.target === nodeId && (edge.targetHandle ?? null) === normalized,
	).length;
}

export function isHandleAtConnectionLimit(input: {
	edges: WorkflowEdge[];
	nodeId: string;
	handleType: "source" | "target";
	handleId?: string | null;
	rule: WorkflowHandleRule;
}): boolean {
	const { edges, nodeId, handleType, handleId, rule } = input;
	if (typeof rule.maxConnections !== "number") {
		return false;
	}

	return (
		countHandleConnections({
			edges,
			nodeId,
			handleType,
			handleId,
		}) >= rule.maxConnections
	);
}

export function getConnectionRulesForEdge(input: {
	nodes: WorkflowNode[];
	connection: XYFlowConnection | XYFlowEdge;
}) {
	const { nodes, connection } = input;
	if (!(connection.source && connection.target)) {
		return null;
	}

	const sourceNode = nodes.find((node) => node.id === connection.source);
	const targetNode = nodes.find((node) => node.id === connection.target);
	if (!(sourceNode && targetNode)) {
		return null;
	}

	const sourceRule = getWorkflowHandleRule({
		nodeType: sourceNode.type as WorkflowNodeType,
		handleType: "source",
		handleId: connection.sourceHandle,
	});
	const targetRule = getWorkflowHandleRule({
		nodeType: targetNode.type as WorkflowNodeType,
		handleType: "target",
		handleId: connection.targetHandle,
	});

	return {
		sourceNode,
		targetNode,
		sourceRule,
		targetRule,
	};
}
