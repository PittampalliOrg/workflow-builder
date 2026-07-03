import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApplicationWorkflowCodeCheckpointService } from "$lib/server/application/workflow-code-checkpoints";
import type {
	WorkflowCodeCheckpointReadModel,
	WorkflowCodeCheckpointStore,
	WorkflowCodeCheckpointWorkspacePort,
} from "$lib/server/application/ports";

describe("ApplicationWorkflowCodeCheckpointService", () => {
	let checkpoints: Pick<
		WorkflowCodeCheckpointStore,
		"listForExecution" | "getForExecution"
	>;
	let workspace: WorkflowCodeCheckpointWorkspacePort;
	let service: ApplicationWorkflowCodeCheckpointService;

	beforeEach(() => {
		checkpoints = {
			listForExecution: vi.fn(async () => [checkpoint("checkpoint-1")]),
			getForExecution: vi.fn(async () => checkpoint("checkpoint-1")),
		};
		workspace = {
			diffCheckpoint: vi.fn(async () => ({
				checkpoint: { id: "checkpoint-1" },
				diff: "diff --git a/src/app.ts b/src/app.ts",
				exitCode: 0,
			})),
			restoreCheckpoint: vi.fn(async () => ({
				checkpoint: { id: "checkpoint-1" },
				sandboxName: "sandbox-1",
				repoPath: "/sandbox",
			})),
		};
		service = new ApplicationWorkflowCodeCheckpointService({ checkpoints, workspace });
	});

	it("lists code checkpoints for an execution through the checkpoint port", async () => {
		const result = await service.listForExecution({ executionId: "exec-1" });

		expect(checkpoints.listForExecution).toHaveBeenCalledWith("exec-1");
		expect(result).toEqual([checkpoint("checkpoint-1")]);
	});

	it("loads checkpoint diffs through the workspace port", async () => {
		const result = await service.diffCheckpoint({
			executionId: "exec-1",
			checkpointId: "checkpoint-1",
			path: "src/app.ts",
		});

		expect(workspace.diffCheckpoint).toHaveBeenCalledWith({
			checkpoint: checkpoint("checkpoint-1"),
			path: "src/app.ts",
		});
		expect(result).toMatchObject({
			checkpoint: { id: "checkpoint-1" },
			exitCode: 0,
		});
	});

	it("restores checkpoints through the workspace port", async () => {
		const result = await service.restoreCheckpoint({
			executionId: "exec-1",
			checkpointId: "checkpoint-1",
			sandboxName: "sandbox-1",
			repoPath: "/repo",
		});

		expect(workspace.restoreCheckpoint).toHaveBeenCalledWith({
			checkpoint: checkpoint("checkpoint-1"),
			sandboxName: "sandbox-1",
			repoPath: "/repo",
		});
		expect(result).toMatchObject({
			checkpoint: { id: "checkpoint-1" },
			sandboxName: "sandbox-1",
		});
	});

	it("returns not found before hitting workspace ports when the checkpoint is missing", async () => {
		checkpoints.getForExecution = vi.fn(async () => null);

		await expect(
			service.diffCheckpoint({
				executionId: "exec-1",
				checkpointId: "missing",
			}),
		).resolves.toEqual({ error: "Checkpoint not found", status: 404 });
		await expect(
			service.restoreCheckpoint({
				executionId: "exec-1",
				checkpointId: "missing",
				sandboxName: "sandbox-1",
			}),
		).resolves.toEqual({ error: "Checkpoint not found", status: 404 });
		expect(workspace.diffCheckpoint).not.toHaveBeenCalled();
		expect(workspace.restoreCheckpoint).not.toHaveBeenCalled();
	});
});

function checkpoint(id: string): WorkflowCodeCheckpointReadModel {
	return {
		id,
		workflowExecutionId: "exec-1",
		workflowAgentRunId: "session-1",
		parentExecutionId: null,
		daprInstanceId: "session-1",
		workspaceRef: "workspace-1",
		sandboxName: "sandbox-1",
		repoPath: "/sandbox",
		nodeId: "node-1",
		sourceEventId: "event-1",
		seq: 1,
		toolName: "edit_file",
		checkpointKind: "tool_mutation",
		beforeSha: "before",
		afterSha: "after",
		remoteUrl: null,
		remoteRef: null,
		remoteStatus: null,
		remoteError: null,
		remotePushedAt: null,
		changedFiles: [{ path: "src/app.ts" }],
		fileCount: 1,
		status: "created",
		error: null,
		metadata: { toolCallId: "tool-1" },
		createdAt: "2026-01-01T00:00:00.000Z",
	};
}
