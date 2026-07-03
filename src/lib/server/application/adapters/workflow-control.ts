import type {
	WorkflowExecutionCoordinatorOwnerPort,
	WorkflowExecutionLifecycleControllerPort,
	WorkflowExecutionLifecycleStopMode,
	WorkflowExecutionReadModelPort,
	WorkflowSpecValidatorPort,
	WorkflowRunStarterPort,
	WorkflowRunStartInput,
	WorkflowRunStartResult,
} from "$lib/server/application/ports";
import {
	loadExecutionReadModel,
	serializeExecutionReadModel,
} from "$lib/server/execution-read-model";
import {
	confirmDurableStop,
	inspectDurableRun,
	stopDurableRun,
	type StopDurableRunMode,
} from "$lib/server/lifecycle";
import { ownsBenchmarkOrEvalRun } from "$lib/server/lifecycle/ownership";
import { isResourceInScope } from "$lib/server/workflows/project-scope";
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

export class LifecycleWorkflowExecutionControllerPort
	implements WorkflowExecutionLifecycleControllerPort
{
	async checkExecutionAccess(input: {
		executionId: string;
		userId: string;
		projectId?: string | null;
	}) {
		const inspected = await inspectDurableRun({
			kind: "workflowExecution",
			id: input.executionId,
		});
		if (inspected.notFound) return { status: "not_found" as const };
		if (
			inspected.scope &&
			!isResourceInScope(inspected.scope, {
				userId: input.userId,
				projectId: input.projectId ?? null,
			})
		) {
			return { status: "not_found" as const };
		}
		return { status: "ok" as const, active: Boolean(inspected.active) };
	}

	stopExecution(
		executionId: string,
		opts: {
			mode: WorkflowExecutionLifecycleStopMode;
			reason?: string;
			graceMs?: number;
		},
	) {
		return stopDurableRun(
			{ kind: "workflowExecution", id: executionId },
			{ ...opts, mode: opts.mode as StopDurableRunMode },
		);
	}

	confirmExecutionStop(executionId: string) {
		return confirmDurableStop({ kind: "workflowExecution", id: executionId });
	}
}

export class LegacyWorkflowExecutionReadModelPort
	implements WorkflowExecutionReadModelPort
{
	loadExecutionReadModel(input: {
		executionId: string;
		refreshRuntime: boolean;
		includeAgentEvents: boolean;
	}) {
		return loadExecutionReadModel(input.executionId, {
			refreshRuntime: input.refreshRuntime,
			includeAgentEvents: input.includeAgentEvents,
		});
	}

	serializeExecutionReadModel(
		model: unknown,
		options: { compact: boolean; includeAgentEvents: boolean },
	) {
		return serializeExecutionReadModel(model as never, options) as unknown as Record<
			string,
			unknown
		>;
	}
}
