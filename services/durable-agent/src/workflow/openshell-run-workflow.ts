import type { WorkflowContext } from "@dapr/dapr";
import type { TriggerAction } from "../types/trigger.js";
import type { AgentWorkflowResult } from "./agent-workflow.js";

export interface FinalizeOpenShellRunPayload {
	instanceId: string;
	loopInstanceId: string;
	runPrompt: string;
	workspaceRef?: string;
	executionId?: string;
	requireFileChanges: boolean;
	traceContext?: Record<string, unknown>;
	completion: {
		success: boolean;
		result?: Record<string, unknown>;
		error?: string;
	};
}

export interface OpenShellRunWorkflowActivities {
	finalizeOpenShellRunResult: (
		ctx: any,
		payload: FinalizeOpenShellRunPayload,
	) => Promise<{
		success: boolean;
		result?: Record<string, unknown>;
		error?: string;
	}>;
}

export function createOpenShellRunWorkflow(
	agentWorkflowName: string,
	activities: OpenShellRunWorkflowActivities,
) {
	return async function* openshellRunWorkflow(
		ctx: WorkflowContext,
		input: TriggerAction,
	): AsyncGenerator<unknown, unknown, any> {
		const instanceId = ctx.getWorkflowInstanceId();
		const loopInstanceId = `${instanceId}__loop`;
		const task =
			typeof input.task === "string" && input.task.trim().length > 0
				? input.task
				: typeof input.prompt === "string" && input.prompt.trim().length > 0
					? input.prompt
					: "Triggered without input.";
		try {
			const loopResult: AgentWorkflowResult = yield ctx.callChildWorkflow(
				agentWorkflowName,
				{
					...input,
					task,
				},
				loopInstanceId,
			);
			const finalized = yield ctx.callActivity(
				activities.finalizeOpenShellRunResult,
				{
					instanceId,
					loopInstanceId,
					runPrompt: task,
					workspaceRef: input.workspaceRef,
					executionId: input.executionId,
					requireFileChanges: input.requireFileChanges === true,
					traceContext: input._otel_span_context,
					completion: {
						success: true,
						result: loopResult as unknown as Record<string, unknown>,
					},
				} satisfies FinalizeOpenShellRunPayload,
			);
			return {
				success: finalized.success,
				workflow_id: instanceId,
				dapr_instance_id: instanceId,
				status: finalized.success ? "completed" : "failed",
				...(input.workspaceRef ? { workspaceRef: input.workspaceRef } : {}),
				...(finalized.result ? finalized.result : {}),
				...(finalized.result ? { result: finalized.result } : {}),
				...(finalized.error ? { error: finalized.error } : {}),
				durableLoopInstanceId: loopInstanceId,
			};
		} catch (err) {
			const error = err instanceof Error ? err.message : String(err);
			return {
				success: false,
				workflow_id: instanceId,
				dapr_instance_id: instanceId,
				status: "failed",
				...(input.workspaceRef ? { workspaceRef: input.workspaceRef } : {}),
				error,
				durableLoopInstanceId: loopInstanceId,
			};
		}
	};
}
