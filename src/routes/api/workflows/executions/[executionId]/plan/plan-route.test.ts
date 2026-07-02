import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
	const workflowData = {
		listPlanArtifactsByExecutionId: vi.fn(async () => [
			{
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
			},
		]),
	};
	const daprFetch = vi.fn(async () =>
		new Response(JSON.stringify({ plan: "legacy plan" }), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		}),
	);
	return { workflowData, daprFetch };
});

vi.mock("$lib/server/application", () => ({
	getApplicationAdapters: () => ({ workflowData: mocks.workflowData }),
}));

vi.mock("$lib/server/dapr-client", () => ({
	daprFetch: mocks.daprFetch,
	getDaprSidecarUrl: () => "http://127.0.0.1:3500",
}));

import { GET } from "./+server";

function event() {
	return {
		params: { executionId: "exec-1" },
	};
}

describe("workflow execution plan route", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("keeps the plan table read behind workflow-data application services", () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "+server.ts"),
			"utf8",
		);
		expect(source).toContain("getApplicationAdapters");
		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("drizzle-orm");
	});

	it("returns the newest persisted plan from workflowData", async () => {
		const response = (await GET(event() as never)) as Response;

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({ plan: "## Plan" });
		expect(mocks.workflowData.listPlanArtifactsByExecutionId).toHaveBeenCalledWith("exec-1");
		expect(mocks.daprFetch).not.toHaveBeenCalled();
	});

	it("keeps the legacy Dapr fallback when no persisted plan exists", async () => {
		mocks.workflowData.listPlanArtifactsByExecutionId.mockResolvedValueOnce([]);

		const response = (await GET(event() as never)) as Response;

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({ plan: "legacy plan" });
		expect(mocks.daprFetch).toHaveBeenCalledWith(
			"http://127.0.0.1:3500/v1.0/invoke/dapr-agent-py.openshell/method/plan/exec-1",
			expect.objectContaining({
				headers: { "Content-Type": "application/json" },
			}),
		);
	});
});
