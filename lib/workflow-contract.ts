import { compileWorkflowSpecToGraph } from "@/lib/workflow-spec/compile";
import { decompileGraphToWorkflowSpec } from "@/lib/workflow-spec/decompile";
import {
	type WorkflowSpec,
	WorkflowSpecSchema,
	WORKFLOW_SPEC_API_VERSION,
} from "@/lib/workflow-spec/types";
import {
	generateWorkflowDefinition,
	type WorkflowDefinition,
} from "@/lib/workflow-definition";
import type { WorkflowEdge, WorkflowNode } from "@/lib/workflow-store";
// CNCF Serverless Workflow 1.0 — types only (no heavy imports at module level)
// Full modules loaded dynamically in isSWWorkflow() and compileSWWorkflowFromGraph()

export const WORKFLOW_EXECUTION_IR_VERSION =
	"workflow-execution-ir/v1" as const;

const SUPPORTED_WORKFLOW_SPEC_NODE_KINDS = new Set([
	// Legacy custom node types
	"trigger",
	"action",
	"approval-gate",
	"timer",
	"if-else",
	"loop-until",
	"set-state",
	"transform",
	"publish-event",
	"note",
	// CNCF Serverless Workflow 1.0 task types
	"start",
	"end",
	"call",
	"set",
	"switch",
	"wait",
	"emit",
	"listen",
	"for",
	"fork",
	"try",
	"run",
	"raise",
	"do",
]);

type WorkflowSpecSource = "persisted-spec" | "derived-graph" | "legacy-graph";

export type WorkflowExecutionIR = {
	apiVersion: typeof WORKFLOW_EXECUTION_IR_VERSION;
	workflowId: string;
	name: string;
	description?: string;
	author?: string;
	source: WorkflowSpecSource;
	specVersion: string | null;
	spec: WorkflowSpec | null;
	graph: {
		nodes: WorkflowNode[];
		edges: WorkflowEdge[];
	};
	definition: WorkflowDefinition;
};

function sanitizeGraphForSpec(input: {
	nodes: WorkflowNode[];
	edges: WorkflowEdge[];
}): {
	nodes: WorkflowNode[];
	edges: WorkflowEdge[];
} {
	const nodes = input.nodes.filter(
		(node) => node.type !== "add" && node.type !== "group",
	);
	const nodeIds = new Set(nodes.map((node) => node.id));
	const edges = input.edges.filter(
		(edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target),
	);
	return { nodes, edges };
}

function toWorkflowTableNodes(nodes: WorkflowNode[]) {
	return nodes.map((node) => ({
		id: node.id,
		type: String(node.type ?? node.data?.type ?? "action"),
		position: node.position,
		data: {
			label: node.data?.label || node.id,
			description: node.data?.description,
			type: String(node.data?.type ?? node.type ?? "action"),
			config:
				(typeof node.data?.config === "object" && node.data.config !== null
					? (node.data.config as Record<string, unknown>)
					: {}) || {},
			status: node.data?.status,
			enabled: node.data?.enabled,
		},
	}));
}

function toWorkflowTableEdges(edges: WorkflowEdge[]) {
	return edges.map((edge) => ({
		id: edge.id,
		source: edge.source,
		target: edge.target,
		sourceHandle: edge.sourceHandle,
		targetHandle: edge.targetHandle,
		type: edge.type,
	}));
}

function nodeKind(node: WorkflowNode): string {
	return String(node.data?.type || node.type || "");
}

export function isGraphRepresentableByWorkflowSpec(input: {
	nodes: WorkflowNode[];
}): boolean {
	for (const node of input.nodes) {
		if (!SUPPORTED_WORKFLOW_SPEC_NODE_KINDS.has(nodeKind(node))) {
			return false;
		}
	}
	return true;
}

