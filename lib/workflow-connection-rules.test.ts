import type { Connection } from "@xyflow/react";
import { describe, expect, it } from "vitest";
import type {
	WorkflowEdge,
	WorkflowNode,
	WorkflowNodeType,
} from "@/lib/workflow-store";
import {
	areHandleTypesCompatible,
	getConnectionRulesForEdge,
	getWorkflowHandleRule,
	isHandleAtConnectionLimit,
} from "./workflow-connection-rules";

function createNode(id: string, type: WorkflowNodeType): WorkflowNode {
	return {
		id,
		type,
		position: { x: 0, y: 0 },
		data: {
			label: id,
			type,
			status: "idle",
			config: {},
		},
	};
}

function createEdge(
	id: string,
	source: string,
	target: string,
	handles?: { sourceHandle?: string | null; targetHandle?: string | null },
): WorkflowEdge {
	return {
		id,
		source,
		target,
		type: "animated",
		...(handles?.sourceHandle ? { sourceHandle: handles.sourceHandle } : {}),
		...(handles?.targetHandle ? { targetHandle: handles.targetHandle } : {}),
	};
}

describe("workflow-connection-rules", () => {
	it("returns default and specific handle rules", () => {
		const triggerRule = getWorkflowHandleRule({
			nodeType: "trigger",
			handleType: "source",
		});
		expect(triggerRule.maxConnections).toBe(1);
		expect(triggerRule.label).toBe("next");

		const trueBranchRule = getWorkflowHandleRule({
			nodeType: "if-else",
			handleType: "source",
			handleId: "true",
		});
		expect(trueBranchRule.dataType).toBe("branch");
		expect(trueBranchRule.maxConnections).toBe(1);
	});

	it("checks handle data type compatibility", () => {
		const controlTarget = getWorkflowHandleRule({
			nodeType: "action",
			handleType: "target",
		});

		expect(areHandleTypesCompatible("control", controlTarget)).toBe(true);
		expect(areHandleTypesCompatible("branch", controlTarget)).toBe(true);
		expect(areHandleTypesCompatible("any", controlTarget)).toBe(true);
	});

	it("detects source handle connection limits", () => {
		const edges = [createEdge("e1", "trigger", "a1")];
		const triggerSourceRule = getWorkflowHandleRule({
			nodeType: "trigger",
			handleType: "source",
		});

		expect(
			isHandleAtConnectionLimit({
				edges,
				nodeId: "trigger",
				handleType: "source",
				rule: triggerSourceRule,
			}),
		).toBe(true);
	});

	it("builds connection rules from nodes and a connection", () => {
		const nodes = [createNode("if1", "if-else"), createNode("a1", "action")];
		const connection: Connection = {
			source: "if1",
			target: "a1",
			sourceHandle: "true",
			targetHandle: null,
		};

		const result = getConnectionRulesForEdge({ nodes, connection });
		expect(result).not.toBeNull();
		expect(result?.sourceRule.dataType).toBe("branch");
	});
});
