import { describe, expect, it } from "vitest";
import {
	isSupportedWorkflowId,
	isSwWorkflowDocument,
	normalizeWorkflowToSwCutover,
	SUPPORTED_WORKFLOW_ID,
	SW_SPEC_VERSION,
} from "./cutover";
import type { WorkflowEdge, WorkflowNode } from "@/lib/workflow-store";

function buildGraph(): { nodes: WorkflowNode[]; edges: WorkflowEdge[] } {
	return {
		nodes: [
			{
				id: "__start__",
				type: "start",
				position: { x: 0, y: 0 },
				data: {
					label: "Start",
					type: "start",
					config: {},
				},
			},
			{
				id: "initialize",
				type: "call",
				position: { x: 200, y: 0 },
				data: {
					label: "Init Sandbox",
					type: "call",
					config: {
						call: "dapr-swe/initialize",
						with: {
							owner: "PittampalliOrg",
							repo: "open-swe",
							issue_number: 1,
						},
					},
				},
			},
			{
				id: "__end__",
				type: "end",
				position: { x: 400, y: 0 },
				data: {
					label: "End",
					type: "end",
					config: {},
				},
			},
		],
		edges: [
			{
				id: "__start__->initialize",
				source: "__start__",
				target: "initialize",
			},
			{
				id: "initialize->__end__",
				source: "initialize",
				target: "__end__",
			},
		],
	};
}

describe("serverless workflow cutover", () => {
	it("recognizes the single supported workflow", () => {
		expect(isSupportedWorkflowId(SUPPORTED_WORKFLOW_ID)).toBe(true);
		expect(isSupportedWorkflowId("some-other-workflow")).toBe(false);
	});

	it("normalizes a graph-backed workflow into a persisted SW 1.0 document", () => {
		const graph = buildGraph();

		const result = normalizeWorkflowToSwCutover({
			name: "Resolve Issue (Dapr SWE Agents)",
			description: "Resolve a GitHub issue with dapr-swe",
			nodes: graph.nodes,
			edges: graph.edges,
			spec: {
				apiVersion: "workflow-spec/v1",
				name: "Legacy Resolve Issue",
				trigger: {},
				steps: [],
				metadata: { publishedRuntime: { latestVersion: "pub_1" } },
			},
			specVersion: "workflow-spec/v1",
		});

		expect(result.specVersion).toBe(SW_SPEC_VERSION);
		expect(isSwWorkflowDocument(result.spec)).toBe(true);
		expect(result.spec.document.dsl).toBe("1.0.0");
		expect(result.spec.document.namespace).toBe("dapr-swe");
		expect(result.spec.document.title).toBe("Resolve Issue (Dapr SWE Agents)");
		expect(result.spec.metadata).toMatchObject({
			publishedRuntime: { latestVersion: "pub_1" },
		});
		expect(result.nodes).toHaveLength(3);
		expect(result.edges).toHaveLength(2);
		expect(result.needsMigration).toBe(true);
	});
});
