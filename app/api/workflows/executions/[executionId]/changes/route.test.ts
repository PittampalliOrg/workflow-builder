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

describe("GET /api/workflows/executions/[executionId]/changes", () => {
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

	it("derives OpenShell file changes from persisted execution output when the workspace endpoint returns 404", async () => {
		mockFindFirst.mockResolvedValueOnce({
			id: "exec-1",
			status: "success",
			startedAt: new Date("2026-03-20T01:37:35.243Z"),
			output: {
				outputs: {
					pf_agent_system_demo: {
						data: {
							workspaceRef: "workspace-123",
						},
					},
					da_agent_system_demo: {
						text: "Script created and verified.\n\n**Changed files:** `scripts/workflow_builder_demo_report.py` (new file)",
						traceId: "trace-1",
					},
				},
			},
			workflow: {
				userId: "user-1",
			},
		});
		mockInvokeService.mockResolvedValueOnce({
			ok: false,
			status: 404,
			data: null,
		});

		const response = await GET(
			new Request("http://localhost/api/workflows/executions/exec-1/changes"),
			{ params: Promise.resolve({ executionId: "exec-1" }) },
		);
		const json = await response.json();

		expect(response.status).toBe(200);
		expect(json).toEqual({
			success: true,
			executionId: "exec-1",
			count: 1,
			changes: [
				{
					changeSetId: "derived:exec-1:da_agent_system_demo",
					executionId: "exec-1",
					workspaceRef: "workspace-123",
					durableInstanceId: undefined,
					operation: "derived-output",
					sequence: 1,
					format: "git-unified-v1",
					sha256: "derived:exec-1:da_agent_system_demo",
					filesChanged: 1,
					additions: 0,
					deletions: 0,
					bytes: 0,
					compressed: false,
					storageRef: "derived:exec-1:da_agent_system_demo",
					createdAt: "2026-03-20T01:37:35.243Z",
					includeInExecutionPatch: false,
					truncated: false,
					originalBytes: 0,
					files: [
						{
							path: "scripts/workflow_builder_demo_report.py",
							status: "A",
						},
					],
				},
			],
			pending: false,
		});
	});
});
