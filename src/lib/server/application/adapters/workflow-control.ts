import type {
	WorkflowExecutionCoordinatorOwnerPort,
	WorkflowSpecValidatorPort,
	WorkflowRunStarterPort,
	WorkflowRunStartInput,
	WorkflowRunStartResult,
} from "$lib/server/application/ports";
import { ownsBenchmarkOrEvalRun } from "$lib/server/lifecycle/ownership";
import { isSWWorkflow, startWorkflowRun } from "$lib/server/workflows/start-run";

export class LegacyWorkflowRunStarterPort implements WorkflowRunStarterPort {
	startWorkflowRun(input: WorkflowRunStartInput): Promise<WorkflowRunStartResult> {
		return startWorkflowRun(input).then((result) =>
			result.ok
				? {
						ok: true,
						executionId: result.executionId,
						instanceId: result.instanceId,
					}
				: result,
		);
	}
}

export class LifecycleWorkflowExecutionCoordinatorOwnerPort
	implements WorkflowExecutionCoordinatorOwnerPort
{
	getCoordinatorOwner(executionIdOrInstanceId: string) {
		return ownsBenchmarkOrEvalRun(executionIdOrInstanceId);
	}
}

export class LegacyWorkflowSpecValidatorPort
	implements WorkflowSpecValidatorPort
{
	isServerlessWorkflow(spec: unknown) {
		return isSWWorkflow(spec);
	}
}
