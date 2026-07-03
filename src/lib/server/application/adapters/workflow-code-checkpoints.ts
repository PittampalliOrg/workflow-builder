import type {
	WorkflowCodeCheckpointReadModel,
	WorkflowCodeCheckpointWorkspacePort,
} from "$lib/server/application/ports";
import {
	loadCodeCheckpointDiff,
	restoreCodeCheckpointToSandbox,
} from "$lib/server/workflows/code-checkpoints";

export class LegacyWorkflowCodeCheckpointWorkspacePort
	implements WorkflowCodeCheckpointWorkspacePort
{
	diffCheckpoint(input: {
		checkpoint: WorkflowCodeCheckpointReadModel;
		path?: string | null;
	}) {
		return loadCodeCheckpointDiff(
			input.checkpoint,
			input.path ?? null,
		);
	}

	restoreCheckpoint(input: {
		checkpoint: WorkflowCodeCheckpointReadModel;
		sandboxName: string;
		repoPath?: string | null;
	}) {
		return restoreCodeCheckpointToSandbox({
			checkpoint: input.checkpoint,
			sandboxName: input.sandboxName,
			repoPath: input.repoPath ?? null,
		});
	}
}
