import type {
	WorkflowEdge,
	WorkflowNode,
	WorkflowNodeType,
} from "@/lib/workflow-store";
import { describe, expect, it } from "vitest";
import { layoutWorkflowNodes } from "./dagre-layout";

function createNode(
	id: string,
	type: WorkflowNodeType = "action",
	position: { x: number; y: number } = { x: 0, y: 0 },
): WorkflowNode {
	return {
		id,
		type,
		position,
		data: {
			label: id,
			type,
			status: "idle",
			config: {},
		},
	};
}

function createEdge(id: string, source: string, target: string): WorkflowEdge {
	return {
		id,
		source,
		target,
		type: "animated",
	};
}

describe("layoutWorkflowNodes", () => {
	it("wraps sequential chains into multiple rows in auto mode", () => {
		const nodes = [
			createNode("n1", "trigger"),
			createNode("n2"),
			createNode("n3"),
			createNode("n4"),
			createNode("n5"),
		];
		const edges = [
			createEdge("e1", "n1", "n2"),
			createEdge("e2", "n2", "n3"),
			createEdge("e3", "n3", "n4"),
			createEdge("e4", "n4", "n5"),
		];

		const arranged = layoutWorkflowNodes(nodes, edges, {
			strategy: "auto",
			viewportWidth: 2000,
			maxColumns: 3,
		});
		const uniqueY = new Set(arranged.map((node) => node.position.y));

		expect(uniqueY.size).toBeGreaterThan(1);
	});

	it("lays out a linear graph left-to-right", () => {
		const nodes = [
			createNode("trigger", "trigger"),
			createNode("step-1"),
			createNode("step-2"),
		];
		const edges = [
			createEdge("e1", "trigger", "step-1"),
			createEdge("e2", "step-1", "step-2"),
		];

		const arranged = layoutWorkflowNodes(nodes, edges, {
			direction: "LR",
			strategy: "dagre",
		});
		const trigger = arranged.find((node) => node.id === "trigger");
		const step1 = arranged.find((node) => node.id === "step-1");
		const step2 = arranged.find((node) => node.id === "step-2");

		expect(trigger).toBeDefined();
		expect(step1).toBeDefined();
		expect(step2).toBeDefined();
		expect(step1?.position.x).toBeGreaterThan(trigger?.position.x ?? 0);
		expect(step2?.position.x).toBeGreaterThan(step1?.position.x ?? 0);
	});

	it("separates branches for a forked graph", () => {
		const nodes = [
			createNode("trigger", "trigger"),
			createNode("if-1", "if-else"),
			createNode("true-branch"),
			createNode("false-branch"),
		];
		const edges = [
			createEdge("e1", "trigger", "if-1"),
			createEdge("e2", "if-1", "true-branch"),
			createEdge("e3", "if-1", "false-branch"),
		];

		const arranged = layoutWorkflowNodes(nodes, edges, {
			direction: "LR",
			strategy: "dagre",
		});
		const trueBranch = arranged.find((node) => node.id === "true-branch");
		const falseBranch = arranged.find((node) => node.id === "false-branch");

		expect(trueBranch).toBeDefined();
		expect(falseBranch).toBeDefined();
		expect(trueBranch?.position.y).not.toBe(falseBranch?.position.y);
	});

	it("ignores placeholder add nodes and keeps their positions unchanged", () => {
		const nodes = [
			createNode("trigger", "trigger"),
			createNode("step-1"),
			createNode("add-node", "add", { x: 999, y: 888 }),
		];
		const edges = [createEdge("e1", "trigger", "step-1")];

		const arranged = layoutWorkflowNodes(nodes, edges, {
			direction: "LR",
			strategy: "dagre",
		});
		const addNode = arranged.find((node) => node.id === "add-node");

		expect(addNode).toBeDefined();
		expect(addNode?.position).toEqual({ x: 999, y: 888 });
	});

	it("handles edges with missing endpoints without throwing", () => {
		const nodes = [createNode("trigger", "trigger"), createNode("step-1")];
		const edges = [
			createEdge("e1", "trigger", "step-1"),
			createEdge("missing-source", "ghost", "step-1"),
			createEdge("missing-target", "step-1", "ghost"),
		];

		const arranged = layoutWorkflowNodes(nodes, edges, {
			direction: "LR",
			strategy: "dagre",
		});
		expect(arranged).toHaveLength(2);
		expect(arranged.some((node) => Number.isFinite(node.position.x))).toBe(
			true,
		);
		expect(arranged.some((node) => Number.isFinite(node.position.y))).toBe(
			true,
		);
	});

	it("produces deterministic output for the same input", () => {
		const nodes = [
			createNode("trigger", "trigger"),
			createNode("step-a"),
			createNode("step-b"),
			createNode("step-c"),
		];
		const edges = [
			createEdge("e1", "trigger", "step-a"),
			createEdge("e2", "trigger", "step-b"),
			createEdge("e3", "step-a", "step-c"),
			createEdge("e4", "step-b", "step-c"),
		];

		const first = layoutWorkflowNodes(nodes, edges, {
			direction: "LR",
			strategy: "dagre",
		});
		const second = layoutWorkflowNodes(nodes, edges, {
			direction: "LR",
			strategy: "dagre",
		});

		expect(first).toEqual(second);
	});
});
