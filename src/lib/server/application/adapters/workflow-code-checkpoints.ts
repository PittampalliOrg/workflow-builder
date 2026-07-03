import type { WorkflowCodeCheckpointWorkspacePort } from "$lib/server/application/ports";
import {
	loadCodeCheckpointDiff,
	restoreCodeCheckpointToSandbox,
} from "$lib/server/workflows/code-checkpoints";

export class LegacyWorkflowCodeCheckpointWorkspacePort
	implements WorkflowCodeCheckpointWorkspacePort
{
	diffCheckpoint(input: {
		executionId: string;
		checkpointId: string;
		path?: string | null;
	}) {
		return loadCodeCheckpointDiff(
			input.executionId,
			input.checkpointId,
			input.path ?? null,
		);
	}

	restoreCheckpoint(input: {
		executionId: string;
		checkpointId: string;
		sandboxName: string;
		repoPath?: string | null;
	}) {
		return restoreCodeCheckpointToSandbox({
			executionId: input.executionId,
			checkpointId: input.checkpointId,
			sandboxName: input.sandboxName,
			repoPath: input.repoPath ?? null,
		});
	}
}
