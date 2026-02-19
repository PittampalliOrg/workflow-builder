import { describe, expect, it } from "vitest";
import type { ActionDefinition } from "@/lib/actions/types";
import type { WorkflowSpecCatalog } from "@/lib/workflow-spec/catalog";
import type { WorkflowEdge, WorkflowNode } from "@/lib/workflow-store";
import { validateWorkflowGraph } from "./validate-workflow-graph";

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

function makeAction(input: {
	id: string;
	label: string;
	outputFields?: Array<{ field: string; description: string }>;
}): ActionDefinition {
	return {
		id: input.id,
		integration: "test",
		slug: input.id.split("/")[1] || input.id,
		label: input.label,
		description: "",
		category: "Test",
		configFields: [],
		outputFields: input.outputFields,
	};
}

function makeCatalog(actions: ActionDefinition[]): WorkflowSpecCatalog {
	return {
		integrations: [],
		actionsById: new Map(actions.map((action) => [action.id, action])),
		integrationLabels: {},
	};
}

describe("validateWorkflowGraph", () => {
	it("returns warning issues for unknown trigger output fields", () => {
		const nodes = [
			makeNode({ id: "trigger", type: "trigger", label: "Trigger" }),
			makeNode({
				id: "target",
				type: "action",
				label: "Target",
				config: {
					actionType: "test/target",
					prompt: "{{@trigger:Trigger.doesNotExist}}",
				},
			}),
		] satisfies WorkflowNode[];
		const edges = [
			makeEdge({ id: "e1", source: "trigger", target: "target" }),
		] satisfies WorkflowEdge[];
		const catalog = makeCatalog([
			makeAction({ id: "test/target", label: "Target" }),
		]);

		const result = validateWorkflowGraph({ nodes, edges, catalog });

		expect(
			result.issues.some(
				(issue) =>
					issue.code === "UNKNOWN_OUTPUT_FIELD" &&
					issue.severity === "warning" &&
					issue.nodeId === "target",
			),
		).toBe(true);
		expect(result.edgeStates.e1).toBe("warning");
	});

	it("returns warning issues and warning edge state for unknown output fields", () => {
		const nodes = [
			makeNode({ id: "trigger", type: "trigger", label: "Trigger" }),
			makeNode({
				id: "source",
				type: "action",
				label: "Source",
				config: { actionType: "test/source" },
			}),
			makeNode({
				id: "target",
				type: "action",
				label: "Target",
				config: {
					actionType: "test/target",
					prompt: "{{@source:Source.missingField}}",
				},
			}),
		] satisfies WorkflowNode[];
		const edges = [
			makeEdge({ id: "e1", source: "trigger", target: "source" }),
			makeEdge({ id: "e2", source: "source", target: "target" }),
		] satisfies WorkflowEdge[];
		const catalog = makeCatalog([
			makeAction({
				id: "test/source",
				label: "Source",
				outputFields: [{ field: "foo", description: "Foo" }],
			}),
			makeAction({ id: "test/target", label: "Target" }),
		]);

		const result = validateWorkflowGraph({ nodes, edges, catalog });

		expect(
			result.issues.some(
				(issue) =>
					issue.code === "UNKNOWN_OUTPUT_FIELD" &&
					issue.severity === "warning" &&
					issue.nodeId === "target",
			),
		).toBe(true);
		expect(result.edgeStates.e2).toBe("warning");
	});

	it("returns error issues and invalid edge state for broken references", () => {
		const nodes = [
			makeNode({ id: "trigger", type: "trigger", label: "Trigger" }),
			makeNode({
				id: "source",
				type: "action",
				label: "Source",
				config: { actionType: "test/source" },
			}),
			makeNode({
				id: "target",
				type: "action",
				label: "Target",
				config: {
					actionType: "test/target",
					prompt: "{{@missing:Missing.value}}",
				},
			}),
		] satisfies WorkflowNode[];
		const edges = [
			makeEdge({ id: "e1", source: "trigger", target: "source" }),
			makeEdge({ id: "e2", source: "source", target: "target" }),
		] satisfies WorkflowEdge[];
		const catalog = makeCatalog([
			makeAction({ id: "test/source", label: "Source" }),
			makeAction({ id: "test/target", label: "Target" }),
		]);

		const result = validateWorkflowGraph({ nodes, edges, catalog });

		expect(
			result.issues.some(
				(issue) =>
					issue.code === "BROKEN_REFERENCE" &&
					issue.severity === "error" &&
					issue.nodeId === "target",
			),
		).toBe(true);
		expect(result.edgeStates.e2).toBe("invalid");
		expect(result.edgeStates.e1).toBe("valid");
	});

	it("ignores group nodes when building validation graph", () => {
		const nodes = [
			makeNode({ id: "trigger", type: "trigger", label: "Trigger" }),
			makeNode({
				id: "source",
				type: "action",
				label: "Source",
				config: { actionType: "test/source" },
			}),
			makeNode({ id: "group-1", type: "group", label: "Group" }),
		] satisfies WorkflowNode[];
		const edges = [
			makeEdge({ id: "e1", source: "trigger", target: "source" }),
			makeEdge({ id: "e2", source: "source", target: "group-1" }),
		] satisfies WorkflowEdge[];
		const catalog = makeCatalog([
			makeAction({ id: "test/source", label: "Source" }),
		]);

		const result = validateWorkflowGraph({ nodes, edges, catalog });

		expect(result.edgeStates.e1).toBe("valid");
		expect(result.edgeStates.e2).toBeUndefined();
		expect(Object.keys(result.issuesByNodeId)).not.toContain("group-1");
	});
});
