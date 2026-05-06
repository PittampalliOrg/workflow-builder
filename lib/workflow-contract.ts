import { buildSpecFromGraph } from "../src/lib/server/workflows/spec-builder";

type WorkflowGraphInput = {
	name: string;
	description?: string | null;
	nodes: unknown[];
	edges: unknown[];
};

export function resolveCanonicalWorkflowSpec(input: WorkflowGraphInput): {
	specVersion: string;
	spec: Record<string, unknown>;
} {
	const spec = buildSpecFromGraph(input.name, input.nodes as never, input.edges as never);
	if (input.description && typeof spec.document === "object" && spec.document) {
		(spec.document as Record<string, unknown>).description = input.description;
	}
	return { specVersion: "1.0.0", spec };
}
