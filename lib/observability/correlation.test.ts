import { describe, expect, it } from "vitest";
import type { JaegerTrace } from "./jaeger-types";
import {
	extractTraceCorrelation,
	resolveTraceContextFromIndex,
} from "./correlation";

type IndexParam = Parameters<typeof resolveTraceContextFromIndex>[1];
type CorrelatedExecution =
	IndexParam["byExecutionId"] extends Map<string, infer T> ? T : never;

function execution(
	overrides: Partial<CorrelatedExecution> & {
		executionId: string;
		workflowId: string;
		workflowName: string;
		startedAt: Date;
	},
): CorrelatedExecution {
	return {
		daprInstanceId: null,
		status: "running",
		phase: null,
		progress: null,
		...overrides,
	};
}

function emptyIndex(): IndexParam {
	return {
		byExecutionId: new Map(),
		byInstanceId: new Map(),
		byWorkflowId: new Map(),
	};
}

describe("extractTraceCorrelation", () => {
	it("extracts and deduplicates execution, instance, and workflow IDs across aliases", () => {
		const trace: JaegerTrace = {
			traceID: "trace-1",
			spans: [
				{
					spanID: "s1",
					tags: [
						{ key: "workflow.db_execution_id", value: "exec-1" },
						{ key: "workflow.instance_id", value: "inst-1" },
						{ key: "workflow.id", value: "wf-1" },
					],
				},
				{
					spanID: "s2",
					tags: [
						{ key: "dbExecutionId", value: "exec-1" },
						{ key: "daprInstanceId", value: "inst-2" },
						{ key: "workflowId", value: "wf-2" },
					],
				},
			],
		};

		const correlation = extractTraceCorrelation(trace);

		expect(Array.from(correlation.executionIds)).toEqual(["exec-1"]);
		expect(Array.from(correlation.instanceIds)).toEqual(["inst-1", "inst-2"]);
		expect(Array.from(correlation.workflowIds)).toEqual(["wf-1", "wf-2"]);
	});

	it("returns empty sets when tags are missing", () => {
		const trace: JaegerTrace = {
			traceID: "trace-2",
			spans: [{ spanID: "s1", operationName: "op" }],
		};

		const correlation = extractTraceCorrelation(trace);
		expect(correlation.executionIds.size).toBe(0);
		expect(correlation.instanceIds.size).toBe(0);
		expect(correlation.workflowIds.size).toBe(0);
	});
});

describe("resolveTraceContextFromIndex", () => {
	it("prefers execution ID matches over instance/workflow matches", () => {
		const correlation = extractTraceCorrelation({
			traceID: "trace-exec",
			spans: [
				{
					tags: [
						{ key: "workflow.db_execution_id", value: "exec-winner" },
						{ key: "workflow.instance_id", value: "inst-loser" },
						{ key: "workflow.id", value: "wf-loser" },
					],
				},
			],
		});

		const index = emptyIndex();
		const winner = execution({
			executionId: "exec-winner",
			workflowId: "wf-win",
			workflowName: "Winner Workflow",
			startedAt: new Date("2026-02-15T10:00:00.000Z"),
		});
		index.byExecutionId.set("exec-winner", winner);
		index.byInstanceId.set(
			"inst-loser",
			execution({
				executionId: "exec-loser",
				workflowId: "wf-loser",
				workflowName: "Loser Workflow",
				startedAt: new Date("2026-02-15T09:00:00.000Z"),
			}),
		);
		index.byWorkflowId.set("wf-loser", [
			execution({
				executionId: "exec-loser-2",
				workflowId: "wf-loser",
				workflowName: "Loser Workflow",
				startedAt: new Date("2026-02-15T08:00:00.000Z"),
			}),
		]);

		const context = resolveTraceContextFromIndex(correlation, index);
		expect(context.executionId).toBe("exec-winner");
		expect(context.workflowId).toBe("wf-win");
	});

	it("falls back to latest workflow execution when only workflow ID matches", () => {
		const correlation = extractTraceCorrelation({
			traceID: "trace-workflow",
			spans: [{ tags: [{ key: "workflow.id", value: "wf-1" }] }],
		});

		const index = emptyIndex();
		index.byWorkflowId.set("wf-1", [
			execution({
				executionId: "exec-old",
				workflowId: "wf-1",
				workflowName: "Workflow One",
				startedAt: new Date("2026-02-15T01:00:00.000Z"),
				phase: "completed",
			}),
			execution({
				executionId: "exec-new",
				workflowId: "wf-1",
				workflowName: "Workflow One",
				startedAt: new Date("2026-02-15T02:00:00.000Z"),
				phase: "running",
			}),
		]);

		const context = resolveTraceContextFromIndex(correlation, index);
		expect(context.executionId).toBe("exec-new");
		expect(context.phase).toBe("running");
	});

	it("returns null context fields for unmatched traces", () => {
		const correlation = extractTraceCorrelation({
			traceID: "trace-unmatched",
			spans: [
				{ tags: [{ key: "workflow.db_execution_id", value: "exec-404" }] },
			],
		});

		const context = resolveTraceContextFromIndex(correlation, emptyIndex());
		expect(context).toEqual({
			workflowId: null,
			workflowName: null,
			executionId: null,
			daprInstanceId: null,
			phase: null,
		});
	});
});
