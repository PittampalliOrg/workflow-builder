import type {
	WorkflowCodeCheckpointOperationResult,
	WorkflowCodeCheckpointReadModel,
	WorkflowCodeCheckpointStore,
	WorkflowCodeCheckpointWorkspacePort,
} from "$lib/server/application/ports";

export class ApplicationWorkflowCodeCheckpointService {
	constructor(
		private readonly deps: {
			checkpoints: Pick<
				WorkflowCodeCheckpointStore,
				"listForExecution" | "getForExecution"
			>;
			workspace: WorkflowCodeCheckpointWorkspacePort;
		},
	) {}

	listForExecution(input: {
		executionId: string;
	}): Promise<WorkflowCodeCheckpointReadModel[]> {
		return this.deps.checkpoints.listForExecution(input.executionId);
	}

	async diffCheckpoint(input: {
		executionId: string;
		checkpointId: string;
		path?: string | null;
	}): Promise<WorkflowCodeCheckpointOperationResult> {
		const checkpoint = await this.deps.checkpoints.getForExecution({
			executionId: input.executionId,
			checkpointId: input.checkpointId,
		});
		if (!checkpoint) return { error: "Checkpoint not found", status: 404 };
		return this.deps.workspace.diffCheckpoint({
			checkpoint,
			path: input.path ?? null,
		});
	}

	async restoreCheckpoint(input: {
		executionId: string;
		checkpointId: string;
		sandboxName: string;
		repoPath?: string | null;
	}): Promise<WorkflowCodeCheckpointOperationResult> {
		const checkpoint = await this.deps.checkpoints.getForExecution({
			executionId: input.executionId,
			checkpointId: input.checkpointId,
		});
		if (!checkpoint) return { error: "Checkpoint not found", status: 404 };
		return this.deps.workspace.restoreCheckpoint({
			checkpoint,
			sandboxName: input.sandboxName,
			repoPath: input.repoPath ?? null,
		});
	}
}
