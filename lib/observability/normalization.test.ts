import { describe, expect, it } from "vitest";
import type { JaegerTrace } from "./jaeger-types";
import {
	normalizeJaegerSpans,
	normalizeJaegerTraceDetails,
	normalizeJaegerTraceSummary,
} from "./normalization";

const baseContext = {
	workflowId: "wf-1",
	workflowName: "Workflow One",
	executionId: "exec-1",
	daprInstanceId: "dapr-1",
	phase: "running",
};

describe("normalizeJaegerSpans", () => {
	it("normalizes spans with parent linkage, attributes, and chronological sort", () => {
		const trace: JaegerTrace = {
			traceID: "trace-1",
			processes: {
				p1: { serviceName: "workflow-service" },
				p2: { serviceName: "worker-service" },
			},
			spans: [
				{
					traceID: "trace-1",
					spanID: "child",
					processID: "p2",
					operationName: "child-op",
					startTime: 2_000_000,
					duration: 9_500,
					references: [{ refType: "CHILD_OF", spanID: "root" }],
					tags: [
						{ key: "span.kind", value: "server" },
						{ key: "custom.tag", value: "x" },
					],
				},
				{
					traceID: "trace-1",
					spanID: "root",
					processID: "p1",
					operationName: "root-op",
					startTime: 1_000_000,
					duration: 4_000,
					tags: [{ key: "otel.status_code", value: "OK" }],
				},
			],
		};

		const spans = normalizeJaegerSpans(trace);

		expect(spans).toHaveLength(2);
		expect(spans.map((span) => span.spanId)).toEqual(["root", "child"]);
		expect(spans[1]?.parentSpanId).toBe("root");
		expect(spans[1]?.serviceName).toBe("worker-service");
		expect(spans[1]?.durationMs).toBe(10);
		expect(spans[1]?.kind).toBe("server");
		expect(spans[1]?.attributes).toEqual({
			"span.kind": "server",
			"custom.tag": "x",
		});
	});
});

describe("normalizeJaegerTraceSummary", () => {
	it("prioritizes error status over ok and maps context fields", () => {
		const trace: JaegerTrace = {
			traceID: "trace-2",
			processes: {
				p1: { serviceName: "workflow-service" },
			},
			spans: [
				{
					traceID: "trace-2",
					spanID: "root",
					processID: "p1",
					operationName: "root-op",
					startTime: 1_000_000,
					duration: 3_000,
					tags: [{ key: "otel.status_code", value: "OK" }],
				},
				{
					traceID: "trace-2",
					spanID: "child",
					processID: "p1",
					operationName: "child-op",
					startTime: 1_002_000,
					duration: 3_000,
					references: [{ refType: "CHILD_OF", spanID: "root" }],
					tags: [{ key: "error", value: true }],
				},
			],
		};

		const summary = normalizeJaegerTraceSummary(trace, baseContext);

		expect(summary).not.toBeNull();
		expect(summary?.traceId).toBe("trace-2");
		expect(summary?.name).toBe("root-op");
		expect(summary?.serviceName).toBe("workflow-service");
		expect(summary?.status).toBe("error");
		expect(summary?.workflowId).toBe(baseContext.workflowId);
		expect(summary?.workflowName).toBe(baseContext.workflowName);
		expect(summary?.executionId).toBe(baseContext.executionId);
		expect(summary?.daprInstanceId).toBe(baseContext.daprInstanceId);
		expect(summary?.phase).toBe(baseContext.phase);
	});

	it("returns unknown status when no status tags exist", () => {
		const trace: JaegerTrace = {
			traceID: "trace-3",
			spans: [
				{
					traceID: "trace-3",
					spanID: "root",
					operationName: "root-op",
					startTime: 5_000_000,
					duration: 2_000,
				},
			],
		};

		const summary = normalizeJaegerTraceSummary(trace, baseContext);

		expect(summary?.status).toBe("unknown");
	});

	it("returns null when trace has no spans", () => {
		const trace: JaegerTrace = {
			traceID: "trace-empty",
			spans: [],
		};

		const summary = normalizeJaegerTraceSummary(trace, baseContext);
		expect(summary).toBeNull();
	});
});

describe("normalizeJaegerTraceDetails", () => {
	it("returns summary with spans for valid traces", () => {
		const trace: JaegerTrace = {
			traceID: "trace-4",
			spans: [
				{
					traceID: "trace-4",
					spanID: "root",
					operationName: "root-op",
					startTime: 10_000_000,
					duration: 2_500,
				},
			],
		};

		const details = normalizeJaegerTraceDetails(trace, baseContext);

		expect(details).not.toBeNull();
		expect(details?.trace.traceId).toBe("trace-4");
		expect(details?.spans).toHaveLength(1);
	});

	it("returns null when summary cannot be built", () => {
		const trace: JaegerTrace = {
			traceID: "",
			spans: [],
		};

		const details = normalizeJaegerTraceDetails(trace, baseContext);
		expect(details).toBeNull();
	});
});
