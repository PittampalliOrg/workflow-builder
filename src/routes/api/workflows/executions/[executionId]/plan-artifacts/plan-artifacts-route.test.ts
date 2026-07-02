import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
	const planArtifact = {
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
	const workflowData = {
		listPlanArtifactsByExecutionId: vi.fn(async () => [planArtifact]),
		upsertPlanArtifact: vi.fn(async () => ({
			artifactRef: "plan-generated",
			storageBackend: "workflow_plan_artifacts",
			artifactType: "claude_task_graph_v1",
			status: "draft",
		})),
		updatePlanArtifactStatus: vi.fn(async () => ({
			artifactRef: "plan-1",
			status: "approved",
		})),
		getPlanArtifact: vi.fn(async (artifactRef: string) => ({
			...planArtifact,
			artifactRef,
			status: artifactRef === "plan-1" ? "approved" : "draft",
		})),
	};
	return { workflowData };
});

vi.mock("$lib/server/application", () => ({
	getApplicationAdapters: () => ({ workflowData: mocks.workflowData }),
}));

vi.mock("$lib/server/utils/id", () => ({
	generateId: () => "plan-generated",
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
		...overrides,
	};
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
		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("drizzle-orm");
	});

	it("lists plan artifacts through workflowData while preserving legacy id", async () => {
		const response = (await GET(event() as never)) as Response;

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toMatchObject({
			artifacts: [{ id: "plan-1", artifactRef: "plan-1", workflowExecutionId: "exec-1" }],
		});
		expect(mocks.workflowData.listPlanArtifactsByExecutionId).toHaveBeenCalledWith("exec-1");
	});

	it("creates a plan artifact through workflowData with a generated artifact ref", async () => {
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
		expect(mocks.workflowData.upsertPlanArtifact).toHaveBeenCalledWith(
			expect.objectContaining({
				artifactRef: "plan-generated",
				workflowExecutionId: "exec-1",
				workflowId: "wf-1",
				nodeId: "agent",
				goal: "ship it",
			}),
		);
		expect(mocks.workflowData.getPlanArtifact).toHaveBeenCalledWith("plan-generated");
	});

	it("updates plan artifact status through workflowData", async () => {
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
		expect(mocks.workflowData.updatePlanArtifactStatus).toHaveBeenCalledWith({
			artifactRef: "plan-1",
			status: "approved",
			metadata: { reviewed: true },
		});
		expect(mocks.workflowData.getPlanArtifact).toHaveBeenCalledWith("plan-1");
	});
});
