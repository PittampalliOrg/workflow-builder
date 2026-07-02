import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
	const workflow = {
		id: "wf-1",
		name: "Webhook workflow",
		userId: "user-1",
		projectId: "project-1",
		nodes: [{ data: { type: "trigger", config: { triggerType: "Webhook" } } }],
		spec: {
			document: {
				dsl: "1.0.0",
				namespace: "default",
				name: "webhook-workflow",
			},
		},
	};
	const workflowData = {
		getWorkflowByRef: vi.fn(async () => workflow),
		validateApiKeyForUser: vi.fn(
			async (): Promise<
				| { valid: true; apiKeyId: string }
				| { valid: false; error: string; statusCode: number }
			> => ({ valid: true, apiKeyId: "key-1" }),
		),
		getRunningWorkflowExecution: vi.fn(
			async (): Promise<{ id: string; status: string } | null> => null,
		),
	};
	const startWorkflowRun = vi.fn(async () => ({
		ok: true,
		executionId: "exec-1",
		instanceId: "sw-webhook-exec-1",
		workflowId: "wf-1",
		workflowName: "Webhook workflow",
		status: "running",
		reused: false,
	}));
	return { workflow, workflowData, startWorkflowRun };
});

vi.mock("$lib/server/application", () => ({
	getApplicationAdapters: () => ({ workflowData: mocks.workflowData }),
}));

vi.mock("$lib/server/workflows/start-run", () => ({
	isSWWorkflow: (spec: unknown) => {
		const document = (spec as { document?: Record<string, unknown> } | null)?.document;
		return document?.dsl === "1.0.0" && typeof document.name === "string";
	},
	startWorkflowRun: mocks.startWorkflowRun,
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
		mocks.workflowData.getWorkflowByRef.mockResolvedValue(mocks.workflow);
		mocks.workflowData.validateApiKeyForUser.mockResolvedValue({
			valid: true,
			apiKeyId: "key-1",
		});
		mocks.workflowData.getRunningWorkflowExecution.mockResolvedValue(null);
		mocks.startWorkflowRun.mockResolvedValue({
			ok: true,
			executionId: "exec-1",
			instanceId: "sw-webhook-exec-1",
			workflowId: "wf-1",
			workflowName: "Webhook workflow",
			status: "running",
			reused: false,
		});
	});

	it("keeps the public webhook route behind workflow-data and startWorkflowRun", () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "+server.ts"),
			"utf8",
		);
		expect(source).toContain("getApplicationAdapters");
		expect(source).toContain("startWorkflowRun");
		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("drizzle-orm");
	});

	it("validates the API key and starts the workflow through the canonical start service", async () => {
		const response = (await POST(event() as never)) as Response;

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({
			executionId: "exec-1",
			status: "running",
		});
		expect(mocks.workflowData.getWorkflowByRef).toHaveBeenCalledWith({
			workflowId: "wf-1",
			lookup: "id",
		});
		expect(mocks.workflowData.validateApiKeyForUser).toHaveBeenCalledWith({
			authorizationHeader: "Bearer wfb_secret",
			userId: "user-1",
		});
		expect(mocks.workflowData.getRunningWorkflowExecution).toHaveBeenCalledWith("wf-1");
		expect(mocks.startWorkflowRun).toHaveBeenCalledWith({
			workflowId: "wf-1",
			triggerData: { message: "hello" },
			userId: "user-1",
			triggerSource: "webhook",
		});
	});

	it("rejects invalid API keys before checking running executions", async () => {
		mocks.workflowData.validateApiKeyForUser.mockResolvedValueOnce({
			valid: false,
			error: "Invalid API key",
			statusCode: 401,
		});

		const response = (await POST(event() as never)) as Response;

		expect(response.status).toBe(401);
		await expect(response.json()).resolves.toEqual({ error: "Invalid API key" });
		expect(mocks.workflowData.getRunningWorkflowExecution).not.toHaveBeenCalled();
		expect(mocks.startWorkflowRun).not.toHaveBeenCalled();
	});

	it("preserves the running-execution duplicate guard", async () => {
		mocks.workflowData.getRunningWorkflowExecution.mockResolvedValueOnce({
			id: "exec-running",
			status: "running",
		});

		const response = (await POST(event() as never)) as Response;

		expect(response.status).toBe(409);
		await expect(response.json()).resolves.toEqual({
			error: "A workflow execution is already running",
			existingExecutionId: "exec-running",
		});
		expect(mocks.startWorkflowRun).not.toHaveBeenCalled();
	});
});
