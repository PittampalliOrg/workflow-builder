import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const mockGetSession = vi.hoisted(() => vi.fn());
const mockExtractTraceCorrelation = vi.hoisted(() => vi.fn());
const mockGetProjectExecutionIndex = vi.hoisted(() => vi.fn());
const mockResolveTraceContextFromIndex = vi.hoisted(() => vi.fn());
const mockSearchJaegerTraces = vi.hoisted(() => vi.fn());
const mockNormalizeJaegerTraceSummary = vi.hoisted(() => vi.fn());

vi.mock("@/lib/auth-helpers", () => ({
	getSession: mockGetSession,
}));

vi.mock("@/lib/observability/correlation", () => ({
	extractTraceCorrelation: mockExtractTraceCorrelation,
	getProjectExecutionIndex: mockGetProjectExecutionIndex,
	resolveTraceContextFromIndex: mockResolveTraceContextFromIndex,
}));

vi.mock("@/lib/observability/jaeger-client", () => ({
	searchJaegerTraces: mockSearchJaegerTraces,
}));

vi.mock("@/lib/observability/normalization", () => ({
	normalizeJaegerTraceSummary: mockNormalizeJaegerTraceSummary,
}));

import { GET } from "./route";

const ORIGINAL_JAEGER_QUERY_SERVICE = process.env.JAEGER_QUERY_SERVICE;
const ORIGINAL_OTEL_SERVICE_NAME = process.env.OTEL_SERVICE_NAME;

function makeTrace(traceId: string, startTimeMicros: number) {
	return {
		traceID: traceId,
		spans: [
			{
				traceID: traceId,
				spanID: `${traceId}-span`,
				operationName: `operation-${traceId}`,
				startTime: startTimeMicros,
				duration: 5_000,
			},
		],
	};
}

function makeSummary(traceId: string, startedAt: string, workflowId = "wf-1") {
	return {
		traceId,
		name: `trace-${traceId}`,
		startedAt,
		endedAt: startedAt,
		durationMs: 5,
		spanCount: 1,
		serviceName: "workflow-service",
		status: "ok" as const,
		workflowId,
		workflowName: "Workflow One",
		executionId: `exec-${traceId}`,
		daprInstanceId: `inst-${traceId}`,
		phase: "running",
	};
}

function decodeCursor(cursor: string) {
	return JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as {
		to: string;
	};
}

