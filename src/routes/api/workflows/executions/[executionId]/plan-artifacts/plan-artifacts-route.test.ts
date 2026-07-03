import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
	WorkflowPlanArtifactListResult,
	WorkflowPlanArtifactResult,
} from "$lib/server/application/workflow-plan";
import type { WorkflowPlanArtifactRecord } from "$lib/server/application/ports";

const mocks = vi.hoisted(() => {
	const planArtifact: WorkflowPlanArtifactRecord = {
		artifactRef: "plan-1",
		workflowExecutionId: "exec-1",
		workflowId: "wf-1",
		userId: "user-1",
		nodeId: "agent",
		workspaceRef: null,
		clonePath: null,
		artifactType: "claude_task_graph_v1",
		artifactVersion: 1,
		status: "draft",
		goal: "ship it",
		planJson: { steps: [] },
		planMarkdown: "## Plan",
		sourcePrompt: null,
		metadata: null,
		createdAt: new Date("2026-01-01T00:00:00.000Z"),
		updatedAt: new Date("2026-01-01T00:00:00.000Z"),
	};
	const workflowPlan = {
		listExecutionPlanArtifacts: vi.fn(async (): Promise<WorkflowPlanArtifactListResult> => ({
			status: "ok" as const,
			artifacts: [planArtifact],
		})),
		createExecutionPlanArtifact: vi.fn(async (): Promise<WorkflowPlanArtifactResult> => ({
			status: "ok" as const,
			artifact: {
				...planArtifact,
				artifactRef: "plan-generated",
				status: "draft",
			},
		})),
		updateExecutionPlanArtifactStatus: vi.fn(async (): Promise<WorkflowPlanArtifactResult> => ({
			status: "ok" as const,
			artifact: {
				...planArtifact,
				status: "approved",
			},
		})),
	};
	return { workflowPlan };
});

vi.mock("$lib/server/application", () => ({
	getApplicationAdapters: () => ({ workflowPlan: mocks.workflowPlan }),
}));

import { GET, PATCH, POST } from "./+server";

function jsonRequest(body: unknown) {
	return new Request("http://workflow-builder.local/test", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
}

function event(overrides: Record<string, unknown> = {}) {
	return {
		params: { executionId: "exec-1" },
		request: jsonRequest({}),
		locals: { session: { userId: "user-1", projectId: "project-1" } },
		...overrides,
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

describe("workflow execution plan-artifacts route", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("keeps the UI-facing route behind workflow-data application services", () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "+server.ts"),
			"utf8",
		);
		expect(source).toContain("getApplicationAdapters");
		expect(source).toContain("workflowPlan.listExecutionPlanArtifacts");
		expect(source).toContain("workflowPlan.createExecutionPlanArtifact");
		expect(source).toContain("workflowPlan.updateExecutionPlanArtifactStatus");
		expect(source).not.toContain("workflowData");
		expect(source).not.toContain("$lib/server/utils/id");
		expect(source).not.toContain("generateId");
		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("drizzle-orm");
	});

	it("lists plan artifacts through workflowPlan after passing session scope", async () => {
		const response = (await GET(event() as never)) as Response;

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toMatchObject({
			artifacts: [{ id: "plan-1", artifactRef: "plan-1", workflowExecutionId: "exec-1" }],
		});
		expect(mocks.workflowPlan.listExecutionPlanArtifacts).toHaveBeenCalledWith({
			executionId: "exec-1",
			userId: "user-1",
			projectId: "project-1",
		});
	});

	it("creates a plan artifact through workflowPlan", async () => {
		const response = (await POST(
			event({
				request: jsonRequest({
					goal: "ship it",
					planMarkdown: "## Plan",
					planJson: { steps: [] },
					nodeId: "agent",
					workflowId: "wf-1",
					metadata: { source: "ui" },
				}),
			}) as never,
		)) as Response;

		expect(response.status).toBe(201);
		expect(mocks.workflowPlan.createExecutionPlanArtifact).toHaveBeenCalledWith(
			{
				executionId: "exec-1",
				userId: "user-1",
				projectId: "project-1",
				workflowId: "wf-1",
				nodeId: "agent",
				goal: "ship it",
				planMarkdown: "## Plan",
				planJson: { steps: [] },
				metadata: { source: "ui" },
			},
		);
	});

	it("updates plan artifact status through workflowPlan", async () => {
		const response = (await PATCH(
			event({
				request: jsonRequest({
					artifactId: "plan-1",
					status: "approved",
					metadata: { reviewed: true },
				}),
			}) as never,
		)) as Response;

		expect(response.status).toBe(200);
		expect(mocks.workflowPlan.updateExecutionPlanArtifactStatus).toHaveBeenCalledWith({
			executionId: "exec-1",
			userId: "user-1",
			projectId: "project-1",
			artifactId: "plan-1",
			status: "approved",
			metadata: { reviewed: true },
		});
	});

	it("requires an authenticated session", async () => {
		await expectHttpStatus(
			Promise.resolve(GET(event({ locals: { session: null } }) as never)),
			401,
		);
		expect(mocks.workflowPlan.listExecutionPlanArtifacts).not.toHaveBeenCalled();
	});

	it("maps service validation errors to HTTP 400", async () => {
		mocks.workflowPlan.createExecutionPlanArtifact.mockResolvedValueOnce({
			status: "bad_request",
			message: "Missing required fields: goal, nodeId, workflowId",
		});

		await expectHttpStatus(
			Promise.resolve(POST(event({ request: jsonRequest({}) }) as never)),
			400,
		);
	});

	it("maps out-of-scope service results to HTTP 404", async () => {
		mocks.workflowPlan.listExecutionPlanArtifacts.mockResolvedValueOnce({
			status: "not_found",
			message: "Execution not found",
		});

		await expectHttpStatus(Promise.resolve(GET(event() as never)), 404);
	});
});
