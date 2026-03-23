import { describe, expect, it } from "vitest";
import {
	buildWorkflowExecutionIR,
	isGraphRepresentableByWorkflowSpec,
	resolveCanonicalWorkflowSpec,
} from "./workflow-contract";
import type { WorkflowEdge, WorkflowNode } from "./workflow-store";
import {
	WORKFLOW_SPEC_API_VERSION,
	type WorkflowSpec,
} from "./workflow-spec/types";

function makeTrigger(): WorkflowNode {
	return {
		id: "trigger",
		type: "trigger",
		position: { x: 0, y: 0 },
		data: {
			label: "Trigger",
			type: "trigger",
			config: { triggerType: "Manual" },
			status: "idle",
		},
	};
}

describe("workflow-contract", () => {
	it("uses persisted workflow spec as the canonical authoring contract", () => {
		const nodes: WorkflowNode[] = [
			makeTrigger(),
			{
				id: "step-a",
				type: "action",
				position: { x: 100, y: 100 },
				data: {
					label: "Workspace Profile",
					type: "action",
					config: { actionType: "workspace/profile" },
					status: "idle",
				},
			},
		];
		const edges: WorkflowEdge[] = [
			{
				id: "trigger=>step-a",
				source: "trigger",
				target: "step-a",
			},
		];
		const spec: WorkflowSpec = {
			apiVersion: WORKFLOW_SPEC_API_VERSION,
			name: "Spec Workflow",
			description: "Workflow authored via spec",
			trigger: {
				id: "trigger",
				type: "manual",
				config: { triggerType: "Manual" },
				next: "step-a",
			},
			steps: [
				{
					id: "step-a",
					kind: "action",
					label: "Workspace Profile",
					enabled: true,
					config: { actionType: "workspace/profile" },
				},
			],
		};

		const canonical = resolveCanonicalWorkflowSpec({
			name: "Spec Workflow",
			description: "Workflow authored via spec",
			nodes,
			edges,
			spec,
			specVersion: WORKFLOW_SPEC_API_VERSION,
		});
		expect(canonical.source).toBe("persisted-spec");
		expect(canonical.spec?.apiVersion).toBe(WORKFLOW_SPEC_API_VERSION);

		const executionIr = buildWorkflowExecutionIR({
			workflowId: "wf_123",
			name: "Spec Workflow",
			description: "Workflow authored via spec",
			author: "user@example.com",
			nodes,
			edges,
			spec,
			specVersion: WORKFLOW_SPEC_API_VERSION,
		});

		expect(executionIr.source).toBe("persisted-spec");
		expect(executionIr.spec?.name).toBe("Spec Workflow");
		expect(executionIr.definition.id).toBe("wf_123");
		expect(executionIr.definition.executionOrder).toEqual(["step-a"]);
	});

	it("falls back to legacy graph mode for unsupported node kinds", () => {
		const nodes: WorkflowNode[] = [
			makeTrigger(),
			{
				id: "while-1",
				type: "while",
				position: { x: 100, y: 100 },
				data: {
					label: "While",
					type: "while",
					config: { expression: "{{state.keepGoing}}" },
					status: "idle",
				},
			},
		];
		const edges: WorkflowEdge[] = [
			{
				id: "trigger=>while-1",
				source: "trigger",
				target: "while-1",
			},
		];

		expect(isGraphRepresentableByWorkflowSpec({ nodes })).toBe(false);

		const canonical = resolveCanonicalWorkflowSpec({
			name: "Legacy Workflow",
			nodes,
			edges,
		});
		expect(canonical.source).toBe("legacy-graph");
		expect(canonical.spec).toBeNull();

		const executionIr = buildWorkflowExecutionIR({
			workflowId: "wf_legacy",
			name: "Legacy Workflow",
			nodes,
			edges,
		});
		expect(executionIr.source).toBe("legacy-graph");
		expect(executionIr.spec).toBeNull();
		expect(executionIr.definition.executionOrder).toEqual(["while-1"]);
	});
});
