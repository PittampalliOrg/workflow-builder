import type {
	WorkflowCodeCheckpointOperationResult,
	WorkflowCodeCheckpointReadModel,
	WorkflowCodeCheckpointStore,
	WorkflowCodeCheckpointWorkspacePort,
} from "$lib/server/application/ports";

export class ApplicationWorkflowCodeCheckpointService {
	constructor(
		private readonly deps: {
			checkpoints: Pick<WorkflowCodeCheckpointStore, "listForExecution">;
			workspace: WorkflowCodeCheckpointWorkspacePort;
		},
	) {}

	listForExecution(input: {
		executionId: string;
	}): Promise<WorkflowCodeCheckpointReadModel[]> {
		return this.deps.checkpoints.listForExecution(input.executionId);
	}

	diffCheckpoint(input: {
		executionId: string;
		checkpointId: string;
		path?: string | null;
	}): Promise<WorkflowCodeCheckpointOperationResult> {
		return this.deps.workspace.diffCheckpoint(input);
	}

	restoreCheckpoint(input: {
		executionId: string;
		checkpointId: string;
		sandboxName: string;
		repoPath?: string | null;
	}): Promise<WorkflowCodeCheckpointOperationResult> {
		return this.deps.workspace.restoreCheckpoint(input);
	}
}