export function deriveWorkflowSpecFromGraph(input: {
	name: string;
	description?: string;
	nodes: WorkflowNode[];
	edges: WorkflowEdge[];
}): WorkflowSpec | null {
	const sanitized = sanitizeGraphForSpec(input);
	if (!isGraphRepresentableByWorkflowSpec({ nodes: sanitized.nodes })) {
		return null;
	}
	return decompileGraphToWorkflowSpec({
		name: input.name,
		description: input.description,
		nodes: toWorkflowTableNodes(sanitized.nodes),
		edges: toWorkflowTableEdges(sanitized.edges),
	});
}

export function resolveCanonicalWorkflowSpec(input: {
	name: string;
	description?: string;
	nodes: WorkflowNode[];
	edges: WorkflowEdge[];
	spec?: unknown;
	specVersion?: string | null;
}): {
	spec: WorkflowSpec | null;
	specVersion: string | null;
	source: WorkflowSpecSource;
} {
	const parsedSpec = WorkflowSpecSchema.safeParse(input.spec);
	if (parsedSpec.success) {
		const normalizedSpec: WorkflowSpec = {
			...parsedSpec.data,
			name: input.name,
			description: input.description,
		};
		return {
			spec: normalizedSpec,
			specVersion: parsedSpec.data.apiVersion,
			source: "persisted-spec",
		};
	}

	const derivedSpec = deriveWorkflowSpecFromGraph({
		name: input.name,
		description: input.description,
		nodes: input.nodes,
		edges: input.edges,
	});
	if (derivedSpec) {
		return {
			spec: derivedSpec,
			specVersion: WORKFLOW_SPEC_API_VERSION,
			source: "derived-graph",
		};
	}

	return {
		spec: null,
		specVersion: input.specVersion ?? null,
		source: "legacy-graph",
	};
}

/**
 * Check if a spec object is a CNCF Serverless Workflow 1.0 document.
 */
export function isSWWorkflow(spec: unknown): boolean {
	// Inline check to avoid importing the full SW types module at the top level.
	if (typeof spec !== "object" || spec === null) return false;
	const w = spec as Record<string, unknown>;
	if (typeof w.document !== "object" || w.document === null) return false;
	const doc = w.document as Record<string, unknown>;
	return doc.dsl === "1.0.0" && typeof doc.namespace === "string" && typeof doc.name === "string";
}

export function buildWorkflowExecutionIR(input: {
	workflowId: string;
	name: string;
	description?: string;
	author?: string;
	nodes: WorkflowNode[];
	edges: WorkflowEdge[];
	spec?: unknown;
	specVersion?: string | null;
}): WorkflowExecutionIR {
	// Check if the spec is a SW 1.0 document
	if (isSWWorkflow(input.spec)) {
		// SW 1.0 path: the spec IS the definition (no translation needed)
		const sanitized = sanitizeGraphForSpec({ nodes: input.nodes, edges: input.edges });
		return {
			apiVersion: WORKFLOW_EXECUTION_IR_VERSION,
			workflowId: input.workflowId,
			name: input.name,
			description: input.description,
			author: input.author,
			source: "persisted-spec",
			specVersion: "1.0.0",
			spec: null, // SW 1.0 uses its own spec format, not WorkflowSpec
			graph: sanitized,
			// For SW 1.0, the "definition" IS the SW 1.0 document itself
			definition: input.spec as unknown as WorkflowDefinition,
		};
	}

	const resolved = resolveCanonicalWorkflowSpec(input);
	const graph = resolved.spec
		? (() => {
				const compiled = compileWorkflowSpecToGraph(resolved.spec);
				return {
					nodes: compiled.nodes as unknown as WorkflowNode[],
					edges: compiled.edges as unknown as WorkflowEdge[],
				};
			})()
		: sanitizeGraphForSpec({
				nodes: input.nodes,
				edges: input.edges,
			});
	const definition = generateWorkflowDefinition(
		graph.nodes,
		graph.edges,
		input.workflowId,
		input.name,
		{
			description: input.description,
			author: input.author,
		},
	);

	return {
		apiVersion: WORKFLOW_EXECUTION_IR_VERSION,
		workflowId: input.workflowId,
		name: input.name,
		description: input.description,
		author: input.author,
		source: resolved.source,
		specVersion: resolved.specVersion,
		spec: resolved.spec,
		graph,
		definition,
	};
}
