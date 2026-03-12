import { describe, expect, it } from "vitest";
import { compileWorkflowSpecToGraph } from "./compile";
import { decompileGraphToWorkflowSpec } from "./decompile";
import type { WorkflowSpec } from "./types";

describe("WorkflowSpec round-trip", () => {
	it("preserves branching topology and key node config", () => {
		const spec: WorkflowSpec = {
			apiVersion: "workflow-spec/v1",
			name: "Branching Workflow",
			description: "Round-trip test workflow",
			trigger: {
				id: "trigger",
				type: "manual",
				config: {
					triggerType: "Manual",
				},
			},
			steps: [
				{
					id: "fetch_data",
					kind: "action",
					label: "Fetch Data",
					enabled: true,
					config: {
						actionType: "system/http-request",
						endpoint: "https://example.com",
						httpMethod: "GET",
					},
					next: "check_result",
				},
				{
					id: "check_result",
					kind: "if-else",
					label: "Check Result",
					enabled: true,
					config: {
						operator: "BOOLEAN_IS_TRUE",
						left: "{{state.ok}}",
					},
					next: {
						true: "notify_success",
						false: "notify_failure",
					},
				},
				{
					id: "notify_success",
					kind: "note",
					label: "Notify Success",
					enabled: true,
					config: {
						text: "success path",
					},
				},
				{
					id: "notify_failure",
					kind: "set-state",
					label: "Notify Failure",
					enabled: true,
					config: {
						key: "lastError",
						value: "failure",
					},
				},
			],
		};

		const compiled = compileWorkflowSpecToGraph(spec);
		const decompiled = decompileGraphToWorkflowSpec({
			name: spec.name,
			description: spec.description,
			nodes: compiled.nodes,
			edges: compiled.edges,
		});

		expect(decompiled.name).toBe(spec.name);
		expect(decompiled.description).toBe(spec.description);
		expect(decompiled.trigger.type).toBe("manual");
		expect(decompiled.steps).toHaveLength(4);

		const fetchStep = decompiled.steps.find((step) => step.id === "fetch_data");
		expect(fetchStep).toMatchObject({
			kind: "action",
			label: "Fetch Data",
			config: expect.objectContaining({
				actionType: "system/http-request",
				endpoint: "https://example.com",
			}),
			next: "check_result",
		});

		const branchStep = decompiled.steps.find(
			(step) => step.id === "check_result",
		);
		expect(branchStep).toMatchObject({
			kind: "if-else",
			next: {
				true: ["notify_success"],
				false: ["notify_failure"],
			},
		});
	});
});
