import { describe, expect, it } from "vitest";
import { buildWorkflowRuntimeGraph } from "./workflow-runtime-graph";
import type {
	WorkflowEdge,
	WorkflowNode,
	WorkflowNodeType,
} from "./workflow-store";
import type { DaprExecutionEvent } from "./types/workflow-ui";

function createNode(
	id: string,
	type: WorkflowNodeType,
	label = id,
	position = { x: 0, y: 0 },
): WorkflowNode {
	return {
		id,
		type,
		position,
		data: {
			label,
			type,
			config: {},
			status: "idle",
		},
	};
}

function createEdge(
	id: string,
	source: string,
	target: string,
	sourceHandle?: string,
): WorkflowEdge {
	return {
		id,
		source,
		target,
		sourceHandle,
		type: "animated",
	};
}

function createEvent(input: Partial<DaprExecutionEvent>): DaprExecutionEvent {
	return {
		eventId: input.eventId ?? 1,
		eventType: input.eventType ?? "TaskScheduled",
		name: input.name ?? null,
		timestamp: input.timestamp ?? new Date().toISOString(),
		input: input.input,
		output: input.output,
		metadata: input.metadata,
	};
}

describe("buildWorkflowRuntimeGraph", () => {
	it("projects runtime node and edge statuses onto the saved workflow definition", () => {
		const nodes = [
			createNode("trigger", "trigger", "Trigger"),
			createNode("fetch", "action", "Fetch Data"),
			createNode("branch", "if-else", "Check Result"),
			createNode("success", "note", "Success Path"),
			createNode("failure", "set-state", "Failure Path"),
		];
		const edges = [
			createEdge("e1", "trigger", "fetch"),
			createEdge("e2", "fetch", "branch"),
			createEdge("e3", "branch", "success", "true"),
			createEdge("e4", "branch", "failure", "false"),
		];

		const history = [
			createEvent({
				eventId: 1,
				eventType: "TaskCompleted",
				name: "Fetch Data",
				timestamp: "2026-03-11T10:00:00.000Z",
				metadata: {
					nodeId: "fetch",
					status: "success",
					nodeName: "Fetch Data",
				},
			}),
			createEvent({
				eventId: 2,
				eventType: "TaskScheduled",
				name: "Check Result",
				timestamp: "2026-03-11T10:00:01.000Z",
				metadata: {
					nodeId: "branch",
					status: "running",
					nodeName: "Check Result",
				},
			}),
		];

		const graph = buildWorkflowRuntimeGraph({
			nodes,
			edges,
			executionHistory: history,
			daprStatus: {
				runtimeStatus: "RUNNING",
				currentNodeId: "branch",
				currentNodeName: "Check Result",
				message: "Executing branch",
			},
		});

		expect(graph.source).toBe("definition+runtime");
		expect(graph.layout).toBe("auto");
		expect(graph.nodes).toHaveLength(5);

		const fetchNode = graph.nodes.find((node) => node.id === "fetch");
		const branchNode = graph.nodes.find((node) => node.id === "branch");
		const successEdge = graph.edges.find((edge) => edge.id === "e3");
		const fetchEdge = graph.edges.find((edge) => edge.id === "e2");

		expect(fetchNode?.data.status).toBe("success");
		expect(branchNode?.data.status).toBe("running");
		expect(branchNode?.data.isCurrent).toBe(true);
		expect(fetchEdge?.status).toBe("active");
		expect(successEdge?.label).toBe("True");
	});

	it("marks failed current nodes with the runtime error", () => {
		const graph = buildWorkflowRuntimeGraph({
			nodes: [createNode("trigger", "trigger"), createNode("step", "action")],
			edges: [createEdge("e1", "trigger", "step")],
			executionHistory: [],
			daprStatus: {
				runtimeStatus: "FAILED",
				currentNodeId: "step",
				currentNodeName: "step",
				error: "HTTP request failed",
			},
		});

		const stepNode = graph.nodes.find((node) => node.id === "step");
		expect(stepNode?.data.status).toBe("error");
		expect(stepNode?.data.error).toBe("HTTP request failed");
	});
});
