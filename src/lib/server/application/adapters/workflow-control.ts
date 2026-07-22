import type {
	WorkflowExecutionCoordinatorOwnerPort,
	WorkflowExecutionLifecycleControllerPort,
	WorkflowExecutionLifecycleStopMode,
	WorkflowExecutionRuntimeHostLifecyclePort,
	WorkflowSpecValidatorPort,
	WorkflowRunStarterPort,
	WorkflowRunStartInput,
	WorkflowRunStartResult,
} from "$lib/server/application/ports";
import {
	confirmDurableStop,
	inspectDurableRun,
	stopDurableRun,
	type StopDurableRunMode,
} from "$lib/server/lifecycle";
import { PostgresLifecycleCoordinatorOwnerStore } from "$lib/server/application/adapters/lifecycle-ownership";
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
						workflowId: result.workflowId,
						workflowName: result.workflowName,
						reused: result.reused,
					}
				: result,
		);
	}
}

export class LifecycleWorkflowExecutionCoordinatorOwnerPort
	implements WorkflowExecutionCoordinatorOwnerPort
{
	constructor(
		private readonly owners: WorkflowExecutionCoordinatorOwnerPort =
			new PostgresLifecycleCoordinatorOwnerStore(),
	) {}

	getCoordinatorOwner(executionIdOrInstanceId: string) {
		return this.owners.getCoordinatorOwner(executionIdOrInstanceId);
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
	constructor(
		private readonly runtimeHostCleanup?: Pick<
			WorkflowExecutionRuntimeHostLifecyclePort,
			"requestReap"
		>,
	) {}

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

	async stopExecution(
		executionId: string,
		opts: {
			mode: WorkflowExecutionLifecycleStopMode;
			reason?: string;
			graceMs?: number;
		},
	) {
		const result = await stopDurableRun(
			{ kind: "workflowExecution", id: executionId },
			{ ...opts, mode: opts.mode as StopDurableRunMode },
		);
		if (opts.mode !== "interrupt" && result.state === "confirmed") {
			this.runtimeHostCleanup?.requestReap();
		}
		return result;
	}

	async confirmExecutionStop(executionId: string) {
		const result = await confirmDurableStop({
			kind: "workflowExecution",
			id: executionId,
		});
		if (result.state === "confirmed") {
			this.runtimeHostCleanup?.requestReap();
		}
		return result;
	}
}
