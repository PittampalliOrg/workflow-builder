import { beforeEach, describe, expect, it, vi } from "vitest";

const mockGetSession = vi.hoisted(() => vi.fn());
const mockCreateWorkflowOperationStream = vi.hoisted(() => vi.fn());
const mockCreateValidatedOperationStream = vi.hoisted(() => vi.fn());

vi.mock("@/lib/auth-helpers", () => ({
	getSession: mockGetSession,
}));

vi.mock("@/lib/ai/workflow-generation", () => ({
	createWorkflowOperationStream: mockCreateWorkflowOperationStream,
}));

vi.mock("@/lib/ai/validated-operation-stream", () => ({
	createValidatedOperationStream: mockCreateValidatedOperationStream,
}));

import { POST } from "./route";

describe("POST /api/ai/generate", () => {
	beforeEach(() => {
		mockGetSession.mockReset();
		mockCreateWorkflowOperationStream.mockReset();
		mockCreateValidatedOperationStream.mockReset();
	});

	it("returns 401 when session is missing", async () => {
		mockGetSession.mockResolvedValueOnce(null);

		const response = await POST(
			new Request("http://localhost/api/ai/generate", {
				method: "POST",
				body: JSON.stringify({ prompt: "build a workflow" }),
			}),
		);
		const json = await response.json();

		expect(response.status).toBe(401);
		expect(json).toEqual({ error: "Unauthorized" });
	});

	it("returns 400 when prompt is missing", async () => {
		mockGetSession.mockResolvedValueOnce({
			user: { id: "user-1", projectId: "project-1" },
		});

		const response = await POST(
			new Request("http://localhost/api/ai/generate", {
				method: "POST",
				body: JSON.stringify({}),
			}),
		);
		const json = await response.json();

		expect(response.status).toBe(400);
		expect(json).toEqual({ error: "Prompt is required" });
	});

	it("returns 400 when used for full workflow creation", async () => {
		mockGetSession.mockResolvedValueOnce({
			user: { id: "user-1", projectId: "project-1" },
		});

		const response = await POST(
			new Request("http://localhost/api/ai/generate", {
				method: "POST",
				body: JSON.stringify({ prompt: "create a workflow from scratch" }),
			}),
		);
		const json = await response.json();

		expect(response.status).toBe(400);
		expect(json).toEqual({
			error:
				"This endpoint only supports incremental edits to an existing workflow. Use /api/workflows/generate-from-prompt or /api/workflows/create-from-prompt for new workflow generation.",
		});
		expect(mockCreateWorkflowOperationStream).not.toHaveBeenCalled();
		expect(mockCreateValidatedOperationStream).not.toHaveBeenCalled();
	});
});
