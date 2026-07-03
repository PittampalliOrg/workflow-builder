import type {
	WorkflowCodeCheckpointReadModel,
	WorkflowCodeCheckpointStore,
} from "$lib/server/application/ports";

export class ApplicationWorkflowCodeCheckpointService {
	constructor(
		private readonly deps: {
			checkpoints: Pick<WorkflowCodeCheckpointStore, "listForExecution">;
		},
	) {}

	listForExecution(input: {
		executionId: string;
	}): Promise<WorkflowCodeCheckpointReadModel[]> {
		return this.deps.checkpoints.listForExecution(input.executionId);
	}
}
