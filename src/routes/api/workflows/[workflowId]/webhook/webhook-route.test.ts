import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkflowExecutionControlResult } from "$lib/server/application/workflow-execution-control";

const mocks = vi.hoisted(() => {
	const workflowExecutionControl = {
		startWebhookExecution: vi.fn(
			async (): Promise<WorkflowExecutionControlResult> => ({
				status: "ok" as const,
				body: {
					executionId: "exec-1",
					status: "running",
				},
			}),
		),
	};
	return { workflowExecutionControl };
});

vi.mock("$lib/server/application", () => ({
	getApplicationAdapters: () => ({
		workflowExecutionControl: mocks.workflowExecutionControl,
	}),
}));

import { POST } from "./+server";

function request(body: unknown = { message: "hello" }, authorization = "Bearer wfb_secret") {
	return new Request("http://workflow-builder.local/api/workflows/wf-1/webhook", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: authorization,
		},
		body: JSON.stringify(body),
	});
}

function event(overrides: Record<string, unknown> = {}) {
	return {
		params: { workflowId: "wf-1" },
		request: request(),
		...overrides,
	};
}

describe("workflow webhook route", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.workflowExecutionControl.startWebhookExecution.mockResolvedValue({
			status: "ok",
			body: {
				executionId: "exec-1",
				status: "running",
			},
		});
	});

	it("delegates public webhook starts to the workflow execution control service", () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "+server.ts"),
			"utf8",
		);
		expect(source).toContain("getApplicationAdapters");
		expect(source).toContain("workflowExecutionControl.startWebhookExecution");
		expect(source).not.toContain("workflowData.getWorkflowByRef");
		expect(source).not.toContain("validateApiKeyForUser");
		expect(source).not.toContain("getRunningWorkflowExecution");
		expect(source).not.toContain("startWorkflowRun");
		expect(source).not.toContain("isSWWorkflow");
		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("drizzle-orm");
	});

	it("passes webhook request details to the application service", async () => {
		const response = (await POST(event() as never)) as Response;

		expect(response.status).toBe(200);
		expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
		await expect(response.json()).resolves.toEqual({
			executionId: "exec-1",
			status: "running",
		});
		expect(
			mocks.workflowExecutionControl.startWebhookExecution,
		).toHaveBeenCalledWith({
			workflowId: "wf-1",
			authorizationHeader: "Bearer wfb_secret",
			body: { message: "hello" },
		});
	});

	it("forwards application errors as CORS JSON errors", async () => {
		mocks.workflowExecutionControl.startWebhookExecution.mockResolvedValueOnce({
			status: "error",
			httpStatus: 401,
			message: "Invalid API key",
		});

		const response = (await POST(event() as never)) as Response;

		expect(response.status).toBe(401);
		expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
		await expect(response.json()).resolves.toEqual({ error: "Invalid API key" });
	});

	it("forwards duplicate-run JSON conflicts from the application service", async () => {
		mocks.workflowExecutionControl.startWebhookExecution.mockResolvedValueOnce({
			status: "ok",
			httpStatus: 409,
			body: {
				error: "A workflow execution is already running",
				existingExecutionId: "exec-running",
			},
		});

		const response = (await POST(event() as never)) as Response;

		expect(response.status).toBe(409);
		await expect(response.json()).resolves.toEqual({
			error: "A workflow execution is already running",
			existingExecutionId: "exec-running",
		});
	});
});
