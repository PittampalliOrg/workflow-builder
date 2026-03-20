import { beforeEach, describe, expect, it, vi } from "vitest";

const mockGetSession = vi.hoisted(() => vi.fn());
const mockInvokeService = vi.hoisted(() => vi.fn());
const mockFindFirst = vi.hoisted(() => vi.fn());

vi.mock("@/lib/auth-helpers", () => ({
	getSession: mockGetSession,
}));

vi.mock("@/lib/dapr/client", () => ({
	invokeService: mockInvokeService,
}));

vi.mock("@/lib/db", () => ({
	db: {
		query: {
			workflowExecutions: {
				findFirst: mockFindFirst,
			},
		},
	},
}));

import { GET } from "./route";

describe("GET /api/workflows/executions/[executionId]/changes/[changeSetId]", () => {
	beforeEach(() => {
		mockGetSession.mockReset();
		mockInvokeService.mockReset();
		mockFindFirst.mockReset();

		mockGetSession.mockResolvedValue({
			user: {
				id: "user-1",
			},
		});
	});

	it("returns persisted execution patch data for derived execution-output change sets", async () => {
		mockFindFirst.mockResolvedValueOnce({
			id: "exec-3",
			startedAt: new Date("2026-03-20T03:27:07.459Z"),
			output: {
				outputs: {
					pf_agent_system_demo: {
						data: {
							workspaceRef: "workspace-789",
						},
					},
					da_agent_system_demo: {
						fileChanges: [
							{
								path: "scripts/workflow_builder_demo_report.py",
								status: "A",
							},
						],
						patch:
							"diff --git a/scripts/workflow_builder_demo_report.py b/scripts/workflow_builder_demo_report.py\nnew file mode 100644\n",
						daprInstanceId: "durable-123",
					},
				},
			},
			workflow: {
				userId: "user-1",
			},
		});

		const response = await GET(
			new Request(
				"http://localhost/api/workflows/executions/exec-3/changes/derived:exec-3:da_agent_system_demo",
			),
			{
				params: Promise.resolve({
					executionId: "exec-3",
					changeSetId: "derived:exec-3:da_agent_system_demo",
				}),
			},
		);
		const json = await response.json();

		expect(response.status).toBe(200);
		expect(mockInvokeService).not.toHaveBeenCalled();
		expect(json).toMatchObject({
			success: true,
			executionId: "exec-3",
			metadata: {
				changeSetId: "derived:exec-3:da_agent_system_demo",
				executionId: "exec-3",
				workspaceRef: "workspace-789",
				durableInstanceId: "durable-123",
				operation: "execution-output",
				includeInExecutionPatch: true,
			},
		});
		expect(json.patch).toContain(
			"diff --git a/scripts/workflow_builder_demo_report.py b/scripts/workflow_builder_demo_report.py",
		);
		expect(json.patch).toContain("new file mode 100644");
	});
});
