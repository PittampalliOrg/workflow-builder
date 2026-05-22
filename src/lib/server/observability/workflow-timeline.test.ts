import { describe, expect, it } from "vitest";

import type {
	ObservabilityTraceSpan,
	ObservabilityWorkflowStep,
} from "$lib/types/observability";
import { buildWorkflowTimeline } from "./workflow-timeline";

function span(
	spanId: string,
	operationName: string,
	attributes: Record<string, unknown>,
	startMs: number,
	duration = 100,
): ObservabilityTraceSpan {
	return {
		traceId: "trace-1",
		spanId,
		parentSpanId: null,
		operationName,
		serviceName: "workflow-orchestrator",
		startTime: new Date(startMs).toISOString(),
		duration,
		status: "ok",
		statusCode: "Ok",
		spanKind: "Internal",
		attributes,
		depth: 0,
	};
}

function step(overrides: Partial<ObservabilityWorkflowStep>): ObservabilityWorkflowStep {
	return {
		id: "log-1",
		stepName: "extract_patch",
		label: "Extract patch",
		actionType: "workspace/command",
		status: "success",
		input: {},
		output: {},
		error: null,
		durationMs: 1200,
		startedAt: new Date(1_000).toISOString(),
		completedAt: new Date(2_200).toISOString(),
		routedTo: "function-router",
		...overrides,
	};
}

describe("buildWorkflowTimeline", () => {
	it("orders workflow nodes by workflow.node.sequence and attaches native Dapr task ids", () => {
		const items = buildWorkflowTimeline({
			workflowSteps: [
				step({
					stepName: "profile",
					label: "Profile workspace",
					startedAt: new Date(1_000).toISOString(),
					completedAt: new Date(1_300).toISOString(),
				}),
				step({
					stepName: "extract_patch",
					label: "Extract patch",
					startedAt: new Date(2_000).toISOString(),
					completedAt: new Date(3_000).toISOString(),
				}),
			],
			traceSpans: [
				span(
					"node-extract",
					"workflow.node.extract_patch",
					{
						"workflow.node.id": "extract_patch",
						"workflow.node.name": "Extract patch",
						"workflow.node.action_type": "workspace/command",
						"workflow.node.sequence": 1,
					},
					2_000,
					1_000,
				),
				span(
					"app-extract",
					"activity: execute_action",
					{
						"node.id": "extract_patch",
						"action.type": "workspace/command",
						"input.value": JSON.stringify({ command: "git diff" }),
						"output.value": JSON.stringify({ stdout: "patch" }),
					},
					2_005,
					900,
				),
				span(
					"native-extract",
					"activity||execute_action",
					{
						"durabletask.task.task_id": "8",
						"durabletask.task.name": "execute_action",
					},
					2_004,
					902,
				),
				span(
					"node-profile",
					"workflow.node.profile",
					{
						"workflow.node.id": "profile",
						"workflow.node.sequence": 0,
					},
					1_000,
					300,
				),
			],
		});

		expect(items.map((item) => item.nodeId)).toEqual(["profile", "extract_patch"]);
		const extract = items[1];
		expect(extract.durableTaskId).toBe("8");
		expect(extract.relatedSpanIds).toContain("native-extract");
		expect(extract.inputSpanId).toBe("app-extract");
		expect(extract.outputSpanId).toBe("app-extract");
	});

	it("keeps native-only Dapr activities in task id order", () => {
		const items = buildWorkflowTimeline({
			workflowSteps: [],
			traceSpans: [
				span("later", "activity||persist_results_to_db", {
					"durabletask.task.task_id": "10",
					"durabletask.task.name": "persist_results_to_db",
				}, 10_000),
				span("earlier", "activity||spawn_session_for_workflow", {
					"durabletask.task.task_id": "5",
					"durabletask.task.name": "spawn_session_for_workflow",
				}, 5_000),
			],
		});

		expect(items.map((item) => item.durableTaskId)).toEqual(["5", "10"]);
		expect(items[0].kind).toBe("dapr_activity");
		expect(items[1].kind).toBe("system");
	});

	it("falls back to workflow_execution_logs when spans are absent", () => {
		const items = buildWorkflowTimeline({
			workflowSteps: [
				step({ stepName: "first", label: "First" }),
				step({ stepName: "second", label: "Second", status: "error", error: "failed" }),
			],
			traceSpans: [],
		});

		expect(items.map((item) => item.title)).toEqual(["First", "Second"]);
		expect(items[1].status).toBe("error");
		expect(items[0].spanId).toBeNull();
	});
});
