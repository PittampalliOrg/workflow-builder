import { beforeEach, describe, expect, it, vi } from "vitest";

const mockGetSession = vi.hoisted(() => vi.fn());
const mockExtractTraceCorrelation = vi.hoisted(() => vi.fn());
const mockFindTraceContextForProject = vi.hoisted(() => vi.fn());
const mockGetJaegerTraceById = vi.hoisted(() => vi.fn());
const mockNormalizeJaegerTraceDetails = vi.hoisted(() => vi.fn());

vi.mock("@/lib/auth-helpers", () => ({
	getSession: mockGetSession,
}));

vi.mock("@/lib/observability/correlation", () => ({
	extractTraceCorrelation: mockExtractTraceCorrelation,
	findTraceContextForProject: mockFindTraceContextForProject,
}));

vi.mock("@/lib/observability/jaeger-client", () => ({
	getJaegerTraceById: mockGetJaegerTraceById,
}));

vi.mock("@/lib/observability/normalization", () => ({
	normalizeJaegerTraceDetails: mockNormalizeJaegerTraceDetails,
}));

import { GET } from "./route";

function traceContext(traceId: string) {
	return {
		trace: {
			traceId,
			name: "trace-name",
			startedAt: "2026-02-16T00:00:00.000Z",
			endedAt: "2026-02-16T00:00:00.100Z",
			durationMs: 100,
			spanCount: 1,
			serviceName: "workflow-service",
			status: "ok" as const,
			workflowId: "wf-1",
			workflowName: "Workflow One",
			executionId: "exec-1",
			daprInstanceId: "inst-1",
			phase: "running",
		},
		spans: [],
	};
}

describe("GET /api/observability/traces/[traceId]", () => {
	beforeEach(() => {
		mockGetSession.mockReset();
		mockExtractTraceCorrelation.mockReset();
		mockFindTraceContextForProject.mockReset();
		mockGetJaegerTraceById.mockReset();
		mockNormalizeJaegerTraceDetails.mockReset();

		mockGetSession.mockResolvedValue({
			user: { id: "user-1", projectId: "project-1" },
		});
		mockExtractTraceCorrelation.mockReturnValue({
			executionIds: new Set(["exec-1"]),
			instanceIds: new Set<string>(),
			workflowIds: new Set<string>(),
		});
	});

	it("returns 401 when unauthenticated", async () => {
		mockGetSession.mockResolvedValueOnce(null);

		const response = await GET(
			new Request("http://localhost/api/observability/traces/trace-1"),
			{ params: Promise.resolve({ traceId: "trace-1" }) },
		);
		const json = await response.json();

		expect(response.status).toBe(401);
		expect(json).toEqual({ error: "Unauthorized" });
	});

	it("returns 400 when traceId is missing", async () => {
		const response = await GET(
			new Request("http://localhost/api/observability/traces/"),
			{ params: Promise.resolve({ traceId: "" }) },
		);
		const json = await response.json();

		expect(response.status).toBe(400);
		expect(json).toEqual({ error: "Trace ID is required" });
	});

	it("returns 404 when jaeger trace is not found", async () => {
		mockGetJaegerTraceById.mockResolvedValueOnce(null);

		const response = await GET(
			new Request("http://localhost/api/observability/traces/trace-404"),
			{ params: Promise.resolve({ traceId: "trace-404" }) },
		);
		const json = await response.json();

		expect(response.status).toBe(404);
		expect(json).toEqual({ error: "Trace not found" });
	});

	it("returns 404 when trace is unmatched for project scope", async () => {
		mockGetJaegerTraceById.mockResolvedValueOnce({
			traceID: "trace-1",
			spans: [],
		});
		mockFindTraceContextForProject.mockResolvedValueOnce({
			workflowId: null,
			workflowName: null,
			executionId: null,
			daprInstanceId: null,
			phase: null,
		});

		const response = await GET(
			new Request("http://localhost/api/observability/traces/trace-1"),
			{ params: Promise.resolve({ traceId: "trace-1" }) },
		);
		const json = await response.json();

		expect(response.status).toBe(404);
		expect(json).toEqual({ error: "Trace not found" });
	});

	it("returns 200 with normalized trace details when matched", async () => {
		mockGetJaegerTraceById.mockResolvedValueOnce({
			traceID: "trace-1",
			spans: [],
		});
		mockFindTraceContextForProject.mockResolvedValueOnce({
			workflowId: "wf-1",
			workflowName: "Workflow One",
			executionId: "exec-1",
			daprInstanceId: "inst-1",
			phase: "running",
		});
		mockNormalizeJaegerTraceDetails.mockReturnValueOnce(
			traceContext("trace-1"),
		);

		const response = await GET(
			new Request("http://localhost/api/observability/traces/trace-1"),
			{ params: Promise.resolve({ traceId: "trace-1" }) },
		);
		const json = await response.json();

		expect(response.status).toBe(200);
		expect(json).toEqual({ trace: traceContext("trace-1") });
	});

	it("returns 404 when trace cannot be normalized", async () => {
		mockGetJaegerTraceById.mockResolvedValueOnce({
			traceID: "trace-1",
			spans: [],
		});
		mockFindTraceContextForProject.mockResolvedValueOnce({
			workflowId: "wf-1",
			workflowName: "Workflow One",
			executionId: "exec-1",
			daprInstanceId: "inst-1",
			phase: "running",
		});
		mockNormalizeJaegerTraceDetails.mockReturnValueOnce(null);

		const response = await GET(
			new Request("http://localhost/api/observability/traces/trace-1"),
			{ params: Promise.resolve({ traceId: "trace-1" }) },
		);
		const json = await response.json();

		expect(response.status).toBe(404);
		expect(json).toEqual({ error: "Trace not found" });
	});

	it("returns 500 when an internal error is thrown", async () => {
		mockGetJaegerTraceById.mockRejectedValueOnce(new Error("network"));

		const response = await GET(
			new Request("http://localhost/api/observability/traces/trace-1"),
			{ params: Promise.resolve({ traceId: "trace-1" }) },
		);
		const json = await response.json();

		expect(response.status).toBe(500);
		expect(json).toEqual({
			error: "Failed to fetch observability trace details",
		});
	});
});
