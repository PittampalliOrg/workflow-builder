import { compileGraphToWorkflow } from "./compile";
import { decompileWorkflowToGraph } from "./decompile";
import { buildUseFunctions, getCatalogFunction } from "./function-catalog";
import { isWorkflowDefinition, normalizeWorkflowDefinition } from "./sdk";
import type { McpInputProperty } from "@/lib/mcp/types";
import {
	getTaskType,
	SW_DSL_VERSION,
	type TaskItem,
	type Workflow,
} from "./types";
import type { WorkflowEdge, WorkflowNode } from "@/lib/workflow-store";

export const SUPPORTED_WORKFLOW_ID = "vajlzrprpie7fvco6ibhi" as const;
export const SUPPORTED_WORKFLOW_NAME =
	"Resolve Issue (Dapr SWE Agents)" as const;
export const SW_SPEC_VERSION = `sw-${SW_DSL_VERSION}` as const;
export const SUPPORTED_WORKFLOW_RUN_INPUT_FIELDS: McpInputProperty[] = [
	{
		name: "owner",
		type: "TEXT",
		required: true,
		description: "GitHub owner or organization for the repository.",
	},
	{
		name: "repo",
		type: "TEXT",
		required: true,
		description: "GitHub repository name to inspect and update.",
	},
	{
		name: "issue_number",
		type: "NUMBER",
		required: true,
		description: "Issue number to resolve in the target repository.",
	},
	{
		name: "title",
		type: "TEXT",
		required: true,
		description:
			"Short run title used for the execution and downstream PR context.",
	},
	{
		name: "body",
		type: "TEXT",
		required: true,
		description:
			"Detailed task description for the agent. Include the requested change or bug fix here.",
	},
	{
		name: "sender",
		type: "TEXT",
		required: false,
		description: "Optional requester identity or email for audit context.",
	},
];

export function isSupportedWorkflowId(workflowId: string): boolean {
	return workflowId === SUPPORTED_WORKFLOW_ID;
}

export function getSupportedWorkflowRunInputFields(
	workflowId: string | null | undefined,
): McpInputProperty[] {
	if (!workflowId || !isSupportedWorkflowId(workflowId)) {
		return [];
	}
	return SUPPORTED_WORKFLOW_RUN_INPUT_FIELDS;
}

export function validateSupportedWorkflowTriggerInput(
	input: Record<string, unknown>,
): string[] {
	const issues: string[] = [];
	const requiredStringFields = ["owner", "repo", "title", "body"] as const;
	for (const field of requiredStringFields) {
		const value = input[field];
		if (typeof value !== "string" || !value.trim()) {
			issues.push(`Missing required input field: ${field}`);
		}
	}

	const issueNumber = input.issue_number;
	if (
		typeof issueNumber !== "number" &&
		!(typeof issueNumber === "string" && issueNumber.trim())
	) {
		issues.push("Missing required input field: issue_number");
	}

	return issues;
}

export function isSwWorkflowDocument(spec: unknown): spec is Workflow {
	return isWorkflowDefinition(spec);
}

function sanitizeDocumentName(name: string): string {
	const sanitized = name
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9_-]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return sanitized || "resolve-issue-dapr-swe-agents";
}

function asRecord(value: unknown): Record<string, unknown> | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return null;
	}
	return value as Record<string, unknown>;
}

function deepCloneWorkflow(spec: Workflow): Workflow {
	return JSON.parse(JSON.stringify(spec)) as Workflow;
}

function jsonEquals(left: unknown, right: unknown): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

