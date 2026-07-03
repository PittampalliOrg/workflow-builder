import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApplicationWorkflowExecutionSessionsService } from "$lib/server/application/workflow-execution-sessions";

describe("ApplicationWorkflowExecutionSessionsService", () => {
	let workflowData: ConstructorParameters<
		typeof ApplicationWorkflowExecutionSessionsService
	>[0]["workflowData"];
	let service: ApplicationWorkflowExecutionSessionsService;

	beforeEach(() => {
		workflowData = {
			getScopedExecutionById: vi.fn(async () => ({ id: "exec-child" }) as never),
			listExecutionSessions: vi.fn(async () => sessions()),
		};
		service = new ApplicationWorkflowExecutionSessionsService({ workflowData });
	});

	it("lists direct and inherited sessions after scoped execution access", async () => {
		await expect(
			service.listSessions({
				executionId: "exec-child",
				userId: "user-1",
				projectId: "project-1",
			}),
		).resolves.toEqual({
			status: "ok",
			body: {
				sessions: [
					{
						id: "session-child",
						title: "Child run",
						status: "running",
						agentId: "agent-1",
						inherited: false,
						sourceExecutionId: null,
						createdAt: "2026-01-01T00:00:00.000Z",
						completedAt: null,
					},
					{
						id: "session-parent",
						title: "Parent run",
						status: "completed",
						agentId: "agent-2",
						inherited: true,
						sourceExecutionId: "exec-parent",
						createdAt: "2025-12-31T23:00:00.000Z",
						completedAt: "2025-12-31T23:05:00.000Z",
					},
				],
			},
		});
		expect(workflowData.getScopedExecutionById).toHaveBeenCalledWith({
			executionId: "exec-child",
			userId: "user-1",
			projectId: "project-1",
		});
		expect(workflowData.listExecutionSessions).toHaveBeenCalledWith({
			executionId: "exec-child",
			projectId: "project-1",
			includeAncestors: true,
		});
	});

	it("hides missing or out-of-scope executions before loading sessions", async () => {
		vi.mocked(workflowData.getScopedExecutionById).mockResolvedValueOnce(null);

		await expect(
			service.listSessions({
				executionId: "exec-child",
				userId: "user-1",
				projectId: "project-1",
			}),
		).resolves.toEqual({
			status: "error",
			httpStatus: 404,
			message: "Execution not found",
		});
		expect(workflowData.listExecutionSessions).not.toHaveBeenCalled();
	});
});

function sessions() {
	return [
		{
			id: "session-child",
			title: "Child run",
			status: "running",
			agentId: "agent-1",
			workflowExecutionId: "exec-child",
			createdAt: new Date("2026-01-01T00:00:00.000Z"),
			completedAt: null,
		},
		{
			id: "session-parent",
			title: "Parent run",
			status: "completed",
			agentId: "agent-2",
			workflowExecutionId: "exec-parent",
			createdAt: new Date("2025-12-31T23:00:00.000Z"),
			completedAt: new Date("2025-12-31T23:05:00.000Z"),
		},
	];
}
