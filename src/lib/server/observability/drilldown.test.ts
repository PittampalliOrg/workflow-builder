import { describe, expect, it } from "vitest";

import type {
	ObservabilityInvestigationPayload,
	ObservabilityTraceSpan,
} from "$lib/types/observability";
import { filterInvestigationToSelection } from "./drilldown";

function span(
	spanId: string,
	parentSpanId: string | null,
	serviceName: string,
	operationName: string,
	attributes: Record<string, unknown> = {},
): ObservabilityTraceSpan {
	return {
		traceId: "trace-1",
		spanId,
		parentSpanId,
		operationName,
		serviceName,
		startTime: "2026-05-22T11:00:00.000Z",
		duration: 1,
		status: "ok",
		spanKind: "Server",
		attributes,
		depth: 0,
	};
}

function payload(traceSpans: ObservabilityTraceSpan[]): ObservabilityInvestigationPayload {
	return {
		summary: {
			scope: "session",
			sessionId: null,
			traceIds: ["trace-1"],
			traceCount: 1,
			spanCount: traceSpans.length,
			llmTurnCount: 0,
			toolCallCount: 0,
			logCount: 0,
			workflowStepCount: 0,
			serviceCount: 0,
			errorCount: 0,
			totalDurationMs: 0,
			totalTokens: 0,
			cacheReadInputTokens: 0,
			cacheCreationInputTokens: 0,
			reasoningTokens: 0,
			startedAt: null,
			completedAt: null,
			status: null,
			slowestSpanId: null,
			firstFailureEventId: null,
			services: [],
		},
		traceSpans,
		logs: [],
		llmSpans: [],
		toolSpans: [],
		agentDecisionSummary: null,
		agentDecisions: [],
		agentDecisionDiagram: null,
		workflowSteps: [],
		events: [],
		issues: [],
	};
}

describe("filterInvestigationToSelection", () => {
	it("keeps same-trace ancestors so wrapper request/response content remains visible", () => {
		const parent = span("router", null, "function-router", "POST", {
			"input.value": JSON.stringify({ function_slug: "workspace/command" }),
			"output.value": JSON.stringify({ success: true }),
		});
		const child = span("workspace-command", "router", "openshell-agent-runtime", "POST /api/workspaces/command", {
			"workflow.node.id": "command",
			"input.value": JSON.stringify({ command: "pwd" }),
			"output.value": JSON.stringify({ stdout: "/sandbox" }),
		});

		const scoped = filterInvestigationToSelection(payload([parent, child]), {
			kind: "node",
			id: "command",
			nodeKind: "step",
		});

		expect(scoped.traceSpans.map((s) => s.spanId)).toEqual(["router", "workspace-command"]);
		expect(scoped.traceSpans[0].attributes?.["input.value"]).toContain("workspace/command");
		expect(scoped.traceSpans[1].attributes?.["input.value"]).toContain("pwd");
	});
});