function collectReferencedFunctions(
	tasks: TaskItem[],
	result = new Set<string>(),
) {
	for (const item of tasks) {
		const [taskName, task] = Object.entries(item)[0] ?? [];
		if (!taskName || !task || typeof task !== "object") {
			continue;
		}
		const taskRecord = task as unknown as Record<string, unknown>;
		let taskType: ReturnType<typeof getTaskType>;
		try {
			taskType = getTaskType(taskRecord as never);
		} catch {
			continue;
		}
		if (taskType === "call") {
			const callName =
				typeof taskRecord.call === "string" ? taskRecord.call.trim() : "";
			if (
				callName &&
				!["http", "grpc", "openapi", "asyncapi"].includes(callName) &&
				getCatalogFunction(callName)
			) {
				result.add(callName);
			}
		}
		if (taskType === "do" && Array.isArray(taskRecord.do)) {
			collectReferencedFunctions(taskRecord.do as TaskItem[], result);
		}
		if (taskType === "for" && Array.isArray(taskRecord.do)) {
			collectReferencedFunctions(taskRecord.do as TaskItem[], result);
		}
		if (taskType === "try") {
			if (Array.isArray(taskRecord.try)) {
				collectReferencedFunctions(taskRecord.try as TaskItem[], result);
			}
			const catchConfig =
				taskRecord.catch &&
				typeof taskRecord.catch === "object" &&
				!Array.isArray(taskRecord.catch)
					? (taskRecord.catch as Record<string, unknown>)
					: null;
			if (catchConfig && Array.isArray(catchConfig.do)) {
				collectReferencedFunctions(catchConfig.do as TaskItem[], result);
			}
		}
		if (taskType === "fork") {
			const forkConfig =
				taskRecord.fork &&
				typeof taskRecord.fork === "object" &&
				!Array.isArray(taskRecord.fork)
					? (taskRecord.fork as Record<string, unknown>)
					: null;
			if (forkConfig && Array.isArray(forkConfig.branches)) {
				collectReferencedFunctions(forkConfig.branches as TaskItem[], result);
			}
		}
	}
	return result;
}

function hydrateUseFunctions(spec: Workflow): Workflow {
	const functionNames = Array.from(collectReferencedFunctions(spec.do ?? []));
	if (functionNames.length === 0) {
		return spec;
	}
	return {
		...spec,
		use: {
			...((spec.use ?? {}) as Record<string, unknown>),
			functions: {
				...((spec.use?.functions ?? {}) as Record<string, unknown>),
				...buildUseFunctions(functionNames),
			},
		} as never,
	};
}

export function normalizeWorkflowToSwCutover(input: {
	name: string;
	description?: string | null;
	nodes: WorkflowNode[];
	edges: WorkflowEdge[];
	spec?: unknown;
	specVersion?: string | null;
}): {
	spec: Workflow;
	specVersion: typeof SW_SPEC_VERSION;
	nodes: WorkflowNode[];
	edges: WorkflowEdge[];
	needsMigration: boolean;
} {
	const metadata = asRecord(asRecord(input.spec)?.metadata);

	const spec = isSwWorkflowDocument(input.spec)
		? deepCloneWorkflow(input.spec)
		: compileGraphToWorkflow(
				{
					nodes: input.nodes as never,
					edges: input.edges as never,
				},
				{
					namespace: "dapr-swe",
					name: sanitizeDocumentName(input.name),
					title: input.name,
					summary: input.description || undefined,
				},
			);

	const nextSpec = {
		...spec,
		document: {
			...spec.document,
			dsl: SW_DSL_VERSION,
			namespace: spec.document.namespace || "dapr-swe",
			name: sanitizeDocumentName(input.name),
			version: spec.document.version || "0.0.1",
			title: input.name,
			...(input.description ? { summary: input.description } : {}),
		},
	} as Workflow;

	if (!input.description) {
		delete nextSpec.document.summary;
	}

	if (metadata) {
		nextSpec.metadata = {
			...(asRecord(nextSpec.metadata) ?? {}),
			...metadata,
		};
	}

	const normalizedSpec = normalizeWorkflowDefinition(
		hydrateUseFunctions(nextSpec),
	) as unknown as Workflow;
	const graph = decompileWorkflowToGraph(normalizedSpec);
	const needsMigration =
		!isSwWorkflowDocument(input.spec) ||
		input.specVersion !== SW_SPEC_VERSION ||
		!jsonEquals(input.nodes, graph.nodes) ||
		!jsonEquals(input.edges, graph.edges) ||
		!jsonEquals(input.spec, normalizedSpec);

	return {
		spec: normalizedSpec as Workflow,
		specVersion: SW_SPEC_VERSION,
		nodes: graph.nodes as unknown as WorkflowNode[],
		edges: graph.edges as unknown as WorkflowEdge[],
		needsMigration,
	};
}
