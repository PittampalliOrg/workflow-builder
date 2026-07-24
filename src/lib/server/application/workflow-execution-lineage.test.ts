import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApplicationWorkflowExecutionLineageService } from "$lib/server/application/workflow-execution-lineage";

describe("ApplicationWorkflowExecutionLineageService", () => {
	let workflowData: ConstructorParameters<
		typeof ApplicationWorkflowExecutionLineageService
	>[0]["workflowData"];
	let service: ApplicationWorkflowExecutionLineageService;

	beforeEach(() => {
		workflowData = {
			getScopedExecutionById: vi.fn(async () => ({ id: "exec-1" }) as never),
			getExecutionLineage: vi.fn(async () => lineage()),
		};
		service = new ApplicationWorkflowExecutionLineageService({ workflowData });
	});

	it("loads lineage after scoped execution access", async () => {
		await expect(
			service.getLineage({
				executionId: "exec-1",
				userId: "user-1",
				projectId: "project-1",
			}),
		).resolves.toEqual({
			status: "ok",
			body: lineage(),
		});
		expect(workflowData.getScopedExecutionById).toHaveBeenCalledWith({
			executionId: "exec-1",
			userId: "user-1",
			projectId: "project-1",
		});
		expect(workflowData.getExecutionLineage).toHaveBeenCalledWith("exec-1");
	});

	it("does not load lineage outside the active workspace", async () => {
		vi.mocked(workflowData.getScopedExecutionById).mockResolvedValueOnce(null);

		await expect(
			service.getLineage({
				executionId: "exec-1",
				userId: "user-1",
				projectId: "project-1",
			}),
		).resolves.toEqual({
			status: "error",
			httpStatus: 404,
			message: "Execution not found",
		});
		expect(workflowData.getExecutionLineage).not.toHaveBeenCalled();
	});

	it("maps a missing lineage read model to the existing 404", async () => {
		vi.mocked(workflowData.getExecutionLineage).mockResolvedValueOnce(null);

		await expect(
			service.getLineage({
				executionId: "exec-1",
				userId: "user-1",
				projectId: "project-1",
			}),
		).resolves.toEqual({
			status: "error",
			httpStatus: 404,
			message: "Execution not found",
		});
	});
});

function lineage() {
	return {
		rootId: "root-exec",
		currentId: "exec-1",
		nodes: [
			{
				id: "root-exec",
				status: "success",
				fromNodeId: null,
				parentId: null,
				startedAt: "2026-01-01T00:00:00.000Z",
				completedAt: "2026-01-01T00:01:00.000Z",
				durationMs: 60_000,
				isCurrent: false,
				seededFromSnapshot: false,
				snapshotPath: null,
			},
			{
				id: "exec-1",
				status: "running",
				fromNodeId: "agent",
				parentId: "root-exec",
				startedAt: "2026-01-01T00:02:00.000Z",
				completedAt: null,
				durationMs: null,
				isCurrent: true,
				seededFromSnapshot: true,
				snapshotPath: ".snapshots/instance-root/plan",
			},
		],
	};
}
