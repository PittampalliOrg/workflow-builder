import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
	const execution = {
		id: "exec-1",
		workflowId: "wf-1",
		userId: "user-1",
		projectId: "project-1" as string | null,
		status: "running",
		daprInstanceId: "sw-example-exec-exec-1" as string | null,
	};
	const workflowData = {
		getExecutionById: vi.fn(async (): Promise<typeof execution | null> => execution),
	};
	const daprFetch = vi.fn(async () => new Response(null, { status: 202 }));
	return { daprFetch, execution, workflowData };
});

vi.mock("$lib/server/application", () => ({
	getApplicationAdapters: () => ({ workflowData: mocks.workflowData }),
}));

vi.mock("$lib/server/dapr-client", () => ({
	daprFetch: mocks.daprFetch,
	getOrchestratorUrl: () => "http://orchestrator.test",
}));

import { GET, POST } from "./+server";

function postEvent(body: unknown, requestId = "request-1234") {
	return {
		params: { id: "exec-1", requestId },
		request: new Request(
			"http://localhost/api/internal/executions/exec-1/ap-resume/request-1234?ok=yes",
			{
				method: "POST",
				body: typeof body === "string" ? body : JSON.stringify(body),
				headers: { "Content-Type": "application/json" },
			},
		),
		url: new URL(
			"http://localhost/api/internal/executions/exec-1/ap-resume/request-1234?ok=yes",
		),
	};
}

function getEvent(requestId = "request-1234") {
	return {
		params: { id: "exec-1", requestId },
		url: new URL(
			"http://localhost/api/internal/executions/exec-1/ap-resume/request-1234?ok=yes",
		),
	};
}

async function expectHttpStatus(promise: Promise<unknown>, status: number) {
	try {
		const result = await promise;
		expect((result as { status?: number }).status).toBe(status);
	} catch (err) {
		expect((err as { status?: number }).status).toBe(status);
	}
}

describe("ActivePieces resume route", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.workflowData.getExecutionById.mockResolvedValue(mocks.execution);
		mocks.daprFetch.mockResolvedValue(new Response(null, { status: 202 }));
	});

	it("keeps execution lookup behind workflow-data services", () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "+server.ts"),
			"utf8",
		);

		expect(source).toContain("workflowData.getExecutionById");
		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("$lib/server/db/schema");
		expect(source).not.toContain("drizzle-orm");
		expect(source).not.toContain("workflowExecutions");
	});

	it("raises the resume event with query params and JSON body", async () => {
		const response = (await POST(
			postEvent({ approved: true }) as never,
		)) as Response;

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({
			ok: true,
			executionId: "exec-1",
			requestId: "request-1234",
		});
		expect(mocks.workflowData.getExecutionById).toHaveBeenCalledWith("exec-1");
		expect(mocks.daprFetch).toHaveBeenCalledWith(
			"http://orchestrator.test/api/v2/workflows/sw-example-exec-exec-1/events",
			expect.objectContaining({
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					eventName: "ap.resume.request-1234",
					eventData: {
						requestId: "request-1234",
						queryParams: { ok: "yes" },
						body: { approved: true },
					},
				}),
			}),
		);
	});

	it("supports GET callbacks with a null body", async () => {
		const response = (await GET(getEvent() as never)) as Response;

		expect(response.status).toBe(200);
		expect(mocks.daprFetch).toHaveBeenCalledWith(
			expect.any(String),
			expect.objectContaining({
				body: JSON.stringify({
					eventName: "ap.resume.request-1234",
					eventData: {
						requestId: "request-1234",
						queryParams: { ok: "yes" },
						body: null,
					},
				}),
			}),
		);
	});

	it("rejects invalid request ids before loading the execution", async () => {
		await expectHttpStatus(
			Promise.resolve(POST(postEvent({ ok: true }, "bad") as never)),
			400,
		);
		expect(mocks.workflowData.getExecutionById).not.toHaveBeenCalled();
	});

	it("returns 404 when the execution is missing", async () => {
		mocks.workflowData.getExecutionById.mockResolvedValueOnce(null);

		await expectHttpStatus(
			Promise.resolve(POST(postEvent({ ok: true }) as never)),
			404,
		);
		expect(mocks.daprFetch).not.toHaveBeenCalled();
	});

	it("returns a conflict when the execution is not running", async () => {
		mocks.workflowData.getExecutionById.mockResolvedValueOnce({
			...mocks.execution,
			status: "success",
		});

		await expectHttpStatus(
			Promise.resolve(POST(postEvent({ ok: true }) as never)),
			409,
		);
		expect(mocks.daprFetch).not.toHaveBeenCalled();
	});

	it("returns a conflict when no Dapr instance is available", async () => {
		mocks.workflowData.getExecutionById.mockResolvedValueOnce({
			...mocks.execution,
			daprInstanceId: null,
		});

		await expectHttpStatus(
			Promise.resolve(POST(postEvent({ ok: true }) as never)),
			409,
		);
		expect(mocks.daprFetch).not.toHaveBeenCalled();
	});

	it("returns 502 when the orchestrator rejects the event", async () => {
		mocks.daprFetch.mockResolvedValueOnce(new Response("nope", { status: 500 }));

		await expectHttpStatus(
			Promise.resolve(POST(postEvent({ ok: true }) as never)),
			502,
		);
	});
});
