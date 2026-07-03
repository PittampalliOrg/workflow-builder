import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApplicationWorkflowCodeCheckpointService } from "$lib/server/application/workflow-code-checkpoints";
import type {
	WorkflowCodeCheckpointReadModel,
	WorkflowCodeCheckpointStore,
} from "$lib/server/application/ports";

describe("ApplicationWorkflowCodeCheckpointService", () => {
	let checkpoints: Pick<WorkflowCodeCheckpointStore, "listForExecution">;
	let service: ApplicationWorkflowCodeCheckpointService;

	beforeEach(() => {
		checkpoints = {
			listForExecution: vi.fn(async () => [checkpoint("checkpoint-1")]),
		};
		service = new ApplicationWorkflowCodeCheckpointService({ checkpoints });
	});

	it("lists code checkpoints for an execution through the checkpoint port", async () => {
		const result = await service.listForExecution({ executionId: "exec-1" });

		expect(checkpoints.listForExecution).toHaveBeenCalledWith("exec-1");
		expect(result).toEqual([checkpoint("checkpoint-1")]);
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