describe("GET /api/observability/traces", () => {
	beforeEach(() => {
		mockGetSession.mockReset();
		mockExtractTraceCorrelation.mockReset();
		mockGetProjectExecutionIndex.mockReset();
		mockResolveTraceContextFromIndex.mockReset();
		mockSearchJaegerTraces.mockReset();
		mockNormalizeJaegerTraceSummary.mockReset();

		mockGetSession.mockResolvedValue({
			user: { id: "user-1", projectId: "project-1" },
		});
		mockGetProjectExecutionIndex.mockResolvedValue({
			byExecutionId: new Map(),
			byInstanceId: new Map(),
			byWorkflowId: new Map(),
		});
		delete process.env.JAEGER_QUERY_SERVICE;
		delete process.env.OTEL_SERVICE_NAME;
	});

	afterAll(() => {
		process.env.JAEGER_QUERY_SERVICE = ORIGINAL_JAEGER_QUERY_SERVICE;
		process.env.OTEL_SERVICE_NAME = ORIGINAL_OTEL_SERVICE_NAME;
	});

	it("returns 401 when the user is not authenticated", async () => {
		mockGetSession.mockResolvedValueOnce(null);

		const response = await GET(
			new Request("http://localhost/api/observability/traces"),
		);
		const json = await response.json();

		expect(response.status).toBe(401);
		expect(json).toEqual({ error: "Unauthorized" });
	});

	it("filters out unmatched traces by default", async () => {
		const traceA = makeTrace("a", 2_000_000);
		const traceB = makeTrace("b", 1_000_000);
		mockSearchJaegerTraces.mockResolvedValueOnce([traceA, traceB]);
		mockExtractTraceCorrelation
			.mockReturnValueOnce({
				executionIds: new Set(["exec-a"]),
				instanceIds: new Set<string>(),
				workflowIds: new Set<string>(),
			})
			.mockReturnValueOnce({
				executionIds: new Set(["exec-b"]),
				instanceIds: new Set<string>(),
				workflowIds: new Set<string>(),
			});
		mockResolveTraceContextFromIndex
			.mockReturnValueOnce({
				workflowId: null,
				workflowName: null,
				executionId: null,
				daprInstanceId: null,
				phase: null,
			})
			.mockReturnValueOnce({
				workflowId: "wf-1",
				workflowName: "Workflow One",
				executionId: "exec-b",
				daprInstanceId: "inst-b",
				phase: "running",
			});
		mockNormalizeJaegerTraceSummary.mockReturnValueOnce(
			makeSummary("b", "2026-02-16T00:00:00.000Z"),
		);

		const response = await GET(
			new Request("http://localhost/api/observability/traces?limit=10"),
		);
		const json = await response.json();

		expect(response.status).toBe(200);
		expect(json.traces).toHaveLength(1);
		expect(json.traces[0]?.traceId).toBe("b");
		expect(mockNormalizeJaegerTraceSummary).toHaveBeenCalledTimes(1);
	});

	it("applies workflow entity filter and search filter", async () => {
		const traceA = makeTrace("a", 3_000_000);
		const traceB = makeTrace("b", 2_000_000);
		mockSearchJaegerTraces.mockResolvedValueOnce([traceA, traceB]);
		mockExtractTraceCorrelation
			.mockReturnValueOnce({
				executionIds: new Set(["exec-a"]),
				instanceIds: new Set<string>(),
				workflowIds: new Set(["wf-a"]),
			})
			.mockReturnValueOnce({
				executionIds: new Set(["exec-b"]),
				instanceIds: new Set<string>(),
				workflowIds: new Set(["wf-b"]),
			});
		mockResolveTraceContextFromIndex
			.mockReturnValueOnce({
				workflowId: "wf-a",
				workflowName: "Alpha Workflow",
				executionId: "exec-a",
				daprInstanceId: "inst-a",
				phase: "running",
			})
			.mockReturnValueOnce({
				workflowId: "wf-b",
				workflowName: "Beta Workflow",
				executionId: "exec-b",
				daprInstanceId: "inst-b",
				phase: "running",
			});
		mockNormalizeJaegerTraceSummary
			.mockReturnValueOnce({
				...makeSummary("a", "2026-02-16T00:00:03.000Z", "wf-a"),
				name: "alpha trace",
			})
			.mockReturnValueOnce({
				...makeSummary("b", "2026-02-16T00:00:02.000Z", "wf-b"),
				name: "beta trace",
			});

		const response = await GET(
			new Request(
				"http://localhost/api/observability/traces?entityType=workflow&entityId=wf-a&search=alpha",
			),
		);
		const json = await response.json();

		expect(response.status).toBe(200);
		expect(json.traces).toHaveLength(1);
		expect(json.traces[0]?.workflowId).toBe("wf-a");
		expect(json.traces[0]?.name).toBe("alpha trace");
	});

	it("decodes cursor into the jaeger query window and emits nextCursor", async () => {
		const cursor = Buffer.from(
			JSON.stringify({ to: "2026-02-15T01:00:00.000Z" }),
			"utf8",
		).toString("base64url");

		const traces = Array.from({ length: 11 }, (_, i) =>
			makeTrace(`t${i + 1}`, 1_000_000 + i * 1_000),
		);
		mockSearchJaegerTraces.mockResolvedValueOnce(traces);
		mockExtractTraceCorrelation.mockReturnValue({
			executionIds: new Set(["exec-1"]),
			instanceIds: new Set<string>(),
			workflowIds: new Set<string>(),
		});
		mockResolveTraceContextFromIndex.mockReturnValue({
			workflowId: "wf-1",
			workflowName: "Workflow One",
			executionId: "exec-1",
			daprInstanceId: "inst-1",
			phase: "running",
		});
		mockNormalizeJaegerTraceSummary.mockImplementation(
			(trace: { traceID: string }) =>
				makeSummary(trace.traceID, "2026-02-16T00:00:00.000Z"),
		);

		const response = await GET(
			new Request(
				`http://localhost/api/observability/traces?limit=1&cursor=${encodeURIComponent(cursor)}`,
			),
		);
		const json = await response.json();

		expect(response.status).toBe(200);
		expect(mockSearchJaegerTraces).toHaveBeenCalledWith(
			expect.objectContaining({
				limit: 11,
				to: new Date("2026-02-15T01:00:00.000Z"),
			}),
		);
		expect(json.traces).toHaveLength(1);
		expect(typeof json.nextCursor).toBe("string");
		expect(decodeCursor(json.nextCursor).to).toBe("1970-01-01T00:00:00.999Z");
	});

	it("returns 500 when jaeger lookup fails", async () => {
		mockSearchJaegerTraces.mockRejectedValueOnce(
			new Error("jaeger unavailable"),
		);

		const response = await GET(
			new Request("http://localhost/api/observability/traces"),
		);
		const json = await response.json();

		expect(response.status).toBe(500);
		expect(json).toEqual({ error: "Failed to fetch observability traces" });
	});

	it("falls back to workflow-builder service when service is not provided", async () => {
		mockSearchJaegerTraces.mockResolvedValueOnce([]);

		const response = await GET(
			new Request("http://localhost/api/observability/traces"),
		);

		expect(response.status).toBe(200);
		expect(mockSearchJaegerTraces).toHaveBeenCalledWith(
			expect.objectContaining({
				service: "workflow-builder",
			}),
		);
	});

	it("ignores blank service query values and falls back to workflow-builder", async () => {
		mockSearchJaegerTraces.mockResolvedValueOnce([]);

		const response = await GET(
			new Request("http://localhost/api/observability/traces?service=%20%20"),
		);

		expect(response.status).toBe(200);
		expect(mockSearchJaegerTraces).toHaveBeenCalledWith(
			expect.objectContaining({
				service: "workflow-builder",
			}),
		);
	});

	it("uses JAEGER_QUERY_SERVICE when set and no service query param is provided", async () => {
		mockSearchJaegerTraces.mockResolvedValueOnce([]);
		process.env.JAEGER_QUERY_SERVICE = "function-router";

		const response = await GET(
			new Request("http://localhost/api/observability/traces"),
		);

		expect(response.status).toBe(200);
		expect(mockSearchJaegerTraces).toHaveBeenCalledWith(
			expect.objectContaining({
				service: "function-router",
			}),
		);
	});

	it("prefers OTEL_SERVICE_NAME over JAEGER_QUERY_SERVICE when both are set", async () => {
		mockSearchJaegerTraces.mockResolvedValueOnce([]);
		process.env.JAEGER_QUERY_SERVICE = "workflow-builder";
		process.env.OTEL_SERVICE_NAME = "workflow-builder-dev";

		const response = await GET(
			new Request("http://localhost/api/observability/traces"),
		);

		expect(response.status).toBe(200);
		expect(mockSearchJaegerTraces).toHaveBeenCalledWith(
			expect.objectContaining({
				service: "workflow-builder-dev",
			}),
		);
	});
});
