import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
	WorkflowDefinition,
	WorkflowExecutionListItem,
} from "$lib/server/application/ports";

const mocks = vi.hoisted(() => {
	const workflow: WorkflowDefinition = {
		id: "wf-1",
		name: "Supported workflow",
		description: null,
		userId: "user-1",
		projectId: "project-1",
		nodes: [],
		edges: [],
		specVersion: null,
		spec: {
			document: {
				dsl: "1.0.0",
				namespace: "examples",
				name: "supported-workflow",
			},
		},
		visibility: "private",
		engineType: "dapr",
		daprWorkflowName: null,
		daprOrchestratorUrl: null,
		mlflowExperimentId: null,
		mlflowExperimentName: null,
		createdAt: new Date("2026-07-02T00:00:00.000Z"),
		updatedAt: new Date("2026-07-02T00:00:00.000Z"),
	};
	const workflowData = {
		assertExecutionReadModelReady: vi.fn(async () => undefined),
		getWorkflowByRef: vi.fn(async (): Promise<WorkflowDefinition | null> => workflow),
		listWorkflowExecutions: vi.fn(
			async (): Promise<WorkflowExecutionListItem[]> => [],
		),
		createWorkflowExecution: vi.fn(async () => ({ id: "exec-1" })),
		attachExecutionSchedulerInstance: vi.fn(async () => undefined),
		updateExecutionReadModel: vi.fn(async () => undefined),
	};
	const daprFetch = vi.fn(async () =>
		new Response(JSON.stringify({ instanceId: "instance-1" }), { status: 200 }),
	);
	const validateInternalToken = vi.fn(() => true);
	return { daprFetch, validateInternalToken, workflow, workflowData };
});

vi.mock("$env/dynamic/private", () => ({
	env: {
		SUPPORTED_WORKFLOW_ID: "wf-1",
	},
}));

vi.mock("$lib/server/application", () => ({
	getApplicationAdapters: () => ({ workflowData: mocks.workflowData }),
}));

vi.mock("$lib/server/dapr-client", () => ({
	daprFetch: mocks.daprFetch,
	getOrchestratorUrl: () => "http://workflow-orchestrator",
}));

vi.mock("$lib/server/internal-auth", () => ({
	validateInternalToken: mocks.validateInternalToken,
}));

import { POST } from "./+server";

const routeDir = dirname(fileURLToPath(import.meta.url));

function githubPayload(overrides: Record<string, unknown> = {}) {
	return {
		action: "opened",
		issue: {
			number: 42,
			title: "Fix the thing",
			body: "Please fix the thing",
			labels: [{ name: "dapr-swe" }],
		},
		repository: {
			name: "workflow-builder",
			owner: { login: "PittampalliOrg" },
		},
		sender: { login: "vinod" },
		...overrides,
	};
}

