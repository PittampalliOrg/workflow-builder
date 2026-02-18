import { decompileGraphToWorkflowSpec } from "@/lib/workflow-spec/decompile";
import { lintWorkflowSpec, type LintIssue } from "@/lib/workflow-spec/lint";
import type { WorkflowSpecCatalog } from "@/lib/workflow-spec/catalog";
import type { WorkflowEdge, WorkflowNode } from "@/lib/workflow-store";
import { buildWorkflowContextAvailability } from "./context-availability";
import type {
	ContractIssue,
	ContractIssueCode,
	ContractIssueSeverity,
	EdgeValidationState,
	WorkflowValidationSnapshot,
} from "./types";
import type {
	WorkflowTableEdge,
	WorkflowTableNode,
} from "@/lib/workflow-spec/compile";

type ValidateWorkflowGraphInput = {
	nodes: WorkflowNode[];
	edges: WorkflowEdge[];
	catalog?: WorkflowSpecCatalog;
};

function normalizeIssueCode(code: string): ContractIssueCode {
	switch (code) {
		case "BROKEN_REFERENCE":
		case "NON_UPSTREAM_REFERENCE":
		case "MAYBE_UNSET_REFERENCE":
		case "UNKNOWN_OUTPUT_FIELD":
		case "UNKNOWN_ACTION_TYPE":
			return code;
		default:
			return "OTHER";
	}
}

function toContractIssue(
	issue: LintIssue,
	severity: ContractIssueSeverity,
): ContractIssue {
	return {
		code: normalizeIssueCode(issue.code),
		severity,
		message: issue.message,
		path: issue.path,
		nodeId: issue.nodeId,
	};
}

function buildIssuesByNodeId(issues: ContractIssue[]) {
	const byNodeId: Record<string, ContractIssue[]> = {};
	for (const issue of issues) {
		if (!issue.nodeId) {
			continue;
		}
		if (!byNodeId[issue.nodeId]) {
			byNodeId[issue.nodeId] = [];
		}
		byNodeId[issue.nodeId].push(issue);
	}
	return byNodeId;
}

function isErrorIssue(issue: ContractIssue): boolean {
	return issue.severity === "error";
}

function buildEdgeStates(
	edges: WorkflowEdge[],
	issuesByNodeId: Record<string, ContractIssue[]>,
): Record<string, EdgeValidationState> {
	const edgeStates: Record<string, EdgeValidationState> = {};

	for (const edge of edges) {
		const sourceIssues = issuesByNodeId[edge.source] ?? [];
		const targetIssues = issuesByNodeId[edge.target] ?? [];
		const allNodeIssues = [...sourceIssues, ...targetIssues];

		if (allNodeIssues.some(isErrorIssue)) {
			edgeStates[edge.id] = "invalid";
			continue;
		}

		if (allNodeIssues.length > 0) {
			edgeStates[edge.id] = "warning";
			continue;
		}

		edgeStates[edge.id] = "valid";
	}

	return edgeStates;
}

function sanitizeGraph(nodes: WorkflowNode[], edges: WorkflowEdge[]) {
	const filteredNodes = nodes.filter((node) => node.type !== "add");
	const nodeIds = new Set(filteredNodes.map((node) => node.id));
	const filteredEdges = edges.filter(
		(edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target),
	);
	return { filteredNodes, filteredEdges };
}

function toWorkflowTableNode(node: WorkflowNode): WorkflowTableNode {
	return {
		id: node.id,
		type: String(node.type ?? node.data.type ?? "action"),
		position: node.position,
		data: {
			label: node.data.label || node.id,
			description: node.data.description,
			type: String(node.data.type ?? node.type ?? "action"),
			config: (node.data.config as Record<string, unknown> | undefined) || {},
			status: node.data.status,
			enabled: node.data.enabled,
		},
	};
}

function toWorkflowTableEdge(edge: WorkflowEdge): WorkflowTableEdge {
	return {
		id: edge.id,
		source: edge.source,
		target: edge.target,
		sourceHandle: edge.sourceHandle,
		targetHandle: edge.targetHandle,
		type: edge.type,
	};
}

export function validateWorkflowGraph(
	input: ValidateWorkflowGraphInput,
): WorkflowValidationSnapshot {
	const { filteredNodes, filteredEdges } = sanitizeGraph(
		input.nodes,
		input.edges,
	);
	const availableContextByNodeId = buildWorkflowContextAvailability(
		filteredNodes,
		filteredEdges,
	);

	if (filteredNodes.length === 0) {
		return {
			issues: [],
			issuesByNodeId: {},
			edgeStates: {},
			availableContextByNodeId,
		};
	}

	const spec = decompileGraphToWorkflowSpec({
		name: "Workflow",
		nodes: filteredNodes.map(toWorkflowTableNode),
		edges: filteredEdges.map(toWorkflowTableEdge),
	});
	const lintResult = lintWorkflowSpec(spec, {
		catalog: input.catalog,
		unknownActionType: "warn",
	});

	const issues = [
		...lintResult.result.errors.map((issue) => toContractIssue(issue, "error")),
		...lintResult.result.warnings.map((issue) =>
			toContractIssue(issue, "warning"),
		),
	];
	const issuesByNodeId = buildIssuesByNodeId(issues);
	const edgeStates = buildEdgeStates(filteredEdges, issuesByNodeId);

	return {
		issues,
		issuesByNodeId,
		edgeStates,
		availableContextByNodeId,
	};
}
