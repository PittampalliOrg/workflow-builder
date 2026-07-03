import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApplicationWorkflowExecutionSpecDiffService } from "$lib/server/application/workflow-execution-spec-diff";

describe("ApplicationWorkflowExecutionSpecDiffService", () => {
	let workflowData: ConstructorParameters<
		typeof ApplicationWorkflowExecutionSpecDiffService
	>[0]["workflowData"];
	let service: ApplicationWorkflowExecutionSpecDiffService;

	beforeEach(() => {
		workflowData = {
			getScopedExecutionById: vi.fn(async () => childExecution() as never),
			getExecutionById: vi.fn(async (id: string) =>
				(id === "exec-parent" ? parentExecution() : childExecution()) as never,
			),
		};
		service = new ApplicationWorkflowExecutionSpecDiffService({ workflowData });
	});

	it("returns a node-level diff between a forked run and its parent", async () => {
		const result = await service.getSpecDiff(commandInput());

		expect(result).toMatchObject({
			status: "ok",
			body: {
				hasParent: true,
				parentId: "exec-parent",
				fromNode: "refine",
				snapshotUnavailable: false,
				added: ["verify"],
				removed: [],
				changed: [expect.objectContaining({ name: "refine" })],
			},
		});
		expect(workflowData.getScopedExecutionById).toHaveBeenCalledWith({
			executionId: "exec-child",
			userId: "user-1",
			projectId: "project-1",
		});
		expect(workflowData.getExecutionById).toHaveBeenCalledWith("exec-parent");
	});

	it("returns the existing no-parent shape for non-forked runs", async () => {
		vi.mocked(workflowData.getScopedExecutionById).mockResolvedValueOnce(
			childExecution({ rerunOfExecutionId: null }) as never,
		);

		await expect(service.getSpecDiff(commandInput())).resolves.toEqual({
			status: "ok",
			body: { hasParent: false, parentId: null, fromNode: "refine" },
		});
		expect(workflowData.getExecutionById).not.toHaveBeenCalled();
	});

	it("returns snapshotUnavailable when either run lacks a persisted spec", async () => {
		vi.mocked(workflowData.getExecutionById).mockResolvedValueOnce(
			parentExecution({ executionIr: null }) as never,
		);

		await expect(service.getSpecDiff(commandInput())).resolves.toEqual({
			status: "ok",
			body: {
				hasParent: true,
				parentId: "exec-parent",
				fromNode: "refine",
				snapshotUnavailable: true,
			},
		});
	});

	it("hides missing or out-of-scope executions before loading the parent", async () => {
		vi.mocked(workflowData.getScopedExecutionById).mockResolvedValueOnce(null);

		await expect(service.getSpecDiff(commandInput())).resolves.toEqual({
			status: "error",
			httpStatus: 404,
			message: "Execution not found",
		});
		expect(workflowData.getExecutionById).not.toHaveBeenCalled();
	});
});

function commandInput() {
	return {
		executionId: "exec-child",
		userId: "user-1",
		projectId: "project-1",
	};
}

function childExecution(overrides: Record<string, unknown> = {}) {
	return {
		id: "exec-child",
		workflowId: "wf-1",
		userId: "user-1",
		projectId: "project-1",
		status: "running",
		executionIr: { spec: childSpec() },
		rerunOfExecutionId: "exec-parent",
		resumeFromNode: "refine",
		...overrides,
	};
}

function parentExecution(overrides: Record<string, unknown> = {}) {
	return {
		...childExecution(),
		id: "exec-parent",
		executionIr: { spec: parentSpec() },
		rerunOfExecutionId: null,
		resumeFromNode: null,
		...overrides,
	};
}

function parentSpec() {
	return {
		do: [
			{
				refine: {
					call: "agent.run",
					with: { prompt: "old" },
				},
			},
		],
	};
}

function childSpec() {
	return {
		do: [
			{
				refine: {
					call: "agent.run",
					with: { prompt: "new" },
				},
			},
			{
				verify: {
					call: "agent.run",
					with: { prompt: "check" },
				},
			},
		],
	};
}