function event(body: unknown, options: { url?: string; headers?: HeadersInit } = {}) {
	return {
		url: new URL(
			options.url ??
				"http://localhost/api/events/ingest?source=github&eventType=issues",
		),
		request: new Request("http://localhost/api/events/ingest", {
			method: "POST",
			body: typeof body === "string" ? body : JSON.stringify(body),
			headers: {
				"Content-Type": "application/json",
				...(options.headers ?? {}),
			},
		}),
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

describe("external events ingest route", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.validateInternalToken.mockReturnValue(true);
		mocks.workflowData.assertExecutionReadModelReady.mockResolvedValue(undefined);
		mocks.workflowData.getWorkflowByRef.mockResolvedValue(mocks.workflow);
		mocks.workflowData.listWorkflowExecutions.mockResolvedValue([]);
		mocks.workflowData.createWorkflowExecution.mockResolvedValue({ id: "exec-1" });
		mocks.workflowData.attachExecutionSchedulerInstance.mockResolvedValue(undefined);
		mocks.workflowData.updateExecutionReadModel.mockResolvedValue(undefined);
		mocks.daprFetch.mockResolvedValue(
			new Response(JSON.stringify({ instanceId: "instance-1" }), { status: 200 }),
		);
	});

	it("keeps event persistence behind workflow-data application services", () => {
		const routeSource = readFileSync(join(routeDir, "+server.ts"), "utf8");
		const registrySource = readFileSync(
			resolve(routeDir, "../../../../lib/server/workflows/external-event-registry.ts"),
			"utf8",
		);

		expect(routeSource).toContain("workflowData.assertExecutionReadModelReady");
		expect(routeSource).toContain("workflowData.getWorkflowByRef");
		expect(routeSource).toContain("workflowData.createWorkflowExecution");
		expect(routeSource).toContain("workflowData.attachExecutionSchedulerInstance");
		expect(routeSource).toContain("workflowData.updateExecutionReadModel");
		expect(routeSource).not.toContain("$lib/server/db");
		expect(routeSource).not.toContain("$lib/server/db/schema");
		expect(routeSource).not.toContain("drizzle-orm");
		expect(routeSource).not.toContain("assertExecutionReadModelColumns");
		expect(registrySource).not.toContain("$lib/server/db");
		expect(registrySource).not.toContain("$lib/server/db/schema");
		expect(registrySource).not.toContain("drizzle-orm");
		expect(registrySource).not.toContain("workflowExecutions");
	});

	it("rejects unauthorized calls before workflow-data access", async () => {
		mocks.validateInternalToken.mockReturnValueOnce(false);

		const response = (await POST(
			event({ payload: githubPayload() }) as never,
		)) as Response;

		expect(response.status).toBe(401);
		await expect(response.json()).resolves.toEqual({ error: "Unauthorized" });
		expect(mocks.workflowData.assertExecutionReadModelReady).not.toHaveBeenCalled();
	});

	it("creates an execution, starts the orchestrator, and attaches the instance", async () => {
		const response = (await POST(
			event(
				{
					eventId: "github-event-1",
					payload: githubPayload(),
				},
				{
					headers: {
						traceparent: "00-abc-def-01",
						tracestate: "vendor=value",
					},
				},
			) as never,
		)) as Response;

		expect(response.status).toBe(202);
		await expect(response.json()).resolves.toEqual({
			status: "accepted",
			source: "github",
			eventType: "issues",
			workflowId: "wf-1",
			executionId: "exec-1",
			instanceId: "instance-1",
			eventId: "github-event-1",
		});
		expect(mocks.workflowData.assertExecutionReadModelReady).toHaveBeenCalledTimes(1);
		expect(mocks.workflowData.getWorkflowByRef).toHaveBeenCalledWith({
			workflowId: "wf-1",
			lookup: "id",
		});
		expect(mocks.workflowData.listWorkflowExecutions).toHaveBeenCalledWith({
			workflowId: "wf-1",
			limit: 25,
			include: "full",
		});
		expect(mocks.workflowData.createWorkflowExecution).toHaveBeenCalledWith(
			expect.objectContaining({
				workflowId: "wf-1",
				userId: "user-1",
				projectId: "project-1",
				status: "running",
				phase: "running",
				progress: 0,
				executionIrVersion: "sw-1.0.0",
				input: expect.objectContaining({
					provider: "github",
					owner: "PittampalliOrg",
					repo: "workflow-builder",
					issue_number: 42,
				}),
			}),
		);
		expect(mocks.daprFetch).toHaveBeenCalledWith(
			"http://workflow-orchestrator/api/v2/sw-workflows",
			expect.objectContaining({
				method: "POST",
				headers: expect.objectContaining({
					"Content-Type": "application/json",
					traceparent: "00-abc-def-01",
					tracestate: "vendor=value",
				}),
			}),
		);
		expect(mocks.workflowData.attachExecutionSchedulerInstance).toHaveBeenCalledWith({
			executionId: "exec-1",
			instanceId: "instance-1",
			workflowSessionId: "exec-1",
		});
	});

	it("suppresses duplicate running executions without creating or starting another run", async () => {
		mocks.workflowData.listWorkflowExecutions.mockResolvedValueOnce([
			{
				id: "exec-existing",
				workflowId: "wf-1",
				status: "running",
				daprInstanceId: "instance-existing",
				startedAt: new Date("2026-07-02T00:00:00.000Z"),
				completedAt: null,
				duration: null,
				input: {
					provider: "github",
					owner: "PittampalliOrg",
					repo: "workflow-builder",
					issue_number: 42,
				},
				output: null,
			},
		]);

		const response = (await POST(
			event({ payload: githubPayload() }) as never,
		)) as Response;

		expect(response.status).toBe(202);
		await expect(response.json()).resolves.toEqual({
			status: "ignored",
			reason: "A workflow execution is already in progress for this issue",
			executionId: "exec-existing",
		});
		expect(mocks.workflowData.createWorkflowExecution).not.toHaveBeenCalled();
		expect(mocks.daprFetch).not.toHaveBeenCalled();
	});

	it("suppresses duplicate successful executions that already opened a PR", async () => {
		mocks.workflowData.listWorkflowExecutions.mockResolvedValueOnce([
			{
				id: "exec-success",
				workflowId: "wf-1",
				status: "success",
				daprInstanceId: "instance-success",
				startedAt: new Date("2026-07-02T00:00:00.000Z"),
				completedAt: new Date("2026-07-02T00:05:00.000Z"),
				duration: null,
				input: {
					provider: "github",
					owner: "PittampalliOrg",
					repo: "workflow-builder",
					issue_number: 42,
				},
				output: {
					workflowOutput: {
						pr_url: "https://github.com/PittampalliOrg/workflow-builder/pull/1",
					},
				},
			},
		]);

		const response = (await POST(
			event({ payload: githubPayload() }) as never,
		)) as Response;

		expect(response.status).toBe(202);
		await expect(response.json()).resolves.toEqual({
			status: "ignored",
			reason: "A workflow execution already created a PR for this issue",
			executionId: "exec-success",
		});
		expect(mocks.workflowData.createWorkflowExecution).not.toHaveBeenCalled();
		expect(mocks.daprFetch).not.toHaveBeenCalled();
	});

	it("marks the execution failed when the orchestrator rejects the start", async () => {
		mocks.daprFetch.mockResolvedValueOnce(new Response("bad start", { status: 503 }));

		const response = (await POST(
			event({ payload: githubPayload() }) as never,
		)) as Response;

		expect(response.status).toBe(502);
		await expect(response.json()).resolves.toEqual({
			error: "SW workflow failed: 503 bad start",
		});
		expect(mocks.workflowData.updateExecutionReadModel).toHaveBeenCalledWith(
			"exec-1",
			expect.objectContaining({
				status: "error",
				error: "SW workflow failed: 503 bad start",
				completedAt: expect.any(Date),
			}),
		);
	});

	it("marks the execution failed when the orchestrator request throws", async () => {
		mocks.daprFetch.mockRejectedValueOnce(new Error("network down"));

		const response = (await POST(
			event({ payload: githubPayload() }) as never,
		)) as Response;

		expect(response.status).toBe(500);
		await expect(response.json()).resolves.toEqual({ error: "network down" });
		expect(mocks.workflowData.updateExecutionReadModel).toHaveBeenCalledWith(
			"exec-1",
			expect.objectContaining({
				status: "error",
				error: "network down",
				completedAt: expect.any(Date),
			}),
		);
	});

	it("returns ignored for unsupported event payloads", async () => {
		const response = (await POST(
			event({ payload: githubPayload({ action: "closed" }) }) as never,
		)) as Response;

		expect(response.status).toBe(202);
		await expect(response.json()).resolves.toEqual({
			status: "ignored",
			reason: "Unsupported GitHub issue action",
		});
		expect(mocks.workflowData.getWorkflowByRef).not.toHaveBeenCalled();
	});

	it("returns 400 for invalid query parameters after the readiness check", async () => {
		const response = (await POST(
			event(
				{ payload: githubPayload() },
				{ url: "http://localhost/api/events/ingest?source=github" },
			) as never,
		)) as Response;

		expect(response.status).toBe(400);
		await expect(response.json()).resolves.toEqual({
			error: "Missing required source or eventType query parameter",
		});
		expect(mocks.workflowData.assertExecutionReadModelReady).toHaveBeenCalledTimes(1);
	});

	it("surfaces execution creation failures without starting the orchestrator", async () => {
		mocks.workflowData.createWorkflowExecution.mockRejectedValueOnce(
			new Error("insert failed"),
		);

		const response = (await POST(
			event({ payload: githubPayload() }) as never,
		)) as Response;

		expect(response.status).toBe(500);
		await expect(response.json()).resolves.toEqual({
			error: "Failed to create execution record",
		});
		expect(mocks.daprFetch).not.toHaveBeenCalled();
	});

	it("returns 404 when the supported workflow is missing", async () => {
		mocks.workflowData.getWorkflowByRef.mockResolvedValueOnce(null);

		await expectHttpStatus(
			Promise.resolve(POST(event({ payload: githubPayload() }) as never)),
			404,
		);
	});
});
