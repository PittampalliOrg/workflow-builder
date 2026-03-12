import { beforeEach, describe, expect, it, vi } from "vitest";

const mockGetSession = vi.hoisted(() => vi.fn());
const mockFindWorkflow = vi.hoisted(() => vi.fn());
const mockDbInsert = vi.hoisted(() => vi.fn());
const mockCreateWorkflowOperationStream = vi.hoisted(() => vi.fn());

vi.mock("@/lib/auth-helpers", () => ({
	getSession: mockGetSession,
}));

vi.mock("@/lib/db", () => ({
	db: {
		query: {
			workflows: {
				findFirst: mockFindWorkflow,
			},
		},
		insert: mockDbInsert,
	},
}));

vi.mock("@/lib/ai/workflow-generation", () => ({
	createWorkflowOperationStream: mockCreateWorkflowOperationStream,
}));

vi.mock("@/lib/db/workflow-ai-messages", () => ({
	isWorkflowAiMessagesTableMissing: vi.fn().mockReturnValue(false),
}));

import { POST } from "./route";

describe("POST /api/workflows/[workflowId]/ai-chat/stream", () => {
	beforeEach(() => {
		mockGetSession.mockReset();
		mockFindWorkflow.mockReset();
		mockDbInsert.mockReset();
		mockCreateWorkflowOperationStream.mockReset();
	});

	it("returns 401 when session is missing", async () => {
		mockGetSession.mockResolvedValueOnce(null);

		const response = await POST(
			new Request("http://localhost/api/workflows/wf-1/ai-chat/stream", {
				method: "POST",
				body: JSON.stringify({ message: "edit this workflow" }),
			}),
			{ params: Promise.resolve({ workflowId: "wf-1" }) },
		);
		const json = await response.json();

		expect(response.status).toBe(401);
		expect(json).toEqual({ error: "Unauthorized" });
	});

	it("returns 400 when existingWorkflow is missing", async () => {
		mockGetSession.mockResolvedValueOnce({
			user: { id: "user-1", projectId: "project-1" },
		});
		mockFindWorkflow.mockResolvedValueOnce({
			id: "wf-1",
			userId: "user-1",
		});

		const response = await POST(
			new Request("http://localhost/api/workflows/wf-1/ai-chat/stream", {
				method: "POST",
				body: JSON.stringify({ message: "edit this workflow" }),
			}),
			{ params: Promise.resolve({ workflowId: "wf-1" }) },
		);
		const json = await response.json();

		expect(response.status).toBe(400);
		expect(json).toEqual({
			error:
				"This endpoint only supports incremental edits to an existing workflow snapshot.",
		});
		expect(mockDbInsert).not.toHaveBeenCalled();
		expect(mockCreateWorkflowOperationStream).not.toHaveBeenCalled();
	});
});
