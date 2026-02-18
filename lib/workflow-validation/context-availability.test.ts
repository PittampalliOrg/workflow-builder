import { describe, expect, it } from "vitest";
import type { WorkflowEdge, WorkflowNode } from "@/lib/workflow-store";
import { buildWorkflowContextAvailability } from "./context-availability";

function makeNode(input: {
	id: string;
	type: WorkflowNode["type"];
	label?: string;
	config?: Record<string, unknown>;
}): WorkflowNode {
	return {
		id: input.id,
		type: input.type,
		position: { x: 0, y: 0 },
		data: {
			label: input.label || input.id,
			type: input.type,
			config: input.config || {},
		},
	} as WorkflowNode;
}

function makeEdge(input: {
	id: string;
	source: string;
	target: string;
}): WorkflowEdge {
	return {
		id: input.id,
		source: input.source,
		target: input.target,
		type: "animated",
	} as WorkflowEdge;
}

describe("buildWorkflowContextAvailability", () => {
	it("computes upstream availability and state keys", () => {
		const nodes = [
			makeNode({ id: "trigger", type: "trigger", label: "Trigger" }),
			makeNode({ id: "a", type: "action", label: "A" }),
			makeNode({ id: "b", type: "action", label: "B" }),
			makeNode({ id: "c", type: "action", label: "C" }),
			makeNode({
				id: "state-1",
				type: "set-state",
				label: "Set State",
				config: {
					entries: [
						{ key: "customerId", value: "123" },
						{ key: "status", value: "new" },
					],
				},
			}),
			makeNode({
				id: "state-2",
				type: "set-state",
				label: "Set State 2",
				config: {
					key: "customerId",
					value: "456",
				},
			}),
		];
		const edges = [
			makeEdge({ id: "e1", source: "trigger", target: "a" }),
			makeEdge({ id: "e2", source: "trigger", target: "b" }),
			makeEdge({ id: "e3", source: "a", target: "c" }),
			makeEdge({ id: "e4", source: "b", target: "c" }),
		] satisfies WorkflowEdge[];

		const context = buildWorkflowContextAvailability(nodes, edges);
		const cContext = context.c;
		expect(cContext).toBeDefined();
		expect(cContext.stateKeys).toEqual(["customerId", "status"]);

		const upstreamById = new Map(
			cContext.upstreamNodes.map((entry) => [entry.nodeId, entry]),
		);
		expect(upstreamById.get("trigger")?.availability).toBe("always");
		expect(upstreamById.get("a")?.availability).toBe("maybe");
		expect(upstreamById.get("b")?.availability).toBe("maybe");
	});
});
