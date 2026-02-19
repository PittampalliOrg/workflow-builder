import { describe, expect, it } from "vitest";
import type {
	WorkflowEdge,
	WorkflowNode,
	WorkflowNodeType,
} from "@/lib/workflow-store";
import {
	collectSelectionForClipboard,
	parseWorkflowClipboardPayload,
	remapClipboardPayloadForPaste,
	serializeWorkflowClipboardPayload,
	WORKFLOW_CLIPBOARD_FORMAT,
	WORKFLOW_CLIPBOARD_VERSION,
} from "./workflow-clipboard";

function createNode(input: {
	id: string;
	type?: WorkflowNodeType;
	x?: number;
	y?: number;
	selected?: boolean;
	parentId?: string;
}): WorkflowNode {
	return {
		id: input.id,
		type: input.type ?? "action",
		position: { x: input.x ?? 0, y: input.y ?? 0 },
		data: {
			label: input.id,
			type: input.type ?? "action",
			config: {},
		},
		selected: input.selected ?? false,
		...(input.parentId ? { parentId: input.parentId } : {}),
	};
}

function createEdge(input: {
	id: string;
	source: string;
	target: string;
	selected?: boolean;
}): WorkflowEdge {
	return {
		id: input.id,
		source: input.source,
		target: input.target,
		selected: input.selected ?? false,
	};
}

describe("workflow clipboard", () => {
	it("collects selected nodes and only internal edges", () => {
		const nodes = [
			createNode({ id: "trigger", type: "trigger" }),
			createNode({ id: "a", selected: true }),
			createNode({ id: "b", selected: true }),
			createNode({ id: "c" }),
		];
		const edges = [
			createEdge({ id: "a-b", source: "a", target: "b" }),
			createEdge({ id: "a-c", source: "a", target: "c" }),
		];

		const payload = collectSelectionForClipboard(nodes, edges);

		expect(payload).not.toBeNull();
		expect(payload?.nodes.map((node) => node.id).sort()).toEqual(["a", "b"]);
		expect(payload?.edges.map((edge) => edge.id)).toEqual(["a-b"]);
		expect(payload?.format).toBe(WORKFLOW_CLIPBOARD_FORMAT);
		expect(payload?.version).toBe(WORKFLOW_CLIPBOARD_VERSION);
	});

	it("normalizes copied node positions to absolute coordinates", () => {
		const nodes = [
			createNode({ id: "group-1", type: "group", x: 100, y: 200 }),
			createNode({
				id: "inside",
				x: 40,
				y: 60,
				parentId: "group-1",
				selected: true,
			}),
		];
		const payload = collectSelectionForClipboard(nodes, []);

		expect(payload?.nodes[0]?.parentId).toBeUndefined();
		expect(payload?.nodes[0]?.position).toEqual({ x: 140, y: 260 });
	});

	it("serializes and parses clipboard payload", () => {
		const payload = collectSelectionForClipboard(
			[createNode({ id: "a", selected: true })],
			[],
		);
		expect(payload).not.toBeNull();

		const text = serializeWorkflowClipboardPayload(payload!);
		const parsed = parseWorkflowClipboardPayload(text);

		expect(parsed).not.toBeNull();
		expect(parsed?.nodes[0]?.id).toBe("a");
	});

	it("remaps ids and offsets pasted positions", () => {
		const payload = collectSelectionForClipboard(
			[
				createNode({ id: "a", x: 10, y: 10, selected: true }),
				createNode({ id: "b", x: 60, y: 35, selected: true }),
			],
			[createEdge({ id: "a-b", source: "a", target: "b" })],
		);

		const result = remapClipboardPayloadForPaste(payload!, { x: 400, y: 300 });
		expect(result.nodes).toHaveLength(2);
		expect(result.edges).toHaveLength(1);

		const ids = result.nodes.map((node) => node.id);
		expect(ids).not.toContain("a");
		expect(ids).not.toContain("b");
		expect(result.edges[0]?.source).toBe(result.nodes[0]?.id);
		expect(result.edges[0]?.target).toBe(result.nodes[1]?.id);

		const firstNode = result.nodes.find((node) => node.position.x === 400);
		expect(firstNode?.position.y).toBe(300);
	});
});
